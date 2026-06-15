'use strict';

const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { getData, save, nextId } = require('./lib/db');
const holidays = require('./lib/holidays');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'inter-colis-services-dev-secret-change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEAVE_TYPES = {
  conge_n: { label: 'Congé payé N', balance: 'congesN', unit: 'days' },
  conge_n1: { label: 'Congé payé N-1', balance: 'congesN1', unit: 'days' },
  rcc: { label: 'RCC', balance: 'rcc', unit: 'days' },
  recuperation: { label: 'Récupération (heures sup.)', balance: 'heuresSupp', unit: 'hours' },
  absence: { label: 'Absence', balance: null, unit: 'days' },
};
const HOURS_PER_DAY = 7;

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
  save();
  res.json({
    user: publicUser(user),
    token: user.status === 'active' ? signToken(user) : null,
    message: isFirstUser
      ? 'Compte administrateur créé. Vous pouvez vous connecter.'
      : 'Demande envoyée. Un administrateur doit valider votre compte et attribuer vos soldes.',
  });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const db = getData();
  const normEmail = String(email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email === normEmail);
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

app.get('/api/info-panel', authRequired, (req, res) => {
  res.json({ content: getData().settings.infoPanel });
});

app.put('/api/info-panel', authRequired, adminRequired, (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'Contenu invalide' });
  getData().settings.infoPanel = content;
  save();
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
  const usersById = Object.fromEntries(db.users.map((u) => [u.id, u]));
  const events = db.requests
    .filter((r) => r.status === 'approved')
    .map((r) => {
      const u = usersById[r.userId];
      const g = u ? groupsById[u.groupId] : null;
      return {
        id: r.id,
        userId: r.userId,
        userName: u ? `${u.firstName} ${u.lastName}` : 'Inconnu',
        groupId: u ? u.groupId : null,
        groupName: g ? g.name : '—',
        color: g ? g.color : '#64748b',
        type: r.type,
        typeLabel: (LEAVE_TYPES[r.type] || {}).label || r.type,
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

app.post('/api/requests', authRequired, (req, res) => {
  const { type, startDate, endDate, reason } = req.body || {};
  if (!LEAVE_TYPES[type]) return res.status(400).json({ error: 'Type de demande invalide' });
  if (!validDate(startDate) || !validDate(endDate)) return res.status(400).json({ error: 'Dates invalides' });
  if (endDate < startDate) return res.status(400).json({ error: 'La date de fin précède la date de début' });

  const days = holidays.countWorkingDays(startDate, endDate);
  if (days <= 0) return res.status(400).json({ error: 'Aucun jour ouvré sur cette période (dimanches/fériés exclus)' });

  const request = {
    id: nextId('request'),
    userId: req.user.id,
    type,
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
  save();
  res.json({ request });
});

app.delete('/api/requests/:id', authRequired, (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  if (r.userId !== req.user.id) return res.status(403).json({ error: 'Action non autorisée' });
  if (r.status !== 'pending') return res.status(400).json({ error: 'Seules les demandes en attente peuvent être annulées' });
  db.requests = db.requests.filter((x) => x.id !== r.id);
  save();
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

// Valider une inscription en attribuant groupe + soldes
app.post('/api/admin/users/:id/approve', authRequired, adminRequired, (req, res) => {
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
  save();
  res.json({ user: publicUser(user) });
});

app.post('/api/admin/users/:id/reject', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  user.status = 'rejected';
  save();
  res.json({ user: publicUser(user) });
});

// Modifier groupe / soldes / rôle d'un utilisateur actif
app.put('/api/admin/users/:id', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const { groupId, congesN, congesN1, rcc, heuresSupp, role } = req.body || {};
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
  save();
  res.json({ user: publicUser(user) });
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
        typeLabel: (LEAVE_TYPES[r.type] || {}).label || r.type,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ requests: list });
});

// Décision admin sur une demande (validation = déduction du solde)
app.post('/api/admin/requests/:id/decide', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const r = db.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable' });
  const { decision, adminNote } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Décision invalide' });

  if (decision === 'approved' && r.status !== 'approved') {
    const user = db.users.find((u) => u.id === r.userId);
    const typeInfo = LEAVE_TYPES[r.type];
    if (user && typeInfo && typeInfo.balance) {
      if (typeInfo.unit === 'hours') {
        user.balances[typeInfo.balance] = Math.round((user.balances[typeInfo.balance] - r.hours) * 100) / 100;
      } else {
        user.balances[typeInfo.balance] = Math.round((user.balances[typeInfo.balance] - r.days) * 100) / 100;
      }
    }
  }
  // Si on repasse d'approuvé à refusé, on recrédite le solde.
  if (decision === 'rejected' && r.status === 'approved') {
    const user = db.users.find((u) => u.id === r.userId);
    const typeInfo = LEAVE_TYPES[r.type];
    if (user && typeInfo && typeInfo.balance) {
      const amount = typeInfo.unit === 'hours' ? r.hours : r.days;
      user.balances[typeInfo.balance] = Math.round((user.balances[typeInfo.balance] + amount) * 100) / 100;
    }
  }

  r.status = decision;
  r.adminNote = String(adminNote || '').trim();
  r.decidedAt = new Date().toISOString();
  r.decidedBy = req.user.id;
  save();
  res.json({ request: r });
});

// Gestion des groupes (couleurs)
app.put('/api/admin/groups/:id', authRequired, adminRequired, (req, res) => {
  const db = getData();
  const g = db.groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Groupe introuvable' });
  const { name, color } = req.body || {};
  if (name) g.name = String(name).trim();
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) g.color = color;
  save();
  res.json({ group: g });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`INTER COLIS SERVICES — serveur démarré sur http://localhost:${PORT}`);
});
