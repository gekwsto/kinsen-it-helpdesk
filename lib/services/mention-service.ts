/**
 * Shared @mention ELIGIBILITY architecture for Note @mentions across all
 * three note surfaces (Ticket internal notes, Project Notes, Activity
 * Notes) — the ONE implementation every route/component in this feature
 * calls into for "who can be mentioned here", rather than three
 * independent copies. See prisma/schema.prisma's TicketMessageMention doc
 * comment for why the storage itself is still three small per-entity join
 * tables even though this service is shared. Deliberately has NO
 * dependency on the notification-sending path (see
 * lib/services/mention-notification-service.ts's notifyNewMentions,
 * exported separately) — this file is pure eligibility/DB logic, safe to
 * import anywhere the notification path's own dependencies (web-push)
 * aren't wanted.
 *
 * SECURITY MODEL (the part of this file that must never be weakened):
 *   - A mention is a reference + notification only. It never grants access
 *     to anything.
 *   - Eligibility ("can user X be mentioned in a note about entity Y") is
 *     always "can user X currently VIEW entity Y", answered by the exact
 *     canonical resolvers every other read path in this app already uses —
 *     canViewTicket for tickets, hasEffectiveEntityPermission(...,
 *     "project.view"/"activity.view") for projects/activities (the union of
 *     a global role/custom-role grant and an active DepartmentMembership/
 *     custom Department role grant FOR THAT ENTITY'S OWN department — never
 *     a bare canActOnEntity call, which alone silently ignores a candidate's
 *     global grant). Never approximated by a raw role-name check.
 *   - Two layers, both real, neither trusted alone:
 *       1. searchMentionCandidates — UX convenience for the picker. Uses a
 *          broad, cheap SQL prefilter (same "never misses anyone" idiom
 *          lib/services/assignment-eligibility-service.ts already
 *          established for `<entity>.assignable`, generalized here to
 *          `<entity>.view`) to gather a small, plausible candidate pool
 *          matching the typed query text, then runs the SAME canonical
 *          per-candidate check as layer 2 on that (already small) pool.
 *          This is not an approximation of the real check — it IS the real
 *          check, just applied to a bounded, query-narrowed candidate set
 *          instead of the whole user table, which is what keeps it cheap.
 *       2. resolveEligibleMentionUsers — the ACTUAL security boundary, run
 *          again at Note/message create time against whatever userIds the
 *          client submitted. A client-submitted id that fails the same
 *          canonical check is silently dropped — never persisted as a
 *          mention, never notified. A crafted request naming an
 *          unauthorized user's id can therefore never turn them into an
 *          authorized viewer, or even into a recorded mention.
 */
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole } from "@prisma/client";
import { canViewTicket, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { DEPARTMENT_ROLE_OPTIONS } from "@/lib/services/department-role-translation";

export type MentionEntityType = "ticket" | "project" | "activity";

export interface MentionCandidate {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface CandidateRow extends MentionCandidate {
  role: Role;
  customRoleId: string | null;
}

interface TicketViewContext {
  departmentId: string | null;
  subDepartmentId: string | null;
  requesterId: string;
  assignedAgentId: string | null;
  shareWithDepartment: boolean;
  shareWithSubDepartment: boolean;
}

const GLOBAL_ROLE_ENUM_VALUES = new Set<string>(Object.values(Role));
const DEPARTMENT_ROLE_ENUM_VALUES = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);

/** Every roleKey (built-in Role/DepartmentRole strings, plus admin-created custom-role keys) currently granting the given permission — same shape as assignment-eligibility-service's own getRoleKeysWithAssignablePermission, generalized to any permission key rather than hardcoded to `<entity>.assignable`. */
async function getRoleKeysWithPermission(permissionKey: string) {
  const rows = await prisma.rolePermission.findMany({
    where: { permission: { key: permissionKey } },
    select: { roleKey: true },
  });
  const roleKeys = rows.map((r) => r.roleKey);
  return {
    departmentRoles: roleKeys.filter((k): k is DepartmentRole => DEPARTMENT_ROLE_ENUM_VALUES.has(k)),
    // ADMIN and DIRECTOR always included regardless of an explicit grant —
    // canViewAllDepartments(role) bypasses the permission check entirely
    // for both inside canActOnEntity/canViewTicket, so excluding either
    // here would just mean the per-candidate check re-adds them anyway;
    // including them up front keeps the prefilter's own "never misses
    // anyone" contract honest without a special case at the call site.
    globalRoles: Array.from(
      new Set<Role>([Role.ADMIN, Role.DIRECTOR, ...roleKeys.filter((k): k is Role => GLOBAL_ROLE_ENUM_VALUES.has(k))])
    ),
    allRoleKeys: roleKeys,
  };
}

/** Text-search WHERE fragment — display name or email, case-insensitive. Empty/whitespace-only query matches everyone in the (already access-scoped) candidate pool. */
function queryFilter(query: string | undefined) {
  const q = query?.trim();
  if (!q) return undefined;
  return {
    OR: [
      { name: { contains: q, mode: "insensitive" as const } },
      { email: { contains: q, mode: "insensitive" as const } },
    ],
  };
}

async function fetchCandidatePool(orConditions: Record<string, unknown>[], query: string | undefined, take: number): Promise<CandidateRow[]> {
  const qf = queryFilter(query);
  return prisma.user.findMany({
    where: {
      isActive: true,
      AND: [{ OR: orConditions }, ...(qf ? [qf] : [])],
    },
    select: { id: true, name: true, email: true, image: true, role: true, customRoleId: true },
    orderBy: { name: "asc" },
    take,
  });
}

async function loadTicketContext(ticketId: string): Promise<TicketViewContext | null> {
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      departmentId: true,
      subDepartmentId: true,
      requesterId: true,
      assignedAgentId: true,
      shareWithDepartment: true,
      shareWithSubDepartment: true,
    },
  });
}

