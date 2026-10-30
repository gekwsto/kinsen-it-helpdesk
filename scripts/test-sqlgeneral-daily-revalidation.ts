/**
 * Focused verification: "SQLGeneral Primary Placement: Automatic Daily
 * Revalidation" — the existing worker (claimBatch/processOne/
 * processDueSqlGeneralUserSyncs in lib/services/sqlgeneral-user-sync-service.ts)
 * extended to revalidate SUCCEEDED attempts once per rolling 24h window,
 * reusing the SAME queue/locking/retry/claim mechanisms (no second
 * scheduler). Covers every ACCEPTANCE item from that round:
 *   1. successful daily revalidation (a SUCCEEDED row past the 24h window
 *      gets re-claimed and re-processed)
 *   2. unchanged-Department no-op (a MANUAL-protected row is genuinely
 *      untouched — byte-identical updatedAt)
 *   3. a real A->B move triggered by a changed HR Department
 *   4. role preservation (both the protected no-op and the one genuinely-
 *      changing case, during a REVALIDATION cycle specifically)
 *   5. Primary Lock respected during revalidation
 *   6. SQLGeneral outage/retry during revalidation: deferred (SUCCEEDED,
 *      never FAILED_PERMANENT), existing membership preserved, no
 *      immediate retry-storm
 *   7. concurrency: two/three simultaneous claims on the SAME due-for-
 *      revalidation row never double-process it
 *   8. Preview/worker parity for all four primaryChangeOutcome buckets
 *      (would_place / already_aligned / would_realign_source_only /
 *      would_change_role)
 *   9. flags-OFF preservation: SQLGENERAL_SYNC_ENABLED unset claims
 *      nothing at all, including a SUCCEEDED row due for revalidation
 *
 * Entirely local/dev-DB. Never touches production. Never enables real
 * sync flags outside this process.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-sqlgeneral-daily-revalidation.ts
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
const HOUR_MS = 60 * 60 * 1000;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const originalSyncEnabled = process.env.SQLGENERAL_SYNC_ENABLED;
  const originalPrimaryEnabled = process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED;
  process.env.SQLGENERAL_SYNC_ENABLED = "true";
  process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  type FindUserFn = typeof realClient.findSqlGeneralUserByUsername;
  let mockFindUserImpl: FindUserFn = async () => {
    throw new Error("mock: no impl installed");
  };
  let mockListDeptImpl: typeof realClient.listAllSqlGeneralDepartments = async () => ({ ok: true, departments: [] });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const membershipSvc = await import("@/lib/services/department-membership-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({ data: { email: `sgdr-${tag}-${RUN_ID}@kinsen.gr`, name: `SGDR ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true } });
    userIds.push(u.id);
    return u.id;
  }
  const attempt = (userId: string) => prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId } });
  const primaryMembership = (userId: string, departmentId: string) =>
    prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId, departmentId } } });
  const driveOnce = (now: Date) => svc.processDueSqlGeneralUserSyncs({ now, batchSize: 50 });
  /** Forces an attempt row into "already succeeded, due for revalidation" shape — bypasses ever running a real first sync, so each scenario below isolates the REVALIDATION cycle specifically. */
  async function makeStaleSucceeded(userId: string, username: string, completedAt: Date) {
    await svc.enqueueOrRecoverSqlGeneralUserSync(userId, username);
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId }, data: { status: "SUCCEEDED", attemptCount: 1, lastError: null, lastSyncCompletedAt: completedAt } });
  }
  const fakeHrUser = (username: string, hrDepartmentId: string, active = true) => ({
    username, mail: null, hrDepartmentId, department: null, companyId: null, company: null, active,
    managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
  });

  try {
    console.log("\n=== Setup: one SQLGeneral-owned Company, two Departments (A/B) ===\n");
    const admin = await makeUser("admin-actor");
    const company = await prisma.company.create({ data: { name: `SGDR Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`SGDR Co ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } });
    companyIds.push(company.id);
    const deptA = await prisma.department.create({ data: { name: `SGDR Dept A ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGDR Dept A ${RUN_ID}`), slug: `sgdr-dept-a-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL } });
    departmentIds.push(deptA.id);
    const deptB = await prisma.department.create({ data: { name: `SGDR Dept B ${RUN_ID}`, normalizedName: normalizeDepartmentName(`SGDR Dept B ${RUN_ID}`), slug: `sgdr-dept-b-${RUN_ID}`, companyId: company.id, importSource: OrganizationNodeSource.SQLGENERAL } });
    departmentIds.push(deptB.id);

    const HR_A = `sgdr-hr-a-${RUN_ID}`;
    const HR_B = `sgdr-hr-b-${RUN_ID}`;
    const FAKE_DEPT_A = { id: HR_A, description: deptA.name, isActive: true, parentDepartmentId: null, country: null, company: company.name, companyShortname: null, creationDate: null, updateTimestamp: null };
    const FAKE_DEPT_B = { id: HR_B, description: deptB.name, isActive: true, parentDepartmentId: null, country: null, company: company.name, companyShortname: null, creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_DEPT_A, FAKE_DEPT_B] });
    // No approved SqlGeneralCompanyMapping/SqlGeneralDepartmentMapping
    // needed: deptA/deptB's names already exactly match FAKE_DEPT_A/B's
    // company/description, and both are already SQLGENERAL-owned, so
    // resolveSqlGeneralPlacementTarget's plain name-match fallback resolves
    // them directly — explicit mapping approval is a separate concern
    // (covered by test-sqlgeneral-department-company-independence.ts),
    // out of scope for this file.

    // ══════════════════════ 1. Successful daily revalidation ══════════════════════
    console.log("\n=== 1. A SUCCEEDED row past the 24h window gets re-claimed and re-processed ===\n");
    {
      const user = await makeUser("happy-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-happy", new Date(now0.getTime() - 25 * HOUR_MS));
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdr-happy", HR_A) });

      const before = await attempt(user);
      const result = await driveOnce(now0);
      check("1. processDueSqlGeneralUserSyncs claims the stale-SUCCEEDED row (new claim branch, not a second scheduler)", result.claimed >= 1, `claimed=${result.claimed}`);
      const after = await attempt(user);
      check("1. The row is reprocessed and SUCCEEDED again (not stuck/skipped)", after.status === "SUCCEEDED");
      check("1. lastSyncCompletedAt refreshed to this run's `now` (the staleness marker, distinct from updatedAt)", after.lastSyncCompletedAt?.getTime() === now0.getTime(), `before=${before.lastSyncCompletedAt?.toISOString()} after=${after.lastSyncCompletedAt?.toISOString()}`);
      check("1. attemptCount reset to a fresh budget for this cycle (0 at claim, +1 on success = 1 — never inherited from a prior cycle)", after.attemptCount === 1, `attemptCount=${after.attemptCount}`);
    }

    // ══════════════════════ 2. Unchanged-Department no-op (MANUAL-protected) ══════════════════════
    console.log("\n=== 2. Unchanged Department, MANUAL-protected role: genuinely untouched (byte-identical updatedAt) ===\n");
    {
      const user = await makeUser("manual-noop-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      const before = await primaryMembership(user, deptA.id);
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-manual-noop", new Date(now0.getTime() - 25 * HOUR_MS));
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdr-manual-noop", HR_A) });

      await driveOnce(now0);
      const afterAttempt = await attempt(user);
      check("2. The worker-level revalidation cycle itself SUCCEEDED (independent of the row-level no-op below)", afterAttempt.status === "SUCCEEDED" && afterAttempt.lastSyncCompletedAt?.getTime() === now0.getTime());

      const after = await primaryMembership(user, deptA.id);
      check("2. The MANUAL-protected membership row is genuinely untouched: same updatedAt (a true zero-write no-op)", after.updatedAt.getTime() === before.updatedAt.getTime(), `before=${before.updatedAt.toISOString()} after=${after.updatedAt.toISOString()}`);
      check("2. ...source still MANUAL (never silently promoted to SQLGENERAL_DEPARTMENT)", after.source === MembershipSource.MANUAL);
      check("2. ...role still the admin's own choice (never reset merely because the membership source changed)", after.role === DepartmentRole.DEPARTMENT_MANAGER);
    }

    // ══════════════════════ 3. A real A->B move, detected via revalidation ══════════════════════
    console.log("\n=== 3. A genuine HR Department change (A->B) is detected and applied during revalidation ===\n");
    {
      const user = await makeUser("real-move-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-real-move", new Date(now0.getTime() - 25 * HOUR_MS));
      // The HR record now reports Department B instead of A — the real change this cycle must detect.
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdr-real-move", HR_B) });

      await driveOnce(now0);
      const afterAttempt = await attempt(user);
      check("3. Revalidation cycle succeeded", afterAttempt.status === "SUCCEEDED");

      const newPrimary = await primaryMembership(user, deptB.id);
      check("3. The user's primary moved to Department B — a real A->B placement via the canonical placement service", newPrimary.isPrimary === true && newPrimary.isActive === true && newPrimary.source === MembershipSource.SQLGENERAL_DEPARTMENT);
      const oldPrimary = await primaryMembership(user, deptA.id);
      check("3. The obsolete Department A primary was fully deactivated (REQUIRED DO #5 behavior, unchanged by this round)", oldPrimary.isPrimary === false && oldPrimary.isActive === false);
    }

    // ══════════════════════ 4. Role preservation — a REAL role change during revalidation ══════════════════════
    console.log("\n=== 4. Unchanged Department, NOT protected: a real role change IS applied during revalidation ===\n");
    {
      const user = await makeUser("role-change-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.AGENT_ASSIGNEE });
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-role-change", new Date(now0.getTime() - 25 * HOUR_MS));
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdr-role-change", HR_A) });

      await driveOnce(now0);
      const after = await primaryMembership(user, deptA.id);
      check("4. Department unchanged, but role/source WERE updated — none of protectManualRole/protectCustomRole/roleAlreadyMatches applied, so the real write path (reused, not duplicated) ran", after.role === DepartmentRole.REQUESTER && after.source === MembershipSource.SQLGENERAL_DEPARTMENT, JSON.stringify(after));
      check("4. ...isActive/isPrimary stay correct throughout", after.isActive === true && after.isPrimary === true);
    }

    // ══════════════════════ 5. Primary Lock respected during revalidation ══════════════════════
    console.log("\n=== 5. An explicit Primary Lock blocks even a revalidation attempt — existing membership preserved ===\n");
    {
      const user = await makeUser("locked-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const lockResult = await membershipSvc.setPrimaryDepartmentLock(user, true, admin);
      check("5. Setup: primary explicitly locked", lockResult.ok === true && lockResult.locked === true);
      const before = await primaryMembership(user, deptA.id);

      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-locked", new Date(now0.getTime() - 25 * HOUR_MS));
      // HR now reports Department B — an attempted move AWAY from the locked primary.
      mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgdr-locked", HR_B) });

      await driveOnce(now0);
      const afterAttempt = await attempt(user);
      check("5. The revalidation is retried (bounded, like any other failure), never silently dropped", afterAttempt.status === "PENDING" && afterAttempt.attemptCount === 1 && !!afterAttempt.lastError, JSON.stringify(afterAttempt));

      const after = await primaryMembership(user, deptA.id);
      check("5. The locked primary is left COMPLETELY untouched — same row, same updatedAt (existing membership preserved)", after.id === before.id && after.updatedAt.getTime() === before.updatedAt.getTime() && after.isActive === true && after.isPrimary === true);
      const bRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user, departmentId: deptB.id } } });
      check("5. No Department B membership was created either — the blocked move has zero side effects", bRow === null);

      // Clean path for later sections: unlock and let it settle so this user doesn't keep retrying in later global-table-wide runs.
      await membershipSvc.setPrimaryDepartmentLock(user, false, admin);
      await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: user }, data: { status: "SKIPPED_NO_USERNAME" } });
    }

    // ══════════════════════ 6. SQLGeneral outage/retry during revalidation ══════════════════════
    console.log("\n=== 6. A persistent SQLGeneral outage during revalidation defers (SUCCEEDED), never reaches FAILED_PERMANENT ===\n");
    {
      const user = await makeUser("outage-revalidation");
      await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const before = await primaryMembership(user, deptA.id);
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-outage", new Date(now0.getTime() - 25 * HOUR_MS));
      mockFindUserImpl = async () => {
        throw new Error("mock: SQLGeneral outage");
      };

      await driveOnce(now0);
      const afterFirst = await attempt(user);
      check("6. First outage-hit retry: back to PENDING, attemptCount=1 (bounded retry, same mechanism as any other failure)", afterFirst.status === "PENDING" && afterFirst.attemptCount === 1);

      let lastNow = now0;
      for (let i = 1; i < svc.MAX_ATTEMPTS; i++) {
        lastNow = new Date(now0.getTime() + i * 1000);
        await driveOnce(lastNow);
      }
      const exhausted = await attempt(user);
      check("6. After MAX_ATTEMPTS failures, a REVALIDATION cycle defers back to SUCCEEDED — never FAILED_PERMANENT (would silently strip working access on a transient outage)", exhausted.status === "SUCCEEDED", `status=${exhausted.status}`);
      check("6. ...attemptCount reset to 0 (a fresh budget for tomorrow's attempt, never carried over)", exhausted.attemptCount === 0, `attemptCount=${exhausted.attemptCount}`);
      check("6. ...lastError preserved for diagnostics (not cleared, even though status is SUCCEEDED)", !!exhausted.lastError);
      check("6. ...lastSyncCompletedAt pushed to this last attempt's `now` — the next automatic attempt is ~24h out, not the very next cron tick", exhausted.lastSyncCompletedAt?.getTime() === lastNow.getTime());

      const after = await primaryMembership(user, deptA.id);
      check("6. The existing membership is completely preserved throughout the whole outage (DO #2: failed revalidations must preserve existing memberships)", after.id === before.id && after.isActive === true && after.isPrimary === true && after.role === before.role && after.source === before.source);

      // Retry-storm check: calling again with the SAME `now` (no 24h elapsed) must NOT reclaim it.
      const immediateRerun = await svc.processDueSqlGeneralUserSyncs({ now: lastNow, batchSize: 50 });
      const stillDeferred = await attempt(user);
      check("6. No retry-storm: an immediate re-run (same `now`, no 24h elapsed) does not reclaim the just-deferred row", stillDeferred.attemptCount === 0 && stillDeferred.status === "SUCCEEDED" && stillDeferred.lastSyncCompletedAt?.getTime() === lastNow.getTime(), `claimedThisRerun=${immediateRerun.claimed}`);

      await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: user }, data: { status: "SKIPPED_NO_USERNAME" } });
    }

    // ══════════════════════ 7. Concurrency: the NEW SUCCEEDED-due-for-revalidation claim branch ══════════════════════
    console.log("\n=== 7. Three concurrent worker runs claim the SAME due-for-revalidation rows between them exactly once each ===\n");
    {
      const concurrentUsers = await Promise.all([1, 2, 3, 4].map((i) => makeUser(`conc-revalidation-${i}`)));
      const now0 = new Date();
      for (const uid of concurrentUsers) {
        await membershipSvc.setPrimaryDepartmentMembership(uid, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
        await makeStaleSucceeded(uid, `sgdr-conc-${uid}`, new Date(now0.getTime() - 25 * HOUR_MS));
      }
      mockFindUserImpl = async (u: string) => ({ outcome: "unique" as const, user: fakeHrUser(u, HR_A) });

      const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => svc.processDueSqlGeneralUserSyncs({ now: now0, batchSize: 50 })));
      const totalClaimed = r1.claimed + r2.claimed + r3.claimed;
      const after = await Promise.all(concurrentUsers.map((uid) => attempt(uid)));
      // Not asserting totalClaimed === 4 exactly — the claim query is table-wide
      // (same caveat as the existing PENDING-claim concurrency test); the real
      // proof is per-row: each of these 4 target rows was claimed and
      // processed exactly once, never twice by two of the three runs racing
      // on the SAME SUCCEEDED+stale row via FOR UPDATE SKIP LOCKED.
      check(
        "7. Each of the 4 target rows was reclaimed and reprocessed exactly once (attemptCount=1, status SUCCEEDED, lastSyncCompletedAt refreshed) — no double-processing of the new claim branch",
        totalClaimed >= 4 && after.every((a) => a.attemptCount === 1 && a.status === "SUCCEEDED" && a.lastSyncCompletedAt?.getTime() === now0.getTime()),
        `totalClaimed=${totalClaimed} shapes=${after.map((a) => `${a.status}:${a.attemptCount}`).join(",")}`
      );
    }

    // ══════════════════════ 8. Preview/worker parity for all four primaryChangeOutcome buckets ══════════════════════
    console.log("\n=== 8. Preview's primaryChangeOutcome for each bucket matches what the worker actually does ===\n");
    {
      mockFindUserImpl = async (u: string) => ({ outcome: "unique" as const, user: fakeHrUser(u, HR_A) });

      // 8a. would_place — no current primary at all yet.
      {
        const user = await makeUser("parity-would-place");
        await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdr-parity-place");
        const preview = await svc.previewSqlGeneralUserSync({ userIds: [user] });
        check("8a. Preview: no current primary -> would_place", preview.ok && preview.rows[0].primaryChangeOutcome === "would_place", JSON.stringify(preview));
        await driveOnce(new Date());
        const after = await primaryMembership(user, deptA.id);
        check("8a. Worker: a real placement actually happened — parity confirmed", after.isPrimary === true && after.isActive === true && after.source === MembershipSource.SQLGENERAL_DEPARTMENT);
      }

      // 8b. already_aligned — already SQLGENERAL_DEPARTMENT-sourced, role already matches default.
      {
        const user = await makeUser("parity-already-aligned");
        await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
        const before = await primaryMembership(user, deptA.id);
        await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdr-parity-aligned");
        const preview = await svc.previewSqlGeneralUserSync({ userIds: [user] });
        check("8b. Preview: dept matches, source already SQLGENERAL_DEPARTMENT, role matches -> already_aligned", preview.ok && preview.rows[0].primaryChangeOutcome === "already_aligned", JSON.stringify(preview));
        await driveOnce(new Date());
        const after = await primaryMembership(user, deptA.id);
        check("8b. Worker: byte-identical no-op — parity confirmed", after.updatedAt.getTime() === before.updatedAt.getTime());
      }

      // 8c. would_realign_source_only — MANUAL-protected, dept matches.
      {
        const user = await makeUser("parity-realign-source");
        await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
        const before = await primaryMembership(user, deptA.id);
        await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdr-parity-realign");
        const preview = await svc.previewSqlGeneralUserSync({ userIds: [user] });
        check("8c. Preview: dept matches, MANUAL-protected -> would_realign_source_only (a zero-write no-op, but source stays stale)", preview.ok && preview.rows[0].primaryChangeOutcome === "would_realign_source_only", JSON.stringify(preview));
        await driveOnce(new Date());
        const after = await primaryMembership(user, deptA.id);
        check("8c. Worker: genuinely zero-write (same updatedAt, source still MANUAL) — parity confirmed", after.updatedAt.getTime() === before.updatedAt.getTime() && after.source === MembershipSource.MANUAL);
      }

      // 8d. would_change_role — plain-enum role differs, not MANUAL, no custom role.
      {
        const user = await makeUser("parity-change-role");
        await membershipSvc.setPrimaryDepartmentMembership(user, deptA.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.AGENT_ASSIGNEE });
        await svc.enqueueOrRecoverSqlGeneralUserSync(user, "sgdr-parity-rolechange");
        const preview = await svc.previewSqlGeneralUserSync({ userIds: [user] });
        check("8d. Preview: dept matches, role differs, no protection -> would_change_role", preview.ok && preview.rows[0].primaryChangeOutcome === "would_change_role", JSON.stringify(preview));
        await driveOnce(new Date());
        const after = await primaryMembership(user, deptA.id);
        check("8d. Worker: a real role/source write actually happened — parity confirmed", after.role === DepartmentRole.REQUESTER && after.source === MembershipSource.SQLGENERAL_DEPARTMENT);
      }
    }

    // ══════════════════════ 9. Flags-OFF preservation ══════════════════════
    console.log("\n=== 9. SQLGENERAL_SYNC_ENABLED unset: claims NOTHING, including a SUCCEEDED row due for revalidation ===\n");
    {
      const user = await makeUser("flags-off");
      const now0 = new Date();
      await makeStaleSucceeded(user, "sgdr-flags-off", new Date(now0.getTime() - 48 * HOUR_MS));
      const before = await attempt(user);

      delete process.env.SQLGENERAL_SYNC_ENABLED;
      const result = await svc.processDueSqlGeneralUserSyncs({ now: now0, batchSize: 50 });
      check("9. processDueSqlGeneralUserSyncs claims nothing at all while the flag is unset — the new claim branch is still gated by the SAME existing outer check", result.claimed === 0, `claimed=${result.claimed}`);

      const after = await attempt(user);
      check("9. The due-for-revalidation row is completely untouched (status/attemptCount/lastSyncCompletedAt all unchanged)", after.status === before.status && after.attemptCount === before.attemptCount && after.lastSyncCompletedAt?.getTime() === before.lastSyncCompletedAt?.getTime());

      process.env.SQLGENERAL_SYNC_ENABLED = "true";
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralDepartmentMappings", () => prisma.sqlGeneralDepartmentMapping.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["sqlGeneralCompanyMappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { companyId: { in: companyIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
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
    if (originalSyncEnabled === undefined) delete process.env.SQLGENERAL_SYNC_ENABLED;
    else process.env.SQLGENERAL_SYNC_ENABLED = originalSyncEnabled;
    if (originalPrimaryEnabled === undefined) delete process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED;
    else process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = originalPrimaryEnabled;
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
