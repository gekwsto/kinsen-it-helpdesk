"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { DndContext, type DragEndEvent, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import { TicketKanbanColumn } from "@/components/tickets/ticket-kanban-column";
import { type KanbanTicket } from "@/components/tickets/ticket-kanban-card";

interface KanbanStatus {
  /** Real statusId(s) this column represents — always exactly one entry here, since the board is only ever rendered for a single selected department (see app/(main)/tickets/page.tsx's boardDisabled). */
  ids: string[];
  name: string;
  color: string;
}

interface BoardColumnData {
  statusId: string;
  tickets: KanbanTicket[];
  total: number;
}

interface ColumnState {
  tickets: KanbanTicket[];
  total: number;
  page: number;
  loadingMore: boolean;
}

interface TicketKanbanBoardProps {
  columns: BoardColumnData[];
  statuses: KanbanStatus[];
  departmentId: string;
  /** Department-level half of "who may drag" (ticket.changeStatus for this department) — the per-ticket requester-owner bypass is evaluated per card below. */
  canChangeStatusBase: boolean;
  currentUserId: string;
  /** Page size each column was initially loaded with — "Load more" requests the next page at the same size. */
  pageSize: number;
}

function buildColumnsState(columns: BoardColumnData[]): Map<string, ColumnState> {
  return new Map(columns.map((c) => [c.statusId, { tickets: c.tickets, total: c.total, page: 1, loadingMore: false }]));
}

/**
 * Cross-column Kanban board — the first multi-container dnd-kit usage in
 * this codebase (the one prior usage, ProjectActivitySequenceCard, is a
 * single-list reorder via SortableContext, a different shape of problem).
 * Each column is an independent useDroppable zone with its OWN pagination
 * (initial page + "Load more", via the existing GET /api/tickets endpoint —
 * no new API route), rather than one big unpaginated/capped fetch: a
 * department with hundreds of tickets in one status never silently
 * truncates, it just paginates that column like any other list in this app.
 */
export function TicketKanbanBoard({ columns, statuses, departmentId, canChangeStatusBase, currentUserId, pageSize }: TicketKanbanBoardProps) {
  const searchParams = useSearchParams();
  const [columnState, setColumnState] = useState<Map<string, ColumnState>>(() => buildColumnsState(columns));

  // Re-seed whenever a fresh server fetch hands down new columns (a
  // filter/search/department change navigates and re-renders this page).
  useEffect(() => {
    setColumnState(buildColumnsState(columns));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, departmentId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const canDrag = (ticket: KanbanTicket) => canChangeStatusBase || ticket.requester.id === currentUserId;

  const loadMore = async (statusId: string) => {
    const current = columnState.get(statusId);
    if (!current || current.loadingMore) return;
    setColumnState((prev) => new Map(prev).set(statusId, { ...current, loadingMore: true }));

    // Same filters currently active on the page (search/priority/category/
    // source/date/assignee/etc. — whatever's already in the URL), with
    // `statusId` overridden to THIS column and `page`/`pageSize` replaced by
    // this column's own pagination — reuses the existing, already-scoped
    // GET /api/tickets endpoint rather than a new one. The page's own sort
    // control writes `sortOrder` (see ticket-filters.tsx) but
    // GET /api/tickets reads `sortDir` for the same thing — translated here
    // so a column's "Load more" continues in the EXACT same order as the
    // initial server-rendered page (both ultimately resolve through the
    // same TICKET_SORT_KEYS/id-tiebreaker machinery — see that route's own
    // orderBy comment for why a mismatch here would reintroduce duplicate
    // or skipped rows across pages).
    const params = new URLSearchParams(searchParams.toString());
    const sortOrder = params.get("sortOrder");
    params.delete("sortOrder");
    if (sortOrder) params.set("sortDir", sortOrder);
    params.set("statusId", statusId);
    params.set("departmentId", departmentId);
    params.set("page", String(current.page + 1));
    params.set("limit", String(pageSize));
    params.delete("view");

    try {
      const res = await fetch(`/api/tickets?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load more tickets");
      const data = await res.json();
      setColumnState((prev) => {
        const next = new Map(prev);
        const existing = next.get(statusId);
        if (!existing) return prev;
        next.set(statusId, {
          tickets: [...existing.tickets, ...(data.tickets ?? [])],
          total: existing.total,
          page: existing.page + 1,
          loadingMore: false,
        });
        return next;
      });
    } catch (error: any) {
      setColumnState((prev) => new Map(prev).set(statusId, { ...current, loadingMore: false }));
      toast.error(error.message ?? "Failed to load more tickets");
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return; // dropped outside any column

    const ticketId = String(active.id);
    const newStatusId = String(over.id);

    let movedTicket: KanbanTicket | undefined;
    let fromStatusId: string | undefined;
    for (const [statusId, col] of columnState) {
      const found = col.tickets.find((t) => t.id === ticketId);
      if (found) {
        movedTicket = found;
        fromStatusId = statusId;
        break;
      }
    }
    if (!movedTicket || !fromStatusId || fromStatusId === newStatusId) return;

    const previousState = columnState;
    const nextState = new Map(columnState);
    const fromCol = nextState.get(fromStatusId)!;
    const toCol = nextState.get(newStatusId);
    if (!toCol) return;
    nextState.set(fromStatusId, { ...fromCol, tickets: fromCol.tickets.filter((t) => t.id !== ticketId), total: Math.max(0, fromCol.total - 1) });
    nextState.set(newStatusId, {
      ...toCol,
      tickets: [{ ...movedTicket, status: { ...movedTicket.status, id: newStatusId } }, ...toCol.tickets],
      total: toCol.total + 1,
    });
    setColumnState(nextState);

    try {
      const res = await fetch(`/api/tickets/${ticketId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusId: newStatusId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update ticket status");
      }
    } catch (error: any) {
      setColumnState(previousState);
      toast.error(error.message ?? "Failed to update ticket status");
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {statuses.map((status) => {
          const statusId = status.ids[0];
          const state = columnState.get(statusId) ?? { tickets: [], total: 0, page: 1, loadingMore: false };
          return (
            <TicketKanbanColumn
              key={statusId}
              statusId={statusId}
              name={status.name}
              color={status.color}
              tickets={state.tickets}
              total={state.total}
              loadingMore={state.loadingMore}
              onLoadMore={() => loadMore(statusId)}
              canDrag={canDrag}
            />
          );
        })}
      </div>
    </DndContext>
  );
}
