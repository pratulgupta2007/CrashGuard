/**
 * Full-screen calibration overlay drawn on top of the live camera preview.
 *
 * Drag the two vertical handles to set the LEFT / FRONT / RIGHT lane dividers so
 * FRONT matches your driving corridor. Slide "Distance tuning" to adjust the
 * camera's vertical FOV until the live readout for a known object matches the
 * tape-measured distance.
 *
 * The camera and detector keep running underneath (App owns them), so the
 * distance readout updates live as you slide.
 */
import { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';

import { VFOV_MAX, VFOV_MIN, type Calibration } from '../logic/calibration';
import { formatDistance } from '../logic/distance';
import { labelFor } from '../constants/classes';

type LiveObject = {
  cls: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  distanceM: number | null;
};

type Props = {
  cal: Calibration;
  onChange: (patch: Partial<Calibration>) => void;
  onReset: () => void;
  onClose: () => void;
  mapX: (n: number) => number; // frame-normalized x → screen px
  unmapX: (x: number) => number; // screen px → frame-normalized x
  mapY: (n: number) => number;
  dispW: number;
  dispH: number;
  objects: LiveObject[];
  screenW: number;
};

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export default function CalibrationScreen({
  cal,
  onChange,
  onReset,
  onClose,
  mapX,
  unmapX,
  mapY,
  dispW,
  dispH,
  objects,
  screenW,
}: Props) {
  // Keep the latest props in refs so the once-created PanResponders read fresh values.
  const calRef = useRef(cal);
  calRef.current = cal;
  const unmapRef = useRef(unmapX);
  unmapRef.current = unmapX;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const leftPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_e, g) => {
          const b = clamp(
            unmapRef.current(g.moveX),
            0.02,
            calRef.current.zoneRight - 0.05,
          );
          onChangeRef.current({ zoneLeft: b });
        },
      }),
    [],
  );

  const rightPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_e, g) => {
          const b = clamp(
            unmapRef.current(g.moveX),
            calRef.current.zoneLeft + 0.05,
            0.98,
          );
          onChangeRef.current({ zoneRight: b });
        },
      }),
    [],
  );

  // Custom slider: uses the track's own locationX so no page-coordinate math.
  const [trackW, setTrackW] = useState(1);
  const setFovFromTouch = (e: GestureResponderEvent) => {
    const frac = clamp(e.nativeEvent.locationX / trackW, 0, 1);
    onChange({ vFovDeg: Math.round(VFOV_MIN + frac * (VFOV_MAX - VFOV_MIN)) });
  };
  const fovFrac = (cal.vFovDeg - VFOV_MIN) / (VFOV_MAX - VFOV_MIN);

  // Live feedback: nearest object with a known distance.
  let nearest: LiveObject | null = null;
  for (const o of objects) {
    if (o.distanceM == null) continue;
    if (nearest == null || o.distanceM < nearest.distanceM!) nearest = o;
  }

  const leftX = mapX(cal.zoneLeft);
  const rightX = mapX(cal.zoneRight);

  return (
    <View style={styles.root}>
      {/* Faint detection boxes so you can align lanes to a real object */}
      {objects.map((o, i) => (
        <View
          key={i}
          pointerEvents="none"
          style={[
            styles.detBox,
            {
              left: mapX(o.xmin),
              top: mapY(o.ymin),
              width: (o.xmax - o.xmin) * dispW,
              height: (o.ymax - o.ymin) * dispH,
            },
          ]}
        >
          <Text style={styles.detLabel}>
            {labelFor(o.cls)}
            {o.distanceM != null ? ` · ${formatDistance(o.distanceM)}` : ''}
          </Text>
        </View>
      ))}

      {/* Zone shading */}
      <View
        pointerEvents="none"
        style={[styles.zoneFill, styles.zoneLeftFill, { width: leftX }]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.zoneFill,
          styles.zoneRightFill,
          { left: rightX, width: screenW - rightX },
        ]}
      />

      {/* Draggable divider handles */}
      <View
        style={[styles.dragStrip, { left: leftX - 22 }]}
        {...leftPan.panHandlers}
      >
        <View style={[styles.line, styles.lineLeft]} />
        <View style={[styles.knob, styles.knobLeft]}>
          <Text style={styles.knobText}>⇔</Text>
        </View>
      </View>
      <View
        style={[styles.dragStrip, { left: rightX - 22 }]}
        {...rightPan.panHandlers}
      >
        <View style={[styles.line, styles.lineRight]} />
        <View style={[styles.knob, styles.knobRight]}>
          <Text style={styles.knobText}>⇔</Text>
        </View>
      </View>

      {/* Top bar */}
      <View style={styles.topBar} pointerEvents="box-none">
        <Text style={styles.title}>CALIBRATION</Text>
        <Pressable style={styles.doneBtn} onPress={onClose}>
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>
      <Text style={styles.hint} pointerEvents="none">
        Drag the yellow / blue handles to set the FRONT corridor
      </Text>

      {/* Bottom panel: distance tuning slider + live readout */}
      <View style={styles.panel}>
        <View style={styles.panelRow}>
          <Text style={styles.panelLabel}>
            Distance tuning · FOV {cal.vFovDeg}°
          </Text>
          <Pressable onPress={onReset} hitSlop={10}>
            <Text style={styles.resetText}>Reset</Text>
          </Pressable>
        </View>

        <View
          style={styles.track}
          onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={setFovFromTouch}
          onResponderMove={setFovFromTouch}
        >
          <View style={[styles.trackFill, { width: `${fovFrac * 100}%` }]} />
          <View style={[styles.thumb, { left: `${fovFrac * 100}%` }]} />
        </View>

        <View style={styles.readoutRow}>
          <Text style={styles.readoutHint}>
            Point at an object at a known distance; match the number:
          </Text>
          <Text style={styles.readoutValue}>
            {nearest?.distanceM != null
              ? `${labelFor(nearest.cls)}  ${formatDistance(nearest.distanceM)}`
              : 'no object'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const YELLOW = '#ffd60a';
const BLUE = '#0a84ff';

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  detBox: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    borderRadius: 2,
  },
  detLabel: {
    position: 'absolute',
    top: -15,
    left: -1,
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 3,
  },
  zoneFill: { position: 'absolute', top: 0, bottom: 0 },
  zoneLeftFill: { left: 0, backgroundColor: 'rgba(255,214,10,0.12)' },
  zoneRightFill: { backgroundColor: 'rgba(10,132,255,0.12)' },
  dragStrip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { position: 'absolute', top: 0, bottom: 0, width: 3 },
  lineLeft: { backgroundColor: YELLOW, left: 22 },
  lineRight: { backgroundColor: BLUE, left: 22 },
  knob: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  knobLeft: { backgroundColor: YELLOW },
  knobRight: { backgroundColor: BLUE },
  knobText: { color: '#000', fontSize: 18, fontWeight: '900' },
  topBar: {
    position: 'absolute',
    top: 40,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 2,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  doneBtn: {
    backgroundColor: '#30d158',
    paddingHorizontal: 22,
    paddingVertical: 8,
    borderRadius: 20,
  },
  doneText: { color: '#000', fontSize: 15, fontWeight: '800' },
  hint: {
    position: 'absolute',
    top: 84,
    alignSelf: 'center',
    color: '#fff',
    fontSize: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  panel: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 24,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 16,
    padding: 16,
  },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  panelLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
  resetText: { color: '#0a84ff', fontSize: 14, fontWeight: '700' },
  track: {
    height: 34,
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  trackFill: {
    position: 'absolute',
    left: 0,
    height: '100%',
    borderRadius: 17,
    backgroundColor: 'rgba(48,209,88,0.45)',
  },
  thumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#fff',
    marginLeft: -13,
    borderWidth: 3,
    borderColor: '#30d158',
  },
  readoutRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center' },
  readoutHint: { color: '#bbb', fontSize: 12, flex: 1, marginRight: 10 },
  readoutValue: { color: '#30d158', fontSize: 18, fontWeight: '800' },
});
