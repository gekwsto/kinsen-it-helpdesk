/**
 * One-off, surgical backfill for a SINGLE Permission row (and its ADMIN
 * RolePermission grant) that got added to prisma/seed.ts's PERMISSIONS/
 * NEW_PERMISSION_DEFAULT_GRANTS arrays but never actually reached
 * production — because the full `npm run db:seed` run crashes earlier, at
 * its unrelated Department-seeding loop (a pre-existing production data
 * mismatch: some Department row already holds the configured support
 * inboundEmail under a different id than the seed script's hardcoded
 * "dept-it"). See the real crash this was written against:
 *
 *   PrismaClientKnownRequestError: Invalid `prisma.department.upsert()`
 *   invocation: Unique constraint failed on the fields: (`inboundEmail`)
 *
 * This script touches ONLY the Permission and RolePermission tables —
 * nothing else in the database, by design, specifically so it can be run
 * safely in production without reaching (or needing to fix) the Department
 * mismatch. It is NOT a replacement for `npm run db:seed`; it exists only
 * to unblock the one permission that mismatch was preventing from ever
 * being seeded. Idempotent (safe to re-run): both writes are upserts.
 *
 * Usage: npx tsx scripts/seed-missing-permission.ts
 */
import { prisma } from "@/lib/prisma";

const PERMISSION_KEY = "activity.dependency.manage";
const PERMISSION_DESCRIPTION = "Create and delete dependencies between activities";
const PERMISSION_MODULE = "activities";
const ROLE_KEY = "ADMIN";

async function main() {
  const permission = await prisma.permission.upsert({
    where: { key: PERMISSION_KEY },
    update: { description: PERMISSION_DESCRIPTION, module: PERMISSION_MODULE },
    create: { key: PERMISSION_KEY, description: PERMISSION_DESCRIPTION, module: PERMISSION_MODULE },
  });
  console.log(`✓ Permission "${PERMISSION_KEY}" present (id: ${permission.id})`);

  await prisma.rolePermission.upsert({
    where: { roleKey_permissionId: { roleKey: ROLE_KEY, permissionId: permission.id } },
    update: {},
    create: { roleKey: ROLE_KEY, permissionId: permission.id },
  });
  console.log(`✓ RolePermission (${ROLE_KEY}, "${PERMISSION_KEY}") present`);

  console.log("\nDone. Nothing else in the database was touched.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
