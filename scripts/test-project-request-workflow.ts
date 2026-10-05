/**
 * Full workflow regression for the Project Request Form feature —
 * submission, server-side department resolution, the single
 * department-scoped approval stage, authorization/visibility,
 * notifications, Project Type dropdown sourcing, and confirmation that
 * nothing about the real Project model/permissions was touched.
 *
 * ANY authenticated user may submit a request for their own department —
 * there is no manager/org-chart dependency anywhere in this flow. A
 * request is decided by ANYONE holding effective projectRequest.approve
 * for that request's own department (global grant -> every department;
 * department-scoped grant -> that department only) — never tied to the
 * requester's own manager.
 *
 * Drives the REAL route handlers (POST /api/project-requests, POST
 * .../approval, the admin Project Request Type CRUD routes) and the REAL
 * detail/list Server Component pages against a real database, with a
 * mocked @/lib/auth session — same established pattern as
 * scripts/test-category-create-delete-permission-behavior.ts.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-workflow.ts
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
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const RUN_ID = Date.now();

async function main() {
  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping.");
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
  const { Role, RoleScope, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { hasPermission } = await import("@/lib/permissions");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const typesGET = (await import("@/app/api/admin/project-request-types/route")).GET;
  const typesPOST = (await import("@/app/api/admin/project-request-types/route")).POST;
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { default: ProjectRequestsListPage } = await import("@/app/(main)/project-requests/page");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const notificationIds: string[] = [];

  const jsonReq = (method: string, body?: unknown) =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string, opts: { isActive?: boolean } = {}) {
    const u = await prisma.user.create({
      data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: opts.isActive ?? true },
    });
    userIds.push(u.id);
    return u;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    const m = await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    return m;
  }
  async function makeApproverRole(tag: string, scope: "GLOBAL" | "DEPARTMENT") {
    const r = await prisma.customRole.create({ data: { key: `PR_WF_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    return r;
  }
  /**
   * Clears the mandatory intermediate stage (as whichever user holds
   * projectRequest.intermediateApprove was selected for this request — this
   * file always selects `admin`, who holds it by default, see
   * prisma/seed.ts's NEW_PERMISSION_DEFAULT_GRANTS) so the request lands at
   * PENDING_APPROVAL — the pre-existing starting point every test below was
   * originally written against, before this stage existed. Restores
   * `sessionAfter` once done; this file is about the FINAL stage, so the
   * intermediate stage is only ever cleared here as fixture setup.
   */
  async function clearIntermediate(
    requestId: string,
    approverUser: { id: string; role: any; customRoleId: string | null },
    sessionAfter: { id: string; role: any; customRoleId: string | null }
  ) {
    currentSession = { user: approverUser };
    const res = await intermediateApprovalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Intermediate approval clear for test setup." }), { params: Promise.resolve({ id: requestId }) });
    if (res.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${res.status}`);
    currentSession = { user: sessionAfter };
  }

  try {
    const deptA = await createDepartment({ name: `PR Workflow A ${RUN_ID}`, slug: `pr-workflow-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PR Workflow B ${RUN_ID}`, slug: `pr-workflow-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({ data: { email: `pr-wf-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);

    const requester = await makeUser(`pr-wf-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, deptA.id);

    // Approvers, set up BEFORE any submission so the submission-notification
    // fan-out test below has real eligible approvers to check against.
    const globalApprover = await makeApproverRole("GLOBAL", "GLOBAL");
    const globalApproverUser = await makeUser(`pr-wf-globalapprover-${RUN_ID}@kinsen.gr`);
    await addMembership(globalApproverUser.id, deptA.id, globalApprover.id);

    const deptAScopedApprover = await makeApproverRole("DEPTA", "DEPARTMENT");
    const deptAScopedUser = await makeUser(`pr-wf-deptascoped-${RUN_ID}@kinsen.gr`);
    await addMembership(deptAScopedUser.id, deptA.id, deptAScopedApprover.id);

    const deptBScopedApprover = await makeApproverRole("DEPTB", "DEPARTMENT");
    const deptBScopedUser = await makeUser(`pr-wf-deptbscoped-${RUN_ID}@kinsen.gr`);
    await addMembership(deptBScopedUser.id, deptB.id, deptBScopedApprover.id);

    // ══════════════ Project Type dropdown uses DB-backed active options ══════════════
    console.log("\n=== 1. Project Type dropdown sources ONLY DB-backed, ACTIVE options ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const typeActiveRes = await typesPOST(jsonReq("POST", { name: `Active Type ${RUN_ID}` }));
    check("Admin creates an active Project Request Type -> 201", typeActiveRes.status === 201);
    const typeActive = await typeActiveRes.json();
    typeIds.push(typeActive.id);
    const typeInactiveRes = await typesPOST(jsonReq("POST", { name: `Inactive Type ${RUN_ID}`, isActive: false }));
    const typeInactive = await typeInactiveRes.json();
    typeIds.push(typeInactive.id);

    const activeTypesRes = await (await import("@/app/api/project-request-types/route")).GET();
    const activeTypesBody = await activeTypesRes.json();
    check("The form's active-types endpoint includes the active type", activeTypesBody.some((t: any) => t.id === typeActive.id));
    check("...and EXCLUDES the inactive one", !activeTypesBody.some((t: any) => t.id === typeInactive.id));

    const adminTypesListRes = await typesGET();
    const adminTypesList = await adminTypesListRes.json();
    check("The admin management endpoint (admin.access-gated) shows BOTH active and inactive", adminTypesList.some((t: any) => t.id === typeActive.id) && adminTypesList.some((t: any) => t.id === typeInactive.id));

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const nonAdminTypesRes = await typesGET();
    check("A non-admin.access user gets 403 from the admin management endpoint", nonAdminTypesRes.status === 403);

    // ══════════════ 2. Submission from a single-department user ══════════════
    console.log("\n=== 2. Submission from a user with exactly ONE active department — ANY user may submit, no manager needed ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const basePayload = {
      title: `PR Workflow Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 2,
      projectTypeId: typeActive.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Faster delivery of important features to customers.",
      replacesExisting: false,
      // Every fixture in this file selects `admin` as its single
      // intermediate approver — this file is about the pre-existing FINAL
      // stage, so the intermediate stage is only ever cleared as setup (see
      // clearIntermediate), never itself under test here.
      intermediateApproverIds: [admin.id],
    };
    const submitRes = await requestsPOST(jsonReq("POST", basePayload));
    check("Single-department user: POST /api/project-requests -> 201", submitRes.status === 201);
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);

    const created = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    check("departmentId was auto-selected server-side (the user's only membership)", created.departmentId === deptA.id);
    check("Status starts at PENDING_INTERMEDIATE_APPROVAL (the mandatory intermediate stage)", created.status === "PENDING_INTERMEDIATE_APPROVAL");
    check("requesterId is the authenticated caller, never client-supplied", created.requesterId === requester.id);
    check("businessAssessment (final-approver-side) is null at submission — the requester never fills it", created.businessAssessment === null);
    check("legacyRequesterBusinessAssessment is null for a brand-new request — never populated by anything but the old pre-redesign rows", created.legacyRequesterBusinessAssessment === null);

    console.log("\n-- Submission notifies ONLY the selected intermediate approver, never the final stage's eligible approvers yet --\n");
    const adminIntermediateNotif = await prisma.notification.findFirst({ where: { userId: admin.id, link: `/project-requests/${submitted.id}` } });
    check("The selected intermediate approver (admin) received an in-app notification for this request", adminIntermediateNotif !== null);
    if (adminIntermediateNotif) notificationIds.push(adminIntermediateNotif.id);
    const globalApproverNotifBeforeIntermediate = await prisma.notification.findFirst({ where: { userId: globalApproverUser.id, link: `/project-requests/${submitted.id}` } });
    check("...the FINAL stage's global approver received NOTHING yet — no misleading 'ready for final approval' notification before intermediate approval", globalApproverNotifBeforeIntermediate === null);
    check("Notification body does NOT leak the Description text", !adminIntermediateNotif?.body.includes(basePayload.description));

    console.log("\n-- Clearing the intermediate stage advances status AND fans out to EVERY eligible FINAL approver for the request's department --\n");
    await clearIntermediate(submitted.id, { id: admin.id, role: Role.ADMIN, customRoleId: null }, { id: requester.id, role: Role.USER, customRoleId: null });
    const afterIntermediate = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    check("Status advances to PENDING_APPROVAL once the (sole) intermediate approver approves", afterIntermediate.status === "PENDING_APPROVAL");

    const globalApproverNotif = await prisma.notification.findFirst({ where: { userId: globalApproverUser.id, link: `/project-requests/${submitted.id}` } });
    check("NOW the global approver received an in-app notification for this Dept-A request", globalApproverNotif !== null);
    if (globalApproverNotif) notificationIds.push(globalApproverNotif.id);
    const deptAApproverNotif = await prisma.notification.findFirst({ where: { userId: deptAScopedUser.id, link: `/project-requests/${submitted.id}` } });
    check("The Dept-A-scoped approver received an in-app notification for this Dept-A request", deptAApproverNotif !== null);
    if (deptAApproverNotif) notificationIds.push(deptAApproverNotif.id);
    const deptBApproverNotif = await prisma.notification.findFirst({ where: { userId: deptBScopedUser.id, link: `/project-requests/${submitted.id}` } });
    check("The Dept-B-scoped approver (out of scope) received NO notification for this Dept-A request", deptBApproverNotif === null);
    check("Notification body does NOT leak the Description text", !globalApproverNotif?.body.includes(basePayload.description));

    // ══════════════ 3. Multi-department requester + forged department rejection ══════════════
    console.log("\n=== 3. Multi-department requester: explicit choice required; a forged departmentId is rejected ===\n");
    const multiRequester = await makeUser(`pr-wf-multi-${RUN_ID}@kinsen.gr`);
    await addMembership(multiRequester.id, deptA.id);
    await addMembership(multiRequester.id, deptB.id);
    currentSession = { user: { id: multiRequester.id, role: Role.USER, customRoleId: null } };

    const noDeptRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Multi No Dept ${RUN_ID}` }));
    check("Multi-department requester with NO departmentId -> rejected (ambiguous, not auto-guessed)", noDeptRes.status === 400);

    const otherDept = await createDepartment({ name: `PR Workflow Forged ${RUN_ID}`, slug: `pr-workflow-forged-${RUN_ID}` });
    deptIds.push(otherDept.id);
    const forgedRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Forged Dept ${RUN_ID}`, departmentId: otherDept.id }));
    check("Forged departmentId for a department the requester does NOT belong to -> rejected", forgedRes.status === 400);
    check("...zero ProjectRequest rows were created by the forged attempt", (await prisma.projectRequest.count({ where: { title: `PR Forged Dept ${RUN_ID}` } })) === 0);

    const validMultiRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Multi Valid ${RUN_ID}`, departmentId: deptB.id }));
    check("An explicit, REAL membership match (deptB) -> 201", validMultiRes.status === 201);
    const validMulti = await validMultiRes.json();
    requestIds.push(validMulti.id);
    const validMultiRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: validMulti.id } });
    check("Server-side re-verification stored the EXACT department the requester actually chose and belongs to", validMultiRow.departmentId === deptB.id);
    await clearIntermediate(validMulti.id, { id: admin.id, role: Role.ADMIN, customRoleId: null }, { id: multiRequester.id, role: Role.USER, customRoleId: null });

    console.log("\n-- Inactive Project Type cannot be used, even with a forged request --\n");
    const inactiveTypeRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Inactive Type ${RUN_ID}`, projectTypeId: typeInactive.id }));
    check("Forged projectTypeId pointing at an INACTIVE type -> rejected", inactiveTypeRes.status === 400);
    const forgedTypeRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Forged Type ${RUN_ID}`, projectTypeId: "not-a-real-id" }));
    check("Forged projectTypeId pointing at a NONEXISTENT type -> rejected", forgedTypeRes.status === 400);

    // ══════════════ 4. Approval authorization — global, department-scoped, out-of-scope ══════════════
    console.log("\n=== 4. Out-of-scope department approver is rejected ===\n");
    currentSession = { user: { id: deptBScopedUser.id, role: Role.USER, customRoleId: null } };
    const wrongDeptApproveRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: admin.id }), { params: Promise.resolve({ id: submitted.id }) });
    check("A Dept-B-scoped approver is OUT of scope for a Dept-A request -> 403", wrongDeptApproveRes.status === 403);
    check("...status genuinely unchanged", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } })).status === "PENDING_APPROVAL");
    check("...and the rejected call's businessAssessment was never persisted", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } })).businessAssessment === null);

    console.log("\n=== 5. Global approver approves a request from ANY department ===\n");
    currentSession = { user: { id: globalApproverUser.id, role: Role.USER, customRoleId: null } };
    const globalApproveRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "  Approved centrally — positive ROI.  ", projectOwnerId: admin.id }), { params: Promise.resolve({ id: submitted.id }) });
    check("Global projectRequest.approve holder approves a Dept A request -> 200", globalApproveRes.status === 200);
    const afterGlobalApprove = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } });
    check("Status -> APPROVED", afterGlobalApprove.status === "APPROVED");
    check("Audit: approvedAt + approverId recorded", afterGlobalApprove.approvedAt !== null && afterGlobalApprove.approverId === globalApproverUser.id);
    check("Audit: businessAssessment stored TRIMMED", afterGlobalApprove.businessAssessment === "Approved centrally — positive ROI.");

    console.log("\n-- A decided request is terminal — a second decision attempt -> 409, not a silent success --\n");
    const doubleDecideRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Second attempt", projectOwnerId: admin.id }), { params: Promise.resolve({ id: submitted.id }) });
    check("Approving an already-APPROVED request AGAIN -> 409", doubleDecideRes.status === 409);
    check("...the first decision's businessAssessment is untouched by the rejected second attempt", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: submitted.id } })).businessAssessment === "Approved centrally — positive ROI.");

    console.log("\n=== 6. Department-scoped approver: only within their own department ===\n");
    currentSession = { user: { id: deptAScopedUser.id, role: Role.USER, customRoleId: null } };
    const wrongScopeForMultiRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: admin.id }), { params: Promise.resolve({ id: validMulti.id }) });
    check("A Dept-A-scoped approver is OUT of scope for a Dept-B request -> 403", wrongScopeForMultiRes.status === 403);

    currentSession = { user: { id: deptBScopedUser.id, role: Role.USER, customRoleId: null } };
    const rightDeptApproveRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Dept B approval rationale.", projectOwnerId: admin.id }), { params: Promise.resolve({ id: validMulti.id }) });
    check("A Dept-B-scoped approver CAN approve a Dept-B request -> 200", rightDeptApproveRes.status === 200);

    console.log("\n-- Notification only after successful commit; requester notified on the decision --\n");
    const finalNotif = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/project-requests/${submitted.id}` }, orderBy: { createdAt: "desc" } });
    check("Requester received a notification for the approval decision", finalNotif !== null && /approved/i.test(finalNotif.title));
    if (finalNotif) notificationIds.push(finalNotif.id);
    check("...notification body does not leak Business Assessment text", !finalNotif?.body.includes("Approved centrally"));

    // ══════════════ 7. Rejection ══════════════
    console.log("\n=== 7. Rejection by a department-scoped approver ===\n");
    const rejectRequester = await makeUser(`pr-wf-rejrequester-${RUN_ID}@kinsen.gr`);
    await addMembership(rejectRequester.id, deptA.id);
    currentSession = { user: { id: rejectRequester.id, role: Role.USER, customRoleId: null } };
    const rejectSubmitRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR To Reject ${RUN_ID}` }));
    const rejectSubmit = await rejectSubmitRes.json();
    requestIds.push(rejectSubmit.id);
    await clearIntermediate(rejectSubmit.id, { id: admin.id, role: Role.ADMIN, customRoleId: null }, { id: rejectRequester.id, role: Role.USER, customRoleId: null });

    currentSession = { user: { id: deptAScopedUser.id, role: Role.USER, customRoleId: null } };
    const rejectRes = await approvalPOST(jsonReq("POST", { decision: "reject", businessAssessment: "  Not needed at this time.  " }), { params: Promise.resolve({ id: rejectSubmit.id }) });
    check("Dept-A-scoped approver rejects -> 200", rejectRes.status === 200);
    const afterReject = await prisma.projectRequest.findUniqueOrThrow({ where: { id: rejectSubmit.id } });
    check("Status -> REJECTED", afterReject.status === "REJECTED");
    check("Audit: rejectedAt + approverId set", afterReject.rejectedAt !== null && afterReject.approverId === deptAScopedUser.id);
    check("Audit: businessAssessment stored TRIMMED", afterReject.businessAssessment === "Not needed at this time.");
    check("A REJECTED request is terminal — a second decision attempt on it -> 409", (await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Too late", projectOwnerId: admin.id }), { params: Promise.resolve({ id: rejectSubmit.id }) })).status === 409);
    check("...the terminal request's businessAssessment is untouched by the rejected second attempt", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: rejectSubmit.id } })).businessAssessment === "Not needed at this time.");

    console.log("\n-- Failed/forbidden action creates NO notification --\n");
    const notifCountBeforeFailed = await prisma.notification.count({ where: { userId: rejectRequester.id } });
    await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Too late", projectOwnerId: admin.id }), { params: Promise.resolve({ id: rejectSubmit.id }) }); // already REJECTED -> 409
    const notifCountAfterFailed = await prisma.notification.count({ where: { userId: rejectRequester.id } });
    check("A rejected-again attempt (409) creates no additional notification", notifCountBeforeFailed === notifCountAfterFailed);

    // ══════════════ 8. Custom Role with the new permission works ══════════════
    console.log("\n=== 8. A Custom Role granted projectRequest.approve genuinely works (already proven above) ===\n");
    check("Custom Role (GLOBAL scope) successfully performed a real approval above", afterGlobalApprove.status === "APPROVED");
    check("Custom Role (DEPARTMENT scope) successfully performed a real approval above", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: validMulti.id } })).status === "APPROVED");

    // ══════════════ 9. No permission -> 403 on direct API ══════════════
    console.log("\n=== 9. A user with NO projectRequest.approve gets 403 on the API ===\n");
    const noPermUser = await makeUser(`pr-wf-noperm-${RUN_ID}@kinsen.gr`);
    await addMembership(noPermUser.id, deptA.id);
    const anotherRequester = await makeUser(`pr-wf-anotherrequester-${RUN_ID}@kinsen.gr`);
    await addMembership(anotherRequester.id, deptA.id);
    currentSession = { user: { id: anotherRequester.id, role: Role.USER, customRoleId: null } };
    const anotherSubmitRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR No Perm Check ${RUN_ID}` }));
    const anotherSubmit = await anotherSubmitRes.json();
    requestIds.push(anotherSubmit.id);
    await clearIntermediate(anotherSubmit.id, { id: admin.id, role: Role.ADMIN, customRoleId: null }, { id: anotherRequester.id, role: Role.USER, customRoleId: null });

    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: null } };
    const noPermApiRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: admin.id }), { params: Promise.resolve({ id: anotherSubmit.id }) });
    check("Direct API call from a user with no projectRequest.approve -> 403", noPermApiRes.status === 403);

    // ══════════════ 10. Double-click / concurrent approval never creates a second transition ══════════════
    console.log("\n=== 10. Concurrent/double-click approval never produces a second transition ===\n");
    const raceRequester = await makeUser(`pr-wf-racerequester-${RUN_ID}@kinsen.gr`);
    await addMembership(raceRequester.id, deptA.id);
    currentSession = { user: { id: raceRequester.id, role: Role.USER, customRoleId: null } };
    const raceSubmitRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Race ${RUN_ID}` }));
    const raceSubmit = await raceSubmitRes.json();
    requestIds.push(raceSubmit.id);
    await clearIntermediate(raceSubmit.id, { id: admin.id, role: Role.ADMIN, customRoleId: null }, { id: raceRequester.id, role: Role.USER, customRoleId: null });

    currentSession = { user: { id: globalApproverUser.id, role: Role.USER, customRoleId: null } };
    const [raceA, raceB] = await Promise.all([
      approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Race call A", projectOwnerId: admin.id }), { params: Promise.resolve({ id: raceSubmit.id }) }),
      approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Race call B", projectOwnerId: admin.id }), { params: Promise.resolve({ id: raceSubmit.id }) }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    check("Exactly ONE of the two concurrent identical calls succeeds (200), the other loses the race (409) — never both 200", raceStatuses[0] === 200 && raceStatuses[1] === 409);
    const raceFinal = await prisma.projectRequest.findUniqueOrThrow({ where: { id: raceSubmit.id } });
    check("Final status is genuinely APPROVED exactly once (not double-transitioned)", raceFinal.status === "APPROVED");
    check("Exactly ONE of the two assessments persisted (the winner's), never both/neither", raceFinal.businessAssessment === "Race call A" || raceFinal.businessAssessment === "Race call B");
    const raceNotifCount = await prisma.notification.count({ where: { userId: raceRequester.id, link: `/project-requests/${raceSubmit.id}` } });
    check("Exactly ONE decision notification was created for the requester, not two", raceNotifCount === 1);
    notificationIds.push(...(await prisma.notification.findMany({ where: { userId: raceRequester.id, link: `/project-requests/${raceSubmit.id}` }, select: { id: true } })).map((n) => n.id));

    // ══════════════ 11. Requester/approver list and detail visibility ══════════════
    console.log("\n=== 11. Visibility: requester and in-scope approvers see what they should; nobody else can via forged URL ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const requesterDetailEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: submitted.id }) });
    check("The requester can view their own request's detail page (no thrown notFound)", requesterDetailEl !== undefined);

    currentSession = { user: { id: globalApproverUser.id, role: Role.USER, customRoleId: null } };
    const approverDetailEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: submitted.id }) });
    check("The (now-consumed) approver can still view the detail page afterward", approverDetailEl !== undefined);

    const strangerUser = await makeUser(`pr-wf-stranger-${RUN_ID}@kinsen.gr`);
    await addMembership(strangerUser.id, deptA.id);
    currentSession = { user: { id: strangerUser.id, role: Role.USER, customRoleId: null } };
    let strangerBlocked = false;
    try {
      await ProjectRequestDetailPage({ params: Promise.resolve({ id: submitted.id }) });
    } catch (err: any) {
      strangerBlocked = /NEXT_HTTP_ERROR_FALLBACK;404/.test(String(err?.digest ?? ""));
    }
    check("An unrelated user (not requester/in-scope approver) hitting a forged URL -> notFound, never the content", strangerBlocked);

    console.log("\n-- List visibility: My Requests / Awaiting My Approval / History are each correctly scoped --\n");
    // The list's Title cell is now an in-page Preview trigger, not a <Link>
    // (see components/project-requests/project-request-table.tsx) — row
    // membership is verified via the real `requests` array prop the server
    // page hands to <ProjectRequestTable>, same established
    // findElementsByProps workaround every other test in this suite uses
    // for a nested, never-actually-invoked client component.
    function findElementsByProps(node: any, predicate: (props: any) => boolean, results: any[] = []): any[] {
      if (node == null || typeof node !== "object") return results;
      if (node.props && predicate(node.props)) results.push(node);
      const children = node.props?.children;
      if (Array.isArray(children)) for (const c of children) findElementsByProps(c, predicate, results);
      else if (children) findElementsByProps(children, predicate, results);
      return results;
    }
    async function getListRowIds(tab: string): Promise<string[]> {
      const el = await ProjectRequestsListPage({ searchParams: Promise.resolve({ tab }) });
      const [tableEl] = findElementsByProps(el, (p) => Array.isArray(p.requests) && "emptyMessage" in p);
      return (tableEl?.props.requests ?? []).map((r: any) => r.id);
    }
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const myRequestsIds = await getListRowIds("mine");
    check("Requester's 'My Requests' tab includes their own submitted request id", myRequestsIds.includes(submitted.id));

    currentSession = { user: { id: deptAScopedUser.id, role: Role.USER, customRoleId: null } };
    const awaitingIds = await getListRowIds("awaiting");
    check("Dept-A-scoped approver's 'Awaiting My Approval' tab includes the still-pending Dept-A request they can decide", awaitingIds.includes(anotherSubmit.id));
    check("...but does NOT include the Dept-B request (out of their scope)", !awaitingIds.includes(validMulti.id));

    currentSession = { user: { id: deptBScopedUser.id, role: Role.USER, customRoleId: null } };
    const historyIds = await getListRowIds("history");
    check("Dept-B-scoped approver's History tab includes the Dept-B request they approved", historyIds.includes(validMulti.id));
    check("...but does NOT include the Dept-A request they have no involvement in", !historyIds.includes(submitted.id));

    // ══════════════ 12. Final approval never creates a Project — that's a separate, later step ══════════════
    // Full dedicated coverage of the request-origin Project setup flow
    // itself (owner validation, idempotency, field mapping, authorization,
    // reject never entering it) lives in
    // scripts/test-project-request-project-creation.ts — this is just
    // confirming decideApproval's OWN boundary using THIS file's own
    // already-approved `submitted` request from section 5 above.
    console.log("\n=== 12. Final APPROVED status does NOT auto-create a Project — that's now a deliberate, separate follow-up step ===\n");
    const noAutoProject = await prisma.project.findUnique({ where: { projectRequestId: submitted.id } });
    check("decideApproval itself creates no Project row for the just-approved request", noAutoProject === null);
    const rejectedProject = await prisma.project.findUnique({ where: { projectRequestId: rejectSubmit.id } });
    check("A REJECTED request never gets a Project either (unchanged)", rejectedProject === null);

    console.log("\n=== 13. project.create and other Project permissions are completely unaffected ===\n");
    check("hasPermission(USER, 'project.create') is unchanged (false by default, same as before this feature)", (await hasPermission(Role.USER, "project.create", null)) === false);
    check("hasPermission(ADMIN, 'project.create') still bypasses (unconditional ADMIN grant, unaffected)", (await hasPermission(Role.ADMIN, "project.create", null)) === true);
    check("The approved request's requester was NEVER required to hold project.create to submit or be approved", (await hasPermission(Role.USER, "project.create", null)) === false && afterGlobalApprove.status === "APPROVED");
  } finally {
    console.log("\nCleaning up test data...\n");
    // Each step runs independently (never one big try/catch around the
    // whole sequence) — a failure partway through must never skip EVERY
    // step after it, which is exactly how earlier runs of this suite left
    // orphaned fixture users/notifications behind in the dev database (see
    // the notification-pollution investigation this pattern was hardened
    // for). Notification cleanup is BY LINK (every request this run
    // created), not just the handful of ids individually tracked above —
    // Notification has no FK/cascade to ProjectRequest, and
    // notifyEligibleApproversOfSubmission fans out to EVERY eligible
    // approver for a department, which always includes any real ADMIN
    // account (global projectRequest.approve) — a row-by-row id list would
    // silently miss that recipient.
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["notifications (explicitly tracked)", () => prisma.notification.deleteMany({ where: { id: { in: notificationIds } } })],
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
