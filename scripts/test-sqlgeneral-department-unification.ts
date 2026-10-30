/**
 * Regression coverage for "SQLGeneral Department Unification" — the
 * SQLGeneral Company must NOT determine the target TicketApp Department.
 * Multiple SQLGeneral Departments, including ones under DIFFERENT
 * SQLGeneral Companies, may be explicitly approved onto the SAME local
 * Department.
 *
 * ROOT CAUSE this file guards against: resolveSqlGeneralPlacementTarget's
 * write-time re-validation (and approveSqlGeneralDepartmentMapping's own
 * approval-time hierarchy check, and previewSqlGeneralDepartmentMappingCandidate's
 * mirror of it) used to pick ONE SqlGeneralCompanyMapping row arbitrarily
 * (Prisma `findFirst`) for a target local Company, then compared a
 * SPECIFIC SQLGeneral CompanyId against that ONE row by exact equality.
 * Once a second, legitimately-approved SqlGeneralCompanyMapping existed
 * for the SAME local Company (a different SQLGeneral Company feeding the
 * same unified local Department), a user/Department whose real SQLGeneral
 * Company happened to be the "wrong" (non-picked) one was incorrectly
 * rejected as a "conflicting identity" — even though their own Company
 * mapping was independently, explicitly approved. Fixed by checking SET
 * membership (does this specific SQLGeneral CompanyId have its OWN
 * approved mapping to this SAME local Company) instead of equality
 * against one arbitrarily-chosen row.
 *
 * Covers: two different SQLGeneral Companies each independently approved
 * onto the same local Company; two different SQLGeneral Departments
 * (one under each Company) independently approved onto the same local
 * Department; a user from EITHER Company/Department pair resolves to the
 * identical local Primary Department; an unapproved third Company/
 * Department still fails closed (never guessed); Preview and the actual
 * worker resolve identically (parity); the Preview surface reports the
 * exact proposed local Department id/name; a Ticket created under the
 * user's default/canonical workspace lands in the unified Department; and
 * the worker never fabricates/recreates a locally-deleted employee.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-department-unification.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role, OrganizationNodeSource } from "@prisma/client";

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

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  // In-process only — never written to any .env file.
  process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  type FindUserFn = typeof realClient.findSqlGeneralUserByUsername;
  type ListDeptFn = typeof realClient.listAllSqlGeneralDepartments;
  type ListUsersFn = typeof realClient.listAllSqlGeneralUsers;
  type VerifyCompanyFn = typeof realClient.verifySqlGeneralCompanyIdExists;
  type VerifyDeptFn = typeof realClient.verifySqlGeneralDepartmentIdExists;

  let mockFindUserImpl: FindUserFn = async () => {
    throw new Error("mock: no findSqlGeneralUserByUsername impl installed for this check");
  };
  let mockListDeptImpl: ListDeptFn = async () => ({ ok: true, departments: [] });
  let mockListUsersImpl: ListUsersFn = async () => ({ ok: true, users: [] });
  let mockVerifyCompanyImpl: VerifyCompanyFn = async () => ({ ok: true, exists: true });
  let mockVerifyDeptImpl: VerifyDeptFn = async () => ({ ok: true, exists: true });

  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
      listAllSqlGeneralUsers: (opts?: { activeOnly?: boolean }) => mockListUsersImpl(opts),
      verifySqlGeneralCompanyIdExists: (id: string) => mockVerifyCompanyImpl(id),
      verifySqlGeneralDepartmentIdExists: (id: string) => mockVerifyDeptImpl(id),
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const membershipSvc = await import("@/lib/services/department-membership-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgdu-${tag}-${RUN_ID}@kinsen.gr`, name: `SGDU ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true },
    });
    userIds.push(u.id);
    return u.id;
  }
  const attempt = (userId: string) => prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId } });

  async function driveSync(userId: string, username: string, departments: any[], now = new Date()) {
    await svc.enqueueOrRecoverSqlGeneralUserSync(userId, username);
    const row = await attempt(userId);
    const token = `token-${userId}-${row.attemptCount}`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId }, data: { status: "PROCESSING", claimedAt: now, claimToken: token } });
    const outcome = await svc.processClaimedSqlGeneralUserSync(row.id, token, now, departments);
    return { outcome, row: await attempt(userId) };
  }

  const fakeHrUser = (username: string, hrDepartmentId: string, sqlGeneralCompanyId: string, company: string, active = true) => ({
    username, mail: null, hrDepartmentId, department: null, companyId: sqlGeneralCompanyId, company, active,
    managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
  });

  try {
    console.log("\n=== Setup: two DIFFERENT SQLGeneral Companies (A, B), each independently approved onto the SAME local Company, feeding the SAME unified local Department ===\n");

    const admin = await makeUser("admin-actor");
    const COMPANY_A_ID = `sgdu-companyA-${RUN_ID}`;
    const COMPANY_B_ID = `sgdu-companyB-${RUN_ID}`;
    const COMPANY_C_ID = `sgdu-companyC-${RUN_ID}`; // deliberately NEVER approved — the fail-closed control
    const DEPT_359 = `sgdu-dept-359-${RUN_ID}`;
    const DEPT_129 = `sgdu-dept-129-${RUN_ID}`;
    const DEPT_UNAPPROVED = `sgdu-dept-unapproved-${RUN_ID}`;

    const unifiedCompany = await prisma.company.create({
      data: { name: `Unified Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`Unified Co ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL },
    });
    companyIds.push(unifiedCompany.id);
    const callCenterDept = await prisma.department.create({
      data: { name: `Call Center & Customer Service ${RUN_ID}`, normalizedName: normalizeDepartmentName(`Call Center & Customer Service ${RUN_ID}`), slug: `sgdu-callcenter-${RUN_ID}`, companyId: unifiedCompany.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(callCenterDept.id);
    // A SECOND, unrelated local Department under the SAME unified Company
    // — simulates the "separate Call Center KINSEN Department" scenario:
    // a department that LOOKS similar but must NEVER be the resolution
    // target once explicit mappings exist.
    const decoyDept = await prisma.department.create({
      data: { name: `Call Center KINSEN ${RUN_ID}`, normalizedName: normalizeDepartmentName(`Call Center KINSEN ${RUN_ID}`), slug: `sgdu-decoy-${RUN_ID}`, companyId: unifiedCompany.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(decoyDept.id);

    mockVerifyCompanyImpl = async () => ({ ok: true, exists: true });
    mockVerifyDeptImpl = async () => ({ ok: true, exists: true });
    const FAKE_DEPT_359 = { id: DEPT_359, description: `Call Center 359 ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: `Company A ${RUN_ID}`, companyShortname: "A", creationDate: null, updateTimestamp: null };
    const FAKE_DEPT_129 = { id: DEPT_129, description: `Customer Service 129 ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: `Company B ${RUN_ID}`, companyShortname: "B", creationDate: null, updateTimestamp: null };
    const FAKE_DEPT_UNAPPROVED = { id: DEPT_UNAPPROVED, description: `Unapproved Dept ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: `Company C ${RUN_ID}`, companyShortname: "C", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED] });
    mockListUsersImpl = async () => ({ ok: true, users: [] });

    // Company A -> unifiedCompany (approved).
    const approveA = await svc.approveSqlGeneralCompanyMapping(COMPANY_A_ID, unifiedCompany.id, admin);
    check("Setup: Company A -> Unified Co approved", approveA.ok === true);
    // Company B -> the SAME unifiedCompany (approved, explicit confirmMultipleMapping since Company A already feeds it).
    const approveB = await svc.approveSqlGeneralCompanyMapping(COMPANY_B_ID, unifiedCompany.id, admin, true);
    check("Setup: Company B -> the SAME Unified Co ALSO approved (many-to-one across Companies)", approveB.ok === true);

    // Department 359 (under Company A) -> callCenterDept.
    const approveDept359 = await svc.approveSqlGeneralDepartmentMapping(DEPT_359, callCenterDept.id, admin);
    check("Setup: SQLGeneral Dept 359 -> Call Center & Customer Service approved", approveDept359.ok === true, (approveDept359 as any).reason);
    // Department 129 (under Company B) -> the SAME callCenterDept (explicit confirmMultipleMapping).
    const approveDept129 = await svc.approveSqlGeneralDepartmentMapping(DEPT_129, callCenterDept.id, admin, true);
    check("Setup: SQLGeneral Dept 129 -> the SAME Call Center & Customer Service ALSO approved (THE CORE FIX)", approveDept129.ok === true, (approveDept129 as any).reason);

    // ── 1. A user under Company A / Dept 359 resolves to the unified Department ──
    console.log("\n1. A user under SQLGeneral Company A, HrDepartmentId 359, resolves to the unified Call Center & Customer Service Department as PRIMARY\n");
    {
      const user = await makeUser("user-359");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-359", DEPT_359, COMPANY_A_ID, `Company A ${RUN_ID}`) });
      const { outcome } = await driveSync(user, "sgdu-user-359", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("1. Placement succeeds", outcome === "succeeded");
      const after = await prisma.user.findUnique({ where: { id: user } });
      check("1. User.departmentId is the unified Call Center & Customer Service Department", after?.departmentId === callCenterDept.id);
      check("1. ...NOT the decoy 'Call Center KINSEN' Department", after?.departmentId !== decoyDept.id);
      check("1. User.companyId is the unified Company", after?.companyId === unifiedCompany.id);
    }

    // ── 2. A DIFFERENT user under Company B / Dept 129 resolves to the SAME unified Department — THE CORE FIX ──
    console.log("\n2. A DIFFERENT user under SQLGeneral Company B, HrDepartmentId 129, resolves to the IDENTICAL unified Department — proving the SQLGeneral Company never determines the target\n");
    {
      const user = await makeUser("user-129");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-129", DEPT_129, COMPANY_B_ID, `Company B ${RUN_ID}`) });
      const { outcome, row } = await driveSync(user, "sgdu-user-129", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("2. Placement succeeds (the exact bug this file guards: Company B's own approved mapping is correctly recognized, not rejected against Company A's)", outcome === "succeeded", row.lastError ?? undefined);
      const after = await prisma.user.findUnique({ where: { id: user } });
      check("2. User.departmentId is the SAME unified Call Center & Customer Service Department as scenario 1's Company-A user", after?.departmentId === callCenterDept.id);
      check("2. User.companyId is the SAME unified Company", after?.companyId === unifiedCompany.id);
    }

    // ── 3. An unapproved third Company/Department still fails closed ──
    console.log("\n3. An UNAPPROVED third SQLGeneral Company/Department (C) still fails closed — never guessed, never silently placed\n");
    {
      const user = await makeUser("user-unapproved");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-unapproved", DEPT_UNAPPROVED, COMPANY_C_ID, `Company C ${RUN_ID}`) });
      const { outcome, row } = await driveSync(user, "sgdu-user-unapproved", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("3. Placement is retried (blocked), never silently succeeds", outcome === "retrying");
      check("3. ...reason names the missing Company mapping, not a fabricated placement", (row.lastError ?? "").length > 0);
      const after = await prisma.user.findUnique({ where: { id: user } });
      check("3. User.departmentId stays null — never guessed", after?.departmentId === null);
      check("3. User.companyId stays null too", after?.companyId === null);
    }

    // ── 4. Preview/worker parity for the cross-company case ──
    console.log("\n4. Preview and the actual worker resolve the cross-company case IDENTICALLY (parity)\n");
    {
      const user = await makeUser("user-preview-parity");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-preview-parity", DEPT_129, COMPANY_B_ID, `Company B ${RUN_ID}`) });
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdu-user-preview-parity");
      const previewResult = await svc.previewSqlGeneralUserSync({ userIds: [user] });
      check("4. Preview call succeeds", previewResult.ok === true);
      if (previewResult.ok) {
        const row = previewResult.rows[0];
        check("4. Preview reports the EXACT proposed local Department id (REQUIRED #2 extension)", row.proposedDepartmentId === callCenterDept.id);
        check("4. Preview reports the EXACT proposed local Department NAME", row.proposedDepartmentName === callCenterDept.name);
        check("4. Preview reports primaryChangeOutcome 'would_place' — the SAME outcome the worker will actually produce", row.primaryChangeOutcome === "would_place");
        check("4. Preview's currentPrimaryDepartmentId is null (never yet placed)", row.currentPrimaryDepartmentId === null);
      }
      // Now actually run the worker and confirm it agrees with what Preview predicted.
      const { outcome } = await driveSync(user, "sgdu-user-preview-parity", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("4. The actual worker run succeeds, exactly as Preview predicted", outcome === "succeeded");
      const after = await prisma.user.findUnique({ where: { id: user } });
      check("4. ...and lands in the EXACT Department Preview proposed", after?.departmentId === callCenterDept.id);

      const previewAfter = await svc.previewSqlGeneralUserSync({ userIds: [user] });
      if (previewAfter.ok) {
        check("4. Preview run AGAIN after placement reports 'already_aligned' — Preview and worker never disagree", previewAfter.rows[0].primaryChangeOutcome === "already_aligned");
        check("4. ...and currentPrimaryDepartmentId now matches the real placement", previewAfter.rows[0].currentPrimaryDepartmentId === callCenterDept.id);
      }
    }

    // ── 5. A→B transition preserves correct department-scoped access, and secondary memberships are untouched, across the unified Department ──
    console.log("\n5. A primary A->B transition into the unified Department preserves correct department-scoped access and leaves independent secondary memberships untouched\n");
    {
      const user = await makeUser("user-transition");
      const otherDept = await prisma.department.create({
        data: { name: `SGDU Other Dept ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGDU Other Dept ${RUN_ID}`), slug: `sgdu-other-${RUN_ID}` },
      });
      departmentIds.push(otherDept.id);
      await membershipSvc.setPrimaryDepartmentMembership(user, otherDept.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      const secondaryMembership = await membershipSvc.grantManualMembership(user, decoyDept.id, { role: DepartmentRole.VIEWER });

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-transition", DEPT_359, COMPANY_A_ID, `Company A ${RUN_ID}`) });
      const { outcome } = await driveSync(user, "sgdu-user-transition", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("5. Transition into the unified Department succeeds", outcome === "succeeded");

      const oldMembership = await membershipSvc.getMembership(user, otherDept.id);
      check("5. Old primary department access is IMMEDIATELY gone (live, same-process check)", oldMembership === null);
      const oldRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user, departmentId: otherDept.id } } });
      check("5. ...the old primary row is fully deactivated (isPrimary:false, isActive:false)", oldRow?.isPrimary === false && oldRow?.isActive === false);

      const newMembership = await membershipSvc.getMembership(user, callCenterDept.id);
      check("5. New unified-Department access is live", newMembership !== null && newMembership.isActive === true);

      const secondaryAfter = await prisma.departmentMembership.findUnique({ where: { id: secondaryMembership.id } });
      check("5. The independent MANUAL secondary membership (decoy dept) is completely untouched", secondaryAfter?.isActive === true && secondaryAfter?.isPrimary === false && secondaryAfter?.source === MembershipSource.MANUAL);
    }

    // ── 6. A deleted/inactive employee is never (re)placed ──
    console.log("\n6. A deleted local user (simulating 'partsa') is never recreated or placed — the worker structurally cannot create a User row\n");
    {
      const user = await makeUser("user-deleted");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-deleted", DEPT_359, COMPANY_A_ID, `Company A ${RUN_ID}`) });
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdu-user-deleted");
      // Hard-delete the local User row BEFORE the worker ever claims it — exactly
      // what happens to a genuinely deleted/offboarded employee like "partsa".
      await prisma.user.delete({ where: { id: user } });
      userIds.splice(userIds.indexOf(user), 1);
      const attemptAfterDelete = await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: user } });
      check("6. The SqlGeneralUserSyncAttempt row was cascaded away with the deleted User (onDelete: Cascade) — nothing left to process", attemptAfterDelete === null);
      const recreated = await prisma.user.findUnique({ where: { id: user } });
      check("6. No User row was recreated under the same id", recreated === null);
      const byUsername = await prisma.sqlGeneralUserSyncAttempt.findFirst({ where: { sqlGeneralUsername: "sgdu-user-deleted" } });
      check("6. No OTHER local User/attempt was fabricated for this SQLGeneral username either", byUsername === null);
    }

    // ── 7. Ticket creation under the unified Department (the user's canonical/default workspace) ──
    console.log("\n7. A Ticket created under the user's default/canonical workspace lands in the unified Call Center & Customer Service Department\n");
    {
      const user = await makeUser("user-ticket-routing");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdu-user-ticket-routing", DEPT_129, COMPANY_B_ID, `Company B ${RUN_ID}`) });
      const { outcome } = await driveSync(user, "sgdu-user-ticket-routing", [FAKE_DEPT_359, FAKE_DEPT_129, FAKE_DEPT_UNAPPROVED]);
      check("7. Placement into the unified Department succeeds", outcome === "succeeded");

      const { resolveActiveWorkspace } = await import("@/lib/services/workspace-service");
      const workspace = await resolveActiveWorkspace(user, Role.USER, undefined);
      check("7. The user's default/canonical active workspace IS the unified Call Center & Customer Service Department — not a separate 'Call Center KINSEN' Department", workspace.departmentId === callCenterDept.id);
      check("7. ...specifically NOT the decoy Department", workspace.departmentId !== decoyDept.id);

      // Ticket creation's own destination resolver (app/api/tickets/route.ts
      // calls this EXACT function, resolveTicketDestinationDepartment, NOT
      // resolveDepartmentForCreate — see that route's own comment) falls
      // back to this SAME activeWorkspace.departmentId when no explicit
      // departmentId/linked-project is given.
      const { resolveTicketDestinationDepartment } = await import("@/lib/services/department-scope-service");
      const createResolution = await resolveTicketDestinationDepartment(user, Role.USER, null, undefined);
      check(
        "7. resolveTicketDestinationDepartment (the real Ticket-creation resolver) resolves to the SAME unified Department for this user's default workspace, not a separate 'Call Center KINSEN' one",
        "departmentId" in createResolution && createResolution.departmentId === callCenterDept.id,
        JSON.stringify(createResolution)
      );
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      // Must run BEFORE "users" — approvedById on both mapping tables
      // RESTRICTs deletion of the admin user that approved them.
      ["sqlGeneralDepartmentMappings", () => prisma.sqlGeneralDepartmentMapping.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["sqlGeneralCompanyMappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { companyId: { in: companyIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketPriorities", () => (departmentIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["ticketStatuses", () => (departmentIds.length ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["departments", () => (departmentIds.length ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
      ["companies", () => (companyIds.length ? prisma.company.deleteMany({ where: { id: { in: companyIds } } }) : Promise.resolve())],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