async function loadProjectDepartmentId(projectId: string): Promise<string | null | undefined> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { departmentId: true } });
  return project?.departmentId;
}

async function loadActivityDepartmentId(activityId: string): Promise<string | null | undefined> {
  const activity = await prisma.projectActivity.findUnique({ where: { id: activityId }, select: { departmentId: true } });
  return activity?.departmentId;
}

/** Broad, cheap candidate pool for a project/activity — a superset of who hasEffectiveEntityPermission(..., viewKey) could possibly say yes to (built-in/global-custom-role grants AND department-scoped grants for this entity's own department alike). */
async function buildProjectOrActivityOrConditions(viewKey: string, departmentId: string | null): Promise<Record<string, unknown>[]> {
  const { departmentRoles, globalRoles, allRoleKeys } = await getRoleKeysWithPermission(viewKey);
  const effectiveDeptId = departmentId ?? (await getDefaultLegacyDepartmentId());

  const orConditions: Record<string, unknown>[] = [{ role: { in: globalRoles } }];
  if (allRoleKeys.length > 0) {
    orConditions.push({ customRole: { key: { in: allRoleKeys } } });
  }
  if (effectiveDeptId && departmentRoles.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId: effectiveDeptId, isActive: true, role: { in: departmentRoles } } } });
  }
  if (effectiveDeptId && allRoleKeys.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId: effectiveDeptId, isActive: true, customRole: { key: { in: allRoleKeys } } } } });
  }
  return orConditions;
}

/** Broad, cheap candidate pool for a ticket — direct parties (requester/assignee) plus anyone plausibly holding ticket.view globally or in the ticket's (real or legacy) department. */
async function buildTicketOrConditions(ticket: TicketViewContext): Promise<Record<string, unknown>[]> {
  const { departmentRoles, globalRoles, allRoleKeys } = await getRoleKeysWithPermission("ticket.view");
  const effectiveDeptId = ticket.departmentId ?? (await getDefaultLegacyDepartmentId());

  const directPartyIds = [ticket.requesterId, ticket.assignedAgentId].filter((id): id is string => !!id);
  const orConditions: Record<string, unknown>[] = [
    { role: { in: globalRoles } },
    { id: { in: directPartyIds } },
  ];
  if (allRoleKeys.length > 0) {
    orConditions.push({ customRole: { key: { in: allRoleKeys } } });
  }
  if (effectiveDeptId && departmentRoles.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId: effectiveDeptId, isActive: true, role: { in: departmentRoles } } } });
  }
  if (effectiveDeptId && allRoleKeys.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId: effectiveDeptId, isActive: true, customRole: { key: { in: allRoleKeys } } } } });
  }
  return orConditions;
}

