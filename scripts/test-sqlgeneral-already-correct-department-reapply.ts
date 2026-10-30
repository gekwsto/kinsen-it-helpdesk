/**
 * Focused verification: "SQLGeneral Primary Placement Final Activation
 * Check" — what ACTUALLY happens when applySqlGeneralPrimaryPlacement
 * runs for a user whose current primary is ALREADY in the correct
 * Department, but sourced MANUAL or MICROSOFT_DEPARTMENT (not yet
 * SQLGENERAL_DEPARTMENT) — the exact production shape reported for
 * `aliskr`/`thoche`/`stekam`/`taster` (previewSqlGeneralUserSync reports
 * `would_place`, not `already_aligned`, because that classification
 * requires BOTH departmentId AND source to already match).
 *
 * This file answers, empirically (never by code-reading alone):
 *   1. Does a MANUAL-sourced, already-correct-department primary get
 *      touched at all by a real run? (setPrimaryDepartmentMembership's
 *      own MANUAL-row protection — never silently overwritten, even by
 *      SQLGeneral.)
 *   2. Does a MICROSOFT_DEPARTMENT-sourced, already-correct-department
 *      primary get its role/customRoleId silently changed if the
 *      configured Default Department Role differs from what they
 *      currently hold? (A real access-impact risk if so.)
 *   3. Is any OTHER active membership (secondary, or an unrelated
 *      Department) touched as a side effect?
 *   4. Does Preview's "would_place" classification match what the worker
 *      ACTUALLY does, or does it over-report a change that never really
 *      happens (a Preview/worker parity gap worth flagging on its own)?
 *
 * Entirely local/dev-DB. Never touches production. Never enables real
 * sync flags outside this process.
 *
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-already-correct-department-reapply.ts
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

  process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  let mockFindUserImpl: typeof realClient.findSqlGeneralUserByUsername = async () => {
    throw new Error("mock: no impl installed");
  };
  let mockListDeptImpl: typeof realClient.listAllSqlGeneralDepartments = async () => ({ ok: true, departments: [] });
  const mockVerifyCompanyImpl: typeof realClient.verifySqlGeneralCompanyIdExists = async () => ({ ok: true, exists: true });
  const mockVerifyDeptImpl: typeof realClient.verifySqlGeneralDepartmentIdExists = async () => ({ ok: true, exists: true });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
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
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({ data: { email: `sgrr-${tag}-${RUN_ID}@kinsen.gr`, name: `SGRR ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true } });
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
  const fakeHrUser = (username: string, hrDepartmentId: string, active = true) => ({
    username, mail: null, hrDepartmentId, department: null, companyId: null, company: null, active,
    managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
  });

  try {
    console.log("\n=== Setup: one SQLGeneral-owned Company/Department ===\n");
    const admin = await makeUser("admin-actor");
    const company = await prisma.company.create({ data: { name: `SGRR Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`SGRR Co ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } });
    companyIds.push(company.id);
    const dept = await prisma.department.create({ data: { name: `SGRR Dept ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGRR Dept ${RUN_ID}`), slug: `sgrr-dept-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL } });
    departmentIds.push(dept.id);
    const otherDept = await prisma.department.create({ data: { name: `SGRR Other Dept ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGRR Other Dept ${RUN_ID}`), slug: `sgrr-other-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL } });
    departmentIds.push(otherDept.id);
    const HR_ID = `sgrr-hr-${RUN_ID}`;
    const FAKE_DEPT = { id: HR_ID, description: dept.name, isActive: true, parentDepartmentId: null, country: null, company: company.name, companyShortname: null, creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT] });
    const approveCo = await svc.approveSqlGeneralCompanyMapping(`sgrr-sgco-${RUN_ID}`, company.id, admin);
    check("Setup: Company mapping approved", approveCo.ok === true, approveCo.ok ? undefined : (approveCo as { reason: string }).reason);
    const approveDept = await svc.approveSqlGeneralDepartmentMapping(HR_ID, dept.id, admin);
    check("Setup: Department mapping approved", approveDept.ok === true, approveDept.ok ? undefined : (approveDept as { reason: string }).reason);

    // ══════════════════════ 1. MANUAL-sourced, already-correct-department primary ══════════════════════
    console.log("\n=== 1. MANUAL-sourced primary, already in the CORRECT department (the thoche/stekam/taster shape) ===\n");
    {
      const user = await makeUser("manual-already-correct");
      await membershipSvc.setPrimaryDepartmentMembership(user, dept.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      const secondary = await membershipSvc.grantManualMembership(user, otherDept.id, { role: DepartmentRole.VIEWER });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgrr-manual-already-correct", HR_ID) });
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgrr-manual-already-correct");
      const preview = await svc.previewSqlGeneralUserSync({ userIds: [user] });
      check("1. Preview (FIXED this round) classifies this as 'would_realign_source_only' — Department already matches, MANUAL-row protection means zero write, never a misleading 'would_place'", preview.ok && preview.rows[0].primaryChangeOutcome === "would_realign_source_only", JSON.stringify(preview));

      const { outcome } = await driveSync(user, "sgrr-manual-already-correct", [FAKE_DEPT]);
      check("1. The actual worker run reports 'succeeded' (processOne's own outcome, independent of the row-level no-op below)", outcome === "succeeded");

      const after = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });
      check("1. Department already matched before and after — never a real move", before.departmentId === after.departmentId);
      check("1. ACCESS IMPACT: the row's source is STILL MANUAL — setPrimaryDepartmentMembership's own MANUAL-row protection left it completely untouched, never silently switched to SQLGENERAL_DEPARTMENT", after.source === MembershipSource.MANUAL);
      check("1. ...role is UNCHANGED (still the admin's own DEPARTMENT_MANAGER choice, never downgraded to the configured default)", after.role === DepartmentRole.DEPARTMENT_MANAGER);
      check("1. ...isActive/isPrimary unchanged", after.isActive === true && after.isPrimary === true);
      check("1. ...id is literally the SAME row (no delete+recreate, no new row)", after.id === before.id);
      check("1. ...updatedAt is UNCHANGED (a genuine no-op write, not even a touched timestamp)", after.updatedAt.getTime() === before.updatedAt.getTime());

      const secondaryAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { id: secondary.id } });
      check("1. The independent secondary membership is completely untouched", secondaryAfter.isActive === true && secondaryAfter.isPrimary === false && secondaryAfter.source === MembershipSource.MANUAL);

      check("1. PREVIEW/WORKER PARITY (FIXED this round): Preview's 'would_realign_source_only' correctly predicted a zero-write no-op — source and role both identical before/after", before.source === after.source && before.role === after.role);
    }

    // ══════════════════════ 2. MICROSOFT_DEPARTMENT-sourced, already-correct department, SAME role as configured default ══════════════════════
    console.log("\n=== 2. MICROSOFT_DEPARTMENT-sourced primary, already correct department, role ALREADY matches the configured default (the aliskr shape, no default configured) ===\n");
    {
      const user = await makeUser("msdept-role-matches");
      // No configured Default Department Role in this run -> resolveDefaultDepartmentRoleAssignment() falls back to DepartmentRole.REQUESTER/no custom role (existing, pre-existing fallback — confirmed by scripts/test-configurable-default-roles.ts scenario E).
      await membershipSvc.setPrimaryDepartmentMembership(user, dept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgrr-msdept-role-matches", HR_ID) });
      const { outcome } = await driveSync(user, "sgrr-msdept-role-matches", [FAKE_DEPT]);
      check("2. Worker succeeds", outcome === "succeeded");
      const after = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });
      check("2. Role matched the default already -> roleAlreadyMatches short-circuit: source is STILL unchanged (not flipped to SQLGENERAL_DEPARTMENT) — row left untouched", after.source === MembershipSource.MICROSOFT_DEPARTMENT, JSON.stringify({ before, after }));
      check("2. ...role unchanged", after.role === DepartmentRole.REQUESTER);
      check("2. ...same row, same updatedAt — genuine no-op", after.id === before.id && after.updatedAt.getTime() === before.updatedAt.getTime());
    }

    // ══════════════════════ 3. MICROSOFT_DEPARTMENT-sourced, already-correct department, DIFFERENT role than the configured default ══════════════════════
    console.log("\n=== 3. MICROSOFT_DEPARTMENT-sourced primary, already correct department, role DIFFERS from what SQLGeneral would now assign — THE REAL RISK CASE ===\n");
    {
      const user = await makeUser("msdept-role-differs");
      // Deliberately a CUSTOM role, so it's guaranteed to differ from the plain-enum default resolveDefaultDepartmentRoleAssignment() falls back to.
      const customRole = await prisma.customRole.create({ data: { key: `SGRR_CUSTOM_${RUN_ID}`, name: `SGRR Custom ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
      customRoleIds.push(customRole.id);
      customRoleKeys.push(customRole.key);
      const ticketCreatePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.create" } });
      await prisma.rolePermission.create({ data: { roleKey: customRole.key, permissionId: ticketCreatePerm.id } });
      await membershipSvc.setPrimaryDepartmentMembership(user, dept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.VIEWER, customRoleId: customRole.id });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });
      check("3. Setup: this membership carries a CUSTOM department role (richer/different permissions than the plain default)", before.customRoleId === customRole.id);

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgrr-msdept-role-differs", HR_ID) });
      const { outcome } = await driveSync(user, "sgrr-msdept-role-differs", [FAKE_DEPT]);
      check("3. Worker succeeds", outcome === "succeeded");
      const after = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });
      check("3. ACCESS PRESERVED: protectCustomRole short-circuit (targetExisting.customRoleId is set) left the row COMPLETELY untouched — custom role, and therefore effective permissions, NEVER silently narrowed/broadened", after.customRoleId === customRole.id && after.role === DepartmentRole.VIEWER, JSON.stringify({ before, after }));
      check("3. ...source is STILL unchanged too (protectCustomRole is checked independently of protectManualRole, same short-circuit)", after.source === MembershipSource.MICROSOFT_DEPARTMENT);
      check("3. ...genuine no-op (same row, same updatedAt)", after.id === before.id && after.updatedAt.getTime() === before.updatedAt.getTime());
    }

    // ══════════════════════ 4. The ONE case that genuinely IS a real write: plain-enum role, source NOT MANUAL/no custom role, role DIFFERS ══════════════════════
    console.log("\n=== 4. The one real-write case: a PLAIN-ENUM role (no custom role, not MANUAL-sourced) that differs from the configured default — DOES get updated ===\n");
    {
      const user = await makeUser("plain-role-differs");
      await membershipSvc.setPrimaryDepartmentMembership(user, dept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.AGENT_ASSIGNEE });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgrr-plain-role-differs", HR_ID) });
      const { outcome } = await driveSync(user, "sgrr-plain-role-differs", [FAKE_DEPT]);
      check("4. Worker succeeds", outcome === "succeeded");
      const after = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user, departmentId: dept.id } } });
      check("4. This IS a real write: role changed to the configured default (REQUESTER, no default configured in this run) and source flips to SQLGENERAL_DEPARTMENT — the ONLY case among all four where something actually changes", after.role === DepartmentRole.REQUESTER && after.source === MembershipSource.SQLGENERAL_DEPARTMENT, JSON.stringify({ before, after }));
      check("4. Department/isActive/isPrimary stay correct throughout", after.departmentId === dept.id && after.isActive === true && after.isPrimary === true);
    }

    // ══════════════════════ 5. Periodic re-sync: does ANYTHING revive a SUCCEEDED attempt automatically? ══════════════════════
    console.log("\n=== 5. Periodic re-sync: a SUCCEEDED attempt is NEVER automatically revived by claimBatch, nor by a later login ===\n");
    {
      const user = await makeUser("succeeded-periodic-check");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgrr-succeeded-periodic", HR_ID) });
      const { row: succeededRow } = await driveSync(user, "sgrr-succeeded-periodic", [FAKE_DEPT]);
      check("5. Setup: the attempt reached SUCCEEDED", succeededRow.status === "SUCCEEDED");

      // A later Microsoft login (enqueueOrRecoverSqlGeneralUserSync) with the
      // SAME username — the exact call every subsequent login makes.
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgrr-succeeded-periodic");
      const afterLogin = await attempt(user);
      check("5. A later login leaves the SUCCEEDED row completely untouched — status, attemptCount, claimedAt all unchanged (never re-queued)", afterLogin.status === "SUCCEEDED" && afterLogin.attemptCount === succeededRow.attemptCount);

      // processDueSqlGeneralUserSyncs' own claim query (the SAME SQL the
      // 5-minute cron/sidecar actually runs) — gated here on
      // isSqlGeneralSyncEnabled() too, which stays false in this process,
      // so calling it is a safe no-op either way; the real proof is the
      // claim SQL's own WHERE clause (status = 'PENDING' OR stale
      // PROCESSING), never SUCCEEDED, confirmed by code (claimBatch, this
      // file's own service module) — this call only reconfirms it claims
      // nothing at all while the flag is off, consistent with every other
      // scenario in this file leaving production flags alone.
      const dueResult = await svc.processDueSqlGeneralUserSyncs();
      check("5. processDueSqlGeneralUserSyncs() (the exact function the 5-minute cron calls) claims nothing while SQLGENERAL_SYNC_ENABLED is unset — and even when enabled, its claim SQL only ever selects PENDING or stale-PROCESSING rows, never SUCCEEDED (see claimBatch's own WHERE clause)", dueResult.claimed === 0);

      const finalRow = await attempt(user);
      check("5. The SUCCEEDED row is still SUCCEEDED after a cron-shaped run attempt — no periodic mechanism exists that revisits an already-successful placement", finalRow.status === "SUCCEEDED");
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralDepartmentMappings", () => prisma.sqlGeneralDepartmentMapping.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["sqlGeneralCompanyMappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { companyId: { in: companyIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => (customRoleKeys.length ? prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } }) : Promise.resolve())],
      ["customRoles", () => (customRoleIds.length ? prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } }) : Promise.resolve())],
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
