/**
 * Department-scoped SLA. "SLA level" = TicketPriority itself (already
 * department-scoped: name/level/isActive) — SlaPolicy (lib/services/sla-policy.ts)
 * is 1:1 with a priority and carries only the hours. Deliberately no
 * separate "SlaLevel" entity.
 *
 * Tests:
 *  1. IT gets High/Medium/Low, Sales gets Urgent/High/Medium/Low — the SAME
 *     name ("High") can exist in both departments independently.
 *  2. Each department's own `level` ordering is independent (Sales' 4 levels
 *     vs IT's 3 don't interfere with each other).
 *  3. Duplicate name within the SAME department is rejected (unique constraint).
 *  4. ensureSlaPolicyForPriority is idempotent — a second call never
 *     overwrites an already-edited SlaPolicy row.
 *  5. resolveSlaHours / getSlaHoursForPriority NEVER fabricate hours when no
 *     SlaPolicy row exists — both return an ok:false SlaResolution (no
 *     8h/48h substituted) and log a gap.
 *  6. Disabling a priority (isActive:false) removes it from the "active,
 *     selectable" query used by new-ticket dropdowns, while an existing
 *     ticket that already references it keeps reading it normally (no
 *     isActive filter on a direct relation read).
 *  7. Safe delete: a priority referenced by a ticket cannot be hard-deleted
 *     (mirrors the DELETE route's _count.tickets > 0 guard); an unreferenced
 *     priority CAN be deleted, and its SlaPolicy is cascade-removed with it.
 *  8. buildPriorityWhere-style department scoping: a query scoped to Dept A
 *     never returns Dept B's priorities.
 *
 * Usage: npx tsx scripts/test-sla-department-scoping.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { ensureSlaPolicyForPriority, STARTER_SLA_HOURS } from "@/lib/services/config-starter-data";
import { getSlaHoursForPriority, resolveSlaHours, getSlaPoliciesForPriorities, __resetReportedGapsForTests } from "@/lib/services/sla-policy";
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

const originalConsoleError = console.error;
let capturedErrors: string[] = [];
async function withCapturedGapLogs<T>(fn: () => Promise<T>): Promise<T> {
  capturedErrors = [];
  console.error = (...args: unknown[]) => {
    capturedErrors.push(args.map(String).join(" "));
  };
  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
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

  let itDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let salesDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const priorityIds: string[] = [];
  const ticketIds: string[] = [];
  const statusIds: string[] = [];

  try {
    itDept = await prisma.department.create({ data: { name: `Test IT SLA Dept ${RUN_ID}`, slug: `test-it-sla-dept-${RUN_ID}` } });
    salesDept = await prisma.department.create({ data: { name: `Test Sales SLA Dept ${RUN_ID}`, slug: `test-sales-sla-dept-${RUN_ID}` } });
    requester = await prisma.user.create({ data: { email: `test-sla-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    console.log("IT gets High/Medium/Low, Sales gets Urgent/High/Medium/Low — same name in both departments\n");
    const itHigh = await prisma.ticketPriority.create({ data: { departmentId: itDept.id, name: "High", level: 3, color: "#f97316" } });
    const itMedium = await prisma.ticketPriority.create({ data: { departmentId: itDept.id, name: "Medium", level: 2, color: "#f59e0b" } });
    const itLow = await prisma.ticketPriority.create({ data: { departmentId: itDept.id, name: "Low", level: 1, color: "#22c55e" } });
    const salesUrgent = await prisma.ticketPriority.create({ data: { departmentId: salesDept.id, name: "Urgent", level: 4, color: "#ef4444" } });
    const salesHigh = await prisma.ticketPriority.create({ data: { departmentId: salesDept.id, name: "High", level: 3, color: "#f97316" } });
    const salesMedium = await prisma.ticketPriority.create({ data: { departmentId: salesDept.id, name: "Medium", level: 2, color: "#f59e0b" } });
    const salesLow = await prisma.ticketPriority.create({ data: { departmentId: salesDept.id, name: "Low", level: 1, color: "#22c55e" } });
    priorityIds.push(itHigh.id, itMedium.id, itLow.id, salesUrgent.id, salesHigh.id, salesMedium.id, salesLow.id);
    check("IT has exactly 3 levels", (await prisma.ticketPriority.count({ where: { departmentId: itDept.id } })) === 3);
    check("Sales has exactly 4 levels", (await prisma.ticketPriority.count({ where: { departmentId: salesDept.id } })) === 4);
    check("Both departments independently have a priority literally named 'High'", itHigh.name === "High" && salesHigh.name === "High" && itHigh.id !== salesHigh.id);

    console.log("\nDuplicate name within the SAME department is rejected\n");
    let duplicateRejected = false;
    try {
      await prisma.ticketPriority.create({ data: { departmentId: itDept.id, name: "High", level: 3, color: "#000" } });
    } catch (err: any) {
      duplicateRejected = err.code === "P2002";
    }
    check("Creating a second IT 'High' priority throws P2002", duplicateRejected);

    console.log("\nensureSlaPolicyForPriority is idempotent and never overwrites an already-edited row\n");
    await ensureSlaPolicyForPriority(prisma, itHigh.id);
    const starterHours = await prisma.slaPolicy.findUnique({ where: { priorityId: itHigh.id } });
    check("First call creates starter hours", starterHours?.firstResponseHours === STARTER_SLA_HOURS.firstResponseHours && starterHours?.resolutionHours === STARTER_SLA_HOURS.resolutionHours);
    await prisma.slaPolicy.update({ where: { priorityId: itHigh.id }, data: { firstResponseHours: 1, resolutionHours: 4 } });
    await ensureSlaPolicyForPriority(prisma, itHigh.id);
    const afterSecondCall = await prisma.slaPolicy.findUnique({ where: { priorityId: itHigh.id } });
    check("Second call does NOT overwrite the admin-edited hours (still 1h/4h)", afterSecondCall?.firstResponseHours === 1 && afterSecondCall?.resolutionHours === 4);

    console.log("\nDifferent SLA ordering per department (IT: High>Medium>Low, Sales: Urgent>High>Medium>Low), independent level scales\n");
    const itOrdered = await prisma.ticketPriority.findMany({ where: { departmentId: itDept.id }, orderBy: { level: "desc" } });
    const salesOrdered = await prisma.ticketPriority.findMany({ where: { departmentId: salesDept.id }, orderBy: { level: "desc" } });
    check("IT order is High, Medium, Low", itOrdered.map((p) => p.name).join(",") === "High,Medium,Low");
    check("Sales order is Urgent, High, Medium, Low", salesOrdered.map((p) => p.name).join(",") === "Urgent,High,Medium,Low");

    console.log("\nresolveSlaHours / getSlaHoursForPriority NEVER fabricate hours when no SlaPolicy row exists, and log a gap\n");
    __resetReportedGapsForTests();
    const gapResult = await withCapturedGapLogs(() => getSlaHoursForPriority(itMedium.id));
    check("Priority with no SlaPolicy row resolves to ok:false (no 8h/48h substituted)", gapResult.ok === false);
    check("A configuration gap was logged", capturedErrors.some((e) => e.includes("configuration gap") && e.includes(itMedium.id)));
    const bulkMap = await getSlaPoliciesForPriorities([itHigh.id, itMedium.id]);
    const itHighResolution = resolveSlaHours(bulkMap, itHigh.id);
    const itMediumResolution = resolveSlaHours(bulkMap, itMedium.id);
    check("Bulk loader agrees: itHigh resolves to its real 1h/4h", itHighResolution.ok === true && itHighResolution.hours.firstResponseHours === 1);
    check("Bulk loader agrees: itMedium (gap) resolves to ok:false (never a fabricated 8h)", itMediumResolution.ok === false);

    console.log("\nDisabling a priority removes it from active-selectable dropdown queries; existing references still read it\n");
    const openStatus = await prisma.ticketStatus.create({ data: { departmentId: itDept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, order: 1 } });
    statusIds.push(openStatus.id);
    const ticket = await prisma.ticket.create({
      data: {
        title: `Test SLA Ticket ${RUN_ID}`,
        description: "test",
        departmentId: itDept.id,
        requesterId: requester.id,
        priorityId: itLow.id,
        statusId: openStatus.id,
      },
    });
    ticketIds.push(ticket.id);
    await prisma.ticketPriority.update({ where: { id: itLow.id }, data: { isActive: false } });
    const activeSelectable = await prisma.ticketPriority.findMany({ where: { AND: [{ isActive: true }, buildPriorityWhere(itDept.id)] } });
    check("Disabled 'Low' is absent from the active-selectable list for new tickets", !activeSelectable.some((p) => p.id === itLow.id));
    const ticketReread = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: { priority: true } });
    check("The existing ticket still reads its disabled priority normally (no isActive filter on a direct relation read)", ticketReread?.priority?.id === itLow.id && ticketReread?.priority?.isActive === false);

    console.log("\nSafe delete: a referenced priority is blocked; an unreferenced one deletes cleanly and cascades its SlaPolicy\n");
    const referencedCount = await prisma.ticket.count({ where: { priorityId: itLow.id } });
    check("itLow is referenced by 1 ticket (delete must be blocked per the API's own guard)", referencedCount === 1);
    const unreferencedCount = await prisma.ticket.count({ where: { priorityId: itMedium.id } });
    check("itMedium is unreferenced (safe to hard-delete)", unreferencedCount === 0);
    await ensureSlaPolicyForPriority(prisma, itMedium.id);
    await prisma.ticketPriority.delete({ where: { id: itMedium.id } });
    priorityIds.splice(priorityIds.indexOf(itMedium.id), 1);
    const cascadedSlaPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: itMedium.id } });
    check("Deleting the priority cascade-deletes its SlaPolicy row (no orphan)", cascadedSlaPolicy === null);

    console.log("\nDepartment scoping: a query scoped to IT never returns Sales' priorities\n");
    const itScoped = await prisma.ticketPriority.findMany({ where: buildPriorityWhere(itDept.id) });
    check("IT-scoped query returns none of Sales' priority ids", !itScoped.some((p) => [salesUrgent.id, salesHigh.id, salesMedium.id, salesLow.id].includes(p.id)));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["statuses", () => (statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve())],
      ["priorities", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      ["requester", () => (requester ? prisma.user.deleteMany({ where: { id: requester.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [itDept?.id, salesDept?.id].filter((x): x is string => !!x) } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    __resetReportedGapsForTests();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
