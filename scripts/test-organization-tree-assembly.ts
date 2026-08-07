/**
 * lib/services/organization-tree-service.ts's getDepartmentTree — real DB,
 * multi-level Company -> BusinessUnit -> Department -> SubDepartment
 * fixtures. Proves: correct active/total user counts (PRIMARY-ONLY rule —
 * User.departmentId, the canonical primary-membership mirror; a user who
 * only has a SECONDARY active DepartmentMembership in a department is
 * deliberately NOT counted here, since the Organization tree is an
 * organizational-placement chart, not an access/membership view — see
 * organization-tree-service.ts's own header comment), inactive-department-
 * with-active-subdepartment stays visible (never orphans an active
 * descendant), departments with zero users are pruned under activeOnly,
 * duplicate department names don't collide, and DEPARTMENT_MANAGER
 * membership (primary or secondary — a manager designation is a role fact,
 * independent of primary/secondary) drives the `manager` field.
 *
 * Usage: npx tsx scripts/test-organization-tree-assembly.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { normalizeCompanyName } from "@/lib/services/organization-normalization";
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
    company = await prisma.company.create({ data: { name: `OrgTest Co ${RUN_ID}`, domain: `orgtest-${RUN_ID}.example`, normalizedName: normalizeCompanyName(`OrgTest Co ${RUN_ID}`) } });
    businessUnit = await prisma.businessUnit.create({ data: { name: `OrgTest BU ${RUN_ID}`, companyId: company.id } });

    deptActive = await prisma.department.create({ data: { name: `OrgTest Dept Active ${RUN_ID}`, slug: `orgtest-dept-active-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptInactiveWithActiveChild = await prisma.department.create({ data: { name: `OrgTest Dept Inactive Parent ${RUN_ID}`, slug: `orgtest-dept-inactive-parent-${RUN_ID}`, isActive: false, businessUnitId: businessUnit.id } });
    deptEmpty = await prisma.department.create({ data: { name: `OrgTest Dept Empty ${RUN_ID}`, slug: `orgtest-dept-empty-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptDuplicateA = await prisma.department.create({ data: { name: `OrgTest Dept Duplicate ${RUN_ID}`, slug: `orgtest-dept-dup-a-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });
    deptDuplicateB = await prisma.department.create({ data: { name: `OrgTest Dept Duplicate ${RUN_ID}`, slug: `orgtest-dept-dup-b-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });

    subActive = await prisma.subDepartment.create({ data: { name: `OrgTest Sub Active ${RUN_ID}`, departmentId: deptInactiveWithActiveChild.id, isActive: true } });

    // Users: 2 active + 1 inactive in deptActive via User.departmentId (the
    // canonical primary mirror); 1 more active user with ONLY a SECONDARY
    // active DepartmentMembership in deptActive (no User.departmentId) —
    // deliberately NOT counted in the tree (organizational placement, not
    // access/membership — see this file's header comment).
    const u1 = await prisma.user.create({ data: { email: `orgtest-u1-${RUN_ID}@kinsen.gr`, name: "Org Test U1", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, departmentId: deptActive.id } });
    const u2 = await prisma.user.create({ data: { email: `orgtest-u2-${RUN_ID}@kinsen.gr`, name: "Org Test U2", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, departmentId: deptActive.id } });
    const u3Inactive = await prisma.user.create({ data: { email: `orgtest-u3-${RUN_ID}@kinsen.gr`, name: "Org Test U3 Inactive", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: false, departmentId: deptActive.id } });
    const u4ViaMembership = await prisma.user.create({ data: { email: `orgtest-u4-${RUN_ID}@kinsen.gr`, name: "Org Test U4", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(u1.id, u2.id, u3Inactive.id, u4ViaMembership.id);

    const m4 = await prisma.departmentMembership.create({ data: { userId: u4ViaMembership.id, departmentId: deptActive.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true, isPrimary: false } });
    membershipIds.push(m4.id);

    // Manager: also placed via a SECONDARY membership only (no
    // User.departmentId) — the `manager` field must still resolve (a
    // DEPARTMENT_MANAGER designation is a role fact, independent of
    // primary/secondary), even though this person doesn't count toward
    // deptActive's own primary-only user counts.
    const managerUser = await prisma.user.create({ data: { email: `orgtest-mgr-${RUN_ID}@kinsen.gr`, name: "Org Test Manager", jobTitle: "Head of Ops", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(managerUser.id);
    const mgrMembership = await prisma.departmentMembership.create({ data: { userId: managerUser.id, departmentId: deptActive.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL, isActive: true, isPrimary: false } });
    membershipIds.push(mgrMembership.id);

    // Active user in the SubDepartment under the inactive parent Department.
    const subUser = await prisma.user.create({ data: { email: `orgtest-subuser-${RUN_ID}@kinsen.gr`, name: "Org Test Sub User", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, subDepartmentId: subActive.id } });
    userIds.push(subUser.id);

    invalidateOrganizationTreeCache();
    const fullTree = await getDepartmentTree({ activeOnly: false });

    console.log("\nCounts (PRIMARY-ONLY: User.departmentId, never secondary-only membership)...\n");
    const activeDeptNode = findNode(fullTree, deptActive.id);
    check("deptActive found in tree", activeDeptNode !== null);
    // u1,u2 via User.departmentId (primary); u3 via User.departmentId but
    // inactive. u4 and managerUser have ONLY a secondary active
    // DepartmentMembership (no User.departmentId) — deliberately excluded
    // from these counts.
    check("deptActive activeUserCount = 2 (u1, u2 only — primary-placed and active)", activeDeptNode?.activeUserCount === 2);
    check("deptActive totalUserCount = 3 (u1, u2, u3 — primary-placed, regardless of active/inactive)", activeDeptNode?.totalUserCount === 3);
    check("deptActive manager STILL resolved from a SECONDARY DEPARTMENT_MANAGER membership (role fact, independent of primary/secondary)", activeDeptNode?.manager?.id === managerUser.id);
    check("deptActive manager jobTitle carried through", activeDeptNode?.manager?.jobTitle === "Head of Ops");
    check("u4 (secondary-only membership, no primary placement) does NOT inflate the organizational headcount", activeDeptNode?.totalUserCount === 3);

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
    check("business unit rolls up child departments' active user counts", (buNode?.activeUserCount ?? 0) >= 2);
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
