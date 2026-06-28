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
  green: { color: '#16a34a', label: 'En mouvement', dot: '🟢' },
  yellow: { color: '#eab308', label: 'À l’arrêt (récent)', dot: '🟡' },
  orange: { color: '#ea580c', label: 'À l’arrêt prolongé', dot: '🟠' },
  depot: { color: '#2563eb', label: 'Disponible au dépôt', dot: '🏠' },
  grey: { color: '#94a3b8', label: 'Sans position', dot: '⚪' },
};
function geoStatusMeta(s) { return GEO_STATUS[s] || GEO_STATUS.grey; }
function geoVehLabel(p) { return p.vehicleName || p.plate || p.name || ('Traceur ' + p.deviceId); }
function gTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}
// Véhicule stationné au dépôt -> « Disponible au dépôt ».
// Priorité au rayon GPS (atDepot calculé côté serveur), repli sur l'adresse.
function geoIsDepot(p) {
  if (p.moving) return false;
  if (p.atDepot) return true;
  const a = (p.address || '').toLowerCase();
  return a.indexOf('éterville') !== -1 || a.indexOf('eterville') !== -1 || a.indexOf('14930') !== -1;
}
function geoEffectiveStatus(p) { return p.lat == null ? 'grey' : (geoIsDepot(p) ? 'depot' : p.status); }

// Liste responsive des véhicules (cartes).
function geolocLiveTableHTML(positions) {
  if (!positions.length) return '<p class="help">Aucun véhicule géolocalisé pour le moment.</p>';
  return '<div class="geo-cards">' + positions.map(geoVehCardHTML).join('') + '</div>';
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
  if (p.moving) meta.push('en route');
  else if (!depot && p.finalStopAt) meta.push(`arrêté depuis ${gTime(p.finalStopAt)}`);
  if (p.battery != null) meta.push(`🔋 ${Math.round(p.battery)}%`);
  meta.push(`maj ${gTime(p.ts)}`);
  return `<div class="geo-card geo-${st}">
    <div class="geo-card-top">
      <span class="geo-name"><span class="geo-dot" style="background:${m.color}"></span>${esc(geoVehLabel(p))}</span>
      <span class="geo-speed ${speed > 0 ? 'on' : ''}">${speed} km/h</span>
    </div>
    ${p.plate && p.vehicleName ? `<div class="geo-sub">${esc(p.plate)}</div>` : ''}
    <div class="geo-addr">${m.dot} ${esc(addr)} ${maps}</div>
    <div class="geo-status-line"><span class="geo-badge" style="background:${m.color}1a;color:${m.color}">${esc(m.label)}</span><span class="help">${esc(meta.join(' · '))}</span></div>
  </div>`;
}

// Excès de vitesse DU JOUR — uniquement les véhicules concernés ; rien sinon.
function geolocSpeedTableHTML(positions, cfg) {
  cfg = cfg || {};
  const limit = cfg.speedLimit || 115;
  const ranked = positions
    .map((p) => ({ label: geoVehLabel(p), count: (p.overspeed && p.overspeed.count) || 0, times: (p.overspeed && p.overspeed.times) || [] }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  if (!ranked.length) return '';
  const total = ranked.reduce((s, r) => s + r.count, 0);
  const rows = ranked.map((r, i) => {
    const detail = r.times.length ? r.times.map((t) => `${gTime(t.at)} (${t.speed})`).join(', ') : '—';
    return `<tr><td>${i + 1}</td><td><strong>${esc(r.label)}</strong></td>
      <td style="text-align:center;font-weight:700;color:#ea580c">${r.count}</td>
      <td><span class="help">${esc(detail)}</span></td></tr>`;
  }).join('');
  return `<h3 style="margin-top:1rem">🚨 Excès de vitesse du jour</h3>
    <p class="help">Entre ${esc(cfg.dayStart || '05:00')} et ${esc(cfg.dayEnd || '18:00')}, seuil &gt; ${limit} km/h — total : <strong>${total}</strong>.</p>
    <div class="table-wrap"><table class="report-table">
    <thead><tr><th>#</th><th>Véhicule</th><th style="text-align:center">Excès</th><th>Heures (vitesse)</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// Récapitulatif hebdomadaire des excès sur 3 mois glissants.
function geolocWeeklyRecapHTML(recap, cfg) {
  if (!recap || !recap.length) return '';
  const limit = (cfg && cfg.speedLimit) || 115;
  const grandTotal = recap.reduce((s, w) => s + w.total, 0);
  const rows = recap.map((w, i) => {
    const veh = w.vehicles.length ? w.vehicles.map((v) => `${esc(v.label)} (${v.count})`).join(', ') : '<span class="help">—</span>';
    return `<tr class="${w.total > 0 ? 'geo-wk-hit' : 'geo-wk-zero'}">
      <td>${i === 0 ? '<strong>Cette semaine</strong><br>' : ''}<span class="help">${esc(w.label)}</span></td>
      <td class="geo-wk-total">${w.total}</td>
      <td>${veh}</td></tr>`;
  }).join('');
  return `<h3 style="margin-top:1rem">📅 Récapitulatif hebdomadaire (3 mois glissants)</h3>
    <p class="help">Total sur la période : <strong>${grandTotal}</strong> excès &gt; ${limit} km/h, semaine par semaine (lundi → dimanche).</p>
    <div class="table-wrap"><table class="report-table geo-recap-table">
      <thead><tr><th>Semaine</th><th style="text-align:center">Excès</th><th>Véhicules concernés</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// Bloc complet pour l'accueil (encadrement).
function geolocDashboardHTML(d) {
  if (!d || (!d.configured && !d.enabled)) {
    return isStaff() && State.user.role === 'admin'
      ? `<div class="card"><h3>🛰️ Géolocalisation</h3><p class="help">Non configurée. Ouvrez <strong>Exploitation &amp; Transport → Géolocalisation</strong> pour saisir les identifiants PAJ GPS.</p></div>`
      : '';
  }
  const err = d.error ? `<div class="alert warn" style="margin:.4rem 0">${esc(d.error)}</div>` : '';
  return `<div class="card">
    <div class="geo-head">
      <h3 style="margin:0">🛰️ Véhicules en temps réel</h3>
      <button class="btn ghost sm" data-view="geoloc">Ouvrir la carte →</button>
    </div>
    ${err}
    ${geolocLiveTableHTML(d.positions || [])}
    ${geolocSpeedTableHTML(d.positions || [], d.config)}
    ${geolocWeeklyRecapHTML(d.speedRecap, d.config)}
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
      + geolocSpeedTableHTML(d.positions || [], d.config)
      + geolocWeeklyRecapHTML(d.speedRecap, d.config);
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
