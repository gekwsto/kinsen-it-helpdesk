import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTicketNumber, formatRelative } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { StatusMark, PriorityMark } from "@/components/shared/marks";

interface Ticket {
  id: string;
  ticketNumber: number;
  title: string;
  createdAt: string | Date;
  requester: { name?: string | null; email: string; image?: string | null };
  status: { name: string; color: string; isClosed?: boolean };
  priority?: { name: string; color: string; level: number } | null;
}

interface RecentTicketsProps {
  tickets: Ticket[];
}

export function RecentTickets({ tickets }: RecentTicketsProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Recent Tickets</CardTitle>
        <Link
          href="/tickets"
          className="text-sm text-link hover:underline"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {tickets.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">
            No tickets yet.
          </p>
        ) : (
          <div className="divide-y">
            {tickets.map((ticket) => (
              <Link
                key={ticket.id}
                href={`/tickets/${ticket.id}`}
                className="group relative flex items-start gap-3 px-5 py-3 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span
                  aria-hidden="true"
                  className="kinsen-notch absolute left-0 top-1/2 h-3.5 w-2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                />
                <Avatar className="h-8 w-8 mt-0.5 flex-shrink-0">
                  <AvatarImage src={ticket.requester.image ?? undefined} />
                  <AvatarFallback className="text-xs">
                    {getInitials(ticket.requester.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
                    <span className="text-xs font-semibold tabular-nums text-link">
                      {formatTicketNumber(ticket.ticketNumber)}
                    </span>
                    <StatusMark label={ticket.status.name} color={ticket.status.color} closed={ticket.status.isClosed} />
                    {ticket.priority && (
                      <PriorityMark label={ticket.priority.name} rank={ticket.priority.level} color={ticket.priority.color} />
                    )}
                  </div>
                  <p className="text-sm font-medium mt-0.5 truncate">{ticket.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {ticket.requester.name ?? ticket.requester.email} ·{" "}
                    {formatRelative(ticket.createdAt)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
