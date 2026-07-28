'use strict';

/**
 * Bot WhatsApp INTER COLIS SERVICES (non officiel, hébergé sur le VPS).
 *
 * ⚠️ Processus SÉPARÉ de l'application (voir bot/README.md). Il n'écrit jamais la
 * base : il passe par l'API interne (routes/bot.js, jeton BOT_TOKEN) et par les
 * endpoints existants au nom du salarié.
 *
 * Deux modes :
 *   • Messages privés → menu guidé (soldes, congés, véhicule, direction…).
 *   • Groupes « entretien » → intake conversationnel : le bot reconnaît le
 *     salarié par son numéro et son véhicule attribué, complète les infos
 *     manquantes (véhicule ? avant/arrière ?) puis dépose le signalement.
 *
 * Humanisation : lecture des messages, indicateur « en train d'écrire » et
 * délais aléatoires, pour réduire le profil « robot ».
 *
 * Env : APP_URL, BOT_TOKEN (obligatoire), WA_SESSION_DIR, WA_GROUP_KEYWORDS.
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
// Mots-clés du SUJET d'un groupe qui déclenchent le mode « entretien véhicules ».
const GROUP_KW = new RegExp(process.env.WA_GROUP_KEYWORDS || 'entretien|atelier|m[eé]cano|v[eé]hicule|flotte', 'i');

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN manquant — définissez-le (identique à l’app) puis relancez.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

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

// --- Reconnaissance des problèmes véhicule (vocabulaire → libellés du site) --
function normalize(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function detectFR(t) { if (/arriere|\barr\b|derriere/.test(t)) return 'arriere'; if (/avant|\bav\b|devant/.test(t)) return 'avant'; return null; }
function detectSide(t) {
  if (/\bavg\b|avant gauche|av gauche/.test(t)) return 'AVG';
  if (/\bavd\b|avant droit|av droit/.test(t)) return 'AVD';
  if (/gauche/.test(t)) return 'G'; if (/droit/.test(t)) return 'D';
  return null;
}
// Construit le libellé exact attendu par le site à partir de la famille + position.
function issueLabel(family, pos) {
  const L = {
    freins: { avant: 'Freins avant usés (plaquettes / disques)', arriere: 'Freins arrière usés (plaquettes / disques)' },
    pneus: { avant: 'Pneus avant usés', arriere: 'Pneus arrière usés' },
    amortisseur: { AVG: 'Amortisseur avant gauche (AVG) défectueux', AVD: 'Amortisseur avant droit (AVD) défectueux' },
    triangle: { AVG: 'Triangle de suspension avant gauche (AVG) à remplacer', AVD: 'Triangle de suspension avant droit (AVD) à remplacer' },
  };
  if (L[family]) return L[family][pos] || null;
  const FIX = {
    embrayage: 'Embrayage / boîte de vitesses (point dur, à-coups)',
    batterie: 'Batterie faible / démarrage difficile',
    vidange: 'Vidange à prévoir',
    essuie: 'Essuie-glaces à remplacer',
    parebrise: 'Pare-brise fissuré ou impacté',
    fuite: 'Fuite constatée (huile / liquide)',
    clim: 'Climatisation / chauffage défaillant',
    turbo: 'Turbo inefficace',
    bruit: 'Bruit anormal ou vibration',
    pression: 'Pneus sous-gonflés / témoin de pression allumé',
    carrosserie: 'Carrosserie endommagée (choc / rayure)',
    revision: 'Révision « Service A » (intermédiaire) à prévoir',
    voyantP: 'Voyant moteur avec perte de puissance',
    voyant: 'Voyant moteur sans perte de puissance',
  };
  return FIX[family] || null;
}
// Détecte la famille de problème dans un texte. Renvoie { family, needs:'fr'|'side'|null }.
function detectIssue(t) {
  if (/frein|plaquette|disque/.test(t)) return { family: 'freins', needs: 'fr' };
  if (/pneu|\broue|gomme|crevaison/.test(t)) return { family: 'pneus', needs: 'fr' };
  if (/amortisseur|amorto/.test(t)) return { family: 'amortisseur', needs: 'side' };
  if (/triangle|rotule|bras de suspension/.test(t)) return { family: 'triangle', needs: 'side' };
  if (/embrayage|boite|boîte|vitesse/.test(t)) return { family: 'embrayage', needs: null };
  if (/batterie|demarr|démarr/.test(t)) return { family: 'batterie', needs: null };
  if (/vidange/.test(t)) return { family: 'vidange', needs: null };
  if (/essuie|balai/.test(t)) return { family: 'essuie', needs: null };
  if (/pare.?brise|vitre|impact|fissure/.test(t)) return { family: 'parebrise', needs: null };
  if (/fuite/.test(t)) return { family: 'fuite', needs: null };
  if (/clim|chauffage/.test(t)) return { family: 'clim', needs: null };
  if (/turbo/.test(t)) return { family: 'turbo', needs: null };
  if (/pression|sous.?gonfl/.test(t)) return { family: 'pression', needs: null };
  if (/bruit|vibration|claque|cogne/.test(t)) return { family: 'bruit', needs: null };
  if (/choc|rayure|carrosserie|bosse|enfonc/.test(t)) return { family: 'carrosserie', needs: null };
  if (/voyant/.test(t)) return { family: /puissance|perte|bride/.test(t) ? 'voyantP' : 'voyant', needs: null };
  if (/revision|révision|entretien/.test(t)) return { family: 'revision', needs: null };
  return null;
}
// Résout la position à partir du besoin de la famille et du texte.
function resolvePos(needs, t) {
  if (needs === 'fr') return detectFR(t);
  if (needs === 'side') { const s = detectSide(t); return (s === 'AVG' || s === 'AVD') ? s : null; }
  return 'ok';
}
// Reconnait un véhicule mentionné (numéro de parc / immatriculation).
function matchVehicle(text, fleet) {
  const t = normalize(text);
  const tokens = (t.match(/[a-z0-9]{2,}/g) || []).filter((x) => /\d/.test(x));
  for (const v of fleet) {
    const hay = normalize((v.name || '') + ' ' + (v.plate || '')).replace(/[^a-z0-9]/g, '');
    for (const tok of tokens) { if (tok.length >= 3 && hay.includes(tok)) return v; }
  }
  return null;
}

// --- Flotte (cache rafraîchi) ----------------------------------------------
let fleet = [];
async function refreshFleet() { try { const r = await apiBot('/vehicles'); if (r.ok) fleet = r.data.vehicles || []; } catch (e) {} }

// --- Retour de tournée (n° tournée / colis / points) -----------------------
function looksLikeTourReturn(text) {
  return /colis|points?\b/i.test(text) || /\b\d{1,4}\s*[/,;\-]\s*\d{1,5}\s*[/,;\-]\s*\d{1,5}\b/.test(text);
}
function parseTourReturn(text) {
  let tourNo = '', parcels = null, points = null;
  const m = text.match(/(\d{1,4})\s*[/,;\-]\s*(\d{1,5})\s*[/,;\-]\s*(\d{1,5})/);
  if (m) { tourNo = m[1]; parcels = parseInt(m[2], 10); points = parseInt(m[3], 10); }
  else {
    const mc = text.match(/(\d{1,5})\s*colis/i); if (mc) parcels = parseInt(mc[1], 10);
    const mp = text.match(/(\d{1,5})\s*points?/i); if (mp) points = parseInt(mp[1], 10);
    const mt = text.match(/tourn[eé]*e?\s*n?[°:.\s]*([a-z]?\d{1,5})/i) || text.match(/\bT\s*[-:.]?\s*(\d{1,5})\b/i);
    if (mt) tourNo = mt[1];
  }
  if (!Number.isFinite(parcels) || !Number.isFinite(points)) return null;
  return { tourNo, parcels, points };
}
async function submitTourReturn(phone, parsed) {
  const r = await apiBot('/tour-return', Object.assign({ phone }, parsed));
  return r;
}

// ===========================================================================
//  MODE PRIVÉ (menu guidé)
// ===========================================================================
const sessions = new Map(); // phone -> { token, firstName, flow }

function menuText(name) {
  return `Bonjour ${name || ''} 👋 — que souhaitez-vous faire ?\n\n` +
    `1️⃣ Mes soldes de congés\n2️⃣ Mes demandes / congés\n3️⃣ Poser un congé\n` +
    `4️⃣ Signaler un problème véhicule\n5️⃣ Mes documents à lire\n6️⃣ Contacter la direction\n\n` +
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

async function handlePrivate(phone, text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  let sess = sessions.get(phone);
  if (!sess || !sess.token) {
    const r = await apiBot('/resolve', { phone });
    if (r.data && r.data.linked) { sess = { token: r.data.token, firstName: r.data.firstName, flow: null }; sessions.set(phone, sess); return menuText(sess.firstName); }
    const code = t.replace(/\D/g, '');
    if (/^\d{6}$/.test(code)) {
      const lk = await apiBot('/link', { phone, code });
      if (lk.data && lk.data.ok) { sessions.set(phone, { token: lk.data.token, firstName: lk.data.firstName, flow: null }); return `✅ Compte lié, bienvenue ${lk.data.firstName || ''} !\n\n` + menuText(lk.data.firstName); }
      return (lk.data && lk.data.error) || 'Code invalide. Réessayez.';
    }
    return `👋 Bienvenue sur le bot INTER COLIS SERVICES.\n\nPour lier votre compte : application → *Mon profil* → *Lier mon WhatsApp*, puis envoyez-moi le *code à 6 chiffres*.`;
  }
  if (low === 'menu' || low === '0' || low === 'annuler') { sess.flow = null; return menuText(sess.firstName); }
  if (sess.flow) return continueFlow(sess, t);
  if (t === '1') return soldes(sess);
  if (t === '2') return mesConges(sess);
  if (t === '3') { sess.flow = { name: 'leave', step: 'cat', data: {} }; return `Poser un congé — quel type ?\n1️⃣ Congé payé\n2️⃣ Récupération (heures sup.)\n3️⃣ Congé sans solde\n\n(*menu* pour annuler)`; }
  if (t === '4') { sess.flow = { name: 'veh', step: 'list', data: {} }; return await vehStart(sess); }
  if (t === '5') return mesDocuments(sess);
  if (t === '6') { sess.flow = { name: 'contact', step: 'text', data: {} }; return `Écrivez votre message pour la direction. Vous recevrez sa réponse ici.\n\n(*menu* pour annuler)`; }
  return `Je n’ai pas compris. ` + menuText(sess.firstName);
}
async function soldes(sess) {
  const r = await apiUser(sess.token, 'GET', '/me'); if (!r.ok) return 'Soldes indisponibles pour le moment.';
  const b = (r.data.user && r.data.user.balances) || {};
  return `🌴 *Vos soldes*\n• Congés N : ${b.congesN ?? 0} j\n• Congés N-1 : ${b.congesN1 ?? 0} j\n• RCC : ${b.rcc ?? 0} j\n• Heures sup. : ${b.heuresSupp ?? 0} h\n\nTapez *menu*.`;
}
async function mesConges(sess) {
  const r = await apiUser(sess.token, 'GET', '/requests/mine'); if (!r.ok) return 'Demandes indisponibles.';
  const list = (r.data.requests || []).slice(0, 8); if (!list.length) return 'Aucune demande enregistrée.\n\nTapez *menu*.';
  const st = { approved: '✅ validé', pending: '⏳ en attente', rejected: '❌ refusé' };
  return `📋 *Vos dernières demandes*\n` + list.map((x) => `• ${x.category} ${frDate(x.startDate)}→${frDate(x.endDate)} : ${st[x.status] || x.status}`).join('\n') + `\n\nTapez *menu*.`;
}
async function mesDocuments(sess) {
  const r = await apiUser(sess.token, 'GET', '/admin/erp/my-documents'); if (!r.ok) return 'Documents indisponibles.';
  const docs = (r.data.documents || []).filter((d) => d.status !== 'acked');
  if (!docs.length) return 'Aucun document en attente. 👍\n\nTapez *menu*.';
  return `📄 *Documents à lire (${docs.length})*\n` + docs.slice(0, 8).map((d) => `• ${d.label}`).join('\n') + `\n\n➡️ Ouvrez l’application pour les consulter.\n\nTapez *menu*.`;
}
async function vehStart(sess) {
  const r = await apiUser(sess.token, 'GET', '/vehicles'); if (!r.ok) { sess.flow = null; return 'Liste des véhicules indisponible.'; }
  const vehicles = r.data.vehicles || []; if (!vehicles.length) { sess.flow = null; return 'Aucun véhicule enregistré.'; }
  sess.flow.data.vehicles = vehicles;
  return `Signaler un problème — choisissez :\n` + vehicles.slice(0, 15).map((v, i) => `${i + 1}️⃣ ${v.name}${v.plate ? ' (' + v.plate + ')' : ''}`).join('\n') + `\n\nRépondez par le numéro. (*menu* pour annuler)`;
}
async function continueFlow(sess, t) {
  const f = sess.flow;
  if (f.name === 'leave') {
    if (f.step === 'cat') { const c = ({ 1: 'CP', 2: 'RCP', 3: 'CSS' })[t]; if (!c) return 'Répondez 1, 2 ou 3.'; f.data.category = c; if (c === 'CP') { f.step = 'pool'; return 'Sur quel solde ?\n1️⃣ Congés N\n2️⃣ Congés N-1'; } f.step = 'start'; return 'Date de début ? (JJ/MM/AAAA)'; }
    if (f.step === 'pool') { const p = ({ 1: 'N', 2: 'N1' })[t]; if (!p) return 'Répondez 1 ou 2.'; f.data.pool = p; f.step = 'start'; return 'Date de début ? (JJ/MM/AAAA)'; }
    if (f.step === 'start') { const d = parseDate(t); if (!d) return 'Date invalide (JJ/MM/AAAA).'; f.data.startDate = d; f.step = 'end'; return 'Date de fin ? (JJ/MM/AAAA)'; }
    if (f.step === 'end') { const d = parseDate(t); if (!d) return 'Date invalide (JJ/MM/AAAA).'; f.data.endDate = d; f.step = 'confirm'; return `Confirmez ?\n• ${f.data.category}${f.data.pool ? ' (' + (f.data.pool === 'N' ? 'N' : 'N-1') + ')' : ''}\n• du ${frDate(f.data.startDate)} au ${frDate(f.data.endDate)}\n\n*oui* pour envoyer, *menu* pour annuler.`; }
    if (f.step === 'confirm') { if (!/^oui|o|yes$/i.test(t)) { sess.flow = null; return 'Annulé. Tapez *menu*.'; } const r = await apiUser(sess.token, 'POST', '/requests', f.data); sess.flow = null; return r.ok ? '✅ Demande envoyée ! Vous serez notifié. Tapez *menu*.' : `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`; }
  }
  if (f.name === 'veh') {
    if (f.step === 'list') { const v = (f.data.vehicles || [])[parseInt(t, 10) - 1]; if (!v) return 'Numéro invalide.'; f.data.vehicle = v; f.step = 'km'; return `Kilométrage actuel de ${v.name} ? (nombre)`; }
    if (f.step === 'km') { const km = parseInt(String(t).replace(/\D/g, ''), 10); if (!Number.isFinite(km)) return 'Indiquez le kilométrage (nombre).'; f.data.km = km; f.step = 'desc'; return 'Décrivez le problème :'; }
    if (f.step === 'desc') { const v = f.data.vehicle; const r = await apiUser(sess.token, 'POST', '/vehicles/report', { vehicleId: v.id, plate: v.plate || '', km: f.data.km, issues: [], note: String(t).slice(0, 500) }); sess.flow = null; return r.ok ? '✅ Signalement transmis à l’atelier. Merci ! Tapez *menu*.' : `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`; }
  }
  if (f.name === 'contact') { const r = await apiUser(sess.token, 'POST', '/me/contact-direction', { text: String(t).slice(0, 2000) }); sess.flow = null; return r.ok ? '✅ Message transmis à la direction. Réponse ici. Tapez *menu*.' : `❌ ${(r.data && r.data.error) || 'Envoi impossible.'}\n\nTapez *menu*.`; }
  sess.flow = null; return menuText(sess.firstName);
}

// ===========================================================================
//  MODE GROUPE « ENTRETIEN » (intake véhicule conversationnel)
// ===========================================================================
const groupState = new Map(); // `${jid}|${phone}` -> { step, who, family, needs, pos, vehicle, note }

async function submitReport(who, vehicle, label, note) {
  const r = await apiBot('/vehicle-report', { phone: who.phone, vehicleId: vehicle.id, issues: label ? [label] : [], note: note || '' });
  return r.ok;
}
function issueRecap(family, pos) { const l = issueLabel(family, pos); return l || 'problème signalé'; }

// Renvoie le texte de réponse (ou null pour rester silencieux).
async function handleGroupEntretien(jid, phone, senderName, text) {
  const key = jid + '|' + phone;
  const t = normalize(text);
  let stt = groupState.get(key);

  // Poursuite d'un échange en cours.
  if (stt) {
    if (stt.step === 'confirmVeh') {
      if (/\b(oui|ok|c'?est ca|exact|yes|y)\b/.test(t)) { stt.step = 'afterVeh'; return afterVehicle(key, stt); }
      if (/\b(non|no|nan|pas)\b/.test(t)) { stt.step = 'askVeh'; return `D'accord ${stt.who.firstName}. Quel est le véhicule ? (numéro ou immatriculation)`; }
      // Réponse ambiguë : peut-être une correction de véhicule ou une précision.
      const v2 = matchVehicle(text, fleet); if (v2) stt.vehicle = v2;
      const iss2 = detectIssue(t); if (iss2) { stt.family = iss2.family; stt.needs = iss2.needs; }
      if (!stt.vehicle) { stt.step = 'askVeh'; return `De quel véhicule s'agit-il ? (numéro de parc ou immatriculation)`; }
      return `Pour être sûr : ${vLabel(stt.vehicle)}${stt.family ? ' — ' + issueRecap(stt.family, null) : ''}. C'est bien ça ? (oui / non)`;
    }
    if (stt.step === 'askVeh') {
      const v = matchVehicle(text, fleet);
      if (!v) return `Je ne trouve pas ce véhicule. Donne son numéro de parc ou son immatriculation.`;
      stt.vehicle = v; stt.step = 'afterVeh'; return afterVehicle(key, stt);
    }
    if (stt.step === 'askPos') {
      const pos = resolvePos(stt.needs, t);
      if (!pos) return stt.needs === 'fr' ? `À l'avant ou à l'arrière ?` : `Côté gauche (AVG) ou droit (AVD) ?`;
      stt.pos = pos; return finalizeGroup(key, stt);
    }
    // état inattendu → on repart proprement
    groupState.delete(key);
  }

  // Nouveau message : n'engage QUE si ça ressemble à un signalement véhicule.
  const issue = detectIssue(t);
  const mentioned = matchVehicle(text, fleet);
  if (!issue && !mentioned) return null; // simple discussion → silence

  const who = await apiBot('/whoami', { phone });
  if (!who.data || !who.data.found) {
    return `Bonjour 👋 Je ne reconnais pas ton numéro. Pour signaler un véhicule ici, ton numéro doit être enregistré dans l'application (fiche salarié) — vois avec la direction.`;
  }
  const w = { phone, firstName: who.data.firstName, userId: who.data.userId, vehicles: who.data.vehicles || [] };

  // Véhicule : mentionné > attribué (si unique).
  let vehicle = mentioned || (w.vehicles.length === 1 ? w.vehicles[0] : null);
  stt = { step: null, who: w, family: issue ? issue.family : null, needs: issue ? issue.needs : null, pos: null, vehicle, note: text.slice(0, 400) };
  groupState.set(key, stt);

  if (!issue) { stt.step = 'confirmVeh'; return `${w.firstName}, tu signales un souci sur le véhicule ${vLabel(vehicle)} ? Précise le problème (freins, pneus, amortisseur, batterie, vidange…).`; }
  if (!vehicle) { stt.step = 'askVeh'; return `${w.firstName}, de quel véhicule s'agit-il ? (numéro de parc ou immatriculation)`; }

  // On confirme d'abord le véhicule (comme demandé), puis la position si besoin.
  stt.step = 'confirmVeh';
  return `${w.firstName}, ton problème concerne le véhicule : ${vLabel(vehicle)} ? (oui / non)`;
}
function vLabel(v) { return v ? `*${v.plate || v.name}*${v.plate && v.name ? ' — ' + v.name : ''}` : '—'; }

// Après confirmation/choix du véhicule : demande la position si nécessaire, sinon finalise.
function afterVehicle(key, stt) {
  if (!stt.family) { stt.step = 'confirmVeh'; return `Ok pour ${vLabel(stt.vehicle)}. Quel est le problème ? (freins, pneus, amortisseur, batterie, vidange…)`; }
  if (stt.needs) {
    const pos = resolvePos(stt.needs, normalize(stt.note));
    if (!pos) { stt.step = 'askPos'; return stt.needs === 'fr' ? `C'est à l'avant ou à l'arrière ?` : `Côté gauche (AVG) ou droit (AVD) ?`; }
    stt.pos = pos;
  }
  return finalizeGroup(key, stt);
}
async function finalizeGroup(key, stt) {
  const label = stt.family ? issueLabel(stt.family, stt.pos) : null;
  const ok = await submitReport(stt.who, stt.vehicle, label, label ? '' : stt.note);
  groupState.delete(key);
  if (!ok) return `❌ Je n'ai pas pu enregistrer le signalement. Réessaie ou passe par l'application.`;
  return `✅ C'est noté ${stt.who.firstName} : ${vLabel(stt.vehicle)} — ${issueRecap(stt.family, stt.pos)}. L'atelier est prévenu. 🔧`;
}

// ===========================================================================
//  CONNEXION WHATSAPP (Baileys) + humanisation
// ===========================================================================
let sock = null;
const groupMeta = new Map(); // jid -> sujet du groupe

async function loadGroups() {
  try { const all = await sock.groupFetchAllParticipating(); for (const jid of Object.keys(all || {})) groupMeta.set(jid, (all[jid] && all[jid].subject) || ''); }
  catch (e) {}
}
function purposeOfSubject(s) {
  if (GROUP_KW.test(s || '')) return 'entretien';
  const n = String(s || '').toLowerCase();
  if (n.includes('ciblex')) return 'metier:ciblex';
  if (n.includes('gls')) return 'metier:gls';
  if (n.includes('fedex')) return 'metier:fedex';
  return 'other';
}
async function groupPurpose(jid) {
  let subj = groupMeta.get(jid);
  if (subj === undefined) { try { const meta = await sock.groupMetadata(jid); subj = (meta && meta.subject) || ''; } catch (e) { subj = ''; } groupMeta.set(jid, subj); }
  return purposeOfSubject(subj);
}
function findGroupJid(key) {
  const k = String(key || '').toLowerCase();
  for (const [jid, subj] of groupMeta) { if (String(subj).toLowerCase().includes(k)) return jid; }
  return null;
}

// Groupe métier (GLS/Ciblex/FedEx) : collecte des retours de tournée.
async function handleGroupMetier(phone, text) {
  if (!looksLikeTourReturn(text)) return null; // pas un retour de tournée → silence
  const parsed = parseTourReturn(text);
  if (!parsed) return `Pour enregistrer ton retour, réponds au format : *n° tournée / nb colis / nb points* (ex : 12 / 250 / 180).`;
  const r = await submitTourReturn(phone, parsed);
  if (r.ok && r.data && r.data.ok) return `✅ Merci ${r.data.firstName || ''}, retour enregistré : tournée ${parsed.tourNo || '—'} · ${parsed.parcels} colis · ${parsed.points} points.`;
  if (r.status === 404) return null; // numéro non reconnu → discret dans le groupe
  return `❌ Enregistrement impossible. Réessaie ou passe par l'application.`;
}

// Envoi « humain » : indicateur d'écriture + délai proportionnel au texte.
async function humanSend(jid, text) {
  const chunks = Array.isArray(text) ? text : [text];
  for (const c of chunks) {
    if (!c) continue;
    try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
    await sleep(Math.min(5000, rand(900, 1600) + String(c).length * rand(15, 30)));
    try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
    await sock.sendMessage(jid, { text: String(c) });
    await sleep(rand(300, 800));
  }
}

async function pollOutbox() {
  if (!sock) return;
  try {
    const r = await apiBot('/outbox');
    const msgs = (r.data && r.data.messages) || [];
    const done = [];
    for (const m of msgs) {
      try {
        if (m.group) { const jid = findGroupJid(m.group); if (!jid) continue; await humanSend(jid, m.text); done.push(m.id); }
        else if (m.phone) { await humanSend(m.phone + '@s.whatsapp.net', m.text); done.push(m.id); }
        await sleep(rand(1200, 2600));
      } catch (e) { /* on réessaie au prochain tour */ }
    }
    if (done.length) await apiBot('/outbox/ack', { ids: done });
  } catch (e) { /* app injoignable */ }
}

