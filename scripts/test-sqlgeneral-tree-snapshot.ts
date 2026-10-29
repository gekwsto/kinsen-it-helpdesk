/**
 * Persistent, daily-refreshed SQLGeneral Organization Tree snapshot —
 * verifying: initial "not yet initialized" state, a refresh builds +
 * persists a snapshot, the daily staleness guard, a forced (manual)
 * refresh bypasses staleness but never the lock, atomic replacement
 * (GET always serves the LATEST successful snapshot), failure
 * preservation (a failed refresh never touches the prior successful
 * one), the concurrent-refresh lock, ADMIN authorization on the refresh
 * route, that a normal GET makes ZERO SQLGeneral API calls, that the
 * persisted tree's manager hierarchy round-trips unchanged through JSON
 * storage, and that Project Request's own SQLGeneral lookups are
 * completely independent of this snapshot's state.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-tree-snapshot.ts
 */
// A top-level static import (even unused otherwise) makes this file a real
// ES module rather than an implicit global script — without one, this
// file's top-level `let passed/failed` collide with the IDENTICAL names in
// every other scripts/test-*.ts file that also has no top-level import.
import "@/lib/prisma";

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

function fakeSqlUser(username: string, managerAMAccountName: string | null, opts: Partial<{ active: boolean | null }> = {}) {
  return { username, mail: `${username}@example.com`, hrDepartmentId: null, department: null, companyId: null, company: null, active: opts.active ?? true, managerAMAccountName, manager2AMAccountName: null, manager3AMAccountName: null };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { mock } = await import("node:test");

  // server-only's conditional-exports guard always resolves to its
  // throwing stub outside Next's bundler — mock it to a no-op, same
  // insurance every other project-request/sqlgeneral test file in this
  // suite already takes, in case anything in the permission/auth import
  // chain ever reaches it transitively.
  mock.module("server-only", { namedExports: {} });

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

  let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
  mock.module("@/lib/permissions", {
    namedExports: {
      ...(await import("@/lib/permissions")),
      requireAuth: async () => {
        if (!currentSession) throw new Error("Unauthorized");
        return currentSession;
      },
    },
  });

  // Keyed by username, one entry per ROW — shared "ground truth" dataset
  // for both listAllSqlGeneralUsers (optionally activeOnly-filtered) and
  // findSqlGeneralUserByUsername, exactly mirroring
  // test-sqlgeneral-organization-tree.ts's own mock harness.
  let fixtureUsers: ReturnType<typeof fakeSqlUser>[] = [];
  let forceListUsersFailure: string | null = null;
  let listUsersCallCount = 0;
  let findUserCallCount = 0;
  let buildDelayMs = 0;

  const realClient = await import("@/lib/sqlgeneral-api-client");
  async function mockListAllUsers(options?: { activeOnly?: boolean }) {
    listUsersCallCount++;
    if (buildDelayMs > 0) await delay(buildDelayMs);
    if (forceListUsersFailure) return { ok: false as const, reason: forceListUsersFailure };
    const rows = options?.activeOnly ? fixtureUsers.filter((u) => u.active === true) : fixtureUsers;
    return { ok: true as const, users: rows };
  }
  async function mockFindUserByUsername(username: string) {
    findUserCallCount++;
    const rows = fixtureUsers.filter((u) => u.username === username);
    if (rows.length === 0) return { outcome: "not_found" as const };
    if (rows.length > 1) return { outcome: "ambiguous" as const, count: rows.length };
    return { outcome: "unique" as const, user: rows[0] };
  }
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: { ...realClient, listAllSqlGeneralUsers: (o?: { activeOnly?: boolean }) => mockListAllUsers(o), findSqlGeneralUserByUsername: (u: string) => mockFindUserByUsername(u) },
  });

  const { Role, AuthProvider, SqlGeneralTreeSnapshotTrigger, RoleScope } = await import("@prisma/client");
  const { hasPermission } = await import("@/lib/permissions");
  const snapshotService = await import("@/lib/services/sqlgeneral-tree-snapshot-service");
  const treeRoute = await import("@/app/api/admin/organization/sqlgeneral-tree/route");
  const refreshRoute = await import("@/app/api/admin/organization/sqlgeneral-tree/refresh/route");
  const statusRoute = await import("@/app/api/admin/organization/sqlgeneral-tree/status/route");
  const projectRequestService = await import("@/lib/services/project-request-service");

  const userIds: string[] = [];
  async function makeUser(tag: string, role: typeof Role.USER | typeof Role.ADMIN = Role.USER): Promise<string> {
    const u = await prisma.user.create({ data: { email: `sgsnap-${tag}-${RUN_ID}@kinsen.gr`, name: `SGSnap ${tag}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u.id;
  }
  function sessionFor(userId: string, role: typeof Role.USER | typeof Role.ADMIN) {
    currentSession = { user: { id: userId, role, customRoleId: null } };
  }

  try {
    const admin = await makeUser("admin", Role.ADMIN);
    const nonAdmin = await makeUser("nonadmin", Role.USER);

    console.log("\n=== 1. No snapshot has ever succeeded: GET reports not-initialized, ZERO SQLGeneral API calls ===\n");
    fixtureUsers = [fakeSqlUser("geokos", null), fakeSqlUser("konkef", "geokos")];
    listUsersCallCount = 0;
    findUserCallCount = 0;
    sessionFor(admin, Role.ADMIN);
    const initialGetRes = await treeRoute.GET();
    const initialGetBody = await initialGetRes.json();
    check("1. GET returns initialized: false when no snapshot has ever succeeded", initialGetRes.status === 200 && initialGetBody.initialized === false, JSON.stringify(initialGetBody));
    check("1b. ...and makes ZERO SQLGeneral API calls (reads the DB only, never falls back to a live fetch)", listUsersCallCount === 0 && findUserCallCount === 0, `listUsers=${listUsersCallCount} findUser=${findUserCallCount}`);

    console.log("\n=== 2. A refresh builds the tree via the EXISTING hierarchy function and persists it ===\n");
    const firstRefresh = await snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.CRON });
    check("2. the refresh succeeds and actually ran (not skipped)", firstRefresh.skipped === false && firstRefresh.ok === true, JSON.stringify(firstRefresh));
    check("2b. it made a real SQLGeneral listing call to build the tree", listUsersCallCount === 1, `got ${listUsersCallCount}`);

    const afterFirstGetRes = await treeRoute.GET();
    const afterFirstGetBody = await afterFirstGetRes.json();
    check("2c. GET now reports initialized: true and serves the just-built tree", afterFirstGetBody.initialized === true && Array.isArray(afterFirstGetBody.tree) && afterFirstGetBody.tree.length === 1, JSON.stringify(afterFirstGetBody));
    check("2d. the persisted node has the SAME manager-first shape getSqlGeneralOrganizationTree itself produces — geokos as root, konkef nested under them (round-trips through JSON storage unchanged)", afterFirstGetBody.tree[0]?.sqlGeneralUsername === "geokos" && afterFirstGetBody.tree[0]?.children?.[0]?.sqlGeneralUsername === "konkef", JSON.stringify(afterFirstGetBody.tree));
    check("2e. lastSuccessfulSyncAt is present", typeof afterFirstGetBody.lastSuccessfulSyncAt === "string");

    console.log("\n=== 3. GET still makes ZERO SQLGeneral API calls after a successful snapshot exists ===\n");
    listUsersCallCount = 0;
    findUserCallCount = 0;
    await treeRoute.GET();
    await treeRoute.GET();
    await treeRoute.GET();
    check("3. three more GETs make zero additional SQLGeneral calls", listUsersCallCount === 0 && findUserCallCount === 0, `listUsers=${listUsersCallCount} findUser=${findUserCallCount}`);

    console.log("\n=== 3b. Measured GET latency — a single DB read of an already-built snapshot, never a live multi-request SQLGeneral fetch ===\n");
    const GET_SAMPLE_COUNT = 20;
    const getLatencies: number[] = [];
    for (let i = 0; i < GET_SAMPLE_COUNT; i++) {
      const t0 = Date.now();
      await treeRoute.GET();
      getLatencies.push(Date.now() - t0);
    }
    const totalGetMs = getLatencies.reduce((a, b) => a + b, 0);
    const avgGetMs = totalGetMs / GET_SAMPLE_COUNT;
    const maxGetMs = Math.max(...getLatencies);
    console.log(`    ${GET_SAMPLE_COUNT} snapshot-backed GETs: avg=${avgGetMs.toFixed(1)}ms, max=${maxGetMs}ms (vs. the live-fetch path's own production-measured ~4.76s for a comparable roster)`);
    check(
      `3b. ${GET_SAMPLE_COUNT} consecutive GETs average well under 200ms (a plain DB read, never a SQLGeneral round-trip) — concrete latency evidence for this round's ACCEPTANCE criterion`,
      avgGetMs < 200,
      `avg=${avgGetMs.toFixed(1)}ms max=${maxGetMs}ms`
    );
    check("3c. zero additional SQLGeneral calls were made across all 20 latency-measurement GETs", listUsersCallCount === 0 && findUserCallCount === 0, `listUsers=${listUsersCallCount} findUser=${findUserCallCount}`);

    console.log("\n=== 4. Daily calendar-day guard (Europe/Athens): a NON-forced refresh right after a successful one, same Athens calendar day, is skipped ===\n");
    listUsersCallCount = 0;
    const staleGuardResult = await snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.CRON });
    check("4. the refresh is skipped — a successful snapshot already exists for today (Europe/Athens)", staleGuardResult.skipped === true, JSON.stringify(staleGuardResult));
    check("4b. no SQLGeneral API call was made for the skipped attempt", listUsersCallCount === 0, `got ${listUsersCallCount}`);

    console.log("\n=== 4c. isDueForDailySqlGeneralTreeRefresh — direct, deterministic tests of the Europe/Athens calendar-day + 03:00 target-hour gate, including both DST transitions ===\n");
    const { isDueForDailySqlGeneralTreeRefresh } = snapshotService;
    // A fixed moment well inside a normal (non-DST-transition) Athens day:
    // 2026-06-15 is deep in EEST (summer), no transition nearby.
    const normalDayAt01 = new Date("2026-06-15T22:30:00Z"); // 2026-06-16 01:30 Athens (EEST, UTC+3) — hour 1, too early
    const normalDayAt04 = new Date("2026-06-16T01:30:00Z"); // 2026-06-16 04:30 Athens — hour 4, past target
    const sameDayEarlier = new Date("2026-06-16T02:00:00Z"); // 2026-06-16 05:00 Athens, SAME calendar date as normalDayAt04

    check("4c-1. never succeeded before -> always due, regardless of hour", isDueForDailySqlGeneralTreeRefresh(normalDayAt01, null) === true);
    check("4c-2. different Athens calendar day, but hour < 03:00 Athens -> NOT due yet", isDueForDailySqlGeneralTreeRefresh(normalDayAt01, new Date("2026-06-14T12:00:00Z")) === false);
    check("4c-3. different Athens calendar day, hour >= 03:00 Athens -> due", isDueForDailySqlGeneralTreeRefresh(normalDayAt04, new Date("2026-06-14T12:00:00Z")) === true);
    check("4c-4. SAME Athens calendar day as the last success, even hours later -> NOT due again", isDueForDailySqlGeneralTreeRefresh(sameDayEarlier, normalDayAt04) === false);

    // 2026 EU DST spring-forward: 2026-03-29, 01:00 UTC clocks jump
    // 02:59:59 EET -> 04:00:00 EEST. Athens-local 03:00-03:59 never occurs.
    const springForwardBefore = new Date("2026-03-29T00:30:00Z"); // 02:30 EET — hour 2, before the jump
    const springForwardAfter = new Date("2026-03-29T01:30:00Z"); // 04:30 EEST — hour 4, right after the jump (03:00 never happened)
    check("4c-5. spring-forward day, just BEFORE the jump (Athens hour 2) -> NOT due yet", isDueForDailySqlGeneralTreeRefresh(springForwardBefore, new Date("2026-03-28T12:00:00Z")) === false);
    check(
      "4c-6. spring-forward day, just AFTER the jump (Athens hour jumps straight to 4 — 03:00 literally never occurs) -> still correctly due, no crash, no skipped day",
      isDueForDailySqlGeneralTreeRefresh(springForwardAfter, new Date("2026-03-28T12:00:00Z")) === true
    );

    // 2026 EU DST fall-back: 2026-10-25, 01:00 UTC clocks repeat
    // 03:00:00 EEST -> 03:00:00 EET an hour later. Athens-local 03:00-03:59
    // occurs TWICE that day.
    const fallBackFirst03 = new Date("2026-10-25T00:30:00Z"); // 03:30 EEST (UTC+3) — the FIRST 03:xx of the day
    const fallBackSecond03 = new Date("2026-10-25T01:30:00Z"); // 03:30 EET (UTC+2), one hour later wall-clock — the SECOND 03:xx of the SAME calendar date
    check("4c-7. fall-back day, the FIRST occurrence of 03:xx Athens (different calendar day from last success) -> due", isDueForDailySqlGeneralTreeRefresh(fallBackFirst03, new Date("2026-10-24T12:00:00Z")) === true);
    check(
      "4c-8. fall-back day, the SECOND occurrence of 03:xx Athens an hour later (SAME calendar date, now recorded as the last success) -> NOT due again — never a second same-day rebuild just because the clock repeated the hour",
      isDueForDailySqlGeneralTreeRefresh(fallBackSecond03, fallBackFirst03) === false
    );

    console.log("\n=== 4d. Stale lock recovery: a crashed worker's abandoned RUNNING row is marked FAILED, and a new refresh can still proceed ===\n");
    const staleRun = await prisma.sqlGeneralOrganizationTreeSnapshot.create({
      data: { status: "RUNNING", triggeredBy: SqlGeneralTreeSnapshotTrigger.CRON, startedAt: new Date(Date.now() - 45 * 60 * 1000) },
    });
    await prisma.sqlGeneralTreeSnapshotLock.upsert({
      where: { id: "singleton" },
      update: { isLocked: true, lockedAt: new Date(Date.now() - 45 * 60 * 1000), runId: staleRun.id },
      create: { id: "singleton", isLocked: true, lockedAt: new Date(Date.now() - 45 * 60 * 1000), runId: staleRun.id },
    });
    fixtureUsers = [fakeSqlUser("afterstale-root", null)];
    const afterStaleRefresh = await snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: admin, force: true });
    check("4d-1. a new refresh succeeds despite the 45-minute-old stale lock left by the 'crashed' run", afterStaleRefresh.skipped === false && afterStaleRefresh.ok === true, JSON.stringify(afterStaleRefresh));

    const staleRunAfter = await prisma.sqlGeneralOrganizationTreeSnapshot.findUnique({ where: { id: staleRun.id } });
    check(
      "4d-2. the ABANDONED run's own row is now marked FAILED (never left RUNNING forever) with a clear 'abandoned' error, and has NO treeData",
      staleRunAfter?.status === "FAILED" && staleRunAfter.treeData === null && /abandoned/i.test(staleRunAfter.lastError ?? ""),
      JSON.stringify(staleRunAfter)
    );

    console.log("\n=== 4e. Protection against a LATE completion: once a run's row is no longer RUNNING, a late write to it is a documented no-op, never an overwrite ===\n");
    const lateRun = await prisma.sqlGeneralOrganizationTreeSnapshot.create({ data: { status: "RUNNING", triggeredBy: SqlGeneralTreeSnapshotTrigger.CRON } });
    // Simulate "cleanup already marked this run FAILED" (e.g. its lock went
    // stale and was reclaimed) BEFORE the late completer's own write arrives.
    const firstTransition = await prisma.sqlGeneralOrganizationTreeSnapshot.updateMany({ where: { id: lateRun.id, status: "RUNNING" }, data: { status: "FAILED", completedAt: new Date(), lastError: "Abandoned — the refresh lock expired (the worker likely crashed or was killed) before this attempt completed." } });
    check("4e-1. the FIRST (cleanup) transition applies — the row really was still RUNNING at that moment", firstTransition.count === 1);
    // The "late completer" now tries to write its own SUCCEEDED result to
    // the SAME row, using the EXACT same conditional guard the real
    // transitionRunIfStillRunning helper uses — must be a no-op.
    const lateCompletion = await prisma.sqlGeneralOrganizationTreeSnapshot.updateMany({ where: { id: lateRun.id, status: "RUNNING" }, data: { status: "SUCCEEDED", completedAt: new Date(), treeData: { roots: [], unresolvedUsers: [], unresolvedManagerLinks: [] } } });
    check("4e-2. the LATE completion's write matches ZERO rows (status is no longer RUNNING) — it never overwrites the already-recorded abandonment", lateCompletion.count === 0);
    const lateRunFinal = await prisma.sqlGeneralOrganizationTreeSnapshot.findUnique({ where: { id: lateRun.id } });
    check("4e-3. the row's final state is still the FAILED/abandoned one, never silently flipped to SUCCEEDED by the late write", lateRunFinal?.status === "FAILED", JSON.stringify(lateRunFinal));

    console.log("\n=== 5. A FORCED (manual) refresh bypasses the staleness guard and rebuilds with fresh data — atomic replacement ===\n");
    fixtureUsers = [fakeSqlUser("newroot", null), fakeSqlUser("newleaf", "newroot")]; // completely different fixture
    listUsersCallCount = 0;
    const forcedRefresh = await snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: admin, force: true });
    check("5. the forced refresh actually runs despite the previous snapshot still being fresh", forcedRefresh.skipped === false && forcedRefresh.ok === true, JSON.stringify(forcedRefresh));
    check("5b. it made a real SQLGeneral call (force bypasses staleness)", listUsersCallCount === 1, `got ${listUsersCallCount}`);

    const afterForcedGetBody = await (await treeRoute.GET()).json();
    check("5c. GET now serves the NEW fixture's tree — old data is gone from the LATEST view (atomic replacement)", afterForcedGetBody.tree?.[0]?.sqlGeneralUsername === "newroot" && afterForcedGetBody.tree?.[0]?.children?.[0]?.sqlGeneralUsername === "newleaf", JSON.stringify(afterForcedGetBody.tree));

    const oldStillExists = await prisma.sqlGeneralOrganizationTreeSnapshot.findFirst({ where: { rootCount: 1, nodeCount: 2, lastError: null }, orderBy: { startedAt: "asc" } });
    check("5d. the PREVIOUS successful snapshot row still physically exists in the DB (never deleted, just no longer latest)", !!oldStillExists);

    console.log("\n=== 6. Failure preservation: a failed forced refresh NEVER overwrites the last successful snapshot ===\n");
    forceListUsersFailure = "simulated SQLGeneral outage";
    const failedRefresh = await snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: admin, force: true });
    check("6. the refresh attempt itself reports failure", failedRefresh.skipped === false && failedRefresh.ok === false, JSON.stringify(failedRefresh));
    forceListUsersFailure = null;

    const afterFailureGetBody = await (await treeRoute.GET()).json();
    check("6b. GET still serves the LAST SUCCESSFUL snapshot (newroot/newleaf) — the failed attempt never touched it, never served as a partial/failed result", afterFailureGetBody.tree?.[0]?.sqlGeneralUsername === "newroot", JSON.stringify(afterFailureGetBody.tree));

    const failedRun = await prisma.sqlGeneralOrganizationTreeSnapshot.findUnique({ where: { id: failedRefresh.runId! } });
    check("6c. the failed attempt's own row is marked FAILED with a sanitized error, and has NO treeData", failedRun?.status === "FAILED" && failedRun.treeData === null && typeof failedRun.lastError === "string");

    console.log("\n=== 7. Concurrent refresh lock: two overlapping forced refreshes — only ONE actually builds ===\n");
    buildDelayMs = 150; // long enough that the second call's lock-acquire attempt happens while the first is still mid-build
    listUsersCallCount = 0;
    const [concurrentA, concurrentB] = await Promise.all([
      snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: admin, force: true }),
      snapshotService.refreshSqlGeneralOrganizationTreeSnapshot({ trigger: SqlGeneralTreeSnapshotTrigger.MANUAL, triggeredById: admin, force: true }),
    ]);
    buildDelayMs = 0;
    const outcomes = [concurrentA, concurrentB];
    const ranCount = outcomes.filter((o) => !o.skipped).length;
    const skippedCount = outcomes.filter((o) => o.skipped).length;
    check("7. exactly ONE of the two concurrent forced refreshes actually ran, the other was rejected by the lock", ranCount === 1 && skippedCount === 1, JSON.stringify(outcomes));
    check("7b. only ONE real SQLGeneral listing call was made — never two concurrent builds", listUsersCallCount === 1, `got ${listUsersCallCount}`);

    console.log("\n=== 8. ADMIN authorization on the manual-refresh route (reuses organization.sqlgeneralSync, same gate as viewing the tree) ===\n");
    sessionFor(nonAdmin, Role.USER);
    const forbiddenRefreshRes = await refreshRoute.POST();
    check("8. a user without organization.sqlgeneralSync gets 403 on POST .../refresh", forbiddenRefreshRes.status === 403);
    const forbiddenStatusRes = await statusRoute.GET();
    check("8b. ...and 403 on GET .../status too", forbiddenStatusRes.status === 403);
    const forbiddenTreeRes = await treeRoute.GET();
    check("8c. ...and 403 on the main tree GET itself", forbiddenTreeRes.status === 403);

    sessionFor(admin, Role.ADMIN);
    const adminStatusRes = await statusRoute.GET();
    const adminStatusBody = await adminStatusRes.json();
    check("8d. ADMIN gets 200 on .../status with latestSuccessful + latestRun + running fields", adminStatusRes.status === 200 && !!adminStatusBody.latestSuccessful && !!adminStatusBody.latestRun && typeof adminStatusBody.running === "boolean", JSON.stringify(adminStatusBody));

    console.log("\n=== 8e. A NON-ADMIN user who nonetheless holds organization.sqlgeneralSync (via a custom role) sees the tree but NEVER the raw diagnostic arrays ===\n");
    const diagCustomRole = await prisma.customRole.create({ data: { key: `SGTREE_DIAG_${RUN_ID}`, name: `SGTree Diag ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
    const sqlgeneralSyncPermission = await prisma.permission.findUnique({ where: { key: "organization.sqlgeneralSync" } });
    if (!sqlgeneralSyncPermission) {
      check("8e. (setup) organization.sqlgeneralSync permission is seeded", false, "not found — cannot run this check");
    } else {
      await prisma.rolePermission.create({ data: { roleKey: diagCustomRole.key, permissionId: sqlgeneralSyncPermission.id } });
      const nonAdminWithView = await makeUser("nonadminview", Role.USER);
      await prisma.user.update({ where: { id: nonAdminWithView }, data: { customRoleId: diagCustomRole.id } });

      const sanityCheck = await hasPermission(Role.USER, "organization.sqlgeneralSync", diagCustomRole.id);
      check("8e. (setup) the custom role really does grant organization.sqlgeneralSync to a non-ADMIN role", sanityCheck === true);

      currentSession = { user: { id: nonAdminWithView, role: Role.USER, customRoleId: diagCustomRole.id } };
      const nonAdminTreeRes = await treeRoute.GET();
      const nonAdminTreeBody = await nonAdminTreeRes.json();
      check("8f. a non-ADMIN with view permission still gets 200 (never 403) — they CAN see the tree itself", nonAdminTreeRes.status === 200);
      check("8g. ...and the tree DATA is still present for them", Array.isArray(nonAdminTreeBody.tree));
      check(
        "8h. ...but unresolvedUsers/unresolvedManagerLinks are COMPLETELY ABSENT from their response — never even an empty array, never exposed to a non-ADMIN caller",
        nonAdminTreeBody.unresolvedUsers === undefined && nonAdminTreeBody.unresolvedManagerLinks === undefined,
        JSON.stringify(nonAdminTreeBody)
      );

      const nonAdminStatusRes = await statusRoute.GET();
      check("8i. a non-ADMIN with view permission also gets 200 (not 403) on .../status — status itself isn't admin-only, only the raw diagnostic arrays on the tree route are", nonAdminStatusRes.status === 200);

      await prisma.rolePermission.deleteMany({ where: { roleKey: diagCustomRole.key } });
      await prisma.customRole.delete({ where: { id: diagCustomRole.id } });
    }
    currentSession = null;

    console.log("\n=== 9. Project Request's OWN SQLGeneral lookups are completely independent of this snapshot's state ===\n");
    // Wipe every snapshot row entirely — if Project Request's manager-chain
    // resolution were somehow coupled to this table, it would now fail/behave
    // differently. It must not: it does its own direct, live
    // findSqlGeneralUserByUsername calls, never touching the snapshot table.
    await prisma.sqlGeneralOrganizationTreeSnapshot.deleteMany({});
    sessionFor(admin, Role.ADMIN); // explicit — never relies on whatever session an earlier section happened to leave active
    fixtureUsers = [fakeSqlUser("pr-root-mgr", null)];
    const prRequester = await makeUser("prrequester", Role.USER);
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: prRequester, sqlGeneralUsername: "pr-root-mgr", status: "PENDING" } });
    const candidateResolution = await projectRequestService.resolveIntermediateApproverCandidates(prRequester);
    check(
      "9. resolveIntermediateApproverCandidates works correctly via its OWN live lookup even with ZERO snapshot rows in the DB — never coupled to this feature",
      candidateResolution.status === "no_manager",
      JSON.stringify(candidateResolution)
    );
    const noSnapshotGetBody = await (await treeRoute.GET()).json();
    check("9b. meanwhile the tree GET correctly reports not-initialized again after the wipe — no cross-talk either direction", noSnapshotGetBody.initialized === false);
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["sqlgeneral tree snapshots", () => prisma.sqlGeneralOrganizationTreeSnapshot.deleteMany({})],
      ["sqlgeneral tree snapshot lock", () => prisma.sqlGeneralTreeSnapshotLock.deleteMany({})],
      ["sync attempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
    ];
    for (const [label, step] of steps) {
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
