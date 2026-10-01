/**
 * Regression coverage for the new "final approval auto-creates a Project"
 * feature — confirmed with the user: once a Project Request's FINAL
 * approval completes, a real Project row is created automatically,
 * pre-filled from the request (title/description/departmentId, priority
 * from importance — same 1/2/3 scale), owned by whoever the approver
 * explicitly chose at decision time (never the requester, never the
 * approver themselves by default) — see decideApproval in
 * lib/services/project-request-service.ts.
 *
 * This file does not re-prove what the retrofitted sibling test files
 * already cover incidentally (the final-stage gate, the intermediate
 * stage's own behavior, cost/replacement-description untouched) — it
 * focuses on the Project-creation feature's OWN behavior: owner validation
 * (department-scoped, fail-closed), field mapping, idempotency/uniqueness,
 * reject never creating one, and that the created row is a REAL,
 * first-class Project (shows up in the normal Projects list/API).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-project-creation.ts
 */
import { mock } from "node:test";
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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (established convention across this whole test suite). */
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
  // ══════════════════════ SECTION A — schema + shared dialog source checks ══════════════════════
  console.log("\n=== SECTION A — projectOwnerId required exactly on approve; dialog shows/hides the owner picker correctly ===\n");
  const { projectRequestApprovalDecisionSchema } = await import("@/lib/validations");
  const dialogSrc = await fs.readFile("components/project-requests/project-request-decision-dialog.tsx", "utf8");

  check(
    "1. decision:'approve' WITHOUT projectOwnerId -> rejected",
    !projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "Looks good." }).success
  );
  check(
    "1. decision:'approve' WITH a real projectOwnerId -> accepted",
    projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: "cmx0000000000000000000001" }).success
  );
  check(
    "1. decision:'reject' NEVER needs a projectOwnerId (no Project is ever created from a rejection)",
    projectRequestApprovalDecisionSchema.safeParse({ decision: "reject", businessAssessment: "Not viable." }).success
  );
  check("2. The dialog only requires an owner when decision==='approve' AND ownerOptions was actually provided", /const needsOwner = decision === "approve" && ownerOptions !== undefined;/.test(dialogSrc));
  check("...and blocks confirm (never calls onConfirm) when an approve needs an owner but none was picked", /if \(needsOwner && !ownerId\) return;/.test(dialogSrc));
  check("...the owner select element only renders when needsOwner is true (never shown for reject or the intermediate stage)", /\{needsOwner && \(/.test(dialogSrc));

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
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const projectsGET = (await import("@/app/api/projects/route")).GET;

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const projectIds: string[] = [];

  const jsonReq = (body?: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string, customRoleId: string | null = null, role: "USER" | "ADMIN" = "USER") {
    const u = await prisma.user.create({ data: { email, role: role as any, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }
  async function makeRole(tag: string, scope: "GLOBAL" | "DEPARTMENT", permissionKeys: string[]) {
    const role = await prisma.customRole.create({ data: { key: `PR_PC_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    }
    return role;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
  }

  try {
    const deptA = await createDepartment({ name: `PR Creation Dept A ${RUN_ID}`, slug: `pr-creation-dept-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PR Creation Dept B ${RUN_ID}`, slug: `pr-creation-dept-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR Creation Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await makeUser(`pr-creation-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, deptA.id);

    // Intermediate approver — self-contained, this file is about the FINAL
    // stage's Project-creation side effect, so intermediate is only ever
    // cleared as fixture setup.
    const intermediateRole = await makeRole("INTERMEDIATE", "GLOBAL", ["projectRequest.intermediateApprove"]);
    const intermediateApprover = await makeUser(`pr-creation-intermediate-${RUN_ID}@kinsen.gr`, intermediateRole.id);

    // Final approver for deptA — holds projectRequest.approve but NOT
    // project.assignable, so they can decide the request but are not
    // themselves automatically a valid Project owner choice.
    const finalApproverRole = await makeRole("FINALAPPROVER", "DEPARTMENT", ["projectRequest.approve"]);
    const finalApprover = await makeUser(`pr-creation-finalapprover-${RUN_ID}@kinsen.gr`);
    await addMembership(finalApprover.id, deptA.id, finalApproverRole.id);

    // A real, deptA-scoped project.assignable holder — the valid owner
    // choice. Also project.view, so section 4's "shows up in GET
    // /api/projects for its owner" check can actually list it (owning a
    // project doesn't itself grant list access — that's project.view,
    // checked completely independently by buildProjectListWhere).
    const ownerRole = await makeRole("OWNER", "DEPARTMENT", ["project.assignable", "project.view"]);
    const ownerUser = await makeUser(`pr-creation-owner-${RUN_ID}@kinsen.gr`);
    await addMembership(ownerUser.id, deptA.id, ownerRole.id);

    // A project.assignable holder, but scoped to deptB only — must be
    // rejected as an owner choice for a deptA request (department-scoped,
    // never global-by-accident).
    const otherDeptOwnerRole = await makeRole("OTHERDEPTOWNER", "DEPARTMENT", ["project.assignable"]);
    const otherDeptOwnerUser = await makeUser(`pr-creation-otherdeptowner-${RUN_ID}@kinsen.gr`);
    await addMembership(otherDeptOwnerUser.id, deptB.id, otherDeptOwnerRole.id);

    // An ADMIN — globally bypasses every permission check, so always a
    // valid owner choice regardless of department membership.
    const adminUser = await makeUser(`pr-creation-admin-${RUN_ID}@kinsen.gr`, null, "ADMIN");

    const basePayload = {
      title: `PR Creation Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 3,
      projectTypeId: type.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
      intermediateApproverIds: [intermediateApprover.id],
    };

    async function submitAndClearIntermediate(title: string) {
      currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
      const res = await requestsPOST(jsonReq({ ...basePayload, title }));
      const body = await res.json();
      requestIds.push(body.id);
      currentSession = { user: { id: intermediateApprover.id, role: Role.USER, customRoleId: intermediateRole.id } };
      const clearRes = await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: body.id }) });
      if (clearRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${clearRes.status}`);
      return body.id as string;
    }

    // ══════════════════════ 3. Owner must be a REAL, department-scoped project.assignable holder — fail closed ══════════════════════
    console.log("\n=== 3. The approver's chosen Project owner is re-verified server-side — fail closed on anything invalid ===\n");
    const ownerCheckRequestId = await submitAndClearIntermediate(`PR Creation OwnerCheck ${RUN_ID}`);

    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const nonexistentOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: "cmx0000000000000000000099" }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3a. A nonexistent projectOwnerId -> 422 invalid_project_owner", nonexistentOwnerRes.status === 422);
    const afterNonexistent = await prisma.projectRequest.findUniqueOrThrow({ where: { id: ownerCheckRequestId } });
    check("...status untouched, still PENDING_APPROVAL (never consumed by the failed attempt — can be retried)", afterNonexistent.status === "PENDING_APPROVAL");

    const wrongDeptOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: otherDeptOwnerUser.id }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3b. A project.assignable holder scoped to a DIFFERENT department -> 422 invalid_project_owner (department-scoped, not global-by-accident)", wrongDeptOwnerRes.status === 422);
    check("...still no Project created from the rejected attempt", (await prisma.project.count({ where: { projectRequestId: ownerCheckRequestId } })) === 0);

    const selfOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3c. The approver themselves, who holds projectRequest.approve but NOT project.assignable -> 422 (approving ≠ automatically a valid owner)", selfOwnerRes.status === 422);

    const requesterOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: requester.id }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3d. The requester, who holds no project.assignable grant either -> 422", requesterOwnerRes.status === 422);

    const emptyStringOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good.", projectOwnerId: "" }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3e. An empty-string projectOwnerId is rejected at the SCHEMA layer -> 422", emptyStringOwnerRes.status === 422);

    const adminOwnerRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks good, approving.", projectOwnerId: adminUser.id }), { params: Promise.resolve({ id: ownerCheckRequestId }) });
    check("3f. An ADMIN user (global bypass) IS a valid owner choice regardless of department membership -> 200", adminOwnerRes.status === 200);
    const adminOwnedProject = await prisma.project.findUnique({ where: { projectRequestId: ownerCheckRequestId } });
    if (adminOwnedProject) projectIds.push(adminOwnedProject.id);
    check("...the created Project's owner really is the chosen admin user", adminOwnedProject?.ownerId === adminUser.id);

    // ══════════════════════ 4. Field mapping + first-class Project (shows up in the real Projects list) ══════════════════════
    console.log("\n=== 4. The auto-created Project is pre-filled correctly and is a REAL, first-class Project row ===\n");
    const mappingRequestId = await submitAndClearIntermediate(`PR Creation Mapping ${RUN_ID}`);
    const requestRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: mappingRequestId } });

    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const mappingApproveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Approved, proceed.", projectOwnerId: ownerUser.id }), { params: Promise.resolve({ id: mappingRequestId }) });
    check("4. A valid, deptA-scoped project.assignable owner -> 200", mappingApproveRes.status === 200);
    const mappingApproveBody = await mappingApproveRes.json();
    check("...the response includes the new Project's id", typeof mappingApproveBody.projectId === "string" && mappingApproveBody.projectId.length > 0);

    const mappedProject = await prisma.project.findUnique({ where: { projectRequestId: mappingRequestId } });
    if (mappedProject) projectIds.push(mappedProject.id);
    check("...the Project's id matches what the API returned", mappedProject?.id === mappingApproveBody.projectId);
    check("4. title === request.title", mappedProject?.title === requestRow.title);
    check("4. description === request.description", mappedProject?.description === requestRow.description);
    check("4. departmentId === request.departmentId", mappedProject?.departmentId === deptA.id);
    check("4. priority === request.importance (same 1/2/3 scale, verbatim)", mappedProject?.priority === requestRow.importance);
    check("4. ownerId === the approver's own chosen owner, never the requester or the approver themselves", mappedProject?.ownerId === ownerUser.id && mappedProject?.ownerId !== requester.id && mappedProject?.ownerId !== finalApprover.id);
    check("4. status defaults to PLANNING, exactly like any manually-created Project", mappedProject?.status === "PLANNING");
    check("4. progress defaults to 0", mappedProject?.progress === 0);

    console.log("\n-- The new Project is a REAL, first-class row — it shows up in the normal GET /api/projects listing for its owner --\n");
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const listRes = await projectsGET(new NextRequest(`http://localhost/x?departmentId=${deptA.id}`));
    check("GET /api/projects (as the new owner) -> 200", listRes.status === 200);
    const listBody = await listRes.json();
    check("...the auto-created Project appears in the owner's own normal Projects list, indistinguishable from a manually-created one", listBody.projects?.some((p: any) => p.id === mappedProject?.id));

    // ══════════════════════ 5. A REJECTED request never gets a Project ══════════════════════
    console.log("\n=== 5. Rejecting a request never creates a Project ===\n");
    const rejectRequestId = await submitAndClearIntermediate(`PR Creation Reject ${RUN_ID}`);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const rejectDecisionRes = await approvalPOST(jsonReq({ decision: "reject", businessAssessment: "Not viable at this time." }), { params: Promise.resolve({ id: rejectRequestId }) });
    check("5. Reject -> 200 (projectOwnerId was never required for reject)", rejectDecisionRes.status === 200);
    const rejectedProject = await prisma.project.findUnique({ where: { projectRequestId: rejectRequestId } });
    check("...no Project row was created for the rejected request", rejectedProject === null);

    // ══════════════════════ 6. @unique projectRequestId — a second decide on an already-decided request can never produce a duplicate Project ══════════════════════
    console.log("\n=== 6. A request can never end up with two Projects (idempotency) ===\n");
    const secondAttemptRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Trying again.", projectOwnerId: ownerUser.id }), { params: Promise.resolve({ id: mappingRequestId }) });
    check("6. Deciding an already-APPROVED request again -> 409, never a second Project", secondAttemptRes.status === 409);
    const projectCountForMapping = await prisma.project.count({ where: { projectRequestId: mappingRequestId } });
    check("...exactly ONE Project still exists for that request, never two", projectCountForMapping === 1);
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["projects (auto-created, explicitly tracked)", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["projects (auto-created from these requests)", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["intermediate approver rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
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
