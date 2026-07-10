/**
 * Phase 3 — monocular distance estimation.
 *
 * We use the pinhole model with a known real-world object height:
 *
 *   distance = focal_px * realHeight_m / boxHeight_px
 *
 * The vertical focal length in pixels is  focal_px = (frameH_px/2) / tan(vFOV/2),
 * and a detection's pixel height is  boxHeight_px = normHeight * frameH_px, so
 * frameH_px cancels entirely:
 *
 *   distance = realHeight_m / (2 * tan(vFOV/2) * normHeight)
 *
 * That makes the estimate resolution-independent — the ONLY thing to calibrate
 * is the camera's vertical field of view. This is the same "box height as a
 * distance proxy" idea from the original 2022 project, but converted to metres.
 */
import { CLASS_REAL_HEIGHT_M } from '../constants/classes';

/**
 * Vertical field-of-view of the back camera, in degrees, for the frame aspect
 * we detect on (landscape 16:9). ~40° is typical for a phone main camera.
 *
 * CALIBRATE ON-DEVICE: stand a known object (e.g. a person 1.7 m tall) at a
 * measured distance (say 5 m), read the on-screen estimate, and nudge this
 * value until it matches — larger FOV → smaller reported distance.
 */
export const VERTICAL_FOV_DEG = 40;

/**
 * Estimate distance (metres) to a detection from its normalized box height
 * (ymax - ymin, a fraction of frame height, 0..1). `vFovDeg` is the calibrated
 * vertical field of view (see the calibration screen). Returns null when the
 * class has no known real height or the box is degenerate.
 */
export function estimateDistanceM(
  cls: number,
  normBoxHeight: number,
  vFovDeg: number = VERTICAL_FOV_DEG,
): number | null {
  const realH = CLASS_REAL_HEIGHT_M[cls];
  if (realH == null || normBoxHeight <= 0) return null;
  const tanHalf = Math.tan((vFovDeg * Math.PI) / 360);
  return realH / (2 * tanHalf * normBoxHeight);
}

/** Compact human-readable distance, e.g. "0.8m", "12m", "140m". */
export function formatDistance(m: number): string {
  if (m < 10) return `${m.toFixed(1)}m`;
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}
