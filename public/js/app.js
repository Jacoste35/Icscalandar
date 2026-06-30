'use strict';

/* =========================================================================
   INTER COLIS SERVICES — Portail RH (SPA)
   ========================================================================= */

const State = {
  token: localStorage.getItem('ics_token') || null,
  user: null,
  groups: [],
  categories: [],
  catByCode: {},
  pools: {},
  holidays: {},
  schoolHolidays: [],
  closedPeriods: [],
  reglement: null,
  view: 'dashboard',
  // état du calendrier (colorBy : 'category' ou 'group')
  cal: { mode: 'month', cursor: new Date(), colorBy: 'category' },
  _holidayYear: null,
};

const $app = document.getElementById('app');

/* ------------------------------ Utils ----------------------------------- */
const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const DOW = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];
const DOW_SHORT = ['Lun','Mar','Mer','Jeu','Ven','Sam'];

function pad(n) { return String(n).padStart(2, '0'); }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtDate(s) { const d = parseISO(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }
// Date en toutes lettres, ex. « Lundi 22 Juin 2026 ».
function fmtDateLong(s) { const d = parseISO(s); const mon = MONTHS[d.getMonth()]; return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${mon.charAt(0).toUpperCase() + mon.slice(1)} ${d.getFullYear()}`; }
// Période en toutes lettres : un seul jour, ou « du … au … ».
function fmtPeriodLong(start, end) { return start === end ? fmtDateLong(start) : `du ${fmtDateLong(start)} au ${fmtDateLong(end)}`; }
function fmtDateTime(s) { const d = new Date(s); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDateTimeS(s) { const d = new Date(s); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function startOfWeekMonday(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a, b) { return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

// Helpers catégories (DCP, CP, RCP, PMT, AM, ABS) — chargées depuis le serveur.
function catLabel(code) { const c = State.catByCode[code]; return c ? c.label : code; }
function catColor(code) { const c = State.catByCode[code]; return c ? c.color : '#64748b'; }
// Couleur d'un événement selon le mode d'affichage choisi.
function evColor(ev) { return State.cal.colorBy === 'group' ? ev.groupColor : ev.categoryColor; }
function roleLabel(role) { return role === 'admin' ? 'Administrateur' : role === 'responsable' ? 'Responsable' : 'Salarié'; }
function isStaff() { return State.user.role === 'admin' || State.user.role === 'responsable'; }
// Libellé du "pool" (solde imputé) d'une demande, ex. " · Congés N-1".
function poolLabel(r) {
  if (!r.pool) return '';
  const o = (State.pools[r.category] || []).find((p) => p.value === r.pool);
  return o ? ' · ' + o.label : '';
}
// Libellé complet d'une demande : catégorie + solde imputé.
function reqLabel(r) { return catLabel(r.category) + poolLabel(r); }
// Affiche les heures pour une récupération imputée sur les heures sup.
function reqHours(r) { return (r.category === 'RCP' || r.category === 'RCC') ? ` (${r.hours}h)` : ''; }

// Ancienneté à partir d'une date d'embauche : { years, months, days } et texte.
function ancienneteParts(hireDate) {
  if (!hireDate) return null;
  const start = parseISO(hireDate); const now = new Date();
  let y = now.getFullYear() - start.getFullYear();
  let m = now.getMonth() - start.getMonth();
  let d = now.getDate() - start.getDate();
  if (d < 0) { m -= 1; d += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (m < 0) { y -= 1; m += 12; }
  if (y < 0) return { years: 0, months: 0, days: 0 };
  return { years: y, months: m, days: d };
}
function ancienneteText(hireDate) {
  const p = ancienneteParts(hireDate);
  if (!p) return '—';
  return `${p.years} an${p.years>1?'s':''}, ${p.months} mois, ${p.days} j`;
}
// Sélection d'une phrase qui change chaque jour (index = jour calendaire).
// L'offset évite que toutes les cartes tombent sur le même indice le même jour.
function dailyPick(arr, offset) { return arr[(Math.floor(Date.now() / 86400000) + (offset || 0)) % arr.length]; }

// Message de remerciement proportionnel à l'ancienneté (change tous les jours).
function anciennetePhilo(hireDate) {
  const p = ancienneteParts(hireDate);
  if (!p) return '';
  const y = p.years;
  const s = y > 1 ? 's' : '';
  if (y < 1) return dailyPick([
    "Bienvenue dans l'aventure ! Vos premiers pas comptent déjà pour toute l'équipe. 🌱",
    "Nouvelle recrue, nouvelle énergie : ravis de vous compter parmi nous. Bon vent ! 🚀",
    "Chaque grande carrière commence par un premier jour. Le vôtre est déjà prometteur. 🌱",
    "Bienvenue ! Votre motivation des débuts est une vraie richesse pour le collectif. ✨",
    "Les premiers mois forgent les meilleurs souvenirs. Heureux de débuter cette route avec vous. 🛣️",
  ], 1);
  if (y < 3) return dailyPick([
    `${y} an${s} déjà : votre engagement prend racine. Merci pour votre implication ! 🌿`,
    `${y} an${s} parmi nous et déjà un repère pour l'équipe. Continuez ainsi ! 🌿`,
    `Deux saisons et plus à vos côtés : votre fiabilité se confirme jour après jour. Merci ! 🍃`,
    `${y} an${s} de présence : vous connaissez désormais nos rouages sur le bout des doigts. Bravo ! 👏`,
  ], 1);
  if (y < 5) return dailyPick([
    `${y} ans de fidélité : votre expérience est précieuse pour le collectif. Merci de votre constance. 🌳`,
    `${y} ans déjà : vous êtes une valeur sûre sur qui l'on peut compter. Reconnaissance sincère. 🌳`,
    `${y} années de sérieux et de régularité : un bel exemple pour toute l'équipe. Merci ! 🙏`,
    `${y} ans à nos côtés : votre savoir-faire fait gagner tout le monde. Chapeau ! 🎩`,
  ], 1);
  if (y < 10) return dailyPick([
    `${y} ans parmi nous : un pilier de la maison. Votre dévouement force le respect. Merci infiniment. 🏅`,
    `${y} ans de loyauté : votre expérience est un repère pour les plus jeunes. Merci pour tout. 🏅`,
    `Près d'une décennie ensemble : votre engagement est une fierté pour l'entreprise. Bravo et merci ! 🥇`,
    `${y} ans de fidélité sans faille : vous incarnez les valeurs de la maison. Profonde gratitude. 🙌`,
  ], 1);
  return dailyPick([
    `${y} ans de loyauté : une véritable mémoire vivante de l'entreprise. Du fond du cœur, merci pour tout. 🎖️`,
    `${y} ans à nos côtés : votre constance est exceptionnelle. Toute la direction vous est reconnaissante. 🎖️`,
    `Plus de dix ans d'engagement : un parcours remarquable qui inspire le respect. Merci infiniment. 🏆`,
    `${y} années de fidélité : vous faites partie de l'histoire de la maison. Merci pour cette belle aventure. 💛`,
  ], 1);
}
// Nombre de retards (RET validés) d'un utilisateur depuis N jours.
function retardCountSince(requests, sinceDays) {
  const limit = iso(addDays(new Date(), -sinceDays));
  return requests.filter((r) => r.category === 'RET' && r.status === 'approved' && r.startDate >= limit).length;
}

// Message philosophique selon le nombre de retards sur l'année (motivation).
function philoMessageHTML(retardYear) {
  const pick = (arr) => dailyPick(arr, 0);
  let bg, emoji, msg;
  if (retardYear === 0) {
    bg = 'var(--ok)'; emoji = '🌟';
    msg = pick([
      "« La ponctualité est la politesse des rois. » Merci pour votre dévouement et votre régularité exemplaire.",
      "Toujours à l'heure : votre fiabilité est un pilier de l'équipe. Merci pour votre engagement sans faille.",
      "« Le succès, c'est se lever une fois de plus qu'on est tombé. » Votre constance fait la force du collectif. Bravo !",
      "Zéro retard cette année : un sans-faute remarquable. Votre sérieux fait honneur à toute l'équipe. 👏",
      "« Le temps, c'est du respect. » Et vous le respectez chaque matin. Merci pour cet exemple.",
      "Votre ponctualité est une certitude pour vos collègues. Un grand merci pour cette fiabilité.",
      "« Bien commencer la journée, c'est déjà la moitié du travail. » Vous le prouvez tous les jours. 🌅",
    ]);
  } else if (retardYear <= 3) {
    bg = '#eab308'; emoji = '⏳';
    msg = pick([
      "« Mieux vaut prévenir que guérir. » Quelques retards seulement : un petit effort et vous visez le sans-faute !",
      "Chaque minute compte pour l'équipe. Vous êtes sur la bonne voie, gardez le cap !",
      "« Le temps perdu ne se rattrape jamais. » Anticipez vos trajets, vous y êtes presque.",
      "Presque irréprochable ! Un dernier coup de collier sur les départs et c'est le sans-faute. 💪",
      "« Qui se lève tôt n'a rien à craindre. » Encore un effort, le zéro retard est à portée de main.",
      "Vous tenez le bon rythme. Un réveil cinq minutes plus tôt et l'objectif est atteint !",
    ]);
  } else if (retardYear <= 5) {
    bg = '#f97316'; emoji = '⚠️';
    msg = pick([
      "« La discipline est le pont entre les objectifs et les réalisations. » Quelques retards de trop : reprenons de bonnes habitudes ensemble.",
      "Votre équipe compte sur vous chaque matin. Un effort sur la ponctualité ferait une vraie différence.",
      "« Qui veut voyager loin ménage sa monture… et part à l'heure. » Anticipons davantage les départs.",
      "Il est temps de reprendre le contrôle de vos horaires. Vous avez les capacités, fixons-nous l'objectif zéro retard.",
      "« Les petites habitudes font les grandes réussites. » Changeons une habitude le matin, le reste suivra.",
      "Un trajet préparé la veille, c'est une matinée sereine. Essayons cette semaine !",
    ]);
  } else {
    bg = 'var(--danger)'; emoji = '🚨';
    msg = pick([
      "« On ne récolte que ce que l'on sème. » Le nombre de retards devient préoccupant : un vrai changement d'habitude est nécessaire.",
      "La ponctualité est une marque de respect envers vos collègues. Reprenons ensemble le contrôle de vos horaires.",
      "« Demain est aujourd'hui ce qu'aujourd'hui était hier. » Agissons dès maintenant pour inverser la tendance.",
      "Trop de retards cette année. Parlons-en ensemble : il existe sûrement des solutions concrètes pour repartir du bon pied.",
      "« Le premier pas est toujours le plus difficile. » Faisons-le dès demain matin, ensemble.",
      "Vos collègues commencent leur tournée sans vous : chaque retard pèse sur l'équipe. Reprenons la maîtrise du temps.",
    ]);
  }
  return `<div class="card" style="border-left:5px solid ${bg}"><h3 style="margin:0">${emoji} Ponctualité</h3><p style="margin:.4rem 0 0">${msg}</p>${retardYear>0?`<p class="help" style="margin:.3rem 0 0">${retardYear} retard(s) enregistré(s) sur l'année.</p>`:''}</div>`;
}

/* ------------------------------ API ------------------------------------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (State.token) opts.headers['Authorization'] = 'Bearer ' + State.token;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status === 401) { logout(true); }
    const err = new Error(data.error || 'Erreur serveur');
    err.payload = data;
    throw err;
  }
  return data;
}

/* ------------------------------ Toast ----------------------------------- */
function toast(msg, kind = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
}

/* ------------------------------ Modal ----------------------------------- */
function modal({ title, bodyHTML, footHTML, onMount }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <header><h3>${esc(title)}</h3><button class="close-x" data-close>&times;</button></header>
      <div class="body">${bodyHTML}</div>
      ${footHTML ? `<div class="foot">${footHTML}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.hasAttribute('data-close')) closeModal(); });
  if (onMount) onMount(overlay);
}
function closeModal() { const m = document.getElementById('modal-overlay'); if (m) m.remove(); }

/* ------------------------------ Auth ------------------------------------ */
function logout(silent) {
  State.token = null; State.user = null;
  localStorage.removeItem('ics_token');
  if (!silent) toast('Vous êtes déconnecté.', 'info');
  renderAuth();
}

async function boot() {
  if (State.token) {
    try {
      const { user } = await api('GET', '/me');
      State.user = user;
      await loadRefs();
      renderApp();
      return;
    } catch (e) { State.token = null; localStorage.removeItem('ics_token'); }
  }
  renderAuth();
}

async function loadRefs() {
  const [{ groups }, cats, { holidays }, settings, reglement] = await Promise.all([
    api('GET', '/groups'),
    api('GET', '/categories'),
    api('GET', '/holidays?year=' + new Date().getFullYear()),
    api('GET', '/settings'),
    api('GET', '/reglement').catch(() => null),
  ]);
  State.groups = groups;
  State.categories = cats.categories;
  State.pools = cats.pools || {};
  State.catByCode = Object.fromEntries(cats.categories.map((c) => [c.code, c]));
  State.holidays = holidays;
  State.schoolHolidays = settings.schoolHolidays || [];
  State.closedPeriods = settings.closedPeriods || [];
  State.reglement = reglement;
  State._holidayYear = new Date().getFullYear();
  await loadPendingDocs();
}

// Documents adressés au salarié non encore signés (bloquent l'accès au compte).
async function loadPendingDocs() {
  try { const { documents } = await api('GET', '/admin/erp/my-documents'); State.pendingDocs = (documents || []).filter((d) => d.status !== 'acked'); }
  catch (e) { State.pendingDocs = []; }
}
// Contenu du règlement (serveur si disponible, sinon repli local).
function reglementContent() { return (State.reglement && State.reglement.content) || window.REGLEMENT_INTERIEUR_HTML || ''; }
function reglementVersion() { return (State.reglement && State.reglement.version) || 1; }

// Indique si une date (AAAA-MM-JJ) tombe en vacances scolaires (Zone B).
function schoolHolidayFor(ds) {
  return (State.schoolHolidays || []).find((h) => ds >= h.start && ds <= h.end) || null;
}
// Indique si une date tombe dans une période fermée à la prise de congé.
function closedPeriodFor(ds) {
  return (State.closedPeriods || []).find((p) => ds >= p.start && ds <= p.end) || null;
}

async function ensureHolidays(year) {
  if (State._holidayYear === year) return;
  try {
    const { holidays } = await api('GET', '/holidays?year=' + year);
    State.holidays = Object.assign({}, State.holidays, holidays);
    State._holidayYear = year;
  } catch (e) {}
}

function groupById(id) { return State.groups.find((g) => g.id === id) || null; }

/* =========================================================================
   AUTH SCREEN
   ========================================================================= */
function renderAuth(tab = 'login') {
  $app.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-hero">
      <div class="logo"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" alt="" class="hero-logo" /> INTER COLIS SERVICES</div>
      <h1>Le portail de suivi de vos congés et absences</h1>
      <p>Suivez vos congés payés, vos RCC et vos heures de récupération. Déposez vos demandes en ligne et consultez le planning de toute l'équipe.</p>
      <ul>
        <li>Soldes de congés N / N-1, RCC et heures sup. en temps réel</li>
        <li>Calendrier d'équipe par jour, semaine, mois et année</li>
        <li>Dépôt et suivi de vos demandes de congé</li>
      </ul>
    </div>
    <div class="auth-panel">
      <div class="auth-card">
        <div class="auth-tabs">
          <button data-tab="login" class="${tab==='login'?'active':''}">Connexion</button>
          <button data-tab="register" class="${tab==='register'?'active':''}">Inscription</button>
        </div>
        <div id="auth-form"></div>
      </div>
    </div>
  </div>`;
  $app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => renderAuth(b.dataset.tab));
  document.getElementById('auth-form').innerHTML = tab === 'login' ? loginForm() : registerForm();
  if (tab === 'login') bindLogin(); else bindRegister();
}

function loginForm() {
  return `
    <h2>Connexion</h2>
    <p class="sub">Accédez à votre espace personnel.</p>
    <form id="form-login">
      <label>Email ou nom de compte</label>
      <input name="login" type="text" required autocomplete="username" />
      <label>Mot de passe</label>
      <input name="password" type="password" required autocomplete="current-password" />
      <button class="btn full" type="submit">Se connecter</button>
    </form>`;
}
function bindLogin() {
  document.getElementById('form-login').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const { user, token } = await api('POST', '/login', { login: f.login.value, password: f.password.value });
      State.token = token; State.user = user; localStorage.setItem('ics_token', token);
      await loadRefs();
      toast('Bienvenue ' + user.firstName + ' !', 'ok');
      renderApp();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function registerForm() {
  return `
    <h2>Créer un compte</h2>
    <p class="sub">Votre inscription sera validée par l'administrateur, qui attribuera vos soldes.</p>
    <form id="form-register">
      <div class="row">
        <div><label>Prénom</label><input name="firstName" required /></div>
        <div><label>Nom</label><input name="lastName" required /></div>
      </div>
      <label>Nom de compte (automatique)</label>
      <input name="username" readonly placeholder="prenom.nom" style="background:#f1f5f9;color:#475569" />
      <p class="help">Généré automatiquement. C'est avec ce nom que vous vous connecterez.</p>
      <label>Téléphone</label>
      <input name="phone" type="tel" autocomplete="tel" placeholder="06 12 34 56 78" />
      <label>Date d'entrée dans l'entreprise</label>
      <input name="hireDate" type="date" />
      <label>Email</label>
      <input name="email" type="email" required autocomplete="email" />
      <label>Mot de passe</label>
      <input name="password" type="password" required minlength="6" autocomplete="new-password" />
      <p class="help">6 caractères minimum.</p>
      <button class="btn full accent" type="submit">Envoyer ma demande</button>
    </form>`;
}
function clientSlug(s) {  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
}
// Validation des formats (email + téléphone français/international).
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }
function isValidPhone(s) {
  const v = String(s || '').replace(/[\s.\-]/g, '');
  return v === '' || /^(?:\+?\d{1,3})?0?\d{9,10}$/.test(v);
}
// Normalise un numéro FR en "06 12 34 56 78" si possible.
function formatPhone(s) {
  const v = String(s || '').replace(/[\s.\-]/g, '');
  if (/^0\d{9}$/.test(v)) return v.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  return String(s || '').trim();
}
function bindRegister() {
  const f = document.getElementById('form-register');
  const sync = () => { f.username.value = `${clientSlug(f.firstName.value)}.${clientSlug(f.lastName.value)}`.replace(/^\.|\.$/g, ''); };
  f.firstName.addEventListener('input', sync);
  f.lastName.addEventListener('input', sync);
  f.phone.addEventListener('blur', () => { f.phone.value = formatPhone(f.phone.value); });
  document.getElementById('form-register').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!isValidEmail(f.email.value)) { toast('Adresse email invalide.', 'err'); return; }
    if (!isValidPhone(f.phone.value)) { toast('Numéro de téléphone invalide.', 'err'); return; }
    try {
      const r = await api('POST', '/register', {
        firstName: f.firstName.value, lastName: f.lastName.value,
        email: f.email.value, password: f.password.value, phone: formatPhone(f.phone.value), hireDate: f.hireDate.value,
      });
      if (r.token) {
        State.token = r.token; State.user = r.user; localStorage.setItem('ics_token', r.token);
        await loadRefs();
        toast(r.message, 'ok');
        renderApp();
      } else {
        toast(r.message, 'ok');
        renderAuth('login');
      }
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* =========================================================================
   APP SHELL
   ========================================================================= */
// Menu organisé en groupes dépliables. « Accueil » reste seul en haut.
function navSections() {
  const admin = State.user.role === 'admin';
  const staff = isStaff(); // admin OU responsable
  const groups = [];
  groups.push({ id: 'home', solo: true, items: [{ id: 'dashboard', icon: '🏠', label: 'Accueil' }] });
  groups.push({ id: 'planning', icon: '📅', title: 'Planning & Organisation', items: [
    { id: 'calendar', icon: '📅', label: 'Mon planning' },
    { id: 'organigramme', icon: '🏢', label: 'Organigramme' },
    { id: 'requests', icon: '📝', label: 'Événements' },
  ] });
  groups.push({ id: 'space', icon: '👤', title: 'Mon espace', items: [
    { id: 'mydata', icon: '👤', label: 'Mon profil' },
    { id: 'mydocs', icon: '📁', label: 'Mes documents' },
    { id: 'team', icon: '👥', label: 'Mon équipe' },
    { id: 'myvehicle', icon: '🚐', label: 'Mon véhicule' },
  ] });
  // Ressources Humaines
  const rh = [];
  if (admin || staff) rh.push({ id: 'absmgmt', icon: '🗂️', label: 'Gestion des absences' });
  if (admin || staff) rh.push({ id: 'hours', icon: '⏱️', label: 'Gestion des heures' });
  if (admin || staff) rh.push({ id: 'docmgmt', icon: '📄', label: 'Gestion des procédures' });
  if (rh.length) groups.push({ id: 'rh', icon: '👥', title: 'Ressources Humaines', items: rh });
  // Exploitation & Transport
  const exp = [];
  // Gestion des Tournées masquée pour le moment (à la demande).
  // if (admin) exp.push({ id: 'tours', icon: '🛣️', label: 'Gestion des Tournées' });
  if (admin || staff) exp.push({ id: 'geoloc', icon: '🛰️', label: 'Géolocalisation' });
  if (admin || staff) exp.push({ id: 'carburant', icon: '⛽', label: 'Gestion du carburant' });
  if (admin || staff) exp.push({ id: 'vehmgmt', icon: '🔧', label: 'Gestion des Véhicules' });
  if (admin) exp.push({ id: 'fleet', icon: '🚚', label: 'Gestion de la Flotte' });
  if (admin) exp.push({ id: 'stocks', icon: '🛠️', label: 'Suivi entretiens & stock' });
  if (exp.length) groups.push({ id: 'exploit', icon: '🚚', title: 'Exploitation & Transport', items: exp });
  if (admin) {
    groups.push({ id: 'fin', icon: '💰', title: 'Finance & Facturation', items: [
      { id: 'billing', icon: '🧾', label: 'Facturation' },
      { id: 'justif', icon: '🧾', label: 'Notes de frais' },
      { id: 'finance', icon: '💶', label: 'Contrôle financier' },
      { id: 'tender', icon: '📐', label: 'Devis, Appel d\'offres' },
    ] });
    groups.push({ id: 'docs', icon: '📑', title: 'Contrats', items: [
      { id: 'contracts', icon: '📑', label: 'Contrats clients' },
    ] });
    groups.push({ id: 'adm', icon: '⚙️', title: 'Administration', items: [
      { id: 'admin', icon: '⚙️', label: 'Administration' },
    ] });
  }
  groups.push({ id: 'infos', icon: 'ℹ️', title: 'Informations', items: [{ id: 'info', icon: 'ℹ️', label: 'Droits & devoirs' }] });
  return groups;
}
// Bouton d'élément de menu (vue).
function navItemBtn(it) {
  return `<button data-view="${it.id}" class="${State.view === it.id ? 'active' : ''}"><span class="ico">${it.icon}</span> ${it.label}${it.id === 'admin' ? '<span class="badge" id="admin-badge" style="display:none"></span>' : ''}</button>`;
}
// Groupes dépliés (persisté entre les rendus).
let _navOpen = new Set();

let adminBadgeCount = 0;

// Page de garde / conditions d'utilisation, affichée au tout premier accès.
function renderCGU() {
  const u = State.user;
  $app.innerHTML = `
  <div class="cgu-wrap">
    <div class="cgu-card">
      <div class="cgu-head"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" class="cgu-logo" alt=""><h1>Bienvenue ${esc(u.firstName)}</h1></div>
      <p class="cgu-lead">Avant d'accéder au portail, merci de lire et d'accepter les conditions d'utilisation ci-dessous.</p>
      <div class="cgu-body">
        <h3>1. Objet du site</h3>
        <p>Ce portail est un <strong>outil d'organisation interne</strong> destiné à faciliter le suivi des congés payés, des absences, des heures de récupération (RCC, heures supplémentaires) et du planning des équipes d'INTER COLIS SERVICES. Il a une finalité <strong>purement organisationnelle et informative</strong>.</p>
        <h3>2. Congés payés et absences</h3>
        <p>Conformément aux articles <strong>L3141-15 et L3141-16 du Code du travail</strong>, <strong>l'employeur fixe l'ordre et les dates des départs en congé</strong> en fonction des nécessités du service, de l'organisation et de l'activité de l'entreprise.</p>
        <p>Le dépôt ou la demande d'une date de congé via ce site <strong>ne vaut en aucun cas attribution ou acceptation automatique</strong>. Toute demande doit faire l'objet d'une <strong>validation expresse de la direction</strong> pour être effective. L'enregistrement d'une demande dans l'outil ne crée aucun droit acquis sur la période sollicitée.</p>
        <p>L'employeur se réserve le droit, pour des raisons de service, de modifier ou refuser une demande, et de fermer certaines périodes à la prise de congé.</p>
        <h3>3. Exactitude des informations</h3>
        <p>Les soldes et compteurs affichés sont fournis à titre indicatif. En cas de divergence, les éléments contractuels et les bulletins de paie font foi.</p>
        <h3>4. Protection des données personnelles (RGPD)</h3>
        <p>Dans le cadre du fonctionnement du site, INTER COLIS SERVICES traite des données strictement nécessaires : <strong>nom, prénom, nom de compte, mot de passe (chiffré), email, numéro de téléphone, groupe de travail, date d'entrée, soldes de congés et historique des absences</strong>.</p>
        <ul>
          <li><strong>Finalité :</strong> gestion et organisation des congés et absences.</li>
          <li><strong>Base légale :</strong> intérêt légitime de l'employeur et obligations liées à la gestion du personnel.</li>
          <li><strong>Destinataires :</strong> la direction et l'encadrement habilité de l'entreprise uniquement.</li>
          <li><strong>Conservation :</strong> pendant la durée du contrat de travail et les délais légaux applicables.</li>
          <li><strong>Vos droits :</strong> accès, rectification, effacement et limitation de vos données, en vous adressant à la direction (responsable de traitement), conformément au RGPD et à la loi « Informatique et Libertés ».</li>
        </ul>
        <p>Les données ne sont ni revendues ni transmises à des tiers à des fins commerciales.</p>
      </div>
      <label class="cgu-check"><input type="checkbox" id="cgu-ok"> J'ai lu et j'accepte les conditions d'utilisation et la politique de confidentialité ci-dessus.</label>
      <div class="cgu-actions">
        <button class="btn ghost" id="cgu-logout">Se déconnecter</button>
        <button class="btn accent" id="cgu-accept" disabled>Accéder au portail</button>
      </div>
    </div>
  </div>`;
  const chk = document.getElementById('cgu-ok');
  const acc = document.getElementById('cgu-accept');
  chk.onchange = () => { acc.disabled = !chk.checked; };
  document.getElementById('cgu-logout').onclick = () => logout();
  acc.onclick = async () => {
    try { const r = await api('POST', '/me/accept-cgu'); State.user = r.user; toast('Bienvenue ! Bonne utilisation.', 'ok'); renderApp(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

// Déclaration d'acceptation du règlement intérieur. Tout le monde est « salarié ».
function reglementDeclaration(u) {
  const v = State.reglement ? ` (${esc(State.reglement.label || ('Version ' + reglementVersion()))})` : '';
  return `Je soussigné(e), <strong>${esc(u.firstName)} ${esc(u.lastName)}</strong>, salarié(e) de la société INTER COLIS SERVICES, en qualité de <strong>salarié</strong>, déclare avoir reçu ce jour un exemplaire du Règlement Intérieur de la Société INTER COLIS SERVICES${v}, en avoir pris connaissance et m'engager à le respecter dans son intégralité. Fait à Éterville, le ${fmtDate(iso(new Date()))}.`;
}
// L'utilisateur a-t-il accepté la version EN VIGUEUR du règlement ?
function reglementUpToDate(u) { return (u.reglementAcceptedVersion || 0) >= reglementVersion(); }

// Page de garde : lecture obligatoire du règlement intérieur au 1er accès
// (et à chaque nouvelle version mise en ligne par l'administrateur).
function renderReglementGate() {
  const u = State.user;
  const isUpdate = (u.reglementAcceptedVersion || 0) > 0;
  $app.innerHTML = `
  <div class="cgu-wrap">
    <div class="cgu-card" style="max-width:900px">
      <div class="cgu-head"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" class="cgu-logo" alt=""><h1>Règlement intérieur</h1></div>
      <p class="cgu-lead">${isUpdate ? 'Le règlement intérieur a été <strong>mis à jour</strong>. Merci de prendre connaissance de la nouvelle version et de l\'accepter.' : 'Avant d\'accéder au portail, vous devez prendre connaissance du règlement intérieur de l\'entreprise et l\'accepter.'} ${State.reglement ? `<br><span class="help">${esc(State.reglement.label || '')} — en vigueur depuis le ${fmtDate((State.reglement.updatedAt||'').slice(0,10))}</span>` : ''}</p>
      <div class="cgu-body reglement-scroll">${reglementContent() || '<p>Règlement indisponible.</p>'}</div>
      <label class="cgu-check"><input type="checkbox" id="ri-ok"> ${reglementDeclaration(u)}</label>
      <div class="cgu-actions">
        <button class="btn ghost" id="ri-logout">Se déconnecter</button>
        <button class="btn accent" id="ri-accept" disabled>Accepter et accéder au portail</button>
      </div>
    </div>
  </div>`;
  const chk = document.getElementById('ri-ok');
  const acc = document.getElementById('ri-accept');
  chk.onchange = () => { acc.disabled = !chk.checked; };
  document.getElementById('ri-logout').onclick = () => logout();
  acc.onclick = async () => {
    try { const r = await api('POST', '/me/accept-reglement'); State.user = r.user; toast('Règlement intérieur accepté. Bonne utilisation !', 'ok'); renderApp(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

// Documents que le salarié a ouverts pendant cette session (avant signature).
const _docsOpened = new Set();
// Page de garde : documents adressés à signer avant d'accéder au compte.
function renderDocumentsGate() {
  const u = State.user;
  const docs = State.pendingDocs || [];
  $app.innerHTML = `
  <div class="cgu-wrap"><div class="cgu-card" style="max-width:780px">
    <div class="cgu-head"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" class="cgu-logo" alt=""><h1>Document(s) à signer</h1></div>
    <p class="cgu-lead">${esc(u.firstName)}, un ou plusieurs documents vous ont été adressés par la direction. Vous devez les <strong>lire</strong> puis les <strong>signer électroniquement</strong> (accusé de réception et de lecture horodaté) pour accéder à votre compte.</p>
    <div class="cgu-body" style="max-height:50vh">
      ${docs.map((d) => `<div class="card" data-grow="${d.id}" style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.6rem">
        <div style="min-width:0"><strong>${esc(d.label)}</strong><div class="help">Émis le ${fmtDate((d.createdAt || '').slice(0, 10))} · <span class="g-state">${(_docsOpened.has(d.id) || d.viewedAt) ? '✅ lu' : 'à lire'}</span></div></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn ghost sm" data-gview="${d.id}">📄 Lire le document</button><button class="btn ok sm" data-gsign="${d.id}">✍️ Signer</button></div>
      </div>`).join('')}
    </div>
    <p class="help">La signature électronique vaut reconnaissance d'avoir reçu et pris connaissance du document. Elle est horodatée et conservée à titre de preuve.</p>
    <div class="cgu-actions"><button class="btn ghost" id="docs-logout">Se déconnecter</button></div>
  </div></div>`;
  document.getElementById('docs-logout').onclick = () => logout();
  $app.querySelectorAll('[data-gview]').forEach((b) => b.onclick = () => {
    const id = b.dataset.gview; _docsOpened.add(id);
    api('POST', '/admin/erp/documents/' + id + '/seen').catch(() => {});
    erpOpenHtml('GET', '/admin/erp/documents/' + id + '/view');
    const row = b.closest('[data-grow]'); const st = row && row.querySelector('.g-state'); if (st) st.textContent = '✅ lu';
  });
  $app.querySelectorAll('[data-gsign]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.gsign;
    const d = docs.find((x) => x.id === id);
    if (!_docsOpened.has(id) && !(d && d.viewedAt)) { toast('Veuillez d\'abord lire le document (bouton « Lire le document »).', 'warn'); return; }
    if (!confirm('Je certifie sur l\'honneur avoir reçu et pris connaissance de ce document. Confirmer la signature ?')) return;
    try {
      const r = await api('POST', '/admin/erp/documents/' + id + '/ack');
      toast('Document signé le ' + (r.stamp || '') + '.', 'ok');
      State.pendingDocs = (State.pendingDocs || []).filter((x) => x.id !== id);
      if (State.pendingDocs.length) renderDocumentsGate(); else { await loadPendingDocs(); renderApp(); }
    } catch (e) { toast(e.message, 'err'); }
  });
}

function renderApp() {
  const u = State.user;
  // Pages de garde au premier accès : CGU puis règlement intérieur (version en vigueur).
  if (!u.cguAccepted) { renderCGU(); return; }
  if (!reglementUpToDate(u)) { renderReglementGate(); return; }
  // Documents adressés non signés : lecture + signature obligatoires pour entrer.
  if (State.pendingDocs && State.pendingDocs.length) { renderDocumentsGate(); return; }
  const sections = navSections();
  // Ouvre automatiquement le groupe contenant la vue active.
  const activeGroup = sections.find((s) => !s.solo && s.items.some((it) => it.id === State.view));
  if (activeGroup) _navOpen.add(activeGroup.id);
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" alt="" class="brand-logo" /><span>Inter Colis Services</span></div>
      <button class="nav-toggle" id="nav-toggle" aria-label="Menu">☰</button>
      <nav id="nav">
        ${sections.map((s) => s.solo
          ? s.items.map(navItemBtn).join('')
          : `<div class="nav-group ${_navOpen.has(s.id) ? 'open' : ''}" data-group="${s.id}">
               <button class="nav-group-head" data-navgroup="${s.id}"><span class="ico">${s.icon}</span><span class="nav-group-title">${s.title}</span>${s.id === 'adm' ? '<span class="badge" id="admin-group-badge" style="display:none"></span>' : ''}<span class="nav-caret">▸</span></button>
               <div class="nav-group-items">${s.items.map(navItemBtn).join('')}</div>
             </div>`
        ).join('')}
      </nav>
      <div class="userbox">
        <div class="name">${esc(u.firstName)} ${esc(u.lastName)}</div>
        <div class="role">${roleLabel(u.role)}</div>
        <button class="btn ghost sm" id="logout" style="color:#fff;border-color:rgba(255,255,255,.3)">Déconnexion</button>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>
  <nav class="bottom-nav" id="bottom-nav">
    <button data-view="dashboard" class="${State.view === 'dashboard' ? 'active' : ''}"><span class="bn-ico">🏠</span>Accueil</button>
    <button data-view="calendar" class="${State.view === 'calendar' ? 'active' : ''}"><span class="bn-ico">📅</span>Planning</button>
    <button data-view="mydata" class="${State.view === 'mydata' ? 'active' : ''}"><span class="bn-ico">👤</span>Profil</button>
    <button id="bn-menu"><span class="bn-ico">☰</span>Menu</button>
  </nav>`;
  $app.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { State.view = b.dataset.view; renderApp(); });
  // Dépliage/repliage des groupes de menu (sans recharger la vue).
  $app.querySelectorAll('[data-navgroup]').forEach((b) => b.onclick = () => {
    const g = b.closest('.nav-group'); const id = b.dataset.navgroup;
    const open = !g.classList.contains('open');
    g.classList.toggle('open', open);
    if (open) _navOpen.add(id); else _navOpen.delete(id);
  });
  document.getElementById('logout').onclick = () => logout();
  const toggle = document.getElementById('nav-toggle');
  if (toggle) toggle.onclick = () => document.querySelector('.sidebar').classList.toggle('nav-open');
  // Barre basse (mobile) : le bouton « Menu » ouvre/ferme le tiroir latéral.
  const bnMenu = document.getElementById('bn-menu');
  if (bnMenu) bnMenu.onclick = () => { const sb = document.querySelector('.sidebar'); sb.classList.toggle('nav-open'); if (sb.classList.contains('nav-open')) sb.scrollIntoView({ block: 'start' }); };
  // En navigation depuis la barre basse, on referme le tiroir s'il était ouvert.
  $app.querySelectorAll('.bottom-nav [data-view]').forEach((b) => b.addEventListener('click', () => document.querySelector('.sidebar').classList.remove('nav-open')));
  renderView();
  if (u.role === 'admin') refreshAdminBadge();
}

async function refreshAdminBadge() {
  try {
    const { users } = await api('GET', '/admin/pending');
    const { requests } = await api('GET', '/admin/requests');
    const pendingReq = requests.filter((r) => r.status === 'pending').length;
    adminBadgeCount = users.length + pendingReq;
    [document.getElementById('admin-badge'), document.getElementById('admin-group-badge')].forEach((el) => {
      if (el && adminBadgeCount > 0) { el.style.display = ''; el.textContent = adminBadgeCount; }
    });
  } catch (e) {}
}

function renderView() {
  const main = document.getElementById('main');
  const v = State.view;
  if (v === 'dashboard') return renderDashboard(main);
  if (v === 'calendar') return renderCalendar(main);
  if (v === 'mydata') return renderMyData(main);
  if (v === 'mydocs') return renderMyDocs(main);
  if (v === 'requests') return renderRequests(main);
  if (v === 'team') return renderTeam(main);
  if (v === 'organigramme') return renderOrganigramme(main);
  if (v === 'absmgmt') return renderAbsenceManagement(main);
  if (v === 'myvehicle') return renderMyVehicle(main);
  if (v === 'vehmgmt') return renderVehicleManagement(main);
  if (v === 'info') return renderInfo(main);
  if (v === 'admin') return renderAdmin(main);
  if (v === 'stocks') return renderStocks(main);
  if (v === 'fleet') return renderFleet(main);
  if (v === 'finance') return renderFinance(main);
  if (v === 'docmgmt') return renderDocMgmt(main);
  if (v === 'billing') return renderBilling(main);
  if (v === 'justif') return renderJustif(main);
  if (v === 'tender') return renderTender(main);
  if (v === 'contracts') return renderContracts(main);
  if (v === 'hours') return renderHours(main);
  if (v === 'tours') return renderTours(main);
  if (v === 'geoloc') return renderGeoloc(main);
  if (v === 'carburant') return renderCarburant(main);
}

/* =========================================================================
   CARBURANT — import & suivi des transactions AS 24
   ========================================================================= */
const euro2 = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
let _fuelTab = 'analyse';
async function renderCarburant(main) {
  if (!isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>⛽ Gestion du carburant</h1>
    <p>Analyse de la consommation par chauffeur, détection des surconsommations & vols, et pilotage des cartes AS 24.</p></div></div>
    <div class="view-switch" id="fuel-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-ftab="analyse" class="active">📊 Analyse</button>
      <button data-ftab="params">⚙️ Paramètres</button>
    </div>
    <div id="fuel-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#fuel-tabs');
  const setActive = () => tabs.querySelectorAll('[data-ftab]').forEach((b) => b.classList.toggle('active', b.dataset.ftab === _fuelTab));
  tabs.querySelectorAll('[data-ftab]').forEach((b) => b.onclick = () => { _fuelTab = b.dataset.ftab; setActive(); loadCarburant(); });
  setActive();
  await loadCarburant();
}
async function loadCarburant() {
  const body = document.getElementById('fuel-body'); if (!body) return;
  let d;
  try { d = await api('GET', '/staff/fuel'); } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  body.className = '';
  if (_fuelTab === 'params') return fuelParamsTab(body, d);
  return fuelAnalyseTab(body, d);
}
// --- Onglet Analyse : KPI + graphique & tableau par chauffeur + véhicules ----
function fuelAnalyseTab(body, d) {
  const s = d.summary || {};
  const an = d.analysis || { vehicles: [], alerts: [], alertCount: 0, refConso: 11, threshold: 15, tankCapacity: 100 };
  const da = d.driverAnalysis || { drivers: [], refConso: an.refConso };
  const nAlert = an.vehicles.filter((v) => v.level === 'alert').length;
  const nWarn = an.vehicles.filter((v) => v.level === 'warn').length;
  const consoVals = an.vehicles.map((v) => v.realConso).filter((x) => x != null);
  const fleetConso = consoVals.length ? Math.round(consoVals.reduce((a, b) => a + b, 0) / consoVals.length * 10) / 10 : null;
  const kpiTone = nAlert ? 'tone-alert' : nWarn ? 'tone-warn' : 'tone-ok';
  const s30 = d.summary30 || {}, sy = d.summaryYear || {}, year = d.year || '';
  const cards = `<div class="fuel-kpi-grid">
    <div class="fuel-kpi"><div class="fk-val">${fleetConso != null ? fleetConso + ' <small>L/100</small>' : '—'}</div><div class="fk-lbl">Conso moyenne flotte</div><div class="fk-sub">référence ${an.refConso} L/100</div></div>
    <div class="fuel-kpi ${kpiTone}"><div class="fk-val">${an.alertCount}</div><div class="fk-lbl">Alertes surconso / vol</div><div class="fk-sub">${nAlert} véhicule(s) en alerte</div></div>
    <div class="fuel-kpi"><div class="fk-val">${(s30.liters || 0).toLocaleString('fr-FR')} <small>L</small></div><div class="fk-lbl">Litres — 30 jours</div><div class="fk-sub">${s30.count || 0} pleins</div></div>
    <div class="fuel-kpi"><div class="fk-val">${(sy.liters || 0).toLocaleString('fr-FR')} <small>L</small></div><div class="fk-lbl">Litres — année ${esc(String(year))}</div><div class="fk-sub">${sy.count || 0} pleins</div></div>
    <div class="fuel-kpi"><div class="fk-val">${euro2(s30.ht || 0)} <small>HT</small></div><div class="fk-lbl">Dépense — 30 jours</div><div class="fk-sub">TTC ${euro2(s30.ttc || 0)}</div></div>
    <div class="fuel-kpi"><div class="fk-val">${euro2(sy.ht || 0)} <small>HT</small></div><div class="fk-lbl">Dépense — année ${esc(String(year))}</div><div class="fk-sub">TTC ${euro2(sy.ttc || 0)}</div></div>
  </div>`;
  const alertRow = (a) => {
    const head = `<div class="al-main"><span class="al-veh">${esc(a.vehicle)}</span> ${a.date ? `<span class="help">${esc(a.date)}</span> ` : ''}${esc(a.text)}${a.driver ? ` <span class="al-drv">👤 ${esc(a.driver)}</span>` : ''}</div>`;
    const actions = !d.isAdmin ? '' : a.decision === 'fraud'
      ? `<div class="al-actions"><span class="al-badge al-fraud">🚩 Fraude confirmée</span> <button class="btn ghost sm" data-aundo="${esc(a.key)}">annuler</button></div>`
      : `<div class="al-actions"><button class="btn danger sm" data-afraud="${esc(a.key)}">🚩 Fraude confirmée</button> <button class="btn ghost sm" data-afalse="${esc(a.key)}">✓ Faux positif</button></div>`;
    return `<li class="al-${a.level}${a.decision === 'fraud' ? ' al-done' : ''}">${head}${actions}</li>`;
  };
  const allAlerts = an.alerts || [];
  const fps = allAlerts.filter((a) => a.decision === 'false_positive');
  const shown = allAlerts.filter((a) => a.decision !== 'false_positive'); // en attente + fraudes
  // Les faux positifs sont regroupés dans une seule case (pas de liste détaillée).
  const fpBox = (d.isAdmin && fps.length) ? `<div class="fuel-fp-box">✓ <strong>${fps.length}</strong> alerte(s) classée(s) en faux positif <button class="btn ghost sm" id="fuel-fp-reset">rétablir</button></div>` : '';
  const alertsBlock = (shown.length || fps.length) ? `<details class="card fuel-alerts" open>
      <summary><strong>🚨 Alertes à contrôler (${an.alertCount})</strong> <span class="help">surconsommation ou vol potentiel — confirmez la fraude ou marquez un faux positif</span></summary>
      ${shown.length ? `<ul class="fuel-alert-list">${shown.map(alertRow).join('')}</ul>` : '<p class="help" style="margin:.4rem 0 0">Aucune alerte en attente. ✅</p>'}
      ${fpBox}
    </details>` : `<div class="alert ok">✅ Aucune surconsommation anormale détectée (réf. ${an.refConso} L/100, seuil +${an.threshold}%).</div>`;
  // --- Graphique + tableau PAR CHAUFFEUR (30 jours glissants) ---
  const drivers = da.drivers || [];
  const chart = drivers.length ? geoSvgBars(drivers.map((x, i, arr) => ({ label: x.key, value: x.costHT, valueLabel: euro2(x.costHT), color: geoRankColor(i, arr.length) }))) : '';
  const consoCellD = (x) => x.realConso == null ? '<span class="help">km AS 24 manquant</span>'
    : `<strong style="color:${x.deviationPct > an.threshold ? '#b91c1c' : x.deviationPct > an.threshold / 2 ? '#b45309' : '#166534'}">${x.realConso} L/100</strong> <span class="help">(${x.deviationPct >= 0 ? '+' : ''}${x.deviationPct}%)</span>`;
  const arrow = (p) => p == null ? '' : (p > 0 ? `<span style="color:#b91c1c">▲ +${p}%</span>` : p < 0 ? `<span style="color:#166534">▼ ${p}%</span>` : '<span class="help">→ 0%</span>');
  // Cellule d'évolution mois précédent → mois en cours (coût & conso).
  const monthCell = (x) => {
    const m = x.month || {}; if (!m.curMonth) return '<span class="help">—</span>';
    const cost = `Coût : ${euro2(m.prevCostHT || 0)} → <strong>${euro2(m.curCostHT || 0)}</strong> ${arrow(m.dCostPct)}`;
    const conso = (m.curConso != null || m.prevConso != null) ? `<div>Conso : ${m.prevConso != null ? m.prevConso + ' L/100' : '—'} → <strong>${m.curConso != null ? m.curConso + ' L/100' : '—'}</strong> ${arrow(m.dConsoPct)}</div>` : '';
    return `<div class="help" style="font-size:.78rem"><div>${cost}</div>${conso}</div>`;
  };
  // Indicateur : réel (30 j complets) ou projection (fictif, fond translucide).
  const indicCell = (x) => {
    let html;
    if (!x.projected) html = `<span class="pill ok">30 j complets</span>`;
    else html = `<span class="fuel-proj" title="${x.windowDays} j de données — valeur indicative">≈ projection ${euro2(x.estCostHT30)}/30j${x.projBasis === 'gps' && x.weeklyKm ? ` · ${x.weeklyKm} km/sem GPS` : ''}</span>`;
    if (x.compare) html += `<div class="help" style="margin-top:.2rem">${x.compare.status === 'alert' ? '⚠️' : '✅'} Projection ${x.compare.status === 'alert' ? 'à revoir' : 'tenue'} : prévu ${euro2(x.compare.projectedCostHT)} → réel ${euro2(x.compare.realCostHT)} (${x.compare.deviationPct >= 0 ? '+' : ''}${x.compare.deviationPct}%)</div>`;
    return html;
  };
  const moLbl = drivers[0] && drivers[0].month ? `${esc(drivers[0].month.prevMonth || '')} → ${esc(drivers[0].month.curMonth || '')}` : 'mois préc. → en cours';
  const driverBlock = `<div class="card"><h3 style="margin-top:0">📊 Analyse km / consommation & attribution chauffeur</h3>
    <p class="help">Sur 30 jours glissants (jusqu'au ${da.asOf ? esc(da.asOf) : '—'}). Consommation « tank-to-tank » d'après le kilométrage des pleins. Une période incomplète est <strong>projetée sur 30 j</strong> à partir des km GPS de la semaine (affichée en <span class="fuel-proj">translucide</span> = indicatif) ; au prochain import, la projection est confrontée au réel.</p>
    ${chart ? `<div class="geo-chart-wrap"><div class="geo-chart-title">Coût HT par chauffeur (30 j)</div>${chart}</div>` : ''}
    ${drivers.length ? `<div class="table-wrap"><table class="report-table"><thead><tr><th>Chauffeur</th><th style="text-align:center">Pleins</th><th style="text-align:right">Litres 30j</th><th style="text-align:right">Conso réelle</th><th style="text-align:right">Coût HT 30j</th><th>Évolution (${moLbl})</th><th>Indicateur</th></tr></thead>
      <tbody>${drivers.map((x) => `<tr class="${x.projected ? 'fuel-row-proj' : ''}">
        <td><strong>${esc(x.key)}</strong></td>
        <td style="text-align:center">${x.fills}</td>
        <td style="text-align:right">${x.liters.toLocaleString('fr-FR')} L</td>
        <td style="text-align:right">${consoCellD(x)}</td>
        <td style="text-align:right"><strong>${euro2(x.costHT)}</strong></td>
        <td>${monthCell(x)}</td>
        <td>${indicCell(x)}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="alert info">Aucune donnée chauffeur. Importez un export AS 24 et associez les cartes aux chauffeurs dans Paramètres.</div>'}
  </div>`;
  // --- Détail par véhicule (repliable) ---
  const lvlPill = (lv, txt) => `<span class="pill ${lv === 'alert' ? 'warn' : lv === 'warn' ? 'draft' : 'ok'}">${txt}</span>`;
  const consoCellV = (v) => v.realConso == null ? '<span class="help">km AS 24 manquant</span>'
    : `<strong style="color:${v.level === 'alert' ? '#b91c1c' : v.level === 'warn' ? '#b45309' : '#166534'}">${v.realConso} L/100</strong> <span class="help">(${v.deviationPct >= 0 ? '+' : ''}${v.deviationPct}%)</span>`;
  const vehBlock = an.vehicles && an.vehicles.length ? `<details class="card"><summary><strong>🚚 Détail par véhicule</strong> <span class="help">${an.vehicles.length} véhicule(s)</span></summary>
      <div class="table-wrap" style="margin-top:.6rem"><table class="report-table"><thead><tr><th>Véhicule</th><th>Chauffeur proposé</th><th style="text-align:center">Pleins</th><th style="text-align:right">Litres</th><th style="text-align:right">Conso réelle</th><th style="text-align:center">État</th></tr></thead>
      <tbody>${an.vehicles.map((v) => `<tr>
        <td><strong>${esc(v.vehicle)}</strong>${v.plate ? `<div class="help">${esc(v.plate)}</div>` : ''}</td>
        <td>${v.driver ? `${esc(v.driver.name)} <span class="help">${v.driver.share}% des pleins</span>` : '<span class="help">—</span>'}</td>
        <td style="text-align:center">${v.fills}</td>
        <td style="text-align:right">${v.liters.toLocaleString('fr-FR')} L</td>
        <td style="text-align:right">${consoCellV(v)}</td>
        <td style="text-align:center">${lvlPill(v.level, v.level === 'alert' ? 'Surconso' : v.level === 'warn' ? 'À surveiller' : 'OK')}</td>
      </tr>`).join('')}</tbody></table></div></details>` : '';
  // --- Transactions (repliable) ---
  const txns = (d.transactions || []).length ? `<details class="card"><summary><strong>🧾 Transactions (${(d.transactions || []).length})</strong> <span class="help">détail des pleins AS 24</span></summary>
    <div class="table-wrap" style="margin-top:.6rem"><table class="report-table"><thead><tr><th>Date</th><th>Station</th><th>Véhicule</th><th>Chauffeur</th><th style="text-align:right">Litres</th><th style="text-align:right">HT</th><th style="text-align:right">TTC</th><th>État</th>${d.isAdmin ? '<th></th>' : ''}</tr></thead>
    <tbody>${d.transactions.map((t) => `<tr>
      <td>${esc(t.date)}${t.time ? ' ' + esc(t.time) : ''}</td><td>${esc(t.place)}</td><td>${esc(t.vehicleName)}</td><td>${esc(t.driver)}</td>
      <td style="text-align:right">${(t.liters || 0).toLocaleString('fr-FR')}</td><td style="text-align:right">${euro2(t.amountHT || 0)}</td><td style="text-align:right">${euro2(t.amountTTC)}</td>
      <td><span class="pill ${t.state && t.state.toLowerCase().indexOf('non') === -1 ? 'paid' : 'draft'}">${esc(t.state || '')}</span></td>
      ${d.isAdmin ? `<td><button class="btn ghost sm" data-fueldel="${t.id}">✕</button></td>` : ''}</tr>`).join('')}</tbody></table></div></details>`
    : '<div class="alert info">Aucune transaction. Importez un export AS 24 dans l\'onglet Paramètres.</div>';

  // --- Calibration : conso estimée (GPS archivée) vs pleins réels (AS 24) ---
  const cal = d.calibration || { vehicles: [] };
  const calibBlock = cal.vehicles && cal.vehicles.length ? `<details class="card"><summary><strong>🎯 Calibration : conso estimée (GPS) vs pleins réels</strong> <span class="help">${esc(cal.from || '')} → ${esc(cal.to || '')}</span></summary>
      <p class="help" style="margin-top:.6rem">La consommation estimée par GPS est archivée chaque jour. On la confronte aux litres réellement achetés (AS 24) sur la période : un écart régulier indique qu'il faut ajuster la consommation de référence du modèle.</p>
      <div class="table-wrap"><table class="report-table"><thead><tr><th>Véhicule</th><th style="text-align:right">Conso estimée (GPS)</th><th style="text-align:right">Pleins réels (AS 24)</th><th style="text-align:right">Écart</th></tr></thead>
      <tbody>${cal.vehicles.map((v) => { const col = Math.abs(v.deviationPct) > 15 ? '#b91c1c' : Math.abs(v.deviationPct) > 8 ? '#b45309' : '#166534'; return `<tr>
        <td><strong>${esc(v.vehicleName)}</strong>${v.plate ? `<div class="help">${esc(v.plate)}</div>` : ''}</td>
        <td style="text-align:right">${v.estLiters.toLocaleString('fr-FR')} L</td>
        <td style="text-align:right">${v.realLiters.toLocaleString('fr-FR')} L</td>
        <td style="text-align:right"><strong style="color:${col}">${v.deviationPct >= 0 ? '+' : ''}${v.deviationPct}%</strong></td>
      </tr>`; }).join('')}</tbody></table></div>
      <p class="help">Écart = (pleins réels ÷ conso estimée − 1). Positif : le véhicule consomme plus que l'estimation GPS (relevez la conso de référence). Négatif : l'estimation est trop haute.</p>
    </details>` : '';

  body.innerHTML = cards + alertsBlock + driverBlock + vehBlock + calibBlock + txns;
  if (d.isAdmin) {
    const decide = async (key, status) => { try { await api('POST', '/staff/fuel/alert-decision', { key, status }); toast(status === 'fraud' ? 'Fraude confirmée.' : status === 'false_positive' ? 'Marquée faux positif.' : 'Décision annulée.', 'ok'); loadCarburant(); } catch (e) { toast(e.message, 'err'); } };
    body.querySelectorAll('[data-afraud]').forEach((b) => b.onclick = () => decide(b.dataset.afraud, 'fraud'));
    body.querySelectorAll('[data-afalse]').forEach((b) => b.onclick = () => decide(b.dataset.afalse, 'false_positive'));
    body.querySelectorAll('[data-aundo]').forEach((b) => b.onclick = () => decide(b.dataset.aundo, ''));
    const fpReset = body.querySelector('#fuel-fp-reset');
    if (fpReset) fpReset.onclick = async () => {
      if (!confirm(`Rétablir les ${fps.length} alerte(s) classée(s) faux positif ?`)) return;
      try { for (const a of fps) await api('POST', '/staff/fuel/alert-decision', { key: a.key, status: '' }); toast('Alertes rétablies.', 'ok'); loadCarburant(); } catch (e) { toast(e.message, 'err'); }
    };
    body.querySelectorAll('[data-fueldel]').forEach((b) => b.onclick = async () => {
      if (!confirm('Supprimer cette transaction ?')) return;
      try { await api('DELETE', '/staff/fuel/' + b.dataset.fueldel); loadCarburant(); } catch (e) { toast(e.message, 'err'); }
    });
  }
}
// --- Onglet Paramètres : association carte→chauffeur, réglages, import --------
function fuelParamsTab(body, d) {
  if (!d.isAdmin) { body.innerHTML = `<div class="alert info">Réservé à l'administrateur.</div>`; return; }
  const an = d.analysis || { refConso: 11, threshold: 15, tankCapacity: 100 };
  const users = d.users || [], cards = d.cards || [], dMap = d.fuelDriverMap || {}, vMap = d.fuelCardMap || {};
  const vehicles = d.vehicles || [];
  const userOpt = (sel) => `<option value="">— chauffeur —</option>` + users.map((u) => `<option value="${u.id}" ${sel === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const vehOpt = (sel) => `<option value="">— véhicule —</option>` + vehicles.map((v) => `<option value="${v.id}" ${sel === v.id ? 'selected' : ''}>${esc(v.name)}${v.plate ? ' (' + esc(v.plate) + ')' : ''}</option>`).join('');
  const cardsBlock = cards.length ? `<div class="table-wrap"><table class="report-table"><thead><tr><th>Carte AS 24</th><th>Chauffeur (relevé)</th><th style="text-align:center">Pleins</th><th>Associer au chauffeur</th><th>Associer au véhicule</th></tr></thead>
      <tbody>${cards.map((c) => `<tr>
        <td><strong>${esc(c.card)}</strong></td>
        <td>${esc(c.driver || '—')}${c.vehicleName ? `<div class="help">${esc(c.vehicleName)}</div>` : ''}</td>
        <td style="text-align:center">${c.count}</td>
        <td><select data-cardd="${esc(c.card)}">${userOpt(dMap[c.card] || '')}</select></td>
        <td><select data-cardv="${esc(c.card)}">${vehOpt(vMap[c.card] || '')}</select></td>
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="alert info">Aucune carte détectée. Importez un export AS 24 ci-dessous.</div>';
  body.innerHTML = `
    <div class="card"><h3 style="margin-top:0">👤 Association carte AS 24 → chauffeur</h3>
      <p class="help">Associez chaque carte au chauffeur inscrit qui l'utilise : l'analyse de consommation se fera alors par chauffeur (et non plus seulement par libellé AS 24). L'association au véhicule alimente le rapprochement de la flotte.</p>
      ${cardsBlock}
    </div>
    <div class="card"><h3 style="margin-top:0">⚙️ Paramètres d'analyse</h3>
      <p class="help">Conso de référence, seuil d'alerte et capacité réservoir (utilisés pour détecter surconsommations et remplissages suspects).</p>
      <div class="grid2">
        <div><label>Conso de référence (L/100 km)</label><input id="fk-ref" type="number" step="0.1" value="${an.refConso}"></div>
        <div><label>Seuil d'alerte surconsommation (%)</label><input id="fk-thr" type="number" step="1" value="${an.threshold}"></div>
        <div><label>Capacité réservoir (L)</label><input id="fk-tank" type="number" step="1" value="${an.tankCapacity}"></div>
      </div>
      <div style="margin-top:.5rem"><button class="btn accent" id="fk-save">Enregistrer</button></div>
    </div>
    <div class="card"><h3 style="margin-top:0">📥 Importer un export AS 24</h3>
      <p class="help">Depuis AS 24 FleetManager → Info-Service, exportez vos transactions (Excel <strong>.xlsx</strong> ou CSV) puis déposez le fichier ici. Les doublons (même n° de transaction) sont ignorés.${d.available ? '' : ' <strong style="color:#b91c1c">Lecture Excel indisponible sur le serveur.</strong>'}</p>
      <div class="erp-row" style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
        <input type="file" id="fuel-file" accept=".xlsx,.xls,.csv">
        <button class="btn accent" id="fuel-import">📥 Importer</button>
        <span class="help" id="fuel-status"></span>
      </div>
    </div>`;
  body.querySelectorAll('[data-cardd]').forEach((sel) => sel.onchange = async () => {
    try { await api('POST', '/staff/fuel/driver-map', { card: sel.dataset.cardd, userId: sel.value || '' }); toast('Association enregistrée.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-cardv]').forEach((sel) => sel.onchange = async () => {
    try { await api('POST', '/staff/fuel/card-map', { card: sel.dataset.cardv, vehicleId: sel.value || '' }); toast('Association enregistrée.', 'ok'); } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelector('#fk-save').onclick = async () => {
    try { await api('PUT', '/admin/fuel/kpi', { refConso: +body.querySelector('#fk-ref').value, threshold: +body.querySelector('#fk-thr').value, tankCapacity: +body.querySelector('#fk-tank').value }); toast('Paramètres enregistrés.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const fileEl = body.querySelector('#fuel-file');
  body.querySelector('#fuel-import').onclick = async () => {
    const f = fileEl.files && fileEl.files[0];
    if (!f) { toast('Sélectionnez un fichier AS 24.', 'warn'); return; }
    const st = body.querySelector('#fuel-status'); st.textContent = 'Import en cours…';
    try {
      const dataUrl = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result)); fr.onerror = () => reject(new Error('Lecture impossible')); fr.readAsDataURL(f); });
      const r = await api('POST', '/staff/fuel/import', { fileBase64: dataUrl });
      toast(`${r.added} transaction(s) importée(s)${r.skipped ? `, ${r.skipped} doublon(s) ignoré(s)` : ''}.`, 'ok');
      loadCarburant();
    } catch (e) { st.textContent = ''; toast('Erreur : ' + e.message, 'err'); }
  };
}

/* =========================================================================
   DASHBOARD — semaine en cours / à venir + soldes
   ========================================================================= */
let _calEvents = []; // évènements du calendrier (pour l'édition du remplaçant au planning)
let _previewUserId = null; // aperçu « en tant que » : id du salarié prévisualisé (admin)
let _previewMode = false;  // vrai pendant le rendu d'un aperçu (lecture seule)
async function renderDashboard(main) {
  const todayLong = frLongDate(iso(new Date()));
  const heroDate = todayLong ? todayLong.charAt(0).toUpperCase() + todayLong.slice(1) : '';
  const inPreview = State.user.role === 'admin' && _previewUserId;
  main.innerHTML = `
    <section class="dash-hero">
      <div class="dash-hero-text">
        <div class="dash-hello">Bonjour ${esc(State.user.firstName)} 👋</div>
        <div class="dash-date">${esc(heroDate)}</div>
      </div>
      <div class="dash-hero-actions">
        <button class="hero-chip" data-herov="calendar">📅 Mon planning</button>
        ${inPreview ? '' : '<button class="hero-chip" id="hero-leave">🌴 Poser un congé</button>'}
        <button class="hero-chip" data-herov="mydata">👤 Mon profil</button>
      </div>
    </section>
    <div id="dash-body" class="empty">Chargement…</div>`;
  main.querySelectorAll('[data-herov]').forEach((b) => b.onclick = () => { State.view = b.dataset.herov; renderApp(); });
  const heroLeave = main.querySelector('#hero-leave'); if (heroLeave) heroLeave.onclick = () => openRequestModal();
  try {
    const today = new Date();
    await ensureHolidays(today.getFullYear());
    await ensureHolidays(today.getFullYear() + 1);
    const { events } = await api('GET', '/calendar');
    _calEvents = events;
    const { user } = await api('GET', '/me');
    State.user = user;
    // Aperçu « en tant que » : un admin peut afficher (en lecture seule) l'espace
    // d'un salarié. viewUser = le salarié prévisualisé, sinon soi-même.
    let viewUser = user, previewList = [];
    _previewMode = false;
    if (user.role === 'admin') {
      try { previewList = (await api('GET', '/admin/users')).users.filter((u) => u.status === 'active'); } catch (e) {}
      if (_previewUserId) { const pu = previewList.find((u) => u.id === _previewUserId); if (pu) { viewUser = pu; _previewMode = true; } else { _previewUserId = null; } }
    }
    const b = viewUser.balances;

    const curStart = startOfWeekMonday(today);
    const prevStart = addDays(curStart, -7);   // semaine précédente
    const next1 = addDays(curStart, 7);        // +1
    const next2 = addDays(curStart, 14);       // +2
    // Priorité d'affichage du planning : du lundi au jeudi on met en avant la
    // semaine EN COURS ; à partir du vendredi (et le week-end) on met en avant la
    // semaine À VENIR (on prépare la semaine suivante).
    const _dow = today.getDay(); // 0 dim … 6 sam
    const _focusNext = (_dow === 5 || _dow === 6 || _dow === 0);
    const cardCur = dashWeekCard('Semaine en cours', curStart, events, true);
    const cardNext1 = dashWeekCard('Semaine à venir (+1)', next1, events);
    const cardNext2 = dashWeekCard('Dans deux semaines (+2)', next2, events);
    const cardPrev = dashWeekCard('Semaine précédente', prevStart, events, false, true);
    const weekCards = _focusNext
      ? `${cardNext1}${cardCur}${cardNext2}${cardPrev}`
      : `${cardCur}${cardNext1}${cardNext2}${cardPrev}`;

    const realAdmin = user.role === 'admin';
    const isAdmin = viewUser.role === 'admin';
    const staff = viewUser.role === 'admin' || viewUser.role === 'responsable';
    // Le groupe Président n'est pas éligible aux compteurs CP / CP N-1 / RCC /
    // HSUP ni au suivi des retards : on les masque de son espace.
    const isPresident = (viewUser.groupId === 'grp_president');
    const { team } = await api('GET', '/team').catch(() => ({ team: [] }));
    // Priorité d'apurement des congés (rang du salarié, sans exposer les soldes
    // des autres) — pour la suggestion de poser une semaine complète.
    const leavePrio = _previewMode ? null : await api('GET', '/my-leave-rank').catch(() => null);
    // Sélecteur d'aperçu (admin) + bandeau lecture seule.
    const previewBar = realAdmin ? `<div class="card" style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;${_previewMode ? 'border-left:5px solid #f59e0b' : ''}">
      <strong>👁️ Afficher un aperçu en tant que</strong>
      <select id="dash-preview" style="width:auto"><option value="">— Mon affichage —</option>${previewList.map((u) => `<option value="${u.id}" ${u.id === _previewUserId ? 'selected' : ''}>${esc(u.lastName)} ${esc(u.firstName)}</option>`).join('')}</select>
      ${_previewMode ? `<span class="pill warn">Lecture seule — vous voyez l'espace de ${esc(viewUser.firstName)} ${esc(viewUser.lastName)}</span> <button class="btn ghost sm" id="dash-preview-exit">Revenir à mon affichage</button>` : ''}
    </div>` : '';

    // Priorité de pose des congés (administrateur uniquement)
    let priorityPanel = '';
    if (isAdmin) {
      try {
        const { users } = await api('GET', '/admin/users');
        priorityPanel = priorityPanelHTML(users.filter((u) => u.status === 'active'));
      } catch (e) {}
    }

    // Demandes en attente non traitées (administrateur)
    let pendingPanel = '';
    if (isAdmin) {
      try {
        const { requests } = await api('GET', '/admin/requests');
        pendingPanel = pendingSummaryHTML(requests.filter((r) => r.status === 'pending'));
      } catch (e) {}
    }

    // Mes retards (compteurs glissants) + classement (encadrement)
    const myRetards = events.filter((e) => e.userId === viewUser.id && e.category === 'RET' && e.status === 'approved');
    // « Mes retards » n'apparaît qu'à partir du 1er retard validé par l'administrateur.
    const retardCards = (isPresident || !myRetards.length) ? '' : `<div class="card"><h3 style="margin:0 0 .6rem">⏱️ Mes retards</h3><div class="grid cols-4">
      ${statCard('Retards 30 j', retardCountSince(myRetards, 30), 'retard(s)')}
      ${statCard('Retards 90 j', retardCountSince(myRetards, 90), 'retard(s)')}
      ${statCard('Retards (semestre)', retardCountSince(myRetards, 182), 'retard(s)')}
      ${statCard('Retards (année)', retardCountSince(myRetards, 365), 'retard(s)', true)}
    </div></div>`;
    const classement = staff ? retardRankingHTML(events, team) : '';
    const philo = isPresident ? '' : philoMessageHTML(retardCountSince(myRetards, 365));

    // Panneaux véhicules + discipline (encadrement).
    let vehicleWarnPanel = '', vehPendingPanel = '', entretiensPanel = '', disciplinePanel = '', stockAlertPanel = '', geolocPanel = '';
    if (staff) {
      try { const { warnings } = await api('GET', '/staff/vehicle-warnings'); vehicleWarnPanel = vehicleWarningsHTML(warnings); } catch (e) {}
      try { const { pendingReports, alerts, ctReminders, scheduled } = await api('GET', '/staff/vehicle-dashboard'); vehPendingPanel = dashVehiclePendingHTML(pendingReports); entretiensPanel = dashEntretiensHTML(alerts) + ctRemindersHTML(ctReminders) + scheduledHTML(scheduled); } catch (e) {}
      try { const { items } = await api('GET', '/staff/discipline'); disciplinePanel = disciplineHTML(items); } catch (e) {}
      // Panneau géoloc : en-tête statique TOUJOURS visible (styles inline, sans
      // dépendance au CSS ni au chargement asynchrone), rempli ensuite par
      // geolocStartDashboard avec les données temps réel.
      geolocPanel = '<div id="dash-geoloc"><div class="card" style="padding:0;overflow:hidden;border:2px solid #14427e;border-radius:14px">'
        + '<div style="padding:.85rem 1rem;background:linear-gradient(135deg,#14427e,#2563eb);color:#fff;font-weight:800;font-size:1.05rem">🛰️ Géolocalisation des chauffeurs <span style="font-weight:400;opacity:.85;font-size:.85rem">— chargement…</span></div></div></div>';
    }
    let kmAnomalyPanel = '', licenciementPanel = '';
    if (isAdmin) {
      try { const { alerts } = await api('GET', '/admin/stock-alerts'); stockAlertPanel = stockAlertHTML(alerts); } catch (e) {}
      try { const { anomalies } = await api('GET', '/staff/km-anomalies'); kmAnomalyPanel = kmAnomalyHTML(anomalies); } catch (e) {}
      try { const { files } = await api('GET', '/admin/erp/documents/disciplinary-files'); licenciementPanel = licenciementHTML((files || []).filter((f) => f.level === 'licenciement')); } catch (e) {}
    }

    // Documents adressés au salarié (à accuser réception) — visible de tous.
    let myDocsPanel = '';
    try { const { documents } = await api('GET', '/admin/erp/my-documents'); myDocsPanel = myDocumentsHTML(documents); } catch (e) {}

    // Camions nécessitant un entretien (visible de TOUS les salariés).
    let needsMaintPanel = '';
    try { const { items } = await api('GET', '/vehicles/needs-maintenance'); needsMaintPanel = needsMaintHTML(items); } catch (e) {}

    // Messagerie interne (annonces de l'encadrement).
    let messagesPanel = '';
    try { const { messages } = await api('GET', '/messages'); messagesPanel = messagesPanelHTML(messages); } catch (e) {}

    // Synchronisation du calendrier de la société avec l'agenda perso (iCal).
    const calSyncPanel = isPresident ? '' : `<div class="card" style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;border-left:5px solid var(--accent)">
      <div style="flex:1;min-width:200px"><h3 style="margin:0 0 .2rem">📲 Synchroniser mon calendrier</h3><p class="help" style="margin:0">Recevez automatiquement le planning de la société (congés &amp; absences) dans l'agenda de votre téléphone ou ordinateur.</p></div>
      <button class="btn accent" id="dash-calsync">Synchroniser mon agenda</button>
    </div>`;

    // Cumul des congés / récup / RCC déjà pris (indicatif).
    const mineApproved = events.filter((e) => e.userId === viewUser.id && e.status === 'approved');
    const takenCP = Math.round(mineApproved.filter((e) => e.category === 'CP').reduce((s, e) => s + (e.days || 0), 0) * 100) / 100;
    const takenRCP = Math.round(mineApproved.filter((e) => e.category === 'RCP').reduce((s, e) => s + (e.hours || 0), 0) * 100) / 100;
    const takenRCC = Math.round(mineApproved.filter((e) => e.category === 'RCC').reduce((s, e) => s + (e.hours || 0), 0) * 100) / 100;
    // Demandes EN ATTENTE de validation : montants qui seront déduits une fois
    // validés → on affiche « en attente : X » + un compteur prévisionnel.
    const minePending = events.filter((e) => e.userId === viewUser.id && (e.status === 'pending'));
    const sumP = (pred, key) => Math.round(minePending.filter(pred).reduce((s, e) => s + (e[key] || 0), 0) * 100) / 100;
    const pendCPN = sumP((e) => e.category === 'CP' && e.pool !== 'N1', 'days');
    const pendCPN1 = sumP((e) => e.category === 'CP' && e.pool === 'N1', 'days');
    const pendRCC = sumP((e) => e.category === 'RCC', 'hours');
    const pendRCP = sumP((e) => e.category === 'RCP', 'hours');
    const rnd = (x) => Math.round(x * 100) / 100;
    // Texte « en attente / prévisionnel » ajouté au sous-titre d'un compteur.
    const pendSub = (pend, cur, unit) => pend > 0 ? ` · <span style="color:#b45309">en attente : ${pend} ${unit}</span> → <strong style="color:#1d4ed8">prévisionnel : ${rnd(cur - pend)} ${unit}</strong>` : '';

    // Alerte conflits de dates dans mon groupe
    const conflictPanel = conflictAlertHTML(events, team);
    // Récap personnel des demandes de congés (statut + conflit + modification).
    const myLeavePanel = isPresident ? '' : myLeaveRecapHTML(viewUser, events, team);
    // Suggestion de poser une semaine complète libre (optimisation de la rotation).
    const weekSuggestPanel = isPresident ? '' : weekSuggestionHTML(viewUser, events, leavePrio);

    // Congés à venir des collègues du même groupe (pour éviter les doublons).
    const colleaguesPanel = colleaguesUpcomingHTML(team, events);

    const anc = viewUser.hireDate ? `<div class="card" style="border-left:5px solid var(--brand)"><h3 style="margin:0">📅 ${_previewMode ? 'Ancienneté' : 'Votre ancienneté'} : ${ancienneteText(viewUser.hireDate)}</h3><p style="margin:.4rem 0 0">${anciennetePhilo(viewUser.hireDate)}</p><p class="help" style="margin:.3rem 0 0">Date d'entrée : ${fmtDate(viewUser.hireDate)}</p></div>` : '';

    const compteursCard = isPresident ? '' : `<div class="card"><h3 style="margin:0 0 .6rem">📊 Mes compteurs</h3><div class="grid cols-4">
        ${statCard('Congés N restants', b.congesN, 'jours', false, `déjà pris : ${takenCP} j (tous CP)${pendSub(pendCPN, b.congesN, 'j')}`)}
        ${statCard('Congés N-1 restants', b.congesN1, 'jours', false, pendCPN1 > 0 ? `${pendSub(pendCPN1, b.congesN1, 'j')}` : '')}
        ${statCard('RCC restant', b.rcc, 'h', false, `${hToDays(b.rcc)} · déjà pris ${takenRCC} h${pendSub(pendRCC, b.rcc, 'h')}`)}
        ${statCard('Récup. restante', b.heuresSupp, 'h', true, `${hToDays(b.heuresSupp)} · déjà pris ${takenRCP} h${pendSub(pendRCP, b.heuresSupp, 'h')}`)}
      </div></div>`;
    const pushDiv = isPresident ? '' : '<div id="dash-push"></div>';
    // Regroupe des panneaux sous un intitulé de section ; n'affiche la section
    // que si au moins un panneau a du contenu (évite les titres vides).
    const dashGroup = (title, ...panels) => {
      const inner = panels.filter((p) => p && String(p).trim()).join('\n');
      return inner ? `<h2 class="dash-divider">${title}</h2>${inner}` : '';
    };
    const dashBody = document.getElementById('dash-body');
    dashBody.className = '';
    dashBody.innerHTML = `
      ${previewBar}
      ${dashGroup('📌 À ne pas manquer', licenciementPanel, pendingPanel, conflictPanel, myDocsPanel, messagesPanel)}
      ${dashGroup('🧮 Mon espace', compteursCard, anc, myLeavePanel, weekSuggestPanel, retardCards)}
      ${dashGroup('🚚 Exploitation &amp; véhicules', geolocPanel, kmAnomalyPanel, stockAlertPanel, needsMaintPanel, disciplinePanel, vehPendingPanel, entretiensPanel, vehicleWarnPanel)}
      ${dashGroup('👥 Mon équipe', priorityPanel, classement, colleaguesPanel)}
      ${dashGroup('📅 Mon planning', weekCards)}
      ${dashGroup('⚙️ Réglages &amp; infos', calSyncPanel, pushDiv, philo)}`;
    // Rend chaque section de l'accueil repliable (ouvrir/masquer à la demande).
    makeDashCollapsible(dashBody);
    // Notifications push : remplit le panneau dédié (selon l'état d'abonnement).
    if (!_previewMode) renderPushPanel();
    // Sélecteur d'aperçu (toujours actif pour l'admin).
    const psel = dashBody.querySelector('#dash-preview');
    if (psel) psel.onchange = () => { _previewUserId = psel.value || null; renderDashboard(document.getElementById('main')); };
    const pexit = dashBody.querySelector('#dash-preview-exit');
    if (pexit) pexit.onclick = () => { _previewUserId = null; renderDashboard(document.getElementById('main')); };
    // En aperçu (lecture seule), on ne câble aucune action modifiante.
    if (!_previewMode) bindDashboardActions(dashBody);
  } catch (e) {
    document.getElementById('dash-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

// Accordéon de l'accueil : transforme chaque carte en section repliable, en
// mémorisant l'état ouvert/fermé (localStorage) pour le conserver entre les
// rendus. La barre d'aperçu admin et le panneau géoloc (déjà déroulant) sont
// laissés intacts.
function dashAccState() { try { return JSON.parse(localStorage.getItem('ics_dash_acc') || '{}'); } catch (e) { return {}; } }
function dashAccSave(s) { try { localStorage.setItem('ics_dash_acc', JSON.stringify(s)); } catch (e) {} }
function slugTitle(t) { return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); }
// Indicateur KPI résumant une carte (visible même repliée).
function dashKpi(card) {
  const alerts = card.querySelectorAll('.alert').length;
  const statVals = card.querySelectorAll('.stat .value');
  const rows = card.querySelectorAll('table tbody tr').length;
  const msgs = card.querySelectorAll('.msg-item').length;
  if (statVals.length) return { text: statVals[0].textContent.replace(/\s+/g, ' ').trim(), tone: 'info' };
  if (alerts) return { text: alerts + (alerts > 1 ? ' alertes' : ' alerte'), tone: 'warn' };
  if (msgs) return { text: msgs + (msgs > 1 ? ' messages' : ' message'), tone: 'info' };
  if (rows) return { text: rows + (rows > 1 ? ' lignes' : ' ligne'), tone: 'info' };
  return null;
}
function makeDashCollapsible(scope) {
  const state = dashAccState();
  // Sur téléphone, tout est fermé par défaut pour simplifier l'affichage ;
  // sur ordinateur, ouvert par défaut. L'état choisi par l'utilisateur prime.
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  [...scope.children].forEach((el) => {
    if (!el.classList || !el.classList.contains('card')) return;        // seulement les cartes
    if (el.querySelector('#dash-preview')) return;                       // garde l'aperçu admin visible
    const h = el.querySelector('h1, h2, h3, h4');
    if (!h) return;                                                      // sans titre : on laisse tel quel
    const key = slugTitle(h.textContent);
    const kpi = dashKpi(el);
    const det = document.createElement('details');
    det.className = 'dash-acc';
    det.open = key in state ? !!state[key] : !isMobile;                  // mobile : fermé par défaut
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="dash-chev" aria-hidden="true">›</span><span class="dash-title">${h.innerHTML}</span>${kpi ? `<span class="dash-kpi tone-${kpi.tone}">${esc(kpi.text)}</span>` : ''}`;
    h.remove();
    el.parentNode.insertBefore(det, el);
    det.appendChild(sum);
    det.appendChild(el);
    det.addEventListener('toggle', () => { const s = dashAccState(); s[key] = det.open; dashAccSave(s); });
  });
}

// Câblage des actions de la page d'accueil (messagerie, accusés, « J'ai lu »).
function bindDashboardActions(scope) {
  // Liens de navigation insérés dans les panneaux d'accueil (ex. carte géoloc).
  scope.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => {
    const v = b.dataset.view;
    if (v === 'docmgmt-dossiers') { _docMgmtTab = 'dossiers'; State.view = 'docmgmt'; } else { State.view = v; }
    renderApp();
  });
  // Préparer la mise à pied (faute grave) directement depuis l'alerte d'accueil.
  scope.querySelectorAll('[data-prepmap]').forEach((b) => b.onclick = () => {
    _docGenPrefill = { userId: b.dataset.prepmap, motif: b.dataset.motif || '', type: 'mise_a_pied_conservatoire' };
    _docMgmtTab = 'gen'; State.view = 'docmgmt'; renderApp();
  });
  // Modifier une demande de congés depuis le récap d'accueil.
  scope.querySelectorAll('[data-leavemod]').forEach((b) => b.onclick = () => openRequestModal({ id: b.dataset.leavemod, category: b.dataset.cat, pool: b.dataset.pool || null, startDate: b.dataset.s, endDate: b.dataset.e, reason: b.dataset.reason || '' }));
  // Poser une semaine complète proposée à l'accueil (optimisation des congés).
  scope.querySelectorAll('[data-bookweek]').forEach((b) => b.onclick = () => openRequestModal({ category: 'CP', pool: b.dataset.pool || null, startDate: b.dataset.s, endDate: b.dataset.e, reason: '' }));
  // Synchroniser le calendrier de la société avec l'agenda perso.
  const calSyncBtn = scope.querySelector('#dash-calsync'); if (calSyncBtn) calSyncBtn.onclick = () => calendarSyncModal();
  // Démarre le panneau géoloc auto-actualisé (encadrement).
  if (typeof geolocStartDashboard === 'function' && scope.querySelector('#dash-geoloc')) geolocStartDashboard();
  // Mes documents : consulter, accuser réception (signature), attestation.
  scope.querySelectorAll('[data-mydocview]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.mydocview + '/view'));
  scope.querySelectorAll('[data-mydocatt]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.mydocatt + '/attestation'));
  scope.querySelectorAll('[data-mydocack]').forEach((b) => b.onclick = async () => {
    if (!confirm('Je certifie sur l\'honneur avoir reçu et lu ce document.\n\nEn validant, vous le signez électroniquement (date et heure enregistrées).')) return;
    try { const r = await api('POST', '/admin/erp/documents/' + b.dataset.mydocack + '/ack'); toast('Réception accusée et signée le ' + (r.stamp || '') + '.', 'ok'); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  // Ajouter / modifier le remplaçant directement depuis le planning d'accueil.
  scope.querySelectorAll('[data-repl-cal]').forEach((b) => b.onclick = () => {
    const ev = (_calEvents || []).find((x) => x.id === b.dataset.replCal);
    if (ev) replacementModal(ev, scope, () => renderDashboard(document.getElementById('main')));
  });
  // Valider / écarter une anomalie de kilométrage.
  scope.querySelectorAll('[data-kmano-apply]').forEach((b) => b.onclick = async () => {
    try { await api('POST', `/admin/km-anomalies/${b.dataset.kmanoApply}/resolve`, { apply: true }); toast('Kilométrage validé, odomètre mis à jour.', 'ok'); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  scope.querySelectorAll('[data-kmano-reject]').forEach((b) => b.onclick = async () => {
    try { await api('POST', `/admin/km-anomalies/${b.dataset.kmanoReject}/resolve`, { apply: false }); toast('Anomalie écartée.', 'ok'); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  // Composer un message (encadrement).
  const comp = scope.querySelector('#msg-send');
  if (comp) comp.onclick = async () => {
    const title = scope.querySelector('#msg-title').value;
    const bodyv = scope.querySelector('#msg-body').value;
    if (!bodyv.trim()) { toast('Le message est vide.', 'err'); return; }
    try { await api('POST', '/messages', { title, body: bodyv }); toast('Message publié.', 'ok'); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  };
  scope.querySelectorAll('[data-msgread]').forEach((b) => b.onclick = async () => {
    try { await api('POST', '/messages/' + b.dataset.msgread + '/read'); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  scope.querySelectorAll('[data-msgreads]').forEach((b) => b.onclick = async () => {
    try { const r = await api('GET', '/messages/' + b.dataset.msgreads + '/reads'); messageReadsModal(r); }
    catch (e) { toast(e.message, 'err'); }
  });
  scope.querySelectorAll('[data-msgdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('Supprimer ce message ?')) return;
    try { await api('DELETE', '/messages/' + b.dataset.msgdel); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  scope.querySelectorAll('[data-warnack]').forEach((b) => b.onclick = async () => {
    try { await api('POST', '/staff/vehicle-warnings/ack', { key: b.dataset.warnack }); renderDashboard(document.getElementById('main')); }
    catch (e) { toast(e.message, 'err'); }
  });
  scope.querySelectorAll('[data-sanction]').forEach((b) => b.onclick = () => sanctionModal(b.dataset.sanction, b.dataset.name));
}

function messageReadsModal(r) {
  modal({
    title: 'Accusés de lecture',
    bodyHTML: `<h4 style="margin:.2rem 0 .3rem">A lu (${r.readers.length})</h4>
      ${r.readers.length ? `<ul class="vr-issues">${r.readers.map((x) => `<li>${esc(x.name)} <span class="help">${fmtDateTime(x.at)}</span></li>`).join('')}</ul>` : '<p class="help">Personne pour l’instant.</p>'}
      <h4 style="margin:.6rem 0 .3rem">N'a pas encore lu (${r.nonReaders.length})</h4>
      ${r.nonReaders.length ? `<ul class="vr-issues">${r.nonReaders.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '<p class="help">Tout le monde a lu. 👍</p>'}`,
    footHTML: `<button class="btn ghost" data-close>Fermer</button>`,
  });
}

// Panneau messagerie interne (accueil).
function messagesPanelHTML(messages) {
  const isAdmin = State.user.role === 'admin';
  const staff = isStaff();
  // Seul l'administrateur publie des annonces. Pour tous les autres (salariés ET
  // responsables), la messagerie reste masquée tant qu'aucun message n'a été posté.
  if (!isAdmin && !(messages || []).length) return '';
  const compose = isAdmin ? `<div class="msg-compose">
    <input id="msg-title" placeholder="Titre (facultatif)">
    <textarea id="msg-body" placeholder="Message d'information à l'ensemble des salariés…" style="min-height:60px"></textarea>
    <button class="btn accent sm" id="msg-send">Publier</button>
  </div>` : '';
  const list = (messages || []).slice(0, 12).map((m) => `<div class="msg-item ${m.readByMe ? '' : 'unread'}">
    <div class="msg-head"><strong>${esc(m.title)}</strong> <span class="help">— ${esc(m.authorName)}, ${fmtDateTime(m.createdAt)}</span>
      ${staff ? `<span style="margin-left:auto;display:flex;gap:.3rem"><button class="btn ghost sm" data-msgreads="${m.id}">👁 ${m.readCount} lu(s)</button>${m.mine || State.user.role === 'admin' ? `<button class="btn ghost sm" data-msgdel="${m.id}">✕</button>` : ''}</span>` : ''}
    </div>
    <div class="msg-body">${esc(m.body).replace(/\n/g, '<br>')}</div>
    ${m.readByMe ? '<div class="help">✅ Lu</div>' : `<button class="btn sm" data-msgread="${m.id}">J'ai lu</button>`}
  </div>`).join('');
  if (!staff && !(messages || []).length) return '';
  return `<div class="card">
    <h3 style="margin:0 0 .5rem">📣 Messagerie interne</h3>
    ${compose}
    ${(messages || []).length ? list : '<p class="help">Aucun message pour le moment.</p>'}
  </div>`;
}

// Rappels de contrôle technique / pollution (accueil encadrement).
function ctRemindersHTML(ctReminders) {
  if (!ctReminders || !ctReminders.length) return '';
  return `<div class="card" style="border-left:5px solid var(--brand)">
    <h3 style="margin:0 0 .5rem">🛠️ Contrôles techniques / pollution à prévoir</h3>
    <ul class="veh-alert-list">${ctReminders.map((c) => `<li>
      <span class="pill ${c.level === 'overdue' ? 'danger' : 'warn'}">${c.level === 'overdue' ? 'DÉPASSÉ' : 'BIENTÔT'}</span>
      <strong>${esc(c.vehicleName)}</strong> (${esc(c.plate || '—')}) — ${esc(c.type === 'pollution' ? 'Contrôle pollution' : 'Contrôle technique')} : ${fmtDate(c.date)}
    </li>`).join('')}</ul>
  </div>`;
}

// Camions nécessitant un entretien — visible de tous (ne pas les prendre).
function needsMaintHTML(items) {
  if (!items || !items.length) return '';
  return `<div class="card" style="border-left:5px solid var(--danger)">
    <h3 style="margin:0 0 .4rem">🚫 Véhicules à ne pas prendre sans accord (entretien nécessaire)</h3>
    <p class="help" style="margin:0 0 .5rem">Avant de partir le matin, vérifiez : ces véhicules nécessitent une intervention.</p>
    <ul class="veh-alert-list">${items.map((v) => `<li>
      <strong>${esc(v.vehicleName)}</strong>${v.plate ? ` (${esc(v.plate)})` : ''}${v.tournee ? ` · ${esc(v.tournee)}` : ''}
      <div class="help">${v.reasons.map(esc).join(' · ')}</div>
    </li>`).join('')}</ul>
  </div>`;
}

// --- Priorité de pose des congés (administrateur) ----------------------------
// Ordre : HSUP (>25h) > CP N-1 (urgence selon échéance 31 mai) > CP N > RCC.
function leaveDeadlineInfo() {
  // Période des CP N-1 : se termine le 31 mai. On calcule les mois restants.
  const today = new Date();
  let deadline = new Date(today.getFullYear(), 4, 31); // 31 mai (mois 4)
  if (today > deadline) deadline = new Date(today.getFullYear() + 1, 4, 31);
  const monthsLeft = (deadline - today) / (1000 * 60 * 60 * 24 * 30);
  return { deadline, monthsLeft };
}

// Alerte CP N-1 : uniquement si > 20 j ET entre le 1er janvier et le 31 mai.
function cpN1Alert(u) {
  const m = new Date().getMonth(); // 0 = janvier, 4 = mai
  const inWindow = m >= 0 && m <= 4;
  return inWindow && (u.balances && (u.balances.congesN1 || 0) > 20);
}
function priorityScore(u) {
  const b = u.balances || {};
  // Alertes retenues : heures sup. en retard (>25 h) et CP N-1 (>20 j, jan->mai).
  const hsupOver = Math.max(0, (b.heuresSupp || 0) - 25);
  const n1Urg = cpN1Alert(u) ? (b.congesN1 || 0) : 0;
  return hsupOver * 1e9 + n1Urg * 1e6;
}

function priorityReasons(u) {
  const b = u.balances || {};
  const tags = [];
  if ((b.heuresSupp || 0) > 25) tags.push(`<span class="tag rejected">Heures sup. ${b.heuresSupp} h (retard +${Math.round((b.heuresSupp-25)*10)/10} h)</span>`);
  if (cpN1Alert(u)) tags.push(`<span class="tag rejected">CP N-1 : ${b.congesN1} j ⏰ à solder avant le 31 mai</span>`);
  return tags.join(' ');
}

function priorityPanelHTML(users) {
  const ranked = users
    .map((u) => ({ u, score: priorityScore(u) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return '';
  const { deadline } = leaveDeadlineInfo();
  return `
    <div class="card" style="border-left:5px solid var(--accent)">
      <h3>🔔 Alerte : salariés ayant dépassé l'un des seuils fixés.</h3>
      <p class="help" style="margin-top:-.6rem">Alertes : heures sup. en retard (&gt; 25 h) et CP N-1 &gt; 20 j entre le 1er janvier et le 31 mai (échéance ${pad(deadline.getDate())}/${pad(deadline.getMonth()+1)}/${deadline.getFullYear()}).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Salarié</th><th>Groupe</th><th>Soldes à écouler</th></tr></thead>
        <tbody>${ranked.map((x, i) => {
          const g = groupById(x.u.groupId);
          const hl = i === 0 ? 'background:#fff7ed' : '';
          return `<tr style="${hl}">
            <td><strong>${i+1}</strong></td>
            <td>${esc(x.u.firstName)} ${esc(x.u.lastName)}</td>
            <td>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'—'}</td>
            <td>${priorityReasons(x.u)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`;
}

// Durée d'attente depuis une date (createdAt) -> "X j Y h".
function waitingSince(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return `${d} j ${h} h`;
}

// Résumé des demandes en attente de validation (administrateur).
function pendingSummaryHTML(pending) {
  if (!pending.length) return `<div class="card" style="border-left:5px solid var(--ok)"><h3 style="margin:0">✅ Aucune demande en attente</h3></div>`;
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return `<div class="card" style="border-left:5px solid var(--accent)">
    <h3>📨 ${pending.length} demande(s) en attente de votre validation</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Salarié</th><th>Groupe</th><th>Motif</th><th>Période</th><th>En attente depuis</th></tr></thead>
      <tbody>${pending.map((r) => `<tr>
        <td>${esc(r.userName)}</td><td>${groupChip(r)}</td>
        <td>${esc(r.category)}</td>
        <td>${fmtPeriodLong(r.startDate, r.endDate)}</td>
        <td><strong>${waitingSince(r.createdAt)}</strong></td>
      </tr>`).join('')}</tbody></table></div>
    <button class="btn accent sm" onclick="State.view='admin';renderApp()" style="margin-top:.6rem">Traiter les demandes</button>
  </div>`;
}

// Classement des salariés les plus en retard sur l'année (encadrement).
function retardRankingHTML(events, team) {
  const year = String(new Date().getFullYear());
  const counts = {};
  events.filter((e) => e.category === 'RET' && e.status === 'approved' && e.startDate.slice(0, 4) === year)
    .forEach((e) => { counts[e.userId] = (counts[e.userId] || 0) + 1; });
  const ranked = Object.entries(counts).map(([uid, n]) => {
    const m = team.find((t) => t.id === uid);
    return { name: m ? `${m.firstName} ${m.lastName}` : 'Inconnu', groupId: m ? m.groupId : null, n };
  }).sort((a, b) => b.n - a.n);
  if (!ranked.length) return '';
  return `<div class="card" style="border-left:5px solid #fb7185">
    <h3>⏱️ Classement des retards ${year}</h3>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Salarié</th><th>Groupe</th><th>Retards</th></tr></thead>
    <tbody>${ranked.map((x, i) => { const g = groupById(x.groupId); return `<tr style="${i===0?'background:#fff1f2':''}"><td><strong>${i+1}</strong></td><td>${esc(x.name)}</td><td>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'—'}</td><td><strong>${x.n}</strong></td></tr>`; }).join('')}</tbody></table></div>
  </div>`;
}

// Alerte conflits : deux personnes du même groupe absentes sur une période commune.
function conflictAlertHTML(events, team) {
  const groupOf = {}; team.forEach((m) => { groupOf[m.id] = m.groupId; });
  const groupsToCheck = isStaff() ? State.groups.map((g) => g.id) : [State.user.groupId];
  const today = iso(new Date());
  const conflicts = [];
  for (const gid of groupsToCheck) {
    if (!gid) continue;
    const evs = events.filter((e) => groupOf[e.userId] === gid && e.status === 'approved' && e.endDate >= today);
    for (let i = 0; i < evs.length; i++) for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i], bb = evs[j];
      if (a.userId !== bb.userId && a.startDate <= bb.endDate && a.endDate >= bb.startDate) {
        const s = a.startDate > bb.startDate ? a.startDate : bb.startDate;
        const e = a.endDate < bb.endDate ? a.endDate : bb.endDate;
        conflicts.push({ gid, names: [a.userName, bb.userName], s, e });
      }
    }
  }
  if (!conflicts.length) return '';
  // Dédoublonne
  const seen = new Set();
  const uniq = conflicts.filter((c) => { const k = c.gid + c.names.sort().join() + c.s + c.e; if (seen.has(k)) return false; seen.add(k); return true; });
  return `<div class="alert warn" style="border-left:5px solid var(--danger)">
    <strong>⚠️ Conflit(s) de dates dans ${isStaff() ? 'les équipes' : 'votre groupe'} :</strong>
    <ul style="margin:.4rem 0 0;padding-left:1.1rem">
      ${uniq.slice(0, 12).map((c) => { const g = groupById(c.gid); return `<li>${g?esc(g.name)+' : ':''}${esc(c.names.join(' & '))} en même temps du ${fmtDate(c.s)} au ${fmtDate(c.e)}</li>`; }).join('')}
    </ul>
  </div>`;
}

// Accueil salarié : récap de SES demandes de congés à venir avec statut de
// conflit (vert = aucun, jaune = possible, rouge = certain) + bouton modifier.
// Nombre maximum de congés simultanés (= nombre de chauffeurs pouvant assurer
// les remplacements). Au-delà, certains ne pourront pas partir.
const MAX_CONCURRENT_LEAVES = 2;
function myLeaveRecapHTML(viewUser, events, team) {
  const today = iso(new Date());
  const cap = MAX_CONCURRENT_LEAVES;
  // Les congés sont réservables par TOUS les utilisateurs (pas seulement le groupe).
  const mine = (events || []).filter((e) => e.userId === viewUser.id && e.category !== 'RET' && e.endDate >= today && (e.status === 'pending' || e.status === 'approved'))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  if (!mine.length) return '';
  const rows = mine.map((e) => {
    const others = new Set();
    (events || []).forEach((o) => {
      if (o.userId === viewUser.id || o.category === 'RET') return;
      if (!(o.status === 'pending' || o.status === 'approved')) return;
      if (o.startDate <= e.endDate && o.endDate >= e.startDate) others.add(o.userId);
    });
    const n = others.size;                 // autres personnes sur la même période
    const concurrent = n + 1;              // total (vous compris)
    const period = `du ${fmtDate(e.startDate)} au ${fmtDate(e.endDate)}`;
    const approved = e.status === 'approved';
    let tone, msg;
    if (n === 0) {
      tone = 'ok';
      msg = approved ? `Vos congés ${period} sont <strong>confirmés</strong> — aucun conflit sur ces dates. ✅` : `Votre demande ${period} est <strong>en attente de confirmation</strong> — aucun conflit sur ces dates pour le moment. ✅`;
    } else if (concurrent <= cap) {
      if (approved) {
        // Congés déjà validés et dans la limite des remplacements : tout est sécurisé → vert.
        tone = 'ok';
        msg = `Vos congés ${period} sont <strong>confirmés</strong> — vous êtes ${concurrent} au total sur cette période, soit la limite des <strong>${cap} remplacements</strong> possibles, mais votre absence est garantie. ✅`;
      } else {
        tone = 'warn';
        msg = `Pour vos congés ${period} : <strong>${n} autre personne</strong> a demandé la même période. Vous êtes ${concurrent} au total, soit la limite des <strong>${cap} remplacements</strong> possibles — vos congés restent en attente d'approbation. Vous pouvez nous soumettre une autre date pour plus de sécurité.`;
      }
    } else {
      tone = 'danger';
      msg = `Conflit pour vos congés ${period} : <strong>${n} autres personnes</strong> ont demandé la même période (${concurrent} au total). Or seuls <strong>${cap} congés</strong> peuvent être accordés en même temps (${cap} remplaçants) : il est <strong>certain que l'un d'entre vous ne pourra pas partir</strong> à ces dates. Je vous remercie de bien vouloir modifier vos dates afin de m'aider à résoudre ce conflit de planning.`;
    }
    return `<div class="leave-recap leave-${tone}">
      <div class="leave-recap-msg">${msg}</div>
      <button class="btn ${tone === 'danger' ? 'danger' : 'ghost'} sm" data-leavemod="${e.id}" data-cat="${esc(e.category)}" data-pool="${esc(e.pool || '')}" data-s="${esc(e.startDate)}" data-e="${esc(e.endDate)}" data-reason="${esc(e.reason || '')}">✏️ Modifier mes dates</button>
    </div>`;
  }).join('');
  return `<div class="card"><h3 style="margin:0 0 .4rem">📅 Mes demandes de congés</h3>
    <p class="help" style="margin-top:-.2rem">Bonjour ${esc(viewUser.firstName)}, voici l'état de vos demandes (max. ${cap} congés simultanés). <span style="color:#166534">Vert</span> = aucun conflit · <span style="color:#b45309">Jaune</span> = à la limite · <span style="color:#b91c1c">Rouge</span> = conflit certain.</p>
    ${rows}</div>`;
}

// Accueil : suggestion de poser une SEMAINE COMPLÈTE (lundi → samedi) sur une
// semaine libre à la réservation et située au moins à 2 semaines d'ici, afin
// d'optimiser la rotation des congés et de solder les compteurs. On propose en
// priorité (et davantage de semaines) à ceux dont le solde de congés est le plus
// élevé ; l'ordre est légèrement randomisé chaque jour pour étaler les départs.
function weekSuggestionHTML(viewUser, events, prio) {
  if (!prio || !viewUser.balances) return '';
  const myBal = Number(prio.balance) || 0;
  if (myBal < 6) return ''; // moins d'une semaine complète (6 j ouvrables) à poser
  const cap = MAX_CONCURRENT_LEAVES;
  // Classement (calculé côté serveur, sans exposer les soldes des autres).
  const total = Math.max(1, Number(prio.total) || 1);
  const rank = Math.max(0, Number(prio.rank) || 0);
  // Plus on est haut dans le classement, plus on propose de semaines (1 à 3).
  const nSugg = rank < total / 3 ? 3 : rank < (2 * total) / 3 ? 2 : 1;
  // Semaines candidates : complètes (lun-sam), à partir de S+2, libres (occupation < cap).
  const monThis = isoWeekStart(new Date());
  const cands = [];
  for (let w = 2; w <= 16 && cands.length < 10; w++) {
    const mon = addDays(monThis, w * 7), sat = addDays(mon, 5);
    const ms = iso(mon), es = iso(sat);
    if ((State.closedPeriods || []).some((p) => p.start <= es && p.end >= ms)) continue;
    const occ = new Set();
    (events || []).forEach((o) => {
      if (o.category === 'RET') return;
      if (!(o.status === 'pending' || o.status === 'approved')) return;
      if (o.startDate <= es && o.endDate >= ms) occ.add(o.userId);
    });
    if (occ.has(viewUser.id)) continue;     // déjà une absence posée cette semaine
    if (occ.size < cap) cands.push({ ms, es });
  }
  if (!cands.length) return '';
  // Rotation : priorité aux mieux classés (semaines proches) + variation quotidienne.
  const now = new Date();
  const daySeed = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const off = ((rank + daySeed) % cands.length + cands.length) % cands.length;
  const rotated = cands.slice(off).concat(cands.slice(0, off));
  const picks = rotated.slice(0, Math.min(nSugg, rotated.length));
  const pool = (Number(viewUser.balances.congesN1) || 0) > 0 ? 'N1' : 'N';
  const poolLbl = pool === 'N1' ? 'vos congés N-1 (à solder en priorité)' : 'vos congés N';
  const items = picks.map((p) => `<div class="week-sugg-item">
      <span>📆 Semaine du <strong>${fmtDate(p.ms)}</strong> au <strong>${fmtDate(p.es)}</strong> <span class="help">— libre à la réservation</span></span>
      <button class="btn ok sm" data-bookweek data-s="${p.ms}" data-e="${p.es}" data-pool="${pool}">Poser cette semaine</button>
    </div>`).join('');
  return `<div class="card" style="border-left:5px solid #16a34a">
    <h3 style="margin:0 0 .3rem">🌴 Posez une semaine complète</h3>
    <p class="help" style="margin-top:0">Pour fluidifier la rotation et solder ${poolLbl}, voici ${picks.length > 1 ? 'des semaines complètes libres' : 'une semaine complète libre'} (du lundi au samedi) à réserver dès maintenant. Il vous reste <strong>${Math.round(myBal * 10) / 10} j</strong> de congés à poser.</p>
    ${items}</div>`;
}

// Congés à venir des collègues du même groupe (anti-doublon de semaine).
function colleaguesUpcomingHTML(team, events) {
  const t = iso(new Date());
  const staff = isStaff();
  const myGroup = State.user.groupId;
  const g = groupById(myGroup);
  const range = (e) => e.startDate === e.endDate ? fmtDate(e.startDate) : `${fmtDate(e.startDate)} → ${fmtDate(e.endDate)}`;

  // Bloc « Mes remplacements à venir » : périodes où je remplace un collègue.
  const myReplacements = events
    .filter((e) => e.replacedById === State.user.id && e.endDate >= t && e.category !== 'RET')
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const replBlock = myReplacements.length ? `
    <div class="card" style="border-left:5px solid var(--accent)">
      <h3>🔁 Mes remplacements à venir</h3>
      <p class="help" style="margin-top:-.6rem">Périodes où vous remplacez un collègue absent.</p>
      <div style="display:flex;flex-wrap:wrap;gap:.4rem">
        ${myReplacements.map((e) => `<span class="date-chip future" title="${esc(e.categoryLabel)}">Remplace ${esc(e.userName)} (${esc(e.groupName)}) : ${range(e)}</span>`).join('')}
      </div>
    </div>` : '';

  // Encadrement : vision d'ensemble de TOUTES les absences à venir (tous groupes).
  // Masquée dans l'espace salarié (et en aperçu salarié) — trop d'affichage.
  if (staff && !_previewMode) {
    const upcoming = events.filter((e) => e.endDate >= t && e.category !== 'RET')
      .sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 80);
    return `${replBlock}
      <div class="card" style="border-left:5px solid var(--brand)">
        <h3>🗓️ Absences à venir — tous les groupes</h3>
        <p class="help" style="margin-top:-.6rem">Vision d'ensemble pour anticiper l'organisation.</p>
        ${upcoming.length === 0 ? `<div class="empty">Aucune absence à venir. 👍</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Salarié</th><th>Groupe</th><th>Période</th><th>Motif</th><th>Remplaçant</th></tr></thead>
          <tbody>${upcoming.map((e) => `<tr><td>${esc(e.userName)}</td><td>${e.groupName!=='—'?`<span class="group-chip" style="background:${e.groupColor}">${esc(e.groupName)}</span>`:'—'}</td><td>${range(e)}</td><td><span class="tag" style="background:${catColor(e.code)}22;color:${catColor(e.code)}">${esc(e.code)}</span> ${esc(e.categoryLabel)}${e.status==='pending'?' <em>(en attente)</em>':''}</td><td>${e.replacedByName?esc(e.replacedByName):'<span class="help">—</span>'}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>`;
  }

  // Salarié : congés à venir de son groupe.
  if (!myGroup) return replBlock;
  const mates = new Set(team.filter((m) => m.groupId === myGroup && m.id !== State.user.id).map((m) => m.id));
  // Côté salarié, on masque les demandes de CP en attente (DCP).
  const upcoming = events.filter((e) => mates.has(e.userId) && e.endDate >= t && e.category !== 'RET' && e.code !== 'DCP')
    .sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 30);
  return `${replBlock}
    <div class="card" style="border-left:5px solid ${g ? g.color : 'var(--brand-2)'}">
      <h3>🗓️ Congés à venir de mes collègues ${g ? `— ${esc(g.name)}` : ''}</h3>
      <p class="help" style="margin-top:-.6rem">Vérifiez avant de demander une semaine, pour éviter que tout le groupe soit absent en même temps.</p>
      ${upcoming.length === 0 ? `<div class="empty">Aucun congé à venir dans votre groupe. 👍</div>` : `
      <div style="display:flex;flex-wrap:wrap;gap:.4rem">
        ${upcoming.map((e) => `<span class="date-chip future ${e.status==='pending'?'is-pending':''}" title="${esc(e.categoryLabel)}">${esc(e.userName)} : ${range(e)} (${esc(e.code)})</span>`).join('')}
      </div>`}
    </div>`;
}

// Carte "qui est/était absent" pour une semaine donnée (lundi -> samedi).
// Documents adressés au salarié : à lire et à accuser réception (signature élec.).
function myDocumentsHTML(docs) {
  if (!docs || !docs.length) return '';
  const pending = docs.filter((d) => d.status !== 'acked');
  return `<div class="card" style="border-left:5px solid ${pending.length ? 'var(--danger)' : 'var(--brand-2)'}">
    <h3 style="margin:0 0 .3rem">📄 Mes documents${pending.length ? ` — ${pending.length} à accuser réception` : ''}</h3>
    <p class="help" style="margin-top:0">Consultez vos documents et certifiez sur l'honneur les avoir reçus et lus (signature électronique horodatée).</p>
    <div class="table-wrap"><table class="veh-table"><thead><tr><th>Document</th><th>Émis le</th><th>Statut</th><th></th></tr></thead>
      <tbody>${docs.map((d) => `<tr><td>${esc(d.label)}</td><td>${fmtDate((d.createdAt || '').slice(0, 10))}</td>
        <td>${d.status === 'acked' ? `<span class="pill ok">signé le ${fmtDateTime(d.ackedAt)}</span>` : '<span class="pill warn">à accuser réception</span>'}</td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-mydocview="${d.id}">Voir</button>${d.status === 'acked' ? ` <button class="btn ghost sm" data-mydocatt="${d.id}">Attestation</button>` : ` <button class="btn ok sm" data-mydocack="${d.id}">✍️ J'accuse réception</button>`}</td></tr>`).join('')}</tbody></table></div>
  </div>`;
}

// Alerte d'accueil : anomalies de kilométrage relevées à l'import (validation admin).
function kmAnomalyHTML(anomalies) {
  if (!anomalies || !anomalies.length) return '';
  return `<div class="card" style="border-left:5px solid var(--danger)">
    <h3 style="margin:0 0 .3rem">🚗 Anomalies de kilométrage à vérifier (${anomalies.length})</h3>
    <p class="help" style="margin-top:0">Relevés suspects (erreur de saisie possible). <strong>Validez</strong> pour mettre à jour l'odomètre du véhicule, ou <strong>écartez</strong>.</p>
    <div class="table-wrap"><table><thead><tr><th>Véhicule</th><th>Date</th><th>Km relevé</th><th>Chauffeur</th><th>Anomalie</th><th></th></tr></thead>
      <tbody>${anomalies.map((a) => `<tr><td><strong>${esc(a.vehicleName)}</strong>${a.plate ? ` (${esc(a.plate)})` : ''}</td><td>${fmtDate(a.date)}</td><td>${kmFmt(a.km)}</td><td>${esc(a.userName)}</td><td class="help">${esc(a.reason)}</td><td style="white-space:nowrap"><button class="btn ok sm" data-kmano-apply="${a.id}">Valider</button> <button class="btn ghost sm" data-kmano-reject="${a.id}">Écarter</button></td></tr>`).join('')}</tbody></table></div>
  </div>`;
}

// Accueil (admin) : salariés au niveau « licenciement pour faute grave » —
// la Direction doit engager la procédure (convocation à entretien préalable).
function licenciementHTML(list) {
  if (!list || !list.length) return '';
  return `<div class="card" style="border-left:5px solid var(--danger)">
    <h3 style="margin:0 0 .3rem">⚖️ Procédure de licenciement à engager (${list.length})</h3>
    <p class="help" style="margin-top:0">Dossier disciplinaire au niveau « faute grave » : convoquez le salarié à un entretien préalable. Ouvrez son dossier dans <strong>Gestion des procédures → Dossiers disciplinaires</strong>.</p>
    <div class="table-wrap"><table><thead><tr><th>Salarié</th><th>Groupe</th><th style="text-align:center">Avert.</th><th>Motif / raison</th><th></th></tr></thead>
      <tbody>${list.map((f) => `<tr><td><strong>${esc(f.userName)}</strong></td><td class="help">${esc(f.groupName)}</td><td style="text-align:center">${f.warningCount}${f.miseCount ? ` +${f.miseCount} MAP` : ''}</td><td class="help">${esc(f.reason)}</td><td><button class="btn accent sm" data-prepmap="${f.userId}" data-motif="${esc((f.dominant && (f.dominant.repMotif || f.dominant.motif)) || '')}">⚖️ Préparer la mise à pied</button></td></tr>`).join('')}</tbody></table></div>
    <div style="margin-top:.5rem"><button class="btn ghost sm" data-view="docmgmt-dossiers">Ouvrir les dossiers disciplinaires →</button></div>
  </div>`;
}

// --- Notifications push (PWA) -------------------------------------------
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
let _pushCfg = null;
async function renderPushPanel() {
  const el = document.getElementById('dash-push'); if (!el) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { el.innerHTML = ''; return; }
  let cfg; try { cfg = await api('GET', '/push/config'); } catch (e) { el.innerHTML = ''; return; }
  _pushCfg = cfg;
  if (!cfg.enabled || !cfg.publicKey) { el.innerHTML = ''; return; }
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  const on = !!sub;
  const denied = Notification.permission === 'denied';
  el.innerHTML = `<div class="card" style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;border-left:5px solid ${on ? 'var(--ok)' : 'var(--brand-2)'}">
    <div style="flex:1;min-width:200px"><h3 style="margin:0 0 .2rem">🔔 Notifications</h3>
      <p class="help" style="margin:0">${denied ? 'Les notifications sont bloquées dans les réglages de votre navigateur — réautorisez-les pour les activer.' : on ? 'Activées sur cet appareil : congés validés, documents adressés, annonces…' : 'Recevez les alertes importantes (congés, documents, planning), même application fermée.'}</p></div>
    ${denied ? '' : `<button class="btn ${on ? 'ghost' : 'accent'}" id="push-toggle">${on ? 'Désactiver' : 'Activer les notifications'}</button>`}
  </div>`;
  const btn = el.querySelector('#push-toggle');
  if (btn) btn.onclick = () => (on ? pushDisable() : pushEnable());
}
async function pushEnable() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications non autorisées.', 'warn'); return renderPushPanel(); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(_pushCfg.publicKey) });
    await api('POST', '/me/push-subscribe', sub.toJSON ? sub.toJSON() : sub);
    toast('Notifications activées sur cet appareil. ✅', 'ok');
  } catch (e) { toast('Activation impossible : ' + e.message, 'err'); }
  renderPushPanel();
}
async function pushDisable() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { const ep = sub.endpoint; await sub.unsubscribe().catch(() => {}); await api('POST', '/me/push-unsubscribe', { endpoint: ep }); }
    toast('Notifications désactivées sur cet appareil.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  renderPushPanel();
}

function dashWeekCard(title, weekStart, events, isCurrent, isPast) {
  const isAdmin = State.user && State.user.role === 'admin' && !_previewMode;
  const weekDays = [...Array(6)].map((_, i) => addDays(weekStart, i));
  const weekEnd = addDays(weekStart, 5);
  const label = `${pad(weekStart.getDate())}/${pad(weekStart.getMonth()+1)} → ${pad(weekEnd.getDate())}/${pad(weekEnd.getMonth()+1)}`;
  const weekAbs = events.filter((ev) => ev.startDate <= iso(weekEnd) && ev.endDate >= iso(weekStart));
  // Liste détaillée : salarié, groupe, dates et motif.
  const byUser = {};
  weekAbs.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { ev }).ev = byUser[ev.userId].ev; (byUser[ev.userId].list = byUser[ev.userId].list || []).push(ev); });
  const detail = Object.values(byUser).map((o) => o.list.map((ev) => {
    const range = ev.startDate === ev.endDate ? fmtDate(ev.startDate) : `${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
    const replCell = isAdmin ? `<td>${ev.replacedByName ? esc(ev.replacedByName) : '<span class="help">—</span>'} ${ev.code !== 'RET' ? `<button class="btn ghost sm" data-repl-cal="${ev.id}">${ev.replacedByName ? 'Modifier' : '+ Remplaçant'}</button>` : ''}</td>` : '';
    return `<tr><td>${esc(ev.userName)}</td><td><span class="group-chip" style="background:${ev.groupColor}">${esc(ev.groupName)}</span></td><td>${range}</td><td><span class="tag" style="background:${catColor(ev.code)}22;color:${catColor(ev.code)}">${esc(ev.code)}</span> ${esc(ev.categoryLabel)}</td>${replCell}</tr>`;
  }).join('')).join('');
  return `
    <div class="card" style="${isCurrent?'border-left:5px solid var(--brand-2)':''}">
      <div class="cal-toolbar"><h3 style="margin:0">${isCurrent?'📍 ':''}${esc(title)} — ${label}</h3></div>
      <p class="help" style="margin-top:-.4rem;margin-bottom:1rem">${isPast?'Qui était absent ?':(isCurrent?'Qui est absent ?':'Qui sera absent ?')}</p>
      <div class="week-grid">
        <div class="wrow whead">
          <div class="wcell namecol">Salarié</div>
          ${weekDays.map((d) => {
            const ds = iso(d); const h = State.holidays[ds]; const vac = schoolHolidayFor(ds); const closed = closedPeriodFor(ds);
            const cls = closed ? 'closed' : (h ? 'holiday' : (vac ? 'school' : ''));
            return `<div class="wcell ${cls}">${DOW_SHORT[(d.getDay()+6)%7]} ${pad(d.getDate())}<div class="sub">${h?esc(h):(closed?'🔒':(vac?'vac.':''))}</div></div>`;
          }).join('')}
        </div>
        ${renderDashWeekRows(weekAbs, weekDays)}
      </div>
      ${detail ? `<div class="table-wrap" style="margin-top:.8rem"><table><thead><tr><th>Salarié</th><th>Groupe</th><th>Dates</th><th>Motif</th>${isAdmin ? '<th>Remplaçant</th>' : ''}</tr></thead><tbody>${detail}</tbody></table></div>` : ''}
    </div>`;
}

function renderDashWeekRows(weekAbs, weekDays) {
  // Regroupe par utilisateur
  const byUser = {};
  weekAbs.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { name: ev.userName, color: ev.groupColor, evs: [] }).evs.push(ev); });
  const rows = Object.values(byUser);
  if (rows.length === 0) {
    return `<div class="wrow"><div class="wcell namecol" style="grid-column:1/-1;color:var(--muted);font-weight:500">
      ✅ Personne n'est absent sur cette semaine. Toute l'équipe est présente !</div></div>`;
  }
  return rows.map((r) => {
    const repl = r.evs.map((ev) => ev.replacedByName).filter(Boolean)[0];
    return `
    <div class="wrow">
      <div class="wcell namecol"><div><span class="dot" style="background:${r.color}"></span> ${esc(r.name)}</div>${repl?`<div class="help" style="color:var(--brand-2)">↪ ${esc(repl)} (remplaçant)</div>`:''}</div>
      ${weekDays.map((d) => {
        const ds = iso(d);
        const hit = r.evs.find((ev) => ev.startDate <= ds && ev.endDate >= ds);
        const isH = State.holidays[ds];
        if (hit) { const c = catColor(hit.code); return `<div class="wcell" style="background:${c}22"><span class="tag ${hit.status==='pending'?'is-pending':''}" style="background:${c};color:#fff" title="${esc(calTooltip(hit))}">${esc(hit.code)}</span></div>`; }
        return `<div class="wcell ${isH?'holiday':''}"></div>`;
      }).join('')}
    </div>`; }).join('');
}

function statCard(label, value, unit, alt, sub) {
  return `<div class="stat ${alt?'alt':''}"><div class="value">${value} <span class="unit">${unit}</span></div><div class="label">${label}${sub?` <span class="help" style="display:block;margin-top:.1rem">${sub}</span>`:''}</div></div>`;
}
// Correspondance heures -> jours (7 h = 1 j) pour information.
const HPERDAY = 7;
function hToDays(h) { return `≈ ${(Math.round((Number(h) / HPERDAY) * 10) / 10)} j`; }

/* =========================================================================
   CALENDRIER — jour / semaine / mois / année
   ========================================================================= */
async function renderCalendar(main) {
  const staff = isStaff();
  const admin = State.user.role === 'admin';
  // Sur téléphone, on ouvre par défaut la vue Agenda (la plus lisible sans effort).
  if (!State._calModeInit) { State._calModeInit = true; if (window.matchMedia && window.matchMedia('(max-width: 860px)').matches) State.cal.mode = 'agenda'; }
  main.innerHTML = `<div class="page-head"><div><h1>Mon Planning</h1>
    <p>Présences et absences de tous les salariés inscrits.</p></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn ghost" id="cal-sync">📱 Synchroniser mon téléphone</button>
      ${admin?`<button class="btn ghost" id="cal-close">🔒 Fermer des jours</button>`:''}
      ${staff?`<button class="btn ghost" id="cal-lock">🔐 Verrouiller mon planning</button>`:''}
      ${staff?`<button class="btn accent" id="cal-add">+ Attribuer une absence</button>`:''}
    </div></div>
    <div class="card" id="cal-card"><div class="empty">Chargement…</div></div>`;
  document.getElementById('cal-sync').onclick = () => calendarSyncModal();
  if (staff) document.getElementById('cal-add').onclick = () => adminAssignModal();
  if (staff) document.getElementById('cal-lock').onclick = () => myUnavailModal();
  if (admin) document.getElementById('cal-close').onclick = () => closedPeriodsModal(main);
  try {
    await ensureHolidays(State.cal.cursor.getFullYear());
    const { events } = await api('GET', '/calendar');
    State._calEvents = events;
    drawCalendar();
  } catch (e) {
    document.getElementById('cal-card').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

// Modal de synchronisation du calendrier avec le téléphone (abonnement iCal).
async function calendarSyncModal() {
  modal({ title: '📱 Synchroniser le planning avec mon téléphone', bodyHTML: '<div class="empty">Préparation du lien…</div>' });
  let info;
  try { info = await api('POST', '/me/calendar-token'); }
  catch (e) { const b = document.querySelector('#modal-overlay .body'); if (b) b.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const base = location.origin;
  const httpsUrl = base + info.path;
  const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
  const b = document.querySelector('#modal-overlay .body');
  if (!b) return;
  b.innerHTML = `
    <p>Abonnez-vous une seule fois à ce lien depuis l'application <strong>Calendrier</strong> de votre téléphone : les congés et absences <strong>validés</strong> y apparaîtront, et <strong>les nouveaux s'ajouteront automatiquement</strong> (rafraîchissement régulier, sans rien réinstaller).</p>
    <label>Lien d'abonnement</label>
    <input id="cal-url" readonly value="${esc(webcalUrl)}" style="font-family:monospace;font-size:.8rem">
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
      <a class="btn accent sm" href="${esc(webcalUrl)}">📲 Ajouter au calendrier</a>
      <button class="btn ghost sm" id="cal-copy">Copier le lien</button>
      <button class="btn ghost sm" id="cal-regen" title="Invalide l'ancien lien et en crée un nouveau">↺ Régénérer</button>
    </div>
    <details style="margin-top:.8rem"><summary class="help">Comment faire selon le téléphone</summary>
      <p class="help"><strong>iPhone</strong> : touchez « Ajouter au calendrier » ; sinon Réglages → Calendrier → Comptes → Ajouter un compte → Autre → Ajouter un abonnement à un calendrier, puis collez le lien.<br>
      <strong>Android / Google Agenda</strong> : sur ordinateur, Google Agenda → « Autres agendas » → « À partir d'une URL », collez le lien (en <code>https://</code>). Il se synchronise ensuite sur le téléphone.</p>
      <label>Lien HTTPS (pour Google Agenda)</label>
      <input readonly value="${esc(httpsUrl)}" style="font-family:monospace;font-size:.8rem">
    </details>
    <p class="help" style="margin-top:.6rem">Ce lien est <strong>personnel et privé</strong> : ne le partagez pas. En cas de fuite, cliquez « Régénérer ».</p>`;
  b.querySelector('#cal-copy').onclick = () => { const i = b.querySelector('#cal-url'); i.select(); navigator.clipboard ? navigator.clipboard.writeText(i.value).then(() => toast('Lien copié.', 'ok')) : document.execCommand('copy'); };
  b.querySelector('#cal-regen').onclick = async () => { if (!confirm('Régénérer le lien ? L\'ancien lien cessera de fonctionner et devra être re-ajouté sur les téléphones.')) return; try { await api('POST', '/me/calendar-token', { regenerate: true }); toast('Nouveau lien généré.', 'ok'); calendarSyncModal(); } catch (e) { toast(e.message, 'err'); } };
}

// Modal admin/responsable : attribuer ou proposer une absence pour un salarié.
// Options d'une liste déroulante d'utilisateurs, regroupées par groupe.
// annotate(m) peut renvoyer un suffixe (ex. " (pas disponible)") ; si elle
// renvoie false, l'option est désactivée.
function teamOptgroups(team, selectedId, annotate) {
  const order = State.groups.map((g) => g.id).concat([null]);
  const byG = {}; team.forEach((m) => { const k = m.groupId || 'none'; (byG[k] = byG[k] || []).push(m); });
  return order.map((gid) => {
    const list = byG[gid || 'none']; if (!list || !list.length) return '';
    const g = groupById(gid);
    list.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    return `<optgroup label="${esc(g ? g.name : 'Sans groupe')}">${list.map((m) => {
      const suf = annotate ? annotate(m) : '';
      const dis = suf && /pas disponible/i.test(suf) ? ' disabled' : '';
      return `<option value="${m.id}" ${m.id===selectedId?'selected':''}${dis}>${esc(m.lastName)} ${esc(m.firstName)}${suf?esc(suf):''}</option>`;
    }).join('')}</optgroup>`;
  }).join('');
}
// Un administrateur n'est pas proposé comme remplaçant (sauf se désigner lui-même).
function replacerAllowedClient(m) {
  return !(m.role === 'admin' && !(State.user.role === 'admin' && m.id === State.user.id));
}
// Conflit de remplacement côté client (pour annoter la liste des remplaçants).
const REPLACER_BLOCKING_CODES = ['CP', 'RCC', 'RCP'];
function replacerUnavailableClient(member, events, start, end, exceptUserId) {
  if (!start || !end) return null;
  if (member.id === exceptUserId) return 'le salarié concerné';
  if ((member.unavail || []).some((p) => p.start <= end && p.end >= start)) return 'planning verrouillé';
  for (const ev of events) {
    if (!(ev.startDate <= end && ev.endDate >= start)) continue;
    if (ev.userId === member.id && REPLACER_BLOCKING_CODES.includes(ev.category)) return 'en congé/repos';
    if (ev.replacedById === member.id) return 'déjà remplaçant';
  }
  return null;
}

async function adminAssignModal(prefillDate, prefillUserId) {
  let team = [], allEvents = [];
  try { team = (await api('GET', '/team')).team; allEvents = (await api('GET', '/calendar')).events; } catch (e) { toast(e.message, 'err'); return; }
  team.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  // Tous les motifs sauf DCP (état dérivé d'une demande de CP en attente).
  const cats = State.categories.filter((c) => c.code !== 'DCP');
  const isResp = State.user.role === 'responsable';
  const isAdmin = State.user.role === 'admin';
  modal({
    title: 'Saisir une absence pour un salarié',
    bodyHTML: `
      ${isResp?`<div class="alert info">En tant que responsable, votre saisie sera <strong>soumise à validation</strong> de l'administrateur avant d'être inscrite au planning.</div>`:''}
      <form id="form-assign">
        <label>Salarié</label>
        <select name="userId" required>${teamOptgroups(team, prefillUserId)}</select>
        <label>Motif</label>
        <select name="category" required>${cats.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}</option>`).join('')}</select>
        <div id="assign-solde" class="assign-solde"></div>
        <div id="pool-wrap" style="display:none"><label>Imputer sur le solde</label><select name="pool"></select></div>
        <div id="frac-wrap2" style="display:none"><label>Prise du congé (maternité/paternité)</label>
          <select name="fractionnement"><option value="complet">Complète</option><option value="fractionne">Fractionnée</option></select></div>
        <div id="ret-wrap" style="display:none"><label>Durée du retard</label>
          <select name="retardMinutes"><option value="30">30 minutes</option><option value="60">1 heure</option><option value="120">2 heures</option><option value="180">3 heures et plus</option></select></div>
        <label>Remplacé par (facultatif)</label>
        <select name="replacedById"><option value="">Pas de remplaçant</option></select>
        <p class="help" id="repl-note" style="display:none"></p>
        <div class="row">
          <div><label>Du</label><input type="date" name="startDate" required value="${prefillDate||''}"></div>
          <div id="end-col"><label>Au</label><input type="date" name="endDate" value="${prefillDate||''}"></div>
        </div>
        <p class="help" id="assign-preview"></p>
        <label>Motif / commentaire (facultatif)</label>
        <textarea name="reason" placeholder="Précisez si besoin…"></textarea>
        ${isAdmin?`<label style="display:flex;align-items:center;gap:.5rem;margin-top:.8rem;font-weight:400;cursor:pointer">
          <input type="checkbox" name="immediate" checked style="width:auto"> Attribuer directement au calendrier (sinon, décider plus tard : reste en attente)
        </label>`:''}
      </form>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="assign-save">${isAdmin?'Valider':'Envoyer la proposition'}</button>`,
    onMount: (overlay) => {
      const f = overlay.querySelector('#form-assign');
      const poolWrap = overlay.querySelector('#pool-wrap');
      const fracWrap = overlay.querySelector('#frac-wrap2');
      const retWrap = overlay.querySelector('#ret-wrap');
      const endCol = overlay.querySelector('#end-col');
      const preview = overlay.querySelector('#assign-preview');
      const soldeDiv = overlay.querySelector('#assign-solde');
      const todayStr = iso(new Date());
      // Affiche le décompte disponible du salarié sélectionné pour ce motif.
      const refreshSolde = () => {
        const m = team.find((x) => x.id === f.userId.value);
        const cat = f.category.value;
        const bal = m && m.balances;
        if (!bal) { soldeDiv.innerHTML = ''; soldeDiv.style.display = 'none'; return; }
        let txt = '';
        if (cat === 'CP') txt = `Solde du salarié — Congés N : <strong>${bal.congesN} j</strong> · Congés N-1 : <strong>${bal.congesN1} j</strong>`;
        else if (cat === 'RCP') txt = `Solde de récupération (heures sup.) : <strong>${bal.heuresSupp} h</strong> ${hToDays(bal.heuresSupp)}`;
        else if (cat === 'RCC') txt = `Solde RCC : <strong>${bal.rcc} h</strong> ${hToDays(bal.rcc)}`;
        else { soldeDiv.style.display = 'none'; soldeDiv.innerHTML = ''; return; }
        soldeDiv.style.display = '';
        soldeDiv.innerHTML = `📊 ${txt}<div class="help" style="margin-top:.2rem">N'attribuez que ce qui figure dans son décompte.</div>`;
      };
      const refreshPool = () => {
        const cat = f.category.value;
        const opts = State.pools[cat];
        if (opts && opts.length) { poolWrap.style.display = ''; f.pool.innerHTML = opts.map((p) => `<option value="${p.value}">${esc(p.label)}</option>`).join(''); }
        else { poolWrap.style.display = 'none'; f.pool.innerHTML = ''; }
        fracWrap.style.display = cat === 'PMT' ? '' : 'none';
        const isRet = cat === 'RET';
        retWrap.style.display = isRet ? '' : 'none';
        endCol.style.display = isRet ? 'none' : '';       // retard = une seule date
        f.startDate.max = isRet ? todayStr : '';          // pas de retard futur
        refreshSolde();
      };
      const replNote = overlay.querySelector('#repl-note');
      // Recompose la liste des remplaçants disponibles selon les dates choisies.
      const refreshReplacers = () => {
        const isRet = f.category.value === 'RET';
        const s = f.startDate.value, e = isRet ? f.startDate.value : f.endDate.value;
        const exceptId = f.userId.value;
        const current = f.replacedById.value;
        const annotate = (m) => { const c = replacerUnavailableClient(m, allEvents, s, e, exceptId); return c ? ` (pas disponible — ${c})` : ''; };
        f.replacedById.innerHTML = `<option value="">Pas de remplaçant</option>` + teamOptgroups(team.filter((m) => m.id !== exceptId && replacerAllowedClient(m)), current, annotate);
        if (![...f.replacedById.options].some((o) => o.value === current)) f.replacedById.value = '';
        replNote.style.display = (s && e) ? '' : 'none';
        replNote.textContent = (s && e) ? 'Seuls les salariés disponibles sur la période peuvent être choisis comme remplaçants.' : '';
      };
      f.userId.onchange = () => { refreshSolde(); refreshReplacers(); };
      const update = () => {
        const cat = f.category.value;
        refreshReplacers();
        if (cat === 'RET') { preview.textContent = f.startDate.value ? `→ Retard du ${fmtDate(f.startDate.value)}.` : ''; return; }
        const s = f.startDate.value, e = f.endDate.value;
        preview.textContent = (s && e && e >= s) ? `→ ${countWorkingDaysClient(s, e)} jour(s) ouvré(s).` : '';
      };
      refreshPool(); update();
      f.category.onchange = () => { refreshPool(); update(); };
      f.startDate.onchange = update; f.endDate.onchange = update;
      overlay.querySelector('#assign-save').onclick = async () => {
        const isRet = f.category.value === 'RET';
        if (!f.startDate.value) { toast('Renseignez la date.', 'err'); return; }
        if (!isRet && !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          const r = await api('POST', '/admin/requests', {
            userId: f.userId.value, category: f.category.value, pool: f.pool.value || null,
            startDate: f.startDate.value, endDate: isRet ? f.startDate.value : f.endDate.value, reason: f.reason.value,
            replacedById: f.replacedById.value || null,
            fractionnement: f.fractionnement ? f.fractionnement.value : null,
            retardMinutes: isRet ? Number(f.retardMinutes.value) : null,
            immediate: f.immediate ? f.immediate.checked : true,
          });
          closeModal();
          toast(r.pendingValidation ? 'Saisie enregistrée — en attente de validation.' : 'Absence attribuée au calendrier.', 'ok');
          if (State.view === 'calendar') renderCalendar(document.getElementById('main'));
          if (State.view === 'absmgmt') renderAbsenceManagement(document.getElementById('main'));
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Modal « Verrouiller mon planning » : indisponibilités personnelles.
function myUnavailModal() {
  const list = () => (State.user.unavail || []).slice().sort((a, b) => a.start.localeCompare(b.start)).map((p) => `
    <tr><td>${esc(p.label)}</td><td>${fmtDate(p.start)} → ${fmtDate(p.end)}</td>
    <td><button class="btn danger sm" data-del-un="${p.id}">Suppr.</button></td></tr>`).join('');
  modal({
    title: '🔐 Verrouiller mon planning',
    bodyHTML: `
      <p class="help">Indiquez les jours ou semaines où vous n'êtes pas disponible. Sur ces dates, vous serez retiré du vivier de remplaçants proposés pour les autres salariés.</p>
      <form id="form-un">
        <label>Intitulé</label><input name="label" placeholder="Ex. Indisponible / formation">
        <div class="row"><div><label>Du</label><input type="date" name="start" required></div><div><label>Au</label><input type="date" name="end" required></div></div>
        <button class="btn accent full" type="submit">Ajouter l'indisponibilité</button>
      </form>
      <h4 style="margin:1.2rem 0 .4rem">Mes indisponibilités</h4>
      <div class="table-wrap"><table><tbody id="un-list">${list() || '<tr><td colspan="3" class="help">Aucune.</td></tr>'}</tbody></table></div>`,
    footHTML: `<button class="btn" data-close>Fermer</button>`,
    onMount: (ov) => {
      const refresh = () => { ov.querySelector('#un-list').innerHTML = list() || '<tr><td colspan="3" class="help">Aucune.</td></tr>'; bindDel(); };
      const bindDel = () => ov.querySelectorAll('[data-del-un]').forEach((b) => b.onclick = async () => {
        try { const r = await api('DELETE', '/me/unavail/' + b.dataset.delUn); State.user = r.user; toast('Indisponibilité supprimée.', 'ok'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      });
      bindDel();
      ov.querySelector('#form-un').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try { const r = await api('POST', '/me/unavail', { label: f.label.value, start: f.start.value, end: f.end.value }); State.user = r.user; toast('Indisponibilité ajoutée.', 'ok'); f.reset(); refresh(); }
        catch (err) { toast(err.message, 'err'); }
      };
    },
  });
}

// Modal admin : gérer les journées fermées à la prise de congé.
function closedPeriodsModal(main) {
  // Chaque fermeture est modifiable (intitulé + dates), même déjà verrouillée.
  const list = () => (State.closedPeriods || []).slice().sort((a, b) => a.start.localeCompare(b.start)).map((p) => `
    <tr>
      <td><input id="cl-label-${p.id}" value="${esc(p.label)}" style="min-width:140px"></td>
      <td><input type="date" id="cl-start-${p.id}" value="${p.start}"></td>
      <td><input type="date" id="cl-end-${p.id}" value="${p.end}"></td>
      <td style="white-space:nowrap"><button class="btn ok sm" data-edit-closed="${p.id}">💾</button> <button class="btn danger sm" data-del-closed="${p.id}">Suppr.</button></td>
    </tr>`).join('');
  modal({
    title: 'Fermer des journées à la prise de congé',
    bodyHTML: `
      <p class="help">Empêche les salariés de poser des congés sur ces dates (ex. fêtes de fin d'année). Vous pouvez toujours attribuer une absence manuellement.</p>
      <form id="form-closed">
        <label>Intitulé</label>
        <input name="label" placeholder="Ex. Fêtes de Noël" />
        <div class="row">
          <div><label>Du</label><input type="date" name="start" required /></div>
          <div><label>Au</label><input type="date" name="end" required /></div>
        </div>
        <button class="btn accent full" type="submit">Ajouter la fermeture</button>
      </form>
      <h4 style="margin:1.2rem 0 .4rem">Fermetures actuelles (modifiables)</h4>
      <div class="table-wrap"><table><thead><tr><th>Intitulé</th><th>Du</th><th>Au</th><th></th></tr></thead><tbody id="closed-list">${list() || '<tr><td colspan="4" class="help">Aucune fermeture.</td></tr>'}</tbody></table></div>`,
    footHTML: `<button class="btn" data-close>Fermer</button>`,
    onMount: (overlay) => {
      const refresh = () => { overlay.querySelector('#closed-list').innerHTML = list() || '<tr><td colspan="4" class="help">Aucune fermeture.</td></tr>'; bindRows(); if (State.view==='calendar') drawCalendar(); };
      const bindRows = () => {
        overlay.querySelectorAll('[data-del-closed]').forEach((b) => b.onclick = async () => {
          try { const r = await api('DELETE', '/admin/closed-periods/' + b.dataset.delClosed); State.closedPeriods = r.closedPeriods; toast('Fermeture supprimée.', 'ok'); refresh(); }
          catch (e) { toast(e.message, 'err'); }
        });
        overlay.querySelectorAll('[data-edit-closed]').forEach((b) => b.onclick = async () => {
          const id = b.dataset.editClosed;
          const payload = { label: overlay.querySelector('#cl-label-'+id).value, start: overlay.querySelector('#cl-start-'+id).value, end: overlay.querySelector('#cl-end-'+id).value };
          try { const r = await api('PUT', '/admin/closed-periods/' + id, payload); State.closedPeriods = r.closedPeriods; toast('Fermeture mise à jour.', 'ok'); refresh(); }
          catch (e) { toast(e.message, 'err'); }
        });
      };
      bindRows();
      overlay.querySelector('#form-closed').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try { const r = await api('POST', '/admin/closed-periods', { label: f.label.value, start: f.start.value, end: f.end.value }); State.closedPeriods = r.closedPeriods; toast('Fermeture ajoutée.', 'ok'); f.reset(); refresh(); }
        catch (err) { toast(err.message, 'err'); }
      };
    },
  });
}

function calLegend() {
  const items = State.cal.colorBy === 'group'
    ? State.groups.map((g) => `<div class="item"><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</div>`)
    : State.categories.map((c) => `<div class="item"><span class="dot" style="background:${c.color}"></span><strong>${esc(c.code)}</strong> — ${esc(c.label)}</div>`);
  return `<div class="legend">
    ${items.join('')}
    <div class="item"><span class="dot" style="background:#fde68a;border:1px solid #f59e0b"></span>Jour férié</div>
    <div class="item"><span class="dot" style="background:#dbeafe;border:1px solid #93c5fd"></span>Vacances scolaires (Zone B)</div>
    <div class="item"><span class="dot" style="background:#fee2e2;border:1px solid #fca5a5"></span>🔒 Fermé aux congés</div>
    <div class="item"><span class="tag is-pending" style="background:#94a3b8;color:#fff">code</span> = demande en attente</div>
  </div>`;
}

function drawCalendar() {
  const card = document.getElementById('cal-card');
  const { mode, cursor } = State.cal;
  let title = '';
  if (mode === 'day') title = `${DOW[(cursor.getDay()+6)%7]} ${cursor.getDate()} ${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
  else if (mode === 'week') { const ws = startOfWeekMonday(cursor); const we = addDays(ws,5); title = `Semaine du ${pad(ws.getDate())}/${pad(ws.getMonth()+1)} au ${pad(we.getDate())}/${pad(we.getMonth()+1)} ${we.getFullYear()}`; }
  else if (mode === 'month' || mode === 'agenda') title = `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
  else title = `Année ${cursor.getFullYear()}`;

  card.innerHTML = `
    <div class="cal-toolbar">
      <button class="nav-btn" id="cal-prev">‹</button>
      <button class="nav-btn" id="cal-next">›</button>
      <button class="btn ghost sm" id="cal-today">Aujourd'hui</button>
      <span class="title">${esc(title)}</span>
      <span style="flex:1"></span>
      <div class="view-switch" title="Colorer le calendrier par…">
        <button data-color="category" class="${State.cal.colorBy==='category'?'active':''}">Par catégorie</button>
        <button data-color="group" class="${State.cal.colorBy==='group'?'active':''}">Par groupe</button>
      </div>
      <div class="view-switch">
        ${['agenda','day','week','month','year'].map((m) => `<button data-mode="${m}" class="${mode===m?'active':''}">${({agenda:'Agenda',day:'Jour',week:'Semaine',month:'Mois',year:'Année'})[m]}</button>`).join('')}
      </div>
    </div>
    <div id="cal-grid"></div>
    ${calLegend()}`;

  card.querySelector('#cal-prev').onclick = () => moveCal(-1);
  card.querySelector('#cal-next').onclick = () => moveCal(1);
  card.querySelector('#cal-today').onclick = () => { State.cal.cursor = new Date(); refreshCalForYear(); };
  card.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { State.cal.mode = b.dataset.mode; drawCalendar(); });
  card.querySelectorAll('[data-color]').forEach((b) => b.onclick = () => { State.cal.colorBy = b.dataset.color; drawCalendar(); });

  const grid = document.getElementById('cal-grid');
  if (mode === 'agenda') grid.innerHTML = viewAgenda(cursor);
  else if (mode === 'day') grid.innerHTML = viewDay(cursor);
  else if (mode === 'week') grid.innerHTML = viewWeek(cursor);
  else if (mode === 'month') grid.innerHTML = viewMonth(cursor);
  else grid.innerHTML = viewYear(cursor);

  // Autres vues (jour/semaine/année) : toucher un jour ouvre le détail de ce jour.
  grid.querySelectorAll('[data-day]').forEach((cell) => cell.onclick = () => {
    State.cal.cursor = parseISO(cell.dataset.day); State.cal.mode = 'day'; drawCalendar();
  });
  // Vue mois « iPhone » : sélectionner un jour met à jour la liste sous la grille
  // (sans quitter le mois), façon application Calendrier.
  grid.querySelectorAll('[data-iosday]').forEach((cell) => cell.onclick = () => {
    const ds = cell.dataset.iosday;
    // Jour d'un mois adjacent : on bascule sur ce mois (comme l'app iPhone).
    if (cell.classList.contains('out')) { State.cal.selDay = ds; State.cal.cursor = parseISO(ds); refreshCalForYear(); return; }
    State.cal.selDay = ds;
    grid.querySelectorAll('.ioscell.sel').forEach((c) => c.classList.remove('sel'));
    cell.classList.add('sel');
    const box = document.getElementById('iosday');
    if (box) { box.innerHTML = iosDayDetail(ds); bindCalDelete(box); }
  });
  // Suppression d'une absence par l'administrateur (toutes vues).
  bindCalDelete(grid);
}

// Boutons de suppression d'absence (admin) dans un conteneur donné du calendrier.
function bindCalDelete(scope) {
  scope.querySelectorAll('[data-del-ev]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('Supprimer cette absence du calendrier ?')) return;
    try {
      await api('DELETE', '/admin/requests/' + btn.dataset.delEv);
      toast('Absence supprimée.', 'ok');
      const { events } = await api('GET', '/calendar');
      State._calEvents = events; drawCalendar();
    } catch (e) { toast(e.message, 'err'); }
  });
}

async function refreshCalForYear() {
  await ensureHolidays(State.cal.cursor.getFullYear());
  drawCalendar();
}

function moveCal(dir) {
  const c = State.cal.cursor;
  if (State.cal.mode === 'day') State.cal.cursor = addDays(c, dir);
  else if (State.cal.mode === 'week') State.cal.cursor = addDays(c, dir * 7);
  else if (State.cal.mode === 'month' || State.cal.mode === 'agenda') State.cal.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
  else State.cal.cursor = new Date(c.getFullYear() + dir, c.getMonth(), 1);
  refreshCalForYear();
}

// Résumé affiché au survol d'un évènement (durée + remplaçant).
function calTooltip(ev) {
  const range = ev.startDate === ev.endDate ? fmtDate(ev.startDate) : `${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
  const dur = ev.category === 'RET' ? `Retard de ${ev.retardMinutes || '?'} min` : `${ev.days} jour(s) d'absence`;
  let s = `${ev.userName} (${ev.groupName})\n${ev.categoryLabel}${ev.fractionnement ? ' — ' + (ev.fractionnement === 'fractionne' ? 'fractionné' : 'complet') : ''}\n${range} • ${dur}`;
  if (ev.replacedByName) s += `\n↪ remplacé par ${ev.replacedByName}`;
  if (ev.status === 'pending') s += `\n(en attente de validation)`;
  return s;
}

function eventsOnDay(ds) {
  return (State._calEvents || []).filter((ev) => ev.startDate <= ds && ev.endDate >= ds);
}

function viewDay(cursor) {
  const ds = iso(cursor);
  const isSunday = cursor.getDay() === 0;
  const hol = State.holidays[ds];
  const evs = eventsOnDay(ds);
  const vac = schoolHolidayFor(ds);
  const closed = closedPeriodFor(ds);
  let banner = '';
  if (isSunday) banner += `<div class="alert info">Dimanche — jour non travaillé.</div>`;
  if (hol) banner += `<div class="alert info">Jour férié : ${esc(hol)} — jour non travaillé.</div>`;
  if (closed) banner += `<div class="alert warn">🔒 ${esc(closed.label)} — prise de congé fermée.</div>`;
  if (vac) banner += `<div class="alert info" style="background:#dbeafe;color:#1e40af;border-color:#93c5fd">Vacances scolaires (Zone B) : ${esc(vac.label)}.</div>`;

  const isAdmin = State.user.role === 'admin';
  if (evs.length === 0) return banner + `<div class="empty">✅ Aucune absence ce jour. Toute l'équipe est présente.</div>`;
  return banner + `<div class="day-list">` + evs.map((ev) => `
    <div class="day-event">
      <div class="bar" style="background:${evColor(ev)}"></div>
      <div>
        <strong>${esc(ev.userName)} <span class="help" style="font-weight:600">(${esc(ev.groupName)})</span></strong>
        <div class="help">${esc(ev.categoryLabel)}${ev.fractionnement?` — ${ev.fractionnement==='fractionne'?'fractionné':'complet'}`:''}${ev.status==='pending'?' — <em>demande en attente</em>':''}</div>
        ${ev.replacedByName?`<div class="help" style="color:var(--brand-2)">↪ remplacé par <strong>${esc(ev.replacedByName)}</strong></div>`:''}
      </div>
      <span style="margin-left:auto" class="group-chip ${ev.status==='pending'?'is-pending':''}" style="background:${catColor(ev.code)}">${esc(ev.code)}</span>
      ${isAdmin?`<button class="btn danger sm" data-del-ev="${ev.id}" title="Supprimer">✕</button>`:''}
    </div>`).join('') + `</div>`;
}

function viewWeek(cursor) {
  const ws = startOfWeekMonday(cursor);
  const days = [...Array(6)].map((_, i) => addDays(ws, i));
  const we = addDays(ws, 5);
  const absent = (State._calEvents || []).filter((ev) => ev.startDate <= iso(we) && ev.endDate >= iso(ws));
  const byUser = {};
  absent.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { name: ev.userName, color: ev.groupColor, evs: [] }).evs.push(ev); });
  const rows = Object.values(byUser);

  let html = `<div class="week-grid"><div class="wrow whead"><div class="wcell namecol">Salarié</div>`;
  days.forEach((d) => {
    const ds = iso(d); const h = State.holidays[ds]; const vac = schoolHolidayFor(ds); const closed = closedPeriodFor(ds);
    const cls = closed ? 'closed' : (h ? 'holiday' : (vac ? 'school' : ''));
    const sub = closed ? '🔒 fermé' : (h ? esc(h) : (vac ? 'vac. scol.' : ''));
    html += `<div class="wcell ${cls}">${DOW_SHORT[(d.getDay()+6)%7]} ${pad(d.getDate())}<div class="sub">${sub}</div></div>`;
  });
  html += `</div>`;
  if (rows.length === 0) html += `<div class="wrow"><div class="wcell namecol" style="grid-column:1/-1;color:var(--muted)">✅ Aucune absence cette semaine.</div></div>`;
  else rows.forEach((r) => {
    const repl = r.evs.map((ev) => ev.replacedByName).filter(Boolean)[0];
    html += `<div class="wrow"><div class="wcell namecol"><div><span class="dot" style="background:${r.color}"></span> ${esc(r.name)}</div>${repl?`<div class="help" style="color:var(--brand-2)">↪ ${esc(repl)} (remplaçant)</div>`:''}</div>`;
    days.forEach((d) => {
      const ds = iso(d); const hit = r.evs.find((ev) => ev.startDate <= ds && ev.endDate >= ds); const isH = State.holidays[ds];
      if (hit) { const c = catColor(hit.code); html += `<div class="wcell" style="background:${c}22"><span class="tag ${hit.status==='pending'?'is-pending':''}" style="background:${c};color:#fff" title="${esc(calTooltip(hit))}">${esc(hit.code)}</span>${State.user.role==='admin'?` <button class="btn danger sm" data-del-ev="${hit.id}" title="Supprimer / recréditer" style="padding:0 .35rem">✕</button>`:''}</div>`; }
      else html += `<div class="wcell ${isH?'holiday':''}"></div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;
  return html;
}

// Écran étroit (téléphone) : on bascule sur un mois compact (pastilles).
function isNarrowScreen() { return !!(window.matchMedia && window.matchMedia('(max-width: 700px)').matches); }

// Vue mois façon « Calendrier iPhone » : grille épurée à pastilles, aujourd'hui
// en pastille rouge, et la liste des absences du jour sélectionné en dessous.
function viewMonth(cursor) {
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // 0 = lundi
  const gridStart = addDays(first, -startOffset);
  const today = new Date();
  // Jour sélectionné : aujourd'hui s'il est dans le mois affiché, sinon le 1er.
  const selOk = State.cal.selDay && parseISO(State.cal.selDay).getMonth() === month && parseISO(State.cal.selDay).getFullYear() === year;
  if (!selOk) State.cal.selDay = (today.getFullYear() === year && today.getMonth() === month) ? iso(today) : iso(first);
  const sel = State.cal.selDay;
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const ds = iso(d);
    const out = d.getMonth() !== month;
    const hol = State.holidays[ds];
    const vac = schoolHolidayFor(ds);
    const closed = closedPeriodFor(ds);
    const evs = eventsOnDay(ds);
    let cls = 'ioscell';
    if (out) cls += ' out';
    if (sameDay(d, today)) cls += ' today';
    if (ds === sel) cls += ' sel';
    if (closed) cls += ' closed'; else if (hol) cls += ' holiday'; else if (vac) cls += ' school';
    const dots = evs.slice(0, 4).map((ev) => `<i class="iosdot" style="background:${evColor(ev)}"></i>`).join('');
    cells += `<button class="${cls}" data-iosday="${ds}">
      <span class="iosnum">${d.getDate()}</span>
      <span class="iosdots">${dots}${evs.length > 4 ? `<i class="iosmore">+${evs.length - 4}</i>` : ''}</span>
    </button>`;
  }
  return `<div class="ioscal">
    <div class="iosgrid">
      ${['lun','mar','mer','jeu','ven','sam','dim'].map((d) => `<div class="iosdow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="iosday" id="iosday">${iosDayDetail(sel)}</div>
  </div>`;
}

// Détail (liste lisible) des absences d'un jour donné, affiché sous la grille.
function iosDayDetail(ds) {
  const d = parseISO(ds);
  const evs = eventsOnDay(ds).slice().sort((a, b) => String(a.userName).localeCompare(String(b.userName)));
  const hol = State.holidays[ds], vac = schoolHolidayFor(ds), closed = closedPeriodFor(ds);
  const isAdmin = State.user.role === 'admin';
  const tags = `${closed ? `<span class="pill danger">🔒 ${esc(closed.label)}</span>` : ''}${hol ? `<span class="pill warn">${esc(hol)}</span>` : ''}${vac && !hol ? `<span class="pill">${esc(vac.label)}</span>` : ''}`;
  const head = `<div class="iosday-head"><span class="iosday-date">${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}</span>${tags}</div>`;
  if (!evs.length) return `${head}<div class="iosday-empty">Aucune absence ce jour. ✨</div>`;
  const range = (ev) => ev.startDate === ev.endDate ? '' : ` · ${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
  const rows = evs.map((ev) => {
    const c = evColor(ev);
    return `<div class="iosev" style="--c:${c}"><span class="iosev-bar"></span>
      <span class="iosev-body">
        <span class="iosev-name">${esc(ev.userName)} <span class="help">(${esc(ev.groupName)})</span></span>
        <span class="help">${esc(ev.code)} · ${esc(ev.categoryLabel)}${ev.category === 'RET' ? ` · retard ${ev.retardMinutes || '?'} min` : ''}${range(ev)}${ev.status === 'pending' ? ' · <em>en attente</em>' : ''}${ev.replacedByName ? ` · ↪ ${esc(ev.replacedByName)}` : ''}</span>
      </span>
      ${isAdmin ? `<button class="btn danger sm" data-del-ev="${ev.id}" title="Supprimer / recréditer">✕</button>` : ''}
    </div>`;
  }).join('');
  return `${head}<div class="iosday-list">${rows}</div>`;
}

// Vue Agenda : liste chronologique et lisible des absences du mois (idéale mobile).
function viewAgenda(cursor) {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const monthStart = iso(new Date(y, m, 1));
  const monthEnd = iso(new Date(y, m + 1, 0));
  const evs = (State._calEvents || [])
    .filter((ev) => ev.startDate <= monthEnd && ev.endDate >= monthStart)
    .sort((a, b) => (a.startDate.localeCompare(b.startDate)) || String(a.userName).localeCompare(String(b.userName)));
  if (!evs.length) return `<div class="empty">✅ Aucune absence sur ${MONTHS[m]} ${y}.</div>`;
  const isAdmin = State.user.role === 'admin';
  const fmtRange = (ev) => ev.startDate === ev.endDate ? fmtDate(ev.startDate) : `${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
  const dur = (ev) => ev.category === 'RET' ? `retard ${ev.retardMinutes || '?'} min` : `${ev.days} j`;
  // Regroupement par jour de début pour des sous-titres clairs.
  let html = '<div class="agenda">', lastDay = '';
  evs.forEach((ev) => {
    if (ev.startDate !== lastDay) { lastDay = ev.startDate; html += `<div class="agenda-day">${esc(fmtDate(ev.startDate))}</div>`; }
    const c = evColor(ev);
    html += `<div class="agenda-item" style="border-left-color:${c}">
      <div class="agenda-main">
        <div class="agenda-top"><span class="tag ${ev.status === 'pending' ? 'is-pending' : ''}" style="background:${c};color:#fff">${esc(ev.code)}</span> <strong>${esc(ev.userName)}</strong> <span class="help">(${esc(ev.groupName)})</span></div>
        <div class="help">${esc(ev.categoryLabel)} · ${esc(fmtRange(ev))} · ${dur(ev)}${ev.status === 'pending' ? ' · <em>en attente</em>' : ''}${ev.replacedByName ? ` · ↪ ${esc(ev.replacedByName)}` : ''}</div>
      </div>
      ${isAdmin ? `<button class="btn danger sm" data-del-ev="${ev.id}" title="Supprimer / recréditer">✕</button>` : ''}
    </div>`;
  });
  html += '</div>';
  return html;
}

// Vue Agenda : liste chronologique et lisible des absences du mois (idéale mobile).
function viewAgenda(cursor) {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const monthStart = iso(new Date(y, m, 1));
  const monthEnd = iso(new Date(y, m + 1, 0));
  const evs = (State._calEvents || [])
    .filter((ev) => ev.startDate <= monthEnd && ev.endDate >= monthStart)
    .sort((a, b) => (a.startDate.localeCompare(b.startDate)) || String(a.userName).localeCompare(String(b.userName)));
  if (!evs.length) return `<div class="empty">✅ Aucune absence sur ${MONTHS[m]} ${y}.</div>`;
  const isAdmin = State.user.role === 'admin';
  const fmtRange = (ev) => ev.startDate === ev.endDate ? fmtDate(ev.startDate) : `${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
  const dur = (ev) => ev.category === 'RET' ? `retard ${ev.retardMinutes || '?'} min` : `${ev.days} j`;
  // Regroupement par jour de début pour des sous-titres clairs.
  let html = '<div class="agenda">', lastDay = '';
  evs.forEach((ev) => {
    if (ev.startDate !== lastDay) { lastDay = ev.startDate; html += `<div class="agenda-day">${esc(fmtDate(ev.startDate))}</div>`; }
    const c = evColor(ev);
    html += `<div class="agenda-item" style="border-left-color:${c}">
      <div class="agenda-main">
        <div class="agenda-top"><span class="tag ${ev.status === 'pending' ? 'is-pending' : ''}" style="background:${c};color:#fff">${esc(ev.code)}</span> <strong>${esc(ev.userName)}</strong> <span class="help">(${esc(ev.groupName)})</span></div>
        <div class="help">${esc(ev.categoryLabel)} · ${esc(fmtRange(ev))} · ${dur(ev)}${ev.status === 'pending' ? ' · <em>en attente</em>' : ''}${ev.replacedByName ? ` · ↪ ${esc(ev.replacedByName)}` : ''}</div>
      </div>
      ${isAdmin ? `<button class="btn danger sm" data-del-ev="${ev.id}" title="Supprimer / recréditer">✕</button>` : ''}
    </div>`;
  });
  html += '</div>';
  return html;
}

function viewYear(cursor) {
  const year = cursor.getFullYear();
  const today = new Date();
  let html = `<div class="year-grid">`;
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = addDays(first, -startOffset);
    html += `<div class="mini-month"><h4>${MONTHS[m]}</h4><div class="mini-grid">`;
    DOW_SHORT.concat(['Dim']).forEach((d) => html += `<span class="head">${d[0]}</span>`);
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      if (d.getMonth() !== m) { html += `<span class="dim">${d.getDate()}</span>`; continue; }
      const ds = iso(d);
      const closed = closedPeriodFor(ds);
      const evs = eventsOnDay(ds);
      if (closed) {
        // Jour fermé à la réservation : en rouge.
        html += `<span class="mini-closed" title="Fermé à la réservation : ${esc(closed.label)}">${d.getDate()}</span>`;
      } else if (evs.length) {
        const color = evColor(evs[0]);
        html += `<span class="has-ev" style="background:${color}" title="${evs.length} absence(s) le ${fmtDate(ds)} : ${esc(evs.map((e)=>e.userName.split(' ')[0]+' '+e.code).join(', '))}">${d.getDate()}</span>`;
      } else {
        const isSun = d.getDay() === 0; const hol = State.holidays[ds];
        html += `<span style="${isSun||hol?'color:#cbd5e1':''}">${d.getDate()}</span>`;
      }
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  return html;
}

/* =========================================================================
   MES DONNÉES
   ========================================================================= */
// Décompte (cumul) par motif sur les absences validées : en jours ET en heures.
function decompteRows(approved) {
  const days = {}, hours = {};
  approved.forEach((r) => {
    days[r.category] = (days[r.category] || 0) + r.days;
    hours[r.category] = (hours[r.category] || 0) + r.hours;
  });
  return State.categories.filter((c) => c.code !== 'DCP').map((c) => `
    <tr>
      <td><span class="group-chip" style="background:${c.color}">${esc(c.code)}</span> ${esc(c.label)}</td>
      <td style="text-align:right;font-weight:600">${days[c.code] || 0} j</td>
      <td style="text-align:right;font-weight:600">${hours[c.code] || 0} h</td>
    </tr>`).join('');
}
// Sélection des compteurs mis en avant (jours + heures) pour le tableau de bord.
function suiviHighlight(approved, codes) {
  const days = {}, hours = {};
  approved.forEach((r) => { if (codes.includes(r.category)) { days[r.category] = (days[r.category]||0)+r.days; hours[r.category] = (hours[r.category]||0)+r.hours; } });
  return codes.map((code) => {
    const c = State.catByCode[code]; if (!c) return '';
    return `<div class="stat"><div class="value" style="font-size:1.3rem">${days[code]||0} <span class="unit">j</span> / ${hours[code]||0} <span class="unit">h</span></div><div class="label">${esc(c.label)}</div></div>`;
  }).join('');
}

// Espace personnel : documents reçus de la plateforme (avertissements, contrats…).
async function renderMyDocs(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mes documents</h1>
    <p>Retrouvez et conservez les documents qui vous ont été adressés par la direction.</p></div></div>
    <div id="myd-body" class="empty">Chargement…</div>`;
  let docs;
  try { docs = (await api('GET', '/admin/erp/my-documents')).documents; } catch (e) { document.getElementById('myd-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const body = document.getElementById('myd-body'); body.className = '';
  const pending = docs.filter((d) => d.status !== 'acked');
  if (!docs.length) { body.innerHTML = `<div class="alert info">Aucun document pour le moment. Les documents que la direction vous adresse (avertissements, contrats, attestations…) apparaîtront ici et y resteront archivés.</div>`; return; }
  body.innerHTML = `
    ${pending.length ? `<div class="alert warn">Vous avez <strong>${pending.length} document(s) à signer</strong>. La signature vaut accusé de réception et de lecture (horodatée).</div>` : ''}
    <div class="card"><h3>Documents reçus (${docs.length})</h3>
      <p class="help">Vos documents sont conservés ici. Pour ceux que vous avez signés, l'attestation de prise de connaissance est téléchargeable.</p>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Document</th><th>Reçu le</th><th>Statut</th><th></th></tr></thead>
        <tbody>${docs.map((d) => `<tr>
          <td><strong>${esc(d.label)}</strong></td>
          <td>${fmtDate((d.createdAt || '').slice(0, 10))}</td>
          <td>${d.status === 'acked' ? `<span class="pill ok">signé le ${fmtDateTime(d.ackedAt)}</span>` : (d.viewedAt ? '<span class="pill warn">lu, à signer</span>' : '<span class="pill danger">à lire et signer</span>')}</td>
          <td style="white-space:nowrap"><button class="btn ghost sm" data-mdview="${d.id}">📄 Consulter</button>${d.status === 'acked' ? ` <button class="btn ghost sm" data-mdatt="${d.id}">Attestation</button>` : ` <button class="btn ok sm" data-mdack="${d.id}">✍️ Signer</button>`}</td>
        </tr>`).join('')}</tbody></table></div>
    </div>`;
  body.querySelectorAll('[data-mdview]').forEach((b) => b.onclick = () => { _docsOpened.add(b.dataset.mdview); api('POST', '/admin/erp/documents/' + b.dataset.mdview + '/seen').catch(() => {}); erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.mdview + '/view'); });
  body.querySelectorAll('[data-mdatt]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.mdatt + '/attestation'));
  body.querySelectorAll('[data-mdack]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.mdack; const d = docs.find((x) => x.id === id);
    if (!_docsOpened.has(id) && !(d && d.viewedAt)) { toast('Veuillez d\'abord consulter le document.', 'warn'); return; }
    if (!confirm('Je certifie sur l\'honneur avoir reçu et pris connaissance de ce document. Confirmer la signature ?')) return;
    try { const r = await api('POST', '/admin/erp/documents/' + id + '/ack'); toast('Document signé le ' + (r.stamp || '') + '.', 'ok'); await loadPendingDocs(); renderMyDocs(main); }
    catch (e) { toast(e.message, 'err'); }
  });
}

async function renderMyData(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mon Profil</h1><p>Vos soldes et informations personnelles.</p></div></div><div id="md" class="empty">Chargement…</div>`;
  try {
    const { user } = await api('GET', '/me');
    State.user = user;
    const { requests } = await api('GET', '/requests/mine');
    const g = groupById(user.groupId);
    const approved = requests.filter((r) => r.status === 'approved');
    // Le Président n'est pas éligible aux compteurs CP / CP N-1 / RCC / HSUP ni
    // au suivi des retards.
    const isPresident = (user.groupId === 'grp_president');
    const md = document.getElementById('md'); md.className = '';
    md.innerHTML = `
      ${isPresident ? '' : `<div class="grid cols-4">
        ${statCard('Congés N', user.balances.congesN, 'jours')}
        ${statCard('Congés N-1', user.balances.congesN1, 'jours')}
        ${statCard('RCC', user.balances.rcc, 'h', false, hToDays(user.balances.rcc))}
        ${statCard('Récup. / Heures sup.', user.balances.heuresSupp, 'h', true, hToDays(user.balances.heuresSupp))}
      </div>`}
      <div class="card">
        <h3>Profil</h3>
        <div class="table-wrap"><table>
          <tr><th>Nom</th><td>${esc(user.firstName)} ${esc(user.lastName)}</td></tr>
          ${user.username?`<tr><th>Nom de compte</th><td>${esc(user.username)} <span class="help">(donnée personnelle — visible par vous et l'administrateur uniquement)</span></td></tr>`:''}
          <tr><th>Email</th><td>${user.email?esc(user.email):'<em>—</em>'} <span class="help">(donnée personnelle — visible par vous et l'administrateur uniquement)</span></td></tr>
          <tr><th>Adresse postale</th><td>${user.address?esc(user.address):'<em>—</em>'} <span class="help">(donnée personnelle — visible par vous et l'administrateur uniquement)</span></td></tr>
          <tr><th>Téléphone</th><td><span style="display:inline-flex;gap:.4rem;align-items:center"><input id="md-phone" value="${user.phone?esc(user.phone):''}" placeholder="06 12 34 56 78" style="max-width:200px"><button class="btn sm" id="md-phone-save">Enregistrer</button></span></td></tr>
          <tr><th>Groupe de travail</th><td>${g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Non attribué</em>'}</td></tr>
          <tr><th>Rôle</th><td>${roleLabel(user.role)}</td></tr>
          <tr><th>Statut</th><td><span class="tag approved">Actif</span></td></tr>
          <tr><th>Parent d'un enfant</th><td>
            <label style="display:inline-flex;align-items:center;gap:.5rem;font-weight:400;margin:0;cursor:pointer">
              <input type="checkbox" id="md-parent" ${user.isParent?'checked':''} style="width:auto">
              <span class="help" style="margin:0">Cochez pour nous aider à équilibrer les congés (affiché « parent » à la direction).</span>
            </label>
          </td></tr>
        </table></div>
      </div>
      <div class="card">
        <h3>Suivi : maladie, accident, absences</h3>
        <p class="help" style="margin-top:-.6rem">Comptabilisé en jours et en heures${isPresident ? '' : ' ; retards en nombre'}.</p>
        <div class="grid cols-4">
          ${suiviHighlight(approved, ['AM','AT','ANRN'])}
          ${isPresident ? '' : `<div class="stat alt"><div class="value" style="font-size:1.3rem">${approved.filter((r)=>r.category==='RET').length} <span class="unit">retard(s)</span></div><div class="label">Retards (total validés)</div></div>`}
        </div>
      </div>
      <div class="card">
        <h3>Décompte par motif (jours et heures pris)</h3>
        <p class="help" style="margin-top:-.6rem">Cumul de vos absences validées pour chaque libellé.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Motif</th><th style="text-align:right">Jours</th><th style="text-align:right">Heures</th></tr></thead>
          <tbody>${decompteRows(approved)}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>Mes derniers évènements</h3>
        ${approved.length === 0 ? `<div class="empty">Aucun congé validé pour le moment.</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Du</th><th>Au</th><th>Jours</th></tr></thead>
          <tbody>${approved.map((r) => `<tr><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)}</td><td>${fmtDate(r.endDate)}</td><td>${r.days}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>`;
    const parentBox = document.getElementById('md-parent');
    if (parentBox) parentBox.onchange = async () => {
      try { const r = await api('PUT', '/me', { isParent: parentBox.checked }); State.user = r.user; toast('Information enregistrée.', 'ok'); }
      catch (e) { toast(e.message, 'err'); parentBox.checked = !parentBox.checked; }
    };
    const phoneSave = document.getElementById('md-phone-save');
    if (phoneSave) phoneSave.onclick = async () => {
      try { const r = await api('PUT', '/me', { phone: document.getElementById('md-phone').value }); State.user = r.user; toast('Téléphone enregistré.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
  } catch (e) { document.getElementById('md').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

/* =========================================================================
   MES DEMANDES
   ========================================================================= */
async function renderRequests(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mes événements</h1><p>Vos soldes, vos demandes et votre disponibilité sur l'année.</p></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn ghost" id="req-lock">🔐 Verrouiller mon planning</button>
      <button class="btn accent" id="new-req">+ Nouvelle demande</button>
    </div></div>
    <div id="req-list" class="empty">Chargement…</div>`;
  document.getElementById('new-req').onclick = openRequestModal;
  document.getElementById('req-lock').onclick = () => myUnavailModal();
  try {
    const { user } = await api('GET', '/me'); State.user = user;
    const { events } = await api('GET', '/calendar');
    const { requests } = await api('GET', '/requests/mine');
    const b = user.balances;
    const isPresident = (user.groupId === 'grp_president');
    const recent = requests.filter((r) => new Date(r.createdAt) >= new Date(Date.now() - 92 * 86400000));
    const list = document.getElementById('req-list'); list.className = '';
    list.innerHTML = `
      ${isPresident ? '' : `<div class="grid cols-4">
        ${statCard('Congés N', b.congesN, 'jours')}
        ${statCard('Congés N-1', b.congesN1, 'jours')}
        ${statCard('RCC', b.rcc, 'h', false, hToDays(b.rcc))}
        ${statCard('Récup. / Heures sup.', b.heuresSupp, 'h', true, hToDays(b.heuresSupp))}
      </div>`}
      <div class="card">
        <h3>${events.filter((ev) => ev.category!=='RET' && ev.groupId===user.groupId && ev.endDate>=iso(startOfWeekMonday(new Date())) && ev.startDate<=iso(addDays(startOfWeekMonday(new Date()),83))).length} absence(s) à prévoir dans les 12 prochaines semaines — Disponibilité de l'année</h3>
        <p class="help" style="margin-top:-.6rem">Vert = libre · rouge = absence prévue dans votre groupe (avec le nombre) · bleu = vous · 🔒 = fermé. Les retards n'affectent pas la disponibilité.</p>
        ${yearAvailabilityHTML(user, events)}
      </div>
      <div class="card">
        <h3>Mon historique récent <span class="help">(3 derniers mois)</span></h3>
        ${recent.length===0?`<div class="empty">Aucun évènement sur les 3 derniers mois.</div>`:`<div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Période</th><th>Jours</th><th>Statut</th><th>Déposé le</th></tr></thead>
          <tbody>${recent.map((r)=>`<tr><td>${esc(reqLabel(r))}</td><td>${fmtPeriodLong(r.startDate, r.endDate)}</td><td>${r.days} j${reqHours(r)}</td><td>${statusTag(r.status)}</td><td class="help">${fmtDateTime(r.createdAt)}</td></tr>`).join('')}</tbody></table></div>`}
      </div>
      <div class="card">
        <h3>Toutes mes demandes</h3>
        ${requests.length===0?`<div class="empty">Vous n'avez pas encore déposé de demande.</div>`:`<div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Période</th><th>Jours</th><th>Motif</th><th>Statut</th><th></th></tr></thead>
        <tbody>${requests.map(reqRow).join('')}</tbody></table></div>`}
      </div>`;
    list.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      try { await api('DELETE', '/requests/' + b.dataset.cancel); toast('Demande annulée.', 'ok'); renderRequests(main); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { document.getElementById('req-list').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

// Disponibilité sur 52 semaines pour le groupe de l'utilisateur.
function yearAvailabilityHTML(user, events) {
  // Les retards (RET) n'affectent pas la disponibilité à la réservation.
  let ws = startOfWeekMonday(new Date());
  let html = '<div class="team-weeks">';
  for (let i = 0; i < 52; i++) {
    const we = addDays(ws, 5);
    const wsS = iso(ws), weS = iso(we);
    const closed = (State.closedPeriods || []).some((p) => p.start <= weS && p.end >= wsS);
    const groupBusy = events.filter((ev) => ev.category !== 'RET' && ev.groupId === user.groupId && ev.userId !== user.id && ev.startDate <= weS && ev.endDate >= wsS);
    const mine = events.filter((ev) => ev.category !== 'RET' && ev.userId === user.id && ev.startDate <= weS && ev.endDate >= wsS);
    let cls = 'free', state = '✓';
    if (closed) { cls = 'closed'; state = '🔒'; }
    else if (mine.length) { cls = 'mine'; state = 'moi'; }
    else if (groupBusy.length) { cls = 'busy'; state = String(groupBusy.length); }
    const title = closed ? 'Fermé à la réservation' : (mine.length ? 'Vous êtes absent' : (groupBusy.length ? groupBusy.length + ' absence(s) prévue(s) dans le groupe' : 'Libre'));
    html += `<div class="team-week ${cls}" title="Semaine du ${pad(ws.getDate())}/${pad(ws.getMonth()+1)} — ${title}"><div class="tw-date">S${weekNum(ws)} ${pad(ws.getDate())}/${pad(ws.getMonth()+1)}</div><div class="tw-state">${state}</div></div>`;
    ws = addDays(ws, 7);
  }
  return html + '</div>';
}
function weekNum(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const diff = (date - firstThursday) / 86400000;
  return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

function statusTag(s) {
  const map = { pending: ['pending','En attente'], approved: ['approved','Validé'], rejected: ['rejected','Refusé'] };
  const [cls, label] = map[s] || ['pending', s];
  return `<span class="tag ${cls}">${label}</span>`;
}

function reqRow(r) {
  return `<tr>
    <td><span class="tag" style="background:${catColor(r.category)}22;color:${catColor(r.category)}">${esc(r.category)}</span> ${esc(reqLabel(r))}</td>
    <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
    <td>${r.days} j${reqHours(r)}</td>
    <td>${esc(r.reason||'—')}${r.adminNote?`<div class="help">Note admin : ${esc(r.adminNote)}</div>`:''}</td>
    <td>${statusTag(r.status)}</td>
    <td>${r.status==='pending'?`<button class="btn danger sm" data-cancel="${r.id}">Annuler</button>`:''}</td>
  </tr>`;
}

// Durées légales du congé maternité/paternité (jours calendaires).
const PMT_DURATIONS = {
  pat: { label: 'Paternité (25 jours)', days: 25 },
  pat_mult: { label: 'Paternité, naissances multiples (32 jours)', days: 32 },
  mat12: { label: 'Maternité 1er/2e enfant (16 semaines)', days: 112 },
  mat3: { label: 'Maternité 3e enfant ou + (26 semaines)', days: 182 },
  mat_jum: { label: 'Maternité jumeaux (34 semaines)', days: 238 },
  mat_tri: { label: 'Maternité triplés ou + (46 semaines)', days: 322 },
};
async function openRequestModal(prefill) {
  const selectable = State.categories.filter((c) => c.requestable);
  const b = State.user.balances;
  const soldeExtra = (c) => c.code === 'RCP' ? ` — solde : ${b.heuresSupp} h` : c.code === 'RCC' ? ` — solde : ${b.rcc} h` : '';
  // Pour les notes contextuelles (responsable disponible, période fermée).
  let allEvents = [], allTeam = [];
  try { allEvents = (await api('GET', '/calendar')).events; allTeam = (await api('GET', '/team')).team; } catch (e) {}
  const myRespIds = allTeam.filter((m) => m.role === 'responsable' && m.groupId === State.user.groupId).map((m) => m.id);
  modal({
    title: prefill ? 'Modifier ma demande de congés' : 'Nouvelle demande',
    bodyHTML: `
      ${prefill ? '<div class="alert info" style="margin-bottom:.6rem">Modifiez vos dates puis renvoyez : votre ancienne demande sera remplacée par la nouvelle.</div>' : ''}
      <form id="form-req">
        <label>Catégorie</label>
        <select name="category" required>
          ${selectable.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}${soldeExtra(c)}</option>`).join('')}
        </select>
        <p class="help" id="solde-info"></p>
        <div id="pool-wrap" style="display:none">
          <label id="pool-label">Imputer sur le solde</label>
          <select name="pool"></select>
        </div>
        <div id="frac-wrap" style="display:none">
          <label>Type de congé</label>
          <select name="pmtType">${Object.entries(PMT_DURATIONS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
          <label>Prise du congé</label>
          <select name="fractionnement">
            <option value="complet">Complète (la date de fin est calculée automatiquement)</option>
            <option value="fractionne">Fractionnée (vous saisissez chaque période)</option>
          </select>
          <p class="help">Congé pris en une fois : indiquez la date de début, la date de fin théorique est calculée selon la loi. Vous n'avez plus qu'à valider.</p>
        </div>
        <div class="row">
          <div><label>Du</label><input type="date" name="startDate" required /></div>
          <div><label>Au</label><input type="date" name="endDate" required /></div>
        </div>
        <p class="help" id="days-preview"></p>
        <label>Motif (facultatif)</label>
        <textarea name="reason" placeholder="Précisez si besoin…"></textarea>
        <p class="help">Seuls les jours ouvrés (lundi au samedi, hors jours fériés) sont décomptés.</p>
      </form>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="submit-req">Envoyer la demande</button>`,
    onMount: (overlay) => {
      const f = overlay.querySelector('#form-req');
      const preview = overlay.querySelector('#days-preview');
      const poolWrap = overlay.querySelector('#pool-wrap');
      const soldeInfo = overlay.querySelector('#solde-info');
      const balanceFor = { N: b.congesN + ' j', N1: b.congesN1 + ' j' };
      const fracWrap = overlay.querySelector('#frac-wrap');
      const hourBal = { RCP: b.heuresSupp, RCC: b.rcc };
      // Calcule la date de fin théorique d'un congé maternité/paternité complet.
      const computePmtEnd = () => {
        if (f.category.value !== 'PMT' || f.fractionnement.value !== 'complet' || !f.startDate.value) return;
        const dur = PMT_DURATIONS[f.pmtType.value]; if (!dur) return;
        const end = addDays(parseISO(f.startDate.value), dur.days - 1);
        f.endDate.value = iso(end);
        f.endDate.readOnly = true;
      };
      const refreshPool = () => {
        const cat = f.category.value;
        const opts = State.pools[cat];
        if (opts && opts.length) {
          poolWrap.style.display = '';
          f.pool.innerHTML = opts.map((p) => `<option value="${p.value}">${esc(p.label)} (solde : ${balanceFor[p.value] ?? '—'})</option>`).join('');
        } else { poolWrap.style.display = 'none'; f.pool.innerHTML = ''; }
        const isPmt = cat === 'PMT';
        fracWrap.style.display = isPmt ? '' : 'none';
        f.endDate.readOnly = false;
        soldeInfo.textContent = cat === 'RCP' ? `Solde de récupération (heures sup.) disponible : ${b.heuresSupp} h.` : cat === 'RCC' ? `Solde RCC disponible : ${b.rcc} h.` : '';
        computePmtEnd();
      };
      const update = () => {
        const s = f.startDate.value, e = f.endDate.value;
        const cat = f.category.value;
        computePmtEnd();
        if (s && e && e >= s) {
          const n = countWorkingDaysClient(s, e);
          const isHour = cat in hourBal;
          let txt = n > 0 ? `→ ${n} jour(s) ouvré(s)${isHour?` = ${n*7} h`:''} décompté(s).` : '→ Aucun jour ouvré sur cette période.';
          if (isHour) txt += ` Solde disponible : ${hourBal[cat]} h.`;
          // Période fermée à la réservation ?
          const closedOverlap = (State.closedPeriods || []).some((p) => p.start <= e && p.end >= s);
          if (closedOverlap) { preview.innerHTML = esc(txt) + ` <span style="color:var(--danger);font-weight:700">(Dates non disponible à la réservation)</span>`; return; }
          // Un responsable du groupe disponible sur la période ?
          if (myRespIds.length) {
            const respBusy = allEvents.some((ev) => myRespIds.includes(ev.userId) && ev.category !== 'RET' && ev.startDate <= e && ev.endDate >= s);
            if (!respBusy) { preview.innerHTML = esc(txt) + ` <span style="color:var(--ok);font-weight:700">(Un responsable semble être disponible à cette date)</span>`; return; }
          }
          preview.textContent = txt;
        } else preview.textContent = '';
      };
      refreshPool();
      // Pré-remplissage (modification d'une demande existante).
      if (prefill) {
        if (prefill.category) { f.category.value = prefill.category; refreshPool(); }
        if (prefill.pool && f.pool) f.pool.value = prefill.pool;
        if (prefill.startDate) f.startDate.value = prefill.startDate;
        if (prefill.endDate) f.endDate.value = prefill.endDate;
        if (prefill.reason && f.reason) f.reason.value = prefill.reason;
      }
      f.category.onchange = () => { refreshPool(); update(); };
      if (f.pmtType) f.pmtType.onchange = () => { computePmtEnd(); update(); };
      if (f.fractionnement) f.fractionnement.onchange = () => { f.endDate.readOnly = false; computePmtEnd(); update(); };
      f.startDate.onchange = update; f.endDate.onchange = update; f.pool.onchange = update;
      overlay.querySelector('#submit-req').onclick = async () => {
        if (!f.startDate.value || !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          await api('POST', '/requests', { category: f.category.value, pool: f.pool.value || null, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value, fractionnement: f.fractionnement ? f.fractionnement.value : null });
          // Modification : on supprime l'ancienne demande après la nouvelle.
          if (prefill && prefill.id) { try { await api('DELETE', '/requests/' + prefill.id); } catch (e2) {} }
          closeModal(); toast(prefill ? 'Nouvelle demande envoyée — l\'ancienne a été remplacée.' : 'Demande envoyée à l\'administrateur.', 'ok');
          const main = document.getElementById('main');
          if (State.view === 'requests') renderRequests(main);
          else if (State.view === 'dashboard') renderDashboard(main);
        } catch (e) {
          toast(e.message, 'err');
          // Si le serveur suggère une date de fin maximale, on l'applique.
          if (e.payload && e.payload.suggestedEndDate) {
            f.endDate.value = e.payload.suggestedEndDate; update();
            toast('Date de fin ajustée au maximum possible.', 'info');
          }
        }
      };
    },
  });
}

function countWorkingDaysClient(s, e) {
  let count = 0; let cur = parseISO(s); const end = parseISO(e);
  while (cur <= end) {
    const ds = iso(cur);
    if (cur.getDay() !== 0 && !State.holidays[ds]) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

/* =========================================================================
   ÉQUIPE
   ========================================================================= */
// Statut temporel d'une absence : 'past' (jaune), 'current' (vert), 'future' (bleu).
function dateStatus(startDate, endDate) {
  const t = iso(new Date());
  if (endDate < t) return 'past';
  if (startDate > t) return 'future';
  return 'current';
}

// Pastilles d'absences PRÉVUES d'un membre (hors retards), colorées par statut.
function memberAbsenceChips(memberId, events) {
  const evs = events.filter((e) => e.userId === memberId && e.category !== 'RET').sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (!evs.length) return '<span class="help">Aucune absence prévue.</span>';
  return evs.map((e) => {
    const st = dateStatus(e.startDate, e.endDate);
    const range = e.startDate === e.endDate ? fmtDate(e.startDate) : `${fmtDate(e.startDate)} → ${fmtDate(e.endDate)}`;
    return `<span class="date-chip ${st} ${e.status==='pending'?'is-pending':''}" title="${esc(calTooltip(e))}">${esc(e.code)} ${range}</span>`;
  }).join(' ');
}
// Pastilles de retards d'un membre (en jaune).
function memberRetardChips(memberId, events) {
  const rs = events.filter((e) => e.userId === memberId && e.category === 'RET').sort((a, b) => b.startDate.localeCompare(a.startDate));
  if (!rs.length) return '';
  return rs.map((e) => `<span class="date-chip retard">⏱️ Retard ${fmtDate(e.startDate)}${e.retardMinutes?` (${e.retardMinutes} min)`:''}</span>`).join(' ');
}

// Mini-calendrier de disponibilité (12 semaines). Les retards n'affectent PAS
// la disponibilité ; seules les absences prévues (hors retard) bloquent la semaine.
function teamWeeksMini(members, events) {
  const ids = new Set(members.map((m) => m.id));
  let ws = startOfWeekMonday(new Date());
  let html = '<div class="team-weeks">';
  for (let i = 0; i < 12; i++) {
    const we = addDays(ws, 5);
    const wsS = iso(ws), weS = iso(we);
    const planned = events.filter((ev) => ids.has(ev.userId) && ev.category !== 'RET' && ev.startDate <= weS && ev.endDate >= wsS);
    const closedWeek = (State.closedPeriods || []).some((p) => p.start <= weS && p.end >= wsS);
    const names = [...new Set(planned.map((t) => t.userName.split(' ')[0]))];
    let cls = 'free', state = '✓';
    if (closedWeek) { cls = 'closed'; state = '🔒'; }
    else if (planned.length) { cls = 'busy'; state = String(planned.length); }
    html += `<div class="team-week ${cls}" title="Semaine du ${pad(ws.getDate())}/${pad(ws.getMonth()+1)}${closedWeek?' — fermée':(planned.length?' — '+esc(names.join(', ')):' — libre')}"><div class="tw-date">S${weekNum(ws)} ${pad(ws.getDate())}/${pad(ws.getMonth()+1)}</div><div class="tw-state">${state}</div></div>`;
    ws = addDays(ws, 7);
  }
  return html + '</div>';
}
// Nombre d'absences prévues (hors retard) sur les 12 prochaines semaines.
function plannedCount12w(members, events) {
  const ids = new Set(members.map((m) => m.id));
  const start = iso(startOfWeekMonday(new Date()));
  const end = iso(addDays(startOfWeekMonday(new Date()), 12 * 7 - 1));
  return events.filter((ev) => ids.has(ev.userId) && ev.category !== 'RET' && ev.startDate <= end && ev.endDate >= start).length;
}

async function renderTeam(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mon équipe</h1><p>Disponibilité des équipes, congés prévus et retards.</p></div></div>
    <div class="legend" style="margin-bottom:1rem">
      <div class="item"><span class="team-week free" style="width:auto;padding:.1rem .5rem">vert</span> semaine libre</div>
      <div class="item"><span class="team-week busy" style="width:auto;padding:.1rem .5rem">rouge</span> absence prévue (avec le nombre)</div>
      <div class="item"><span class="date-chip retard">jaune</span> retard (n'affecte pas les congés)</div>
      <div class="item"><span class="team-week closed" style="width:auto;padding:.1rem .5rem">🔒</span> fermé</div>
    </div>
    <div id="team" class="empty">Chargement…</div>`;
  try {
    const { team } = await api('GET', '/team');
    const { events } = await api('GET', '/calendar');
    // Les responsables d'une équipe sont rattachés au tableau de leur équipe.
    const RESP_TO_TEAM = { grp_resp_gls: 'grp_gls', grp_resp_ciblex: 'grp_ciblex', grp_resp_fedex: 'grp_fedex' };
    const teamGroupOf = (m) => RESP_TO_TEAM[m.groupId] || m.groupId;
    const byGroup = {};
    team.forEach((m) => { const k = teamGroupOf(m) || 'none'; (byGroup[k] = byGroup[k] || []).push(m); });
    const el = document.getElementById('team'); el.className = '';
    const groupCard = (g, members) => {
      members = members.slice().sort((a, b) => (a.role === 'responsable' ? 0 : 1) - (b.role === 'responsable' ? 0 : 1) || (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
      const n12 = plannedCount12w(members, events);
      return `<div class="card">
      <h3>${n12} absence(s) à prévoir dans les 12 prochaines semaines — ${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'Sans groupe'} <span class="help">${members.length} membre(s)</span></h3>
      ${members.length?`<p class="help" style="margin-top:-.4rem">Disponibilité des 12 prochaines semaines :</p>${teamWeeksMini(members, events)}`:''}
      ${members.length===0?`<div class="empty">Aucun membre.</div>`:members.map((m) => {
        const ret = memberRetardChips(m.id, events);
        return `<div style="padding:.7rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap">
            <strong>${g?`<span class="dot" style="background:${g.color}"></span> `:''}${esc(m.firstName)} ${esc(m.lastName)}</strong>
            <span class="help">${roleLabel(m.role)}${m.role==='responsable'?' (planning inclus)':''}</span>
          </div>
          ${ret?`<div style="margin-top:.35rem;display:flex;flex-wrap:wrap;gap:.3rem">${ret}</div>`:''}
          <div style="margin-top:.45rem;display:flex;flex-wrap:wrap;gap:.35rem">${memberAbsenceChips(m.id, events)}</div>
        </div>`; }).join('')}
    </div>`; };
    const shown = new Set(Object.keys(RESP_TO_TEAM));
    el.innerHTML = State.groups.filter((g) => !shown.has(g.id)).map((g) => groupCard(g, byGroup[g.id] || [])).join('')
      + (byGroup['none'] ? groupCard(null, byGroup['none']) : '');
  } catch (e) { document.getElementById('team').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

/* =========================================================================
   GESTION DES ABSENCES (responsable / administrateur)
   ========================================================================= */
async function renderAbsenceManagement(main) {
  if (!isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  const isAdmin = State.user.role === 'admin';
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des absences</h1>
    <p>Saisissez une absence ou une demande de congé pour le compte d'un salarié.</p></div>
    <button class="btn accent" id="abs-new">+ Saisir une absence</button></div>
    <div class="alert info">${isAdmin
      ? "Vos saisies sont <strong>directement ajoutées au calendrier</strong>."
      : "Vos saisies sont <strong>envoyées à l'administrateur pour validation</strong> avant d'apparaître au planning."}</div>
    <div id="abs-list" class="empty">Chargement…</div>
    <div id="abs-sanctions"></div>`;
  document.getElementById('abs-new').onclick = () => adminAssignModal();
  renderSanctionsArchive(document.getElementById('abs-sanctions'));
  try {
    const { team } = await api('GET', '/team');
    const el = document.getElementById('abs-list'); el.className = '';
    // Chaque équipe affiche SON responsable au-dessus de ses membres.
    const RESP_OF = { grp_gls: 'grp_resp_gls', grp_ciblex: 'grp_resp_ciblex', grp_fedex: 'grp_resp_fedex' };
    const respGroupIds = new Set(Object.values(RESP_OF));
    const staffMembers = team.filter((m) => m.role !== 'employee');
    const employees = team.filter((m) => m.role === 'employee');
    const byGroup = {};
    employees.forEach((m) => { const k = m.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(m); });
    const byName = (a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName);
    const personBox = (m, sub) => `<div class="person-box" style="border-left:4px solid ${(groupById(m.groupId)||{}).color||'#94a3b8'}">
      <div class="pb-name">${esc(m.firstName)} ${esc(m.lastName)}</div>
      ${sub?`<div class="help">${sub}</div>`:''}
      <button class="btn ghost sm" data-abs="${m.id}" style="margin-top:.4rem">Saisir une absence</button>
    </div>`;
    const usedStaff = new Set();
    // Groupes opérationnels (on saute les groupes « Responsable … » dédiés).
    const order = State.groups.map((g) => g.id).filter((id) => !respGroupIds.has(id)).concat([null]);
    const sections = order.map((gid) => {
      const g = groupById(gid);
      const emps = (byGroup[gid || 'none'] || []).slice().sort(byName);
      const resps = gid ? staffMembers.filter((m) => m.groupId === RESP_OF[gid] || m.groupId === gid).sort(byName) : [];
      resps.forEach((r) => usedStaff.add(r.id));
      if (!emps.length && !resps.length) return '';
      return `<div class="card"><h3>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'Sans groupe'} <span class="help">${emps.length} salarié(s)</span></h3>
        ${resps.length?`<div class="abs-resp"><div class="help" style="margin:0 0 .35rem">👔 Responsable(s)</div><div class="person-grid">${resps.map((m) => personBox(m, roleLabel(m.role))).join('')}</div></div>`:''}
        <div class="person-grid">${emps.length?emps.map((m) => personBox(m)).join(''):'<div class="help">Aucun salarié dans ce groupe.</div>'}</div></div>`;
    }).join('');
    // Encadrement restant (direction, exploitation, responsables non rattachés).
    const remaining = staffMembers.filter((m) => !usedStaff.has(m.id)).sort(byName);
    const staffSection = remaining.length ? `<div class="card" style="border-left:4px solid var(--brand)"><h3>👔 Direction & encadrement</h3>
      <div class="person-grid">${remaining.map((m) => personBox(m, roleLabel(m.role))).join('')}</div></div>` : '';
    el.innerHTML = sections + staffSection;
    el.querySelectorAll('[data-abs]').forEach((b) => b.onclick = () => adminAssignModal(null, b.dataset.abs));
  } catch (e) { document.getElementById('abs-list').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

// Historique des avertissements & sanctions (archivé).
async function renderSanctionsArchive(el) {
  if (!el) return;
  let sanctions = [];
  try { sanctions = (await api('GET', '/staff/sanctions')).sanctions; } catch (e) { return; }
  const isAdmin = State.user.role === 'admin';
  el.innerHTML = `<div class="card"><h3>📁 Historique des avertissements & sanctions</h3>
    ${sanctions.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Salarié</th><th>Type</th><th>Motif</th><th>Par</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
      <tbody>${sanctions.map((s) => `<tr><td>${fmtDate(s.date)}</td><td><strong>${esc(s.userName)}</strong></td><td><span class="pill ${/licenciement|pied/i.test(s.type) ? 'danger' : 'warn'}">${esc(s.type)}</span></td><td>${esc(s.motif || '—')}</td><td class="help">${esc(s.createdByName || '')}</td>
        ${isAdmin ? `<td style="white-space:nowrap"><button class="btn ghost sm" data-reopendisc="${s.userId}" title="Ré-afficher le rappel">↩</button> <button class="btn ghost sm" data-delsanction="${s.id}">✕</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
    : '<p class="help">Aucune sanction archivée.</p>'}</div>`;
  if (isAdmin) {
    el.querySelectorAll('[data-delsanction]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer cette entrée d\'historique ?')) return; try { await api('DELETE', '/admin/sanctions/' + b.dataset.delsanction); renderSanctionsArchive(el); } catch (e) { toast(e.message, 'err'); } });
    el.querySelectorAll('[data-reopendisc]').forEach((b) => b.onclick = async () => { try { await api('POST', '/admin/discipline/' + b.dataset.reopendisc + '/reopen'); toast('Rappel ré-affiché sur l\'accueil.', 'ok'); } catch (e) { toast(e.message, 'err'); } });
  }
}

/* =========================================================================
   VÉHICULES — signalement chauffeur + gestion de flotte
   ========================================================================= */

// Liste des usures / pannes courantes proposées au chauffeur, avec leur degré
// d'urgence (sécurité). Niveaux : critique (ne pas rouler), urgent (sous quelques
// jours), planifie (à programmer), surveillance (à surveiller).
const VEHICLE_ISSUES = [
  { label: 'Freins avant usés (plaquettes / disques)', urgency: 'critique' },
  { label: 'Freins arrière usés (plaquettes / disques)', urgency: 'critique' },
  { label: 'Garniture de frein à main (ne tient plus la charge)', urgency: 'critique' },
  { label: 'Pneus avant usés', urgency: 'critique' },
  { label: 'Pneus arrière usés', urgency: 'critique' },
  { label: 'Voyant moteur avec perte de puissance', urgency: 'critique' },
  { label: 'Fuite constatée (huile / liquide)', urgency: 'urgent' },
  { label: 'Voyant moteur sans perte de puissance', urgency: 'urgent' },
  { label: 'Turbo inefficace', urgency: 'urgent' },
  { label: 'Pare-brise fissuré ou impacté', urgency: 'urgent' },
  { label: 'Éclairage défectueux (feux / clignotants / stop à droite)', urgency: 'urgent' },
  { label: 'Éclairage défectueux (feux / clignotants / stop à gauche)', urgency: 'urgent' },
  { label: 'Embrayage / boîte de vitesses (point dur, à-coups)', urgency: 'urgent' },
  { label: 'Batterie faible / démarrage difficile', urgency: 'urgent' },
  { label: 'Pneus sous-gonflés / témoin de pression allumé', urgency: 'urgent' },
  { label: 'Bruit anormal ou vibration', urgency: 'urgent' },
  { label: 'Vidange à prévoir', urgency: 'planifie' },
  { label: 'Révision « Service A » (intermédiaire) à prévoir', urgency: 'planifie' },
  { label: 'Révision « Service B » (grande révision) à prévoir', urgency: 'planifie' },
  { label: 'Essuie-glaces à remplacer', urgency: 'planifie' },
  { label: 'Niveaux à compléter (huile / lave-glace / liquide de refroidissement)', urgency: 'planifie' },
  { label: 'Climatisation / chauffage défaillant', urgency: 'planifie' },
  { label: 'Carrosserie endommagée (choc / rayure)', urgency: 'surveillance' },
];
const URGENCY_META = {
  critique: { label: 'Critique — ne pas rouler', cls: 'danger' },
  urgent: { label: 'Urgent — sous quelques jours', cls: 'warn' },
  planifie: { label: 'À planifier', cls: '' },
  surveillance: { label: 'À surveiller', cls: 'muted' },
};
const ISSUE_URGENCY = Object.fromEntries(VEHICLE_ISSUES.map((i) => [i.label, i.urgency]));
function issueUrgencyBadge(label) {
  const u = ISSUE_URGENCY[label]; if (!u) return '';
  const m = URGENCY_META[u]; return ` <span class="pill ${m.cls}">${esc(m.label.split(' —')[0])}</span>`;
}

// Types de dommage relevés lors d'un tour de véhicule.
const IMPACT_TYPES = ['Rayure', 'Choc / enfoncement', 'Fissure', 'Bris de glace', 'Rouille', 'Pièce manquante / cassée', 'Autre'];

// Bandeau d'accueil (encadrement) : véhicules/chauffeurs à mettre en conformité.
function vehicleWarningsHTML(warnings) {
  if (!warnings || !warnings.length) return '';
  const row = (w) => `<li>
    <span class="pill ${w.severity === 'avertissement' ? 'danger' : 'warn'}">${w.severity === 'avertissement' ? 'AVERTISSEMENT' : 'À surveiller'}</span>
    <strong>${esc(w.vehicleName || '—')}</strong>${w.plate ? ` (${esc(w.plate)})` : ''}${w.driverName ? ` · chauffeur : <strong>${esc(w.driverName)}</strong>` : ''}
    ${w.key ? `<button class="btn ghost sm" data-warnack="${esc(w.key)}" style="margin-left:.4rem">J'ai lu</button>` : ''}
    <div class="help">${esc(w.detail)}</div>
  </li>`;
  const av = warnings.filter((w) => w.severity === 'avertissement');
  const su = warnings.filter((w) => w.severity !== 'avertissement');
  return `<div class="card" style="border-left:5px solid var(--danger)">
    <h3 style="margin:0">⚠️ Conformité des véhicules — à mettre en demeure avant avertissement</h3>
    <p class="help" style="margin:.3rem 0 .6rem">Manquements relevés lors des derniers tours de véhicule (documents, équipements, propreté, localisation des documents). ${av.length} avertissement(s), ${su.length} point(s) à surveiller.</p>
    <ul class="veh-alert-list veh-warn-list">${av.map(row).join('')}${su.map(row).join('')}</ul>
  </div>`;
}

// Accueil : signalements d'entretien des chauffeurs en attente.
function dashVehiclePendingHTML(reports) {
  if (!reports || !reports.length) return '';
  return `<div class="card" style="border-left:5px solid var(--warn)">
    <h3 style="margin:0 0 .5rem">🔧 Demandes d'entretien des chauffeurs en attente (${reports.length})</h3>
    <ul class="veh-alert-list">${reports.map((r) => `<li>
      <strong>${esc(r.vehicleName)}</strong> (${esc(r.plate)}) · ${kmFmt(r.km)} — ${esc(r.userName)}
      ${r.issues && r.issues.length ? `<div class="help">${r.issues.map(esc).join(' · ')}</div>` : ''}${r.note ? `<div class="help">${esc(r.note)}</div>` : ''}
    </li>`).join('')}</ul>
    <button class="btn ghost sm" onclick="State.view='vehmgmt';renderApp()">Traiter dans Gestion des véhicules</button>
  </div>`;
}
// Accueil : alertes de stock bas (rouge ≤1, jaune 2, vert 3).
function stockAlertHTML(alerts) {
  if (!alerts || !alerts.length) return '';
  const reds = alerts.filter((a) => a.level === 'red'), yel = alerts.filter((a) => a.level === 'yellow'), grn = alerts.filter((a) => a.level === 'green');
  const line = (a) => `<li><span class="pill ${a.level === 'red' ? 'danger' : a.level === 'yellow' ? 'warn' : 'ok'}">${a.qty} ${esc(a.unit)}</span> <strong>${esc(a.name)}</strong> <span class="help">(${esc(a.category)}${a.fits ? ' · 🚐 ' + esc(a.fits) : ''})</span>${a.level === 'red' ? ' — <strong style="color:var(--danger)">à commander d\'urgence</strong>' : a.level === 'yellow' ? ' — à commander bientôt' : ''}</li>`;
  return `<div class="card" style="border-left:5px solid ${reds.length ? 'var(--danger)' : yel.length ? 'var(--warn)' : 'var(--ok)'}">
    <h3 style="margin:0 0 .4rem">📦 Stock à réapprovisionner</h3>
    <ul class="veh-alert-list">${reds.map(line).join('')}${yel.map(line).join('')}${grn.map(line).join('')}</ul>
  </div>`;
}
// Accueil : entretiens libres programmés proches de l'échéance.
function scheduledHTML(scheduled) {
  if (!scheduled || !scheduled.length) return '';
  return `<div class="card" style="border-left:5px solid var(--warn)">
    <h3 style="margin:0 0 .4rem">🗓️ Entretiens programmés à venir</h3>
    <ul class="veh-alert-list">${scheduled.map((s) => `<li><span class="pill ${s.over ? 'danger' : 'warn'}">${s.over ? 'À FAIRE' : 'BIENTÔT'}</span> <strong>${esc(s.vehicleName)}</strong>${s.plate ? ` (${esc(s.plate)})` : ''} — ${esc(s.label)}${s.dueKm != null ? ` · à ${kmFmt(s.dueKm)}` : ''}${s.dueDate ? ` · ${fmtDate(s.dueDate)}` : ''}</li>`).join('')}</ul>
  </div>`;
}
// Accueil : entretiens à anticiper (commander les pièces).
function dashEntretiensHTML(alerts) {
  if (!alerts || !alerts.length) return '';
  return `<div class="card" style="border-left:5px solid var(--accent)">
    <h3 style="margin:0 0 .5rem">🔔 Entretiens à anticiper (commander les pièces)</h3>
    <ul class="veh-alert-list">${alerts.map((a) => `<li>
      <span class="pill ${a.level === 'overdue' ? 'danger' : 'warn'}">${a.level === 'overdue' ? 'DÉPASSÉ' : 'BIENTÔT'}</span>
      <strong>${esc(a.vehicleName)}</strong> (${esc(a.plate || '—')}) — ${esc(a.label)} :
      ${a.level === 'overdue' ? `dépassé de ${kmFmt(-a.remaining)}` : `dans ${kmFmt(a.remaining)}`}
      <span class="help">(échéance ~${kmFmt(a.dueKm)})</span>
    </li>`).join('')}</ul>
  </div>`;
}
// Accueil : situations disciplinaires liées au règlement intérieur.
function disciplineHTML(items) {
  if (!items || !items.length) return '';
  return `<div class="card" style="border-left:5px solid var(--danger)">
    <h3 style="margin:0 0 .5rem">⚖️ Absences pouvant donner lieu à avertissement / sanction (règlement intérieur)</h3>
    <p class="help" style="margin:0 0 .6rem">Sur les 12 derniers mois. À apprécier selon le contexte avant toute mesure.</p>
    <ul class="veh-alert-list veh-warn-list">${items.map((u) => `<li>
      <strong>${esc(u.name)}</strong> <span class="help">(${esc(u.groupName)})</span>
      <button class="btn ghost sm" data-sanction="${u.userId}" data-name="${esc(u.name)}" style="margin-left:.4rem">Avertir / sanctionner & clôturer</button>
      ${u.items.map((it) => `<div class="help">• ${esc(it.label)} ×${it.count} — ${esc(it.reproach)}</div>`).join('')}
    </li>`).join('')}</ul>
  </div>`;
}

// Enregistrer un avertissement / une sanction (et clôturer le rappel d'accueil).
const SANCTION_TYPES_CLIENT = ['Rappel à l\'ordre', 'Avertissement', 'Mise à pied conservatoire', 'Mise à pied disciplinaire', 'Convocation entretien préalable', 'Procédure de licenciement', 'Autre'];
function sanctionModal(userId, name) {
  modal({
    title: 'Avertissement / sanction — ' + name,
    bodyHTML: `<div class="grid2">
        <div><label>Date</label><input id="sn-date" type="date" value="${iso(new Date())}"></div>
        <div><label>Type</label><select id="sn-type">${SANCTION_TYPES_CLIENT.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
      </div>
      <label style="margin-top:.6rem">Motif / commentaire</label>
      <textarea id="sn-motif" style="min-height:90px" placeholder="Faits reprochés, contexte, suite donnée…"></textarea>
      <p class="help">En enregistrant, le rappel est clôturé et archivé dans « Gestion des absences ».</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="sn-save">Enregistrer & clôturer</button>`,
    onMount: (ov) => { ov.querySelector('#sn-save').onclick = async () => {
      try { await api('POST', '/admin/sanctions', { userId, date: ov.querySelector('#sn-date').value, type: ov.querySelector('#sn-type').value, motif: ov.querySelector('#sn-motif').value }); closeModal(); toast('Sanction archivée, rappel clôturé.', 'ok'); renderDashboard(document.getElementById('main')); }
      catch (e) { toast(e.message, 'err'); }
    }; },
  });
}

function vehLabel(v) { return `${v.name}${v.plate ? ' — ' + v.plate : ''}`; }
function kmFmt(n) { return (Number(n) || 0).toLocaleString('fr-FR') + ' km'; }

// Options « Votre véhicule » classées par groupe (optgroups) pour s'y retrouver.
function vehicleOptionsByGroup(vehicles) {
  const order = State.groups.map((g) => g.id).concat([null]);
  const byG = {}; vehicles.forEach((v) => { const k = v.groupId || 'none'; (byG[k] = byG[k] || []).push(v); });
  const opt = (v) => `<option value="${v.id}" data-plate="${esc(v.plate || '')}" data-km="${v.km || 0}">${esc(vehLabel(v))}${v.relais ? ' (relais)' : ''}${v.tournee ? ' · ' + esc(v.tournee) : ''}</option>`;
  return order.map((gid) => {
    const list = byG[gid || 'none']; if (!list || !list.length) return '';
    const g = groupById(gid);
    return `<optgroup label="${esc(g ? g.name : 'Sans groupe')}">${list.map(opt).join('')}</optgroup>`;
  }).join('');
}
function vReportStatusLabel(s) { return s === 'reviewed' ? 'Pris en compte' : s === 'closed' ? 'Clôturé' : 'En attente'; }
function vReportStatusClass(s) { return s === 'reviewed' ? 'ok' : s === 'closed' ? 'muted' : 'warn'; }

// --- Côté salarié : « Mon véhicule » ----------------------------------------
async function renderMyVehicle(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mon véhicule</h1>
    <p>Sélectionnez votre véhicule et signalez toute usure ou anomalie constatée.</p></div></div>
    <div id="mv-body" class="empty">Chargement…</div>`;
  let vehicles = [], myReports = [], conformity = [];
  try {
    vehicles = (await api('GET', '/vehicles')).vehicles;
    myReports = (await api('GET', '/me/vehicle-reports')).reports;
    conformity = (await api('GET', '/me/vehicle-conformity')).items;
  } catch (e) { document.getElementById('mv-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }

  const body = document.getElementById('mv-body'); body.className = '';
  // Bandeau de conformité : documents manquants relevés par le responsable.
  const conformityBanner = (conformity && conformity.length) ? conformity.map((c) => `
    <div class="card" style="border-left:5px solid var(--danger)">
      <h3 style="margin:0 0 .4rem">🚨 Documents manquants sur ${esc(c.vehicleName)}${c.plate ? ' (' + esc(c.plate) + ')' : ''}</h3>
      <p style="margin:0 0 .4rem">Lors du dernier contrôle (${fmtDate(c.date)}), les éléments suivants étaient <strong>absents / non conformes</strong> :</p>
      <ul class="vr-issues">${c.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <p style="margin:.5rem 0 0"><strong>Rapprochez-vous rapidement de la direction</strong> pour mettre votre véhicule en conformité. En cas de contrôle par une autorité compétente débouchant sur une <strong>amende pour non-conformité</strong>, vous en serez redevable du montant.</p>
    </div>`).join('') : '';
  if (!vehicles.length) {
    body.innerHTML = conformityBanner + `<div class="alert info">Aucun véhicule n'est encore enregistré dans la flotte. Contactez la direction pour qu'elle ajoute les véhicules.</div>`;
  } else {
    const issuesHTML = VEHICLE_ISSUES.map((it, i) => `
      <label class="veh-check"><input type="checkbox" class="mv-issue" value="${esc(it.label)}" id="mv-i${i}"> ${esc(it.label)}${issueUrgencyBadge(it.label)}</label>`).join('');
    body.innerHTML = conformityBanner + `
      <div class="card">
        <label>Véhicule en cours d'utilisation</label>
        <select id="mv-vehicle">
          <option value="">— Choisissez votre véhicule —</option>
          ${vehicleOptionsByGroup(vehicles)}
        </select>
        <div class="grid2" style="margin-top:.8rem">
          <div><label>Plaque d'immatriculation *</label><input id="mv-plate" placeholder="AA-123-BB" autocomplete="off"></div>
          <div><label>Kilométrage actuel *</label><input id="mv-km" type="number" min="0" inputmode="numeric" placeholder="ex. 84500"></div>
        </div>
        <label style="margin-top:.8rem">Usures / anomalies constatées</label>
        <div class="veh-issues">${issuesHTML}</div>
        <label style="margin-top:.8rem">Précisions (facultatif)</label>
        <textarea id="mv-note" placeholder="Décrivez le problème, sa localisation, depuis quand…" style="min-height:90px"></textarea>
        <div style="margin-top:1rem"><button class="btn accent" id="mv-send">Envoyer le signalement</button></div>
        <p class="help" style="margin-top:.5rem">Votre signalement est transmis à la direction et apparaît dans le suivi du véhicule.</p>
      </div>
      <div class="card"><h3>Mes signalements récents</h3><div id="mv-mine"></div></div>`;

    const sel = document.getElementById('mv-vehicle');
    const plate = document.getElementById('mv-plate');
    const km = document.getElementById('mv-km');
    sel.onchange = () => {
      const o = sel.selectedOptions[0];
      if (o && o.value) { if (!plate.value) plate.value = o.dataset.plate || ''; if (!km.value && o.dataset.km && o.dataset.km !== '0') km.value = o.dataset.km; }
    };
    document.getElementById('mv-send').onclick = async () => {
      const issues = Array.from(document.querySelectorAll('.mv-issue:checked')).map((c) => c.value);
      const payload = { vehicleId: sel.value, plate: plate.value, km: km.value, issues, note: document.getElementById('mv-note').value };
      if (!payload.vehicleId) { toast('Choisissez votre véhicule.', 'err'); return; }
      try {
        await api('POST', '/vehicles/report', payload);
        toast('Signalement envoyé. Merci !', 'ok');
        renderMyVehicle(main);
      } catch (e) { toast(e.message, 'err'); }
    };
    renderMyVehReports(document.getElementById('mv-mine'), myReports);
  }
}

function resolutionBadge(r) {
  if (r.status !== 'closed') return '';
  if (r.resolution === 'done') return `<span class="pill ok">Travaux réalisés ✔</span>`;
  if (r.resolution === 'partial') return `<span class="pill warn">Partiellement réalisé</span>`;
  if (r.resolution === 'notdone') return `<span class="pill danger">Non réalisé</span>`;
  if (r.resolution === 'none') return `<span class="pill muted">Aucune réparation nécessaire</span>`;
  return '';
}
// Détail des usures avec leur statut réalisé / non réalisé (après clôture).
function issuesWithResolution(r) {
  if (!r.issues || !r.issues.length) return '';
  const byIssue = {}; (r.resolutions || []).forEach((x) => { byIssue[x.issue] = x.done; });
  const closed = r.status === 'closed' && (r.resolutions || []).length;
  return `<ul class="vr-issues">${r.issues.map((i) => {
    if (!closed) return `<li>${esc(i)}${issueUrgencyBadge(i)}</li>`;
    const done = byIssue[i];
    return `<li>${esc(i)}${issueUrgencyBadge(i)} ${done ? '<span class="pill ok">réalisé</span>' : '<span class="pill danger">non réalisé</span>'}</li>`;
  }).join('')}</ul>`;
}

function renderMyVehReports(el, reports) {
  if (!reports.length) { el.innerHTML = `<p class="help">Aucun signalement pour le moment.</p>`; return; }
  el.innerHTML = reports.map((r) => `
    <div class="veh-report">
      <div class="vr-head">
        <strong>${esc(r.vehicleName)}</strong> · ${esc(r.plate)} · ${kmFmt(r.km)}
        <span class="pill ${vReportStatusClass(r.status)}">${vReportStatusLabel(r.status)}</span> ${resolutionBadge(r)}
      </div>
      <div class="help">${fmtDateTime(r.createdAt)}</div>
      ${issuesWithResolution(r)}
      ${r.note ? `<p style="margin:.3rem 0 0">${esc(r.note)}</p>` : ''}
      ${r.adminNote ? `<p class="help" style="margin:.3rem 0 0">↪ Réponse direction : ${esc(r.adminNote)}</p>` : ''}
    </div>`).join('');
}

// --- Côté encadrement : « Gestion des véhicules » ----------------------------
let _veh = null; // cache des données de flotte pour la vue encadrement

async function renderVehicleManagement(main) {
  if (!isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des véhicules</h1>
    <p>Tour du véhicule (état des lieux, propreté, équipements, documents). Le suivi & les alertes et les demandes sont dans « Suivi des entretiens et du stock ».</p></div></div>
    <div id="veh-body" class="empty">Chargement…</div>`;
  await loadFleet();
  vehTab('tour');
}

async function loadFleet() {
  _veh = await api('GET', '/staff/vehicles');
  const badge = document.getElementById('veh-pending-badge');
  if (badge) {
    const n = _veh.reports.filter((r) => r.status === 'pending').length;
    badge.textContent = n ? n : '';
    badge.className = n ? 'badge' : '';
    badge.style.cssText = n ? 'background:var(--accent);color:#fff;border-radius:999px;padding:0 .45rem;font-size:.72rem;font-weight:700' : '';
  }
}

function vehTab(tab) {
  // « Suivi » et « Demandes » ont été déplacés dans « Suivi des entretiens et du
  // stock » : si la page véhicules n'est pas affichée, on rend dans le module Stock.
  let body = document.getElementById('veh-body');
  if (!body && (tab === 'suivi' || tab === 'pending')) { body = document.getElementById('stk-body'); if (body) _stockTab = tab; }
  if (!body) return; body.className = '';
  if (!_veh) { body.innerHTML = `<div class="alert warn">Données indisponibles.</div>`; return; }
  if (tab === 'suivi') return vehTabSuivi(body);
  if (tab === 'pending') return vehTabPending(body);
  if (tab === 'tour') return vehTabTour(body);
  if (tab === 'fleet') return vehTabFleet(body);
}

// Rafraîchit la vue véhicule active selon le contexte (Gestion des véhicules
// ou module Stocks & flotte).
let _stockTab = 'costs';
function vehRefresh() {
  if (document.getElementById('flt-body')) return vehTabFleet(document.getElementById('flt-body'));
  if (document.getElementById('stk-body')) return stockTab(_stockTab);
  if (document.getElementById('veh-body')) return vehTab('suivi');
}

// Pastilles d'usure et de conduite (comparaison à la norme constructeur).
function wearPill(ratio) {
  if (ratio == null) return '<span class="help">—</span>';
  if (ratio <= 0.9) return '<span class="pill ok">use lentement</span>';
  if (ratio <= 1.1) return '<span class="pill">conforme</span>';
  if (ratio <= 1.3) return '<span class="pill warn">use vite</span>';
  return '<span class="pill danger">usure anormale</span>';
}
function gradeColor(g) { return ({ A: 'ok', B: '', C: 'warn', D: 'warn', E: 'danger' })[g] || ''; }
function drivingBadge(d) { return (!d || d.grade === '—') ? '<span class="help">conduite : données insuffisantes</span>' : `<span class="pill ${gradeColor(d.grade)}">Conduite ${esc(d.grade)} · ${d.score}/20</span>`; }
function worstLevel(v) { return v.items.some((i) => i.level === 'overdue') ? 'overdue' : v.items.some((i) => i.level === 'soon') ? 'soon' : 'ok'; }

let _vehOpen = {}; // état déplié/replié par véhicule (minimise l'affichage)
let _admGrp = {};  // état déplié/replié des groupes (Salariés actifs)
let _admHist = {}; // état déplié/replié des groupes (Historique par groupe)

// Onglet « Suivi & alertes » : par véhicule, état des consommables + alertes.
function vehTabSuivi(body) {
  const { vehicles, consumables, alertKm, drivers } = _veh.analysis;
  if (!vehicles.length) { body.innerHTML = `<div class="alert info">Aucun véhicule. Ajoutez-en dans l'onglet « Flotte ».</div>`; return; }
  const isAdmin = State.user.role === 'admin';
  // Bandeau d'alertes globales (entretiens à anticiper).
  const alerts = [];
  vehicles.forEach((v) => v.items.forEach((it) => {
    if (it.level === 'overdue') alerts.push({ v, it, overdue: true });
    else if (it.level === 'soon') alerts.push({ v, it, overdue: false });
  }));
  alerts.sort((a, b) => a.it.remaining - b.it.remaining);
  const alertBanner = alerts.length ? `<div class="card" style="border-left:5px solid var(--accent)">
    <h3 style="margin:0">🔔 Entretiens à anticiper (commander les pièces)</h3>
    <ul class="veh-alert-list">${alerts.map((a) => `<li>
      <span class="pill ${a.overdue ? 'danger' : 'warn'}">${a.overdue ? 'DÉPASSÉ' : 'BIENTÔT'}</span>
      <strong>${esc(a.v.name)}</strong> (${esc(a.v.plate || '—')}) — ${esc(a.it.label)} :
      ${a.overdue ? `dépassé de ${kmFmt(-a.it.remaining)}` : `dans ${kmFmt(a.it.remaining)}`}
      <span class="help">(échéance ~${kmFmt(a.it.dueKm)}, actuel ${kmFmt(a.v.curKm)})</span>
    </li>`).join('')}</ul></div>` : `<div class="alert ok">✅ Aucun entretien imminent (seuil d'alerte : ${kmFmt(alertKm)}).</div>`;

  // Notes de conduite des chauffeurs (usure vs norme constructeur).
  const driversCard = (drivers && drivers.length) ? `<div class="card">
    <h3 style="margin:0 0 .6rem">🏎️ Notes de conduite des chauffeurs</h3>
    <p class="help" style="margin:0 0 .6rem">Comparaison de l'usure réelle des consommables à la norme constructeur (selon l'usage du véhicule). Plus la note est basse, plus la conduite use les pièces.</p>
    <div class="table-wrap"><table class="veh-table"><thead><tr><th>Chauffeur</th><th>Note</th><th>Indice d'usure</th><th>Appréciation</th></tr></thead>
    <tbody>${drivers.map((d) => `<tr><td>${esc(d.name)}</td><td><span class="pill ${gradeColor(d.grade)}">${esc(d.grade)} · ${d.score}/20</span></td><td>${d.ratio}×</td><td>${esc(d.label)}</td></tr>`).join('')}</tbody></table></div>
  </div>` : '';

  const cards = vehicles.map((v) => {
    const open = !!_vehOpen[v.id];
    const wl = worstLevel(v);
    const wlPill = wl === 'overdue' ? '<span class="pill danger">entretien dépassé</span>' : wl === 'soon' ? '<span class="pill warn">entretien proche</span>' : '<span class="pill ok">à jour</span>';
    const usagePill = `<span class="pill">${v.usage === 'ville' ? '🏙️ Ville' : '🛣️ Route + ville'}</span>`;
    const ctPill = v.ct && v.ct.nextDate ? `<span class="pill ${v.ct.level === 'overdue' ? 'danger' : v.ct.level === 'soon' ? 'warn' : 'muted'}">CT ${v.ct.level === 'overdue' ? 'dépassé' : fmtDate(v.ct.nextDate)}</span>` : '';
    const rows = v.items.map((it) => `<tr class="lvl-${it.level}">
      <td>${esc(it.label)}</td>
      <td>${it.lastKm != null ? kmFmt(it.lastKm) : '<span class="help">—</span>'}</td>
      <td>${it.realInterval != null ? `${kmFmt(it.realInterval)} <span class="help">(réel)</span>` : `${kmFmt(it.norm)} <span class="help">(norme)</span>`}<div class="help">norme ${kmFmt(it.norm)} · ${wearPill(it.wearRatio)}</div></td>
      <td>${kmFmt(it.dueKm)}</td>
      <td>${it.level === 'overdue' ? `<span class="pill danger">dépassé ${kmFmt(-it.remaining)}</span>` : it.level === 'soon' ? `<span class="pill warn">dans ${kmFmt(it.remaining)}</span>` : `<span class="pill ok">${kmFmt(it.remaining)}</span>`}</td>
      ${isAdmin ? `<td><button class="btn ghost sm" data-maint="${v.id}" data-part="${it.code}" data-plabel="${esc(it.label)}">Remplacement</button></td>` : ''}
    </tr>`).join('');
    return `<div class="card veh-card">
      <div class="veh-card-head" data-toggle="${v.id}">
        <span class="veh-caret">${open ? '▾' : '▸'}</span>
        <strong>🚐 ${esc(v.name)}</strong> <span class="help">${esc(v.plate || '')}${v.model ? ' · ' + esc(v.model) : ''}</span>
        <span style="margin-left:auto;display:flex;gap:.35rem;flex-wrap:wrap;align-items:center">${usagePill} <span class="pill">${kmFmt(v.curKm)}</span> ${wlPill} ${ctPill} ${drivingBadge(v.driving)}</span>
      </div>
      ${open ? `<div class="veh-card-body">
        ${isAdmin ? `<div class="veh-usage-row">Usage : <button class="btn ghost sm" data-usage="${v.id}" data-to="${v.usage === 'ville' ? 'mixte' : 'ville'}">Basculer en ${v.usage === 'ville' ? 'Route + ville 🛣️' : 'Ville 🏙️'}</button> <span class="help">influe sur les normes d'usure</span></div>` : ''}
        <div class="table-wrap"><table class="veh-table">
          <thead><tr><th>Consommable</th><th>Dernier rempl.</th><th>Intervalle / norme</th><th>Prochaine échéance</th><th>Restant</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${schedListHTML(v.id, isAdmin)}
        ${isAdmin ? `<div style="margin-top:.6rem;display:flex;gap:.4rem;flex-wrap:wrap"><button class="btn ghost sm" data-history="${v.id}">Carnet d'entretien</button><button class="btn ghost sm" data-ct="${v.id}">Contrôle technique</button><button class="btn ghost sm" data-sched="${v.id}">+ Entretien à programmer</button></div>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');

  body.innerHTML = alertBanner + driversCard + cards;
  body.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => { const id = b.dataset.toggle; _vehOpen[id] = !_vehOpen[id]; vehTabSuivi(body); });
  if (isAdmin) {
    body.querySelectorAll('[data-maint]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); maintModal(b.dataset.maint, b.dataset.part, b.dataset.plabel); });
    body.querySelectorAll('[data-history]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); maintHistoryModal(b.dataset.history); });
    body.querySelectorAll('[data-ct]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); ctModal(b.dataset.ct); });
    body.querySelectorAll('[data-sched]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); scheduleModal(b.dataset.sched); });
    body.querySelectorAll('[data-schdone]').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); try { await api('PUT', '/admin/vehicles/schedule/' + b.dataset.schdone, { done: true }); await loadFleet(); vehTabSuivi(body); } catch (err) { toast(err.message, 'err'); } });
    body.querySelectorAll('[data-schdel]').forEach((b) => b.onclick = async (e) => { e.stopPropagation(); try { await api('DELETE', '/admin/vehicles/schedule/' + b.dataset.schdel); await loadFleet(); vehTabSuivi(body); } catch (err) { toast(err.message, 'err'); } });
    body.querySelectorAll('[data-usage]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      try { const r = await api('PUT', '/admin/vehicles/' + b.dataset.usage, { usage: b.dataset.to }); _veh.analysis = r.analysis; await loadFleet(); vehTabSuivi(body); toast('Usage mis à jour.', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
  }
}

// Entretiens libres programmés d'un véhicule (ex. freins/pneus aux 3/4).
function schedListHTML(vehicleId, isAdmin) {
  const list = (_veh.schedule || []).filter((s) => s.vehicleId === vehicleId && !s.done);
  if (!list.length) return '';
  return `<div class="sched-box"><div class="help" style="margin:.4rem 0 .2rem">🗓️ Entretiens à programmer</div>
    ${list.map((s) => `<div class="impact-row"><span><strong>${esc(s.label)}</strong>${s.dueKm != null ? ` · à ${kmFmt(s.dueKm)}` : ''}${s.dueDate ? ` · ${fmtDate(s.dueDate)}` : ''}${s.note ? ` — ${esc(s.note)}` : ''}</span>
      ${isAdmin ? `<span style="margin-left:auto;display:flex;gap:.3rem"><button class="btn ghost sm" data-schdone="${s.id}">Fait</button><button class="btn ghost sm" data-schdel="${s.id}">✕</button></span>` : ''}</div>`).join('')}</div>`;
}
function scheduleModal(vehicleId) {
  const v = _veh.vehicles.find((x) => x.id === vehicleId) || {};
  modal({
    title: 'Programmer un entretien',
    bodyHTML: `<p class="help">${esc(vehLabel(v))} — actuel ${kmFmt(v.km)}</p>
      <label>Intitulé *</label><input id="sc-label" placeholder="ex. Freins avant à prévoir (3/4 d'usure)">
      <div class="grid2" style="margin-top:.5rem">
        <div><label>Échéance kilométrique</label><input id="sc-km" type="number" min="0" placeholder="ex. 90000"></div>
        <div><label>Échéance date</label><input id="sc-date" type="date"></div>
      </div>
      <label style="margin-top:.5rem">Note</label><input id="sc-note" placeholder="détail">`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="sc-save">Programmer</button>`,
    onMount: (ov) => { ov.querySelector('#sc-save').onclick = async () => {
      const payload = { label: ov.querySelector('#sc-label').value, dueKm: ov.querySelector('#sc-km').value, dueDate: ov.querySelector('#sc-date').value, note: ov.querySelector('#sc-note').value };
      if (!payload.label.trim()) { toast('Intitulé obligatoire.', 'err'); return; }
      try { await api('POST', '/admin/vehicles/' + vehicleId + '/schedule', payload); closeModal(); await loadFleet(); vehTab('suivi'); toast('Entretien programmé.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }; },
  });
}

// Kit d'entretien (côté client) : catégories + quantités selon le service/modèle.
function oilLitresClient(model) { return /citan/i.test(model || '') ? 5.4 : 9.5; }
function serviceKitClient(service, model) {
  const oil = { cat: 'Huile moteur 5W30', qty: oilLitresClient(model) };
  if (service === 'service_a') return [{ cat: 'Filtre à huile', qty: 1 }, { cat: 'Filtre habitacle', qty: 1 }, oil];
  if (service === 'service_b') return [{ cat: 'Filtre à huile', qty: 1 }, { cat: 'Filtre à air', qty: 1 }, { cat: 'Filtre habitacle', qty: 1 }, { cat: 'Filtre à gasoil', qty: 1 }, oil];
  return [];
}

async function maintModal(vehicleId, part, partLabel) {
  const v = _veh.vehicles.find((x) => x.id === vehicleId);
  const consumables = _veh.consumables;
  let parts = [], categories = [];
  try { const r = await api('GET', '/admin/parts'); parts = r.parts; categories = r.categories; } catch (e) {}
  const partOptsFor = (cat, sel) => ['<option value="">— Aucune —</option>']
    .concat(parts.filter((p) => !cat || p.category === cat).map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} — ${eur(p.unitPrice)} (stock ${p.qty} ${esc(p.unit)})</option>`)).join('');
  const catOptsSel = (sel) => categories.map((c) => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');

  // Lignes du kit selon le service sélectionné.
  const kitHTML = (service) => {
    const kit = serviceKitClient(service, v ? v.model : '');
    if (!kit.length) return '';
    return `<div class="card" style="margin:.6rem 0;padding:.7rem"><strong>Kit ${service === 'service_a' ? 'Service A' : 'Service B'}</strong> <span class="help">(${esc((v && v.model) || '')})</span>
      ${kit.map((k, i) => `<div class="kit-line"><span class="kit-cat">${esc(k.cat)}</span>
        <select class="mt-kitpart" data-i="${i}">${partOptsFor(k.cat, '')}</select>
        <input class="mt-kitqty" data-i="${i}" type="number" step="0.01" min="0" value="${k.qty}" title="quantité">
      </div>`).join('')}
      <p class="help" style="margin:.3rem 0 0">Choisissez la pièce du stock pour chaque ligne. Le coût s'impute automatiquement au véhicule.</p></div>`;
  };

  modal({
    title: 'Enregistrer un entretien / remplacement',
    bodyHTML: `
      <p class="help">${esc(v ? vehLabel(v) : '')}</p>
      <label>Type d'entretien / consommable</label>
      <select id="mt-part">${consumables.map((c) => `<option value="${c.code}" ${c.code === part ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      <div id="mt-kit">${kitHTML(part)}</div>
      <div class="grid2" style="margin-top:.6rem">
        <div><label>Kilométrage *</label><input id="mt-km" type="number" min="0" value="${v ? (v.km || '') : ''}"></div>
        <div><label>Date</label><input id="mt-date" type="date" value="${iso(new Date())}"></div>
      </div>
      <label style="margin-top:.6rem">Pièces additionnelles du stock (au cas où)</label>
      <div id="mt-extra"></div>
      <button class="btn ghost sm" id="mt-addextra" type="button">+ Ajouter une pièce</button>
      <label style="margin-top:.6rem">Note (facultatif)</label>
      <input id="mt-note" placeholder="Atelier, remarque…">`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="mt-save">Enregistrer l'entretien</button>`,
    onMount: (overlay) => {
      const extra = overlay.querySelector('#mt-extra');
      const addExtraRow = () => {
        const row = document.createElement('div'); row.className = 'kit-line';
        row.innerHTML = `<select class="mt-xcat">${catOptsSel('')}</select><select class="mt-xpart">${partOptsFor(categories[0], '')}</select><input class="mt-xqty" type="number" step="0.01" min="0" value="1"><button class="btn ghost sm mt-xdel" type="button">✕</button>`;
        extra.appendChild(row);
        row.querySelector('.mt-xcat').onchange = (e) => { row.querySelector('.mt-xpart').innerHTML = partOptsFor(e.target.value, ''); };
        row.querySelector('.mt-xdel').onclick = () => row.remove();
      };
      overlay.querySelector('#mt-addextra').onclick = addExtraRow;
      overlay.querySelector('#mt-part').onchange = (e) => { overlay.querySelector('#mt-kit').innerHTML = kitHTML(e.target.value); };
      overlay.querySelector('#mt-save').onclick = async () => {
        const items = [];
        overlay.querySelectorAll('.mt-kitpart').forEach((sel) => { const i = sel.dataset.i; const q = overlay.querySelector(`.mt-kitqty[data-i="${i}"]`).value; if (sel.value) items.push({ partId: sel.value, qty: q }); });
        overlay.querySelectorAll('#mt-extra .kit-line').forEach((row) => { const pid = row.querySelector('.mt-xpart').value; const q = row.querySelector('.mt-xqty').value; if (pid) items.push({ partId: pid, qty: q }); });
        const payload = { part: overlay.querySelector('#mt-part').value, km: overlay.querySelector('#mt-km').value, date: overlay.querySelector('#mt-date').value, note: overlay.querySelector('#mt-note').value, items };
        try {
          const r = await api('POST', '/admin/vehicles/' + vehicleId + '/maint', payload);
          _veh.analysis = r.analysis; closeModal();
          toast(r.maint.cost != null ? `Entretien enregistré (${eur(r.maint.cost)}).` : 'Entretien enregistré.', 'ok');
          await loadFleet(); vehRefresh();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Norme d'un consommable pour un véhicule selon son usage.
function consNorm(c, usage) { return usage === 'ville' ? (c.normVille || c.interval) : (c.normRoute || c.interval); }

// Construit les lignes du carnet d'entretien (par pièce, avec écart vs précédent).
function maintLogRows(vehicleId) {
  const v = _veh.vehicles.find((x) => x.id === vehicleId) || {};
  const usage = v.usage === 'ville' ? 'ville' : 'mixte';
  const consById = Object.fromEntries(_veh.consumables.map((c) => [c.code, c]));
  const out = [];
  _veh.consumables.forEach((c) => {
    const recs = _veh.maint.filter((m) => m.vehicleId === vehicleId && m.part === c.code).sort((a, b) => a.km - b.km);
    const norm = consNorm(c, usage);
    recs.forEach((m, i) => {
      const gap = i > 0 ? m.km - recs[i - 1].km : null;
      let cls = '';
      if (gap != null) cls = gap < norm * 0.8 ? 'lvl-overdue' : gap > norm * 1.15 ? 'lvl-ok' : '';
      out.push({ m, label: consById[c.code].label, gap, norm, cls });
    });
  });
  out.sort((a, b) => b.m.km - a.m.km);
  return out;
}

function maintHistoryModal(vehicleId) {
  const v = _veh.vehicles.find((x) => x.id === vehicleId);
  const rows = maintLogRows(vehicleId);
  modal({
    title: "Carnet d'entretien",
    bodyHTML: `<p class="help">${esc(v ? vehLabel(v) : '')} — usage ${v && v.usage === 'ville' ? 'Ville' : 'Route + ville'}.</p>
      <p class="help">Écart = km parcourus depuis le remplacement précédent de la même pièce. <span class="pill ok">vert</span> = dure plus que la norme, <span class="pill danger">rouge</span> = usure rapide.</p>
      ${rows.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Pièce</th><th>Km</th><th>Écart / norme</th><th>Date</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.cls}">
          <td>${esc(r.label)}</td><td>${kmFmt(r.m.km)}</td>
          <td>${r.gap != null ? `${kmFmt(r.gap)} <span class="help">/ ${kmFmt(r.norm)}</span>` : '<span class="help">1er relevé</span>'}</td>
          <td>${fmtDate(r.m.date)}</td><td>${esc(r.m.note || '')}</td>
          <td style="white-space:nowrap"><button class="btn ghost sm" data-editm="${r.m.id}">✎</button> <button class="btn ghost sm" data-delm="${r.m.id}">✕</button></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<p class="help">Aucun remplacement enregistré.</p>`}`,
    footHTML: `<button class="btn ghost" data-close>Fermer</button><button class="btn" id="mh-pdf">📄 Générer le PDF</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#mh-pdf').onclick = () => vehicleMaintPDF(vehicleId);
      overlay.querySelectorAll('[data-delm]').forEach((b) => b.onclick = async () => {
        if (!confirm('Supprimer ce remplacement ?')) return;
        try { const r = await api('DELETE', '/admin/vehicles/maint/' + b.dataset.delm); _veh.analysis = r.analysis; closeModal(); await loadFleet(); vehRefresh(); toast('Supprimé.', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      });
      overlay.querySelectorAll('[data-editm]').forEach((b) => b.onclick = () => editMaintModal(b.dataset.editm, vehicleId));
    },
  });
}

function editMaintModal(maintId, vehicleId) {
  const m = _veh.maint.find((x) => x.id === maintId); if (!m) return;
  modal({
    title: 'Corriger le remplacement',
    bodyHTML: `<div class="grid2">
        <div><label>Kilométrage</label><input id="em-km" type="number" min="0" value="${m.km}"></div>
        <div><label>Date</label><input id="em-date" type="date" value="${esc(m.date)}"></div>
      </div>
      <label style="margin-top:.6rem">Note</label><input id="em-note" value="${esc(m.note || '')}">`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="em-save">Enregistrer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#em-save').onclick = async () => {
        try {
          const r = await api('PUT', '/admin/vehicles/maint/' + maintId, { km: overlay.querySelector('#em-km').value, date: overlay.querySelector('#em-date').value, note: overlay.querySelector('#em-note').value });
          _veh.analysis = r.analysis; closeModal(); await loadFleet(); maintHistoryModal(vehicleId); toast('Corrigé.', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// PDF du carnet d'entretien d'un véhicule (impression navigateur).
function vehicleMaintPDF(vehicleId) {
  const v = _veh.vehicles.find((x) => x.id === vehicleId) || {};
  const rows = maintLogRows(vehicleId).slice().sort((a, b) => a.label.localeCompare(b.label) || a.m.km - b.m.km);
  const w = window.open('', '_blank');
  if (!w) { toast('Autorisez les fenêtres pop-up pour générer le PDF.', 'err'); return; }
  const tr = rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${kmFmt(r.m.km)}</td><td>${r.gap != null ? kmFmt(r.gap) : '—'}</td><td>${fmtDate(r.m.date)}</td><td>${esc(r.m.note || '')}</td></tr>`).join('');
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Carnet d'entretien — ${esc(v.name || '')}</title>
    <style>body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;padding:24px}h1{color:#14427e;margin:0 0 .2rem}table{width:100%;border-collapse:collapse;margin-top:1rem}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;font-size:13px}th{background:#eef2f7}.sub{color:#475569}</style></head>
    <body>
      <h1>Carnet d'entretien</h1>
      <div class="sub">INTER COLIS SERVICES — Véhicule : <strong>${esc(v.name || '')}</strong>${v.plate ? ' (' + esc(v.plate) + ')' : ''}${v.model ? ' · ' + esc(v.model) : ''}</div>
      <div class="sub">Kilométrage actuel : ${kmFmt(v.curKm || v.km)} · Usage : ${v.usage === 'ville' ? 'Ville' : 'Route + ville'} · Édité le ${fmtDate(iso(new Date()))}</div>
      <table><thead><tr><th>Pièce</th><th>Kilométrage</th><th>Écart depuis précédent</th><th>Date</th><th>Note</th></tr></thead>
      <tbody>${tr || '<tr><td colspan="5">Aucun entretien enregistré.</td></tr>'}</tbody></table>
    </body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

// Liste de contrôle rapide pour un ordre de réparation.
const REPAIR_CHECKUP = ['Niveaux (huile / liquides)', 'Éclairage & signalisation', 'État des pneus', 'Freins', 'Pare-brise / essuie-glaces', 'Documents de bord', 'Propreté', 'Essai routier OK'];

// Onglet « Demandes concernant les véhicules en attente » — ordres de réparation.
function vehTabPending(body) {
  const isAdmin = State.user.role === 'admin';
  const reports = _veh.reports;
  const pending = reports.filter((r) => r.status === 'pending');
  // Non clôturés (pris en compte) que l'on peut ré-ouvrir ou clôturer.
  const openOrders = reports.filter((r) => r.status === 'reviewed');
  const closed = reports.filter((r) => r.status === 'closed').slice(0, 20);

  // Carte « ordre de réparation » éditable (signalement en attente).
  const orderCard = (r) => `<div class="card repair-order">
    <div class="ro-head">
      <div><span class="ro-tag">ORDRE DE RÉPARATION</span> N° ${esc(r.id)}</div>
      <span class="pill ${vReportStatusClass(r.status)}">${vReportStatusLabel(r.status)}</span>
    </div>
    <div class="ro-grid">
      <div><span class="help">Véhicule</span><br><strong>${esc(r.vehicleName)}</strong></div>
      <div><span class="help">Immatriculation</span><br>${esc(r.plate)}</div>
      <div><span class="help">Kilométrage</span><br>${kmFmt(r.km)}</div>
      <div><span class="help">Déclarant</span><br>${esc(r.userName)}</div>
      <div><span class="help">Le</span><br>${fmtDateTime(r.createdAt)}</div>
    </div>
    <h4 style="margin:.6rem 0 .3rem">Travaux demandés</h4>
    ${r.issues.length ? `<div class="vr-reslist">${r.issues.map((i) => `<label class="veh-check"><input type="checkbox" class="vr-res" data-rep="${r.id}" data-issue="${esc(i)}" ${(r.resolutions || []).find((x) => x.issue === i && x.done) ? 'checked' : ''}> Réalisé : ${esc(i)}${issueUrgencyBadge(i)}</label>`).join('')}</div>` : '<p class="help">Aucune usure cochée — voir la remarque du chauffeur.</p>'}
    ${r.note ? `<p style="margin:.3rem 0 0"><em>« ${esc(r.note)} »</em></p>` : ''}
    <h4 style="margin:.7rem 0 .3rem">Check-up atelier rapide</h4>
    <div class="vr-reslist ro-checkup">${REPAIR_CHECKUP.map((c) => `<label class="veh-check"><input type="checkbox" class="ro-chk" data-rep="${r.id}" data-c="${esc(c)}"> ${esc(c)}</label>`).join('')}</div>
    <label style="margin-top:.5rem">Commentaire de clôture / motif</label>
    <input class="vr-note" data-note="${r.id}" placeholder="Travaux réalisés, pièces, ou motif de non-réalisation…" value="${esc(r.adminNote || '')}">
    <div class="vr-actions" style="margin-top:.5rem">
      <button class="btn sm" data-decide="${r.id}" data-d="reviewed">Prendre en compte (laisser ouvert)</button>
      <button class="btn ok sm" data-decide="${r.id}" data-d="closed">Clôturer (travaux statués)</button>
      <button class="btn ghost sm" data-none="${r.id}">Aucune réparation à effectuer</button>
    </div>
  </div>`;

  // Carte récapitulative (traité / clôturé) avec ré-ouverture si non clôturé.
  const summaryCard = (r) => `<div class="card veh-report">
    <div class="vr-head"><strong>${esc(r.vehicleName)}</strong> · ${esc(r.plate)} · ${kmFmt(r.km)}
      <span class="pill ${vReportStatusClass(r.status)}">${vReportStatusLabel(r.status)}</span> ${resolutionBadge(r)}</div>
    <div class="help">Signalé par ${esc(r.userName)} le ${fmtDateTime(r.createdAt)}</div>
    ${issuesWithResolution(r)}
    ${r.adminNote ? `<p class="help" style="margin:.3rem 0 0">↪ ${esc(r.adminNote)}</p>` : ''}
    ${isAdmin ? `<div class="vr-actions" style="margin-top:.4rem">
      <button class="btn sm" data-reopen="${r.id}">Ré-ouvrir</button>
      ${r.status !== 'closed' ? `<button class="btn ok sm" data-reopenclose="${r.id}">Clôturer</button>` : ''}
    </div>` : ''}
  </div>`;

  body.innerHTML = `
    <h3>Ordres de réparation ouverts (${pending.length})</h3>
    ${pending.length ? pending.map(orderCard).join('') : '<div class="alert ok">Aucune demande en attente. 👍</div>'}
    ${openOrders.length ? `<h3 style="margin-top:1.2rem">Pris en compte — à clôturer (${openOrders.length})</h3>${openOrders.map(summaryCard).join('')}` : ''}
    ${closed.length ? `<h3 style="margin-top:1.2rem">Clôturés récemment</h3>${closed.map(summaryCard).join('')}` : ''}`;

  if (!isAdmin) return;
  const collectAndDecide = async (id, decision, extra = {}) => {
    const rep = reports.find((x) => x.id === id);
    const note = (body.querySelector(`[data-note="${id}"]`) || {}).value || '';
    const resolutions = rep && rep.issues ? rep.issues.map((i) => ({ issue: i, done: !!body.querySelector(`.vr-res[data-rep="${id}"][data-issue="${cssEsc(i)}"]`)?.checked })) : [];
    const checkup = REPAIR_CHECKUP.map((c) => ({ label: c, ok: !!body.querySelector(`.ro-chk[data-rep="${id}"][data-c="${cssEsc(c)}"]`)?.checked }));
    try { await api('POST', '/admin/vehicle-reports/' + id + '/decide', Object.assign({ decision, adminNote: note, resolutions, checkup }, extra)); await loadFleet(); vehTab('pending'); toast('Mis à jour. Le chauffeur est informé.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-decide]').forEach((b) => b.onclick = () => collectAndDecide(b.dataset.decide, b.dataset.d));
  body.querySelectorAll('[data-none]').forEach((b) => b.onclick = () => collectAndDecide(b.dataset.none, 'closed', { resolution: 'none' }));
  body.querySelectorAll('[data-reopen]').forEach((b) => b.onclick = async () => { try { await api('POST', '/admin/vehicle-reports/' + b.dataset.reopen + '/decide', { decision: 'pending' }); await loadFleet(); vehTab('pending'); toast('Ré-ouvert.', 'ok'); } catch (e) { toast(e.message, 'err'); } });
  body.querySelectorAll('[data-reopenclose]').forEach((b) => b.onclick = async () => { const note = prompt('Commentaire de clôture (obligatoire si rien n\'a été fait) :', ''); try { await api('POST', '/admin/vehicle-reports/' + b.dataset.reopenclose + '/decide', { decision: 'closed', adminNote: note || 'Clôturé', resolution: 'none' }); await loadFleet(); vehTab('pending'); toast('Clôturé.', 'ok'); } catch (e) { toast(e.message, 'err'); } });
}
// Échappe une valeur pour un sélecteur d'attribut CSS.
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// Onglet « Tour du véhicule » : documents/équipements + propreté + chocs.
let _tour = { vehicleId: '', driverId: '', km: '', note: '', checks: {}, impacts: [] };

// État d'une case : DÉCOCHÉE par défaut — on coche ce qui est présent/conforme.
function trCheckOk(code) { const c = _tour.checks[code]; return c ? c.ok === true : false; }
function trCheckId(code, vehicle) {
  const c = _tour.checks[code];
  if (c && c.id !== undefined) return c.id;
  const arch = vehicle && vehicle.documents && vehicle.documents[code];
  return arch ? arch.id : '';
}

function captureTourForm() {
  const d = document.getElementById('tr-driver'); if (d) _tour.driverId = d.value;
  const k = document.getElementById('tr-km'); if (k) _tour.km = k.value;
  const n = document.getElementById('tr-note'); if (n) _tour.note = n.value;
  _tour.checks = _tour.checks || {};
  document.querySelectorAll('.tr-chk').forEach((cb) => {
    const code = cb.dataset.code; _tour.checks[code] = _tour.checks[code] || {}; _tour.checks[code].ok = cb.checked;
  });
  document.querySelectorAll('.tr-id').forEach((inp) => {
    const code = inp.dataset.code; _tour.checks[code] = _tour.checks[code] || { ok: true }; _tour.checks[code].id = inp.value;
  });
}

function checkItemHTML(c, vehicle) {
  const ok = trCheckOk(c.code);
  const id = c.hasId ? `<input class="tr-id" data-code="${c.code}" placeholder="${esc(c.idLabel || 'N° / référence')}" value="${esc(trCheckId(c.code, vehicle))}" style="margin-top:.25rem">` : '';
  return `<div class="tr-check-item">
    <label class="veh-check"><input type="checkbox" class="tr-chk" data-code="${c.code}" ${ok ? 'checked' : ''}> ${esc(c.label)}</label>
    ${id}
  </div>`;
}

function vehTabTour(body) {
  const vehicles = _veh.vehicles;
  if (!vehicles.length) { body.innerHTML = `<div class="alert info">Aucun véhicule. Ajoutez-en dans l'onglet « Flotte ».</div>`; return; }
  if (!vehicles.some((v) => v.id === _tour.vehicleId)) _tour = { vehicleId: vehicles[0].id, driverId: '', km: '', note: '', checks: {}, impacts: [] };
  const vehicle = vehicles.find((v) => v.id === _tour.vehicleId);
  const team = _veh.team || [];
  const docs = (_veh.checksDef || []).filter((c) => c.group === 'doc');
  const etat = (_veh.checksDef || []).filter((c) => c.group === 'etat');
  body.innerHTML = `
    <div class="card">
      <div class="grid2">
        <div><label>Véhicule</label><select id="tr-vehicle">${vehicles.map((v) => `<option value="${v.id}" ${v.id === _tour.vehicleId ? 'selected' : ''}>${esc(vehLabel(v))}</option>`).join('')}</select></div>
        <div><label>Chauffeur utilisant ce véhicule le jour du contrôle</label><select id="tr-driver"><option value="">— Non précisé —</option>${team.map((m) => `<option value="${m.id}" ${m.id === _tour.driverId ? 'selected' : ''}>${esc(m.firstName)} ${esc(m.lastName)}${m.role !== 'employee' ? ' (' + roleLabel(m.role) + ')' : ''}</option>`).join('')}</select></div>
        <div><label>Kilométrage</label><input id="tr-km" type="number" min="0" placeholder="km du jour" value="${esc(_tour.km)}"></div>
      </div>
      <p class="help" style="margin-top:.5rem">Cochez ce qui est <strong>présent et conforme</strong>. Tout élément <strong>décoché</strong> sera signalé (manquement). La licence et la carte gasoil sont archivées dans le dossier du véhicule pour le suivi.</p>
    </div>
    <div class="card">
      <h3>📄 Documents & équipements de bord</h3>
      <div class="tr-checks">${docs.map((c) => checkItemHTML(c, vehicle)).join('')}</div>
    </div>
    <div class="card">
      <h3>🧽 Propreté & état général</h3>
      <div class="tr-checks">${etat.map((c) => checkItemHTML(c, vehicle)).join('')}</div>
    </div>
    <div class="card">
      <h3>💥 Chocs & dommages carrosserie</h3>
      <p class="help">Cliquez sur une zone du véhicule pour signaler un choc ou un dommage, puis choisissez le type.</p>
      <div class="van-wrap">${vanDiagramSVG(_tour.impacts)}</div>
      <div id="tr-list" style="margin-top:.6rem"></div>
    </div>
    <div class="card">
      <label>Observations générales (facultatif)</label>
      <textarea id="tr-note" style="min-height:70px" placeholder="État général, remarques…">${esc(_tour.note)}</textarea>
      <div style="margin-top:1rem"><button class="btn accent" id="tr-save">Enregistrer le tour du véhicule</button></div>
    </div>
    <div class="card"><h3>Tours de véhicule précédents</h3><div id="tr-history"></div></div>`;

  document.getElementById('tr-vehicle').onchange = (e) => { _tour = { vehicleId: e.target.value, driverId: '', km: '', note: '', checks: {}, impacts: [] }; vehTab('tour'); };
  bindVanZones(body);
  renderTourList();
  renderTourHistory(document.getElementById('tr-history'));
  document.getElementById('tr-save').onclick = async () => {
    captureTourForm();
    const checksDef = _veh.checksDef || [];
    const hasChecks = checksDef.length > 0;
    if (!hasChecks && !_tour.impacts.length) { toast('Renseignez les contrôles ou ajoutez un choc.', 'err'); return; }
    // Construit l'objet checks pour toutes les cases définies.
    const checks = {};
    checksDef.forEach((c) => { const cur = _tour.checks[c.code] || {}; checks[c.code] = { ok: cur.ok !== false, id: c.hasId ? (cur.id || '') : '' }; });
    try {
      await api('POST', '/staff/vehicles/' + _tour.vehicleId + '/inspection', {
        km: _tour.km, driverId: _tour.driverId, note: _tour.note, checks, impacts: _tour.impacts,
      });
      _tour = { vehicleId: _tour.vehicleId, driverId: '', km: '', note: '', checks: {}, impacts: [] };
      toast('Tour du véhicule enregistré.', 'ok');
      await loadFleet(); vehTab('tour');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function bindVanZones(scope) {
  scope.querySelectorAll('.van-zone').forEach((z) => z.onclick = () => {
    const zone = z.dataset.zone, label = z.dataset.label;
    pickImpactType(label, (type, note) => {
      captureTourForm();
      _tour.impacts.push({ zone, zoneLabel: label, type, note: note || '' });
      vehTab('tour');
    });
  });
}

function pickImpactType(zoneLabel, cb) {
  modal({
    title: 'Dommage — ' + zoneLabel,
    bodyHTML: `<label>Type de dommage</label>
      <select id="im-type">${IMPACT_TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
      <label style="margin-top:.6rem">Précision (facultatif)</label>
      <input id="im-note" placeholder="Taille, gravité…">`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="im-add">Ajouter</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#im-add').onclick = () => { cb(overlay.querySelector('#im-type').value, overlay.querySelector('#im-note').value); closeModal(); };
    },
  });
}

function renderTourList() {
  const el = document.getElementById('tr-list'); if (!el) return;
  if (!_tour.impacts.length) { el.innerHTML = `<p class="help">Aucun point relevé. Cliquez sur le schéma ci-dessus.</p>`; return; }
  el.innerHTML = _tour.impacts.map((i, idx) => `<div class="impact-row">
    <span class="impact-dot"></span>
    <span><strong>${esc(i.zoneLabel)}</strong> — ${esc(i.type)}${i.note ? ' · ' + esc(i.note) : ''}</span>
    <button class="btn ghost sm" data-rmimp="${idx}">✕</button>
  </div>`).join('');
  el.querySelectorAll('[data-rmimp]').forEach((b) => b.onclick = () => { captureTourForm(); _tour.impacts.splice(Number(b.dataset.rmimp), 1); vehTab('tour'); });
}

function renderTourHistory(el) {
  const recs = _veh.inspections.filter((i) => i.vehicleId === _tour.vehicleId)
    .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // chrono pour repérer le 1er
  const isStaff = State.user.role === 'admin' || State.user.role === 'responsable';
  const isAdmin = State.user.role === 'admin';
  const labelByCode = Object.fromEntries((_veh.checksDef || []).map((c) => [c.code, c.label]));
  if (!recs.length) { el.innerHTML = `<p class="help">Aucun tour enregistré pour ce véhicule.</p>`; return; }
  const baselineId = recs[0].id;
  el.innerHTML = recs.slice().reverse().map((r) => {
    const checks = r.checks || {};
    const reg = r.regularized || {};
    const missingCodes = Object.keys(checks).filter((k) => checks[k].ok === false);
    const docIds = Object.keys(checks).filter((k) => checks[k].id).map((k) => `${labelByCode[k] || k} : ${checks[k].id}`);
    const isBaseline = r.id === baselineId;
    const activeImpacts = (r.impacts || []).filter((i) => !i.repaired).length;
    return `<div class="veh-report${isBaseline ? ' veh-baseline' : ''}">
      <div class="vr-head"><strong>${fmtDate(r.date)}</strong>${isBaseline ? ' <span class="pill">Tour de départ (base)</span>' : ''} · ${kmFmt(r.km)}${r.driverName ? ' · chauffeur : ' + esc(r.driverName) : ''} · contrôlé par ${esc(r.userName)}
        ${r.impacts && r.impacts.length ? `<span class="pill warn">${activeImpacts}/${r.impacts.length} dommage(s) actif(s)</span>` : ''}${missingCodes.length ? `<span class="pill danger">${missingCodes.length} manquement(s)</span>` : '<span class="pill ok">conforme</span>'}
        ${isAdmin ? `<button class="btn ghost sm" data-delinsp="${r.id}" style="margin-left:auto">Supprimer</button>` : ''}</div>
      ${docIds.length ? `<div class="help">${docIds.map(esc).join(' · ')}</div>` : ''}
      ${missingCodes.length ? `<div class="tr-manq"><div class="help" style="margin:.3rem 0 .2rem">Manquements :</div>${missingCodes.map((k) => `<div class="impact-row">
        <span>${esc(labelByCode[k] || k)} ${reg[k] ? '<span class="pill ok">régularisé</span>' : '<span class="pill danger">manquant</span>'}</span>
        ${isStaff ? `<button class="btn ghost sm" data-reg="${r.id}" data-code="${k}" data-to="${reg[k] ? '0' : '1'}">${reg[k] ? 'Annuler' : 'Régularisé'}</button>` : ''}
      </div>`).join('')}</div>` : ''}
      ${(r.impacts && r.impacts.length) ? `<div class="tr-dmg"><div class="help" style="margin:.4rem 0 .2rem">Dommages carrosserie :</div>${r.impacts.map((i) => `<div class="impact-row${i.repaired ? ' repaired' : ''}">
        <span><strong>${esc(i.zoneLabel || i.zone)}</strong> — ${esc(i.type)}${i.note ? ' · ' + esc(i.note) : ''} ${i.repaired ? '<span class="pill ok">réparation réalisée</span>' : ''}</span>
        ${isStaff ? `<button class="btn ghost sm" data-rep="${i.id}" data-to="${i.repaired ? '0' : '1'}">${i.repaired ? 'Rouvrir' : 'Réparation réalisée'}</button>` : ''}
      </div>`).join('')}</div>` : ''}
      ${r.note ? `<p style="margin:.2rem 0 0">${esc(r.note)}</p>` : ''}
    </div>`;
  }).join('');
  if (isStaff) {
    el.querySelectorAll('[data-rep]').forEach((b) => b.onclick = async () => {
      try { await api('PUT', '/staff/vehicles/impact/' + b.dataset.rep + '/repaired', { repaired: b.dataset.to === '1' }); await loadFleet(); vehTab('tour'); }
      catch (e) { toast(e.message, 'err'); }
    });
    el.querySelectorAll('[data-reg]').forEach((b) => b.onclick = async () => {
      try { await api('PUT', '/staff/vehicles/inspection/' + b.dataset.reg + '/regularize', { code: b.dataset.code, regularized: b.dataset.to === '1' }); await loadFleet(); vehTab('tour'); toast('Mis à jour.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
  }
  if (isAdmin) el.querySelectorAll('[data-delinsp]').forEach((b) => b.onclick = async () => {
    if (!confirm('Supprimer ce tour de véhicule ?')) return;
    try { await api('DELETE', '/staff/vehicles/inspection/' + b.dataset.delinsp); await loadFleet(); vehTab('tour'); toast('Supprimé.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

// Schéma SVG d'un fourgon (vue de dessus) avec zones cliquables. Chaque zone
// porte le nom de la partie (au centre si la place suffit, sinon à côté). Les
// "impacts" déjà relevés sont matérialisés par une pastille sur la zone.
//   kind : 'center' (texte horizontal) | 'vertical' (panneaux latéraux longs)
//          | 'side-left' / 'side-right' (petites zones : texte écrit à côté)
const VAN_ZONES = [
  { zone: 'pare_chocs_av', label: 'Pare-chocs avant', short: 'Pare-chocs AV', x: 66, y: 26, w: 208, h: 24, kind: 'center' },
  { zone: 'capot', label: 'Capot / calandre', short: 'Capot', x: 66, y: 52, w: 208, h: 44, kind: 'center' },
  { zone: 'pare_brise', label: 'Pare-brise', short: 'Pare-brise', x: 110, y: 100, w: 120, h: 42, kind: 'center' },
  { zone: 'retro_g', label: 'Rétroviseur gauche', short: 'Rétro G', x: 40, y: 104, w: 18, h: 26, kind: 'side-left' },
  { zone: 'retro_d', label: 'Rétroviseur droit', short: 'Rétro D', x: 282, y: 104, w: 18, h: 26, kind: 'side-right' },
  { zone: 'cote_av_g', label: 'Côté avant gauche (porte conducteur)', short: 'Porte cond. (G)', x: 66, y: 100, w: 40, h: 150, kind: 'vertical' },
  { zone: 'cote_av_d', label: 'Côté avant droit (porte passager)', short: 'Porte pass. (D)', x: 234, y: 100, w: 40, h: 150, kind: 'vertical' },
  { zone: 'toit', label: 'Toit', short: 'Toit', x: 110, y: 146, w: 120, h: 320, kind: 'center' },
  { zone: 'cote_ar_g', label: 'Côté arrière gauche', short: 'Flanc AR G', x: 66, y: 254, w: 40, h: 270, kind: 'vertical' },
  { zone: 'cote_ar_d', label: 'Côté arrière droit', short: 'Flanc AR D', x: 234, y: 254, w: 40, h: 270, kind: 'vertical' },
  { zone: 'portes_ar', label: 'Portes arrière', short: 'Portes AR', x: 110, y: 470, w: 120, h: 96, kind: 'center' },
  { zone: 'pare_chocs_ar', label: 'Pare-chocs arrière', short: 'Pare-chocs AR', x: 66, y: 570, w: 208, h: 44, kind: 'center' },
  { zone: 'roue_av_g', label: 'Roue avant gauche', short: 'Roue AvG', x: 34, y: 140, w: 22, h: 64, kind: 'side-left' },
  { zone: 'roue_av_d', label: 'Roue avant droite', short: 'Roue AvD', x: 284, y: 140, w: 22, h: 64, kind: 'side-right' },
  { zone: 'roue_ar_g', label: 'Roue arrière gauche', short: 'Roue ArG', x: 34, y: 430, w: 22, h: 64, kind: 'side-left' },
  { zone: 'roue_ar_d', label: 'Roue arrière droite', short: 'Roue ArD', x: 284, y: 430, w: 22, h: 64, kind: 'side-right' },
];

function vanZoneLabelSVG(z) {
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  const t = esc(z.short || z.label);
  if (z.kind === 'vertical') return `<text class="van-label" x="${cx}" y="${cy}" text-anchor="middle" transform="rotate(-90 ${cx} ${cy})">${t}</text>`;
  if (z.kind === 'side-left') return `<text class="van-side-label" x="${z.x - 6}" y="${cy + 3}" text-anchor="end">${t}</text>`;
  if (z.kind === 'side-right') return `<text class="van-side-label" x="${z.x + z.w + 6}" y="${cy + 3}" text-anchor="start">${t}</text>`;
  return `<text class="van-label" x="${cx}" y="${cy + 3}" text-anchor="middle">${t}</text>`;
}

function vanDiagramSVG(impacts) {
  const counts = {};
  (impacts || []).forEach((i) => { counts[i.zone] = (counts[i.zone] || 0) + 1; });
  const zones = VAN_ZONES.map((z) => {
    const n = counts[z.zone] || 0;
    const cx = z.x + z.w / 2;
    // La pastille de comptage se place en haut de la zone pour ne pas masquer le nom.
    const my = z.kind === 'center' || z.kind === 'vertical' ? z.y + 13 : z.y + z.h / 2;
    const mark = n ? `<g class="van-mark"><circle cx="${cx}" cy="${my}" r="10" /><text x="${cx}" y="${my + 4}" text-anchor="middle">${n}</text></g>` : '';
    return `<rect class="van-zone${n ? ' has-mark' : ''}" data-zone="${z.zone}" data-label="${esc(z.label)}" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="7"><title>${esc(z.label)}</title></rect>${vanZoneLabelSVG(z)}${mark}`;
  }).join('');
  return `<svg viewBox="-82 0 504 648" class="van-svg" role="img" aria-label="Schéma du véhicule">
    <rect x="60" y="22" width="220" height="596" rx="30" class="van-body" />
    <text x="170" y="14" text-anchor="middle" class="van-cap">AVANT</text>
    <text x="170" y="636" text-anchor="middle" class="van-cap">ARRIÈRE</text>
    ${zones}
  </svg>`;
}

// Options de chauffeur (liste des utilisateurs de la base) et de groupe.
function driverOptions(selectedId) {
  const team = (_veh.team || []).slice().sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  // Chauffeurs déjà attribués à un véhicule (hors celui en cours d'édition) :
  // affichés dans une catégorie non sélectionnable pour éviter les doublons.
  const assigned = new Set((_veh.vehicles || []).map((v) => v.assignedUserId).filter(Boolean));
  if (selectedId) assigned.delete(selectedId);
  const label = (m) => `${esc(m.lastName)} ${esc(m.firstName)}${m.role !== 'employee' ? ' (' + roleLabel(m.role) + ')' : ''}`;
  const free = team.filter((m) => !assigned.has(m.id));
  const taken = team.filter((m) => assigned.has(m.id));
  let html = `<option value="">— Aucun —</option>` + free.map((m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${label(m)}</option>`).join('');
  if (taken.length) html += `<optgroup label="— Déjà attribués à un véhicule —" disabled>` + taken.map((m) => `<option value="${m.id}" disabled>${label(m)}</option>`).join('') + `</optgroup>`;
  return html;
}
function groupOptions(selectedId) {
  return `<option value="">— Aucun —</option>` + (_veh.groups || State.groups).map((g) => `<option value="${g.id}" ${g.id === selectedId ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
}
function modelOptions(selected) {
  return `<option value="">— Choisir —</option>` + (_veh.models || []).map((m) => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

// Onglet « Flotte » : ajout / modification / suppression des véhicules (admin).
// Suivi du kilométrage : graphique d'évolution + tableau des km parcourus par
// véhicule (moyennes pour l'entretien et les commandes de stock).
async function loadFleetKm() {
  const el = document.getElementById('flt-km'); if (!el) return;
  try {
    const { log, vehicles } = await api('GET', '/staff/vehicle-km');
    el.className = '';
    el.innerHTML = `<h3 style="margin:1rem 0 .3rem">📈 Évolution des kilomètres par véhicule</h3>
      <p class="help" style="margin-top:0">Relevés issus des rapports d'activité importés — pour estimer les moyennes et ajuster l'entretien et les commandes de stock.</p>
      ${fleetKmHTML(vehicles, log)}`;
  } catch (e) { el.className = ''; el.innerHTML = `<p class="help">Suivi kilométrique indisponible.</p>`; }
}
function fleetKmHTML(vehicles, log) {
  const byVeh = {};
  (log || []).forEach((l) => { (byVeh[l.vehicleId] = byVeh[l.vehicleId] || []).push(l); });
  const cards = (vehicles || []).map((v) => {
    const entries = (byVeh[v.id] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!entries.length) return '';
    const months = {}; const byDriver = {};
    entries.forEach((l) => { const k = (l.date || '').slice(0, 7); months[k] = (months[k] || 0) + (l.km || 0); byDriver[l.userName || '—'] = (byDriver[l.userName || '—'] || 0) + (l.km || 0); });
    const mkeys = Object.keys(months).sort();
    const totals = mkeys.map((k) => months[k]);
    const tot = totals.reduce((s, x) => s + x, 0);
    const avg = Math.round(tot / mkeys.length);
    const maxv = Math.max(1, ...totals);
    const bars = `<div class="bars">${mkeys.map((k) => { const val = months[k]; const h = Math.round((val / maxv) * 100); return `<div class="bar-col"><div class="bar-wrap"><div class="bar pos" style="height:${h}%" title="${kmFmt(val)}"></div></div><div class="bar-lbl">${esc(k.slice(2))}</div><div class="bar-val">${val.toLocaleString('fr-FR')}</div></div>`; }).join('')}</div>`;
    const mrows = mkeys.map((k) => `<tr><td>${esc(k)}</td><td>${kmFmt(months[k])}</td></tr>`).join('');
    const drivers = Object.keys(byDriver).sort((a, b) => byDriver[b] - byDriver[a]).map((n) => `${esc(n)} : ${kmFmt(byDriver[n])}`).join(' · ');
    return `<div class="card zoom-hover">
      <h4 style="margin:.1rem 0 .3rem">🚐 ${esc(v.name)}${v.plate ? ` (${esc(v.plate)})` : ''} — odomètre ${kmFmt(v.km)}</h4>
      ${mkeys.length > 1 ? `<div style="margin:.4rem 0">${bars}</div>` : ''}
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Km parcourus</th></tr></thead><tbody>${mrows}<tr><th>Total</th><th>${kmFmt(tot)}</th></tr><tr><th>Moyenne / mois</th><th>${kmFmt(avg)}</th></tr></tbody></table></div>
      <p class="help" style="margin:.3rem 0 0">Par chauffeur : ${drivers || '—'}</p>
    </div>`;
  }).filter(Boolean).join('');
  return cards || '<p class="help">Aucun relevé de kilométrage importé pour le moment (importez un rapport contenant une colonne véhicule + kilomètres).</p>';
}

function vehTabFleet(body) {
  const vehicles = _veh.vehicles;
  body.innerHTML = `
    <div class="card">
      <h3>Ajouter un véhicule</h3>
      <div class="grid2">
        <div><label>Nom (chauffeur attribué)</label><select id="fl-user">${driverOptions('')}</select></div>
        <div><label>Groupe</label><select id="fl-group">${groupOptions('')}</select></div>
        <div><label>Tournée</label><input id="fl-tournee" placeholder="ex. Tournée Caen Nord"></div>
        <div><label>Modèle</label><select id="fl-model">${modelOptions('')}</select></div>
        <div><label>Plaque</label><input id="fl-plate" placeholder="AA123BB (tirets ajoutés auto.)"></div>
        <div><label>Kilométrage d'origine</label><input id="fl-km" type="number" min="0" placeholder="0"></div>
        <div><label>Usage</label><select id="fl-usage"><option value="mixte">Route + ville</option><option value="ville">Ville uniquement</option></select></div>
      </div>
      <label class="veh-check" style="margin-top:.6rem"><input type="checkbox" id="fl-relais"> Véhicule relais</label>
      <div style="margin-top:.6rem"><button class="btn accent" id="fl-add">Ajouter à la flotte</button></div>
      <p class="help" style="margin-top:.4rem">Le « Nom » et le « Groupe » sont proposés à partir des salariés et groupes du site. Le kilométrage d'origine est le point de départ des calculs d'entretien.</p>
    </div>
    <div class="card"><h3>Flotte (${vehicles.length})</h3>
      ${vehicles.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Nom</th><th>Groupe</th><th>Tournée</th><th>Modèle</th><th>Plaque</th><th>Km</th><th>Actif</th><th></th></tr></thead>
        <tbody>${vehicles.map((v) => `<tr>
          <td>${esc(v.name)}${v.relais ? ' <span class="pill">relais</span>' : ''}</td>
          <td>${esc((groupById(v.groupId) || {}).name || '—')}</td>
          <td>${esc(v.tournee || '—')}</td>
          <td>${esc(v.model || '—')}</td><td>${esc(v.plate || '—')}</td><td>${kmFmt(v.km)}</td>
          <td><button class="toggle ${v.active !== false ? 'on' : 'off'}" data-toggleactive="${v.id}" data-active="${v.active !== false ? '1' : '0'}" title="Actif / inactif">${v.active !== false ? 'ON' : 'OFF'}</button></td>
          <td style="white-space:nowrap"><button class="btn ghost sm" data-carnet="${v.id}">Carnet</button> <button class="btn ghost sm" data-editv="${v.id}">Modifier</button> <button class="btn ghost sm" data-delv="${v.id}">✕</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucun véhicule dans la flotte.</p>'}
    </div>
    <div id="flt-km" class="empty">Chargement du suivi kilométrique…</div>`;
  loadFleetKm();
  document.getElementById('fl-add').onclick = async () => {
    const payload = {
      assignedUserId: document.getElementById('fl-user').value || null,
      groupId: document.getElementById('fl-group').value || null,
      tournee: document.getElementById('fl-tournee').value,
      model: document.getElementById('fl-model').value,
      plate: document.getElementById('fl-plate').value,
      km: document.getElementById('fl-km').value,
      usage: document.getElementById('fl-usage').value,
      relais: document.getElementById('fl-relais').checked,
    };
    if (!payload.assignedUserId && !payload.groupId && !payload.tournee.trim()) { toast('Renseignez au moins un chauffeur, un groupe ou une tournée.', 'err'); return; }
    try { await api('POST', '/admin/vehicles', payload); toast('Véhicule ajouté.', 'ok'); await loadFleet(); vehRefresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-carnet]').forEach((b) => b.onclick = () => maintHistoryModal(b.dataset.carnet));
  body.querySelectorAll('[data-editv]').forEach((b) => b.onclick = () => fleetEditModal(b.dataset.editv));
  body.querySelectorAll('[data-toggleactive]').forEach((b) => b.onclick = async () => {
    try { await api('PUT', '/admin/vehicles/' + b.dataset.toggleactive, { active: b.dataset.active !== '1' }); await loadFleet(); vehRefresh(); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-delv]').forEach((b) => b.onclick = async () => {
    if (!confirm('Supprimer ce véhicule et tout son historique (signalements, remplacements, tours) ?')) return;
    try { await api('DELETE', '/admin/vehicles/' + b.dataset.delv); toast('Véhicule supprimé.', 'ok'); await loadFleet(); vehRefresh(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function fleetEditModal(id) {
  const v = _veh.vehicles.find((x) => x.id === id); if (!v) return;
  modal({
    title: 'Modifier le véhicule',
    bodyHTML: `<div class="grid2">
      <div><label>Nom (chauffeur attribué)</label><select id="ev-user">${driverOptions(v.assignedUserId)}</select></div>
      <div><label>Groupe</label><select id="ev-group">${groupOptions(v.groupId)}</select></div>
      <div><label>Tournée</label><input id="ev-tournee" value="${esc(v.tournee || '')}"></div>
      <div><label>Nom affiché (laisser vide = auto)</label><input id="ev-name" value="${esc(v.name || '')}"></div>
      <div><label>Modèle</label><select id="ev-model">${modelOptions(v.model)}</select></div>
      <div><label>Plaque</label><input id="ev-plate" value="${esc(v.plate || '')}"></div>
      <div><label>Kilométrage d'origine</label><input id="ev-base" type="number" min="0" value="${v.baseKm || 0}"></div>
      <div><label>Kilométrage actuel (ne peut qu'augmenter)</label><input id="ev-km" type="number" min="0" value="${v.km || 0}"></div>
      <div><label>Usage</label><select id="ev-usage"><option value="mixte" ${v.usage !== 'ville' ? 'selected' : ''}>Route + ville</option><option value="ville" ${v.usage === 'ville' ? 'selected' : ''}>Ville uniquement</option></select></div>
      <div><label>Date de 1re mise en circulation</label><input id="ev-firstreg" type="date" value="${esc(v.firstRegistration || '')}"></div>
    </div>
    <div style="margin-top:.6rem"><button class="btn ghost sm" id="ev-ct">🛠️ Contrôle technique / pollution</button> <span class="help">1er CT à 4 ans, puis cadence annuelle alternée.</span></div>
    <label class="veh-check" style="margin-top:.6rem"><input type="checkbox" id="ev-relais" ${v.relais ? 'checked' : ''}> Véhicule relais</label>
    <label class="veh-check"><input type="checkbox" id="ev-active" ${v.active !== false ? 'checked' : ''}> Véhicule actif (proposé aux chauffeurs)</label>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ev-save">Enregistrer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#ev-ct').onclick = () => ctModal(id);
      overlay.querySelector('#ev-save').onclick = async () => {
        const payload = {
          name: overlay.querySelector('#ev-name').value,
          assignedUserId: overlay.querySelector('#ev-user').value || null,
          groupId: overlay.querySelector('#ev-group').value || null,
          tournee: overlay.querySelector('#ev-tournee').value,
          model: overlay.querySelector('#ev-model').value,
          plate: overlay.querySelector('#ev-plate').value,
          baseKm: overlay.querySelector('#ev-base').value,
          km: overlay.querySelector('#ev-km').value,
          usage: overlay.querySelector('#ev-usage').value,
          relais: overlay.querySelector('#ev-relais').checked,
          active: overlay.querySelector('#ev-active').checked,
          firstRegistration: overlay.querySelector('#ev-firstreg').value || null,
        };
        try { const r = await api('PUT', '/admin/vehicles/' + id, payload); _veh.analysis = r.analysis; closeModal(); toast('Véhicule mis à jour.', 'ok'); await loadFleet(); vehRefresh(); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Gestion du contrôle technique / pollution d'un véhicule.
function ctTypeLabel(t) { return t === 'pollution' ? 'Contrôle pollution' : 'Contrôle technique'; }
function ctModal(vehicleId) {
  const va = (_veh.analysis.vehicles || []).find((x) => x.id === vehicleId) || {};
  const ct = va.ct || {};
  const controls = (va.ctControls || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const nextTxt = ct.nextDate
    ? `Prochain : <strong>${esc(ctTypeLabel(ct.nextType))}</strong> le <strong>${fmtDate(ct.nextDate)}</strong> ${ct.level === 'overdue' ? '<span class="pill danger">dépassé</span>' : ct.level === 'soon' ? '<span class="pill warn">bientôt</span>' : ''}`
    : (ct.firstCTDue ? `1er contrôle technique éligible le <strong>${fmtDate(ct.firstCTDue)}</strong> (4 ans après la 1re mise en circulation).` : 'Renseignez la date de 1re mise en circulation pour calculer la 1re échéance.');
  modal({
    title: 'Contrôle technique / pollution',
    bodyHTML: `<p class="help">${esc(va.name || '')}${va.firstRegistration ? ' · 1re circulation : ' + fmtDate(va.firstRegistration) : ''}</p>
      <div class="alert info" style="margin:.3rem 0">${nextTxt}</div>
      <h4 style="margin:.6rem 0 .3rem">Enregistrer un contrôle réalisé</h4>
      <div class="grid2"><div><label>Type</label><select id="ct-type"><option value="CT">Contrôle technique</option><option value="pollution">Contrôle pollution</option></select></div>
        <div><label>Date réalisée</label><input id="ct-date" type="date" value="${iso(new Date())}"></div></div>
      <div style="margin-top:.5rem"><button class="btn accent sm" id="ct-add">Ajouter</button></div>
      <h4 style="margin:.8rem 0 .3rem">Historique</h4>
      ${controls.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Type</th><th>Date</th><th></th></tr></thead><tbody>${controls.map((c) => `<tr><td>${esc(ctTypeLabel(c.type))}</td><td>${fmtDate(c.date)}</td><td><button class="btn ghost sm" data-delct="${c.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucun contrôle enregistré.</p>'}`,
    footHTML: `<button class="btn ghost" data-close>Fermer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#ct-add').onclick = async () => {
        try { await api('POST', '/admin/vehicles/' + vehicleId + '/ct', { type: overlay.querySelector('#ct-type').value, date: overlay.querySelector('#ct-date').value }); await loadFleet(); closeModal(); ctModal(vehicleId); toast('Contrôle enregistré.', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      };
      overlay.querySelectorAll('[data-delct]').forEach((b) => b.onclick = async () => {
        try { await api('DELETE', '/admin/vehicles/' + vehicleId + '/ct/' + b.dataset.delct); await loadFleet(); closeModal(); ctModal(vehicleId); }
        catch (e) { toast(e.message, 'err'); }
      });
    },
  });
}

/* =========================================================================
   STOCKS & FLOTTE (administrateur) : pièces, coûts d'exploitation, flotte
   ========================================================================= */
const eur = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

async function renderStocks(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Suivi des entretiens et du stock</h1>
    <p>Entretiens des véhicules, stock de pièces et consommables, et coût réel d'exploitation.</p></div></div>
    <div class="view-switch" id="stk-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-stab="pending" class="active">Demandes concernant les véhicules <span id="veh-pending-badge"></span></button>
      <button data-stab="suivi">Suivi & alertes</button>
      <button data-stab="costs">Coûts par véhicule</button>
      <button data-stab="parts">Stock de pièces & consommables</button>
      <button data-stab="categories">Catégories de pièces</button>
    </div>
    <div id="stk-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#stk-tabs');
  tabs.querySelectorAll('[data-stab]').forEach((b) => b.onclick = () => {
    tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); stockTab(b.dataset.stab);
  });
  await loadFleet();
  stockTab('pending');
}

function stockTab(tab) {
  _stockTab = tab;
  const body = document.getElementById('stk-body'); if (!body) return; body.className = '';
  if (tab === 'pending') return vehTabPending(body);
  if (tab === 'suivi') return vehTabSuivi(body);
  if (tab === 'parts') return stockParts(body);
  if (tab === 'categories') return stockCategories(body);
  if (tab === 'costs') return stockCosts(body);
}

// Nouveau menu « Gestion de la flotte » (création & gestion des véhicules).
async function renderFleet(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Gestion de la flotte</h1>
    <p>Créez, modifiez et gérez vos véhicules (modèle, plaque, contrôle technique, carnet…).</p></div></div>
    <div id="flt-body" class="empty">Chargement…</div>`;
  await loadFleet();
  vehTabFleet(document.getElementById('flt-body'));
}

async function stockCategories(body) {
  try { const r = await api('GET', '/admin/parts'); stockCategoriesRender(body, { categories: r.categories, units: r.units }); }
  catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}
// Édition locale (ajout/suppression) des catégories et unités, puis enregistrement.
function stockCategoriesRender(body, data) {
  const cats = data.categories, units = data.units;
  const listEditor = (id, arr, label) => `<div class="card"><h3>${label}</h3>
    <div id="${id}-list">${arr.map((x, i) => `<div class="impact-row"><input data-${id}="${i}" value="${esc(x)}"><button class="btn ghost sm" data-del${id}="${i}">✕</button></div>`).join('') || '<p class="help">Aucun élément.</p>'}</div>
    <div style="display:flex;gap:.4rem;margin-top:.5rem"><input id="${id}-new" placeholder="Ajouter…"><button class="btn ghost sm" id="${id}-add">+ Ajouter</button></div></div>`;
  body.innerHTML = `<div class="alert info">Paramétrez ici vos catégories et unités.</div>
    ${listEditor('cat', cats, 'Catégories de pièces')}${listEditor('unit', units, 'Unités')}
    <button class="btn accent" id="cu-save">Enregistrer</button>`;
  const collect = (id) => Array.from(body.querySelectorAll(`[data-${id}]`)).map((i) => i.value.trim()).filter(Boolean);
  body.querySelector('#cat-add').onclick = () => { const v = body.querySelector('#cat-new').value.trim(); if (v) stockCategoriesRender(body, { categories: collect('cat').concat(v), units: collect('unit') }); };
  body.querySelector('#unit-add').onclick = () => { const v = body.querySelector('#unit-new').value.trim(); if (v) stockCategoriesRender(body, { categories: collect('cat'), units: collect('unit').concat(v) }); };
  body.querySelectorAll('[data-delcat]').forEach((b) => b.onclick = () => stockCategoriesRender(body, { categories: collect('cat').filter((_, i) => i !== Number(b.dataset.delcat)), units: collect('unit') }));
  body.querySelectorAll('[data-delunit]').forEach((b) => b.onclick = () => stockCategoriesRender(body, { categories: collect('cat'), units: collect('unit').filter((_, i) => i !== Number(b.dataset.delunit)) }));
  body.querySelector('#cu-save').onclick = async () => { try { await api('PUT', '/admin/part-categories', { categories: collect('cat'), units: collect('unit') }); toast('Enregistré.', 'ok'); } catch (e) { toast(e.message, 'err'); } };
}

async function stockParts(body) {
  let parts = [], categories = [], units = [];
  try { const r = await api('GET', '/admin/parts'); parts = r.parts; categories = r.categories; units = r.units; } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const stockValue = parts.reduce((s, p) => s + p.unitPrice * p.qty, 0);
  const catOptions = categories.map((c) => `<option>${esc(c)}</option>`).join('');
  const unitOptions = units.map((u) => `<option>${esc(u)}</option>`).join('');
  const qtyOptions = Array.from({ length: 51 }, (_, i) => `<option>${i}</option>`).join('');
  body.innerHTML = `
    <div class="card">
      <h3>Ajouter une pièce / un consommable</h3>
      <div class="grid2">
        <div><label>Désignation *</label><input id="pt-name" placeholder="ex. Plaquettes avant, Huile 5W30, Gasoil…"></div>
        <div><label>Référence</label><input id="pt-ref" placeholder="réf. fournisseur"></div>
        <div><label>Catégorie</label><select id="pt-cat">${catOptions}</select></div>
        <div><label>Prix unitaire (€)</label><input id="pt-price" type="number" step="0.01" min="0"></div>
        <div><label>Quantité en stock</label><select id="pt-qty">${qtyOptions}</select></div>
        <div><label>Unité</label><select id="pt-unit">${unitOptions}</select></div>
        <div><label>Pour quel véhicule / modèle</label><input id="pt-fits" placeholder="ex. Sprinter 12/14m³, Citan, tous"></div>
      </div>
      <p class="help" style="margin-top:.4rem">Gérez les catégories et unités dans l'onglet « Catégories de pièces ».</p>
      <div style="margin-top:.7rem"><button class="btn accent" id="pt-add">Ajouter au stock</button></div>
    </div>
    <div class="card"><h3>Stock (${parts.length}) — valeur totale ${eur(stockValue)}</h3>
      ${parts.length ? stockByCategory(parts) : '<p class="help">Aucune pièce en stock.</p>'}
    </div>`;
  document.getElementById('pt-add').onclick = async () => {
    const payload = { name: v('#pt-name'), ref: v('#pt-ref'), category: v('#pt-cat'), unitPrice: v('#pt-price'), qty: v('#pt-qty'), unit: v('#pt-unit'), fits: v('#pt-fits') };
    if (!payload.name.trim()) { toast('Désignation obligatoire.', 'err'); return; }
    try { await api('POST', '/admin/parts', payload); toast('Ajouté au stock.', 'ok'); stockParts(body); } catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-delp]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer cette pièce ?')) return; try { await api('DELETE', '/admin/parts/' + b.dataset.delp); stockParts(body); } catch (e) { toast(e.message, 'err'); } });
  body.querySelectorAll('[data-editp]').forEach((b) => b.onclick = () => editPartModal(parts.find((p) => p.id === b.dataset.editp), body));
  function v(sel) { return document.querySelector(sel).value; }
}

// Stock affiché en tableaux par catégorie (lecture rapide). Pastille de stock bas.
function stockByCategory(parts) {
  const byCat = {};
  parts.forEach((p) => { (byCat[p.category || 'Divers'] = byCat[p.category || 'Divers'] || []).push(p); });
  const lvlPill = (q) => q <= 1 ? '<span class="pill danger">stock bas</span>' : q === 2 ? '<span class="pill warn">à surveiller</span>' : q === 3 ? '<span class="pill ok">ok</span>' : '';
  return Object.keys(byCat).sort().map((cat) => {
    const list = byCat[cat].slice().sort((a, b) => a.name.localeCompare(b.name));
    const val = list.reduce((s, p) => s + p.unitPrice * p.qty, 0);
    return `<h4 style="margin:1rem 0 .3rem">${esc(cat)} <span class="help">${list.length} réf. · ${eur(val)}</span></h4>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Désignation</th><th>Réf.</th><th>Véhicule</th><th>Prix U.</th><th>Qté</th><th>Valeur</th><th></th></tr></thead>
      <tbody>${list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.ref || '—')}</td><td>${esc(p.fits || '—')}</td><td>${eur(p.unitPrice)}</td><td>${p.qty} ${esc(p.unit)} ${lvlPill(p.qty)}</td><td>${eur(p.unitPrice * p.qty)}</td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-editp="${p.id}">✎</button> <button class="btn ghost sm" data-delp="${p.id}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  }).join('');
}

function editPartModal(p, body) {
  modal({
    title: 'Modifier la pièce',
    bodyHTML: `<div class="grid2">
      <div><label>Désignation</label><input id="ep-name" value="${esc(p.name)}"></div>
      <div><label>Référence</label><input id="ep-ref" value="${esc(p.ref || '')}"></div>
      <div><label>Catégorie</label><input id="ep-cat" value="${esc(p.category)}"></div>
      <div><label>Prix unitaire (€)</label><input id="ep-price" type="number" step="0.01" value="${p.unitPrice}"></div>
      <div><label>Quantité</label><input id="ep-qty" type="number" step="0.01" value="${p.qty}"></div>
      <div><label>Unité</label><input id="ep-unit" value="${esc(p.unit)}"></div>
      <div><label>Pour quel véhicule / modèle</label><input id="ep-fits" value="${esc(p.fits || '')}"></div>
    </div>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ep-save">Enregistrer</button>`,
    onMount: (ov) => { ov.querySelector('#ep-save').onclick = async () => {
      try { await api('PUT', '/admin/parts/' + p.id, { name: ov.querySelector('#ep-name').value, ref: ov.querySelector('#ep-ref').value, category: ov.querySelector('#ep-cat').value, unitPrice: ov.querySelector('#ep-price').value, qty: ov.querySelector('#ep-qty').value, unit: ov.querySelector('#ep-unit').value, fits: ov.querySelector('#ep-fits').value }); closeModal(); stockParts(body); toast('Modifié.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }; },
  });
}

async function stockCosts(body) {
  let rows = [];
  try { rows = (await api('GET', '/admin/vehicle-costs')).vehicles; } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  if (!rows.length) { body.innerHTML = `<div class="alert info">Aucun véhicule. Ajoutez-en dans l'onglet « Flotte ».</div>`; return; }
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  body.innerHTML = `
    <div class="alert info">Coût d'exploitation par véhicule (entretien, carburant, pièces), du plus coûteux au moins coûteux. Ajoutez des dépenses par véhicule pour affiner.</div>
    ${rows.map((r) => `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <h3 style="margin:0">🚐 ${esc(r.name)} <span class="help">${esc(r.plate || '')}</span></h3>
        <span style="display:flex;gap:.4rem;flex-wrap:wrap"><span class="pill danger">Total ${eur(r.total)}</span><span class="pill">${eur(r.monthly)}/mois</span><span class="pill">${r.perKm != null ? eur(r.perKm) + '/km' : '—/km'}</span></span>
      </div>
      <div class="cost-bar"><div class="cost-bar-fill" style="width:${Math.round((r.total / maxTotal) * 100)}%"></div></div>
      <div class="help">${r.kmDriven.toLocaleString('fr-FR')} km parcourus · ${r.months} mois · ${Object.keys(r.byCat).length ? Object.entries(r.byCat).map(([c, a]) => `${esc(c)} ${eur(a)}`).join(' · ') : 'aucune dépense'}</div>
      <div style="margin-top:.5rem"><button class="btn ghost sm" data-exp="${r.id}">+ Dépense</button> <button class="btn ghost sm" data-explist="${r.id}">Voir les dépenses (${r.expenses.length})</button></div>
    </div>`).join('')}`;
  body.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => expenseModal(b.dataset.exp, body));
  body.querySelectorAll('[data-explist]').forEach((b) => b.onclick = () => expenseListModal(rows.find((r) => r.id === b.dataset.explist), body));
}

async function expenseModal(vehicleId, body) {
  let parts = [];
  try { parts = (await api('GET', '/admin/parts')).parts; } catch (e) {}
  const v = (_veh && _veh.vehicles || []).find((x) => x.id === vehicleId) || {};
  modal({
    title: 'Ajouter une dépense',
    bodyHTML: `<p class="help">${esc(v.name || '')}</p>
      <label>Catégorie</label><select id="ex-cat"><option value="entretien">Entretien</option><option value="carburant">Carburant</option><option value="pneus">Pneus</option><option value="reparation">Réparation</option><option value="autre">Autre</option></select>
      <label>Pièce du stock (optionnel — déstocke et calcule le prix)</label>
      <select id="ex-part"><option value="">— Aucune (montant libre) —</option>${parts.map((p) => `<option value="${p.id}" data-price="${p.unitPrice}">${esc(p.name)} — ${eur(p.unitPrice)} (${p.qty} ${esc(p.unit)})</option>`).join('')}</select>
      <div class="grid2" style="margin-top:.5rem">
        <div><label>Quantité</label><input id="ex-qty" type="number" step="0.01" value="1"></div>
        <div><label>Montant (€) — si pas de pièce</label><input id="ex-amount" type="number" step="0.01"></div>
        <div><label>Date</label><input id="ex-date" type="date" value="${iso(new Date())}"></div>
        <div><label>Libellé</label><input id="ex-label" placeholder="détail"></div>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ex-save">Enregistrer</button>`,
    onMount: (ov) => { ov.querySelector('#ex-save').onclick = async () => {
      const payload = { category: ov.querySelector('#ex-cat').value, partId: ov.querySelector('#ex-part').value || null, qty: ov.querySelector('#ex-qty').value, amount: ov.querySelector('#ex-amount').value, date: ov.querySelector('#ex-date').value, label: ov.querySelector('#ex-label').value };
      try { await api('POST', '/admin/vehicles/' + vehicleId + '/expense', payload); closeModal(); stockCosts(body); toast('Dépense enregistrée.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    }; },
  });
}

function expenseListModal(row, body) {
  modal({
    title: 'Dépenses — ' + (row.name || ''),
    bodyHTML: row.expenses.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Catégorie</th><th>Libellé</th><th>Montant</th><th></th></tr></thead>
      <tbody>${row.expenses.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.label)}</td><td>${eur(e.amount)}</td><td><button class="btn ghost sm" data-delx="${e.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune dépense.</p>',
    footHTML: `<button class="btn ghost" data-close>Fermer</button>`,
    onMount: (ov) => ov.querySelectorAll('[data-delx]').forEach((b) => b.onclick = async () => {
      try { await api('DELETE', '/admin/vehicles/expense/' + b.dataset.delx); closeModal(); stockCosts(body); } catch (e) { toast(e.message, 'err'); }
    }),
  });
}

/* =========================================================================
   FINANCIÈRE (administrateur) : recettes, charges, TVA, clients, projection
   ========================================================================= */
/* =========================================================================
   ERP intégré — Gestion documentaire / facturation / justificatifs
   ========================================================================= */
// Ouvre une réponse HTML d'une route ERP (authentifiée) dans un onglet imprimable.
async function erpOpenHtml(method, path, body) {
  const opts = { method, headers: { Authorization: 'Bearer ' + State.token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  if (!res.ok) { toast('Génération impossible.', 'err'); return; }
  const html = await res.text();
  const w = window.open('', '_blank');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  else { const url = URL.createObjectURL(new Blob([html], { type: 'text/html' })); window.open(url, '_blank'); }
}

// --- Gestion documentaire (génération + PDF des courriers/contrats) ----------
let _docMgmtTab = 'gen';
// Pré-remplissage de l'onglet « Générer » depuis un dossier disciplinaire
// (faute grave → mise à pied conservatoire prête à générer).
let _docGenPrefill = null;
const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// « lundi 7 juillet 2026 » à partir d'une date ISO (yyyy-mm-dd).
function frLongDate(iso) {
  if (!iso) return '';
  const d = parseISO(iso); if (isNaN(d)) return iso;
  return `${JOURS_FR[d.getDay()]} ${d.getDate()} ${MOIS_FR[d.getMonth()]} ${d.getFullYear()}`;
}
// « 10 h 30 » à partir d'une heure HH:MM.
function frHour(hm) {
  if (!hm) return '';
  const m = String(hm).match(/^(\d{1,2}):(\d{2})$/); if (!m) return hm;
  return m[2] === '00' ? `${+m[1]} h` : `${+m[1]} h ${m[2]}`;
}
async function renderDocMgmt(main) {
  if (!isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des procédures</h1>
    <p>Générez vos procédures disciplinaires, suivez les envois et l'état du dossier disciplinaire de chaque salarié.</p></div></div>
    <div class="view-switch" id="dm-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-dtab="gen">Générer une procédure</button>
      <button data-dtab="dossiers">Dossiers disciplinaires</button>
      <button data-dtab="sent">Documents envoyés</button>
    </div>
    <div id="dm-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#dm-tabs');
  const route = () => { if (_docMgmtTab === 'sent') return docMgmtSent(main); if (_docMgmtTab === 'dossiers') return docMgmtDossiers(main); return docMgmtGen(main); };
  const setActive = () => tabs.querySelectorAll('[data-dtab]').forEach((b) => b.classList.toggle('active', b.dataset.dtab === _docMgmtTab));
  tabs.querySelectorAll('[data-dtab]').forEach((b) => b.onclick = () => { _docMgmtTab = b.dataset.dtab; setActive(); route(); });
  setActive();
  route();
}

// Onglet « Documents envoyés » : un tableau par salarié.
async function docMgmtSent(main) {
  const body = document.getElementById('dm-body'); if (!body) return; body.className = '';
  let docs;
  try { docs = (await api('GET', '/admin/erp/documents')).documents; } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  if (!docs.length) { body.innerHTML = '<div class="alert info">Aucun document envoyé pour le moment.</div>'; return; }
  // Regroupement par salarié (un tableau individuel chacun).
  const byUser = {};
  docs.forEach((d) => { (byUser[d.userName || '—'] = byUser[d.userName || '—'] || []).push(d); });
  const names = Object.keys(byUser).sort();
  const docRow = (d) => `<tr>
      <td>${esc(d.label)}</td><td>${fmtDate((d.createdAt || '').slice(0, 10))}</td>
      <td>${d.status === 'acked' ? '<span class="pill ok">lu &amp; signé</span>' : (d.viewedAt || d.status === 'read') ? '<span class="pill warn">lu, non signé</span>' : '<span class="pill danger">non ouvert</span>'}</td>
      <td>${d.viewedAt ? fmtDateTime(d.viewedAt) : '—'}</td><td>${d.ackedAt ? fmtDateTime(d.ackedAt) : '—'}</td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-docview="${d.id}">Voir</button>${d.status === 'acked' ? ` <button class="btn ok sm" data-att="${d.id}">Attestation</button>` : ''} <button class="btn danger sm" data-doccancel="${d.id}" data-lbl="${esc(d.label)}">✕</button></td>
    </tr>`;
  body.innerHTML = `<p class="help" style="margin-top:0">Documents adressés, classés par salarié. Vous pouvez annuler un envoi (✕) : le document et la signature éventuelle sont retirés.</p>` + names.map((n) => {
    const list = byUser[n].slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return `<details class="card" open><summary><strong>${esc(n)}</strong> <span class="help">${list.length} document(s)</span></summary>
      <div class="table-wrap" style="margin-top:.6rem"><table class="veh-table"><thead><tr><th>Document</th><th>Émis le</th><th>Statut</th><th>Lu le</th><th>Signé le</th><th></th></tr></thead>
      <tbody>${list.map(docRow).join('')}</tbody></table></div></details>`;
  }).join('');
  body.querySelectorAll('[data-docview]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.docview + '/view'));
  body.querySelectorAll('[data-att]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.att + '/attestation'));
  body.querySelectorAll('[data-doccancel]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Annuler et supprimer l'envoi de « ${b.dataset.lbl} » ? Cette action est irréversible.`)) return;
    try { await api('DELETE', '/admin/erp/documents/' + b.dataset.doccancel); toast('Envoi annulé.', 'ok'); docMgmtSent(main); }
    catch (e) { toast(e.message, 'err'); }
  });
}

// Onglet « Dossiers disciplinaires » : état par salarié + seuils + progression.
const DISC_LEVEL = {
  licenciement: { lbl: 'Licenciement (faute grave)', cls: 'danger', color: '#b91c1c' },
  mise_a_pied: { lbl: 'Mise à pied éligible', cls: 'warn', color: '#b45309' },
  avertissement: { lbl: 'Avertissement(s)', cls: 'draft', color: '#2563eb' },
  vierge: { lbl: 'Dossier vierge', cls: 'ok', color: '#16a34a' },
};
async function docMgmtDossiers(main) {
  const body = document.getElementById('dm-body'); if (!body) return; body.className = '';
  let d;
  try { d = await api('GET', '/admin/erp/documents/disciplinary-files'); } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const files = d.files || [], sev = d.severity || {}, gl = d.graviteLabels || {};
  const counts = { licenciement: 0, mise_a_pied: 0, avertissement: 0, vierge: 0 };
  files.forEach((f) => { counts[f.level] = (counts[f.level] || 0) + 1; });
  const sevRows = Object.entries(sev).sort((a, b) => a[1].gravite - b[1].gravite || a[1].seuil - b[1].seuil)
    .map(([m, s]) => `<tr><td>${esc(m)}</td><td style="text-align:center">${esc(gl[s.gravite] || s.gravite)}</td><td style="text-align:center">${s.seuil}</td><td style="text-align:center">${s.seuil + 1}ᵉ manquement</td></tr>`).join('');
  // Une barre de progression PAR cas d'avertissement (famille de motifs). Les
  // motifs de même nature s'additionnent vers la mise à pied.
  const progBar = (f) => {
    if (!f.motifs || !f.motifs.length) return f.level === 'vierge' ? '<span class="help">—</span>' : '';
    return f.motifs.map((m) => {
      const pct = m.seuil > 0 ? Math.min(100, Math.round(m.count / m.seuil * 100)) : 100;
      const col = m.gravite >= 4 ? '#7f1d1d' : (m.eligible ? '#b91c1c' : (m.gravite >= 3 ? '#d97706' : '#2563eb'));
      const detail = (m.members && m.members.length > 1) ? ` <span class="help">— ${m.members.map((x) => `${esc(x.motif)} ×${x.count}`).join(', ')}</span>` : '';
      return `<div class="disc-prog"><div class="disc-bar"><span style="width:${pct}%;background:${col}"></span></div><span class="help"><strong>${esc(m.motif)}</strong> — ${m.count}/${m.seuil}${m.eligible ? ' ✅ mise à pied proportionnée' : ''}${m.gravite >= 4 ? ' · très grave' : ''}</span>${detail}</div>`;
    }).join('');
  };
  body.innerHTML = `
    <div class="grid cols-4">
      ${['licenciement', 'mise_a_pied', 'avertissement', 'vierge'].map((l) => `<div class="stat ${l === 'licenciement' && counts[l] ? 'alt' : ''}"><div class="value" style="font-size:1.5rem">${counts[l] || 0}</div><div class="label">${DISC_LEVEL[l].lbl}</div></div>`).join('')}
    </div>
    ${counts.licenciement ? `<div class="alert warn">⚠️ <strong>${counts.licenciement} salarié(s)</strong> au niveau « licenciement pour faute grave » : engagez la procédure (convocation à entretien préalable).</div>` : ''}
    <div class="card"><h3 style="margin-top:0">Dossiers disciplinaires des salariés</h3>
      <p class="help">État du dossier de chaque salarié (vierge ou entamé), progression vers une mise à pied et prochaine étape proportionnée. Chaque avertissement adressé est compté automatiquement.</p>
      <div class="table-wrap"><table class="report-table"><thead><tr><th>Salarié</th><th>Groupe</th><th style="text-align:center">Avert.</th><th>Progression → mise à pied</th><th>État / prochaine étape</th><th></th></tr></thead>
      <tbody>${files.map((f) => `<tr>
        <td><strong>${esc(f.userName)}</strong></td>
        <td><span class="help">${esc(f.groupName)}</span></td>
        <td style="text-align:center">${f.warningCount}${f.miseCount ? ` <span class="help">+${f.miseCount} MAP</span>` : ''}</td>
        <td style="min-width:170px">${progBar(f)}</td>
        <td><span class="pill ${DISC_LEVEL[f.level].cls}">${DISC_LEVEL[f.level].lbl}</span><div class="help">${esc(f.nextStep)}</div></td>
        <td><button class="btn ghost sm" data-discview="${f.userId}">Détail</button></td>
      </tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card"><h3 style="margin-top:0">Barème : seuils par motif</h3>
      <p class="help">Plus un motif est grave, plus le seuil (nombre d'avertissements avant qu'une mise à pied soit proportionnée) est bas.</p>
      <div class="table-wrap"><table class="report-table"><thead><tr><th>Motif</th><th style="text-align:center">Gravité</th><th style="text-align:center">Seuil (avert.)</th><th style="text-align:center">Mise à pied dès</th></tr></thead><tbody>${sevRows}</tbody></table></div>
    </div>`;
  body.querySelectorAll('[data-discview]').forEach((b) => b.onclick = () => discFileModal(files.find((f) => f.userId === b.dataset.discview), gl));
}
function discFileModal(f, gl) {
  if (!f) return;
  gl = gl || {};
  const sanc = f.sanctions.length ? f.sanctions.slice().reverse().map((s) => `<tr><td>${esc(s.date || '')}</td><td>${esc(s.type)}</td><td>${esc(s.motif || '—')}</td></tr>`).join('') : '<tr><td colspan="3"><span class="help">Aucune sanction au dossier.</span></td></tr>';
  const motifRows = f.motifs.map((m) => { const det = (m.members && m.members.length > 1) ? `<div class="help">${m.members.map((x) => `${esc(x.motif)} ×${x.count}`).join(', ')}</div>` : ''; return `<tr><td>${esc(m.motif)}${det}</td><td style="text-align:center">${esc(gl[m.gravite] || m.gravite)}</td><td style="text-align:center">${m.count}/${m.seuil}</td><td style="text-align:center">${m.eligible ? '✅ éligible' : '—'}</td></tr>`; }).join('');
  // Mise à pied prête à générer : conservatoire (faute grave) ou disciplinaire.
  const canMAP = (f.level === 'licenciement' || f.level === 'mise_a_pied') && f.dominant;
  const mapType = f.level === 'licenciement' ? 'mise_a_pied_conservatoire' : 'mise_a_pied_disciplinaire';
  const mapLbl = f.level === 'licenciement' ? '⚖️ Préparer la mise à pied conservatoire' : '⚖️ Préparer la mise à pied disciplinaire';
  modal({
    title: 'Dossier disciplinaire — ' + f.userName,
    bodyHTML: `
      <div class="alert ${f.level === 'licenciement' ? 'warn' : 'info'}"><strong>${esc(f.nextStep)}</strong> — ${esc(f.reason)}</div>
      <h4 style="margin:.6rem 0 .3rem">Historique des sanctions</h4>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Type</th><th>Motif</th></tr></thead><tbody>${sanc}</tbody></table></div>
      ${f.motifs.length ? `<h4 style="margin:.7rem 0 .3rem">Progression par motif (familles cumulées)</h4><div class="table-wrap"><table class="veh-table"><thead><tr><th>Motif</th><th style="text-align:center">Gravité</th><th style="text-align:center">Avert./seuil</th><th style="text-align:center">Mise à pied</th></tr></thead><tbody>${motifRows}</tbody></table></div>` : ''}`,
    footHTML: `${canMAP ? `<button class="btn accent" id="disc-genmap">${mapLbl}</button>` : ''}<button class="btn ghost" data-close>Fermer</button>`,
    onMount: (ov) => {
      const b = ov.querySelector('#disc-genmap');
      if (b) b.onclick = () => {
        _docGenPrefill = { userId: f.userId, motif: (f.dominant && f.dominant.repMotif) || (f.dominant && f.dominant.motif) || '', type: mapType };
        _docMgmtTab = 'gen'; closeModal(); State.view = 'docmgmt'; renderApp();
      };
    },
  });
}

// Onglet « Générer un document » (publipostage + modèles).
async function docMgmtGen(main) {
  const dmBody = document.getElementById('dm-body'); if (dmBody) dmBody.className = 'empty';
  let templates, meta, docOpts;
  try { templates = (await api('GET', '/admin/erp/templates')).templates; meta = await api('GET', '/admin/erp/meta'); docOpts = await api('GET', '/admin/erp/doc-options'); }
  catch (e) { document.getElementById('dm-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const sev = docOpts.severity || {};
  // Motifs classés du plus léger au plus grave (gravité croissante ; à gravité
  // égale, le seuil le plus élevé — donc le plus tolérant — passe en premier).
  const motifs = (docOpts.motifs || []).slice().sort((a, b) => {
    const sa = sev[a] || { gravite: 2, seuil: 2 }, sb = sev[b] || { gravite: 2, seuil: 2 };
    return (sa.gravite - sb.gravite) || (sb.seuil - sa.seuil) || a.localeCompare(b);
  });
  const faitsList = docOpts.faits || [];
  // Seuls les documents disciplinaires sont proposés (avertissement + mises à pied).
  const DISC_TYPES = ['avertissement', 'mise_a_pied_disciplinaire', 'notification_mise_a_pied_disciplinaire', 'mise_a_pied_conservatoire'];
  const typeOpts = DISC_TYPES.filter((k) => templates[k]).map((k) => {
    const cond = k !== 'avertissement';
    return `<option value="${k}"${cond ? ' disabled data-cond="1"' : ''}>${esc(templates[k].label)}${cond ? ' — (verrouillé)' : ''}</option>`;
  }).join('');
  // Salariés rangés par groupe.
  const byGroup = {}; (meta.users || []).forEach((u) => { const g = u.groupName || 'Sans groupe'; (byGroup[g] = byGroup[g] || []).push(u); });
  const userOpts = Object.keys(byGroup).sort().map((g) => `<optgroup label="${esc(g)}">${byGroup[g].sort((a, b) => a.name.localeCompare(b.name)).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</optgroup>`).join('');
  const customTpls = Object.entries(templates).filter(([, v]) => v.custom);
  const body = document.getElementById('dm-body'); body.className = '';
  body.innerHTML = `<div class="card"><h3>Générer un document disciplinaire</h3>
      <div class="grid2">
        <div><label>Type de document</label><select id="dm-type">${typeOpts}</select>
          <p class="help" id="dm-type-note" style="margin:.3rem 0 0">Les mises à pied se déverrouillent selon le nombre d'avertissements déjà notifiés et la gravité du motif.</p></div>
        <div><label>Salarié concerné</label><select id="dm-user"><option value="">—</option>${userOpts}</select></div>
      </div>
      <div class="grid2">
        <div>
          <label>Motif / objet</label>
          <select id="dm-motif-sel"><option value="">— choisir un motif —</option>${motifs.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}<option value="__free__">✏️ Autre (saisie libre)…</option></select>
          <div id="dm-motif-freewrap" style="display:none;margin-top:.4rem"><input id="dm-motif-free" placeholder="Saisissez le motif"><button class="btn ghost sm" id="dm-motif-save" style="margin-top:.3rem">💾 Ajouter à la liste</button></div>
        </div>
        <div id="dm-ctx-box"><label>Dossier disciplinaire</label><div id="dm-ctx" class="help" style="padding:.5rem .6rem;background:#f8fafc;border:1px solid var(--border);border-radius:8px;min-height:38px">Sélectionnez un salarié et un motif.</div></div>
      </div>
      <div id="dm-retards-wrap" style="display:none;margin-top:.6rem">
        <label>📅 Dates de retard à intégrer au document (issues du calendrier — code RET)</label>
        <div id="dm-retards" class="dm-retard-list"></div>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem">
        <button class="btn accent" id="dm-gen">Aperçu</button>
        <button class="btn" id="dm-pdf">⬇️ Exporter en PDF</button>
        <button class="btn ok" id="dm-issue" style="display:none">✅ Valider & adresser au salarié</button>
      </div>
      <p class="help">Les faits sont rédigés automatiquement à partir du motif ; un encart vous demande de compléter les éléments variables (dates, véhicule, description). Le brouillon reste éditable avant export. Cadre : CCN Transports routiers IDCC 16.</p>
    </div>
    <div id="dm-preview"></div>`;
  const effMotif = () => { const s = body.querySelector('#dm-motif-sel'); return s.value === '__free__' ? body.querySelector('#dm-motif-free').value.trim() : s.value; };
  let _discCtx = null, _final = null;
  const selectedRetards = () => [...body.querySelectorAll('.dm-ret:checked')].map((c) => c.value);
  // Étiquette d'un véhicule de la flotte : type (12/14 m³) + immatriculation.
  const vehVolume = (m) => { const x = String(m || '').match(/(\d+)\s*m³|(\d+)\s*m3/i); return x ? `${x[1] || x[2]} m³` : ''; };
  const vehLabel = (v) => { const vol = vehVolume(v.model); const plate = v.plate || v.name || ''; return (vol ? vol + ' — ' : '') + plate; };
  // Énumération à la française : « a, b et c ».
  const frList = (arr) => (arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' et ' + arr[arr.length - 1]);
  // Construit l'éditeur adapté à un [token] détecté dans le document.
  const tokenField = (tok, i) => {
    const t = tok.toLowerCase();
    if (/v[ée]hicule|mat[ée]riel/.test(t)) {
      const cur = (_discCtx && _discCtx.vehicle) || '';
      const opts = (meta.vehicles || []).map((v) => { const lab = vehLabel(v); const sel = cur && (cur === v.name || (v.plate && cur.indexOf(v.plate) >= 0)) ? ' selected' : ''; return `<option value="${esc(lab)}"${sel}>${esc(lab)}</option>`; }).join('');
      return `<select id="tk-${i}"><option value="">— choisir un véhicule —</option>${opts}</select>`;
    }
    if (/voyant|bruit/.test(t)) {
      return `<div class="tk-checks">${VEHICLE_ISSUES.map((it) => `<label class="tk-check"><input type="checkbox" class="tk-c-${i}" value="${esc(it.label)}"> ${esc(it.label)}</label>`).join('')}</div>`;
    }
    if (/heure/.test(t)) return `<input type="time" id="tk-${i}">`;
    if (/date/.test(t)) return `<input type="date" id="tk-${i}">`;
    return `<input id="tk-${i}" placeholder="à compléter">`;
  };
  // Récupère la valeur saisie pour un [token] (mise en forme française).
  const tokenValue = (tok, i, ov) => {
    const t = tok.toLowerCase();
    if (/voyant|bruit/.test(t)) { const vals = [...ov.querySelectorAll('.tk-c-' + i + ':checked')].map((c) => c.value); return frList(vals); }
    const el = ov.querySelector('#tk-' + i); const raw = el ? (el.value || '').trim() : ''; if (!raw) return '';
    if (/heure/.test(t)) return frHour(raw);
    if (/date/.test(t)) return /jour/.test(t) ? frLongDate(raw) : fmtDate(raw);
    return raw;
  };
  // Menu contextuel : demande TOUTES les données entre [crochets] restant dans le
  // document rendu (véhicule, voyants, dates, heure, lieu…). Renvoie le HTML
  // finalisé (ou null si annulé).
  const fillDocTokens = (toks, html) => new Promise((resolve) => {
    const rows = toks.map((tk, i) => `<div class="tk-row"><label>${esc(tk)}</label>${tokenField(tk, i)}</div>`).join('');
    modal({
      title: 'Compléter le document avant envoi',
      bodyHTML: `<p class="help">Renseignez chaque information entre crochets repérée dans le document (véhicule, dates, heure, lieu de convocation…). Tout champ laissé vide restera entre crochets.</p>${rows}`,
      footHTML: `<button class="btn ghost" id="tk-cancel">Annuler</button><button class="btn accent" id="tk-ok">Insérer dans le document</button>`,
      onMount: (ov) => {
        ov.querySelector('#tk-cancel').onclick = () => { closeModal(); resolve(null); };
        ov.querySelector('#tk-ok').onclick = () => {
          let out = html;
          toks.forEach((tk, i) => { const val = tokenValue(tk, i, ov) || tk; out = out.split(tk).join(val); });
          closeModal(); resolve(out);
        };
      },
    });
  });
  // Texte des faits, [tokens] intacts (sauf retards déjà connus du calendrier).
  const buildRawFaits = () => {
    const motif = effMotif();
    let faits = motifFacts(motif);
    if (/retard/i.test(motif)) {
      const dates = selectedRetards();
      if (dates.length) { const txt = dates.map((d) => fmtDate(d)).join(', '); faits = faits.split('[dates]').join(txt).split('[date]').join(txt); }
    }
    return faits;
  };
  // Signature de l'état du formulaire (pour ne pas re-demander les crochets si
  // rien n'a changé entre l'aperçu, le PDF et l'envoi).
  const sigOf = () => JSON.stringify([typeSel.value, effMotif(), body.querySelector('#dm-user').value, selectedRetards()]);
  // Rend le document côté serveur puis ouvre le menu contextuel des crochets.
  const finalizeHtml = async () => {
    const motif = effMotif(); if (!motif) { toast('Choisissez un motif.', 'err'); return null; }
    const type = typeSel.value;
    if (_final && _final.sig === sigOf()) {
      const pv = body.querySelector('#dm-preview [contenteditable]');
      return { html: pv ? pv.innerHTML : _final.html, label: _final.label, type: _final.type };
    }
    let html, label;
    try { const r = await api('POST', '/admin/erp/documents/render', { type, vars: collectVars(buildRawFaits()) }); html = r.html; label = r.label; }
    catch (e) { toast(e.message, 'err'); return null; }
    const toks = []; const re = /\[([^\]]+)\]/g; let m; while ((m = re.exec(html))) { if (!toks.includes(m[0])) toks.push(m[0]); }
    if (toks.length) { const filled = await fillDocTokens(toks, html); if (filled == null) return null; html = filled; }
    _final = { sig: sigOf(), html, label, type };
    return { html, label, type };
  };
  const collectVars = (faits) => {
    const uid = body.querySelector('#dm-user').value; const u = (meta.users || []).find((x) => x.id === uid);
    const motif = effMotif();
    const mp = (_discCtx && _discCtx.miseAPied) || {};
    // Rappel des avertissements déjà notifiés (dates + motifs) pour les mises à pied.
    const sanc = (_discCtx && _discCtx.sanctions) || [];
    const av = sanc.filter((s) => /avertissement/i.test(s.type || ''));
    const historique = av.length
      ? `Pour mémoire, les avertissements suivants vous ont déjà été notifiés et versés à votre dossier disciplinaire : ${av.map((s) => `le ${s.date ? fmtDate(s.date) : '—'}${s.motif ? ` (${s.motif})` : ''}`).join(' ; ')}.`
      : '';
    return {
      motif, faits, historique,
      miseAPied: mp,
      retards: { count: selectedRetards().length, dates: selectedRetards() },
      salarie: u ? { fullName: u.name, lastName: (u.lastName || u.name.split(' ').slice(-1)[0] || '').toUpperCase(), civilite: 'Monsieur', address: u.address || '', birthDate: u.birthDate || '', hireDate: u.hireDate || '', poste: 'conducteur VL ≤ 3,5 T', coefficient: '110M' } : {},
      contrat: { type: 'CDI', lieu: 'Éterville (14930) et déplacements', horaires: '151,67 h/mois (35 h hebdomadaires)', motif, objet: motif, detail: faits },
    };
  };
  // Met à jour le dossier disciplinaire (compteur, éligibilité mises à pied, retards).
  const optD = body.querySelector('#dm-type option[value="mise_a_pied_disciplinaire"]');
  const optN = body.querySelector('#dm-type option[value="notification_mise_a_pied_disciplinaire"]');
  const optC = body.querySelector('#dm-type option[value="mise_a_pied_conservatoire"]');
  const typeSel = body.querySelector('#dm-type');
  const refreshContext = async () => {
    const uid = body.querySelector('#dm-user').value; const motif = effMotif();
    const ctxEl = body.querySelector('#dm-ctx'); const rw = body.querySelector('#dm-retards-wrap');
    _final = null;
    if (!uid || !motif) {
      _discCtx = null; ctxEl.textContent = 'Sélectionnez un salarié et un motif.';
      if (optD) optD.disabled = true; if (optN) optN.disabled = true; if (optC) optC.disabled = true; rw.style.display = 'none'; return;
    }
    try { _discCtx = await api('GET', '/admin/erp/documents/disciplinary-context?userId=' + encodeURIComponent(uid) + '&motif=' + encodeURIComponent(motif)); }
    catch (e) { _discCtx = null; ctxEl.textContent = 'Contexte indisponible.'; return; }
    const mp = _discCtx.miseAPied || {};
    const allowDisc = !!mp.proposed && /disciplinaire/i.test(mp.type || '') && (mp.gravite || 0) < 4;
    const allowCons = !!mp.proposed && ((mp.gravite || 0) >= 4 || /conservatoire/i.test(mp.type || ''));
    // La notification ne s'ouvre qu'après l'envoi de la convocation (mise à pied disciplinaire).
    const hasDiscMise = (_discCtx.sanctions || []).some((s) => /mise (à|a) pied disciplinaire/i.test(s.type || ''));
    if (optD) { optD.disabled = !allowDisc; optD.textContent = 'Mise à pied disciplinaire — convocation' + (allowDisc ? ` (${mp.jours} j proposé(s))` : ' — (verrouillé)'); }
    if (optN) { optN.disabled = !hasDiscMise; optN.textContent = 'Notification de la mise à pied disciplinaire' + (hasDiscMise ? '' : ' — (après envoi de la convocation)'); }
    if (optC) { optC.disabled = !allowCons; optC.textContent = 'Mise à pied conservatoire' + (allowCons ? ' — disponible' : ' — (verrouillé)'); }
    if (typeSel.options[typeSel.selectedIndex] && typeSel.options[typeSel.selectedIndex].disabled) { typeSel.value = 'avertissement'; }
    ctxEl.innerHTML = `<strong>${_discCtx.warningCount}</strong> avertissement(s) au dossier · gravité ${esc(mp.graviteLabel || '—')} · ${mp.proposed ? `mise à pied <strong>${esc(mp.type || '')}</strong>${mp.jours ? ` (${mp.jours} j)` : ''} désormais proportionnée` : `mise à pied non encore proportionnée (seuil ${mp.seuil != null ? mp.seuil : '—'})`}${_discCtx.vehicle ? ` · véhicule : ${esc(_discCtx.vehicle)}` : ''}`;
    const isRet = /retard/i.test(motif);
    rw.style.display = isRet ? '' : 'none';
    if (isRet) {
      const dl = _discCtx.retardDates || [];
      body.querySelector('#dm-retards').innerHTML = dl.length
        ? dl.map((d) => `<label class="dm-retard-chip"><input type="checkbox" class="dm-ret" value="${d}" checked> ${fmtDate(d)}</label>`).join('')
        : '<span class="help">Aucun retard validé (RET) au calendrier pour ce salarié.</span>';
    }
  };
  // Motif : bascule saisie libre + enregistrement d'un nouveau motif.
  const motifSel = body.querySelector('#dm-motif-sel');
  motifSel.onchange = () => { body.querySelector('#dm-motif-freewrap').style.display = motifSel.value === '__free__' ? 'block' : 'none'; refreshContext(); };
  body.querySelector('#dm-motif-save').onclick = async () => {
    const m = body.querySelector('#dm-motif-free').value.trim(); if (!m) { toast('Saisissez un motif.', 'err'); return; }
    try { await api('POST', '/admin/erp/doc-options/motif', { motif: m }); toast('Motif ajouté à la liste.', 'ok'); renderDocMgmt(main); }
    catch (e) { toast(e.message, 'err'); }
  };
  const syncBtns = () => { const uid = body.querySelector('#dm-user').value; body.querySelector('#dm-issue').style.display = uid ? 'inline-block' : 'none'; };
  body.querySelector('#dm-user').addEventListener('change', () => { syncBtns(); refreshContext(); });
  body.querySelector('#dm-type').addEventListener('change', syncBtns);
  syncBtns();
  body.querySelector('#dm-gen').onclick = async () => {
    const r = await finalizeHtml(); if (!r) return;
    body.querySelector('#dm-preview').innerHTML = `<div class="card"><div contenteditable="true" style="background:#fff;color:#111;padding:18px;border-radius:8px;outline:none">${r.html}</div></div>`;
  };
  body.querySelector('#dm-pdf').onclick = async () => {
    const r = await finalizeHtml(); if (!r) return;
    erpOpenHtml('POST', '/admin/erp/documents/print', { html: r.html, title: r.label });
  };
  body.querySelector('#dm-issue').onclick = async () => {
    const uid = body.querySelector('#dm-user').value; if (!uid) { toast('Sélectionnez un salarié.', 'err'); return; }
    const r = await finalizeHtml(); if (!r) return;
    if (!confirm('Adresser ce document au salarié ? Il devra en accuser réception dans l\'application.')) return;
    try { await api('POST', '/admin/erp/documents/issue', { userId: uid, type: r.type, html: r.html, label: r.label, vars: { motif: effMotif() } }); toast('Document adressé au salarié.', 'ok'); renderDocMgmt(main); }
    catch (e) { toast(e.message, 'err'); }
  };
  // Pré-remplissage depuis un dossier disciplinaire (faute grave → conservatoire).
  if (_docGenPrefill) {
    const pf = _docGenPrefill; _docGenPrefill = null;
    if (pf.userId) body.querySelector('#dm-user').value = pf.userId;
    if (pf.motif) {
      const sel = body.querySelector('#dm-motif-sel');
      if ([...sel.options].some((o) => o.value === pf.motif)) sel.value = pf.motif;
      else { sel.value = '__free__'; body.querySelector('#dm-motif-freewrap').style.display = 'block'; body.querySelector('#dm-motif-free').value = pf.motif; }
    }
    syncBtns();
    await refreshContext();
    if (pf.type) { const o = [...typeSel.options].find((x) => x.value === pf.type); if (o && !o.disabled) typeSel.value = pf.type; syncBtns(); }
    toast('Dossier chargé : complétez les crochets puis générez le document.', 'ok');
  }
}

// Phrases-type des faits selon le motif (avec [placeholders] à compléter).
const MOTIF_FACTS = {
  'Retards répétés': "Aux dates suivantes : [dates], vous vous êtes présenté(e) à votre poste avec un retard injustifié, désorganisant le service et l'exécution des tournées de livraison.",
  "Dégradation du matériel de l'entreprise": "Le [date], une négligence de votre part a entraîné [dégradation / incident] sur [matériel / véhicule], occasionnant un préjudice pour l'entreprise.",
  "Négligence dans l'exécution du travail": "Le [date], une négligence de votre part a entraîné [dégradation / incident] sur [matériel / véhicule], occasionnant un préjudice pour l'entreprise.",
  'Absence injustifiée': "Le [date], vous avez été absent(e) de votre poste sans justification ni autorisation préalable, désorganisant le service et les tournées.",
  'Abandon de poste': "Le [date], vous avez quitté votre poste sans autorisation et sans en informer la Direction, abandonnant les missions qui vous étaient confiées.",
  'Non-respect des consignes de sécurité': "Le [date], vous n'avez pas respecté les consignes de sécurité suivantes : [consignes concernées], exposant des personnes et le matériel à un risque.",
  "Insubordination / refus d'exécuter une tâche": "Le [date], vous avez refusé d'exécuter [tâche demandée] qui relevait de vos fonctions, malgré la demande explicite de votre responsable.",
  'Utilisation non autorisée du véhicule de service': "Le [date], vous avez utilisé le [matériel / véhicule] à des fins non autorisées, en dehors du cadre de vos missions.",
  'Non-respect des temps de conduite et de repos': "Le [date], il a été constaté un non-respect des temps de conduite et de repos réglementaires sur [véhicule], en infraction avec la réglementation sociale européenne.",
  "Véhicule non propre à l'intérieur": "Le [date], lors d'un contrôle du véhicule [matériel / véhicule] qui vous est confié, il a été constaté un défaut manifeste de propreté de l'habitacle (saleté, détritus, absence d'entretien intérieur). L'entretien courant de propreté du véhicule relève de vos obligations ; cet état nuit aux conditions d'hygiène de travail et à l'image de l'entreprise auprès de la clientèle.",
  "Véhicule non propre à l'extérieur": "Le [date], il a été constaté que le véhicule [matériel / véhicule] qui vous est confié présentait un défaut manifeste de propreté extérieure (carrosserie sale, non lavée). La propreté extérieure du véhicule, qui porte l'image de l'entreprise auprès des clients et du public, relève de vos obligations d'entretien courant.",
  "Véhicule non propre à l'intérieur et à l'extérieur": "Le [date], lors d'un contrôle du véhicule [matériel / véhicule] qui vous est confié, il a été constaté un défaut manifeste de propreté, tant à l'intérieur de l'habitacle (saleté, détritus) qu'à l'extérieur (carrosserie sale, non lavée). L'entretien courant de propreté du véhicule relève de vos obligations ; cet état nuit aux conditions d'hygiène de travail et à l'image de l'entreprise auprès de la clientèle.",
  'Non-entretien mécanique du véhicule malgré voyants / bruits (mise en danger)': "Le [date], malgré la présence de [voyant(s) / bruit(s) anormal(aux)] signalant une anomalie mécanique sur le véhicule [matériel / véhicule], vous avez poursuivi son utilisation sans en informer l'entreprise ni faire procéder à la vérification nécessaire. Ce manquement à votre obligation de signalement et d'entretien préventif a exposé le véhicule à un risque de casse et votre sécurité — ainsi que celle des autres usagers de la route — à un danger.",
};
function motifFacts(motif) {
  return MOTIF_FACTS[motif] || "Le [date], il a été constaté les faits suivants : [description des faits], constitutifs d'un manquement à vos obligations contractuelles.";
}

// Création / édition / import d'un modèle de lettre.
function templateEditModal(main, key, tpl) {
  const isEdit = !!key;
  modal({
    title: isEdit ? 'Éditer le modèle' : 'Nouveau modèle de lettre',
    bodyHTML: `
      <label>Titre du modèle</label><input id="nt-label" value="${esc(tpl ? tpl.label : '')}" placeholder="ex. Mise à pied conservatoire">
      <label>Catégorie</label><input id="nt-cat" value="${esc(tpl ? (tpl.category || '') : 'Personnalisés')}" placeholder="ex. Disciplinaire">
      ${isEdit ? '' : '<label>Importer un fichier (.txt / .html)</label><input id="nt-file" type="file" accept=".txt,.html,.htm,text/plain,text/html">'}
      <label>Contenu (HTML ou texte ; insérez les {{variables}})</label>
      <textarea id="nt-body" style="min-height:200px;font-family:monospace;font-size:.78rem" placeholder="{{company.legal}}&#10;&#10;Objet : …&#10;&#10;{{salarie.civilite}} {{salarie.lastName}},&#10;&#10;{{faits}}&#10;&#10;La Direction">${esc(tpl ? tpl.body : '')}</textarea>
      <p class="help">Pour renforcer la valeur du document, citez le fondement (contrat de travail, règlement intérieur, CCN Transports routiers IDCC 16) et conservez un ton factuel et daté.</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="nt-save">${isEdit ? 'Enregistrer' : 'Créer le modèle'}</button>`,
    onMount: (ov) => {
      const fileInp = ov.querySelector('#nt-file');
      if (fileInp) fileInp.onchange = async (e) => { const f = e.target.files[0]; if (!f) return; ov.querySelector('#nt-body').value = await f.text(); if (!ov.querySelector('#nt-label').value) ov.querySelector('#nt-label').value = f.name.replace(/\.[^.]+$/, ''); };
      ov.querySelector('#nt-save').onclick = async () => {
        const label = ov.querySelector('#nt-label').value.trim(), category = ov.querySelector('#nt-cat').value.trim(), bodyTxt = ov.querySelector('#nt-body').value;
        if (!label || !bodyTxt.trim()) { toast('Titre et contenu requis.', 'err'); return; }
        try {
          if (isEdit) await api('PUT', '/admin/erp/templates/' + key, { label, category, body: bodyTxt });
          else await api('POST', '/admin/erp/templates', { label, category, body: bodyTxt });
          closeModal(); toast(isEdit ? 'Modèle mis à jour.' : 'Modèle créé.', 'ok'); renderDocMgmt(main);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// --- OCR (lecture de préfacturation scannée) ---------------------------------
// Charge un script externe une seule fois (Tesseract / pdf.js, depuis jsDelivr).
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Échec de chargement : ' + src));
    document.head.appendChild(s);
  });
}
// Binarisation Otsu : niveaux de gris + seuil automatique. Nettoie les scans
// pâles/contrastés et améliore nettement la reconnaissance (sans effet néfaste
// sur les images déjà en noir et blanc, type JBIG2).
function binarizeCanvas(cv) {
  try {
    const ctx = cv.getContext('2d'); const im = ctx.getImageData(0, 0, cv.width, cv.height); const d = im.data;
    const hist = new Array(256).fill(0); const n = cv.width * cv.height;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = g; hist[g]++; }
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, max = -1, thr = 127;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const between = wB * wF * (mB - mF) * (mB - mF); if (between > max) { max = between; thr = t; } }
    for (let i = 0; i < d.length; i += 4) { const v = d[i] > thr ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(im, 0, 0);
  } catch (e) { /* canvas trop grand / cross-origin : on garde l'image telle quelle */ }
}
// OCR d'un fichier (PDF scanné ou image) -> texte brut. status = élément de suivi.
async function ocrFileToText(file, status) {
  const setS = (t) => { if (status) status.textContent = t; };
  setS('Chargement du moteur OCR…');
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  const canvases = [];
  if (/pdf$/i.test(file.name) || file.type === 'application/pdf') {
    setS('Lecture du PDF…');
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      // Rendu haute résolution (~2200 px sur le grand côté) : crucial pour l'OCR.
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.max(2, 2200 / Math.max(base.width, base.height)));
      const vp = page.getViewport({ scale });
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      canvases.push(cv);
    }
  } else {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; cv.getContext('2d').drawImage(img, 0, 0); canvases.push(cv);
  }
  setS('Préparation des images…');
  canvases.forEach(binarizeCanvas);
  // Worker Tesseract paramétré (bloc de texte uniforme + espaces préservés).
  const worker = await window.Tesseract.createWorker('fra', 1, { logger: (m) => { if (m.status === 'recognizing text') setS(`Reconnaissance — ${Math.round((m.progress || 0) * 100)} %`); } });
  let out = '';
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    for (let i = 0; i < canvases.length; i++) {
      setS(`Reconnaissance du texte (page ${i + 1}/${canvases.length})…`);
      const { data } = await worker.recognize(canvases[i]);
      out += (data.text || '') + '\n';
    }
  } finally { await worker.terminate(); }
  setS('OCR terminé.');
  return out;
}
// Extrait des lignes de prestation depuis un texte OCR (heuristique multi-format).
// Gère les tableaux transporteurs « Désignation | Nbre | Prix Unitaire | Total HT »
// (GLS, Ciblex…) ET les montants entiers (ex. 464, 80) ou décimaux (1003,65).
function ocrTextToLines(text) {
  const lines = [];
  // Un nombre OCR isolé -> flottant (virgule OU point décimal ; les milliers
  // sont rarement séparés par l'OCR, on traite donc l'espace comme séparateur).
  const toNum = (s) => parseFloat(String(s).replace(',', '.'));
  // Métadonnées / en-têtes / totaux : ce ne sont pas des lignes de prestation.
  const SKIP = /\b(total|sous[- ]?total|t\.?v\.?a|net\s*(?:à|a)\s*payer|montant|prix\s*unitaire|nbre\s*de\s*jours|sous[- ]?traitant|d[ée]signation|num[ée]ro|agence|indice\s*de\s*base|^mois)\b/i;
  const NUM = /-?\d+(?:[.,]\d+)?/g;
  // Retire les colonnes numériques de fin de ligne pour isoler le libellé.
  const TAIL = /[\s|.:;/()-]*(?:-?\d+(?:[.,]\d+)?[\s|.:;/()-]*)+$/;
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const t = raw.replace(/[|_]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (t.length < 4 || !/[A-Za-zÀ-ÿ]/.test(t)) return;
    const nums = (t.match(NUM) || []).map(toNum).filter((n) => Number.isFinite(n));
    if (!nums.length) return;
    const total = nums[nums.length - 1];
    if (!total || Math.abs(total) < 0.01) return;
    let des = t.replace(TAIL, '').trim();
    if (!des) des = t.replace(NUM, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!des || des.length < 2 || SKIP.test(des)) return;
    let qty = 1, pu = total;
    // « … Nbre PU Total » : si Nbre×PU ≈ Total, on récupère quantité et prix unitaire.
    if (nums.length >= 3) {
      const q = nums[nums.length - 3], p = nums[nums.length - 2];
      if (q > 0 && p > 0 && Math.abs(q * p - total) <= Math.max(1, Math.abs(total) * 0.02)) { qty = q; pu = p; }
    }
    lines.push({ designation: des.slice(0, 120), quantite: qty, prixUnitaire: pu });
  });
  return lines;
}

// Libellés de lignes connus par transporteur (valeurs par défaut, complétées par
// les lignes enregistrées dans le profil de facturation). Sert à « nettoyer »
// automatiquement un libellé écorché par l'OCR.
const CARRIER_LABELS = {
  gls: ['Nombre de colis Points livrés, enlevés, collectés', 'Nombre de colis Mois livrés, enlevés, collectés', 'Convention Image', 'Bonus 1%', 'Surcharge Gazole Enlèvement', 'Surcharge Gazole Livraison'],
  ciblex: ['Forfait nuit 14100/101/102', 'Forfait nuit 14103/14104', 'Forfait jour 14100/101/102', 'Forfait jour 14103', 'Forfait jour 14104', 'Forfait lundi', 'Prix au point jour 14100/101/102', 'Prix au point jour 14103', 'Prix au point jour 14104', 'Livraisons spare', 'Livraisons synchro', 'Enlèvements', 'Points Relais Colis', 'SASIC', 'Picking 1', 'Picking 2', 'Picking 3', 'Montant VTPC'],
  fedex: ['Livraison N° T560', 'Livraison N° T561', 'Livraison N° T562', 'Livraison N° T563', 'Livraison N° T564', 'Livraison N° T565', 'Livraison N° T566', 'Ramassage R260 HEROUVILLE', 'Ramassage R262 Bayeux', 'Ramassage R263 Isigny Ste Mère', 'Ajustement / indexation carburant'],
};
// Normalisation pour comparaison floue (minuscules, sans accents ni ponctuation).
function _norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function _lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) { cur[0] = i; for (let j = 1; j <= n; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c); } [prev, cur] = [cur, prev]; }
  return prev[n];
}
// Similarité 0..1 : max entre ratio de Levenshtein et Jaccard de mots.
function _sim(a, b) {
  const na = _norm(a), nb = _norm(b); if (!na || !nb) return 0;
  const full = 1 - _lev(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(na.split(' ')), tb = new Set(nb.split(' '));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const jac = inter / new Set([...ta, ...tb]).size;
  return Math.max(full, jac);
}
// Remplace un libellé OCR par le libellé connu le plus proche (si assez proche).
function snapDesignation(raw, knownLabels) {
  let best = null, score = 0;
  for (const k of knownLabels) { const s = _sim(raw, k); if (s > score) { score = s; best = k; } }
  return score >= 0.5 && best ? best : raw;
}

// --- Gestion de la facturation (factures conformes + PDF) --------------------
// Déduit, d'après le libellé d'une ligne, ce que représente la « quantité » à
// saisir (points livrés, colis, enlèvements, jours, véhicules…) et donc ce que
// signifie le prix unitaire. Guide la saisie pour éviter les confusions.
function billQtyKind(designation) {
  const s = String(designation || '').toLowerCase();
  if (/(enl[èe]vement|ramassage|collecte|pickup)/.test(s)) return { unit: 'enlèvements', qLabel: 'Nb d\'enlèvements', puLabel: 'Prix / enlèvement (€ HT)', tone: 'pts' };
  if (/(point|livraison|livr[ée]|delivery|distribu)/.test(s)) return { unit: 'points', qLabel: 'Nb de points', puLabel: 'Prix / point (€ HT)', tone: 'pts' };
  if (/(colis|paquet|parcel)/.test(s)) return { unit: 'colis', qLabel: 'Nb de colis', puLabel: 'Prix / colis (€ HT)', tone: 'pts' };
  if (/(forfait|journ[ée]e|\bjour\b|\bjours\b|vacation|tourn[ée]e)/.test(s)) return { unit: 'jours', qLabel: 'Nb de jours', puLabel: 'Prix / jour (€ HT)', tone: 'days' };
  if (/(v[ée]hicule|camion|tracteur)/.test(s)) return { unit: 'véhicules', qLabel: 'Nb de véhicules', puLabel: 'Prix / véhicule (€ HT)', tone: 'days' };
  if (/(\bkm\b|kilom[èe]tr)/.test(s)) return { unit: 'km', qLabel: 'Nb de km', puLabel: 'Prix / km (€ HT)', tone: 'days' };
  if (/(prime|bonus|p[ée]nalit|indexation|gazole|carburant|forfaitaire|frais|montant|index)/.test(s)) return { unit: 'forfait €', qLabel: 'Mettre 1', puLabel: 'Montant (€ HT)', tone: 'amt' };
  return { unit: 'unités', qLabel: 'Quantité', puLabel: 'Prix unitaire (€ HT)', tone: 'pts' };
}
let _billTab = 'generic';
async function renderBilling(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Gestion de la facturation</h1>
    <p>Émettez des factures conformes (mentions légales) et exportez-les en PDF. Les coordonnées de l'entreprise se règlent dans Administration → Informations de l'entreprise.</p></div></div>
    <div class="view-switch" id="bl-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-btab="generic">Facture libre</button>
      <button data-btab="fedex">FedEx</button>
      <button data-btab="gls">GLS</button>
      <button data-btab="ciblex">Ciblex</button>
    </div>
    <div id="bl-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#bl-tabs');
  const setActive = () => tabs.querySelectorAll('[data-btab]').forEach((b) => b.classList.toggle('active', b.dataset.btab === _billTab));
  tabs.querySelectorAll('[data-btab]').forEach((b) => b.onclick = () => { _billTab = b.dataset.btab; setActive(); billTab(main); });
  setActive();
  billTab(main);
}

async function billTab(main) {
  const body = document.getElementById('bl-body'); if (!body) return; body.className = '';
  let inv, profiles, co;
  try { inv = await api('GET', '/admin/erp/invoices'); const bp = await api('GET', '/admin/erp/billing-profiles'); profiles = bp.profiles; co = bp.company; }
  catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const isClient = _billTab !== 'generic';
  const prof = isClient ? (profiles[_billTab] || { name: _billTab, clientAddress: '', mentions: [], lignes: [] }) : null;
  const vat = co.tvaFranchise ? 0 : (co.vatRate || 20);
  let formHtml;
  if (!isClient) {
    formHtml = `<div class="card"><h3>Nouvelle facture (libre)</h3>
      <div class="grid2">
        <div><label>Client</label><input id="iv-client" list="iv-contracts" placeholder="ex. Client"><datalist id="iv-contracts">${(inv.contracts || []).map((c) => `<option value="${esc(c.client || c.name || '')}">`).join('')}</datalist></div>
        <div><label>Adresse client</label><input id="iv-addr" placeholder="adresse"></div>
        <div><label>Période / prestation</label><input id="iv-period" placeholder="${iso(new Date()).slice(0, 7)}"></div>
        <div><label>TVA (%)</label><input id="iv-vat" type="number" value="${vat}" style="width:90px"></div>
      </div>
      <div id="iv-lines" style="margin-top:.5rem"></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem"><button class="btn ghost sm" id="iv-add">+ Ligne</button><button class="btn accent" id="iv-create">Créer la facture</button><label class="veh-check" style="margin:0"><input type="checkbox" id="iv-avoir"> Avoir (négatif)</label></div>
    </div>`;
  } else {
    formHtml = `<div class="card"><h3>Facturation ${esc(prof.name)}</h3>
      <p class="help">Profil du donneur d'ordre : adresse, mentions et lignes de prestation (avec prix unitaire). Saisissez les quantités du mois (ou collez la préfacturation) puis générez la facture conforme.</p>
      <div class="grid2">
        <div><label>Adresse ${esc(prof.name)}</label><textarea id="pf-addr" style="min-height:58px;font-size:.9rem" placeholder="adresse du donneur d'ordre (une ligne par retour)">${esc(prof.clientAddress || '')}</textarea></div>
        <div><label>Période / prestation</label><input id="iv-period" placeholder="${iso(new Date()).slice(0, 7)}"></div>
      </div>
      <label style="margin-top:.4rem">Mentions spécifiques (une par ligne)</label>
      <textarea id="pf-mentions" style="min-height:60px;font-size:.85rem">${esc((prof.mentions || []).join('\n'))}</textarea>
      <h4 style="margin:.7rem 0 .3rem">Lignes de prestation</h4>
      <div id="iv-lines"></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem"><button class="btn ghost sm" id="iv-add">+ Ligne</button><button class="btn ghost sm" id="pf-save">💾 Enregistrer le profil</button><button class="btn ghost sm" id="pf-reset" title="Recharger le catalogue de lignes, tarifs et mentions du modèle de référence">♻️ Réinitialiser sur le modèle</button><button class="btn accent" id="iv-create">Générer la facture ${esc(prof.name)}</button></div>
      <details open style="margin-top:.7rem"><summary class="help">Importer une préfacturation (PDF scanné / image via OCR, ou collage texte)</summary>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:.5rem 0">
          <input id="pf-file" type="file" accept=".pdf,image/*">
          <button class="btn sm" id="pf-ocr">🔍 Lire le PDF/image (OCR)</button>
          <span id="pf-ocrstatus" class="help"></span>
        </div>
        <label class="help">Texte reconnu / à coller (format des lignes : <strong>désignation;quantité;prix unitaire</strong>) :</label>
        <textarea id="pf-paste" style="min-height:120px;font-family:monospace;font-size:.78rem" placeholder="L'OCR remplit cette zone. Ex. : Livraison points;1850;0,82"></textarea>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.4rem">
          <button class="btn ghost sm" id="pf-autoextract">Extraire les lignes automatiquement</button>
          <button class="btn ghost sm" id="pf-import">Charger (désignation;qté;PU)</button>
        </div>
        <p class="help">L'OCR lit le scan <strong>localement</strong> (aucune donnée envoyée à un tiers). La reconnaissance peut être imparfaite : vérifiez les lignes avant de générer. Envoyez-moi un exemple de texte reconnu pour que j'affine le mapping FedEx exact.</p>
      </details>
    </div>`;
  }
  body.innerHTML = formHtml + `<div class="card"><h3>Factures émises</h3><div id="iv-list"></div></div>`;
  const val = (s) => { const el = body.querySelector(s); return el ? el.value : ''; };
  const linesBox = body.querySelector('#iv-lines');
  // Légende des colonnes : rappelle ce que représente chaque champ à saisir.
  const legend = document.createElement('div');
  legend.className = 'bill-legend help';
  legend.innerHTML = `<span style="flex:2">📝 <strong>Désignation</strong> de la prestation</span><span style="width:130px">🔢 <strong>Quantité</strong> (s'adapte au libellé)</span><span style="width:130px">💶 <strong>Prix unitaire</strong> HT</span><span style="width:34px"></span>`;
  linesBox.parentElement.insertBefore(legend, linesBox);
  let updateTotal = () => {};
  const refreshKind = (row) => {
    const k = billQtyKind(row.querySelector('.il-d').value);
    const chip = row.querySelector('.il-kind');
    chip.textContent = k.unit; chip.className = 'il-kind kind-' + k.tone;
    const q = row.querySelector('.il-q'), pu = row.querySelector('.il-pu');
    q.title = k.qLabel; q.placeholder = k.qLabel;
    pu.title = k.puLabel; pu.placeholder = k.puLabel;
  };
  const addLine = (d = '', q = 1, pu = '') => { const row = document.createElement('div'); row.className = 'impact-row'; row.innerHTML = `<input class="il-d" placeholder="Désignation" value="${esc(d)}" style="flex:2"><span class="il-kind" title="Type de donnée attendu pour la quantité"></span><input class="il-q" type="number" step="0.01" value="${q}" style="width:90px"><input class="il-pu" type="number" step="0.001" value="${pu}" style="width:120px"><button class="btn ghost sm il-del">✕</button>`; row.querySelector('.il-del').onclick = () => { row.remove(); updateTotal(); }; row.querySelector('.il-d').addEventListener('input', () => refreshKind(row)); linesBox.appendChild(row); refreshKind(row); updateTotal(); };
  if (isClient) { (prof.lignes && prof.lignes.length ? prof.lignes : [{ designation: 'Prestation de livraison', prixUnitaire: 0 }]).forEach((l) => addLine(l.designation, 0, l.prixUnitaire || 0)); }
  else { addLine('Prestation de livraison', 21, 560); }
  body.querySelector('#iv-add').onclick = () => addLine();
  const collectLines = () => [...linesBox.querySelectorAll('.impact-row')].map((r) => ({ designation: r.querySelector('.il-d').value, quantite: +r.querySelector('.il-q').value, prixUnitaire: +r.querySelector('.il-pu').value })).filter((l) => l.designation);
  // Total vivant des lignes (pour vérifier la conformité « à l'identique » avec
  // le « TOTAL HT » de la préfacturation avant de générer).
  const totalEl = document.createElement('div'); totalEl.className = 'alert info'; totalEl.id = 'iv-total'; totalEl.style.marginTop = '.6rem';
  linesBox.parentElement.insertBefore(totalEl, linesBox.nextSibling);
  updateTotal = () => {
    const ht = collectLines().reduce((s, l) => s + (l.quantite || 0) * (l.prixUnitaire || 0), 0);
    const v = isClient ? vat : (+val('#iv-vat') || 0);
    totalEl.innerHTML = `Total des lignes — <strong>HT ${eur(ht)}</strong> · TVA ${v} % · <strong>TTC ${eur(ht * (1 + v / 100))}</strong>. <span class="help">Vérifiez que le HT correspond au « TOTAL HT » de la préfacturation.</span>`;
  };
  body.addEventListener('input', updateTotal);
  updateTotal();
  if (isClient) {
    const num = (s) => parseFloat(String(s).replace(/\s/g, '').replace(',', '.')) || 0;
    const fillLines = (arr) => { linesBox.innerHTML = ''; arr.forEach((l) => addLine(l.designation, l.quantite != null ? l.quantite : 1, l.prixUnitaire || 0)); if (!arr.length) addLine(); };
    // Libellés connus = ceux enregistrés dans le profil + valeurs par défaut du
    // transporteur. On nettoie les libellés OCR en les rapprochant de ceux-ci.
    const knownLabels = [...new Set([...(prof.lignes || []).map((l) => l.designation).filter(Boolean), ...(CARRIER_LABELS[_billTab] || [])])];
    const snapLines = (arr) => arr.map((l) => ({ ...l, designation: snapDesignation(l.designation, knownLabels) }));
    body.querySelector('#pf-import').onclick = () => {
      const rows = body.querySelector('#pf-paste').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const c = l.split(';'); return { designation: (c[0] || '').trim(), quantite: num(c[1]), prixUnitaire: num(c[2]) }; }).filter((l) => l.designation);
      fillLines(rows); toast(`${rows.length} ligne(s) chargée(s).`, 'ok');
    };
    body.querySelector('#pf-autoextract').onclick = () => { const arr = snapLines(ocrTextToLines(body.querySelector('#pf-paste').value)); if (!arr.length) { toast('Aucune ligne montant détectée — corrigez le texte ou saisissez manuellement.', 'warn'); return; } fillLines(arr); toast(`${arr.length} ligne(s) extraite(s) — à vérifier.`, 'ok'); };
    body.querySelector('#pf-ocr').onclick = async () => {
      const file = body.querySelector('#pf-file').files[0]; if (!file) { toast('Choisissez un fichier (PDF scanné ou image).', 'err'); return; }
      const status = body.querySelector('#pf-ocrstatus');
      try { const txt = await ocrFileToText(file, status); body.querySelector('#pf-paste').value = txt; const arr = snapLines(ocrTextToLines(txt)); if (arr.length) { fillLines(arr); status.textContent = `OCR terminé — ${arr.length} ligne(s) pré-remplie(s), à vérifier.`; } else { status.textContent = 'OCR terminé — vérifiez le texte puis « Extraire les lignes ».'; } }
      catch (e) { status.textContent = ''; toast('OCR indisponible : ' + e.message + '. Vous pouvez coller le texte manuellement.', 'err'); }
    };
    body.querySelector('#pf-save').onclick = async () => {
      try { await api('PUT', '/admin/erp/billing-profiles/' + _billTab, { clientAddress: val('#pf-addr'), mentions: body.querySelector('#pf-mentions').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), lignes: collectLines().map((l) => ({ designation: l.designation, prixUnitaire: l.prixUnitaire, unit: '' })) }); toast('Profil enregistré.', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    body.querySelector('#pf-reset').onclick = async () => {
      if (!confirm('Réinitialiser ce profil (coordonnées, mentions, catalogue de lignes et tarifs) sur le modèle de référence ? Vos modifications de ce profil seront remplacées.')) return;
      try { await api('POST', '/admin/erp/billing-profiles/' + _billTab + '/reset'); toast('Profil réinitialisé sur le modèle.', 'ok'); billTab(main); }
      catch (e) { toast(e.message, 'err'); }
    };
  }
  body.querySelector('#iv-create').onclick = async () => {
    const lines = collectLines();
    const client = isClient ? prof.name : val('#iv-client');
    const clientAddress = isClient ? val('#pf-addr') : val('#iv-addr');
    if (!client || !lines.length) { toast('Client et au moins une ligne requis.', 'err'); return; }
    const mentions = isClient ? body.querySelector('#pf-mentions').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : undefined;
    const payload = { client, clientAddress, period: val('#iv-period'), vatRate: isClient ? vat : +val('#iv-vat'), lines, mentions };
    const avoir = !isClient && body.querySelector('#iv-avoir') && body.querySelector('#iv-avoir').checked;
    try { await api('POST', avoir ? '/admin/erp/invoices/avoir' : '/admin/erp/invoices', payload); toast('Facture créée.', 'ok'); billTab(main); }
    catch (e) { toast(e.message, 'err'); }
  };
  const list = body.querySelector('#iv-list');
  const shown = isClient ? (inv.invoices || []).filter((i) => (i.client || '').toLowerCase().includes(_billTab) || (i.client || '') === prof.name) : (inv.invoices || []);
  list.innerHTML = shown.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>N°</th><th>Client</th><th>Date</th><th>TTC</th><th>Statut</th><th></th></tr></thead><tbody>${shown.map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(i.client)}</td><td>${esc(i.date)}</td><td>${eur(i.totalTTC)}</td><td><span class="pill ${i.status === 'paid' ? 'ok' : i.status === 'sent' ? 'warn' : ''}">${i.status}</span></td><td style="white-space:nowrap"><button class="btn ghost sm" data-pdf="${i.id}">PDF</button>${i.status !== 'paid' ? ` <button class="btn ghost sm" data-sent="${i.id}">Envoyée</button> <button class="btn ok sm" data-paid="${i.id}">Payée</button>` : ''} <button class="btn danger sm" data-del="${i.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune facture.</p>';
  list.querySelectorAll('[data-pdf]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/invoices/' + b.dataset.pdf + '/print'));
  list.querySelectorAll('[data-sent]').forEach((b) => b.onclick = async () => { await api('POST', '/admin/erp/invoices/' + b.dataset.sent + '/status', { status: 'sent' }); billTab(main); });
  list.querySelectorAll('[data-paid]').forEach((b) => b.onclick = async () => { await api('POST', '/admin/erp/invoices/' + b.dataset.paid + '/status', { status: 'paid' }); billTab(main); });
  list.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer cette facture ?')) return; await api('DELETE', '/admin/erp/invoices/' + b.dataset.del); billTab(main); });
}

// --- Gestion des justificatifs (frais / IK conformes + PDF) ------------------
async function renderJustif(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des justificatifs</h1>
    <p>Notes de frais et indemnités kilométriques (barème éditable), avec export PDF conforme.</p></div></div>
    <div id="ju-body" class="empty">Chargement…</div>`;
  let d, meta;
  try { d = await api('GET', '/admin/erp/expenses'); meta = await api('GET', '/admin/erp/meta'); }
  catch (e) { document.getElementById('ju-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const names = {}; (meta.users || []).forEach((u) => names[u.id] = u.name);
  const body = document.getElementById('ju-body'); body.className = '';
  const sc = d.ikScale || { note: '', brackets: [] };
  body.innerHTML = `
    <div class="alert info">${esc(sc.note || 'Vérifiez le barème en vigueur sur impots.gouv.fr.')} L'indemnité kilométrique est forfaitaire et calculée par arithmétique pure à partir du barème ci-dessous.</div>
    <div class="card"><h3>Nouveau justificatif</h3>
      <div class="grid2">
        <div><label>Salarié</label><select id="ju-user">${(meta.users || []).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
        <div><label>Date</label><input id="ju-date" type="date" value="${iso(new Date())}"></div>
        <div><label>Type</label><select id="ju-type"><option value="ik">Indemnité kilométrique (IK)</option><option value="frais">Frais réel</option></select></div>
        <div><label>Puissance fiscale (CV)</label><input id="ju-cv" type="number" value="5" style="width:90px"></div>
        <div><label>Distance (km, si IK)</label><input id="ju-km" type="number" placeholder="km"></div>
        <div><label>Montant € (si frais réel)</label><input id="ju-amt" type="number" placeholder="montant"></div>
      </div>
      <div class="grid2"><div style="grid-column:1/-1"><label>Objet / note</label><input id="ju-note" placeholder="déplacement, motif…"></div></div>
      <div style="margin-top:.5rem"><button class="btn accent" id="ju-add">Calculer & enregistrer</button></div>
    </div>
    <div class="card"><h3>Barème kilométrique (éditable)</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Jusqu'à CV</th><th>≤5000 km (€/km)</th><th>5001-20000 (€/km)</th><th>+ forfait (€)</th><th>&gt;20000 (€/km)</th></tr></thead>
      <tbody id="ik-rows">${(sc.brackets || []).map((b, i) => `<tr><td><input data-ik="${i}" data-k="cvMax" type="number" value="${b.cvMax}" style="width:70px"></td><td><input data-ik="${i}" data-k="a" type="number" step="0.001" value="${b.a}" style="width:90px"></td><td><input data-ik="${i}" data-k="b" type="number" step="0.001" value="${b.b}" style="width:90px"></td><td><input data-ik="${i}" data-k="c" type="number" value="${b.c}" style="width:90px"></td><td><input data-ik="${i}" data-k="d" type="number" step="0.001" value="${b.d}" style="width:90px"></td></tr>`).join('')}</tbody></table></div>
      <div style="margin-top:.5rem"><button class="btn ghost" id="ik-save">Enregistrer le barème</button></div>
    </div>
    <div class="card"><h3>Justificatifs enregistrés</h3><div id="ju-list"></div></div>`;
  body.querySelector('#ju-add').onclick = async () => {
    try { await api('POST', '/admin/erp/expenses', { userId: body.querySelector('#ju-user').value, date: body.querySelector('#ju-date').value, type: body.querySelector('#ju-type').value, cv: +body.querySelector('#ju-cv').value, km: +body.querySelector('#ju-km').value, amount: +body.querySelector('#ju-amt').value, note: body.querySelector('#ju-note').value }); toast('Justificatif enregistré.', 'ok'); renderJustif(main); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelector('#ik-save').onclick = async () => {
    const rows = {}; body.querySelectorAll('[data-ik]').forEach((inp) => { const i = inp.dataset.ik; (rows[i] = rows[i] || {})[inp.dataset.k] = +inp.value; });
    const brackets = Object.keys(rows).sort((a, b) => a - b).map((i) => rows[i]);
    try { await api('PUT', '/admin/erp/ik-scale', { brackets, note: sc.note }); toast('Barème enregistré.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const list = body.querySelector('#ju-list');
  list.innerHTML = (d.expenses || []).length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Salarié</th><th>Type</th><th>Km</th><th>Montant</th><th>Statut</th><th></th></tr></thead><tbody>${(d.expenses || []).slice().reverse().map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(names[x.userId] || '')}</td><td>${esc(x.type)}</td><td>${x.km || '—'}</td><td><strong>${eur(x.amount)}</strong></td><td><span class="pill ${x.status === 'approved' ? 'ok' : ''}">${x.status}</span></td><td style="white-space:nowrap"><button class="btn ghost sm" data-pdf="${x.id}">PDF</button>${x.status !== 'approved' ? ` <button class="btn ok sm" data-ok="${x.id}">Valider</button>` : ''} <button class="btn danger sm" data-del="${x.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucun justificatif.</p>';
  list.querySelectorAll('[data-pdf]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/expenses/' + b.dataset.pdf + '/print'));
  list.querySelectorAll('[data-ok]').forEach((b) => b.onclick = async () => { await api('POST', '/admin/erp/expenses/' + b.dataset.ok + '/status', { status: 'approved' }); renderJustif(main); });
  list.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api('DELETE', '/admin/erp/expenses/' + b.dataset.del); renderJustif(main); });
}

/* --- Gestion des Tournées : retours de tournée + analyse de rentabilité ---- */
let _toursYM = null;
async function renderTours(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des Tournées</h1>
    <p>Saisie des retours de tournée et analyse de la rentabilité par client.</p></div></div>
    <div id="tours-body"><div class="alert info">Chargement…</div></div>`;
  await loadToursView();
}
async function loadToursView() {
  const body = document.getElementById('tours-body'); if (!body) return;
  if (!_toursYM) _toursYM = iso(new Date()).slice(0, 7);
  let meta, an;
  try { meta = await api('GET', '/admin/erp/meta'); an = await api('GET', '/admin/erp/tours/analytics?ym=' + _toursYM); }
  catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const opt = (id, label) => `<option value="${id}">${esc(label)}</option>`;
  const maxMarge = Math.max(1, ...(an.byClient || []).map((x) => Math.abs(x.marge)));
  body.innerHTML = `
    <div class="card"><h3>Saisir un retour de tournée</h3>
      <div class="grid2">
        <div><label>Date</label><input id="t-date" type="date" value="${iso(new Date())}"></div>
        <div><label>Chauffeur</label><select id="t-user">${(meta.users || []).map((u) => opt(u.id, u.name)).join('')}</select></div>
        <div><label>Véhicule</label><select id="t-veh"><option value="">— véhicule —</option>${(meta.vehicles || []).map((v) => opt(v.id, v.plate || v.name)).join('')}</select></div>
        <div><label>Contrat / client</label><select id="t-ctr"><option value="">— contrat —</option>${(meta.contracts || []).map((c) => opt(c.id, c.client)).join('')}</select></div>
        <div><label>Km début</label><input id="t-km1" type="number" min="0"></div>
        <div><label>Km fin</label><input id="t-km2" type="number" min="0"></div>
        <div><label>Points prévus</label><input id="t-pp" type="number" min="0"></div>
        <div><label>Points livrés</label><input id="t-pd" type="number" min="0"></div>
        <div><label>Points en échec</label><input id="t-pf" type="number" min="0"></div>
        <div><label>Ramassages</label><input id="t-pick" type="number" min="0"></div>
        <div><label>Litres carburant (opt.)</label><input id="t-fuel" type="number" min="0" step="0.01"></div>
        <div><label>Motif d'échec (opt.)</label><input id="t-fr"></div>
        <div><label>Incident (opt.)</label><input id="t-inc"></div>
      </div>
      <div style="margin-top:.6rem"><button class="btn accent" id="t-save">Enregistrer le retour</button></div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <h3 style="margin:0">Analyse — ${esc(an.ym)}</h3>
        <label style="display:inline-flex;gap:.4rem;align-items:center;margin:0">Mois <input id="t-month" type="month" value="${_toursYM}" style="width:auto"></label>
      </div>
      <div class="grid cols-4" style="margin:.6rem 0">
        <div class="stat"><div class="value" style="font-size:1.4rem">${an.count}</div><div class="label">Tournées</div></div>
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(an.totals.recette)}</div><div class="label">Recette</div></div>
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(an.totals.coutTotal)}</div><div class="label">Coût total</div></div>
        <div class="stat ${an.totals.marge < 0 ? 'alt' : ''}"><div class="value" style="font-size:1.4rem">${eur(an.totals.marge)}</div><div class="label">Marge</div></div>
      </div>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Chauffeur</th><th>Client</th><th>Km</th><th>Pts</th><th>Recette</th><th>Coût</th><th>Marge</th><th></th></tr></thead>
      <tbody>${(an.rows || []).length ? an.rows.map((r) => `<tr${r.marge < 0 ? ' style="background:#fef2f2"' : ''}><td>${fmtDate(r.date)}</td><td>${esc(r.userName || '')}</td><td>${esc(r.client)}</td><td>${r.km}</td><td>${r.points}</td><td>${eur(r.recette)}</td><td>${eur(r.coutTotal)}</td><td><strong>${eur(r.marge)}</strong></td><td><button class="btn ghost sm" data-tdel="${r.id}">✕</button></td></tr>`).join('') : '<tr><td colspan="9"><span class="help">Aucune tournée saisie pour ce mois.</span></td></tr>'}</tbody></table></div>
      ${(an.byClient || []).length ? `<h3 style="margin-top:1rem">Marge par client</h3>${an.byClient.map((c) => `<div style="display:grid;grid-template-columns:160px 1fr auto;gap:.6rem;align-items:center;margin:.25rem 0"><span class="help">${esc(c.key)}</span><span style="background:#eef2f7;border-radius:5px;overflow:hidden"><span style="display:block;height:14px;width:${Math.round(Math.abs(c.marge) / maxMarge * 100)}%;background:${c.marge < 0 ? '#dc2626' : '#16a34a'}"></span></span><span style="${c.marge < 0 ? 'color:#dc2626;font-weight:600' : ''}">${eur(c.marge)}</span></div>`).join('')}` : ''}
      <p class="help" style="margin-top:.6rem">La marge tient compte de la recette (points livrés × tarif du contrat), du coût chauffeur, du carburant et du coût véhicule. Une ligne en rouge est déficitaire.</p>
    </div>`;
  body.querySelector('#t-month').onchange = (e) => { _toursYM = e.target.value; loadToursView(); };
  body.querySelector('#t-save').onclick = async () => {
    const g = (id) => body.querySelector(id);
    const payload = { date: g('#t-date').value, userId: g('#t-user').value, vehicleId: g('#t-veh').value, contractId: g('#t-ctr').value, kmStart: +g('#t-km1').value, kmEnd: +g('#t-km2').value, pointsPlanned: +g('#t-pp').value, pointsDelivered: +g('#t-pd').value, pointsFailed: +g('#t-pf').value, pickups: +g('#t-pick').value, fuelLiters: +g('#t-fuel').value, failReason: g('#t-fr').value, incident: g('#t-inc').value };
    if (!payload.date || !payload.userId) { toast('Renseignez au moins la date et le chauffeur.', 'err'); return; }
    try { await api('POST', '/admin/erp/tours', payload); toast('Retour de tournée enregistré.', 'ok'); loadToursView(); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-tdel]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer cette tournée ?')) return; try { await api('DELETE', '/admin/erp/tours/' + b.dataset.tdel); toast('Tournée supprimée.', 'ok'); loadToursView(); } catch (e) { toast(e.message, 'err'); } });
}

async function renderFinance(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Contrôle financier</h1>
    <p>Pilotez l'équilibre financier : recettes, charges, TVA, rentabilité par client et projections.</p></div></div>
    <div class="view-switch" id="fin-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-ftab="resume" class="active">Résumé & graphiques</button>
      <button data-ftab="import">Import bancaire</button>
      <button data-ftab="treso">Trésorerie & indicateurs</button>
      <button data-ftab="rules">Règles de catégorisation</button>
      <button data-ftab="flash">Flash comptable & TVA</button>
      <button data-ftab="clients">Rentabilité clients</button>
      <button data-ftab="projection">Projection</button>
      <button data-ftab="saisie">Saisie manuelle</button>
    </div>
    <div id="fin-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#fin-tabs');
  tabs.querySelectorAll('[data-ftab]').forEach((b) => b.onclick = () => { tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); finTab(b.dataset.ftab); });
  await loadFinance();
  finTab('resume');
}

let _fin = null;
async function loadFinance() { _fin = await api('GET', '/admin/finance'); }
function finTab(tab) {
  const body = document.getElementById('fin-body'); if (!body) return; body.className = '';
  if (tab === 'resume') return finResume(body);
  if (tab === 'import') return finImport(body);
  if (tab === 'treso') return finTreso(body);
  if (tab === 'rules') return finRules(body);
  if (tab === 'flash') return finFlash(body);
  if (tab === 'clients') return finClients(body);
  if (tab === 'projection') return finProjection(body);
  if (tab === 'saisie') return finSaisie(body);
}

/* --- Gestion Financière : import bancaire, trésorerie, indicateurs --------- */
let _finMeta = null, _importPreview = null;
async function finMeta() { if (!_finMeta) _finMeta = await api('GET', '/admin/finance-meta'); return _finMeta; }

async function finImport(body) {
  const meta = await finMeta();
  body.innerHTML = `
    <div class="card">
      <h3>Importer un relevé bancaire</h3>
      <p class="help">Collez le contenu d'un relevé (CSV exporté de votre banque, ou lignes copiées), chargez un fichier <strong>.csv / .txt</strong>, ou un <strong>PDF scanné / une photo</strong> (lecture par <strong>OCR</strong>). Le système reconnaît les colonnes Date / Libellé / Débit / Crédit (ou Montant), catégorise automatiquement et détecte les doublons.</p>
      <div class="grid2">
        <div><label>Banque</label><select id="im-bank"><option value="auto">Détection automatique</option>${meta.banks.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
        <div><label>Mois du relevé</label><input id="im-month" type="month" value="${iso(new Date()).slice(0, 7)}"></div>
        <div><label>Fichier (.csv / .txt, ou PDF scanné / photo)</label><input id="im-file" type="file" accept=".csv,.txt,text/csv,text/plain,.pdf,image/*"></div>
      </div>
      <p class="help" id="im-ocrstatus" style="margin:.3rem 0 0"></p>
      <p class="help" style="margin:.3rem 0 0">Indiquez le <strong>mois du relevé</strong> : il sert à nommer l'import et à alimenter les résumés et graphiques mensuels.</p>
      <label style="margin-top:.5rem">Ou collez le relevé ici</label>
      <textarea id="im-text" style="min-height:140px;font-family:monospace;font-size:.82rem" placeholder="Date;Libellé;Débit;Crédit&#10;02/03/2026;VIR SEPA FEDEX;;40193,99&#10;05/03/2026;PRVL AXA ASSURANCES;394,38;"></textarea>
      <div style="margin-top:.6rem"><button class="btn accent" id="im-analyze">Analyser</button></div>
    </div>
    <div id="im-preview"></div>
    <div class="card"><h3>Relevés importés</h3><div id="im-docs"></div></div>
    <div class="alert info">📷 Vous pouvez charger un <strong>CSV/TXT</strong> (le plus fiable), ou un <strong>PDF scanné / une photo</strong> du relevé : l'<strong>OCR lit le document localement</strong> dans votre navigateur (aucune donnée envoyée à un tiers) et remplit la zone ci-dessus. La reconnaissance pouvant être imparfaite, vérifiez les lignes avant d'analyser.</div>`;
  document.getElementById('im-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const status = document.getElementById('im-ocrstatus');
    const isScan = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' || /^image\//.test(f.type);
    if (isScan) {
      // PDF scanné / photo : OCR local (Tesseract + pdf.js) -> texte dans la zone.
      try { const txt = await ocrFileToText(f, status); document.getElementById('im-text').value = txt; status.textContent = 'OCR terminé — vérifiez les lignes (Date / Libellé / Montant) puis « Analyser ».'; }
      catch (err) { status.textContent = ''; toast('OCR indisponible : ' + err.message + '. Fournissez plutôt un CSV.', 'err'); }
      return;
    }
    status.textContent = '';
    // CSV/TXT : les relevés bancaires FR sont souvent en Windows-1252 : on bascule
    // si l'UTF-8 produit des caractères de remplacement (�).
    try {
      const buf = await f.arrayBuffer();
      let txt = new TextDecoder('utf-8').decode(buf);
      if (txt.includes('�')) { try { txt = new TextDecoder('windows-1252').decode(buf); } catch (err) {} }
      document.getElementById('im-text').value = txt;
    } catch (err) { const r = new FileReader(); r.onload = () => { document.getElementById('im-text').value = r.result; }; r.readAsText(f, 'windows-1252'); }
  };
  document.getElementById('im-analyze').onclick = async () => {
    const text = document.getElementById('im-text').value;
    if (!text.trim()) { toast('Collez un relevé ou chargez un fichier.', 'err'); return; }
    try {
      _importPreview = await api('POST', '/admin/bank-import', { text, bank: document.getElementById('im-bank').value });
      // Mois du relevé : par défaut le mois dominant des écritures détectées.
      const mEl = document.getElementById('im-month');
      if (mEl && _importPreview.transactions && _importPreview.transactions.length) {
        const counts = {}; _importPreview.transactions.forEach((t) => { const k = (t.opDate || '').slice(0, 7); if (k) counts[k] = (counts[k] || 0) + 1; });
        const dom = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        if (dom) mEl.value = dom;
      }
      renderImportPreview();
    }
    catch (e) { toast(e.message, 'err'); }
  };
  // Documents déjà importés (supprimables s'ils sont incorrects).
  await renderImportDocs();
}
async function renderImportDocs() {
  const el = document.getElementById('im-docs'); if (!el) return;
  try {
    const { docs } = await api('GET', '/admin/bank-tx');
    el.innerHTML = docs.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Document</th><th>Banque</th><th>Mois</th><th>Lignes</th><th>Importé le</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.bank)}</td><td>${esc(d.month || '—')}</td><td>${d.lines}</td><td>${fmtDateTime(d.importedAt)}</td><td><button class="btn danger sm" data-docdel="${d.id}" data-docname="${esc(d.name)}" title="Supprimer ce relevé et ses écritures">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucun relevé importé.</p>';
    el.querySelectorAll('[data-docdel]').forEach((b) => b.onclick = async () => {
      if (!confirm(`Supprimer le relevé « ${b.dataset.docname} » et toutes ses écritures ? Cette action est irréversible.`)) return;
      try { const r = await api('DELETE', `/admin/bank-docs/${b.dataset.docdel}`); toast(`Relevé supprimé (${r.removedTx} écriture(s) retirée(s)).`, 'ok'); await renderImportDocs(); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) {}
}

function renderImportPreview() {
  const p = _importPreview; const el = document.getElementById('im-preview');
  const meta = _finMeta;
  const catSel = (val, i) => `<select data-imrow="${i}">${['', ...meta.categories].map((c) => `<option ${c === val ? 'selected' : ''}>${esc(c || '— à vérifier —')}</option>`).join('')}</select>`;
  const importable = p.transactions.filter((t) => !t.dupe || t.force).length;
  const dupesPending = p.transactions.filter((t) => t.dupe && !t.force).length;
  const dupesKept = p.transactions.filter((t) => t.dupe && t.force).length;
  el.innerHTML = `<div class="card">
    <h3>Validation de l'import — ${p.bank}</h3>
    <div class="grid cols-4">
      <div class="stat"><div class="value" style="font-size:1.4rem">${p.detected}</div><div class="label">Lignes détectées</div></div>
      <div class="stat"><div class="value" style="font-size:1.4rem">${p.classified}</div><div class="label">Classées auto</div></div>
      <div class="stat ${p.toVerify ? 'alt' : ''}"><div class="value" style="font-size:1.4rem">${p.toVerify}</div><div class="label">À vérifier</div></div>
      <div class="stat"><div class="value" style="font-size:1.4rem">${p.duplicates}</div><div class="label">Doublons</div></div>
    </div>
    <p class="help" style="margin:.5rem 0 0">Une ligne inutile peut être <strong>supprimée</strong> (✕). Un <strong>doublon</strong> réellement présent sur le relevé peut être <strong>conservé</strong> (puis justifié) pour être importé malgré tout.</p>
    ${p.duplicates ? `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
      ${dupesPending ? `<button class="btn ghost sm" id="im-keepall">Conserver tous les doublons (${dupesPending})</button>` : ''}
      ${dupesKept ? `<button class="btn ghost sm" id="im-resetdupes">Réignorer les doublons (${dupesKept})</button>` : ''}
      <span class="help" style="align-self:center">Conservez tout puis faites le tri (✕ sur les lignes à retirer).</span>
    </div>` : ''}
    <div class="table-wrap" style="max-height:50vh;overflow:auto;margin-top:.6rem"><table class="veh-table"><thead><tr><th>Date</th><th>Libellé</th><th>Montant</th><th>Catégorie / Justification</th><th></th></tr></thead>
      <tbody>${p.transactions.map((t, i) => {
        const isDupe = t.dupe && !t.force;
        const catCell = isDupe
          ? `<span class="help">doublon ignoré</span> <button class="btn ghost sm" data-imkeep="${i}">Conserver</button>`
          : `${catSel(t.category, i)}${t.dupe && t.force ? ` <input data-imjust="${i}" placeholder="justification" value="${esc(t.subCategory || '')}" style="width:150px">` : ''}`;
        return `<tr class="${isDupe ? 'lvl-overdue' : ''}"><td>${fmtDate(t.opDate)}</td><td>${esc(t.label)}${t.dupe ? ` <span class="pill ${t.force ? 'ok' : 'danger'}">${t.force ? 'conservé' : 'doublon'}</span>` : ''}</td><td class="${t.amount >= 0 ? 'pos' : 'neg'}">${eur(t.amount)}</td><td>${catCell}</td><td><button class="btn ghost sm" data-imdel="${i}" title="Supprimer cette ligne">✕</button></td></tr>`;
      }).join('')}</tbody></table></div>
    <div style="margin-top:.7rem"><button class="btn accent" id="im-confirm">Confirmer l'import (${importable} écriture(s))</button></div>
  </div>`;
  el.querySelectorAll('[data-imrow]').forEach((s) => s.onchange = () => { const i = +s.dataset.imrow; p.transactions[i].category = s.value.startsWith('—') ? '' : s.value; });
  el.querySelectorAll('[data-imjust]').forEach((inp) => inp.onchange = () => { p.transactions[+inp.dataset.imjust].subCategory = inp.value; });
  el.querySelectorAll('[data-imkeep]').forEach((b) => b.onclick = () => { p.transactions[+b.dataset.imkeep].force = true; renderImportPreview(); });
  const keepAll = document.getElementById('im-keepall');
  if (keepAll) keepAll.onclick = () => { p.transactions.forEach((t) => { if (t.dupe) t.force = true; }); toast('Tous les doublons sont conservés — faites le tri puis confirmez.', 'ok'); renderImportPreview(); };
  const resetDupes = document.getElementById('im-resetdupes');
  if (resetDupes) resetDupes.onclick = () => { p.transactions.forEach((t) => { if (t.dupe) t.force = false; }); renderImportPreview(); };
  el.querySelectorAll('[data-imdel]').forEach((b) => b.onclick = () => { p.transactions.splice(+b.dataset.imdel, 1); renderImportPreview(); });
  document.getElementById('im-confirm').onclick = async () => {
    const mEl = document.getElementById('im-month'); const month = mEl ? mEl.value : '';
    const docName = 'Relevé ' + p.bank + (month ? ' ' + month : ' ' + iso(new Date()));
    try { const r = await api('POST', '/admin/bank-confirm', { transactions: p.transactions, bank: p.bank, month, docName }); toast(r.added + ' écritures importées.', 'ok'); _importPreview = null; finTab('treso'); }
    catch (e) { toast(e.message, 'err'); }
  };
}

async function finTreso(body) {
  let ov;
  try { ov = await api('GET', '/admin/finance-overview'); } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const meta = await finMeta();
  if (!ov.txCount) { body.innerHTML = `<div class="alert info">Aucune écriture bancaire. Importez un relevé dans l'onglet « Import bancaire ».</div>`; return; }
  const ind = ov.indicators;
  const feuT = (cond) => cond === 'ok' ? 'green' : cond === 'warn' ? 'orange' : 'red';
  const indCard = (lbl, val, lvl) => `<div class="tnd-ind"><div class="tnd-ind-top">${feu(lvl)}<span>${lbl}</span></div><div class="tnd-ind-val">${val}</div></div>`;
  body.innerHTML = `
    <div class="card"><h3>Tableau de bord financier</h3>
      <div class="tnd-grid">
        ${indCard('Solde / trésorerie', eur(ind.soldeActuel), ind.soldeActuel < 0 ? 'red' : 'green')}
        ${indCard('Résultat cumulé', eur(ind.resultat), ind.resultat >= 0 ? 'green' : 'red')}
        ${indCard('Taux de charges', ind.tauxCharges + ' %', ind.tauxCharges < 90 ? 'green' : 'orange')}
        ${indCard('Taux de marge', ind.tauxMarge + ' %', ind.tauxMarge >= 10 ? 'green' : ind.tauxMarge >= 0 ? 'orange' : 'red')}
        ${indCard('Masse salariale / CA', ind.masseSalarialePct + ' %', ind.masseSalarialePct < 50 ? 'green' : 'orange')}
        ${indCard('Carburant / CA', ind.carburantPct + ' %', ind.carburantPct < 15 ? 'green' : 'orange')}
        ${indCard('Péages / CA', ind.peagesPct + ' %', 'green')}
      </div>
    </div>
    <div class="card"><h3>Analyse automatique</h3><ul class="veh-alert-list">${ov.alerts.map((a) => `<li>${feu(a.lvl)} ${esc(a.txt)}</li>`).join('')}</ul></div>
    <div class="card"><h3>Solde de trésorerie de départ</h3>
      <div style="display:flex;gap:.5rem;align-items:end;flex-wrap:wrap"><div><label>Solde initial (€)</label><input id="tr-start" type="number" step="0.01" value="${meta.startBalance}"></div><button class="btn ghost" id="tr-start-save">Enregistrer</button></div>
    </div>
    <div class="card"><h3>Tableau de trésorerie mensuel</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Solde début</th><th>Recettes</th><th>Dépenses</th><th>Résultat</th><th>Solde fin</th></tr></thead>
      <tbody>${ov.treasury.map((t) => `<tr><td>${esc(t.ym)}</td><td>${eur(t.start)}</td><td class="pos">${eur(t.revenue)}</td><td class="neg">${eur(t.expense)}</td><td class="${t.result >= 0 ? 'pos' : 'neg'}">${eur(t.result)}</td><td><strong>${eur(t.end)}</strong></td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card"><h3>Évolution du résultat mensuel</h3>${barChart(ov.months.map((m) => ({ ym: m.ym, result: m.result })), 'result', 'ym')}</div>
    <div class="card"><h3>Répartition des dépenses</h3>
      <div class="table-wrap"><table class="veh-table"><tbody>${ov.expenseByCat.map((e) => `<tr><td>${esc(e.cat)}</td><td>${eur(e.v)}</td><td>${ov.totals.expense > 0 ? (e.v / ov.totals.expense * 100).toFixed(1) : 0} %</td></tr>`).join('')}</tbody></table></div>
      ${expenseBarsHTML(ov.expenseByCat, ov.totals.expense)}
    </div>`;
  document.getElementById('tr-start-save').onclick = async () => {
    try { await api('PUT', '/admin/treasury-start', { balance: document.getElementById('tr-start').value }); _finMeta = null; toast('Solde enregistré.', 'ok'); finTab('treso'); }
    catch (e) { toast(e.message, 'err'); }
  };
}

async function finRules(body) {
  const meta = await finMeta(); _finMeta = null; // force refresh next
  const m2 = await api('GET', '/admin/finance-meta'); _finMeta = m2;
  let rules = m2.rules.slice();
  const render = () => {
    const sensOpts = (sel) => `<option value="" ${!sel ? 'selected' : ''}>Auto (selon le montant)</option><option value="debit" ${sel === 'debit' ? 'selected' : ''}>Débit (dépense)</option><option value="credit" ${sel === 'credit' ? 'selected' : ''}>Crédit (recette)</option>`;
    body.innerHTML = `<div class="card"><h3>Règles de catégorisation automatique</h3>
      <p class="help">Si un libellé contient le mot-clé, l'écriture reçoit la catégorie. Vous pouvez <strong>créer votre propre catégorie</strong> (saisie libre) et préciser si elle s'applique au <strong>débit</strong> ou au <strong>crédit</strong> selon le type d'opération. Les corrections faites sur les écritures sont aussi mémorisées (apprentissage).</p>
      <datalist id="fin-cats">${m2.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div id="rl-list">${rules.map((r, i) => `<div class="kit-line" style="flex-wrap:wrap"><input data-rkw="${i}" value="${esc(r.kw)}" placeholder="mot-clé (ex. AXA)"><input data-rcat="${i}" list="fin-cats" value="${esc(r.cat || '')}" placeholder="catégorie (libre)" style="min-width:160px"><select data-rsens="${i}">${sensOpts(r.sens)}</select><button class="btn ghost sm" data-rdel="${i}">✕</button></div>`).join('')}</div>
      <div style="display:flex;gap:.4rem;margin-top:.5rem"><button class="btn ghost sm" id="rl-add">+ Ajouter une règle</button><button class="btn accent sm" id="rl-save">Enregistrer</button></div>
    </div>`;
    const collect = () => Array.from(body.querySelectorAll('[data-rkw]')).map((inp, i) => ({ kw: inp.value.trim(), cat: body.querySelector(`[data-rcat="${i}"]`).value.trim(), sens: body.querySelector(`[data-rsens="${i}"]`).value })).filter((r) => r.kw && r.cat);
    body.querySelector('#rl-add').onclick = () => { rules = collect().concat({ kw: '', cat: '', sens: '' }); render(); };
    body.querySelectorAll('[data-rdel]').forEach((b) => b.onclick = () => { rules = collect().filter((_, i) => i !== +b.dataset.rdel); render(); });
    body.querySelector('#rl-save').onclick = async () => { try { await api('PUT', '/admin/cat-rules', { rules: collect() }); _finMeta = null; toast('Règles enregistrées.', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  };
  render();
}

// Agrège des mois en périodes (trimestre/semestre/année).
function aggregatePeriods(months, size) {
  const out = {};
  months.forEach((m) => {
    const [y, mm] = m.ym.split('-').map(Number);
    let key;
    if (size === 3) key = `${y}-T${Math.ceil(mm / 3)}`;
    else if (size === 6) key = `${y}-S${Math.ceil(mm / 6)}`;
    else key = `${y}`;
    const o = out[key] = out[key] || { key, revenue: 0, charges: 0, result: 0 };
    o.revenue += m.revenue; o.charges += m.charges; o.result += m.result;
  });
  return Object.values(out).map((o) => ({ key: o.key, revenue: Math.round(o.revenue * 100) / 100, charges: Math.round(o.charges * 100) / 100, result: Math.round(o.result * 100) / 100 }));
}

// Mini graphique en barres (résultat par période ; vert = bénéfice, rouge = perte).
function barChart(items, valueKey, labelKey) {
  if (!items.length) return '<p class="help">Aucune donnée. Saisissez des écritures.</p>';
  const max = Math.max(1, ...items.map((i) => Math.abs(i[valueKey])));
  return `<div class="bars">${items.map((i) => {
    const val = i[valueKey]; const h = Math.round((Math.abs(val) / max) * 100);
    return `<div class="bar-col"><div class="bar-wrap"><div class="bar ${val >= 0 ? 'pos' : 'neg'}" style="height:${h}%" title="${eur(val)}"></div></div><div class="bar-lbl">${esc(i[labelKey])}</div><div class="bar-val ${val >= 0 ? 'pos' : 'neg'}">${eur(val)}</div></div>`;
  }).join('')}</div>`;
}

// Graphique en barres horizontales de la répartition des dépenses (visuel par pôle).
function expenseBarsHTML(items, total) {
  if (!items || !items.length) return '<p class="help" style="margin-top:.6rem">Aucune dépense à représenter.</p>';
  const max = Math.max(1, ...items.map((e) => e.v));
  const colors = ['#6b7cff', '#22c55e', '#f59e0b', '#ef4444', '#0ea5e9', '#a855f7', '#14b8a6', '#f97316', '#84cc16', '#ec4899', '#64748b'];
  return `<div style="display:flex;flex-direction:column;gap:.35rem;margin-top:.7rem">${items.map((e, i) => {
    const pct = total > 0 ? (e.v / total * 100) : 0;
    const w = Math.round((e.v / max) * 100);
    return `<div style="display:grid;grid-template-columns:130px 1fr auto;gap:.5rem;align-items:center"><span class="help" style="text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(e.cat)}">${esc(e.cat)}</span><span style="background:var(--border,#eee);border-radius:5px;overflow:hidden"><span style="display:block;height:15px;width:${w}%;background:${colors[i % colors.length]}"></span></span><span style="white-space:nowrap"><strong>${eur(e.v)}</strong> <span class="help">${pct.toFixed(1)} %</span></span></div>`;
  }).join('')}</div>`;
}

function finResume(body) {
  const s = _fin.summary; const m = s.months;
  const t = s.totals;
  const kpi = (lbl, val, cls) => `<div class="stat ${cls || ''}"><div class="value" style="font-size:1.4rem">${eur(val)}</div><div class="label">${lbl}</div></div>`;
  body.innerHTML = `
    <div class="grid cols-4">
      ${kpi('Recettes cumulées', t.revenue)}
      ${kpi('Charges cumulées', t.charges)}
      ${kpi('Résultat', t.result, t.result >= 0 ? '' : 'alt')}
      ${kpi('TVA due (cumul)', t.vatDue)}
    </div>
    <p class="help">Ces chiffres incluent vos <strong>écritures manuelles</strong> et les <strong>transactions bancaires importées</strong> (montants reconstitués en HT depuis le TTC, TVA estimée). Évitez de saisir manuellement une opération déjà présente dans un relevé importé pour ne pas la compter deux fois.</p>
    ${m.length ? '' : '<div class="alert info">Aucune donnée pour le moment. Importez un relevé bancaire (onglet « Import bancaire ») ou saisissez une écriture pour voir les graphiques se remplir.</div>'}
    <div class="card"><h3>Résultat mensuel</h3>${barChart(m, 'result', 'ym')}</div>
    <div class="card"><h3>Résultat par trimestre</h3>${barChart(aggregatePeriods(m, 3), 'result', 'key')}</div>
    <div class="card"><h3>Résultat par semestre</h3>${barChart(aggregatePeriods(m, 6), 'result', 'key')}</div>
    <div class="card"><h3>Résultat annuel</h3>${barChart(aggregatePeriods(m, 12), 'result', 'key')}</div>
    <div class="card"><h3>Plan de comptes (cumul) — cliquez pour déplier</h3>
      ${finChartHTML(s.tree)}
    </div>
    <div class="card"><h3>Détail mensuel</h3>
      ${m.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Recettes</th><th>Charges fixes</th><th>Charges var.</th><th>Résultat</th></tr></thead>
      <tbody>${m.map((x) => `<tr><td>${esc(x.ym)}</td><td>${eur(x.revenue)}</td><td>${eur(x.chargesFixed)}</td><td>${eur(x.chargesVar)}</td><td class="${x.result >= 0 ? 'pos' : 'neg'}">${eur(x.result)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune donnée.</p>'}
    </div>`;
  bindFinChart(body);
}

// Plan de comptes : comptes principaux dépliables avec leurs sous-comptes.
function finChartHTML(tree) {
  if (!tree || !tree.length) return '<p class="help">Aucune écriture. Renseignez vos recettes et charges dans l\'onglet « Saisie ».</p>';
  return tree.map((main, i) => {
    const isCharge = main.name.startsWith('Charges');
    return `<div class="acct">
      <div class="acct-head" data-acct="${i}"><span class="acct-caret">▸</span> <strong>${esc(main.name)}</strong>
        <span class="acct-total ${isCharge ? 'neg' : 'pos'}">${eur(main.total)}</span></div>
      <div class="acct-subs" id="acct-${i}" style="display:none">
        ${main.subs.map((s) => `<div class="acct-sub"><span>${esc(s.name)} <span class="help">(${s.count})</span></span><span>${eur(s.total)}</span></div>`).join('')}
      </div>
    </div>`;
  }).join('');
}
function bindFinChart(scope) {
  scope.querySelectorAll('[data-acct]').forEach((h) => h.onclick = () => {
    const el = scope.querySelector('#acct-' + h.dataset.acct);
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    h.querySelector('.acct-caret').textContent = open ? '▸' : '▾';
  });
}

function finFlash(body) {
  const s = _fin.summary;
  // Charges par pôle depuis le plan de comptes (inclut les imports bancaires).
  const lblMap = { 'Charges fixes': 'Fixe', 'Charges variables': 'Variable', 'Charges exceptionnelles': 'Except.' };
  const poste = {};
  (s.tree || []).forEach((m) => { if (m.name.startsWith('Charges')) m.subs.forEach((sub) => { poste[(lblMap[m.name] || m.name) + ' — ' + sub.name] = sub.total; }); });
  const caHT = s.totals.revenue;
  body.innerHTML = `
    <div class="card"><h3>Flash comptable (cumul)</h3>
      <div class="grid cols-3">
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(caHT)}</div><div class="label">Chiffre d'affaires (HT)</div></div>
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(s.totals.charges)}</div><div class="label">Charges totales</div></div>
        <div class="stat ${s.totals.result >= 0 ? '' : 'alt'}"><div class="value" style="font-size:1.4rem">${eur(s.totals.result)}</div><div class="label">Résultat</div></div>
      </div>
    </div>
    <div class="card"><h3>Charges par pôle</h3>
      ${Object.keys(poste).length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Pôle</th><th>Montant</th></tr></thead><tbody>${Object.entries(poste).sort((a, b) => b[1] - a[1]).map(([k, val]) => `<tr><td>${esc(k)}</td><td>${eur(val)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune charge saisie.</p>'}
    </div>
    <div class="card"><h3>TVA — à reverser, mois par mois</h3>
      <p class="help">TVA collectée (sur recettes) − TVA déductible (sur charges) = TVA due.</p>
      ${s.months.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>TVA collectée</th><th>TVA déductible</th><th>TVA due</th></tr></thead>
      <tbody>${s.months.map((x) => `<tr><td>${esc(x.ym)}</td><td>${eur(x.vatCollected)}</td><td>${eur(x.vatDeductible)}</td><td class="${x.vatDue >= 0 ? 'neg' : 'pos'}"><strong>${eur(x.vatDue)}</strong></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune donnée.</p>'}
    </div>`;
}

function finClients(body) {
  const c = _fin.summary.clients;
  body.innerHTML = `<div class="card"><h3>Rentabilité par client</h3>
    <p class="help">Recettes, charges affectées et marge par client (GLS, FedEx, Ciblex). Affectez le client à vos écritures lors de la saisie.</p>
    ${c.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Client</th><th>Recettes</th><th>Charges</th><th>Marge</th><th>Marge %</th></tr></thead>
      <tbody>${c.map((x) => `<tr><td><strong>${esc(x.client)}</strong></td><td>${eur(x.revenue)}</td><td>${eur(x.charges)}</td><td class="${x.margin >= 0 ? 'pos' : 'neg'}">${eur(x.margin)}</td><td>${x.marginPct}%</td></tr>`).join('')}</tbody></table></div>
      <div style="margin-top:1rem">${barChart(c.map((x) => ({ v: x.margin, l: x.client })), 'v', 'l')}</div>` : '<p class="help">Aucune écriture affectée à un client.</p>'}
  </div>`;
}

function finProjection(body) {
  const p = _fin.summary.projection; const t = _fin.summary.totals;
  body.innerHTML = `<div class="card"><h3>Projection (si le cap est maintenu)</h3>
    <div class="grid cols-3">
      <div class="stat"><div class="value" style="font-size:1.4rem">${eur(p.avgMonthlyResult)}</div><div class="label">Résultat moyen / mois</div></div>
      <div class="stat"><div class="value" style="font-size:1.4rem">${p.monthsLeftYear}</div><div class="label">Mois restants (année)</div></div>
      <div class="stat ${p.projectedYearEnd >= 0 ? '' : 'alt'}"><div class="value" style="font-size:1.4rem">${eur(p.projectedYearEnd)}</div><div class="label">Résultat projeté fin d'année</div></div>
    </div>
    <p class="help" style="margin-top:.8rem">Projection linéaire basée sur la moyenne des résultats mensuels saisis (${eur(t.result)} cumulés). Plus vous saisissez de mois, plus la projection est fiable.</p>
  </div>`;
}

function finSaisie(body) {
  const clients = _fin.clients;
  body.innerHTML = `
    <div class="card"><h3>Ajouter une écriture</h3>
      <div class="grid2">
        <div><label>Mois</label><input id="fn-ym" type="month" value="${iso(new Date()).slice(0, 7)}"></div>
        <div><label>Type</label><select id="fn-kind"><option value="recette">Recette</option><option value="charge">Charge</option></select></div>
        <div><label>Compte principal</label><select id="fn-main">${(_fin.summary.mainAccounts || []).map((a) => `<option>${esc(a)}</option>`).join('')}</select></div>
        <div><label>Sous-compte / poste</label><input id="fn-cat" placeholder="ex. Prestation, Carburant, Salaires, Loyer…"></div>
        <div><label>Client (optionnel)</label><select id="fn-client"><option value="">— Aucun —</option>${clients.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
        <div><label>Montant HT (€)</label><input id="fn-amount" type="number" step="0.01" min="0"></div>
        <div><label>Taux TVA (%)</label><select id="fn-vat"><option value="20">20</option><option value="10">10</option><option value="5.5">5,5</option><option value="0">0</option></select></div>
      </div>
      <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="fn-fixed"> Charge fixe (sinon variable)</label>
      <div style="margin-top:.6rem"><button class="btn accent" id="fn-add">Enregistrer l'écriture</button></div>
    </div>
    <div class="card"><h3>Écritures récentes</h3>
      ${_fin.entries.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Type</th><th>Poste</th><th>Client</th><th>Montant</th><th>TVA</th><th></th></tr></thead>
      <tbody>${_fin.entries.slice(0, 80).map((e) => `<tr><td>${esc(e.ym)}</td><td>${e.kind === 'recette' ? '<span class="pill ok">Recette</span>' : `<span class="pill warn">Charge${e.fixed ? ' fixe' : ''}</span>`}</td><td>${esc(e.category)}</td><td>${esc(e.client || '—')}</td><td>${eur(e.amount)}</td><td>${e.vatRate}%</td><td style="white-space:nowrap"><button class="btn ghost sm" data-editf="${e.id}">✎</button> <button class="btn ghost sm" data-delf="${e.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune écriture.</p>'}
    </div>`;
  document.getElementById('fn-add').onclick = async () => {
    const payload = { ym: document.getElementById('fn-ym').value, kind: document.getElementById('fn-kind').value, mainAccount: document.getElementById('fn-main').value, category: document.getElementById('fn-cat').value, client: document.getElementById('fn-client').value, amount: document.getElementById('fn-amount').value, vatRate: document.getElementById('fn-vat').value, fixed: document.getElementById('fn-fixed').checked };
    if (!payload.ym) { toast('Indiquez le mois.', 'err'); return; }
    try { await api('POST', '/admin/finance', payload); toast('Écriture enregistrée.', 'ok'); await loadFinance(); finTab('saisie'); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-delf]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer cette écriture ?')) return; try { await api('DELETE', '/admin/finance/' + b.dataset.delf); await loadFinance(); finTab('saisie'); } catch (e) { toast(e.message, 'err'); } });
  body.querySelectorAll('[data-editf]').forEach((b) => b.onclick = () => editFinanceModal(_fin.entries.find((e) => e.id === b.dataset.editf)));
}

function editFinanceModal(e) {
  if (!e) return;
  const mains = _fin.summary.mainAccounts || [];
  modal({
    title: 'Modifier l\'écriture',
    bodyHTML: `<div class="grid2">
      <div><label>Mois</label><input id="fe-ym" type="month" value="${esc(e.ym)}"></div>
      <div><label>Type</label><select id="fe-kind"><option value="recette" ${e.kind === 'recette' ? 'selected' : ''}>Recette</option><option value="charge" ${e.kind === 'charge' ? 'selected' : ''}>Charge</option></select></div>
      <div><label>Compte principal</label><select id="fe-main">${mains.map((a) => `<option ${a === e.mainAccount ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></div>
      <div><label>Sous-compte / poste</label><input id="fe-cat" value="${esc(e.category)}"></div>
      <div><label>Client</label><select id="fe-client"><option value="">— Aucun —</option>${_fin.clients.map((c) => `<option ${c === e.client ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div><label>Montant HT (€)</label><input id="fe-amount" type="number" step="0.01" value="${e.amount}"></div>
      <div><label>TVA (%)</label><input id="fe-vat" type="number" step="0.1" value="${e.vatRate}"></div>
    </div>
    <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="fe-fixed" ${e.fixed ? 'checked' : ''}> Charge fixe</label>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="fe-save">Enregistrer</button>`,
    onMount: (ov) => { ov.querySelector('#fe-save').onclick = async () => {
      const payload = { ym: ov.querySelector('#fe-ym').value, kind: ov.querySelector('#fe-kind').value, mainAccount: ov.querySelector('#fe-main').value, category: ov.querySelector('#fe-cat').value, client: ov.querySelector('#fe-client').value, amount: ov.querySelector('#fe-amount').value, vatRate: ov.querySelector('#fe-vat').value, fixed: ov.querySelector('#fe-fixed').checked };
      try { await api('PUT', '/admin/finance/' + e.id, payload); closeModal(); await loadFinance(); finTab('saisie'); toast('Modifié.', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    }; },
  });
}

/* =========================================================================
   ESTIMATION APPEL D'OFFRE (administrateur) : prix de livraison au point
   ========================================================================= */
let _tender = null;
async function loadTender() { _tender = (await api('GET', '/admin/tender')).params; }

// Moteur de contrôle de gestion : coûts, prix, CNR, productivité, point mort.
function tenderCompute(p) {
  const drivers = Math.max(1, p.nbDrivers || 1);
  const fuelDay = p.kmPerDay * (p.consumption / 100) * p.fuelPrice;
  const fuelMonthlyPerDriver = fuelDay * p.daysPerMonth;
  // Postes de coût mensuels (flotte entière).
  const salairesChauffeurs = p.driverCost * drivers;
  const salairesResp = (p.nbResponsables || 0) * p.responsableCost;
  const salaireSecr = (p.nbSecretaires || 0) * p.secretaireCost;
  const vehiculesM = p.vehicleCost * drivers;
  const pneusM = p.tyresPerMonth * drivers;
  const fraisGen = p.fraisGeneraux || 0;
  const carburantM = fuelMonthlyPerDriver * drivers;
  const kmTotal = p.kmPerDay * p.daysPerMonth * drivers;
  // Pôles « méthode ICS » (fichier tarif au point) — additifs, neutres si à 0.
  const panierM = (p.panierRepas || 0) * (p.joursPanier || p.daysPerMonth || 0) * drivers;        // indemnité repas (exonérée)
  const remplacementM = (p.remplacementPerDriver || 0) * drivers;                                  // provision remplacement congés
  const entretienKmM = (p.entretienPerKm || 0) * kmTotal;                                          // entretien/consommables au km
  const fixedMonthly = salairesChauffeurs + salairesResp + salaireSecr + vehiculesM + pneusM + fraisGen + panierM + remplacementM;
  const variableMonthly = carburantM + entretienKmM;
  const totalCostMonthly = fixedMonthly + variableMonthly;
  // Volumes : livraisons + enlèvements (= total points).
  const deliveryPoints = p.pointsPerDay * p.daysPerMonth * drivers;
  const rama = p.ramassage ? 1 : 0;
  const pickupPoints = rama ? (p.ramassagePerDay * p.daysPerMonth * drivers) : 0;
  const totalPoints = deliveryPoints + pickupPoints;
  const hoursMonth = (p.hoursPerDay || 8) * p.daysPerMonth * drivers;
  // Coûts unitaires.
  const coutReelPoint = totalPoints > 0 ? totalCostMonthly / totalPoints : 0;
  const coutKm = kmTotal > 0 ? totalCostMonthly / kmTotal : 0;
  const coutHoraire = hoursMonth > 0 ? totalCostMonthly / hoursMonth : 0;
  // Prix (marge en % du CA).
  const m = (p.marginPct || 0) / 100, mp = (p.marginPremiumPct || 0) / 100;
  const prixMin = coutReelPoint;
  const prixCible = m < 1 ? coutReelPoint / (1 - m) : coutReelPoint;
  const prixPremium = mp < 1 ? coutReelPoint / (1 - mp) : coutReelPoint;
  // CNR : variation gazole × part carburant.
  const variationPct = p.cnrRef > 0 ? ((p.cnrCurrent - p.cnrRef) / p.cnrRef) * 100 : 0;
  const coefAjustPct = variationPct * ((p.fuelSurchargePct || 0) / 100);
  const suppPerPoint = prixCible * (coefAjustPct / 100);
  const suppPerTour = suppPerPoint * (p.pointsPerDay + (rama ? p.ramassagePerDay : 0));
  const suppMonthly = suppPerPoint * totalPoints;
  const prixCibleCNR = prixCible + suppPerPoint;
  const prixPremiumCNR = prixPremium + prixPremium * (coefAjustPct / 100);
  // Auto-équilibrage : CA cible couvert par livraisons + enlèvements ; le
  // ramassage allège le prix de livraison sans gonfler le CA.
  const caTarget = m < 1 ? totalCostMonthly / (1 - m) : totalCostMonthly;
  const ratio = p.ramassageMode ? (p.ramassageRatio || 0.7) : null;
  let deliveryPrice, pickupPrice;
  if (rama && p.ramassageMode) {
    deliveryPrice = (deliveryPoints + pickupPoints * ratio) > 0 ? caTarget / (deliveryPoints + pickupPoints * ratio) : prixCible;
    pickupPrice = deliveryPrice * ratio;
  } else if (rama) {
    pickupPrice = p.ramassagePrice || 0;
    deliveryPrice = deliveryPoints > 0 ? (caTarget - pickupPoints * pickupPrice) / deliveryPoints : prixCible;
  } else {
    deliveryPrice = prixCible; pickupPrice = 0;
  }
  const ramaRevenue = pickupPoints * pickupPrice;
  // Tarifs « au-delà du forfait » (méthode ICS) : livraison au-delà = ½ du prix
  // de base ; collecte au-delà = prix de livraison de base.
  const auDelaPct = p.auDelaPct != null ? p.auDelaPct / 100 : 0.5;
  const prixLivraisonAuDela = deliveryPrice * auDelaPct;
  const prixCollecteAuDela = deliveryPrice;
  const caMonthly = deliveryPrice * deliveryPoints + ramaRevenue;
  const caPerDriver = caMonthly / drivers;
  const resultMonth = caMonthly - totalCostMonthly;
  const marginRealisedPct = caMonthly > 0 ? (resultMonth / caMonthly) * 100 : 0;
  // Point mort (formule simple : coût total / prix facturé du point).
  const pointMort = deliveryPrice > 0 ? totalCostMonthly / deliveryPrice : null;
  const pointMortPct = (pointMort != null && totalPoints > 0) ? (pointMort / totalPoints) * 100 : null;
  const margeSecurite = pointMort != null ? totalPoints - pointMort : null;
  // Productivité.
  const ptsPerHour = hoursMonth > 0 ? totalPoints / hoursMonth : 0;
  const ptsPerVehicle = totalPoints / drivers;
  const kmPerPoint = totalPoints > 0 ? kmTotal / totalPoints : 0;
  const coutChauffeurPerPoint = totalPoints > 0 ? salairesChauffeurs / totalPoints : 0;
  const coutChauffeurPerHour = hoursMonth > 0 ? salairesChauffeurs / hoursMonth : 0;
  const tph = p.targetPtsPerHour || 15;
  let prodLevel = 'Faible';
  if (ptsPerHour >= tph * 1.15) prodLevel = 'Excellent';
  else if (ptsPerHour >= tph) prodLevel = 'Bon';
  else if (ptsPerHour >= tph * 0.8) prodLevel = 'Moyen';
  // Recommandations automatiques.
  const reco = [];
  if (marginRealisedPct < 15) reco.push({ lvl: 'orange', txt: 'Marge inférieure à 15 % : négociation tarifaire recommandée.' });
  if (coutReelPoint > deliveryPrice) reco.push({ lvl: 'red', txt: 'Coût du point supérieur au prix : tournée déficitaire.' });
  if (kmPerPoint > (p.maxKmPerPoint || 2)) reco.push({ lvl: 'orange', txt: 'Km/point élevé : densité de tournée insuffisante.' });
  if (Math.abs(coefAjustPct) >= 2) reco.push({ lvl: 'orange', txt: 'Impact carburant significatif : prévoir une révision tarifaire liée au gazole.' });
  if (prodLevel === 'Faible' || prodLevel === 'Moyen') reco.push({ lvl: 'orange', txt: 'Productivité perfectible : optimisation de tournée recommandée.' });
  if (!reco.length) reco.push({ lvl: 'green', txt: 'Indicateurs conformes : activité rentable et productive.' });
  return {
    drivers, fuelDay, fuelMonthlyPerDriver, carburantM, salairesChauffeurs, salairesResp, salaireSecr, vehiculesM, pneusM, fraisGen,
    panierM, remplacementM, entretienKmM,
    fixedMonthly, variableMonthly, totalCostMonthly, deliveryPoints, pickupPoints, totalPoints, kmTotal, hoursMonth,
    coutReelPoint, coutKm, coutHoraire, prixMin, prixCible, prixPremium, prixCibleCNR, prixPremiumCNR,
    variationPct, coefAjustPct, suppPerPoint, suppPerTour, suppMonthly,
    prixLivraisonAuDela, prixCollecteAuDela,
    rama, ratio, deliveryPrice, pickupPrice, ramaRevenue, caMonthly, caPerDriver, resultMonth, marginRealisedPct,
    pointMort, pointMortPct, margeSecurite, ptsPerHour, ptsPerVehicle, kmPerPoint, coutChauffeurPerPoint, coutChauffeurPerHour, prodLevel, reco,
    // compat anciens champs
    pricePerPoint: deliveryPrice, pointsMonth: deliveryPoints, breakEvenPoints: pointMort, breakEvenPerDay: pointMort != null ? pointMort / (p.daysPerMonth * drivers) : null, contribPerPoint: deliveryPrice, varPerPoint: totalPoints > 0 ? variableMonthly / totalPoints : 0, driverHourly: p.hoursPerWeek > 0 ? p.driverCost / (p.hoursPerWeek * 4.333) : 0,
  };
}
const eur3 = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' €';

async function renderTender(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Estimation appel d'offre</h1>
    <p>Calculez un prix de livraison au point couvrant vos charges et votre marge.</p></div></div>
    <div class="view-switch" id="tnd-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-ttab="dashboard" class="active">Tableau de bord</button>
      <button data-ttab="calc">Estimation</button>
      <button data-ttab="prod">Productivité & point mort</button>
      <button data-ttab="nego">Négociation</button>
      <button data-ttab="params">Paramètres</button>
    </div>
    <div id="tnd-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#tnd-tabs');
  tabs.querySelectorAll('[data-ttab]').forEach((b) => b.onclick = () => { tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); tndTab(b.dataset.ttab); });
  await loadTender();
  tndTab('dashboard');
}
// Feu tricolore : vert conforme, orange vigilance, rouge critique.
function feu(level) { return `<span class="feu feu-${level}"></span>`; }
function tndTab(tab) {
  const body = document.getElementById('tnd-body'); if (!body) return; body.className = '';
  if (tab === 'dashboard') return tndResume(body);
  if (tab === 'calc') return tndCalc(body);
  if (tab === 'prod') return tndMarge(body);
  if (tab === 'nego') return tndNego(body);
  if (tab === 'params') return tndParams(body);
}

function tndResume(body) {
  const p = _tender, c = tenderCompute(p);
  const lvlMargin = c.marginRealisedPct >= 15 ? 'green' : c.marginRealisedPct >= 8 ? 'orange' : 'red';
  const lvlResult = c.resultMonth > 0 ? 'green' : c.resultMonth === 0 ? 'orange' : 'red';
  const lvlProd = c.prodLevel === 'Excellent' || c.prodLevel === 'Bon' ? 'green' : c.prodLevel === 'Moyen' ? 'orange' : 'red';
  const lvlCnr = Math.abs(c.coefAjustPct) < 2 ? 'green' : Math.abs(c.coefAjustPct) < 4 ? 'orange' : 'red';
  const card = (feuLvl, lbl, val, sub) => `<div class="tnd-ind"><div class="tnd-ind-top">${feu(feuLvl)}<span>${lbl}</span></div><div class="tnd-ind-val">${val}</div>${sub ? `<div class="help">${sub}</div>` : ''}</div>`;
  body.innerHTML = `
    <div class="card"><h3>Tableau de bord — indicateurs</h3>
      <div class="tnd-grid">
        ${card('green', 'Coût réel / point', eur3(c.coutReelPoint), eur3(c.coutKm) + '/km · ' + eur(c.coutHoraire) + '/h')}
        ${card('green', 'Prix proposé / point', eur3(c.deliveryPrice), 'cible ' + eur3(c.prixCible))}
        ${card('green', 'Prix ajusté CNR', eur3(c.prixCibleCNR), 'supplément ' + eur3(c.suppPerPoint) + '/pt')}
        ${card(lvlMargin, 'Marge réalisée', c.marginRealisedPct.toFixed(1) + ' %', 'cible ' + p.marginPct + ' %')}
        ${card('green', 'Point mort', c.pointMort != null ? Math.ceil(c.pointMort).toLocaleString('fr-FR') + ' pts' : '—', c.pointMortPct != null ? c.pointMortPct.toFixed(0) + ' % du volume' : '')}
        ${card(lvlResult, 'Résultat / mois', eur(c.resultMonth), 'CA ' + eur(c.caMonthly))}
        ${card(lvlProd, 'Productivité', c.prodLevel, c.ptsPerHour.toFixed(1) + ' pts/h')}
        ${card(lvlCnr, 'Supplément CNR / mois', eur(c.suppMonthly), 'variation gazole ' + c.variationPct.toFixed(1) + ' %')}
      </div>
      <div style="margin-top:.8rem"><button class="btn accent" id="tnd-pdf">📄 Générer la proposition tarifaire (en-tête entreprise)</button></div>
    </div>
    <div class="card"><h3>Analyse & recommandations</h3>
      <ul class="veh-alert-list">${c.reco.map((r) => `<li>${feu(r.lvl)} ${esc(r.txt)}</li>`).join('')}</ul>
    </div>
    <div class="card"><h3>Grille tarifaire (méthode au point)</h3>
      <div class="table-wrap"><table class="veh-table"><tbody>
        <tr><td>Prix au point — <strong>livraison</strong></td><td><strong>${eur3(c.deliveryPrice)}</strong></td></tr>
        ${c.rama ? `<tr><td>Prix au point — <strong>collecte</strong></td><td><strong>${eur3(c.pickupPrice)}</strong> (ratio ×${(p.ramassageRatio || 0).toLocaleString('fr-FR')})</td></tr>` : ''}
        <tr><td>Livraison au-delà du forfait (${p.auDelaPct || 50} %)</td><td>${eur3(c.prixLivraisonAuDela)}</td></tr>
        <tr><td>Collecte au-delà du forfait</td><td>${eur3(c.prixCollecteAuDela)}</td></tr>
        <tr><td>Prix ajusté indexation gazole (CNR)</td><td>${eur3(c.prixCibleCNR)}</td></tr>
      </tbody></table></div>
    </div>
    <div class="card"><h3>Décomposition des coûts mensuels (méthode ICS)</h3>
      <div class="table-wrap"><table class="veh-table"><tbody>
        <tr><td>Chauffeurs (chargés)</td><td>${eur(c.salairesChauffeurs)}</td></tr>
        ${c.remplacementM ? `<tr><td>Remplacement congés (provision)</td><td>${eur(c.remplacementM)}</td></tr>` : ''}
        ${c.panierM ? `<tr><td>Panier repas (exonéré)</td><td>${eur(c.panierM)}</td></tr>` : ''}
        ${(c.salairesResp || c.salaireSecr) ? `<tr><td>Encadrement & secrétariat</td><td>${eur(c.salairesResp + c.salaireSecr)}</td></tr>` : ''}
        <tr><td>Véhicules (LOA + assurance + structure)</td><td>${eur(c.vehiculesM + c.pneusM + c.fraisGen)}</td></tr>
        ${c.entretienKmM ? `<tr><td>Entretien & consommables (au km)</td><td>${eur(c.entretienKmM)}</td></tr>` : ''}
        <tr><td>Carburant</td><td>${eur(c.carburantM)}</td></tr>
        <tr><td><strong>Coût total / mois</strong></td><td><strong>${eur(c.totalCostMonthly)}</strong></td></tr>
        <tr><td>C.A. à facturer / mois (marge ${p.marginPct} %)</td><td><strong>${eur(c.caMonthly)}</strong></td></tr>
      </tbody></table></div>
    </div>
    <div class="card"><h3>Réponses clés</h3>
      <div class="table-wrap"><table class="veh-table"><tbody>
        <tr><td>1. Coût réel d'un point livré</td><td><strong>${eur3(c.coutReelPoint)}</strong></td></tr>
        <tr><td>2. Prix minimum rentable</td><td><strong>${eur3(c.prixMin)}</strong></td></tr>
        <tr><td>3. Prix pour la marge cible (${p.marginPct} %)</td><td><strong>${eur3(c.prixCible)}</strong> (premium ${eur3(c.prixPremium)})</td></tr>
        <tr><td>4. Impact CNR sur la rentabilité</td><td>${c.coefAjustPct.toFixed(2)} % → ${eur(c.suppMonthly)}/mois · ${eur3(c.suppPerPoint)}/pt</td></tr>
        <tr><td>5. Points à produire (seuil de rentabilité)</td><td><strong>${c.pointMort != null ? Math.ceil(c.pointMort).toLocaleString('fr-FR') + ' pts/mois' : '—'}</strong> · marge de sécurité ${c.margeSecurite != null ? Math.round(c.margeSecurite).toLocaleString('fr-FR') + ' pts' : '—'}</td></tr>
        <tr><td>6. Tarif à négocier (marge maintenue)</td><td><strong>${eur3(c.prixCibleCNR)}</strong> (cible + CNR)</td></tr>
      </tbody></table></div>
    </div>
    ${c.rama ? `<div class="alert info">Ramassage ${p.ramassageMode ? 'auto-équilibré' : 'manuel'} : prix livraison ${eur3(c.deliveryPrice)} · prix enlèvement ${eur3(c.pickupPrice)}. Le ramassage complète le C.A. (${eur(c.ramaRevenue)}/mois) et abaisse le prix de livraison sans gonfler le C.A.</div>` : ''}`;
  body.querySelector('#tnd-pdf').onclick = () => tenderProposalPDF(p, c);
}

// Onglet Négociation : scénarios de prix.
function tndNego(body) {
  const p = _tender, base = tenderCompute(p);
  const scenarios = [2.50, 2.75, 3.00, 3.25, 3.50, 3.75, 4.00];
  const row = (price) => {
    const ca = price * base.deliveryPoints + base.ramaRevenue;
    const result = ca - base.totalCostMonthly;
    const marge = ca > 0 ? (result / ca) * 100 : 0;
    const pm = price > 0 ? base.totalCostMonthly / price : 0;
    const cnrImpact = price * (base.coefAjustPct / 100);
    const lvl = result < 0 ? 'red' : marge < 15 ? 'orange' : 'green';
    return `<tr><td>${feu(lvl)} ${eur3(price)}</td><td>${eur(ca)}</td><td class="${result >= 0 ? 'pos' : 'neg'}">${eur(result)}</td><td>${marge.toFixed(1)} %</td><td>${Math.ceil(pm).toLocaleString('fr-FR')} pts</td><td>${eur3(cnrImpact)}/pt</td></tr>`;
  };
  body.innerHTML = `
    <div class="card"><h3>Simulateur de négociation (prix du point)</h3>
      <p class="help">Prix de revient ${eur3(base.coutReelPoint)} · prix cible ${eur3(base.prixCible)}. Repérez le prix minimal acceptable (feu vert = marge ≥ 15 %).</p>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Prix / point</th><th>C.A. / mois</th><th>Résultat</th><th>Marge</th><th>Point mort</th><th>Impact CNR</th></tr></thead>
      <tbody>${scenarios.map(row).join('')}</tbody></table></div>
      <div class="grid2" style="margin-top:.8rem">
        <div><label>Prix libre à tester (€)</label><input id="ng-price" type="number" step="0.01" value="${base.prixCible.toFixed(3)}"></div>
        <div style="align-self:end"><button class="btn accent" id="ng-go">Tester</button></div>
      </div>
      <div id="ng-result"></div>
    </div>
    <div class="card"><h3>Tarif à négocier en cas de hausse des coûts</h3>
      <div class="grid2">
        <div><label>Hausse carburant (%)</label><input id="ng-fuel" type="number" step="0.5" value="0"></div>
        <div><label>Hausse salariale (%)</label><input id="ng-sal" type="number" step="0.5" value="0"></div>
        <div><label>Hausse entretien/assurance (%)</label><input id="ng-ent" type="number" step="0.5" value="0"></div>
        <div><label>Inflation autres charges (%)</label><input id="ng-inf" type="number" step="0.5" value="0"></div>
      </div>
      <div style="margin-top:.6rem"><button class="btn" id="ng-reneg">Calculer le prix recommandé</button></div>
      <div id="ng-reneg-result"></div>
    </div>`;
  document.getElementById('ng-go').onclick = () => {
    const price = Number(document.getElementById('ng-price').value) || 0;
    const ca = price * base.deliveryPoints + base.ramaRevenue, result = ca - base.totalCostMonthly, marge = ca > 0 ? result / ca * 100 : 0;
    document.getElementById('ng-result').innerHTML = `<p style="margin:.6rem 0 0">À ${eur3(price)} : C.A. ${eur(ca)} · résultat <strong class="${result >= 0 ? 'pos' : 'neg'}">${eur(result)}</strong> · marge ${marge.toFixed(1)} % · point mort ${Math.ceil(base.totalCostMonthly / price).toLocaleString('fr-FR')} pts.</p>`;
  };
  document.getElementById('ng-reneg').onclick = () => {
    const fuel = +document.getElementById('ng-fuel').value, sal = +document.getElementById('ng-sal').value, ent = +document.getElementById('ng-ent').value, inf = +document.getElementById('ng-inf').value;
    const newFixed = base.salairesChauffeurs * (1 + sal / 100) + base.salairesResp * (1 + sal / 100) + base.salaireSecr * (1 + sal / 100) + (base.vehiculesM + base.pneusM) * (1 + ent / 100) + base.fraisGen * (1 + inf / 100);
    const newVar = base.variableMonthly * (1 + fuel / 100);
    const newTotal = newFixed + newVar;
    const newCoutPoint = base.totalPoints > 0 ? newTotal / base.totalPoints : 0;
    const m = (p.marginPct || 0) / 100;
    const recommended = m < 1 ? newCoutPoint / (1 - m) : newCoutPoint;
    const ecart = recommended - base.prixCible;
    const gainAn = ecart * base.deliveryPoints * 12;
    document.getElementById('ng-reneg-result').innerHTML = `<div class="table-wrap" style="margin-top:.6rem"><table class="veh-table"><tbody>
      <tr><td>Prix actuel (cible)</td><td>${eur3(base.prixCible)}</td></tr>
      <tr><td>Coût réel actualisé / point</td><td>${eur3(newCoutPoint)}</td></tr>
      <tr><td><strong>Prix recommandé</strong></td><td><strong>${eur3(recommended)}</strong></td></tr>
      <tr><td>Écart à négocier</td><td class="${ecart >= 0 ? 'neg' : 'pos'}">${ecart >= 0 ? '+' : ''}${eur3(ecart)}/pt (${(base.prixCible > 0 ? ecart / base.prixCible * 100 : 0).toFixed(1)} %)</td></tr>
      <tr><td>Gain annuel estimé si obtenu</td><td>${eur(gainAn)}</td></tr>
    </tbody></table></div>`;
  };
}

function tndCalc(body) {
  const p = _tender;
  const f = (id, lbl, val, step) => `<div><label>${lbl}</label><input id="${id}" type="number" step="${step || 1}" value="${val}"></div>`;
  const pgOpts = [6, 8, 10, 12].map((x) => `<option value="${x}" ${p.fuelSurchargePct === x ? 'selected' : ''}>${x} %</option>`).join('');
  body.innerHTML = `<div class="card"><h3>Paramètres de l'offre</h3>
    <div class="grid2">
      ${f('tc-drivers', 'Nombre de chauffeurs', p.nbDrivers)}
      ${f('tc-points', 'Points livrés / jour / chauffeur', p.pointsPerDay)}
      ${f('tc-km', 'Km / jour / chauffeur', p.kmPerDay)}
      ${f('tc-days', 'Jours travaillés / mois', p.daysPerMonth)}
      ${f('tc-margin', 'Marge cible (%)', p.marginPct, 0.5)}
      <div><label>Part gasoil indexée</label><select id="tc-pg">${pgOpts}</select></div>
      ${f('tc-cnr', 'Indice CNR gasoil actuel (M-1, base 100)', p.cnrCurrent, 0.1)}
    </div>
    <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="tc-rama" ${p.ramassage ? 'checked' : ''}> L'offre inclut aussi le <strong>ramassage</strong></label>
    <div class="grid2" id="tc-rama-box" style="${p.ramassage ? '' : 'display:none'}">
      ${f('tc-ramaday', 'Points de ramassage / jour / chauffeur', p.ramassagePerDay)}
      ${f('tc-ramaprice', 'Prix par point de ramassage (€)', p.ramassagePrice, 0.01)}
    </div>
    <p class="help">Les coûts (chauffeur, structure, véhicule…) se règlent dans « Paramètres ».</p>
    <div style="margin-top:.6rem"><button class="btn accent" id="tc-calc">Calculer</button> <button class="btn ghost" id="tc-save">Enregistrer ces valeurs</button></div>
  </div>
  <div id="tc-result"></div>`;
  document.getElementById('tc-rama').onchange = (e) => { document.getElementById('tc-rama-box').style.display = e.target.checked ? '' : 'none'; };
  const read = () => ({ ...p, nbDrivers: +val('#tc-drivers'), pointsPerDay: +val('#tc-points'), kmPerDay: +val('#tc-km'), daysPerMonth: +val('#tc-days'), marginPct: +val('#tc-margin'), fuelSurchargePct: +val('#tc-pg'), cnrCurrent: +val('#tc-cnr'), ramassage: document.getElementById('tc-rama').checked ? 1 : 0, ramassagePerDay: +val('#tc-ramaday'), ramassagePrice: +val('#tc-ramaprice') });
  const show = (pp) => {
    const c = tenderCompute(pp);
    document.getElementById('tc-result').innerHTML = `<div class="card"><h3>Résultat</h3>
      <div class="grid cols-4">
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur3(c.pricePerPoint)}</div><div class="label">Prix / point</div></div>
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(c.caMonthly)}</div><div class="label">C.A. global / mois</div></div>
        <div class="stat"><div class="value" style="font-size:1.4rem">${eur(c.caPerDriver)}</div><div class="label">C.A. / chauffeur</div></div>
        <div class="stat ${c.resultMonth >= 0 ? '' : 'alt'}"><div class="value" style="font-size:1.4rem">${eur(c.resultMonth)}</div><div class="label">Résultat / mois</div></div>
      </div>
      <p class="help" style="margin-top:.6rem">${Math.round(c.pointsMonth).toLocaleString('fr-FR')} points/mois · coût de revient ${eur3(c.costPerPoint)}/point · point mort ${c.breakEvenPoints != null ? Math.ceil(c.breakEvenPoints).toLocaleString('fr-FR') + ' pts/mois' : '—'}</p></div>`;
  };
  document.getElementById('tc-calc').onclick = () => show(read());
  document.getElementById('tc-save').onclick = async () => { try { await api('PUT', '/admin/tender', read()); await loadTender(); toast('Enregistré.', 'ok'); tndTab('dashboard'); } catch (e) { toast(e.message, 'err'); } };
  show(p);
  function val(s) { return document.querySelector(s).value; }
}

function tndMarge(body) {
  const p = _tender, c = tenderCompute(p);
  const low = tenderCompute({ ...p, pointsPerDay: p.pointsPerDay * 0.9, marginPct: p.marginPct - 3 });
  const high = tenderCompute({ ...p, pointsPerDay: p.pointsPerDay * 1.1, marginPct: p.marginPct + 3 });
  const months = Array.from({ length: 12 }, (_, i) => ({ ym: 'M+' + (i + 1), result: c.resultMonth * (i + 1) }));
  const fixedRows = [
    ['Salaires chauffeurs (' + c.drivers + ')', c.salairesChauffeurs],
    ['Salaires responsables (' + (p.nbResponsables || 0) + ')', c.salairesResp],
    ['Secrétariat (' + (p.nbSecretaires || 0) + ')', c.salaireSecr],
    ['Véhicules (leasing/assur./entretien × ' + c.drivers + ')', c.vehiculesM],
    ['Pneumatiques', c.pneusM],
    ['Frais généraux (loyer, télécom, assur. structure…)', c.fraisGen],
  ];
  body.innerHTML = `
    <div class="card"><h3>Détail des charges fixes mensuelles</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Poste</th><th>Montant / mois</th></tr></thead><tbody>
        ${fixedRows.map((r) => `<tr><td>${esc(r[0])}</td><td>${eur(r[1])}</td></tr>`).join('')}
        <tr><td><strong>Total charges fixes</strong></td><td><strong>${eur(c.fixedMonthly)}</strong></td></tr>
        <tr><td>Carburant (variable)</td><td>${eur(c.carburantM)}</td></tr>
        <tr><td><strong>Coût total mensuel</strong></td><td><strong>${eur(c.totalCostMonthly)}</strong></td></tr>
      </tbody></table></div>
      <p class="help">Coût horaire chauffeur indicatif : ${eur(c.driverHourly)}/h (base ${p.hoursPerWeek} h/sem, 8 h/jour).</p>
    </div>
    <div class="card"><h3>Productivité</h3>
      <div class="table-wrap"><table class="veh-table"><tbody>
        <tr><td>Niveau global</td><td><span class="pill ${c.prodLevel === 'Excellent' || c.prodLevel === 'Bon' ? 'ok' : c.prodLevel === 'Moyen' ? 'warn' : 'danger'}">${esc(c.prodLevel)}</span></td></tr>
        <tr><td>Points par heure</td><td>${c.ptsPerHour.toFixed(1)} (cible ${p.targetPtsPerHour})</td></tr>
        <tr><td>Points par véhicule / mois</td><td>${Math.round(c.ptsPerVehicle).toLocaleString('fr-FR')}</td></tr>
        <tr><td>Km par point</td><td>${c.kmPerPoint.toFixed(2)} km (seuil ${p.maxKmPerPoint})</td></tr>
        <tr><td>Coût chauffeur / point</td><td>${eur3(c.coutChauffeurPerPoint)}</td></tr>
        <tr><td>Coût chauffeur / heure</td><td>${eur(c.coutChauffeurPerHour)}</td></tr>
      </tbody></table></div>
    </div>
    <div class="card"><h3>Point mort (seuil de rentabilité)</h3>
      <p>Vous couvrez vos charges à partir de <strong>${c.pointMort != null ? Math.ceil(c.pointMort).toLocaleString('fr-FR') : '—'} points/mois</strong> au prix de ${eur3(c.deliveryPrice)}/point.</p>
      <p class="help">Soit ${c.pointMortPct != null ? c.pointMortPct.toFixed(0) + ' % du volume' : '—'} · marge de sécurité ${c.margeSecurite != null ? Math.round(c.margeSecurite).toLocaleString('fr-FR') + ' points' : '—'}${c.rama ? ' · le ramassage apporte ' + eur(c.ramaRevenue) + '/mois' : ''}.</p>
    </div>
    <div class="card"><h3>Tendances</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Scénario</th><th>Prix / point</th><th>C.A. / mois</th><th>Résultat / mois</th><th>Résultat / an</th></tr></thead><tbody>
        <tr><td>📉 Basse (−10% volume, −3 pts marge)</td><td>${eur3(low.pricePerPoint)}</td><td>${eur(low.caMonthly)}</td><td class="${low.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(low.resultMonth)}</td><td class="${low.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(low.resultMonth * 12)}</td></tr>
        <tr><td>➡️ Centrale</td><td>${eur3(c.pricePerPoint)}</td><td>${eur(c.caMonthly)}</td><td class="${c.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(c.resultMonth)}</td><td class="${c.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(c.resultMonth * 12)}</td></tr>
        <tr><td>📈 Haute (+10% volume, +3 pts marge)</td><td>${eur3(high.pricePerPoint)}</td><td>${eur(high.caMonthly)}</td><td class="${high.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(high.resultMonth)}</td><td class="${high.resultMonth >= 0 ? 'pos' : 'neg'}">${eur(high.resultMonth * 12)}</td></tr>
      </tbody></table></div>
    </div>
    <div class="card"><h3>Projection du résultat cumulé sur 12 mois</h3>${barChart(months, 'result', 'ym')}</div>`;
}

function tndParams(body) {
  const p = _tender;
  const f = (id, lbl, val, step) => `<div><label>${lbl}</label><input id="${id}" type="number" step="${step || 1}" value="${val}"></div>`;
  const pgOpts = [6, 8, 10, 12].map((x) => `<option value="${x}" ${p.fuelSurchargePct === x ? 'selected' : ''}>${x} %</option>`).join('');
  body.innerHTML = `
    <div class="card"><h3>Effectif & temps de travail</h3>
      <div class="grid2">
        ${f('tp-nbd', 'Nombre de chauffeurs', p.nbDrivers)}
        ${f('tp-nbr', 'Nombre de responsables', p.nbResponsables)}
        ${f('tp-nbs', 'Nombre de secrétaires', p.nbSecretaires)}
        ${f('tp-hd', 'Heures / jour', p.hoursPerDay)}
        ${f('tp-hw', 'Heures / semaine', p.hoursPerWeek)}
        ${f('tp-days', 'Jours travaillés / mois', p.daysPerMonth)}
      </div>
    </div>
    <div class="card"><h3>Coûts mensuels chargés</h3>
      <div class="grid2">
        ${f('tp-driver', 'Coût chauffeur (€)', p.driverCost)}
        ${f('tp-resp', 'Coût responsable (€)', p.responsableCost)}
        ${f('tp-secr', 'Coût secrétaire (€)', p.secretaireCost)}
        ${f('tp-fg', 'Frais généraux / mois (loyer, télécom…) (€)', p.fraisGeneraux)}
        ${f('tp-vehicle', 'Coût véhicule / mois (leasing+assur.+entretien) (€)', p.vehicleCost)}
        ${f('tp-tyres', 'Pneumatiques amortis / mois / véhicule (€)', p.tyresPerMonth)}
        ${f('tp-cons', 'Consommation (L/100 km)', p.consumption, 0.1)}
        ${f('tp-fuel', 'Prix du gasoil (€/L)', p.fuelPrice, 0.01)}
      </div>
    </div>
    <div class="card"><h3>Activité & tarif</h3>
      <div class="grid2">
        ${f('tp-points', 'Points livrés / jour / chauffeur', p.pointsPerDay)}
        ${f('tp-km', 'Km / jour / chauffeur', p.kmPerDay)}
        ${f('tp-margin', 'Marge / bénéfice cible (%)', p.marginPct, 0.5)}
        ${f('tp-marginp', 'Marge premium (%)', p.marginPremiumPct, 0.5)}
        <div><label>Part gasoil indexée</label><select id="tp-pg">${pgOpts}</select></div>
        ${f('tp-cnrref', 'Indice CNR gasoil de référence (base 100)', p.cnrRef, 0.1)}
        ${f('tp-cnrcur', 'Indice CNR gasoil actuel (M-1, base 100)', p.cnrCurrent, 0.1)}
        ${f('tp-tph', 'Seuil productivité « bon » (points/heure)', p.targetPtsPerHour, 0.5)}
        ${f('tp-kpp', 'Seuil densité (km/point max)', p.maxKmPerPoint, 0.1)}
      </div>
      <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="tp-rama" ${p.ramassage ? 'checked' : ''}> Offre incluant le ramassage</label>
      <label class="veh-check"><input type="checkbox" id="tp-ramamode" ${p.ramassageMode ? 'checked' : ''}> Ramassage <strong>auto-équilibré</strong> (le prix d'enlèvement abaisse le prix de livraison)</label>
      <div class="grid2">
        ${f('tp-ramaday', 'Enlèvements / jour / chauffeur', p.ramassagePerDay)}
        ${f('tp-ramaprice', 'Prix par enlèvement (€) — mode manuel', p.ramassagePrice, 0.01)}
        ${f('tp-ramaratio', 'Ratio prix enlèvement / livraison (mode auto)', p.ramassageRatio, 0.05)}
      </div>
      <p class="help" style="margin-top:.5rem">📈 Part gasoil : relevez l'indice gasoil M-1 (base 100) sur <a href="https://www.cnr.fr/espaces/13/indicateurs/26" target="_blank" rel="noopener">cnr.fr</a>. Seule la part gasoil du prix est réindexée (indice actuel / référence).</p>
    </div>
    <div class="card"><h3>Méthode ICS — pôles complémentaires (fichier « tarif au point »)</h3>
      <p class="help">Reproduit votre fichier de référence : indemnité repas exonérée, provision de remplacement des congés, entretien au km et tarif « au-delà du forfait ». Mettez 0 pour neutraliser un pôle.</p>
      <div class="grid2">
        ${f('tp-panier', 'Panier repas (€/jour/chauffeur)', p.panierRepas, 0.01)}
        ${f('tp-jpanier', 'Jours de panier / mois', p.joursPanier, 0.01)}
        ${f('tp-rempl', 'Provision remplacement congés (€/mois/chauffeur)', p.remplacementPerDriver)}
        ${f('tp-entkm', 'Entretien & consommables (€/km)', p.entretienPerKm, 0.0001)}
        ${f('tp-audela', 'Tarif livraison au-delà du forfait (% du prix de base)', p.auDelaPct, 1)}
      </div>
      <p class="help" style="margin-top:.5rem">💡 Méthode au point : le prix de livraison est calculé sur un <strong>dénominateur pondéré</strong> (points livraison + ratio collecte/livraison × points collecte, réglé dans « Activité & tarif » → mode auto-équilibré). Avec un ratio de 2, la collecte vaut 2× la livraison. La collecte au-delà du forfait est facturée au prix de livraison de base.</p>
      <div style="margin-top:.6rem"><button class="btn ghost" id="tp-refmodel">📋 Charger le modèle de référence ICS</button></div>
    </div>
    <button class="btn accent" id="tp-save">Enregistrer tous les paramètres</button>`;
    // Pré-remplit tous les champs avec les valeurs du fichier de référence ICS.
    document.getElementById('tp-refmodel').onclick = () => {
      if (!confirm('Charger les valeurs de référence du fichier « ICS tarif au point » dans le formulaire ? (rien n\'est enregistré tant que vous ne cliquez pas sur « Enregistrer »)')) return;
      const ref = { 'tp-driver': 2738, 'tp-resp': 3500, 'tp-secr': 2600, 'tp-fg': 150, 'tp-vehicle': 1420, 'tp-tyres': 0, 'tp-cons': 10, 'tp-fuel': 1.60, 'tp-panier': 16.36, 'tp-jpanier': 21.67, 'tp-rempl': 263, 'tp-entkm': 0.0353, 'tp-audela': 50, 'tp-ramaratio2': 2, 'tp-margin': 15, 'tp-cnrref': 234.36, 'tp-cnrcur': 234.36 };
      for (const id in ref) { const el = document.getElementById(id); if (el) el.value = ref[id]; }
      const rama = document.getElementById('tp-rama'); if (rama) rama.checked = true;
      const ramamode = document.getElementById('tp-ramamode'); if (ramamode) ramamode.checked = true;
      const rr = document.getElementById('tp-ramaratio'); if (rr) rr.value = 2;
      toast('Modèle de référence chargé — vérifiez puis « Enregistrer ».', 'ok');
    };
  document.getElementById('tp-save').onclick = async () => {
    const payload = {
      nbDrivers: v('#tp-nbd'), nbResponsables: v('#tp-nbr'), nbSecretaires: v('#tp-nbs'),
      hoursPerDay: v('#tp-hd'), hoursPerWeek: v('#tp-hw'), daysPerMonth: v('#tp-days'),
      driverCost: v('#tp-driver'), responsableCost: v('#tp-resp'), secretaireCost: v('#tp-secr'), fraisGeneraux: v('#tp-fg'),
      vehicleCost: v('#tp-vehicle'), tyresPerMonth: v('#tp-tyres'), consumption: v('#tp-cons'), fuelPrice: v('#tp-fuel'),
      pointsPerDay: v('#tp-points'), kmPerDay: v('#tp-km'), marginPct: v('#tp-margin'), marginPremiumPct: v('#tp-marginp'), fuelSurchargePct: v('#tp-pg'),
      cnrRef: v('#tp-cnrref'), cnrCurrent: v('#tp-cnrcur'), targetPtsPerHour: v('#tp-tph'), maxKmPerPoint: v('#tp-kpp'),
      ramassage: document.getElementById('tp-rama').checked ? 1 : 0, ramassageMode: document.getElementById('tp-ramamode').checked ? 1 : 0, ramassagePerDay: v('#tp-ramaday'), ramassagePrice: v('#tp-ramaprice'), ramassageRatio: v('#tp-ramaratio'),
      panierRepas: v('#tp-panier'), joursPanier: v('#tp-jpanier'), remplacementPerDriver: v('#tp-rempl'), entretienPerKm: v('#tp-entkm'), auDelaPct: v('#tp-audela'),
    };
    try { await api('PUT', '/admin/tender', payload); await loadTender(); toast('Paramètres enregistrés.', 'ok'); tndTab('dashboard'); } catch (e) { toast(e.message, 'err'); }
  };
  function v(s) { return document.querySelector(s).value; }
}

// Proposition tarifaire à en-tête de l'entreprise (impression / PDF).
function tenderProposalPDF(p, c) {
  const w = window.open('', '_blank');
  if (!w) { toast('Autorisez les fenêtres pop-up pour générer le PDF.', 'err'); return; }
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Proposition tarifaire — INTER COLIS SERVICES</title>
    <style>body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;padding:32px;line-height:1.5}
      .head{display:flex;justify-content:space-between;border-bottom:3px solid #14427e;padding-bottom:12px}
      .head h1{color:#14427e;margin:0;font-size:20px}.head .co{font-size:12px;color:#475569}
      h2{color:#14427e;font-size:15px;margin:1.4rem 0 .4rem}table{width:100%;border-collapse:collapse;margin:.5rem 0}
      td,th{border:1px solid #cbd5e1;padding:7px 9px;font-size:13px;text-align:left}th{background:#eef2f7}
      .big{font-size:22px;color:#14427e;font-weight:800}.foot{margin-top:2rem;font-size:12px;color:#475569}</style></head>
    <body>
      <div class="head"><div><h1>INTER COLIS SERVICES</h1><div class="co">12 rue des Écrottes — 14480 Sainte-Croix-sur-Mer<br>contact@inter-colis-services.com</div></div>
        <div class="co" style="text-align:right">Proposition tarifaire<br>Éterville, le ${fmtDate(iso(new Date()))}</div></div>
      <h2>Objet : proposition de prix de livraison au point</h2>
      <p>Madame, Monsieur,<br>Suite à votre consultation, veuillez trouver notre proposition tarifaire pour la prestation de livraison de colis.</p>
      <table><tbody>
        <tr><th>Prix par point livré (HT)</th><td class="big">${eur3(c.deliveryPrice)}</td></tr>
        ${c.rama ? `<tr><th>Prix par point de collecte / enlèvement (HT)</th><td>${eur3(c.pickupPrice)}</td></tr>` : ''}
        <tr><th>Livraison au-delà du forfait (HT)</th><td>${eur3(c.prixLivraisonAuDela)}</td></tr>
        ${c.rama ? `<tr><th>Collecte au-delà du forfait (HT)</th><td>${eur3(c.prixCollecteAuDela)}</td></tr>` : ''}
        <tr><th>Volume estimé</th><td>${p.pointsPerDay} points/jour/chauffeur · ${c.drivers} chauffeurs · ${Math.round(c.pointsMonth).toLocaleString('fr-FR')} points/mois</td></tr>
        <tr><th>Chiffre d'affaires mensuel estimé (HT)</th><td>${eur(c.caMonthly)}</td></tr>
        <tr><th>Révision tarifaire</th><td>Indexation gasoil (part ${p.fuelSurchargePct}%) sur l'indice CNR (base 100, mois M-1) — cnr.fr</td></tr>
      </tbody></table>
      <p class="foot">Prix hors taxes, hors péages et hors prestations annexes. Proposition valable 30 jours. Conditions de règlement : 30 jours date de facture. Document non contractuel établi à titre indicatif.</p>
      <p class="foot">Pour INTER COLIS SERVICES — La Direction</p>
    </body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
}

/* =========================================================================
   CONTRATS DONNEURS D'ORDRE (administrateur)
   ========================================================================= */
const CONTRACT_DONNEURS = ['GLS', 'FedEx', 'DPD', 'Chronopost', 'UPS', 'Ciblex', 'Autre'];

// Calcul de rentabilité d'un contrat (côté client).
function contractCompute(k) {
  // C.A. livraison (avec éventuel tarif dégressif au-delà d'un seuil de points).
  const dThr = k.deliveryThreshold || 0, dDeg = k.priceDeliveryDeg || 0;
  const caLivraison = (k.degressiveDelivery && dThr > 0 && (k.deliveries || 0) > dThr)
    ? dThr * (k.priceDelivery || 0) + ((k.deliveries || 0) - dThr) * dDeg
    : (k.deliveries || 0) * (k.priceDelivery || 0);
  const pThr = k.pickupThreshold || 0, pDeg = k.pricePickupDeg || 0;
  const caEnlevement = (k.degressivePickup && pThr > 0 && (k.pickups || 0) > pThr)
    ? pThr * (k.pricePickup || 0) + ((k.pickups || 0) - pThr) * pDeg
    : (k.pickups || 0) * (k.pricePickup || 0);
  const caForfait = (k.dailyFlat || 0) * (k.daysPerMonth || 21) + (k.vehicleFlat || 0) * (k.vehicles || 1) + (k.fuelFlat || 0);
  const caPrimes = (k.bonusQuality || 0) + (k.bonusPerf || 0) + (k.bonusProd || 0);
  const caEquip = (k.flocage || 0) + (k.tenues || 0); // flocage camion + tenues chauffeurs
  const caTotal = caLivraison + caEnlevement + caForfait + caPrimes + caEquip;
  const penalites = (k.penFailedDelivery || 0) + (k.penLate || 0) + (k.penAbsence || 0) + (k.penClaim || 0) + (k.penQuality || 0);
  const resultBrut = caTotal - (k.monthlyCost || 0);
  const resultNet = resultBrut - penalites;
  const marginPct = caTotal > 0 ? (resultNet / caTotal) * 100 : 0;
  const totalPoints = (k.deliveries || 0) + (k.pickups || 0);
  const coutReelPoint = totalPoints > 0 ? (k.monthlyCost || 0) / totalPoints : 0;
  const resultParVehicule = (k.vehicles || 1) > 0 ? resultNet / (k.vehicles || 1) : resultNet;
  // CNR : indexation gazole.
  const variationPct = k.fuelRef > 0 ? ((k.fuelCurrent - k.fuelRef) / k.fuelRef) * 100 : 0;
  const indexPct = variationPct * ((k.fuelSharePct || 0) / 100);
  const cnrPerPoint = (k.priceDelivery || 0) * (indexPct / 100);
  const cnrDaily = cnrPerPoint * ((k.deliveries || 0) / (k.daysPerMonth || 21));
  const cnrMonthly = cnrPerPoint * (k.deliveries || 0);
  const cnrYearly = cnrMonthly * 12;
  // Renégociation : prix recommandé pour la marge cible.
  const mt = (k.marginTargetPct || 12) / 100;
  const prixRecommande = mt < 1 ? coutReelPoint / (1 - mt) : coutReelPoint;
  const ecart = prixRecommande - (k.priceDelivery || 0);
  const gainAnnuel = ecart * (k.deliveries || 0) * 12;
  return { caLivraison, caEnlevement, caForfait, caPrimes, caEquip, caTotal, penalites, resultBrut, resultNet, marginPct, totalPoints, coutReelPoint, resultParVehicule, variationPct, indexPct, cnrPerPoint, cnrDaily, cnrMonthly, cnrYearly, prixRecommande, ecart, gainAnnuel };
}

// Extraction heuristique des paramètres d'un contrat depuis un texte OCR.
// Imparfait par nature : tout est PROPOSÉ et relu dans le formulaire.
function contractExtractFromText(txt) {
  const t = String(txt || '').replace(/ /g, ' ');
  const low = t.toLowerCase();
  const lines = t.split(/\r?\n/);
  const out = {};
  // Donneur d'ordre connu.
  for (const d of CONTRACT_DONNEURS) { if (d !== 'Autre' && low.includes(d.toLowerCase())) { out.name = d; break; } }
  // Montant (prix/€) sur une ligne contenant un mot-clé.
  const amountOn = (re) => {
    for (const ln of lines) {
      if (!re.test(ln)) continue;
      const m = ln.match(/(\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{1,3})|\d+[.,]\d{1,3}|\d+)/);
      if (m) { const n = parseFloat(m[1].replace(/[ ]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); if (Number.isFinite(n)) return n; }
    }
    return null;
  };
  const priceOn = (re) => {
    for (const ln of lines) {
      if (!re.test(ln)) continue;
      const m = ln.match(/(\d+[.,]\d{1,3})\s*(?:€|eur|ht)?/i);
      if (m) { const n = parseFloat(m[1].replace(',', '.')); if (Number.isFinite(n) && n < 100) return n; }
    }
    return null;
  };
  const pd = priceOn(/(point|livraison|livr[ée]|colis)/i); if (pd != null) out.priceDelivery = pd;
  const pp = priceOn(/(enl[èe]vement|collecte|ramassage|pickup)/i); if (pp != null) out.pricePickup = pp;
  const fd = amountOn(/forfait\s*(journalier|jour|quotidien)/i); if (fd != null) out.dailyFlat = fd;
  const fv = amountOn(/forfait\s*(v[ée]hicule|camion)/i); if (fv != null) out.vehicleFlat = fv;
  const ff = amountOn(/forfait\s*(carburant|gazole|gasoil)/i); if (ff != null) out.fuelFlat = ff;
  // Pénalités selon le motif.
  const penOn = (re) => amountOn(new RegExp('p[ée]nalit[ée].*' + re.source + '|' + re.source + '.*p[ée]nalit', 'i'));
  let v;
  if ((v = penOn(/retard/i)) != null) out.penLate = v;
  if ((v = penOn(/(r[ée]clamation|litige)/i)) != null) out.penClaim = v;
  if ((v = penOn(/(échec|echec|non[- ]?livr)/i)) != null) out.penFailedDelivery = v;
  if ((v = penOn(/absence/i)) != null) out.penAbsence = v;
  if ((v = penOn(/qualit[ée]/i)) != null) out.penQuality = v;
  // Part gazole / indexation (%).
  const gz = low.match(/(?:indexation|gazole|gasoil)[^%]{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/);
  if (gz) out.fuelSharePct = parseFloat(gz[1].replace(',', '.'));
  // Jours / mois.
  const jm = low.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*jours?\s*(?:\/|par|ouvr)/);
  if (jm) { const n = parseFloat(jm[1].replace(',', '.')); if (n >= 15 && n <= 31) out.daysPerMonth = n; }
  // Dates (du … au …).
  const dts = [...t.matchAll(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/g)].map((m) => {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  });
  if (dts[0]) out.startDate = dts[0];
  if (dts[1]) out.endDate = dts[1];
  // Secteur.
  const sec = t.match(/secteur\s*:?\s*([^\n]{2,40})/i);
  if (sec) out.sector = sec[1].trim().replace(/[.;].*$/, '');
  return out;
}

let _contracts = [];
async function renderContracts(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>Contrats donneurs d'ordre</h1>
    <p>Rentabilité par contrat, indexation CNR et tarif à négocier.</p></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn" id="ct-ocr">📄 Importer un contrat (OCR)</button><button class="btn accent" id="ct-new">+ Nouveau contrat</button></div></div>
    <details class="card" id="ct-ocr-box" style="display:none">
      <summary style="display:none"></summary>
      <h3 style="margin-top:0">Lecture automatique d'un contrat</h3>
      <p class="help">Déposez le contrat (PDF ou image). Le système lit le document <strong>localement</strong> (OCR) et pré-remplit une fiche contrat avec les paramètres détectés (prix au point, forfaits, pénalités, indexation gazole, dates…). Tout est <strong>proposé</strong> : relisez et corrigez avant d'enregistrer.</p>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <input type="file" id="ct-file" accept=".pdf,image/*">
        <button class="btn accent" id="ct-ocr-run">🔍 Lire & pré-remplir</button>
        <span class="help" id="ct-ocr-status"></span>
      </div>
    </details>
    <div id="ct-body" class="empty">Chargement…</div>`;
  document.getElementById('ct-new').onclick = () => contractModal(null);
  const ocrBox = document.getElementById('ct-ocr-box');
  document.getElementById('ct-ocr').onclick = () => { ocrBox.style.display = ocrBox.style.display === 'none' ? '' : 'none'; ocrBox.open = true; };
  document.getElementById('ct-ocr-run').onclick = async () => {
    const file = document.getElementById('ct-file').files[0];
    const status = document.getElementById('ct-ocr-status');
    if (!file) { toast('Choisissez un fichier (PDF ou image).', 'err'); return; }
    try {
      const txt = await ocrFileToText(file, status);
      const params = contractExtractFromText(txt);
      const n = Object.keys(params).length;
      status.textContent = n ? `OCR terminé — ${n} paramètre(s) détecté(s), à vérifier.` : 'OCR terminé — aucun paramètre reconnu automatiquement, saisissez manuellement.';
      contractModal(params, true);
    } catch (e) { status.textContent = ''; toast('OCR indisponible : ' + e.message, 'err'); }
  };
  await loadContracts();
}
async function loadContracts() {
  try { _contracts = (await api('GET', '/admin/contracts')).contracts; } catch (e) { document.getElementById('ct-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const body = document.getElementById('ct-body'); body.className = '';
  if (!_contracts.length) { body.innerHTML = `<div class="alert info">Aucun contrat. Cliquez sur « Nouveau contrat ».</div>`; return; }
  const computed = _contracts.map((k) => ({ k, c: contractCompute(k) }));
  // Tableau de bord direction : agrégats + classement.
  const tot = computed.reduce((a, x) => ({ ca: a.ca + x.c.caTotal, res: a.res + x.c.resultNet }), { ca: 0, res: 0 });
  const ranking = computed.slice().sort((a, b) => b.c.resultNet - a.c.resultNet);
  body.innerHTML = `
    <div class="grid cols-3">
      <div class="stat"><div class="value" style="font-size:1.4rem">${eur(tot.ca)}</div><div class="label">C.A. mensuel (tous contrats)</div></div>
      <div class="stat ${tot.res >= 0 ? '' : 'alt'}"><div class="value" style="font-size:1.4rem">${eur(tot.res)}</div><div class="label">Résultat net mensuel</div></div>
      <div class="stat"><div class="value" style="font-size:1.4rem">${tot.ca > 0 ? (tot.res / tot.ca * 100).toFixed(1) : 0} %</div><div class="label">Marge moyenne</div></div>
    </div>
    <div class="card"><h3>Classement des contrats par rentabilité</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Contrat</th><th>C.A.</th><th>Résultat net</th><th>Marge</th><th>Coût/pt</th><th>CNR/mois</th><th></th></tr></thead>
      <tbody>${ranking.map(({ k, c }) => `<tr>
        <td><strong>${esc(k.name)}</strong>${k.sector ? `<div class="help">${esc(k.sector)}</div>` : ''}</td>
        <td>${eur(c.caTotal)}</td>
        <td class="${c.resultNet >= 0 ? 'pos' : 'neg'}">${eur(c.resultNet)}</td>
        <td>${c.marginPct.toFixed(1)} %</td>
        <td>${eur3(c.coutReelPoint)}</td>
        <td>${eur(c.cnrMonthly)}</td>
        <td style="white-space:nowrap"><button class="btn ghost sm" data-ctview="${k.id}">Détail</button> <button class="btn ghost sm" data-ctedit="${k.id}">✎</button> <button class="btn ghost sm" data-ctdel="${k.id}">✕</button></td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;
  body.querySelectorAll('[data-ctview]').forEach((b) => b.onclick = () => contractDetailModal(_contracts.find((x) => x.id === b.dataset.ctview)));
  body.querySelectorAll('[data-ctedit]').forEach((b) => b.onclick = () => contractModal(_contracts.find((x) => x.id === b.dataset.ctedit)));
  body.querySelectorAll('[data-ctdel]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer ce contrat ?')) return; try { await api('DELETE', '/admin/contracts/' + b.dataset.ctdel); loadContracts(); } catch (e) { toast(e.message, 'err'); } });
}

function contractDetailModal(k) {
  if (!k) return; const c = contractCompute(k);
  const reneg = c.marginPct < (k.marginTargetPct || 12);
  modal({
    title: 'Contrat — ' + k.name,
    bodyHTML: `
      ${reneg ? `<div class="alert warn">⚠️ Marge (${c.marginPct.toFixed(1)} %) inférieure à l'objectif (${k.marginTargetPct || 12} %) : <strong>renégociation tarifaire recommandée</strong>. Prix recommandé ${eur3(c.prixRecommande)} (+${eur3(c.ecart)}/pt, gain annuel ${eur(c.gainAnnuel)}).</div>` : ''}
      <div class="table-wrap"><table class="veh-table"><tbody>
        <tr><td>C.A. livraison</td><td>${eur(c.caLivraison)}</td></tr>
        <tr><td>C.A. enlèvement</td><td>${eur(c.caEnlevement)}</td></tr>
        <tr><td>C.A. forfaits</td><td>${eur(c.caForfait)}</td></tr>
        <tr><td>C.A. primes</td><td>${eur(c.caPrimes)}</td></tr>
        ${c.caEquip ? `<tr><td>C.A. flocage & tenues</td><td>${eur(c.caEquip)}</td></tr>` : ''}
        <tr><td><strong>C.A. total</strong></td><td><strong>${eur(c.caTotal)}</strong></td></tr>
        <tr><td>Coût d'exploitation</td><td>${eur(k.monthlyCost || 0)}</td></tr>
        <tr><td>Résultat brut</td><td>${eur(c.resultBrut)}</td></tr>
        <tr><td>Pénalités</td><td>${eur(c.penalites)}</td></tr>
        <tr><td><strong>Résultat net</strong></td><td><strong class="${c.resultNet >= 0 ? 'pos' : 'neg'}">${eur(c.resultNet)}</strong> (${c.marginPct.toFixed(1)} %)</td></tr>
        <tr><td>Résultat par véhicule</td><td>${eur(c.resultParVehicule)}</td></tr>
        <tr><td>Coût réel du point</td><td>${eur3(c.coutReelPoint)}</td></tr>
        <tr><td>Indexation CNR</td><td>${c.indexPct.toFixed(2)} % → ${eur3(c.cnrPerPoint)}/pt · ${eur(c.cnrMonthly)}/mois · ${eur(c.cnrYearly)}/an</td></tr>
        <tr><td>Tarif à négocier</td><td><strong>${eur3(c.prixRecommande)}</strong> (actuel ${eur3(k.priceDelivery || 0)})</td></tr>
      </tbody></table></div>`,
    footHTML: `<button class="btn ghost" data-close>Fermer</button>`,
  });
}

function contractModal(k, isNew) {
  const e = k || {};
  const creating = isNew || !k || !k.id; // OCR/préremplissage = création (POST)
  const f = (id, lbl, val, step) => `<div><label>${lbl}</label><input id="${id}" type="number" step="${step || 1}" value="${val != null ? val : ''}"></div>`;
  const donneurOpts = CONTRACT_DONNEURS.map((d) => `<option ${e.name === d ? 'selected' : ''}>${d}</option>`).join('');
  modal({
    title: creating ? 'Nouveau contrat' : 'Modifier le contrat',
    bodyHTML: `
      <div class="grid2">
        <div><label>Nom du contrat</label><input id="k-name" list="k-donneurs" value="${esc(e.name || '')}" placeholder="GLS, FedEx, DPD…"><datalist id="k-donneurs">${donneurOpts}</datalist></div>
        <div><label>Secteur</label><input id="k-sector" value="${esc(e.sector || '')}"></div>
        <div><label>Date de début</label><input id="k-start" type="date" value="${esc(e.startDate || '')}"></div>
        <div><label>Date de fin</label><input id="k-end" type="date" value="${esc(e.endDate || '')}"></div>
        ${f('k-vehicles', 'Véhicules affectés', e.vehicles, 1)}
        ${f('k-days', 'Jours / mois', e.daysPerMonth != null ? e.daysPerMonth : 21, 1)}
      </div>
      <h4 style="margin:.7rem 0 .3rem">Volumes mensuels</h4>
      <div class="grid2">${f('k-deliveries', 'Livraisons / mois', e.deliveries, 1)}${f('k-pickups', 'Enlèvements / mois', e.pickups, 1)}${f('k-cost', "Coût d'exploitation / mois (€)", e.monthlyCost, 1)}</div>
      <h4 style="margin:.7rem 0 .3rem">Tarification</h4>
      <div class="grid2">
        ${f('k-pd', 'Prix point livraison (€)', e.priceDelivery, 0.01)}${f('k-pp', 'Prix point enlèvement (€)', e.pricePickup, 0.01)}
        ${f('k-fd', 'Forfait journalier (€)', e.dailyFlat, 0.01)}${f('k-fv', 'Forfait véhicule (€)', e.vehicleFlat, 0.01)}
        ${f('k-ff', 'Forfait carburant (€)', e.fuelFlat, 0.01)}
        ${f('k-bq', 'Prime qualité (€)', e.bonusQuality, 0.01)}${f('k-bp', 'Prime performance (€)', e.bonusPerf, 0.01)}${f('k-bpr', 'Prime productivité (€)', e.bonusProd, 0.01)}
      </div>
      <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="k-degd" ${e.degressiveDelivery ? 'checked' : ''}> Tarif <strong>dégressif livraison</strong> (au-delà d'un seuil de points)</label>
      <div class="grid2">${f('k-dthr', 'Seuil livraison (points au tarif normal)', e.deliveryThreshold, 1)}${f('k-pddeg', 'Prix livraison dégressif au-delà (€)', e.priceDeliveryDeg, 0.01)}</div>
      <label class="veh-check" style="margin-top:.4rem"><input type="checkbox" id="k-degp" ${e.degressivePickup ? 'checked' : ''}> Tarif <strong>dégressif enlèvement</strong></label>
      <div class="grid2">${f('k-pthr', 'Seuil enlèvement (points au tarif normal)', e.pickupThreshold, 1)}${f('k-ppdeg', 'Prix enlèvement dégressif au-delà (€)', e.pricePickupDeg, 0.01)}</div>
      <h4 style="margin:.7rem 0 .3rem">Rémunérations complémentaires (€ / mois)</h4>
      <div class="grid2">${f('k-flocage', 'Flocage camion', e.flocage, 0.01)}${f('k-tenues', 'Tenues chauffeurs', e.tenues, 0.01)}</div>
      <h4 style="margin:.7rem 0 .3rem">Pénalités mensuelles (€)</h4>
      <div class="grid2">${f('k-p1', 'Échec de livraison', e.penFailedDelivery, 0.01)}${f('k-p2', 'Retard', e.penLate, 0.01)}${f('k-p3', 'Absence chauffeur', e.penAbsence, 0.01)}${f('k-p4', 'Réclamation client', e.penClaim, 0.01)}${f('k-p5', 'Non-respect qualité', e.penQuality, 0.01)}</div>
      <h4 style="margin:.7rem 0 .3rem">Indexation CNR & objectif</h4>
      <div class="grid2">${f('k-fref', 'Gazole référence (€/L)', e.fuelRef != null ? e.fuelRef : 1.5, 0.01)}${f('k-fcur', 'Gazole actuel (€/L)', e.fuelCurrent != null ? e.fuelCurrent : 1.5, 0.01)}${f('k-fs', 'Part carburant (%)', e.fuelSharePct != null ? e.fuelSharePct : 10, 1)}${f('k-mt', 'Marge cible (%)', e.marginTargetPct != null ? e.marginTargetPct : 12, 0.5)}</div>`,
    footHTML: `${creating && (e.priceDelivery != null || e.name) ? '<span class="help" style="margin-right:auto">📄 Valeurs pré-remplies par OCR — à vérifier</span>' : ''}<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="k-save">${creating ? 'Créer' : 'Enregistrer'}</button>`,
    onMount: (ov) => { ov.querySelector('#k-save').onclick = async () => {
      const g = (s) => ov.querySelector(s).value;
      const payload = { name: g('#k-name'), sector: g('#k-sector'), startDate: g('#k-start'), endDate: g('#k-end'), vehicles: g('#k-vehicles'), daysPerMonth: g('#k-days'), deliveries: g('#k-deliveries'), pickups: g('#k-pickups'), monthlyCost: g('#k-cost'), priceDelivery: g('#k-pd'), pricePickup: g('#k-pp'), dailyFlat: g('#k-fd'), vehicleFlat: g('#k-fv'), fuelFlat: g('#k-ff'), bonusQuality: g('#k-bq'), bonusPerf: g('#k-bp'), bonusProd: g('#k-bpr'), penFailedDelivery: g('#k-p1'), penLate: g('#k-p2'), penAbsence: g('#k-p3'), penClaim: g('#k-p4'), penQuality: g('#k-p5'), fuelRef: g('#k-fref'), fuelCurrent: g('#k-fcur'), fuelSharePct: g('#k-fs'), marginTargetPct: g('#k-mt'),
        degressiveDelivery: ov.querySelector('#k-degd').checked ? 1 : 0, deliveryThreshold: g('#k-dthr'), priceDeliveryDeg: g('#k-pddeg'),
        degressivePickup: ov.querySelector('#k-degp').checked ? 1 : 0, pickupThreshold: g('#k-pthr'), pricePickupDeg: g('#k-ppdeg'),
        flocage: g('#k-flocage'), tenues: g('#k-tenues') };
      if (!payload.name.trim()) { toast('Nom du contrat obligatoire.', 'err'); return; }
      try { await api(creating ? 'POST' : 'PUT', '/admin/contracts' + (creating ? '' : '/' + k.id), payload); closeModal(); loadContracts(); toast('Enregistré.', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    }; },
  });
}

/* =========================================================================
   GESTION DES HEURES — amplitudes des chauffeurs (encadrement)
   ========================================================================= */
let _hours = null;
function hFmt(h) { const n = Number(h) || 0; const hh = Math.floor(n); const mm = Math.round((n - hh) * 60); return `${hh}h${mm < 10 ? '0' : ''}${mm}`; }
function isoWeekStart(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; }

async function renderHours(main) {
  if (!isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  // Les responsables n'ont accès qu'au « Résumé des amplitudes » pour le moment.
  const fullAccess = State.user.role === 'admin';
  main.innerHTML = `<div class="page-head"><div><h1>Gestion des heures</h1>
    <p>Suivi des amplitudes et du temps de travail des chauffeurs.</p></div></div>
    <div class="view-switch" id="hr-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-htab="resume" class="active">Résumé des amplitudes</button>
      ${fullAccess ? `<button data-htab="hsup">Gestion des heures supplémentaires</button>
      <button data-htab="import">Import rapport d'activité</button>
      <button data-htab="saisie">Saisie manuelle</button>
      <button data-htab="bulletins">Bulletins de salaire</button>` : ''}
    </div>
    <div id="hr-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#hr-tabs');
  tabs.querySelectorAll('[data-htab]').forEach((b) => b.onclick = () => { tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); hrTab(b.dataset.htab); });
  await loadHours();
  hrTab('resume');
}
async function loadHours() { _hours = await api('GET', '/staff/work-hours'); }
function hrTab(tab) {
  const body = document.getElementById('hr-body'); if (!body) return; body.className = '';
  if (tab === 'resume') return hoursResume(body);
  if (tab === 'hsup') return hoursHsup(body);
  if (tab === 'import') return hoursImport(body);
  if (tab === 'saisie') return hoursSaisie(body);
  if (tab === 'bulletins') return hoursBulletins(body);
}

/* ---- Bulletins de salaire : upload + lecture + relecture + application --- */
const BULL_CATS = [['congesN', 'Congés N'], ['congesN1', 'Congés N-1'], ['rcc', 'RCC (h)'], ['heuresSupp', 'Récup. / h. sup (h)']];
let _bullUsers = [];
function hoursBulletins(body) {
  body.innerHTML = `
    <div class="alert info">Importez les bulletins de paie (PDF). Les compteurs détectés (congés payés N / N-1, RCC, récupération) sont <strong>proposés</strong> ; vous les relisez et corrigez avant de les appliquer aux comptes des salariés.</div>
    <div class="card">
      <div class="erp-row" style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
        <input type="file" id="bull-files" accept="application/pdf" multiple>
        <button class="btn accent" id="bull-read">📄 Lire les bulletins</button>
        <span class="help" id="bull-status"></span>
      </div>
    </div>
    <div id="bull-review"></div>`;
  body.querySelector('#bull-read').onclick = bullRead;
}

function bullFileToData(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ name: file.name, data: String(fr.result) });
    fr.onerror = () => reject(new Error('Lecture du fichier impossible'));
    fr.readAsDataURL(file);
  });
}

async function bullRead() {
  const input = document.getElementById('bull-files');
  const status = document.getElementById('bull-status');
  const files = [...(input.files || [])];
  if (!files.length) { toast('Sélectionnez au moins un bulletin PDF.', 'warn'); return; }
  status.textContent = 'Lecture en cours…';
  try {
    const payload = await Promise.all(files.map(bullFileToData));
    const { results, users } = await api('POST', '/staff/payslips/parse', { files: payload });
    _bullUsers = users || [];
    bullRenderReview(results || []);
    status.textContent = `${results.length} bulletin(s) lu(s).`;
  } catch (e) { status.textContent = ''; toast('Erreur : ' + e.message, 'err'); }
}

function bullConfBadge(c) {
  const m = c >= 3 ? ['#16a34a', 'fiable'] : c >= 1 ? ['#eab308', 'à vérifier'] : ['#ef4444', 'incertain'];
  return `<span class="pill" style="background:${m[0]}22;color:${m[0]}">détection ${m[1]}</span>`;
}

function bullRenderReview(results) {
  const wrap = document.getElementById('bull-review');
  // Associés (et plus sûrs) d'abord ; non rapprochés en dernier.
  results = results.slice().sort((a, b) => (((a.matchedUserId ? 0 : 1) - (b.matchedUserId ? 0 : 1)) || ((b.confidence || 0) - (a.confidence || 0)) || String(a.fileName).localeCompare(String(b.fileName))));
  const nMatched = results.filter((r) => r.matchedUserId).length;
  const userOpts = (sel) => '<option value="">— choisir un salarié —</option>'
    + _bullUsers.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const summary = `<div class="alert info"><strong>${results.length} bulletin(s) lu(s)</strong> — ${nMatched} rapproché(s) automatiquement à un salarié${results.length - nMatched ? `, ${results.length - nMatched} à associer manuellement` : ''}. Vérifiez chaque proposition (soldes de congés / repos) puis appliquez.</div>`;
  wrap.innerHTML = summary + results.map((r, i) => {
    const cur = (_bullUsers.find((u) => u.id === r.matchedUserId) || {}).balances || {};
    const rows = BULL_CATS.map(([k, lbl]) => {
      const proposed = r.values && r.values[k] != null ? r.values[k] : (cur[k] != null ? cur[k] : '');
      const detected = r.found && r.found[k] ? '<span class="pill" style="background:#3b82f622;color:#3b82f6">lu</span>' : '<span class="help">non détecté</span>';
      return `<label style="display:block;margin:.3rem 0">${lbl} ${detected}<br>
        <span class="help">actuel : <b data-cur="${k}">${cur[k] != null ? cur[k] : '—'}</b> →</span>
        <input data-f="${k}" type="number" step="0.5" value="${proposed}" style="width:120px"></label>`;
    }).join('');
    const src = (r.lines || []).length ? `<details style="margin-top:.4rem"><summary class="help">Voir les lignes lues</summary><pre style="white-space:pre-wrap;font-size:.75rem;color:#475569">${esc(r.lines.join('\n'))}</pre></details>` : '';
    const err = r.error ? `<div class="alert warn" style="margin:.3rem 0">Lecture partielle : ${esc(r.error)}</div>` : '';
    const curAddr = (_bullUsers.find((u) => u.id === r.matchedUserId) || {}).address || '';
    const addrDet = r.address ? '<span class="pill" style="background:#3b82f622;color:#3b82f6">lu</span>' : '<span class="help">non détecté</span>';
    return `<div class="card bull-card" data-i="${i}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <strong>📄 ${esc(r.fileName)}</strong> ${bullConfBadge(r.confidence)}
      </div>
      ${err}
      <div class="erp-row" style="margin:.5rem 0"><label>Salarié<br><select data-user style="min-width:220px">${userOpts(r.matchedUserId)}</select></label></div>
      <div class="grid cols-2">${rows}</div>
      <label style="display:block;margin:.4rem 0">🏠 Adresse postale (donnée perso — visible admin uniquement) ${addrDet}<br>
        <span class="help">actuelle : <b data-curaddr>${curAddr ? esc(curAddr) : '—'}</b></span>
        <input data-addr type="text" value="${esc(r.address || curAddr || '')}" placeholder="N° rue, code postal ville" style="width:100%"></label>
      ${src}
    </div>`;
  }).join('') + `<div style="margin-top:1rem"><button class="btn accent" id="bull-apply">✅ Valider et appliquer aux comptes</button></div>`;

  // Met à jour la colonne « actuel » quand on change le salarié.
  wrap.querySelectorAll('.bull-card').forEach((card) => {
    const sel = card.querySelector('[data-user]');
    sel.onchange = () => {
      const u = _bullUsers.find((x) => x.id === sel.value);
      const bal = (u && u.balances) || {};
      card.querySelectorAll('[data-cur]').forEach((sp) => { const k = sp.dataset.cur; sp.textContent = bal[k] != null ? bal[k] : '—'; });
      const ca = card.querySelector('[data-curaddr]'); if (ca) ca.textContent = (u && u.address) ? u.address : '—';
    };
  });
  wrap.querySelector('#bull-apply').onclick = bullApply;
}

async function bullApply() {
  const cards = [...document.querySelectorAll('.bull-card')];
  const items = [];
  for (const card of cards) {
    const userId = card.querySelector('[data-user]').value;
    if (!userId) continue;
    const it = { userId };
    card.querySelectorAll('[data-f]').forEach((inp) => { if (inp.value !== '') it[inp.dataset.f] = Number(inp.value); });
    const addr = card.querySelector('[data-addr]'); if (addr && addr.value.trim()) it.address = addr.value.trim();
    items.push(it);
  }
  if (!items.length) { toast('Associez au moins un bulletin à un salarié.', 'warn'); return; }
  if (!confirm(`Appliquer les compteurs à ${items.length} salarié(s) ? Les valeurs remplaceront leurs soldes actuels.`)) return;
  try {
    const { applied } = await api('POST', '/staff/payslips/apply', { items });
    toast(`Compteurs mis à jour pour ${applied.length} salarié(s).`, 'ok');
    await loadHours();
  } catch (e) { toast('Erreur : ' + e.message, 'err'); }
}

// Résumé : amplitudes réalisées par chauffeur, pour un mois sélectionnable
// (par défaut le mois le plus récent présent dans les données importées) +
// dernière semaine de ce mois.
let _hrResumeMonth = null;
function hoursResume(body) {
  const entries = _hours.entries, ampMax = _hours.amplitudeMax;
  if (!entries.length) { body.innerHTML = `<div class="alert info">Aucune heure saisie. Importez un rapport d'activité ou renseignez les amplitudes dans l'onglet « Saisie ».</div>`; return; }
  // Mois disponibles (les plus récents en premier).
  const months = Array.from(new Set(entries.map((e) => (e.date || '').slice(0, 7)).filter(Boolean))).sort().reverse();
  if (!_hrResumeMonth || !months.includes(_hrResumeMonth)) _hrResumeMonth = months[0];
  const refMonth = _hrResumeMonth;
  // Dernière semaine ISO présente dans ce mois.
  let wkStart = null;
  entries.forEach((e) => { if ((e.date || '').slice(0, 7) !== refMonth) return; const ws = iso(isoWeekStart(parseISO(e.date))); if (!wkStart || ws > wkStart) wkStart = ws; });
  // Agrège par chauffeur sur le mois sélectionné et sa dernière semaine.
  const byUser = {};
  entries.forEach((e) => {
    if ((e.date || '').slice(0, 7) !== refMonth) return;
    const u = byUser[e.userId] = byUser[e.userId] || { name: e.userName, week: { amp: 0, work: 0, pause: 0, days: 0, max: 0, over: 0 }, month: { amp: 0, work: 0, pause: 0, days: 0, max: 0, over: 0 } };
    const add = (acc) => { acc.amp += e.amplitude; acc.work += e.worked; acc.pause += Math.max(0, e.amplitude - e.worked); acc.days += 1; acc.max = Math.max(acc.max, e.amplitude); if (e.amplitude > ampMax) acc.over += 1; };
    add(u.month);
    if (iso(isoWeekStart(parseISO(e.date))) === wkStart) add(u.week);
  });
  const rows = Object.values(byUser).filter((u) => u.month.days > 0).sort((a, b) => b.month.amp - a.month.amp);
  const monthSel = `<label style="display:inline-flex;gap:.4rem;align-items:center;margin:0">Mois <select id="hr-resume-month" style="width:auto">${months.map((m) => `<option value="${m}" ${m === refMonth ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>`;
  if (!rows.length) { body.innerHTML = `<div style="margin-bottom:.6rem">${monthSel}</div><div class="alert info">Aucune heure pour ${esc(refMonth)}.</div>`; bindResumeMonth(body); return; }
  // Totaux flotte.
  const tWeekAmp = rows.reduce((s, u) => s + u.week.amp, 0), tMonthAmp = rows.reduce((s, u) => s + u.month.amp, 0);
  const tOver = rows.reduce((s, u) => s + u.month.over, 0);
  const tMonthPause = rows.reduce((s, u) => s + u.month.pause, 0);
  // Pastille « temps de pause » = présence hors travail (amplitude − travaillé),
  // avec sa part de l'amplitude (repère pour améliorer l'amplitude).
  const pausePill = (acc) => { if (!acc.days || acc.amp <= 0) return '—'; const pct = acc.pause / acc.amp * 100; return `<span class="pill ${pct >= 30 ? 'danger' : pct >= 20 ? 'warn' : 'ok'}">${hFmt(acc.pause)} · ${pct.toFixed(0)} %</span>`; };
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem">
      <h3 style="margin:0">Amplitudes — ${esc(refMonth)}</h3>${monthSel}
    </div>
    <div class="grid cols-4">
      <div class="stat"><div class="value" style="font-size:1.4rem">${hFmt(tWeekAmp)}</div><div class="label">Amplitude totale (dernière semaine)</div></div>
      <div class="stat"><div class="value" style="font-size:1.4rem">${hFmt(tMonthAmp)}</div><div class="label">Amplitude totale (mois)</div></div>
      <div class="stat ${tMonthAmp > 0 && tMonthPause / tMonthAmp >= 0.2 ? 'alt' : ''}"><div class="value" style="font-size:1.4rem">${hFmt(tMonthPause)}</div><div class="label">Pause totale (mois)${tMonthAmp > 0 ? ` · ${(tMonthPause / tMonthAmp * 100).toFixed(0)} %` : ''}</div></div>
      <div class="stat ${tOver ? 'alt' : ''}"><div class="value" style="font-size:1.4rem">${tOver}</div><div class="label">Dépassements (> ${ampMax}h)</div></div>
    </div>
    <div class="card"><h3>Amplitudes par chauffeur — dernière semaine du mois</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Chauffeur</th><th>Jours</th><th>Amplitude</th><th>Travaillé</th><th>Pause</th><th>Moy./jour</th><th>Max</th></tr></thead>
      <tbody>${rows.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td>${u.week.days}</td><td>${hFmt(u.week.amp)}</td><td>${hFmt(u.week.work)}</td><td>${pausePill(u.week)}</td><td>${u.week.days ? hFmt(u.week.amp / u.week.days) : '—'}</td><td>${u.week.days ? `<span class="pill ${u.week.max > ampMax ? 'danger' : u.week.max > ampMax - 1 ? 'warn' : 'ok'}">${hFmt(u.week.max)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card"><h3>Amplitudes par chauffeur — mois ${esc(refMonth)}</h3>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Chauffeur</th><th>Jours</th><th>Amplitude</th><th>Travaillé</th><th>Pause</th><th>Moy./jour</th><th>Max</th><th>Dépass.</th></tr></thead>
      <tbody>${rows.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td>${u.month.days}</td><td>${hFmt(u.month.amp)}</td><td>${hFmt(u.month.work)}</td><td>${pausePill(u.month)}</td><td>${hFmt(u.month.amp / u.month.days)}</td><td>${hFmt(u.month.max)}</td><td>${u.month.over ? `<span class="pill danger">${u.month.over}</span>` : '0'}</td></tr>`).join('')}</tbody></table></div>
      <p class="help">Amplitude = durée entre la prise et la fin de service (pauses comprises). Pause = présence hors travail (amplitude − travaillé) ; une part élevée (≥ 20 %) signale une amplitude à optimiser. Seuil d'alerte amplitude : ${ampMax}h.</p>
    </div>`;
  bindResumeMonth(body);
}
function bindResumeMonth(body) {
  const sel = body.querySelector('#hr-resume-month');
  if (sel) sel.onchange = () => { _hrResumeMonth = sel.value; hoursResume(body); };
}

function hoursSaisie(body) {
  const drivers = _hours.drivers;
  const recent = _hours.entries.slice(0, 50);
  const driverOpts = drivers.map((d) => `<option value="${d.id}">${esc(d.lastName)} ${esc(d.firstName)}${d.role !== 'employee' ? ' (' + roleLabel(d.role) + ')' : ''}</option>`).join('');
  body.innerHTML = `
    <div class="card"><h3>Saisir une journée</h3>
      <div class="grid2">
        <div><label>Chauffeur</label><select id="wh-user">${driverOpts}</select></div>
        <div><label>Date</label><input id="wh-date" type="date" value="${iso(new Date())}"></div>
        <div><label>Prise de service</label><input id="wh-start" type="time" value="08:00"></div>
        <div><label>Fin de service</label><input id="wh-end" type="time" value="17:00"></div>
        <div><label>Pause (minutes)</label><input id="wh-break" type="number" min="0" value="45"></div>
      </div>
      <div style="margin-top:.6rem"><button class="btn accent" id="wh-save">Enregistrer</button> <span class="help" id="wh-preview"></span></div>
      <p class="help">L'amplitude et le temps de travail sont calculés automatiquement. Une saisie par chauffeur et par jour (remplace l'existante).</p>
    </div>
    <div class="card"><h3>Saisies récentes</h3>
      ${recent.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Chauffeur</th><th>Service</th><th>Pause</th><th>Amplitude</th><th>Travaillé</th><th></th></tr></thead>
      <tbody>${recent.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.userName)}</td><td>${esc(e.start)}–${esc(e.end)}</td><td>${e.breakMin} min</td><td><span class="pill ${e.amplitude > _hours.amplitudeMax ? 'danger' : ''}">${hFmt(e.amplitude)}</span></td><td>${hFmt(e.worked)}</td><td><button class="btn ghost sm" data-whdel="${e.id}">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucune saisie.</p>'}
    </div>`;
  const prev = () => {
    const s = document.getElementById('wh-start').value, en = document.getElementById('wh-end').value, br = +document.getElementById('wh-break').value;
    const sm = hmToMinClient(s), em = hmToMinClient(en);
    if (sm == null || em == null) { document.getElementById('wh-preview').textContent = ''; return; }
    let amp = em - sm; if (amp < 0) amp += 1440; const work = Math.max(0, amp - br);
    document.getElementById('wh-preview').textContent = `→ amplitude ${hFmt(amp / 60)} · travaillé ${hFmt(work / 60)}`;
  };
  ['wh-start', 'wh-end', 'wh-break'].forEach((id) => document.getElementById(id).oninput = prev); prev();
  document.getElementById('wh-save').onclick = async () => {
    const payload = { userId: document.getElementById('wh-user').value, date: document.getElementById('wh-date').value, start: document.getElementById('wh-start').value, end: document.getElementById('wh-end').value, breakMin: document.getElementById('wh-break').value };
    try { await api('POST', '/staff/work-hours', payload); toast('Heures enregistrées.', 'ok'); await loadHours(); hrTab('saisie'); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-whdel]').forEach((b) => b.onclick = async () => { try { await api('DELETE', '/staff/work-hours/' + b.dataset.whdel); await loadHours(); hrTab('saisie'); } catch (e) { toast(e.message, 'err'); } });
}
function hmToMinClient(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? (Number(m[1]) * 60 + Number(m[2])) : null; }

/* --- Heures supplémentaires : 25%/50%, paiement, transmission récupération --- */
function isoWeekKey(d) { const x = isoWeekStart(d); return iso(x); }
function getSettlement(userId, month) { return (_hours.settlements || []).find((s) => s.userId === userId && s.month === month) || { paidHours: 0, transmittedEquiv: 0, realizedAdj: 0, overpayApplied: 0 }; }
// Répartit des HSUP brutes en 25% (8 premières) et 50% (au-delà).
function splitHsup(h) { const h25 = Math.min(Math.max(0, h), 8); const h50 = Math.max(0, h - 8); return { h25, h50 }; }
// Équivalent récupération (heures de repos majorées) : 1h25 et 1h30.
function equivRecup(h25, h50) { return Math.round((h25 * 1.25 + h50 * 1.5) * 100) / 100; }

function hoursHsup(body) {
  const base = _hours.hsupBase || 35;
  // Soldes par salarié (compteurs CP / CP N-1 / RCC / Récup) pour affichage.
  const balById = {};
  (_hours.drivers || []).forEach((d) => { balById[d.id] = d.balances || {}; });
  const byUser = {};
  _hours.entries.forEach((e) => { (byUser[e.userId] = byUser[e.userId] || { name: e.userName, days: [] }).days.push(e); });
  const ids = Object.keys(byUser);
  if (!ids.length) { body.innerHTML = `<div class="alert info">Aucune donnée. Importez un rapport d'activité ou saisissez des heures.</div>`; return; }

  const cards = ids.map((id) => {
    const u = byUser[id]; u.days.sort((a, b) => a.date.localeCompare(b.date));
    // Semaines -> HSUP -> répartition 25/50 par semaine.
    const weeks = {};
    u.days.forEach((e) => { const k = isoWeekKey(parseISO(e.date)); (weeks[k] = weeks[k] || { worked: 0, days: 0, ids: [] }); weeks[k].worked += e.worked || 0; weeks[k].days += 1; if (e.id) weeks[k].ids.push(e.id); });
    const weekRows = Object.keys(weeks).sort().map((k) => { const w = weeks[k]; const hsup = Math.max(0, w.worked - base); const sp = splitHsup(hsup); return { k, worked: w.worked, days: w.days, hsup, h25: sp.h25, h50: sp.h50, ids: w.ids }; });
    // Agrégat mensuel (25/50 sommés sur les semaines du mois).
    const months = {};
    weekRows.forEach((w) => { const m = w.k.slice(0, 7); (months[m] = months[m] || { worked: 0, h25: 0, h50: 0 }); months[m].worked += w.worked; months[m].h25 += w.h25; months[m].h50 += w.h50; });
    const monthKeys = Object.keys(months).sort();
    // Calcul des restants par mois (après paiement) + transmission déjà faite.
    // On NE transmet et NE compte dans le « Reste dû » que les HSUP réalisées
    // (heures brutes). L'équivalence en récupération majorée n'est qu'indicative
    // (à titre informatif pour la direction).
    let totRemDue = 0, totHsup = 0, totRemEquivInfo = 0;
    const monthCalc = monthKeys.map((m) => {
      const mo = months[m]; const hsup = mo.h25 + mo.h50; totHsup += hsup;
      const st = getSettlement(id, m);
      const paid = st.paidHours || 0;
      const transmitted = st.transmittedEquiv || 0; // heures BRUTES déjà transmises au compteur
      // Paiement (heures brutes) imputé d'abord sur le 25% puis le 50%.
      const remH25 = Math.max(0, mo.h25 - paid);
      const remH50 = Math.max(0, mo.h50 - Math.max(0, paid - mo.h25));
      // Transmission déjà faite (heures brutes) imputée d'abord sur le 25% puis le 50%.
      const dueH25 = Math.max(0, remH25 - transmitted);
      const dueH50 = Math.max(0, remH50 - Math.max(0, transmitted - remH25));
      const remDue = Math.round((dueH25 + dueH50) * 100) / 100; // HSUP réalisées restant dues (brutes)
      const equipTot = equivRecup(mo.h25, mo.h50);              // info : équiv. récup. du mois
      const remEquivInfo = equivRecup(dueH25, dueH50);          // info : équiv. récup. du reste dû
      const realizedAdj = st.realizedAdj || 0;                  // correction manuelle du réalisé
      const effRealized = Math.round((hsup + realizedAdj) * 100) / 100; // réalisé corrigé (affiché)
      const overpay = Math.max(0, Math.round((paid - hsup) * 100) / 100); // trop-payé (payé > réalisé)
      totRemDue += remDue; totRemEquivInfo += remEquivInfo;
      return { m, ...mo, hsup, equipTot, paid, transmitted, remDue, remEquivInfo, realizedAdj, effRealized, overpay };
    });
    const open = !!_vehOpen['hsup_' + id];
    const jourOpen = !!_vehOpen['jour_' + id];
    const semOpen = !!_vehOpen['sem_' + id];
    const detOpen = !!_vehOpen['det_' + id];
    const totWorked = u.days.reduce((s, e) => s + (e.worked || 0), 0);
    const totPaid = monthCalc.reduce((s, c) => s + (c.paid || 0), 0);
    const bal = balById[id] || {};
    const balLine = `CP ${(bal.congesN || 0)} j · CP N-1 ${(bal.congesN1 || 0)} j · RCC ${hFmt(bal.rcc || 0)} · Récup ${hFmt(bal.heuresSupp || 0)}`;
    const rows = monthCalc.map((c) => `<tr>
      <td>${esc(c.m)}</td><td>${hFmt(c.worked)}</td>
      <td>${c.h25 > 0 ? hFmt(c.h25) : '—'}</td><td>${c.h50 > 0 ? hFmt(c.h50) : '—'}</td>
      <td><input class="hsup-realized" data-uid="${id}" data-month="${c.m}" data-computed="${c.hsup}" data-old="${c.realizedAdj}" type="number" step="0.5" min="0" value="${c.effRealized}" style="width:74px" title="Réalisé corrigé : l'écart avec le réalisé importé (${hFmt(c.hsup)}) est transmis au compteur du salarié">${c.realizedAdj ? `<div class="help">ajust. ${c.realizedAdj > 0 ? '+' : ''}${hFmt(c.realizedAdj)}</div>` : ''}</td>
      <td><span class="help">${hFmt(c.equipTot)} (${(c.equipTot / HPERDAY).toFixed(2)} j)</span></td>
      <td><input class="hsup-paid" data-uid="${id}" data-month="${c.m}" data-computed="${c.hsup}" type="number" step="0.5" min="0" value="${c.paid}" style="width:70px">${c.overpay > 0 ? `<div class="help" style="color:var(--danger)">trop-payé ${hFmt(c.overpay)} → −${hFmt(c.overpay)} au stock</div>` : ''}</td>
      <td><input class="hsup-transmitted" data-uid="${id}" data-month="${c.m}" data-old="${c.transmitted}" type="number" step="0.5" min="0" value="${c.transmitted}" style="width:70px" title="Modifie ce qui a déjà été transmis au compteur du salarié (ajuste son solde)"></td>
      <td><strong class="${c.remDue > 0 ? 'warn' : 'pos'}">${hFmt(c.remDue)}</strong>${c.remDue > 0 ? ` <span class="help">(≈ ${(c.remEquivInfo / HPERDAY).toFixed(2)} j récup.)</span>` : ''}</td>
      <td>${c.remDue > 0 ? `<button class="btn ok sm" data-transmit="${id}" data-month="${c.m}" data-eq="${c.remDue}">Transmettre</button>` : '<span class="pill ok">réglé</span>'}</td>
    </tr>`).join('');
    return `<div class="card veh-card">
      <div class="veh-card-head" data-toggle="hsup_${id}">
        <span class="veh-caret">${open ? '▾' : '▸'}</span>
        <strong>${esc(u.name)}</strong>
        <span class="help" style="margin-left:.5rem">${balLine}</span>
        <span style="margin-left:auto;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center"><span class="pill">${u.days.length} j · ${hFmt(totWorked)}</span><span class="pill ${totHsup > 0 ? 'warn' : 'ok'}">HSUP : ${hFmt(totHsup)}</span><span class="pill ${totRemDue > 0 ? 'danger' : 'ok'}">Reste dû : ${hFmt(totRemDue)}<span class="help" style="opacity:.85"> (≈ ${(totRemEquivInfo / HPERDAY).toFixed(1)} j récup.)</span></span></span>
      </div>
      ${open ? `<div class="veh-card-body">
        <h4 style="margin:.4rem 0 .3rem">Synthèse du salarié</h4>
        ${synthSalarie(u.days, base, id)}
        <h4 style="margin:.7rem 0 .3rem">Récapitulatif mois par mois</h4>
        <div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Travaillé</th><th>HSUP 25%</th><th>HSUP 50%</th><th>Réalisé HSUP (h)</th><th>Équiv. récup. <span class="help">(info)</span></th><th>Déjà payé (h)</th><th>Transmis (h)</th><th>Reste dû (HSUP)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="help" style="margin:.3rem 0">« Réalisé HSUP », « Déjà payé » et « Transmis » sont modifiables directement (mettez 0 pour annuler). Corriger le <strong>Réalisé</strong> transmet l'écart au compteur du salarié ; <strong>trop-payer</strong> un mois (payé &gt; réalisé) décrémente son stock d'HSUP d'autant ; modifier « Transmis » ajuste aussi son compteur.</p>
        <div class="alert ${(bal.heuresSupp || 0) > 0 ? 'info' : ''}" style="margin:.3rem 0">Compteur salarié (Récup / heures sup., chiffre réel après tous les calculs) : <strong>${hFmt(bal.heuresSupp || 0)}</strong> ≈ <strong>${((bal.heuresSupp || 0) / HPERDAY).toFixed(2)} jour(s)</strong> de récupération.</div>
        <div class="alert info" style="margin-top:.5rem">
          <strong>Reste à transmettre à ${esc(u.name)} : ${hFmt(totRemDue)}</strong> d'heures supplémentaires réalisées (heures brutes transmises au compteur du salarié).<br>
          <span class="help">Équivalence en récupération (à titre informatif, pour la direction) : ajustements légaux +25% de la 36ᵉ à la 43ᵉ h, +50% au-delà ; 1 h sup. = 1 h + majoration de repos ; ${HPERDAY} h = 1 jour. Soit ≈ <strong>${(totRemEquivInfo / HPERDAY).toFixed(2)} jour(s)</strong> de récupération.</span>
        </div>
        <div style="margin:.5rem 0"><button class="btn ok" data-transmitall="${id}">Transmettre tout le reste dû au compteur de ${esc(u.name)}</button></div>
        <h4 style="margin:.7rem 0 .3rem;cursor:pointer" data-toggle="sem_${id}"><span class="veh-caret">${semOpen ? '▾' : '▸'}</span> Semaine par semaine <span class="help">— supprimez une semaine mal attribuée</span></h4>
        ${semOpen ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Semaine du</th><th>Jours</th><th>Travaillé</th><th>HSUP</th><th>25%</th><th>50%</th><th></th></tr></thead>
          <tbody>${weekRows.map((w) => `<tr class="${w.hsup > 0 ? 'lvl-soon' : ''}"><td>${fmtDate(w.k)}</td><td>${w.days}</td><td>${hFmt(w.worked)}</td><td>${w.hsup > 0 ? hFmt(w.hsup) : '—'}</td><td>${w.h25 > 0 ? hFmt(w.h25) : '—'}</td><td>${w.h50 > 0 ? hFmt(w.h50) : '—'}</td><td>${w.ids && w.ids.length ? `<button class="btn ghost sm" data-delweek="${w.ids.join(',')}" data-uid="${id}" title="Supprimer la semaine">🗑</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <h4 style="margin:.7rem 0 .3rem;cursor:pointer" data-toggle="det_${id}"><span class="veh-caret">${detOpen ? '▾' : '▸'}</span> Détail par mois (indemnités & estimation de salaire) <span class="help">— ${hFmt(totPaid)} payé(s) saisi(s)</span></h4>
        ${detOpen ? monthsDetailHTML(u.days, base, id) : ''}
        <h4 style="margin:.7rem 0 .3rem;cursor:pointer" data-toggle="jour_${id}"><span class="veh-caret">${jourOpen ? '▾' : '▸'}</span> Jour par jour <span class="help">— supprimez une saisie mal attribuée</span></h4>
        ${jourOpen ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Date</th><th>Service</th><th>Travaillé</th><th>Nuit</th><th>Ampl.</th><th>R.midi</th><th>R.soir</th><th>Casse-cr.</th><th>Découch.</th><th>Km</th><th>Mission</th><th>Absence</th><th></th></tr></thead>
          <tbody>${u.days.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${e.start && e.end ? esc(e.start) + '–' + esc(e.end) : '—'}</td><td>${hFmt(e.worked)}</td><td>${e.nightHours ? hFmt(e.nightHours) : '—'}</td><td>${hFmt(e.amplitude)}</td><td>${e.mealMidi || '—'}</td><td>${e.mealSoir || '—'}</td><td>${e.casseCroute || '—'}</td><td>${e.decoucher || '—'}</td><td>${e.km || '—'}</td><td>${esc(e.missions || '—')}</td><td>${e.absence ? hFmt(e.absence) + (e.motif ? ' (' + esc(e.motif) + ')' : '') : '—'}</td><td>${e.id ? `<button class="btn ghost sm" data-delday="${e.id}" data-uid="${id}" title="Supprimer cette saisie">🗑</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div style="margin-top:.6rem"><button class="btn ghost" data-exportcsv="${id}">⬇️ Exporter le tableau (CSV)</button></div>
      </div>` : ''}
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="card"><h3>Heures supplémentaires</h3>
      <div style="display:flex;gap:.5rem;align-items:end;flex-wrap:wrap">
        <div><label>Base hebdomadaire (h au-delà = HSUP)</label><input id="hsup-base" type="number" step="0.5" min="0" value="${base}" style="width:120px"></div>
        <button class="btn ghost" id="hsup-recalc">Enregistrer la base & recalculer</button>
      </div>
      <p class="help">HSUP calculées par semaine (au-delà de la base, 35 h légal), réparties en <strong>+25%</strong> (8 premières heures) et <strong>+50%</strong>. « Déjà payé » réduit le reste dû ; « Transmettre » crédite le compteur Récupération du salarié avec le <strong>nombre d'heures supplémentaires réalisées</strong> qui lui sont dues. L'<em>Équiv. récup.</em> (majoration légale) est affichée uniquement à titre informatif pour la direction.</p>
    </div>
    ${cards}`;
  document.getElementById('hsup-recalc').onclick = async () => { try { await api('PUT', '/staff/hsup-base', { base: document.getElementById('hsup-base').value }); await loadHours(); hrTab('hsup'); } catch (e) { toast(e.message, 'err'); } };
  body.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = () => { const id = b.dataset.toggle; _vehOpen[id] = !_vehOpen[id]; hoursHsup(body); });
  body.querySelectorAll('.hsup-paid').forEach((inp) => inp.onchange = async () => {
    try { const r = await api('PUT', '/staff/hsup-settlement', { userId: inp.dataset.uid, month: inp.dataset.month, paidHours: inp.value, computedRealized: Number(inp.dataset.computed) || 0 }); if (r.newBalance != null) toast(`Enregistré. Solde récup. : ${hFmt(r.newBalance)}.`, 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  // Correction du réalisé d'un mois : l'écart est transmis au compteur du salarié.
  body.querySelectorAll('.hsup-realized').forEach((inp) => inp.onchange = async () => {
    const computed = Number(inp.dataset.computed) || 0, oldAdj = Number(inp.dataset.old) || 0;
    const entered = Number(inp.value) || 0, newAdj = Math.round((entered - computed) * 100) / 100;
    if (newAdj === oldAdj) return;
    const d = Math.round((newAdj - oldAdj) * 100) / 100;
    if (!confirm(`Corriger le réalisé de ${hFmt(computed + oldAdj)} à ${hFmt(entered)} ? L'écart (${d >= 0 ? '+' : ''}${hFmt(d)}) sera transmis au compteur du salarié.`)) { inp.value = computed + oldAdj; return; }
    try { const r = await api('PUT', '/staff/hsup-settlement', { userId: inp.dataset.uid, month: inp.dataset.month, realizedAdj: newAdj, computedRealized: computed }); toast(`Réalisé corrigé. Nouveau solde récup. : ${hFmt(r.newBalance)}.`, 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); inp.value = computed + oldAdj; }
  });
  // Correction du nombre d'heures déjà transmises (ajuste le solde Récup. du salarié).
  body.querySelectorAll('.hsup-transmitted').forEach((inp) => inp.onchange = async () => {
    const oldV = Number(inp.dataset.old) || 0, newV = Number(inp.value) || 0;
    if (newV === oldV) return;
    if (!confirm(`Corriger le transmis de ${hFmt(oldV)} à ${hFmt(newV)} ? Le compteur Récupération du salarié sera ajusté de ${newV - oldV >= 0 ? '+' : ''}${hFmt(newV - oldV)}.`)) { inp.value = oldV; return; }
    try { const r = await api('PUT', '/staff/hsup/transmitted', { userId: inp.dataset.uid, month: inp.dataset.month, transmittedHours: newV }); toast(`Transmis corrigé. Nouveau solde récup. : ${hFmt(r.newBalance)}.`, 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); inp.value = oldV; }
  });
  body.querySelectorAll('[data-transmit]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Transmettre ${hFmt(+b.dataset.eq)} d'heures supplémentaires au compteur du salarié ?`)) return;
    try { const r = await api('POST', '/staff/hsup/transmit', { userId: b.dataset.transmit, month: b.dataset.month, equivHours: b.dataset.eq }); toast(`Transmis. Nouveau solde récup. : ${hFmt(r.newBalance)}.`, 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-transmitall]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.transmitall;
    const btns = Array.from(body.querySelectorAll(`[data-transmit="${id}"]`));
    if (!btns.length) { toast('Rien à transmettre.', 'info'); return; }
    if (!confirm('Transmettre tout le reste dû de ce salarié à son compteur de récupération ?')) return;
    try { for (const bt of btns) await api('POST', '/staff/hsup/transmit', { userId: id, month: bt.dataset.month, equivHours: bt.dataset.eq }); toast('Récupération transmise.', 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-exportcsv]').forEach((b) => b.onclick = () => exportHoursCSV(byUser[b.dataset.exportcsv], _hours.hsupBase || 35));
  // Option « payer les HSUP 25% jusqu'à 32 h » (recalcule la projection).
  body.querySelectorAll('.hs25-32').forEach((c) => c.onchange = () => { _hs25To32[c.dataset.uid] = c.checked; hoursHsup(body); });
  // Enregistrement des paramètres de paie par salarié.
  body.querySelectorAll('[data-savesal]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.savesal;
    const params = {};
    body.querySelectorAll(`.salary-param[data-uid="${id}"]`).forEach((inp) => { params[inp.dataset.key] = inp.value; });
    try { await api('PUT', '/staff/salary-params', { userId: id, params }); toast('Paramètres de paie enregistrés.', 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  // Suppression d'une saisie (journée) mal attribuée.
  body.querySelectorAll('[data-delday]').forEach((b) => b.onclick = async () => {
    if (!confirm('Supprimer définitivement cette saisie ?')) return;
    try { await api('DELETE', `/staff/work-hours/${b.dataset.delday}`); toast('Saisie supprimée.', 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  // Suppression de toutes les saisies d'une semaine (semaine mal attribuée).
  body.querySelectorAll('[data-delweek]').forEach((b) => b.onclick = async () => {
    const ids = (b.dataset.delweek || '').split(',').filter(Boolean);
    if (!ids.length) return;
    if (!confirm(`Supprimer les ${ids.length} saisie(s) de cette semaine ?`)) return;
    try { for (const id of ids) await api('DELETE', `/staff/work-hours/${id}`); toast('Semaine supprimée.', 'ok'); await loadHours(); hoursHsup(body); }
    catch (e) { toast(e.message, 'err'); }
  });
}

// Paramètres de paie par défaut (calés sur un bulletin Chauffeur-Livreur réel).
// Paramètres calés sur les bulletins réels ICS (mai 2026) : base 151,67 h ×
// 12,09 €/h = 1 833,69 € ; HSUP 25 % ; majoration nuit 2,486 €/h ; cotisations
// salariales ≈ 23,04 % avec exonération HS ≈ 11,31 % (net avant IR à ≈ 1 €).
const SAL_DEFAULTS = { tauxHoraire: 12.09, baseMois: 151.67, cotisPct: 23.04, exoHsPct: 11.31, panierMidi: 16.36, panierSoir: 16.36, casseCroute: 0, nuitParH: 2.49, decoucher: 0, pasPct: 0 };
// Option « payer les HSUP 25% jusqu'à 32 h » (au lieu de 22 h), par salarié.
let _hs25To32 = {};
function getSalParams(id) { const o = (_hours.salaryParams || {})[id] || {}; return Object.assign({}, SAL_DEFAULTS, o); }

// Agrégats mensuels d'un salarié : heures (avec répartition HSUP 25/50 calculée
// par semaine au-delà de la base) + indemnités/événements. Renvoie un tableau
// trié par mois croissant.
function monthlyAgg(days, base) {
  base = base || 35;
  const m = {};
  const bucket = (k) => ({ key: k, worked: 0, days: 0, h25: 0, h50: 0, hsup: 0, night: 0, midi: 0, soir: 0, casse: 0, dec: 0, km: 0, abs: 0 });
  days.forEach((e) => {
    const k = (e.date || '').slice(0, 7); if (!k) return;
    const o = m[k] = m[k] || bucket(k);
    o.worked += e.worked || 0; o.days += 1; o.night += e.nightHours || 0;
    o.midi += e.mealMidi || 0; o.soir += e.mealSoir || 0; o.casse += e.casseCroute || 0;
    o.dec += e.decoucher || 0; o.km += e.km || 0; o.abs += e.absence || 0;
  });
  const weeks = {};
  days.forEach((e) => { const k = isoWeekKey(parseISO(e.date)); weeks[k] = (weeks[k] || 0) + (e.worked || 0); });
  Object.keys(weeks).forEach((wk) => { const mk = wk.slice(0, 7); const o = m[mk] = m[mk] || bucket(mk); const hs = Math.max(0, weeks[wk] - base); const sp = splitHsup(hs); o.h25 += sp.h25; o.h50 += sp.h50; o.hsup += hs; });
  return Object.keys(m).sort().map((k) => m[k]);
}

// Estimation du salaire net mensuel à partir des heures du mois et des
// paramètres de paie du salarié (calage ≈ bulletin réel).
// Règles de paie : les HSUP à 50% ne sont PAS payées (récupérées) ; les HSUP à
// 25% sont payées dans la limite d'un plafond (22 h de base, 32 h en option).
const HS25_BASE = 22, HS25_MAX = 32;
function estimSalaire(mo, p, hs25Cap) {
  const cap = hs25Cap || HS25_BASE;
  const base = p.baseMois * p.tauxHoraire;
  const paidH25 = Math.min(mo.h25, cap);        // HSUP 25% payées (plafonnées)
  const over22 = Math.max(0, mo.h25 - HS25_BASE); // dépassement au-delà de 22 h
  const hs25 = paidH25 * p.tauxHoraire * 1.25;
  const hs50 = 0;                                // récupérées, non payées
  const nuit = (mo.night || 0) * p.nuitParH;
  const brut = base + hs25 + nuit;
  const hsTot = hs25;                            // exonération HS sur la part payée
  const cotis = Math.max(0, brut * p.cotisPct / 100 - hsTot * p.exoHsPct / 100);
  const netImpo = brut - cotis;
  const indem = (mo.midi || 0) * p.panierMidi + (mo.soir || 0) * p.panierSoir + (mo.casse || 0) * p.casseCroute + (mo.dec || 0) * p.decoucher;
  const pas = netImpo * p.pasPct / 100;
  const net = netImpo + indem - pas;
  return { base, hs25, hs50, nuit, brut, cotis, netImpo, indem, pas, net, paidH25, over22, cap };
}

// Formulaire (repliable) des paramètres de paie, éditable et enregistrable.
function salaryParamsForm(id, p) {
  const open = !!_vehOpen['sal_' + id];
  const f = (key, lbl, step) => `<div style="display:flex;flex-direction:column;gap:.15rem"><label class="help" style="margin:0">${lbl}</label><input class="salary-param" data-uid="${id}" data-key="${key}" type="number" step="${step || '0.01'}" min="0" value="${p[key]}" style="width:120px"></div>`;
  return `<div class="card" style="margin:.2rem 0 .5rem">
    <div class="veh-card-head" data-toggle="sal_${id}" style="cursor:pointer"><span class="veh-caret">${open ? '▾' : '▸'}</span><strong>Paramètres de paie</strong><span class="help" style="margin-left:auto">taux horaire, base mensualisée, cotisations, paniers…</span></div>
    ${open ? `<div style="display:flex;gap:.7rem;flex-wrap:wrap;margin-top:.6rem">
      ${f('tauxHoraire', 'Taux horaire brut (€)')}
      ${f('baseMois', 'Base mensualisée (h)')}
      ${f('cotisPct', 'Cotisations salariales (%)')}
      ${f('exoHsPct', 'Exonération HS salariale (%)')}
      ${f('panierMidi', 'Panier repas midi (€)')}
      ${f('panierSoir', 'Panier repas soir (€)')}
      ${f('casseCroute', 'Casse-croûte (€)')}
      ${f('nuitParH', 'Majoration nuit (€/h)')}
      ${f('decoucher', 'Découcher (€)')}
      ${f('pasPct', 'Prélèvement à la source (%)')}
    </div>
    <div style="margin-top:.6rem"><button class="btn accent sm" data-savesal="${id}">Enregistrer les paramètres</button></div>
    <p class="help" style="margin-top:.3rem">Estimation <strong>indicative</strong> du net (≈ bulletin de paie). Base mensualisée 151,67 h. Ajustez selon le bulletin réel du salarié.</p>` : ''}
  </div>`;
}

// Synthèse d'un salarié : paramètres de paie + comparatif mois en cours / mois
// précédent (avec estimation du net) + tendance sur le trimestre glissant.
function synthSalarie(days, base, id) {
  const months = monthlyAgg(days, base);
  if (!months.length) return '<p class="help">—</p>';
  const p = getSalParams(id);
  const to32 = !!_hs25To32[id];
  const cap = to32 ? HS25_MAX : HS25_BASE;
  const cur = months[months.length - 1];
  const prev = months.length > 1 ? months[months.length - 2] : null;
  const eCur = estimSalaire(cur, p, cap);
  const ePrev = prev ? estimSalaire(prev, p, cap) : null;
  const line = (lbl, val, delta) => `<div style="display:flex;justify-content:space-between;gap:.6rem;padding:.14rem 0;border-bottom:1px solid var(--border,#eee)"><span class="help">${lbl}</span><span style="text-align:right">${val} ${delta || ''}</span></div>`;
  const dh = (c, pv) => pv == null ? '' : (Math.abs(c - pv) < 0.01 ? '<span class="help">=</span>' : `<span class="help">(${c - pv > 0 ? '+' : '−'}${hFmt(Math.abs(c - pv))})</span>`);
  const di = (c, pv, suf) => pv == null ? '' : (!(c - pv) ? '<span class="help">=</span>' : `<span class="help">(${c - pv > 0 ? '+' : '−'}${Math.abs(c - pv)}${suf || ''})</span>`);
  const de = (c, pv) => pv == null ? '' : (Math.abs(c - pv) < 0.01 ? '<span class="help">=</span>' : `<span class="${c - pv > 0 ? 'pos' : 'warn'}" style="font-size:.85em">(${c - pv > 0 ? '+' : '−'}${eur(Math.abs(c - pv))})</span>`);
  const panel = (mo, est, pv, pvEst, title, accent) => {
    const panierVal = (mo.midi || 0) * p.panierMidi + (mo.soir || 0) * p.panierSoir;
    const over22 = Math.max(0, mo.h25 - HS25_BASE);
    const h25Disp = hFmt(Math.min(mo.h25, HS25_BASE)) + (over22 > 0 ? ` <span class="warn">(+${hFmt(over22)} > 22h${to32 ? ', payées' : ''})</span>` : '');
    return `<div class="card zoom-hover" style="flex:1;min-width:270px;${accent ? 'border:1px solid var(--accent,#6b7cff)' : ''}">
    <h4 style="margin:.1rem 0 .5rem">${title} — <span style="color:var(--accent,#6b7cff)">${esc(mo.key)}</span></h4>
    ${line('Jours travaillés', mo.days, pv ? di(mo.days, pv.days) : '')}
    ${line('Heures travaillées <span class="help">(base mensualisée 151,67 h)</span>', `<strong>${hFmt(mo.worked)}</strong>`, pv ? dh(mo.worked, pv.worked) : '')}
    ${line('HSUP 25% payées', h25Disp, '')}
    ${line('HSUP 50% (récupérées)', mo.h50 ? `${hFmt(mo.h50)} <span class="help">non payées</span>` : '—', '')}
    ${line('Heures de nuit', mo.night ? hFmt(mo.night) : '—', pv ? dh(mo.night, pv.night) : '')}
    ${line('Paniers midi / soir', `${mo.midi || 0} / ${mo.soir || 0} <span class="help">(${eur(panierVal)})</span>`, '')}
    ${line('Casse-croûte', mo.casse || 0, pv ? di(mo.casse || 0, pv.casse || 0) : '')}
    ${line('Découcher', mo.dec || 0, pv ? di(mo.dec || 0, pv.dec || 0) : '')}
    ${line('Kilomètres', (mo.km || 0).toLocaleString('fr-FR'), pv ? di(mo.km || 0, pv.km || 0, ' km') : '')}
    ${line('Absences', mo.abs ? hFmt(mo.abs) : '—', '')}
    <div style="border-top:2px solid var(--border,#ddd);margin-top:.35rem;padding-top:.35rem">
      ${line('Salaire de base <span class="help">(151,67 h mensualisées)</span>', eur(est.base), '')}
      ${line('Salaire brut estimé', eur(est.brut), pv ? de(est.brut, pvEst.brut) : '')}
      ${line('Cotisations salariales', '− ' + eur(est.cotis), '')}
      ${line('Indemnités (non soumis)', eur(est.indem), '')}
      ${line('Net estimé à payer', `<strong style="font-size:1.1em">${eur(est.net)}</strong>`, pv ? de(est.net, pvEst.net) : '')}
    </div>
  </div>`;
  };
  // Tendance trimestre glissant (3 derniers mois).
  const win = months.slice(-3);
  const totW = win.reduce((s, o) => s + o.worked, 0);
  const totH = win.reduce((s, o) => s + o.hsup, 0);
  const avgW = totW / win.length;
  const lastW = win[win.length - 1].worked, firstW = win[0].worked;
  const diffAvg = avgW ? Math.round(((lastW - avgW) / avgW) * 100) : 0;
  const diffFirst = firstW ? Math.round(((lastW - firstW) / firstW) * 100) : 0;
  const verdict = diffAvg > 2 ? 'plus' : (diffAvg < -2 ? 'moins' : 'autant');
  const vcls = diffAvg > 2 ? 'warn' : (diffAvg < -2 ? 'pos' : '');
  const allW = months.map((o) => ({ l: o.key.slice(2), v: o.worked }));
  const maxW = Math.max(1, ...allW.map((i) => i.v));
  const bars = `<div class="bars">${allW.map((i) => { const h = Math.round((i.v / maxW) * 100); const isCur = i.l === cur.key.slice(2); return `<div class="bar-col"><div class="bar-wrap"><div class="bar ${isCur ? 'pos' : ''}" style="height:${h}%;${isCur ? '' : 'background:var(--accent,#6b7cff);opacity:.5'}" title="${hFmt(i.v)}"></div></div><div class="bar-lbl">${esc(i.l)}</div><div class="bar-val">${hFmt(i.v)}</div></div>`; }).join('')}</div>`;
  const arrow = (pct) => pct > 2 ? `<span class="warn">▲ +${pct}%</span>` : (pct < -2 ? `<span class="pos">▼ ${pct}%</span>` : '<span class="help">≈</span>');
  return `
    <h4 style="margin:.5rem 0 .3rem">Comparatif mensuel</h4>
    <p class="help" style="margin:0 0 .4rem">Projection : HSUP 50% <strong>non payées</strong> (récupérées) ; HSUP 25% payées jusqu'à ${to32 ? '32' : '22'} h ; base mensualisée 151,67 h.</p>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap">
      ${panel(cur, eCur, prev, ePrev, 'Estimation de la période en cours', true)}
      ${prev ? panel(prev, ePrev, null, null, 'Estimation du mois précédent', false) : '<div class="card" style="flex:1;min-width:270px;display:flex;align-items:center;justify-content:center"><span class="help">Pas de mois précédent à comparer.</span></div>'}
    </div>
    <label style="display:inline-flex;gap:.4rem;align-items:center;font-weight:400;cursor:pointer;margin:.5rem 0">
      <input type="checkbox" class="hs25-32" data-uid="${id}" ${to32 ? 'checked' : ''} style="width:auto">
      <span style="margin:0">Payer les HSUP 25% jusqu'à <strong>32 h</strong> (au lieu de 22 h)</span>
    </label>
    ${salaryParamsForm(id, p)}
    <h4 style="margin:.7rem 0 .3rem">Tendance sur le trimestre glissant (${win.length} dernier(s) mois)</h4>
    <div class="table-wrap"><table class="veh-table"><thead><tr><th>Mois</th><th>Jours</th><th>Travaillé</th><th>Évol.</th><th>HSUP</th><th>Nuit</th><th>Paniers (m/s)</th><th>Km</th></tr></thead>
      <tbody>${win.map((o, i) => { const prevW = i > 0 ? win[i - 1].worked : null; const pct = prevW ? Math.round(((o.worked - prevW) / prevW) * 100) : null; return `<tr><td>${esc(o.key)}</td><td>${o.days}</td><td>${hFmt(o.worked)}</td><td>${pct === null ? '—' : arrow(pct)}</td><td>${o.hsup ? hFmt(o.hsup) : '—'}</td><td>${o.night ? hFmt(o.night) : '—'}</td><td>${(o.midi || 0)}/${(o.soir || 0)}</td><td>${o.km ? o.km.toLocaleString('fr-FR') : '—'}</td></tr>`; }).join('')}</tbody></table></div>
    ${allW.length > 1 ? `<div style="margin:.5rem 0">${bars}</div>` : ''}
    <div class="alert ${vcls || 'info'}" style="margin-top:.4rem">
      Trimestre glissant : <strong>${hFmt(totW)}</strong> travaillées (moyenne <strong>${hFmt(avgW)}</strong>/mois, dont <strong>${hFmt(totH)}</strong> d'heures sup.).<br>
      Le mois en cours est <strong>${diffAvg >= 0 ? '+' : ''}${diffAvg}%</strong> par rapport à la moyenne du trimestre et <strong>${diffFirst >= 0 ? '+' : ''}${diffFirst}%</strong> par rapport au 1ᵉʳ mois de la fenêtre — le chauffeur a travaillé <strong>${verdict}</strong> ce mois-ci.
    </div>`;
}

// Détail par mois, dans des tableaux DISTINCTS (un bloc par mois) : indemnités/
// événements + estimation détaillée du salaire.
function monthsDetailHTML(days, base, id) {
  const months = monthlyAgg(days, base);
  if (!months.length) return '<p class="help">—</p>';
  const p = getSalParams(id);
  const cap = _hs25To32[id] ? HS25_MAX : HS25_BASE;
  return months.slice().reverse().map((mo) => {
    const e = estimSalaire(mo, p, cap);
    return `<div class="card zoom-hover" style="margin:.4rem 0">
      <h4 style="margin:.1rem 0 .4rem">📅 ${esc(mo.key)} — ${hFmt(mo.worked)} travaillées · ${mo.days} j</h4>
      <div class="table-wrap"><table class="veh-table"><thead><tr><th>Travaillé</th><th>HSUP 25%</th><th>HSUP 50% (récup.)</th><th>Nuit</th><th>Paniers midi</th><th>Paniers soir</th><th>Casse-cr.</th><th>Découch.</th><th>Km</th><th>Absence</th></tr></thead>
        <tbody><tr><td>${hFmt(mo.worked)}</td><td>${mo.h25 ? hFmt(mo.h25) + (e.over22 > 0 ? ` <span class="warn">(+${hFmt(e.over22)} > 22h)</span>` : '') : '—'}</td><td>${mo.h50 ? hFmt(mo.h50) : '—'}</td><td>${mo.night ? hFmt(mo.night) : '—'}</td><td>${mo.midi || '—'}</td><td>${mo.soir || '—'}</td><td>${mo.casse || '—'}</td><td>${mo.dec || '—'}</td><td>${mo.km ? mo.km.toLocaleString('fr-FR') : '—'}</td><td>${mo.abs ? hFmt(mo.abs) : '—'}</td></tr></tbody></table></div>
      <div class="table-wrap" style="margin-top:.4rem"><table class="veh-table"><thead><tr><th>Salaire de base</th><th>HS 25% payées (≤${cap}h)</th><th>HS 50%</th><th>Maj. nuit</th><th>Brut</th><th>Cotis.</th><th>Indemnités</th><th>Net estimé</th></tr></thead>
        <tbody><tr><td>${eur(e.base)}</td><td>${e.hs25 ? eur(e.hs25) : '—'}</td><td><span class="help">récup. (non payé)</span></td><td>${e.nuit ? eur(e.nuit) : '—'}</td><td><strong>${eur(e.brut)}</strong></td><td>− ${eur(e.cotis)}</td><td>${eur(e.indem)}</td><td><strong class="pos">${eur(e.net)}</strong></td></tr></tbody></table></div>
    </div>`;
  }).join('');
}

// Export CSV du tableau d'un salarié (journées + indemnités + événements).
function exportHoursCSV(u, base) {
  const cell = (v) => { const s = String(v == null ? '' : v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Date', 'Début', 'Fin', 'Travaillé (h)', 'Heures nuit (h)', 'Amplitude (h)', 'Pause (min)', 'Repas midi', 'Repas soir', 'Casse-croûte', 'Découcher', 'Km', 'Mission(s)', 'Absence (h)', 'Motif', 'Observations'];
  const lines = [head.join(';')];
  u.days.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
    lines.push([e.date, e.start || '', e.end || '', e.worked || 0, e.nightHours || 0, e.amplitude || 0, e.breakMin || 0, e.mealMidi || 0, e.mealSoir || 0, e.casseCroute || 0, e.decoucher || 0, e.km || 0, e.missions || '', e.absence || 0, e.motif || '', e.observations || ''].map(cell).join(';'));
  });
  const csv = '﻿' + lines.join('\r\n'); // BOM pour Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `heures_${(u.name || 'salarie').replace(/[^a-zA-Z0-9]+/g, '_')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --- Import d'un rapport d'activité (.xlsx) -------------------------------- */
// Lecteur XLSX minimal et SANS dépendance : décompression ZIP via l'API native
// DecompressionStream du navigateur + lecture XML via DOMParser.
async function xlsxUnzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('Fichier .xlsx invalide.');
  const cdOff = dv.getUint32(eocd + 16, true), count = dv.getUint16(eocd + 10, true);
  const out = {}; let p = cdOff;
  const inflate = async (bytes) => { const ds = new DecompressionStream('deflate-raw'); const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer(); return new Uint8Array(ab); };
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true), exLen = dv.getUint16(p + 30, true), cmLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fnLen));
    if (/sharedStrings\.xml$|worksheets\/sheet1\.xml$/.test(name)) {
      const lfn = dv.getUint16(localOff + 26, true), lex = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lfn + lex; const comp = u8.subarray(start, start + compSize);
      out[name] = new TextDecoder('utf-8').decode(method === 0 ? comp : await inflate(comp));
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  return out;
}
function colIndex(ref) { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }
async function parseXlsx(buf) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Votre navigateur ne supporte pas la lecture .xlsx ici. Exportez en CSV ou utilisez un navigateur récent.');
  const files = await xlsxUnzip(buf);
  const sheetKey = Object.keys(files).find((k) => /sheet1\.xml$/.test(k));
  if (!sheetKey) throw new Error('Feuille introuvable dans le fichier.');
  const ss = [];
  const ssKey = Object.keys(files).find((k) => /sharedStrings\.xml$/.test(k));
  if (ssKey) { const doc = new DOMParser().parseFromString(files[ssKey], 'application/xml'); doc.querySelectorAll('si').forEach((si) => { let t = ''; si.querySelectorAll('t').forEach((n) => { t += n.textContent; }); ss.push(t); }); }
  const sdoc = new DOMParser().parseFromString(files[sheetKey], 'application/xml');
  const rows = [];
  sdoc.querySelectorAll('row').forEach((row) => {
    const cells = [];
    row.querySelectorAll('c').forEach((c) => {
      const ref = c.getAttribute('r'); if (!ref) return; const col = colIndex(ref); const t = c.getAttribute('t');
      const v = c.querySelector('v'); let val = null;
      if (t === 'inlineStr') { const isn = c.querySelector('is t'); val = isn ? isn.textContent : ''; }
      else if (v != null) { val = v.textContent; if (t === 's') val = ss[+val] || ''; else if (t === 'str' || t === 'b') { /* string */ } else val = Number(val); }
      cells[col] = val;
    });
    rows.push(cells);
  });
  return rows;
}
function xlDateISO(n) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000); return d.toISOString().slice(0, 10); }
function xlTimeHM(n) { const frac = n - Math.floor(n); let mins = Math.round(frac * 24 * 60); const hh = Math.floor(mins / 60), mm = mins % 60; return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; }

let _hImport = null; // { employees: { name: rows[] }, period }
function hoursImport(body) {
  body.innerHTML = `
    <div class="card"><h3>Importer un rapport d'activité (.xlsx)</h3>
      <p class="help">Chargez le fichier exporté (colonnes Employé, Jour, Début, Fin, Total travail, Amplitude…). Les salariés détectés seront à associer à vos comptes, puis les données alimentent les amplitudes et les heures supplémentaires.</p>
      <input id="hi-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
      <div id="hi-status" class="help" style="margin-top:.4rem"></div>
    </div>
    <div id="hi-map"></div>`;
  document.getElementById('hi-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    document.getElementById('hi-status').textContent = 'Analyse en cours…';
    try {
      const rows = await parseXlsx(await f.arrayBuffer());
      _hImport = extractActivityReport(rows);
      const names = Object.keys(_hImport.employees);
      if (!names.length) throw new Error('Aucune ligne exploitable détectée.');
      document.getElementById('hi-status').textContent = `${names.length} salarié(s) détecté(s) · période ${_hImport.period}.`;
      renderImportMapping();
    } catch (err) { document.getElementById('hi-status').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
  };
}
// Extrait les lignes d'activité (employé porté ligne par ligne).
function extractActivityReport(rows) {
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) { const r = rows[i] || []; if (r.some((c) => typeof c === 'string' && c.trim() === 'Employé') && r.some((c) => typeof c === 'string' && /Total travail/.test(c))) { hdr = i; break; } }
  if (hdr < 0) throw new Error('En-têtes non reconnus (Employé / Total travail).');
  const H = rows[hdr];
  const col = (name) => H.findIndex((c) => typeof c === 'string' && c.trim().startsWith(name));
  const colAny = (names) => { for (const n of names) { const i = col(n); if (i >= 0) return i; } return -1; };
  const cE = col('Employé'), cJ = col('Jour'), cD = col('Début'), cF = col('Fin'), cP = col('Pause'), cT = col('Total travail'), cA = col('Amplitude'), cAbs = col('Heures congés');
  const cNight = col('Heures au tarif nuit'), cKm = col('Nombre de kilomètres'), cMidi = col('Repas midi'), cSoir = col('Repas soir'), cDec = col('Découcher'), cCasse = col('Casse'), cMiss = col('Mission'), cMot = col('Motif'), cObs = col('Observations');
  const cVeh = colAny(['Véhicule', 'Vehicule', 'Immatriculation', 'Plaque', 'Tournée']); // pour le suivi du kilométrage
  const hN = (i) => (i >= 0 && typeof r[i] === 'number') ? Math.round(r[i] * 24 * 100) / 100 : 0; // fraction de jour -> heures
  const nb = (i) => (i >= 0 && typeof r[i] === 'number') ? r[i] : 0;
  const str = (i) => (i >= 0 && typeof r[i] === 'string') ? r[i].replace(/\s+/g, ' ').trim() : '';
  let r; const employees = {}; let cur = null; let minD = null, maxD = null;
  for (let i = hdr + 1; i < rows.length; i++) {
    r = rows[i] || [];
    const e = r[cE]; if (typeof e === 'string' && e.trim()) cur = e.split(/\r?\n/)[0].trim();
    if (!cur || typeof r[cJ] !== 'number') continue;
    const date = xlDateISO(r[cJ]);
    const rec = {
      date,
      start: typeof r[cD] === 'number' ? xlTimeHM(r[cD]) : '',
      end: typeof r[cF] === 'number' ? xlTimeHM(r[cF]) : '',
      breakMin: typeof r[cP] === 'number' ? Math.round(r[cP] * 24 * 60) : 0,
      worked: hN(cT), amplitude: hN(cA), absence: hN(cAbs),
      nightHours: hN(cNight), km: Math.round(nb(cKm)),
      mealMidi: nb(cMidi), mealSoir: nb(cSoir), casseCroute: nb(cCasse), decoucher: nb(cDec),
      missions: str(cMiss), motif: str(cMot), observations: str(cObs),
      absCat: hN(cAbs) > 0 ? mapMotifToCat(str(cMot)) : null, // pour l'ajout rétroactif au planning
      vehName: str(cVeh), // identifiant véhicule (pour le suivi du kilométrage)
    };
    (employees[cur] = employees[cur] || []).push(rec);
    if (!minD || date < minD) minD = date; if (!maxD || date > maxD) maxD = date;
  }
  return { employees, period: minD ? `${fmtDate(minD)} → ${fmtDate(maxD)}` : '' };
}
// Normalise un nom (minuscules, sans accents, ponctuation -> espaces).
function normNm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function nmTokens(s) { return normNm(s).split(' ').filter((t) => t.length > 1); }
// Devine le code de catégorie d'absence à partir d'un motif libre (par défaut CP).
function mapMotifToCat(motif) {
  const n = normNm(motif);
  const cats = (State.categories || []).filter((c) => c.selectable !== false && c.code !== 'RET');
  const has = (code) => cats.some((c) => c.code === code);
  if (n) {
    for (const c of cats) if (normNm(c.code) === n) return c.code;
    for (const c of cats) { const l = normNm(c.label); if (l && (n.includes(l) || l.includes(n))) return c.code; }
    if (/malad/.test(n)) return has('AM') ? 'AM' : 'CP';
    if (/accident/.test(n)) return has('AT') ? 'AT' : 'CP';
    if (/recup/.test(n)) return has('RCP') ? 'RCP' : 'CP';
    if (/rtt/.test(n)) return has('RTT') ? 'RTT' : 'CP';
    if (/conge|cp/.test(n)) return 'CP';
  }
  return 'CP';
}
// Tente d'associer un nom du fichier à un salarié (compare noms ET prénoms).
function matchDriverId(fileName, drivers) {
  const fileTokens = new Set(nmTokens(fileName));
  if (!fileTokens.size) return '';
  let best = null, bestScore = 0;
  drivers.forEach((d) => {
    const lastT = nmTokens(d.lastName), firstT = nmTokens(d.firstName);
    if (!lastT.length && !firstT.length) return;
    const lastMatch = lastT.length && lastT.every((t) => fileTokens.has(t));
    const firstMatch = firstT.some((t) => fileTokens.has(t));
    const score = (lastMatch ? 2 : 0) + (firstMatch ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = d; }
  });
  // Auto-sélection seulement si le nom de famille correspond (idéalement nom + prénom).
  return bestScore >= 2 ? best.id : '';
}
// Liste déroulante des salariés, triée par groupe d'attribution (optgroups).
function importDriverOptions(selectedId, drivers) {
  const order = State.groups.map((g) => g.id).concat([null]);
  const byGroup = {};
  drivers.forEach((d) => { const k = d.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(d); });
  let html = `<option value="">— Associer à un salarié —</option>`;
  order.forEach((gid) => {
    const list = byGroup[gid || 'none']; if (!list || !list.length) return;
    const g = groupById(gid);
    list.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    html += `<optgroup label="${esc(g ? g.name : 'Sans groupe')}">` + list.map((d) => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.lastName)} ${esc(d.firstName)}</option>`).join('') + `</optgroup>`;
  });
  return html;
}
function renderImportMapping() {
  const drivers = _hours.drivers;
  const names = Object.keys(_hImport.employees);
  const el = document.getElementById('hi-map');
  let matched = 0;
  const rowsHTML = names.map((n) => {
    const rows = _hImport.employees[n];
    const tot = rows.reduce((s, r) => s + r.worked, 0);
    const mid = matchDriverId(n, drivers);
    if (mid) matched++;
    const badge = mid ? '<span class="pill ok" style="margin-left:.4rem">✓ détecté</span>' : '<span class="pill warn" style="margin-left:.4rem">à associer</span>';
    return `<tr><td><strong>${esc(n)}</strong>${badge}</td><td>${rows.length}</td><td>${hFmt(tot)}</td><td><select data-mapname="${esc(n)}">${importDriverOptions(mid, drivers)}</select></td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card"><h3>Associer les salariés détectés</h3>
    <p class="help">${matched} / ${names.length} salarié(s) reconnu(s) automatiquement (par comparaison nom + prénom). Vérifiez et corrigez si besoin ; la liste est triée par groupe.</p>
    <div class="table-wrap"><table class="veh-table"><thead><tr><th>Salarié du fichier</th><th>Jours</th><th>Total travaillé</th><th>Associer au compte</th></tr></thead>
    <tbody>${rowsHTML}</tbody></table></div>
    <div style="margin-top:.7rem"><button class="btn accent" id="hi-import">Importer les données associées</button></div>
    <p class="help">Astuce : un salarié non associé est ignoré.</p>
  </div>`;
  document.getElementById('hi-import').onclick = async () => {
    const maps = Array.from(el.querySelectorAll('[data-mapname]')).map((s) => ({ name: s.dataset.mapname, userId: s.value })).filter((m) => m.userId);
    if (!maps.length) { toast('Associez au moins un salarié.', 'err'); return; }
    let total = 0, planned = 0, kmUp = 0, kmFlag = 0; const reopened = new Set();
    try {
      for (const m of maps) { const r = await api('POST', '/staff/work-hours/import', { userId: m.userId, rows: _hImport.employees[m.name] }); total += r.added; planned += (r.planned || 0); kmUp += (r.kmUpdated || 0); kmFlag += (r.kmFlagged || 0); (r.reopened || []).forEach((mo) => reopened.add(mo)); }
      toast(`${total} journée(s) importée(s).`, 'ok');
      if (planned) toast(`${planned} absence(s) ajoutée(s) au planning (rétroactif).`, 'ok');
      if (kmUp) toast(`${kmUp} relevé(s) de kilométrage pris en compte.`, 'ok');
      if (kmFlag) toast(`${kmFlag} anomalie(s) de kilométrage à vérifier sur l'accueil.`, 'warn');
      if (reopened.size) toast(`Mois rouvert(s) : ${[...reopened].sort().join(', ')} — de nouvelles heures sup. peuvent être dues (voir « Reste dû »).`, 'warn');
      // Détecte les journées de travail manquantes, justifie via le planning ou
      // demande le type d'absence, puis réactualise toute la gestion des heures.
      await handleMissingDays(maps);
    } catch (e) { toast(e.message, 'err'); }
  };
}

// Recharge la gestion des heures et recadre le résumé sur le mois importé.
function finalizeImport() { _hImport = null; _hrResumeMonth = null; loadHours().then(() => hrTab('hsup')); }

// Journées OUVRÉES (lun-ven, hors fériés) sans aucune saisie entre la 1re et la
// dernière date du fichier d'un salarié.
function computeMissingDays(rows) {
  const dates = new Set((rows || []).map((r) => r.date).filter(Boolean));
  if (!dates.size) return [];
  const sorted = [...dates].sort();
  let d = parseISO(sorted[0]); const end = parseISO(sorted[sorted.length - 1]);
  const missing = [];
  while (d <= end) {
    const ds = iso(d), dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !State.holidays[ds] && !dates.has(ds)) missing.push(ds);
    d = addDays(d, 1);
  }
  return missing;
}
// Cherche une absence approuvée du salarié couvrant la date (justification planning).
function justifForDate(reqs, userId, ds) {
  const r = (reqs || []).find((x) => x.userId === userId && x.status === 'approved' && x.category !== 'RET' && x.startDate <= ds && x.endDate >= ds);
  return r ? r.category : null;
}
// Construit une ligne d'absence (journée complète) à importer dans les heures.
function absenceRow(ds, cat, fromPlanning) {
  return { date: ds, worked: 0, amplitude: 0, absence: HPERDAY, motif: catLabel(cat) + (fromPlanning ? ' (planning)' : ''), absCat: cat, missions: '', start: '', end: '', breakMin: 0 };
}
// Orchestration : justifie automatiquement via le planning, sinon demande.
async function handleMissingDays(maps) {
  // S'assure que les jours fériés des années concernées sont chargés.
  const years = new Set();
  maps.forEach((m) => (_hImport.employees[m.name] || []).forEach((r) => { if (r.date) years.add(Number(r.date.slice(0, 4))); }));
  for (const y of years) { try { await ensureHolidays(y); } catch (e) {} }
  let reqs = [];
  try { reqs = (await api('GET', '/admin/requests')).requests || []; } catch (e) {}
  const justified = {}; const unresolved = [];
  for (const m of maps) {
    for (const ds of computeMissingDays(_hImport.employees[m.name])) {
      const cat = justifForDate(reqs, m.userId, ds);
      if (cat) (justified[m.userId] = justified[m.userId] || []).push(absenceRow(ds, cat, true));
      else unresolved.push({ userId: m.userId, name: m.name, date: ds });
    }
  }
  let auto = 0;
  for (const uid of Object.keys(justified)) { try { const r = await api('POST', '/staff/work-hours/import', { userId: uid, rows: justified[uid] }); auto += r.added; } catch (e) {} }
  if (auto) toast(`${auto} absence(s) justifiée(s) ajoutée(s) depuis le planning.`, 'ok');
  if (unresolved.length) missingDaysModal(unresolved, finalizeImport);
  else finalizeImport();
}
// Menu contextuel : indiquer le type d'absence des journées manquantes non justifiées.
function missingDaysModal(items, done) {
  const dows = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const catOpts = `<option value="">— Ignorer —</option>` + State.categories.filter((c) => c.selectable !== false && c.code !== 'RET').map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(catLabel(c.code))}</option>`).join('');
  const rows = items.map((it, i) => `<tr><td>${esc(it.name)}</td><td>${fmtDate(it.date)} <span class="help">${dows[parseISO(it.date).getDay()]}</span></td><td><select data-mi="${i}" data-uid="${it.userId}" data-date="${it.date}">${catOpts}</select></td></tr>`).join('');
  modal({
    title: `Journées manquantes (${items.length})`,
    bodyHTML: `<p class="help">Ces journées ouvrées n'ont ni heures ni absence dans le fichier, et aucune justification n'a été trouvée dans le planning. Indiquez le type d'absence (ou « Ignorer »).</p>
      <label>Appliquer à toutes les lignes : <select id="mi-all" style="width:auto">${catOpts}</select></label>
      <div class="table-wrap" style="margin-top:.6rem;max-height:50vh;overflow:auto"><table class="veh-table"><thead><tr><th>Salarié</th><th>Date</th><th>Type d'absence</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    footHTML: `<button class="btn ghost" id="mi-skip">Tout ignorer</button><button class="btn accent" id="mi-save">Enregistrer les absences</button>`,
    onMount: (ov) => {
      ov.querySelector('#mi-all').onchange = (e) => { const v = e.target.value; ov.querySelectorAll('[data-mi]').forEach((s) => s.value = v); };
      ov.querySelector('#mi-skip').onclick = () => { closeModal(); done(); };
      ov.querySelector('#mi-save').onclick = async () => {
        const byUser = {};
        ov.querySelectorAll('[data-mi]').forEach((s) => { if (s.value) (byUser[s.dataset.uid] = byUser[s.dataset.uid] || []).push(absenceRow(s.dataset.date, s.value, false)); });
        let n = 0, planned = 0;
        try { for (const uid of Object.keys(byUser)) { const r = await api('POST', '/staff/work-hours/import', { userId: uid, rows: byUser[uid] }); n += r.added; planned += (r.planned || 0); } }
        catch (e) { toast(e.message, 'err'); return; }
        closeModal(); if (n) toast(`${n} absence(s) enregistrée(s)${planned ? `, ${planned} ajoutée(s) au planning` : ''}.`, 'ok'); done();
      };
    },
  });
}

/* =========================================================================
   ORGANIGRAMME
   ========================================================================= */
async function renderOrganigramme(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Organigramme</h1><p>Qui contacter selon votre besoin.</p></div></div><div id="org" class="empty">Chargement…</div>`;
  try {
    const { team } = await api('GET', '/team');
    const RESP_GROUPS = ['grp_responsables', 'grp_resp_exploitation', 'grp_resp_gls', 'grp_resp_ciblex', 'grp_resp_fedex'];
    const OP_GROUPS = ['grp_gls', 'grp_ciblex', 'grp_fedex', 'grp_joker', 'grp_secretaire'];

    const card = (m) => {
      const g = groupById(m.groupId);
      return `<div class="org-card" style="border-top:4px solid ${g ? g.color : 'var(--brand)'}">
        <div class="org-name">${esc(m.firstName)} ${esc(m.lastName)}</div>
        <div class="org-role">${roleLabel(m.role)}${g ? ' • ' + esc(g.name) : ''}</div>
        ${m.phone ? `<a class="org-mail" href="tel:${esc(m.phone)}">📞 ${esc(m.phone)}</a>` : ''}
        ${m.email ? `<a class="org-mail" href="mailto:${esc(m.email)}">✉️ ${esc(m.email)}</a>` : ''}
      </div>`;
    };

    const isAdmin = State.user.role === 'admin';
    // Responsable attaché à chaque équipe opérationnelle.
    const RESP_OF = { grp_gls: 'grp_resp_gls', grp_ciblex: 'grp_resp_ciblex', grp_fedex: 'grp_resp_fedex' };
    const direction = team.filter((m) => m.role === 'admin');
    const exploitation = team.filter((m) => m.groupId === 'grp_resp_exploitation' || (m.role === 'responsable' && !Object.values(RESP_OF).includes(m.groupId) && m.groupId !== 'grp_resp_exploitation' && !RESP_GROUPS.includes(m.groupId)));

    // Une colonne par équipe : responsable(s) en haut, équipe en dessous.
    const columns = OP_GROUPS.map((gid) => {
      const g = groupById(gid); if (!g) return '';
      const resps = team.filter((m) => RESP_OF[gid] && m.groupId === RESP_OF[gid]);
      const members = team.filter((m) => m.groupId === gid && m.role === 'employee');
      if (!resps.length && !members.length) return '';
      return `<div class="org-col">
        <div class="org-col-head" style="background:${g.color}">${esc(g.name)}</div>
        ${resps.length ? `<div class="org-resp">${resps.map(card).join('')}</div><div class="org-connector"></div>` : ''}
        <div class="org-members">${members.length ? members.map(card).join('') : '<div class="help" style="text-align:center">—</div>'}</div>
      </div>`;
    }).join('');

    const el = document.getElementById('org'); el.className = '';
    el.innerHTML = `
      ${!isAdmin ? `<div class="alert info">Seuls les emails de la direction sont visibles. Les autres coordonnées sont réservées à l'administration.</div>` : ''}
      <div class="org-level"><div class="org-level-title">Direction</div>
        <div class="org-row">${direction.length ? direction.map(card).join('') : '<div class="empty">—</div>'}</div>
      </div>
      ${exploitation.length ? `<div class="org-connector"></div><div class="org-level"><div class="org-level-title">Responsable Exploitation</div><div class="org-row">${exploitation.map(card).join('')}</div></div>` : ''}
      <div class="org-connector"></div>
      <div class="org-level-title" style="text-align:center">Équipes</div>
      <div class="org-cols">${columns || '<div class="empty">Aucune équipe.</div>'}</div>`;
  } catch (e) { document.getElementById('org').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

/* =========================================================================
   DROITS & DEVOIRS
   ========================================================================= */
async function renderInfo(main) {
  const u = State.user;
  const accepted = reglementUpToDate(u);
  const ri = State.reglement || {};
  const isAdmin = u.role === 'admin';
  main.innerHTML = `<div class="page-head"><div><h1>Vos droits & devoirs</h1><p>Informations utiles sur la plateforme.</p></div>
    ${isAdmin?`<button class="btn ghost" id="edit-info">Modifier le panneau</button>`:''}</div>
    <div class="card"><div class="info-content" id="info-content">Chargement…</div></div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <h3 style="margin:0">📋 Règlement intérieur de l'entreprise</h3>
        ${isAdmin?`<button class="btn accent" id="edit-reglement">✏️ Modifier le règlement</button>`:''}
      </div>
      <p class="help" style="margin-top:.4rem">${ri.label?`<strong>${esc(ri.label)}</strong> — en vigueur depuis le ${fmtDate((ri.updatedAt||'').slice(0,10))}. `:''}${accepted?`✅ Vous avez lu et approuvé cette version le <strong>${fmtDateTimeS(u.reglementAcceptedAt)}</strong>.`:'Veuillez prendre connaissance du règlement intérieur ci-dessous et l\'accepter.'}</p>
      <div class="cgu-body reglement-scroll" style="max-height:55vh">${reglementContent()}</div>
      ${accepted ? '' : `
      <label class="cgu-check" style="margin-top:1rem"><input type="checkbox" id="ri-ok2"> ${reglementDeclaration(u)}</label>
      <div style="margin-top:1rem"><button class="btn accent" id="ri-accept2" disabled>J'accepte le règlement intérieur</button></div>`}
    </div>`;
  try {
    const { content } = await api('GET', '/info-panel');
    document.getElementById('info-content').textContent = content;
    if (isAdmin) {
      document.getElementById('edit-info').onclick = () => editInfoModal(content);
      document.getElementById('edit-reglement').onclick = () => editReglementModal(main);
    }
  } catch (e) { document.getElementById('info-content').textContent = e.message; }
  if (!accepted) {
    const chk = document.getElementById('ri-ok2');
    const acc = document.getElementById('ri-accept2');
    chk.onchange = () => { acc.disabled = !chk.checked; };
    acc.onclick = async () => {
      try { const r = await api('POST', '/me/accept-reglement'); State.user = r.user; toast('Règlement intérieur accepté.', 'ok'); renderInfo(main); }
      catch (e) { toast(e.message, 'err'); }
    };
  }
}

function editInfoModal(content) {
  modal({
    title: 'Modifier le panneau d\'informations',
    bodyHTML: `<textarea id="info-edit" style="min-height:300px">${esc(content)}</textarea>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn" id="save-info">Enregistrer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#save-info').onclick = async () => {
        try { await api('PUT', '/info-panel', { content: overlay.querySelector('#info-edit').value }); closeModal(); toast('Mis à jour.', 'ok'); renderInfo(document.getElementById('main')); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Édition du règlement intérieur (admin) : publier crée une nouvelle version et
// oblige tous les salariés à ré-accepter à leur prochaine connexion.
function editReglementModal(main) {
  const ri = State.reglement || {};
  const nextV = (ri.version || 0) + 1;
  modal({
    title: 'Modifier le règlement intérieur',
    bodyHTML: `
      <div class="alert warn">⚠️ Publier une nouvelle version <strong>réinitialise les acceptations</strong> : tous les salariés devront ré-accepter le règlement à leur prochaine connexion.</div>
      <label>Intitulé de la version</label>
      <input id="ri-label" value="Version ${nextV}.0">
      <label>Contenu du règlement (HTML accepté)</label>
      <textarea id="ri-content" style="min-height:340px;font-family:monospace;font-size:.82rem">${esc(ri.content || reglementContent())}</textarea>
      <p class="help">Astuce : conservez les balises &lt;h3&gt; (titres), &lt;h4&gt; (articles), &lt;p&gt; et &lt;ul&gt;&lt;li&gt; pour une mise en forme cohérente.</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ri-pub">Publier la nouvelle version</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#ri-pub').onclick = async () => {
        const content = overlay.querySelector('#ri-content').value;
        const label = overlay.querySelector('#ri-label').value;
        if (!content.trim()) { toast('Le contenu ne peut pas être vide.', 'err'); return; }
        if (!confirm('Publier cette nouvelle version ? Tous les salariés devront la ré-accepter.')) return;
        try {
          const r = await api('PUT', '/admin/reglement', { content, label });
          State.reglement = r.reglement;
          // L'admin lui-même devra ré-accepter : on remet son statut à jour.
          State.user.reglementAcceptedVersion = (State.user.reglementAcceptedVersion || 0);
          closeModal(); toast('Nouvelle version publiée.', 'ok');
          renderApp();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* =========================================================================
   ADMINISTRATION
   ========================================================================= */
async function renderAdmin(main) {
  if (State.user.role !== 'admin') { main.innerHTML = `<div class="alert warn">Accès réservé à l'administrateur.</div>`; return; }
  // Compteurs de notifications à traiter.
  let nbPending = 0, nbReqs = 0;
  try {
    const [{ users }, { requests }] = await Promise.all([api('GET', '/admin/pending'), api('GET', '/admin/requests')]);
    nbPending = users.length;
    nbReqs = requests.filter((r) => r.status === 'pending').length;
  } catch (e) {}
  const badge = (n) => n > 0 ? ` <span class="badge" style="background:var(--accent);color:#fff;border-radius:999px;padding:0 .45rem;font-size:.72rem;font-weight:700">${n}</span>` : '';
  main.innerHTML = `<div class="page-head"><div><h1>Administration</h1><p>Validez les inscriptions, gérez les soldes et les demandes.</p></div></div>
    <div class="view-switch" id="admin-tabs" style="margin-bottom:1.2rem;flex-wrap:wrap">
      <button data-tab="pending" class="active">Nouveaux inscrits${badge(nbPending)}</button>
      <button data-tab="reqs">En attente d'approbation${badge(nbReqs)}</button>
      <button data-tab="users">Paramétrages salariés</button>
      <button data-tab="company">Informations de l'entreprise</button>
      <button data-tab="docsuivi">Suivi des documents</button>
      <button data-tab="export">Exporter des données</button>
      <button data-tab="reglement">Règlement intérieur</button>
      <button data-tab="groups">Groupes</button>
      <button data-tab="categories">Catégories</button>
    </div>
    <div id="admin-body" class="empty">Chargement…</div>`;
  const tabs = main.querySelector('#admin-tabs');
  tabs.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    adminTab(b.dataset.tab);
  });
  adminTab('pending');
}

async function adminTab(tab) {
  const body = document.getElementById('admin-body');
  body.className = '';
  body.innerHTML = `<div class="empty">Chargement…</div>`;
  try {
    if (tab === 'pending') return adminPending(body);
    if (tab === 'reqs') return adminReqs(body);
    if (tab === 'users') return adminUsers(body);
    if (tab === 'company') return adminCompany(body);
    if (tab === 'docsuivi') return adminDocSuivi(body);
    if (tab === 'export') return adminExport(body);
    if (tab === 'groups') return adminGroups(body);
    if (tab === 'reglement') return adminReglement(body);
    if (tab === 'categories') return adminCategories(body);
  } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

// Informations de l'entreprise (en-tête de tous les documents générés).
async function adminCompany(body) {
  let co;
  try { co = (await api('GET', '/admin/erp/company')).company; } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const f = (id, lbl, ph) => `<div><label>${lbl}</label><input id="${id}" value="${esc(co[id.replace('co-', '')] || '')}" placeholder="${ph || ''}"></div>`;
  body.innerHTML = `<div class="card">
    <h3>Informations de l'entreprise</h3>
    <p class="help">Ces informations constituent l'<strong>en-tête de tous les documents</strong> générés (courriers, contrats, factures, attestations). Renseignez-les une fois, elles seront reprises automatiquement.</p>
    <div class="grid2">
      ${f('co-name', 'Nom commercial', 'INTER COLIS SERVICES')}
      ${f('co-legal', 'Dénomination légale', 'SASU INTER COLIS SERVICES')}
      ${f('co-formeJuridique', 'Forme juridique', 'SASU')}
      ${f('co-capital', 'Capital social', '1 000 €')}
      ${f('co-address', 'Adresse du siège', 'rue…, 14930 Éterville')}
      ${f('co-siret', 'SIRET (14 chiffres)', '82032335000042')}
      ${f('co-rcs', 'RCS', 'RCS Caen 820 323 350')}
      ${f('co-ape', 'Code APE / NAF', '4941A')}
      ${f('co-tva', 'N° TVA intracommunautaire', 'FR..')}
      ${f('co-iban', 'IBAN', 'FR76 …')}
      ${f('co-bic', 'BIC / SWIFT', '')}
      ${f('co-contact', 'Contact (email / téléphone)', '')}
      ${f('co-penaltyRate', 'Taux pénalités de retard (%/an)', 'vide = taux légal')}
    </div>
    <label class="veh-check" style="margin-top:.5rem"><input type="checkbox" id="co-franchise" ${co.tvaFranchise ? 'checked' : ''}> Franchise en base de TVA (art. 293 B du CGI — pas de TVA facturée)</label>
    <div style="margin-top:.6rem"><button class="btn ok" id="co-save">Enregistrer les informations</button></div>
  </div>`;
  body.querySelector('#co-save').onclick = async () => {
    const v = (id) => body.querySelector(id).value;
    try {
      await api('PUT', '/admin/erp/company', {
        name: v('#co-name'), legal: v('#co-legal'), formeJuridique: v('#co-formeJuridique'), capital: v('#co-capital'), address: v('#co-address'),
        siret: v('#co-siret'), rcs: v('#co-rcs'), ape: v('#co-ape'), tva: v('#co-tva'), iban: v('#co-iban'), bic: v('#co-bic'), contact: v('#co-contact'),
        penaltyRate: v('#co-penaltyRate'), tvaFranchise: body.querySelector('#co-franchise').checked,
      });
      toast('Informations de l\'entreprise enregistrées.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// Suivi des documents adressés aux salariés (lu / reçu / signé + attestation).
async function adminDocSuivi(body) {
  let docs;
  try { docs = (await api('GET', '/admin/erp/documents')).documents; } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  body.innerHTML = `<div class="card">
    <h3>Suivi des documents adressés aux salariés</h3>
    <p class="help">Chaque document généré et adressé apparaît ici. Le salarié le retrouve à l'ouverture de l'application et certifie sur l'honneur l'avoir reçu et lu (signature électronique horodatée). L'attestation est alors disponible.</p>
    ${docs.length ? `<div class="table-wrap"><table class="veh-table"><thead><tr><th>Document</th><th>Salarié</th><th>Émis le</th><th>Statut</th><th>Lu le</th><th>Signé le</th><th></th></tr></thead><tbody>${docs.map((d) => `<tr>
      <td>${esc(d.label)}</td><td>${esc(d.userName)}</td><td>${fmtDate((d.createdAt || '').slice(0, 10))}</td>
      <td>${d.status === 'acked' ? '<span class="pill ok">lu &amp; signé</span>' : (d.viewedAt || d.status === 'read') ? '<span class="pill warn">lu, non signé — à relancer</span>' : '<span class="pill danger">non ouvert</span>'}</td>
      <td>${d.viewedAt ? fmtDateTime(d.viewedAt) : '—'}</td>
      <td>${d.ackedAt ? fmtDateTime(d.ackedAt) : '—'}</td>
      <td style="white-space:nowrap"><button class="btn ghost sm" data-docview="${d.id}">Voir</button>${d.status === 'acked' ? ` <button class="btn ok sm" data-att="${d.id}">Attestation PDF</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="help">Aucun document adressé pour le moment. Générez-en un depuis « Gestion des documents ».</p>'}
  </div>`;
  body.querySelectorAll('[data-docview]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.docview + '/view'));
  body.querySelectorAll('[data-att]').forEach((b) => b.onclick = () => erpOpenHtml('GET', '/admin/erp/documents/' + b.dataset.att + '/attestation'));
}

async function adminPending(body) {
  const { users } = await api('GET', '/admin/pending');
  if (users.length === 0) { body.innerHTML = `<div class="card"><div class="empty">✅ Aucune inscription en attente.</div></div>`; return; }
  body.innerHTML = `<div class="alert info">${users.length} demande(s) d'inscription à traiter. Attribuez le groupe et les soldes avant de valider.</div>` +
    users.map((u) => `
    <div class="card">
      <h3>${esc(u.firstName)} ${esc(u.lastName)} <span class="help">${esc(u.email)}</span></h3>
      <div class="row">
        <div><label>Groupe</label><select data-f="groupId" data-u="${u.id}">${groupOptions(null)}</select></div>
        <div><label>Rôle</label><select data-f="role" data-u="${u.id}"><option value="employee">Salarié</option><option value="responsable">Responsable</option><option value="admin">Administrateur</option></select></div>
      </div>
      <div class="row">
        <div><label>Congés N (j)</label><input type="number" step="0.5" data-f="congesN" data-u="${u.id}" value="0"></div>
        <div><label>Congés N-1 (j)</label><input type="number" step="0.5" data-f="congesN1" data-u="${u.id}" value="0"></div>
        <div><label>RCC (j)</label><input type="number" step="0.5" data-f="rcc" data-u="${u.id}" value="0"></div>
        <div><label>Heures sup. (h)</label><input type="number" step="0.5" data-f="heuresSupp" data-u="${u.id}" value="0"></div>
      </div>
      <div style="margin-top:1rem;display:flex;gap:.6rem">
        <button class="btn ok" data-approve="${u.id}">✓ Valider l'inscription</button>
        <button class="btn ghost" data-reject="${u.id}">Refuser</button>
      </div>
    </div>`).join('');

  body.querySelectorAll('[data-approve]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.approve;
    const payload = collectFields(body, id);
    try { await api('POST', `/admin/users/${id}/approve`, payload); toast('Inscription validée.', 'ok'); refreshAdminBadge(); adminPending(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-reject]').forEach((btn) => btn.onclick = async () => {
    try { await api('POST', `/admin/users/${btn.dataset.reject}/reject`); toast('Inscription refusée.', 'info'); refreshAdminBadge(); adminPending(body); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function collectFields(scope, id) {
  const o = {};
  scope.querySelectorAll(`[data-u="${id}"]`).forEach((el) => { o[el.dataset.f] = el.value; });
  return o;
}

function groupOptions(selected) {
  return `<option value="">— Aucun —</option>` + State.groups.map((g) => `<option value="${g.id}" ${g.id===selected?'selected':''}>${esc(g.name)}</option>`).join('');
}

// Rang d'arrivée d'une demande parmi les demandes EN ATTENTE qui chevauchent
// ses dates : 0 = premier à avoir demandé (vert), 1 = 2e (jaune), 2 = 3e (orange).
function pendingOrderRank(r, pending) {
  const earlier = pending.filter((o) =>
    o.id !== r.id &&
    o.startDate <= r.endDate && o.endDate >= r.startDate &&
    o.createdAt < r.createdAt
  );
  return earlier.length;
}
const ORDER_COLORS = ['#16a34a', '#eab308', '#f97316']; // vert, jaune, orange
function orderBadge(rank) {
  if (rank > 2) return `<span class="tag" style="background:#64748b;color:#fff">${rank + 1}e</span>`;
  const labels = ['1er', '2e', '3e'];
  return `<span class="tag" style="background:${ORDER_COLORS[rank]};color:#fff">${labels[rank]} à demander</span>`;
}

function parentTag(r) {
  return r.isParent ? ' <span class="tag" style="background:#0d9488;color:#fff"><strong>Parent</strong></span>' : '';
}

async function adminReqs(body) {
  const { requests } = await api('GET', '/admin/requests');
  const pending = requests.filter((r) => r.status === 'pending');
  const others = requests.filter((r) => r.status !== 'pending');

  // Historique groupé par groupe de travail.
  const order = State.groups.map((g) => g.id).concat([null]);
  const byGroup = {};
  others.forEach((r) => { const k = r.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(r); });
  const historySections = order.map((gid) => {
    const list = byGroup[gid || 'none'];
    if (!list || !list.length) return '';
    const g = groupById(gid);
    const title = g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Sans groupe</em>';
    const key = gid || 'none';
    const isOpen = !!_admHist[key];
    // Regroupe les évènements par salarié pour une lecture claire.
    const byUser = {};
    list.forEach((r) => { (byUser[r.userId] = byUser[r.userId] || { name: r.userName, items: [] }).items.push(r); });
    const users = Object.values(byUser).sort((a, b) => a.name.localeCompare(b.name));
    const summary = users.map((u) => `${esc(u.name)} <span class="help">(${u.items.length})</span>`).join(' · ');
    const userBlocks = users.map((u) => {
      u.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return `<h5 style="margin:.7rem 0 .2rem">${esc(u.name)}${parentTag(u.items[0])} <span class="help">${u.items.length} évènement(s)</span></h5>
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Période</th><th>Jours</th><th>Demandé le</th><th>Statut</th><th></th></tr></thead>
          <tbody>${u.items.map((r) => `<tr><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${r.days}${reqHours(r)}</td><td class="help">${fmtDateTime(r.createdAt)}<div>par ${esc(r.createdByName||'—')}</div></td><td>${statusTag(r.status)}</td><td style="white-space:nowrap"><button class="btn sm" data-edit-req="${r.id}" title="Modifier la saisie (ajouter / retirer des jours)">✏️</button> <button class="btn danger sm" data-del-req="${r.id}" title="Supprimer / libérer les dates">🗑️</button></td></tr>`).join('')}</tbody></table></div>`;
    }).join('');
    return `<div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:.6rem .7rem;margin-top:.8rem">
      <h4 style="margin:0;cursor:pointer" data-admhist="${key}"><span class="veh-caret">${isOpen ? '▾' : '▸'}</span> ${title} <span class="help">${list.length} évènement(s) · ${users.length} salarié(s)</span></h4>
      ${isOpen ? userBlocks : `<p class="help" style="margin:.4rem 0 0">${summary}</p>`}
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="card">
      <h3>Demandes en attente (${pending.length})</h3>
      <p class="help" style="margin-top:-.6rem">La couleur indique l'ordre d'arrivée quand plusieurs salariés visent les mêmes dates : <span style="color:#16a34a;font-weight:700">1er</span>, <span style="color:#ca8a04;font-weight:700">2e</span>, <span style="color:#f97316;font-weight:700">3e</span>.</p>
      ${pending.length===0?`<div class="empty">Aucune demande en attente.</div>`:`<div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Groupe</th><th>Type</th><th>Période</th><th>Ordre</th><th>Jours</th><th>Demandé le</th><th>Décision</th></tr></thead>
        <tbody>${pending.map((r) => adminReqRow(r, pendingOrderRank(r, pending))).join('')}</tbody></table></div>`}
    </div>
    <div class="card">
      <h3>Historique (${others.length}) — par groupe</h3>
      ${others.length===0?`<div class="empty">—</div>`:historySections}
    </div>`;
  body.querySelectorAll('[data-decide]').forEach((btn) => btn.onclick = async () => {
    const [id, decision] = btn.dataset.decide.split('|');
    let note = '';
    if (decision === 'rejected') { note = prompt('Motif du refus (facultatif) :') || ''; }
    try { await api('POST', `/admin/requests/${id}/decide`, { decision, adminNote: note }); toast(decision==='approved'?'Demande validée, solde mis à jour.':'Demande refusée.', 'ok'); refreshAdminBadge(); adminReqs(body); }
    catch (e) {
      // Conflit de remplaçant : popup bloquant, on ne valide pas.
      if (/deux endroits|disponible/i.test(e.message)) alert('⛔ ' + e.message);
      else toast(e.message, 'err');
    }
  });
  body.querySelectorAll('[data-repl]').forEach((btn) => btn.onclick = () => replacementModal(requests.find((r) => r.id === btn.dataset.repl), body));
  body.querySelectorAll('[data-del-req]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('Supprimer cet évènement et libérer les dates ? (le solde est recrédité si la demande était validée)')) return;
    try { await api('DELETE', `/admin/requests/${btn.dataset.delReq}`); toast('Évènement supprimé, dates libérées.', 'ok'); refreshAdminBadge(); adminReqs(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-admhist]').forEach((el) => el.onclick = () => { const k = el.dataset.admhist; _admHist[k] = !_admHist[k]; adminReqs(body); });
  body.querySelectorAll('[data-edit-req]').forEach((btn) => btn.onclick = () => editEventModal(requests.find((r) => r.id === btn.dataset.editReq), body));
}

// Modifier une saisie (évènement) sans la supprimer : ajuster la période et le
// nombre de jours/heures. Le solde est ré-ajusté automatiquement (recrédit de
// l'ancien décompte puis application du nouveau).
async function editEventModal(req, body) {
  if (!req) return;
  // Récupère les soldes du salarié + l'équipe (pour le remplaçant).
  let users = [], team = [];
  try { users = (await api('GET', '/admin/users')).users; team = (await api('GET', '/team')).team; }
  catch (e) { toast(e.message, 'err'); return; }
  const u = users.find((x) => x.id === req.userId) || {};
  const b = (u.balances) || { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 };
  // Type de congé courant (parmi CP N / CP N-1 / RCC / Récup).
  const TYPES = [
    { v: 'CP|N', lbl: 'CP (N)' }, { v: 'CP|N1', lbl: 'CP (N-1)' },
    { v: 'RCC|', lbl: 'RCC' }, { v: 'RCP|', lbl: 'Récupération (heures sup.)' },
  ];
  const curType = req.category === 'CP' ? (req.pool === 'N1' ? 'CP|N1' : 'CP|N') : `${req.category}|`;
  const inList = TYPES.some((t) => t.v === curType);
  const typeOpts = (inList ? '' : `<option value="" selected>Conserver (${esc(catLabel(req.category))})</option>`)
    + TYPES.map((t) => `<option value="${t.v}" ${t.v === curType ? 'selected' : ''}>${t.lbl}</option>`).join('');
  modal({
    title: `Modifier la saisie — ${req.userName}`,
    bodyHTML: `
      <p class="help">${esc(reqLabel(req))} · statut : ${req.status}. Ajustez la période, le type et le décompte ; le solde est recalculé automatiquement.</p>
      <div class="row">
        <div><label>Du</label><input type="date" id="ee-start" value="${req.startDate}"></div>
        <div><label>Au</label><input type="date" id="ee-end" value="${req.endDate}"></div>
      </div>
      <div class="row">
        <div><label>Type de congé</label><select id="ee-type">${typeOpts}</select></div>
        <div><label>Remplaçant</label><select id="ee-repl"><option value="">Pas de remplaçant</option>${teamOptgroups(team.filter((m) => m.id !== req.userId), req.replacedById)}</select></div>
      </div>
      <div class="row">
        <div><label>Nombre de jours</label><input type="number" step="0.5" min="0" id="ee-days" value="${req.days || 0}"></div>
        <div id="ee-hours-wrap" style="${(req.category === 'RCP' || req.category === 'RCC') ? '' : 'display:none'}"><label>Nombre d'heures</label><input type="number" step="0.5" min="0" id="ee-hours" value="${req.hours || 0}"></div>
      </div>
      <div class="card" style="margin-top:.6rem;background:var(--bg-soft,#fafafe)">
        <strong>Compteurs de ${esc(req.userName)}</strong> <span class="help">— correction au réel (valeur absolue)</span>
        <div class="row" style="margin-top:.4rem">
          <div><label>CP N (j)</label><input type="number" step="0.5" id="ee-b-congesN" value="${b.congesN}"></div>
          <div><label>CP N-1 (j)</label><input type="number" step="0.5" id="ee-b-congesN1" value="${b.congesN1}"></div>
        </div>
        <div class="row">
          <div><label>RCC (h)</label><input type="number" step="0.5" id="ee-b-rcc" value="${b.rcc}"></div>
          <div><label>Récup / H. sup. (h)</label><input type="number" step="0.5" id="ee-b-heuresSupp" value="${b.heuresSupp}"></div>
        </div>
        <div style="margin-top:.4rem"><button class="btn sm" id="ee-bal-save">💾 Enregistrer les compteurs</button></div>
        <p class="help" style="margin:.3rem 0 0">Changer le type de congé réajuste déjà le solde. Ces champs permettent une correction manuelle directe.</p>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ee-save">Enregistrer la saisie</button>`,
    onMount: (ov) => {
      const typeSel = ov.querySelector('#ee-type');
      const syncHours = () => { const v = typeSel.value; ov.querySelector('#ee-hours-wrap').style.display = (v === 'RCC|' || v === 'RCP|') ? '' : 'none'; };
      typeSel.onchange = syncHours;
      // Correction manuelle des compteurs (indépendante).
      ov.querySelector('#ee-bal-save').onclick = async () => {
        const bal = {
          congesN: ov.querySelector('#ee-b-congesN').value, congesN1: ov.querySelector('#ee-b-congesN1').value,
          rcc: ov.querySelector('#ee-b-rcc').value, heuresSupp: ov.querySelector('#ee-b-heuresSupp').value,
        };
        try { await api('PUT', `/admin/users/${req.userId}`, bal); toast('Compteurs mis à jour.', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      };
      ov.querySelector('#ee-save').onclick = async () => {
        // 1) Remplaçant (peut échouer pour conflit → on n'altère rien d'autre).
        const repl = ov.querySelector('#ee-repl').value || null;
        if ((repl || null) !== (req.replacedById || null)) {
          try { await api('PUT', `/admin/requests/${req.id}/replacement`, { replacedById: repl }); }
          catch (e) { if (/deux endroits|disponible/i.test(e.message)) { alert('⛔ ' + e.message); } else { toast(e.message, 'err'); } return; }
        }
        // 2) Période + type + décompte (le serveur réajuste le solde).
        const payload = { startDate: ov.querySelector('#ee-start').value, endDate: ov.querySelector('#ee-end').value, days: ov.querySelector('#ee-days').value };
        const tv = typeSel.value;
        if (tv) { const [cat, pool] = tv.split('|'); payload.category = cat; payload.pool = pool || null; }
        if (typeSel.value === 'RCC|' || typeSel.value === 'RCP|' || req.category === 'RCP' || req.category === 'RCC') payload.hours = ov.querySelector('#ee-hours').value;
        try { await api('PUT', `/admin/requests/${req.id}`, payload); closeModal(); toast('Saisie mise à jour, solde réajusté.', 'ok'); refreshAdminBadge(); adminReqs(body); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Attribuer / changer le remplaçant d'une demande (depuis les demandes en attente).
async function replacementModal(req, body, onDone) {
  if (!req) return;
  let team = [], events = [];
  try { team = (await api('GET', '/team')).team; events = (await api('GET', '/calendar')).events; } catch (e) { toast(e.message, 'err'); return; }
  const annotate = (m) => { const c = replacerUnavailableClient(m, events, req.startDate, req.endDate, req.userId); return c ? ` (pas disponible — ${c})` : ''; };
  modal({
    title: `Remplaçant — ${req.userName}`,
    bodyHTML: `
      <p class="help">Période : ${fmtDate(req.startDate)} → ${fmtDate(req.endDate)}. Seuls les salariés disponibles sur cette période sont proposés.</p>
      <label>Remplaçant</label>
      <select id="repl-sel"><option value="">Pas de remplaçant</option>${teamOptgroups(team.filter((m) => m.id !== req.userId && replacerAllowedClient(m)), req.replacedById, annotate)}</select>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="repl-save">Enregistrer</button>`,
    onMount: (ov) => {
      ov.querySelector('#repl-save').onclick = async () => {
        try { await api('PUT', `/admin/requests/${req.id}/replacement`, { replacedById: ov.querySelector('#repl-sel').value || null }); closeModal(); toast('Remplaçant mis à jour.', 'ok'); if (onDone) onDone(); else adminReqs(body); }
        catch (e) { if (/deux endroits|disponible/i.test(e.message)) alert('⛔ ' + e.message); else toast(e.message, 'err'); }
      };
    },
  });
}

function groupChip(r) {
  return r.groupName && r.groupName !== '—'
    ? `<span class="group-chip" style="background:${r.groupColor||'#64748b'}">${esc(r.groupName)}</span>`
    : '<em>—</em>';
}

function adminReqRow(r, rank) {
  return `<tr>
    <td>${esc(r.userName)}${parentTag(r)}</td>
    <td>${groupChip(r)}</td>
    <td><span class="tag" style="background:${catColor(r.category)}22;color:${catColor(r.category)}">${esc(r.category)}</span> ${esc(reqLabel(r))}</td>
    <td>${fmtPeriodLong(r.startDate, r.endDate)}${r.containsHoliday?`<div class="help" style="color:#b45309">⚠️ contient un ou plusieurs jours fériés</div>`:''}
      <div style="margin-top:.2rem">${r.replacedByName?`<span class="help" style="color:var(--brand-2)">Remplacé par : <strong>${esc(r.replacedByName)}</strong></span> `:''}<button class="btn ghost sm" data-repl="${r.id}">${r.replacedByName?'Modifier remplaçant':'+ Remplaçant'}</button></div></td>
    <td>${orderBadge(rank)}</td>
    <td>${r.days} j${reqHours(r)}</td>
    <td class="help">${fmtDateTime(r.createdAt)}<div>par ${esc(r.createdByName||'—')}</div></td>
    <td style="white-space:nowrap">
      <button class="btn ok sm" data-decide="${r.id}|approved">Valider</button>
      <button class="btn danger sm" data-decide="${r.id}|rejected">Refuser</button>
    </td>
  </tr>`;
}

async function adminUsers(body) {
  const { users } = await api('GET', '/admin/users');
  const active = users.filter((u) => u.status === 'active');
  // Regroupe les salariés par groupe pour une lecture claire.
  const order = State.groups.map((g) => g.id).concat([null]);
  const byGroup = {};
  active.forEach((u) => { const k = u.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(u); });

  // CP plafonnés à 30 j (pas de report) → menu déroulant 0 à 30 (pas de 0,5).
  function cpOptions(sel) { let o = ''; for (let i = 0; i <= 30; i += 0.5) o += `<option value="${i}" ${Number(sel) === i ? 'selected' : ''}>${i}</option>`; return o; }
  const numCell = (u, f) => (f === 'congesN' || f === 'congesN1')
    ? `<td><select data-uid="${u.id}" data-bal="${f}" style="width:74px">${cpOptions(u.balances[f])}</select></td>`
    : `<td><input type="number" step="0.5" data-uid="${u.id}" data-bal="${f}" value="${u.balances[f]}" style="width:72px"></td>`;
  function userRow(u) {
    return `<tr>
      <td>${esc(u.firstName)} ${esc(u.lastName)}${u.suspended?' <span class="tag rejected">suspendu</span>':''}
        <div class="help">${roleLabel(u.role)}${u.isParent?' • <strong style="color:var(--text)">Parent</strong>':''}</div>
        <div class="help adm-pii">📍 ${u.address?esc(u.address):'<em>adresse non renseignée</em>'}</div>
        <div class="help adm-pii">✉️ ${u.email?esc(u.email):'—'} &nbsp;·&nbsp; ☎️ ${u.phone?esc(u.phone):'—'}</div>
        <div class="help">Ancienneté : ${u.hireDate?ancienneteText(u.hireDate):'—'}</div>
        ${u.taken?`<div class="help" style="color:var(--brand)">Total déjà pris : CP ${u.taken.cp} j · RCC ${u.taken.rcc} h · Récup ${u.taken.rcp} h</div>`:''}
        <div class="taken-base"><span class="help">Déjà pris (saisi) :</span>
          <label>CP N<select data-tb="${u.id}" data-tbk="congesN">${cpOptions((u.takenBaseline&&u.takenBaseline.congesN)||0)}</select></label>
          <label>CP N-1<select data-tb="${u.id}" data-tbk="congesN1">${cpOptions((u.takenBaseline&&u.takenBaseline.congesN1)||0)}</select></label>
          <label>RCC<input type="number" step="0.5" data-tb="${u.id}" data-tbk="rcc" value="${(u.takenBaseline&&u.takenBaseline.rcc)||0}"></label>
          <label>HSUP<input type="number" step="0.5" data-tb="${u.id}" data-tbk="heuresSupp" value="${(u.takenBaseline&&u.takenBaseline.heuresSupp)||0}"></label>
        </div>
      </td>
      <td>${esc(u.username||'')}${u.username&&u.email?'<br>':''}${u.email?`<span class="help">${esc(u.email)}</span>`:(u.username?'':'<em>—</em>')}</td>
      ${numCell(u,'congesN')}${numCell(u,'congesN1')}${numCell(u,'rcc')}${numCell(u,'heuresSupp')}
      <td><div style="display:flex;flex-wrap:wrap;gap:.3rem">
        <button class="btn ok sm" data-save-user="${u.id}">💾</button>
        <button class="btn sm" style="background:#eab308;color:#3b2f00" data-decompte="${u.id}">Voir son décompte</button>
        <button class="btn sm" data-edit="${u.id}">Modifier son profil</button>
        <button class="btn sm" style="background:#f97316;color:#fff" data-departure="${u.id}">Départ</button>
        <button class="btn ghost sm" data-suspend="${u.id}">${u.suspended?'Réactiver':'Suspendre'}</button>
        <button class="btn danger sm" data-del="${u.id}">Suppr.</button>
      </div></td>
    </tr>`;
  }

  const sections = order.map((gid) => {
    const list = byGroup[gid || 'none'];
    if (!list || !list.length) return '';
    const g = groupById(gid);
    list.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    const title = g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Sans groupe</em>';
    const key = gid || 'none';
    const isOpen = !!_admGrp[key];
    const names = list.map((u) => `${esc(u.firstName)} ${esc(u.lastName)}`).join(' · ');
    return `<div class="card" style="margin-top:1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <h3 style="margin:0;cursor:pointer" data-admgrp="${key}"><span class="veh-caret">${isOpen ? '▾' : '▸'}</span> ${title} <span class="help">${list.length} salarié(s)</span></h3>
        <button class="btn ok sm" data-save-group="${key}">💾 Enregistrer ce groupe</button>
      </div>
      ${isOpen ? `<div class="table-wrap" style="margin-top:.5rem"><table>
        <thead><tr><th>Salarié</th><th>Compte</th><th>CP N</th><th>CP N-1</th><th>RCC (h)</th><th>H. sup.</th><th>Actions</th></tr></thead>
        <tbody>${list.map(userRow).join('')}</tbody></table></div>` : `<p class="help" style="margin:.4rem 0 0">${names}</p>`}
    </div>`;
  }).join('');

  body.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
      <h3 style="margin:0">Salariés actifs (${active.length}) — par groupe</h3>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn ok" id="save-all">💾 Enregistrer toute la page</button>
        <button class="btn accent" id="new-user">+ Créer un utilisateur</button>
      </div>
    </div>
    <p class="help">Modifiez les soldes dans le tableau, puis enregistrez individuellement, par groupe, ou toute la page. Les CP N s'incrémentent automatiquement de +2,5 j/mois ; le RCC est en heures et remis à 0 chaque trimestre s'il n'est pas posé.</p>
    ${active.length===0?'<div class="empty">Aucun salarié actif.</div>':sections}
  </div>`;

  const saveUser = async (uid) => {
    const payload = {};
    body.querySelectorAll(`[data-uid="${uid}"]`).forEach((inp) => { payload[inp.dataset.bal] = inp.value; });
    const tb = {};
    body.querySelectorAll(`[data-tb="${uid}"]`).forEach((inp) => { tb[inp.dataset.tbk] = inp.value; });
    if (Object.keys(tb).length) payload.takenBaseline = tb;
    await api('PUT', `/admin/users/${uid}`, payload);
  };

  body.querySelector('#new-user').onclick = () => userModal(null, body);
  body.querySelector('#save-all').onclick = async () => {
    try { for (const u of active) await saveUser(u.id); toast('Toute la page enregistrée.', 'ok'); adminUsers(body); }
    catch (e) { toast(e.message, 'err'); }
  };
  body.querySelectorAll('[data-edit]').forEach((btn) => btn.onclick = () => userModal(active.find((u) => u.id === btn.dataset.edit), body));
  body.querySelectorAll('[data-decompte]').forEach((btn) => btn.onclick = () => userDecompteModal(active.find((u) => u.id === btn.dataset.decompte)));
  body.querySelectorAll('[data-save-user]').forEach((btn) => btn.onclick = async () => {
    try { await saveUser(btn.dataset.saveUser); toast('Salarié enregistré.', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-del]').forEach((btn) => btn.onclick = async () => {
    const u = active.find((x) => x.id === btn.dataset.del);
    if (!confirm(`⚠️ SUPPRESSION DÉFINITIVE\n\nConfirmez-vous la suppression de ${u.firstName} ${u.lastName} et de toutes ses demandes ? Cette action est irréversible.`)) return;
    try { await api('DELETE', `/admin/users/${u.id}`); toast('Utilisateur supprimé.', 'ok'); adminUsers(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-suspend]').forEach((btn) => btn.onclick = async () => {
    const u = active.find((x) => x.id === btn.dataset.suspend);
    const action = u.suspended ? 'réactiver' : 'suspendre';
    if (!confirm(`Confirmez-vous de ${action} l'accès de ${u.firstName} ${u.lastName} ?`)) return;
    try { await api('PUT', `/admin/users/${u.id}/suspend`, { suspended: !u.suspended }); toast(`Accès ${u.suspended?'réactivé':'suspendu'}.`, 'ok'); adminUsers(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-departure]').forEach((btn) => btn.onclick = () => departureModal(active.find((u) => u.id === btn.dataset.departure), body));
  body.querySelectorAll('[data-save-group]').forEach((btn) => btn.onclick = async () => {
    const list = byGroup[btn.dataset.saveGroup] || [];
    try { for (const u of list) await saveUser(u.id); toast('Soldes du groupe enregistrés.', 'ok'); adminUsers(body); }
    catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-admgrp]').forEach((el) => el.onclick = () => { const k = el.dataset.admgrp; _admGrp[k] = !_admGrp[k]; adminUsers(body); });
}

// Popup de confirmation de départ (démission / licenciement).
function departureModal(u, body) {
  modal({
    title: `Départ de ${u.firstName} ${u.lastName}`,
    bodyHTML: `
      <p>Confirmez le départ de ce salarié. Toutes ses réservations sur le calendrier seront <strong>supprimées</strong> et son accès <strong>suspendu</strong> (le compte est conservé pour l'historique).</p>
      <label>Motif du départ</label>
      <select id="dep-mode"><option value="demission">Démission</option><option value="licenciement">Licenciement</option></select>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn" style="background:#f97316;color:#fff" id="dep-ok">Confirmer le départ</button>`,
    onMount: (ov) => {
      ov.querySelector('#dep-ok').onclick = async () => {
        try { const r = await api('POST', `/admin/users/${u.id}/departure`, { mode: ov.querySelector('#dep-mode').value }); closeModal(); toast(`Départ enregistré, ${r.removed} réservation(s) libérée(s).`, 'ok'); adminUsers(body); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Décompte par motif d'un salarié, filtrable par année (assiduité).
async function userDecompteModal(u) {
  let requests = [];
  try { requests = (await api('GET', '/admin/requests')).requests.filter((r) => r.userId === u.id && r.status === 'approved'); }
  catch (e) { toast(e.message, 'err'); return; }
  const years = Array.from(new Set(requests.map((r) => r.startDate.slice(0, 4)))).sort().reverse();
  const curYear = String(new Date().getFullYear());
  const defYear = years.includes(curYear) ? curYear : (years[0] || curYear);

  function table(year) {
    const subset = year === 'all' ? requests : requests.filter((r) => r.startDate.slice(0, 4) === year);
    const rows = decompteRows(subset);
    const totalDays = subset.reduce((s, r) => s + r.days, 0);
    const totalHours = subset.reduce((s, r) => s + r.hours, 0);
    return `<div class="table-wrap"><table>
      <thead><tr><th>Motif</th><th style="text-align:right">Jours</th><th style="text-align:right">Heures</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>Total absences</th><th style="text-align:right">${totalDays} j</th><th style="text-align:right">${totalHours} h</th></tr></tfoot>
    </table></div>`;
  }

  modal({
    title: `Décompte — ${u.firstName} ${u.lastName}`,
    bodyHTML: `
      <label>Année</label>
      <select id="dc-year">
        <option value="all">Toutes les années</option>
        ${years.map((y) => `<option value="${y}" ${y===defYear?'selected':''}>${y}</option>`).join('')}
      </select>
      <div id="dc-table" style="margin-top:1rem">${table(defYear)}</div>`,
    footHTML: `<button class="btn" data-close>Fermer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#dc-year').onchange = (e) => { overlay.querySelector('#dc-table').innerHTML = table(e.target.value); };
    },
  });
}

// --- Export PDF mois par mois (archivage) ------------------------------------
async function adminExport(body) {
  const [{ requests }, { users }] = await Promise.all([
    api('GET', '/admin/requests'),
    api('GET', '/admin/users'),
  ]);
  const active = users.filter((u) => u.status === 'active');
  const now = new Date();
  const defMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

  function render(month) {
    const mStart = month + '-01';
    const [y, m] = month.split('-').map(Number);
    const mEnd = `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
    const monthName = `${MONTHS[m - 1]} ${y}`;
    // Absences validées chevauchant le mois.
    const inMonth = requests.filter((r) => r.status === 'approved' && r.startDate <= mEnd && r.endDate >= mStart);

    const order = State.groups.map((g) => g.id).concat([null]);
    const byGroup = {};
    inMonth.forEach((r) => { const k = r.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(r); });

    const absSections = order.map((gid) => {
      const list = byGroup[gid || 'none'];
      if (!list || !list.length) return '';
      const g = groupById(gid);
      list.sort((a, b) => a.startDate.localeCompare(b.startDate));
      return `<h3>${g ? esc(g.name) : 'Sans groupe'}</h3>
        <table class="report-table"><thead><tr><th>Salarié</th><th>Motif</th><th>Du</th><th>Au</th><th>Jours</th></tr></thead>
        <tbody>${list.map((r) => `<tr><td>${esc(r.userName)}</td><td>${esc(r.category)} — ${esc(catLabel(r.category))}</td><td>${fmtDate(r.startDate)}</td><td>${fmtDate(r.endDate)}</td><td>${r.days}</td></tr>`).join('')}</tbody></table>`;
    }).join('') || '<p>Aucune absence validée sur ce mois.</p>';

    const balRows = active.slice().sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName))
      .map((u) => `<tr><td>${esc(u.firstName)} ${esc(u.lastName)}</td><td>${esc((groupById(u.groupId)||{}).name||'—')}</td><td>${u.balances.congesN}</td><td>${u.balances.congesN1}</td><td>${u.balances.rcc}</td><td>${u.balances.heuresSupp}</td></tr>`).join('');

    return `
      <div class="report-head">
        <h1>INTER COLIS SERVICES — Récapitulatif ${esc(monthName)}</h1>
        <p>Édité le ${fmtDate(iso(new Date()))}</p>
      </div>
      <h2>Absences du mois</h2>
      ${absSections}
      <h2>Soldes des salariés (à l'édition)</h2>
      <table class="report-table"><thead><tr><th>Salarié</th><th>Groupe</th><th>CP N</th><th>CP N-1</th><th>RCC</th><th>H. sup.</th></tr></thead>
      <tbody>${balRows}</tbody></table>`;
  }

  body.innerHTML = `<div class="card">
    <h3>Export / archivage mensuel (PDF)</h3>
    <p class="help">Choisissez un mois puis « Imprimer / PDF ». Dans la fenêtre d'impression, sélectionnez « Enregistrer au format PDF » pour archiver.</p>
    <div style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap">
      <div><label>Mois</label><input type="month" id="exp-month" value="${defMonth}"></div>
      <button class="btn accent" id="exp-print">🖨️ Imprimer / PDF</button>
    </div>
  </div>
  <div class="card"><div id="print-area">${render(defMonth)}</div></div>`;

  body.querySelector('#exp-month').onchange = (e) => { body.querySelector('#print-area').innerHTML = render(e.target.value); };
  body.querySelector('#exp-print').onclick = () => window.print();
}

// Modal de création (u = null) ou d'édition complète d'un utilisateur.
function userModal(u, body) {
  const isNew = !u;
  const b = (u && u.balances) || { congesN: 0, congesN1: 0, rcc: 0, heuresSupp: 0 };
  modal({
    title: isNew ? 'Créer un utilisateur' : `Modifier ${u.firstName} ${u.lastName}`,
    bodyHTML: `
      <div class="row">
        <div><label>Prénom</label><input id="eu-firstName" value="${u?esc(u.firstName):''}"></div>
        <div><label>Nom</label><input id="eu-lastName" value="${u?esc(u.lastName):''}"></div>
      </div>
      <div class="row">
        <div><label>Nom de compte</label><input id="eu-username" value="${u&&u.username?esc(u.username):''}" autocomplete="off" placeholder="ex. m.dupont"></div>
        <div><label>Email (facultatif)</label><input id="eu-email" type="email" value="${u&&u.email?esc(u.email):''}" autocomplete="off"></div>
      </div>
      <div class="row">
        <div><label>Téléphone</label><input id="eu-phone" type="tel" value="${u&&u.phone?esc(u.phone):''}" placeholder="06 12 34 56 78"></div>
        <div><label>Parent</label><select id="eu-parent"><option value="">Non</option><option value="1" ${u&&u.isParent?'selected':''}>Oui</option></select></div>
      </div>
      <label>Adresse postale <span class="help">(donnée personnelle — chiffrée, visible administrateur uniquement)</span></label>
      <input id="eu-address" value="${u&&u.address?esc(u.address):''}" placeholder="N° rue, code postal ville">
      <div class="row">
        <div><label>Date d'entrée dans l'entreprise</label><input id="eu-hire" type="date" value="${u&&u.hireDate?esc(u.hireDate):''}"></div>
        <div><label>Date de naissance</label><input id="eu-birth" type="date" value="${u&&u.birthDate?esc(u.birthDate):''}"></div>
      </div>
      <label>${isNew?'Mot de passe':'Nouveau mot de passe (laisser vide pour ne pas changer)'}</label>
      <input id="eu-password" type="password" autocomplete="new-password" placeholder="6 caractères minimum">
      <div class="row">
        <div><label>Groupe</label><select id="eu-groupId">${groupOptions(u?u.groupId:null)}</select></div>
        <div><label>Rôle</label><select id="eu-role"><option value="employee" ${u&&u.role==='employee'?'selected':''}>Salarié</option><option value="responsable" ${u&&u.role==='responsable'?'selected':''}>Responsable</option><option value="admin" ${u&&u.role==='admin'?'selected':''}>Administrateur</option></select></div>
      </div>
      <div class="row">
        <div><label>Congés N (j)</label><input type="number" step="0.5" id="eu-congesN" value="${b.congesN}"></div>
        <div><label>Congés N-1 (j)</label><input type="number" step="0.5" id="eu-congesN1" value="${b.congesN1}"></div>
      </div>
      <div class="row">
        <div><label>RCC (j)</label><input type="number" step="0.5" id="eu-rcc" value="${b.rcc}"></div>
        <div><label>H. sup. restant dues (h)<span class="help"> — après paiement du reste</span></label><input type="number" step="0.5" id="eu-heuresSupp" value="${b.heuresSupp}"></div>
      </div>
      <p class="help" style="margin:.2rem 0 0">« H. sup. restant dues » = heures supplémentaires encore dues au salarié <strong>après paiement</strong> des autres (celles qu'il peut récupérer).</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn ${isNew?'accent':''}" id="eu-save">${isNew?'Créer le compte':'Enregistrer'}</button>`,
    onMount: (overlay) => {
      const val = (id) => overlay.querySelector(id).value;
      overlay.querySelector('#eu-save').onclick = async () => {
        const payload = {
          firstName: val('#eu-firstName'), lastName: val('#eu-lastName'),
          username: val('#eu-username'), email: val('#eu-email'), phone: val('#eu-phone'), hireDate: val('#eu-hire'),
          address: val('#eu-address'), birthDate: val('#eu-birth'),
          isParent: !!val('#eu-parent'),
          password: val('#eu-password'),
          groupId: val('#eu-groupId'), role: val('#eu-role'),
          congesN: val('#eu-congesN'), congesN1: val('#eu-congesN1'),
          rcc: val('#eu-rcc'), heuresSupp: val('#eu-heuresSupp'),
        };
        try {
          if (isNew) { await api('POST', '/admin/users', payload); toast('Compte créé.', 'ok'); }
          else { await api('PUT', `/admin/users/${u.id}`, payload); toast('Salarié mis à jour.', 'ok'); }
          closeModal(); adminUsers(body); refreshAdminBadge();
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// Suivi des acceptations du règlement intérieur + génération d'attestations PDF.
async function adminReglement(body) {
  const { users, current, history } = await api('GET', '/admin/reglement-status');
  users.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  const nbOk = users.filter((u) => u.upToDate).length;
  const curV = current.version;
  const hist = (history || []).slice().sort((a, b) => b.version - a.version);
  body.innerHTML = `<div class="card">
    <h3>Règlement intérieur — version en vigueur</h3>
    <p style="margin:-.4rem 0 .6rem"><strong>${esc(current.label || ('Version ' + curV))}</strong> — mise en ligne le <strong>${fmtDateTimeS(current.updatedAt)}</strong>.</p>
    <h4 style="margin:.4rem 0">Historique des versions</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>Version</th><th>Intitulé</th><th>Date de mise en ligne</th><th>Salariés à jour</th></tr></thead>
      <tbody>${hist.map((h) => {
        const okN = users.filter((u) => (u.reglementAcceptedVersion || 0) >= h.version).length;
        return `<tr${h.version===curV?' style="background:#f0fdf4"':''}><td><strong>v${h.version}</strong>${h.version===curV?' <span class="tag approved">en vigueur</span>':''}</td><td>${esc(h.label||'')}</td><td class="help">${fmtDateTimeS(h.updatedAt)}</td><td>${okN}/${users.length}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>
  <div class="card">
    <h3>Suivi des acceptations — ${nbOk}/${users.length} à jour</h3>
    <p class="help" style="margin-top:-.6rem">« À jour » = a accepté la version en vigueur (v${curV}). Générez une attestation PDF pour vos dossiers.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Salarié</th><th>Groupe</th><th>Statut</th><th>Version acceptée</th><th>Date & heure d'acceptation</th><th>Attestation</th></tr></thead>
      <tbody>${users.map((u) => { const g = groupById(u.groupId); const av = u.reglementAcceptedVersion || 0; return `<tr>
        <td>${esc(u.firstName)} ${esc(u.lastName)}<div class="help">salarié</div></td>
        <td>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'—'}</td>
        <td>${u.upToDate?`<span class="tag approved">Lu et approuvé (à jour)</span>`:(av>0?`<span class="tag pending">Doit ré-accepter (v${av})</span>`:`<span class="tag rejected">Jamais accepté</span>`)}</td>
        <td>${av>0?`v${av}`:'—'}</td>
        <td class="help">${u.reglementAcceptedAt?fmtDateTimeS(u.reglementAcceptedAt):'—'}</td>
        <td>${av>0?`<button class="btn ghost sm" data-attest="${u.id}">📄 Attestation PDF</button>`:'<span class="help">—</span>'}</td>
      </tr>`; }).join('')}</tbody>
    </table></div>
  </div>`;
  body.querySelectorAll('[data-attest]').forEach((btn) => btn.onclick = () => attestationModal(users.find((u) => u.id === btn.dataset.attest)));
}

// Attestation de remise du règlement intérieur (imprimable / PDF).
function attestationModal(u) {
  if (!u) return;
  const dt = u.reglementAcceptedAt ? fmtDateTimeS(u.reglementAcceptedAt) : fmtDateTimeS(new Date().toISOString());
  const today = fmtDateTimeS(new Date().toISOString());
  const ri = State.reglement || {};
  const ver = u.reglementAcceptedVersion ? ` (version v${u.reglementAcceptedVersion}${ri.label?` — ${esc(ri.label)}`:''})` : '';
  modal({
    title: 'Attestation de remise du règlement intérieur',
    bodyHTML: `
      <div id="attest-print" class="attestation">
        <div class="att-head">
          <img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" class="att-logo" alt="">
          <div>
            <strong>INTER COLIS SERVICES</strong><br>
            SASU au capital de 12 700 € – SIRET : 820 323 350 00042<br>
            Zone de l'Intendance – 14930 Éterville
          </div>
        </div>
        <h2 style="text-align:center;margin:1.4rem 0">ACCUSÉ DE RÉCEPTION ET ATTESTATION DE REMISE</h2>
        <p>Je soussigné(e), <strong>${esc(u.firstName)} ${esc(u.lastName)}</strong>, salarié(e) de la société INTER COLIS SERVICES, en qualité de <strong>salarié</strong>,</p>
        <p>Déclare avoir reçu ce jour un exemplaire du Règlement Intérieur de la Société INTER COLIS SERVICES${ver}, en avoir pris connaissance et m'engager à le respecter dans son intégralité.</p>
        <p>Fait à Éterville, le ${dt}.</p>
        <p style="margin-top:1.6rem">Signature du salarié précédée de la mention manuscrite « Lu et approuvé » :</p>
        <p style="margin-top:.6rem">${esc(u.firstName)} ${esc(u.lastName)} — « Lu et approuvé » le ${dt}.</p>
        <div style="height:1.2rem"></div>
        <p style="margin-top:1.6rem">Pour la Direction d'ICS – Quentin Routel, Directeur :</p>
        <p style="margin-top:.6rem">Quentin Routel, Directeur — « Lu et approuvé » le ${today}.</p>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>Fermer</button><button class="btn accent" id="att-print-btn">🖨️ Imprimer / PDF</button>`,
    onMount: (ov) => {
      ov.querySelector('#att-print-btn').onclick = () => {
        // Impression ciblée de l'attestation via une fenêtre dédiée.
        const w = window.open('', '_blank');
        w.document.write(`<html><head><title>Attestation - ${esc(u.firstName)} ${esc(u.lastName)}</title>
          <style>body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;padding:2.5rem;line-height:1.6}
          .att-head{display:flex;gap:1rem;align-items:center;border-bottom:2px solid #14427e;padding-bottom:1rem}
          .att-logo{width:64px;height:64px;object-fit:contain}
          h2{color:#14427e}</style></head><body>${ov.querySelector('#attest-print').innerHTML}</body></html>`);
        w.document.close();
        setTimeout(() => { w.focus(); w.print(); }, 300);
      };
    },
  });
}

async function adminGroups(body) {
  body.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
      <h3 style="margin:0">Groupes de travail & couleurs</h3>
      <button class="btn accent" id="new-group">+ Ajouter un groupe</button>
    </div>
    <p class="help">Chaque groupe a une couleur utilisée sur le calendrier. Supprimer un groupe replace ses salariés en « sans groupe ».</p>
    <div class="table-wrap"><table><thead><tr><th>Nom</th><th>Couleur</th><th></th></tr></thead>
    <tbody>${State.groups.map((g) => `<tr>
      <td><input value="${esc(g.name)}" id="g-name-${g.id}" style="max-width:220px"></td>
      <td><input type="color" value="${g.color}" id="g-color-${g.id}" style="width:60px;height:38px;padding:2px"></td>
      <td style="white-space:nowrap"><button class="btn sm" data-save-group="${g.id}">Enregistrer</button> <button class="btn danger sm" data-del-group="${g.id}">Suppr.</button></td>
    </tr>`).join('')}</tbody></table></div></div>`;
  body.querySelector('#new-group').onclick = () => modal({
    title: 'Nouveau groupe de travail',
    bodyHTML: `<label>Nom</label><input id="ng-name" placeholder="Ex. Nuit"><label>Couleur</label><input type="color" id="ng-color" value="#64748b" style="width:80px;height:40px;padding:2px">`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="ng-save">Créer</button>`,
    onMount: (ov) => { ov.querySelector('#ng-save').onclick = async () => {
      try { const { group } = await api('POST', '/admin/groups', { name: ov.querySelector('#ng-name').value, color: ov.querySelector('#ng-color').value }); State.groups.push(group); closeModal(); toast('Groupe créé.', 'ok'); adminGroups(body); }
      catch (e) { toast(e.message, 'err'); }
    }; },
  });
  body.querySelectorAll('[data-save-group]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.saveGroup;
    try {
      const { group } = await api('PUT', `/admin/groups/${id}`, { name: document.getElementById('g-name-'+id).value, color: document.getElementById('g-color-'+id).value });
      const idx = State.groups.findIndex((g) => g.id === id); State.groups[idx] = group;
      toast('Groupe mis à jour.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-del-group]').forEach((btn) => btn.onclick = async () => {
    const g = groupById(btn.dataset.delGroup);
    if (!confirm(`Supprimer le groupe « ${g ? g.name : ''} » ? Ses salariés seront « sans groupe ».`)) return;
    try { await api('DELETE', `/admin/groups/${btn.dataset.delGroup}`); State.groups = State.groups.filter((x) => x.id !== btn.dataset.delGroup); toast('Groupe supprimé.', 'ok'); adminGroups(body); }
    catch (e) { toast(e.message, 'err'); }
  });
}

const CORE_CATS = ['DCP', 'CP', 'RCP'];
async function adminCategories(body) {
  body.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
      <h3 style="margin:0">Motifs d'absence & couleurs</h3>
      <button class="btn accent" id="new-cat">+ Ajouter un motif</button>
    </div>
    <p class="help">Ajustez chaque couleur pour qu'elle corresponde à votre planning. Vous pouvez aussi créer vos propres motifs.</p>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Libellé</th><th>Couleur</th><th>Décompte</th><th></th></tr></thead>
    <tbody>${State.categories.map((c) => {
      const ded = c.code==='CP' ? 'Congés N / N-1 (jours)' : c.code==='RCP' ? 'Heures supplémentaires (heures)' : c.code==='RCC' ? 'Compteur RCC (heures)' : c.code==='RET' ? 'Compteur de retards (nombre)' : c.code==='DCP' ? 'Demande de CP (en attente)' : 'Aucun (suivi)';
      return `<tr>
        <td><span class="group-chip" style="background:${c.color}">${esc(c.code)}</span></td>
        <td><input value="${esc(c.label)}" id="c-name-${c.code}"></td>
        <td><input type="color" value="${c.color}" id="c-color-${c.code}" style="width:60px;height:38px;padding:2px"></td>
        <td class="help">${ded}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-save-cat="${c.code}">Enregistrer</button>${CORE_CATS.includes(c.code)?'':` <button class="btn danger sm" data-del-cat="${c.code}">Suppr.</button>`}</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
  body.querySelector('#new-cat').onclick = () => newCategoryModal(body);
  body.querySelectorAll('[data-save-cat]').forEach((btn) => btn.onclick = async () => {
    const code = btn.dataset.saveCat;
    try {
      const { category } = await api('PUT', `/admin/categories/${code}`, { label: document.getElementById('c-name-'+code).value, color: document.getElementById('c-color-'+code).value });
      const idx = State.categories.findIndex((c) => c.code === code);
      State.categories[idx] = category; State.catByCode[code] = category;
      toast('Motif mis à jour.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
  body.querySelectorAll('[data-del-cat]').forEach((btn) => btn.onclick = async () => {
    const code = btn.dataset.delCat;
    if (!confirm(`Supprimer le motif ${code} ?`)) return;
    try {
      await api('DELETE', `/admin/categories/${code}`);
      State.categories = State.categories.filter((c) => c.code !== code);
      delete State.catByCode[code];
      toast('Motif supprimé.', 'ok'); adminCategories(body);
    } catch (e) { toast(e.message, 'err'); }
  });
}

function newCategoryModal(body) {
  modal({
    title: 'Nouveau motif d\'absence',
    bodyHTML: `
      <label>Code court (ex. CSS)</label>
      <input id="nc-code" maxlength="6" placeholder="Lettres / chiffres" style="text-transform:uppercase">
      <label>Libellé</label>
      <input id="nc-label" placeholder="ex. Congés sans solde">
      <label>Couleur</label>
      <input type="color" id="nc-color" value="#64748b" style="width:80px;height:40px;padding:2px">
      <p class="help">Le motif sera proposé dans les demandes et affiché sur le calendrier (sans décompte de solde).</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="nc-save">Créer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#nc-save').onclick = async () => {
        try {
          const { category } = await api('POST', '/admin/categories', {
            code: overlay.querySelector('#nc-code').value,
            label: overlay.querySelector('#nc-label').value,
            color: overlay.querySelector('#nc-color').value,
          });
          State.categories.push(category); State.catByCode[category.code] = category;
          closeModal(); toast('Motif créé.', 'ok'); adminCategories(body);
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

/* ------------------------------ Start ----------------------------------- */
boot();
