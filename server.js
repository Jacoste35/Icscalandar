'use strict';

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
        replacedByName: r.replacedByName || null,
        fractionnement: r.fractionnement || null,
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

// Tous les utilisateurs actifs (pour gestion des soldes)
app.get('/api/admin/users', authRequired, adminRequired, (req, res) => {
  res.json({ users: getData().users.map(publicUser) });
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
  const { userId, category, pool, startDate, endDate, reason, replacedById, immediate, fractionnement } = req.body || {};
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
  if (!validDate(startDate) || !validDate(endDate)) return res.status(400).json({ error: 'Dates invalides' });
  if (endDate < startDate) return res.status(400).json({ error: 'La date de fin précède la date de début' });
  const days = holidays.countWorkingDays(startDate, endDate);
  if (days <= 0) return res.status(400).json({ error: 'Aucun jour ouvré sur cette période (dimanches/fériés exclus)' });

  // Remplaçant éventuel.
  const replacer = replacedById ? db.users.find((u) => u.id === replacedById) : null;

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
    endDate,
    reason: String(reason || '').trim() || cat.label,
    fractionnement: category === 'PMT' ? (fractionnement === 'fractionne' ? 'fractionne' : 'complet') : null,
    days,
    hours: days * HOURS_PER_DAY,
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

// Décision admin sur une demande (validation = déduction du solde)
app.post('/api/admin/requests/:id/decide', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  const { decision, adminNote } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

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
