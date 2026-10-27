/**
 * Minimal, standalone production-safe alternative to `npm run db:seed` for
 * this one deployment: adds ONLY the `organization.sqlgeneralSync`
 * Permission row and grants it to the built-in ADMIN role — the exact two
 * writes `prisma/seed.ts` would eventually reach via its PERMISSIONS array
 * and NEW_PERMISSION_DEFAULT_GRANTS map, with nothing else in that script
 * touched. Needed because the full seed script also upserts the 5 bootstrap
 * Departments' `slug` field and 4 example MicrosoftDepartmentMapping rows'
 * departmentId/role/departmentRole unconditionally on every run — safe on a
 * fresh database, but a real overwrite risk on an existing production
 * database if an admin has since customized either of those (see the
 * SQLGeneral Preview Deployment Readiness report for the full inventory).
 *
 * Idempotent and safe to run any number of times: both writes are `upsert`
 * with an empty/no-op `update`, so re-running never changes anything that
 * already exists. Touches nothing else — no Users, no other permissions, no
 * Departments, no Companies, no mock/demo data of any kind.
 *
 * Usage: npx tsx scripts/add-sqlgeneral-permission.ts
 */
import { prisma } from "@/lib/prisma";

const PERMISSION_KEY = "organization.sqlgeneralSync";
const PERMISSION_DESCRIPTION = "Trigger a manual SQLGeneral per-user organization-sync refresh";
const PERMISSION_MODULE = "organization";
const ROLE_KEY = "ADMIN";

async function main() {
  const permission = await prisma.permission.upsert({
    where: { key: PERMISSION_KEY },
    update: {},
    create: { key: PERMISSION_KEY, description: PERMISSION_DESCRIPTION, module: PERMISSION_MODULE },
  });
  console.log(`✓ Permission "${PERMISSION_KEY}" present (id=${permission.id})`);

  await prisma.rolePermission.upsert({
    where: { roleKey_permissionId: { roleKey: ROLE_KEY, permissionId: permission.id } },
    update: {},
    create: { roleKey: ROLE_KEY, permissionId: permission.id },
  });
  console.log(`✓ RolePermission ${ROLE_KEY} -> "${PERMISSION_KEY}" present`);
  console.log("\nDone. No other table was touched.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
