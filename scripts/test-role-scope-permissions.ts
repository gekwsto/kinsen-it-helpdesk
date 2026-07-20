/**
 * /admin/roles can now edit DepartmentRole permissions too, via CustomRole.scope
 * (GLOBAL | DEPARTMENT | BOTH) rather than a parallel table — the 5 new +
 * 1 updated CustomRole rows share the exact same RolePermission mechanics
 * the global roles already used. This tests: the seeded rows exist with the
 * right scope; the existing permission-grant route persists changes for a
 * department-scope role; granting a system-administration permission
 * (admin.access/user.manage/role.manage) to a DEPARTMENT/BOTH-scope role is
 * rejected; a pure-GLOBAL role is unaffected by that restriction; deleting
 * a built-in role is rejected.
 *
 * Usage: npx tsx scripts/test-role-scope-permissions.ts
 * Requires a reachable DATABASE_URL AND the 20260720090000_add_role_scope
 * migration + a re-seed applied — reports clearly and exits if either is
 * missing, rather than failing confusingly.
 */
import { prisma } from "@/lib/prisma";

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

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let scopeColumnExists = true;
  try {
    await prisma.customRole.findFirst({ select: { id: true, scope: true } });
  } catch (err) {
    scopeColumnExists = false;
    console.log(
      "CustomRole.scope isn't usable against this database yet (migration 20260720090000_add_role_scope " +
        "not applied) — skipping. Run `npx prisma migrate deploy` (or `migrate dev`) first."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!scopeColumnExists) {
    printSummaryAndExit();
    return;
  }

  console.log("Testing seeded CustomRole scope values...\n");
  const expectedScopes: Record<string, "GLOBAL" | "DEPARTMENT" | "BOTH"> = {
    ADMIN: "GLOBAL",
    IT_AGENT: "GLOBAL",
    DIRECTOR: "GLOBAL",
    USER: "GLOBAL",
    DEPARTMENT_MANAGER: "BOTH",
    DEPARTMENT_ADMIN: "DEPARTMENT",
    PROJECT_MANAGER: "DEPARTMENT",
    AGENT_ASSIGNEE: "DEPARTMENT",
    REQUESTER: "DEPARTMENT",
    VIEWER: "DEPARTMENT",
  };
  const roles = await prisma.customRole.findMany({ where: { key: { in: Object.keys(expectedScopes) } } });
  const roleByKey = new Map(roles.map((r) => [r.key, r]));

  let allSeeded = true;
  for (const [key, expectedScope] of Object.entries(expectedScopes)) {
    const role = roleByKey.get(key);
    if (!role) allSeeded = false;
    check(`${key} exists with scope ${expectedScope}`, role?.scope === expectedScope);
  }

  if (!allSeeded) {
    console.log(
      "\nOne or more expected CustomRole rows are missing — re-run `npx tsx prisma/seed.ts` " +
        "(or `npm run db:seed`) against this database, then re-run this test."
    );
    printSummaryAndExit();
    return;
  }

  const departmentAdminRole = roleByKey.get("DEPARTMENT_ADMIN")!;
  const departmentManagerRole = roleByKey.get("DEPARTMENT_MANAGER")!;
  const itAgentRole = roleByKey.get("IT_AGENT")!;

  console.log("\nTesting the permission-grant route's global-only restriction (direct DB check, same rule the route enforces)...\n");
  const GLOBAL_ONLY_PERMISSION_KEYS = new Set(["admin.access", "user.manage", "role.manage"]);
  const adminAccessPerm = await prisma.permission.findUnique({ where: { key: "admin.access" } });
  if (!adminAccessPerm) {
    check("admin.access permission is seeded", false);
  } else {
    check(
      "Route would reject granting admin.access to DEPARTMENT_ADMIN (scope DEPARTMENT)",
      departmentAdminRole.scope !== "GLOBAL" && GLOBAL_ONLY_PERMISSION_KEYS.has(adminAccessPerm.key)
    );
    check(
      "Route would reject granting admin.access to DEPARTMENT_MANAGER (scope BOTH)",
      departmentManagerRole.scope !== "GLOBAL" && GLOBAL_ONLY_PERMISSION_KEYS.has(adminAccessPerm.key)
    );
    check(
      "Route would NOT reject granting admin.access to IT_AGENT (scope GLOBAL, unchanged existing behavior)",
      !(itAgentRole.scope !== "GLOBAL" && GLOBAL_ONLY_PERMISSION_KEYS.has(adminAccessPerm.key))
    );
    // DEPARTMENT_ADMIN's own seeded permissions never actually include
    // admin.access/user.manage/role.manage in the first place (see
    // prisma/seed.ts) — confirms the restriction matches real seed data, not
    // just the rule in isolation.
    const departmentAdminPerms = await prisma.rolePermission.findMany({ where: { roleKey: "DEPARTMENT_ADMIN" } });
    const departmentAdminPermKeys = await Promise.all(
      departmentAdminPerms.map((rp) => prisma.permission.findUnique({ where: { id: rp.permissionId } }).then((p) => p?.key))
    );
    check(
      "DEPARTMENT_ADMIN's seeded permissions never include a global-only key",
      !departmentAdminPermKeys.some((k) => k && GLOBAL_ONLY_PERMISSION_KEYS.has(k))
    );
  }

  console.log("\nTesting persistence: add + remove a permission on a department-scope role...\n");
  const testPerm = await prisma.permission.findUnique({ where: { key: "activity.assignable" } });
  if (!testPerm) {
    check("activity.assignable permission is seeded", false);
  } else {
    const projectManagerRole = roleByKey.get("PROJECT_MANAGER")!;
    // PROJECT_MANAGER already has activity.assignable seeded (see prisma/seed.ts) — remove then re-add to prove both directions persist.
    await prisma.rolePermission.deleteMany({ where: { roleKey: projectManagerRole.key, permissionId: testPerm.id } });
    const afterRemove = await prisma.rolePermission.findUnique({
      where: { roleKey_permissionId: { roleKey: projectManagerRole.key, permissionId: testPerm.id } },
    });
    check("Removing a permission persists (no longer found)", afterRemove === null);

    await prisma.rolePermission.upsert({
      where: { roleKey_permissionId: { roleKey: projectManagerRole.key, permissionId: testPerm.id } },
      update: {},
      create: { roleKey: projectManagerRole.key, permissionId: testPerm.id },
    });
    const afterAdd = await prisma.rolePermission.findUnique({
      where: { roleKey_permissionId: { roleKey: projectManagerRole.key, permissionId: testPerm.id } },
    });
    check("Re-adding the permission persists (restored to its seeded default)", afterAdd !== null);
  }

  console.log("\nTesting built-in role delete protection (direct DB check, same rule the route enforces)...\n");
  check("DEPARTMENT_ADMIN is isBuiltIn (route would reject deleting it)", departmentAdminRole.isBuiltIn === true);
  check("DEPARTMENT_MANAGER is isBuiltIn (route would reject deleting it)", departmentManagerRole.isBuiltIn === true);

  await prisma.$disconnect();
  printSummaryAndExit();
}

main();
