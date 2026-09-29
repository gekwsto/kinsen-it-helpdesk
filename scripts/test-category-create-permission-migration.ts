/**
 * Regression coverage for prisma/migrations/20260929100000_add_category_create_permission
 * — the production migration that makes `category.create`'s existence AND
 * both of its default-grant backfills (the 3 built-in roles that already
 * hold category.manage, and pre-existing custom roles) independent of
 * `prisma db seed`/application-runtime initialization. Same production-safe
 * pattern as 20260915110000_add_gantt_view_permission (see
 * scripts/test-gantt-view-permission-migration.ts, which this file mirrors
 * closely) and 20260813113000_backfill_permission_catalog.
 *
 * This test does NOT trust "the migration already ran once" — it directly
 * re-executes the migration's own raw SQL, then restores the exact prior
 * state in `finally`.
 *
 * SCENARIO A — fresh database: category.create doesn't exist at all. Proves
 * the migration alone fully bootstraps it from nothing, granting it to
 * exactly ADMIN/DEPARTMENT_MANAGER/DEPARTMENT_ADMIN (the 3 roles that
 * already hold category.manage) and to a custom role that already holds
 * category.manage — but NOT to a custom role that lacks category.manage,
 * and not to any OTHER built-in role (IT_AGENT/USER/DIRECTOR/etc. never had
 * category.manage, so this migration must not widen their access either).
 *
 * SCENARIO B — the actual precedent bug case: category.create ALREADY
 * exists with its built-in grants (exactly what a `prisma db seed` run
 * before this migration would leave behind), and a pre-existing custom role
 * has category.manage but lacks category.create. Proves the migration
 * repairs that role on its own.
 *
 * Both scenarios also prove: re-running the migration's SQL a second time
 * produces zero additional rows (idempotency).
 *
 * Usage: npx tsx scripts/test-category-create-permission-migration.ts
 */
import fs from "fs";
import path from "path";
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

const MIGRATION_PATH = path.join(process.cwd(), "prisma", "migrations", "20260929100000_add_category_create_permission", "migration.sql");

/** Same comment-stripping + top-level-semicolon-split technique as scripts/test-permission-catalog-migration.ts's loadMigrationStatements. */
function loadMigrationStatements(): string[] {
  const raw = fs.readFileSync(MIGRATION_PATH, "utf8");
  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigrationSql(): Promise<void> {
  const statements = loadMigrationStatements();
  check("(sanity) migration file has exactly 3 top-level SQL statements (Permission insert, built-in grants, custom-role backfill)", statements.length === 3);
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 30_000 }
  );
}

