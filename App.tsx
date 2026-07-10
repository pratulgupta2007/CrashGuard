/**
 * Main screen: camera preview, on-device detection, and the driving HUD.
 *
 * Pipeline (all on-device):
 *   VisionCamera frame -> useFrameOutput worklet
 *     -> letterbox to 320x320x3 float32 -> fast-tflite YOLOv8n (CPU)
 *     -> decode boxes/classes/scores (NMS) -> runOnJS -> React state -> overlay
 *
 * Each detection gets a lane zone (LEFT / FRONT / RIGHT) and a metric distance
 * from its box height (see src/logic/distance.ts). The nearest object in the
 * FRONT corridor drives the brake score and audio alert.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
} from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { runOnJS } from 'react-native-worklets';
import { Asset } from 'expo-asset';

import { RELEVANT_CLASS_IDS, labelFor } from './src/constants/classes';
import { estimateDistanceM, formatDistance } from './src/logic/distance';
import { brakeScore, type BrakeAssessment } from './src/logic/physics';
import { useEgoSpeed } from './src/logic/useEgoSpeed';
import { useBrakeAlert } from './src/logic/useBrakeAlert';
import { useSpeedLimit } from './src/logic/useSpeedLimit';
import { useCalibration } from './src/logic/calibration';
import CalibrationScreen from './src/components/CalibrationScreen';

const MODEL = require('./assets/models/yolov8n.tflite');

const INPUT_SIZE = 320;
const NUM_ANCHORS = 2100; // YOLOv8n @ 320px: 40² + 20² + 10²
const NUM_CLASSES = 80;
const MAX_DETECTIONS = 25;
const SCORE_THRESHOLD = 0.4;
const IOU_THRESHOLD = 0.45; // non-max suppression overlap

// Debug: draw every detected class (not just road-relevant ones). Set true to
// bring-up/verify indoors with household objects; false for real driving, where
// we only care about vehicles, people, bikes and animals (RELEVANT_CLASS_IDS).
const DEBUG_SHOW_ALL = false;

// Lane-zone boundaries live in calibration state now (src/logic/calibration.ts)
// so they can be dragged on the calibration screen and persisted.

type RawDetection = {
  cls: number;
  score: number;
  // normalized box in model-input space (0..1)
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
};

type Zone = 'LEFT' | 'FRONT' | 'RIGHT';

function zoneForCenterX(cx: number, left: number, right: number): Zone {
  if (cx < left) return 'LEFT';
  if (cx > right) return 'RIGHT';
  return 'FRONT';
}

// Traffic-light coloring for the brake score (0..10).
function scoreColor(s: number): string {
  if (s >= 8) return '#ff3b30'; // red: brake now
  if (s >= 6) return '#ff9f0a'; // orange
  if (s >= 3) return '#ffd60a'; // yellow: following too close
  return '#30d158'; // green: safe
}

export default function App() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const device = useCameraDevice('back');

  // Resolve the model to a real file:// URI before handing it to fast-tflite.
  // fast-tflite's native loader does `URL(uri).readBytes()`, which only accepts
  // a scheme java.net.URL understands. In dev, require() resolves to a Metro
  // http URL (fine), but in a standalone release build it resolves to a bare
  // Android resource name that URL() can't parse, so the model fails to load
  // ("model: error"). expo-asset copies the bundled model to the cache and
  // gives a file:// path that works in both dev and release.
  const [modelSource, setModelSource] =
    useState<Parameters<typeof useTensorflowModel>[0]>(MODEL);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const asset = Asset.fromModule(MODEL);
        if (!asset.localUri) await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (!cancelled && uri) setModelSource({ url: uri });
      } catch (e) {
        console.log('[model] asset resolve failed:', String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE: the 'android-gpu' delegate produces NaN outputs for this float32 YOLOv8
  // model, so we run on CPU (XNNPACK). Revisit with an int8/GPU-friendly export.
  const { model, state } = useTensorflowModel(modelSource, []);

  const [detections, setDetections] = useState<RawDetection[]>([]);
  const [frameDims, setFrameDims] = useState({ w: 1280, h: 720 });
  const [diag, setDiag] = useState<string>('starting…');
  const { speedMs: egoSpeedMs, hasGps, lat, lng } = useEgoSpeed();
  const { limitKmh, status: limitStatus } = useSpeedLimit(lat, lng);
  const { cal, update: updateCal, reset: resetCal } = useCalibration();
  const [closingMs, setClosingMs] = useState(0);
  const [screen, setScreen] = useState<'main' | 'calibrate'>('main');
  const lastFrontRef = useRef<{ d: number; t: number } | null>(null);

  // Overspeed = more than 10% over the current road's posted limit.
  const egoSpeedKmh = egoSpeedMs * 3.6;
  const overspeed = limitKmh != null && egoSpeedKmh > limitKmh * 1.1;

  // Road-relevant detections, each enriched with lane zone + metric distance.
  // Computed every render (pure) so the effects below can watch nearestFront.
  const visible = DEBUG_SHOW_ALL
    ? detections
    : detections.filter((d) => RELEVANT_CLASS_IDS.has(d.cls));
  const objects = visible.map((d) => {
    const cx = (d.xmin + d.xmax) / 2;
    return {
      ...d,
      zone: zoneForCenterX(cx, cal.zoneLeft, cal.zoneRight),
      distanceM: estimateDistanceM(d.cls, d.ymax - d.ymin, cal.vFovDeg),
    };
  });
  // Nearest object in the FRONT corridor; this is what the brake score reacts to.
  let nearestFront: (typeof objects)[number] | null = null;
  for (const o of objects) {
    if (o.zone !== 'FRONT' || o.distanceM == null) continue;
    if (nearestFront == null || o.distanceM < nearestFront.distanceM!) {
      nearestFront = o;
    }
  }
  const frontDist = nearestFront?.distanceM ?? null;

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // Track how fast the gap to the nearest front object is shrinking (m/s).
  // Monocular distance is noisy, so low-pass the derivative. Positive = closing.
  useEffect(() => {
    const now = Date.now();
    if (frontDist == null) {
      lastFrontRef.current = null;
      setClosingMs(0);
      return;
    }
    const prev = lastFrontRef.current;
    if (prev != null) {
      const dt = (now - prev.t) / 1000;
      if (dt >= 0.05) {
        const closing = (prev.d - frontDist) / dt;
        setClosingMs((c) => c * 0.6 + closing * 0.4);
      }
    }
    lastFrontRef.current = { d: frontDist, t: now };
  }, [frontDist]);

  // Brake score for the nearest object ahead, and the audio alert it drives.
  // Both must sit above the early returns (Rules of Hooks); the score is a pure
  // function, so recomputing each render is cheap.
  const assess: BrakeAssessment | null =
    frontDist != null ? brakeScore(egoSpeedMs, frontDist, closingMs) : null;
  useBrakeAlert(assess?.score ?? 0, overspeed, state === 'loaded');

  // One-time: log how fast-tflite sees the model's tensors (dtype/shape).
  useEffect(() => {
    if (model != null) {
      console.log('MODEL inputs:', JSON.stringify(model.inputs));
      console.log('MODEL outputs:', JSON.stringify(model.outputs));
    }
  }, [model]);

  // Called from the frame-processor worklet with each frame's results.
  const onResults = useCallback(
    (dets: RawDetection[], info: string, fw: number, fh: number) => {
      setDetections(dets);
      setDiag(info);
      setFrameDims({ w: fw, h: fh });
    },
    [],
  );

  const frameOutput = useFrameOutput({
    // Use YUV: on VisionCamera 5.1.0 the RGB path's getPixelBuffer() reports a
    // byteLength of w*h instead of w*h*4, exposing only the top ~1/4 of the
    // frame. The Y (luminance) plane is correctly sized w*h, so we read it for
    // full-frame grayscale detection (YOLO detects shapes fine without color).
    pixelFormat: 'yuv',
    dropFramesWhileBusy: true,
    onFrame: (frame) => {
      'worklet';
      try {
        if (model == null) {
          frame.dispose();
          return;
        }

        const yPlane = frame.getPlanes()[0]; // Y (luminance) plane, full-res
        const bpr = yPlane.bytesPerRow; // Y row stride (may be padded)
        const src = new Uint8Array(yPlane.getPixelBuffer()); // 1 byte/px grayscale
        const sw = yPlane.width; // source width  (e.g. 1280)
        const sh = yPlane.height; // source height (e.g. 720)

        // Orientation-aware un-rotation into an UPRIGHT image. We map each upright
        // pixel (uX,uY) to a source (col,row) via an affine transform that depends
        // on frame.orientation, so it works in both portrait ('left') and
        // landscape ('up'). uw×uh are the upright dimensions.
        const ori = frame.orientation;
        let fw: number, fh: number; // upright width/height
        let ca: number, cb: number, cc: number; // col = ca*uX + cb*uY + cc
        let ra: number, rb: number, rc: number; // row = ra*uX + rb*uY + rc
        if (ori === 'left') {
          fw = sh; fh = sw;
          ca = 0; cb = 1; cc = 0; ra = -1; rb = 0; rc = sh - 1;
        } else if (ori === 'right') {
          fw = sh; fh = sw;
          ca = 0; cb = -1; cc = sw - 1; ra = 1; rb = 0; rc = 0;
        } else if (ori === 'down') {
          fw = sw; fh = sh;
          ca = -1; cb = 0; cc = sw - 1; ra = 0; rb = -1; rc = sh - 1;
        } else {
          // 'up': no rotation (landscape sensor aligned with landscape screen)
          fw = sw; fh = sh;
          ca = 1; cb = 0; cc = 0; ra = 0; rb = 1; rc = 0;
        }

        // Letterbox the UPRIGHT image into 320x320 preserving aspect (YOLO uses
        // 114-gray padding; input is float32 [0,1]). Grayscale, so R=G=B.
        const input = new Float32Array(INPUT_SIZE * INPUT_SIZE * 3);
        input.fill(114 / 255); // neutral padding
        const fitScale =
          INPUT_SIZE / fw < INPUT_SIZE / fh ? INPUT_SIZE / fw : INPUT_SIZE / fh;
        const contentW = (fw * fitScale) | 0;
        const contentH = (fh * fitScale) | 0;
        const padX = ((INPUT_SIZE - contentW) / 2) | 0;
        const padY = ((INPUT_SIZE - contentH) / 2) | 0;
        const invF = 1 / fitScale;
        for (let cy = 0; cy < contentH; cy++) {
          const uY = (cy * invF) | 0; // upright row
          const dBase = ((cy + padY) * INPUT_SIZE + padX) * 3;
          for (let cx = 0; cx < contentW; cx++) {
            const uX = (cx * invF) | 0; // upright col
            const col = ca * uX + cb * uY + cc;
            const row = ra * uX + rb * uY + rc;
            const g = src[row * bpr + col] / 255; // 1 byte/px
            const di = dBase + cx * 3;
            input[di] = g; // R
            input[di + 1] = g; // G
            input[di + 2] = g; // B
          }
        }

        // YOLOv8 output: [1, 84, 2100] row-major = 84 rows (cx,cy,w,h + 80 class
        // scores) × 2100 anchors. bbox is normalized to the 320 canvas; class
        // scores are already sigmoid'd. Value at row r, anchor a = out[r*A + a].
        const outputs = model.runSync([input.buffer]);
        const out = new Float32Array(outputs[0]);
        const A = NUM_ANCHORS;

        // 1) Gather candidates above threshold (best class per anchor), as xyxy
        //    in canvas-normalized [0,1].
        const cand: RawDetection[] = [];
        for (let a = 0; a < A; a++) {
          let best = 0;
          let bestScore = out[4 * A + a];
          for (let c = 1; c < NUM_CLASSES; c++) {
            const v = out[(4 + c) * A + a];
            if (v > bestScore) {
              bestScore = v;
              best = c;
            }
          }
          if (bestScore < SCORE_THRESHOLD) continue;
          const cx = out[a];
          const cy = out[A + a];
          const hw = out[2 * A + a] * 0.5;
          const hh = out[3 * A + a] * 0.5;
          cand.push({
            cls: best,
            score: bestScore,
            xmin: cx - hw,
            ymin: cy - hh,
            xmax: cx + hw,
            ymax: cy + hh,
          });
        }

        // 2) Greedy non-max suppression (class-agnostic), in canvas space.
        cand.sort((p, q) => q.score - p.score);
        const keep: RawDetection[] = [];
        for (let i = 0; i < cand.length; i++) {
          const ci = cand[i];
          let drop = false;
          for (let j = 0; j < keep.length; j++) {
            const kj = keep[j];
            const ix = ci.xmin > kj.xmin ? ci.xmin : kj.xmin;
            const iy = ci.ymin > kj.ymin ? ci.ymin : kj.ymin;
            const ax = ci.xmax < kj.xmax ? ci.xmax : kj.xmax;
            const ay = ci.ymax < kj.ymax ? ci.ymax : kj.ymax;
            const iw = ax - ix;
            const ih = ay - iy;
            if (iw > 0 && ih > 0) {
              const inter = iw * ih;
              const ua =
                (ci.xmax - ci.xmin) * (ci.ymax - ci.ymin) +
                (kj.xmax - kj.xmin) * (kj.ymax - kj.ymin) -
                inter;
              if (ua > 0 && inter / ua > IOU_THRESHOLD) {
                drop = true;
                break;
              }
            }
          }
          if (!drop) {
            keep.push(ci);
            if (keep.length >= MAX_DETECTIONS) break;
          }
        }

        // 3) Un-letterbox kept boxes from the padded canvas into frame-normalized [0,1].
        const invW = 1 / contentW;
        const invH = 1 / contentH;
        const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
        const dets: RawDetection[] = [];
        for (let i = 0; i < keep.length; i++) {
          const k = keep[i];
          dets.push({
            cls: k.cls,
            score: k.score,
            xmin: clamp01((k.xmin * INPUT_SIZE - padX) * invW),
            ymin: clamp01((k.ymin * INPUT_SIZE - padY) * invH),
            xmax: clamp01((k.xmax * INPUT_SIZE - padX) * invW),
            ymax: clamp01((k.ymax * INPUT_SIZE - padY) * invH),
          });
        }

        const t = dets.length
          ? `${dets[0].cls}@${dets[0].score.toFixed(2)} [${dets[0].xmin.toFixed(2)},${dets[0].ymin.toFixed(2)},${dets[0].xmax.toFixed(2)},${dets[0].ymax.toFixed(2)}]`
          : '-';
        const info = `Y=${sw}x${sh} ylen=${src.length} n=${dets.length} top=${dets.length ? dets[0].cls + '@' + dets[0].score.toFixed(2) : '-'}`;
        runOnJS(onResults)(dets, info, fw, fh);
        frame.dispose();
      } catch (e) {
        runOnJS(onResults)([], 'ERR ' + String(e), INPUT_SIZE, INPUT_SIZE);
        frame.dispose();
      }
    },
  });

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <StatusBar style="light" />
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.subtitle}>ADAS watches the road ahead.</Text>
        <Pressable style={styles.button} onPress={() => requestPermission()}>
          <Text style={styles.buttonText}>Grant permission</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openSettings()}>
          <Text style={styles.link}>Open Settings</Text>
        </Pressable>
      </View>
    );
  }

  if (device == null) {
    return (
      <View style={styles.centered}>
        <StatusBar style="light" />
        <Text style={styles.title}>No back camera found</Text>
      </View>
    );
  }

  // Map normalized frame coords to screen pixels, honoring the preview's 'cover'
  // crop (frame is scaled to fill the screen and centered; edges are clipped).
  const scale = Math.max(SCREEN_W / frameDims.w, SCREEN_H / frameDims.h);
  const dispW = frameDims.w * scale;
  const dispH = frameDims.h * scale;
  const offX = (SCREEN_W - dispW) / 2;
  const offY = (SCREEN_H - dispH) / 2;
  const mapX = (nx: number) => offX + nx * dispW;
  const mapY = (ny: number) => offY + ny * dispH;
  const unmapX = (x: number) => (dispW > 0 ? (x - offX) / dispW : 0);

  const calibrating = screen === 'calibrate';

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        outputs={[frameOutput]}
        isActive={true}
        resizeMode="cover"
      />

      {calibrating ? (
        <CalibrationScreen
          cal={cal}
          onChange={updateCal}
          onReset={resetCal}
          onClose={() => setScreen('main')}
          mapX={mapX}
          unmapX={unmapX}
          mapY={mapY}
          dispW={dispW}
          dispH={dispH}
          objects={objects}
          screenW={SCREEN_W}
        />
      ) : (
        <MainOverlay />
      )}
    </View>
  );

  // The normal driving HUD (extracted so the return stays readable).
  function MainOverlay() {
    return (
      <>
      {/* Lane-zone guides (mapped through the same crop transform) */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={[styles.zoneLine, { left: mapX(cal.zoneLeft) }]} />
        <View style={[styles.zoneLine, { left: mapX(cal.zoneRight) }]} />
      </View>

      {/* Detection boxes */}
      <View style={styles.overlay} pointerEvents="none">
        {objects.map((d, i) => {
          const color =
            d.zone === 'FRONT'
              ? '#ff3b30'
              : d.zone === 'LEFT'
                ? '#ffd60a'
                : '#0a84ff';
          const left = mapX(d.xmin);
          const top = mapY(d.ymin);
          const w = (d.xmax - d.xmin) * dispW;
          const h = (d.ymax - d.ymin) * dispH;
          const isNearest = d === nearestFront;
          const dist = d.distanceM != null ? ` · ${formatDistance(d.distanceM)}` : '';
          return (
            <View
              key={i}
              style={[
                styles.box,
                {
                  left,
                  top,
                  width: w,
                  height: h,
                  borderColor: color,
                  borderWidth: isNearest ? 4 : 2,
                },
              ]}
            >
              <Text style={[styles.boxLabel, { backgroundColor: color }]}>
                {labelFor(d.cls)} {Math.round(d.score * 100)}%{dist}
              </Text>
            </View>
          );
        })}
      </View>

      {/* Banner */}
      <View style={styles.banner} pointerEvents="none">
        <Text style={styles.bannerText}>
          {state !== 'loaded'
            ? `CrashGuard · model: ${state}`
            : nearestFront != null
              ? `AHEAD · ${labelFor(nearestFront.cls)} · ${formatDistance(nearestFront.distanceM!)}`
              : 'CrashGuard · road clear'}
        </Text>
      </View>

      {/* HUD: speed, speed-limit sign, and brake score meter */}
      <View style={styles.hud} pointerEvents="none">
        <View style={styles.hudTopRow}>
          <Text style={[styles.hudSpeed, overspeed && styles.hudSpeedOver]}>
            {hasGps ? Math.round(egoSpeedKmh) : '--'}
            <Text style={styles.hudUnit}> km/h</Text>
          </Text>
          <View style={styles.limitSign}>
            <Text style={styles.limitNum}>
              {limitKmh != null ? Math.round(limitKmh) : '--'}
            </Text>
          </View>
        </View>
        <View style={styles.meterTrack}>
          <View
            style={[
              styles.meterFill,
              {
                width: `${(assess?.score ?? 0) * 10}%`,
                backgroundColor: scoreColor(assess?.score ?? 0),
              },
            ]}
          />
        </View>
        <Text style={[styles.hudScore, { color: scoreColor(assess?.score ?? 0) }]}>
          BRAKE {assess ? assess.score.toFixed(1) : '0.0'}/10
        </Text>
        <Text style={[styles.hudReason, overspeed && styles.hudReasonOver]}>
          {overspeed
            ? 'OVERSPEED'
            : assess
              ? assess.reason.toUpperCase()
              : !hasGps
                ? 'GPS…'
                : limitStatus === 'loading'
                  ? 'MAP…'
                  : limitStatus === 'error'
                    ? 'MAP ERR'
                    : limitStatus === 'nodata'
                      ? 'NO LIMIT NEARBY'
                      : 'CLEAR'}
        </Text>
      </View>

      <View style={styles.diagBar} pointerEvents="none">
        <Text style={styles.diagText}>{diag}</Text>
      </View>

      <Pressable
        style={styles.calibrateBtn}
        onPress={() => setScreen('calibrate')}
      >
        <Text style={styles.calibrateText}>⚙ Calibrate</Text>
      </Pressable>
      </>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: { color: '#aaa', fontSize: 14, textAlign: 'center', marginBottom: 20 },
  button: {
    backgroundColor: '#2e7dff',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    marginBottom: 14,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { color: '#2e7dff', fontSize: 14 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  zoneLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: 'rgba(0, 255, 120, 0.4)',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 3,
  },
  boxLabel: {
    position: 'absolute',
    top: -18,
    left: -1,
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  banner: {
    position: 'absolute',
    top: 48,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  bannerText: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  hud: {
    position: 'absolute',
    top: 80,
    left: 16,
    width: 210,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  hudTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hudSpeed: { color: '#fff', fontSize: 30, fontWeight: '800' },
  hudSpeedOver: { color: '#ff3b30' },
  hudUnit: { color: '#aaa', fontSize: 13, fontWeight: '600' },
  limitSign: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 4,
    borderColor: '#d1122b',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  limitNum: { color: '#111', fontSize: 17, fontWeight: '800' },
  meterTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginTop: 10,
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 5 },
  hudScore: { fontSize: 15, fontWeight: '800', marginTop: 8, letterSpacing: 0.5 },
  hudReason: { color: '#ccc', fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  hudReasonOver: { color: '#ff3b30', fontWeight: '800' },
  diagBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  diagText: { color: '#7CFC00', fontSize: 10, fontFamily: 'monospace' },
  calibrateBtn: {
    position: 'absolute',
    right: 24,
    bottom: 28,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
  },
  calibrateText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
