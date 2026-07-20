/**
 * "SubDepartment is a filter, not a scope boundary" (architecture decision):
 * buildTicketListWhere/buildProjectListWhere/buildActivityListWhere are NOT
 * modified to accept subDepartmentId — every list route instead ANDs an
 * optional { subDepartmentId } condition onto the already department-scoped
 * `where`, exactly like the existing ?categoryId=/?statusId= filters. This
 * script verifies that narrowing at the Prisma-query level, matching how
 * app/(main)/tickets/page.tsx, projects/page.tsx and activities/page.tsx
 * build their `andConditions`/`where`.
 *
 * Tests, per entity (Ticket, Project, ProjectActivity):
 *  1. Applying ?subDepartmentId=X returns only rows tagged with X.
 *  2. Omitting the filter returns all rows regardless of subDepartmentId
 *     (including null ones) — access is still governed by department scope,
 *     never narrowed by subDepartment unless explicitly asked for.
 *
 * Usage: npx tsx scripts/test-subdepartment-filtering.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260721100000_add_subdepartments_and_custom_department_roles migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityPriority, ActivityStatus, ProjectStatus, Role } from "@prisma/client";
import { createSubDepartment } from "@/lib/services/sub-department-service";

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
    await prisma.ticket.findFirst({ select: { id: true, subDepartmentId: true, shareWithDepartment: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nTicket.subDepartmentId/shareWithDepartment aren't usable against this database yet (migrations " +
        "20260721100000_add_subdepartments_and_custom_department_roles and/or " +
        "20260722090000_add_ticket_sharing_and_department_change_audit not applied) — skipping."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!migrationApplied) {
    printSummaryAndExit();
    return;
  }

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subDept: Awaited<ReturnType<typeof createSubDepartment>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test SubDept Filtering Dept ${RUN_ID}`, slug: `test-subdept-filtering-dept-${RUN_ID}` } });
    subDept = await createSubDepartment({ departmentId: dept.id, name: `Filtering Team ${RUN_ID}` });
    requester = await prisma.user.create({ data: { email: `test-subdept-filtering-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!defaultStatus) throw new Error("No default TicketStatus seeded — cannot create a test ticket.");

    console.log("\nSeeding Tickets (one tagged, one untagged)...\n");
    const taggedTicket = await prisma.ticket.create({
      data: { title: `Tagged Ticket ${RUN_ID}`, description: "x", statusId: defaultStatus.id, departmentId: dept.id, subDepartmentId: subDept.id, requesterId: requester.id },
    });
    ticketIds.push(taggedTicket.id);
    const untaggedTicket = await prisma.ticket.create({
      data: { title: `Untagged Ticket ${RUN_ID}`, description: "x", statusId: defaultStatus.id, departmentId: dept.id, requesterId: requester.id },
    });
    ticketIds.push(untaggedTicket.id);

    const scopedTicketsBase = { departmentId: dept.id };
    const filteredTickets = await prisma.ticket.findMany({ where: { AND: [scopedTicketsBase, { subDepartmentId: subDept.id }] } });
    const unfilteredTickets = await prisma.ticket.findMany({ where: { AND: [scopedTicketsBase] } });
    check("Ticket filter: only the tagged ticket is returned", filteredTickets.length === 1 && filteredTickets[0].id === taggedTicket.id);
    check("Ticket no-filter: both tickets are returned", unfilteredTickets.length === 2);

    console.log("\nSeeding Projects (one tagged, one untagged)...\n");
    const taggedProject = await prisma.project.create({
      data: { title: `Tagged Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dept.id, subDepartmentId: subDept.id, ownerId: requester.id },
    });
    projectIds.push(taggedProject.id);
    const untaggedProject = await prisma.project.create({
      data: { title: `Untagged Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dept.id, ownerId: requester.id },
    });
    projectIds.push(untaggedProject.id);

    const scopedProjectsBase = { departmentId: dept.id };
    const filteredProjects = await prisma.project.findMany({ where: { AND: [scopedProjectsBase, { subDepartmentId: subDept.id }] } });
    const unfilteredProjects = await prisma.project.findMany({ where: { AND: [scopedProjectsBase] } });
    check("Project filter: only the tagged project is returned", filteredProjects.length === 1 && filteredProjects[0].id === taggedProject.id);
    check("Project no-filter: both projects are returned", unfilteredProjects.length === 2);

    console.log("\nSeeding standalone Activities (one tagged, one untagged)...\n");
    const taggedActivity = await prisma.projectActivity.create({
      data: { title: `Tagged Activity ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: dept.id, subDepartmentId: subDept.id },
    });
    activityIds.push(taggedActivity.id);
    const untaggedActivity = await prisma.projectActivity.create({
      data: { title: `Untagged Activity ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: dept.id },
    });
    activityIds.push(untaggedActivity.id);

    const scopedActivitiesBase = [{ departmentId: dept.id }];
    const filteredActivities = await prisma.projectActivity.findMany({ where: { AND: [...scopedActivitiesBase, { subDepartmentId: subDept.id }] } });
    const unfilteredActivities = await prisma.projectActivity.findMany({ where: { AND: scopedActivitiesBase } });
    check("Activity filter: only the tagged activity is returned", filteredActivities.length === 1 && filteredActivities[0].id === taggedActivity.id);
    check("Activity no-filter: both activities are returned", unfilteredActivities.length === 2);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["subDepartment", () => (subDept ? prisma.subDepartment.deleteMany({ where: { id: subDept.id } }) : Promise.resolve())],
      ["user", () => (requester ? prisma.user.deleteMany({ where: { id: requester.id } }) : Promise.resolve())],
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

  printSummaryAndExit();
}

main();
