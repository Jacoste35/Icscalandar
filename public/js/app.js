'use strict';

/* =========================================================================
   INTER COLIS SERVICES — Portail RH (SPA)
   ========================================================================= */

const State = {
  token: localStorage.getItem('ics_token') || null,
  user: null,
  groups: [],
  holidays: {},
  view: 'dashboard',
  // état du calendrier
  cal: { mode: 'month', cursor: new Date() },
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

const LEAVE_TYPES = {
  conge_n: 'Congé payé N',
  conge_n1: 'Congé payé N-1',
  rcc: 'RCC',
  recuperation: 'Récupération (h. sup.)',
  absence: 'Absence',
};

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
  const [{ groups }, { holidays }] = await Promise.all([
    api('GET', '/groups'),
    api('GET', '/holidays?year=' + new Date().getFullYear()),
  ]);
  State.groups = groups;
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
      <label>Email</label>
      <input name="email" type="email" required autocomplete="email" />
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
      const { user, token } = await api('POST', '/login', { email: f.email.value, password: f.password.value });
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
      <div class="brand">📦 INTER COLIS</div>
      <nav id="nav">
        ${items.map((it) => `
          <button data-view="${it.id}" class="${State.view===it.id?'active':''}">
            <span class="ico">${it.icon}</span> ${it.label}
            ${it.id==='admin' ? `<span class="badge" id="admin-badge" style="display:none"></span>` : ''}
          </button>`).join('')}
      </nav>
      <div class="userbox">
        <div class="name">${esc(u.firstName)} ${esc(u.lastName)}</div>
        <div class="role">${u.role==='admin'?'Administrateur':'Salarié'}</div>
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
    const { events } = await api('GET', '/calendar');
    const { user } = await api('GET', '/me');
    State.user = user;
    const b = user.balances;

    // Détermine la semaine à afficher : en cours, sauf dimanche -> semaine suivante.
    let weekStart = startOfWeekMonday(today);
    if (today.getDay() === 0) weekStart = addDays(weekStart, 7);
    const weekDays = [...Array(6)].map((_, i) => addDays(weekStart, i)); // lun-sam
    const weekEnd = addDays(weekStart, 5);
    const weekLabel = `${pad(weekStart.getDate())}/${pad(weekStart.getMonth()+1)} → ${pad(weekEnd.getDate())}/${pad(weekEnd.getMonth()+1)}`;

    // Absences chevauchant la semaine
    const weekAbs = events.filter((ev) => ev.startDate <= iso(weekEnd) && ev.endDate >= iso(weekStart));

    const dashBody = document.getElementById('dash-body');
    dashBody.className = '';
    dashBody.innerHTML = `
      <div class="grid cols-4">
        ${statCard('Congés N', b.congesN, 'jours')}
        ${statCard('Congés N-1', b.congesN1, 'jours')}
        ${statCard('RCC', b.rcc, 'jours')}
        ${statCard('Heures sup. dues', b.heuresSupp, 'h', true)}
      </div>

      <div class="card">
        <div class="cal-toolbar">
          <h3 style="margin:0">Semaine ${today.getDay()===0?'à venir':'en cours'} — ${weekLabel}</h3>
        </div>
        <p class="help" style="margin-top:-.4rem;margin-bottom:1rem">Qui sera absent cette semaine ?</p>
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
  } catch (e) {
    document.getElementById('dash-body').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

function renderDashWeekRows(weekAbs, weekDays) {
  // Regroupe par utilisateur
  const byUser = {};
  weekAbs.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { name: ev.userName, color: ev.color, group: ev.groupName, evs: [] }).evs.push(ev); });
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
        if (hit) return `<div class="wcell" style="background:${hit.color}22"><span class="tag" style="background:${hit.color};color:#fff">${shortType(hit.type)}</span></div>`;
        return `<div class="wcell ${isH?'holiday':''}"></div>`;
      }).join('')}
    </div>`).join('');
}

function shortType(t) {
  return ({ conge_n:'CP N', conge_n1:'CP N-1', rcc:'RCC', recuperation:'Récup', absence:'Abs' })[t] || t;
}

function statCard(label, value, unit, alt) {
  return `<div class="stat ${alt?'alt':''}"><div class="value">${value} <span class="unit">${unit}</span></div><div class="label">${label}</div></div>`;
}

/* =========================================================================
   CALENDRIER — jour / semaine / mois / année
   ========================================================================= */
