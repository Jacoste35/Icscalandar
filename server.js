'use strict';

// Charge un éventuel fichier .env (présent sur un serveur OVH/VPS). Optionnel :
// si le paquet dotenv n'est pas installé, on ignore sans erreur.
try { require('dotenv').config(); } catch (e) { /* dotenv non installé : ignoré */ }

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('./lib/db');
const { getData, save, nextId, enableAccrual } = db;
const holidays = require('./lib/holidays');
const mail = require('./lib/mail');
const pajgps = require('./lib/erp/pajgps');
const payslip = require('./lib/erp/payslip');
const fuelimport = require('./lib/erp/fuelimport');
const { ensureErp } = require('./lib/erp');
const push = require('./lib/push');

const ROLES = ['admin', 'responsable', 'employee'];

// Date ISO (YYYY-MM-DD) → JJ/MM/AAAA (pour les libellés de notifications).
function frDate(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); }

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'inter-colis-services-dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'inter-colis-services-dev-secret-change-me') {
  console.warn('⚠️  JWT_SECRET non défini — définissez-le dans .env pour la production.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1); // derrière nginx (IP réelle pour le rate-limit)

// En-têtes de sécurité (sans dépendance externe). La CSP autorise les
// gestionnaires d'évènements inline utilisés par l'application.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://nominatim.openstreetmap.org blob: data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
  next();
});

// Limite confortable : permet d'importer jusqu'à 365 jours d'activité par
// chauffeur (suivi des HSUP sur 12 mois glissants) sans rejet.
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (p.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    // Le service worker doit pouvoir se mettre à jour : pas de cache HTTP long.
    if (p.endsWith('sw.js')) { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/'); }
  },
}));

// Anti-bruteforce simple sur l'authentification (par IP, fenêtre glissante).
const _authHits = new Map();
function loginRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = _authHits.get(ip) || { count: 0, reset: now + 15 * 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 15 * 60000; }
  rec.count += 1; _authHits.set(ip, rec);
  if (_authHits.size > 5000) _authHits.clear(); // garde-fou mémoire
  if (rec.count > 20) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  next();
}

// Charge la base avant chaque requête API (indispensable en serverless, où la
// mémoire n'est pas partagée entre les invocations).
app.use('/api', async (req, res, next) => {
  try {
    await db.load();
    next();
  } catch (e) {
    console.error('Erreur de chargement de la base:', e);
    res.status(500).json({ error: 'Erreur de stockage des données' });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOURS_PER_DAY = 7;

// Options de "réserve" (pool) selon la catégorie : sur quel solde imputer.
// Seul le congé payé propose un choix (année N ou N-1). La récupération impute
// toujours les heures supplémentaires ; le RCC impute son compteur dédié.
const CATEGORY_POOLS = {
  CP: [
    { value: 'N', label: 'Congés N' },
    { value: 'N1', label: 'Congés N-1' },
  ],
};

function categoryByCode(code) {
  return getData().categories.find((c) => c.code === code) || null;
}

function categoryLabel(code) {
  const c = categoryByCode(code);
  return c ? c.label : code;
}

// Code affiché sur le calendrier : une demande de CP en attente devient "DCP".
function displayCode(req) {
  if (req.category === 'CP' && req.status === 'pending') return 'DCP';
  return req.category;
}

// Détermine le solde à débiter pour une demande validée (ou null).
//   CP  -> congés N ou N-1 (jours)
//   RCP -> heures supplémentaires (heures) = compteur de récupération
//   RCC -> compteur RCC dédié (jours)
function deductionFor(r) {
  // Absences importées rétroactivement : visibles au planning mais SANS décompte
  // de solde (les compteurs sont gérés à part).
  if (r.noDeduct) return null;
  if (r.category === 'CP') return { balance: r.pool === 'N1' ? 'congesN1' : 'congesN', amount: r.days };
  if (r.category === 'RCP') return { balance: 'heuresSupp', amount: r.hours };
  if (r.category === 'RCC') return { balance: 'rcc', amount: r.hours };
  return null; // PMT, AM, ABS, etc. : pas de décompte
}

// Catégories décomptées en HEURES et leur compteur (RCP = heures sup., RCC).
const HOUR_BASED = { RCP: 'heuresSupp', RCC: 'rcc' };

// Pour une catégorie en heures, renvoie la date de fin maximale atteignable
// depuis startStr avec le nombre d'heures disponibles (jours ouvrés * 7h).
function maxEndDateForHours(startStr, balanceHours) {
  const maxDays = Math.floor((Number(balanceHours) || 0) / HOURS_PER_DAY);
  if (maxDays <= 0) return null;
  let count = 0;
  let last = null;
  let cur = new Date(startStr + 'T00:00:00Z');
  for (let i = 0; i < 400 && count < maxDays; i++) {
    const ds = cur.toISOString().slice(0, 10);
    if (holidays.isWorkingDay(ds)) { count++; last = ds; }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return last;
}

function rangesOverlap(s1, e1, s2, e2) {
  return s1 <= e2 && e1 >= s2;
}

// Indique si la période [start, end] contient au moins un jour férié.
function rangeContainsHoliday(startStr, endStr) {
  if (!validDate(startStr) || !validDate(endStr)) return false;
  let cur = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  for (let i = 0; i < 400 && cur.getTime() <= end.getTime(); i++) {
    if (holidays.isHoliday(cur.toISOString().slice(0, 10))) return true;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return false;
}

// Renvoie la période fermée chevauchant [startDate, endDate], ou null.
function closedPeriodOverlap(startDate, endDate) {
  const periods = getData().settings.closedPeriods || [];
  return periods.find((p) => rangesOverlap(startDate, endDate, p.start, p.end)) || null;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getData().users.find((u) => u.id === payload.id);
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Compte non activé' });
    if (user.suspended) return res.status(403).json({ error: 'Accès suspendu' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session invalide' });
  }
}

function adminRequired(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé à l’administrateur' });
  next();
}

// Encadrement : administrateur OU responsable.
function staffRequired(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'responsable') {
    return res.status(403).json({ error: 'Réservé à l’encadrement' });
  }
  next();
}

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// ---------------------------------------------------------------------------
// Auth & inscription
// ---------------------------------------------------------------------------

// Normalise une chaîne en identifiant (sans accents, minuscules, a-z0-9).
function slug(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // retire les accents
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '');
}

// Met une majuscule à la première lettre de chaque partie d'un nom propre.
function capitalizeName(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/(^|[\s\-'])([a-zà-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// Génère un nom de compte "prenom.nom" unique.
function makeUsername(db, firstName, lastName) {
  const base = `${slug(firstName)}.${slug(lastName)}`.replace(/^\.|\.$/g, '') || 'utilisateur';
  let candidate = base;
  let n = 1;
  const taken = (name) => db.users.some((u) => (u.username || '').toLowerCase() === name);
  while (taken(candidate)) { n += 1; candidate = `${base}${n}`; }
  return candidate;
}

app.post('/api/register', loginRateLimit, async (req, res) => {
  const { firstName, lastName, email, password, phone, hireDate } = req.body || {};
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont obligatoires' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
  }
  const db = getData();
  const normEmail = String(email).trim().toLowerCase();
  if (db.users.some((u) => u.email === normEmail)) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
  }
  const isFirstUser = db.users.length === 0;
  const passwordHash = await bcrypt.hash(String(password), 10);
  // Nom de compte automatique "prenom.nom" (unique), utilisé pour se connecter.
  const username = makeUsername(db, firstName, lastName);
  const user = {
    id: nextId('user'),
    firstName: capitalizeName(firstName),
    lastName: capitalizeName(lastName),
    username,
    email: normEmail,
    phone: String(phone || '').trim() || null,
    passwordHash,
    isParent: false,
    suspended: false,
    cguAccepted: false,
    reglementAccepted: false,
    reglementAcceptedAt: null,
    reglementAcceptedVersion: 0,
    unavail: [],
    hireDate: validDate(hireDate) ? hireDate : null,
    // Le tout premier compte créé devient administrateur et est actif.
    role: isFirstUser ? 'admin' : 'employee',
    status: isFirstUser ? 'active' : 'pending',
    groupId: null,
    balances: { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 },
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  await save();
  // Confirmation des identifiants par email (nom de compte + mot de passe).
  if (user.email) {
    mail.sendCredentials({ to: user.email, firstName: user.firstName, login: user.username, password: String(password) });
  }
  // Push : prévient les administrateurs qu'un nouveau compte attend leur validation.
  if (!isFirstUser) {
    push.fire(push.notifyUsers(getData(), save, push.adminIds(getData()), {
      title: '👤 Nouvelle inscription à valider',
      body: `${user.firstName} ${user.lastName} a créé un compte — à valider et paramétrer.`,
      url: '/', tag: 'register-' + user.id,
    }));
  }
  res.json({
    user: publicUser(user),
    token: user.status === 'active' ? signToken(user) : null,
    message: isFirstUser
      ? `Compte administrateur créé. Votre nom de compte est « ${user.username} ». Vous pouvez vous connecter.`
      : `Demande envoyée. Votre nom de compte est « ${user.username} ». Un administrateur doit valider votre compte et attribuer vos soldes.`,
  });
});

app.post('/api/login', loginRateLimit, async (req, res) => {
  const { email, login, password } = req.body || {};
  const db = getData();
  // Accepte l'email OU le nom de compte (username), insensible à la casse.
  const id = String(login || email || '').trim().toLowerCase();
  const user = db.users.find(
    (u) => (u.email && u.email === id) || (u.username && u.username.toLowerCase() === id)
  );
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });
  if (user.status === 'pending') return res.status(403).json({ error: 'Compte en attente de validation par l’administrateur' });
  if (user.status === 'rejected') return res.status(403).json({ error: 'Demande d’inscription refusée' });
  if (user.suspended) return res.status(403).json({ error: 'Accès suspendu. Contactez la direction.' });
  res.json({ user: publicUser(user), token: signToken(user) });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ---- Notifications push (Web Push / VAPID) ------------------------------- */
// Config publique : indique si le push est disponible + la clé publique VAPID.
app.get('/api/push/config', authRequired, async (req, res) => {
  const db = getData();
  const cfg = push.publicConfig(db);
  if (cfg.enabled && db.settings.push && db.settings.push.generated) { try { await save(); } catch (e) {} }
  const sub = Array.isArray(req.user.pushSubs) && req.user.pushSubs.length > 0;
  res.json({ ...cfg, subscribed: sub });
});
// Le salarié enregistre l'abonnement de SON appareil.
app.post('/api/me/push-subscribe', authRequired, async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint) return res.status(400).json({ error: 'Abonnement invalide' });
  push.addSubscription(req.user, sub, req.headers['user-agent']);
  await save();
  // Confirmation immédiate sur l'appareil qui vient de s'abonner.
  push.fire(push.notifyUser(getData(), save, req.user.id, {
    title: 'Notifications activées ✅',
    body: 'Vous recevrez désormais les alertes importantes (congés, documents, planning).',
    url: '/',
  }));
  res.json({ ok: true });
});
// Le salarié retire l'abonnement de son appareil.
app.post('/api/me/push-unsubscribe', authRequired, async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) push.removeSubscription(req.user, endpoint);
  else req.user.pushSubs = [];
  await save();
  res.json({ ok: true });
});

// Le salarié met à jour ses propres informations (statut de parent, téléphone).
app.put('/api/me', authRequired, async (req, res) => {
  const { isParent, phone } = req.body || {};
  if (isParent !== undefined) req.user.isParent = Boolean(isParent);
  if (phone !== undefined) req.user.phone = String(phone || '').trim() || null;
  await save();
  res.json({ user: publicUser(req.user) });
});

// Acceptation des conditions d'utilisation (page de garde au 1er accès).
app.post('/api/me/accept-cgu', authRequired, async (req, res) => {
  req.user.cguAccepted = true;
  req.user.cguAcceptedAt = new Date().toISOString();
  await save();
  res.json({ user: publicUser(req.user) });
});

// Règlement intérieur en vigueur (version, date, contenu, historique).
app.get('/api/reglement', authRequired, (req, res) => {
  const r = getData().settings.reglement || {};
  res.json({ version: r.version, label: r.label, updatedAt: r.updatedAt, content: r.content, history: r.history || [] });
});

// Acceptation du règlement intérieur (version en vigueur) par le salarié.
app.post('/api/me/accept-reglement', authRequired, async (req, res) => {
  const cur = getData().settings.reglement || { version: 1 };
  req.user.reglementAccepted = true;
  req.user.reglementAcceptedVersion = cur.version || 1;
  req.user.reglementAcceptedAt = new Date().toISOString();
  await save();
  res.json({ user: publicUser(req.user) });
});

// Modifier le règlement intérieur (admin) : nouvelle version → ré-acceptation
// requise par tous les salariés à leur prochaine connexion.
app.put('/api/admin/reglement', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { content, label } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'Contenu du règlement requis' });
  const cur = db.settings.reglement || {};
  const newVersion = (cur.version || 0) + 1;
  const now = new Date().toISOString();
  const newLabel = String(label || `Version ${newVersion}.0`).trim();
  cur.history = Array.isArray(cur.history) ? cur.history : [];
  cur.history.push({ version: newVersion, label: newLabel, updatedAt: now });
  db.settings.reglement = {
    version: newVersion,
    label: newLabel,
    updatedAt: now,
    content: String(content),
    history: cur.history,
  };
  await save();
  res.json({ reglement: db.settings.reglement });
});

// Liste des acceptations du règlement intérieur (administrateur).
app.get('/api/admin/reglement-status', authRequired, adminRequired, (req, res) => {
  const r = getData().settings.reglement || { version: 1 };
  const list = getData().users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id, firstName: u.firstName, lastName: u.lastName, role: u.role,
      groupId: u.groupId, email: u.email || null,
      reglementAcceptedVersion: u.reglementAcceptedVersion || 0,
      upToDate: (u.reglementAcceptedVersion || 0) >= r.version,
      reglementAcceptedAt: u.reglementAcceptedAt || null,
    }));
  res.json({ users: list, current: { version: r.version, label: r.label, updatedAt: r.updatedAt }, history: r.history || [] });
});

// --- Indisponibilités personnelles (« Verrouiller mon planning ») -----------
// Tout utilisateur peut déclarer des jours/semaines où il n'est pas disponible.
// Ces dates le retirent du vivier de remplaçants pour les autres salariés.
app.post('/api/me/unavail', authRequired, async (req, res) => {
  const { start, end, label } = req.body || {};
  if (!validDate(start) || !validDate(end)) return res.status(400).json({ error: 'Dates invalides' });
  if (end < start) return res.status(400).json({ error: 'La date de fin précède la date de début' });
  if (!Array.isArray(req.user.unavail)) req.user.unavail = [];
  req.user.unavail.push({ id: nextId('request'), start, end, label: String(label || 'Indisponible').trim() });
  await save();
  res.json({ user: publicUser(req.user) });
});
app.delete('/api/me/unavail/:id', authRequired, async (req, res) => {
  req.user.unavail = (req.user.unavail || []).filter((u) => u.id !== req.params.id);
  await save();
  res.json({ user: publicUser(req.user) });
});

// Indique si un salarié peut servir de remplaçant sur [start, end] :
// - pas en congé payé / repos / récupération (CP, RCC, RCP) validé ou en attente
// - pas déjà affecté comme remplaçant d'une autre tâche sur la période
// - pas en indisponibilité personnelle (planning verrouillé)
const REPLACER_BLOCKING = ['CP', 'RCC', 'RCP'];
function replacerConflict(db, replacerId, start, end, exceptReqId) {
  const u = db.users.find((x) => x.id === replacerId);
  if (!u) return 'introuvable';
  if ((u.unavail || []).some((p) => rangesOverlap(start, end, p.start, p.end))) return 'planning verrouillé';
  for (const r of db.requests) {
    if (r.id === exceptReqId) continue;
    if (r.status === 'rejected') continue;
    if (!rangesOverlap(start, end, r.startDate, r.endDate)) continue;
    if (r.userId === replacerId && REPLACER_BLOCKING.includes(r.category)) return 'en congé/repos';
    if (r.replacedById === replacerId) return 'déjà remplaçant ailleurs';
  }
  return null;
}

// Réglages calendrier (vacances scolaires, fermetures) — lecture pour tous.
app.get('/api/settings', authRequired, (req, res) => {
  const s = getData().settings;
  res.json({ schoolHolidays: s.schoolHolidays || [], closedPeriods: s.closedPeriods || [] });
});

// ---------------------------------------------------------------------------
// Données de référence
// ---------------------------------------------------------------------------

app.get('/api/groups', authRequired, (req, res) => {
  res.json({ groups: getData().groups });
});

app.get('/api/categories', authRequired, (req, res) => {
  res.json({ categories: getData().categories, pools: CATEGORY_POOLS });
});

// Créer un nouveau motif d'absence (catégorie).
app.post('/api/admin/categories', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { code, label, color } = req.body || {};
  const cleanCode = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleanCode) return res.status(400).json({ error: 'Code invalide (lettres/chiffres uniquement)' });
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'Libellé obligatoire' });
  if (db.categories.some((c) => c.code === cleanCode)) return res.status(409).json({ error: 'Ce code existe déjà' });
  const cat = {
    code: cleanCode,
    label: String(label).trim(),
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#64748b',
    selectable: true,
    pool: null,
  };
  db.categories.push(cat);
  await save();
  res.json({ category: cat });
});

// Modifier le libellé / la couleur d'une catégorie (admin)
app.put('/api/admin/categories/:code', authRequired, adminRequired, async (req, res) => {
  const cat = categoryByCode(req.params.code);
  if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });
  const { label, color } = req.body || {};
  if (label) cat.label = String(label).trim();
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) cat.color = color;
  await save();
  res.json({ category: cat });
});

// Supprimer un motif (sauf motifs cœur, et s'il n'est pas utilisé).
const CORE_CATEGORIES = ['DCP', 'CP', 'RCP'];
app.delete('/api/admin/categories/:code', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const code = req.params.code;
  if (CORE_CATEGORIES.includes(code)) return res.status(400).json({ error: 'Ce motif est essentiel et ne peut pas être supprimé' });
  if (!db.categories.some((c) => c.code === code)) return res.status(404).json({ error: 'Catégorie introuvable' });
  if (db.requests.some((r) => r.category === code)) {
    return res.status(400).json({ error: 'Ce motif est utilisé par des demandes existantes' });
  }
  db.categories = db.categories.filter((c) => c.code !== code);
  await save();
  res.json({ ok: true });
});

app.get('/api/info-panel', authRequired, (req, res) => {
  res.json({ content: getData().settings.infoPanel });
});

app.put('/api/info-panel', authRequired, adminRequired, async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'Contenu invalide' });
  getData().settings.infoPanel = content;
  await save();
  res.json({ content });
});

app.get('/api/holidays', authRequired, (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const years = [year - 1, year, year + 1];
  res.json({ holidays: holidays.holidaysMap(years) });
});

// Liste des membres (visible de tous les inscrits).
// Les emails ne sont exposés que pour la direction (admins) à tous ; les autres
// emails ne sont visibles que par un administrateur (organigramme).
app.get('/api/team', authRequired, (req, res) => {
  const db = getData();
  const isAdmin = req.user.role === 'admin';
  const isStaff = isAdmin || req.user.role === 'responsable';
  const team = db.users
    .filter((u) => u.status === 'active' && !u.suspended)
    .map((u) => {
      const emailVisible = isAdmin || u.role === 'admin';
      return {
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        groupId: u.groupId,
        email: emailVisible ? (u.email || null) : null,
        phone: u.phone || null,
        isParent: Boolean(u.isParent),
        hireDate: u.hireDate || null,
        // Les soldes et indisponibilités ne sont exposés qu'à l'encadrement.
        balances: isStaff ? { ...u.balances } : undefined,
        unavail: isStaff ? (u.unavail || []) : undefined,
      };
    });
  res.json({ team });
});

// Priorité personnelle d'apurement des congés : rang du salarié (0 = solde le
// plus élevé) parmi les actifs, sans exposer les soldes des autres (RGPD).
app.get('/api/my-leave-rank', authRequired, (req, res) => {
  const db = getData();
  const cp = (u) => (Number(u.balances && u.balances.congesN) || 0) + (Number(u.balances && u.balances.congesN1) || 0);
  const actives = db.users.filter((u) => u.status === 'active' && !u.suspended);
  const ranked = actives.map((u) => ({ id: u.id, b: cp(u) })).sort((a, z) => z.b - a.b || String(a.id).localeCompare(String(z.id)));
  const idx = ranked.findIndex((r) => r.id === req.user.id);
  res.json({ balance: cp(req.user), rank: idx < 0 ? actives.length : idx, total: actives.length });
});

// ---------------------------------------------------------------------------
// Calendrier : toutes les absences validées (visible de tous)
// ---------------------------------------------------------------------------

app.get('/api/calendar', authRequired, (req, res) => {
  const db = getData();
  const groupsById = Object.fromEntries(db.groups.map((g) => [g.id, g]));
  const catByCode = Object.fromEntries(db.categories.map((c) => [c.code, c]));
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  // On affiche les absences validées ET les demandes en attente (DCP).
  const events = db.requests
    .filter((r) => r.status === 'approved' || r.status === 'pending')
    .map((r) => {
      const u = usersById[r.userId];
      const g = u ? groupsById[u.groupId] : null;
      const code = displayCode(r);
      const cat = catByCode[code] || catByCode[r.category];
      return {
        id: r.id,
        userId: r.userId,
        userName: u ? `${u.firstName} ${u.lastName}` : 'Inconnu',
        groupId: u ? u.groupId : null,
        groupName: g ? g.name : '—',
        groupColor: g ? g.color : '#64748b',
        category: r.category,
        code, // DCP pour une demande de CP en attente
        categoryLabel: cat ? cat.label : code,
        categoryColor: cat ? cat.color : '#64748b',
        status: r.status,
        pool: r.pool || null,
        startDate: r.startDate,
        endDate: r.endDate,
        days: r.days,
        hours: r.hours,
        retardMinutes: r.retardMinutes || null,
        replacedByName: r.replacedByName || null,
        replacedById: r.replacedById || null,
        fractionnement: r.fractionnement || null,
        reason: r.reason || null,
      };
    });
  res.json({ events });
});

