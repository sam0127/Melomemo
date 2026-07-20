import type { AnalysisEngine } from './AnalysisEngine.ts';
import { mpmEngine } from './engines/mpmEngine.ts';

/**
 * Known transcription engines.
 *
 * Old analyses record which engine produced them, so results stay readable
 * after the current engine moves on. Engines are therefore never removed from
 * here, only added.
 */
const engines = new Map<string, AnalysisEngine>([[mpmEngine.algorithmId, mpmEngine]]);

/** The engine new analyses use. Changing this makes every existing analysis stale. */
export const CURRENT_ENGINE = mpmEngine;

export function getEngine(algorithmId: string): AnalysisEngine | null {
  return engines.get(algorithmId) ?? null;
}

/**
 * Whether an analysis was produced by something other than the current engine
 * at its current version, and so would change if recomputed.
 */
export function isStale(algorithmId: string, algorithmVersion: string): boolean {
  return (
    algorithmId !== CURRENT_ENGINE.algorithmId ||
    algorithmVersion !== CURRENT_ENGINE.version
  );
}
