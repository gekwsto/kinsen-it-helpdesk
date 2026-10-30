/**
 * Focused regression coverage for "Prevent Duplicate Companies and
 * Departments" — the architectural fix for the real production incident
 * where Microsoft Directory/Login sync's free-text Company/Department
 * resolution (lib/services/organization-company-department-resolver.ts)
 * silently created near-duplicate Companies from punctuation/spelling
 * variants (e.g. three "Kinsen Hellas S.A." variants in production) and
 * re-created a RENAMED Department under its old name on every subsequent
 * login, plus the companion fix making Microsoft's canonical primary-write
 * path (setPrimaryDepartmentMembership) structurally incapable of
 * overriding an unlocked SQLGeneral-authoritative primary.
 *
 * Three sections, matching the round's own DO #5:
 *   A. Company-name variants never auto-create a duplicate Company.
 *   B. A renamed/obsolete Department can never be silently re-created.
 *   C. Microsoft can never override an unlocked SQLGeneral-authoritative
 *      primary (a structural guarantee, not just a caller-side check).
 *
 * Entirely local/dev-DB. Never touches production. No Company ownership,
 * SQLGeneral mapping, or permission is modified — this only exercises the
 * resolver and the canonical membership-write function directly.
 *
 * Usage: npx tsx scripts/test-organization-duplicate-prevention.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import {
  resolveCompanyForSync,
  resolveDepartmentForSync,
  createOrganizationResolutionCache,
} from "@/lib/services/organization-company-department-resolver";
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

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({ data: { email: `odp-${tag}-${RUN_ID}@kinsen.gr`, name: `ODP ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true } });
    userIds.push(u.id);
    return u.id;
  }

  try {
    // ══════════════════════ A. Company-name variants ══════════════════════
    console.log("\n=== A. Company-name variants never auto-create a duplicate Company ===\n");
    {
      const REAL_NAME = `ODP Acme Inc. ${RUN_ID}`;
      const real = await prisma.company.create({ data: { name: REAL_NAME, normalizedName: normalizeCompanyName(REAL_NAME) } });
      companyIds.push(real.id);

      const cache = createOrganizationResolutionCache();
      const exactMatch = await resolveCompanyForSync(cache, REAL_NAME);
      check("A1. An exact match still resolves normally (unchanged behavior)", exactMatch?.id === real.id);

      const PUNCTUATION_VARIANT = `ODP Acme Inc ${RUN_ID}`; // no trailing period — different normalizedName
      const punctuationResult = await resolveCompanyForSync(cache, PUNCTUATION_VARIANT);
      check("A2. A punctuation variant of an EXISTING Company does NOT auto-create a duplicate — resolves to null", punctuationResult === null);
      const countAfterPunctuation = await prisma.company.count({ where: { normalizedName: normalizeCompanyName(PUNCTUATION_VARIANT) } });
      check("A2b. ...no Company row exists for the variant string at all", countAfterPunctuation === 0);

      const TYPO_VARIANT = `ODP Acem Inc ${RUN_ID}`; // misspelled — never fuzzy-matched to the real Company
      const typoResult = await resolveCompanyForSync(cache, TYPO_VARIANT);
      check("A3. A spelling/typo variant ALSO does not auto-create — resolves to null (never fuzzy-merged with the real Company)", typoResult === null);
      check("A3b. The real Company is still the ONLY row matching its own exact name", (await prisma.company.count({ where: { normalizedName: normalizeCompanyName(REAL_NAME) } })) === 1);

      const BRAND_NEW_NAME = `ODP Totally New Co ${RUN_ID}`; // no existing match of any kind
      const brandNewResult = await resolveCompanyForSync(cache, BRAND_NEW_NAME);
      check("A4. A genuinely first-ever-seen Company name ALSO does not auto-create — requires an explicit admin action now", brandNewResult === null);
      check("A4b. No row was created for it either", (await prisma.company.count({ where: { normalizedName: normalizeCompanyName(BRAND_NEW_NAME) } })) === 0);

      check("A5. The unresolved name is negative-cached (no repeated DB churn for the same value within one sync run)", cache.unresolvedCompanyNormalizedNames.has(normalizeCompanyName(PUNCTUATION_VARIANT)));
      const secondCallSameUnresolved = await resolveCompanyForSync(cache, PUNCTUATION_VARIANT);
      check("A5b. A second call for the SAME unresolved variant still returns null, consistently (cache hit, not a different code path)", secondCallSameUnresolved === null);
    }

    // ══════════════════════ B. Renamed/obsolete Departments ══════════════════════
    console.log("\n=== B. A renamed Department can never be silently re-created under its old name ===\n");
    {
      const company = await prisma.company.create({ data: { name: `ODP Co B ${RUN_ID}`, normalizedName: normalizeCompanyName(`ODP Co B ${RUN_ID}`) } });
      companyIds.push(company.id);
      const ORIGINAL_NAME = `ODP Mobility ${RUN_ID}`;
      const dept = await prisma.department.create({
        data: { name: ORIGINAL_NAME, slug: `odp-mobility-${RUN_ID}`, normalizedName: normalizeDepartmentName(ORIGINAL_NAME), companyId: company.id },
      });
      departmentIds.push(dept.id);

      const cache = createOrganizationResolutionCache();
      const exactMatch = await resolveDepartmentForSync(cache, company.id, ORIGINAL_NAME);
      check("B1. An exact match still resolves the real Department normally (unchanged behavior)", exactMatch.id === dept.id);

      // The real production incident: an admin renames the Department. Its
      // normalizedName no longer matches the OLD raw Entra value.
      const RENAMED_NAME = `ODP Kinsen Marketing ${RUN_ID}`;
      await prisma.department.update({ where: { id: dept.id }, data: { name: RENAMED_NAME, normalizedName: normalizeDepartmentName(RENAMED_NAME) } });
      const renamedRowBefore = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });

      const cache2 = createOrganizationResolutionCache();
      const afterRenameResolution = await resolveDepartmentForSync(cache2, company.id, ORIGINAL_NAME);
      check("B2. The OLD raw value no longer resolves to (or recreates) the renamed Department", afterRenameResolution.id !== dept.id);
      check("B2b. It falls back to this Company's own Unassigned bucket instead", afterRenameResolution.name === UNASSIGNED_NODE_NAME);
      const staleCount = await prisma.department.count({ where: { companyId: company.id, normalizedName: normalizeDepartmentName(ORIGINAL_NAME) } });
      check("B2c. NO Department row named after the old value was created — the exact bug this round fixes", staleCount === 0);

      const renamedRowAfter = await prisma.department.findUniqueOrThrow({ where: { id: dept.id } });
      check("B3. The renamed Department itself is completely untouched by that resolution attempt (same updatedAt, still renamed)", renamedRowAfter.updatedAt.getTime() === renamedRowBefore.updatedAt.getTime() && renamedRowAfter.name === RENAMED_NAME);
      departmentIds.push(afterRenameResolution.id); // the newly-created Unassigned bucket, for cleanup

      // A genuinely first-ever-seen (never renamed, never existed) raw value
      // under the SAME company also falls back to the SAME Unassigned
      // bucket, never a new row named after itself.
      const BRAND_NEW_DEPT_VALUE = `ODP Totally New Dept ${RUN_ID}`;
      const brandNewDeptResult = await resolveDepartmentForSync(cache2, company.id, BRAND_NEW_DEPT_VALUE);
      check("B4. A brand-new, never-before-seen Department name ALSO falls back to the SAME Unassigned bucket (idempotent, no duplicate Unassigned)", brandNewDeptResult.id === afterRenameResolution.id);
      check("B4b. No row was created named after the brand-new raw value", (await prisma.department.count({ where: { companyId: company.id, normalizedName: normalizeDepartmentName(BRAND_NEW_DEPT_VALUE) } })) === 0);

      // Multi-company preservation: a SECOND, different company's identical
      // unmatched value resolves to ITS OWN Unassigned bucket, never the
      // same shared row as the first company's.
      const company2 = await prisma.company.create({ data: { name: `ODP Co B2 ${RUN_ID}`, normalizedName: normalizeCompanyName(`ODP Co B2 ${RUN_ID}`) } });
      companyIds.push(company2.id);
      const otherCompanyResult = await resolveDepartmentForSync(cache2, company2.id, BRAND_NEW_DEPT_VALUE);
      check("B5. A DIFFERENT company's identical unmatched value resolves to a DIFFERENT, company-scoped Unassigned bucket — never a shared/global one", otherCompanyResult.id !== afterRenameResolution.id);
      check("B5b. ...correctly scoped to that company", otherCompanyResult.name === UNASSIGNED_NODE_NAME);
      departmentIds.push(otherCompanyResult.id);
    }

    // ══════════════════════ C. SQLGeneral-authoritative users ══════════════════════
    console.log("\n=== C. Microsoft can never override an unlocked SQLGeneral-authoritative primary (structural guarantee) ===\n");
    {
      const deptA = await prisma.department.create({ data: { name: `ODP Dept A ${RUN_ID}`, slug: `odp-dept-a-${RUN_ID}`, normalizedName: normalizeDepartmentName(`ODP Dept A ${RUN_ID}`) } });
      const deptB = await prisma.department.create({ data: { name: `ODP Dept B ${RUN_ID}`, slug: `odp-dept-b-${RUN_ID}`, normalizedName: normalizeDepartmentName(`ODP Dept B ${RUN_ID}`) } });
      departmentIds.push(deptA.id, deptB.id);

      // C1. SQLGeneral-authoritative, unlocked -> Microsoft tries to move it away. Must be blocked.
      const userC1 = await makeUser("c1");
      await setPrimaryDepartmentMembership(userC1, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const beforeC1 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: userC1, departmentId: deptA.id } } });
      const resultC1 = await setPrimaryDepartmentMembership(userC1, deptB.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteAutomaticPrimary: true });
      check("C1. Microsoft's attempt to move an unlocked SQLGeneral-sourced primary is BLOCKED (blocked_primary_protected)", resultC1.outcome === "blocked_primary_protected");
      const afterC1 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: userC1, departmentId: deptA.id } } });
      check("C1b. The SQLGeneral-sourced primary is completely untouched (same updatedAt)", afterC1.updatedAt.getTime() === beforeC1.updatedAt.getTime());
      check("C1c. Still primary, still active, still SQLGENERAL_DEPARTMENT-sourced", afterC1.isPrimary === true && afterC1.isActive === true && afterC1.source === MembershipSource.SQLGENERAL_DEPARTMENT);
      const deptBRowC1 = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: userC1, departmentId: deptB.id } } });
      check("C1d. No membership was created at Department B either — zero side effects from the blocked attempt", deptBRowC1 === null);

      // C2. Directionality preserved: SQLGeneral itself CAN still move a user off an unlocked MICROSOFT_DEPARTMENT-sourced primary.
      const userC2 = await makeUser("c2");
      await setPrimaryDepartmentMembership(userC2, deptA.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const resultC2 = await setPrimaryDepartmentMembership(userC2, deptB.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteAutomaticPrimary: true });
      check("C2. SQLGeneral's OWN authority over an unlocked Microsoft-sourced primary is completely unaffected by this round's fix (directionality preserved)", resultC2.outcome === "switched");
      const afterC2 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: userC2, departmentId: deptB.id } } });
      check("C2b. The new primary is Department B, SQLGeneral-sourced, active", afterC2.isPrimary === true && afterC2.isActive === true && afterC2.source === MembershipSource.SQLGENERAL_DEPARTMENT);
      const oldDeptARowC2 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: userC2, departmentId: deptA.id } } });
      check("C2c. The old Microsoft-sourced primary was demoted and deactivated (REQUIRED DO #5 behavior from an earlier round, unchanged)", oldDeptARowC2.isPrimary === false && oldDeptARowC2.isActive === false);

      // C3. Microsoft targeting the SAME department a user is already SQLGeneral-primary-placed in is NOT a "move" — never blocked, follows ordinary role-protection rules.
      const userC3 = await makeUser("c3");
      await setPrimaryDepartmentMembership(userC3, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const resultC3 = await setPrimaryDepartmentMembership(userC3, deptA.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      check("C3. Same-department call is never blocked_primary_protected (not a move at all)", resultC3.outcome !== "blocked_primary_protected");
      const afterC3 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: userC3, departmentId: deptA.id } } });
      check("C3b. Source stays SQLGENERAL_DEPARTMENT — role-already-matches protection left it untouched, never silently reset merely because the caller's source differs", afterC3.source === MembershipSource.SQLGENERAL_DEPARTMENT);

      // C4. A LOCKED SQLGeneral-sourced primary is doubly protected — both conditions can coexist without conflict.
      const userC4 = await makeUser("c4");
      const admin = await makeUser("c4-admin");
      await setPrimaryDepartmentMembership(userC4, deptA.id, MembershipSource.SQLGENERAL_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const membershipSvc = await import("@/lib/services/department-membership-service");
      const lockResult = await membershipSvc.setPrimaryDepartmentLock(userC4, true, admin);
      check("C4. Setup: primary locked", lockResult.ok === true);
      const resultC4 = await setPrimaryDepartmentMembership(userC4, deptB.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      check("C4b. A LOCKED SQLGeneral-sourced primary is ALSO blocked (pre-existing lock protection, unaffected by this round's new condition)", resultC4.outcome === "blocked_primary_protected");
      userIds.push(admin);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      // Every auto-created "Unassigned" fallback department goes through
      // createDepartment()'s own starter-config row set (TicketPriority/
      // TicketStatus, RESTRICT FKs) — same cleanup-ordering requirement as
      // every other test file that resolves/creates a real Department.
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
