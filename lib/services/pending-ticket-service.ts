import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { PendingTicketStatus } from "@prisma/client";
import type { ParsedEmail } from "@/lib/email-ticket-parser";
import { resolveDefaultStatusId, resolveDefaultPriorityId } from "@/lib/services/department-scope-service";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./public/uploads";

export type AcceptPendingTicketResult =
  | { ok: true; ticket: { id: string; ticketNumber: number; title: string } }
  | { ok: false; error: "ticket_not_found" | "already_accepted" | "already_rejected" | "invalid_department" };

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
 * Finds or creates the User a message's sender resolves to — same
 * find-or-create-by-email logic processInboundEmails always used inline,
 * extracted so both the pipeline and createTestEmailTicket share one copy.
 */
async function findOrCreateRequester(fromEmail: string, fromName: string): Promise<{ id: string }> {
  const existing = await prisma.user.findUnique({ where: { email: fromEmail }, select: { id: true } });
  if (existing) return existing;
  return prisma.user.create({
    data: { email: fromEmail, name: fromName || undefined },
    select: { id: true },
  });
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
      body: parsed.bodyHtml,
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
      const dir = path.join(UPLOAD_DIR, "pending", pendingTicketId);
      await fs.mkdir(dir, { recursive: true });

      const safe = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${Date.now()}-${safe}`;
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, Buffer.from(att.contentBytes, "base64"));

      await prisma.pendingTicketAttachment.create({
        data: {
          pendingTicketId,
          filename,
          originalName: att.name,
          mimeType: att.contentType,
          size: att.size,
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
 */
export async function acceptPendingTicket(
  pendingTicketId: string,
  acceptingUserId: string,
  overrideDepartmentId?: string | null
): Promise<AcceptPendingTicketResult> {
  const pendingTicket = await prisma.pendingTicket.findUnique({ where: { id: pendingTicketId } });
  if (!pendingTicket) return { ok: false, error: "ticket_not_found" };
  if (pendingTicket.status === PendingTicketStatus.ACCEPTED) return { ok: false, error: "already_accepted" };
  if (pendingTicket.status === PendingTicketStatus.REJECTED) return { ok: false, error: "already_rejected" };

  const departmentId = pendingTicket.departmentId ?? overrideDepartmentId ?? null;
  if (!pendingTicket.departmentId && overrideDepartmentId) {
    const dept = await prisma.department.findUnique({ where: { id: overrideDepartmentId }, select: { id: true } });
    if (!dept) return { ok: false, error: "invalid_department" };
  }
  // Status/priority are strictly department-owned now (no more global
  // fallback) — an unmatched pending ticket with no department at all
  // (and no override supplied) has nothing to resolve them against.
  if (!departmentId) return { ok: false, error: "invalid_department" };

  // The target department's own configured status/priority — see
  // resolveDefaultStatusId/resolveDefaultPriorityId in
  // department-scope-service.ts. Category has no isDefault concept (no
  // schema field for it, unlike status), so it's deliberately left unset
  // here, same as before this change — not guessed at.
  const defaultStatusId = await resolveDefaultStatusId(departmentId);
  if (!defaultStatusId) throw new Error("No default ticket status configured");
  const defaultPriorityId = await resolveDefaultPriorityId(departmentId);

  const requesterId = pendingTicket.requesterId ?? (await findOrCreateRequester(pendingTicket.fromEmail, pendingTicket.fromName ?? "")).id;

  const ticket = await prisma.ticket.create({
    data: {
      title: pendingTicket.subject || "Email Support Request",
      description: pendingTicket.body,
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

  const msg = await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      authorId: requesterId,
      body: pendingTicket.body,
      direction: "INBOUND",
      emailMessageId: pendingTicket.emailMessageId,
      fromEmail: pendingTicket.fromEmail,
      fromName: pendingTicket.fromName,
    },
    select: { id: true },
  });

  const attachments = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingTicket.id } });
  for (const att of attachments) {
    try {
      const sourcePath = path.join(UPLOAD_DIR, "pending", pendingTicket.id, att.filename);
      const destDir = path.join(UPLOAD_DIR, ticket.id);
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(destDir, att.filename);
      await fs.copyFile(sourcePath, destPath);

      await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          messageId: msg.id,
          uploadedById: requesterId,
          filename: att.filename,
          originalName: att.originalName,
          mimeType: att.mimeType,
          size: att.size,
          path: `/uploads/${ticket.id}/${att.filename}`,
        },
      });
    } catch (err) {
      console.error(`[pending-ticket] Failed to copy attachment ${att.filename} on accept:`, err);
    }
  }

  await prisma.ticketHistory.create({
    data: {
      ticketId: ticket.id,
      changedById: acceptingUserId,
      type: "CREATED",
      description: `Ticket created by accepting a pending email ticket from ${pendingTicket.fromEmail}`,
      newValue: "EMAIL",
    },
  });

  await prisma.pendingTicket.update({
    where: { id: pendingTicket.id },
    data: {
      status: PendingTicketStatus.ACCEPTED,
      acceptedById: acceptingUserId,
      acceptedAt: new Date(),
      acceptedTicketId: ticket.id,
    },
  });

  return { ok: true, ticket };
}

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
