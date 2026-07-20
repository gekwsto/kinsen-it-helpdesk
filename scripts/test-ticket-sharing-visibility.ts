/**
 * Ticket sharing: shareWithDepartment/shareWithSubDepartment widen
 * visibility for own-only (REQUESTER-tier) department members — full-view
 * members already see every ticket in their department regardless of share
 * flags, so sharing is a no-op there by construction. Enforced centrally via
 * canViewTicket (single-ticket GET/detail page) and buildTicketListWhere
 * (list pages + dashboard) in department-scope-service.ts — never a
 * page-local filter.
 *
 * Tests:
 *  1. shareWithDepartment:false — a non-requester own-only member cannot view the ticket.
 *  2. shareWithDepartment:true — that same member can now view it.
 *  3. shareWithSubDepartment:true — only a member of the ticket's specific
 *     SubDepartment can view it this way; another own-only member of the
 *     same department but NOT that sub-department still cannot.
 *  4. A full-view (AGENT_ASSIGNEE) member sees the ticket regardless of share flags.
 *  5. A user with no membership in the department at all never sees it, even when shared.
 *  6. buildAssignedToMeWhere/buildCreatedByMeWhere never reference the share
 *     fields — Assigned to Me / Created by Me stay strict by construction.
 *
 * Usage: npx tsx scripts/test-ticket-sharing-visibility.ts
 * Requires a reachable DATABASE_URL AND the
 * 20260722090000_add_ticket_sharing_and_department_change_audit migration
 * applied — reports clearly and exits if either is missing.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { canViewTicket, buildAssignedToMeWhere, buildCreatedByMeWhere } from "@/lib/services/department-scope-service";
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
  let ownOnlyInSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ownOnlyOutsideSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsider: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let ticket: Awaited<ReturnType<typeof prisma.ticket.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Sharing Dept ${RUN_ID}`, slug: `test-sharing-dept-${RUN_ID}` } });
    subDept = await createSubDepartment({ departmentId: dept.id, name: `Sharing Sub ${RUN_ID}` });

    requester = await prisma.user.create({ data: { email: `test-sharing-requester-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    agent = await prisma.user.create({ data: { email: `test-sharing-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    ownOnlyInSub = await prisma.user.create({ data: { email: `test-sharing-in-sub-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    ownOnlyOutsideSub = await prisma.user.create({ data: { email: `test-sharing-outside-sub-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsider = await prisma.user.create({ data: { email: `test-sharing-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    for (const [user, role] of [
      [requester, DepartmentRole.REQUESTER],
      [agent, DepartmentRole.AGENT_ASSIGNEE],
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
      shareWithDepartment: t.shareWithDepartment,
      shareWithSubDepartment: t.shareWithSubDepartment,
    });

    console.log("\nTesting shareWithDepartment:false (default) — own-only non-requester cannot view...\n");
    check(
      "ownOnlyInSub (not requester, not shared) cannot view",
      !(await canViewTicket(ownOnlyInSub.id, Role.USER, ticketArgs(ticket)))
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

    console.log("\nTesting full-view members are unaffected by share flags either way...\n");
    check(
      "AGENT_ASSIGNEE (full department view) can view even when nothing is shared",
      await canViewTicket(agent.id, Role.USER, ticketArgs({ ...ticket, shareWithDepartment: false, shareWithSubDepartment: false }))
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
            where: { id: { in: [requester?.id, agent?.id, ownOnlyInSub?.id, ownOnlyOutsideSub?.id, outsider?.id].filter((id): id is string => !!id) } },
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
