import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { PendingTicketStatus } from "@prisma/client";
import type { ParsedEmail } from "@/lib/email-ticket-parser";
import { normalizeStoredEmailBody } from "@/lib/email-ticket-parser";
import { resolveDefaultStatusId, resolveDefaultPriorityId, isDepartmentAcceptingTickets } from "@/lib/services/department-scope-service";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
import { publishTicketListInvalidationInTransaction } from "@/lib/realtime/ticket-list-invalidation";
import { UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename, buildMigratedAttachmentFilename } from "@/lib/attachment-policy";

export type AcceptPendingTicketResult =
  | { ok: true; ticket: { id: string; ticketNumber: number; title: string } }
  | { ok: false; error: "ticket_not_found" | "already_accepted" | "invalid_department" | "department_inactive" };

export type RejectPendingTicketResult =
  | { ok: true }
  | { ok: false; error: "ticket_not_found" | "already_accepted" | "already_rejected" };

/**
 * Resolves the single Department a new pending ticket routes to, by exact
 * match of a recipient address against Department.inboundEmail. First match
 * wins if more than one recipient happens to match (never fans one email out
 * into multiple pending tickets — see the architecture plan's Decision #3).
 * Returns null if nothing matches — the pending ticket is still created,
 * just with departmentId: null (Admin/Director-only visibility).
 */
export async function matchDepartmentForRecipients(toEmails: string[]): Promise<{ id: string } | null> {
  const normalized = toEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return null;
  return prisma.department.findFirst({
    where: { inboundEmail: { in: normalized } },
    select: { id: true },
  });
}

/**
 * Finds or creates the User a message's sender resolves to. A thin
 * {id}-only wrapper around the shared resolveOrCreateRequester (see
 * requester-resolution-service.ts) — this used to be its own separate
 * implementation with no email normalization, which meant an inbound email
 * from "John.Doe@Company.com" and an already-existing "john.doe@company.com"
 * User could silently become two different rows. Sharing one
 * implementation across every "find or create a User by email" flow closes
 * that gap for good, rather than needing every call site to remember to
 * normalize itself.
 */
async function findOrCreateRequester(fromEmail: string, fromName: string): Promise<{ id: string }> {
  const requester = await resolveOrCreateRequester(fromEmail, fromName || undefined);
  return { id: requester.id };
}

/**
 * Creates a PendingTicket (never a real Ticket) from a freshly parsed
 * inbound email — the replacement for the old direct-to-Ticket
 * createTicketFromEmail path for any message that isn't a reply to an
 * already-accepted ticket. Attachments are saved under a `pending/` subtree
 * so they never collide with a real Ticket's own upload directory naming.
 */
export async function createPendingTicketFromEmail(
  parsed: ParsedEmail,
  department: { id: string } | null
): Promise<{ id: string }> {
  const requester = await findOrCreateRequester(parsed.fromEmail, parsed.fromName);

  const pendingTicket = await prisma.pendingTicket.create({
    data: {
      emailMessageId: parsed.messageId,
      emailThreadId: parsed.conversationId,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName || null,
      subject: parsed.subject || "Email Support Request",
      // The normalized, readable representation — never parsed.bodyHtml
      // (raw markup). See ParsedEmail.bodyText's doc comment in
      // lib/email-ticket-parser.ts (BUG 1 fix): this is what
      // acceptPendingTicket later copies verbatim into Ticket.description
      // and the initial TicketMessage.body, so normalizing it once, here,
      // at the single point every pending ticket is created from, is
      // enough — no downstream re-cleaning needed.
      body: parsed.bodyText,
      receivedAt: parsed.receivedAt,
      departmentId: department?.id ?? null,
      requesterId: requester.id,
    },
    select: { id: true },
  });

  await savePendingAttachments(parsed.attachments, pendingTicket.id);

  return pendingTicket;
}

