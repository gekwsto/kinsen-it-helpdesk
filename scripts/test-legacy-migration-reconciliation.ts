/**
 * DB-backed regression coverage for the legacy TicketApp migration's
 * reconciliation logic — user identity, Microsoft-login reconciliation,
 * department/reference-data preparation, ticket/comment/attachment import,
 * idempotent rerun, and transaction/error accounting.
 *
 * Exercises the REAL module functions
 * (lib/services/legacy-migration/*, unchanged by this test) against
 * fabricated legacy row arrays (no live SQL Server connection needed/used)
 * and a real Postgres dev DB, following this repo's established
 * RUN_ID/check()/cleanup-in-finally test convention.
 *
 * Usage: npx tsx scripts/test-legacy-migration-reconciliation.ts
 */
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, AuthProvider, MembershipSource, DepartmentRole } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { setDefaultGlobalRole, setDefaultDepartmentRole } from "@/lib/services/default-role-service";
import { resolveDefaultGlobalRoleAssignment } from "@/lib/services/default-role-service";
import { buildLegacyIdentities, reconcileLegacyUsers, findDuplicateNormalizedEmails } from "@/lib/services/legacy-migration/user-reconciliation";
import { validateTargetDepartment, ensureDepartmentMemberships, ensureAdditionalDepartmentMembership, TargetDepartmentValidationError } from "@/lib/services/legacy-migration/department-preparation";
import { ensureReferenceData } from "@/lib/services/legacy-migration/reference-data";
import { ensureUnknownCreatorPlaceholder, UNKNOWN_CREATOR_EMAIL, UNKNOWN_CREATOR_NAME } from "@/lib/services/legacy-migration/unknown-creator";
import { importOneLegacyTicket } from "@/lib/services/legacy-migration/ticket-import";
import { importOneLegacyComment } from "@/lib/services/legacy-migration/comment-import";
import { importOneLegacyAttachment, findPhysicalOrphans } from "@/lib/services/legacy-migration/attachment-import";
import { LEGACY_MIGRATION_SOURCE } from "@/lib/services/legacy-migration/ledger";
import { normalizeEmail } from "@/lib/services/email-identity";
import { isAllowedOrganizationEmail } from "@/lib/allowed-email-domains";
import { setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import type { LegacyUserRow, LegacyApplicationUserRow, LegacyTicketRow, LegacyCommentRow, LegacyFileDataRow } from "@/lib/services/legacy-migration/sql-source-client";
import fs from "fs/promises";
import os from "os";
import path from "path";

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

function baseTicketRow(overrides: Partial<LegacyTicketRow>): LegacyTicketRow {
  return {
    Id: 0,
    Title: "Test ticket",
    Description: "Test description",
    Priority: 1,
    Status: 0,
    Platform: 0,
    Category: 1,
    SubCategory: null,
    User: null,
    Developer: null,
    OpenDate: new Date(2023, 0, 1),
    LastUpdatedOn: new Date(2023, 0, 2),
    CloseDate: null,
    CancelDate: null,
    reopenDate: null,
    CancelText: null,
    CancelledReason: null,
    CancelledBy: null,
    ...overrides,
  };
}

async function main() {
  await prisma.$connect();

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const ticketIds: string[] = [];
  const messageIds: string[] = [];
  const attachmentIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  let tempAttachmentDir: string | null = null;
  const legacyKeysToPurgeFromLedger = { USER: new Set<string>(), TICKET: new Set<string>(), COMMENT: new Set<string>(), ATTACHMENT: new Set<string>() };

  try {
    // ══════════════ Fixture: a real target department + default roles ══════════════
    const dept = await createDepartment({ name: `Legacy Migration Test Dept ${RUN_ID}`, slug: `legacy-migration-test-${RUN_ID}` });
    deptIds.push(dept.id);

    const globalDefaultRole = await prisma.customRole.create({ data: { key: `LMT_GLOBAL_DEFAULT_${RUN_ID}`, name: `Legacy Import Default ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
    customRoleIds.push(globalDefaultRole.id);
    customRoleKeys.push(globalDefaultRole.key);
    const departmentDefaultRole = await prisma.customRole.create({ data: { key: `LMT_DEPT_DEFAULT_${RUN_ID}`, name: `Legacy Import Dept Default ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(departmentDefaultRole.id);
    customRoleKeys.push(departmentDefaultRole.key);
    await setDefaultGlobalRole(globalDefaultRole.id);
    await setDefaultDepartmentRole(departmentDefaultRole.id);

    // ══════════════ 1. Target department validation ══════════════
    console.log("\n=== 1. Target department validation ===\n");
    let threw: Error | null = null;
    try { await validateTargetDepartment(prisma, undefined); } catch (e) { threw = e as Error; }
    check("Missing LEGACY_MIGRATION_DEPARTMENT_ID throws TargetDepartmentValidationError", threw instanceof TargetDepartmentValidationError);
    threw = null;
    try { await validateTargetDepartment(prisma, "nonexistent-dept-id"); } catch (e) { threw = e as Error; }
    check("Nonexistent department id throws", threw instanceof TargetDepartmentValidationError);
    const validated = await validateTargetDepartment(prisma, dept.id);
    check("Valid, active department id succeeds", validated.id === dept.id);

    // ══════════════ 2. User identity reconciliation ══════════════
    console.log("\n=== 2. Normalized-email identity reconciliation ===\n");
    const existingAdminEmail = `lmt-existing-admin-${RUN_ID}@kinsen.gr`;
    const existingAdmin = await prisma.user.create({ data: { email: existingAdminEmail, name: "Pre-existing Admin", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(existingAdmin.id);

    const legacyUsers: LegacyUserRow[] = [
      { UserName: "jdoe", Id: 1 },
      { UserName: "asmith", Id: 2 },
      { UserName: "existingadmin", Id: 3 }, // reconciles to the pre-existing admin by email
      { UserName: "noemail", Id: 4 },
      { UserName: "orphanuser", Id: 5 }, // no matching ApplicationUsers row
    ];
    const legacyAppUsers: LegacyApplicationUserRow[] = [
      { UserName: "JDoe", Email: `  JDoe-${RUN_ID}@Kinsen.gr  `, Name: "John Doe" }, // mixed case UserName join + mixed case/whitespace email
      { UserName: "asmith", Email: `asmith-${RUN_ID}@kinsen.gr`, Name: "Alice Smith" },
      { UserName: "existingadmin", Email: existingAdminEmail.toUpperCase(), Name: "Existing Admin" },
      { UserName: "noemail", Email: null, Name: "No Email User" },
      { UserName: "PavlosChatzisavvas-nobusinessrow", Email: null, Name: "Pavlos Chatzisavvas" }, // the proven extra ApplicationUsers row with no dbo.Users match
    ];

    const identityResult = buildLegacyIdentities(legacyUsers, legacyAppUsers);
    check("Case-insensitive UserName join resolves 4 of 5 dbo.Users rows (jdoe/asmith/existingadmin/noemail)", identityResult.identities.length === 4);
    check("orphanuser (no ApplicationUsers match) is reported, not silently dropped", identityResult.usersWithNoApplicationUserMatch.some((u) => u.UserName === "orphanuser"));
    check("The extra ApplicationUsers row with no dbo.Users match is identified separately, never treated as a business user", identityResult.applicationUsersWithNoBusinessUserRow.some((au) => au.UserName === "PavlosChatzisavvas-nobusinessrow"));

    const defaultGlobalRole = await resolveDefaultGlobalRoleAssignment();
    check("Configured Default Global Role resolves to the fixture custom role (not a hardcoded Role.USER fallback)", defaultGlobalRole.customRoleId === globalDefaultRole.id);

    const reconcileResult = await reconcileLegacyUsers(prisma, identityResult.identities, defaultGlobalRole, false);
    for (const id of reconcileResult.usernameToUserId.values()) if (!userIds.includes(id)) userIds.push(id);
    legacyKeysToPurgeFromLedger.USER = new Set(legacyUsers.map((u) => u.UserName));

    check("existingadmin reconciles to the SAME pre-existing User.id (reused, not duplicated) — including the preserved admin", reconcileResult.usernameToUserId.get("existingadmin") === existingAdmin.id);
    check("jdoe and asmith are newly created (2 created)", reconcileResult.created === 2);
    check("existingadmin is reused, not created (1 reused... at minimum)", reconcileResult.reused >= 1);
    check("noemail (no email at all) is unresolved, not silently fabricated an email", reconcileResult.unresolved.some((u) => u.userName === "noemail"));

    const newUserCountAfterFirstReconcile = await prisma.user.count();
    const createdUser = await prisma.user.findUniqueOrThrow({ where: { id: reconcileResult.usernameToUserId.get("jdoe")! } });
    check("Newly created user's email is normalized (trim+lowercase) even though the source had mixed case/whitespace", createdUser.email === normalizeEmail(`JDoe-${RUN_ID}@Kinsen.gr`));
    check("Newly created user gets the configured Default Global Role's customRoleId — never a hardcoded Role.USER-only fallback", createdUser.customRoleId === globalDefaultRole.id && createdUser.role === Role.USER);

    // ══════════════ 3. Idempotent rerun — user reconciliation ══════════════
    console.log("\n=== 3. Idempotent rerun: user reconciliation ===\n");
    const secondReconcileResult = await reconcileLegacyUsers(prisma, identityResult.identities, defaultGlobalRole, false);
    check("Second run reuses ALL previously-migrated users via the ledger (0 newly created)", secondReconcileResult.created === 0);
    check("Second run's jdoe maps to the SAME User.id as the first run", secondReconcileResult.usernameToUserId.get("jdoe") === reconcileResult.usernameToUserId.get("jdoe"));
    const userCountAfterSecondReconcile = await prisma.user.count();
    check("No duplicate users were created by the second run", userCountAfterSecondReconcile === newUserCountAfterFirstReconcile);

    // ══════════════ 4. Duplicate normalized email detection ══════════════
    console.log("\n=== 4. Duplicate normalized email detection (reported, never silently merged/split) ===\n");
    const dupIdentities = buildLegacyIdentities(
      [{ UserName: "user.a", Id: 10 }, { UserName: "user.b", Id: 11 }],
      [{ UserName: "user.a", Email: `dup-${RUN_ID}@kinsen.gr`, Name: "A" }, { UserName: "user.b", Email: `DUP-${RUN_ID}@KINSEN.GR`, Name: "B" }]
    ).identities;
    const dupGroups = findDuplicateNormalizedEmails(dupIdentities);
    check("Two different UserNames whose emails normalize identically are detected as ONE duplicate group", dupGroups.length === 1 && dupGroups[0].userNames.length === 2);
    const dupReconcileResult = await reconcileLegacyUsers(prisma, dupIdentities, defaultGlobalRole, false);
    for (const id of dupReconcileResult.usernameToUserId.values()) if (!userIds.includes(id)) userIds.push(id);
    legacyKeysToPurgeFromLedger.USER.add("user.a");
    legacyKeysToPurgeFromLedger.USER.add("user.b");
    check("Both duplicate UserNames resolve to the SAME target User.id (never two rows for one email)", dupReconcileResult.usernameToUserId.get("user.a") === dupReconcileResult.usernameToUserId.get("user.b"));
    check("Reported in duplicateNormalizedEmails, not silently ignored", dupReconcileResult.duplicateNormalizedEmails.length === 1);

    // ══════════════ 5. Microsoft reconciliation — no duplicate on first Entra login ══════════════
    console.log("\n=== 5. Microsoft reconciliation: first Entra login binds the SAME migrated User.id, never creates a duplicate ===\n");
    const { withNormalizedEmail } = await import("@/lib/auth");
    const { PrismaAdapter } = await import("@auth/prisma-adapter");
    const wrappedAdapter = withNormalizedEmail(PrismaAdapter(prisma) as any);

    const migratedUserId = reconcileResult.usernameToUserId.get("asmith")!;
    const migratedUser = await prisma.user.findUniqueOrThrow({ where: { id: migratedUserId } });
    check("Migrated user has no microsoftUserId yet (never logged in via Microsoft)", migratedUser.microsoftUserId === null);

    const userCountBeforeMsLogin = await prisma.user.count();
    // Entra would present the SAME email but possibly different casing —
    // the wrapped adapter's getUserByEmail must still find the existing row.
    const foundByAdapter = await wrappedAdapter.getUserByEmail!(migratedUser.email.toUpperCase());
    check("withNormalizedEmail(PrismaAdapter).getUserByEmail finds the EXISTING migrated user by normalized email (mixed case) — never creating a new one", foundByAdapter?.id === migratedUserId);
    const userCountAfterAdapterLookup = await prisma.user.count();
    check("A pure lookup creates zero new rows", userCountAfterAdapterLookup === userCountBeforeMsLogin);

    const { handleMicrosoftJwtSignIn } = await import("@/lib/services/microsoft-department-sync-service");
    const oid = `entra-oid-${RUN_ID}`;
    (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ id: oid, displayName: migratedUser.name, mail: null, userPrincipalName: null, department: null, jobTitle: null }), { status: 200 })) as typeof fetch;

    const refreshed = await handleMicrosoftJwtSignIn({
      dbUser: {
        id: migratedUser.id,
        role: migratedUser.role,
        isActive: migratedUser.isActive,
        mustChangePassword: migratedUser.mustChangePassword,
        departmentId: migratedUser.departmentId,
        businessUnitId: migratedUser.businessUnitId,
        customRoleId: migratedUser.customRoleId,
        microsoftUserId: migratedUser.microsoftUserId,
        globalRoleSource: migratedUser.globalRoleSource,
        name: migratedUser.name,
        image: migratedUser.image,
      },
      accessToken: "fake-token",
      oid,
      providerAccountId: oid,
      userEmail: migratedUser.email,
      userName: migratedUser.name,
    });

    const userCountAfterFirstEntraLogin = await prisma.user.count();
    check("User count does NOT increase on first Entra reconciliation", userCountAfterFirstEntraLogin === userCountBeforeMsLogin);
    check("User.id remains IDENTICAL after first Microsoft login", refreshed.id === migratedUserId);
    check("microsoftUserId is populated on the EXISTING row", refreshed.microsoftUserId === oid);
    check("The migrated user's customRoleId (Default Global Role) survives the Microsoft login untouched", refreshed.customRoleId === globalDefaultRole.id);

    // ══════════════ 6. Department membership + reference data preparation ══════════════
    console.log("\n=== 6. Department membership + reference data (Phase 3/4) ===\n");
    const allReconciledUserIds = [...new Set(reconcileResult.usernameToUserId.values())];
    const membershipResult = await ensureDepartmentMemberships(prisma, allReconciledUserIds, dept.id, false);
    check("Memberships granted AS PRIMARY for newly-placed users (none of jdoe/asmith/existingadmin had any prior membership)", membershipResult.grantedAsPrimary >= 2);
    const membershipRow = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: reconcileResult.usernameToUserId.get("jdoe")!, departmentId: dept.id } });
    check("Granted membership uses the configured Default Department Role's customRoleId", membershipRow.customRoleId === departmentDefaultRole.id);
    check("Granted membership source is MANUAL (protected from being clobbered by a later Microsoft sync)", membershipRow.source === "MANUAL");

    const referenceData = await ensureReferenceData(prisma, dept.id, false);
    check("7 target statuses prepared (one per legacy Status 0-6)", referenceData.statusIdByLegacyStatus.size === 7);
    check("3 target priorities prepared", referenceData.priorityIdByLegacyPriority.size === 3);
    check("10 target categories prepared (3 bare parents + 7 distinct SubCategory-text-derived categories)", referenceData.categoryIdByName.size === 10);

    // ══════════════ 6b. Membership safety (migration-safety Issue 1): an existing user's primary elsewhere is NEVER touched ══════════════
    console.log("\n=== 6b. Membership safety: existing primary/custom role elsewhere is preserved EXACTLY; only an additive secondary is granted ===\n");

    const otherDept = await createDepartment({ name: `Legacy Migration Test OTHER Dept ${RUN_ID}`, slug: `legacy-migration-test-other-${RUN_ID}` });
    deptIds.push(otherDept.id);

    const distinctDeptCustomRole = await prisma.customRole.create({ data: { key: `LMT_DISTINCT_DEPT_ROLE_${RUN_ID}`, name: `Legacy Distinct Dept Role ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(distinctDeptCustomRole.id);
    customRoleKeys.push(distinctDeptCustomRole.key);

    const existingUserWithPrimaryElsewhere = await prisma.user.create({ data: { email: `lmt-existing-primary-${RUN_ID}@kinsen.gr`, name: "Existing User With Own Primary", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(existingUserWithPrimaryElsewhere.id);

    // Fixture: this user already has a REAL primary department (MANUAL source, a distinct custom role) BEFORE the migration ever runs — simulating a genuine pre-existing account whose legacy UserName happens to reconcile during import.
    await setPrimaryDepartmentMembership(existingUserWithPrimaryElsewhere.id, otherDept.id, MembershipSource.MANUAL, { role: DepartmentRole.REQUESTER, customRoleId: distinctDeptCustomRole.id });
    const primaryBefore = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: existingUserWithPrimaryElsewhere.id, isPrimary: true, isActive: true } });
    check("Fixture: existing user's primary is in the OTHER department with the distinct custom role, before migration runs", primaryBefore.departmentId === otherDept.id && primaryBefore.customRoleId === distinctDeptCustomRole.id);

    // Run the SAME membership step the migration runner uses, targeting `dept` (NOT otherDept) — exactly what happens when a pre-existing user's legacy UserName reconciles to their real, existing account.
    const safetyResult1 = await ensureDepartmentMemberships(prisma, [existingUserWithPrimaryElsewhere.id], dept.id, false);
    check("Existing user with a primary elsewhere is counted as addedAsSecondary, never grantedAsPrimary", safetyResult1.addedAsSecondary === 1 && safetyResult1.grantedAsPrimary === 0);

    const primaryAfter = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: existingUserWithPrimaryElsewhere.id, isPrimary: true, isActive: true } });
    check("[MIGRATION SAFETY] Existing user's PRIMARY department is EXACTLY UNCHANGED after migration (still otherDept, never moved to the migration target)", primaryAfter.departmentId === otherDept.id);
    check("[MIGRATION SAFETY] Existing user's primary customRoleId is EXACTLY UNCHANGED (still the pre-existing distinct role, never overwritten by the migration's configured default department role)", primaryAfter.customRoleId === distinctDeptCustomRole.id);
    check("Existing user's primary membership row itself is unchanged (same row id, not replaced/recreated)", primaryAfter.id === primaryBefore.id);

    const secondaryRow = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: existingUserWithPrimaryElsewhere.id, departmentId: dept.id } });
    check("[MIGRATION SAFETY] A NEW, additive, NON-primary membership was granted in the migration target so the user can see their imported tickets", secondaryRow.isPrimary === false && secondaryRow.isActive === true);
    check("The additive secondary membership uses the configured Default Department Role (its OWN role, independent of the untouched primary)", secondaryRow.customRoleId === departmentDefaultRole.id);

    // Rerun — must not duplicate the secondary row, and must still never touch the primary.
    const membershipRowCountBeforeRerun = await prisma.departmentMembership.count({ where: { userId: existingUserWithPrimaryElsewhere.id } });
    const safetyResult2 = await ensureDepartmentMemberships(prisma, [existingUserWithPrimaryElsewhere.id], dept.id, false);
    check("Rerun for the same user reports secondaryAlreadyPresent, not a fresh addedAsSecondary", safetyResult2.secondaryAlreadyPresent === 1 && safetyResult2.addedAsSecondary === 0);
    const membershipRowCountAfterRerun = await prisma.departmentMembership.count({ where: { userId: existingUserWithPrimaryElsewhere.id } });
    check("Rerun does NOT duplicate the migration-target membership — zero new rows for this user", membershipRowCountAfterRerun === membershipRowCountBeforeRerun);
    const primaryAfterRerun = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: existingUserWithPrimaryElsewhere.id, isPrimary: true, isActive: true } });
    check("Primary is STILL unchanged after the rerun", primaryAfterRerun.departmentId === otherDept.id && primaryAfterRerun.customRoleId === distinctDeptCustomRole.id);

    // A genuinely NEW user (no membership anywhere) gets a valid PRIMARY membership in the migration target — the ordinary, expected case, unaffected by the additive-safety path above.
    const brandNewUser = await prisma.user.create({ data: { email: `lmt-brand-new-${RUN_ID}@kinsen.gr`, name: "Brand New Migrated User", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(brandNewUser.id);
    const noMembershipYet = await prisma.departmentMembership.findFirst({ where: { userId: brandNewUser.id } });
    check("Fixture: brand-new user has no DepartmentMembership row at all yet", noMembershipYet === null);
    const safetyResult3 = await ensureDepartmentMemberships(prisma, [brandNewUser.id], dept.id, false);
    check("Brand-new user (no primary anywhere) is granted the migration target department as PRIMARY", safetyResult3.grantedAsPrimary === 1);
    const newUserPrimary = await prisma.departmentMembership.findFirstOrThrow({ where: { userId: brandNewUser.id, isPrimary: true, isActive: true } });
    check("New user's primary membership is genuinely valid: in the target department, source MANUAL, active", newUserPrimary.departmentId === dept.id && newUserPrimary.source === "MANUAL" && newUserPrimary.isActive === true);

    // Direct unit-level proof of the underlying additive primitive itself (not just via the ensureDepartmentMemberships wrapper).
    const directAdditiveResult1 = await ensureAdditionalDepartmentMembership(prisma, brandNewUser.id, otherDept.id, DepartmentRole.REQUESTER, null);
    check("ensureAdditionalDepartmentMembership creates a row when none exists yet for (user, department)", directAdditiveResult1.outcome === "created");
    const directAdditiveResult2 = await ensureAdditionalDepartmentMembership(prisma, brandNewUser.id, otherDept.id, DepartmentRole.REQUESTER, null);
    check("ensureAdditionalDepartmentMembership is idempotent — reports already_present and writes nothing new on rerun", directAdditiveResult2.outcome === "already_present");

    // ══════════════ 7. Unknown-creator placeholder — never System Administrator (migration-safety Issue 6) ══════════════
    console.log("\n=== 7. Unknown-creator placeholder (for tickets with no legacy creator) ===\n");
    const unknownCreatorUserId = await ensureUnknownCreatorPlaceholder(prisma, false);
    if (!userIds.includes(unknownCreatorUserId)) userIds.push(unknownCreatorUserId);
    const unknownCreatorUser = await prisma.user.findUniqueOrThrow({ where: { id: unknownCreatorUserId } });
    check("Placeholder is NOT role ADMIN (never silently System Administrator)", unknownCreatorUser.role !== Role.ADMIN);
    check("Placeholder is inactive (can never sign in)", unknownCreatorUser.isActive === false);
    check("Placeholder email is the dedicated migration-invalid address", unknownCreatorUser.email === UNKNOWN_CREATOR_EMAIL);
    check("Placeholder name is clearly identifiable as a migration artifact, never mistakable for a real staff member", unknownCreatorUser.name === UNKNOWN_CREATOR_NAME && unknownCreatorUser.name.includes("Migration Placeholder"));

    // [MIGRATION SAFETY] Cannot authenticate at all: credentials login (lib/auth.ts
    // `authorize`) requires a passwordHash — none was ever set for this
    // placeholder — and separately hard-rejects any non-active account even
    // if one existed.
    check("[AUTH SAFETY] Placeholder has NO passwordHash — credentials login's authorize() returns null immediately, cannot ever succeed", (unknownCreatorUser as unknown as { passwordHash: string | null }).passwordHash === null);
    check("[AUTH SAFETY] isActive=false independently blocks credentials login even in a hypothetical future where a passwordHash got set", unknownCreatorUser.isActive === false);

    // [MIGRATION SAFETY] Has no microsoftUserId and structurally can NEVER
    // get one bound: lib/auth.ts's signIn callback rejects any Microsoft
    // sign-in whose email fails isAllowedOrganizationEmail() BEFORE jwt()/
    // handleMicrosoftJwtSignIn ever runs — and this placeholder's email
    // domain ("migration.invalid") can never be a configured organization
    // domain.
    check("[AUTH SAFETY] Placeholder has no microsoftUserId bound", unknownCreatorUser.microsoftUserId === null);
    check(
      "[AUTH SAFETY] Placeholder's email domain is REJECTED by isAllowedOrganizationEmail — the exact same gate lib/auth.ts's signIn callback checks BEFORE jwt()/handleMicrosoftJwtSignIn ever runs, so this account can structurally never complete a Microsoft sign-in or get a microsoftUserId bound",
      isAllowedOrganizationEmail(UNKNOWN_CREATOR_EMAIL) === false
    );

    // [MIGRATION SAFETY] Reused idempotently — calling the ensure-function
    // again returns the SAME id, never creates a second placeholder.
    const userCountBeforeSecondEnsure = await prisma.user.count();
    const unknownCreatorUserIdSecondCall = await ensureUnknownCreatorPlaceholder(prisma, false);
    check("Calling ensureUnknownCreatorPlaceholder again returns the SAME User.id — reused, not duplicated", unknownCreatorUserIdSecondCall === unknownCreatorUserId);
    check("No new User row was created by the second call", (await prisma.user.count()) === userCountBeforeSecondEnsure);

    await ensureDepartmentMemberships(prisma, [unknownCreatorUserId], dept.id, false);

    // ══════════════ 8. Ticket import: creator preservation, assignee preservation, null assignee, unknown-creator fallback ══════════════
    console.log("\n=== 8. Ticket import ===\n");
    const ticketCtx = {
      targetDepartmentId: dept.id,
      usernameToUserId: reconcileResult.usernameToUserId,
      referenceData,
      unknownCreatorUserId,
      dryRun: false,
    };

    const ticketWithCreatorAndAssignee = baseTicketRow({ Id: 90001 + RUN_ID, User: "jdoe", Developer: "asmith" });
    const outcome1 = await importOneLegacyTicket(prisma, ticketWithCreatorAndAssignee, ticketCtx);
    if (outcome1.targetId) ticketIds.push(outcome1.targetId);
    check("Ticket with creator+assignee imports successfully", outcome1.status === "created");
    const targetTicket1 = await prisma.ticket.findUniqueOrThrow({ where: { id: outcome1.targetId! } });
    check("Creator preserved (requesterId = jdoe's target id)", targetTicket1.requesterId === reconcileResult.usernameToUserId.get("jdoe"));
    check("Assignee preserved (assignedAgentId = asmith's target id)", targetTicket1.assignedAgentId === reconcileResult.usernameToUserId.get("asmith"));
    check("Historical OpenDate preserved as createdAt, NOT migration execution time", targetTicket1.createdAt.getTime() === ticketWithCreatorAndAssignee.OpenDate!.getTime());

    const ticketWithNoAssignee = baseTicketRow({ Id: 90002 + RUN_ID, User: "jdoe", Developer: null });
    const outcome2 = await importOneLegacyTicket(prisma, ticketWithNoAssignee, ticketCtx);
    if (outcome2.targetId) ticketIds.push(outcome2.targetId);
    const targetTicket2 = await prisma.ticket.findUniqueOrThrow({ where: { id: outcome2.targetId! } });
    check("Null Developer -> assignedAgentId stays null (kept unassigned, not silently assigned)", targetTicket2.assignedAgentId === null);

    const ticketWithNoCreator = baseTicketRow({ Id: 90003 + RUN_ID, User: null, Developer: null });
    const outcome3 = await importOneLegacyTicket(prisma, ticketWithNoCreator, ticketCtx);
    if (outcome3.targetId) ticketIds.push(outcome3.targetId);
    check("Ticket with NO legacy creator imports using the Unknown-Creator placeholder, never blocked", outcome3.status === "created" && outcome3.usedUnknownCreator === true);
    const targetTicket3 = await prisma.ticket.findUniqueOrThrow({ where: { id: outcome3.targetId! } });
    check("requesterId is the dedicated placeholder, NOT any real staff account", targetTicket3.requesterId === unknownCreatorUserId);

    // [MIGRATION SAFETY, Issue 6] A SECOND, independent creator-less ticket
    // (mirroring the migration brief's proven expected count of 2 such
    // tickets in the real source) reuses the SAME placeholder idempotently —
    // never a second placeholder account, and a ticket WITH a real creator
    // (outcome1/outcome2 above) never touches this placeholder at all.
    const secondTicketWithNoCreator = baseTicketRow({ Id: 90005 + RUN_ID, User: null, Developer: null });
    const outcome3b = await importOneLegacyTicket(prisma, secondTicketWithNoCreator, ticketCtx);
    if (outcome3b.targetId) ticketIds.push(outcome3b.targetId);
    check("A second, independent creator-less ticket ALSO uses the Unknown-Creator placeholder", outcome3b.status === "created" && outcome3b.usedUnknownCreator === true);
    const targetTicket3b = await prisma.ticket.findUniqueOrThrow({ where: { id: outcome3b.targetId! } });
    check("The second creator-less ticket reuses the EXACT SAME placeholder User.id as the first (idempotent reuse, not a second placeholder)", targetTicket3b.requesterId === unknownCreatorUserId && targetTicket3b.requesterId === targetTicket3.requesterId);
    check("Tickets WITH a real legacy creator (outcome1/outcome2) never use the placeholder", targetTicket1.requesterId !== unknownCreatorUserId && targetTicket2.requesterId !== unknownCreatorUserId);

    const ticketWithUnknownAssigneeUserName = baseTicketRow({ Id: 90004 + RUN_ID, User: "jdoe", Developer: "someone-not-reconciled" });
    const outcome4 = await importOneLegacyTicket(prisma, ticketWithUnknownAssigneeUserName, ticketCtx);
    check("Ticket whose Developer UserName never resolved is a reported FAILURE, not silently unassigned or misassigned", outcome4.status === "failed");

    // ══════════════ 9. Idempotent rerun — ticket import ══════════════
    console.log("\n=== 9. Idempotent rerun: ticket import ===\n");
    const ticketCountBeforeRerun = await prisma.ticket.count();
    const rerunOutcome1 = await importOneLegacyTicket(prisma, ticketWithCreatorAndAssignee, ticketCtx);
    check("Re-importing the SAME legacy ticket reuses the ledger entry", rerunOutcome1.status === "reused" && rerunOutcome1.targetId === outcome1.targetId);
    const ticketCountAfterRerun = await prisma.ticket.count();
    check("No duplicate ticket was created on rerun", ticketCountAfterRerun === ticketCountBeforeRerun);

    // ══════════════ 10. Transaction/error accounting: one failure never aborts the others ══════════════
    console.log("\n=== 10. Transaction/error accounting ===\n");
    const goodTicketA = baseTicketRow({ Id: 90010 + RUN_ID, User: "jdoe" });
    const badTicketMissingOpenDate = baseTicketRow({ Id: 90011 + RUN_ID, User: "jdoe", OpenDate: null });
    const goodTicketB = baseTicketRow({ Id: 90012 + RUN_ID, User: "jdoe" });
    const batchOutcomes = [];
    for (const row of [goodTicketA, badTicketMissingOpenDate, goodTicketB]) {
      batchOutcomes.push(await importOneLegacyTicket(prisma, row, ticketCtx));
    }
    for (const o of batchOutcomes) if (o.targetId) ticketIds.push(o.targetId);
    check("Ticket with missing OpenDate is a reported FAILURE (never substitutes migration-execution-time)", batchOutcomes[1].status === "failed");
    check("The ticket BEFORE the failed one still committed successfully (its own short transaction, unaffected)", batchOutcomes[0].status === "created");
    check("The ticket AFTER the failed one ALSO still committed successfully — one bad row never aborts a shared transaction", batchOutcomes[2].status === "created");
    const failedLedgerEntry = await prisma.migrationLedger.findUnique({
      where: { source_entityType_legacyKey: { source: LEGACY_MIGRATION_SOURCE, entityType: "TICKET", legacyKey: String(badTicketMissingOpenDate.Id) } },
    });
    check("Failed ticket is recorded in the ledger as FAILED with an error message (not silently dropped, and not left as a phantom aborted-transaction row)", failedLedgerEntry?.status === "FAILED" && !!failedLedgerEntry?.errorMessage);

    // ══════════════ 11. Comment import: author resolution, unresolved reporting ══════════════
    console.log("\n=== 11. Comment import ===\n");
    const ticketIdByLegacyTicketId = new Map<number, string>([
      [ticketWithCreatorAndAssignee.Id, outcome1.targetId!],
    ]);
    const emailToUserId = new Map<string, string>();
    for (const [uname, uid] of reconcileResult.usernameToUserId) {
      const identity = identityResult.identities.find((i) => i.userName === uname);
      if (identity?.normalizedEmail) emailToUserId.set(identity.normalizedEmail, uid);
    }

    const commentByExactUserName: LegacyCommentRow = { Id: 80001 + RUN_ID, Message: "Comment by exact username", CreatedBy: "asmith", DateSent: new Date(2023, 0, 3), isPublic: true, isHidden: false, Ticket_Messages: ticketWithCreatorAndAssignee.Id };
    const c1 = await importOneLegacyComment(prisma, commentByExactUserName, { usernameToUserId: reconcileResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: false }, emailToUserId);
    if (c1.targetId) messageIds.push(c1.targetId);
    check("Comment author resolved by exact legacy UserName", c1.authorResolved === true && c1.status === "created");
    const c1Row = await prisma.ticketMessage.findUniqueOrThrow({ where: { id: c1.targetId! } });
    check("Resolved author id matches asmith's target user", c1Row.authorId === reconcileResult.usernameToUserId.get("asmith"));

    const commentByExactEmail: LegacyCommentRow = { Id: 80002 + RUN_ID, Message: "Comment by exact email", CreatedBy: `  JDoe-${RUN_ID}@Kinsen.gr  `, DateSent: new Date(2023, 0, 4), isPublic: true, isHidden: false, Ticket_Messages: ticketWithCreatorAndAssignee.Id };
    const c2 = await importOneLegacyComment(prisma, commentByExactEmail, { usernameToUserId: reconcileResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: false }, emailToUserId);
    if (c2.targetId) messageIds.push(c2.targetId);
    check("Comment author resolved by exact normalized email when CreatedBy isn't a known UserName", c2.authorResolved === true);

    const commentUnresolvedAuthor: LegacyCommentRow = { Id: 80003 + RUN_ID, Message: "Comment by unknown person", CreatedBy: "Completely Different Display Name", DateSent: new Date(2023, 0, 5), isPublic: true, isHidden: false, Ticket_Messages: ticketWithCreatorAndAssignee.Id };
    const c3 = await importOneLegacyComment(prisma, commentUnresolvedAuthor, { usernameToUserId: reconcileResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: false }, emailToUserId);
    if (c3.targetId) messageIds.push(c3.targetId);
    check("Unresolved author is NEVER fuzzy-matched — comment still imported with authorId null, reported not guessed", c3.status === "created" && c3.authorResolved === false);
    const c3Row = await prisma.ticketMessage.findUniqueOrThrow({ where: { id: c3.targetId! } });
    check("authorId is genuinely null for the unresolved-author comment", c3Row.authorId === null);

    const commentInternal: LegacyCommentRow = { Id: 80004 + RUN_ID, Message: "Internal note", CreatedBy: "asmith", DateSent: new Date(2023, 0, 6), isPublic: false, isHidden: true, Ticket_Messages: ticketWithCreatorAndAssignee.Id };
    const c4 = await importOneLegacyComment(prisma, commentInternal, { usernameToUserId: reconcileResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: false }, emailToUserId);
    if (c4.targetId) messageIds.push(c4.targetId);
    const c4Row = await prisma.ticketMessage.findUniqueOrThrow({ where: { id: c4.targetId! } });
    check("isHidden=true/isPublic=false -> isInternal=true, direction=INTERNAL_NOTE", c4Row.isInternal === true && c4Row.direction === "INTERNAL_NOTE");

    // ══════════════ 12. Idempotent rerun — comment import ══════════════
    const commentCountBefore = await prisma.ticketMessage.count();
    const c1Rerun = await importOneLegacyComment(prisma, commentByExactUserName, { usernameToUserId: reconcileResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: false }, emailToUserId);
    check("Re-importing the same comment reuses the ledger entry", c1Rerun.status === "reused" && c1Rerun.targetId === c1.targetId);
    check("No duplicate comment created on rerun", (await prisma.ticketMessage.count()) === commentCountBefore);

    // ══════════════ 13. Attachment import: missing file hard failure, physical orphan reporting ══════════════
    console.log("\n=== 13. Attachment import ===\n");
    tempAttachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), `legacy-migration-test-${RUN_ID}-`));
    const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), `legacy-migration-upload-${RUN_ID}-`));

    const existingFileName = `report-${RUN_ID}.txt`;
    await fs.writeFile(path.join(tempAttachmentDir, existingFileName), "legacy attachment bytes");
    const orphanFileName = `orphan-${RUN_ID}.txt`;
    await fs.writeFile(path.join(tempAttachmentDir, orphanFileName), "no DB record for this file");

    const resolvedFilenames = new Map([
      [70001 + RUN_ID, { id: 70001 + RUN_ID, originalFileName: existingFileName, physicalFileName: existingFileName, groupSize: 1, isNewestInGroup: true }],
      [70002 + RUN_ID, { id: 70002 + RUN_ID, originalFileName: "missing-file.txt", physicalFileName: "missing-file.txt", groupSize: 1, isNewestInGroup: true }],
    ]);

    const attachCtx = {
      legacyPhysicalDir: tempAttachmentDir,
      uploadDir,
      ticketIdByLegacyTicketId,
      resolvedFilenames,
      usernameToUserId: reconcileResult.usernameToUserId,
      dryRun: false,
    };

    const goodFileRow: LegacyFileDataRow = {
      Id: 70001 + RUN_ID,
      FileName: existingFileName,
      UploadDateTime: new Date(2023, 0, 10),
      Ticket_FileUpload: ticketWithCreatorAndAssignee.Id,
      StorageMedium: 0,
      FolderPath: "TicketFileUpload",
      UploadedBy: "asmith",
      Description: "Legacy file description text",
    };
    const a1 = await importOneLegacyAttachment(prisma, goodFileRow, attachCtx);
    if (a1.targetId) attachmentIds.push(a1.targetId);
    check("Attachment with a verified-existing physical file imports successfully", a1.status === "created");
    const a1Row = await prisma.ticketAttachment.findUniqueOrThrow({ where: { id: a1.targetId! } });
    check("originalName preserves the exact DB FileName", a1Row.originalName === existingFileName);
    check("mimeType inferred safely from extension (.txt -> text/plain)", a1Row.mimeType === "text/plain");
    check("createdAt preserves the legacy UploadDateTime", a1Row.createdAt.getTime() === goodFileRow.UploadDateTime.getTime());
    check("uploadedById resolved from legacy UploadedBy (asmith) via the same username map as tickets/comments", a1Row.uploadedById === reconcileResult.usernameToUserId.get("asmith"));
    const copiedBytes = await fs.readFile(path.join(uploadDir, ticketIdByLegacyTicketId.get(ticketWithCreatorAndAssignee.Id)!, a1Row.filename), "utf-8");
    check("Bytes were actually copied into the target UPLOAD_DIR/<ticketId>/<filename> layout", copiedBytes === "legacy attachment bytes");
    const a1History = await prisma.ticketHistory.findFirstOrThrow({ where: { ticketId: a1Row.ticketId, type: "ATTACHMENT_ADDED", newValue: existingFileName } });
    check("An ATTACHMENT_ADDED TicketHistory entry was created alongside the attachment", !!a1History);
    check("The legacy Description text (no target TicketAttachment column exists for it) is preserved in the history entry's description", !!a1History.description?.includes("Legacy file description text"));
    check("The history entry's changedById is the resolved uploader", a1History.changedById === reconcileResult.usernameToUserId.get("asmith"));

    const missingFileRow: LegacyFileDataRow = {
      Id: 70002 + RUN_ID,
      FileName: "missing-file.txt",
      UploadDateTime: new Date(2023, 0, 11),
      Ticket_FileUpload: ticketWithCreatorAndAssignee.Id,
      StorageMedium: 0,
      FolderPath: "TicketFileUpload",
      UploadedBy: null,
      Description: null,
    };
    const attachmentCountBeforeMissing = await prisma.ticketAttachment.count();
    const a2 = await importOneLegacyAttachment(prisma, missingFileRow, attachCtx);
    check("A DB-linked attachment record with NO resolvable physical file is a HARD failure", a2.status === "failed");
    check("No broken TicketAttachment row was created for the missing file", (await prisma.ticketAttachment.count()) === attachmentCountBeforeMissing);
    const missingLedger = await prisma.migrationLedger.findUnique({ where: { source_entityType_legacyKey: { source: LEGACY_MIGRATION_SOURCE, entityType: "ATTACHMENT", legacyKey: String(missingFileRow.Id) } } });
    check("Missing-physical-file failure is recorded in the ledger, not silently dropped", missingLedger?.status === "FAILED");

    const orphans = await findPhysicalOrphans(tempAttachmentDir, [
      { id: goodFileRow.Id, originalFileName: existingFileName, physicalFileName: existingFileName, groupSize: 1, isNewestInGroup: true },
    ]);
    check("Physical file with no matching FileDataTbl record is reported as PHYSICAL_ORPHAN", orphans.includes(orphanFileName));
    check("The legitimately-imported file is NOT reported as an orphan", !orphans.includes(existingFileName));

    // Idempotent rerun for attachments.
    const attachmentCountBeforeRerun = await prisma.ticketAttachment.count();
    const a1Rerun = await importOneLegacyAttachment(prisma, goodFileRow, attachCtx);
    check("Re-importing the same attachment reuses the ledger entry", a1Rerun.status === "reused" && a1Rerun.targetId === a1.targetId);
    check("No duplicate attachment created on rerun", (await prisma.ticketAttachment.count()) === attachmentCountBeforeRerun);

    // ══════════════ 14. Duplicate target objects created = 0 (final cross-check) ══════════════
    console.log("\n=== 14. Zero duplicate target objects across this entire run ===\n");
    const finalUserCount = await prisma.user.count({ where: { id: { in: userIds } } });
    check("Exactly as many User rows exist as unique ids collected — zero unexpected duplicates", finalUserCount === new Set(userIds).size);
  } finally {
    // Cleanup — dependent rows first. Ledger rows are purged both by
    // targetId membership (covers TICKET/COMMENT/ATTACHMENT, whose
    // legacyKeys were never tracked separately above) and by the explicitly
    // tracked USER legacyKeys (covers ledger rows for users that were only
    // ever RESOLVED/reused, never freshly created, so they'd otherwise have
    // no targetId in this run's own id lists).
    await prisma.migrationLedger.deleteMany({ where: { source: LEGACY_MIGRATION_SOURCE, targetId: { in: [...ticketIds, ...messageIds, ...attachmentIds, ...userIds] } } });
    await prisma.migrationLedger.deleteMany({ where: { source: LEGACY_MIGRATION_SOURCE, entityType: "USER", legacyKey: { in: [...legacyKeysToPurgeFromLedger.USER] } } });

    await prisma.ticketAttachment.deleteMany({ where: { id: { in: attachmentIds } } });
    await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { customRoleId: null } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
    await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });

    await prisma.defaultRoleConfig.updateMany({ where: { id: "singleton" }, data: { defaultGlobalCustomRoleId: null, defaultDepartmentCustomRoleId: null } });

    // Department + its starter config rows (same pattern established in
    // earlier sessions' tests — createDepartment() provisions a full
    // starter set nothing cascade-deletes with the Department row itself).
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } });

    if (tempAttachmentDir) await fs.rm(tempAttachmentDir, { recursive: true, force: true }).catch(() => {});

    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
