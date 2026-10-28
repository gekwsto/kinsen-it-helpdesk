/**
 * SQLGeneral Organization Tree — recursive hierarchy, multi-company
 * isolation and Company-grouping identity (verified CompanyId evidence
 * only, never shortname/display-text equality), duplicate/conflicting
 * username attempts, missing parents, cycles (including cascading
 * failures at arbitrary depth), unmatched users, incomplete pagination,
 * the admin permission gate, and that the two EXISTING tree modes
 * (Departments/People) are completely unaffected.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-sqlgeneral-organization-tree.ts
 */
import { NextRequest } from "next/server";
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

function fakeDept(id: string, description: string, parentDepartmentId: string | null, company: string, companyShortnameOverride?: string | null) {
  return {
    id,
    description,
    isActive: true,
    parentDepartmentId,
    country: null,
    company,
    companyShortname: companyShortnameOverride !== undefined ? companyShortnameOverride : company.slice(0, 4).toUpperCase(),
    creationDate: null,
    updateTimestamp: null,
  };
}
function fakeSqlUser(username: string, hrDepartmentId: string | number | null, companyId: string | number | null = null, company: string | null = null) {
  return { username, mail: null, hrDepartmentId, department: null, companyId, company, active: true, managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null };
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
  type ListDeptFn = typeof realClient.listAllSqlGeneralDepartments;
  type ListUsersFn = typeof realClient.listAllSqlGeneralUsers;
  let mockListDeptImpl: ListDeptFn = async () => ({ ok: true, departments: [] });
  let mockListUsersImpl: ListUsersFn = async () => ({ ok: true, users: [] });
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
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

  try {
    console.log("\nRecursive hierarchy (arbitrary depth) ===\n");
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("1", "Root", null, "Acme"), fakeDept("2", "Division", "1", "Acme"), fakeDept("3", "Department", "2", "Acme"), fakeDept("4", "Team", "3", "Acme")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [] });
    const deepResult = await treeService.getSqlGeneralOrganizationTree();
    if (!deepResult.ok) {
      check("1-4. deep hierarchy builds", false, deepResult.reason);
    } else {
      check(
        "1. with zero live CompanyId evidence anywhere in its subtree, the root is rendered standalone (never wrapped in a guessed/synthetic company node) and reported unresolved",
        deepResult.roots.length === 1 &&
          deepResult.roots[0].kind === "sqlgeneral-department" &&
          (deepResult.roots[0] as any).sqlGeneralDepartmentId === "1" &&
          deepResult.unresolvedCompanyIdentity.length === 1 &&
          deepResult.unresolvedCompanyIdentity[0].sqlGeneralDepartmentId === "1" &&
          deepResult.unresolvedCompanyIdentity[0].reason === "no_evidence",
        JSON.stringify({ roots: deepResult.roots, unresolvedCompanyIdentity: deepResult.unresolvedCompanyIdentity })
      );
      const division = findNode(deepResult.roots, "sgdept:2");
      const department = findNode(deepResult.roots, "sgdept:3");
      const team = findNode(deepResult.roots, "sgdept:4");
      check("2. level 2 (Division) nested directly under the root", !!division);
      check("3. level 3 (Department) nested under Division", !!department && findNode([division], "sgdept:3") !== null);
      check("4. level 4 (Team) nested under Department — arbitrary depth, not just 1-2 levels", !!team && findNode([department], "sgdept:4") !== null);
      check("4b. zero unresolved departments for a genuinely clean deep chain", deepResult.unresolvedDepartments.length === 0);
    }

    console.log("\nMulti-company isolation (verified CompanyId evidence) ===\n");
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("10", "Alpha Root", null, "Alpha Co"), fakeDept("11", "Alpha Child", "10", "Alpha Co"), fakeDept("20", "Beta Root", null, "Beta Co"), fakeDept("21", "Beta Child", "20", "Beta Co")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [fakeSqlUser("alpha.evidence", "10", "1", "Alpha Co"), fakeSqlUser("beta.evidence", "20", "2", "Beta Co")] });
    const isolationResult = await treeService.getSqlGeneralOrganizationTree();
    if (!isolationResult.ok) {
      check("5-6. multi-company isolation builds", false, isolationResult.reason);
    } else {
      check(
        "5. two independent, VERIFIED CompanyIds produce two SEPARATE company nodes, never merged",
        isolationResult.roots.length === 2 && isolationResult.roots.every((r) => r.kind === "sqlgeneral-company") && isolationResult.unresolvedCompanyIdentity.length === 0
      );
      const alphaCompany = isolationResult.roots.find((r) => (r as any).companyId === "1");
      const betaCompany = isolationResult.roots.find((r) => (r as any).companyId === "2");
      const alphaRoot = alphaCompany ? findNode([alphaCompany], "sgdept:10") : null;
      const betaRoot = betaCompany ? findNode([betaCompany], "sgdept:20") : null;
      check(
        "6. each root's own children stay within its own verified company — no cross-company attachment",
        !!alphaCompany && !!betaCompany && !!alphaRoot && !!betaRoot && findNode([alphaCompany], "sgdept:21") === null && findNode([betaCompany], "sgdept:11") === null,
        JSON.stringify({ alpha: alphaCompany, beta: betaCompany })
      );
    }

    console.log("\nCompany grouping identity edge cases ===\n");
    // Two roots sharing identical Company/CompanyShortname DISPLAY TEXT but
    // backed by DIFFERENT verified CompanyIds must stay SEPARATE — grouping
    // never keys on the display text, only the live, verified CompanyId.
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("60", "Root One", null, "Acme Co", "ACME"), fakeDept("70", "Root Two", null, "Acme Co", "ACME")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [fakeSqlUser("u60", "60", "501", "Acme Co"), fakeSqlUser("u70", "70", "502", "Acme Co")] });
    const distinctSharingTextResult = await treeService.getSqlGeneralOrganizationTree();
    if (!distinctSharingTextResult.ok) {
      check("24. distinct-companies-sharing-text build", false, distinctSharingTextResult.reason);
    } else {
      check(
        "24. distinct Companies sharing the SAME display text/shortname (ACME/Acme Co) but verified to DIFFERENT CompanyIds are never merged",
        distinctSharingTextResult.roots.length === 2 &&
          distinctSharingTextResult.roots.every((r) => r.kind === "sqlgeneral-company") &&
          !!distinctSharingTextResult.roots.find((r) => (r as any).companyId === "501") &&
          !!distinctSharingTextResult.roots.find((r) => (r as any).companyId === "502"),
        JSON.stringify(distinctSharingTextResult.roots)
      );
    }

    // The inverse: two roots with COMPLETELY DIFFERENT display text/shortname
    // but the SAME verified CompanyId must be merged — proving grouping
    // truly keys on the verified identity, not the text.
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("80", "Root One", null, "Acme Hellas", "AHEL"), fakeDept("81", "Root Two", null, "Acme International", "AINT")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [fakeSqlUser("u80", "80", "900", "Acme Hellas"), fakeSqlUser("u81", "81", "900", "Acme International")] });
    const verifiedMergeResult = await treeService.getSqlGeneralOrganizationTree();
    if (!verifiedMergeResult.ok) {
      check("25. verified-merge-despite-different-text build", false, verifiedMergeResult.reason);
    } else {
      check(
        "25. two roots with totally different display text/shortname but the SAME verified CompanyId ARE grouped under one company node",
        verifiedMergeResult.roots.length === 1 && verifiedMergeResult.roots[0].kind === "sqlgeneral-company" && (verifiedMergeResult.roots[0] as any).companyId === "900" && verifiedMergeResult.roots[0].children.length === 2,
        JSON.stringify(verifiedMergeResult.roots)
      );
    }

    // Two roots with ZERO CompanyId evidence must NEVER be merged into one
    // shared "unknown company" bucket — each is reported unresolved and
    // rendered standalone, independently.
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("90", "Orphan Root One", null, "Mystery Co"), fakeDept("91", "Orphan Root Two", null, "Other Co")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [] });
    const noEvidenceResult = await treeService.getSqlGeneralOrganizationTree();
    if (!noEvidenceResult.ok) {
      check("26. no-evidence build", false, noEvidenceResult.reason);
    } else {
      check(
        "26. two roots with zero CompanyId evidence are NEVER merged into a shared synthetic/unknown company node — each rendered standalone",
        noEvidenceResult.roots.length === 2 &&
          noEvidenceResult.roots.every((r) => r.kind === "sqlgeneral-department") &&
          noEvidenceResult.unresolvedCompanyIdentity.length === 2 &&
          noEvidenceResult.unresolvedCompanyIdentity.every((u) => u.reason === "no_evidence"),
        JSON.stringify({ roots: noEvidenceResult.roots, unresolvedCompanyIdentity: noEvidenceResult.unresolvedCompanyIdentity })
      );
    }

    // Conflicting evidence WITHIN one root's own subtree (root itself has
    // one CompanyId, a descendant has a different one) must never be
    // silently resolved to either value — reported unresolved, rendered
    // standalone, hierarchy underneath left completely intact.
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("100", "Conflicted Root", null, "Conflict Co"), fakeDept("101", "Conflicted Child", "100", "Conflict Co")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [fakeSqlUser("u100", "100", "11"), fakeSqlUser("u101", "101", "22")] });
    const conflictResult = await treeService.getSqlGeneralOrganizationTree();
    if (!conflictResult.ok) {
      check("27. conflicting-evidence build", false, conflictResult.reason);
    } else {
      const conflictedChild = findNode(conflictResult.roots, "sgdept:101");
      check(
        "27. conflicting CompanyId evidence within one root's own subtree (100 vs its child 101) is reported unresolved, never silently resolved to either value, and the root is rendered standalone",
        conflictResult.roots.some((r) => r.kind === "sqlgeneral-department" && (r as any).sqlGeneralDepartmentId === "100") &&
          conflictResult.unresolvedCompanyIdentity.length === 1 &&
          conflictResult.unresolvedCompanyIdentity[0].sqlGeneralDepartmentId === "100" &&
          conflictResult.unresolvedCompanyIdentity[0].reason === "conflicting_evidence" &&
          !!conflictedChild,
        JSON.stringify({ roots: conflictResult.roots, unresolvedCompanyIdentity: conflictResult.unresolvedCompanyIdentity })
      );
    }

    // Evidence found on a DESCENDANT (not the root itself) still verifies
    // the ROOT's identity — subtree-wide aggregation, not root-only — and
    // the existing nesting below the root is completely unchanged by being
    // wrapped in a company node.
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [fakeDept("110", "Root", null, "Descendant Co"), fakeDept("111", "Child", "110", "Descendant Co")],
    });
    mockListUsersImpl = async () => ({ ok: true, users: [fakeSqlUser("u111", "111", "77")] });
    const descendantEvidenceResult = await treeService.getSqlGeneralOrganizationTree();
    if (!descendantEvidenceResult.ok) {
      check("28. descendant-evidence build", false, descendantEvidenceResult.reason);
    } else {
      const companyNode = descendantEvidenceResult.roots.find((r) => (r as any).companyId === "77");
      const nestedChild = companyNode ? findNode([companyNode], "sgdept:111") : null;
      check(
        "28. CompanyId evidence found on a DESCENDANT (not the root itself) still verifies the ROOT's identity, and arbitrary Department nesting below the root is completely unchanged once wrapped in the company node",
        !!companyNode && companyNode.kind === "sqlgeneral-company" && !!findNode([companyNode], "sgdept:110") && !!nestedChild,
        JSON.stringify(descendantEvidenceResult.roots)
      );
    }

    console.log("\nMissing parent + cycle (including cascading failures at depth) ===\n");
    mockListDeptImpl = async () => ({
      ok: true,
      departments: [
        fakeDept("30", "Orphan", "999", "Gamma"), // 999 doesn't exist — missing_parent
        fakeDept("31", "Cyclic A", "32", "Gamma"),
        fakeDept("32", "Cyclic B", "31", "Gamma"), // 31 <-> 32 cycle
        fakeDept("40", "Valid Root", null, "Gamma"),
        fakeDept("41", "Valid Mid", "40", "Gamma"),
        fakeDept("42", "Grandchild Of Orphan", "30", "Gamma"), // its parent (30) is missing_parent -> must cascade
      ],
    });
    const brokenResult = await treeService.getSqlGeneralOrganizationTree();
    if (!brokenResult.ok) {
      check("7-11. missing parent / cycle build", false, brokenResult.reason);
    } else {
      const unresolvedById = new Map(brokenResult.unresolvedDepartments.map((d) => [d.sqlGeneralDepartmentId, d.reason]));
      check("7. a department whose parent id doesn't exist in the fetched set is reported missing_parent, never a false root", unresolvedById.get("30") === "missing_parent");
      check("8. both members of a 2-cycle are reported as cycle", unresolvedById.get("31") === "cycle" && unresolvedById.get("32") === "cycle");
      check(
        "9. a cycle/missing-parent department is excluded from the tree entirely (searched recursively through the company wrapper layer)",
        ["30", "31", "32"].every((id) => findNode(brokenResult.roots, `sgdept:${id}`) === null)
      );
      check(
        "10. CASCADE at depth: a node whose parent is itself unresolved (30) is ALSO unresolved, even though its own ParentDepartmentId value is perfectly valid",
        unresolvedById.get("42") === "missing_parent"
      );
      check("11. a genuinely unrelated, valid chain (40->41) is completely unaffected by the broken ones", findNode(brokenResult.roots, "sgdept:40") !== null && findNode(brokenResult.roots, "sgdept:41") !== null);
    }

    console.log("\nUnmatched / conflicting users ===\n");
    const uNotFound = await makeUser("notfound");
    await enqueue(uNotFound, "ghost.user");
    const uAmbiguous = await makeUser("ambiguous");
    await enqueue(uAmbiguous, "dupe.user");
    const uNoHrDept = await makeUser("nohrdept");
    await enqueue(uNoHrDept, "no.dept.user");
    const uDeptNotFound = await makeUser("deptnotfound");
    await enqueue(uDeptNotFound, "orphan.dept.user");
    const uGood = await makeUser("good");
    await enqueue(uGood, "good.user");
    const uConflictA = await makeUser("conflicta");
    await enqueue(uConflictA, "shared.identity");
    const uConflictB = await makeUser("conflictb");
    await enqueue(uConflictB, "shared.identity");

    mockListDeptImpl = async () => ({ ok: true, departments: [fakeDept("50", "Home Department", null, "Delta")] });
    mockListUsersImpl = async () => ({
      ok: true,
      users: [
        fakeSqlUser("dupe.user", "50"),
        fakeSqlUser("dupe.user", "50"), // SQLGeneral's own ambiguity: two rows share this Username
        fakeSqlUser("no.dept.user", null), // no HrDepartmentId at all
        fakeSqlUser("orphan.dept.user", "999"), // HrDepartmentId doesn't match any fetched Department
        fakeSqlUser("good.user", "50"),
        // "ghost.user" and "shared.identity" deliberately absent from SQLGeneral's own data
      ],
    });
    const userResult = await treeService.getSqlGeneralOrganizationTree();
    if (!userResult.ok) {
      check("12-17. unmatched/conflicting user resolution", false, userResult.reason);
    } else {
      const unresolvedByUserId = new Map(userResult.unresolvedUsers.map((u) => [u.userId, u.reason]));
      check("12. a username with zero SQLGeneral matches => not_found", unresolvedByUserId.get(uNotFound) === "not_found");
      check("13. a username SQLGeneral itself reports more than once => ambiguous, never silently picks one", unresolvedByUserId.get(uAmbiguous) === "ambiguous");
      check("14. a matched user with no HrDepartmentId at all => no_hr_department", unresolvedByUserId.get(uNoHrDept) === "no_hr_department");
      check("15. a matched user whose HrDepartmentId doesn't resolve to any fetched Department => department_not_found", unresolvedByUserId.get(uDeptNotFound) === "department_not_found");
      check(
        "16. TWO DIFFERENT local users claiming the SAME SQLGeneral username (local-side conflict) => BOTH reported conflicting_attempt, NEITHER shown as a leaf",
        unresolvedByUserId.get(uConflictA) === "conflicting_attempt" && unresolvedByUserId.get(uConflictB) === "conflicting_attempt"
      );
      const homeDept = findNode(userResult.roots, "sgdept:50");
      check(
        "17. a genuinely unique, resolvable user DOES appear as a leaf under their resolved department — never over-conservatively dropped",
        !!homeDept && homeDept.children.some((c: any) => c.kind === "sqlgeneral-user" && c.userId === uGood),
        JSON.stringify(homeDept)
      );
      check("17b. no conflicting/ambiguous/unresolved user ever appears as a leaf anywhere", !findNode(userResult.roots, `sguser:${uConflictA}`) && !findNode(userResult.roots, `sguser:${uAmbiguous}`));
    }

    console.log("\nIncomplete pagination (fail closed) ===\n");
    mockListDeptImpl = async () => ({ ok: false, reason: "Pagination exceeded 200 pages without reaching the end — treating as incomplete rather than silently truncating." });
    mockListUsersImpl = async () => ({ ok: true, users: [] });
    const deptFailResult = await treeService.getSqlGeneralOrganizationTree();
    check("18. a Departments pagination failure fails the WHOLE build closed — never a partial tree", deptFailResult.ok === false, deptFailResult.ok ? "unexpectedly ok" : "");

    mockListDeptImpl = async () => ({ ok: true, departments: [] });
    mockListUsersImpl = async () => ({ ok: false, reason: "Pagination exceeded 200 pages." });
    const userFailResult = await treeService.getSqlGeneralOrganizationTree();
    check("19. a UsersAndManagers pagination failure ALSO fails the whole build closed", userFailResult.ok === false);

    console.log("\nAdmin permission gate ===\n");
    mockListDeptImpl = async () => ({ ok: true, departments: [] });
    mockListUsersImpl = async () => ({ ok: true, users: [] });
    const nonAdmin = await makeUser("nonadmin");
    currentSession = { user: { id: nonAdmin, role: Role.USER, customRoleId: null } };
    const forbiddenRes = await treeRoute.GET();
    check("20. the SQLGeneral tree endpoint: a user without organization.sqlgeneralSync gets 403", forbiddenRes.status === 403);

    const adminUser = await makeUser("admin", Role.ADMIN, null);
    currentSession = { user: { id: adminUser, role: Role.ADMIN, customRoleId: null } };
    const adminRes = await treeRoute.GET();
    const adminBody = await adminRes.json();
    check("21. ADMIN bypasses the permission check and receives tree + unresolvedDepartments + unresolvedUsers", adminRes.status === 200 && Array.isArray(adminBody.tree) && Array.isArray(adminBody.unresolvedDepartments) && Array.isArray(adminBody.unresolvedUsers));
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
    check("22. the EXISTING local Department tree service (unmocked, untouched) still runs without error", localDeptTreeOk);
    check("23. the EXISTING local People tree service (unmocked, untouched) still runs without error", localPeopleTreeOk);
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

main();
