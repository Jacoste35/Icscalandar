'use strict';

/**
 * Options prêtes à l'emploi pour la génération de documents RH :
 *  - motifs/objets disciplinaires & RH les plus courants ;
 *  - « faits » types (textes de paragraphe) réutilisables, éditables.
 * Listes ÉDITABLES depuis l'interface (ajout de nouveaux motifs/faits).
 */

const DEFAULT_MOTIFS = [
  'Retards répétés',
  'Absence injustifiée',
  'Abandon de poste',
  'Non-respect des consignes de sécurité',
  'Non-respect du règlement intérieur',
  'Insubordination / refus d\'exécuter une tâche',
  'Comportement inapproprié envers un collègue ou un client',
  'Négligence dans l\'exécution du travail',
  'Non-respect des procédures de l\'entreprise',
  'Utilisation non autorisée du véhicule de service',
  'Défaut de remontée d\'informations / documents manquants',
  'Manquement aux obligations contractuelles',
  'Dégradation du matériel de l\'entreprise',
  'Non-respect des temps de conduite et de repos',
  'Véhicule non propre à l\'intérieur',
  'Véhicule non propre à l\'extérieur',
  'Véhicule non propre à l\'intérieur et à l\'extérieur',
  'Non-entretien mécanique du véhicule malgré voyants / bruits (mise en danger)',
];

const DEFAULT_FAITS = [
  { label: 'Retards répétés', text: "Nous avons constaté, à plusieurs reprises, votre arrivée tardive sur votre lieu de prise de service, notamment les [dates], malgré nos rappels. Ces retards désorganisent la préparation et le départ des tournées et pénalisent l'ensemble de l'équipe." },
  { label: 'Absence injustifiée', text: "Vous avez été absent(e) de votre poste le [date] sans justificatif ni information préalable de votre hiérarchie, en méconnaissance de vos obligations contractuelles et du règlement intérieur." },
  { label: 'Non-respect des consignes de sécurité', text: "Le [date], vous n'avez pas respecté les consignes de sécurité en vigueur, à savoir [préciser], exposant votre propre sécurité ainsi que celle de vos collègues et des tiers." },
  { label: 'Non-respect des procédures', text: "Le [date], vous n'avez pas appliqué la procédure en vigueur concernant [préciser], ce qui a entraîné [conséquences]." },
  { label: 'Comportement inapproprié', text: "Le [date], vous avez adopté un comportement inapproprié à l'égard de [personne], se traduisant par [faits précis], incompatible avec les règles de bonne conduite au sein de l'entreprise." },
  { label: 'Dégradation / négligence matériel', text: "Le [date], une négligence de votre part a entraîné [dégradation / incident] sur [matériel / véhicule], occasionnant un préjudice pour l'entreprise." },
  { label: 'Temps de conduite et de repos', text: "Le [date], nous avons relevé un non-respect de la réglementation relative aux temps de conduite et de repos, à savoir [préciser], susceptible d'engager la responsabilité de l'entreprise." },
  { label: 'Clause de confidentialité (avenant/contrat)', text: "Le/La salarié(e) s'engage à observer la plus stricte confidentialité sur l'ensemble des informations, documents et données dont il/elle aura connaissance dans l'exercice de ses fonctions, pendant l'exécution du contrat et après sa rupture." },
  { label: 'Rémunération (avenant/contrat)', text: "À compter du [date], la rémunération brute mensuelle du/de la salarié(e) est portée à [montant] € pour une durée de travail de 151,67 heures par mois, les autres dispositions du contrat demeurant inchangées." },
];

module.exports = { DEFAULT_MOTIFS, DEFAULT_FAITS };
