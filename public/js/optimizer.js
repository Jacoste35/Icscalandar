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
        <div id="opt-startinfo" class="opt-startinfo">${optStartInfoHTML(st.start)}</div>
        <label style="margin-top:.6rem">Ajouter un arrêt (adresse)</label>
        <div class="opt-search"><input id="opt-addr" placeholder="ex. 12 rue de Bayeux, Caen" autocomplete="off"><div id="opt-sug" class="opt-sug"></div></div>
        <div style="margin-top:.6rem"><button class="btn accent sm" id="opt-scan">📷 Scanner une étiquette / feuille de tournée</button>
          <input type="file" id="opt-scan-file" accept="image/*" capture="environment" style="display:none"></div>
        <div id="opt-scan-out"></div>
        <p class="help">Recherche limitée au <strong>Calvados (14)</strong> et à l'<strong>Orne (61)</strong>.</p>
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
    const scanBtn = document.getElementById('opt-scan'), scanFile = document.getElementById('opt-scan-file');
    if (scanBtn && scanFile) { scanBtn.onclick = () => scanFile.click(); scanFile.onchange = () => { const f = scanFile.files && scanFile.files[0]; if (f) optScan(f); scanFile.value = ''; }; }
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
  const pro = s.clientName ? ` <span class="pill ok">🏢 ${esc(s.clientName)}</span>` : '';
  const hrs = s.horaires ? ` <span class="help">⏰ ${esc(s.horaires)}</span>` : '';
  const proBtn = s.clientName ? '' : `<button class="btn ghost sm" data-pro="${s.id}" title="Enregistrer comme client pro">🏢</button>`;
  return `<div class="opt-row"><span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}${pro}${hrs}</span>${proBtn}<button class="opt-del" data-del="${s.id}" title="Retirer">✕</button></div>`;
}
function optRunRow(s, i, activeId) {
  const pro = s.clientName ? ` <span class="pill ok">🏢 ${esc(s.clientName)}</span>` : '';
  return `<div class="opt-row ${s.id === activeId ? 'active' : ''} ${s.skipped ? 'skipped' : ''}" data-activate="${s.id}">
    <span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}${pro}${s.skipped ? ' <span class="pill warn">passé</span>' : ''}</span></div>`;
}
// Ajoute un arrêt puis tente de reconnaître un client pro (proximité + nom).
function optAddStop(label, lat, lon) {
  const stop = { id: 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, lat, lon, delivered: false, skipped: false };
  _opt.stops.push(stop); optSave(_opt);
  api('GET', `/clients/match?lat=${lat}&lon=${lon}&name=${encodeURIComponent(label)}`).then((r) => {
    if (r && r.client) { stop.clientId = r.client.id; stop.clientName = r.client.name; stop.horaires = r.client.horaires || ''; stop.window = r.client.horaires || ''; optSave(_opt); if (_opt.optimized) optRenderBody(); else optRefreshList(); }
  }).catch(() => {});
  return stop;
}
// Rafraîchit uniquement la liste d'arrêts (préserve le panneau de scan et l'input).
function optRefreshList() {
  const listEl = document.getElementById('opt-list'); if (!listEl) return;
  listEl.innerHTML = _opt.stops.length ? _opt.stops.map((s, i) => optStopRow(s, i)).join('') : '<p class="help">Aucun arrêt pour le moment.</p>';
  optBindList();
  const run = document.getElementById('opt-run'); if (run) { run.disabled = _opt.stops.length < 1; run.textContent = `🚀 Optimiser la tournée (${_opt.stops.length})`; }
}
// Enregistre l'arrêt courant comme client pro (avec suggestion de nom via OSM).
function optRegisterPro(id) {
  const s = _opt.stops.find((x) => x.id === id); if (!s || typeof modal !== 'function') return;
  modal({
    title: '🏢 Enregistrer un client pro',
    bodyHTML: `<p class="help">${esc(s.label)}</p>
      <label>Nom de l'établissement *</label><input id="pro-name" placeholder="ex. Établissement Passard" value="${esc(s.clientName || '')}">
      <div class="help" id="pro-sugg" style="margin:.25rem 0"></div>
      <label style="margin-top:.5rem">Horaires d'ouverture (facultatif)</label><input id="pro-hours" placeholder="ex. 9h-12h30, 14h-18h" value="${esc(s.horaires || '')}">
      <p class="help">Enregistré une fois, ce client sera reconnu automatiquement aux prochaines tournées.</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="pro-save">Enregistrer</button>`,
    onMount: (ov) => {
      api('GET', `/geo/poi?lat=${s.lat}&lon=${s.lon}`).then((r) => {
        if (r && r.name) { const nm = ov.querySelector('#pro-name'), sg = ov.querySelector('#pro-sugg'); if (sg) { sg.innerHTML = `Suggestion : <a href="#" id="pro-us">${esc(r.name)}</a>`; ov.querySelector('#pro-us').onclick = (e) => { e.preventDefault(); nm.value = r.name; }; } if (nm && !nm.value) nm.value = r.name; }
      }).catch(() => {});
      ov.querySelector('#pro-save').onclick = async () => {
        const name = ov.querySelector('#pro-name').value.trim(); if (!name) { toast('Nom requis.', 'err'); return; }
        const horaires = ov.querySelector('#pro-hours').value.trim();
        try { const r = await api('POST', '/clients', { name, address: s.label, lat: s.lat, lon: s.lon, horaires }); s.clientId = r.client.id; s.clientName = r.client.name; s.horaires = r.client.horaires || ''; s.window = r.client.horaires || ''; optSave(_opt); closeModal(); if (_opt.optimized) optRenderBody(); else optRefreshList(); toast('Client pro enregistré ✓', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
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
          optAddStop(b.dataset.lbl, +b.dataset.lat, +b.dataset.lon);
          inp.value = ''; sug.innerHTML = ''; optRefreshList();
        });
      } catch (e) { sug.innerHTML = `<div class="help" style="padding:.4rem">${esc(e.message)}</div>`; }
    }, 280);
  };
}
function optBindList() {
  document.querySelectorAll('#opt-list [data-del]').forEach((b) => b.onclick = () => { _opt.stops = _opt.stops.filter((s) => s.id !== b.dataset.del); optSave(_opt); optRefreshList(); });
  document.querySelectorAll('#opt-list [data-pro]').forEach((b) => b.onclick = () => optRegisterPro(b.dataset.pro));
}
// Encart d'info sous « Partir de ma position » : coordonnées + adresse trouvée.
function optStartInfoHTML(start) {
  if (!start || !start.gps) return '';
  const acc = start.acc != null ? ` · précision ±${Math.round(start.acc)} m` : '';
  return `<div class="opt-gpsbox">📍 <strong>Position trouvée</strong> : ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}${acc}
    <div class="help" id="opt-gpsaddr">${start.addr ? esc(start.addr) : 'Adresse en cours…'}</div></div>`;
}
function optUseGps() {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible.', 'err'); return; }
  const info = document.getElementById('opt-startinfo'); if (info) info.innerHTML = '<div class="help">📍 Localisation en cours…</div>';
  navigator.geolocation.getCurrentPosition(async (p) => {
    _opt.start = { label: 'Ma position', lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, gps: true, addr: '' };
    optSave(_opt);
    const l = document.getElementById('opt-startlbl'); if (l) l.textContent = _opt.start.label;
    if (info) info.innerHTML = optStartInfoHTML(_opt.start);
    toast('Départ = ma position.', 'ok');
    // Reverse-géocodage pour vérification visuelle (adresse la plus proche).
    try { const r = await api('GET', `/geo/reverse?lat=${_opt.start.lat}&lon=${_opt.start.lon}`); _opt.start.addr = r.label || 'Adresse non trouvée'; optSave(_opt); const a = document.getElementById('opt-gpsaddr'); if (a) a.textContent = _opt.start.addr; }
    catch (e) { const a = document.getElementById('opt-gpsaddr'); if (a) a.textContent = 'Adresse indisponible'; }
  }, (err) => { if (info) info.innerHTML = `<div class="help" style="color:var(--danger)">Position refusée (${esc(err.message || '')}). Départ = dépôt Éterville.</div>`; toast('Position refusée.', 'err'); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

// --- OCR (Tesseract.js) : photo d'étiquette / feuille de tournée -----------
let _tessPromise = null;
function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tessPromise) return _tessPromise;
  _tessPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('OCR indisponible (connexion requise au 1er scan).'));
    document.head.appendChild(s);
  });
  return _tessPromise;
}
// Réduit la photo (max 1600 px) et la passe en niveaux de gris → OCR plus rapide/net.
function optPrepImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1600, sc = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      try { const d = ctx.getImageData(0, 0, w, h); const px = d.data; for (let i = 0; i < px.length; i += 4) { const g = (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11); px[i] = px[i + 1] = px[i + 2] = g; } ctx.putImageData(d, 0, 0); } catch (e) {}
      URL.revokeObjectURL(url); resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}
