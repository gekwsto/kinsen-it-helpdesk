"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { PaginationControls } from "@/components/ui/pagination";
import type { PaginationMeta } from "@/lib/pagination";
import { StatusBadge, PriorityBadge, SourceBadge } from "@/components/tickets/ticket-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatTicketNumber, formatDateTime, getInitials } from "@/lib/utils";
import { Paperclip, MessageSquare, Inbox } from "lucide-react";

interface Ticket {
  id: string;
  ticketNumber: number;
  title: string;
  source: string;
  createdAt: string;
  requester: { name?: string | null; email: string; image?: string | null };
  assignedAgent?: { name?: string | null; email: string; image?: string | null } | null;
  status: { id: string; name: string; color: string };
  priority?: { id: string; name: string; color: string; level: number } | null;
  category?: { id: string; name: string; color: string } | null;
  department?: { id: string; name: string } | null;
  project?: { id: string; title: string } | null;
  departmentChangedBy?: { id: string; name?: string | null; email: string } | null;
  departmentChangedAt?: string | null;
  _count: { messages: number; attachments: number };
}

interface TicketTableProps {
  tickets: Ticket[];
  /** Single source of truth for page/pageSize/total — see lib/pagination.ts. */
  pagination: PaginationMeta;
  showRequester?: boolean;
  emptyMessage?: string;
}

export function TicketTable({
  tickets,
  pagination,
  showRequester = true,
  emptyMessage = "No tickets match your filters.",
}: TicketTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Same convention as components/projects/project-pagination-bar.tsx /
  // components/activities/activity-pagination-bar.tsx: a page change
  // preserves every other URL param (filters, sort, pageSize); a page-size
  // change resets back to page 1, since the current page number may no
  // longer mean anything once the page size changes.
  const updateParams = useCallback(
    (updates: Record<string, string | null>, opts: { resetPage?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      if (opts.resetPage) params.delete("page");
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams]
  );

  return (
    <div className="space-y-4">
      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-32">Ticket #</TableHead>
              <TableHead>Title</TableHead>
              {showRequester && <TableHead>Requester</TableHead>}
              <TableHead className="w-24">Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Dept. changed by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tickets.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={showRequester ? 12 : 11}
                  className="py-20"
                >
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Inbox className="h-8 w-8" />
                    <p className="text-sm">{emptyMessage}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {tickets.map((ticket) => (
              <TableRow key={ticket.id} className="group">
                <TableCell>
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="font-mono text-xs font-medium text-primary hover:underline"
                  >
                    {formatTicketNumber(ticket.ticketNumber)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="font-medium hover:text-primary line-clamp-1"
                  >
                    {ticket.title}
                  </Link>
                  <div className="flex items-center gap-2 mt-1">
                    {ticket._count.messages > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MessageSquare className="h-3 w-3" />
                        {ticket._count.messages}
                      </span>
                    )}
                    {ticket._count.attachments > 0 && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Paperclip className="h-3 w-3" />
                        {ticket._count.attachments}
                      </span>
                    )}
                  </div>
                </TableCell>
                {showRequester && (
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={ticket.requester.image ?? undefined} />
                        <AvatarFallback className="text-[10px]">
                          {getInitials(ticket.requester.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate max-w-[120px]">
                        {ticket.requester.name ?? ticket.requester.email}
                      </span>
                    </div>
                  </TableCell>
                )}
                <TableCell>
                  <SourceBadge source={ticket.source} />
                </TableCell>
                <TableCell>
                  {ticket.status && (
                    <StatusBadge name={ticket.status.name} color={ticket.status.color} />
                  )}
                </TableCell>
                <TableCell>
                  {ticket.priority && (
                    <PriorityBadge
                      name={ticket.priority.name}
                      color={ticket.priority.color}
                      level={ticket.priority.level}
                    />
                  )}
                </TableCell>
                <TableCell>
                  {ticket.category && (
                    <span className="text-sm text-muted-foreground">
                      {ticket.category.name}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {ticket.project ? (
                    <Link
                      href={`/projects/${ticket.project.id}`}
                      className="text-sm text-primary hover:underline truncate max-w-[100px] block"
                    >
                      {ticket.project.title}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {ticket.assignedAgent ? (
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={ticket.assignedAgent.image ?? undefined} />
                        <AvatarFallback className="text-[10px]">
                          {getInitials(ticket.assignedAgent.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate max-w-[100px]">
                        {ticket.assignedAgent.name}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
                <TableCell>
                  {ticket.departmentChangedBy ? (
                    <span className="text-xs text-muted-foreground" title={ticket.departmentChangedAt ? formatDateTime(ticket.departmentChangedAt) : undefined}>
                      {ticket.departmentChangedBy.name ?? ticket.departmentChangedBy.email}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(ticket.createdAt)}
                  </span>
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/tickets/${ticket.id}`}>View</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <PaginationControls
        pagination={pagination}
        onPageChange={(page) => updateParams({ page: page === 1 ? null : String(page) })}
        onPageSizeChange={(pageSize) => updateParams({ pageSize: pageSize === 20 ? null : String(pageSize) }, { resetPage: true })}
        itemLabel="tickets"
      />
    </div>
  );
}
