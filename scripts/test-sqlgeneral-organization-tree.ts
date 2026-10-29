/**
 * SQLGeneral Organization Tree — MANAGER-FIRST hierarchy (built purely from
 * UsersAndManagers.managerAMAccountName, never Departments/Company),
 * verifying the five named production identities (geokos manager of
 * konkef/chapav/thoche/stekam), cross-company reporting, multi-level
 * management, external (non-TicketApp) managers, ambiguous identities/
 * managers, self-references, cycles (without cascading to a cycle
 * member's own subordinates), local-user uniqueness/conflict handling, the
 * admin permission gate, and that the two EXISTING tree modes
 * (Departments/People) are completely unaffected.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-sqlgeneral-organization-tree.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";

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

function fakeSqlUser(
  username: string,
  managerAMAccountName: string | null,
  opts: Partial<{ mail: string | null; hrDepartmentId: string | number | null; department: string | null; companyId: string | number | null; company: string | null; active: boolean | null }> = {}
) {
  return {
    username,
    mail: opts.mail !== undefined ? opts.mail : `${username}@example.com`,
    hrDepartmentId: opts.hrDepartmentId ?? null,
    department: opts.department ?? null,
    companyId: opts.companyId ?? null,
    company: opts.company ?? null,
    active: opts.active ?? true,
    managerAMAccountName,
    manager2AMAccountName: null,
    manager3AMAccountName: null,
  };
}

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

  // The single simulated SQLGeneral population for whatever section is
  // currently running — BOTH mocks below read from this SAME array, so
  // listAllSqlGeneralUsers({ activeOnly: true }) and
  // findSqlGeneralUserByUsername (ground truth, always unfiltered) can
  // never disagree about what SQLGeneral "really" contains, exactly like
  // the real API client's two functions hitting the same live backend.
  let fixtureUsers: ReturnType<typeof fakeSqlUser>[] = [];
  let forceListUsersFailure: string | null = null;
  let forceFindUserFailureOnce = false;
  let listUsersDelayMs = 0;
  let findUserDelayMs = 0;
  let listUsersPageSize = 100; // mirrors listAllSqlGeneralUsers' real $first=100
  let listUsersSimulatedPages = 0;
  let findUserCallCount = 0;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function mockListAllUsers(options?: { activeOnly?: boolean }) {
    if (forceListUsersFailure) return { ok: false as const, reason: forceListUsersFailure };
    const rows = options?.activeOnly ? fixtureUsers.filter((u) => u.active === true) : fixtureUsers;
    if (listUsersDelayMs > 0) {
      const pages = Math.max(1, Math.ceil(rows.length / listUsersPageSize));
      listUsersSimulatedPages += pages;
      for (let i = 0; i < pages; i++) await delay(listUsersDelayMs);
    }
    return { ok: true as const, users: rows };
  }

  async function mockFindUserByUsername(username: string) {
    findUserCallCount++;
    if (forceFindUserFailureOnce) {
      forceFindUserFailureOnce = false;
      throw new realClient.SqlGeneralApiError("Pagination exceeded 200 pages without reaching the end.");
    }
    if (findUserDelayMs > 0) await delay(findUserDelayMs);
    const rows = fixtureUsers.filter((u) => u.username === username);
    if (rows.length === 0) return { outcome: "not_found" as const };
    if (rows.length > 1) return { outcome: "ambiguous" as const, count: rows.length };
    return { outcome: "unique" as const, user: rows[0] };
  }

  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      listAllSqlGeneralUsers: (options?: { activeOnly?: boolean }) => mockListAllUsers(options),
      findSqlGeneralUserByUsername: (username: string) => mockFindUserByUsername(username),
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

  const treeService = await import("@/lib/services/sqlgeneral-organization-tree-service");
  const treeRoute = await import("@/app/api/admin/organization/sqlgeneral-tree/route");
  const localTreeService = await import("@/lib/services/organization-tree-service");

  const userIds: string[] = [];
  async function makeUser(tag: string, role: Role = Role.USER, customRoleId: string | null = null): Promise<string> {
    const u = await prisma.user.create({ data: { email: `sgtree-${tag}-${RUN_ID}@kinsen.gr`, name: `SGTree ${tag}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u.id;
  }
  async function enqueue(userId: string, username: string | null) {
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId, sqlGeneralUsername: username, status: username ? "PENDING" : "SKIPPED_NO_USERNAME" } });
  }

  function findNode(roots: any[], id: string): any {
    for (const n of roots) {
      if (n.id === id) return n;
      const found = findNode(n.children, id);
      if (found) return found;
    }
    return null;
  }
  const personId = (username: string) => `sgperson:${username}`;

  try {
    console.log("\nFive named production identities: geokos manager of konkef/chapav/thoche/stekam ===\n");
    const uKonkef = await makeUser("konkef");
    await enqueue(uKonkef, "konkef");
    const uNikpap = await makeUser("nikpap");
    await enqueue(uNikpap, "nikpap");

    fixtureUsers = [
      fakeSqlUser("geokos", null, { company: "Acme HQ" }),
      fakeSqlUser("konkef", "geokos", { company: "Acme HQ" }),
      fakeSqlUser("chapav", "geokos", { company: "Beta Co" }), // cross-company: reports to geokos despite a DIFFERENT company
      fakeSqlUser("thoche", "geokos", { company: "Gamma Co" }), // cross-company
      fakeSqlUser("stekam", "geokos", { company: "Delta Co" }), // cross-company, and neither local NOR an ancestor of a local user
      fakeSqlUser("nikpap", "thoche", { company: "Gamma Co" }), // multi-level: geokos -> thoche -> nikpap
    ];

    const namedResult = await treeService.getSqlGeneralOrganizationTree();
    if (!namedResult.ok) {
      check("1-8. five-named-identity build", false, namedResult.reason);
    } else {
      const geokos = findNode(namedResult.roots, personId("geokos"));
      check("1. geokos has no manager and appears as a ROOT", !!geokos && namedResult.roots.includes(geokos), JSON.stringify(namedResult.roots.map((r) => r.sqlGeneralUsername)));
      check("1b. geokos has no local TicketApp account — rendered as an external placeholder", !!geokos && geokos.isLocal === false && geokos.userId === null);
      const directReports = geokos ? geokos.children.map((c: any) => c.sqlGeneralUsername).sort() : [];
      check(
        "2. geokos is verified as the DIRECT manager of EXACTLY konkef, chapav, thoche and stekam",
        JSON.stringify(directReports) === JSON.stringify(["chapav", "konkef", "stekam", "thoche"]),
        JSON.stringify(directReports)
      );
      check("3. konkef (a real TicketApp user) is isLocal with its own userId attached", findNode(namedResult.roots, personId("konkef"))?.isLocal === true && findNode(namedResult.roots, personId("konkef"))?.userId === uKonkef);
      const chapavNode = findNode(namedResult.roots, personId("chapav"));
      check("4. CROSS-COMPANY reporting: chapav (Beta Co) reports directly to geokos (Acme HQ) — Company never blocks or reshapes the edge", !!chapavNode && geokos.children.includes(chapavNode));
      const stekamNode = findNode(namedResult.roots, personId("stekam"));
      check(
        "5. stekam renders under geokos even though stekam is NEITHER a TicketApp user NOR an ancestor of one — the tree is never scoped down to only TicketApp-relevant chains",
        !!stekamNode && stekamNode.isLocal === false && geokos.children.includes(stekamNode)
      );
      const thocheNode = findNode(namedResult.roots, personId("thoche"));
      const nikpapNode = thocheNode ? findNode([thocheNode], personId("nikpap")) : null;
      check("6. MULTI-LEVEL management: nikpap nests under thoche, which nests under geokos — arbitrary depth, not just one level", !!thocheNode && !!nikpapNode && geokos.children.includes(thocheNode));
      check("7. nikpap (a real TicketApp user) is isLocal with its own userId attached, even nested 2 levels deep", nikpapNode?.isLocal === true && nikpapNode?.userId === uNikpap);
      check("8. zero unresolvedManagerLinks for this entirely clean, well-formed set of relationships", namedResult.unresolvedManagerLinks.length === 0, JSON.stringify(namedResult.unresolvedManagerLinks));
    }

    console.log("\nAmbiguous identities and ambiguous managers ===\n");
    fixtureUsers = [
      fakeSqlUser("dupeuser", null), // row 1 of an ambiguous username
      fakeSqlUser("dupeuser", null), // row 2 — SQLGeneral's own data reports this username twice
      fakeSqlUser("ambmgr-emp", "dupeuser"), // claims the ambiguous username as manager
    ];
    const ambResult = await treeService.getSqlGeneralOrganizationTree();
    if (!ambResult.ok) {
      check("9-10. ambiguity build", false, ambResult.reason);
    } else {
      check("9. an identity SQLGeneral itself reports more than once NEVER becomes a node at all", findNode(ambResult.roots, personId("dupeuser")) === null);
      const ambEmp = findNode(ambResult.roots, personId("ambmgr-emp"));
      check(
        "10. a employee claiming an AMBIGUOUS username as their manager is reported ambiguous_manager and rendered as a standalone root — never guesses which row is the real manager",
        !!ambEmp && ambResult.roots.includes(ambEmp) && ambResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "ambmgr-emp" && u.reason === "ambiguous_manager"),
        JSON.stringify(ambResult.unresolvedManagerLinks)
      );
    }

    console.log("\nMissing (dangling) managers and self-references ===\n");
    fixtureUsers = [fakeSqlUser("orphan-emp", "ghost-manager-404"), fakeSqlUser("selfref-emp", "selfref-emp")];
    const missingResult = await treeService.getSqlGeneralOrganizationTree();
    if (!missingResult.ok) {
      check("11-12. missing/self-reference build", false, missingResult.reason);
    } else {
      const orphan = findNode(missingResult.roots, personId("orphan-emp"));
      check(
        "11. a manager username that doesn't exist ANYWHERE in the live data is missing_manager — the employee still renders, as a standalone root",
        !!orphan && missingResult.roots.includes(orphan) && missingResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "orphan-emp" && u.reason === "missing_manager")
      );
      const selfRef = findNode(missingResult.roots, personId("selfref-emp"));
      check(
        "12. an employee claiming THEMSELVES as their own manager is self_reference, never a self-loop — rendered as a standalone root",
        !!selfRef && missingResult.roots.includes(selfRef) && missingResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "selfref-emp" && u.reason === "self_reference")
      );
    }

    console.log("\nCycles — detected, reported, and NEVER cascaded onto a cycle member's own subordinates ===\n");
    fixtureUsers = [fakeSqlUser("cycA", "cycB"), fakeSqlUser("cycB", "cycA"), fakeSqlUser("cycA-report", "cycA")];
    const cycleResult = await treeService.getSqlGeneralOrganizationTree();
    if (!cycleResult.ok) {
      check("13-15. cycle build", false, cycleResult.reason);
    } else {
      check(
        "13. both members of a 2-cycle (cycA <-> cycB) are reported \"cycle\", never a false root picked arbitrarily — EACH becomes its own standalone root",
        cycleResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "cycA" && u.reason === "cycle") &&
          cycleResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "cycB" && u.reason === "cycle"),
        JSON.stringify(cycleResult.unresolvedManagerLinks)
      );
      const cycANode = findNode(cycleResult.roots, personId("cycA"));
      const cycBNode = findNode(cycleResult.roots, personId("cycB"));
      check("14. cycA and cycB both render as standalone roots (their own broken upward edge, not excluded from the tree entirely)", !!cycANode && !!cycBNode && cycleResult.roots.includes(cycANode) && cycleResult.roots.includes(cycBNode));
      check(
        "15. cycA's OWN subordinate (cycA-report) is completely unaffected by cycA's broken upward edge — never cascaded, chains are cut exactly where data stops supporting them, nothing more",
        !!cycANode && cycANode.children.some((c: any) => c.sqlGeneralUsername === "cycA-report")
      );
    }

    console.log("\nLocal-user uniqueness: not_found, SQLGeneral-side ambiguous, and conflicting local claims ===\n");
    const uNotFound = await makeUser("notfound");
    await enqueue(uNotFound, "no-such-sqlgeneral-user");
    const uAmbiguousLocal = await makeUser("ambiguouslocal");
    await enqueue(uAmbiguousLocal, "dupeuser2");
    const uConflictA = await makeUser("conflicta");
    await enqueue(uConflictA, "shared-identity");
    const uConflictB = await makeUser("conflictb");
    await enqueue(uConflictB, "shared-identity");

    fixtureUsers = [
      fakeSqlUser("dupeuser2", null),
      fakeSqlUser("dupeuser2", null), // SQLGeneral's own ambiguity for a username a LOCAL user also claims
      fakeSqlUser("shared-identity", "geokos2"), // two DIFFERENT local users claim this exact username
      fakeSqlUser("geokos2", null),
      // "no-such-sqlgeneral-user" deliberately absent from SQLGeneral's own data
    ];
    const uniquenessResult = await treeService.getSqlGeneralOrganizationTree();
    if (!uniquenessResult.ok) {
      check("16-19. uniqueness build", false, uniquenessResult.reason);
    } else {
      const unresolvedByUserId = new Map(uniquenessResult.unresolvedUsers.map((u) => [u.userId, u.reason]));
      check("16. a username with zero SQLGeneral matches => not_found", unresolvedByUserId.get(uNotFound) === "not_found");
      check("17. a LOCAL user claiming a username SQLGeneral itself reports more than once => ambiguous, never silently picks one", unresolvedByUserId.get(uAmbiguousLocal) === "ambiguous");
      check(
        "18. TWO DIFFERENT local users claiming the SAME SQLGeneral username => BOTH reported conflicting_attempt, and the SQLGeneral identity itself still renders in the tree but with NO local userId attached (neither claim is trusted)",
        unresolvedByUserId.get(uConflictA) === "conflicting_attempt" &&
          unresolvedByUserId.get(uConflictB) === "conflicting_attempt" &&
          findNode(uniquenessResult.roots, personId("shared-identity"))?.isLocal === false,
        JSON.stringify(uniquenessResult.unresolvedUsers)
      );
      check("19. each existing TicketApp user who DOES resolve uniquely still appears in the tree exactly once (no duplicate nodes)", uniquenessResult.roots.flatMap(flattenAll).filter((n: any) => n.sqlGeneralUsername === "shared-identity").length === 1);
    }

    console.log("\nActive-only scope: inactive SQLGeneral identities never render, active external employees still do ===\n");
    fixtureUsers = [fakeSqlUser("active-root", null, { active: true }), fakeSqlUser("inactive-root", null, { active: false }), fakeSqlUser("active-external", "active-root", { active: true })];
    const activeOnlyResult = await treeService.getSqlGeneralOrganizationTree();
    if (!activeOnlyResult.ok) {
      check("20-21. active-only build", false, activeOnlyResult.reason);
    } else {
      check("20. an inactive SQLGeneral identity with no manager link involved NEVER becomes a node at all", findNode(activeOnlyResult.roots, personId("inactive-root")) === null);
      const activeExternal = findNode(activeOnlyResult.roots, personId("active-external"));
      check("21. an ACTIVE external employee (no TicketApp account) still renders normally under their active manager", !!activeExternal && activeExternal.isLocal === false && findNode(activeOnlyResult.roots, personId("active-root"))?.children.includes(activeExternal));
    }

    console.log("\nAn ACTIVE employee reporting to a real but INACTIVE manager — never missing_manager, never silently skipped or fabricated ===\n");
    fixtureUsers = [fakeSqlUser("inactive-boss", null, { active: false }), fakeSqlUser("active-report", "inactive-boss", { active: true })];
    const inactiveMgrResult = await treeService.getSqlGeneralOrganizationTree();
    if (!inactiveMgrResult.ok) {
      check("22-23. inactive-manager build", false, inactiveMgrResult.reason);
    } else {
      check("22. inactive-boss (inactive, no TicketApp account either) is NOT a node — correctly excluded by the active filter, not merely hidden", findNode(inactiveMgrResult.roots, personId("inactive-boss")) === null);
      const activeReport = findNode(inactiveMgrResult.roots, personId("active-report"));
      check(
        "23. active-report renders as a STANDALONE ROOT with reason \"inactive_manager\" (never \"missing_manager\" — their manager genuinely exists, just isn't active)",
        !!activeReport &&
          inactiveMgrResult.roots.includes(activeReport) &&
          inactiveMgrResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "active-report" && u.reason === "inactive_manager"),
        JSON.stringify(inactiveMgrResult.unresolvedManagerLinks)
      );
    }

    console.log("\nMulti-level: an inactive manager in the MIDDLE of a chain cuts the edge exactly there — never skip-connects to the grandparent ===\n");
    fixtureUsers = [
      fakeSqlUser("grandparent-active", null, { active: true }),
      fakeSqlUser("inactive-middle", "grandparent-active", { active: false }),
      fakeSqlUser("active-leaf", "inactive-middle", { active: true }),
    ];
    const midChainResult = await treeService.getSqlGeneralOrganizationTree();
    if (!midChainResult.ok) {
      check("24-25. mid-chain build", false, midChainResult.reason);
    } else {
      const grandparent = findNode(midChainResult.roots, personId("grandparent-active"));
      const activeLeaf = findNode(midChainResult.roots, personId("active-leaf"));
      check(
        "24. active-leaf becomes its OWN standalone root — NEVER silently reattached to grandparent-active (that would skip the inactive level and fabricate an edge data never supported)",
        !!activeLeaf && midChainResult.roots.includes(activeLeaf) && midChainResult.unresolvedManagerLinks.some((u) => u.sqlGeneralUsername === "active-leaf" && u.reason === "inactive_manager")
      );
      check("25. grandparent-active is completely unaffected — still a root, with zero children (inactive-middle was never a node to carry active-leaf up to it)", !!grandparent && grandparent.children.length === 0);
    }

    console.log("\nA local TicketApp user whose OWN captured SQLGeneral identity is inactive: silently excluded, never reported as not_found ===\n");
    const uInactiveAnchor = await makeUser("inactiveanchor");
    await enqueue(uInactiveAnchor, "now-inactive-local");
    fixtureUsers = [fakeSqlUser("now-inactive-local", null, { active: false })];
    const inactiveAnchorResult = await treeService.getSqlGeneralOrganizationTree();
    if (!inactiveAnchorResult.ok) {
      check("26-27. inactive-anchor build", false, inactiveAnchorResult.reason);
    } else {
      check(
        "26. the local user's own inactive SQLGeneral identity is NEVER reported in unresolvedUsers (this is the active filter correctly doing its job, not an identity problem)",
        !inactiveAnchorResult.unresolvedUsers.some((u) => u.userId === uInactiveAnchor),
        JSON.stringify(inactiveAnchorResult.unresolvedUsers)
      );
      check("27. and correspondingly renders no node at all for that now-inactive identity", findNode(inactiveAnchorResult.roots, personId("now-inactive-local")) === null);
    }

    console.log("\nA live ground-truth lookup failure while refining a broken manager link fails the WHOLE build closed ===\n");
    fixtureUsers = [fakeSqlUser("broken-link-emp", "will-fail-lookup", { active: true })];
    forceFindUserFailureOnce = true;
    const lookupFailResult = await treeService.getSqlGeneralOrganizationTree();
    check("28. a SqlGeneralApiError while confirming whether a broken manager link is genuinely missing vs. merely inactive fails the WHOLE build closed — never a partial/best-effort tree", lookupFailResult.ok === false, lookupFailResult.ok ? "unexpectedly ok" : "");

    console.log("\nPerformance: fewer rows fetched (active-only) directly means fewer sequential pages, bounded extra cost for the rare inactive-manager case ===\n");
    {
      // Every earlier section's local users (uKonkef, uNotFound, etc.) left a
      // real sqlGeneralUserSyncAttempt row behind — resolveSqlGeneralAnchors
      // queries those globally, not scoped to this fixture, so they'd each
      // trigger an EXTRA, unrelated ground-truth lookup here (none of their
      // usernames exist in this section's fixtureUsers) and pollute the call
      // count this measurement depends on. Nothing later needs them — their
      // own assertions already ran — so clear them before measuring.
      await prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } });

      const PAGE_SIZE = 100;
      const ACTIVE_COUNT = 3000;
      const INACTIVE_COUNT = 1000;
      const BROKEN_LINK_COUNT = 5; // active employees whose manager happens to be one of the inactive identities
      const SIMULATED_LATENCY_MS = 20;

      const perfUsers: ReturnType<typeof fakeSqlUser>[] = [];
      for (let i = 0; i < INACTIVE_COUNT; i++) perfUsers.push(fakeSqlUser(`perf-inactive-${i}`, null, { active: false }));
      for (let i = 0; i < ACTIVE_COUNT - BROKEN_LINK_COUNT; i++) perfUsers.push(fakeSqlUser(`perf-active-${i}`, null, { active: true }));
      for (let i = 0; i < BROKEN_LINK_COUNT; i++) perfUsers.push(fakeSqlUser(`perf-active-brokenlink-${i}`, `perf-inactive-${i}`, { active: true })); // reports to a DISTINCT inactive identity each
      fixtureUsers = perfUsers;
      listUsersDelayMs = SIMULATED_LATENCY_MS;
      findUserDelayMs = SIMULATED_LATENCY_MS;

      listUsersSimulatedPages = 0;
      findUserCallCount = 0;
      const oldStart = Date.now();
      const oldFetch = await mockListAllUsers(); // the OLD design's own call shape — no activeOnly, fetches EVERY row
      const oldElapsedMs = Date.now() - oldStart;
      const oldPages = listUsersSimulatedPages;
      check("29. (sanity) the OLD-shaped fetch really does return every row, active and inactive alike", oldFetch.ok === true && oldFetch.users.length === ACTIVE_COUNT + INACTIVE_COUNT);

      listUsersSimulatedPages = 0;
      findUserCallCount = 0;
      const newStart = Date.now();
      const newResult = await treeService.getSqlGeneralOrganizationTree();
      const newElapsedMs = Date.now() - newStart;
      const newPages = listUsersSimulatedPages;
      const newLookups = findUserCallCount;

      console.log(`    OLD (full roster, no filter): ${oldPages} page fetch(es) ≈ ${oldElapsedMs}ms`);
      console.log(`    NEW (active-only + ground-truth lookups): ${newPages} page fetch(es) + ${newLookups} per-identity lookup(s) ≈ ${newElapsedMs}ms`);
      console.log(`    Expected page counts: OLD = ceil(${ACTIVE_COUNT + INACTIVE_COUNT}/${PAGE_SIZE}) = ${Math.ceil((ACTIVE_COUNT + INACTIVE_COUNT) / PAGE_SIZE)}, NEW = ceil(${ACTIVE_COUNT}/${PAGE_SIZE}) = ${Math.ceil(ACTIVE_COUNT / PAGE_SIZE)} + ${BROKEN_LINK_COUNT} lookup(s)`);

      check("30. the NEW design fetches STRICTLY fewer pages for the main listing than the OLD, full-roster design", newPages < oldPages, `old=${oldPages} new=${newPages}`);
      check(
        "31. the NEW design's bounded per-identity lookups equal the number of DISTINCT broken links — never one lookup per employee, never the full inactive population re-fetched",
        newLookups === BROKEN_LINK_COUNT,
        `expected ${BROKEN_LINK_COUNT}, got ${newLookups}`
      );
      check(
        "32. measured end-to-end wall time: the NEW design (fewer pages, a handful of cheap extra lookups) is FASTER than the OLD full-roster fetch at this inactive ratio",
        newElapsedMs < oldElapsedMs,
        `old=${oldElapsedMs}ms new=${newElapsedMs}ms`
      );
      check("33. the NEW tree still builds correctly at this scale (not ok:false)", newResult.ok === true, newResult.ok ? "" : newResult.reason);

      listUsersDelayMs = 0;
      findUserDelayMs = 0;
    }

    console.log("\nAdmin permission gate ===\n");
    fixtureUsers = [];
    const nonAdmin = await makeUser("nonadmin");
    currentSession = { user: { id: nonAdmin, role: Role.USER, customRoleId: null } };
    const forbiddenRes = await treeRoute.GET();
    check("34. the SQLGeneral tree endpoint: a user without organization.sqlgeneralSync gets 403", forbiddenRes.status === 403);

    const adminUser = await makeUser("admin", Role.ADMIN, null);
    currentSession = { user: { id: adminUser, role: Role.ADMIN, customRoleId: null } };
    const adminRes = await treeRoute.GET();
    const adminBody = await adminRes.json();
    check("35. ADMIN bypasses the permission check and receives tree + unresolvedUsers + unresolvedManagerLinks", adminRes.status === 200 && Array.isArray(adminBody.tree) && Array.isArray(adminBody.unresolvedUsers) && Array.isArray(adminBody.unresolvedManagerLinks));
    currentSession = null;

    console.log("\nExisting Departments/People tree modes are completely unaffected ===\n");
    let localDeptTreeOk = true;
    let localPeopleTreeOk = true;
    try {
      await localTreeService.getDepartmentTree({});
    } catch {
      localDeptTreeOk = false;
    }
    try {
      await localTreeService.getPeopleTree(undefined, {});
    } catch {
      localPeopleTreeOk = false;
    }
    check("36. the EXISTING local Department tree service (unmocked, untouched) still runs without error", localDeptTreeOk);
    check("37. the EXISTING local People tree service (unmocked, untouched) still runs without error", localPeopleTreeOk);
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
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

function flattenAll(node: any): any[] {
  return [node, ...node.children.flatMap(flattenAll)];
}

main();
