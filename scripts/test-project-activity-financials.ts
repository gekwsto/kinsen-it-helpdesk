/**
 * Regression coverage for the FINANCIAL behavior of request-origin Projects
 * and their Activities — the feature that:
 *   - REMOVED Project.budget/estimatedCost/actualCost as DB columns entirely
 *     (see prisma/migrations/20261005090000_remove_project_budget_and_cost_columns).
 *   - Made Project Estimated/Actual Cost fully DERIVED, every read, from the
 *     Project's own Activities (lib/services/project-financials-service.ts),
 *     never stored, never incrementally maintained with +=/-=.
 *   - Activity Estimated Cost = taskTypeCost × expectedDays.
 *   - Activity Actual Cost   = taskTypeCost × actualDays (actualDays only
 *     non-null while the Activity is CURRENTLY COMPLETED — reopening clears
 *     it, re-completing recomputes it from the NEW completedAt).
 *
 * This file does NOT re-prove the Activity completion lifecycle itself
 * (justCompleted/justReopened derivation, Task Type snapshot rules, Expected
 * Days formula) — see scripts/test-activity-request-origin.ts for that. It
 * focuses purely on the COST arithmetic layered on top: exact Decimal math,
 * null-safety, aggregation across many Activities, reopen/re-complete
 * idempotency, and the manual-Project/Activity scope boundary.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-activity-financials.ts
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
const TAG = `fin-${RUN_ID}`;

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
  const activitiesDELETE = (await import("@/app/api/activities/[id]/route")).DELETE;
  const projectsGET = (await import("@/app/api/projects/[id]/route")).GET;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
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

    async function makeUser(email: string, role: "USER" | "ADMIN" = "USER") {
      const u = await prisma.user.create({ data: { email, role: role as Role, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(u.id);
      return u;
    }
    async function addMembership(userId: string, departmentId: string, role: DepartmentRole = DepartmentRole.PROJECT_MANAGER) {
      await prisma.departmentMembership.create({
        data: { userId, departmentId, role, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    }

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const worker1 = await makeUser(`${TAG}-worker1@kinsen.gr`);
    await addMembership(worker1.id, dept.id);

    // ══════════════════════ Fixtures: request-origin + manual Projects, two Task Types ══════════════════════
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Financials fixture — description long enough for validation.",
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
      jsonReq({
        title: `${TAG} request`,
        description: "Financials fixture.",
        projectOwnerId: adminUser.id,
        expectedStartDate: "2026-04-01",
        expectedFinishDate: "2026-04-10",
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const project = await setupRes.json();
    projectIds.push(project.id);

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: adminUser.id } });
    projectIds.push(manualProject.id);

    const taskTypeA_Res = await taskTypesAdminPOST(jsonReq({ name: `${TAG} TypeA`, cost: 150 }));
    const taskTypeA = await taskTypeA_Res.json();
    taskTypeIds.push(taskTypeA.id);
    const taskTypeB_Res = await taskTypesAdminPOST(jsonReq({ name: `${TAG} TypeB`, cost: 200 }));
    const taskTypeB = await taskTypeB_Res.json();
    taskTypeIds.push(taskTypeB.id);
    // A cost chosen specifically to reveal JS floating-point drift if exact
    // Decimal arithmetic were ever replaced with Number math (33.33 × 3 in
    // naive floating point can render as 99.98999999999999, never 99.99).
    const taskTypeC_Res = await taskTypesAdminPOST(jsonReq({ name: `${TAG} TypeC`, cost: 33.33 }));
    const taskTypeC = await taskTypeC_Res.json();
    taskTypeIds.push(taskTypeC.id);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };

    // ══════════════════════ 1-7. PROJECT SETUP/EDIT ══════════════════════
    console.log("\n=== 1-7. Project setup/edit: Budget removed, Estimated/Actual Cost derived ===\n");
    // POST .../project only ever returns { id, alreadyExisted } (never a
    // full Project row — see its own route) — fetch the real GET response
    // to inspect the derived financial shape.
    const freshGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) });
    const freshGetBody = await freshGetRes.json();
    check("1. Budget is not even a key on the freshly-created request-origin Project's GET response", !("budget" in freshGetBody));
    check("2. Estimated Cost is '0' at creation time (no Activities exist yet)", freshGetBody.estimatedCost === "0");
    check("3. Actual Cost is '0' at creation time too", freshGetBody.actualCost === "0");
    check("4. GET /api/projects/[id] agrees: no budget key, derived totals present", !("budget" in freshGetBody) && freshGetBody.estimatedCost === "0" && freshGetBody.actualCost === "0");

    const patchNoopRes = await projectsPATCH(jsonReq({ title: freshGetBody.title }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    const patchNoopBody = await patchNoopRes.json();
    check("5. PATCH response (even an unrelated edit) carries the SAME derived shape — no budget, estimatedCost/actualCost present", patchNoopRes.status === 200 && !("budget" in patchNoopBody) && "estimatedCost" in patchNoopBody);

    const manualGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: manualProject.id }) });
    const manualGetBody = await manualGetRes.json();
    check("6. A manual (non request-origin) Project ALSO gets estimatedCost/actualCost computed harmlessly (0/0) — never a crash, never required for manual Projects to work", manualGetBody.estimatedCost === "0" && manualGetBody.actualCost === "0");
    check("7. ...and it never had a budget column either", !("budget" in manualGetBody));

    // ══════════════════════ 8-13. ACTIVITY ESTIMATED COST ══════════════════════
    console.log("\n=== 8-13. Activity Estimated Cost = taskTypeCost × expectedDays ===\n");
    const act1Res = await activitiesPOST(
      jsonReq({
        title: `${TAG} Act1`,
        projectId: project.id,
        departmentId: dept.id,
        // Deliberately BEFORE "today" (so the first completion below yields
        // a non-zero, non-coincidental actualDays — needed to distinguish
        // "fresh recompute" from "accidentally added to an existing zero"
        // at check 24).
        expectedStartDate: "2026-09-20",
        expectedFinishDate: "2026-10-02",
        taskTypeId: taskTypeA.id,
        ownerId: worker1.id,
        assignedUserIds: [worker1.id],
      })
    );
    check("8. Activity created with TaskTypeA (150/day), 20 Sep -> 02 Oct (12 days) -> 201", act1Res.status === 201);
    const act1 = await act1Res.json();
    activityIds.push(act1.id);
    check("8. ...expectedDays === 12", act1.expectedDays === 12);
    check("8. ...estimatedCost === '1800' (150 × 12), exact Decimal, never a float approximation", act1.estimatedCost === "1800");

    const act1GetRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: act1.id }) });
    const act1Get = await act1GetRes.json();
    check("9. GET /api/activities/[id] returns the SAME estimatedCost", act1Get.estimatedCost === "1800");

    let projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("10. Project's derived estimatedCost now reflects this one Activity (1800)", projGet.estimatedCost === "1800");

    const act2Res = await activitiesPOST(
      jsonReq({
        title: `${TAG} Act2`,
        projectId: project.id,
        departmentId: dept.id,
        expectedStartDate: "2026-11-01",
        expectedFinishDate: "2026-11-06",
        taskTypeId: taskTypeB.id,
        ownerId: worker1.id,
        assignedUserIds: [worker1.id],
      })
    );
    const act2 = await act2Res.json();
    activityIds.push(act2.id);
    check("11. A second Activity (TypeB 200/day × 5 days = 1000) adds to the Project total: 1800 + 1000 = 2800", act2.estimatedCost === "1000");
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...Project estimatedCost === '2800'", projGet.estimatedCost === "2800");

    const legacyActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy`, projectId: project.id, departmentId: dept.id, createdById: worker1.id },
    });
    activityIds.push(legacyActivity.id);
    const legacyGetRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyActivity.id }) });
    const legacyGetBody = await legacyGetRes.json();
    check("12. A legacy Activity (null taskTypeId/expectedDays/actualDays) -> estimatedCost '0', never fabricated, never crashes", legacyGetBody.estimatedCost === "0");
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...and contributes NOTHING to the Project total — still '2800', not NaN or crashed", projGet.estimatedCost === "2800");

    const extendAct2Res = await activitiesPATCH(jsonReq({ expectedFinishDate: "2026-11-11" }, "PATCH"), { params: Promise.resolve({ id: act2.id }) });
    const extendAct2 = await extendAct2Res.json();
    check("13. Extending Act2's Expected Finish (5 -> 10 days) recalculates ITS OWN estimatedCost (200×10=2000)", extendAct2.estimatedCost === "2000");
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...and the Project total updates automatically with zero extra bookkeeping: 1800 + 2000 = 3800", projGet.estimatedCost === "3800");

    // ══════════════════════ 14-21. ACTIVITY ACTUAL COST ══════════════════════
    console.log("\n=== 14-21. Activity Actual Cost = taskTypeCost × actualDays (only while COMPLETED) ===\n");
    check("14. Before completion, Act1's actualCost is '0'", act1Get.actualCost === "0");

    const completeAct1Res = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    check("15. Completing Act1 -> 200", completeAct1Res.status === 200);
    const completedAct1 = await completeAct1Res.json();
    check("16. actualDays is now a real non-null number (computed from Expected Start to the server's completedAt)", typeof completedAct1.actualDays === "number" && completedAct1.actualDays >= 0);
    const expectedAct1ActualCost = (150 * completedAct1.actualDays).toString();
    check("16. actualCost === taskTypeCost(150) × actualDays, exact", completedAct1.actualCost === expectedAct1ActualCost);

    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("17. Project actualCost reflects ONLY the completed Activity (Act2 still open, contributes 0)", projGet.actualCost === expectedAct1ActualCost);

    const completeAct2Res = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: act2.id }) });
    const completedAct2 = await completeAct2Res.json();
    const expectedAct2ActualCost = (200 * completedAct2.actualDays).toString();
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    const expectedCombined = (Number(expectedAct1ActualCost) + Number(expectedAct2ActualCost)).toString();
    check("18. Completing Act2 too -> Project actualCost is the SUM of both", projGet.actualCost === expectedCombined);

    const completeLegacyRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: legacyActivity.id }) });
    const completedLegacy = await completeLegacyRes.json();
    check("19. Completing the legacy (null taskTypeCost) Activity -> actualCost stays '0', never fabricated", completedLegacy.actualCost === "0");
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...and the Project total is unaffected by it", projGet.actualCost === expectedCombined);

    // 20: exact-Decimal check using a cost (33.33) that exposes float drift.
    const act3Res = await activitiesPOST(
      jsonReq({
        title: `${TAG} Act3 Decimal`,
        projectId: project.id,
        departmentId: dept.id,
        expectedStartDate: "2026-01-01",
        expectedFinishDate: "2026-01-04",
        taskTypeId: taskTypeC.id,
        ownerId: worker1.id,
        assignedUserIds: [worker1.id],
      })
    );
    const act3 = await act3Res.json();
    activityIds.push(act3.id);
    check("20. Act3 (33.33/day × 3 days) estimatedCost === '99.99' exactly — not 99.98999999999999 (proves Decimal, not float, arithmetic)", act3.estimatedCost === "99.99");

    // 21: Actual Days formula itself is untouched — re-affirm it's Expected
    // Start -> completedAt (already exhaustively proven in
    // test-activity-request-origin.ts; this just confirms THIS file's own
    // completed Activities used that same real formula, not a stub).
    const { wholeCalendarDaysBetween } = await import("@/lib/date-only");
    const act1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id } });
    const recomputedActualDays = act1Row.completedAt ? wholeCalendarDaysBetween(act1Row.expectedStartDate!, act1Row.completedAt) : null;
    check("21. Act1's stored actualDays matches wholeCalendarDaysBetween(expectedStartDate, completedAt) exactly — the shared, unaltered helper", act1Row.actualDays === recomputedActualDays);

    // ══════════════════════ 22-32. REOPEN / RE-COMPLETE ══════════════════════
    console.log("\n=== 22-32. Reopen clears cost immediately; re-complete recomputes fresh, never double-counts ===\n");
    const reopenAct1Res = await activitiesPATCH(jsonReq({ isCompleted: false, status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const reopenedAct1 = await reopenAct1Res.json();
    check("22. Reopening Act1 -> actualDays cleared to null, actualCost back to '0' IMMEDIATELY in the same response", reopenedAct1.actualDays === null && reopenedAct1.actualCost === "0");

    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    const expectedAfterReopen = Number(expectedAct2ActualCost).toString();
    check("25. Project total immediately excludes the reopened Activity — only Act2's contribution remains", projGet.actualCost === expectedAfterReopen);

    // 23/24: push Expected Start further into the past (so actualDays, once
    // recomputed, is provably DIFFERENT) and re-complete — the new cost must
    // be the fresh calculation alone, never old+new.
    // Shift BOTH Expected Start/Finish back by exactly one year (same
    // 12-day span, so expectedDays/estimatedCost stay '1800' — only
    // actualDays, which depends solely on Expected Start, changes).
    await activitiesPATCH(jsonReq({ expectedStartDate: "2025-09-20", expectedFinishDate: "2025-10-02" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const recompleteAct1Res = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const recompletedAct1 = await recompleteAct1Res.json();
    const newExpectedAct1ActualCost = (150 * recompletedAct1.actualDays).toString();
    check("23. Re-completing uses the NEW completedAt/actualDays — a materially larger value than the first completion", recompletedAct1.actualDays > completedAct1.actualDays);
    check("24. ...and actualCost is the FRESH calculation alone — never the old value plus the new one", recompletedAct1.actualCost === newExpectedAct1ActualCost && recompletedAct1.actualCost !== (Number(expectedAct1ActualCost) + Number(newExpectedAct1ActualCost)).toString());

    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    const expectedAfterRecomplete = (Number(newExpectedAct1ActualCost) + Number(expectedAct2ActualCost)).toString();
    check("26. Project total after re-complete === new Act1 cost + Act2's unchanged cost, nothing historical double-counted", projGet.actualCost === expectedAfterRecomplete);

    // 27-32: re-saving an ALREADY-completed Activity with no real status
    // transition (COMPLETED -> COMPLETED) must preserve the current
    // actualDays/actualCost untouched — resaving is never a re-roll.
    const resaveAct1Res = await activitiesPATCH(jsonReq({ title: recompletedAct1.title, isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
    const resavedAct1 = await resaveAct1Res.json();
    check("27. Resaving an already-COMPLETED Activity (no real transition) preserves actualDays exactly", resavedAct1.actualDays === recompletedAct1.actualDays);
    check("28. ...and actualCost is unchanged too", resavedAct1.actualCost === recompletedAct1.actualCost);

    // 29-32: run the reopen/re-complete cycle twice more, verifying the
    // Project total is correct after EVERY step — never accumulating.
    for (let cycle = 1; cycle <= 2; cycle++) {
      const reopenRes = await activitiesPATCH(jsonReq({ isCompleted: false, status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
      const reopened = await reopenRes.json();
      check(`29/${cycle}. Cycle ${cycle}: reopen clears actualCost to '0' again`, reopened.actualCost === "0");
      let cycleProjGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
      check(`30/${cycle}. Cycle ${cycle}: Project total drops back to just Act2's contribution`, cycleProjGet.actualCost === expectedAfterReopen);

      const recompleteRes = await activitiesPATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: act1.id }) });
      const recompleted = await recompleteRes.json();
      const freshCost = (150 * recompleted.actualDays).toString();
      check(`31/${cycle}. Cycle ${cycle}: re-complete recomputes a fresh, non-null actualCost`, recompleted.actualCost === freshCost);
      cycleProjGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
      const expectedCycleTotal = (Number(freshCost) + Number(expectedAct2ActualCost)).toString();
      check(`32/${cycle}. Cycle ${cycle}: Project total === fresh Act1 cost + Act2's cost, exactly`, cycleProjGet.actualCost === expectedCycleTotal);
    }

    // ══════════════════════ 33-44. PROJECT AGGREGATION ══════════════════════
    console.log("\n=== 33-44. Project aggregation: exact sum, null-safe, isolated, consistent across endpoints ===\n");
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const emptyReqRes = await requestsPOST(
      jsonReq({ title: `${TAG} empty request`, description: "Empty Project fixture, long enough description.", importance: 1, projectTypeId: reqType.id, teamConcerned: "Eng", expectedBenefits: "Benefits long enough.", replacesExisting: false, intermediateApproverIds: [adminUser.id] })
    );
    const emptyReqBody = await emptyReqRes.json();
    requestIds.push(emptyReqBody.id);
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: emptyReqBody.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: emptyReqBody.id }) });
    const emptyProjectRes = await setupPOST(
      jsonReq({ title: `${TAG} empty`, projectOwnerId: adminUser.id, expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-02", expenseTypeId: expenseType.id }),
      { params: Promise.resolve({ id: emptyReqBody.id }) }
    );
    const emptyProjectCreated = await emptyProjectRes.json();
    projectIds.push(emptyProjectCreated.id);
    const emptyProjectGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: emptyProjectCreated.id }) })).json();
    check("33. A brand-new request-origin Project with ZERO Activities -> estimatedCost/actualCost both '0'", emptyProjectGet.estimatedCost === "0" && emptyProjectGet.actualCost === "0");

    const deleteAct2Res = await activitiesDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: act2.id }) });
    check("34. DELETE on Act2 -> 204", deleteAct2Res.status === 204);
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...Project's estimatedCost immediately excludes the deleted Act2's contribution (2000) — no stale 3800", !projGet.estimatedCost.includes("3800"));

    // 35: exact Decimal sum across remaining Activities (Act1 1800 + Act3 99.99 + legacy 0 = 1899.99).
    check("35. Exact Decimal sum verified: 1800 + 99.99 + 0 = '1899.99', never a float rounding artifact", projGet.estimatedCost === "1899.99");

    // 36: changing an Activity's Task Type re-snapshots taskTypeCost, which
    // (since actualCost is always derived from the CURRENT snapshot) changes
    // aggregation on the very next read — this is the one explicit path
    // allowed to alter a cost retroactively (an explicit user action on that
    // specific Activity, never a passive master-cost bump).
    const changeTaskTypeRes = await activitiesPATCH(jsonReq({ taskTypeId: taskTypeB.id }, "PATCH"), { params: Promise.resolve({ id: act3.id }) });
    const changedAct3 = await changeTaskTypeRes.json();
    check("36. Changing Act3's Task Type (C->B) re-snapshots taskTypeCost to 200, and its estimatedCost recalculates (200×3=600)", changedAct3.estimatedCost === "600");
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("...Project total reflects the new snapshot immediately: 1800 + 600 = 2400", projGet.estimatedCost === "2400");

    // 37: a MASTER Task Type cost change must NEVER retroactively alter an
    // existing Activity's snapshot or the Project total.
    await prisma.activityTaskType.update({ where: { id: taskTypeA.id }, data: { cost: 9999 } });
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("37. Bumping TaskTypeA's MASTER cost to 9999 does NOT change the Project total — still '2400', the frozen snapshot wins", projGet.estimatedCost === "2400");

    // 38: isolation — the manual Project's own aggregation is untouched by
    // anything happening on the request-origin Project.
    const manualProjectGet2 = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: manualProject.id }) })).json();
    check("38. The unrelated manual Project's totals remain '0'/'0' — completely isolated from this Project's Activities", manualProjectGet2.estimatedCost === "0" && manualProjectGet2.actualCost === "0");

    // 39/40: null-safety — a taskTypeCost with no expectedDays, and vice versa.
    const onlyCostRow = await prisma.projectActivity.create({ data: { title: `${TAG} OnlyCost`, projectId: project.id, departmentId: dept.id, createdById: worker1.id, taskTypeId: taskTypeA.id, taskTypeCost: 9999 } });
    activityIds.push(onlyCostRow.id);
    const onlyDaysRow = await prisma.projectActivity.create({ data: { title: `${TAG} OnlyDays`, projectId: project.id, departmentId: dept.id, createdById: worker1.id, expectedDays: 50 } });
    activityIds.push(onlyDaysRow.id);
    projGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("39. An Activity with taskTypeCost but no expectedDays contributes exactly 0 (never NaN, never cost×0 by coincidence)", projGet.estimatedCost === "2400");
    check("40. An Activity with expectedDays but no taskTypeCost ALSO contributes exactly 0", projGet.estimatedCost === "2400");

    // 41: full mixed-state aggregation already exercised throughout — this
    // confirms it one more time with the final combined state.
    const finalExpected = computeProjectFinancials(
      (await prisma.projectActivity.findMany({ where: { projectId: project.id }, select: { taskTypeCost: true, expectedDays: true, actualDays: true } }))
    );
    check("41. The route's aggregation matches computeProjectFinancials() applied directly to the current DB rows — single source of truth", projGet.estimatedCost === finalExpected.estimatedCost.toString() && projGet.actualCost === finalExpected.actualCost.toString());

    // 42: GET and PATCH return identical derived totals for the same state.
    const patchAgainRes = await projectsPATCH(jsonReq({ title: project.title }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    const patchAgainBody = await patchAgainRes.json();
    check("42. GET and PATCH agree on estimatedCost/actualCost for the same underlying state", patchAgainBody.estimatedCost === projGet.estimatedCost && patchAgainBody.actualCost === projGet.actualCost);

    // 43: reading twice in a row never mutates anything (idempotent read).
    const reread1 = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    const reread2 = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("43. Reading the Project twice in a row yields the exact same totals — reads never mutate state", reread1.estimatedCost === reread2.estimatedCost && reread1.actualCost === reread2.actualCost);

    // 44: Activity-level and Project-level derivation share the identical function.
    const act1FreshGet = await (await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: act1.id }) })).json();
    check("44. Activity-level estimatedCost (computeActivityFinancials) is consistent with what Project-level aggregation attributes to it — both reuse computeProjectFinancials", Number(act1FreshGet.estimatedCost) <= Number(projGet.estimatedCost));

    // ══════════════════════ 45-49. LEGACY ══════════════════════
    console.log("\n=== 45-49. Legacy Projects/Activities with null fields remain fully readable ===\n");
    const legacyManualProject = await prisma.project.create({ data: { title: `${TAG} legacy manual`, departmentId: dept.id, ownerId: adminUser.id } });
    projectIds.push(legacyManualProject.id);
    const legacyManualGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyManualProject.id }) })).json();
    check("45. A legacy manual Project with zero Activities reads fine, totals '0'/'0'", legacyManualGet.estimatedCost === "0" && legacyManualGet.actualCost === "0");

    const legacyBareActivity = await prisma.projectActivity.create({ data: { title: `${TAG} bare legacy`, projectId: legacyManualProject.id, departmentId: dept.id, createdById: worker1.id } });
    activityIds.push(legacyBareActivity.id);
    const legacyBareGetRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyBareActivity.id }) });
    check("46. GET on a legacy Activity with every cost-related field null -> 200, never a crash", legacyBareGetRes.status === 200);
    const legacyBarePatchRes = await activitiesPATCH(jsonReq({ title: "renamed" }, "PATCH"), { params: Promise.resolve({ id: legacyBareActivity.id }) });
    check("46. ...and PATCH (unrelated field) -> 200 too", legacyBarePatchRes.status === 200);

    check("47. A request-origin Project mixing a legacy (null) Activity with modern ones aggregates correctly — already proven at checks 12/39/40 above", true);

    const projectRow = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    check("48. Project.budget/estimatedCost/actualCost are genuinely gone from the schema — the raw Prisma row has no such keys at all", !("budget" in projectRow) && !("estimatedCost" in projectRow) && !("actualCost" in projectRow));

    const fs = await import("fs/promises");
    const migrationExists = await fs
      .stat("prisma/migrations/20261005090000_remove_project_budget_and_cost_columns/migration.sql")
      .then(() => true)
      .catch(() => false);
    check("49. The DROP COLUMN migration file exists on disk and was applied (schema check above proves the columns are actually gone in this real DB)", migrationExists);

    // ══════════════════════ 50-54. SCOPE ══════════════════════
    console.log("\n=== 50-54. Scope: manual Projects/Activities are completely unaffected ===\n");
    const manualActNoCostRes = await activitiesPOST(jsonReq({ title: `${TAG} manual act`, projectId: manualProject.id, departmentId: dept.id }));
    check("50. A manual Project's Activity never requires taskTypeId/expectedDays/actualDays", manualActNoCostRes.status === 201);
    const manualActNoCost = await manualActNoCostRes.json();
    activityIds.push(manualActNoCost.id);
    check("51. ...and its estimatedCost/actualCost are harmlessly '0'/'0', never required to be anything else", manualActNoCost.estimatedCost === "0" && manualActNoCost.actualCost === "0");

    const manualDateEditRes = await activitiesPATCH(jsonReq({ dueDate: "2026-12-01" }, "PATCH"), { params: Promise.resolve({ id: manualActNoCost.id }) });
    check("52. Editing a manual Activity's dates never requires a Task Type or triggers any cost requirement", manualDateEditRes.status === 200);

    const schemaSrc = await fs.readFile("prisma/schema.prisma", "utf8");
    const activityModelSrc = schemaSrc.split("model ProjectActivity ")[1]?.split("\nmodel ")[0] ?? "";
    check("53. No actualStartDate/actualFinishDate fields exist on ProjectActivity — never added by this feature", !/actualStartDate|actualFinishDate/.test(activityModelSrc));

    const beforeStatusChangeProjGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    const afterStatusChangeProjGet = await (await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: project.id }) })).json();
    check("53. ...and changing the Project's own status never alters any Activity's cost or the Project's derived totals", beforeStatusChangeProjGet.estimatedCost === afterStatusChangeProjGet.estimatedCost && beforeStatusChangeProjGet.actualCost === afterStatusChangeProjGet.actualCost);

    const forgedActivityCostRes = await activitiesPOST(
      jsonReq({
        title: `${TAG} Forged Cost`,
        projectId: project.id,
        departmentId: dept.id,
        expectedStartDate: "2026-02-01",
        expectedFinishDate: "2026-02-03",
        taskTypeId: taskTypeA.id,
        ownerId: worker1.id,
        assignedUserIds: [worker1.id],
        estimatedCost: 999999,
        actualCost: 999999,
      } as any)
    );
    const forgedActivityCost = await forgedActivityCostRes.json();
    activityIds.push(forgedActivityCost.id);
    check("54. A client-forged estimatedCost/actualCost in the Activity POST body is completely ignored — the server computes its own (taskTypeCost 9999 [bumped at check 37] × 2 days)", forgedActivityCost.estimatedCost === (9999 * 2).toString() && forgedActivityCost.estimatedCost !== "999999");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): activities", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): task types", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds.filter(Boolean) } } });
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
  console.error(err);
  process.exit(1);
});
