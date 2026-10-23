"use client";

import Link from "next/link";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PriorityBadge } from "@/components/tickets/ticket-badge";
import { formatTicketNumber, getInitials } from "@/lib/utils";
import { MessageSquare, Paperclip } from "lucide-react";

export interface KanbanTicket {
  id: string;
  ticketNumber: number;
  title: string;
  status: { id: string; name: string; color: string };
  priority: { id: string; name: string; color: string; level: number } | null;
  requester: { id: string; name: string | null; email: string; image: string | null };
  assignedAgent: { id: string; name: string | null; email: string; image: string | null } | null;
  _count: { messages: number; attachments: number };
}

interface TicketKanbanCardProps {
  ticket: KanbanTicket;
  /** False for a ticket this viewer may not drag (no ticket.changeStatus for the department, and not the ticket's own requester) — still a plain, clickable card. */
  draggable: boolean;
}

/**
 * One board card — the whole card surface is the drag affordance (unlike
 * ProjectActivitySequenceCard's dedicated grip handle: a Kanban card
 * conventionally drags by the card itself). Disambiguated from a plain click
 * through to the ticket by PointerSensor's own activationConstraint
 * (distance threshold) on the DndContext in TicketKanbanBoard, not by a
 * separate handle element.
 */
export function TicketKanbanCard({ ticket, draggable }: TicketKanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: ticket.id,
    disabled: !draggable,
  });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      className={`rounded-lg border bg-card transition-colors ${
        isDragging ? "opacity-60 shadow-lg z-10 relative" : "hover:bg-muted/50"
      } ${draggable ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
    >
      <Link href={`/tickets/${ticket.id}`} className="block p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] font-medium text-primary">
            {formatTicketNumber(ticket.ticketNumber)}
          </span>
          {ticket.priority && (
            <PriorityBadge name={ticket.priority.name} color={ticket.priority.color} level={ticket.priority.level} />
          )}
        </div>
        <p className="text-sm font-medium leading-snug line-clamp-2">{ticket.title}</p>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Avatar className="h-5 w-5 flex-shrink-0">
              <AvatarImage src={ticket.requester.image ?? undefined} />
              <AvatarFallback className="text-[9px]">{getInitials(ticket.requester.name)}</AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate">
              {ticket.requester.name ?? ticket.requester.email}
            </span>
          </div>
          {ticket.assignedAgent && (
            <Avatar className="h-5 w-5 flex-shrink-0 ring-2 ring-background">
              <AvatarImage src={ticket.assignedAgent.image ?? undefined} />
              <AvatarFallback className="text-[9px]">{getInitials(ticket.assignedAgent.name)}</AvatarFallback>
            </Avatar>
          )}
        </div>
        {(ticket._count.messages > 0 || ticket._count.attachments > 0) && (
          <div className="flex items-center gap-3 pt-0.5">
            {ticket._count.messages > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <MessageSquare className="h-3 w-3" />
                {ticket._count.messages}
              </span>
            )}
            {ticket._count.attachments > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Paperclip className="h-3 w-3" />
                {ticket._count.attachments}
              </span>
            )}
          </div>
        )}
      </Link>
    </div>
  );
}
