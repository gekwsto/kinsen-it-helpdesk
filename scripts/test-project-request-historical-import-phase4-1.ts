/**
 * Phase 4.1 — Historical Project Import Contract Completion: regression
 * coverage for the NEW behavior added on top of Phase 3/3.1's Historical
 * Import mechanism (lib/services/project-request-historical-import-service.ts):
 *
 *   1. description/importance/teamConcerned/expectedBenefits may all be
 *      absent for a Historical Import — never fabricated, never required
 *      the way they still are for a STANDARD submission.
 *   2. Expected Start/Finish Date extend the historical contract to the
 *      same canonical Project fields the standard request-origin flow
 *      already populates; expectedTotalInitialDays is computed only when
 *      BOTH are known.
 *   3. historicalSourceMetadata preserves otherwise-unmapped source fields
 *      (feedback user(s), original Estimated/Actual Cost, original Total
 *      Days when unmapped) with zero/null preserved distinctly, and is
 *      restricted to Historical Imports (rejected by the Zod schema for
 *      Ticket ID/Zoho Link — both explicitly out of scope — via .strict()).
 *   4. A conflicting externalSourceId reuse (same id, different title or
 *      department) is rejected rather than silently resolved as
 *      alreadyExisted.
 *
 * Does NOT re-prove anything already covered by
 * scripts/test-project-request-historical-import.ts (idempotency itself,
 * not_standard_request guards, authorization, notifications/reminders,
 * queue exclusion, IMPORTED-vs-APPROVED status semantics) — all of that is
 * completely unaffected by this phase and still passes unchanged.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-historical-import-phase4-1.ts
 */
