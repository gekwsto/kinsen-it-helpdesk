/**
 * Regression coverage for "Remove SQLGeneral Company Constraint from
 * Approved Department Placement" — Company identity and Primary
 * Department placement are now COMPLETELY independent. An explicitly
 * approved HR Department mapping (SqlGeneralDepartmentMapping) is
 * authoritative on its own; it is never additionally required to agree
 * with whatever local Company the department's own staff happen to be
 * separately, independently verified under.
 *
 * ROOT CAUSE this file guards against (found via a real production
 * dry-run): the PRIOR round's "many-to-one across Companies" fix still
 * required that SOME SqlGeneralCompanyMapping existed connecting the
 * evidence/acting SQLGeneral CompanyId to the TARGET Department's own
 * local Company. In production, SQLGeneral Company "3" ("Kinsen Hellas
 * S.A.") already had its OWN, different, perfectly legitimate approved
 * mapping (to the "Kinsen Hellas S.A." local Company) — so three HR
 * Departments staffed by Company-"3" employees could never be approved
 * onto an unrelated target Company ("Saracakis Group of Companies"), even
 * though an admin had explicitly reviewed and approved exactly that
 * Department-level mapping. Fixed by removing the CompanyId-evidence
 * cross-check ENTIRELY from both validateSqlGeneralDepartmentSourceHierarchy
 * (approval-time) and resolveSqlGeneralPlacementTarget (write-time) —
 * Department-mapping validation is now PURELY structural (SQLGeneral
 * ancestor chain must resolve — no missing parent, no cycle); it never
 * inspects live UsersAndManagers CompanyId evidence at all any more.
 *
 * Also adds explicit, confirmation-gated REPLACEMENT of an already-
 * approved Department mapping (confirmReplaceExisting) — previously there
 * was no way to re-point a stale mapping at all short of a direct DB
 * edit; approveSqlGeneralDepartmentMapping unconditionally refused.
 *
 * Covers: a Department mapping succeeds even when its own staff's
 * SQLGeneral Company already has a DIFFERENT, unrelated local Company
 * approved (the exact production shape); the actual worker places such a
 * user correctly; Preview and the worker agree; explicit, audited
 * replacement of an existing mapping (never implicit — the plain call
 * still refuses exactly as before); structural (cycle/missing-parent)
 * validation is unchanged; SqlGeneralCompanyMapping's own 1:1-per-
 * SQLGeneral-Company semantics are completely untouched.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: node --experimental-test-module-mocks --import tsx scripts/test-sqlgeneral-department-company-independence.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource, Role, OrganizationNodeSource } from "@prisma/client";

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

  process.env.SQLGENERAL_PRIMARY_PLACEMENT_ENABLED = "true";

  const { mock } = await import("node:test");
  const realClient = await import("@/lib/sqlgeneral-api-client");
  let mockFindUserImpl: typeof realClient.findSqlGeneralUserByUsername = async () => {
    throw new Error("mock: no findSqlGeneralUserByUsername impl installed");
  };
  let mockListDeptImpl: typeof realClient.listAllSqlGeneralDepartments = async () => ({ ok: true, departments: [] });
  let mockVerifyCompanyImpl: typeof realClient.verifySqlGeneralCompanyIdExists = async () => ({ ok: true, exists: true });
  let mockVerifyDeptImpl: typeof realClient.verifySqlGeneralDepartmentIdExists = async () => ({ ok: true, exists: true });

  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realClient,
      findSqlGeneralUserByUsername: (u: string) => mockFindUserImpl(u),
      listAllSqlGeneralDepartments: () => mockListDeptImpl(),
      verifySqlGeneralCompanyIdExists: (id: string) => mockVerifyCompanyImpl(id),
      verifySqlGeneralDepartmentIdExists: (id: string) => mockVerifyDeptImpl(id),
    },
  });

  const svc = await import("@/lib/services/sqlgeneral-user-sync-service");
  const { normalizeCompanyName, normalizeDepartmentName } = await import("@/lib/services/organization-normalization");

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];

  async function makeUser(tag: string): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `sgci-${tag}-${RUN_ID}@kinsen.gr`, name: `SGCI ${tag}`, role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true },
    });
    userIds.push(u.id);
    return u.id;
  }
  const attempt = (userId: string) => prisma.sqlGeneralUserSyncAttempt.findUniqueOrThrow({ where: { userId } });
  async function driveSync(userId: string, username: string, departments: any[], now = new Date()) {
    await svc.enqueueOrRecoverSqlGeneralUserSync(userId, username);
    const row = await attempt(userId);
    const token = `token-${userId}-${row.attemptCount}`;
    await prisma.sqlGeneralUserSyncAttempt.update({ where: { userId }, data: { status: "PROCESSING", claimedAt: now, claimToken: token } });
    const outcome = await svc.processClaimedSqlGeneralUserSync(row.id, token, now, departments);
    return { outcome, row: await attempt(userId) };
  }
  const fakeHrUser = (username: string, hrDepartmentId: string, sqlGeneralCompanyId: string, company: string, active = true) => ({
    username, mail: null, hrDepartmentId, department: null, companyId: sqlGeneralCompanyId, company, active,
    managerAMAccountName: null, manager2AMAccountName: null, manager3AMAccountName: null,
  });

  try {
    console.log("\n=== Setup: two local Companies, EACH with its own approved SQLGeneral Company mapping — unrelated to each other ===\n");
    const admin = await makeUser("admin-actor");
    const COMPANY_KINSEN_SG = `sgci-companyKinsen-${RUN_ID}`;
    const COMPANY_SARACAKIS_SG = `sgci-companySaracakis-${RUN_ID}`;

    const kinsenCo = await prisma.company.create({ data: { name: `Kinsen Hellas ${RUN_ID}`, normalizedName: normalizeCompanyName(`Kinsen Hellas ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } });
    companyIds.push(kinsenCo.id);
    const saracakisCo = await prisma.company.create({ data: { name: `Saracakis Group ${RUN_ID}`, normalizedName: normalizeCompanyName(`Saracakis Group ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } });
    companyIds.push(saracakisCo.id);

    const approveKinsen = await svc.approveSqlGeneralCompanyMapping(COMPANY_KINSEN_SG, kinsenCo.id, admin);
    check("Setup: Company 'Kinsen' -> local Kinsen Co approved", approveKinsen.ok === true);
    const approveSaracakis = await svc.approveSqlGeneralCompanyMapping(COMPANY_SARACAKIS_SG, saracakisCo.id, admin);
    check("Setup: Company 'Saracakis' -> local Saracakis Co approved (completely unrelated mapping)", approveSaracakis.ok === true);

    const saracakisTargetDept = await prisma.department.create({
      data: { name: `Software Engineering ${RUN_ID}`, normalizedName: normalizeDepartmentName(`Software Engineering ${RUN_ID}`), slug: `sgci-swe-${RUN_ID}`, companyId: saracakisCo.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(saracakisTargetDept.id);
    const kinsenOldDept = await prisma.department.create({
      data: { name: `Software Engineering (legacy, Kinsen) ${RUN_ID}`, normalizedName: normalizeDepartmentName(`Software Engineering (legacy, Kinsen) ${RUN_ID}`), slug: `sgci-swe-legacy-${RUN_ID}`, companyId: kinsenCo.id, importSource: OrganizationNodeSource.SQLGENERAL },
    });
    departmentIds.push(kinsenOldDept.id);

    const HR_362 = `sgci-hr362-${RUN_ID}`;
    const FAKE_HR_362 = { id: HR_362, description: `Software Engineering ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: `Kinsen Hellas ${RUN_ID}`, companyShortname: "KIN", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_HR_362] });

    // ══════════════════════ 1. Cross-company Department approval: the exact production shape ══════════════════════
    console.log("\n=== 1. A Department staffed by 'Kinsen' Company employees is approved onto a 'Saracakis' Company Department — the staff's OWN Company has a DIFFERENT, unrelated approved mapping ===\n");
    const candidateBefore = await svc.previewSqlGeneralDepartmentMappingCandidate(HR_362, saracakisTargetDept.id);
    check("1. hierarchyValidation is purely structural now — 'root' despite the Company mismatch", candidateBefore.hierarchyValidation.status === "root", JSON.stringify(candidateBefore.hierarchyValidation));
    const approve362 = await svc.approveSqlGeneralDepartmentMapping(HR_362, saracakisTargetDept.id, admin);
    check("1. approve() SUCCEEDS — Company identity never blocks this any more (THE CORE FIX)", approve362.ok === true, approve362.ok ? undefined : (approve362 as { reason: string }).reason);
    const mappingRow = await prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: HR_362 } });
    check("1. ...the mapping row points at the Saracakis target", mappingRow?.departmentId === saracakisTargetDept.id);

    // ══════════════════════ 2. The actual worker places such a user correctly, and Preview agrees ══════════════════════
    console.log("\n=== 2. The actual worker places a Company-'Kinsen' user into the Saracakis-owned Department, and Preview predicts the SAME outcome ══════════════════════\n");
    const user362 = await makeUser("user-362");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgci-user-362", HR_362, COMPANY_KINSEN_SG, `Kinsen Hellas ${RUN_ID}`) });
    await svc.enqueueOrRecoverSqlGeneralUserSync(user362, "sgci-user-362");
    const previewBefore = await svc.previewSqlGeneralUserSync({ userIds: [user362] });
    check("2. Preview call succeeds", previewBefore.ok === true);
    if (previewBefore.ok) {
      check("2. Preview proposes the Saracakis Department id, regardless of this user's own Kinsen Company", previewBefore.rows[0].proposedDepartmentId === saracakisTargetDept.id);
      check("2. Preview outcome is would_place", previewBefore.rows[0].primaryChangeOutcome === "would_place");
    }
    const { outcome: outcome362 } = await driveSync(user362, "sgci-user-362", [FAKE_HR_362]);
    check("2. The actual worker run SUCCEEDS", outcome362 === "succeeded");
    const after362 = await prisma.user.findUnique({ where: { id: user362 } });
    check("2. User.departmentId is the Saracakis Department — exactly as Preview predicted", after362?.departmentId === saracakisTargetDept.id);
    check("2. User.companyId is still this user's OWN resolved Company (Kinsen) — User.companyId semantics untouched, never forced to Saracakis", after362?.companyId === kinsenCo.id);

    // ══════════════════════ 3. Explicit, audited REPLACEMENT of an existing mapping ══════════════════════
    console.log("\n=== 3. Explicit, confirmation-gated replacement of an already-approved Department mapping (HR 362-style) ===\n");
    const HR_REPLACE = `sgci-hrreplace-${RUN_ID}`;
    const FAKE_HR_REPLACE = { id: HR_REPLACE, description: `Replace Test Dept ${RUN_ID}`, isActive: true, parentDepartmentId: null, country: null, company: `Kinsen Hellas ${RUN_ID}`, companyShortname: "KIN", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_HR_362, FAKE_HR_REPLACE] });

    const firstApprove = await svc.approveSqlGeneralDepartmentMapping(HR_REPLACE, kinsenOldDept.id, admin);
    check("3. Initial approval onto the OLD (Kinsen) target succeeds", firstApprove.ok === true);
    const beforeReplace = await prisma.sqlGeneralDepartmentMapping.findUniqueOrThrow({ where: { sqlGeneralDepartmentId: HR_REPLACE } });
    check("3. ...mapping points at the OLD target, audited to the original approver", beforeReplace.departmentId === kinsenOldDept.id && beforeReplace.approvedById === admin);

    console.log("\n-- A plain re-approval onto a DIFFERENT target (no confirmReplaceExisting) is refused — never implicit --\n");
    const refusedReplace = await svc.approveSqlGeneralDepartmentMapping(HR_REPLACE, saracakisTargetDept.id, admin);
    check("3. Without confirmReplaceExisting, the call is refused", refusedReplace.ok === false, refusedReplace.ok ? "unexpectedly ok" : undefined);
    const unchangedAfterRefusal = await prisma.sqlGeneralDepartmentMapping.findUniqueOrThrow({ where: { sqlGeneralDepartmentId: HR_REPLACE } });
    check("3. ...the mapping is byte-for-byte UNCHANGED after the refused attempt (never an implicit mutation)", unchangedAfterRefusal.departmentId === beforeReplace.departmentId && unchangedAfterRefusal.approvedAt.getTime() === beforeReplace.approvedAt.getTime());

    console.log("\n-- WITH confirmReplaceExisting: true, the replacement succeeds and the audit trail is updated --\n");
    const replacerAdmin = await makeUser("replacer-admin");
    const explicitReplace = await svc.approveSqlGeneralDepartmentMapping(HR_REPLACE, saracakisTargetDept.id, replacerAdmin, false, true);
    check("3. Explicit confirmReplaceExisting:true SUCCEEDS", explicitReplace.ok === true, explicitReplace.ok ? undefined : (explicitReplace as { reason: string }).reason);
    const afterReplace = await prisma.sqlGeneralDepartmentMapping.findUniqueOrThrow({ where: { sqlGeneralDepartmentId: HR_REPLACE } });
    check("3. ...the mapping NOW points at the NEW (Saracakis) target", afterReplace.departmentId === saracakisTargetDept.id);
    check("3. ...the audit trail reflects WHO replaced it and WHEN (approvedById changed to the replacer, approvedAt refreshed)", afterReplace.approvedById === replacerAdmin && afterReplace.approvedAt.getTime() > beforeReplace.approvedAt.getTime());
    check("3. ...exactly one mapping row still exists for this HR id (replaced in place, never duplicated)", (await prisma.sqlGeneralDepartmentMapping.count({ where: { sqlGeneralDepartmentId: HR_REPLACE } })) === 1);

    console.log("\n-- Worker/Preview parity after the replacement --\n");
    const userReplace = await makeUser("user-replace");
    mockFindUserImpl = async () => ({ outcome: "unique" as const, user: fakeHrUser("sgci-user-replace", HR_REPLACE, COMPANY_KINSEN_SG, `Kinsen Hellas ${RUN_ID}`) });
    await svc.enqueueOrRecoverSqlGeneralUserSync(userReplace, "sgci-user-replace");
    const previewAfterReplace = await svc.previewSqlGeneralUserSync({ userIds: [userReplace] });
    if (previewAfterReplace.ok) {
      check("3. Preview after replacement proposes the NEW (Saracakis) target, not the old one", previewAfterReplace.rows[0].proposedDepartmentId === saracakisTargetDept.id);
    }
    const { outcome: replaceOutcome } = await driveSync(userReplace, "sgci-user-replace", [FAKE_HR_362, FAKE_HR_REPLACE]);
    check("3. The actual worker places this user into the NEW (replaced) target too", replaceOutcome === "succeeded");
    const afterReplaceUser = await prisma.user.findUnique({ where: { id: userReplace } });
    check("3. ...User.departmentId matches the replaced mapping's new target", afterReplaceUser?.departmentId === saracakisTargetDept.id);

    // ══════════════════════ 4. Structural validation (cycle/missing parent) is UNCHANGED ══════════════════════
    console.log("\n=== 4. Structural hierarchy validation (cycle, missing parent) is completely unchanged by this round ===\n");
    const HR_CYCLE_A = `sgci-cycA-${RUN_ID}`;
    const HR_CYCLE_B = `sgci-cycB-${RUN_ID}`;
    const FAKE_CYCLE_A = { id: HR_CYCLE_A, description: "Cycle A", isActive: true, parentDepartmentId: HR_CYCLE_B, country: null, company: `Kinsen Hellas ${RUN_ID}`, companyShortname: "KIN", creationDate: null, updateTimestamp: null };
    const FAKE_CYCLE_B = { id: HR_CYCLE_B, description: "Cycle B", isActive: true, parentDepartmentId: HR_CYCLE_A, country: null, company: `Kinsen Hellas ${RUN_ID}`, companyShortname: "KIN", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_HR_362, FAKE_HR_REPLACE, FAKE_CYCLE_A, FAKE_CYCLE_B] });
    const cycleCandidate = await svc.previewSqlGeneralDepartmentMappingCandidate(HR_CYCLE_A, saracakisTargetDept.id);
    check("4. A genuine cycle is STILL reported as unresolved — structural integrity preserved", cycleCandidate.hierarchyValidation.status === "unresolved" && /cycle/i.test((cycleCandidate.hierarchyValidation as { reason: string }).reason));
    const cycleApprove = await svc.approveSqlGeneralDepartmentMapping(HR_CYCLE_A, saracakisTargetDept.id, admin, true);
    check("4. ...and approve() still refuses a cyclic chain", cycleApprove.ok === false);

    const HR_MISSING_PARENT = `sgci-missingparent-${RUN_ID}`;
    const FAKE_MISSING_PARENT = { id: HR_MISSING_PARENT, description: "Orphan", isActive: true, parentDepartmentId: "does-not-exist", country: null, company: `Kinsen Hellas ${RUN_ID}`, companyShortname: "KIN", creationDate: null, updateTimestamp: null };
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_HR_362, FAKE_HR_REPLACE, FAKE_MISSING_PARENT] });
    const missingParentApprove = await svc.approveSqlGeneralDepartmentMapping(HR_MISSING_PARENT, saracakisTargetDept.id, admin, true);
    check("4. A missing-parent chain is STILL refused — structural integrity preserved", missingParentApprove.ok === false);

    // ══════════════════════ 5. Unmapped/unapproved targets still fail closed ══════════════════════
    console.log("\n=== 5. A target Department with NO Company, or no approved Company mapping at all, still fails closed ===\n");
    const noCompanyDept = await prisma.department.create({
      data: { name: `No Company Dept ${RUN_ID}`, normalizedName: normalizeDepartmentName(`No Company Dept ${RUN_ID}`), slug: `sgci-nocompany-${RUN_ID}` },
    });
    departmentIds.push(noCompanyDept.id);
    mockListDeptImpl = async () => ({ ok: true, departments: [FAKE_HR_362, FAKE_HR_REPLACE] });
    const noCompanyApprove = await svc.approveSqlGeneralDepartmentMapping(`sgci-nocompanyhr-${RUN_ID}`, noCompanyDept.id, admin);
    check("5. A target Department with no Company at all is refused", noCompanyApprove.ok === false);

    const unmappedCoDept = await prisma.department.create({
      data: { name: `Unmapped Co Dept ${RUN_ID}`, normalizedName: normalizeDepartmentName(`Unmapped Co Dept ${RUN_ID}`), slug: `sgci-unmappedco-${RUN_ID}`, companyId: (await prisma.company.create({ data: { name: `Unmapped Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`Unmapped Co ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } })).id },
    });
    departmentIds.push(unmappedCoDept.id);
    companyIds.push(unmappedCoDept.companyId!);
    const unmappedCoApprove = await svc.approveSqlGeneralDepartmentMapping(`sgci-unmappedcohr-${RUN_ID}`, unmappedCoDept.id, admin);
    check("5. A target Department whose Company has NO approved SqlGeneralCompanyMapping at all is still refused", unmappedCoApprove.ok === false, unmappedCoApprove.ok ? "unexpectedly ok" : (unmappedCoApprove as { reason: string }).reason);

    // ══════════════════════ 6. SqlGeneralCompanyMapping's own 1:1-per-Company semantics are untouched ══════════════════════
    console.log("\n=== 6. SqlGeneralCompanyMapping's own semantics are completely untouched — a Company still cannot be re-pointed at all ===\n");
    const otherLocalCo = await prisma.company.create({ data: { name: `Other Local Co ${RUN_ID}`, normalizedName: normalizeCompanyName(`Other Local Co ${RUN_ID}`), importSource: OrganizationNodeSource.SQLGENERAL } });
    companyIds.push(otherLocalCo.id);
    const repointAttempt = await svc.approveSqlGeneralCompanyMapping(COMPANY_KINSEN_SG, otherLocalCo.id, admin);
    check("6. Re-pointing an already-approved SQLGeneral Company to a DIFFERENT local Company is still refused (no replace mechanism added here — out of scope, untouched)", repointAttempt.ok === false);
    const kinsenMappingUnchanged = await prisma.sqlGeneralCompanyMapping.findUniqueOrThrow({ where: { sqlGeneralCompanyId: COMPANY_KINSEN_SG } });
    check("6. ...and the original Kinsen mapping is unchanged", kinsenMappingUnchanged.companyId === kinsenCo.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralUserSyncAttempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } })],
      ["sqlGeneralDepartmentMappings", () => prisma.sqlGeneralDepartmentMapping.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["sqlGeneralCompanyMappings", () => prisma.sqlGeneralCompanyMapping.deleteMany({ where: { companyId: { in: companyIds } } })],
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
