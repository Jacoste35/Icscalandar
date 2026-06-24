'use strict';

/**
 * Facturation — 100 % déterministe. Un LLM ne calcule JAMAIS un total :
 * les montants sont de l'arithmétique pure, exacte et auditable.
 */

const { eid } = require('./index');

function r2(n) { return Math.round((n || 0) * 100) / 100; }

/**
 * Construit une facture à partir d'un contrat et de lignes saisies/calculées.
 * @param {object} data     base (pour le compteur de numérotation)
 * @param {object} params   { client, clientAddress, period, lines, vatRate, dueDays }
 *   lines: [{ designation, quantite, prixUnitaire }]
 */
function buildInvoice(data, params) {
  const vatRate = params.vatRate != null ? Number(params.vatRate)
    : Number((data.settings && data.settings.company && data.settings.company.vatRate) || 20);

  const lines = (params.lines || []).map((l) => {
    const quantite = Number(l.quantite) || 0;
    const prixUnitaire = Number(l.prixUnitaire) || 0;
    return { designation: l.designation || '', quantite, prixUnitaire, montantHT: r2(quantite * prixUnitaire) };
  });

  const totalHT = r2(lines.reduce((s, l) => s + l.montantHT, 0));
  const tva = r2(totalHT * vatRate / 100);
  const totalTTC = r2(totalHT + tva);

  data.erp.invoiceSeq = (data.erp.invoiceSeq || 0) + 1;
  const now = new Date();
  const number = `ICS-${now.getFullYear()}-${String(data.erp.invoiceSeq).padStart(4, '0')}`;
  const date = ymd(now);
  const dueDate = ymd(addDays(now, params.dueDays != null ? params.dueDays : 30));

  return {
    id: eid('inv'),
    number,
    date,
    dueDate,
    period: params.period || '',
    client: params.client || '',
    clientAddress: params.clientAddress || '',
    lines,
    vatRate,
    totalHT,
    tva,
    totalTTC,
    status: 'draft',           // draft -> sent -> paid
    createdAt: now.toISOString(),
  };
}

/** Facture imprimable (HTML -> PDF via l'impression du navigateur). */
function renderInvoiceHtml(inv, company) {
  const co = company || {};
  const rows = inv.lines.map((l) => `
    <tr>
      <td>${esc(l.designation)}</td>
      <td class="num">${l.quantite}</td>
      <td class="num">${euro(l.prixUnitaire)}</td>
      <td class="num">${euro(l.montantHT)}</td>
    </tr>`).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Facture ${esc(inv.number)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #1e293b; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; }
  .co { font-weight:700; font-size:16px; }
  .muted { color:#64748b; font-size:12px; }
  h1 { font-size:22px; margin:24px 0 4px; }
  .box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px; margin:8px 0; }
  table { width:100%; border-collapse:collapse; margin-top:16px; }
  th,td { padding:9px 10px; border-bottom:1px solid #e2e8f0; text-align:left; }
  th { background:#1e293b; color:#fff; font-size:12px; }
  .num { text-align:right; }
  .totals { margin-top:14px; margin-left:auto; width:280px; }
  .totals .row { display:flex; justify-content:space-between; padding:5px 0; }
  .totals .ttc { font-weight:700; font-size:16px; border-top:2px solid #1e293b; padding-top:8px; }
  .foot { margin-top:28px; font-size:11px; color:#64748b; }
  @media print { .noprint { display:none; } }
</style></head>
<body>
  <div class="head">
    <div>
      <div class="co">${esc(co.legal || co.name || 'INTER COLIS SERVICES')}</div>
      <div class="muted">${esc(co.address || '')}</div>
      ${co.siret ? `<div class="muted">SIRET ${esc(co.siret)}</div>` : ''}
      ${co.tva ? `<div class="muted">TVA ${esc(co.tva)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <h1>FACTURE</h1>
      <div class="muted">N° ${esc(inv.number)}</div>
      <div class="muted">Date : ${esc(inv.date)}</div>
      <div class="muted">Échéance : ${esc(inv.dueDate)}</div>
    </div>
  </div>

  <div class="box">
    <strong>Client</strong><br>${esc(inv.client)}<br>${esc(inv.clientAddress || '')}
    ${inv.period ? `<div class="muted">Période : ${esc(inv.period)}</div>` : ''}
  </div>

  <table>
    <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">P.U. HT</th><th class="num">Montant HT</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Total HT</span><span>${euro(inv.totalHT)}</span></div>
    <div class="row"><span>TVA ${inv.vatRate} %</span><span>${euro(inv.tva)}</span></div>
    <div class="row ttc"><span>Total TTC</span><span>${euro(inv.totalTTC)}</span></div>
  </div>

  <div class="foot">
    ${co.iban ? `Règlement par virement — IBAN ${esc(co.iban)}.<br>` : ''}
    En cas de retard de paiement : pénalités au taux légal + indemnité forfaitaire de recouvrement de 40 €.
  </div>

  <p class="noprint" style="margin-top:24px"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></p>
</body></html>`;
}

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function euro(n) { return (r2(n)).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { buildInvoice, renderInvoiceHtml };
