import { DepartmentRole, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getUserDepartmentMemberships, getMembership } from "@/lib/services/department-membership-service";
import { getDefaultLegacyDepartmentId, listDepartments, toDepartmentSummary } from "@/lib/services/department-service";
import { getUserSubDepartmentIds, getSubDepartmentMembership } from "@/lib/services/sub-department-membership-service";
import { resolveActiveWorkspace } from "@/lib/services/workspace-service";
import { hasDepartmentPermission, hasPermission, canViewAllDepartments } from "@/lib/permissions";
import type { DepartmentSummary } from "@/types/department";

/**
 * Phase 2A: the single place list/read/write department scoping is computed,
 * consumed identically by API route handlers and Server Component pages
 * (several of which query Prisma directly, bypassing the API routes
 * entirely — see the Phase 2A plan). Every function here is a pure
 * data/authorization computation; callers own turning a `denied` result
 * into a 403 JSON response or an inline access-denied UI state.
 *
 * "No explicit departmentId" resolves to the union of a user's accessible
 * departments for reads (there's no workspace-selector UI yet to force a
 * single choice — see Phase 1's resolveActiveWorkspace). An *explicit*
 * departmentId is always validated against real membership; it is never
 * trusted as-is. Writes (resolveDepartmentForCreate) are stricter: a create
 * always needs exactly one resolved department, never a union.
 */

export type ScopeDenial = { denied: "invalid_department" };
export type CreateDenial = { denied: "invalid_department" | "workspace_required" | "pending_setup" };

/** Consistent, human-readable message for a CreateDenial reason — used by every route so the client sees the same wording. */
export function departmentDenialMessage(reason: CreateDenial["denied"]): string {
  switch (reason) {
    case "invalid_department":
      return "You don't have access to this department.";
    case "workspace_required":
      return "You belong to multiple departments — specify which one this belongs to.";
    case "pending_setup":
      return "Your account isn't assigned to a department yet. Contact an administrator.";
  }
}

/** Matching HTTP status for a CreateDenial reason — kept alongside the message so every route stays consistent. */
export function departmentDenialStatus(reason: CreateDenial["denied"]): number {
  switch (reason) {
    case "invalid_department":
      return 403;
    case "workspace_required":
      return 400;
    case "pending_setup":
      return 403;
  }
}

const NO_MATCH_WHERE = { id: { in: [] as string[] } };

async function getDepartmentIdsWithPermission(userId: string, permissionKey: string): Promise<string[]> {
  const memberships = await getUserDepartmentMemberships(userId);
  const ids: string[] = [];
  for (const m of memberships) {
    if (await hasDepartmentPermission(m.role, permissionKey, m.customRoleId)) ids.push(m.departmentId);
  }
  return ids;
}

/**
 * Department rows (not just ids) for a filter dropdown or creation-form
 * picker — ADMIN sees every active department, everyone else only the ones
 * where their DepartmentRole grants the given permission. Shared by any
 * page that needs to show a "which department" choice without ever
 * rendering one the backend would reject anyway (Phase 2B §6/§7).
 */
export async function getAccessibleDepartmentSummaries(
  userId: string,
  role: Role,
  permissionKey: string
): Promise<DepartmentSummary[]> {
  if (canViewAllDepartments(role)) {
    return (await listDepartments()).map(toDepartmentSummary);
  }
  const memberships = await getUserDepartmentMemberships(userId);
  const result: DepartmentSummary[] = [];
  for (const m of memberships) {
    if (await hasDepartmentPermission(m.role, permissionKey, m.customRoleId)) result.push(m.department);
  }
  return result;
}

/**
 * SubDepartment ids where `userId` has an active SubDepartmentMembership AND
 * the parent department is in `ownOnlyDepartmentIds` — the exact set the
 * ticket-sharing OR-clauses below widen visibility for. Deliberately never
 * computed for full-view departments: a full-view member already sees every
 * ticket in the department regardless of share flags, so it would be a
 * no-op there.
 */
