/**
 * prisma/seed.ts used to be destructive-on-rerun for role state in two ways:
 * (a) the RolePermission loop upserted every [roleKey, permKey] pair from
 * ROLE_PERMISSIONS on every run, silently recreating any single permission an
 * admin had removed from a role that still had others; (b) the builtInRoles
 * CustomRole upsert's `update: {...}` overwrote an admin-renamed built-in
 * role's name/description/scope back to the hardcoded seed values every run.
 * Both are now bootstrap-once: (a) is guarded by a per-roleKey
 * `count > 0 → skip the whole loop` check, (b) uses `update: {}`
 * (create-if-missing only).
 *
 * This test reproduces the exact loop bodies from prisma/seed.ts against
 * self-contained, freshly created test rows (never touching real seeded
 * roles), so it's safe to run against any environment and needs no revert of
 * real data.
 *
 * Tests:
 *  1. RolePermission bootstrap-once: a role that already has rows (simulating
 *     "seeded before, admin removed one permission since") is skipped
 *     entirely on re-seed — the removed permission is NOT recreated.
 *  2. A role with zero rows (simulating "never seeded yet") still gets its
 *     full default set created — the bootstrap guard doesn't break first-run
 *     seeding.
 *  3. CustomRole non-destructive upsert: an admin-renamed built-in-style role
 *     keeps its admin-given name/description after the seed's upsert runs
 *     again with the original hardcoded values (`update: {}`).
 *     — Skipped with a clear message if the isActive migration hasn't been
 *     applied yet (CustomRole rows can't round-trip through Prisma's default
 *     select until then); the RolePermission tests above don't depend on it
 *     and always run.
 *
 * Usage: npx tsx scripts/test-seed-non-destructive.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { RoleScope } from "@prisma/client";

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

/** The exact bootstrap-once loop body from prisma/seed.ts's Role-Permission Mappings step. */
async function runRolePermissionSeedLoop(roleKey: string, permKeys: string[]) {
  const existingCount = await prisma.rolePermission.count({ where: { roleKey } });
  if (existingCount > 0) return;
  for (const permKey of permKeys) {
    const perm = await prisma.permission.findUnique({ where: { key: permKey } });
    if (!perm) continue;
    await prisma.rolePermission.upsert({
      where: { roleKey_permissionId: { roleKey, permissionId: perm.id } },
      update: {},
      create: { roleKey, permissionId: perm.id },
    });
  }
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

  const alreadySeededRoleKey = `TEST_ALREADY_SEEDED_${RUN_ID}`;
  const neverSeededRoleKey = `TEST_NEVER_SEEDED_${RUN_ID}`;
  let simulatedBuiltinRole: { id: string; key: string } | undefined;

  try {
    console.log("\nTesting RolePermission bootstrap-once guard...\n");
    const [permA, permB] = await Promise.all([
      prisma.permission.findUnique({ where: { key: "ticket.view" } }),
      prisma.permission.findUnique({ where: { key: "ticket.create" } }),
    ]);
    check("ticket.view and ticket.create are seeded", !!permA && !!permB);
    if (permA && permB) {
      // Simulate "seeded before, then an admin removed ticket.create" —
      // only ticket.view remains.
      await prisma.rolePermission.create({ data: { roleKey: alreadySeededRoleKey, permissionId: permA.id } });

      await runRolePermissionSeedLoop(alreadySeededRoleKey, [permA.key, permB.key]);

      const stillOnlyOne = await prisma.rolePermission.count({ where: { roleKey: alreadySeededRoleKey } });
      check("Bootstrap-once guard skips a role that already has rows (removed permission NOT recreated)", stillOnlyOne === 1);
      const recreated = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey: alreadySeededRoleKey, permissionId: permB.id } },
      });
      check("The specifically-removed permission (ticket.create) stays absent", recreated === null);

      console.log("\nTesting the bootstrap guard doesn't break first-run seeding...\n");
      await runRolePermissionSeedLoop(neverSeededRoleKey, [permA.key, permB.key]);
      const freshCount = await prisma.rolePermission.count({ where: { roleKey: neverSeededRoleKey } });
      check("A role with zero prior rows gets its full default set created on first run", freshCount === 2);
    }

    console.log("\nTesting CustomRole non-destructive upsert (update: {})...\n");
    try {
      await prisma.customRole.findFirst({ select: { id: true, isActive: true } });
    } catch (err) {
      console.log(
        "CustomRole.isActive isn't usable against this database yet (migration " +
          "20260723090000_add_custom_role_is_active not applied) — skipping this sub-test. " +
          "Run `npx prisma migrate deploy` (or `migrate dev`) first."
      );
      console.log(String(err instanceof Error ? err.message : err));
      printSummaryAndExit();
      return;
    }

    const originalSeedData = {
      key: `TEST_BUILTIN_SIM_${RUN_ID}`,
      name: "Original Seed Name",
      description: "Original seed description",
      isBuiltIn: true,
      scope: RoleScope.GLOBAL,
    };
    simulatedBuiltinRole = await prisma.customRole.create({
      data: originalSeedData,
      select: { id: true, key: true },
    });

    // Simulate an admin renaming/redescribing this built-in role via
    // PATCH /api/admin/roles/[id] after it was first seeded.
    await prisma.customRole.update({
      where: { id: simulatedBuiltinRole.id },
      data: { name: "Admin Renamed Role", description: "Admin-written description" },
    });

    // Re-run the exact seed upsert with the ORIGINAL hardcoded seed values —
    // this is what a later `db:seed` run does.
    await prisma.customRole.upsert({
      where: { key: originalSeedData.key },
      update: {},
      create: originalSeedData,
    });

    const afterReseed = await prisma.customRole.findUnique({
      where: { id: simulatedBuiltinRole.id },
      select: { name: true, description: true },
    });
    check(
      "Admin-renamed built-in role's name is NOT reverted by re-seeding",
      afterReseed?.name === "Admin Renamed Role"
    );
    check(
      "Admin-written description is NOT reverted by re-seeding",
      afterReseed?.description === "Admin-written description"
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      [
        "rolePermissions",
        () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: [alreadySeededRoleKey, neverSeededRoleKey] } } }),
      ],
      [
        "customRole",
        () => (simulatedBuiltinRole ? prisma.customRole.deleteMany({ where: { id: simulatedBuiltinRole.id } }) : Promise.resolve()),
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
