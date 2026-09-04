"use client";

import { useRouter } from "next/navigation";
import { useTicketListRealtime } from "@/hooks/use-ticket-list-realtime";

/**
 * Mount ONCE per ticket-list page (Tickets, Assigned to Me, Created by Me,
 * Closed Tickets — every page whose data comes from the shared Ticket
 * query architecture, i.e. buildTicketListWhere/buildAssignedToMeWhere/
 * buildCreatedByMeWhere). Renders nothing.
 *
 * On a debounced TICKETS_CHANGED signal, calls router.refresh() — this
 * re-runs the SAME Server Component page with its EXACT current URL
 * (searchParams: filters, search, sort, page, pageSize all untouched),
 * re-executing its real server-side authorization/scope/filter query from
 * scratch. Nothing from the realtime channel is ever trusted or merged into
 * the list directly — this is purely an invalidation signal. Per Next.js's
 * own router.refresh() semantics, this never causes a full page
 * navigation/reload, never resets client-side component state (open
 * dropdowns, unrelated form inputs, scroll position) elsewhere on the page,
 * and never flashes — only the Server Component payload is re-fetched and
 * reconciled in place.
 */
export function TicketListLiveRefresh() {
  const router = useRouter();
  useTicketListRealtime(() => router.refresh());
  return null;
}
