import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { createNoteSchema } from "@/lib/validations";

const noteInclude = {
  author: { select: { id: true, name: true, email: true, image: true } },
} as const;

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

    // Same department-aware visibility rule the Project detail page itself
    // uses — read access to Notes follows project.view, no separate
    // `project.note` permission is introduced.
    const canView = await canActOnEntity(session.user.id, session.user.role, project.departmentId, "project.view");
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const notes = await prisma.projectNote.findMany({
      where: { projectId: id },
      include: noteInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    return NextResponse.json(notes);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

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

    // Write access follows project.edit — deliberately a stricter gate than
    // read (project.view). Never Admin-only, never inferred from the UI.
    const canAddNote = await canActOnEntity(session.user.id, session.user.role, project.departmentId, "project.edit");
    if (!canAddNote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    // createNoteSchema accepts exactly one field (`body`) — isInternal,
    // direction, and any other reply/email semantics are not part of this
    // schema at all, so a client sending them has no effect; they are
    // silently dropped by Zod before reaching this handler.
    const data = createNoteSchema.parse(body);

    const note = await prisma.projectNote.create({
      data: {
        projectId: id,
        // authorId always comes from the authenticated session — never
        // accepted from the request body.
        authorId: session.user.id,
        body: data.body,
      },
      include: noteInclude,
    });

    return NextResponse.json(note, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
