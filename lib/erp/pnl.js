'use strict';

/**
 * Tableau de bord direction — calculs déterministes (compte de résultat
 * simplifié + trésorerie) à partir des données déjà présentes :
 *   - data.finance.entries  (recettes/charges saisies)
 *   - data.bankTx           (écritures bancaires importées)
 *   - data.settings.treasuryStartBalance
 *
 * Aucun LLM ne calcule jamais un montant : tout est de l'arithmétique.
 */

function r2(n) { return Math.round((n || 0) * 100) / 100; }

/** Compte de résultat agrégé pour un mois 'YYYY-MM' (ou tous si null). */
function computePnL(data, ym = null) {
  const entries = ((data.finance && data.finance.entries) || [])
    .filter((e) => !ym || e.ym === ym);

  let ca = 0, charges = 0;
  const chargesByCat = {};
  const caByClient = {};

  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.kind === 'recette' || e.kind === 'income' || amt > 0 && e.kind === undefined) {
      ca += Math.abs(amt);
      const cl = e.client || 'Divers';
      caByClient[cl] = (caByClient[cl] || 0) + Math.abs(amt);
    } else {
      charges += Math.abs(amt);
      const cat = e.category || 'Divers';
      chargesByCat[cat] = (chargesByCat[cat] || 0) + Math.abs(amt);
    }
  }

  const result = ca - charges;
  return {
    ym: ym || 'global',
    ca: r2(ca),
    charges: r2(charges),
    result: r2(result),
    marginPct: ca ? r2((result / ca) * 100) : 0,
    chargesByCat: sortedObj(chargesByCat),
    caByClient: sortedObj(caByClient),
  };
}

/** Résultat par client pour un mois donné (sert au moteur de règles). */
function marginByClient(data, ym) {
  const entries = ((data.finance && data.finance.entries) || []).filter((e) => e.ym === ym);
  const byClient = {};
  for (const e of entries) {
    const cl = e.client || 'Divers';
    const amt = Math.abs(Number(e.amount) || 0);
    const o = byClient[cl] || (byClient[cl] = { client: cl, ca: 0, charges: 0 });
    if (e.kind === 'recette' || e.kind === 'income') o.ca += amt;
    else o.charges += amt;
  }
  return Object.values(byClient).map((o) => ({ ...o, result: r2(o.ca - o.charges) }));
}

/** Trésorerie : solde de départ + somme des mouvements bancaires importés. */
function computeTreasury(data) {
  const start = Number((data.settings && data.settings.treasuryStartBalance) || 0);
  let movement = 0;
  for (const t of (data.bankTx || [])) {
    if (typeof t.amount === 'number') movement += t.amount;
    else movement += (Number(t.credit) || 0) - (Number(t.debit) || 0);
  }
  return { start: r2(start), movement: r2(movement), balance: r2(start + movement) };
}

function sortedObj(o) {
  return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: r2(v) }));
}

module.exports = { computePnL, marginByClient, computeTreasury };
