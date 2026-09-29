import { type SortKeyDef } from "@/lib/list-sort";

/**
 * Whitelist for the Ticket lists' clickable column headers (/tickets,
 * /tickets/closed, /tickets/created-by-me, /tickets/assigned-to-me) — the
 * ONLY `sortBy` values ever accepted; anything else falls back to
 * TICKET_DEFAULT_ORDER_BY below untouched. See lib/list-sort.ts's own doc
 * comment for why this is never a dynamic `{ [sortBy]: order }` object —
 * that was this exact codebase's PREVIOUS pattern on all four of these
 * pages (a raw URL string used as a dynamic Prisma orderBy key, gated only
 * by two special-cased branches for priority/status), now replaced by this
 * explicit, pre-built-fragment whitelist, same as Projects/Activities.
 *
 * Shared across all four pages (rather than one copy per page, unlike
 * Projects/Activities' own single-page whitelists) because they render the
 * exact same TicketTable columns and must stay in sync — a `sortBy` value
 * valid on /tickets must behave identically on /tickets/closed, etc.
 *
 * Columns deliberately left OUT even though TicketTable renders them:
 *   - Source, Project, Dept. changed by: not in the requested sortable set,
 *     and the latter two are not simple/efficient single-column sorts.
 *   - The trailing View-action column: not a data column.
 * Department itself is not a column TicketTable renders at all (it's part
 * of the filter/scope, not a visible list column), so it isn't sortable.
 */
export const TICKET_SORT_KEYS: Record<string, SortKeyDef> = {
  ticketNumber: (order) => ({ ticketNumber: order }),
  title: (order) => ({ title: order }),
  // requester/assignedAgent sort by the user's display name. requester is a
  // required relation (every ticket has one); assignedAgent is optional. In
  // both cases `name` itself may be null (e.g. an account synced from
  // Microsoft before a display name was set) — Postgres's own default null
  // ordering (NULLS LAST for ASC, NULLS FIRST for DESC) applies, same as
  // PROJECT_SORT_KEYS' `department` entry; Prisma does not accept a `nulls`
  // modifier on a nested relation field, only on a scalar column of the
  // model being directly queried.
  requester: (order) => ({ requester: { name: order } }),
  assignedAgent: (order) => ({ assignedAgent: { name: order } }),
  status: (order) => ({ status: { order } }),
  priority: (order) => ({ priority: { level: order } }),
  category: (order) => ({ category: { name: order } }),
  createdAt: (order) => ({ createdAt: order }),
  // Not a TicketTable column header, but a pre-existing option in
  // TicketFilters' own "Sort by" dropdown (SORT_OPTIONS' "Last Updated") —
  // kept whitelisted, safely, so that control keeps working under this
  // same mechanism rather than silently falling back to the default.
  updatedAt: (order) => ({ updatedAt: order }),
};

// Matches the ordering every one of these pages already fell back to today
// (sortBy defaulting to "createdAt", sortDir to "desc") — preserved
// verbatim so an absent/invalid sortBy changes nothing about the default view.
export const TICKET_DEFAULT_ORDER_BY = [{ createdAt: "desc" as const }, { id: "asc" as const }];
