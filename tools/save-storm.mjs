#!/usr/bin/env node
/**
 * ⚡ UKKOSTUTKA — Myrskyn tallennus (npm run something-something-storm)
 *
 * Hakee aikavälin salamat FMI:n avoimesta datasta ja tallentaa ne
 * staattiseksi tiedostoksi storms/<id>.json + kortin storms/index.json:iin.
 * Replay lukee vain näitä tiedostoja — FMI:tä ei tarvita enää jälkikäteen.
 *
 * Käyttö (ilman argumentteja kysyy kaiken):
 *   npm run something-something-storm
 *   npm run save-storm -- "2026-07-30 21:00" "02:00" "Heinäkuun rintama"
 *
 * Ajat Suomen aikaa (kesä/talviaika hoituu itsestään). Pelkkä "02:00"
 * loppuna = sama päivä tai seuraava yö. UTC:nä: "2026-07-30T18:00Z".
 * Valinnainen: --radius 400  (vain iskut näin lähellä Oulua, km)
 *
 * Tiedostomuoto (v1): strikes = [[lat, lon, sekuntia_alusta], ...] aikajärjestyksessä.
 * Data: Ilmatieteen laitos, avoin data (CC BY 4.0).
 *
 * Miia & Caelan, 2026 🖤
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const TZ = 'Europe/Helsinki';
const OULU_LAT = 65.0121;
const OULU_LON = 25.4651;
const NORDIC_BBOX = '4,54,32,71';
const CHUNK_MIN = 30;     // yksi FMI-kysely
const MIN_CHUNK_MIN = 5;  // jos 30 min on liikaa, puolitetaan tähän asti
const STORMS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storms');

// --- Aika: Suomen aika ↔ UTC ---

const pad = n => String(n).padStart(2, '0');

function tzOffsetMs(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

function helsinkiToUtc(y, mo, d, h, mi) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let utc = naive - tzOffsetMs(naive);
  utc = naive - tzOffsetMs(utc); // korjaus kellojen siirron lähellä
  return new Date(utc);
}

export function localParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute };
}

/** Hylkää 31.2., 25:00 ja kellonsiirron puuttuvan tunnin: tuloksen pitää olla sama kuin syöte */
function strictHelsinki(y, mo, d, h, mi, original) {
  const norm = new Date(Date.UTC(y, mo - 1, d)); // seuraava päivä yms. normalisoituu tässä
  const want = { y: norm.getUTCFullYear(), mo: norm.getUTCMonth() + 1, d: norm.getUTCDate(), h, mi };
  const utc = helsinkiToUtc(y, mo, d, h, mi);
  const got = localParts(utc);
  if (h > 23 || mi > 59 || mo < 1 || mo > 12 ||
      got.y !== want.y || got.mo !== want.mo || got.d !== want.d || got.h !== want.h || got.mi !== want.mi ||
      (original && d !== want.d)) {
    throw new Error(`"${original || `${h}:${pad(mi)}`}" ei ole olemassa oleva aika Suomessa ` +
                    '(väärä päivä/kellonaika tai kellonsiirrossa hypätty tunti)');
  }
  return utc;
}

/** "2026-07-30 21:00" (Suomen aikaa), "2026-07-30T18:00Z" (UTC) tai pelkkä "02:00" (vaatii base) */
export function parseTime(str, base = null) {
  const s = String(str).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d)) throw new Error(`En ymmärrä aikaa "${s}"`);
    return d;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})[:.](\d{2})$/);
  if (m) return strictHelsinki(+m[1], +m[2], +m[3], +m[4], +m[5], s);
  m = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m && base) {
    const b = localParts(base);
    const d = strictHelsinki(b.y, b.mo, b.d, +m[1], +m[2]);
    return d > base ? d : strictHelsinki(b.y, b.mo, b.d + 1, +m[1], +m[2]);
  }
  throw new Error(`En ymmärrä aikaa "${s}" — käytä muotoa 2026-07-30 21:00`);
}

function fmtLocal(date) {
  const p = localParts(date);
  return `${p.d}.${p.mo}.${p.y} ${pad(p.h)}:${pad(p.mi)}`;
}
function fmiTime(d) { return d.toISOString().split('.')[0] + 'Z'; }

