/**
 * SQLGeneral First-Login Sync Foundation — enqueue idempotency, missing-
 * username recovery, stale-claim recovery, concurrent claims, retry
 * exhaustion, explicit admin refresh, configuration blocking, and that
 * Microsoft login itself is never affected. Real DB; time is real (no
 * external calls ever actually succeed in this suite — SQLGeneral stays
 * unconfigured/disabled throughout, which is itself part of what's tested).
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-sqlgeneral-user-sync.ts
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, RoleScope } from "@prisma/client";

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

  // SQLGENERAL_SYNC_ENABLED must be unset/false by default for this suite —
  // asserted explicitly below, then flipped only where a test needs the
  // worker to actually claim rows. Real SQLGENERAL_* credentials stay
  // whatever .env has (dummy placeholders in dev); the worker/Preview-
  // relevant client calls (findSqlGeneralUserByUsername/
  // listAllSqlGeneralDepartments) are mocked below so retry/exhaustion/
  // stale-claim/concurrent-claim/Preview mechanics can be driven
  // deterministically against controlled fake data rather than always
  // hitting the same "not configured" wall — the config-error path itself
  // is covered separately in scripts/test-sqlgeneral-api-client.ts.
  const originalEnabled = process.env.SQLGENERAL_SYNC_ENABLED;
  delete process.env.SQLGENERAL_SYNC_ENABLED;

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  type FindUserFn = typeof realClient.findSqlGeneralUserByUsername;
  type ListDeptFn = typeof realClient.listAllSqlGeneralDepartments;
  type VerifyCompanyIdFn = typeof realClient.verifySqlGeneralCompanyIdExists;
  type VerifyDepartmentIdFn = typeof realClient.verifySqlGeneralDepartmentIdExists;
  let mockFindUserImpl: FindUserFn = async () => {
    throw new Error("mock: SQLGeneral external call failed");
  };
  let mockListDeptImpl: ListDeptFn = async () => ({ ok: true, departments: [] });
  // Default: every CompanyId/DepartmentId is confirmed to exist —
  // individual tests override this to exercise the "unknown source id"
  // rejection path.
  let mockVerifyCompanyIdImpl: VerifyCompanyIdFn = async () => ({ ok: true, exists: true });
  let mockVerifyDepartmentIdImpl: VerifyDepartmentIdFn = async () => ({ ok: true, exists: true });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (username: string) => mockFindUserImpl(username),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
      verifySqlGeneralCompanyIdExists: (companyId: string) => mockVerifyCompanyIdImpl(companyId),
      verifySqlGeneralDepartmentIdExists: (departmentId: string) => mockVerifyDepartmentIdImpl(departmentId),
    },
  });

  const realDirectoryService = await import("@/lib/services/microsoft-directory-service");
  type FetchIdentitiesFn = typeof realDirectoryService.fetchAllGraphUserIdentities;
  let mockFetchIdentitiesImpl: FetchIdentitiesFn = async () => ({ ok: true, identities: [] });
  mock.module("@/lib/services/microsoft-directory-service", {
    namedExports: {
      ...realDirectoryService,
      fetchAllGraphUserIdentities: () => mockFetchIdentitiesImpl(),
    },
  });

  let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
  mock.module("@/lib/permissions", {
    namedExports: {
      ...(await import("@/lib/permissions")),
      requireAuth: async () => {
        if (!currentSession) throw new Error("Unauthorized");
        return currentSession;
      },
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const client = await import("@/lib/sqlgeneral-api-client");
  const workerRoute = await import("@/app/api/internal/sqlgeneral-user-sync/process/route");
  const adminRoute = await import("@/app/api/admin/sqlgeneral-user-sync/route");
  const backfillRoute = await import("@/app/api/admin/sqlgeneral-user-sync/backfill-usernames/route");

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string, role: Role = Role.USER, customRoleId: string | null = null): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgs-${tag}-${RUN_ID}@kinsen.gr`, name: `SGS ${tag}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(u.id);
    return u.id;
  }
  const attempt = (userId: string) => prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId } });
  const jsonReq = (method: string, body?: unknown) => new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  try {
    console.log("\nConfiguration blocking ===\n");
    check("SQLGENERAL_SYNC_ENABLED is unset by default in this run", !client.isSqlGeneralSyncEnabled());

    const uBlock = await makeUser("block");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uBlock, "jdoe");
    const beforeBlock = await attempt(uBlock);
    check("1. row enqueued as PENDING with a username", beforeBlock.status === "PENDING" && beforeBlock.sqlGeneralUsername === "jdoe");
    const blockedResult = await svc.processDueSqlGeneralUserSyncs();
    check("2. disabled integration: processDueSqlGeneralUserSyncs claims nothing at all", blockedResult.claimed === 0, `claimed=${blockedResult.claimed}`);
    const afterBlock = await attempt(uBlock);
    check("3. ...and the PENDING row is completely untouched (no attempt consumed)", afterBlock.status === "PENDING" && afterBlock.attemptCount === 0 && afterBlock.claimedAt === null);

    console.log("\nEnqueue idempotency ===\n");
    const uIdem = await makeUser("idem");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uIdem, "alice");
    const first = await attempt(uIdem);
    await svc.enqueueOrRecoverSqlGeneralUserSync(uIdem, "alice");
    const second = await attempt(uIdem);
    check("4. a second identical enqueue call is a true no-op (same row id, unchanged)", first.id === second.id && second.status === "PENDING" && second.sqlGeneralUsername === "alice");
    check("4b. exactly one SqlGeneralUserSyncAttempt row exists for this user", (await prisma.sqlGeneralUserSyncAttempt.count({ where: { userId: uIdem } })) === 1);
    await svc.enqueueOrRecoverSqlGeneralUserSync(uIdem, "alice2");
    check("5. a CHANGED username on a still-PENDING row refreshes the username in place", (await attempt(uIdem)).sqlGeneralUsername === "alice2");

    console.log("\nMissing-username recovery ===\n");
    const uNoUser = await makeUser("nouser");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uNoUser, null);
    const skipped = await attempt(uNoUser);
    check("6. no username at all => row created as SKIPPED_NO_USERNAME", skipped.status === "SKIPPED_NO_USERNAME" && skipped.sqlGeneralUsername === null);
    await svc.enqueueOrRecoverSqlGeneralUserSync(uNoUser, null);
    check("6b. another login still with no username leaves it SKIPPED_NO_USERNAME (no-op)", (await attempt(uNoUser)).status === "SKIPPED_NO_USERNAME");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uNoUser, "bob");
    const recovered = await attempt(uNoUser);
    check("7. a LATER login with a real username revives it to PENDING (recoverable, not a dead end)", recovered.status === "PENDING" && recovered.sqlGeneralUsername === "bob" && recovered.attemptCount === 0);

    console.log("\nLogin never blocked by SQLGeneral ===\n");
    let threwForNonexistentUser = false;
    try {
      await svc.enqueueOrRecoverSqlGeneralUserSync(`nonexistent-user-${RUN_ID}`, "x");
    } catch {
      threwForNonexistentUser = true;
    }
    check("8. enqueue never throws even on an internal DB error (FK violation for a nonexistent user)", !threwForNonexistentUser);

    console.log("\nStates untouched by login (PROCESSING / terminal) ===\n");
    const uProc = await makeUser("proc");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uProc, "carol");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uProc }, data: { status: "PROCESSING", claimedAt: new Date(), claimToken: "live-worker" } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(uProc, "carol-renamed");
    const stillProcessing = await attempt(uProc);
    check("9. a PROCESSING row is never touched by a login, even with a changed username", stillProcessing.status === "PROCESSING" && stillProcessing.sqlGeneralUsername === "carol" && stillProcessing.claimToken === "live-worker");

    const uDone = await makeUser("done");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uDone, "dave");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uDone }, data: { status: "SUCCEEDED", attemptCount: 1 } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(uDone, "dave");
    check("10. login never re-triggers a SUCCEEDED row on its own", (await attempt(uDone)).status === "SUCCEEDED");

    console.log("\nExplicit admin refresh ===\n");
    const refreshSucceeded = await svc.requestManualSqlGeneralUserSyncRefresh(uDone);
    const afterRefresh = await attempt(uDone);
    check("11. admin refresh revives a SUCCEEDED row to PENDING (reset attemptCount/lastError)", refreshSucceeded.reset === true && afterRefresh.status === "PENDING" && afterRefresh.attemptCount === 0);

    const refreshPending = await svc.requestManualSqlGeneralUserSyncRefresh(uDone);
    check("12. admin refresh never disturbs an already-PENDING row", refreshPending.reset === false && (await attempt(uDone)).status === "PENDING");

    const refreshProcessing = await svc.requestManualSqlGeneralUserSyncRefresh(uProc);
    check("13. admin refresh never disturbs a PROCESSING row", refreshProcessing.reset === false && (await attempt(uProc)).status === "PROCESSING");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uProc }, data: { status: "PENDING", claimedAt: null, claimToken: null } });

    const uNoRow = await makeUser("norow");
    const refreshNoRow = await svc.requestManualSqlGeneralUserSyncRefresh(uNoRow);
    check("14. admin refresh for a user with no row yet creates one as PENDING", refreshNoRow.reset === true && (await attempt(uNoRow)).status === "PENDING");

    const uFailedPerm = await makeUser("failedperm");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uFailedPerm, "erin");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uFailedPerm }, data: { status: "FAILED_PERMANENT", attemptCount: svc.MAX_ATTEMPTS, lastError: "boom" } });
    const uSkippedAgain = await makeUser("skippedagain");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uSkippedAgain, null);

    const allResult = await svc.requestManualSqlGeneralUserSyncRefreshAll();
    check("15. Sync All resets every terminal row (FAILED_PERMANENT, SKIPPED_NO_USERNAME, SUCCEEDED-already-reset-above) to PENDING", allResult.requested >= 2, `requested=${allResult.requested}`);
    check("15b. ...FAILED_PERMANENT row reset, attemptCount cleared", (await attempt(uFailedPerm)).status === "PENDING" && (await attempt(uFailedPerm)).attemptCount === 0);
    check("15c. ...SKIPPED_NO_USERNAME row reset to PENDING even with no username (worker will re-skip it, not error)", (await attempt(uSkippedAgain)).status === "PENDING" && (await attempt(uSkippedAgain)).sqlGeneralUsername === null);
    check("15d. Sync All never touches an active PENDING/PROCESSING row", (await attempt(uIdem)).status === "PENDING" && (await attempt(uNoUser)).status === "PENDING");

    console.log("\nWorker: defensive no-username finalize (no attempt consumed) ===\n");
    process.env.SQLGENERAL_SYNC_ENABLED = "true";
    const before15c = await attempt(uSkippedAgain);
    await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50 });
    const after15c = await attempt(uSkippedAgain);
    check("16. a claimed PENDING row with no username finalizes to SKIPPED_NO_USERNAME without consuming an attempt", before15c.attemptCount === 0 && after15c.status === "SKIPPED_NO_USERNAME" && after15c.attemptCount === 0, `status=${after15c.status} attempts=${after15c.attemptCount}`);

    console.log("\nWorker: bounded retries + exhaustion ===\n");
    const uRetry = await makeUser("retry");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uRetry, "frank");
    await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50 });
    const afterOne = await attempt(uRetry);
    check("17. a real (unconfigured/dummy-credential) external failure is bounded-retried: back to PENDING, attemptCount=1, not FAILED_PERMANENT yet", afterOne.status === "PENDING" && afterOne.attemptCount === 1 && !!afterOne.lastError, `status=${afterOne.status} count=${afterOne.attemptCount}`);

    for (let i = 1; i < svc.MAX_ATTEMPTS; i++) {
      await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50 });
    }
    const exhausted = await attempt(uRetry);
    check("18. after MAX_ATTEMPTS failures the row reaches FAILED_PERMANENT and stays claimable no more", exhausted.status === "FAILED_PERMANENT" && exhausted.attemptCount === svc.MAX_ATTEMPTS, `status=${exhausted.status} count=${exhausted.attemptCount}`);
    const noMoreClaims = await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50 });
    check("18b. a FAILED_PERMANENT row is never claimed again on a later run", (await attempt(uRetry)).status === "FAILED_PERMANENT", `claimed this run=${noMoreClaims.claimed}`);

    console.log("\nWorker: stale-claim recovery ===\n");
    const uStale = await makeUser("stale");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uStale, "grace");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uStale }, data: { status: "PROCESSING", claimedAt: new Date(Date.now() - 1 * 60_000), claimToken: "dead-worker" } });
    await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50, staleAfterMs: svc.STALE_CLAIM_TIMEOUT_MS });
    check("19. a FRESH PROCESSING claim (worker still alive) is not stolen", (await attempt(uStale)).status === "PROCESSING" && (await attempt(uStale)).claimToken === "dead-worker");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uStale }, data: { claimedAt: new Date(Date.now() - (svc.STALE_CLAIM_TIMEOUT_MS + 60_000)) } });
    await svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50, staleAfterMs: svc.STALE_CLAIM_TIMEOUT_MS });
    const recoveredStale = await attempt(uStale);
    check("20. a STALE PROCESSING claim (crashed worker) is reclaimed and processed exactly once (attemptCount=1, not re-stolen twice)", recoveredStale.status === "PENDING" && recoveredStale.attemptCount === 1, `status=${recoveredStale.status} count=${recoveredStale.attemptCount}`);

    console.log("\nWorker: concurrent claims ===\n");
    const concurrentUsers = await Promise.all([1, 2, 3, 4].map((i) => makeUser(`conc${i}`)));
    for (const uid of concurrentUsers) await svc.enqueueOrRecoverSqlGeneralUserSync(uid, `conc-${uid}`);
    const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => svc.processDueSqlGeneralUserSyncs({ now: new Date(), batchSize: 50 })));
    const totalClaimed = c1.claimed + c2.claimed + c3.claimed;
    const afterConcurrent = await Promise.all(concurrentUsers.map((uid) => attempt(uid)));
    // totalClaimed is NOT asserted === 4: the claim query is table-wide (by
    // design — see claimBatch), so other PENDING rows left over from
    // earlier sections in THIS SAME run legitimately get swept into the
    // same batches. The real "no double-processing" proof is per-row: each
    // of these 4 target rows was claimed and processed exactly once, never
    // twice by two of the three concurrent runs racing on it.
    check(
      "21. three concurrent worker runs claim these 4 rows between them exactly once each (no double-processing)",
      totalClaimed >= 4 && afterConcurrent.every((a) => a.attemptCount === 1 && a.status === "PENDING"),
      `totalClaimed=${totalClaimed} counts=${afterConcurrent.map((a) => a.attemptCount).join(",")}`
    );

    console.log("\nUsername matching + hierarchy resolution + Preview accuracy ===\n");
    const FAKE_ROOT = { id: "1", description: "Root", isActive: true, parentDepartmentId: null, country: null, company: "Acme Corp", companyShortname: "ACME", creationDate: null, updateTimestamp: null };
    const FAKE_ENGINEERING = { id: "10", description: "Engineering", isActive: true, parentDepartmentId: "1", country: null, company: "Acme Corp", companyShortname: "ACME", creationDate: null, updateTimestamp: null };
    const FAKE_ORPHAN = { id: "99", description: "Orphan Team", isActive: true, parentDepartmentId: "404", country: null, company: "Acme Corp", companyShortname: "ACME", creationDate: null, updateTimestamp: null };
    const FAKE_SALES = { id: "20", description: "Sales", isActive: true, parentDepartmentId: null, country: null, company: "Beta Co", companyShortname: "BETA", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN, FAKE_SALES] });

    const fakeUser = (username: string, hrDepartmentId: string | null, companyId: string | null = null, company = "Acme Corp") => ({
      username, mail: null, hrDepartmentId, department: null, companyId, company, active: true,
      managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
    });
    const CONFLICT_SQLGENERAL_COMPANY_ID = `sgcid-${RUN_ID}-acme`;
    mockFindUserImpl = async (username: string) => {
      if (username === "preview-unique" || username === "preview-conflict") return { outcome: "unique" as const, user: fakeUser(username, "10", username === "preview-conflict" ? CONFLICT_SQLGENERAL_COMPANY_ID : null) };
      if (username === "preview-missingparent") return { outcome: "unique" as const, user: fakeUser(username, "99") };
      if (username === "preview-notfound") return { outcome: "not_found" as const };
      if (username === "preview-ambiguous") return { outcome: "ambiguous" as const, count: 2 };
      if (username === "preview-deptconflict") return { outcome: "unique" as const, user: fakeUser(username, "20") };
      throw new Error(`unexpected username in mock: ${username}`);
    };

    // Pure hierarchy resolution — no network, no DB.
    const resolvedEng = client.resolveSqlGeneralDepartmentPlacement("10", [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN]);
    check(
      "26. hierarchy resolution builds the parent chain purely from ParentDepartmentId (root-to-immediate-parent order)",
      resolvedEng.outcome === "resolved" && resolvedEng.placement.department.id === "10" && resolvedEng.placement.parentChain.length === 1 && resolvedEng.placement.parentChain[0].id === "1" && !resolvedEng.placement.missingParent
    );
    const resolvedOrphan = client.resolveSqlGeneralDepartmentPlacement("99", [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN]);
    check("27. a ParentDepartmentId not present in the fetched set is reported as missingParent, never silently dropped", resolvedOrphan.outcome === "resolved" && resolvedOrphan.placement.missingParent === true);
    const resolvedMissing = client.resolveSqlGeneralDepartmentPlacement("not-a-real-id", [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN]);
    check("28. an HrDepartmentId with no matching Departments.Id is department_not_found, never guessed", resolvedMissing.outcome === "department_not_found");

    const uPvUnique = await makeUser("pv-unique");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvUnique, "preview-unique");
    const uPvMissingParent = await makeUser("pv-missingparent");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvMissingParent, "preview-missingparent");
    const uPvNotFound = await makeUser("pv-notfound");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvNotFound, "preview-notfound");
    const uPvAmbiguous = await makeUser("pv-ambiguous");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvAmbiguous, "preview-ambiguous");
    const uPvConflict = await makeUser("pv-conflict");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvConflict, "preview-conflict");
    const uPvDeptConflict = await makeUser("pv-deptconflict");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uPvDeptConflict, "preview-deptconflict");

    // A pre-existing LOCAL Company with the SAME normalized name, owned by
    // nobody (importSource null) — must be reported as a conflict, never claimed.
    const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");
    const existingCompany = await prisma.company.create({ data: { name: "Acme Corp", normalizedName: normalizeCompanyName("Acme Corp") } });
    companyIds.push(existingCompany.id);

    // Company-level ownership resolved (SQLGeneral-owned), but the specific
    // Department under it is owned by someone else — must surface as a
    // DEPARTMENT-level conflict, distinct from the company-level one above.
    const betaCompany = await prisma.company.create({ data: { name: "Beta Co", normalizedName: normalizeCompanyName("Beta Co"), importSource: "SQLGENERAL" } });
    companyIds.push(betaCompany.id);
    const salesDept = await prisma.department.create({ data: { name: "Sales", normalizedName: normalizeDepartmentName("Sales"), slug: `sales-${RUN_ID}`, companyId: betaCompany.id } });
    departmentIds.push(salesDept.id);

    const previewResult = await svc.previewSqlGeneralUserSync({ userIds: [uPvUnique, uPvMissingParent, uPvNotFound, uPvAmbiguous, uPvConflict, uPvDeptConflict] });
    if (!previewResult.ok) {
      check("29-33. Preview call succeeded", false, previewResult.reason);
    } else {
      const rows = previewResult.rows;
      const byUser = new Map(rows.map((r) => [r.userId, r]));
      const unique = byUser.get(uPvUnique);
      check(
        "29. Preview resolves a unique match's department/company and parent chain correctly",
        unique?.usernameMatch === "unique" && unique.departmentResolution === "resolved" && unique.departmentDescription === "Engineering" && unique.company === "Acme Corp" && unique.parentChain.length === 1 && unique.parentChain[0] === "Root" && unique.missingParent === false,
        JSON.stringify(unique)
      );
      const missingParentRow = byUser.get(uPvMissingParent);
      check("30. Preview flags missingParent for a department whose parent isn't in the fetched set", missingParentRow?.departmentResolution === "resolved" && missingParentRow.missingParent === true);
      const notFoundRow = byUser.get(uPvNotFound);
      check("31. Preview reports not_found for a username with zero SQLGeneral matches", notFoundRow?.usernameMatch === "not_found" && notFoundRow.departmentResolution === "n/a");
      const ambiguousRow = byUser.get(uPvAmbiguous);
      check("32. Preview reports ambiguous (never silently picks one) for a username matching more than one SQLGeneral user", ambiguousRow?.usernameMatch === "ambiguous");
      const conflictRow = byUser.get(uPvConflict);
      check(
        "33. Preview flags a conflict against an existing non-SQLGeneral-owned local Company — read-only, never claims or writes it",
        conflictRow?.localMatch === "conflict_other_owner" && !!conflictRow.conflictDetail && conflictRow.conflictLevel === "company" && conflictRow.sqlGeneralCompanyId === CONFLICT_SQLGENERAL_COMPANY_ID,
        JSON.stringify(conflictRow)
      );
      check("33b. Preview never wrote anything to the DB — the conflicting Company row is untouched (still importSource null)", (await prisma.company.findUniqueOrThrow({ where: { id: existingCompany.id } })).importSource === null);
      const deptConflictRow = byUser.get(uPvDeptConflict);
      check(
        "33c. Preview distinguishes a DEPARTMENT-level conflict (Company resolved/SQLGeneral-owned, Department owned by someone else) via structured conflictLevel",
        deptConflictRow?.localMatch === "conflict_other_owner" && deptConflictRow.conflictLevel === "department" && !!deptConflictRow.conflictDetail,
        JSON.stringify(deptConflictRow)
      );
      check("33d. ...and never writes to the conflicting Department either (still importSource null)", (await prisma.department.findUniqueOrThrow({ where: { id: salesDept.id } })).importSource === null);
    }

    console.log("\nExplicit admin-approved Company mapping ===\n");
    const companyMappingRoute = await import("@/app/api/admin/sqlgeneral-user-sync/company-mapping/route");
    const bfMapAdmin = await makeUser("mapadmin", Role.ADMIN, null);

    const beforePreview = await svc.previewSqlGeneralCompanyMappingCandidate(CONFLICT_SQLGENERAL_COMPANY_ID, existingCompany.id);
    check("54. preview-candidate: no existing mapping yet, target Company resolves correctly", beforePreview.existingMapping === null && beforePreview.targetCompany?.id === existingCompany.id);

    const invalidTarget = await svc.approveSqlGeneralCompanyMapping(CONFLICT_SQLGENERAL_COMPANY_ID, "not-a-real-company-id", bfMapAdmin);
    check("55. approve() rejects a non-existent targetCompanyId — never creates a stub Company", invalidTarget.ok === false, invalidTarget.ok ? "unexpectedly ok" : invalidTarget.reason);
    check("55b. ...and creates no mapping row either", !(await prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId: CONFLICT_SQLGENERAL_COMPANY_ID } })));

    const approved = await svc.approveSqlGeneralCompanyMapping(CONFLICT_SQLGENERAL_COMPANY_ID, existingCompany.id, bfMapAdmin);
    check("56. approve() succeeds, records approvedBy + approvedAt", approved.ok === true && approved.ok && approved.mapping.approvedById === bfMapAdmin && !!approved.mapping.approvedAt, approved.ok ? JSON.stringify(approved.mapping) : approved.reason);
    check("57. approving never modified the target Company's own fields (name/importSource unchanged)", (await prisma.company.findUniqueOrThrow({ where: { id: existingCompany.id } })).importSource === null && (await prisma.company.findUniqueOrThrow({ where: { id: existingCompany.id } })).name === "Acme Corp");

    const reApproveSame = await svc.approveSqlGeneralCompanyMapping(CONFLICT_SQLGENERAL_COMPANY_ID, existingCompany.id, bfMapAdmin);
    check("58. idempotency: re-approving the exact same pair is a safe no-op success, not an error", reApproveSame.ok === true && (await prisma.sqlGeneralCompanyMapping.count({ where: { sqlGeneralCompanyId: CONFLICT_SQLGENERAL_COMPANY_ID } })) === 1);

    const betaCompanyForDup = betaCompany;
    const duplicateDifferentTarget = await svc.approveSqlGeneralCompanyMapping(CONFLICT_SQLGENERAL_COMPANY_ID, betaCompanyForDup.id, bfMapAdmin);
    check("59. duplicate prevention: approving the SAME sqlGeneralCompanyId against a DIFFERENT Company is rejected, never silently repointed", duplicateDifferentTarget.ok === false);
    check("59b. ...the original mapping is still intact and unchanged", (await prisma.sqlGeneralCompanyMapping.findUniqueOrThrow({ where: { sqlGeneralCompanyId: CONFLICT_SQLGENERAL_COMPANY_ID } })).companyId === existingCompany.id);

    const previewAfterApproval = await svc.previewSqlGeneralUserSync({ userIds: [uPvConflict] });
    if (!previewAfterApproval.ok) {
      check("60. Preview re-run after approval succeeded", false, previewAfterApproval.reason);
    } else {
      const rowAfter = previewAfterApproval.rows[0];
      check(
        "60. Preview now reports approved_external_mapping (NOT existing_sqlgeneral_owned, NOT conflict_other_owner) for the approved Company",
        rowAfter?.localMatch === "approved_external_mapping" && rowAfter.conflictLevel === null,
        JSON.stringify(rowAfter)
      );
    }

    currentSession = { user: { id: bfMapAdmin, role: Role.ADMIN, customRoleId: null } };
    const mappingGetReq = new NextRequest(`http://localhost/x?sqlGeneralCompanyId=${CONFLICT_SQLGENERAL_COMPANY_ID}&targetCompanyId=${existingCompany.id}`, { method: "GET" });
    const mappingGetRes = await companyMappingRoute.GET(mappingGetReq);
    check("61. Company-mapping GET (candidate preview) endpoint: ADMIN succeeds, returns the existing mapping", mappingGetRes.status === 200);
    currentSession = { user: { id: bfMapAdmin, role: Role.USER, customRoleId: null } };
    const mappingPostForbidden = await companyMappingRoute.POST(jsonReq("POST", { sqlGeneralCompanyId: CONFLICT_SQLGENERAL_COMPANY_ID, targetCompanyId: existingCompany.id }));
    check("62. Company-mapping POST endpoint: a user without organization.sqlgeneralSync gets 403", mappingPostForbidden.status === 403);
    currentSession = null;

    console.log("\nCompany mapping safety: unknown source IDs + many-to-one confirmation ===\n");

    const UNKNOWN_SOURCE_ID = `sgcid-${RUN_ID}-unknown`;
    mockVerifyCompanyIdImpl = async () => ({ ok: true, exists: false });
    const unknownSourceResult = await svc.approveSqlGeneralCompanyMapping(UNKNOWN_SOURCE_ID, existingCompany.id, bfMapAdmin);
    check("63. approve() rejects a sqlGeneralCompanyId that SQLGeneral itself does not confirm exists — never approves an arbitrary identifier", unknownSourceResult.ok === false, unknownSourceResult.ok ? "unexpectedly ok" : unknownSourceResult.reason);
    check("63b. ...and creates no mapping row", !(await prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId: UNKNOWN_SOURCE_ID } })));

    mockVerifyCompanyIdImpl = async () => ({ ok: false, reason: "mock: verification unavailable (simulating unconfigured/network failure)" });
    const unverifiableResult = await svc.approveSqlGeneralCompanyMapping(UNKNOWN_SOURCE_ID, existingCompany.id, bfMapAdmin);
    check("64. approve() treats a verification FAILURE (not configured/network) the same as unknown — rejects, never approves on an unverifiable identifier", unverifiableResult.ok === false, unverifiableResult.ok ? "unexpectedly ok" : unverifiableResult.reason);

    mockVerifyCompanyIdImpl = async () => ({ ok: true, exists: true });
    const NEW_VERIFIED_SOURCE_ID = `sgcid-${RUN_ID}-newverified`;

    const candidateBeforeMulti = await svc.previewSqlGeneralCompanyMappingCandidate(NEW_VERIFIED_SOURCE_ID, existingCompany.id);
    check(
      "65. Preview candidate surfaces the ALREADY-approved mapping from a DIFFERENT sqlGeneralCompanyId to this same target (many-to-one warning)",
      candidateBeforeMulti.otherMappingsToSameTarget.includes(CONFLICT_SQLGENERAL_COMPANY_ID) && candidateBeforeMulti.sourceVerified === true,
      JSON.stringify(candidateBeforeMulti)
    );

    const multiWithoutConfirm = await svc.approveSqlGeneralCompanyMapping(NEW_VERIFIED_SOURCE_ID, existingCompany.id, bfMapAdmin);
    check(
      "66. approve() rejects a genuinely NEW many-to-one mapping without explicit confirmMultipleMapping — never created silently",
      multiWithoutConfirm.ok === false,
      multiWithoutConfirm.ok ? "unexpectedly ok" : multiWithoutConfirm.reason
    );
    check("66b. ...no mapping row was created", !(await prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId: NEW_VERIFIED_SOURCE_ID } })));

    const multiWithConfirm = await svc.approveSqlGeneralCompanyMapping(NEW_VERIFIED_SOURCE_ID, existingCompany.id, bfMapAdmin, true);
    check("67. approve() with confirmMultipleMapping: true succeeds — many-to-one is a legitimate, preservable state", multiWithConfirm.ok === true, multiWithConfirm.ok ? "" : multiWithConfirm.reason);
    const mappingsToTarget = await prisma.sqlGeneralCompanyMapping.findMany({ where: { companyId: existingCompany.id } });
    check(
      "68. BOTH mappings to the same target now coexist intact — the earlier one was never removed/overwritten",
      mappingsToTarget.length === 2 && mappingsToTarget.some((m) => m.sqlGeneralCompanyId === CONFLICT_SQLGENERAL_COMPANY_ID) && mappingsToTarget.some((m) => m.sqlGeneralCompanyId === NEW_VERIFIED_SOURCE_ID),
      JSON.stringify(mappingsToTarget.map((m) => m.sqlGeneralCompanyId))
    );
    check(
      "69. Company's own fields/ownership are STILL untouched after the second (multi) approval too",
      (await prisma.company.findUniqueOrThrow({ where: { id: existingCompany.id } })).importSource === null && (await prisma.company.findUniqueOrThrow({ where: { id: existingCompany.id } })).name === "Acme Corp"
    );

    // Idempotent re-approval of an ALREADY-multi-mapped pair must not re-require confirmation.
    const reApproveMultiNoConfirmFlag = await svc.approveSqlGeneralCompanyMapping(NEW_VERIFIED_SOURCE_ID, existingCompany.id, bfMapAdmin);
    check("70. idempotency holds even for an already-multi-mapped pair: re-approving the SAME pair succeeds without needing confirmMultipleMapping again", reApproveMultiNoConfirmFlag.ok === true);

    console.log("\nExplicit admin-approved Department mapping ===\n");
    const departmentMappingRoute = await import("@/app/api/admin/sqlgeneral-user-sync/department-mapping/route");
    const ENGINEERING_SQLGENERAL_DEPARTMENT_ID = "10"; // FAKE_ENGINEERING's own id — matches department.id as resolved by Preview

    // The real production scenario: an existing, non-SQLGeneral-owned local
    // Department under a Company that DOES have an approved Company mapping.
    const engineeringDept = await prisma.department.create({
      data: { name: "Engineering", normalizedName: normalizeDepartmentName("Engineering"), slug: `engineering-${RUN_ID}`, companyId: existingCompany.id },
    });
    departmentIds.push(engineeringDept.id);

    const previewDeptConflictBefore = await svc.previewSqlGeneralUserSync({ userIds: [uPvConflict] });
    if (!previewDeptConflictBefore.ok) {
      check("71. precondition preview succeeded", false, previewDeptConflictBefore.reason);
    } else {
      const rowBefore = previewDeptConflictBefore.rows[0];
      check(
        "71. precondition: with the Company mapping approved but no Department mapping yet, Preview now correctly reports a DEPARTMENT-level conflict against the real existing \"Engineering\" Department",
        rowBefore?.localMatch === "conflict_other_owner" && rowBefore.conflictLevel === "department",
        JSON.stringify(rowBefore)
      );
    }

    mockVerifyDepartmentIdImpl = async () => ({ ok: true, exists: false });
    const unknownDeptSource = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id, bfMapAdmin);
    check("72. approve() rejects a sqlGeneralDepartmentId that SQLGeneral itself does not confirm exists", unknownDeptSource.ok === false, unknownDeptSource.ok ? "unexpectedly ok" : unknownDeptSource.reason);

    mockVerifyDepartmentIdImpl = async () => ({ ok: false, reason: "mock: verification unavailable" });
    const unverifiableDeptSource = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id, bfMapAdmin);
    check("73. approve() treats a verification FAILURE the same as unknown — rejects, never approves on an unverifiable identifier", unverifiableDeptSource.ok === false);

    mockVerifyDepartmentIdImpl = async () => ({ ok: true, exists: true });

    // "Unsafe parent relationship": salesDept's Company (betaCompany) has
    // importSource=SQLGENERAL set directly as a test fixture, but has NO
    // actual approved SqlGeneralCompanyMapping row — approving a Department
    // mapping under it must be refused.
    const unsafeParent = await svc.approveSqlGeneralDepartmentMapping("20", salesDept.id, bfMapAdmin);
    check(
      "74. approve() refuses an unsafe parent relationship: target Department's own Company has no approved SqlGeneralCompanyMapping yet",
      unsafeParent.ok === false,
      unsafeParent.ok ? "unexpectedly ok" : unsafeParent.reason
    );
    check("74b. ...no mapping row was created", !(await prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: "20" } })));

    const deptCandidate = await svc.previewSqlGeneralDepartmentMappingCandidate(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id);
    check(
      "75. Department mapping candidate preview correctly reports the target's own Company HAS an approved Company mapping (safe to proceed)",
      deptCandidate.companyMappingForTargetDepartment?.sqlGeneralCompanyId === CONFLICT_SQLGENERAL_COMPANY_ID && deptCandidate.sourceVerified === true,
      JSON.stringify(deptCandidate)
    );
    check(
      "75b. candidate preview's hierarchyValidation correctly reports an UNMAPPED ancestor (\"Root\", id 1) — Company matches but hierarchy cannot yet be verified",
      deptCandidate.hierarchyValidation.status === "unmapped_ancestor" && (deptCandidate.hierarchyValidation as { sqlGeneralDepartmentId: string }).sqlGeneralDepartmentId === "1",
      JSON.stringify(deptCandidate.hierarchyValidation)
    );

    console.log("\nHierarchy validation: root, matching chain, unresolved and mismatched ancestor ===\n");

    // Must NOT be approvable yet: Company matches, but the ancestor ("Root",
    // id "1") has no approved mapping — "cannot be verified", not inferred
    // from missingParent alone (missingParent is false here; the chain
    // resolves fine on the SQLGeneral side, it's the LOCAL mapping chain
    // that's incomplete).
    const engineeringBeforeRoot = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id, bfMapAdmin);
    check(
      "83. approve() blocks an INTERMEDIATE department whose ancestor isn't mapped yet, even though Company matches and missingParent is false",
      engineeringBeforeRoot.ok === false,
      engineeringBeforeRoot.ok ? "unexpectedly ok" : engineeringBeforeRoot.reason
    );

    // ROOT Department: "Root" (id "1") has no ParentDepartmentId at all —
    // always "root", verified by construction, no ancestors to check.
    const rootDept = await prisma.department.create({
      data: { name: "Root", normalizedName: normalizeDepartmentName("Root"), slug: `root-${RUN_ID}`, companyId: existingCompany.id },
    });
    departmentIds.push(rootDept.id);
    const rootCandidate = await svc.previewSqlGeneralDepartmentMappingCandidate("1", rootDept.id);
    check("84. candidate preview correctly reports a ROOT department (no ParentDepartmentId) as hierarchy-verified with nothing to check", rootCandidate.hierarchyValidation.status === "root", JSON.stringify(rootCandidate.hierarchyValidation));
    const rootApproved = await svc.approveSqlGeneralDepartmentMapping("1", rootDept.id, bfMapAdmin);
    check("85. approve() succeeds for a ROOT Department mapping", rootApproved.ok === true, rootApproved.ok ? "" : rootApproved.reason);

    // MATCHING parent chain: now that "Root" is mapped into existingCompany,
    // "Engineering" (child of "Root") in the SAME company should verify and succeed.
    const engineeringCandidateAfterRoot = await svc.previewSqlGeneralDepartmentMappingCandidate(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id);
    check("86. candidate preview now reports \"verified\" once the ancestor is mapped into the SAME Company — a matching parent chain", engineeringCandidateAfterRoot.hierarchyValidation.status === "verified", JSON.stringify(engineeringCandidateAfterRoot.hierarchyValidation));
    const deptApproved = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id, bfMapAdmin);
    check("76. approve() succeeds for a safe, now-verified parent relationship, records approvedBy + approvedAt", deptApproved.ok === true && deptApproved.ok && deptApproved.mapping.approvedById === bfMapAdmin, deptApproved.ok ? JSON.stringify(deptApproved.mapping) : deptApproved.reason);
    check(
      "77. approving never modified the target Department's own fields (name/importSource/companyId unchanged)",
      (await prisma.department.findUniqueOrThrow({ where: { id: engineeringDept.id } })).importSource === null &&
        (await prisma.department.findUniqueOrThrow({ where: { id: engineeringDept.id } })).name === "Engineering" &&
        (await prisma.department.findUniqueOrThrow({ where: { id: engineeringDept.id } })).companyId === existingCompany.id
    );

    // UNRESOLVED parent: "Orphan Team" (id "99") has a ParentDepartmentId
    // ("404") that is NOT present in the fetched Departments set at all —
    // missingParent is true, so this is "ambiguous, cannot be verified",
    // blocked regardless of Company matching.
    const orphanUnresolved = await svc.approveSqlGeneralDepartmentMapping("99", engineeringDept.id, bfMapAdmin, true);
    check("87. approve() blocks a department with an UNRESOLVED parent (missingParent=true) — ambiguous, cannot be verified", orphanUnresolved.ok === false, orphanUnresolved.ok ? "unexpectedly ok" : orphanUnresolved.reason);

    // MISMATCHED ancestor: a new SQLGeneral department ("11") also claims
    // "Root" (id "1") as its parent — but "Root" is mapped into
    // existingCompany, while THIS department is being proposed for a
    // Department under a totally different, independently-approved Company.
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN, FAKE_SALES, { id: "11", description: "Engineering Satellite", isActive: true, parentDepartmentId: "1", country: null, company: "Gamma Co", companyShortname: "GAMMA", creationDate: null, updateTimestamp: null }] });
    const GAMMA_SQLGENERAL_COMPANY_ID = `sgcid-${RUN_ID}-gamma`;
    mockVerifyCompanyIdImpl = async () => ({ ok: true, exists: true });
    const gammaCompany = await prisma.company.create({ data: { name: "Gamma Co", normalizedName: normalizeCompanyName("Gamma Co") } });
    companyIds.push(gammaCompany.id);
    await svc.approveSqlGeneralCompanyMapping(GAMMA_SQLGENERAL_COMPANY_ID, gammaCompany.id, bfMapAdmin);
    const gammaDept = await prisma.department.create({
      data: { name: "Engineering Satellite", normalizedName: normalizeDepartmentName("Engineering Satellite"), slug: `eng-satellite-${RUN_ID}`, companyId: gammaCompany.id },
    });
    departmentIds.push(gammaDept.id);

    const mismatchCandidate = await svc.previewSqlGeneralDepartmentMappingCandidate("11", gammaDept.id);
    check(
      "88. candidate preview reports a MISMATCHED ancestor: \"Root\" is already mapped into a DIFFERENT Company than the one proposed here",
      mismatchCandidate.hierarchyValidation.status === "conflicting_ancestor" && (mismatchCandidate.hierarchyValidation as { sqlGeneralDepartmentId: string }).sqlGeneralDepartmentId === "1",
      JSON.stringify(mismatchCandidate.hierarchyValidation)
    );
    const mismatchApprove = await svc.approveSqlGeneralDepartmentMapping("11", gammaDept.id, bfMapAdmin);
    check("89. approve() blocks a MISMATCHED parent relationship — Company matches (Gamma Co has its own approval) but the ancestor conflicts", mismatchApprove.ok === false, mismatchApprove.ok ? "unexpectedly ok" : mismatchApprove.reason);
    check("89b. ...no mapping row was created for the mismatched department", !(await prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: "11" } })));
    check("89c. ...and gammaDept's own fields remain untouched", (await prisma.department.findUniqueOrThrow({ where: { id: gammaDept.id } })).importSource === null);

    // Restore the department list mock for the remainder of the suite.
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_ROOT, FAKE_ENGINEERING, FAKE_ORPHAN, FAKE_SALES] });

    const deptReApproveSame = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, engineeringDept.id, bfMapAdmin);
    check("78. idempotency: re-approving the exact same Department pair is a safe no-op success", deptReApproveSame.ok === true && (await prisma.sqlGeneralDepartmentMapping.count({ where: { sqlGeneralDepartmentId: ENGINEERING_SQLGENERAL_DEPARTMENT_ID } })) === 1);

    const deptDuplicateDifferentTarget = await svc.approveSqlGeneralDepartmentMapping(ENGINEERING_SQLGENERAL_DEPARTMENT_ID, salesDept.id, bfMapAdmin);
    check("79. duplicate prevention: approving the SAME sqlGeneralDepartmentId against a DIFFERENT Department is rejected, never silently repointed", deptDuplicateDifferentTarget.ok === false);

    const previewDeptConflictAfter = await svc.previewSqlGeneralUserSync({ userIds: [uPvConflict] });
    if (!previewDeptConflictAfter.ok) {
      check("80. Preview re-run after Department approval succeeded", false, previewDeptConflictAfter.reason);
    } else {
      const rowAfter = previewDeptConflictAfter.rows[0];
      check(
        "80. Preview now resolves approved_external_mapping (sync and preview resolve the approved Department mapping consistently) — no more department-level conflict",
        rowAfter?.localMatch === "approved_external_mapping" && rowAfter.conflictLevel === null,
        JSON.stringify(rowAfter)
      );
    }

    currentSession = { user: { id: bfMapAdmin, role: Role.ADMIN, customRoleId: null } };
    const deptMappingGetReq = new NextRequest(`http://localhost/x?sqlGeneralDepartmentId=${ENGINEERING_SQLGENERAL_DEPARTMENT_ID}&targetDepartmentId=${engineeringDept.id}`, { method: "GET" });
    const deptMappingGetRes = await departmentMappingRoute.GET(deptMappingGetReq);
    check("81. Department-mapping GET (candidate preview) endpoint: ADMIN succeeds", deptMappingGetRes.status === 200);
    currentSession = { user: { id: bfMapAdmin, role: Role.USER, customRoleId: null } };
    const deptMappingPostForbidden = await departmentMappingRoute.POST(jsonReq("POST", { sqlGeneralDepartmentId: ENGINEERING_SQLGENERAL_DEPARTMENT_ID, targetDepartmentId: engineeringDept.id }));
    check("82. Department-mapping POST endpoint: a user without organization.sqlgeneralSync gets 403", deptMappingPostForbidden.status === 403);
    currentSession = null;

    console.log("\nPreview coverage: N/All must include eligible users with NO existing attempt row ===\n");
    const uPvNoAttempt = await makeUser("pv-noattempt"); // never enqueued — no SqlGeneralUserSyncAttempt row exists for this user at all
    check("34. precondition: no attempt row exists yet for this user", !(await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: uPvNoAttempt } })));
    const previewNoAttempt = await svc.previewSqlGeneralUserSync({ userIds: [uPvNoAttempt] });
    check(
      "35. Preview N reports a user with no attempt row at all as no_username_captured, never silently omitting them from the result",
      previewNoAttempt.ok === true && previewNoAttempt.rows.length === 1 && previewNoAttempt.rows[0].userId === uPvNoAttempt && previewNoAttempt.rows[0].usernameMatch === "no_username_captured",
      previewNoAttempt.ok ? JSON.stringify(previewNoAttempt.rows) : previewNoAttempt.reason
    );

    const uEligible = await makeUser("eligible");
    await prisma.user.update({ where: { id: uEligible }, data: { microsoftUserId: `msid-${RUN_ID}-eligible` } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(uEligible, "preview-unique");
    const uIneligibleNoMs = await makeUser("ineligible-no-ms"); // isActive, but never signed in via Microsoft — microsoftUserId stays null
    const uIneligibleInactive = await makeUser("ineligible-inactive");
    await prisma.user.update({ where: { id: uIneligibleInactive }, data: { microsoftUserId: `msid-${RUN_ID}-inactive`, isActive: false } });

    const previewAll = await svc.previewSqlGeneralUserSync({ all: true });
    if (!previewAll.ok) {
      check("36-37. Preview All succeeded", false, previewAll.reason);
    } else {
      const allIds = new Set(previewAll.rows.map((r) => r.userId));
      check("36. Preview All includes an active, Microsoft-authenticated eligible user even with no filters applied", allIds.has(uEligible));
      check(
        "37. Preview All excludes a credentials-only (never signed in via Microsoft) user and an inactive Microsoft user — never guesses eligibility, never touches User rows either way",
        !allIds.has(uIneligibleNoMs) && !allIds.has(uIneligibleInactive)
      );
    }
    await prisma.user.update({ where: { id: uIneligibleInactive }, data: { isActive: true } }); // restore before generic cleanup below (deleteMany doesn't care, but keeps intent clear)

    console.log("\nGraph username backfill: ID matching, missing usernames, conflicts, state preservation ===\n");

    const bfNoRow = await makeUser("bf-norow");
    await prisma.user.update({ where: { id: bfNoRow }, data: { microsoftUserId: `graph-${RUN_ID}-norow` } });
    const bfSkipped = await makeUser("bf-skipped");
    await prisma.user.update({ where: { id: bfSkipped }, data: { microsoftUserId: `graph-${RUN_ID}-skipped` } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(bfSkipped, null); // SKIPPED_NO_USERNAME
    const bfPendingSame = await makeUser("bf-pending-same");
    await prisma.user.update({ where: { id: bfPendingSame }, data: { microsoftUserId: `graph-${RUN_ID}-pending-same` } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(bfPendingSame, "already.correct");
    const bfPendingConflict = await makeUser("bf-pending-conflict");
    await prisma.user.update({ where: { id: bfPendingConflict }, data: { microsoftUserId: `graph-${RUN_ID}-pending-conflict` } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(bfPendingConflict, "the.old.captured.one");
    const bfSucceeded = await makeUser("bf-succeeded");
    await prisma.user.update({ where: { id: bfSucceeded }, data: { microsoftUserId: `graph-${RUN_ID}-succeeded` } });
    await svc.enqueueOrRecoverSqlGeneralUserSync(bfSucceeded, "already.synced");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: bfSucceeded }, data: { status: "SUCCEEDED" } });
    const bfNoGraphUsername = await makeUser("bf-nographusername");
    await prisma.user.update({ where: { id: bfNoGraphUsername }, data: { microsoftUserId: `graph-${RUN_ID}-nographusername` } });
    const bfNotLinked = await makeUser("bf-notlinked"); // never Microsoft-linked at all — must never appear as a candidate, confirming matching is by id, not by anything else

    mockFetchIdentitiesImpl = async () => ({
      ok: true,
      identities: [
        { graphId: `graph-${RUN_ID}-norow`, onPremisesSamAccountName: "fresh.from.graph" },
        { graphId: `graph-${RUN_ID}-skipped`, onPremisesSamAccountName: "recovered.from.graph" },
        { graphId: `graph-${RUN_ID}-pending-same`, onPremisesSamAccountName: "already.correct" },
        { graphId: `graph-${RUN_ID}-pending-conflict`, onPremisesSamAccountName: "a.totally.different.value" },
        { graphId: `graph-${RUN_ID}-succeeded`, onPremisesSamAccountName: "a.value.that.would.overwrite.if.applied" },
        { graphId: `graph-${RUN_ID}-nographusername`, onPremisesSamAccountName: null },
        { graphId: `graph-${RUN_ID}-unmatched-ghost`, onPremisesSamAccountName: "nobody.local.has.this.id" },
      ],
    });

    const bfPreview1 = await svc.previewSqlGeneralUsernameBackfill();
    if (!bfPreview1.ok) {
      check("38-44. backfill preview succeeded", false, bfPreview1.reason);
    } else {
      const byUser = new Map(bfPreview1.candidates.map((c) => [c.userId, c]));
      check("38. Graph id -> User.microsoftUserId matching: a never-Microsoft-linked user never appears as a candidate", !byUser.has(bfNotLinked) && !bfPreview1.candidates.some((c) => c.graphId === `graph-${RUN_ID}-unmatched-ghost`));
      check("39. no existing attempt row + a Graph username => create_pending (not yet written by preview)", byUser.get(bfNoRow)?.action === "create_pending" && byUser.get(bfNoRow)?.graphUsername === "fresh.from.graph");
      check("40. SKIPPED_NO_USERNAME + a Graph username => recover_pending", byUser.get(bfSkipped)?.action === "recover_pending" && byUser.get(bfSkipped)?.graphUsername === "recovered.from.graph");
      check("41. PENDING with the SAME username already captured => no_change", byUser.get(bfPendingSame)?.action === "no_change");
      check(
        "42. PENDING with a DIFFERENT username already captured => conflicting_username_skipped (never silently overwritten)",
        byUser.get(bfPendingConflict)?.action === "conflicting_username_skipped" && byUser.get(bfPendingConflict)?.currentUsername === "the.old.captured.one" && byUser.get(bfPendingConflict)?.graphUsername === "a.totally.different.value"
      );
      check("43. SUCCEEDED (terminal, active/successful state) => active_or_terminal_skipped regardless of what Graph says — state preservation", byUser.get(bfSucceeded)?.action === "active_or_terminal_skipped");
      check("44. a Graph identity with no onPremisesSamAccountName => no_graph_username", byUser.get(bfNoGraphUsername)?.action === "no_graph_username");
    }

    const beforeApply = {
      skipped: await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: bfSkipped } }),
      pendingConflict: await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: bfPendingConflict } }),
      succeeded: await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: bfSucceeded } }),
      noRowExistsYet: await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId: bfNoRow } }),
    };
    check("45. precondition: preview alone wrote nothing (no_row user still has no attempt row)", !beforeApply.noRowExistsYet);

    const applyResult1 = await svc.applySqlGeneralUsernameBackfill();
    if (!applyResult1.ok) {
      check("46-50. backfill apply succeeded", false, applyResult1.reason);
    } else {
      check("46. apply() actually creates the missing row as PENDING with the Graph username (never touching User)", (await prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId: bfNoRow } })).status === "PENDING");
      const recovered = await prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId: bfSkipped } });
      check("47. apply() recovers the SKIPPED_NO_USERNAME row to PENDING with the Graph username", recovered.status === "PENDING" && recovered.sqlGeneralUsername === "recovered.from.graph");
      const stillPendingConflict = await prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId: bfPendingConflict } });
      check("48. apply() NEVER overwrites the conflicting username — row is byte-for-byte unchanged from before apply", stillPendingConflict.sqlGeneralUsername === beforeApply.pendingConflict?.sqlGeneralUsername && stillPendingConflict.updatedAt.getTime() === beforeApply.pendingConflict?.updatedAt.getTime());
      const stillSucceeded = await prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId: bfSucceeded } });
      check("49. apply() never touches a SUCCEEDED row even though Graph offered a different value — active/successful state preserved", stillSucceeded.status === "SUCCEEDED" && stillSucceeded.sqlGeneralUsername === beforeApply.succeeded?.sqlGeneralUsername);
      check("50. apply() never created or modified any User row (spot-check: microsoftUserId values untouched)", (await prisma.user.findUniqueOrThrow({ where: { id: bfNoRow } })).microsoftUserId === `graph-${RUN_ID}-norow`);
    }

    const applyResult2 = await svc.applySqlGeneralUsernameBackfill();
    check(
      "51. idempotency: running apply() a second time with the same Graph data makes no further changes (create_pending/recover_pending counts both now zero)",
      applyResult2.ok === true && applyResult2.counts.createPending === 0 && applyResult2.counts.recoverPending === 0,
      applyResult2.ok ? JSON.stringify(applyResult2.counts) : applyResult2.reason
    );

    console.log("\nBackfill admin endpoint authorization ===\n");
    currentSession = { user: { id: bfNoRow, role: Role.USER, customRoleId: null } };
    const backfillForbidden = await backfillRoute.POST(jsonReq("POST", {}));
    check("52. backfill endpoint: a user without organization.sqlgeneralSync gets 403", backfillForbidden.status === 403);

    const bfAdmin = await makeUser("bf-admin", Role.ADMIN, null);
    currentSession = { user: { id: bfAdmin, role: Role.ADMIN, customRoleId: null } };
    mockFetchIdentitiesImpl = async () => ({ ok: true, identities: [] });
    const backfillAdminPreview = await backfillRoute.POST(jsonReq("POST", {}));
    const backfillAdminPreviewBody = await backfillAdminPreview.json();
    check("53. ADMIN bypasses the permission check; default (no apply flag) is preview-only and returns candidates+counts", backfillAdminPreview.status === 200 && Array.isArray(backfillAdminPreviewBody.candidates) && !!backfillAdminPreviewBody.counts);
    currentSession = null;

    console.log("\nAdmin endpoint authorization ===\n");
    const noop = await (async () => {
      const r = await prisma.customRole.create({ data: { key: `SGS_NOOP_${RUN_ID}`, name: `SGS NOOP ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
      roleIds.push(r.id);
      roleKeys.push(r.key);
      return r;
    })();
    const granted = await (async () => {
      const r = await prisma.customRole.create({ data: { key: `SGS_GRANT_${RUN_ID}`, name: `SGS GRANT ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
      roleIds.push(r.id);
      roleKeys.push(r.key);
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "organization.sqlgeneralSync" } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
      return r;
    })();
    const nonPermUser = await makeUser("nonperm", Role.USER, noop.id);
    const grantedUser = await makeUser("granted", Role.USER, granted.id);
    const adminUser = await makeUser("admin", Role.ADMIN, null);

    currentSession = { user: { id: nonPermUser, role: Role.USER, customRoleId: noop.id } };
    const forbidden = await adminRoute.POST(jsonReq("POST", { all: true }));
    check("22. a user without organization.sqlgeneralSync gets 403", forbidden.status === 403);

    currentSession = { user: { id: grantedUser, role: Role.USER, customRoleId: granted.id } };
    const uGrantTarget = await makeUser("granttarget");
    await svc.enqueueOrRecoverSqlGeneralUserSync(uGrantTarget, "henry");
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId: uGrantTarget }, data: { status: "SUCCEEDED" } });
    const grantedOk = await adminRoute.POST(jsonReq("POST", { userId: uGrantTarget }));
    check("23. a custom role WITH organization.sqlgeneralSync can trigger a single-user refresh", grantedOk.status === 200 && (await attempt(uGrantTarget)).status === "PENDING");

    currentSession = { user: { id: adminUser, role: Role.ADMIN, customRoleId: null } };
    const adminOk = await adminRoute.POST(jsonReq("POST", {}));
    check("24. ADMIN bypasses the permission check; invalid body (neither userId nor all) is rejected 400", adminOk.status === 400);
    currentSession = null;

    console.log("\nWorker endpoint authentication ===\n");
    const prevSecret = process.env.CRON_SECRET;
    const prevEnv = process.env.NODE_ENV;
    process.env.CRON_SECRET = "s3cret-sgs-test";
    const noAuth = await workerRoute.POST(jsonReq("POST"));
    const right = await workerRoute.POST(new NextRequest("http://localhost/x", { method: "POST", headers: { authorization: "Bearer s3cret-sgs-test" } }));
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const failClosed = await workerRoute.POST(jsonReq("POST"));
    (process.env as Record<string, string>).NODE_ENV = prevEnv ?? "test";
    if (prevSecret) process.env.CRON_SECRET = prevSecret;
    check("25. worker endpoint: 401 without a token, 200 with the correct secret, fails closed in production with none configured", noAuth.status === 401 && right.status === 200 && failClosed.status === 401);
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      // Must run BEFORE "users": approvedById is onDelete:Restrict, so a
      // leftover mapping row would abort the whole user deleteMany batch.
      ["sqlGeneral company mappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { approvedById: { in: userIds } } })],
      ["sqlGeneral department mappings", () => prisma.sqlGeneralDepartmentMapping.deleteMany({ where: { approvedById: { in: userIds } } })],
      ["sync attempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: roleKeys } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: roleIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
      ["companies", () => prisma.company.deleteMany({ where: { id: { in: companyIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    if (originalEnabled === undefined) delete process.env.SQLGENERAL_SYNC_ENABLED;
    else process.env.SQLGENERAL_SYNC_ENABLED = originalEnabled;
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main();
