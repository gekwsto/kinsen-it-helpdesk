import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTicketNumber, formatRelative } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";

interface Ticket {
  id: string;
  ticketNumber: number;
  title: string;
  createdAt: string | Date;
  requester: { name?: string | null; email: string; image?: string | null };
  status: { name: string; color: string };
  priority?: { name: string; color: string } | null;
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
          className="text-sm text-primary hover:underline"
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
                className="flex items-start gap-3 px-6 py-3 hover:bg-muted/50 transition-colors"
              >
                <Avatar className="h-8 w-8 mt-0.5 flex-shrink-0">
                  <AvatarImage src={ticket.requester.image ?? undefined} />
                  <AvatarFallback className="text-xs">
                    {getInitials(ticket.requester.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatTicketNumber(ticket.ticketNumber)}
                    </span>
                    {ticket.priority && (
                      <span
                        className="text-xs font-medium px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: ticket.priority.color + "20",
                          color: ticket.priority.color,
                        }}
                      >
                        {ticket.priority.name}
                      </span>
                    )}
                    <span
                      className="text-xs font-medium px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: ticket.status.color + "20",
                        color: ticket.status.color,
                      }}
                    >
                      {ticket.status.name}
                    </span>
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
