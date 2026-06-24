'use strict';

/**
 * Accusé de réception & signature électronique (niveau simple, eIDAS).
 *
 * Preuve juridique d'une lecture/réception interne : on enregistre l'identité du
 * signataire, un horodatage serveur (autoritatif), et une déclaration explicite
 * de consentement sur l'honneur. L'attestation reprend ces éléments.
 */

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Horodatage en toutes lettres : « 14:30:05, lundi 24 juin 2026 ». */
function frenchStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const heure = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return `${heure}, ${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Attestation de prise de connaissance / signature électronique (imprimable). */
function renderAttestationHtml(doc, company) {
  const co = company || {};
  const stamp = frenchStamp(doc.ackedAt);
  const name = doc.ackName || doc.userName || '';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Attestation de lecture — ${esc(doc.label)}</title>
<style>
  @page { margin: 20mm; }
  body { font: 13px/1.7 'Times New Roman', Georgia, serif; color:#111; max-width:760px; margin:0 auto; padding:12px; }
  .lh { border-bottom:2px solid #111; padding-bottom:8px; margin-bottom:20px; }
  .lh-co { font-weight:700; font-size:16px; }
  .lh-ad { color:#444; font-size:12px; }
  h2 { text-align:center; }
  .box { border:1px solid #999; border-radius:6px; padding:14px 16px; margin:16px 0; background:#fafafa; }
  .sign { margin-top:30px; }
  .muted { color:#555; font-size:11px; }
  @media print { .noprint { display:none; } }
</style></head><body>
  <div class="lh"><div class="lh-co">${esc(co.legal || co.name || 'INTER COLIS SERVICES')}</div><div class="lh-ad">${esc(co.address || '')}${co.siret ? ` · SIRET ${esc(co.siret)}` : ''}</div></div>
  <h2>ATTESTATION DE PRISE DE CONNAISSANCE</h2>
  <p>Je soussigné(e) <strong>${esc(name)}</strong>, salarié(e) de la société ${esc(co.legal || co.name || '')}, certifie sur l'honneur avoir <strong>reçu, lu et pris connaissance</strong> du document suivant :</p>
  <div class="box"><strong>${esc(doc.label)}</strong>${doc.type ? ` <span class="muted">(${esc(doc.type)})</span>` : ''}<br>Émis le ${esc((doc.createdAt || '').slice(0, 10))} par ${esc(doc.createdByName || 'la Direction')}.</div>
  <p>Cette prise de connaissance a été signée électroniquement (signature simple au sens du règlement eIDAS n° 910/2014), le :</p>
  <p style="text-align:center;font-size:15px"><strong>${esc(stamp)}</strong></p>
  <p>Le signataire certifie sur l'honneur l'exactitude de la présente déclaration et reconnaît la valeur probante de cette signature électronique.</p>
  <div class="sign"><strong>Signé électroniquement par :</strong> ${esc(name)}<br><span class="muted">Référence de la signature : ${esc(doc.ackRef || doc.id)} — horodatage serveur ${esc(doc.ackedAt || '')}</span></div>
  <p class="noprint" style="margin-top:26px;text-align:center"><button onclick="window.print()" style="padding:8px 16px;cursor:pointer">Imprimer / Enregistrer en PDF</button></p>
</body></html>`;
}

module.exports = { frenchStamp, renderAttestationHtml };
