"use client";

import { useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { TicketKanbanCard, type KanbanTicket } from "@/components/tickets/ticket-kanban-card";

interface TicketKanbanColumnProps {
  statusId: string;
  name: string;
  color: string;
  tickets: KanbanTicket[];
  /** Total matching tickets for this status (not just the ones currently loaded) — drives whether "Load more" shows. */
  total: number;
  loadingMore: boolean;
  onLoadMore: () => void;
  canDrag: (ticket: KanbanTicket) => boolean;
}

/**
 * One status column — stays visible (header + empty-state placeholder) even
 * with zero tickets, so the department's full configured status lineup is
 * always discoverable, not just the ones currently populated. Paginated
 * independently of every other column — see TicketKanbanBoard's own doc
 * comment for why (no single-fetch hard cap for the whole board).
 */
export function TicketKanbanColumn({ statusId, name, color, tickets, total, loadingMore, onLoadMore, canDrag }: TicketKanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: statusId });
  const hasMore = tickets.length < total;

  return (
    <div className="flex flex-col min-w-[260px] w-[260px] flex-shrink-0">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="text-sm font-semibold truncate">{name}</span>
        <span className="text-xs text-muted-foreground font-medium ml-auto">{total}</span>
      </div>
      <div
        ref={setNodeRef}
        data-kanban-column={statusId}
        className={`flex-1 space-y-2 rounded-lg border bg-muted/30 p-2 min-h-[120px] transition-colors ${
          isOver ? "border-primary bg-primary/5" : ""
        }`}
      >
        {tickets.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No tickets in this status</p>
        ) : (
          tickets.map((ticket) => (
            <TicketKanbanCard key={ticket.id} ticket={ticket} draggable={canDrag(ticket)} />
          ))
        )}
        {hasMore && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full h-8 text-xs text-muted-foreground"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Load more ({total - tickets.length} more)
          </Button>
        )}
      </div>
    </div>
  );
}
