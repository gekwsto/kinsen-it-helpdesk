/**
 * Populates a realistic multi-company Microsoft Directory Sync dataset by
 * calling the REAL runOrganizationSync() orchestrator — the exact same
 * function POST /api/admin/organization/sync calls — with ONLY the Graph
 * HTTP transport mocked (this environment has no real Azure/Entra tenant
 * credentials, see docs/microsoft-production-readiness-audit.md). Every
 * other part of the pipeline (directory sync, manager sync, locking,
 * OrganizationSyncRun bookkeeping, cache invalidation) runs for real against
 * the real database, so the resulting data is exactly what a real
 * successful sync would have produced.
 *
 * Deliberately does NOT clean up after itself — this data is meant to be
 * observed live in the Organization tab (scripts/browser-verify-organization-tab.ts)
 * and audited via direct DB queries. Run
 * scripts/cleanup-organization-sync-fixture.ts afterward to remove it.
 *
 * Pass 1 (this script's default): establishes Kinsen / Kinsen Austria /
 * Saracakis with realistic users, a shared "IT" department name across two
 * companies, Graph pagination across 2 pages, and Unassigned fallbacks.
 * Pass 2 (SIMULATE_PASS=2): introduces the "change scenarios" — job title
 * change, department move within a company, company move, a new
 * department, a brand-new fourth company, an existing user losing their
 * department/company.
 *
 * Usage:
 *   npx tsx scripts/simulate-organization-sync-fixture.ts
 *   npx tsx scripts/simulate-organization-sync-fixture.ts --pass=2
 *   npx tsx scripts/simulate-organization-sync-fixture.ts --pass=1 --repeat   (idempotency check: re-runs pass 1 unchanged)
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { OrganizationSyncType } from "@prisma/client";
import { runOrganizationSync } from "@/lib/services/organization-sync-orchestrator";
import type { GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { writeFileSync } from "node:fs";

const FIXTURE_TAG = "orgfixture";
const SCRATCH_DIR = "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/org-audit";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pass1Users(): GraphDirectoryUser[] {
  return [
    { id: `${FIXTURE_TAG}-kinsen-it-1`, userType: "Member", mail: `${FIXTURE_TAG}.kinsen.it.1@kinsen.example`, displayName: "Nikos Papadopoulos", givenName: "Nikos", surname: "Papadopoulos", companyName: "Kinsen", department: "IT", jobTitle: "IT Support Engineer", accountEnabled: true },
    { id: `${FIXTURE_TAG}-kinsen-it-2`, userType: "Member", mail: `${FIXTURE_TAG}.kinsen.it.2@kinsen.example`, displayName: "Maria Ioannou", givenName: "Maria", surname: "Ioannou", companyName: "Kinsen", department: "IT", jobTitle: "Systems Administrator", accountEnabled: true },
    { id: `${FIXTURE_TAG}-kinsen-sales-1`, userType: "Member", mail: `${FIXTURE_TAG}.kinsen.sales.1@kinsen.example`, displayName: "Giorgos Antoniou", givenName: "Giorgos", surname: "Antoniou", companyName: "Kinsen", department: "Sales", jobTitle: "Sales Representative", accountEnabled: true },
    { id: `${FIXTURE_TAG}-austria-it-1`, userType: "Member", mail: `${FIXTURE_TAG}.austria.it.1@kinsen-austria.example`, displayName: "Anna Huber", givenName: "Anna", surname: "Huber", companyName: "Kinsen Austria", department: "IT", jobTitle: "IT Consultant", accountEnabled: true },
    { id: `${FIXTURE_TAG}-austria-hr-1`, userType: "Member", mail: `${FIXTURE_TAG}.austria.hr.1@kinsen-austria.example`, displayName: "Stefan Gruber", givenName: "Stefan", surname: "Gruber", companyName: "Kinsen Austria", department: "Human Resources", jobTitle: "HR Officer", accountEnabled: true },
    { id: `${FIXTURE_TAG}-saracakis-svc-1`, userType: "Member", mail: `${FIXTURE_TAG}.saracakis.svc.1@saracakis.example`, displayName: "Eleni Vasiliou", givenName: "Eleni", surname: "Vasiliou", companyName: "Saracakis", department: "Service", jobTitle: "Service Advisor", accountEnabled: true },
    { id: `${FIXTURE_TAG}-unassigned-both-1`, userType: "Member", mail: `${FIXTURE_TAG}.unassigned.both.1@example.com`, displayName: "Contractor Account", companyName: null, department: null, accountEnabled: true },
    { id: `${FIXTURE_TAG}-kinsen-unassigned-dept-1`, userType: "Member", mail: `${FIXTURE_TAG}.kinsen.unassigneddept.1@kinsen.example`, displayName: "New Hire Pending Placement", companyName: "Kinsen", department: null, accountEnabled: true },
  ];
}

/** Pass 2: change scenarios layered on top of pass 1's identities. */
function pass2Users(): GraphDirectoryUser[] {
  const base = pass1Users();
  const byId = new Map(base.map((u) => [u.id, { ...u }]));

  // Scenario: existing user changes job title only.
  byId.get(`${FIXTURE_TAG}-kinsen-it-1`)!.jobTitle = "Senior IT Support Engineer";

  // Scenario: existing user moves department within the SAME company (Kinsen: Sales -> IT).
  byId.get(`${FIXTURE_TAG}-kinsen-sales-1`)!.department = "IT";

  // Scenario: existing user moves to a DIFFERENT company entirely (Austria HR -> Saracakis Service).
  byId.get(`${FIXTURE_TAG}-austria-hr-1`)!.companyName = "Saracakis";
  byId.get(`${FIXTURE_TAG}-austria-hr-1`)!.department = "Service";

  // Scenario: existing user LOSES their department/company (moves to Unassigned).
  byId.get(`${FIXTURE_TAG}-saracakis-svc-1`)!.companyName = null;
  byId.get(`${FIXTURE_TAG}-saracakis-svc-1`)!.department = null;

  // Scenario: brand-new department appears under an existing company (Kinsen: "Marketing").
  const newDeptUser: GraphDirectoryUser = {
    id: `${FIXTURE_TAG}-kinsen-marketing-1`,
    userType: "Member",
    mail: `${FIXTURE_TAG}.kinsen.marketing.1@kinsen.example`,
    displayName: "Dimitra Konstantinou",
    givenName: "Dimitra",
    surname: "Konstantinou",
    companyName: "Kinsen",
    department: "Marketing",
    jobTitle: "Marketing Specialist",
    accountEnabled: true,
  };

  // Scenario: a brand-new company appears in the tenant, with no code change.
  const newCompanyUser: GraphDirectoryUser = {
    id: `${FIXTURE_TAG}-newco-1`,
    userType: "Member",
    mail: `${FIXTURE_TAG}.newco.1@newco.example`,
    displayName: "Petros Michailidis",
    givenName: "Petros",
    surname: "Michailidis",
    companyName: "Kinsen Logistics",
    department: "Warehouse",
    jobTitle: "Warehouse Coordinator",
    accountEnabled: true,
  };

  return [...byId.values(), newDeptUser, newCompanyUser];
}

