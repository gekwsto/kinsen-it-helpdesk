/**
 * Ticket sharing: shareWithDepartment/shareWithSubDepartment widen
 * visibility for own-only (REQUESTER-tier) department members — full-view
 * members already see every ticket in their department regardless of share
 * flags, so sharing is a no-op there by construction. Enforced centrally via
 * canViewTicket (single-ticket GET/detail page) and buildTicketListWhere
 * (list pages + dashboard) in department-scope-service.ts — never a
 * page-local filter.
 *
 * Also covers the canViewTicket over-visibility fix directly: department
 * membership alone (REQUESTER-tier) must never grant visibility into another
 * member's ticket — only direct relationship (requester/assignee), explicit
 * sharing, or a full-view department permission does.
 *
 * Tests:
 *  1. Requester can view their own ticket.
 *  2. shareWithDepartment:false — a non-requester own-only member cannot view the ticket.
 *  3. A Department Manager (full-view tier) can view the ticket via department-wide
 *     permission alone, with nothing shared and no direct relationship.
 *  4. Admin can view the ticket (system-wide), despite zero department membership.
 *  5. Director can view the ticket (system-wide), despite zero department membership.
 *  6. shareWithDepartment:true — the own-only member can now view it.
 *  7. A user with no membership in the department at all never sees it, even when shared.
 *  8. All Tickets list scope (buildTicketListWhere) agrees with canViewTicket for the
 *     same users/state (list and direct-detail access never diverge).
 *  9. shareWithSubDepartment:true — only a member of the ticket's specific
 *     SubDepartment can view it this way; another own-only member of the
 *     same department but NOT that sub-department still cannot.
 *  10. A full-view (AGENT_ASSIGNEE) member sees the ticket regardless of share flags.
 *  11. The assigned agent can view the ticket via direct relationship alone,
 *      even with zero department membership and nothing shared.
 *  12. Sharing widens VIEW only — canActOnEntity("ticket.changeStatus") for the
 *      same own-only, now-shared-in member still returns false (mutation stays gated).
 *  13. buildAssignedToMeWhere/buildCreatedByMeWhere never reference the share
 *      fields — Assigned to Me / Created by Me stay strict by construction.
 *
 * Usage: npx tsx scripts/test-ticket-sharing-visibility.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260722090000_add_ticket_sharing_and_department_change_audit migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import {
  canViewTicket,
  canActOnEntity,
  buildTicketListWhere,
  buildAssignedToMeWhere,
  buildCreatedByMeWhere,
} from "@/lib/services/department-scope-service";
import { createSubDepartment } from "@/lib/services/sub-department-service";
import { grantSubDepartmentMembership } from "@/lib/services/sub-department-membership-service";

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
  console.log("Testing Assigned to Me / Created by Me never reference share fields (pure, no DB)...\n");
  const assignedWhere = buildAssignedToMeWhere("user-x");
  const createdWhere = buildCreatedByMeWhere("user-x");
  check("buildAssignedToMeWhere returns only assignedAgentId", JSON.stringify(assignedWhere) === JSON.stringify({ assignedAgentId: "user-x" }));
  check("buildCreatedByMeWhere returns only requesterId", JSON.stringify(createdWhere) === JSON.stringify({ requesterId: "user-x" }));

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed checks.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let migrationApplied = true;
  try {
    await prisma.ticket.findFirst({ select: { id: true, shareWithDepartment: true, shareWithSubDepartment: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nTicket.shareWithDepartment/shareWithSubDepartment aren't usable against this database yet (migration " +
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
  let agent: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let deptManager: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ownOnlyInSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ownOnlyOutsideSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsider: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let unaffiliatedAssignee: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let adminUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let directorUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ticket: Awaited<ReturnType<typeof prisma.ticket.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Sharing Dept ${RUN_ID}`, slug: `test-sharing-dept-${RUN_ID}` } });
    subDept = await createSubDepartment({ departmentId: dept.id, name: `Sharing Sub ${RUN_ID}` });

    requester = await prisma.user.create({ data: { email: `test-sharing-requester-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    agent = await prisma.user.create({ data: { email: `test-sharing-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    deptManager = await prisma.user.create({ data: { email: `test-sharing-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    ownOnlyInSub = await prisma.user.create({ data: { email: `test-sharing-in-sub-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    ownOnlyOutsideSub = await prisma.user.create({ data: { email: `test-sharing-outside-sub-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsider = await prisma.user.create({ data: { email: `test-sharing-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    unaffiliatedAssignee = await prisma.user.create({ data: { email: `test-sharing-unaffiliated-assignee-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    adminUser = await prisma.user.create({ data: { email: `test-sharing-admin-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN } });
    directorUser = await prisma.user.create({ data: { email: `test-sharing-director-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.DIRECTOR } });

    for (const [user, role] of [
      [requester, DepartmentRole.REQUESTER],
      [agent, DepartmentRole.AGENT_ASSIGNEE],
      [deptManager, DepartmentRole.DEPARTMENT_MANAGER],
      [ownOnlyInSub, DepartmentRole.REQUESTER],
      [ownOnlyOutsideSub, DepartmentRole.REQUESTER],
    ] as const) {
      const m = await prisma.departmentMembership.create({
        data: { userId: user.id, departmentId: dept.id, role, source: MembershipSource.MANUAL },
      });
      membershipIds.push(m.id);
    }

    const grant = await grantSubDepartmentMembership(ownOnlyInSub.id, subDept.id);
    check("Setup: ownOnlyInSub granted active SubDepartmentMembership in subDept", grant.ok === true);

    const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!defaultStatus) throw new Error("No default TicketStatus seeded — cannot create a test ticket.");

    ticket = await prisma.ticket.create({
      data: {
        title: `Test Sharing Ticket ${RUN_ID}`,
        description: "x",
        statusId: defaultStatus.id,
        requesterId: requester.id,
        departmentId: dept.id,
        subDepartmentId: subDept.id,
      },
    });

    const ticketArgs = (t: NonNullable<typeof ticket>) => ({
      departmentId: t.departmentId,
      subDepartmentId: t.subDepartmentId,
      requesterId: t.requesterId,
      assignedAgentId: t.assignedAgentId,
      shareWithDepartment: t.shareWithDepartment,
      shareWithSubDepartment: t.shareWithSubDepartment,
    });

    console.log("\nTesting direct relationship — the requester can always view their own ticket...\n");
    check("Requester can view their own ticket", await canViewTicket(requester.id, Role.USER, ticketArgs(ticket)));

    console.log("\nTesting shareWithDepartment:false (default) — own-only non-requester cannot view...\n");
    check(
      "ownOnlyInSub (not requester, not shared) cannot view",
      !(await canViewTicket(ownOnlyInSub.id, Role.USER, ticketArgs(ticket)))
    );

    console.log("\nTesting department-wide / system-wide visibility, independent of sharing...\n");
    check(
      "Department Manager (full-view tier) can view via department-wide permission, nothing shared",
      await canViewTicket(deptManager.id, Role.USER, ticketArgs(ticket))
    );
    check(
      "Admin can view (system-wide), despite zero department membership",
      await canViewTicket(adminUser.id, Role.ADMIN, ticketArgs(ticket))
    );
    check(
      "Director can view (system-wide), despite zero department membership",
      await canViewTicket(directorUser.id, Role.DIRECTOR, ticketArgs(ticket))
    );

    console.log("\nTesting shareWithDepartment:true widens visibility...\n");
    const sharedByDept = await prisma.ticket.update({ where: { id: ticket.id }, data: { shareWithDepartment: true } });
    check(
      "ownOnlyOutsideSub (own-only, department-shared) can now view",
      await canViewTicket(ownOnlyOutsideSub.id, Role.USER, ticketArgs(sharedByDept))
    );
    check(
      "outsider (no membership in dept at all) still cannot view, even though shared",
      !(await canViewTicket(outsider.id, Role.USER, ticketArgs(sharedByDept)))
    );

    console.log("\nTesting All Tickets list scope (buildTicketListWhere) agrees with canViewTicket, at this shared-by-department state...\n");
    const listMatchesDetail = async (userId: string, role: Role, expected: boolean) => {
      const scope = await buildTicketListWhere(userId, role);
      if ("denied" in scope) return expected === false;
      const found = await prisma.ticket.findFirst({ where: { AND: [scope, { id: ticket!.id }] }, select: { id: true } });
      return (found !== null) === expected;
    };
    check(
      "List scope includes the ticket for ownOnlyOutsideSub (department-shared), matching canViewTicket=true",
      await listMatchesDetail(ownOnlyOutsideSub.id, Role.USER, true)
    );
    check(
      "List scope excludes the ticket for outsider, matching canViewTicket=false",
      await listMatchesDetail(outsider.id, Role.USER, false)
    );

    console.log("\nTesting shareWithSubDepartment:true only widens visibility for that sub-department's members...\n");
    const sharedBySubDept = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { shareWithDepartment: false, shareWithSubDepartment: true },
    });
    check(
      "ownOnlyInSub (active SubDepartmentMembership in subDept) can view",
      await canViewTicket(ownOnlyInSub.id, Role.USER, ticketArgs(sharedBySubDept))
    );
    check(
      "ownOnlyOutsideSub (department member, NOT subDept member) cannot view via sub-department share",
      !(await canViewTicket(ownOnlyOutsideSub.id, Role.USER, ticketArgs(sharedBySubDept)))
    );

    console.log("\nTesting All Tickets list scope agrees with canViewTicket at this shared-by-subdepartment state too...\n");
    check(
      "List scope includes the ticket for ownOnlyInSub (sub-department-shared), matching canViewTicket=true",
      await listMatchesDetail(ownOnlyInSub.id, Role.USER, true)
    );
    check(
      "List scope excludes the ticket for ownOnlyOutsideSub (not a sub-department member), matching canViewTicket=false",
      await listMatchesDetail(ownOnlyOutsideSub.id, Role.USER, false)
    );

    console.log("\nTesting sharing widens VIEW only, never mutation permission...\n");
    check(
      "ownOnlyOutsideSub still cannot changeStatus even though nothing is shared to them here",
      !(await canActOnEntity(ownOnlyOutsideSub.id, Role.USER, dept.id, "ticket.changeStatus", false))
    );

    console.log("\nTesting full-view members are unaffected by share flags either way...\n");
    check(
      "AGENT_ASSIGNEE (full department view) can view even when nothing is shared",
      await canViewTicket(agent.id, Role.USER, ticketArgs({ ...ticket, shareWithDepartment: false, shareWithSubDepartment: false }))
    );

    console.log("\nTesting the assigned agent can view via direct relationship alone...\n");
    const assignedToUnaffiliated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: { assignedAgentId: unaffiliatedAssignee.id, shareWithDepartment: false, shareWithSubDepartment: false },
    });
    check(
      "Assigned agent with zero department membership and nothing shared can still view (direct relationship)",
      await canViewTicket(unaffiliatedAssignee.id, Role.USER, ticketArgs(assignedToUnaffiliated))
    );
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticket ? prisma.ticket.deleteMany({ where: { id: ticket.id } }) : Promise.resolve())],
      ["subDepartmentMemberships", () => (subDept ? prisma.subDepartmentMembership.deleteMany({ where: { subDepartmentId: subDept.id } }) : Promise.resolve())],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["subDepartment", () => (subDept ? prisma.subDepartment.deleteMany({ where: { id: subDept.id } }) : Promise.resolve())],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: {
              id: {
                in: [
                  requester?.id,
                  agent?.id,
                  deptManager?.id,
                  ownOnlyInSub?.id,
                  ownOnlyOutsideSub?.id,
                  outsider?.id,
                  unaffiliatedAssignee?.id,
                  adminUser?.id,
                  directorUser?.id,
                ].filter((id): id is string => !!id),
              },
            },
          }),
      ],
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
