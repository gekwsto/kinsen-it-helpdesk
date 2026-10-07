/**
 * Regression coverage for the negative Activity Actual Days / Actual Cost
 * bug: completing a request-origin Activity BEFORE its own Expected Start
 * produced a negative actualDays (raw wholeCalendarDaysBetween going
 * negative), which multiplied through taskTypeCost into a negative
 * Activity Actual Cost and, summed, a negative Project Actual Cost (a real
 * row in this dev DB showed actualDays: -2, Project Actual Cost: -€300.00
 * before this fix).
 *
 * Fix: lib/date-only.ts's new actualDaysFromCompletion() — the SAME
 * wholeCalendarDaysBetween formula, floored at 0 — now used by BOTH
 * app/api/activities/route.ts (create-as-COMPLETED) and
 * app/api/activities/[id]/route.ts (the completion-transition boundary
 * every completion UI path funnels through: the checkbox, the quick-
 * status dropdown). Expected Days is completely untouched (still
 * unclamped — creation validation already guarantees finish >= start).
 *
 * Determinism note: completedAt is always the REAL server clock
 * (never client-controllable) — "completed before Expected Start" is
 * reproduced here by setting Expected Start to a date AFTER "today" (the
 * real environment date), exactly like this repo's other financial tests'
 * established convention (see test-project-activity-financials.ts).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-activity-actual-days-clamp.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { actualDaysFromCompletion, wholeCalendarDaysBetween } from "@/lib/date-only";

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

/** YYYY-MM-DD, `offsetDays` days from real "now" (negative = past, positive = future). */
function dateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

const RUN_ID = Date.now();
const TAG = `aadc-${RUN_ID}`;

