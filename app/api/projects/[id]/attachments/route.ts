import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import path from "path";
import fs from "fs/promises";
import { MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename, entityAttachmentDir } from "@/lib/attachment-policy";

const attachmentInclude = {
  uploadedBy: { select: { id: true, name: true, email: true } },
} as const;

/**
 * Project's counterpart of GET/POST /api/activities/[id]/attachments — same
 * shape, same shared storage policy (lib/attachment-policy.ts), same
 * hasEffectiveEntityPermission resolver (global grant OR this Project's own
 * department grant, never active workspace/client-supplied department).
 * Read access follows project.view — the same permission that gates the
 * Project detail page itself, no separate `project.attachment` key.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, departmentId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // hasEffectiveEntityPermission (global grant OR this entity's own department
    // grant) — bare canActOnEntity ignored a global role/custom-role project.view.
    // Department is the real row's, never the workspace or the client.
    const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachments = await prisma.projectAttachment.findMany({
      where: { projectId: id },
      include: attachmentInclude,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(attachments);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Write access follows project.edit — deliberately a stricter gate than
 * read (project.view), same as Project Notes. Reuses the exact storage
 * policy already enforced by Activity/Ticket attachment upload
 * (private UPLOAD_DIR, MIME/size allowlist, generateStoredFilename) — see
 * lib/attachment-policy.ts.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, departmentId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canUpload = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.edit");
    if (!canUpload) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    if (!isAllowedAttachmentMimeType(file.type)) {
      return NextResponse.json({ error: "File type not allowed" }, { status: 400 });
    }

    const dir = entityAttachmentDir("projects", id);
    await fs.mkdir(dir, { recursive: true });

    const filename = generateStoredFilename(file.name);
    const filePath = path.join(dir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const attachment = await prisma.projectAttachment.create({
      data: {
        projectId: id,
        uploadedById: session.user.id,
        filename,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
      },
      include: attachmentInclude,
    });

    return NextResponse.json(attachment, { status: 201 });
  } catch (error: any) {
    // requireAuth() throws a plain Error("Unauthorized") on no/expired
    // session — surfaced as a real 401, not folded into the generic 500
    // below — matches every other Project route's convention (see e.g.
    // DELETE /api/projects/[id]) and mirrors the Activity attachment route.
    if (error?.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Project attachment upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
