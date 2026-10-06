/**
 * ⚡ UKKOSTUTKA - Cloudflare Worker
 *
 * Hakee salamadatan FMI:n avoimesta rajapinnasta, hallinnoi push-hälytyksiä,
 * JA seuraa myrskysoluja: klusteroi iskut, antaa soluille identiteetin yli
 * syklien, laskee suunnan + nopeuden ja tallentaa polun D1:een (6 h häntä).
 *
 * Miia & Caelan, 2026 🖤
 *
 * --- TURVAPÄIVITYS 2026-06-04 (Caelan) ---
 *   CORS lukittu originiin; /clear-subs ja /debug vaativat ADMIN_TOKENin.
 * --- AIKAIKKUNA 2026-06-13 (Caelan) ---
 *   Pääendpoint hakee 3 h iskuja ikäporrastusta varten.
 * --- MYRSKYSOLUSEURANTA 2026-06-14 (Caelan) ---
 *   D1 (binding: STORMS). Cron klusteroi + seuraa soluja. Uusi GET /cells.
 * --- LEPOTILA 2026-10-06 (Caelan) ---
 *   Itsestään herääva tila. D1-taulu `state` (mode = active | sleep).
 *   Levossa cron tekee vain kevyen tarkistuksen (FMI-haku + säderajaus,
 *   ei klusterointia eikä D1-kirjoituksia). Herätys: vähintään 2 iskua
 *   säteellä ≤ 25 km toisistaan → active. 3 h ilman sellaista → sleep.
 *   Uusi GET /status (tila selaimella tarkistettavaksi, ei UI:ssa).
 *   Jos `state`-taulua ei ole, cron toimii kuten ennen (aina active).
 *
 * BINDINGIT joita Worker tarvitsee:
 *   KV   "SUBSCRIPTIONS"  (push-tilaukset, ennallaan)
 *   D1   "STORMS"         (database: ukkostutka-storms, id b7480f00-c959-4a0f-9e45-6ee193d86ced)
 *   Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, ADMIN_TOKEN
 * CRON: joka 10. minuutti (asetettu dashboardissa)
 */

const ALLOWED_ORIGINS = [
  'https://ukkostutka.pages.dev',
  'https://ukkostutka.miiatikkala.fi'];

const PRIMARY_ORIGIN = ALLOWED_ORIGINS[0];

