'use strict';

/**
 * Client API PAJ GPS (https://connect.paj-gps.de/api/v1/) + suivi temps réel.
 *
 * Fonctions :
 *  - authentification (login -> jeton Bearer, mis en cache ~4 min) ;
 *  - liste des traceurs (device) et dernières positions (getalllastpositions) ;
 *  - chiffrement AES-256-GCM du mot de passe PAJ stocké en base ;
 *  - suivi de l'état de chaque véhicule : en mouvement / à l'arrêt, heure du
 *    dernier arrêt, trace de déplacement du jour ;
 *  - comptage des excès de vitesse de la journée (fenêtre 05h–18h, seuil
 *    paramétrable, 115 km/h par défaut) ;
 *  - géocodage inverse (adresse) via OpenStreetMap/Nominatim, avec cache.
 *
 * Aucune dépendance externe : fetch global (Node ≥ 18).
 */

const crypto = require('crypto');

const API_URL = 'https://connect.paj-gps.de/api/v1/';
const ENC_PREFIX = 'PAJENC1:';
const TOKEN_TTL = 4 * 60 * 1000;   // durée de vie du jeton en cache
const POLL_THROTTLE = 20 * 1000;   // ne pas réinterroger PAJ plus d'une fois / 20 s
const MOVING_KMH = 3;              // au-dessus : véhicule considéré en mouvement
const YELLOW_MAX_MIN = 10;         // arrêt « récent » (jaune) en dessous de N minutes
const TRAIL_MAX = 300;             // points de trace conservés par véhicule (jour)

/* ------------------------------------------------------------------ */
/* Chiffrement du mot de passe PAJ (clé dérivée d'un secret d'env.)     */
/* ------------------------------------------------------------------ */
function encKey() {
  const pass = process.env.PAJ_SECRET_KEY || process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'ics-paj-gps-fallback-key';
  return crypto.createHash('sha256').update(String(pass)).digest();
}
function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}
function decrypt(blob) {
  if (!isEnc(blob)) return '';
  try {
    const raw = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) { return ''; }
}
function isEnc(s) { return typeof s === 'string' && s.startsWith(ENC_PREFIX); }

/* ------------------------------------------------------------------ */
/* Appels HTTP                                                          */
/* ------------------------------------------------------------------ */
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

async function http(method, path, { token, query, body } = {}) {
  let url = API_URL + path;
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  opts.signal = ctrl.signal;
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* réponse non-JSON */ }
    if (!res.ok) {
      const err = new Error('PAJ : ' + errMsg(json, res.status, text)); err.status = res.status; throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('PAJ : délai de connexion dépassé.');
    throw e;
  } finally { clearTimeout(timer); }
}

