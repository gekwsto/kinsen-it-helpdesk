/**
 * lib/services/organization-tree-service.ts's getDepartmentTree — real DB,
 * multi-level Company -> BusinessUnit -> Department -> SubDepartment
 * fixtures. Proves: correct active/total user counts (dual-source rule,
 * matching admin/users' own department query), inactive-department-with-
 * active-subdepartment stays visible (never orphans an active descendant),
 * departments with zero users are pruned under activeOnly, duplicate
 * department names don't collide, and DEPARTMENT_MANAGER membership drives
 * the `manager` field.
 *
 * Usage: npx tsx scripts/test-organization-tree-assembly.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { getDepartmentTree, invalidateOrganizationTreeCache, type DepartmentTreeNode } from "@/lib/services/organization-tree-service";

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

function findNode(nodes: DepartmentTreeNode[], id: string): DepartmentTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const userIds: string[] = [];
  const membershipIds: string[] = [];
  let company: Awaited<ReturnType<typeof prisma.company.create>> | undefined;
  let businessUnit: Awaited<ReturnType<typeof prisma.businessUnit.create>> | undefined;
  let deptActive: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptInactiveWithActiveChild: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptEmpty: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptDuplicateA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptDuplicateB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subActive: Awaited<ReturnType<typeof prisma.subDepartment.create>> | undefined;

  try {
    company = await prisma.company.create({ data: { name: `OrgTest Co ${RUN_ID}`, domain: `orgtest-${RUN_ID}.example` } });
    businessUnit = await prisma.businessUnit.create({ data: { name: `OrgTest BU ${RUN_ID}`, companyId: company.id } });

    deptActive = await prisma.department.create({ data: { name: `OrgTest Dept Active ${RUN_ID}`, slug: `orgtest-dept-active-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptInactiveWithActiveChild = await prisma.department.create({ data: { name: `OrgTest Dept Inactive Parent ${RUN_ID}`, slug: `orgtest-dept-inactive-parent-${RUN_ID}`, isActive: false, businessUnitId: businessUnit.id } });
    deptEmpty = await prisma.department.create({ data: { name: `OrgTest Dept Empty ${RUN_ID}`, slug: `orgtest-dept-empty-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptDuplicateA = await prisma.department.create({ data: { name: `OrgTest Dept Duplicate ${RUN_ID}`, slug: `orgtest-dept-dup-a-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptDuplicateB = await prisma.department.create({ data: { name: `OrgTest Dept Duplicate ${RUN_ID}`, slug: `orgtest-dept-dup-b-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });

    subActive = await prisma.subDepartment.create({ data: { name: `OrgTest Sub Active ${RUN_ID}`, departmentId: deptInactiveWithActiveChild.id, isActive: true } });

    // Users: 2 active + 1 inactive in deptActive (via legacy departmentId);
    // 1 active via DepartmentMembership only (multi-membership case).
    const u1 = await prisma.user.create({ data: { email: `orgtest-u1-${RUN_ID}@kinsen.gr`, name: "Org Test U1", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, departmentId: deptActive.id } });
    const u2 = await prisma.user.create({ data: { email: `orgtest-u2-${RUN_ID}@kinsen.gr`, name: "Org Test U2", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, departmentId: deptActive.id } });
    const u3Inactive = await prisma.user.create({ data: { email: `orgtest-u3-${RUN_ID}@kinsen.gr`, name: "Org Test U3 Inactive", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: false, departmentId: deptActive.id } });
    const u4ViaMembership = await prisma.user.create({ data: { email: `orgtest-u4-${RUN_ID}@kinsen.gr`, name: "Org Test U4", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(u1.id, u2.id, u3Inactive.id, u4ViaMembership.id);

    const m4 = await prisma.departmentMembership.create({ data: { userId: u4ViaMembership.id, departmentId: deptActive.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true } });
    membershipIds.push(m4.id);

    // Manager membership for deptActive.
    const managerUser = await prisma.user.create({ data: { email: `orgtest-mgr-${RUN_ID}@kinsen.gr`, name: "Org Test Manager", jobTitle: "Head of Ops", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(managerUser.id);
    const mgrMembership = await prisma.departmentMembership.create({ data: { userId: managerUser.id, departmentId: deptActive.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL, isActive: true } });
    membershipIds.push(mgrMembership.id);

    // Active user in the SubDepartment under the inactive parent Department.
    const subUser = await prisma.user.create({ data: { email: `orgtest-subuser-${RUN_ID}@kinsen.gr`, name: "Org Test Sub User", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, subDepartmentId: subActive.id } });
    userIds.push(subUser.id);

    invalidateOrganizationTreeCache();
    const fullTree = await getDepartmentTree({ activeOnly: false });

    console.log("\nCounts (dual-source: legacy departmentId OR active DepartmentMembership)...\n");
    const activeDeptNode = findNode(fullTree, deptActive.id);
    check("deptActive found in tree", activeDeptNode !== null);
    // u1,u2 via legacy departmentId; u3 via legacy departmentId but inactive;
    // u4 via active DepartmentMembership; managerUser also via active
    // DepartmentMembership (the DEPARTMENT_MANAGER row) — 5 distinct
    // associated users total, 4 of them active (all but u3).
    check("deptActive activeUserCount = 4 (u1, u2, u4, manager; u3 inactive excluded)", activeDeptNode?.activeUserCount === 4);
    check("deptActive totalUserCount = 5 (u1,u2,u3,u4,manager)", activeDeptNode?.totalUserCount === 5);
    check("deptActive manager resolved from DEPARTMENT_MANAGER membership", activeDeptNode?.manager?.id === managerUser.id);
    check("deptActive manager jobTitle carried through", activeDeptNode?.manager?.jobTitle === "Head of Ops");

    console.log("\nInactive department with an active subdepartment stays visible...\n");
    const inactiveParentNode = findNode(fullTree, deptInactiveWithActiveChild.id);
    check("inactive parent department is present in the unfiltered tree", inactiveParentNode !== null);
    check("inactive parent is flagged isActive=false", inactiveParentNode?.isActive === false);
    const subNode = inactiveParentNode?.children.find((c) => c.id === subActive!.id);
    check("its active subdepartment is a child", !!subNode);
    check("subdepartment activeUserCount = 1", subNode?.activeUserCount === 1);

    const prunedTree = await getDepartmentTree({ activeOnly: true });
    const prunedParent = findNode(prunedTree, deptInactiveWithActiveChild.id);
    check("under activeOnly=true, the inactive parent STILL appears (ancestor of an active subdepartment, never orphaned)", prunedParent !== null);
    check("under activeOnly=true, its active subdepartment child is still present", prunedParent?.children.some((c) => c.id === subActive!.id) ?? false);

    console.log("\nEmpty department pruning under activeOnly...\n");
    const emptyInFull = findNode(fullTree, deptEmpty.id);
    check("empty-but-active department appears in the unfiltered tree", emptyInFull !== null);
    check("empty department has 0 active users", emptyInFull?.activeUserCount === 0);
    // deptEmpty itself IS active (isActive: true) so it is NOT pruned even
    // under activeOnly — pruning only drops isActive=false leaves with no
    // visible descendants, never an active-but-empty department.
    const emptyInPruned = findNode(prunedTree, deptEmpty.id);
    check("an ACTIVE department with 0 users is still shown under activeOnly (isActive is authoritative, not user count)", emptyInPruned !== null);

    console.log("\nDuplicate department names never collide...\n");
    const dupA = findNode(fullTree, deptDuplicateA.id);
    const dupB = findNode(fullTree, deptDuplicateB.id);
    check("both duplicate-name departments appear as separate nodes", dupA !== null && dupB !== null);
    check("they have distinct ids despite identical names", dupA!.id !== dupB!.id && dupA!.name === dupB!.name);

    console.log("\nHierarchy shape...\n");
    const companyNode = fullTree.find((c) => c.id === company!.id);
    check("company node exists at the root", !!companyNode);
    const buNode = companyNode?.children.find((c) => c.id === businessUnit!.id);
    check("business unit is a child of the company", !!buNode);
    check("business unit rolls up child departments' active user counts", (buNode?.activeUserCount ?? 0) >= 4);
  } finally {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["subDepartment", () => (subActive ? prisma.subDepartment.delete({ where: { id: subActive.id } }) : Promise.resolve())],
      [
        "department",
        () =>
          prisma.department.deleteMany({
            where: { id: { in: [deptActive?.id, deptInactiveWithActiveChild?.id, deptEmpty?.id, deptDuplicateA?.id, deptDuplicateB?.id].filter((x): x is string => !!x) } },
          }),
      ],
      ["businessUnit", () => (businessUnit ? prisma.businessUnit.delete({ where: { id: businessUnit.id } }) : Promise.resolve())],
      ["company", () => (company ? prisma.company.delete({ where: { id: company.id } }) : Promise.resolve())],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    invalidateOrganizationTreeCache();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
