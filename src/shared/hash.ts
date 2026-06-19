/**
 * Deterministic 32-bit string hash (djb2-style), rendered as an 8-char
 * uppercase base-36 token. Used to derive stable synthetic IDs for dedup.
 *
 * Shared by canonicalizer, constraintCanonicalizer, and merge — previously each
 * carried a byte-identical private copy.
 */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 8).padEnd(8, "0");
}
