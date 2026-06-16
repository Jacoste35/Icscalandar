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

// Panneau "Droits & Devoirs" : repères réglementaires (droit du travail
// français). Indicatif — la convention collective applicable (transport
// routier pour les chauffeurs) et les accords d'entreprise peuvent prévoir des
// dispositions plus favorables. Éditable par l'administrateur.
const DEFAULT_INFO_PANEL =
  "PORTAIL INTER COLIS SERVICES — VOS DROITS & DEVOIRS\n" +
  "(Repères issus du Code du travail français. Document indicatif : la convention collective des transports routiers et les accords d'entreprise peuvent être plus favorables.)\n" +
  "\n" +
  "1. CONGÉS PAYÉS\n" +
  "• Acquisition : 2,5 jours ouvrables de congé par mois de travail effectif, soit 30 jours ouvrables (5 semaines) pour une année complète (art. L3141-3).\n" +
  "• Période de référence d'acquisition : en général du 1er juin au 31 mai (sauf accord d'entreprise).\n" +
  "• Le salarié doit pouvoir prendre au moins 12 jours ouvrables continus entre le 1er mai et le 31 octobre.\n" +
  "• Les dates de congés sont validées par l'employeur en fonction des nécessités de service.\n" +
  "\n" +
  "2. DURÉE DU TRAVAIL & HEURES SUPPLÉMENTAIRES\n" +
  "• Durée légale : 35 heures par semaine (art. L3121-27). Des régimes spécifiques existent pour les conducteurs (durée des transports routiers).\n" +
  "• Heures supplémentaires : majorées de 25 % pour les 8 premières heures au-delà de 35 h, puis de 50 % (sauf accord différent, au minimum 10 %).\n" +
  "• Elles peuvent être récupérées sous forme de repos compensateur équivalent (RCP) au lieu d'être payées, en accord avec la direction.\n" +
  "\n" +
  "3. REPOS & PAUSES\n" +
  "• Repos quotidien : au moins 11 heures consécutives entre deux journées de travail (art. L3131-1).\n" +
  "• Repos hebdomadaire : au moins 35 heures consécutives (24 h + 11 h), en principe le dimanche (art. L3132-2).\n" +
  "• Pause : au moins 20 minutes consécutives dès que le temps de travail atteint 6 heures (art. L3121-16).\n" +
  "• Les chauffeurs travaillent du lundi au samedi : ni le dimanche, ni les jours fériés.\n" +
  "\n" +
  "4. JOURS FÉRIÉS\n" +
  "• Le 1er mai est chômé et payé (art. L3133-4). Les autres jours fériés légaux sont gérés selon l'accord applicable.\n" +
  "\n" +
  "5. MATERNITÉ, PATERNITÉ & FAMILLE\n" +
  "• Congé maternité : en général 16 semaines (6 avant et 10 après l'accouchement), durée majorée selon le nombre d'enfants.\n" +
  "• Congé paternité et d'accueil de l'enfant : 25 jours calendaires (32 en cas de naissances multiples), depuis le 1er juillet 2021.\n" +
  "• Congés pour évènements familiaux (mariage, naissance, décès…) : selon le Code du travail et la convention collective, sans perte de salaire.\n" +
  "\n" +
  "6. MALADIE & ACCIDENT\n" +
  "• En cas d'arrêt maladie, prévenir l'employeur sans délai et transmettre l'avis d'arrêt de travail sous 48 heures.\n" +
  "• Accident du travail : informer l'employeur dans les 24 heures ; il établit la déclaration auprès de la CPAM.\n" +
  "\n" +
  "7. ABSENCES\n" +
  "• Toute absence doit être justifiée et signalée au plus tôt. Une absence non justifiée peut être considérée comme injustifiée (ABS) et donner lieu à retenue sur salaire, voire sanction.\n" +
  "\n" +
  "VOS DEVOIRS\n" +
  "• Déposer vos demandes de congé via la plateforme, en respectant un délai de prévenance raisonnable.\n" +
  "• Respecter le planning validé et prévenir immédiatement en cas d'absence imprévue.\n" +
  "• Respecter les durées de conduite et de repos, et les règles de sécurité.\n" +
  "\n" +
  "Pour toute question relative à vos droits, contactez votre responsable ou la direction. Sources : Légifrance (Code du travail) et service-public.fr.";

// Anciens contenus par défaut : si le panneau n'a pas été personnalisé, on le
// met automatiquement à jour vers DEFAULT_INFO_PANEL (voir migrate()).
const PREVIOUS_DEFAULT_INFO_PANELS = [
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
];

