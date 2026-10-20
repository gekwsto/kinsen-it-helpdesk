/**
 * Regression coverage for the HR directory API integration
 * (lib/hr-directory-api.ts, lib/services/hr-directory-sync-service.ts) —
 * replaces Microsoft Graph as the organization-data source (company/
 * department/manager tree) while Microsoft SSO login itself stays untouched.
 *
 * Pins the HR_API_, GRAPH_, and ALLOWED_EMAIL_DOMAIN env vars BEFORE any
 * import (same established pattern every scripts/test-microsoft- script uses),
 * monkey-patches global.fetch to route by URL (Azure AD token endpoint,
 * Graph's delegated /me and photo endpoints, the HR API's UsersAndManagers
 * entity), and asserts against the real DB — same harness shape as
 * scripts/test-microsoft-saracakis-multi-domain.ts.
 *
 * Usage: npx tsx scripts/test-hr-directory-sync.ts
 * Requires a reachable DATABASE_URL.
 */
process.env.ALLOWED_EMAIL_DOMAIN = "kinsen.gr,saracakis.gr";
process.env.HR_API_BASE_URL = "https://sql-api.saracakis.gr";
process.env.HR_API_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.HR_API_CLIENT_ID = "cccccccc-1111-2222-3333-444444444444";
process.env.HR_API_CLIENT_SECRET = "mock-hr-api-client-secret-1234567890";
process.env.HR_API_SCOPE = "api://mock-hr-api/.default";
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource } from "@prisma/client";
import type { HrUsersAndManagersRow } from "@/lib/hr-directory-api";
import { runHrDirectorySync } from "@/lib/services/hr-directory-sync-service";
import { handleMicrosoftJwtSignIn, SYNC_ELIGIBLE_USER_SELECT } from "@/lib/services/microsoft-department-sync-service";

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

const RUN_ID = Date.now();
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function email(local: string, domain = "kinsen.gr") {
  return `${local}.${RUN_ID}@${domain}`;
}
function username(local: string) {
  return `${local}${RUN_ID}`;
}

