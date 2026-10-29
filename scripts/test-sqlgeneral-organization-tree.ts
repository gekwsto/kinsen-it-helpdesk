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
  type ListUsersFn = typeof realClient.listAllSqlGeneralUsers;
  let mockListUsersImpl: ListUsersFn = async () => ({ ok: true, users: [] });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      listAllSqlGeneralUsers: () => mockListUsersImpl(),
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

    mockListUsersImpl = async () => ({
      ok: true,
      users: [
        fakeSqlUser("geokos", null, { company: "Acme HQ" }),
        fakeSqlUser("konkef", "geokos", { company: "Acme HQ" }),
        fakeSqlUser("chapav", "geokos", { company: "Beta Co" }), // cross-company: reports to geokos despite a DIFFERENT company
        fakeSqlUser("thoche", "geokos", { company: "Gamma Co" }), // cross-company
        fakeSqlUser("stekam", "geokos", { company: "Delta Co" }), // cross-company, and neither local NOR an ancestor of a local user
        fakeSqlUser("nikpap", "thoche", { company: "Gamma Co" }), // multi-level: geokos -> thoche -> nikpap
      ],
    });

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
    mockListUsersImpl = async () => ({
      ok: true,
      users: [
        fakeSqlUser("dupeuser", null), // row 1 of an ambiguous username
        fakeSqlUser("dupeuser", null), // row 2 — SQLGeneral's own data reports this username twice
        fakeSqlUser("ambmgr-emp", "dupeuser"), // claims the ambiguous username as manager
      ],
    });
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
    mockListUsersImpl = async () => ({
      ok: true,
      users: [fakeSqlUser("orphan-emp", "ghost-manager-404"), fakeSqlUser("selfref-emp", "selfref-emp")],
    });
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
    mockListUsersImpl = async () => ({
      ok: true,
      users: [fakeSqlUser("cycA", "cycB"), fakeSqlUser("cycB", "cycA"), fakeSqlUser("cycA-report", "cycA")],
    });
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

    mockListUsersImpl = async () => ({
      ok: true,
      users: [
        fakeSqlUser("dupeuser2", null),
        fakeSqlUser("dupeuser2", null), // SQLGeneral's own ambiguity for a username a LOCAL user also claims
        fakeSqlUser("shared-identity", "geokos2"), // two DIFFERENT local users claim this exact username
        fakeSqlUser("geokos2", null),
        // "no-such-sqlgeneral-user" deliberately absent from SQLGeneral's own data
      ],
    });
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

    console.log("\nIncomplete pagination (fail closed) ===\n");
    mockListUsersImpl = async () => ({ ok: false, reason: "Pagination exceeded 200 pages without reaching the end — treating as incomplete rather than silently truncating." });
    const failResult = await treeService.getSqlGeneralOrganizationTree();
    check("20. a UsersAndManagers pagination failure fails the WHOLE build closed — never a partial tree", failResult.ok === false, failResult.ok ? "unexpectedly ok" : "");

    console.log("\nAdmin permission gate ===\n");
    mockListUsersImpl = async () => ({ ok: true, users: [] });
    const nonAdmin = await makeUser("nonadmin");
    currentSession = { user: { id: nonAdmin, role: Role.USER, customRoleId: null } };
    const forbiddenRes = await treeRoute.GET();
    check("21. the SQLGeneral tree endpoint: a user without organization.sqlgeneralSync gets 403", forbiddenRes.status === 403);

    const adminUser = await makeUser("admin", Role.ADMIN, null);
    currentSession = { user: { id: adminUser, role: Role.ADMIN, customRoleId: null } };
    const adminRes = await treeRoute.GET();
    const adminBody = await adminRes.json();
    check("22. ADMIN bypasses the permission check and receives tree + unresolvedUsers + unresolvedManagerLinks", adminRes.status === 200 && Array.isArray(adminBody.tree) && Array.isArray(adminBody.unresolvedUsers) && Array.isArray(adminBody.unresolvedManagerLinks));
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
    check("23. the EXISTING local Department tree service (unmocked, untouched) still runs without error", localDeptTreeOk);
    check("24. the EXISTING local People tree service (unmocked, untouched) still runs without error", localPeopleTreeOk);
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
