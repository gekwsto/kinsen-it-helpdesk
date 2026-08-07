/**
 * Section 5 of the live audit: verifies every "change scenario" after
 * scripts/simulate-organization-sync-fixture.ts --pass=2 has been run on
 * top of pass 1's baseline.
 */
import { prisma } from "@/lib/prisma";

let passed = 0, failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

async function main() {
  const users = await prisma.user.findMany({
    where: { microsoftUserId: { startsWith: "orgfixture-" } },
    select: { microsoftUserId: true, jobTitle: true, companyId: true, departmentId: true, company: { select: { name: true } }, department: { select: { name: true, companyId: true } } },
  });
  const byId = new Map(users.map((u) => [u.microsoftUserId, u]));

  const jobTitleUser = byId.get("orgfixture-kinsen-it-1");
  check("Existing user's job title change is reflected", jobTitleUser?.jobTitle === "Senior IT Support Engineer");
  check("   ...same company/department (title-only change)", jobTitleUser?.company?.name === "Kinsen" && jobTitleUser?.department?.name === "IT");

  const deptMoveUser = byId.get("orgfixture-kinsen-sales-1");
  check("Existing user moved department WITHIN the same company (Kinsen: Sales -> IT)", deptMoveUser?.company?.name === "Kinsen" && deptMoveUser?.department?.name === "IT");

  const companyMoveUser = byId.get("orgfixture-austria-hr-1");
  check("Existing user moved to a DIFFERENT company entirely (Kinsen Austria -> Saracakis)", companyMoveUser?.company?.name === "Saracakis" && companyMoveUser?.department?.name === "Service");

  const lostPlacementUser = byId.get("orgfixture-saracakis-svc-1");
  check("Existing user who lost companyName/department moved to the correct (orphaned, non-persisted-company) Unassigned node", lostPlacementUser?.companyId === null && lostPlacementUser?.department?.name === "Unassigned" && lostPlacementUser?.department?.companyId === null);

  const newDeptUser = byId.get("orgfixture-kinsen-marketing-1");
  check("New department created under an EXISTING company with no code change (Kinsen: Marketing)", newDeptUser?.company?.name === "Kinsen" && newDeptUser?.department?.name === "Marketing");

  const newCompanyUser = byId.get("orgfixture-newco-1");
  check("Brand-new company appeared with no code change (Kinsen Logistics: Warehouse)", newCompanyUser?.company?.name === "Kinsen Logistics" && newCompanyUser?.department?.name === "Warehouse");

  const salesDept = await prisma.department.findFirst({ where: { name: "Sales", company: { normalizedName: "kinsen" } }, select: { id: true, _count: { select: { users: true } } } });
  check("Vacated 'Sales' department still exists (never destroyed, just emptied)", salesDept !== null && salesDept._count.users === 0);

  const crossCompanyManagerEdges = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint as count FROM "User" u
    JOIN "User" m ON u."managerId" = m."id"
    WHERE u."companyId" IS NOT NULL AND m."companyId" IS NOT NULL AND u."companyId" != m."companyId"
  `;
  check("No invalid cross-company manager relations after the change-scenario sync", Number(crossCompanyManagerEdges[0].count) === 0);

  const companies = await prisma.company.findMany({ select: { normalizedName: true } });
  check("Still no persisted 'Unassigned' Company row after the change-scenario sync", !companies.some((c) => c.normalizedName === "unassigned"));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().finally(() => prisma.$disconnect());
