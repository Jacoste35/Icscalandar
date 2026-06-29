'use strict';

/**
 * Import des transactions carburant AS 24 (export Excel/CSV de FleetManager).
 * Lecture côté serveur via SheetJS (xlsx) ; normalisation des colonnes FR.
 * Chargé paresseusement et protégé : si xlsx est absent, l'import est désactivé
 * proprement (message clair) sans planter l'application.
 */

let _xlsx = null, _tried = false;
function xlsx() {
  if (_tried) return _xlsx;
  _tried = true;
  try { _xlsx = require('xlsx'); } catch (e) { _xlsx = null; }
  return _xlsx;
}

function num(x) { const n = Number(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; }
function pad2(x) { return String(x).padStart(2, '0'); }

// Convertit un numéro de série Excel en { ymd, time }.
function serialDate(v, X) {
  const n = Number(v);
  if (!Number.isFinite(n) || !n) return { ymd: '', time: '' };
  const d = X.SSF.parse_date_code(n);
  if (!d) return { ymd: '', time: '' };
  return { ymd: `${d.y}-${pad2(d.m)}-${pad2(d.d)}`, time: `${pad2(d.H)}:${pad2(d.M)}` };
}

const G = (r, keys) => { for (const k of keys) { if (r[k] !== undefined && r[k] !== '') return r[k]; } return ''; };

// Parse un classeur (buffer) et renvoie des transactions normalisées.
function parseWorkbook(buffer) {
  const X = xlsx();
  if (!X) throw new Error('Lecture Excel indisponible (module xlsx non installé).');
  const wb = X.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Aucune feuille trouvée dans le fichier.');
  const rows = X.utils.sheet_to_json(ws, { defval: '' });
  return rows.map((r) => {
    const dt = serialDate(G(r, ['Date/Heure transaction', 'Date transaction', 'Date']), X);
    const inv = serialDate(G(r, ['Date de facturation']), X);
    return {
      txnId: String(G(r, ['N° de transaction', 'N°de transaction', 'N° transaction'])).trim(),
      date: dt.ymd, time: dt.time,
      state: String(G(r, ['Etat', 'État'])).trim(),
      card: String(G(r, ['N°support', 'N° support', 'Support'])).trim(),
      product: String(G(r, ['Produit'])).trim(),
      place: String(G(r, ['Lieu', 'Station'])).trim(),
      country: String(G(r, ['Pays'])).trim(),
      vehicleName: String(G(r, ['Véhicule'])).trim(),
      km: num(G(r, ['Kilométrage'])),
      driver: String(G(r, ['Chauffeur'])).trim(),
      ref: String(G(r, ['Référence personnelle'])).trim(),
      liters: num(G(r, ['Quantité'])),
      unit: String(G(r, ['Unité'])).trim(),
      amountHT: num(G(r, ['Montant HT en devise de règlement', 'Montant HT en devise locale', 'Montant HT'])),
      amountTTC: num(G(r, ['Montant TTC en devise de règlement', 'Montant TTC en devise locale', 'Montant TTC'])),
      tva: num(G(r, ['Montant TVA transaction', 'Montant TVA'])),
      invoice: String(G(r, ['N°de facture', 'N° de facture'])).trim(),
      invoiceDate: inv.ymd,
    };
  }).filter((r) => r.txnId);
}

module.exports = { parseWorkbook, available: () => !!xlsx() };
