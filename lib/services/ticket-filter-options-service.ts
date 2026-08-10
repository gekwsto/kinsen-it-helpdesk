import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";

/**
 * A Status/Priority/Category filter option for a ticket list dropdown.
 * `ids` holds every real TicketStatus/TicketPriority/TicketCategory row this
 * option represents — a single id when scoped to one department, several
 * when the same `name` is configured in more than one department the caller
 * is authorized to see (the "All Workspaces" union). `value` is `ids`
 * joined with "," — the <Select> value / URL param — so a ticket-list query
 * always matches by real FK id(s) (`statusId IN (...)`), never by comparing
 * display text against ticket data.
 */
export interface TicketFilterOption {
  ids: string[];
  value: string;
  name: string;
  color: string;
  level?: number;
}

export interface TicketFilterOptionSets {
  statuses: TicketFilterOption[];
  priorities: TicketFilterOption[];
  categories: TicketFilterOption[];
}

type NamedRow = { id: string; name: string; color: string; level?: number };

/**
 * Groups department-scoped config rows by `name` into filter options —
 * TicketStatus/TicketPriority/TicketCategory are each unique only WITHIN a
 * department (`@@unique([departmentId, name])`), so the exact same name can
 * legitimately exist as several distinct rows across departments. Rows
 * arrive pre-sorted by the caller's own `orderBy` (status.order /
 * priority.level desc / category.name); the first occurrence of a name
 * therefore also fixes that option's position, preserving configured
 * ordering instead of falling back to alphabetical.
 */
function groupByName(rows: NamedRow[]): TicketFilterOption[] {
  const order: string[] = [];
  const byName = new Map<string, { ids: string[]; color: string; level?: number }>();
  for (const row of rows) {
    let group = byName.get(row.name);
    if (!group) {
      group = { ids: [], color: row.color, level: row.level };
      byName.set(row.name, group);
      order.push(row.name);
    }
    group.ids.push(row.id);
  }
  return order.map((name) => {
    const group = byName.get(name)!;
    return { ids: group.ids, value: group.ids.join(","), name, color: group.color, level: group.level };
  });
}

/**
 * The department id set a filter-options query should scope to: exactly
 * `[effectiveDepartmentId]` for a specific workspace, or every department
 * the caller may view tickets in for "All Workspaces" — never a blind
 * "every department in the system" query. Mirrors the same
 * `getAccessibleDepartmentSummaries(..., "ticket.view")` permission check
 * already used for this page's Department filter dropdown, so a user can
 * never receive status/priority/category options sourced exclusively from a
 * department they aren't authorized to view tickets in.
 */
async function resolveScopeDepartmentIds(
  effectiveDepartmentId: string | null | undefined,
  userId: string,
  role: Role
): Promise<string[]> {
  if (effectiveDepartmentId) return [effectiveDepartmentId];
  const accessible = await getAccessibleDepartmentSummaries(userId, role, "ticket.view");
  return accessible.map((d) => d.id);
}

/**
 * Workspace-scoped Status/Priority/Category filter options for a ticket
 * list page — the authoritative replacement for a bare
 * `prisma.ticketStatus.findMany({ where: { isActive: true } })`. That query
 * silently spans every department in the system: TicketStatus,
 * TicketPriority and TicketCategory are all department-owned config tables
 * (each seeded per-department by createDepartment()), so an unscoped query
 * returns one row per department that happens to share a name — the "Open /
 * Open / Open" duplicate-dropdown bug. Scoping by departmentId (or
 * the accessible-department union for "All Workspaces") is sufficient on
 * its own for a specific workspace, since `@@unique([departmentId, name])`
 * already guarantees no duplicate names within one department; the
 * `groupByName` step only does real work in the multi-department union
 * case.
 *
 * A single small, bounded, permission-scoped query per axis — never one
 * query per status/priority/category, and never a fetch of ticket rows to
 * derive options from.
 */
export async function getTicketFilterOptions(
  effectiveDepartmentId: string | null | undefined,
  userId: string,
  role: Role,
  options: { statusWhere?: Record<string, unknown> } = {}
): Promise<TicketFilterOptionSets> {
  const departmentIds = await resolveScopeDepartmentIds(effectiveDepartmentId, userId, role);
  if (departmentIds.length === 0) return { statuses: [], priorities: [], categories: [] };

  const [statusRows, priorityRows, categoryRows] = await Promise.all([
    prisma.ticketStatus.findMany({
      where: { departmentId: { in: departmentIds }, isActive: true, ...options.statusWhere },
      orderBy: { order: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.ticketPriority.findMany({
      where: { departmentId: { in: departmentIds }, isActive: true },
      orderBy: { level: "desc" },
      select: { id: true, name: true, color: true, level: true },
    }),
    prisma.ticketCategory.findMany({
      where: { departmentId: { in: departmentIds }, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  return {
    statuses: groupByName(statusRows),
    priorities: groupByName(priorityRows),
    categories: groupByName(categoryRows),
  };
}

/** Splits a `statusId`/`priorityId`/`categoryId` URL param — a single id, or several comma-joined ids from a grouped "All Workspaces" selection — back into individual real ids for a Prisma `{ in: [...] }` filter. */
export function splitFilterParam(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const FILTER_MODEL = {
  status: prisma.ticketStatus,
  priority: prisma.ticketPriority,
  category: prisma.ticketCategory,
} as const;

/**
 * Reconciles a previously-selected statusId/priorityId/categoryId URL value
 * against the freshly-scoped option set for a just-switched workspace.
 * Returns:
 *  - the SAME value, unchanged, if every id it references is still one of
 *    the fresh scope's ids (the common case — nothing to correct);
 *  - a DIFFERENT value if the selection's underlying row(s) no longer
 *    exist in the fresh scope but the same-NAMED option does (e.g.
 *    switching Workspace A -> B, both configure "Open" as independent
 *    per-department rows) — the selection is carried over by matching
 *    name, so a still-meaningful choice like "Open" survives a workspace
 *    switch instead of silently resetting;
 *  - null if the selection no longer applies at all (its name doesn't
 *    exist in the fresh scope, e.g. "In Progress" selected but the new
 *    workspace has no such status) — callers must remove the URL param
 *    entirely rather than keep a stale/invalid filter silently active.
 *
 * Matching "the same conceptual selection" across a department switch is
 * necessarily by option NAME — TicketStatus/TicketPriority/TicketCategory
 * rows are independently owned per department (`@@unique([departmentId,
 * name])`), so a literal id from department A never exists in department
 * B's rows. The name lookup here is only a bridge to find the NEW scope's
 * real id(s) for that name; the value that actually flows into the ticket
 * list's Prisma `where` clause is always a real FK id (or id set), never a
 * name string comparison.
 */
export async function reconcileTicketFilterParam(
  kind: keyof typeof FILTER_MODEL,
  currentValue: string | undefined,
  freshOptions: TicketFilterOption[]
): Promise<string | null> {
  if (!currentValue) return null;
  const currentIds = splitFilterParam(currentValue);
  if (currentIds.length === 0) return null;

  const freshIdSet = new Set(freshOptions.flatMap((o) => o.ids));
  if (currentIds.every((id) => freshIdSet.has(id))) return currentValue;

  const model = FILTER_MODEL[kind] as { findFirst: (args: unknown) => Promise<{ name: string } | null> };
  const previous = await model.findFirst({ where: { id: { in: currentIds } }, select: { name: true } });
  if (!previous) return null;

  const match = freshOptions.find((o) => o.name === previous.name);
  return match ? match.value : null;
}
