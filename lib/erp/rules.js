'use strict';

/**
 * Moteur de règles — cœur de l'« auto-pilotage » déterministe.
 *
 * Prend l'état complet de la base et renvoie une liste d'alertes/actions
 * suggérées. AUCUNE IA : ce sont des « si… alors… » encodés, donc fiables,
 * gratuits, instantanés et auditables.
 *
 * Chaque règle est défensive (champs optionnels protégés) : si une donnée
 * n'existe pas encore dans la base, la règle est simplement ignorée.
 */

function daysBetween(fromISO, toDate) {
  const a = new Date(fromISO + (fromISO.length <= 10 ? 'T00:00:00Z' : ''));
  if (isNaN(a)) return null;
  return Math.round((a - toDate) / 86400000);
}

function alert(level, category, title, detail, extra = {}) {
  return { level, category, title, detail, ...extra };
}

/**
 * @param {object} data  base complète (getData())
 * @param {Date}   now   date de référence (par défaut maintenant)
 * @param {object} opts  seuils paramétrables
 */
function computeAlerts(data, now = new Date(), opts = {}) {
  const out = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const soonDays = opts.soonDays || 30;       // fenêtre d'anticipation (jours)
  const sanctionWindow = opts.sanctionWindow || 365;
  const sanctionThreshold = opts.sanctionThreshold || 3;

  // 1) Conformité véhicule : contrôle technique (forme v.ct = {nextDate,level,nextType})
  for (const v of (data.vehicles || [])) {
    try {
      if (v.active === false) continue;
      if (v.ct && v.ct.nextDate) {
        const d = daysBetween(v.ct.nextDate, today);
        if (d === null) continue;
        if (d < 0) out.push(alert('critique', 'Conformité', `CT dépassé — ${v.name}`,
          `Contrôle technique du ${v.plate || v.name} expiré depuis ${-d} j.`, { ref: { type: 'vehicle', id: v.id } }));
        else if (d <= soonDays) out.push(alert('urgent', 'Conformité', `CT à prévoir — ${v.name}`,
          `Contrôle technique du ${v.plate || v.name} dans ${d} j (le ${v.ct.nextDate}).`, { ref: { type: 'vehicle', id: v.id } }));
      }
    } catch (e) { /* règle ignorée */ }
  }

  // 2) Conformité documentaire (data.compliance) : permis, visite médicale,
  //    assurance, licence LTI… avec date d'échéance.
  for (const c of (data.compliance || [])) {
    try {
      if (!c.expiry) continue;
      const d = daysBetween(c.expiry, today);
      if (d === null) continue;
      const who = labelForCompliance(data, c);
      if (d < 0) out.push(alert('critique', 'Conformité', `${c.label} expiré — ${who}`,
        `${c.label} (${who}) expiré depuis ${-d} j.`, { ref: { type: 'compliance', id: c.id } }));
      else if (d <= soonDays) out.push(alert('urgent', 'Conformité', `${c.label} à renouveler — ${who}`,
        `${c.label} (${who}) expire dans ${d} j (le ${c.expiry}).`, { ref: { type: 'compliance', id: c.id } }));
    } catch (e) { /* ignore */ }
  }

  // 3) RH / discipline : escalade si N sanctions sur 12 mois glissants.
  try {
    const byUser = {};
    for (const s of (data.sanctions || [])) {
      const d = s.date ? daysBetween(s.date, today) : null;
      if (d === null || d > sanctionWindow) continue;
      (byUser[s.userId] = byUser[s.userId] || []).push(s);
    }
    for (const uid of Object.keys(byUser)) {
      const list = byUser[uid];
      if (list.length >= sanctionThreshold) {
        const u = (data.users || []).find((x) => x.id === uid);
        const name = u ? `${u.firstName} ${u.lastName}` : (list[0].userName || uid);
        out.push(alert('urgent', 'RH', `Escalade disciplinaire — ${name}`,
          `${list.length} sanctions sur 12 mois. Procédure renforcée à envisager.`,
          { ref: { type: 'user', id: uid }, action: 'document', actionType: 'avertissement' }));
      }
    }
  } catch (e) { /* ignore */ }

  // 4) Finance : facture en retard de paiement (échéance dépassée, non payée).
  for (const inv of ((data.erp && data.erp.invoices) || [])) {
    try {
      if (inv.status === 'paid' || inv.status === 'draft') continue;
      if (!inv.dueDate) continue;
      const d = daysBetween(inv.dueDate, today);
      if (d !== null && d < 0) out.push(alert(d < -30 ? 'critique' : 'urgent', 'Finance',
        `Impayé — ${inv.client}`,
        `Facture ${inv.number} (${money(inv.totalTTC)}) échue depuis ${-d} j.`,
        { ref: { type: 'invoice', id: inv.id }, action: 'document', actionType: 'relance' }));
    } catch (e) { /* ignore */ }
  }

  // 5) Finance : marge mensuelle négative par client (depuis finance.entries).
  try {
    const pnl = require('./pnl').marginByClient(data, ymOf(today));
    for (const row of pnl) {
      // On ne signale que les vrais donneurs d'ordre (CA réel), pas les
      // charges générales regroupées sous « Divers ».
      if (row.client !== 'Divers' && row.ca > 0 && row.result < 0) out.push(alert('urgent', 'Finance', `Marge négative — ${row.client}`,
        `Résultat ${money(row.result)} sur ${ymOf(today)} (CA ${money(row.ca)} / charges ${money(row.charges)}).`,
        { ref: { type: 'client', id: row.client } }));
    }
  } catch (e) { /* ignore */ }

  // Tri : critique > urgent > info
  const rank = { critique: 0, urgent: 1, info: 2 };
  out.sort((a, b) => (rank[a.level] - rank[b.level]));
  return out;
}

function labelForCompliance(data, c) {
  if (c.scope === 'vehicle') {
    const v = (data.vehicles || []).find((x) => x.id === c.refId);
    return v ? (v.plate || v.name) : 'véhicule';
  }
  if (c.scope === 'user') {
    const u = (data.users || []).find((x) => x.id === c.refId);
    return u ? `${u.firstName} ${u.lastName}` : 'salarié';
  }
  return 'société';
}

function ymOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function money(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }

module.exports = { computeAlerts };
