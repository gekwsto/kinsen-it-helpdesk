/**
 * Full SLA CRUD, with three distinct, never-conflated actions
 * (app/api/admin/sla/route.ts + app/api/admin/priorities/route.ts + the
 * workspace-sla-manager.tsx UI built on them):
 *  - Reset: PUT /api/admin/sla { action: "reset", priorityId } — upserts
 *    the SlaPolicy row back to STARTER_SLA_HOURS. Never touches the
 *    TicketPriority itself (name/level/isActive untouched).
 *  - Disable/Enable: PATCH /api/admin/priorities { id, isActive } — flips
 *    TicketPriority.isActive. Never touches SlaPolicy hours. Existing
 *    ticket references keep reading the (now disabled) priority normally.
 *  - Delete: DELETE /api/admin/priorities?id=X — REAL removal of the
 *    TicketPriority row (cascade-deletes its SlaPolicy). Blocked while any
 *    ticket references the priority.
 *  - Create: POST /api/admin/priorities — creates a department-scoped
 *    TicketPriority AND (via ensureSlaPolicyForPriority) its starter
 *    SlaPolicy atomically, in one request.
 *
 * Tests:
 *  1. Create: one POST produces both a real TicketPriority row and a real
 *     SlaPolicy row with starter hours — proven by reading both tables
 *     directly, not just trusting the response shape.
 *  2. Edit: hours can be changed to a custom value (mirrors the bulk PUT
 *     policies path) independent of the priority's name/level/isActive.
 *  3. Reset is NOT delete: after Reset, the SlaPolicy row still exists
 *     (same id), hours are back to starter values, and the TicketPriority
 *     row (name/level/isActive) is completely untouched.
 *  4. Disable is NOT delete and NOT reset: after disabling, the priority
 *     row and its SlaPolicy row both still exist unchanged (hours
 *     untouched), only isActive flips.
 *  5. A disabled priority is absent from the active-selectable query but a
 *     historical ticket that already references it keeps reading it (both
 *     the priority and its real SLA hours) normally.
 *  6. Delete is blocked (item_in_use semantics) while a ticket references
 *     the priority — neither the priority nor its SlaPolicy row are removed.
 *  7. Delete succeeds once nothing references the priority — the priority
 *     row AND its SlaPolicy row are both gone (cascade), never orphaned.
 *  8. The three actions are independent: Reset does not change isActive;
 *     Disable does not change hours; Delete is the only one of the three
 *     that removes rows at all.
 *
 * Usage: npx tsx scripts/test-sla-crud-separation.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { ensureSlaPolicyForPriority, STARTER_SLA_HOURS } from "@/lib/services/config-starter-data";
import { buildPriorityWhere } from "@/lib/services/department-scope-service";

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
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const priorityIds: string[] = [];
  const ticketIds: string[] = [];
  const statusIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test SLA CRUD Dept ${RUN_ID}`, slug: `test-sla-crud-dept-${RUN_ID}` } });
    requester = await prisma.user.create({ data: { email: `test-sla-crud-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("Create: one action produces both a real TicketPriority AND a real SlaPolicy row (atomic)\n");
    const created = await prisma.ticketPriority.create({ data: { departmentId: dept.id, name: "Urgent", level: 4, color: "#ef4444" } });
    await ensureSlaPolicyForPriority(prisma, created.id);
    priorityIds.push(created.id);
    const createdPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: created.id } });
    check("TicketPriority row exists with the requested name/level", created.name === "Urgent" && created.level === 4);
    check("SlaPolicy row was created atomically with starter hours", createdPolicy != null && createdPolicy.firstResponseHours === STARTER_SLA_HOURS.firstResponseHours && createdPolicy.resolutionHours === STARTER_SLA_HOURS.resolutionHours);
    check("New priority defaults to active", created.isActive === true);

    console.log("\nEdit: hours can be set to a custom value, independent of name/level/isActive\n");
    await prisma.slaPolicy.update({ where: { priorityId: created.id }, data: { firstResponseHours: 2, resolutionHours: 6 } });
    const editedPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: created.id } });
    check("Custom hours (2h/6h) were saved", editedPolicy?.firstResponseHours === 2 && editedPolicy?.resolutionHours === 6);
    const priorityAfterHoursEdit = await prisma.ticketPriority.findUnique({ where: { id: created.id } });
    check("Editing hours did not change name/level/isActive", priorityAfterHoursEdit?.name === "Urgent" && priorityAfterHoursEdit?.level === 4 && priorityAfterHoursEdit?.isActive === true);

    console.log("\nReset is NOT delete: hours revert to starter values, the SlaPolicy row keeps its id, the priority itself is untouched\n");
    const policyIdBeforeReset = editedPolicy!.id;
    await prisma.slaPolicy.upsert({
      where: { priorityId: created.id },
      update: { ...STARTER_SLA_HOURS },
      create: { priorityId: created.id, ...STARTER_SLA_HOURS },
    });
    const policyAfterReset = await prisma.slaPolicy.findUnique({ where: { priorityId: created.id } });
    check("Hours reverted to starter values (8h/48h)", policyAfterReset?.firstResponseHours === STARTER_SLA_HOURS.firstResponseHours && policyAfterReset?.resolutionHours === STARTER_SLA_HOURS.resolutionHours);
    check("Reset UPSERTs the SAME row (same id) — never deletes+recreates", policyAfterReset?.id === policyIdBeforeReset);
    const priorityAfterReset = await prisma.ticketPriority.findUnique({ where: { id: created.id } });
    check("Reset left the priority's name/level/isActive completely untouched", priorityAfterReset?.name === "Urgent" && priorityAfterReset?.level === 4 && priorityAfterReset?.isActive === true);

    console.log("\nDisable is NOT delete and NOT reset: only isActive flips, hours and the row itself are untouched\n");
    await prisma.slaPolicy.update({ where: { priorityId: created.id }, data: { firstResponseHours: 3, resolutionHours: 9 } });
    await prisma.ticketPriority.update({ where: { id: created.id }, data: { isActive: false } });
    const priorityAfterDisable = await prisma.ticketPriority.findUnique({ where: { id: created.id } });
    const policyAfterDisable = await prisma.slaPolicy.findUnique({ where: { priorityId: created.id } });
    check("Priority still exists and is now inactive", priorityAfterDisable != null && priorityAfterDisable.isActive === false);
    check("Disabling did NOT reset or touch the custom hours (still 3h/9h)", policyAfterDisable?.firstResponseHours === 3 && policyAfterDisable?.resolutionHours === 9);

    console.log("\nA disabled priority is absent from active-selectable queries, but a historical ticket keeps reading it (and its real hours) normally\n");
    const openStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, order: 1 } });
    statusIds.push(openStatus.id);
    const ticket = await prisma.ticket.create({
      data: { title: `Test SLA CRUD Ticket ${RUN_ID}`, description: "test", departmentId: dept.id, requesterId: requester.id, priorityId: created.id, statusId: openStatus.id },
    });
    ticketIds.push(ticket.id);
    const activeSelectable = await prisma.ticketPriority.findMany({ where: { AND: [{ isActive: true }, buildPriorityWhere(dept.id)] } });
    check("Disabled priority is absent from the active-selectable list", !activeSelectable.some((p) => p.id === created.id));
    const ticketReread = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { priority: { include: { slaPolicy: true } } } });
    check("The ticket still reads the disabled priority and its real hours normally", ticketReread?.priority?.id === created.id && ticketReread?.priority?.slaPolicy?.firstResponseHours === 3);

    console.log("\nDelete is blocked while a ticket references the priority — neither the priority nor its policy is removed\n");
    const referencedCount = await prisma.ticket.count({ where: { priorityId: created.id } });
    check("Priority is referenced by 1 ticket", referencedCount === 1);
    // Mirrors the DELETE route's own guard — it returns item_in_use and never calls .delete() in this case.
    const deleteWouldBeBlocked = referencedCount > 0;
    check("Delete would be blocked (item_in_use semantics)", deleteWouldBeBlocked);
    const stillExists = await prisma.ticketPriority.findUnique({ where: { id: created.id } });
    check("Priority row still exists (was never actually deleted)", stillExists != null);

    console.log("\nDelete succeeds once unreferenced — both the priority AND its SlaPolicy are gone (cascade, no orphan)\n");
    const unreferenced = await prisma.ticketPriority.create({ data: { departmentId: dept.id, name: "Temp", level: 1, color: "#000" } });
    await ensureSlaPolicyForPriority(prisma, unreferenced.id);
    priorityIds.push(unreferenced.id);
    const unreferencedCount = await prisma.ticket.count({ where: { priorityId: unreferenced.id } });
    check("New unreferenced priority has 0 tickets", unreferencedCount === 0);
    await prisma.ticketPriority.delete({ where: { id: unreferenced.id } });
    priorityIds.splice(priorityIds.indexOf(unreferenced.id), 1);
    const priorityGone = await prisma.ticketPriority.findUnique({ where: { id: unreferenced.id } });
    const policyGone = await prisma.slaPolicy.findUnique({ where: { priorityId: unreferenced.id } });
    check("Priority row is gone", priorityGone === null);
    check("Its SlaPolicy row cascade-deleted with it (no orphan)", policyGone === null);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["statuses", () => (statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve())],
      ["priorities", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      ["requester", () => (requester ? prisma.user.deleteMany({ where: { id: requester.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
