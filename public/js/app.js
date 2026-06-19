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
// Message de remerciement proportionnel à l'ancienneté.
function anciennetePhilo(hireDate) {
  const p = ancienneteParts(hireDate);
  if (!p) return '';
  const y = p.years;
  if (y < 1) return "Bienvenue dans l'aventure ! Vos premiers pas comptent déjà pour toute l'équipe. 🌱";
  if (y < 3) return `${y} an${y>1?'s':''} déjà : votre engagement prend racine. Merci pour votre implication ! 🌿`;
  if (y < 5) return `${y} ans de fidélité : votre expérience est précieuse pour le collectif. Merci de votre constance. 🌳`;
  if (y < 10) return `${y} ans parmi nous : un pilier de la maison. Votre dévouement force le respect. Merci infiniment. 🏅`;
  return `${y} ans de loyauté : une véritable mémoire vivante de l'entreprise. Du fond du cœur, merci pour tout. 🎖️`;
}
// Nombre de retards (RET validés) d'un utilisateur depuis N jours.
function retardCountSince(requests, sinceDays) {
  const limit = iso(addDays(new Date(), -sinceDays));
  return requests.filter((r) => r.category === 'RET' && r.status === 'approved' && r.startDate >= limit).length;
}

// Message philosophique selon le nombre de retards sur l'année (motivation).
function philoMessageHTML(retardYear) {
  const pick = (arr) => arr[Math.floor(Date.now() / 86400000) % arr.length];
  let bg, emoji, msg;
  if (retardYear === 0) {
    bg = 'var(--ok)'; emoji = '🌟';
    msg = pick([
      "« La ponctualité est la politesse des rois. » Merci pour votre dévouement et votre régularité exemplaire.",
      "Toujours à l'heure : votre fiabilité est un pilier de l'équipe. Merci pour votre engagement sans faille.",
      "« Le succès, c'est se lever une fois de plus qu'on est tombé. » Votre constance fait la force du collectif. Bravo !",
    ]);
  } else if (retardYear <= 3) {
    bg = '#eab308'; emoji = '⏳';
    msg = pick([
      "« Mieux vaut prévenir que guérir. » Quelques retards seulement : un petit effort et vous visez le sans-faute !",
      "Chaque minute compte pour l'équipe. Vous êtes sur la bonne voie, gardez le cap !",
      "« Le temps perdu ne se rattrape jamais. » Anticipez vos trajets, vous y êtes presque.",
    ]);
  } else if (retardYear <= 5) {
    bg = '#f97316'; emoji = '⚠️';
    msg = pick([
      "« La discipline est le pont entre les objectifs et les réalisations. » Quelques retards de trop : reprenons de bonnes habitudes ensemble.",
      "Votre équipe compte sur vous chaque matin. Un effort sur la ponctualité ferait une vraie différence.",
      "« Qui veut voyager loin ménage sa monture… et part à l'heure. » Anticipons davantage les départs.",
    ]);
  } else {
    bg = 'var(--danger)'; emoji = '🚨';
    msg = pick([
      "« On ne récolte que ce que l'on sème. » Le nombre de retards devient préoccupant : un vrai changement d'habitude est nécessaire.",
      "La ponctualité est une marque de respect envers vos collègues. Reprenons ensemble le contrôle de vos horaires.",
      "« Demain est aujourd'hui ce qu'aujourd'hui était hier. » Agissons dès maintenant pour inverser la tendance.",
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
// Menu organisé en catégories propres. "Droits & devoirs" est placé en bas.
function navSections() {
  const sections = [
    { title: '', items: [{ id: 'dashboard', icon: '🏠', label: 'Accueil' }] },
    { title: 'Planning', items: [
      { id: 'calendar', icon: '📅', label: 'Mon Planning' },
      { id: 'organigramme', icon: '🏢', label: 'Organigramme' },
    ] },
    { title: 'Mon espace', items: [
      { id: 'mydata', icon: '👤', label: 'Mon Profil' },
      { id: 'requests', icon: '📝', label: 'Mes événements' },
      { id: 'team', icon: '👥', label: 'Mon équipe' },
      ...(isStaff() ? [{ id: 'absmgmt', icon: '🗂️', label: 'Gestion des absences' }] : []),
    ] },
  ];
  if (State.user.role === 'admin') {
    sections.push({ title: 'Gestion', items: [{ id: 'admin', icon: '⚙️', label: 'Administration' }] });
  }
  sections.push({ title: 'Informations', items: [{ id: 'info', icon: 'ℹ️', label: 'Droits & devoirs' }] });
  return sections;
}

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

function renderApp() {
  const u = State.user;
  // Pages de garde au premier accès : CGU puis règlement intérieur (version en vigueur).
  if (!u.cguAccepted) { renderCGU(); return; }
  if (!reglementUpToDate(u)) { renderReglementGate(); return; }
  const sections = navSections();
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><img src="/img/logo.png" onerror="this.onerror=null;this.src='/img/logo.svg'" alt="" class="brand-logo" /><span>Inter Colis Services</span></div>
      <button class="nav-toggle" id="nav-toggle" aria-label="Menu">☰</button>
      <nav id="nav">
        ${sections.map((s) => `
          ${s.title ? `<div class="nav-section">${s.title}</div>` : ''}
          ${s.items.map((it) => `
            <button data-view="${it.id}" class="${State.view===it.id?'active':''}">
              <span class="ico">${it.icon}</span> ${it.label}
              ${it.id==='admin' ? `<span class="badge" id="admin-badge" style="display:none"></span>` : ''}
            </button>`).join('')}
        `).join('')}
      </nav>
      <div class="userbox">
        <div class="name">${esc(u.firstName)} ${esc(u.lastName)}</div>
        <div class="role">${roleLabel(u.role)}</div>
        <button class="btn ghost sm" id="logout" style="color:#fff;border-color:rgba(255,255,255,.3)">Déconnexion</button>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $app.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { State.view = b.dataset.view; renderApp(); });
  document.getElementById('logout').onclick = () => logout();
  const toggle = document.getElementById('nav-toggle');
  if (toggle) toggle.onclick = () => document.querySelector('.sidebar').classList.toggle('nav-open');
  renderView();
  if (u.role === 'admin') refreshAdminBadge();
}

async function refreshAdminBadge() {
  try {
    const { users } = await api('GET', '/admin/pending');
    const { requests } = await api('GET', '/admin/requests');
    const pendingReq = requests.filter((r) => r.status === 'pending').length;
    adminBadgeCount = users.length + pendingReq;
    const el = document.getElementById('admin-badge');
    if (el && adminBadgeCount > 0) { el.style.display = ''; el.textContent = adminBadgeCount; }
  } catch (e) {}
}

function renderView() {
  const main = document.getElementById('main');
  const v = State.view;
  if (v === 'dashboard') return renderDashboard(main);
  if (v === 'calendar') return renderCalendar(main);
  if (v === 'mydata') return renderMyData(main);
  if (v === 'requests') return renderRequests(main);
  if (v === 'team') return renderTeam(main);
  if (v === 'organigramme') return renderOrganigramme(main);
  if (v === 'absmgmt') return renderAbsenceManagement(main);
  if (v === 'info') return renderInfo(main);
  if (v === 'admin') return renderAdmin(main);
}

/* =========================================================================
   DASHBOARD — semaine en cours / à venir + soldes
   ========================================================================= */
async function renderDashboard(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Bonjour ${esc(State.user.firstName)} 👋</h1>
    <p>Voici un aperçu de votre situation et de l'équipe.</p></div></div>
    <div id="dash-body" class="empty">Chargement…</div>`;
  try {
    const today = new Date();
    await ensureHolidays(today.getFullYear());
    await ensureHolidays(today.getFullYear() + 1);
    const { events } = await api('GET', '/calendar');
    const { user } = await api('GET', '/me');
    State.user = user;
    const b = user.balances;

    const curStart = startOfWeekMonday(today);
    const prevStart = addDays(curStart, -7);   // semaine précédente
    const next1 = addDays(curStart, 7);        // +1
    const next2 = addDays(curStart, 14);       // +2

    const isAdmin = State.user.role === 'admin';
    const staff = isStaff();
    const { team } = await api('GET', '/team').catch(() => ({ team: [] }));

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
    const myRetards = events.filter((e) => e.userId === State.user.id && e.category === 'RET' && e.status === 'approved');
    const retardCards = `<div class="grid cols-4">
      ${statCard('Retards 30 j', retardCountSince(myRetards, 30), 'retard(s)')}
      ${statCard('Retards 90 j', retardCountSince(myRetards, 90), 'retard(s)')}
      ${statCard('Retards (semestre)', retardCountSince(myRetards, 182), 'retard(s)')}
      ${statCard('Retards (année)', retardCountSince(myRetards, 365), 'retard(s)', true)}
    </div>`;
    const classement = staff ? retardRankingHTML(events, team) : '';
    const philo = philoMessageHTML(retardCountSince(myRetards, 365));

    // Alerte conflits de dates dans mon groupe
    const conflictPanel = conflictAlertHTML(events, team);

    // Congés à venir des collègues du même groupe (pour éviter les doublons).
    const colleaguesPanel = colleaguesUpcomingHTML(team, events);

    const anc = State.user.hireDate ? `<div class="card" style="border-left:5px solid var(--brand)"><h3 style="margin:0">📅 Votre ancienneté : ${ancienneteText(State.user.hireDate)}</h3><p style="margin:.4rem 0 0">${anciennetePhilo(State.user.hireDate)}</p><p class="help" style="margin:.3rem 0 0">Date d'entrée : ${fmtDate(State.user.hireDate)}</p></div>` : '';

    const dashBody = document.getElementById('dash-body');
    dashBody.className = '';
    dashBody.innerHTML = `
      ${anc}
      <div class="grid cols-4">
        ${statCard('Congés N', b.congesN, 'jours')}
        ${statCard('Congés N-1', b.congesN1, 'jours')}
        ${statCard('RCC', b.rcc, 'h', false, hToDays(b.rcc))}
        ${statCard('Récup. / Heures sup.', b.heuresSupp, 'h', true, hToDays(b.heuresSupp))}
      </div>
      ${philo}
      ${retardCards}
      ${conflictPanel}
      ${pendingPanel}
      ${priorityPanel}
      ${classement}
      ${colleaguesPanel}
      ${dashWeekCard('Semaine précédente', prevStart, events, false, true)}
      ${dashWeekCard('Semaine en cours', curStart, events, true)}
      ${dashWeekCard('Semaine à venir (+1)', next1, events)}
      ${dashWeekCard('Dans deux semaines (+2)', next2, events)}`;
  } catch (e) {
    document.getElementById('dash-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
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
      <h3>🔔 Alertes — salariés à faire poser leurs congés</h3>
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
        <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
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
  if (staff) {
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
  const upcoming = events.filter((e) => mates.has(e.userId) && e.endDate >= t && e.category !== 'RET')
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
function dashWeekCard(title, weekStart, events, isCurrent, isPast) {
  const weekDays = [...Array(6)].map((_, i) => addDays(weekStart, i));
  const weekEnd = addDays(weekStart, 5);
  const label = `${pad(weekStart.getDate())}/${pad(weekStart.getMonth()+1)} → ${pad(weekEnd.getDate())}/${pad(weekEnd.getMonth()+1)}`;
  const weekAbs = events.filter((ev) => ev.startDate <= iso(weekEnd) && ev.endDate >= iso(weekStart));
  // Liste détaillée : salarié, groupe, dates et motif.
  const byUser = {};
  weekAbs.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { ev }).ev = byUser[ev.userId].ev; (byUser[ev.userId].list = byUser[ev.userId].list || []).push(ev); });
  const detail = Object.values(byUser).map((o) => o.list.map((ev) => {
    const range = ev.startDate === ev.endDate ? fmtDate(ev.startDate) : `${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)}`;
    return `<tr><td>${esc(ev.userName)}</td><td><span class="group-chip" style="background:${ev.groupColor}">${esc(ev.groupName)}</span></td><td>${range}</td><td><span class="tag" style="background:${catColor(ev.code)}22;color:${catColor(ev.code)}">${esc(ev.code)}</span> ${esc(ev.categoryLabel)}</td></tr>`;
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
      ${detail ? `<div class="table-wrap" style="margin-top:.8rem"><table><thead><tr><th>Salarié</th><th>Groupe</th><th>Dates</th><th>Motif</th></tr></thead><tbody>${detail}</tbody></table></div>` : ''}
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
  main.innerHTML = `<div class="page-head"><div><h1>Mon Planning</h1>
    <p>Présences et absences de tous les salariés inscrits.</p></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      ${admin?`<button class="btn ghost" id="cal-close">🔒 Fermer des jours</button>`:''}
      ${staff?`<button class="btn ghost" id="cal-lock">🔐 Verrouiller mon planning</button>`:''}
      ${staff?`<button class="btn accent" id="cal-add">+ Attribuer une absence</button>`:''}
    </div></div>
    <div class="card" id="cal-card"><div class="empty">Chargement…</div></div>`;
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
        <select name="replacedById"><option value="">— Personne —</option></select>
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
        f.replacedById.innerHTML = `<option value="">— Personne —</option>` + teamOptgroups(team.filter((m) => m.id !== exceptId), current, annotate);
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
  else if (mode === 'month') title = `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
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
        ${['day','week','month','year'].map((m) => `<button data-mode="${m}" class="${mode===m?'active':''}">${({day:'Jour',week:'Semaine',month:'Mois',year:'Année'})[m]}</button>`).join('')}
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
  if (mode === 'day') grid.innerHTML = viewDay(cursor);
  else if (mode === 'week') grid.innerHTML = viewWeek(cursor);
  else if (mode === 'month') grid.innerHTML = viewMonth(cursor);
  else grid.innerHTML = viewYear(cursor);

  // Suppression d'une absence par l'administrateur (vue jour).
  grid.querySelectorAll('[data-del-ev]').forEach((btn) => btn.onclick = async () => {
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
  else if (State.cal.mode === 'month') State.cal.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
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

function viewMonth(cursor) {
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // 0 = lundi
  const gridStart = addDays(first, -startOffset);
  const today = new Date();

  let html = `<div class="month-grid">`;
  ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].forEach((d) => html += `<div class="dow">${d}</div>`);
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const ds = iso(d);
    const out = d.getMonth() !== month;
    const isSun = d.getDay() === 0;
    const hol = State.holidays[ds];
    const vac = schoolHolidayFor(ds);
    const closed = closedPeriodFor(ds);
    const evs = eventsOnDay(ds);
    let cls = 'cell';
    if (out) cls += ' out';
    if (isSun) cls += ' sunday';
    if (hol) cls += ' holiday';
    if (vac && !hol) cls += ' school';
    if (closed) cls += ' closed';
    if (sameDay(d, today)) cls += ' today';
    html += `<div class="${cls}" title="${closed ? 'Fermé : ' + esc(closed.label) : (vac ? esc(vac.label) : '')}">
      <span class="num">${d.getDate()}</span>
      ${closed && !out ? `<span class="hol-label" style="color:#b91c1c">🔒 ${esc(closed.label)}</span>` : (hol && !out ? `<span class="hol-label">${esc(hol)}</span>` : (vac && !out ? `<span class="hol-label" style="color:#2563eb">${esc(vac.label)}</span>` : ''))}
      ${evs.slice(0,6).map((ev) => `<span class="ev ${ev.status==='pending'?'is-pending':''}" style="background:${evColor(ev)}" title="${esc(calTooltip(ev))}">${esc(ev.code)} · ${esc(ev.userName)} (${esc(ev.groupName)})${ev.replacedByName?` ↪ ${esc(ev.replacedByName.split(' ')[0])}`:''}</span>`).join('')}
      ${evs.length > 6 ? `<span class="ev" style="background:#64748b">+${evs.length-6} autres</span>` : ''}
    </div>`;
  }
  html += `</div>`;
  if (month + 1 > 12) {}
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

async function renderMyData(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mon Profil</h1><p>Vos soldes et informations personnelles.</p></div></div><div id="md" class="empty">Chargement…</div>`;
  try {
    const { user } = await api('GET', '/me');
    State.user = user;
    const { requests } = await api('GET', '/requests/mine');
    const g = groupById(user.groupId);
    const approved = requests.filter((r) => r.status === 'approved');
    const md = document.getElementById('md'); md.className = '';
    md.innerHTML = `
      <div class="grid cols-4">
        ${statCard('Congés N', user.balances.congesN, 'jours')}
        ${statCard('Congés N-1', user.balances.congesN1, 'jours')}
        ${statCard('RCC', user.balances.rcc, 'h', false, hToDays(user.balances.rcc))}
        ${statCard('Récup. / Heures sup.', user.balances.heuresSupp, 'h', true, hToDays(user.balances.heuresSupp))}
      </div>
      <div class="card">
        <h3>Profil</h3>
        <div class="table-wrap"><table>
          <tr><th>Nom</th><td>${esc(user.firstName)} ${esc(user.lastName)}</td></tr>
          ${user.username?`<tr><th>Nom de compte</th><td>${esc(user.username)}</td></tr>`:''}
          <tr><th>Email</th><td>${user.email?esc(user.email):'<em>—</em>'}</td></tr>
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
        <p class="help" style="margin-top:-.6rem">Comptabilisé en jours et en heures ; retards en nombre.</p>
        <div class="grid cols-4">
          ${suiviHighlight(approved, ['AM','AT','ANRN'])}
          <div class="stat alt"><div class="value" style="font-size:1.3rem">${approved.filter((r)=>r.category==='RET').length} <span class="unit">retard(s)</span></div><div class="label">Retards (total validés)</div></div>
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
    const recent = requests.filter((r) => new Date(r.createdAt) >= new Date(Date.now() - 92 * 86400000));
    const list = document.getElementById('req-list'); list.className = '';
    list.innerHTML = `
      <div class="grid cols-4">
        ${statCard('Congés N', b.congesN, 'jours')}
        ${statCard('Congés N-1', b.congesN1, 'jours')}
        ${statCard('RCC', b.rcc, 'h', false, hToDays(b.rcc))}
        ${statCard('Récup. / Heures sup.', b.heuresSupp, 'h', true, hToDays(b.heuresSupp))}
      </div>
      <div class="card">
        <h3>${events.filter((ev) => ev.category!=='RET' && ev.groupId===user.groupId && ev.endDate>=iso(startOfWeekMonday(new Date())) && ev.startDate<=iso(addDays(startOfWeekMonday(new Date()),83))).length} absence(s) à prévoir dans les 12 prochaines semaines — Disponibilité de l'année</h3>
        <p class="help" style="margin-top:-.6rem">Vert = libre · rouge = absence prévue dans votre groupe (avec le nombre) · bleu = vous · 🔒 = fermé. Les retards n'affectent pas la disponibilité.</p>
        ${yearAvailabilityHTML(user, events)}
      </div>
      <div class="card">
        <h3>Mon historique récent <span class="help">(3 derniers mois)</span></h3>
        ${recent.length===0?`<div class="empty">Aucun évènement sur les 3 derniers mois.</div>`:`<div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Période</th><th>Jours</th><th>Statut</th><th>Déposé le</th></tr></thead>
          <tbody>${recent.map((r)=>`<tr><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${r.days} j${reqHours(r)}</td><td>${statusTag(r.status)}</td><td class="help">${fmtDateTime(r.createdAt)}</td></tr>`).join('')}</tbody></table></div>`}
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
async function openRequestModal() {
  const selectable = State.categories.filter((c) => c.requestable);
  const b = State.user.balances;
  const soldeExtra = (c) => c.code === 'RCP' ? ` — solde : ${b.heuresSupp} h` : c.code === 'RCC' ? ` — solde : ${b.rcc} h` : '';
  // Pour les notes contextuelles (responsable disponible, période fermée).
  let allEvents = [], allTeam = [];
  try { allEvents = (await api('GET', '/calendar')).events; allTeam = (await api('GET', '/team')).team; } catch (e) {}
  const myRespIds = allTeam.filter((m) => m.role === 'responsable' && m.groupId === State.user.groupId).map((m) => m.id);
  modal({
    title: 'Nouvelle demande',
    bodyHTML: `
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
      f.category.onchange = () => { refreshPool(); update(); };
      if (f.pmtType) f.pmtType.onchange = () => { computePmtEnd(); update(); };
      if (f.fractionnement) f.fractionnement.onchange = () => { f.endDate.readOnly = false; computePmtEnd(); update(); };
      f.startDate.onchange = update; f.endDate.onchange = update; f.pool.onchange = update;
      overlay.querySelector('#submit-req').onclick = async () => {
        if (!f.startDate.value || !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          await api('POST', '/requests', { category: f.category.value, pool: f.pool.value || null, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value, fractionnement: f.fractionnement ? f.fractionnement.value : null });
          closeModal(); toast('Demande envoyée à l\'administrateur.', 'ok');
          if (State.view === 'requests') renderRequests(document.getElementById('main'));
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
    <div id="abs-list" class="empty">Chargement…</div>`;
  document.getElementById('abs-new').onclick = () => adminAssignModal();
  try {
    const { team } = await api('GET', '/team');
    const el = document.getElementById('abs-list'); el.className = '';
    // Salariés regroupés par groupe ; responsables et admins à part.
    const staffMembers = team.filter((m) => m.role !== 'employee');
    const employees = team.filter((m) => m.role === 'employee');
    const byGroup = {};
    employees.forEach((m) => { const k = m.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(m); });
    const order = State.groups.map((g) => g.id).concat([null]);
    const personBox = (m, sub) => `<div class="person-box" style="border-left:4px solid ${(groupById(m.groupId)||{}).color||'#94a3b8'}">
      <div class="pb-name">${esc(m.firstName)} ${esc(m.lastName)}</div>
      ${sub?`<div class="help">${sub}</div>`:''}
      <button class="btn ghost sm" data-abs="${m.id}" style="margin-top:.4rem">Saisir une absence</button>
    </div>`;
    const sections = order.map((gid) => {
      const list = byGroup[gid || 'none']; if (!list || !list.length) return '';
      const g = groupById(gid);
      list.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
      return `<div class="card"><h3>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'Sans groupe'} <span class="help">${list.length}</span></h3>
        <div class="person-grid">${list.map((m) => personBox(m)).join('')}</div></div>`;
    }).join('');
    staffMembers.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    const staffSection = staffMembers.length ? `<div class="card" style="border-left:4px solid var(--brand)"><h3>👔 Encadrement (responsables & administration)</h3>
      <div class="person-grid">${staffMembers.map((m) => personBox(m, roleLabel(m.role))).join('')}</div></div>` : '';
    el.innerHTML = sections + staffSection;
    el.querySelectorAll('[data-abs]').forEach((b) => b.onclick = () => adminAssignModal(null, b.dataset.abs));
  } catch (e) { document.getElementById('abs-list').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
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
    if (tab === 'export') return adminExport(body);
    if (tab === 'groups') return adminGroups(body);
    if (tab === 'reglement') return adminReglement(body);
    if (tab === 'categories') return adminCategories(body);
  } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
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
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return `<h4 style="margin:1rem 0 .4rem">${title} <span class="help">${list.length}</span></h4>
      <div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Type</th><th>Période</th><th>Jours</th><th>Demandé le</th><th>Statut</th><th></th></tr></thead>
        <tbody>${list.map((r)=>`<tr><td>${esc(r.userName)}${parentTag(r)}</td><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${r.days}</td><td class="help">${fmtDateTime(r.createdAt)}<div>par ${esc(r.createdByName||'—')}</div></td><td>${statusTag(r.status)}</td><td><button class="btn danger sm" data-del-req="${r.id}" title="Supprimer / libérer les dates">🗑️</button></td></tr>`).join('')}</tbody></table></div>`;
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
}

// Attribuer / changer le remplaçant d'une demande (depuis les demandes en attente).
async function replacementModal(req, body) {
  if (!req) return;
  let team = [], events = [];
  try { team = (await api('GET', '/team')).team; events = (await api('GET', '/calendar')).events; } catch (e) { toast(e.message, 'err'); return; }
  const annotate = (m) => { const c = replacerUnavailableClient(m, events, req.startDate, req.endDate, req.userId); return c ? ` (pas disponible — ${c})` : ''; };
  modal({
    title: `Remplaçant — ${req.userName}`,
    bodyHTML: `
      <p class="help">Période : ${fmtDate(req.startDate)} → ${fmtDate(req.endDate)}. Seuls les salariés disponibles sur cette période sont proposés.</p>
      <label>Remplaçant</label>
      <select id="repl-sel"><option value="">— Personne —</option>${teamOptgroups(team.filter((m) => m.id !== req.userId), req.replacedById, annotate)}</select>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="repl-save">Enregistrer</button>`,
    onMount: (ov) => {
      ov.querySelector('#repl-save').onclick = async () => {
        try { await api('PUT', `/admin/requests/${req.id}/replacement`, { replacedById: ov.querySelector('#repl-sel').value || null }); closeModal(); toast('Remplaçant mis à jour.', 'ok'); adminReqs(body); }
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
    <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}${r.containsHoliday?`<div class="help" style="color:#b45309">⚠️ contient un ou plusieurs jours fériés</div>`:''}
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

  const numCell = (u, f) => `<td><input type="number" step="0.5" data-uid="${u.id}" data-bal="${f}" value="${u.balances[f]}" style="width:72px"></td>`;
  function userRow(u) {
    return `<tr>
      <td>${esc(u.firstName)} ${esc(u.lastName)}${u.suspended?' <span class="tag rejected">suspendu</span>':''}
        <div class="help">${roleLabel(u.role)}${u.isParent?' • <strong style="color:var(--text)">Parent</strong>':''}</div>
        <div class="help">Ancienneté : ${u.hireDate?ancienneteText(u.hireDate):'—'}</div>
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
    return `<div style="margin-top:1.2rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
        <h3 style="margin:0">${title} <span class="help">${list.length} salarié(s)</span></h3>
        <button class="btn ok sm" data-save-group="${key}">💾 Enregistrer ce groupe</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Compte</th><th>CP N</th><th>CP N-1</th><th>RCC (h)</th><th>H. sup.</th><th>Actions</th></tr></thead>
        <tbody>${list.map(userRow).join('')}</tbody></table></div>`;
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
      <div class="row">
        <div><label>Date d'entrée dans l'entreprise</label><input id="eu-hire" type="date" value="${u&&u.hireDate?esc(u.hireDate):''}"></div>
        <div></div>
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
        <div><label>Heures sup. dues (h)</label><input type="number" step="0.5" id="eu-heuresSupp" value="${b.heuresSupp}"></div>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn ${isNew?'accent':''}" id="eu-save">${isNew?'Créer le compte':'Enregistrer'}</button>`,
    onMount: (overlay) => {
      const val = (id) => overlay.querySelector(id).value;
      overlay.querySelector('#eu-save').onclick = async () => {
        const payload = {
          firstName: val('#eu-firstName'), lastName: val('#eu-lastName'),
          username: val('#eu-username'), email: val('#eu-email'), phone: val('#eu-phone'), hireDate: val('#eu-hire'),
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