async function getUserShareEligibleSubDepartmentIds(userId: string, ownOnlyDepartmentIds: string[]): Promise<string[]> {
  if (ownOnlyDepartmentIds.length === 0) return [];
  const rows = await prisma.subDepartmentMembership.findMany({
    where: { userId, isActive: true, departmentId: { in: ownOnlyDepartmentIds }, subDepartment: { isActive: true } },
    select: { subDepartmentId: true },
  });
  return rows.map((r) => r.subDepartmentId);
}

/** Splits a user's ticket-viewable departments into "sees everyone's tickets" vs "own tickets only" (DepartmentRole.REQUESTER). */
async function splitTicketViewScope(userId: string): Promise<{ fullView: string[]; ownOnly: string[] }> {
  const memberships = await getUserDepartmentMemberships(userId);
  const fullView: string[] = [];
  const ownOnly: string[] = [];
  for (const m of memberships) {
    const allowed = await hasDepartmentPermission(m.role, "ticket.view", m.customRoleId);
    if (!allowed) continue;
    if (m.role === DepartmentRole.REQUESTER) ownOnly.push(m.departmentId);
    else fullView.push(m.departmentId);
  }
  return { fullView, ownOnly };
}

/**
 * Category visibility: strictly the given department's own — there is no
 * more global/shared category (each department has its own independent
 * set; see the 20260727_retire_global_config migration).
 */
export function buildCategoryWhere(departmentId: string): Record<string, unknown> {
  return { departmentId };
}

/** Priority visibility — strictly that department's own, same shape as buildCategoryWhere. */
export function buildPriorityWhere(departmentId: string): Record<string, unknown> {
  return { departmentId };
}

/** Status visibility — strictly that department's own, same shape as buildCategoryWhere. */
export function buildStatusWhere(departmentId: string): Record<string, unknown> {
  return { departmentId };
}

/** Cancel reason visibility — same global-plus-own shape as buildCategoryWhere. */
export function buildCancelReasonWhere(departmentId: string | null): Record<string, unknown> {
  return departmentId ? { OR: [{ departmentId: null }, { departmentId }] } : { departmentId: null };
}

/**
 * The default TicketStatus for a new ticket in `departmentId` — that
 * department's own active isDefault status. Used by both ticket creation
 * (app/api/tickets/route.ts) and the pending-ticket accept flow
 * (lib/services/pending-ticket-service.ts) so the two paths can never
 * disagree on which status a fresh ticket starts in. Returns null only if
 * the department has no active default status configured — callers treat
 * that as a genuine configuration error, not a silent fallback.
 */