// ---------------------------------------------------------------------------
// Synchronisation calendrier (flux iCalendar à s'abonner sur le téléphone)
// ---------------------------------------------------------------------------
function icsEscape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDay(ymdStr) { return String(ymdStr || '').replace(/-/g, ''); } // YYYY-MM-DD -> YYYYMMDD
function icsDayPlus1(ymdStr) { const d = new Date(ymdStr + 'T00:00:00Z'); if (isNaN(d)) return icsDay(ymdStr); d.setUTCDate(d.getUTCDate() + 1); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`; }
function icsStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; }

// Génère/retourne le jeton d'abonnement personnel + l'URL du flux.
app.post('/api/me/calendar-token', authRequired, async (req, res) => {
  const db = getData();
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (!u.calendarToken || (req.body && req.body.regenerate)) { u.calendarToken = require('crypto').randomBytes(18).toString('hex'); await save(); }
  res.json({ token: u.calendarToken, path: `/calendar/${u.calendarToken}.ics` });
});

// Flux iCalendar public (protégé par le jeton dans l'URL). À s'abonner depuis
// l'app Calendrier du téléphone : les nouveaux congés apparaissent au rafraîchi.
app.get('/calendar/:token.ics', (req, res) => {
  const token = String(req.params.token || '').replace(/\.ics$/i, '');
  const db = getData();
  const owner = token && db.users.find((u) => u.calendarToken && u.calendarToken === token);
  if (!owner) { res.status(404).type('text/plain').send('Calendrier introuvable.'); return; }
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  const catByCode = Object.fromEntries(db.categories.map((c) => [c.code, c]));
  const stamp = icsStamp();
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Inter Colis Services//Planning//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Planning ICS', 'NAME:Planning ICS', 'X-WR-TIMEZONE:Europe/Paris', 'REFRESH-INTERVAL;VALUE=DURATION:PT4H', 'X-PUBLISHED-TTL:PT4H'];
  for (const r of db.requests) {
    if ((r.status !== 'approved' && r.status !== 'pending') || !r.startDate || !r.endDate) continue;
    const u = usersById[r.userId];
    const code = displayCode(r);
    const cat = catByCode[code] || catByCode[r.category];
    const name = u ? `${u.firstName} ${u.lastName}` : 'Inconnu';
    const label = cat ? cat.label : code;
    out.push('BEGIN:VEVENT', `UID:${r.id}@inter-colis-services`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDay(r.startDate)}`, `DTEND;VALUE=DATE:${icsDayPlus1(r.endDate)}`, `SUMMARY:${icsEscape(name + ' — ' + label)}`, `STATUS:${r.status === 'approved' ? 'CONFIRMED' : 'TENTATIVE'}`, 'TRANSP:TRANSPARENT');
    if (r.reason) out.push(`DESCRIPTION:${icsEscape(r.reason)}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="planning-ics.ics"');
  res.send(out.join('\r\n'));
});

// ---------------------------------------------------------------------------
// Demandes de congé
// ---------------------------------------------------------------------------

app.get('/api/requests/mine', authRequired, (req, res) => {
  const mine = getData().requests
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ requests: mine });
});

app.post('/api/requests', authRequired, async (req, res) => {
  const { category, pool, startDate, endDate, reason, fractionnement } = req.body || {};
  const cat = categoryByCode(category);
  if (!cat || !cat.requestable) return res.status(400).json({ error: 'Catégorie de demande invalide' });
  // Vérifie le "pool" pour les catégories qui en exigent un (CP : N ou N-1).
  const poolOptions = CATEGORY_POOLS[category];
  let chosenPool = null;
  if (poolOptions) {
    if (!poolOptions.some((p) => p.value === pool)) {
      return res.status(400).json({ error: 'Précisez sur quel solde imputer la demande' });
    }
    chosenPool = pool;
  }
  if (!validDate(startDate) || !validDate(endDate)) return res.status(400).json({ error: 'Dates invalides' });
  if (endDate < startDate) return res.status(400).json({ error: 'La date de fin précède la date de début' });

  // Éligibilité : impossible de demander si le solde concerné est à zéro.
  const b = req.user.balances;
  if (category === 'CP' && chosenPool === 'N1' && (b.congesN1 || 0) <= 0) {
    return res.status(400).json({ error: 'Solde de congés N-1 à 0 : vous n’êtes pas éligible à cette demande.' });
  }
  if (category === 'RCP' && (b.heuresSupp || 0) <= 0) {
    return res.status(400).json({ error: 'Compteur d’heures supplémentaires à 0 : vous n’êtes pas éligible à une récupération.' });
  }
  if (category === 'RCC' && (b.rcc || 0) <= 0) {
    return res.status(400).json({ error: 'Compteur RCC à 0 : vous n’êtes pas éligible à cette demande.' });
  }

  // Période fermée à la prise de congé (ex. fêtes de fin d'année).
  const closed = closedPeriodOverlap(startDate, endDate);
  if (closed) return res.status(400).json({ error: `Prise de congé fermée sur cette période : ${closed.label}. Contactez la direction.` });

  const days = holidays.countWorkingDays(startDate, endDate);
  if (days <= 0) return res.status(400).json({ error: 'Aucun jour ouvré sur cette période (dimanches/fériés exclus)' });
  const hours = days * HOURS_PER_DAY;

  // Catégories en heures (RCP, RCC) : refuser si la demande dépasse le solde,
  // et suggérer la période maximale possible depuis la date de début.
  const hourBalanceKey = HOUR_BASED[category];
  if (hourBalanceKey) {
    const available = req.user.balances[hourBalanceKey] || 0;
    if (hours > available) {
      const maxEnd = maxEndDateForHours(startDate, available);
      const suggestion = maxEnd
        ? ` Vous disposez de ${available} h : au maximum jusqu'au ${maxEnd} à partir du ${startDate}.`
        : ` Vous disposez de ${available} h, insuffisant pour une journée.`;
      return res.status(400).json({
        error: `Demande de ${hours} h supérieure à votre solde disponible (${available} h).${suggestion}`,
        suggestedEndDate: maxEnd,
        availableHours: available,
      });
    }
  }

  // Motif par défaut : si rien n'est précisé, on reprend le libellé de la catégorie.
  const finalReason = String(reason || '').trim() || cat.label;

  const request = {
    id: nextId('request'),
    userId: req.user.id,
    category,
    pool: chosenPool,
    startDate,
    endDate,
    reason: finalReason,
    fractionnement: category === 'PMT' ? (fractionnement === 'fractionne' ? 'fractionne' : 'complet') : null,
    retardMinutes: null,
    days,
    hours,
    status: 'pending',
    createdAt: new Date().toISOString(),
    createdBy: req.user.id,
    decidedAt: null,
    decidedBy: null,
    replacedById: null,
    replacedByName: null,
    adminNote: '',
  };
  getData().requests.push(request);
  await save();
  // Accusé de réception : la demande est en cours d'étude.
  if (req.user.email) {
    mail.sendLeaveStatus({ to: req.user.email, firstName: req.user.firstName, status: 'pending', category: cat.label, startDate, endDate });
  }
  // Push : prévient l'encadrement qu'une demande attend sa validation.
  push.fire(push.notifyUsers(getData(), save, push.adminIds(getData()), {
    title: 'Nouvelle demande de congé',
    body: `${req.user.firstName} ${req.user.lastName} — ${cat.label} du ${frDate(startDate)} au ${frDate(endDate)}.`,
    url: '/', tag: 'leave-pending',
  }));
  res.json({ request });
});

app.delete('/api/requests/:id', authRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  if (r.userId !== req.user.id) return res.status(403).json({ error: 'Action non autorisée' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Seules les demandes en attente peuvent être annulées' });
  db.requests = db.requests.filter((x) => x.id !== r.id);
  await save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

// Comptes en attente de validation
app.get('/api/admin/pending', authRequired, adminRequired, (req, res) => {
  const pending = getData().users.filter((u) => u.status === 'pending').map(publicUser);
  res.json({ users: pending });
});

// Cumul des éléments DÉJÀ PRIS par un salarié (demandes validées).
//   cpN / cpN1 : jours de congés payés ; rcp : heures de récup ; rcc : heures RCC.
function takenByUser(db, userId) {
  const u = db.users.find((x) => x.id === userId);
  const base = (u && u.takenBaseline) || {};
  const t = { cpN: 0, cpN1: 0, cp: 0, rcp: 0, rcc: 0 };
  for (const r of db.requests) {
    if (r.userId !== userId || r.status !== 'approved') continue;
    if (r.category === 'CP') { t.cp += r.days || 0; if (r.pool === 'N1') t.cpN1 += r.days || 0; else t.cpN += r.days || 0; }
    else if (r.category === 'RCP') t.rcp += r.hours || 0;
    else if (r.category === 'RCC') t.rcc += r.hours || 0;
  }
  // Ajoute le compteur de base saisi par l'administrateur (historique hors appli).
  t.cpN += num(base.congesN); t.cpN1 += num(base.congesN1); t.cp += num(base.congesN) + num(base.congesN1);
  t.rcp += num(base.heuresSupp); t.rcc += num(base.rcc);
  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

// Tous les utilisateurs actifs (pour gestion des soldes) + cumul déjà pris.
app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  const db = getData();
  res.json({ users: db.users.map((u) => ({ ...publicUser(u), taken: takenByUser(db, u.id) })) });
});

// Vérifie l'unicité de l'email et du nom de compte (hors utilisateur exclu).
function loginTaken(db, { email, username }, exceptId) {
  return db.users.some((u) => {
    if (u.id === exceptId) return false;
    if (email && u.email && u.email === email) return true;
    if (username && u.username && u.username.toLowerCase() === username.toLowerCase()) return true;
    return false;
  });
}

// Créer directement un utilisateur (actif) avec toutes ses données.
app.post('/api/admin/users', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { firstName, lastName, username, email, password, groupId, role, congesN, congesN1, rcc, heuresSupp, isParent, phone, hireDate, address, birthDate } = req.body || {};
  if (!firstName || !lastName) return res.status(400).json({ error: 'Nom et prénom obligatoires' });
  let uname = String(username || '').trim().toLowerCase();
  const mailAddr = String(email || '').trim().toLowerCase();
  // Si aucun nom de compte n'est fourni, on le génère automatiquement (prenom.nom).
  if (!uname) uname = makeUsername(db, firstName, lastName);
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Mot de passe de 6 caractères minimum' });
  if (groupId && !db.groups.some((g) => g.id === groupId)) return res.status(400).json({ error: 'Groupe invalide' });
  if (loginTaken(db, { email: mailAddr, username: uname })) {
    return res.status(409).json({ error: 'Ce nom de compte ou cet email est déjà utilisé' });
  }
  const user = {
    id: nextId('user'),
    firstName: capitalizeName(firstName),
    lastName: capitalizeName(lastName),
    username: uname || null,
    email: mailAddr || null,
    phone: String(phone || '').trim() || null,
    address: String(address || '').trim() || null,
    birthDate: validDate(birthDate) ? birthDate : null,
    hireDate: validDate(hireDate) ? hireDate : null,
    suspended: false,
    cguAccepted: false,
    reglementAccepted: false,
    reglementAcceptedAt: null,
    reglementAcceptedVersion: 0,
    unavail: [],
    rccAnchor: new Date().toISOString().slice(0, 10),
    passwordHash: await bcrypt.hash(String(password), 10),
    isParent: Boolean(isParent),
    role: ROLES.includes(role) ? role : 'employee',
    status: 'active',
    groupId: groupId || null,
    balances: {
      congesN: Number(congesN) || 0,
      congesN1: Number(congesN1) || 0,
      rcc: Number(rcc) || 0,
      heuresSupp: Number(heuresSupp) || 0,
    },
    createdAt: new Date().toISOString(),
  };
  // Active l'acquisition automatique des CP dès qu'une valeur N est paramétrée.
  if (Number(congesN) >= 0 && (congesN !== undefined && congesN !== null && congesN !== '')) enableAccrual(user);
  db.users.push(user);
  await save();
  // Envoi des identifiants par email si une adresse a été fournie.
  let emailed = false;
  if (user.email) {
    emailed = await mail.sendCredentials({ to: user.email, firstName: user.firstName, login: user.username || user.email, password: String(password) });
  }
  res.json({ user: publicUser(user), emailed });
});

// Valider une inscription en attribuant groupe + soldes
app.post('/api/admin/users/:id/approve', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { groupId, congesN, congesN1, rcc, heuresSupp, role } = req.body || {};
  if (groupId && !db.groups.some((g) => g.id === groupId)) {
    return res.status(400).json({ error: 'Groupe invalide' });
  }
  user.status = 'active';
  user.groupId = groupId || user.groupId || null;
  user.balances = {
    congesN: Number(congesN) || 0,
    congesN1: Number(congesN1) || 0,
    rcc: Number(rcc) || 0,
    heuresSupp: Number(heuresSupp) || 0,
  };
  if (ROLES.includes(role)) user.role = role;
  enableAccrual(user); // acquisition CP +2,5 j/mois à partir de la validation
  await save();
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/users/:id/reject', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  user.status = 'rejected';
  await save();
  res.json({ user: publicUser(user) });
});

// Modifier toutes les données d'un utilisateur (identité, compte, soldes, rôle).
app.put('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { firstName, lastName, username, email, password, groupId, congesN, congesN1, rcc, heuresSupp, role, isParent, phone, hireDate, address, birthDate, takenBaseline } = req.body || {};
  // Compteur « déjà pris » de base (historique hors application), éditable.
  if (takenBaseline && typeof takenBaseline === 'object') {
    user.takenBaseline = user.takenBaseline || { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 };
    for (const k of ['congesN', 'congesN1', 'rcc', 'heuresSupp']) {
      if (takenBaseline[k] !== undefined) user.takenBaseline[k] = Number(takenBaseline[k]) || 0;
    }
  }

  // Identité et compte
  if (firstName !== undefined && String(firstName).trim()) user.firstName = capitalizeName(firstName);
  if (lastName !== undefined && String(lastName).trim()) user.lastName = capitalizeName(lastName);
  if (phone !== undefined) user.phone = String(phone || '').trim() || null;
  if (address !== undefined) user.address = String(address || '').trim() || null;
  if (birthDate !== undefined) user.birthDate = validDate(birthDate) ? birthDate : null;
  if (hireDate !== undefined) user.hireDate = validDate(hireDate) ? hireDate : null;
  if (username !== undefined || email !== undefined) {
    const uname = username !== undefined ? String(username).trim().toLowerCase() : (user.username || '');
    const mail = email !== undefined ? String(email).trim().toLowerCase() : (user.email || '');
    if (!uname && !mail) return res.status(400).json({ error: 'Renseignez un nom de compte ou un email' });
    if (loginTaken(db, { email: mail, username: uname }, user.id)) {
      return res.status(409).json({ error: 'Ce nom de compte ou cet email est déjà utilisé' });
    }
    user.username = uname || null;
    user.email = mail || null;
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: 'Mot de passe de 6 caractères minimum' });
    user.passwordHash = await bcrypt.hash(String(password), 10);
  }

  if (groupId !== undefined) {
    if (groupId && !db.groups.some((g) => g.id === groupId)) return res.status(400).json({ error: 'Groupe invalide' });
    user.groupId = groupId || null;
  }
  user.balances = {
    congesN: congesN !== undefined ? Number(congesN) || 0 : user.balances.congesN,
    congesN1: congesN1 !== undefined ? Number(congesN1) || 0 : user.balances.congesN1,
    rcc: rcc !== undefined ? Number(rcc) || 0 : user.balances.rcc,
    heuresSupp: heuresSupp !== undefined ? Number(heuresSupp) || 0 : user.balances.heuresSupp,
  };
  if (congesN !== undefined) enableAccrual(user); // (ré)active l'acquisition CP
  // Réamorce le cycle glissant de 3 mois du RCC à chaque (ré)attribution.
  if (rcc !== undefined) user.rccAnchor = new Date().toISOString().slice(0, 10);
  if (isParent !== undefined) user.isParent = Boolean(isParent);
  if (ROLES.includes(role)) user.role = role;
  await save();
  res.json({ user: publicUser(user) });
});

// Supprimer un utilisateur (et ses demandes).
app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
  db.users = db.users.filter((u) => u.id !== user.id);
  db.requests = db.requests.filter((r) => r.userId !== user.id);
  await save();
  res.json({ ok: true });
});

// Suspendre / réactiver l'accès d'un salarié.
app.put('/api/admin/users/:id/suspend', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas suspendre votre propre compte' });
  user.suspended = Boolean((req.body || {}).suspended);
  await save();
  res.json({ user: publicUser(user) });
});

// Départ (démission / licenciement) : libère toutes ses réservations du
// calendrier et suspend son accès. Le compte est conservé pour l'historique.
app.post('/api/admin/users/:id/departure', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { mode } = req.body || {}; // 'demission' | 'licenciement'
  const removed = db.requests.filter((r) => r.userId === user.id).length;
  db.requests = db.requests.filter((r) => r.userId !== user.id);
  user.suspended = true;
  user.departure = { mode: mode === 'licenciement' ? 'licenciement' : 'demission', date: new Date().toISOString() };
  await save();
  res.json({ ok: true, removed });
});

// Auteur d'une demande : "Lui-même" si le salarié, sinon le nom du saisisseur.
function createdByName(usersById, r) {
  if (!r.createdBy || r.createdBy === r.userId) return 'Le salarié';
  const c = usersById[r.createdBy];
  return c ? `${c.firstName} ${c.lastName}` : 'Encadrement';
}

// Toutes les demandes (admin) avec infos utilisateur
app.get('/api/admin/requests', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  const groupsById = Object.fromEntries(db.groups.map((g) => [g.id, g]));
  const list = db.requests
    .map((r) => {
      const u = usersById[r.userId];
      const g = u ? groupsById[u.groupId] : null;
      return {
        ...r,
        userName: u ? `${u.firstName} ${u.lastName}` : 'Inconnu',
        isParent: u ? Boolean(u.isParent) : false,
        phone: u ? (u.phone || null) : null,
        groupId: u ? u.groupId : null,
        groupName: g ? g.name : '—',
        groupColor: g ? g.color : '#64748b',
        categoryLabel: categoryLabel(r.category),
        containsHoliday: rangeContainsHoliday(r.startDate, r.endDate),
        createdByName: createdByName(usersById, r),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ requests: list });
});

// Attribuer une absence à un salarié (depuis le calendrier).
// - Administrateur : la demande est créée VALIDÉE et le solde décompté.
// - Responsable : la demande est créée EN ATTENTE (l'administrateur tranche).
app.post('/api/admin/requests', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const { userId, category, pool, startDate, endDate, reason, replacedById, immediate, fractionnement, retardMinutes } = req.body || {};
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Salarié introuvable' });
  const cat = categoryByCode(category);
  if (!cat || cat.code === 'DCP') return res.status(400).json({ error: 'Motif invalide' });
  const poolOptions = CATEGORY_POOLS[category];
  let chosenPool = null;
  if (poolOptions) {
    if (!poolOptions.some((p) => p.value === pool)) {
      return res.status(400).json({ error: 'Précisez sur quel solde imputer' });
    }
    chosenPool = pool;
  }
  if (!validDate(startDate)) return res.status(400).json({ error: 'Date invalide' });

  // RETARD : une seule date, jamais dans le futur, durée en minutes.
  let days, hours, end = endDate, retMin = null;
  const RET_DURATIONS = [30, 60, 120, 180];
  if (category === 'RET') {
    const today = new Date().toISOString().slice(0, 10);
    if (startDate > today) return res.status(400).json({ error: 'Un retard ne peut pas être saisi dans le futur.' });
    end = startDate; // date unique
    retMin = RET_DURATIONS.includes(Number(retardMinutes)) ? Number(retardMinutes) : 30;
    days = 0; // un retard ne consomme pas de journée
    hours = Math.round((retMin / 60) * 100) / 100;
  } else {
    if (!validDate(end)) return res.status(400).json({ error: 'Dates invalides' });
    if (end < startDate) return res.status(400).json({ error: 'La date de fin précède la date de début' });
    days = holidays.countWorkingDays(startDate, end);
    if (days <= 0) return res.status(400).json({ error: 'Aucun jour ouvré sur cette période (dimanches/fériés exclus)' });
    hours = days * HOURS_PER_DAY;
  }

  // Remplaçant éventuel.
  const replacer = replacedById ? db.users.find((u) => u.id === replacedById) : null;
  if (replacer) {
    const na = replacerNotAllowed(db, req.user, replacer.id);
    if (na) return res.status(400).json({ error: na });
  }

  // L'administrateur peut choisir d'attribuer directement (validé) ou plus tard
  // (en attente). Le responsable propose toujours (en attente)… SAUF pour un
  // retard (RET) : simple constat d'exploitation, il ne consomme aucun solde et
  // n'a pas besoin de la validation d'un administrateur.
  const isAdmin = req.user.role === 'admin';
  const isRet = category === 'RET';
  const approveNow = (isAdmin || isRet) && immediate !== false;
  const request = {
    id: nextId('request'),
    userId,
    category,
    pool: chosenPool,
    startDate,
    endDate: end,
    reason: String(reason || '').trim() || cat.label,
    fractionnement: category === 'PMT' ? (fractionnement === 'fractionne' ? 'fractionne' : 'complet') : null,
    retardMinutes: retMin,
    days,
    hours,
    status: approveNow ? 'approved' : 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: approveNow ? new Date().toISOString() : null,
    decidedBy: approveNow ? req.user.id : null,
    createdBy: req.user.id,
    replacedById: replacer ? replacer.id : null,
    replacedByName: replacer ? `${replacer.firstName} ${replacer.lastName}` : null,
    adminNote: approveNow
      ? (isAdmin ? 'Attribué par l’administrateur' : `Retard enregistré par le responsable ${req.user.firstName} ${req.user.lastName}`)
      : (isAdmin ? 'Saisi par l’administrateur (à valider plus tard)' : `Proposé par le responsable ${req.user.firstName} ${req.user.lastName}`),
  };
  // Le solde n'est décompté que si la demande est validée.
  if (approveNow) {
    const d = deductionFor(request);
    if (d) user.balances[d.balance] = Math.round((user.balances[d.balance] - d.amount) * 100) / 100;
  }
  db.requests.push(request);
  await save();
  if (approveNow && user.email) {
    mail.sendLeaveStatus({ to: user.email, firstName: user.firstName, status: 'approved', category: cat.label, startDate, endDate });
  }
  res.json({ request, pendingValidation: !approveNow });
});

// Supprimer n'importe quelle demande (admin) — recrédite le solde si validée.
app.delete('/api/admin/requests/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  if (r.status === 'approved') {
    const user = db.users.find((u) => u.id === r.userId);
    const d = deductionFor(r);
    if (user && d) user.balances[d.balance] = Math.round((user.balances[d.balance] + d.amount) * 100) / 100;
  }
  db.requests = db.requests.filter((x) => x.id !== r.id);
  await save();
  res.json({ ok: true });
});

// Attribuer / changer le remplaçant d'une demande (admin).
app.put('/api/admin/requests/:id/replacement', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  const { replacedById } = req.body || {};
  if (!replacedById) { r.replacedById = null; r.replacedByName = null; await save(); return res.json({ request: r }); }
  const replacer = db.users.find((u) => u.id === replacedById);
  if (!replacer) return res.status(404).json({ error: 'Remplaçant introuvable' });
  const na = replacerNotAllowed(db, req.user, replacer.id);
  if (na) return res.status(400).json({ error: na });
  const conflict = replacerConflict(db, replacedById, r.startDate, r.endDate, r.id);
  if (conflict) return res.status(409).json({ error: `${replacer.firstName} ${replacer.lastName} n'est pas disponible (${conflict}) sur cette période — il ne peut pas être à deux endroits en même temps.` });
  r.replacedById = replacer.id;
  r.replacedByName = `${replacer.firstName} ${replacer.lastName}`;
  await save();
  res.json({ request: r });
});

// Modifier une saisie (admin) : période + décompte jours/heures, sans la
// supprimer. Réajuste le solde (recrédit de l'ancien décompte puis application
// du nouveau) si la demande est validée.
app.put('/api/admin/requests/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  const { startDate, endDate, days, hours, category, pool } = req.body || {};
  if (startDate && !validDate(startDate)) return res.status(400).json({ error: 'Date de début invalide' });
  if (endDate && !validDate(endDate)) return res.status(400).json({ error: 'Date de fin invalide' });
  if (category != null && category !== '' && !['CP', 'RCC', 'RCP'].includes(category)) return res.status(400).json({ error: 'Type de congé invalide' });
  const user = db.users.find((u) => u.id === r.userId);
  const wasApproved = r.status === 'approved';
  // Recrédite l'ancien décompte si la demande était validée.
  if (wasApproved && user) { const d = deductionFor(r); if (d) user.balances[d.balance] = Math.round((user.balances[d.balance] + d.amount) * 100) / 100; }
  // Applique les modifications.
  if (startDate) r.startDate = startDate;
  if (endDate) r.endDate = endDate;
  if (r.endDate < r.startDate) r.endDate = r.startDate;
  if (category != null && category !== '') { r.category = category; r.pool = category === 'CP' ? (pool === 'N1' ? 'N1' : null) : null; }
  if (days != null && days !== '') r.days = Math.max(0, Math.round((Number(days) || 0) * 100) / 100);
  if (hours != null && hours !== '') r.hours = Math.max(0, Math.round((Number(hours) || 0) * 100) / 100);
  // Applique le nouveau décompte.
  if (wasApproved && user) { const d = deductionFor(r); if (d) user.balances[d.balance] = Math.round((user.balances[d.balance] - d.amount) * 100) / 100; }
  await save();
  res.json({ request: r });
});

