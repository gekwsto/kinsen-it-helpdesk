/**
 * Pending tickets are architecturally invisible to the normal Ticket
 * surface — they live in a separate PendingTicket table, never a Ticket row,
 * until Accept. buildPendingTicketListWhere (a thin wrapper over the same
 * private buildEntityListWhere buildProjectListWhere/buildActivityListWhere
 * use, gated by ticket.pending.view) is what /tickets/pending scopes with.
 *
 * Tests:
 *  1. A freshly created PendingTicket has no corresponding Ticket row —
 *     buildTicketListWhere-scoped queries (the real "All Tickets" list) can
 *     never surface it, by construction (no row exists to match).
 *  2. buildPendingTicketListWhere: a Department Manager sees only their own
 *     department's pending tickets.
 *  3. buildPendingTicketListWhere: denied for a department they don't belong to.
 *  4. A user without ticket.pending.view anywhere gets a zero-match scope.
 *  5. Admin/Director's scope has no departmentId filter, so it includes
 *     departmentId: null (unmatched) pending tickets — the "unmatched is
 *     Admin/Director-only" rule falling out of the same primitive
 *     buildProjectListWhere already uses, with no special-casing needed.
 *
 * Usage: npx tsx scripts/test-pending-ticket-visibility.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole, MembershipSource, Role, AuthProvider } from "@prisma/client";
import { buildPendingTicketListWhere } from "@/lib/services/department-scope-service";

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

  try {
    await prisma.pendingTicket.count();
  } catch (err) {
    console.log(
      "PendingTicket isn't usable against this database yet (migration " +
        "20260724090000_add_department_inbound_email_and_pending_tickets not applied) — skipping. " +
        "Run `npx prisma migrate deploy` (or `migrate dev`) first."
    );
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let noAccessUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];
  const pendingTicketIds: string[] = [];

  try {
    console.log("\nSetting up two departments, a manager, and pending tickets in each...\n");
    deptA = await prisma.department.create({ data: { name: `Vis Dept A ${RUN_ID}`, slug: `vis-dept-a-${RUN_ID}` }, select: { id: true } });
    deptB = await prisma.department.create({ data: { name: `Vis Dept B ${RUN_ID}`, slug: `vis-dept-b-${RUN_ID}` }, select: { id: true } });

    managerUser = await prisma.user.create({
      data: { email: `vis-manager-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    noAccessUser = await prisma.user.create({
      data: { email: `vis-noaccess-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    const membership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(membership.id);

    const pendingA = await prisma.pendingTicket.create({
      data: { emailMessageId: `vis-a-${RUN_ID}@test.local`, fromEmail: "a@example.com", subject: "In Dept A", body: "x", receivedAt: new Date(), departmentId: deptA.id },
    });
    pendingTicketIds.push(pendingA.id);
    const pendingB = await prisma.pendingTicket.create({
      data: { emailMessageId: `vis-b-${RUN_ID}@test.local`, fromEmail: "b@example.com", subject: "In Dept B", body: "x", receivedAt: new Date(), departmentId: deptB.id },
    });
    pendingTicketIds.push(pendingB.id);
    const pendingUnmatched = await prisma.pendingTicket.create({
      data: { emailMessageId: `vis-unmatched-${RUN_ID}@test.local`, fromEmail: "c@example.com", subject: "Unmatched", body: "x", receivedAt: new Date(), departmentId: null },
    });
    pendingTicketIds.push(pendingUnmatched.id);

    console.log("\nTesting a pending ticket never has a corresponding Ticket row...\n");
    const asRealTicket = await prisma.ticket.findFirst({ where: { emailMessageId: pendingA.emailMessageId } });
    check("No Ticket row exists for the pending ticket's emailMessageId — invisible to any Ticket-scoped query by construction", asRealTicket === null);

    console.log("\nTesting buildPendingTicketListWhere scoping...\n");
    const managerWhere = await buildPendingTicketListWhere(managerUser.id, Role.USER, deptA.id);
    check("Department Manager's own-department scope resolves (not denied)", !("denied" in managerWhere));
    if (!("denied" in managerWhere)) {
      const visible = await prisma.pendingTicket.findMany({ where: { AND: [managerWhere, { id: { in: pendingTicketIds } }] } });
      check("Manager sees deptA's pending ticket", visible.some((p) => p.id === pendingA.id));
      check("Manager does NOT see deptB's pending ticket", !visible.some((p) => p.id === pendingB.id));
      check("Manager does NOT see the unmatched pending ticket", !visible.some((p) => p.id === pendingUnmatched.id));
    }

    const deniedWhere = await buildPendingTicketListWhere(managerUser.id, Role.USER, deptB.id);
    check("Manager is denied scope for a department they don't belong to", "denied" in deniedWhere);

    const noAccessWhere = await buildPendingTicketListWhere(noAccessUser.id, Role.USER, undefined);
    check(
      "A user with no ticket.pending.view anywhere gets a zero-match scope",
      !("denied" in noAccessWhere) && JSON.stringify(noAccessWhere).includes('"id":{"in":[]}')
    );

    console.log("\nTesting Admin/Director sees unmatched (departmentId: null) pending tickets too...\n");
    const directorWhere = await buildPendingTicketListWhere("nonexistent-director-id", Role.DIRECTOR, undefined);
    check("Director's unrestricted scope has no departmentId filter ({})", JSON.stringify(directorWhere) === "{}");
    if (!("denied" in directorWhere)) {
      const allVisibleToDirector = await prisma.pendingTicket.findMany({
        where: { AND: [directorWhere as Record<string, unknown>, { id: { in: pendingTicketIds } }] },
      });
      check("Unrestricted scope includes the unmatched pending ticket", allVisibleToDirector.some((p) => p.id === pendingUnmatched.id));
    } else {
      check("Director's scope was not denied", false);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["pendingTickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [managerUser?.id, noAccessUser?.id].filter((id): id is string => !!id) } },
          }),
      ],
      [
        "departments",
        () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } }),
      ],
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
