/**
 * Shared attachment storage layer — used by EVERY attachment write path in
 * the app: the WEB ticket upload route, email ingestion (both the pending-
 * ticket intake and ticket-reply paths), the pending-ticket accept-time
 * migration copy, and the Activity/Project upload routes. One
 * implementation, never duplicated per route, so none of them can drift
 * from the same durability/never-overwrite guarantees.
 *
 * WHY THIS EXISTS — a real production incident: 11 WEB-uploaded
 * TicketAttachment rows (10 Tickets, created between 2026-09-25 and
 * 2026-11-16) ended up with valid database rows but no file on disk. The
 * most likely root cause (see the RCA this round is based on — LIKELY, not
 * definitively confirmed, since production deployment history couldn't be
 * directly inspected) is a bounded window where the running container's
 * UPLOAD_DIR did not actually correspond to the persistent Docker volume —
 * every `fs.writeFile` succeeded silently (no exception, immediately
 * downloadable), the DB row was created normally, and the bytes were only
 * ever sitting in the container's own ephemeral writable layer, lost at
 * the next container recreation. NOTHING in the previous code could have
 * detected this — there was no verification of any kind between "the
 * write call didn't throw" and "this file is actually durable."
 *
 * TWO INDEPENDENT SAFEGUARDS, FOR TWO DIFFERENT FAILURE CLASSES
 *   1. verifyAttachmentStorage() — confirms UPLOAD_DIR is genuinely its
 *      OWN distinct mount point (not merely a directory inside the
 *      container's own writable layer), by reading the kernel's own
 *      mount table (/proc/self/mountinfo), never `stat().dev` (an
 *      indirect, less reliable proxy — see this module's own function
 *      doc comment for why). This is the check that would have caught
 *      the actual historical failure mode. It answers "is this mount
 *      durable AT ALL," never "is it durable from the EXACT expected host
 *      path" — that stronger, source-path-specific assertion can only be
 *      made from OUTSIDE the container (where `docker inspect`'s
 *      `.Mounts[].Source` is visible) — see
 *      scripts/verify-attachment-storage-mount.sh, the deploy-time
 *      operator check this module's own in-process check complements,
 *      never replaces.
 *   2. writeAttachmentFile() / copyAttachmentFile() — write to a temp file
 *      in the SAME destination directory (exclusive creation), re-read it
 *      and compare its hash/length against what was supposed to be
 *      written, and only then atomically publish it via an exclusive hard
 *      link (fails closed with EEXIST rather than silently overwriting —
 *      never rename, which would overwrite). This catches a genuinely
 *      DIFFERENT failure class — a truncated or corrupted write — and
 *      does NOT, and cannot, prove the mount itself is durable: a file
 *      sitting in an ephemeral layer reads back perfectly at the exact
 *      moment it's written: the loss only happens later, at container
 *      recreation, which no post-write check can observe. Confusing these
 *      two guarantees is exactly the trap this module's own doc comments
 *      exist to prevent.
 *
 * NO POLLING, NO MARKER FILES — the mount check runs ONCE per process
 * lifetime (lazily, on first need) and the result is cached in memory for
 * the rest of that process's life; a corrected mount is picked up the next
 * time the process restarts (which redeploying already does), never via a
 * timer or a persisted sentinel file on disk.
 */
import fs from "fs/promises";
import path from "path";
import { randomBytes, createHash } from "crypto";
import { UPLOAD_DIR } from "@/lib/attachment-policy";

export type StorageVerification = { verified: boolean; reason: string };

type MountInfoReader = () => Promise<string>;

async function defaultMountInfoReader(): Promise<string> {
  return fs.readFile("/proc/self/mountinfo", "utf8");
}

/**
 * proc(5) escapes space/tab/newline/backslash in mountinfo path fields as
 * octal (`\040`, `\011`, `\012`, `\134`) — a path containing any of these
 * (a space is the realistic one) would otherwise never string-match
 * fs.realpath's own, unescaped output. Unescaping both sides to the same
 * canonical form is what "confirm canonical path resolution" means here.
 */
function unescapeMountInfoPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Extracts every MOUNT POINT (and its filesystem type) from Linux's
 * /proc/self/mountinfo (see proc(5)): each line is `ID parentID
 * major:minor root MOUNTPOINT options... - fstype source superopts` —
 * the mount point is always the 5th whitespace-separated field (index
 * 4), and fstype always immediately follows the lone `-` separator field
 * (whose own position varies, since the optional-fields block before it
 * has a variable length). This reflects the CALLING PROCESS's own mount
 * namespace — exactly what this container itself sees as mounted, which
 * is the only thing that matters here (Docker gives every container its
 * own mount namespace). Malformed lines (too few fields, or no `-`
 * separator found) are silently skipped, never partially trusted. When
 * more than one mount shares the same mount point (a later mount
 * stacked on top of an earlier one at the identical path), the LAST
 * entry for that path wins — mountinfo lists mounts in the order they
 * were performed, so the last one is the one actually visible there now.
 */
function parseMountEntries(mountInfoContent: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of mountInfoContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(" ");
    if (fields.length <= 4) continue;
    const sepIndex = fields.indexOf("-");
    if (sepIndex === -1 || fields.length <= sepIndex + 1) continue;
    entries.set(unescapeMountInfoPath(fields[4]), fields[sepIndex + 1]);
  }
  return entries;
}

/**
 * Filesystem types that never survive a container recreation — a mount
 * of one of these at some ancestor of UPLOAD_DIR must NOT be treated as
 * durable, even though it's a perfectly real, distinct mount (so the
 * plain "is there a covering mount at all" check above would otherwise
 * wrongly pass it). `overlay` is deliberately NOT in this list: it's the
 * normal, legitimate filesystem for a container's OWN root and also for
 * some genuinely durable volume backends — denylisting it would produce
 * false negatives against real, persistent storage.
 */
