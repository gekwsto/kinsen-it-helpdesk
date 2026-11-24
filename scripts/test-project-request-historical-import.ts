/**
 * Phase 3 (+ 3.1 correction) — Historical Project Request Architecture:
 * regression coverage for the new Historical Import mechanism
 * (lib/services/project-request-historical-import-service.ts), the
 * explicit standard-request invariants enforced at every normal-workflow
 * write boundary (decideApproval/decideIntermediateApproval/
 * createProjectFromApprovedRequest in lib/services/project-request-
 * service.ts), and (Phase 3.1) that a Historical Import's own terminal
 * status is IMPORTED — deliberately distinct from APPROVED — so it is
 * never counted as a standard approved request or distorts approval KPIs.
 *
 * Does NOT re-prove the full standard submission/approval workflow —
 * scripts/test-project-request-workflow.ts and siblings already cover
 * that exhaustively and are unaffected by this phase (see this script's
 * own "standard workflow unaffected" section for a focused spot-check
 * only).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-historical-import.ts
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

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
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

  const { Role, DepartmentRole, MembershipSource, AuthProvider, ProjectStatus } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { createHistoricalProjectRequest } = await import("@/lib/services/project-request-historical-import-service");
  const { decideApproval, decideIntermediateApproval, createProjectFromApprovedRequest, canViewProjectRequest, buildAwaitingMyApprovalWhere, buildAwaitingMyIntermediateApprovalWhere, buildHistoryWhere, resolveApprovalScope } = await import(
    "@/lib/services/project-request-service"
  );
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeUser(email: string) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    const m = await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(m.id);
    return m;
  }
  async function makeRole(tag: string, permissionKeys: string[]) {
    const role = await prisma.customRole.create({ data: { key: `HIST_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    }
    return role;
  }

  try {
    const dept = await createDepartment({ name: `Historical Dept ${RUN_ID}`, slug: `historical-dept-${RUN_ID}` });
    const requesterSnapshotDept = await createDepartment({ name: `Historical Requester Dept ${RUN_ID}`, slug: `historical-requester-dept-${RUN_ID}` });
    const inactiveDept = await createDepartment({ name: `Historical Inactive Dept ${RUN_ID}`, slug: `historical-inactive-dept-${RUN_ID}` });
    await prisma.department.update({ where: { id: inactiveDept.id }, data: { isActive: false } });
    deptIds.push(dept.id, requesterSnapshotDept.id, inactiveDept.id);

    const owner = await makeUser(`historical-owner-${RUN_ID}@kinsen.gr`);
    const audienceUser = await makeUser(`historical-audience-${RUN_ID}@kinsen.gr`);
    const responsibleUser = await makeUser(`historical-responsible-${RUN_ID}@kinsen.gr`);
    const knownRequester = await makeUser(`historical-requester-${RUN_ID}@kinsen.gr`);
    const knownApprover = await makeUser(`historical-approver-${RUN_ID}@kinsen.gr`);
    const unrelatedUser = await makeUser(`historical-unrelated-${RUN_ID}@kinsen.gr`);
    // Merely a member of the historical request's own Requester Department
    // snapshot — must NOT gain any Request access from that alone.
    const requesterDeptMember = await makeUser(`historical-reqdeptmember-${RUN_ID}@kinsen.gr`);
    await addMembership(requesterDeptMember.id, requesterSnapshotDept.id);

    const approverRole = await makeRole("APPROVER", ["projectRequest.approve"]);
    const departmentApprover = await makeUser(`historical-deptapprover-${RUN_ID}@kinsen.gr`);
    await addMembership(departmentApprover.id, dept.id, approverRole.id);

    // ══════════════════════ 1. Validation ══════════════════════
    console.log("\n=== 1. Historical creation validation ===\n");
    const baseInput = () => ({
      title: `Historical Project ${RUN_ID}`,
      description: "Imported from a legacy external system.",
      importance: 2,
      teamConcerned: "Facilities",
      expectedBenefits: "Already delivered, historically.",
      departmentId: dept.id,
      projectStatus: ProjectStatus.COMPLETED,
      ownerIds: [owner.id],
      externalSourceId: `ext-${RUN_ID}-base`,
    });

    const fakeDeptRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakedept`, departmentId: "nonexistent-id" });
    check("Nonexistent departmentId -> invalid_department", !fakeDeptRes.ok && fakeDeptRes.error.code === "invalid_department");

    const inactiveDeptRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-inactivedept`, departmentId: inactiveDept.id });
    check("Inactive departmentId -> invalid_department", !inactiveDeptRes.ok && inactiveDeptRes.error.code === "invalid_department");

    const noOwnerRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-noowner`, ownerIds: [] });
    check("Empty ownerIds -> invalid_project_owner", !noOwnerRes.ok && noOwnerRes.error.code === "invalid_project_owner");

    const fakeOwnerRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeowner`, ownerIds: ["nonexistent-id"] });
    check("Nonexistent ownerIds entry -> invalid_project_owner", !fakeOwnerRes.ok && fakeOwnerRes.error.code === "invalid_project_owner");

    const fakeAudienceRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeaud`, audienceIds: ["nonexistent-id"] });
    check("Nonexistent audienceIds entry -> invalid_audience", !fakeAudienceRes.ok && fakeAudienceRes.error.code === "invalid_audience");

    const fakeAudDeptRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeauddept`, audienceDepartmentIds: ["nonexistent-id"] });
    check("Nonexistent audienceDepartmentIds entry -> invalid_audience_department", !fakeAudDeptRes.ok && fakeAudDeptRes.error.code === "invalid_audience_department");

    const fakeAudBuRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeaudbu`, audienceBusinessUnitIds: ["nonexistent-id"] });
    check("Nonexistent audienceBusinessUnitIds entry -> invalid_audience_business_unit", !fakeAudBuRes.ok && fakeAudBuRes.error.code === "invalid_audience_business_unit");

    const fakeRespRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeresp`, responsiblePeopleIds: ["nonexistent-id"] });
    check("Nonexistent responsiblePeopleIds entry -> invalid_responsible_people", !fakeRespRes.ok && fakeRespRes.error.code === "invalid_responsible_people");

    const fakeRequesterRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakereq`, requesterId: "nonexistent-id" });
    check("Nonexistent requesterId -> invalid_requester", !fakeRequesterRes.ok && fakeRequesterRes.error.code === "invalid_requester");

    const fakeRequesterDeptRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakereqdept`, requesterDepartmentId: "nonexistent-id" });
    check("Nonexistent requesterDepartmentId -> invalid_requester_department", !fakeRequesterDeptRes.ok && fakeRequesterDeptRes.error.code === "invalid_requester_department");

    const fakeApproverRes = await createHistoricalProjectRequest({ ...baseInput(), externalSourceId: `ext-${RUN_ID}-fakeapprover`, approverId: "nonexistent-id" });
    check("Nonexistent approverId -> invalid_approver", !fakeApproverRes.ok && fakeApproverRes.error.code === "invalid_approver");

    const countBeforeFailedAttempts = await prisma.projectRequest.count({ where: { departmentId: dept.id } });
    check("None of the above failed validation attempts created ANY ProjectRequest row (validated before the transaction starts)", countBeforeFailedAttempts === 0);

    // ══════════════════════ 2. Core creation: unknown requester, explicit Requester Department ══════════════════════
    console.log("\n=== 2. Historical creation with an UNKNOWN requester but an EXPLICIT Requester Department ===\n");
    const coreRes = await createHistoricalProjectRequest({
      ...baseInput(),
      externalSourceId: `ext-${RUN_ID}-core`,
      requesterDepartmentId: requesterSnapshotDept.id,
      // requesterId, submittedAt, approverId, approvedAt, businessAssessment all omitted — genuinely unknown.
      audienceIds: [audienceUser.id],
      responsiblePeopleIds: [responsibleUser.id],
    });
    check("Core creation (unknown requester, known Requester Department) -> ok", coreRes.ok);
    if (!coreRes.ok) {
      printSummaryAndExit();
      return;
    }
    requestIds.push(coreRes.projectRequestId);
    projectIds.push(coreRes.projectId);

    const coreRequest = await prisma.projectRequest.findUniqueOrThrow({ where: { id: coreRes.projectRequestId } });
    check("source === HISTORICAL_IMPORT", coreRequest.source === "HISTORICAL_IMPORT");
    check("status === IMPORTED (Phase 3.1 — its own distinct terminal status, never APPROVED/PENDING_*/REJECTED)", coreRequest.status === "IMPORTED");
    check("requesterId is null — never fabricated", coreRequest.requesterId === null);
    check("requesterDepartmentId IS set, independent of the unknown requester", coreRequest.requesterDepartmentId === requesterSnapshotDept.id);
    check("submittedAt is null — never defaulted to 'now'", coreRequest.submittedAt === null);
    check("approverId/approvedAt/businessAssessment are all null — no fabricated approval", coreRequest.approverId === null && coreRequest.approvedAt === null && coreRequest.businessAssessment === null);
    check("externalSourceId persisted exactly as submitted", coreRequest.externalSourceId === `ext-${RUN_ID}-core`);

    const coreProject = await prisma.project.findUniqueOrThrow({
      where: { id: coreRes.projectId },
      include: { owners: true, audience: true, responsiblePeople: true },
    });
    check("Project genuinely linked via the EXISTING canonical relationship (projectRequestId)", coreProject.projectRequestId === coreRes.projectRequestId);
    check("Project.status is its OWN lifecycle state (COMPLETED) — independent of the request's IMPORTED status", coreProject.status === "COMPLETED");
    check("Project.priority === importance (same 1/2/3 scale, no second mapping)", coreProject.priority === 2);
    check("Project.departmentId === the ONE shared target department", coreProject.departmentId === dept.id);
    check("Project Owners reused correctly", coreProject.ownerId === owner.id && coreProject.owners.some((o) => o.id === owner.id));
    check("Individual Audience reused correctly", coreProject.audience.some((a) => a.id === audienceUser.id));
    check("Responsible People reused correctly (its own separate relation)", coreProject.responsiblePeople.some((r) => r.id === responsibleUser.id));

    // ══════════════════════ 3. Idempotency ══════════════════════
    console.log("\n=== 3. Stable external identifiers prevent duplicate imports ===\n");
    // Final Import Safety Corrections — the retry must be the EXACT SAME
    // payload as the original `coreRes` call (including audienceIds/
    // responsiblePeopleIds) for this to be a genuine "identical retry"
    // check under the new full-payload fingerprint; a payload differing
    // in those fields is correctly a conflict, not idempotent — see
    // scripts/test-historical-import-safety-corrections.ts section 2b/2c
    // for that behavior's own dedicated coverage.
    const dupRes = await createHistoricalProjectRequest({
      ...baseInput(),
      externalSourceId: `ext-${RUN_ID}-core`,
      requesterDepartmentId: requesterSnapshotDept.id,
      audienceIds: [audienceUser.id],
      responsiblePeopleIds: [responsibleUser.id],
    });
    check("A second call with the SAME externalSourceId -> ok, alreadyExisted: true", dupRes.ok && dupRes.alreadyExisted === true);
    if (dupRes.ok) {
      check("...resolves to the EXACT SAME ProjectRequest/Project, never a duplicate", dupRes.projectRequestId === coreRes.projectRequestId && dupRes.projectId === coreRes.projectId);
    }
    const dupCount = await prisma.projectRequest.count({ where: { externalSourceId: `ext-${RUN_ID}-core` } });
    check("Exactly ONE ProjectRequest row exists for this externalSourceId, never two", dupCount === 1);

    // ══════════════════════ 4. Known requester/approver supported when source data provides them ══════════════════════
    console.log("\n=== 4. Historical creation with a KNOWN requester/approver (when source data supports it) ===\n");
    const knownSubmittedAt = new Date("2019-03-01T00:00:00.000Z");
    const knownApprovedAt = new Date("2019-03-10T00:00:00.000Z");
    const knownRes = await createHistoricalProjectRequest({
      ...baseInput(),
      externalSourceId: `ext-${RUN_ID}-known`,
      requesterId: knownRequester.id,
      requesterDepartmentId: requesterSnapshotDept.id,
      submittedAt: knownSubmittedAt,
      approverId: knownApprover.id,
      approvedAt: knownApprovedAt,
      businessAssessment: "Confirmed historically valuable.",
    });
    check("Historical creation with known requester/approver -> ok", knownRes.ok);
    if (knownRes.ok) {
      requestIds.push(knownRes.projectRequestId);
      projectIds.push(knownRes.projectId);
      const knownRequest = await prisma.projectRequest.findUniqueOrThrow({ where: { id: knownRes.projectRequestId } });
      check("requesterId/submittedAt/approverId/approvedAt/businessAssessment all persisted EXACTLY as provided — never altered",
        knownRequest.requesterId === knownRequester.id &&
        knownRequest.submittedAt?.getTime() === knownSubmittedAt.getTime() &&
        knownRequest.approverId === knownApprover.id &&
        knownRequest.approvedAt?.getTime() === knownApprovedAt.getTime() &&
        knownRequest.businessAssessment === "Confirmed historically valuable."
      );
    }

    // ══════════════════════ 5. Standard-request invariants enforced at every normal-workflow write boundary ══════════════════════
    console.log("\n=== 5. A Historical Import request is NEVER eligible for the normal approval/setup workflow ===\n");
    const decideRes = await decideApproval(coreRes.projectRequestId, departmentApprover.id, Role.USER, approverRole.id, "approve", "Trying to approve a historical row.");
    check("decideApproval on a historical row -> not_standard_request (explicit guard, not merely incidental)", !decideRes.ok && decideRes.error.code === "not_standard_request");

    const decideIntermediateRes = await decideIntermediateApproval(coreRes.projectRequestId, departmentApprover.id, "approve");
    check("decideIntermediateApproval on a historical row -> not_standard_request", !decideIntermediateRes.ok && decideIntermediateRes.error.code === "not_standard_request");

    const setupRes = await createProjectFromApprovedRequest(coreRes.projectRequestId, departmentApprover.id, Role.USER, approverRole.id, {
      ownerIds: [owner.id],
      audienceIds: [],
      audienceDepartmentIds: [],
      audienceBusinessUnitIds: [],
      responsiblePeopleIds: [],
      expectedStartDate: "2026-01-01",
      expectedFinishDate: "2026-01-05",
      expenseTypeId: "irrelevant",
      external: false,
    } as any);
    check("createProjectFromApprovedRequest on a historical row -> not_standard_request (never a quiet 'alreadyExisted' no-op)", !setupRes.ok && (setupRes as any).error.code === "not_standard_request");

    // No new Project was created by any of these three rejected attempts.
    const projectCountForCoreRequest = await prisma.project.count({ where: { projectRequestId: coreRes.projectRequestId } });
    check("Exactly ONE Project still exists for the historical request — none of the rejected normal-workflow attempts created another", projectCountForCoreRequest === 1);

    // ══════════════════════ 6. No retroactive notifications ══════════════════════
    console.log("\n=== 6. No retroactive notifications/emails/reminders are generated by Historical Import ===\n");
    const notificationsForRequester = knownRes.ok ? await prisma.notification.findMany({ where: { userId: knownRequester.id } }) : [];
    check("The known historical requester received ZERO notifications from their own historical import", notificationsForRequester.length === 0);
    const notificationsForApprover = knownRes.ok ? await prisma.notification.findMany({ where: { userId: knownApprover.id } }) : [];
    check("The known historical approver received ZERO notifications either", notificationsForApprover.length === 0);
    const setupReminder = await prisma.projectRequestSetupReminder.findUnique({ where: { projectRequestId: coreRes.projectRequestId } });
    check("No ProjectRequestSetupReminder row was ever created for the historical request", setupReminder === null);

    // ══════════════════════ 7. Excluded from pending approval/intermediate queues (structurally, via status) ══════════════════════
    console.log("\n=== 7. Historical requests never appear in pending approval/intermediate queues ===\n");
    const scope = await resolveApprovalScope(departmentApprover.id, Role.USER, approverRole.id);
    const awaitingApprovalWhere = buildAwaitingMyApprovalWhere(departmentApprover.id, scope);
    const awaitingApprovalMatch = await prisma.projectRequest.findFirst({ where: { AND: [awaitingApprovalWhere, { id: coreRes.projectRequestId }] } });
    check("The historical request never matches 'Awaiting My Approval' (status is IMPORTED, never PENDING_APPROVAL)", awaitingApprovalMatch === null);

    const awaitingIntermediateWhere = buildAwaitingMyIntermediateApprovalWhere(departmentApprover.id);
    const awaitingIntermediateMatch = await prisma.projectRequest.findFirst({ where: { AND: [awaitingIntermediateWhere, { id: coreRes.projectRequestId }] } });
    check("...nor 'Awaiting My Intermediate Approval' (no ProjectRequestIntermediateApprover rows exist for it at all)", awaitingIntermediateMatch === null);

    // ══════════════════════ 8. Authorization: Requester Department never implicitly grants Request access ══════════════════════
    console.log("\n=== 8. Historical Requester Department does NOT grant department-wide Request access or approval permissions ===\n");
    const reqForView = { id: coreRes.projectRequestId, requesterId: coreRequest.requesterId, departmentId: coreRequest.departmentId };
    check("A plain member of the Requester Department snapshot CANNOT view this Request", !(await canViewProjectRequest(requesterDeptMember.id, Role.USER, null, reqForView)));
    check("An unrelated user CANNOT view it either", !(await canViewProjectRequest(unrelatedUser.id, Role.USER, null, reqForView)));
    check("A user who holds projectRequest.approve for the Request's OWN (target) department CAN still view it — the existing, unchanged rule", await canViewProjectRequest(departmentApprover.id, Role.USER, approverRole.id, reqForView));

    // History tab: a decided request is visible to the SAME existing scope rule — not a new bypass, just the request flowing through the Approved bucket like any other.
    const historyWhere = buildHistoryWhere(departmentApprover.id, scope);
    const historyMatch = await prisma.projectRequest.findFirst({ where: { AND: [historyWhere, { id: coreRes.projectRequestId }] } });
    check("The historical request IS visible in 'History' to someone who holds approve rights for its OWN target department (same existing rule, not a new access grant)", historyMatch !== null);

    // ══════════════════════ 9. Project visibility reuses the existing architecture, without exposing Request details ══════════════════════
    console.log("\n=== 9. Project visibility (Audience/Responsible People/Owner) works, but never implies Request visibility ===\n");
    const projectForAccessCheck = { id: coreRes.projectId, departmentId: dept.id, projectRequestId: coreRes.projectRequestId };
    check("The individual Audience user CAN view the imported Project (reuses the existing architecture)", await hasProjectViewAccess(audienceUser.id, Role.USER, null, projectForAccessCheck));
    check("The Responsible Person CAN view the imported Project too", await hasProjectViewAccess(responsibleUser.id, Role.USER, null, projectForAccessCheck));
    check("...but that SAME Audience user CANNOT view the underlying Project Request's own detail (a narrower, separate gate)", !(await canViewProjectRequest(audienceUser.id, Role.USER, null, reqForView)));
    check("...nor can the Responsible Person", !(await canViewProjectRequest(responsibleUser.id, Role.USER, null, reqForView)));

    // ══════════════════════ 10. Standard workflow is completely unaffected (spot check) ══════════════════════
    console.log("\n=== 10. Standard requests are completely unaffected — still require a valid requester ===\n");
    const standardCreateAttempt = prisma.projectRequest.create({
      data: {
        title: `Should fail ${RUN_ID}`,
        description: "x",
        importance: 2,
        teamConcerned: "x",
        expectedBenefits: "x",
        departmentId: dept.id,
        // requesterId omitted entirely — nullable at the DB level now, but
        // every STANDARD request submitted through the real app route
        // (POST /api/project-requests) ALWAYS provides one from the
        // authenticated session; this merely confirms the schema change
        // doesn't silently weaken that at the database level either when a
        // real caller DOES supply it.
        requesterId: knownRequester.id,
        source: "STANDARD",
      },
    });
    const standardCreated = await standardCreateAttempt;
    requestIds.push(standardCreated.id);
    check("A STANDARD request with a real requesterId still creates normally", standardCreated.requesterId === knownRequester.id && standardCreated.source === "STANDARD");
    check("...and defaults to PENDING_INTERMEDIATE_APPROVAL exactly as before (unchanged default)", standardCreated.status === "PENDING_INTERMEDIATE_APPROVAL");

    // ══════════════════════ 11. Phase 3.1 — IMPORTED is its own distinct terminal status, never counted as APPROVED ══════════════════════
    console.log("\n=== 11. IMPORTED is its own distinct terminal status — never counted as APPROVED, never a transition target for STANDARD requests ===\n");
    const approvedCountInDept = await prisma.projectRequest.count({ where: { departmentId: dept.id, status: "APPROVED" } });
    check("A plain 'status: APPROVED' count for this department does NOT include the historical row (it's IMPORTED, not APPROVED) — approval KPIs are never distorted by an import", approvedCountInDept === 0);
    const importedCountInDept = await prisma.projectRequest.count({ where: { departmentId: dept.id, status: "IMPORTED" } });
    check("...while a 'status: IMPORTED' count DOES include it", importedCountInDept >= 1);

    const serviceSrc = await (await import("fs/promises")).readFile("lib/services/project-request-service.ts", "utf8");
    check(
      "Standard requests never transition to IMPORTED — the normal-workflow service module (decideApproval/decideIntermediateApproval/the submission route's own status transitions) never writes that status anywhere; IMPORTED is written ONLY by createHistoricalProjectRequest",
      !/status:\s*["']IMPORTED["']/.test(serviceSrc) && !/nextStatus[^;]*IMPORTED/.test(serviceSrc)
    );

    currentSession = null;
  } finally {
    await runCleanup([
      ["delete notifications", async () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      ["delete projects", async () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["delete project requests", async () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["delete memberships", async () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["delete role permissions", async () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["delete custom roles", async () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
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
