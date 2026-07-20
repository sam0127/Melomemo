import type { Platform } from './types.ts';

/**
 * Coarse platform detection.
 *
 * Used only to record capture provenance and to decide which recovery advice
 * to show (iOS permission re-enabling and the Safari/home-screen storage split
 * are genuinely platform-specific). Never used to gate a feature — capability
 * checks do that.
 */
export function detectPlatform(ua: string = navigator.userAgent): Platform {
  if (/android/i.test(ua)) return 'android';
  // iPadOS 13+ reports itself as Macintosh; the touch-point count is the
  // standard way to tell an iPad from a Mac.
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) {
    return 'ios';
  }
  return 'desktop';
}

export function isIos(): boolean {
  return detectPlatform() === 'ios';
}

/** True when running as an installed PWA rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // navigator.standalone is the iOS-only signal; the media query covers the rest.
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}
