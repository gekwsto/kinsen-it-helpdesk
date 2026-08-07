/**
 * FIND-006 (docs/roadmap-handoff-register.md): domain-scoped Job Title
 * permission mapping. Proves the NEW canonical identity
 * (sourceType, domain, normalizedMicrosoftValue) on MicrosoftDepartmentMapping —
 * multi-domain coexistence, deterministic normalization, zero cross-domain
 * leakage, zero regression for existing kinsen.gr-only behavior (full sync,
 * first login, MANUAL/ADMIN protection, PROFILE_DEPARTMENT mappings,
 * DepartmentMembership creation) — via isolated fixtures. Never touches
 * real production data; every fixture is RUN_ID-tagged and cleaned up in a
 * finally block. "kinsen.at" below is a NEVER-enabled domain used purely to
 * prove architecture readiness — ALLOWED_EMAIL_DOMAIN stays "kinsen.gr" for
 * the whole file, exactly like production today.
 *
 * Usage: npx tsx scripts/test-microsoft-mapping-domain-scope.ts
 */
process.env.ALLOWED_EMAIL_DOMAIN = "kinsen.gr";

import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, GlobalRoleSource, MembershipSource, MicrosoftMappingSourceType, Role } from "@prisma/client";
import {
  createMapping,
  updateMapping,
  resolveDepartmentMemberships,
  resolvePrimaryMicrosoftMapping,
  MicrosoftMappingValidationError,
} from "@/lib/services/microsoft-mapping-service";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { listJobTitleDirectoryForAdmin } from "@/lib/services/microsoft-job-title-directory-service";
import type { MicrosoftIdentityClaims } from "@/types/department";

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

const RUN_ID = Date.now();
const NAME_TAG = `mds-${RUN_ID}`;
const TITLE_DIRECTOR = `Director ${RUN_ID}`;