export async function resolveDefaultStatusId(departmentId: string): Promise<string | null> {
  const departmentDefault = await prisma.ticketStatus.findFirst({
    where: { departmentId, isDefault: true, isActive: true },
    // Deterministic tie-break if more than one row ever qualifies (should
    // never happen by design, but a `findFirst` with no order is not
    // guaranteed stable across calls) — oldest wins, matching the dedupe
    // script's canonical-selection convention.
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return departmentDefault?.id ?? null;
}

/**
 * True if `id` is currently the only active default status in its own
 * department — removing/un-defaulting/deactivating/deleting it would leave
 * ticket creation and the pending-ticket accept flow with no default status
 * to resolve to for that department (see resolveDefaultStatusId above).
 * Every department is protected this way now, not just what used to be the
 * one shared global default.
 */
export async function isLastActiveDefaultStatusInDepartment(id: string, departmentId: string): Promise<boolean> {
  const otherActiveDefaults = await prisma.ticketStatus.count({
    where: { departmentId, isDefault: true, isActive: true, NOT: { id } },
  });
  return otherActiveDefaults === 0;
}

/**
 * The default TicketPriority for a new ticket in `departmentId` — priorities
 * have no isDefault flag (unlike TicketStatus), so "default" here means the
 * lowest-`level` active priority in this department (least urgent — a safe,
 * non-escalating default for tickets created without explicit priority
 * input, e.g. the pending-ticket accept flow). Returns null if the
 * department has no active priority of its own.
 */
export async function resolveDefaultPriorityId(departmentId: string): Promise<string | null> {
  const priority = await prisma.ticketPriority.findFirst({
    where: { AND: [{ isActive: true }, buildPriorityWhere(departmentId)] },
    // createdAt as a secondary key breaks ties deterministically when two
    // priorities share the same level (should never happen by design, but
    // `findFirst` with only a partial order is not guaranteed stable).
    orderBy: [{ level: "asc" }, { createdAt: "asc" }],
  });
  return priority?.id ?? null;
}

/**
 * True if the user sees the full ticket list in at least one department
 * (not just their own tickets) — the gate for the "All Tickets" page vs.
 * "My Tickets" (an all-REQUESTER user, or one with zero memberships, only
 * ever sees their own). ADMIN always qualifies.
 */
export async function hasAnyFullTicketView(userId: string, role: Role): Promise<boolean> {
  if (canViewAllDepartments(role)) return true;
  const { fullView } = await splitTicketViewScope(userId);
  return fullView.length > 0;
}

/**
 * Ticket list scoping. ADMIN sees everything (optionally narrowed by an
 * explicit departmentId). Everyone else: full-view departments contribute
 * every ticket, own-only (REQUESTER) departments contribute only tickets
 * they requested themselves. Legacy departmentId:null rows are folded into
 * whichever bucket the default legacy department falls into, if accessible.
 */
export async function buildTicketListWhere(
  userId: string,
  role: Role,
  requestedDepartmentId?: string | null
): Promise<Record<string, unknown> | ScopeDenial> {
  if (canViewAllDepartments(role)) {
    return requestedDepartmentId ? { departmentId: requestedDepartmentId } : {};
  }

  const { fullView, ownOnly } = await splitTicketViewScope(userId);
  const legacyId = await getDefaultLegacyDepartmentId();

  if (requestedDepartmentId) {
    const isFull = fullView.includes(requestedDepartmentId);
    const isOwn = !isFull && ownOnly.includes(requestedDepartmentId);
    if (!isFull && !isOwn) return { denied: "invalid_department" };

    let base: Record<string, unknown>;
    if (isFull) {
      base = { departmentId: requestedDepartmentId };
    } else {
      // Own-only (REQUESTER-tier): normally just their own tickets, widened
      // by whichever sharing flags the ticket itself opted into.
      const shareSubDeptIds = await getUserShareEligibleSubDepartmentIds(userId, [requestedDepartmentId]);
      base = {
        OR: [
          { departmentId: requestedDepartmentId, requesterId: userId },
          { departmentId: requestedDepartmentId, shareWithDepartment: true },
          ...(shareSubDeptIds.length > 0
            ? [{ subDepartmentId: { in: shareSubDeptIds }, shareWithSubDepartment: true }]
            : []),
        ],
      };
    }
    if (legacyId !== requestedDepartmentId) return base;

    // Legacy (departmentId: null) rows predate department scoping entirely —
    // sharing doesn't apply to them, own-only still means own-only here.
    const legacyBase = isFull ? { departmentId: null } : { departmentId: null, requesterId: userId };
    return { OR: [base, legacyBase] };
  }

  const orClauses: Record<string, unknown>[] = [];
  if (fullView.length > 0) {
    orClauses.push({ departmentId: { in: fullView } });
    if (legacyId && fullView.includes(legacyId)) orClauses.push({ departmentId: null });
  }
  if (ownOnly.length > 0) {
    orClauses.push({ departmentId: { in: ownOnly }, requesterId: userId });
    orClauses.push({ departmentId: { in: ownOnly }, shareWithDepartment: true });
    const shareSubDeptIds = await getUserShareEligibleSubDepartmentIds(userId, ownOnly);
    if (shareSubDeptIds.length > 0) {
      orClauses.push({ subDepartmentId: { in: shareSubDeptIds }, shareWithSubDepartment: true });
    }
    if (legacyId && ownOnly.includes(legacyId)) orClauses.push({ departmentId: null, requesterId: userId });
  }

  if (orClauses.length === 0) return NO_MATCH_WHERE;
  return orClauses.length === 1 ? orClauses[0] : { OR: orClauses };
}

/**
 * Ticket-specific view gate for a single already-fetched ticket (GET
 * /api/tickets/[id], the ticket detail page) — mirrors buildTicketListWhere's
 * full-view/own-only split (see splitTicketViewScope) so a direct URL/API
 * call can never see a ticket the All Tickets list itself would hide.
 *
 * Deliberately does NOT delegate its department-membership check to
 * canActOnEntity(..., "ticket.view", ...): that helper is a generic
 * "does this permission key apply anywhere in this department" check with no
 * concept of REQUESTER-tier own-only scoping, and DepartmentRole.REQUESTER
 * IS seeded with ticket.view (so a requester can view/create/reply to their
 * own tickets) — using it here would grant a requester-tier department
 * member visibility into every other ticket in the department, not just
 * their own. Order matters: system-wide, then direct relationship
 * (owner/assignee), then department-wide permission (full-view tier only),
 * then sharing for own-only tier — never let department membership alone
 * return true.
 */
export async function canViewTicket(
  userId: string,
  role: Role,
  ticket: {
    departmentId: string | null;
    subDepartmentId: string | null;
    requesterId: string;
    assignedAgentId?: string | null;
    shareWithDepartment: boolean;
    shareWithSubDepartment: boolean;
  }
): Promise<boolean> {
  // 1. System-wide (Admin/Director).
  if (canViewAllDepartments(role)) return true;

  // 2. Direct relationship — requester or assigned agent, regardless of
  // department standing (an agent reassigned out of a department mid-ticket
  // should still see their own assignment history).
  if (ticket.requesterId === userId) return true;
  if (ticket.assignedAgentId && ticket.assignedAgentId === userId) return true;

  // 3. Department-wide permission — full-view tier only. Legacy
  // (departmentId: null) rows fall back to the default legacy department,
  // matching buildTicketListWhere's own legacy handling.
  const effectiveDeptId = ticket.departmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDeptId) return false;

  const membership = await getMembership(userId, effectiveDeptId);
  if (!membership) return false;
  const hasView = await hasDepartmentPermission(membership.role, "ticket.view", membership.customRoleId);
  if (!hasView) return false;

  if (membership.role !== DepartmentRole.REQUESTER) return true;

  // 4. Sharing — own-only (REQUESTER) tier only, and only for a real
  // (non-legacy) department ticket: sharing doesn't apply to legacy rows,
  // own-only still means own-only there (see buildTicketListWhere).
  if (!ticket.departmentId) return false;

  if (ticket.shareWithDepartment) return true;
  if (ticket.shareWithSubDepartment && ticket.subDepartmentId) {
    const subMembership = await getSubDepartmentMembership(userId, ticket.subDepartmentId);
    if (subMembership) return true;
  }
  return false;
}

/**
 * Nav-visibility flags for the sidebar (app/(main)/layout.tsx) — computed
 * server-side, mirroring the existing canCreateTicket pattern. Sidebar
 * hiding is UX only; every route below still enforces its own permission
 * regardless of these flags.
 */
export interface NavVisibilityFlags {
  canViewAdminSubDepartments: boolean;
  canViewMyDepartments: boolean;
  canViewMySubDepartments: boolean;
  /** Gates the "Pending Tickets" sidebar entry — mirrors ticket.pending.view, department-scoped or global. */
  canViewPendingTickets: boolean;
}

export async function getNavVisibilityFlags(
  userId: string,
  role: Role,
  customRoleId?: string | null
): Promise<NavVisibilityFlags> {
  if (canViewAllDepartments(role)) {
    return {
      canViewAdminSubDepartments: true,
      canViewMyDepartments: true,
      canViewMySubDepartments: true,
      canViewPendingTickets: true,
    };
  }

  const [accessibleSubDeptDepartments, memberships, subDeptIds, pendingTicketDepartmentIds, globalPendingView] = await Promise.all([
    getAccessibleDepartmentSummaries(userId, role, "subdepartment.view"),
    getUserDepartmentMemberships(userId),
    getUserSubDepartmentIds(userId),
    getDepartmentIdsWithPermission(userId, "ticket.pending.view"),
    // A global-role grant (e.g. IT_AGENT) is independent of any department
    // membership — checked in addition to, not instead of, the
    // membership-based check above (which covers AGENT_ASSIGNEE etc.).
    hasPermission(role, "ticket.pending.view", customRoleId),
  ]);

  return {
    canViewAdminSubDepartments: accessibleSubDeptDepartments.length > 0,
    canViewMyDepartments: memberships.length > 0,
    canViewMySubDepartments: accessibleSubDeptDepartments.length > 0 || subDeptIds.length > 0,
    canViewPendingTickets: pendingTicketDepartmentIds.length > 0 || globalPendingView,
  };
}

/** Shared shape for Project/Activity list scoping — accessible department + permission key, no own/all split. */
async function buildEntityListWhere(
  userId: string,
  role: Role,
  permissionKey: string,
  requestedDepartmentId?: string | null
): Promise<Record<string, unknown> | ScopeDenial> {
  if (canViewAllDepartments(role)) {
    return requestedDepartmentId ? { departmentId: requestedDepartmentId } : {};
  }

  const accessible = await getDepartmentIdsWithPermission(userId, permissionKey);
  const legacyId = await getDefaultLegacyDepartmentId();
  const includeLegacy = legacyId != null && accessible.includes(legacyId);

  if (requestedDepartmentId) {
    if (!accessible.includes(requestedDepartmentId)) return { denied: "invalid_department" };
    if (legacyId !== requestedDepartmentId) return { departmentId: requestedDepartmentId };
    return { OR: [{ departmentId: requestedDepartmentId }, { departmentId: null }] };
  }

  if (accessible.length === 0) return NO_MATCH_WHERE;
  return includeLegacy
    ? { OR: [{ departmentId: { in: accessible } }, { departmentId: null }] }
    : { departmentId: { in: accessible } };
}

/**
 * "Assigned to Me" / "Created by Me" ticket scoping — no permission check,
 * seeing your own assigned/created tickets needs no department membership
 * (same "isOwner" philosophy as canActOnEntity above). An optional department
 * id just narrows an already-personal result set further; it never grants
 * cross-department visibility on its own.
 */
export function buildAssignedToMeWhere(userId: string, requestedDepartmentId?: string | null) {
  return requestedDepartmentId
    ? { assignedAgentId: userId, departmentId: requestedDepartmentId }
    : { assignedAgentId: userId };
}

export function buildCreatedByMeWhere(userId: string, requestedDepartmentId?: string | null) {
  return requestedDepartmentId
    ? { requesterId: userId, departmentId: requestedDepartmentId }
    : { requesterId: userId };
}

export async function buildProjectListWhere(userId: string, role: Role, requestedDepartmentId?: string | null) {
  return buildEntityListWhere(userId, role, "project.view", requestedDepartmentId);
}

export async function buildActivityListWhere(userId: string, role: Role, requestedDepartmentId?: string | null) {
  return buildEntityListWhere(userId, role, "activity.view", requestedDepartmentId);
}

/**
 * PendingTicket list scoping — same shape as buildProjectListWhere, gated by
 * ticket.pending.view. ADMIN/Director's branch already returns `{}` (no
 * filter), which includes departmentId: null rows for free — exactly the
 * "unmatched pending tickets are Admin/Director-only" rule the plan calls
 * for, with no special-casing needed here.
 */
export async function buildPendingTicketListWhere(userId: string, role: Role, requestedDepartmentId?: string | null) {
  return buildEntityListWhere(userId, role, "ticket.pending.view", requestedDepartmentId);
}

/**
 * Resource Planning scoping — same shape as buildProjectListWhere/
 * buildActivityListWhere, gated by resourcePlanning.view. The resulting
 * {departmentId: ...} where is applied directly to ProjectActivity queries.
 */
export async function buildResourcePlanningWhere(userId: string, role: Role, requestedDepartmentId?: string | null) {
  return buildEntityListWhere(userId, role, "resourcePlanning.view", requestedDepartmentId);
}

/**
 * Gate for acting on a single already-fetched entity (ticket/project/activity
 * detail GET, PATCH, assign, status-change). `isOwner` (e.g. ticket
 * requester) short-circuits true before any department lookup — the
 * existing self-service bypass, preserved exactly as it worked pre-Phase-2A.
 * A null entityDepartmentId (legacy row) falls back to the default legacy
 * department; if that isn't configured either, access is denied rather than
 * guessed at.
 */
export async function canActOnEntity(
  userId: string,
  role: Role,
  entityDepartmentId: string | null,
  permissionKey: string,
  isOwner: boolean = false
): Promise<boolean> {
  if (isOwner) return true;
  if (canViewAllDepartments(role)) return true;

  const effectiveDeptId = entityDepartmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDeptId) return false;

  const membership = await getMembership(userId, effectiveDeptId);
  if (!membership) return false;

  return hasDepartmentPermission(membership.role, permissionKey, membership.customRoleId);
}

