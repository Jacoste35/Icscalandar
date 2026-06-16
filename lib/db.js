'use strict';

const fs = require('fs');
const path = require('path');

// Persistance simple basée sur un fichier JSON. Suffisant pour une petite
// équipe : lecture en mémoire, écriture atomique sur disque.

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'database.json');

const DEFAULT_DATA = {
  users: [],
  groups: [
    { id: 'grp_gls', name: 'GLS', color: '#1d4ed8' },
    { id: 'grp_fedex', name: 'FedEx', color: '#7c3aed' },
    { id: 'grp_ciblex', name: 'Ciblex', color: '#dc2626' },
    { id: 'grp_joker', name: 'Joker', color: '#ea580c' },
    { id: 'grp_secretaire', name: 'Secrétaire', color: '#0d9488' },
  ],
  requests: [],
  // Catégories d'absence (reprises du planning Excel), couleurs éditables.
  // selectable=false -> non choisissable par le salarié (état dérivé).
  categories: [
    { code: 'DCP', label: 'Demande congé payé', color: '#f59e0b', selectable: false, pool: null },
    { code: 'CP', label: 'Congé payé', color: '#22c55e', selectable: true, pool: 'conges' },
    { code: 'RCP', label: 'Récupération', color: '#3b82f6', selectable: true, pool: 'recup' },
    { code: 'PMT', label: 'Congé maternité / paternité', color: '#ec4899', selectable: true, pool: null },
    { code: 'AM', label: 'Arrêt maladie', color: '#ef4444', selectable: true, pool: null },
    { code: 'ABS', label: 'Absence injustifiée', color: '#6b7280', selectable: true, pool: null },
  ],
  counters: { user: 0, request: 0 },
  settings: {
    // Contenu du panneau "Droits & Devoirs" (modifiable par l'admin).
    infoPanel:
      "Bienvenue sur le portail INTER COLIS SERVICES.\n\n" +
      "VOS DROITS\n" +
      "• Congés payés : 2,5 jours ouvrables acquis par mois travaillé (année N et N-1).\n" +
      "• RCC (Repos Compensateur de Contrepartie) attribués selon les heures effectuées.\n" +
      "• Récupération des heures supplémentaires dues, en accord avec la direction.\n" +
      "• Consultation à tout moment de vos soldes et du planning de l'équipe.\n\n" +
      "VOS DEVOIRS\n" +
      "• Déposer vos demandes de congé via la plateforme, avec un délai de prévenance raisonnable.\n" +
      "• Respecter le planning validé et prévenir en cas d'absence imprévue.\n" +
      "• Les chauffeurs travaillent du lundi au samedi (hors dimanches et jours fériés).\n\n" +
      "Pour toute question, contactez votre administrateur.",
  },
};

let data = null;

function ensureLoaded() {
  if (data) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('Base corrompue, réinitialisation:', e.message);
      data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  } else {
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    persist();
  }
  // Garantir la présence des clés par défaut (migrations légères)
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (data[key] === undefined) data[key] = JSON.parse(JSON.stringify(DEFAULT_DATA[key]));
  }
  if (!data.settings.infoPanel) data.settings.infoPanel = DEFAULT_DATA.settings.infoPanel;
}

function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function getData() {
  ensureLoaded();
  return data;
}

function save() {
  ensureLoaded();
  persist();
}

function nextId(kind) {
  ensureLoaded();
  data.counters[kind] = (data.counters[kind] || 0) + 1;
  return `${kind}_${data.counters[kind]}`;
}

module.exports = { getData, save, nextId, DATA_FILE };
