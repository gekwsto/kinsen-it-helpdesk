/**
 * Final Import Safety Corrections (on top of Phase 4.1) — regression
 * coverage for the two narrowly-scoped fixes:
 *
 *   1. Manifest identity (scripts/historical-import/): Ticket ID removed
 *      entirely from recognition logic; all 20 already-assigned
 *      externalSourceIds preserved; ambiguous/unmatched rows require
 *      explicit review rather than silently receiving a new identity;
 *      repeated executions against the original Excel are stable.
 *   2. Canonical import payload fingerprint
 *      (lib/services/project-request-historical-import-service.ts):
 *      replaces the old title/departmentId-only idempotency check with a
 *      sha256 fingerprint of the COMPLETE normalized payload, compared
 *      against the ORIGINAL, immutable, stored value — never the live,
 *      possibly-since-edited Project/Request state.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-historical-import-safety-corrections.ts
 */
import { mock } from "node:test";
import * as React from "react";
import fs from "fs/promises";
import path from "path";
import os from "os";
(globalThis as any).React = React;

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

async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

const RUN_ID = Date.now();
const REAL_SOURCE_XLSX = "/Users/pavloschatzisavvas/Downloads/ProjectList_ 23-11-2026 (15 10).xlsx";
const REAL_MANIFEST = path.join(process.cwd(), "scripts/historical-import/manifests/project-list-2026-11-23.json");

