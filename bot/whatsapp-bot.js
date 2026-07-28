'use strict';

/**
 * Bot WhatsApp INTER COLIS SERVICES (non officiel, hébergé sur le VPS).
 *
 * ⚠️ À exécuter comme PROCESSUS SÉPARÉ de l'application (voir bot/README.md).
 * Il n'écrit jamais la base : il dialogue avec l'app via l'API interne
 * (routes/bot.js, jeton BOT_TOKEN) et via les endpoints existants au nom du
 * salarié (jeton utilisateur obtenu à la liaison).
 *
 * Menu guidé (chiffres). Le salarié lie son compte en envoyant le code affiché
 * dans « Mon profil » de l'application.
 *
 * Variables d'environnement :
 *   APP_URL        (déf. http://localhost:3000) — base de l'API de l'app
 *   BOT_TOKEN      (obligatoire) — jeton partagé secret (identique à l'app)
 *   WA_SESSION_DIR (déf. ./wa-session) — dossier de session WhatsApp (QR)
 */

const path = require('path');
const P = require('pino')({ level: 'silent' });
const qrcode = require('qrcode-terminal');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, 'wa-session');

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN manquant — définissez-le (identique à l’app) puis relancez.'); process.exit(1); }

// --- Clients API -----------------------------------------------------------
async function apiBot(pathname, body) {
  const res = await fetch(APP_URL + '/api/bot' + pathname, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'x-bot-token': BOT_TOKEN }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data = {}; try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
  return { ok: res.ok, status: res.status, data };
}
async function apiUser(token, method, pathname, body) {
  const res = await fetch(APP_URL + '/api' + pathname, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data = {}; try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

// --- État de conversation par numéro (en mémoire) --------------------------
const sessions = new Map(); // phone -> { token, firstName, flow }

function menuText(name) {
  return `Bonjour ${name || ''} 👋 — que souhaitez-vous faire ?\n\n` +
    `1️⃣ Mes soldes de congés\n` +
    `2️⃣ Mes demandes / congés\n` +
    `3️⃣ Poser un congé\n` +
    `4️⃣ Signaler un problème véhicule\n` +
    `5️⃣ Mes documents à lire\n` +
    `6️⃣ Contacter la direction\n\n` +
    `Répondez par le chiffre. Tapez *menu* à tout moment.`;
}

function parseDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  return null;
}
function frDate(iso) { if (!iso) return '—'; const p = String(iso).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; }

// --- Logique du menu -------------------------------------------------------
// Renvoie un texte (ou tableau de textes) de réponse. `send` sert aux cas async.
async function handleText(phone, text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  let sess = sessions.get(phone);

  // Résolution / liaison si non authentifié.
  if (!sess || !sess.token) {
    const r = await apiBot('/resolve', { phone });
    if (r.data && r.data.linked) {
      sess = { token: r.data.token, firstName: r.data.firstName, flow: null };
      sessions.set(phone, sess);
      return menuText(sess.firstName);
    }
    // Non lié : on attend un code à 6 chiffres.
    const code = t.replace(/\D/g, '');
    if (/^\d{6}$/.test(code)) {
      const lk = await apiBot('/link', { phone, code });
      if (lk.data && lk.data.ok) {
        sessions.set(phone, { token: lk.data.token, firstName: lk.data.firstName, flow: null });
        return `✅ Compte lié, bienvenue ${lk.data.firstName || ''} !\n\n` + menuText(lk.data.firstName);
      }
      return (lk.data && lk.data.error) || 'Code invalide. Réessayez.';
    }
    return `👋 Bienvenue sur le bot INTER COLIS SERVICES.\n\nPour lier votre compte, ouvrez l’application → *Mon profil* → *Lier mon WhatsApp*, puis envoyez-moi le *code à 6 chiffres* affiché.`;
  }

  // Commandes globales.
  if (low === 'menu' || low === '0' || low === 'annuler') { sess.flow = null; return menuText(sess.firstName); }

  // Poursuite d'un flux en cours.
  if (sess.flow) return continueFlow(sess, t);

  // Choix du menu principal.
  if (t === '1') return soldes(sess);
  if (t === '2') return mesConges(sess);
  if (t === '3') { sess.flow = { name: 'leave', step: 'cat', data: {} }; return `Poser un congé — quel type ?\n1️⃣ Congé payé\n2️⃣ Récupération (heures sup.)\n3️⃣ Congé sans solde\n\n(*menu* pour annuler)`; }
  if (t === '4') { sess.flow = { name: 'veh', step: 'list', data: {} }; return await vehStart(sess); }
  if (t === '5') return mesDocuments(sess);
  if (t === '6') { sess.flow = { name: 'contact', step: 'text', data: {} }; return `Écrivez votre message pour la direction. Il lui sera transmis et vous recevrez sa réponse ici.\n\n(*menu* pour annuler)`; }
  return `Je n’ai pas compris. ` + menuText(sess.firstName);
}

async function soldes(sess) {
  const r = await apiUser(sess.token, 'GET', '/me');
  if (!r.ok) return 'Impossible de récupérer vos soldes pour le moment.';
  const b = (r.data.user && r.data.user.balances) || {};
  return `🌴 *Vos soldes*\n` +
    `• Congés N : ${b.congesN ?? 0} j\n` +
    `• Congés N-1 : ${b.congesN1 ?? 0} j\n` +
    `• RCC : ${b.rcc ?? 0} j\n` +
    `• Heures supplémentaires : ${b.heuresSupp ?? 0} h\n\nTapez *menu* pour revenir.`;
}
async function mesConges(sess) {
  const r = await apiUser(sess.token, 'GET', '/requests/mine');
  if (!r.ok) return 'Impossible de récupérer vos demandes.';
  const list = (r.data.requests || []).slice(0, 8);
  if (!list.length) return 'Vous n’avez aucune demande enregistrée.\n\nTapez *menu* pour revenir.';
  const st = { approved: '✅ validé', pending: '⏳ en attente', rejected: '❌ refusé' };
  return `📋 *Vos dernières demandes*\n` + list.map((x) => `• ${x.category} ${frDate(x.startDate)}→${frDate(x.endDate)} : ${st[x.status] || x.status}`).join('\n') + `\n\nTapez *menu* pour revenir.`;
}
async function mesDocuments(sess) {
  const r = await apiUser(sess.token, 'GET', '/admin/erp/my-documents');
  if (!r.ok) return 'Impossible de récupérer vos documents.';
  const docs = (r.data.documents || []).filter((d) => d.status !== 'acked');
  if (!docs.length) return 'Aucun document en attente de lecture. 👍\n\nTapez *menu* pour revenir.';
  return `📄 *Documents à lire (${docs.length})*\n` + docs.slice(0, 8).map((d) => `• ${d.label}`).join('\n') + `\n\n➡️ Ouvrez l’application pour les consulter et en accuser réception.\n\nTapez *menu* pour revenir.`;
}
async function vehStart(sess) {
  const r = await apiUser(sess.token, 'GET', '/vehicles');
  if (!r.ok) { sess.flow = null; return 'Impossible de charger la liste des véhicules.'; }
  const vehicles = (r.data.vehicles || []);
  if (!vehicles.length) { sess.flow = null; return 'Aucun véhicule enregistré. Contactez la direction.'; }
  sess.flow.data.vehicles = vehicles;
  return `Signaler un problème véhicule — choisissez :\n` + vehicles.slice(0, 15).map((v, i) => `${i + 1}️⃣ ${v.name}${v.plate ? ' (' + v.plate + ')' : ''}`).join('\n') + `\n\nRépondez par le numéro. (*menu* pour annuler)`;
}

async function continueFlow(sess, t) {
  const f = sess.flow;
  // --- Poser un congé ---
  if (f.name === 'leave') {
    if (f.step === 'cat') {
      const map = { 1: { category: 'CP' }, 2: { category: 'RCP' }, 3: { category: 'CSS' } };
      const c = map[t]; if (!c) return 'Répondez 1, 2 ou 3 (ou *menu*).';
      f.data.category = c.category;
      if (c.category === 'CP') { f.step = 'pool'; return 'Sur quel solde ?\n1️⃣ Congés N\n2️⃣ Congés N-1'; }
      f.step = 'start'; return 'Date de début ? (JJ/MM/AAAA)';
    }
    if (f.step === 'pool') {
      const p = { 1: 'N', 2: 'N1' }[t]; if (!p) return 'Répondez 1 ou 2.';
      f.data.pool = p; f.step = 'start'; return 'Date de début ? (JJ/MM/AAAA)';
    }
    if (f.step === 'start') {
      const d = parseDate(t); if (!d) return 'Date invalide. Format JJ/MM/AAAA.';
      f.data.startDate = d; f.step = 'end'; return 'Date de fin ? (JJ/MM/AAAA)';
    }
    if (f.step === 'end') {
      const d = parseDate(t); if (!d) return 'Date invalide. Format JJ/MM/AAAA.';
      f.data.endDate = d; f.step = 'confirm';
      return `Confirmez-vous la demande ?\n• ${f.data.category}${f.data.pool ? ' (' + (f.data.pool === 'N' ? 'N' : 'N-1') + ')' : ''}\n• du ${frDate(f.data.startDate)} au ${frDate(f.data.endDate)}\n\nRépondez *oui* pour envoyer, *menu* pour annuler.`;
    }
    if (f.step === 'confirm') {
      if (!/^oui|o|yes$/i.test(t)) { sess.flow = null; return 'Demande annulée. Tapez *menu*.'; }
      const r = await apiUser(sess.token, 'POST', '/requests', f.data);
      sess.flow = null;
      if (r.ok) return '✅ Demande envoyée ! Vous serez notifié de la décision. Tapez *menu*.';
      return `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`;
    }
  }
  // --- Signaler un véhicule ---
  if (f.name === 'veh') {
    if (f.step === 'list') {
      const idx = parseInt(t, 10) - 1; const v = (f.data.vehicles || [])[idx];
      if (!v) return 'Numéro invalide. Répondez par le numéro du véhicule.';
      f.data.vehicle = v; f.step = 'km'; return `Kilométrage actuel de ${v.name} ? (nombre)`;
    }
    if (f.step === 'km') {
      const km = parseInt(String(t).replace(/\D/g, ''), 10);
      if (!Number.isFinite(km)) return 'Indiquez le kilométrage (nombre).';
      f.data.km = km; f.step = 'desc'; return 'Décrivez le problème constaté :';
    }
    if (f.step === 'desc') {
      f.data.note = String(t).slice(0, 500);
      const v = f.data.vehicle;
      const r = await apiUser(sess.token, 'POST', '/vehicles/report', { vehicleId: v.id, plate: v.plate || '', km: f.data.km, issues: [], note: f.data.note });
      sess.flow = null;
      if (r.ok) return '✅ Signalement transmis à l’atelier. Merci ! Tapez *menu*.';
      return `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`;
    }
  }
  // --- Contacter la direction ---
  if (f.name === 'contact') {
    const r = await apiUser(sess.token, 'POST', '/me/contact-direction', { text: String(t).slice(0, 2000) });
    sess.flow = null;
    if (r.ok) return '✅ Message transmis à la direction. Vous recevrez sa réponse ici. Tapez *menu*.';
    return `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`;
  }
  sess.flow = null; return menuText(sess.firstName);
}

// --- Connexion WhatsApp (Baileys) ------------------------------------------
let sock = null;

async function sendText(jid, text) {
  const chunks = Array.isArray(text) ? text : [text];
  for (const c of chunks) { if (c) await sock.sendMessage(jid, { text: String(c) }); }
}

async function pollOutbox() {
  if (!sock) return;
  try {
    const r = await apiBot('/outbox');
    const msgs = (r.data && r.data.messages) || [];
    const done = [];
    for (const m of msgs) {
      try { await sock.sendMessage(m.phone + '@s.whatsapp.net', { text: m.text }); done.push(m.id); }
      catch (e) { /* on réessaiera au prochain tour */ }
    }
    if (done.length) await apiBot('/outbox/ack', { ids: done });
  } catch (e) { /* app injoignable : on réessaie */ }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { version = undefined; }
  sock = makeWASocket({ auth: state, version, logger: P, printQRInTerminal: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { console.log('\n📲 Scannez ce QR code avec WhatsApp (Appareils connectés) :\n'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') console.log('✅ Bot WhatsApp connecté.');
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('🔌 Déconnecté' + (loggedOut ? ' (session fermée — supprimez wa-session et rescannez).' : ' — reconnexion…'));
      if (!loggedOut) setTimeout(() => start().catch((e) => console.error(e)), 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (!jid.endsWith('@s.whatsapp.net')) continue; // ignore groupes / statuts
        const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
        if (!text) continue;
        const phone = jid.split('@')[0].replace(/\D/g, '');
        const reply = await handleText(phone, text);
        await sendText(jid, reply);
      } catch (e) { console.error('Traitement message:', e && e.message); }
    }
  });

  setInterval(pollOutbox, 8000);
}

start().catch((e) => { console.error('Démarrage bot impossible:', e); process.exit(1); });
