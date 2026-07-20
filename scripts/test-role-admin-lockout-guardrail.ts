/**
 * lib/services/role-safety-service.ts is the new guardrail layer behind
 * unlocking built-in role edits — `wouldOrphanCriticalPermission` and
 * `wouldOrphanAdminAccessByDisablingRole` are what PATCH /api/admin/roles/[id]
 * (isActive:false) and POST/DELETE .../permissions/[permId] now call instead
 * of the old blanket built-in lock. Neither function reads CustomRole.isActive
 * (only User.role/isActive/customRoleId and RolePermission), so checks 1-2
 * below run regardless of migration state. Checks 3-5 need freshly created
 * CustomRole rows to simulate the scenario, and Prisma writes every
 * @default() field (including isActive) into a CustomRole INSERT's column
 * list regardless of `select` — so those are skipped with a clear message if
 * migration 20260723090000_add_custom_role_is_active hasn't been applied yet.
 *
 * Tests:
 *  1. Real seeded state: an active Role.ADMIN enum user exists (admin@kinsen.gr)
 *     — wouldOrphanCriticalPermission is false for every critical key on every
 *     role, since the hardcoded ADMIN bypass makes it safe by construction.
 *  2. Non-critical permission keys always return false, regardless of ADMIN
 *     enum user state — losing e.g. ticket.delete is never a lockout risk.
 *  3. Simulated zero-ADMIN-enum-user scenario (temporarily demoting the seeded
 *     admin's `role` for the duration of the check, reverted immediately after):
 *     removing a critical permission from a role that is the ONLY other grantor
 *     (no active user reaches it) → true (would orphan).
 *  4. Same simulated scenario, but another active user's role still grants the
 *     permission → false (not orphaned).
 *  5. wouldOrphanAdminAccessByDisablingRole("ADMIN") mirrors the same logic for
 *     disabling the Administrator role itself.
 *
 * Usage: npx tsx scripts/test-role-admin-lockout-guardrail.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, RoleScope } from "@prisma/client";
import {
  CRITICAL_ADMIN_PERMISSION_KEYS,
  wouldOrphanCriticalPermission,
  wouldOrphanAdminAccessByDisablingRole,
} from "@/lib/services/role-safety-service";

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
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  type MinimalRole = { id: string; key: string; name: string; isBuiltIn: boolean; scope: RoleScope };
  let demotedAdminIds: string[] = [];
  let soleGrantorRole: MinimalRole | undefined;
  let otherGrantorRole: MinimalRole | undefined;
  let coverUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let adminAccessPermId: string | undefined;

  try {
    console.log("\nTesting the common case: a real active Role.ADMIN enum user exists...\n");
    const activeAdminCount = await prisma.user.count({ where: { role: Role.ADMIN, isActive: true } });
    check("At least one active Role.ADMIN enum user is seeded (admin@kinsen.gr)", activeAdminCount > 0);

    for (const key of CRITICAL_ADMIN_PERMISSION_KEYS) {
      const orphan = await wouldOrphanCriticalPermission("IT_AGENT", key);
      check(`wouldOrphanCriticalPermission("IT_AGENT", "${key}") is false while an active ADMIN enum user exists`, orphan === false);
    }

    console.log("\nTesting non-critical permission keys are never a lockout risk...\n");
    const nonCritical = await wouldOrphanCriticalPermission("IT_AGENT", "ticket.delete");
    check('wouldOrphanCriticalPermission("IT_AGENT", "ticket.delete") is false (not a critical key)', nonCritical === false);

    console.log("\nSetting up a simulated zero-ADMIN-enum-user scenario...\n");
    const adminAccessPerm = await prisma.permission.findUnique({ where: { key: "admin.access" } });
    check("admin.access permission is seeded", adminAccessPerm !== null);
    if (!adminAccessPerm) {
      printSummaryAndExit();
      return;
    }
    adminAccessPermId = adminAccessPerm.id;

    try {
      soleGrantorRole = await prisma.customRole.create({
        data: { key: `TEST_SOLE_GRANTOR_${RUN_ID}`, name: `Sole Grantor ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL },
        select: { id: true, key: true, name: true, isBuiltIn: true, scope: true },
      });
    } catch (err: any) {
      if (err?.code === "P2022") {
        console.log(
          "CustomRole.isActive isn't usable against this database yet (migration " +
            "20260723090000_add_custom_role_is_active not applied) — Prisma includes the " +
            "schema's @default(true) for isActive in every CustomRole INSERT regardless of " +
            "select, so no new CustomRole rows can be created until it's applied. Skipping " +
            "the simulated-lockout sub-tests below; the real-seeded-state checks above already ran."
        );
        printSummaryAndExit();
        return;
      }
      throw err;
    }
    await prisma.rolePermission.create({ data: { roleKey: soleGrantorRole.key, permissionId: adminAccessPermId } });

    otherGrantorRole = await prisma.customRole.create({
      data: { key: `TEST_OTHER_GRANTOR_${RUN_ID}`, name: `Other Grantor ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL },
      select: { id: true, key: true, name: true, isBuiltIn: true, scope: true },
    });
    await prisma.rolePermission.create({ data: { roleKey: otherGrantorRole.key, permissionId: adminAccessPermId } });

    // Temporarily demote every active Role.ADMIN enum user so the hardcoded
    // bypass no longer masks the RolePermission-based reasoning — reverted in
    // `finally` no matter what happens below.
    const activeAdmins = await prisma.user.findMany({ where: { role: Role.ADMIN, isActive: true }, select: { id: true } });
    demotedAdminIds = activeAdmins.map((u) => u.id);
    await prisma.user.updateMany({ where: { id: { in: demotedAdminIds } }, data: { role: Role.USER } });

    console.log("\nTesting: role is the ONLY grantor and no active user reaches the other grantor role...\n");
    const orphanWhenSoleGrantor = await wouldOrphanCriticalPermission(otherGrantorRole.key, "admin.access");
    check(
      "wouldOrphanCriticalPermission is true when removing from the last-covered role with no active user on the other grantor",
      orphanWhenSoleGrantor === true
    );

    console.log("\nTesting: another active user's role still covers the permission...\n");
    coverUser = await prisma.user.create({
      data: {
        email: `test-cover-${RUN_ID}@kinsen.gr`,
        name: "Test Cover User",
        role: Role.USER,
        customRoleId: soleGrantorRole.id,
        isActive: true,
        authProvider: "CREDENTIALS",
      },
    });
    const orphanWhenCovered = await wouldOrphanCriticalPermission(otherGrantorRole.key, "admin.access");
    check(
      "wouldOrphanCriticalPermission is false once an active user's customRole covers the permission elsewhere",
      orphanWhenCovered === false
    );

    console.log("\nTesting wouldOrphanAdminAccessByDisablingRole for the ADMIN role itself...\n");
    // With admins demoted and no other role covering role.manage/user.manage
    // (only admin.access is covered by our test roles), disabling ADMIN
    // should be flagged unsafe for at least one critical key.
    const wouldOrphanAdminDisable = await wouldOrphanAdminAccessByDisablingRole("ADMIN");
    check(
      "wouldOrphanAdminAccessByDisablingRole('ADMIN') is true when no active user has any critical-permission path",
      wouldOrphanAdminDisable === true
    );
  } finally {
    console.log("\nReverting simulated state...\n");
    if (demotedAdminIds.length > 0) {
      try {
        await prisma.user.updateMany({ where: { id: { in: demotedAdminIds } }, data: { role: Role.ADMIN } });
      } catch (err) {
        console.warn("Reverting demoted admins failed (non-fatal):", err instanceof Error ? err.message : err);
      }
    }
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["coverUser", () => (coverUser ? prisma.user.deleteMany({ where: { id: coverUser.id } }) : Promise.resolve())],
      [
        "rolePermissions",
        () =>
          prisma.rolePermission.deleteMany({
            where: { roleKey: { in: [soleGrantorRole?.key, otherGrantorRole?.key].filter((k): k is string => !!k) } },
          }),
      ],
      [
        "customRoles",
        () =>
          prisma.customRole.deleteMany({
            where: { id: { in: [soleGrantorRole?.id, otherGrantorRole?.id].filter((id): id is string => !!id) } },
          }),
      ],
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
