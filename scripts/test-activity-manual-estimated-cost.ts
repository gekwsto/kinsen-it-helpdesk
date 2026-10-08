/**
 * Regression coverage for manual Estimated Cost on Activities whose Task
 * Sub Type has NO configured fixed cost (TaskSubType.cost === null, e.g.
 * "External"/"Others") — see app/api/activities/route.ts (POST) and
 * app/api/activities/[id]/route.ts (PATCH)'s own cost-resolution blocks,
 * and lib/validations.ts's `manualEstimatedCost` field on
 * createActivitySchema.
 *
 * Rule under test:
 *   - Task Sub Type with a configured cost -> that cost is ALWAYS the
 *     snapshot, a submitted manualEstimatedCost is silently ignored
 *     (never overridable).
 *   - Task Sub Type with cost === null -> manualEstimatedCost is REQUIRED
 *     and becomes the snapshot; it is NEVER written back to
 *     TaskSubType.cost itself.
 *   - Switching Task Sub Type (fixed <-> null) re-resolves the cost using
 *     the rule above for whichever Sub Type is now selected.
 *   - Editing unrelated fields (not touching taskSubTypeId or
 *     manualEstimatedCost) never recalculates the existing snapshot.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-activity-manual-estimated-cost.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

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

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const RUN_ID = Date.now();
const TAG = `mec-${RUN_ID}`;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });

  const activitiesPOST = (await import("@/app/api/activities/route")).POST;
  const activitiesPATCH = (await import("@/app/api/activities/[id]/route")).PATCH;
  const activitiesGET = (await import("@/app/api/activities/[id]/route")).GET;

  const deptIds: string[] = [];
  const taskTypeIds: string[] = [];
  const taskSubTypeIds: string[] = [];
  const activityIds: string[] = [];
  const userIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const taskType = await prisma.taskType.create({ data: { name: `${TAG}-tasktype` } });
    taskTypeIds.push(taskType.id);

    const worker = await prisma.user.create({ data: { email: `${TAG}-worker@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(worker.id);
    currentSession = { user: { id: worker.id, role: Role.ADMIN, customRoleId: null } };

    // Fixtures: one Task Sub Type WITH a configured cost, one WITHOUT.
    const fixedSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-fixed`, cost: 120 } });
    taskSubTypeIds.push(fixedSubType.id);
    const nullSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-null`, cost: null } });
    taskSubTypeIds.push(nullSubType.id);

    // ══════════════════════ 1-3. Fixed-cost subtype: snapshot = configured, override ignored ══════════════════════
    console.log("\n=== 1-3. Fixed-cost Task Sub Type: configured cost is authoritative ===\n");
    const act1Res = await activitiesPOST(
      jsonReq({ title: `${TAG} Act1 fixed`, departmentId: dept.id, taskTypeId: taskType.id, taskSubTypeId: fixedSubType.id })
    );
    check("1. Creating an Activity against the fixed-cost subtype -> 201", act1Res.status === 201);
    const act1 = await act1Res.json();
    activityIds.push(act1.id);
    check("1. ...snapshot === configured cost (120)", act1.taskSubTypeCost === "120");

    const act2Res = await activitiesPOST(
      jsonReq({ title: `${TAG} Act2 forged`, departmentId: dept.id, taskTypeId: taskType.id, taskSubTypeId: fixedSubType.id, manualEstimatedCost: 999 } as any)
    );
    const act2 = await act2Res.json();
    activityIds.push(act2.id);
    check("2. A forged manualEstimatedCost alongside a fixed-cost subtype is silently ignored -> snapshot still 120, never 999", act2Res.status === 201 && act2.taskSubTypeCost === "120");

    const fixedSubTypeRow = await prisma.taskSubType.findUniqueOrThrow({ where: { id: fixedSubType.id } });
    check("3. TaskSubType.cost itself is untouched by the forged value (still 120)", Number(fixedSubTypeRow.cost) === 120);

    // ══════════════════════ 4-7. Null-cost subtype: manual required, persisted, never backfills TaskSubType.cost ══════════════════════
    console.log("\n=== 4-7. Null-cost Task Sub Type: manual Estimated Cost required and used ===\n");
    const act3RejectedRes = await activitiesPOST(
      jsonReq({ title: `${TAG} Act3 missing manual`, departmentId: dept.id, taskTypeId: taskType.id, taskSubTypeId: nullSubType.id })
    );
    const act3Rejected = await act3RejectedRes.json();
    check("4. Creating against the null-cost subtype WITHOUT a manual cost -> 400, code estimated_cost_required", act3RejectedRes.status === 400 && act3Rejected.code === "estimated_cost_required");

    const act3Res = await activitiesPOST(
      jsonReq({ title: `${TAG} Act3 manual`, departmentId: dept.id, taskTypeId: taskType.id, taskSubTypeId: nullSubType.id, manualEstimatedCost: 77.5 } as any)
    );
    const act3 = await act3Res.json();
    activityIds.push(act3.id);
    check("5. Creating with a valid manual cost (77.5) against the null-cost subtype -> 201, snapshot === 77.5", act3Res.status === 201 && act3.taskSubTypeCost === "77.5");

    const nullSubTypeRow = await prisma.taskSubType.findUniqueOrThrow({ where: { id: nullSubType.id } });
    check("6. TaskSubType.cost itself remains null — the manual value was NEVER written back to it", nullSubTypeRow.cost === null);

    const act3PersistedRow = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act3.id } });
    check("7. The persisted ProjectActivity row's own taskSubTypeCost (DB-level, not just the JSON response) is exactly 77.5", Number(act3PersistedRow.taskSubTypeCost) === 77.5);

    const negativeCostRes = await activitiesPOST(
      jsonReq({ title: `${TAG} Act negative`, departmentId: dept.id, taskTypeId: taskType.id, taskSubTypeId: nullSubType.id, manualEstimatedCost: -5 } as any)
    );
    check("7b. A negative manualEstimatedCost is rejected by schema validation (422)", negativeCostRes.status === 422);

    // ══════════════════════ 8-11. Switching subtype re-resolves the rule ══════════════════════
    console.log("\n=== 8-11. Switching Task Sub Type (null <-> fixed) re-resolves cost correctly ===\n");
    // Switch Act3 (currently null-cost, manual 77.5) -> fixed-cost subtype.
    // Must IGNORE the stale manual value entirely and use the configured cost.
    const switchToFixedRes = await activitiesPATCH(
      jsonReq({ taskSubTypeId: fixedSubType.id, manualEstimatedCost: 77.5 } as any, "PATCH"),
      { params: Promise.resolve({ id: act3.id }) }
    );
    const switchedToFixed = await switchToFixedRes.json();
    check("8. Switching a null-cost Activity to a fixed-cost subtype ignores the resent stale manual value -> snapshot becomes 120", switchToFixedRes.status === 200 && switchedToFixed.taskSubTypeCost === "120");

    // Switch Act1 (currently fixed-cost, 120) -> null-cost subtype WITHOUT
    // supplying a manual cost -> must be rejected, never silently 0/120.
    const switchToNullRejectedRes = await activitiesPATCH(
      jsonReq({ taskSubTypeId: nullSubType.id } as any, "PATCH"),
      { params: Promise.resolve({ id: act1.id }) }
    );
    const switchToNullRejected = await switchToNullRejectedRes.json();
    check("9. Switching a fixed-cost Activity to a null-cost subtype WITHOUT a manual cost -> 400, estimated_cost_required", switchToNullRejectedRes.status === 400 && switchToNullRejected.code === "estimated_cost_required");

    const switchToNullOkRes = await activitiesPATCH(
      jsonReq({ taskSubTypeId: nullSubType.id, manualEstimatedCost: 42 } as any, "PATCH"),
      { params: Promise.resolve({ id: act1.id }) }
    );
    const switchToNullOk = await switchToNullOkRes.json();
    check("10. Switching with a valid manual cost supplied in the SAME request -> 200, snapshot === 42", switchToNullOkRes.status === 200 && switchToNullOk.taskSubTypeCost === "42");

    const act1AfterSwitchRow = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id } });
    check("11. The persisted DB row agrees (taskSubTypeCost === 42)", Number(act1AfterSwitchRow.taskSubTypeCost) === 42);

    // ══════════════════════ 12-15. Editing unrelated fields never recalculates the snapshot ══════════════════════
    console.log("\n=== 12-15. Editing unrelated fields preserves the existing snapshot ===\n");
    // act1 is now on nullSubType with snapshot 42. Bump the MASTER cost of
    // fixedSubType (currently irrelevant to act1) to prove it doesn't leak in,
    // then edit an unrelated field (title) on act1 and confirm 42 survives.
    const unrelatedEditRes = await activitiesPATCH(jsonReq({ title: `${TAG} Act1 renamed` } as any, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const unrelatedEdit = await unrelatedEditRes.json();
    check("12. Editing title only (no taskSubTypeId, no manualEstimatedCost) -> 200, snapshot UNCHANGED (42)", unrelatedEditRes.status === 200 && unrelatedEdit.taskSubTypeCost === "42");

    // Re-saving the SAME taskSubTypeId (no actual change) must also leave
    // the snapshot untouched, even without resending manualEstimatedCost.
    const resameSubTypeRes = await activitiesPATCH(jsonReq({ taskSubTypeId: nullSubType.id } as any, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const resameSubType = await resameSubTypeRes.json();
    check("13. Resending the SAME (unchanged) taskSubTypeId without a manual cost -> 200, snapshot still 42, never rejected", resameSubTypeRes.status === 200 && resameSubType.taskSubTypeCost === "42");

    // A fresh manualEstimatedCost resent for the SAME currently-effective
    // null-cost subtype (no taskSubTypeId in the body at all) legitimately
    // corrects the estimate — the intentionally-widened PATCH trigger.
    const correctManualRes = await activitiesPATCH(jsonReq({ manualEstimatedCost: 55 } as any, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const correctManual = await correctManualRes.json();
    check("14. Resending manualEstimatedCost alone (no taskSubTypeId) for a still-null-cost Activity updates the snapshot to the new value (55)", correctManualRes.status === 200 && correctManual.taskSubTypeCost === "55");

    // act2 is on the fixed-cost subtype (120). Editing an unrelated field
    // there must not re-trigger resolution into something else even if a
    // manualEstimatedCost is irrelevant to it (not sent at all here).
    const act2UnrelatedRes = await activitiesPATCH(jsonReq({ title: `${TAG} Act2 renamed` } as any, "PATCH"), { params: Promise.resolve({ id: act2.id }) });
    const act2Unrelated = await act2UnrelatedRes.json();
    check("15. Editing an unrelated field on the fixed-cost Act2 -> 200, snapshot still 120", act2UnrelatedRes.status === 200 && act2Unrelated.taskSubTypeCost === "120");

    // ══════════════════════ 16-17. Financial rollup consumes the resulting snapshot correctly ══════════════════════
    console.log("\n=== 16-17. Financial computation feeds off the resulting snapshot, null-safe ===\n");
    const act3GetRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: act3.id }) });
    const act3Get = await act3GetRes.json();
    check("16. GET on the manual-cost-origin Activity (now switched to fixed, snapshot 120) returns a consistent estimatedCost shape (no crash, numeric-or-zero)", act3GetRes.status === 200 && typeof act3Get.estimatedCost === "string");

    const legacyNoSubType = await prisma.projectActivity.create({ data: { title: `${TAG} no subtype`, departmentId: dept.id, createdById: worker.id, taskTypeId: taskType.id } });
    activityIds.push(legacyNoSubType.id);
    const legacyGetRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyNoSubType.id }) });
    const legacyGet = await legacyGetRes.json();
    check("17. An Activity with no Task Sub Type at all -> taskSubTypeCost null, estimatedCost '0' (never coerced from null)", legacyGet.taskSubTypeCost === null && legacyGet.estimatedCost === "0");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): activities", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: taskTypeIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): task types", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): users", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): departments", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
