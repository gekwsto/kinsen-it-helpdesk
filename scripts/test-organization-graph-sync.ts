/**
 * Organization Graph sync — pagination, 429 retry/backoff, 401/403 typed
 * errors, partial-failure isolation, idempotent repeated sync, manager
 * resolution/cycle-rejection, and concurrent-sync-prevention (locking).
 * Every Graph call is a mocked `global.fetch` (fetch-level stub, matching
 * the existing `test-microsoft-*.ts` scripts' approach) — never requires a
 * real Azure tenant. GRAPH_* env vars are set to correctly-SHAPED but fake
 * values so credential-format validation passes without a real secret.
 *
 * Usage: npx tsx scripts/test-organization-graph-sync.ts
 * Requires a reachable DATABASE_URL for the DB-writing sections — skips
 * (not fails) those if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { OrganizationSyncType, AuthProvider } from "@prisma/client";
import { fetchWithGraphRetry } from "@/lib/microsoft-graph-retry";
import { validateDirectoryUser, fetchAllTenantUsers, runOrganizationDirectorySync, type DirectoryRawUserRecord } from "@/lib/services/organization-directory-sync-service";
import { runOrganizationManagerSync } from "@/lib/services/organization-manager-sync-service";
import { runOrganizationSync } from "@/lib/services/organization-sync-orchestrator";
import { describeOrganizationSyncFailure } from "@/lib/services/organization-sync-error-messages";
import { getOrganizationContext, invalidateOrganizationTreeCache } from "@/lib/services/organization-tree-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const RUN_ID = Date.now();
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function installTokenMock(router: (url: string) => Promise<Response> | Response) {
  global.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "mock-app-token" });
    }
    return router(url);
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function section1_validateDirectoryUser() {
  console.log("\n=== validateDirectoryUser (pure, no mocks) ===\n");
  check("valid Member with mail -> valid", validateDirectoryUser({ id: "u1", userType: "Member", mail: "a@kinsen.gr" }).valid === true);
  check("Guest userType -> guest_or_service_account", (() => {
    const r = validateDirectoryUser({ id: "u2", userType: "Guest", mail: "a@kinsen.gr" });
    return !r.valid && r.reason === "guest_or_service_account";
  })());
  check("missing id -> missing_id", (() => {
    const r = validateDirectoryUser({ id: "", userType: "Member", mail: "a@kinsen.gr" });
    return !r.valid && r.reason === "missing_id";
  })());
  check("no mail but has userPrincipalName -> valid, uses UPN as email", (() => {
    const r = validateDirectoryUser({ id: "u3", userType: "Member", mail: null, userPrincipalName: "u3@kinsen.gr" });
    return r.valid && r.email === "u3@kinsen.gr";
  })());
  // FIND-003 (docs/roadmap-handoff-register.md): a record with neither mail
  // nor userPrincipalName can never pass the @kinsen.gr domain eligibility
  // check (nothing to match a domain suffix against), so it's now correctly
  // diagnosed as "domain_not_eligible" — the domain check runs BEFORE the
  // generic missing-email safety net, which is unreachable for this exact
  // input shape (kept in validateDirectoryUser as defensive dead code, not
  // removed, per this session's "don't rip out working safety nets" rule).
  check("neither mail nor UPN -> domain_not_eligible (no domain-matching identity to check at all)", (() => {
    const r = validateDirectoryUser({ id: "u4", userType: "Member", mail: null, userPrincipalName: null });
    return !r.valid && r.reason === "domain_not_eligible";
  })());
  check("missing userType (not rejected, absence isn't evidence of guest) -> valid", validateDirectoryUser({ id: "u5", mail: "a@kinsen.gr" }).valid === true);
  check("non-@kinsen.gr mail and UPN -> domain_not_eligible", (() => {
    const r = validateDirectoryUser({ id: "u6", userType: "Member", mail: "a@other.com", userPrincipalName: "a@tenant.onmicrosoft.com" });
    return !r.valid && r.reason === "domain_not_eligible";
  })());
}

async function section2_retryBackoff() {
  console.log("\n=== fetchWithGraphRetry ===\n");

  let calls = 0;
  global.fetch = (async () => {
    calls++;
    if (calls < 2) return jsonResponse(429, { error: "throttled" }, { "retry-after": "0" });
    return jsonResponse(200, { ok: true });
  }) as typeof fetch;
  const res1 = await fetchWithGraphRetry("https://example.test/a", {}, { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 });
  check("429 with Retry-After eventually succeeds", res1.status === 200 && calls === 2);

  calls = 0;
  global.fetch = (async () => {
    calls++;
    return jsonResponse(503, { error: "unavailable" });
  }) as typeof fetch;
  const res2 = await fetchWithGraphRetry("https://example.test/b", {}, { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 });
  check("persistent 503 exhausts maxAttempts and returns the final (still-failing) response", res2.status === 503 && calls === 3);

  calls = 0;
  global.fetch = (async () => {
    calls++;
    return jsonResponse(403, { error: "forbidden" });
  }) as typeof fetch;
  const res3 = await fetchWithGraphRetry("https://example.test/c", {}, { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 });
  check("403 is never retried — returns immediately after exactly 1 call", res3.status === 403 && calls === 1);

  calls = 0;
  global.fetch = (async () => {
    calls++;
    return jsonResponse(401, { error: "unauthorized" });
  }) as typeof fetch;
  const res4 = await fetchWithGraphRetry("https://example.test/d", {}, { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 });
  check("401 is never retried", res4.status === 401 && calls === 1);

  restoreFetch();
}

async function section3_pagination() {
  console.log("\n=== fetchAllTenantUsers pagination ===\n");
  let page1Calls = 0;
  let page2Calls = 0;
  const page2Url = "https://graph.microsoft.com/v1.0/users?$skiptoken=page2";
  installTokenMock(async (url) => {
    if (url === page2Url) {
      page2Calls++;
      return jsonResponse(200, { value: [{ id: `p2-${RUN_ID}`, userType: "Member", mail: `p2-${RUN_ID}@kinsen.gr` }] });
    }
    page1Calls++;
    return jsonResponse(200, {
      value: [
        { id: `p1a-${RUN_ID}`, userType: "Member", mail: `p1a-${RUN_ID}@kinsen.gr` },
        { id: `p1b-${RUN_ID}`, userType: "Member", mail: `p1b-${RUN_ID}@kinsen.gr` },
      ],
      "@odata.nextLink": page2Url,
    });
  });

  const result = await fetchAllTenantUsers();
  check("fetchAllTenantUsers succeeds", result.ok === true);
  if (result.ok) {
    check("all 3 users across 2 pages are returned (never assumes a single page)", result.users.length === 3);
    check("page 1 was fetched exactly once", page1Calls === 1);
    check("@odata.nextLink was followed exactly once", page2Calls === 1);
  }
  restoreFetch();
}

async function section4_directorySyncDbWrites() {
  console.log("\n=== runOrganizationDirectorySync: idempotency + partial-failure isolation (real DB) ===\n");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping DB-writing sections.");
    console.log(String(err instanceof Error ? err.message : err));
    return;
  }

  const validId = `dirsync-valid-${RUN_ID}`;
  const guestId = `dirsync-guest-${RUN_ID}`;
  const missingEmailId = `dirsync-noemail-${RUN_ID}`;

  installTokenMock(() =>
    jsonResponse(200, {
      value: [
        { id: validId, userType: "Member", mail: `${validId}@kinsen.gr`, displayName: "Valid User", jobTitle: "Engineer" },
        { id: guestId, userType: "Guest", mail: `${guestId}@kinsen.gr`, displayName: "Guest User" },
        { id: missingEmailId, userType: "Member", mail: null, userPrincipalName: null, displayName: "No Email User" },
      ],
    })
  );

  try {
    const outcome1 = await runOrganizationDirectorySync();
    check("first run succeeds", outcome1.ok === true);
    check("usersScanned = 3 (all rows Graph returned)", outcome1.usersScanned === 3);
    check("usersSkipped = 2 (guest + missing-email, isolated, not aborting the run)", outcome1.usersSkipped === 2);
    check("usersUpdated = 1 (only the valid user)", outcome1.usersUpdated === 1);

    const createdUser = await prisma.user.findUnique({ where: { microsoftUserId: validId } });
    check("the valid user was actually created in the DB", createdUser !== null);
    check("guest user was never created", (await prisma.user.findUnique({ where: { microsoftUserId: guestId } })) === null);
    check("missing-email user was never created", (await prisma.user.findUnique({ where: { microsoftUserId: missingEmailId } })) === null);

    const outcome2 = await runOrganizationDirectorySync();
    check("second (repeated) run also succeeds", outcome2.ok === true);
    const usersWithThisMicrosoftId = await prisma.user.count({ where: { microsoftUserId: validId } });
    check("idempotent: repeated sync never creates a duplicate user for the same microsoftUserId", usersWithThisMicrosoftId === 1);

    if (createdUser) await prisma.user.delete({ where: { id: createdUser.id } });
  } finally {
    restoreFetch();
  }
}

/**
 * Regression test for a real production incident: runOrganizationDirectorySync
 * used to look up existing users ONLY by microsoftUserId, then unconditionally
 * `create()` when not found — which threw the User_email_lower_key unique
 * constraint for anyone who already existed under the same email with a
 * missing/different microsoftUserId, and (because every user in a batch
 * shared ONE Postgres transaction) cascaded into 25P02 "current transaction
 * is aborted" for every subsequent user in that same batch, silently rolling
 * back everyone else's already-"successful" writes too. Covers all 5 identity-
 * resolution outcomes (found by oid / linked by email / conflict-skipped /
 * created / duplicate-email-in-one-batch-skipped) AND proves a user processed
 * AFTER a conflict still syncs normally — the actual regression check.
 */
