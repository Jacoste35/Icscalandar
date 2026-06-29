'use strict';
/*
 * Géolocalisation PAJ GPS — vue carte (Exploitation & Transport) + helpers
 * réutilisés par le panneau d'accueil (liste véhicules + excès de vitesse).
 *
 * Dépend de app.js (api, esc, toast, isStaff…). Leaflet est chargé à la demande
 * depuis un CDN, uniquement quand la carte est ouverte.
 */

/* ---- Chargement paresseux de Leaflet -------------------------------- */
let _leafletPromise = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = '/vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Impossible de charger la carte.'));
    document.head.appendChild(js);
  });
  return _leafletPromise;
}

/* ---- Helpers d'affichage -------------------------------------------- */
const GEO_STATUS = {
  green: { color: '#16a34a', label: 'En tournée', short: 'en tournée', dot: '🟢' },
  yellow: { color: '#eab308', label: 'Arrêt temporaire', short: 'arrêt temp.', dot: '🟡' },
  orange: { color: '#ea580c', label: 'Arrêt prolongé', short: 'arrêt prolongé', dot: '🟠' },
  depot: { color: '#2563eb', label: 'Disponible au dépôt', short: 'au dépôt', dot: '🏠' },
  grey: { color: '#94a3b8', label: 'Sans position', short: 'sans position', dot: '⚪' },
};
function geoStatusMeta(s) { return GEO_STATUS[s] || GEO_STATUS.grey; }
function geoVehLabel(p) { return p.vehicleName || p.plate || p.name || ('Traceur ' + p.deviceId); }
function gTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}
function gDate(iso) { try { return new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }); } catch (e) { return ''; } }
function gIsToday(iso) { try { return gDate(iso) === gDate(Date.now()); } catch (e) { return false; } }
// « depuis » : heure seule si aujourd'hui, sinon date + heure.
function gStopSince(iso) { if (!iso) return '—'; return gIsToday(iso) ? gTime(iso) : `le ${gDate(iso)} à ${gTime(iso)}`; }
// Date + heure complètes (pour le pied de tableau dépôt).
function gDateTime(iso) { return iso ? `le ${gDate(iso)} à ${gTime(iso)}` : '—'; }
// Véhicule stationné au dépôt -> « Disponible au dépôt ».
// Priorité au rayon GPS (atDepot calculé côté serveur), repli sur l'adresse.
function geoIsDepot(p) {
  if (p.moving) return false;
  if (p.atDepot) return true;
  const a = (p.address || '').toLowerCase();
  return a.indexOf('éterville') !== -1 || a.indexOf('eterville') !== -1 || a.indexOf('14930') !== -1;
}
function geoEffectiveStatus(p) { return p.lat == null ? 'grey' : (geoIsDepot(p) ? 'depot' : p.status); }

