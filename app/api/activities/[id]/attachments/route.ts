import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import path from "path";
import fs from "fs/promises";
import { MAX_ATTACHMENT_SIZE_BYTES, validateAttachmentUpload, generateStoredFilename, entityAttachmentDir } from "@/lib/attachment-policy";
import { writeAttachmentFile } from "@/lib/attachment-storage-service";

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

    // hasEffectiveEntityPermission (global grant OR this entity's own department
    // grant) — bare canActOnEntity ignored a global role/custom-role activity.view.
    // Department is the real row's, never the workspace or the client.
    const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.view");
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

    const canUpload = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.edit");
    if (!canUpload) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
    }

    const dir = entityAttachmentDir("activities", id);
    const filename = generateStoredFilename(file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    // Shared upload policy (lib/attachment-policy.ts): type/size rule shared
    // with every client picker, plus content verification for .msg/.eml.
    // The stored MIME type is the validated (normalized) one.
    const validation = validateAttachmentUpload(file, buffer);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const writeResult = await writeAttachmentFile(buffer, dir, filename);
    if (!writeResult.ok) {
      console.error("Activity attachment upload error:", writeResult.reason);
      return NextResponse.json({ error: writeResult.reason }, { status: writeResult.statusCode });
    }

    let attachment;
    try {
      attachment = await prisma.activityAttachment.create({
        data: {
          activityId: id,
          uploadedById: session.user.id,
          filename,
          originalName: file.name,
          mimeType: validation.mimeType,
          size: writeResult.size,
        },
        include: attachmentInclude,
      });
    } catch (dbErr) {
      // Compensation: the file above was JUST published, in THIS SAME
      // request, at this EXACT path this handler itself computed — never
      // any pre-existing attachment.
      await fs.unlink(path.join(dir, filename)).catch(() => {});
      throw dbErr;
    }

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