import { mock } from "node:test";
import * as React from "react";
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
  const { createHistoricalProjectRequest } = await import("@/lib/services/project-request-historical-import-service");
  const { createHistoricalProjectRequestSchema, historicalSourceMetadataSchema, createProjectRequestSchema } = await import("@/lib/validations");

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
    const dept = await createDepartment({ name: `Phase4.1 Dept ${RUN_ID}`, slug: `phase41-dept-${RUN_ID}` });
    const otherDept = await createDepartment({ name: `Phase4.1 Other Dept ${RUN_ID}`, slug: `phase41-other-dept-${RUN_ID}` });
    deptIds.push(dept.id, otherDept.id);
    const owner = await makeUser(`phase41-owner-${RUN_ID}@kinsen.gr`);

    // ══════════════════════ 1. Mandatory-field relaxation ══════════════════════
    console.log("\n=== 1. description/importance/teamConcerned/expectedBenefits may all be absent for a Historical Import ===\n");

    const minimalResult = await createHistoricalProjectRequest({
      title: `Minimal Historical Import ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:minimal`,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
      // description/importance/teamConcerned/expectedBenefits all omitted.
    });
    check("Creation succeeds with none of the four fields provided", minimalResult.ok);
    if (minimalResult.ok) {
      requestIds.push(minimalResult.projectRequestId);
      projectIds.push(minimalResult.projectId);
      const createdRequest = await prisma.projectRequest.findUniqueOrThrow({ where: { id: minimalResult.projectRequestId } });
      check("description persisted as null, never fabricated", createdRequest.description === null);
      check("importance persisted as null, never fabricated", createdRequest.importance === null);
      check("teamConcerned persisted as null, never fabricated", createdRequest.teamConcerned === null);
      check("expectedBenefits persisted as null, never fabricated", createdRequest.expectedBenefits === null);

      const createdProject = await prisma.project.findUniqueOrThrow({ where: { id: minimalResult.projectId } });
      check(
        "The linked Project's OWN priority falls back to ITS column default (2/Medium) — a live-field default, never a fabricated historical importance",
        createdProject.priority === 2
      );
      check("Project.description is also null (no projectDescription override, no description to fall back to)", createdProject.description === null);
    }

    console.log("\n=== 1b. STANDARD submissions are COMPLETELY UNAFFECTED — still require all four fields ===\n");
    const standardParseMissingFields = createProjectRequestSchema.safeParse({
      title: `Should fail standard ${RUN_ID}`,
      departmentId: dept.id,
      // description/importance/teamConcerned/expectedBenefits all omitted.
    });
    check("createProjectRequestSchema (STANDARD) still rejects a submission missing these fields", !standardParseMissingFields.success);

    // ══════════════════════ 2. Expected Start/Finish ══════════════════════
    console.log("\n=== 2. Expected Start/Finish extend the historical contract to the same canonical Project fields ===\n");

    const expStart = new Date("2025-01-01T00:00:00.000Z");
    const expFinish = new Date("2025-01-11T00:00:00.000Z"); // 10 whole calendar days later
    const withDatesResult = await createHistoricalProjectRequest({
      title: `Historical With Expected Dates ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:with-dates`,
      departmentId: dept.id,
      projectStatus: ProjectStatus.COMPLETED,
      ownerIds: [owner.id],
      expectedStartDate: expStart,
      expectedFinishDate: expFinish,
    });
    check("Creation succeeds with both Expected Start and Expected Finish provided", withDatesResult.ok);
    if (withDatesResult.ok) {
      requestIds.push(withDatesResult.projectRequestId);
      projectIds.push(withDatesResult.projectId);
      const createdProject = await prisma.project.findUniqueOrThrow({ where: { id: withDatesResult.projectId } });
      check("Project.expectedStartDate is set from the input", createdProject.expectedStartDate?.toISOString() === expStart.toISOString());
      check("Project.expectedFinishDate is set from the input", createdProject.expectedFinishDate?.toISOString() === expFinish.toISOString());
      check(
        "Project.expectedTotalInitialDays is computed the SAME way createProjectFromApprovedRequest computes it (whole calendar days)",
        createdProject.expectedTotalInitialDays === 10
      );
    }

    console.log("\n=== 2b. expectedTotalInitialDays is left null when only ONE Expected date is known — never estimated from a proxy ===\n");
    const oneSidedDateResult = await createHistoricalProjectRequest({
      title: `Historical One-Sided Expected Date ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:one-sided-date`,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
      expectedStartDate: expStart,
      // expectedFinishDate genuinely unknown (mirrors 2 of the 20 real source rows).
    });
    check("Creation succeeds with only Expected Start known", oneSidedDateResult.ok);
    if (oneSidedDateResult.ok) {
      requestIds.push(oneSidedDateResult.projectRequestId);
      projectIds.push(oneSidedDateResult.projectId);
      const createdProject = await prisma.project.findUniqueOrThrow({ where: { id: oneSidedDateResult.projectId } });
      check("Project.expectedStartDate is still set", createdProject.expectedStartDate?.toISOString() === expStart.toISOString());
      check("Project.expectedFinishDate stays null — never guessed", createdProject.expectedFinishDate === null);
      check("Project.expectedTotalInitialDays stays null — never estimated from one date alone", createdProject.expectedTotalInitialDays === null);
    }

    // ══════════════════════ 3. historicalSourceMetadata ══════════════════════
    console.log("\n=== 3. historicalSourceMetadata preserves otherwise-unmapped source fields, zero distinct from null ===\n");

    const metadataResult = await createHistoricalProjectRequest({
      title: `Historical With Source Metadata ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:with-metadata`,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
      historicalSourceMetadata: {
        feedbackUsers: "Jane Doe",
        originalEstimatedCost: 0, // a REAL zero, not "unknown"
        originalActualCost: null, // genuinely unknown — must stay null, never coerced to 0
        originalTotalDays: 11,
      },
    });
    check("Creation succeeds with historicalSourceMetadata provided", metadataResult.ok);
    if (metadataResult.ok) {
      requestIds.push(metadataResult.projectRequestId);
      projectIds.push(metadataResult.projectId);
      const createdRequest = await prisma.projectRequest.findUniqueOrThrow({ where: { id: metadataResult.projectRequestId } });
      const meta = createdRequest.historicalSourceMetadata as Record<string, unknown> | null;
      check("historicalSourceMetadata persisted, not null", meta !== null);
      check("feedbackUsers preserved verbatim", meta?.feedbackUsers === "Jane Doe");
      check("originalEstimatedCost of 0 is preserved AS ZERO, never dropped/coerced", meta?.originalEstimatedCost === 0);
      check("originalActualCost of null stays null — distinct from the real zero above", meta?.originalActualCost === null);
      check("originalTotalDays preserved verbatim, never assigned to expectedTotalInitialDays", meta?.originalTotalDays === 11);

      const createdProject = await prisma.project.findUniqueOrThrow({ where: { id: metadataResult.projectId } });
      check(
        "Project.expectedTotalInitialDays was NOT derived from originalTotalDays (no Expected dates were given here)",
        createdProject.expectedTotalInitialDays === null
      );
    }

    console.log("\n=== 3b. historicalSourceMetadata is restricted to Historical Imports — never a Ticket ID/Zoho Link smuggling vector ===\n");
    const strictMetadataParse = historicalSourceMetadataSchema.safeParse({
      feedbackUsers: "Someone",
      ticketId: "TICKET-123",
    } as any);
    check("historicalSourceMetadataSchema rejects an unrecognized key (e.g. a smuggled ticketId) via .strict()", !strictMetadataParse.success);
    const zohoMetadataParse = historicalSourceMetadataSchema.safeParse({ zohoLink: "https://example.com" } as any);
    check("historicalSourceMetadataSchema rejects zohoLink the same way", !zohoMetadataParse.success);
    const serviceSrc = await (await import("fs/promises")).readFile("lib/services/project-request-historical-import-service.ts", "utf8");
    check("The service's own input contract has no field for Ticket ID at all", !/ticketId\s*[:?]/i.test(serviceSrc));
    check("...nor a field for Zoho Link (prose mentioning the exclusion in a doc comment is fine; no `zohoLink` field exists)", !/zohoLink\s*[:?]/i.test(serviceSrc));

    console.log("\n=== 3c. A STANDARD request never has historicalSourceMetadata — the only writer is createHistoricalProjectRequest ===\n");
    const standardRequestSrc = await (await import("fs/promises")).readFile("lib/services/project-request-service.ts", "utf8");
    check("historicalSourceMetadata is never referenced in the normal-workflow service module", !/historicalSourceMetadata/.test(standardRequestSrc));

    // ══════════════════════ 4. Conflicting externalSourceId reuse ══════════════════════
    console.log("\n=== 4. A conflicting externalSourceId reuse is rejected, never silently resolved ===\n");

    const conflictBaseId = `phase41-test:${RUN_ID}:conflict-base`;
    const firstOfPair = await createHistoricalProjectRequest({
      title: `Conflict Base Project ${RUN_ID}`,
      externalSourceId: conflictBaseId,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
    });
    check("The first call with this externalSourceId succeeds", firstOfPair.ok);
    if (firstOfPair.ok) {
      requestIds.push(firstOfPair.projectRequestId);
      projectIds.push(firstOfPair.projectId);
    }

    const sameIdSamePayload = await createHistoricalProjectRequest({
      title: `Conflict Base Project ${RUN_ID}`,
      externalSourceId: conflictBaseId,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
    });
    check(
      "A genuine retry with the SAME title/department still resolves idempotently (alreadyExisted: true), never a conflict",
      sameIdSamePayload.ok && sameIdSamePayload.alreadyExisted === true
    );

    const sameIdDifferentTitle = await createHistoricalProjectRequest({
      title: `A Completely Different Project ${RUN_ID}`,
      externalSourceId: conflictBaseId,
      departmentId: dept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
    });
    check(
      "The SAME externalSourceId with a DIFFERENT title is rejected as external_source_id_conflict, never silently resolved",
      !sameIdDifferentTitle.ok && sameIdDifferentTitle.error.code === "external_source_id_conflict"
    );

    const sameIdDifferentDepartment = await createHistoricalProjectRequest({
      title: `Conflict Base Project ${RUN_ID}`,
      externalSourceId: conflictBaseId,
      departmentId: otherDept.id,
      projectStatus: ProjectStatus.IN_PROGRESS,
      ownerIds: [owner.id],
    });
    check(
      "The SAME externalSourceId with a DIFFERENT department is also rejected as external_source_id_conflict",
      !sameIdDifferentDepartment.ok && sameIdDifferentDepartment.error.code === "external_source_id_conflict"
    );

    const requestCountForConflictId = await prisma.projectRequest.count({ where: { externalSourceId: conflictBaseId } });
    check("Exactly ONE ProjectRequest row exists for this externalSourceId — the conflicting attempts never created a second one", requestCountForConflictId === 1);

    // ══════════════════════ 5. Full Zod contract exercised end-to-end ══════════════════════
    console.log("\n=== 5. createHistoricalProjectRequestSchema accepts the Phase 4.1 fields together ===\n");
    const fullSchemaParse = createHistoricalProjectRequestSchema.safeParse({
      title: `Full Schema Exercise ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:full-schema`,
      departmentId: dept.id,
      projectStatus: "IN_PROGRESS",
      ownerIds: [owner.id],
      // description/importance/teamConcerned/expectedBenefits all omitted.
      expectedStartDate: "2025-01-01",
      expectedFinishDate: "2025-01-11",
      historicalSourceMetadata: { originalEstimatedCost: 0, originalActualCost: null, originalTotalDays: 10 },
    });
    check("The full Phase 4.1 payload shape parses successfully", fullSchemaParse.success);

    const schemaWithTicketIdInMetadata = createHistoricalProjectRequestSchema.safeParse({
      title: `Should fail ${RUN_ID}`,
      externalSourceId: `phase41-test:${RUN_ID}:should-fail`,
      departmentId: dept.id,
      projectStatus: "IN_PROGRESS",
      ownerIds: [owner.id],
      historicalSourceMetadata: { ticketId: "TICKET-1" },
    } as any);
    check("...but a payload smuggling ticketId inside historicalSourceMetadata is rejected", !schemaWithTicketIdInMetadata.success);
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
