'use strict';
/* =========================================================================
   OPTIMISATEUR DE TOURNÉE — Phase 1 (PWA, 100 % gratuit)
   - Saisie d'adresse avec autocomplétion API BAN (adresse.data.gouv.fr)
   - Optimisation locale (plus proche voisin + 2-opt, distances haversine)
   - Carte Leaflet/OSM avec arrêts numérotés
   - Écran « arrêt en cours » : Livrer / Passer / Guider (deep link gratuit)
   - État persistant (localStorage) : survit au passage vers Waze/Maps
   NB : OCR d'étiquette (ML Kit) et OR-Tools/OSRM = phases suivantes (Capacitor + VPS).
   ========================================================================= */

// Dépôt par défaut : Éterville (14930). Modifiable, ou « partir de ma position ».
const OPT_DEPOT = { label: 'Dépôt — Éterville (14930)', lat: 49.1436, lon: -0.4256, gps: false };
const OPT_KEY = 'ics_optim_v1';

function optLoad() {
  try { const s = JSON.parse(localStorage.getItem(OPT_KEY) || 'null'); if (s && s.stops) return s; } catch (e) {}
  return { start: Object.assign({}, OPT_DEPOT), stops: [], optimized: false, activeId: null };
}
function optSave(st) { try { localStorage.setItem(OPT_KEY, JSON.stringify(st)); } catch (e) {} }
let _opt = null; // état courant
let _optMap = null, _optMarkers = [], _optLine = null;

function optRad(d) { return d * Math.PI / 180; }
function optHaversine(a, b) {
  const R = 6371000, dLat = optRad(b.lat - a.lat), dLon = optRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(optRad(a.lat)) * Math.cos(optRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Chemin ouvert (dépôt → tous les arrêts) : plus proche voisin puis 2-opt.
function optSolve(start, stops) {
  if (stops.length <= 1) return stops.slice();
  const pts = stops.slice();
  const route = []; let cur = start; const rest = pts.slice();
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = optHaversine(cur, rest[i]); if (d < bd) { bd = d; bi = i; } }
    cur = rest[bi]; route.push(cur); rest.splice(bi, 1);
  }
  // 2-opt (chemin ouvert depuis start)
  const dist = (a, b) => optHaversine(a, b);
  let improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const A = i === 0 ? start : route[i - 1], B = route[i];
        const C = route[k], D = k + 1 < route.length ? route[k + 1] : null;
        const before = dist(A, B) + (D ? dist(C, D) : 0);
        const after = dist(A, C) + (D ? dist(B, D) : 0);
        if (after + 1e-6 < before) { let lo = i, hi = k; while (lo < hi) { const t = route[lo]; route[lo] = route[hi]; route[hi] = t; lo++; hi--; } improved = true; }
      }
    }
  }
  return route;
}

// --- Autocomplétion d'adresse (proxy serveur → API BAN) -------------------
async function optBanSearch(q) {
  const j = await api('GET', '/geo/search?q=' + encodeURIComponent(q));
  return (j.results || []);
}

// --- Liens de guidage gratuits (deep links) -------------------------------
function optMapsUrl(s) { return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`; }
function optWazeUrl(s) { return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`; }

// --- Ordre d'affichage : arrêts non livrés ; « passés » épinglés en tête ---
function optOrdered(st) {
  const live = st.stops.filter((s) => !s.delivered);
  const skipped = live.filter((s) => s.skipped), rest = live.filter((s) => !s.skipped);
  return skipped.concat(rest);
}

async function renderOptimizer(main) {
  _opt = optLoad();
  main.innerHTML = `<div class="page-head"><div><h1>🧭 Optimisateur de tournée</h1>
    <p>Ajoutez vos arrêts, optimisez l'ordre, et faites-vous guider. Départ : <span id="opt-startlbl">${esc(_opt.start.label)}</span>.</p></div></div>
    <div id="opt-body"></div>`;
  optRenderBody();
}

