/**
 * Regression coverage for the Project Request INTERMEDIATE approval stage —
 * restricted this round to the requester's own VERIFIED SQLGeneral direct
 * manager (lib/services/project-request-service.ts's
 * resolveIntermediateApproverCandidates/resolveIntermediateApprovers),
 * replacing the prior global-permission-holder picker entirely. The
 * pre-existing, untouched, department-scoped FINAL approval stage
 * (decideApproval) is exercised too, to prove it's genuinely unaffected.
 *
 * Design (this round): candidates are never Company/Department-derived,
 * never a permission grant — they are the requester's own verified
 * managerAMAccountName, resolved to an ACTIVE local TicketApp user via
 * SqlGeneralUserSyncAttempt. Explicit selection is still required when a
 * candidate exists (never auto-selected). A requester whose own SQLGeneral
 * record VERIFIES they have no manager at all (managerAMAccountName is
 * genuinely null) skips the intermediate stage entirely and starts at
 * PENDING_APPROVAL. Anything short of that verified fact — an unmatched/
 * ambiguous identity, a SQLGeneral API failure, a manager with no
 * TicketApp account, or an inactive manager account — is "unresolved" and
 * blocks submission outright; it is NEVER treated as "no manager".
 * Authorization to DECIDE a request no longer requires a separate global
 * permission either — a real ProjectRequestIntermediateApprover row is
 * now sufficient on its own, since it can only ever have been created
 * against a freshly-verified manager.
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

function fakeSqlUser(username: string, managerAMAccountName: string | null) {
  return { username, mail: `${username}@example.com`, hrDepartmentId: null, department: null, companyId: null, company: null, active: true, managerAMAccountName, manager2AMAccountName: null, manager3AMAccountName: null };
}

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

  const realSqlGeneralClient = await import("@/lib/sqlgeneral-api-client");
  type ListUsersFn = typeof realSqlGeneralClient.listAllSqlGeneralUsers;
  // The bulk fixture every test below shares unless a specific test
  // overrides it (e.g. to simulate an API failure for one call only).
  let mockListUsersImpl: ListUsersFn = async () => ({
    ok: true,
    users: [
      fakeSqlUser("geokos", null), // a genuine, verified root — the manager
      fakeSqlUser("konsym", "geokos"), // the named example from the spec: geokos -> konsym
      fakeSqlUser("toporoot", null), // a different, independent verified root (no-manager requester)
      fakeSqlUser("mgr-no-ticketapp", null), // exists in SQLGeneral, but gets NO local SqlGeneralUserSyncAttempt below
      fakeSqlUser("nolocalmgr-emp", "mgr-no-ticketapp"),
      fakeSqlUser("inactive-boss", null), // exists, has a local account, but that account is isActive=false
      fakeSqlUser("inactivemgr-emp", "inactive-boss"),
      fakeSqlUser("deactmgr", null), // ACTIVE at submission time; deactivated AFTER being selected, before deciding
      fakeSqlUser("deactreq", "deactmgr"),
    ],
  });
  mock.module("@/lib/sqlgeneral-api-client", { namedExports: { ...realSqlGeneralClient, listAllSqlGeneralUsers: () => mockListUsersImpl() } });

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

  async function makeUser(email: string, isActive = true) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive } });
    userIds.push(u.id);
    return u;
  }
  /** Captures this local user's verified SQLGeneral username — exactly what SqlGeneralUserSyncAttempt would hold after a real Microsoft login resolved it (see sqlgeneral-user-sync-service.ts), never created by this feature itself. */
  async function captureSqlGeneralUsername(userId: string, username: string) {
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId, sqlGeneralUsername: username, status: "SUCCEEDED" } });
  }
  async function makeDeptMember(departmentId: string, email: string) {
    const user = await makeUser(email);
    await prisma.departmentMembership.create({
      data: { userId: user.id, departmentId, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    return user;
  }
  async function makeDeptApprover(tag: string, departmentId: string) {
    const role = await prisma.customRole.create({ data: { key: `PR_IA_DEPT_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
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
    const type = await prisma.taskType.create({ data: { name: `PR IA Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const geokos = await makeUser(`pr-ia-geokos-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(geokos.id, "geokos");
    await prisma.departmentMembership.create({
      data: { userId: geokos.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const konsym = await makeDeptMember(dept.id, `pr-ia-konsym-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(konsym.id, "konsym");

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

    // ══════════════════════ 1. geokos -> konsym: the named production relationship, end to end through BOTH stages ══════════════════════
    console.log("\n=== 1. geokos is verified as konsym's direct manager — explicit selection, decision, and the unchanged FINAL stage ===\n");
    sessionFor(konsym);
    const konsymSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA geokos-konsym ${RUN_ID}`, intermediateApproverIds: [geokos.id] }));
    check("1. konsym submits selecting geokos (their verified manager) -> 201", konsymSubmitRes.status === 201);
    const konsymSubmit = await konsymSubmitRes.json();
    requestIds.push(konsymSubmit.id);
    const konsymRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: konsymSubmit.id } });
    check("...status starts at PENDING_INTERMEDIATE_APPROVAL", konsymRow.status === "PENDING_INTERMEDIATE_APPROVAL");
    const konsymApproverRow = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: konsymSubmit.id, approverId: geokos.id } } });
    check("...exactly one ProjectRequestIntermediateApprover row was created, for geokos, PENDING", konsymApproverRow.status === "PENDING");

    sessionFor(finalApprover);
    const earlyFinalRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Jumping ahead.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: konsymSubmit.id }) });
    check("1. The final stage still refuses to act while intermediate approval is pending (unchanged gate)", earlyFinalRes.status === 409);

    sessionFor(geokos);
    const geokosApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Approved by direct manager." }), { params: Promise.resolve({ id: konsymSubmit.id }) });
    check("1. geokos (the verified manager, selected) can decide -> 200", geokosApproveRes.status === 200);
    const konsymRowAfterApprove = await prisma.projectRequest.findUniqueOrThrow({ where: { id: konsymSubmit.id } });
    check("...status advances to PENDING_APPROVAL (final stage unlocked)", konsymRowAfterApprove.status === "PENDING_APPROVAL");

    console.log("\n-- The FINAL stage now works completely normally — unchanged by this round's intermediate-stage redesign --\n");
    sessionFor(finalApprover);
    const finalDecideRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Final sign-off, approved.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: konsymSubmit.id }) });
    check("1. The department-scoped final approver -> 200", finalDecideRes.status === 200);
    const konsymRowFinal = await prisma.projectRequest.findUniqueOrThrow({ where: { id: konsymSubmit.id } });
    check("...status -> APPROVED, final stage's own fields populated independently", konsymRowFinal.status === "APPROVED" && konsymRowFinal.approverId === finalApprover.id);

    // ══════════════════════ 2. Explicit selection required — never auto-selected ══════════════════════
    console.log("\n=== 2. Explicit selection is required when a verified manager candidate exists — never auto-selected ===\n");
    sessionFor(konsym);
    const emptySelectionRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Empty ${RUN_ID}`, intermediateApproverIds: [] }));
    check("2. Submitting with ZERO approvers, even though a real verified manager exists, -> 400 (never auto-selects geokos for them)", emptySelectionRes.status === 400);
    const countAfterEmpty = await prisma.projectRequest.count({ where: { title: `PR IA Empty ${RUN_ID}` } });
    check("...no ProjectRequest row was created", countAfterEmpty === 0);

    // ══════════════════════ 3. Unauthorized approver injection ══════════════════════
    console.log("\n=== 3. Submitting an approver who is NOT the requester's verified manager fails the WHOLE submission ===\n");
    const impostor = await makeUser(`pr-ia-impostor-${RUN_ID}@kinsen.gr`);
    sessionFor(konsym);
    const countBeforeForged = await prisma.projectRequest.count();
    const forgedRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Forged ${RUN_ID}`, intermediateApproverIds: [impostor.id] }));
    check("3. A requester submitting ANYONE other than their own verified manager -> 400", forgedRes.status === 400);
    const countAfterForged = await prisma.projectRequest.count();
    check("...zero ProjectRequest rows created — never a partial fallback", countBeforeForged === countAfterForged);

    console.log("\n-- A user who was never selected for a request cannot decide it, even if they ARE someone else's verified manager --\n");
    const secondSubmitRes = (async () => {
      sessionFor(konsym);
      return requestsPOST(jsonReq({ ...basePayload, title: `PR IA Second ${RUN_ID}`, intermediateApproverIds: [geokos.id] }));
    })();
    const secondSubmitJson = await (await secondSubmitRes).json();
    requestIds.push(secondSubmitJson.id);
    sessionFor(impostor);
    const impostorDecideRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Let me approve this too." }), { params: Promise.resolve({ id: secondSubmitJson.id }) });
    check("3. A user with no ProjectRequestIntermediateApprover row for this request -> 403, never 200", impostorDecideRes.status === 403);
    const secondRowUnchanged = await prisma.projectRequest.findUniqueOrThrow({ where: { id: secondSubmitJson.id } });
    check("...the request's status is completely untouched by the forbidden attempt", secondRowUnchanged.status === "PENDING_INTERMEDIATE_APPROVAL");

    console.log("\n-- A selected approver who is DEACTIVATED after submission (but before deciding) is rejected, even with a live session --\n");
    const deactMgr = await makeUser(`pr-ia-deactmgr-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(deactMgr.id, "deactmgr");
    const deactReq = await makeDeptMember(dept.id, `pr-ia-deactreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(deactReq.id, "deactreq");
    sessionFor(deactReq);
    const deactSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Deact ${RUN_ID}`, intermediateApproverIds: [deactMgr.id] }));
    check("3b. Submission with a genuinely active, verified manager -> 201", deactSubmitRes.status === 201);
    const deactSubmit = await deactSubmitRes.json();
    requestIds.push(deactSubmit.id);
    // Deactivated AFTER being validly selected — simulates a real admin
    // deactivation mid-session; this app's isActive=false enforcement is a
    // JWT/session-level SNAPSHOT taken at login (see lib/auth.ts), so the
    // mocked `currentSession` below deliberately still reports a "live"
    // session for deactMgr, exactly like a stale, not-yet-expired real one.
    await prisma.user.update({ where: { id: deactMgr.id }, data: { isActive: false } });
    sessionFor(deactMgr);
    const deactDecideRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Trying to approve while deactivated." }), { params: Promise.resolve({ id: deactSubmit.id }) });
    check("3b. A selected approver who was deactivated AFTER submission -> 403, never 200, despite a live session and a real selected row", deactDecideRes.status === 403);
    const deactRowUnchanged = await prisma.projectRequest.findUniqueOrThrow({ where: { id: deactSubmit.id } });
    check("...the request's status is completely untouched by the forbidden attempt", deactRowUnchanged.status === "PENDING_INTERMEDIATE_APPROVAL");
    const deactMyRowUnchanged = await prisma.projectRequestIntermediateApprover.findUniqueOrThrow({ where: { projectRequestId_approverId: { projectRequestId: deactSubmit.id, approverId: deactMgr.id } } });
    check("...and their own ProjectRequestIntermediateApprover row is still PENDING, never fabricated as decided", deactMyRowUnchanged.status === "PENDING");

    // ══════════════════════ 4. No-manager bypass: a VERIFIED "no manager" record skips the intermediate stage entirely ══════════════════════
    console.log("\n=== 4. A requester whose SQLGeneral record VERIFIES they have no manager skips straight to Final Approval ===\n");
    const toporoot = await makeDeptMember(dept.id, `pr-ia-toporoot-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(toporoot.id, "toporoot");
    sessionFor(toporoot);
    const notifBeforeSkip = await prisma.notification.count({ where: { userId: finalApprover.id } });
    const skipSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Skip ${RUN_ID}`, intermediateApproverIds: [] }));
    check("4. A verified-no-manager requester submitting with an EMPTY approver list -> 201", skipSubmitRes.status === 201);
    const skipSubmit = await skipSubmitRes.json();
    requestIds.push(skipSubmit.id);
    const skipRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: skipSubmit.id } });
    check("4. status starts DIRECTLY at PENDING_APPROVAL — the intermediate stage is never entered", skipRow.status === "PENDING_APPROVAL");
    const skipApproverRows = await prisma.projectRequestIntermediateApprover.count({ where: { projectRequestId: skipSubmit.id } });
    check("...zero ProjectRequestIntermediateApprover rows were created", skipApproverRows === 0);
    const notifAfterSkip = await prisma.notification.count({ where: { userId: finalApprover.id } });
    check("...the final-stage approver is notified IMMEDIATELY (same as the unanimous-completion transition), not left waiting", notifAfterSkip > notifBeforeSkip);

    console.log("\n-- The final stage already works immediately for a skipped request, no intermediate approval ever required --\n");
    sessionFor(finalApprover);
    const skipFinalRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Approved directly.", projectOwnerId: finalApprover.id }), { params: Promise.resolve({ id: skipSubmit.id }) });
    check("4. The final approver can decide it immediately -> 200", skipFinalRes.status === 200);

    console.log("\n-- A non-empty selection for a VERIFIED no-manager requester is rejected too — fail closed, never a silent override --\n");
    const skipForgedRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA SkipForged ${RUN_ID}`, intermediateApproverIds: [geokos.id] }));
    check("4. A verified-no-manager requester submitting a non-empty approver list -> 400", skipForgedRes.status === 400);

    // ══════════════════════ 5. Unresolved manager/API failure — NEVER treated as "no manager" ══════════════════════
    console.log('\n=== 5. "Unresolved" (API failure / no TicketApp account / inactive account) NEVER behaves like "no manager" ===\n');

    console.log("\n-- A SQLGeneral API/pagination failure blocks submission entirely --\n");
    const realImpl = mockListUsersImpl;
    mockListUsersImpl = async () => ({ ok: false, reason: "Pagination exceeded 200 pages." });
    sessionFor(konsym);
    const apiFailRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA ApiFail ${RUN_ID}`, intermediateApproverIds: [] }));
    check('5. An API failure while resolving the requester\'s manager -> 400, NEVER 201 ("no manager" would also submit with [])', apiFailRes.status === 400);
    const apiFailCount = await prisma.projectRequest.count({ where: { title: `PR IA ApiFail ${RUN_ID}` } });
    check("...no ProjectRequest row was created", apiFailCount === 0);
    mockListUsersImpl = realImpl;

    console.log("\n-- A manager who exists in SQLGeneral but has NO local TicketApp account blocks submission --\n");
    const noLocalMgrEmp = await makeDeptMember(dept.id, `pr-ia-nolocalmgr-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(noLocalMgrEmp.id, "nolocalmgr-emp");
    sessionFor(noLocalMgrEmp);
    const noLocalMgrRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA NoLocalMgr ${RUN_ID}`, intermediateApproverIds: [] }));
    check("5. A requester whose verified manager has no TicketApp account -> 400, never skipped", noLocalMgrRes.status === 400);

    console.log("\n-- A manager whose local TicketApp account is INACTIVE blocks submission --\n");
    const inactiveBoss = await makeUser(`pr-ia-inactiveboss-${RUN_ID}@kinsen.gr`, false);
    await captureSqlGeneralUsername(inactiveBoss.id, "inactive-boss");
    const inactiveMgrEmp = await makeDeptMember(dept.id, `pr-ia-inactivemgr-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(inactiveMgrEmp.id, "inactivemgr-emp");
    sessionFor(inactiveMgrEmp);
    const inactiveMgrRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA InactiveMgr ${RUN_ID}`, intermediateApproverIds: [] }));
    check("5. A requester whose verified manager's TicketApp account is inactive -> 400, never skipped", inactiveMgrRes.status === 400);
    check("...and never 201 with inactiveBoss as a usable candidate either", inactiveMgrRes.status !== 201);
    const inactiveBossAsApproverRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA InactiveMgrForce ${RUN_ID}`, intermediateApproverIds: [inactiveBoss.id] }));
    check("...and explicitly selecting the inactive manager also fails (they are never a valid candidate)", inactiveBossAsApproverRes.status === 400);

    console.log("\n-- A requester whose own SQLGeneral identity was never captured at all is unresolved, never no-manager --\n");
    const uncaptured = await makeDeptMember(dept.id, `pr-ia-uncaptured-${RUN_ID}@kinsen.gr`);
    sessionFor(uncaptured);
    const uncapturedRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Uncaptured ${RUN_ID}`, intermediateApproverIds: [] }));
    check("5. A requester with no captured SQLGeneral username at all -> 400, never skipped", uncapturedRes.status === 400);

    // ══════════════════════ 6. not_found / invalid_assessment / double-decide — unchanged generic behaviors ══════════════════════
    console.log("\n=== 6. not_found, double-decide, and businessAssessment validation are unaffected by this round's redesign ===\n");
    sessionFor(geokos);
    const notFoundRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Doesn't matter." }), { params: Promise.resolve({ id: "cmx0000000000000000000099" }) });
    check("6. Deciding a nonexistent request id -> 404", notFoundRes.status === 404);

    sessionFor(konsym);
    const assessmentFixtureRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA Assessment ${RUN_ID}`, intermediateApproverIds: [geokos.id] }));
    const assessmentFixture = await assessmentFixtureRes.json();
    requestIds.push(assessmentFixture.id);
    sessionFor(geokos);
    const whitespaceAssessmentRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "   \n\t  " }), { params: Promise.resolve({ id: assessmentFixture.id }) });
    check("6. Whitespace-only businessAssessment -> 200, never rejected (optional at this stage)", whitespaceAssessmentRes.status === 200);
    const doubleDecideRes = await intermediateApprovalPOST(jsonReq({ decision: "reject", businessAssessment: "Changed my mind." }), { params: Promise.resolve({ id: assessmentFixture.id }) });
    check("...deciding the same row a second time -> 409, never a silent no-op success", doubleDecideRes.status === 409);

    sessionFor(konsym);
    const overLengthFixtureRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA OverLength ${RUN_ID}`, intermediateApproverIds: [geokos.id] }));
    const overLengthFixture = await overLengthFixtureRes.json();
    requestIds.push(overLengthFixture.id);
    sessionFor(geokos);
    const overLengthRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "x".repeat(5001) }), { params: Promise.resolve({ id: overLengthFixture.id }) });
    check("6. Over-length (5001 chars) businessAssessment -> 422", overLengthRes.status === 422);
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["intermediate approver rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["projects (auto-created from these requests)", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.taskType.deleteMany({ where: { id: { in: typeIds } } })],
      ["sqlgeneral sync attempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
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
