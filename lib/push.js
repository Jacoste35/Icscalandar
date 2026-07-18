'use strict';

/**
 * Notifications « push » (Web Push + VAPID) — sans service tiers.
 *
 * La librairie web-push est chargée paresseusement : si elle n'est pas installée,
 * tout le module se met en veille (aucune erreur, l'app fonctionne sans push).
 *
 * Clés VAPID :
 *   • si VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY sont définis dans l'environnement,
 *     on les utilise (recommandé en production) ;
 *   • sinon, on génère une paire UNE FOIS et on la persiste dans settings.push
 *     (la clé privée reste sur le serveur ; la base peut être chiffrée au repos).
 */

let _wp = null, _tried = false;
function lib() {
  if (_tried) return _wp;
  _tried = true;
  try { _wp = require('web-push'); } catch (e) { _wp = null; }
  return _wp;
}

// Prépare web-push avec les clés VAPID (génère/persiste si besoin). Renvoie
// { wp, publicKey } ou null si indisponible.
function ensureConfig(data) {
  const wp = lib();
  if (!wp) return null;
  data.settings = data.settings || {};
  data.settings.push = data.settings.push || {};
  let pub = process.env.VAPID_PUBLIC_KEY || '';
  let priv = process.env.VAPID_PRIVATE_KEY || '';
  if (!pub || !priv) {
    if (!data.settings.push.publicKey || !data.settings.push.privateKey) {
      try {
        const k = wp.generateVAPIDKeys();
        data.settings.push.publicKey = k.publicKey;
        data.settings.push.privateKey = k.privateKey;
        data.settings.push.generated = true;
      } catch (e) { return null; }
    }
    pub = data.settings.push.publicKey;
    priv = data.settings.push.privateKey;
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@inter-colis-services.fr';
  try { wp.setVapidDetails(subject, pub, priv); } catch (e) { return null; }
  return { wp, publicKey: pub };
}

// Config publique exposée au client (clé publique seulement).
function publicConfig(data) {
  const c = ensureConfig(data);
  return { enabled: !!c, publicKey: c ? c.publicKey : null };
}

// Enregistre un abonnement pour un salarié (dédoublonné par endpoint).
function addSubscription(user, sub, ua) {
  if (!user || !sub || !sub.endpoint) return false;
  user.pushSubs = Array.isArray(user.pushSubs) ? user.pushSubs : [];
  user.pushSubs = user.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
  user.pushSubs.push({ endpoint: sub.endpoint, keys: sub.keys || {}, ua: String(ua || '').slice(0, 200), addedAt: new Date().toISOString() });
  return true;
}
function removeSubscription(user, endpoint) {
  if (!user || !Array.isArray(user.pushSubs)) return false;
  const before = user.pushSubs.length;
  user.pushSubs = user.pushSubs.filter((s) => s.endpoint !== endpoint);
  return user.pushSubs.length !== before;
}

// Envoie une notification à TOUS les appareils d'un salarié. Les abonnements
// périmés (404/410) sont supprimés puis la base est enregistrée. Tolérant aux
// erreurs (jamais d'exception remontée à l'appelant).
async function notifyUser(data, save, userId, payload) {
  const c = ensureConfig(data);
  if (!c) return;
  const u = (data.users || []).find((x) => x.id === userId);
  if (!u || !Array.isArray(u.pushSubs) || !u.pushSubs.length) return;
  const body = JSON.stringify(payload || {});
  const dead = [];
  await Promise.all(u.pushSubs.map((s) => c.wp.sendNotification(s, body).catch((err) => {
    const code = err && err.statusCode;
    if (code === 404 || code === 410) dead.push(s.endpoint);
  })));
  if (dead.length) {
    u.pushSubs = u.pushSubs.filter((s) => !dead.includes(s.endpoint));
    try { await save(); } catch (e) { /* best-effort */ }
  }
}

async function notifyUsers(data, save, userIds, payload) {
  for (const id of new Set(userIds || [])) {
    // eslint-disable-next-line no-await-in-loop
    await notifyUser(data, save, id, payload);
  }
}

// Identifiants des administrateurs (pour les alertes d'encadrement).
function adminIds(data) {
  return (data.users || []).filter((u) => u.role === 'admin' && u.status !== 'deleted').map((u) => u.id);
}
function staffIds(data) {
  return (data.users || []).filter((u) => (u.role === 'admin' || u.role === 'responsable') && u.status !== 'deleted').map((u) => u.id);
}
// Atelier : administrateurs + mécaniciens (destinataires des ordres de réparation).
function mechanicIds(data) {
  return (data.users || []).filter((u) => (u.role === 'admin' || u.mecano) && u.status !== 'deleted').map((u) => u.id);
}

// Déclenche en arrière-plan sans bloquer la réponse HTTP.
function fire(promise) { Promise.resolve(promise).catch(() => {}); }

module.exports = {
  publicConfig, ensureConfig, addSubscription, removeSubscription,
  notifyUser, notifyUsers, adminIds, staffIds, mechanicIds, fire,
};
