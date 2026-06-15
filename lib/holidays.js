'use strict';

// Calcul des jours fériés français (métropole) pour une année donnée.
// Inclut les fêtes fixes + celles basées sur Pâques (Lundi de Pâques,
// Ascension, Lundi de Pentecôte) via l'algorithme de Meeus/Butcher.

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = mars, 4 = avril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// Renvoie un objet { 'YYY-MM-DD': 'Nom du jour férié' }
function holidaysForYear(year) {
  const easter = easterSunday(year);
  const list = {
    [`${year}-01-01`]: 'Jour de l’An',
    [`${year}-05-01`]: 'Fête du Travail',
    [`${year}-05-08`]: 'Victoire 1945',
    [`${year}-07-14`]: 'Fête Nationale',
    [`${year}-08-15`]: 'Assomption',
    [`${year}-11-01`]: 'Toussaint',
    [`${year}-11-11`]: 'Armistice 1918',
    [`${year}-12-25`]: 'Noël',
    [iso(addDays(easter, 1))]: 'Lundi de Pâques',
    [iso(addDays(easter, 39))]: 'Ascension',
    [iso(addDays(easter, 50))]: 'Lundi de Pentecôte',
  };
  return list;
}

// Cache multi-années
const cache = {};
function holidaysMap(years) {
  let map = {};
  for (const y of years) {
    if (!cache[y]) cache[y] = holidaysForYear(y);
    map = Object.assign(map, cache[y]);
  }
  return map;
}

function isHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!cache[year]) cache[year] = holidaysForYear(year);
  return Boolean(cache[year][dateStr]);
}

// Un jour ouvré pour les chauffeurs : lundi -> samedi, hors jours fériés.
// dimanche = 0 dans getUTCDay
function isWorkingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0) return false; // dimanche
  if (isHoliday(dateStr)) return false;
  return true;
}

// Compte les jours ouvrés (lun-sam, hors fériés) entre deux dates incluses.
function countWorkingDays(startStr, endStr) {
  let count = 0;
  let cur = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  while (cur.getTime() <= end.getTime()) {
    const s = cur.toISOString().slice(0, 10);
    if (isWorkingDay(s)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

module.exports = {
  holidaysForYear,
  holidaysMap,
  isHoliday,
  isWorkingDay,
  countWorkingDays,
};
