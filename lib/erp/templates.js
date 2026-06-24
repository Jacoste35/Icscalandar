'use strict';

/**
 * Moteur de publipostage — remplace {{variables}} dans un modèle texte/HTML.
 * Pas d'IA : un modèle écrit une fois, rempli avec les données. Pour les ~5 %
 * de cas atypiques, l'admin édite le brouillon à la main avant validation.
 *
 * Syntaxe supportée :
 *   {{cle}}                       -> valeur
 *   {{#if cle}}...{{/if}}         -> bloc conditionnel
 */

function render(tpl, vars) {
  let out = String(tpl || '');
  // Blocs conditionnels {{#if x}}...{{/if}}
  out = out.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) =>
    truthy(get(vars, key)) ? body : '');
  // Variables simples
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = get(vars, key);
    return v === undefined || v === null ? '' : String(v);
  });
  return out;
}

function get(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function truthy(v) { return !(v === undefined || v === null || v === false || v === '' || v === 0); }

/* ------------------------------------------------------------------ */
/* Modèles par défaut (éditables ensuite depuis le panneau ERP).       */
/* Ton sobre, juridiquement prudent. Conducteurs VL ≤ 3,5 T (IDCC 16). */
/* ------------------------------------------------------------------ */

const LETTERHEAD = `
<div class="lh">
  <div class="lh-co">{{company.legal}}</div>
  <div class="lh-ad">{{company.address}}{{#if company.siret}} · SIRET {{company.siret}}{{/if}}</div>
</div>`;

const AVERTISSEMENT = `${LETTERHEAD}
<p class="addr">{{salarie.fullName}}<br>{{salarie.address}}</p>
<p class="meta">Éterville, le {{date}}<br>Lettre remise en main propre contre décharge / LRAR</p>
<p><strong>Objet : avertissement</strong></p>
<p>{{salarie.civilite}} {{salarie.lastName}},</p>
<p>Nous sommes contraints de vous notifier le présent avertissement pour le motif suivant : <strong>{{motif}}</strong>.</p>
<p>{{faits}}</p>
<p>Ces faits constituent un manquement à vos obligations professionnelles au regard de votre contrat de travail et du règlement intérieur de l'entreprise, ainsi que des dispositions de la convention collective nationale des transports routiers (IDCC 16) applicable à votre emploi de conducteur de véhicule léger.</p>
<p>Nous vous demandons de veiller scrupuleusement, à l'avenir, au respect de vos obligations. À défaut, nous serions amenés à envisager des mesures plus contraignantes.</p>
{{#if antecedents}}<p>Nous vous rappelons qu'un rappel a déjà été porté à votre connaissance : {{antecedents}}.</p>{{/if}}
<p>Ce courrier constitue un avertissement et sera versé à votre dossier.</p>
<p>Nous vous prions d'agréer, {{salarie.civilite}} {{salarie.lastName}}, l'expression de nos salutations distinguées.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const CONVOCATION = `${LETTERHEAD}
<p class="addr">{{salarie.fullName}}<br>{{salarie.address}}</p>
<p class="meta">Éterville, le {{date}}<br>LRAR / remise en main propre contre décharge</p>
<p><strong>Objet : convocation à un entretien préalable</strong></p>
<p>{{salarie.civilite}} {{salarie.lastName}},</p>
<p>Nous sommes amenés à envisager à votre égard une mesure de {{mesure}}. Nous vous convoquons à un entretien préalable qui se tiendra le <strong>{{dateEntretien}}</strong> à <strong>{{heureEntretien}}</strong>, à l'adresse de l'entreprise.</p>
<p>Au cours de cet entretien, nous vous exposerons les motifs de la mesure envisagée et recueillerons vos explications.</p>
<p>Vous pouvez vous faire assister par une personne de votre choix appartenant au personnel de l'entreprise.</p>
<p>Nous vous prions d'agréer, {{salarie.civilite}} {{salarie.lastName}}, nos salutations distinguées.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const RELANCE = `${LETTERHEAD}
<p class="addr">{{client.name}}<br>{{client.address}}</p>
<p class="meta">Éterville, le {{date}}</p>
<p><strong>Objet : relance — facture {{invoice.number}} impayée</strong></p>
<p>Madame, Monsieur,</p>
<p>Sauf erreur de notre part, notre facture <strong>{{invoice.number}}</strong> du {{invoice.date}}, d'un montant de <strong>{{invoice.totalTTC}} € TTC</strong>, échue le {{invoice.dueDate}}, demeure impayée à ce jour.</p>
<p>Nous vous remercions de bien vouloir procéder à son règlement sous huitaine. Si ce règlement a été effectué entre-temps, nous vous prions de ne pas tenir compte du présent courrier.</p>
<p>À défaut, et conformément à la loi, des pénalités de retard ainsi que l'indemnité forfaitaire de recouvrement de 40 € seront exigibles, sans préjudice de toute action en recouvrement.</p>
<p>Nous vous prions d'agréer, Madame, Monsieur, nos salutations distinguées.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const ATTESTATION = `${LETTERHEAD}
<p class="meta">Éterville, le {{date}}</p>
<p><strong>Objet : attestation de travail</strong></p>
<p>Je soussigné, représentant légal de la société {{company.legal}}, atteste que {{salarie.civilite}} {{salarie.fullName}} est employé(e) au sein de notre entreprise depuis le {{salarie.hireDate}}, en qualité de {{salarie.poste}}.</p>
<p>Cette attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

/* ---- Module 2 : contrats & cycle de vie RH -------------------------- */
/* CCN Transports routiers (IDCC 16), conducteurs VL ≤ 3,5 T coef 110M/120M. */

const CONTRAT_CDI = `${LETTERHEAD}
<h2 style="text-align:center">CONTRAT DE TRAVAIL À DURÉE INDÉTERMINÉE</h2>
<p>Entre les soussignés :</p>
<p>La société <strong>{{company.legal}}</strong>, dont le siège est situé {{company.address}}{{#if company.siret}}, SIRET {{company.siret}}{{/if}}, représentée par son représentant légal,</p>
<p>d'une part,</p>
<p>Et {{salarie.civilite}} <strong>{{salarie.fullName}}</strong>, demeurant {{salarie.address}}{{#if salarie.birthDate}}, né(e) le {{salarie.birthDate}}{{/if}},</p>
<p>d'autre part,</p>
<p>Il a été convenu ce qui suit :</p>
<p><strong>Article 1 — Engagement.</strong> {{salarie.civilite}} {{salarie.lastName}} est engagé(e) à compter du <strong>{{salarie.hireDate}}</strong> en qualité de <strong>{{salarie.poste}}</strong>, coefficient {{salarie.coefficient}}, groupe 3 bis, statut ouvrier.</p>
<p><strong>Article 2 — Convention collective.</strong> Le présent contrat est régi par la convention collective nationale des transports routiers et activités auxiliaires du transport (IDCC 16).</p>
<p><strong>Article 3 — Lieu de travail.</strong> {{contrat.lieu}}. La nature de l'emploi implique des déplacements inhérents à la fonction de conducteur.</p>
<p><strong>Article 4 — Durée du travail.</strong> {{contrat.horaires}}.</p>
<p><strong>Article 5 — Rémunération.</strong> {{contrat.remuneration}}.</p>
<p><strong>Article 6 — Période d'essai.</strong> Le contrat comporte une période d'essai d'un mois (statut ouvrier), non renouvelable, pendant laquelle chacune des parties peut rompre le contrat dans les conditions légales.</p>
<p><strong>Article 7 — Véhicule.</strong> Un véhicule de l'entreprise est mis à disposition pour l'exécution des missions ; le salarié s'engage à en prendre soin et à signaler tout incident.</p>
<p><strong>Article 8 — Obligations.</strong> Le salarié s'engage au respect du règlement intérieur, à la confidentialité et au respect des règles de sécurité routière.</p>
<p>Fait à Éterville, le {{date}}, en deux exemplaires.</p>
<table style="width:100%;margin-top:24px"><tr><td>L'employeur<br>{{company.name}}</td><td style="text-align:right">Le salarié<br>(« lu et approuvé »)<br>{{salarie.fullName}}</td></tr></table>`;

const CONTRAT_CDD = `${LETTERHEAD}
<h2 style="text-align:center">CONTRAT DE TRAVAIL À DURÉE DÉTERMINÉE</h2>
<p>Entre la société <strong>{{company.legal}}</strong>, {{company.address}}, et {{salarie.civilite}} <strong>{{salarie.fullName}}</strong>, demeurant {{salarie.address}}, il a été convenu ce qui suit :</p>
<p><strong>Article 1 — Motif du recours.</strong> Le présent contrat à durée déterminée est conclu pour le motif suivant : <strong>{{contrat.motif}}</strong>.</p>
<p><strong>Article 2 — Engagement et terme.</strong> {{salarie.civilite}} {{salarie.lastName}} est engagé(e) à compter du <strong>{{salarie.hireDate}}</strong> en qualité de <strong>{{salarie.poste}}</strong>, coefficient {{salarie.coefficient}}. Terme du contrat : <strong>{{contrat.terme}}</strong>.</p>
<p><strong>Article 3 — Convention collective.</strong> CCN des transports routiers (IDCC 16).</p>
<p><strong>Article 4 — Durée du travail.</strong> {{contrat.horaires}}.</p>
<p><strong>Article 5 — Rémunération.</strong> {{contrat.remuneration}}.</p>
<p><strong>Article 6 — Période d'essai.</strong> Conforme à la durée légale applicable aux CDD (un jour par semaine, dans les limites légales).</p>
<p><strong>Article 7 — Indemnité de fin de contrat.</strong> Sauf exclusion légale, une indemnité de fin de contrat de 10 % de la rémunération brute totale sera versée au terme du contrat.</p>
<p>Fait à Éterville, le {{date}}, en deux exemplaires.</p>
<table style="width:100%;margin-top:24px"><tr><td>L'employeur<br>{{company.name}}</td><td style="text-align:right">Le salarié<br>(« lu et approuvé »)<br>{{salarie.fullName}}</td></tr></table>`;

const AVENANT = `${LETTERHEAD}
<h2 style="text-align:center">AVENANT AU CONTRAT DE TRAVAIL</h2>
<p>Entre la société <strong>{{company.legal}}</strong> et {{salarie.civilite}} <strong>{{salarie.fullName}}</strong>, il est convenu l'avenant suivant au contrat de travail en vigueur :</p>
<p><strong>Objet :</strong> {{contrat.objet}}.</p>
<p><strong>Clause modifiée :</strong> {{contrat.clause}}.</p>
<p><strong>Date d'effet :</strong> {{contrat.dateEffet}}.</p>
<p>Les autres clauses du contrat de travail demeurent inchangées.</p>
<p>Fait à Éterville, le {{date}}, en deux exemplaires.</p>
<table style="width:100%;margin-top:24px"><tr><td>L'employeur<br>{{company.name}}</td><td style="text-align:right">Le salarié<br>(« lu et approuvé »)<br>{{salarie.fullName}}</td></tr></table>`;

const PROMESSE = `${LETTERHEAD}
<p class="addr">{{salarie.fullName}}<br>{{salarie.address}}</p>
<p class="meta">Éterville, le {{date}}</p>
<p><strong>Objet : promesse d'embauche</strong></p>
<p>{{salarie.civilite}} {{salarie.lastName}},</p>
<p>Nous avons le plaisir de vous confirmer notre intention de vous engager au sein de la société {{company.legal}} aux conditions suivantes :</p>
<ul>
  <li>Poste : <strong>{{salarie.poste}}</strong> (coefficient {{salarie.coefficient}})</li>
  <li>Type de contrat : {{contrat.type}}</li>
  <li>Date d'entrée envisagée : {{salarie.hireDate}}</li>
  <li>Rémunération : {{contrat.remuneration}}</li>
  <li>Lieu de travail : {{contrat.lieu}}</li>
</ul>
<p>Cette promesse vaut engagement de notre part. Nous vous remercions de nous retourner un exemplaire signé pour accord.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

/* ---- Module 3 : pack fin de contrat --------------------------------- */

const CERTIFICAT_TRAVAIL = `${LETTERHEAD}
<h2 style="text-align:center">CERTIFICAT DE TRAVAIL</h2>
<p>Je soussigné, représentant légal de la société <strong>{{company.legal}}</strong>, certifie que {{salarie.civilite}} <strong>{{salarie.fullName}}</strong> a été employé(e) dans notre entreprise du <strong>{{salarie.hireDate}}</strong> au <strong>{{contrat.lastDay}}</strong>, en qualité de <strong>{{salarie.poste}}</strong>.</p>
<p>{{salarie.civilite}} {{salarie.lastName}} est libre de tout engagement à notre égard.</p>
<p>Certificat délivré pour servir et valoir ce que de droit.</p>
<p class="meta">Fait à Éterville, le {{date}}.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const SOLDE_TOUT_COMPTE = `${LETTERHEAD}
<h2 style="text-align:center">REÇU POUR SOLDE DE TOUT COMPTE</h2>
<p>Je soussigné(e) {{salarie.civilite}} <strong>{{salarie.fullName}}</strong> reconnais avoir reçu de la société <strong>{{company.legal}}</strong>, pour solde de tout compte et en règlement de l'ensemble des sommes dues au titre de l'exécution et de la rupture de mon contrat de travail prenant fin le <strong>{{contrat.lastDay}}</strong>, les éléments suivants :</p>
<p>{{contrat.detail}}</p>
<p>Le présent reçu est établi en deux exemplaires. Il peut être dénoncé dans les six mois suivant sa signature.</p>
<p class="meta">Fait à Éterville, le {{date}}.</p>
<table style="width:100%;margin-top:24px"><tr><td>L'employeur<br>{{company.name}}</td><td style="text-align:right">Le salarié<br>(« pour solde de tout compte »)<br>{{salarie.fullName}}</td></tr></table>`;

const ATTESTATION_FRANCE_TRAVAIL = `${LETTERHEAD}
<h2 style="text-align:center">ATTESTATION FRANCE TRAVAIL — données préparatoires</h2>
<p class="meta">⚠️ L'attestation officielle doit être générée et transmise via le portail employeur de France Travail (ex-Pôle emploi) — net-entreprises.fr. Ce document pré-remplit les informations à reporter.</p>
<p><strong>Employeur :</strong> {{company.legal}} — {{company.address}}{{#if company.siret}} — SIRET {{company.siret}}{{/if}}</p>
<p><strong>Salarié :</strong> {{salarie.civilite}} {{salarie.fullName}} — {{salarie.address}}</p>
<p><strong>Emploi :</strong> {{salarie.poste}} (coefficient {{salarie.coefficient}})</p>
<p><strong>Période d'emploi :</strong> du {{salarie.hireDate}} au {{contrat.lastDay}}</p>
<p><strong>Motif de la rupture :</strong> {{contrat.motif}}</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

/* ---- Module 4 : documents commerciaux & financiers ------------------ */

const DEVIS = `${LETTERHEAD}
<h2 style="text-align:center">DEVIS {{devis.number}}</h2>
<p class="addr">{{client.name}}<br>{{client.address}}</p>
<p class="meta">Éterville, le {{date}} — valable 30 jours</p>
<p>{{devis.intro}}</p>
<table style="width:100%;border-collapse:collapse;margin-top:10px">
  <thead><tr><th style="text-align:left;border-bottom:1px solid #000">Désignation</th><th style="text-align:right;border-bottom:1px solid #000">Qté</th><th style="text-align:right;border-bottom:1px solid #000">P.U. HT</th><th style="text-align:right;border-bottom:1px solid #000">Total HT</th></tr></thead>
  <tbody>{{devis.linesHtml}}</tbody>
</table>
<p style="text-align:right;margin-top:10px">Total HT : <strong>{{devis.totalHT}} €</strong> — TVA {{devis.vatRate}} % : {{devis.tva}} € — <strong>Total TTC : {{devis.totalTTC}} €</strong></p>
<p class="meta">Prix au point indexés (gasoil/CNR) selon les paramètres en vigueur. Bon pour accord, date et signature :</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const MISE_EN_DEMEURE = `${LETTERHEAD}
<p class="addr">{{client.name}}<br>{{client.address}}</p>
<p class="meta">Éterville, le {{date}}<br>LETTRE RECOMMANDÉE AVEC ACCUSÉ DE RÉCEPTION</p>
<p><strong>Objet : MISE EN DEMEURE — facture {{invoice.number}} impayée</strong></p>
<p>Madame, Monsieur,</p>
<p>Malgré notre relance, notre facture <strong>{{invoice.number}}</strong> du {{invoice.date}}, d'un montant de <strong>{{invoice.totalTTC}} € TTC</strong>, échue le {{invoice.dueDate}}, demeure à ce jour impayée.</p>
<p>Par la présente, nous vous <strong>mettons en demeure</strong> de régler l'intégralité de cette somme dans un délai de <strong>huit (8) jours</strong> à compter de la réception du présent courrier.</p>
<p>À défaut de règlement dans ce délai, et conformément aux articles L.441-10 et D.441-5 du Code de commerce, seront exigibles des pénalités de retard au taux légal en vigueur ainsi que l'indemnité forfaitaire pour frais de recouvrement de <strong>40 €</strong>, sans préjudice de toute action judiciaire en recouvrement et des intérêts y afférents.</p>
<p>Nous vous prions d'agréer, Madame, Monsieur, l'expression de nos salutations distinguées.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const NOTE_SERVICE = `${LETTERHEAD}
<h2 style="text-align:center">NOTE DE SERVICE</h2>
<p class="meta">Éterville, le {{date}} — Réf. {{note.ref}}</p>
<p><strong>Objet : {{note.objet}}</strong></p>
<p><strong>Destinataires :</strong> {{note.destinataires}}</p>
<p>{{note.corps}}</p>
<p>Cette note prend effet à compter du {{note.dateEffet}} et est affichée/diffusée à l'ensemble du personnel concerné.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const BON_COMMANDE_FOURNISSEUR = `${LETTERHEAD}
<h2 style="text-align:center">BON DE COMMANDE {{bc.number}}</h2>
<p class="addr"><strong>Fournisseur :</strong> {{bc.fournisseur}}<br>{{bc.fournisseurAddress}}</p>
<p class="meta">Éterville, le {{date}}</p>
<table style="width:100%;border-collapse:collapse;margin-top:10px">
  <thead><tr><th style="text-align:left;border-bottom:1px solid #000">Référence</th><th style="text-align:left;border-bottom:1px solid #000">Désignation</th><th style="text-align:right;border-bottom:1px solid #000">Qté</th><th style="text-align:right;border-bottom:1px solid #000">P.U. HT</th></tr></thead>
  <tbody>{{bc.linesHtml}}</tbody>
</table>
<p style="text-align:right;margin-top:10px">Total commande HT estimé : <strong>{{bc.totalHT}} €</strong></p>
<p class="meta">Livraison souhaitée : {{bc.delai}}. Merci d'accuser réception de la présente commande.</p>
<p class="sign">La Direction<br>{{company.name}}</p>`;

const BORDEREAU_TOURNEE = `${LETTERHEAD}
<h2 style="text-align:center">BORDEREAU DE TOURNÉE</h2>
<p class="meta">Date : {{tour.date}} — Chauffeur : {{tour.chauffeur}} — Véhicule : {{tour.vehicule}} — Tournée : {{tour.contrat}}</p>
<table style="width:100%;border-collapse:collapse;margin-top:10px">
  <tr><td style="border:1px solid #000;padding:6px">Km départ : {{tour.kmStart}}</td><td style="border:1px solid #000;padding:6px">Km arrivée : {{tour.kmEnd}}</td></tr>
  <tr><td style="border:1px solid #000;padding:6px">Points prévus : {{tour.pointsPlanned}}</td><td style="border:1px solid #000;padding:6px">Points livrés : {{tour.pointsDelivered}}</td></tr>
  <tr><td style="border:1px solid #000;padding:6px">Échecs : {{tour.pointsFailed}} ({{tour.failReason}})</td><td style="border:1px solid #000;padding:6px">Ramassages : {{tour.pickups}}</td></tr>
</table>
<p class="meta">Incident éventuel : {{tour.incident}}</p>
<p class="sign">Signature chauffeur</p>`;

const DEFAULT_TEMPLATES = {
  avertissement: { label: 'Avertissement disciplinaire', body: AVERTISSEMENT, category: 'Disciplinaire' },
  convocation: { label: 'Convocation entretien préalable', body: CONVOCATION, category: 'Disciplinaire' },
  relance: { label: 'Relance impayé', body: RELANCE, category: 'Finance' },
  attestation: { label: 'Attestation de travail', body: ATTESTATION, category: 'RH' },
  contrat_cdi: { label: 'Contrat CDI conducteur VL', body: CONTRAT_CDI, category: 'Contrats' },
  contrat_cdd: { label: 'Contrat CDD conducteur VL', body: CONTRAT_CDD, category: 'Contrats' },
  avenant: { label: 'Avenant au contrat', body: AVENANT, category: 'Contrats' },
  promesse_embauche: { label: 'Promesse d\'embauche', body: PROMESSE, category: 'Contrats' },
  certificat_travail: { label: 'Certificat de travail', body: CERTIFICAT_TRAVAIL, category: 'Départ' },
  solde_tout_compte: { label: 'Reçu pour solde de tout compte', body: SOLDE_TOUT_COMPTE, category: 'Départ' },
  attestation_france_travail: { label: 'Attestation France Travail (préparatoire)', body: ATTESTATION_FRANCE_TRAVAIL, category: 'Départ' },
  devis: { label: 'Devis', body: DEVIS, category: 'Finance' },
  mise_en_demeure: { label: 'Mise en demeure', body: MISE_EN_DEMEURE, category: 'Finance' },
  note_service: { label: 'Note de service', body: NOTE_SERVICE, category: 'RH' },
  bon_commande_fournisseur: { label: 'Bon de commande fournisseur', body: BON_COMMANDE_FOURNISSEUR, category: 'Achats' },
  bordereau_tournee: { label: 'Bordereau de tournée', body: BORDEREAU_TOURNEE, category: 'Exploitation' },
};

module.exports = { render, DEFAULT_TEMPLATES };