// Extrait un message d'erreur LISIBLE d'une réponse PAJ, qui peut renvoyer une
// chaîne, un objet { error/message } ou des erreurs de validation { champ: [..] }.
function errMsg(json, status, rawText) {
  const cand = json && (json.error != null ? json.error : (json.message != null ? json.message : (json.msg != null ? json.msg : json.errors)));
  if (typeof cand === 'string' && cand.trim()) return cand;
  if (cand && typeof cand === 'object') {
    try {
      const parts = [];
      for (const k of Object.keys(cand)) {
        const v = cand[k];
        parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : (typeof v === 'string' ? v : JSON.stringify(v))}`);
      }
      if (parts.length) return parts.join(' ; ');
    } catch (e) { /* repli ci-dessous */ }
    try { return JSON.stringify(cand); } catch (e) { /* repli ci-dessous */ }
  }
  if (status === 401 || status === 403) return 'identifiants refusés (email ou mot de passe incorrect).';
  if (status === 422) return 'données de connexion invalides (vérifiez l\'email et le mot de passe).';
  const snippet = (rawText || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 120);
  return snippet || ('HTTP ' + status);
}

// Le format de réponse PAJ enveloppe souvent les données dans { success: [...] }.
function payload(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.success)) return json.success;
  if (Array.isArray(json.data)) return json.data;
  return [];
}

/* ------------------------------------------------------------------ */
/* Authentification (jeton en cache module)                             */
/* ------------------------------------------------------------------ */
let _token = null, _tokenAt = 0, _tokenFor = '';

async function login(email, password) {
  const cacheKey = String(email) + '|' + (password ? password.length : 0);
  if (_token && _tokenFor === cacheKey && (Date.now() - _tokenAt) < TOKEN_TTL) return _token;
  const json = await http('POST', 'login', { query: { email, password } });
  let tk = null;
  if (json) {
    if (json.success && json.success.token) tk = json.success.token;
    else if (json.token) tk = json.token;
    else if (typeof json.success === 'string') tk = json.success;
    else if (json.userID && json.routeIcon !== undefined && json.success) tk = json.success.token;
  }
  if (!tk) throw new Error('PAJ : identifiants invalides ou réponse inattendue.');
  _token = tk; _tokenAt = Date.now(); _tokenFor = cacheKey;
  return tk;
}
function resetToken() { _token = null; _tokenAt = 0; _tokenFor = ''; }

async function getDevices(token) {
  const json = await http('GET', 'device', { token });
  return payload(json).map((d) => ({
    id: d.id,
    name: d.name || ('Traceur ' + d.id),
    imei: d.imei || '',
    model: (d.device_models && d.device_models[0] && d.device_models[0].model) || '',
  }));
}

async function getPositions(token, deviceIds) {
  if (!deviceIds.length) return [];
  const json = await http('POST', 'trackerdata/getalllastpositions', {
    token, body: { deviceIDs: deviceIds, fromLastPoint: false },
  });
  return payload(json).map((p) => ({
    deviceId: p.iddevice != null ? p.iddevice : (p.deviceId != null ? p.deviceId : p.id),
    lat: num(p.lat), lng: num(p.lng),
    speed: num(p.speed) || 0,
    direction: num(p.direction),
    battery: p.battery_level != null ? num(p.battery_level) : (p.battery != null ? num(p.battery) : null),
    ts: pickTs(p),
  }));
}
function pickTs(p) {
  const u = p.dateunix || p.timestamp || p.lastmessage || p.gps_time || p.time;
  if (u) { const n = Number(u); if (Number.isFinite(n)) return new Date(n > 1e12 ? n : n * 1000).toISOString(); }
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* Heure de Paris (fenêtre journalière + reset quotidien)               */
/* ------------------------------------------------------------------ */
function parisParts(d) {
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const o = {};
  for (const part of fmt.formatToParts(d)) o[part.type] = part.value;
  return { ymd: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}
function hmToMin(s, dflt) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
}
function dayWindow(cfg) {
  return { start: hmToMin(cfg.dayStart, 5 * 60), end: hmToMin(cfg.dayEnd, 18 * 60) };
}

/* ------------------------------------------------------------------ */
/* État de suivi (persisté dans data.pajState)                          */
/* ------------------------------------------------------------------ */
function ensureState(data) {
  if (!data.pajState || typeof data.pajState !== 'object') data.pajState = { day: '', devices: {}, _lastPollTs: 0, _lastError: '' };
  if (!data.pajState.devices) data.pajState.devices = {};
  if (!Array.isArray(data.pajState.speedLog)) data.pajState.speedLog = []; // historique des excès (3 mois glissants)
  return data.pajState;
}
const SPEEDLOG_DAYS = 95; // conservation de l'historique des excès (~3 mois)
const DEFAULT_FUEL_PRICE = 1.75; // €/L gazole (paramétrable)

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// Consommation théorique (L/100 km) d'un VL ≤ 3,5 t en fonction de la vitesse.
// Modèle C(v) = C0 + k·v² (la traînée aérodynamique domine à haute vitesse) ;
// calibré ≈ 8 L/100 à 90 km/h et ≈ 11 L/100 à 130 km/h. Estimation indicative.
const FUEL_C0 = 5.24, FUEL_K = 0.0003409;
function consoLper100(v) { return FUEL_C0 + FUEL_K * v * v; }

function blankDevice() {
  return {
    name: '', imei: '', model: '',
    lat: null, lng: null, speed: 0, direction: null, battery: null, ts: null,
    moving: false, lastMovingAt: null, stoppedSince: null, finalStopAt: null,
    overspeed: { count: 0, times: [] }, wasOver: false, roadLimit: null, ep: null,
    trail: [], addr: '', addrKey: '',
  };
}
function rollDay(st, now) {
  const today = parisParts(now).ymd;
  if (st.day !== today) {
    st.day = today;
    for (const id of Object.keys(st.devices)) {
      const d = st.devices[id];
      if (d.ep) finalizeEpisode(st, id, d); // clôt un épisode d'excès en cours
      d.overspeed = { count: 0, times: [] };
      d.wasOver = false;
      d.finalStopAt = null;
      d.trail = [];
    }
  }
}

// Clôt un épisode d'excès et l'enregistre dans l'historique (avec sur-conso).
function finalizeEpisode(st, id, cur) {
  const ep = cur.ep; if (!ep) return;
  st.speedLog.push({
    deviceId: id, name: cur.name, at: ep.start,
    recorded: Math.round(ep.maxSpeed), limit: Math.round(ep.limit), roadLimit: ep.roadLimit || null,
    liters: round2(ep.liters), euros: round2(ep.euros), distKm: round2(ep.distKm),
  });
  pruneSpeedLog(st);
  cur.ep = null;
}

function updateDevice(st, dev, p, now, fixedLimit, win, extra) {
  extra = extra || {};
  const id = String(dev.id);
  const cur = st.devices[id] || (st.devices[id] = blankDevice());
  const prevTs = cur.ts;
  cur.name = dev.name; cur.imei = dev.imei; cur.model = dev.model;
  if (p.lat != null) cur.lat = p.lat;
  if (p.lng != null) cur.lng = p.lng;
  cur.speed = p.speed; cur.direction = p.direction; cur.battery = p.battery;
  cur.ts = p.ts || now.toISOString();

  const moving = (p.speed || 0) > MOVING_KMH;
  if (moving) {
    cur.moving = true; cur.lastMovingAt = cur.ts; cur.stoppedSince = null; cur.finalStopAt = null;
  } else {
    if (cur.moving || !cur.stoppedSince) cur.stoppedSince = cur.ts; // transition vers l'arrêt
    cur.moving = false;
    cur.finalStopAt = cur.stoppedSince; // heure du dernier arrêt du jour
  }

  // Trace de déplacement (positions distinctes du jour).
  if (p.lat != null && p.lng != null) {
    const last = cur.trail[cur.trail.length - 1];
    if (!last || last.lat !== p.lat || last.lng !== p.lng) {
      cur.trail.push({ lat: p.lat, lng: p.lng, ts: cur.ts, speed: p.speed });
      if (cur.trail.length > TRAIL_MAX) cur.trail.shift();
    }
  }

  // ---- Excès de vitesse + sur-consommation -----------------------------
  // Limite applicable = limite légale de la route (si connue via OSM), sinon
  // le seuil fixe paramétré. Un excès est un épisode (montée au-dessus de la
  // limite jusqu'au retour en dessous) ; la sur-conso est cumulée sur l'épisode.
  const roadLimit = extra.roadLimit && extra.roadLimit > 0 ? extra.roadLimit : null;
  if (roadLimit) cur.roadLimit = roadLimit; else if (!moving) cur.roadLimit = cur.roadLimit;
  const appLimit = roadLimit || fixedLimit;
  const fuelPrice = extra.fuelPrice || DEFAULT_FUEL_PRICE;
  const pp = parisParts(new Date(cur.ts));
  const mins = pp.hour * 60 + pp.minute;
  const inWindow = mins >= win.start && mins <= win.end;
  const speed = p.speed || 0;
  const over = inWindow && speed > appLimit;

  // Durée écoulée depuis le dernier échantillon (pour estimer la distance).
  let dt = 60;
  if (prevTs) { const d = (new Date(cur.ts) - new Date(prevTs)) / 1000; if (d > 0) dt = Math.min(300, Math.max(5, d)); }

  if (over) {
    if (!cur.ep) {
      cur.ep = { start: cur.ts, maxSpeed: speed, limit: appLimit, roadLimit, liters: 0, euros: 0, distKm: 0 };
      cur.overspeed.count += 1;
      cur.overspeed.times.push({ at: cur.ts, speed: Math.round(speed), limit: Math.round(appLimit), road: !!roadLimit });
      if (cur.overspeed.times.length > 50) cur.overspeed.times.shift();
    }
    const segKm = speed / 3600 * dt;
    const dl = Math.max(0, consoLper100(speed) - consoLper100(appLimit)) * segKm / 100;
    cur.ep.distKm += segKm; cur.ep.liters += dl; cur.ep.euros += dl * fuelPrice;
    if (speed > cur.ep.maxSpeed) cur.ep.maxSpeed = speed;
    if (roadLimit && roadLimit < cur.ep.limit) { cur.ep.limit = roadLimit; cur.ep.roadLimit = roadLimit; }
  } else if (cur.ep) {
    finalizeEpisode(st, id, cur);
  }
  cur.wasOver = over;
}

/* ------------------------------------------------------------------ */
/* Limite de vitesse de la route (OpenStreetMap / Overpass), avec cache */
/* ------------------------------------------------------------------ */
const _roadCache = new Map(); // "lat,lng" arrondi -> { limit }
let _overpassNext = 0;

function parseMaxspeed(s) {
  if (!s) return null;
  if (/walk/i.test(s)) return 6;
  const m = /(\d{2,3})/.exec(String(s));
  if (!m) return null;
  let v = Number(m[1]);
  if (/mph/i.test(s)) v = Math.round(v * 1.60934);
  return v > 0 ? v : null;
}

async function roadLimitAt(lat, lng) {
  if (lat == null || lng == null) return null;
  const key = lat.toFixed(3) + ',' + lng.toFixed(3); // ~110 m
  const hit = _roadCache.get(key);
  if (hit) return hit.limit;
  const now = Date.now();
  if (now < _overpassNext) return null; // limiteur de débit Overpass — réessai plus tard
  _overpassNext = now + 1200;
  try {
    const q = `[out:json][timeout:6];way(around:25,${lat},${lng})[highway][maxspeed];out tags 1;`;
    const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { headers: { 'User-Agent': 'InterColisServices-GPS/1.0' }, signal: ctrl.signal });
    clearTimeout(timer);
    const j = await res.json();
    let limit = null;
    if (j && Array.isArray(j.elements)) {
      for (const el of j.elements) { const m = parseMaxspeed(el.tags && el.tags.maxspeed); if (m) { limit = m; break; } }
    }
    _roadCache.set(key, { limit });
    return limit;
  } catch (e) { return null; }
}

function pruneSpeedLog(st) {
  const cutoff = new Date(Date.now() - SPEEDLOG_DAYS * 86400000).toISOString();
  if (st.speedLog.length > 5000 || (st.speedLog[0] && st.speedLog[0].at < cutoff)) {
    st.speedLog = st.speedLog.filter((e) => e.at >= cutoff);
  }
}

function classify(d) {
  if (d.moving) return 'green';
  if (!d.stoppedSince) return 'yellow';
  const mins = (Date.now() - new Date(d.stoppedSince).getTime()) / 60000;
  return mins <= YELLOW_MAX_MIN ? 'yellow' : 'orange';
}

// Tente de relier un traceur à un véhicule de la flotte par plaque/nom.
function normPlate(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function matchVehicle(data, dev) {
  const name = normPlate(dev.name);
  if (!name) return null;
  for (const v of (data.vehicles || [])) {
    const plate = normPlate(v.plate);
    if (plate && (name.includes(plate) || plate.includes(name))) return v;
    const vn = normPlate(v.name);
    if (vn && name.includes(vn)) return v;
  }
  return null;
}

// Distance en mètres entre deux points GPS (formule de haversine).
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function liveList(data) {
  const st = ensureState(data);
  const cfg = data.settings.pajgps || {};
  const map = cfg.deviceMap || {};
  const depot = { lat: cfg.depotLat, lng: cfg.depotLng, r: Number(cfg.depotRadius) || 300 };
  const vehById = {}; (data.vehicles || []).forEach((v) => { vehById[v.id] = v; });
  const out = [];
  for (const id of Object.keys(st.devices)) {
    const d = st.devices[id];
    const veh = map[id] ? vehById[map[id]] : matchVehicle(data, d);
    const atDepot = (depot.lat != null && depot.lng != null && d.lat != null && d.lng != null)
      ? haversineM(d.lat, d.lng, depot.lat, depot.lng) <= depot.r : false;
    out.push({
      deviceId: id, name: d.name, imei: d.imei, model: d.model,
      lat: d.lat, lng: d.lng, speed: d.speed, direction: d.direction, battery: d.battery, ts: d.ts,
      moving: d.moving, stoppedSince: d.stoppedSince, finalStopAt: d.finalStopAt, atDepot,
      status: classify(d), overspeed: d.overspeed, trail: d.trail, address: d.addr || '',
      vehicleId: veh ? veh.id : null, vehicleName: veh ? veh.name : null, plate: veh ? veh.plate : null,
    });
  }
  // Mouvement d'abord, puis par nom.
  out.sort((a, b) => (a.status === b.status ? 0 : a.status === 'green' ? -1 : b.status === 'green' ? 1 : 0)
    || String(a.vehicleName || a.name).localeCompare(String(b.vehicleName || b.name)));
  return out;
}

// Lundi (YYYY-MM-DD) de la semaine contenant la date ymd donnée.
function mondayOf(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lundi
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function frDay(ymd) { const p = ymd.split('-'); return `${p[2]}/${p[1]}`; }

/**
 * Récapitulatif des excès de vitesse semaine par semaine sur N semaines
 * glissantes (~3 mois par défaut). Regroupe l'historique persistant par
 * semaine ISO (lundi→dimanche, heure de Paris).
 */
function weeklySpeedRecap(data, weeks = 13) {
  const st = ensureState(data);
  const cfg = data.settings.pajgps || {};
  const map = cfg.deviceMap || {};
  const vehById = {}; (data.vehicles || []).forEach((v) => { vehById[v.id] = v; });
  const labelFor = (e) => {
    const veh = map[e.deviceId] ? vehById[map[e.deviceId]] : matchVehicle(data, { name: e.name });
    return veh ? (veh.name || veh.plate) : (e.name || ('Traceur ' + e.deviceId));
  };
  // Construit la liste des N lundis (du plus récent au plus ancien).
  const todayMonday = mondayOf(parisParts(new Date()).ymd);
  const buckets = [];
  const byKey = {};
  for (let i = 0; i < weeks; i++) {
    const d = new Date(todayMonday + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i * 7);
    const start = d.toISOString().slice(0, 10);
    const end = new Date(d); end.setUTCDate(end.getUTCDate() + 6);
    const b = { weekStart: start, label: `${frDay(start)} – ${frDay(end.toISOString().slice(0, 10))}`, total: 0, liters: 0, euros: 0, vehicles: {} };
    buckets.push(b); byKey[start] = b;
  }
  const oldest = buckets[buckets.length - 1].weekStart;
  for (const e of st.speedLog) {
    const ymd = parisParts(new Date(e.at)).ymd;
    const wk = mondayOf(ymd);
    if (wk < oldest) continue;
    const b = byKey[wk]; if (!b) continue;
    b.total += 1;
    b.liters += e.liters || 0;
    b.euros += e.euros || 0;
    const label = labelFor(e);
    const v = b.vehicles[label] || (b.vehicles[label] = { label, count: 0, liters: 0, euros: 0, maxRecorded: 0, limit: e.limit || null, roadKnown: false });
    v.count += 1; v.liters += e.liters || 0; v.euros += e.euros || 0;
    if ((e.recorded || 0) > v.maxRecorded) { v.maxRecorded = e.recorded || 0; v.limit = e.limit || v.limit; }
    if (e.roadLimit) v.roadKnown = true;
  }
  return buckets.map((b) => ({
    weekStart: b.weekStart, label: b.label, total: b.total,
    liters: round2(b.liters), euros: round2(b.euros),
    vehicles: Object.values(b.vehicles).map((v) => ({
      label: v.label, count: v.count, liters: round2(v.liters), euros: round2(v.euros),
      maxRecorded: v.maxRecorded, limit: v.limit, roadKnown: v.roadKnown,
    })).sort((a, z) => z.count - a.count),
  }));
}

/**
 * Interroge PAJ (si nécessaire) et met à jour l'état de suivi.
 * Retourne { polled, list, error }.
 */
async function refreshAndTrack(data, opts = {}) {
  const cfg = data.settings.pajgps || {};
  const st = ensureState(data);
  if (!cfg.enabled) return { polled: false, list: [], error: 'Géolocalisation non activée.' };
  const email = cfg.email;
  const password = decrypt(cfg.passwordEnc);
  if (!email || !password) return { polled: false, list: liveList(data), error: 'Identifiants PAJ manquants.' };

  if (!opts.force && st._lastPollTs && (Date.now() - st._lastPollTs) < POLL_THROTTLE) {
    return { polled: false, list: liveList(data), error: st._lastError || '' };
  }
  const now = new Date();
  try {
    const token = await login(email, password);
    const devices = await getDevices(token);
    const ids = devices.map((d) => d.id);
    const positions = await getPositions(token, ids);
    const posById = {};
    positions.forEach((p, i) => {
      const key = p.deviceId != null ? p.deviceId : ids[i];
      if (key != null) posById[String(key)] = p;
    });
    rollDay(st, now);
    const limit = Number(cfg.speedLimit) || 115;
    const fuelPrice = Number(cfg.fuelPrice) || DEFAULT_FUEL_PRICE;
    const win = dayWindow(cfg);
    for (const dev of devices) {
      const p = posById[String(dev.id)];
      if (!p) continue;
      // Limite légale de la route (best-effort, cachée + débit limité) pour les
      // véhicules en mouvement — sert à détecter les excès et la sur-consommation.
      let roadLimit = null;
      if (cfg.roadSpeedLookup !== false && p.lat != null && (p.speed || 0) > MOVING_KMH) {
        try { roadLimit = await roadLimitAt(p.lat, p.lng); } catch (e) { /* best-effort */ }
      }
      updateDevice(st, dev, p, now, limit, win, { roadLimit, fuelPrice });
    }
    st._lastPollTs = Date.now();
    st._lastError = '';
    return { polled: true, list: liveList(data), error: '' };
  } catch (e) {
    resetToken();
    st._lastError = e.message;
    return { polled: false, list: liveList(data), error: e.message };
  }
}

// Vérifie des identifiants et renvoie la liste des traceurs (pour le mapping).
async function testConnection(email, password) {
  resetToken();
  const token = await login(email, password);
  const devices = await getDevices(token);
  return devices;
}

/* ------------------------------------------------------------------ */
/* Géocodage inverse (adresse) — OpenStreetMap / Nominatim, avec cache  */
/* ------------------------------------------------------------------ */
const _geoCache = new Map(); // "lat,lng" arrondi -> { addr, at }

function shortenAddr(j) {
  const a = j && j.address;
  if (!a) return '';
  const line = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.postcode && a.city ? `${a.postcode} ${a.city}` : (a.city || a.town || a.village || a.municipality || ''),
  ].filter(Boolean).join(', ');
  return line || j.display_name || '';
}

async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return '';
  const key = lat.toFixed(4) + ',' + lng.toFixed(4);
  const hit = _geoCache.get(key);
  if (hit) return hit.addr;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'InterColisServices-GPS/1.0', 'Accept-Language': 'fr' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await res.json();
    const addr = shortenAddr(j);
    _geoCache.set(key, { addr, at: Date.now() });
    return addr;
  } catch (e) { return ''; }
}

// Renseigne l'adresse de chaque véhicule (cache dans l'état pour limiter les appels).
async function attachAddresses(data, list) {
  const st = ensureState(data);
  for (const item of list) {
    if (item.lat == null || item.lng == null) continue;
    const k = item.lat.toFixed(4) + ',' + item.lng.toFixed(4);
    const dev = st.devices[item.deviceId];
    if (dev && dev.addrKey === k && dev.addr) { item.address = dev.addr; continue; }
    const addr = await reverseGeocode(item.lat, item.lng);
    if (addr) { item.address = addr; if (dev) { dev.addr = addr; dev.addrKey = k; } }
  }
  return list;
}

module.exports = {
  encrypt, decrypt, isEnc, ensureState, liveList, weeklySpeedRecap,
  refreshAndTrack, testConnection, attachAddresses, reverseGeocode,
  login, getDevices, classify, resetToken,
};
