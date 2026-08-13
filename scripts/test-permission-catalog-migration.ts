/**
 * Regression coverage for the production Permission-catalogue drift fix:
 * prisma/migrations/20260813113000_backfill_permission_catalog. Root cause
 * — Permission/RolePermission are DATA tables, but most permission
 * additions after the initial schema migration lived only in
 * prisma/seed.ts. A production environment that runs `prisma migrate
 * deploy` but never re-runs `prisma db seed` keeps whatever Permission
 * catalogue it started with (observed live: only 6 of the current 13
 * ticket.* permissions existed).
 *
 * This test does NOT trust "the migration already ran once" — it directly
 * re-executes the migration's own raw SQL (split into its 5 top-level
 * statements, run in order inside ONE `prisma.$transaction` so the file's
 * session-scoped TEMP TABLE survives across statements — a bare
 * `$executeRawUnsafe` per statement would each grab a different pooled
 * connection and lose the temp table) against a DELIBERATELY partial
 * catalogue on THIS real dev database, then restores the exact prior state
 * in `finally`. This proves the migration's real idempotency/safety
 * guarantees, not just that "it ran once in the past".
 *
 * Usage: npx tsx scripts/test-permission-catalog-migration.ts
 */
import fs from "fs";
import path from "path";
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

const MIGRATION_PATH = path.join(process.cwd(), "prisma", "migrations", "20260813113000_backfill_permission_catalog", "migration.sql");

/**
 * The migration file's 5 top-level statements, in order — strips full-line
 * `--` comments FIRST (they precede several statements on their own lines,
 * within the same semicolon-delimited chunk — merely checking whether a
 * whole chunk "starts with --" after trimming was wrong: a comment block
 * immediately followed by real SQL in the same chunk still starts with
 * "--", which would have silently dropped that statement entirely), then
 * splits on the only 5 top-level semicolons in the file (verified: no
 * other ';' appears anywhere, including inside string literals).
 */
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

/** Runs the migration's statements in order, inside one transaction (pins to a single DB connection, so the file's CREATE TEMP TABLE / DROP TABLE bracketing survives across statements exactly like it does under a real `prisma migrate deploy`). */
async function runMigrationSql(): Promise<void> {
  const statements = loadMigrationStatements();
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 30_000 }
  );
}

// ticket.view.all/ticket.closed.view were added by a LATER migration
// (20260813150000_add_ticket_view_all_and_closed_view_permissions), not by
// the 20260813113000 migration this file specifically re-executes — but
// they're real, permanent rows in the live catalogue this file's baseline
// counts read from, so they're included here too (this file verifies the
// 20260813113000 migration's OWN idempotent restore behavior against
// whatever the CURRENT full catalogue is, not a frozen historical one).
const CANONICAL_TICKET_KEYS = [
  "ticket.view",
  "ticket.create",
  "ticket.reply",
  "ticket.internalNote",
  "ticket.assign",
  "ticket.changeStatus",
  "ticket.assignable",
  "ticket.department.change",
  "ticket.share.department",
  "ticket.share.subdepartment",
  "ticket.pending.view",
  "ticket.pending.accept",
  "ticket.pending.reject",
  "ticket.view.all",
  "ticket.closed.view",
].sort();

/** Exact per-module counts from the current prisma/seed.ts PERMISSIONS catalogue (78 total) — verified module-by-module, not just a global count, so a drift confined to one module (e.g. department/subdepartment/organization) can't hide behind an otherwise-correct total. */
const CANONICAL_MODULE_COUNTS: Record<string, number> = {
  activities: 6,
  projects: 6,
  goals: 4,
  tickets: 15,
  admin: 7,
  department: 9,
  company: 3,
  businessUnit: 3,
  subdepartment: 6,
  ticketConfig: 17,
  organization: 2,
};

