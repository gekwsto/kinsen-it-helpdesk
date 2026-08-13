/**
 * Regression coverage for extending TicketApp's Microsoft/Entra integration
 * to a second allowed organization domain (saracakis.gr, alongside the
 * existing kinsen.gr) — lib/allowed-email-domains.ts is the new shared,
 * typed source of truth both the login gate (lib/auth.ts/lib/auth.config.ts)
 * and organization-sync eligibility
 * (lib/services/organization-directory-eligibility-service.ts) now read,
 * replacing what used to be two independently-duplicated single-domain
 * constants (lib/auth.ts/lib/auth.config.ts's own ALLOWED_DOMAIN, and
 * organization-directory-eligibility-service.ts's own
 * ORGANIZATION_SYNC_ALLOWED_DOMAIN).
 *
 * Sets ALLOWED_EMAIL_DOMAIN to "kinsen.gr,saracakis.gr" explicitly, BEFORE
 * any import — mirrors the exact pattern every other
 * scripts/test-microsoft-*.ts script already uses to pin its own
 * deterministic domain configuration, independent of whatever this dev
 * box's real .env happens to contain.
 *
 * Usage: npx tsx scripts/test-microsoft-saracakis-multi-domain.ts
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * one isn't configured/reachable, rather than failing confusingly.
 */
process.env.ALLOWED_EMAIL_DOMAIN = "kinsen.gr,saracakis.gr";

import { prisma } from "@/lib/prisma";
import { AuthProvider, MicrosoftMappingSourceType, Role } from "@prisma/client";
import { isAllowedOrganizationEmail, getAllowedOrganizationEmailDomain, ALLOWED_ORGANIZATION_EMAIL_DOMAINS } from "@/lib/allowed-email-domains";
import { getOrganizationDirectoryEligibility } from "@/lib/services/organization-directory-eligibility-service";
import { handleMicrosoftJwtSignIn } from "@/lib/services/microsoft-department-sync-service";
import {
  validateDirectoryUser,
  runOrganizationDirectorySync,
} from "@/lib/services/organization-directory-sync-service";
import { fetchAllGraphUserDirectoryValues, normalizeJobTitleValue } from "@/lib/services/microsoft-directory-service";
import { createMapping, MicrosoftMappingValidationError } from "@/lib/services/microsoft-mapping-service";
import { listDepartments } from "@/lib/services/department-service";

process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

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

/** Same pattern as scripts/test-microsoft-first-login-sync.ts's mockGraphMeOnce — unconditionally answers any fetch (GET /me, the profile-photo check, etc.) with this one GET /me payload. */
function mockGraphMeOnce(email: string, oid: string, jobTitle: string | null = null) {
  global.fetch = (async () =>
    jsonResponse(200, {
      id: oid,
      displayName: "Test User",
      mail: email,
      userPrincipalName: null,
      department: null,
      jobTitle,
    })) as typeof fetch;
}

