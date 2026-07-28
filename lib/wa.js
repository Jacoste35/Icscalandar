'use strict';

/**
 * File d'attente WhatsApp (bot non officiel hébergé sur le VPS).
 *
 * L'application n'envoie JAMAIS de message WhatsApp elle-même : elle dépose les
 * messages sortants dans `data.waOutbox`. Le processus « bot » (Baileys) les
 * relève via l'API interne (routes/bot.js), les envoie, puis les acquitte.
 * Ainsi un seul processus écrit la base (l'app) — le bot n'est qu'un client.
 */

// Numéro au format « chiffres uniquement, indicatif compris » (ex. 33612345678).
function normPhone(s) { return String(s || '').replace(/\D/g, ''); }
// 9 derniers chiffres (partie significative d'un mobile FR) — sert à rapprocher
// un numéro WhatsApp international (33 6…) du téléphone stocké en base (0 6…).
function last9(s) { return normPhone(s).slice(-9); }
// Deux numéros correspondent-ils (comparaison FR tolérante) ?
function samePhone(a, b) { const x = last9(a), y = last9(b); return !!x && x === y; }

// Dépose un message sortant pour un salarié (si son WhatsApp est lié et qu'il
// n'a pas désactivé le canal). Renvoie true si mis en file. Persistance via
// `save` (fire-and-forget), comme le module push.
function enqueue(data, save, userId, text) {
  const u = (data.users || []).find((x) => x.id === userId);
  if (!u || !u.whatsapp || !u.whatsapp.phone) return false;
  if (u.waNotifications === false) return false;
  data.waOutbox = data.waOutbox || [];
  data.waOutbox.push({
    id: 'wa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    phone: u.whatsapp.phone, userId,
    text: String(text || '').slice(0, 1500),
    createdAt: new Date().toISOString(), sentAt: null,
  });
  // Garde-fou mémoire : ne conserve que les 500 derniers messages.
  if (data.waOutbox.length > 500) data.waOutbox = data.waOutbox.slice(-500);
  if (typeof save === 'function') { try { Promise.resolve(save()).catch(() => {}); } catch (e) { /* best-effort */ } }
  return true;
}

// Dépose un message destiné à un GROUPE WhatsApp (identifié par un mot-clé de
// sujet, ex. 'fedex'). `mentionPhone` permet au bot de mentionner le chauffeur.
function enqueueGroup(data, save, groupKey, text, mentionPhone) {
  if (!groupKey) return false;
  data.waOutbox = data.waOutbox || [];
  data.waOutbox.push({
    id: 'wa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    group: String(groupKey), mentionPhone: mentionPhone ? normPhone(mentionPhone) : null,
    text: String(text || '').slice(0, 1500), createdAt: new Date().toISOString(), sentAt: null,
  });
  if (data.waOutbox.length > 500) data.waOutbox = data.waOutbox.slice(-500);
  if (typeof save === 'function') { try { Promise.resolve(save()).catch(() => {}); } catch (e) { /* best-effort */ } }
  return true;
}

module.exports = { normPhone, last9, samePhone, enqueue, enqueueGroup };
