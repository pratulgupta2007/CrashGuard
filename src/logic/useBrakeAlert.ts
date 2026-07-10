/**
 * Audio alerts. Two brake tiers plus an overspeed chirp, each on its own
 * cooldown so they warn without nagging:
 *   caution   (score >= 6): double 740 Hz beep, min every 2.5s
 *   imminent  (score >= 8): rising 3-tone alert, min every 1.2s
 *   overspeed (>10% over limit): the caution beep, min every 5s
 *
 * Sounds play at full volume over silent mode and duck (not stop) other audio.
 */
import { useEffect, useRef } from 'react';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';

const BEEP = require('../../assets/sounds/beep.wav');
const ALERT = require('../../assets/sounds/alert.wav');

const CAUTION_SCORE = 6;
const ALERT_SCORE = 8;
const CAUTION_COOLDOWN_MS = 2500;
const ALERT_COOLDOWN_MS = 1200;
const OVERSPEED_COOLDOWN_MS = 5000;

type Player = ReturnType<typeof useAudioPlayer>;

function play(player: Player, tag: string): void {
  try {
    player.volume = 1.0;
    player.seekTo(0);
    player.play();
    console.log(`[alert] ▶ ${tag}`);
  } catch (e) {
    console.log(`[alert] play(${tag}) failed:`, String(e));
  }
}

export function useBrakeAlert(
  score: number,
  overspeed: boolean,
  enabled: boolean,
): void {
  const beep = useAudioPlayer(BEEP);
  const alert = useAudioPlayer(ALERT);
  const lastBrakeRef = useRef(0);
  const lastOverspeedRef = useRef(0);

  // Route audio so a driving alert is actually heard: full volume, over silent
  // mode, ducking (not stopping) any music/nav audio.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldPlayInBackground: false,
    }).catch((e) => console.log('[alert] setAudioMode failed:', String(e)));
    beep.volume = 1.0;
    alert.volume = 1.0;
  }, [beep, alert]);

  // Dev-only self-test: chirp once after launch to confirm the audio path
  // without triggering a real brake event. __DEV__ is false in release, so this
  // is stripped from the production build. (Kept from debugging the silent-alert
  // bug where the players were fine but the tone was too quiet/short to notice.)
  useEffect(() => {
    if (!__DEV__) return;
    const t = setTimeout(() => play(alert, 'self-test'), 2500);
    return () => clearTimeout(t);
  }, [alert]);

  // Collision brake alert.
  useEffect(() => {
    if (!enabled) return;
    const level = score >= ALERT_SCORE ? 2 : score >= CAUTION_SCORE ? 1 : 0;
    if (level === 0) return;
    const now = Date.now();
    const cooldown = level === 2 ? ALERT_COOLDOWN_MS : CAUTION_COOLDOWN_MS;
    if (now - lastBrakeRef.current < cooldown) return;
    lastBrakeRef.current = now;
    play(level === 2 ? alert : beep, level === 2 ? 'imminent' : 'caution');
  }, [score, enabled, beep, alert]);

  // Overspeed chirp.
  useEffect(() => {
    if (!enabled || !overspeed) return;
    const now = Date.now();
    if (now - lastOverspeedRef.current < OVERSPEED_COOLDOWN_MS) return;
    lastOverspeedRef.current = now;
    play(beep, 'overspeed');
  }, [overspeed, enabled, beep]);
}
