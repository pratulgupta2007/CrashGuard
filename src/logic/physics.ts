/**
 * Physics-based brake score (0-10) for the nearest object ahead.
 *
 * Takes the worse of two dangers:
 *   1. Stopping distance (reaction time + braking) as a fraction of the gap
 *      ahead. A large fraction is dangerous even if nothing is moving.
 *   2. Time-to-collision, when the gap is actually shrinking.
 *
 * 0 = clear/stopped, 10 = brake now. Pure functions, no camera/GPS deps.
 */

// Driver reaction time before the brakes engage (seconds).
export const REACTION_TIME_S = 1.2;

// Emergency deceleration on a dry road (m/s^2), roughly 0.7 g.
export const BRAKE_DECEL_MS2 = 7.0;

// TTC urgency band (seconds): <= MIN is full urgency, >= MAX is none.
export const TTC_MIN_S = 1.5;
export const TTC_MAX_S = 6.0;

export type BrakeReason = 'clear' | 'following' | 'closing' | 'imminent';

export type BrakeAssessment = {
  score: number; // 0..10 (one decimal)
  stoppingDistanceM: number; // road needed to stop at ego speed
  ttcS: number | null; // time-to-collision, null when not closing
  reason: BrakeReason;
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Distance (m) to a full stop from speedMs, incl. reaction creep:
// d = v*t_react + v^2 / (2a).
export function stoppingDistanceM(speedMs: number): number {
  if (speedMs <= 0) return 0;
  return (
    speedMs * REACTION_TIME_S + (speedMs * speedMs) / (2 * BRAKE_DECEL_MS2)
  );
}

// Time-to-collision (s) from the gap and how fast it's shrinking.
// null when not closing (object stationary or receding).
export function timeToCollisionS(
  distanceM: number,
  closingSpeedMs: number,
): number | null {
  if (closingSpeedMs <= 0) return null;
  return distanceM / closingSpeedMs;
}

// Combined brake score for the nearest object ahead.
//   egoSpeedMs     speed over ground (m/s), >= 0
//   distanceM      gap to the object ahead (m)
//   closingSpeedMs rate the gap is shrinking (m/s); <= 0 means not closing
export function brakeScore(
  egoSpeedMs: number,
  distanceM: number,
  closingSpeedMs: number,
): BrakeAssessment {
  const dStop = stoppingDistanceM(egoSpeedMs);

  // Stopping-distance pressure.
  const gap = Math.max(distanceM, 0.01);
  const s1 = clamp((dStop / gap) * 10, 0, 10);

  // Time-to-collision urgency (only when the gap is closing).
  const ttc = timeToCollisionS(distanceM, closingSpeedMs);
  const s2 =
    ttc == null
      ? 0
      : clamp(((TTC_MAX_S - ttc) / (TTC_MAX_S - TTC_MIN_S)) * 10, 0, 10);

  const raw = Math.max(s1, s2);
  const score = Math.round(raw * 10) / 10;

  let reason: BrakeReason;
  if (raw >= 8) reason = 'imminent';
  else if (ttc != null && s2 >= s1) reason = 'closing';
  else if (raw >= 3) reason = 'following';
  else reason = 'clear';

  return { score, stoppingDistanceM: dStop, ttcS: ttc, reason };
}
