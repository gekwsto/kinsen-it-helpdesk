import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canViewTicket, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { searchMentionCandidates, type MentionEntityType } from "@/lib/services/mention-service";

const ENTITY_TYPES: MentionEntityType[] = ["ticket", "project", "activity"];

/**
 * Shared user-picker search endpoint for Note @mentions across all three
 * surfaces (Ticket internal notes, Project Notes, Activity Notes) — one
 * route, not three. Requires authentication, and the CALLER must
 * themselves already be able to view the entity being discussed (same
 * canonical check as the corresponding GET .../notes route) before
 * anything about who else can view it is revealed — otherwise this
 * endpoint would let any authenticated user probe department membership
 * for a ticket/project/activity they have no standing on at all.
 *
 * Results are the picker candidate list ONLY — a UX convenience already
 * filtered to users who can view the entity (see
 * lib/services/mention-service.ts's own doc comment on why this is not the
 * real security boundary). The real boundary is re-applied independently
 * when a Note is actually created, against whatever ids the client submits.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);
    const entityType = searchParams.get("entityType");
    const entityId = searchParams.get("entityId");
    const query = searchParams.get("q") ?? undefined;

    if (!entityType || !ENTITY_TYPES.includes(entityType as MentionEntityType) || !entityId) {
      return NextResponse.json({ error: "entityType and entityId are required" }, { status: 400 });
    }

    const canCallerView = await callerCanViewEntity(entityType as MentionEntityType, entityId, session.user.id, session.user.role, session.user.customRoleId);
    if (!canCallerView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const candidates = await searchMentionCandidates({
      entityType: entityType as MentionEntityType,
      entityId,
      query,
      limit: 8,
    });

    return NextResponse.json(candidates);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

async function callerCanViewEntity(
  entityType: MentionEntityType,
  entityId: string,
  userId: string,
  role: Parameters<typeof canViewTicket>[1],
  customRoleId: string | null | undefined
): Promise<boolean> {
  if (entityType === "ticket") {
    const ticket = await prisma.ticket.findUnique({
      where: { id: entityId },
      select: {
        departmentId: true,
        subDepartmentId: true,
        requesterId: true,
        assignedAgentId: true,
        shareWithDepartment: true,
        shareWithSubDepartment: true,
      },
    });
    if (!ticket) return false;
    return canViewTicket(userId, role, ticket);
  }

  // hasEffectiveEntityPermission (the union of a global grant and a
  // DepartmentMembership/custom Department role grant for the entity's OWN
  // department), never a bare canActOnEntity call — the CALLER's own
  // standing to even use this search endpoint at all must recognize the
  // exact same grants resolveEligibleMentionUsers/searchMentionCandidates
  // (lib/services/mention-service.ts) already do for candidates, or a note
  // author whose project.view/activity.view comes solely from a global
  // role/custom role would be wrongly 403'd here before ever reaching the
  // candidate search.
  if (entityType === "project") {
    const project = await prisma.project.findUnique({ where: { id: entityId }, select: { departmentId: true } });
    if (!project) return false;
    return hasEffectiveEntityPermission(userId, role, customRoleId, project.departmentId, "project.view");
  }

  const activity = await prisma.projectActivity.findUnique({ where: { id: entityId }, select: { departmentId: true } });
  if (!activity) return false;
  return hasEffectiveEntityPermission(userId, role, customRoleId, activity.departmentId, "activity.view");
}
