/**
 * Architecture/regression guard for the Microsoft organizational-placement
 * fix. This file is NOT the full scenario suite (that's
 * scripts/test-microsoft-organization-placement-integrity.ts) — it exists
 * specifically to keep two things from silently drifting apart in a future
 * refactor:
 *
 *   1. getOrganizationDirectoryEligibility (organization-directory-
 *      eligibility-service.ts) — bulk Directory Sync trust. Requires BOTH
 *      an allowed domain AND Entra `userType === "Member"`. This is the
 *      ONLY trust anchor the full tenant scan has (no prior admission
 *      proof for any of the records it processes), so both checks stay
 *      hard requirements there.
 *
 *   2. isOrganizationPlacementTrustedForAuthenticatedLogin (same file) —
 *      login-time organizational placement. Requires an allowed domain
 *      ONLY. Only ever called for a user who has ALREADY passed real
 *      Microsoft OAuth + lib/auth.ts's own domain-gated `signIn` callback,
 *      so `userType` alone must never be allowed to suppress their
 *      canonical Graph-derived placement — that conflation was the exact
 *      root cause of the "domain-valid user gets no primary department"
 *      bug this guard exists to keep fixed.
 *
 * SECTION A below is a pure source-text check (no DB) — it fails loudly if
 * a future edit reintroduces `eligibility.eligible` as the PRIMARY-
 * placement gate in microsoft-department-sync-service.ts, or lets
 * organization-directory-sync-service.ts start using the narrower
 * authenticated-login predicate for its own (deliberately stricter) bulk
 * scan. SECTION B is the small set of explicitly-requested behavioral
 * regressions, run against a real DATABASE_URL.
 *
 * Usage: npx tsx scripts/test-organization-placement-trust-boundary-guard.ts
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource, MicrosoftMappingSourceType, Role, DepartmentRole } from "@prisma/client";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { setPrimaryDepartmentMembership, syncDepartmentMemberships } from "@/lib/services/department-membership-service";
import { createMapping } from "@/lib/services/microsoft-mapping-service";
import { isOrganizationPlacementTrustedForAuthenticatedLogin } from "@/lib/services/organization-directory-eligibility-service";
import { validateDirectoryUser, type GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { normalizeDepartmentName, normalizeCompanyName } from "@/lib/services/organization-normalization";

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

async function main() {
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — architecture boundary (source-text guard, no DB) ===\n");

  const syncServicePath = path.join(process.cwd(), "lib/services/microsoft-department-sync-service.ts");
  const syncServiceSrc = await fs.readFile(syncServicePath, "utf8");

  check(
    "A1. microsoft-department-sync-service.ts imports isOrganizationPlacementTrustedForAuthenticatedLogin",
    syncServiceSrc.includes("isOrganizationPlacementTrustedForAuthenticatedLogin")
  );
  check(
    "A2. The PRIMARY-placement gate is `if (placementTrust.trusted)` — the login-specific, domain-only predicate",
    /if\s*\(\s*placementTrust\.trusted\s*\)/.test(syncServiceSrc)
  );
  check(
    "A3. REGRESSION GUARD: `eligibility.eligible` is NEVER used as an `if` condition anymore — it must only feed the job-title cache-fill / domain-scoped SECONDARY mapping resolution (eligibleDomain), never gate PRIMARY placement again",
    !/if\s*\(\s*eligibility\.eligible\s*\)/.test(syncServiceSrc)
  );
  check(
    "A4. getOrganizationDirectoryEligibility is still imported (it legitimately still drives eligibleDomain for SECONDARY mapping/job-title scoping — this guard is about WHERE it's used, not removing it)",
    syncServiceSrc.includes("getOrganizationDirectoryEligibility")
  );

  const directorySyncPath = path.join(process.cwd(), "lib/services/organization-directory-sync-service.ts");
  const directorySyncSrc = await fs.readFile(directorySyncPath, "utf8");

  check(
    "A5. REGRESSION GUARD: organization-directory-sync-service.ts (the full tenant scan) does NOT import the narrower, domain-only, authenticated-login predicate — it must keep its own stricter (userType + domain) eligibility semantics",
    !directorySyncSrc.includes("isOrganizationPlacementTrustedForAuthenticatedLogin")
  );
  check(
    "A6. organization-directory-sync-service.ts still uses getOrganizationDirectoryEligibility for its own (stricter) trust decision",
    directorySyncSrc.includes("getOrganizationDirectoryEligibility(")
  );

  // Repo-wide: setPrimaryDepartmentMembership must remain the only runtime
  // writer of User.departmentId, plus the one already-audited, explicitly
  // principled exception (the admin-run, CLI-only reconciliation tool,
  // which mirrors User.departmentId FROM the already-canonical
  // DepartmentMembership.isPrimary row rather than deciding placement
  // itself — see that file's own header comment). A THIRD file appearing
  // here would mean a new, undocumented bypass was introduced.
  const libDir = path.join(process.cwd(), "lib");
  const writers = new Set<string>();
  async function scan(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const src = await fs.readFile(full, "utf8");
        // Matches both `data: { departmentId: x }` and the shorthand
        // `data: { departmentId }` (e.g. setPrimaryDepartmentMembership's
        // own `tx.user.update({ ..., data: { departmentId } })`) — no
        // trailing colon required.
        if (/\.user\.(update|create|upsert)\s*\(\s*\{[\s\S]{0,400}?\bdepartmentId\b/m.test(src)) {
          writers.add(path.relative(process.cwd(), full));
        }
      }
    }
  }
  await scan(libDir);
  const expectedWriters = new Set([
    "lib/services/department-membership-service.ts",
    "lib/services/department-membership-reconciliation-service.ts",
  ]);
  const unexpectedWriters = [...writers].filter((w) => !expectedWriters.has(w));
  check(
    `A7. No new/undocumented writer of User.departmentId exists outside the two known, audited ones (found: ${[...writers].join(", ") || "none"})`,
    unexpectedWriters.length === 0
  );
  check(
    "A8. department-membership-service.ts (the canonical writer) is still among them",
    writers.has("lib/services/department-membership-service.ts")
  );

  // ══════════════════════ SECTION B — behavioral regressions (real DB) ══════════════════════
  console.log("\n=== SECTION B — behavioral regression coverage (real DB) ===\n");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const RUN_ID = Date.now();
  let seq = 0;
  const nextId = (label: string) => `${label}-${RUN_ID}-${seq++}`;

  function mockGraphMe(opts: { companyName: string | null; department: string | null; userType?: string | null; oid: string; mail?: string | null }) {
    (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          id: opts.oid,
          displayName: "Guard Test User",
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

  async function createTestUser(prefix: string) {
    return prisma.user.create({ data: { email: `${prefix}-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT } });
  }

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];
  const mappingIds: string[] = [];

  try {
    console.log("Setup: a pre-existing secondary-only department + mapping (never a valid primary target)\n");
    const secondaryOnlyDept = await prisma.department.create({
      data: { name: `Guard Secondary Dept ${RUN_ID}`, slug: `guard-secondary-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Guard Secondary Dept ${RUN_ID}`) },
    });
    departmentIds.push(secondaryOnlyDept.id);
    const FINANCE_VALUE = `Guard Finance ${RUN_ID}`;
    const mapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: FINANCE_VALUE,
      departmentId: secondaryOnlyDept.id,
      role: Role.USER,
      departmentRole: DepartmentRole.REQUESTER,
    });
    mappingIds.push(mapping.id);

    // B1 — secondary mappings never auto-promote to PRIMARY.
    console.log("\nB1. A secondary Microsoft mapping never auto-promotes itself to PRIMARY\n");
    {
      const user = await createTestUser("b1-secondary-only");
      userIds.push(user.id);
      // A wrong-domain mail -> isOrganizationPlacementTrustedForAuthenticatedLogin
      // is false, so PRIMARY placement is skipped entirely (no row created
      // at all). The PROFILE_DEPARTMENT mapping match, though, is domain-
      // independent (GLOBAL_MAPPING_DOMAIN — see microsoft-mapping-
      // service.ts's buildCandidates) and matches on the raw `department`
      // claim value regardless, so it still fires as this user's ONLY
      // membership — exactly the shape that used to trigger
      // syncDepartmentMemberships's now-disabled auto-promote fallback.
      mockGraphMe({ companyName: `Guard Company ${RUN_ID}`, department: FINANCE_VALUE, mail: `b1-${RUN_ID}@not-allowed.example`, oid: nextId("oidB1") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oidB1-${RUN_ID}`, email: user.email, name: "B1" });
      const memberships = await prisma.departmentMembership.findMany({ where: { userId: user.id } });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      check("B1. The secondary membership exists", memberships.some((m) => m.departmentId === secondaryOnlyDept.id));
      check("B1. It is NOT flagged primary", !memberships.some((m) => m.isPrimary));
      check("B1. User.departmentId stays null (no writer touched it)", after?.departmentId === null);
    }

    // B2 — setPrimaryDepartmentMembership remains the canonical primary writer.
    console.log("\nB2. setPrimaryDepartmentMembership remains the canonical, sole writer of User.departmentId\n");
    {
      const user = await createTestUser("b2-canonical-writer");
      userIds.push(user.id);
      const secondaryDept = await prisma.department.create({
        data: { name: `Guard Canonical Secondary ${RUN_ID}`, slug: `guard-canonical-secondary-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Guard Canonical Secondary ${RUN_ID}`) },
      });
      const primaryDept = await prisma.department.create({
        data: { name: `Guard Canonical Primary ${RUN_ID}`, slug: `guard-canonical-primary-${RUN_ID}`, normalizedName: normalizeDepartmentName(`Guard Canonical Primary ${RUN_ID}`) },
      });
      departmentIds.push(secondaryDept.id, primaryDept.id);

      // syncDepartmentMemberships alone (no setPrimaryDepartmentMembership
      // call at all) must NEVER write User.departmentId, even though it can
      // create/activate membership rows — checked against a DIFFERENT
      // department than the one used below, so there is no ambiguity about
      // which call actually did the writing.
      // Called with its DEFAULT options here (no autoPromoteSoleActiveMembership
      // override) — this is the sole-active-membership tail fallback's
      // ordinary, still-intentional default behavior for a caller with no
      // primary-placement mechanism of its own (see that function's own doc
      // comment): it MAY flip DepartmentMembership.isPrimary. The actual
      // invariant under test is narrower and stronger than "isPrimary never
      // changes" — it's that User.departmentId ONLY ever moves via
      // setPrimaryDepartmentMembership, regardless of what happens to a
      // membership row's own isPrimary flag.
      await syncDepartmentMemberships(user.id, [{ departmentId: secondaryDept.id, role: DepartmentRole.REQUESTER, customRoleId: null, source: MembershipSource.MICROSOFT_GROUP }]);
      const afterSecondaryOnly = await prisma.user.findUnique({ where: { id: user.id } });
      check("B2. syncDepartmentMemberships alone never writes User.departmentId — even when it flips a membership's OWN isPrimary flag via its default sole-membership fallback", afterSecondaryOnly?.departmentId === null);
      const secondaryRow = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user.id, departmentId: secondaryDept.id } } });
      check("B2. ...the membership row itself exists and is active", secondaryRow?.isActive === true);

      // setPrimaryDepartmentMembership is called for a DIFFERENT department
      // — proving it (and only it) is what moves User.departmentId, and
      // that it correctly recognizes+replaces the non-MANUAL primary the
      // step above produced (demoted, not deactivated — no
      // deactivateObsoleteMicrosoftPrimary passed here).
      const result = await setPrimaryDepartmentMembership(user.id, primaryDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
      const afterPrimary = await prisma.user.findUnique({ where: { id: user.id } });
      check("B2. setPrimaryDepartmentMembership is what actually writes User.departmentId", afterPrimary?.departmentId === primaryDept.id);
      const secondaryRowAfter = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user.id, departmentId: secondaryDept.id } } });
      check("B2. The other department's own membership row is demoted (isPrimary:false) but NEVER deleted/deactivated by this call", secondaryRowAfter?.isPrimary === false && secondaryRowAfter?.isActive === true);
    }

    // B3 — the root-cause scenario: userType != "Member", valid domain + companyName + department -> correct primary, same login.
    console.log("\nB3. Domain-valid authenticated user, userType != 'Member', valid companyName+department -> correct primary in the SAME login\n");
    {
      const user = await createTestUser("b3-guest-shaped");
      userIds.push(user.id);
      const COMPANY = `Guard Company ${RUN_ID}`;
      const DEPT = `Guard Real Dept ${RUN_ID}`;
      mockGraphMe({ companyName: COMPANY, department: DEPT, userType: "Guest", oid: nextId("oidB3") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oidB3-${RUN_ID}`, email: user.email, name: "B3" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { company: true, department: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
      check("B3. Company resolved despite userType='Guest'", after?.company?.name === COMPANY);
      check("B3. Department resolved to the REAL Graph department", after?.department?.name === DEPT);
      const primary = await prisma.departmentMembership.findFirst({ where: { userId: user.id, isPrimary: true, isActive: true } });
      check("B3. Exactly the resolved department is primary, in this SAME login (no second login needed)", primary?.departmentId === after?.departmentId);
    }

    // B4 — wrong-domain users receive no placement.
    console.log("\nB4. A genuinely wrong-domain user receives NO organizational placement\n");
    {
      const user = await createTestUser("b4-wrongdomain");
      userIds.push(user.id);
      mockGraphMe({ companyName: `Guard Company ${RUN_ID}`, department: `Guard Dept ${RUN_ID}`, userType: "Member", mail: `b4-${RUN_ID}@not-allowed.example`, oid: nextId("oidB4") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oidB4-${RUN_ID}`, email: user.email, name: "B4" });
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      const primaryCount = await prisma.departmentMembership.count({ where: { userId: user.id, isPrimary: true } });
      check("B4. companyId stays null", after?.companyId === null);
      check("B4. departmentId stays null", after?.departmentId === null);
      check("B4. No primary membership created", primaryCount === 0);
    }

    // B5 — blank Graph `mail` correctly falls back to the authenticated claims email.
    console.log("\nB5. Blank Graph `mail` (empty string, not null) correctly falls back to the authenticated session email\n");
    {
      // Direct unit check of the predicate itself first — the exact `||`
      // vs `??` distinction this guards.
      const withEmptyMail = isOrganizationPlacementTrustedForAuthenticatedLogin({ mail: "", userPrincipalName: null });
      check("B5a. Empty-string mail alone (no fallback applied) correctly fails closed on its own", withEmptyMail.trusted === false);

      const user = await createTestUser("b5-blankmail");
      userIds.push(user.id);
      const DEPT = `Guard Blank Mail Dept ${RUN_ID}`;
      // Graph itself returns mail: "" (empty string) — the fallback to
      // claims.email (this user's own already-verified @kinsen.gr address)
      // must still fire via `||`.
      mockGraphMe({ companyName: `Guard Company ${RUN_ID}`, department: DEPT, mail: "", oid: nextId("oidB5") });
      await syncMicrosoftUserDepartment({ accessToken: "fake", userId: user.id, oid: `oidB5-${RUN_ID}`, email: user.email, name: "B5" });
      const after = await prisma.user.findUnique({ where: { id: user.id }, include: { department: true } });
      if (after?.companyId) companyIds.push(after.companyId);
      if (after?.departmentId) departmentIds.push(after.departmentId);
      check("B5b. End-to-end: empty-string Graph mail still resolves organizational placement via the claims-email fallback", after?.department?.name === DEPT);
    }

    // B6 — full Directory Sync keeps its stricter existing eligibility semantics.
    console.log("\nB6. Full Directory Sync's validateDirectoryUser keeps its stricter (userType + domain) semantics — unaffected by the login-sync fix\n");
    {
      const guestRaw: GraphDirectoryUser = {
        id: `guard-guest-${RUN_ID}`,
        mail: `guard-guest-${RUN_ID}@kinsen.gr`, // domain-valid on its own
        userPrincipalName: null,
        userType: "Guest",
        companyName: `Guard Company ${RUN_ID}`,
        department: `Guard Dept ${RUN_ID}`,
      };
      const guestResult = validateDirectoryUser(guestRaw);
      check("B6a. A Guest-shaped record with an otherwise domain-valid mail is still REJECTED by the Directory Sync's own validation", !guestResult.valid && (guestResult as { reason: string }).reason === "guest_or_service_account");

      const memberRaw: GraphDirectoryUser = {
        id: `guard-member-${RUN_ID}`,
        mail: `guard-member-${RUN_ID}@kinsen.gr`,
        userPrincipalName: null,
        userType: "Member",
        companyName: `Guard Company ${RUN_ID}`,
        department: `Guard Dept ${RUN_ID}`,
      };
      const memberResult = validateDirectoryUser(memberRaw);
      check("B6b. A genuine Member with a valid domain is still accepted (sanity check — the stricter rule isn't over-broad either)", memberResult.valid === true);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["mappings", () => (mappingIds.length ? prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } }) : Promise.resolve())],
      ["ticketPriorities (explicit)", () => (departmentIds.length ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
      ["ticketStatuses (explicit)", () => (departmentIds.length ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }) : Promise.resolve())],
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