async function renderCalendar(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Calendrier de l'équipe</h1>
    <p>Présences et absences de tous les salariés inscrits.</p></div></div>
    <div class="card" id="cal-card"><div class="empty">Chargement…</div></div>`;
  try {
    await ensureHolidays(State.cal.cursor.getFullYear());
    const { events } = await api('GET', '/calendar');
    State._calEvents = events;
    drawCalendar();
  } catch (e) {
    document.getElementById('cal-card').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

function calLegend() {
  return `<div class="legend">
    ${State.groups.map((g) => `<div class="item"><span class="dot" style="background:${g.color}"></span>${esc(g.name)}</div>`).join('')}
    <div class="item"><span class="dot" style="background:#f5f3ff;border:1px solid #ddd"></span>Jour férié</div>
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

  const grid = document.getElementById('cal-grid');
  if (mode === 'day') grid.innerHTML = viewDay(cursor);
  else if (mode === 'week') grid.innerHTML = viewWeek(cursor);
  else if (mode === 'month') grid.innerHTML = viewMonth(cursor);
  else grid.innerHTML = viewYear(cursor);
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

  if (evs.length === 0) return banner + `<div class="empty">✅ Aucune absence ce jour. Toute l'équipe est présente.</div>`;
  return banner + `<div class="day-list">` + evs.map((ev) => `
    <div class="day-event">
      <div class="bar" style="background:${ev.color}"></div>
      <div>
        <strong>${esc(ev.userName)}</strong>
        <div class="help">${esc(ev.groupName)} • ${esc(ev.typeLabel)}</div>
      </div>
      <span style="margin-left:auto" class="group-chip" style="background:${ev.color}">${esc(LEAVE_TYPES[ev.type]||ev.type)}</span>
    </div>`).join('') + `</div>`;
}

