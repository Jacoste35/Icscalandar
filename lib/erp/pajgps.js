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
    odo: pickOdo(p),
    ts: pickTs(p),
  }));
}
// Odomètre/kilométrage remonté par le traceur (selon le modèle PAJ : OBD ou
// boîtier avec relevé de distance). On teste les champs connus ; renvoie un
// kilométrage en KM (les valeurs > 1e6 sont supposées en mètres → /1000).
function pickOdo(p) {
  const cand = p.mileage != null ? p.mileage
    : p.odometer != null ? p.odometer
    : p.total_distance != null ? p.total_distance
    : p.totalDistance != null ? p.totalDistance
    : p.distance != null ? p.distance
    : null;
  const n = num(cand);
  if (n == null || n <= 0) return null;
  return n > 1e6 ? n / 1000 : n; // m → km si très grand
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
  if (!data.pajState.dayStats || typeof data.pajState.dayStats !== 'object') data.pajState.dayStats = {}; // km/conso journaliers par traceur
  return data.pajState;
}
const SPEEDLOG_DAYS = 95; // conservation de l'historique des excès (~3 mois)
const DEFAULT_FUEL_PRICE = 1.75; // €/L gazole (paramétrable)

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// Consommation théorique (L/100 km) — calibrée sur Mercedes Sprinter W907
// 314 CDI (2,0 L 143 ch, ~3,5 t, 2022). Référence constructeur (WLTP combiné)
// ≈ 9,5 L/100 km ; en ville (arrêts/redémarrages, charge) ≈ 12,5 L/100 km.
// Modèle route : C(v) = consoRoad90 + k·(v² − 90²) (traînée dominante).
// consoRoad90 et consoUrban sont paramétrables pour coller aux relevés réels.
const FUEL_K = 0.0005114;
const REF_V = 90;
const SPRINTER_ROAD90 = 9.5;  // L/100 km à 90 km/h (réf. constructeur)
const SPRINTER_URBAN = 12.5;  // L/100 km en conduite urbaine
function consoModel(v, road90) { return (road90 || SPRINTER_ROAD90) + FUEL_K * (v * v - REF_V * REF_V); }

function blankDevice() {
  return {
    name: '', imei: '', model: '',
    lat: null, lng: null, speed: 0, direction: null, battery: null, ts: null,
    moving: false, lastMovingAt: null, stoppedSince: null, finalStopAt: null, dayFirstMoveAt: null,
    overspeed: { count: 0, times: [] }, wasOver: false, roadLimit: null, ep: null,
    trail: [], addr: '', addrKey: '',
    odoReal: null, odoRealAt: null, odoEst: 0,
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
      d.dayFirstMoveAt = null;
      d.trail = [];
    }
    pruneDayStats(st, now);
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
  // Odomètre réel remonté par le traceur (si le modèle le fournit).
  if (p.odo != null && p.odo > 0) {
    // garde-fou : ignore les reculs et les sauts aberrants (> 5000 km d'un coup)
    if (cur.odoReal == null || (p.odo >= cur.odoReal && p.odo - cur.odoReal < 5000)) {
      cur.odoReal = p.odo; cur.odoRealAt = cur.ts;
    }
  }

  const moving = (p.speed || 0) > MOVING_KMH;
  if (moving) {
    cur.moving = true; cur.lastMovingAt = cur.ts; cur.stoppedSince = null; cur.finalStopAt = null;
    if (!cur.dayFirstMoveAt) cur.dayFirstMoveAt = cur.ts; // 1re mise en mouvement du jour
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
    const road90 = extra.consoRoad90 || SPRINTER_ROAD90;
    const dl = Math.max(0, consoModel(speed, road90) - consoModel(appLimit, road90)) * segKm / 100;
    cur.ep.distKm += segKm; cur.ep.liters += dl; cur.ep.euros += dl * fuelPrice;
    if (speed > cur.ep.maxSpeed) cur.ep.maxSpeed = speed;
    if (roadLimit && roadLimit < cur.ep.limit) { cur.ep.limit = roadLimit; cur.ep.roadLimit = roadLimit; }
  } else if (cur.ep) {
    finalizeEpisode(st, id, cur);
  }
  cur.wasOver = over;

  // ---- Kilométrage & consommation moyenne (réaliste ville/route) -------
  // Distance estimée par la vitesse (robuste au bruit GPS). Conso réelle vs
  // conso « idéale » (mêmes trajets conduits dans les limites) -> gaspillage.
  if (moving && speed > MOVING_KMH) {
    const segKm = speed / 3600 * dt;
    cur.odoEst = (cur.odoEst || 0) + segKm; // distance GPS cumulée (estimation continue)
    const road90 = extra.consoRoad90 || SPRINTER_ROAD90;
    const urbanC = extra.consoUrban || SPRINTER_URBAN;
    const urban = roadLimit ? roadLimit <= URBAN_LIMIT_KMH : speed < URBAN_SPEED_KMH;
    const cActual = urban ? urbanC : consoModel(speed, road90);
    const idealSpeed = appLimit ? Math.min(speed, appLimit) : speed;
    const cIdeal = urban ? urbanC : consoModel(idealSpeed, road90);
    addDayStat(st, id, pp.ymd, {
      km: segKm, urbanKm: urban ? segKm : 0,
      fuel: cActual * segKm / 100, idealFuel: cIdeal * segKm / 100,
    });
  }
}

