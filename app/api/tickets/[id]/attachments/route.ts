import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canViewAllTickets } from "@/lib/permissions";
import path from "path";
import fs from "fs/promises";
import { UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename } from "@/lib/attachment-policy";
import { writeAttachmentFile } from "@/lib/attachment-storage-service";
import { publishTicketListInvalidation } from "@/lib/realtime/ticket-list-invalidation";

/**
 * Writes via writeAttachmentFile (lib/attachment-storage-service.ts) —
 * shared by every attachment write path in the app — which verifies
 * UPLOAD_DIR is a genuinely durable mount before ever touching the
 * filesystem, and atomically publishes (never overwrites) once written
 * bytes are confirmed to read back identical. Returns the storage
 * service's own statusCode (503 if storage isn't currently verified as
 * durable, 409 on a destination collision, 500 on a write/verify
 * failure) rather than a bare 500 for every failure mode.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canUpload =
      canViewAllTickets(session.user.role) ||
      ticket.requesterId === session.user.id;

    if (!canUpload) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const messageId = formData.get("messageId") as string | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    if (!isAllowedAttachmentMimeType(file.type)) {
      return NextResponse.json({ error: "File type not allowed" }, { status: 400 });
    }

    const dir = path.join(UPLOAD_DIR, id);
    const filename = generateStoredFilename(file.name);
    const buffer = Buffer.from(await file.arrayBuffer());

    const writeResult = await writeAttachmentFile(buffer, dir, filename);
    if (!writeResult.ok) {
      console.error("Upload error:", writeResult.reason);
      return NextResponse.json({ error: writeResult.reason }, { status: writeResult.statusCode });
    }

    let attachment;
    try {
      attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: id,
          messageId: messageId ?? null,
          uploadedById: session.user.id,
          filename,
          originalName: file.name,
          mimeType: file.type,
          size: writeResult.size,
          // No longer a working static URL now that UPLOAD_DIR is private
          // (see lib/attachment-policy.ts) — kept in this same shape purely
          // for data-shape/audit continuity. The real, authenticated download
          // path is GET /api/tickets/[id]/attachments/[attachmentId], which
          // never reads this field (it reconstructs the file location from
          // UPLOAD_DIR + ticketId + filename instead).
          path: `/uploads/${id}/${filename}`,
        },
        include: {
          uploadedBy: { select: { id: true, name: true } },
        },
      });
    } catch (dbErr) {
      // Compensation: the file above was JUST published, in THIS SAME
      // request, at this EXACT path this handler itself computed — never
      // any pre-existing attachment. The DB row that would reference it
      // never committed, so removing it leaves no dangling reference and
      // no pre-existing file is ever touched.
      await fs.unlink(path.join(dir, filename)).catch(() => {});
      throw dbErr;
    }

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: "ATTACHMENT_ADDED",
        description: `Attachment "${file.name}" uploaded by ${session.user.name}`,
        newValue: file.name,
      },
    });

    // The Ticket list's own row displays this ticket's attachment count as
    // a badge (components/tickets/ticket-table.tsx's `_count.attachments`)
    // — a successful upload changes that badge, so every open list must be
    // invalidated the same way a status/priority/assignee change already
    // is (see lib/realtime/publisher.ts's publishTicketEvent, which this
    // mirrors; a bare list-invalidation is used here instead since there is
    // no per-ticket-detail-stream event type for "attachment added").
    publishTicketListInvalidation();

    return NextResponse.json(attachment, { status: 201 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
