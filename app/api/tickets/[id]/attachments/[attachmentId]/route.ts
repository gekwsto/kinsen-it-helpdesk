import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canViewTicket } from "@/lib/services/department-scope-service";
import { UPLOAD_DIR, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";

/**
 * Authenticated attachment download — the ONLY way to read an attachment's
 * bytes now that UPLOAD_DIR is private (see lib/attachment-policy.ts):
 * never under public/, so Next.js's static file server cannot serve it
 * under any URL, guessed or not. Previously (both before this authorization
 * check existed, AND before storage moved private) TicketAttachment.path
 * (`/uploads/<ticketId>/<filename>`) was a plain link into public/uploads,
 * reachable by anyone with the URL, authenticated or not — true for every
 * attachment (web-uploaded or email-derived). This route is the correct
 * link target for both ticket-detail-client.tsx's ticket-level Attachments
 * panel and ticket-thread.tsx's per-message attachment chips.
 * TicketAttachment.path itself is left as a stored field (unread by this
 * route, which reconstructs the real location from UPLOAD_DIR + ticketId +
 * filename instead) purely for data-shape continuity — see
 * lib/attachment-policy.ts's / the accept-time migration comment for detail.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id: ticketId, attachmentId } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        departmentId: true,
        subDepartmentId: true,
        requesterId: true,
        assignedAgentId: true,
        shareWithDepartment: true,
        shareWithSubDepartment: true,
      },
    });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const allowed = await canViewTicket(session.user.id, session.user.role, ticket);
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachment = await prisma.ticketAttachment.findUnique({ where: { id: attachmentId } });
    // Must belong to THIS ticket — an attachment id valid for some other
    // ticket must never be reachable through a different ticket's URL, even
    // for a user who can view that other ticket too.
    if (!attachment || attachment.ticketId !== ticketId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Defense-in-depth path-traversal guard: attachment.filename is always
    // server-generated (generateStoredFilename/buildMigratedAttachmentFilename,
    // see lib/attachment-policy.ts) and never contains a path separator —
    // this rejects the row outright rather than ever resolving a path
    // outside its own ticket's upload directory, in case a row somehow
    // predates that guarantee.
    if (!isSafeStoredFilename(attachment.filename)) {
      console.error(`[attachments] Refusing to serve TicketAttachment ${attachment.id} — unsafe filename on record`);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const filePath = path.join(UPLOAD_DIR, ticketId, attachment.filename);
    // Belt-and-suspenders: the joined path must still resolve inside this
    // ticket's own upload directory (never leaks the real filesystem path
    // to the client either way — only used server-side to read the file).
    if (!resolvesInsideDir(filePath, path.join(UPLOAD_DIR, ticketId))) {
      console.error(`[attachments] Refusing to serve TicketAttachment ${attachment.id} — resolved path escaped its ticket directory`);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      // TicketAttachment row exists but the file is missing on disk — a
      // real, distinct failure mode (see this fix's report) from "never
      // had a row at all"; still a 404 to the client either way.
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // originalName is sender/uploader-controlled free text — strip control
    // characters (CR/LF header-injection, in particular) before it ever
    // reaches a response header; the visible download filename otherwise
    // remains exactly what was uploaded/emailed in.
    const safeDownloadName = attachment.originalName.replace(/[\r\n"]/g, "_");

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": attachment.mimeType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${safeDownloadName}"; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error: any) {
    if (error?.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("[attachments] Download failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