const BUILT_IN_ROLE_KEYS = ["ADMIN", "DEPARTMENT_MANAGER", "DEPARTMENT_ADMIN"];
const OTHER_BUILT_IN_ROLE_KEYS = ["IT_AGENT", "USER", "DIRECTOR", "PROJECT_MANAGER", "AGENT_ASSIGNEE", "REQUESTER", "VIEWER"];

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

  const priorPermission = await prisma.permission.findUnique({ where: { key: "category.create" } });
  const priorGrantRoleKeys = priorPermission
    ? (await prisma.rolePermission.findMany({ where: { permissionId: priorPermission.id }, select: { roleKey: true } })).map((g) => g.roleKey).sort()
    : [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `CATCREATE_MIG_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    // ══════════════════════ SCENARIO A — fresh database ══════════════════════
    console.log("\n=== SCENARIO A — fresh database: category.create does not exist at all ===\n");

    const freshManageRole = await makeCustomRole("FRESH_MANAGE", RoleScope.GLOBAL, ["category.manage"]);
    const freshDeptManageRole = await makeCustomRole("FRESH_DEPT_MANAGE", RoleScope.DEPARTMENT, ["category.manage"]);
    const freshNeitherRole = await makeCustomRole("FRESH_NEITHER", RoleScope.DEPARTMENT, ["category.delete"]);

    if (priorPermission) {
      await prisma.permission.delete({ where: { key: "category.create" } });
    }
    check("A0. Fixture: category.create does not exist", (await prisma.permission.findUnique({ where: { key: "category.create" } })) === null);

    console.log("\nRunning the migration's actual SQL against a totally fresh catalogue...\n");
    await runMigrationSql();

    const permA = await prisma.permission.findUnique({ where: { key: "category.create" } });
    check("A1. category.create Permission row created", permA !== null);
    check("A1. Correct module ('ticketConfig')", permA?.module === "ticketConfig");
    check("A1. Correct description", permA?.description === "Create ticket categories");

    const grantsA = (await prisma.rolePermission.findMany({ where: { permissionId: permA!.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("A2. Every one of the 3 roles that already hold category.manage is granted category.create", BUILT_IN_ROLE_KEYS.every((k) => grantsA.includes(k)));
    check("A2. No OTHER built-in role (never had category.manage) is granted category.create — access must not widen", OTHER_BUILT_IN_ROLE_KEYS.every((k) => !grantsA.includes(k)));
    check("A3. The GLOBAL custom role with category.manage is backfilled with category.create", grantsA.includes(freshManageRole.key));
    check("A3. The DEPARTMENT custom role with category.manage is backfilled with category.create", grantsA.includes(freshDeptManageRole.key));
    check("A3. The custom role with category.delete but NOT category.manage is NOT granted category.create (create/delete stay independent)", !grantsA.includes(freshNeitherRole.key));

    const countABefore = await prisma.rolePermission.count({ where: { permissionId: permA!.id } });
    console.log("\nRe-running the SAME migration SQL a second time (idempotency)...\n");
    await runMigrationSql();
    const countAAfter = await prisma.rolePermission.count({ where: { permissionId: permA!.id } });
    check("A4. Re-running the migration inserts zero additional RolePermission rows", countABefore === countAAfter);
    check("A4. Re-running the migration inserts zero additional Permission rows", (await prisma.permission.count({ where: { key: "category.create" } })) === 1);

    // ══════════════════════ SCENARIO B — Permission + built-ins already exist, a custom role was never backfilled ══════════════════════
    console.log("\n=== SCENARIO B — category.create + built-in grants ALREADY exist; a pre-existing custom role was never backfilled ===\n");

    const permBefore = await prisma.permission.findUniqueOrThrow({ where: { key: "category.create" } });
    const grantsBefore = (await prisma.rolePermission.findMany({ where: { permissionId: permBefore.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("B0. Precondition: every one of the 3 roles already holds category.create", BUILT_IN_ROLE_KEYS.every((k) => grantsBefore.includes(k)));

    const driftedManageRole = await makeCustomRole("DRIFTED_MANAGE", RoleScope.GLOBAL, ["category.manage"]);
    const driftedNeitherRole = await makeCustomRole("DRIFTED_NEITHER", RoleScope.DEPARTMENT, ["category.delete"]);
    check("B0. Fixture: the drifted custom role has category.manage but NOT category.create yet", !(await prisma.rolePermission.findFirst({ where: { roleKey: driftedManageRole.key, permissionId: permBefore.id } })));

    console.log("\nRunning the migration's actual SQL against this exact state (Permission + built-ins present, custom role drifted)...\n");
    await runMigrationSql();

    const grantsAfterB = (await prisma.rolePermission.findMany({ where: { permissionId: permBefore.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("B1. The drifted custom role IS NOW backfilled with category.create — proves the backfill runs even though category.create already existed before this migration ran", grantsAfterB.includes(driftedManageRole.key));
    check("B1. The custom role with only category.delete is still NOT granted category.create", !grantsAfterB.includes(driftedNeitherRole.key));
    check("B1. Every built-in role is still granted (untouched, not duplicated)", BUILT_IN_ROLE_KEYS.every((k) => grantsAfterB.includes(k)));

    const countBBefore = await prisma.rolePermission.count({ where: { permissionId: permBefore.id } });
    console.log("\nRe-running the SAME migration SQL a second time (idempotency / duplicate-safety)...\n");
    await runMigrationSql();
    const countBAfter = await prisma.rolePermission.count({ where: { permissionId: permBefore.id } });
    check("B2. Re-running the migration inserts zero additional RolePermission rows", countBBefore === countBAfter);
    check("B2. Re-running the migration inserts zero additional Permission rows", (await prisma.permission.count({ where: { key: "category.create" } })) === 1);
  } finally {
    console.log("\nRestoring category.create to its exact prior production state...\n");
    try {
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });

      if (priorPermission) {
        const perm = await prisma.permission.upsert({
          where: { key: "category.create" },
          update: { description: priorPermission.description, module: priorPermission.module },
          create: { key: priorPermission.key, description: priorPermission.description, module: priorPermission.module },
        });
        for (const roleKey of priorGrantRoleKeys) {
          await prisma.rolePermission.upsert({
            where: { roleKey_permissionId: { roleKey, permissionId: perm.id } },
            update: {},
            create: { roleKey, permissionId: perm.id },
          });
        }
        const nowGrants = await prisma.rolePermission.findMany({ where: { permissionId: perm.id }, select: { roleKey: true } });
        const toRemove = nowGrants.map((g) => g.roleKey).filter((k) => !priorGrantRoleKeys.includes(k));
        if (toRemove.length > 0) {
          await prisma.rolePermission.deleteMany({ where: { permissionId: perm.id, roleKey: { in: toRemove } } });
        }
      } else {
        await prisma.permission.deleteMany({ where: { key: "category.create" } });
      }
    } catch (err) {
      console.error("RESTORE FAILED — manually verify category.create's grants against prisma/seed.ts's TICKET_CONFIG_PERMISSION_KEYS/NEW_PERMISSION_DEFAULT_GRANTS:", err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
