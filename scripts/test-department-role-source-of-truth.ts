/**
 * Regression coverage for the Department Role source-of-truth fix:
 * CustomRole (not the DepartmentRole enum) is now the sole authority for
 * which department roles exist, their display name, and whether they're
 * assignable — exercised via lib/services/department-role-options-service.ts's
 * getDepartmentRoleOptions() and lib/services/department-membership-service.ts's
 * grantManualMembership()/getDepartmentMemberships(), the same functions the
 * admin user-edit modal and department members page call through their API
 * routes. Real Prisma fixtures against the real dev DB, cleaned up in a
 * finally block — no mocking needed, this is pure DB/service logic.
 *
 * Usage: npx tsx scripts/test-department-role-source-of-truth.ts
 */
import { prisma } from "@/lib/prisma";
import { getDepartmentRoleOptions } from "@/lib/services/department-role-options-service";
import { getGlobalRoleOptions } from "@/lib/services/global-role-options-service";
import {
  grantManualMembership,
  getDepartmentMemberships,
  DepartmentRoleAssignmentError,
} from "@/lib/services/department-membership-service";
import { hasDepartmentPermission } from "@/lib/permissions";
import { DepartmentRole, RoleScope, AuthProvider, Role } from "@prisma/client";

const RUN_ID = Date.now();
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