function mockGraphMe(oid: string, mail: string | null, jobTitle: string | null, department: string | null = null) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(JSON.stringify({ id: oid, displayName: "Test User", mail, userPrincipalName: null, userType: "Member", department, jobTitle }), { status: 200 })) as typeof fetch;
}

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  await prisma.microsoftDepartmentMapping.deleteMany({ where: { microsoftValue: { contains: `${RUN_ID}` } } });
  // Operation A's opportunistic cache-fill (microsoft-directory-service.ts)
  // creates a MicrosoftDirectoryJobTitleValue row for every jobTitle
  // mockGraphMe passes through syncMicrosoftUserDepartment above (manualTitle,
  // titleAlpha, titleBeta, the unconfigured title) — swept up here so this
  // test never accumulates debris across repeated runs.
  await prisma.microsoftDirectoryJobTitleValue.deleteMany({ where: { value: { contains: `${RUN_ID}` } } });
  await prisma.user.deleteMany({ where: { email: { contains: `${RUN_ID}` } } });
  const depts = await prisma.department.findMany({ where: { name: { contains: NAME_TAG } }, select: { id: true } });
  const deptIds = depts.map((d) => d.id);
  if (deptIds.length > 0) {
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
  }
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  await cleanup();

  try {
    const deptA = await prisma.department.create({ data: { name: `${NAME_TAG}-dept-A`, slug: `${NAME_TAG}-dept-a` } });
    const deptB = await prisma.department.create({ data: { name: `${NAME_TAG}-dept-B`, slug: `${NAME_TAG}-dept-b` } });
    const deptC = await prisma.department.create({ data: { name: `${NAME_TAG}-dept-C`, slug: `${NAME_TAG}-dept-c` } });

    console.log("\n=== 1-3. Same domain: exact/case/whitespace dedup rejects a duplicate mapping ===\n");
    const mappingKinsenGr = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: TITLE_DIRECTOR,
      departmentId: deptA.id,
      role: Role.USER,
      departmentRole: DepartmentRole.REQUESTER,
      domain: "kinsen.gr",
    });
    check("1. kinsen.gr Director mapping created", !!mappingKinsenGr.id);
    check("   normalizedMicrosoftValue computed correctly", mappingKinsenGr.normalizedMicrosoftValue === TITLE_DIRECTOR.trim().replace(/\s+/g, " ").toLowerCase());

    for (const [label, variant] of [
      ["2. UPPERCASE case variant", TITLE_DIRECTOR.toUpperCase()],
      ["3. extra   whitespace variant", `  ${TITLE_DIRECTOR.replace(" ", "   ")}  `],
    ] as const) {
      let rejected = false;
      try {
        await createMapping({
          sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
          microsoftValue: variant,
          departmentId: deptB.id,
          role: Role.USER,
          departmentRole: DepartmentRole.VIEWER,
          domain: "kinsen.gr",
        });
      } catch (err: any) {
        rejected = err?.code === "P2002";
      }
      check(`${label} on the SAME domain is rejected as a duplicate (deterministic normalization)`, rejected);
    }

    console.log("\n=== 4-8. Multi-domain isolated fixture: kinsen.gr vs kinsen.at, zero collision, zero cross-domain leakage ===\n");
    // "kinsen.at" is NEVER enabled for real organization sync in this file
    // or anywhere else — this is a pure architecture-readiness proof using
    // Prisma directly (bypassing the domain-allowlist check createMapping
    // enforces for real admin input), exactly like the brief's own
    // instruction: prove the SCHEMA/ENGINE can do this, without activating
    // another domain.
    const normalizedDirector = TITLE_DIRECTOR.trim().replace(/\s+/g, " ").toLowerCase();
    const mappingKinsenAt = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: TITLE_DIRECTOR,
        domain: "kinsen.at",
        normalizedMicrosoftValue: normalizedDirector,
        departmentId: deptB.id,
        role: Role.IT_AGENT,
        departmentRole: DepartmentRole.AGENT_ASSIGNEE,
      },
    });
    check("4. Same raw Job Title now has TWO independent mapping rows, one per domain", mappingKinsenAt.id !== mappingKinsenGr.id);

    const claimsDirector: MicrosoftIdentityClaims = { oid: "n/a", email: "n/a", jobTitle: TITLE_DIRECTOR };
    const resolvedForGr = await resolvePrimaryMicrosoftMapping(claimsDirector, "kinsen.gr");
    const resolvedForAt = await resolvePrimaryMicrosoftMapping(claimsDirector, "kinsen.at");
    check("5. kinsen.gr + 'Director' resolves to Mapping A (deptA)", resolvedForGr?.id === mappingKinsenGr.id && resolvedForGr?.departmentId === deptA.id);
    check("6. kinsen.at + 'Director' resolves to Mapping B (deptB)", resolvedForAt?.id === mappingKinsenAt.id && resolvedForAt?.departmentId === deptB.id);
    check("7. resolver does NOT return Mapping A for kinsen.at", resolvedForAt?.id !== mappingKinsenGr.id);
    check("8. resolver does NOT return Mapping B for kinsen.gr", resolvedForGr?.id !== mappingKinsenAt.id);

    const membershipsForGr = await resolveDepartmentMemberships(claimsDirector, "kinsen.gr");
    const membershipsForAt = await resolveDepartmentMemberships(claimsDirector, "kinsen.at");
    check("   resolveDepartmentMemberships(kinsen.gr) targets deptA only", membershipsForGr.length === 1 && membershipsForGr[0].departmentId === deptA.id);
    check("   resolveDepartmentMemberships(kinsen.at) targets deptB only", membershipsForAt.length === 1 && membershipsForAt[0].departmentId === deptB.id);

    // A candidate with NO eligible domain (null) must never match a
    // domain-scoped mapping at all — "unconfigured/ineligible" behaves
    // identically to "no mapping exists", never falls back to any domain.
    const resolvedForNullDomain = await resolvePrimaryMicrosoftMapping(claimsDirector, null);
    check("   domain=null resolves to NOTHING (never silently picks either domain's mapping)", resolvedForNullDomain === null);

    console.log("\n=== 9. Discovery Configured badge is domain-aware ===\n");
    // Seed a discovery-catalog row for kinsen.gr only (kinsen.at isn't a
    // real discovery domain since organization sync only ever runs for
    // kinsen.gr) — proves listJobTitleDirectoryForAdmin's join is scoped to
    // ALLOWED_EMAIL_DOMAIN, matching mappingKinsenGr, never mappingKinsenAt.
    const discoveryRow = await prisma.microsoftDirectoryJobTitleValue.create({
      data: { value: TITLE_DIRECTOR, domain: "kinsen.gr", normalizedValue: normalizedDirector, userCount: 2, isActive: true },
    });
    const { domain: discoveryDomain, rows } = await listJobTitleDirectoryForAdmin();
    const discoveredDirectorRow = rows.find((r) => r.id === discoveryRow.id);
    check("   listJobTitleDirectoryForAdmin domain matches ALLOWED_EMAIL_DOMAIN (kinsen.gr)", discoveryDomain === "kinsen.gr");
    check("9. kinsen.gr/Director shows Configured, pointing at Mapping A's department", discoveredDirectorRow?.configured === true && discoveredDirectorRow?.mapping?.departmentId === deptA.id);
    check("   Configured mapping is NEVER Mapping B (the kinsen.at one)", discoveredDirectorRow?.mapping?.id !== mappingKinsenAt.id);
    await prisma.microsoftDirectoryJobTitleValue.delete({ where: { id: discoveryRow.id } });

    console.log("\n=== 11. Editing an existing mapping preserves its domain ===\n");
    const updated = await updateMapping(mappingKinsenGr.id, { departmentRole: DepartmentRole.AGENT_ASSIGNEE });
    check("11. domain unchanged after an unrelated-field edit", updated.domain === "kinsen.gr");
    check("    normalizedMicrosoftValue unchanged too", updated.normalizedMicrosoftValue === normalizedDirector);
    check("    the actually-requested field DID change", updated.departmentRole === DepartmentRole.AGENT_ASSIGNEE);

    console.log("\n=== Admin CRUD domain validation ===\n");
    let missingDomainRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: `${TITLE_DIRECTOR}-no-domain`,
        departmentId: deptC.id,
        departmentRole: DepartmentRole.VIEWER,
      });
    } catch (err) {
      missingDomainRejected = err instanceof MicrosoftMappingValidationError && err.code === "DOMAIN_REQUIRED_FOR_SOURCE_TYPE";
    }
    check("   PROFILE_JOB_TITLE mapping with NO domain is rejected (DOMAIN_REQUIRED_FOR_SOURCE_TYPE)", missingDomainRejected);

    let disallowedDomainRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: `${TITLE_DIRECTOR}-bad-domain`,
        departmentId: deptC.id,
        departmentRole: DepartmentRole.VIEWER,
        domain: "kinsen.at", // not the enabled ALLOWED_EMAIL_DOMAIN
      });
    } catch (err) {
      disallowedDomainRejected = err instanceof MicrosoftMappingValidationError && err.code === "DOMAIN_NOT_ALLOWED";
    }
    check("   PROFILE_JOB_TITLE mapping for a NON-enabled domain via the admin path is rejected (DOMAIN_NOT_ALLOWED — only kinsen.gr enabled today)", disallowedDomainRejected);

    console.log("\n=== 21. PROFILE_DEPARTMENT mappings remain global — no regression ===\n");
    const deptMappingValue = `${NAME_TAG}-hr-dept`;
    const deptMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: deptMappingValue,
      departmentId: deptC.id,
      role: Role.USER,
      departmentRole: DepartmentRole.REQUESTER,
      // deliberately NOT passing domain — must be silently ignored/forced global
    });
    check("   PROFILE_DEPARTMENT mapping stored as domain='' (global), unaffected by FIND-006", deptMapping.domain === "");
    const deptClaims: MicrosoftIdentityClaims = { oid: "n/a", email: "n/a", department: deptMappingValue };
    const deptResolvedAnyDomain = await resolveDepartmentMemberships(deptClaims, null);
    const deptResolvedWithDomain = await resolveDepartmentMemberships(deptClaims, "kinsen.gr");
    check("   PROFILE_DEPARTMENT mapping resolves regardless of domain context (null)", deptResolvedAnyDomain.some((m) => m.departmentId === deptC.id));
    check("   PROFILE_DEPARTMENT mapping resolves the same way with a domain present too", deptResolvedWithDomain.some((m) => m.departmentId === deptC.id));

    console.log("\n=== 12. Existing (pre-FIND-006) seed mappings kept their IDs/config across the migration ===\n");
    const seedGroupMapping = await prisma.microsoftDepartmentMapping.findFirst({ where: { microsoftValue: "TicketApp - IT", sourceType: MicrosoftMappingSourceType.ENTRA_GROUP } });
    check("   seed ENTRA_GROUP mapping still exists with its historical id shape", seedGroupMapping !== null && seedGroupMapping.id.startsWith("cm"));
    check("   seed mapping's role/departmentRole config untouched", seedGroupMapping?.role === "DEPARTMENT_MANAGER" && seedGroupMapping?.departmentRole === "DEPARTMENT_MANAGER");
    check("   seed mapping correctly backfilled to global domain ('')", seedGroupMapping?.domain === "");

    console.log("\n=== 15-16. MANUAL/ADMIN override protected from a domain-scoped Job Title mapping ===\n");
    const manualTitle = `${TITLE_DIRECTOR}-manual-test`;
    await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: manualTitle,
      departmentId: deptA.id,
      role: Role.IT_AGENT,
      departmentRole: DepartmentRole.AGENT_ASSIGNEE,
      domain: "kinsen.gr",
    });

    const manualAdminEmail = `manual-admin-${RUN_ID}@kinsen.gr`;
    const manualAdmin = await prisma.user.create({
      data: { email: manualAdminEmail, authProvider: AuthProvider.MICROSOFT, role: Role.ADMIN, globalRoleSource: GlobalRoleSource.MANUAL },
    });
    mockGraphMe(`manual-admin-oid-${RUN_ID}`, manualAdminEmail, manualTitle);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: manualAdmin.id, oid: `manual-admin-oid-${RUN_ID}`, email: manualAdminEmail, name: "Manual Admin" });
    const manualAdminAfter = await prisma.user.findUnique({ where: { id: manualAdmin.id } });
    check("15/16. MANUAL ADMIN's global role is NEVER overwritten by a matching domain-scoped Job Title mapping", manualAdminAfter?.role === Role.ADMIN && manualAdminAfter?.globalRoleSource === GlobalRoleSource.MANUAL);

    const manualUserEmail = `manual-user-${RUN_ID}@kinsen.gr`;
    const manualUser = await prisma.user.create({
      data: { email: manualUserEmail, authProvider: AuthProvider.MICROSOFT, role: Role.DEPARTMENT_MANAGER, globalRoleSource: GlobalRoleSource.MANUAL },
    });
    mockGraphMe(`manual-user-oid-${RUN_ID}`, manualUserEmail, manualTitle);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: manualUser.id, oid: `manual-user-oid-${RUN_ID}`, email: manualUserEmail, name: "Manual User" });
    const manualUserAfter = await prisma.user.findUnique({ where: { id: manualUser.id } });
    check("   A plain MANUAL globalRoleSource user's role is ALSO protected from the same mapping", manualUserAfter?.role === Role.DEPARTMENT_MANAGER && manualUserAfter?.globalRoleSource === GlobalRoleSource.MANUAL);

    console.log("\n=== 17-18. Job title change: configured -> configured, and configured -> unconfigured ===\n");
    const titleAlpha = `${NAME_TAG}-title-alpha`;
    const titleBeta = `${NAME_TAG}-title-beta`;
    const mappingAlpha = await createMapping({ sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE, microsoftValue: titleAlpha, departmentId: deptA.id, role: Role.USER, departmentRole: DepartmentRole.REQUESTER, domain: "kinsen.gr" });
    const mappingBeta = await createMapping({ sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE, microsoftValue: titleBeta, departmentId: deptB.id, role: Role.USER, departmentRole: DepartmentRole.VIEWER, domain: "kinsen.gr" });

    const jobChangeEmail = `job-change-${RUN_ID}@kinsen.gr`;
    const jobChangeUser = await prisma.user.create({ data: { email: jobChangeEmail, authProvider: AuthProvider.MICROSOFT, role: Role.USER } });
    mockGraphMe(`job-change-oid-${RUN_ID}`, jobChangeEmail, titleAlpha);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: jobChangeUser.id, oid: `job-change-oid-${RUN_ID}`, email: jobChangeEmail, name: "Job Change" });
    let membership = await prisma.departmentMembership.findFirst({ where: { userId: jobChangeUser.id, departmentId: deptA.id, isActive: true } });
    check("17. First sync (title=Alpha) grants membership in Mapping Alpha's department", membership !== null);

    mockGraphMe(`job-change-oid-${RUN_ID}`, jobChangeEmail, titleBeta);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: jobChangeUser.id, oid: `job-change-oid-${RUN_ID}`, email: jobChangeEmail, name: "Job Change" });
    const membershipAlphaAfterChange = await prisma.departmentMembership.findFirst({ where: { userId: jobChangeUser.id, departmentId: deptA.id, isActive: true, source: MembershipSource.MICROSOFT_JOB_TITLE } });
    const membershipBetaAfterChange = await prisma.departmentMembership.findFirst({ where: { userId: jobChangeUser.id, departmentId: deptB.id, isActive: true } });
    check("   Title change (Alpha -> Beta, both configured) revokes the old Microsoft-sourced membership", membershipAlphaAfterChange === null);
    check("   ...and grants the new mapping's department membership", membershipBetaAfterChange !== null);

    mockGraphMe(`job-change-oid-${RUN_ID}`, jobChangeEmail, `${NAME_TAG}-unconfigured-title`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: jobChangeUser.id, oid: `job-change-oid-${RUN_ID}`, email: jobChangeEmail, name: "Job Change" });
    const membershipBetaAfterUnconfigured = await prisma.departmentMembership.findFirst({ where: { userId: jobChangeUser.id, departmentId: deptB.id, isActive: true } });
    const allActiveMembershipsAfterUnconfigured = await prisma.departmentMembership.findMany({ where: { userId: jobChangeUser.id, isActive: true, source: MembershipSource.MICROSOFT_JOB_TITLE } });
    check("18. Changing to an UNCONFIGURED title revokes the prior Microsoft-sourced membership (existing syncDepartmentMemberships policy — a disappeared signal is dropped, never left as a stale grant)", membershipBetaAfterUnconfigured === null);
    check("    ...and creates NO implicit new membership for the unconfigured title", allActiveMembershipsAfterUnconfigured.length === 0);

    console.log("\n=== 22. Second identical sync is idempotent (no duplicate membership rows) ===\n");
    mockGraphMe(`job-change-oid-${RUN_ID}`, jobChangeEmail, titleAlpha);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: jobChangeUser.id, oid: `job-change-oid-${RUN_ID}`, email: jobChangeEmail, name: "Job Change" });
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: jobChangeUser.id, oid: `job-change-oid-${RUN_ID}`, email: jobChangeEmail, name: "Job Change" });
    const allMembershipsFinal = await prisma.departmentMembership.findMany({ where: { userId: jobChangeUser.id, departmentId: deptA.id } });
    check("22. Re-running the identical sync twice creates exactly ONE membership row for deptA (idempotent)", allMembershipsFinal.length === 1);

    await prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: [mappingAlpha.id, mappingBeta.id] } } });
  } finally {
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