async function savePendingAttachments(
  attachments: Array<{ name: string; contentType: string; size: number; contentBytes: string }>,
  pendingTicketId: string
) {
  for (const att of attachments) {
    try {
      // Same policy the WEB upload route has always enforced (type
      // allowlist + size cap) — an inbound email is untrusted input exactly
      // like a browser upload, so it gets no free pass on either check
      // (BUG 2 / SECURITY fix — this path previously had no such check at
      // all). MIME type is still whatever the sender's mail client claimed
      // (Graph doesn't sniff it either) — that's a real, inherent
      // difference from the web upload path, where the browser itself
      // reports `file.type`; both are equally "client-claimed," so this is
      // not a weaker guarantee, just the same one applied to a different
      // client.
      if (!isAllowedAttachmentMimeType(att.contentType)) {
        console.warn(`[pending-ticket] Skipping attachment ${att.name} — disallowed MIME type ${att.contentType}`);
        continue;
      }

      const bytes = Buffer.from(att.contentBytes, "base64");
      // The actual decoded byte length, not the sender-reported `size`
      // metadata field — never trust that a claimed size matches reality.
      if (bytes.length > MAX_ATTACHMENT_SIZE_BYTES) {
        console.warn(`[pending-ticket] Skipping attachment ${att.name} — ${bytes.length} bytes exceeds the ${MAX_ATTACHMENT_SIZE_BYTES}-byte cap`);
        continue;
      }

      const dir = path.join(UPLOAD_DIR, "pending", pendingTicketId);
      await fs.mkdir(dir, { recursive: true });

      const filename = generateStoredFilename(att.name);
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, bytes);

      await prisma.pendingTicketAttachment.create({
        data: {
          pendingTicketId,
          filename,
          originalName: att.name,
          mimeType: att.contentType,
          size: bytes.length,
          path: `/uploads/pending/${pendingTicketId}/${filename}`,
        },
      });
    } catch (err) {
      console.error(`[pending-ticket] Failed to save attachment ${att.name}:`, err);
    }
  }
}

/**
 * Accepts a PendingTicket, creating a real Ticket from it — the only path
 * that ever produces a Ticket from this flow. Mirrors exactly the same
 * TicketMessage/TicketAttachment/TicketHistory shape the old
 * createTicketFromEmail wrote, just relocated here and fed from the pending
 * row instead of a fresh ParsedEmail. `overrideDepartmentId` lets an
 * Admin/Director pick a department for an unmatched (departmentId: null)
 * pending ticket at accept time; ignored if the pending ticket already has
 * one (that department already "won" at receipt time).
 *
 * Callable from BOTH lifecycle starting points:
 *   PENDING  -> ACCEPTED (+ Ticket)   — the original Pending-review flow.
 *   REJECTED -> ACCEPTED (+ Ticket)   — the "Create Ticket" recovery flow
 *     from /tickets/rejected: a reviewer changes their mind about a
 *     previously-rejected request. This is a single, direct, intentional
 *     transition — never REJECTED -> PENDING -> ACCEPTED through two
 *     separate calls, which could leave an inconsistent intermediate state
 *     visible to a concurrent reader.
 * Only ACCEPTED is a genuine terminal state here: an already-ACCEPTED
 * record (whichever path it arrived from) can never produce a second
 * Ticket — see the idempotency notes below.
 */