const CANONICAL_BUILT_IN_DEPARTMENT_ROLES: { key: string; scope: RoleScope }[] = [
  { key: "DEPARTMENT_ADMIN", scope: RoleScope.DEPARTMENT },
  { key: "DEPARTMENT_MANAGER", scope: RoleScope.BOTH },
  { key: "PROJECT_MANAGER", scope: RoleScope.DEPARTMENT },
  { key: "AGENT_ASSIGNEE", scope: RoleScope.DEPARTMENT },
  { key: "REQUESTER", scope: RoleScope.DEPARTMENT },
  { key: "VIEWER", scope: RoleScope.DEPARTMENT },
];

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const customRoleIds: string[] = [];
  const userIds: string[] = [];
  const membershipUserIds: string[] = [];
  // Tracks (key -> original name/isActive) for any BUILT-IN row this file
  // mutates, so it can be restored exactly on cleanup — these are shared,
  // production-critical rows, never something this test may leave altered.
  const builtInRestore: { key: string; name: string; isActive: boolean }[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `DeptRoleSoT Dept ${RUN_ID}`, slug: `dept-role-sot-${RUN_ID}` } });

    // ══════════════ 1. Every canonical built-in exists in CustomRole ══════════════
    console.log("\n=== 1. Every canonical built-in Department Role exists in CustomRole ===\n");
    for (const { key, scope } of CANONICAL_BUILT_IN_DEPARTMENT_ROLES) {
      const row = await prisma.customRole.findUnique({ where: { key } });
      check(`${key} exists as a CustomRole row`, !!row);
      check(`${key} isBuiltIn: true`, row?.isBuiltIn === true);
      check(`${key} has the expected scope (${scope})`, row?.scope === scope);
    }

    // ══════════════ 2. Re-running the backfill creates no duplicates ══════════════
    console.log("\n=== 2. Re-running the backfill migration's SQL is a safe no-op ===\n");
    const beforeCount = await prisma.customRole.count({ where: { key: { in: CANONICAL_BUILT_IN_DEPARTMENT_ROLES.map((r) => r.key) } } });
    // The exact same idempotent statement the migration file runs — proves
    // the ON CONFLICT (key) DO NOTHING guarantee directly, not just that the
    // migration happened to already be applied once.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CustomRole" (id, key, name, description, "isBuiltIn", "isActive", scope, "createdAt", "updatedAt")
      VALUES
        (gen_random_uuid()::text, 'DEPARTMENT_ADMIN', 'Department Admin', 'Full control of this department — projects, tickets, activities, goals, members and settings.', true, true, 'DEPARTMENT', now(), now()),
        (gen_random_uuid()::text, 'DEPARTMENT_MANAGER', 'Department Manager', 'Manage department projects and goals', true, true, 'BOTH', now(), now()),
        (gen_random_uuid()::text, 'PROJECT_MANAGER', 'Project Manager', 'Creates and edits projects and Gantt schedules for this department only.', true, true, 'DEPARTMENT', now(), now()),
        (gen_random_uuid()::text, 'AGENT_ASSIGNEE', 'Agent / Assignee', 'Handles assigned tickets and activities; sees every ticket in this department.', true, true, 'DEPARTMENT', now(), now()),
        (gen_random_uuid()::text, 'REQUESTER', 'Requester', 'Creates and tracks their own tickets in this department only.', true, true, 'DEPARTMENT', now(), now()),
        (gen_random_uuid()::text, 'VIEWER', 'Viewer', 'Read-only access to this department''s projects, tickets and activities.', true, true, 'DEPARTMENT', now(), now())
      ON CONFLICT (key) DO NOTHING;
    `);
    const afterCount = await prisma.customRole.count({ where: { key: { in: CANONICAL_BUILT_IN_DEPARTMENT_ROLES.map((r) => r.key) } } });
    check("2. Re-running the backfill creates no duplicate rows", afterCount === beforeCount);

    // ══════════════ 3/10. Renamed built-in role is preserved ══════════════
    console.log("\n=== 3/10. A renamed built-in role's name is preserved (not reverted) ===\n");
    const original = await prisma.customRole.findUniqueOrThrow({ where: { key: "AGENT_ASSIGNEE" } });
    builtInRestore.push({ key: "AGENT_ASSIGNEE", name: original.name, isActive: original.isActive });
    const renamedName = `Field Technician ${RUN_ID}`;
    await prisma.customRole.update({ where: { key: "AGENT_ASSIGNEE" }, data: { name: renamedName } });

    // Re-run the backfill SQL again — must NEVER revert the rename.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CustomRole" (id, key, name, description, "isBuiltIn", "isActive", scope, "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, 'AGENT_ASSIGNEE', 'Agent / Assignee', 'Handles assigned tickets and activities; sees every ticket in this department.', true, true, 'DEPARTMENT', now(), now())
      ON CONFLICT (key) DO NOTHING;
    `);
    const afterBackfillRerun = await prisma.customRole.findUniqueOrThrow({ where: { key: "AGENT_ASSIGNEE" } });
    check("Rename survives a backfill re-run", afterBackfillRerun.name === renamedName);

    let options = await getDepartmentRoleOptions();
    const agentOption = options.find((o) => o.value === DepartmentRole.AGENT_ASSIGNEE);
    check("3. Membership dropdown shows the RENAMED name, not a stale hardcoded label", agentOption?.label === renamedName);
    check("10. Renamed role displays its persisted CustomRole.name specifically", agentOption?.label === renamedName && agentOption?.label !== "Agent / Assignee");

    // Restore immediately so the rest of this run (and other tests) see the normal name.
    await prisma.customRole.update({ where: { key: "AGENT_ASSIGNEE" }, data: { name: original.name } });
    builtInRestore.pop();

    // ══════════════ 4/9. Active built-in (incl. BOTH-scope) appears ══════════════
    console.log("\n=== 4/9. Active built-in roles (including BOTH-scope) appear in the dropdown ===\n");
    options = await getDepartmentRoleOptions();
    check("4. Active built-in DEPARTMENT_ADMIN appears", options.some((o) => o.value === DepartmentRole.DEPARTMENT_ADMIN && !o.isCustom));
    check("9. BOTH-scope DEPARTMENT_MANAGER appears in the Department dropdown", options.some((o) => o.value === DepartmentRole.DEPARTMENT_MANAGER && !o.isCustom));
    check("   ...exactly once, never duplicated", options.filter((o) => o.value === DepartmentRole.DEPARTMENT_MANAGER).length === 1);

    // ══════════════ 5. Active custom role appears ══════════════
    console.log("\n=== 5. Active custom Department Role appears in the dropdown ===\n");
    const customRole = await prisma.customRole.create({
      data: { key: `SOT_TESTROLE_${RUN_ID}`, name: `TestRole ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(customRole.id);
    options = await getDepartmentRoleOptions();
    check("5. Active custom role appears, correctly flagged isCustom", options.some((o) => o.isCustom && o.customRoleId === customRole.id && o.label === customRole.name));

    // ══════════════ 6. Disabled built-in role excluded from new assignment ══════════════
    console.log("\n=== 6. Disabled built-in Department Role does NOT appear for new assignment ===\n");
    const viewerOriginal = await prisma.customRole.findUniqueOrThrow({ where: { key: "VIEWER" } });
    builtInRestore.push({ key: "VIEWER", name: viewerOriginal.name, isActive: viewerOriginal.isActive });
    await prisma.customRole.update({ where: { key: "VIEWER" }, data: { isActive: false } });
    options = await getDepartmentRoleOptions();
    check("6. Disabled built-in VIEWER is excluded from the default (assignable) options", !options.some((o) => o.value === DepartmentRole.VIEWER));

    const freshUser1 = await prisma.user.create({ data: { email: `sot-u1-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(freshUser1.id);
    let rejectedBuiltIn = false;
    try {
      await grantManualMembership(freshUser1.id, dept.id, { role: DepartmentRole.VIEWER });
    } catch (err) {
      rejectedBuiltIn = err instanceof DepartmentRoleAssignmentError && err.code === "ROLE_INACTIVE";
    }
    check("   Server-side: assigning the disabled built-in role to a NEW membership is rejected", rejectedBuiltIn);

    // ══════════════ 7. Disabled custom role excluded from new assignment ══════════════
    console.log("\n=== 7. Disabled custom Department Role does NOT appear for new assignment ===\n");
    await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: false } });
    options = await getDepartmentRoleOptions();
    check("7. Disabled custom role is excluded from the default (assignable) options", !options.some((o) => o.customRoleId === customRole.id));

    const freshUser2 = await prisma.user.create({ data: { email: `sot-u2-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(freshUser2.id);
    let rejectedCustom = false;
    try {
      await grantManualMembership(freshUser2.id, dept.id, { customRoleId: customRole.id });
    } catch (err) {
      rejectedCustom = err instanceof DepartmentRoleAssignmentError && err.code === "ROLE_INACTIVE";
    }
    check("   Server-side: assigning the disabled custom role to a NEW membership is rejected", rejectedCustom);

    // ══════════════ 8. GLOBAL-only role excluded ══════════════
    console.log("\n=== 8. GLOBAL-only role does NOT appear in the Department dropdown ===\n");
    const globalOnlyRole = await prisma.customRole.create({
      data: { key: `SOT_GLOBALONLY_${RUN_ID}`, name: `Global Only ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleIds.push(globalOnlyRole.id);
    options = await getDepartmentRoleOptions({ includeInactive: true });
    check("8. A GLOBAL-scope custom role never appears in the Department options, even with includeInactive", !options.some((o) => o.customRoleId === globalOnlyRole.id));

    let rejectedWrongScope = false;
    try {
      await grantManualMembership(freshUser1.id, dept.id, { customRoleId: globalOnlyRole.id });
    } catch (err) {
      rejectedWrongScope = err instanceof DepartmentRoleAssignmentError && err.code === "ROLE_WRONG_SCOPE";
    }
    check("   Server-side: assigning a GLOBAL-scope role id to a Department Membership is rejected", rejectedWrongScope);

    // ══════════════ 11. Existing membership on a disabled role remains readable ══════════════
    console.log("\n=== 11. Existing membership already on a disabled role remains readable/manageable ===\n");
    // Re-activate VIEWER just long enough to grant it, then disable it again
    // — simulates "was active when assigned, disabled afterward".
    await prisma.customRole.update({ where: { key: "VIEWER" }, data: { isActive: true } });
    const viewerUser = await prisma.user.create({ data: { email: `sot-viewer-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(viewerUser.id);
    membershipUserIds.push(viewerUser.id);
    await grantManualMembership(viewerUser.id, dept.id, { role: DepartmentRole.VIEWER });
    await prisma.customRole.update({ where: { key: "VIEWER" }, data: { isActive: false } });

    const readBack = await getDepartmentMemberships(dept.id);
    const viewerMembership = readBack.find((m) => m.userId === viewerUser.id);
    check("11. Membership on a since-disabled role is still returned by getDepartmentMemberships", !!viewerMembership);
    check("   ...with its real role intact (not corrupted/nulled)", viewerMembership?.role === DepartmentRole.VIEWER);

    // Re-saving the SAME (now-disabled) role must succeed — "reactivate/no-op is never blocked".
    let unchangedThrew = false;
    try {
      await grantManualMembership(viewerUser.id, dept.id, { role: DepartmentRole.VIEWER });
    } catch {
      unchangedThrew = true;
    }
    check("   Re-saving the membership WITHOUT changing its (disabled) role does not throw", !unchangedThrew);

    // ══════════════ 12/13. Permission resolution still works ══════════════
    console.log("\n=== 12/13. Built-in and custom Department Role permission resolution still work ===\n");
    await prisma.customRole.update({ where: { key: "VIEWER" }, data: { isActive: true } });
    const perm = await prisma.permission.findFirst({ where: { key: "activity.view" } });
    if (perm) {
      const viewerHasPerm = await hasDepartmentPermission(DepartmentRole.VIEWER, perm.key, null);
      check("12. Built-in role (VIEWER) permission resolution still works", viewerHasPerm === true);
    } else {
      console.log("  (skip: activity.view permission not seeded in this environment)");
    }

    const customPerm = await prisma.permission.findFirst({ where: { key: "ticket.view" } });
    if (customPerm) {
      await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: true } });
      await prisma.rolePermission.create({ data: { roleKey: customRole.key, permissionId: customPerm.id } }).catch(() => {});
      const customHasPerm = await hasDepartmentPermission(DepartmentRole.VIEWER, customPerm.key, customRole.id);
      check("13. Custom Department Role permission resolution works (via customRoleId)", customHasPerm === true);
    } else {
      console.log("  (skip: ticket.view permission not seeded in this environment)");
    }

    // ══════════════ 14. Updating a membership persists the correct stable identity ══════════════
    console.log("\n=== 14. Updating a membership persists the correct stable role identity ===\n");
    await grantManualMembership(freshUser1.id, dept.id, { role: DepartmentRole.REQUESTER });
    membershipUserIds.push(freshUser1.id);
    let refetched = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: freshUser1.id, departmentId: dept.id } } });
    check("   Built-in identity persisted as the enum value, customRoleId null", refetched?.role === DepartmentRole.REQUESTER && refetched?.customRoleId === null);

    await grantManualMembership(freshUser1.id, dept.id, { customRoleId: customRole.id });
    refetched = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: freshUser1.id, departmentId: dept.id } } });
    check("14. Switching to a custom role persists customRoleId (stable identity), never the display name", refetched?.customRoleId === customRole.id);
    check("   ...role column holds the required placeholder, never read for permissions once customRoleId is set", refetched?.role === DepartmentRole.VIEWER);

    // Rename the custom role AFTER assignment — identity (customRoleId) must be unaffected.
    await prisma.customRole.update({ where: { id: customRole.id }, data: { name: `TestRole Renamed ${RUN_ID}` } });
    refetched = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: freshUser1.id, departmentId: dept.id } } });
    check("   Renaming the custom role after assignment does not change the stored identity", refetched?.customRoleId === customRole.id);

    // ══════════════ 15. Global Role behavior is not regressed ══════════════
    console.log("\n=== 15. Global Role behavior is not regressed ===\n");
    const globalOptions = await getGlobalRoleOptions();
    check("15. getGlobalRoleOptions still returns built-in global roles", globalOptions.some((o) => o.value === Role.USER));
    check("   ...and ADMIN is present in the raw catalogue (Microsoft-mapping-specific exclusion lives elsewhere, not here)", globalOptions.some((o) => o.value === Role.ADMIN));
    const globalCustom = await prisma.customRole.create({
      data: { key: `SOT_GLOBALCUSTOM_${RUN_ID}`, name: `Global Custom ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleIds.push(globalCustom.id);
    const globalOptionsAfter = await getGlobalRoleOptions();
    check("   A custom GLOBAL role still appears in getGlobalRoleOptions (untouched by this fix)", globalOptionsAfter.some((o) => o.customRoleId === globalCustom.id));
  } finally {
    // Restore any built-in row this test mutated, in every case, even on failure.
    for (const b of builtInRestore) {
      await prisma.customRole.update({ where: { key: b.key }, data: { name: b.name, isActive: b.isActive } }).catch(() => {});
    }
    // Defensive: VIEWER/AGENT_ASSIGNEE must never be left disabled/renamed by this file.
    await prisma.customRole.update({ where: { key: "VIEWER" }, data: { isActive: true } }).catch(() => {});
    await prisma.customRole.update({ where: { key: "AGENT_ASSIGNEE" }, data: { isActive: true } }).catch(() => {});

    const cleanup: [string, () => Promise<unknown>][] = [
      ["role permissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { contains: `SOT_TESTROLE_${RUN_ID}` } } })],
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: membershipUserIds }, departmentId: dept?.id } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