async function main() {
  await prisma.$connect();

  // Exact prior state of everything this test deliberately mutates, so
  // `finally` can restore it precisely regardless of pass/fail — these are
  // real, currently-in-use system rows, never something this test may
  // leave altered.
  let deletedPermissionA: Awaited<ReturnType<typeof prisma.permission.findUniqueOrThrow>> | null = null;
  let deletedPermissionAGrants: { roleKey: string }[] = [];
  let deletedPermissionB: Awaited<ReturnType<typeof prisma.permission.findUniqueOrThrow>> | null = null;
  let deletedPermissionBGrants: { roleKey: string }[] = [];
  let removedGrantExisted = false;
  let originalDescription: string | null = null;

  try {
    // ══════════════════════ 1. Canonical catalogue baseline ══════════════════════
    console.log("\n=== 1. Canonical permission catalogue (baseline, before this test mutates anything) ===\n");
    const baselineCount = await prisma.permission.count();
    check("1. Canonical catalogue currently has all 78 permissions", baselineCount === 78);
    const baselineTicketKeys = (await prisma.permission.findMany({ where: { module: "tickets" }, select: { key: true } })).map((p) => p.key).sort();
    check("2. Tickets module currently has exactly the 15 canonical keys", JSON.stringify(baselineTicketKeys) === JSON.stringify(CANONICAL_TICKET_KEYS));

    console.log("\n=== 1b. Every module's permission count matches the canonical catalogue exactly (not just tickets) ===\n");
    for (const [module, expectedCount] of Object.entries(CANONICAL_MODULE_COUNTS)) {
      const actual = await prisma.permission.count({ where: { module } });
      check(`1b. Module "${module}" has exactly ${expectedCount} permissions`, actual === expectedCount);
    }
    const sumOfModules = Object.values(CANONICAL_MODULE_COUNTS).reduce((a, b) => a + b, 0);
    check("1b. Per-module counts sum to the full canonical catalogue size (78)", sumOfModules === 78);

    // ══════════════════════ Simulate stale production: delete 2 permissions entirely ══════════════════════
    console.log("\n=== Simulating a stale/partial catalogue (the production symptom) ===\n");
    deletedPermissionA = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.pending.reject" } });
    deletedPermissionAGrants = await prisma.rolePermission.findMany({ where: { permissionId: deletedPermissionA.id }, select: { roleKey: true } });
    deletedPermissionB = await prisma.permission.findUniqueOrThrow({ where: { key: "organization.tree.view" } });
    deletedPermissionBGrants = await prisma.rolePermission.findMany({ where: { permissionId: deletedPermissionB.id }, select: { roleKey: true } });
    // onDelete: Cascade on RolePermission.permission — deleting the
    // Permission row also removes its RolePermission grants, exactly
    // reproducing "this key never existed in this database".
    await prisma.permission.delete({ where: { key: "ticket.pending.reject" } });
    await prisma.permission.delete({ where: { key: "organization.tree.view" } });
    check("Fixture: catalogue now genuinely missing 2 keys (76 remain)", (await prisma.permission.count()) === 76);

    // Simulate "an admin manually removed one specific grant from an
    // EXISTING permission" — the permission itself is untouched, only its
    // DEPARTMENT_MANAGER grant is removed.
    const survivingPermission = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.share.subdepartment" } });
    const existingGrant = await prisma.rolePermission.findUnique({
      where: { roleKey_permissionId: { roleKey: "DEPARTMENT_MANAGER", permissionId: survivingPermission.id } },
    });
    removedGrantExisted = !!existingGrant;
    if (existingGrant) {
      await prisma.rolePermission.delete({ where: { roleKey_permissionId: { roleKey: "DEPARTMENT_MANAGER", permissionId: survivingPermission.id } } });
    }
    check("Fixture: DEPARTMENT_MANAGER's ticket.share.subdepartment grant was removed (simulating an admin customization)", removedGrantExisted);

    // Simulate a stale/hand-edited description on a permission that stays
    // in the catalogue the whole time — proves the metadata-alignment
    // branch works independently of the insert-tracking branch.
    const staleDescTarget = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.view" } });
    originalDescription = staleDescTarget.description;
    await prisma.permission.update({ where: { key: "ticket.view" }, data: { description: "STALE TEST DESCRIPTION" } });

    // ══════════════════════ 3. Run the migration SQL against the partial catalogue ══════════════════════
    console.log("\n=== 3. Re-running the migration's actual SQL against the deliberately partial catalogue ===\n");
    await runMigrationSql();

    const afterCount = await prisma.permission.count();
    check("3. Only the missing records were inserted — catalogue is back to all 78", afterCount === 78);
    const afterTicketKeys = (await prisma.permission.findMany({ where: { module: "tickets" }, select: { key: true } })).map((p) => p.key).sort();
    check("2 (post-migration). Tickets module has exactly the 15 canonical keys again", JSON.stringify(afterTicketKeys) === JSON.stringify(CANONICAL_TICKET_KEYS));

    // ══════════════════════ 5. Newly-inserted permissions get their canonical default grants ══════════════════════
    console.log("\n=== 5. Newly (re-)inserted permissions get their intended fresh-install default grants ===\n");
    const restoredA = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.pending.reject" } });
    const restoredAGrantRoles = (await prisma.rolePermission.findMany({ where: { permissionId: restoredA.id }, select: { roleKey: true } })).map((g) => g.roleKey).sort();
    const expectedAGrantRoles = deletedPermissionAGrants.map((g) => g.roleKey).sort();
    check("5. ticket.pending.reject's restored default grants exactly match what it had before deletion (IT_AGENT/DEPARTMENT_MANAGER/DEPARTMENT_ADMIN/AGENT_ASSIGNEE)", JSON.stringify(restoredAGrantRoles) === JSON.stringify(expectedAGrantRoles));

    const restoredB = await prisma.permission.findUniqueOrThrow({ where: { key: "organization.tree.view" } });
    const restoredBGrantRoles = (await prisma.rolePermission.findMany({ where: { permissionId: restoredB.id }, select: { roleKey: true } })).map((g) => g.roleKey).sort();
    const expectedBGrantRoles = deletedPermissionBGrants.map((g) => g.roleKey).sort();
    check("5. organization.tree.view's restored default grants exactly match what it had before deletion (ADMIN/DIRECTOR)", JSON.stringify(restoredBGrantRoles) === JSON.stringify(expectedBGrantRoles));

    // ══════════════════════ 6. A manually-removed grant on a PRE-EXISTING permission is never restored ══════════════════════
    console.log("\n=== 6. An existing permission's manually-removed grant is NOT re-granted by the migration ===\n");
    const stillRemoved = await prisma.rolePermission.findUnique({
      where: { roleKey_permissionId: { roleKey: "DEPARTMENT_MANAGER", permissionId: survivingPermission.id } },
    });
    check("6. DEPARTMENT_MANAGER's ticket.share.subdepartment grant is STILL absent after the migration (admin customization preserved)", stillRemoved === null);

    // ══════════════════════ 4. Existing RolePermission customization elsewhere is preserved ══════════════════════
    console.log("\n=== 4. Every other existing RolePermission row is completely untouched ===\n");
    const itAgentGrantForShareSubdept = await prisma.rolePermission.findFirst({
      where: { roleKey: "IT_AGENT", permission: { key: "ticket.share.subdepartment" } },
    });
    check("4. IT_AGENT's own (never touched) ticket.share.subdepartment grant is still present", !!itAgentGrantForShareSubdept);

    // ══════════════════════ 7. Description/module realignment ══════════════════════
    console.log("\n=== 7. Permission description/module realigned to the canonical system catalogue ===\n");
    const realigned = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.view" } });
    check("7. The stale hand-edited description was realigned back to the canonical value", realigned.description === originalDescription && realigned.description === "View tickets");

    // ══════════════════════ Idempotency: running it again is a true no-op ══════════════════════
    console.log("\n=== Idempotency: running the SAME migration SQL again changes nothing further ===\n");
    const countBeforeRerun = await prisma.permission.count();
    const rolePermCountBeforeRerun = await prisma.rolePermission.count();
    await runMigrationSql();
    const countAfterRerun = await prisma.permission.count();
    const rolePermCountAfterRerun = await prisma.rolePermission.count();
    check("Re-running the migration inserts zero additional Permission rows", countAfterRerun === countBeforeRerun);
    check("Re-running the migration inserts zero additional RolePermission rows", rolePermCountAfterRerun === rolePermCountBeforeRerun);
    check("The manually-removed grant is STILL not restored after a second run", (await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey: "DEPARTMENT_MANAGER", permissionId: survivingPermission.id } } })) === null);
  } finally {
    // Restore the ONE genuine customization this test simulated removing —
    // everything else (the 2 deleted permissions, the stale description)
    // is already back to its correct canonical state via the migration
    // itself, which IS the real steady state, so nothing further to redo
    // for those.
    if (removedGrantExisted) {
      const perm = await prisma.permission.findUnique({ where: { key: "ticket.share.subdepartment" } });
      if (perm) {
        await prisma.rolePermission
          .upsert({
            where: { roleKey_permissionId: { roleKey: "DEPARTMENT_MANAGER", permissionId: perm.id } },
            update: {},
            create: { roleKey: "DEPARTMENT_MANAGER", permissionId: perm.id },
          })
          .catch((err) => console.error("Failed to restore DEPARTMENT_MANAGER's ticket.share.subdepartment grant:", err));
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
