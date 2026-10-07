import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { createNoteSchema } from "@/lib/validations";
import { resolveEligibleMentionUsers } from "@/lib/services/mention-service";
import {
  filterReminderEligibleUserIds,
  resolveRespondedRemindersInTx,
  scheduleMentionRemindersInTx,
} from "@/lib/services/mention-reminder-service";
import { notifyNewMentions } from "@/lib/services/mention-notification-service";

const noteInclude = {
  author: { select: { id: true, name: true, email: true, image: true } },
  mentions: { include: { user: { select: { id: true, name: true, email: true } } } },
} as const;

function toNoteMentions(note: { mentions: { user: { id: string; name: string | null; email: string } }[] }) {
  return note.mentions.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email }));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, departmentId: true, projectRequestId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Same visibility rule the Project detail page itself uses — read
    // access to Notes follows project.view (Department-scoped), OR —
    // request-origin only — an explicitly-selected Owner/Audience user.
    // No separate `project.note` permission is introduced.
    const canView = await hasProjectViewAccess(session.user.id, session.user.role, session.user.customRoleId, project);
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const notes = await prisma.projectNote.findMany({
      where: { projectId: id },
      include: noteInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    return NextResponse.json(notes.map((n) => ({ ...n, mentions: toNoteMentions(n) })));
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
      select: { id: true, title: true, departmentId: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Write access follows project.edit — deliberately a stricter gate than
    // read (project.view). Never Admin-only, never inferred from the UI.
    const canAddNote = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.edit");
    if (!canAddNote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const data = createNoteSchema.parse(body);

    // Layer 2 of the mention security model (see
    // lib/services/mention-service.ts's doc comment): every client-submitted
    // mentionUserId is re-validated here against the exact same canonical
    // project.view eligibility check the picker itself used, independent of
    // whatever the client claims. Anything that fails is silently dropped —
    // never persisted as a mention, never notified.
    const eligibleMentions = await resolveEligibleMentionUsers({
      entityType: "project",
      entityId: id,
      requestedUserIds: data.mentionUserIds,
    });

    // Mention Reminders: eligibility (active, opted in, view + note-create
    // permission against the REAL entity department) is resolved before the
    // transaction; the reminder rows themselves are written inside it.
    const reminderUserIds = await filterReminderEligibleUserIds({
      entityType: "project",
      entityDepartmentId: project.departmentId,
      authorId: session.user.id,
      mentionedUserIds: eligibleMentions.map((m) => m.id),
    });

    const note = await prisma.$transaction(async (tx) => {
      const created = await tx.projectNote.create({
        data: {
          projectId: id,
          // authorId always comes from the authenticated session — never
          // accepted from the request body.
          authorId: session.user.id,
          body: data.body,
        },
      });
      if (eligibleMentions.length > 0) {
        await tx.projectNoteMention.createMany({
          data: eligibleMentions.map((m) => ({ noteId: created.id, userId: m.id })),
          skipDuplicates: true,
        });
        await scheduleMentionRemindersInTx(tx, { entityType: "project", noteId: created.id, eligibleUserIds: reminderUserIds });
      }
      // The author just responded here: resolve their earlier pending reminders on THIS entity.
      await resolveRespondedRemindersInTx(tx, { entityType: "project", entityId: id, authorId: session.user.id, noteCreatedAt: created.createdAt });
      return tx.projectNote.findUniqueOrThrow({ where: { id: created.id }, include: noteInclude });
    });

    // Notifications only fire after the Note + its mentions are fully
    // committed — never before, and never for a mention that failed
    // eligibility. Self-mentions are silently skipped inside
    // notifyNewMentions; no Note-editing exists for Project Notes today, so
    // every mention here is by construction "newly added." Awaited (not
    // fire-and-forget) so a mentioned user is guaranteed to already have
    // their notification by the time this response reaches the client —
    // a failure here is logged, never allowed to fail the note creation
    // itself (the note is already committed above).
    if (eligibleMentions.length > 0) {
      try {
        await notifyNewMentions({
          authorId: session.user.id,
          authorName: session.user.name ?? "Someone",
          mentionedUserIds: eligibleMentions.map((m) => m.id),
          link: `/projects/${id}`,
          entityLabel: `the project "${project.title}"`,
        });
      } catch (err) {
        console.error("[mentions] Failed to notify project note mentions:", err);
      }
    }

    return NextResponse.json({ ...note, mentions: toNoteMentions(note) }, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
