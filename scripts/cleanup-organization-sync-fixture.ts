/**
 * Removes all data created by scripts/simulate-organization-sync-fixture.ts
 * runs: fixture users (microsoftUserId prefixed "orgfixture-"), the
 * companies/departments that were created ONLY to hold them (verified empty
 * of any non-fixture user before deletion), and their starter
 * TicketPriority/TicketStatus rows. Never touches the real pre-existing
 * Kinsen company/business-unit/department data.
 *
 * Usage: npx tsx scripts/cleanup-organization-sync-fixture.ts
 */
import { prisma } from "@/lib/prisma";

async function main() {
  const users = await prisma.user.findMany({ where: { microsoftUserId: { startsWith: "orgfixture-" } }, select: { id: true, email: true } });
  console.log(`Deleting ${users.length} fixture users:`, users.map((u) => u.email));
  if (users.length > 0) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });

  // Fixture-only companies: created fresh by the fixture runs, never pre-existing.
  const fixtureCompanyNames = ["Kinsen Austria", "Saracakis", "Unassigned", "Kinsen Logistics"];
  const fixtureCompanies = await prisma.company.findMany({ where: { name: { in: fixtureCompanyNames } }, select: { id: true, name: true } });

  // Direct-Company departments under the REAL Kinsen that only the fixture
  // could have created (confirmed via pre-sync-inventory.json: Kinsen had
  // directDepartments: 0 before any fixture run — every BusinessUnit-nested
  // legacy department there is untouched and excluded here).
  const kinsenDirectFixtureDeptNames = ["IT", "Sales", "Unassigned", "Marketing"];
  const realKinsen = await prisma.company.findUnique({ where: { normalizedName: "kinsen" }, select: { id: true } });

  const deptWhere = {
    OR: [
      { companyId: { in: fixtureCompanies.map((c) => c.id) } },
      ...(realKinsen ? [{ companyId: realKinsen.id, name: { in: kinsenDirectFixtureDeptNames } }] : []),
    ],
  };
  const depts = await prisma.department.findMany({ where: deptWhere, select: { id: true, name: true, companyId: true, _count: { select: { users: true } } } });
  const nonEmpty = depts.filter((d) => d._count.users > 0);
  if (nonEmpty.length > 0) {
    console.log("Refusing to delete non-empty departments (still has users after fixture-user deletion — investigate):", nonEmpty);
    process.exit(1);
  }
  const deptIds = depts.map((d) => d.id);
  console.log(`Deleting ${deptIds.length} fixture-only departments:`, depts.map((d) => d.name));

  await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
  await prisma.department.deleteMany({ where: { id: { in: deptIds } } });

  const companyIds = fixtureCompanies.map((c) => c.id);
  console.log(`Deleting ${companyIds.length} fixture companies:`, fixtureCompanies.map((c) => c.name));
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } });

  console.log("Cleanup complete.");
}

main().then(() => prisma.$disconnect());
