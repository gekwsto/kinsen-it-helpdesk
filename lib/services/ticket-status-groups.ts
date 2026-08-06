/**
 * The single shared definition of each ticket "status group" — used
 * identically by the Tickets Dashboard's KPI counts (app/(main)/dashboard/page.tsx)
 * and the All Tickets list's `?status=` filter (app/(main)/tickets/page.tsx),
 * so a dashboard card's count and what clicking it actually shows can never
 * silently disagree. TicketStatus is a per-department, DB-configurable table
 * (no global enum/slug — see prisma/schema.prisma's TicketStatus model), so
 * "open"/"closed" are the isClosed boolean and "in progress" is a
 * name-contains match — the same fragile-but-only-available signal the
 * dashboard already relied on before this file existed; not invented here,
 * just centralized so it's defined in exactly one place.
 */
export type TicketStatusGroup = "all" | "open" | "in_progress" | "closed";

const VALID_GROUPS: readonly TicketStatusGroup[] = ["all", "open", "in_progress", "closed"];

/** Strict parse — any value other than the 4 canonical group names (including typos/garbage) is treated as absent, never guessed at. */
export function parseTicketStatusGroup(raw: string | string[] | undefined): TicketStatusGroup | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return (VALID_GROUPS as readonly string[]).includes(value) ? (value as TicketStatusGroup) : null;
}

/** `undefined` means "no extra condition" (the `all` group) — spread it into a where object, never AND an empty/undefined clause in. */
export function buildTicketStatusGroupCondition(group: TicketStatusGroup): Record<string, unknown> | undefined {
  switch (group) {
    case "all":
      return undefined;
    case "open":
      return { status: { isClosed: false } };
    case "in_progress":
      return { status: { name: { contains: "Progress", mode: "insensitive" } } };
    case "closed":
      return { status: { isClosed: true } };
  }
}

export const TICKET_STATUS_GROUP_LABEL: Record<TicketStatusGroup, string> = {
  all: "All statuses",
  open: "Open",
  in_progress: "In Progress",
  closed: "Closed",
};
