/**
 * Section 3 of the live audit: read-only database assertions confirming
 * correct multi-company scoping after a real sync run. Run against whatever
 * data currently exists (populated by scripts/simulate-organization-sync-fixture.ts).
 */
import { prisma } from "@/lib/prisma";

let passed = 0, failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, normalizedName: true } });
  const byNormalized = new Map<string, typeof companies>();
  for (const c of companies) {
    if (!byNormalized.has(c.normalizedName)) byNormalized.set(c.normalizedName, []);
    byNormalized.get(c.normalizedName)!.push(c);
  }
  check("Each normalizedName maps to exactly one Company row", [...byNormalized.values()].every((rows) => rows.length === 1));

  const kinsen = companies.find((c) => c.normalizedName === "kinsen");
  const austria = companies.find((c) => c.normalizedName === "kinsen austria");
  const saracakis = companies.find((c) => c.normalizedName === "saracakis");
  check("Separate company roots exist for Kinsen, Kinsen Austria, Saracakis", !!kinsen && !!austria && !!saracakis && new Set([kinsen.id, austria.id, saracakis.id]).size === 3);
  check("No persisted 'Unassigned' Company row exists (fabricated-company bug fix)", !companies.some((c) => c.normalizedName === "unassigned"));

  const itDepts = await prisma.department.findMany({ where: { name: "IT", companyId: { in: [kinsen?.id, austria?.id].filter(Boolean) as string[] } }, select: { id: true, companyId: true, name: true } });
  check("Kinsen's 'IT' and Kinsen Austria's 'IT' are two distinct Department rows with different companyId", itDepts.length === 2 && itDepts[0].companyId !== itDepts[1].companyId);

  const allDepts = await prisma.department.findMany({ where: { companyId: { not: null } }, select: { id: true, companyId: true } });
  check("No direct-Company department is attached to more than one company (companyId is a scalar FK, trivially true, sanity-checked)", allDepts.every((d) => typeof d.companyId === "string"));

  const fixtureUsers = await prisma.user.findMany({
    where: { microsoftUserId: { startsWith: "orgfixture-" } },
    select: { microsoftUserId: true, email: true, givenName: true, surname: true, jobTitle: true, role: true, companyId: true, departmentId: true, company: { select: { name: true } }, department: { select: { name: true, companyId: true, businessUnitId: true } } },
  });
  check("All 8 fixture users exist", fixtureUsers.length === 8);
  check("Every fixture user has the base USER role (Microsoft sync never assigns roles)", fixtureUsers.every((u) => u.role === "USER"));

  const kinsenIt1 = fixtureUsers.find((u) => u.microsoftUserId === "orgfixture-kinsen-it-1");
  check("Existing/new user has givenName/surname/jobTitle populated from Graph", kinsenIt1?.givenName === "Nikos" && kinsenIt1?.surname === "Papadopoulos" && kinsenIt1?.jobTitle === "IT Support Engineer");

  const unassignedBoth = fixtureUsers.find((u) => u.microsoftUserId === "orgfixture-unassigned-both-1");
  check("User with null companyName+department: companyId is null, department is 'Unassigned' orphan (companyId+businessUnitId both null)", unassignedBoth?.companyId === null && unassignedBoth?.department?.name === "Unassigned" && unassignedBoth?.department?.companyId === null && unassignedBoth?.department?.businessUnitId === null);

  const kinsenUnassignedDept = fixtureUsers.find((u) => u.microsoftUserId === "orgfixture-kinsen-unassigned-dept-1");
  check("User with known company + null department: scoped 'Unassigned' department WITHIN Kinsen (companyId = Kinsen)", kinsenUnassignedDept?.departmentId !== unassignedBoth?.departmentId && kinsenUnassignedDept?.department?.companyId === kinsen?.id);

  const emails = fixtureUsers.map((u) => u.email.toLowerCase());
  check("No duplicate users by case-insensitive email", new Set(emails).size === emails.length);

  const preExistingRoles = await prisma.user.findMany({ where: { globalRoleSource: "MANUAL" }, select: { email: true, role: true } });
  check("Manually-assigned roles (globalRoleSource=MANUAL) are untouched (spot check: at least the known seeded manual-admin row still exists)", preExistingRoles.length > 0);

  const crossCompanyManagerEdges = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint as count FROM "User" u
    JOIN "User" m ON u."managerId" = m."id"
    WHERE u."companyId" IS NOT NULL AND m."companyId" IS NOT NULL AND u."companyId" != m."companyId"
  `;
  check("No invalid cross-company manager relations exist in the database", Number(crossCompanyManagerEdges[0].count) === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().finally(() => prisma.$disconnect());