async function section4b_identityResolution() {
  console.log("\n=== runOrganizationDirectorySync: identity resolution (oid -> email -> link/skip/create) ===\n");
  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping.");
    return;
  }

  const oidByOid = `idres-byoid-${RUN_ID}`;
  const oidLinkTarget = `idres-link-${RUN_ID}`;
  const oidConflict = `idres-conflict-${RUN_ID}`;
  const oidConflictOwner = `idres-conflict-owner-${RUN_ID}`;
  const oidNew = `idres-new-${RUN_ID}`;
  const oidDupA = `idres-dupa-${RUN_ID}`;
  const oidDupB = `idres-dupb-${RUN_ID}`;
  const oidAfterDup = `idres-afterdup-${RUN_ID}`;

  const emailByOid = `${oidByOid}@kinsen.gr`;
  const emailLinkTarget = `idres-link-target-${RUN_ID}@kinsen.gr`;
  const emailConflict = `idres-conflict-target-${RUN_ID}@kinsen.gr`;
  const emailNew = `${oidNew}@kinsen.gr`;
  const emailDup = `idres-dup-shared-${RUN_ID}@kinsen.gr`; // shared by dupA and dupB on purpose — a real Entra data anomaly
  const emailAfterDup = `${oidAfterDup}@kinsen.gr`;

  const userIds: string[] = [];
  try {
    const preByOid = await prisma.user.create({ data: { email: emailByOid, microsoftUserId: oidByOid, name: "Pre ByOid" } });
    userIds.push(preByOid.id);

    // Pre-existing user with the email the sync will see, but no microsoftUserId — e.g. a manual/credentials account created before this person ever signed in via Microsoft.
    const preLinkTarget = await prisma.user.create({ data: { email: emailLinkTarget, name: "Pre Link Target", authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(preLinkTarget.id);

    // Pre-existing user with the SAME email but a DIFFERENT microsoftUserId already linked — a genuine identity conflict, must never be silently reassigned.
    const preConflict = await prisma.user.create({ data: { email: emailConflict, microsoftUserId: oidConflictOwner, name: "Pre Conflict" } });
    userIds.push(preConflict.id);

    installTokenMock(() =>
      jsonResponse(200, {
        value: [
          { id: oidByOid, userType: "Member", mail: emailByOid, displayName: "By Oid Updated" },
          { id: oidLinkTarget, userType: "Member", mail: emailLinkTarget, displayName: "Link Target Updated" },
          { id: oidConflict, userType: "Member", mail: emailConflict, displayName: "Conflict Attempt" },
          { id: oidNew, userType: "Member", mail: emailNew, displayName: "Brand New" },
          { id: oidDupA, userType: "Member", mail: emailDup, displayName: "Dup A" },
          { id: oidDupB, userType: "Member", mail: emailDup, displayName: "Dup B" },
          { id: oidAfterDup, userType: "Member", mail: emailAfterDup, displayName: "After Dup" },
        ],
      })
    );

    const outcome = await runOrganizationDirectorySync();
    check("sync completes ok despite identity conflicts inside it (never a hard failure)", outcome.ok === true);

    const afterByOid = await prisma.user.findUnique({ where: { id: preByOid.id } });
    check("1. existing user found by microsoftUserId is updated in place", afterByOid?.name === "By Oid Updated");
    check("   no duplicate row for this microsoftUserId", (await prisma.user.count({ where: { microsoftUserId: oidByOid } })) === 1);

    const afterLink = await prisma.user.findUnique({ where: { id: preLinkTarget.id } });
    check("2. existing user found by email with null microsoftUserId is LINKED (not duplicated)", afterLink?.microsoftUserId === oidLinkTarget);
    check("   the linked row's fields were actually refreshed", afterLink?.name === "Link Target Updated");
    check("   exactly one row exists for this email", (await prisma.user.count({ where: { email: emailLinkTarget } })) === 1);

    const afterConflict = await prisma.user.findUnique({ where: { id: preConflict.id } });
    check("3. email already linked to a DIFFERENT microsoftUserId is left completely untouched", afterConflict?.name === "Pre Conflict" && afterConflict?.microsoftUserId === oidConflictOwner);
    check("   no row was created for the conflicting attempt's own oid", (await prisma.user.findUnique({ where: { microsoftUserId: oidConflict } })) === null);

    const created = await prisma.user.findUnique({ where: { microsoftUserId: oidNew } });
    check("4. brand-new user (new oid, new email) is created", created !== null && created?.email === emailNew);
    if (created) userIds.push(created.id);

    const dupWinner = await prisma.user.findUnique({ where: { microsoftUserId: oidDupA } });
    check("5. first of two same-email records in one Graph batch is created normally", dupWinner !== null);
    if (dupWinner) userIds.push(dupWinner.id);
    const dupLoser = await prisma.user.findUnique({ where: { microsoftUserId: oidDupB } });
    check("   second of two same-email records in one batch is safely skipped, never a duplicate", dupLoser === null);
    check("   exactly one row exists for the shared email", (await prisma.user.count({ where: { email: emailDup } })) === 1);

    const afterDupUser = await prisma.user.findUnique({ where: { microsoftUserId: oidAfterDup } });
    check(
      "6. REGRESSION CHECK: a user processed AFTER a conflicting one still syncs successfully (no 25P02 cascade from a shared transaction — there is no shared transaction anymore)",
      afterDupUser !== null
    );
    if (afterDupUser) userIds.push(afterDupUser.id);

    check("errorCount reflects exactly the 2 skipped identity conflicts (conflict + dup-loser)", outcome.errorCount === 2);
  } finally {
    restoreFetch();
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
}

async function section5_managerSyncViaDirectReports() {
  console.log("\n=== runOrganizationManagerSync: directReports inversion (real DB) ===\n");
  console.log("  Confirms this service NEVER calls GET /users/{id}/manager (unsupported for Application\n  tokens) — every mocked URL below is /users/{id}/directReports, and the mock would fail any\n  request that doesn't match that shape.\n");
  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping.");
    return;
  }

  const oidTop = `mgrsync-top-${RUN_ID}`;
  const oidTop2 = `mgrsync-top2-${RUN_ID}`; // an independent second root
  const oidMid = `mgrsync-mid-${RUN_ID}`;
  const oidLeaf = `mgrsync-leaf-${RUN_ID}`; // zero direct reports
  const oidCycleA = `mgrsync-cyclea-${RUN_ID}`;
  const oidCycleB = `mgrsync-cycleb-${RUN_ID}`;
  const oidExcludedManager = `mgrsync-excluded-mgr-${RUN_ID}`; // guest/service — never given a local row
  const oidExcludedReport = `mgrsync-excluded-report-${RUN_ID}`;

  const userIds: string[] = [];
  try {
    const top = await prisma.user.create({ data: { email: `${oidTop}@kinsen.gr`, microsoftUserId: oidTop, name: "Top" } });
    const top2 = await prisma.user.create({ data: { email: `${oidTop2}@kinsen.gr`, microsoftUserId: oidTop2, name: "Top2" } });
    const mid = await prisma.user.create({ data: { email: `${oidMid}@kinsen.gr`, microsoftUserId: oidMid, name: "Mid" } });
    const leaf = await prisma.user.create({ data: { email: `${oidLeaf}@kinsen.gr`, microsoftUserId: oidLeaf, name: "Leaf" } });
    const cycleA = await prisma.user.create({ data: { email: `${oidCycleA}@kinsen.gr`, microsoftUserId: oidCycleA, name: "CycleA" } });
    const cycleB = await prisma.user.create({ data: { email: `${oidCycleB}@kinsen.gr`, microsoftUserId: oidCycleB, name: "CycleB" } });
    const excludedReport = await prisma.user.create({ data: { email: `${oidExcludedReport}@kinsen.gr`, microsoftUserId: oidExcludedReport, name: "ExcludedReport" } });
    userIds.push(top.id, top2.id, mid.id, leaf.id, cycleA.id, cycleB.id, excludedReport.id);

    const candidateManagers: DirectoryRawUserRecord[] = [
      { microsoftUserId: oidTop, isExcluded: false, dbUserId: top.id },
      { microsoftUserId: oidTop2, isExcluded: false, dbUserId: top2.id },
      { microsoftUserId: oidMid, isExcluded: false, dbUserId: mid.id },
      { microsoftUserId: oidLeaf, isExcluded: false, dbUserId: leaf.id },
      { microsoftUserId: oidCycleA, isExcluded: false, dbUserId: cycleA.id },
      { microsoftUserId: oidCycleB, isExcluded: false, dbUserId: cycleB.id },
      { microsoftUserId: oidExcludedManager, isExcluded: true, dbUserId: null },
      { microsoftUserId: oidExcludedReport, isExcluded: false, dbUserId: excludedReport.id },
    ];

    const directReportsByOid: Record<string, string[]> = {
      [oidTop2]: [],
      [oidMid]: [oidLeaf],
      [oidLeaf]: [], // manager with zero reports
      [oidCycleA]: [oidCycleB],
      [oidCycleB]: [oidCycleA],
      [oidExcludedManager]: [oidExcludedReport], // real manager, but excluded from the synced set
      [oidExcludedReport]: [],
    };

    // Top's directReports call is deliberately paginated across 2 pages —
    // proves @odata.nextLink is followed for THIS endpoint too, not just
    // GET /users.
    let topPage1Calls = 0;
    let topPage2Calls = 0;
    const topPage2Url = `https://graph.microsoft.com/v1.0/users/${oidTop}/directReports?$skiptoken=page2`;

    installTokenMock((url) => {
      const decoded = decodeURIComponent(url);
      if (decoded === topPage2Url) {
        topPage2Calls++;
        return jsonResponse(200, { value: [{ id: oidMid }] });
      }
      const match = decoded.match(/\/users\/([^/]+)\/directReports/);
      const managerOid = match?.[1];
      if (!managerOid) {
        // Any request that ISN'T /directReports (e.g. a stray /manager
        // call) fails hard here — this IS the proof that /manager is never
        // called by this service.
        return jsonResponse(500, { error: "unexpected endpoint called by manager sync" });
      }
      if (managerOid === oidTop) {
        topPage1Calls++;
        return jsonResponse(200, { value: [], "@odata.nextLink": topPage2Url });
      }
      const reportOids = directReportsByOid[managerOid] ?? [];
      return jsonResponse(200, { value: reportOids.map((id) => ({ id })) });
    });

    const outcome = await runOrganizationManagerSync(candidateManagers);
    check("manager sync succeeds and publishes", outcome.ok === true && outcome.published === true);
    check("directReports pagination followed for top's own query (@odata.nextLink)", topPage1Calls === 1 && topPage2Calls === 1);

    const refreshed = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, microsoftUserId: true, managerId: true, managerExcludedFromSync: true },
    });
    const byOid = new Map(refreshed.map((u) => [u.microsoftUserId, u]));

    check("mid's manager resolved to top's LOCAL id via directReports inversion, across pagination", byOid.get(oidMid)?.managerId === top.id);
    check("leaf (a manager with zero reports) is itself correctly resolved as mid's report", byOid.get(oidLeaf)?.managerId === mid.id);
    check("top has no manager (never claimed as anyone's report) — a plausible root, not an error", byOid.get(oidTop)?.managerId === null);
    check("top2 is an independent second root (multiple organization roots supported)", byOid.get(oidTop2)?.managerId === null);

    check("cycleA/cycleB mutual edge is rejected at publish time (both null, never a cycle written)", byOid.get(oidCycleA)?.managerId === null && byOid.get(oidCycleB)?.managerId === null);
    check("cycle rejection is counted as an error", outcome.errorCount >= 1);

    check(
      "excludedReport's real Entra manager (excluded guest/service account) is tracked via managerExcludedFromSync, managerId stays null",
      byOid.get(oidExcludedReport)?.managerId === null && byOid.get(oidExcludedReport)?.managerExcludedFromSync === true
    );
    check("managerNotSyncedCount reflects exactly the one excluded-manager edge", outcome.managerNotSyncedCount === 1);
  } finally {
    restoreFetch();
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
}

