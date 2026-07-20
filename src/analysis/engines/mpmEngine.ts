import { DEFAULT_A4_HZ } from '../../core/pitch.ts';
import type { AnalysisEngine, AnalysisPayload, PcmInput } from '../AnalysisEngine.ts';
import {
  FRAME_SIZE,
  HOP_SIZE,
  MAX_GAP_MS,
  MIN_CLARITY,
  MIN_NOTE_MS,
  SPLIT_SEMITONES,
} from '../constants.ts';
import { trackPitch } from '../pitchTrack.ts';
import { segmentNotes } from '../segmentation.ts';

/**
 * Transcription via the McLeod Pitch Method, plus median smoothing, hysteresis
 * segmentation, and a global tuning correction.
 *
 * MPM is frame-local: it decides each frame independently, which makes it fast
 * and streaming-friendly but leaves it prone to isolated octave errors. The
 * layers around it exist to compensate. A future engine using a method with
 * whole-phrase context (pYIN's Viterbi decoding, or a learned model) would
 * handle those errors at the source and should simply be registered alongside
 * this one.
 */

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const mpmEngine: AnalysisEngine = {
  algorithmId: 'mpm',
  /*
   * 1.0.0 — first release.
   * Bump on any change that would alter output for identical input, including
   * changes to the constants module, so stale analyses are recomputed.
   */
  version: '1.0.0',
  defaultParams: {
    minClarity: MIN_CLARITY,
    frameSize: FRAME_SIZE,
    hopSize: HOP_SIZE,
    minNoteMs: MIN_NOTE_MS,
    maxGapMs: MAX_GAP_MS,
    splitSemitones: SPLIT_SEMITONES,
  },

  analyze(input: PcmInput, params = {}): AnalysisPayload {
    const startedAt = Date.now();

    const track = trackPitch(input.samples, input.sampleRate);
    const { notes, estimatedOffsetCents } = segmentNotes(track);

    let voicedFrames = 0;
    for (let i = 0; i < track.frameCount; i++) {
      if (!Number.isNaN(track.midi[i]!)) voicedFrames++;
    }
    const voicedRatio =
      track.frameCount === 0 ? 0 : voicedFrames / track.frameCount;

    const warnings: string[] = [];
    const durationMs = (input.samples.length / input.sampleRate) * 1000;
    if (track.frameCount === 0) {
      warnings.push('too-short');
    } else if (notes.length === 0) {
      warnings.push('no-pitch-detected');
    } else if (voicedRatio < 0.2) {
      // Most of the recording was silence or noise; whatever notes came out
      // rest on very little evidence.
      warnings.push('mostly-unvoiced');
    }
    if (durationMs > 0 && durationMs < 500) warnings.push('very-short');
    if (Math.abs(estimatedOffsetCents) > 40) warnings.push('significant-tuning-offset');

    return {
      params: { ...mpmEngine.defaultParams, ...params },
      computeMs: Date.now() - startedAt,
      input: {
        sampleRate: input.sampleRate,
        frameSizeSamples: FRAME_SIZE,
        hopSizeSamples: HOP_SIZE,
        frameCount: track.frameCount,
      },
      // The dense contour is kept, not just the notes: when a transcription is
      // wrong, the contour is the only thing that shows whether the detector
      // or the segmentation was at fault.
      f0: {
        hz: track.hz.buffer as ArrayBuffer,
        confidence: track.clarity.buffer as ArrayBuffer,
        rms: track.rms.buffer as ArrayBuffer,
      },
      tuning: {
        referenceA4Hz: DEFAULT_A4_HZ,
        estimatedOffsetCents,
      },
      notes,
      quality: {
        voicedRatio,
        medianConfidence: median(notes.map((n) => n.confidence)),
        warnings,
      },
    };
  },
};