// Décision admin sur une demande (validation = déduction du solde)
app.post('/api/admin/requests/:id/decide', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  const { decision, adminNote } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

  // À la validation : vérifier que le remplaçant n'est pas déjà pris ailleurs.
  if (decision === 'approved' && r.replacedById) {
    const conflict = replacerConflict(db, r.replacedById, r.startDate, r.endDate, r.id);
    if (conflict) {
      return res.status(409).json({ error: `Validation impossible : le remplaçant ${r.replacedByName || ''} est déjà indisponible (${conflict}). Il ne peut pas être à deux endroits en même temps.` });
    }
  }

  if (decision === 'approved' && r.status !== 'approved') {
    const user = db.users.find((u) => u.id === r.userId);
    const d = deductionFor(r);
    if (user && d) {
      user.balances[d.balance] = Math.round((user.balances[d.balance] - d.amount) * 100) / 100;
    }
  }
  // Si on repasse d'approuvé à refusé, on recrédite le solde.
  if (decision === 'rejected' && r.status === 'approved') {
    const user = db.users.find((u) => u.id === r.userId);
    const d = deductionFor(r);
    if (user && d) {
      user.balances[d.balance] = Math.round((user.balances[d.balance] + d.amount) * 100) / 100;
    }
  }

  r.status = decision;
  r.adminNote = String(adminNote || '').trim();
  r.decidedAt = new Date().toISOString();
  r.decidedBy = req.user.id;
  await save();
  // Email de confirmation (accepté / refusé) au salarié.
  const reqUser = db.users.find((u) => u.id === r.userId);
  if (reqUser && reqUser.email) {
    mail.sendLeaveStatus({ to: reqUser.email, firstName: reqUser.firstName, status: decision, category: categoryLabel(r.category), startDate: r.startDate, endDate: r.endDate, note: r.adminNote });
  }
  // Push : informe le salarié de la décision sur sa demande.
  push.fire(push.notifyUser(getData(), save, r.userId, {
    title: decision === 'approved' ? 'Congé validé ✅' : 'Demande refusée',
    body: `${categoryLabel(r.category)} du ${frDate(r.startDate)} au ${frDate(r.endDate)} : ${decision === 'approved' ? 'validé' : 'refusé'}.${r.adminNote ? ' ' + r.adminNote : ''}`,
    url: '/', tag: 'leave-' + r.id,
  }));
  res.json({ request: r });
});

// Gestion des groupes (couleurs)
app.put('/api/admin/groups/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const g = db.groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Groupe introuvable' });
  const { name, color } = req.body || {};
  if (name) g.name = String(name).trim();
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) g.color = color;
  await save();
  res.json({ group: g });
});

// Créer un groupe de travail.
app.post('/api/admin/groups', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { name, color } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nom du groupe obligatoire' });
  const id = 'grp_' + slug(name) + '_' + Math.random().toString(36).slice(2, 6);
  const group = { id, name: String(name).trim(), color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#64748b' };
  db.groups.push(group);
  await save();
  res.json({ group });
});

// Supprimer un groupe (les salariés du groupe repassent "sans groupe").
app.delete('/api/admin/groups/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const id = req.params.id;
  if (!db.groups.some((g) => g.id === id)) return res.status(404).json({ error: 'Groupe introuvable' });
  db.groups = db.groups.filter((g) => g.id !== id);
  db.users.forEach((u) => { if (u.groupId === id) u.groupId = null; });
  await save();
  res.json({ ok: true });
});

// --- Fermetures (prise de congé interdite) -----------------------------------
app.post('/api/admin/closed-periods', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { label, start, end } = req.body || {};
  if (!validDate(start) || !validDate(end)) return res.status(400).json({ error: 'Dates invalides' });
  if (end < start) return res.status(400).json({ error: 'La date de fin précède la date de début' });
  const period = { id: nextId('request'), label: String(label || 'Fermeture').trim(), start, end };
  db.settings.closedPeriods.push(period);
  await save();
  res.json({ closedPeriods: db.settings.closedPeriods });
});

// Modifier une fermeture (intitulé et/ou dates) même déjà verrouillée.
app.put('/api/admin/closed-periods/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const p = (db.settings.closedPeriods || []).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Période introuvable' });
  const { label, start, end } = req.body || {};
  if (label !== undefined) p.label = String(label || 'Fermeture').trim();
  if (start !== undefined) { if (!validDate(start)) return res.status(400).json({ error: 'Date de début invalide' }); p.start = start; }
  if (end !== undefined) { if (!validDate(end)) return res.status(400).json({ error: 'Date de fin invalide' }); p.end = end; }
  if (p.end < p.start) return res.status(400).json({ error: 'La date de fin précède la date de début' });
  await save();
  res.json({ closedPeriods: db.settings.closedPeriods });
});

app.delete('/api/admin/closed-periods/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.settings.closedPeriods = (db.settings.closedPeriods || []).filter((p) => p.id !== req.params.id);
  await save();
  res.json({ closedPeriods: db.settings.closedPeriods });
});

// --- Vacances scolaires (Zone B, surbrillance) -------------------------------
app.put('/api/admin/school-holidays', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { schoolHolidays } = req.body || {};
  if (!Array.isArray(schoolHolidays)) return res.status(400).json({ error: 'Format invalide' });
  db.settings.schoolHolidays = schoolHolidays
    .filter((h) => validDate(h.start) && validDate(h.end))
    .map((h) => ({ label: String(h.label || 'Vacances').trim(), start: h.start, end: h.end }));
  await save();
  res.json({ schoolHolidays: db.settings.schoolHolidays });
});

// ---------------------------------------------------------------------------
// Parc de véhicules (flotte) : signalements chauffeurs, suivi, entretien, tours
// ---------------------------------------------------------------------------

const VEHICLE_ALERT_KM = 3000; // marge d'alerte avant l'échéance d'un entretien

// Points de contrôle d'un « tour du véhicule ».
//   group : 'doc' (documents/équipements) | 'etat' (propreté & état)
//   mandatory : un manquement constitue un possible manquement au règlement
//   hasId : on archive un n°/nom (licence, carte gasoil) pour le suivi croisé
const VEHICLE_CHECKS = [
  { code: 'extincteur', label: 'Extincteur', group: 'doc', mandatory: true },
  { code: 'licence', label: 'Licence de transport', group: 'doc', mandatory: true, hasId: true, idLabel: 'N° / nom de la licence' },
  { code: 'assurance', label: "Attestation d'assurance", group: 'doc', mandatory: true },
  { code: 'carte_grise', label: "Carte grise (certificat d'immatriculation)", group: 'doc', mandatory: true },
  { code: 'carte_gasoil', label: 'Carte gasoil / carburant', group: 'doc', mandatory: true, hasId: true, idLabel: 'N° / nom de la carte gasoil' },
  { code: 'gilet', label: 'Gilet de sécurité', group: 'doc', mandatory: true },
  { code: 'triangle', label: 'Triangle de signalisation', group: 'doc', mandatory: true },
  { code: 'constat', label: 'Constat amiable à bord', group: 'doc', mandatory: false },
  { code: 'roue_secours', label: 'Roue de secours / kit anti-crevaison', group: 'doc', mandatory: false },
  { code: 'proprete_ext', label: 'Propreté extérieure correcte', group: 'etat', mandatory: false },
  { code: 'proprete_int', label: 'Propreté intérieure correcte', group: 'etat', mandatory: false },
  { code: 'carburant', label: 'Niveau de carburant correct', group: 'etat', mandatory: false },
  { code: 'adblue', label: 'Niveau AdBlue correct', group: 'etat', mandatory: false },
  { code: 'pneus_etat', label: 'État visuel des pneus correct', group: 'etat', mandatory: false },
  { code: 'eclairage', label: 'Éclairage fonctionnel', group: 'etat', mandatory: false },
  { code: 'carrosserie', label: 'Carrosserie sans nouveau dommage', group: 'etat', mandatory: false },
];
const VEHICLE_CHECK_BY_CODE = Object.fromEntries(VEHICLE_CHECKS.map((c) => [c.code, c]));

function intStr(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

// Dernière inspection (tour) par véhicule.
function latestInspections(db) {
  const latest = {};
  for (const ins of db.vehicleInspections) {
    if (!latest[ins.vehicleId] || ins.createdAt > latest[ins.vehicleId].createdAt) latest[ins.vehicleId] = ins;
  }
  return latest;
}

// Alertes de conformité de la flotte (documents/équipements manquants, propreté,
// et anomalies de localisation des documents identifiés). Sert à la page d'accueil
// pour mettre les véhicules/chauffeurs en demeure avant un avertissement.
function fleetWarnings(db) {
  const latest = latestInspections(db);
  // Où se trouve chaque document identifié (licence, carte gasoil) au dernier tour.
  const presentId = {}; // code -> { id -> [ {vehicleId, vehicleName} ] }
  for (const v of db.vehicles) {
    const ins = latest[v.id]; if (!ins || !ins.checks) continue;
    for (const c of VEHICLE_CHECKS) {
      if (!c.hasId) continue;
      const ck = ins.checks[c.code];
      if (ck && ck.ok !== false && ck.id) {
        presentId[c.code] = presentId[c.code] || {};
        (presentId[c.code][ck.id] = presentId[c.code][ck.id] || []).push({ vehicleId: v.id, vehicleName: v.name });
      }
    }
  }
  const warnings = [];
  for (const v of db.vehicles) {
    const ins = latest[v.id]; if (!ins || !ins.checks) continue;
    const driverName = ins.driverName || null;
    for (const c of VEHICLE_CHECKS) {
      const ck = ins.checks[c.code];
      if (!ck || ck.ok !== false) continue; // seul un élément explicitement non conforme alerte
      if (ins.regularized && ins.regularized[c.code]) continue; // manquement régularisé : retiré de l'accueil
      let foundOn = null;
      if (c.hasId) {
        const owned = v.documents && v.documents[c.code] && v.documents[c.code].id;
        if (owned && presentId[c.code] && presentId[c.code][owned]) {
          const others = presentId[c.code][owned].filter((x) => x.vehicleId !== v.id);
          if (others.length) foundOn = others.map((o) => o.vehicleName).join(', ');
        }
      }
      const detail = c.mandatory
        ? `${c.label} non présent(e) / non conforme à bord lors du contrôle du ${ins.date}.`
          + (foundOn ? ` Ce document est peut-être à bord de : ${foundOn}.` : '')
          + ' Élément obligatoire — manquement susceptible de relever du règlement intérieur (obligation d\'entretien et de présentation du véhicule et de ses documents). Mise en conformité requise avant avertissement.'
        : `${c.label} : à corriger (constaté le ${ins.date}).`;
      warnings.push({
        vehicleId: v.id, vehicleName: v.name, plate: v.plate || null, driverName,
        severity: c.mandatory ? 'avertissement' : 'surveillance',
        item: c.label, reglement: !!c.mandatory, foundOn, date: ins.date, detail,
      });
    }
  }
  // Anomalie : un même document identifié présent dans plusieurs véhicules.
  for (const code of Object.keys(presentId)) {
    for (const id of Object.keys(presentId[code])) {
      const list = presentId[code][id];
      if (list.length > 1) {
        const names = list.map((x) => x.vehicleName).join(', ');
        warnings.push({
          vehicleId: null, vehicleName: names, plate: null, driverName: null,
          severity: 'avertissement', anomaly: true, reglement: true,
          item: VEHICLE_CHECK_BY_CODE[code].label, foundOn: names, date: null,
          detail: `${VEHICLE_CHECK_BY_CODE[code].label} « ${id} » relevé(e) à bord de plusieurs véhicules (${names}). Un même document ne peut être présent que dans un seul véhicule : vérifiez sa localisation.`,
        });
      }
    }
  }
  // Clé stable + filtrage des alertes marquées « lues » (acquittées).
  const acks = db.settings.vehicleWarnAcks || {};
  warnings.forEach((w) => { w.key = `${w.vehicleId || w.vehicleName}|${w.item}|${w.date || ''}`; w.acked = !!acks[w.key]; });
  const visible = warnings.filter((w) => !w.acked);
  // Tri : avertissements (règlement) d'abord.
  visible.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'avertissement' ? -1 : 1));
  return visible;
}

// Modèles de véhicules proposés (liste déroulante à l'ajout).
const VEHICLE_MODELS = ['Mercedes Sprinter 12m³', 'Mercedes Sprinter 14m³', 'Citan 6m³'];

// Kits d'entretien par service (catégories de pièces + quantités). La quantité
// d'huile dépend du modèle : 9,5 L (Sprinter) / 5,4 L (Citan).
function oilLitres(model) { return /citan/i.test(model || '') ? 5.4 : 9.5; }
function serviceKit(service, model) {
  const oil = { cat: 'Huile moteur 5W30', qty: oilLitres(model) };
  if (service === 'service_a') return [{ cat: 'Filtre à huile', qty: 1 }, { cat: 'Filtre habitacle', qty: 1 }, oil];
  if (service === 'service_b') return [{ cat: 'Filtre à huile', qty: 1 }, { cat: 'Filtre à air', qty: 1 }, { cat: 'Filtre habitacle', qty: 1 }, { cat: 'Filtre à gasoil', qty: 1 }, oil];
  return [];
}

// Statut du contrôle technique d'un véhicule.
//   1er CT : 4 ans après la 1re mise en circulation (anniversaire).
//   Ensuite, cadence annuelle alternée CT / contrôle pollution (rappel à
//   l'anniversaire de l'année suivante après chaque contrôle saisi).
function addYears(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function ctStatus(v) {
  const today = new Date().toISOString().slice(0, 10);
  const controls = (v.ctControls || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const firstCTDue = v.firstRegistration ? addYears(v.firstRegistration, 4) : null;
  let nextDate = null, nextType = 'CT';
  if (controls.length) {
    const last = controls[controls.length - 1];
    nextType = last.type === 'CT' ? 'pollution' : 'CT';
    nextDate = addYears(last.date, 1);
  } else if (firstCTDue) {
    nextDate = firstCTDue; nextType = 'CT';
  }
  let level = 'ok';
  if (nextDate) {
    if (nextDate < today) level = 'overdue';
    else if (nextDate <= addDays(today, 60)) level = 'soon';
  }
  return { nextDate, nextType, firstCTDue, level, lastControl: controls[controls.length - 1] || null };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Norme constructeur d'un consommable selon l'usage du véhicule.
function normFor(c, usage) {
  return usage === 'ville' ? (c.normVille || c.interval) : (c.normRoute || c.interval);
}

// Met une plaque au format AA-123-BB si l'utilisateur a oublié les tirets.
function formatPlate(s) {
  const raw = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = raw.match(/^([A-Z]{2})(\d{3})([A-Z]{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return String(s || '').trim().toUpperCase();
}

// Kilométrage "effectif" d'un véhicule : le plus élevé connu entre la valeur
// saisie, les signalements, les remplacements et les tours de véhicule.
function effectiveKm(db, v) {
  let km = Number(v.km) || 0;
  const consider = (arr) => arr.filter((x) => x.vehicleId === v.id)
    .forEach((x) => { const k = Number(x.km); if (Number.isFinite(k) && k > km) km = k; });
  consider(db.vehicleReports);
  consider(db.vehicleMaint);
  consider(db.vehicleInspections);
  return km;
}

// Convertit un indice d'usure (norme / intervalle réel) en note de conduite.
//   ratio > 1 : pièces usées plus vite que la norme -> conduite brutale.
function drivingFromRatio(ratio) {
  if (ratio == null) return { score: null, grade: '—', label: 'Données insuffisantes' };
  // score sur 20 : 20 = très souple (use lentement), baisse si usure rapide.
  let score = Math.round(Math.max(0, Math.min(20, 14 - (ratio - 1) * 20)));
  let grade, label;
  if (ratio <= 0.9) { grade = 'A'; label = 'Conduite souple (consommables ménagés)'; }
  else if (ratio <= 1.1) { grade = 'B'; label = 'Conduite normale'; }
  else if (ratio <= 1.3) { grade = 'C'; label = 'Usure un peu rapide'; }
  else if (ratio <= 1.6) { grade = 'D'; label = 'Conduite appuyée (usure rapide)'; }
  else { grade = 'E'; label = 'Usure anormale (conduite brutale)'; }
  return { score, grade, label };
}

// Analyse de durabilité des consommables et prévision des prochains entretiens.
// L'intervalle réel est calculé véhicule par véhicule : il repart de chaque
// remplacement enregistré (le 1er cycle, depuis le km d'origine, peut être plus
// court car le véhicule roulait déjà). À défaut de données, on prend la norme.
function fleetAnalysis(db) {
  const consumables = db.settings.vehicleConsumables || [];
  const driverAgg = {}; // userId -> { name, ratios:[] }
  const vehicles = db.vehicles.map((v) => {
    const usage = v.usage === 'ville' ? 'ville' : 'mixte';
    const curKm = effectiveKm(db, v);
    const base = Number(v.baseKm) || 0;
    const vRatios = [];
    const items = consumables.map((c) => {
      const recs = db.vehicleMaint
        .filter((m) => m.vehicleId === v.id && m.part === c.code)
        .map((m) => Number(m.km)).filter((k) => Number.isFinite(k)).sort((a, b) => a - b);
      const norm = normFor(c, usage);
      // Écarts entre remplacements successifs (cycles complets) ; le segment
      // base -> 1er remplacement est ignoré (cycle partiel, véhicule déjà roulé).
      const gaps = [];
      for (let i = 1; i < recs.length; i++) gaps.push(recs[i] - recs[i - 1]);
      const realInterval = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
      const interval = realInterval != null ? realInterval : norm;
      const lastKm = recs.length ? recs[recs.length - 1] : null;
      const startKm = lastKm != null ? lastKm : base;
      const dueKm = startKm + interval;
      const remaining = dueKm - curKm;
      let level = 'ok';
      if (remaining <= 0) level = 'overdue';
      else if (remaining <= VEHICLE_ALERT_KM) level = 'soon';
      // Indice d'usure vs norme (uniquement si un cycle complet est mesuré).
      const wearRatio = realInterval != null && realInterval > 0 ? Math.round((norm / realInterval) * 100) / 100 : null;
      if (wearRatio != null) vRatios.push(wearRatio);
      return { code: c.code, label: c.label, interval, realInterval, norm, lastKm, startKm, dueKm, remaining, level, count: recs.length, wearRatio };
    });
    const vRatio = vRatios.length ? Math.round((vRatios.reduce((a, b) => a + b, 0) / vRatios.length) * 100) / 100 : null;
    const driving = drivingFromRatio(vRatio);
    if (v.assignedUserId && vRatio != null) {
      const agg = driverAgg[v.assignedUserId] = driverAgg[v.assignedUserId] || { userId: v.assignedUserId, name: v.assignedUserName || '—', ratios: [] };
      agg.ratios.push(vRatio);
    }
    return {
      id: v.id, name: v.name, plate: v.plate, model: v.model, active: v.active !== false,
      usage, relais: !!v.relais, groupId: v.groupId || null, tournee: v.tournee || null,
      assignedUserId: v.assignedUserId || null, assignedUserName: v.assignedUserName || null,
      km: Number(v.km) || 0, baseKm: base, curKm, items, wearRatio: vRatio, driving,
      firstRegistration: v.firstRegistration || null, ctControls: v.ctControls || [], ct: ctStatus(v),
    };
  });
  // Notes de conduite par chauffeur (moyenne des véhicules qui lui sont attribués).
  const drivers = Object.values(driverAgg).map((a) => {
    const r = a.ratios.reduce((x, y) => x + y, 0) / a.ratios.length;
    const ratio = Math.round(r * 100) / 100;
    return { userId: a.userId, name: a.name, ratio, ...drivingFromRatio(ratio) };
  }).sort((a, b) => b.ratio - a.ratio);
  return { vehicles, consumables, alertKm: VEHICLE_ALERT_KM, drivers, models: VEHICLE_MODELS };
}

// Motifs d'absence ouvrant droit, selon le règlement intérieur, à un rappel,
// un avertissement ou une sanction. Affiché à l'encadrement sur l'accueil.
const SANCTIONABLE_ABSENCES = {
  ABS: 'Absence injustifiée — manquement à l’obligation de présence et de justification (art. règlement intérieur). Susceptible d’un avertissement, voire d’une sanction.',
  ANRN: 'Absence non autorisée et non rémunérée — absence sans autorisation préalable. Susceptible d’une sanction disciplinaire.',
  PNE: 'Préavis non effectué — manquement aux obligations contractuelles.',
  MAP: 'Mise à pied conservatoire en cours.',
};
const RETARD_THRESHOLD = 3; // nb de retards sur 90 j déclenchant un rappel

// Bilan disciplinaire (lié au règlement intérieur) sur les 12 derniers mois.
function disciplineList(db) {
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  const groupsById = Object.fromEntries(db.groups.map((g) => [g.id, g]));
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const byUser = {};
  const ensure = (u) => (byUser[u.id] = byUser[u.id] || {
    userId: u.id, name: `${u.firstName} ${u.lastName}`,
    groupName: u.groupId && groupsById[u.groupId] ? groupsById[u.groupId].name : '—',
    items: [],
  });
  // Comptage des motifs fautifs + retards.
  const counts = {}; // userId -> { code -> n }
  for (const r of db.requests) {
    if (r.status === 'rejected') continue;
    if (r.startDate < yearAgo) continue;
    const u = usersById[r.userId]; if (!u) continue;
    if (SANCTIONABLE_ABSENCES[r.category]) {
      counts[u.id] = counts[u.id] || {}; counts[u.id][r.category] = (counts[u.id][r.category] || 0) + 1;
    }
    if (r.category === 'RET' && r.status === 'approved' && r.startDate >= d90) {
      counts[u.id] = counts[u.id] || {}; counts[u.id].RET = (counts[u.id].RET || 0) + 1;
    }
  }
  for (const uid of Object.keys(counts)) {
    const u = usersById[uid]; if (!u) continue;
    const c = counts[uid];
    for (const code of Object.keys(SANCTIONABLE_ABSENCES)) {
      if (c[code]) ensure(u).items.push({ category: code, label: categoryLabel(code), count: c[code], reproach: SANCTIONABLE_ABSENCES[code] });
    }
    if (c.RET && c.RET >= RETARD_THRESHOLD) {
      ensure(u).items.push({ category: 'RET', label: 'Retards répétés', count: c.RET, reproach: `${c.RET} retards sur les 90 derniers jours — manquement à la ponctualité (règlement intérieur). Un rappel à l’ordre, voire un avertissement, peut être envisagé.` });
    }
  }
  // On masque de l'accueil les rappels déjà clôturés (sanction archivée).
  const acks = db.settings.disciplineAcks || {};
  return Object.values(byUser).filter((x) => x.items.length && !acks[x.userId]);
}

const SANCTION_TYPES = ['Rappel à l\'ordre', 'Avertissement', 'Mise à pied conservatoire', 'Mise à pied disciplinaire', 'Convocation entretien préalable', 'Procédure de licenciement', 'Autre'];

// Liste des avertissements / sanctions archivés.
app.get('/api/staff/sanctions', authRequired, staffRequired, (req, res) => {
  res.json({ sanctions: getData().sanctions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')), types: SANCTION_TYPES });
});
// Enregistrer une sanction (et clôturer le rappel sur l'accueil).
app.post('/api/admin/sanctions', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, type, date, motif } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
  const s = {
    id: nextId('sanction'), userId, userName: `${u.firstName} ${u.lastName}`,
    type: SANCTION_TYPES.includes(type) ? type : 'Avertissement',
    date: validDate(date) ? date : new Date().toISOString().slice(0, 10),
    motif: String(motif || '').trim(),
    createdBy: req.user.id, createdByName: `${req.user.firstName} ${req.user.lastName}`, createdAt: new Date().toISOString(),
  };
  db.sanctions.push(s);
  db.settings.disciplineAcks = db.settings.disciplineAcks || {};
  db.settings.disciplineAcks[userId] = true; // clôt le rappel d'accueil
  await save();
  res.json({ sanction: s });
});
app.delete('/api/admin/sanctions/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.sanctions = db.sanctions.filter((s) => s.id !== req.params.id);
  await save();
  res.json({ ok: true });
});
// Rouvrir un rappel disciplinaire (le ré-afficher sur l'accueil).
app.post('/api/admin/discipline/:userId/reopen', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  if (db.settings.disciplineAcks) delete db.settings.disciplineAcks[req.params.userId];
  await save();
  res.json({ ok: true });
});

// Un administrateur ne peut pas être remplaçant (sauf se désigner lui-même).
function replacerNotAllowed(db, reqUser, replacerId) {
  const u = db.users.find((x) => x.id === replacerId);
  if (!u) return null;
  if (u.role === 'admin' && !(reqUser.role === 'admin' && reqUser.id === replacerId)) {
    return 'Un administrateur ne peut pas être désigné comme remplaçant. Seul un administrateur peut se désigner lui-même.';
  }
  return null;
}

app.get('/api/staff/discipline', authRequired, staffRequired, (req, res) => {
  res.json({ items: disciplineList(getData()) });
});

// Données véhicule pour la page d'accueil de l'encadrement : signalements en
// attente + entretiens à anticiper.
app.get('/api/staff/vehicle-dashboard', authRequired, staffRequired, (req, res) => {
  const db = getData();
  const analysis = fleetAnalysis(db);
  const alerts = [];
  analysis.vehicles.forEach((v) => v.items.forEach((it) => {
    if (it.level === 'overdue' || it.level === 'soon') {
      alerts.push({ vehicleName: v.name, plate: v.plate, label: it.label, level: it.level, remaining: it.remaining, dueKm: it.dueKm, curKm: v.curKm });
    }
  }));
  alerts.sort((a, b) => a.remaining - b.remaining);
  // Rappels contrôle technique / pollution.
  const ctReminders = [];
  analysis.vehicles.forEach((v) => {
    if (v.ct && v.ct.nextDate && (v.ct.level === 'overdue' || v.ct.level === 'soon')) {
      ctReminders.push({ vehicleName: v.name, plate: v.plate, type: v.ct.nextType, date: v.ct.nextDate, level: v.ct.level });
    }
  });
  ctReminders.sort((a, b) => a.date.localeCompare(b.date));
  // Entretiens programmés (libres) proches de l'échéance.
  const today = new Date().toISOString().slice(0, 10);
  const scheduled = (db.vehicleSchedule || []).filter((s) => !s.done).map((s) => {
    const v = db.vehicles.find((x) => x.id === s.vehicleId) || {};
    const curKm = effectiveKm(db, v);
    let near = false, over = false;
    if (s.dueKm != null) { const r = s.dueKm - curKm; if (r <= 0) over = true; else if (r <= VEHICLE_ALERT_KM) near = true; }
    if (s.dueDate) { if (s.dueDate < today) over = true; else if (s.dueDate <= addDays(today, 30)) near = true; }
    return { vehicleName: v.name, plate: v.plate, label: s.label, dueKm: s.dueKm, dueDate: s.dueDate, over, near };
  }).filter((s) => s.over || s.near);
  const pendingReports = db.vehicleReports.filter((r) => r.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ pendingReports, alerts, ctReminders, scheduled });
});

// --- Côté salarié : liste de la flotte + signalement d'usure -----------------
app.get('/api/vehicles', authRequired, (req, res) => {
  const list = getData().vehicles
    .filter((v) => v.active !== false)
    .map((v) => ({ id: v.id, name: v.name, plate: v.plate, model: v.model, km: Number(v.km) || 0, groupId: v.groupId || null, tournee: v.tournee || null, relais: !!v.relais }));
  res.json({ vehicles: list });
});

app.post('/api/vehicles/report', authRequired, async (req, res) => {
  const db = getData();
  const { vehicleId, plate, km, issues, note } = req.body || {};
  const v = db.vehicles.find((x) => x.id === vehicleId);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable — sélectionnez votre véhicule dans la liste.' });
  const plateClean = formatPlate(plate);
  if (!plateClean) return res.status(400).json({ error: 'La plaque d’immatriculation est obligatoire.' });
  const kmNum = intStr(km);
  if (kmNum == null || kmNum < 0) return res.status(400).json({ error: 'Le kilométrage est obligatoire (nombre).' });
  // Le kilométrage ne peut pas diminuer (sauf 1re saisie).
  if (kmNum < (Number(v.km) || 0)) {
    return res.status(400).json({ error: `Le kilométrage (${kmNum}) ne peut pas être inférieur au dernier relevé (${v.km} km).` });
  }
  const issueList = Array.isArray(issues) ? issues.map((s) => String(s).trim()).filter(Boolean).slice(0, 40) : [];
  if (!issueList.length && !String(note || '').trim()) {
    return res.status(400).json({ error: 'Indiquez au moins une usure constatée ou une précision.' });
  }
  const report = {
    id: nextId('vreport'),
    vehicleId: v.id,
    vehicleName: v.name,
    plate: plateClean,
    km: kmNum,
    userId: req.user.id,
    userName: `${req.user.firstName} ${req.user.lastName}`,
    issues: issueList,
    note: String(note || '').trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    adminNote: '',
    resolution: null,     // 'done' | 'notdone'
    resolutions: [],      // [{ issue, done }]
  };
  // Le kilométrage le plus récent fait progresser le compteur du véhicule.
  if (kmNum > (Number(v.km) || 0)) v.km = kmNum;
  db.vehicleReports.push(report);
  await save();
  // Push : prévient l'encadrement d'un signalement / demande d'entretien véhicule.
  push.fire(push.notifyUsers(getData(), save, push.staffIds(getData()), {
    title: '🔧 Signalement véhicule',
    body: `${report.userName} — ${report.vehicleName} (${report.plate})${report.issues.length ? ' : ' + report.issues.slice(0, 3).join(', ') : ''}${report.note ? ' — ' + report.note.slice(0, 80) : ''}`,
    url: '/', tag: 'vreport-' + report.id,
  }));
  res.json({ report });
});

app.get('/api/me/vehicle-reports', authRequired, (req, res) => {
  const mine = getData().vehicleReports
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ reports: mine });
});

// --- Côté encadrement : suivi complet de la flotte ---------------------------
app.get('/api/staff/vehicles', authRequired, staffRequired, (req, res) => {
  const db = getData();
  const analysis = fleetAnalysis(db);
  const team = db.users
    .filter((u) => u.status === 'active' && !u.suspended)
    .map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, role: u.role, groupId: u.groupId }))
    .sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  res.json({
    analysis,
    vehicles: db.vehicles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))),
    reports: db.vehicleReports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    maint: db.vehicleMaint.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    inspections: db.vehicleInspections.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    consumables: db.settings.vehicleConsumables || [],
    checksDef: VEHICLE_CHECKS,
    models: VEHICLE_MODELS,
    team,
    groups: db.groups,
    schedule: db.vehicleSchedule.slice(),
    warnings: fleetWarnings(db),
  });
});

