/**
 * ACCEPTANCE coverage for "SQLGeneral Authoritative Primary Placement"
 * (REQUIRED DO #1-#8) plus the 3 rollout blockers closed in a later round
 * (preserve Microsoft's existing placement behavior while the rollout gate
 * is off; distinguish pending first-time placement from legitimate
 * secondary-only access, for ANY membership count; resolve the
 * User.companyId dual-writer precedence against a SUBSEQUENT Microsoft
 * sync). Complements the two existing suites:
 *   - scripts/test-microsoft-organization-placement-integrity.ts — proves
 *     Microsoft's PRIMARY placement is UNCHANGED while the rollout gate is
 *     off (the default), and that flipping the SAME gate on/off is a true
 *     two-way toggle (its scenario 13).
 *   - scripts/test-sqlgeneral-user-sync.ts — proves the SECONDARY-only
 *     (isSqlGeneralPrimaryPlacementEnabled() === false, today's default)
 *     worker/enqueue/retry/Preview mechanics.
 *
 * This file is specifically about applySqlGeneralPrimaryPlacement and the
 * primary-lock mechanism, run with SQLGENERAL_PRIMARY_PLACEMENT_ENABLED
 * forced to "true" IN THIS PROCESS ONLY (never written to .env/.env.local —
 * see the explicit override below) so the worker's primary-placement
 * branch is actually exercised. SQLGENERAL_SYNC_ENABLED itself is left
 * alone (processClaimedSqlGeneralUserSync is the same testable seam
 * test-sqlgeneral-user-sync.ts uses, which bypasses that outer gate — see
 * processDueSqlGeneralUserSyncs's own doc comment for why that's safe here).
 *
 * Covers: first login (no interim Microsoft primary, enqueue local-only,
 * zero network calls), pending access vs. legitimate secondary-only for
 * 0/1/2+ memberships, existing-user migration (untouched until SQLGeneral
 * resolves them), primary locks (blocks SQLGeneral, never MANUAL, unlock
 * restores, locking with no primary fails closed), A->B transitions (old
 * primary fully deactivated, including an unlocked MANUAL-sourced one),
 * secondary preservation, same-session authorization, missing/conflicting
 * mappings, failures (API error / inactive HR), and User.companyId
 * precedence against a subsequent Microsoft sync.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-primary-placement.ts
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

  // In-process only — never written to any .env file. Flipped for this
  // suite specifically so applySqlGeneralPrimaryPlacement's branch of
  // processOne is actually exercised; the real deployment's config is
  // completely untouched by running this file.
  process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  type FindUserFn = typeof realClient.findSqlGeneralUserByUsername;
  type ListDeptFn = typeof realClient.listAllSqlGeneralDepartments;
  let mockFindUserImpl: FindUserFn = async () => {
    throw new Error("mock: no findSqlGeneralUserByUsername impl installed for this check");
  };
  let mockListDeptImpl: ListDeptFn = async () => ({ ok: true, departments: [] });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (username: string) => mockFindUserImpl(username),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
    },
  });

  check("SQLGENERAL_PRIMARY_PLACEMENT_ENABLED is forced true for this suite only", realClient.isSqlGeneralPrimaryPlacementEnabled());

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const membershipSvc = await import("@/lib/services/department-membership-service");
  const scopeSvc = await import("@/lib/services/department-scope-service");
  const workspaceSvc = await import("@/lib/services/workspace-service");
  const microsoftSyncSvc = await import("@/lib/services/microsoft-department-sync-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  function mockGraphMeForMicrosoft(opts: { companyName: string | null; department: string | null; oid: string; mail?: string | null }) {
    (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          id: opts.oid, displayName: "SGP Microsoft User", mail: opts.mail ?? null, userPrincipalName: null,
          userType: "Member", companyName: opts.companyName, department: opts.department, jobTitle: null,
        }),
        { status: 200 }
      )) as typeof fetch;
  }

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgp-${tag}-${RUN_ID}@kinsen.gr`, name: `SGP ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true },
    });
    userIds.push(u.id);
    return u.id;
  }

  const attempt = (userId: string) => prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId } });

  /** Enqueues, claims, and processes ONE sync attempt end-to-end, reusing the exact worker seam test-sqlgeneral-user-sync.ts uses. `departments` is the SAME batch-fetched snapshot processDueSqlGeneralUserSyncs would pass — a direct parameter, never re-read from mockListDeptImpl (which only backs listAllSqlGeneralDepartments, a different caller). */
  async function driveSync(userId: string, username: string, departments = [FAKE_DEPT_A, FAKE_DEPT_B], now = new Date()) {
    await svc.enqueueOrRecoverSqlGeneralUserSync(userId, username);
    const row = await attempt(userId);
    const token = `token-${userId}-${row.attemptCount}`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId }, data: { status: "PROCESSING", claimedAt: now, claimToken: token } });
    const outcome = await svc.processClaimedSqlGeneralUserSync(row.id, token, now, departments);
    return { outcome, row: await attempt(userId) };
  }

  const fakeHrUser = (username: string, hrDepartmentId: string, active = true, companyId: string | null = null) => ({
    username, mail: null, hrDepartmentId, department: null, companyId, company: COMPANY_NAME, active,
    managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
  });

  const COMPANY_NAME = `SGP Company ${RUN_ID}`;
  const FAKE_DEPT_A = { id: "sgp-a", description: `SGP Dept A ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: COMPANY_NAME, companyShortname: null, creationDate: null, updateTimestamp: null };
  const FAKE_DEPT_B = { id: "sgp-b", description: `SGP Dept B ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: COMPANY_NAME, companyShortname: null, creationDate: null, updateTimestamp: null };
  mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_A, FAKE_DEPT_B] });

  try {
    console.log("\n=== Setup: a SQLGeneral-owned Company with two SQLGeneral-owned Departments (A, B) ===\n");
    const company = await prisma.company.create({
      data: { name: COMPANY_NAME, normalizedName: normalizeCompanyName(COMPANY_NAME), importSource: OrganizationNodeSource.SQLGENERAL },
    });
    companyIds.push(company.id);
    const deptA = await prisma.department.create({
      data: { name: FAKE_DEPT_A.description, normalizedName: normalizeDepartmentName(FAKE_DEPT_A.description), slug: `sgp-a-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    const deptB = await prisma.department.create({
      data: { name: FAKE_DEPT_B.description, normalizedName: normalizeDepartmentName(FAKE_DEPT_B.description), slug: `sgp-b-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    const deptSecondary = await prisma.department.create({
      data: { name: `SGP Secondary ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGP Secondary ${RUN_ID}`), slug: `sgp-secondary-${RUN_ID}` },
    });
    // Under the SAME SQLGeneral-owned Company, but this Department row
    // itself has no importSource — a genuine department-level ownership
    // collision, distinct from the company-level check.
    const deptUnowned = await prisma.department.create({
      data: { name: `SGP Unowned ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGP Unowned ${RUN_ID}`), slug: `sgp-unowned-${RUN_ID}`, companyId: company.id },
    });
    departmentIds.push(deptA.id, deptB.id, deptSecondary.id, deptUnowned.id);
    const adminId = await makeUser("admin-actor");

    // ── 1. First login: enqueue is a pure local write, zero network calls, no interim primary ──
    console.log("\n1. First login: enqueue is local-only (zero network calls), never an interim primary\n");
    {
      const user = await makeUser("first-login");
      const originalFetch = global.fetch;
      let fetchCalled = false;
      global.fetch = (async (...args: Parameters<typeof fetch>) => {
        fetchCalled = true;
        return originalFetch(...args);
      }) as typeof fetch;
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "first-login-username");
      global.fetch = originalFetch;
      check("1. enqueueOrRecoverSqlGeneralUserSync makes zero network calls", !fetchCalled);
      const row = await attempt(user);
      check("1. Row enqueued as PENDING with the captured username", row.status === "PENDING" && row.sqlGeneralUsername === "first-login-username");
      const after = await prisma.user.findUnique({ where: { id: user } });
      check("1. User.departmentId stays null — enqueue never implies an interim primary", after?.departmentId === null);
      const primaryCount = await prisma.departmentMembership.count({ where: { userId: user, isPrimary: true } });
      check("1. Zero primary memberships exist yet", primaryCount === 0);
    }

    // ── 2. Pending access vs. legitimate secondary-only access — 0/1/2+ memberships ──
    console.log("\n2. Pending vs. legitimate secondary-only: 0/1/2+ purely-automatic memberships stay pending; a MANUAL-sourced grant is preserved regardless of count\n");
    {
      // 2a. Zero memberships at all — trivially pending (nothing to narrow to).
      const userZero = await makeUser("pending-zero");
      const ctxZero = await workspaceSvc.resolveActiveWorkspace(userZero, Role.USER, undefined);
      check("2a. Zero memberships: zero accessible departments", ctxZero.departmentId === null && ctxZero.departments.length === 0);

      // 2b. Exactly ONE purely-automatic (non-MANUAL) secondary membership,
      // no primary — the original production bug's exact shape — must stay pending.
      const userOne = await makeUser("pending-one-auto");
      await prisma.departmentMembership.create({
        data: { userId: userOne, departmentId: deptSecondary.id, role: DepartmentRole.VIEWER, source: MembershipSource.MICROSOFT_DEPARTMENT, isPrimary: false, isActive: true },
      });
      const ctxOne = await workspaceSvc.resolveActiveWorkspace(userOne, Role.USER, undefined);
      check("2b. One automatic membership: does not hand this user that department", ctxOne.departmentId !== deptSecondary.id);
      check("2b. One automatic membership: zero accessible departments (pending)", ctxOne.departmentId === null && ctxOne.departments.length === 0);

      // 2c. TWO+ purely-automatic secondary memberships, no primary — the
      // broadened half of DO #2: must ALSO stay pending, not just the
      // single-membership case.
      const userTwo = await makeUser("pending-two-auto");
      await prisma.departmentMembership.create({
        data: { userId: userTwo, departmentId: deptSecondary.id, role: DepartmentRole.VIEWER, source: MembershipSource.MICROSOFT_DEPARTMENT, isPrimary: false, isActive: true },
      });
      await prisma.departmentMembership.create({
        data: { userId: userTwo, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.SQLGENERAL_DEPARTMENT, isPrimary: false, isActive: true },
      });
      const ctxTwo = await workspaceSvc.resolveActiveWorkspace(userTwo, Role.USER, undefined);
      check("2c. Two+ automatic memberships, no primary: ALSO stays pending (zero accessible departments) — not just the single-membership fallback", ctxTwo.departmentId === null && ctxTwo.departments.length === 0);

      // 2d. Legitimate secondary-only: ONE MANUAL-sourced membership, no
      // primary — a human admin's explicit decision — must be PRESERVED,
      // not gated. Falls through to the pre-existing single-membership
      // convenience fallback exactly as before this round.
      const userManualOne = await makeUser("legit-secondary-one");
      await membershipSvc.grantManualMembership(userManualOne, deptSecondary.id, { role: DepartmentRole.VIEWER });
      const ctxManualOne = await workspaceSvc.resolveActiveWorkspace(userManualOne, Role.USER, undefined);
      check("2d. Legitimate MANUAL secondary-only (1 membership): resolves to that department, NOT gated", ctxManualOne.departmentId === deptSecondary.id);

      // 2e. Legitimate secondary-only: a MIX of MANUAL + automatic
      // memberships, no primary — still preserved (at least one human
      // decision exists), falling through to the pre-existing "ambiguous,
      // no narrowing" ergonomics for 2+ memberships.
      const userMixed = await makeUser("legit-secondary-mixed");
      await membershipSvc.grantManualMembership(userMixed, deptSecondary.id, { role: DepartmentRole.VIEWER });
      await prisma.departmentMembership.create({
        data: { userId: userMixed, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MICROSOFT_DEPARTMENT, isPrimary: false, isActive: true },
      });
      const ctxMixed = await workspaceSvc.resolveActiveWorkspace(userMixed, Role.USER, undefined);
      check("2e. Legitimate mixed MANUAL+automatic secondary-only (2 memberships): NOT gated — at least one accessible department reported", ctxMixed.departments.length > 0);
    }

    // ── 3. Existing-user migration: untouched until SQLGeneral actually resolves them ──
    console.log("\n3. Existing-user migration: a real existing primary is completely unaffected while SQLGeneral has not yet resolved this user\n");
    {
      const user = await makeUser("migration-pending");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      // Enqueue only — deliberately never claimed/processed, simulating "SQLGeneral
      // hasn't resolved this user yet" (no backfill, no background migration).
      await svc.enqueueOrRecoverSqlGeneralUserSync(user, "migration-pending-username");
      const after = await prisma.user.findUnique({ where: { id: user } });
      const primary = await prisma.departmentMembership.findFirst({ where: { userId: user, isPrimary: true, isActive: true } });
      check("3. User.departmentId is still the pre-existing MANUAL department", after?.departmentId === deptSecondary.id);
      check("3. The MANUAL primary row is untouched", primary?.source === MembershipSource.MANUAL && primary?.departmentId === deptSecondary.id);
    }

    // ── 4. Primary locks ──
    console.log("\n4. Primary locks: blocks SQLGeneral, never MANUAL, unlock restores, locking with no primary fails closed\n");
    {
      // 4a/4b: lock blocks SQLGeneral, never MANUAL.
      const user = await makeUser("lock-basic");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      const lockResult = await membershipSvc.setPrimaryDepartmentLock(user, true, adminId);
      check("4a. Locking succeeds for a user with an active primary", lockResult.ok === true && lockResult.locked === true);

      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("lock-basic-username", FAKE_DEPT_A.id) });
      const { outcome: lockedOutcome, row: lockedRow } = await driveSync(user, "lock-basic-username");
      check("4a. A locked primary blocks the automatic SQLGeneral placement attempt (retried, not applied)", lockedOutcome === "retrying");
      check("4a. ...with the specific, distinguishable lock-blocked failure reason", (lockedRow.lastError ?? "").includes("locked"));
      const afterLocked = await prisma.user.findUnique({ where: { id: user } });
      check("4a. User.departmentId is unchanged (still the locked MANUAL department)", afterLocked?.departmentId === deptSecondary.id);

      const manualResult = await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      check("4b. A lock NEVER blocks a direct MANUAL admin edit — it proceeds and switches the primary", manualResult.outcome === "switched" && manualResult.primaryMembership.departmentId === deptA.id);
      const oldRowAfterManual = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user, departmentId: deptSecondary.id } } });
      check("4b. The old (locked) row is demoted but NOT deactivated by a MANUAL call (no deactivateObsoleteAutomaticPrimary)", oldRowAfterManual?.isPrimary === false && oldRowAfterManual?.isActive === true);

      // Re-lock the NEW primary (deptA) explicitly — a lock does not carry over automatically.
      const relock = await membershipSvc.setPrimaryDepartmentLock(user, true, adminId);
      check("4b-sanity. Re-locking the new primary succeeds", relock.ok === true);

      // 4c: unlock restores normal automatic behavior.
      const unlockResult = await membershipSvc.setPrimaryDepartmentLock(user, false, adminId);
      check("4c. Unlocking succeeds", unlockResult.ok === true && unlockResult.locked === false);
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("lock-basic-username-2", FAKE_DEPT_B.id) });
      const { outcome: unlockedOutcome } = await driveSync(user, "lock-basic-username-2");
      check("4c. SQLGeneral placement now succeeds once unlocked", unlockedOutcome === "succeeded");
      const afterUnlocked = await prisma.user.findUnique({ where: { id: user } });
      check("4c. User.departmentId now reflects the SQLGeneral-placed department", afterUnlocked?.departmentId === deptB.id);

      // 4d: locking with no active primary at all fails closed.
      const noPrimaryUser = await makeUser("lock-no-primary");
      const noPrimaryLock = await membershipSvc.setPrimaryDepartmentLock(noPrimaryUser, true, adminId);
      check("4d. Locking a user with NO active primary fails closed (no_active_primary), never fabricates one", noPrimaryLock.ok === false && (noPrimaryLock as { reason: string }).reason === "no_active_primary");
    }

    // ── 5. A->B transitions, including an unlocked MANUAL old primary ──
    console.log("\n5. A->B transitions: the obsolete primary is fully deactivated, even when it was MANUAL-sourced (unlocked)\n");
    {
      const user = await makeUser("a-to-b");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("a-to-b-username", FAKE_DEPT_A.id) });
      const { outcome: firstOutcome } = await driveSync(user, "a-to-b-username");
      check("5. First SQLGeneral placement succeeds, replacing the unlocked MANUAL primary", firstOutcome === "succeeded");
      const afterFirst = await prisma.user.findUnique({ where: { id: user } });
      check("5. User.departmentId now points at Dept A", afterFirst?.departmentId === deptA.id);
      const oldManualRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user, departmentId: deptSecondary.id } } });
      check("5. The old MANUAL primary is FULLY deactivated (isPrimary:false AND isActive:false) — DO #5, no `!oldIsManual` exception any more", oldManualRow?.isPrimary === false && oldManualRow?.isActive === false);

      // Second SQLGeneral run: HR now reports Dept B — a genuine A->B move.
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("a-to-b-username", FAKE_DEPT_B.id) });
      const { outcome: secondOutcome } = await driveSync(user, "a-to-b-username");
      check("5. Second run (A->B move) also succeeds", secondOutcome === "succeeded");
      const afterSecond = await prisma.user.findUnique({ where: { id: user } });
      check("5. User.departmentId now points at Dept B", afterSecond?.departmentId === deptB.id);
      const deptARowAfterMove = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user, departmentId: deptA.id } } });
      check("5. The old SQLGENERAL_DEPARTMENT primary (Dept A) is fully deactivated too", deptARowAfterMove?.isPrimary === false && deptARowAfterMove?.isActive === false);
      const activePrimaryCount = await prisma.departmentMembership.count({ where: { userId: user, isPrimary: true, isActive: true } });
      check("5. Exactly one active primary after the move", activePrimaryCount === 1);
    }

    // ── 6. Secondary preservation ──
    console.log("\n6. Secondary preservation: independently-approved secondary memberships are untouched by a primary placement run\n");
    {
      const user = await makeUser("secondary-preserved");
      const secondaryMembership = await membershipSvc.grantManualMembership(user, deptSecondary.id, { role: DepartmentRole.VIEWER });
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("secondary-preserved-username", FAKE_DEPT_A.id) });
      const { outcome } = await driveSync(user, "secondary-preserved-username");
      check("6. Primary placement succeeds", outcome === "succeeded");
      const secondaryAfter = await prisma.departmentMembership.findUnique({ where: { id: secondaryMembership.id } });
      check("6. The secondary MANUAL membership is completely untouched (still active, still non-primary, still MANUAL)", secondaryAfter?.isActive === true && secondaryAfter?.isPrimary === false && secondaryAfter?.source === MembershipSource.MANUAL);
      const primaryRow = await prisma.departmentMembership.findFirst({ where: { userId: user, isPrimary: true, isActive: true } });
      check("6. ...while the new primary is the SQLGeneral-placed Dept A, a completely separate row", primaryRow?.departmentId === deptA.id);
    }

    // ── 7. Same-session authorization ──
    console.log("\n7. Same-session authorization: a deactivated old-department membership is immediately unauthorized, no re-login needed\n");
    {
      const user = await makeUser("same-session-auth");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("same-session-auth-username", FAKE_DEPT_A.id) });
      await driveSync(user, "same-session-auth-username");
      const beforeMembership = await membershipSvc.getMembership(user, deptA.id);
      check("7. Sanity: the user genuinely has a live membership in Dept A right now", beforeMembership !== null);

      // Move to Dept B — Dept A's membership is fully deactivated as part of the SAME call.
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("same-session-auth-username", FAKE_DEPT_B.id) });
      await driveSync(user, "same-session-auth-username");

      const afterOldMembership = await membershipSvc.getMembership(user, deptA.id);
      check("7. getMembership for the OLD department returns null IMMEDIATELY — no session refresh, no re-login, in the same process", afterOldMembership === null);
      const canActOld = await scopeSvc.canActOnEntity(user, Role.USER, deptA.id, "ticket.view", false);
      check("7. canActOnEntity for the old department is denied in the same request", canActOld === false);
      const newMembership = await membershipSvc.getMembership(user, deptB.id);
      check("7. getMembership for the NEW department is live and active", newMembership !== null && newMembership.isActive === true);
    }

    // ── 8. Missing / conflicting mappings fail closed ──
    console.log("\n8. Missing/conflicting mappings: fails closed, no primary change, existing primary (if any) untouched\n");
    {
      // 8a. HrDepartmentId with no matching fetched Department at all.
      const user = await makeUser("missing-mapping");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("missing-mapping-username", "sgp-does-not-exist") });
      const { outcome: missingOutcome, row: missingRow } = await driveSync(user, "missing-mapping-username");
      check("8a. An HrDepartmentId with no matching fetched Department retries (department_not_found)", missingOutcome === "retrying");
      check("8a. ...with a specific, descriptive failure reason", (missingRow.lastError ?? "").includes("does not match any fetched SQLGeneral Department"));
      const afterMissing = await prisma.user.findUnique({ where: { id: user } });
      check("8a. No primary was created", afterMissing?.departmentId === null);

      // 8b. HrDepartmentId resolves to a Department this sync does NOT own (ownership conflict).
      const user2 = await makeUser("conflict-mapping");
      await membershipSvc.setPrimaryDepartmentMembership(user2, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      const FAKE_DEPT_UNOWNED = { id: "sgp-unowned-hr", description: deptUnowned.name, isActive: true, parentDepartmentId: null, country: null, company: COMPANY_NAME, companyShortname: null, creationDate: null, updateTimestamp: null };
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("conflict-mapping-username", FAKE_DEPT_UNOWNED.id) });
      const { outcome: conflictOutcome, row: conflictRow } = await driveSync(user2, "conflict-mapping-username", [FAKE_DEPT_A, FAKE_DEPT_B, FAKE_DEPT_UNOWNED]);
      check("8b. A Department this sync does not own is refused, never claimed (retries)", conflictOutcome === "retrying");
      check("8b. ...with a specific ownership-conflict reason", (conflictRow.lastError ?? "").includes("not owned by SQLGeneral sync"));
      const afterConflict = await prisma.user.findUnique({ where: { id: user2 } });
      check("8b. The pre-existing MANUAL primary is completely untouched", afterConflict?.departmentId === deptSecondary.id);
    }

    // ── 9. Failures: API error and inactive HR record fail closed via the existing retry mechanism ──
    console.log("\n9. Failures: a SQLGeneral API error and an inactive HR record both fail closed and eventually reach FAILED_PERMANENT via the SAME existing bounded retry\n");
    {
      // 9a. API call throws outright.
      const user = await makeUser("api-failure");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      mockFindUserImpl = async () => {
        throw new Error("mock: SQLGeneral API is unreachable");
      };
      const { outcome: apiFailOutcome } = await driveSync(user, "api-failure-username");
      check("9a. A thrown API error is caught and retried, never crashes the worker", apiFailOutcome === "retrying");
      const afterApiFail = await prisma.user.findUnique({ where: { id: user } });
      check("9a. The existing primary is untouched by the failed attempt", afterApiFail?.departmentId === deptSecondary.id);

      // 9b. Inactive HR record — drive to FAILED_PERMANENT via repeated attempts, same mechanism.
      const user2 = await makeUser("inactive-hr");
      await membershipSvc.setPrimaryDepartmentMembership(user2, deptSecondary.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("inactive-hr-username", FAKE_DEPT_A.id, false) });
      await svc.enqueueOrRecoverSqlGeneralUserSync(user2, "inactive-hr-username");
      let lastOutcome: string | null = null;
      for (let i = 0; i < svc.MAX_ATTEMPTS; i++) {
        const row = await attempt(user2);
        const token = `inactive-hr-token-${i}`;
        await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: user2 }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: token } });
        lastOutcome = await svc.processClaimedSqlGeneralUserSync(row.id, token, new Date(), [FAKE_DEPT_A, FAKE_DEPT_B]);
      }
      check(`9b. After ${svc.MAX_ATTEMPTS} attempts against an inactive HR record, the attempt reaches FAILED_PERMANENT`, lastOutcome === "failed_permanent", `lastOutcome=${lastOutcome}`);
      const finalRow = await attempt(user2);
      check("9b. ...with the inactive-HR failure reason recorded", (finalRow.lastError ?? "").includes("is not Active"));
      const afterInactiveHr = await prisma.user.findUnique({ where: { id: user2 } });
      check("9b. The existing primary was NEVER touched, through every retry and at FAILED_PERMANENT", afterInactiveHr?.departmentId === deptSecondary.id);
      const primaryRow2 = await prisma.departmentMembership.findFirst({ where: { userId: user2, isPrimary: true, isActive: true } });
      check("9b. ...and it is still the original MANUAL row, not replaced or deactivated", primaryRow2?.source === MembershipSource.MANUAL && primaryRow2?.departmentId === deptSecondary.id);
    }

    // ── 10. User.companyId precedence against a SUBSEQUENT Microsoft sync ──
    console.log("\n10. User.companyId precedence: once SQLGeneral is authoritative for a user, a SUBSEQUENT Microsoft sync — even after a rollout-flag rollback — never reclaims their Company\n");
    {
      const user = await makeUser("company-precedence");
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("company-precedence-username", FAKE_DEPT_A.id) });
      const { outcome } = await driveSync(user, "company-precedence-username");
      check("10. SQLGeneral placement succeeds", outcome === "succeeded");
      const afterSqlGeneral = await prisma.user.findUnique({ where: { id: user } });
      check("10. User.companyId now matches the SQLGeneral-verified Company", afterSqlGeneral?.companyId === company.id);
      check("10. isPrimaryCompanySqlGeneralAuthoritative reports true for this user", await membershipSvc.isPrimaryCompanySqlGeneralAuthoritative(user));

      // Rollback: the rollout gate flips OFF, and Microsoft's reinstated
      // PRIMARY-placement path runs again on this user's next login,
      // reporting a COMPLETELY DIFFERENT Microsoft-side company/department.
      const OTHER_COMPANY = `SGP Other Microsoft Company ${RUN_ID}`;
      const OTHER_DEPT = `SGP Other Microsoft Dept ${RUN_ID}`;
      process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "false";
      mockGraphMeForMicrosoft({ companyName: OTHER_COMPANY, department: OTHER_DEPT, mail: `sgp-company-precedence-${RUN_ID}@kinsen.gr`, oid: `msoid-${user}` });
      await microsoftSyncSvc.syncMicrosoftUserDepartment({ accessToken: "fake", userId: user, oid: `msoid-${user}`, email: `sgp-company-precedence-${RUN_ID}@kinsen.gr`, name: "Company Precedence" });
      process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

      const afterMicrosoftRollback = await prisma.user.findUnique({ where: { id: user }, include: { company: true } });
      check("10. User.companyId is STILL the SQLGeneral-verified Company — Microsoft's reinstated placement never reclaimed it", afterMicrosoftRollback?.companyId === company.id);
      check("10. ...confirmed by name, not just id", afterMicrosoftRollback?.company?.name === COMPANY_NAME);
      const noRogueCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(OTHER_COMPANY) } });
      check("10. Microsoft's reported OTHER company was never even created locally as a side effect", noRogueCompany === null);
    }

    // ── 11. Read-only preview accuracy (REQUIRED DO #5) ────────────────────
    console.log("\n11. Read-only preview accurately reports proposed moves, blocked mappings, inactive identities and explicit Primary locks\n");
    {
      const userWouldPlace = await makeUser("preview-would-place");
      const userAlreadyAligned = await makeUser("preview-already-aligned");
      const userBlockedLocked = await makeUser("preview-blocked-locked");
      const userBlockedInactive = await makeUser("preview-blocked-inactive");
      const userBlockedUnmapped = await makeUser("preview-blocked-unmapped");
      const userBlockedIdentity = await makeUser("preview-blocked-identity");
      const userBlockedConflict = await makeUser("preview-blocked-conflict");

      // userAlreadyAligned: a REAL prior SQLGeneral placement into Dept A.
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("preview-already-aligned-username", FAKE_DEPT_A.id) });
      await driveSync(userAlreadyAligned, "preview-already-aligned-username");

      // userBlockedLocked: a locked primary in Dept B — any automatic move is blocked.
      await membershipSvc.setPrimaryDepartmentMembership(userBlockedLocked, deptB.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      await membershipSvc.setPrimaryDepartmentLock(userBlockedLocked, true, adminId);

      const FAKE_DEPT_UNOWNED_PREVIEW = { id: "sgp-unowned-preview", description: deptUnowned.name, isActive: true, parentDepartmentId: null, country: null, company: COMPANY_NAME, companyShortname: null, creationDate: null, updateTimestamp: null };
      mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_A, FAKE_DEPT_B, FAKE_DEPT_UNOWNED_PREVIEW] });

      await svc.enqueueOrRecoverSqlGeneralUserSync(userWouldPlace, "preview-would-place-username");
      await svc.enqueueOrRecoverSqlGeneralUserSync(userBlockedLocked, "preview-blocked-locked-username");
      await svc.enqueueOrRecoverSqlGeneralUserSync(userBlockedInactive, "preview-blocked-inactive-username");
      await svc.enqueueOrRecoverSqlGeneralUserSync(userBlockedUnmapped, "preview-blocked-unmapped-username");
      await svc.enqueueOrRecoverSqlGeneralUserSync(userBlockedIdentity, "preview-blocked-identity-username");
      await svc.enqueueOrRecoverSqlGeneralUserSync(userBlockedConflict, "preview-blocked-conflict-username");

      const usernameToResult: Record<string, Awaited<ReturnType<typeof realClient.findSqlGeneralUserByUsername>>> = {
        "preview-already-aligned-username": { outcome: "unique", user: fakeHrUser("preview-already-aligned-username", FAKE_DEPT_A.id) },
        "preview-would-place-username": { outcome: "unique", user: fakeHrUser("preview-would-place-username", FAKE_DEPT_A.id) },
        "preview-blocked-locked-username": { outcome: "unique", user: fakeHrUser("preview-blocked-locked-username", FAKE_DEPT_A.id) },
        "preview-blocked-inactive-username": { outcome: "unique", user: fakeHrUser("preview-blocked-inactive-username", FAKE_DEPT_A.id, false) },
        "preview-blocked-unmapped-username": { outcome: "unique", user: fakeHrUser("preview-blocked-unmapped-username", "sgp-does-not-exist") },
        "preview-blocked-identity-username": { outcome: "not_found" },
        "preview-blocked-conflict-username": { outcome: "unique", user: fakeHrUser("preview-blocked-conflict-username", FAKE_DEPT_UNOWNED_PREVIEW.id) },
      };
      mockFindUserImpl = async (username: string) => {
        const result = usernameToResult[username];
        if (!result) throw new Error(`unexpected username in preview mock: ${username}`);
        return result;
      };

      const previewResult = await svc.previewSqlGeneralUserSync({
        userIds: [userWouldPlace, userAlreadyAligned, userBlockedLocked, userBlockedInactive, userBlockedUnmapped, userBlockedIdentity, userBlockedConflict],
      });
      mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_A, FAKE_DEPT_B] });
      check("11. previewSqlGeneralUserSync itself succeeds", previewResult.ok === true);
      if (previewResult.ok) {
        const byUser = new Map(previewResult.rows.map((r) => [r.userId, r]));
        check("11. would_place: a resolvable new placement is correctly proposed", byUser.get(userWouldPlace)?.primaryChangeOutcome === "would_place");
        check("11. already_aligned: a user already correctly SQLGeneral-placed is reported as a no-op", byUser.get(userAlreadyAligned)?.primaryChangeOutcome === "already_aligned");
        check("11. ...with currentPrimaryDepartmentId reflecting their real current primary", byUser.get(userAlreadyAligned)?.currentPrimaryDepartmentId === deptA.id);
        check("11. blocked_locked: an explicitly locked primary is reported as blocked, not silently would_place", byUser.get(userBlockedLocked)?.primaryChangeOutcome === "blocked_locked");
        check("11. ...with currentPrimaryLocked correctly true", byUser.get(userBlockedLocked)?.currentPrimaryLocked === true);
        check("11. blocked_inactive_hr: an inactive HR record is reported as blocked, distinctly from a resolution failure", byUser.get(userBlockedInactive)?.primaryChangeOutcome === "blocked_inactive_hr");
        check("11. blocked_unmapped_department: an HrDepartmentId with no matching fetched Department is reported as blocked", byUser.get(userBlockedUnmapped)?.primaryChangeOutcome === "blocked_unmapped_department");
        check("11. blocked_identity_unresolved: a not_found username match is reported as blocked, with the right usernameMatch", byUser.get(userBlockedIdentity)?.primaryChangeOutcome === "blocked_identity_unresolved" && byUser.get(userBlockedIdentity)?.usernameMatch === "not_found");
        check("11. blocked_local_conflict: a Department this sync does not own is reported as a local conflict, never a silent would_place", byUser.get(userBlockedConflict)?.primaryChangeOutcome === "blocked_local_conflict" && byUser.get(userBlockedConflict)?.localMatch === "conflict_other_owner");
      }
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
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
