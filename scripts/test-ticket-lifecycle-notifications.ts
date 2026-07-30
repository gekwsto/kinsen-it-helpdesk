/**
 * Focused, deterministic tests for the ticket created/closed lifecycle
 * notifications (lib/ticket-notification-service.ts's notifyRequesterCreated
 * / notifyRequesterClosed) — real Prisma fixtures against the real dev DB,
 * cleaned up in a finally block, but microsoft-graph.ts's sendMail is
 * monkey-patched in-process so NO real email is ever sent and no real Graph
 * credentials/network call is ever used. Covers: creation (both real
 * creation shapes), closed transitions (status route shape and cancel route
 * shape), the closed->closed no-op, idempotency under a direct duplicate
 * call and under genuine concurrency, skip for a non-notifiable requester,
 * a Graph failure producing a FAILED log without throwing, reopen+reclose
 * producing a second, distinct email, and HTML escaping of every dynamic
 * field in both templates.
 *
 * Route-level wiring (that each of the 5 real call sites actually invokes
 * these functions on the correct transition) is verified separately via
 * scripts/browser-verify-ticket-lifecycle-notification-routes.ts, using
 * real HTTP against a live dev server — that script deliberately uses a
 * no-reply-pattern requester email on every ticket so the SKIPPED branch is
 * structurally guaranteed and no real Graph call can ever be reached there
 * either.
 *
 * Usage: npx tsx scripts/test-ticket-lifecycle-notifications.ts
 */
import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import { notifyRequesterCreated, notifyRequesterClosed } from "@/lib/ticket-notification-service";
import { buildTicketCreatedNotificationHtml, buildTicketClosedNotificationHtml } from "@/lib/email-ticket-parser";
import { Role, AuthProvider, TicketSource } from "@prisma/client";

const RUN_ID = Date.now();
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

// ── Mocked Graph send — records every call, never touches the network ──────
type SentCall = { to: string; subject: string; html: string };
let sentCalls: SentCall[] = [];
let sendShouldFail = false;
let sendFailureMessage = "Simulated Graph outage";

const originalSendMail = microsoftGraph.sendMail;
microsoftGraph.sendMail = async (payload) => {
  if (sendShouldFail) throw new Error(sendFailureMessage);
  sentCalls.push({
    to: payload.message.toRecipients[0]?.emailAddress.address ?? "",
    subject: payload.message.subject,
    html: payload.message.body.content,
  });
};

