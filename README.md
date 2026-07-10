# CrashGuard

A forward-collision and overspeed warning app for Android that turns a phone into a
dashcam-style driving aid. It watches the road through the back camera, estimates how
close and how dangerous the vehicles ahead are, and warns you with sound before you get
too close or too fast. Everything runs **on the device** — object detection, distance,
physics, and the speed-limit lookup all work offline; there is no server and no cloud.

It's a from-scratch rebuild of a 2022 project ("Smart Bumper") that used a laptop, a
webcam and a Python/OpenCV script. This version does the same job locally on a phone,
with the crude box-height heuristic replaced by a real kinematic model.

## Features

- **On-device object detection** — a YOLOv8n TFLite model runs per frame and detects
  the road-relevant classes: cars, trucks, buses, motorcycles, bicycles, people and
  animals (dogs, cows, horses, etc.).
- **Lane zones** — the frame is split into LEFT / FRONT / RIGHT corridors so the app can
  focus on what's directly ahead. The dividers are adjustable.
- **Metric distance** — each detection's distance is estimated from its box height using
  a pinhole camera model, calibrated to the phone's field of view.
- **Physics brake score (0–10)** — combines the kinematic stopping distance at your
  current speed with the time-to-collision to the nearest object ahead.
- **Audio alerts** — a two-tier, cooldown-limited beep (no mechanical or Bluetooth
  actuation, just a timely sound), plus a chirp when you exceed the speed limit.
- **Offline speed limits** — road speed limits within ~25 km are pulled once from
  OpenStreetMap and cached in SQLite; lookups while driving are fully offline. The
  window refetches automatically as you move out of range.
- **Landscape HUD** — speed, a speed-limit sign, the brake meter, live detection boxes,
  and an in-app calibration screen.

## How it works

### Detection pipeline

```
VisionCamera frame ─▶ frame-processor worklet
    ─▶ letterbox to 320×320×3 float32
    ─▶ fast-tflite YOLOv8n (CPU / XNNPACK)
    ─▶ decode + non-max suppression
    ─▶ per-detection lane zone + distance
    ─▶ React overlay (boxes, HUD, alerts)
```

The frame processor reads the camera's luminance (Y) plane for a full-frame grayscale
image, letterboxes it into the model's 320×320 input, runs inference, and decodes the
`[1, 84, 2100]` output with greedy NMS.

### Distance

Distance comes from the pinhole model with a known real-world object height:

```
distance = realHeight / (2 · tan(vFOV / 2) · normHeight)
```

where `normHeight` is the detection's box height as a fraction of the frame height. The
frame resolution cancels out, so the only per-device thing to calibrate is the camera's
vertical field of view.

### Brake score

The 0–10 score is the worse of two dangers:

1. **Stopping-distance pressure** — how much of the gap ahead your own stopping distance
   would consume:

   ```
   stopping distance = v · t_react + v² / (2a)
   ```

   with a 1.2 s reaction time and 7 m/s² (≈ 0.7 g) braking.

2. **Time-to-collision** — the gap divided by how fast it is closing, mapped so that
   ≥ 6 s is calm and ≤ 1.5 s is maximum urgency.

Stationary with nothing approaching scores 0; a gap you can't stop within, or an
imminent impact, scores 10.

## Tech stack

- [Expo](https://expo.dev) SDK 57 (dev client + config plugins + prebuild), React Native 0.86, New Architecture
- [react-native-vision-camera](https://github.com/mrousavy/react-native-vision-camera) 5 (Nitro) for the camera + frame processor
- [react-native-fast-tflite](https://github.com/mrousavy/react-native-fast-tflite) 3 for on-device TFLite inference
- [react-native-worklets](https://github.com/margelo/react-native-worklets) for running the frame processor off the JS thread
- `expo-location` (GPS speed + position), `expo-sqlite` (speed-limit cache + calibration), `expo-audio` (alerts)

## Requirements

- Node 18+ and the Expo CLI
- Android device with **minSdk 26+** (the frame buffer is HardwareBuffer-backed) — arm64
- Android SDK + NDK for local native builds
- A physical device (the camera and GPS don't work in an emulator)

## Getting started

```bash
git clone https://github.com/pratulgupta2007/CrashGuard.git
cd CrashGuard
npm install
```

### Run in development

```bash
# build & install the dev client on a connected device, then start Metro
npx expo run:android
```

Grant the camera and location permissions when prompted, then point the phone at the
road (landscape).

### Build a standalone release APK

```bash
cd android
./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

The release APK bundles the JS and runs with no Metro/laptop attached. On low-memory
machines, build with a single worker and a larger Node heap:

```bash
NODE_OPTIONS=--max-old-space-size=4096 ./gradlew assembleRelease --no-daemon --max-workers=1
```

Install it with `adb install -r app-release.apk`, or copy the file to a phone and tap it.

> The default release build is signed with the debug keystore, which is fine for
> sideloading. For the Play Store, add a release keystore and signing config.

## Calibration

Tap **Calibrate** on the main screen to open the overlay:

- Drag the two vertical handles to line the FRONT corridor up with your lane.
- Slide **Distance tuning** to set the camera's vertical FOV: point at an object at a
  known distance (e.g. a person at a measured 5 m) and adjust until the on-screen
  distance matches.

Both settings are saved on the device and persist across restarts.

## Configuration

Most tunables live at the top of their modules:

| Setting | File | Default |
| --- | --- | --- |
| Detection score / NMS thresholds | `App.tsx` | `0.4` / `0.45` |
| Reaction time, braking deceleration | `src/logic/physics.ts` | `1.2 s`, `7 m/s²` |
| TTC urgency band | `src/logic/physics.ts` | `1.5–6 s` |
| Alert score thresholds & cooldowns | `src/logic/useBrakeAlert.ts` | `6` / `8` |
| Speed-limit window radius | `src/logic/speedLimit.ts` | `25 km` |
| Default camera FOV | `src/logic/distance.ts` | `40°` |

## Project structure

```
App.tsx                     main screen: camera, detection, HUD
index.ts                    entry point
src/
  components/
    CalibrationScreen.tsx   draggable lane dividers + FOV slider
  constants/
    classes.ts              COCO labels, relevant classes, class heights
  logic/
    distance.ts             pinhole distance estimation
    physics.ts              stopping distance + TTC + brake score
    useEgoSpeed.ts          GPS speed + position
    useBrakeAlert.ts        two-tier audio alerts
    speedLimit.ts           Overpass fetch + SQLite cache + lookup
    useSpeedLimit.ts        window management + throttled lookups
    calibration.ts          persisted calibration store
assets/
  models/yolov8n.tflite     detection model
  sounds/                   alert tones
```

## Limitations

- Distance is only accurate when the whole object is in frame; a partially visible
  object reads as farther than it is.
- Detection currently runs on grayscale (the camera's Y plane); color could be added
  from the U/V planes if needed.
- Per-frame CPU inference is battery-hungry — fine for testing, but a production build
  would want frame skipping or an int8/NNAPI model.
- Speed limits depend on OpenStreetMap coverage; roads without a `maxspeed` tag show no
  limit.

## License

Code is released under the [MIT License](LICENSE).

The bundled `yolov8n.tflite` model is from [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics)
and is licensed **AGPL-3.0**; swap in your own model if you need different terms. Speed-limit
data comes from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors via the
Overpass API. Object classes follow the COCO label set.
