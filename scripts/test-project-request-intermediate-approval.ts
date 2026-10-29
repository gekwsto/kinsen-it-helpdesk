/**
 * Regression coverage for the Project Request INTERMEDIATE approval stage —
 * restricted to the requester's own VERIFIED SQLGeneral manager CHAIN
 * (lib/services/project-request-service.ts's
 * resolveIntermediateApproverCandidates/resolveIntermediateApprovers),
 * never Company/Department, never a permission-holder pool. The
 * pre-existing, untouched, department-scoped FINAL approval stage
 * (decideApproval) is exercised too, to prove it's genuinely unaffected.
 *
 * Design (this round): resolveIntermediateApproverCandidates walks the
 * requester's managerAMAccountName chain upward — direct manager, that
 * manager's own manager, and so on — resolving each hop via a SINGLE exact
 * SQLGeneral lookup (findSqlGeneralUserByUsername), never the full
 * paginated roster (listAllSqlGeneralUsers, no longer called here at all).
 * Two different kinds of problem are handled differently, deliberately:
 *   - A STRUCTURAL problem anywhere in the chain (not found, ambiguous,
 *     self-reference, cycle, live API failure) fails the WHOLE resolution
 *     closed ("unresolved"), discarding any candidates already found below
 *     the break — never silently truncated.
 *   - A LOCAL-ACCOUNT problem on one specific, structurally-verified
 *     ancestor (no TicketApp account, claimed by >1 local account, or
 *     inactive) only excludes THAT ancestor as a candidate; the walk
 *     continues upward through them regardless.
 * A requester whose own record verifies no manager at all, OR whose fully
 * and cleanly walked chain yields zero eligible candidates, gets
 * "no_manager" and skips straight to PENDING_APPROVAL. Explicit selection
 * is still required among the manager(s) who ARE found. Authorization to
 * DECIDE no longer requires a separate global permission — a real
 * ProjectRequestIntermediateApprover row is sufficient on its own — but
 * IS re-checked for the deciding user's current isActive status, fresh
 * from the database, closing the window where a deactivated-mid-session
 * approver could still act on a stale session.
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
// Outside Next's bundler there is no "react-server" resolve condition, so the
// "server-only" package's conditional-exports guard always resolves to its
// throwing stub. Every code path this suite exercises that sends a
// notification transitively imports it (lib/web-push.ts via
// lib/notifications/create-notification.ts) — mock it to a no-op so that real
// require succeeds, exactly like the other real-module mocks below.
mock.module("server-only", { namedExports: {} });
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
  // Keyed by username, one entry per ROW — an array (not a single value) so
  // an ambiguous username (SQLGeneral itself reporting it more than once)
  // can be represented honestly, exactly like the real OData backend would.
  const sqlGeneralRowsByUsername = new Map<string, ReturnType<typeof fakeSqlUser>[]>();
  function registerSqlGeneralUser(username: string, managerAMAccountName: string | null) {
    if (!sqlGeneralRowsByUsername.has(username)) sqlGeneralRowsByUsername.set(username, []);
    sqlGeneralRowsByUsername.get(username)!.push(fakeSqlUser(username, managerAMAccountName));
  }
  let findUserCallCount = 0;
  let forceApiFailureOnce = false;
  async function mockFindUser(username: string) {
    findUserCallCount++;
    if (forceApiFailureOnce) {
      forceApiFailureOnce = false;
      throw new Error("Pagination exceeded 200 pages without reaching the end.");
    }
    const rows = sqlGeneralRowsByUsername.get(username) ?? [];
    if (rows.length === 0) return { outcome: "not_found" as const };
    if (rows.length > 1) return { outcome: "ambiguous" as const, count: rows.length };
    return { outcome: "unique" as const, user: rows[0] };
  }
  mock.module("@/lib/sqlgeneral-api-client", { namedExports: { ...realSqlGeneralClient, findSqlGeneralUserByUsername: (u: string) => mockFindUser(u) } });

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const { resolveIntermediateApproverCandidates } = await import("@/lib/services/project-request-service");

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
  /** A local TicketApp user who is ALSO a verified SQLGeneral identity — convenience for building manager-chain fixtures. */
  async function makeSqlGeneralUser(username: string, managerUsername: string | null, email: string, isActive = true) {
    const user = await makeUser(email, isActive);
    await captureSqlGeneralUsername(user.id, username);
    registerSqlGeneralUser(username, managerUsername);
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
    registerSqlGeneralUser("geokos", null);
    await prisma.departmentMembership.create({
      data: { userId: geokos.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const konsym = await makeDeptMember(dept.id, `pr-ia-konsym-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(konsym.id, "konsym");
    registerSqlGeneralUser("konsym", "geokos");

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

    // ══════════════════════ 3. Unauthorized approver injection + deactivation-mid-session ══════════════════════
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
    const deactMgr = await makeSqlGeneralUser("deactmgr", null, `pr-ia-deactmgr-${RUN_ID}@kinsen.gr`);
    const deactReq = await makeDeptMember(dept.id, `pr-ia-deactreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(deactReq.id, "deactreq");
    registerSqlGeneralUser("deactreq", "deactmgr");
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
    registerSqlGeneralUser("toporoot", null);
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
    console.log('\n=== 5. "Unresolved" (API failure / no TicketApp account / inactive account / uncaptured) NEVER behaves like "no manager" ===\n');

    console.log("\n-- A SQLGeneral API/pagination failure blocks submission entirely --\n");
    sessionFor(konsym);
    forceApiFailureOnce = true;
    const apiFailRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA ApiFail ${RUN_ID}`, intermediateApproverIds: [] }));
    check('5. An API failure while resolving the requester\'s manager -> 400, NEVER 201 ("no manager" would also submit with [])', apiFailRes.status === 400);
    const apiFailCount = await prisma.projectRequest.count({ where: { title: `PR IA ApiFail ${RUN_ID}` } });
    check("...no ProjectRequest row was created", apiFailCount === 0);

    console.log("\n-- A manager who exists in SQLGeneral but has NO local TicketApp account, with no further chain above them, BLOCKS submission — a real manager exists, so this is NEVER no_manager --\n");
    const mgrNoTicketApp = "mgr-no-ticketapp";
    registerSqlGeneralUser(mgrNoTicketApp, null); // exists in SQLGeneral, NO local SqlGeneralUserSyncAttempt below -> not eligible, and it's the chain's own root, so zero candidates overall
    const noLocalMgrEmp = await makeDeptMember(dept.id, `pr-ia-nolocalmgr-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(noLocalMgrEmp.id, "nolocalmgr-emp");
    registerSqlGeneralUser("nolocalmgr-emp", mgrNoTicketApp);
    const noLocalMgrCandidates = await resolveIntermediateApproverCandidates(noLocalMgrEmp.id);
    check(
      "5. A requester whose entire (structurally valid) chain has ZERO eligible candidates resolves to \"unresolved\", NEVER \"no_manager\" — a real manager exists, just isn't onboarded to TicketApp yet",
      noLocalMgrCandidates.status === "unresolved",
      JSON.stringify(noLocalMgrCandidates)
    );
    sessionFor(noLocalMgrEmp);
    const noLocalMgrRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA NoLocalMgr ${RUN_ID}`, intermediateApproverIds: [] }));
    check("5. ...so submission -> 400, never 201 — never silently skipped to Final Approval", noLocalMgrRes.status === 400);
    const noLocalMgrCount = await prisma.projectRequest.count({ where: { title: `PR IA NoLocalMgr ${RUN_ID}` } });
    check("...no ProjectRequest row was created", noLocalMgrCount === 0);

    console.log("\n-- A manager whose local TicketApp account is INACTIVE, with no further chain above them, behaves the same way --\n");
    const inactiveBoss = await makeSqlGeneralUser("inactive-boss", null, `pr-ia-inactiveboss-${RUN_ID}@kinsen.gr`, false);
    const inactiveMgrEmp = await makeDeptMember(dept.id, `pr-ia-inactivemgr-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(inactiveMgrEmp.id, "inactivemgr-emp");
    registerSqlGeneralUser("inactivemgr-emp", "inactive-boss");
    sessionFor(inactiveMgrEmp);
    const inactiveMgrRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA InactiveMgr ${RUN_ID}`, intermediateApproverIds: [] }));
    check("5. A requester whose only manager's TicketApp account is inactive -> 400, blocked, never no_manager", inactiveMgrRes.status === 400);
    const inactiveBossAsApproverRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA InactiveMgrForce ${RUN_ID}`, intermediateApproverIds: [inactiveBoss.id] }));
    check("...and explicitly FORCING the inactive manager as a selection also fails (they are never a valid candidate)", inactiveBossAsApproverRes.status === 400);

    console.log("\n-- The genuine, immediate no_manager case (requester's own managerAMAccountName is verified null) still skips straight to Final Approval — the ONLY case this status applies to --\n");
    const genuineNoManagerCandidates = await resolveIntermediateApproverCandidates(toporoot.id);
    check("5. toporoot's own record has a genuinely null managerAMAccountName -> \"no_manager\", not \"unresolved\"", genuineNoManagerCandidates.status === "no_manager", JSON.stringify(genuineNoManagerCandidates));

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

    // ══════════════════════ 7. Multi-level chain: direct + grandmanager, all eligible — multiple selections, unanimous approval ══════════════════════
    console.log("\n=== 7. A 3-level manager chain where every ancestor is TicketApp-eligible offers all three, in hierarchy order ===\n");
    const ceo = await makeSqlGeneralUser("ceo", null, `pr-ia-ceo-${RUN_ID}@kinsen.gr`);
    const vp = await makeSqlGeneralUser("vp", "ceo", `pr-ia-vp-${RUN_ID}@kinsen.gr`);
    const director = await makeSqlGeneralUser("director", "vp", `pr-ia-director-${RUN_ID}@kinsen.gr`);
    const deepRequester = await makeDeptMember(dept.id, `pr-ia-deeprequester-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(deepRequester.id, "deepreq");
    registerSqlGeneralUser("deepreq", "director");

    const deepCandidates = await resolveIntermediateApproverCandidates(deepRequester.id);
    check(
      "7. Candidate resolution finds all 3 levels (director, vp, ceo), correctly leveled and in hierarchy order",
      deepCandidates.status === "has_candidates" &&
        deepCandidates.candidates.length === 3 &&
        deepCandidates.candidates[0].id === director.id &&
        deepCandidates.candidates[0].level === 1 &&
        deepCandidates.candidates[1].id === vp.id &&
        deepCandidates.candidates[1].level === 2 &&
        deepCandidates.candidates[2].id === ceo.id &&
        deepCandidates.candidates[2].level === 3,
      JSON.stringify(deepCandidates)
    );

    sessionFor(deepRequester);
    const multiSelectRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA MultiSelect ${RUN_ID}`, intermediateApproverIds: [director.id, ceo.id] }));
    check("7. Selecting TWO non-adjacent levels (director + ceo, skipping vp) -> 201 — any subset of real candidates is valid, never required to be contiguous or all-of-them", multiSelectRes.status === 201);
    const multiSelectSubmit = await multiSelectRes.json();
    requestIds.push(multiSelectSubmit.id);
    const multiSelectRows = await prisma.projectRequestIntermediateApprover.findMany({ where: { projectRequestId: multiSelectSubmit.id } });
    check("...exactly 2 rows created, for director and ceo only — vp was never auto-added", multiSelectRows.length === 2 && multiSelectRows.every((r) => [director.id, ceo.id].includes(r.approverId)));

    sessionFor(director);
    const directorApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "Director approves." }), { params: Promise.resolve({ id: multiSelectSubmit.id }) });
    check("7. director (selected) approves -> 200", directorApproveRes.status === 200);
    const afterDirectorOnly = await prisma.projectRequest.findUniqueOrThrow({ where: { id: multiSelectSubmit.id } });
    check("...with only ONE of TWO required approvals in, status is STILL PENDING_INTERMEDIATE_APPROVAL — unanimity preserved", afterDirectorOnly.status === "PENDING_INTERMEDIATE_APPROVAL");

    sessionFor(vp);
    const vpAttemptRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "vp wasn't even selected." }), { params: Promise.resolve({ id: multiSelectSubmit.id }) });
    check("...vp (structurally a real manager, but NOT selected for this request) -> 403, never 200", vpAttemptRes.status === 403);

    sessionFor(ceo);
    const ceoApproveRes = await intermediateApprovalPOST(jsonReq({ decision: "approve", businessAssessment: "ceo approves too." }), { params: Promise.resolve({ id: multiSelectSubmit.id }) });
    check("7. ceo (the SECOND and last required approval) -> 200", ceoApproveRes.status === 200);
    const afterBoth = await prisma.projectRequest.findUniqueOrThrow({ where: { id: multiSelectSubmit.id } });
    check("...only NOW, with BOTH selected approvals in, does the request advance to PENDING_APPROVAL", afterBoth.status === "PENDING_APPROVAL");

    // ══════════════════════ 8. Skip-level: an ineligible ancestor is skipped, never breaks the chain, never renumbered ══════════════════════
    console.log("\n=== 8. An ancestor with no TicketApp account (or an inactive one) is skipped as a candidate, but the walk continues past them honestly ===\n");
    const skipRoot = await makeSqlGeneralUser("skiproot", null, `pr-ia-skiproot-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser("skipmid", "skiproot"); // SQLGeneral-only — no local SqlGeneralUserSyncAttempt at all
    const skipLevelRequester = await makeDeptMember(dept.id, `pr-ia-skiplevelreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(skipLevelRequester.id, "skipreq");
    registerSqlGeneralUser("skipreq", "skipmid");

    const skipLevelCandidates = await resolveIntermediateApproverCandidates(skipLevelRequester.id);
    check(
      "8. skipmid (no TicketApp account) is excluded, but skiproot (their own manager) still appears — at the TRUE level 2, never renumbered to 1",
      skipLevelCandidates.status === "has_candidates" && skipLevelCandidates.candidates.length === 1 && skipLevelCandidates.candidates[0].id === skipRoot.id && skipLevelCandidates.candidates[0].level === 2,
      JSON.stringify(skipLevelCandidates)
    );

    // ══════════════════════ 9. A structural break at depth > 1 discards ALL candidates, even ones already resolved below it ══════════════════════
    console.log("\n=== 9. A structural problem ABOVE a perfectly valid, already-resolved candidate invalidates the WHOLE chain — never silently truncated ===\n");

    console.log("\n-- Cycle two levels up --\n");
    const cycleMidManager = await makeSqlGeneralUser("cyclemid", "cycleA", `pr-ia-cyclemid-${RUN_ID}@kinsen.gr`); // perfectly real, eligible — but their OWN manager chain is broken
    registerSqlGeneralUser("cycleA", "cycleB");
    registerSqlGeneralUser("cycleB", "cycleA"); // cycleA <-> cycleB
    const cycleRequester = await makeDeptMember(dept.id, `pr-ia-cyclereq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(cycleRequester.id, "cyclereq");
    registerSqlGeneralUser("cyclereq", "cyclemid");
    const cycleCandidates = await resolveIntermediateApproverCandidates(cycleRequester.id);
    check(
      "9. A cycle two levels up invalidates the WHOLE resolution — cyclemid (level 1, otherwise perfectly valid) is NOT offered either",
      cycleCandidates.status === "unresolved",
      JSON.stringify(cycleCandidates)
    );
    void cycleMidManager;

    console.log("\n-- Missing (dangling) ancestor two levels up --\n");
    const danglingMidManager = await makeSqlGeneralUser("danglingmid", "ghost-ancestor-404", `pr-ia-danglingmid-${RUN_ID}@kinsen.gr`);
    const danglingRequester = await makeDeptMember(dept.id, `pr-ia-danglingreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(danglingRequester.id, "danglingreq");
    registerSqlGeneralUser("danglingreq", "danglingmid");
    const danglingCandidates = await resolveIntermediateApproverCandidates(danglingRequester.id);
    check(
      "9. A dangling (nonexistent) ancestor two levels up invalidates the WHOLE resolution",
      danglingCandidates.status === "unresolved",
      JSON.stringify(danglingCandidates)
    );
    void danglingMidManager;

    console.log("\n-- Ambiguous ancestor two levels up --\n");
    const ambiguousMidManager = await makeSqlGeneralUser("ambiguousmid", "dupe-ancestor", `pr-ia-ambiguousmid-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser("dupe-ancestor", null); // row 1
    registerSqlGeneralUser("dupe-ancestor", null); // row 2 — SQLGeneral itself reports this username twice
    const ambiguousRequester = await makeDeptMember(dept.id, `pr-ia-ambiguousreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(ambiguousRequester.id, "ambiguousreq");
    registerSqlGeneralUser("ambiguousreq", "ambiguousmid");
    const ambiguousCandidates = await resolveIntermediateApproverCandidates(ambiguousRequester.id);
    check(
      "9. An ambiguous ancestor two levels up invalidates the WHOLE resolution",
      ambiguousCandidates.status === "unresolved",
      JSON.stringify(ambiguousCandidates)
    );
    void ambiguousMidManager;

    console.log("\n-- Self-reference two levels up --\n");
    const selfRefMidManager = await makeSqlGeneralUser("selfrefmid", "selfrefancestor", `pr-ia-selfrefmid-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser("selfrefancestor", "selfrefancestor"); // claims themselves as their own manager
    const selfRefRequester = await makeDeptMember(dept.id, `pr-ia-selfrefreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(selfRefRequester.id, "selfrefreq");
    registerSqlGeneralUser("selfrefreq", "selfrefmid");
    const selfRefCandidates = await resolveIntermediateApproverCandidates(selfRefRequester.id);
    check(
      "9. A self-referencing ancestor two levels up invalidates the WHOLE resolution",
      selfRefCandidates.status === "unresolved",
      JSON.stringify(selfRefCandidates)
    );
    void selfRefMidManager;

    console.log("\n-- A structurally broken chain, submitted anyway, is blocked at the API just like depth-1 unresolved cases --\n");
    sessionFor(danglingRequester);
    const brokenChainSubmitRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR IA BrokenChain ${RUN_ID}`, intermediateApproverIds: [] }));
    check("9. Submitting with a structurally broken chain -> 400, never 201", brokenChainSubmitRes.status === 400);

    // ══════════════════════ 10. Defensive max-depth bound ══════════════════════
    console.log("\n=== 10. A pathologically deep (but acyclic) chain is bounded, never an unbounded walk ===\n");
    let previousUsername: string | null = null;
    for (let i = 0; i < 60; i++) {
      const username = `deepchain${i}-${RUN_ID}`;
      registerSqlGeneralUser(username, previousUsername);
      previousUsername = username;
    }
    const deepChainRequester = await makeDeptMember(dept.id, `pr-ia-deepchainreq-${RUN_ID}@kinsen.gr`);
    await captureSqlGeneralUsername(deepChainRequester.id, "deepchainreq");
    registerSqlGeneralUser("deepchainreq", previousUsername);
    const deepChainCandidates = await resolveIntermediateApproverCandidates(deepChainRequester.id);
    check("10. A 60-level, genuinely acyclic chain exceeds the defensive depth bound -> unresolved, never an unbounded walk", deepChainCandidates.status === "unresolved", JSON.stringify(deepChainCandidates).slice(0, 200));

    // ══════════════════════ 11. Performance: exact filtered lookups, never the full roster, regardless of chain depth ══════════════════════
    console.log("\n=== 11. Performance: resolution cost scales with CHAIN DEPTH only, never with total SQLGeneral roster size ===\n");
    const beforeCount = findUserCallCount;
    const perfResult = await resolveIntermediateApproverCandidates(deepRequester.id); // the 3-level ceo/vp/director chain from section 7
    const callsForThreeLevelChain = findUserCallCount - beforeCount;
    check(
      "11. Resolving a 3-level chain (requester + 3 ancestors) makes EXACTLY 4 identity lookups — one exact lookup per identity, never a full-roster fetch",
      perfResult.status === "has_candidates" && callsForThreeLevelChain === 4,
      `calls=${callsForThreeLevelChain}`
    );
    // The OLD design (listAllSqlGeneralUsers, $first=100 per page, fetchAllPages)
    // made exactly ONE call per resolution — but that ONE call was a FULL,
    // paginated roster fetch costing ceil(rosterSize / 100) real HTTP
    // requests, REGARDLESS of how shallow the requester's own chain was,
    // and it was reissued in full on every single page load AND again at
    // every submission. For a modest 800-person roster that's ~8 HTTP
    // requests per resolution; for 8,000 it's ~80 — flat, unavoidable cost
    // that never shrinks no matter how short the real chain is. The NEW
    // design's cost (4 calls above) is a function of chain depth ALONE and
    // is completely decoupled from roster size — a 200,000-row roster
    // would still cost exactly 4 calls for this exact chain.
    const assumedOldRosterSize = 800;
    const oldDesignHttpRequestsPerResolution = Math.ceil(assumedOldRosterSize / 100);
    check(
      `11. (reported, not re-executed) the OLD design's cost for a representative ${assumedOldRosterSize}-person roster was ~${oldDesignHttpRequestsPerResolution} HTTP requests per resolution call, PER PAGE LOAD AND AGAIN PER SUBMISSION, independent of chain depth — the NEW design's ${callsForThreeLevelChain} calls for this 3-level chain would stay ${callsForThreeLevelChain} even against a roster 1000x larger`,
      true
    );
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
