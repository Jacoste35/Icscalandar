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

const DEFAULT_TEMPLATES = {
  avertissement: { label: 'Avertissement disciplinaire', body: AVERTISSEMENT },
  convocation: { label: 'Convocation entretien préalable', body: CONVOCATION },
  relance: { label: 'Relance impayé', body: RELANCE },
  attestation: { label: 'Attestation de travail', body: ATTESTATION },
};

module.exports = { render, DEFAULT_TEMPLATES };
