"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Ticket, Link2 } from "lucide-react";
import { formatTicketNumber } from "@/lib/utils";
import { LinkExistingTicketDialog } from "@/components/projects/link-existing-ticket-dialog";

export interface ProjectRelatedTicketRow {
  id: string;
  ticketNumber: number;
  title: string;
  status: { name: string; color: string };
}

interface ProjectRelatedTicketsCardProps {
  projectId: string;
  /** This Project's own title — passed through to LinkExistingTicketDialog as the reassignment destination's display name. */
  projectTitle: string;
  initialTickets: ProjectRelatedTicketRow[];
  /** This Project's own departmentId — null hides the Link Ticket button entirely (nothing to scope a candidate search to). */
  departmentId: string | null;
  /** ticket.linkProjectActivity for this Project's own department — the SAME permission PATCH /api/tickets/[id] itself requires to set a Ticket's projectId; this only gates whether the button renders. */
  canLinkTickets: boolean;
}

/**
 * Client wrapper for the Project detail page's "Related Tickets" rail card
 * — extracted from a plain server-rendered block (app/(main)/projects/[id]/page.tsx)
 * only so it can own the "Link Ticket" button/dialog; the list itself is
 * still server-sourced (`initialTickets`, capped at 10 like before) and
 * simply re-fetched via router.refresh() after a successful link, same as
 * ProjectActivitiesCard/ProjectActivitySequenceCard's own Link Activity
 * flow — no new client-side data-merging logic.
 */
export function ProjectRelatedTicketsCard({ projectId, projectTitle, initialTickets, departmentId, canLinkTickets }: ProjectRelatedTicketsCardProps) {
  const router = useRouter();
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Ticket className="h-4 w-4" />
          Related Tickets ({initialTickets.length})
        </CardTitle>
        {canLinkTickets && departmentId && (
          <Button size="sm" className="gap-1.5" onClick={() => setLinkDialogOpen(true)}>
            <Link2 className="h-3.5 w-3.5" />
            Link Ticket
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {initialTickets.length === 0 ? (
          <p className="text-center text-muted-foreground py-4 text-sm">
            No tickets linked to this project.
          </p>
        ) : (
          <div className="space-y-2">
            {initialTickets.map((t) => (
              <Link
                key={t.id}
                href={`/tickets/${t.id}`}
                className="flex items-center justify-between p-2.5 rounded-lg border hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                    {formatTicketNumber(t.ticketNumber)}
                  </span>
                  <span className="text-sm font-medium truncate">{t.title}</span>
                </div>
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2"
                  style={{
                    backgroundColor: t.status.color + "22",
                    color: t.status.color,
                  }}
                >
                  {t.status.name}
                </span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
      {canLinkTickets && departmentId && (
        <LinkExistingTicketDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          projectId={projectId}
          projectTitle={projectTitle}
          departmentId={departmentId}
          onLinked={() => router.refresh()}
        />
      )}
    </Card>
  );
}
