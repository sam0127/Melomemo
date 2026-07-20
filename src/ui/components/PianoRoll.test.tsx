import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuantizedNote } from '../../core/types.ts';
import { createRollGeometry } from '../pianoRollGeometry.ts';
import { PianoRoll } from './PianoRoll.tsx';

/**
 * The playhead cannot be watched live in the browser harness — Chrome
 * suspends requestAnimationFrame entirely for hidden tabs — so its behaviour
 * is pinned down here instead, with rAF stubbed and fired by hand.
 */

const NOTES: QuantizedNote[] = [
  { midi: 60, startMs: 0, durationMs: 1000, centsDeviation: 0, confidence: 0.9 },
  { midi: 64, startMs: 8000, durationMs: 1000, centsDeviation: 0, confidence: 0.9 },
];
const DURATION_MS = 10_000;

describe('PianoRoll playhead', () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Fires the most recently scheduled frame, the way a browser would. */
  function fireFrame() {
    const cb = rafCallbacks.pop();
    rafCallbacks = [];
    cb?.(performance.now());
  }

  function playhead(container: HTMLElement): SVGGElement {
    return container.querySelector('g[aria-hidden]')!;
  }

  it('stays hidden when not playing', () => {
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        isPlaying={false}
        getPositionMs={() => 0}
      />,
    );
    expect(playhead(container).style.display).toBe('none');
    expect(rafCallbacks).toHaveLength(0);
  });

  it('moves to the position the player reports, in the renderer’s own geometry', () => {
    let position = 0;
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        isPlaying={true}
        getPositionMs={() => position}
      />,
    );

    const geometry = createRollGeometry(NOTES, DURATION_MS);

    position = 5000;
    fireFrame();
    // Asserted through the same geometry module the renderer uses, so the
    // playhead and the notes cannot disagree about where a time sits.
    expect(playhead(container).getAttribute('transform')).toBe(
      `translate(${geometry.xForMs(5000).toFixed(2)} 0)`,
    );

    position = 7500;
    fireFrame();
    expect(playhead(container).getAttribute('transform')).toBe(
      `translate(${geometry.xForMs(7500).toFixed(2)} 0)`,
    );
  });

  it('keeps rescheduling itself while playing', () => {
    render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        isPlaying={true}
        getPositionMs={() => 0}
      />,
    );
    expect(rafCallbacks.length).toBeGreaterThan(0);
    fireFrame();
    // Each tick must schedule the next, or the playhead silently stops.
    expect(rafCallbacks.length).toBeGreaterThan(0);
  });

  it('scrolls to follow the playhead only once it leaves the visible window', () => {
    let position = 0;
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        isPlaying={true}
        getPositionMs={() => position}
      />,
    );

    const scroller = container.querySelector<HTMLElement>('.piano-roll')!;
    // jsdom reports zero layout; give the scroller a real viewport width.
    Object.defineProperty(scroller, 'clientWidth', { value: 500 });

    const geometry = createRollGeometry(NOTES, DURATION_MS);

    // Playhead well inside the window: the user's scroll must not be touched.
    position = 1000; // x ≈ 110
    fireFrame();
    expect(scroller.scrollLeft).toBe(0);

    // Past the right edge: follow, keeping a third of the view as lead-in.
    position = 6000; // x ≈ 660
    fireFrame();
    const x = geometry.xForMs(6000);
    expect(scroller.scrollLeft).toBeCloseTo(x - 500 / 3, 1);
  });
});