// Constantes de réalisme de consommation.
const URBAN_LIMIT_KMH = 50;   // route urbaine si limite ≤ 50 km/h
const URBAN_SPEED_KMH = 30;   // sinon, vitesse faible = conduite urbaine
const DAYSTATS_DAYS = 100;    // conservation des stats journalières

function addDayStat(st, id, ymd, f) {
  if (!st.dayStats) st.dayStats = {};
  const d = st.dayStats[id] || (st.dayStats[id] = {});
  const e = d[ymd] || (d[ymd] = { km: 0, urbanKm: 0, fuel: 0, idealFuel: 0 });
  e.km += f.km; e.urbanKm += f.urbanKm; e.fuel += f.fuel; e.idealFuel += f.idealFuel;
}
function ymdDaysAgo(now, n) { return new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10); }
function pruneDayStats(st, now) {
  if (!st.dayStats) return;
  const cutoff = ymdDaysAgo(now, DAYSTATS_DAYS);
  for (const id of Object.keys(st.dayStats)) {
    const d = st.dayStats[id];
    for (const ymd of Object.keys(d)) if (ymd < cutoff) delete d[ymd];
  }
}

// Agrège kilométrage (jour / 30 j / 90 j), consommation moyenne et note
// d'éco-conduite (vert/jaune/rouge) en neutralisant la part urbaine.
function statsFor(st, id, now) {
  const ds = (st.dayStats && st.dayStats[id]) || {};
  const todayY = parisParts(now).ymd;
  const d30 = ymdDaysAgo(now, 30), d90 = ymdDaysAgo(now, 90);
  let kmDay = 0, litersDay = 0, km30 = 0, km90 = 0, fuel30 = 0, ideal30 = 0, urban30 = 0;
  for (const ymd of Object.keys(ds)) {
    const e = ds[ymd];
    if (ymd === todayY) { kmDay += e.km; litersDay += e.fuel; }
    if (ymd >= d30) { km30 += e.km; fuel30 += e.fuel; ideal30 += e.idealFuel; urban30 += e.urbanKm; }
    if (ymd >= d90) km90 += e.km;
  }
  const avgConso = km30 > 0 ? fuel30 / km30 * 100 : null;
  const excess = ideal30 > 0 ? (fuel30 - ideal30) / ideal30 : 0;
  const urbanShare = km30 > 0 ? urban30 / km30 : 0;
  let rating = 'na';
  if (km30 >= 10) rating = excess > 0.12 ? 'red' : (excess > 0.05 ? 'yellow' : 'green');
  return {
    kmDay: round1(kmDay), litersDay: round1(litersDay), kmMonth: round1(km30), kmQuarter: round1(km90),
    avgConso: avgConso != null ? round1(avgConso) : null,
    urbanShare: Math.round(urbanShare * 100), excessPct: Math.round(excess * 100), rating,
  };
}
const round1 = (n) => Math.round((n || 0) * 10) / 10;

