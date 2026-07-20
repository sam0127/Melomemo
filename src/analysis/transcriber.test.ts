import { describe, expect, it } from 'vitest';
import { createMemoFromCapture } from '../core/memoFactory.ts';
import type { AnalysisRecord, CaptureInfo, CapturedAudio } from '../core/types.ts';
import { InMemoryMemoRepository } from '../storage/memoRepository.ts';
import { uuidv7 } from '../core/ids.ts';
import { CURRENT_ENGINE, isStale } from './registry.ts';
import { mpmEngine } from './engines/mpmEngine.ts';
import { concat, silence, tone } from '../test/signals.ts';
import { midiToHz } from '../core/pitch.ts';
import { ANALYSIS_RATE } from './constants.ts';

function makeCaptured(): CapturedAudio {
  const data = new ArrayBuffer(64);
  new Uint8Array(data).fill(3);
  const capture: CaptureInfo = {
    mimeType: 'audio/webm;codecs=opus',
    requestedMimeType: 'audio/webm;codecs=opus',
    durationMs: 1000,
    byteLength: 64,
    sampleRate: 48000,
    channelCount: 1,
    dsp: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    deviceLabel: null,
    capturedAt: Date.now(),
    platform: 'desktop',
    terminatedBy: 'user',
  };
  return { data, capture };
}

function recordFor(memoId: string, audioHash: string): AnalysisRecord {
  const payload = mpmEngine.analyze({
    samples: tone(midiToHz(60), 600),
    sampleRate: ANALYSIS_RATE,
  });
  return {
    id: uuidv7(),
    memoId,
    audioHash,
    algorithmId: CURRENT_ENGINE.algorithmId,
    algorithmVersion: CURRENT_ENGINE.version,
    status: 'ok',
    createdAt: Date.now(),
    ...payload,
  };
}

describe('analysis persistence', () => {
  it('points the memo at the analysis it saved', async () => {
    const repository = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured());
    await repository.saveMemo(memo, audio);

    const record = recordFor(memo.id, memo.audioHash);
    expect((await repository.saveAnalysis(record)).ok).toBe(true);

    const stored = await repository.getMemo(memo.id);
    expect(stored.ok && stored.value.analysisState?.status).toBe('ok');
    expect(stored.ok && stored.value.analysisState?.currentAnalysisId).toBe(record.id);

    const fetched = await repository.getAnalysis(memo.id);
    expect(fetched.ok && fetched.value.notes.length).toBeGreaterThan(0);
  });

  it('reports not-found for a memo with no transcription', async () => {
    const repository = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured());
    await repository.saveMemo(memo, audio);

    const result = await repository.getAnalysis(memo.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('records a failure without attaching a result', async () => {
    const repository = new InMemoryMemoRepository();
    const { memo, audio } = await createMemoFromCapture(makeCaptured());
    await repository.saveMemo(memo, audio);

    await repository.setAnalysisState(memo.id, {
      currentAnalysisId: null,
      algorithmId: CURRENT_ENGINE.algorithmId,
      algorithmVersion: CURRENT_ENGINE.version,
      status: 'failed',
      updatedAt: Date.now(),
    });

    const stored = await repository.getMemo(memo.id);
    expect(stored.ok && stored.value.analysisState?.status).toBe('failed');
    // A failed state must not leave a dangling analysis pointer.
    expect(stored.ok && stored.value.analysisState?.currentAnalysisId).toBeNull();
  });
});

describe('staleness', () => {
  it('treats the current engine at its current version as fresh', () => {
    expect(isStale(CURRENT_ENGINE.algorithmId, CURRENT_ENGINE.version)).toBe(false);
  });

  it('treats an older version or a different engine as stale', () => {
    // This is what drives re-analysis once the algorithm improves.
    expect(isStale(CURRENT_ENGINE.algorithmId, '0.0.1')).toBe(true);
    expect(isStale('some-future-engine', CURRENT_ENGINE.version)).toBe(true);
  });
});

describe('engine output shape', () => {
  it('reports quality metrics alongside the notes', () => {
    const melody = concat(
      tone(midiToHz(60), 400),
      silence(150),
      tone(midiToHz(67), 400),
    );
    const payload = mpmEngine.analyze({ samples: melody, sampleRate: ANALYSIS_RATE });

    expect(payload.notes).toHaveLength(2);
    expect(payload.quality.voicedRatio).toBeGreaterThan(0.4);
    expect(payload.quality.medianConfidence).toBeGreaterThan(0.8);
    expect(payload.input.frameCount).toBeGreaterThan(0);
    // The dense contour is retained for the debug view, one value per frame.
    expect(new Float32Array(payload.f0.hz)).toHaveLength(payload.input.frameCount);
  });

  it('warns rather than silently returning nothing for unusable audio', () => {
    const payload = mpmEngine.analyze({
      samples: silence(800),
      sampleRate: ANALYSIS_RATE,
    });
    expect(payload.notes).toEqual([]);
    expect(payload.quality.warnings).toContain('no-pitch-detected');
  });
});