async function candidateCanView(entityType: MentionEntityType, candidate: CandidateRow, ctx: { ticket?: TicketViewContext; departmentId?: string | null }): Promise<boolean> {
  if (entityType === "ticket") {
    return canViewTicket(candidate.id, candidate.role, ctx.ticket!);
  }
  // hasEffectiveEntityPermission, NOT bare canActOnEntity: canActOnEntity
  // alone only resolves canViewAllDepartments(role) (ADMIN/DIRECTOR) or an
  // active DepartmentMembership in the entity's own department — it never
  // consults the candidate's GLOBAL role/custom-role permission at all
  // (see hasEffectiveEntityPermission's own doc comment in
  // department-scope-service.ts). A candidate whose ONLY project.view/
  // activity.view grant comes from a built-in global Role or a global
  // CustomRole — no DepartmentMembership in this entity's department —
  // was therefore wrongly excluded from every Project/Activity mention
  // picker and from resolveEligibleMentionUsers, even though the exact
  // same candidate is correctly treated as an eligible VIEWER everywhere
  // else in the app (GET /api/projects/[id], GET /api/activities/[id],
  // etc., which already use this same composed resolver). Deliberately
  // NOT hasEffectiveModulePermission — that unions across ANY department
  // the candidate happens to hold the permission in, which would leak a
  // Department A grant into eligibility for a Department B entity; this
  // must stay scoped to THIS entity's own department, exactly like the
  // ticket.linkProjectActivity fix.
  const permKey = entityType === "project" ? "project.view" : "activity.view";
  return hasEffectiveEntityPermission(candidate.id, candidate.role, candidate.customRoleId, ctx.departmentId ?? null, permKey);
}

export interface SearchMentionCandidatesParams {
  entityType: MentionEntityType;
  entityId: string;
  query?: string;
  /** Max results returned to the picker. Capped hard regardless of caller input. */
  limit?: number;
}

/**
 * Layer 1 (UX only, never the security boundary — see module doc comment):
 * a small, query-matched, already-eligible candidate list for the mention
 * picker dropdown.
 */
export async function searchMentionCandidates(params: SearchMentionCandidatesParams): Promise<MentionCandidate[]> {
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  // Fetch a modest multiple of the requested limit so the per-candidate
  // authorization pass below still has enough plausible candidates left
  // after any prefilter over-inclusion is trimmed away.
  const poolSize = limit * 4;

  let orConditions: Record<string, unknown>[];
  let ctx: { ticket?: TicketViewContext; departmentId?: string | null };

  if (params.entityType === "ticket") {
    const ticket = await loadTicketContext(params.entityId);
    if (!ticket) return [];
    orConditions = await buildTicketOrConditions(ticket);
    ctx = { ticket };
  } else {
    const departmentId = params.entityType === "project"
      ? await loadProjectDepartmentId(params.entityId)
      : await loadActivityDepartmentId(params.entityId);
    if (departmentId === undefined) return []; // entity not found
    const viewKey = params.entityType === "project" ? "project.view" : "activity.view";
    orConditions = await buildProjectOrActivityOrConditions(viewKey, departmentId);
    ctx = { departmentId };
  }

  const pool = await fetchCandidatePool(orConditions, params.query, poolSize);

  const eligible: MentionCandidate[] = [];
  for (const candidate of pool) {
    if (eligible.length >= limit) break;
    if (await candidateCanView(params.entityType, candidate, ctx)) {
      eligible.push({ id: candidate.id, name: candidate.name, email: candidate.email, image: candidate.image });
    }
  }
  return eligible;
}

export interface ResolveEligibleMentionsParams {
  entityType: MentionEntityType;
  entityId: string;
  /** Raw, client-submitted candidate ids — NEVER trusted as-is. */
  requestedUserIds: string[];
}

/**
 * Layer 2 (the REAL security boundary): re-validates every client-submitted
 * mention id against the exact same canonical view-eligibility check,
 * independent of whatever the picker showed. Anything that fails — a
 * nonexistent id, an inactive user, or a real-but-ineligible user, however
 * it got into the request — is silently dropped: never persisted as a
 * mention, never notified. Deduplicates by construction (a Set input), so
 * the same id submitted twice yields exactly one result.
 */
export async function resolveEligibleMentionUsers(params: ResolveEligibleMentionsParams): Promise<MentionCandidate[]> {
  const uniqueIds = Array.from(new Set(params.requestedUserIds.filter((id) => typeof id === "string" && id.length > 0)));
  if (uniqueIds.length === 0) return [];

  let ctx: { ticket?: TicketViewContext; departmentId?: string | null };
  if (params.entityType === "ticket") {
    const ticket = await loadTicketContext(params.entityId);
    if (!ticket) return [];
    ctx = { ticket };
  } else {
    const departmentId = params.entityType === "project"
      ? await loadProjectDepartmentId(params.entityId)
      : await loadActivityDepartmentId(params.entityId);
    if (departmentId === undefined) return [];
    ctx = { departmentId };
  }

  const candidates = await prisma.user.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
    select: { id: true, name: true, email: true, image: true, role: true, customRoleId: true },
  });

  const eligible: MentionCandidate[] = [];
  for (const candidate of candidates) {
    if (await candidateCanView(params.entityType, candidate, ctx)) {
      eligible.push({ id: candidate.id, name: candidate.name, email: candidate.email, image: candidate.image });
    }
  }
  return eligible;
}

