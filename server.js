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

const ROLES = ['admin', 'responsable', 'employee'];

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'inter-colis-services-dev-secret-change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/register', async (req, res) => {
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
  res.json({
    user: publicUser(user),
    token: user.status === 'active' ? signToken(user) : null,
    message: isFirstUser
      ? `Compte administrateur créé. Votre nom de compte est « ${user.username} ». Vous pouvez vous connecter.`
      : `Demande envoyée. Votre nom de compte est « ${user.username} ». Un administrateur doit valider votre compte et attribuer vos soldes.`,
  });
});

app.post('/api/login', async (req, res) => {
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
  const t = { cpN: 0, cpN1: 0, cp: 0, rcp: 0, rcc: 0 };
  for (const r of db.requests) {
    if (r.userId !== userId || r.status !== 'approved') continue;
    if (r.category === 'CP') { t.cp += r.days || 0; if (r.pool === 'N1') t.cpN1 += r.days || 0; else t.cpN += r.days || 0; }
    else if (r.category === 'RCP') t.rcp += r.hours || 0;
    else if (r.category === 'RCC') t.rcc += r.hours || 0;
  }
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
  const { firstName, lastName, username, email, password, groupId, role, congesN, congesN1, rcc, heuresSupp, isParent, phone, hireDate } = req.body || {};
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
  const { firstName, lastName, username, email, password, groupId, congesN, congesN1, rcc, heuresSupp, role, isParent, phone, hireDate } = req.body || {};

  // Identité et compte
  if (firstName !== undefined && String(firstName).trim()) user.firstName = capitalizeName(firstName);
  if (lastName !== undefined && String(lastName).trim()) user.lastName = capitalizeName(lastName);
  if (phone !== undefined) user.phone = String(phone || '').trim() || null;
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
  // (en attente). Le responsable propose toujours (en attente).
  const isAdmin = req.user.role === 'admin';
  const approveNow = isAdmin && immediate !== false; // par défaut direct pour l'admin
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
    adminNote: approveNow ? 'Attribué par l’administrateur' : (isAdmin ? 'Saisi par l’administrateur (à valider plus tard)' : `Proposé par le responsable ${req.user.firstName} ${req.user.lastName}`),
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
  return Object.values(byUser).filter((x) => x.items.length);
}

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
  const pendingReports = db.vehicleReports.filter((r) => r.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ pendingReports, alerts, ctReminders });
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
  await save();
  res.json({ ok: true });
});

// Enregistrer le remplacement d'une pièce (kilométrage pris en compte).
app.post('/api/admin/vehicles/:id/maint', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const v = db.vehicles.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Véhicule introuvable' });
  const { part, km, date, note } = req.body || {};
  const consumables = db.settings.vehicleConsumables || [];
  if (!consumables.some((c) => c.code === part)) return res.status(400).json({ error: 'Pièce / consommable invalide' });
  const kmNum = intStr(km);
  if (kmNum == null || kmNum < 0) return res.status(400).json({ error: 'Kilométrage du remplacement obligatoire' });
  const rec = {
    id: nextId('vmaint'),
    vehicleId: v.id,
    part,
    km: kmNum,
    date: validDate(date) ? date : new Date().toISOString().slice(0, 10),
    note: String(note || '').trim(),
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
  const { decision, adminNote, resolutions } = req.body || {};
  if (!['reviewed', 'closed', 'pending'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });
  r.status = decision;
  r.adminNote = String(adminNote || '').trim();
  if (Array.isArray(resolutions)) {
    r.resolutions = resolutions.map((x) => ({ issue: String(x.issue || '').slice(0, 200), done: !!x.done }));
  }
  if (decision === 'closed') {
    const total = r.resolutions.length || (r.issues ? r.issues.length : 0);
    const done = r.resolutions.filter((x) => x.done).length;
    r.resolution = total > 0 && done === 0 ? 'notdone' : (done < total ? 'partial' : 'done');
    if (r.resolution !== 'done' && !r.adminNote) {
      return res.status(400).json({ error: 'Précisez le motif lorsque les travaux ne sont pas (entièrement) réalisés.' });
    }
  }
  r.decidedAt = new Date().toISOString();
  r.decidedBy = req.user.id;
  await save();
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
}

module.exports = app;
