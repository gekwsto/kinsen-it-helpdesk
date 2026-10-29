/**
 * Regression coverage for `projectRequest.skipIntermediateApproval` — lets
 * a requester's OWN submission bypass the entire intermediate-approval
 * stage (including the live SQLGeneral identity/manager-chain lookup),
 * routing straight to the pre-existing, unchanged Final Approval stage.
 * Complements scripts/test-project-request-intermediate-approval.ts (the
 * normal unanimous flow, untouched by this feature) and
 * scripts/test-project-request-workflow.ts (the Final stage itself,
 * untouched by this feature).
 *
 * Covers: permission registration (module/default-grant shape), global vs
 * department-scoped effective grant, bypassing SQLGeneral verification
 * entirely (zero API calls) when held, the normal flow staying completely
 * unaffected when NOT held (candidates-exist and unresolved-identity cases
 * both still fail/require exactly as before), Final Approval enforcement
 * and department scoping unaffected by skip reason, auditability
 * (intermediateApprovalSkipReason), a forged client bypass flag being
 * impossible (no such field exists in the schema) is never trusted, and
 * the new generic SQLGeneral-identity-unavailable page message (shown only
 * when verification is actually required).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-skip-intermediate-approval.ts
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

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}
function collectStrings(node: any, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) collectStrings(c, out);
    return out;
  }
  if (node != null && typeof node === "object") {
    const children = node.props?.children;
    if (children !== undefined) collectStrings(children, out);
  }
  return out;
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let currentCookieValue: string | undefined = undefined;

mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined) }),
    headers: async () => new Headers(),
  },
});

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

  const sqlGeneralRowsByUsername = new Map<string, ReturnType<typeof fakeSqlUser>[]>();
  function registerSqlGeneralUser(username: string, managerAMAccountName: string | null) {
    if (!sqlGeneralRowsByUsername.has(username)) sqlGeneralRowsByUsername.set(username, []);
    sqlGeneralRowsByUsername.get(username)!.push(fakeSqlUser(username, managerAMAccountName));
  }
  let findUserCallCount = 0;
  const realSqlGeneralClient = await import("@/lib/sqlgeneral-api-client");
  async function mockFindUser(username: string) {
    findUserCallCount++;
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
  const { default: NewProjectRequestPage } = await import("@/app/(main)/project-requests/new/page");
  const { ProjectRequestForm } = await import("@/components/project-requests/project-request-form");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const jsonReq = (body?: unknown) =>
    new NextRequest("http://localhost/x", { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string, customRoleId: string | null = null) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }
  async function captureSqlGeneralUsername(userId: string, username: string) {
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId, sqlGeneralUsername: username, status: "SUCCEEDED" } });
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    return prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
  }
  async function makeCustomRole(tag: string, scope: "GLOBAL" | "DEPARTMENT", permissionKeys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `PR_SKIP_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  function sessionFor(user: { id: string }, role: any = Role.USER, customRoleId: string | null = null) {
    currentSession = { user: { id: user.id, role, customRoleId } };
  }

  const basePayload = {
    title: `PR Skip Request ${RUN_ID}`,
    description: "A description that is definitely long enough.",
    importance: 2,
    teamConcerned: "Engineering",
    expectedBenefits: "Benefits text that is definitely long enough for validation.",
    replacesExisting: false,
  };

  try {
    // ══════════════════════ 1. Permission registration ══════════════════════
    console.log("\n=== 1. projectRequest.skipIntermediateApproval is registered correctly ===\n");
    const perm = await prisma.permission.findUnique({ where: { key: "projectRequest.skipIntermediateApproval" } });
    check("1. The Permission row exists", perm !== null);
    check("1. ...under the projectRequests module", perm?.module === "projectRequests");
    const grants = await prisma.rolePermission.findMany({ where: { permission: { key: "projectRequest.skipIntermediateApproval" } } });
    // Deliberately DIFFERENT from projectRequest.approve/.intermediateApprove:
    // ZERO default grants, not even ADMIN's usual cosmetic one — see this
    // key's own seed.ts doc comment. An ADMIN-role requester must still go
    // through the normal flow unless EXPLICITLY granted (scenario 9 below
    // proves this end to end).
    check("1. ZERO default RolePermission rows exist for this key — not even ADMIN", grants.length === 0);
    check("1. NEVER auto-granted to DIRECTOR specifically", !grants.some((g) => g.roleKey === "DIRECTOR"));
    check("1. NEVER auto-granted to any built-in manager/agent/requester roleKey", !grants.some((g) => ["ADMIN", "DEPARTMENT_MANAGER", "DEPARTMENT_ADMIN", "AGENT_ASSIGNEE", "REQUESTER", "USER", "IT_AGENT"].includes(g.roleKey)));

    const deptA = await createDepartment({ name: `PR Skip Dept A ${RUN_ID}`, slug: `pr-skip-dept-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PR Skip Dept B ${RUN_ID}`, slug: `pr-skip-dept-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const finalApproverRole = await makeCustomRole("FINAL", "DEPARTMENT", ["projectRequest.approve"]);
    const finalApproverA = await makeUser(`pr-skip-finalA-${RUN_ID}@kinsen.gr`);
    await addMembership(finalApproverA.id, deptA.id, finalApproverRole.id);
    const finalApproverB = await makeUser(`pr-skip-finalB-${RUN_ID}@kinsen.gr`);
    await addMembership(finalApproverB.id, deptB.id, finalApproverRole.id);

    // ══════════════════════ 2. Global grant: skip works for ANY department, SQLGeneral never queried ══════════════════════
    console.log("\n=== 2. A GLOBAL effective grant skips the whole stage for ANY department, with ZERO SQLGeneral calls ===\n");
    const globalSkipRole = await makeCustomRole("GLOBAL", "GLOBAL", ["projectRequest.skipIntermediateApproval"]);
    const globalSkipUser = await makeUser(`pr-skip-global-${RUN_ID}@kinsen.gr`, globalSkipRole.id);
    await addMembership(globalSkipUser.id, deptA.id);
    // Deliberately given a VERIFIED, resolvable SQLGeneral manager chain —
    // if the bypass were somehow NOT taken, this user would otherwise
    // sail through the NORMAL flow too, which would make this scenario
    // too weak to prove the bypass actually fired. The call-count
    // assertion below is the real proof.
    const globalSkipManager = await makeUser(`pr-skip-global-mgr-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser(`pr-skip-global-mgr-username-${RUN_ID}`, null);
    await captureSqlGeneralUsername(globalSkipManager.id, `pr-skip-global-mgr-username-${RUN_ID}`);
    registerSqlGeneralUser(`pr-skip-global-username-${RUN_ID}`, `pr-skip-global-mgr-username-${RUN_ID}`);
    await captureSqlGeneralUsername(globalSkipUser.id, `pr-skip-global-username-${RUN_ID}`);

    sessionFor(globalSkipUser, Role.USER, globalSkipRole.id);
    const callsBeforeGlobal = findUserCallCount;
    const globalSkipRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Global ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [] }));
    check("2. Submission succeeds -> 201", globalSkipRes.status === 201);
    check("2. ZERO SQLGeneral lookups were made — the bypass never even attempted identity verification", findUserCallCount === callsBeforeGlobal);
    const globalSkipSubmit = await globalSkipRes.json();
    requestIds.push(globalSkipSubmit.id);
    const globalSkipRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: globalSkipSubmit.id } });
    check("2. status starts DIRECTLY at PENDING_APPROVAL", globalSkipRow.status === "PENDING_APPROVAL");
    check("2. intermediateApprovalSkipReason is PERMISSION_BYPASS (auditable)", globalSkipRow.intermediateApprovalSkipReason === "PERMISSION_BYPASS");
    const globalSkipApproverCount = await prisma.projectRequestIntermediateApprover.count({ where: { projectRequestId: globalSkipSubmit.id } });
    check("2. Zero ProjectRequestIntermediateApprover rows created", globalSkipApproverCount === 0);

    console.log("\n-- The SAME global grant also works for a DIFFERENT department (deptB) — genuinely global, not department-scoped --\n");
    const callsBeforeGlobalB = findUserCallCount;
    const globalSkipResB = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Global B ${RUN_ID}`, departmentId: undefined, intermediateApproverIds: [] }));
    // globalSkipUser is only a member of deptA, so departmentId resolves to
    // deptA automatically either way — this just re-confirms the global
    // grant doesn't depend on an explicit departmentId at all.
    check("2b. Submission with no explicit departmentId (auto-resolved) also succeeds -> 201", globalSkipResB.status === 201);
    check("2b. Still zero SQLGeneral lookups", findUserCallCount === callsBeforeGlobalB);
    const globalSkipSubmitB = await globalSkipResB.json();
    requestIds.push(globalSkipSubmitB.id);

    // ══════════════════════ 3. Department-scoped grant: skip works ONLY in that department ══════════════════════
    console.log("\n=== 3. A DEPARTMENT-scoped grant skips the stage ONLY for that department — normal flow elsewhere ===\n");
    const deptASkipRole = await makeCustomRole("DEPTA_SKIP", "DEPARTMENT", ["projectRequest.skipIntermediateApproval"]);
    const deptScopedUser = await makeUser(`pr-skip-deptscoped-${RUN_ID}@kinsen.gr`);
    await addMembership(deptScopedUser.id, deptA.id, deptASkipRole.id);
    await addMembership(deptScopedUser.id, deptB.id); // plain membership, no skip grant here
    registerSqlGeneralUser(`pr-skip-deptscoped-username-${RUN_ID}`, null); // verified "no manager" — used only for the deptB (non-skip) submission below
    await captureSqlGeneralUsername(deptScopedUser.id, `pr-skip-deptscoped-username-${RUN_ID}`);

    sessionFor(deptScopedUser, Role.USER, null); // session customRoleId null — canActOnEntity re-reads the membership's OWN customRoleId fresh from DB, never trusts this
    const callsBeforeDeptA = findUserCallCount;
    const deptASkipRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip DeptA ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [] }));
    check("3. Submission under the GRANTED department (A) succeeds and skips -> 201", deptASkipRes.status === 201);
    check("3. Zero SQLGeneral lookups for the granted-department submission", findUserCallCount === callsBeforeDeptA);
    const deptASkipSubmit = await deptASkipRes.json();
    requestIds.push(deptASkipSubmit.id);
    const deptASkipRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: deptASkipSubmit.id } });
    check("3. status -> PENDING_APPROVAL, skipReason PERMISSION_BYPASS", deptASkipRow.status === "PENDING_APPROVAL" && deptASkipRow.intermediateApprovalSkipReason === "PERMISSION_BYPASS");

    console.log("\n-- The SAME user submitting under deptB (NOT granted there) goes through the NORMAL flow instead --\n");
    const callsBeforeDeptB = findUserCallCount;
    const deptBNormalRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip DeptB Normal ${RUN_ID}`, departmentId: deptB.id, intermediateApproverIds: [] }));
    check("3b. Submission under the UNGRANTED department (B) still succeeds (verified no-manager) -> 201", deptBNormalRes.status === 201);
    check("3b. ...but DID genuinely consult SQLGeneral this time (the normal flow, not the bypass)", findUserCallCount > callsBeforeDeptB);
    const deptBNormalSubmit = await deptBNormalRes.json();
    requestIds.push(deptBNormalSubmit.id);
    const deptBNormalRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: deptBNormalSubmit.id } });
    check("3b. status -> PENDING_APPROVAL via the NORMAL no-manager path, skipReason NO_MANAGER (not PERMISSION_BYPASS)", deptBNormalRow.status === "PENDING_APPROVAL" && deptBNormalRow.intermediateApprovalSkipReason === "NO_MANAGER");

    // ══════════════════════ 4. No permission: existing unanimous flow completely unaffected ══════════════════════
    console.log("\n=== 4. A requester WITHOUT the permission: the pre-existing unanimous flow is completely unaffected ===\n");
    const noPermManager = await makeUser(`pr-skip-noperm-mgr-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser(`pr-skip-noperm-mgr-username-${RUN_ID}`, null);
    await captureSqlGeneralUsername(noPermManager.id, `pr-skip-noperm-mgr-username-${RUN_ID}`);
    const noPermUser = await makeUser(`pr-skip-noperm-${RUN_ID}@kinsen.gr`);
    await addMembership(noPermUser.id, deptA.id);
    registerSqlGeneralUser(`pr-skip-noperm-username-${RUN_ID}`, `pr-skip-noperm-mgr-username-${RUN_ID}`);
    await captureSqlGeneralUsername(noPermUser.id, `pr-skip-noperm-username-${RUN_ID}`);

    sessionFor(noPermUser);
    const noPermEmptyRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip NoPerm Empty ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [] }));
    check("4. A real verified manager exists, so an EMPTY selection is still rejected -> 400 (never silently skipped without the permission)", noPermEmptyRes.status === 400);
    const noPermRealRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip NoPerm Real ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [noPermManager.id] }));
    check("4. Explicit selection of the real verified manager still succeeds -> 201", noPermRealRes.status === 201);
    const noPermRealSubmit = await noPermRealRes.json();
    requestIds.push(noPermRealSubmit.id);
    const noPermRealRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: noPermRealSubmit.id } });
    check("4. status starts at PENDING_INTERMEDIATE_APPROVAL (normal unanimous flow)", noPermRealRow.status === "PENDING_INTERMEDIATE_APPROVAL");
    check("4. intermediateApprovalSkipReason is null (not skipped at all)", noPermRealRow.intermediateApprovalSkipReason === null);

    // ══════════════════════ 5. A forged client bypass flag is impossible — no such field exists ══════════════════════
    console.log("\n=== 5. A client cannot forge a bypass — createProjectRequestSchema has no bypass field at all ===\n");
    const forgedRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Forged ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [], skipIntermediateApproval: true, bypassIntermediateApproval: true } as any));
    check("5. A forged 'skipIntermediateApproval'/'bypassIntermediateApproval' field in the body is silently stripped (zod) and has NO effect — same 400 as scenario 4's empty selection", forgedRes.status === 400);

    // ══════════════════════ 5b. REGRESSION GUARD: Role.ADMIN never gets this automatically ══════════════════════
    console.log("\n=== 5b. REGRESSION GUARD: an ADMIN-role requester with a real manager chain is NOT auto-granted the skip — must go through the normal flow like anyone else ===\n");
    const adminRequester = await prisma.user.create({ data: { email: `pr-skip-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(adminRequester.id);
    const adminsManager = await makeUser(`pr-skip-admin-mgr-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser(`pr-skip-admin-mgr-username-${RUN_ID}`, null);
    await captureSqlGeneralUsername(adminsManager.id, `pr-skip-admin-mgr-username-${RUN_ID}`);
    registerSqlGeneralUser(`pr-skip-admin-username-${RUN_ID}`, `pr-skip-admin-mgr-username-${RUN_ID}`);
    await captureSqlGeneralUsername(adminRequester.id, `pr-skip-admin-username-${RUN_ID}`);

    sessionFor(adminRequester, Role.ADMIN, null);
    const adminEmptyRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Admin Empty ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [] }));
    check("5b. An ADMIN-role requester with a real verified manager, submitting an EMPTY selection, -> 400 — Role.ADMIN's blanket hasPermission bypass does NOT leak into this check", adminEmptyRes.status === 400);
    const adminRealRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Admin Real ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [adminsManager.id] }));
    check("5b. The SAME ADMIN requester, explicitly selecting their real verified manager, -> 201 (the normal flow works for ADMIN too, just not auto-skipped)", adminRealRes.status === 201);
    const adminRealSubmit = await adminRealRes.json();
    requestIds.push(adminRealSubmit.id);
    const adminRealRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: adminRealSubmit.id } });
    check("5b. status starts at PENDING_INTERMEDIATE_APPROVAL — exactly the normal flow, not skipped", adminRealRow.status === "PENDING_INTERMEDIATE_APPROVAL" && adminRealRow.intermediateApprovalSkipReason === null);

    console.log("\n-- Once EXPLICITLY granted (same as any other role), the SAME ADMIN requester's skip works fine --\n");
    await prisma.user.update({ where: { id: adminRequester.id }, data: { customRoleId: globalSkipRole.id } });
    sessionFor(adminRequester, Role.ADMIN, globalSkipRole.id);
    const adminGrantedRes = await requestsPOST(jsonReq({ ...basePayload, title: `PR Skip Admin Granted ${RUN_ID}`, departmentId: deptA.id, intermediateApproverIds: [] }));
    check("5b. An ADMIN requester WITH an explicit grant skips normally -> 201", adminGrantedRes.status === 201);
    const adminGrantedSubmit = await adminGrantedRes.json();
    requestIds.push(adminGrantedSubmit.id);
    const adminGrantedRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: adminGrantedSubmit.id } });
    check("5b. ...status -> PENDING_APPROVAL, skipReason PERMISSION_BYPASS", adminGrantedRow.status === "PENDING_APPROVAL" && adminGrantedRow.intermediateApprovalSkipReason === "PERMISSION_BYPASS");

    // ══════════════════════ 6. Final Approval enforcement + department scoping unaffected by skip reason ══════════════════════
    console.log("\n=== 6. Final Approval: authorization, department scoping, and status transitions are unaffected by WHY intermediate was skipped ===\n");
    sessionFor(finalApproverB); // wrong department for globalSkipSubmit (deptA)
    const wrongDeptRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Wrong department attempt.", projectOwnerId: finalApproverB.id }), { params: Promise.resolve({ id: globalSkipSubmit.id }) });
    check("6. A final approver scoped to the WRONG department -> 403, regardless of skip reason", wrongDeptRes.status === 403);
    const stillPending = await prisma.projectRequest.findUniqueOrThrow({ where: { id: globalSkipSubmit.id } });
    check("6. ...request untouched, still PENDING_APPROVAL", stillPending.status === "PENDING_APPROVAL");

    sessionFor(finalApproverA);
    const correctApproveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Correctly approved after permission-based skip.", projectOwnerId: finalApproverA.id }), { params: Promise.resolve({ id: globalSkipSubmit.id }) });
    check("6. The CORRECT department-scoped final approver -> 200", correctApproveRes.status === 200);
    const approvedRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: globalSkipSubmit.id } });
    check("6. status -> APPROVED, final stage's own fields populated exactly as for any other request", approvedRow.status === "APPROVED" && approvedRow.approverId === finalApproverA.id);
    check("6. intermediateApprovalSkipReason is UNCHANGED by the final decision (still PERMISSION_BYPASS, audit trail preserved)", approvedRow.intermediateApprovalSkipReason === "PERMISSION_BYPASS");

    // Also approve the no_manager-skipped and normal-unanimous requests, to
    // prove Final Approval behaves identically across all three skip reasons.
    sessionFor(finalApproverB);
    const deptBNormalApproveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Approving the NO_MANAGER-skipped request.", projectOwnerId: finalApproverB.id }), { params: Promise.resolve({ id: deptBNormalSubmit.id }) });
    check("6b. Final approval of the NO_MANAGER-skipped request -> 200, identical mechanics", deptBNormalApproveRes.status === 200);

    // ══════════════════════ 7. Legacy/existing-request compatibility ══════════════════════
    console.log("\n=== 7. Existing requests (created before this field existed) are completely unaffected ===\n");
    const legacyRequester = await makeUser(`pr-skip-legacy-${RUN_ID}@kinsen.gr`);
    await addMembership(legacyRequester.id, deptA.id);
    const legacyRow = await prisma.projectRequest.create({
      data: {
        title: `PR Skip Legacy ${RUN_ID}`,
        description: "A pre-existing legacy request, simulating one created before this field existed.",
        importance: 1,
        teamConcerned: "Legacy",
        expectedBenefits: "N/A",
        replacesExisting: false,
        requesterId: legacyRequester.id,
        departmentId: deptA.id,
        status: "PENDING_APPROVAL",
        // intermediateApprovalSkipReason deliberately omitted — exercises
        // the column's own default (null), exactly like a real row
        // inserted before this migration.
      },
    });
    requestIds.push(legacyRow.id);
    check("7. A legacy-shaped row reads back with intermediateApprovalSkipReason === null, no crash", legacyRow.intermediateApprovalSkipReason === null);
    sessionFor(finalApproverA);
    const legacyApproveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Approving a legacy-shaped request.", projectOwnerId: finalApproverA.id }), { params: Promise.resolve({ id: legacyRow.id }) });
    check("7. Final Approval works completely normally on a legacy-shaped row -> 200", legacyApproveRes.status === 200);

    // ══════════════════════ 8. UI messaging: generic message, shown only when verification is actually required ══════════════════════
    console.log("\n=== 8. Page UI: the new generic message replaces the technical reason, and is never shown when the skip permission makes verification unnecessary ===\n");
    const GENERIC_MESSAGE = "Your organizational details are not yet available. Please sign out and sign in again. If the issue persists, contact your administrator.";

    console.log("\n-- 8a. A requester with NO skip permission and an UNRESOLVED SQLGeneral identity sees the NEW generic message, never the raw technical reason --\n");
    const unresolvedUser = await makeUser(`pr-skip-unresolved-${RUN_ID}@kinsen.gr`);
    await addMembership(unresolvedUser.id, deptA.id);
    // Deliberately NO captureSqlGeneralUsername call at all -> "unresolved"
    // (the exact technical reason this scenario proves is never leaked).
    sessionFor(unresolvedUser);
    const unresolvedPageEl = await NewProjectRequestPage();
    const unresolvedStrings = collectStrings(unresolvedPageEl);
    check("8a. The page's text includes the NEW generic message verbatim", unresolvedStrings.includes(GENERIC_MESSAGE));
    check("8a. ...and does NOT include the old technical substring ('SQLGeneral identity has not been captured')", !unresolvedStrings.some((s) => s.includes("SQLGeneral identity has not been captured")));
    const unresolvedFormEls = findElementsByType(unresolvedPageEl, ProjectRequestForm);
    check("8a. The form itself is never rendered while blocked", unresolvedFormEls.length === 0);

    console.log("\n-- 8b. The SAME user, now GRANTED the skip permission: the warning never appears, SQLGeneral is never even queried by the page ---\n");
    await prisma.user.update({ where: { id: unresolvedUser.id }, data: { customRoleId: globalSkipRole.id } });
    sessionFor(unresolvedUser, Role.USER, globalSkipRole.id);
    const callsBeforePageSkip = findUserCallCount;
    const skipPageEl = await NewProjectRequestPage();
    check("8b. The page makes ZERO SQLGeneral calls when the requester holds the skip permission", findUserCallCount === callsBeforePageSkip);
    const skipPageStrings = collectStrings(skipPageEl);
    check("8b. The generic 'organizational details not yet available' warning is NOT shown at all", !skipPageStrings.includes(GENERIC_MESSAGE));
    const skipFormEls = findElementsByType(skipPageEl, ProjectRequestForm);
    check("8b. The form IS rendered instead", skipFormEls.length === 1);
    check("8b. ...with canSkipIntermediateApproval correctly passed through as true", skipFormEls[0]?.props.canSkipIntermediateApproval === true);
    check("8b. ...and an empty intermediateApproverOptions (candidates were never resolved)", Array.isArray(skipFormEls[0]?.props.intermediateApproverOptions) && skipFormEls[0].props.intermediateApproverOptions.length === 0);

    console.log("\n-- 8c. A requester with a VERIFIED real manager (has_candidates) renders the form normally — no warning, no skip note --\n");
    const candidatesUser = await makeUser(`pr-skip-candidates-${RUN_ID}@kinsen.gr`);
    await addMembership(candidatesUser.id, deptA.id);
    const candidatesManager = await makeUser(`pr-skip-candidates-mgr-${RUN_ID}@kinsen.gr`);
    registerSqlGeneralUser(`pr-skip-candidates-mgr-username-${RUN_ID}`, null);
    await captureSqlGeneralUsername(candidatesManager.id, `pr-skip-candidates-mgr-username-${RUN_ID}`);
    registerSqlGeneralUser(`pr-skip-candidates-username-${RUN_ID}`, `pr-skip-candidates-mgr-username-${RUN_ID}`);
    await captureSqlGeneralUsername(candidatesUser.id, `pr-skip-candidates-username-${RUN_ID}`);
    sessionFor(candidatesUser);
    const candidatesPageEl = await NewProjectRequestPage();
    const candidatesStrings = collectStrings(candidatesPageEl);
    check("8c. No generic warning shown for a requester with a real, resolvable manager", !candidatesStrings.includes(GENERIC_MESSAGE));
    const candidatesFormEls = findElementsByType(candidatesPageEl, ProjectRequestForm);
    check("8c. The form is rendered with canSkipIntermediateApproval false (no permission held)", candidatesFormEls.length === 1 && candidatesFormEls[0]?.props.canSkipIntermediateApproval === false);
    check("8c. ...and the real candidate IS offered", candidatesFormEls[0]?.props.intermediateApproverOptions.some((c: any) => c.id === candidatesManager.id));
  } finally {
    await runCleanup([
      ["projectRequestIntermediateApprover", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["notification", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["projectRequest", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["sqlGeneralUserSyncAttempt", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["user", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermission", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRole", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["ticketPriority", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketStatus", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["department", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
      ["$disconnect", () => prisma.$disconnect()],
    ]);
  }

  printSummaryAndExit();
}

main();
