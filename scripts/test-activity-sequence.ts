/**
 * Regression coverage for the request-origin Project Activity sequence
 * feature — an ordered vertical list (1..N), drag-and-drop reorderable,
 * applying ONLY to Projects where Project.projectRequestId != null.
 *
 * Covers: scope (manual vs request-origin), initial/append/legacy
 * ordering, reorder atomicity/contiguity, authorization (activity.edit
 * reused, never a new permission), create/delete normalization, Project-
 * move semantics, concurrency, and a regression proving reorder never
 * touches status/dates/cost/financials.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-activity-sequence.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
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
const TAG = `aseq-${RUN_ID}`;

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
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  const activitiesPOST = (await import("@/app/api/activities/route")).POST;
  const activitiesPATCH = (await import("@/app/api/activities/[id]/route")).PATCH;
  const activitiesDELETE = (await import("@/app/api/activities/[id]/route")).DELETE;
  const reorderPATCH = (await import("@/app/api/projects/[id]/activities/order/route")).PATCH;
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
    async function addMembership(userId: string, departmentId: string, role: DepartmentRole = DepartmentRole.DEPARTMENT_ADMIN) {
      await prisma.departmentMembership.create({
        data: { userId, departmentId, role, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    }

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const worker1 = await makeUser(`${TAG}-worker1@kinsen.gr`);
    await addMembership(worker1.id, dept.id);
    const viewerOnly = await makeUser(`${TAG}-viewer@kinsen.gr`);
    await addMembership(viewerOnly.id, dept.id, DepartmentRole.VIEWER);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };

    async function makeRequestOriginProject(tag: string): Promise<string> {
      currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
      const submitRes = await requestsPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "Activity sequence fixture — description long enough for validation.",
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
        jsonReq({ title: `${TAG} ${tag} request`, description: "fixture", projectOwnerId: adminUser.id, expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-05", expenseTypeId: expenseType.id }),
        { params: Promise.resolve({ id: submitted.id }) }
      );
      if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
      const project = await setupRes.json();
      projectIds.push(project.id);
      return project.id;
    }

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const taskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} TaskType`, cost: 100 }));
    if (taskTypeRes.status !== 201) throw new Error(`Fixture task type create failed: ${taskTypeRes.status}: ${JSON.stringify(await taskTypeRes.json())}`);
    const taskType = await taskTypeRes.json();
    taskTypeIds.push(taskType.id);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };

    async function createActivity(projectId: string, title: string) {
      const res = await activitiesPOST(
        jsonReq({
          title,
          projectId,
          departmentId: dept.id,
          expectedStartDate: "2026-01-01",
          expectedFinishDate: "2026-01-02",
          taskTypeId: taskType.id,
          ownerId: worker1.id,
          assignedUserIds: [worker1.id],
        })
      );
      if (res.status !== 201) throw new Error(`Fixture activity create failed: ${res.status}: ${JSON.stringify(await res.json())}`);
      const activity = await res.json();
      activityIds.push(activity.id);
      return activity;
    }

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: adminUser.id } });
    projectIds.push(manualProject.id);

    // ══════════════════════ 1-3. SCOPE ══════════════════════
    console.log("\n=== 1-3. Scope: manual vs request-origin, provenance server-resolved ===\n");
    const manualActivityRes = await activitiesPOST(jsonReq({ title: `${TAG} manual activity`, projectId: manualProject.id, departmentId: dept.id }));
    check("(fixture) Manual Project Activity creation -> 201", manualActivityRes.status === 201);
    const manualActivity = await manualActivityRes.json();
    activityIds.push(manualActivity.id);
    check("1. Manual Project Activity has NO sequence at all — existing behavior retained", manualActivity.sequence === null || manualActivity.sequence === undefined);

    const project = await makeRequestOriginProject("main");
    const actA = await createActivity(project, "Activity A");
    check("2. Request-origin Project's first Activity receives sequence = 1", actA.sequence === 1);

    const forgedReorderRes = await reorderPATCH(jsonReq({ activityIds: [actA.id] }, "PATCH"), { params: Promise.resolve({ id: manualProject.id }) });
    check("3. The reorder API independently re-resolves provenance from the Project row — a manual Project is rejected (403 not_request_origin), never trusting any client flag/route", forgedReorderRes.status === 403 && (await forgedReorderRes.json()).code === "not_request_origin");

    // ══════════════════════ 4-6. INITIAL ORDER ══════════════════════
    console.log("\n=== 4-6. Initial order: append on create, deterministic legacy fallback ===\n");
    const actB = await createActivity(project, "Activity B");
    const actC = await createActivity(project, "Activity C");
    const actD = await createActivity(project, "Activity D");
    check("5/6. New Activities append to the end: B=2, C=3, D=4", actB.sequence === 2 && actC.sequence === 3 && actD.sequence === 4);

    // Legacy simulation: a DEDICATED Project (never reused for the reorder
    // tests below — the reorder service requires the full current
    // Activity set, so mixing legacy rows into `project` would make every
    // later reorder payload a "partial list" by construction) with two
    // Activities created directly via Prisma (bypassing the API, as a
    // pre-migration row would have been), both with sequence: null — the
    // deterministic (sequence ASC NULLS LAST, createdAt ASC) fallback must
    // still render them in a stable order.
    const legacyProject = await makeRequestOriginProject("legacy");
    const legacy1 = await prisma.projectActivity.create({ data: { title: `${TAG} Legacy1`, projectId: legacyProject, departmentId: dept.id, createdById: worker1.id, sequence: null } });
    await new Promise((r) => setTimeout(r, 10));
    const legacy2 = await prisma.projectActivity.create({ data: { title: `${TAG} Legacy2`, projectId: legacyProject, departmentId: dept.id, createdById: worker1.id, sequence: null } });
    activityIds.push(legacy1.id, legacy2.id);
    const allLegacyActivities = await prisma.projectActivity.findMany({ where: { projectId: legacyProject }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    check("4. Legacy (null-sequence) Activities render deterministically, in createdAt order", allLegacyActivities[0].id === legacy1.id && allLegacyActivities[1].id === legacy2.id);

    // ══════════════════════ 7-13. REORDER ══════════════════════
    console.log("\n=== 7-13. Reorder: atomic, contiguous, persists ===\n");
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const reorder1Res = await reorderPATCH(jsonReq({ activityIds: [actC.id, actA.id, actB.id, actD.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("7. 1,2,3,4 -> submit [C,A,B,D] -> 200", reorder1Res.status === 200);
    const afterReorder1 = await prisma.projectActivity.findMany({ where: { id: { in: [actA.id, actB.id, actC.id, actD.id] } }, select: { id: true, sequence: true } });
    const seqOf = (rows: { id: string; sequence: number | null }[], id: string) => rows.find((r) => r.id === id)?.sequence;
    check("...persisted: C=1, A=2, B=3, D=4", seqOf(afterReorder1, actC.id) === 1 && seqOf(afterReorder1, actA.id) === 2 && seqOf(afterReorder1, actB.id) === 3 && seqOf(afterReorder1, actD.id) === 4);

    // 8/9: reload (fresh read) preserves the order, and it's a clean 1..N.
    const reread = await prisma.projectActivity.findMany({ where: { id: { in: [actA.id, actB.id, actC.id, actD.id] } }, orderBy: { sequence: "asc" }, select: { id: true, sequence: true } });
    check("8/9. Reload preserves the new order, displayed as 1,2,3,4", reread.map((r) => r.id).join(",") === [actC.id, actA.id, actB.id, actD.id].join(",") && reread.every((r, i) => r.sequence === i + 1));

    // 10: moving a middle item downward (B above D: currently C,A,B,D -> C,A,D,B).
    const reorder2Res = await reorderPATCH(jsonReq({ activityIds: [actC.id, actA.id, actD.id, actB.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("10. Moving a middle item downward -> 200", reorder2Res.status === 200);
    const afterReorder2 = await prisma.projectActivity.findMany({ where: { id: { in: [actA.id, actB.id, actC.id, actD.id] } }, select: { id: true, sequence: true } });
    check("...B correctly moved to the end", seqOf(afterReorder2, actB.id) === 4 && seqOf(afterReorder2, actD.id) === 3);

    // 11: moving the first item (C) to last.
    const reorder3Res = await reorderPATCH(jsonReq({ activityIds: [actA.id, actD.id, actB.id, actC.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("11. Moving the first item to last -> 200", reorder3Res.status === 200);
    const afterReorder3 = await prisma.projectActivity.findMany({ where: { id: { in: [actA.id, actB.id, actC.id, actD.id] } }, select: { sequence: true } });
    const sortedSeqs = afterReorder3.map((r) => r.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
    check("12. No duplicate positions among the 4 reordered Activities", new Set(sortedSeqs).size === 4);
    check("13. No gaps — exactly 1,2,3,4", sortedSeqs.join(",") === "1,2,3,4");

    // ══════════════════════ 14-17. AUTHORIZATION ══════════════════════
    console.log("\n=== 14-17. Authorization: activity.edit reused, never a new permission ===\n");
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const authorizedReorderRes = await reorderPATCH(jsonReq({ activityIds: [actA.id, actB.id, actC.id, actD.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("14. A user with activity.edit (DEPARTMENT_ADMIN) can reorder -> 200", authorizedReorderRes.status === 200);

    currentSession = { user: { id: viewerOnly.id, role: Role.USER, customRoleId: null } };
    const viewerReorderRes = await reorderPATCH(jsonReq({ activityIds: [actB.id, actA.id, actC.id, actD.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("15. A read-only VIEWER (no activity.edit) cannot reorder -> 403 forbidden", viewerReorderRes.status === 403 && (await viewerReorderRes.json()).code === "missing_permission");
    const unaffectedAfterViewerAttempt = await prisma.projectActivity.findMany({ where: { id: actA.id }, select: { sequence: true } });
    check("...and the rejected attempt changed nothing", unaffectedAfterViewerAttempt[0].sequence === 1);

    currentSession = null;
    const unauthRes = await reorderPATCH(jsonReq({ activityIds: [actA.id, actB.id, actC.id, actD.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("16. An unauthenticated request is rejected (401)", unauthRes.status === 401);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const otherProject = await makeRequestOriginProject("other");
    const foreignActivity = await createActivity(otherProject, "Foreign Activity");
    const injectionRes = await reorderPATCH(jsonReq({ activityIds: [actA.id, actB.id, actC.id, foreignActivity.id] }, "PATCH"), { params: Promise.resolve({ id: project }) });
    check("17. An Activity from a DIFFERENT Project cannot be injected into the reorder payload -> 400 invalid_activity_ids", injectionRes.status === 400 && (await injectionRes.json()).code === "invalid_activity_ids");
    const foreignUnaffected = await prisma.projectActivity.findUniqueOrThrow({ where: { id: foreignActivity.id }, select: { sequence: true, projectId: true } });
    check("...and the foreign Activity's own project/sequence is completely untouched", foreignUnaffected.projectId === otherProject && foreignUnaffected.sequence === 1);

    // ══════════════════════ 18-20. CREATE / DELETE ══════════════════════
    console.log("\n=== 18-20. Create appends; delete renormalizes to contiguous 1..N ===\n");
    const actE = await createActivity(project, "Activity E");
    check("18. A brand-new Activity appends to the end (position 5, after the 4 reordered + E)", actE.sequence === 5);

    // 19: delete a MIDDLE one (by current sequence) and confirm contiguity.
    const beforeDeleteOrder = await prisma.projectActivity.findMany({ where: { id: { in: [actA.id, actB.id, actC.id, actD.id, actE.id] } }, orderBy: { sequence: "asc" }, select: { id: true } });
    const middleId = beforeDeleteOrder[2].id;
    const deleteMiddleRes = await activitiesDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: middleId }) });
    check("(fixture) Deleting the middle Activity -> 204", deleteMiddleRes.status === 204);
    const afterDeleteMiddle = await prisma.projectActivity.findMany({ where: { projectId: project }, orderBy: { sequence: "asc" }, select: { sequence: true } });
    const middleSeqs = afterDeleteMiddle.filter((r) => r.sequence !== null).map((r) => r.sequence);
    check("19. After deleting a middle Activity, remaining sequence is contiguous 1..N (no gap)", JSON.stringify(middleSeqs) === JSON.stringify(middleSeqs.map((_, i) => i + 1)));

    // 20: delete the FIRST (by current sequence) one.
    const beforeDeleteFirst = await prisma.projectActivity.findMany({ where: { projectId: project, sequence: { not: null } }, orderBy: { sequence: "asc" }, select: { id: true } });
    const firstId = beforeDeleteFirst[0].id;
    await activitiesDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: firstId }) });
    const afterDeleteFirst = await prisma.projectActivity.findMany({ where: { projectId: project, sequence: { not: null } }, orderBy: { sequence: "asc" }, select: { sequence: true } });
    check("20. After deleting the FIRST Activity, remaining sequence is still contiguous 1..N", afterDeleteFirst.map((r) => r.sequence).join(",") === afterDeleteFirst.map((_, i) => i + 1).join(","));

    // ══════════════════════ 21-23. PROJECT CHANGE ══════════════════════
    console.log("\n=== 21-23. Moving an Activity between Projects reconciles both sequences ===\n");
    const remainingBeforeMove = await prisma.projectActivity.findMany({ where: { projectId: project, sequence: { not: null } }, orderBy: { sequence: "asc" }, select: { id: true } });
    const movingActivityId = remainingBeforeMove[0].id;
    const moveRes = await activitiesPATCH(jsonReq({ projectId: otherProject }, "PATCH"), { params: Promise.resolve({ id: movingActivityId }) });
    check("(fixture) Moving an Activity from one request-origin Project to another -> 200", moveRes.status === 200);
    const movedActivity = await moveRes.json();
    check("22. Moving INTO a request-origin Project appends to its end (otherProject already has 1 -> this becomes 2)", movedActivity.sequence === 2);
    const sourceAfterMove = await prisma.projectActivity.findMany({ where: { projectId: project, sequence: { not: null } }, orderBy: { sequence: "asc" }, select: { sequence: true } });
    check("21. The SOURCE Project's remaining sequence is renormalized to contiguous 1..N (no gap left by the moved-out Activity)", sourceAfterMove.map((r) => r.sequence).join(",") === sourceAfterMove.map((_, i) => i + 1).join(","));
    const destAfterMove = await prisma.projectActivity.findMany({ where: { projectId: otherProject }, orderBy: { sequence: "asc" }, select: { sequence: true } });
    check("23. The DESTINATION Project's sequence is a clean 1,2 — both Projects consistent after a cross-request-origin move", destAfterMove.map((r) => r.sequence).join(",") === "1,2");

    // Moving into a MANUAL Project clears sequence (meaningless there).
    const moveToManualRes = await activitiesPATCH(jsonReq({ projectId: manualProject.id }, "PATCH"), { params: Promise.resolve({ id: movedActivity.id }) });
    check("...moving an Activity INTO a manual Project clears its sequence back to null", moveToManualRes.status === 200 && (await moveToManualRes.json()).sequence === null);

    // ══════════════════════ 24-25. CONCURRENCY ══════════════════════
    console.log("\n=== 24-25. Concurrency: no corrupt duplicate/gapped sequence ===\n");
    const concurrencyProject = await makeRequestOriginProject("concurrency");
    const cAct1 = await createActivity(concurrencyProject, "Concurrency Act1");
    const cAct2 = await createActivity(concurrencyProject, "Concurrency Act2");
    const cAct3 = await createActivity(concurrencyProject, "Concurrency Act3");

    const [concReorderA, concReorderB] = await Promise.all([
      reorderPATCH(jsonReq({ activityIds: [cAct2.id, cAct1.id, cAct3.id] }, "PATCH"), { params: Promise.resolve({ id: concurrencyProject }) }),
      reorderPATCH(jsonReq({ activityIds: [cAct3.id, cAct1.id, cAct2.id] }, "PATCH"), { params: Promise.resolve({ id: concurrencyProject }) }),
    ]);
    check("24. Two concurrent reorder requests for the same Project both resolve (<500), never corrupting the table", concReorderA.status < 500 && concReorderB.status < 500);
    const concFinal = await prisma.projectActivity.findMany({ where: { projectId: concurrencyProject }, select: { sequence: true } });
    const concSeqs = concFinal.map((r) => r.sequence).sort((a, b) => (a ?? 0) - (b ?? 0));
    check("...the final persisted state is still a clean, contiguous 1,2,3 — never duplicated or gapped", concSeqs.join(",") === "1,2,3");

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const concurrencyCreateProject = await makeRequestOriginProject("concurrency-create");
    const [concCreateA, concCreateB, concCreateC] = await Promise.all([
      createActivity(concurrencyCreateProject, "Concurrent Create A"),
      createActivity(concurrencyCreateProject, "Concurrent Create B"),
      createActivity(concurrencyCreateProject, "Concurrent Create C"),
    ]);
    const concCreateSeqs = [concCreateA.sequence, concCreateB.sequence, concCreateC.sequence].sort((a, b) => a - b);
    check("25. Three CONCURRENT Activity creations under the same Project never collide on the same append position", new Set(concCreateSeqs).size === 3 && concCreateSeqs.join(",") === "1,2,3");

    // ══════════════════════ 26-30. REGRESSIONS: reorder changes ORDER ONLY ══════════════════════
    console.log("\n=== 26-30. Reorder never touches status, dates, cost, or financial totals ===\n");
    const regressionProject = await makeRequestOriginProject("regression");
    const rAct1 = await createActivity(regressionProject, "Regression Act1");
    const rAct2 = await createActivity(regressionProject, "Regression Act2");
    await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: rAct1.id }) });
    const beforeReorderSnapshot = await prisma.projectActivity.findUniqueOrThrow({ where: { id: rAct1.id } });
    const projectFinancialsBefore = computeProjectFinancials(await prisma.projectActivity.findMany({ where: { projectId: regressionProject }, select: { taskTypeCost: true, expectedDays: true, actualDays: true } }));

    const regressionReorderRes = await reorderPATCH(jsonReq({ activityIds: [rAct2.id, rAct1.id] }, "PATCH"), { params: Promise.resolve({ id: regressionProject }) });
    check("(fixture) Reorder succeeds -> 200", regressionReorderRes.status === 200);
    const afterReorderSnapshot = await prisma.projectActivity.findUniqueOrThrow({ where: { id: rAct1.id } });
    check("26. Reorder does not modify Activity status", afterReorderSnapshot.status === beforeReorderSnapshot.status);
    check("27. Reorder does not modify completedAt", afterReorderSnapshot.completedAt?.getTime() === beforeReorderSnapshot.completedAt?.getTime());
    check("28. Reorder does not modify expectedDays/actualDays", afterReorderSnapshot.expectedDays === beforeReorderSnapshot.expectedDays && afterReorderSnapshot.actualDays === beforeReorderSnapshot.actualDays);
    check("29. Reorder does not modify Task Type or its snapshot cost", afterReorderSnapshot.taskTypeId === beforeReorderSnapshot.taskTypeId && afterReorderSnapshot.taskTypeCost?.toString() === beforeReorderSnapshot.taskTypeCost?.toString());
    check("...and the sequence DID actually change (proving this isn't a no-op)", afterReorderSnapshot.sequence !== beforeReorderSnapshot.sequence);

    const projectFinancialsAfter = computeProjectFinancials(await prisma.projectActivity.findMany({ where: { projectId: regressionProject }, select: { taskTypeCost: true, expectedDays: true, actualDays: true } }));
    check("30. Project Estimated/Actual Cost are completely unchanged by the reorder — set-based aggregation, never order-dependent", projectFinancialsBefore.estimatedCost.toString() === projectFinancialsAfter.estimatedCost.toString() && projectFinancialsBefore.actualCost.toString() === projectFinancialsAfter.actualCost.toString());
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