export async function acceptPendingTicket(
  pendingTicketId: string,
  acceptingUserId: string,
  overrideDepartmentId?: string | null
): Promise<AcceptPendingTicketResult> {
  const pendingTicket = await prisma.pendingTicket.findUnique({ where: { id: pendingTicketId } });
  if (!pendingTicket) return { ok: false, error: "ticket_not_found" };
  if (pendingTicket.status === PendingTicketStatus.ACCEPTED) return { ok: false, error: "already_accepted" };

  const departmentId = pendingTicket.departmentId ?? overrideDepartmentId ?? null;
  if (!pendingTicket.departmentId && overrideDepartmentId) {
    const dept = await prisma.department.findUnique({ where: { id: overrideDepartmentId }, select: { id: true } });
    if (!dept) return { ok: false, error: "invalid_department" };
  }
  // Status/priority are strictly department-owned now (no more global
  // fallback) — an unmatched pending ticket with no department at all
  // (and no override supplied) has nothing to resolve them against.
  if (!departmentId) return { ok: false, error: "invalid_department" };

  // Same shared gate WEB and integration ticket creation both go through —
  // Accept is EMAIL's actual "new ticket intake" moment (the PendingTicket
  // itself already existed as a review-queue row; it isn't yet a real
  // Ticket), so this is the correct point to enforce it, not at the
  // earlier inbound-email/PendingTicket-creation step. The PendingTicket
  // itself is left untouched (still PENDING) so a reviewer can still see
  // it and, once the department is reactivated, accept it normally.
  if (!(await isDepartmentAcceptingTickets(departmentId))) {
    return { ok: false, error: "department_inactive" };
  }

  // The target department's own configured status/priority — see
  // resolveDefaultStatusId/resolveDefaultPriorityId in
  // department-scope-service.ts. Category has no isDefault concept (no
  // schema field for it, unlike status), so it's deliberately left unset
  // here, same as before this change — not guessed at.
  const defaultStatusId = await resolveDefaultStatusId(departmentId);
  if (!defaultStatusId) throw new Error("No default ticket status configured");
  const defaultPriorityId = await resolveDefaultPriorityId(departmentId);

  const requesterId = pendingTicket.requesterId ?? (await findOrCreateRequester(pendingTicket.fromEmail, pendingTicket.fromName ?? "")).id;

  // GAP 1 / defense-in-depth: PendingTicket.body is normalized again HERE,
  // right before it becomes canonical Ticket data — never trusted as
  // already-clean just because createPendingTicketFromEmail normalizes at
  // ingestion time. This is what makes accepting a PendingTicket row that
  // was created BEFORE that ingestion-time fix (and so still holds raw
  // Outlook/Word HTML in its body) safe: normalizeStoredEmailBody handles
  // "already clean" and "still raw HTML" identically safely — see its own
  // doc comment in lib/email-ticket-parser.ts.
  const normalizedBody = normalizeStoredEmailBody(pendingTicket.body);

  // Ticket + its initial message + history + the PendingTicket's own
  // ACCEPTED transition all commit together or not at all — closes the gap
  // where a process crash/DB error between separate sequential writes could
  // leave a real Ticket that the PendingTicket never got marked as
  // producing (or vice versa). The actual anti-duplication guarantee is
  // Ticket.emailMessageId's DB-level `@unique` constraint (see
  // prisma/schema.prisma) — this transaction makes the SUCCESS path atomic;
  // that constraint makes the CONCURRENCY path safe (caught below).
  let ticket: { id: string; ticketNumber: number; title: string };
  try {
    const created = await prisma.$transaction(async (tx) => {
      const newTicket = await tx.ticket.create({
        data: {
          title: pendingTicket.subject || "Email Support Request",
          description: normalizedBody,
          source: "EMAIL",
          requesterId,
          departmentId,
          statusId: defaultStatusId,
          priorityId: defaultPriorityId,
          emailMessageId: pendingTicket.emailMessageId,
          emailThreadId: pendingTicket.emailThreadId,
        },
        select: { id: true, ticketNumber: true, title: true },
      });

      const msg = await tx.ticketMessage.create({
        data: {
          ticketId: newTicket.id,
          authorId: requesterId,
          body: normalizedBody,
          direction: "INBOUND",
          emailMessageId: pendingTicket.emailMessageId,
          fromEmail: pendingTicket.fromEmail,
          fromName: pendingTicket.fromName,
        },
        select: { id: true },
      });

      await tx.ticketHistory.create({
        data: {
          ticketId: newTicket.id,
          changedById: acceptingUserId,
          type: "CREATED",
          description: `Ticket created by accepting a pending email ticket from ${pendingTicket.fromEmail}`,
          newValue: "EMAIL",
        },
      });

      // Re-checked INSIDE the transaction (not just at function entry
      // above) so two concurrent callers that both read PENDING/REJECTED
      // before either wrote anything cannot both reach this update: the
      // loser's WHERE clause (status still PENDING/REJECTED, never
      // ACCEPTED) will already have been flipped by the winner by the time
      // its own transaction's write is attempted, causing Prisma to report
      // 0 rows updated — checked explicitly below via `updateMany`'s count,
      // since `update` would instead throw P2025 on a WHERE miss, which is
      // a valid alternative but count-based logic reads more directly here.
      const updateResult = await tx.pendingTicket.updateMany({
        where: { id: pendingTicket.id, status: pendingTicket.status },
        data: {
          status: PendingTicketStatus.ACCEPTED,
          acceptedById: acceptingUserId,
          acceptedAt: new Date(),
          acceptedTicketId: newTicket.id,
        },
      });
      if (updateResult.count === 0) {
        // Someone else already transitioned this PendingTicket between our
        // initial read and this write — abort the whole transaction (the
        // Ticket we just created inside it is rolled back with everything
        // else) rather than leaving an orphaned duplicate.
        throw new AlreadyProcessedError();
      }

      // EMAIL's actual "new ticket intake" moment — see this function's own
      // header comment. Published from inside the transaction, so it can
      // never fire for a ticket that ends up rolled back by the
      // AlreadyProcessedError race guard above.
      await publishTicketListInvalidationInTransaction(tx);

      return newTicket;
    });
    ticket = created;
  } catch (err) {
    if (err instanceof AlreadyProcessedError) {
      return { ok: false, error: "already_accepted" };
    }
    // A concurrent request's transaction committed first and already holds
    // the unique emailMessageId — this request's own ticket.create lost the
    // race at the DB level (belt-and-suspenders alongside the in-transaction
    // updateMany guard above, which normally catches this first since it
    // reads the SAME row both requests started from).
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      return { ok: false, error: "already_accepted" };
    }
    throw err;
  }

  // Attachment file copying is best-effort and stays OUTSIDE the
  // transaction (filesystem writes aren't part of a Prisma transaction,
  // and a copy failure here was already non-fatal to Ticket creation
  // before this change — each attachment is independently try/caught and
  // logged, never rolls back the Ticket that was just durably committed).
  const attachments = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingTicket.id } });
  // Idempotency guard (BUG 2 fix, consistency requirement) — identity-based
  // (GAP 3 fix), not filename-based. There is no known way to reach
  // acceptPendingTicket a second time for an already-ACCEPTED record today
  // (see the early `already_accepted` return above and the in-transaction
  // race guard), but a future repair/retry path might, so this loop is kept
  // safe to re-run on its own. The destination filename for a migrated
  // attachment is ALWAYS buildMigratedAttachmentFilename(att.id, ...) below
  // — deterministic and unique per source PendingTicketAttachment row — so
  // checking for that exact filename is checking "has THIS pending
  // attachment specifically already been migrated," not "does some
  // TicketAttachment happen to share a name." Two PendingTicketAttachment
  // rows with the same originalName (a real, legitimate case — one email,
  // two identically-named MIME parts) get two different att.id values and
  // therefore two different destination filenames, so neither is ever
  // mistaken for the other, before or after a retry.
  const existingFilenames = new Set(
    (await prisma.ticketAttachment.findMany({ where: { ticketId: ticket.id }, select: { filename: true } })).map((a) => a.filename)
  );
  for (const att of attachments) {
    const destFilename = buildMigratedAttachmentFilename(att.id, att.originalName);
    if (existingFilenames.has(destFilename)) continue;
    try {
      const sourcePath = path.join(UPLOAD_DIR, "pending", pendingTicket.id, att.filename);
      const destDir = path.join(UPLOAD_DIR, ticket.id);
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, destFilename);
      await fs.copyFile(sourcePath, destPath);

      await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          // Ticket-level (messageId: null), NOT tied to the initial email
          // message — BUG 2's actual root cause. This is what makes a
          // migrated attachment behave exactly like one uploaded through
          // the normal web ticket-creation flow (app/api/tickets/[id]/
          // attachments/route.ts also writes messageId: null for a fresh
          // ticket's own attachments): the ticket detail page's
          // "Attachments" panel only ever queries
          // `attachments: { where: { messageId: null } }` (see
          // app/(main)/tickets/[id]/page.tsx). Attaching it to the initial
          // TicketMessage instead — the previous behavior — silently
          // excluded it from that panel: the file and its TicketAttachment
          // row both existed, but nothing in the normal Ticket UI ever
          // surfaced them (confirmed via a direct reproduction — see this
          // change's PR/commit description).
          messageId: null,
          uploadedById: requesterId,
          filename: destFilename,
          originalName: att.originalName,
          mimeType: att.mimeType,
          size: att.size,
          path: `/uploads/${ticket.id}/${destFilename}`,
        },
      });
    } catch (err) {
      console.error(`[pending-ticket] Failed to copy attachment ${att.filename} on accept:`, err);
    }
  }

  // Notifying the requester is the caller's job (app/api/tickets/pending/
  // [id]/accept/route.ts schedules it via next/server's after()) — this
  // function stays framework-context-agnostic on purpose: it's also called
  // directly from scripts/test-pending-ticket-accept-reject.ts outside any
  // Next.js request scope, where after() would throw.
  return { ok: true, ticket };
}

/** Internal sentinel — thrown (never exported) to abort the accept transaction when a concurrent request already won the race; caught immediately in acceptPendingTicket and translated to `{ ok: false, error: "already_accepted" }`. */
class AlreadyProcessedError extends Error {}

/**
 * Rejects a PendingTicket — soft, kept for audit, never produces a Ticket.
 */
export async function rejectPendingTicket(pendingTicketId: string, rejectingUserId: string): Promise<RejectPendingTicketResult> {
  const pendingTicket = await prisma.pendingTicket.findUnique({
    where: { id: pendingTicketId },
    select: { id: true, status: true },
  });
  if (!pendingTicket) return { ok: false, error: "ticket_not_found" };
  if (pendingTicket.status === PendingTicketStatus.ACCEPTED) return { ok: false, error: "already_accepted" };
  if (pendingTicket.status === PendingTicketStatus.REJECTED) return { ok: false, error: "already_rejected" };

  await prisma.pendingTicket.update({
    where: { id: pendingTicketId },
    data: { status: PendingTicketStatus.REJECTED, rejectedById: rejectingUserId, rejectedAt: new Date() },
  });

  return { ok: true };
}
