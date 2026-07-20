/**
 * Full coverage of the effective assignability rule
 * (lib/services/assignment-eligibility-service.ts) for tickets — the same
 * rule Activity/Project reuse, so this is the most thorough of the three
 * per-entity test scripts:
 *   - AGENT_ASSIGNEE membership + ticket.assignable -> assignable in that department
 *   - Global IT_AGENT with NO membership anywhere -> NOT assignable (a plain
 *     role's global permission doesn't leak across every department)
 *   - DIRECTOR (canViewAllDepartments, no explicit ticket.assignable grant) -> NOT assignable by default
 *   - Inactive user -> excluded
 *   - User with membership in a DIFFERENT department -> excluded
 *   - ADMIN -> always assignable (universal bypass, unchanged)
 *   - Microsoft-sourced (MICROSOFT_DEPARTMENT) AGENT_ASSIGNEE membership ->
 *     assignable the same as a MANUAL one (the check is source-agnostic)
 *
 * Usage: npx tsx scripts/test-assignable-users-ticket.ts
 * Requires a reachable DATABASE_URL and the seeded `*.assignable` defaults.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { userHasAssignablePermissionForEntity, getAssignableUsersForTicket } from "@/lib/services/assignment-eligibility-service";

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

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Assign Dept A ${RUN_ID}`, slug: `test-assign-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Assign Dept B ${RUN_ID}`, slug: `test-assign-dept-b-${RUN_ID}` } });

    const agent = await prisma.user.create({
      data: { email: `test-assign-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(agent.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: agent.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const itAgentNoMembership = await prisma.user.create({
      data: { email: `test-assign-itagent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.IT_AGENT },
    });
    userIds.push(itAgentNoMembership.id);

    const director = await prisma.user.create({
      data: { email: `test-assign-director-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.DIRECTOR },
    });
    userIds.push(director.id);

    const inactiveAgent = await prisma.user.create({
      data: { email: `test-assign-inactive-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: false },
    });
    userIds.push(inactiveAgent.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: inactiveAgent.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const otherDeptAgent = await prisma.user.create({
      data: { email: `test-assign-otherdept-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    userIds.push(otherDeptAgent.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: otherDeptAgent.id, departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
        })
      ).id
    );

    const admin = await prisma.user.create({
      data: { email: `test-assign-admin-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN },
    });
    userIds.push(admin.id);

    const msftAgent = await prisma.user.create({
      data: { email: `test-assign-msft-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT, role: Role.IT_AGENT },
    });
    userIds.push(msftAgent.id);
    membershipIds.push(
      (
        await prisma.departmentMembership.create({
          data: { userId: msftAgent.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MICROSOFT_DEPARTMENT, isActive: true },
        })
      ).id
    );

    console.log("Testing userHasAssignablePermissionForEntity (ticket)...\n");
    check("AGENT_ASSIGNEE membership in dept A -> assignable in dept A", await userHasAssignablePermissionForEntity(agent.id, "ticket", deptA.id));
    check("Global IT_AGENT with no membership anywhere -> NOT assignable in dept A", !(await userHasAssignablePermissionForEntity(itAgentNoMembership.id, "ticket", deptA.id)));
    check("DIRECTOR (no explicit ticket.assignable grant) -> NOT assignable by default", !(await userHasAssignablePermissionForEntity(director.id, "ticket", deptA.id)));
    check("Inactive user -> NOT assignable even with a matching membership", !(await userHasAssignablePermissionForEntity(inactiveAgent.id, "ticket", deptA.id)));
    check("AGENT_ASSIGNEE membership in dept B -> NOT assignable in dept A", !(await userHasAssignablePermissionForEntity(otherDeptAgent.id, "ticket", deptA.id)));
    check("ADMIN -> always assignable (universal bypass)", await userHasAssignablePermissionForEntity(admin.id, "ticket", deptA.id));
    check(
      "Microsoft-sourced AGENT_ASSIGNEE membership -> assignable the same as MANUAL",
      await userHasAssignablePermissionForEntity(msftAgent.id, "ticket", deptA.id)
    );

    console.log("\nTesting getAssignableUsersForTicket list builder...\n");
    const listForA = await getAssignableUsersForTicket(deptA.id);
    const listForAIds = listForA.map((u) => u.id);
    check("List for dept A includes the AGENT_ASSIGNEE member", listForAIds.includes(agent.id));
    check("List for dept A includes the Microsoft-sourced agent", listForAIds.includes(msftAgent.id));
    check("List for dept A includes ADMIN", listForAIds.includes(admin.id));
    check("List for dept A excludes the inactive user", !listForAIds.includes(inactiveAgent.id));
    check("List for dept A excludes the dept B member", !listForAIds.includes(otherDeptAgent.id));
    check("List for dept A excludes the no-membership global IT_AGENT", !listForAIds.includes(itAgentNoMembership.id));
    check("List for dept A excludes DIRECTOR (no explicit grant)", !listForAIds.includes(director.id));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
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
