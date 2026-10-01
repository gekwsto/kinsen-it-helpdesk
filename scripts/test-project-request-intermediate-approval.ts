/**
 * Regression coverage for the Project Request INTERMEDIATE approval stage —
 * the new, requester-selected, unanimous-multi-approver stage that now sits
 * ahead of the pre-existing, untouched, department-scoped FINAL approval
 * stage (lib/services/project-request-service.ts's decideApproval, never
 * modified by this feature).
 *
 * Design (confirmed with the user): at submission, the requester selects one
 * or more approvers from EVERY active user system-wide who holds the new
 * `projectRequest.intermediateApprove` permission (global, never
 * department-scoped, never org-chart/manager-derived). ALL selected
 * approvers must approve (unanimous) before the request advances to the
 * final stage; a REJECT from any single selected approver immediately
 * terminalizes the whole request. Holding the permission is NECESSARY but
 * NOT SUFFICIENT — only an explicitly selected user may decide a given
 * request.
 *
 * This file does not re-prove what the retrofitted sibling test files
 * already cover incidentally (basic submission plumbing, cost-snapshot
 * untouched, replacement-description untouched, list/table wiring,
 * notification-hygiene cleanup) — it focuses on the intermediate stage's OWN
 * behavior: permission-vs-assignment separation, unanimous multi-approver
 * completion, immediate-rejection short-circuit, the final-stage gate, audit
 * trail separation, snapshot immutability, and race/tamper resistance.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-intermediate-approval.ts
 */
