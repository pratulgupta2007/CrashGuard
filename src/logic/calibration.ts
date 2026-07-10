/**
 * User calibration — lane-zone boundaries and camera vertical FOV — persisted
 * on-device with expo-sqlite so it survives restarts. Tuned from the in-app
 * calibration screen.
 *
 *   zoneLeft / zoneRight : FRAME-normalized x (0..1) of the two lane dividers.
 *                          A detection whose centre-x is < zoneLeft is LEFT,
 *                          > zoneRight is RIGHT, otherwise FRONT.
 *   vFovDeg              : vertical field of view used by the pinhole distance
 *                          model (src/logic/distance.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import * as SQLite from 'expo-sqlite';

export type Calibration = {
  zoneLeft: number;
  zoneRight: number;
  vFovDeg: number;
};

export const DEFAULT_CALIBRATION: Calibration = {
  zoneLeft: 0.381,
  zoneRight: 0.599,
  vFovDeg: 40,
};

export const VFOV_MIN = 25;
export const VFOV_MAX = 90;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbPromise == null) {
    dbPromise = SQLite.openDatabaseAsync('adas_settings.db').then(async (db) => {
      await db.execAsync(
        'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);',
      );
      return db;
    });
  }
  return dbPromise;
}

async function loadCalibration(): Promise<Calibration> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ k: string; v: string }>(
    'SELECT k, v FROM settings',
  );
  const cal: Calibration = { ...DEFAULT_CALIBRATION };
  for (const r of rows) {
    if (r.k in cal) {
      const n = parseFloat(r.v);
      if (Number.isFinite(n)) (cal as Record<string, number>)[r.k] = n;
    }
  }
  return cal;
}

async function saveCalibration(cal: Calibration): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const k of Object.keys(cal) as (keyof Calibration)[]) {
      await db.runAsync('INSERT OR REPLACE INTO settings(k, v) VALUES (?, ?)', [
        k,
        String(cal[k]),
      ]);
    }
  });
}

// Persistence is debounced so dragging a slider doesn't hammer SQLite.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(cal: Calibration): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveCalibration(cal).catch(() => {});
  }, 400);
}

export function useCalibration(): {
  cal: Calibration;
  update: (patch: Partial<Calibration>) => void;
  reset: () => void;
  loaded: boolean;
} {
  const [cal, setCal] = useState<Calibration>(DEFAULT_CALIBRATION);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadCalibration()
      .then((c) => setCal(c))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const update = useCallback((patch: Partial<Calibration>) => {
    setCal((prev) => {
      const next = { ...prev, ...patch };
      scheduleSave(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setCal(DEFAULT_CALIBRATION);
    scheduleSave(DEFAULT_CALIBRATION);
  }, []);

  return { cal, update, reset, loaded };
}
