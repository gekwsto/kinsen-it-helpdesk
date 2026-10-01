/**
 * Regression coverage for the reported bug: `/project-requests/new` showed
 * "You don't belong to any active department" for a System Administrator
 * who DID have a real, currently-selected active workspace.
 *
 * ROOT CAUSE (confirmed by reading, not assumed): resolveDepartmentForRequest
 * (lib/services/project-request-service.ts) and the /project-requests/new
 * page both queried ONLY direct, active DepartmentMembership rows via
 * getUserDepartmentMemberships — a narrower, DIFFERENT rule than the
 * canonical one the workspace selector itself uses
 * (lib/services/workspace-service.ts's listAccessibleWorkspaces/
 * resolveActiveWorkspace), which additionally grants a global-scope role
 * (canViewAllDepartments — ADMIN/DIRECTOR) access to every ACTIVE
 * department regardless of membership rows. An ADMIN with zero direct
 * DepartmentMembership rows (a completely normal, common case — System
 * Admin doesn't need a membership to act) therefore got an empty list from
 * the OLD, narrower check even though their real active workspace (resolved
 * via the SAME canonical function elsewhere in the app) was genuinely valid.
 *
 * THE FIX: resolveDepartmentForRequest now defers entirely to two additions
 * in lib/services/workspace-service.ts — the pre-existing
 * listAccessibleWorkspaces (for listing/auto-select) and the new
 * isAccessibleDepartment (for validating one already-known id) — the EXACT
 * same canonical rule the workspace selector uses, never a second,
 * independently-drifting resolver.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-department-eligibility.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (that silent partial-cleanup is exactly how earlier test runs left orphaned fixture users/Notification rows in the dev database). */