// Alertes de conformité de la flotte (pour la page d'accueil de l'encadrement).
app.get('/api/staff/vehicle-warnings', authRequired, staffRequired, (req, res) => {
  res.json({ warnings: fleetWarnings(getData()) });
});

// Construit le nom d'affichage d'un véhicule à partir de tournée / groupe / chauffeur.
function buildVehicleName(db, { name, tournee, groupId, assignedUserName }) {
  if (name && String(name).trim()) return String(name).trim();
  const g = groupId ? db.groups.find((x) => x.id === groupId) : null;
  const parts = [];
  if (tournee && String(tournee).trim()) parts.push(String(tournee).trim());
  else if (g) parts.push(g.name);
  if (assignedUserName) parts.push(assignedUserName);
  return parts.join(' — ') || 'Véhicule';
}

// Flotte : ajout / modification / suppression (administrateur).
app.post('/api/admin/vehicles', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { name, plate, model, km, baseKm, groupId, tournee, assignedUserId, relais, usage } = req.body || {};
  const assigned = assignedUserId ? db.users.find((u) => u.id === assignedUserId) : null;
  const assignedUserName = assigned ? `${assigned.firstName} ${assigned.lastName}` : null;
  const dispName = buildVehicleName(db, { name, tournee, groupId, assignedUserName });
  const kmInit = intStr(km) || 0;
  const vehicle = {
    id: nextId('vehicle'),
    name: dispName,
    plate: plate ? formatPlate(plate) : null,
    model: VEHICLE_MODELS.includes(model) ? model : (String(model || '').trim() || null),
    km: kmInit,
    baseKm: intStr(baseKm) != null ? intStr(baseKm) : kmInit,
    usage: usage === 'ville' ? 'ville' : 'mixte',
    relais: Boolean(relais),
    groupId: groupId && db.groups.some((g) => g.id === groupId) ? groupId : null,
    tournee: String(tournee || '').trim() || null,
    assignedUserId: assigned ? assigned.id : null,
    assignedUserName,
    documents: {},
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.vehicles.push(vehicle);
  await save();
  res.json({ vehicle });
});

app.put('/api/admin/vehicles/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { name, plate, model, km, baseKm, active, groupId, tournee, assignedUserId, relais, usage, firstRegistration } = req.body || {};
  if (firstRegistration !== undefined) v.firstRegistration = validDate(firstRegistration) ? firstRegistration : null;
  if (plate !== undefined) v.plate = plate ? formatPlate(plate) : null;
  if (model !== undefined) v.model = VEHICLE_MODELS.includes(model) ? model : (String(model || '').trim() || null);
  if (groupId !== undefined) v.groupId = groupId && db.groups.some((g) => g.id === groupId) ? groupId : null;
  if (tournee !== undefined) v.tournee = String(tournee || '').trim() || null;
  if (assignedUserId !== undefined) {
    const assigned = assignedUserId ? db.users.find((u) => u.id === assignedUserId) : null;
    v.assignedUserId = assigned ? assigned.id : null;
    v.assignedUserName = assigned ? `${assigned.firstName} ${assigned.lastName}` : null;
  }
  if (relais !== undefined) v.relais = Boolean(relais);
  if (usage !== undefined) v.usage = usage === 'ville' ? 'ville' : 'mixte';
  // Le nom suit la tournée/groupe/chauffeur sauf nom explicite fourni.
  if (name !== undefined && String(name).trim()) v.name = String(name).trim();
  else if (name !== undefined || groupId !== undefined || tournee !== undefined || assignedUserId !== undefined) {
    v.name = buildVehicleName(db, { name: '', tournee: v.tournee, groupId: v.groupId, assignedUserName: v.assignedUserName });
  }
  // Le km d'origine (baseKm) est librement corrigeable (point de départ des calculs).
  if (baseKm !== undefined && intStr(baseKm) != null) v.baseKm = intStr(baseKm);
  // Le kilométrage courant ne peut qu'augmenter (jamais diminuer).
  if (km !== undefined && intStr(km) != null) {
    const next = intStr(km);
    if (next < (Number(v.km) || 0)) return res.status(400).json({ error: `Le kilométrage ne peut pas diminuer (actuel : ${v.km} km).` });
    v.km = next;
  }
  if (active !== undefined) v.active = Boolean(active);
  await save();
  res.json({ vehicle: v, analysis: fleetAnalysis(db) });
});

app.delete('/api/admin/vehicles/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  if (!db.vehicles.some((v) => v.id === req.params.id)) return res.status(404).json({ error: 'Véhicule introuvable' });
  db.vehicles = db.vehicles.filter((v) => v.id !== req.params.id);
  db.vehicleReports = db.vehicleReports.filter((r) => r.vehicleId !== req.params.id);
  db.vehicleMaint = db.vehicleMaint.filter((m) => m.vehicleId !== req.params.id);
  db.vehicleInspections = db.vehicleInspections.filter((i) => i.vehicleId !== req.params.id);
  db.vehicleSchedule = db.vehicleSchedule.filter((s) => s.vehicleId !== req.params.id);
  db.vehicleExpenses = db.vehicleExpenses.filter((e) => e.vehicleId !== req.params.id);
  await save();
  res.json({ ok: true });
});

// Enregistrer le remplacement d'une pièce (kilométrage pris en compte).
app.post('/api/admin/vehicles/:id/maint', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { part, km, date, note, partId, qty, items } = req.body || {};
  const consumables = db.settings.vehicleConsumables || [];
  if (!consumables.some((c) => c.code === part)) return res.status(400).json({ error: 'Pièce / consommable invalide' });
  const kmNum = intStr(km);
  if (kmNum == null || kmNum < 0) return res.status(400).json({ error: 'Kilométrage du remplacement obligatoire' });
  const mdate = validDate(date) ? date : new Date().toISOString().slice(0, 10);
  // Pièces consommées : kit du service + pièces additionnelles (déstockage +
  // imputation directe du coût au véhicule, sans double saisie).
  let lines = Array.isArray(items) ? items.slice() : [];
  if (partId) lines.push({ partId, qty });
  let cost = 0; const usedNames = [];
  for (const it of lines) {
    const p = db.parts.find((x) => x.id === it.partId);
    if (!p) continue;
    const q = num(it.qty) || 1;
    const lineCost = Math.round(p.unitPrice * q * 100) / 100;
    cost += lineCost;
    p.qty = Math.max(0, Math.round((p.qty - q) * 100) / 100);
    usedNames.push(`${p.name} ×${q}`);
    db.vehicleExpenses.push({ id: nextId('vexp'), vehicleId: v.id, date: mdate, category: 'entretien', label: `${p.name} (${q} ${p.unit})`, amount: lineCost, partId: p.id, qty: q, km: kmNum });
  }
  cost = lines.length ? Math.round(cost * 100) / 100 : null;
  const rec = {
    id: nextId('vmaint'),
    vehicleId: v.id,
    part,
    km: kmNum,
    date: mdate,
    note: String(note || '').trim(),
    items: lines.map((l) => ({ partId: l.partId, qty: num(l.qty) || 1 })),
    partName: usedNames.join(', ') || null,
    cost,
    createdBy: req.user.id,
    createdAt: new Date().toISOString(),
  };
  if (kmNum > (Number(v.km) || 0)) v.km = kmNum;
  db.vehicleMaint.push(rec);
  await save();
  res.json({ maint: rec, analysis: fleetAnalysis(db) });
});

// Corriger le kilométrage / la date d'un remplacement (en cas d'erreur de saisie).
app.put('/api/admin/vehicles/maint/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const m = db.vehicleMaint.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Remplacement introuvable' });
  const { km, date, note } = req.body || {};
  if (km !== undefined) { const k = intStr(km); if (k == null || k < 0) return res.status(400).json({ error: 'Kilométrage invalide' }); m.km = k; }
  if (date !== undefined && validDate(date)) m.date = date;
  if (note !== undefined) m.note = String(note || '').trim();
  await save();
  res.json({ maint: m, analysis: fleetAnalysis(db) });
});

app.delete('/api/admin/vehicles/maint/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.vehicleMaint = db.vehicleMaint.filter((m) => m.id !== req.params.id);
  await save();
  res.json({ ok: true, analysis: fleetAnalysis(db) });
});

// Décision sur un signalement véhicule (examiné / clôturé) — administrateur.
// À la clôture : indique au chauffeur si les travaux ont été réalisés (avec
// le détail par usure) et, sinon, le motif de non-réalisation.
app.post('/api/admin/vehicle-reports/:id/decide', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.vehicleReports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Signalement introuvable' });
  const { decision, adminNote, resolutions, resolution, checkup } = req.body || {};
  if (!['reviewed', 'closed', 'pending'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });
  r.status = decision;
  r.adminNote = String(adminNote || '').trim();
  if (Array.isArray(checkup)) r.checkup = checkup.map((c) => ({ label: String(c.label || '').slice(0, 120), ok: !!c.ok }));
  if (Array.isArray(resolutions)) {
    r.resolutions = resolutions.map((x) => ({ issue: String(x.issue || '').slice(0, 200), done: !!x.done }));
  }
  if (decision === 'closed') {
    if (resolution === 'none') {
      // « Aucune réparation à effectuer » : vérifié, rien à prévoir.
      r.resolution = 'none';
      r.resolutions = (r.issues || []).map((i) => ({ issue: i, done: false }));
      if (!r.adminNote) r.adminNote = 'Vérifié : aucune réparation à effectuer.';
    } else {
      const total = r.resolutions.length || (r.issues ? r.issues.length : 0);
      const done = r.resolutions.filter((x) => x.done).length;
      r.resolution = total > 0 && done === 0 ? 'notdone' : (done < total ? 'partial' : 'done');
      if (r.resolution !== 'done' && !r.adminNote) {
        return res.status(400).json({ error: 'Précisez le motif lorsque les travaux ne sont pas (entièrement) réalisés.' });
      }
    }
  }
  r.decidedAt = new Date().toISOString();
  r.decidedBy = req.user.id;
  await save();
  // Push : informe le chauffeur du traitement de son signalement.
  if (decision === 'closed') {
    const resLbl = r.resolution === 'done' ? 'travaux réalisés ✅' : r.resolution === 'partial' ? 'travaux partiellement réalisés' : r.resolution === 'notdone' ? 'travaux non réalisés' : 'clôturé';
    push.fire(push.notifyUser(getData(), save, r.userId, {
      title: '🔧 Signalement véhicule traité',
      body: `${r.vehicleName} (${r.plate}) : ${resLbl}.${r.adminNote ? ' ' + r.adminNote.slice(0, 100) : ''}`,
      url: '/', tag: 'vreport-' + r.id,
    }));
  }
  res.json({ report: r });
});

// Tour du véhicule : relevé des chocs / dommages (encadrement).
app.post('/api/staff/vehicles/:id/inspection', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { km, date, impacts, note, driverId, checks } = req.body || {};
  const cleanImpacts = Array.isArray(impacts) ? impacts.map((i, idx) => ({
    id: nextId('vimpact'),
    zone: String(i.zone || '').slice(0, 60),
    zoneLabel: String(i.zoneLabel || i.zone || '').slice(0, 80),
    type: String(i.type || '').slice(0, 60),
    note: String(i.note || '').trim().slice(0, 200),
    repaired: false,
  })).filter((i) => i.zone && i.type).slice(0, 60) : [];
  // Points de contrôle (documents/équipements/propreté). Non conforme = ok:false.
  const cleanChecks = {};
  if (checks && typeof checks === 'object') {
    for (const c of VEHICLE_CHECKS) {
      const v0 = checks[c.code];
      if (v0 === undefined) continue;
      cleanChecks[c.code] = { ok: v0.ok !== false, id: c.hasId ? String(v0.id || '').trim().slice(0, 60) : '' };
    }
  }
  if (!cleanImpacts.length && !Object.keys(cleanChecks).length) {
    return res.status(400).json({ error: 'Renseignez les points de contrôle ou au moins un choc/dommage sur le schéma.' });
  }
  const driver = driverId ? db.users.find((u) => u.id === driverId) : null;
  const kmNum = intStr(km);
  const inspDate = validDate(date) ? date : new Date().toISOString().slice(0, 10);
  const rec = {
    id: nextId('vinspect'),
    vehicleId: v.id,
    userId: req.user.id,
    userName: `${req.user.firstName} ${req.user.lastName}`,
    driverId: driver ? driver.id : null,
    driverName: driver ? `${driver.firstName} ${driver.lastName}` : null,
    km: kmNum != null ? kmNum : (Number(v.km) || 0),
    date: inspDate,
    impacts: cleanImpacts,
    checks: cleanChecks,
    note: String(note || '').trim(),
    createdAt: new Date().toISOString(),
  };
  // Archive dans le dossier du véhicule le n°/nom des documents identifiés présents.
  v.documents = v.documents || {};
  for (const c of VEHICLE_CHECKS) {
    if (!c.hasId) continue;
    const ck = cleanChecks[c.code];
    if (ck && ck.ok && ck.id) v.documents[c.code] = { id: ck.id, since: inspDate };
  }
  if (kmNum != null && kmNum > (Number(v.km) || 0)) v.km = kmNum;
  db.vehicleInspections.push(rec);
  await save();
  res.json({ inspection: rec });
});

app.delete('/api/staff/vehicles/inspection/:id', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  db.vehicleInspections = db.vehicleInspections.filter((i) => i.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

// Marquer un dommage comme réparé / non réparé (conserve l'historique). Une fois
// réparé, l'élément est considéré neuf ; un nouveau dégât sera un nouveau relevé.
app.put('/api/staff/vehicles/impact/:impactId/repaired', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  let found = null;
  for (const ins of db.vehicleInspections) {
    const im = (ins.impacts || []).find((x) => x.id === req.params.impactId);
    if (im) { im.repaired = !!(req.body || {}).repaired; im.repairedAt = im.repaired ? new Date().toISOString() : null; found = im; break; }
  }
  if (!found) return res.status(404).json({ error: 'Dommage introuvable' });
  await save();
  res.json({ ok: true });
});

// Régulariser / annuler la régularisation d'un manquement d'un tour (retiré de
// l'accueil mais conservé dans l'historique du tour).
app.put('/api/staff/vehicles/inspection/:id/regularize', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const ins = db.vehicleInspections.find((x) => x.id === req.params.id);
  if (!ins) return res.status(404).json({ error: 'Tour introuvable' });
  const { code, regularized } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code manquant' });
  ins.regularized = ins.regularized || {};
  if (regularized) ins.regularized[code] = true; else delete ins.regularized[code];
  await save();
  res.json({ ok: true });
});

// « J'ai lu » : masque une alerte de conformité de la page d'accueil.
app.post('/api/staff/vehicle-warnings/ack', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const { key, acked } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Clé manquante' });
  db.settings.vehicleWarnAcks = db.settings.vehicleWarnAcks || {};
  if (acked === false) delete db.settings.vehicleWarnAcks[key];
  else db.settings.vehicleWarnAcks[key] = true;
  await save();
  res.json({ ok: true });
});

// Enregistrer un contrôle technique / pollution réalisé.
app.post('/api/admin/vehicles/:id/ct', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { date, type, note } = req.body || {};
  if (!validDate(date)) return res.status(400).json({ error: 'Date du contrôle invalide' });
  v.ctControls = v.ctControls || [];
  v.ctControls.push({ id: nextId('vct'), date, type: type === 'pollution' ? 'pollution' : 'CT', note: String(note || '').trim() });
  await save();
  res.json({ vehicle: v, ct: ctStatus(v) });
});
app.delete('/api/admin/vehicles/:id/ct/:ctId', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  v.ctControls = (v.ctControls || []).filter((c) => c.id !== req.params.ctId);
  await save();
  res.json({ vehicle: v, ct: ctStatus(v) });
});

// --- Conformité côté chauffeur : documents manquants sur son véhicule ---------
app.get('/api/me/vehicle-conformity', authRequired, (req, res) => {
  const db = getData();
  const latest = latestInspections(db);
  const out = [];
  for (const v of db.vehicles) {
    const ins = latest[v.id]; if (!ins || !ins.checks) continue;
    const mine = v.assignedUserId === req.user.id || ins.driverId === req.user.id;
    if (!mine) continue;
    const missing = VEHICLE_CHECKS.filter((c) => c.mandatory && ins.checks[c.code] && ins.checks[c.code].ok === false && !(ins.regularized && ins.regularized[c.code])).map((c) => c.label);
    if (missing.length) out.push({ vehicleName: v.name, plate: v.plate || null, date: ins.date, missing });
  }
  res.json({ items: out });
});