/** Same pattern as scripts/test-organization-graph-sync.ts's installTokenMock — routes the app-only token exchange separately from the actual Graph call under test. */
function installTenantUsersMock(users: unknown[]) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "mock-app-token" });
    }
    return jsonResponse(200, { value: users });
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const userIds: string[] = [];
  const customRoleIds: string[] = [];
  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;

  try {
    // ══════════════════════ A. LOGIN DOMAIN POLICY ══════════════════════
    console.log("\n=== A. Microsoft login domain policy (isAllowedOrganizationEmail — the exact function lib/auth.ts's signIn callback and lib/auth.config.ts's authorized callback both call) ===\n");
    check("A. user@kinsen.gr -> allowed", isAllowedOrganizationEmail("user@kinsen.gr") === true);
    check("A. user@saracakis.gr -> allowed", isAllowedOrganizationEmail("user@saracakis.gr") === true);
    check("A. Mixed/upper case User@SARACAKIS.GR -> allowed (case-insensitive)", isAllowedOrganizationEmail("User@SARACAKIS.GR") === true);
    check("A. Unrelated domain user@example.com -> rejected", isAllowedOrganizationEmail("user@example.com") === false);
    // The exact adversarial suffix-spoofing shape the spec calls out —
    // never a substring/loose match.
    check("A. user@saracakis.gr.fake.com -> rejected (does not END with @saracakis.gr)", isAllowedOrganizationEmail("user@saracakis.gr.fake.com") === false);
    check("A. user@fakesaracakis.gr -> rejected (character before 'saracakis.gr' is not '@')", isAllowedOrganizationEmail("user@fakesaracakis.gr") === false);
    check("A. Existing kinsen.gr behavior is unchanged: user@kinsen.gr.fake.com -> rejected", isAllowedOrganizationEmail("user@kinsen.gr.fake.com") === false);
    check("A. Empty/null email -> rejected, never throws", isAllowedOrganizationEmail("") === false && isAllowedOrganizationEmail(null) === false && isAllowedOrganizationEmail(undefined) === false);
    check("A. getAllowedOrganizationEmailDomain resolves the SPECIFIC matched domain, not just true/false", getAllowedOrganizationEmailDomain("User@SARACAKIS.GR") === "saracakis.gr");
    check("   ...and kinsen.gr resolves to kinsen.gr, never confused with saracakis.gr", getAllowedOrganizationEmailDomain("user@kinsen.gr") === "kinsen.gr");
    check("   ALLOWED_ORGANIZATION_EMAIL_DOMAINS contains both configured domains", ALLOWED_ORGANIZATION_EMAIL_DOMAINS.includes("kinsen.gr") && ALLOWED_ORGANIZATION_EMAIL_DOMAINS.includes("saracakis.gr"));

    // Organization-sync eligibility must use the exact same policy — never a
    // second, independently-configurable domain list that could drift.
    console.log("\n=== A (sync eligibility). getOrganizationDirectoryEligibility recognizes both domains identically ===\n");
    check("Member @kinsen.gr -> eligible", getOrganizationDirectoryEligibility({ userType: "Member", mail: "a@kinsen.gr" }).eligible === true);
    check("Member @saracakis.gr -> eligible", getOrganizationDirectoryEligibility({ userType: "Member", mail: "a@saracakis.gr" }).eligible === true);
    check("Member @SARACAKIS.GR (uppercase) -> eligible", getOrganizationDirectoryEligibility({ userType: "Member", mail: "a@SARACAKIS.GR" }).eligible === true);
    check("Member @unrelated.com -> ineligible, no_matching_domain", (() => {
      const r = getOrganizationDirectoryEligibility({ userType: "Member", mail: "a@unrelated.com" });
      return !r.eligible && r.reason === "no_matching_domain";
    })());
    check("Guest @saracakis.gr -> ineligible, not_member (domain never overrides Guest exclusion)", (() => {
      const r = getOrganizationDirectoryEligibility({ userType: "Guest", mail: "a@saracakis.gr" });
      return !r.eligible && r.reason === "not_member";
    })());

    // ══════════════════════ B. EXISTING SARACAKIS USER RECONCILIATION (login path) ══════════════════════
    console.log("\n=== B. An existing @saracakis.gr user with NO microsoftUserId is LINKED on Microsoft login, never duplicated ===\n");
    const existingEmail = `existing-b-${RUN_ID}@saracakis.gr`;
    const existingUser = await prisma.user.create({
      data: { email: existingEmail, name: "Existing Saracakis User", role: Role.USER, authProvider: AuthProvider.CREDENTIALS },
      // No microsoftUserId — simulates the exact scenario: a user that
      // exists from an old/manual creation or a prior partial sync, never
      // linked to Microsoft yet.
    });
    userIds.push(existingUser.id);
    check("B. Fixture starts with exactly one User row for this email", (await prisma.user.count({ where: { email: existingEmail } })) === 1);
    check("B. Fixture user has no microsoftUserId yet", existingUser.microsoftUserId === null);

    const oid = `test-oid-saracakis-${RUN_ID}`;
    mockGraphMeOnce(existingEmail, oid);
    const dbUserBeforeLogin = await prisma.user.findUniqueOrThrow({
      where: { id: existingUser.id },
      select: { id: true, role: true, isActive: true, mustChangePassword: true, departmentId: true, businessUnitId: true, customRoleId: true, microsoftUserId: true, globalRoleSource: true, name: true, image: true },
    });
    const afterLogin = await handleMicrosoftJwtSignIn({
      dbUser: dbUserBeforeLogin,
      accessToken: "mock-delegated-token",
      oid,
      providerAccountId: oid,
      userEmail: existingEmail,
      userName: "Existing Saracakis User",
    });

    check("B. handleMicrosoftJwtSignIn returns the SAME user id — no second identity created", afterLogin.id === existingUser.id);
    check("B. Still exactly ONE User row for this email after Microsoft login", (await prisma.user.count({ where: { email: existingEmail } })) === 1);
    const afterLoginRow = await prisma.user.findUnique({ where: { id: existingUser.id } });
    check("B. microsoftUserId is now backfilled onto the SAME existing row", afterLoginRow?.microsoftUserId === oid);
    restoreFetch();

    // Idempotent: logging in again with the same oid must still resolve to
    // the same single row, never a second one.
    mockGraphMeOnce(existingEmail, oid);
    const dbUserSecondLogin = await prisma.user.findUniqueOrThrow({
      where: { id: existingUser.id },
      select: { id: true, role: true, isActive: true, mustChangePassword: true, departmentId: true, businessUnitId: true, customRoleId: true, microsoftUserId: true, globalRoleSource: true, name: true, image: true },
    });
    const afterSecondLogin = await handleMicrosoftJwtSignIn({
      dbUser: dbUserSecondLogin,
      accessToken: "mock-delegated-token",
      oid,
      providerAccountId: oid,
      userEmail: existingEmail,
      userName: "Existing Saracakis User",
    });
    check("B. A second login with the same identity still resolves to the same row (idempotent)", afterSecondLogin.id === existingUser.id);
    check("   ...and still exactly one User row for this email", (await prisma.user.count({ where: { email: existingEmail } })) === 1);
    restoreFetch();

    // ══════════════════════ C. FULL DIRECTORY SYNC: BOTH DOMAINS PROCESSED ══════════════════════
    console.log("\n=== C. Full Microsoft sync fixture: employee1@kinsen.gr AND employee2@saracakis.gr both pass through the same pipeline ===\n");
    const kinsenEmail = `employee1-c-${RUN_ID}@kinsen.gr`;
    const saracakisEmail = `employee2-c-${RUN_ID}@saracakis.gr`;
    installTenantUsersMock([
      { id: `oid-emp1-${RUN_ID}`, displayName: "Employee One", mail: kinsenEmail, userType: "Member", accountEnabled: true, department: null, jobTitle: null },
      { id: `oid-emp2-${RUN_ID}`, displayName: "Employee Two", mail: saracakisEmail, userType: "Member", accountEnabled: true, department: null, jobTitle: null },
      // A genuinely non-allowed domain must still be excluded, exactly like before — proves the widened set doesn't accidentally become "allow everything".
      { id: `oid-outsider-${RUN_ID}`, displayName: "Outsider", mail: `outsider-${RUN_ID}@unrelated.com`, userType: "Member", accountEnabled: true, department: null, jobTitle: null },
    ]);

    const syncResult = await runOrganizationDirectorySync();
    check("C. Sync completes ok", syncResult.ok === true);
    if (syncResult.ok) {
      check("C. Both eligible users (kinsen.gr + saracakis.gr) were processed", syncResult.usersEligible === 2);
      check("   The non-allowed-domain outsider was skipped, not processed", syncResult.usersSkippedDomain === 1);
    }

    const kinsenUser = await prisma.user.findUnique({ where: { email: kinsenEmail } });
    const saracakisUser = await prisma.user.findUnique({ where: { email: saracakisEmail } });
    const outsiderUser = await prisma.user.findUnique({ where: { email: `outsider-${RUN_ID}@unrelated.com` } });
    check("C. employee1@kinsen.gr was created by the sync", !!kinsenUser);
    check("C. employee2@saracakis.gr was ALSO created by the sync (both domains processed by the same pipeline)", !!saracakisUser);
    check("   The outsider was never created at all", !outsiderUser);
    if (kinsenUser) userIds.push(kinsenUser.id);
    if (saracakisUser) userIds.push(saracakisUser.id);
    restoreFetch();

    // ══════════════════════ D. EXISTING SARACAKIS SYNC USER: UPDATE, NOT DUPLICATE ══════════════════════
    console.log("\n=== D. A saracakis.gr user already in the local DB is updated/reconciled by sync, never duplicated ===\n");
    const preExistingEmail = `employee2-d-${RUN_ID}@saracakis.gr`;
    const preExisting = await prisma.user.create({
      data: { email: preExistingEmail, name: "Pre-existing Name", role: Role.USER, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(preExisting.id);
    check("D. Fixture starts with exactly one row for this email", (await prisma.user.count({ where: { email: preExistingEmail } })) === 1);

    installTenantUsersMock([
      { id: `oid-emp2d-${RUN_ID}`, displayName: "Employee Two Updated", mail: preExistingEmail, userType: "Member", accountEnabled: true, department: null, jobTitle: "Updated Title" },
    ]);
    const syncResultD = await runOrganizationDirectorySync();
    check("D. Sync completes ok", syncResultD.ok === true);

    check("D. Still exactly ONE row for this email after sync (no duplicate create)", (await prisma.user.count({ where: { email: preExistingEmail } })) === 1);
    const afterSyncRow = await prisma.user.findUnique({ where: { email: preExistingEmail } });
    check("D. The SAME row id is reused (linked, not replaced)", afterSyncRow?.id === preExisting.id);
    check("D. microsoftUserId is now backfilled via the linking path", afterSyncRow?.microsoftUserId === `oid-emp2d-${RUN_ID}`);
    check("D. Microsoft-sourced fields (name) were updated onto the existing row", afterSyncRow?.name === "Employee Two Updated");
    restoreFetch();

    // ══════════════════════ Per-domain job title tagging (the mistagging bug this fix closes) ══════════════════════
    console.log("\n=== A tenant scan with users from BOTH domains tags job titles under each user's OWN domain, never one assumed domain ===\n");
    const titleKinsen = `Multi-Domain Test Title Kinsen ${RUN_ID}`;
    const titleSaracakis = `Multi-Domain Test Title Saracakis ${RUN_ID}`;
    installTenantUsersMock([
      { id: `oid-jt-k-${RUN_ID}`, mail: `jt-k-${RUN_ID}@kinsen.gr`, userType: "Member", jobTitle: titleKinsen },
      { id: `oid-jt-s-${RUN_ID}`, mail: `jt-s-${RUN_ID}@saracakis.gr`, userType: "Member", jobTitle: titleSaracakis },
    ]);
    const fetchResult = await fetchAllGraphUserDirectoryValues();
    check("Fetch ok", fetchResult.ok === true);
    if (fetchResult.ok) {
      const kinsenBucket = fetchResult.values.jobTitleCountsByDomain["kinsen.gr"] ?? [];
      const saracakisBucket = fetchResult.values.jobTitleCountsByDomain["saracakis.gr"] ?? [];
      check("The kinsen.gr user's title is bucketed under kinsen.gr", kinsenBucket.some((c) => c.normalizedValue === normalizeJobTitleValue(titleKinsen)));
      check("...and NOT under saracakis.gr", !saracakisBucket.some((c) => c.normalizedValue === normalizeJobTitleValue(titleKinsen)));
      check("The saracakis.gr user's title is bucketed under saracakis.gr", saracakisBucket.some((c) => c.normalizedValue === normalizeJobTitleValue(titleSaracakis)));
      check("...and NOT under kinsen.gr", !kinsenBucket.some((c) => c.normalizedValue === normalizeJobTitleValue(titleSaracakis)));
    }
    restoreFetch();

    // ══════════════════════ Domain-aware mapping: saracakis.gr PROFILE_JOB_TITLE mapping ══════════════════════
    console.log("\n=== Domain-scoped mapping: an admin CAN create a PROFILE_JOB_TITLE mapping for saracakis.gr ===\n");
    dept = await prisma.department.create({ data: { name: `Multi-Domain Mapping Dept ${RUN_ID}`, slug: `multi-domain-mapping-dept-${RUN_ID}` } });
    const saracakisMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: `Saracakis Mapping Title ${RUN_ID}`,
      departmentId: dept.id,
      domain: "saracakis.gr",
    });
    check("A PROFILE_JOB_TITLE mapping for saracakis.gr is created successfully (not rejected as 'domain not allowed')", saracakisMapping.domain === "saracakis.gr");

    let rejectedForDisallowedDomain = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: `Disallowed Domain Title ${RUN_ID}`,
        departmentId: dept.id,
        domain: "totally-unrelated.example",
      });
    } catch (err) {
      rejectedForDisallowedDomain = err instanceof MicrosoftMappingValidationError && err.code === "DOMAIN_NOT_ALLOWED";
    }
    check("A mapping for a genuinely non-allowed domain is still rejected (widening the set doesn't mean 'allow anything')", rejectedForDisallowedDomain);

    // Sanity: kinsen.gr mappings still work exactly as before — regression guard.
    const kinsenMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: `Kinsen Mapping Title ${RUN_ID}`,
      departmentId: dept.id,
      domain: "kinsen.gr",
    });
    check("A PROFILE_JOB_TITLE mapping for kinsen.gr still works unchanged", kinsenMapping.domain === "kinsen.gr");

    // ══════════════════════ Department listing sanity (unrelated regression guard) ══════════════════════
    const allDepts = await listDepartments();
    check("Existing listDepartments() service is unaffected by this change (regression sanity)", allDepts.some((d) => d.id === dept!.id));
  } finally {
    const cleanup: [string, () => Promise<unknown>][] = [
      ["microsoft mappings", () => (dept ? prisma.microsoftDepartmentMapping.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["job title directory values", () => prisma.microsoftDirectoryJobTitleValue.deleteMany({ where: { value: { contains: `${RUN_ID}` } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["outsider/leftover users by RUN_ID email", () => prisma.user.deleteMany({ where: { email: { contains: `${RUN_ID}` } } })],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    restoreFetch();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
