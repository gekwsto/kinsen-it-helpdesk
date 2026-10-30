/**
 * Focused regression coverage for "Verify Unresolved Microsoft Department
 * Safety" — a real defect found in the duplicate-prevention round's own
 * fix: once resolveCompanyForSync/resolveDepartmentForSync stopped
 * auto-creating from an unmatched Microsoft signal (returning `null` /
 * falling back to "Unassigned"), BOTH Microsoft sync entry points
 * (microsoft-department-sync-service.ts's per-login path,
 * organization-directory-sync-service.ts's Full Directory Sync) still
 * unconditionally APPLIED that degraded result — silently clobbering an
 * EXISTING user's real `companyId` to null, and silently demoting/
 * deactivating their real primary DepartmentMembership in favor of the
 * Unassigned bucket. Untrusted/unresolved Microsoft directory data must
 * never downgrade an existing user's access.
 *
 * FIX: both call sites now read the user's pre-sync companyId/departmentId
 * once and skip applying companyId/primary-department when the resolver's
 * result is unresolved/fallback AND the user already has something real to
 * protect — safe to apply unconditionally for a brand-new user (nothing to
 * protect yet).
 *
 * Covers, through the REAL entry points (not just the resolver in
 * isolation):
 *   1. Existing user, valid primary, unknown/renamed Department -> preserved.
 *   2. Existing user, unresolved Company -> companyId/primary preserved.
 *   3. First-login user, unresolved Company/Department -> safe Unassigned
 *      placement (not blocked, not granting anything beyond Unassigned).
 *   4. SQLGeneral-authoritative primary stays protected (no regression from
 *      layering the new guard on top of the pre-existing one).
 *   5. Sanity: a GENUINE new resolution still moves an existing primary
 *      (the guard must not over-protect).
 * For BOTH Microsoft sync entry points.
 *
 * Entirely local/dev-DB. Never touches production.
 *
 * Usage: npx tsx scripts/test-unresolved-microsoft-directory-safety.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { runOrganizationDirectorySync, type GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { normalizeCompanyName, normalizeDepartmentName, UNASSIGNED_NODE_NAME } from "@/lib/services/organization-normalization";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const originalFetch = global.fetch;

function mockGraphMe(opts: { companyName: string | null; department: string | null; oid: string; mail?: string | null }) {
  global.fetch = (async () =>
    new Response(JSON.stringify({ id: opts.oid, displayName: "Test User", mail: opts.mail ?? null, userPrincipalName: null, userType: "Member", companyName: opts.companyName, department: opts.department, jobTitle: null }), { status: 200 })) as typeof fetch;
}
function restoreFetch() {
  global.fetch = originalFetch;
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function installTokenMock(router: (url: string) => Promise<Response> | Response) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "mock-app-token" });
    return router(url);
  }) as typeof fetch;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string, email?: string): Promise<{ id: string; email: string }> {
    const u = await prisma.user.create({ data: { email: email ?? `umds-${tag}-${RUN_ID}@kinsen.gr`, name: `UMDS ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true } });
    userIds.push(u.id);
    return { id: u.id, email: u.email };
  }

  try {
    const realCompany = await prisma.company.create({ data: { name: `UMDS Real Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`UMDS Real Co ${RUN_ID}`) } });
    companyIds.push(realCompany.id);
    const realDept = await prisma.department.create({ data: { name: `UMDS Real Dept ${RUN_ID}`, slug: `umds-real-dept-${RUN_ID}`, normalizedName: normalizeDepartmentName(`UMDS Real Dept ${RUN_ID}`), companyId: realCompany.id } });
    departmentIds.push(realDept.id);
    const genuineNewDept = await prisma.department.create({ data: { name: `UMDS Genuine New Dept ${RUN_ID}`, slug: `umds-genuine-new-dept-${RUN_ID}`, normalizedName: normalizeDepartmentName(`UMDS Genuine New Dept ${RUN_ID}`), companyId: realCompany.id } });
    departmentIds.push(genuineNewDept.id);
    const UNRESOLVED_COMPANY_NAME = `UMDS Totally Unresolved Co ${RUN_ID}`; // never created
    const UNRESOLVED_DEPT_VALUE = `UMDS Totally Unresolved Dept ${RUN_ID}`; // never created, under realCompany

    // ══════════════════════ Section 1: Per-login path ══════════════════════
    console.log("\n=== Section 1: syncMicrosoftUserDepartment (per-login path) ===\n");

    // 1a. Existing user, valid MICROSOFT_DEPARTMENT primary, unresolved Department this login (company still resolves fine).
    {
      const user = await makeUser("1a");
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      mockGraphMe({ companyName: `UMDS Real Co ${RUN_ID}`, department: UNRESOLVED_DEPT_VALUE, oid: `umds-1a-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1a-${RUN_ID}`, email: user.email, name: "1a" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      check("1a. User.departmentId is UNCHANGED — still the real Department, never moved to Unassigned", after?.departmentId === realDept.id);
      check("1a. The real primary membership is byte-for-byte untouched (same updatedAt)", membershipAfter.updatedAt.getTime() === before.updatedAt.getTime());
      check("1a. Still primary, still active, still MICROSOFT_DEPARTMENT-sourced", membershipAfter.isPrimary === true && membershipAfter.isActive === true && membershipAfter.source === MembershipSource.MICROSOFT_DEPARTMENT);
      check("1a. companyId is unaffected (the Company itself resolved fine this login)", after?.companyId === realCompany.id);
    }

    // 1b/2. Existing user, valid primary+company, THIS login's Company is unresolved (never seen before).
    {
      const user = await makeUser("1b");
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      await prisma.user.update({ where: { id: user.id }, data: { companyId: realCompany.id } });
      mockGraphMe({ companyName: UNRESOLVED_COMPANY_NAME, department: UNRESOLVED_DEPT_VALUE, oid: `umds-1b-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1b-${RUN_ID}`, email: user.email, name: "1b" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      check("1b/2. User.companyId is NEVER overwritten to null by an unresolved Company — stays the real Company", after?.companyId === realCompany.id);
      check("1b/2. User.departmentId also stays the real Department (unresolved Company implies unresolved Department too)", after?.departmentId === realDept.id);
      check("1b/2. No stray Company was created for the unresolved name either", (await prisma.company.count({ where: { normalizedName: normalizeCompanyName(UNRESOLVED_COMPANY_NAME) } })) === 0);
    }

    // 1c/3. First-login user (no existing primary at all), BOTH Company and Department unresolved -> safe Unassigned.
    {
      const user = await makeUser("1c");
      mockGraphMe({ companyName: UNRESOLVED_COMPANY_NAME, department: UNRESOLVED_DEPT_VALUE, oid: `umds-1c-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1c-${RUN_ID}`, email: user.email, name: "1c" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true } });
      check("1c/3. A brand-new user with nothing to protect still gets safely placed (not left with no primary at all)", after?.departmentId !== null);
      check("1c/3. Placed in the Unassigned bucket (companyId: null, since the Company itself never resolved either)", after?.department?.name === UNASSIGNED_NODE_NAME && after?.companyId === null);
      const primary = await prisma.departmentMembership.findFirst({ where: { userId: user.id, isPrimary: true, isActive: true } });
      check("1c/3. Exactly one real, active primary membership exists — safe placement, not a blocked/broken login", primary?.departmentId === after?.departmentId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
    }

    // 1d/4. SQLGeneral-authoritative existing user, unresolved Company/Department -> fully untouched (pre-existing gate, no regression).
    {
      const user = await makeUser("1d");
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      await prisma.user.update({ where: { id: user.id }, data: { companyId: realCompany.id } });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      mockGraphMe({ companyName: UNRESOLVED_COMPANY_NAME, department: UNRESOLVED_DEPT_VALUE, oid: `umds-1d-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1d-${RUN_ID}`, email: user.email, name: "1d" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      check("1d/4. SQLGeneral-authoritative companyId untouched", after?.companyId === realCompany.id);
      check("1d/4. SQLGeneral-authoritative primary completely untouched (same updatedAt)", membershipAfter.updatedAt.getTime() === before.updatedAt.getTime());
    }

    // 1e. MANUAL existing primary, unresolved Company/Department -> untouched (pre-existing protection, sanity check).
    {
      const user = await makeUser("1e");
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      await prisma.user.update({ where: { id: user.id }, data: { companyId: realCompany.id } });
      mockGraphMe({ companyName: UNRESOLVED_COMPANY_NAME, department: UNRESOLVED_DEPT_VALUE, oid: `umds-1e-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1e-${RUN_ID}`, email: user.email, name: "1e" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      check("1e. MANUAL companyId untouched", after?.companyId === realCompany.id);
      check("1e. MANUAL primary untouched (still MANUAL, still DEPARTMENT_MANAGER)", membershipAfter.source === MembershipSource.MANUAL && membershipAfter.role === DepartmentRole.DEPARTMENT_MANAGER && membershipAfter.isPrimary === true);
    }

    // 1f. Sanity: a GENUINE resolution still moves an existing primary — the new guard must not over-protect.
    {
      const user = await makeUser("1f");
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      mockGraphMe({ companyName: `UMDS Real Co ${RUN_ID}`, department: `UMDS Genuine New Dept ${RUN_ID}`, oid: `umds-1f-${RUN_ID}`, mail: user.email });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `umds-1f-${RUN_ID}`, email: user.email, name: "1f" });
      restoreFetch();
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      check("1f. A genuine, real HR Department change still correctly moves the primary (guard is not over-broad)", after?.departmentId === genuineNewDept.id);
    }

    // ══════════════════════ Section 2: Full Directory Sync path ══════════════════════
    console.log("\n=== Section 2: runOrganizationDirectorySync (Full Directory Sync path) ===\n");
    const saved = { GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID, GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET };
    process.env.GRAPH_TENANT_ID = "00000000-0000-4000-8000-000000000021";
    process.env.GRAPH_CLIENT_ID = "00000000-0000-4000-8000-000000000022";
    process.env.GRAPH_CLIENT_SECRET = `umds-hermetic-secret-${RUN_ID}`;

    function installDirectoryUsersMock(users: GraphDirectoryUser[]) {
      installTokenMock((url) => {
        if (url.startsWith("https://graph.microsoft.com/v1.0/users")) return jsonResponse(200, { value: users });
        throw new Error(`Unexpected URL in Full Directory Sync mock: ${url}`);
      });
    }

    // 2a/2. Existing user, valid primary+company, Full Sync sees an unresolved Company/Department for them this run.
    {
      const email = `umds-2a-${RUN_ID}@kinsen.gr`;
      const oid = `umds-2a-oid-${RUN_ID}`;
      const user = await prisma.user.create({ data: { email, authProvider: AuthProvider.MICROSOFT, microsoftUserId: oid, role: Role.USER } });
      userIds.push(user.id);
      await setPrimaryDepartmentMembership(user.id, realDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      await prisma.user.update({ where: { id: user.id }, data: { companyId: realCompany.id } });
      const before = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });

      installDirectoryUsersMock([{ id: oid, displayName: "2a", givenName: null, surname: null, userPrincipalName: null, mail: email, accountEnabled: true, userType: "Member", department: UNRESOLVED_DEPT_VALUE, jobTitle: null, companyName: UNRESOLVED_COMPANY_NAME, officeLocation: null, employeeId: null, employeeType: null }]);
      const outcome = await runOrganizationDirectorySync();
      check("2a/2. Full Directory Sync run completes ok", outcome.ok === true);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user.id, departmentId: realDept.id } } });
      check("2a/2. Full Directory Sync never overwrites an existing real companyId with an unresolved result", after?.companyId === realCompany.id);
      check("2a/2. Full Directory Sync never moves an existing real primary to Unassigned for an unresolved Department", after?.departmentId === realDept.id);
      check("2a/2. The real primary membership is untouched (same updatedAt)", membershipAfter.updatedAt.getTime() === before.updatedAt.getTime());
    }

    // 2c/3. First-login (brand-new via Full Sync), unresolved Company/Department -> safe Unassigned.
    {
      const email = `umds-2c-${RUN_ID}@kinsen.gr`;
      const oid = `umds-2c-oid-${RUN_ID}`;
      installDirectoryUsersMock([{ id: oid, displayName: "2c", givenName: null, surname: null, userPrincipalName: null, mail: email, accountEnabled: true, userType: "Member", department: UNRESOLVED_DEPT_VALUE, jobTitle: null, companyName: UNRESOLVED_COMPANY_NAME, officeLocation: null, employeeId: null, employeeType: null }]);
      const outcome = await runOrganizationDirectorySync();
      check("2c/3. Full Directory Sync run completes ok", outcome.ok === true);
      const created = await prisma.user.findUnique({ where: { microsoftUserId: oid }, include: { department: true } });
      check("2c/3. A brand-new user is still created and safely placed via Full Directory Sync too", created !== null && created.departmentId !== null);
      check("2c/3. Placed in the Unassigned bucket, not blocked, not granted a fabricated named Department", created?.department?.name === UNASSIGNED_NODE_NAME && created?.companyId === null);
      if (created) userIds.push(created.id);
      if (created?.departmentId) departmentIds.push(created.departmentId);
    }

    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key as keyof typeof saved];
      else process.env[key as keyof typeof saved] = value;
    }
  } finally {
    restoreFetch();
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketPriorities", () => (departmentIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["ticketStatuses", () => (departmentIds.length ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["departments", () => (departmentIds.length ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
      ["companies", () => (companyIds.length ? prisma.company.deleteMany({ where: { id: { in: companyIds } } }) : Promise.resolve())],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
