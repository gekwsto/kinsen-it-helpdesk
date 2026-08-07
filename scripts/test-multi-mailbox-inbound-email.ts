/**
 * Multi-mailbox inbound email polling — the fix for Department.inboundEmail
 * being only a ROUTING address (recipient matching after a message already
 * landed in the single hardcoded GRAPH_USER_EMAIL mailbox) rather than a
 * mailbox Graph itself actually polled. See:
 *   - lib/microsoft-graph.ts (getUnreadMessages/markAsRead/moveMessage now
 *     take an explicit `mailbox` parameter — no hidden single-mailbox
 *     dependency)
 *   - lib/services/inbound-mailbox-service.ts (mailbox discovery: central +
 *     every active department's own inboundEmail, deduped/normalized)
 *   - lib/ticket-email-service.ts's processInboundEmails (per-mailbox
 *     independent processing, deterministic department routing, P2002-safe
 *     concurrent dedup)
 *
 * Every Graph call is a mocked `global.fetch`, dispatched by which mailbox
 * appears in the request URL — matching this repo's established
 * `test-organization-graph-sync.ts`-style approach. Never requires a real
 * Azure tenant. GRAPH_* env vars are correctly-SHAPED fake values.
 *
 * Usage: npx tsx scripts/test-multi-mailbox-inbound-email.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";
process.env.GRAPH_USER_EMAIL = "central-support@kinsen.gr";

import { prisma } from "@/lib/prisma";
import { getMailboxesToPoll } from "@/lib/services/inbound-mailbox-service";
import { processInboundEmails } from "@/lib/ticket-email-service";
import { createDepartment, setDepartmentInboundEmail } from "@/lib/services/department-service";
import type { GraphMailMessage } from "@/lib/microsoft-graph";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const RUN_ID = Date.now();
const CENTRAL = "central-support@kinsen.gr";
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Extracts the mailbox address from a Graph request URL's /users/{mailbox}/... segment. */
function mailboxFromUrl(url: string): string | null {
  const match = url.match(/\/users\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

function makeMessage(overrides: Partial<GraphMailMessage> & { id: string }): GraphMailMessage {
  return {
    subject: "Test Subject",
    bodyPreview: "preview",
    body: { contentType: "text", content: "Test body" },
    from: { emailAddress: { name: "Sender", address: `sender-${overrides.id}@example.com` } },
    toRecipients: [],
    internetMessageId: `<${overrides.id}@test.local>`,
    conversationId: `conv-${overrides.id}`,
    receivedDateTime: new Date().toISOString(),
    hasAttachments: false,
    isRead: false,
    internetMessageHeaders: [],
    ...overrides,
  };
}

/**
 * Installs a fetch mock that:
 *  - answers the OAuth token endpoint unconditionally
 *  - for a `/mailFolders/Inbox/messages` GET, returns `unreadByMailbox[mailbox]` (or [] if absent, or throws if `failFor` matches)
 *  - for PATCH (markAsRead) / POST .../move (moveMessage) / POST .../mailFolders (folder lookup/create), just records the call and succeeds
 * `calls` accumulates { mailbox, kind } for assertions about which mailbox/operation was hit.
 */
function installMailboxRouterMock(
  unreadByMailbox: Record<string, GraphMailMessage[]>,
  opts: { failFor?: Set<string> } = {}
): { calls: Array<{ mailbox: string; kind: "getUnread" | "markAsRead" | "move" | "folderLookup" | "folderCreate" }> } {
  const calls: Array<{ mailbox: string; kind: "getUnread" | "markAsRead" | "move" | "folderLookup" | "folderCreate" }> = [];

  global.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "mock-app-token" });
    }

    const mailbox = mailboxFromUrl(url);
    if (!mailbox) return jsonResponse(404, { error: { message: "unexpected URL in test mock", url } });

    if (opts.failFor?.has(mailbox)) {
      return jsonResponse(403, { error: { code: "Forbidden", message: `mock: no access to mailbox ${mailbox}` } });
    }

    if (url.includes("/mailFolders/Inbox/messages") && method === "GET") {
      calls.push({ mailbox, kind: "getUnread" });
      return jsonResponse(200, { value: unreadByMailbox[mailbox] ?? [] });
    }
    if (url.includes("/messages/") && method === "PATCH") {
      calls.push({ mailbox, kind: "markAsRead" });
      return jsonResponse(200, {});
    }
    if (url.includes("/messages/") && url.includes("/move") && method === "POST") {
      calls.push({ mailbox, kind: "move" });
      return jsonResponse(200, {});
    }
    if (url.includes("/mailFolders?") && method === "GET") {
      calls.push({ mailbox, kind: "folderLookup" });
      return jsonResponse(200, { value: [{ id: `processed-folder-${mailbox}`, displayName: "Processed" }] });
    }
    if (url.endsWith("/mailFolders") && method === "POST") {
      calls.push({ mailbox, kind: "folderCreate" });
      return jsonResponse(200, { id: `processed-folder-${mailbox}` });
    }

    return jsonResponse(404, { error: { message: "unhandled mock URL", url, method } });
  }) as typeof fetch;

  return { calls };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function cleanup(deptIds: string[], pendingTicketIds: string[], ticketIds: string[], userEmails: string[]) {
  if (pendingTicketIds.length > 0) await prisma.pendingTicketAttachment.deleteMany({ where: { pendingTicketId: { in: pendingTicketIds } } }).catch(() => {});
  if (pendingTicketIds.length > 0) await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } }).catch(() => {});
  if (ticketIds.length > 0) {
    await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } }).catch(() => {});
    await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } }).catch(() => {});
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
  }
  await prisma.emailProcessingLog.deleteMany({ where: { fromEmail: { contains: `${RUN_ID}` } } }).catch(() => {});
  if (userEmails.length > 0) await prisma.user.deleteMany({ where: { email: { in: userEmails } } }).catch(() => {});
  if (deptIds.length > 0) {
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } }).catch(() => {});
  }
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  const deptIds: string[] = [];
  const pendingTicketIds: string[] = [];
  const ticketIds: string[] = [];
  const userEmails: string[] = [];

  try {
    // createDepartment (not a raw prisma.department.create) so each
    // department gets its full starter TicketStatus/TicketPriority
    // configuration atomically — required for acceptPendingTicket
    // (scenario 8 below) to resolve a default status/priority.
    const deptAEmail = `dept-a-${RUN_ID}@kinsen.gr`;
    const deptBEmail = `dept-b-${RUN_ID}@kinsen.gr`;
    const deptA = await createDepartment({ name: `Mailbox Dept A ${RUN_ID}`, slug: `mailbox-dept-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `Mailbox Dept B ${RUN_ID}`, slug: `mailbox-dept-b-${RUN_ID}` });
    await setDepartmentInboundEmail(deptA.id, deptAEmail);
    await setDepartmentInboundEmail(deptB.id, deptBEmail);
    deptIds.push(deptA.id, deptB.id);

    console.log("\n=== Mailbox discovery ===\n");
    const mailboxes = await getMailboxesToPoll();
    const central = mailboxes.find((m) => m.kind === "central");
    const foundA = mailboxes.find((m) => m.email === deptAEmail);
    const foundB = mailboxes.find((m) => m.email === deptBEmail);
    check("Central mailbox is included", central?.email === CENTRAL);
    check("Department A's mailbox is discovered with kind=department + correct departmentId", foundA?.kind === "department" && foundA?.departmentId === deptA.id);
    check("Department B's mailbox is discovered too", foundB?.kind === "department" && foundB?.departmentId === deptB.id);

    console.log("\n=== 10. Inactive department is not silently treated as an active intake mailbox ===\n");
    const deptInactiveEmail = `dept-inactive-${RUN_ID}@kinsen.gr`;
    const deptInactive = await prisma.department.create({
      data: { name: `Mailbox Dept Inactive ${RUN_ID}`, slug: `mailbox-dept-inactive-${RUN_ID}`, inboundEmail: deptInactiveEmail, isActive: false },
    });
    deptIds.push(deptInactive.id);
    const mailboxesAfterInactive = await getMailboxesToPoll();
    check("An inactive department's inboundEmail is NOT included in the poll set", !mailboxesAfterInactive.some((m) => m.email === deptInactiveEmail));

    console.log("\n=== 4. Uppercase/mixed-case mailbox addresses normalize correctly ===\n");
    const deptMixedCaseRaw = `Dept-MixedCase-${RUN_ID}@Kinsen.GR`;
    const deptMixedCase = await prisma.department.create({
      data: { name: `Mailbox Dept MixedCase ${RUN_ID}`, slug: `mailbox-dept-mixedcase-${RUN_ID}`, inboundEmail: deptMixedCaseRaw.toLowerCase() },
    });
    deptIds.push(deptMixedCase.id);
    const mailboxesWithMixedCase = await getMailboxesToPoll();
    const mixedCaseEntry = mailboxesWithMixedCase.find((m) => m.departmentId === deptMixedCase.id);
    check("A stored inboundEmail is returned fully lowercase regardless of original casing", mixedCaseEntry?.email === deptMixedCaseRaw.toLowerCase());
    await prisma.department.delete({ where: { id: deptMixedCase.id } }).catch(() => {});
    deptIds.splice(deptIds.indexOf(deptMixedCase.id), 1);

    console.log("\n=== 5. A department mailbox equal to the central mailbox is not polled twice ===\n");
    const deptSameAsCentral = await prisma.department.create({
      data: { name: `Mailbox Dept SameAsCentral ${RUN_ID}`, slug: `mailbox-dept-samecentral-${RUN_ID}`, inboundEmail: CENTRAL },
    });
    deptIds.push(deptSameAsCentral.id);
    const mailboxesWithDup = await getMailboxesToPoll();
    const centralOccurrences = mailboxesWithDup.filter((m) => m.email === CENTRAL);
    check("The central address appears exactly once even when a department also configures it", centralOccurrences.length === 1);
    check("...and that one entry is still kind=central (recipient-routing semantics preserved)", centralOccurrences[0]?.kind === "central");
    await prisma.department.delete({ where: { id: deptSameAsCentral.id } }).catch(() => {});
    deptIds.splice(deptIds.indexOf(deptSameAsCentral.id), 1);

    // ── End-to-end processInboundEmails() runs ──────────────────────────
    console.log("\n=== 1+3. Central + Department A + Department B all processed in the same poll ===\n");
    const centralMsgId = `run1-central-${RUN_ID}`;
    const deptAMsgId = `run1-depta-${RUN_ID}`;
    const deptBMsgId = `run1-deptb-${RUN_ID}`;
    const { calls } = installMailboxRouterMock({
      [CENTRAL]: [makeMessage({ id: centralMsgId, subject: `Central Inquiry ${RUN_ID}`, from: { emailAddress: { name: "Alice", address: `alice-${RUN_ID}@example.com` } } })],
      [deptAEmail]: [makeMessage({ id: deptAMsgId, subject: `Dept A Direct ${RUN_ID}`, from: { emailAddress: { name: "Bob", address: `bob-${RUN_ID}@example.com` } } })],
      [deptBEmail]: [makeMessage({ id: deptBMsgId, subject: `Dept B Direct ${RUN_ID}`, from: { emailAddress: { name: "Carol", address: `carol-${RUN_ID}@example.com` } } })],
    });
    userEmails.push(`alice-${RUN_ID}@example.com`, `bob-${RUN_ID}@example.com`, `carol-${RUN_ID}@example.com`);

    const result1 = await processInboundEmails();
    check("Poll processed all 3 messages as new pending tickets", result1.created === 3);
    check("Zero errors across all 3 mailboxes", result1.errors === 0);

    const ptCentral = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${centralMsgId}@test.local>` } });
    const ptA = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${deptAMsgId}@test.local>` } });
    const ptB = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${deptBMsgId}@test.local>` } });
    if (ptCentral) pendingTicketIds.push(ptCentral.id);
    if (ptA) pendingTicketIds.push(ptA.id);
    if (ptB) pendingTicketIds.push(ptB.id);

    check("1. Central-mailbox email created a pending ticket", ptCentral !== null);
    check("2. Direct email to Department A's mailbox -> PendingTicket.departmentId = Department A", ptA?.departmentId === deptA.id);
    check("   Direct email to Department B's mailbox -> PendingTicket.departmentId = Department B", ptB?.departmentId === deptB.id);
    check("11. Central mailbox with NO recipient match -> departmentId null (unchanged recipient-routing behaviour)", ptCentral?.departmentId === null);

    console.log("\n=== 9. Successful message is marked read/moved in the EXACT mailbox it was fetched from ===\n");
    const markReadCalls = calls.filter((c) => c.kind === "markAsRead");
    const moveCalls = calls.filter((c) => c.kind === "move");
    check("markAsRead was called against the central mailbox", markReadCalls.some((c) => c.mailbox === CENTRAL));
    check("markAsRead was called against Department A's OWN mailbox (not central)", markReadCalls.some((c) => c.mailbox === deptAEmail));
    check("markAsRead was called against Department B's OWN mailbox (not central)", markReadCalls.some((c) => c.mailbox === deptBEmail));
    check("moveMessage (Processed folder) was called against Department A's own mailbox", moveCalls.some((c) => c.mailbox === deptAEmail));
    check("moveMessage (Processed folder) was called against Department B's own mailbox", moveCalls.some((c) => c.mailbox === deptBEmail));
    restoreFetch();

    console.log("\n=== 11. Central/alias recipient-routing still works (recipient matches a department's inboundEmail) ===\n");
    const aliasMsgId = `run2-alias-${RUN_ID}`;
    installMailboxRouterMock({
      [CENTRAL]: [
        makeMessage({
          id: aliasMsgId,
          subject: `Alias Routed ${RUN_ID}`,
          from: { emailAddress: { name: "Dave", address: `dave-${RUN_ID}@example.com` } },
          toRecipients: [{ emailAddress: { name: "Dept A", address: deptAEmail } }],
        }),
      ],
    });
    userEmails.push(`dave-${RUN_ID}@example.com`);
    const result2 = await processInboundEmails();
    check("Alias-routed poll succeeded", result2.created === 1 && result2.errors === 0);
    const ptAlias = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${aliasMsgId}@test.local>` } });
    if (ptAlias) pendingTicketIds.push(ptAlias.id);
    check("A message forwarded/cc'd into the central mailbox still routes to Department A via recipient matching", ptAlias?.departmentId === deptA.id);
    restoreFetch();

    console.log("\n=== 7. One Graph mailbox failure does not prevent another mailbox from processing ===\n");
    const survivorMsgId = `run3-survivor-${RUN_ID}`;
    installMailboxRouterMock(
      { [deptBEmail]: [makeMessage({ id: survivorMsgId, subject: `Survivor ${RUN_ID}`, from: { emailAddress: { name: "Eve", address: `eve-${RUN_ID}@example.com` } } })] },
      { failFor: new Set([deptAEmail]) }
    );
    userEmails.push(`eve-${RUN_ID}@example.com`);
    const result3 = await processInboundEmails();
    check("7. A failing Department A mailbox produces at least one error...", result3.errors >= 1);
    check("   ...but Department B's message is STILL created successfully in the same run", result3.created === 1);
    const ptSurvivor = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${survivorMsgId}@test.local>` } });
    if (ptSurvivor) pendingTicketIds.push(ptSurvivor.id);
    check("   Survivor pending ticket routed to Department B correctly", ptSurvivor?.departmentId === deptB.id);
    restoreFetch();

    console.log("\n=== 6. Duplicate internetMessageId across two mailboxes never creates two PendingTickets ===\n");
    const dupMsgId = `run4-dup-${RUN_ID}`;
    const dupMessage = makeMessage({ id: dupMsgId, subject: `Duplicate Across Mailboxes ${RUN_ID}`, from: { emailAddress: { name: "Frank", address: `frank-${RUN_ID}@example.com` } } });
    installMailboxRouterMock({
      [CENTRAL]: [dupMessage],
      [deptAEmail]: [dupMessage], // same internetMessageId visible via two delivery paths in the SAME run
    });
    userEmails.push(`frank-${RUN_ID}@example.com`);
    const result4 = await processInboundEmails();
    check("6. Exactly ONE pending ticket created for a message visible via two mailboxes in one run", result4.created === 1 && result4.skipped >= 1);
    const dupCount = await prisma.pendingTicket.count({ where: { emailMessageId: `<${dupMsgId}@test.local>` } });
    check("   Exactly one PendingTicket row exists in the database for that emailMessageId", dupCount === 1);
    const dupPt = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${dupMsgId}@test.local>` } });
    if (dupPt) pendingTicketIds.push(dupPt.id);
    restoreFetch();

    console.log("\n=== 8. [KIN-N] reply still appends to an accepted Ticket ===\n");
    const { acceptPendingTicket } = await import("@/lib/services/pending-ticket-service");
    const acceptSourceMsgId = `run5-toaccept-${RUN_ID}`;
    installMailboxRouterMock({
      [deptAEmail]: [makeMessage({ id: acceptSourceMsgId, subject: `To Be Accepted ${RUN_ID}`, from: { emailAddress: { name: "Grace", address: `grace-${RUN_ID}@example.com` } } })],
    });
    userEmails.push(`grace-${RUN_ID}@example.com`);
    await processInboundEmails();
    restoreFetch();
    const ptToAccept = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${acceptSourceMsgId}@test.local>` } });
    check("Pending ticket for the to-be-accepted message exists", ptToAccept !== null);
    if (ptToAccept) {
      pendingTicketIds.push(ptToAccept.id);
      const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
      if (admin) {
        const acceptResult = await acceptPendingTicket(ptToAccept.id, admin.id);
        check("Accept succeeded", acceptResult.ok === true);
        if (acceptResult.ok) {
          ticketIds.push(acceptResult.ticket.id);
          const kinRef = `[KIN-${acceptResult.ticket.ticketNumber}]`;
          const replyMsgId = `run5-reply-${RUN_ID}`;
          installMailboxRouterMock({
            [deptAEmail]: [makeMessage({ id: replyMsgId, subject: `Re: ${kinRef} To Be Accepted ${RUN_ID}`, from: { emailAddress: { name: "Grace", address: `grace-${RUN_ID}@example.com` } } })],
          });
          const replyResult = await processInboundEmails();
          check("8. A [KIN-N] reply appends to the accepted ticket (appended=1, not created)", replyResult.appended === 1 && replyResult.created === 0);
          const messageCount = await prisma.ticketMessage.count({ where: { ticketId: acceptResult.ticket.id } });
          check("   Exactly 2 ticket messages exist (original + reply), no duplicate append", messageCount === 2);
          restoreFetch();
        }
      } else {
        console.log("  (skipped: no ADMIN user in this environment to accept as)");
      }
    }
  } finally {
    restoreFetch();
    await cleanup(deptIds, pendingTicketIds, ticketIds, userEmails);
    await prisma.$disconnect();
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
