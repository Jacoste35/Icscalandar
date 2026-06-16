'use strict';

const fs = require('fs');
const path = require('path');

// Couche de persistance compatible avec deux modes :
//   1. Redis (Upstash / Vercel KV) — pour les hébergements *serverless*
//      (Vercel) où le système de fichiers n'est pas conservé. Activé dès qu'une
//      URL Redis est présente dans l'environnement.
//   2. Fichier JSON local — pour le développement et les hébergements à
//      serveur permanent (Render, Docker, machine perso).
//
// Toute la base tient dans un seul document JSON (petite équipe), ce qui garde
// le code simple : on charge l'objet, on le modifie, on le ré-enregistre.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = process.env.REDIS_KEY || 'ics:database';

let redis = null;
if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
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
    { code: 'AEF', label: 'Absence évènement familial (sans retenue)', color: '#14b8a6', selectable: true, pool: null },
    { code: 'AT', label: 'Accident de travail', color: '#b91c1c', selectable: true, pool: null },
    { code: 'MNP', label: 'Maladie non professionnelle', color: '#f97316', selectable: true, pool: null },
    { code: 'ANRA', label: 'Absence non rémunérée (autorisée)', color: '#a16207', selectable: true, pool: null },
    { code: 'ANRN', label: 'Absence non rémunérée (non autorisée)', color: '#7f1d1d', selectable: true, pool: null },
    { code: 'AR', label: 'Absence rémunérée', color: '#65a30d', selectable: true, pool: null },
    { code: 'CSS', label: 'Congés sans solde', color: '#9333ea', selectable: true, pool: null },
    { code: 'PNE', label: 'Préavis non effectué', color: '#78716c', selectable: true, pool: null },
    { code: 'PNEP', label: 'Préavis non effectué payé', color: '#0891b2', selectable: true, pool: null },
    { code: 'CPA', label: 'Congé parental', color: '#c026d3', selectable: true, pool: null },
    { code: 'RCC', label: 'Repos compensateur complémentaire', color: '#4f46e5', selectable: true, pool: null },
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

function freshDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

// Migrations légères : garantir la présence des clés par défaut.
function migrate(d) {
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (d[key] === undefined) d[key] = JSON.parse(JSON.stringify(DEFAULT_DATA[key]));
  }
  if (!d.settings) d.settings = freshDefault().settings;
  if (!d.settings.infoPanel) d.settings.infoPanel = DEFAULT_DATA.settings.infoPanel;
  // Ajoute les catégories par défaut manquantes (nouveaux motifs d'absence)
  // sans écraser celles dont la couleur/le libellé ont été personnalisés.
  if (!Array.isArray(d.categories)) d.categories = freshDefault().categories;
  const haveCodes = new Set(d.categories.map((c) => c.code));
  for (const c of DEFAULT_DATA.categories) {
    if (!haveCodes.has(c.code)) d.categories.push(JSON.parse(JSON.stringify(c)));
  }
  return d;
}

// Charge la base depuis le stockage vers la mémoire. À appeler au début de
// chaque requête en mode serverless (les instances ne partagent pas la mémoire).
async function load() {
  if (USE_REDIS) {
    let raw = null;
    try {
      raw = await redis.get(REDIS_KEY);
    } catch (e) {
      console.error('Erreur lecture Redis:', e.message);
    }
    if (!raw) {
      data = freshDefault();
      await save();
    } else {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      try {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (e) {
        console.error('Base corrompue, réinitialisation:', e.message);
        data = freshDefault();
      }
    } else {
      data = freshDefault();
    }
  }
  migrate(data);
  return data;
}

async function save() {
  if (!data) return;
  if (USE_REDIS) {
    // Le SDK Upstash sérialise/désérialise le JSON automatiquement : on lui
    // passe l'objet directement (et load() gère objet ou chaîne au retour).
    await redis.set(REDIS_KEY, data);
  } else {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }
}

function getData() {
  if (!data) throw new Error('Base non chargée — appelez load() avant getData().');
  return data;
}

function nextId(kind) {
  data.counters[kind] = (data.counters[kind] || 0) + 1;
  return `${kind}_${data.counters[kind]}`;
}

module.exports = { load, save, getData, nextId, DATA_FILE, USE_REDIS };