const euroFmt = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const litFmt = (n) => (Math.round((n || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';

// Sépare les véhicules en activité de ceux au dépôt.
function geolocSplit(positions) {
  const depot = [], active = [];
  (positions || []).forEach((p) => (geoIsDepot(p) ? depot : active).push(p));
  return { depot, active };
}

// Résumé coloré du statut réel des véhicules (en tournée / arrêts / dépôt).
function geoStatusChips(active, depot) {
  const counts = { green: 0, yellow: 0, orange: 0, grey: 0 };
  (active || []).forEach((p) => { const s = p.lat == null ? 'grey' : p.status; counts[s] = (counts[s] || 0) + 1; });
  const chip = (s, n) => {
    if (!n) return '';
    const m = GEO_STATUS[s];
    return `<span class="geo-chip" style="background:${m.color}1a;color:${m.color}">${m.dot} ${n} ${m.short}</span>`;
  };
  let html = chip('green', counts.green) + chip('yellow', counts.yellow) + chip('orange', counts.orange) + chip('grey', counts.grey);
  if (!active || !active.length) html = '<span class="geo-chip">aucun en activité</span>';
  if (depot && depot.length) html += `<span class="geo-chip" style="background:#2563eb1a;color:#2563eb">🏠 ${depot.length} au dépôt</span>`;
  const lateN = (active || []).filter((p) => p.late).length;
  if (lateN) html += `<span class="geo-chip" style="background:#fee2e2;color:#b91c1c">⏰ ${lateN} en retard prise de poste</span>`;
  return html;
}

// Liste responsive : véhicules en activité + dépôt regroupé dans un menu déroulant.
function geolocLiveTableHTML(positions) {
  if (!positions || !positions.length) return '<p class="help">Aucun véhicule géolocalisé pour le moment.</p>';
  const { depot, active } = geolocSplit(positions);
  let html = active.length
    ? '<div class="geo-cards">' + active.map(geoVehCardHTML).join('') + '</div>'
    : '<p class="help">Aucun véhicule en activité — tous au dépôt.</p>';
  if (depot.length) {
    const foot = depot.map((p) => `<li><strong>${esc(geoVehLabel(p))}</strong> — arrêté ${gDateTime(p.finalStopAt)}</li>`).join('');
    html += `<details class="geo-drop" id="geodrop-depot">
      <summary>🏠 Véhicules au dépôt <span class="geo-count">${depot.length}</span></summary>
      <div class="geo-cards" style="margin-top:.5rem">${depot.map(geoVehCardHTML).join('')}</div>
      <div class="geo-depot-foot"><strong>Cessation de mouvement</strong><ul>${foot}</ul></div>
    </details>`;
  }
  return html;
}
function geoVehCardHTML(p) {
  const st = geoEffectiveStatus(p);
  const m = geoStatusMeta(st);
  const depot = st === 'depot';
  const speed = Math.round(p.speed || 0);
  const addr = depot ? 'Disponible au dépôt'
    : (p.address || (p.lat != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'Position inconnue'));
  const maps = (p.lat != null && !depot) ? `<a class="geo-maps" href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener">Voir ↗</a>` : '';
  const meta = [];
  if (p.activeSince) meta.push(`actif depuis ${gTime(p.activeSince)}`);
  if (p.moving) meta.push('en tournée');
  else if (depot) meta.push(`immobilisé depuis ${gStopSince(p.finalStopAt)}`);
  else if (p.finalStopAt) meta.push(`arrêté depuis ${gStopSince(p.finalStopAt)}`);
  if (p.battery != null) meta.push(`🔋 ${Math.round(p.battery)}%`);
  meta.push(`maj ${gTime(p.ts)}`);
  const lateHtml = p.late ? `<div class="geo-late">⏰ Retard prise de poste : <strong>${p.late.minutes} min</strong> (prévu ${esc(p.late.ref)})</div>` : '';
  return `<div class="geo-card geo-${st}">
    <div class="geo-card-top">
      <span class="geo-name"><span class="geo-dot" style="background:${m.color}"></span>${esc(geoVehLabel(p))}</span>
      <span class="geo-speed ${speed > 0 ? 'on' : ''}">${speed} km/h</span>
    </div>
    ${p.plate && p.vehicleName ? `<div class="geo-sub">${esc(p.plate)}</div>` : ''}
    <div class="geo-addr">${m.dot} ${esc(addr)} ${maps}</div>
    <div class="geo-status-line"><span class="geo-badge" style="background:${m.color}1a;color:${m.color}">${esc(m.label)}</span><span class="help">${esc(meta.join(' · '))}</span></div>
    ${lateHtml}
    ${geoStatsHTML(p.stats)}
  </div>`;
}

const GEO_RATE = {
  green: { label: 'Conducteur économique', cls: 'green' },
  yellow: { label: 'À surveiller', cls: 'yellow' },
  red: { label: 'Dépense inutile', cls: 'red' },
  na: { label: 'données insuffisantes', cls: 'na' },
};
// Bloc kilométrage + consommation moyenne (note d'éco-conduite colorée).
function geoStatsHTML(s) {
  if (!s) return '';
  const km = `📏 <strong>${s.kmDay}</strong> km auj. · ${s.kmMonth} km/30j · ${s.kmQuarter} km/90j`;
  let conso = '';
  if (s.avgConso != null) {
    const r = GEO_RATE[s.rating] || GEO_RATE.na;
    conso = `<span class="geo-rate geo-rate-${r.cls}" title="Sur-consommation évitable : ${s.excessPct}%">⛽ ${s.avgConso} L/100${s.urbanShare ? ` · ville ${s.urbanShare}%` : ''} — ${r.label}</span>`;
  }
  return `<div class="geo-stats"><span class="geo-km help">${km}</span>${conso}</div>`;
}

// Coût d'utilisation du jour par véhicule, décomposé par pôle de dépense.
const GEO_POLES = [['salarie', 'Salarié', '#2563eb'], ['carburant', 'Carburant', '#ea580c'], ['vehicule', 'Véhicule', '#64748b']];
function geoCostBar(c) {
  return GEO_POLES.map(([k, lbl, col]) => c[k] > 0 && c.total > 0
    ? `<span class="geo-cost-seg" style="width:${(c[k] / c.total * 100).toFixed(1)}%;background:${col}" title="${lbl} : ${euroFmt(c[k])}"></span>` : '').join('');
}
function geolocCostHTML(positions) {
  const items = (positions || []).filter((p) => p.cost && p.cost.total > 0).sort((a, b) => b.cost.total - a.cost.total);
  if (!items.length) return '';
  const grand = { salarie: 0, carburant: 0, vehicule: 0, total: 0 };
  items.forEach((p) => { GEO_POLES.forEach(([k]) => grand[k] += p.cost[k]); grand.total += p.cost.total; });
  const rows = items.map((p) => {
    const c = p.cost;
    return `<div class="geo-cost-row">
      <div class="geo-cost-head"><strong>${esc(geoVehLabel(p))}</strong>${c.closed ? ' <span class="geo-count">immobilisé</span>' : ' <span class="geo-count alt">en cours</span>'}<span class="geo-cost-total">${euroFmt(c.total)}</span></div>
      <div class="geo-cost-bar">${geoCostBar(c)}</div>
      <div class="help">${esc(c.driverName || 'chauffeur non affecté')} · ${c.hours} h · ${c.km} km · ${litFmt(c.liters)} — Salarié <strong>${euroFmt(c.salarie)}</strong> · Carburant <strong>${euroFmt(c.carburant)}</strong> · Véhicule <strong>${euroFmt(c.vehicule)}</strong>${c.vehiculeFixe ? ` <span class="help">(dont leasing+assurance ${euroFmt(c.vehiculeFixe)})</span>` : ''}</div>
    </div>`;
  }).join('');
  return `<p class="help">Total flotte aujourd'hui : <strong>${euroFmt(grand.total)}</strong> — cumul jusqu'au retour au dépôt ou 18h.</p>
    <div class="geo-cost-legend">${GEO_POLES.map(([k, lbl, col]) => `<span><i style="background:${col}"></i>${lbl} ${euroFmt(grand[k])}</span>`).join('')}</div>
    <div class="geo-cost-bar geo-cost-grand">${geoCostBar(grand)}</div>
    ${rows}`;
}

// Enrobe un contenu dans un menu déroulant (vide -> rien).
function geoDrop(id, title, inner, open) {
  if (!inner) return '';
  return `<details class="geo-drop geo-sub" id="${id}"${open ? ' open' : ''}><summary>${title}</summary><div class="geo-drop-body">${inner}</div></details>`;
}

// Excès de vitesse DU JOUR — uniquement les véhicules concernés ; rien sinon.
// Affiche le comparatif vitesse relevée / vitesse autorisée.
function geolocSpeedTableHTML(positions, cfg) {
  cfg = cfg || {};
  const limit = cfg.speedLimit || 115;
  const ranked = positions
    .map((p) => ({ label: geoVehLabel(p), count: (p.overspeed && p.overspeed.count) || 0, times: (p.overspeed && p.overspeed.times) || [] }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  if (!ranked.length) return '';
  const total = ranked.reduce((s, r) => s + r.count, 0);
  const cards = ranked.map((r) => {
    const chips = (r.times || []).map((t) => `<span class="geo-ex-chip">${gTime(t.at)} · <strong>${t.speed}</strong>${t.limit ? `/${t.limit}` : ''}${t.road ? ' <span class="help">route</span>' : ''}</span>`).join('');
    return `<div class="geo-ex-card">
      <div class="geo-ex-head"><span class="geo-ex-veh">🚗 ${esc(r.label)}</span><span class="geo-ex-count">${r.count} excès</span></div>
      ${chips ? `<div class="geo-ex-chips">${chips}</div>` : ''}
    </div>`;
  }).join('');
  return `<p class="help">Entre ${esc(cfg.dayStart || '05:00')} et ${esc(cfg.dayEnd || '18:00')} — <strong>vitesse relevée / limite autorisée</strong> (km/h). Limite de la route si connue, sinon seuil ${limit}. Total du jour : <strong>${total}</strong>.</p>
    ${cards}`;
}

// Récapitulatif hebdomadaire des excès sur 3 mois glissants — cartes claires :
// bandeau de synthèse + une carte par semaine ayant eu des excès (les semaines
// vides sont résumées). Responsive (les cartes et pastilles s'empilent).
function geolocWeeklyRecapHTML(recap, cfg) {
  if (!recap || !recap.length) return '';
  const grandTotal = recap.reduce((s, w) => s + w.total, 0);
  if (grandTotal === 0) return ''; // rien tant qu'aucun excès sur la période
  const grandL = recap.reduce((s, w) => s + (w.liters || 0), 0);
  const grandE = recap.reduce((s, w) => s + (w.euros || 0), 0);
  const hit = recap.filter((w) => w.total > 0);
  const empties = recap.length - hit.length;
  const cards = hit.map((w, i) => {
    const isCurrent = w === recap[0];
    const chips = (w.vehicles || []).map((v) => `<span class="geo-wk-chip">${esc(v.label)} <strong>${v.count}</strong>${v.maxRecorded ? ` · ${v.maxRecorded}${v.limit ? '/' + v.limit : ''} km/h` : ''}</span>`).join('');
    return `<div class="geo-wk-card">
      <div class="geo-wk-head">
        <span class="geo-wk-week">${isCurrent ? '📍 ' : '📅 '}${esc(w.label)}${isCurrent ? ' <span class="help">(en cours)</span>' : ''}</span>
        <span class="geo-wk-tot">${w.total} excès${w.euros ? ` · ${euroFmt(w.euros)}` : ''}</span>
      </div>
      ${chips ? `<div class="geo-wk-chips">${chips}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="geo-recap-sum">📊 Sur 3 mois : <strong>${grandTotal}</strong> excès · sur-conso <strong>${litFmt(grandL)}</strong> · <strong>${euroFmt(grandE)}</strong></div>
    ${cards}
    ${empties ? `<p class="help">${empties} semaine(s) sans excès sur la période.</p>` : ''}`;
}

// Bloc accueil (encadrement) : menu déroulant « Véhicules en temps réel ».
function geolocDashboardHTML(d) {
  if (!d || (!d.configured && !d.enabled)) {
    return isStaff() && State.user.role === 'admin'
      ? `<div class="card"><h3>🛰️ Géolocalisation</h3><p class="help">Non configurée. Ouvrez <strong>Exploitation &amp; Transport → Géolocalisation</strong> pour saisir les identifiants PAJ GPS.</p></div>`
      : '';
  }
  const { depot, active } = geolocSplit(d.positions || []);
  const err = d.error ? `<div class="alert warn" style="margin:.4rem 0">${esc(d.error)}</div>` : '';
  // Ouvert par défaut sur ordinateur (mis en avant) ; replié sur téléphone.
  const isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  return `<div class="card">
    <details class="geo-drop geo-drop-main" id="geodrop-main"${isMobile ? '' : ' open'}>
      <summary><span class="geo-main-title">🛰️ Géolocalisation des chauffeurs</span> ${geoStatusChips(active, depot)}</summary>
      <div style="display:flex;justify-content:flex-end;margin:.3rem 0 .2rem"><button class="btn ghost sm" data-view="geoloc">Ouvrir la carte →</button></div>
      ${err}
      ${geolocLiveTableHTML(d.positions || [])}
      ${geoDrop('geodrop-cost', '💶 Coût d\'utilisation du jour', geolocCostHTML(d.positions || []))}
      ${geoDrop('geodrop-speed', '🚨 Excès de vitesse du jour', geolocSpeedTableHTML(d.positions || [], d.config))}
      ${geoDrop('geodrop-recap', '📅 Récapitulatif hebdomadaire des excès (3 mois)', geolocWeeklyRecapHTML(d.speedRecap, d.config))}
    </details>
  </div>`;
}

/* ---- Panneau d'accueil auto-actualisé ------------------------------- */
let _dashGeoTimer = null;
async function geolocRefreshDashboard() {
  const el = document.getElementById('dash-geoloc');
  if (!el || State.view !== 'dashboard') { if (_dashGeoTimer) { clearInterval(_dashGeoTimer); _dashGeoTimer = null; } return; }
  try {
    const d = await api('GET', '/staff/geoloc/live');
    const openIds = [...el.querySelectorAll('details[open]')].map((x) => x.id).filter(Boolean);
    const html = geolocDashboardHTML(d);
    el.innerHTML = html || geolocFallbackHTML('Aucune donnée de géolocalisation pour le moment.');
    openIds.forEach((id) => { const x = el.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id)); if (x) x.open = true; });
    el.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { State.view = b.dataset.view; renderApp(); });
  } catch (e) {
    // Ne jamais rester bloqué sur « chargement… » : afficher l'en-tête + l'erreur.
    el.innerHTML = geolocFallbackHTML('Connexion momentanément indisponible — réessai automatique… ' + (e && e.message ? '(' + e.message + ')' : ''));
  }
}
function geolocFallbackHTML(msg) {
  return `<div class="card"><details class="geo-drop geo-drop-main" open>
    <summary><span class="geo-main-title">🛰️ Géolocalisation des chauffeurs</span></summary>
    <div class="geo-drop-body"><div class="alert info">${esc(msg)}</div></div>
  </details></div>`;
}
function geolocStartDashboard() {
  if (_dashGeoTimer) clearInterval(_dashGeoTimer);
  geolocRefreshDashboard();
  _dashGeoTimer = setInterval(geolocRefreshDashboard, 30000);
}

/* ---- Vue carte plein écran ------------------------------------------ */
let _geoMap = null, _geoLayers = null, _geoTimer = null, _geoFirstFit = true;

async function renderGeoloc(main) {
  if (_geoTimer) { clearInterval(_geoTimer); _geoTimer = null; }
  _geoMap = null; _geoLayers = null; _geoFirstFit = true;
  const isAdmin = State.user.role === 'admin';
  main.innerHTML = `
    <div class="page-head"><div><h1>🛰️ Géolocalisation des véhicules</h1>
      <p>Positions et déplacements en temps réel (PAJ GPS).</p></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <label class="help" style="display:flex;align-items:center;gap:.3rem"><input type="checkbox" id="geo-auto" checked> Auto-actualisation</label>
        <button class="btn ghost" id="geo-refresh">↻ Actualiser</button>
        ${isAdmin ? '<button class="btn" id="geo-config">⚙️ Configuration</button>' : ''}
      </div>
    </div>
    <div id="geo-alert"></div>
    <div id="geo-config-panel"></div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="geo-map" style="height:60vh;min-height:380px;width:100%;background:#eef2f7"></div>
    </div>
    <div class="card"><div id="geo-list">Chargement…</div></div>`;

  const refreshBtn = main.querySelector('#geo-refresh');
  const autoChk = main.querySelector('#geo-auto');
  refreshBtn.onclick = () => loadGeoloc(true);
  if (isAdmin) main.querySelector('#geo-config').onclick = () => toggleGeoConfig(main);

  try {
    const L = await ensureLeaflet();
    _geoMap = L.map('geo-map', { zoomControl: true }).setView([49.15, -0.42], 9); // Caen/Éterville par défaut
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(_geoMap);
    _geoLayers = L.layerGroup().addTo(_geoMap);
  } catch (e) {
    main.querySelector('#geo-alert').innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }

  await loadGeoloc(true);
  _geoTimer = setInterval(() => { if (State.view === 'geoloc' && autoChk.checked) loadGeoloc(false); else if (State.view !== 'geoloc') { clearInterval(_geoTimer); _geoTimer = null; } }, 30000);
}

async function loadGeoloc(force) {
  const listEl = document.getElementById('geo-list');
  const alertEl = document.getElementById('geo-alert');
  if (!listEl) return;
  try {
    const d = await api('GET', '/staff/geoloc/live' + (force ? '?force=1' : ''));
    if (alertEl) alertEl.innerHTML = d.error ? `<div class="alert warn">${esc(d.error)}</div>` : '';
    if (!d.enabled || !d.configured) {
      listEl.innerHTML = `<p class="help">${d.enabled ? 'Identifiants PAJ manquants.' : 'Géolocalisation non activée.'} ${State.user.role === 'admin' ? 'Cliquez sur « Configuration ».' : 'Contactez un administrateur.'}</p>`;
      return;
    }
    drawGeoMarkers(d.positions || []);
    const openIds = [...listEl.querySelectorAll('details[open]')].map((x) => x.id).filter(Boolean);
    const upd = (d.positions || []).reduce((mx, p) => (p.ts && p.ts > mx ? p.ts : mx), '');
    listEl.innerHTML = `<p class="help">Dernière mise à jour : ${gTime(upd) || '—'} ${d.day ? '· ' + d.day : ''}</p>`
      + geolocLiveTableHTML(d.positions || [])
      + geoDrop('geodrop-cost', '💶 Coût d\'utilisation du jour', geolocCostHTML(d.positions || []))
      + geoDrop('geodrop-speed', '🚨 Excès de vitesse du jour', geolocSpeedTableHTML(d.positions || [], d.config))
      + geoDrop('geodrop-recap', '📅 Récapitulatif hebdomadaire des excès (3 mois)', geolocWeeklyRecapHTML(d.speedRecap, d.config));
    openIds.forEach((id) => { const x = listEl.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id)); if (x) x.open = true; });
  } catch (e) {
    if (alertEl) alertEl.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`;
  }
}

function drawGeoMarkers(positions) {
  if (!_geoMap || !_geoLayers || !window.L) return;
  const L = window.L;
  _geoLayers.clearLayers();
  const pts = [];
  positions.forEach((p) => {
    if (p.lat == null || p.lng == null) return;
    const st = geoEffectiveStatus(p);
    const m = geoStatusMeta(st);
    // Trace de déplacement du jour.
    if (Array.isArray(p.trail) && p.trail.length > 1) {
      L.polyline(p.trail.map((t) => [t.lat, t.lng]), { color: m.color, weight: 3, opacity: .5 }).addTo(_geoLayers);
    }
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 9, color: '#fff', weight: 2, fillColor: m.color, fillOpacity: 1,
    }).addTo(_geoLayers);
    const arret = st === 'depot' ? 'Disponible au dépôt'
      : (p.moving ? 'en mouvement' : (p.finalStopAt ? `arrêté depuis ${gTime(p.finalStopAt)}` : 'à l’arrêt'));
    marker.bindPopup(`<strong>${esc(geoVehLabel(p))}</strong><br>
      ${m.dot} ${esc(m.label)}<br>
      Vitesse : <strong>${Math.round(p.speed || 0)} km/h</strong><br>
      ${(p.address && st !== 'depot') ? esc(p.address) + '<br>' : ''}
      ${esc(arret)}<br>
      Excès aujourd'hui : <strong>${(p.overspeed && p.overspeed.count) || 0}</strong><br>
      <span style="color:#64748b">maj ${gTime(p.ts)}</span>`);
    pts.push([p.lat, p.lng]);
  });
  if (pts.length && _geoFirstFit) {
    try { _geoMap.fitBounds(pts, { padding: [40, 40], maxZoom: 14 }); } catch (e) {}
    _geoFirstFit = false;
  }
}

/* ---- Panneau de configuration (admin) ------------------------------- */
async function toggleGeoConfig(main) {
  const panel = main.querySelector('#geo-config-panel');
  if (panel.dataset.open === '1') { panel.innerHTML = ''; panel.dataset.open = '0'; return; }
  panel.dataset.open = '1';
  panel.innerHTML = '<div class="card">Chargement…</div>';
  let cfg;
  try { cfg = await api('GET', '/staff/geoloc/config'); }
  catch (e) { panel.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; return; }
  const c = cfg.config;
  const vehOpts = (id) => `<option value="">— véhicule —</option>` + cfg.vehicles.map((v) => `<option value="${v.id}" ${id === v.id ? 'selected' : ''}>${esc(v.name)}${v.plate ? ' (' + esc(v.plate) + ')' : ''}</option>`).join('');
  panel.innerHTML = `<div class="card">
    <h3 style="margin-top:0">⚙️ Configuration PAJ GPS</h3>
    <div class="alert info">Les identifiants sont chiffrés (AES-256) avant stockage. Le mot de passe n'est jamais réaffiché.</div>
    <div class="grid cols-2">
      <label>Identifiant (email PAJ)<input id="gc-email" type="email" value="${esc(c.email)}" placeholder="compte@exemple.fr"></label>
      <label>Mot de passe PAJ<input id="gc-pass" type="password" placeholder="${c.hasPassword ? '•••••• (inchangé)' : 'mot de passe'}"></label>
      <label>Seuil d'excès (km/h)<input id="gc-limit" type="number" value="${c.speedLimit}"></label>
      <label>Activer la géolocalisation<select id="gc-enabled"><option value="1" ${c.enabled ? 'selected' : ''}>Activée</option><option value="0" ${!c.enabled ? 'selected' : ''}>Désactivée</option></select></label>
      <label>Début de journée<input id="gc-start" type="time" value="${esc(c.dayStart)}"></label>
      <label>Fin de journée<input id="gc-end" type="time" value="${esc(c.dayEnd)}"></label>
    </div>
    <h3 style="margin:.8rem 0 .2rem">🏠 Dépôt (état « Disponible au dépôt »)</h3>
    <p class="help">Un véhicule à l'arrêt à moins du rayon indiqué autour de ce point est affiché « au dépôt ».</p>
    <div class="grid cols-2">
      <label>Latitude du dépôt<input id="gc-dlat" type="number" step="any" value="${c.depotLat != null ? c.depotLat : ''}"></label>
      <label>Longitude du dépôt<input id="gc-dlng" type="number" step="any" value="${c.depotLng != null ? c.depotLng : ''}"></label>
      <label>Rayon du dépôt (mètres)<input id="gc-drad" type="number" value="${c.depotRadius || 300}"></label>
    </div>
    <h3 style="margin:.8rem 0 .2rem">⛽ Sur-consommation & limites de route</h3>
    <p class="help">Le récap hebdomadaire estime le carburant perdu par les excès (différence de consommation théorique entre la vitesse relevée et la limite autorisée).</p>
    <div class="grid cols-2">
      <label>Prix du gazole (€/L)<input id="gc-fuel" type="number" step="0.01" value="${c.fuelPrice || 1.75}"></label>
      <label>Limites de route (OpenStreetMap)<select id="gc-road"><option value="1" ${c.roadSpeedLookup ? 'selected' : ''}>Activées</option><option value="0" ${!c.roadSpeedLookup ? 'selected' : ''}>Désactivées</option></select></label>
      <label>Conso à 90 km/h (L/100)<input id="gc-c90" type="number" step="0.1" value="${c.consoRoad90 || 9.5}" title="Sprinter 314 CDI ≈ 9,5"></label>
      <label>Conso en ville (L/100)<input id="gc-curb" type="number" step="0.1" value="${c.consoUrban || 12.5}"></label>
    </div>
    <h3 style="margin:.8rem 0 .2rem">💶 Coût d'utilisation</h3>
    <p class="help">Décompose le coût journalier par pôle : salarié (chauffeur affecté × taux horaire de la gestion des heures + charges), carburant et véhicule.</p>
    <div class="grid cols-2">
      <label>Coût véhicule (€/km, hors carburant)<input id="gc-vkm" type="number" step="0.01" value="${c.vehicleCostPerKm != null ? c.vehicleCostPerKm : 0.25}" title="Entretien, pneus, usure, dépréciation"></label>
      <label>Charges patronales (%)<input id="gc-charges" type="number" step="1" value="${c.chargesPatrPct != null ? c.chargesPatrPct : 42}"></label>
      <label>Mensualité véhicule (€ HT/mois)<input id="gc-lease" type="number" step="1" value="${c.vehicleMonthlyLease != null ? c.vehicleMonthlyLease : 1000}" title="Leasing / crédit Sprinter"></label>
      <label>Assurance (€/mois)<input id="gc-insur" type="number" step="1" value="${c.vehicleMonthlyInsurance != null ? c.vehicleMonthlyInsurance : 220}"></label>
      <label>Jours travaillés / mois (prorata)<input id="gc-fdays" type="number" step="0.5" value="${c.vehicleFixedDays != null ? c.vehicleFixedDays : 21.5}"></label>
    </div>
    <h3 style="margin:.8rem 0 .2rem">🕒 Prise de poste (retard chauffeur)</h3>
    <p class="help">Heure d'embauche prévue. Si le véhicule démarre après, le retard du chauffeur est signalé sur l'accueil et dans le résumé.</p>
    <div class="grid cols-2">
      <label>Heure par défaut (tous)<input id="gc-prise" type="time" value="${esc(c.priseDePoste || '')}"></label>
    </div>
    ${(cfg.drivers && cfg.drivers.length)
      ? `<p class="help" style="margin:.5rem 0 .2rem">Par chauffeur (laisser vide = heure par défaut) :</p><div class="grid cols-2">${cfg.drivers.map((dr) => `<label>${esc(dr.name)}<input type="time" data-prise="${dr.id}" value="${esc((c.priseDePosteByUser && c.priseDePosteByUser[dr.id]) || '')}"></label>`).join('')}</div>`
      : '<p class="help">Associez les chauffeurs aux véhicules (Gestion des véhicules) pour définir une heure par chauffeur.</p>'}
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem">
      <button class="btn ghost" id="gc-test">🔌 Tester la connexion</button>
      <button class="btn" id="gc-save">💾 Enregistrer</button>
    </div>
    <div id="gc-devices" style="margin-top:.8rem"></div>
  </div>`;

  let deviceMap = Object.assign({}, c.deviceMap);
  const devBox = panel.querySelector('#gc-devices');

  const collectConfig = () => ({
    email: panel.querySelector('#gc-email').value.trim(),
    password: panel.querySelector('#gc-pass').value,
    speedLimit: Number(panel.querySelector('#gc-limit').value) || 115,
    enabled: panel.querySelector('#gc-enabled').value === '1',
    dayStart: panel.querySelector('#gc-start').value || '05:00',
    dayEnd: panel.querySelector('#gc-end').value || '18:00',
    depotLat: parseFloat(panel.querySelector('#gc-dlat').value),
    depotLng: parseFloat(panel.querySelector('#gc-dlng').value),
    depotRadius: Number(panel.querySelector('#gc-drad').value) || 300,
    fuelPrice: Number(panel.querySelector('#gc-fuel').value) || 1.75,
    roadSpeedLookup: panel.querySelector('#gc-road').value === '1',
    consoRoad90: Number(panel.querySelector('#gc-c90').value) || 9.5,
    consoUrban: Number(panel.querySelector('#gc-curb').value) || 12.5,
    vehicleCostPerKm: Number(panel.querySelector('#gc-vkm').value) || 0,
    chargesPatrPct: Number(panel.querySelector('#gc-charges').value) || 0,
    vehicleMonthlyLease: Number(panel.querySelector('#gc-lease').value) || 0,
    vehicleMonthlyInsurance: Number(panel.querySelector('#gc-insur').value) || 0,
    vehicleFixedDays: Number(panel.querySelector('#gc-fdays').value) || 21.5,
    priseDePoste: panel.querySelector('#gc-prise').value || '',
    priseDePosteByUser: (() => { const m = {}; panel.querySelectorAll('[data-prise]').forEach((i) => { if (i.value) m[i.dataset.prise] = i.value; }); return m; })(),
    deviceMap,
  });

  panel.querySelector('#gc-test').onclick = async () => {
    devBox.innerHTML = '<p class="help">Connexion…</p>';
    try {
      const r = await api('POST', '/admin/geoloc/test', { email: panel.querySelector('#gc-email').value.trim(), password: panel.querySelector('#gc-pass').value });
      if (!r.devices.length) { devBox.innerHTML = '<p class="help">Connexion réussie, aucun traceur trouvé.</p>'; return; }
      devBox.innerHTML = `<h3>Traceurs détectés — associez à un véhicule</h3>
        <table class="report-table"><thead><tr><th>Traceur</th><th>IMEI</th><th>Véhicule</th></tr></thead><tbody>
        ${r.devices.map((dv) => `<tr><td><strong>${esc(dv.name)}</strong></td><td>${esc(dv.imei || '—')}</td>
          <td><select data-dev="${dv.id}">${vehOpts(deviceMap[dv.id] || '')}</select></td></tr>`).join('')}
        </tbody></table>`;
      devBox.querySelectorAll('select[data-dev]').forEach((s) => s.onchange = () => {
        if (s.value) deviceMap[s.dataset.dev] = s.value; else delete deviceMap[s.dataset.dev];
      });
      toast('Connexion PAJ réussie.', 'ok');
    } catch (e) { devBox.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; }
  };

  panel.querySelector('#gc-save').onclick = async () => {
    try {
      await api('POST', '/admin/geoloc/config', collectConfig());
      toast('Configuration enregistrée.', 'ok');
      panel.innerHTML = ''; panel.dataset.open = '0';
      loadGeoloc(true);
    } catch (e) { toast(e.message, 'err'); }
  };
}
