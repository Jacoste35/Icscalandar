'use strict';

const fs = require('fs');
const path = require('path');
const DEFAULT_REGLEMENT_HTML = require('./reglement-default');

// Règlement intérieur par défaut (version 1.0). Éditable par l'admin, versionné.
const DEFAULT_REGLEMENT = {
  version: 1,
  label: 'Version 1.0',
  updatedAt: '2026-01-01T00:00:00.000Z',
  content: DEFAULT_REGLEMENT_HTML,
  history: [{ version: 1, label: 'Version 1.0', updatedAt: '2026-01-01T00:00:00.000Z' }],
};

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
  "Convention collective applicable : Convention collective nationale des transports routiers et activités auxiliaires du transport (IDCC 16) — activité MESSAGERIE / FRET EXPRESS, transport de marchandises avec véhicules de moins de 3,5 tonnes (− 3,5 t).\n" +
  "(Repères issus du Code du travail et de la CCN des transports routiers. Document indicatif : la convention collective et les accords d'entreprise priment et peuvent être plus favorables.)\n" +
  "\n" +
  "1. CONGÉS PAYÉS\n" +
  "• Acquisition : 2,5 jours ouvrables de congé par mois de travail effectif, soit 30 jours ouvrables (5 semaines) pour une année complète (art. L3141-3).\n" +
  "• Période de référence d'acquisition : en général du 1er juin au 31 mai (sauf accord d'entreprise).\n" +
  "• Le salarié doit pouvoir prendre au moins 12 jours ouvrables continus entre le 1er mai et le 31 octobre.\n" +
  "• Les dates de congés sont validées par l'employeur en fonction des nécessités de service.\n" +
  "• ⚠️ IMPORTANT : les congés payés NON PRIS au 31 mai (fin de la période de prise) sont en principe PERDUS et ne sont ni reportés ni indemnisés, sauf report prévu par accord, situation assimilée (maladie, maternité…) ou si l'employeur a empêché leur prise (art. L3141-3 et s. du Code du travail). Anticipez vos demandes pour ne pas perdre vos droits.\n" +
  "\n" +
  "2. DURÉE DU TRAVAIL & HEURES SUPPLÉMENTAIRES\n" +
  "• Durée légale : 35 heures par semaine (art. L3121-27). Des régimes spécifiques existent pour les conducteurs (durée des transports routiers).\n" +
  "• Heures supplémentaires : majorées de 25 % pour les 8 premières heures au-delà de 35 h, puis de 50 % (sauf accord différent, au minimum 10 %).\n" +
  "• Elles peuvent être récupérées sous forme de repos compensateur équivalent (RCP) au lieu d'être payées, en accord avec la direction.\n" +
  "• ⚠️ Les RCC (repos compensateurs complémentaires) doivent être pris dans un délai de 3 MOIS suivant leur acquisition. À défaut de prise dans ce délai, ils sont remis à zéro et perdus (sauf report autorisé par la direction).\n" +
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
  "8. SPÉCIFICITÉS MESSAGERIE / − 3,5 t (CCN transports routiers, IDCC 16)\n" +
  "• Les conducteurs de véhicules ≤ 3,5 t relèvent du régime « messagerie / fret express » de la convention collective des transports routiers.\n" +
  "• Temps de service, amplitude, coupures, heures supplémentaires et repos sont encadrés par les accords de la branche transport ; ils peuvent différer du seul Code du travail.\n" +
  "• Une garantie annuelle de rémunération et des primes conventionnelles peuvent s'appliquer selon le coefficient et l'ancienneté.\n" +
  "• Pour le détail, se reporter au texte de la CCN (IDCC 16) et aux accords d'entreprise en vigueur.\n" +
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

