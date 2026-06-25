'use strict';

/**
 * Profils de facturation par donneur d'ordre (FedEx, GLS, Ciblex).
 * Pré-renseignés à partir des factures réelles de mai 2026 (lignes, tarifs
 * unitaires, coordonnées et mentions). ÉDITABLES depuis l'interface — il suffit
 * d'ajuster les quantités chaque mois (ou de les lire par OCR) pour régénérer
 * une facture identique.
 *
 * profil : { key, name, clientAddress, mentions:[..], lignes:[{ designation, prixUnitaire, unit }] }
 */

const DEFAULT_PROFILES = {
  fedex: {
    key: 'fedex', name: 'Fedex Express FR',
    clientAddress: "À l'attention de la Comptabilité Fournisseurs\n58 Avenue Leclerc - CS 17237\n69354 LYON CEDEX 07",
    mentions: [
      'Prestation de Transport Mai 2026',
      'Capital social : 12 700 € — Code NAF/APE 4941A',
      'Code Activité Fedex Express FR : Réseau',
      'Contact en Agence : David Lagoude | PUDODOM',
      'Numéro TVA INTRA : FR39315334011',
      "Indexation carburant : ((Indice M-1 / Indice de référence) − 1) × % carburant (8 %) × Montant secteur",
    ],
    lignes: [
      { designation: 'Livraison N° T560', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T561', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T562', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T563', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T564', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T565', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Livraison N° T566', prixUnitaire: 4.90, unit: 'colis' },
      { designation: 'Ramassage R260 HEROUVILLE', prixUnitaire: 5.24, unit: 'ramassage' },
      { designation: 'Ramassage R262 Bayeux', prixUnitaire: 5.24, unit: 'ramassage' },
      { designation: 'Ramassage R263 Isigny Ste Mère', prixUnitaire: 5.24, unit: 'ramassage' },
      { designation: 'Ajustement / indexation carburant', prixUnitaire: 0, unit: 'forfait' },
    ],
  },
  gls: {
    key: 'gls', name: 'GLS Agence de Caen [FR0014]',
    clientAddress: "ZAC Object'IFS Sud\nRue Antoine Becquerel\n14123 IFS",
    mentions: [
      'Prestation de transport Mai 2026 — Simulation mensuelle des prestations',
      'Numéro Sous-traitant : 2509906265',
      'Numéro SAP : 4100164677',
      'SIRET : 820 323 350 00026',
      'Numéro TVA INTRA : FR39315334011',
    ],
    lignes: [
      { designation: 'Nombre de colis Points livrés, enlevés, collectés', prixUnitaire: 4.70, unit: 'colis' },
      { designation: 'Nombre de colis Mois livrés, enlevés, collectés', prixUnitaire: 0.30, unit: 'colis' },
      { designation: 'Convention Image', prixUnitaire: 10.00, unit: 'forfait' },
      { designation: 'Bonus 1%', prixUnitaire: 0, unit: 'forfait' },
      { designation: 'Surcharge Gazole Enlèvement', prixUnitaire: 0, unit: 'forfait' },
      { designation: 'Surcharge Gazole Livraison', prixUnitaire: 0, unit: 'forfait' },
    ],
  },
  ciblex: {
    key: 'ciblex', name: 'Ciblex France — Agence de Caen',
    clientAddress: '16 rue … (à confirmer)\n14120 Mondeville',
    mentions: [
      'Prestation de transport Mai 2026 — Relevé de prestations',
    ],
    lignes: [
      { designation: 'Forfait nuit 14100/101/102', prixUnitaire: 30.00, unit: 'forfait' },
      { designation: 'Forfait nuit 14103/14104', prixUnitaire: 25.00, unit: 'forfait' },
      { designation: 'Forfait jour 14100/101/102', prixUnitaire: 55.00, unit: 'forfait' },
      { designation: 'Forfait jour 14103', prixUnitaire: 35.00, unit: 'forfait' },
      { designation: 'Forfait jour 14104', prixUnitaire: 25.00, unit: 'forfait' },
      { designation: 'Forfait lundi', prixUnitaire: 90.00, unit: 'forfait' },
      { designation: 'Prix au point jour 14100/101/102', prixUnitaire: 2.80, unit: 'point' },
      { designation: 'Prix au point jour 14103', prixUnitaire: 2.60, unit: 'point' },
      { designation: 'Prix au point jour 14104', prixUnitaire: 2.40, unit: 'point' },
      { designation: 'Livraisons spare', prixUnitaire: 7.00, unit: 'livraison' },
      { designation: 'Livraisons synchro', prixUnitaire: 5.00, unit: 'livraison' },
      { designation: 'Enlèvements', prixUnitaire: 2.80, unit: 'enlèvement' },
      { designation: 'Points Relais Colis', prixUnitaire: 8.00, unit: 'colis' },
      { designation: 'SASIC', prixUnitaire: 100.00, unit: 'forfait' },
      { designation: 'Picking 1', prixUnitaire: 25.00, unit: 'forfait' },
      { designation: 'Picking 2', prixUnitaire: 25.00, unit: 'forfait' },
      { designation: 'Picking 3', prixUnitaire: 25.00, unit: 'forfait' },
      { designation: 'Montant VTPC', prixUnitaire: 675.00, unit: 'forfait' },
    ],
  },
};

module.exports = { DEFAULT_PROFILES };
