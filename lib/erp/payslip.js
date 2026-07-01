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

// Texte AVEC coordonnées (pour lire les tableaux/grilles que l'aplatissement
// du texte mélange). Renvoie un tableau de pages = [{ s, x, y }].
async function pdfToItems(buffer) {
  const lib = pdfLib();
  if (!lib) throw new Error('Lecture PDF indisponible (pdf-parse non installé).');
  const pages = [];
  await lib(buffer, {
    pagerender: (pd) => pd.getTextContent().then((tc) => {
      pages.push(tc.items.map((it) => ({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) })));
      return '';
    }),
  });
  return pages;
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

// Rapprochement direct par nom/prénom de l'en-tête machine du bulletin.
function matchByName(last, first, users) {
  const nl = norm(last), nf = norm(first);
  // Rapprochement STRICT : nom ET prénom doivent correspondre (sinon on laisse
  // l'admin associer — évite de confondre deux salariés de même nom de famille).
  for (const u of (users || [])) {
    const ul = norm(u.lastName), uf = norm(u.firstName);
    if (!ul || ul !== nl) continue;
    if (uf === nf || (nf && uf.indexOf(nf) === 0) || (uf && nf.indexOf(uf) === 0)) return { user: u, score: 3 };
  }
  return null;
}

// Extrait l'adresse postale du salarié (bloc destinataire à droite de l'en-tête).
// La ligne « civilité Prénom NOM » sert d'ancre ; on collecte les lignes situées
// juste en dessous, dans la même colonne (x), jusqu'au code postal + ville.
function extractAddress(p, last, first) {
  const nl = norm(last), nf = norm(first);
  if (!nl) return '';
  const isName = (it) => { const s = norm(it.s); return s.indexOf(nl) >= 0 && (!nf || s.indexOf(nf) >= 0); };
  const nameItem = p.find((it) => isName(it) && /monsieur|madame|mademoiselle/.test(norm(it.s))) || p.find(isName);
  if (!nameItem) return '';
  const cx = nameItem.x, cy = nameItem.y;
  const cand = p.filter((it) => Math.abs(it.x - cx) <= 40 && it.y < cy && it.y > cy - 70 && it.s.trim() && it.s.indexOf(':') < 0 && it.s.indexOf('##') < 0)
    .sort((a, b) => b.y - a.y);
  const addr = [];
  for (const it of cand) {
    const l = it.s.trim();
    addr.push(l);
    if (/\b\d{5}\b/.test(l)) break; // code postal + ville → fin du bloc adresse
  }
  return addr.join(', ');
}

/**
 * Lecture d'un PDF contenant PLUSIEURS bulletins (un par salarié, séparés par
 * un en-tête machine « …##BULLETIN##période##matricule##NOM##Prénom##siret »).
 * Lit la grille des soldes (Congés N-1 / Congés N / Repos C) par coordonnées.
 * Renvoie un tableau de propositions, une par bulletin.
 */
