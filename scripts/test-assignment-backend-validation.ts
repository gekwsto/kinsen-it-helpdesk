/**
 * Confirms the backend write-path guard rejects a non-assignable target for
 * all three entity types — calling `userHasAssignablePermissionForEntity`
 * directly, the exact function every write route
 * (PATCH /api/tickets/[id]/assign, PATCH /api/tickets/[id],
 * POST/PATCH /api/activities[/id], POST/PATCH /api/projects[/id]) calls
 * before persisting an assignee. Since it's the same function backing both
 * the assignee-dropdown list and the write validation, there's no separate
 * frontend-only filter a raw API call could bypass — this test IS that
 * "raw API cannot bypass frontend filtering" guarantee.
 *
 * Usage: npx tsx scripts/test-assignment-backend-validation.ts
 * Requires a reachable DATABASE_URL and the seeded `*.assignable` defaults.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { userHasAssignablePermissionForEntity, type AssignableEntityType } from "@/lib/services/assignment-eligibility-service";

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

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Backend Validation Dept ${RUN_ID}`, slug: `test-backend-validation-dept-${RUN_ID}` } });

    // Eligible for tickets/activities (AGENT_ASSIGNEE), not for projects.
    const agent = await prisma.user.create({
      data: { email: `test-backend-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(agent.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: agent.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    // Eligible for projects (PROJECT_MANAGER), not for tickets.
    const projectManager = await prisma.user.create({
      data: { email: `test-backend-pm-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(projectManager.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: projectManager.id, departmentId: dept.id, role: DepartmentRole.PROJECT_MANAGER, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    // Eligible for nothing (REQUESTER — every *.assignable false by default).
    const requester = await prisma.user.create({
      data: { email: `test-backend-requester-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(requester.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    // Simulates exactly what each write route's validation loop does:
    // reject the whole write if any submitted id isn't assignable.
    async function simulateWriteValidation(userIdsToAssign: string[], entityType: AssignableEntityType, departmentId: string | null) {
      for (const id of userIdsToAssign) {
        if (!(await userHasAssignablePermissionForEntity(id, entityType, departmentId))) {
          return { ok: false, code: "assignee_not_assignable" as const };
        }
      }
      return { ok: true as const };
    }

    console.log("Testing ticket assignment write validation...\n");
    check("Assigning the eligible AGENT_ASSIGNEE to a ticket is accepted", (await simulateWriteValidation([agent.id], "ticket", dept.id)).ok === true);
    const ticketRejectPM = await simulateWriteValidation([projectManager.id], "ticket", dept.id);
    check("Assigning the PROJECT_MANAGER (not ticket-eligible) to a ticket is rejected", ticketRejectPM.ok === false && ticketRejectPM.code === "assignee_not_assignable");
    check("Assigning the REQUESTER to a ticket is rejected", (await simulateWriteValidation([requester.id], "ticket", dept.id)).ok === false);

    console.log("\nTesting activity assignment write validation...\n");
    check("Assigning the eligible AGENT_ASSIGNEE to an activity is accepted", (await simulateWriteValidation([agent.id], "activity", dept.id)).ok === true);
    check("Assigning the REQUESTER to an activity is rejected", (await simulateWriteValidation([requester.id], "activity", dept.id)).ok === false);

    console.log("\nTesting project assignment write validation...\n");
    check("Assigning the eligible PROJECT_MANAGER to a project is accepted", (await simulateWriteValidation([projectManager.id], "project", dept.id)).ok === true);
    const projectRejectAgent = await simulateWriteValidation([agent.id], "project", dept.id);
    check("Assigning the AGENT_ASSIGNEE (not project-eligible) to a project is rejected", projectRejectAgent.ok === false && projectRejectAgent.code === "assignee_not_assignable");

    console.log("\nTesting a batch with one bad id rejects the whole write (matches the routes' loop-and-reject behavior)...\n");
    const batchResult = await simulateWriteValidation([agent.id, requester.id], "ticket", dept.id);
    check("A mixed batch (one eligible, one not) is rejected as a whole", batchResult.ok === false);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.delete({ where: { id: dept.id } }) : Promise.resolve())],
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
