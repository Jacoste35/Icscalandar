'use strict';

/**
 * Barème des indemnités kilométriques — ÉDITABLE et déterministe.
 *
 * IMPORTANT : aucun montant officiel n'est gravé comme « vérité ». La table est
 * pré-remplie à titre indicatif puis modifiable depuis l'interface. Vérifiez
 * toujours le barème en vigueur sur impots.gouv.fr avant utilisation.
 *
 * Modèle (3 tranches kilométriques annuelles, par puissance fiscale) :
 *   km ≤ 5000            -> km * a
 *   5000 < km ≤ 20000    -> km * b + c (forfait)
 *   km > 20000           -> km * d
 */

const DEFAULT_IK_SCALE = {
  note: 'Barème indicatif — VÉRIFIEZ le barème en vigueur sur impots.gouv.fr avant tout usage.',
  brackets: [
    { cvMax: 3, a: 0.529, b: 0.316, c: 1065, d: 0.370 },
    { cvMax: 4, a: 0.606, b: 0.340, c: 1330, d: 0.407 },
    { cvMax: 5, a: 0.636, b: 0.357, c: 1395, d: 0.427 },
    { cvMax: 6, a: 0.665, b: 0.374, c: 1457, d: 0.447 },
    { cvMax: 99, a: 0.697, b: 0.394, c: 1515, d: 0.470 },
  ],
};

function computeIK(scale, cv, km) {
  km = Math.max(0, Number(km) || 0);
  cv = Number(cv) || 5;
  const brackets = (scale && scale.brackets) || DEFAULT_IK_SCALE.brackets;
  const b = brackets.find((x) => cv <= x.cvMax) || brackets[brackets.length - 1];
  if (!b) return 0;
  let amt;
  if (km <= 5000) amt = km * b.a;
  else if (km <= 20000) amt = km * b.b + b.c;
  else amt = km * b.d;
  return Math.round((amt || 0) * 100) / 100;
}

module.exports = { DEFAULT_IK_SCALE, computeIK };