async function section5b_atomicPublishOnPartialFailure() {
  console.log("\n=== Atomic publish: a hard fetch failure aborts the WHOLE run, previous snapshot untouched ===\n");
  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping.");
    return;
  }

  const oidB = `atomic-b-${RUN_ID}`;
  const oidA = `atomic-a-${RUN_ID}`;
  const oidC = `atomic-c-${RUN_ID}`;
  const userIds: string[] = [];

  try {
    const b = await prisma.user.create({ data: { email: `${oidB}@kinsen.gr`, microsoftUserId: oidB, name: "B" } });
    const a = await prisma.user.create({ data: { email: `${oidA}@kinsen.gr`, microsoftUserId: oidA, name: "A" } });
    userIds.push(b.id, a.id);

    // Run 1: B -> A (B manages A). Succeeds and publishes — this becomes
    // "the previously published snapshot" the rest of this test protects.
    installTokenMock((url) => {
      const decoded = decodeURIComponent(url);
      const match = decoded.match(/\/users\/([^/]+)\/directReports/);
      const managerOid = match?.[1];
      if (managerOid === oidB) return jsonResponse(200, { value: [{ id: oidA }] });
      return jsonResponse(200, { value: [] });
    });
    const run1 = await runOrganizationManagerSync([
      { microsoftUserId: oidB, isExcluded: false, dbUserId: b.id },
      { microsoftUserId: oidA, isExcluded: false, dbUserId: a.id },
    ]);
    check("initial run publishes successfully", run1.ok === true && run1.published === true);
    const afterRun1 = await prisma.user.findUnique({ where: { id: a.id } });
    check("A's manager is B after the first successful run (this is the snapshot being protected)", afterRun1?.managerId === b.id);

    // Run 2: introduce C, whose directReports call fails persistently
    // (exhausts fetchWithGraphRetry's retries — a genuine hard failure).
    // B's response is deliberately CHANGED this run (B no longer reports
    // managing A) — specifically to prove that even though B's fetch
    // itself succeeds and returns DIFFERENT data, none of it is published
    // because C's fetch hard-failed elsewhere in the same run.
    const c = await prisma.user.create({ data: { email: `${oidC}@kinsen.gr`, microsoftUserId: oidC, name: "C" } });
    userIds.push(c.id);

    installTokenMock((url) => {
      const decoded = decodeURIComponent(url);
      const match = decoded.match(/\/users\/([^/]+)\/directReports/);
      const managerOid = match?.[1];
      if (managerOid === oidC) return jsonResponse(500, { error: "simulated persistent failure" });
      // B now reports NO direct reports — a real, different answer from run 1.
      return jsonResponse(200, { value: [] });
    });

    const run2 = await runOrganizationManagerSync(
      [oidA, oidB, oidC].map((microsoftUserId) => ({
        microsoftUserId,
        isExcluded: false,
        dbUserId: microsoftUserId === oidA ? a.id : microsoftUserId === oidB ? b.id : c.id,
      })),
      { retryOptions: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20 } }
    );
    check("second run reports published:false (fetch phase hard-failed)", run2.published === false);
    check('second run reason is "partial_fetch_failure"', run2.reason === "partial_fetch_failure");

    const afterRun2 = await prisma.user.findUnique({ where: { id: a.id } });
    check("A's managerId is STILL B — unchanged, even though B's new (unpublished) answer said otherwise", afterRun2?.managerId === b.id);

    invalidateOrganizationTreeCache();
    const contextAfterFailure = await getOrganizationContext(a.id);
    check("the read API (getOrganizationContext) also still reports A's manager as B — no mixed old/new state visible to readers", contextAfterFailure?.manager?.id === b.id);
  } finally {
    restoreFetch();
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    invalidateOrganizationTreeCache();
  }
}