// Extrait des adresses candidates du texte OCR (lignes avec un CP 14xxx/61xxx).
function optParseAddresses(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 3);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b(14|61)\s?\d{3}\b/);
    if (!m) continue;
    const cp = m[0].replace(/\s/g, '');
    const idx = lines[i].indexOf(m[0]);
    const cityPart = (cp + ' ' + lines[i].slice(idx + m[0].length)).replace(/\s+/g, ' ').trim();
    let street = lines[i].slice(0, idx).trim();
    if (!street && i > 0) street = lines[i - 1];
    const cand = ((street ? street + ' ' : '') + cityPart).replace(/\s+/g, ' ').trim();
    if (cand.length > 6) out.push(cand);
  }
  return [...new Set(out)];
}
async function optScan(file) {
  const outEl = document.getElementById('opt-scan-out'); if (!outEl) return;
  outEl.innerHTML = '<div class="opt-scanning"><div class="spin"></div> Analyse de l’image… <span id="opt-scan-pct">0%</span></div>';
  try {
    const canvas = await optPrepImage(file);
    const T = await ensureTesseract();
    const { data } = await T.recognize(canvas, 'fra', { logger: (m) => { if (m.status === 'recognizing text') { const e = document.getElementById('opt-scan-pct'); if (e) e.textContent = Math.round(m.progress * 100) + '%'; } } });
    const text = (data && data.text) || '';
    const cands = optParseAddresses(text);
    outEl.innerHTML = `
      <div class="card" style="margin-top:.6rem;background:#f8fafc">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap"><strong>📷 ${cands.length} adresse(s) détectée(s)</strong><button class="btn ghost sm" id="opt-scan-close" style="margin-left:auto">✕</button></div>
        ${cands.length ? cands.map((c, i) => `<div class="opt-cand"><span class="opt-lbl">${esc(c)}</span><button class="btn accent sm" data-cand="${i}">Ajouter</button></div>`).join('')
          : '<p class="help">Aucune adresse (CP 14/61) reconnue. Utilisez la saisie manuelle ci-dessus ou reprenez la photo bien cadrée.</p>'}
        <details style="margin-top:.4rem"><summary class="help">Texte lu par l’OCR</summary><pre class="opt-ocrtext">${esc(text || '(vide)')}</pre></details>
      </div>`;
    outEl.querySelector('#opt-scan-close').onclick = () => { outEl.innerHTML = ''; };
    outEl.querySelectorAll('[data-cand]').forEach((b) => b.onclick = async () => {
      const q = cands[+b.dataset.cand]; b.disabled = true; b.textContent = '…';
      try {
        const r = await optBanSearch(q); const hit = r[0];
        if (!hit) { toast('Adresse introuvable en zone 14/61.', 'err'); b.disabled = false; b.textContent = 'Ajouter'; return; }
        optAddStop(hit.label, hit.lat, hit.lon);
        b.textContent = '✓ Ajouté'; optRefreshList();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Ajouter'; }
    });
  } catch (e) { outEl.innerHTML = `<div class="alert warn" style="margin-top:.6rem">${esc(e.message)}</div>`; }
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