const SAL_DEFAULT_TAUX = 12.09; // taux horaire brut par défaut (SMIC ~ 2024)
function parisMinOfDay(iso) { const pp = parisParts(new Date(iso)); return pp.hour * 60 + pp.minute; }

// Coût d'utilisation du jour pour un véhicule QUI S'EST DÉPLACÉ : décomposé en
// pôles (salarié, carburant, véhicule) jusqu'à l'immobilisation (retour au
// dépôt) ou 18h. Le coût « salarié » couvre l'amplitude d'utilisation.
function costFor(data, st, id, d, veh, cfg, atDepot, now) {
  const ymd = parisParts(now).ymd;
  const ds = (st.dayStats && st.dayStats[id] && st.dayStats[id][ymd]) || null;
  const kmToday = ds ? ds.km : 0;
  const litersToday = ds ? ds.fuel : 0;
  if (!d.dayFirstMoveAt && kmToday <= 0) return null; // pas utilisé aujourd'hui

  // Amplitude d'utilisation : du 1er départ jusqu'au DERNIER mouvement (et non
  // jusqu'à 18h) — sinon un véhicule garé hors dépôt comptait jusqu'à 18h.
  const CAP = 18 * 60;
  const startMin = d.dayFirstMoveAt ? parisMinOfDay(d.dayFirstMoveAt) : null;
  const nowMin = parisMinOfDay(now.toISOString());
  let endMin;
  if (d.moving) endMin = Math.min(nowMin, CAP);            // encore en tournée
  else if (d.finalStopAt) endMin = Math.min(parisMinOfDay(d.finalStopAt), CAP); // arrêté : fin = dernier arrêt
  else endMin = Math.min(nowMin, CAP);
  const amplitude = startMin != null ? Math.max(0, (endMin - startMin) / 60) : 0;

  // Pôle salarié : on ne paie PAS toute l'amplitude du véhicule (pause déjeuner
  // non payée, temps d'attente) ; on déduit la pause et on borne aux heures
  // réellement payables d'une journée (paramétrable). Évite de surévaluer le coût.
  const sp = (data.settings.salaryParams && veh && data.settings.salaryParams[veh.assignedUserId]) || null;
  const taux = (sp && Number(sp.tauxHoraire)) || SAL_DEFAULT_TAUX;
  const charges = cfg.chargesPatrPct != null ? Number(cfg.chargesPatrPct) : 42;
  const chargesSal = cfg.chargesSalPct != null ? Number(cfg.chargesSalPct) : 22; // part salariale (net ≈ brut×(1-22%))
  const mealBreak = cfg.mealBreakHours != null ? Number(cfg.mealBreakHours) : 0.75;
  const maxPaid = cfg.maxPaidHours != null ? Number(cfg.maxPaidHours) : 9;
  const hours = Math.max(0, Math.min(amplitude - (amplitude > mealBreak ? mealBreak : 0), maxPaid)); // heures payées
  const hourlyEmployer = taux * (1 + charges / 100);
  const salBrut = hours * taux;
  const salNet = salBrut * (1 - chargesSal / 100);
  const salarie = hours * hourlyEmployer; // coût chargé employeur (= le pôle)

  // Pôle carburant : litres réels estimés × prix.
  const fuelPrice = Number(cfg.fuelPrice) || DEFAULT_FUEL_PRICE;
  const carburant = litersToday * fuelPrice;

  // Pôle véhicule : charges fixes journalières (leasing + assurance, prorata
  // des jours travaillés) + usage au km (entretien, pneus, usure).
  const perKm = cfg.vehicleCostPerKm != null ? Number(cfg.vehicleCostPerKm) : 0.25;
  const lease = cfg.vehicleMonthlyLease != null ? Number(cfg.vehicleMonthlyLease) : 1000;
  const insur = cfg.vehicleMonthlyInsurance != null ? Number(cfg.vehicleMonthlyInsurance) : 220;
  const fixedDays = cfg.vehicleFixedDays != null ? Number(cfg.vehicleFixedDays) : 22;
  const vehiculeFixe = fixedDays > 0 ? (lease + insur) / fixedDays : 0;
  const vehiculeKm = kmToday * perKm;
  const vehicule = vehiculeFixe + vehiculeKm;

  const total = salarie + carburant + vehicule;
  return {
    total: round2(total), salarie: round2(salarie), carburant: round2(carburant), vehicule: round2(vehicule),
    vehiculeFixe: round2(vehiculeFixe), vehiculeKm: round2(vehiculeKm),
    hours: round1(hours), amplitude: round1(amplitude), km: round1(kmToday), liters: round1(litersToday),
    driverName: (veh && veh.assignedUserName) || '', hourlyEmployer: round2(hourlyEmployer),
    taux: round2(taux), salBrut: round2(salBrut), salNet: round2(salNet), salCharge: round2(salarie),
    closed: atDepot && !d.moving, // immobilisé (retour dépôt)
  };
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

// Dépôts par donneur d'ordre (coordonnées réelles) : départ/retour + temps sur
// place calculés à partir de la trace GPS du jour. Rayon en mètres.
const GROUP_DEPOTS = {
  gls: { lat: 49.141750, lng: -0.329389, r: 150, label: 'Dépôt GLS' },
  ciblex: { lat: 49.168750, lng: -0.295083, r: 150, label: 'Dépôt Ciblex' },
  fedex: { lat: 49.153667, lng: -0.312444, r: 150, label: 'Dépôt FedEx' },
};
// Stations AS24 (tous véhicules) : passage relevé seulement si arrêt > 3 min
// dans la zone (évite les faux positifs de simple passage devant la station).
const FUEL_STATIONS = [
  { name: 'AS24 Mondeville N°1', lat: 49.155278, lng: -0.311833, r: 70 },
  { name: 'AS24 Mondeville N°2', lat: 49.152000, lng: -0.299778, r: 70 },
  { name: 'AS24 Carpiquet', lat: 49.194139, lng: -0.450833, r: 70 },
];
const FUEL_MIN_MINUTES = 3;

function depotKeyForGroup(g) {
  if (!g) return null;
  const s = (String(g.id || '') + ' ' + String(g.name || '')).toLowerCase();
  if (/\bgls\b|gls/.test(s)) return 'gls';
  if (/ciblex/.test(s)) return 'ciblex';
  if (/fedex/.test(s)) return 'fedex';
  return null;
}
// Visites d'une zone GPS à partir de la trace : entrée / sortie / durée (min).
// La sortie est estimée au milieu entre le dernier point DANS la zone et le
// 1er point HORS zone (compromis, la trace étant échantillonnée).
function zoneVisits(trail, zLat, zLng, rM) {
  const pts = (trail || []).filter((p) => p && p.lat != null && p.lng != null && p.ts)
    .slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const visits = []; let cur = null;
  for (let i = 0; i < pts.length; i++) {
    const inside = haversineM(pts[i].lat, pts[i].lng, zLat, zLng) <= rM;
    if (inside) { if (!cur) cur = { enter: pts[i].ts, lastIn: pts[i].ts }; else cur.lastIn = pts[i].ts; }
    else if (cur) { cur.out = pts[i].ts; visits.push(cur); cur = null; }
  }
  if (cur) { cur.open = true; visits.push(cur); }
  return visits.map((v) => {
    const enterMs = new Date(v.enter).getTime(), lastInMs = new Date(v.lastIn).getTime();
    const exitMs = v.out ? Math.round((lastInMs + new Date(v.out).getTime()) / 2) : lastInMs;
    return { enter: v.enter, exit: new Date(exitMs).toISOString(), minutes: Math.round((exitMs - enterMs) / 60000 * 10) / 10, open: !!v.open };
  });
}
// Synthèse dépôt : 1er départ (sortie de la 1re visite), retour (dernière
// entrée), temps total passé sur place.
function depotSummary(trail, depot) {
  if (!depot || depot.lat == null) return null;
  const vs = zoneVisits(trail, depot.lat, depot.lng, depot.r || 150);
  if (!vs.length) return null;
  const depart = vs[0].open ? null : vs[0].exit;
  const retour = vs.length >= 2 ? vs[vs.length - 1].enter : null;
  const dwellMin = Math.round(vs.reduce((s, v) => s + v.minutes, 0) * 10) / 10;
  return { label: depot.label, depart, retour, dwellMin };
}
// Passages AS24 (arrêt > seuil) à partir de la trace.
function fuelStops(trail, stations, minMin) {
  const out = [];
  (stations || []).forEach((s) => {
    zoneVisits(trail, s.lat, s.lng, s.r || 70).forEach((v) => {
      if (v.minutes >= (minMin || FUEL_MIN_MINUTES)) out.push({ name: s.name, at: v.enter, minutes: v.minutes });
    });
  });
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

function liveList(data) {
  const st = ensureState(data);
  const cfg = data.settings.pajgps || {};
  const map = cfg.deviceMap || {};
  const depot = { lat: cfg.depotLat, lng: cfg.depotLng, r: Number(cfg.depotRadius) || 300 };
  const vehById = {}; (data.vehicles || []).forEach((v) => { vehById[v.id] = v; });
  const usersById = {}; (data.users || []).forEach((u) => { usersById[u.id] = u; });
  const groupsById = {}; (data.groups || []).forEach((g) => { groupsById[g.id] = g; });
  const duMap = cfg.deviceUserMap || {};
  const now = new Date();
  const out = [];
  for (const id of Object.keys(st.devices)) {
    const d = st.devices[id];
    let veh = map[id] ? vehById[map[id]] : matchVehicle(data, d);
    // Attribution directe traceur → chauffeur inscrit (prioritaire sur le véhicule).
    if (duMap[id]) {
      const u = usersById[duMap[id]];
      veh = Object.assign({}, veh || {}, { assignedUserId: duMap[id], assignedUserName: u ? `${u.firstName} ${u.lastName}` : ((veh && veh.assignedUserName) || '') });
    }
    const atDepot = (depot.lat != null && depot.lng != null && d.lat != null && d.lng != null)
      ? haversineM(d.lat, d.lng, depot.lat, depot.lng) <= depot.r : false;
    // Retard à la prise de poste : 1re mise en mouvement du jour vs heure prévue.
    // Priorité : heure par chauffeur → heure par groupe → heure par défaut.
    const driverId = veh && veh.assignedUserId;
    const driverUser = driverId ? usersById[driverId] : null;
    // Groupe : attribution directe traceur → groupe (config) prioritaire, sinon
    // groupe du chauffeur, sinon groupe du véhicule attribué.
    const groupId = ((cfg.deviceGroupMap || {})[id]) || (driverUser && driverUser.groupId) || (veh && veh.groupId) || null;
    const priseRef = (driverId && cfg.priseDePosteByUser && cfg.priseDePosteByUser[driverId])
      || (groupId && cfg.priseDePosteByGroup && cfg.priseDePosteByGroup[groupId])
      || cfg.priseDePoste || '';
    let late = null;
    if (priseRef && d.dayFirstMoveAt) {
      const refMin = hmToMin(priseRef, null);
      const firstMin = parisMinOfDay(d.dayFirstMoveAt);
      if (refMin != null && firstMin > refMin) late = { ref: priseRef, minutes: Math.round(firstMin - refMin) };
    }
    // Dépôt du groupe (GLS / Ciblex / FedEx) : départ / retour / temps sur place.
    // Passages AS24 (tous véhicules), relevés seulement au-delà de 3 min sur place.
    const gKey = depotKeyForGroup(groupsById[groupId]);
    const gDepot = gKey ? (((cfg.groupDepots || {})[gKey]) || GROUP_DEPOTS[gKey]) : null;
    const depotInfo = gDepot ? depotSummary(d.trail, gDepot) : null;
    const fuelPassages = fuelStops(d.trail, cfg.fuelStations || FUEL_STATIONS, FUEL_MIN_MINUTES);
    out.push({
      deviceId: id, name: d.name, imei: d.imei, model: d.model,
      lat: d.lat, lng: d.lng, speed: d.speed, direction: d.direction, battery: d.battery, ts: d.ts,
      moving: d.moving, stoppedSince: d.stoppedSince, finalStopAt: d.finalStopAt, atDepot,
      activeSince: d.dayFirstMoveAt || null, lastMovingAt: d.lastMovingAt || null, late,
      odometer: { real: d.odoReal != null ? round1(d.odoReal) : null, realAt: d.odoRealAt || null, fleet: (veh && veh.km != null) ? Math.round(veh.km) : null },
      status: classify(d), overspeed: d.overspeed, trail: d.trail, address: d.addr || '',
      stats: statsFor(st, id, now), cost: costFor(data, st, id, d, veh, cfg, atDepot, now),
      vehicleId: veh ? veh.id : null, vehicleName: veh ? veh.name : null, plate: veh ? veh.plate : null,
      driverId: driverId || null, driverName: (veh && veh.assignedUserName) || '',
      groupId: groupId || null, groupName: (groupId && groupsById[groupId] && groupsById[groupId].name) || '',
      depotInfo, fuelStops: fuelPassages,
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
  const duMap = cfg.deviceUserMap || {};
  const vehById = {}; (data.vehicles || []).forEach((v) => { vehById[v.id] = v; });
  const usersById = {}; (data.users || []).forEach((u) => { usersById[u.id] = u; });
  // Étiquette = chauffeur attribué (cohérence « Impact par chauffeur » dans tout
  // le site), sinon le véhicule, sinon le traceur.
  const labelFor = (e) => {
    const veh = map[e.deviceId] ? vehById[map[e.deviceId]] : matchVehicle(data, { name: e.name });
    const uid = duMap[e.deviceId] || (veh && veh.assignedUserId);
    if (uid && usersById[uid]) return `${usersById[uid].firstName} ${usersById[uid].lastName}`;
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
 * Archive durablement la consommation ESTIMÉE (GPS) par véhicule et par jour,
 * pour pouvoir ensuite la croiser avec les pleins réels AS 24 et affiner le
 * modèle de consommation. Upsert idempotent par (date, traceur) ; bornage ~400 j.
 */
function syncFuelEstimates(data) {
  const st = ensureState(data);
  const cfg = data.settings.pajgps || {};
  const map = cfg.deviceMap || {};
  const duMap = cfg.deviceUserMap || {};
  const vehById = {}; (data.vehicles || []).forEach((v) => { vehById[v.id] = v; });
  const usersById = {}; (data.users || []).forEach((u) => { usersById[u.id] = u; });
  if (!Array.isArray(data.fuelEstimates)) data.fuelEstimates = [];
  const idx = {};
  data.fuelEstimates.forEach((e, i) => { idx[e.date + '|' + e.deviceId] = i; });
  const ds = st.dayStats || {};
  const nowIso = new Date().toISOString();
  for (const id of Object.keys(ds)) {
    const dev = st.devices[id] || {};
    const veh = map[id] ? vehById[map[id]] : matchVehicle(data, dev);
    const driverId = duMap[id] || (veh && veh.assignedUserId) || null;
    const u = driverId ? usersById[driverId] : null;
    const days = ds[id];
    for (const ymd of Object.keys(days)) {
      const e = days[ymd];
      if (!e || (!(e.km > 0) && !(e.fuel > 0))) continue;
      const rec = {
        date: ymd, deviceId: id,
        vehicleId: veh ? veh.id : null, vehicleName: veh ? veh.name : (dev.name || ''),
        plate: veh ? (veh.plate || '') : '',
        driverId, driverName: u ? `${u.firstName} ${u.lastName}` : ((veh && veh.assignedUserName) || ''),
        km: round1(e.km), liters: round1(e.fuel), updatedAt: nowIso,
      };
      const k = ymd + '|' + id;
      if (idx[k] != null) data.fuelEstimates[idx[k]] = rec;
      else { data.fuelEstimates.push(rec); idx[k] = data.fuelEstimates.length - 1; }
    }
  }
  const cutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  data.fuelEstimates = data.fuelEstimates.filter((e) => e.date >= cutoff);
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
    const consoRoad90 = Number(cfg.consoRoad90) || SPRINTER_ROAD90;
    const consoUrban = Number(cfg.consoUrban) || SPRINTER_URBAN;
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
      updateDevice(st, dev, p, now, limit, win, { roadLimit, fuelPrice, consoRoad90, consoUrban });
    }
    st._lastPollTs = Date.now();
    st._lastError = '';
    try { syncFuelEstimates(data); } catch (e) { /* archivage best-effort */ }
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
  login, getDevices, classify, resetToken, syncFuelEstimates,
};
