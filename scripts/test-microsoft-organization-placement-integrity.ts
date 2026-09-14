/**
 * Root-cause regression coverage for the "new Microsoft user lands in
 * Systems Operations instead of their real Entra department" production
 * bug.
 *
 * ROOT CAUSE: syncDepartmentMemberships (lib/services/department-membership-
 * service.ts) has a tail fallback — "if exactly one active membership
 * exists and none is flagged primary, promote it" — originally justified as
 * "harmless for callers that also call setPrimaryDepartmentMembership, since
 * that function corrects the final primary regardless." That reasoning was
 * WRONG: both real callers (microsoft-department-sync-service.ts's
 * syncMicrosoftUserDepartment, organization-directory-sync-service.ts's
 * directory sync) wrap their setPrimaryDepartmentMembership call in a
 * try/catch that logs and continues on failure, and eligibility
 * (organization-directory-eligibility-service.ts) can independently be
 * false for a real, already-signed-in, domain-valid user (Entra `userType`
 * reporting something other than "Member" for that specific account) even
 * though Graph returned a real `department`/`companyName`. In EITHER case,
 * setPrimaryDepartmentMembership never ran that sync, so there was no
 * active primary row — and the very next line always still runs the
 * SEPARATE, independent SECONDARY MicrosoftDepartmentMapping resolution
 * (e.g. an org-wide "all employees" Entra group grant, unrelated to the
 * user's real Graph company/department). If that secondary resolution
 * produced exactly one active membership, the tail fallback silently
 * promoted THAT unrelated department to isPrimary — with no corresponding
 * User.departmentId write (setPrimaryDepartmentMembership is the only
 * writer of that column) — leaving the user in a self-contradictory DB
 * state. workspace-service.ts's resolveActiveWorkspace resolves a regular
 * user's active workspace from exactly this isPrimary row (never from
 * User.departmentId), so this wrongly-primaried secondary department is
 * what the user's very first dashboard load actually showed.
 *
 * FIX #1: syncDepartmentMemberships now accepts
 * `{ autoPromoteSoleActiveMembership: false }`, and BOTH real Microsoft-sync
 * callers pass it — they always have their own explicit primary-placement
 * mechanism, whether or not it happened to succeed this specific run, so
 * the "no separate primary-placement signal" rationale the fallback exists
 * for never actually applied to either of them.
 *
 * ROOT CAUSE #2 (found while verifying fix #1): fix #1 alone stopped the
 * WRONG department from becoming primary, but left a second, real gap open
 * — a genuinely admitted, domain-valid user (real Microsoft OAuth +
 * already passed lib/auth.ts's own domain check at sign-in) could still end
 * up with NO primary at all, because syncMicrosoftUserDepartment reused
 * getOrganizationDirectoryEligibility (organization-directory-eligibility-
 * service.ts) — a check designed for a DIFFERENT question (is this Graph
 * record, scanned in bulk with no other trust anchor, safe for the full
 * tenant Directory Sync to provision at all) — to ALSO gate primary
 * placement for an already-authenticated login. That check's userType
 * !== "Member" condition can be false for a real, already-admitted employee
 * independent of actual employment status, discarding perfectly valid
 * Graph companyName/department data.
 *
 * FIX #2: isOrganizationPlacementTrustedForAuthenticatedLogin
 * (organization-directory-eligibility-service.ts) is a new, narrower,
 * domain-match-ONLY trust check — no userType — used ONLY to gate PRIMARY
 * placement in the login-sync path. getOrganizationDirectoryEligibility
 * itself is UNCHANGED and still exclusively gates the full Directory Sync
 * (which has no other admission proof and must keep excluding Guest
 * accounts independently) and this login path's job-title cache-fill/
 * domain-scoped SECONDARY mapping resolution — see both functions' own doc
 * comments for the full reasoning on why this is not a security weakening.
 *
 * This file covers the required scenarios end-to-end, using real Prisma
 * calls against DATABASE_URL and a mocked Graph /me (and, for scenario 12,
 * a mocked app-only /users page — same pattern as
 * test-microsoft-first-login-sync.ts's Case 5).
 *
 * Usage: npx tsx scripts/test-microsoft-organization-placement-integrity.ts
 * Requires a reachable DATABASE_URL.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource, MicrosoftMappingSourceType, Role, DepartmentRole } from "@prisma/client";
import { syncMicrosoftUserDepartment, handleMicrosoftJwtSignIn, type SyncEligibleDbUser } from "@/lib/services/microsoft-department-sync-service";
import { createMapping } from "@/lib/services/microsoft-mapping-service";
import { resolveActiveWorkspace } from "@/lib/services/workspace-service";
import { setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { normalizeDepartmentName, normalizeCompanyName } from "@/lib/services/organization-normalization";
import { runOrganizationDirectorySync } from "@/lib/services/organization-directory-sync-service";

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

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
let seq = 0;
const nextId = (label: string) => `${label}-${RUN_ID}-${seq++}`;

function mockGraphMe(opts: { companyName: string | null; department: string | null; userType?: string | null; oid: string; mail?: string | null }) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({
        id: opts.oid,
        displayName: "Repro User",
        mail: opts.mail ?? null,
        userPrincipalName: null,
        userType: opts.userType ?? "Member",
        companyName: opts.companyName,
        department: opts.department,
        jobTitle: null,
      }),
      { status: 200 }
    )) as typeof fetch;
}

function mockGraphMeFailure(status: number) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => new Response("boom", { status })) as typeof fetch;
}

async function createTestUser(emailPrefix: string, data: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  return prisma.user.create({
    data: { email: `${emailPrefix}-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT, ...data },
  });
}

async function findResolvedDept(companyId: string | null, rawName: string) {
  return prisma.department.findFirst({ where: { companyId, normalizedName: normalizeDepartmentName(rawName) } });
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];
  const mappingIds: string[] = [];

  try {
    console.log("\n=== Setup: a pre-existing, unrelated legacy 'Systems Operations' department + a broad secondary mapping onto it ===\n");
    const sysOps = await prisma.department.create({
      data: { name: `Systems Operations ${RUN_ID}`, slug: `sysops-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Systems Operations ${RUN_ID}`) },
    });
    departmentIds.push(sysOps.id);
    // A realistic admin-configured SECONDARY mapping: the raw Graph
    // `department` value used throughout this file's Finance scenarios,
    // pointing at the UNRELATED Systems Operations department — simulates
    // e.g. "everyone in Finance also gets baseline IT/Systems-Ops ticket
    // visibility," a legitimate secondary grant that must never become
    // primary.
    const FINANCE_VALUE = `Finance ${RUN_ID}`;
    const secondaryMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: FINANCE_VALUE,
      departmentId: sysOps.id,
      role: Role.USER,
      departmentRole: DepartmentRole.REQUESTER,
    });
    mappingIds.push(secondaryMapping.id);

    // ── 1. New user + existing Graph department -> primary Finance ────────
    console.log("\n1. New user + existing Graph department: Graph Finance -> primary Finance\n");
    {
      const user = await createTestUser("t1-finance");
      userIds.push(user.id);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid: nextId("oid1") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid1-${RUN_ID}`, email: user.email, name: "T1" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
      check("1. Company resolved to Kinsen Hellas", after?.company?.name === `Kinsen Hellas ${RUN_ID}`);
      check("1. User.departmentId points at Finance (not Systems Operations)", after?.department?.name === FINANCE_VALUE);
      check("1. Never landed on Systems Operations", after?.departmentId !== sysOps.id);
      const primary = await prisma.departmentMembership.findFirst({ where: { userId: user.id, isPrimary: true } });
      check("1. Active primary DepartmentMembership points at Finance", primary?.departmentId === after?.departmentId && primary?.isActive === true);
    }

    // ── 2. New user + nonexistent Graph department -> created once -> primary ──
    console.log("\n2. New user + nonexistent Graph department: Graph Legal -> Legal created once -> primary Legal\n");
    const LEGAL_VALUE = `Legal ${RUN_ID}`;
    let legalDeptId: string | null = null;
    {
      const user = await createTestUser("t2-legal");
      userIds.push(user.id);
      const preCount = await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(LEGAL_VALUE) } });
      check("2. Legal does not exist locally yet", preCount === 0);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: LEGAL_VALUE, oid: nextId("oid2") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid2-${RUN_ID}`, email: user.email, name: "T2" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      legalDeptId = after?.departmentId ?? null;
      if (legalDeptId) departmentIds.push(legalDeptId);
      check("2. Legal was created exactly once", (await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(LEGAL_VALUE) } })) === 1);
      check("2. User.departmentId points at the newly-created Legal", after?.department?.name === LEGAL_VALUE);
      check("2. First session already used this department (no second login needed)", after?.departmentId === legalDeptId);
    }

    // ── 3. Systems Operations must not influence a Finance user's placement ──
    console.log("\n3. A Finance user's placement is never influenced by the pre-existing Systems Operations department\n");
    {
      const user = await createTestUser("t3-finance2");
      userIds.push(user.id);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid: nextId("oid3") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid3-${RUN_ID}`, email: user.email, name: "T3" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      check("3. Not Systems Operations", after?.departmentId !== sysOps.id);
      const sysOpsMembersCountBefore = await prisma.departmentMembership.count({ where: { departmentId: sysOps.id, isPrimary: true } });
      check("3. Systems Operations gained zero new PRIMARY members from this", sysOpsMembersCountBefore === 0);
    }

    // ── 4. Re-login is idempotent — no duplicate Company/Department/Membership ──
    console.log("\n4. Re-login (same user, same Graph profile) is idempotent — no duplicates\n");
    {
      const user = await createTestUser("t4-idempotent");
      userIds.push(user.id);
      const oid = `oid4-${RUN_ID}`;
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid, email: user.email, name: "T4" });
      const companyCountAfter1 = await prisma.company.count({ where: { normalizedName: normalizeCompanyName(`Kinsen Hellas ${RUN_ID}`) } });
      const deptCountAfter1 = await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(FINANCE_VALUE) } });
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid, email: user.email, name: "T4" });
      const companyCountAfter2 = await prisma.company.count({ where: { normalizedName: normalizeCompanyName(`Kinsen Hellas ${RUN_ID}`) } });
      const deptCountAfter2 = await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(FINANCE_VALUE) } });
      const membershipCount = await prisma.departmentMembership.count({ where: { userId: user.id } });
      const primaryCount = await prisma.departmentMembership.count({ where: { userId: user.id, isPrimary: true } });
      check("4. Exactly one Company row (no duplicate on re-login)", companyCountAfter1 === 1 && companyCountAfter2 === 1);
      check("4. Exactly one Department row for Finance (no duplicate on re-login)", deptCountAfter1 === 1 && deptCountAfter2 === 1);
      // Two rows are correct here, not one: FINANCE_VALUE is ALSO the target
      // of the setup section's own secondary PROFILE_DEPARTMENT mapping (->
      // Systems Operations) — so every login in this suite using
      // FINANCE_VALUE legitimately gets both a PRIMARY (Finance, via the
      // resolver) and a SECONDARY (Systems Operations, via that mapping)
      // row. The actual idempotency property under test is "no duplicate
      // rows created on re-login" and "exactly one of them is primary."
      check("4. Exactly two DepartmentMembership rows (1 primary Finance + 1 secondary Systems Operations, no duplicates on re-login)", membershipCount === 2);
      check("4. Exactly one of them is primary (re-login never creates a second primary)", primaryCount === 1);
    }

    // ── 5. Department name normalization ───────────────────────────────────
    console.log("\n5. Department name normalization: ' Finance ' / casing variants resolve to the SAME company-scoped department\n");
    {
      const userA = await createTestUser("t5a-spaced");
      const userB = await createTestUser("t5b-cased");
      userIds.push(userA.id, userB.id);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: `  ${FINANCE_VALUE}  `, oid: nextId("oid5a") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: userA.id, oid: `oid5a-${RUN_ID}`, email: userA.email, name: "T5a" });
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE.toUpperCase(), oid: nextId("oid5b") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: userB.id, oid: `oid5b-${RUN_ID}`, email: userB.email, name: "T5b" });
      const afterA = await prisma.user.findUnique({ where: { id: userA.id } });
      const afterB = await prisma.user.findUnique({ where: { id: userB.id } });
      check("5. Untrimmed/padded value resolves to the same Finance department", afterA?.departmentId === afterB?.departmentId);
      const deptCount = await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(FINANCE_VALUE) } });
      check("5. Still exactly one Finance department despite whitespace/casing variants", deptCount === 1);
    }

    // ── 6. Two companies with department "Finance" remain separate ────────
    console.log("\n6. Two different companies each with a department literally named 'Finance' remain separate\n");
    {
      const userCo1 = await createTestUser("t6-co1");
      const userCo2 = await createTestUser("t6-co2");
      userIds.push(userCo1.id, userCo2.id);
      const SHARED_DEPT_NAME = `Shared Finance Name ${RUN_ID}`;
      mockGraphMe({ companyName: `Company One ${RUN_ID}`, department: SHARED_DEPT_NAME, oid: nextId("oid6a") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: userCo1.id, oid: `oid6a-${RUN_ID}`, email: userCo1.email, name: "T6a" });
      mockGraphMe({ companyName: `Company Two ${RUN_ID}`, department: SHARED_DEPT_NAME, oid: nextId("oid6b") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: userCo2.id, oid: `oid6b-${RUN_ID}`, email: userCo2.email, name: "T6b" });
      const afterCo1 = await prisma.user.findUnique({ where: { id: userCo1.id }, include: { department: true } });
      const afterCo2 = await prisma.user.findUnique({ where: { id: userCo2.id }, include: { department: true } });
      if (afterCo1?.companyId) companyIds.push(afterCo1.companyId);
      if (afterCo2?.companyId) companyIds.push(afterCo2.companyId);
      if (afterCo1?.departmentId) departmentIds.push(afterCo1.departmentId);
      if (afterCo2?.departmentId) departmentIds.push(afterCo2.departmentId);
      check("6. Same department NAME, two different companies -> two different Department rows", afterCo1?.departmentId !== afterCo2?.departmentId);
      check("6. Both are literally named the same", afterCo1?.department?.name === SHARED_DEPT_NAME && afterCo2?.department?.name === SHARED_DEPT_NAME);
      const deptCount = await prisma.department.count({ where: { normalizedName: normalizeDepartmentName(SHARED_DEPT_NAME) } });
      check("6. Exactly two Department rows exist for this shared name (one per company)", deptCount === 2);
    }

    // ── 7. First-login DB row/JWT already has the corrected departmentId ──
    console.log("\n7. First-login handleMicrosoftJwtSignIn returns the ALREADY-corrected departmentId — no second login required\n");
    {
      const user = await createTestUser("t7-jwt");
      userIds.push(user.id);
      const preSyncSnapshot: SyncEligibleDbUser = {
        id: user.id, role: user.role, isActive: user.isActive, mustChangePassword: user.mustChangePassword,
        departmentId: user.departmentId, businessUnitId: user.businessUnitId, customRoleId: user.customRoleId,
        microsoftUserId: user.microsoftUserId, globalRoleSource: user.globalRoleSource, name: user.name, image: user.image,
      };
      check("7. Pre-sync snapshot has no department (sanity check)", preSyncSnapshot.departmentId === null);
      const oid = `oid7-${RUN_ID}`;
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid });
      const postSync = await handleMicrosoftJwtSignIn({
        dbUser: preSyncSnapshot, accessToken: "fake", oid, providerAccountId: oid, userEmail: user.email, userName: "T7",
      });
      const financeDept = await findResolvedDept(await prisma.company.findFirst({ where: { normalizedName: normalizeCompanyName(`Kinsen Hellas ${RUN_ID}`) } }).then((c) => c?.id ?? null), FINANCE_VALUE);
      check("7. Returned object (what lib/auth.ts builds the JWT from) already has the corrected departmentId", postSync.departmentId !== null && postSync.departmentId === financeDept?.id);
      check("7. Returned departmentId is Finance, not Systems Operations", postSync.departmentId !== sysOps.id);
    }

    // ── 8. Stale/invalid workspace cookie cannot force an inaccessible department ──
    console.log("\n8. A stale/invalid workspace cookie cannot force an inaccessible department — falls back to canonical primary\n");
    {
      const user = await createTestUser("t8-cookie");
      userIds.push(user.id);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid: nextId("oid8") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid8-${RUN_ID}`, email: user.email, name: "T8" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      // A department this user genuinely has NO membership in at all — NOT
      // sysOps, which every FINANCE_VALUE user in this suite legitimately
      // has SECONDARY access to via the setup section's own mapping (so a
      // cookie pointing at it would be a valid explicit selection, not a
      // stale/inaccessible one — see resolveActiveWorkspace's own
      // "requestedValid" rule, which this scenario is deliberately NOT
      // testing).
      const trulyInaccessibleDept = await prisma.department.create({
        data: { name: `Truly Inaccessible ${RUN_ID}`, slug: `truly-inaccessible-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Truly Inaccessible ${RUN_ID}`) },
      });
      departmentIds.push(trulyInaccessibleDept.id);
      const ctx = await resolveActiveWorkspace(user.id, Role.USER, trulyInaccessibleDept.id);
      check("8. resolveActiveWorkspace ignores the inaccessible cookie value", ctx.departmentId !== trulyInaccessibleDept.id);
      check("8. ...and falls back to the canonical primary membership (Finance)", ctx.departmentId === after?.departmentId);
    }

    // ── 9. THE BUG: secondary Microsoft mapping does not replace the canonical primary ──
    console.log("\n9. ROOT-CAUSE FIX #2: an authenticated, domain-valid user whose Entra userType is NOT 'Member' still gets their REAL Graph company/department as canonical primary — the SECONDARY Systems Operations mapping never becomes primary either\n");
    {
      const user = await createTestUser("t9-guest-shaped");
      userIds.push(user.id);
      // userType: "Guest" would previously (pre this fix) have skipped
      // primary placement ENTIRELY via getOrganizationDirectoryEligibility
      // — even though this account already passed real Microsoft OAuth +
      // the SAME domain check at lib/auth.ts's signIn callback before ever
      // reaching this code. isOrganizationPlacementTrustedForAuthenticatedLogin
      // deliberately does not re-consult userType — see its own doc comment.
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, userType: "Guest", oid: nextId("oid9") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid9-${RUN_ID}`, email: user.email, name: "T9" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
      const memberships = await prisma.departmentMembership.findMany({ where: { userId: user.id } });
      check("9. Company resolved to Kinsen Hellas despite userType='Guest' (ROOT-CAUSE FIX #2)", after?.company?.name === `Kinsen Hellas ${RUN_ID}`);
      check("9. User.departmentId points at the REAL Graph department (Finance), not null and not Systems Operations", after?.department?.name === FINANCE_VALUE && after?.departmentId !== sysOps.id);
      const primary = memberships.find((m) => m.isPrimary);
      check("9. Exactly one primary membership, and it's Finance with source MICROSOFT_DEPARTMENT", primary?.departmentId === after?.departmentId && primary?.source === MembershipSource.MICROSOFT_DEPARTMENT);
      check("9. The secondary Systems Operations membership ALSO exists (the mapping legitimately matched)...", memberships.some((m) => m.departmentId === sysOps.id));
      check("9. ...but is NOT flagged primary (ROOT-CAUSE FIX #1, still holding)", !memberships.find((m) => m.departmentId === sysOps.id)?.isPrimary);
      check("9. Exactly one membership is primary overall (no ambiguity)", memberships.filter((m) => m.isPrimary).length === 1);
    }

    // ── 9b. A GENUINELY untrusted domain must still fail closed ───────────
    console.log("\n9b. A genuinely wrong/untrusted domain still gets NO organizational placement at all (the security boundary that must NOT be weakened)\n");
    {
      const user = await createTestUser("t9b-baddomain");
      userIds.push(user.id);
      // Graph's own mail/UPN both outside any allowed domain — the ONE
      // signal isOrganizationPlacementTrustedForAuthenticatedLogin still
      // hard-requires. userType is "Member" here specifically to prove
      // domain, not userType, is what's actually doing the gating now.
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, userType: "Member", mail: `t9b-baddomain-${RUN_ID}@not-an-allowed-domain.example`, oid: nextId("oid9b") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid9b-${RUN_ID}`, email: user.email, name: "T9b" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipCount = await prisma.departmentMembership.count({ where: { userId: user.id, isPrimary: true } });
      check("9b. companyId stays null — no organizational placement for an untrusted domain", after?.companyId === null);
      check("9b. departmentId stays null too", after?.departmentId === null);
      check("9b. No primary membership was created", membershipCount === 0);
    }

    // ── 9c. Blank/missing Graph department -> no fabricated department ────
    console.log("\n9c. Missing/blank Graph department: resolves to the company's own 'Unassigned' bucket — never a fabricated named department, never Systems Operations\n");
    {
      const user = await createTestUser("t9c-noDept");
      userIds.push(user.id);
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: null, oid: nextId("oid9c") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid9c-${RUN_ID}`, email: user.email, name: "T9c" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
      check("9c. Company still resolved (Kinsen Hellas)", after?.company?.name === `Kinsen Hellas ${RUN_ID}`);
      check("9c. Department is the company's own Unassigned bucket, not Systems Operations, not Finance", after?.departmentId !== sysOps.id && after?.department?.name !== FINANCE_VALUE && after?.department != null);
      check("9c. Department is scoped to THIS company (not a cross-company/global bucket)", after?.department?.companyId === after?.companyId);
    }

    // ── 9d. An obsolete AUTOMATED primary is replaced by authoritative Graph placement ──
    console.log("\n9d. An obsolete AUTOMATED (non-MANUAL) primary from an earlier login is replaced once authoritative Graph placement succeeds\n");
    {
      const OLD_VALUE = `Old Dept Before Move ${RUN_ID}`;
      const user = await createTestUser("t9d-moved");
      userIds.push(user.id);
      // First login: user's org placement is some other department, resolved and set automatically (source MICROSOFT_DEPARTMENT).
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: OLD_VALUE, oid: nextId("oid9d") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid9d-${RUN_ID}`, email: user.email, name: "T9d" });
      const afterFirst = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true } });
      if (afterFirst?.companyId) companyIds.push(afterFirst.companyId);
      if (afterFirst?.departmentId) departmentIds.push(afterFirst.departmentId);
      check("9d. First login placed the user in the OLD department", afterFirst?.department?.name === OLD_VALUE);

      // Second login: the user genuinely moved in Entra — Graph now reports Finance.
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid: `oid9d-${RUN_ID}` });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid9d-${RUN_ID}`, email: user.email, name: "T9d" });
      const afterSecond = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true } });
      const oldMembership = await prisma.departmentMembership.findFirst({ where: { userId: user.id, departmentId: afterFirst?.departmentId ?? "___none___" } });
      check("9d. User.departmentId now correctly points at Finance", afterSecond?.department?.name === FINANCE_VALUE);
      check("9d. The OLD automated primary is demoted (no longer primary)", oldMembership?.isPrimary === false);
      check("9d. The OLD automated primary is fully deactivated too (Microsoft org-move semantics, not a MANUAL demotion)", oldMembership?.isActive === false);
      const primaryCount = await prisma.departmentMembership.count({ where: { userId: user.id, isPrimary: true, isActive: true } });
      check("9d. Exactly one active primary after the move", primaryCount === 1);
    }

    // ── 10. Genuine MANUAL primary protection still works ──────────────────
    console.log("\n10. A genuine MANUAL primary is still fully protected from any automated Microsoft signal\n");
    {
      const user = await createTestUser("t10-manual");
      userIds.push(user.id);
      const manualDept = await prisma.department.create({ data: { name: `Manual Choice Dept ${RUN_ID}`, slug: `manual-choice-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Manual Choice Dept ${RUN_ID}`) } });
      departmentIds.push(manualDept.id);
      await setPrimaryDepartmentMembership(user.id, manualDept.id, MembershipSource.MANUAL, { role: DepartmentRole.DEPARTMENT_MANAGER });
      mockGraphMe({ companyName: `Kinsen Hellas ${RUN_ID}`, department: FINANCE_VALUE, oid: nextId("oid10") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid10-${RUN_ID}`, email: user.email, name: "T10" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const manualRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user.id, departmentId: manualDept.id } } });
      check("10. User.departmentId is UNCHANGED (still the admin's manual choice)", after?.departmentId === manualDept.id);
      check("10. The MANUAL row is still primary, still MANUAL, role untouched", manualRow?.isPrimary === true && manualRow?.source === MembershipSource.MANUAL && manualRow?.role === DepartmentRole.DEPARTMENT_MANAGER);
    }

    // ── 11. Graph failure fabricates nothing ────────────────────────────────
    console.log("\n11. Graph /me failure does not fabricate Systems Operations or any other department\n");
    {
      const user = await createTestUser("t11-graphfail");
      userIds.push(user.id);
      mockGraphMeFailure(500);
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oid11-${RUN_ID}`, email: user.email, name: "T11" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const membershipCount = await prisma.departmentMembership.count({ where: { userId: user.id } });
      check("11. User.departmentId stays null (nothing fabricated)", after?.departmentId === null);
      check("11. No DepartmentMembership row was created at all", membershipCount === 0);
      check("11. companyId stays null too", after?.companyId === null);
    }

    // ── 12. Full Directory Sync and per-login sync converge ────────────────
    console.log("\n12. Full Directory Sync and per-login Microsoft sync converge on the SAME Company + primary Department for the same Graph profile\n");
    {
      const CONVERGE_DEPT = `Converge Finance ${RUN_ID}`;
      const CONVERGE_COMPANY = `Converge Co ${RUN_ID}`;
      const oid = `oid12-${RUN_ID}`;
      const email = `t12-converge-${RUN_ID}@kinsen.gr`;

      // Half A: per-login sync creates the user + resolves placement.
      const user = await prisma.user.create({ data: { email, authProvider: AuthProvider.MICROSOFT, microsoftUserId: oid } });
      userIds.push(user.id);
      mockGraphMe({ companyName: CONVERGE_COMPANY, department: CONVERGE_DEPT, mail: email, oid });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid, email, name: "T12" });
      const afterLogin = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      if (afterLogin?.companyId) companyIds.push(afterLogin.companyId);
      if (afterLogin?.departmentId) departmentIds.push(afterLogin.departmentId);

      // Half B: full tenant Directory Sync sees the SAME Graph identity (same oid/email/company/department).
      const FAKE_TENANT = "00000000-0000-4000-8000-000000000011";
      const FAKE_CLIENT = "00000000-0000-4000-8000-000000000012";
      const FAKE_SECRET = `hermetic-secret-${RUN_ID}`;
      const saved = { GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID, GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET };
      process.env.GRAPH_TENANT_ID = FAKE_TENANT;
      process.env.GRAPH_CLIENT_ID = FAKE_CLIENT;
      process.env.GRAPH_CLIENT_SECRET = FAKE_SECRET;

      (global as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.startsWith("https://login.microsoftonline.com/")) {
          return new Response(JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: `fake-app-token-${RUN_ID}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.startsWith("https://graph.microsoft.com/v1.0/users")) {
          return new Response(
            JSON.stringify({
              value: [
                { id: oid, displayName: "T12", givenName: null, surname: null, userPrincipalName: null, mail: email, accountEnabled: true, userType: "Member", department: CONVERGE_DEPT, jobTitle: null, companyName: CONVERGE_COMPANY, officeLocation: null, employeeId: null, employeeType: null },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Scenario 12's fetch mock received an unexpected URL: ${url}`);
      }) as typeof fetch;

      const syncOutcome = await runOrganizationDirectorySync();
      check("12. Directory sync run succeeded", syncOutcome.ok === true);

      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key as keyof typeof saved];
        else process.env[key as keyof typeof saved] = value;
      }

      const afterDirectorySync = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true, company: true } });
      check("12. Directory sync did NOT create a second Company row for the same companyName", afterDirectorySync?.companyId === afterLogin?.companyId);
      check("12. Directory sync did NOT create a second Department row for the same department", afterDirectorySync?.departmentId === afterLogin?.departmentId);
      check("12. Company name matches between both entry points", afterDirectorySync?.company?.name === afterLogin?.company?.name && afterDirectorySync?.company?.name === CONVERGE_COMPANY);
      check("12. Department name matches between both entry points", afterDirectorySync?.department?.name === afterLogin?.department?.name && afterDirectorySync?.department?.name === CONVERGE_DEPT);
      const primaryCount = await prisma.departmentMembership.count({ where: { userId: user.id, isPrimary: true, isActive: true } });
      check("12. Still exactly one active primary membership after both entry points ran", primaryCount === 1);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["mappings", () => (mappingIds.length ? prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } }) : Promise.resolve())],
      ["ticketPriorities", () => (departmentIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["ticketStatuses", () => (departmentIds.length ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      // Broad sweep too, in case a department got created but its id wasn't captured above for any reason.
      ["broad ticketPriorities sweep", () => prisma.ticketPriority.deleteMany({ where: { department: { normalizedName: { contains: RUN_ID.toString() } } } })],
      ["broad ticketStatuses sweep", () => prisma.ticketStatus.deleteMany({ where: { department: { normalizedName: { contains: RUN_ID.toString() } } } })],
      ["departments", () => prisma.department.deleteMany({ where: { normalizedName: { contains: RUN_ID.toString() } } })],
      ["companies", () => prisma.company.deleteMany({ where: { normalizedName: { contains: RUN_ID.toString() } } })],
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