const EPHEMERAL_FSTYPES = new Set(["tmpfs", "proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "mqueue"]);

/**
 * Finds the CLOSEST mount covering `resolvedPath` — the longest mount
 * point that is either exactly `resolvedPath` or one of its ancestor
 * directories — never requiring UPLOAD_DIR to be its OWN exact mount
 * point. Handles a NESTED mount correctly: if UPLOAD_DIR is a plain
 * subdirectory of some separately-mounted PARENT directory (e.g. a bind
 * mount at `/app/storage` with UPLOAD_DIR at `/app/storage/uploads`
 * underneath it, rather than the mount landing exactly at UPLOAD_DIR
 * itself), that parent mount is still durable and UPLOAD_DIR inherits
 * that durability — the previous exact-match-only check would have
 * produced a FALSE NEGATIVE here. Returns `null` only if `mountEntries`
 * is empty or malformed (not even "/" present) — handled by the caller
 * as "ambiguous/corrupted," never silently treated as "verified."
 */
function findClosestCoveringMount(mountEntries: Map<string, string>, resolvedPath: string): { mountPoint: string; fstype: string } | null {
  let closest: { mountPoint: string; fstype: string } | null = null;
  for (const [mp, fstype] of mountEntries) {
    const covers = resolvedPath === mp || resolvedPath.startsWith(mp.endsWith("/") ? mp : `${mp}/`);
    if (!covers) continue;
    if (closest === null || mp.length > closest.mountPoint.length) closest = { mountPoint: mp, fstype };
  }
  return closest;
}

let cachedVerification: StorageVerification | null = null;

/**
 * Confirms UPLOAD_DIR's own real (symlink-resolved) path is itself a
 * distinct mount point, by reading /proc/self/mountinfo directly — the
 * same kernel-maintained source of truth `docker inspect`'s `.Mounts`
 * reads from the outside, consulted here from the inside instead, since
 * the app process has no way to call `docker inspect` on itself without
 * mounting the Docker socket (a privilege escalation not worth taking for
 * this). Deliberately NOT `stat().dev`: a device-number comparison is an
 * indirect proxy that can't distinguish "legitimately shares a device
 * with something else" from "is actually inside the container's own
 * writable layer," says nothing about which SPECIFIC mount is present,
 * and doesn't use the one data structure (the mount table itself) that
 * actually answers the question directly.
 *
 * Linux-only — outside a Linux container (local dev on macOS/Windows, a
 * non-containerized test runner, CI), /proc/self/mountinfo doesn't exist
 * and this check is meaningless there; it is explicitly skipped (treated
 * as verified) rather than ever blocking local development over a
 * production-only signal.
 *
 * Cached for the lifetime of the process after the first call — this is
 * deliberately NOT re-checked on a timer (see this module's own top
 * doc comment: no polling). `opts` exists purely as a test seam (default
 * real reader/platform otherwise) — see test-attachment-storage-service.ts.
 */
export async function verifyAttachmentStorage(opts?: { mountInfoReader?: MountInfoReader; uploadDir?: string; platform?: string }): Promise<StorageVerification> {
  if (cachedVerification) return cachedVerification;

  // `opts.platform` is a TEST SEAM ONLY — production code (publishBuffer,
  // below) always calls this with zero arguments, so `platform` is always
  // the real `process.platform`: a low-level Node binding reflecting the
  // actual OS the process is running on, not configurable via any env var
  // or application setting — there is no way for a real Linux/Docker
  // production deployment to accidentally take the "skip" branch below.
  const platform = opts?.platform ?? process.platform;
  const uploadDirArg = opts?.uploadDir ?? UPLOAD_DIR;

  if (platform !== "linux") {
    cachedVerification = { verified: true, reason: "Non-Linux platform — mount validation is skipped here and trusted by default outside containerized production." };
    return cachedVerification;
  }

  let resolvedUploadDir: string;
  try {
    resolvedUploadDir = await fs.realpath(uploadDirArg);
  } catch (err) {
    cachedVerification = { verified: false, reason: `UPLOAD_DIR (${uploadDirArg}) does not exist or is not accessible: ${err instanceof Error ? err.message : String(err)}` };
    console.error(`[attachment-storage] CRITICAL: ${cachedVerification.reason}`);
    return cachedVerification;
  }

  const reader = opts?.mountInfoReader ?? defaultMountInfoReader;
  let mountInfoContent: string;
  try {
    mountInfoContent = await reader();
  } catch (err) {
    cachedVerification = { verified: false, reason: `Could not read /proc/self/mountinfo to validate UPLOAD_DIR's persistence: ${err instanceof Error ? err.message : String(err)}` };
    console.error(`[attachment-storage] CRITICAL: ${cachedVerification.reason}`);
    return cachedVerification;
  }

  const mountEntries = parseMountEntries(mountInfoContent);

  // Ambiguous/corrupted read: a valid mountinfo always has AT LEAST the
  // root "/" entry. Zero parsed entries at all means the read itself is
  // suspect (truncated, garbled, wrong format) — a materially different,
  // more alarming condition than "UPLOAD_DIR just isn't mounted," and
  // reported as such rather than silently falling through to the same
  // "not found" branch.
  if (mountEntries.size === 0) {
    cachedVerification = { verified: false, reason: "Could not establish ANY mount information from /proc/self/mountinfo (zero entries parsed, not even the root \"/\" mount) — the read is suspect (truncated or malformed), not merely 'UPLOAD_DIR unmounted'." };
    console.error(`[attachment-storage] CRITICAL: ${cachedVerification.reason}`);
    return cachedVerification;
  }

  const closest = findClosestCoveringMount(mountEntries, resolvedUploadDir);
  if (closest && closest.mountPoint !== "/") {
    // A real, distinct mount covers this path — but still not durable if
    // its filesystem type is one of the known-ephemeral ones (e.g. a
    // tmpfs mounted at some ancestor directory): that mount is genuinely
    // separate from the container's root, yet still backed by RAM, not
    // by anything that survives a container restart.
    if (EPHEMERAL_FSTYPES.has(closest.fstype)) {
      cachedVerification = {
        verified: false,
        reason: `UPLOAD_DIR (${resolvedUploadDir}) is covered by a distinct mount at '${closest.mountPoint}', but its filesystem type ('${closest.fstype}') is ephemeral and does not survive a container restart. Attachment writes are being refused until this is corrected and the application is restarted.`,
      };
      console.error(`[attachment-storage] CRITICAL: ${cachedVerification.reason}`);
      return cachedVerification;
    }
    cachedVerification = { verified: true, reason: `UPLOAD_DIR (${resolvedUploadDir}) is covered by a distinct mount at '${closest.mountPoint}' (fstype '${closest.fstype}', not the container root).` };
    // Success-path log, deliberately at INFO (never console.error) and
    // only ever logged once per process lifetime (this function is
    // cached — see its own doc comment) — so "verified durable at
    // startup" is distinguishable in logs from "this process never
    // actually reached a verification call at all."
    console.log(`[attachment-storage] ${cachedVerification.reason}`);
    return cachedVerification;
  }
  if (closest === null) {
    // Even the root "/" entry (always present in a well-formed
    // mountinfo) doesn't cover this path — a different, more alarming
    // signal than "unmounted": the mountinfo data itself doesn't make
    // sense for this path at all.
    cachedVerification = { verified: false, reason: `No mount at all (not even the container root) covers UPLOAD_DIR (${resolvedUploadDir}) — the mount information read does not make sense for this path; refusing to trust it.` };
  } else {
    cachedVerification = {
      verified: false,
      reason: `UPLOAD_DIR (${resolvedUploadDir}) is NOT covered by any mount other than the container root ('/') — it appears to be part of the container's own writable layer, which does not survive container recreation. Attachment writes are being refused until this is corrected and the application is restarted.`,
    };
  }
  console.error(`[attachment-storage] CRITICAL: ${cachedVerification.reason}`);
  return cachedVerification;
}

/** The last cached verification result, or `null` if verifyAttachmentStorage has never run yet in this process. Read-only convenience — never triggers a check itself. */
export function isAttachmentStorageVerified(): boolean | null {
  return cachedVerification?.verified ?? null;
}

/** Test-only: clears the cached verification so the next call re-evaluates. Never called from application code. */
export function resetAttachmentStorageVerificationForTests(): void {
  cachedVerification = null;
}

export type AttachmentWriteResult = { ok: true; sha256: string; size: number } | { ok: false; reason: string; statusCode: 503 | 409 | 500 };

type PublishDeps = { readBack?: (p: string) => Promise<Buffer> };

/**
 * The shared write-verify-atomically-publish core both writeAttachmentFile
 * and copyAttachmentFile delegate to, once each already has the bytes in
 * memory. Gated on verifyAttachmentStorage() FIRST — never even attempts
 * a write if storage isn't verified as durable (fail closed, 503).
 * `deps.readBack` is a test seam only (defaults to a real fs.readFile) —
 * see test-attachment-storage-service.ts's disk-corruption simulation.
 */
async function publishBuffer(buffer: Buffer, dir: string, filename: string, deps: PublishDeps = {}): Promise<AttachmentWriteResult> {
  const verification = await verifyAttachmentStorage();
  if (!verification.verified) {
    return { ok: false, reason: `Attachment storage is not available: ${verification.reason}`, statusCode: 503 };
  }

  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, filename);
  const tempPath = path.join(dir, `.upload-${randomBytes(8).toString("hex")}.tmp`);
  const expectedHash = createHash("sha256").update(buffer).digest("hex");
  const readBack = deps.readBack ?? fs.readFile;

  try {
    await fs.writeFile(tempPath, buffer, { flag: "wx" });
  } catch (err) {
    return { ok: false, reason: `Failed to write attachment: ${err instanceof Error ? err.message : String(err)}`, statusCode: 500 };
  }

  try {
    const writtenBuf = await readBack(tempPath);
    const writtenHash = createHash("sha256").update(writtenBuf).digest("hex");
    if (writtenBuf.length !== buffer.length || writtenHash !== expectedHash) {
      await fs.unlink(tempPath).catch(() => {});
      return { ok: false, reason: "Write verification failed (did not read back identical to what was written) — not trusted as durable. This is NOT a guarantee the mount itself is persistent; it only catches a corrupted/truncated write.", statusCode: 500 };
    }
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    return { ok: false, reason: `Failed to verify written attachment: ${err instanceof Error ? err.message : String(err)}`, statusCode: 500 };
  }

  try {
    await fs.link(tempPath, finalPath);
  } catch (err: unknown) {
    await fs.unlink(tempPath).catch(() => {});
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      return { ok: false, reason: "A file already exists at the destination — refusing to overwrite.", statusCode: 409 };
    }
    return { ok: false, reason: `Failed to publish attachment: ${err instanceof Error ? err.message : String(err)}`, statusCode: 500 };
  }
  await fs.unlink(tempPath).catch(() => {});

  return { ok: true, sha256: expectedHash, size: buffer.length };
}

/** For a freshly-received buffer (a web upload, a decoded email attachment). */
export async function writeAttachmentFile(buffer: Buffer, dir: string, filename: string, deps?: PublishDeps): Promise<AttachmentWriteResult> {
  return publishBuffer(buffer, dir, filename, deps);
}

/** For migrating an EXISTING on-disk file to a new location (the pending-ticket accept-time copy) — reads the source fully into memory, then goes through the exact same verify-gate/write/verify/publish core as a fresh upload. */
export async function copyAttachmentFile(sourcePath: string, dir: string, filename: string, deps?: PublishDeps): Promise<AttachmentWriteResult> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(sourcePath);
  } catch (err) {
    return { ok: false, reason: `Failed to read source attachment at ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`, statusCode: 500 };
  }
  return publishBuffer(buffer, dir, filename, deps);
}
