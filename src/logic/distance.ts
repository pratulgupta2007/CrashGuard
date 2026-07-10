/**
 * Monocular distance estimation from a detection's box height (pinhole model).
 *
 *   distance = focal_px * realHeight_m / boxHeight_px
 *
 * With focal_px = (frameH/2)/tan(vFOV/2) and boxHeight_px = normHeight*frameH,
 * the frame height cancels:
 *
 *   distance = realHeight_m / (2 * tan(vFOV/2) * normHeight)
 *
 * so the estimate is resolution-independent and the only thing to calibrate is
 * the camera's vertical field of view.
 */
import { CLASS_REAL_HEIGHT_M } from '../constants/classes';

// Default vertical FOV of the back camera in landscape 16:9 (degrees). Typical
// for a phone main camera; tune per-device on the calibration screen. Larger
// FOV reports a smaller distance.
export const VERTICAL_FOV_DEG = 40;

// Distance (m) to a detection from its normalized box height (ymax - ymin, a
// fraction of frame height 0..1). null when the class has no known height or the
// box is degenerate.
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

// Compact distance label, e.g. "0.8m", "12m", "1.4km".
export function formatDistance(m: number): string {
  if (m < 10) return `${m.toFixed(1)}m`;
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(1)}km`;
}
