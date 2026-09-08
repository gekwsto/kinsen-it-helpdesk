import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canViewAllTickets } from "@/lib/permissions";
import path from "path";
import fs from "fs/promises";
import { UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename } from "@/lib/attachment-policy";

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
    await fs.mkdir(dir, { recursive: true });

    const filename = generateStoredFilename(file.name);
    const filePath = path.join(dir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const attachment = await prisma.ticketAttachment.create({
      data: {
        ticketId: id,
        messageId: messageId ?? null,
        uploadedById: session.user.id,
        filename,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
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

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: "ATTACHMENT_ADDED",
        description: `Attachment "${file.name}" uploaded by ${session.user.name}`,
        newValue: file.name,
      },
    });

    return NextResponse.json(attachment, { status: 201 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
