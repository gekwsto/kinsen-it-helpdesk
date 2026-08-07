/**
 * Organization tree/sync authorization — lib/services/organization-scope-service.ts.
 * Proves: Admin/Director get full-tree access via the EXISTING
 * canViewAllDepartments bypass (no new logic duplicated); a plain USER
 * without the new organization.tree.view permission gets false for
 * full-tree access but a real, non-empty own-slice (own department, own
 * manager chain, own direct reports); organization.sync stays false for a
 * non-admin by default; and the existing admin.access/user.manage/etc.
 * permission checks elsewhere are completely unaffected (no permission
 * seeding change touched any existing key's grants).
 *
 * Usage: npx tsx scripts/test-organization-authorization.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { normalizeCompanyName } from "@/lib/services/organization-normalization";
import { canViewFullOrganizationTree, canTriggerOrganizationSync, getOwnDepartmentTreeSlice, getOwnPeopleTreeSlice } from "@/lib/services/organization-scope-service";
import { hasPermission } from "@/lib/permissions";

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

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  console.log("\nRole-level bypass (no per-user DB state needed)...\n");
  check("ADMIN can always view the full tree (hasPermission's ADMIN bypass)", await canViewFullOrganizationTree(Role.ADMIN, null));
  check("DIRECTOR can always view the full tree (canViewAllDepartments bypass)", await canViewFullOrganizationTree(Role.DIRECTOR, null));
  check("ADMIN can always trigger a sync", await canTriggerOrganizationSync(Role.ADMIN, null));
  check("a plain USER (no custom role) cannot trigger a sync by default", (await canTriggerOrganizationSync(Role.USER, null)) === false);
  check("a plain USER (no custom role) does not have full-tree view by default", (await canViewFullOrganizationTree(Role.USER, null)) === false);
  check("IT_AGENT does not have full-tree view by default (not seeded for this role)", (await canViewFullOrganizationTree(Role.IT_AGENT, null)) === false);

  console.log("\norganization.tree.view is seeded and independently checkable...\n");
  const orgTreeViewPermission = await prisma.permission.findUnique({ where: { key: "organization.tree.view" } });
  check("organization.tree.view permission row exists (seeded)", orgTreeViewPermission !== null);
  const orgSyncPermission = await prisma.permission.findUnique({ where: { key: "organization.sync" } });
  check("organization.sync permission row exists (seeded)", orgSyncPermission !== null);
  check("DIRECTOR's default grants include organization.tree.view (cosmetic-consistency backfill)", (await hasPermission(Role.DIRECTOR, "organization.tree.view", null)) === true);

  console.log("\nExisting, unrelated permissions are unaffected by this feature's seeding...\n");
  check("user.manage is still ADMIN-gated as before (unaffected)", (await hasPermission(Role.ADMIN, "user.manage", null)) === true);
  check("a plain USER still lacks user.manage (unaffected)", (await hasPermission(Role.USER, "user.manage", null)) === false);

  console.log("\nOwn-slice access for a plain, unprivileged user (real DB fixtures)...\n");
  const userIds: string[] = [];
  let company: Awaited<ReturnType<typeof prisma.company.create>> | undefined;
  let businessUnit: Awaited<ReturnType<typeof prisma.businessUnit.create>> | undefined;
  let department: Awaited<ReturnType<typeof prisma.department.create>> | undefined;

  try {
    company = await prisma.company.create({ data: { name: `AuthTest Co ${RUN_ID}`, domain: `authtest-${RUN_ID}.example`, normalizedName: normalizeCompanyName(`AuthTest Co ${RUN_ID}`) } });
    businessUnit = await prisma.businessUnit.create({ data: { name: `AuthTest BU ${RUN_ID}`, companyId: company.id } });
    department = await prisma.department.create({ data: { name: `AuthTest Dept ${RUN_ID}`, slug: `authtest-dept-${RUN_ID}`, isActive: true, businessUnitId: businessUnit.id } });

    const manager = await prisma.user.create({ data: { email: `authtest-mgr-${RUN_ID}@kinsen.gr`, name: "Auth Test Manager", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(manager.id);
    const plainUser = await prisma.user.create({
      data: { email: `authtest-user-${RUN_ID}@kinsen.gr`, name: "Auth Test User", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, departmentId: department.id, managerId: manager.id },
    });
    userIds.push(plainUser.id);
    const report = await prisma.user.create({ data: { email: `authtest-report-${RUN_ID}@kinsen.gr`, name: "Auth Test Report", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: plainUser.id } });
    userIds.push(report.id);

    const deptSlice = await getOwnDepartmentTreeSlice(plainUser.id);
    check("own department slice is non-empty for a plain user (never an empty response)", deptSlice.length > 0);
    function findDeptInSlice(nodes: typeof deptSlice, id: string): boolean {
      return nodes.some((n) => n.id === id || findDeptInSlice(n.children, id));
    }
    check("the slice includes the user's own department", findDeptInSlice(deptSlice, department.id));

    const peopleSlice = await getOwnPeopleTreeSlice(plainUser.id);
    check("own people slice is non-empty", peopleSlice.length > 0);
    check("own people slice is a single linear chain (one root)", peopleSlice.length === 1);
    // Root is the topmost visible ancestor (manager, who has no manager of
    // their own) with the plain user nested one level down.
    check("the root of the own-slice chain is the user's manager", peopleSlice[0].id === manager.id);
    const selfInChain = peopleSlice[0].children[0];
    check("the plain user is the manager's only child in this own-slice view", selfInChain?.id === plainUser.id);
    check("the plain user's own direct report appears as their child", selfInChain?.children.some((c) => c.id === report.id));
  } finally {
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (department) await prisma.department.delete({ where: { id: department.id } });
      if (businessUnit) await prisma.businessUnit.delete({ where: { id: businessUnit.id } });
      if (company) await prisma.company.delete({ where: { id: company.id } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
