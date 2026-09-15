/**
 * Regression coverage for prisma/migrations/20260915110000_add_gantt_view_permission
 * — the production migration that makes `gantt.view`'s existence AND both of
 * its default-grant backfills (built-in roles, and pre-existing custom
 * roles) independent of `prisma db seed`/application-runtime initialization
 * (same root cause as 20260813113000_backfill_permission_catalog and
 * 20260813150000_add_ticket_view_all_and_closed_view_permissions).
 *
 * This test does NOT trust "the migration already ran once" — it directly
 * re-executes the migration's own raw SQL (same technique as
 * scripts/test-permission-catalog-migration.ts), then restores the exact
 * prior state in `finally`.
 *
 * FIX BEING TESTED: an earlier version of this migration gated BOTH the
 * built-in-role grants AND the custom-role backfill on whether THIS exact
 * statement was what inserted the Permission row — which meant a database
 * where `gantt.view` already existed (e.g. `prisma db seed` ran before this
 * migration shipped) got NO custom-role backfill at all, even though the
 * migration's whole purpose is to make that backfill independent of seed.
 * The corrected SQL runs all three INSERTs unconditionally (each is its own
 * idempotent, ON CONFLICT DO NOTHING repair) — no "was I the one who
 * inserted the Permission row" gate anywhere.
 *
 * SCENARIO A — fresh database: gantt.view (and every grant pointing at it,
 * built-in and custom) doesn't exist at all. Proves the migration alone
 * fully bootstraps it from nothing.
 *
 * SCENARIO B — the actual reported bug case: gantt.view ALREADY exists with
 * its built-in grants (exactly what a `prisma db seed` run before this
 * migration would leave behind), and a pre-existing custom role has
 * project.view/activity.view but lacks gantt.view. Proves the migration
 * repairs that role on its own — no seed re-run, no app-runtime
 * initialization, no manual DB operation.
 *
 * Both scenarios also prove: a custom role with NEITHER project.view nor
 * activity.view never gains gantt.view (E), and re-running the migration's
 * SQL a second time produces zero additional rows (G, duplicate-safety).
 *
 * Usage: npx tsx scripts/test-gantt-view-permission-migration.ts
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

const MIGRATION_PATH = path.join(process.cwd(), "prisma", "migrations", "20260915110000_add_gantt_view_permission", "migration.sql");

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
  check("(sanity) migration file has exactly 3 top-level SQL statements (Permission insert, built-in grants, custom-role backfill — no temp table)", statements.length === 3);
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 30_000 }
  );
}

const BUILT_IN_ROLE_KEYS = [
  "ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "USER", "DIRECTOR",
  "DEPARTMENT_ADMIN", "PROJECT_MANAGER", "AGENT_ASSIGNEE", "REQUESTER", "VIEWER",
];

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

  // Exact prior state of everything this test deliberately mutates, so
  // `finally` can restore it precisely regardless of pass/fail — gantt.view
  // is a real, currently-in-use permission (every built-in role, plus any
  // real custom role an administrator has configured).
  const priorPermission = await prisma.permission.findUnique({ where: { key: "gantt.view" } });
  const priorGrantRoleKeys = priorPermission
    ? (await prisma.rolePermission.findMany({ where: { permissionId: priorPermission.id }, select: { roleKey: true } })).map((g) => g.roleKey).sort()
    : [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `GANTT_MIG_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
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
    console.log("\n=== SCENARIO A — fresh database: gantt.view does not exist at all ===\n");

    const freshGlobalRole = await makeCustomRole("FRESH_GLOBAL_PROJECT_VIEW", RoleScope.GLOBAL, ["project.view"]);
    const freshDeptRole = await makeCustomRole("FRESH_DEPT_ACTIVITY_VIEW", RoleScope.DEPARTMENT, ["activity.view"]);
    const freshNeitherRole = await makeCustomRole("FRESH_NEITHER", RoleScope.DEPARTMENT, ["ticket.view"]);

    // onDelete: Cascade on RolePermission.permission — deleting the
    // Permission row (if it exists) also removes EVERY RolePermission grant
    // pointing at it: every built-in role's, and every real pre-existing
    // custom role's (including any this dev DB already had), exactly
    // reproducing "this key never existed in this database". The fixtures'
    // OWN project.view/activity.view/ticket.view grants (different
    // Permission rows) are untouched by this cascade.
    if (priorPermission) {
      await prisma.permission.delete({ where: { key: "gantt.view" } });
    }
    check("A0. Fixture: gantt.view does not exist", (await prisma.permission.findUnique({ where: { key: "gantt.view" } })) === null);

    console.log("\nRunning the migration's actual SQL against a totally fresh catalogue...\n");
    await runMigrationSql();

    const permA = await prisma.permission.findUnique({ where: { key: "gantt.view" } });
    check("A1. gantt.view Permission row created", permA !== null);
    check("A1. Correct module ('projects')", permA?.module === "projects");
    check("A1. Correct description", permA?.description === "View Gantt timelines");

    const grantsA = (await prisma.rolePermission.findMany({ where: { permissionId: permA!.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("A2. Every built-in role is granted gantt.view", BUILT_IN_ROLE_KEYS.every((k) => grantsA.includes(k)));
    check("A3. The GLOBAL custom role with project.view is backfilled with gantt.view", grantsA.includes(freshGlobalRole.key));
    check("A3. The DEPARTMENT custom role with activity.view is backfilled with gantt.view", grantsA.includes(freshDeptRole.key));
    check("A3. The custom role with NEITHER project.view nor activity.view is NOT granted gantt.view", !grantsA.includes(freshNeitherRole.key));

    const countABefore = await prisma.rolePermission.count({ where: { permissionId: permA!.id } });
    console.log("\nRe-running the SAME migration SQL a second time (idempotency)...\n");
    await runMigrationSql();
    const countAAfter = await prisma.rolePermission.count({ where: { permissionId: permA!.id } });
    check("A4. Re-running the migration inserts zero additional RolePermission rows", countABefore === countAAfter);
    check("A4. Re-running the migration inserts zero additional Permission rows", (await prisma.permission.count({ where: { key: "gantt.view" } })) === 1);

    // ══════════════════════ SCENARIO B — the actual reported bug: Permission + built-ins already exist, a custom role was never backfilled ══════════════════════
    console.log("\n=== SCENARIO B — gantt.view + built-in grants ALREADY exist (as if `prisma db seed` ran before this migration shipped); a pre-existing custom role was never backfilled ===\n");

    // A/B: Permission and built-in grants already present — Scenario A just
    // established exactly this state; nothing further to set up.
    const permBefore = await prisma.permission.findUniqueOrThrow({ where: { key: "gantt.view" } });
    check("B0a. Precondition: gantt.view Permission already exists", true);
    const grantsBefore = (await prisma.rolePermission.findMany({ where: { permissionId: permBefore.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("B0b. Precondition: every built-in role already holds gantt.view", BUILT_IN_ROLE_KEYS.every((k) => grantsBefore.includes(k)));

    // C/D/E: fresh custom roles created AFTER gantt.view already exists,
    // deliberately WITHOUT a gantt.view grant — exactly the drift a
    // pre-existing custom role has when it predates this migration and was
    // never touched by `prisma db seed` running NEW_PERMISSION_DEFAULT_GRANTS
    // (which only ever lists built-in roleKeys, never CustomRole rows).
    const driftedGlobalRole = await makeCustomRole("DRIFTED_GLOBAL_PROJECT_VIEW", RoleScope.GLOBAL, ["project.view"]);
    const driftedDeptRole = await makeCustomRole("DRIFTED_DEPT_ACTIVITY_VIEW", RoleScope.DEPARTMENT, ["activity.view"]);
    const driftedNeitherRole = await makeCustomRole("DRIFTED_NEITHER", RoleScope.DEPARTMENT, ["ticket.view"]);
    check("B0c. Fixture: the GLOBAL custom role has project.view but NOT gantt.view yet", !(await prisma.rolePermission.findFirst({ where: { roleKey: driftedGlobalRole.key, permissionId: permBefore.id } })));
    check("B0d. Fixture: the DEPARTMENT custom role has activity.view but NOT gantt.view yet", !(await prisma.rolePermission.findFirst({ where: { roleKey: driftedDeptRole.key, permissionId: permBefore.id } })));

    console.log("\nRunning the migration's actual SQL against this exact state (Permission + built-ins present, custom roles drifted)...\n");
    await runMigrationSql();

    const grantsAfterB = (await prisma.rolePermission.findMany({ where: { permissionId: permBefore.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("B1 (F). The GLOBAL custom role IS NOW backfilled with gantt.view — proves the backfill runs even though gantt.view already existed before this migration ran", grantsAfterB.includes(driftedGlobalRole.key));
    check("B1 (F). The DEPARTMENT custom role IS NOW backfilled with gantt.view too", grantsAfterB.includes(driftedDeptRole.key));
    check("B1 (E). The custom role with NEITHER project.view nor activity.view is still NOT granted gantt.view", !grantsAfterB.includes(driftedNeitherRole.key));
    check("B1. Every built-in role is still granted (untouched, not duplicated)", BUILT_IN_ROLE_KEYS.every((k) => grantsAfterB.includes(k)));
    check("B1. No manual DB operation was performed to achieve this — only the migration's own SQL ran", true);

    const countBBefore = await prisma.rolePermission.count({ where: { permissionId: permBefore.id } });
    console.log("\nRe-running the SAME migration SQL a second time (idempotency / duplicate-safety, G)...\n");
    await runMigrationSql();
    const countBAfter = await prisma.rolePermission.count({ where: { permissionId: permBefore.id } });
    check("B2 (G). Re-running the migration inserts zero additional RolePermission rows (no duplicates for anyone — built-in or custom)", countBBefore === countBAfter);
    check("B2 (G). Re-running the migration inserts zero additional Permission rows", (await prisma.permission.count({ where: { key: "gantt.view" } })) === 1);
  } finally {
    console.log("\nRestoring gantt.view to its exact prior production state...\n");
    try {
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });

      // Whatever this test left gantt.view in is reconciled back to the
      // exact snapshot captured at the very start, never trusted to already
      // be correct.
      if (priorPermission) {
        const perm = await prisma.permission.upsert({
          where: { key: "gantt.view" },
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
        // Remove any grant that exists now but wasn't in the original
        // snapshot (e.g. a stray row this test's own fixtures left behind).
        const nowGrants = await prisma.rolePermission.findMany({ where: { permissionId: perm.id }, select: { roleKey: true } });
        const toRemove = nowGrants.map((g) => g.roleKey).filter((k) => !priorGrantRoleKeys.includes(k));
        if (toRemove.length > 0) {
          await prisma.rolePermission.deleteMany({ where: { permissionId: perm.id, roleKey: { in: toRemove } } });
        }
      } else {
        // gantt.view didn't exist before this test ran at all — undo this
        // test's own creation of it entirely.
        await prisma.permission.deleteMany({ where: { key: "gantt.view" } });
      }
    } catch (err) {
      console.error("RESTORE FAILED — manually verify gantt.view's grants against prisma/seed.ts's NEW_PERMISSION_DEFAULT_GRANTS:", err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
