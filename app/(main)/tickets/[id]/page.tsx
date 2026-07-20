import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { canActOnEntity, buildCategoryWhere } from "@/lib/services/department-scope-service";
import { getAssignableUsersForTicket } from "@/lib/services/assignment-eligibility-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatTicketNumber } from "@/lib/utils";
import { Role } from "@prisma/client";
import {
  TicketDetailClient,
  type TicketDetailClientProps,
} from "@/components/tickets/ticket-detail-client";

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const ticket = await prisma.ticket.findUnique({
    where: { id },
    include: {
      requester: { select: { id: true, name: true, email: true, image: true } },
      assignedAgent: { select: { id: true, name: true, email: true, image: true } },
      status: true,
      priority: true,
      category: true,
      department: { select: { id: true, name: true } },
      project: { select: { id: true, title: true } },
      activity: { select: { id: true, title: true } },
      cancelReason: true,
      messages: {
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { id: true, name: true, email: true, image: true, role: true } },
          attachments: true,
        },
      },
      attachments: {
        where: { messageId: null },
        orderBy: { createdAt: "asc" },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
        },
      },
      history: {
        orderBy: { createdAt: "desc" },
        include: {
          changedBy: { select: { id: true, name: true, image: true } },
        },
      },
    },
  });

  if (!ticket) notFound();

  const role = session.user.role;
  const customRoleId = session.user.customRoleId;
  const isAdminUser = role === Role.ADMIN;
  const isRequester = ticket.requesterId === session.user.id;

  // Gate: can view this specific ticket — department-scoped, not a global
  // "sees every department's tickets" role check.
  const canView = await canActOnEntity(session.user.id, role, ticket.departmentId, "ticket.view", isRequester);
  if (!canView) redirect("/dashboard");

  // Resolve fine-grained permissions in parallel. ticket.reply/internalNote
  // stay global (not department-scoped in Phase 2A — they gate what a
  // viewer of this ticket can additionally do, not whether they can view
  // it at all); changeStatus/assign are department-scoped to match the
  // actual backend gate on the PATCH/assign/status routes, so the UI never
  // shows a button that would just 403.
  const [canReplyPerm, canInternalNote, canChangeStatus, canAssign] =
    await Promise.all([
      hasPermission(role, "ticket.reply", customRoleId),
      hasPermission(role, "ticket.internalNote", customRoleId),
      canActOnEntity(session.user.id, role, ticket.departmentId, "ticket.changeStatus", isRequester),
      canActOnEntity(session.user.id, role, ticket.departmentId, "ticket.assign"),
    ]);

  // Requesters can always reply to their own ticket (even without ticket.reply perm)
  const canReply = canReplyPerm || isRequester;
  const canViewHistory = canChangeStatus || canInternalNote || canAssign;
  const needsAdminData = canChangeStatus || canAssign;

  // Filter internal notes for users without internalNote permission
  const visibleMessages = canInternalNote
    ? ticket.messages
    : ticket.messages.filter((m) => !m.isInternal);

  // Fetch option lists only for users who can act on them
  const [[statuses, priorities, categories, agents], cancelReasons] = await Promise.all([
    needsAdminData
      ? Promise.all([
          canChangeStatus
            ? prisma.ticketStatus.findMany({ where: { isActive: true }, orderBy: { order: "asc" } })
            : Promise.resolve([]),
          canChangeStatus
            ? prisma.ticketPriority.findMany({ where: { isActive: true }, orderBy: { level: "desc" } })
            : Promise.resolve([]),
          canChangeStatus
            ? prisma.ticketCategory.findMany({
                where: { AND: [{ isActive: true }, buildCategoryWhere(ticket.departmentId)] },
                orderBy: { name: "asc" },
              })
            : Promise.resolve([]),
          canAssign
            ? getAssignableUsersForTicket(ticket.departmentId)
            : Promise.resolve([]),
        ])
      : Promise.resolve([[], [], [], []]),
    // Cancel reasons needed by both admins and requesters (who can cancel their own tickets)
    isAdminUser || isRequester
      ? prisma.ticketCancelReason.findMany({ where: { isActive: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
  ]);

  const props: TicketDetailClientProps = {
    ticketId: ticket.id,
    ticketNumber: ticket.ticketNumber,
    ticketTitle: ticket.title,
    ticketDescription: ticket.description,
    ticketSource: ticket.source,
    isAdmin: isAdminUser,
    isRequester,
    initialCancelReasonId: ticket.cancelReasonId,
    cancelReasons: (cancelReasons as Array<{ id: string; name: string }>).map((r) => ({ id: r.id, name: r.name })),
    ticketCreatedAt: ticket.createdAt.toISOString(),
    requester: {
      id: ticket.requester.id,
      name: ticket.requester.name,
      email: ticket.requester.email,
      image: ticket.requester.image,
    },
    department: ticket.department
      ? { id: ticket.department.id, name: ticket.department.name }
      : null,
    project: ticket.project
      ? { id: ticket.project.id, title: ticket.project.title }
      : null,
    activity: ticket.activity
      ? { id: ticket.activity.id, title: ticket.activity.title }
      : null,
    initialStatus: {
      id: ticket.status.id,
      name: ticket.status.name,
      color: ticket.status.color,
      isClosed: ticket.status.isClosed,
    },
    initialPriority: ticket.priority
      ? {
          id: ticket.priority.id,
          name: ticket.priority.name,
          color: ticket.priority.color,
          level: ticket.priority.level,
        }
      : null,
    initialCategory: ticket.category
      ? {
          id: ticket.category.id,
          name: ticket.category.name,
          color: ticket.category.color,
        }
      : null,
    initialAssignedAgent: ticket.assignedAgent
      ? {
          id: ticket.assignedAgent.id,
          name: ticket.assignedAgent.name,
          email: ticket.assignedAgent.email,
          image: ticket.assignedAgent.image,
        }
      : null,
    initialClosedAt: ticket.closedAt?.toISOString() ?? null,
    initialMessages: visibleMessages.map((m) => ({
      id: m.id,
      body: m.body,
      direction: m.direction,
      isInternal: m.isInternal,
      createdAt: m.createdAt.toISOString(),
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      author: m.author
        ? {
            id: m.author.id,
            name: m.author.name,
            email: m.author.email,
            image: m.author.image,
            role: m.author.role,
          }
        : null,
      attachments: m.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        originalName: a.originalName,
        mimeType: a.mimeType,
        size: a.size,
        path: a.path,
      })),
    })),
    ticketAttachments: ticket.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      originalName: a.originalName,
      mimeType: a.mimeType,
      size: a.size,
      path: a.path,
      createdAt: a.createdAt.toISOString(),
      uploadedBy: a.uploadedBy
        ? { id: a.uploadedBy.id, name: a.uploadedBy.name, email: a.uploadedBy.email }
        : null,
    })),
    initialHistory: ticket.history.map((h) => ({
      id: h.id,
      type: h.type,
      oldValue: h.oldValue,
      newValue: h.newValue,
      description: h.description,
      createdAt: h.createdAt.toISOString(),
      changedBy: h.changedBy
        ? { id: h.changedBy.id, name: h.changedBy.name, image: h.changedBy.image }
        : null,
    })),
    currentUserId: session.user.id,
    userRole: role,
    canReply,
    canInternalNote,
    canChangeStatus,
    canAssign,
    canViewHistory,
    statuses: statuses.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    priorities: priorities.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      level: p.level,
    })),
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      image: a.image,
    })),
  };

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/tickets" className="hover:text-foreground">
          Tickets
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-mono font-medium">
          {formatTicketNumber(ticket.ticketNumber)}
        </span>
      </div>

      <TicketDetailClient {...props} />
    </div>
  );
}