const DEFAULT_DATA = {
  users: [],
  groups: [
    { id: 'grp_gls', name: 'GLS', color: '#1d4ed8' },
    { id: 'grp_fedex', name: 'FedEx', color: '#7c3aed' },
    { id: 'grp_ciblex', name: 'Ciblex', color: '#dc2626' },
    { id: 'grp_joker', name: 'Joker', color: '#ea580c' },
    { id: 'grp_secretaire', name: 'Secrétaire', color: '#0d9488' },
    { id: 'grp_responsables', name: 'Responsables', color: '#854d0e' },
  ],
  requests: [],
  // Catégories d'absence (reprises du planning Excel), couleurs éditables.
  //   selectable  : false -> état dérivé (DCP), non listé comme motif réel.
  //   requestable : le salarié peut la demander lui-même (sinon admin seul).
  categories: [
    { code: 'DCP', label: 'Demande congé payé', color: '#f59e0b', selectable: false, requestable: false, pool: null },
    { code: 'CP', label: 'Congé payé', color: '#22c55e', selectable: true, requestable: true, pool: 'conges' },
    { code: 'RCP', label: 'Récupération', color: '#3b82f6', selectable: true, requestable: true, pool: 'recup' },
    { code: 'PMT', label: 'Congé maternité / paternité', color: '#ec4899', selectable: true, requestable: true, pool: null },
    { code: 'AM', label: 'Arrêt maladie', color: '#ef4444', selectable: true, requestable: false, pool: null },
    { code: 'ABS', label: 'Absence injustifiée', color: '#6b7280', selectable: true, requestable: false, pool: null },
    { code: 'AEF', label: 'Absence évènement familial (sans retenue)', color: '#14b8a6', selectable: true, requestable: false, pool: null },
    { code: 'AT', label: 'Accident de travail', color: '#b91c1c', selectable: true, requestable: false, pool: null },
    { code: 'MNP', label: 'Maladie non professionnelle', color: '#f97316', selectable: true, requestable: false, pool: null },
    { code: 'ANRA', label: 'Absence non rémunérée (autorisée)', color: '#a16207', selectable: true, requestable: false, pool: null },
    { code: 'ANRN', label: 'Absence non rémunérée (non autorisée)', color: '#7f1d1d', selectable: true, requestable: false, pool: null },
    { code: 'AR', label: 'Absence rémunérée', color: '#65a30d', selectable: true, requestable: false, pool: null },
    { code: 'CSS', label: 'Congés sans solde', color: '#9333ea', selectable: true, requestable: true, pool: null },
    { code: 'PNE', label: 'Préavis non effectué', color: '#78716c', selectable: true, requestable: false, pool: null },
    { code: 'PNEP', label: 'Préavis non effectué payé', color: '#0891b2', selectable: true, requestable: false, pool: null },
    { code: 'CPA', label: 'Congé parental', color: '#c026d3', selectable: true, requestable: false, pool: null },
    { code: 'RCC', label: 'Repos compensateur complémentaire', color: '#4f46e5', selectable: true, requestable: true, pool: null },
  ],
  counters: { user: 0, request: 0 },
  settings: {
    // Contenu du panneau "Droits & Devoirs" (modifiable par l'admin).
    infoPanel: DEFAULT_INFO_PANEL,
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
  if (!d.settings.infoPanel) d.settings.infoPanel = DEFAULT_INFO_PANEL;
  // Met à jour le panneau RH s'il correspond encore à un ancien défaut
  // (donc non personnalisé par l'administrateur).
  if (PREVIOUS_DEFAULT_INFO_PANELS.includes(d.settings.infoPanel)) {
    d.settings.infoPanel = DEFAULT_INFO_PANEL;
  }
  // Ajoute les groupes par défaut manquants (ex. Responsables).
  if (!Array.isArray(d.groups)) d.groups = freshDefault().groups;
  const haveGroups = new Set(d.groups.map((g) => g.id));
  for (const g of DEFAULT_DATA.groups) {
    if (!haveGroups.has(g.id)) d.groups.push(JSON.parse(JSON.stringify(g)));
  }
  // Ajoute les catégories par défaut manquantes (nouveaux motifs d'absence)
  // sans écraser celles dont la couleur/le libellé ont été personnalisés.
  if (!Array.isArray(d.categories)) d.categories = freshDefault().categories;
  const defByCode = Object.fromEntries(DEFAULT_DATA.categories.map((c) => [c.code, c]));
  const haveCodes = new Set(d.categories.map((c) => c.code));
  for (const c of DEFAULT_DATA.categories) {
    if (!haveCodes.has(c.code)) d.categories.push(JSON.parse(JSON.stringify(c)));
  }
  // Renseigne "requestable" sur les catégories existantes qui ne l'ont pas.
  for (const c of d.categories) {
    if (c.requestable === undefined) {
      c.requestable = defByCode[c.code] ? defByCode[c.code].requestable : false;
    }
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
