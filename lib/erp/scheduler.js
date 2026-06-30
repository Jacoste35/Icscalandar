'use strict';

/**
 * Tâches planifiées — la seconde moitié de l'« auto-pilote ».
 * Le système agit seul à intervalles réguliers, sans aucune IA.
 *
 * node-cron est optionnel : s'il n'est pas installé, on se rabat sur setInterval
 * (l'application démarre normalement dans tous les cas).
 *
 * À n'activer que sur un serveur permanent (OVH/VPS/Render), pas en serverless.
 */

const pnl = require('./pnl');
const rules = require('./rules');

function start(deps) {
  const { getData, save } = deps;
  let cron = null;
  try { cron = require('node-cron'); } catch (e) { /* fallback ci-dessous */ }

  const tasks = [
    { name: 'digest-matin', cron: '0 7 * * *', fn: () => buildDigest(getData, save) },
    { name: 'recalc-nuit', cron: '0 2 * * *', fn: () => nightlyRecalc(getData, save) },
    { name: 'factures-mensuelles', cron: '0 6 1 * *', fn: () => monthlyDraftInvoices(getData, save) },
  ];

  if (cron) {
    for (const t of tasks) cron.schedule(t.cron, t.fn, { timezone: 'Europe/Paris' });
    console.log('ERP : tâches planifiées actives (node-cron) —', tasks.map((t) => t.name).join(', '));
  } else {
    // Fallback minimal : on construit le digest une fois par heure.
    setInterval(() => buildDigest(getData, save), 3600 * 1000);
    console.log('ERP : node-cron absent — digest horaire via setInterval. (npm i node-cron pour le planning complet.)');
  }

  // Suivi géolocalisation : interrogation PAJ toutes les 60 s (mouvement, excès
  // de vitesse, heure d'arrêt) — indépendant de node-cron, actif seulement si
  // la géolocalisation est configurée.
  setInterval(() => pollGeoloc(getData, save), 60 * 1000);
}

/** Interroge PAJ GPS et persiste l'état de suivi (si activé). */
async function pollGeoloc(getData, save) {
  try {
    const data = getData();
    require('./index').ensureErp(data);
    const g = data.settings.pajgps;
    if (!g || !g.enabled || !g.email || !g.passwordEnc) return;
    const r = await require('./pajgps').refreshAndTrack(data, { force: true });
    if (r.polled) await save();
  } catch (e) { console.error('Géoloc poll:', e.message); }
}

/** Snapshot des échéances du jour (alertes critiques/urgentes). */
async function buildDigest(getData, save) {
  try {
    const data = getData();
    require('./index').ensureErp(data);
    const alerts = rules.computeAlerts(data).filter((a) => a.level !== 'info');
    data.erp.digests.unshift({ date: new Date().toISOString().slice(0, 10), count: alerts.length, alerts });
    data.erp.digests = data.erp.digests.slice(0, 30);
    await save();
  } catch (e) { console.error('ERP digest:', e.message); }
}

async function nightlyRecalc(getData, save) {
  try {
    const data = getData();
    require('./index').ensureErp(data);
    // Maintenance des compteurs de congés (bascule annuelle au 1er juillet,
    // acquisitions +2,5 j/mois, RCC) — rejouée chaque nuit pour qu'elle prenne
    // effet le jour J sans attendre un redémarrage du serveur.
    try { require('../db').runLeaveMaintenance(data); } catch (e) { console.error('Maintenance congés:', e.message); }
    data.erp._lastRecalc = new Date().toISOString();
    await save();
  } catch (e) { console.error('ERP recalc:', e.message); }
}

/** Le 1er du mois : prépare des factures BROUILLON pour les contrats actifs. */
async function monthlyDraftInvoices(getData, save) {
  try {
    const data = getData();
    require('./index').ensureErp(data);
    const prev = new Date(); prev.setDate(0); // dernier jour du mois précédent
    const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    // Logique commune extraite dans closing.js (pas de duplication).
    const created = require('./closing').draftInvoicesForPeriod(data, period, true);
    await save();
    console.log('ERP : factures brouillon générées pour', period, `(${created.length})`);
  } catch (e) { console.error('ERP factures mensuelles:', e.message); }
}

module.exports = { start };
