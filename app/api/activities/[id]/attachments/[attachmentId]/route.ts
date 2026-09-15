import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { UPLOAD_DIR, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";

function activityUploadDir(activityId: string): string {
  return path.join(UPLOAD_DIR, "activities", activityId);
}

/**
 * Authenticated attachment download — same private-storage model as
 * GET /api/tickets/[id]/attachments/[attachmentId] (see that route's own
 * comment and lib/attachment-policy.ts): UPLOAD_DIR is never under public/,
 * so a file is only ever reachable through this route, which reconstructs
 * the on-disk location from UPLOAD_DIR + activityId + filename rather than
 * trusting any stored path. Gated on activity.view (read access), not
 * activity.edit — download is a read operation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id: activityId, attachmentId } = await params;
    const session = await requireAuth();

    const activity = await prisma.projectActivity.findUnique({
      where: { id: activityId },
      select: { departmentId: true },
    });
    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canView = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachment = await prisma.activityAttachment.findUnique({ where: { id: attachmentId } });
    // Must belong to THIS activity — an attachment id valid for some other
    // activity must never be reachable through a different activity's URL,
    // even for a user who can view that other activity too.
    if (!attachment || attachment.activityId !== activityId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Defense-in-depth path-traversal guard: attachment.filename is always
    // server-generated (generateStoredFilename, see lib/attachment-policy.ts)
    // and never contains a path separator — this rejects the row outright
    // rather than ever resolving a path outside its own activity's upload
    // directory, in case a row somehow predates that guarantee.
    if (!isSafeStoredFilename(attachment.filename)) {
      console.error(`[activity-attachments] Refusing to serve ActivityAttachment ${attachment.id} — unsafe filename on record`);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dir = activityUploadDir(activityId);
    const filePath = path.join(dir, attachment.filename);
    // Belt-and-suspenders: the joined path must still resolve inside this
    // activity's own upload directory.
    if (!resolvesInsideDir(filePath, dir)) {
      console.error(`[activity-attachments] Refusing to serve ActivityAttachment ${attachment.id} — resolved path escaped its activity directory`);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    // originalName is uploader-controlled free text — strip control
    // characters (CR/LF header-injection, in particular) before it ever
    // reaches a response header.
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
    console.error("[activity-attachments] Download failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Delete follows activity.edit — the same permission that gates upload
 * (per the confirmed design: upload/delete = activity.edit, view/download =
 * activity.view). Removes both the DB row and the on-disk file; the DB
 * delete is the authoritative outcome — a failure to remove the now-orphaned
 * file is logged, never allowed to block the response, since a dangling file
 * with no reachable DB row is unreachable through this route anyway (the
 * lookup above always goes through activityAttachment first).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id: activityId, attachmentId } = await params;
    const session = await requireAuth();

    const activity = await prisma.projectActivity.findUnique({
      where: { id: activityId },
      select: { departmentId: true },
    });
    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canDelete = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.edit");
    if (!canDelete) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachment = await prisma.activityAttachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.activityId !== activityId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.activityAttachment.delete({ where: { id: attachmentId } });

    if (isSafeStoredFilename(attachment.filename)) {
      const dir = activityUploadDir(activityId);
      const filePath = path.join(dir, attachment.filename);
      if (resolvesInsideDir(filePath, dir)) {
        fs.unlink(filePath).catch((err) => {
          console.error(`[activity-attachments] Failed to remove on-disk file for deleted ActivityAttachment ${attachmentId}:`, err);
        });
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error?.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("[activity-attachments] Delete failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