async function main() {
  const args = process.argv.slice(2);
  const passArg = args.find((a) => a.startsWith("--pass="));
  const pass = passArg ? Number(passArg.split("=")[1]) : 1;
  const repeat = args.includes("--repeat");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const users = pass === 2 ? pass2Users() : pass1Users();

  // Split into 2 Graph pages to genuinely exercise @odata.nextLink pagination
  // (fetchAllTenantUsers, already unit-tested elsewhere — here it's exercised
  // through the real end-to-end orchestrator instead).
  const mid = Math.ceil(users.length / 2);
  const page1 = users.slice(0, mid);
  const page2 = users.slice(mid);
  const page2Url = "https://graph.microsoft.com/v1.0/users?$skiptoken=simulated-page-2";

  const originalFetch = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "mock-app-token" });
    if (url === page2Url) return jsonResponse(200, { value: page2 });
    if (url.includes("graph.microsoft.com/v1.0/users?")) return jsonResponse(200, { value: page1, "@odata.nextLink": page2Url });
    if (url.includes("/directReports")) return jsonResponse(200, { value: [] }); // no manager fixtures in this pass — org-manager-sync's own dedicated tests already cover directReports inversion thoroughly
    return jsonResponse(404, {});
  }) as typeof fetch;

  const admin = await prisma.user.findUnique({ where: { email: "admin@kinsen.gr" }, select: { id: true } });

  console.log(`\n=== Simulated sync — pass ${pass}${repeat ? " (repeat run)" : ""} — ${users.length} Graph users across 2 pages ===\n`);
  const result = await runOrganizationSync(OrganizationSyncType.FULL, admin?.id);
  global.fetch = originalFetch;

  console.log("Real runOrganizationSync() result (same function the admin Sync button calls):");
  console.log(JSON.stringify(result, null, 2));

  const companies = await prisma.company.findMany({ include: { _count: { select: { directDepartments: true, businessUnits: true, users: true } } } });
  const departments = await prisma.department.findMany({ where: { companyId: { not: null } }, select: { id: true, name: true, companyId: true, _count: { select: { users: true } } } });

  writeFileSync(`${SCRATCH_DIR}/sync-pass-${pass}${repeat ? "-repeat" : ""}-result.json`, JSON.stringify({ result, companies, departments }, null, 2));

  console.log("\nCompanies now in the database:");
  for (const c of companies) console.log(`  - ${c.name} (id=${c.id}) directDepartments=${c._count.directDepartments} businessUnits=${c._count.businessUnits} users=${c._count.users}`);
  console.log("\nDirect-Company departments now in the database:");
  for (const d of departments) console.log(`  - ${d.name} (company=${d.companyId}) users=${d._count.users}`);

  await prisma.$disconnect();
}

main();