function corsFor(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : PRIMARY_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

const HISTORY_HOURS = 3;
const OULU_LAT = 65.0121;
const OULU_LON = 25.4651;

// --- Myrskysolun parametrit (säädettävissä) ---
const CLUSTER_WINDOW_MIN = 15;
const CLUSTER_EPS_KM     = 25;
const CLUSTER_MIN_PTS    = 3;
const MATCH_MAX_KM       = 40;
const CELL_TIMEOUT_MIN   = 30;
const TRACK_TTL_HOURS    = 6;

// --- Hälytys + lepotila ---
const ALERT_RADIUS     = 200; // push-hälytyksen säde (km)
const WAKE_RADIUS_KM   = 200; // herättävien iskujen pitää olla tämän sisällä
const WAKE_PAIR_KM     = CLUSTER_EPS_KM; // ...ja vähintään kaksi näin lähekkäin
const SLEEP_AFTER_MIN  = 180; // näin kauan ilman iskuja säteellä → lepoon

function fmiTime(d) { return d.toISOString().split('.')[0] + 'Z'; }

function buildFmiUrl(start, end) {
  const NORDIC_BBOX = '4,54,32,71'; // lon_min, lat_min, lon_max, lat_max

let u = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=fmi::observations::lightning::multipointcoverage';
u += `&bbox=${NORDIC_BBOX}`;
if (start && end) u += `&starttime=${fmiTime(start)}&endtime=${fmiTime(end)}`;
return u;
}

function isAuthorized(request, url, env) {
  const fromQuery = url.searchParams.get('token');
  const fromHeader = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = fromQuery || fromHeader;
  return Boolean(env.ADMIN_TOKEN) && provided === env.ADMIN_TOKEN;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}
function toRadians(d) { return d * Math.PI / 180; }
function toDegrees(r) { return r * 180 / Math.PI; }

function bearing(lat1, lon1, lat2, lon2) {
  const f1 = toRadians(lat1), f2 = toRadians(lat2), dl = toRadians(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}
function compassFi(deg) {
  const dirs = ['pohjoiseen', 'koilliseen', 'itään', 'kaakkoon',
                'etelään', 'lounaaseen', 'länteen', 'luoteeseen'];
  return dirs[Math.round(deg / 45) % 8];
}

function clusterStrikes(strikes, epsKm, minPts) {
  const n = strikes.length;
  const visited = new Array(n).fill(false);
  const assigned = new Array(n).fill(-1);
  const clusters = [];

  const neighbors = i => {
    const res = [];
    for (let j = 0; j < n; j++) {
      if (j !== i &&
          calculateDistance(strikes[i].lat, strikes[i].lon, strikes[j].lat, strikes[j].lon) <= epsKm) {
        res.push(j);
      }
    }
    return res;
  };

  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const nb = neighbors(i);
    if (nb.length + 1 < minPts) continue;
    const cid = clusters.length;
    clusters.push([]);
    assigned[i] = cid;
    clusters[cid].push(i);
    const queue = [...nb];
    while (queue.length) {
      const j = queue.shift();
      if (!visited[j]) {
        visited[j] = true;
        const nb2 = neighbors(j);
        if (nb2.length + 1 >= minPts) {
          for (const k of nb2) if (!queue.includes(k)) queue.push(k);
        }
      }
      if (assigned[j] === -1) { assigned[j] = cid; clusters[cid].push(j); }
    }
  }

  return clusters.map(idxs => {
    let la = 0, lo = 0;
    idxs.forEach(ix => { la += strikes[ix].lat; lo += strikes[ix].lon; });
    const lat = la / idxs.length, lon = lo / idxs.length;
    return { lat, lon, count: idxs.length, distanceFromOulu: calculateDistance(OULU_LAT, OULU_LON, lat, lon) };
  });
}

// Vähintään kaksi iskua lähekkäin → oikea ukkonen, ei yksittäinen harhaisku
function hasNearbyPair(strikes, maxKm) {
  for (let i = 0; i < strikes.length; i++)
    for (let j = i + 1; j < strikes.length; j++)
      if (calculateDistance(strikes[i].lat, strikes[i].lon, strikes[j].lat, strikes[j].lon) <= maxKm) return true;
  return false;
}

// --- Lepotilan tila (D1-taulu `state`, avain/arvo) ---
async function getState(env) {
  const res = await env.STORMS.prepare(`SELECT key, value FROM state`).all();
  const s = {};
  for (const r of (res.results || [])) s[r.key] = r.value;
  return s;
}
async function setState(env, pairs) {
  await env.STORMS.batch(Object.entries(pairs).map(([k, v]) =>
    env.STORMS.prepare(
      `INSERT INTO state (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(k, v)
  ));
}

async function getVapidHeaders(endpoint, subject, publicKey, privateKey) {
  const audience = new URL(endpoint).origin;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 3600;
  const encode = obj => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ aud: audience, exp: expiration, sub: subject })}`;
  const pubKeyBytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const toB64url = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwk = { kty: 'EC', crv: 'P-256', x: toB64url(pubKeyBytes.slice(1, 33)), y: toB64url(pubKeyBytes.slice(33, 65)), d: privateKey, ext: true, key_ops: ['sign'] };
  const signingKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(unsigned));
  return { Authorization: `vapid t=${unsigned}.${toB64url(new Uint8Array(signature))}, k=${publicKey}`, 'Content-Type': 'application/octet-stream', TTL: '86400' };
}
async function sendPushNotification(subscription, payload, env) {
  const headers = await getVapidHeaders(subscription.endpoint, env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const r = await fetch(subscription.endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  return r.ok;
}

function jsonResponse(obj, corsHeaders, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = corsFor(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      try {
        const subscription = await request.json();
        await env.SUBSCRIPTIONS.put('sub_' + Date.now(), JSON.stringify(subscription));
        return jsonResponse({ ok: true }, corsHeaders);
      } catch (e) { return jsonResponse({ error: e.message }, corsHeaders, 500); }
    }

    if (url.pathname === '/simulate' && request.method === 'POST') {
      try {
        const now = Date.now();
        const fakeStrikes = [
          { lat: 64.5, lon: 25.8, distance: 58,  peakCurrent: -42, timestamp: new Date(now - 180000).toISOString() },
          { lat: 64.2, lon: 26.1, distance: 91,  peakCurrent: 31,  timestamp: new Date(now - 90000).toISOString() },
          { lat: 63.9, lon: 24.9, distance: 125, peakCurrent: -67, timestamp: new Date(now - 30000).toISOString() },
        ];
        const closest = fakeStrikes.reduce((a, b) => a.distance < b.distance ? a : b);
        const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub_' });
        for (const key of list.keys) {
          const raw = await env.SUBSCRIPTIONS.get(key.name);
          if (!raw) continue;
          await sendPushNotification(JSON.parse(raw), {
            title: '⚡ Ukkostutka — SIMULAATIO',
            body: `${fakeStrikes.length} salamaa — lähin ${closest.distance} km päässä Oulusta`,
            url: PRIMARY_ORIGIN
          }, env);
        }
        return jsonResponse({ ok: true, strikes: fakeStrikes }, corsHeaders);
      } catch (e) { return jsonResponse({ error: e.message }, corsHeaders, 500); }
    }

    if (url.pathname === '/debug') {
      if (!isAuthorized(request, url, env)) return jsonResponse({ error: 'Unauthorized' }, corsHeaders, 401);
      const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub_' });
      return jsonResponse({ subscriptionCount: list.keys.length }, corsHeaders);
    }

    if (url.pathname === '/clear-subs') {
      if (!isAuthorized(request, url, env)) return jsonResponse({ error: 'Unauthorized' }, corsHeaders, 401);
      const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub_' });
      for (const key of list.keys) await env.SUBSCRIPTIONS.delete(key.name);
      return jsonResponse({ deleted: list.keys.length }, corsHeaders);
    }

    if (url.pathname === '/vapid-public-key') {
      return jsonResponse({ publicKey: env.VAPID_PUBLIC_KEY }, corsHeaders);
    }

    // === LEPOTILAN TILA ===
    if (url.pathname === '/status') {
      try {
        const s = await getState(env);
        return jsonResponse({
          mode: s.mode || 'active',
          modeChangedAt: s.mode_changed_at || null,
          lastStrikeAt: s.last_strike_at || null,
          wakeRadiusKm: WAKE_RADIUS_KM,
          sleepAfterMin: SLEEP_AFTER_MIN
        }, corsHeaders);
      } catch (e) {
        return jsonResponse({ mode: 'unknown', error: e.message }, corsHeaders, 500);
      }
    }

    // === MYRSKYSOLUT + POLUT (6 h) ===
    if (url.pathname === '/cells') {
      try {
        const sixAgo = new Date(Date.now() - TRACK_TTL_HOURS * 3600000).toISOString();
        const cellsRes = await env.STORMS.prepare(
          `SELECT DISTINCT c.id, c.status, c.first_seen, c.last_seen, c.peak_strikes
           FROM cells c JOIN cell_tracks t ON t.cell_id = c.id
           WHERE t.timestamp >= ?1 ORDER BY c.id`
        ).bind(sixAgo).all();

        const cells = [];
        for (const c of (cellsRes.results || [])) {
          const tr = await env.STORMS.prepare(
            `SELECT lat, lon, strike_count, direction_deg, speed_kmh, distance_from_oulu, timestamp
             FROM cell_tracks WHERE cell_id = ?1 AND timestamp >= ?2 ORDER BY timestamp ASC`
          ).bind(c.id, sixAgo).all();
          const track = tr.results || [];
          const latest = track[track.length - 1] || null;
          cells.push({
            id: c.id, status: c.status, first_seen: c.first_seen,
            last_seen: c.last_seen, peak_strikes: c.peak_strikes,
            latest: latest ? { ...latest, compass: latest.direction_deg != null ? compassFi(latest.direction_deg) : null } : null,
            track
          });
        }
        return jsonResponse({ generated: new Date().toISOString(), cellCount: cells.length, cells }, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: 'Solujen haku epäonnistui', details: e.message }, corsHeaders, 500);
      }
    }

    // === PÄÄENDPOINT: SALAMADATA (3 h) ===
    try {
      const now = new Date();
      const start = new Date(now.getTime() - HISTORY_HOURS * 3600000);
      const fmiResponse = await fetch(buildFmiUrl(start, now));
      const strikes = parseXML(await fmiResponse.text()).map(s => ({
        ...s, distanceFromOulu: calculateDistance(OULU_LAT, OULU_LON, s.lat, s.lon)
      }));
      return jsonResponse({
        timestamp: now.toISOString(),
        historyHours: HISTORY_HOURS,
        totalStrikes: strikes.length,
        strikesWithin200km: strikes.filter(s => s.distanceFromOulu <= 200).length,
        strikes
      }, corsHeaders);
    } catch (error) {
      return jsonResponse({ error: 'Virhe haettaessa salamadataa', details: error.message }, corsHeaders, 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const winStart = new Date(now.getTime() - CLUSTER_WINDOW_MIN * 60000);

      // Ikkuna (15 min) > cron-väli (10 min) → yksikään isku ei putoa
      // välistä, oli tila mikä tahansa.
      const fmiResponse = await fetch(buildFmiUrl(winStart, now));
      const strikes = parseXML(await fmiResponse.text()).map(s => ({
        ...s, distance: calculateDistance(OULU_LAT, OULU_LON, s.lat, s.lon)
      }));
      const wakeStrikes = strikes.filter(s => s.distance <= WAKE_RADIUS_KM);
      const stormNear = hasNearbyPair(wakeStrikes, WAKE_PAIR_KM);

      // 0) Lepotila. Jos tilan luku epäonnistuu (esim. taulua ei vielä ole),
      //    ajetaan täysi sykli kuten ennen.
      let state = null;
      try { state = await getState(env); }
      catch (e) { console.error('State read failed, running full cycle:', e.message); }

      if (state) {
        if (!state.mode) {
          state = { mode: 'active', mode_changed_at: nowIso };
          await setState(env, state);
        }

        if (state.mode === 'sleep') {
          if (!stormNear) return; // kevyt tarkistus, ei kirjoituksia
          await setState(env, { mode: 'active', mode_changed_at: nowIso, last_strike_at: nowIso });
          console.log(`Wake: ${wakeStrikes.length} strikes within ${WAKE_RADIUS_KM} km`);
        } else if (stormNear) {
          await setState(env, { last_strike_at: nowIso });
        } else {
          const quietSince = Math.max(
            ...[state.last_strike_at, state.mode_changed_at].filter(Boolean).map(Date.parse), 0);
          if (now.getTime() - quietSince >= SLEEP_AFTER_MIN * 60000) {
            // Solut kiinni, ettei herätessä vanha "active"-solu yhdisty uuteen klusteriin
            await env.STORMS.prepare(`UPDATE cells SET status = 'inactive' WHERE status = 'active'`).run();
            await setState(env, { mode: 'sleep', mode_changed_at: nowIso });
            console.log('Sleep: no storm within radius for ' + SLEEP_AFTER_MIN + ' min');
            return;
          }
        }
      }

      // 1) Push-hälytys
      const nearStrikes = strikes.filter(s => s.distance <= ALERT_RADIUS);
      if (nearStrikes.length > 0) {
        const lastAlert = await env.SUBSCRIPTIONS.get('last_alert_sent');
        const okToAlert = !lastAlert || (Date.now() - Number(lastAlert)) / 60000 >= 90;
        if (okToAlert) {
          const closest = nearStrikes.reduce((a, b) => a.distance < b.distance ? a : b);
          const list = await env.SUBSCRIPTIONS.list({ prefix: 'sub_' });
          for (const key of list.keys) {
            const raw = await env.SUBSCRIPTIONS.get(key.name);
            if (!raw) continue;
            await sendPushNotification(JSON.parse(raw), {
              title: '⚡ Ukkostutka — Salamoita lähellä!',
              body: `${nearStrikes.length} salamaa — lähin ${closest.distance} km päässä Oulusta`,
              url: PRIMARY_ORIGIN
            }, env);
          }
          await env.SUBSCRIPTIONS.put('last_alert_sent', String(Date.now()));
        }
      }

      // 2) Klusterointi
      const centroids = clusterStrikes(strikes, CLUSTER_EPS_KM, CLUSTER_MIN_PTS);

      // 3) Aktiivisten solujen viimeisin sijainti
      const activeRes = await env.STORMS.prepare(
        `SELECT c.id, c.first_seen, c.peak_strikes, t.lat, t.lon, t.timestamp AS ts
         FROM cells c
         JOIN cell_tracks t ON t.cell_id = c.id
         JOIN (SELECT cell_id, MAX(timestamp) mt FROM cell_tracks GROUP BY cell_id) m
           ON m.cell_id = c.id AND m.mt = t.timestamp
         WHERE c.status = 'active'`
      ).all();
      const activeCells = (activeRes.results || []).map(r => ({ ...r, claimed: false }));

      // 4) Yhdistä klusterit soluihin (lähin naapuri)
      for (const ctr of centroids.sort((a, b) => b.count - a.count)) {
        let best = null, bestDist = Infinity;
        for (const cell of activeCells) {
          if (cell.claimed) continue;
          const d = calculateDistance(ctr.lat, ctr.lon, cell.lat, cell.lon);
          if (d < bestDist && d <= MATCH_MAX_KM) { best = cell; bestDist = d; }
        }
        if (best) {
          best.claimed = true;
          const dtH = Math.max((now - new Date(best.ts)) / 3600000, 1 / 60);
          const dir = bearing(best.lat, best.lon, ctr.lat, ctr.lon);
          const spd = Math.round((bestDist / dtH) * 10) / 10;
          await env.STORMS.prepare(
            `INSERT INTO cell_tracks (cell_id, lat, lon, strike_count, direction_deg, speed_kmh, distance_from_oulu, timestamp)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
          ).bind(best.id, ctr.lat, ctr.lon, ctr.count, dir, spd, ctr.distanceFromOulu, nowIso).run();
          await env.STORMS.prepare(
            `UPDATE cells SET last_seen = ?1, peak_strikes = MAX(peak_strikes, ?2) WHERE id = ?3`
          ).bind(nowIso, ctr.count, best.id).run();
        } else {
          const ins = await env.STORMS.prepare(
            `INSERT INTO cells (first_seen, last_seen, status, peak_strikes) VALUES (?1,?1,'active',?2) RETURNING id`
          ).bind(nowIso, ctr.count).first();
          await env.STORMS.prepare(
            `INSERT INTO cell_tracks (cell_id, lat, lon, strike_count, direction_deg, speed_kmh, distance_from_oulu, timestamp)
             VALUES (?1,?2,?3,?4,NULL,NULL,?5,?6)`
          ).bind(ins.id, ctr.lat, ctr.lon, ctr.count, ctr.distanceFromOulu, nowIso).run();
        }
      }

      // 5) Vanhentuneet solut inaktiivisiksi
      const timeoutIso = new Date(now.getTime() - CELL_TIMEOUT_MIN * 60000).toISOString();
      await env.STORMS.prepare(
        `UPDATE cells SET status = 'inactive' WHERE status = 'active' AND last_seen < ?1`
      ).bind(timeoutIso).run();

      // 6) Siivous
      const ttlIso = new Date(now.getTime() - TRACK_TTL_HOURS * 3600000).toISOString();
      await env.STORMS.prepare(`DELETE FROM cell_tracks WHERE timestamp < ?1`).bind(ttlIso).run();
      await env.STORMS.prepare(`DELETE FROM cells WHERE status = 'inactive' AND last_seen < ?1`).bind(ttlIso).run();

    } catch (e) {
      console.error('Cron error:', e.message);
    }
  }
};

function parseXML(xmlText) {
  const strikes = [];
  const positionsMatch = xmlText.match(/<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/);
  if (!positionsMatch) return strikes;
  const posParts = positionsMatch[1].trim().split(/\s+/).map(Number);
  const valuesMatch = xmlText.match(/<gml:doubleOrNilReasonTupleList>([\s\S]*?)<\/gml:doubleOrNilReasonTupleList>/);
  const vals = valuesMatch ? valuesMatch[1].trim().split(/\s+/).map(Number) : [];
  for (let i = 0, idx = 0; i < posParts.length; i += 3, idx++) {
    const v = idx * 4;
    strikes.push({
      lat: posParts[i],
      lon: posParts[i + 1],
      timestamp: posParts[i + 2] ? new Date(posParts[i + 2] * 1000).toISOString() : null,
      cloudIndicator: vals[v],
      multiplicity: vals[v + 1],
      peakCurrent: vals[v + 2],
      ellipseMajor: vals[v + 3],
    });
  }
  return strikes;
}
