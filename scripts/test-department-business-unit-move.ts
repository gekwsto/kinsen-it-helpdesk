/**
 * End-to-end verification of moving a Department to a different Business
 * Unit (PATCH /api/admin/departments/[id] with businessUnitId) — exercises
 * the real route handler directly (not a reimplementation) with a mocked
 * @/lib/auth session, same technique as scripts/test-integration-admin-authz.ts.
 * Covers: permission gating (department.update AND businessUnit.update,
 * distinct from the weaker department.manageSettings), target validation,
 * idempotent same-BU no-op, cross-company moves (policy: allowed, requires
 * both permissions), preservation of every related record's departmentId,
 * organization-tree cache invalidation, and a nonexistent-department 404.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-department-business-unit-move.ts
 */
import { mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, DepartmentRole, MembershipSource, MicrosoftMappingSourceType } from "@prisma/client";
import { normalizeCompanyName } from "@/lib/services/organization-normalization";
import { createDepartment } from "@/lib/services/department-service";

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
    printSummaryAndExit();
    return;
  }

  // Dynamically imported so mock.module("@/lib/auth", ...) above is already
  // registered before this route's own transitive imports resolve it.
  const { PATCH } = await import("@/app/api/admin/departments/[id]/route");
  const { getDepartmentTree, invalidateOrganizationTreeCache } = await import("@/lib/services/organization-tree-service");
  const { buildProjectListWhere } = await import("@/lib/services/department-scope-service");

  const companyIds: string[] = [];
  const businessUnitIds: string[] = [];
  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const customRoleIds: string[] = [];
  const membershipIds: string[] = [];
  const ticketIds: string[] = [];
  const projectIds: string[] = [];
  const subDepartmentIds: string[] = [];
  const mappingIds: string[] = [];

  const jsonReq = (body: unknown) =>
    new NextRequest("http://localhost/api/admin/departments/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  function findBusinessUnitContaining(nodes: any[], departmentId: string): { businessUnitId: string } | null {
    for (const node of nodes) {
      if (node.type === "businessUnit") {
        const found = node.children.find((c: any) => c.type === "department" && c.id === departmentId);
        if (found) return { businessUnitId: node.id };
      }
      const nested = findBusinessUnitContaining(node.children, departmentId);
      if (nested) return nested;
    }
    return null;
  }

  try {
    const companyA = await prisma.company.create({ data: { name: `BU Move Company A ${RUN_ID}`, domain: `bu-move-a-${RUN_ID}.example.com`, normalizedName: normalizeCompanyName(`BU Move Company A ${RUN_ID}`) } });
    companyIds.push(companyA.id);
    const companyB = await prisma.company.create({ data: { name: `BU Move Company B ${RUN_ID}`, domain: `bu-move-b-${RUN_ID}.example.com`, normalizedName: normalizeCompanyName(`BU Move Company B ${RUN_ID}`) } });
    companyIds.push(companyB.id);

    const buA1 = await prisma.businessUnit.create({ data: { name: `BU Move A1 ${RUN_ID}`, companyId: companyA.id } });
    const buA2 = await prisma.businessUnit.create({ data: { name: `BU Move A2 ${RUN_ID}`, companyId: companyA.id } });
    const buB1 = await prisma.businessUnit.create({ data: { name: `BU Move B1 ${RUN_ID}`, companyId: companyB.id } });
    businessUnitIds.push(buA1.id, buA2.id, buB1.id);

    const dept = await createDepartment({ name: `BU Move Dept ${RUN_ID}`, slug: `bu-move-dept-${RUN_ID}`, businessUnitId: buA1.id });
    departmentIds.push(dept.id);
    const originalDeptId = dept.id;

    // Dependents that must survive the move untouched.
    const memberUser = await prisma.user.create({ data: { email: `bu-move-member-${RUN_ID}@example.com`, role: Role.USER, departmentId: dept.id } });
    userIds.push(memberUser.id);
    const membership = await prisma.departmentMembership.create({
      data: { userId: memberUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(membership.id);

    const status = await prisma.ticketStatus.create({ data: { name: `BU Move Status ${RUN_ID}`, color: "#3b82f6", departmentId: dept.id, isDefault: true, order: 1 } });
    const priority = await prisma.ticketPriority.create({ data: { name: `BU Move Priority ${RUN_ID}`, color: "#888", level: 1, departmentId: dept.id } });
    const ticket = await prisma.ticket.create({
      data: { title: `BU Move Ticket ${RUN_ID}`, description: "fixture", departmentId: dept.id, requesterId: memberUser.id, statusId: status.id, priorityId: priority.id },
    });
    ticketIds.push(ticket.id);

    const project = await prisma.project.create({ data: { title: `BU Move Project ${RUN_ID}`, ownerId: memberUser.id, departmentId: dept.id } });
    projectIds.push(project.id);

    const subDept = await prisma.subDepartment.create({ data: { name: `BU Move SubDept ${RUN_ID}`, departmentId: dept.id } });
    subDepartmentIds.push(subDept.id);

    const mapping = await prisma.microsoftDepartmentMapping.create({
      data: { sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT, microsoftValue: `bu-move-mapping-${RUN_ID}`, departmentId: dept.id, departmentRole: DepartmentRole.AGENT_ASSIGNEE },
    });
    mappingIds.push(mapping.id);

    // Users / permissions.
    const adminUser = await prisma.user.create({ data: { email: `bu-move-admin-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(adminUser.id);
    const plainUser = await prisma.user.create({ data: { email: `bu-move-plain-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(plainUser.id);

    const fullyGrantedRole = await prisma.customRole.create({ data: { key: `bu-move-full-${RUN_ID}`, name: `BU Move Full ${RUN_ID}`, scope: RoleScope.GLOBAL } });
    customRoleIds.push(fullyGrantedRole.id);
    const partialRole = await prisma.customRole.create({ data: { key: `bu-move-partial-${RUN_ID}`, name: `BU Move Partial ${RUN_ID}`, scope: RoleScope.GLOBAL } });
    customRoleIds.push(partialRole.id);

    const [deptUpdatePerm, buUpdatePerm] = await Promise.all([
      prisma.permission.findUnique({ where: { key: "department.update" } }),
      prisma.permission.findUnique({ where: { key: "businessUnit.update" } }),
    ]);
    if (!deptUpdatePerm || !buUpdatePerm) throw new Error("department.update / businessUnit.update permission rows are missing — run the seed first.");
    await prisma.rolePermission.createMany({
      data: [
        { roleKey: fullyGrantedRole.key, permissionId: deptUpdatePerm.id },
        { roleKey: fullyGrantedRole.key, permissionId: buUpdatePerm.id },
        { roleKey: partialRole.key, permissionId: deptUpdatePerm.id }, // deliberately missing businessUnit.update
      ],
    });
    const fullyGrantedUser = await prisma.user.create({ data: { email: `bu-move-full-user-${RUN_ID}@example.com`, role: Role.USER, customRoleId: fullyGrantedRole.id } });
    userIds.push(fullyGrantedUser.id);
    // Every non-businessUnitId field on this route is ALSO gated behind the
    // existing department-scoped department.manageSettings permission
    // (unrelated to this feature, pre-existing route behavior) — so a
    // realistic "delegated admin" fixture needs a real DEPARTMENT_ADMIN
    // membership on this department IN ADDITION to the two new global
    // permissions being tested here, not a bare global-only custom role.
    const fullyGrantedMembership = await prisma.departmentMembership.create({
      data: { userId: fullyGrantedUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(fullyGrantedMembership.id);
    const partialUser = await prisma.user.create({ data: { email: `bu-move-partial-user-${RUN_ID}@example.com`, role: Role.USER, customRoleId: partialRole.id } });
    userIds.push(partialUser.id);
    // Same reasoning as fullyGrantedUser above — gets past the pre-existing
    // department.manageSettings gate, so the 403 below is unambiguously
    // caused by the missing businessUnit.update permission being tested,
    // not by an unrelated lack of department membership.
    const partialMembership = await prisma.departmentMembership.create({
      data: { userId: partialUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(partialMembership.id);

    // ── 17. Plain user cannot change the business unit ──────────────────
    console.log("\nPlain user (no permission)...\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    let res: NextResponse<any> = await PATCH(jsonReq({ businessUnitId: buA2.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Plain user -> 403", res.status === 403);
    let refetched = await prisma.department.findUnique({ where: { id: dept.id } });
    check("Department's businessUnitId unchanged after denied attempt", refetched?.businessUnitId === buA1.id);

    // ── 18. Unauthorized admin scope (has department.update but not businessUnit.update) ──
    console.log("\nPartially-granted role (department.update only, missing businessUnit.update)...\n");
    currentSession = { user: { id: partialUser.id, role: Role.USER, customRoleId: partialRole.id } };
    res = await PATCH(jsonReq({ businessUnitId: buA2.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Missing businessUnit.update -> 403", res.status === 403);
    refetched = await prisma.department.findUnique({ where: { id: dept.id } });
    check("Department's businessUnitId still unchanged", refetched?.businessUnitId === buA1.id);
    // The weaker department.manageSettings-gated fields (name) still work for this role via the department-scoped path? Not applicable here (no membership) — just confirm the BU-specific gate is what blocked it, not a blanket 403 on everything: a plain name-only edit through the SAME permission this role lacks membership for is out of scope; we only assert the businessUnitId-specific gate above.

    // ── 16. Administrator can change the business unit ───────────────────
    console.log("\nAdministrator changes the business unit (same company)...\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    res = await PATCH(jsonReq({ businessUnitId: buA2.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Administrator -> 200", res.status === 200);
    const body1 = await res.json();
    check("Response reflects the new business unit", body1.businessUnit?.id === buA2.id);
    check("Response includes the new business unit's company", body1.businessUnit?.company?.id === companyA.id);

    // ── 23. Department ID never changes ───────────────────────────────────
    check("Department ID is unchanged", body1.id === originalDeptId);

    // ── 19. Invalid business unit id rejected ─────────────────────────────
    console.log("\nInvalid target business unit...\n");
    res = await PATCH(jsonReq({ businessUnitId: `nonexistent-bu-${RUN_ID}` }), { params: Promise.resolve({ id: dept.id }) });
    check("Nonexistent businessUnitId -> 400", res.status === 400);
    const invalidBody = await res.json();
    check("Error names the businessUnitId field", invalidBody.field === "businessUnitId" || invalidBody.code === "business_unit_not_found");
    refetched = await prisma.department.findUnique({ where: { id: dept.id } });
    check("Department's businessUnitId unchanged after invalid attempt", refetched?.businessUnitId === buA2.id);

    // ── 21. Same-business-unit update is a safe no-op ─────────────────────
    console.log("\nSame business unit again (idempotent no-op)...\n");
    res = await PATCH(jsonReq({ businessUnitId: buA2.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Re-submitting the current businessUnitId -> 200 (no-op, not an error)", res.status === 200);
    refetched = await prisma.department.findUnique({ where: { id: dept.id } });
    check("Still buA2 after the no-op", refetched?.businessUnitId === buA2.id);

    // ── 22. Cross-company move (policy: allowed, requires both permissions) ──
    console.log("\nCross-company move by a fully-granted (non-ADMIN) custom role...\n");
    currentSession = { user: { id: fullyGrantedUser.id, role: Role.USER, customRoleId: fullyGrantedRole.id } };
    res = await PATCH(jsonReq({ businessUnitId: buB1.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Fully-granted role can move cross-company -> 200", res.status === 200);
    const body2 = await res.json();
    check("New business unit is under Company B", body2.businessUnit?.company?.id === companyB.id);

    // ── 24/25/26/27. Every related record's departmentId is untouched ────
    console.log("\nRelated records preserved (SubDepartments, Users, Tickets, Projects, Microsoft mappings)...\n");
    const refetchedSubDept = await prisma.subDepartment.findUnique({ where: { id: subDept.id } });
    check("SubDepartment still belongs to the same department", refetchedSubDept?.departmentId === originalDeptId);
    const refetchedMember = await prisma.user.findUnique({ where: { id: memberUser.id } });
    check("User's legacy departmentId is unchanged", refetchedMember?.departmentId === originalDeptId);
    const refetchedMembership = await prisma.departmentMembership.findUnique({ where: { id: membership.id } });
    check("DepartmentMembership still references the same department", refetchedMembership?.departmentId === originalDeptId);
    const refetchedTicket = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    check("Ticket's departmentId is unchanged", refetchedTicket?.departmentId === originalDeptId);
    const refetchedProject = await prisma.project.findUnique({ where: { id: project.id } });
    check("Project's departmentId is unchanged", refetchedProject?.departmentId === originalDeptId);
    const refetchedMapping = await prisma.microsoftDepartmentMapping.findUnique({ where: { id: mapping.id } });
    check("MicrosoftDepartmentMapping still references the same department", refetchedMapping?.departmentId === originalDeptId);
    check("No duplicate department was created (still exactly one row for this id)", (await prisma.department.count({ where: { id: originalDeptId } })) === 1);

    // ── 29. Department scope/permissions recompute correctly (unaffected by BU) ──
    console.log("\nDepartment-level access is unaffected by the business unit change...\n");
    const projectScope = await buildProjectListWhere(memberUser.id, Role.USER, dept.id);
    check("The department member can still be scoped into this department's projects after the BU move", !("denied" in projectScope));

    // ── 28/30. Organization tree shows the department only under the new BU; cache invalidation prevents staleness ──
    console.log("\nOrganization tree reflects the new ancestry without a stale cache...\n");
    invalidateOrganizationTreeCache();
    const treeBefore = await getDepartmentTree({ activeOnly: false }); // populates the cache
    const locationBefore = findBusinessUnitContaining(treeBefore, dept.id);
    check("Tree (freshly built) shows the department under buB1 before any further move", locationBefore?.businessUnitId === buB1.id);

    // Move back to buA1 WITHOUT calling invalidateOrganizationTreeCache
    // manually here — the route itself must invalidate it; if it didn't,
    // the next getDepartmentTree() call would incorrectly keep serving the
    // cached buB1 grouping from treeBefore above.
    res = await PATCH(jsonReq({ businessUnitId: buA1.id }), { params: Promise.resolve({ id: dept.id }) });
    check("Move back to buA1 -> 200", res.status === 200);

    const treeAfter = await getDepartmentTree({ activeOnly: false });
    const locationAfter = findBusinessUnitContaining(treeAfter, dept.id);
    check("Tree immediately reflects buA1 (route invalidated the cache itself, not a stale 5-minute-old snapshot)", locationAfter?.businessUnitId === buA1.id);
    const stillUnderOldBu = findBusinessUnitContaining(treeAfter, dept.id)?.businessUnitId === buB1.id;
    check("The department no longer appears under the old business unit (buB1)", !stillUnderOldBu);

    // ── Nonexistent department -> 404 ─────────────────────────────────────
    console.log("\nNonexistent department...\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    res = await PATCH(jsonReq({ businessUnitId: buA1.id }), { params: Promise.resolve({ id: `nonexistent-dept-${RUN_ID}` }) });
    check("PATCH on a nonexistent department -> 404", res.status === 404);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.subDepartment.deleteMany({ where: { id: { in: subDepartmentIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: [`bu-move-full-${RUN_ID}`, `bu-move-partial-${RUN_ID}`] } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.businessUnit.deleteMany({ where: { id: { in: businessUnitIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    const { invalidateOrganizationTreeCache: cleanupInvalidate } = await import("@/lib/services/organization-tree-service");
    cleanupInvalidate();
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
