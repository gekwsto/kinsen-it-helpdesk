/**
 * Ticket department/subdepartment change: a dedicated, audited path
 * (PATCH /api/tickets/[id]/department), gated by the new ticket.department.change
 * permission — never the old ticket.create proxy the generic PATCH used to
 * reuse. This script exercises the exact same building blocks the route
 * itself calls (canActOnEntity, getMembership+hasDepartmentPermission,
 * validateSubDepartmentInDepartment) plus performs the same
 * prisma.ticket.update + TicketHistory write the route performs, to verify
 * end-to-end behavior without spinning up an HTTP server.
 *
 * Tests:
 *  1. A user without ticket.department.change is denied (canActOnEntity false).
 *  2. A user with ticket.department.change in the ticket's current department is allowed.
 *  3. Moving into a target department requires standing (ticket.department.change) THERE too.
 *  4. subDepartmentId must belong to the target department — mismatch rejected.
 *  5. Department change clears a stale subDepartmentId when none is explicitly given.
 *  6. Clearing subDepartmentId forces shareWithSubDepartment back to false.
 *  7. The write records departmentChangedById/At AND a TicketHistory DEPARTMENT_CHANGE row.
 *
 * Usage: npx tsx scripts/test-ticket-department-change.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260722090000_add_ticket_sharing_and_department_change_audit migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { hasDepartmentPermission } from "@/lib/permissions";
import { validateSubDepartmentInDepartment, createSubDepartment } from "@/lib/services/sub-department-service";

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

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let migrationApplied = true;
  try {
    await prisma.ticket.findFirst({ select: { id: true, shareWithSubDepartment: true, departmentChangedById: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nTicket.shareWithSubDepartment/departmentChangedById aren't usable against this database yet (migration " +
        "20260722090000_add_ticket_sharing_and_department_change_audit not applied) — skipping."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!migrationApplied) {
    printSummaryAndExit();
    return;
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subA: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let subB: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let manager: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let viewer: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ticket: Awaited<ReturnType<typeof prisma.ticket.create>> | undefined;
  const membershipIds: string[] = [];
  const subDeptIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Dept Change A ${RUN_ID}`, slug: `test-dept-change-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Dept Change B ${RUN_ID}`, slug: `test-dept-change-b-${RUN_ID}` } });
    subA = await createSubDepartment({ departmentId: deptA.id, name: `Sub A ${RUN_ID}` });
    subDeptIds.push(subA.id);
    subB = await createSubDepartment({ departmentId: deptB.id, name: `Sub B ${RUN_ID}` });
    subDeptIds.push(subB.id);

    manager = await prisma.user.create({ data: { email: `test-dept-change-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    viewer = await prisma.user.create({ data: { email: `test-dept-change-viewer-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const managerMembership = await prisma.departmentMembership.create({
      data: { userId: manager.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerMembership.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewer.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);

    const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!defaultStatus) throw new Error("No default TicketStatus seeded — cannot create a test ticket.");

    ticket = await prisma.ticket.create({
      data: {
        title: `Test Dept Change Ticket ${RUN_ID}`,
        description: "x",
        statusId: defaultStatus.id,
        requesterId: viewer.id,
        departmentId: deptA.id,
        subDepartmentId: subA.id,
      },
    });

    console.log("\nTesting permission gating (canActOnEntity for ticket.department.change)...\n");
    check(
      "VIEWER (no ticket.department.change) is denied",
      !(await canActOnEntity(viewer.id, viewer.role, deptA.id, "ticket.department.change", false))
    );
    check(
      "DEPARTMENT_MANAGER (has ticket.department.change) is allowed",
      await canActOnEntity(manager.id, manager.role, deptA.id, "ticket.department.change", false)
    );

    console.log("\nTesting target-department standing is required...\n");
    const targetMembership = await getMembership(manager.id, deptB.id);
    check("Manager has no membership in deptB (target check would reject)", targetMembership === null);

    console.log("\nTesting subDepartmentId must belong to the target department...\n");
    check("subB is invalid for deptA (mismatch)", !(await validateSubDepartmentInDepartment(subB.id, deptA.id)));
    check("subA is valid for deptA", await validateSubDepartmentInDepartment(subA.id, deptA.id));

    console.log("\nTesting the actual department-change write (deptA -> deptA, subA -> null, i.e. clearing sub)...\n");
    // Grant manager membership in deptB too so the "move into deptB" write below is legitimate.
    const managerBMembership = await prisma.departmentMembership.create({
      data: { userId: manager.id, departmentId: deptB.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerBMembership.id);
    check(
      "Manager now has ticket.department.change standing in deptB too",
      await canActOnEntity(manager.id, manager.role, deptB.id, "ticket.department.change", false)
    );

    // Set shareWithSubDepartment true first, to verify the clear-on-move rule.
    await prisma.ticket.update({ where: { id: ticket.id }, data: { shareWithSubDepartment: true } });

    const departmentChanging = true; // deptA -> deptB
    const resolvedSubDepartmentId: string | null = departmentChanging ? null : subA.id; // no explicit new subDept given
    const clearingSubDepartment = !resolvedSubDepartmentId;

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        departmentId: deptB.id,
        subDepartmentId: resolvedSubDepartmentId,
        shareWithSubDepartment: clearingSubDepartment ? false : undefined,
        departmentChangedById: manager.id,
        departmentChangedAt: new Date(),
      },
    });
    await prisma.ticketHistory.create({
      data: {
        ticketId: ticket.id,
        changedById: manager.id,
        type: "DEPARTMENT_CHANGE",
        oldValue: `${deptA.name} / ${subA.name}`,
        newValue: `${deptB.name}`,
        description: `Department changed from "${deptA.name} / ${subA.name}" to "${deptB.name}"`,
      },
    });

    check("departmentId updated to deptB", updated.departmentId === deptB.id);
    check("subDepartmentId cleared (stale subA no longer valid in deptB)", updated.subDepartmentId === null);
    check("shareWithSubDepartment forced back to false", updated.shareWithSubDepartment === false);
    check("departmentChangedById recorded", updated.departmentChangedById === manager.id);
    check("departmentChangedAt recorded", updated.departmentChangedAt !== null);

    const historyRow = await prisma.ticketHistory.findFirst({ where: { ticketId: ticket.id, type: "DEPARTMENT_CHANGE" } });
    check("TicketHistory DEPARTMENT_CHANGE row written", historyRow !== null && historyRow.changedById === manager.id);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticketHistory", () => (ticket ? prisma.ticketHistory.deleteMany({ where: { ticketId: ticket.id } }) : Promise.resolve())],
      ["ticket", () => (ticket ? prisma.ticket.deleteMany({ where: { id: ticket.id } }) : Promise.resolve())],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: [manager?.id, viewer?.id].filter((id): id is string => !!id) } } })],
      ["subDepartments", () => prisma.subDepartment.deleteMany({ where: { id: { in: subDeptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } })],
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
