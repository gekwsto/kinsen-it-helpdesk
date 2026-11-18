/**
 * Focused regression for the crash fix in
 * scripts/diagnose-attachment-graph-recovery.ts: a real production run
 * (`--limit=22` full inventory) crashed with
 * `RangeError: Maximum call stack size exceeded` at `RegExp.test` inside
 * `isStrictlyValidBase64`, on a multi-megabyte attachment's base64
 * payload. Reproduced directly against the OLD implementation (the regex
 * `/^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/`)
 * with an 8 MB payload (11.2M-character base64 string) before writing this
 * fix — it threw every time, regardless of whether the content was valid.
 *
 * Root cause: V8's irregexp engine implements a quantified GROUP followed
 * by a trailing alternation as a backtracking match that recurses once
 * per repetition rather than looping — not catastrophic (exponential)
 * backtracking, just enough native-stack depth, proportional to input
 * size, to exceed V8's call stack limit once the input reaches millions
 * of characters. No ReDoS pattern is involved; the regex itself has no
 * ambiguous repetition.
 *
 * Fix: replaced the regex with a manual, single-pass character-code scan
 * (plain iterative `for` loop, O(n) time, O(1) additional space) — no
 * regex engine, no recursion, no backtracking, so there is no input size
 * at which this can exhaust the call stack, by construction.
 *
 * This test calls `isStrictlyValidBase64`/`checkContentBytes` DIRECTLY —
 * both now live in their own side-effect-free module,
 * scripts/attachment-graph-recovery-base64.ts, imported here instead of
 * the diagnostic script itself (importing the diagnostic would trigger
 * its own `main()` as a side effect, hitting the real DB/Graph pipeline —
 * unnecessary and slow for multi-megabyte fixtures, and the bug/fix live
 * entirely inside these two pure functions, not in the surrounding
 * matching/correlation logic, which this test does not touch and is
 * already covered by test-attachment-graph-recovery-matching.ts and
 * test-attachment-graph-recovery-dry-run.ts).
 *
 * Covers:
 *   - A large (8 MB) VALID base64 payload — must not throw, must
 *     validate as well-formed, and must report the correct decoded
 *     length when compared against the matching expected size.
 *   - The SAME large payload with one character replaced by a non-base64
 *     character deep inside it — must fail closed (malformed), not
 *     throw, not silently decode into a wrong-but-plausible value.
 *   - The SAME large payload truncated to a shorter (still 4-aligned)
 *     prefix — must decode cleanly (valid base64) but to fewer bytes than
 *     expected, i.e. a genuine length mismatch, never "malformed."
 *   - A large payload with invalid padding (an `=` character appearing
 *     before the end, not just as trailing padding) — must fail closed
 *     (malformed), not throw.
 *   - Legitimate zero-byte content (`""`) — still correctly "usable" when
 *     the expected size is 0 (the round-4 fix), re-verified here
 *     alongside the large-payload cases so one test file covers the full
 *     size spectrum.
 *   - A stack-safety sanity check: validating the 8 MB payload completes
 *     well under a generous time bound, confirming no accidental
 *     reintroduction of a slow or recursive implementation.
 *
 * Usage: npx tsx scripts/test-attachment-graph-recovery-base64-validation.ts
 */
