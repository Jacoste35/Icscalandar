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

// Transporteurs + template OCR : « anchors » = mots-clés qui marquent le bloc
// DESTINATAIRE (on isole l'adresse de livraison, pas l'expéditeur).
const OPT_CARRIERS = [
  { id: 'fedex', name: 'FedEx', color: '#4d148c', anchors: ['to', 'ship to', 'deliver to', 'destinataire', 'consignee'] },
  { id: 'gls', name: 'GLS', color: '#ffcc00', anchors: ['destinataire', 'consignee', 'empfänger', 'livraison'] },
  { id: 'ciblex', name: 'Ciblex', color: '#e30613', anchors: ['destinataire', 'livraison', 'a livrer', 'à livrer'] },
  { id: 'laposte', name: 'La Poste', color: '#ffd100', anchors: ['destinataire', 'livraison', 'colissimo'] },
];
function optCarrier(id) { return OPT_CARRIERS.find((c) => c.id === id) || null; }

// Jours de la semaine (clé stockée = français, comme demandé dans la fiche).
const OPT_DAYS = [['lundi', 'Lun'], ['mardi', 'Mar'], ['mercredi', 'Mer'], ['jeudi', 'Jeu'], ['vendredi', 'Ven'], ['samedi', 'Sam'], ['dimanche', 'Dim']];
function optHoursObj(h) { return (h && typeof h === 'object') ? h : {}; }
function optHoursText(h) { const o = optHoursObj(h); return OPT_DAYS.filter(([k]) => o[k]).map(([k, s]) => `${s} ${o[k]}`).join(' · '); }
function optTodayKey() { return OPT_DAYS[(new Date().getDay() + 6) % 7][0]; }
function optTodayHours(h) { const o = optHoursObj(h); return o[optTodayKey()] || (typeof h === 'string' ? h : ''); }
// Parse « 9h-12h30, 14h-18h » → [[540,750],[840,1080]] (minutes). Tolérant.
function optParseRanges(s) {
  const out = []; String(s || '').split(/[,;]+/).forEach((part) => {
    const m = part.match(/(\d{1,2})\s*[h:]\s*(\d{0,2}).*?[-–à]\s*(\d{1,2})\s*[h:]\s*(\d{0,2})/i);
    if (m) out.push([(+m[1]) * 60 + (+(m[2] || 0)), (+m[3]) * 60 + (+(m[4] || 0))]);
  });
  return out;
}
function optHhmm(min) { const h = Math.floor(min / 60), m = min % 60; return `${h}h${m < 10 ? '0' : ''}${m}`; }
// État d'ouverture aujourd'hui à une heure donnée (min). Renvoie {open, txt}.
function optOpenState(hoursToday, atMin) {
  const r = optParseRanges(hoursToday); if (!r.length) return { open: null, txt: hoursToday || '' };
  const now = atMin == null ? (new Date().getHours() * 60 + new Date().getMinutes()) : atMin;
  for (const [a, b] of r) { if (now >= a && now <= b) return { open: true, txt: `ouvert (jusqu'à ${optHhmm(b)})` }; }
  const next = r.map((x) => x[0]).filter((a) => a > now).sort((a, b) => a - b)[0];
  return { open: false, txt: next != null ? `fermé — ouvre à ${optHhmm(next)}` : 'fermé' };
}

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

// =========================================================================
//  OPTIMISATION AVEC FENÊTRES HORAIRES (livrer le max de clients / jour)
//  100 % local : temps de trajet estimés (haversine × détour), respect des
//  heures d'ouverture du client, priorité aux clients qui ferment bientôt.
// =========================================================================
// Temps de trajet estimé en minutes (facteur détour routier 1,3).
function optTravelMin(a, b, speedKmh) { return (optHaversine(a, b) * 1.3) / ((speedKmh || 32) * 1000 / 60); }
// Fenêtres d'ouverture du jour pour un arrêt.
//  { wins:[[o,c]…] } = ouvert sur ces plages ; wins:null = inconnu (aucune
//  contrainte) ; closedToday:true = horaires renseignés mais fermé aujourd'hui.
function optDayInfo(s) {
  const o = optHoursObj(s && s.hours);
  const hasObj = o && Object.keys(o).length > 0;
  const today = optTodayHours(s && s.hours);
  const wins = optParseRanges(today);
  if (wins.length) return { wins, closedToday: false };
  if (hasObj && !today) return { wins: [], closedToday: true }; // objet rempli, rien aujourd'hui
  return { wins: null, closedToday: false };                    // inconnu / texte libre
}
// Fonction temps de trajet : matrice OSRM si dispo, sinon estimation.
function optTravelOf(o) {
  return (a, b) => {
    const M = o && o.matrix;
    if (M && a && b && a._mi != null && b._mi != null && M[a._mi] && M[a._mi][b._mi] != null && isFinite(M[a._mi][b._mi])) return M[a._mi][b._mi];
    return optTravelMin(a, b, o ? o.speedKmh : 32);
  };
}
// Planifie un ordre donné : renvoie l'horaire de chaque arrêt + métriques.
function optScheduleRoute(start, route, o) {
  const tt = o.travel || optTravelOf(o);
  let cur = start, t = o.departMin, delivered = 0, missed = 0;
  const sched = [];
  for (const s of route) {
    const travel = tt(cur, s);
    const arrival = t + travel;
    const info = optDayInfo(s);
    let serviceStart = arrival, wait = 0, ok = true, closeUsed = null;
    if (info.closedToday) { ok = false; }
    else if (info.wins) {
      let placed = null;
      for (const [op, cl] of info.wins) { if (arrival <= cl) { const ss = Math.max(arrival, op); if (ss <= cl) { placed = [ss, cl]; break; } } }
      if (placed) { serviceStart = placed[0]; wait = serviceStart - arrival; closeUsed = placed[1]; }
      else { ok = false; } // arrivée après la dernière fermeture
    }
    if (ok) delivered++; else missed++;
    sched.push({ id: s.id, arrival, serviceStart, wait, ok, closeUsed, closedToday: info.closedToday });
    cur = s; t = (ok ? serviceStart : arrival) + o.serviceMin;
  }
  return { sched, delivered, missed, makespan: t - o.departMin };
}
// Construction gloutonne « plus proche voisin » sensible aux fenêtres :
//  à chaque pas, privilégie un client dont la fermeture est imminente, sinon
//  le plus proche joignable pendant ses heures. Les clients injoignables
//  aujourd'hui (fermés / trop tard) sont ajoutés en fin de tournée, signalés.
function optSolveTW(start, stops, o) {
  const tt = o.travel || optTravelOf(o);
  const rest = stops.slice(), route = [];
  let cur = start, t = o.departMin;
  while (rest.length) {
    const evals = [];
    for (let i = 0; i < rest.length; i++) {
      const s = rest[i], travel = tt(cur, s), arrival = t + travel;
      const info = optDayInfo(s);
      if (info.closedToday) continue;
      if (!info.wins) { evals.push({ i, cost: travel, slack: Infinity, serviceStart: arrival, travel }); continue; }
      let placed = null;
      for (const [op, cl] of info.wins) { if (arrival <= cl) { const ss = Math.max(arrival, op); if (ss <= cl) { placed = [ss, cl]; break; } } }
      if (!placed) continue; // pas joignable dans une fenêtre → traité en fin
      evals.push({ i, cost: travel + (placed[0] - arrival), slack: placed[1] - arrival, serviceStart: placed[0], travel });
    }
    if (!evals.length) break;
    const atRisk = evals.filter((e) => e.slack <= 40 + e.travel);
    const pick = atRisk.length ? atRisk.sort((a, b) => a.slack - b.slack)[0] : evals.sort((a, b) => a.cost - b.cost)[0];
    const s = rest[pick.i]; route.push(s); rest.splice(pick.i, 1);
    cur = s; t = pick.serviceStart + o.serviceMin;
  }
  // Reliquat (fermé aujourd'hui / arrivée trop tardive) : au plus proche voisin.
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = optHaversine(cur, rest[i]); if (d < bd) { bd = d; bi = i; } }
    route.push(rest[bi]); cur = rest[bi]; rest.splice(bi, 1);
  }
  return route;
}
// Amélioration 2-opt guidée par le score (max livrés, puis durée mini).
function optImproveTW(start, route, o) {
  const score = (r) => { const m = optScheduleRoute(start, r, o); return m.delivered * 1e6 - m.makespan; };
  let cur = route.slice(), best = score(cur), improved = true, guard = 0;
  while (improved && guard++ < 40) {
    improved = false;
    for (let i = 0; i < cur.length - 1; i++) {
      for (let k = i + 1; k < cur.length; k++) {
        const cand = cur.slice(0, i).concat(cur.slice(i, k + 1).reverse(), cur.slice(k + 1));
        const sc = score(cand);
        if (sc > best + 1e-6) { cur = cand; best = sc; improved = true; }
      }
    }
  }
  return cur;
}
// Paramètres d'optimisation courants (heure de départ, vitesse, temps par arrêt).
function optRunOpts(forceNow) {
  const st = _opt, d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  const departMin = (!forceNow && st.departMin != null) ? st.departMin : now;
  return { departMin, speedKmh: st.speedKmh || 32, serviceMin: (st.serviceMin != null ? st.serviceMin : 2.5) };
}

