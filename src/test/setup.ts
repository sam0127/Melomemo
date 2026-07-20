import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';

/**
 * jsdom ships getRandomValues but not SubtleCrypto, which the audio hashing
 * needs. Node's implementation is spec-compliant, so it stands in rather than
 * the code under test having to know it is being tested.
 */
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}
