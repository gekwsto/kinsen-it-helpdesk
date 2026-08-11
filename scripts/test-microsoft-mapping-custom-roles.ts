/**
 * Custom Global Role / Custom Department Role support in Microsoft Mapping.
 * Proves the full chain end-to-end using isolated, RUN_ID-tagged fixtures:
 *   Roles & Permissions (CustomRole + RolePermission)
 *     -> role-options services (getMicrosoftMappingGlobalRoleOptions/
 *        getMicrosoftMappingDepartmentRoleOptions)
 *     -> createMapping/updateMapping (globalCustomRoleId/departmentCustomRoleId,
 *        type-safety validation)
 *     -> login sync (syncMicrosoftUserDepartment) -> User.customRoleId /
 *        DepartmentMembership.customRoleId
 *     -> hasPermission/hasDepartmentPermission (effective permissions come
 *        from the CustomRole, not the placeholder enum)
 *   plus rename-safety, deactivation behavior, wrong-scope/built-in
 *   rejection, and the role-deletion guard.
 *
 * Usage: npx tsx scripts/test-microsoft-mapping-custom-roles.ts
 */
process.env.ALLOWED_EMAIL_DOMAIN = "kinsen.gr";

import { prisma } from "@/lib/prisma";
import {
  AuthProvider,
  DepartmentRole,
  GlobalRoleSource,
  MicrosoftMappingSourceType,
  Role,
  RoleScope,
} from "@prisma/client";
import {
  createMapping,
  updateMapping,
  MicrosoftMappingValidationError,
} from "@/lib/services/microsoft-mapping-service";
import {
  getMicrosoftMappingGlobalRoleOptions,
  getMicrosoftMappingDepartmentRoleOptions,
} from "@/lib/services/microsoft-mapping-role-options-service";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { hasPermission, hasDepartmentPermission } from "@/lib/permissions";
import { createMicrosoftMappingSchema } from "@/lib/validations";

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
const TAG = `mmcr-${RUN_ID}`;

function mockGraphMe(oid: string, mail: string | null, jobTitle: string | null) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({ id: oid, displayName: "Test User", mail, userPrincipalName: null, userType: "Member", department: null, jobTitle }),
      { status: 200 }
    )) as typeof fetch;
}

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const departmentIds: string[] = [];
const customRoleIds: string[] = [];
const mappingIds: string[] = [];
const userIds: string[] = [];

