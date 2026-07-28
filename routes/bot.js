'use strict';

/**
 * API interne du bot WhatsApp (non officiel, hébergé sur le VPS).
 * Protégée par un jeton partagé secret `BOT_TOKEN` (en-tête x-bot-token).
 * Si BOT_TOKEN est absent, l'API est désactivée (503) — l'app fonctionne sans.
 *
 * Le bot n'écrit jamais la base directement : pour les actions d'un salarié
 * (soldes, poser un congé, signaler un véhicule…), il obtient ici un JETON
 * UTILISATEUR et appelle les endpoints existants comme le ferait le salarié
 * (toute la validation métier est ainsi réutilisée).
 */

const wa = require('../lib/wa');

function mount(app, ctx) {
  const { express, getData, save, signToken } = ctx;
  const r = express.Router();
  const BOT_TOKEN = process.env.BOT_TOKEN || '';

  const botAuth = (req, res, next) => {
    if (!BOT_TOKEN) return res.status(503).json({ error: 'Bot WhatsApp non configuré (BOT_TOKEN absent).' });
    if ((req.headers['x-bot-token'] || '') !== BOT_TOKEN) return res.status(401).json({ error: 'Jeton bot invalide' });
    next();
  };

  // Jeton utilisateur pour un numéro déjà lié (le bot le met en cache par numéro).
  r.post('/resolve', botAuth, (req, res) => {
    const phone = wa.normPhone((req.body || {}).phone);
    const u = (getData().users || []).find((x) => x.whatsapp && x.whatsapp.phone === phone && x.status === 'active');
    if (!u) return res.json({ linked: false });
    res.json({ linked: true, token: signToken(u), firstName: u.firstName, role: u.role });
  });

  // Liaison d'un numéro à un salarié via son code à usage unique (« Mon profil »).
  r.post('/link', botAuth, async (req, res) => {
    const b = req.body || {};
    const phone = wa.normPhone(b.phone);
    const code = String(b.code || '').replace(/\D/g, '');
    if (!phone || !/^\d{6}$/.test(code)) return res.json({ ok: false, error: 'Code à 6 chiffres attendu.' });
    const data = getData();
    const now = Date.now();
    const u = (data.users || []).find((x) => x.waLinkCode && x.waLinkCode.code === code && x.waLinkCode.expires > now && x.status === 'active');
    if (!u) return res.json({ ok: false, error: 'Code invalide ou expiré. Générez-en un nouveau dans « Mon profil ».' });
    (data.users || []).forEach((x) => { if (x.whatsapp && x.whatsapp.phone === phone && x.id !== u.id) x.whatsapp = null; });
    u.whatsapp = { phone, linkedAt: new Date().toISOString() };
    u.waLinkCode = null;
    await save();
    res.json({ ok: true, token: signToken(u), firstName: u.firstName });
  });

  // Messages sortants non encore envoyés (notifications + réponses direction).
  r.get('/outbox', botAuth, (req, res) => {
    const pending = (getData().waOutbox || []).filter((m) => !m.sentAt).slice(0, 30)
      .map((m) => ({ id: m.id, phone: m.phone, text: m.text }));
    res.json({ messages: pending });
  });

  // Acquittement : purge les messages envoyés.
  r.post('/outbox/ack', botAuth, async (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
    const data = getData();
    if (ids.length && Array.isArray(data.waOutbox)) {
      const set = new Set(ids);
      data.waOutbox = data.waOutbox.filter((m) => !set.has(m.id));
      await save();
    }
    res.json({ ok: true });
  });

  app.use('/api/bot', r);
}

module.exports = { mount };
