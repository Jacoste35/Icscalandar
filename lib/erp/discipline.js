'use strict';

/**
 * Barème disciplinaire — classement des motifs d'avertissement par gravité et
 * calcul d'une PROPOSITION de mise à pied proportionnelle à la désorganisation
 * causée par la répétition des manquements.
 *
 * Cadre juridique (à titre indicatif) :
 *  - La mise à pied DISCIPLINAIRE est une suspension temporaire du contrat sans
 *    rémunération (distincte de la mise à pied conservatoire). Art. L.1331-1 et
 *    L.1333-2 C. trav. : la sanction doit être PROPORTIONNÉE à la faute. Une mise
 *    à pied disciplinaire d'une durée excessive expose à la requalification ; on
 *    borne donc la proposition (MAX_JOURS) et l'on rappelle qu'il s'agit d'une
 *    proposition soumise à l'appréciation de l'employeur, jamais d'un automatisme.
 *  - Échelle des sanctions : règlement intérieur ICS, art. 20 (1° avertissement,
 *    2° mise à pied, 3° licenciement) et CCN Transports routiers (IDCC 16).
 *
 * Principe du classement : plus un motif est grave, plus le SEUIL (nombre
 * d'avertissements avant mise à pied) est bas — les fautes graves mènent donc
 * « plus rapidement » à la mise à pied, comme demandé.
 */

// gravite : 1 (léger) → 4 (très grave).
// seuil   : nombre d'avertissements DÉJÀ notifiés à partir duquel une mise à pied
//           devient proportionnée (0 = dès le premier manquement).
const MOTIF_SEVERITY = {
  'Retards répétés': { gravite: 1, seuil: 3 },
  "Défaut de remontée d'informations / documents manquants": { gravite: 1, seuil: 3 },
  "Négligence dans l'exécution du travail": { gravite: 1, seuil: 3 },
  'Absence injustifiée': { gravite: 2, seuil: 2 },
  'Non-respect du règlement intérieur': { gravite: 2, seuil: 2 },
  "Non-respect des procédures de l'entreprise": { gravite: 2, seuil: 2 },
  'Comportement inapproprié envers un collègue ou un client': { gravite: 2, seuil: 2 },
  'Manquement aux obligations contractuelles': { gravite: 2, seuil: 2 },
  'Non-respect des consignes de sécurité': { gravite: 3, seuil: 1 },
  "Insubordination / refus d'exécuter une tâche": { gravite: 3, seuil: 1 },
  'Utilisation non autorisée du véhicule de service': { gravite: 3, seuil: 1 },
  "Dégradation du matériel de l'entreprise": { gravite: 3, seuil: 1 },
  'Non-respect des temps de conduite et de repos': { gravite: 3, seuil: 1 },
  'Abandon de poste': { gravite: 4, seuil: 0 },
};

const GRAVITE_LABEL = { 1: 'Légère', 2: 'Moyenne', 3: 'Grave', 4: 'Très grave' };
const MAX_JOURS = 8; // garde-fou de proportionnalité (mise à pied disciplinaire)

function severityOf(motif) {
  return MOTIF_SEVERITY[motif] || { gravite: 2, seuil: 2 };
}

/**
 * Propose une mise à pied à partir du compteur d'avertissements déjà au dossier
 * et de la gravité du motif courant.
 *   warningCount : nb d'avertissements DÉJÀ notifiés (hors document en cours)
 *   motif        : libellé du motif
 * Retour : { proposed, jours, type, justification, gravite, graviteLabel, seuil, echelon, warningCount }
 */
function computeMiseAPied({ warningCount, motif }) {
  const sev = severityOf(motif);
  const n = Math.max(0, Number(warningCount) || 0);
  // L'avertissement en cours de rédaction constitue l'échelon disciplinaire atteint.
  const echelon = n + 1;
  let proposed = false, jours = 0, type = '', justification = '';

  if (sev.gravite >= 4) {
    // Faute d'une gravité justifiant une mesure conservatoire immédiate.
    proposed = true;
    jours = MAX_JOURS;
    type = 'Mise à pied conservatoire + engagement d\'une procédure de licenciement';
    justification = "Motif d'une gravité justifiant une mise à pied conservatoire immédiate (art. L.1332-3 C. trav.) dans l'attente de l'engagement de la procédure de licenciement pour faute grave.";
  } else if (echelon > sev.seuil) {
    // Seuil franchi : mise à pied disciplinaire proportionnée.
    proposed = true;
    const surplus = echelon - sev.seuil; // 1, 2, 3...
    jours = Math.min(MAX_JOURS, sev.gravite + (surplus - 1));
    type = 'Mise à pied disciplinaire (sans solde)';
    justification = `${echelon} manquement(s) de même nature pour une faute de gravité ${GRAVITE_LABEL[sev.gravite].toLowerCase()} : le seuil de ${sev.seuil} avertissement(s) est franchi. La durée proposée est proportionnée à la désorganisation occasionnée.`;
  } else {
    // Seuil non atteint : on en reste à l'avertissement.
    const reste = sev.seuil - n; // manquements restants avant mise à pied
    type = 'Avertissement (mise à pied non encore proportionnée)';
    justification = `Échelon ${echelon} sur un seuil de ${sev.seuil} pour ce motif. Une mise à pied deviendra proportionnée après ${reste} manquement(s) supplémentaire(s) de même nature dûment constaté(s).`;
  }

  return {
    proposed, jours, type, justification,
    gravite: sev.gravite, graviteLabel: GRAVITE_LABEL[sev.gravite],
    seuil: sev.seuil, echelon, warningCount: n,
  };
}

module.exports = { MOTIF_SEVERITY, GRAVITE_LABEL, MAX_JOURS, severityOf, computeMiseAPied };