async function section5d_missingManagerAndSelfManager() {
  console.log("\n=== Manager sync: manager not in the synced set, and an explicit self-manager edge ===\n");
  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping.");
    return;
  }

  const oidGhostManager = `mgrsync-ghost-mgr-${RUN_ID}`; // a real, non-excluded candidate whose OWN directory-sync upsert never produced a local row (e.g. it hit the identity-conflict skip above) — "manager που δεν υπάρχει" locally.
  const oidGhostReport = `mgrsync-ghost-report-${RUN_ID}`;
  const oidSelfManager = `mgrsync-selfmgr-${RUN_ID}`; // reports itself as its own direct report — a real Entra data anomaly.

  const userIds: string[] = [];
  try {
    const ghostReport = await prisma.user.create({ data: { email: `${oidGhostReport}@kinsen.gr`, microsoftUserId: oidGhostReport, name: "GhostReport" } });
    const selfManager = await prisma.user.create({ data: { email: `${oidSelfManager}@kinsen.gr`, microsoftUserId: oidSelfManager, name: "SelfManager" } });
    userIds.push(ghostReport.id, selfManager.id);

    const candidateManagers: DirectoryRawUserRecord[] = [
      // Validated (not excluded) but dbUserId is null — the directory-sync
      // stage never actually persisted a row for this candidate manager
      // (distinct from isExcluded: true, which means "known guest/service
      // account, never even attempted").
      { microsoftUserId: oidGhostManager, isExcluded: false, dbUserId: null },
      { microsoftUserId: oidGhostReport, isExcluded: false, dbUserId: ghostReport.id },
      { microsoftUserId: oidSelfManager, isExcluded: false, dbUserId: selfManager.id },
    ];

    installTokenMock((url) => {
      const decoded = decodeURIComponent(url);
      const match = decoded.match(/\/users\/([^/]+)\/directReports/);
      const managerOid = match?.[1];
      if (managerOid === oidGhostManager) return jsonResponse(200, { value: [{ id: oidGhostReport }] });
      if (managerOid === oidSelfManager) return jsonResponse(200, { value: [{ id: oidSelfManager }] }); // reports itself
      return jsonResponse(200, { value: [] });
    });

    const outcome = await runOrganizationManagerSync(candidateManagers);
    check("manager sync still succeeds and publishes despite these anomalies", outcome.ok === true && outcome.published === true);

    const refreshed = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, microsoftUserId: true, managerId: true, managerExcludedFromSync: true },
    });
    const byOid = new Map(refreshed.map((u) => [u.microsoftUserId, u]));

    check(
      "manager that doesn't exist locally: report's managerId stays null, managerExcludedFromSync is true (safe skip, not a crash)",
      byOid.get(oidGhostReport)?.managerId === null && byOid.get(oidGhostReport)?.managerExcludedFromSync === true
    );
    check(
      "self-manager edge is rejected — the user is never recorded as their own manager",
      byOid.get(oidSelfManager)?.managerId === null
    );
    check("both anomalies are counted in errorCount, never silently dropped", outcome.errorCount >= 2);
  } finally {
    restoreFetch();
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
}

