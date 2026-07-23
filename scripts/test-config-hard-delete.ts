/**
 * Verifies the hard-delete-when-unused behavior added to Categories,
 * Priorities, and Statuses (mirroring the pattern Cancel Reasons already
 * had), plus the SLA policy create/edit/delete round trip.
 *
 * Every Category/Priority/Status is now strictly department-owned (no more
 * global/shared row — see the 20260727_retire_global_config migration), so
 * all throwaway rows here are created under a real, isolated, throwaway
 * Department rather than left department-less.
 *
 * Same style/limits as scripts/test-department-scoped-config.ts: this
 * codebase has no HTTP-mocking harness for route handlers (requireAdmin/
 * requireAuth call next-auth's auth(), which needs a real request context),
 * so this script exercises the underlying data-layer invariants the routes
 * rely on directly via Prisma, plus the exported service/permission
 * functions the routes call — not the route handlers themselves.
 *
 * - "Hard delete succeeds when unused" is verified by calling
 *   prisma.<entity>.delete() directly on a throwaway, unreferenced row —
 *   exactly what app/api/admin/{categories,priorities,statuses}/route.ts's
 *   DELETE now does once its own ticket-count check passes.
 * - "Blocked when in use" works differently per entity, because the FK
 *   referential actions differ (see the init migration):
 *     - Ticket.statusId is required, so its FK is ON DELETE RESTRICT — the
 *       DB itself refuses the delete (Postgres "restrict_violation", code
 *       23001) as a second layer under the route's own check. Verified here
 *       by asserting the delete throws.
 *     - Ticket.categoryId/priorityId are optional, so their FKs are ON
 *       DELETE SET NULL — the DB will NOT stop a delete; it would silently
 *       null out the ticket's categoryId/priorityId instead. The route's
 *       own `_count.tickets > 0` check is therefore the ONLY thing
 *       preventing historical tickets from losing their category/priority
 *       label. Verified here by asserting that signal is correctly non-zero
 *       for an in-use row — deliberately NOT calling delete() on it, since
 *       unlike status that call would actually succeed and orphan the
 *       ticket's label.
 * - The priority+SlaPolicy cascade and isLastActiveDefaultStatusInDepartment
 *   are verified directly since they're plain Prisma/exported-service behavior.
 *
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * not available.
 *
 * Usage: npx tsx scripts/test-config-hard-delete.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, Role } from "@prisma/client";
import { isLastActiveDefaultStatusInDepartment } from "@/lib/services/department-scope-service";
import { hasDepartmentPermission } from "@/lib/permissions";

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

async function expectDeleteBlocked(label: string, action: () => Promise<unknown>) {
  try {
    await action();
    check(label, false);
  } catch {
    check(label, true);
  }
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const categoryIds: string[] = [];
  const priorityIds: string[] = [];
  const statusIds: string[] = [];
  const ticketIds: string[] = [];
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let testDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;

  try {
    testDept = await prisma.department.create({ data: { name: `Test Config Delete Dept ${RUN_ID}`, slug: `test-config-delete-dept-${RUN_ID}` } });
    const deptId = testDept.id;

    requester = await prisma.user.create({
      data: { email: `test-config-delete-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });

    console.log("Categories: hard delete when unused, blocked when in use\n");
    const categoryUnused = await prisma.ticketCategory.create({ data: { name: `Test Category Unused ${RUN_ID}`, departmentId: deptId } });
    categoryIds.push(categoryUnused.id);
    await prisma.ticketCategory.delete({ where: { id: categoryUnused.id } });
    check(
      "Unused category hard-deletes (row is gone)",
      (await prisma.ticketCategory.findUnique({ where: { id: categoryUnused.id } })) === null
    );

    const categoryInUse = await prisma.ticketCategory.create({ data: { name: `Test Category In Use ${RUN_ID}`, departmentId: deptId } });
    categoryIds.push(categoryInUse.id);
    // A status is needed for the throwaway ticket below (Ticket.statusId is
    // required) — created here, department-owned, not itself under test.
    const anyStatus = await prisma.ticketStatus.create({ data: { name: `Test Any Status ${RUN_ID}`, color: "#000000", order: 0, departmentId: deptId } });
    statusIds.push(anyStatus.id);
    const categoryTicket = await prisma.ticket.create({
      data: {
        title: `Test ticket ${RUN_ID}`,
        description: "test",
        requesterId: requester.id,
        statusId: anyStatus.id,
        categoryId: categoryInUse.id,
      },
    });
    ticketIds.push(categoryTicket.id);
    // categoryId is ON DELETE SET NULL (optional relation) — the DB will not
    // stop this delete on its own, so the route's _count.tickets > 0 check
    // is the only safety net. Assert that signal, don't call delete() here.
    const categoryInUseCount = await prisma.ticketCategory.findUnique({
      where: { id: categoryInUse.id },
      include: { _count: { select: { tickets: true } } },
    });
    check(
      "Category referenced by a ticket has a non-zero ticket count (the exact item_in_use signal the route checks before deleting)",
      (categoryInUseCount?._count.tickets ?? 0) > 0
    );

    console.log("\nPriorities: hard delete when unused, blocked when in use, no orphan SlaPolicy\n");
    const priorityUnused = await prisma.ticketPriority.create({ data: { name: `Test Priority Unused ${RUN_ID}`, level: 1, color: "#111111", departmentId: deptId } });
    priorityIds.push(priorityUnused.id);
    await prisma.ticketPriority.delete({ where: { id: priorityUnused.id } });
    check(
      "Unused priority hard-deletes (row is gone)",
      (await prisma.ticketPriority.findUnique({ where: { id: priorityUnused.id } })) === null
    );

    const priorityInUse = await prisma.ticketPriority.create({ data: { name: `Test Priority In Use ${RUN_ID}`, level: 2, color: "#222222", departmentId: deptId } });
    priorityIds.push(priorityInUse.id);
    const priorityTicket = await prisma.ticket.create({
      data: {
        title: `Test ticket priority ${RUN_ID}`,
        description: "test",
        requesterId: requester.id,
        statusId: anyStatus.id,
        priorityId: priorityInUse.id,
      },
    });
    ticketIds.push(priorityTicket.id);
    // Same as categoryId: priorityId is ON DELETE SET NULL, so the route's
    // own ticket-count check is the only thing preventing deletion here.
    const priorityInUseCount = await prisma.ticketPriority.findUnique({
      where: { id: priorityInUse.id },
      include: { _count: { select: { tickets: true } } },
    });
    check(
      "Priority referenced by a ticket has a non-zero ticket count (the exact item_in_use signal the route checks before deleting)",
      (priorityInUseCount?._count.tickets ?? 0) > 0
    );

    const priorityWithSla = await prisma.ticketPriority.create({ data: { name: `Test Priority SLA ${RUN_ID}`, level: 3, color: "#333333", departmentId: deptId } });
    priorityIds.push(priorityWithSla.id);
    await prisma.slaPolicy.create({ data: { priorityId: priorityWithSla.id, firstResponseHours: 1, resolutionHours: 2 } });
    await prisma.ticketPriority.delete({ where: { id: priorityWithSla.id } });
    check(
      "Deleting an unused priority cascades away its SlaPolicy (no orphan row)",
      (await prisma.slaPolicy.findUnique({ where: { priorityId: priorityWithSla.id } })) === null
    );

    console.log("\nStatuses: hard delete when unused, blocked when in use, last-active-default guard is per-department\n");
    const statusDefault = await prisma.ticketStatus.create({ data: { name: `Test Status Default ${RUN_ID}`, color: "#333333", order: 1, isDefault: true, isActive: true, departmentId: deptId } });
    statusIds.push(statusDefault.id);
    const statusUnused = await prisma.ticketStatus.create({ data: { name: `Test Status Unused ${RUN_ID}`, color: "#444444", order: 999, departmentId: deptId } });
    statusIds.push(statusUnused.id);
    check(
      "isLastActiveDefaultStatusInDepartment(non-default status) is false — the department's real default status still exists",
      !(await isLastActiveDefaultStatusInDepartment(statusUnused.id, deptId))
    );
    check(
      "isLastActiveDefaultStatusInDepartment(the actual default status) is true — it's the only one in this throwaway department",
      await isLastActiveDefaultStatusInDepartment(statusDefault.id, deptId)
    );
    await prisma.ticketStatus.delete({ where: { id: statusUnused.id } });
    check(
      "Unused (non-default) status hard-deletes (row is gone)",
      (await prisma.ticketStatus.findUnique({ where: { id: statusUnused.id } })) === null
    );

    const statusInUse = await prisma.ticketStatus.create({ data: { name: `Test Status In Use ${RUN_ID}`, color: "#555555", order: 998, departmentId: deptId } });
    statusIds.push(statusInUse.id);
    const statusTicket = await prisma.ticket.create({
      data: {
        title: `Test ticket status ${RUN_ID}`,
        description: "test",
        requesterId: requester.id,
        statusId: statusInUse.id,
      },
    });
    ticketIds.push(statusTicket.id);
    // statusId is required (not optional), so its FK is ON DELETE RESTRICT —
    // unlike category/priority, the DB itself refuses this delete as a
    // second layer under the route's own _count.tickets check.
    await expectDeleteBlocked(
      "Status referenced by a ticket cannot be hard-deleted (DB-level RESTRICT, backs item_in_use)",
      () => prisma.ticketStatus.delete({ where: { id: statusInUse.id } })
    );

    console.log("\nDisable stays independent of delete (isActive:false works without touching the row's existence)\n");
    const categoryToDisable = await prisma.ticketCategory.create({ data: { name: `Test Category Disable ${RUN_ID}`, departmentId: deptId } });
    categoryIds.push(categoryToDisable.id);
    await prisma.ticketCategory.update({ where: { id: categoryToDisable.id }, data: { isActive: false } });
    const disabledCategory = await prisma.ticketCategory.findUnique({ where: { id: categoryToDisable.id } });
    check("Disabling a category sets isActive:false but keeps the row", disabledCategory?.isActive === false);
    await prisma.ticketCategory.update({ where: { id: categoryToDisable.id }, data: { isActive: true } });
    check(
      "Re-enabling a disabled category flips isActive back to true",
      (await prisma.ticketCategory.findUnique({ where: { id: categoryToDisable.id } }))?.isActive === true
    );

    console.log("\nPermissions: priority.delete / status.delete enforced same as category.delete\n");
    check("DEPARTMENT_ADMIN has priority.delete", await hasDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, "priority.delete"));
    check("DEPARTMENT_ADMIN has status.delete", await hasDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, "status.delete"));
    check("VIEWER does NOT have priority.delete", !(await hasDepartmentPermission(DepartmentRole.VIEWER, "priority.delete")));
    check("VIEWER does NOT have status.delete", !(await hasDepartmentPermission(DepartmentRole.VIEWER, "status.delete")));
    check("AGENT_ASSIGNEE does NOT have priority.delete", !(await hasDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, "priority.delete")));
    check("AGENT_ASSIGNEE does NOT have status.delete", !(await hasDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, "status.delete")));

    console.log("\nSLA: create/edit/delete round trip, no duplicate policy per priority\n");
    const slaPriority = await prisma.ticketPriority.create({ data: { name: `Test Priority SLA CRUD ${RUN_ID}`, level: 4, color: "#666666", departmentId: deptId } });
    priorityIds.push(slaPriority.id);
    check("A priority with no SlaPolicy yet has none (falls back to 8h/48h default in the API)", (await prisma.slaPolicy.findUnique({ where: { priorityId: slaPriority.id } })) === null);

    await prisma.slaPolicy.upsert({
      where: { priorityId: slaPriority.id },
      update: { firstResponseHours: 4, resolutionHours: 24 },
      create: { priorityId: slaPriority.id, firstResponseHours: 4, resolutionHours: 24 },
    });
    check(
      "Create (upsert with no existing row) creates exactly one SlaPolicy",
      (await prisma.slaPolicy.count({ where: { priorityId: slaPriority.id } })) === 1
    );

    await prisma.slaPolicy.upsert({
      where: { priorityId: slaPriority.id },
      update: { firstResponseHours: 2, resolutionHours: 12 },
      create: { priorityId: slaPriority.id, firstResponseHours: 2, resolutionHours: 12 },
    });
    const editedPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: slaPriority.id } });
    check(
      "Edit (upsert with an existing row) updates in place, still exactly one row",
      editedPolicy?.firstResponseHours === 2 && editedPolicy?.resolutionHours === 12 &&
        (await prisma.slaPolicy.count({ where: { priorityId: slaPriority.id } })) === 1
    );

    await prisma.slaPolicy.delete({ where: { priorityId: slaPriority.id } });
    check(
      "Delete removes the SlaPolicy row but leaves the TicketPriority itself untouched",
      (await prisma.slaPolicy.findUnique({ where: { priorityId: slaPriority.id } })) === null &&
        (await prisma.ticketPriority.findUnique({ where: { id: slaPriority.id } })) !== null
    );
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["slaPolicy", () =>
        priorityIds.length > 0 ? prisma.slaPolicy.deleteMany({ where: { priorityId: { in: priorityIds } } }) : Promise.resolve()],
      ["ticketPriority", () => (priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve())],
      ["ticketCategory", () => (categoryIds.length > 0 ? prisma.ticketCategory.deleteMany({ where: { id: { in: categoryIds } } }) : Promise.resolve())],
      ["ticketStatus", () => (statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve())],
      ["user", () => (requester ? prisma.user.delete({ where: { id: requester.id } }) : Promise.resolve())],
      ["department", () => (testDept ? prisma.department.delete({ where: { id: testDept.id } }) : Promise.resolve())],
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
