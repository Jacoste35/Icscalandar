'use strict';

/**
 * Lecture des bulletins de salaire (PDF) pour pré-remplir les compteurs
 * (congés payés N / N-1, RCC, heures de récupération).
 *
 * Extraction « best-effort » : les bulletins varient selon le logiciel de paie,
 * donc les valeurs détectées sont des PROPOSITIONS, toujours relues et validées
 * par l'administrateur avant d'être appliquées aux comptes.
 *
 * Dépendance : pdf-parse (texte des PDF). Chargée paresseusement et protégée :
 * si elle est absente, l'onglet fonctionne quand même en saisie manuelle.
 */

let _pdf = null, _pdfTried = false;
function pdfLib() {
  if (_pdfTried) return _pdf;
  _pdfTried = true;
  try { _pdf = require('pdf-parse/lib/pdf-parse.js'); } catch (e) { try { _pdf = require('pdf-parse'); } catch (e2) { _pdf = null; } }
  return _pdf;
}

async function pdfToText(buffer) {
  const lib = pdfLib();
  if (!lib) throw new Error('Lecture PDF indisponible (pdf-parse non installé).');
  const res = await lib(buffer);
  return (res && res.text) || '';
}

/* ------------------------------------------------------------------ */
/* Normalisation & nombres                                             */
/* ------------------------------------------------------------------ */
function deaccent(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function norm(s) { return deaccent(s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// Convertit un jeton numérique FR ("1 234,5", "25,50", "10.5") en nombre.
function parseNum(tok) {
  let t = String(tok).replace(/\s/g, '');
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.'); // 1.234,5 -> 1234.5
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
// Dernier nombre d'une ligne (souvent la colonne « solde » à droite).
function lastNumber(line) {
  const m = String(line).match(/-?\d{1,3}(?:[ .]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g);
  if (!m || !m.length) return null;
  return parseNum(m[m.length - 1]);
}

/* ------------------------------------------------------------------ */
/* Rapprochement salarié                                               */
/* ------------------------------------------------------------------ */
function matchUser(text, users) {
  const t = norm(text);
  let best = null;
  for (const u of (users || [])) {
    const fn = norm(u.firstName), ln = norm(u.lastName);
    if (!fn && !ln) continue;
    const full1 = `${fn} ${ln}`.trim(), full2 = `${ln} ${fn}`.trim();
    let score = 0;
    if (full1 && t.indexOf(full1) !== -1) score = 3;
    else if (full2 && t.indexOf(full2) !== -1) score = 3;
    else if (ln && fn && t.indexOf(ln) !== -1 && t.indexOf(fn) !== -1) score = 2;
    if (score > (best ? best.score : 0)) best = { user: u, score };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Détection des compteurs ligne par ligne                            */
/* ------------------------------------------------------------------ */
function categoryOf(lineNorm) {
  const has = (re) => re.test(lineNorm);
  // RCC : repos compensateur / contrepartie obligatoire en repos.
  if (has(/\brcc\b/) || has(/repos compensateur/) || has(/contrepartie obligatoire/)) return 'rcc';
  // Heures de récupération / RCR / heures supplémentaires en repos.
  if (has(/\brcr\b/) || has(/recup/) || has(/repos de remplacement/) || (has(/heures? sup/) && has(/repos|recup|solde/))) return 'heuresSupp';
  // Congés payés (N-1 vs N).
  if (has(/cong/) || has(/\bcp\b/)) {
    if (has(/n\s*-\s*1/) || has(/anterieur/) || has(/precedent/) || has(/n-1/)) return 'congesN1';
    return 'congesN';
  }
  return null;
}

/**
 * Analyse le texte d'un bulletin : rapproche un salarié et propose des valeurs.
 * Retour : { matchedUserId, matchedUserName, confidence, values, found, lines }
 */
function extractFromText(text, users) {
  const rawLines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const m = matchUser(text, users);
  const values = {}; const found = {}; const lines = [];
  for (const line of rawLines) {
    const ln = norm(line);
    const cat = categoryOf(ln);
    if (!cat) continue;
    const n = lastNumber(line);
    if (n == null) continue;
    if (found[cat]) continue; // 1re ligne pertinente par catégorie
    values[cat] = n; found[cat] = true;
    lines.push(line.slice(0, 120));
  }
  const nbFound = Object.keys(found).length;
  const confidence = (m && m.score >= 3 ? 2 : m && m.score === 2 ? 1 : 0) + (nbFound >= 2 ? 1 : 0);
  return {
    matchedUserId: m ? m.user.id : null,
    matchedUserName: m ? `${m.user.firstName} ${m.user.lastName}` : '',
    confidence, // 0 faible … 3 élevé
    values, found, lines,
  };
}

module.exports = { pdfToText, extractFromText, parseNum };
