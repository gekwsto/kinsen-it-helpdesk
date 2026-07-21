/**
 * acceptPendingTicket / rejectPendingTicket (lib/services/pending-ticket-service.ts)
 * are the only two ways a PendingTicket ever changes status. Accept is the
 * ONLY path that ever creates a real Ticket from this flow; Reject is a soft
 * update kept for audit and never produces one.
 *
 * Tests:
 *  1. Accepting a PENDING ticket creates a real Ticket (source: EMAIL,
 *     correct departmentId/emailMessageId) and sets acceptedById/acceptedAt/
 *     acceptedTicketId on the PendingTicket.
 *  2. The newly created Ticket is now visible via buildTicketListWhere for
 *     that department — proving Accept is the one path that ever makes a
 *     pending ticket "real."
 *  3. Re-accepting the same (now ACCEPTED) pending ticket returns
 *     already_accepted, does not create a second Ticket.
 *  4. Rejecting a PENDING ticket sets status REJECTED + rejectedById/
 *     rejectedAt, and never creates a Ticket.
 *  5. Re-rejecting an already-REJECTED ticket returns already_rejected.
 *  6. Accepting an already-REJECTED ticket returns already_rejected (not
 *     silently accepted).
 *  7. Accepting an unmatched (departmentId: null) pending ticket with an
 *     explicit overrideDepartmentId creates the Ticket in that department.
 *
 * Usage: npx tsx scripts/test-pending-ticket-accept-reject.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { acceptPendingTicket, rejectPendingTicket } from "@/lib/services/pending-ticket-service";
import { buildTicketListWhere } from "@/lib/services/department-scope-service";

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

  const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (!defaultStatus) {
    check("A default TicketStatus is seeded (required for Accept to work at all)", false);
    printSummaryAndExit();
    return;
  }

  let dept: { id: string } | undefined;
  let acceptingUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const pendingTicketIds: string[] = [];
  const ticketIds: string[] = [];
  const userEmails: string[] = [];

  try {
    console.log("\nSetting up a department and an accepting user...\n");
    dept = await prisma.department.create({ data: { name: `AR Dept ${RUN_ID}`, slug: `ar-dept-${RUN_ID}` }, select: { id: true } });
    acceptingUser = await prisma.user.create({
      data: { email: `ar-accepting-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    const senderEmail = `ar-sender-${RUN_ID}@example.com`;
    userEmails.push(senderEmail);

    console.log("\nTesting Accept creates a real Ticket...\n");
    const pending = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `ar-accept-${RUN_ID}@test.local`,
        fromEmail: senderEmail,
        subject: "Accept Me",
        body: "<p>Body</p>",
        receivedAt: new Date(),
        departmentId: dept.id,
      },
    });
    pendingTicketIds.push(pending.id);

    const acceptResult = await acceptPendingTicket(pending.id, acceptingUser.id);
    check("Accept succeeds (ok: true)", acceptResult.ok === true);
    if (acceptResult.ok) {
      ticketIds.push(acceptResult.ticket.id);
      const ticket = await prisma.ticket.findUnique({ where: { id: acceptResult.ticket.id } });
      check("Created Ticket has source EMAIL", ticket?.source === "EMAIL");
      check("Created Ticket has the pending ticket's departmentId", ticket?.departmentId === dept.id);
      check("Created Ticket carries over the emailMessageId", ticket?.emailMessageId === pending.emailMessageId);

      const afterAccept = await prisma.pendingTicket.findUnique({ where: { id: pending.id } });
      check("PendingTicket status is now ACCEPTED", afterAccept?.status === "ACCEPTED");
      check("acceptedById is set", afterAccept?.acceptedById === acceptingUser.id);
      check("acceptedTicketId points at the new Ticket", afterAccept?.acceptedTicketId === acceptResult.ticket.id);

      console.log("\nTesting the accepted Ticket is now visible via buildTicketListWhere...\n");
      const scope = await buildTicketListWhere(acceptingUser.id, Role.ADMIN, dept.id);
      if (!("denied" in scope)) {
        const visible = await prisma.ticket.findFirst({ where: { AND: [scope, { id: acceptResult.ticket.id }] } });
        check("The newly created Ticket is visible in a department-scoped ticket list query", visible !== null);
      } else {
        check("buildTicketListWhere resolved for ADMIN", false);
      }
    }

    console.log("\nTesting re-accepting an already-accepted ticket...\n");
    const reAccept = await acceptPendingTicket(pending.id, acceptingUser.id);
    check("Re-accepting returns already_accepted", !reAccept.ok && reAccept.error === "already_accepted");
    const ticketCountAfterReAccept = await prisma.ticket.count({ where: { emailMessageId: pending.emailMessageId } });
    check("Re-accepting does not create a second Ticket", ticketCountAfterReAccept === 1);

    console.log("\nTesting Reject...\n");
    const pendingToReject = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `ar-reject-${RUN_ID}@test.local`,
        fromEmail: senderEmail,
        subject: "Reject Me",
        body: "<p>Body</p>",
        receivedAt: new Date(),
        departmentId: dept.id,
      },
    });
    pendingTicketIds.push(pendingToReject.id);

    const rejectResult = await rejectPendingTicket(pendingToReject.id, acceptingUser.id);
    check("Reject succeeds (ok: true)", rejectResult.ok === true);

    const afterReject = await prisma.pendingTicket.findUnique({ where: { id: pendingToReject.id } });
    check("PendingTicket status is now REJECTED", afterReject?.status === "REJECTED");
    check("rejectedById is set", afterReject?.rejectedById === acceptingUser.id);
    check("rejectedAt is set", afterReject?.rejectedAt !== null);

    const rejectedAsTicket = await prisma.ticket.findFirst({ where: { emailMessageId: pendingToReject.emailMessageId } });
    check("Rejected pending ticket never produced a Ticket", rejectedAsTicket === null);

    console.log("\nTesting re-rejecting and accepting-after-reject...\n");
    const reReject = await rejectPendingTicket(pendingToReject.id, acceptingUser.id);
    check("Re-rejecting returns already_rejected", !reReject.ok && reReject.error === "already_rejected");

    const acceptAfterReject = await acceptPendingTicket(pendingToReject.id, acceptingUser.id);
    check("Accepting an already-rejected ticket returns already_rejected (not silently accepted)", !acceptAfterReject.ok && acceptAfterReject.error === "already_rejected");

    console.log("\nTesting Accept with an explicit department override for an unmatched pending ticket...\n");
    const unmatchedPending = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `ar-unmatched-${RUN_ID}@test.local`,
        fromEmail: senderEmail,
        subject: "Unmatched, Accept With Override",
        body: "<p>Body</p>",
        receivedAt: new Date(),
        departmentId: null,
      },
    });
    pendingTicketIds.push(unmatchedPending.id);

    const overrideResult = await acceptPendingTicket(unmatchedPending.id, acceptingUser.id, dept.id);
    check("Accepting an unmatched ticket with an override department succeeds", overrideResult.ok === true);
    if (overrideResult.ok) {
      ticketIds.push(overrideResult.ticket.id);
      const ticket = await prisma.ticket.findUnique({ where: { id: overrideResult.ticket.id } });
      check("The created Ticket uses the override department, not null", ticket?.departmentId === dept.id);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticketMessages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["ticketHistory", () => prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["pendingTickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: {
              OR: [
                { id: acceptingUser?.id ?? "___none___" },
                { email: { in: userEmails } },
              ],
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