async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let currentCookieValue: string | undefined = undefined;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined) }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ 2. Source-text: no ADMIN role hardcoding ══════════════════════
  console.log("\n=== 2. No hardcoded ADMIN role check in the form or the POST route ===\n");
  const pageSrc = await fs.readFile("app/(main)/project-requests/new/page.tsx", "utf8");
  const routeSrc = await fs.readFile("app/api/project-requests/route.ts", "utf8");
  const serviceSrc = await fs.readFile("lib/services/project-request-service.ts", "utf8");
  check("The 'new' page never checks role === \"ADMIN\" / isAdmin() for department eligibility", !/role\s*===\s*["']ADMIN["']/.test(pageSrc) && !/isAdmin\(/.test(pageSrc));
  check("POST /api/project-requests never checks role === \"ADMIN\" / isAdmin() for department eligibility", !/role\s*===\s*["']ADMIN["']/.test(routeSrc) && !/isAdmin\(/.test(routeSrc));
  check("resolveDepartmentForRequest never checks role === \"ADMIN\" / isAdmin() directly — it defers to canViewAllDepartments via workspace-service", !/role\s*===\s*["']ADMIN["']/.test(serviceSrc) && !/isAdmin\(/.test(serviceSrc));
  check(
    "The page now sources departments from the canonical getActiveWorkspace (workspace-service.ts), not getUserDepartmentMemberships directly",
    /import \{ getActiveWorkspace \} from "@\/lib\/services\/workspace-service"/.test(pageSrc) && !/from "@\/lib\/services\/department-membership-service"/.test(pageSrc)
  );
  check("resolveDepartmentForRequest reuses the canonical workspace-service helpers (listAccessibleWorkspaces/isAccessibleDepartment) — no second/independent resolver", /listAccessibleWorkspaces/.test(serviceSrc) && /isAccessibleDepartment/.test(serviceSrc));
  const workspaceServiceSrc = await fs.readFile("lib/services/workspace-service.ts", "utf8");
  check("isAccessibleDepartment itself reuses canViewAllDepartments — the same rule listAccessibleWorkspaces/resolveActiveWorkspace already apply", /export async function isAccessibleDepartment/.test(workspaceServiceSrc) && /canViewAllDepartments\(role\)/.test(workspaceServiceSrc));

  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping the real-DB portion.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { resolveDepartmentForRequest } = await import("@/lib/services/project-request-service");
  const { listAccessibleWorkspaces, isAccessibleDepartment, ALL_WORKSPACES_VALUE } = await import("@/lib/services/workspace-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const { default: NewProjectRequestPage } = await import("@/app/(main)/project-requests/new/page");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const deptA = await createDepartment({ name: `PR Elig Dept A ${RUN_ID}`, slug: `pr-elig-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PR Elig Dept B ${RUN_ID}`, slug: `pr-elig-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);
    const deptInactive = await createDepartment({ name: `PR Elig Inactive ${RUN_ID}`, slug: `pr-elig-inactive-${RUN_ID}` });
    deptIds.push(deptInactive.id);
    await prisma.department.update({ where: { id: deptInactive.id }, data: { isActive: false } });

    const activeType = await prisma.projectRequestType.create({ data: { name: `PR Elig Type ${RUN_ID}` } });
    typeIds.push(activeType.id);

    const manager = await prisma.user.create({ data: { email: `pr-elig-manager-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(manager.id);
    await prisma.departmentMembership.create({ data: { userId: manager.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });

    // ══════════════════════ 1. The exact reproduction: ADMIN, ZERO direct memberships ══════════════════════
    console.log("\n=== 1. System Administrator with ZERO direct DepartmentMembership rows gets the canonical active-department set ===\n");
    const admin = await prisma.user.create({ data: { email: `pr-elig-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, managerId: manager.id } });
    userIds.push(admin.id);
    check("Fixture: the admin genuinely has zero DepartmentMembership rows", (await prisma.departmentMembership.count({ where: { userId: admin.id } })) === 0);

    const adminAccessible = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { take: 1000 });
    check("listAccessibleWorkspaces(ADMIN) is non-empty despite zero memberships (includes every ACTIVE department)", adminAccessible.length > 0);
    check("...includes deptA and deptB", adminAccessible.some((d) => d.id === deptA.id) && adminAccessible.some((d) => d.id === deptB.id));
    check("8. ...but EXCLUDES the inactive department", !adminAccessible.some((d) => d.id === deptInactive.id));

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieValue = deptA.id;
    const adminPageEl = await NewProjectRequestPage();
    const pageBodyStr = JSON.stringify(adminPageEl, (_k, v) => (typeof v === "function" ? undefined : v));
    check("The page NO LONGER renders the false 'no department' empty-state text for this ADMIN", !/don.t belong to any active department/i.test(pageBodyStr));

    // ══════════════════════ 3/4/5/6. Form wiring: scoped user, auto-select, dropdown, pre-selection ══════════════════════
    console.log("\n=== 3/4. Department-scoped, single-department user: sees only their own department, auto-selected ===\n");
    const singleDeptUser = await prisma.user.create({ data: { email: `pr-elig-single-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, managerId: manager.id } });
    userIds.push(singleDeptUser.id);
    await prisma.departmentMembership.create({ data: { userId: singleDeptUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    const singleAccessible = await listAccessibleWorkspaces(singleDeptUser.id, Role.USER);
    check("Department-scoped USER sees ONLY their own real, active department", singleAccessible.length === 1 && singleAccessible[0].id === deptA.id);
    check("...never deptB (not a member there)", !singleAccessible.some((d) => d.id === deptB.id));

    const singleResolution = await resolveDepartmentForRequest(singleDeptUser.id, Role.USER, undefined);
    check("4. Single accessible department -> auto-selected server-side with no explicit choice", singleResolution.ok && singleResolution.departmentId === deptA.id);

    console.log("\n=== 5/6. Multi-department user: required dropdown; valid active workspace pre-selected ===\n");
    const multiUser = await prisma.user.create({ data: { email: `pr-elig-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, managerId: manager.id } });
    userIds.push(multiUser.id);
    await prisma.departmentMembership.create({ data: { userId: multiUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    await prisma.departmentMembership.create({ data: { userId: multiUser.id, departmentId: deptB.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });

    const multiResolutionNoChoice = await resolveDepartmentForRequest(multiUser.id, Role.USER, undefined);
    check("5. More than one accessible department with no explicit choice -> ambiguous (requires a real dropdown choice, never auto-guessed)", !multiResolutionNoChoice.ok && multiResolutionNoChoice.reason === "ambiguous");

    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptB.id;
    const multiPageEl = await NewProjectRequestPage();
    const { ProjectRequestForm } = await import("@/components/project-requests/project-request-form");
    const [formEl] = findElementsByType(multiPageEl, ProjectRequestForm);
    check("6. The form receives BOTH accessible departments (the real dropdown data)", formEl?.props.departments?.length === 2 && formEl.props.departments.some((d: any) => d.id === deptA.id) && formEl.props.departments.some((d: any) => d.id === deptB.id));
    check("6. ...and defaultDepartmentId is the REAL active workspace (deptB), pre-selecting it without forcing it", formEl?.props.defaultDepartmentId === deptB.id);

    // ══════════════════════ 7. "All Workspaces" is never a real department ══════════════════════
    console.log('\n=== 7. "All Workspaces" is never stored as a departmentId — for the page default, or a client-submitted value ===\n');
    currentCookieValue = ALL_WORKSPACES_VALUE;
    const allSelectedPageEl = await NewProjectRequestPage();
    const [allSelectedFormEl] = findElementsByType(allSelectedPageEl, ProjectRequestForm);
    check('When "All Workspaces" is the active selection, the form gets NO defaultDepartmentId (never the synthetic value itself)', allSelectedFormEl?.props.defaultDepartmentId === undefined);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const allWorkspacesSubmitRes = await requestsPOST(
      jsonReq({
        title: `PR Elig All Workspaces ${RUN_ID}`,
        description: "A description that is definitely long enough.",
        importance: 2,
        projectTypeId: activeType.id,
        teamConcerned: "Ops",
        expectedBenefits: "Benefits text long enough to pass validation.",
        replacesExisting: false,
        departmentId: ALL_WORKSPACES_VALUE,
        intermediateApproverIds: [admin.id],
      })
    );
    check('7. A client explicitly submitting departmentId="ALL" (the synthetic value) is rejected, never stored', allWorkspacesSubmitRes.status === 400);
    check("...zero rows created from it", (await prisma.projectRequest.count({ where: { title: `PR Elig All Workspaces ${RUN_ID}` } })) === 0);

    // ══════════════════════ 8/9. Inactive department + forged out-of-scope department ══════════════════════
    console.log("\n=== 8. Inactive department is rejected server-side even if somehow submitted ===\n");
    check("isAccessibleDepartment(ADMIN, inactive dept) -> false (inactive is never accessible, even for a global-scope role)", (await isAccessibleDepartment(admin.id, Role.ADMIN, deptInactive.id)) === false);
    const inactiveDeptRes = await requestsPOST(
      jsonReq({
        title: `PR Elig Inactive Dept ${RUN_ID}`,
        description: "A description that is definitely long enough.",
        importance: 2,
        projectTypeId: activeType.id,
        teamConcerned: "Ops",
        expectedBenefits: "Benefits text long enough to pass validation.",
        replacesExisting: false,
        departmentId: deptInactive.id,
        intermediateApproverIds: [admin.id],
      })
    );
    check("Forged inactive departmentId -> rejected (400)", inactiveDeptRes.status === 400);
    check("...zero rows created", (await prisma.projectRequest.count({ where: { title: `PR Elig Inactive Dept ${RUN_ID}` } })) === 0);

    console.log("\n=== 9. Forged out-of-scope departmentId is rejected and creates no request or notification ===\n");
    currentSession = { user: { id: singleDeptUser.id, role: Role.USER, customRoleId: null } };
    const notifCountBefore = await prisma.notification.count({ where: { userId: manager.id } });
    const forgedRes = await requestsPOST(
      jsonReq({
        title: `PR Elig Forged ${RUN_ID}`,
        description: "A description that is definitely long enough.",
        importance: 2,
        projectTypeId: activeType.id,
        teamConcerned: "Ops",
        expectedBenefits: "Benefits text long enough to pass validation.",
        replacesExisting: false,
        departmentId: deptB.id, // singleDeptUser is NOT a member of deptB
        intermediateApproverIds: [admin.id],
      })
    );
    check("A single-department user forging deptB (not their own) -> rejected (400)", forgedRes.status === 400);
    check("...zero ProjectRequest rows created", (await prisma.projectRequest.count({ where: { title: `PR Elig Forged ${RUN_ID}` } })) === 0);
    const notifCountAfter = await prisma.notification.count({ where: { userId: manager.id } });
    check("...and NO notification was created either", notifCountBefore === notifCountAfter);

    // ══════════════════════ 10. Genuinely empty accessible set -> the existing empty state ══════════════════════
    console.log("\n=== 10. A user with a genuinely EMPTY accessible-departments set still sees the existing empty state ===\n");
    const noDeptUser = await prisma.user.create({ data: { email: `pr-elig-nodept-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(noDeptUser.id);
    currentSession = { user: { id: noDeptUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = undefined;
    const noDeptPageEl = await NewProjectRequestPage();
    const noDeptBodyStr = JSON.stringify(noDeptPageEl, (_k, v) => (typeof v === "function" ? undefined : v));
    check("A user with a TRULY empty accessible set still sees the 'no department' empty state (never hidden by this fix)", /don.t belong to any active department/i.test(noDeptBodyStr));
    const noDeptResolution = await resolveDepartmentForRequest(noDeptUser.id, Role.USER, undefined);
    check("...and resolveDepartmentForRequest itself reports no_department", !noDeptResolution.ok && noDeptResolution.reason === "no_department");

    // ══════════════════════ 11. Department resolved correctly, no manager needed at all ══════════════════════
    console.log("\n=== 11. User with a valid department but NO manager submits successfully — there is no manager stage at all ===\n");
    const managerlessAdmin = await prisma.user.create({ data: { email: `pr-elig-managerless-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } }); // no managerId
    userIds.push(managerlessAdmin.id);
    currentSession = { user: { id: managerlessAdmin.id, role: Role.ADMIN, customRoleId: null } };
    const managerlessRes = await requestsPOST(
      jsonReq({
        title: `PR Elig Managerless ${RUN_ID}`,
        description: "A description that is definitely long enough.",
        importance: 2,
        projectTypeId: activeType.id,
        teamConcerned: "Ops",
        expectedBenefits: "Benefits text long enough to pass validation.",
        replacesExisting: false,
        departmentId: deptA.id,
        // Self-selected — managerlessAdmin is itself Role.ADMIN, which
        // holds projectRequest.intermediateApprove by default (see
        // prisma/seed.ts's NEW_PERMISSION_DEFAULT_GRANTS), so no extra
        // fixture is needed just to clear this file's own intermediate
        // stage (this file is about department resolution, not the
        // intermediate stage itself).
        intermediateApproverIds: [managerlessAdmin.id],
      })
    );
    check("Department resolves successfully (ADMIN, real active department) AND submission succeeds outright — no manager-related failure of any kind", managerlessRes.status === 201);
    const managerless = await managerlessRes.json();
    requestIds.push(managerless.id);
    const managerlessCreated = await prisma.projectRequest.findUniqueOrThrow({ where: { id: managerless.id } });
    check("...status starts at PENDING_INTERMEDIATE_APPROVAL immediately (the mandatory intermediate stage, no manager dependency)", managerlessCreated.status === "PENDING_INTERMEDIATE_APPROVAL");

    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const clearManagerlessRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Self-cleared for fixture setup." }), { params: Promise.resolve({ id: managerless.id }) });
    check("...managerlessAdmin (self-selected) clears the intermediate stage -> 200", clearManagerlessRes.status === 200);
    const managerlessAfterIntermediate = await prisma.projectRequest.findUniqueOrThrow({ where: { id: managerless.id } });
    check("...status now advances to PENDING_APPROVAL", managerlessAfterIntermediate.status === "PENDING_APPROVAL");

    // ══════════════════════ 12. The single department-scoped approval stage works for this previously-mis-resolved flow ══════════════════════
    console.log("\n=== 12. The single department-scoped approval stage decides the request correctly ===\n");
    const deptAApprover = await prisma.customRole.create({ data: { key: `PR_ELIG_DEPTA_${RUN_ID}`, name: `Dept A Approver ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(deptAApprover.id);
    customRoleKeys.push(deptAApprover.key);
    const approvePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: deptAApprover.key, permissionId: approvePerm.id } });
    const deptAApproverUser = await prisma.user.create({ data: { email: `pr-elig-deptaapprover-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAApproverUser.id);
    await prisma.departmentMembership.create({ data: { userId: deptAApproverUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, customRoleId: deptAApprover.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });

    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    currentSession = { user: { id: deptAApproverUser.id, role: Role.USER, customRoleId: null } };
    const approveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Dept A approval rationale.", projectOwnerId: managerlessAdmin.id }), { params: Promise.resolve({ id: managerless.id }) });
    check("A Dept-A-scoped approver decides the request -> 200 (never tied to the requester's own manager)", approveRes.status === 200);
    const afterApprove = await prisma.projectRequest.findUniqueOrThrow({ where: { id: managerless.id } });
    check("...status transitions straight to APPROVED", afterApprove.status === "APPROVED");
    check("...approverId records the approver, not any manager", afterApprove.approverId === deptAApproverUser.id);
    check("...businessAssessment persisted trimmed", afterApprove.businessAssessment === "Dept A approval rationale.");
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["projects (auto-created from these requests)", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } })],
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["role permissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ]);
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
