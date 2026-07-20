/**
 * UUIDv7 — time-ordered identifiers.
 *
 * Chosen over v4 because IndexedDB keys are stored in sorted order, so
 * time-sortable ids keep newly written memos contiguous and make
 * chronological cursor walks cheap. The tradeoff is that the id leaks its
 * creation time, which is fine here: createdAt is stored in the clear anyway.
 *
 * Layout (RFC 9562): 48-bit big-endian ms timestamp, 4-bit version, 12 bits
 * random, 2-bit variant, 62 bits random.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);

  // 48-bit timestamp. Split to stay within the 32-bit range of bitwise ops.
  const timeHigh = Math.floor(now / 0x1_0000_0000);
  const timeLow = now >>> 0;
  bytes[0] = (timeHigh >>> 8) & 0xff;
  bytes[1] = timeHigh & 0xff;
  bytes[2] = (timeLow >>> 24) & 0xff;
  bytes[3] = (timeLow >>> 16) & 0xff;
  bytes[4] = (timeLow >>> 8) & 0xff;
  bytes[5] = timeLow & 0xff;

  crypto.getRandomValues(bytes.subarray(6));

  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