async function start() {
  await refreshFleet();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { version = undefined; }
  sock = makeWASocket({ auth: state, version, logger: P, printQRInTerminal: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { console.log('\n📲 Scannez ce QR code avec WhatsApp (Appareils connectés) :\n'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') { console.log('✅ Bot WhatsApp connecté.'); loadGroups(); }
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
        const text = msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '';
        if (!text) continue;
        const isGroup = jid.endsWith('@g.us');

        if (isGroup) {
          const purpose = await groupPurpose(jid);
          if (purpose === 'other') continue; // silencieux hors groupes configurés
          const part = msg.key.participant || '';
          if (!part.endsWith('@s.whatsapp.net')) continue; // participant masqué (@lid) : non résolvable
          const phone = part.split('@')[0].replace(/\D/g, '');
          let reply = null;
          if (purpose === 'entretien') reply = await handleGroupEntretien(jid, phone, (msg.pushName || '').trim(), text);
          else if (purpose.startsWith('metier')) reply = await handleGroupMetier(phone, text);
          if (reply) { try { await sock.readMessages([msg.key]); } catch (e) {} await humanSend(jid, reply); }
          continue;
        }

        if (!jid.endsWith('@s.whatsapp.net')) continue; // statuts / diffusions
        const phone = jid.split('@')[0].replace(/\D/g, '');
        try { await sock.readMessages([msg.key]); } catch (e) {}
        // Raccourci : un retour de tournée envoyé en privé est enregistré direct.
        if (looksLikeTourReturn(text)) {
          const parsed = parseTourReturn(text);
          if (parsed) {
            const rr = await submitTourReturn(phone, parsed);
            if (rr.ok && rr.data && rr.data.ok) { await humanSend(jid, `✅ Merci, retour de tournée enregistré : tournée ${parsed.tourNo || '—'} · ${parsed.parcels} colis · ${parsed.points} points.`); continue; }
          }
        }
        const reply = await handlePrivate(phone, text);
        await humanSend(jid, reply);
      } catch (e) { console.error('Traitement message:', e && e.message); }
    }
  });

  setInterval(pollOutbox, 9000);
  setInterval(refreshFleet, 5 * 60 * 1000);
  setInterval(loadGroups, 10 * 60 * 1000);
}

start().catch((e) => { console.error('Démarrage bot impossible:', e); process.exit(1); });
