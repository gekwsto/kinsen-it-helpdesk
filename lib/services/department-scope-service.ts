import { DepartmentRole, Role } from "@prisma/client";
import { getUserDepartmentMemberships, getMembership } from "@/lib/services/department-membership-service";
import { getDefaultLegacyDepartmentId, listDepartments, toDepartmentSummary } from "@/lib/services/department-service";
import { resolveActiveWorkspace } from "@/lib/services/workspace-service";
import { hasDepartmentPermission, canViewAllDepartments } from "@/lib/permissions";
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
    if (await hasDepartmentPermission(m.role, permissionKey)) ids.push(m.departmentId);
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
    if (await hasDepartmentPermission(m.role, permissionKey)) result.push(m.department);
  }
  return result;
}

/** Splits a user's ticket-viewable departments into "sees everyone's tickets" vs "own tickets only" (DepartmentRole.REQUESTER). */
async function splitTicketViewScope(userId: string): Promise<{ fullView: string[]; ownOnly: string[] }> {
  const memberships = await getUserDepartmentMemberships(userId);
  const fullView: string[] = [];
  const ownOnly: string[] = [];
  for (const m of memberships) {
    const allowed = await hasDepartmentPermission(m.role, "ticket.view");
    if (!allowed) continue;
    if (m.role === DepartmentRole.REQUESTER) ownOnly.push(m.departmentId);
    else fullView.push(m.departmentId);
  }
  return { fullView, ownOnly };
}

/**
 * Category visibility: global (departmentId: null) categories plus the
 * given department's own — never another department's. Pass null for
 * departmentId (e.g. a legacy ticket with no department) to see only
 * global categories.
 */
export function buildCategoryWhere(departmentId: string | null): Record<string, unknown> {
  return departmentId ? { OR: [{ departmentId: null }, { departmentId }] } : { departmentId: null };
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

    const base = isFull
      ? { departmentId: requestedDepartmentId }
      : { departmentId: requestedDepartmentId, requesterId: userId };
    if (legacyId !== requestedDepartmentId) return base;

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
    if (legacyId && ownOnly.includes(legacyId)) orClauses.push({ departmentId: null, requesterId: userId });
  }

  if (orClauses.length === 0) return NO_MATCH_WHERE;
  return orClauses.length === 1 ? orClauses[0] : { OR: orClauses };
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

  return hasDepartmentPermission(membership.role, permissionKey);
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
    const allowed = await hasDepartmentPermission(membership.role, permissionKey);
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
  const allowed = await hasDepartmentPermission(membership.role, permissionKey);
  if (!allowed) return { denied: "invalid_department" };
  return { departmentId: workspace.departmentId };
}
