/**
 * Phase 6 — React glue for the speed-limit cache.
 *
 * Given the live GPS position it (a) fetches/refetches the 25 km window when you
 * enter a new area, and (b) throttles nearest-road lookups to ~1.5 s so we're
 * not hammering SQLite every GPS tick. Returns the current limit (km/h) and a
 * coarse status for the UI.
 */
import { useEffect, useRef, useState } from 'react';
import {
  fetchAndStoreWindow,
  getWindowCenter,
  lookupLimitKmh,
  needsRefetch,
} from './speedLimit';

export type LimitStatus = 'idle' | 'loading' | 'ready' | 'nodata' | 'error';

export function useSpeedLimit(
  lat: number | null,
  lng: number | null,
): { limitKmh: number | null; status: LimitStatus } {
  const [limitKmh, setLimitKmh] = useState<number | null>(null);
  const [status, setStatus] = useState<LimitStatus>('idle');
  const fetchingRef = useRef(false);
  const lastLookupRef = useRef(0);

  useEffect(() => {
    if (lat == null || lng == null) return;
    let cancelled = false;

    (async () => {
      try {
        // (a) Window management — fetch a fresh window if we've moved out of range.
        const center = await getWindowCenter();
        if (needsRefetch(lat, lng, center) && !fetchingRef.current) {
          fetchingRef.current = true;
          setStatus('loading');
          try {
            const n = await fetchAndStoreWindow(lat, lng);
            console.log(`[speedLimit] cached ${n} segments around ${lat},${lng}`);
          } catch (e) {
            console.log('[speedLimit] fetch failed:', String(e));
            throw e;
          } finally {
            fetchingRef.current = false;
          }
        }

        // (b) Throttled nearest-road lookup.
        const now = Date.now();
        if (now - lastLookupRef.current >= 1500) {
          lastLookupRef.current = now;
          const l = await lookupLimitKmh(lat, lng);
          if (!cancelled) {
            setLimitKmh(l);
            setStatus(l == null ? 'nodata' : 'ready');
          }
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  return { limitKmh, status };
}
