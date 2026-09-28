import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { isSafeStoredFilename, resolvesInsideDir, entityAttachmentDir } from "@/lib/attachment-policy";

function projectUploadDir(projectId: string): string {
  return entityAttachmentDir("projects", projectId);
}

/**
 * Authenticated attachment download — the Project counterpart of
 * GET /api/activities/[id]/attachments/[attachmentId] (see that route's own
 * comment and lib/attachment-policy.ts): UPLOAD_DIR is never under public/,
 * so a file is only ever reachable through this route, which reconstructs
 * the on-disk location from UPLOAD_DIR + projectId + filename rather than
 * trusting any stored path. Gated on project.view (read access), not
 * project.edit — download is a read operation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id: projectId, attachmentId } = await params;
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { departmentId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // hasEffectiveEntityPermission (global grant OR this entity's own department
    // grant) — bare canActOnEntity ignored a global role/custom-role project.view.
    // Department is the real row's, never the workspace or the client.
    const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachment = await prisma.projectAttachment.findUnique({ where: { id: attachmentId } });
    // Must belong to THIS project — an attachment id valid for some other
    // project (or an Activity attachment id, an entirely different table)
    // must never be reachable through a different project's URL, even for a
    // user who can view that other project too.
    if (!attachment || attachment.projectId !== projectId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Defense-in-depth path-traversal guard: attachment.filename is always
    // server-generated (generateStoredFilename, see lib/attachment-policy.ts)
    // and never contains a path separator — this rejects the row outright
    // rather than ever resolving a path outside its own project's upload
    // directory, in case a row somehow predates that guarantee.
    if (!isSafeStoredFilename(attachment.filename)) {
      console.error(`[project-attachments] Refusing to serve ProjectAttachment ${attachment.id} — unsafe filename on record`);
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const dir = projectUploadDir(projectId);
    const filePath = path.join(dir, attachment.filename);
    // Belt-and-suspenders: the joined path must still resolve inside this
    // project's own upload directory.
    if (!resolvesInsideDir(filePath, dir)) {
      console.error(`[project-attachments] Refusing to serve ProjectAttachment ${attachment.id} — resolved path escaped its project directory`);
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
    console.error("[project-attachments] Download failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Delete follows project.edit — the same permission that gates upload (per
 * the confirmed design: upload/delete = project.edit, view/download =
 * project.view). Removes both the DB row and the on-disk file; the DB
 * delete is the authoritative outcome — a failure to remove the now-orphaned
 * file is logged, never allowed to block the response, since a dangling file
 * with no reachable DB row is unreachable through this route anyway (the
 * lookup above always goes through projectAttachment first).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  try {
    const { id: projectId, attachmentId } = await params;
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { departmentId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canDelete = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.edit");
    if (!canDelete) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachment = await prisma.projectAttachment.findUnique({ where: { id: attachmentId } });
    if (!attachment || attachment.projectId !== projectId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.projectAttachment.delete({ where: { id: attachmentId } });

    if (isSafeStoredFilename(attachment.filename)) {
      const dir = projectUploadDir(projectId);
      const filePath = path.join(dir, attachment.filename);
      if (resolvesInsideDir(filePath, dir)) {
        fs.unlink(filePath).catch((err) => {
          console.error(`[project-attachments] Failed to remove on-disk file for deleted ProjectAttachment ${attachmentId}:`, err);
        });
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error?.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    console.error("[project-attachments] Delete failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
