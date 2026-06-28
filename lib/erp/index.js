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
  siret: '',          // SIRET (14 chiffres) — mention obligatoire facture
  rcs: '',            // ex. « RCS Caen 820 323 350 »
  ape: '',            // code APE/NAF (ex. 4941A)
  capital: '',        // capital social (ex. « 1 000 € »)
  formeJuridique: 'SASU',
  tva: '',            // n° TVA intracommunautaire (ex. FR..)
  iban: '',           // pour règlement par virement
  bic: '',            // BIC/SWIFT
  contact: '',        // email / téléphone (facultatif)
  vatRate: 20,        // taux de TVA par défaut (%)
  penaltyRate: '',    // taux des pénalités de retard (% annuel) — éditable
  tvaFranchise: false,// true => « TVA non applicable, art. 293 B du CGI »
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
  // Conteneurs ERP additionnels (idempotent — installs existantes incluses).
  const e = data.erp;
  if (!Array.isArray(e.recurring)) e.recurring = [];          // charges récurrentes (trésorerie)
  if (!Array.isArray(e.expenses)) e.expenses = [];            // notes de frais / IK
  if (!Array.isArray(e.staffDocs)) e.staffDocs = [];          // coffre-fort salarié (métadonnées)
  if (!Array.isArray(e.acknowledgements)) e.acknowledgements = []; // accusés de réception
  if (!Array.isArray(e.documents)) e.documents = [];          // documents adressés aux salariés
  if (!data.settings) data.settings = {};
  if (!data.settings.billingProfiles) data.settings.billingProfiles = require('./billing').DEFAULT_PROFILES;
  // Options de génération de documents : motifs RH courants + « faits » types.
  if (!Array.isArray(data.settings.docMotifs)) data.settings.docMotifs = require('./docoptions').DEFAULT_MOTIFS.slice();
  if (!Array.isArray(data.settings.docFaits)) data.settings.docFaits = require('./docoptions').DEFAULT_FAITS.map((f) => ({ ...f }));
  // Backfill : pré-renseigne les profils transporteurs (coordonnées, mentions,
  // catalogue de lignes) à partir des factures réelles, SANS écraser les
  // personnalisations existantes (on ne remplit que ce qui est vide / par défaut).
  {
    const defs = require('./billing').DEFAULT_PROFILES;
    const bp = data.settings.billingProfiles;
    for (const k of Object.keys(defs)) {
      const cur = bp[k];
      if (!cur) { bp[k] = JSON.parse(JSON.stringify(defs[k])); continue; }
      if (!cur.clientAddress) cur.clientAddress = defs[k].clientAddress;
      if (!cur.name || /^(FedEx Express FR|General Logistics Systems \(GLS\)|Ciblex)$/.test(cur.name)) cur.name = defs[k].name;
      if (!Array.isArray(cur.mentions) || !cur.mentions.length) cur.mentions = defs[k].mentions.slice();
      // Catalogue de lignes : on remplace s'il est vide ou encore au tarif 0 (placeholder).
      if (!Array.isArray(cur.lignes) || !cur.lignes.length || cur.lignes.every((l) => !Number(l.prixUnitaire))) cur.lignes = JSON.parse(JSON.stringify(defs[k].lignes));
    }
  }
  if (!Array.isArray(data.tours)) data.tours = [];            // retours de tournée
  if (!Array.isArray(data.compliance)) {
    // Documents à échéance : permis B, visite médicale, assurance, licence LTI…
    // scope: 'user' | 'vehicle' | 'company' ; refId pointe vers l'entité.
    data.compliance = [];
  }
  if (!data.settings) data.settings = {};
  if (!data.settings.company) data.settings.company = { ...COMPANY };
  {
    const tplmod = require('./templates');
    const def = tplmod.DEFAULT_TEMPLATES;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    if (!data.settings.erpTemplates) {
      data.settings.erpTemplates = clone(def);
      data.settings.erpTemplatesVersion = tplmod.TEMPLATES_VERSION;
    } else {
      // Ajoute les nouveaux modèles par défaut sans écraser les personnalisés.
      for (const k of Object.keys(def)) if (!data.settings.erpTemplates[k]) data.settings.erpTemplates[k] = clone(def[k]);
      // Quand la version de code change, on rafraîchit les modèles PAR DÉFAUT
      // qui n'ont PAS été édités manuellement (ni personnalisés). Les modèles
      // créés/édités par l'admin (custom/edited) sont préservés.
      if ((data.settings.erpTemplatesVersion || 0) < tplmod.TEMPLATES_VERSION) {
        for (const k of Object.keys(def)) {
          const cur = data.settings.erpTemplates[k];
          if (cur && !cur.custom && !cur.edited) { cur.body = def[k].body; cur.label = def[k].label; cur.category = def[k].category; }
        }
        data.settings.erpTemplatesVersion = tplmod.TEMPLATES_VERSION;
      }
    }
  }
  // Barème indemnités kilométriques — ÉDITABLE (vérifier impots.gouv.fr).
  if (!data.settings.ikScale) data.settings.ikScale = require('./ik').DEFAULT_IK_SCALE;
  // Géolocalisation PAJ GPS — configuration (mot de passe chiffré) + état de suivi.
  if (!data.settings.pajgps || typeof data.settings.pajgps !== 'object') {
    data.settings.pajgps = { enabled: false, email: '', passwordEnc: '', deviceMap: {}, speedLimit: 115, dayStart: '05:00', dayEnd: '18:00' };
  } else {
    const g = data.settings.pajgps;
    if (typeof g.speedLimit !== 'number') g.speedLimit = 115;
    if (!g.dayStart) g.dayStart = '05:00';
    if (!g.dayEnd) g.dayEnd = '18:00';
    if (!g.deviceMap || typeof g.deviceMap !== 'object') g.deviceMap = {};
  }
  if (!data.pajState || typeof data.pajState !== 'object') data.pajState = { day: '', devices: {}, _lastPollTs: 0, _lastError: '' };
  return data;
}

module.exports = { COMPANY, eid, ensureErp };