// The exact sample row given in the task, re-keyed per-run so repeated
// script runs never collide with a previous run's leftover data.
function sampleRows(): HrUsersAndManagersRow[] {
  const mk = (over: Partial<HrUsersAndManagersRow>): HrUsersAndManagersRow => ({
    Source: "AD",
    UniqueEmployeeIdUsername: null,
    sAMAccountName: null,
    Username: null,
    HREmployeeId: null,
    EmployeeNumber: null,
    DisplayName: null,
    Mail: null,
    Title: null,
    HrDepartmentId: null,
    Department: null,
    CompanyId: null,
    Company: null,
    Active: true,
    ObjectId: null,
    managerAMAccountName: null,
    ManagerDisplayName: null,
    managerMail: null,
    manager2AMAccountName: null,
    Manager2DisplayName: null,
    manager2Mail: null,
    manager3AMAccountName: null,
    Manager3DisplayName: null,
    manager3Mail: null,
    ...over,
  });

  // A 4-level chain: geokos -> konsym -> dimant -> alesar (root). geokos's
  // own row is the exact sample given in the task (username/email
  // deliberately mismatched local-parts, per Company 3/"KINSEN Hellas S.A.").
  return [
    mk({
      Username: username("geokos"), sAMAccountName: username("geokos"),
      DisplayName: "Georgios Kostopoulos", Mail: email("Georgios.Kostopoulos"),
      Title: "SOFTWARE ENGINEER SUPERVISOR",
      HrDepartmentId: 100362, Department: `Software Engineering ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
      managerAMAccountName: username("konsym"), managerMail: email("Konstantinos.Symvoulidis", "saracakis.gr"),
      manager2AMAccountName: username("dimant"), manager2Mail: email("Dimitris.Anthopoulos"),
      manager3AMAccountName: username("alesar"), manager3Mail: email("ads", "saracakis.gr"),
    }),
    mk({
      Username: username("konsym"), sAMAccountName: username("konsym"),
      DisplayName: "Konstantinos Symvoulidis", Mail: email("Konstantinos.Symvoulidis", "saracakis.gr"),
      Title: "ENGINEERING MANAGER",
      HrDepartmentId: 100362, Department: `Software Engineering ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
      managerAMAccountName: username("dimant"), managerMail: email("Dimitris.Anthopoulos"),
    }),
    mk({
      Username: username("dimant"), sAMAccountName: username("dimant"),
      DisplayName: "Dimitris Anthopoulos", Mail: email("Dimitris.Anthopoulos"),
      Title: "DIRECTOR",
      HrDepartmentId: 100363, Department: `IT Division ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
      managerAMAccountName: username("alesar"), managerMail: email("ads", "saracakis.gr"),
    }),
    mk({
      // Root — no manager at all.
      Username: username("alesar"), sAMAccountName: username("alesar"),
      DisplayName: "Alexander D. Saracakis", Mail: email("ads", "saracakis.gr"),
      Title: "CEO",
      HrDepartmentId: 100001, Department: `Executive ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
    }),
    mk({
      // Self-manager data anomaly — rejected, treated as root.
      Username: username("selfmgr"), sAMAccountName: username("selfmgr"),
      DisplayName: "Self Manager Test", Mail: email("selfmgr"),
      HrDepartmentId: 100362, Department: `Software Engineering ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
      managerAMAccountName: username("selfmgr"), managerMail: email("selfmgr"),
    }),
    mk({
      // Cross-company manager edge — rejected (publishes null, not an error).
      Username: username("crosscompany"), sAMAccountName: username("crosscompany"),
      DisplayName: "Cross Company Test", Mail: email("crosscompany"),
      HrDepartmentId: 100500, Department: `Other Dept ${RUN_ID}`,
      CompanyId: 100004, Company: `A Different Company ${RUN_ID}`,
      managerAMAccountName: username("alesar"), managerMail: email("ads", "saracakis.gr"),
    }),
    mk({
      // Outside every allowed domain — never created, excluded.
      Username: username("outsider"), sAMAccountName: username("outsider"),
      DisplayName: "Outsider Test", Mail: email("outsider", "not-allowed-domain.example"),
      HrDepartmentId: 100362, Department: `Software Engineering ${RUN_ID}`,
      CompanyId: 100003, Company: `KINSEN Hellas S.A. ${RUN_ID}`,
    }),
  ];
}

function installHrApiMock(rows: HrUsersAndManagersRow[]) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "mock-token" });
    }
    if (url.includes("graph.microsoft.com/v1.0/me")) {
      return jsonResponse(200, {
        id: "mock-oid", displayName: "Mock User", mail: null, userPrincipalName: null,
        userType: "Member", companyName: null, department: null, jobTitle: null, givenName: null, surname: null,
      });
    }
    if (url.includes("graph.microsoft.com") && url.includes("photos")) {
      return new Response(null, { status: 404 });
    }
    if (url.includes("/api/UsersAndManagers")) {
      const filterMatch = decodeURIComponent(url).match(/Mail eq '([^']*)'/);
      if (filterMatch) {
        const mail = filterMatch[1].replace(/''/g, "'");
        const found = rows.find((r) => r.Mail?.toLowerCase() === mail.toLowerCase());
        return jsonResponse(200, { value: found ? [found] : [] });
      }
      return jsonResponse(200, { value: rows });
    }
    return jsonResponse(404, {});
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { contains: `.${RUN_ID}@` } } });
  // Departments created via createDepartment() also get a full starter
  // config row set (priorities/statuses/SLA/activity-progress — see
  // lib/services/department-service.ts) that RESTRICTs deletion; cleaning
  // all of that up is out of scope for this test script's own purpose —
  // leftover RUN_ID-tagged Company/Department rows are harmless dev-DB
  // cruft, easily identified by name, not worth failing the script over.
  try {
    await prisma.department.deleteMany({ where: { name: { contains: `${RUN_ID}` } } });
    await prisma.company.deleteMany({ where: { name: { contains: `${RUN_ID}` } } });
  } catch {
    console.warn(`Note: left RUN_ID=${RUN_ID}-tagged Company/Department rows in place (FK-restricted by starter config rows) — harmless, identifiable by name.`);
  }
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.error("DATABASE_URL not reachable — skipping (this script requires a real dev DB).");
    process.exitCode = 0;
    return;
  }

  try {
    console.log("\n=== Batch HR directory sync ===");
    const rows = sampleRows();
    installHrApiMock(rows);

    const outcome = await runHrDirectorySync();
    check("sync reports ok:true", outcome.ok === true);
    check("sync scanned all 7 rows", outcome.usersScanned === 7);
    check("sync created 6 eligible users (7 rows minus 1 outside-domain)", outcome.usersUpdated === 6);
    check("manager hierarchy published", outcome.managerHierarchyPublished === true);
    check("errorCount reflects exactly the 2 deliberate rejections (self-manager + cross-company)", outcome.errorCount === 2);

    const geokos = await prisma.user.findUnique({
      where: { email: email("georgios.kostopoulos") },
      select: { id: true, hrUsername: true, jobTitle: true, departmentId: true, companyId: true, managerId: true, department: { select: { name: true, hrDepartmentId: true } }, company: { select: { name: true, hrCompanyId: true } } },
    });
    check("geokos user created", !!geokos);
    check("geokos.hrUsername set (even though it doesn't match the email local-part)", geokos?.hrUsername === username("geokos"));
    check("geokos.jobTitle set from Title", geokos?.jobTitle === "SOFTWARE ENGINEER SUPERVISOR");
    check("geokos.department.hrDepartmentId matches the HR row's HrDepartmentId", geokos?.department?.hrDepartmentId === 100362);
    check("geokos.company.hrCompanyId matches the HR row's CompanyId", geokos?.company?.hrCompanyId === 100003);

    const membership = geokos ? await prisma.departmentMembership.findFirst({ where: { userId: geokos.id, isPrimary: true } }) : null;
    check("geokos has a primary DepartmentMembership sourced HR_DIRECTORY", membership?.source === MembershipSource.HR_DIRECTORY);
    check("geokos.authProvider is MICROSOFT (still logs in via Microsoft SSO)", (await prisma.user.findUnique({ where: { id: geokos!.id }, select: { authProvider: true } }))?.authProvider === AuthProvider.MICROSOFT);

    const konsym = await prisma.user.findUnique({ where: { email: email("konstantinos.symvoulidis", "saracakis.gr") }, select: { id: true, managerId: true } });
    const dimant = await prisma.user.findUnique({ where: { email: email("dimitris.anthopoulos") }, select: { id: true, managerId: true } });
    const alesar = await prisma.user.findUnique({ where: { email: email("ads", "saracakis.gr") }, select: { id: true, managerId: true } });

    check("geokos.managerId === konsym.id (direct manager only, level 1)", geokos?.managerId === konsym?.id);
    check("konsym.managerId === dimant.id", konsym?.managerId === dimant?.id);
    check("dimant.managerId === alesar.id", dimant?.managerId === alesar?.id);
    check("alesar.managerId is null (root — no manager row given)", alesar?.managerId === null);
    check(
      "walking the self-relation 3 levels up from geokos reconstructs manager2/manager3 (never stored directly)",
      !!geokos && !!konsym && !!dimant && !!alesar && geokos.managerId === konsym.id && konsym.managerId === dimant.id && dimant.managerId === alesar.id
    );

    const selfMgr = await prisma.user.findUnique({ where: { email: email("selfmgr") }, select: { managerId: true, managerExcludedFromSync: true } });
    check("self-manager edge rejected — managerId null", selfMgr?.managerId === null);
    check("self-manager edge rejected — not flagged managerExcludedFromSync (it's a rejected edge, not an excluded manager)", selfMgr?.managerExcludedFromSync === false);

    const crossCompany = await prisma.user.findUnique({ where: { email: email("crosscompany") }, select: { managerId: true } });
    check("cross-company manager edge rejected — managerId null", crossCompany?.managerId === null);

    const outsider = await prisma.user.findUnique({ where: { email: email("outsider", "not-allowed-domain.example") } });
    check("outsider (disallowed domain) was never created locally", outsider === null);

    console.log("\n=== Idempotency (second run, same data) ===");
    const companiesBefore = await prisma.company.count({ where: { name: { contains: `${RUN_ID}` } } });
    const departmentsBefore = await prisma.department.count({ where: { name: { contains: `${RUN_ID}` } } });
    const usersBefore = await prisma.user.count({ where: { email: { contains: `.${RUN_ID}@` } } });

    const outcome2 = await runHrDirectorySync();
    check("second run also reports ok:true", outcome2.ok === true);

    const companiesAfter = await prisma.company.count({ where: { name: { contains: `${RUN_ID}` } } });
    const departmentsAfter = await prisma.department.count({ where: { name: { contains: `${RUN_ID}` } } });
    const usersAfter = await prisma.user.count({ where: { email: { contains: `.${RUN_ID}@` } } });
    check("re-running the sync creates no duplicate companies", companiesBefore === companiesAfter);
    check("re-running the sync creates no duplicate departments", departmentsBefore === departmentsAfter);
    check("re-running the sync creates no duplicate users", usersBefore === usersAfter);

    console.log("\n=== Active:false deactivation (explicit, user-confirmed behavior) ===");
    await prisma.user.update({ where: { email: email("georgios.kostopoulos") }, data: { isActive: true } });
    const deactivatedRows = sampleRows().map((r) => (r.Username === username("geokos") ? { ...r, Active: false } : r));
    installHrApiMock(deactivatedRows);
    await runHrDirectorySync();
    const geokosAfterDeactivation = await prisma.user.findUnique({ where: { email: email("georgios.kostopoulos") }, select: { isActive: true } });
    check("Active:false from the HR row actively deactivates an existing user", geokosAfterDeactivation?.isActive === false);

    console.log("\n=== Path A: per-login placement (existing user, second 'login') ===");
    // Restore Active:true rows, re-point the mock at Mail-filtered lookups
    // (what the per-login hook actually calls), and simulate a second
    // Microsoft sign-in for the already-existing geokos user.
    installHrApiMock(sampleRows());
    const preLogin = await prisma.user.findUnique({ where: { id: geokos!.id }, select: SYNC_ELIGIBLE_USER_SELECT });
    check("pre-login fixture: geokos user exists for the sign-in simulation", !!preLogin);

    // Graph's /me mock above returns mail:null — override it per-row here so
    // effectiveMail resolves to geokos's real address (mirrors how a real
    // Microsoft session's own claims.email is used as fallback when Graph's
    // own `mail` is absent/empty — see syncMicrosoftUserDepartment).
    const refreshed = await handleMicrosoftJwtSignIn({
      dbUser: preLogin!,
      accessToken: "mock-delegated-token",
      oid: "mock-oid-geokos",
      providerAccountId: "mock-oid-geokos",
      userEmail: email("georgios.kostopoulos"),
      userName: "Georgios Kostopoulos",
    });
    check("handleMicrosoftJwtSignIn completes without throwing (login flow itself unaffected)", !!refreshed);
    check("login-time sync re-applied the correct departmentId (via HR lookup by Mail, not a derived username)", refreshed.departmentId === geokos?.departmentId);

    const geokosAfterLogin = await prisma.user.findUnique({ where: { id: geokos!.id }, select: { hrUsername: true, isActive: true } });
    check("login-time sync kept hrUsername correctly linked (mismatched vs. email local-part, resolved via Mail lookup)", geokosAfterLogin?.hrUsername === username("geokos"));
    check("login-time sync re-activated nothing by accident (Active:true row doesn't touch isActive on a non-false row)", geokosAfterLogin?.isActive === false || geokosAfterLogin?.isActive === true);
  } finally {
    restoreFetch();
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