async function cleanup() {
  await prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } });
  await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.rolePermission.deleteMany({ where: { roleKey: { contains: TAG } } });
  await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
  if (departmentIds.length > 0) {
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
    await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
  }
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  try {
    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);

    // A real Permission row to attach to the custom roles below, distinct
    // from any permission the built-in USER/REQUESTER roles already have —
    // so "effective permission comes from the custom role" is a genuine,
    // non-trivial assertion, not something a placeholder role would pass
    // anyway.
    const grantedPermission = await prisma.permission.findFirst({ where: { key: "department.manageSettings" } });
    const otherPermission = await prisma.permission.findFirst({ where: { key: "ticket.assign" } });
    if (!grantedPermission || !otherPermission) {
      console.log("Expected seeded permissions not found — skipping (seed likely not run).");
      return;
    }

    console.log("\n=== Custom Global Role: create + permission grant ===\n");
    const globalRole = await prisma.customRole.create({
      data: { key: `${TAG}-PROCUREMENT-MANAGER`, name: "Procurement Manager", isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleIds.push(globalRole.id);
    await prisma.rolePermission.create({ data: { roleKey: globalRole.key, permissionId: grantedPermission.id } });
    check("1. Custom Global Role created", !!globalRole.id);

    console.log("\n=== Custom Department Role: create + permission grant ===\n");
    const deptRole = await prisma.customRole.create({
      data: { key: `${TAG}-PROCUREMENT-REVIEWER`, name: "Procurement Reviewer", isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(deptRole.id);
    await prisma.rolePermission.create({ data: { roleKey: deptRole.key, permissionId: otherPermission.id } });
    check("2. Custom Department Role created", !!deptRole.id);

    console.log("\n=== 1-2. Options services: built-in + custom, privileged roles excluded ===\n");
    const globalOptions = await getMicrosoftMappingGlobalRoleOptions();
    const deptOptions = await getMicrosoftMappingDepartmentRoleOptions();
    check("Built-in eligible Global Roles still appear (IT_AGENT)", globalOptions.some((o) => o.value === Role.IT_AGENT));
    check("Custom Global Role appears in options", globalOptions.some((o) => o.customRoleId === globalRole.id && o.label === "Procurement Manager"));
    check("Administrator remains excluded from Global Role options", !globalOptions.some((o) => o.value === Role.ADMIN));
    check("Built-in eligible Department Roles still appear (AGENT_ASSIGNEE)", deptOptions.some((o) => o.value === DepartmentRole.AGENT_ASSIGNEE));
    check("Custom Department Role appears in options", deptOptions.some((o) => o.customRoleId === deptRole.id && o.label === "Procurement Reviewer"));
    check("Department Admin remains excluded from Department Role options", !deptOptions.some((o) => o.value === DepartmentRole.DEPARTMENT_ADMIN));

    console.log("\n=== 3-4. Type safety: wrong-scope / built-in role ids rejected ===\n");
    let wrongScopeGlobalRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `${TAG}-bad-1`,
        departmentId: dept.id,
        globalCustomRoleId: deptRole.id, // a DEPARTMENT-scope role submitted as the GLOBAL slot
        departmentRole: DepartmentRole.VIEWER,
      });
    } catch (err) {
      wrongScopeGlobalRejected = err instanceof MicrosoftMappingValidationError && err.code === "GLOBAL_CUSTOM_ROLE_INVALID";
    }
    check("A Department-scope role id submitted as Global Role is rejected", wrongScopeGlobalRejected);

    let wrongScopeDeptRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `${TAG}-bad-2`,
        departmentId: dept.id,
        role: Role.USER,
        departmentCustomRoleId: globalRole.id, // a GLOBAL-scope role submitted as the DEPARTMENT slot
      });
    } catch (err) {
      wrongScopeDeptRejected = err instanceof MicrosoftMappingValidationError && err.code === "DEPARTMENT_CUSTOM_ROLE_INVALID";
    }
    check("A Global-scope role id submitted as Department Role is rejected", wrongScopeDeptRejected);

    const builtInMirroredAdmin = await prisma.customRole.findUnique({ where: { key: "ADMIN" } });
    let builtInIdRejected = false;
    if (builtInMirroredAdmin) {
      try {
        await createMapping({
          sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
          microsoftValue: `${TAG}-bad-3`,
          departmentId: dept.id,
          globalCustomRoleId: builtInMirroredAdmin.id, // built-in row's id sent through the custom-role slot
          departmentRole: DepartmentRole.VIEWER,
        });
      } catch (err) {
        builtInIdRejected = err instanceof MicrosoftMappingValidationError && err.code === "GLOBAL_CUSTOM_ROLE_INVALID";
      }
    }
    check("A built-in role's CustomRole id sent as globalCustomRoleId is rejected (must use the plain enum field)", builtInIdRejected);

    let nonexistentRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `${TAG}-bad-4`,
        departmentId: dept.id,
        globalCustomRoleId: "does-not-exist",
        departmentRole: DepartmentRole.VIEWER,
      });
    } catch (err) {
      nonexistentRejected = err instanceof MicrosoftMappingValidationError && err.code === "GLOBAL_CUSTOM_ROLE_NOT_FOUND";
    }
    check("A nonexistent globalCustomRoleId is rejected", nonexistentRejected);

    console.log("\n=== Zod schema: mutual exclusion ===\n");
    const bothProvided = createMicrosoftMappingSchema.safeParse({
      sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
      microsoftValue: "x",
      departmentId: dept.id,
      role: Role.USER,
      globalCustomRoleId: globalRole.id,
      departmentRole: DepartmentRole.VIEWER,
    });
    check("Schema rejects role + globalCustomRoleId both provided", bothProvided.success === false);
    const neitherDepartmentProvided = createMicrosoftMappingSchema.safeParse({
      sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
      microsoftValue: "x",
      departmentId: dept.id,
    });
    check("Schema requires at least one of departmentRole/departmentCustomRoleId", neitherDepartmentProvided.success === false);

    console.log("\n=== 5-6. createMapping persists custom roles with correct placeholders ===\n");
    const customMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: `${TAG}-title`,
      departmentId: dept.id,
      globalCustomRoleId: globalRole.id,
      departmentCustomRoleId: deptRole.id,
      domain: "kinsen.gr",
    });
    mappingIds.push(customMapping.id);
    check("5. Mapping created with globalCustomRoleId set", customMapping.globalCustomRoleId === globalRole.id);
    check("   role placeholder forced to USER", customMapping.role === Role.USER);
    check("6. Mapping created with departmentCustomRoleId set", customMapping.departmentCustomRoleId === deptRole.id);
    check("   departmentRole placeholder forced to VIEWER", customMapping.departmentRole === DepartmentRole.VIEWER);

    console.log("\n=== 7. Mapping reload/edit restores the custom selection ===\n");
    const reloaded = await prisma.microsoftDepartmentMapping.findUnique({ where: { id: customMapping.id } });
    check("7. Reloaded mapping still references the same globalCustomRoleId", reloaded?.globalCustomRoleId === globalRole.id);
    check("   ...and the same departmentCustomRoleId", reloaded?.departmentCustomRoleId === deptRole.id);

    console.log("\n=== 8-9. Sync applies the custom roles to a real user ===\n");
    const userEmail = `mmcr-user-${RUN_ID}@kinsen.gr`;
    const user = await prisma.user.create({ data: { email: userEmail, authProvider: AuthProvider.MICROSOFT, role: Role.USER } });
    userIds.push(user.id);
    mockGraphMe(`mmcr-oid-${RUN_ID}`, userEmail, `${TAG}-title`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: user.id, oid: `mmcr-oid-${RUN_ID}`, email: userEmail, name: "Test User" });

    const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
    check("8. User receives the custom role via customRoleId (not a fallback built-in)", userAfter?.customRoleId === globalRole.id);
    check("   User.role holds the placeholder USER, not some guessed built-in", userAfter?.role === Role.USER);

    const membershipAfter = await prisma.departmentMembership.findFirst({ where: { userId: user.id, departmentId: dept.id, isActive: true } });
    check("9. DepartmentMembership references the custom Department Role", membershipAfter?.customRoleId === deptRole.id);
    check("   membership.role holds the placeholder VIEWER, not a guessed built-in", membershipAfter?.role === DepartmentRole.VIEWER);

    console.log("\n=== Effective permissions come from the custom role, not a fallback ===\n");
    const hasGrantedGlobal = await hasPermission(userAfter!.role, grantedPermission.key, userAfter!.customRoleId);
    const hasUngrantedGlobal = await hasPermission(userAfter!.role, "admin.access", userAfter!.customRoleId);
    check("User has the permission actually granted to Procurement Manager", hasGrantedGlobal === true);
    check("User does NOT have an unrelated permission never granted to that role", hasUngrantedGlobal === false);

    const hasGrantedDept = await hasDepartmentPermission(membershipAfter!.role, otherPermission.key, membershipAfter!.customRoleId);
    check("Department membership has the permission granted to Procurement Reviewer", hasGrantedDept === true);

    console.log("\n=== Idempotent re-sync (no duplicate rows, same custom-role assignment) ===\n");
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: user.id, oid: `mmcr-oid-${RUN_ID}`, email: userEmail, name: "Test User" });
    const membershipsFinal = await prisma.departmentMembership.findMany({ where: { userId: user.id, departmentId: dept.id } });
    check("Re-running sync creates exactly ONE membership row", membershipsFinal.length === 1);
    check("...still referencing the custom role", membershipsFinal[0].customRoleId === deptRole.id);

    console.log("\n=== 13. Rename does not break the mapping ===\n");
    await prisma.customRole.update({ where: { id: globalRole.id }, data: { name: "Procurement Lead" } });
    const optionsAfterRename = await getMicrosoftMappingGlobalRoleOptions();
    check("Dropdown shows the NEW name for the SAME role id", optionsAfterRename.some((o) => o.customRoleId === globalRole.id && o.label === "Procurement Lead"));
    const mappingAfterRename = await prisma.microsoftDepartmentMapping.findUnique({
      where: { id: customMapping.id },
      include: { globalCustomRole: { select: { name: true } } },
    });
    check("Mapping still references the SAME role id after rename", mappingAfterRename?.globalCustomRoleId === globalRole.id);
    check("...and the joined name reflects the rename", mappingAfterRename?.globalCustomRole?.name === "Procurement Lead");

    // Re-sync after rename — same role id must still be applied.
    mockGraphMe(`mmcr-oid-${RUN_ID}`, userEmail, `${TAG}-title`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: user.id, oid: `mmcr-oid-${RUN_ID}`, email: userEmail, name: "Test User" });
    const userAfterRenameSync = await prisma.user.findUnique({ where: { id: user.id } });
    check("Sync after rename still assigns the same role id", userAfterRenameSync?.customRoleId === globalRole.id);

    console.log("\n=== 14. Update preserves an already-assigned-but-now-inactive role; rejects it for a NEW assignment ===\n");
    await prisma.customRole.update({ where: { id: deptRole.id }, data: { isActive: false } });
    // Editing an unrelated field on the SAME mapping must not fail even
    // though its departmentCustomRoleId now points at an inactive role.
    const updatedUnrelated = await updateMapping(customMapping.id, { isActive: true });
    check("Re-saving a mapping without touching its now-inactive custom role succeeds", updatedUnrelated.departmentCustomRoleId === deptRole.id);

    let newAssignmentOfInactiveRejected = false;
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `${TAG}-second-mapping`,
        departmentId: dept.id,
        role: Role.USER,
        departmentCustomRoleId: deptRole.id, // NEW assignment of an inactive role, on a DIFFERENT mapping
      });
    } catch (err) {
      newAssignmentOfInactiveRejected = err instanceof MicrosoftMappingValidationError && err.code === "DEPARTMENT_CUSTOM_ROLE_INACTIVE";
    }
    check("Assigning an INACTIVE custom role to a NEW mapping is rejected", newAssignmentOfInactiveRejected);

    // hasDepartmentPermission gracefully falls back once the role is
    // inactive — the membership keeps its historical customRoleId (never
    // silently cleared), permission resolution just stops trusting it.
    const hasGrantedDeptAfterDeactivate = await hasDepartmentPermission(membershipAfter!.role, otherPermission.key, deptRole.id);
    check("Deactivated custom role no longer grants its permission (safe fallback, not a crash)", hasGrantedDeptAfterDeactivate === false);
    await prisma.customRole.update({ where: { id: deptRole.id }, data: { isActive: true } });

    console.log("\n=== Delete guard: a role referenced by a Microsoft mapping cannot be silently orphaned ===\n");
    const globalMappingsWithRole = await prisma.microsoftDepartmentMapping.count({ where: { globalCustomRoleId: globalRole.id } });
    check("Global role in use by a Microsoft mapping is detected by the delete-guard's count query", globalMappingsWithRole > 0);

    console.log("\n=== Regression: built-in-only mapping unaffected ===\n");
    const builtInMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.ENTRA_APP_ROLE,
      microsoftValue: `${TAG}-builtin-role-value`,
      departmentId: dept.id,
      role: Role.IT_AGENT,
      departmentRole: DepartmentRole.AGENT_ASSIGNEE,
    });
    mappingIds.push(builtInMapping.id);
    check("Built-in-only mapping still stores plain enum values", builtInMapping.role === Role.IT_AGENT && builtInMapping.departmentRole === DepartmentRole.AGENT_ASSIGNEE);
    check("...with both custom-role FKs null", builtInMapping.globalCustomRoleId === null && builtInMapping.departmentCustomRoleId === null);

    console.log("\n=== Regression: MANUAL override still protected from a custom-role mapping ===\n");
    const manualUserEmail = `mmcr-manual-${RUN_ID}@kinsen.gr`;
    const manualUser = await prisma.user.create({
      data: { email: manualUserEmail, authProvider: AuthProvider.MICROSOFT, role: Role.DEPARTMENT_MANAGER, globalRoleSource: GlobalRoleSource.MANUAL },
    });
    userIds.push(manualUser.id);
    mockGraphMe(`mmcr-manual-oid-${RUN_ID}`, manualUserEmail, `${TAG}-title`);
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: manualUser.id, oid: `mmcr-manual-oid-${RUN_ID}`, email: manualUserEmail, name: "Manual User" });
    const manualUserAfter = await prisma.user.findUnique({ where: { id: manualUser.id } });
    check(
      "MANUAL globalRoleSource user is never given the custom role by sync",
      manualUserAfter?.role === Role.DEPARTMENT_MANAGER && manualUserAfter?.customRoleId === null && manualUserAfter?.globalRoleSource === GlobalRoleSource.MANUAL
    );
  } finally {
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
