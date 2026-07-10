/**
 * Phase 5 — the non-annoying audio alert (feature #4: no mechanical braking,
 * just a timely sound).
 *
 * Two tiers, each on its own cooldown so it warns without nagging:
 *   • caution (score ≥ 6): a soft 660 Hz beep, at most every 2.5 s
 *   • imminent (score ≥ 8): a sharper 880 Hz tone, at most every 1.2 s
 *
 * Plus a Phase 6 overspeed chirp (soft beep, every 5 s) when you're > 10 % over
 * the road's limit. Sounds play even with the phone on silent (it's a safety
 * alert) and briefly duck other audio (music/nav) rather than stopping it.
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

function play(player: ReturnType<typeof useAudioPlayer>): void {
  try {
    player.seekTo(0);
    player.play();
  } catch {
    // player not ready yet — skip this beat, a later tick will retry
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

  // Route audio so a driving alert is actually heard.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldPlayInBackground: false,
    }).catch(() => {});
  }, []);

  // Collision brake alert.
  useEffect(() => {
    if (!enabled) return;
    const level = score >= ALERT_SCORE ? 2 : score >= CAUTION_SCORE ? 1 : 0;
    if (level === 0) return;
    const now = Date.now();
    const cooldown = level === 2 ? ALERT_COOLDOWN_MS : CAUTION_COOLDOWN_MS;
    if (now - lastBrakeRef.current < cooldown) return;
    lastBrakeRef.current = now;
    play(level === 2 ? alert : beep);
  }, [score, enabled, beep, alert]);

  // Overspeed chirp (Phase 6).
  useEffect(() => {
    if (!enabled || !overspeed) return;
    const now = Date.now();
    if (now - lastOverspeedRef.current < OVERSPEED_COOLDOWN_MS) return;
    lastOverspeedRef.current = now;
    play(beep);
  }, [overspeed, enabled, beep]);
}