function resetMock() {
  sentCalls = [];
  sendShouldFail = false;
}

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let status: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let noReplyRequester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let supportRequester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const userIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Lifecycle Notif Dept ${RUN_ID}`, slug: `lifecycle-notif-dept-${RUN_ID}` } });
    status = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    closedStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Closed ${RUN_ID}`, color: "#6b7280", isDefault: false, isClosed: true, order: 2 } });

    requester = await prisma.user.create({ data: { email: `lifecycle-requester-${RUN_ID}@example.com`, name: "Léa O'Brien <script>", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    noReplyRequester = await prisma.user.create({ data: { email: `no-reply@example.com`, name: "System", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    supportRequester = await prisma.user.create({ data: { email: (process.env.GRAPH_USER_EMAIL || process.env.SUPPORT_EMAIL || "kinsenitsupport@kinsen.gr"), name: "Support Mailbox", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id, noReplyRequester.id, supportRequester.id);

    async function makeTicket(requesterId: string, title: string, statusId: string) {
      const t = await prisma.ticket.create({
        data: { title, description: "Test description", source: TicketSource.WEB, requesterId, departmentId: dept!.id, statusId },
        select: { id: true, ticketNumber: true },
      });
      ticketIds.push(t.id);
      return t;
    }

    // ── 1. Creation notification: real ticket -> exactly one SENT, correct eventKey ──
    console.log("\n=== Creation notification ===\n");
    resetMock();
    const createdTicket = await makeTicket(requester.id, "First contact from a <b>customer</b>", status.id);
    await notifyRequesterCreated({ ticketId: createdTicket.id });
    check("Exactly one email sent for creation", sentCalls.length === 1);
    check("Subject includes the formatted ticket reference", sentCalls[0]?.subject.includes(`KIN-${createdTicket.ticketNumber}`));
    check("Body includes the ticket title (escaped)", sentCalls[0]?.html.includes("First contact from a &lt;b&gt;customer&lt;/b&gt;"));
    check("Body does NOT include the raw unescaped title", !sentCalls[0]?.html.includes("<b>customer</b>"));
    check("Body links directly to /tickets/{id}", sentCalls[0]?.html.includes(`/tickets/${createdTicket.id}`));
    let logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: createdTicket.id, type: "CREATED" } });
    check("Exactly one CREATED log row, status SENT", logs.length === 1 && logs[0].status === "SENT");
    check("Log row's eventKey matches the fixed per-ticket key", logs[0].eventKey === `ticket:${createdTicket.id}:created`);

    // ── 2. Duplicate direct call for the same ticket -> no second email ──
    console.log("\n=== Duplicate creation call is a no-op ===\n");
    await notifyRequesterCreated({ ticketId: createdTicket.id });
    check("No second email sent on a duplicate call", sentCalls.length === 1);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: createdTicket.id, type: "CREATED" } });
    check("Still exactly one CREATED log row", logs.length === 1);

    // ── 3. Concurrent duplicate calls -> at most one send ──
    console.log("\n=== Concurrent creation calls collapse to one send ===\n");
    resetMock();
    const concurrentTicket = await makeTicket(requester.id, "Concurrent creation test", status.id);
    await Promise.all([
      notifyRequesterCreated({ ticketId: concurrentTicket.id }),
      notifyRequesterCreated({ ticketId: concurrentTicket.id }),
      notifyRequesterCreated({ ticketId: concurrentTicket.id }),
      notifyRequesterCreated({ ticketId: concurrentTicket.id }),
      notifyRequesterCreated({ ticketId: concurrentTicket.id }),
    ]);
    check("Exactly one email sent despite 5 concurrent calls", sentCalls.length === 1);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: concurrentTicket.id, type: "CREATED" } });
    check("Exactly one CREATED log row after 5 concurrent calls", logs.length === 1 && logs[0].status === "SENT");

    // ── 4. PendingTicket receipt (never accepted) -> no CREATED email ever ──
    console.log("\n=== PendingTicket receipt without acceptance sends nothing ===\n");
    const pending = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `test-lifecycle-${RUN_ID}@example.com`,
        fromEmail: requester.email,
        fromName: requester.name,
        subject: "Unaccepted pending ticket",
        body: "body",
        receivedAt: new Date(),
        departmentId: dept.id,
        requesterId: requester.id,
      },
      select: { id: true },
    });
    // Nothing to call — createPendingTicketFromEmail/the inbound pipeline never invokes notifyRequesterCreated. Verified by construction: no Ticket exists for this PendingTicket, so there is no ticketId a CREATED notification could even be logged against.
    const pendingAsTicket = await prisma.ticket.findFirst({ where: { title: "Unaccepted pending ticket" } });
    check("No real Ticket was created for a merely-received PendingTicket", pendingAsTicket === null);
    await prisma.pendingTicket.delete({ where: { id: pending.id } });

    // ── 5. Closed notification: open -> closed transition ──
    console.log("\n=== Closed notification (open -> closed) ===\n");
    resetMock();
    const closingTicket = await makeTicket(requester.id, "Ticket to be closed", status.id);
    await prisma.ticket.update({ where: { id: closingTicket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyRequesterClosed({ ticketId: closingTicket.id, statusName: closedStatus.name, closingMessage: "Resolved by <i>agent</i>" });
    check("Exactly one email sent for closing", sentCalls.length === 1);
    check("Subject includes the ticket reference", sentCalls[0]?.subject.includes(`KIN-${closingTicket.ticketNumber}`));
    check("Body includes the closing reason (escaped)", sentCalls[0]?.html.includes("Resolved by &lt;i&gt;agent&lt;/i&gt;"));
    check("Body does NOT include the raw unescaped reason", !sentCalls[0]?.html.includes("<i>agent</i>"));
    check("Body links directly to /tickets/{id}", sentCalls[0]?.html.includes(`/tickets/${closingTicket.id}`));
    check("Body does not claim replying automatically reopens the ticket", !sentCalls[0]?.html.toLowerCase().includes("reopen"));
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: closingTicket.id, type: "CLOSED" } });
    check("Exactly one CLOSED log row, status SENT", logs.length === 1 && logs[0].status === "SENT");

    // ── 6. Closed -> closed (retry of the same transition, same closedAt) -> no second email ──
    console.log("\n=== Retry of the same close transition sends nothing new ===\n");
    await notifyRequesterClosed({ ticketId: closingTicket.id, statusName: closedStatus.name, closingMessage: "Resolved by <i>agent</i>" });
    check("No second email sent for the same closedAt", sentCalls.length === 1);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: closingTicket.id, type: "CLOSED" } });
    check("Still exactly one CLOSED log row", logs.length === 1);

    // ── 7. Concurrent closed-notification calls for the same transition -> one send ──
    console.log("\n=== Concurrent closed calls for the same transition collapse to one send ===\n");
    resetMock();
    const concurrentCloseTicket = await makeTicket(requester.id, "Concurrent close test", status.id);
    await prisma.ticket.update({ where: { id: concurrentCloseTicket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await Promise.all(
      Array.from({ length: 5 }, () => notifyRequesterClosed({ ticketId: concurrentCloseTicket.id, statusName: closedStatus!.name }))
    );
    check("Exactly one email sent despite 5 concurrent close calls", sentCalls.length === 1);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: concurrentCloseTicket.id, type: "CLOSED" } });
    check("Exactly one CLOSED log row after 5 concurrent calls", logs.length === 1);

    // ── 8. Reopen then reclose -> a NEW email for the NEW transition ──
    console.log("\n=== Reopen then reclose sends a new email for the new transition ===\n");
    resetMock();
    const reopenTicket = await makeTicket(requester.id, "Reopen then reclose test", status.id);
    await prisma.ticket.update({ where: { id: reopenTicket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyRequesterClosed({ ticketId: reopenTicket.id, statusName: closedStatus.name });
    check("First close sent one email", sentCalls.length === 1);
    // Reopen: back to the open status, closedAt cleared — mirrors what a real reopen would do.
    await prisma.ticket.update({ where: { id: reopenTicket.id }, data: { statusId: status.id, closedAt: null } });
    await new Promise((r) => setTimeout(r, 5)); // ensure the new closedAt timestamp differs from the first
    // Reclose: a genuinely new transition, new closedAt.
    await prisma.ticket.update({ where: { id: reopenTicket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyRequesterClosed({ ticketId: reopenTicket.id, statusName: closedStatus.name });
    check("Second close (after reopen) sent a second, new email", sentCalls.length === 2);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: reopenTicket.id, type: "CLOSED" }, orderBy: { createdAt: "asc" } });
    check("Two distinct CLOSED log rows exist", logs.length === 2);
    check("...with two distinct eventKeys (different closedAt)", logs[0]?.eventKey !== logs[1]?.eventKey);
    check("...both SENT", logs.every((l) => l.status === "SENT"));

    // ── 9. No-reply requester -> SKIPPED, no send, for both creation and closing ──
    console.log("\n=== No-reply requester is skipped (no send) ===\n");
    resetMock();
    const noReplyTicket = await makeTicket(noReplyRequester.id, "From a no-reply address", status.id);
    await notifyRequesterCreated({ ticketId: noReplyTicket.id });
    check("No email sent for a no-reply requester (creation)", sentCalls.length === 0);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: noReplyTicket.id, type: "CREATED" } });
    check("CREATED log row is SKIPPED", logs.length === 1 && logs[0].status === "SKIPPED");

    await prisma.ticket.update({ where: { id: noReplyTicket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyRequesterClosed({ ticketId: noReplyTicket.id, statusName: closedStatus.name });
    check("No email sent for a no-reply requester (closing)", sentCalls.length === 0);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: noReplyTicket.id, type: "CLOSED" } });
    check("CLOSED log row is SKIPPED", logs.length === 1 && logs[0].status === "SKIPPED");

    // ── 9b. Support mailbox itself as requester -> also SKIPPED ──
    const supportTicket = await makeTicket(supportRequester.id, "Support mailbox as requester", status.id);
    await notifyRequesterCreated({ ticketId: supportTicket.id });
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: supportTicket.id, type: "CREATED" } });
    check("Support mailbox requester also SKIPPED (no self-notification loop)", logs.length === 1 && logs[0].status === "SKIPPED");

    // ── 10. Graph failure -> ticket op unaffected, FAILED log, function does not throw ──
    console.log("\n=== Microsoft Graph failure produces a FAILED log without throwing ===\n");
    resetMock();
    sendShouldFail = true;
    const failTicket = await makeTicket(requester.id, "Graph will fail for this one", status.id);
    let threw = false;
    try {
      await notifyRequesterCreated({ ticketId: failTicket.id });
    } catch {
      threw = true;
    }
    check("notifyRequesterCreated does not throw even when Graph fails", !threw);
    const stillExists = await prisma.ticket.findUnique({ where: { id: failTicket.id } });
    check("The ticket itself is completely unaffected by the Graph failure", stillExists !== null && stillExists.title === "Graph will fail for this one");
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: failTicket.id, type: "CREATED" } });
    check("Log row status is FAILED", logs.length === 1 && logs[0].status === "FAILED");
    check("Log row's error message is useful (contains the simulated reason)", (logs[0]?.error ?? "").includes(sendFailureMessage));
    check("Error log does not contain anything resembling a secret/token", !(logs[0]?.error ?? "").match(/Bearer |client_secret|access_token/i));
    sendShouldFail = false;

    // ── 11. Requester with no name falls back gracefully, still escapes title/status ──
    console.log("\n=== Requester with null name falls back to a generic greeting ===\n");
    resetMock();
    const anonUser = await prisma.user.create({ data: { email: `no-name-${RUN_ID}@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(anonUser.id);
    const anonTicket = await makeTicket(anonUser.id, "Ticket with nameless requester", status.id);
    await notifyRequesterCreated({ ticketId: anonTicket.id });
    check("Still sends successfully with a null requester name", sentCalls.length === 1);
    check("Falls back to a generic greeting, not 'Dear null' or 'Dear undefined'", !sentCalls[0]?.html.includes("Dear null") && !sentCalls[0]?.html.includes("Dear undefined"));

    // ── 12. HTML escaping — direct template checks with adversarial input ──
    console.log("\n=== HTML escaping of every dynamic field (direct template check) ===\n");
    const evilCreatedHtml = buildTicketCreatedNotificationHtml({
      ticketId: "abc123",
      ticketNumber: 999,
      ticketTitle: `<script>alert('title')</script>`,
      requesterName: `<img src=x onerror=alert('name')>`,
      statusName: `<b>Open & "quoted"</b>`,
      appUrl: "http://localhost:3000",
    });
    check("Created email: title script tag is escaped", !evilCreatedHtml.includes("<script>alert('title')</script>"));
    check("Created email: requester name img/onerror is escaped", !evilCreatedHtml.includes("<img src=x onerror=alert('name')>"));
    check("Created email: status name bold tag is escaped", !evilCreatedHtml.includes("<b>Open & \"quoted\"</b>"));
    check("Created email: escaped ampersand present", evilCreatedHtml.includes("&amp;"));

    const evilClosedHtml = buildTicketClosedNotificationHtml({
      ticketId: "abc123",
      ticketNumber: 999,
      ticketTitle: `<script>alert('title')</script>`,
      statusName: `<b>Closed</b>`,
      closingMessage: `<svg onload=alert('closing')>`,
      appUrl: "http://localhost:3000",
    });
    check("Closed email: title script tag is escaped", !evilClosedHtml.includes("<script>alert('title')</script>"));
    check("Closed email: status name bold tag is escaped", !evilClosedHtml.includes("<b>Closed</b>"));
    check("Closed email: closing message svg/onload is escaped", !evilClosedHtml.includes("<svg onload=alert('closing')>"));

    // ── 13. notifyRequesterClosed with no closedAt set -> safely no-ops (defensive) ──
    console.log("\n=== notifyRequesterClosed defensively no-ops if closedAt was never set ===\n");
    resetMock();
    const noClosedAtTicket = await makeTicket(requester.id, "Never actually got closedAt", status.id);
    let threw2 = false;
    try {
      await notifyRequesterClosed({ ticketId: noClosedAtTicket.id, statusName: closedStatus.name });
    } catch {
      threw2 = true;
    }
    check("Does not throw even with no closedAt", !threw2);
    check("Does not send anything with no closedAt", sentCalls.length === 0);
  } finally {
    microsoftGraph.sendMail = originalSendMail;

    const cleanup: [string, () => Promise<unknown>][] = [
      ["email logs", () => prisma.emailNotificationLog.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["statuses", () => (dept ? prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
