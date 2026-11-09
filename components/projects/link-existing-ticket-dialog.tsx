"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ArrowRight } from "lucide-react";
import { formatTicketNumber } from "@/lib/utils";

interface LinkableTicket {
  id: string;
  ticketNumber: number;
  title: string;
  /** The Ticket's CURRENT Project, if any — null for an unlinked Ticket. Never the destination; see projectId prop for that. */
  currentProjectId: string | null;
  currentProjectTitle: string | null;
}

interface LinkExistingTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** This Project's own title — shown as the reassignment destination in the confirmation step. */
  projectTitle: string;
  /** This Project's own departmentId — GET /api/tickets already scopes visibility to what the caller can actually see within it (buildTicketListWhere), never an unbounded cross-department search. */
  departmentId: string;
  /** Called once after a successful link — the caller re-fetches (router.refresh()), this dialog never maintains its own copy of the Project's Related Tickets list. */
  onLinked: () => void;
}

const SEARCH_DEBOUNCE_MS = 275;

/**
 * Lets a user attach an EXISTING Ticket (from anywhere in this department,
 * unlinked or already belonging to another Project) to this Project. The
 * actual write is the exact same PATCH /api/tickets/[id] (`{ projectId }`)
 * the Ticket detail page's own "Link Project / Activity" dialog already
 * uses — same ticket.linkProjectActivity permission check, same
 * validateTicketProjectActivityLink department-scope validation, no
 * parallel logic.
 *
 * A Ticket already tied to a different Project is shown (never silently
 * hidden) but requires an explicit confirmation step naming both the
 * source and destination Project before the PATCH is actually sent — "do
 * not silently move it" without blocking reassignment outright.
 *
 * Server-side search (GET /api/tickets?search=) rather than loading every
 * department Ticket at once — a department's ticket volume can be large,
 * unlike the Activity picker's typically-small standalone set.
 */
export function LinkExistingTicketDialog({ open, onOpenChange, projectId, projectTitle, departmentId, onLinked }: LinkExistingTicketDialogProps) {
  const [search, setSearch] = useState("");
  const [tickets, setTickets] = useState<LinkableTicket[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchTickets = (query: string) => {
    setLoadingList(true);
    fetch(`/api/tickets?departmentId=${departmentId}&search=${encodeURIComponent(query)}&limit=20`)
      .then((r) => (r.ok ? r.json() : { tickets: [] }))
      .then((data) => {
        const rows: LinkableTicket[] = Array.isArray(data.tickets)
          ? data.tickets
              .filter((t: any) => t.projectId !== projectId)
              .map((t: any) => ({
                id: t.id,
                ticketNumber: t.ticketNumber,
                title: t.title,
                currentProjectId: t.projectId ?? null,
                currentProjectTitle: t.project?.title ?? null,
              }))
          : [];
        setTickets(rows);
      })
      .catch(() => toast.error("Failed to load tickets"))
      .finally(() => setLoadingList(false));
  };

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setSearch("");
      setTickets([]);
      setConfirming(false);
      return;
    }
    fetchTickets("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, departmentId]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchTickets(search), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const selected = selectedId ? tickets.find((t) => t.id === selectedId) ?? null : null;

  const performLink = async () => {
    if (!selectedId) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/tickets/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to link ticket");
      }
      toast.success("Ticket linked");
      onOpenChange(false);
      onLinked();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to link ticket");
      setConfirming(false);
    } finally {
      setLinking(false);
    }
  };

  // Reassigning away from another Project needs an explicit confirmation
  // naming both Projects first; attaching an unlinked Ticket links
  // immediately, same as before.
  const handleLinkClick = () => {
    if (!selected) return;
    if (selected.currentProjectId) {
      setConfirming(true);
      return;
    }
    performLink();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{confirming ? "Move Ticket to this Project?" : "Link Ticket"}</DialogTitle>
        </DialogHeader>
        {confirming && selected ? (
          <div className="space-y-4 py-2 min-w-0">
            <p className="text-sm">
              <span className="font-mono text-xs text-muted-foreground mr-1">{formatTicketNumber(selected.ticketNumber)}</span>
              <span className="font-medium">{selected.title}</span> is currently linked to another Project. Linking it here will move it.
            </p>
            <div className="flex items-center gap-2 text-sm rounded-md border p-3 min-w-0">
              <span className="font-medium truncate min-w-0">{selected.currentProjectTitle ?? "Unknown Project"}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="font-medium truncate min-w-0">{projectTitle}</span>
            </div>
          </div>
        ) : (
          // min-w-0 here is load-bearing, not decorative: DialogContent is a
          // CSS grid, and a grid item's automatic minimum width defaults to
          // its content's min-content size (same rule as flexbox) unless
          // something resets it — without this, a long "Linked to: …" badge
          // several rows down (flex-shrink-0, see below) would force this
          // ENTIRE grid column wider than DialogContent's max-w-lg cap,
          // visually overflowing the search Input and DialogFooter too, not
          // just the one row that caused it.
          <div className="space-y-3 py-2 min-w-0">
            <p className="text-xs text-muted-foreground">
              Attach an existing Ticket from this department to this Project.
            </p>
            <Input
              placeholder="Search by title or ticket #…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
              {loadingList ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : tickets.length === 0 ? (
                <p className="text-xs text-muted-foreground px-3 py-4 text-center">
                  No tickets match{search ? ` "${search}"` : " this department"}.
                </p>
              ) : (
                tickets.map((t) => (
                  <label
                    key={t.id}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 min-w-0 ${selectedId === t.id ? "bg-primary/5" : ""}`}
                  >
                    <input
                      type="radio"
                      name="link-ticket"
                      className="h-4 w-4 flex-shrink-0"
                      checked={selectedId === t.id}
                      onChange={() => setSelectedId(t.id)}
                    />
                    <span className="font-mono text-xs text-muted-foreground flex-shrink-0">{formatTicketNumber(t.ticketNumber)}</span>
                    {/* flex-1 + min-w-0 so the title is the row's one
                        flexible element — it absorbs whatever space the
                        fixed-width ticket #/radio and the capped "Linked
                        to" badge don't need, truncating first under
                        pressure rather than pushing the row wider. */}
                    <span className="text-sm truncate min-w-0 flex-1">{t.title}</span>
                    {t.currentProjectTitle && (
                      // Capped at 40% of the row instead of a bare
                      // whitespace-nowrap (which has no upper bound and was
                      // the actual overflow trigger) — long project titles
                      // now ellipsis-truncate in place rather than forcing
                      // the row wider; the title attribute still exposes
                      // the full name on hover.
                      <span
                        className="text-[10px] text-muted-foreground truncate max-w-[40%] flex-shrink-0"
                        title={`Linked to: ${t.currentProjectTitle}`}
                      >
                        Linked to: {t.currentProjectTitle}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          {confirming && (
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={linking}>
              Back
            </Button>
          )}
          <Button onClick={confirming ? performLink : handleLinkClick} disabled={!selectedId || linking}>
            {linking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirming ? "Confirm Move" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