function viewWeek(cursor) {
  const ws = startOfWeekMonday(cursor);
  const days = [...Array(6)].map((_, i) => addDays(ws, i));
  const we = addDays(ws, 5);
  const absent = (State._calEvents || []).filter((ev) => ev.startDate <= iso(we) && ev.endDate >= iso(ws));
  const byUser = {};
  absent.forEach((ev) => { (byUser[ev.userId] = byUser[ev.userId] || { name: ev.userName, color: ev.color, evs: [] }).evs.push(ev); });
  const rows = Object.values(byUser);

  let html = `<div class="week-grid"><div class="wrow whead"><div class="wcell namecol">Salarié</div>`;
  days.forEach((d) => { const h = State.holidays[iso(d)]; html += `<div class="wcell ${h?'holiday':''}">${DOW_SHORT[(d.getDay()+6)%7]} ${pad(d.getDate())}<div class="sub">${h?esc(h):''}</div></div>`; });
  html += `</div>`;
  if (rows.length === 0) html += `<div class="wrow"><div class="wcell namecol" style="grid-column:1/-1;color:var(--muted)">✅ Aucune absence cette semaine.</div></div>`;
  else rows.forEach((r) => {
    html += `<div class="wrow"><div class="wcell namecol"><span class="dot" style="background:${r.color}"></span> ${esc(r.name)}</div>`;
    days.forEach((d) => {
      const ds = iso(d); const hit = r.evs.find((ev) => ev.startDate <= ds && ev.endDate >= ds); const isH = State.holidays[ds];
      if (hit) html += `<div class="wcell" style="background:${hit.color}22"><span class="tag" style="background:${hit.color};color:#fff">${shortType(hit.type)}</span></div>`;
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
      ${evs.slice(0,4).map((ev) => `<span class="ev" style="background:${ev.color}" title="${esc(ev.userName)} — ${esc(ev.typeLabel)}">${esc(ev.userName.split(' ')[0])} · ${shortType(ev.type)}</span>`).join('')}
      ${evs.length > 4 ? `<span class="ev" style="background:#64748b">+${evs.length-4} autres</span>` : ''}
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
        const color = evs[0].color;
        html += `<span class="has-ev" style="background:${color}" title="${evs.length} absence(s) le ${fmtDate(ds)}">${d.getDate()}</span>`;
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
          <tr><th>Email</th><td>${esc(user.email)}</td></tr>
          <tr><th>Groupe de travail</th><td>${g ? `<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>` : '<em>Non attribué</em>'}</td></tr>
          <tr><th>Rôle</th><td>${user.role==='admin'?'Administrateur':'Salarié'}</td></tr>
          <tr><th>Statut</th><td><span class="tag approved">Actif</span></td></tr>
        </table></div>
      </div>
      <div class="card">
        <h3>Historique de mes congés validés</h3>
        ${approved.length === 0 ? `<div class="empty">Aucun congé validé pour le moment.</div>` : `
        <div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Du</th><th>Au</th><th>Jours</th></tr></thead>
          <tbody>${approved.map((r) => `<tr><td>${esc(LEAVE_TYPES[r.type]||r.type)}</td><td>${fmtDate(r.startDate)}</td><td>${fmtDate(r.endDate)}</td><td>${r.days}</td></tr>`).join('')}</tbody>
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
    <td>${esc(LEAVE_TYPES[r.type]||r.type)}</td>
    <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
    <td>${r.days} j${r.type==='recuperation'?` (${r.hours}h)`:''}</td>
    <td>${esc(r.reason||'—')}${r.adminNote?`<div class="help">Note admin : ${esc(r.adminNote)}</div>`:''}</td>
    <td>${statusTag(r.status)}</td>
    <td>${r.status==='pending'?`<button class="btn danger sm" data-cancel="${r.id}">Annuler</button>`:''}</td>
  </tr>`;
}

function openRequestModal() {
  const b = State.user.balances;
  modal({
    title: 'Nouvelle demande de congé',
    bodyHTML: `
      <form id="form-req">
        <label>Type de demande</label>
        <select name="type" required>
          <option value="conge_n">Congé payé N (solde : ${b.congesN} j)</option>
          <option value="conge_n1">Congé payé N-1 (solde : ${b.congesN1} j)</option>
          <option value="rcc">RCC (solde : ${b.rcc} j)</option>
          <option value="recuperation">Récupération heures sup. (solde : ${b.heuresSupp} h)</option>
          <option value="absence">Absence (justifiée)</option>
        </select>
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
      const update = () => {
        const s = f.startDate.value, e = f.endDate.value;
        if (s && e && e >= s) {
          const n = countWorkingDaysClient(s, e);
          preview.textContent = n > 0 ? `→ ${n} jour(s) ouvré(s) décompté(s)${f.type.value==='recuperation'?` (${n*7} h)`:''}.` : '→ Aucun jour ouvré sur cette période.';
        } else preview.textContent = '';
      };
      f.startDate.onchange = update; f.endDate.onchange = update; f.type.onchange = update;
      overlay.querySelector('#submit-req').onclick = async () => {
        if (!f.startDate.value || !f.endDate.value) { toast('Renseignez les dates.', 'err'); return; }
        try {
          await api('POST', '/requests', { type: f.type.value, startDate: f.startDate.value, endDate: f.endDate.value, reason: f.reason.value });
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
async function renderTeam(main) {
  main.innerHTML = `<div class="page-head"><div><h1>L'équipe</h1><p>Tous les salariés inscrits et leur groupe.</p></div></div><div id="team" class="empty">Chargement…</div>`;
  try {
    const { team } = await api('GET', '/team');
    const byGroup = {};
    team.forEach((m) => { const k = m.groupId || 'none'; (byGroup[k] = byGroup[k] || []).push(m); });
    const el = document.getElementById('team'); el.className = '';
    el.innerHTML = State.groups.map((g) => {
      const members = byGroup[g.id] || [];
      return `<div class="card"><h3><span class="group-chip" style="background:${g.color}">${esc(g.name)}</span> &nbsp;${members.length} membre(s)</h3>
        ${members.length===0?`<div class="empty">Aucun membre.</div>`:`<div class="table-wrap"><table><tbody>
        ${members.map((m) => `<tr><td><span class="dot" style="background:${g.color}"></span> ${esc(m.firstName)} ${esc(m.lastName)}</td><td style="text-align:right">${m.role==='admin'?'Administrateur':'Salarié'}</td></tr>`).join('')}
        </tbody></table></div>`}</div>`;
    }).join('') + (byGroup['none'] ? `<div class="card"><h3>Sans groupe</h3><div class="table-wrap"><table><tbody>${byGroup['none'].map((m)=>`<tr><td>${esc(m.firstName)} ${esc(m.lastName)}</td></tr>`).join('')}</tbody></table></div></div>` : '');
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
        <div><label>Rôle</label><select data-f="role" data-u="${u.id}"><option value="employee">Salarié</option><option value="admin">Administrateur</option></select></div>
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
        <thead><tr><th>Salarié</th><th>Type</th><th>Période</th><th>Jours</th><th>Motif</th><th>Décision</th></tr></thead>
        <tbody>${pending.map(adminReqRow).join('')}</tbody></table></div>`}
    </div>
    <div class="card">
      <h3>Historique (${others.length})</h3>
      ${others.length===0?`<div class="empty">—</div>`:`<div class="table-wrap"><table>
        <thead><tr><th>Salarié</th><th>Type</th><th>Période</th><th>Jours</th><th>Statut</th></tr></thead>
        <tbody>${others.map((r)=>`<tr><td>${esc(r.userName)}</td><td>${esc(LEAVE_TYPES[r.type]||r.type)}</td><td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${r.days}</td><td>${statusTag(r.status)}</td></tr>`).join('')}</tbody></table></div>`}
    </div>`;
  body.querySelectorAll('[data-decide]').forEach((btn) => btn.onclick = async () => {
    const [id, decision] = btn.dataset.decide.split('|');
    let note = '';
    if (decision === 'rejected') { note = prompt('Motif du refus (facultatif) :') || ''; }
    try { await api('POST', `/admin/requests/${id}/decide`, { decision, adminNote: note }); toast(decision==='approved'?'Demande validée, solde mis à jour.':'Demande refusée.', 'ok'); refreshAdminBadge(); adminReqs(body); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function adminReqRow(r) {
  return `<tr>
    <td>${esc(r.userName)}</td>
    <td>${esc(LEAVE_TYPES[r.type]||r.type)}</td>
    <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
    <td>${r.days} j${r.type==='recuperation'?` (${r.hours}h)`:''}</td>
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
  body.innerHTML = `<div class="card"><h3>Salariés actifs (${active.length})</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Salarié</th><th>Groupe</th><th>CP N</th><th>CP N-1</th><th>RCC</th><th>H. sup.</th><th></th></tr></thead>
      <tbody>${active.map((u) => {
        const g = groupById(u.groupId);
        return `<tr>
          <td>${esc(u.firstName)} ${esc(u.lastName)}<div class="help">${u.role==='admin'?'Administrateur':'Salarié'}</div></td>
          <td>${g?`<span class="group-chip" style="background:${g.color}">${esc(g.name)}</span>`:'<em>—</em>'}</td>
          <td>${u.balances.congesN}</td><td>${u.balances.congesN1}</td><td>${u.balances.rcc}</td><td>${u.balances.heuresSupp}</td>
          <td><button class="btn ghost sm" data-edit="${u.id}">Modifier</button></td>
        </tr>`;
      }).join('')}</tbody></table></div></div>`;
  body.querySelectorAll('[data-edit]').forEach((btn) => btn.onclick = () => editUserModal(active.find((u) => u.id === btn.dataset.edit), body));
}

function editUserModal(u, body) {
  modal({
    title: `${u.firstName} ${u.lastName}`,
    bodyHTML: `
      <div class="row">
        <div><label>Groupe</label><select id="eu-groupId">${groupOptions(u.groupId)}</select></div>
        <div><label>Rôle</label><select id="eu-role"><option value="employee" ${u.role==='employee'?'selected':''}>Salarié</option><option value="admin" ${u.role==='admin'?'selected':''}>Administrateur</option></select></div>
      </div>
      <div class="row">
        <div><label>Congés N (j)</label><input type="number" step="0.5" id="eu-congesN" value="${u.balances.congesN}"></div>
        <div><label>Congés N-1 (j)</label><input type="number" step="0.5" id="eu-congesN1" value="${u.balances.congesN1}"></div>
      </div>
      <div class="row">
        <div><label>RCC (j)</label><input type="number" step="0.5" id="eu-rcc" value="${u.balances.rcc}"></div>
        <div><label>Heures sup. dues (h)</label><input type="number" step="0.5" id="eu-heuresSupp" value="${u.balances.heuresSupp}"></div>
      </div>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn" id="eu-save">Enregistrer</button>`,
    onMount: (overlay) => {
      overlay.querySelector('#eu-save').onclick = async () => {
        const payload = {
          groupId: overlay.querySelector('#eu-groupId').value,
          role: overlay.querySelector('#eu-role').value,
          congesN: overlay.querySelector('#eu-congesN').value,
          congesN1: overlay.querySelector('#eu-congesN1').value,
          rcc: overlay.querySelector('#eu-rcc').value,
          heuresSupp: overlay.querySelector('#eu-heuresSupp').value,
        };
        try { await api('PUT', `/admin/users/${u.id}`, payload); closeModal(); toast('Salarié mis à jour.', 'ok'); adminUsers(body); }
        catch (e) { toast(e.message, 'err'); }
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

/* ------------------------------ Start ----------------------------------- */
boot();