// --- Camions nécessitant un entretien (visible de TOUS) -----------------------
app.get('/api/vehicles/needs-maintenance', authRequired, (req, res) => {
  const db = getData();
  const analysis = fleetAnalysis(db);
  const latest = latestInspections(db);
  const out = [];
  for (const v of analysis.vehicles) {
    const reasons = [];
    v.items.forEach((it) => { if (it.level === 'overdue') reasons.push(`${it.label} (entretien dépassé)`); else if (it.level === 'soon') reasons.push(`${it.label} (entretien proche)`); });
    if (v.ct && v.ct.level === 'overdue') reasons.push('Contrôle technique dépassé');
    else if (v.ct && v.ct.level === 'soon') reasons.push('Contrôle technique à prévoir');
    const ins = latest[v.id];
    if (ins && ins.checks) {
      const miss = VEHICLE_CHECKS.filter((c) => c.mandatory && ins.checks[c.code] && ins.checks[c.code].ok === false && !(ins.regularized && ins.regularized[c.code]));
      if (miss.length) reasons.push('Document/équipement obligatoire manquant');
      const dmg = (ins.impacts || []).some((im) => !im.repaired && /choc|enfoncement|bris/i.test(im.type));
      // (les dommages graves non réparés sont signalés via la conformité)
    }
    if (reasons.length) out.push({ vehicleName: v.name, plate: v.plate, tournee: v.tournee, reasons });
  }
  res.json({ items: out });
});

// ---------------------------------------------------------------------------
// Messagerie interne (annonces de l'encadrement + accusés de lecture)
// ---------------------------------------------------------------------------
app.get('/api/messages', authRequired, (req, res) => {
  const db = getData();
  const isStaff = req.user.role === 'admin' || req.user.role === 'responsable';
  const list = db.messages.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => ({
    id: m.id, authorName: m.authorName, title: m.title, body: m.body, createdAt: m.createdAt,
    readByMe: (m.reads || []).some((r) => r.userId === req.user.id),
    readCount: (m.reads || []).length,
    reads: isStaff ? m.reads : undefined,
    mine: m.authorId === req.user.id,
  }));
  res.json({ messages: list });
});
app.post('/api/messages', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const { title, body } = req.body || {};
  if (!String(body || '').trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide' });
  const msg = {
    id: nextId('msg'), authorId: req.user.id, authorName: `${req.user.firstName} ${req.user.lastName}`,
    title: String(title || '').trim() || 'Information', body: String(body).trim().slice(0, 4000),
    createdAt: new Date().toISOString(), reads: [],
  };
  db.messages.push(msg);
  await save();
  // Push : diffuse l'annonce à tous les salariés (sauf l'auteur).
  const targets = (db.users || []).filter((u) => u.status !== 'deleted' && u.id !== req.user.id).map((u) => u.id);
  push.fire(push.notifyUsers(getData(), save, targets, {
    title: '📣 ' + msg.title,
    body: msg.body.slice(0, 160),
    url: '/', tag: 'msg-' + msg.id,
  }));
  res.json({ message: msg });
});
app.post('/api/messages/:id/read', authRequired, async (req, res) => {
  const db = getData();
  const m = db.messages.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  m.reads = m.reads || [];
  if (!m.reads.some((r) => r.userId === req.user.id)) {
    m.reads.push({ userId: req.user.id, name: `${req.user.firstName} ${req.user.lastName}`, at: new Date().toISOString() });
    await save();
  }
  res.json({ ok: true });
});
// Qui a / n'a pas lu (encadrement).
app.get('/api/messages/:id/reads', authRequired, staffRequired, (req, res) => {
  const db = getData();
  const m = db.messages.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  const readIds = new Set((m.reads || []).map((r) => r.userId));
  const active = db.users.filter((u) => u.status === 'active' && !u.suspended);
  const readers = (m.reads || []).map((r) => ({ name: r.name, at: r.at }));
  const nonReaders = active.filter((u) => !readIds.has(u.id)).map((u) => `${u.firstName} ${u.lastName}`);
  res.json({ readers, nonReaders });
});
app.delete('/api/messages/:id', authRequired, staffRequired, async (req, res) => {
  const db = getData();
  const m = db.messages.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable' });
  if (m.authorId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Seul l’auteur ou un administrateur peut supprimer ce message' });
  db.messages = db.messages.filter((x) => x.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Stocks de pièces / consommables + coût d'exploitation des véhicules (admin)
// ---------------------------------------------------------------------------
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function monthsBetween(fromIso, toDate) {
  const f = new Date(fromIso); if (isNaN(f.getTime())) return 1;
  const months = (toDate.getFullYear() - f.getFullYear()) * 12 + (toDate.getMonth() - f.getMonth()) + 1;
  return Math.max(1, months);
}

app.get('/api/admin/parts', authRequired, adminRequired, (req, res) => {
  const db = getData();
  res.json({
    parts: db.parts.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))),
    categories: db.settings.partCategories || [],
    units: db.settings.partUnits || [],
  });
});

// Kit d'entretien d'un service pour un véhicule (catégories + qté + stock dispo).
app.get('/api/admin/service-kit', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.query.vehicleId);
  const kit = serviceKit(req.query.service, v ? v.model : '');
  const lines = kit.map((k) => ({
    cat: k.cat, qty: k.qty,
    parts: db.parts.filter((p) => p.category === k.cat).map((p) => ({ id: p.id, name: p.name, unitPrice: p.unitPrice, qty: p.qty, unit: p.unit })),
  }));
  res.json({ lines, oil: oilLitres(v ? v.model : '') });
});

// Alertes de stock bas (page d'accueil) : ≤1 rouge, =2 jaune, =3 vert.
app.get('/api/admin/stock-alerts', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const low = db.parts.filter((p) => p.qty <= 3).map((p) => ({
    id: p.id, name: p.name, category: p.category, qty: p.qty, unit: p.unit, fits: p.fits || null,
    level: p.qty <= 1 ? 'red' : p.qty === 2 ? 'yellow' : 'green',
  })).sort((a, b) => a.qty - b.qty);
  res.json({ alerts: low });
});

// Entretiens à programmer (libres) — par véhicule.
app.post('/api/admin/vehicles/:id/schedule', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { label, dueKm, dueDate, note } = req.body || {};
  if (!String(label || '').trim()) return res.status(400).json({ error: 'Intitulé obligatoire' });
  const s = { id: nextId('vsched'), vehicleId: v.id, label: String(label).trim(), dueKm: intStr(dueKm), dueDate: validDate(dueDate) ? dueDate : null, note: String(note || '').trim(), done: false, createdAt: new Date().toISOString() };
  db.vehicleSchedule.push(s); await save(); res.json({ schedule: s });
});
app.put('/api/admin/vehicles/schedule/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const s = db.vehicleSchedule.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Introuvable' });
  if ((req.body || {}).done !== undefined) s.done = !!req.body.done;
  await save(); res.json({ schedule: s });
});
app.delete('/api/admin/vehicles/schedule/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.vehicleSchedule = db.vehicleSchedule.filter((x) => x.id !== req.params.id);
  await save(); res.json({ ok: true });
});

// Paramétrage des catégories et unités de pièces.
app.put('/api/admin/part-categories', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { categories, units } = req.body || {};
  if (Array.isArray(categories)) db.settings.partCategories = categories.map((c) => String(c).trim()).filter(Boolean);
  if (Array.isArray(units)) db.settings.partUnits = units.map((u) => String(u).trim()).filter(Boolean);
  await save();
  res.json({ categories: db.settings.partCategories, units: db.settings.partUnits });
});
app.post('/api/admin/parts', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { name, ref, category, unitPrice, qty, unit, fits } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Nom de la pièce obligatoire' });
  const part = { id: nextId('part'), name: String(name).trim(), ref: String(ref || '').trim() || null, category: String(category || 'piece').trim(), unitPrice: num(unitPrice), qty: num(qty), unit: String(unit || 'u').trim(), fits: String(fits || '').trim() || null };
  db.parts.push(part); await save(); res.json({ part });
});
app.put('/api/admin/parts/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const p = db.parts.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Pièce introuvable' });
  const { name, ref, category, unitPrice, qty, unit, fits } = req.body || {};
  if (name !== undefined) p.name = String(name).trim() || p.name;
  if (ref !== undefined) p.ref = String(ref || '').trim() || null;
  if (category !== undefined) p.category = String(category || 'piece').trim();
  if (unitPrice !== undefined) p.unitPrice = num(unitPrice);
  if (qty !== undefined) p.qty = num(qty);
  if (unit !== undefined) p.unit = String(unit || 'u').trim();
  if (fits !== undefined) p.fits = String(fits || '').trim() || null;
  await save(); res.json({ part: p });
});
app.delete('/api/admin/parts/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.parts = db.parts.filter((p) => p.id !== req.params.id);
  await save(); res.json({ ok: true });
});

// Dépenses d'un véhicule (entretien, carburant, pièces…).
app.post('/api/admin/vehicles/:id/expense', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { date, category, label, amount, partId, qty } = req.body || {};
  let amt = num(amount);
  let usedPart = null;
  if (partId) {
    usedPart = db.parts.find((p) => p.id === partId);
    if (usedPart) {
      const q = num(qty) || 1;
      amt = usedPart.unitPrice * q;
      usedPart.qty = Math.max(0, usedPart.qty - q); // déstockage
    }
  }
  if (amt <= 0) return res.status(400).json({ error: 'Montant (ou pièce + quantité) requis' });
  const exp = { id: nextId('vexp'), vehicleId: v.id, date: validDate(date) ? date : new Date().toISOString().slice(0, 10), category: String(category || 'entretien'), label: String(label || (usedPart ? usedPart.name : 'Dépense')).trim(), amount: Math.round(amt * 100) / 100, partId: usedPart ? usedPart.id : null, qty: num(qty) || (usedPart ? 1 : null), km: intStr((req.body || {}).km) };
  db.vehicleExpenses.push(exp); await save(); res.json({ expense: exp });
});
app.delete('/api/admin/vehicles/expense/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.vehicleExpenses = db.vehicleExpenses.filter((e) => e.id !== req.params.id);
  await save(); res.json({ ok: true });
});

// Synthèse des coûts par véhicule (mensuel + au km), du plus cher au moins cher.
app.get('/api/admin/vehicle-costs', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const now = new Date();
  const rows = db.vehicles.map((v) => {
    const exps = db.vehicleExpenses.filter((e) => e.vehicleId === v.id);
    const total = exps.reduce((s, e) => s + num(e.amount), 0);
    const byCat = {};
    exps.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + num(e.amount); });
    const kmDriven = Math.max(0, effectiveKm(db, v) - (num(v.baseKm)));
    const months = monthsBetween(v.createdAt || now.toISOString(), now);
    return {
      id: v.id, name: v.name, plate: v.plate || null, model: v.model || null,
      total: Math.round(total * 100) / 100,
      monthly: Math.round((total / months) * 100) / 100,
      perKm: kmDriven > 0 ? Math.round((total / kmDriven) * 1000) / 1000 : null,
      kmDriven, months, byCat, expenses: exps.slice().sort((a, b) => b.date.localeCompare(a.date)),
    };
  }).sort((a, b) => b.total - a.total);
  res.json({ vehicles: rows });
});

// ---------------------------------------------------------------------------
// Financière (recettes / charges / TVA / clients) — administrateur
// ---------------------------------------------------------------------------
const FINANCE_CLIENTS = ['GLS', 'FedEx', 'Ciblex'];
const FINANCE_MAIN_ACCOUNTS = ['Recettes', 'Charges fixes', 'Charges variables', 'Charges exceptionnelles'];
function defaultMainAccount(e) {
  if (e.kind === 'recette') return 'Recettes';
  return e.fixed ? 'Charges fixes' : 'Charges variables';
}

// Arborescence de comptes : compte principal -> sous-comptes (postes).
function financeTree(entries) {
  const tree = {};
  for (const e of entries) {
    const main = FINANCE_MAIN_ACCOUNTS.includes(e.mainAccount) ? e.mainAccount : defaultMainAccount(e);
    const sub = e.category || '(non classé)';
    const t = tree[main] = tree[main] || { name: main, total: 0, subs: {} };
    const s = t.subs[sub] = t.subs[sub] || { name: sub, total: 0, count: 0 };
    t.total += num(e.amount); s.total += num(e.amount); s.count += 1;
  }
  return FINANCE_MAIN_ACCOUNTS.filter((m) => tree[m]).map((m) => ({
    name: m, total: Math.round(tree[m].total * 100) / 100,
    subs: Object.values(tree[m].subs).map((s) => ({ name: s.name, total: Math.round(s.total * 100) / 100, count: s.count })).sort((a, b) => b.total - a.total),
  }));
}

// TVA estimée par catégorie bancaire (les montants importés sont TTC -> on
// reconstitue un HT). 0 % pour les postes hors champ TVA (salaires, assurances…).
const FIN_VAT_BY_CAT = { 'Chiffre d\'affaires': 20, 'Prestations': 20, 'Carburant': 20, 'Péages': 20, 'Entretien': 20, 'Pneumatiques': 20, 'Véhicules (leasing)': 20, 'Téléphonie': 20, 'Administratif': 20, 'Divers': 20, 'Salaires': 0, 'Charges sociales': 0, 'Assurances': 0, 'Loyer': 0, 'Frais bancaires': 0 };
const FIN_FIXED_CATS = new Set(['Salaires', 'Charges sociales', 'Assurances', 'Véhicules (leasing)', 'Téléphonie', 'Loyer', 'Frais bancaires', 'Administratif']);
function detectFinClient(label) { const L = String(label || '').toLowerCase(); for (const c of FINANCE_CLIENTS) if (L.includes(c.toLowerCase())) return c; return null; }
// Convertit les transactions bancaires importées en écritures financières
// (crédit = recette, débit = charge) pour alimenter la vision d'ensemble.
function bankTxAsEntries(db) {
  return (db.bankTx || []).map((t) => {
    const ym = (t.opDate || '').slice(0, 7); if (!ym) return null;
    const ttc = Math.abs(num(t.amount));
    const kind = num(t.amount) >= 0 ? 'recette' : 'charge';
    const category = (t.category && String(t.category).trim()) || (kind === 'recette' ? 'Chiffre d\'affaires' : 'Divers');
    const rate = FIN_VAT_BY_CAT[category] != null ? FIN_VAT_BY_CAT[category] : 20;
    const ht = Math.round((ttc / (1 + rate / 100)) * 100) / 100;
    const fixed = kind === 'charge' && FIN_FIXED_CATS.has(category);
    const mainAccount = kind === 'recette' ? 'Recettes' : (fixed ? 'Charges fixes' : 'Charges variables');
    return { ym, kind, amount: ht, vatRate: rate, fixed, category, client: detectFinClient(t.label), mainAccount, _bank: true };
  }).filter(Boolean);
}
function financeSummary(db) {
  // Vision d'ensemble : on fusionne les écritures manuelles AVEC les transactions
  // bancaires importées (reconstituées en HT depuis le TTC, TVA estimée).
  const entries = [...(db.finance.entries || []), ...bankTxAsEntries(db)];
  const byMonth = {}; // ym -> { revenue, chargesFixed, chargesVar, vatCollected, vatDeductible }
  const byClient = {}; // client -> { revenue, charges }
  for (const e of entries) {
    const ym = e.ym; if (!ym) continue;
    const m = byMonth[ym] = byMonth[ym] || { ym, revenue: 0, chargesFixed: 0, chargesVar: 0, vatCollected: 0, vatDeductible: 0 };
    const amt = num(e.amount);
    const vat = amt * (num(e.vatRate) / 100);
    if (e.kind === 'recette') { m.revenue += amt; m.vatCollected += vat; }
    else { if (e.fixed) m.chargesFixed += amt; else m.chargesVar += amt; m.vatDeductible += vat; }
    if (e.client && FINANCE_CLIENTS.includes(e.client)) {
      const c = byClient[e.client] = byClient[e.client] || { client: e.client, revenue: 0, charges: 0 };
      if (e.kind === 'recette') c.revenue += amt; else c.charges += amt;
    }
  }
  const months = Object.values(byMonth).map((m) => ({
    ...m,
    charges: m.chargesFixed + m.chargesVar,
    result: m.revenue - m.chargesFixed - m.chargesVar,
    vatDue: Math.round((m.vatCollected - m.vatDeductible) * 100) / 100,
  })).sort((a, b) => a.ym.localeCompare(b.ym));
  const round = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100; return o; };
  months.forEach(round);
  const totals = months.reduce((t, m) => ({ revenue: t.revenue + m.revenue, charges: t.charges + m.charges, result: t.result + m.result, vatDue: t.vatDue + m.vatDue }), { revenue: 0, charges: 0, result: 0, vatDue: 0 });
  round(totals);
  const clients = Object.values(byClient).map((c) => round({ ...c, margin: c.revenue - c.charges, marginPct: c.revenue > 0 ? Math.round(((c.revenue - c.charges) / c.revenue) * 1000) / 10 : 0 })).sort((a, b) => b.margin - a.margin);
  // Projection : moyenne des résultats mensuels appliquée jusqu'à fin d'année.
  const avgResult = months.length ? totals.result / months.length : 0;
  const now = new Date();
  const monthsLeftYear = 12 - (now.getMonth() + 1);
  const projection = { avgMonthlyResult: Math.round(avgResult * 100) / 100, monthsLeftYear, projectedYearEnd: Math.round((totals.result + avgResult * monthsLeftYear) * 100) / 100 };
  // Arborescence globale + par mois (3 derniers mois affichés côté client).
  const tree = financeTree(entries);
  const treeByMonth = {};
  const ymList = [...new Set(entries.map((e) => e.ym))].sort().reverse();
  for (const ym of ymList) treeByMonth[ym] = financeTree(entries.filter((e) => e.ym === ym));
  return { months, totals, clients, projection, clientsList: FINANCE_CLIENTS, tree, treeByMonth, mainAccounts: FINANCE_MAIN_ACCOUNTS };
}

app.get('/api/admin/finance', authRequired, adminRequired, (req, res) => {
  const db = getData();
  res.json({ entries: db.finance.entries.slice().sort((a, b) => (b.ym || '').localeCompare(a.ym || '')), summary: financeSummary(db), clients: FINANCE_CLIENTS });
});
app.post('/api/admin/finance', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { ym, kind, category, client, amount, fixed, vatRate, note } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return res.status(400).json({ error: 'Mois invalide (AAAA-MM)' });
  if (!['recette', 'charge'].includes(kind)) return res.status(400).json({ error: 'Type invalide' });
  if (num(amount) <= 0) return res.status(400).json({ error: 'Montant invalide' });
  const { mainAccount } = req.body || {};
  const entry = { id: nextId('fin'), ym, kind, mainAccount: FINANCE_MAIN_ACCOUNTS.includes(mainAccount) ? mainAccount : null, category: String(category || (kind === 'recette' ? 'Chiffre d\'affaires' : 'Charge')).trim(), client: FINANCE_CLIENTS.includes(client) ? client : null, amount: Math.round(num(amount) * 100) / 100, fixed: !!fixed, vatRate: num(vatRate), note: String(note || '').trim() };
  db.finance.entries.push(entry); await save(); res.json({ entry, summary: financeSummary(db) });
});
app.put('/api/admin/finance/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const e = db.finance.entries.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Écriture introuvable' });
  const { ym, kind, mainAccount, category, client, amount, fixed, vatRate, note } = req.body || {};
  if (ym !== undefined && /^\d{4}-\d{2}$/.test(String(ym))) e.ym = ym;
  if (kind !== undefined && ['recette', 'charge'].includes(kind)) e.kind = kind;
  if (mainAccount !== undefined) e.mainAccount = FINANCE_MAIN_ACCOUNTS.includes(mainAccount) ? mainAccount : null;
  if (category !== undefined) e.category = String(category).trim() || e.category;
  if (client !== undefined) e.client = FINANCE_CLIENTS.includes(client) ? client : null;
  if (amount !== undefined && num(amount) > 0) e.amount = Math.round(num(amount) * 100) / 100;
  if (fixed !== undefined) e.fixed = !!fixed;
  if (vatRate !== undefined) e.vatRate = num(vatRate);
  if (note !== undefined) e.note = String(note || '').trim();
  await save(); res.json({ entry: e, summary: financeSummary(db) });
});

app.delete('/api/admin/finance/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.finance.entries = db.finance.entries.filter((e) => e.id !== req.params.id);
  await save(); res.json({ ok: true, summary: financeSummary(db) });
});

// Estimation d'appel d'offre : paramètres (administrateur).
app.get('/api/admin/tender', authRequired, adminRequired, (req, res) => {
  res.json({ params: getData().settings.tenderParams });
});
app.put('/api/admin/tender', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const p = db.settings.tenderParams;
  const body = req.body || {};
  for (const k of Object.keys(p)) { if (body[k] !== undefined && body[k] !== '' && !isNaN(Number(body[k]))) p[k] = Number(body[k]); }
  await save();
  res.json({ params: p });
});

// Contrats donneurs d'ordre (administrateur).
const CONTRACT_FIELDS = ['name', 'startDate', 'endDate', 'sector', 'vehicles', 'daysPerMonth',
  'priceDelivery', 'pricePickup', 'dailyFlat', 'vehicleFlat', 'fuelFlat',
  'bonusQuality', 'bonusPerf', 'bonusProd', 'deliveries', 'pickups', 'monthlyCost',
  'penFailedDelivery', 'penLate', 'penAbsence', 'penClaim', 'penQuality',
  'fuelRef', 'fuelCurrent', 'fuelSharePct', 'marginTargetPct',
  // Tarif dégressif (livraison / enlèvement) + rémunérations flocage & tenues.
  'degressiveDelivery', 'deliveryThreshold', 'priceDeliveryDeg',
  'degressivePickup', 'pickupThreshold', 'pricePickupDeg', 'flocage', 'tenues'];
