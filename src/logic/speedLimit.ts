/**
 * Offline speed-limit cache and lookup.
 *
 * On boot, and whenever you drive out of the cached window, pull every road with
 * a `maxspeed` tag within WINDOW_RADIUS_KM from OpenStreetMap's Overpass API,
 * split each road into straight segments, and store them in SQLite keyed by a
 * coarse lat/lng grid cell. Lookups then scan the current cell plus its 8
 * neighbours and take the nearest segment. No network while driving.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'adas_speed.db';

// Radius of each cached window (km).
export const WINDOW_RADIUS_KM = 25;
// Refetch once within this of the window edge, so the next window is ready.
const REFETCH_MARGIN_KM = 5;
// Spatial-index grid cell size in degrees (~2.2 km). Lookups scan cell + 8 neighbours.
const CELL_DEG = 0.02;
// Max perpendicular distance to count as "on" a road (m). Wide enough for
// multi-lane roads and GPS drift, tight enough not to snap to a parallel street.
const MATCH_MAX_M = 60;
// Overpass mirrors, tried in order. The main .de endpoint frequently 504s/406s
// on heavy queries and kumi can time out, so mail.ru is tried first.
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
// Per-mirror timeout before falling through (ms).
const FETCH_TIMEOUT_MS = 45000;

type SegRow = {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  maxspeed: number;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbPromise == null) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS segments (
          cell TEXT, lat1 REAL, lng1 REAL, lat2 REAL, lng2 REAL, maxspeed REAL
        );
        CREATE INDEX IF NOT EXISTS idx_seg_cell ON segments(cell);
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      `);
      return db;
    });
  }
  return dbPromise;
}

function cellKey(lat: number, lng: number): string {
  return `${Math.round(lat / CELL_DEG)}:${Math.round(lng / CELL_DEG)}`;
}

/** Great-circle distance in km (haversine). */
export function distKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Perpendicular distance (m) from point P to segment A-B, equirectangular. */
function pointSegMeters(
  pLat: number,
  pLng: number,
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((pLat * Math.PI) / 180);
  const ax = (aLng - pLng) * mLng;
  const ay = (aLat - pLat) * mLat;
  const bx = (bLng - pLng) * mLng;
  const by = (bLat - pLat) * mLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

/**
 * Parse an OSM maxspeed tag into km/h. Handles "50", "30 mph", "50 km/h".
 * Returns null for non-numeric values ("none", "walk", "signals", …).
 */
export function parseMaxspeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /mph/i.test(v) ? n * 1.60934 : n;
}

/** POST the query to each mirror in turn until one returns 200 (or all fail). */
async function overpassFetch(query: string): Promise<Response> {
  let lastErr: unknown = new Error('no mirrors');
  for (const url of OVERPASS_MIRRORS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'CrashGuard/1.0 (on-device speed-limit cache)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (res.ok) return res;
      lastErr = new Error(`${url} → ${res.status}`);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Fetch the window around (lat,lng) from Overpass and replace the cache. */
export async function fetchAndStoreWindow(
  lat: number,
  lng: number,
): Promise<number> {
  const query = `[out:json][timeout:60];way["highway"]["maxspeed"](around:${
    WINDOW_RADIUS_KM * 1000
  },${lat},${lng});out geom;`;
  const res = await overpassFetch(query);
  const json = (await res.json()) as {
    elements?: Array<{
      type: string;
      tags?: { maxspeed?: string };
      geometry?: Array<{ lat: number; lon: number }>;
    }>;
  };

  // Flatten every way into straight segments with a parsed limit.
  const rows: Array<[string, number, number, number, number, number]> = [];
  for (const el of json.elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const ms = parseMaxspeed(el.tags?.maxspeed);
    if (ms == null) continue;
    const g = el.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i];
      const b = g[i + 1];
      rows.push([
        cellKey((a.lat + b.lat) / 2, (a.lon + b.lon) / 2),
        a.lat,
        a.lon,
        b.lat,
        b.lon,
        ms,
      ]);
    }
  }

  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.execAsync('DELETE FROM segments;');
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?)').join(',');
      const flat = chunk.flat();
      await db.runAsync(
        `INSERT INTO segments(cell,lat1,lng1,lat2,lng2,maxspeed) VALUES ${placeholders}`,
        flat as (string | number)[],
      );
    }
    await db.runAsync('INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)', [
      'center',
      `${lat},${lng}`,
    ]);
  });
  return rows.length;
}

/** Centre of the currently cached window, or null if nothing cached yet. */
export async function getWindowCenter(): Promise<{
  lat: number;
  lng: number;
} | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ v: string }>(
    'SELECT v FROM meta WHERE k = ?',
    ['center'],
  );
  if (!row) return null;
  const [la, ln] = row.v.split(',').map(Number);
  return { lat: la, lng: ln };
}

/** Speed limit (km/h) for the nearest cached road to (lat,lng), or null. */
export async function lookupLimitKmh(
  lat: number,
  lng: number,
): Promise<number | null> {
  const db = await getDb();
  const baseLa = Math.round(lat / CELL_DEG);
  const baseLo = Math.round(lng / CELL_DEG);
  const keys: string[] = [];
  for (let dLa = -1; dLa <= 1; dLa++)
    for (let dLo = -1; dLo <= 1; dLo++)
      keys.push(`${baseLa + dLa}:${baseLo + dLo}`);

  const ph = keys.map(() => '?').join(',');
  const segs = await db.getAllAsync<SegRow>(
    `SELECT lat1,lng1,lat2,lng2,maxspeed FROM segments WHERE cell IN (${ph})`,
    keys,
  );
  let best = Infinity;
  let bestMs: number | null = null;
  for (const s of segs) {
    const d = pointSegMeters(lat, lng, s.lat1, s.lng1, s.lat2, s.lng2);
    if (d < best) {
      best = d;
      bestMs = s.maxspeed;
    }
  }
  return best <= MATCH_MAX_M ? bestMs : null;
}

/** True when the point is far enough from the cached centre to warrant a refetch. */
export function needsRefetch(
  lat: number,
  lng: number,
  center: { lat: number; lng: number } | null,
): boolean {
  if (center == null) return true;
  return distKm(lat, lng, center.lat, center.lng) > WINDOW_RADIUS_KM - REFETCH_MARGIN_KM;
}