// --- Autocomplétion d'adresse (proxy serveur → API BAN) -------------------
async function optBanSearch(q) {
  const j = await api('GET', '/geo/search?q=' + encodeURIComponent(q));
  return (j.results || []);
}

// --- Liens de guidage gratuits (deep links) -------------------------------
function optMapsUrl(s) { return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`; }
function optWazeUrl(s) { return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`; }

// --- Ordre d'affichage : arrêts ouverts (ni livrés ni absents) ; « passés » en tête ---
function optClosed(s) { return s.delivered || s.absent; }
function optOrdered(st) {
  const live = st.stops.filter((s) => !optClosed(s));
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
        <label>Transporteur <span class="help">— adapte la lecture de l'étiquette</span></label>
        <div class="opt-carriers">${OPT_CARRIERS.map((c) => `<button class="opt-carrier ${st.carrier === c.id ? 'sel' : ''}" data-carrier="${c.id}" style="--cc:${c.color}">${esc(c.name)}</button>`).join('')}</div>
      </div>
      <div class="card">
        <div class="opt-startrow">
          <button class="btn ghost sm" id="opt-gps">📍 Partir de ma position</button>
          <span class="help">ou dépôt Éterville par défaut</span>
        </div>
        <div id="opt-startinfo" class="opt-startinfo">${optStartInfoHTML(st.start)}</div>
        <label style="margin-top:.6rem">Ajouter un arrêt (adresse)</label>
        <div class="opt-search"><input id="opt-addr" placeholder="ex. 12 rue de Bayeux, Caen" autocomplete="off"><div id="opt-sug" class="opt-sug"></div></div>
        <label style="margin-top:.6rem">Scanner une étiquette / feuille de tournée</label>
        <div class="opt-scanbtns">
          <button class="btn accent sm" id="opt-scan-cam">📷 Prendre en photo</button>
          <button class="btn ghost sm" id="opt-scan-gal">🖼️ Depuis ma pellicule</button>
          <input type="file" id="opt-scan-cam-file" accept="image/*" capture="environment" style="display:none">
          <input type="file" id="opt-scan-gal-file" accept="image/*" multiple style="display:none">
        </div>
        <p class="help" style="margin:.3rem 0 0">Feuille FedEx sur plusieurs pages ? Sélectionnez toutes les photos d'un coup depuis la pellicule.</p>
        <div id="opt-scan-out"></div>
        <p class="help">Recherche limitée au <strong>Calvados (14)</strong> et à l'<strong>Orne (61)</strong>.${st.carrier ? ` Étiquettes : <strong>${esc(optCarrier(st.carrier).name)}</strong>.` : ''}</p>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap"><h3 style="margin:0">Arrêts (${total})</h3>
          ${total ? '<button class="btn ghost sm" id="opt-clear" style="margin-left:auto">Tout effacer</button>' : ''}</div>
        <div id="opt-list" class="opt-list">${st.stops.length ? st.stops.map((s, i) => optStopRow(s, i)).join('') : '<p class="help">Aucun arrêt pour le moment.</p>'}</div>
        ${optSettingsHTML()}
        <div style="margin-top:1rem"><button class="btn accent full" id="opt-run" ${total < 1 ? 'disabled' : ''}>🚀 Optimiser la tournée (${total})</button></div>
      </div>`;
    optBindSearch(); optBindList();
    const gps = document.getElementById('opt-gps'); if (gps) gps.onclick = optUseGps;
    const clr = document.getElementById('opt-clear'); if (clr) clr.onclick = () => { if (confirm('Effacer tous les arrêts ?')) { st.stops = []; optSave(st); optRenderBody(); } };
    const run = document.getElementById('opt-run'); if (run) run.onclick = () => optRun();
    const camBtn = document.getElementById('opt-scan-cam'), camFile = document.getElementById('opt-scan-cam-file');
    if (camBtn && camFile) { camBtn.onclick = () => camFile.click(); camFile.onchange = () => { const f = camFile.files && camFile.files[0]; if (f) optScan(f); camFile.value = ''; }; }
    const galBtn = document.getElementById('opt-scan-gal'), galFile = document.getElementById('opt-scan-gal-file');
    if (galBtn && galFile) { galBtn.onclick = () => galFile.click(); galFile.onchange = () => { const fs = galFile.files; if (fs && fs.length) optScan(fs); galFile.value = ''; }; }
    body.querySelectorAll('[data-carrier]').forEach((b) => b.onclick = () => { st.carrier = (st.carrier === b.dataset.carrier) ? null : b.dataset.carrier; optSave(st); optRenderBody(); });
    const dep = document.getElementById('opt-depart'); if (dep) dep.onchange = () => { const p = dep.value.split(':').map(Number); if (Number.isFinite(p[0])) { st.departMin = p[0] * 60 + (p[1] || 0); optSave(st); } };
    const sv = document.getElementById('opt-service'); if (sv) sv.onchange = () => { const v = parseFloat(sv.value); st.serviceMin = Math.min(30, Math.max(0, Number.isFinite(v) ? v : 2.5)); optSave(st); };
  } else {
    // ---- Écran TOURNÉE / ARRÊT EN COURS ----
    const order = optOrdered(st);
    const active = order.find((s) => s.id === st.activeId) || order[0] || null;
    const absent = st.stops.filter((s) => s.absent).length;
    const closed = delivered + absent;
    body.innerHTML = `
      <div class="card opt-progress"><strong>${closed}/${total} clôturés</strong> <span class="help">${delivered} livré(s)${absent ? ` · ${absent} absent(s)` : ''}</span>
        <div class="opt-bar"><span style="width:${total ? Math.round(closed / total * 100) : 0}%"></span></div>
        <div style="margin-left:auto;display:flex;gap:.4rem"><button class="btn ghost sm" id="opt-recalc">🔄 Recalculer</button><button class="btn ghost sm" id="opt-edit">✏️ Modifier</button></div>
      </div>
      ${active ? `<div class="card opt-active">
        <div class="opt-active-badge">Arrêt en cours ${active.skipped ? '<span class="pill warn">passé — à revenir</span>' : ''}</div>
        <div class="opt-active-addr">${esc(active.label)}</div>
        ${active.clientName ? `<div class="help">🏢 <strong>${esc(active.clientName)}</strong>${optHoursBadge(active)}</div>` : (active.scanName ? `<div class="help">🏢 <strong>${esc(active.scanName)}</strong></div>` : '')}
        ${optActiveEtaHTML(active)}
        <div class="opt-active-actions">
          <button class="btn ok" data-deliver="${active.id}">✅ Livrer</button>
          <button class="btn danger" data-absent="${active.id}">🚫 Absent</button>
          <button class="btn ghost" data-skip="${active.id}">⏭️ Passer</button>
        </div>
        <div class="opt-active-actions" style="margin-top:.4rem">
          <a class="btn accent" href="${optMapsUrl(active)}" target="_blank" rel="noopener">🧭 Guider (Maps)</a>
          <a class="btn ghost" href="${optWazeUrl(active)}" target="_blank" rel="noopener">Waze</a>
        </div>
      </div>` : `<div class="card"><div class="alert ok">🎉 Tournée terminée — tous les arrêts sont clôturés.</div></div>`}
      <div class="card" style="padding:0;overflow:hidden"><div id="opt-map" style="height:340px"></div></div>
      <div class="card"><h3 style="margin:0 0 .5rem">Arrêts restants (${order.length})</h3>
        <div class="opt-list">${order.length ? order.map((s, i) => optRunRow(s, i, st.activeId)).join('') : '<p class="help">Aucun arrêt restant.</p>'}
        ${closed ? `<details style="margin-top:.6rem"><summary class="help">Clôturés (${closed})</summary>${st.stops.filter(optClosed).map((s) => `<div class="opt-row done">${s.absent ? '🚫' : '✅'} ${esc(s.label)}${s.absent ? ' <span class="pill danger">absent</span>' : ''}</div>`).join('')}</details>` : ''}
        </div></div>`;
    document.getElementById('opt-recalc').onclick = () => optRun(true);
    document.getElementById('opt-edit').onclick = () => { st.optimized = false; optSave(st); optRenderBody(); };
    body.querySelectorAll('[data-deliver]').forEach((b) => b.onclick = () => optMark(b.dataset.deliver, 'delivered'));
    body.querySelectorAll('[data-absent]').forEach((b) => b.onclick = () => optMark(b.dataset.absent, 'absent'));
    body.querySelectorAll('[data-skip]').forEach((b) => b.onclick = () => optMark(b.dataset.skip, 'skip'));
    body.querySelectorAll('[data-activate]').forEach((b) => b.onclick = () => { st.activeId = b.dataset.activate; optSave(st); optRenderBody(); });
    optDrawMap();
  }
}

// Nom affiché : client pro reconnu, sinon nom lu sur l'étiquette (destinataire).
function optNameBadge(s) {
  if (s.clientName) return ` <span class="pill ok">🏢 ${esc(s.clientName)}</span>`;
  if (s.scanName) return ` <span class="pill muted">🏢 ${esc(s.scanName)}</span>`;
  return '';
}
function optStopRow(s, i) {
  const di = optDayInfo(s);
  const today = optTodayHours(s.hours);
  const hrs = di.closedToday ? ` <span class="pill danger">🔒 fermé auj.</span>` : (today ? ` <span class="help">⏰ ${esc(today)}</span>` : '');
  const proBtn = s.clientName ? '' : `<button class="btn ghost sm" data-pro="${s.id}" title="Enregistrer comme client pro">🏢</button>`;
  return `<div class="opt-row"><span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}${optNameBadge(s)}${optPkgBadge(s)}${hrs}</span>${proBtn}<button class="opt-del" data-del="${s.id}" title="Retirer">✕</button></div>`;
}
function optRunRow(s, i, activeId) {
  return `<div class="opt-row ${s.id === activeId ? 'active' : ''} ${s.skipped ? 'skipped' : ''}" data-activate="${s.id}">
    <span class="opt-num">${i + 1}</span><span class="opt-lbl">${esc(s.label)}${optNameBadge(s)}${optPkgBadge(s)}${optEtaPill(s)}${s.skipped ? ' <span class="pill warn">passé</span>' : ''}</span></div>`;
}
// Normalise un libellé d'adresse (minuscules, sans accents ni ponctuation).
function optNormLbl(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
// Ajoute un arrêt puis tente de reconnaître un client pro (proximité + nom).
// Dédoublonnage : même point (≤30 m) ou même adresse → un seul arrêt, on
// cumule les colis (« plusieurs colis possible »).
function optAddStop(label, lat, lon, count, scanName) {
  const add = Math.max(1, count || 1);
  const ck = optCompanyKey(scanName);
  // Même point ET même entreprise → on cumule les colis. Entreprise différente
  // à la même adresse → NOUVEAU point de livraison (demande client).
  const dup = _opt.stops.find((s) => {
    const place = (Number.isFinite(s.lat) && optHaversine(s, { lat, lon }) < 30) || optNormLbl(s.label) === optNormLbl(label);
    if (!place) return false;
    const sck = optCompanyKey(s.scanName || s.clientName || '');
    if (ck && sck) return ck === sck || ck.includes(sck) || sck.includes(ck); // même société
    return true; // au moins un sans nom → même point
  });
  if (dup) {
    dup.packages = (dup.packages || 1) + add; if (scanName && !dup.scanName) dup.scanName = scanName; optSave(_opt);
    if (_opt.optimized) optRenderBody(); else optRefreshList();
    if (typeof toast === 'function') toast(`${dup.clientName || dup.scanName || 'Adresse'} : ${dup.packages} colis possibles.`, 'ok');
    return dup;
  }
  const stop = { id: 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label, lat, lon, packages: add, scanName: scanName || '', delivered: false, skipped: false };
  _opt.stops.push(stop); optSave(_opt);
  api('GET', `/clients/match?lat=${lat}&lon=${lon}&name=${encodeURIComponent(scanName || label)}`).then((r) => {
    if (r && r.client) { stop.clientId = r.client.id; stop.clientName = r.client.name; stop.hours = r.client.horaires || ''; optSave(_opt); if (_opt.optimized) optRenderBody(); else optRefreshList(); }
  }).catch(() => {});
  return stop;
}
// Pastille « plusieurs colis possible » (adresse détectée plusieurs fois).
function optPkgBadge(s) { return (s.packages && s.packages > 1) ? ` <span class="pill warn">📦 plusieurs colis possible (${s.packages})</span>` : ''; }
// Rafraîchit uniquement la liste d'arrêts (préserve le panneau de scan et l'input).
function optRefreshList() {
  const listEl = document.getElementById('opt-list'); if (!listEl) return;
  listEl.innerHTML = _opt.stops.length ? _opt.stops.map((s, i) => optStopRow(s, i)).join('') : '<p class="help">Aucun arrêt pour le moment.</p>';
  optBindList();
  const run = document.getElementById('opt-run'); if (run) { run.disabled = _opt.stops.length < 1; run.textContent = `🚀 Optimiser la tournée (${_opt.stops.length})`; }
}
// Options d'un menu déroulant d'heure (pas de 15 min, 6h→21h).
function optTimeOptions(sel) {
  let html = '';
  let has = false;
  for (let m = 5 * 60; m <= 22 * 60; m += 15) { const v = optHhmm(m); if (v === sel) has = true; html += `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`; }
  if (sel && !has) html = `<option value="${sel}" selected>${sel}</option>` + html; // valeur hors grille (legacy) préservée
  return html;
}
// Reconstitue l'état d'une journée depuis la chaîne stockée (pour pré-remplir).
//  0 plage = fermé ; 1 plage = journée continue ; 2 plages = pause déjeuner.
function optDayState(str) {
  const r = optParseRanges(str);
  if (!r.length) return { open: false };
  if (r.length === 1) return { open: true, pause: false, o1: optHhmm(r[0][0]), c1: optHhmm(r[0][1]) };
  return { open: true, pause: true, o1: optHhmm(r[0][0]), ps: optHhmm(r[0][1]), pe: optHhmm(r[1][0]), c1: optHhmm(r[r.length - 1][1]) };
}
// Éditeur d'horaires RAPIDE : par défaut 3 lignes groupées (Lun–Ven, Samedi,
// Dimanche) + raccourcis en un clic. Case « différents selon les jours » pour
// détailler jour par jour au besoin. Sortie identique au format « 9h00-18h00 ».
const OPT_WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];
const OPT_DAYNAME = { lundi: 'Lundi', mardi: 'Mardi', mercredi: 'Mercredi', jeudi: 'Jeudi', vendredi: 'Vendredi', samedi: 'Samedi', dimanche: 'Dimanche' };
// Faut-il ouvrir le mode « jour par jour » ? (semaine non homogène)
function optHoursNeedPerDay(hoursObj) {
  const o = optHoursObj(hoursObj); const vals = OPT_WEEKDAYS.map((d) => o[d] || '');
  return !vals.every((v) => v === vals[0]);
}
// Groupes affichés selon le mode.
function optHoursGroups(perDay) {
  if (perDay) return OPT_DAYS.map(([k]) => ({ label: OPT_DAYNAME[k], days: [k] }));
  return [{ label: 'Lundi – Vendredi', days: OPT_WEEKDAYS }, { label: 'Samedi', days: ['samedi'] }, { label: 'Dimanche', days: ['dimanche'] }];
}
// Une ligne groupée (l'état est repris du 1er jour du groupe).
function optGrpRowHTML(g, o) {
  const st = optDayState(o[g.days[0]]);
  const o1 = st.open ? st.o1 : '9h00', c1 = st.open ? st.c1 : '18h00';
  const pause = !!(st.open && st.pause), ps = pause ? st.ps : '12h00', pe = pause ? st.pe : '14h00';
  return `<div class="opt-grp" data-days="${g.days.join(',')}">
    <label class="opt-dname"><input type="checkbox" data-role="open" ${st.open ? 'checked' : ''}> ${g.label}</label>
    <div class="opt-times" ${st.open ? '' : 'hidden'}>
      <span class="opt-tg">Ouv. <select data-role="o1">${optTimeOptions(o1)}</select></span>
      <label class="opt-pchk"><input type="checkbox" data-role="pause" ${pause ? 'checked' : ''}> Pause midi</label>
      <span class="opt-pause opt-tg" ${pause ? '' : 'hidden'}>ferme <select data-role="ps">${optTimeOptions(ps)}</select> rouvre <select data-role="pe">${optTimeOptions(pe)}</select></span>
      <span class="opt-tg">Ferm. <select data-role="c1">${optTimeOptions(c1)}</select></span>
    </div>
    <span class="opt-closed help" ${st.open ? 'hidden' : ''}>Fermé</span>
  </div>`;
}
function optHoursEditorHTML(hoursObj, perDay) {
  const o = optHoursObj(hoursObj);
  if (perDay == null) perDay = optHoursNeedPerDay(o);
  return `<div class="opt-hours-edit" data-perday="${perDay ? 1 : 0}">
    <div class="opt-presets">
      <button type="button" class="opt-chip" data-preset="8-18">Lun–Ven 8h–18h</button>
      <button type="button" class="opt-chip" data-preset="9-18lunch">Lun–Ven 9h–12h30 · 14h–18h</button>
      <button type="button" class="opt-chip" data-preset="8-19sat">Lun–Sam 8h–19h</button>
      <button type="button" class="opt-chip" data-preset="clear">Tout fermer</button>
    </div>
    ${optHoursGroups(perDay).map((g) => optGrpRowHTML(g, o)).join('')}
    <label class="opt-perday-toggle"><input type="checkbox" data-role="perday" ${perDay ? 'checked' : ''}> Horaires différents selon les jours</label>
  </div>`;
}
// Raccourcis : construit un objet horaires prêt à l'emploi.
function optPresetHours(id) {
  const o = {};
  if (id === '8-18') OPT_WEEKDAYS.forEach((d) => { o[d] = '8h00-18h00'; });
  else if (id === '9-18lunch') OPT_WEEKDAYS.forEach((d) => { o[d] = '9h00-12h30, 14h00-18h00'; });
  else if (id === '8-19sat') OPT_WEEKDAYS.concat('samedi').forEach((d) => { o[d] = '8h00-19h00'; });
  return o; // 'clear' → objet vide (tout fermé)
}
// Re-rend l'éditeur (changement de mode / raccourci) en conservant scope.
function optRerenderHours(scope, hoursObj, perDay) {
  const wrap = scope.querySelector('.opt-hours-edit'); if (!wrap) return;
  const holder = document.createElement('div'); holder.innerHTML = optHoursEditorHTML(hoursObj, perDay);
  wrap.replaceWith(holder.firstElementChild);
  optBindHoursEditor(scope);
}
// Branche bascules ouvert/pause, raccourcis, et le mode jour par jour.
function optBindHoursEditor(scope) {
  scope.querySelectorAll('.opt-grp').forEach((row) => {
    const openChk = row.querySelector('[data-role="open"]'), times = row.querySelector('.opt-times'), closed = row.querySelector('.opt-closed');
    const pauseChk = row.querySelector('[data-role="pause"]'), pauseBox = row.querySelector('.opt-pause');
    if (openChk) openChk.onchange = () => { const on = openChk.checked; if (times) times.hidden = !on; if (closed) closed.hidden = on; };
    if (pauseChk) pauseChk.onchange = () => { if (pauseBox) pauseBox.hidden = !pauseChk.checked; };
  });
  scope.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => optRerenderHours(scope, b.dataset.preset === 'clear' ? {} : optPresetHours(b.dataset.preset), false));
  const pd = scope.querySelector('[data-role="perday"]');
  if (pd) pd.onchange = () => optRerenderHours(scope, optCollectHours(scope), pd.checked);
}
// Reconstruit l'objet horaires depuis les groupes (chaque jour du groupe reçoit
// la même plage). Groupe non coché = fermé (jours absents).
function optCollectHours(scope) {
  const o = {};
  scope.querySelectorAll('.opt-grp').forEach((row) => {
    if (!row.querySelector('[data-role="open"]').checked) return;
    const g = (r) => { const el = row.querySelector(`[data-role="${r}"]`); return el ? el.value : ''; };
    const o1 = g('o1'), c1 = g('c1');
    const str = row.querySelector('[data-role="pause"]').checked ? `${o1}-${g('ps')}, ${g('pe')}-${c1}` : `${o1}-${c1}`;
    String(row.dataset.days || '').split(',').filter(Boolean).forEach((d) => { o[d] = str; });
  });
  return o;
}
// Enregistre l'arrêt courant comme client pro (avec suggestion de nom via OSM).
function optRegisterPro(id) {
  const s = _opt.stops.find((x) => x.id === id); if (!s || typeof modal !== 'function') return;
  modal({
    title: '🏢 Enregistrer un client pro',
    bodyHTML: `<p class="help">${esc(s.label)}</p>
      <label>Nom de l'établissement *</label><input id="pro-name" placeholder="ex. Établissement Passard" value="${esc(s.clientName || s.scanName || '')}">
      <div class="help" id="pro-sugg" style="margin:.25rem 0"></div>
      <label style="margin-top:.5rem">Horaires d'ouverture <span class="help">— un raccourci puis ajustez</span></label>
      ${optHoursEditorHTML(s.hours)}
      <p class="help">Enregistré une fois, ce client sera reconnu automatiquement aux prochaines tournées.</p>`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="pro-save">Enregistrer</button>`,
    onMount: (ov) => {
      optBindHoursEditor(ov);
      api('GET', `/geo/poi?lat=${s.lat}&lon=${s.lon}`).then((r) => {
        if (r && r.name) { const nm = ov.querySelector('#pro-name'), sg = ov.querySelector('#pro-sugg'); if (sg) { sg.innerHTML = `Suggestion : <a href="#" id="pro-us">${esc(r.name)}</a>`; ov.querySelector('#pro-us').onclick = (e) => { e.preventDefault(); nm.value = r.name; }; } if (nm && !nm.value) nm.value = r.name; }
      }).catch(() => {});
      ov.querySelector('#pro-save').onclick = async () => {
        const name = ov.querySelector('#pro-name').value.trim(); if (!name) { toast('Nom requis.', 'err'); return; }
        const horaires = optCollectHours(ov);
        try { const r = await api('POST', '/clients', { name, address: s.label, lat: s.lat, lon: s.lon, horaires }); s.clientId = r.client.id; s.clientName = r.client.name; s.hours = r.client.horaires || ''; optSave(_opt); closeModal(); if (_opt.optimized) optRenderBody(); else optRefreshList(); toast('Client pro enregistré ✓', 'ok'); }
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
// Prépare la photo pour l'OCR : agrandit (max 2200 px), passe en niveaux de
// gris puis étire le contraste (feuilles carbone peu contrastées) → texte net.
function optPrepImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 2200, sc = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * sc), h = Math.round(img.height * sc);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      try {
        const d = ctx.getImageData(0, 0, w, h); const px = d.data;
        // 1) niveaux de gris + histogramme
        let mn = 255, mx = 0; const g = new Float32Array(px.length / 4);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; g[j] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
        // 2) étirement de contraste (min→0, max→255) + légère courbe gamma
        const range = Math.max(1, mx - mn);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
          let v = (g[j] - mn) / range; v = Math.pow(v, 0.8) * 255;
          const o = v < 0 ? 0 : v > 255 ? 255 : v; px[i] = px[i + 1] = px[i + 2] = o;
        }
        ctx.putImageData(d, 0, 0);
      } catch (e) {}
      URL.revokeObjectURL(url); resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}
