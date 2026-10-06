/**
 * Permission-driven administration of three global reference-data
 * entities: Project Request Types, Project Expense Types, Activity Task
 * Types.
 *
 * BEFORE this task: Task Types already used its own dedicated
 * `taskType.manage` permission everywhere (page/GET/POST/PATCH/DELETE) —
 * unchanged by this task, verified here as a regression guard. Project
 * Request Types and Project Expense Types were both gated by the generic
 * `admin.access` permission everywhere — normalized here to their own
 * dedicated `projectRequestType.manage`/`projectExpenseType.manage` keys,
 * same shape `taskType.manage` already established. All three are
 * GLOBAL-only (see GLOBAL_ONLY_PERMISSION_KEYS in
 * app/api/admin/roles/[id]/permissions/[permId]/route.ts and
 * app/(main)/admin/roles/page.tsx) and independent of one another — a role
 * holding exactly one of the three can administer only that resource.
 *
 * Exercises the REAL route-handler functions directly (mocked @/lib/auth +
 * next/headers cookies()), same established pattern as this session's
 * other permission/scope regression tests.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-reference-data-manage-permissions.ts
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

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;

mock.module("@/lib/auth", {
  namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { Role, RoleScope, AuthProvider } = await import("@prisma/client");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: ProjectRequestTypesAdminPage } = await import("@/app/(main)/admin/project-request-types/page");
  const { default: ProjectExpenseTypesAdminPage } = await import("@/app/(main)/admin/project-expense-types/page");
  const { default: ActivityTaskTypesAdminPage } = await import("@/app/(main)/admin/activity-task-types/page");

  const reqTypesRoute = await import("@/app/api/admin/project-request-types/route");
  const reqTypesIdRoute = await import("@/app/api/admin/project-request-types/[id]/route");
  const expTypesRoute = await import("@/app/api/admin/project-expense-types/route");
  const expTypesIdRoute = await import("@/app/api/admin/project-expense-types/[id]/route");
  const taskTypesRoute = await import("@/app/api/admin/activity-task-types/route");
  const taskTypesIdRoute = await import("@/app/api/admin/activity-task-types/[id]/route");

  const rolesRoute = await import("@/app/api/admin/roles/route");
  const rolePermRoute = await import("@/app/api/admin/roles/[id]/permissions/[permId]/route");

  const publicReqTypesRoute = await import("@/app/api/project-request-types/route");
  const publicExpTypesRoute = await import("@/app/api/project-expense-types/route");
  const publicTaskTypesRoute = await import("@/app/api/activity-task-types/route");

  function mkReq(url: string, body?: unknown, method = "POST"): any {
    return new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function isRedirected(fn: () => Promise<any>): Promise<string | undefined> {
    try {
      await fn();
      return undefined;
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return err.digest.split(";")[2] ?? "";
      }
      throw err;
    }
  }

  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const reqTypeIds: string[] = [];
  const expTypeIds: string[] = [];
  const taskTypeIds: string[] = [];
  const projectIds: string[] = [];
  const projectRequestIds: string[] = [];
  const activityIds: string[] = [];

  try {
    // ══════════════ Permission registration ══════════════
    console.log("\n=== 1-3. Permission registration ===\n");
    const reqTypePerm = await prisma.permission.findUnique({ where: { key: "projectRequestType.manage" } });
    const expTypePerm = await prisma.permission.findUnique({ where: { key: "projectExpenseType.manage" } });
    check("1. projectRequestType.manage exists", !!reqTypePerm);
    check("2. projectExpenseType.manage exists", !!expTypePerm);
    const taskTypePermCount = await prisma.permission.count({ where: { key: "taskType.manage" } });
    check("3. taskType.manage still exists exactly once", taskTypePermCount === 1);

    // ══════════════ Fixtures ══════════════
    const adminUser = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN, isActive: true }, select: { id: true } });

    const roleReqOnly = await prisma.customRole.create({
      data: { key: `REQTYPE_ONLY_${RUN_ID}`, name: `ReqType Only ${RUN_ID}`, scope: RoleScope.GLOBAL, isBuiltIn: false },
    });
    const roleExpAndTask = await prisma.customRole.create({
      data: { key: `EXP_TASK_${RUN_ID}`, name: `Expense+Task ${RUN_ID}`, scope: RoleScope.GLOBAL, isBuiltIn: false },
    });
    const roleTaskOnly = await prisma.customRole.create({
      data: { key: `TASK_ONLY_${RUN_ID}`, name: `Task Only ${RUN_ID}`, scope: RoleScope.GLOBAL, isBuiltIn: false },
    });
    const roleDeptScoped = await prisma.customRole.create({
      data: { key: `DEPT_SCOPED_${RUN_ID}`, name: `Dept Scoped ${RUN_ID}`, scope: RoleScope.DEPARTMENT, isBuiltIn: false },
    });
    customRoleIds.push(roleReqOnly.id, roleExpAndTask.id, roleTaskOnly.id, roleDeptScoped.id);
    customRoleKeys.push(roleReqOnly.key, roleExpAndTask.key, roleTaskOnly.key, roleDeptScoped.key);

    const userReqOnly = await prisma.user.create({ data: { email: `refdata-reqonly-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: roleReqOnly.id, authProvider: AuthProvider.CREDENTIALS } });
    const userExpAndTask = await prisma.user.create({ data: { email: `refdata-expandtask-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: roleExpAndTask.id, authProvider: AuthProvider.CREDENTIALS } });
    const userTaskOnly = await prisma.user.create({ data: { email: `refdata-taskonly-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: roleTaskOnly.id, authProvider: AuthProvider.CREDENTIALS } });
    const userNone = await prisma.user.create({ data: { email: `refdata-none-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(userReqOnly.id, userExpAndTask.id, userTaskOnly.id, userNone.id);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };

    // ══════════════ 5-7. Role administration integration ══════════════
    console.log("\n=== 5-7. Role administration integration ===\n");
    const rolesListRes: Response = await rolesRoute.GET(mkReq("http://localhost/api/admin/roles", undefined, "GET"));
    const rolesListBody = await rolesListRes.json();
    const seededReqTypePerm = (rolesListBody.permissions as any[]).find((p) => p.key === "projectRequestType.manage");
    const seededExpTypePerm = (rolesListBody.permissions as any[]).find((p) => p.key === "projectExpenseType.manage");
    const seededTaskTypePerm = (rolesListBody.permissions as any[]).find((p) => p.key === "taskType.manage");
    check("5. projectRequestType.manage appears in the Role administration permission list", !!seededReqTypePerm && seededReqTypePerm.module === "admin");
    check("5. projectExpenseType.manage appears in the Role administration permission list", !!seededExpTypePerm && seededExpTypePerm.module === "admin");
    check("5. taskType.manage still appears correctly", !!seededTaskTypePerm && seededTaskTypePerm.module === "admin");

    // 6. Eligible GLOBAL custom role can receive each permission.
    const grantReqType = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleReqOnly.id, permId: seededReqTypePerm.id }) });
    check("6. Granting projectRequestType.manage to a GLOBAL role succeeds", grantReqType.status === 200);
    const grantExpType = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleExpAndTask.id, permId: seededExpTypePerm.id }) });
    check("6. Granting projectExpenseType.manage to a GLOBAL role succeeds", grantExpType.status === 200);
    const grantTaskTypeToExpRole = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleExpAndTask.id, permId: seededTaskTypePerm.id }) });
    check("6. Granting taskType.manage to the same GLOBAL role succeeds (a role can hold more than one)", grantTaskTypeToExpRole.status === 200);
    const grantTaskTypeOnly = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleTaskOnly.id, permId: seededTaskTypePerm.id }) });
    check("6. Granting taskType.manage to roleTaskOnly succeeds", grantTaskTypeOnly.status === 200);

    // 7. Department-scoped custom role cannot receive GLOBAL-only permissions.
    const rejectDeptReqType = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleDeptScoped.id, permId: seededReqTypePerm.id }) });
    const rejectDeptReqTypeBody = await rejectDeptReqType.json();
    check("7. Granting projectRequestType.manage to a DEPARTMENT-scoped role is rejected (400)", rejectDeptReqType.status === 400 && rejectDeptReqTypeBody.code === "invalid_permission_scope");
    const rejectDeptExpType = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleDeptScoped.id, permId: seededExpTypePerm.id }) });
    check("7. Granting projectExpenseType.manage to a DEPARTMENT-scoped role is rejected (400)", rejectDeptExpType.status === 400);
    const rejectDeptTaskType = await rolePermRoute.POST(mkReq("http://localhost/x"), { params: Promise.resolve({ id: roleDeptScoped.id, permId: seededTaskTypePerm.id }) });
    check("7. Granting taskType.manage to a DEPARTMENT-scoped role is rejected (400) — unchanged existing behavior", rejectDeptTaskType.status === 400);
    const deptRolePerms = await prisma.rolePermission.findMany({ where: { roleKey: roleDeptScoped.key } });
    check("...no RolePermission row was actually created for the rejected grants", deptRolePerms.length === 0);

    // ══════════════ Project Request Types ══════════════
    console.log("\n=== 8-16. Project Request Types ===\n");
    currentSession = { user: { id: userReqOnly.id, role: Role.USER, customRoleId: roleReqOnly.id } };

    const reqTypeRedirect = await isRedirected(() => ProjectRequestTypesAdminPage());
    check("8. User with projectRequestType.manage can access the admin page (no redirect)", reqTypeRedirect === undefined);

    const createReqTypeRes: Response = await reqTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData ReqType ${RUN_ID}` }));
    check("9. Can create", createReqTypeRes.status === 201);
    const createdReqType = await createReqTypeRes.json();
    reqTypeIds.push(createdReqType.id);

    const editReqTypeRes: Response = await reqTypesIdRoute.PATCH(mkReq("http://localhost/x", { name: `RefData ReqType ${RUN_ID} Renamed` }, "PATCH"), { params: Promise.resolve({ id: createdReqType.id }) });
    check("10. Can edit", editReqTypeRes.status === 200);

    const deleteReqTypeRes: Response = await reqTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: createdReqType.id }) });
    check("11. Can delete unused type", deleteReqTypeRes.status === 204);
    reqTypeIds.pop();

    // 12. Referenced type remains protected.
    const dept = await prisma.department.create({ data: { name: `RefData Dept ${RUN_ID}`, slug: `refdata-dept-${RUN_ID}` } });
    departmentIds.push(dept.id);
    const referencedReqTypeRes: Response = await reqTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Referenced ReqType ${RUN_ID}` }));
    const referencedReqType = await referencedReqTypeRes.json();
    reqTypeIds.push(referencedReqType.id);
    const projectRequest = await prisma.projectRequest.create({
      data: {
        title: `RefData PR ${RUN_ID}`,
        description: "seed",
        importance: 2,
        projectTypeId: referencedReqType.id,
        teamConcerned: "seed",
        expectedBenefits: "seed",
        requesterId: userNone.id,
        departmentId: dept.id,
      },
    });
    projectRequestIds.push(projectRequest.id);
    const deleteReferencedReqTypeRes: Response = await reqTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: referencedReqType.id }) });
    check("12. Referenced type remains protected (409 item_in_use, not deleted)", deleteReferencedReqTypeRes.status === 409);

    currentSession = { user: { id: userNone.id, role: Role.USER, customRoleId: null } };
    const noPermRedirect = await isRedirected(() => ProjectRequestTypesAdminPage());
    check("13. User without permission cannot access the admin page (redirected)", noPermRedirect === "/dashboard");
    const noPermPostRes: Response = await reqTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Denied ${RUN_ID}` }));
    check("14. Cannot POST (403)", noPermPostRes.status === 403);
    const noPermPatchRes: Response = await reqTypesIdRoute.PATCH(mkReq("http://localhost/x", { name: "x" }, "PATCH"), { params: Promise.resolve({ id: referencedReqType.id }) });
    check("15. Cannot PATCH (403)", noPermPatchRes.status === 403);
    const noPermDeleteRes: Response = await reqTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: referencedReqType.id }) });
    check("16. Cannot DELETE (403)", noPermDeleteRes.status === 403);

    // ══════════════ Project Expense Types ══════════════
    console.log("\n=== 17-23. Project Expense Types ===\n");
    currentSession = { user: { id: userExpAndTask.id, role: Role.USER, customRoleId: roleExpAndTask.id } };

    const expTypeRedirect = await isRedirected(() => ProjectExpenseTypesAdminPage());
    check("17. User with projectExpenseType.manage can access the admin page", expTypeRedirect === undefined);

    const createExpTypeRes: Response = await expTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData ExpType ${RUN_ID}` }));
    check("18. Can create", createExpTypeRes.status === 201);
    const createdExpType = await createExpTypeRes.json();
    expTypeIds.push(createdExpType.id);

    const editExpTypeRes: Response = await expTypesIdRoute.PATCH(mkReq("http://localhost/x", { name: `RefData ExpType ${RUN_ID} Renamed` }, "PATCH"), { params: Promise.resolve({ id: createdExpType.id }) });
    check("19. Can edit", editExpTypeRes.status === 200);

    const deactivateExpTypeRes: Response = await expTypesIdRoute.PATCH(mkReq("http://localhost/x", { isActive: false }, "PATCH"), { params: Promise.resolve({ id: createdExpType.id }) });
    const deactivatedExpType = await deactivateExpTypeRes.json();
    check("20. Can deactivate", deactivateExpTypeRes.status === 200 && deactivatedExpType.isActive === false);
    const reactivateExpTypeRes: Response = await expTypesIdRoute.PATCH(mkReq("http://localhost/x", { isActive: true }, "PATCH"), { params: Promise.resolve({ id: createdExpType.id }) });
    const reactivatedExpType = await reactivateExpTypeRes.json();
    check("20. Can reactivate", reactivateExpTypeRes.status === 200 && reactivatedExpType.isActive === true);

    const deleteExpTypeRes: Response = await expTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: createdExpType.id }) });
    check("21. Can delete unused type", deleteExpTypeRes.status === 204);
    expTypeIds.pop();

    // 22. Referenced type remains protected.
    const referencedExpTypeRes: Response = await expTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Referenced ExpType ${RUN_ID}` }));
    const referencedExpType = await referencedExpTypeRes.json();
    expTypeIds.push(referencedExpType.id);
    const project = await prisma.project.create({ data: { title: `RefData Project ${RUN_ID}`, ownerId: userNone.id, departmentId: dept.id, expenseTypeId: referencedExpType.id } });
    projectIds.push(project.id);
    const deleteReferencedExpTypeRes: Response = await expTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: referencedExpType.id }) });
    check("22. Referenced type remains protected (409 item_in_use, not deleted, Project never orphaned)", deleteReferencedExpTypeRes.status === 409);
    const projectStillHasExpenseType = await prisma.project.findUnique({ where: { id: project.id }, select: { expenseTypeId: true } });
    check("...the Project's own expenseTypeId is untouched", projectStillHasExpenseType?.expenseTypeId === referencedExpType.id);

    currentSession = { user: { id: userNone.id, role: Role.USER, customRoleId: null } };
    const noPermExpPostRes: Response = await expTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Denied ExpType ${RUN_ID}` }));
    check("23. User without permission cannot mutate through direct API (403)", noPermExpPostRes.status === 403);

    // ══════════════ Task Types ══════════════
    console.log("\n=== 24-30. Task Types (taskType.manage, pre-existing — regression guard) ===\n");
    currentSession = { user: { id: userExpAndTask.id, role: Role.USER, customRoleId: roleExpAndTask.id } };

    const taskTypeRedirect = await isRedirected(() => ActivityTaskTypesAdminPage());
    check("24. User with taskType.manage can access the admin page", taskTypeRedirect === undefined);

    const createTaskTypeRes: Response = await taskTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData TaskType ${RUN_ID}`, cost: 100 }));
    check("25. Can create", createTaskTypeRes.status === 201);
    const createdTaskType = await createTaskTypeRes.json();
    taskTypeIds.push(createdTaskType.id);

    const editTaskTypeRes: Response = await taskTypesIdRoute.PATCH(mkReq("http://localhost/x", { name: `RefData TaskType ${RUN_ID} Renamed`, cost: 250 }, "PATCH"), { params: Promise.resolve({ id: createdTaskType.id }) });
    const editedTaskType = await editTaskTypeRes.json();
    check("26. Can edit name/cost", editTaskTypeRes.status === 200 && editedTaskType.cost === 250);

    const deactivateTaskTypeRes: Response = await taskTypesIdRoute.PATCH(mkReq("http://localhost/x", { isActive: false }, "PATCH"), { params: Promise.resolve({ id: createdTaskType.id }) });
    const deactivatedTaskType = await deactivateTaskTypeRes.json();
    check("27. Can deactivate", deactivateTaskTypeRes.status === 200 && deactivatedTaskType.isActive === false);

    const deleteTaskTypeRes: Response = await taskTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: createdTaskType.id }) });
    check("28. Can delete unused Task Type", deleteTaskTypeRes.status === 204);
    taskTypeIds.pop();

    // 29. Referenced Task Type remains protected, and its snapshot behavior is untouched.
    const referencedTaskTypeRes: Response = await taskTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Referenced TaskType ${RUN_ID}`, cost: 500 }));
    const referencedTaskType = await referencedTaskTypeRes.json();
    taskTypeIds.push(referencedTaskType.id);
    const activity = await prisma.projectActivity.create({
      data: { title: `RefData Activity ${RUN_ID}`, projectId: project.id, taskTypeId: referencedTaskType.id, taskTypeCost: 500 },
    });
    activityIds.push(activity.id);
    const deleteReferencedTaskTypeRes: Response = await taskTypesIdRoute.DELETE(mkReq("http://localhost/x", undefined, "DELETE"), { params: Promise.resolve({ id: referencedTaskType.id }) });
    check("29. Referenced Task Type remains protected (409 item_in_use)", deleteReferencedTaskTypeRes.status === 409);

    // Changing the MASTER cost must never touch the Activity's own snapshot — core
    // "Do NOT alter Activity taskTypeCost snapshot behavior" constraint for this task.
    await taskTypesIdRoute.PATCH(mkReq("http://localhost/x", { cost: 999 }, "PATCH"), { params: Promise.resolve({ id: referencedTaskType.id }) });
    const activityAfterMasterCostChange = await prisma.projectActivity.findUnique({ where: { id: activity.id }, select: { taskTypeCost: true } });
    check("...changing the master Task Type cost never touches the Activity's own taskTypeCost snapshot (untouched business logic)", Number(activityAfterMasterCostChange?.taskTypeCost) === 500);

    currentSession = { user: { id: userReqOnly.id, role: Role.USER, customRoleId: roleReqOnly.id } };
    const noPermTaskTypePostRes: Response = await taskTypesRoute.POST(mkReq("http://localhost/x", { name: `RefData Denied TaskType ${RUN_ID}`, cost: 1 }));
    check("30. User without permission (holds only projectRequestType.manage) cannot mutate through direct API (403)", noPermTaskTypePostRes.status === 403);

    // ══════════════ Independence ══════════════
    console.log("\n=== 31-34. Independence between the three permissions ===\n");
    currentSession = { user: { id: userReqOnly.id, role: Role.USER, customRoleId: roleReqOnly.id } };
    const reqOnlyVsExpRes: Response = await expTypesRoute.POST(mkReq("http://localhost/x", { name: `x-${RUN_ID}` }));
    check("31. projectRequestType.manage alone does not grant Expense Type management (403)", reqOnlyVsExpRes.status === 403);
    const reqOnlyVsTaskRes: Response = await taskTypesRoute.POST(mkReq("http://localhost/x", { name: `x-${RUN_ID}`, cost: 1 }));
    check("32. projectRequestType.manage alone does not grant Task Type management (403)", reqOnlyVsTaskRes.status === 403);

    currentSession = { user: { id: userExpAndTask.id, role: Role.USER, customRoleId: roleExpAndTask.id } };
    const expVsReqRes: Response = await reqTypesRoute.POST(mkReq("http://localhost/x", { name: `x-${RUN_ID}` }));
    check("33. projectExpenseType.manage does not grant Request Type management (403)", expVsReqRes.status === 403);

    currentSession = { user: { id: userTaskOnly.id, role: Role.USER, customRoleId: roleTaskOnly.id } };
    const taskOnlyVsReqRes: Response = await reqTypesRoute.POST(mkReq("http://localhost/x", { name: `x-${RUN_ID}` }));
    const taskOnlyVsExpRes: Response = await expTypesRoute.POST(mkReq("http://localhost/x", { name: `x-${RUN_ID}` }));
    check("34. taskType.manage alone does not grant Request Type management (403)", taskOnlyVsReqRes.status === 403);
    check("34. taskType.manage alone does not grant Expense Type management (403)", taskOnlyVsExpRes.status === 403);
    const taskOnlyCanManageTaskTypes = await isRedirected(() => ActivityTaskTypesAdminPage());
    check("...but roleTaskOnly CAN still access Task Types itself (the permission genuinely works for its own resource)", taskOnlyCanManageTaskTypes === undefined);

    // ══════════════ Regression ══════════════
    console.log("\n=== 35-39. Regression ===\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const adminReqTypeRedirect = await isRedirected(() => ProjectRequestTypesAdminPage());
    const adminExpTypeRedirect = await isRedirected(() => ProjectExpenseTypesAdminPage());
    const adminTaskTypeRedirect = await isRedirected(() => ActivityTaskTypesAdminPage());
    check("35. ADMIN (no customRoleId, bypasses hasPermission unconditionally) still reaches all three admin pages", adminReqTypeRedirect === undefined && adminExpTypeRedirect === undefined && adminTaskTypeRedirect === undefined);

    const rolesListAfterRes: Response = await rolesRoute.GET(mkReq("http://localhost/api/admin/roles", undefined, "GET"));
    const rolesListAfterBody = await rolesListAfterRes.json();
    check("36. Existing custom-role permission editor's GET /api/admin/roles remains functional (same response shape)", Array.isArray(rolesListAfterBody.roles) && Array.isArray(rolesListAfterBody.permissions) && Array.isArray(rolesListAfterBody.rolePermissions));

    currentSession = { user: { id: userNone.id, role: Role.USER, customRoleId: null } };
    const publicReqTypesRes: Response = await publicReqTypesRoute.GET();
    check("37. Project Request flow unchanged — the public (active-only) Project Request Types list still works for any authenticated user, no new gate", publicReqTypesRes.status === 200);
    const publicExpTypesRes: Response = await publicExpTypesRoute.GET();
    check("38. Expense Type usage in Projects unchanged — the public (active-only) Project Expense Types list still works for any authenticated user", publicExpTypesRes.status === 200);
    const publicTaskTypesRes: Response = await publicTaskTypesRoute.GET();
    const publicTaskTypesBody = await publicTaskTypesRes.json();
    check("39. Task Type cost/snapshot behavior unchanged — the public Task Types list still works and still includes cost", publicTaskTypesRes.status === 200 && publicTaskTypesBody.every((t: any) => typeof t.cost === "number"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { id: { in: expTypeIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: reqTypeIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
