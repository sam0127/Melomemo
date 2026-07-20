/**
 * The Melomemo data model.
 *
 * Three layers per memo, deliberately kept separate:
 *
 *   AudioAsset      immutable captured bytes — the source of truth
 *        |  (v2) analysis: derived, versioned, disposable, safe to recompute
 *   AnalysisRecord  machine output — never edited by the user
 *        |  (v3) seeded once, then independent
 *   ScoreDocument   the user's MIDI — NEVER auto-overwritten by re-analysis
 *
 * Re-analysis may freely replace an AnalysisRecord. It may never silently
 * modify a ScoreDocument the user has touched; re-seeding is an explicit,
 * confirmed action. See ScoreDocument.userEdited.
 */

export type MemoId = string;
export type AnalysisId = string;
export type ScoreId = string;

/** Bumped when the shape of a persisted Memo changes; migrated lazily on read. */
export const MEMO_SCHEMA_VERSION = 1;

export type Platform = 'ios' | 'android' | 'desktop';

/**
 * How a recording ended. `interruption` and `limit` still produce a valid,
 * saved memo — we never discard captured audio just because the stop was
 * involuntary.
 */
export type TerminationReason = 'user' | 'interruption' | 'error' | 'limit';

/**
 * What the browser's audio DSP *actually* did, read back from
 * MediaStreamTrack.getSettings() — not what we requested.
 *
 * We ask for all three to be off because they destroy the signal that pitch
 * detection depends on, but the request is not always honored: Chrome has
 * historically applied AGC regardless of the constraint, and WebKit has
 * ignored echoCancellation (https://bugs.webkit.org/show_bug.cgi?id=179411).
 * Recording reality here lets v2 analysis flag degraded audio as low
 * confidence instead of silently emitting garbage.
 *
 * `null` means the browser declined to report the setting.
 */
export interface DspSettings {
  readonly echoCancellation: boolean | null;
  readonly noiseSuppression: boolean | null;
  readonly autoGainControl: boolean | null;
}

/** Immutable facts about a capture. Never edited after the memo is created. */
export interface CaptureInfo {
  /** MediaRecorder.mimeType read AFTER start() — the authoritative container. */
  readonly mimeType: string;
  /** What we asked for. Kept only for debugging negotiation. */
  readonly requestedMimeType: string;
  /**
   * Wall-clock duration measured during capture.
   *
   * Never derived from HTMLMediaElement.duration: MediaRecorder writes the
   * WebM header before it knows the length, so the element reports Infinity
   * (https://bugzilla.mozilla.org/show_bug.cgi?id=1385699).
   */
  readonly durationMs: number;
  readonly byteLength: number;
  /** null when the UA won't report it. */
  readonly sampleRate: number | null;
  readonly channelCount: number;
  readonly dsp: DspSettings;
  readonly deviceLabel: string | null;
  readonly capturedAt: number;
  readonly platform: Platform;
  readonly terminatedBy: TerminationReason;
}

/**
 * Denormalized onto Memo so "which memos need re-analysis?" is a single index
 * scan over `memos`, without touching the audio or analyses stores.
 */
export interface AnalysisState {
  currentAnalysisId: AnalysisId | null;
  algorithmId: string;
  algorithmVersion: string;
  status: 'none' | 'pending' | 'running' | 'ok' | 'failed' | 'unsupported';
  updatedAt: number;
}

/** Memo metadata. Deliberately holds no audio bytes — see AudioAsset. */
export interface Memo {
  id: MemoId;
  schemaVersion: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** SHA-256 of the audio bytes. Ties derived data to exact input. */
  audioHash: string;
  capture: CaptureInfo;
  /** null until v2 analysis exists. */
  analysisState: AnalysisState | null;
  /** null until v3 scores exist. */
  currentScoreId: ScoreId | null;
  tags?: string[];
  /** Set for soft delete / undo; absent or null means live. */
  deletedAt?: number | null;
}

/**
 * The audio bytes, in their own store so listing memos never deserializes
 * them.
 *
 * Stored as ArrayBuffer rather than Blob because Blobs cannot be written to
 * IndexedDB at all in iOS Private Browsing
 * (https://bugs.webkit.org/show_bug.cgi?id=198278), and because ArrayBuffer is
 * transferable — v2 hands it to the analysis worker with zero copy.
 */
export interface AudioAsset {
  memoId: MemoId;
  data: ArrayBuffer;
  mimeType: string;
  byteLength: number;
}

/** A note quantized to equal temperament. */
export interface QuantizedNote {
  /** MIDI note number, 0..127. */
  midi: number;
  startMs: number;
  durationMs: number;
  /**
   * Signed deviation from equal temperament, in cents.
   *
   * Retained rather than discarded at quantization: a tune sung consistently
   * 40 cents flat is a fact about the performance, not noise.
   */
  centsDeviation: number;
  confidence: number;
  velocity?: number;
}

// --- v2: analysis. Types ship now so adding analysis needs no migration. ---

/**
 * Machine analysis output. Versioned, disposable, regenerable at any time.
 * Never edited by the user.
 */
export interface AnalysisRecord {
  id: AnalysisId;
  memoId: MemoId;
  /** Must match Memo.audioHash; a mismatch means this result is invalid. */
  audioHash: string;
  algorithmId: string;
  algorithmVersion: string;
  params: Record<string, unknown>;
  createdAt: number;
  computeMs: number;
  status: 'pending' | 'running' | 'ok' | 'failed';
  error?: { code: string; message: string };
  input: {
    /** Rate the analysis ran at, not the capture rate. */
    sampleRate: number;
    frameSizeSamples: number;
    hopSizeSamples: number;
    frameCount: number;
  };
  /**
   * Dense per-frame tracks, held as ArrayBuffers (Float32Array.buffer) rather
   * than number[] — roughly 10x smaller and far cheaper to structured-clone.
   * NaN in `hz` marks an unvoiced frame.
   */
  f0: {
    hz: ArrayBuffer;
    confidence: ArrayBuffer;
    rms: ArrayBuffer;
  };
  tuning: {
    referenceA4Hz: number;
    /** Overall flat/sharp bias of the performance. */
    estimatedOffsetCents: number;
  };
  notes: QuantizedNote[];
  quality: {
    voicedRatio: number;
    medianConfidence: number;
    warnings: string[];
  };
}

// --- v3: the user's score. ---

/**
 * A note in the user's score. Unlike analysis notes, these carry a stable id:
 * editing operations (drag, delete, keyboard nudges) must reference a note
 * across re-sorts and re-renders, and "the third note" stops meaning anything
 * the moment a drag moves a note past its neighbour.
 */
export interface ScoreNote extends QuantizedNote {
  id: string;
}

/**
 * The user's editable MIDI. Seeded from an AnalysisRecord once, then wholly
 * independent of it.
 */
export interface ScoreDocument {
  id: ScoreId;
  memoId: MemoId;
  createdAt: number;
  updatedAt: number;
  seededFromAnalysisId: AnalysisId | null;
  /**
   * Set true the moment the user edits a note. Blocks any automatic re-seed
   * from a newer analysis — losing hand edits to a background re-analysis is
   * the failure this whole layer split exists to prevent.
   */
  userEdited: boolean;
  /** Ticks per quarter note, for MIDI export. */
  ppq: number;
  tempoBpm: number;
  /** Kept sorted by startMs; every edit operation preserves this. */
  notes: ScoreNote[];
}

/** A recording handed from the capture layer to the UI, before it is saved. */
export interface CapturedAudio {
  data: ArrayBuffer;
  capture: CaptureInfo;
}
