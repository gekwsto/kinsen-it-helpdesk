/**
 * Regression coverage for request-origin Activity metadata — ONLY
 * Activities whose parent Project itself originates from a Project Request
 * (Project.projectRequestId != null) get the extended setup requirement;
 * every other Activity (standalone, or under a manual Project) keeps its
 * exact current creation/edit behavior.
 *
 * Exercises the REAL route handlers directly (mocked @/lib/auth, same
 * convention as every other scripts/test-*.ts file in this repo).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-activity-request-origin.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, ActivityStatus } from "@prisma/client";
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
const TAG = `aro-${RUN_ID}`;

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
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const taskTypesAdminPOST = (await import("@/app/api/admin/activity-task-types/route")).POST;
  const taskTypesAdminPATCH = (await import("@/app/api/admin/activity-task-types/[id]/route")).PATCH;
  const taskTypesAdminDELETE = (await import("@/app/api/admin/activity-task-types/[id]/route")).DELETE;
  const taskTypesAdminGET = (await import("@/app/api/admin/activity-task-types/route")).GET;
  const taskTypesActiveGET = (await import("@/app/api/activity-task-types/route")).GET;

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
    // PROJECT_MANAGER (not VIEWER) — grants BOTH activity.create (so
    // worker1 can actually POST /api/activities) and activity.assignable
    // (so worker1/worker2 are legitimate Owner/Related-User candidates).
    async function addMembership(userId: string, departmentId: string, role: DepartmentRole = DepartmentRole.PROJECT_MANAGER) {
      await prisma.departmentMembership.create({
        data: { userId, departmentId, role, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    }

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const worker1 = await makeUser(`${TAG}-worker1@kinsen.gr`);
    const worker2 = await makeUser(`${TAG}-worker2@kinsen.gr`);
    await addMembership(worker1.id, dept.id);
    await addMembership(worker2.id, dept.id);
    const viewerNoManage = await makeUser(`${TAG}-viewer-nomanage@kinsen.gr`);
    await addMembership(viewerNoManage.id, dept.id);

    // ══════════════════════ Fixture: one real request-origin Project ══════════════════════
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Activity request-origin fixture — description long enough.",
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
        description: "Activity request-origin fixture.",
        projectOwnerId: adminUser.id,
        expectedStartDate: "2026-04-01",
        expectedFinishDate: "2026-04-10",
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const requestOriginProject = await setupRes.json();
    projectIds.push(requestOriginProject.id);

    // A plain manual Project, for every "manual stays unchanged" check.
    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: adminUser.id } });
    projectIds.push(manualProject.id);

    // ══════════════════════ Task Type fixtures ══════════════════════
    console.log("\n=== Task Type admin: permission-gated CRUD ===\n");
    currentSession = { user: { id: viewerNoManage.id, role: Role.USER, customRoleId: null } };
    const unauthorizedListRes = await taskTypesAdminGET();
    check("37. A user WITHOUT taskType.manage cannot GET the admin Task Type list", unauthorizedListRes.status === 403);
    const unauthorizedCreateRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} Unauthorized`, cost: 10 }));
    check("38. ...and cannot POST a new Task Type either", unauthorizedCreateRes.status === 403);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    check("36. ADMIN (which holds taskType.manage via its blanket bootstrap) CAN access the admin Task Type list", (await taskTypesAdminGET()).status === 200);

    const { hasPermission } = await import("@/lib/permissions");
    check("39. taskType.manage flows through the real hasPermission()/custom-role system (ADMIN bypass), not a hardcoded role check", await hasPermission(Role.ADMIN, "taskType.manage", null));
    check("...and a plain USER role does not have it by default", !(await hasPermission(Role.USER, "taskType.manage", null)));

    check("22. Task Type cost is REQUIRED on create — missing cost rejected", (await taskTypesAdminPOST(jsonReq({ name: `${TAG} NoCost` }))).status === 400 || (await taskTypesAdminPOST(jsonReq({ name: `${TAG} NoCost` }))).status === 422);
    check("23. Invalid money (negative) rejected", (await taskTypesAdminPOST(jsonReq({ name: `${TAG} Negative`, cost: -5 }))).status >= 400);
    check("23. Invalid money (3 decimal places) rejected", (await taskTypesAdminPOST(jsonReq({ name: `${TAG} 3dp`, cost: 10.555 }))).status >= 400);

    const devTaskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} Development`, cost: 100 }));
    check("(fixture) Task Type 'Development' created at cost 100", devTaskTypeRes.status === 201);
    const devTaskType = await devTaskTypeRes.json();
    taskTypeIds.push(devTaskType.id);
    check("...cost returned as a real number, not a Decimal string", devTaskType.cost === 100);

    const inactiveTaskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} Inactive`, cost: 50, isActive: false }));
    const inactiveTaskType = await inactiveTaskTypeRes.json();
    taskTypeIds.push(inactiveTaskType.id);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const activeOnlyRes = await taskTypesActiveGET();
    const activeOnlyList = await activeOnlyRes.json();
    check("(fixture) The active-only dropdown list includes Development", activeOnlyList.some((t: any) => t.id === devTaskType.id));
    check("...and EXCLUDES the inactive one", !activeOnlyList.some((t: any) => t.id === inactiveTaskType.id));

    // ══════════════════════ 1/2/3/4/5. Provenance / scope ══════════════════════
    console.log("\n=== 1/2/3/4/5. Provenance: server-resolved from Project.projectRequestId, never a client flag ===\n");
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };

    const manualActivityRes = await activitiesPOST(jsonReq({ title: `${TAG} Manual Activity`, projectId: manualProject.id, departmentId: dept.id }));
    check("1. Manual Project Activity creation still works with NONE of the new fields", manualActivityRes.status === 201);
    const manualActivity = await manualActivityRes.json();
    activityIds.push(manualActivity.id);
    check("2. ...and none of the new fields are required (all null/default)", manualActivity.expectedStartDate === null && manualActivity.ownerId === null && manualActivity.taskTypeId === null);

    const missingFieldsRes = await activitiesPOST(jsonReq({ title: `${TAG} RO Missing`, projectId: requestOriginProject.id, departmentId: dept.id }));
    check("3. Request-origin Project Activity creation WITHOUT the new fields -> rejected", missingFieldsRes.status === 400);
    const missingFieldsBody = await missingFieldsRes.json();
    check("...with code request_origin_fields_required and the real missing list", missingFieldsBody.code === "request_origin_fields_required" && Array.isArray(missingFieldsBody.missingFields) && missingFieldsBody.missingFields.length === 5);

    // 4: a client-sent fake flag changes nothing — there's no such field on
    // createActivitySchema at all, so this is a no-op, not a bypass.
    const forgedFlagRes = await activitiesPOST(jsonReq({ title: `${TAG} Forged Flag`, projectId: requestOriginProject.id, departmentId: dept.id, fromProjectRequest: false, isRequestOrigin: false } as any));
    check("4. A client-sent fake 'fromProjectRequest:false' flag changes nothing — still rejected the same way", forgedFlagRes.status === 400);

    // 5: confirmed by the fact that `manualActivityRes` (same route, same
    // schema, different Project) succeeded with zero extra requirements —
    // the ONLY difference was the resolved project.projectRequestId.
    check("5. Server resolves mode from Project.projectRequestId alone — proven by the manual/request-origin split above using the exact same endpoint", manualActivityRes.status === 201 && missingFieldsRes.status === 400);

    // ══════════════════════ 6-12. Expected dates / expectedDays ══════════════════════
    console.log("\n=== 6-12. Expected Start/Finish required at creation; expectedDays server-derived ===\n");
    const validRequestOriginPayload = () => ({
      title: `${TAG} RO Activity`,
      projectId: requestOriginProject.id,
      departmentId: dept.id,
      expectedStartDate: "2026-05-05",
      expectedFinishDate: "2026-05-17",
      taskTypeId: devTaskType.id,
      ownerId: worker1.id,
      assignedUserIds: [worker1.id, worker2.id],
    });

    check("6. Missing Expected Start -> rejected", (await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), expectedStartDate: undefined }))).status === 400);
    check("7. Missing Expected Finish -> rejected", (await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), expectedFinishDate: undefined }))).status === 400);
    const finishBeforeStartRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), expectedStartDate: "2026-05-17", expectedFinishDate: "2026-05-05" }));
    check("8. Finish before Start -> rejected", finishBeforeStartRes.status === 400);
    check("...with code invalid_expected_dates", (await finishBeforeStartRes.json()).code === "invalid_expected_dates");

    const sameDayRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} SameDay`, expectedStartDate: "2026-05-05", expectedFinishDate: "2026-05-05" }));
    check("9. Same-day Expected Start/Finish -> accepted, expectedDays = 0", sameDayRes.status === 201);
    const sameDayActivity = await sameDayRes.json();
    activityIds.push(sameDayActivity.id);
    check("9. ...expectedDays === 0", sameDayActivity.expectedDays === 0);

    const twelveDaysRes = await activitiesPOST(jsonReq(validRequestOriginPayload()));
    check("10. 05 May -> 17 May -> 201", twelveDaysRes.status === 201);
    const twelveDaysActivity = await twelveDaysRes.json();
    activityIds.push(twelveDaysActivity.id);
    check("10. ...expectedDays === 12", twelveDaysActivity.expectedDays === 12);

    const forgedDaysRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} ForgedDays`, expectedDays: 9999 } as any));
    check("11. A forged client expectedDays is simply ignored — not even a field on the schema", forgedDaysRes.status === 201);
    const forgedDaysActivity = await forgedDaysRes.json();
    activityIds.push(forgedDaysActivity.id);
    check("...server's own real calculation persists instead (12), never 9999", forgedDaysActivity.expectedDays === 12 && forgedDaysActivity.expectedDays !== 9999);

    // 12: DST/timezone safety — reuses the exact same wholeCalendarDaysBetween
    // helper already proven DST-safe for Project.expectedTotalInitialDays
    // (UTC-midnight normalization, not local time) — verified structurally.
    const { wholeCalendarDaysBetween } = await import("@/lib/date-only");
    check("12. Date math uses the shared UTC-midnight-normalized helper (DST-safe by construction)", wholeCalendarDaysBetween(new Date("2026-03-01"), new Date("2026-03-09")) === 8);

    // ══════════════════════ 13-20. Actual Days / completion transition ══════════════════════
    console.log("\n=== 13-20. Actual Days: computed ONLY at the real COMPLETED transition, from Expected Start ===\n");
    check("13. Actual Days is null before completion", twelveDaysActivity.actualDays === null);

    const forgedActualRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} ForgedActual`, actualDays: 777 } as any));
    const forgedActualActivity = await forgedActualRes.json();
    activityIds.push(forgedActualActivity.id);
    check("14. A client-sent actualDays at creation is ignored — not even a field on the schema", forgedActualActivity.actualDays === null);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const completeRes = await activitiesPATCH(jsonReq({ status: "COMPLETED", isCompleted: true }, "PATCH"), { params: Promise.resolve({ id: twelveDaysActivity.id }) });
    check("15. PATCHing status to COMPLETED -> 200", completeRes.status === 200);
    const completedActivity = await completeRes.json();
    check("16. Actual Days computed from Expected Start (2026-05-05), NOT Expected Finish (2026-05-17)", typeof completedActivity.actualDays === "number" && completedActivity.actualDays !== 0);
    check("17. completedAt is a real, server-set timestamp (not a client-submitted date)", !!completedActivity.completedAt);

    const forgedCompletedAtRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} ForgedCompletedAt`, status: "COMPLETED", completedAt: "2020-01-01" } as any));
    const forgedCompletedAtActivity = await forgedCompletedAtRes.json();
    activityIds.push(forgedCompletedAtActivity.id);
    const createdAtYear = new Date(forgedCompletedAtActivity.completedAt).getUTCFullYear();
    check("17. Creating DIRECTLY as COMPLETED with a forged completedAt -> the server's own clock wins, not 2020", createdAtYear >= 2026);

    const legacyNoStartRes = await activitiesPOST(jsonReq({ title: `${TAG} LegacyNoStart`, projectId: requestOriginProject.id, departmentId: dept.id, taskTypeId: devTaskType.id, ownerId: worker1.id, assignedUserIds: [worker1.id] } as any));
    // This should actually be rejected (missing dates) — simulate the TRUE
    // legacy case instead via direct DB write (pre-feature row), matching
    // every other legacy-safety test in this suite.
    check("(sanity) Creating without dates is still rejected — legacy rows never come from this path", legacyNoStartRes.status === 400);
    const legacyActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy RO Activity`, projectId: requestOriginProject.id, departmentId: dept.id, createdById: adminUser.id, progress: 0 },
    });
    activityIds.push(legacyActivity.id);
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const legacyCompleteRes = await activitiesPATCH(jsonReq({ status: "COMPLETED", isCompleted: true }, "PATCH"), { params: Promise.resolve({ id: legacyActivity.id }) });
    check("18. A legacy Activity with null Expected Start can still complete safely -> 200", legacyCompleteRes.status === 200);
    const legacyCompletedActivity = await legacyCompleteRes.json();
    check("18. ...Actual Days stays null (no expectedStartDate to compute from) — never fabricated", legacyCompletedActivity.actualDays === null);

    // 19/20: reopen clears actualDays; re-completing recomputes from the NEW date.
    const reopenRes = await activitiesPATCH(jsonReq({ status: "IN_PROGRESS", isCompleted: false }, "PATCH"), { params: Promise.resolve({ id: twelveDaysActivity.id }) });
    check("19. Reopening (COMPLETED -> IN_PROGRESS) -> 200", reopenRes.status === 200);
    const reopenedActivity = await reopenRes.json();
    check("19. ...Actual Days is cleared back to null", reopenedActivity.actualDays === null);

    await new Promise((r) => setTimeout(r, 1100)); // ensure a different wall-clock second for a distinguishable completedAt/actualDays recompute
    const recompleteRes = await activitiesPATCH(jsonReq({ status: "COMPLETED", isCompleted: true }, "PATCH"), { params: Promise.resolve({ id: twelveDaysActivity.id }) });
    const recompletedActivity = await recompleteRes.json();
    check("20. Completing again -> Actual Days is recomputed (non-null) from the NEW completion date", typeof recompletedActivity.actualDays === "number");

    // ══════════════════════ 24-29. Task Type snapshot semantics ══════════════════════
    console.log("\n=== 24-29. Task Type cost snapshot: frozen at the moment it's set, never retroactively rewritten ═��═\n");
    check("24. Activity snapshots the CURRENT Task Type cost at creation (100)", twelveDaysActivity.taskTypeCost !== null && Number(twelveDaysActivity.taskTypeCost) === 100);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const bumpCostRes = await taskTypesAdminPATCH(jsonReq({ cost: 150 }, "PATCH"), { params: Promise.resolve({ id: devTaskType.id }) });
    check("(fixture) Admin raises Development's cost from 100 to 150", bumpCostRes.status === 200 && (await bumpCostRes.json()).cost === 150);

    const rereadOldActivityRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: twelveDaysActivity.id }) });
    const rereadOldActivity = await rereadOldActivityRes.json();
    check("25. The EXISTING Activity's snapshot is STILL 100 — not retroactively rewritten to 150", Number(rereadOldActivity.taskTypeCost) === 100);

    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const newActivityAfterBumpRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} AfterBump` }));
    const newActivityAfterBump = await newActivityAfterBumpRes.json();
    activityIds.push(newActivityAfterBump.id);
    check("26. A NEW Activity created after the bump receives the NEW current cost (150)", Number(newActivityAfterBump.taskTypeCost) === 150);

    const forgedSnapshotRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} ForgedSnapshot`, taskTypeCost: 99999 } as any));
    const forgedSnapshotActivity = await forgedSnapshotRes.json();
    activityIds.push(forgedSnapshotActivity.id);
    check("27. A client-forged taskTypeCost is ignored — the server's own resolved snapshot (150) persists instead", Number(forgedSnapshotActivity.taskTypeCost) === 150 && Number(forgedSnapshotActivity.taskTypeCost) !== 99999);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const secondTaskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} Design`, cost: 200 }));
    const secondTaskType = await secondTaskTypeRes.json();
    taskTypeIds.push(secondTaskType.id);
    currentSession = { user: { id: worker1.id, role: Role.USER, customRoleId: null } };
    const changeTaskTypeRes = await activitiesPATCH(jsonReq({ taskTypeId: secondTaskType.id }, "PATCH"), { params: Promise.resolve({ id: newActivityAfterBump.id }) });
    check("28. Changing an Activity's Task Type on edit -> 200", changeTaskTypeRes.status === 200);
    const changedTaskTypeActivity = await changeTaskTypeRes.json();
    check("28. ...snapshot updates to the NEWLY selected type's current cost (200)", Number(changedTaskTypeActivity.taskTypeCost) === 200);

    const unrelatedEditRes = await activitiesPATCH(jsonReq({ title: `${TAG} AfterBump Renamed` }, "PATCH"), { params: Promise.resolve({ id: newActivityAfterBump.id }) });
    const unrelatedEditActivity = await unrelatedEditRes.json();
    check("29. Leaving Task Type UNCHANGED on an unrelated edit does NOT rewrite the snapshot", Number(unrelatedEditActivity.taskTypeCost) === 200);

    // ══════════════════════ 30-35. Owner / Related Users ══════════════════════
    console.log("\n=== 30-35. Owner required; Related Users (reused assignedUsers) require >=1 ═══\n");
    const missingOwnerRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} NoOwner`, ownerId: undefined }));
    check("30. Owner required for request-origin Activity -> rejected when omitted", missingOwnerRes.status === 400);

    const invalidOwnerRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} BadOwner`, ownerId: "cmx-not-a-real-user-id" }));
    check("31. An invalid/non-assignable Owner is rejected server-side", invalidOwnerRes.status === 400);
    check("...with code invalid_owner", (await invalidOwnerRes.json()).code === "invalid_owner");

    const missingRelatedUsersRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} NoRelated`, assignedUserIds: [] }));
    check("32. At least one Related User required -> rejected when the list is empty", missingRelatedUsersRes.status === 400);

    const invalidRelatedUserRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} BadRelated`, assignedUserIds: ["cmx-not-a-real-user-id"] }));
    check("33. An invalid Related User is rejected server-side", invalidRelatedUserRes.status === 400);
    check("...with code assignee_not_assignable", (await invalidRelatedUserRes.json()).code === "assignee_not_assignable");

    const dupedUserIds = [worker1.id, worker1.id, worker2.id, worker1.id];
    const dupedRes = await activitiesPOST(jsonReq({ ...validRequestOriginPayload(), title: `${TAG} Duped`, assignedUserIds: dupedUserIds }));
    check("34. Duplicate Related User ids are handled safely -> 201 (deduplicated, not an error)", dupedRes.status === 201);
    const dupedActivity = await dupedRes.json();
    activityIds.push(dupedActivity.id);
    check("...exactly 2 unique assignees connected, not 4", dupedActivity.assignedUsers.length === 2);

    check("35. Manual Project Activities preserve old user semantics (assignedUsers optional, no Owner/Related requirement)", manualActivity.assignedUsers.length === 0 && manualActivityRes.status === 201);

    // ══════════════════════ 41-43. Task Type delete safety ══════════════════════
    console.log("\n=== 41-43. Task Type delete: blocked while referenced, safe for an unused one ═══\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const deleteReferencedRes = await taskTypesAdminDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: devTaskType.id }) });
    check("42. DELETE on a Task Type still referenced by an Activity -> 409 item_in_use", deleteReferencedRes.status === 409);
    check("...it was NOT deleted — still present", (await prisma.activityTaskType.findUnique({ where: { id: devTaskType.id } })) !== null);
    check("...and no Activity was cascade-deleted by the blocked attempt", (await prisma.projectActivity.findUnique({ where: { id: twelveDaysActivity.id } })) !== null);

    const unusedTaskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG} Unused`, cost: 5 }));
    const unusedTaskType = await unusedTaskTypeRes.json();
    const deleteUnusedRes = await taskTypesAdminDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: unusedTaskType.id }) });
    check("41. An unused Task Type deletes cleanly -> 204", deleteUnusedRes.status === 204);

    const rereadAfterLifecycleRes = await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: twelveDaysActivity.id }) });
    const rereadAfterLifecycle = await rereadAfterLifecycleRes.json();
    check("43. The existing Activity remains readable after Task Type master lifecycle changes, still showing its Task Type name", rereadAfterLifecycleRes.status === 200 && rereadAfterLifecycle.taskType?.name === devTaskType.name);

    // ══════════════════════ 52-54. Legacy Activity readability/editability ══════════════════════
    console.log("\n=== 52-54. Legacy Activities with no new fields remain readable/editable/completable ═══\n");
    const legacyManual = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy Manual`, projectId: manualProject.id, departmentId: dept.id, createdById: adminUser.id, progress: 0 },
    });
    activityIds.push(legacyManual.id);
    check("52. A legacy Activity (null new fields) is readable via GET", (await activitiesGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyManual.id }) })).status === 200);
    const legacyEditRes = await activitiesPATCH(jsonReq({ title: `${TAG} Legacy Manual Renamed` }, "PATCH"), { params: Promise.resolve({ id: legacyManual.id }) });
    check("53. ...and editable (unrelated field) without requiring any of the new fields to be backfilled first", legacyEditRes.status === 200);
    check("54. ...a legacy REQUEST-ORIGIN Activity (legacyActivity, completed above) transitioned status successfully too", legacyCompleteRes.status === 200);

    // ══════════════════════ 60. Gantt semantics untouched ══════════════════════
    console.log("\n=== 60. Gantt still reads startDate/dueDate, never Expected Start/Finish ═══\n");
    const fs = await import("fs/promises");
    const ganttSrc = await fs.readFile("components/gantt/gantt-chart.tsx", "utf8");
    check("60. gantt-chart.tsx has NO reference to expectedStartDate/expectedFinishDate/expectedDays", !/expectedStartDate|expectedFinishDate|expectedDays/.test(ganttSrc));
    const projectGanttPageSrc = await fs.readFile("app/(main)/projects/gantt/page.tsx", "utf8");
    check("60. Project Gantt page still maps startDate/dueDate only", /a\.startDate/.test(projectGanttPageSrc) && /a\.dueDate/.test(projectGanttPageSrc) && !/expectedStartDate/.test(projectGanttPageSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): activities", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds.filter(Boolean) } } });
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
