/**
 * Verifies (doesn't just assume) that a DepartmentRole.DEPARTMENT_MANAGER
 * membership already gets full department-wide visibility — every ticket,
 * project and activity in their department, not just ones they own/are
 * assigned to — and nothing from a department they don't belong to. Also
 * checks resolveDepartmentForCreate rejects a Department Manager submitting
 * a foreign department id (relevant to the new Create Project form, which
 * now lets a user pick a department explicitly — the backend must still
 * reject one they don't manage).
 *
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * one isn't configured/reachable.
 *
 * Usage: npx tsx scripts/test-department-manager-scope.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import {
  buildTicketListWhere,
  buildProjectListWhere,
  buildActivityListWhere,
  resolveDepartmentForCreate,
} from "@/lib/services/department-scope-service";

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
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let otherUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const membershipIds: string[] = [];
  const ticketIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  let statusId: string | undefined;

  try {
    deptA = await prisma.department.create({ data: { name: `Test Manager Dept A ${RUN_ID}`, slug: `test-manager-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Manager Dept B ${RUN_ID}`, slug: `test-manager-dept-b-${RUN_ID}` } });

    managerUser = await prisma.user.create({
      data: { email: `test-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.DEPARTMENT_MANAGER },
    });
    const membership = await prisma.departmentMembership.create({
      data: {
        userId: managerUser.id,
        departmentId: deptA.id,
        role: DepartmentRole.DEPARTMENT_MANAGER,
        source: MembershipSource.MANUAL,
        isActive: true,
      },
    });
    membershipIds.push(membership.id);

    // A ticket/project/activity the manager neither created nor is
    // assigned/member of, in their own department (deptA) and in the other
    // department (deptB) — this is the actual "sees everything in their
    // department, nothing outside it" claim being tested, not just
    // "sees their own stuff."
    otherUser = await prisma.user.create({
      data: { email: `test-manager-otheruser-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: otherUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const status = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    statusId = status?.id;
    if (!statusId) throw new Error("No default TicketStatus seeded — cannot create a test ticket.");

    const ticketA = await prisma.ticket.create({
      data: { title: `Test dept A ticket ${RUN_ID}`, description: "x", requesterId: otherUser.id, departmentId: deptA.id, statusId },
    });
    ticketIds.push(ticketA.id);
    const ticketB = await prisma.ticket.create({
      data: { title: `Test dept B ticket ${RUN_ID}`, description: "x", requesterId: otherUser.id, departmentId: deptB.id, statusId },
    });
    ticketIds.push(ticketB.id);

    const projectA = await prisma.project.create({ data: { title: `Test dept A project ${RUN_ID}`, ownerId: otherUser.id, departmentId: deptA.id } });
    projectIds.push(projectA.id);
    const projectB = await prisma.project.create({ data: { title: `Test dept B project ${RUN_ID}`, ownerId: otherUser.id, departmentId: deptB.id } });
    projectIds.push(projectB.id);

    const activityA = await prisma.projectActivity.create({ data: { title: `Test dept A activity ${RUN_ID}`, departmentId: deptA.id } });
    activityIds.push(activityA.id);
    const activityB = await prisma.projectActivity.create({ data: { title: `Test dept B activity ${RUN_ID}`, departmentId: deptB.id } });
    activityIds.push(activityB.id);

    console.log("Testing Department Manager ticket scope...\n");
    const ticketScope = await buildTicketListWhere(managerUser.id, Role.DEPARTMENT_MANAGER, deptA.id);
    const visibleTicketsA = await prisma.ticket.findMany({ where: "denied" in ticketScope ? { id: { in: [] } } : ticketScope });
    check("Sees the dept A ticket (not created/assigned by them)", visibleTicketsA.some((t) => t.id === ticketA.id));
    check("Does not see the dept B ticket", !visibleTicketsA.some((t) => t.id === ticketB.id));

    const deniedTicketScope = await buildTicketListWhere(managerUser.id, Role.DEPARTMENT_MANAGER, deptB.id);
    check("Requesting dept B directly is denied (not a member there)", "denied" in deniedTicketScope);

    console.log("\nTesting Department Manager project scope...\n");
    const projectScope = await buildProjectListWhere(managerUser.id, Role.DEPARTMENT_MANAGER, deptA.id);
    const visibleProjectsA = await prisma.project.findMany({ where: "denied" in projectScope ? { id: { in: [] } } : projectScope });
    check("Sees the dept A project (not owned by them)", visibleProjectsA.some((p) => p.id === projectA.id));
    check("Does not see the dept B project", !visibleProjectsA.some((p) => p.id === projectB.id));

    console.log("\nTesting Department Manager activity scope...\n");
    const activityScope = await buildActivityListWhere(managerUser.id, Role.DEPARTMENT_MANAGER, deptA.id);
    const visibleActivitiesA = await prisma.projectActivity.findMany({ where: "denied" in activityScope ? { id: { in: [] } } : activityScope });
    check("Sees the dept A activity", visibleActivitiesA.some((a) => a.id === activityA.id));
    check("Does not see the dept B activity", !visibleActivitiesA.some((a) => a.id === activityB.id));

    console.log("\nTesting resolveDepartmentForCreate rejects a foreign department for Department Manager...\n");
    const foreignCreate = await resolveDepartmentForCreate(managerUser.id, Role.DEPARTMENT_MANAGER, deptB.id, "project.create");
    check("Submitting dept B (not their department) is denied", "denied" in foreignCreate && (foreignCreate as any).denied === "invalid_department");
    const ownCreate = await resolveDepartmentForCreate(managerUser.id, Role.DEPARTMENT_MANAGER, deptA.id, "project.create");
    check("Submitting dept A (their own department) is accepted", !("denied" in ownCreate) && (ownCreate as any).departmentId === deptA.id);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["projectActivity", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["project", () => (projectIds.length > 0 ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () =>
        prisma.user.deleteMany({ where: { id: { in: [managerUser?.id, otherUser?.id].filter((x): x is string => !!x) } } })],
      ["department", () =>
        prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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
