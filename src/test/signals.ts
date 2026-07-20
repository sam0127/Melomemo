import { ANALYSIS_RATE } from '../analysis/constants.ts';

/**
 * Synthetic audio for testing the analysis pipeline.
 *
 * Real singing can't be generated convincingly, but the properties that break
 * pitch trackers can be: vibrato, glides, harmonics, quiet passages, and
 * noise. Every generator uses phase accumulation rather than
 * `sin(2π f t)` computed per sample, so frequency can vary continuously
 * without the discontinuities that would themselves look like onsets.
 */

export interface ToneOptions {
  sampleRate?: number;
  amplitude?: number;
  /** Vibrato depth in cents, peak deviation from the centre frequency. */
  vibratoCents?: number;
  vibratoHz?: number;
  /** Relative levels of harmonics 2..n; a pure sine by default. */
  harmonics?: number[];
}

function lengthFor(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

export function tone(hz: number, ms: number, options: ToneOptions = {}): Float32Array {
  const {
    sampleRate = ANALYSIS_RATE,
    amplitude = 0.3,
    vibratoCents = 0,
    vibratoHz = 5,
    harmonics = [],
  } = options;

  const out = new Float32Array(lengthFor(ms, sampleRate));
  let phase = 0;
  const harmonicPhases = harmonics.map(() => 0);

  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const cents = vibratoCents * Math.sin(2 * Math.PI * vibratoHz * t);
    const instantaneous = hz * Math.pow(2, cents / 1200);

    phase += (2 * Math.PI * instantaneous) / sampleRate;
    let sample = Math.sin(phase);

    harmonics.forEach((level, index) => {
      const multiple = index + 2;
      harmonicPhases[index]! +=
        (2 * Math.PI * instantaneous * multiple) / sampleRate;
      sample += level * Math.sin(harmonicPhases[index]!);
    });

    out[i] = amplitude * sample;
  }
  return out;
}

/** A continuous slide between two frequencies, exponential in pitch. */
export function glide(
  fromHz: number,
  toHz: number,
  ms: number,
  options: ToneOptions = {},
): Float32Array {
  const { sampleRate = ANALYSIS_RATE, amplitude = 0.3 } = options;
  const out = new Float32Array(lengthFor(ms, sampleRate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const progress = out.length === 1 ? 0 : i / (out.length - 1);
    const hz = fromHz * Math.pow(toHz / fromHz, progress);
    phase += (2 * Math.PI * hz) / sampleRate;
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

export function silence(ms: number, sampleRate = ANALYSIS_RATE): Float32Array {
  return new Float32Array(lengthFor(ms, sampleRate));
}

/**
 * Deterministic pseudo-random noise, so a failing test fails the same way
 * twice.
 *
 * Uses mulberry32 via Math.imul rather than a textbook linear congruential
 * generator: `seed * 1103515245` exceeds 2^53 in JavaScript's doubles, loses
 * precision, and collapses into a short repeating cycle. A repeating cycle is
 * a *periodic* signal, which a pitch detector correctly reports as a note —
 * so the naive version produces a confident low tone instead of noise.
 */
export function noise(
  ms: number,
  amplitude = 0.05,
  sampleRate = ANALYSIS_RATE,
): Float32Array {
  const out = new Float32Array(lengthFor(ms, sampleRate));
  let seed = 0x9e3779b9;
  for (let i = 0; i < out.length; i++) {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out[i] = amplitude * (unit * 2 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Adds a quiet noise bed, closer to a real room than digital silence. */
export function withNoiseFloor(
  signal: Float32Array,
  amplitude = 0.002,
): Float32Array {
  const bed = noise((signal.length / ANALYSIS_RATE) * 1000, amplitude);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i]! + (bed[i] ?? 0);
  return out;
}