// --- FMI ---

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
            Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Sama parseri kuin Workerissa: positions = lat lon unixaika -tripletit */
export function parseFmi(xml) {
  if (/ExceptionReport/.test(xml)) {
    const msg = (xml.match(/<ExceptionText>([\s\S]*?)<\/ExceptionText>/) || [])[1] || 'tuntematon virhe';
    throw new Error('FMI: ' + msg.trim());
  }
  const m = xml.match(/<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/);
  if (!m) return [];
  const p = m[1].trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 2 < p.length; i += 3) out.push({ lat: p[i], lon: p[i + 1], time: p[i + 2] });
  return out;
}

async function fetchChunk(start, end) {
  const url = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature' +
    '&storedquery_id=fmi::observations::lightning::multipointcoverage' +
    `&bbox=${NORDIC_BBOX}&starttime=${fmiTime(start)}&endtime=${fmiTime(end)}`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) { // toinen yritys, sitten pilkotaan
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok && !/ExceptionReport/.test(text)) throw new Error('HTTP ' + res.status);
      return parseFmi(text);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

/** Hakee välin; jos pala epäonnistuu, puolittaa sen (iso myrsky = paljon dataa) */
async function fetchRange(start, end, log) {
  const mins = (end - start) / 60000;
  try {
    const strikes = await fetchChunk(start, end);
    log(`  ${fmtLocal(start)} → ${fmtLocal(end).slice(-5)}  ${String(strikes.length).padStart(6)} salamaa`);
    return strikes;
  } catch (e) {
    if (mins <= MIN_CHUNK_MIN) throw new Error(`${fmtLocal(start)}: ${e.message}`);
    log(`  ${fmtLocal(start)}: ${e.message} — pilkotaan pienemmäksi`);
    const mid = new Date(start.getTime() + Math.round(mins / 2) * 60000);
    return [...await fetchRange(start, mid, log), ...await fetchRange(mid, end, log)];
  }
}

export async function downloadStorm(start, end, { radiusKm = null, log = console.log } = {}) {
  const all = [];
  for (let t = start.getTime(); t < end.getTime(); t += CHUNK_MIN * 60000) {
    const a = new Date(t), b = new Date(Math.min(t + CHUNK_MIN * 60000, end.getTime()));
    all.push(...await fetchRange(a, b, log));
  }
  // Palojen rajalla sama isku voi tulla kahdesti
  const seen = new Set();
  const t0 = start.getTime() / 1000;
  const rows = [];
  for (const s of all) {
    if (s.time < t0 || s.time > end.getTime() / 1000) continue;
    if (radiusKm && distanceKm(OULU_LAT, OULU_LON, s.lat, s.lon) > radiusKm) continue;
    const key = `${s.lat},${s.lon},${s.time}`; // alkuperäinen tarkkuus: lähekkäiset iskut eivät sulaudu
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([Math.round(s.lat * 1000) / 1000, Math.round(s.lon * 1000) / 1000, Math.round(s.time - t0)]);
  }
  rows.sort((a, b) => a[2] - b[2]);
  return rows;
}

// --- Tiedostot ---

export function buildStorm({ id, name, start, end, strikes, radiusKm }) {
  return {
    v: 1, id, name,
    start: start.toISOString(), end: end.toISOString(),
    count: strikes.length,
    radiusKm: radiusKm || null,
    source: 'Ilmatieteen laitos, avoin data (CC BY 4.0)',
    fields: ['lat', 'lon', 'secondsFromStart'],
    strikes
  };
}

async function readIndex() {
  const file = path.join(STORMS_DIR, 'index.json');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { storms: [] }; throw e; } // ensimmäinen myrsky
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`storms/index.json on rikki (${e.message}) — korjaa se ensin, ettei kirjasto katoa`); }
}

async function upsertIndex(entry) {
  const file = path.join(STORMS_DIR, 'index.json');
  const index = await readIndex();
  index.storms = (index.storms || []).filter(s => s.id !== entry.id);
  index.storms.push(entry);
  index.storms.sort((a, b) => b.start.localeCompare(a.start)); // uusin ensin
  await writeFile(file, JSON.stringify(index, null, 2) + '\n');
}

