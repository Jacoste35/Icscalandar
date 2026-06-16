'use strict';

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('./lib/db');
const { getData, save, nextId } = db;
const holidays = require('./lib/holidays');

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
const CATEGORY_POOLS = {
  CP: [
    { value: 'N', label: 'Congés N' },
    { value: 'N1', label: 'Congés N-1' },
  ],
  RCP: [
    { value: 'RCC', label: 'RCC (jours)' },
    { value: 'HS', label: 'Heures supplémentaires (heures)' },
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
function deductionFor(r) {
  if (r.category === 'CP') return { balance: r.pool === 'N1' ? 'congesN1' : 'congesN', amount: r.days };
  if (r.category === 'RCP') {
    return r.pool === 'HS'
      ? { balance: 'heuresSupp', amount: r.hours }
      : { balance: 'rcc', amount: r.days };
  }
  return null; // PMT, AM, ABS : pas de décompte
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

function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// ---------------------------------------------------------------------------
// Auth & inscription
// ---------------------------------------------------------------------------

app.post('/api/register', async (req, res) => {
  const { firstName, lastName, email, password } = req.body || {};
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
  const user = {
    id: nextId('user'),
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    username: null,
    email: normEmail,
    passwordHash,
    // Le tout premier compte créé devient administrateur et est actif.
    role: isFirstUser ? 'admin' : 'employee',
    status: isFirstUser ? 'active' : 'pending',
    groupId: null,
    balances: { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 },
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  await save();
  res.json({
    user: publicUser(user),
    token: user.status === 'active' ? signToken(user) : null,
    message: isFirstUser
      ? 'Compte administrateur créé. Vous pouvez vous connecter.'
      : 'Demande envoyée. Un administrateur doit valider votre compte et attribuer vos soldes.',
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
  res.json({ user: publicUser(user), token: signToken(user) });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
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

// Liste des membres (visible de tous les inscrits)
app.get('/api/team', authRequired, (req, res) => {
  const db = getData();
  const team = db.users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      groupId: u.groupId,
    }));
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
  const { category, pool, startDate, endDate, reason } = req.body || {};
  const cat = categoryByCode(category);
  if (!cat || !cat.selectable) return res.status(400).json({ error: 'Catégorie de demande invalide' });
  // Vérifie le "pool" pour les catégories qui en exigent un (CP, RCP).
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

  const days = holidays.countWorkingDays(startDate, endDate);
  if (days <= 0) return res.status(400).json({ error: 'Aucun jour ouvré sur cette période (dimanches/fériés exclus)' });

  const request = {
    id: nextId('request'),
    userId: req.user.id,
    category,
    pool: chosenPool,
    startDate,
    endDate,
    reason: String(reason || '').trim(),
    days,
    hours: days * HOURS_PER_DAY,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    adminNote: '',
  };
  getData().requests.push(request);
  await save();
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
  const { firstName, lastName, username, email, password, groupId, role, congesN, congesN1, rcc, heuresSupp } = req.body || {};
  if (!firstName || !lastName) return res.status(400).json({ error: 'Nom et prénom obligatoires' });
  const uname = String(username || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!uname && !mail) return res.status(400).json({ error: 'Renseignez un nom de compte ou un email' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Mot de passe de 6 caractères minimum' });
  if (groupId && !db.groups.some((g) => g.id === groupId)) return res.status(400).json({ error: 'Groupe invalide' });
  if (loginTaken(db, { email: mail, username: uname })) {
    return res.status(409).json({ error: 'Ce nom de compte ou cet email est déjà utilisé' });
  }
  const user = {
    id: nextId('user'),
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    username: uname || null,
    email: mail || null,
    passwordHash: await bcrypt.hash(String(password), 10),
    role: role === 'admin' ? 'admin' : 'employee',
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
  db.users.push(user);
  await save();
  res.json({ user: publicUser(user) });
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
  if (role === 'admin' || role === 'employee') user.role = role;
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
  const { firstName, lastName, username, email, password, groupId, congesN, congesN1, rcc, heuresSupp, role } = req.body || {};

  // Identité et compte
  if (firstName !== undefined && String(firstName).trim()) user.firstName = String(firstName).trim();
  if (lastName !== undefined && String(lastName).trim()) user.lastName = String(lastName).trim();
  if (username !== undefined || email !== undefined) {
    const uname = username !== undefined ? String(username).trim() : (user.username || '');
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
  if (role === 'admin' || role === 'employee') user.role = role;
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

// Toutes les demandes (admin) avec infos utilisateur
app.get('/api/admin/requests', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  const list = db.requests
    .map((r) => {
      const u = usersById[r.userId];
      return {
        ...r,
        userName: u ? `${u.firstName} ${u.lastName}` : 'Inconnu',
        categoryLabel: categoryLabel(r.category),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ requests: list });
});

// Attribuer directement une absence à un salarié (depuis le calendrier).
// La demande est créée déjà validée et le solde est immédiatement décompté.
app.post('/api/admin/requests', authRequired, adminRequired, async (req, res) => {
  const db = getData();
  const { userId, category, pool, startDate, endDate, reason } = req.body || {};
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

  const request = {
    id: nextId('request'),
    userId,
    category,
    pool: chosenPool,
    startDate,
    endDate,
    reason: String(reason || '').trim(),
    days,
    hours: days * HOURS_PER_DAY,
    status: 'approved',
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    decidedBy: req.user.id,
    adminNote: 'Attribué par l’administrateur',
  };
  const d = deductionFor(request);
  if (d) user.balances[d.balance] = Math.round((user.balances[d.balance] - d.amount) * 100) / 100;
  db.requests.push(request);
  await save();
  res.json({ request });
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