function cleanContract(body, base) {
  const c = Object.assign({}, base || {});
  for (const f of CONTRACT_FIELDS) {
    if (body[f] === undefined) continue;
    if (['name', 'sector', 'startDate', 'endDate'].includes(f)) c[f] = String(body[f] || '').trim();
    else c[f] = Number(body[f]) || 0;
  }
  return c;
}
app.get('/api/admin/contracts', authRequired, adminRequired, (req, res) => {
  res.json({ contracts: getData().contracts.slice() });
});
app.post('/api/admin/contracts', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const body = req.body || {};
  if (!String(body.name || '').trim()) return res.status(400).json({ error: 'Nom du contrat obligatoire' });
  const c = cleanContract(body, { id: nextId('contract'), createdAt: new Date().toISOString() });
  if (!c.daysPerMonth) c.daysPerMonth = 21;
  if (!c.vehicles) c.vehicles = 1;
  db.contracts.push(c); await save(); res.json({ contract: c });
});
app.put('/api/admin/contracts/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const c = db.contracts.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Contrat introuvable' });
  Object.assign(c, cleanContract(req.body || {}, c));
  await save(); res.json({ contract: c });
});
app.delete('/api/admin/contracts/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.contracts = db.contracts.filter((x) => x.id !== req.params.id);
  await save(); res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Gestion Financière : import de relevés, catégorisation, trésorerie (admin)
// ---------------------------------------------------------------------------
const FIN_BANKS = ['Crédit Agricole', 'Crédit Mutuel', 'CIC', 'BNP Paribas', 'Société Générale', 'LCL', 'Banque Populaire', "Caisse d'Épargne", 'Qonto', 'Boursorama', 'Revolut', 'Hello Bank', 'Themis', 'Autre'];
const FIN_CATEGORIES = ['Chiffre d\'affaires', 'Prestations', 'Salaires', 'Charges sociales', 'Carburant', 'Péages', 'Assurances', 'Entretien', 'Pneumatiques', 'Véhicules (leasing)', 'Téléphonie', 'Loyer', 'Frais bancaires', 'Administratif', 'Divers'];
const FIN_REVENUE_CATS = ['Chiffre d\'affaires', 'Prestations'];

function normLabel(s) { return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[0-9]/g, '').replace(/[^A-Z &]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40); }
function parseAmount(s) {
  if (s == null || s === '') return NaN;
  let x = String(s).replace(/\s| |€|EUR/gi, '');
  const neg = /^\(.*\)$/.test(x) || x.trim().startsWith('-') || x.includes('-');
  x = x.replace(/[()]/g, '').replace(/-/g, '');
  if (x.includes(',') && x.includes('.')) x = x.replace(/\./g, '').replace(',', '.');
  else if (x.includes(',')) x = x.replace(',', '.');
  const n = parseFloat(x);
  return isNaN(n) ? NaN : (neg ? -n : n);
}
function parseDateFin(s) {
  if (!s) return null;
  let m = String(s).match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) { let [_, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function guessDelim(lines) {
  for (const d of [';', '\t', ',']) { if (lines.slice(0, 5).every((l) => (l.split(d).length >= 3))) return d; }
  return null;
}
function detectBank(text) {
  const T = text.toUpperCase();
  for (const b of FIN_BANKS) { if (T.includes(b.toUpperCase().replace("'", '')) || T.includes(b.toUpperCase())) return b; }
  if (T.includes('THEMIS')) return 'Themis';
  return null;
}
function categorizeFin(db, label, amount) {
  const L = String(label || '').toUpperCase();
  const learn = db.settings.catLearn || {};
  const n = normLabel(label);
  if (n && learn[n]) return learn[n];
  const sign = (amount == null || !Number.isFinite(amount)) ? null : (amount < 0 ? 'debit' : 'credit');
  for (const r of (db.settings.catRules || [])) {
    if (!r.kw || !L.includes(String(r.kw).toUpperCase())) continue;
    if (r.sens && sign && r.sens !== sign) continue; // règle limitée au débit ou au crédit
    return r.cat;
  }
  return null;
}
function txHash(t) { return `${t.opDate}|${Math.round(t.amount * 100)}|${normLabel(t.label)}`; }

// Analyse d'un texte de relevé (CSV ou copié-collé) -> écritures.
function parseBankText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = guessDelim(lines);
  // Robustesse accents/encodage (Windows-1252) + cellules entre guillemets.
  const stripAcc = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const unq = (s) => String(s == null ? '' : s).trim().replace(/^"([\s\S]*)"$/, '$1').trim();
  let header = null, idx = {};
  if (delim) {
    const c0 = lines[0].split(delim).map((c) => stripAcc(unq(c)));
    if (c0.some((c) => c.includes('date')) && c0.some((c) => /libell|montant|debit|credit/.test(c))) {
      header = c0;
      idx.date = c0.findIndex((c) => c.includes('date'));
      // Le libellé ne doit pas être la colonne de date (« Date d'opération »).
      idx.label = c0.findIndex((c, j) => j !== idx.date && /libell|motif|nature|detail|intitul|operation/.test(c));
      idx.debit = c0.findIndex((c) => /debit/.test(c));
      idx.credit = c0.findIndex((c) => /credit/.test(c));
      idx.amount = c0.findIndex((c) => /montant/.test(c));
    }
  }
  const out = [];
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]; let date, label, amount;
    if (delim) {
      const cells = line.split(delim).map((c) => unq(c));
      date = parseDateFin(cells[idx.date >= 0 ? idx.date : 0]);
      label = idx.label >= 0 ? cells[idx.label] : cells.filter((c, j) => j !== idx.date && isNaN(parseAmount(c))).join(' ');
      if (idx.amount >= 0 && cells[idx.amount]) amount = parseAmount(cells[idx.amount]);
      else { const d = idx.debit >= 0 ? (parseAmount(cells[idx.debit]) || 0) : 0; const cr = idx.credit >= 0 ? (parseAmount(cells[idx.credit]) || 0) : 0; amount = Math.abs(cr) - Math.abs(d); }
    } else {
      const dm = line.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/);
      if (!dm) continue;
      date = parseDateFin(dm[1]);
      const nums = line.match(/-?\d[\d  .]*,\d{2}/g) || line.match(/-?\d+\.\d{2}/g);
      if (!nums) continue;
      amount = parseAmount(nums[nums.length - 1]);
      label = line.replace(dm[1], '').replace(nums[nums.length - 1], '').trim();
    }
    if (!date || !Number.isFinite(amount) || amount === 0) continue;
    out.push({ opDate: date, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 140), amount: Math.round(amount * 100) / 100 });
  }
  return out;
}

app.get('/api/admin/finance-meta', authRequired, adminRequired, (req, res) => {
  const db = getData();
  // Catégories = liste standard + catégories personnalisées (règles) + apprises.
  const custom = (db.settings.catRules || []).map((r) => r.cat).filter(Boolean);
  const learned = Object.values(db.settings.catLearn || {});
  const categories = Array.from(new Set([...FIN_CATEGORIES, ...custom, ...learned].map((c) => String(c).trim()).filter(Boolean)));
  res.json({ banks: FIN_BANKS, categories, rules: db.settings.catRules || [], startBalance: db.settings.treasuryStartBalance || 0 });
});
app.put('/api/admin/cat-rules', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { rules } = req.body || {};
  // Une règle peut créer une catégorie personnalisée et la limiter au débit/crédit.
  if (Array.isArray(rules)) db.settings.catRules = rules.filter((r) => r && r.kw && r.cat).map((r) => ({ kw: String(r.kw).trim(), cat: String(r.cat).trim(), sens: ['debit', 'credit'].includes(r.sens) ? r.sens : '' }));
  await save();
  res.json({ rules: db.settings.catRules });
});
app.put('/api/admin/treasury-start', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.settings.treasuryStartBalance = num((req.body || {}).balance);
  await save();
  res.json({ startBalance: db.settings.treasuryStartBalance });
});

// Aperçu d'import (non persistant) : parse + catégorise + détecte les doublons.
app.post('/api/admin/bank-import', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const { text } = req.body || {};
  let bank = (req.body || {}).bank;
  if (!bank || bank === 'auto') bank = detectBank(text) || 'Autre';
  const parsed = parseBankText(text);
  const existing = new Set(db.bankTx.map(txHash));
  const seen = new Set();
  const transactions = parsed.map((t) => {
    const h = txHash(t);
    const dupe = existing.has(h) || seen.has(h);
    seen.add(h);
    const category = categorizeFin(db, t.label, t.amount);
    return { opDate: t.opDate, label: t.label, amount: t.amount, debit: t.amount < 0 ? -t.amount : 0, credit: t.amount > 0 ? t.amount : 0, category: category || '', bank, dupe };
  });
  res.json({
    transactions, bank,
    detected: transactions.length,
    classified: transactions.filter((t) => t.category).length,
    toVerify: transactions.filter((t) => !t.category && !t.dupe).length,
    duplicates: transactions.filter((t) => t.dupe).length,
  });
});

// Confirmation d'import : persiste les écritures (hors doublons) + archive le doc.
app.post('/api/admin/bank-confirm', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { transactions, bank, docName, month } = req.body || {};
  if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Aucune écriture' });
  const docMonth = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : '';
  const existing = new Set(db.bankTx.map(txHash));
  const docId = nextId('bdoc');
  let added = 0;
  for (const t of transactions) {
    // Doublon NON conservé : on ignore. Conservé (force) : on l'ajoute malgré tout.
    if (t.dupe && !t.force) continue;
    const amount = Math.round(num(t.amount) * 100) / 100;
    const rec = { id: nextId('btx'), opDate: t.opDate, valDate: t.valDate || t.opDate, label: String(t.label || '').slice(0, 140), amount, debit: amount < 0 ? -amount : 0, credit: amount > 0 ? amount : 0, category: String(t.category || '').trim() || 'Divers', subCategory: String(t.subCategory || '').slice(0, 80), bank: bank || t.bank || 'Autre', account: '', source: String(docName || 'import'), docId, createdAt: new Date().toISOString() };
    if (!t.force && existing.has(txHash(rec))) continue;
    existing.add(txHash(rec));
    db.bankTx.push(rec); added++;
  }
  db.bankDocs.push({ id: docId, name: String(docName || 'Relevé').slice(0, 120), bank: bank || 'Autre', month: docMonth, importedAt: new Date().toISOString(), lines: added });
  await save();
  res.json({ added });
});

app.get('/api/admin/bank-tx', authRequired, adminRequired, (req, res) => {
  res.json({ transactions: getData().bankTx.slice().sort((a, b) => (b.opDate || '').localeCompare(a.opDate || '')), docs: getData().bankDocs.slice().sort((a, b) => b.importedAt.localeCompare(a.importedAt)) });
});
app.put('/api/admin/bank-tx/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const t = db.bankTx.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Écriture introuvable' });
  const { category, subCategory } = req.body || {};
  if (category !== undefined) {
    t.category = String(category).trim() || 'Divers';
    // Apprentissage : mémorise le libellé normalisé -> catégorie.
    const n = normLabel(t.label);
    if (n) { db.settings.catLearn = db.settings.catLearn || {}; db.settings.catLearn[n] = t.category; }
  }
  if (subCategory !== undefined) t.subCategory = String(subCategory).trim();
  await save();
  res.json({ tx: t });
});
app.delete('/api/admin/bank-tx/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.bankTx = db.bankTx.filter((x) => x.id !== req.params.id);
  await save();
  res.json({ ok: true });
});
// Supprimer un relevé importé (et toutes ses écritures).
app.delete('/api/admin/bank-docs/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const doc = db.bankDocs.find((d) => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Relevé introuvable' });
  const before = db.bankTx.length;
  db.bankTx = db.bankTx.filter((t) => (t.docId ? t.docId !== doc.id : t.source !== doc.name));
  db.bankDocs = db.bankDocs.filter((d) => d.id !== doc.id);
  await save();
  res.json({ ok: true, removedTx: before - db.bankTx.length });
});

// Comptabilité de gestion + trésorerie + indicateurs + alertes.
app.get('/api/admin/finance-overview', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const txs = db.bankTx;
  const byMonth = {}; // ym -> { revenue, expense, cats:{cat:amount} }
  for (const t of txs) {
    const ym = (t.opDate || '').slice(0, 7); if (!ym) continue;
    const m = byMonth[ym] = byMonth[ym] || { ym, revenue: 0, expense: 0, cats: {} };
    if (t.amount >= 0) m.revenue += t.amount; else m.expense += -t.amount;
    m.cats[t.category] = (m.cats[t.category] || 0) + t.amount;
  }
  const months = Object.values(byMonth).sort((a, b) => a.ym.localeCompare(b.ym)).map((m) => ({ ...m, result: Math.round((m.revenue - m.expense) * 100) / 100, revenue: Math.round(m.revenue * 100) / 100, expense: Math.round(m.expense * 100) / 100 }));
  // Trésorerie : solde de départ + cumul.
  let bal = db.settings.treasuryStartBalance || 0;
  const treasury = months.map((m) => { const start = bal; bal = Math.round((bal + m.revenue - m.expense) * 100) / 100; return { ym: m.ym, start: Math.round(start * 100) / 100, revenue: m.revenue, expense: m.expense, result: m.result, end: bal }; });
  const totalRev = months.reduce((s, m) => s + m.revenue, 0);
  const totalExp = months.reduce((s, m) => s + m.expense, 0);
  const result = totalRev - totalExp;
  // Indicateurs (sur l'ensemble).
  const catTotal = {}; for (const t of txs) if (t.amount < 0) catTotal[t.category] = (catTotal[t.category] || 0) + (-t.amount);
  const pct = (v) => totalRev > 0 ? Math.round((v / totalRev) * 1000) / 10 : 0;
  const indicators = {
    tauxCharges: totalRev > 0 ? Math.round((totalExp / totalRev) * 1000) / 10 : 0,
    tauxMarge: totalRev > 0 ? Math.round((result / totalRev) * 1000) / 10 : 0,
    masseSalarialePct: pct((catTotal['Salaires'] || 0) + (catTotal['Charges sociales'] || 0)),
    carburantPct: pct(catTotal['Carburant'] || 0),
    peagesPct: pct(catTotal['Péages'] || 0),
    resultat: Math.round(result * 100) / 100,
    soldeActuel: bal,
  };
  // Répartition des dépenses / recettes par catégorie.
  const expenseByCat = Object.entries(catTotal).map(([cat, v]) => ({ cat, v: Math.round(v * 100) / 100 })).sort((a, b) => b.v - a.v);
  const revByCat = {}; for (const t of txs) if (t.amount > 0) revByCat[t.category] = (revByCat[t.category] || 0) + t.amount;
  const revenueByCat = Object.entries(revByCat).map(([cat, v]) => ({ cat, v: Math.round(v * 100) / 100 })).sort((a, b) => b.v - a.v);
  // Analyse automatique + alertes.
  const last = months[months.length - 1];
  const alerts = [];
  if (last && last.result < 0) alerts.push({ lvl: 'red', txt: `Résultat de ${last.ym} négatif (${Math.round(last.result)} €).` });
  if (result < 0) alerts.push({ lvl: 'red', txt: 'Résultat cumulé négatif sur la période.' });
  else alerts.push({ lvl: 'green', txt: 'Les recettes couvrent les dépenses.' });
  if (indicators.carburantPct >= 15) alerts.push({ lvl: 'orange', txt: `Le carburant représente ${indicators.carburantPct} % du CA — surveiller la rentabilité.` });
  if (indicators.masseSalarialePct >= 50) alerts.push({ lvl: 'orange', txt: `Masse salariale élevée (${indicators.masseSalarialePct} % du CA).` });
  if (bal < 0) alerts.push({ lvl: 'red', txt: 'Trésorerie négative : tension à anticiper.' });
  else if (treasury.length && treasury[treasury.length - 1].end < totalExp / Math.max(1, months.length)) alerts.push({ lvl: 'orange', txt: 'Trésorerie inférieure à un mois de charges : vigilance.' });
  res.json({ months, treasury, totals: { revenue: Math.round(totalRev * 100) / 100, expense: Math.round(totalExp * 100) / 100, result: Math.round(result * 100) / 100 }, indicators, expenseByCat, revenueByCat, alerts, txCount: txs.length });
});

// ---------------------------------------------------------------------------
// Gestion des heures : amplitudes des chauffeurs (encadrement)
// ---------------------------------------------------------------------------
const AMPLITUDE_MAX = 12; // amplitude indicative (h) — alerte au-delà
function hmToMin(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? (Number(m[1]) * 60 + Number(m[2])) : null; }
function computeHours(start, end, breakMin) {
  const a = hmToMin(start), b = hmToMin(end);
  if (a == null || b == null) return null;
  let amp = b - a; if (amp < 0) amp += 24 * 60; // service de nuit
  const worked = Math.max(0, amp - (Number(breakMin) || 0));
  return { amplitude: Math.round((amp / 60) * 100) / 100, worked: Math.round((worked / 60) * 100) / 100 };
}

app.get('/api/staff/work-hours', authRequired, staffRequired, (req, res) => {
  const db = getData();
  // Par défaut on renvoie TOUT l'historique (les HSUP et le résumé doivent voir
  // tous les mois importés) ; `from` permet de restreindre si besoin.
  const since = req.query.from || '';
  const list = db.workHours.filter((h) => !since || h.date >= since).sort((a, b) => b.date.localeCompare(a.date));
  const drivers = db.users.filter((u) => u.status === 'active' && !u.suspended)
    .map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, role: u.role, groupId: u.groupId, balances: u.balances, hireDate: u.hireDate || null }))
    .sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  res.json({ entries: list, drivers, amplitudeMax: AMPLITUDE_MAX, settlements: db.hsupSettlements.slice(), hsupBase: db.settings.hsupWeeklyBase || 35, hsupCutoff: db.settings.hsupCutoffDay || 0, salaryParams: db.settings.salaryParams || {}, payImports: (db.payImports || []).slice(), driverLearn: db.settings.driverImportLearning || {} });
});

// Paramètres de paie par salarié (taux horaire, base mensualisée, cotisations,
// paniers, heure de nuit…) pour l'estimation du salaire net.
app.put('/api/staff/salary-params', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, params } = req.body || {};
  if (!db.users.some((u) => u.id === userId)) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!params || typeof params !== 'object') return res.status(400).json({ error: 'Paramètres invalides' });
  const num = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
  const keys = ['tauxHoraire', 'baseMois', 'cotisPct', 'exoHsPct', 'panierMidi', 'panierSoir', 'casseCroute', 'nuitParH', 'decoucher', 'pasPct'];
  const clean = {};
  keys.forEach((k) => { if (params[k] != null && params[k] !== '') clean[k] = Math.max(0, num(params[k])); });
  if (!db.settings.salaryParams || typeof db.settings.salaryParams !== 'object') db.settings.salaryParams = {};
  db.settings.salaryParams[userId] = clean;
  await save();
  res.json({ params: clean });
});

// Base hebdomadaire des heures supplémentaires (35 h légal par défaut).
app.put('/api/staff/hsup-base', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const b = Number((req.body || {}).base);
  if (Number.isFinite(b) && b > 0) db.settings.hsupWeeklyBase = b;
  await save();
  res.json({ hsupBase: db.settings.hsupWeeklyBase });
});

// Jour de clôture de la paie (paie « du J au J » décalée d'un mois sur l'autre).
// 0 = paie au mois civil (comportement d'origine) ; 22 = période 23→22.
app.put('/api/staff/hsup-cutoff', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const d = Number((req.body || {}).cutoff);
  if (Number.isFinite(d) && d >= 0 && d <= 28) db.settings.hsupCutoffDay = Math.round(d);
  await save();
  res.json({ hsupCutoff: db.settings.hsupCutoffDay || 0 });
});

// Indiquer les HSUP déjà payées (en heures brutes) pour un salarié / un mois.
app.put('/api/staff/hsup-settlement', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, month, paidHours, realizedAdj, computedRealized } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ error: 'Mois invalide' });
  let s = db.hsupSettlements.find((x) => x.userId === userId && x.month === month);
  if (!s) { s = { userId, month, paidHours: 0, transmittedEquiv: 0 }; db.hsupSettlements.push(s); }
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  if (paidHours != null) s.paidHours = Math.max(0, r2(paidHours));
  // Correction manuelle du réalisé : l'écart est transmis directement au
  // compteur HSUP du salarié (incrémente ou décrémente son stock).
  if (realizedAdj != null) {
    const newAdj = r2(realizedAdj);
    const delta = newAdj - (s.realizedAdj || 0);
    if (delta) u.balances.heuresSupp = r2((u.balances.heuresSupp || 0) + delta);
    s.realizedAdj = newAdj;
  }
  // Trop-payé : si le payé dépasse le réalisé (importé), l'excédent est retiré
  // du stock d'HSUP du salarié (delta-tracé pour rester idempotent).
  if (computedRealized != null) {
    const overpay = Math.max(0, r2(s.paidHours - r2(computedRealized)));
    const overDelta = overpay - (s.overpayApplied || 0);
    if (overDelta) u.balances.heuresSupp = r2((u.balances.heuresSupp || 0) - overDelta);
    s.overpayApplied = overpay;
  }
  await save();
  res.json({ settlement: s, newBalance: u.balances.heuresSupp });
});

// Transmettre au compteur du salarié les HEURES SUPPLÉMENTAIRES RÉALISÉES qui
// lui sont dues (heures brutes — PAS l'équivalent majoré en récupération, qui
// reste purement informatif pour la direction).
app.post('/api/staff/hsup/transmit', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, month, equivHours } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ error: 'Mois invalide' });
  const eq = Math.round((Number(equivHours) || 0) * 100) / 100; // heures sup. brutes dues
  if (eq <= 0) return res.status(400).json({ error: 'Aucune heure supplémentaire à transmettre' });
  let s = db.hsupSettlements.find((x) => x.userId === userId && x.month === month);
  if (!s) { s = { userId, month, paidHours: 0, transmittedEquiv: 0 }; db.hsupSettlements.push(s); }
  // Crédite le compteur « Récupération / heures sup. » du salarié (heures brutes).
  u.balances.heuresSupp = Math.round(((u.balances.heuresSupp || 0) + eq) * 100) / 100;
  // transmittedEquiv = cumul des heures BRUTES déjà transmises (anti double-envoi).
  s.transmittedEquiv = Math.round(((s.transmittedEquiv || 0) + eq) * 100) / 100;
  s.transmittedAt = new Date().toISOString(); // pour repérer une réouverture du mois
  await save();
  res.json({ settlement: s, newBalance: u.balances.heuresSupp });
});

// Corriger les heures déjà transmises pour un mois (valeur absolue) : ajuste le
// compteur Récupération du salarié du delta (ajout ou retrait).
app.put('/api/staff/hsup/transmitted', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, month, transmittedHours } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ error: 'Mois invalide' });
  const nv = Math.max(0, Math.round((Number(transmittedHours) || 0) * 100) / 100);
  let s = db.hsupSettlements.find((x) => x.userId === userId && x.month === month);
  if (!s) { s = { userId, month, paidHours: 0, transmittedEquiv: 0 }; db.hsupSettlements.push(s); }
  const old = Math.round((s.transmittedEquiv || 0) * 100) / 100;
  const delta = Math.round((nv - old) * 100) / 100;
  u.balances.heuresSupp = Math.max(0, Math.round(((u.balances.heuresSupp || 0) + delta) * 100) / 100);
  s.transmittedEquiv = nv;
  s.transmittedAt = new Date().toISOString();
  await save();
  res.json({ settlement: s, newBalance: u.balances.heuresSupp });
});

app.post('/api/staff/work-hours', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, date, start, end, breakMin } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Chauffeur introuvable' });
  if (!validDate(date)) return res.status(400).json({ error: 'Date invalide' });
  const calc = computeHours(start, end, breakMin);
  if (!calc) return res.status(400).json({ error: 'Heures invalides (format HH:MM attendu)' });
  // Une seule saisie par chauffeur et par jour : on remplace si elle existe.
  db.workHours = db.workHours.filter((h) => !(h.userId === userId && h.date === date));
  const rec = { id: nextId('wh'), userId, userName: `${u.firstName} ${u.lastName}`, date, start, end, breakMin: Number(breakMin) || 0, amplitude: calc.amplitude, worked: calc.worked };
  db.workHours.push(rec);
  await save();
  res.json({ entry: rec });
});