function optRenderBody() {
  const st = _opt; const body = document.getElementById('opt-body'); if (!body) return;
  const total = st.stops.length, delivered = st.stops.filter((s) => s.delivered).length;
  if (!st.optimized) {
    // ---- Écran PLANIFICATION ----
    body.innerHTML = `
      <div class="card">
        <div class="opt-startrow">
          <button class="btn ghost sm" id="opt-gps">📍 Partir de ma position</button>
          <span class="help">ou dépôt Éterville par défaut</span>
        </div>
        <label style="margin-top:.6rem">Ajouter un arrêt (adresse)</label>
        <div class="opt-search"><input id="opt-addr" placeholder="ex. 12 rue de Bayeux, Caen" autocomplete="off"><div id="opt-sug" class="opt-sug"></div></div>
        <p class="help">Recherche limitée au <strong>Calvados (14)</strong> et à l'<strong>Orne (61)</strong>. L'OCR d'étiquette arrivera en version mobile.</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap"><h3 style="margin:0">Arrêts (${total})</h3>
          ${total ? '<button class="btn ghost sm" id="opt-clear" style="margin-left:auto">Tout effacer</button>' : ''}</div>
        <div id="opt-list" class="opt-list">${st.stops.length ? st.stops.map((s, i) => optStopRow(s, i)).join('') : '<p class="help">Aucun arrêt pour le moment.</p>'}</div>
        <div style="margin-top:1rem"><button class="btn accent full" id="opt-run" ${total < 1 ? 'disabled' : ''}>🚀 Optimiser la tournée (${total})</button></div>
      </div>`;
    optBindSearch(); optBindList();
    const gps = document.getElementById('opt-gps'); if (gps) gps.onclick = optUseGps;
    const clr = document.getElementById('opt-clear'); if (clr) clr.onclick = () => { if (confirm('Effacer tous les arrêts ?')) { st.stops = []; optSave(st); optRenderBody(); } };
    const run = document.getElementById('opt-run'); if (run) run.onclick = optRun;
  } else {
    // ---- Écran TOURNÉE / ARRÊT EN COURS ----
    const order = optOrdered(st);
    const active = order.find((s) => s.id === st.activeId) || order[0] || null;
    body.innerHTML = `
      <div class="card opt-progress"><strong>${delivered}/${total} livrés</strong>
        <div class="opt-bar"><span style="width:${total ? Math.round(delivered / total * 100) : 0}%"></span></div>
        <div style="margin-left:auto;display:flex;gap:.4rem"><button class="btn ghost sm" id="opt-recalc">🔄 Recalculer</button><button class="btn ghost sm" id="opt-edit">✏️ Modifier</button></div>
      </div>
      ${active ? `<div class="card opt-active">
        <div class="opt-active-badge">Arrêt en cours ${active.skipped ? '<span class="pill warn">passé — à revenir</span>' : ''}</div>
        <div class="opt-active-addr">${esc(active.label)}</div>
        ${active.clientName ? `<div class="help">🏢 ${esc(active.clientName)}${active.window ? ' · ⏰ ' + esc(active.window) : ''}</div>` : ''}
        <div class="opt-active-actions">
          <button class="btn ok" data-deliver="${active.id}">✅ Livrer</button>
          <button class="btn ghost" data-skip="${active.id}">⏭️ Passer</button>
          <a class="btn accent" href="${optMapsUrl(active)}" target="_blank" rel="noopener">🧭 Guider (Maps)</a>
          <a class="btn ghost" href="${optWazeUrl(active)}" target="_blank" rel="noopener">Waze</a>
        </div>
      </div>` : `<div class="card"><div class="alert ok">🎉 Tournée terminée — tous les arrêts sont livrés.</div></div>`}
      <div class="card" style="padding:0;overflow:hidden"><div id="opt-map" style="height:340px"></div></div>
      <div class="card"><h3 style="margin:0 0 .5rem">Arrêts restants (${order.length})</h3>
        <div class="opt-list">${order.length ? order.map((s, i) => optRunRow(s, i, st.activeId)).join('') : '<p class="help">Aucun arrêt restant.</p>'}
        ${st.stops.some((s) => s.delivered) ? `<details style="margin-top:.6rem"><summary class="help">Livrés (${delivered})</summary>${st.stops.filter((s) => s.delivered).map((s) => `<div class="opt-row done">✅ ${esc(s.label)}</div>`).join('')}</details>` : ''}
        </div></div>`;
    document.getElementById('opt-recalc').onclick = optRun;
    document.getElementById('opt-edit').onclick = () => { st.optimized = false; optSave(st); optRenderBody(); };
    body.querySelectorAll('[data-deliver]').forEach((b) => b.onclick = () => optMark(b.dataset.deliver, 'delivered'));
    body.querySelectorAll('[data-skip]').forEach((b) => b.onclick = () => optMark(b.dataset.skip, 'skip'));
    body.querySelectorAll('[data-activate]').forEach((b) => b.onclick = () => { st.activeId = b.dataset.activate; optSave(st); optRenderBody(); });
    optDrawMap();
  }
}

function optStopRow(s, i) {
  return `<div class="opt-row"><span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}</span><button class="opt-del" data-del="${s.id}" title="Retirer">✕</button></div>`;
}
function optRunRow(s, i, activeId) {
  return `<div class="opt-row ${s.id === activeId ? 'active' : ''} ${s.skipped ? 'skipped' : ''}" data-activate="${s.id}">
    <span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}${s.skipped ? ' <span class="pill warn">passé</span>' : ''}</span></div>`;
}