function section5c_permissionMessaging() {
  console.log("\n=== Permission error messaging: no false User.Read.All blocker ===\n");
  const noPermissionMessage = describeOrganizationSyncFailure("Directory sync failed: no_permission");
  check("403 message lists the full accepted permission set, not just User.Read.All", noPermissionMessage.message.includes("Directory.Read.All") && noPermissionMessage.message.includes("User.Read.All"));
  check(
    "403 message never suggests granting/fixing something FOR /users/{id}/manager (it may only mention it to clarify that endpoint is irrelevant/never called)",
    !/add|grant|consent/i.test(noPermissionMessage.message.split("/manager")[0].slice(-60))
  );
  check("403 message explicitly notes Directory.Read.All is what this app already uses", noPermissionMessage.message.toLowerCase().includes("already"));

  const partialFailureMessage = describeOrganizationSyncFailure("Manager sync failed: partial_fetch_failure");
  check('"partial_fetch_failure" gets its own specific, actionable message (not the generic fallback)', partialFailureMessage.code === "manager_sync_incomplete");
  check("that message explicitly states the previous snapshot is unchanged", partialFailureMessage.message.toLowerCase().includes("unchanged") || partialFailureMessage.message.toLowerCase().includes("still"));
}

async function section6_concurrentSyncPrevention() {
  console.log("\n=== Concurrent sync prevention (real lock, real DB) ===\n");
  let connected = true;
  try {
    await prisma.$connect();
  } catch {
    connected = false;
  }
  if (!connected) {
    console.log("No reachable DATABASE_URL — skipping.");
    return;
  }

  // A deliberately slow mocked Graph response so the two runOrganizationSync
  // calls below genuinely overlap in time — this exercises the REAL
  // acquireOrganizationSyncLock atomic compare-and-set against Postgres, not
  // a simulated race.
  installTokenMock(async (url) => {
    if (url.includes("/users?")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return jsonResponse(200, { value: [] });
    }
    return jsonResponse(404, {});
  });

  const runIds: string[] = [];
  try {
    const [resultA, resultB] = await Promise.all([runOrganizationSync(OrganizationSyncType.FULL), runOrganizationSync(OrganizationSyncType.FULL)]);
    runIds.push(resultA.runId, resultB.runId);

    const alreadyRunningCount = [resultA, resultB].filter((r) => r.alreadyRunning).length;
    check("exactly one of the two concurrent sync attempts is rejected as already-running", alreadyRunningCount === 1);
    const succeededCount = [resultA, resultB].filter((r) => !r.alreadyRunning).length;
    check("exactly one of the two concurrent attempts actually ran", succeededCount === 1);

    const lock = await prisma.organizationSyncLock.findUnique({ where: { id: "singleton" } });
    check("the lock is released after both attempts settle (never left stuck)", lock?.isLocked === false);
  } finally {
    restoreFetch();
    try {
      await prisma.organizationSyncRun.deleteMany({ where: { id: { in: runIds } } });
      // Defensive reset — this is shared, real application infrastructure;
      // never leave it locked after this test regardless of what happened above.
      await prisma.organizationSyncLock.updateMany({ where: { id: "singleton" }, data: { isLocked: false, lockedAt: null, runId: null } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
  }
}

async function main() {
  await section1_validateDirectoryUser();
  await section2_retryBackoff();
  await section3_pagination();
  await section4_directorySyncDbWrites();
  await section4b_identityResolution();
  await section5_managerSyncViaDirectReports();
  await section5b_atomicPublishOnPartialFailure();
  await section5d_missingManagerAndSelfManager();
  section5c_permissionMessaging();
  await section6_concurrentSyncPrevention();

  restoreFetch();
  await prisma.$disconnect().catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