/**
 * Resolves the single department a new Ticket/Project/Activity should be
 * created in. An explicit requestedDepartmentId is validated against real
 * membership + the given permission key (ADMIN bypasses). Omitted -> falls
 * back to the active workspace (Phase 1's resolveActiveWorkspace); ADMIN
 * omitting it is treated as ambiguous on purpose (an admin isn't a member of
 * any one department to default to) rather than guessed at.
 */
export async function resolveDepartmentForCreate(
  userId: string,
  role: Role,
  requestedDepartmentId: string | null | undefined,
  permissionKey: string
): Promise<{ departmentId: string } | CreateDenial> {
  if (requestedDepartmentId) {
    if (canViewAllDepartments(role)) return { departmentId: requestedDepartmentId };
    const membership = await getMembership(userId, requestedDepartmentId);
    if (!membership) return { denied: "invalid_department" };
    const allowed = await hasDepartmentPermission(membership.role, permissionKey, membership.customRoleId);
    if (!allowed) return { denied: "invalid_department" };
    return { departmentId: requestedDepartmentId };
  }

  if (canViewAllDepartments(role)) return { denied: "workspace_required" };

  const workspace = await resolveActiveWorkspace(userId, role);
  if (!workspace.departmentId) {
    return { denied: workspace.departments.length === 0 ? "pending_setup" : "workspace_required" };
  }

  const membership = await getMembership(userId, workspace.departmentId);
  if (!membership) return { denied: "pending_setup" };
  const allowed = await hasDepartmentPermission(membership.role, permissionKey, membership.customRoleId);
  if (!allowed) return { denied: "invalid_department" };
  return { departmentId: workspace.departmentId };
}

