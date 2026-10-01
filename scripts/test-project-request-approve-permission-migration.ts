/**
 * Regression coverage for prisma/migrations/20260930141900_add_project_request_approve_permission
 * — the production migration that makes `projectRequest.approve`'s
 * existence AND its ADMIN-only default grant independent of `prisma db
 * seed`/application-runtime initialization. Same production-safe pattern as
 * 20260915110000_add_gantt_view_permission and
 * 20260929100000_add_category_create_permission.
 *
 * Unlike gantt.view/category.create, this is a genuinely BRAND NEW feature
 * with no prior implicit reachability for ANY role — so this migration
 * intentionally backfills ONLY ADMIN (cosmetic), never any other built-in
 * role, and never any pre-existing custom role (no "already had X" backfill
 * clause at all, unlike the other two).
 *
 * This test does NOT trust "the migration already ran once" — it directly
 * re-executes the migration's own raw SQL, then restores the exact prior
 * state in `finally`.
 *
 * Usage: npx tsx scripts/test-project-request-approve-permission-migration.ts
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

const MIGRATION_PATH = path.join(process.cwd(), "prisma", "migrations", "20260930141900_add_project_request_approve_permission", "migration.sql");
const DESCRIPTION_UPDATE_MIGRATION_PATH = path.join(process.cwd(), "prisma", "migrations", "20260930150000_update_project_request_approve_description", "migration.sql");

function loadMigrationStatementsFrom(migrationPath: string): string[] {
  const raw = fs.readFileSync(migrationPath, "utf8");
  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function loadMigrationStatements(): string[] {
  return loadMigrationStatementsFrom(MIGRATION_PATH);
}

async function runSqlStatements(statements: string[]): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 30_000 }
  );
}

async function runDescriptionUpdateMigrationSql(): Promise<void> {
  const statements = loadMigrationStatementsFrom(DESCRIPTION_UPDATE_MIGRATION_PATH);
  check("(sanity) the description-update migration has exactly 1 top-level SQL statement (a single UPDATE)", statements.length === 1);
  await runSqlStatements(statements);
}

async function runMigrationSql(): Promise<void> {
  const statements = loadMigrationStatements();
  check("(sanity) migration file has exactly 2 top-level SQL statements (Permission insert, ADMIN grant)", statements.length === 2);
  await prisma.$transaction(
    async (tx) => {
      for (const stmt of statements) {
        await tx.$executeRawUnsafe(stmt);
      }
    },
    { timeout: 30_000 }
  );
}

const OTHER_BUILT_IN_ROLE_KEYS = ["IT_AGENT", "DEPARTMENT_MANAGER", "USER", "DIRECTOR", "DEPARTMENT_ADMIN", "PROJECT_MANAGER", "AGENT_ASSIGNEE", "REQUESTER", "VIEWER"];

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

  const priorPermission = await prisma.permission.findUnique({ where: { key: "projectRequest.approve" } });
  const priorGrantRoleKeys = priorPermission
    ? (await prisma.rolePermission.findMany({ where: { permissionId: priorPermission.id }, select: { roleKey: true } })).map((g) => g.roleKey).sort()
    : [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `PRAPPROVE_MIG_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
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
    console.log("\n=== Fresh database: projectRequest.approve does not exist at all ===\n");

    // Pre-existing custom roles with unrelated permissions — must NOT be
    // touched, unlike gantt.view/category.create's own backfill (this new
    // feature has no "already had implicit reachability" precedent to
    // preserve).
    const preExistingRole = await makeCustomRole("PREEXISTING", RoleScope.GLOBAL, ["project.edit", "project.view"]);

    if (priorPermission) {
      await prisma.permission.delete({ where: { key: "projectRequest.approve" } });
    }
    check("Fixture: projectRequest.approve does not exist", (await prisma.permission.findUnique({ where: { key: "projectRequest.approve" } })) === null);

    console.log("\nRunning the migration's actual SQL against a totally fresh catalogue...\n");
    await runMigrationSql();

    const perm = await prisma.permission.findUnique({ where: { key: "projectRequest.approve" } });
    check("projectRequest.approve Permission row created", perm !== null);
    check("Correct module ('projectRequests')", perm?.module === "projectRequests");
    check("Correct description", perm?.description === "Give final (system) approval on Project Requests");

    const grants = (await prisma.rolePermission.findMany({ where: { permissionId: perm!.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("ADMIN is granted projectRequest.approve", grants.includes("ADMIN"));
    check("Exactly ONE role is granted (ADMIN only) — no other built-in role", grants.length === 1 && OTHER_BUILT_IN_ROLE_KEYS.every((k) => !grants.includes(k)));
    check("A pre-existing custom role with project.edit/project.view (unrelated permissions) is NOT backfilled — this new feature has no implicit-reachability precedent to preserve", !grants.includes(preExistingRole.key));

    const countBefore = await prisma.rolePermission.count({ where: { permissionId: perm!.id } });
    console.log("\nRe-running the SAME migration SQL a second time (idempotency)...\n");
    await runMigrationSql();
    const countAfter = await prisma.rolePermission.count({ where: { permissionId: perm!.id } });
    check("Re-running the migration inserts zero additional RolePermission rows", countBefore === countAfter);
    check("Re-running the migration inserts zero additional Permission rows", (await prisma.permission.count({ where: { key: "projectRequest.approve" } })) === 1);

    console.log("\n=== An administrator's LATER grant to another role survives a second migration run (never reverted) ===\n");
    const managerRole = await prisma.customRole.findFirst({ where: { key: "DEPARTMENT_MANAGER" } });
    void managerRole;
    // Simulate: an admin manually grants this to a custom role via /admin/roles.
    await prisma.rolePermission.create({ data: { roleKey: preExistingRole.key, permissionId: perm!.id } });
    await runMigrationSql();
    const grantsAfterManualAssign = (await prisma.rolePermission.findMany({ where: { permissionId: perm!.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("The manually-granted custom role STILL holds it after re-running the migration (never reverted by this file)", grantsAfterManualAssign.includes(preExistingRole.key));

    console.log("\n=== 20260930150000_update_project_request_approve_description: realigns the description to name both Approve AND Reject ===\n");
    check("Precondition: description is still the ORIGINAL (approval-only) wording from the first migration", (await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } })).description === "Give final (system) approval on Project Requests");
    await runDescriptionUpdateMigrationSql();
    const realigned = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    check("Description now explicitly names BOTH approval and rejection/decline", realigned.description === "Give final (system) approval or rejection on Project Requests");
    check("The permission's key/module are untouched by this description-only migration", realigned.key === "projectRequest.approve" && realigned.module === "projectRequests");
    const grantsAfterDescriptionUpdate = (await prisma.rolePermission.findMany({ where: { permissionId: realigned.id }, select: { roleKey: true } })).map((g) => g.roleKey);
    check("...and every existing RolePermission grant (ADMIN + the manually-assigned custom role) survives untouched", grantsAfterDescriptionUpdate.includes("ADMIN") && grantsAfterDescriptionUpdate.includes(preExistingRole.key));

    console.log("\nRe-running the description-update migration a second time (idempotency)...\n");
    await runDescriptionUpdateMigrationSql();
    const realignedAgain = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    check("Re-running it changes nothing further — description stays exactly the same", realignedAgain.description === realigned.description);
  } finally {
    console.log("\nRestoring projectRequest.approve to its exact prior production state...\n");
    try {
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });

      if (priorPermission) {
        const perm = await prisma.permission.upsert({
          where: { key: "projectRequest.approve" },
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
        await prisma.permission.deleteMany({ where: { key: "projectRequest.approve" } });
      }
    } catch (err) {
      console.error("RESTORE FAILED — manually verify projectRequest.approve's grants:", err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
