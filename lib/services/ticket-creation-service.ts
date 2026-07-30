import { prisma } from "@/lib/prisma";
import { resolveDefaultStatusId, resolveDefaultPriorityId } from "@/lib/services/department-scope-service";
import type { ExternalIntegration, Prisma, TicketSource } from "@prisma/client";

/**
 * Already-validated/resolved fields a new Ticket is created from. Every
 * caller (WEB's POST /api/tickets and the integration endpoint) resolves
 * its own permissions, department, and status/category/priority defaults
 * BEFORE calling this — this service only persists, it never authorizes or
 * resolves scope itself, so it can't accidentally diverge between callers
 * on who's allowed to do what.
 */
export interface CreateTicketData {
  title: string;
  description: string;
  source: TicketSource;
  requesterId: string;
  statusId: string;
  categoryId?: string | null;
  priorityId?: string | null;
  departmentId?: string | null;
  subDepartmentId?: string | null;
  projectId?: string | null;
  activityId?: string | null;
  shareWithDepartment?: boolean;
  shareWithSubDepartment?: boolean;
  integrationId?: string | null;
  externalReferenceId?: string | null;
  sourceUrl?: string | null;
  externalMetadata?: Prisma.InputJsonValue;
}

/**
 * Who/what to record on the initial TicketHistory "CREATED" row.
 * changedById is null for integration-created tickets (no human acted) —
 * description carries the actual provenance in readable form instead.
 */
export interface CreateTicketHistoryContext {
  changedById?: string | null;
  description: string;
}

const TICKET_CREATE_INCLUDE = {
  status: true,
  priority: true,
  category: true,
  requester: { select: { id: true, name: true, email: true } },
} satisfies Prisma.TicketInclude;

/**
 * Atomically creates a Ticket together with its initial TicketMessage
 * (the description, as an INBOUND message — same convention the WEB flow
 * has always used) and its initial TicketHistory ("CREATED") row, via
 * prisma.$transaction so a failure partway through (e.g. a unique-
 * constraint conflict on [integrationId, externalReferenceId]) leaves
 * nothing behind — never a Ticket with no history/message, never an orphan
 * history row.
 *
 * The initial message's authorId is always the requester (data.requesterId)
 * — for WEB this is the same person as the session user who submitted the
 * form (requesterId is always session.user.id there); for an integration-
 * created ticket it's the real end user resolved from requesterEmail (see
 * resolveOrCreateRequester), never the integration itself, since an
 * ExternalIntegration is a credential, not a User.
 */
export async function createTicketAtomic(data: CreateTicketData, history: CreateTicketHistoryContext) {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.create({
      data: {
        title: data.title,
        description: data.description,
        source: data.source,
        requesterId: data.requesterId,
        statusId: data.statusId,
        categoryId: data.categoryId ?? undefined,
        priorityId: data.priorityId ?? undefined,
        departmentId: data.departmentId ?? undefined,
        subDepartmentId: data.subDepartmentId ?? undefined,
        projectId: data.projectId ?? undefined,
        activityId: data.activityId ?? undefined,
        shareWithDepartment: data.shareWithDepartment ?? false,
        shareWithSubDepartment: data.shareWithSubDepartment ?? false,
        integrationId: data.integrationId ?? undefined,
        externalReferenceId: data.externalReferenceId ?? undefined,
        sourceUrl: data.sourceUrl ?? undefined,
        externalMetadata: data.externalMetadata ?? undefined,
      },
      include: TICKET_CREATE_INCLUDE,
    });

    await tx.ticketHistory.create({
      data: {
        ticketId: ticket.id,
        changedById: history.changedById ?? null,
        type: "CREATED",
        description: history.description,
        newValue: data.source,
      },
    });

    await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: data.requesterId,
        body: data.description,
        direction: "INBOUND",
      },
    });

    return ticket;
  });
}

export type ResolveIntegrationDefaultsResult =
  | {
      ok: true;
      statusId: string;
      categoryId: string | null;
      priorityId: string | null;
    }
  | { ok: false; code: "configuration_required" | "category_department_mismatch" | "priority_department_mismatch"; message: string };

/**
 * Resolves statusId/categoryId/priorityId for a new integration-created
 * ticket, per the fixed precedence rules for each field:
 *
 * - statusId: always the department's own configured default (
 *   resolveDefaultStatusId) — never caller-supplied, there's no such field
 *   on the request contract.
 * - categoryId: the request's own categoryId IF it's active and belongs to
 *   the integration's department; else the integration's own
 *   defaultCategoryId IF that's still active (a department admin may have
 *   deactivated it since); else null. A category from a different
 *   department (or an inactive/unknown one) is rejected outright — never
 *   silently swapped for the department default, since that could put a
 *   ticket in a category the caller never asked for.
 * - priorityId: same shape as categoryId, but falls back one level further
 *   — request value, else integration default, else the department's own
 *   generic default priority (resolveDefaultPriorityId), since (unlike
 *   category) every department is expected to have a usable default
 *   priority.
 */
export async function resolveIntegrationTicketDefaults(
  integration: ExternalIntegration,
  requested: { categoryId?: string | null; priorityId?: string | null }
): Promise<ResolveIntegrationDefaultsResult> {
  const statusId = await resolveDefaultStatusId(integration.departmentId);
  if (!statusId) {
    return {
      ok: false,
      code: "configuration_required",
      message: `Department ${integration.departmentId} has no active default ticket status configured.`,
    };
  }

  let categoryId: string | null = null;
  if (requested.categoryId) {
    const category = await prisma.ticketCategory.findUnique({
      where: { id: requested.categoryId },
      select: { id: true, isActive: true, departmentId: true },
    });
    if (!category || !category.isActive || category.departmentId !== integration.departmentId) {
      return {
        ok: false,
        code: "category_department_mismatch",
        message: "categoryId does not belong to an active category in this integration's department.",
      };
    }
    categoryId = category.id;
  } else if (integration.defaultCategoryId) {
    const defaultCategory = await prisma.ticketCategory.findUnique({
      where: { id: integration.defaultCategoryId },
      select: { id: true, isActive: true, departmentId: true },
    });
    if (defaultCategory && defaultCategory.isActive && defaultCategory.departmentId === integration.departmentId) {
      categoryId = defaultCategory.id;
    }
  }

  let priorityId: string | null = null;
  if (requested.priorityId) {
    const priority = await prisma.ticketPriority.findUnique({
      where: { id: requested.priorityId },
      select: { id: true, isActive: true, departmentId: true },
    });
    if (!priority || !priority.isActive || priority.departmentId !== integration.departmentId) {
      return {
        ok: false,
        code: "priority_department_mismatch",
        message: "priorityId does not belong to an active priority in this integration's department.",
      };
    }
    priorityId = priority.id;
  } else if (integration.defaultPriorityId) {
    const defaultPriority = await prisma.ticketPriority.findUnique({
      where: { id: integration.defaultPriorityId },
      select: { id: true, isActive: true, departmentId: true },
    });
    if (defaultPriority && defaultPriority.isActive && defaultPriority.departmentId === integration.departmentId) {
      priorityId = defaultPriority.id;
    }
  }
  if (!priorityId) {
    priorityId = await resolveDefaultPriorityId(integration.departmentId);
  }

  return { ok: true, statusId, categoryId, priorityId };
}
