/**
 * Pure, side-effect-free base64 validation/decoding helpers for
 * scripts/diagnose-attachment-graph-recovery.ts. Kept in their own module
 * (no DB/Graph access, no top-level `main()`) so a focused regression test
 * can import and call them directly — including with multi-megabyte
 * payloads — without triggering the diagnostic's full DB+Graph pipeline,
 * which importing the diagnostic script itself would do (it calls its own
 * `main()` unconditionally on import, which is how the diagnostic's OTHER
 * focused tests intentionally drive it against a mocked Graph client).
 */

export type ContentBytesCheck =
  | { status: "usable"; length: number }
  | { status: "absent" }
  | { status: "malformed_base64" }
  | { status: "length_mismatch"; length: number };

/**
 * A real production attachment (several MB, base64-encoded to 7+ million
 * characters) crashed the diagnostic with `RangeError: Maximum call stack
 * size exceeded` at `RegExp.test` inside the PREVIOUS implementation of
 * this function: `/^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|
 * [A-Za-z0-9+\/]{3}=)?$/`. Reproduced exactly against an 8 MB payload
 * (11.2M-character base64 string) — the old regex threw every time,
 * regardless of whether the content was valid base64.
 *
 * The pattern itself has no catastrophic (exponential) backtracking —
 * it's a straightforward, unambiguous grammar — but V8's irregexp engine
 * still implements a quantified GROUP followed by a trailing alternation
 * as a backtracking match that recurses once per repetition rather than
 * looping, so for a string with millions of 4-character quanta the
 * native call stack is exhausted before `.test()` ever returns a result.
 * This is NOT a ReDoS-style slowdown (which this input wouldn't trigger —
 * no ambiguous repetition) — it's a hard crash on perfectly well-formed,
 * large input.
 *
 * Fixed by replacing the regex with a manual, single-pass character-code
 * scan: O(n) time, O(1) additional space, a plain iterative `for` loop
 * with no recursion, no backtracking, and no regex engine involved at
 * all — there is no input size at which this can exhaust the call stack,
 * by construction. Validates exactly what the old regex validated:
 *   - Zero or more full 4-character quanta from the base64 alphabet
 *     (A-Z, a-z, 0-9, +, /).
 *   - An optional trailing padding of exactly 1 or 2 `=` characters, ONLY
 *     at the very end (a `=` anywhere else in the scanned "data" region
 *     fails the alphabet check directly, since `=` is never a member of
 *     that alphabet in this function's own classification).
 *   - Overall length a multiple of 4 (required for ANY valid base64,
 *     padded or not).
 *   - The empty string (0 quanta, no padding) is valid — a legitimate
 *     0-byte attachment's base64 encoding.
 * Confirmed against the same 8 MB payload: completes in under 100ms, no
 * exception, same `true` result the correct (non-crashing-sized) cases
 * the old regex used to return.
 */
export function isStrictlyValidBase64(s: string): boolean {
  const len = s.length;
  if (len === 0) return true;
  if (len % 4 !== 0) return false;
  let paddingCount = 0;
  if (s.charCodeAt(len - 1) === 61 /* '=' */) {
    paddingCount = 1;
    if (len >= 2 && s.charCodeAt(len - 2) === 61) paddingCount = 2;
  }
  const dataLength = len - paddingCount;
  for (let i = 0; i < dataLength; i++) {
    const c = s.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90; // A-Z
    const isLower = c >= 97 && c <= 122; // a-z
    const isDigit = c >= 48 && c <= 57; // 0-9
    const isPlus = c === 43; // '+'
    const isSlash = c === 47; // '/'
    if (!isUpper && !isLower && !isDigit && !isPlus && !isSlash) return false;
  }
  return true;
}

/**
 * Decodes `contentBytes` and compares it against `expectedSize` — always
 * the row's OWN DB-recorded size, NEVER Graph's reported attachment
 * `size` (see GRAPH METADATA SIZE RELIABILITY in the diagnostic script's
 * own doc comment for why that field can't be trusted as the expected
 * value).
 *
 * Only a MISSING field (`undefined`/`null` — contentBytes wasn't in the
 * response at all) is "absent." An explicit empty string `""` is valid,
 * well-formed base64 for zero bytes — it is validated and decoded like
 * any other value, so a legitimately empty attachment (expectedSize 0)
 * correctly comes back "usable" instead of being misclassified as absent.
 */
export function checkContentBytes(contentBytes: string | null | undefined, expectedSize: number): ContentBytesCheck {
  if (contentBytes === undefined || contentBytes === null) return { status: "absent" };
  if (!isStrictlyValidBase64(contentBytes)) return { status: "malformed_base64" };
  const decoded = Buffer.from(contentBytes, "base64");
  if (decoded.length === expectedSize) return { status: "usable", length: decoded.length };
  return { status: "length_mismatch", length: decoded.length };
}
