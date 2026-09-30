"use client";

import { useCallback, useId, useState } from "react";
import { motion, LayoutGroup, useReducedMotion } from "motion/react";
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
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { PaginationControls } from "@/components/ui/pagination";
import type { PaginationMeta } from "@/lib/pagination";
import { StatusBadge, PriorityBadge, SourceBadge } from "@/components/tickets/ticket-badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatTicketNumber, formatDate, formatDateTime, getInitials } from "@/lib/utils";
import { Paperclip, MessageSquare, Inbox } from "lucide-react";

interface Ticket {
  id: string;
  ticketNumber: number;
  title: string;
  source: string;
  createdAt: string;
  requester: { name?: string | null; email: string; image?: string | null };
  assignedAgent?: { name?: string | null; email: string; image?: string | null } | null;
  status: { id: string; name: string; color: string; isClosed?: boolean };
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
  // Row the notch currently marks (pointer or keyboard focus).
  const [markedId, setMarkedId] = useState<string | null>(null);
  const notchScope = useId();
  const reduceMotion = useReducedMotion();
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
      <div className="rounded-md border bg-card overflow-hidden">
        <LayoutGroup id={notchScope}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <SortableTableHead sortKey="ticketNumber" className="w-28 pl-5">Ticket</SortableTableHead>
              <SortableTableHead sortKey="title" className="min-w-[13rem] w-full">{showRequester ? "Title and requester" : "Title"}</SortableTableHead>
              <TableHead className="w-12 hidden lg:table-cell"><span className="sr-only">Source</span></TableHead>
              <SortableTableHead sortKey="status" className="hidden md:table-cell">Status</SortableTableHead>
              <SortableTableHead sortKey="priority" className="hidden md:table-cell">Priority</SortableTableHead>
              <SortableTableHead sortKey="category" className="hidden lg:table-cell">Category</SortableTableHead>
              <TableHead className="hidden 2xl:table-cell">Project</TableHead>
              <TableHead className="hidden lg:table-cell">Department</TableHead>
              <SortableTableHead sortKey="assignedAgent" className="hidden lg:table-cell">Assigned To</SortableTableHead>
              <SortableTableHead sortKey="createdAt" className="hidden lg:table-cell">Created</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody onMouseLeave={() => setMarkedId(null)} onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMarkedId(null);
          }}>
            {tickets.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={10}
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
              <TableRow
                key={ticket.id}
                className="group"
                onMouseEnter={() => setMarkedId(ticket.id)}
                onFocusCapture={() => setMarkedId(ticket.id)}
              >
                <TableCell className="relative pl-5">
                  {/* The Kinsen notch marks the row under the pointer or
                      keyboard focus: one shared element that slides between
                      rows, like the sidebar's. */}
                  {markedId === ticket.id && (
                    <motion.span
                      layoutId={`${notchScope}-notch`}
                      aria-hidden="true"
                      className="kinsen-notch absolute left-0 top-[calc(50%-0.4375rem)] h-3.5 w-2"
                      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
                    />
                  )}
                  <Link
                    href={`/tickets/${ticket.id}`}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="whitespace-nowrap text-sm font-semibold tabular-nums text-link hover:underline"
                  >
                    {formatTicketNumber(ticket.ticketNumber)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/tickets/${ticket.id}`}
                    className="font-medium hover:underline line-clamp-1 focus-visible:outline-none focus-visible:underline"
                  >
                    <span className="sr-only">{formatTicketNumber(ticket.ticketNumber)}: </span>
                    {ticket.title}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-1">
                    {ticket.status && (
                      <span className="md:hidden">
                        <StatusBadge name={ticket.status.name} color={ticket.status.color} isClosed={ticket.status.isClosed} />
                      </span>
                    )}
                    {ticket.priority && (
                      <span className="md:hidden">
                        <PriorityBadge name={ticket.priority.name} color={ticket.priority.color} level={ticket.priority.level} />
                      </span>
                    )}
                    {showRequester && (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <Avatar className="h-4 w-4">
                          <AvatarImage src={ticket.requester.image ?? undefined} />
                          <AvatarFallback className="text-[8px]">{getInitials(ticket.requester.name)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate max-w-[12rem]">{ticket.requester.name ?? ticket.requester.email}</span>
                      </span>
                    )}
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
                    {ticket.project && (
                      <Link
                        href={`/projects/${ticket.project.id}`}
                        className="hidden max-w-[12rem] truncate text-xs text-link hover:underline md:inline 2xl:hidden"
                      >
                        {ticket.project.title}
                      </Link>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <SourceBadge source={ticket.source} compact />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {ticket.status && (
                    <StatusBadge name={ticket.status.name} color={ticket.status.color} isClosed={ticket.status.isClosed} />
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {ticket.priority ? (
                    <PriorityBadge
                      name={ticket.priority.name}
                      color={ticket.priority.color}
                      level={ticket.priority.level}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {ticket.category ? (
                    <span className="text-sm text-muted-foreground">
                      {ticket.category.name}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden 2xl:table-cell">
                  {ticket.project ? (
                    <Link
                      href={`/projects/${ticket.project.id}`}
                      className="text-sm text-link hover:underline truncate max-w-[6rem] block"
                    >
                      {ticket.project.title}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {ticket.department ? (
                    <div className="max-w-[7rem]">
                      <span className="text-sm truncate block">{ticket.department.name}</span>
                      {ticket.departmentChangedBy && (
                        <span
                          className="text-xs text-muted-foreground truncate block"
                          title={ticket.departmentChangedAt ? `Moved ${formatDateTime(ticket.departmentChangedAt)}` : undefined}
                        >
                          Moved by {ticket.departmentChangedBy.name ?? ticket.departmentChangedBy.email}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {ticket.assignedAgent ? (
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={ticket.assignedAgent.image ?? undefined} />
                        <AvatarFallback className="text-[10px]">
                          {getInitials(ticket.assignedAgent.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate max-w-[5.5rem]">
                        {ticket.assignedAgent.name}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unassigned</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className="whitespace-nowrap text-xs text-muted-foreground" title={formatDateTime(ticket.createdAt)}>
                    {formatDate(ticket.createdAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </LayoutGroup>
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
