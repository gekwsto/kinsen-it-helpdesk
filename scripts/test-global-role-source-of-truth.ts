/**
 * Regression coverage for the Global Role source-of-truth fix: CustomRole
 * (not the Role enum) is now the sole authority for which global roles
 * exist, their display name, and whether they're assignable — exercised via
 * lib/services/global-role-options-service.ts's getGlobalRoleOptions() and
 * lib/services/global-role-assignment-service.ts's assertGlobalRoleAssignable(),
 * the same functions GET /api/admin/roles/options and the Admin User
 * create/edit routes call through. Real Prisma fixtures against the real
 * dev DB, cleaned up in a finally block — no mocking needed, this is pure
 * DB/service logic.
 *
 * Scenario 5/6/7/14/17 below specifically reproduces the cited PRODUCTION
 * state: Role.DIRECTOR exists in the Prisma/PostgreSQL enum (added by
 * migration 20260718160000_add_director_role, enum-only, no CustomRole
 * insert), but CustomRole/User/RolePermission all have zero DIRECTOR rows.
 * This dev DB normally HAS a real DIRECTOR CustomRole row (seed.ts includes
 * it) — this test temporarily removes it (and its RolePermission rows) to
 * reproduce the exact production scenario, then restores everything exactly
 * in the finally block.
 *
 * Usage: npx tsx scripts/test-global-role-source-of-truth.ts
 */
import { prisma } from "@/lib/prisma";
import { getGlobalRoleOptions } from "@/lib/services/global-role-options-service";
import { getDepartmentRoleOptions } from "@/lib/services/department-role-options-service";
import { assertGlobalRoleAssignable, GlobalRoleAssignmentError } from "@/lib/services/global-role-assignment-service";
import { hasPermission, canViewAllDepartments, canManageProjects } from "@/lib/permissions";
import { Role, RoleScope, AuthProvider } from "@prisma/client";

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

