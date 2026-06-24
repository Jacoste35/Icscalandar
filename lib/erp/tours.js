'use strict';

/**
 * Retour de tournée — rentabilité réelle, 100 % déterministe.
 * Aucun montant n'est inventé : tout est de l'arithmétique sur les paramètres
 * déjà saisis (contrats, tenderParams).
 */

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function ymOf(s) { return String(s || '').slice(0, 7); }

/** Estime un tarif au point par défaut depuis les paramètres d'appel d'offre. */
function defaultPricePerPoint(tp) {
  if (!tp) return 0;
  // Coût direct journalier / points par jour, majoré de la marge cible.
  const daily = (Number(tp.driverCost) || 0) / (Number(tp.daysPerMonth) || 21)
    + (Number(tp.vehicleCost) || 0) / (Number(tp.daysPerMonth) || 21)
    + (Number(tp.kmPerDay) || 0) * (Number(tp.consumption) || 0) / 100 * (Number(tp.fuelPrice) || 0);
  const pts = Number(tp.pointsPerDay) || 0;
  if (!pts) return 0;
  const cost = daily / pts;
  return r2(cost * (1 + (Number(tp.marginPct) || 0) / 100));
}

/** Calcul d'une tournée : recette, coûts, marge. */
function computeTour(data, t) {
  const tp = (data.settings && data.settings.tenderParams) || {};
  const contract = (data.contracts || []).find((c) => c.id === t.contractId) || null;
  const km = Math.max(0, (Number(t.kmEnd) || 0) - (Number(t.kmStart) || 0));
  const tarifPoint = contract && contract.pricePerPoint != null ? Number(contract.pricePerPoint) : defaultPricePerPoint(tp);
  const tarifRamassage = contract && contract.pricePerPickup != null ? Number(contract.pricePerPickup) : 0;

  const recette = r2((Number(t.pointsDelivered) || 0) * tarifPoint + (Number(t.pickups) || 0) * tarifRamassage);
  const days = Number(tp.daysPerMonth) || 21;
  const coutChauffeur = r2((Number(tp.driverCost) || 0) / days);
  const litres = (Number(t.fuelLiters) || 0) > 0 ? Number(t.fuelLiters) : km * (Number(tp.consumption) || 0) / 100;
  const coutCarburant = r2(litres * (Number(tp.fuelPrice) || 0));
  const coutVehicule = r2((Number(tp.vehicleCost) || 0) / days);
  const coutTotal = r2(coutChauffeur + coutCarburant + coutVehicule);
  const marge = r2(recette - coutTotal);
  const pointsPlanned = Number(t.pointsPlanned) || 0;
  const tauxEchec = pointsPlanned ? r2((Number(t.pointsFailed) || 0) / pointsPlanned) : 0;

  // Points/heure si une amplitude est connue (workHours du jour).
  let ptsParHeure = null;
  const wh = (data.workHours || []).find((h) => h.userId === t.userId && h.date === t.date);
  const amp = wh ? (Number(wh.amplitude) || Number(wh.worked) || 0) : 0;
  if (amp > 0) ptsParHeure = r2((Number(t.pointsDelivered) || 0) / amp);

  const clientName = contract ? (contract.client || contract.name || 'Client') : 'Divers';
  return { km, tarifPoint: r2(tarifPoint), recette, coutChauffeur, coutCarburant, coutVehicule, coutTotal, marge, tauxEchec, ptsParHeure, clientName };
}

/** Agrégats sur une période (ym ou from/to) + classements. */
function analytics(data, opts = {}) {
  const ym = opts.ym || null;
  const from = opts.from || null, to = opts.to || null;
  const tours = (data.tours || []).filter((t) => {
    if (ym && ymOf(t.date) !== ym) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    return true;
  });

  const rows = tours.map((t) => ({ ...t, calc: computeTour(data, t) }));
  const sum = (key) => r2(rows.reduce((s, r) => s + (r.calc[key] || 0), 0));

  const groupBy = (fn) => {
    const m = {};
    rows.forEach((r) => {
      const k = fn(r) || '—';
      const o = m[k] || (m[k] = { key: k, recette: 0, coutTotal: 0, marge: 0, tours: 0, points: 0 });
      o.recette += r.calc.recette; o.coutTotal += r.calc.coutTotal; o.marge += r.calc.marge; o.tours += 1; o.points += Number(r.pointsDelivered) || 0;
    });
    return Object.values(m).map((o) => ({ ...o, recette: r2(o.recette), coutTotal: r2(o.coutTotal), marge: r2(o.marge) })).sort((a, b) => a.marge - b.marge);
  };

  return {
    ym: ym || (from || to ? `${from || ''}→${to || ''}` : 'global'),
    count: rows.length,
    totals: { recette: sum('recette'), coutTotal: sum('coutTotal'), marge: sum('marge') },
    byDay: groupBy((r) => r.date),
    byDriver: groupBy((r) => r.userName || r.userId),
    byVehicle: groupBy((r) => r.vehicleId || '—'),
    byClient: groupBy((r) => r.calc.clientName),
    deficits: rows.filter((r) => r.calc.marge < 0).map((r) => ({ id: r.id, date: r.date, userName: r.userName, client: r.calc.clientName, marge: r.calc.marge })).sort((a, b) => a.marge - b.marge),
    rows: rows.map((r) => ({ id: r.id, date: r.date, userName: r.userName, vehicleId: r.vehicleId, client: r.calc.clientName, km: r.calc.km, points: Number(r.pointsDelivered) || 0, recette: r.calc.recette, coutTotal: r.calc.coutTotal, marge: r.calc.marge, tauxEchec: r.calc.tauxEchec, ptsParHeure: r.calc.ptsParHeure })),
  };
}

/** Marge cumulée par client sur les N derniers jours (pour le moteur de règles). */
function marginByClientWindow(data, now, days) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fromD = new Date(to); fromD.setDate(fromD.getDate() - days);
  const fromS = fromD.toISOString().slice(0, 10);
  const m = {};
  for (const t of (data.tours || [])) {
    if (!t.date || t.date < fromS) continue;
    const c = computeTour(data, t);
    const o = m[c.clientName] || (m[c.clientName] = { client: c.clientName, marge: 0 });
    o.marge += c.marge;
  }
  return Object.values(m).map((o) => ({ ...o, marge: r2(o.marge) }));
}

/** Taux d'échec moyen par chauffeur sur N derniers jours. */
function failRateByDriverWindow(data, now, days) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fromD = new Date(to); fromD.setDate(fromD.getDate() - days);
  const fromS = fromD.toISOString().slice(0, 10);
  const m = {};
  for (const t of (data.tours || [])) {
    if (!t.date || t.date < fromS) continue;
    const o = m[t.userId] || (m[t.userId] = { userId: t.userId, userName: t.userName, planned: 0, failed: 0 });
    o.planned += Number(t.pointsPlanned) || 0; o.failed += Number(t.pointsFailed) || 0;
  }
  return Object.values(m).map((o) => ({ ...o, rate: o.planned ? r2(o.failed / o.planned) : 0 }));
}

module.exports = { analytics, computeTour, defaultPricePerPoint, marginByClientWindow, failRateByDriverWindow };
