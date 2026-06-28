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
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('Impossible de charger la carte (connexion requise).'));
    document.head.appendChild(js);
  });
  return _leafletPromise;
}

/* ---- Helpers d'affichage -------------------------------------------- */
const GEO_STATUS = {
  green: { color: '#16a34a', label: 'En mouvement', dot: '🟢' },
  yellow: { color: '#eab308', label: 'À l’arrêt (récent)', dot: '🟡' },
  orange: { color: '#ea580c', label: 'À l’arrêt prolongé', dot: '🟠' },
  grey: { color: '#94a3b8', label: 'Sans position', dot: '⚪' },
};
function geoStatusMeta(s) { return GEO_STATUS[s] || GEO_STATUS.grey; }
function geoVehLabel(p) { return p.vehicleName || p.plate || p.name || ('Traceur ' + p.deviceId); }
function gTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}
function gSpeed(p) { return (p.speed != null ? Math.round(p.speed) : 0) + ' km/h'; }

// Tableau « liste des véhicules » (position, adresse, vitesse, statut, arrêt).
function geolocLiveTableHTML(positions) {
  if (!positions.length) return '<p class="help">Aucun véhicule géolocalisé pour le moment.</p>';
  const rows = positions.map((p) => {
    const m = geoStatusMeta(p.lat == null ? 'grey' : p.status);
    const arret = p.moving ? '<span class="help">en route</span>'
      : (p.finalStopAt ? `depuis ${gTime(p.finalStopAt)}` : '—');
    const addr = p.address || (p.lat != null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '—');
    const maps = p.lat != null ? ` <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener" title="Ouvrir dans Google Maps">📍</a>` : '';
    const batt = p.battery != null ? ` · 🔋${Math.round(p.battery)}%` : '';
    return `<tr>
      <td><span title="${esc(m.label)}">${m.dot}</span> <strong>${esc(geoVehLabel(p))}</strong>${p.plate && p.vehicleName ? `<br><span class="help">${esc(p.plate)}</span>` : ''}</td>
      <td>${esc(addr)}${maps}</td>
      <td style="text-align:right;font-weight:600;${(p.speed || 0) > 0 ? 'color:#16a34a' : ''}">${gSpeed(p)}</td>
      <td>${esc(m.label)}<br><span class="help">${arret}${batt}</span></td>
    </tr>`;
  }).join('');
  return `<div style="overflow:auto"><table class="report-table">
    <thead><tr><th>Véhicule</th><th>Position (adresse)</th><th style="text-align:right">Vitesse</th><th>Statut / arrêt</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Tableau « classement des excès de vitesse » du jour (fenêtre + seuil).
function geolocSpeedTableHTML(positions, cfg) {
  cfg = cfg || {};
  const limit = cfg.speedLimit || 115;
  const ranked = positions
    .map((p) => ({ label: geoVehLabel(p), count: (p.overspeed && p.overspeed.count) || 0, times: (p.overspeed && p.overspeed.times) || [] }))
    .sort((a, b) => b.count - a.count);
  const total = ranked.reduce((s, r) => s + r.count, 0);
  const head = `<p class="help">Excès relevés entre ${esc(cfg.dayStart || '05:00')} et ${esc(cfg.dayEnd || '18:00')}, seuil &gt; ${limit} km/h — total du jour : <strong>${total}</strong>.</p>`;
  if (!ranked.length) return head + '<p class="help">—</p>';
  const rows = ranked.map((r, i) => {
    const detail = r.times.length ? r.times.map((t) => `${gTime(t.at)} (${t.speed})`).join(', ') : '—';
    return `<tr${r.count > 0 ? ' style="background:rgba(234,88,12,.08)"' : ''}>
      <td>${i + 1}</td><td><strong>${esc(r.label)}</strong></td>
      <td style="text-align:center;font-weight:700${r.count > 0 ? ';color:#ea580c' : ''}">${r.count}</td>
      <td><span class="help">${esc(detail)}</span></td></tr>`;
  }).join('');
  return head + `<div style="overflow:auto"><table class="report-table">
    <thead><tr><th>#</th><th>Véhicule</th><th style="text-align:center">Excès</th><th>Heures (vitesse)</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Bloc complet pour l'accueil (encadrement) : 2 cartes (liste + excès).
function geolocDashboardHTML(d) {
  if (!d || (!d.configured && !d.enabled)) {
    return isStaff() && State.user.role === 'admin'
      ? `<div class="card"><h3>🛰️ Géolocalisation</h3><p class="help">Non configurée. Ouvrez <strong>Exploitation &amp; Transport → Géolocalisation</strong> pour saisir les identifiants PAJ GPS.</p></div>`
      : '';
  }
  const err = d.error ? `<div class="alert warn" style="margin:.4rem 0">${esc(d.error)}</div>` : '';
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.4rem">
      <h3 style="margin:0">🛰️ Véhicules en temps réel</h3>
      <button class="btn ghost sm" data-view="geoloc">Ouvrir la carte →</button>
    </div>
    ${err}
    ${geolocLiveTableHTML(d.positions || [])}
    <h3 style="margin-top:1rem">🚨 Excès de vitesse du jour</h3>
    ${geolocSpeedTableHTML(d.positions || [], d.config)}
  </div>`;
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
    const upd = (d.positions || []).reduce((mx, p) => (p.ts && p.ts > mx ? p.ts : mx), '');
    listEl.innerHTML = `<p class="help">Dernière mise à jour : ${gTime(upd) || '—'} ${d.day ? '· ' + d.day : ''}</p>`
      + geolocLiveTableHTML(d.positions || [])
      + `<h3 style="margin-top:1rem">🚨 Excès de vitesse du jour</h3>`
      + geolocSpeedTableHTML(d.positions || [], d.config);
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
    const m = geoStatusMeta(p.status);
    // Trace de déplacement du jour.
    if (Array.isArray(p.trail) && p.trail.length > 1) {
      L.polyline(p.trail.map((t) => [t.lat, t.lng]), { color: m.color, weight: 3, opacity: .5 }).addTo(_geoLayers);
    }
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 9, color: '#fff', weight: 2, fillColor: m.color, fillOpacity: 1,
    }).addTo(_geoLayers);
    const arret = p.moving ? 'en mouvement' : (p.finalStopAt ? `arrêté depuis ${gTime(p.finalStopAt)}` : 'à l’arrêt');
    marker.bindPopup(`<strong>${esc(geoVehLabel(p))}</strong><br>
      ${m.dot} ${esc(m.label)}<br>
      Vitesse : <strong>${gSpeed(p)}</strong><br>
      ${p.address ? esc(p.address) + '<br>' : ''}
      ${esc(arret)}<br>
      Excès aujourd'hui : <strong>${(p.overspeed && p.overspeed.count) || 0}</strong><br>
      <span style="color:#64748b">${gTime(p.ts)}</span>`);
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
