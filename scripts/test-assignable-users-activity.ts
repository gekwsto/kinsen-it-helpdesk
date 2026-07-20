/**
 * Activity assignability — same rule as tickets (see
 * test-assignable-users-ticket.ts for the full effective-permission
 * coverage), focused here on the behavior CHANGE this feature makes:
 * activities used to be assignable to Administrators ONLY (a hardcoded
 * `role: Role.ADMIN` count-check in app/api/activities/route.ts and
 * [id]/route.ts) — now any role granted `activity.assignable` qualifies,
 * per the seeded defaults (AGENT_ASSIGNEE, IT_AGENT, DEPARTMENT_MANAGER,
 * DEPARTMENT_ADMIN, PROJECT_MANAGER), while a role that still shouldn't be
 * (plain USER/REQUESTER) stays excluded.
 *
 * Usage: npx tsx scripts/test-assignable-users-activity.ts
 * Requires a reachable DATABASE_URL and the seeded `*.assignable` defaults.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { userHasAssignablePermissionForEntity, getAssignableUsersForActivity } from "@/lib/services/assignment-eligibility-service";

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
    dept = await prisma.department.create({ data: { name: `Test Activity Assign Dept ${RUN_ID}`, slug: `test-activity-assign-dept-${RUN_ID}` } });

    const agentAssignee = await prisma.user.create({
      data: { email: `test-activity-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(agentAssignee.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: agentAssignee.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const requester = await prisma.user.create({
      data: { email: `test-activity-requester-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(requester.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const admin = await prisma.user.create({
      data: { email: `test-activity-admin-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN },
    });
    userIds.push(admin.id);

    console.log("Testing the ADMIN-only -> permission-driven widening...\n");
    check(
      "AGENT_ASSIGNEE member is now assignable to activities (was ADMIN-only before this feature)",
      await userHasAssignablePermissionForEntity(agentAssignee.id, "activity", dept.id)
    );
    check("REQUESTER member stays NOT assignable (no activity.assignable grant)", !(await userHasAssignablePermissionForEntity(requester.id, "activity", dept.id)));
    check("ADMIN stays assignable (unchanged)", await userHasAssignablePermissionForEntity(admin.id, "activity", dept.id));

    console.log("\nTesting getAssignableUsersForActivity list builder...\n");
    const list = (await getAssignableUsersForActivity(dept.id)).map((u) => u.id);
    check("Includes the AGENT_ASSIGNEE member", list.includes(agentAssignee.id));
    check("Includes ADMIN", list.includes(admin.id));
    check("Excludes the REQUESTER member", !list.includes(requester.id));
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
