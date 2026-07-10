/**
 * Phase 4/6 — our own motion from GPS (expo-location): speed over ground plus
 * current position (position feeds the Phase 6 speed-limit lookup, so we keep a
 * single location subscription rather than two).
 *
 * Returns speed in m/s (never negative) and lat/lng (null until first fix).
 * `hasGps` is false until location permission is granted and a fix arrives.
 * BestForNavigation gives the Doppler-derived `coords.speed` most phones report,
 * which is smoother than differentiating positions ourselves.
 */
import { useEffect, useState } from 'react';
import * as Location from 'expo-location';

export type EgoState = {
  speedMs: number;
  hasGps: boolean;
  lat: number | null;
  lng: number | null;
};

export function useEgoSpeed(): EgoState {
  const [state, setState] = useState<EgoState>({
    speedMs: 0,
    hasGps: false,
    lat: null,
    lng: null,
  });

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 0,
        },
        (loc) => {
          const s = loc.coords.speed;
          setState({
            speedMs: s != null && s > 0 ? s : 0,
            hasGps: true,
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
          });
        },
      );
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  return state;
}