async function main() {
  await prisma.$connect();

  const customRoleIds: string[] = [];
  const userIds: string[] = [];
  const builtInRestore: { key: string; name: string; isActive: boolean }[] = [];

  // DIRECTOR fixture state, captured before this file mutates anything, so
  // it can be restored exactly regardless of pass/fail.
  let directorRole: Awaited<ReturnType<typeof prisma.customRole.findUnique>> = null;
  let directorPermissions: { permissionId: string }[] = [];
  let directorRemoved = false;

  try {
    // ══════════════ 1/3. Active built-in and BOTH-scope roles appear ══════════════
    console.log("\n=== 1/3. Active persisted built-in (incl. BOTH-scope) Global Roles appear ===\n");
    let options = await getGlobalRoleOptions();
    check("1. Active built-in ADMIN appears", options.some((o) => o.value === Role.ADMIN && !o.isCustom));
    check("1. Active built-in USER appears", options.some((o) => o.value === Role.USER && !o.isCustom));
    check("3. BOTH-scope DEPARTMENT_MANAGER appears in the Global dropdown", options.some((o) => o.value === Role.DEPARTMENT_MANAGER && !o.isCustom));

    // ══════════════ 18. Catalogue size tracks CustomRole, not the fixed-size enum ══════════════
    console.log("\n=== 18. No dropdown catalogue is directly Object.values(Role)-sized ===\n");
    const persistedActiveCount = await prisma.customRole.count({ where: { scope: { not: RoleScope.DEPARTMENT }, isActive: true } });
    check("18. getGlobalRoleOptions()'s length exactly tracks the CustomRole table (not the fixed 5-value Role enum)", options.length === persistedActiveCount);

    // ══════════════ 4/11. Renamed built-in role uses persisted name ══════════════
    console.log("\n=== 4/11. A renamed built-in Global Role is preserved and shown correctly ===\n");
    const itAgentOriginal = await prisma.customRole.findUniqueOrThrow({ where: { key: "IT_AGENT" } });
    builtInRestore.push({ key: "IT_AGENT", name: itAgentOriginal.name, isActive: itAgentOriginal.isActive });
    const renamedName = `Support Engineer ${RUN_ID}`;
    await prisma.customRole.update({ where: { key: "IT_AGENT" }, data: { name: renamedName } });
    options = await getGlobalRoleOptions();
    const itAgentOption = options.find((o) => o.value === Role.IT_AGENT);
    check("4. GLOBAL assignment catalogue reflects the renamed persisted name, not a stale hardcoded label", itAgentOption?.label === renamedName);
    check("11. Renamed built-in role uses persisted CustomRole.name specifically", itAgentOption?.label === renamedName && itAgentOption?.label !== "IT Agent");

    // ══════════════ 8. Disabled built-in role excluded from new assignment ══════════════
    console.log("\n=== 8. Disabled built-in Global Role does NOT appear for new assignment ===\n");
    await prisma.customRole.update({ where: { key: "IT_AGENT" }, data: { isActive: false } });
    options = await getGlobalRoleOptions();
    check("8. Disabled built-in IT_AGENT is excluded from the default (assignable) options", !options.some((o) => o.value === Role.IT_AGENT));

    const freshUser1 = await prisma.user.create({ data: { email: `groleSot-u1-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(freshUser1.id);
    let rejectedDisabledBuiltIn = false;
    try {
      await assertGlobalRoleAssignable({ role: Role.IT_AGENT }, null, prisma);
    } catch (err) {
      rejectedDisabledBuiltIn = err instanceof GlobalRoleAssignmentError && err.code === "ROLE_INACTIVE";
    }
    check("   Server-side: assigning the disabled built-in role to a NEW user is rejected", rejectedDisabledBuiltIn);

    // Restore IT_AGENT immediately (name + active) so the rest of this run sees it normally.
    await prisma.customRole.update({ where: { key: "IT_AGENT" }, data: { name: itAgentOriginal.name, isActive: true } });
    builtInRestore.pop();

    // ══════════════ 2/12. Active custom GLOBAL role appears + renamed custom role ══════════════
    console.log("\n=== 2/12. Active custom GLOBAL role appears; renamed custom role uses persisted name ===\n");
    const customRole = await prisma.customRole.create({
      data: { key: `GROLE_SOT_TESTROLE_${RUN_ID}`, name: `TestGlobalRole ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleIds.push(customRole.id);
    options = await getGlobalRoleOptions();
    check("2. Active custom GLOBAL role appears, correctly flagged isCustom", options.some((o) => o.isCustom && o.customRoleId === customRole.id && o.label === customRole.name));

    const renamedCustomName = `TestGlobalRole Renamed ${RUN_ID}`;
    await prisma.customRole.update({ where: { id: customRole.id }, data: { name: renamedCustomName } });
    options = await getGlobalRoleOptions();
    check("12. Renamed custom role uses persisted name", options.find((o) => o.customRoleId === customRole.id)?.label === renamedCustomName);

    // ══════════════ 9. Disabled custom Global Role excluded from new assignment ══════════════
    console.log("\n=== 9. Disabled custom Global Role does NOT appear for new assignment ===\n");
    await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: false } });
    options = await getGlobalRoleOptions();
    check("9. Disabled custom role is excluded from the default (assignable) options", !options.some((o) => o.customRoleId === customRole.id));

    let rejectedDisabledCustom = false;
    try {
      await assertGlobalRoleAssignable({ customRoleId: customRole.id }, null, prisma);
    } catch (err) {
      rejectedDisabledCustom = err instanceof GlobalRoleAssignmentError && err.code === "ROLE_INACTIVE";
    }
    check("   Server-side: assigning the disabled custom role to a NEW user is rejected", rejectedDisabledCustom);

    // ══════════════ 13. Existing user on a disabled role remains readable/manageable ══════════════
    console.log("\n=== 13. Existing user already assigned to a disabled Global Role remains readable/manageable ===\n");
    // Re-activate just long enough to grant it — simulates "was active when assigned, disabled afterward".
    await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: true } });
    await prisma.user.update({ where: { id: freshUser1.id }, data: { role: Role.USER, customRoleId: customRole.id } });
    await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: false } });

    const readBack = await prisma.user.findUnique({ where: { id: freshUser1.id }, include: { customRole: true } });
    check("13. User assigned to a since-disabled custom role is still readable", !!readBack);
    check("   ...with its real customRoleId intact (not corrupted/nulled)", readBack?.customRoleId === customRole.id);

    let unchangedThrew = false;
    try {
      await assertGlobalRoleAssignable({ customRoleId: customRole.id }, { role: readBack!.role, customRoleId: readBack!.customRoleId }, prisma);
    } catch {
      unchangedThrew = true;
    }
    check("   Re-saving the user WITHOUT changing its (disabled) role does not throw", !unchangedThrew);

    // ══════════════ 10. GLOBAL-incompatible (DEPARTMENT-scope) role excluded ══════════════
    console.log("\n=== 10. A DEPARTMENT-scope role does NOT appear in the Global dropdown ===\n");
    const deptOnlyRole = await prisma.customRole.create({
      data: { key: `GROLE_SOT_DEPTONLY_${RUN_ID}`, name: `Dept Only ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(deptOnlyRole.id);
    options = await getGlobalRoleOptions({ includeInactive: true });
    check("10. A DEPARTMENT-scope custom role never appears in the Global options, even with includeInactive", !options.some((o) => o.customRoleId === deptOnlyRole.id));

    let rejectedWrongScope = false;
    try {
      await assertGlobalRoleAssignable({ customRoleId: deptOnlyRole.id }, null, prisma);
    } catch (err) {
      rejectedWrongScope = err instanceof GlobalRoleAssignmentError && err.code === "ROLE_WRONG_SCOPE";
    }
    check("   Server-side: assigning a DEPARTMENT-scope role id as a Global Role is rejected", rejectedWrongScope);

    // Sanity: the reverse must also hold — a GLOBAL-only role never leaks into the Department catalogue (unchanged, cross-checks Section 13's "do not regress Department Roles").
    const deptOptions = await getDepartmentRoleOptions({ includeInactive: true });
    check("   ...and this GLOBAL-scope custom role from earlier never leaks into Department options either", !deptOptions.some((o) => o.customRoleId === customRole.id));

    // ══════════════ 15/16. Permission resolution still works ══════════════
    console.log("\n=== 15/16. Built-in and custom Global Role permission resolution still work ===\n");
    const adminHasPerm = await hasPermission(Role.ADMIN, "admin.access", null);
    check("15. Built-in role (ADMIN) permission resolution still works", adminHasPerm === true);

    const customPerm = await prisma.permission.findFirst({ where: { key: "ticket.view" } });
    if (customPerm) {
      await prisma.customRole.update({ where: { id: customRole.id }, data: { isActive: true } });
      await prisma.rolePermission.create({ data: { roleKey: customRole.key, permissionId: customPerm.id } }).catch(() => {});
      const customHasPerm = await hasPermission(Role.USER, customPerm.key, customRole.id);
      check("16. Custom Global Role permission resolution works (via customRoleId)", customHasPerm === true);
    } else {
      console.log("  (skip: ticket.view permission not seeded in this environment)");
    }

    // ══════════════ 5/6/7/14/17. Exact production DIRECTOR scenario ══════════════
    console.log("\n=== 5/6/7/14/17. Exact production repro: enum has DIRECTOR, CustomRole/User/RolePermission do not ===\n");
    directorRole = await prisma.customRole.findUnique({ where: { key: "DIRECTOR" } });
    if (!directorRole) {
      console.log("  (skip: this dev DB has no DIRECTOR CustomRole row to begin with — already matches production; the assignability checks below still run)");
    } else {
      directorPermissions = await prisma.rolePermission.findMany({ where: { roleKey: "DIRECTOR" }, select: { permissionId: true } });
      // RolePermission.roleKey has no FK to CustomRole.id (plain string join)
      // — deleting the CustomRole row alone would NOT remove these, so they
      // are removed explicitly to reproduce the exact cited production
      // state (RolePermission WHERE roleKey = 'DIRECTOR' -> 0 rows).
      await prisma.rolePermission.deleteMany({ where: { roleKey: "DIRECTOR" } });
      await prisma.customRole.delete({ where: { key: "DIRECTOR" } });
      directorRemoved = true;
    }

    // A pre-existing legacy user whose enum role is DIRECTOR — proves
    // reading/managing such a user never crashes just because DIRECTOR has
    // no active CustomRole row (production currently has zero such users,
    // but the fix must be safe if any environment ever does).
    const legacyDirectorUser = await prisma.user.create({
      data: { email: `groleSot-director-${RUN_ID}@example.com`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(legacyDirectorUser.id);

    options = await getGlobalRoleOptions();
    check("5/6. DIRECTOR does NOT appear in the default (assignable) Global Role options", !options.some((o) => o.value === Role.DIRECTOR));
    const optionsIncludingInactive = await getGlobalRoleOptions({ includeInactive: true });
    check("5/6. DIRECTOR does NOT appear even with includeInactive (the row doesn't exist at all, not merely disabled)", !optionsIncludingInactive.some((o) => o.value === Role.DIRECTOR));

    let ghostDirectorRejected = false;
    try {
      await assertGlobalRoleAssignable({ role: Role.DIRECTOR }, null, prisma);
    } catch (err) {
      ghostDirectorRejected = err instanceof GlobalRoleAssignmentError && err.code === "ROLE_NOT_FOUND";
    }
    check("7. A malicious/manual API request assigning ghost DIRECTOR to a NEW user is rejected cleanly", ghostDirectorRejected);

    let existingDirectorUnchangedThrew = false;
    try {
      await assertGlobalRoleAssignable(
        { role: Role.DIRECTOR },
        { role: legacyDirectorUser.role, customRoleId: legacyDirectorUser.customRoleId },
        prisma
      );
    } catch {
      existingDirectorUnchangedThrew = true;
    }
    check("14. Re-saving an EXISTING legacy DIRECTOR user without changing their role does not throw (remains manageable)", !existingDirectorUnchangedThrew);

    const readLegacyDirector = await prisma.user.findUnique({ where: { id: legacyDirectorUser.id } });
    check("14. The existing legacy DIRECTOR user remains readable", readLegacyDirector?.role === Role.DIRECTOR);

    let authorizationCrashed = false;
    let viewAll = false;
    let manageProjects = false;
    try {
      viewAll = canViewAllDepartments(Role.DIRECTOR);
      manageProjects = canManageProjects(Role.DIRECTOR);
    } catch {
      authorizationCrashed = true;
    }
    check("17. canViewAllDepartments(DIRECTOR) does not crash and still returns true (legacy authorization intact)", !authorizationCrashed && viewAll === true);
    check("17. canManageProjects(DIRECTOR) does not crash and still returns true (legacy authorization intact)", !authorizationCrashed && manageProjects === true);

    // ══════════════ 19. Roles & Permissions and the User dropdown expose the same catalogue ══════════════
    console.log("\n=== 19. Roles & Permissions and the Admin User Global Role dropdown expose the same active catalogue ===\n");
    // /api/admin/roles (Roles & Permissions page) reads prisma.customRole.findMany
    // directly (no isActive filter, admins need to see disabled roles too);
    // /api/admin/roles/options (Admin User dropdown) is getGlobalRoleOptions().
    // Filtering the first to isActive must produce exactly the same set of
    // GLOBAL/BOTH ids the second returns — one shared catalogue, not two.
    const rolesPageActiveGlobal = await prisma.customRole.findMany({ where: { scope: { not: RoleScope.DEPARTMENT }, isActive: true }, select: { id: true } });
    const dropdownActive = await getGlobalRoleOptions();
    const rolesPageIds = new Set(rolesPageActiveGlobal.map((r) => r.id));
    const dropdownCustomIds = new Set(dropdownActive.filter((o) => o.isCustom).map((o) => o.customRoleId));
    const rolesPageCustomIds = new Set(
      (await prisma.customRole.findMany({ where: { scope: { not: RoleScope.DEPARTMENT }, isActive: true, isBuiltIn: false }, select: { id: true } })).map((r) => r.id)
    );
    check("19. Same active custom-role id set behind both surfaces", rolesPageCustomIds.size === dropdownCustomIds.size && [...rolesPageCustomIds].every((id) => dropdownCustomIds.has(id)));
    check("19. Same total active GLOBAL/BOTH row count behind both surfaces", rolesPageIds.size === dropdownActive.length);
  } finally {
    // Restore DIRECTOR exactly as it was, first — this is shared,
    // production-critical (well, dev-critical) data, never something this
    // test may leave altered, regardless of pass/fail above.
    if (directorRemoved && directorRole) {
      await prisma.customRole
        .create({
          data: {
            id: directorRole.id,
            key: directorRole.key,
            name: directorRole.name,
            description: directorRole.description,
            isBuiltIn: directorRole.isBuiltIn,
            isActive: directorRole.isActive,
            scope: directorRole.scope,
            createdAt: directorRole.createdAt,
            updatedAt: directorRole.updatedAt,
          },
        })
        .catch((err) => console.error("Failed to restore DIRECTOR CustomRole row:", err));
      if (directorPermissions.length > 0) {
        await prisma.rolePermission
          .createMany({ data: directorPermissions.map((p) => ({ roleKey: "DIRECTOR", permissionId: p.permissionId })) })
          .catch((err) => console.error("Failed to restore DIRECTOR RolePermission rows:", err));
      }
    }

    // Restore any other built-in row this test mutated.
    for (const b of builtInRestore) {
      await prisma.customRole.update({ where: { key: b.key }, data: { name: b.name, isActive: b.isActive } }).catch(() => {});
    }
    // Defensive: IT_AGENT must never be left disabled/renamed by this file.
    await prisma.customRole.update({ where: { key: "IT_AGENT" }, data: { isActive: true } }).catch(() => {});

    const cleanup: [string, () => Promise<unknown>][] = [
      ["role permissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { contains: `GROLE_SOT_TESTROLE_${RUN_ID}` } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
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
