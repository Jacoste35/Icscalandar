'use strict';

/**
 * Extension ERP — socle commun.
 * - Garantit la présence des structures de données ERP dans la base existante.
 * - Génère des identifiants sans toucher aux compteurs de l'application.
 * - Centralise quelques constantes (société, TVA).
 *
 * Aucune dépendance externe. Tout est déterministe (aucun appel à une IA).
 */

const COMPANY = {
  name: 'INTER COLIS SERVICES',
  legal: 'SASU INTER COLIS SERVICES',
  address: 'Éterville, 14930 Calvados',
  siret: '',          // à compléter dans Administration
  tva: '',            // n° TVA intracommunautaire — à compléter
  iban: '',           // pour les factures — à compléter
  vatRate: 20,        // taux de TVA par défaut (%)
};

let _seq = 0;
function eid(prefix) {
  _seq = (_seq + 1) % 100000;
  return `${prefix}_${Date.now().toString(36)}${_seq.toString(36).padStart(3, '0')}`;
}

/**
 * Garantit que la base contient les conteneurs ERP. Idempotent : on peut
 * l'appeler à chaque requête sans risque.
 */
function ensureErp(data) {
  if (!data.erp) {
    data.erp = {
      invoices: [],       // factures émises (brouillon -> validée -> payée)
      invoiceSeq: 0,      // compteur de numérotation des factures
      suppliers: [],      // fournisseurs (cycle achats)
      purchases: [],      // factures fournisseurs
      auditLog: [],       // journal d'audit ERP
      digests: [],        // snapshots quotidiens (échéances du jour)
    };
  }
  if (!Array.isArray(data.compliance)) {
    // Documents à échéance : permis B, visite médicale, assurance, licence LTI…
    // scope: 'user' | 'vehicle' | 'company' ; refId pointe vers l'entité.
    data.compliance = [];
  }
  if (!data.settings) data.settings = {};
  if (!data.settings.company) data.settings.company = { ...COMPANY };
  if (!data.settings.erpTemplates) {
    data.settings.erpTemplates = require('./templates').DEFAULT_TEMPLATES;
  }
  return data;
}

module.exports = { COMPANY, eid, ensureErp };
