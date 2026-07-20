import { fireEvent, render } from '@testing-library/react';
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
    return container.querySelector('.piano-roll__playhead')!;
  }

  it('stays hidden on an idle chart that cannot be scrubbed', () => {
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        transport="idle"
        getPositionMs={() => 0}
      />,
    );
    expect(playhead(container).style.display).toBe('none');
    expect(rafCallbacks).toHaveLength(0);
  });

  it('stays visible when paused, showing where playback will resume', () => {
    // The reason it is drawn at rest: the resume point has to be visible.
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        transport="paused"
        getPositionMs={() => 4000}
      />,
    );
    const geometry = createRollGeometry(NOTES, DURATION_MS);
    expect(playhead(container).style.display).not.toBe('none');
    expect(playhead(container).getAttribute('transform')).toBe(
      `translate(${geometry.xForMs(4000).toFixed(2)} 0)`,
    );
    // Nothing is moving, so no animation frames should be burned.
    expect(rafCallbacks).toHaveLength(0);
  });

  it('is shown at rest when scrubbable, so there is something to grab', () => {
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        transport="idle"
        getPositionMs={() => 0}
        scrubber={{ onScrubStart: () => {}, onScrubEnd: () => {} }}
      />,
    );
    expect(playhead(container).style.display).not.toBe('none');
  });

  it('moves to the position the player reports, in the renderer’s own geometry', () => {
    let position = 0;
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        transport="playing"
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
        transport="playing"
        getPositionMs={() => 0}
      />,
    );
    expect(rafCallbacks.length).toBeGreaterThan(0);
    fireFrame();
    // Each tick must schedule the next, or the playhead silently stops.
    expect(rafCallbacks.length).toBeGreaterThan(0);
  });

  describe('scrubbing', () => {
    function renderScrubbable(position = 0) {
      const scrubber = { onScrubStart: vi.fn(), onScrubEnd: vi.fn() };
      const utils = render(
        <PianoRoll
          notes={NOTES}
          durationMs={DURATION_MS}
          transport="paused"
          getPositionMs={() => position}
          scrubber={scrubber}
        />,
      );
      return { scrubber, ...utils };
    }

    it('pauses before the drag and seeks once on release', () => {
      // jsdom reports a zero rect for the SVG, so client x maps straight to
      // content x — the playhead goes to wherever the pointer is dragged.
      const { scrubber, container } = renderScrubbable(2000);
      const grab = container.querySelector('.piano-roll__playhead-grab')!;
      const geometry = createRollGeometry(NOTES, DURATION_MS);
      const target = geometry.xForMs(5000);

      fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientX: geometry.xForMs(2000), clientY: 10 });
      // Pausing first is what keeps the audio from being torn down and
      // rebuilt on every frame of the drag.
      expect(scrubber.onScrubStart).toHaveBeenCalledTimes(1);
      expect(scrubber.onScrubEnd).not.toHaveBeenCalled();

      fireEvent.pointerMove(grab, { pointerId: 1, clientX: target, clientY: 10 });
      fireEvent.pointerMove(grab, { pointerId: 1, clientX: target, clientY: 10 });
      // Still nothing committed mid-drag.
      expect(scrubber.onScrubEnd).not.toHaveBeenCalled();

      fireEvent.pointerUp(grab, { pointerId: 1, clientX: target, clientY: 10 });
      expect(scrubber.onScrubEnd).toHaveBeenCalledTimes(1);
      expect(vi.mocked(scrubber.onScrubEnd).mock.calls[0]![0]).toBeCloseTo(5000, 0);
    });

    it('moves the playhead to where the pointer is, not by how far it dragged', () => {
      const { container } = renderScrubbable(0);
      const grab = container.querySelector('.piano-roll__playhead-grab')!;
      const geometry = createRollGeometry(NOTES, DURATION_MS);
      const target = geometry.xForMs(2500);

      fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientX: 0, clientY: 10 });
      fireEvent.pointerMove(grab, { pointerId: 1, clientX: target, clientY: 10 });

      // Absolute positioning is what lets an auto-scroll advance the playhead:
      // scrolling moves the content under a still finger, so "where the pointer
      // is" becomes a later time.
      expect(playhead(container).getAttribute('transform')).toBe(
        `translate(${geometry.xForMs(2500).toFixed(2)} 0)`,
      );
    });

    it('scrolls the chart when a scrub is held at the edge, carrying it on', () => {
      // The point of the whole change: the playhead is drawn under the finger,
      // so reaching a time outside the visible window is only possible if the
      // chart scrolls itself while the finger sits at the edge.
      const { container } = renderScrubbable(0);
      const scroller = container.querySelector<HTMLElement>('.piano-roll__scroll')!;
      Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
      Object.defineProperty(scroller, 'scrollWidth', { value: 1000, configurable: true });
      const grab = container.querySelector('.piano-roll__playhead-grab')!;

      fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientX: 150, clientY: 10 });
      // Held near the right edge, then stopped.
      fireEvent.pointerMove(grab, { pointerId: 1, clientX: 290, clientY: 10 });
      expect(scroller.scrollLeft).toBe(0);

      // The edge loop keeps going though the finger has not moved.
      fireFrame();
      fireFrame();
      expect(scroller.scrollLeft).toBeGreaterThan(0);
    });

    it('stops the edge scroll once the pointer is released', () => {
      const { container } = renderScrubbable(0);
      const scroller = container.querySelector<HTMLElement>('.piano-roll__scroll')!;
      Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
      Object.defineProperty(scroller, 'scrollWidth', { value: 1000, configurable: true });
      const grab = container.querySelector('.piano-roll__playhead-grab')!;

      fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientX: 290, clientY: 10 });
      fireEvent.pointerUp(grab, { pointerId: 1, clientX: 290, clientY: 10 });

      // No frames should remain scheduled, or the chart would scroll forever.
      const scrolledBefore = scroller.scrollLeft;
      fireFrame();
      expect(scroller.scrollLeft).toBe(scrolledBefore);
    });

    it('never scrubs outside the recording', () => {
      const { scrubber, container } = renderScrubbable(0);
      const grab = container.querySelector('.piano-roll__playhead-grab')!;

      fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientX: 0, clientY: 10 });
      fireEvent.pointerMove(grab, { pointerId: 1, clientX: -5000, clientY: 10 });
      fireEvent.pointerUp(grab, { pointerId: 1, clientX: -5000, clientY: 10 });

      expect(vi.mocked(scrubber.onScrubEnd).mock.calls[0]![0]).toBe(0);
    });

    it('is a slider for assistive tech, with keyboard seeking', () => {
      const { scrubber, container } = renderScrubbable(1000);
      const grab = container.querySelector('.piano-roll__playhead-grab')!;
      expect(grab.getAttribute('role')).toBe('slider');
      expect(grab.getAttribute('aria-valuenow')).toBe('1000');

      fireEvent.keyDown(grab, { key: 'ArrowRight' });
      expect(scrubber.onScrubEnd).toHaveBeenCalledWith(1250);

      fireEvent.keyDown(grab, { key: 'Home' });
      expect(scrubber.onScrubEnd).toHaveBeenCalledWith(0);
    });
  });

  it('scrolls to follow the playhead only once it leaves the visible window', () => {
    let position = 0;
    const { container } = render(
      <PianoRoll
        notes={NOTES}
        durationMs={DURATION_MS}
        transport="playing"
        getPositionMs={() => position}
      />,
    );

    const scroller = container.querySelector<HTMLElement>('.piano-roll__scroll')!;
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