export type TicketLinkValidation =
  | { ok: true }
  | {
      ok: false;
      code: "project_not_found" | "activity_not_found" | "invalid_project_scope" | "invalid_activity_scope" | "invalid_project_activity_pair";
      message: string;
    };

/**
 * Validates a ticket's (final, already-resolved — not partial/undefined)
 * projectId/activityId pair against the ticket's own department — shared by
 * ticket creation (POST /api/tickets) and editing (PATCH /api/tickets/[id])
 * so the two paths can never disagree on what's a valid link. Mirrors the
 * activity-scope-checking pattern already used for an activity's OWN project
 * link in app/api/activities/[id]/route.ts.
 *
 * - A project must exist and belong to this department.
 * - An activity must exist; a null activity.departmentId (legacy/unscoped)
 *   is treated as compatible with any department, same leniency
 *   TicketDepartmentEditor's stillValid check already applies to category/
 *   priority/cancelReason.
 * - If the activity itself belongs to a specific project, the ticket's
 *   resolved projectId must match it exactly (never silently auto-filled —
 *   Create Ticket's form doesn't do that either, so validation matches
 *   existing behavior rather than inventing new leniency).
 */
export async function validateTicketProjectActivityLink(
  departmentId: string,
  projectId: string | null,
  activityId: string | null
): Promise<TicketLinkValidation> {
  if (projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { departmentId: true } });
    if (!project) return { ok: false, code: "project_not_found", message: "Project not found." };
    if (project.departmentId !== departmentId) {
      return { ok: false, code: "invalid_project_scope", message: "The selected project belongs to a different department." };
    }
  }

  if (activityId) {
    const activity = await prisma.projectActivity.findUnique({ where: { id: activityId }, select: { departmentId: true, projectId: true } });
    if (!activity) return { ok: false, code: "activity_not_found", message: "Activity not found." };
    if (activity.departmentId && activity.departmentId !== departmentId) {
      return { ok: false, code: "invalid_activity_scope", message: "The selected activity belongs to a different department." };
    }
    if (activity.projectId && activity.projectId !== projectId) {
      return { ok: false, code: "invalid_project_activity_pair", message: "The selected activity does not belong to the selected project." };
    }
  }

  return { ok: true };
}
