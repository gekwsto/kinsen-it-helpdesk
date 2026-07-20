/**
 * Project member/owner assignability — same rule as tickets/activities (see
 * test-assignable-users-ticket.ts for the full effective-permission
 * coverage), focused here on the "was ADMIN-only, now permission-driven"
 * widening: PROJECT_MANAGER and DEPARTMENT_ADMIN members are now eligible
 * (per the seeded `project.assignable` defaults), while AGENT_ASSIGNEE
 * (project.assignable: false by default) stays excluded.
 *
 * Usage: npx tsx scripts/test-assignable-users-project.ts
 * Requires a reachable DATABASE_URL and the seeded `*.assignable` defaults.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { userHasAssignablePermissionForEntity, getAssignableUsersForProject } from "@/lib/services/assignment-eligibility-service";

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
    dept = await prisma.department.create({ data: { name: `Test Project Assign Dept ${RUN_ID}`, slug: `test-project-assign-dept-${RUN_ID}` } });

    const projectManager = await prisma.user.create({
      data: { email: `test-project-pm-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(projectManager.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: projectManager.id, departmentId: dept.id, role: DepartmentRole.PROJECT_MANAGER, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const agentAssignee = await prisma.user.create({
      data: { email: `test-project-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(agentAssignee.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: agentAssignee.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const admin = await prisma.user.create({
      data: { email: `test-project-admin-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN },
    });
    userIds.push(admin.id);

    console.log("Testing the ADMIN-only -> permission-driven widening...\n");
    check(
      "PROJECT_MANAGER member is now assignable to projects (was ADMIN-only before this feature)",
      await userHasAssignablePermissionForEntity(projectManager.id, "project", dept.id)
    );
    check(
      "AGENT_ASSIGNEE member stays NOT assignable to projects (project.assignable false by default)",
      !(await userHasAssignablePermissionForEntity(agentAssignee.id, "project", dept.id))
    );
    check("ADMIN stays assignable (unchanged)", await userHasAssignablePermissionForEntity(admin.id, "project", dept.id));

    console.log("\nTesting getAssignableUsersForProject list builder...\n");
    const list = (await getAssignableUsersForProject(dept.id)).map((u) => u.id);
    check("Includes the PROJECT_MANAGER member", list.includes(projectManager.id));
    check("Includes ADMIN", list.includes(admin.id));
    check("Excludes the AGENT_ASSIGNEE member", !list.includes(agentAssignee.id));
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