app.delete('/api/staff/work-hours/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.workHours = db.workHours.filter((h) => h.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

// Import en masse depuis un rapport d'activité (fichier analysé côté client).
app.post('/api/staff/work-hours/import', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, rows, name } = req.body || {};
  const u = db.users.find((x) => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Salarié introuvable' });
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Données invalides' });
  // Auto-apprentissage : mémorise l'association nom-du-fichier -> salarié pour
  // reconnaître automatiquement ce chauffeur lors des prochains imports.
  if (name) {
    if (!db.settings.driverImportLearning || typeof db.settings.driverImportLearning !== 'object') db.settings.driverImportLearning = {};
    const key = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    if (key) db.settings.driverImportLearning[key] = userId;
  }
  let added = 0, planned = 0, kmUpdated = 0, kmFlagged = 0;
  const touchedMonths = new Set();
  const DAILY_KM_MAX = 1200; // au-delà : anomalie probable (erreur de saisie)
  const normVeh = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const recomputeOdo = (v) => {
    const sum = db.vehicleKmLog.filter((l) => l.vehicleId === v.id).reduce((s, l) => s + (l.km || 0), 0);
    const odo = Math.round((Number(v.baseKm) || 0) + sum);
    if (odo > (Number(v.km) || 0)) v.km = odo; // l'odomètre ne recule jamais
  };
  for (const r of rows) {
    if (!validDate(r.date)) continue;
    touchedMonths.add(String(r.date).slice(0, 7));
    // Kilométrage relevé dans le rapport : rattaché au véhicule identifié, avec
    // détection d'anomalie (validation admin avant prise en compte).
    const km = Math.round(Number(r.km) || 0);
    const ident = normVeh(r.vehName || r.vehPlate);
    if (km !== 0 && ident) {
      const v = db.vehicles.find((x) => { const np = normVeh(x.plate), nn = normVeh(x.name); return (np && (np === ident || ident.includes(np) || np.includes(ident))) || (nn && (nn === ident || ident.includes(nn) || nn.includes(ident))); });
      if (v) {
        const anomaly = km < 0 || km > DAILY_KM_MAX;
        if (anomaly) {
          db.kmAnomalies = db.kmAnomalies.filter((a) => !(a.vehicleId === v.id && a.date === r.date && a.userId === userId));
          db.kmAnomalies.push({ id: nextId('kmano'), vehicleId: v.id, vehicleName: v.name, plate: v.plate || '', date: r.date, km, userId, userName: `${u.firstName} ${u.lastName}`, reason: km < 0 ? 'Kilométrage négatif' : `Distance journalière anormale (> ${DAILY_KM_MAX} km)`, createdAt: new Date().toISOString() });
          kmFlagged++;
        } else {
          db.vehicleKmLog = db.vehicleKmLog.filter((l) => !(l.vehicleId === v.id && l.date === r.date && l.userId === userId));
          db.vehicleKmLog.push({ id: nextId('kmlog'), vehicleId: v.id, date: r.date, km, userId, userName: `${u.firstName} ${u.lastName}`, source: 'import' });
          recomputeOdo(v);
          kmUpdated++;
        }
      }
    }
    // Une seule entrée par salarié et par jour : on remplace.
    db.workHours = db.workHours.filter((h) => !(h.userId === userId && h.date === r.date));
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    // Absence saisie : on l'ajoute aussi au PLANNING (rétroactif) pour voir qui
    // était présent/absent à cette date — sans décompte de solde, et seulement
    // si aucun évènement ne couvre déjà ce jour.
    if (r2(r.absence) > 0) {
      const ds = r.date;
      const exists = db.requests.some((x) => x.userId === userId && x.category !== 'RET' && x.status !== 'rejected' && x.startDate <= ds && x.endDate >= ds);
      if (!exists) {
        const code = (r.absCat && categoryByCode(r.absCat) && r.absCat !== 'DCP') ? r.absCat : 'CP';
        const cat = categoryByCode(code);
        const wd = holidays.countWorkingDays(ds, ds);
        db.requests.push({
          id: nextId('request'), userId, category: code, pool: code === 'CP' ? 'N' : null,
          startDate: ds, endDate: ds, reason: (cat ? cat.label : 'Absence') + ' (import)',
          retardMinutes: null, days: wd, hours: r2(wd * HOURS_PER_DAY),
          status: 'approved', createdAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
          decidedBy: req.user.id, createdBy: req.user.id, replacedById: null, replacedByName: null,
          adminNote: 'Absence importée depuis le rapport d’activité (rétroactif, sans décompte de solde)',
          source: 'import', noDeduct: true,
        });
        planned++;
      }
    }
    db.workHours.push({
      id: nextId('wh'), userId, userName: `${u.firstName} ${u.lastName}`, date: r.date,
      start: String(r.start || ''), end: String(r.end || ''), breakMin: Number(r.breakMin) || 0,
      amplitude: r2(r.amplitude), worked: r2(r.worked), absence: r2(r.absence),
      // Indemnités & événements repris du rapport d'activité.
      nightHours: r2(r.nightHours), km: Math.round(Number(r.km) || 0),
      mealMidi: r2(r.mealMidi), mealSoir: r2(r.mealSoir), casseCroute: r2(r.casseCroute), decoucher: r2(r.decoucher),
      missions: String(r.missions || '').slice(0, 120), motif: String(r.motif || '').slice(0, 120), observations: String(r.observations || '').slice(0, 200),
      source: 'import',
    });
    added++;
  }
  // Réouverture : si l'import ajoute des heures sur un mois déjà transmis,
  // ce mois redevient « ouvert » (de nouvelles HSUP peuvent être dues).
  const reopened = db.hsupSettlements
    .filter((s) => s.userId === userId && touchedMonths.has(s.month) && (s.transmittedEquiv || 0) > 0)
    .map((s) => s.month);
  await save();
  res.json({ added, reopened, planned, kmUpdated, kmFlagged });
});

/* ---- Bulletins de salaire : lecture (PDF) + application aux compteurs --- */
// Lit un ou plusieurs bulletins (PDF en base64) et propose, par salarié, les
// valeurs détectées (CP N / N-1, RCC, récup.). Rien n'est appliqué ici.
app.post('/api/staff/payslips/parse', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Aucun fichier fourni.' });
  const usersMin = db.users.filter((u) => u.status !== 'deleted').map((u) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName }));
  const balById = {}, addrById = {}; db.users.forEach((u) => { balById[u.id] = u.balances || {}; addrById[u.id] = u.address || ''; });
  // Catégories proposables comme motif d'absence + dictionnaire d'apprentissage.
  const absCats = db.categories.filter((c) => c.selectable && c.code !== 'DCP' && c.code !== 'RET');
  const learning = (db.settings && db.settings.motifLearning) || {};
  const results = [];
  for (const f of files.slice(0, 40)) {
    const fileName = String((f && f.name) || 'bulletin.pdf');
    try {
      const b64 = String((f && f.data) || '').replace(/^data:[^,]*,/, '');
      if (!b64) throw new Error('Fichier vide.');
      const buf = Buffer.from(b64, 'base64');
      // PDF multi-bulletins (un par salarié, séparés par « ##BULLETIN## ») :
      // lecture par coordonnées de chaque grille de soldes.
      let many = null;
      try { const pages = await payslip.pdfToItems(buf); many = payslip.extractMany(pages, usersMin); } catch (e) { many = null; }
      // Texte plat : absences datées + éléments de paie (heures sup., nuit, repas).
      let elByMat = {};
      try {
        const text = await payslip.pdfToText(buf);
        payslip.splitBulletins(text).forEach((b) => { elByMat[b.matricule] = payslip.parseBulletinElements(b.block, absCats, learning); });
      } catch (e) { elByMat = {}; }
      if (many && many.length) {
        many.slice(0, 80).forEach((r) => {
          const el = elByMat[r.matricule];
          if (el) { r.absences = el.absences; r.pay = { hsup25: el.hsup25, nightHours: el.nightHours, mealCount: el.mealCount, mealAmount: el.mealAmount }; }
          results.push(r);
        });
        continue;
      }
      // Sinon : un seul bulletin (autre format) — extraction ligne par ligne + éléments.
      const text = await payslip.pdfToText(buf);
      const el = payslip.parseBulletinElements(text, absCats, learning);
      results.push(Object.assign(
        { fileName, error: '', matchedUserId: null, matchedUserName: '', confidence: 0, values: {}, found: {}, lines: [] },
        payslip.extractFromText(text, usersMin),
        { absences: el.absences, pay: { hsup25: el.hsup25, nightHours: el.nightHours, mealCount: el.mealCount, mealAmount: el.mealAmount }, period: '' }
      ));
    } catch (e) { results.push({ fileName, error: e.message, matchedUserId: null, matchedUserName: '', confidence: 0, values: {}, found: {}, lines: [], absences: [], pay: {} }); }
  }
  res.json({
    results,
    users: usersMin.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, balances: balById[u.id] || {}, address: addrById[u.id] || '' })),
    categories: absCats.map((c) => ({ code: c.code, label: c.label, color: c.color })),
  });
});

// Applique les compteurs validés (relus par l'admin) aux comptes des salariés.
app.post('/api/staff/payslips/apply', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Rien à appliquer.' });
  const applied = [];
  for (const it of items) {
    const u = db.users.find((x) => x.id === (it && it.userId));
    if (!u) continue;
    u.balances = u.balances || { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 };
    let changed = false;
    for (const k of ['congesN', 'congesN1', 'rcc', 'heuresSupp']) {
      if (it[k] !== undefined && it[k] !== '' && Number.isFinite(Number(it[k]))) { u.balances[k] = Number(it[k]); changed = true; }
    }
    // Adresse postale lue sur le bulletin → fiche individuelle (donnée perso RGPD).
    if (typeof it.address === 'string' && it.address.trim()) { u.address = it.address.trim(); changed = true; }
    if (it.congesN !== undefined && it.congesN !== '' && Number.isFinite(Number(it.congesN))) enableAccrual(u);
    if (changed) applied.push({ userId: u.id, name: `${u.firstName} ${u.lastName}`, balances: u.balances, address: u.address || '' });
  }
  await save();
  res.json({ applied });
});

// Applique les ABSENCES datées (au planning) et les ÉLÉMENTS DE PAIE (heures
// sup. 25 %, majoration nuit, indemnité de repas → Gestion des heures) lus sur
// les bulletins, après relecture et validation des motifs par l'administrateur.
// Enregistre aussi l'apprentissage motif→catégorie pour les prochaines fois.
app.post('/api/staff/payslips/apply-elements', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const normMotif = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  db.payImports = db.payImports || [];
  if (!db.settings.motifLearning || typeof db.settings.motifLearning !== 'object') db.settings.motifLearning = {};
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Rien à importer.' });
  let absAdded = 0, absSkipped = 0, payCount = 0, learned = 0;
  for (const it of items) {
    const u = db.users.find((x) => x.id === (it && it.userId));
    if (!u) continue;
    // --- Absences datées → calendrier (créées validées, sans re-décompte des
    //     soldes car ceux-ci sont importés séparément depuis le même bulletin). ---
    for (const a of (it.absences || [])) {
      const cat = categoryByCode(a.category);
      if (!cat || cat.code === 'DCP') continue;
      if (!validDate(a.startDate)) continue;
      const end = validDate(a.endDate) && a.endDate >= a.startDate ? a.endDate : a.startDate;
      // Anti-doublon : même salarié / motif / période déjà au planning.
      if (db.requests.some((r) => r.userId === u.id && r.category === a.category && r.startDate === a.startDate && r.endDate === end)) { absSkipped++; continue; }
      const days = cat.code === 'RET' ? 0 : holidays.countWorkingDays(a.startDate, end);
      const hours = days * HOURS_PER_DAY;
      db.requests.push({
        id: nextId('request'), userId: u.id, category: a.category, pool: null,
        startDate: a.startDate, endDate: end, reason: cat.label,
        fractionnement: null, retardMinutes: null, days, hours,
        status: 'approved', createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(), decidedBy: req.user.id, createdBy: req.user.id,
        replacedById: null, replacedByName: null,
        adminNote: 'Importé du bulletin de paie' + (it.month ? ' (' + it.month + ')' : ''),
      });
      absAdded++;
      // Apprentissage : mémorise le motif lu -> catégorie confirmée.
      if (a.motif) { const k = normMotif(a.motif); if (k && db.settings.motifLearning[k] !== a.category) { db.settings.motifLearning[k] = a.category; learned++; } }
    }
    // --- Éléments de paie (mois YYYY-MM) → Gestion des heures. ---
    const month = /^\d{4}-\d{2}$/.test(String(it.month || '')) ? it.month : null;
    if (month) {
      const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
      const rec = {
        id: nextId('payimp'), userId: u.id, userName: `${u.firstName} ${u.lastName}`, month,
        hsup25: num(it.hsup25), nightHours: num(it.nightHours), mealCount: num(it.mealCount), mealAmount: num(it.mealAmount),
        source: 'bulletin', createdAt: new Date().toISOString(),
      };
      if (rec.hsup25 != null || rec.nightHours != null || rec.mealCount != null) {
        db.payImports = db.payImports.filter((p) => !(p.userId === u.id && p.month === month));
        db.payImports.push(rec);
        payCount++;
        // Les heures sup. 25 % payées alimentent le rapprochement HSUP du mois.
        if (rec.hsup25 != null) {
          let s = db.hsupSettlements.find((x) => x.userId === u.id && x.month === month);
          if (!s) { s = { userId: u.id, month, paidHours: 0, transmittedEquiv: 0 }; db.hsupSettlements.push(s); }
          s.paidHours = rec.hsup25;
        }
      }
    }
  }
  await save();
  res.json({ absAdded, absSkipped, payCount, learned });
});

