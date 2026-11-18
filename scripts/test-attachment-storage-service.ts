/**
 * Focused regression for lib/attachment-storage-service.ts — the shared
 * durability guard + write-verify-atomic-publish core used by every
 * attachment write path in the app. No database access is needed at all
 * (this module never touches Prisma), so this test runs fast and
 * standalone against a throwaway OS-temp directory.
 *
 * Proves:
 *   A. Non-Linux platform -> verified (the check is skipped, never blocks
 *      local development).
 *   B. Linux + mountinfo WITH an exact entry for UPLOAD_DIR's real path ->
 *      verified.
 *   C. Linux + mountinfo WITHOUT that entry -> NOT verified (this is the
 *      actual historical failure mode — a directory inside the
 *      container's own writable layer, not a distinct mount).
 *   D. A reader that throws, or an UPLOAD_DIR that doesn't exist -> NOT
 *      verified (fails closed on any inability to confirm durability).
 *   E. Caching: the result from the FIRST call is returned on a SECOND
 *      call even with a completely different injected reader — proving
 *      no re-check/polling happens within a process lifetime.
 *   F. writeAttachmentFile: happy path (verified storage) writes,
 *      verifies, and publishes correctly, returning the real sha256/size.
 *   G. writeAttachmentFile: storage NOT verified -> 503, zero filesystem
 *      writes attempted.
 *   H. writeAttachmentFile: destination already exists -> 409, the
 *      pre-existing content is never overwritten.
 *   I. writeAttachmentFile: injected corrupted readback -> 500, temp file
 *      cleaned up, nothing published.
 *   J. copyAttachmentFile: happy path, missing-source failure, and
 *      never-overwrite — the same core, fed from an existing file instead
 *      of a fresh buffer.
 *
 * Usage: npx tsx scripts/test-attachment-storage-service.ts
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const RUN_ID = Date.now();
const TAG = `gstorage-${RUN_ID}`;
const TEMP_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

async function main() {
  await fs.mkdir(TEMP_DIR, { recursive: true });

  const { verifyAttachmentStorage, isAttachmentStorageVerified, resetAttachmentStorageVerificationForTests, writeAttachmentFile, copyAttachmentFile } = await import("@/lib/attachment-storage-service");

  try {
    // ── A — non-Linux is skipped and trusted. ────────────────────────────
    resetAttachmentStorageVerificationForTests();
    const resultA = await verifyAttachmentStorage({ platform: "darwin", uploadDir: TEMP_DIR });
    check("A: non-Linux platform is verified (skipped)", resultA.verified === true);
    check("A: isAttachmentStorageVerified reflects the cached result", isAttachmentStorageVerified() === true);

    // ── B — Linux + a matching mountinfo entry -> verified. ──────────────
    resetAttachmentStorageVerificationForTests();
    const realTempDir = await fs.realpath(TEMP_DIR);
    const goodMountInfo = `36 35 98:0 / ${realTempDir} rw,relatime shared:1 - ext4 /dev/sdb1 rw\n37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultB = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => goodMountInfo });
    check("B: Linux with a matching mountinfo entry is verified", resultB.verified === true);

    // ── C — Linux + mountinfo WITHOUT that entry -> NOT verified. ────────
    resetAttachmentStorageVerificationForTests();
    const badMountInfo = `37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultC = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => badMountInfo });
    check("C: Linux WITHOUT a matching mountinfo entry is NOT verified (the actual historical failure mode)", resultC.verified === false);
    check("C: reason explains it's not covered by any mount other than the root", /NOT covered by any mount other than the container root/i.test(resultC.reason));

    // ── D — reader throws, and a nonexistent UPLOAD_DIR, both fail closed. ─
    resetAttachmentStorageVerificationForTests();
    const resultD1 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => { throw new Error("simulated /proc read failure"); } });
    check("D1: a mountinfo read failure fails closed (NOT verified)", resultD1.verified === false);

    resetAttachmentStorageVerificationForTests();
    const resultD2 = await verifyAttachmentStorage({ platform: "linux", uploadDir: path.join(TEMP_DIR, "does-not-exist-at-all"), mountInfoReader: async () => goodMountInfo });
    check("D2: a nonexistent UPLOAD_DIR fails closed (NOT verified)", resultD2.verified === false);

    // ── D3 — ambiguous/corrupted mountinfo (zero parsed entries, not even
    //    the root "/") fails closed with a DISTINCT reason from "unmounted". ─
    resetAttachmentStorageVerificationForTests();
    const resultD3 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => "" });
    check("D3: empty/corrupted mountinfo fails closed", resultD3.verified === false);
    check("D3: reason distinguishes a corrupted read from a normal 'unmounted' finding", /zero entries parsed/i.test(resultD3.reason));

    // ── D4 — NESTED mount: UPLOAD_DIR is a plain subdirectory of a
    //    separately-mounted PARENT directory, not a mount point itself —
    //    must still be verified (the previous exact-match-only design would
    //    have produced a false negative here). ─────────────────────────────
    resetAttachmentStorageVerificationForTests();
    const parentDir = path.dirname(realTempDir);
    const nestedMountInfo = `36 35 98:0 / ${parentDir} rw,relatime shared:1 - ext4 /dev/sdb1 rw\n37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultD4 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => nestedMountInfo });
    check("D4: UPLOAD_DIR nested inside a separately-mounted PARENT directory is verified (inherits durability)", resultD4.verified === true);

    // ── D5 — octal-escaped mountinfo path (a literal space in the real
    //    path, encoded as \040 per proc(5)) must still match after
    //    unescaping — "canonical path resolution". ────────────────────────
    const spacedDir = path.join(TEMP_DIR, "has a space");
    await fs.mkdir(spacedDir, { recursive: true });
    const realSpacedDir = await fs.realpath(spacedDir);
    const escapedPath = realSpacedDir.replace(/ /g, "\\040");
    resetAttachmentStorageVerificationForTests();
    const escapedMountInfo = `36 35 98:0 / ${escapedPath} rw,relatime shared:1 - ext4 /dev/sdb1 rw\n37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultD5 = await verifyAttachmentStorage({ platform: "linux", uploadDir: spacedDir, mountInfoReader: async () => escapedMountInfo });
    check("D5: an octal-escaped mountinfo path (\\040 for a space) correctly matches the real, unescaped path", resultD5.verified === true);

    // ── D6 — a distinct, nested mount whose filesystem is a known-ephemeral
    //    type (tmpfs) must NOT be trusted, even though it genuinely covers
    //    UPLOAD_DIR and isn't the container root. ───────────────────────────
    resetAttachmentStorageVerificationForTests();
    const tmpfsMountInfo = `36 35 98:0 / ${realTempDir} rw,relatime shared:1 - tmpfs tmpfs rw\n37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultD6 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => tmpfsMountInfo });
    check("D6: a tmpfs-backed mount covering UPLOAD_DIR is NOT verified (ephemeral, does not survive a restart)", resultD6.verified === false);
    check("D6: reason names the ephemeral filesystem type", /ephemeral/i.test(resultD6.reason) && /tmpfs/i.test(resultD6.reason));

    // ── D7 — same as D6, but the ephemeral mount is at an ANCESTOR
    //    directory (the nested-mount case) rather than UPLOAD_DIR itself —
    //    must still be rejected, not just the exact-match case. ─────────────
    resetAttachmentStorageVerificationForTests();
    const tmpfsNestedMountInfo = `36 35 98:0 / ${parentDir} rw,relatime shared:1 - tmpfs tmpfs rw\n37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n`;
    const resultD7 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => tmpfsNestedMountInfo });
    check("D7: a tmpfs-backed mount covering an ANCESTOR of UPLOAD_DIR is also NOT verified", resultD7.verified === false);

    // ── D8 — a legitimate, non-denylisted filesystem type at a nested
    //    mount must still verify correctly (no regression from D6/D7). ──────
    resetAttachmentStorageVerificationForTests();
    const resultD8 = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => nestedMountInfo });
    check("D8: a legitimate (ext4) nested mount still verifies (no regression)", resultD8.verified === true);

    // ── E — caching: the first result sticks even with a different reader
    //    injected on the second call (no re-check/polling). ───────────────
    resetAttachmentStorageVerificationForTests();
    const firstCall = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => badMountInfo });
    const secondCall = await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => goodMountInfo });
    check("E: first call result is NOT verified", firstCall.verified === false);
    check("E: second call returns the SAME cached result, ignoring its own different injected reader (no polling)", secondCall.verified === false && secondCall === firstCall);

    // ── F — writeAttachmentFile happy path (storage forced verified). ────
    resetAttachmentStorageVerificationForTests();
    await verifyAttachmentStorage({ platform: "darwin", uploadDir: TEMP_DIR }); // seed cache as verified
    const happyDir = path.join(TEMP_DIR, "ticket-happy");
    const happyBuffer = Buffer.from("happy path attachment content");
    const happyResult = await writeAttachmentFile(happyBuffer, happyDir, "happy.bin");
    check("F: happy-path write succeeds", happyResult.ok === true);
    if (happyResult.ok) {
      check("F: reports the correct sha256", happyResult.sha256 === createHash("sha256").update(happyBuffer).digest("hex"));
      check("F: reports the correct size", happyResult.size === happyBuffer.length);
    }
    const happyFilePath = path.join(happyDir, "happy.bin");
    check("F: file exists on disk with the exact bytes", (await fs.readFile(happyFilePath)).equals(happyBuffer));
    const happyDirEntries = await fs.readdir(happyDir);
    check("F: no stray temp file left behind after a successful publish", happyDirEntries.length === 1 && happyDirEntries[0] === "happy.bin");

    // ── G — storage NOT verified -> 503, zero filesystem writes attempted. ─
    resetAttachmentStorageVerificationForTests();
    await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_DIR, mountInfoReader: async () => badMountInfo }); // seed cache as UNverified
    const unverifiedDir = path.join(TEMP_DIR, "ticket-unverified");
    const unverifiedResult = await writeAttachmentFile(Buffer.from("should never be written"), unverifiedDir, "nope.bin");
    check("G: write is refused with statusCode 503 when storage is not verified", !unverifiedResult.ok && unverifiedResult.statusCode === 503);
    check("G: the destination directory was never even created", !(await pathExists(unverifiedDir)));

    // Re-seed as verified for the remaining scenarios.
    resetAttachmentStorageVerificationForTests();
    await verifyAttachmentStorage({ platform: "darwin", uploadDir: TEMP_DIR });

    // ── H — never overwrite an existing destination. ─────────────────────
    const overwriteDir = path.join(TEMP_DIR, "ticket-overwrite");
    await fs.mkdir(overwriteDir, { recursive: true });
    const sentinel = Buffer.from("PRE-EXISTING SENTINEL — MUST NEVER CHANGE");
    await fs.writeFile(path.join(overwriteDir, "existing.bin"), sentinel);
    const overwriteResult = await writeAttachmentFile(Buffer.from("different, attempted-overwrite content"), overwriteDir, "existing.bin");
    check("H: write is refused with statusCode 409 when the destination already exists", !overwriteResult.ok && overwriteResult.statusCode === 409);
    const afterOverwriteAttempt = await fs.readFile(path.join(overwriteDir, "existing.bin"));
    check("H: the pre-existing file is STILL the original sentinel content — never overwritten", afterOverwriteAttempt.equals(sentinel));
    const overwriteDirEntries = await fs.readdir(overwriteDir);
    check("H: no stray temp file left behind after a refused overwrite", overwriteDirEntries.length === 1 && overwriteDirEntries[0] === "existing.bin");

    // ── I — injected corrupted readback -> 500, cleaned up, nothing published. ─
    const corruptDir = path.join(TEMP_DIR, "ticket-corrupt");
    const corruptResult = await writeAttachmentFile(Buffer.from("the real content"), corruptDir, "corrupt.bin", {
      readBack: async () => Buffer.from("CORRUPTED — entirely different content"),
    });
    check("I: write verification failure is refused with statusCode 500", !corruptResult.ok && corruptResult.statusCode === 500);
    check("I: nothing was published at the final destination", !(await pathExists(path.join(corruptDir, "corrupt.bin"))));
    const corruptDirEntries = await fs.readdir(corruptDir).catch(() => []);
    check("I: no stray temp file left behind after a verification failure", corruptDirEntries.length === 0);

    // ── J — copyAttachmentFile: happy path, missing source, never overwrite. ─
    const sourceFile = path.join(TEMP_DIR, "source-for-copy.bin");
    const sourceContent = Buffer.from("content to be copied via copyAttachmentFile");
    await fs.writeFile(sourceFile, sourceContent);
    const copyDestDir = path.join(TEMP_DIR, "ticket-copy-dest");
    const copyResult = await copyAttachmentFile(sourceFile, copyDestDir, "copied.bin");
    check("J: copyAttachmentFile happy path succeeds", copyResult.ok === true);
    if (copyResult.ok) check("J: reports the correct sha256/size for the copied content", copyResult.sha256 === createHash("sha256").update(sourceContent).digest("hex") && copyResult.size === sourceContent.length);
    check("J: the copied file exists with the exact source bytes", (await fs.readFile(path.join(copyDestDir, "copied.bin"))).equals(sourceContent));

    const missingSourceResult = await copyAttachmentFile(path.join(TEMP_DIR, "does-not-exist.bin"), copyDestDir, "wontexist.bin");
    check("J: copyAttachmentFile with a missing source fails with statusCode 500 and a clear reason", !missingSourceResult.ok && missingSourceResult.statusCode === 500 && /Failed to read source/i.test(missingSourceResult.reason));
    check("J: nothing was created for the missing-source attempt", !(await pathExists(path.join(copyDestDir, "wontexist.bin"))));

    const copyOverwriteResult = await copyAttachmentFile(sourceFile, copyDestDir, "copied.bin"); // same dest filename as the successful copy above
    check("J: copyAttachmentFile never overwrites an existing destination either (409)", !copyOverwriteResult.ok && copyOverwriteResult.statusCode === 409);
  } finally {
    resetAttachmentStorageVerificationForTests();
    try {
      await fs.rm(TEMP_DIR, { recursive: true, force: true });
    } catch (err) {
      console.warn("Temp directory cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  printSummaryAndExit();
}

main();
