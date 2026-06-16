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
function reqHours(r) { return (r.category === 'RCP' && r.pool === 'HS') ? ` (${r.hours}h)` : ''; }

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
    throw new Error(data.error || 'Erreur serveur');
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
  const [{ groups }, cats, { holidays }] = await Promise.all([
    api('GET', '/groups'),
    api('GET', '/categories'),
    api('GET', '/holidays?year=' + new Date().getFullYear()),
  ]);
  State.groups = groups;
  State.categories = cats.categories;
  State.pools = cats.pools || {};
  State.catByCode = Object.fromEntries(cats.categories.map((c) => [c.code, c]));
  State.holidays = holidays;
  State._holidayYear = new Date().getFullYear();
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
      <div class="logo">📦 INTER COLIS SERVICES</div>
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
      <label>Email</label>
      <input name="email" type="email" required autocomplete="email" />
      <label>Mot de passe</label>
      <input name="password" type="password" required minlength="6" autocomplete="new-password" />
      <p class="help">6 caractères minimum.</p>
      <button class="btn full accent" type="submit">Envoyer ma demande</button>
    </form>`;
}
function bindRegister() {
  document.getElementById('form-register').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('POST', '/register', {
        firstName: f.firstName.value, lastName: f.lastName.value,
        email: f.email.value, password: f.password.value,
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
function navItems() {
  const items = [
    { id: 'dashboard', icon: '🏠', label: 'Accueil' },
    { id: 'calendar', icon: '📅', label: 'Calendrier' },
    { id: 'mydata', icon: '👤', label: 'Mes données' },
    { id: 'requests', icon: '📝', label: 'Mes demandes' },
    { id: 'team', icon: '👥', label: 'Équipe' },
    { id: 'info', icon: 'ℹ️', label: 'Droits & devoirs' },
  ];
  if (State.user.role === 'admin') {
    items.push({ id: 'admin', icon: '⚙️', label: 'Administration' });
  }
  return items;
}

let adminBadgeCount = 0;

function renderApp() {
  const u = State.user;
  const items = navItems();
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">📦 Inter Colis Services</div>
      <nav id="nav">
        ${items.map((it) => `
          <button data-view="${it.id}" class="${State.view===it.id?'active':''}">
            <span class="ico">${it.icon}</span> ${it.label}
            ${it.id==='admin' ? `<span class="badge" id="admin-badge" style="display:none"></span>` : ''}
          </button>`).join('')}
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

    // Panneau de priorité (administrateur uniquement)
    let priorityPanel = '';
    if (State.user.role === 'admin') {
      try {
        const { users } = await api('GET', '/admin/users');
        priorityPanel = priorityPanelHTML(users.filter((u) => u.status === 'active'));
      } catch (e) {}
    }

    const dashBody = document.getElementById('dash-body');
    dashBody.className = '';
    dashBody.innerHTML = `
      <div class="grid cols-4">
        ${statCard('Congés N', b.congesN, 'jours')}
        ${statCard('Congés N-1', b.congesN1, 'jours')}
        ${statCard('RCC', b.rcc, 'jours')}
        ${statCard('Heures sup. dues', b.heuresSupp, 'h', true)}
      </div>
      ${priorityPanel}
      ${dashWeekCard('Semaine précédente', prevStart, events)}
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

function priorityScore(u) {
  const b = u.balances || {};
  const { monthsLeft } = leaveDeadlineInfo();
  const hsupOver = Math.max(0, (b.heuresSupp || 0) - 25);
  // Plus l'échéance du 31 mai approche, plus les CP N-1 pèsent.
  const n1Weight = monthsLeft <= 2 ? 3 : monthsLeft <= 4 ? 2 : 1;
  const n1Urg = (b.congesN1 || 0) * n1Weight;
  // Multiplicateurs en paliers pour respecter strictement l'ordre de priorité.
  return hsupOver * 1e9 + n1Urg * 1e6 + (b.congesN || 0) * 1e3 + (b.rcc || 0);
}