// Vacances scolaires ZONE B (académies : Aix-Marseille, Amiens, Lille,
// Nancy-Metz, Nantes, Nice, Orléans-Tours, Reims, Rennes, Rouen, Strasbourg).
// Dates indicatives 2025-2026 et 2026-2027, modifiables par l'administrateur.
const SCHOOL_HOLIDAYS_VERSION = 2;
const DEFAULT_SCHOOL_HOLIDAYS_ZONE_B = [
  { label: 'Toussaint 2025 (Zone B)', start: '2025-10-18', end: '2025-11-03' },
  { label: 'Noël 2025 (Zone B)', start: '2025-12-20', end: '2026-01-05' },
  { label: 'Hiver 2026 (Zone B)', start: '2026-02-14', end: '2026-03-02' },
  { label: 'Printemps 2026 (Zone B)', start: '2026-04-11', end: '2026-04-27' },
  { label: 'Été 2026 (Zone B)', start: '2026-07-04', end: '2026-08-31' },
  { label: 'Toussaint 2026 (Zone B)', start: '2026-10-17', end: '2026-11-02' },
  { label: 'Noël 2026 (Zone B)', start: '2026-12-19', end: '2027-01-04' },
  { label: 'Hiver 2027 (Zone B)', start: '2027-02-13', end: '2027-03-01' },
  { label: 'Printemps 2027 (Zone B)', start: '2027-04-10', end: '2027-04-26' },
];

// Consommables suivis pour l'analyse de durabilité et les alertes d'entretien.
//   normVille / normRoute = kilométrage de référence constructeur selon l'usage
//     (ville = trajets urbains, plus usants ; route = grands trajets + ville).
//   interval = valeur indicative générique (repli) ; l'intervalle réel est
//     affiné par la moyenne des remplacements enregistrés pour CHAQUE véhicule.
const DEFAULT_CONSUMABLES = [
  { code: 'pneus_av', label: 'Pneus avant', interval: 50000, normVille: 30000, normRoute: 50000 },
  { code: 'pneus_ar', label: 'Pneus arrière', interval: 60000, normVille: 35000, normRoute: 60000 },
  { code: 'freins_av', label: 'Freins avant', interval: 55000, normVille: 30000, normRoute: 55000 },
  { code: 'freins_ar', label: 'Freins arrière', interval: 70000, normVille: 40000, normRoute: 70000 },
  { code: 'service_a', label: 'Service A (révision intermédiaire)', interval: 30000, normVille: 20000, normRoute: 30000 },
  { code: 'service_b', label: 'Service B (grande révision)', interval: 60000, normVille: 40000, normRoute: 60000 },
  { code: 'vidange', label: 'Vidange', interval: 30000, normVille: 20000, normRoute: 30000 },
];