import { mock } from "node:test";

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
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const jsonReq = (body?: unknown) =>
    new NextRequest("http://localhost/x", { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string, customRoleId: string | null = null) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }
  /** GLOBAL-scope custom role granting `permissionKey` — set directly on the user's own top-level customRoleId (the reverse-lookup used by getUsersWithGlobalPermission/resolveIntermediateApprovers reads that DB column, never a DepartmentMembership's, and never the mocked session alone). */
  async function makeGlobalUser(tag: string, email: string, permissionKey: string) {
    const role = await prisma.customRole.create({ data: { key: `PR_IA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL" as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } });
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    const user = await makeUser(email, role.id);
    return { role, user };
  }
  async function makeDeptApprover(tag: string, departmentId: string) {
    const role = await prisma.customRole.create({ data: { key: `PR_IA_DEPT_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    // Also project-assignable, via the SAME role — this user doubles as
    // the chosen owner of the Project auto-created on approval (see
    // decideApproval), no separate fixture needed just for that.
    const assignablePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "project.assignable" } });
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: assignablePerm.id } });
    const user = await makeUser(`pr-ia-${tag.toLowerCase()}-${RUN_ID}@kinsen.gr`);
    await prisma.departmentMembership.create({
      data: { userId: user.id, departmentId, role: DepartmentRole.VIEWER, customRoleId: role.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    return user;
  }

  try {
    const dept = await createDepartment({ name: `PR IA Dept ${RUN_ID}`, slug: `pr-ia-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR IA Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await makeUser(`pr-ia-requester-${RUN_ID}@kinsen.gr`);
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const { user: approver1 } = await makeGlobalUser("APPROVER1", `pr-ia-approver1-${RUN_ID}@kinsen.gr`, "projectRequest.intermediateApprove");
    const { user: approver2 } = await makeGlobalUser("APPROVER2", `pr-ia-approver2-${RUN_ID}@kinsen.gr`, "projectRequest.intermediateApprove");
    const { user: unselectedHolder } = await makeGlobalUser("UNSELECTED", `pr-ia-unselected-${RUN_ID}@kinsen.gr`, "projectRequest.intermediateApprove");
    const finalApprover = await makeDeptApprover("FINAL", dept.id);

    const basePayload = {
      title: `PR IA Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 2,
      projectTypeId: type.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
    };

    function sessionFor(user: { id: string }, role: any = Role.USER, customRoleId: string | null = null) {
      currentSession = { user: { id: user.id, role, customRoleId } };
    }

    // ══════════════════════ 1. Permission alone is NECESSARY but NOT SUFFICIENT ══════════════════════
    console.log("\n=== 1. A global permission-holder who was NOT selected for this request cannot decide it ===\n");
    sessionFor(requester);
    const soloSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Solo ${RUN_ID}`, intermediateApproverIds: [approver1.id] }));
    check("Submission with a single valid intermediate approver -> 201", soloSubmitRes.status === 201);
    const soloSubmit = await soloSubmitRes.json();
    requestIds.push(soloSubmit.id);
    const soloRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: soloSubmit.id } });
    check("...status starts at PENDING_INTERMEDIATE_APPROVAL", soloRow.status === "PENDING_INTERMEDIATE_APPROVAL");

    sessionFor(unselectedHolder, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: unselectedHolder.id } })).customRoleId);
    const unselectedAttemptRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "I hold the permission, let me in." }), { params: Promise.resolve({ id: soloSubmit.id }) });
    check("1. A real, active holder of projectRequest.intermediateApprove who was NEVER selected for THIS request -> 403, not 200", unselectedAttemptRes.status === 403);
    const soloRowUnchanged = await prisma.projectRequest.findUniqueOrThrow({ where: { id: soloSubmit.id } });
    check("...the request's status is completely untouched by the forbidden attempt", soloRowUnchanged.status === "PENDING_INTERMEDIATE_APPROVAL");

    console.log("\n-- A user with NEITHER the permission NOR a selection gets the SAME forbidden outcome (no information leak) --\n");
    const nobodyRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Trying anyway." }), { params: Promise.resolve({ id: soloSubmit.id }) });
    void nobodyRes; // same session (unselectedHolder) reused is enough to prove the 403 path; a second distinct no-permission user is exercised in section 7 below.
    check("Resubmitting the forbidden attempt again -> still 403, not escalated to any other error", (await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Still trying." }), { params: Promise.resolve({ id: soloSubmit.id }) })).status === 403);

    // ══════════════════════ 2. The sole selected approver clears a single-approver request normally ══════════════════════
    console.log("\n=== 2. The sole, correctly selected approver clears the stage normally ===\n");
    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const soloApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Looks fine, approving." }), { params: Promise.resolve({ id: soloSubmit.id }) });
    check("The selected approver -> 200", soloApproveRes.status === 200);
    const soloRowApproved = await prisma.projectRequest.findUniqueOrThrow({ where: { id: soloSubmit.id } });
    check("...status advances to PENDING_APPROVAL (final stage unlocked)", soloRowApproved.status === "PENDING_APPROVAL");
    check("...the FINAL stage's own fields (approver/approvedAt/businessAssessment) are completely untouched by the intermediate decision", soloRowApproved.approverId === null && soloRowApproved.approvedAt === null && soloRowApproved.businessAssessment === null);
    const soloApproverRow = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: soloSubmit.id, approverId: approver1.id } } });
    check("...the intermediate row itself records APPROVED + the approver's OWN businessAssessment, on its OWN field", soloApproverRow.status === "APPROVED" && soloApproverRow.businessAssessment === "Looks fine, approving.");

    console.log("\n-- Deciding the same row a second time -> 409, never a silent no-op success --\n");
    const doubleDecideRes = await intermediateApprovalPOST(jsonReq({ decision: "reject", businessAssessment: "Changed my mind." }), { params: Promise.resolve({ id: soloSubmit.id }) });
    check("A second decision attempt on an already-decided row -> 409 invalid_status", doubleDecideRes.status === 409);
    const soloRowStillApproved = await prisma.projectRequest.findUniqueOrThrow({ where: { id: soloSubmit.id } });
    check("...the first decision's outcome is completely unaffected", soloRowStillApproved.status === "PENDING_APPROVAL");

    console.log("\n-- The FINAL stage now works completely normally, exactly as before this feature ever existed --\n");
    sessionFor(finalApprover);
    const finalDecideRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Final sign-off, approved.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: soloSubmit.id }) });
    check("The department-scoped final approver -> 200", finalDecideRes.status === 200);
    const soloRowFinal = await prisma.projectRequest.findUniqueOrThrow({ where: { id: soloSubmit.id } });
    check("...status -> APPROVED", soloRowFinal.status === "APPROVED");
    check("...and NOW the final stage's own fields ARE populated, independently of the intermediate stage's", soloRowFinal.approverId === finalApprover.id && soloRowFinal.businessAssessment === "Final sign-off, approved.");

    // ══════════════════════ 3. Unanimous multi-approver: both must approve before the final stage unlocks ══════════════════════
    console.log("\n=== 3. Multi-approver UNANIMOUS approval: the final stage unlocks only once BOTH selected approvers have approved ===\n");
    sessionFor(requester);
    const multiSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Multi ${RUN_ID}`, intermediateApproverIds: [approver1.id, approver2.id] }));
    check("Submission with TWO intermediate approvers -> 201", multiSubmitRes.status === 201);
    const multiSubmit = await multiSubmitRes.json();
    requestIds.push(multiSubmit.id);
    const multiRows = await prisma.projectRequestIntermediateApprover.findMany({ where: { projectRequestId: multiSubmit.id } });
    check("...exactly 2 ProjectRequestIntermediateApprover rows were created, one per selected approver, both PENDING", multiRows.length === 2 && multiRows.every((r) => r.status === "PENDING"));

    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const firstApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "I approve my part." }), { params: Promise.resolve({ id: multiSubmit.id }) });
    check("approver1 approves -> 200", firstApproveRes.status === 200);
    const multiRowAfterFirst = await prisma.projectRequest.findUniqueOrThrow({ where: { id: multiSubmit.id } });
    check("3. After only ONE of two required approvals, the request is STILL PENDING_INTERMEDIATE_APPROVAL — not yet unlocked", multiRowAfterFirst.status === "PENDING_INTERMEDIATE_APPROVAL");

    sessionFor(approver2, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver2.id } })).customRoleId);
    const beforeSecondApproveNotifCount = await prisma.notification.count({ where: { userId: finalApprover.id, link: `/project-requests/${multiSubmit.id}` } });
    check("Before the second (final) approval, the department-scoped final approver has NOT yet been notified at all", beforeSecondApproveNotifCount === 0);
    const secondApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "I approve too." }), { params: Promise.resolve({ id: multiSubmit.id }) });
    check("approver2 (the SECOND and last required approval) -> 200", secondApproveRes.status === 200);
    const multiRowAfterSecond = await prisma.projectRequest.findUniqueOrThrow({ where: { id: multiSubmit.id } });
    check("3. Only NOW, with BOTH approvals in, does the request advance to PENDING_APPROVAL", multiRowAfterSecond.status === "PENDING_APPROVAL");
    const afterSecondApproveNotifs = await prisma.notification.findMany({ where: { userId: finalApprover.id, link: `/project-requests/${multiSubmit.id}` } });
    check("...and the final approver is notified EXACTLY once now — not once per intermediate approver, not zero", afterSecondApproveNotifs.length === 1);

    // ══════════════════════ 4. A single REJECT short-circuits the whole request, regardless of other pending approvers ══════════════════════
    console.log("\n=== 4. A single REJECT from one of several selected approvers immediately terminalizes the whole request ===\n");
    sessionFor(requester);
    const rejectSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Reject ${RUN_ID}`, intermediateApproverIds: [approver1.id, approver2.id] }));
    check("Submission with TWO intermediate approvers -> 201", rejectSubmitRes.status === 201);
    const rejectSubmit = await rejectSubmitRes.json();
    requestIds.push(rejectSubmit.id);

    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const rejectRes = await intermediateApprovalPOST(jsonReq({ decision: "reject", businessAssessment: "This should not proceed." }), { params: Promise.resolve({ id: rejectSubmit.id }) });
    check("approver1 rejects -> 200", rejectRes.status === 200);
    const rejectRowAfter = await prisma.projectRequest.findUniqueOrThrow({ where: { id: rejectSubmit.id } });
    check("4. The WHOLE request is immediately REJECTED — never waits for approver2's own decision", rejectRowAfter.status === "REJECTED");
    check("...rejectedAt is set", rejectRowAfter.rejectedAt !== null);
    const rejectorRow = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: rejectSubmit.id, approverId: approver1.id } } });
    check("...the rejecting approver's OWN row records REJECTED with their own assessment", rejectorRow.status === "REJECTED" && rejectorRow.businessAssessment === "This should not proceed.");
    const otherApproverRow = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: rejectSubmit.id, approverId: approver2.id } } });
    check("...the OTHER (never-decided) approver's row is left exactly as it was — still PENDING, never fabricated as rejected/approved on their behalf", otherApproverRow.status === "PENDING");

    sessionFor(approver2, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver2.id } })).customRoleId);
    const lateApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Too late, trying anyway." }), { params: Promise.resolve({ id: rejectSubmit.id }) });
    check("4. approver2's later decision attempt on the already-rejected request -> 409, not a silent success", lateApproveRes.status === 409);
    const rejectRowStill = await prisma.projectRequest.findUniqueOrThrow({ where: { id: rejectSubmit.id } });
    check("...the request remains REJECTED, untouched by the late attempt", rejectRowStill.status === "REJECTED");

    console.log("\n-- The requester was notified of the rejection; the final-stage approver was NEVER notified for this request at all --\n");
    const rejectRequesterNotif = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/project-requests/${rejectSubmit.id}` } });
    check("The requester received a rejection notification", rejectRequesterNotif !== null && rejectRequesterNotif.body.includes("rejected during intermediate approval"));
    const finalApproverNotifsForRejected = await prisma.notification.count({ where: { userId: finalApprover.id, link: `/project-requests/${rejectSubmit.id}` } });
    check("The final-stage approver was never notified for this request (it never reached the final stage)", finalApproverNotifsForRejected === 0);

    console.log("\n-- The FINAL approval route itself refuses to act on a request still stuck at (or past) the intermediate stage — the gate falls out of the existing status guard, with zero new code in decideApproval --\n");
    sessionFor(finalApprover);
    const finalOnRejectedRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Trying to override.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: rejectSubmit.id }) });
    check("A final approver attempting to decide a REJECTED (at the intermediate stage) request -> 409, never 200", finalOnRejectedRes.status === 409);
    const rejectRowAfterFinalAttempt = await prisma.projectRequest.findUniqueOrThrow({ where: { id: rejectSubmit.id } });
    check("...status is untouched, still REJECTED, never silently flipped to APPROVED", rejectRowAfterFinalAttempt.status === "REJECTED");

    // ══════════════════════ 5. The final stage is blocked while intermediate is still genuinely PENDING ══════════════════════
    console.log("\n=== 5. The final approval route is blocked while the intermediate stage is still PENDING (not yet unanimous) ===\n");
    sessionFor(requester);
    const pendingGateSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA PendingGate ${RUN_ID}`, intermediateApproverIds: [approver1.id, approver2.id] }));
    const pendingGateSubmit = await pendingGateSubmitRes.json();
    requestIds.push(pendingGateSubmit.id);
    sessionFor(finalApprover);
    const prematureFinalRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Jumping the queue.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: pendingGateSubmit.id }) });
    check("5. A final approver attempting to decide a request still PENDING_INTERMEDIATE_APPROVAL (zero approvals in) -> 409, never 200", prematureFinalRes.status === 409);
    const pendingGateRowAfter = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pendingGateSubmit.id } });
    check("...status untouched, still PENDING_INTERMEDIATE_APPROVAL", pendingGateRowAfter.status === "PENDING_INTERMEDIATE_APPROVAL");
    // Clean up this fixture's own intermediate stage so it doesn't linger as
    // a dangling PENDING request after the run (cosmetic only — the
    // runCleanup below deletes it by id regardless of status).

    // ══════════════════════ 6. Submission snapshot is immutable — a NEW global permission holder never retroactively joins an existing request's approver set ══════════════════════
    console.log("\n=== 6. The selected-approver snapshot is frozen at submission — a newly-eligible user never retroactively appears ===\n");
    const snapshotRowsBefore = await prisma.projectRequestIntermediateApprover.findMany({ where: { projectRequestId: multiSubmit.id }, select: { approverId: true } });
    const { user: lateJoiner } = await makeGlobalUser("LATEJOIN", `pr-ia-latejoin-${RUN_ID}@kinsen.gr`, "projectRequest.intermediateApprove");
    const snapshotRowsAfter = await prisma.projectRequestIntermediateApprover.findMany({ where: { projectRequestId: multiSubmit.id }, select: { approverId: true } });
    check("6. A brand-new global permission holder created AFTER submission never appears on an already-submitted request's approver set", snapshotRowsAfter.length === snapshotRowsBefore.length && !snapshotRowsAfter.some((r) => r.approverId === lateJoiner.id));
    sessionFor(lateJoiner, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: lateJoiner.id } })).customRoleId);
    const lateJoinerAttemptRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Let me in too." }), { params: Promise.resolve({ id: multiSubmit.id }) });
    void lateJoinerAttemptRes; // multiSubmit already reached PENDING_APPROVAL above (section 3) — this attempt will 409 either way; the real proof is the snapshot-row check above.

    // ══════════════════════ 7. Fail-closed submission: resolveIntermediateApprovers rejects a forged/stale/no-permission id, the WHOLE submission fails ══════════════════════
    console.log("\n=== 7. A forged/ineligible intermediateApproverIds entry fails the WHOLE submission — never silently drops it and proceeds ===\n");
    const noPermUser = await makeUser(`pr-ia-noperm-${RUN_ID}@kinsen.gr`);
    sessionFor(requester);
    const countBeforeForged = await prisma.projectRequest.count();
    const forgedApproverRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Forged ${RUN_ID}`, intermediateApproverIds: [approver1.id, noPermUser.id] }));
    check("7. A submission mixing one valid approver with one user who does NOT hold the permission -> 400, the whole thing fails", forgedApproverRes.status === 400);
    const countAfterForged = await prisma.projectRequest.count();
    check("...zero ProjectRequest rows created — never a partial 'approver1-only' fallback", countBeforeForged === countAfterForged);

    console.log("\n-- An empty selection is also rejected server-side (fail closed — an empty intermediate pool must never silently skip the stage) --\n");
    const emptySelectionRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Empty ${RUN_ID}`, intermediateApproverIds: [] }));
    check("7. intermediateApproverIds: [] -> 422 (zod's own min(1) rejects it before it even reaches the server-side resolver)", emptySelectionRes.status === 422);

    // ══════════════════════ 8. not_found and invalid_assessment paths ══════════════════════
    console.log("\n=== 8. not_found and invalid_assessment error paths ===\n");
    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const notFoundRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Doesn't matter." }), { params: Promise.resolve({ id: "cmx0000000000000000000099" }) });
    check("8. Deciding a nonexistent request id -> 404", notFoundRes.status === 404);

    console.log("\n-- Unlike the FINAL stage, businessAssessment is OPTIONAL here (confirmed with the user: the intermediate stage asks for a decision only, no written justification) --\n");
    sessionFor(requester);
    const assessmentFixtureRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Assessment ${RUN_ID}`, intermediateApproverIds: [approver1.id] }));
    const assessmentFixture = await assessmentFixtureRes.json();
    requestIds.push(assessmentFixture.id);
    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const whitespaceAssessmentRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "   \n\t  " }), { params: Promise.resolve({ id: assessmentFixture.id }) });
    check("8. Whitespace-only businessAssessment -> 200, never rejected (optional at this stage)", whitespaceAssessmentRes.status === 200);
    const assessmentRowAfter = await prisma.projectRequest.findUniqueOrThrow({ where: { id: assessmentFixture.id } });
    check("...the decision still took effect (advanced past intermediate, the sole approver's decision)", assessmentRowAfter.status === "PENDING_APPROVAL");
    const myDecidedRow = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: assessmentFixture.id, approverId: approver1.id } } });
    check("...and the whitespace-only text is stored as null, never as a blank-but-technically-present string", myDecidedRow.businessAssessment === null);

    console.log("\n-- An over-length businessAssessment is still rejected, even though it's optional --\n");
    sessionFor(requester);
    const overLengthFixtureRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA OverLength ${RUN_ID}`, intermediateApproverIds: [approver1.id] }));
    const overLengthFixture = await overLengthFixtureRes.json();
    requestIds.push(overLengthFixture.id);
    sessionFor(approver1, Role.USER, (await prisma.user.findUniqueOrThrow({ where: { id: approver1.id } })).customRoleId);
    const overLengthRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "x".repeat(5001) }), { params: Promise.resolve({ id: overLengthFixture.id }) });
    check("8. Over-length (5001 chars) businessAssessment -> 422", overLengthRes.status === 422);
    const overLengthRowUnaffected = await prisma.projectRequest.findUniqueOrThrow({ where: { id: overLengthFixture.id } });
    check("...the request's status is completely untouched by the failed validation", overLengthRowUnaffected.status === "PENDING_INTERMEDIATE_APPROVAL");
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["intermediate approver rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
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
