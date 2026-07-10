/**
 * Phase 4 — physics-based brake score (0..10).
 *
 * The original 2022 project turned "how big is the box" into a crude braking
 * level. Here we do it properly with real kinematics, combining TWO independent
 * dangers and taking the worst:
 *
 *   1. Stopping distance  — at your current speed, how much road do you need to
 *      come to a stop (reaction time + braking)? If that's a big fraction of the
 *      gap to the object ahead, you're in trouble even if nothing is moving.
 *
 *   2. Time-to-collision  — if the gap is shrinking, how many seconds until
 *      impact at the current closing speed? Small TTC = urgent.
 *
 * score 0  = clear road / stopped;  score 10 = brake NOW (can't stop in the gap,
 * or impact is imminent). Everything here is a pure function of numbers so it's
 * trivially testable and independent of camera/GPS plumbing.
 */

/** Driver reaction time before the brakes actually engage (seconds). */
export const REACTION_TIME_S = 1.2;

/** Emergency deceleration on a typical dry road (m/s²) — about 0.7 g. */
export const BRAKE_DECEL_MS2 = 7.0;

/** TTC urgency band (seconds): ≤ MIN → full urgency, ≥ MAX → none. */
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

/**
 * Distance (metres) to come to a full stop from `speedMs`, including the
 * reaction-time creep: d = v·t_react + v²/(2a).
 */
export function stoppingDistanceM(speedMs: number): number {
  if (speedMs <= 0) return 0;
  return (
    speedMs * REACTION_TIME_S + (speedMs * speedMs) / (2 * BRAKE_DECEL_MS2)
  );
}

/**
 * Time-to-collision (seconds) given the gap and how fast it's shrinking.
 * Returns null when not closing (object stationary relative to us or receding).
 */
export function timeToCollisionS(
  distanceM: number,
  closingSpeedMs: number,
): number | null {
  if (closingSpeedMs <= 0) return null;
  return distanceM / closingSpeedMs;
}

/**
 * Combined brake score for the nearest object ahead.
 *
 * @param egoSpeedMs      our own speed over ground (m/s), ≥ 0
 * @param distanceM       gap to the object ahead (m)
 * @param closingSpeedMs  rate the gap is shrinking (m/s); ≤ 0 means not closing
 */
export function brakeScore(
  egoSpeedMs: number,
  distanceM: number,
  closingSpeedMs: number,
): BrakeAssessment {
  const dStop = stoppingDistanceM(egoSpeedMs);

  // Sub-score 1 — stopping-distance pressure. A small safety buffer (2 m) keeps
  // us from screaming when we're already stopped right behind something.
  const gap = Math.max(distanceM, 0.01);
  const s1 = clamp((dStop / gap) * 10, 0, 10);

  // Sub-score 2 — time-to-collision urgency (only when the gap is closing).
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