async function main() {
  const { prisma } = await import("@/lib/prisma");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { Role, AuthProvider, ProjectStatus } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { createHistoricalProjectRequest, computeImportPayloadFingerprint } = await import("@/lib/services/project-request-historical-import-service");
  const { readProjectListRows } = await import("@/scripts/historical-import/read-source-rows");
  const { loadManifest, findManifestEntries } = await import("@/scripts/historical-import/manifest");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];

  async function makeUser(email: string) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u;
  }

  try {
    // ══════════════════════ 1. Manifest identity ══════════════════════
    console.log("\n=== 1. Manifest identity — Ticket ID removed, ids preserved, repeated runs stable ===\n");

    const manifestBefore = await loadManifest(REAL_MANIFEST);
    check("The committed manifest has exactly 20 entries (the first production import batch)", manifestBefore.entries.length === 20);
    check(
      "No stored naturalKey has a ticketId field — removed entirely from recognition logic",
      manifestBefore.entries.every((e) => !("ticketId" in (e.naturalKey as any)))
    );

    const rows = await readProjectListRows(REAL_SOURCE_XLSX);
    check("Every one of the 20 real source rows matches EXACTLY ONE manifest entry (no ambiguity introduced by dropping Ticket ID)", rows.every((r) => findManifestEntries(manifestBefore, r).length === 1));

    // Re-run the real generator against the real source file into a throwaway copy and confirm byte-identical output.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-stability-test-"));
    const tmpManifestPath = path.join(tmpDir, "manifest.json");
    await fs.copyFile(REAL_MANIFEST, tmpManifestPath);
    const before = await fs.readFile(tmpManifestPath, "utf8");

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("npx", ["tsx", "scripts/historical-import/generate-manifest.ts", `--manifest=${tmpManifestPath}`], { cwd: process.cwd() });
    const after = await fs.readFile(tmpManifestPath, "utf8");
    check("Running generate-manifest.ts again against the SAME source file produces byte-identical output (stable ids, no drift)", before === after);

    const reviewRequiredPath = tmpManifestPath.replace(/\.json$/, "") + ".review-required.json";
    const reviewRequiredExists = await fs
      .access(reviewRequiredPath)
      .then(() => true)
      .catch(() => false);
    check("No review-required file was produced for the real, unmodified 20-row source (zero ambiguity)", !reviewRequiredExists);

    // Simulate a genuinely new/ambiguous row and confirm neither is silently resolved.
    const manifestForAmbiguity = JSON.parse(await fs.readFile(tmpManifestPath, "utf8"));
    const removedEntry = manifestForAmbiguity.entries.shift();
    const duplicatedEntry = { ...manifestForAmbiguity.entries[0] };
    manifestForAmbiguity.entries.push(duplicatedEntry);
    await fs.writeFile(tmpManifestPath, JSON.stringify(manifestForAmbiguity, null, 2), "utf8");

    await execFileAsync("npx", ["tsx", "scripts/historical-import/generate-manifest.ts", `--manifest=${tmpManifestPath}`], { cwd: process.cwd() });
    const manifestAfterAmbiguity = JSON.parse(await fs.readFile(tmpManifestPath, "utf8"));
    check(
      "A row with ZERO manifest matches is NOT silently given a new id (entry count unchanged, not 20 again)",
      manifestAfterAmbiguity.entries.length === manifestForAmbiguity.entries.length
    );
    const reviewRequiredAfterAmbiguity = JSON.parse(await fs.readFile(reviewRequiredPath, "utf8"));
    check(
      "...it is reported under reviewRequired as NO_MATCH instead",
      reviewRequiredAfterAmbiguity.reviewRequired.some((r: any) => r.reason === "NO_MATCH" && r.naturalKey.title === removedEntry.naturalKey.title)
    );
    check(
      "A row matching TWO existing entries is reported as AMBIGUOUS_MULTIPLE_MATCHES, never auto-resolved",
      reviewRequiredAfterAmbiguity.reviewRequired.some((r: any) => r.reason === "AMBIGUOUS_MULTIPLE_MATCHES" && r.naturalKey.title === duplicatedEntry.naturalKey.title)
    );

    // --approve-new resolves ONLY the unambiguous NO_MATCH case, never the ambiguous one.
    await execFileAsync("npx", ["tsx", "scripts/historical-import/generate-manifest.ts", `--manifest=${tmpManifestPath}`, "--approve-new"], { cwd: process.cwd() });
    const manifestAfterApprove = JSON.parse(await fs.readFile(tmpManifestPath, "utf8"));
    check("--approve-new assigns a fresh id for the unambiguous NO_MATCH row", manifestAfterApprove.entries.length === manifestForAmbiguity.entries.length + 1);
    const reviewRequiredAfterApprove = JSON.parse(await fs.readFile(reviewRequiredPath, "utf8"));
    check(
      "...but the AMBIGUOUS case is STILL flagged even with --approve-new (never auto-resolved by any flag)",
      reviewRequiredAfterApprove.reviewRequired.length === 1 && reviewRequiredAfterApprove.reviewRequired[0].reason === "AMBIGUOUS_MULTIPLE_MATCHES"
    );

    await fs.rm(tmpDir, { recursive: true, force: true });

    // ══════════════════════ 2. Canonical import payload fingerprint ══════════════════════
    console.log("\n=== 2. Canonical import payload fingerprint replaces the narrow title/departmentId check ===\n");

    const dept = await createDepartment({ name: `Fingerprint Dept ${RUN_ID}`, slug: `fingerprint-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const ownerA = await makeUser(`fp-owner-a-${RUN_ID}@kinsen.gr`);
    const ownerB = await makeUser(`fp-owner-b-${RUN_ID}@kinsen.gr`);
    const audienceA = await makeUser(`fp-audience-a-${RUN_ID}@kinsen.gr`);
    const audienceB = await makeUser(`fp-audience-b-${RUN_ID}@kinsen.gr`);

    const basePayload = {
      title: `Fingerprint Base ${RUN_ID}`,
      externalSourceId: `fp-test:${RUN_ID}:base`,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [ownerA.id, ownerB.id],
      audienceIds: [audienceA.id, audienceB.id],
    };

    const first = await createHistoricalProjectRequest(basePayload);
    check("The first call succeeds", first.ok);
    if (first.ok) {
      requestIds.push(first.projectRequestId);
      projectIds.push(first.projectId);
    }

    console.log("\n=== 2a. Identical payload (even with the unordered id sets reordered) retries idempotently ===\n");
    const reorderedRetry = await createHistoricalProjectRequest({ ...basePayload, ownerIds: [ownerB.id, ownerA.id], audienceIds: [audienceB.id, audienceA.id] });
    check("A retry with the SAME owner/audience SETS in a DIFFERENT order still resolves idempotently", reorderedRetry.ok && reorderedRetry.alreadyExisted === true);

    console.log("\n=== 2b. A payload differing ONLY in Owners (same title/department) is now correctly flagged — the old check would have missed this ===\n");
    const differentOwnersRetry = await createHistoricalProjectRequest({ ...basePayload, ownerIds: [ownerA.id] });
    check(
      "Dropping an owner is detected as a conflict (NOT silently accepted as 'the same import')",
      !differentOwnersRetry.ok && differentOwnersRetry.error.code === "external_source_id_conflict"
    );

    console.log("\n=== 2c. A payload differing ONLY in Audiences is also flagged ===\n");
    const differentAudienceRetry = await createHistoricalProjectRequest({ ...basePayload, audienceIds: [audienceA.id] });
    check("Dropping an audience member is detected as a conflict", !differentAudienceRetry.ok && differentAudienceRetry.error.code === "external_source_id_conflict");

    console.log("\n=== 2d. A payload differing in Project status, dates, or historicalSourceMetadata is also flagged ===\n");
    const differentStatusRetry = await createHistoricalProjectRequest({ ...basePayload, projectStatus: ProjectStatus.COMPLETED });
    check("A different projectStatus is detected as a conflict", !differentStatusRetry.ok && differentStatusRetry.error.code === "external_source_id_conflict");
    const differentMetadataRetry = await createHistoricalProjectRequest({ ...basePayload, historicalSourceMetadata: { originalTotalDays: 5 } });
    check("A different historicalSourceMetadata is detected as a conflict", !differentMetadataRetry.ok && differentMetadataRetry.error.code === "external_source_id_conflict");

    console.log("\n=== 2e. Normal Project edits AFTER import do not invalidate a legitimate retry ===\n");
    if (first.ok) {
      await prisma.project.update({ where: { id: first.projectId }, data: { title: `Edited After Import ${RUN_ID}`, priority: 1, status: ProjectStatus.COMPLETED } });
      const retryAfterEdit = await createHistoricalProjectRequest(basePayload);
      check(
        "The ORIGINAL payload still resolves idempotently even though the live Project has since been edited through the normal UI/API",
        retryAfterEdit.ok && retryAfterEdit.alreadyExisted === true && retryAfterEdit.projectId === first.projectId
      );
      const storedRequest = await prisma.projectRequest.findUniqueOrThrow({ where: { id: first.projectRequestId } });
      check(
        "The stored historicalImportFingerprint is unchanged by the edit AND by the idempotent retries above — written exactly once",
        storedRequest.historicalImportFingerprint === computeImportPayloadFingerprint(basePayload as any)
      );
    }

    console.log("\n=== 2f. historicalImportFingerprint is restricted to Historical Imports ===\n");
    const standardRequestSrc = await (await import("fs/promises")).readFile("lib/services/project-request-service.ts", "utf8");
    check("historicalImportFingerprint is never referenced in the normal-workflow service module", !/historicalImportFingerprint/.test(standardRequestSrc));

    const requestCountForFingerprintId = await prisma.projectRequest.count({ where: { externalSourceId: basePayload.externalSourceId } });
    check("Exactly ONE ProjectRequest row exists for this externalSourceId despite every retry/conflict attempt above", requestCountForFingerprintId === 1);
  } finally {
    await runCleanup([
      ["delete projects", async () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["delete project requests", async () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["delete users", async () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["delete ticket categories", async () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete ticket priorities", async () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete ticket statuses", async () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete departments", async () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
      ["disconnect", async () => prisma.$disconnect()],
    ]);
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Unhandled error in test run:", err);
  process.exit(1);
});