function compactJson(storm) {
  // Yksi isku per rivi: luettava diffi gitissä, silti pieni
  const { strikes, ...meta } = storm;
  const head = JSON.stringify(meta, null, 2).replace(/\n}$/, '');
  return head + ',\n  "strikes": [\n' + strikes.map(r => '    ' + JSON.stringify(r)).join(',\n') + '\n  ]\n}\n';
}

// --- CLI ---

function usage() {
  console.log(`
⚡ Myrskyn tallennus — npm run something-something-storm

  Ilman argumentteja kysyn kaiken. Tai suoraan:
    npm run save-storm -- "2026-07-30 21:00" "02:00" "Heinäkuun rintama"

  Ajat Suomen aikaa. Loppuajaksi riittää kellonaika (yön yli menee itsestään).
  Valinnainen: --radius 400   (vain iskut 400 km säteellä Oulusta)

  Tulos: storms/<päivä>.json + kortti storms/index.json:iin.
  Saman päivän toinen myrsky: storms/<päivä>-<kellonaika>.json.
  Sama alkuaika uudelleen korvaa aiemman tallenteen.
  Sen jälkeen: git add storms && git commit -m "Myrsky" && git push
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) return usage();
  let radiusKm = null;
  const ri = args.indexOf('--radius');
  if (ri >= 0) {
    radiusKm = Number(args[ri + 1]);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) throw new Error(`--radius tarvitsee positiivisen luvun (km), sain "${args[ri + 1]}"`);
    args.splice(ri, 2);
  }

  let [startStr, endStr, name] = args;
  if (!startStr) {
    usage();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    startStr = await rl.question('Alku (esim. 2026-07-30 21:00): ');
    endStr = await rl.question('Loppu (esim. 02:00): ');
    name = await rl.question('Nimi (esim. Heinäkuun rintama): ');
    rl.close();
  }
  const start = parseTime(startStr);
  const end = parseTime(endStr, start);
  if (end <= start) throw new Error('Loppu on ennen alkua');
  const hours = (end - start) / 3600000;
  if (hours > 24) throw new Error(`${hours.toFixed(1)} h on aika pitkä myrsky — tarkista ajat`);
  const lp = localParts(start);
  // Tunnus = päivä; saman päivän TOINEN myrsky saa kellonajan perään.
  // Sama alku uudelleen = tarkoituksellinen uudelleentallennus, korvataan.
  let id = `${lp.y}-${pad(lp.mo)}-${pad(lp.d)}`;
  const existing = (await readIndex()).storms || [];
  const sameDay = existing.find(s => s.id === id);
  if (sameDay && sameDay.start !== start.toISOString()) id += `-${pad(lp.h)}${pad(lp.mi)}`;
  const replacing = existing.find(s => s.id === id);
  name = (name || '').trim() || `Myrsky ${lp.d}.${lp.mo}.${lp.y}`;

  console.log(`\n⛈️  ${name}\n   ${fmtLocal(start)} – ${fmtLocal(end)} Suomen aikaa (${hours.toFixed(1)} h)` +
              (radiusKm ? `, ${radiusKm} km Oulusta` : ', koko Pohjola') + '\n');

  if (replacing) console.log(`   (korvaa aiemman tallenteen "${replacing.name}", sama alkuaika)\n`);

  const strikes = await downloadStorm(start, end, { radiusKm });
  if (strikes.length === 0) {
    console.log('\nEi yhtään salamaa tällä välillä' + (radiusKm ? ` ${radiusKm} km säteellä` : '') +
                ' — mitään ei tallennettu. Tarkista ajat?');
    process.exitCode = 1;
    return;
  }

  const storm = buildStorm({ id, name, start, end, strikes, radiusKm });
  await mkdir(STORMS_DIR, { recursive: true });
  const file = path.join(STORMS_DIR, id + '.json');
  const body = compactJson(storm);
  await writeFile(file, body);
  await upsertIndex({ id, name, start: storm.start, end: storm.end, count: storm.count, file: `storms/${id}.json` });

  console.log(`\n✅ ${strikes.length} salamaa → storms/${id}.json (${(body.length / 1024).toFixed(0)} KB)`);
  console.log('   Seuraavaksi: git add storms && git commit -m "Myrsky: ' + name + '" && git push\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error('\n❌ ' + e.message); process.exitCode = 1; });
}