// Adresse du transporteur / expéditeurs récurrents à ne JAMAIS livrer.
function optIsTransporter(s) { return /tilly sur seulles|inter colis|rue de bayeux|cormelles|fedex|avenue leclerc|erstein|saint priest|st priest/.test(s); }
// Rue reconnue par mot-clé (tolère un préfixe collé par l'OCR : « AROUTE »).
const OPT_STREET_RE = /(RUE|ROUTE|RTE|AVENUE|CHEMIN|IMPASSE|ALLEE|BOULEVARD|PLACE|QUAI|CLOS|COURS|MAIL|SQUARE|LOTISSEMENT|RESIDENCE|ZONE|ZAC|PARC|LIEU|FAUBOURG|SENTIER|PASSAGE|ROND[\s\-]?POINT)[\sA-Za-zÀ-ÿ'.\-]{2,}/i;
// Coupe la partie expéditeur d'un fragment : marqueur (Réf/Pays/Instr/Cedex/BP),
// CP étranger (≠ 14/61) ou long numéro (téléphone/réf). Nettoie la ponctuation.
function optStripSender(s) {
  const segs = String(s || '').split(/[!|¡]/).map((x) => x.trim());
  let out = segs.find((x) => /[A-Za-zÀ-ÿ]{2}/.test(x)) || segs.find((x) => x.length) || '';
  let cut = out.length;
  const mk = out.search(/r[ée]f|pays|instr|cedex|\bbp\b|div\s*:/i); if (mk >= 0) cut = Math.min(cut, mk);
  let m; const re = /\d{5,}/g;
  while ((m = re.exec(out))) { const f = m[0].slice(0, 2); if (f !== '14' && f !== '61') { cut = Math.min(cut, m.index); break; } }
  return out.slice(0, cut).replace(/[^\wÀ-ÿ'\- ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Code postal 14xxx/61xxx tolérant : suivi d'une ville, jamais noyé dans un
// long nombre (téléphone) — on rejette si 2 chiffres le précèdent directement.
function optFindCP(s) {
  const re = /(14|61)\d{3}/g; let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    const next = s.charAt(m.index + 5);
    const after = s.slice(m.index + 5, m.index + 5 + 30); // fenêtre large (padding fixe)
    if (/\d{2}$/.test(before) || /\d/.test(next)) continue; // noyé dans un long nombre (tél/tracking)
    if (!/[A-Za-zÀ-ÿ]{2}/.test(after)) continue;            // doit être suivi d'une ville
    return { cp: m[0], idx: m.index };
  }
  return null;
}
function optStreetFrom(line) { const m = String(line || '').match(OPT_STREET_RE); return m ? optStripSender(m[0]) : ''; }
// Lecture d'une lettre de voiture FedEx (tolérante au bruit OCR). On ne retient
// que le destinataire : rue (mot-clé) + CP 14/61 ville, en écartant l'en-tête,
// le transporteur et les expéditeurs. Renvoie null si ce n'est pas une LV FedEx.
function optParseFedexSheet(text) {
  const raw = String(text || '').split(/\n+/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length);
  const full = optNormLbl(raw.join(' '));
  const isLV = (full.includes('destinataire') && full.includes('expediteur')) || full.includes('lettre de voiture') || full.includes('soumis aux conditions');
  if (!isLV) return null;
  // Coupe l'en-tête jusqu'à la ligne d'entête de colonnes, si trouvée.
  let start = 0;
  for (let i = 0; i < raw.length; i++) { const l = optNormLbl(raw[i]); if (l.includes('destinataire') && l.includes('expediteur')) { start = i + 1; break; } }
  const body = raw.slice(start);
  const found = [];
  // Le nom du destinataire est la 1re ligne juste après « Soumis aux conditions ».
  let blockName = '';
  for (let i = 0; i < body.length; i++) {
    if (optNormLbl(body[i]).includes('soumis aux conditions')) {
      let nm = optStripSender(body[i + 1] || '').replace(/^[^A-Za-zÀ-ÿ]+/, '').trim(); const nnm = optNormLbl(nm);
      if (!nm || OPT_STREET_RE.test(nm) || /\b(14|61)\d{3}\b/.test(nm) || optIsTransporter(nnm) || nnm.length < 3) nm = '';
      blockName = nm; continue;
    }
    const cpm = optFindCP(body[i]); if (!cpm) continue;
    const cityPart = optStripSender(body[i].slice(cpm.idx));
    let street = optStreetFrom(body[i].slice(0, cpm.idx));
    for (let k = i - 1; k >= Math.max(0, i - 3) && !street; k--) street = optStreetFrom(body[k]);
    const cand = ((street ? street + ' ' : '') + cityPart).replace(/\s+/g, ' ').trim();
    if (cand.length < 8 || optIsTransporter(optNormLbl(cand))) continue;
    found.push({ cand, pri: 0, name: blockName });
  }
  return found;
}
// Lecture générique (autres transporteurs / étiquette simple) : lignes avec CP.
function optParseGeneric(text, carrierId) {
  const tpl = optCarrier(carrierId);
  const lines = String(text || '').split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 3);
  const low = lines.map((l) => optNormLbl(l));
  let anchor = -1;
  if (tpl) { for (let i = 0; i < low.length; i++) { if (tpl.anchors.some((a) => low[i].includes(a))) { anchor = i; break; } } }
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b(14|61)\s?\d{3}\b/);
    if (!m) continue;
    const cp = m[0].replace(/\s/g, '');
    const idx = lines[i].indexOf(m[0]);
    const cityPart = (cp + ' ' + lines[i].slice(idx + m[0].length)).replace(/\s+/g, ' ').trim();
    let street = lines[i].slice(0, idx).trim();
    if (!street && i > 0) street = lines[i - 1];
    // Nom du destinataire : ligne au-dessus de la rue qui n'est ni une rue ni un CP.
    let name = '';
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) { const t = lines[k]; if (t && /[a-zA-ZÀ-ÿ]{3}/.test(t) && !OPT_STREET_RE.test(t) && !/\b(14|61)\d{3}\b/.test(t) && !optIsTransporter(optNormLbl(t))) { name = t; break; } }
    const cand = ((street ? street + ' ' : '') + cityPart).replace(/\s+/g, ' ').trim();
    if (cand.length > 6 && !optIsTransporter(optNormLbl(cand))) found.push({ cand, pri: (anchor >= 0 && i > anchor) ? 0 : 1, name });
  }
  return found;
}
// Clé « entreprise » : 1-2 mots significatifs du nom, hors formes juridiques.
// Sert à distinguer deux sociétés d'une même rue et à regrouper les colis
// d'un même client (tolère la variance OCR sur les mots secondaires).
const OPT_LEGAL = new Set(['sas', 'sasu', 'sarl', 'sa', 'eurl', 'sci', 'snc', 'scop', 'ets', 'etablissement', 'etablissements', 'ste', 'societe', 'sté', 'ent', 'entreprise', 'sav', 'service', 'services', 'maintenance', 'div', 'france']);
function optCompanyKey(name) {
  const toks = optNormLbl(name).split(' ')
    .map((t) => t.replace(/[^a-zà-ÿ]/g, '')) // enlève chiffres/bruit collés (ex. « 1sas » → « sas »)
    .filter((t) => t.length > 1 && !OPT_LEGAL.has(t));
  return toks.slice(0, 2).join(' ');
}
// Dédoublonnage : regroupe par ENTREPRISE + code postal (colis multiples d'un
// même client), sinon par adresse. Deux entreprises différentes → 2 entrées.
function optCandKey(x) {
  const ck = optCompanyKey(x.name);
  const cp = (String(x.cand).match(/\b(14|61)\d{3}\b/) || [])[0] || '';
  return ck ? ('n:' + ck + '|' + cp) : ('a:' + optNormLbl(x.cand).replace(/\s+/g, ''));
}
function optDedupCands(found) {
  const map = new Map();
  found.forEach((x) => {
    const key = optCandKey(x);
    const e = map.get(key);
    if (e) { e.count++; if (x.pri < e.pri) e.pri = x.pri; if (!e.name && x.name) e.name = x.name; if (x.name && x.name.length > (e.name || '').length) e.name = x.name; }
    else map.set(key, { cand: x.cand, count: 1, pri: x.pri, name: x.name || '' });
  });
  return Array.from(map.values()).sort((a, b) => a.pri - b.pri);
}
// Extrait les adresses candidates du texte OCR : lettre de voiture FedEx si
// reconnue (colonnes destinataire/expéditeur), sinon lecture générique.
function optParseAddresses(text, carrierId) {
  const fedex = optParseFedexSheet(text);
  return optDedupCands((fedex && fedex.length) ? fedex : optParseGeneric(text, carrierId));
}
async function optScan(fileOrFiles) {
  const files = (fileOrFiles && fileOrFiles.length != null && !(fileOrFiles instanceof File)) ? Array.from(fileOrFiles) : [fileOrFiles];
  const outEl = document.getElementById('opt-scan-out'); if (!outEl || !files.length) return;
  const multi = files.length > 1;
  const merged = new Map(); let fullText = '';
  try {
    const T = await ensureTesseract();
    for (let n = 0; n < files.length; n++) {
      outEl.innerHTML = `<div class="opt-scanning"><div class="spin"></div> Analyse ${multi ? `de la page ${n + 1}/${files.length}` : 'de l’image'}… <span id="opt-scan-pct">0%</span></div>`;
      const canvas = await optPrepImage(files[n]);
      const { data } = await T.recognize(canvas, 'fra', { logger: (m) => { if (m.status === 'recognizing text') { const e = document.getElementById('opt-scan-pct'); if (e) e.textContent = Math.round(m.progress * 100) + '%'; } } });
      const text = (data && data.text) || '';
      fullText += (fullText ? '\n\n— — —\n\n' : '') + text;
      optParseAddresses(text, _opt.carrier).forEach((c) => {
        const key = optCandKey(c); const e = merged.get(key);
        if (e) { e.count += c.count; if (c.name && c.name.length > (e.name || '').length) e.name = c.name; } else merged.set(key, Object.assign({}, c));
      });
    }
    const cands = Array.from(merged.values()).sort((a, b) => a.pri - b.pri);
    outEl.innerHTML = `
      <div class="card" style="margin-top:.6rem;background:#f8fafc">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap"><strong>📷 ${cands.length} adresse(s) détectée(s)${multi ? ` · ${files.length} pages` : ''}</strong>
          ${cands.length ? '<button class="btn accent sm" id="opt-scan-all">Tout ajouter</button>' : ''}
          <button class="btn ghost sm" id="opt-scan-close" style="margin-left:auto">✕</button></div>
        ${cands.length ? cands.map((c, i) => `<div class="opt-cand"><span class="opt-lbl">${c.name ? `<strong>🏢 ${esc(c.name)}</strong><br>` : ''}${esc(c.cand)}${c.count > 1 ? ` <span class="pill warn">📦 plusieurs colis possible (${c.count})</span>` : ''}</span><button class="btn accent sm" data-cand="${i}">Ajouter</button></div>`).join('')
          : '<p class="help">Aucune adresse (CP 14/61) reconnue. Utilisez la saisie manuelle ci-dessus ou reprenez la photo bien cadrée.</p>'}
        <details style="margin-top:.4rem"><summary class="help">Texte lu par l’OCR</summary><pre class="opt-ocrtext">${esc(fullText || '(vide)')}</pre></details>
      </div>`;
    outEl.querySelector('#opt-scan-close').onclick = () => { outEl.innerHTML = ''; };
    const addOne = async (b) => {
      const c = cands[+b.dataset.cand]; if (!c || b.dataset.done) return; b.disabled = true; b.textContent = '…';
      try {
        const r = await optBanSearch(c.cand); const hit = r[0];
        if (!hit) { toast(`Introuvable : ${c.cand}`, 'err'); b.disabled = false; b.textContent = 'Ajouter'; return false; }
        optAddStop(hit.label, hit.lat, hit.lon, c.count, c.name);
        b.textContent = '✓ Ajouté'; b.dataset.done = '1'; optRefreshList(); return true;
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Ajouter'; return false; }
    };
    outEl.querySelectorAll('[data-cand]').forEach((b) => b.onclick = () => addOne(b));
    const allBtn = outEl.querySelector('#opt-scan-all');
    if (allBtn) allBtn.onclick = async () => { allBtn.disabled = true; allBtn.textContent = '…'; for (const b of outEl.querySelectorAll('[data-cand]')) { await addOne(b); } allBtn.textContent = '✓ Terminé'; };
  } catch (e) { outEl.innerHTML = `<div class="alert warn" style="margin-top:.6rem">${esc(e.message)}</div>`; }
}
// Récupère la matrice de durées OSRM (min) si le serveur est configuré.
// Renvoie null si OSRM indisponible → on garde l'estimation haversine.
async function optFetchMatrix(pts) {
  if (pts.length < 2 || pts.length > 100) return null;
  try {
    const coords = pts.map((p) => [p.lon, p.lat]);
    const r = await api('POST', '/geo/route-matrix', { coords });
    if (r && r.enabled && r.ok && Array.isArray(r.durations)) return r.durations.map((row) => row.map((v) => (v == null ? null : v / 60)));
  } catch (e) {}
  return null;
}
// Récupère le tracé routier réel (OSRM) pour l'ordre donné → carte.
async function optFetchGeom(pts) {
  if (pts.length < 2 || pts.length > 100) return null;
  try {
    const coords = pts.map((p) => [p.lon, p.lat]);
    const r = await api('POST', '/geo/route', { coords });
    if (r && r.enabled && r.ok && r.geometry && Array.isArray(r.geometry.coordinates)) return r.geometry.coordinates.map((c) => [c[1], c[0]]);
  } catch (e) {}
  return null;
}
async function optRun(fromNow) {
  const st = _opt; const pending = st.stops.filter((s) => !s.delivered && !s.absent);
  if (!pending.length) { toast('Aucun arrêt à optimiser.', 'err'); return; }
  const o = optRunOpts(fromNow);
  // Matrice OSRM (temps routiers réels) : indices 0 = départ, 1..n = arrêts.
  const pts = [st.start].concat(pending); pts.forEach((p, i) => { p._mi = i; });
  o.matrix = await optFetchMatrix(pts);
  o.travel = optTravelOf(o);
  st._osrm = !!o.matrix;
  let route = optSolveTW(st.start, pending, o);
  if (route.length <= 60) route = optImproveTW(st.start, route, o); // borne anti-lenteur
  // Calcule l'horaire prévisionnel de chaque arrêt (arrivée + ouvert/fermé).
  const { sched, missed } = optScheduleRoute(st.start, route, o);
  const byId = {}; sched.forEach((x) => { byId[x.id] = x; });
  route.forEach((s) => {
    s.skipped = false; const e = byId[s.id] || null;
    s._eta = e ? Math.round(e.serviceStart) : null;
    s._etaOk = e ? e.ok : null;
    s._etaWait = e ? Math.round(e.wait) : 0;
    s._closedToday = e ? !!e.closedToday : false;
    s._etaClose = e && e.closeUsed != null ? Math.round(e.closeUsed) : null;
  });
  const closedList = st.stops.filter((s) => s.delivered || s.absent);
  st.stops = closedList.concat(route);
  st.optimized = true; st.activeId = route[0] ? route[0].id : null;
  st.lastDepartMin = o.departMin;
  // Tracé routier réel (si OSRM) pour la carte ; sinon lignes droites.
  st.routeGeom = o.matrix ? await optFetchGeom([st.start].concat(route)) : null;
  optSave(st); optRenderBody();
  const via = o.matrix ? ' (temps routiers réels)' : '';
  toast(missed
    ? `Tournée optimisée${via} : ${route.length} arrêt(s) · ⚠️ ${missed} hors horaires aujourd'hui.`
    : `Tournée optimisée${via} : ${route.length} arrêt(s), tous dans les horaires ✓`, missed ? 'warn' : 'ok');
}
function optMark(id, kind) {
  const st = _opt; const s = st.stops.find((x) => x.id === id); if (!s) return;
  if (kind === 'delivered') { s.delivered = true; s.absent = false; s.skipped = false; }
  else if (kind === 'absent') { s.absent = true; s.delivered = false; s.skipped = false; }
  else if (kind === 'skip') { s.skipped = true; }
  // Prochain arrêt actif : 1er non passé, sinon 1er restant.
  const order = optOrdered(st);
  const next = order.find((x) => !x.skipped) || order[0] || null;
  st.activeId = next ? next.id : null;
  optSave(st); optRenderBody();
  if ((kind === 'delivered' || kind === 'absent') && window.celebrate && !order.length) celebrate('success', { text: 'Tournée terminée !' });
}
// Pastille horaire du jour (ouvert/fermé) pour un arrêt client pro.
function optHoursBadge(s) {
  const today = optTodayHours(s.hours); if (!today) return '';
  const state = optOpenState(today);
  const cls = state.open === true ? 'ok' : state.open === false ? 'danger' : '';
  return ` · ⏰ ${esc(today)} ${cls ? `<span class="pill ${cls}">${esc(state.txt)}</span>` : ''}`;
}
// "HH:MM" pour un <input type="time">.
function optHhmmInput(min) { const h = Math.floor(min / 60), m = min % 60; return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`; }
// Pastille d'heure d'arrivée prévue (liste d'arrêts optimisée).
function optEtaPill(s) {
  if (s._closedToday) return ` <span class="pill danger">🔒 fermé auj.</span>`;
  if (s._eta == null) return '';
  if (s._etaOk === false) return ` <span class="pill danger">⛔ ~${optHhmm(s._eta)}</span>`;
  const wait = s._etaWait > 1 ? ` +${s._etaWait}′` : '';
  return ` <span class="pill muted">🕒 ~${optHhmm(s._eta)}${wait}</span>`;
}
// Ligne « arrivée estimée » sur la carte de l'arrêt en cours.
function optActiveEtaHTML(s) {
  if (s._closedToday) return `<div class="help">🔒 <span class="pill danger">Fermé aujourd'hui</span> — à reprogrammer.</div>`;
  if (s._eta == null) return '';
  if (s._etaOk === false) return `<div class="help">🕒 Arrivée estimée ~${optHhmm(s._eta)} — <span class="pill danger">hors horaires</span></div>`;
  const close = s._etaClose != null ? ` <span class="help">(ferme à ${optHhmm(s._etaClose)})</span>` : '';
  const wait = s._etaWait > 1 ? ` <span class="pill warn">attente ${s._etaWait} min</span>` : '';
  return `<div class="help">🕒 Arrivée estimée ~${optHhmm(s._eta)}${close}${wait}</div>`;
}
// Panneau de réglages de la tournée (heure de départ, vitesse, temps/arrêt).
function optSettingsHTML() {
  const st = _opt, d = new Date();
  const dep = optHhmmInput(st.departMin != null ? st.departMin : (d.getHours() * 60 + d.getMinutes()));
  const svc = st.serviceMin != null ? st.serviceMin : 2.5;
  return `<details class="opt-settings"><summary>⚙️ Réglages de tournée — heure de départ &amp; horaires</summary>
    <div class="opt-hrow"><span>Départ</span><input type="time" id="opt-depart" value="${dep}"></div>
    <div class="opt-hrow"><span>Par arrêt</span><input type="number" id="opt-service" min="0" max="30" step="0.5" value="${svc}"><span class="help">min sur place (≈ 2,5)</span></div>
    <p class="help">L'optimisation respecte les heures d'ouverture de chaque client pro pour en livrer le plus possible dans la journée, et signale ceux fermés ou hors horaires.</p>
  </details>`;
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
  // Tracé routier réel (OSRM) si disponible, sinon lignes droites en pointillé.
  if (st.routeGeom && st.routeGeom.length > 1) {
    _optLine = L.polyline(st.routeGeom, { color: '#2563eb', weight: 4, opacity: .8 }).addTo(_optMap);
    st.routeGeom.forEach((c) => bounds.push(c));
  } else {
    _optLine = L.polyline(pts.map((p) => [p.lat, p.lon]), { color: '#2563eb', weight: 3, opacity: .7, dashArray: '6 6' }).addTo(_optMap);
  }
  if (bounds.length > 1) _optMap.fitBounds(bounds, { padding: [30, 30] }); else _optMap.setView(bounds[0] || [49.14, -0.42], 12);
  setTimeout(() => { if (_optMap) _optMap.invalidateSize(); }, 200);
}

/* =========================================================================
   ADMIN — Clients professionnels (base + horaires)
   ========================================================================= */
async function renderClientsProAdmin(main) {
  if (typeof isStaff === 'function' && !isStaff()) { main.innerHTML = `<div class="alert warn">Accès réservé à l'encadrement.</div>`; return; }
  main.innerHTML = `<div class="page-head"><div><h1>🏢 Clients professionnels</h1>
    <p>Créez, modifiez ou supprimez les professionnels et leurs horaires — la base sert à l'optimisateur de tournée.</p></div>
    <div style="margin-left:auto"><button class="btn accent" id="cp-new">➕ Nouveau client</button></div></div>
    <div id="cp-body" class="empty">Chargement…</div>`;
  const body = document.getElementById('cp-body');
  const reload = async () => { try { const l = (await api('GET', '/clients')).clients; cpRender(body, l); } catch (e) { body.innerHTML = `<div class="alert warn">${esc(e.message)}</div>`; } };
  const nb = document.getElementById('cp-new'); if (nb) nb.onclick = () => cpCreate(reload);
  await reload();
}
// Sélecteur d'adresse réutilisable (autocomplétion BAN 14/61 → coordonnées).
function cpAddrPickerHTML(current) {
  return `<div class="opt-search"><input id="cp-addr" placeholder="Rechercher l'adresse…" autocomplete="off" value="${esc(current || '')}"><div id="cp-sug" class="opt-sug"></div></div><div class="help" id="cp-geo"></div>`;
}
function cpBindAddrPicker(scope, picked) {
  const inp = scope.querySelector('#cp-addr'), sug = scope.querySelector('#cp-sug'), geo = scope.querySelector('#cp-geo');
  if (!inp) return; let t = null, last = '';
  inp.oninput = () => {
    const q = inp.value.trim(); if (t) clearTimeout(t);
    picked.lat = null; picked.lon = null; if (geo) geo.textContent = '';
    if (q.length < 3) { sug.innerHTML = ''; return; }
    t = setTimeout(async () => {
      if (q === last) return; last = q;
      try {
        const res = await optBanSearch(q);
        sug.innerHTML = res.length ? res.map((r) => `<button class="opt-sug-it" data-lat="${r.lat}" data-lon="${r.lon}" data-lbl="${esc(r.label)}">${esc(r.label)}</button>`).join('') : '<div class="help" style="padding:.4rem">Aucune adresse en 14/61.</div>';
        sug.querySelectorAll('.opt-sug-it').forEach((b) => b.onclick = () => { picked.lat = +b.dataset.lat; picked.lon = +b.dataset.lon; picked.label = b.dataset.lbl; inp.value = b.dataset.lbl; sug.innerHTML = ''; if (geo) geo.innerHTML = `📍 ${picked.lat.toFixed(5)}, ${picked.lon.toFixed(5)} — position enregistrée`; });
      } catch (e) { sug.innerHTML = `<div class="help" style="padding:.4rem">${esc(e.message)}</div>`; }
    }, 280);
  };
}
function cpCreate(reload) {
  const picked = { lat: null, lon: null, label: '' };
  modal({
    title: '➕ Nouveau client pro',
    bodyHTML: `<label>Nom de l'établissement *</label><input id="cp-name" placeholder="ex. Établissement Passard">
      <label style="margin-top:.5rem">Adresse * <span class="help">(Calvados 14 / Orne 61)</span></label>${cpAddrPickerHTML('')}
      <label style="margin-top:.5rem">Horaires d'ouverture <span class="help">— un raccourci puis ajustez</span></label>${optHoursEditorHTML({})}`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="cp-create">Créer</button>`,
    onMount: (ov) => {
      cpBindAddrPicker(ov, picked); optBindHoursEditor(ov);
      ov.querySelector('#cp-create').onclick = async () => {
        const name = ov.querySelector('#cp-name').value.trim(); if (!name) { toast('Nom requis.', 'err'); return; }
        if (picked.lat == null) { toast('Choisissez une adresse dans la liste des suggestions.', 'err'); return; }
        try { await api('POST', '/clients', { name, address: picked.label, lat: picked.lat, lon: picked.lon, horaires: optCollectHours(ov) }); closeModal(); reload(); toast('Client créé ✓', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
function cpRender(body, list) {
  body.className = '';
  if (!list.length) { body.innerHTML = `<div class="alert info">Aucun client pro enregistré. Cliquez sur <strong>➕ Nouveau client</strong> ci-dessus, ou ajoutez-les depuis l'optimisateur de tournée (bouton 🏢 sur un arrêt).</div>`; return; }
  body.innerHTML = `<div class="card"><input id="cp-search" placeholder="Rechercher un client…" style="width:100%"><span class="help">${list.length} client(s)</span></div><div id="cp-list">${list.map(cpRow).join('')}</div>`;
  const doList = (q) => { const f = q ? list.filter((c) => normNm(c.name + ' ' + (c.address || '')).includes(normNm(q))) : list; document.getElementById('cp-list').innerHTML = f.length ? f.map(cpRow).join('') : '<p class="help">Aucun résultat.</p>'; cpBind(body, list); };
  const se = document.getElementById('cp-search'); if (se) se.oninput = (e) => doList(e.target.value.trim());
  cpBind(body, list);
}
function cpRow(c) {
  const hrs = optHoursText(c.horaires) || (typeof c.horaires === 'string' && c.horaires ? esc(c.horaires) : '<span class="help">horaires non renseignés</span>');
  return `<div class="card cp-card"><div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
    <strong>🏢 ${esc(c.name)}</strong>
    <span style="margin-left:auto;display:flex;gap:.4rem"><button class="btn ghost sm" data-cpedit="${c.id}">✏️ Modifier</button><button class="btn danger sm" data-cpdel="${c.id}">🗑</button></span></div>
    <div class="help">${esc(c.address || '')}</div>
    <div style="margin-top:.2rem">⏰ ${hrs}${c.horairesSource ? ` <span class="help">(${esc(c.horairesSource)}${c.horairesMajLe ? ', ' + esc(c.horairesMajLe) : ''})</span>` : ''}</div>
  </div>`;
}
function cpBind(body, list) {
  const reload = async () => { try { const l = (await api('GET', '/clients')).clients; cpRender(document.getElementById('cp-body'), l); } catch (e) {} };
  body.querySelectorAll('[data-cpdel]').forEach((b) => b.onclick = async () => { if (!confirm('Supprimer ce client pro ?')) return; try { await api('DELETE', '/clients/' + b.dataset.cpdel); reload(); } catch (e) { toast(e.message, 'err'); } });
  body.querySelectorAll('[data-cpedit]').forEach((b) => b.onclick = () => { const c = list.find((x) => x.id === b.dataset.cpedit); if (c) cpEdit(c, reload); });
}
function cpEdit(c, reload) {
  const picked = { lat: null, lon: null, label: '' };
  modal({
    title: '✏️ Client professionnel',
    bodyHTML: `<label>Nom *</label><input id="cp-name" value="${esc(c.name)}">
      <label style="margin-top:.5rem">Adresse <span class="help">(choisir une suggestion pour repositionner si le pro a déménagé)</span></label>${cpAddrPickerHTML(c.address || '')}
      <label style="margin-top:.5rem">Horaires d'ouverture <span class="help">— un raccourci puis ajustez</span></label>${optHoursEditorHTML(c.horaires)}`,
    footHTML: `<button class="btn ghost" data-close>Annuler</button><button class="btn accent" id="cp-save">Enregistrer</button>`,
    onMount: (ov) => {
      cpBindAddrPicker(ov, picked); optBindHoursEditor(ov);
      ov.querySelector('#cp-save').onclick = async () => {
        const name = ov.querySelector('#cp-name').value.trim(); if (!name) { toast('Nom requis.', 'err'); return; }
        const payload = { name, address: (picked.label || ov.querySelector('#cp-addr').value.trim()), horaires: optCollectHours(ov) };
        if (picked.lat != null) { payload.lat = picked.lat; payload.lon = picked.lon; } // déménagement → nouvelles coordonnées
        try { await api('PUT', '/clients/' + c.id, payload); closeModal(); reload(); toast('Enregistré.', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}
