/**
 * Regression coverage for configurable Default Global Role / Default
 * Department Role (lib/services/default-role-service.ts).
 *
 * ROOT CAUSE THIS FEATURE ADDRESSES: every "no explicit role" fallback in
 * this codebase's provisioning paths hardcoded the built-in enum values
 * Role.USER / DepartmentRole.REQUESTER directly — a brand-new user with no
 * matching Microsoft mapping, or a brand-new primary DepartmentMembership,
 * had no way to be given anything other than these two literal legacy
 * roles, and an admin who wanted a DIFFERENT starting role for new people
 * had no lever to pull. This is now fully configurable via a real
 * CustomRole reference (DefaultRoleConfig, a singleton table), consulted by
 * every provisioning call site instead of a hardcoded enum:
 *   - lib/services/microsoft-department-sync-service.ts (per-login sync —
 *     primary department placement AND the global-role "no mapping matched"
 *     fallback)
 *   - lib/services/organization-directory-sync-service.ts (tenant-wide sync
 *     — brand-new user creation AND primary department placement)
 *   - lib/services/requester-resolution-service.ts (inbound-email-derived
 *     requester creation)
 *   - lib/services/microsoft-department-autocreate-service.ts (the
 *     auto-created bootstrap MicrosoftDepartmentMapping's own role grant)
 *
 * Precedence proven below: explicit Microsoft mapping > configured default
 * > pre-existing hardcoded fallback (role:USER/REQUESTER, customRoleId:null
 * — UNCHANGED when no default is configured). Existing manual/Microsoft-
 * mapping-derived assignments are proven untouched by a later sync.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-configurable-default-roles.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  DepartmentRole,
  GlobalRoleSource,
  MembershipSource,
  MicrosoftMappingSourceType,
  Role,
  RoleScope,
  AuthProvider,
} from "@prisma/client";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
import { setPrimaryDepartmentMembership, grantManualMembership } from "@/lib/services/department-membership-service";
import {
  getDefaultRoleConfig,
  setDefaultGlobalRole,
  setDefaultDepartmentRole,
  resolveDefaultGlobalRoleAssignment,
  resolveDefaultDepartmentRoleAssignment,
  isCustomRoleConfiguredAsDefault,
  DefaultRoleConfigValidationError,
} from "@/lib/services/default-role-service";
import { normalizeDepartmentName } from "@/lib/services/organization-normalization";

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

function mockGraphMeOnce(department: string | null, oid: string, jobTitle: string | null = null) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({ id: oid, displayName: "Test User", mail: null, userPrincipalName: null, department, jobTitle }),
      { status: 200 }
    )) as typeof fetch;
}

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n0 passed, 0 failed`);
    return;
  }

  const userIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const mappingIds: string[] = [];
  const resolvedDeptNames = new Set<string>();
  let adminUserId: string | null = null;

  async function makeCustomRole(tag: string, scope: RoleScope, isActive = true) {
    const r = await prisma.customRole.create({
      data: { key: `DRC_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    return r;
  }
  async function makeUser(tag: string, data: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
    const u = await prisma.user.create({
      data: { email: `drc-${tag}-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT, ...data },
    });
    userIds.push(u.id);
    return u;
  }
  async function findResolvedPrimaryDepartment(rawDepartmentName: string) {
    resolvedDeptNames.add(rawDepartmentName);
    return prisma.department.findFirst({ where: { companyId: null, normalizedName: normalizeDepartmentName(rawDepartmentName) } });
  }

  try {
    // ══════════════ Fixture roles ══════════════
    const globalDefaultRole = await makeCustomRole("GLOBAL_DEFAULT", RoleScope.GLOBAL);
    const departmentDefaultRole = await makeCustomRole("DEPT_DEFAULT", RoleScope.DEPARTMENT);
    const bothScopeRole = await makeCustomRole("BOTH_SCOPE", RoleScope.BOTH);
    const inactiveGlobalRole = await makeCustomRole("INACTIVE_GLOBAL", RoleScope.GLOBAL, false);
    const explicitMappingCustomRole = await makeCustomRole("EXPLICIT_MAPPING_ROLE", RoleScope.GLOBAL);

    console.log("\n=== A. New user gets Default Global Role (no matching mapping) ===\n");
    await setDefaultGlobalRole(globalDefaultRole.id);
    const userA = await makeUser("a", { role: Role.USER, globalRoleSource: GlobalRoleSource.SYSTEM });
    const deptValueA = `DRC Unmapped Dept A ${RUN_ID}`;
    mockGraphMeOnce(deptValueA, `oid-a-${RUN_ID}`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userA.id, oid: `oid-a-${RUN_ID}`, email: userA.email, name: "Test A" });
    const refreshedA = await prisma.user.findUniqueOrThrow({ where: { id: userA.id } });
    check("A. New user's customRoleId is the configured Default Global Role", refreshedA.customRoleId === globalDefaultRole.id);
    check("A. globalRoleSource stays SYSTEM (not MANUAL, not MICROSOFT_DEPARTMENT — no real mapping was involved)", refreshedA.globalRoleSource === GlobalRoleSource.SYSTEM);
    check("A. role enum stays the required USER placeholder", refreshedA.role === Role.USER);

    console.log("\n=== A2. resolveOrCreateRequester (inbound-email path) also applies the Default Global Role ===\n");
    const emailUserA2 = `drc-requester-${RUN_ID}@example.com`;
    const createdA2 = await resolveOrCreateRequester(emailUserA2, "Email Requester");
    userIds.push(createdA2.id);
    check("A2. Inbound-email-created user's customRoleId is the configured Default Global Role", createdA2.customRoleId === globalDefaultRole.id);

    console.log("\n=== B. New DepartmentMembership gets Default Department Role (primary placement) ===\n");
    await setDefaultDepartmentRole(departmentDefaultRole.id);
    const userB = await makeUser("b", { role: Role.USER, globalRoleSource: GlobalRoleSource.SYSTEM });
    const deptValueB = `DRC Unmapped Dept B ${RUN_ID}`;
    mockGraphMeOnce(deptValueB, `oid-b-${RUN_ID}`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userB.id, oid: `oid-b-${RUN_ID}`, email: userB.email, name: "Test B" });
    const resolvedDeptB = await findResolvedPrimaryDepartment(deptValueB);
    check("B. Organization resolver created/found the department", !!resolvedDeptB);
    const membershipB = resolvedDeptB
      ? await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: userB.id, departmentId: resolvedDeptB.id } } })
      : null;
    check("B. New primary DepartmentMembership's customRoleId is the configured Default Department Role", membershipB?.customRoleId === departmentDefaultRole.id);
    check("B. DepartmentMembership.role is the VIEWER placeholder (matches grantManualMembership's own convention for a custom-role row)", membershipB?.role === DepartmentRole.VIEWER);
    check("B. Membership is marked primary, source MICROSOFT_DEPARTMENT", membershipB?.isPrimary === true && membershipB?.source === MembershipSource.MICROSOFT_DEPARTMENT);

    console.log("\n=== C. Explicit Microsoft mapping beats the configured default on creation ===\n");
    const mappedDeptValue = `DRC Mapped Dept C ${RUN_ID}`;
    const mappingDept = await prisma.department.create({ data: { name: `DRC Mapping Target Dept ${RUN_ID}`, slug: `drc-mapping-target-${RUN_ID}` } });
    resolvedDeptNames.add(mappingDept.name);
    const mapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
        microsoftValue: mappedDeptValue,
        domain: "",
        normalizedMicrosoftValue: mappedDeptValue,
        departmentId: mappingDept.id,
        role: Role.USER,
        globalCustomRoleId: explicitMappingCustomRole.id,
        departmentRole: DepartmentRole.REQUESTER,
      },
    });
    mappingIds.push(mapping.id);
    const userC = await makeUser("c", { role: Role.USER, globalRoleSource: GlobalRoleSource.SYSTEM });
    mockGraphMeOnce(mappedDeptValue, `oid-c-${RUN_ID}`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userC.id, oid: `oid-c-${RUN_ID}`, email: userC.email, name: "Test C" });
    const refreshedC = await prisma.user.findUniqueOrThrow({ where: { id: userC.id } });
    check("C. User's customRoleId is the MAPPING's globalCustomRoleId, NOT the configured Default Global Role", refreshedC.customRoleId === explicitMappingCustomRole.id);
    check("C. Confirms the default and the mapping target are genuinely different roles (a real precedence test, not a coincidence)", explicitMappingCustomRole.id !== globalDefaultRole.id);
    check("C. globalRoleSource is MICROSOFT_DEPARTMENT (mapping-derived), not SYSTEM (default-derived)", refreshedC.globalRoleSource === GlobalRoleSource.MICROSOFT_DEPARTMENT);

    console.log("\n=== D. Manual role survives a later sync (both global and department level) ===\n");
    const manualGlobalRole = await makeCustomRole("MANUAL_GLOBAL", RoleScope.GLOBAL);
    const userD = await makeUser("d", { role: Role.USER, customRoleId: manualGlobalRole.id, globalRoleSource: GlobalRoleSource.MANUAL });
    const deptValueD = `DRC Unmapped Dept D ${RUN_ID}`;
    mockGraphMeOnce(deptValueD, `oid-d-${RUN_ID}`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userD.id, oid: `oid-d-${RUN_ID}`, email: userD.email, name: "Test D" });
    const refreshedD = await prisma.user.findUniqueOrThrow({ where: { id: userD.id } });
    check("D. MANUAL global customRoleId is UNTOUCHED by a later sync with no mapping match (default never applied over a MANUAL assignment)", refreshedD.customRoleId === manualGlobalRole.id);
    check("D. globalRoleSource stays MANUAL", refreshedD.globalRoleSource === GlobalRoleSource.MANUAL);

    const manualDeptRole = await makeCustomRole("MANUAL_DEPT", RoleScope.DEPARTMENT);
    const userD2 = await makeUser("d2");
    const deptD2 = await prisma.department.create({ data: { name: `DRC Manual Primary Dept ${RUN_ID}`, slug: `drc-manual-primary-${RUN_ID}` } });
    resolvedDeptNames.add(deptD2.name);
    await prisma.departmentMembership.create({
      data: { userId: userD2.id, departmentId: deptD2.id, role: DepartmentRole.VIEWER, customRoleId: manualDeptRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    // A later call using the SAME shape microsoft-department-sync-service.ts
    // uses (source MICROSOFT_DEPARTMENT, the resolved default) — proves
    // setPrimaryDepartmentMembership's own MANUAL protection still fully
    // applies even when the caller now ALSO passes a customRoleId.
    const deptDefaultForD2 = await resolveDefaultDepartmentRoleAssignment();
    const resultD2 = await setPrimaryDepartmentMembership(userD2.id, deptD2.id, MembershipSource.MICROSOFT_DEPARTMENT, {
      role: deptDefaultForD2.role,
      customRoleId: deptDefaultForD2.customRoleId,
      deactivateObsoleteMicrosoftPrimary: true,
    });
    check("D. MANUAL department customRoleId is UNTOUCHED by a later Microsoft-sourced call carrying the default", resultD2.primaryMembership.customRoleId === manualDeptRole.id);
    check("D. MANUAL department membership source stays MANUAL", resultD2.primaryMembership.source === MembershipSource.MANUAL);

    console.log("\n=== E. Deleted/absent legacy USER/REQUESTER CustomRoles are never recreated or depended on ===\n");
    const customRoleCountBefore = await prisma.customRole.count();
    await setDefaultGlobalRole(null);
    await setDefaultDepartmentRole(null);
    const userE = await makeUser("e", { role: Role.USER, globalRoleSource: GlobalRoleSource.SYSTEM });
    const deptValueE = `DRC Unmapped Dept E ${RUN_ID}`;
    mockGraphMeOnce(deptValueE, `oid-e-${RUN_ID}`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userE.id, oid: `oid-e-${RUN_ID}`, email: userE.email, name: "Test E" });
    const refreshedE = await prisma.user.findUniqueOrThrow({ where: { id: userE.id } });
    const customRoleCountAfter = await prisma.customRole.count();
    check("E. With no default configured, provisioning falls back to the pre-existing role:USER/customRoleId:null (never invents/looks up a role by the literal name 'USER')", refreshedE.role === Role.USER && refreshedE.customRoleId === null);
    check("E. Zero new CustomRole rows were created as a side effect of provisioning with no default configured", customRoleCountAfter === customRoleCountBefore);
    const fs = await import("fs");
    const serviceSrc = fs.readFileSync("lib/services/default-role-service.ts", "utf-8");
    check("E. default-role-service.ts never references the literal built-in role keys 'USER'/'REQUESTER' as a lookup identity (source-level proof — resolution is 100% customRoleId-based, no name-based fallback)", !/["'`](USER|REQUESTER)["'`]/.test(serviceSrc));

    console.log("\n=== F. Default role scope validation ===\n");
    let threw: DefaultRoleConfigValidationError | null = null;
    try { await setDefaultGlobalRole(departmentDefaultRole.id); } catch (e) { threw = e as DefaultRoleConfigValidationError; }
    check("F. Setting a DEPARTMENT-only-scope role as the Default Global Role throws INVALID_SCOPE_FOR_GLOBAL_DEFAULT", threw instanceof DefaultRoleConfigValidationError && threw.reason === "INVALID_SCOPE_FOR_GLOBAL_DEFAULT");

    threw = null;
    try { await setDefaultDepartmentRole(globalDefaultRole.id); } catch (e) { threw = e as DefaultRoleConfigValidationError; }
    check("F. Setting a GLOBAL-only-scope role as the Default Department Role throws INVALID_SCOPE_FOR_DEPARTMENT_DEFAULT", threw instanceof DefaultRoleConfigValidationError && threw.reason === "INVALID_SCOPE_FOR_DEPARTMENT_DEFAULT");

    threw = null;
    try { await setDefaultGlobalRole(inactiveGlobalRole.id); } catch (e) { threw = e as DefaultRoleConfigValidationError; }
    check("F. Setting an INACTIVE role as a default throws ROLE_INACTIVE", threw instanceof DefaultRoleConfigValidationError && threw.reason === "ROLE_INACTIVE");

    threw = null;
    try { await setDefaultGlobalRole("nonexistent-id-xyz"); } catch (e) { threw = e as DefaultRoleConfigValidationError; }
    check("F. Setting a nonexistent role id throws ROLE_NOT_FOUND", threw instanceof DefaultRoleConfigValidationError && threw.reason === "ROLE_NOT_FOUND");

    await setDefaultGlobalRole(bothScopeRole.id);
    await setDefaultDepartmentRole(bothScopeRole.id);
    const configBoth = await getDefaultRoleConfig();
    check("F. A BOTH-scope role is valid for EITHER default simultaneously", configBoth.defaultGlobalCustomRole?.id === bothScopeRole.id && configBoth.defaultDepartmentCustomRole?.id === bothScopeRole.id);

    console.log("\n=== F2. Same validation enforced by the admin API route (PATCH /api/admin/default-roles) ===\n");
    adminUserId = (await makeUser("admin-f2", { role: Role.ADMIN })).id;
    currentSession = { user: { id: adminUserId, role: Role.ADMIN, customRoleId: null } };
    const { PATCH: defaultRolesPATCH } = await import("@/app/api/admin/default-roles/route");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/api/admin/default-roles", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const badRes = await defaultRolesPATCH(jsonReq({ defaultGlobalCustomRoleId: departmentDefaultRole.id }));
    check("F2. API route rejects an invalid-scope default with 422 + the same reason code", badRes.status === 422 && (await badRes.clone().json()).code === "INVALID_SCOPE_FOR_GLOBAL_DEFAULT");
    const goodRes = await defaultRolesPATCH(jsonReq({ defaultGlobalCustomRoleId: globalDefaultRole.id }));
    check("F2. API route accepts a valid default and persists it", goodRes.status === 200 && (await goodRes.clone().json()).defaultGlobalCustomRole?.id === globalDefaultRole.id);

    console.log("\n=== G. Deletion/deactivation protection for a currently-configured default ===\n");
    await setDefaultGlobalRole(globalDefaultRole.id);
    await setDefaultDepartmentRole(departmentDefaultRole.id);
    const kinds = await isCustomRoleConfiguredAsDefault(globalDefaultRole.id);
    check("G. isCustomRoleConfiguredAsDefault correctly reports the global default", kinds.asGlobalDefault === true && kinds.asDepartmentDefault === false);

    const { DELETE: rolesDELETE, PATCH: rolesPATCH } = await import("@/app/api/admin/roles/[id]/route");
    const deleteRes = await rolesDELETE(new NextRequest("http://localhost", { method: "DELETE" }), { params: Promise.resolve({ id: globalDefaultRole.id }) });
    check("G. DELETE on the currently-default-configured role is blocked (409 role_is_configured_default)", deleteRes.status === 409 && (await deleteRes.clone().json()).code === "role_is_configured_default");

    const deactivateRes = await rolesPATCH(
      new NextRequest("http://localhost", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: false }) }),
      { params: Promise.resolve({ id: departmentDefaultRole.id }) }
    );
    check("G. PATCH isActive:false on the currently-default-configured DEPARTMENT role is blocked (409 role_is_configured_default)", deactivateRes.status === 409 && (await deactivateRes.clone().json()).code === "role_is_configured_default");

    // Clear the default, then the SAME deactivation succeeds — proves the
    // guard is specifically about "currently configured," not a blanket
    // lock on these particular rows.
    await setDefaultDepartmentRole(null);
    const deactivateRes2 = await rolesPATCH(
      new NextRequest("http://localhost", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: false }) }),
      { params: Promise.resolve({ id: departmentDefaultRole.id }) }
    );
    check("G. After clearing the default, the SAME role can now be deactivated", deactivateRes2.status === 200);
    // Restore isActive:true so cleanup (which doesn't touch isActive) leaves no surprise for any later run reusing role keys (RUN_ID-scoped anyway, but tidy).
    await prisma.customRole.update({ where: { id: departmentDefaultRole.id }, data: { isActive: true } });
  } finally {
    currentSession = null;
    await prisma.defaultRoleConfig.updateMany({
      where: { id: "singleton" },
      data: { defaultGlobalCustomRoleId: null, defaultDepartmentCustomRoleId: null },
    });
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { customRoleId: null } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    if (resolvedDeptNames.size > 0) {
      const names = [...resolvedDeptNames];
      const depts = await prisma.department.findMany({ where: { companyId: null, normalizedName: { in: names.map(normalizeDepartmentName) } } });
      const deptIds = depts.map((d) => d.id);
      if (deptIds.length > 0) {
        await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.microsoftDepartmentMapping.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
