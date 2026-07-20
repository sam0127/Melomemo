import { PitchDetector } from 'pitchy';
import { hzToMidi } from '../core/pitch.ts';
import {
  ABSOLUTE_SILENCE_RMS,
  ANALYSIS_RATE,
  FRAME_SIZE,
  HOP_SIZE,
  MAX_F0_HZ,
  MEDIAN_WINDOW_FRAMES,
  MIN_CLARITY,
  MIN_F0_HZ,
  SILENCE_FLOOR_DB,
} from './constants.ts';

/**
 * Frame-by-frame fundamental frequency tracking.
 *
 * Produces a dense per-frame track rather than notes directly. Keeping the raw
 * contour is what lets the debug view show *why* a transcription went wrong —
 * a wobbling contour and a confidently wrong one look identical once collapsed
 * into note names.
 */

export interface PitchTrack {
  /** Hz per frame; NaN where the frame is unvoiced. */
  hz: Float32Array;
  /** McLeod clarity, 0..1. */
  clarity: Float32Array;
  rms: Float32Array;
  /** Fractional MIDI per frame after median smoothing; NaN where unvoiced. */
  midi: Float32Array;
  frameCount: number;
}

function rmsOf(samples: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / length);
}

/**
 * Median of the valid (non-NaN) values in a window.
 *
 * NaN entries are skipped rather than treated as zero, so an unvoiced
 * neighbour cannot drag a voiced frame's pitch down.
 */
function medianIgnoringNaN(
  values: Float32Array,
  centre: number,
  halfWidth: number,
): number {
  const collected: number[] = [];
  const from = Math.max(0, centre - halfWidth);
  const to = Math.min(values.length - 1, centre + halfWidth);
  for (let i = from; i <= to; i++) {
    const v = values[i]!;
    if (!Number.isNaN(v)) collected.push(v);
  }
  if (collected.length === 0) return Number.NaN;
  collected.sort((a, b) => a - b);
  const mid = collected.length >> 1;
  return collected.length % 2 === 1
    ? collected[mid]!
    : (collected[mid - 1]! + collected[mid]!) / 2;
}

export function trackPitch(
  samples: Float32Array,
  sampleRate: number = ANALYSIS_RATE,
): PitchTrack {
  const frameCount =
    samples.length < FRAME_SIZE
      ? 0
      : Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1;

  const hz = new Float32Array(frameCount);
  const clarity = new Float32Array(frameCount);
  const rms = new Float32Array(frameCount);
  const rawMidi = new Float32Array(frameCount);

  if (frameCount === 0) {
    return { hz, clarity, rms, midi: rawMidi, frameCount: 0 };
  }

  const detector = PitchDetector.forFloat32Array(FRAME_SIZE);
  // Reused across frames; the detector requires an exact-length input.
  const window = new Float32Array(FRAME_SIZE);

  let peakRms = 0;
  for (let i = 0; i < frameCount; i++) {
    const offset = i * HOP_SIZE;
    window.set(samples.subarray(offset, offset + FRAME_SIZE));

    const frameRms = rmsOf(samples, offset, FRAME_SIZE);
    rms[i] = frameRms;
    if (frameRms > peakRms) peakRms = frameRms;

    const [pitch, clar] = detector.findPitch(window, sampleRate);
    hz[i] = pitch;
    clarity[i] = clar;
  }

  // Voicing is decided after the whole file is seen, because the loudness
  // threshold is relative to this recording's own peak.
  const relativeFloor = peakRms * Math.pow(10, SILENCE_FLOOR_DB / 20);
  const floor = Math.max(relativeFloor, ABSOLUTE_SILENCE_RMS);

  for (let i = 0; i < frameCount; i++) {
    const frequency = hz[i]!;
    const voiced =
      clarity[i]! >= MIN_CLARITY &&
      rms[i]! >= floor &&
      Number.isFinite(frequency) &&
      // Outside the human range this is a subharmonic or a window-edge
      // artefact, however confident the clarity score looks.
      frequency >= MIN_F0_HZ &&
      frequency <= MAX_F0_HZ;
    rawMidi[i] = voiced ? hzToMidi(hz[i]!) : Number.NaN;
    if (!voiced) hz[i] = Number.NaN;
  }

  // Median smoothing in the MIDI domain, not in Hz: an octave error is a
  // constant ±12 offset in MIDI but a factor of two in Hz, so a linear median
  // is the right tool only after the log transform.
  const smoothed = new Float32Array(frameCount);
  const half = Math.floor(MEDIAN_WINDOW_FRAMES / 2);
  for (let i = 0; i < frameCount; i++) {
    smoothed[i] = Number.isNaN(rawMidi[i]!)
      ? Number.NaN
      : medianIgnoringNaN(rawMidi, i, half);
  }

  return { hz, clarity, rms, midi: smoothed, frameCount };
}
