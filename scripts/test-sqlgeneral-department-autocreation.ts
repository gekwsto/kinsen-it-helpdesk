/**
 * Regression coverage for "SQLGeneral missing-Department auto-creation" —
 * resolveSqlGeneralPlacementTarget (lib/services/sqlgeneral-user-sync-
 * service.ts) previously hard-failed with "...SQLGeneral Department
 * auto-creation is not yet implemented" whenever the resolved HR Department
 * had no existing local match. It now creates the missing local Department
 * directly under the already-resolved Company, mirroring the pre-existing
 * Company auto-creation exactly (importSource: SQLGENERAL, same starter-
 * config row set a manually admin-created Department gets).
 *
 * Design note this file verifies: the local Department model has no
 * self-referencing field (no `parentDepartmentId`) — SQLGeneral's own
 * recursive `parentChain` ancestry is used PURELY to validate the HR
 * source is structurally sound (no missing parent, no cycle, no inactive/
 * cross-Company ancestor) before trusting it enough to create anything.
 * Only the resolved LEAF Department is ever created locally — never a
 * fabricated BusinessUnit/Department per ancestor level.
 *
 * Covers: root-level (no-ancestor) creation; creation with a validated
 * multi-level ancestor chain (only the leaf is materialized); reuse of an
 * already-SQLGeneral-owned exact match (no duplicate); fail-closed on a
 * missing-parent chain; fail-closed on a cycle; fail-closed on an inactive
 * leaf; fail-closed on an inactive ancestor; fail-closed on a
 * cross-Company ancestor; the pre-existing non-SQLGeneral-ownership
 * conflict is unaffected; concurrent sync attempts for two different users
 * resolving to the same missing Department never create two rows; and a
 * failure partway through creation (ensure-config throws) leaves no
 * orphaned Department row and the attempt stays retryable.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-department-autocreation.ts
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

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  let mockFindUserImpl: typeof realClient.findSqlGeneralUserByUsername = async () => {
    throw new Error("mock: no findSqlGeneralUserByUsername impl installed");
  };
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      // listAllSqlGeneralDepartments is untouched here — driveSync below
      // always passes `departments` directly to
      // processClaimedSqlGeneralUserSync, never through the worker's own
      // scheduling path, so it's never actually invoked. verify* ARE
      // invoked (by approveSqlGeneralCompanyMapping's own live-verification
      // step), so both are mocked to always confirm existence.
      verifySqlGeneralCompanyIdExists: async () => ({ ok: true, exists: true }),
      verifySqlGeneralDepartmentIdExists: async () => ({ ok: true, exists: true }),
    },
  });

  const realConfigStarter = await import("@/lib/services/config-starter-data");
  let shouldThrowConfigError = false;
  mock.module("@/lib/services/config-starter-data", {
    namedExports: {
      ...realConfigStarter,
      ensureActivityProgressConfigForDepartment: async (db: any, departmentId: string) => {
        if (shouldThrowConfigError) {
          shouldThrowConfigError = false;
          throw new Error("injected failure: ensureActivityProgressConfigForDepartment (rollback test)");
        }
        return realConfigStarter.ensureActivityProgressConfigForDepartment(db, departmentId);
      },
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgac-${tag}-${RUN_ID}@kinsen.gr`, name: `SGAC ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true },
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
    const COMPANY_A = `Kinsen AutoCreate A ${RUN_ID}`;
    const SG_COMPANY_A = `sgac-companyA-${RUN_ID}`;
    const companyA = await trackCompany(COMPANY_A);
    const approveA = await svc.approveSqlGeneralCompanyMapping(SG_COMPANY_A, companyA.id, await makeUser("admin"));
    check("Setup: Company A mapping approved", approveA.ok === true);

    // ══════════════════════ 1. Root-level (no ancestors) creation ══════════════════════
    console.log("\n=== 1. Missing root-level Department (empty parentChain) is auto-created under the resolved Company ===\n");
    const HR_ROOT = `sgac-root-${RUN_ID}`;
    const deptNameRoot = `Operations AutoCreate ${RUN_ID}`;
    const FAKE_ROOT = hrDept(HR_ROOT, deptNameRoot, COMPANY_A);
    const user1 = await makeUser("user-root");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-root", HR_ROOT, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome1 } = await driveSync(user1, "sgac-user-root", [FAKE_ROOT]);
    check("1. Worker run succeeds", outcome1 === "succeeded", outcome1);
    const createdRoot = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameRoot) } } });
    if (createdRoot) departmentIds.push(createdRoot.id);
    check("1. A new local Department was created", createdRoot !== null);
    check("1. ...owned by SQLGeneral (importSource)", createdRoot?.importSource === OrganizationNodeSource.SQLGENERAL);
    check("1. ...under the correct Company", createdRoot?.companyId === companyA.id);
    check("1. ...directly under Company, no BusinessUnit", createdRoot?.businessUnitId === null);
    const user1Row = await prisma.user.findUnique({ where: { id: user1 } });
    check("1. Secondary membership path: user1 is NOT auto-placed as primary (primary placement not enabled in this test)", user1Row?.departmentId !== createdRoot?.id || process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED === "true");
    if (createdRoot) {
      const startedConfig = await prisma.ticketStatus.count({ where: { departmentId: createdRoot.id } });
      check("1. Starter TicketStatus config was created (same as a manually admin-created Department)", startedConfig > 0);
    }

    // ══════════════════════ 2. Multi-level ancestor chain — only the LEAF is created ══════════════════════
    console.log("\n=== 2. A validated multi-level ancestor chain creates ONLY the leaf Department locally — no row for any ancestor ===\n");
    const HR_PARENT = `sgac-parent-${RUN_ID}`;
    const HR_GRANDPARENT = `sgac-grandparent-${RUN_ID}`;
    const HR_LEAF = `sgac-leaf-${RUN_ID}`;
    const deptNameLeaf = `Credit Control AutoCreate ${RUN_ID}`;
    const FAKE_GRANDPARENT = hrDept(HR_GRANDPARENT, "Finance Group", COMPANY_A);
    const FAKE_PARENT = hrDept(HR_PARENT, "Finance", COMPANY_A, { parentDepartmentId: HR_GRANDPARENT });
    const FAKE_LEAF = hrDept(HR_LEAF, deptNameLeaf, COMPANY_A, { parentDepartmentId: HR_PARENT });
    const chainDepts = [FAKE_GRANDPARENT, FAKE_PARENT, FAKE_LEAF];
    const user2 = await makeUser("user-chain");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-chain", HR_LEAF, SG_COMPANY_A, COMPANY_A) });
    const countBefore2 = await prisma.department.count({ where: { companyId: companyA.id } });
    const { outcome: outcome2 } = await driveSync(user2, "sgac-user-chain", chainDepts);
    check("2. Worker run succeeds", outcome2 === "succeeded", outcome2);
    const createdLeaf = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameLeaf) } } });
    if (createdLeaf) departmentIds.push(createdLeaf.id);
    check("2. The leaf Department was created", createdLeaf !== null);
    const countAfter2 = await prisma.department.count({ where: { companyId: companyA.id } });
    check("2. Exactly ONE new Department row was created for this Company (not one per ancestor level)", countAfter2 === countBefore2 + 1, `before=${countBefore2} after=${countAfter2}`);
    const ancestorAsLocal = await prisma.department.findFirst({ where: { companyId: companyA.id, OR: [{ normalizedName: normalizeDepartmentName("Finance") }, { normalizedName: normalizeDepartmentName("Finance Group") }] } });
    check("2. ...no local Department row exists for either ancestor name", ancestorAsLocal === null);

    // ══════════════════════ 3. Reuse of an already-SQLGeneral-owned exact match ══════════════════════
    console.log("\n=== 3. An exact-match existing SQLGeneral-owned Department is reused, never duplicated ===\n");
    const user3 = await makeUser("user-reuse");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-reuse", HR_ROOT, SG_COMPANY_A, COMPANY_A) });
    const countBefore3 = await prisma.department.count({ where: { companyId: companyA.id } });
    const { outcome: outcome3 } = await driveSync(user3, "sgac-user-reuse", [FAKE_ROOT]);
    check("3. Worker run succeeds (reusing the Department created in step 1)", outcome3 === "succeeded", outcome3);
    const countAfter3 = await prisma.department.count({ where: { companyId: companyA.id } });
    check("3. No new Department row was created — the existing one was reused", countAfter3 === countBefore3);

    // ══════════════════════ 4. Fail-closed: missing-parent chain ══════════════════════
    console.log("\n=== 4. A missing-parent chain fails closed — no Department is created ===\n");
    const HR_MISSING_PARENT = `sgac-missingparent-${RUN_ID}`;
    const deptNameMissingParent = `Missing Parent AutoCreate ${RUN_ID}`;
    const FAKE_MISSING_PARENT = hrDept(HR_MISSING_PARENT, deptNameMissingParent, COMPANY_A, { parentDepartmentId: "does-not-exist" });
    const user4 = await makeUser("user-missingparent");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-missingparent", HR_MISSING_PARENT, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome4, row: row4 } = await driveSync(user4, "sgac-user-missingparent", [FAKE_MISSING_PARENT]);
    check("4. Worker run does NOT succeed", outcome4 !== "succeeded", outcome4);
    check("4. ...attempt stays retryable (PENDING), never corrupted into a success", row4.status === "PENDING");
    check("4. ...lastError mentions the chain problem", /parentdepartmentid|ambiguous|chain/i.test(row4.lastError ?? ""), row4.lastError ?? "");
    const notCreated4 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameMissingParent) } } });
    check("4. ...no Department row was created", notCreated4 === null);

    // ══════════════════════ 5. Fail-closed: cycle in the chain ══════════════════════
    console.log("\n=== 5. A cyclic ancestor chain fails closed — no Department is created ===\n");
    const HR_CYCLE_A = `sgac-cycA-${RUN_ID}`;
    const HR_CYCLE_B = `sgac-cycB-${RUN_ID}`;
    const deptNameCycle = `Cycle AutoCreate ${RUN_ID}`;
    const FAKE_CYCLE_A = hrDept(HR_CYCLE_A, deptNameCycle, COMPANY_A, { parentDepartmentId: HR_CYCLE_B });
    const FAKE_CYCLE_B = hrDept(HR_CYCLE_B, "Cycle B", COMPANY_A, { parentDepartmentId: HR_CYCLE_A });
    const user5 = await makeUser("user-cycle");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-cycle", HR_CYCLE_A, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome5, row: row5 } = await driveSync(user5, "sgac-user-cycle", [FAKE_CYCLE_A, FAKE_CYCLE_B]);
    check("5. Worker run does NOT succeed", outcome5 !== "succeeded", outcome5);
    check("5. ...lastError mentions the cycle", /cycle/i.test(row5.lastError ?? ""), row5.lastError ?? "");
    const notCreated5 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameCycle) } } });
    check("5. ...no Department row was created", notCreated5 === null);

    // ══════════════════════ 6. Fail-closed: inactive leaf ══════════════════════
    console.log("\n=== 6. An inactive (isActive: false) HR Department fails closed — no Department is created ===\n");
    const HR_INACTIVE = `sgac-inactive-${RUN_ID}`;
    const deptNameInactive = `Inactive AutoCreate ${RUN_ID}`;
    const FAKE_INACTIVE = hrDept(HR_INACTIVE, deptNameInactive, COMPANY_A, { isActive: false });
    const user6 = await makeUser("user-inactive");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-inactive", HR_INACTIVE, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome6, row: row6 } = await driveSync(user6, "sgac-user-inactive", [FAKE_INACTIVE]);
    check("6. Worker run does NOT succeed", outcome6 !== "succeeded", outcome6);
    check("6. ...lastError mentions inactive", /inactive/i.test(row6.lastError ?? ""), row6.lastError ?? "");
    const notCreated6 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameInactive) } } });
    check("6. ...no Department row was created", notCreated6 === null);

    // ══════════════════════ 7. Fail-closed: inactive ancestor ══════════════════════
    console.log("\n=== 7. An inactive ANCESTOR in an otherwise-active chain fails closed — no Department is created ===\n");
    const HR_INACTIVE_PARENT = `sgac-inactiveparent-${RUN_ID}`;
    const HR_LEAF_UNDER_INACTIVE = `sgac-leafunderinactive-${RUN_ID}`;
    const deptNameLeafUnderInactive = `Leaf Under Inactive AutoCreate ${RUN_ID}`;
    const FAKE_INACTIVE_PARENT = hrDept(HR_INACTIVE_PARENT, "Inactive Parent", COMPANY_A, { isActive: false });
    const FAKE_LEAF_UNDER_INACTIVE = hrDept(HR_LEAF_UNDER_INACTIVE, deptNameLeafUnderInactive, COMPANY_A, { parentDepartmentId: HR_INACTIVE_PARENT });
    const user7 = await makeUser("user-inactiveparent");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-inactiveparent", HR_LEAF_UNDER_INACTIVE, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome7, row: row7 } = await driveSync(user7, "sgac-user-inactiveparent", [FAKE_INACTIVE_PARENT, FAKE_LEAF_UNDER_INACTIVE]);
    check("7. Worker run does NOT succeed", outcome7 !== "succeeded", outcome7);
    check("7. ...lastError mentions the inactive ancestor", /inactive/i.test(row7.lastError ?? ""), row7.lastError ?? "");
    const notCreated7 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameLeafUnderInactive) } } });
    check("7. ...no Department row was created", notCreated7 === null);

    // ══════════════════════ 8. Fail-closed: ancestor in a different Company ══════════════════════
    console.log("\n=== 8. An ancestor belonging to a DIFFERENT Company than the leaf fails closed (ambiguous/conflicting hierarchy) ===\n");
    const COMPANY_B = `Kinsen AutoCreate B ${RUN_ID}`;
    const HR_CROSS_PARENT = `sgac-crossparent-${RUN_ID}`;
    const HR_CROSS_LEAF = `sgac-crossleaf-${RUN_ID}`;
    const deptNameCrossLeaf = `Cross Company Leaf AutoCreate ${RUN_ID}`;
    const FAKE_CROSS_PARENT = hrDept(HR_CROSS_PARENT, "Cross Parent", COMPANY_B);
    const FAKE_CROSS_LEAF = hrDept(HR_CROSS_LEAF, deptNameCrossLeaf, COMPANY_A, { parentDepartmentId: HR_CROSS_PARENT });
    const user8 = await makeUser("user-crosscompany");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-crosscompany", HR_CROSS_LEAF, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome8, row: row8 } = await driveSync(user8, "sgac-user-crosscompany", [FAKE_CROSS_PARENT, FAKE_CROSS_LEAF]);
    check("8. Worker run does NOT succeed", outcome8 !== "succeeded", outcome8);
    check("8. ...lastError mentions the Company mismatch", /different company/i.test(row8.lastError ?? ""), row8.lastError ?? "");
    const notCreated8 = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameCrossLeaf) } } });
    check("8. ...no Department row was created", notCreated8 === null);

    // ══════════════════════ 9. Pre-existing ownership conflict is unaffected ══════════════════════
    console.log("\n=== 9. A Department that already exists but is NOT SQLGeneral-owned still fails closed (pre-existing behavior, unaffected by auto-creation) ===\n");
    const manualDeptName = `Manually Created AutoCreate ${RUN_ID}`;
    const manualDept = await prisma.department.create({
      data: { name: manualDeptName, normalizedName: normalizeDepartmentName(manualDeptName), slug: `sgac-manual-${RUN_ID}`, companyId: companyA.id, importSource: null },
    });
    departmentIds.push(manualDept.id);
    const HR_MANUAL_COLLISION = `sgac-manualcollision-${RUN_ID}`;
    const FAKE_MANUAL_COLLISION = hrDept(HR_MANUAL_COLLISION, manualDeptName, COMPANY_A);
    const user9 = await makeUser("user-manualcollision");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-manualcollision", HR_MANUAL_COLLISION, SG_COMPANY_A, COMPANY_A) });
    const { outcome: outcome9, row: row9 } = await driveSync(user9, "sgac-user-manualcollision", [FAKE_MANUAL_COLLISION]);
    check("9. Worker run does NOT succeed", outcome9 !== "succeeded", outcome9);
    check("9. ...lastError mentions it's not owned by SQLGeneral sync", /not owned by sqlgeneral sync/i.test(row9.lastError ?? ""), row9.lastError ?? "");
    const manualUnchanged = await prisma.department.findUnique({ where: { id: manualDept.id } });
    check("9. ...the manually-created Department is completely untouched", manualUnchanged?.importSource === null && manualUnchanged?.name === manualDeptName);

    // ══════════════════════ 10. Concurrency: two users racing onto the SAME missing Department ══════════════════════
    console.log("\n=== 10. Two concurrent sync attempts resolving to the SAME missing Department never create two rows ===\n");
    const HR_RACE = `sgac-race-${RUN_ID}`;
    const deptNameRace = `Race AutoCreate ${RUN_ID}`;
    const FAKE_RACE = hrDept(HR_RACE, deptNameRace, COMPANY_A);
    const userRace1 = await makeUser("user-race1");
    const userRace2 = await makeUser("user-race2");
    await svc.enqueueOrRecoverSqlGeneralUserSync(userRace1, "sgac-user-race1");
    await svc.enqueueOrRecoverSqlGeneralUserSync(userRace2, "sgac-user-race2");
    const raceRow1 = await attempt(userRace1);
    const raceRow2 = await attempt(userRace2);
    const raceToken1 = `token-${userRace1}-${raceRow1.attemptCount}`;
    const raceToken2 = `token-${userRace2}-${raceRow2.attemptCount}`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: userRace1 }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: raceToken1 } });
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: userRace2 }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: raceToken2 } });
    mockFindUserImpl = async (username: string) =>
      username === "sgac-user-race1"
        ? { outcome: "unique" as const, user: fakeHrUser("sgac-user-race1", HR_RACE, SG_COMPANY_A, COMPANY_A) }
        : { outcome: "unique" as const, user: fakeHrUser("sgac-user-race2", HR_RACE, SG_COMPANY_A, COMPANY_A) };
    const [raceOutcome1, raceOutcome2] = await Promise.all([
      svc.processClaimedSqlGeneralUserSync(raceRow1.id, raceToken1, new Date(), [FAKE_RACE]),
      svc.processClaimedSqlGeneralUserSync(raceRow2.id, raceToken2, new Date(), [FAKE_RACE]),
    ]);
    // acquireOrganizationSyncLock fails FAST (never blocks/waits) when the
    // singleton lock is already held — so under true concurrency, exactly
    // one of the two wins the lock and succeeds immediately, while the
    // other gets a retryable "lock is held" failure (never lost/corrupted,
    // never a duplicate) and would succeed on its NEXT attempt, same as
    // any other transient contention this worker already retries through.
    const raceOutcomes = [raceOutcome1, raceOutcome2];
    check("10. Exactly one of the two concurrent attempts succeeds immediately; the other is a retryable lock-contention failure (never lost, never corrupted)", raceOutcomes.filter((o) => o === "succeeded").length === 1 && raceOutcomes.filter((o) => o === "retrying").length === 1, `${raceOutcome1} / ${raceOutcome2}`);
    const createdRace = await prisma.department.findMany({ where: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameRace) } });
    if (createdRace[0]) departmentIds.push(createdRace[0].id);
    check("10. Exactly ONE Department row was created for the race, never two", createdRace.length === 1, `found ${createdRace.length}`);

    // Drive the retrying one a second time — confirms it REUSES the
    // Department the winner already created, rather than being permanently
    // stuck or creating a second one on its own eventual success.
    const retryingUser = raceOutcome1 === "retrying" ? userRace1 : userRace2;
    const retryingUsername = raceOutcome1 === "retrying" ? "sgac-user-race1" : "sgac-user-race2";
    const retryRow = await attempt(retryingUser);
    const retryToken = `token-${retryingUser}-${retryRow.attemptCount}-retry`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: retryingUser }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: retryToken } });
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser(retryingUsername, HR_RACE, SG_COMPANY_A, COMPANY_A) });
    const retryOutcome = await svc.processClaimedSqlGeneralUserSync(retryRow.id, retryToken, new Date(), [FAKE_RACE]);
    check("10. The second attempt succeeds on retry, reusing the SAME Department (no duplicate created)", retryOutcome === "succeeded", retryOutcome);
    const createdRaceAfterRetry = await prisma.department.count({ where: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameRace) } });
    check("10. ...still exactly ONE Department row after the retry", createdRaceAfterRetry === 1);

    // ══════════════════════ 11. Rollback on failure partway through creation ══════════════════════
    console.log("\n=== 11. A failure partway through Department creation (starter-config step) leaves no orphaned row, and the attempt stays retryable ===\n");
    const HR_ROLLBACK = `sgac-rollback-${RUN_ID}`;
    const deptNameRollback = `Rollback AutoCreate ${RUN_ID}`;
    const FAKE_ROLLBACK = hrDept(HR_ROLLBACK, deptNameRollback, COMPANY_A);
    const userRollback = await makeUser("user-rollback");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgac-user-rollback", HR_ROLLBACK, SG_COMPANY_A, COMPANY_A) });
    // Flag is consumed (set back to null) by the FIRST matching call inside
    // the mocked config-starter-data module — set it fresh right before
    // driving this one attempt so no earlier step in this file can consume
    // it first.
    await svc.enqueueOrRecoverSqlGeneralUserSync(userRollback, "sgac-user-rollback");
    const rollbackRow = await attempt(userRollback);
    const rollbackToken = `token-${userRollback}-${rollbackRow.attemptCount}`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: userRollback }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: rollbackToken } });
    const pendingDept = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameRollback) } } });
    check("11. Setup: the target Department does not exist yet", pendingDept === null);
    // Asserts the invariant the transaction itself guarantees: if
    // tx.department.create() succeeds but a LATER statement in the SAME
    // transaction throws, Prisma's $transaction rolls back every statement
    // in it, including the create. The flag fires exactly once (consumed
    // by the first call, real implementation used otherwise), so only this
    // one attempt's starter-config step fails.
    shouldThrowConfigError = true;
    const rollbackOutcome = await svc.processClaimedSqlGeneralUserSync(rollbackRow.id, rollbackToken, new Date(), [FAKE_ROLLBACK]);
    check("11. Worker run does NOT succeed (the injected failure propagates)", rollbackOutcome !== "succeeded", rollbackOutcome);
    const rollbackAttemptRow = await attempt(userRollback);
    check("11. ...the attempt stays retryable (PENDING), not corrupted", rollbackAttemptRow.status === "PENDING");
    check("11. ...lastError captures the injected failure", /injected failure/i.test(rollbackAttemptRow.lastError ?? ""), rollbackAttemptRow.lastError ?? "");
    const noOrphanDept = await prisma.department.findUnique({ where: { companyId_normalizedName: { companyId: companyA.id, normalizedName: normalizeDepartmentName(deptNameRollback) } } });
    check("11. ...no orphaned Department row was left behind (the whole transaction rolled back)", noOrphanDept === null);
    if (noOrphanDept) departmentIds.push(noOrphanDept.id);
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
      ["departments (any remaining, by RUN_ID name pattern)", () => prisma.department.deleteMany({ where: { name: { contains: `AutoCreate ${RUN_ID}` } } })],
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
