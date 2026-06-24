'use strict';

/**
 * Trésorerie prévisionnelle — déterministe.
 * Solde de départ (pnl.computeTreasury) + encaissements attendus (factures
 * envoyées non payées, à leur échéance) − décaissements récurrents.
 */

const pnl = require('./pnl');

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function iso(d) { return d.toISOString().slice(0, 10); }

function forecast(data, weeks = 8, now = new Date()) {
  const start = pnl.computeTreasury(data).balance;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Encaissements : factures 'sent' non payées projetées à leur dueDate.
  const inflows = ((data.erp && data.erp.invoices) || [])
    .filter((i) => i.status === 'sent' && i.dueDate)
    .map((i) => ({ date: i.dueDate, amount: Number(i.totalTTC) || 0, label: `Encaissement ${i.client} (${i.number})` }));

  // Décaissements récurrents : un par mois sur l'horizon, au jour dayOfMonth.
  const outflows = [];
  const horizonEnd = addDays(today, weeks * 7);
  for (const rec of ((data.erp && data.erp.recurring) || [])) {
    const amount = Number(rec.amount) || 0;
    if (!amount) continue;
    let cur = new Date(today.getFullYear(), today.getMonth(), 1);
    for (let k = 0; k < weeks / 4 + 2; k++) {
      const day = Math.min(Math.max(1, Number(rec.dayOfMonth) || 1), 28);
      const d = new Date(cur.getFullYear(), cur.getMonth(), day);
      if (d >= today && d <= horizonEnd) outflows.push({ date: iso(d), amount: -amount, label: rec.label || 'Charge récurrente' });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }

  const moves = inflows.concat(outflows).sort((a, b) => a.date.localeCompare(b.date));

  // Projection semaine par semaine.
  const buckets = [];
  let balance = start;
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(today, w * 7), we = addDays(today, (w + 1) * 7 - 1);
    const wsS = iso(ws), weS = iso(we);
    const wMoves = moves.filter((m) => m.date >= wsS && m.date <= weS);
    const inn = r2(wMoves.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0));
    const out = r2(wMoves.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0));
    balance = r2(balance + inn + out);
    buckets.push({ week: w + 1, from: wsS, to: weS, in: inn, out: out, balance, negative: balance < 0, moves: wMoves });
  }
  return { start: r2(start), weeks, buckets, lowestBalance: r2(Math.min(start, ...buckets.map((b) => b.balance))), anyNegative: buckets.some((b) => b.negative) };
}

module.exports = { forecast };