// Retirer un élément de paie importé (heures sup. / nuit / repas d'un mois).
app.delete('/api/staff/payimports/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  db.payImports = (db.payImports || []).filter((p) => p.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

// Anomalies de kilométrage en attente de validation (encadrement).
app.get('/api/staff/km-anomalies', authRequired, staffRequired, (req, res) => {
  const db = getData();
  res.json({ anomalies: db.kmAnomalies.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

// Valider (appliquer) ou écarter une anomalie de kilométrage.
app.post('/api/admin/km-anomalies/:id/resolve', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const a = db.kmAnomalies.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Anomalie introuvable' });
  const { apply } = req.body || {};
  if (apply) {
    const v = db.vehicles.find((x) => x.id === a.vehicleId);
    if (v) {
      db.vehicleKmLog = db.vehicleKmLog.filter((l) => !(l.vehicleId === v.id && l.date === a.date && l.userId === a.userId));
      db.vehicleKmLog.push({ id: nextId('kmlog'), vehicleId: v.id, date: a.date, km: a.km, userId: a.userId, userName: a.userName, source: 'import-validé' });
      const sum = db.vehicleKmLog.filter((l) => l.vehicleId === v.id).reduce((s, l) => s + (l.km || 0), 0);
      const odo = Math.round((Number(v.baseKm) || 0) + sum);
      if (odo > (Number(v.km) || 0)) v.km = odo;
    }
  }
  db.kmAnomalies = db.kmAnomalies.filter((x) => x.id !== a.id);
  await save();
  res.json({ ok: true });
});

// Historique des km par véhicule (graphique + tableau de la flotte).
app.get('/api/staff/vehicle-km', authRequired, staffRequired, (req, res) => {
  const db = getData();
  res.json({ log: db.vehicleKmLog.slice(), vehicles: db.vehicles.map((v) => ({ id: v.id, name: v.name, plate: v.plate, km: v.km, baseKm: v.baseKm })) });
});

/* =========================================================================
   GÉOLOCALISATION PAJ GPS
   - Configuration (identifiants chiffrés) : administrateur uniquement.
   - Vue temps réel (positions, vitesses, excès, arrêts) : encadrement.
   ========================================================================= */

// Configuration courante (sans jamais exposer le mot de passe).
app.get('/api/staff/geoloc/config', authRequired, staffRequired, (req, res) => {
  const data = getData(); ensureErp(data);
  const g = data.settings.pajgps;
  res.json({
    config: {
      enabled: !!g.enabled,
      email: g.email || '',
      hasPassword: !!g.passwordEnc,
      configured: !!(g.email && g.passwordEnc),
      speedLimit: g.speedLimit || 115,
      dayStart: g.dayStart || '05:00',
      dayEnd: g.dayEnd || '18:00',
      deviceMap: g.deviceMap || {},
      depotLat: g.depotLat, depotLng: g.depotLng, depotRadius: g.depotRadius || 300,
      fuelPrice: g.fuelPrice || 1.75, roadSpeedLookup: g.roadSpeedLookup !== false,
      consoRoad90: g.consoRoad90 || 9.5, consoUrban: g.consoUrban || 12.5,
      vehicleCostPerKm: g.vehicleCostPerKm != null ? g.vehicleCostPerKm : 0.25,
      chargesPatrPct: g.chargesPatrPct != null ? g.chargesPatrPct : 42,
      vehicleMonthlyLease: g.vehicleMonthlyLease != null ? g.vehicleMonthlyLease : 1000,
      vehicleMonthlyInsurance: g.vehicleMonthlyInsurance != null ? g.vehicleMonthlyInsurance : 220,
      vehicleFixedDays: g.vehicleFixedDays != null ? g.vehicleFixedDays : 21.5,
      priseDePoste: g.priseDePoste || '', priseDePosteByUser: g.priseDePosteByUser || {},
      priseDePosteByGroup: g.priseDePosteByGroup || {}, deviceUserMap: g.deviceUserMap || {}, deviceGroupMap: g.deviceGroupMap || {},
    },
    isAdmin: req.user.role === 'admin',
    vehicles: data.vehicles.filter((v) => v.active !== false).map((v) => ({ id: v.id, name: v.name, plate: v.plate || '' })),
    // Chauffeurs affectés aux véhicules (pour définir leur heure de prise de poste).
    drivers: Object.values((data.vehicles || []).reduce((acc, v) => {
      if (v.assignedUserId) acc[v.assignedUserId] = { id: v.assignedUserId, name: v.assignedUserName || '—' };
      return acc;
    }, {})),
    // Tous les chauffeurs inscrits (pour attribuer un traceur à un chauffeur).
    users: (data.users || []).filter((u) => u.status === 'active').map((u) => {
      const grp = (data.groups || []).find((gr) => gr.id === u.groupId);
      return { id: u.id, name: `${u.firstName} ${u.lastName}`, groupId: u.groupId || null, groupName: grp ? grp.name : 'Sans groupe' };
    }),
    // Groupes (pour définir une heure de prise de poste par groupe).
    groups: (data.groups || []).map((gr) => ({ id: gr.id, name: gr.name })),
  });
});

// Enregistre / met à jour la configuration (admin). Le mot de passe est chiffré.
app.post('/api/admin/geoloc/config', authRequired, adminRequired, async (req, res) => {
  const data = getData(); ensureErp(data);
  const g = data.settings.pajgps;
  const b = req.body || {};
  if (typeof b.email === 'string') g.email = b.email.trim();
  if (typeof b.password === 'string' && b.password) g.passwordEnc = pajgps.encrypt(b.password);
  if (b.clearPassword === true) g.passwordEnc = '';
  if (typeof b.enabled === 'boolean') g.enabled = b.enabled;
  if (b.speedLimit != null && Number.isFinite(Number(b.speedLimit))) g.speedLimit = Math.max(1, Math.round(Number(b.speedLimit)));
  if (/^\d{1,2}:\d{2}$/.test(b.dayStart || '')) g.dayStart = b.dayStart;
  if (/^\d{1,2}:\d{2}$/.test(b.dayEnd || '')) g.dayEnd = b.dayEnd;
  if (b.depotLat != null && Number.isFinite(Number(b.depotLat))) g.depotLat = Number(b.depotLat);
  if (b.depotLng != null && Number.isFinite(Number(b.depotLng))) g.depotLng = Number(b.depotLng);
  if (b.depotRadius != null && Number.isFinite(Number(b.depotRadius))) g.depotRadius = Math.max(20, Math.round(Number(b.depotRadius)));
  if (b.fuelPrice != null && Number.isFinite(Number(b.fuelPrice))) g.fuelPrice = Math.max(0, Number(b.fuelPrice));
  if (typeof b.roadSpeedLookup === 'boolean') g.roadSpeedLookup = b.roadSpeedLookup;
  if (b.consoRoad90 != null && Number.isFinite(Number(b.consoRoad90))) g.consoRoad90 = Math.max(1, Number(b.consoRoad90));
  if (b.consoUrban != null && Number.isFinite(Number(b.consoUrban))) g.consoUrban = Math.max(1, Number(b.consoUrban));
  if (b.vehicleCostPerKm != null && Number.isFinite(Number(b.vehicleCostPerKm))) g.vehicleCostPerKm = Math.max(0, Number(b.vehicleCostPerKm));
  if (b.chargesPatrPct != null && Number.isFinite(Number(b.chargesPatrPct))) g.chargesPatrPct = Math.max(0, Number(b.chargesPatrPct));
  if (b.vehicleMonthlyLease != null && Number.isFinite(Number(b.vehicleMonthlyLease))) g.vehicleMonthlyLease = Math.max(0, Number(b.vehicleMonthlyLease));
  if (b.vehicleMonthlyInsurance != null && Number.isFinite(Number(b.vehicleMonthlyInsurance))) g.vehicleMonthlyInsurance = Math.max(0, Number(b.vehicleMonthlyInsurance));
  if (b.vehicleFixedDays != null && Number.isFinite(Number(b.vehicleFixedDays))) g.vehicleFixedDays = Math.max(1, Math.round(Number(b.vehicleFixedDays) * 2) / 2);
  if (typeof b.priseDePoste === 'string') g.priseDePoste = /^\d{1,2}:\d{2}$/.test(b.priseDePoste) ? b.priseDePoste : '';
  if (b.priseDePosteByUser && typeof b.priseDePosteByUser === 'object') {
    const clean = {};
    for (const k of Object.keys(b.priseDePosteByUser)) { const t = b.priseDePosteByUser[k]; if (/^\d{1,2}:\d{2}$/.test(t || '')) clean[String(k)] = t; }
    g.priseDePosteByUser = clean;
  }
  if (b.deviceMap && typeof b.deviceMap === 'object') {
    const clean = {};
    for (const k of Object.keys(b.deviceMap)) { const v = b.deviceMap[k]; if (v) clean[String(k)] = String(v); }
    g.deviceMap = clean;
  }
  if (b.priseDePosteByGroup && typeof b.priseDePosteByGroup === 'object') {
    const clean = {};
    for (const k of Object.keys(b.priseDePosteByGroup)) { const t = b.priseDePosteByGroup[k]; if (/^\d{1,2}:\d{2}$/.test(t || '')) clean[String(k)] = t; }
    g.priseDePosteByGroup = clean;
  }
  if (b.deviceUserMap && typeof b.deviceUserMap === 'object') {
    const clean = {};
    for (const k of Object.keys(b.deviceUserMap)) { const v = b.deviceUserMap[k]; if (v) clean[String(k)] = String(v); }
    g.deviceUserMap = clean;
  }
  // Attribution directe traceur → groupe (prioritaire sur le groupe déduit du chauffeur).
  if (b.deviceGroupMap && typeof b.deviceGroupMap === 'object') {
    const clean = {};
    for (const k of Object.keys(b.deviceGroupMap)) { const v = b.deviceGroupMap[k]; if (v) clean[String(k)] = String(v); }
    g.deviceGroupMap = clean;
  }
  pajgps.resetToken();
  await save();
  res.json({ ok: true, configured: !!(g.email && g.passwordEnc), enabled: !!g.enabled });
});

// Teste la connexion PAJ (identifiants stockés ou fournis) et renvoie les traceurs.
app.post('/api/admin/geoloc/test', authRequired, adminRequired, async (req, res) => {
  const data = getData(); ensureErp(data);
  const g = data.settings.pajgps;
  const b = req.body || {};
  const email = (b.email && b.email.trim()) || g.email;
  const password = (b.password && b.password) || pajgps.decrypt(g.passwordEnc);
  if (!email || !password) return res.status(400).json({ error: 'Identifiants manquants.' });
  try {
    const devices = await pajgps.testConnection(email, password);
    res.json({ ok: true, devices });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Vue temps réel : positions, statut de mouvement, excès de vitesse du jour.
app.get('/api/staff/geoloc/live', authRequired, staffRequired, async (req, res) => {
  const data = getData(); ensureErp(data);
  const g = data.settings.pajgps;
  if (!g.enabled || !g.email || !g.passwordEnc) {
    return res.json({ positions: [], configured: !!(g.email && g.passwordEnc), enabled: !!g.enabled, error: g.enabled ? 'Identifiants PAJ manquants.' : 'Géolocalisation non activée.', config: pubCfg(g) });
  }
  // Endpoint volontairement « incassable » : on renvoie toujours 200 avec ce
  // qu'on peut (positions en cache + message d'erreur éventuel), pour ne jamais
  // laisser le panneau d'accueil bloqué sur « chargement… ».
  let positions = [], errMsg = '', day = '', speedRecap = [];
  try {
    const r = await pajgps.refreshAndTrack(data, { force: req.query.force === '1' });
    positions = r.list || [];
    errMsg = r.error || '';
    if (req.query.address !== '0') {
      try { await pajgps.attachAddresses(data, positions); } catch (e) { /* géocodage best-effort */ }
    }
    if (r.polled) { try { await save(); } catch (e) { /* persistance best-effort */ } }
  } catch (e) {
    errMsg = e.message;
    try { positions = pajgps.liveList(data); } catch (e2) { positions = []; }
    console.error('Géoloc live:', e && e.stack ? e.stack : e);
  }
  try { day = data.pajState.day; } catch (e) {}
  try { speedRecap = pajgps.weeklySpeedRecap(data); } catch (e) { speedRecap = []; console.error('Géoloc recap:', e && e.stack ? e.stack : e); }
  res.json({ positions, day, error: errMsg, enabled: true, configured: true, config: pubCfg(g), speedRecap });
});

function pubCfg(g) { return { speedLimit: g.speedLimit || 115, dayStart: g.dayStart || '05:00', dayEnd: g.dayEnd || '18:00' }; }

/* =========================================================================
   CARBURANT (Exploitation & Transport) — import des transactions AS 24
   ========================================================================= */
function fuelMatchVehicle(db, t) {
  const map = db.settings.fuelCardMap || {};
  if (t.card && map[t.card]) { const v = db.vehicles.find((x) => x.id === map[t.card]); if (v) return v; }
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vn = norm(t.vehicleName);
  if (vn) {
    for (const v of db.vehicles) {
      const cand = [v.name, v.plate, v.tournee].map(norm).filter(Boolean);
      if (cand.some((c) => c && (c.indexOf(vn) !== -1 || vn.indexOf(c) !== -1))) return v;
    }
  }
  return null;
}

// Analyse carburant : KPI conso (tank-to-tank via kilométrage AS 24),
// attribution chauffeur (par fréquence des pleins) et détection de
// surconsommation / vol (plein > capacité réservoir, écart de conso anormal).
function fuelAnalysis(db) {
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const round1 = (n) => Math.round((n || 0) * 10) / 10;
  const kpi = db.settings.fuelKpi || { refConso: 11, threshold: 15, tankCapacity: 100 };
  const refConso = Number(kpi.refConso) || 11;
  const thr = (Number(kpi.threshold) || 15) / 100;
  const tank = Number(kpi.tankCapacity) || 100;
  // Regroupe par véhicule (identité AS 24 = vehicleName, sinon « — »).
  const groups = {};
  for (const t of db.fuel) {
    const key = (t.vehicleName || '').trim() || '—';
    (groups[key] || (groups[key] = [])).push(t);
  }
  const vehById = {}; db.vehicles.forEach((v) => { vehById[v.id] = v; });
  const vehicles = []; const alerts = [];
  for (const key of Object.keys(groups)) {
    const txns = groups[key].slice().sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));
    let liters = 0, ttc = 0, validKm = 0, validLiters = 0;
    const drivers = {};
    let mapped = null;
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      liters += t.liters || 0; ttc += t.amountTTC || 0;
      if (t.driver) { const d = drivers[t.driver] || (drivers[t.driver] = { name: t.driver, count: 0, liters: 0 }); d.count++; d.liters += t.liters || 0; }
      if (t.vehicleId && vehById[t.vehicleId]) mapped = vehById[t.vehicleId];
      // Plein > capacité réservoir : remplissage suspect (jerrican / autre cuve).
      if ((t.liters || 0) > tank) {
        alerts.push({ akey: 'overtank|' + t.txnId, vehicle: key, type: 'overtank', level: 'alert', date: t.date, driver: t.driver || '', text: `Plein de ${round1(t.liters)} L > capacité réservoir (${tank} L) — remplissage suspect (jerrican ?)` });
      }
      // Conso tank-to-tank entre deux pleins (kilométrage AS 24 renseigné).
      if (i > 0) {
        const prev = txns[i - 1];
        const dk = (t.km || 0) - (prev.km || 0);
        if ((prev.km || 0) > 0 && (t.km || 0) > 0 && dk > 1 && dk < 2000 && (t.liters || 0) > 0) {
          validKm += dk; validLiters += t.liters;
          const segConso = t.liters / dk * 100;
          if (segConso > refConso * (1 + Math.max(thr, 0.35))) {
            alerts.push({ akey: 'spike|' + t.txnId, vehicle: key, type: 'spike', level: 'alert', date: t.date, driver: t.driver || '', text: `Conso anormale ${round1(segConso)} L/100 sur ${Math.round(dk)} km (${round1(t.liters)} L) — surconsommation ou vol à contrôler` });
          }
        }
      }
    }
    const realConso = validKm > 0 ? validLiters / validKm * 100 : null;
    const deviationPct = realConso != null ? Math.round((realConso - refConso) / refConso * 100) : null;
    let level = 'ok';
    if (realConso != null) level = (realConso > refConso * (1 + thr)) ? 'alert' : (realConso > refConso * (1 + thr / 2)) ? 'warn' : 'ok';
    const drvList = Object.values(drivers).sort((a, b) => b.count - a.count);
    const dominant = drvList[0] || null;
    const driverShare = dominant && txns.length ? Math.round(dominant.count / txns.length * 100) : 0;
    if (level === 'alert' && realConso != null) {
      alerts.push({ akey: 'avg|' + key, vehicle: key, type: 'avg', level: 'alert', date: '', driver: dominant ? dominant.name : '', text: `Conso moyenne ${round1(realConso)} L/100 (réf. ${refConso}) — écart +${deviationPct}% à contrôler${dominant ? ' (chauffeur principal : ' + dominant.name + ')' : ''}` });
    }
    vehicles.push({
      vehicle: key, vehicleId: mapped ? mapped.id : null, plate: mapped ? (mapped.plate || '') : '',
      fills: txns.length, liters: round2(liters), ttc: round2(ttc),
      km: validKm, realConso: realConso != null ? round1(realConso) : null,
      refConso, deviationPct, level,
      driver: dominant ? { name: dominant.name, share: driverShare } : null,
      drivers: drvList.slice(0, 4).map((d) => ({ name: d.name, count: d.count })),
      assignedDriver: mapped ? (mapped.assignedUserName || '') : '',
    });
  }
  vehicles.sort((a, b) => (a.level === b.level ? b.ttc - a.ttc : a.level === 'alert' ? -1 : b.level === 'alert' ? 1 : a.level === 'warn' ? -1 : 1));
  // Décisions admin (fraude confirmée / faux positif) rattachées par clé stable.
  const dec = db.settings.fuelAlertDecisions || {};
  alerts.forEach((a) => { a.key = a.akey; a.decision = dec[a.akey] ? dec[a.akey].status : null; delete a.akey; });
  const order = { alert: 0, warn: 1, ok: 2 };
  // Non traitées en premier ; les décidées (fraude/faux positif) en bas.
  alerts.sort((a, b) => (((a.decision ? 1 : 0) - (b.decision ? 1 : 0)) || (order[a.level] - order[b.level]) || String(b.date).localeCompare(String(a.date))));
  const pending = alerts.filter((a) => !a.decision).length;
  return { refConso, threshold: kpi.threshold, tankCapacity: tank, vehicles, alerts: alerts.slice(0, 80), alertCount: pending, totalAlerts: alerts.length };
}

// Analyse par CHAUFFEUR sur 30 jours glissants (fenêtre se terminant à la
// dernière transaction connue). Quand la fenêtre est incomplète, projette la
// consommation sur 30 j ; à l'import suivant, compare la projection au réel.
// Km moyens par semaine et par chauffeur, déduits de la géolocalisation (archive
// fuelEstimates). Sert à projeter la consommation attendue sur 30 jours.
function gpsWeeklyKmByDriver(db) {
  const est = db.fuelEstimates || [];
  const out = {};
  if (!est.length) return out;
  const allD = est.map((e) => e.date).filter(Boolean).sort();
  const last = allD[allD.length - 1];
  const from = new Date(new Date(last + 'T00:00:00Z').getTime() - 55 * 86400000).toISOString().slice(0, 10); // 8 semaines
  const by = {};
  est.forEach((e) => { if (!e.date || e.date < from) return; const k = (e.driverName || '').trim(); if (!k) return; const r = by[k] || (by[k] = { km: 0, min: e.date, max: e.date }); r.km += e.km || 0; if (e.date < r.min) r.min = e.date; if (e.date > r.max) r.max = e.date; });
  Object.keys(by).forEach((k) => { const r = by[k]; const span = Math.max(7, (new Date(r.max) - new Date(r.min)) / 86400000 + 1); out[k] = r.km / (span / 7); });
  return out;
}
// Statistiques d'un lot de transactions (litres, coût HT, conso tank-to-tank).
function fuelTxnStats(txns) {
  let liters = 0, costHT = 0, vk = 0, vl = 0;
  for (let i = 0; i < txns.length; i++) {
    const t = txns[i]; liters += t.liters || 0; costHT += t.amountHT || 0;
    if (i > 0) { const p = txns[i - 1]; const dk = (t.km || 0) - (p.km || 0); if ((p.km || 0) > 0 && (t.km || 0) > 0 && dk > 1 && dk < 2000 && (t.liters || 0) > 0) { vk += dk; vl += t.liters; } }
  }
  return { liters, costHT, km: vk, conso: vk > 0 ? vl / vk * 100 : null, fills: txns.length };
}
function prevMonthOf(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); }

function fuelDriverAnalysis(db) {
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const round1 = (n) => Math.round((n || 0) * 10) / 10;
  const kpi = db.settings.fuelKpi || {};
  const cfg = db.settings.pajgps || {};
  const refConso = Number(kpi.refConso) || 11;
  const thrPct = Math.max(Number(kpi.threshold) || 15, 10);
  const driverMap = db.settings.fuelDriverMap || {};
  const usersById = {}; (db.users || []).forEach((u) => { usersById[u.id] = `${u.firstName} ${u.lastName}`; });
  const keyOf = (t) => (t.card && driverMap[t.card] && usersById[driverMap[t.card]]) ? usersById[driverMap[t.card]] : ((t.driver || '').trim() || '—');
  const allDates = db.fuel.map((t) => t.date).filter(Boolean).sort();
  const lastDate = allDates.length ? allDates[allDates.length - 1] : new Date().toISOString().slice(0, 10);
  const cutoff = new Date(new Date(lastDate + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const curMonth = lastDate.slice(0, 7), prevMonth = prevMonthOf(curMonth);
  const gpsKm = gpsWeeklyKmByDriver(db);
  // Tous les pleins regroupés par chauffeur (pour mois en cours / précédent).
  const allByDriver = {};
  for (const t of db.fuel) { if (!t.date) continue; (allByDriver[keyOf(t)] || (allByDriver[keyOf(t)] = [])).push(t); }
  const groups = {};
  for (const t of db.fuel) { if (!t.date || t.date < cutoff) continue; (groups[keyOf(t)] || (groups[keyOf(t)] = [])).push(t); }
  const store = db.settings.fuelProjections || {};
  const drivers = Object.keys(groups).map((k) => {
    const txns = groups[k].slice().sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));
    const s = fuelTxnStats(txns);
    const liters = s.liters, costHT = s.costHT, realConso = s.conso;
    const ds = txns.map((t) => t.date).sort();
    const windowDays = ds.length ? Math.round((new Date(ds[ds.length - 1]) - new Date(ds[0])) / 86400000) + 1 : 1;
    const complete = windowDays >= 28;
    const pricePerL = liters > 0 ? costHT / liters : null;
    // Projection 30 j : prioritairement à partir des km GPS de la semaine ×
    // conso de référence ; sinon mise à l'échelle de la fenêtre.
    const weeklyKm = gpsKm[k] || null;
    let estLiters30, estCostHT30, projBasis;
    if (!complete && weeklyKm && pricePerL) {
      const km30 = weeklyKm * 30 / 7;
      estLiters30 = round1(km30 * refConso / 100);
      estCostHT30 = round2(estLiters30 * pricePerL);
      projBasis = 'gps';
    } else {
      const factor = (complete || windowDays <= 0) ? 1 : 30 / windowDays;
      estLiters30 = round1(liters * factor); estCostHT30 = round2(costHT * factor);
      projBasis = complete ? null : 'window';
    }
    // Comparaison projeté vs réel (mémorisée à l'import).
    const stored = store[k];
    let liveCompare = null;
    if (stored && stored.basisDays < 28 && complete && stored.projCostHT > 0) {
      const dev = Math.round((costHT - stored.projCostHT) / stored.projCostHT * 100);
      liveCompare = { projectedCostHT: round2(stored.projCostHT), realCostHT: round2(costHT), deviationPct: dev, status: Math.abs(dev) > thrPct ? 'alert' : 'ok' };
    }
    const compare = (stored && stored.lastCompare) ? stored.lastCompare : liveCompare;
    // Comparatif mois en cours / mois précédent (litres, coût, conso).
    const allTx = (allByDriver[k] || []).slice().sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));
    const cur = fuelTxnStats(allTx.filter((t) => t.date.slice(0, 7) === curMonth));
    const prev = fuelTxnStats(allTx.filter((t) => t.date.slice(0, 7) === prevMonth));
    const pct = (a, b) => (b > 0 ? Math.round((a - b) / b * 100) : null);
    return {
      key: k, fills: txns.length, liters: round1(liters), costHT: round2(costHT),
      realConso: realConso != null ? round1(realConso) : null,
      deviationPct: realConso != null ? Math.round((realConso - refConso) / refConso * 100) : null,
      windowDays, complete, projected: !complete, projBasis, weeklyKm: weeklyKm != null ? round1(weeklyKm) : null,
      estLiters30, estCostHT30, refConso, compare,
      month: {
        curMonth, prevMonth,
        curLiters: round1(cur.liters), curCostHT: round2(cur.costHT), curConso: cur.conso != null ? round1(cur.conso) : null,
        prevLiters: round1(prev.liters), prevCostHT: round2(prev.costHT), prevConso: prev.conso != null ? round1(prev.conso) : null,
        dCostPct: pct(cur.costHT, prev.costHT), dLitersPct: pct(cur.liters, prev.liters),
        dConsoPct: (cur.conso != null && prev.conso != null && prev.conso > 0) ? Math.round((cur.conso - prev.conso) / prev.conso * 100) : null,
      },
    };
  }).sort((a, b) => b.costHT - a.costHT);
  return { asOf: lastDate, windowFrom: cutoff, curMonth, prevMonth, refConso, drivers };
}
// À l'import : fige la projection de chaque chauffeur (réel si fenêtre complète,
// sinon estimation sur 30 j) et mémorise la dernière comparaison disponible.
function updateFuelProjections(db) {
  const an = fuelDriverAnalysis(db);
  const next = {};
  for (const d of an.drivers) {
    const prev = (db.settings.fuelProjections || {})[d.key];
    next[d.key] = {
      projCostHT: d.complete ? d.costHT : d.estCostHT30,
      projLiters: d.complete ? d.liters : d.estLiters30,
      basisDays: d.windowDays, madeAt: new Date().toISOString(),
      lastCompare: d.compare || (prev && prev.lastCompare) || null,
    };
  }
  db.settings.fuelProjections = next;
}

// Croisement consommation ESTIMÉE (GPS, archivée) vs pleins RÉELS (AS 24) sur
// 30 jours glissants — pour calibrer le modèle de consommation.
function fuelCalibration(db) {
  const round1 = (n) => Math.round((n || 0) * 10) / 10;
  const est = db.fuelEstimates || [], fills = db.fuel || [];
  const allDates = fills.map((t) => t.date).concat(est.map((e) => e.date)).filter(Boolean).sort();
  if (!allDates.length) return { from: '', to: '', vehicles: [] };
  const lastDate = allDates[allDates.length - 1];
  const cutoff = new Date(new Date(lastDate + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const keyFor = (vehicleId, vehicleName) => vehicleId || ('n:' + norm(vehicleName));
  const rows = {};
  est.forEach((e) => {
    if (!e.date || e.date < cutoff) return;
    const k = keyFor(e.vehicleId, e.vehicleName);
    const r = rows[k] || (rows[k] = { vehicleName: e.vehicleName || '', plate: e.plate || '', estLiters: 0, estKm: 0, realLiters: 0 });
    r.estLiters += e.liters || 0; r.estKm += e.km || 0; if (!r.vehicleName && e.vehicleName) r.vehicleName = e.vehicleName; if (!r.plate && e.plate) r.plate = e.plate;
  });
  fills.forEach((t) => {
    if (!t.date || t.date < cutoff) return;
    const k = keyFor(t.vehicleId, t.vehicleName);
    const r = rows[k] || (rows[k] = { vehicleName: t.vehicleName || '', plate: '', estLiters: 0, estKm: 0, realLiters: 0 });
    r.realLiters += t.liters || 0; if (!r.vehicleName && t.vehicleName) r.vehicleName = t.vehicleName;
  });
  const vehicles = Object.values(rows).filter((r) => r.estLiters > 0 && r.realLiters > 0).map((r) => {
    const ratio = r.realLiters / r.estLiters; // pleins réels / conso estimée
    return { vehicleName: r.vehicleName || '—', plate: r.plate, estLiters: round1(r.estLiters), realLiters: round1(r.realLiters), estKm: round1(r.estKm), ratio: Math.round(ratio * 100) / 100, deviationPct: Math.round((ratio - 1) * 100) };
  }).sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));
  return { from: cutoff, to: lastDate, vehicles };
}

// Cartes AS 24 distinctes (pour l'association carte → chauffeur).
function fuelCards(db) {
  const info = {};
  db.fuel.forEach((t) => { if (!t.card) return; const c = info[t.card] || (info[t.card] = { card: t.card, count: 0, driver: t.driver || '', vehicleName: t.vehicleName || '' }); c.count++; if (t.driver && !c.driver) c.driver = t.driver; });
  return Object.values(info).sort((a, b) => b.count - a.count);
}

// Liste des transactions + synthèse (litres, montants, par véhicule).
app.get('/api/staff/fuel', authRequired, staffRequired, (req, res) => {
  const db = getData(); ensureErp(db);
  const list = db.fuel.slice().sort((a, b) => String(b.date + (b.time || '')).localeCompare(String(a.date + (a.time || ''))));
  const sum = { count: list.length, liters: 0, ht: 0, ttc: 0 };
  const byVeh = {};
  for (const t of list) {
    sum.liters += t.liters || 0; sum.ht += t.amountHT || 0; sum.ttc += t.amountTTC || 0;
    const key = t.vehicleName || '—';
    const b = byVeh[key] || (byVeh[key] = { vehicle: key, liters: 0, ttc: 0, count: 0 });
    b.liters += t.liters || 0; b.ttc += t.amountTTC || 0; b.count += 1;
  }
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  // Synthèses distinctes : 30 jours glissants vs année civile en cours.
  const dates = db.fuel.map((t) => t.date).filter(Boolean).sort();
  const lastD = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  const cut30 = new Date(new Date(lastD + 'T00:00:00Z').getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const year = lastD.slice(0, 4);
  const agg = (pred) => { const a = { count: 0, liters: 0, ht: 0, ttc: 0 }; for (const t of db.fuel) { if (!t.date || !pred(t.date)) continue; a.count++; a.liters += t.liters || 0; a.ht += t.amountHT || 0; a.ttc += t.amountTTC || 0; } return { count: a.count, liters: round2(a.liters), ht: round2(a.ht), ttc: round2(a.ttc) }; };
  const summary30 = agg((d) => d >= cut30);
  const summaryYear = agg((d) => d.slice(0, 4) === year);
  res.json({
    transactions: list.slice(0, 500),
    summary: { count: sum.count, liters: round2(sum.liters), ht: round2(sum.ht), ttc: round2(sum.ttc) },
    summary30, summaryYear, year, asOf: lastD,
    byVehicle: Object.values(byVeh).map((b) => ({ ...b, liters: round2(b.liters), ttc: round2(b.ttc) })).sort((a, z) => z.ttc - a.ttc),
    analysis: fuelAnalysis(db),
    driverAnalysis: fuelDriverAnalysis(db),
    calibration: fuelCalibration(db),
    isAdmin: req.user.role === 'admin',
    vehicles: db.vehicles.filter((v) => v.active !== false).map((v) => ({ id: v.id, name: v.name, plate: v.plate || '' })),
    users: (db.users || []).filter((u) => u.status === 'active').map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}` })),
    cards: fuelCards(db),
    fuelDriverMap: db.settings.fuelDriverMap || {},
    fuelCardMap: db.settings.fuelCardMap || {},
    available: fuelimport.available(),
  });
});

// Décision sur une alerte carburant : 'fraud' (fraude confirmée), 'false_positive'
// (faux positif) ou '' pour réinitialiser.
app.post('/api/staff/fuel/alert-decision', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  const { key, status } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Alerte non identifiée.' });
  if (status === 'fraud' || status === 'false_positive') {
    db.settings.fuelAlertDecisions[String(key)] = { status, by: req.user.id, byName: `${req.user.firstName} ${req.user.lastName}`, at: new Date().toISOString() };
  } else {
    delete db.settings.fuelAlertDecisions[String(key)];
  }
  await save();
  res.json({ ok: true });
});

// Associe une carte AS 24 à un chauffeur inscrit (croisement conso par chauffeur).
app.post('/api/staff/fuel/driver-map', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  const { card, userId } = req.body || {};
  if (!card) return res.status(400).json({ error: 'Carte requise.' });
  if (userId) db.settings.fuelDriverMap[String(card)] = String(userId);
  else delete db.settings.fuelDriverMap[String(card)];
  await save();
  res.json({ fuelDriverMap: db.settings.fuelDriverMap });
});

// Réglage des paramètres d'analyse carburant (conso de référence, seuils).
app.put('/api/admin/fuel/kpi', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  const b = req.body || {}; const k = db.settings.fuelKpi;
  if (b.refConso != null && Number.isFinite(Number(b.refConso))) k.refConso = Math.max(1, Number(b.refConso));
  if (b.threshold != null && Number.isFinite(Number(b.threshold))) k.threshold = Math.max(1, Number(b.threshold));
  if (b.tankCapacity != null && Number.isFinite(Number(b.tankCapacity))) k.tankCapacity = Math.max(20, Number(b.tankCapacity));
  await save();
  res.json({ fuelKpi: k });
});

// Import d'un export AS 24 (Excel/CSV, base64). Déduplique par n° de transaction.
app.post('/api/staff/fuel/import', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  const b64 = String((req.body && req.body.fileBase64) || '').replace(/^data:[^,]*,/, '');
  if (!b64) return res.status(400).json({ error: 'Aucun fichier fourni.' });
  let rows;
  try { rows = fuelimport.parseWorkbook(Buffer.from(b64, 'base64')); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const seen = new Set(db.fuel.map((t) => t.txnId));
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (seen.has(r.txnId)) { skipped++; continue; }
    const veh = fuelMatchVehicle(db, r);
    db.fuel.push({ id: nextId('fuel'), ...r, vehicleId: veh ? veh.id : null, importedAt: new Date().toISOString() });
    seen.add(r.txnId); added++;
  }
  updateFuelProjections(db); // fige la projection conso & compare au réel
  await save();
  res.json({ added, skipped, total: db.fuel.length });
});

// Associe une carte AS 24 à un véhicule (rapprochement automatique des imports).
app.post('/api/staff/fuel/card-map', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  const { card, vehicleId } = req.body || {};
  if (!card) return res.status(400).json({ error: 'Carte requise.' });
  if (vehicleId) db.settings.fuelCardMap[String(card)] = String(vehicleId);
  else delete db.settings.fuelCardMap[String(card)];
  // Réapplique le mapping aux transactions existantes de cette carte.
  db.fuel.forEach((t) => { if (t.card === String(card)) t.vehicleId = vehicleId || null; });
  await save();
  res.json({ fuelCardMap: db.settings.fuelCardMap });
});

app.delete('/api/staff/fuel/:id', authRequired, adminRequired, async (req, res) => {
  const db = getData(); ensureErp(db);
  db.fuel = db.fuel.filter((t) => t.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

// Extension ERP (facturation, conformité, documents, audit) — déterministe.
require('./routes/erp').mount(app, { express, authRequired, adminRequired, staffRequired, getData, save });

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Démarre un serveur permanent uniquement en exécution directe
// (node server.js). En serverless (Vercel), le module est seulement importé et
// l'app est exportée comme gestionnaire de requêtes.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`INTER COLIS SERVICES — serveur démarré sur http://localhost:${PORT}`);
  });
  try { require('./lib/erp/scheduler').start({ getData, save }); } catch (e) { console.warn('ERP scheduler:', e.message); }
}

module.exports = app;
