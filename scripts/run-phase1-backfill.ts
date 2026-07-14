/**
 * Runs prisma/migrations/20260714120000_add_department_workspace_model/backfill.sql
 * via Prisma instead of psql — for local setups without the Postgres CLI
 * client installed. Executes the exact same statements, in the same order,
 * inside one transaction. Safe to re-run: every step only touches rows that
 * still need it.
 *
 * Usage: npx tsx scripts/run-phase1-backfill.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Running Phase 1 backfill...");

  await prisma.$transaction(async (tx) => {
    // 1. Default existing Ticket/Project/ProjectActivity rows to IT.
    const tickets = await tx.$executeRawUnsafe(
      `UPDATE "Ticket" SET "departmentId" = 'dept-it' WHERE "departmentId" IS NULL;`
    );
    console.log(`  Tickets backfilled to dept-it: ${tickets}`);

    const projects = await tx.$executeRawUnsafe(
      `UPDATE "Project" SET "departmentId" = 'dept-it' WHERE "departmentId" IS NULL;`
    );
    console.log(`  Projects backfilled to dept-it: ${projects}`);

    const activitiesFromProject = await tx.$executeRawUnsafe(`
      UPDATE "ProjectActivity" pa
      SET "departmentId" = p."departmentId"
      FROM "Project" p
      WHERE pa."projectId" = p."id"
        AND pa."departmentId" IS NULL
        AND p."departmentId" IS NOT NULL;
    `);
    console.log(`  Activities inherited department from their project: ${activitiesFromProject}`);

    const activitiesFallback = await tx.$executeRawUnsafe(
      `UPDATE "ProjectActivity" SET "departmentId" = 'dept-it' WHERE "departmentId" IS NULL;`
    );
    console.log(`  Remaining activities backfilled to dept-it: ${activitiesFallback}`);

    // 2. One DepartmentMembership per existing user with a home department.
    const memberships = await tx.$executeRawUnsafe(`
      INSERT INTO "DepartmentMembership"
        ("id", "userId", "departmentId", "role", "source", "isPrimary", "isActive", "createdAt", "updatedAt")
      SELECT
        md5(u."id" || '-department-membership-backfill'),
        u."id",
        u."departmentId",
        CASE
          WHEN u."role" = 'DEPARTMENT_MANAGER' THEN 'DEPARTMENT_MANAGER'
          WHEN u."role" = 'IT_AGENT' THEN 'AGENT_ASSIGNEE'
          ELSE 'REQUESTER'
        END::"DepartmentRole",
        'MANUAL'::"MembershipSource",
        true,
        true,
        now(),
        now()
      FROM "User" u
      WHERE u."departmentId" IS NOT NULL
        AND u."role" != 'ADMIN'
        AND NOT EXISTS (
          SELECT 1 FROM "DepartmentMembership" dm
          WHERE dm."userId" = u."id" AND dm."departmentId" = u."departmentId"
        );
    `);
    console.log(`  Department memberships created: ${memberships}`);

    // 3. Human-friendly slugs for the 5 known bootstrap departments.
    const slugs: [string, string][] = [
      ["dept-it", "it"],
      ["dept-hr", "hr"],
      ["dept-finance", "finance"],
      ["dept-sales", "sales"],
      ["dept-operations", "operations"],
    ];
    for (const [id, slug] of slugs) {
      await tx.$executeRawUnsafe(`UPDATE "Department" SET "slug" = $1 WHERE "id" = $2;`, slug, id);
    }
    console.log("  Bootstrap department slugs set.");
  });

  console.log("✓ Backfill complete.");

  // Verification — mirrors the commented queries at the bottom of backfill.sql
  const [openTickets, openProjects, openActivities, byRole] = await Promise.all([
    prisma.ticket.count({ where: { departmentId: null } }),
    prisma.project.count({ where: { departmentId: null } }),
    prisma.projectActivity.count({ where: { departmentId: null } }),
    prisma.departmentMembership.groupBy({ by: ["role"], _count: true }),
  ]);
  console.log("\nVerification:");
  console.log(`  Tickets still with no department (expect 0): ${openTickets}`);
  console.log(`  Projects still with no department (expect 0): ${openProjects}`);
  console.log(`  Activities still with no department (expect 0): ${openActivities}`);
  console.log("  Memberships by role:", byRole);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
