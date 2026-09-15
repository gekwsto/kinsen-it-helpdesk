/**
 * Regression coverage for the new `gantt.view` permission (Task 2).
 *
 * SEMANTICS BEING TESTED: gantt.view is a capability gate for the Gantt UI
 * itself, layered ON TOP OF (never a replacement for) the underlying
 * entity-view authorization:
 *   - Project Gantt access = effective gantt.view AND effective project.view
 *   - Activity Gantt access = effective gantt.view AND effective activity.view
 * "Effective" means the same GLOBAL-grant-OR-qualifying-active-department-
 * grant union getNavVisibilityFlags already applies to its other *.view/
 * *.create keys (see hasEffectiveModulePermission in
 * lib/services/department-scope-service.ts). Department DATA scoping
 * (buildProjectListWhere/buildActivityListWhere) is completely untouched by
 * this permission — confirmed with the user before implementing.
 *
 * Both Gantt pages (app/(main)/projects/gantt/page.tsx,
 * app/(main)/activities/gantt/page.tsx) and the sidebar's Project/Activity
 * Gantt links (components/layout/sidebar.tsx, via NavVisibilityFlags.
 * canViewProjectGantt/canViewActivityGantt) all consume this same
 * AND-combination — never re-derived ad hoc per call site.
 *
 * A deliberate design nuance covered here: inside getNavVisibilityFlags'
 * canViewAllDepartments(role) early-return branch (ADMIN + DIRECTOR),
 * every OTHER flag is hardcoded `true` (safe, because the bypass itself
 * already grants those unconditionally at the code level), but
 * canViewProjectGantt/canViewActivityGantt are computed via a genuine
 * hasPermission(role, "gantt.view", customRoleId) call instead — so a real
 * System Admin (Role.ADMIN) can never have Gantt hidden (hasPermission
 * unconditionally short-circuits true for ADMIN), while a DIRECTOR
 * (canViewAllDepartments=true but NOT given hasPermission's unconditional
 * bypass) genuinely loses Gantt if an administrator revokes gantt.view from
 * the DIRECTOR role via /admin/roles. SECTION B proves both halves of this
 * distinction directly against the real DB, restoring the seeded state
 * afterward either way.
 *
 * Usage: npx tsx scripts/test-gantt-view-permission.ts
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, Role, RoleScope } from "@prisma/client";
import {
  getNavVisibilityFlags,
  hasEffectiveModulePermission,
} from "@/lib/services/department-scope-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";

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
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — Gantt pages/sidebar gate on gantt.view AND the underlying entity-view permission ===\n");

  const projectGanttPath = path.join(process.cwd(), "app/(main)/projects/gantt/page.tsx");
  const projectGanttSrc = await fs.readFile(projectGanttPath, "utf8");
  check("A1. Project Gantt page checks hasEffectiveModulePermission(...,'gantt.view')", /hasEffectiveModulePermission\([^)]*"gantt\.view"/.test(projectGanttSrc));
  check("A2. Project Gantt page checks hasEffectiveModulePermission(...,'project.view')", /hasEffectiveModulePermission\([^)]*"project\.view"/.test(projectGanttSrc));
  check("A3. Project Gantt page redirects unless BOTH are true (AND, not OR)", /if\s*\(\s*!canViewGantt\s*\|\|\s*!canViewProjects\s*\)/.test(projectGanttSrc));

  const activityGanttPath = path.join(process.cwd(), "app/(main)/activities/gantt/page.tsx");
  const activityGanttSrc = await fs.readFile(activityGanttPath, "utf8");
  check("A4. Activity Gantt page checks hasEffectiveModulePermission(...,'gantt.view')", /hasEffectiveModulePermission\([^)]*"gantt\.view"/.test(activityGanttSrc));
  check("A5. Activity Gantt page checks canViewActivities (from getNavVisibilityFlags)", /canViewActivities/.test(activityGanttSrc));
  check("A6. Activity Gantt page redirects unless BOTH are true (AND, not OR)", /if\s*\(\s*!canViewGantt\s*\|\|\s*!canViewActivities\s*\)/.test(activityGanttSrc));

  const sidebarPath = path.join(process.cwd(), "components/layout/sidebar.tsx");
  const sidebarSrc = await fs.readFile(sidebarPath, "utf8");
  check("A7. Sidebar's Project Gantt link uses navFlags.canViewProjectGantt (not the plain canViewProjects flag)", /canViewProjectGantt/.test(sidebarSrc));
  check("A8. Sidebar's Activity Gantt link uses navFlags.canViewActivityGantt (not the plain canViewActivities flag)", /canViewActivityGantt/.test(sidebarSrc));

  const scopeServicePath = path.join(process.cwd(), "lib/services/department-scope-service.ts");
  const scopeServiceSrc = await fs.readFile(scopeServicePath, "utf8");
  check("A9. canViewProjectGantt is computed as canViewGantt && canViewProjects (AND semantics) in the general branch", /canViewProjectGantt:\s*canViewGantt\s*&&\s*canViewProjects/.test(scopeServiceSrc));
  check("A10. canViewActivityGantt is computed as canViewGantt && canViewActivities (AND semantics) in the general branch", /canViewActivityGantt:\s*canViewGantt\s*&&\s*canViewActivities/.test(scopeServiceSrc));
  check("A11. Inside the canViewAllDepartments bypass branch, gantt.view is resolved via a genuine hasPermission() call (not hardcoded true like the sibling flags)", /const canViewGantt = await hasPermission\(role, "gantt\.view", customRoleId\)/.test(scopeServiceSrc));

  // ══════════════════════ SECTION B — behavioral (real DB) ══════════════════════
  console.log("\n=== SECTION B — gantt.view AND-combination + ADMIN/DIRECTOR revocability, against the real resolvers ===\n");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const RUN_ID = Date.now();
  const userIds: string[] = [];
  const deptIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  let directorGrantDeleted = false;
  let adminGrantDeleted = false;

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `GANTT_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUnique({ where: { key } });
      if (!perm) throw new Error(`Missing canonical permission: ${key}`);
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    const dept = await prisma.department.create({ data: { name: `Gantt View Dept ${RUN_ID}`, slug: `gantt-view-${RUN_ID}` } });
    deptIds.push(dept.id);

    // Role.USER (the base global role every fixture below uses) already
    // globally grants activity.view + gantt.view on its own (see
    // ROLE_PERMISSIONS.USER in prisma/seed.ts) — real, correct, unrelated
    // behavior, but it would silently contaminate an "isolated department
    // grant only" test below. A blank GLOBAL custom role assigned as each
    // fixture user's customRoleId neutralizes that base-role global grant
    // entirely (hasPermission checks an active customRoleId's OWN
    // permission set instead of falling back to the base Role enum — see
    // lib/permissions.ts), so only the DEPARTMENT-scoped grant under test
    // is actually in effect for these fixtures.
    const noopGlobalRole = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);

    // ── 1. gantt.view present but project.view/activity.view ABSENT => no Gantt access, even though gantt.view itself is granted (proves gantt.view alone is not a substitute for entity-view auth) ──
    console.log("\n1. Department role with gantt.view ONLY (no project.view/activity.view) => canViewProjectGantt/canViewActivityGantt both false\n");
    const ganttOnlyRole = await makeCustomRole("GANTT_ONLY", RoleScope.DEPARTMENT, ["gantt.view"]);
    const ganttOnlyUser = await prisma.user.create({
      data: { email: `gantt-only-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(ganttOnlyUser.id);
    await grantManualMembership(ganttOnlyUser.id, dept.id, { customRoleId: ganttOnlyRole.id });
    const flags1 = await getNavVisibilityFlags(ganttOnlyUser.id, Role.USER, noopGlobalRole.id);
    check("1a. canViewProjectGantt=false (project.view missing)", flags1.canViewProjectGantt === false);
    check("1b. canViewActivityGantt=false (activity.view missing)", flags1.canViewActivityGantt === false);
    check("1c. sanity: this role genuinely does hold gantt.view via hasEffectiveModulePermission", await hasEffectiveModulePermission(ganttOnlyUser.id, Role.USER, noopGlobalRole.id, "gantt.view"));

    // ── 2. project.view/activity.view present but gantt.view ABSENT => no Gantt access, even though the user can see the underlying list/detail pages (proves gantt.view is a real, independent gate — not implied by project.view/activity.view) ──
    console.log("\n2. Department role with project.view + activity.view but NO gantt.view => canViewProjects/canViewActivities true, but canViewProjectGantt/canViewActivityGantt both false\n");
    const viewOnlyRole = await makeCustomRole("VIEW_ONLY_NO_GANTT", RoleScope.DEPARTMENT, ["project.view", "activity.view"]);
    const viewOnlyUser = await prisma.user.create({
      data: { email: `view-only-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(viewOnlyUser.id);
    await grantManualMembership(viewOnlyUser.id, dept.id, { customRoleId: viewOnlyRole.id });
    const flags2 = await getNavVisibilityFlags(viewOnlyUser.id, Role.USER, noopGlobalRole.id);
    check("2a. canViewProjects=true (entity-view auth itself is unaffected)", flags2.canViewProjects === true);
    check("2b. canViewActivities=true (entity-view auth itself is unaffected)", flags2.canViewActivities === true);
    check("2c. canViewProjectGantt=false (gantt.view missing => Gantt UI hidden even though project.view is present)", flags2.canViewProjectGantt === false);
    check("2d. canViewActivityGantt=false (gantt.view missing => Gantt UI hidden even though activity.view is present)", flags2.canViewActivityGantt === false);

    // ── 3. Both present => Gantt access granted (the positive case) ──
    console.log("\n3. Department role with gantt.view + project.view + activity.view => both Gantt flags true\n");
    const bothRole = await makeCustomRole("GANTT_AND_VIEW", RoleScope.DEPARTMENT, ["gantt.view", "project.view", "activity.view"]);
    const bothUser = await prisma.user.create({
      data: { email: `gantt-and-view-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(bothUser.id);
    await grantManualMembership(bothUser.id, dept.id, { customRoleId: bothRole.id });
    const flags3 = await getNavVisibilityFlags(bothUser.id, Role.USER, noopGlobalRole.id);
    check("3a. canViewProjectGantt=true (both sources present)", flags3.canViewProjectGantt === true);
    check("3b. canViewActivityGantt=true (both sources present)", flags3.canViewActivityGantt === true);

    // ── 4. Department-scoped-only gantt.view (no global grant) still counts via the union — same rule as every other module key ──
    console.log("\n4. hasEffectiveModulePermission('gantt.view') recognizes a department-scoped-only grant (union rule applies to gantt.view too, not just the pre-existing 4 keys)\n");
    check("4a. hasEffectiveModulePermission is true for the dept-scoped-only gantt.view grant above", await hasEffectiveModulePermission(bothUser.id, Role.USER, noopGlobalRole.id, "gantt.view"));
    const noGanttUser = await prisma.user.create({
      data: { email: `no-gantt-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(noGanttUser.id);
    check("4b. hasEffectiveModulePermission is false for a user with no membership/role granting gantt.view at all", !(await hasEffectiveModulePermission(noGanttUser.id, Role.USER, noopGlobalRole.id, "gantt.view")));

    // ── 5. Built-in roles already backfilled with gantt.view (prisma/seed.ts NEW_PERMISSION_DEFAULT_GRANTS) keep working end to end ──
    console.log("\n5. Built-in DEPARTMENT_ADMIN (backfilled with gantt.view in prisma/seed.ts) has both Gantt flags true through the real seeded grant, not a test fixture\n");
    const builtinUser = await prisma.user.create({
      data: { email: `builtin-deptadmin-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(builtinUser.id);
    await grantManualMembership(builtinUser.id, dept.id, { role: DepartmentRole.DEPARTMENT_ADMIN });
    const flags5 = await getNavVisibilityFlags(builtinUser.id, Role.USER, noopGlobalRole.id);
    check("5a. canViewProjectGantt=true via the real seeded DEPARTMENT_ADMIN grant", flags5.canViewProjectGantt === true);
    check("5b. canViewActivityGantt=true via the real seeded DEPARTMENT_ADMIN grant", flags5.canViewActivityGantt === true);

    // ── 6. ADMIN vs DIRECTOR revocability distinction inside the canViewAllDepartments branch ──
    console.log("\n6. ADMIN (unconditional hasPermission bypass) can never lose Gantt; DIRECTOR (canViewAllDepartments but no hasPermission bypass) genuinely can\n");

    const ganttPerm = await prisma.permission.findUniqueOrThrow({ where: { key: "gantt.view" } });

    const directorGrant = await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey: "DIRECTOR", permissionId: ganttPerm.id } } });
    check("6a. sanity: DIRECTOR is seeded with gantt.view before this test mutates anything", !!directorGrant);

    const flagsDirectorBefore = await getNavVisibilityFlags("director-fixture-unused-id", Role.DIRECTOR, null);
    check("6b. Baseline: DIRECTOR has canViewProjectGantt=true (seeded grant present)", flagsDirectorBefore.canViewProjectGantt === true);
    check("6c. Baseline: DIRECTOR has canViewActivityGantt=true (seeded grant present)", flagsDirectorBefore.canViewActivityGantt === true);

    if (directorGrant) {
      await prisma.rolePermission.delete({ where: { roleKey_permissionId: { roleKey: "DIRECTOR", permissionId: ganttPerm.id } } });
      directorGrantDeleted = true;
    }
    const flagsDirectorRevoked = await getNavVisibilityFlags("director-fixture-unused-id", Role.DIRECTOR, null);
    check("6d. After revoking gantt.view from DIRECTOR: canViewProjectGantt=false (genuinely revocable)", flagsDirectorRevoked.canViewProjectGantt === false);
    check("6e. After revoking gantt.view from DIRECTOR: canViewActivityGantt=false (genuinely revocable)", flagsDirectorRevoked.canViewActivityGantt === false);
    check("6f. ...but canViewProjects stays true (canViewAllDepartments bypass for the underlying entity-view is untouched by this)", flagsDirectorRevoked.canViewProjects === true);
    check("6g. ...and canViewActivities stays true too", flagsDirectorRevoked.canViewActivities === true);

    if (directorGrant) {
      await prisma.rolePermission.create({ data: { roleKey: "DIRECTOR", permissionId: ganttPerm.id } });
      directorGrantDeleted = false;
    }
    const flagsDirectorRestored = await getNavVisibilityFlags("director-fixture-unused-id", Role.DIRECTOR, null);
    check("6h. Restored: DIRECTOR's canViewProjectGantt=true again", flagsDirectorRestored.canViewProjectGantt === true);

    const adminGrant = await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: ganttPerm.id } } });
    if (adminGrant) {
      await prisma.rolePermission.delete({ where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: ganttPerm.id } } });
      adminGrantDeleted = true;
    }
    const flagsAdminNoGrantRow = await getNavVisibilityFlags("admin-fixture-unused-id", Role.ADMIN, null);
    check("6i. Even with its RolePermission row for gantt.view deleted, ADMIN still has canViewProjectGantt=true (hasPermission's role===ADMIN unconditional bypass, not a DB grant)", flagsAdminNoGrantRow.canViewProjectGantt === true);
    check("6j. ...and canViewActivityGantt=true too", flagsAdminNoGrantRow.canViewActivityGantt === true);

    if (adminGrant) {
      await prisma.rolePermission.create({ data: { roleKey: "ADMIN", permissionId: ganttPerm.id } });
      adminGrantDeleted = false;
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions (custom roles)", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    // Failsafe restoration in case an earlier step threw before the normal
    // restore ran — never leave the real dev DB with DIRECTOR/ADMIN
    // permanently missing gantt.view.
    try {
      const ganttPerm = await prisma.permission.findUnique({ where: { key: "gantt.view" } });
      if (ganttPerm && directorGrantDeleted) {
        await prisma.rolePermission.upsert({
          where: { roleKey_permissionId: { roleKey: "DIRECTOR", permissionId: ganttPerm.id } },
          update: {},
          create: { roleKey: "DIRECTOR", permissionId: ganttPerm.id },
        });
        console.warn("Failsafe: restored DIRECTOR's gantt.view grant after an unexpected early exit.");
      }
      if (ganttPerm && adminGrantDeleted) {
        await prisma.rolePermission.upsert({
          where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: ganttPerm.id } },
          update: {},
          create: { roleKey: "ADMIN", permissionId: ganttPerm.id },
        });
        console.warn("Failsafe: restored ADMIN's gantt.view grant after an unexpected early exit.");
      }
    } catch (err) {
      console.error("FAILSAFE RESTORE FAILED — manually verify DIRECTOR/ADMIN still hold gantt.view:", err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
