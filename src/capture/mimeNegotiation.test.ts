import { describe, expect, it } from 'vitest';
import {
  extensionForMimeType,
  negotiateMimeType,
  UA_DEFAULT_MIME,
} from './mimeNegotiation.ts';

/**
 * Negotiation is exercised against simulated capability matrices rather than a
 * real browser, since the whole point is behaviour on engines this test run
 * will never execute in.
 */
function supporting(...types: string[]) {
  return (type: string) => types.includes(type);
}

describe('negotiateMimeType', () => {
  it('gives Safari an MP4 container with an explicit codec', () => {
    // Safari before 18.4: MP4 only.
    const isSupported = supporting('audio/mp4;codecs=mp4a.40.2', 'audio/mp4');
    expect(negotiateMimeType(isSupported)).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('gives Chrome and Android WebM/Opus', () => {
    const isSupported = supporting('audio/webm;codecs=opus', 'audio/webm');
    expect(negotiateMimeType(isSupported)).toBe('audio/webm;codecs=opus');
  });

  it('falls back to Ogg for Firefox builds without WebM recording', () => {
    const isSupported = supporting('audio/ogg;codecs=opus');
    expect(negotiateMimeType(isSupported)).toBe('audio/ogg;codecs=opus');
  });

  it('keeps preferring MP4 on Safari 18.4+, which also reports WebM', () => {
    // Newer Safari supports both. Preferring WebM here would gain nothing and
    // diverge from what every earlier iOS version produces.
    const isSupported = supporting(
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
    );
    expect(negotiateMimeType(isSupported)).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('defers to the browser default when nothing probes as supported', () => {
    expect(negotiateMimeType(() => false)).toBe(UA_DEFAULT_MIME);
  });

  it('defers to the browser default when isTypeSupported is missing', () => {
    // Some older WebKit builds expose MediaRecorder without the probe.
    expect(negotiateMimeType(null)).toBe(UA_DEFAULT_MIME);
  });

  it('treats a throwing probe as unsupported and keeps walking the chain', () => {
    const isSupported = (type: string) => {
      if (type.startsWith('audio/mp4')) throw new TypeError('bad argument');
      return type === 'audio/webm;codecs=opus';
    };
    expect(negotiateMimeType(isSupported)).toBe('audio/webm;codecs=opus');
  });
});

describe('extensionForMimeType', () => {
  it('maps the containers MediaRecorder actually produces', () => {
    expect(extensionForMimeType('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMimeType('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('is case and whitespace tolerant', () => {
    expect(extensionForMimeType('AUDIO/MP4 ; codecs=x')).toBe('m4a');
  });

  it('falls back to webm for an unknown container', () => {
    expect(extensionForMimeType('audio/weird')).toBe('webm');
    expect(extensionForMimeType('')).toBe('webm');
  });
});
