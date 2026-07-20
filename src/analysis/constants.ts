/**
 * Tuning parameters for the transcription pipeline.
 *
 * Collected here because these are the knobs worth turning when a real
 * recording transcribes badly, and because every one of them is a tradeoff
 * rather than a correct answer.
 */

/**
 * Rate the analysis runs at. Audio is resampled to this on decode.
 *
 * Not the capture rate (usually 48 kHz): the pitch work costs roughly linearly
 * in sample count, and nothing above ~8 kHz carries fundamental frequency.
 * 22.05 kHz rather than the more obvious 16 kHz because whistling — a stated
 * use case — commonly sits at 1–3 kHz, and at 16 kHz a 2.5 kHz tone spans only
 * about six samples per period, which is thin for a period-based estimator.
 */
export const ANALYSIS_RATE = 22050;

/**
 * Analysis window, in samples. ~46 ms.
 *
 * The floor on detectable pitch: a period-based method needs at least two
 * periods in the window, so this sets the lowest usable f0 at roughly
 * 2 * 22050 / 1024 ≈ 43 Hz — comfortably below the lowest sung note. Longer
 * windows would track low notes more stably but smear the boundary between
 * two quick notes, which matters more here.
 */
export const FRAME_SIZE = 1024;

/** Step between windows, in samples. ~11.6 ms — the timing resolution of a note edge. */
export const HOP_SIZE = 256;

/**
 * Minimum McLeod clarity for a frame to count as pitched.
 *
 * McLeod's paper suggests 0.8–0.9 for clean signals. Lowered here because
 * singing with vibrato, breathy tone, and phone microphones all depress
 * clarity, and missing real notes is worse than admitting a few weak frames
 * that segmentation will discard anyway.
 */
export const MIN_CLARITY = 0.72;

/**
 * Loudness floor relative to the recording's peak, in dB.
 *
 * Relative rather than absolute because recording level varies enormously
 * between a phone at arm's length and a headset. Anything this far below the
 * loudest moment is treated as silence.
 */
export const SILENCE_FLOOR_DB = -42;

/** Absolute floor, to stop a recording of near-silence being scaled up into noise. */
export const ABSOLUTE_SILENCE_RMS = 0.0015;

/**
 * Plausible range for a sung or whistled fundamental, in Hz.
 *
 * A hard sanity check, not a preference. Period-based estimators fail toward
 * *subharmonics* — reporting half or a third of the true frequency — and near
 * the edge of the window they will confidently report a period longer than the
 * signal supports. A2 is below the lowest note a bass hums; 4200 Hz is above
 * the highest whistle. Anything outside is an artefact by definition, so it is
 * cheaper and safer to discard it than to try to repair it downstream.
 */
export const MIN_F0_HZ = 55;
export const MAX_F0_HZ = 4200;

/**
 * Median filter width, in frames (~58 ms).
 *
 * The main defence against octave errors: period-based estimators
 * intermittently report half or double the true frequency, and those errors
 * are isolated spikes that a median rejects while leaving real note
 * transitions intact.
 */
export const MEDIAN_WINDOW_FRAMES = 5;

/** Notes shorter than this are treated as artefacts rather than intent. */
export const MIN_NOTE_MS = 70;

/**
 * Unvoiced gap that does not end a note.
 *
 * Consonants, breaths, and brief clarity dropouts interrupt an otherwise
 * continuous note; splitting on every one of them would shred a held tone
 * into fragments.
 */
export const MAX_GAP_MS = 60;

/**
 * Pitch change that starts a new note, in semitones.
 *
 * Wide enough that vibrato (typically ±0.5 semitone or less) does not split a
 * held note, narrow enough to catch a real step of one semitone.
 */
export const SPLIT_SEMITONES = 0.7;

/** Consecutive frames that must exceed SPLIT_SEMITONES before a note is actually split. */
export const SPLIT_CONFIRM_FRAMES = 3;

export const framesToMs = (frames: number): number =>
  (frames * HOP_SIZE * 1000) / ANALYSIS_RATE;

/** Time at the centre of a frame — the window spans FRAME_SIZE, so its centre represents it. */
export const frameCentreMs = (frameIndex: number): number =>
  ((frameIndex * HOP_SIZE + FRAME_SIZE / 2) * 1000) / ANALYSIS_RATE;