function optBindSearch() {
  const inp = document.getElementById('opt-addr'), sug = document.getElementById('opt-sug'); if (!inp) return;
  let t = null, last = '';
  inp.oninput = () => {
    const q = inp.value.trim(); if (t) clearTimeout(t);
    if (q.length < 3) { sug.innerHTML = ''; return; }
    t = setTimeout(async () => {
      if (q === last) return; last = q;
      try {
        const res = await optBanSearch(q);
        sug.innerHTML = res.length
          ? res.map((r) => `<button class="opt-sug-it" data-lat="${r.lat}" data-lon="${r.lon}" data-lbl="${esc(r.label)}">${esc(r.label)}</button>`).join('')
          : '<div class="help" style="padding:.5rem">Aucune adresse dans le Calvados (14) ou l’Orne (61).</div>';
        sug.querySelectorAll('.opt-sug-it').forEach((b) => b.onclick = () => {
          _opt.stops.push({ id: 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label: b.dataset.lbl, lat: +b.dataset.lat, lon: +b.dataset.lon, delivered: false, skipped: false });
          optSave(_opt); inp.value = ''; sug.innerHTML = ''; optRenderBody();
        });
      } catch (e) { sug.innerHTML = `<div class="help" style="padding:.4rem">${esc(e.message)}</div>`; }
    }, 280);
  };
}
function optBindList() {
  document.querySelectorAll('#opt-list [data-del]').forEach((b) => b.onclick = () => { _opt.stops = _opt.stops.filter((s) => s.id !== b.dataset.del); optSave(_opt); optRenderBody(); });
}
function optUseGps() {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible.', 'err'); return; }
  toast('Localisation…', 'info');
  navigator.geolocation.getCurrentPosition((p) => {
    _opt.start = { label: 'Ma position', lat: p.coords.latitude, lon: p.coords.longitude, gps: true };
    optSave(_opt); const l = document.getElementById('opt-startlbl'); if (l) l.textContent = _opt.start.label; toast('Départ = ma position.', 'ok');
  }, () => toast('Position refusée. Départ = dépôt Éterville.', 'err'), { enableHighAccuracy: true, timeout: 8000 });
}
function optRun() {
  const st = _opt; const pending = st.stops.filter((s) => !s.delivered);
  if (!pending.length) { toast('Aucun arrêt à optimiser.', 'err'); return; }
  const solved = optSolve(st.start, pending);
  // Réordonne st.stops : livrés d'abord (conservés), puis l'ordre optimisé.
  const delivered = st.stops.filter((s) => s.delivered);
  solved.forEach((s) => { s.skipped = false; });
  st.stops = delivered.concat(solved);
  st.optimized = true; st.activeId = solved[0] ? solved[0].id : null;
  optSave(st); optRenderBody();
  toast(`Tournée optimisée : ${solved.length} arrêt(s).`, 'ok');
}
function optMark(id, kind) {
  const st = _opt; const s = st.stops.find((x) => x.id === id); if (!s) return;
  if (kind === 'delivered') { s.delivered = true; s.skipped = false; }
  else if (kind === 'skip') { s.skipped = true; }
  // Prochain arrêt actif : 1er non livré et non passé, sinon 1er restant.
  const order = optOrdered(st);
  const next = order.find((x) => !x.skipped) || order[0] || null;
  st.activeId = next ? next.id : null;
  optSave(st); optRenderBody();
  if (kind === 'delivered' && window.celebrate && !order.length) celebrate('success', { text: 'Tournée terminée !' });
}

async function optDrawMap() {
  const st = _opt; const el = document.getElementById('opt-map'); if (!el) return;
  let L; try { L = await ensureLeaflet(); } catch (e) { el.innerHTML = `<div class="alert warn" style="margin:1rem">${esc(e.message)}</div>`; return; }
  if (_optMap) { _optMap.remove(); _optMap = null; }
  _optMap = L.map(el, { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(_optMap);
  const order = optOrdered(st);
  const pts = [st.start].concat(order);
  const bounds = [];
  // Dépôt / départ
  L.marker([st.start.lat, st.start.lon], { icon: L.divIcon({ className: 'opt-pin opt-pin-depot', html: '🏠', iconSize: [28, 28] }) }).addTo(_optMap).bindPopup(esc(st.start.label));
  bounds.push([st.start.lat, st.start.lon]);
  order.forEach((s, i) => {
    const cls = s.id === st.activeId ? 'opt-pin opt-pin-active' : (s.skipped ? 'opt-pin opt-pin-skip' : 'opt-pin');
    L.marker([s.lat, s.lon], { icon: L.divIcon({ className: cls, html: String(i + 1), iconSize: [26, 26] }) }).addTo(_optMap).bindPopup(`<strong>${i + 1}.</strong> ${esc(s.label)}`);
    bounds.push([s.lat, s.lon]);
  });
  if (_optLine) { _optLine.remove(); _optLine = null; }
  _optLine = L.polyline(pts.map((p) => [p.lat, p.lon]), { color: '#2563eb', weight: 3, opacity: .7, dashArray: '6 6' }).addTo(_optMap);
  if (bounds.length > 1) _optMap.fitBounds(bounds, { padding: [30, 30] }); else _optMap.setView(bounds[0] || [49.14, -0.42], 12);
  setTimeout(() => { if (_optMap) _optMap.invalidateSize(); }, 200);
}
