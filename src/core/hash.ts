/**
 * SHA-256 over the raw audio bytes.
 *
 * This is what ties derived data to exact input: an AnalysisRecord carries the
 * hash of the audio it was computed from, so a mismatch is an unambiguous
 * "this result is stale" rather than a guess.
 *
 * crypto.subtle requires a secure context (https or localhost), which the app
 * already needs for getUserMedia — so there is no case where recording works
 * but hashing doesn't.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