function priorityReasons(u) {
  const b = u.balances || {};
  const { monthsLeft } = leaveDeadlineInfo();
  const tags = [];
  if ((b.heuresSupp || 0) > 25) tags.push(`<span class="tag rejected">HSUP ${b.heuresSupp} h (retard +${Math.round((b.heuresSupp-25)*10)/10} h)</span>`);
  if ((b.congesN1 || 0) > 0) tags.push(`<span class="tag ${monthsLeft<=2?'rejected':'pending'}">CP N-1 : ${b.congesN1} j${monthsLeft<=4?' ⏰ échéance proche':''}</span>`);
  if ((b.congesN || 0) > 0) tags.push(`<span class="tag pending">CP N : ${b.congesN} j</span>`);
  if ((b.rcc || 0) > 0) tags.push(`<span class="tag approved">RCC : ${b.rcc} j</span>`);
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
      <h3>🔔 Salariés prioritaires pour poser leurs congés</h3>
      <p class="help" style="margin-top:-.6rem">Ordre de priorité : heures sup. en retard (&gt; 25 h), puis CP N-1 (échéance ${pad(deadline.getDate())}/${pad(deadline.getMonth()+1)}/${deadline.getFullYear()}), CP N, puis RCC. À planifier en priorité.</p>
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

// Carte "qui est absent" pour une semaine donnée (lundi -> samedi).
function dashWeekCard(title, weekStart, events, isCurrent) {
  const weekDays = [...Array(6)].map((_, i) => addDays(weekStart, i));
  const weekEnd = addDays(weekStart, 5);
  const label = `${pad(weekStart.getDate())}/${pad(weekStart.getMonth()+1)} → ${pad(weekEnd.getDate())}/${pad(weekEnd.getMonth()+1)}`;
  const weekAbs = events.filter((ev) => ev.startDate <= iso(weekEnd) && ev.endDate >= iso(weekStart));
  return `
    <div class="card" style="${isCurrent?'border-left:5px solid var(--brand-2)':''}">
      <div class="cal-toolbar"><h3 style="margin:0">${isCurrent?'📍 ':''}${esc(title)} — ${label}</h3></div>
      <p class="help" style="margin-top:-.4rem;margin-bottom:1rem">Qui sera absent ?</p>
      <div class="week-grid">
        <div class="wrow whead">
          <div class="wcell namecol">Salarié</div>
          ${weekDays.map((d) => {
            const h = State.holidays[iso(d)];
            return `<div class="wcell ${h?'holiday':''}">${DOW_SHORT[(d.getDay()+6)%7]} ${pad(d.getDate())}<div class="sub">${h?esc(h):''}</div></div>`;
          }).join('')}
        </div>
        ${renderDashWeekRows(weekAbs, weekDays)}
      </div>
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
  return rows.map((r) => `
    <div class="wrow">
      <div class="wcell namecol"><span class="dot" style="background:${r.color}"></span> ${esc(r.name)}</div>
      ${weekDays.map((d) => {
        const ds = iso(d);
        const hit = r.evs.find((ev) => ev.startDate <= ds && ev.endDate >= ds);
        const isH = State.holidays[ds];
        if (hit) { const c = catColor(hit.code); return `<div class="wcell" style="background:${c}22"><span class="tag ${hit.status==='pending'?'is-pending':''}" style="background:${c};color:#fff">${esc(hit.code)}</span></div>`; }
        return `<div class="wcell ${isH?'holiday':''}"></div>`;
      }).join('')}
    </div>`).join('');
}

function statCard(label, value, unit, alt) {
  return `<div class="stat ${alt?'alt':''}"><div class="value">${value} <span class="unit">${unit}</span></div><div class="label">${label}</div></div>`;
}

/* =========================================================================
   CALENDRIER — jour / semaine / mois / année
   ========================================================================= */
async function renderCalendar(main) {
  const staff = isStaff();
  main.innerHTML = `<div class="page-head"><div><h1>Calendrier de l'équipe</h1>
    <p>Présences et absences de tous les salariés inscrits.</p></div>
    ${staff?`<button class="btn accent" id="cal-add">+ Attribuer une absence</button>`:''}</div>
    <div class="card" id="cal-card"><div class="empty">Chargement…</div></div>`;
  if (staff) document.getElementById('cal-add').onclick = () => adminAssignModal();
  try {
    await ensureHolidays(State.cal.cursor.getFullYear());
    const { events } = await api('GET', '/calendar');
    State._calEvents = events;
    drawCalendar();
  } catch (e) {
    document.getElementById('cal-card').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

// Modal admin : attribuer une absence à un salarié (tous motifs).
async function adminAssignModal(prefillDate) {
  let team = [];
  try { team = (await api('GET', '/team')).team; } catch (e) { toast(e.message, 'err'); return; }
  team.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
  // Tous les motifs sauf DCP (état dérivé d'une demande de CP en attente).
  const cats = State.categories.filter((c) => c.code !== 'DCP');
  const isResp = State.user.role === 'responsable';
  modal({
    title: 'Attribuer une absence',
    bodyHTML: `
      ${isResp?`<div class="alert info">En tant que responsable, votre attribution sera <strong>soumise à validation</strong> de l'administrateur avant d'être inscrite au planning.</div>`:''}
      <form id="form-assign">
        <label>Salarié</label>
        <select name="userId" required>${team.map((m) => `<option value="${m.id}">${esc(m.lastName)} ${esc(m.firstName)}</option>`).join('')}</select>
        <label>Motif</label>
        <select name="category" required>${cats.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}</option>`).join('')}</select>
        <div id="pool-wrap" style="display:none"><label>Imputer sur le solde</label><select name="pool"></select></div>
        <div class="row">
          <div><label>Du</label><input type="date" name="startDate" required value="${prefillDate||''}"></div>
          <div><label>Au</label><input type="date" name="endDate" required value="${prefillDate||''}"></div>
        </div>
        <p class="help" id="assign-preview"></p>
        <label>Motif / commentaire (facultatif)</label>
        <textarea name="reason" placeholder="Précisez si besoin…"></textarea>
      </form>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="assign-save">Attribuer</button>`,
    onMount: (overlay) => {
      const f = overlay.querySelector('#form-assign');
      const poolWrap = overlay.querySelector('#pool-wrap');
      const preview = overlay.querySelector('#assign-preview');
      const refreshPool = () => {
        const opts = State.pools[f.category.value];
        if (opts && opts.length) { poolWrap.style.display = ''; f.pool.innerHTML = opts.map((p) => `<option value="${p.value}">${esc(p.label)}</option>`).join(''); }
        else { poolWrap.style.display = 'none'; f.pool.innerHTML = ''; }
      };
      const update = () => {
        const s = f.startDate.value, e = f.endDate.value;
        preview.textContent = (s && e && e >= s) ? `→ ${countWorkingDaysClient(s, e)} jour(s) ouvré(s).` : '';
      };
      refreshPool();
      f.category.onchange = () => { refreshPool(); update(); };
      f.startDate.onchange = update; f.endDate.onchange = update;
      overlay.querySelector('#assign-save').onclick = async () => {
        if (!f.startDate.value || !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          const r = await api('POST', '/admin/requests', { userId: f.userId.value, category: f.category.value, pool: f.pool.value || null, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value });
          closeModal();
          toast(r.pendingValidation ? 'Proposition envoyée à l\'administrateur pour validation.' : 'Absence attribuée.', 'ok');
          if (State.view === 'calendar') renderCalendar(document.getElementById('main'));
        } catch (e) { toast(e.message, 'err'); }
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
    <div class="item"><span class="dot" style="background:#f5f3ff;border:1px solid #ddd"></span>Jour férié</div>
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

function eventsOnDay(ds) {
  return (State._calEvents || []).filter((ev) => ev.startDate <= ds && ev.endDate >= ds);
}

function viewDay(cursor) {
  const ds = iso(cursor);
  const isSunday = cursor.getDay() === 0;
  const hol = State.holidays[ds];
  const evs = eventsOnDay(ds);
  let banner = '';
  if (isSunday) banner = `<div class="alert info">Dimanche — jour non travaillé.</div>`;
  else if (hol) banner = `<div class="alert info">Jour férié : ${esc(hol)} — jour non travaillé.</div>`;

  const isAdmin = State.user.role === 'admin';
  if (evs.length === 0) return banner + `<div class="empty">✅ Aucune absence ce jour. Toute l'équipe est présente.</div>`;
  return banner + `<div class="day-list">` + evs.map((ev) => `
    <div class="day-event">
      <div class="bar" style="background:${evColor(ev)}"></div>
      <div>
        <strong>${esc(ev.userName)}</strong>
        <div class="help">${esc(ev.groupName)} • ${esc(ev.categoryLabel)}${ev.status==='pending'?' — <em>demande en attente</em>':''}</div>
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
  days.forEach((d) => { const h = State.holidays[iso(d)]; html += `<div class="wcell ${h?'holiday':''}">${DOW_SHORT[(d.getDay()+6)%7]} ${pad(d.getDate())}<div class="sub">${h?esc(h):''}</div></div>`; });
  html += `</div>`;
  if (rows.length === 0) html += `<div class="wrow"><div class="wcell namecol" style="grid-column:1/-1;color:var(--muted)">✅ Aucune absence cette semaine.</div></div>`;
  else rows.forEach((r) => {
    html += `<div class="wrow"><div class="wcell namecol"><span class="dot" style="background:${r.color}"></span> ${esc(r.name)}</div>`;
    days.forEach((d) => {
      const ds = iso(d); const hit = r.evs.find((ev) => ev.startDate <= ds && ev.endDate >= ds); const isH = State.holidays[ds];
      if (hit) { const c = catColor(hit.code); html += `<div class="wcell" style="background:${c}22"><span class="tag ${hit.status==='pending'?'is-pending':''}" style="background:${c};color:#fff">${esc(hit.code)}</span></div>`; }
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
    const evs = eventsOnDay(ds);
    let cls = 'cell';
    if (out) cls += ' out';
    if (isSun) cls += ' sunday';
    if (hol) cls += ' holiday';
    if (sameDay(d, today)) cls += ' today';
    html += `<div class="${cls}">
      <span class="num">${d.getDate()}</span>
      ${hol && !out ? `<span class="hol-label">${esc(hol)}</span>` : ''}
      ${evs.slice(0,6).map((ev) => `<span class="ev ${ev.status==='pending'?'is-pending':''}" style="background:${evColor(ev)}" title="${esc(ev.userName)} — ${esc(ev.categoryLabel)}${ev.status==='pending'?' (demande)':''}">${esc(ev.code)} · ${esc(ev.userName)}</span>`).join('')}
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
      const evs = eventsOnDay(ds);
      if (evs.length) {
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
// Décompte (cumul de jours pris) par motif, calculé sur les absences validées.
function decompteRows(approved) {
  const days = {}, hours = {};
  approved.forEach((r) => {
    days[r.category] = (days[r.category] || 0) + r.days;
    if (r.category === 'RCP' && r.pool === 'HS') hours[r.category] = (hours[r.category] || 0) + r.hours;
  });
  return State.categories.filter((c) => c.code !== 'DCP').map((c) => `
    <tr>
      <td><span class="group-chip" style="background:${c.color}">${esc(c.code)}</span> ${esc(c.label)}</td>
      <td style="text-align:right;font-weight:600">${days[c.code] || 0} j${hours[c.code] ? ` (${hours[c.code]} h)` : ''}</td>
    </tr>`).join('');
}

async function renderMyData(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mes données</h1><p>Vos soldes et informations personnelles.</p></div></div><div id="md" class="empty">Chargement…</div>`;
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
        ${statCard('RCC', user.balances.rcc, 'jours')}
        ${statCard('Heures sup. dues', user.balances.heuresSupp, 'h', true)}
      </div>
      <div class="card">
        <h3>Profil</h3>
        <div class="table-wrap"><table>
          <tr><th>Nom</th><td>${esc(user.firstName)} ${esc(user.lastName)}</td></tr>
          ${user.username?`<tr><th>Nom de compte</th><td>${esc(user.username)}</td></tr>`:''}
          <tr><th>Email</th><td>${user.email?esc(user.email):'<em>—</em>'}</td></tr>
          <tr><th>Groupe de travail</th><td>${g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Non attribué</em>'}</td></tr>
          <tr><th>Rôle</th><td>${roleLabel(user.role)}</td></tr>
          <tr><th>Statut</th><td><span class="tag approved">Actif</span></td></tr>
        </table></div>
      </div>
      <div class="card">
        <h3>Décompte par motif (jours pris)</h3>
        <p class="help" style="margin-top:-.6rem">Cumul de vos absences validées pour chaque libellé.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Motif</th><th style="text-align:right">Décompte</th></tr></thead>
          <tbody>${decompteRows(approved)}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>Historique de mes congés validés</h3>
        ${approved.length === 0 ? `<div class="empty">Aucun congé validé pour le moment.</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Du</th><th>Au</th><th>Jours</th></tr></thead>
          <tbody>${approved.map((r) => `<tr><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)}</td><td>${fmtDate(r.endDate)}</td><td>${r.days}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>`;
  } catch (e) { document.getElementById('md').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

/* =========================================================================
   MES DEMANDES
   ========================================================================= */
async function renderRequests(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Mes demandes de congé</h1><p>Déposez et suivez vos demandes.</p></div>
    <button class="btn accent" id="new-req">+ Nouvelle demande</button></div>
    <div id="req-list" class="empty">Chargement…</div>`;
  document.getElementById('new-req').onclick = openRequestModal;
  try {
    const { requests } = await api('GET', '/requests/mine');
    const list = document.getElementById('req-list'); list.className = 'card';
    if (requests.length === 0) { list.innerHTML = `<div class="empty">Vous n'avez pas encore déposé de demande.</div>`; return; }
    list.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Type</th><th>Période</th><th>Jours</th><th>Motif</th><th>Statut</th><th></th></tr></thead>
      <tbody>${requests.map(reqRow).join('')}</tbody></table></div>`;
    list.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      try { await api('DELETE', '/requests/' + b.dataset.cancel); toast('Demande annulée.', 'ok'); renderRequests(main); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { document.getElementById('req-list').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
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

function openRequestModal() {
  const selectable = State.categories.filter((c) => c.requestable);
  modal({
    title: 'Nouvelle demande',
    bodyHTML: `
      <form id="form-req">
        <label>Catégorie</label>
        <select name="category" required>
          ${selectable.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}</option>`).join('')}
        </select>
        <div id="pool-wrap" style="display:none">
          <label id="pool-label">Imputer sur le solde</label>
          <select name="pool"></select>
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
      const b = State.user.balances;
      const balanceFor = { N: b.congesN + ' j', N1: b.congesN1 + ' j', RCC: b.rcc + ' j', HS: b.heuresSupp + ' h' };
      const refreshPool = () => {
        const opts = State.pools[f.category.value];
        if (opts && opts.length) {
          poolWrap.style.display = '';
          f.pool.innerHTML = opts.map((p) => `<option value="${p.value}">${esc(p.label)} (solde : ${balanceFor[p.value] ?? '—'})</option>`).join('');
        } else { poolWrap.style.display = 'none'; f.pool.innerHTML = ''; }
      };
      const update = () => {
        const s = f.startDate.value, e = f.endDate.value;
        if (s && e && e >= s) {
          const n = countWorkingDaysClient(s, e);
          const showHours = f.category.value === 'RCP' && f.pool.value === 'HS';
          preview.textContent = n > 0 ? `→ ${n} jour(s) ouvré(s)${showHours?` (${n*7} h)`:''} décompté(s).` : '→ Aucun jour ouvré sur cette période.';
        } else preview.textContent = '';
      };
      refreshPool();
      f.category.onchange = () => { refreshPool(); update(); };
      f.startDate.onchange = update; f.endDate.onchange = update; f.pool.onchange = update;
      overlay.querySelector('#submit-req').onclick = async () => {
        if (!f.startDate.value || !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          await api('POST', '/requests', { category: f.category.value, pool: f.pool.value || null, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value });
          closeModal(); toast('Demande envoyée à l\'administrateur.', 'ok');
          if (State.view === 'requests') renderRequests(document.getElementById('main'));
        } catch (e) { toast(e.message, 'err'); }
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

// Pastilles de dates d'absence d'un membre, triées et colorées par statut.
function memberAbsenceChips(memberId, events) {
  const evs = events.filter((e) => e.userId === memberId).sort((a, b) => a.startDate.localeCompare(b.startDate));
  if (!evs.length) return '<span class="help">Aucune absence enregistrée.</span>';
  return evs.map((e) => {
    const st = dateStatus(e.startDate, e.endDate);
    const range = e.startDate === e.endDate ? fmtDate(e.startDate) : `${fmtDate(e.startDate)} → ${fmtDate(e.endDate)}`;
    return `<span class="date-chip ${st} ${e.status==='pending'?'is-pending':''}" title="${esc(e.categoryLabel)}${e.status==='pending'?' (en attente)':''}">${esc(e.code)} ${range}</span>`;
  }).join(' ');
}

async function renderTeam(main) {
  main.innerHTML = `<div class="page-head"><div><h1>L'équipe</h1><p>Salariés, groupes et dates de congés / absences.</p></div></div>
    <div class="legend" style="margin-bottom:1rem">
      <div class="item"><span class="date-chip past">passées</span></div>
      <div class="item"><span class="date-chip current">en cours</span></div>
      <div class="item"><span class="date-chip future">à venir</span></div>
    </div>
    <div id="team" class="empty">Chargement…</div>`;
  try {
    const { team } = await api('GET', '/team');
    const { events } = await api('GET', '/calendar');
    const byGroup = {};
    team.forEach((m) => { const k = m.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(m); });
    const el = document.getElementById('team'); el.className = '';
    const groupCard = (g, members) => `<div class="card">
      <h3>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'Sans groupe'} &nbsp;${members.length} membre(s)</h3>
      ${members.length===0?`<div class="empty">Aucun membre.</div>`:members.map((m) => `
        <div style="padding:.7rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap">
            <strong>${g?`<span class="dot" style="background:${g.color}"></span> `:''}${esc(m.firstName)} ${esc(m.lastName)}</strong>
            <span class="help">${roleLabel(m.role)}</span>
          </div>
          <div style="margin-top:.45rem;display:flex;flex-wrap:wrap;gap:.35rem">${memberAbsenceChips(m.id, events)}</div>
        </div>`).join('')}
    </div>`;
    el.innerHTML = State.groups.map((g) => groupCard(g, byGroup[g.id] || [])).join('')
      + (byGroup['none'] ? groupCard(null, byGroup['none']) : '');
  } catch (e) { document.getElementById('team').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
}

/* =========================================================================
   DROITS & DEVOIRS
   ========================================================================= */
async function renderInfo(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Vos droits & devoirs</h1><p>Informations utiles sur la plateforme.</p></div>
    ${State.user.role==='admin'?`<button class="btn ghost" id="edit-info">Modifier</button>`:''}</div>
    <div class="card"><div class="info-content" id="info-content">Chargement…</div></div>`;
  try {
    const { content } = await api('GET', '/info-panel');
    document.getElementById('info-content').textContent = content;
    if (State.user.role === 'admin') {
      document.getElementById('edit-info').onclick = () => editInfoModal(content);
    }
  } catch (e) { document.getElementById('info-content').textContent = e.message; }
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

/* =========================================================================
   ADMINISTRATION
   ========================================================================= */
async function renderAdmin(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Administration</h1><p>Validez les inscriptions, gérez les soldes et les demandes.</p></div></div>
    <div class="view-switch" id="admin-tabs" style="margin-bottom:1.2rem">
      <button data-tab="pending" class="active">Inscriptions</button>
      <button data-tab="reqs">Demandes</button>
      <button data-tab="users">Salariés & soldes</button>
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
    if (tab === 'groups') return adminGroups(body);
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

async function adminReqs(body) {
  const { requests } = await api('GET', '/admin/requests');
  const pending = requests.filter((r) => r.status === 'pending');
  const others = requests.filter((r) => r.status !== 'pending');
  body.innerHTML = `
    <div class="card">
      <h3>Demandes en attente (${pending.length})</h3>
      ${pending.length===0?`<div class="empty">Aucune demande en attente.</div>`:`<div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Groupe</th><th>Type</th><th>Période</th><th>Jours</th><th>Motif</th><th>Décision</th></tr></thead>
        <tbody>${pending.map(adminReqRow).join('')}</tbody></table></div>`}
    </div>
    <div class="card">
      <h3>Historique (${others.length})</h3>
      ${others.length===0?`<div class="empty">—</div>`:`<div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Groupe</th><th>Type</th><th>Période</th><th>Jours</th><th>Statut</th></tr></thead>
        <tbody>${others.map((r)=>`<tr><td>${esc(r.userName)}</td><td>${groupChip(r)}</td><td>${esc(reqLabel(r))}</td><td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${r.days}</td><td>${statusTag(r.status)}</td></tr>`).join('')}</tbody></table></div>`}
    </div>`;
  body.querySelectorAll('[data-decide]').forEach((btn) => btn.onclick = async () => {
    const [id, decision] = btn.dataset.decide.split('|');
    let note = '';
    if (decision === 'rejected') { note = prompt('Motif du refus (facultatif) :') || ''; }
    try { await api('POST', `/admin/requests/${id}/decide`, { decision, adminNote: note }); toast(decision==='approved'?'Demande validée, solde mis à jour.':'Demande refusée.', 'ok'); refreshAdminBadge(); adminReqs(body); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function groupChip(r) {
  return r.groupName && r.groupName !== '—'
    ? `<span class="group-chip" style="background:${r.groupColor||'#64748b'}">${esc(r.groupName)}</span>`
    : '<em>—</em>';
}

function adminReqRow(r) {
  return `<tr>
    <td>${esc(r.userName)}</td>
    <td>${groupChip(r)}</td>
    <td><span class="tag" style="background:${catColor(r.category)}22;color:${catColor(r.category)}">${esc(r.category)}</span> ${esc(reqLabel(r))}</td>
    <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
    <td>${r.days} j${reqHours(r)}</td>
    <td>${esc(r.reason||'—')}</td>
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

  function userRow(u) {
    return `<tr>
      <td>${esc(u.firstName)} ${esc(u.lastName)}<div class="help">${roleLabel(u.role)}</div></td>
      <td>${esc(u.username||'')}${u.username&&u.email?'<br>':''}${u.email?`<span class="help">${esc(u.email)}</span>`:(u.username?'':'<em>—</em>')}</td>
      <td>${u.balances.congesN}</td><td>${u.balances.congesN1}</td><td>${u.balances.rcc}</td><td>${u.balances.heuresSupp}</td>
      <td style="white-space:nowrap">
        <button class="btn ghost sm" data-decompte="${u.id}">Décompte</button>
        <button class="btn ghost sm" data-edit="${u.id}">Modifier</button>
        <button class="btn danger sm" data-del="${u.id}">Suppr.</button>
      </td>
    </tr>`;
  }

  const sections = order.map((gid) => {
    const list = byGroup[gid || 'none'];
    if (!list || !list.length) return '';
    const g = groupById(gid);
    list.sort((a, b) => (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    const title = g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Sans groupe</em>';
    return `<h3 style="margin:1.2rem 0 .6rem">${title} <span class="help">${list.length} salarié(s)</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Compte</th><th>CP N</th><th>CP N-1</th><th>RCC</th><th>H. sup.</th><th></th></tr></thead>
        <tbody>${list.map(userRow).join('')}</tbody></table></div>`;
  }).join('');

  body.innerHTML = `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.6rem">
      <h3 style="margin:0">Salariés actifs (${active.length}) — par groupe</h3>
      <button class="btn accent" id="new-user">+ Créer un utilisateur</button>
    </div>
    <p class="help">Créez un compte (nom de compte + mot de passe) et configurez toutes ses données. « Décompte » affiche les jours pris par motif, année par année.</p>
    ${active.length===0?'<div class="empty">Aucun salarié actif.</div>':sections}
  </div>`;

  body.querySelector('#new-user').onclick = () => userModal(null, body);
  body.querySelectorAll('[data-edit]').forEach((btn) => btn.onclick = () => userModal(active.find((u) => u.id === btn.dataset.edit), body));
  body.querySelectorAll('[data-decompte]').forEach((btn) => btn.onclick = () => userDecompteModal(active.find((u) => u.id === btn.dataset.decompte)));
  body.querySelectorAll('[data-del]').forEach((btn) => btn.onclick = async () => {
    const u = active.find((x) => x.id === btn.dataset.del);
    if (!confirm(`Supprimer définitivement ${u.firstName} ${u.lastName} et ses demandes ?`)) return;
    try { await api('DELETE', `/admin/users/${u.id}`); toast('Utilisateur supprimé.', 'ok'); adminUsers(body); }
    catch (e) { toast(e.message, 'err'); }
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
    return `<div class="table-wrap"><table>
      <thead><tr><th>Motif</th><th style="text-align:right">Décompte</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th>Total jours d'absence</th><th style="text-align:right">${totalDays} j</th></tr></tfoot>
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
          username: val('#eu-username'), email: val('#eu-email'),
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

async function adminGroups(body) {
  body.innerHTML = `<div class="card"><h3>Groupes de travail & couleurs</h3>
    <p class="help">Chaque groupe a une couleur utilisée sur le calendrier.</p>
    <div class="table-wrap"><table><thead><tr><th>Nom</th><th>Couleur</th><th></th></tr></thead>
    <tbody>${State.groups.map((g) => `<tr>
      <td><input value="${esc(g.name)}" id="g-name-${g.id}" style="max-width:200px"></td>
      <td><input type="color" value="${g.color}" id="g-color-${g.id}" style="width:60px;height:38px;padding:2px"></td>
      <td><button class="btn sm" data-save-group="${g.id}">Enregistrer</button></td>
    </tr>`).join('')}</tbody></table></div></div>`;
  body.querySelectorAll('[data-save-group]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.saveGroup;
    try {
      const { group } = await api('PUT', `/admin/groups/${id}`, { name: document.getElementById('g-name-'+id).value, color: document.getElementById('g-color-'+id).value });
      const idx = State.groups.findIndex((g) => g.id === id); State.groups[idx] = group;
      toast('Groupe mis à jour.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
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
      const ded = c.code==='CP' ? 'Congés N / N-1' : c.code==='RCP' ? 'RCC / Heures sup.' : c.code==='DCP' ? 'Demande de CP (en attente)' : 'Aucun (suivi)';
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
