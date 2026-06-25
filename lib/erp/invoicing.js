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

  // Facture d'avoir : montants négatifs, numérotation préfixée « AV- ».
  const isAvoir = params.kind === 'avoir';
  const sign = isAvoir ? -1 : 1;

  const lines = (params.lines || []).map((l) => {
    const quantite = Number(l.quantite) || 0;
    const prixUnitaire = Math.abs(Number(l.prixUnitaire) || 0) * sign;
    return { designation: l.designation || '', quantite, prixUnitaire, montantHT: r2(quantite * prixUnitaire) };
  });

  const totalHT = r2(lines.reduce((s, l) => s + l.montantHT, 0));
  const tva = r2(totalHT * vatRate / 100);
  const totalTTC = r2(totalHT + tva);

  data.erp.invoiceSeq = (data.erp.invoiceSeq || 0) + 1;
  const now = new Date();
  const number = `${isAvoir ? 'AV' : 'ICS'}-${now.getFullYear()}-${String(data.erp.invoiceSeq).padStart(4, '0')}`;
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
    mentions: Array.isArray(params.mentions) ? params.mentions.map((m) => String(m)).filter(Boolean) : [],
    lines,
    vatRate,
    totalHT,
    tva,
    totalTTC,
    kind: isAvoir ? 'avoir' : 'facture',
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

  const isAvoir = inv.kind === 'avoir' || /^AV-/.test(inv.number || '');
  const docTitle = isAvoir ? 'FACTURE D\'AVOIR' : 'FACTURE';
  const franchise = !!co.tvaFranchise;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${docTitle} ${esc(inv.number)}</title>
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
      <div class="muted">${esc(co.formeJuridique || '')}${co.capital ? ` au capital de ${esc(co.capital)}` : ''}</div>
      <div class="muted">${esc(co.address || '')}</div>
      ${co.siret ? `<div class="muted">SIRET ${esc(co.siret)}</div>` : ''}
      ${co.rcs ? `<div class="muted">${esc(co.rcs)}</div>` : ''}
      ${co.ape ? `<div class="muted">APE ${esc(co.ape)}</div>` : ''}
      ${co.tva ? `<div class="muted">TVA intracom. ${esc(co.tva)}</div>` : ''}
      ${co.contact ? `<div class="muted">${esc(co.contact)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <h1>${docTitle}</h1>
      <div class="muted">N° ${esc(inv.number)}</div>
      <div class="muted">Date d'émission : ${esc(inv.date)}</div>
      ${inv.period ? `<div class="muted">Période / date de prestation : ${esc(inv.period)}</div>` : ''}
      <div class="muted">Date d'échéance : ${esc(inv.dueDate)}</div>
    </div>
  </div>

  <div class="box">
    <strong>Facturé à</strong><br>${esc(inv.client)}<br>${esc(inv.clientAddress || '').replace(/\n/g, '<br>')}${(inv.mentions && inv.mentions.length) ? '<br><span class="muted">' + inv.mentions.map((m) => esc(m)).join('<br>') + '</span>' : ''}
  </div>

  <table>
    <thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">P.U. HT</th><th class="num">Montant HT</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Total HT</span><span>${euro(inv.totalHT)}</span></div>
    ${franchise ? '' : `<div class="row"><span>TVA ${inv.vatRate} %</span><span>${euro(inv.tva)}</span></div>`}
    <div class="row ttc"><span>Total ${franchise ? 'net' : 'TTC'}</span><span>${euro(franchise ? inv.totalHT : inv.totalTTC)}</span></div>
  </div>

  <div class="foot">
    ${franchise ? '<strong>TVA non applicable, art. 293 B du CGI.</strong><br>' : ''}
    <strong>Conditions de règlement :</strong> à réception, échéance le ${esc(inv.dueDate)}.${co.iban ? ` Règlement par virement — IBAN ${esc(co.iban)}${co.bic ? ` — BIC ${esc(co.bic)}` : ''}.` : ''}<br>
    Pénalités de retard : ${co.penaltyRate ? `taux annuel de ${esc(co.penaltyRate)} %` : 'au taux d\'intérêt légal en vigueur'} (art. L.441-10 du Code de commerce). Indemnité forfaitaire pour frais de recouvrement : <strong>40 €</strong> (art. D.441-5). Pas d'escompte pour paiement anticipé.<br>
    ${isAvoir ? 'Le présent avoir vient en déduction des sommes dues.' : 'Tout règlement après échéance entraîne l\'application des pénalités susvisées.'}
  </div>

  <p class="noprint" style="margin-top:24px"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></p>
</body></html>`;
}

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function euro(n) { return (r2(n)).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Justificatif de frais / état d'indemnités kilométriques (imprimable PDF). */
function renderExpenseHtml(exp, user, company, ikScale) {
  const co = company || {};
  const isIK = exp.type === 'ik' || (Number(exp.km) > 0);
  const note = (ikScale && ikScale.note) || '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Justificatif de frais ${esc(exp.id)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 13px/1.6 -apple-system, Segoe UI, Roboto, sans-serif; color:#1e293b; }
  .co { font-weight:700; font-size:16px; }
  .muted { color:#64748b; font-size:12px; }
  h1 { font-size:20px; margin:18px 0 6px; }
  table { width:100%; border-collapse:collapse; margin-top:14px; }
  th,td { padding:9px 10px; border:1px solid #e2e8f0; text-align:left; }
  th { background:#f1f5f9; }
  .totals { margin-top:12px; font-weight:700; font-size:15px; }
  .foot { margin-top:26px; font-size:11px; color:#64748b; }
  .sign { margin-top:30px; display:flex; justify-content:space-between; }
  @media print { .noprint { display:none; } }
</style></head>
<body>
  <div class="co">${esc(co.legal || co.name || 'INTER COLIS SERVICES')}</div>
  <div class="muted">${esc(co.address || '')}${co.siret ? ` · SIRET ${esc(co.siret)}` : ''}</div>
  <h1>${isIK ? 'État d\'indemnités kilométriques' : 'Note de frais'}</h1>
  <div class="muted">Document n° ${esc(exp.id)} — établi le ${esc(new Date().toLocaleDateString('fr-FR'))}</div>
  <table>
    <tr><th>Salarié</th><td>${esc(user ? `${user.firstName} ${user.lastName}` : (exp.userName || '—'))}</td></tr>
    <tr><th>Date</th><td>${esc(exp.date || '')}</td></tr>
    <tr><th>Objet</th><td>${esc(exp.note || (isIK ? 'Déplacement professionnel' : 'Frais professionnel'))}</td></tr>
    ${isIK ? `<tr><th>Puissance fiscale</th><td>${esc(exp.cv || '')} CV</td></tr>
    <tr><th>Distance parcourue</th><td>${esc(exp.km || 0)} km</td></tr>
    <tr><th>Barème appliqué</th><td>Barème kilométrique paramétré (3 tranches annuelles)</td></tr>` : ''}
    <tr><th>Montant ${isIK ? 'de l\'indemnité' : 'des frais'}</th><td><strong>${euro(exp.amount)}</strong></td></tr>
  </table>
  <div class="foot">
    ${isIK ? `Indemnité kilométrique à caractère <strong>forfaitaire</strong>, couvrant l'usure, le carburant, l'assurance et l'entretien du véhicule personnel utilisé à des fins professionnelles. Calcul déterministe à partir du barème en vigueur dans l'entreprise.<br>⚠️ ${esc(note || 'Vérifiez le barème en vigueur sur impots.gouv.fr.')}<br>` : ''}
    Pièce justificative à conserver à l'appui de la comptabilité et des déclarations sociales/fiscales.
  </div>
  <div class="sign"><div>Le salarié<br>(« certifié exact »)</div><div style="text-align:right">L'employeur<br>${esc(co.name || '')}</div></div>
  <p class="noprint" style="margin-top:24px"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></p>
</body></html>`;
}

module.exports = { buildInvoice, renderInvoiceHtml, renderExpenseHtml };
