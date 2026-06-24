'use strict';

/**
 * Profils de facturation par donneur d'ordre (FedEx, GLS, Ciblex).
 * Structure ÉDITABLE depuis l'interface. Les lignes de prestation et mentions
 * seront affinées à partir des factures réelles fournies par la direction.
 *
 * profil : {
 *   key, name, clientAddress, mentions:[..], lignes:[{ designation, prixUnitaire, unit }]
 * }
 */

const DEFAULT_PROFILES = {
  fedex: {
    key: 'fedex', name: 'FedEx Express FR', clientAddress: '',
    mentions: ['Numéro de commande / contrat à reporter', 'Prestation de transport de colis'],
    lignes: [
      { designation: 'Prestation de livraison — colis livrés', prixUnitaire: 0, unit: 'colis' },
      { designation: 'Enlèvements / ramassages', prixUnitaire: 0, unit: 'enlèvement' },
    ],
  },
  gls: {
    key: 'gls', name: 'General Logistics Systems (GLS)', clientAddress: '',
    mentions: ['Référence tournée', 'Prestation de transport et distribution'],
    lignes: [
      { designation: 'Prestation de livraison — points livrés', prixUnitaire: 0, unit: 'point' },
      { designation: 'Indexation gasoil / surcharge carburant', prixUnitaire: 0, unit: 'forfait' },
    ],
  },
  ciblex: {
    key: 'ciblex', name: 'Ciblex', clientAddress: '',
    mentions: ['Référence tournée', 'Prestation de transport express'],
    lignes: [
      { designation: 'Prestation de livraison express — courses', prixUnitaire: 0, unit: 'course' },
    ],
  },
};

module.exports = { DEFAULT_PROFILES };