function extractMany(pages, users) {
  const out = [];
  for (const p of (pages || [])) {
    const full = p.map((i) => i.s).join('\n');
    const h = full.match(/##BULLETIN##([\d-]+)##(\d+)##([^#\n]+)##([^#\n]+)##/);
    if (!h) continue;
    const period = h[1], matricule = h[2], last = h[3].trim(), first = h[4].trim();
    // Colonnes de la grille des congés (x de chaque en-tête).
    let xN1 = null, xN = null, xRC = null;
    p.forEach((it) => { const s = it.s.trim(); if (s.indexOf('Congés N-1') >= 0) xN1 = it.x; else if (s === 'Congés N') xN = it.x; else if (s.indexOf('Repos C') >= 0) xRC = it.x; });
    // Lignes Acquis / Pris / Solde (y de chaque libellé).
    let yS = null;
    p.forEach((it) => { if (it.s.trim() === 'Solde') yS = it.y; });
    const cols = [['congesN1', xN1], ['congesN', xN], ['rcc', xRC]].filter((c) => c[1] != null);
    const rowVals = (ry) => {
      const r = {};
      if (ry == null) return r;
      p.filter((it) => /^-?\d+([.,]\d+)?$/.test(it.s.trim()) && Math.abs(it.y - ry) <= 3).forEach((it) => {
        let best = null, bd = 99;
        cols.forEach(([k, cx]) => { const d = it.x - cx; if (d >= 8 && d <= 45 && d < bd) { bd = d; best = k; } });
        if (best && r[best] == null) r[best] = parseNum(it.s);
      });
      return r;
    };
    const solde = rowVals(yS);
    const values = {}, found = {};
    ['congesN', 'congesN1', 'rcc'].forEach((k) => { if (solde[k] != null) { values[k] = solde[k]; found[k] = true; } });
    const address = extractAddress(p, last, first);
    const m = matchByName(last, first, users) || matchUser(full, users);
    const nbFound = Object.keys(found).length;
    out.push({
      fileName: `${last} ${first} — ${period}`,
      matricule, period, address,
      matchedUserId: m ? m.user.id : null,
      matchedUserName: m ? `${m.user.firstName} ${m.user.lastName}` : '',
      confidence: (m ? (m.score >= 3 ? 2 : 1) : 0) + (nbFound >= 1 ? 1 : 0),
      values, found,
      lines: [`Soldes lus — Congés N-1 : ${solde.congesN1 != null ? solde.congesN1 : '—'} · Congés N : ${solde.congesN != null ? solde.congesN : '—'} · Repos C : ${solde.rcc != null ? solde.rcc : '—'}`],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Absences datées + éléments de paie (heures sup., nuit, repas)       */
/* ------------------------------------------------------------------ */
// Convertit une date « JJMMAA » (ex. 190526) en ISO 2026-05-19.
function ddmmyyToISO(s) {
  const m = String(s || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const dd = m[1], mm = m[2], yy = m[3];
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

// Analyse une ligne « Absence … » d'un bulletin : renvoie { raw, motif, startDate, endDate }
// ou null si la ligne ne contient pas de date exploitable (ex. « Absence complète »).
function parseAbsenceLine(line) {
  const raw = String(line).trim();
  const dm = raw.match(/(\d{6})(?:\s*-\s*(\d{6}))?/);
  if (!dm) return null; // pas de date → ligne structurelle (Absence complète, entrée/sortie…)
  const startDate = ddmmyyToISO(dm[1]);
  const endDate = dm[2] ? ddmmyyToISO(dm[2]) : startDate;
  if (!startDate) return null;
  // Motif : après « : » s'il existe, sinon entre « Absence » et la date.
  let motif = '';
  const colon = raw.indexOf(':');
  if (colon >= 0) motif = raw.slice(colon + 1);
  else motif = raw.slice(0, dm.index).replace(/^absence\b/i, '');
  // On retire les valeurs numériques résiduelles et la ponctuation.
  motif = motif.replace(/[-–]?\s*\d[\d .,]*$/, '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
  if (!motif) motif = 'absence';
  return { raw: raw.slice(0, 140), motif, startDate, endDate: endDate >= startDate ? endDate : startDate };
}

// Propose un code de motif du site à partir du libellé lu, en tenant compte du
// dictionnaire d'auto-apprentissage (mappings confirmés par l'administrateur).
function suggestCategory(motif, categories, learning) {
  const key = norm(motif);
  if (!key) return null;
  if (learning && learning[key]) return learning[key];        // appris précédemment
  const codes = new Set((categories || []).map((c) => c.code));
  const rules = [
    [/recup|repos de remplacement|\brcr\b/, 'RCP'],
    [/repos compensateur|contrepartie oblig|\brcc\b/, 'RCC'],
    [/accident.*trajet|accident.*travail|\baccident\b/, 'AT'],
    [/maladie non prof|mal.*non prof|mal.*profession/, 'MNP'],
    [/maladie|arret maladie|maladie ordinaire/, 'AM'],
    [/maternite|paternite/, 'PMT'],
    [/familial|evenement famil|deces|mariage|naissance/, 'AEF'],
    [/parental/, 'CPA'],
    [/sans solde/, 'CSS'],
    [/mise a pied/, 'MAP'],
    [/injustifi/, 'ABS'],
    [/non remuneree.*autoris|autorisee/, 'ANRA'],
    [/non remuneree/, 'ANRN'],
    [/remuneree|remunere/, 'AR'],
    [/conge paye|conges payes|\bcp\b/, 'CP'],
  ];
  for (const [re, code] of rules) { if (re.test(key) && codes.has(code)) return code; }
  return null;
}

// Découpe le texte plat d'un PDF multi-bulletins en blocs (un par salarié).
function splitBulletins(text) {
  const lines = String(text || '').split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    const h = l.match(/##BULLETIN##([\d-]+)##(\d+)##([^#\n]+)##([^#\n]+)##/);
    if (h) heads.push({ i, period: h[1], matricule: h[2], last: h[3].trim(), first: h[4].trim() });
  });
  return heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    return Object.assign({}, h, { block: lines.slice(h.i, end).join('\n') });
  });
}

// Extrait d'un bloc-bulletin : absences datées + éléments de paie à importer.
function parseBulletinElements(block, categories, learning) {
  const lines = String(block || '').split(/\r?\n/);
  const absences = [];
  let hsup25 = null, nightHours = null, mealCount = null, mealAmount = null;
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    if (/^absence\b/i.test(line)) {
      const a = parseAbsenceLine(line);
      if (a) { a.suggested = suggestCategory(a.motif, categories, learning); absences.push(a); }
      continue;
    }
    // Les colonnes du bulletin sont collées (« 15.0015.21542… ») : le 1er nombre
    // à 2 décimales après le libellé = la quantité (heures / nombre de paniers).
    let m;
    if ((m = line.match(/heures?\s+suppl[ée]mentaires?\s*25\s*%\s*(\d{1,3}[.,]\d{2})/i))) hsup25 = parseNum(m[1]);
    else if ((m = line.match(/majoration\s+heures?\s+de\s+nuit\s*(\d{1,3}[.,]\d{2})/i))) nightHours = parseNum(m[1]);
    else if ((m = line.match(/indemnit[ée]\s+de\s+repas\s*(\d{1,3}[.,]\d{2})(\d{1,3}[.,]\d{2})/i))) {
      mealCount = parseNum(m[1]);
      const unit = parseNum(m[2]);
      mealAmount = (mealCount != null && unit != null) ? Math.round(mealCount * unit * 100) / 100 : null;
    }
  }
  return { absences, hsup25, nightHours, mealCount, mealAmount };
}

module.exports = {
  pdfToText, pdfToItems, extractFromText, extractMany, extractAddress, parseNum,
  ddmmyyToISO, parseAbsenceLine, suggestCategory, splitBulletins, parseBulletinElements,
};