async function main() {
  // ══════════════════════ SECTION A — pure helper (no DB) ══════════════════════
  console.log("\n=== SECTION A — actualDaysFromCompletion: the clamp itself ===\n");
  const future = new Date("2026-10-10T00:00:00.000Z");
  const earlierCompletion = new Date("2026-10-08T00:00:00.000Z");
  check("1. Expected Start 10 Oct, Completed 08 Oct -> raw would be -2, clamped actualDays = 0", actualDaysFromCompletion(future, earlierCompletion) === 0);
  check("...confirms the RAW (unclamped) helper really would have been negative, proving this is a genuine floor, not a no-op", wholeCalendarDaysBetween(future, earlierCompletion) === -2);

  const sameDay = new Date("2026-10-10T00:00:00.000Z");
  check("4. Expected Start === Completed date -> actualDays = 0", actualDaysFromCompletion(future, sameDay) === 0);

  const later = new Date("2026-10-13T00:00:00.000Z");
  check("5. Completed AFTER Expected Start -> normal positive value, unaffected by the clamp", actualDaysFromCompletion(future, later) === 3);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping the real-DB portion.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  const activitiesPOST = (await import("@/app/api/activities/route")).POST;
  const activitiesPATCH = (await import("@/app/api/activities/[id]/route")).PATCH;
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const taskTypesAdminPOST = (await import("@/app/api/admin/activity-task-types/route")).POST;
  const { computeProjectFinancials } = await import("@/lib/services/project-financials-service");

  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const userIds: string[] = [];
  const taskTypeIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    async function makeUser(email: string) {
      const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(u.id);
      return u;
    }
    async function addMembership(userId: string, departmentId: string) {
      await prisma.departmentMembership.create({
        data: { userId, departmentId, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    }

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const worker1 = await makeUser(`${TAG}-worker1@kinsen.gr`);
    await addMembership(worker1.id, dept.id);
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };

    async function makeRequestOriginProject(tag: string): Promise<string> {
      currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
      const submitRes = await requestsPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "Actual Days clamp fixture — description long enough for validation.",
          importance: 2,
          projectTypeId: reqType.id,
          teamConcerned: "Engineering",
          expectedBenefits: "Benefits text long enough for validation.",
          replacesExisting: false,
          intermediateApproverIds: [adminUser.id],
        })
      );
      const submitted = await submitRes.json();
      requestIds.push(submitted.id);
      currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
      await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
      await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
      const setupRes = await setupPOST(
        jsonReq({ title: `${TAG} ${tag} request`, description: "fixture", ownerIds: [adminUser.id], expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-05", expenseTypeId: expenseType.id }),
        { params: Promise.resolve({ id: submitted.id }) }
      );
      if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
      const project = await setupRes.json();
      projectIds.push(project.id);
      return project.id;
    }

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const taskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG}-tasktype`, cost: 150 }));
    const taskType = await taskTypeRes.json();
    taskTypeIds.push(taskType.id);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const project = await makeRequestOriginProject("main");

    async function createActivity(title: string, expectedStartDate: string, expectedFinishDate: string) {
      const res = await activitiesPOST(
        jsonReq({ title, projectId: project, departmentId: dept.id, expectedStartDate, expectedFinishDate, taskTypeId: taskType.id, ownerId: worker1.id, assignedUserIds: [worker1.id] })
      );
      if (res.status !== 201) throw new Error(`Fixture activity create failed: ${res.status}: ${JSON.stringify(await res.json())}`);
      const activity = await res.json();
      activityIds.push(activity.id);
      return activity;
    }

    // ══════════════════════ 1-3. End-to-end: complete BEFORE Expected Start ══════════════════════
    console.log("\n=== 1-3. Completing an Activity before its own Expected Start never goes negative, end to end ===\n");
    const earlyAct = await createActivity(`${TAG} Early`, dateOffset(5), dateOffset(7));
    const completeEarlyRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: earlyAct.id }) });
    check("(fixture) Completing -> 200", completeEarlyRes.status === 200);
    const completedEarly = await completeEarlyRes.json();
    check("1. actualDays = 0 (Expected Start is 5 days in the future; completed today)", completedEarly.actualDays === 0);
    check("2. Activity Actual Cost = '0' (never negative)", completedEarly.actualCost === "0");

    const projAfterEarly = await prisma.projectActivity.findMany({ where: { projectId: project }, select: { taskTypeCost: true, expectedDays: true, actualDays: true } });
    const totalsAfterEarly = computeProjectFinancials(projAfterEarly);
    check("3. Project Actual Cost does not become negative", Number(totalsAfterEarly.actualCost) >= 0 && totalsAfterEarly.actualCost.toString() === "0");

    // ══════════════════════ 4. Expected Start === completion date ══════════════════════
    console.log("\n=== 4. Expected Start exactly equal to the completion date ===\n");
    const sameDayAct = await createActivity(`${TAG} SameDay`, dateOffset(0), dateOffset(2));
    const completeSameDayRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: sameDayAct.id }) });
    const completedSameDay = await completeSameDayRes.json();
    check("4. actualDays = 0", completedSameDay.actualDays === 0);

    // ══════════════════════ 5. Completed after Expected Start — unaffected ══════════════════════
    console.log("\n=== 5. A normal (positive) completion is completely unaffected by the clamp ===\n");
    const normalAct = await createActivity(`${TAG} Normal`, dateOffset(-9), dateOffset(3));
    const completeNormalRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const completedNormal = await completeNormalRes.json();
    check("5. actualDays = 9 (real positive value, not touched by the fix)", completedNormal.actualDays === 9);
    check("...Activity Actual Cost = '1350' (150 × 9)", completedNormal.actualCost === "1350");

    // ══════════════════════ 6-7. Client cannot forge actualDays/actualCost ══════════════════════
    console.log("\n=== 6-7. Client-forged actualDays/actualCost are silently ignored ===\n");
    const forgedAct = await createActivity(`${TAG} Forged`, dateOffset(5), dateOffset(7));
    const forgedRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED", actualDays: -999, actualCost: -999999 } as any, "PATCH"), { params: Promise.resolve({ id: forgedAct.id }) });
    const forged = await forgedRes.json();
    check("6. A forged actualDays: -999 in the body is ignored — the server's own clamped value (0) persists", forged.actualDays === 0);
    check("7. A forged actualCost: -999999 is ignored — the server's own derived value ('0') persists", forged.actualCost === "0");

    // ══════════════════════ 8-10. Reopen / re-complete lifecycle ══════════════════════
    console.log("\n=== 8-10. Reopen clears it; re-completing recomputes with the SAME clamp ===\n");
    const reopenRes = await activitiesPATCH(jsonReq({ isCompleted: false, status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const reopened = await reopenRes.json();
    check("8. Reopen clears actualDays back to null", reopened.actualDays === null);

    // 9: re-complete BEFORE expected start (shift Expected Start into the future first).
    await activitiesPATCH(jsonReq({ expectedStartDate: dateOffset(5), expectedFinishDate: dateOffset(7) }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const recompleteEarlyRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const recompletedEarly = await recompleteEarlyRes.json();
    check("9. Re-completing BEFORE the (now-future) Expected Start still produces actualDays = 0", recompletedEarly.actualDays === 0);

    // 10: reopen again, shift Expected Start back into the past, re-complete.
    await activitiesPATCH(jsonReq({ isCompleted: false, status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    await activitiesPATCH(jsonReq({ expectedStartDate: dateOffset(-4), expectedFinishDate: dateOffset(3) }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const recompleteLaterRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: normalAct.id }) });
    const recompletedLater = await recompleteLaterRes.json();
    check("10. Re-completing AFTER Expected Start produces the correct positive value (4 days)", recompletedLater.actualDays === 4);

    // ══════════════════════ 11. Legacy negative-row reconciliation mechanism ══════════════════════
    console.log("\n=== 11. The reconciliation mechanism (migration SQL) correctly fixes a negative row ===\n");
    const legacyNegative = await prisma.projectActivity.create({
      data: { title: `${TAG} LegacyNegative`, projectId: project, departmentId: dept.id, createdById: worker1.id, taskTypeId: taskType.id, taskTypeCost: 150, actualDays: -5, completedAt: new Date() },
    });
    activityIds.push(legacyNegative.id);
    check("(fixture) A simulated pre-fix negative row exists", (await prisma.projectActivity.findUniqueOrThrow({ where: { id: legacyNegative.id } })).actualDays === -5);
    // The EXACT reconciliation query from prisma/migrations/20261005114249_fix_negative_activity_actual_days/migration.sql.
    await prisma.$executeRaw`UPDATE "ProjectActivity" SET "actualDays" = 0 WHERE "actualDays" < 0`;
    const reconciled = await prisma.projectActivity.findUniqueOrThrow({ where: { id: legacyNegative.id } });
    check("11. The reconciliation query corrects the negative row to 0", reconciled.actualDays === 0);
    check("...and never touches completedAt (no fabricated/removed timestamp)", reconciled.completedAt !== null);

    // ══════════════════════ 12. No negative contribution to Project aggregation ══════════════════════
    console.log("\n=== 12. Project financial aggregation contains no negative contribution, across a mixed set ===\n");
    const allActivities = await prisma.projectActivity.findMany({ where: { projectId: project }, select: { taskTypeCost: true, expectedDays: true, actualDays: true } });
    check("(sanity) This Project now has a mix of zero, positive, and a reconciled-legacy actualDays", allActivities.some((a) => a.actualDays === 0) && allActivities.some((a) => (a.actualDays ?? 0) > 0));
    const finalTotals = computeProjectFinancials(allActivities);
    check("12. Project Actual Cost is non-negative", Number(finalTotals.actualCost) >= 0);
    check("...and Estimated Cost is non-negative too (sanity — Task Type costs are already non-negative-constrained)", Number(finalTotals.estimatedCost) >= 0);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): activities", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): task types", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): projects", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): project requests", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
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
  console.error("Test crashed:", err);
  process.exit(1);
});
