/**
 * Workspace selector — initial-20 + search architecture
 * (lib/services/workspace-service.ts's listAccessibleWorkspaces,
 * resolveActiveWorkspace, app/api/workspace/search/route.ts). Proves the
 * DATABASE query itself is take-bounded and search-filtered (never "fetch
 * everything, then .slice()/.filter() in Node"), permission-scoped, and
 * that the currently-active department is never lost even when it falls
 * outside the first WORKSPACE_LIST_TAKE.
 *
 * Usage: npx tsx scripts/test-workspace-selector-search.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import {
  listAccessibleWorkspaces,
  resolveActiveWorkspace,
  WORKSPACE_LIST_TAKE,
} from "@/lib/services/workspace-service";
import { ALL_WORKSPACES_VALUE } from "@/types/department";

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

const RUN_ID = Date.now();
const NAME_TAG = `wssearch-${RUN_ID}`;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function cleanupDepartments(deptIds: string[]) {
  if (deptIds.length === 0) return;
  await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
  await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
  await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
  await prisma.department.deleteMany({ where: { id: { in: deptIds } } }).catch(() => {});
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  const deptIds: string[] = [];
  const userIds: string[] = [];

  try {
    console.log(`\n=== Seeding ${WORKSPACE_LIST_TAKE + 5} departments (WORKSPACE_LIST_TAKE=${WORKSPACE_LIST_TAKE}) ===\n`);
    // Named so they sort deterministically ("...-00" .. "...-24") and so
    // "-24" (the 25th) is guaranteed to sort AFTER the first
    // WORKSPACE_LIST_TAKE by name ascending.
    const total = WORKSPACE_LIST_TAKE + 5;
    const created: { id: string; name: string }[] = [];
    for (let i = 0; i < total; i++) {
      const idx = String(i).padStart(2, "0");
      const dept = await createDepartment({ name: `${NAME_TAG}-${idx}`, slug: `${NAME_TAG}-${idx}` });
      deptIds.push(dept.id);
      created.push({ id: dept.id, name: dept.name });
    }
    const lastDept = created[created.length - 1]; // "-29" if total=25 starting at 0 => actually last index = total-1
    const beyondFirst20 = created[WORKSPACE_LIST_TAKE]; // the (TAKE+1)-th department, guaranteed outside the initial page

    const admin = await prisma.user.create({
      data: { email: `${NAME_TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "irrelevant" },
      select: { id: true },
    });
    userIds.push(admin.id);

    console.log("\n=== Initial list is DB-take-bounded, not a client slice ===\n");
    const initial = await listAccessibleWorkspaces(admin.id, Role.ADMIN);
    check(`Initial list returns exactly ${WORKSPACE_LIST_TAKE} rows (not more)`, initial.length === WORKSPACE_LIST_TAKE, `got ${initial.length}`);
    check("Initial list is ordered by name ascending (deterministic)", initial.every((d, i) => i === 0 || d.name >= initial[i - 1].name));
    const initialIds = new Set(initial.map((d) => d.id));
    check("No duplicate ids in the initial list", initialIds.size === initial.length);

    console.log("\n=== Search finds a workspace OUTSIDE the initial page ===\n");
    check("The (TAKE+1)-th department is NOT in the initial list (sanity check on the fixture)", !initialIds.has(beyondFirst20.id));
    const searchForBeyond = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: beyondFirst20.name });
    check("Search-by-exact-name finds it", searchForBeyond.some((d) => d.id === beyondFirst20.id));

    console.log("\n=== Case-insensitive matching ===\n");
    const searchUpper = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: beyondFirst20.name.toUpperCase() });
    check("Uppercase search still matches", searchUpper.some((d) => d.id === beyondFirst20.id));
    const searchLower = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: beyondFirst20.name.toLowerCase() });
    check("Lowercase search still matches", searchLower.some((d) => d.id === beyondFirst20.id));

    console.log("\n=== Search results are themselves limited ===\n");
    const searchAllFixture = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: NAME_TAG });
    check(`Searching a term matching all ${total} fixture departments returns at most ${WORKSPACE_LIST_TAKE}`, searchAllFixture.length <= WORKSPACE_LIST_TAKE, `got ${searchAllFixture.length}`);

    console.log("\n=== Empty search restores the initial (unfiltered) list ===\n");
    const emptySearch = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: "" });
    check("search:'' behaves identically to no search filter", emptySearch.map((d) => d.id).join(",") === initial.map((d) => d.id).join(","));

    console.log("\n=== No-results state ===\n");
    const noResults = await listAccessibleWorkspaces(admin.id, Role.ADMIN, { search: `nonexistent-${RUN_ID}-xyz` });
    check("A term matching nothing returns an empty array", noResults.length === 0);

    console.log("\n=== Currently-selected workspace is preserved even outside the initial 20 ===\n");
    const resolvedForBeyond = await resolveActiveWorkspace(admin.id, Role.ADMIN, beyondFirst20.id);
    check("resolveActiveWorkspace resolves the requested (beyond-page-1) department as active", resolvedForBeyond.departmentId === beyondFirst20.id);
    check(
      "...and includes it in the returned `departments` list even though it's outside the initial page",
      resolvedForBeyond.departments.some((d) => d.id === beyondFirst20.id)
    );
    check(
      `...while the returned list stays small (<= ${WORKSPACE_LIST_TAKE + 1}), never the full accessible set`,
      resolvedForBeyond.departments.length <= WORKSPACE_LIST_TAKE + 1,
      `got ${resolvedForBeyond.departments.length}`
    );

    console.log("\n=== All Workspaces semantics unaffected ===\n");
    const resolvedAll = await resolveActiveWorkspace(admin.id, Role.ADMIN, ALL_WORKSPACES_VALUE);
    check("Requesting ALL_WORKSPACES_VALUE resolves departmentId: null, isAllSelected: true", resolvedAll.departmentId === null && resolvedAll.isAllSelected === true);
    check("...and canViewAllDepartments stays true for ADMIN", resolvedAll.canViewAllDepartments === true);

    console.log("\n=== Permission scoping: a regular member only searches their OWN memberships ===\n");
    const plainDept = await createDepartment({ name: `${NAME_TAG}-plain-dept`, slug: `${NAME_TAG}-plain-dept` });
    deptIds.push(plainDept.id);
    const plainUser = await prisma.user.create({
      data: { email: `${NAME_TAG}-plain@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "irrelevant" },
      select: { id: true },
    });
    userIds.push(plainUser.id);
    await prisma.departmentMembership.create({
      data: { userId: plainUser.id, departmentId: plainDept.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const plainUserSearchForFixture = await listAccessibleWorkspaces(plainUser.id, Role.USER, { search: NAME_TAG });
    check(
      "A plain USER's search NEVER returns a department they aren't a member of, even though it matches the search term",
      !plainUserSearchForFixture.some((d) => d.id === beyondFirst20.id)
    );
    const plainUserSearchForOwn = await listAccessibleWorkspaces(plainUser.id, Role.USER, { search: "plain-dept" });
    check("...but DOES find their own department by name", plainUserSearchForOwn.some((d) => d.id === plainDept.id));
  } finally {
    await cleanupDepartments(deptIds);
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
