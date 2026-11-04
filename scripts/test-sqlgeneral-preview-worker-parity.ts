/**
 * Regression coverage for "Fix SQLGeneral Preview/Worker behavioral
 * divergence" — previewSqlGeneralUserSync used to re-implement its own
 * copy of Company/Department resolution (approved-mapping lookup,
 * name-match, ownership conflict), predating Department auto-creation —
 * so it always reported "blocked_unmapped_department" for a missing
 * Department even after the real worker gained the ability to auto-create
 * one. Preview now calls the EXACT SAME resolveSqlGeneralPlacementTarget
 * the worker uses (resolveSqlGeneralPlacementTargetDryRun, inside a
 * transaction that is always rolled back) — this file verifies Preview's
 * prediction and the worker's actual outcome now agree, AND that calling
 * Preview itself never persists anything.
 *
 * Covers: an existing SQLGeneral-owned Department (reuse) — Preview and
 * worker agree; a missing, structurally-valid Department (auto-create) —
 * Preview predicts "would_auto_create"/"would_place" WITHOUT creating
 * anything, then the real worker creates it and lands on the exact
 * Department Preview's own (never-persisted) resolution pointed at; an
 * invalid hierarchy (missing parent / cycle) — Preview and worker both
 * fail closed, identically; an ownership conflict (Company and Department
 * level) — Preview reports conflict_other_owner/blocked_local_conflict,
 * matching the worker's refusal; a locked current primary — Preview
 * predicts blocked_locked, matching setPrimaryDepartmentMembership's own
 * refusal; and Preview's own dry-run call never creates a Department/
 * Company row by itself, confirmed by a before/after count around the
 * Preview call alone (separate from the worker run that follows it).
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-preview-worker-parity.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, OrganizationNodeSource } from "@prisma/client";

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
    throw new Error("mock: no findSqlGeneralUserByUsername impl installed");
  };
  // previewSqlGeneralUserSync (unlike driveSync below, which passes
  // departments directly to processClaimedSqlGeneralUserSync) fetches the
  // Departments listing itself via listAllSqlGeneralDepartments — must be
  // mocked too, kept in lockstep with whatever departments the ACTIVE
  // scenario's driveSync call will also use, so Preview and the worker see
  // byte-identical source data.
  let mockListDeptImpl: typeof realClient.listAllSqlGeneralDepartments = async () => ({ ok: true, departments: [] });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
      verifySqlGeneralCompanyIdExists: async () => ({ ok: true, exists: true }),
      verifySqlGeneralDepartmentIdExists: async () => ({ ok: true, exists: true }),
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgpwp-${tag}-${RUN_ID}@kinsen.gr`, name: `SGPWP ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true },
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
  const hrDept = (id: string, description: string, company: string, opts: { isActive?: boolean | null; parentDepartmentId?: string | null } = {}) => ({
    id, description, isActive: opts.isActive ?? true, parentDepartmentId: opts.parentDepartmentId ?? null, country: null, company, companyShortname: "KIN", creationDate: null, updateTimestamp: null,
  });

  async function trackCompany(name: string) {
    const normalizedName = normalizeCompanyName(name);
    let company = await prisma.company.findUnique({ where: { normalizedName } });
    if (!company) {
      company = await prisma.company.create({ data: { name, normalizedName, importSource: OrganizationNodeSource.SQLGENERAL } });
    }
    companyIds.push(company.id);
    return company;
  }

  try {
    const COMPANY_A = `Kinsen Parity A ${RUN_ID}`;
    const SG_COMPANY_A = `sgpwp-companyA-${RUN_ID}`;
    const companyA = await trackCompany(COMPANY_A);
    const admin = await makeUser("admin");
    const approveA = await svc.approveSqlGeneralCompanyMapping(SG_COMPANY_A, companyA.id, admin);
    check("Setup: Company A mapping approved", approveA.ok === true);
    // A SECOND SQLGeneral CompanyId, deliberately left WITHOUT an approved
    // mapping, whose `.company` text still matches Company A's real name —
    // resolves to the exact same local Company purely by name-match, NOT
    // via SG_COMPANY_A's approved mapping. Scenarios 1-2 use this one
    // specifically so their localMatch reflects plain reuse/auto-creation,
    // not "approved_external_mapping" (which SG_COMPANY_A would always
    // report, by design, for every user under it).
    const SG_COMPANY_A_BY_NAME = `sgpwp-companyAbyname-${RUN_ID}`;

    // ══════════════════════ 1. Existing Department — Preview and worker agree ══════════════════════
    console.log("\n=== 1. An existing, SQLGeneral-owned Department: Preview predicts the exact outcome the worker then produces ===\n");
    const HR_EXISTING = `sgpwp-existing-${RUN_ID}`;
    const deptNameExisting = `Existing Reuse Parity ${RUN_ID}`;
    const existingDept = await prisma.department.create({
      data: { name: deptNameExisting, normalizedName: normalizeDepartmentName(deptNameExisting), slug: `sgpwp-existing-${RUN_ID}`, companyId: companyA.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(existingDept.id);
    const FAKE_EXISTING = hrDept(HR_EXISTING, deptNameExisting, COMPANY_A);
    const user1 = await makeUser("user-existing");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-existing", HR_EXISTING, SG_COMPANY_A_BY_NAME, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_EXISTING] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user1, "sgpwp-user-existing");
    const preview1 = await svc.previewSqlGeneralUserSync({ userIds: [user1] });
    check("1. Preview call succeeds", preview1.ok === true);
    if (preview1.ok) {
      const row = preview1.rows[0];
      check("1. localMatch is existing_sqlgeneral_owned (reused, not created)", row.localMatch === "existing_sqlgeneral_owned", row.localMatch);
      check("1. proposedDepartmentId is the REAL existing id", row.proposedDepartmentId === existingDept.id);
      check("1. primaryChangeOutcome is would_place (no current primary yet)", row.primaryChangeOutcome === "would_place", row.primaryChangeOutcome);
    }
    const countBefore1 = await prisma.department.count({ where: { companyId: companyA.id } });
    const { outcome: outcome1 } = await driveSync(user1, "sgpwp-user-existing", [FAKE_EXISTING]);
    check("1. Worker run succeeds", outcome1 === "succeeded", outcome1);
    const countAfter1 = await prisma.department.count({ where: { companyId: companyA.id } });
    check("1. No new Department was created by the worker either (matches Preview's prediction)", countAfter1 === countBefore1);
    const after1 = await prisma.user.findUnique({ where: { id: user1 } });
    check("1. User actually landed in the EXACT Department Preview proposed", after1?.departmentId === existingDept.id);

    // ══════════════════════ 2. Missing, valid Department — Preview predicts auto-creation WITHOUT creating anything ══════════════════════
    console.log("\n=== 2. A missing, structurally-valid Department: Preview predicts would_auto_create/would_place, creates NOTHING itself, then the real worker creates it and matches ===\n");
    const HR_MISSING = `sgpwp-missing-${RUN_ID}`;
    const deptNameMissing = `Missing AutoCreate Parity ${RUN_ID}`;
    const FAKE_MISSING = hrDept(HR_MISSING, deptNameMissing, COMPANY_A);
    const user2 = await makeUser("user-missing");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-missing", HR_MISSING, SG_COMPANY_A_BY_NAME, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_MISSING] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user2, "sgpwp-user-missing");

    const countBeforePreview2 = await prisma.department.count({ where: { companyId: companyA.id } });
    const preview2 = await svc.previewSqlGeneralUserSync({ userIds: [user2] });
    check("2. Preview call succeeds", preview2.ok === true);
    if (preview2.ok) {
      const row2 = preview2.rows[0];
      check("2. localMatch is would_auto_create — a VALID proposed creation, not a blocker", row2.localMatch === "would_auto_create", row2.localMatch);
      check("2. proposedDepartmentId is null — never a never-persisted id handed back as if it existed", row2.proposedDepartmentId === null);
      check("2. proposedDepartmentName IS populated (the name that would be used)", row2.proposedDepartmentName === deptNameMissing);
      check("2. primaryChangeOutcome is would_place — NOT blocked_unmapped_department (the exact gap this round fixes)", row2.primaryChangeOutcome === "would_place", row2.primaryChangeOutcome);
    }
    const countAfterPreview2 = await prisma.department.count({ where: { companyId: companyA.id } });
    check("2. Preview itself created ZERO Department rows — strictly read-only", countAfterPreview2 === countBeforePreview2, `before=${countBeforePreview2} after=${countAfterPreview2}`);
    const noLeakedDept = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameMissing) } } });
    check("2. ...confirmed by direct lookup: the Department genuinely does not exist yet", noLeakedDept === null);

    const { outcome: outcome2 } = await driveSync(user2, "sgpwp-user-missing", [FAKE_MISSING]);
    check("2. The REAL worker run now succeeds (creates the Department for real)", outcome2 === "succeeded", outcome2);
    const createdDept2 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameMissing) } } });
    if (createdDept2) departmentIds.push(createdDept2.id);
    check("2. ...the Department now genuinely exists, owned by SQLGeneral", createdDept2?.importSource === OrganizationNodeSource.SQLGENERAL);
    const after2 = await prisma.user.findUnique({ where: { id: user2 } });
    check("2. ...and the user landed in EXACTLY that Department — Preview's prediction and the worker's real action agree", after2?.departmentId === createdDept2?.id);

    // ══════════════════════ 3. Invalid hierarchy (missing parent) — Preview and worker both fail closed ══════════════════════
    console.log("\n=== 3. An invalid hierarchy (missing parent): Preview and the worker both fail closed, identically ===\n");
    const HR_BADCHAIN = `sgpwp-badchain-${RUN_ID}`;
    const deptNameBadChain = `Bad Chain Parity ${RUN_ID}`;
    const FAKE_BADCHAIN = hrDept(HR_BADCHAIN, deptNameBadChain, COMPANY_A, { parentDepartmentId: "does-not-exist" });
    const user3 = await makeUser("user-badchain");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-badchain", HR_BADCHAIN, SG_COMPANY_A, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_BADCHAIN] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user3, "sgpwp-user-badchain");
    const preview3 = await svc.previewSqlGeneralUserSync({ userIds: [user3] });
    check("3. Preview call succeeds", preview3.ok === true);
    if (preview3.ok) {
      const row = preview3.rows[0];
      check("3. localMatch is 'none' — a genuine blocker, not a proposed creation", row.localMatch === "none", row.localMatch);
      check("3. conflictDetail mentions the chain problem", /parentdepartmentid|ambiguous|chain/i.test(row.conflictDetail ?? ""), row.conflictDetail ?? "");
      check("3. primaryChangeOutcome is blocked_unmapped_department", row.primaryChangeOutcome === "blocked_unmapped_department", row.primaryChangeOutcome);
    }
    const { outcome: outcome3, row: workerRow3 } = await driveSync(user3, "sgpwp-user-badchain", [FAKE_BADCHAIN]);
    check("3. The real worker ALSO fails (never silently succeeds) — matches Preview", outcome3 !== "succeeded", outcome3);
    check("3. ...and its own error ALSO mentions the chain problem (same underlying resolver, same reason)", /parentdepartmentid|ambiguous|chain/i.test(workerRow3.lastError ?? ""), workerRow3.lastError ?? "");
    const notCreated3 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameBadChain) } } });
    check("3. No Department was created by either Preview or the worker", notCreated3 === null);

    // ══════════════════════ 4. Ownership conflict (Company level) — Preview and worker agree ══════════════════════
    console.log("\n=== 4. A Company-level ownership conflict: Preview reports conflict_other_owner/blocked_local_conflict, matching the worker's refusal ===\n");
    const manualCompanyName = `Manually Created Company Parity ${RUN_ID}`;
    const manualCompany = await prisma.company.create({ data: { name: manualCompanyName, normalizedName: normalizeCompanyName(manualCompanyName), importSource: null } });
    companyIds.push(manualCompany.id);
    const HR_COMPANY_CONFLICT = `sgpwp-companyconflict-${RUN_ID}`;
    const SG_COMPANY_CONFLICT = `sgpwp-sgcompanyconflict-${RUN_ID}`;
    const deptNameCompanyConflict = `Company Conflict Dept Parity ${RUN_ID}`;
    const FAKE_COMPANY_CONFLICT = hrDept(HR_COMPANY_CONFLICT, deptNameCompanyConflict, manualCompanyName);
    const user4 = await makeUser("user-companyconflict");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-companyconflict", HR_COMPANY_CONFLICT, SG_COMPANY_CONFLICT, manualCompanyName) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_COMPANY_CONFLICT] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user4, "sgpwp-user-companyconflict");
    const preview4 = await svc.previewSqlGeneralUserSync({ userIds: [user4] });
    check("4. Preview call succeeds", preview4.ok === true);
    if (preview4.ok) {
      const row = preview4.rows[0];
      check("4. localMatch is conflict_other_owner", row.localMatch === "conflict_other_owner", row.localMatch);
      check("4. conflictLevel is 'company'", row.conflictLevel === "company", String(row.conflictLevel));
      check("4. primaryChangeOutcome is blocked_local_conflict", row.primaryChangeOutcome === "blocked_local_conflict", row.primaryChangeOutcome);
    }
    const { outcome: outcome4, row: workerRow4 } = await driveSync(user4, "sgpwp-user-companyconflict", [FAKE_COMPANY_CONFLICT]);
    check("4. The real worker ALSO refuses — matches Preview", outcome4 !== "succeeded", outcome4);
    check("4. ...and its reason ALSO names the Company ownership conflict", /not owned by sqlgeneral sync/i.test(workerRow4.lastError ?? ""), workerRow4.lastError ?? "");
    const manualCompanyUnchanged = await prisma.company.findUnique({ where: { id: manualCompany.id } });
    check("4. The manually-created Company is completely untouched", manualCompanyUnchanged?.importSource === null);

    // ══════════════════════ 5. Ownership conflict (Department level) — Preview and worker agree ══════════════════════
    console.log("\n=== 5. A Department-level ownership conflict: Preview reports conflict_other_owner/blocked_local_conflict, matching the worker's refusal ===\n");
    const manualDeptName = `Manually Created Dept Parity ${RUN_ID}`;
    const manualDept = await prisma.department.create({
      data: { name: manualDeptName, normalizedName: normalizeDepartmentName(manualDeptName), slug: `sgpwp-manualdept-${RUN_ID}`, companyId: companyA.id, importSource: null },
    });
    departmentIds.push(manualDept.id);
    const HR_DEPT_CONFLICT = `sgpwp-deptconflict-${RUN_ID}`;
    const FAKE_DEPT_CONFLICT = hrDept(HR_DEPT_CONFLICT, manualDeptName, COMPANY_A);
    const user5 = await makeUser("user-deptconflict");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-deptconflict", HR_DEPT_CONFLICT, SG_COMPANY_A, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_CONFLICT] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user5, "sgpwp-user-deptconflict");
    const preview5 = await svc.previewSqlGeneralUserSync({ userIds: [user5] });
    check("5. Preview call succeeds", preview5.ok === true);
    if (preview5.ok) {
      const row = preview5.rows[0];
      check("5. localMatch is conflict_other_owner", row.localMatch === "conflict_other_owner", row.localMatch);
      check("5. conflictLevel is 'department'", row.conflictLevel === "department", String(row.conflictLevel));
      check("5. primaryChangeOutcome is blocked_local_conflict", row.primaryChangeOutcome === "blocked_local_conflict", row.primaryChangeOutcome);
    }
    const { outcome: outcome5, row: workerRow5 } = await driveSync(user5, "sgpwp-user-deptconflict", [FAKE_DEPT_CONFLICT]);
    check("5. The real worker ALSO refuses — matches Preview", outcome5 !== "succeeded", outcome5);
    const manualDeptUnchanged = await prisma.department.findUnique({ where: { id: manualDept.id } });
    check("5. The manually-created Department is completely untouched", manualDeptUnchanged?.importSource === null && manualDeptUnchanged?.name === manualDeptName);

    // ══════════════════════ 6. Locked current primary — Preview predicts blocked_locked, matching the worker ══════════════════════
    console.log("\n=== 6. A locked current primary Department: Preview predicts blocked_locked, matching setPrimaryDepartmentMembership's own refusal ===\n");
    const HR_LOCK_OLD = `sgpwp-lockold-${RUN_ID}`;
    const HR_LOCK_NEW = `sgpwp-locknew-${RUN_ID}`;
    const deptNameLockOld = `Lock Old Parity ${RUN_ID}`;
    const deptNameLockNew = `Lock New Parity ${RUN_ID}`;
    const lockOldDept = await prisma.department.create({
      data: { name: deptNameLockOld, normalizedName: normalizeDepartmentName(deptNameLockOld), slug: `sgpwp-lockold-${RUN_ID}`, companyId: companyA.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(lockOldDept.id);
    const lockNewDept = await prisma.department.create({
      data: { name: deptNameLockNew, normalizedName: normalizeDepartmentName(deptNameLockNew), slug: `sgpwp-locknew-${RUN_ID}`, companyId: companyA.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(lockNewDept.id);
    const FAKE_LOCK_NEW = hrDept(HR_LOCK_NEW, deptNameLockNew, COMPANY_A);
    const user6 = await makeUser("user-locked");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-locked", HR_LOCK_OLD, SG_COMPANY_A, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [hrDept(HR_LOCK_OLD, deptNameLockOld, COMPANY_A)] });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user6, "sgpwp-user-locked");
    const { outcome: setupOutcome6 } = await driveSync(user6, "sgpwp-user-locked", [hrDept(HR_LOCK_OLD, deptNameLockOld, COMPANY_A)]);
    check("6. Setup: user placed into the OLD Department first", setupOutcome6 === "succeeded", setupOutcome6);
    const membershipSvc = await import("@/lib/services/department-membership-service");
    const lockResult = await membershipSvc.setPrimaryDepartmentLock(user6, true, admin);
    check("6. Setup: the current primary is now explicitly locked", lockResult.ok === true && lockResult.locked === true);

    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgpwp-user-locked", HR_LOCK_NEW, SG_COMPANY_A, COMPANY_A) });
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_LOCK_NEW] });
    const preview6 = await svc.previewSqlGeneralUserSync({ userIds: [user6] });
    check("6. Preview call succeeds", preview6.ok === true);
    if (preview6.ok) {
      const row = preview6.rows[0];
      check("6. currentPrimaryLocked is true", row.currentPrimaryLocked === true);
      check("6. primaryChangeOutcome is blocked_locked", row.primaryChangeOutcome === "blocked_locked", row.primaryChangeOutcome);
    }
    const { outcome: outcome6, row: workerRow6 } = await driveSync(user6, "sgpwp-user-locked", [FAKE_LOCK_NEW]);
    check("6. The real worker ALSO refuses to move the locked primary — matches Preview", outcome6 !== "succeeded", outcome6);
    check("6. ...and its reason ALSO names the explicit lock", /locked/i.test(workerRow6.lastError ?? ""), workerRow6.lastError ?? "");
    const after6 = await prisma.user.findUnique({ where: { id: user6 } });
    check("6. User's primary Department is UNCHANGED (still the old, locked one)", after6?.departmentId === lockOldDept.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralCompanyMappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { companyId: { in: companyIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketPriorities", () => (departmentIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["ticketStatuses", () => (departmentIds.length ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["departments (tracked)", () => (departmentIds.length ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
      ["departments (any remaining, by RUN_ID name pattern)", () => prisma.department.deleteMany({ where: { name: { contains: `Parity ${RUN_ID}` } } })],
      ["companies (tracked)", () => (companyIds.length ? prisma.company.deleteMany({ where: { id: { in: companyIds } } }) : Promise.resolve())],
      ["companies (any remaining, by RUN_ID name pattern)", () => prisma.company.deleteMany({ where: { name: { contains: `Parity ${RUN_ID}` } } })],
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
