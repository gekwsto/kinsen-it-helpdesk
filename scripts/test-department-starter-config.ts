/**
 * Regression test for a real bug found during the live Organization-tab/
 * Microsoft-sync audit: createDepartment() (lib/services/department-service.ts)
 * created TicketPriority rows for a brand-new department but NEVER created
 * any TicketStatus rows, despite its own header comment promising a
 * complete starter set. Every department created purely through
 * createDepartment() — every admin-created department via
 * app/api/admin/departments/route.ts, every Microsoft-sync-created
 * department via lib/services/organization-company-department-resolver.ts,
 * every lib/services/microsoft-department-autocreate-service.ts department —
 * ended up with zero TicketStatus rows and could never actually have a
 * ticket created for it (proven live: scripts/test-integration-middleware-bypass.ts's
 * "Valid key through the live server -> 201" failed against a real
 * Microsoft-sync-created department for exactly this reason).
 *
 * Fixed at the shared root (lib/services/config-starter-data.ts's new
 * ensureStarterStatusesForDepartment(), called from createDepartment()) so
 * every caller benefits uniformly — never special-cased per caller.
 *
 * Usage: npx tsx scripts/test-department-starter-config.ts
 */
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { resolveOrganizationPlacement, createOrganizationResolutionCache } from "@/lib/services/organization-company-department-resolver";
import { STARTER_STATUSES, STARTER_PRIORITIES } from "@/lib/services/config-starter-data";
import { checkDepartmentConfigHealth } from "@/lib/services/config-health";

let passed = 0, failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

const RUN_ID = Date.now();
const departmentIds: string[] = [];
const companyIds: string[] = [];

async function main() {
  try {
    // ── Path 1: plain admin-style createDepartment (businessUnitId path) ──
    const plainDept = await createDepartment({ name: `Starter Config Test ${RUN_ID}` });
    departmentIds.push(plainDept.id);
    const plainStatuses = await prisma.ticketStatus.findMany({ where: { departmentId: plainDept.id } });
    const plainPriorities = await prisma.ticketPriority.findMany({ where: { departmentId: plainDept.id } });
    check("1. A plain admin-created department gets all STARTER_STATUSES", plainStatuses.length === STARTER_STATUSES.length);
    check("   ...including exactly one isDefault status", plainStatuses.filter((s) => s.isDefault).length === 1);
    check("   ...and still gets all STARTER_PRIORITIES too (unaffected by the fix)", plainPriorities.length === STARTER_PRIORITIES.length);
    const plainHealth = await checkDepartmentConfigHealth(prisma, plainDept.id);
    check("   config-health reports no issues for a freshly-created department", plainHealth.healthy === true);

    // ── Path 2: Microsoft-sync placement (companyId path, the one that surfaced this live) ──
    const cache = createOrganizationResolutionCache();
    const placement = await resolveOrganizationPlacement(cache, `Starter Config Co ${RUN_ID}`, `Starter Config Dept ${RUN_ID}`);
    if (placement.companyId) companyIds.push(placement.companyId);
    departmentIds.push(placement.departmentId);
    const syncStatuses = await prisma.ticketStatus.findMany({ where: { departmentId: placement.departmentId } });
    check("2. A Microsoft-sync-created (companyId-placed) department ALSO gets all STARTER_STATUSES", syncStatuses.length === STARTER_STATUSES.length);

    // ── Idempotency: calling ensureStarterStatusesForDepartment-equivalent path twice never duplicates ──
    const secondPlacement = await resolveOrganizationPlacement(cache, `Starter Config Co ${RUN_ID}`, `Starter Config Dept ${RUN_ID}`);
    check("3. Resolving the SAME company+department a second time reuses the same department (no duplicate)", secondPlacement.departmentId === placement.departmentId);
    const statusesAfterSecondResolve = await prisma.ticketStatus.count({ where: { departmentId: placement.departmentId } });
    check("   ...and still exactly STARTER_STATUSES.length statuses (no duplicate statuses either)", statusesAfterSecondResolve === STARTER_STATUSES.length);
  } finally {
    console.log("\nCleaning up test data...\n");
    if (departmentIds.length > 0) {
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    }
    if (companyIds.length > 0) await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
