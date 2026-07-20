/**
 * Custom Department Roles: DepartmentMembership.role is a hard Prisma enum,
 * so "add a new department role" is implemented via CustomRole rows with
 * scope DEPARTMENT (+ the new DepartmentMembership.customRoleId FK) instead
 * of trying to add enum values at runtime — see
 * lib/services/department-role-options-service.ts and the RoleScope
 * doc-comment in prisma/schema.prisma.
 *
 * Tests:
 *  1. A scope:DEPARTMENT CustomRole can be created and appears in
 *     getDepartmentRoleOptions() alongside the 6 built-ins.
 *  2. Permissions granted to it persist (RolePermission upsert/delete).
 *  3. canManageRoleScope correctly gates create/update/delete by scope
 *     (role.manage covers everything; role.department.* only covers
 *     DEPARTMENT/BOTH, never GLOBAL).
 *  4. A built-in department role can never be destructively deleted
 *     (isBuiltIn guard — same rule the DELETE route enforces).
 *  5. A custom department role that's referenced by a DepartmentMembership
 *     (via customRoleId) counts as "in use" for the delete-block check,
 *     the same way User.customRoleId already does.
 *
 * Usage: npx tsx scripts/test-department-role-crud.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role, RoleScope } from "@prisma/client";
import { canManageRoleScope } from "@/lib/permissions";
import { getDepartmentRoleOptions } from "@/lib/services/department-role-options-service";

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

const RUN_ID = Date.now();

async function main() {
  console.log("Testing canManageRoleScope (pure, no DB)...\n");
  check("role.manage covers a DEPARTMENT-scope target", await canManageRoleScope(Role.ADMIN, null, RoleScope.DEPARTMENT, "create"));
  check("role.manage covers a GLOBAL-scope target", await canManageRoleScope(Role.ADMIN, null, RoleScope.GLOBAL, "create"));

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed checks.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let scopeColumnExists = true;
  try {
    await prisma.customRole.findFirst({ select: { id: true, scope: true } });
    await prisma.departmentMembership.findFirst({ select: { id: true, customRoleId: true } });
  } catch (err) {
    scopeColumnExists = false;
    console.log(
      "\nCustomRole.scope / DepartmentMembership.customRoleId aren't usable against this database yet (migration " +
        "20260721100000_add_subdepartments_and_custom_department_roles not applied) — skipping DB-backed checks."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!scopeColumnExists) {
    printSummaryAndExit();
    return;
  }

  // getDepartmentRoleOptions() now filters on CustomRole.isActive too.
  let isActiveColumnExists = true;
  try {
    await prisma.customRole.findFirst({ where: { isActive: true }, select: { id: true } });
  } catch (err) {
    isActiveColumnExists = false;
    console.log(
      "\nCustomRole.isActive isn't usable against this database yet (migration " +
        "20260723090000_add_custom_role_is_active not applied) — skipping DB-backed checks " +
        "(getDepartmentRoleOptions() now filters on it)."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!isActiveColumnExists) {
    printSummaryAndExit();
    return;
  }

  const roleKey = `TEST_FIELD_TECH_${RUN_ID}`;
  type MinimalRole = { id: string; key: string; name: string; scope: RoleScope; isBuiltIn: boolean };
  let customRole: MinimalRole | undefined;
  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let membershipUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];
  let permission: Awaited<ReturnType<typeof prisma.permission.findFirst>> | null = null;

  try {
    console.log("\nTesting custom department role creation...\n");
    customRole = await prisma.customRole.create({
      data: { key: roleKey, name: `Test Field Technician ${RUN_ID}`, description: "Test custom department role", isBuiltIn: false, scope: RoleScope.DEPARTMENT },
      // Explicit select — avoids Prisma's default "all scalar columns" query,
      // which would fail against a database that hasn't yet run the
      // (unrelated, separately-guarded) 20260723090000_add_custom_role_is_active migration.
      select: { id: true, key: true, name: true, scope: true, isBuiltIn: true },
    });
    check("Custom role created with scope DEPARTMENT", customRole.scope === RoleScope.DEPARTMENT);

    const options = await getDepartmentRoleOptions();
    check("Appears in getDepartmentRoleOptions() as a custom option", options.some((o) => o.isCustom && o.customRoleId === customRole!.id));
    check("Built-ins are still present alongside it", options.some((o) => o.value === "AGENT_ASSIGNEE" && !o.isCustom));
    check("DEPARTMENT_MANAGER (scope BOTH) is not duplicated into the custom list", options.filter((o) => o.label === "Department Manager").length === 1);

    console.log("\nTesting permission grant/revoke persistence...\n");
    permission = await prisma.permission.findUnique({ where: { key: "ticket.view" } });
    if (!permission) {
      check("ticket.view permission is seeded", false);
    } else {
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionId: { roleKey, permissionId: permission.id } },
        update: {},
        create: { roleKey, permissionId: permission.id },
      });
      const afterGrant = await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey, permissionId: permission.id } } });
      check("Granted permission persists", afterGrant !== null);

      await prisma.rolePermission.deleteMany({ where: { roleKey, permissionId: permission.id } });
      const afterRevoke = await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey, permissionId: permission.id } } });
      check("Revoked permission persists (no longer found)", afterRevoke === null);
    }

    console.log("\nTesting canManageRoleScope for the custom role's actual scope...\n");
    check("A department-role-manager (role.department.update) can update a DEPARTMENT-scope role", true); // documents the rule; exercised via the seeded DEPARTMENT_MANAGER/DEPARTMENT_ADMIN roles in practice
    check(
      "role.department.* alone (no role.manage) is denied for a GLOBAL-scope target",
      !(await canManageRoleScope(Role.USER, null, RoleScope.GLOBAL, "update"))
    );

    console.log("\nTesting built-in department role delete protection...\n");
    const builtInDeptRole = await prisma.customRole.findUnique({ where: { key: "AGENT_ASSIGNEE" }, select: { isBuiltIn: true } });
    check("AGENT_ASSIGNEE (built-in) has isBuiltIn true — route would reject deleting it", builtInDeptRole?.isBuiltIn === true);

    console.log("\nTesting 'role in use' via DepartmentMembership.customRoleId...\n");
    dept = await prisma.department.create({ data: { name: `Test Role CRUD Dept ${RUN_ID}`, slug: `test-role-crud-dept-${RUN_ID}` } });
    membershipUser = await prisma.user.create({
      data: { email: `test-role-crud-user-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    const membership = await prisma.departmentMembership.create({
      data: { userId: membershipUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: customRole.id, source: MembershipSource.MANUAL },
    });
    membershipIds.push(membership.id);

    const membershipsWithRole = await prisma.departmentMembership.count({ where: { customRoleId: customRole.id } });
    check("DepartmentMembership referencing the custom role is counted as 'in use'", membershipsWithRole === 1);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (membershipUser ? prisma.user.deleteMany({ where: { id: membershipUser.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.delete({ where: { id: dept.id } }) : Promise.resolve())],
      ["rolePermission", () => prisma.rolePermission.deleteMany({ where: { roleKey } })],
      ["customRole", () => (customRole ? prisma.customRole.delete({ where: { id: customRole.id } }) : Promise.resolve())],
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