const DEFAULT_DATA = {
  users: [],
  groups: [
    { id: 'grp_president', name: 'Président', color: '#1e1b4b' },
    { id: 'grp_gls', name: 'GLS', color: '#1d4ed8' },
    { id: 'grp_fedex', name: 'FedEx', color: '#7c3aed' },
    { id: 'grp_ciblex', name: 'Ciblex', color: '#dc2626' },
    { id: 'grp_joker', name: 'Joker', color: '#ea580c' },
    { id: 'grp_secretaire', name: 'Secrétaire', color: '#0d9488' },
    { id: 'grp_responsables', name: 'Responsables', color: '#854d0e' },
    { id: 'grp_resp_gls', name: 'Responsable GLS', color: '#1e3a8a' },
    { id: 'grp_resp_ciblex', name: 'Responsable Ciblex', color: '#991b1b' },
    { id: 'grp_resp_fedex', name: 'Responsable FedEx', color: '#5b21b6' },
    { id: 'grp_resp_exploitation', name: 'Responsable Exploitation', color: '#115e59' },
  ],
  requests: [],
  // Parc de véhicules (flotte) et son suivi.
  vehicles: [],            // { id, name, plate, model, km, baseKm, active, createdAt }
  vehicleReports: [],      // signalements d'usure des chauffeurs (en attente d'examen)
  vehicleMaint: [],        // remplacements de pièces enregistrés par l'admin
  vehicleInspections: [],  // tours de véhicule (chocs/dommages relevés)
  // Catégories d'absence (reprises du planning Excel), couleurs éditables.
  //   selectable  : false -> état dérivé (DCP), non listé comme motif réel.
  //   requestable : le salarié peut la demander lui-même (sinon admin seul).
  //   pool        : 'conges' (CP -> N/N-1). Récupération impute les heures sup.,
  //                 RCC impute le compteur RCC dédié (géré dans deductionFor).
  categories: [
    { code: 'DCP', label: 'Demande congé payé', color: '#f59e0b', selectable: false, requestable: false, pool: null },
    { code: 'CP', label: 'Congé payé', color: '#22c55e', selectable: true, requestable: true, pool: 'conges' },
    { code: 'RCP', label: 'Récupération (heures sup.)', color: '#3b82f6', selectable: true, requestable: true, pool: null },
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
    { code: 'MAP', label: 'Mise à pied conservatoire', color: '#1e293b', selectable: true, requestable: false, pool: null },
    { code: 'RET', label: 'Retard', color: '#fb7185', selectable: true, requestable: false, pool: null },
  ],
  counters: { user: 0, request: 0 },
  settings: {
    // Contenu du panneau "Droits & Devoirs" (modifiable par l'admin).
    infoPanel: DEFAULT_INFO_PANEL,
    // Vacances scolaires ZONE B (surbrillance bleu pâle sur le calendrier).
    // Dates indicatives — modifiables dans Administration > Vacances & fermetures.
    schoolHolidays: DEFAULT_SCHOOL_HOLIDAYS_ZONE_B,
    // Journées fermées à la prise de congé (ex. fêtes de fin d'année).
    closedPeriods: [],
    // Règlement intérieur (versionné, éditable par l'administrateur).
    reglement: JSON.parse(JSON.stringify(DEFAULT_REGLEMENT)),
    // Consommables suivis pour les alertes d'entretien des véhicules.
    vehicleConsumables: JSON.parse(JSON.stringify(DEFAULT_CONSUMABLES)),
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
  // Met à jour le panneau RH s'il correspond encore à un ancien défaut (non
  // personnalisé par l'administrateur). On reconnaît un panneau "par défaut" à
  // son en-tête ; on ne le remplace que s'il ne contient pas déjà les dernières
  // mentions légales (CP perdus au 31 mai).
  const PANEL_SENTINEL = 'PORTAIL INTER COLIS SERVICES — VOS DROITS & DEVOIRS';
  if (PREVIOUS_DEFAULT_INFO_PANELS.includes(d.settings.infoPanel)
      || (d.settings.infoPanel.startsWith(PANEL_SENTINEL) && !d.settings.infoPanel.includes('NON PRIS au 31 mai'))) {
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
  // RCP n'a plus de "pool" (impute toujours les heures sup.).
  const rcp = d.categories.find((c) => c.code === 'RCP');
  if (rcp) rcp.pool = null;
  // Nouveaux réglages : vacances scolaires et fermetures.
  if (!Array.isArray(d.settings.closedPeriods)) d.settings.closedPeriods = [];
  // (Re)pose les vacances scolaires Zone B si absentes ou version dépassée.
  if (!Array.isArray(d.settings.schoolHolidays) || (d.settings.schoolHolidaysVersion || 0) < SCHOOL_HOLIDAYS_VERSION) {
    d.settings.schoolHolidays = JSON.parse(JSON.stringify(DEFAULT_SCHOOL_HOLIDAYS_ZONE_B));
    d.settings.schoolHolidaysVersion = SCHOOL_HOLIDAYS_VERSION;
  }
  // Règlement intérieur versionné (initialise si absent).
  if (!d.settings.reglement || !d.settings.reglement.content) {
    d.settings.reglement = JSON.parse(JSON.stringify(DEFAULT_REGLEMENT));
  }
  if (!Array.isArray(d.settings.reglement.history)) {
    d.settings.reglement.history = [{ version: d.settings.reglement.version || 1, label: d.settings.reglement.label || 'Version 1.0', updatedAt: d.settings.reglement.updatedAt || DEFAULT_REGLEMENT.updatedAt }];
  }
  // Parc de véhicules (présence des tableaux + consommables par défaut).
  if (!Array.isArray(d.vehicles)) d.vehicles = [];
  if (!Array.isArray(d.vehicleReports)) d.vehicleReports = [];
  if (!Array.isArray(d.vehicleMaint)) d.vehicleMaint = [];
  if (!Array.isArray(d.vehicleInspections)) d.vehicleInspections = [];
  if (!Array.isArray(d.settings.vehicleConsumables) || !d.settings.vehicleConsumables.length) {
    d.settings.vehicleConsumables = JSON.parse(JSON.stringify(DEFAULT_CONSUMABLES));
  }
  // Ajoute les normes constructeur (ville/route) aux consommables existants.
  const consDef = Object.fromEntries(DEFAULT_CONSUMABLES.map((c) => [c.code, c]));
  for (const c of d.settings.vehicleConsumables) {
    const def = consDef[c.code];
    if (c.normVille === undefined) c.normVille = def ? def.normVille : (c.interval || 30000);
    if (c.normRoute === undefined) c.normRoute = def ? def.normRoute : (c.interval || 50000);
  }
  // Champs récents des véhicules (portabilité des données lors des mises à jour).
  for (const v of d.vehicles) {
    if (v.baseKm === undefined || v.baseKm === null) v.baseKm = Number(v.km) || 0;
    if (v.active === undefined) v.active = true;
    if (v.usage === undefined) v.usage = 'mixte';            // 'ville' | 'mixte'
    if (v.relais === undefined) v.relais = false;
    if (v.groupId === undefined) v.groupId = null;
    if (v.tournee === undefined) v.tournee = null;
    if (v.assignedUserId === undefined) v.assignedUserId = null;
    if (v.assignedUserName === undefined) v.assignedUserName = null;
    if (!v.documents || typeof v.documents !== 'object') v.documents = {};
  }
  // Champs récents des signalements véhicule.
  for (const r of d.vehicleReports) {
    if (!Array.isArray(r.resolutions)) r.resolutions = [];
    if (r.resolution === undefined) r.resolution = null;     // 'done' | 'notdone' | null
  }
  // Champs utilisateur récents.
  for (const u of d.users) {
    if (u.isParent === undefined) u.isParent = false;
    if (u.username === undefined) u.username = null;
    if (u.phone === undefined) u.phone = null;
    if (u.hireDate === undefined) u.hireDate = null;
    if (u.suspended === undefined) u.suspended = false;
    if (u.rccAnchor === undefined) u.rccAnchor = new Date().toISOString().slice(0, 10);
    if (u.cguAccepted === undefined) u.cguAccepted = false;
    if (u.reglementAccepted === undefined) u.reglementAccepted = false;
    if (u.reglementAcceptedAt === undefined) u.reglementAcceptedAt = null;
    // Version du règlement acceptée (0 = aucune). Les comptes ayant déjà accepté
    // l'ancien règlement (booléen) sont réputés avoir accepté la version 1.
    if (u.reglementAcceptedVersion === undefined) u.reglementAcceptedVersion = u.reglementAccepted ? 1 : 0;
    if (!Array.isArray(u.unavail)) u.unavail = [];
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
  applyAccruals(data);
  applyRccReset(data);
  return data;
}

// Remet le compteur RCC à 0 selon un cycle GLISSANT de 3 mois à partir de la
// date d'attribution (rccAnchor), si le salarié ne l'a pas posé.
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function applyRccReset(d) {
  const today = new Date().toISOString().slice(0, 10);
  for (const u of d.users) {
    if (!u.rccAnchor) { u.rccAnchor = today; continue; }
    // Échéance = ancre + 3 mois ; au-delà, on remet à 0 et on réamorce.
    while (addMonths(u.rccAnchor, 3) <= today) {
      u.balances.rcc = 0;
      u.rccAnchor = addMonths(u.rccAnchor, 3);
    }
  }
}

// Acquisition automatique des congés payés : +2,5 j par mois (de mai à mai),
// à partir du moment où l'administrateur a paramétré la première valeur N.
// Calcul paresseux et idempotent : on rattrape les mois écoulés depuis le
// dernier crédit. Le mois est repéré par "AAAA-MM" (comparaison lexicale).
function ym(date) {
  const m = date.getMonth() + 1;
  return `${date.getFullYear()}-${m < 10 ? '0' + m : m}`;
}
function ymNext(s) {
  let [y, m] = s.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${m < 10 ? '0' + m : m}`;
}
function applyAccruals(d) {
  const cur = ym(new Date());
  for (const u of d.users) {
    if (!u.cpAccrualEnabled || !u.cpAccrualYM) continue;
    let guard = 0;
    while (u.cpAccrualYM < cur && guard < 240) {
      u.balances.congesN = Math.round((u.balances.congesN + 2.5) * 100) / 100;
      u.cpAccrualYM = ymNext(u.cpAccrualYM);
      guard += 1;
    }
  }
}

// Active l'acquisition automatique pour un utilisateur (au 1er paramétrage de N).
function enableAccrual(u) {
  if (!u.cpAccrualEnabled) {
    u.cpAccrualEnabled = true;
    u.cpAccrualYM = ym(new Date()); // le crédit démarre le mois suivant
  }
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

module.exports = { load, save, getData, nextId, enableAccrual, DATA_FILE, USE_REDIS };