import { isStrictlyValidBase64, checkContentBytes } from "@/scripts/attachment-graph-recovery-base64";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function runsWithoutThrowing(fn: () => void): { threw: false } | { threw: true; error: unknown } {
  try {
    fn();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

// 8 MB of raw bytes -> an 11.2M-character base64 string — the exact size
// class that crashed the previous regex-based implementation.
const LARGE_RAW_SIZE = 8 * 1024 * 1024;
const largeBuffer = Buffer.alloc(LARGE_RAW_SIZE, 65 /* 'A' */);
const largeValidBase64 = largeBuffer.toString("base64");

function main() {
  console.log(`Large payload: ${LARGE_RAW_SIZE} raw bytes -> ${largeValidBase64.length} base64 characters\n`);

  // ── Large valid payload: must not throw, must validate, must decode to
  //    the exact expected length. ──
  const validResult = runsWithoutThrowing(() => isStrictlyValidBase64(largeValidBase64));
  check("isStrictlyValidBase64 does NOT throw on an 8 MB valid payload", !validResult.threw, validResult.threw ? String(validResult.error) : undefined);
  check("8 MB valid payload is classified well-formed", !validResult.threw && isStrictlyValidBase64(largeValidBase64) === true);

  const start = Date.now();
  isStrictlyValidBase64(largeValidBase64);
  const elapsedMs = Date.now() - start;
  check(`Validating the 8 MB payload completes well under budget (took ${elapsedMs}ms, bound 5000ms)`, elapsedMs < 5000);

  const checkValid = checkContentBytes(largeValidBase64, LARGE_RAW_SIZE);
  check("checkContentBytes reports \"usable\" for the large valid payload against its true size", checkValid.status === "usable" && checkValid.length === LARGE_RAW_SIZE);

  // ── Same large payload, one character deep inside swapped for a
  //    non-base64 character — must fail closed as malformed, never throw,
  //    never silently decode into a wrong-but-plausible value. ──
  const midpoint = Math.floor(largeValidBase64.length / 2);
  const corruptedChars = largeValidBase64.split("");
  corruptedChars[midpoint] = "!";
  const corruptedLargeBase64 = corruptedChars.join("");
  const corruptedResult = runsWithoutThrowing(() => isStrictlyValidBase64(corruptedLargeBase64));
  check("isStrictlyValidBase64 does NOT throw on a large payload corrupted deep inside", !corruptedResult.threw, corruptedResult.threw ? String(corruptedResult.error) : undefined);
  check("Large payload corrupted deep inside is classified malformed", !corruptedResult.threw && isStrictlyValidBase64(corruptedLargeBase64) === false);
  const checkCorrupted = checkContentBytes(corruptedLargeBase64, LARGE_RAW_SIZE);
  check("checkContentBytes reports \"malformed_base64\" for the corrupted large payload", checkCorrupted.status === "malformed_base64");

  // ── Same large payload truncated to a shorter, still-4-aligned, still
  //    VALID base64 prefix — simulates a truncated/corrupted Graph
  //    response that is nonetheless well-formed base64 decoding to fewer
  //    bytes than expected: a genuine length mismatch, never "malformed." ──
  const truncatedLength = Math.floor(largeValidBase64.length / 2 / 4) * 4; // keep 4-alignment
  const truncatedLargeBase64 = largeValidBase64.slice(0, truncatedLength);
  const truncatedResult = runsWithoutThrowing(() => isStrictlyValidBase64(truncatedLargeBase64));
  check("isStrictlyValidBase64 does NOT throw on a large truncated payload", !truncatedResult.threw, truncatedResult.threw ? String(truncatedResult.error) : undefined);
  check("Large truncated (but still well-formed) payload is classified VALID base64", !truncatedResult.threw && isStrictlyValidBase64(truncatedLargeBase64) === true);
  const checkTruncated = checkContentBytes(truncatedLargeBase64, LARGE_RAW_SIZE);
  check("checkContentBytes reports \"length_mismatch\" (not malformed) for the truncated large payload", checkTruncated.status === "length_mismatch" && typeof checkTruncated.length === "number" && checkTruncated.length < LARGE_RAW_SIZE);

  // ── Large payload with invalid padding: an '=' character injected
  //    before the end, not as trailing padding — must fail closed. ──
  const invalidPaddingChars = largeValidBase64.split("");
  invalidPaddingChars[midpoint] = "=";
  const invalidPaddingLargeBase64 = invalidPaddingChars.join("");
  const invalidPaddingResult = runsWithoutThrowing(() => isStrictlyValidBase64(invalidPaddingLargeBase64));
  check("isStrictlyValidBase64 does NOT throw on a large payload with invalid mid-string padding", !invalidPaddingResult.threw, invalidPaddingResult.threw ? String(invalidPaddingResult.error) : undefined);
  check("Large payload with '=' injected mid-string is classified malformed", !invalidPaddingResult.threw && isStrictlyValidBase64(invalidPaddingLargeBase64) === false);

  // ── Small, explicit invalid-padding cases (fast, precise, independent
  //    of payload size). ──
  check('"A===" (3 trailing pads) is malformed', isStrictlyValidBase64("A===") === false);
  check('"====" (4 trailing pads, no data) is malformed', isStrictlyValidBase64("====") === false);
  check('"AB==AB==" (padding chars not only at the very end) is malformed', isStrictlyValidBase64("AB==AB==") === false);
  check('"AA==" (legitimate 2-pad quantum) is well-formed', isStrictlyValidBase64("AA==") === true);
  check('"AAA=" (legitimate 1-pad quantum) is well-formed', isStrictlyValidBase64("AAA=") === true);

  // ── Zero-byte content — re-verified here alongside the large-payload
  //    cases so this file covers the full size spectrum end to end. ──
  check('Empty string is well-formed base64 (0 bytes)', isStrictlyValidBase64("") === true);
  const checkZeroByte = checkContentBytes("", 0);
  check('checkContentBytes reports "usable" for empty contentBytes against expected size 0', checkZeroByte.status === "usable" && checkZeroByte.length === 0);
  const checkMissingZero = checkContentBytes(undefined, 0);
  check('checkContentBytes reports "absent" (not "usable") when the field is MISSING, even if expected size is 0', checkMissingZero.status === "absent");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
