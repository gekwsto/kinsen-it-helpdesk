import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import path from "path";
import fs from "fs/promises";
import { UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename } from "@/lib/attachment-policy";

const attachmentInclude = {
  uploadedBy: { select: { id: true, name: true, email: true } },
} as const;

/**
 * Read access follows activity.view — the same permission that gates the
 * Activity detail page itself, no separate `activity.attachment` key is
 * introduced (same pattern as GET /api/activities/[id]/notes).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      select: { id: true, departmentId: true },
    });
    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canView = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const attachments = await prisma.activityAttachment.findMany({
      where: { activityId: id },
      include: attachmentInclude,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(attachments);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

/**
 * Write access follows activity.edit — deliberately a stricter gate than
 * read (activity.view), same as notes. Reuses the exact storage policy
 * already enforced by the Ticket attachment upload route (private
 * UPLOAD_DIR, MIME/size allowlist, generateStoredFilename) — see
 * lib/attachment-policy.ts.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      select: { id: true, departmentId: true },
    });
    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canUpload = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.edit");
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

    const dir = path.join(UPLOAD_DIR, "activities", id);
    await fs.mkdir(dir, { recursive: true });

    const filename = generateStoredFilename(file.name);
    const filePath = path.join(dir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    const attachment = await prisma.activityAttachment.create({
      data: {
        activityId: id,
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
    // below (the Ticket attachment upload route this was modeled on
    // doesn't make this distinction; this route does, matching every other
    // Activity route's convention — see e.g. DELETE /api/activities/[id]).
    if (error?.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Activity attachment upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
