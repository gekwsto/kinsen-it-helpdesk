"use client";

import { useCallback, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaginationControls } from "@/components/ui/pagination";
import type { PaginationMeta } from "@/lib/pagination";
import { formatDateTime, stripHtmlToText, htmlToReadableText } from "@/lib/utils";
import { CheckCircle2, XCircle, Loader2, Inbox, Eye } from "lucide-react";

interface PendingTicket {
  id: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  subject: string;
  fromEmail: string;
  fromName: string | null;
  body: string;
  receivedAt: string;
  department: { id: string; name: string } | null;
  requester: { id: string; name: string | null; email: string } | null;
}

interface PendingTicketTableProps {
  pendingTickets: PendingTicket[];
  /** Single source of truth for page/pageSize/total — see lib/pagination.ts. */
  pagination: PaginationMeta;
  canAccept: boolean;
  canReject: boolean;
  /** True when no single department is in scope (Admin/Director "All Workspaces") — an unmatched pending ticket needs an explicit department chosen at accept time. */
  showDepartmentPicker: boolean;
  allDepartments: { id: string; name: string }[];
  /**
   * "pending" (default) — the /tickets/pending operational queue: Accept/
   * Reject on PENDING rows. "rejected" — the /tickets/rejected recovery
   * archive: rows are always REJECTED, and the only action is "Create
   * Ticket" (recovering the SAME row into a real Ticket via the SAME
   * accept endpoint/dialog — never a duplicated implementation). No Reject
   * button ever renders in this mode (the row is already rejected).
   */
  mode?: "pending" | "rejected";
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  ACCEPTED: { label: "Accepted", className: "bg-emerald-100 text-emerald-700" },
  REJECTED: { label: "Rejected", className: "bg-slate-100 text-slate-600" },
};

export function PendingTicketTable({
  pendingTickets,
  pagination,
  canAccept,
  canReject,
  showDepartmentPicker,
  allDepartments,
  mode = "pending",
}: PendingTicketTableProps) {
  const isRejectedMode = mode === "rejected";
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [acceptTarget, setAcceptTarget] = useState<PendingTicket | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingTicket | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PendingTicket | null>(null);
  const [acceptDepartmentId, setAcceptDepartmentId] = useState<string>("");
  const [processing, setProcessing] = useState(false);

  // Same convention as components/tickets/ticket-table.tsx / components/
  // projects/project-pagination-bar.tsx: a page change preserves every
  // other URL param, a page-size change resets back to page 1.
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

  const openAccept = (pt: PendingTicket) => {
    setAcceptDepartmentId(pt.department?.id ?? "");
    setAcceptTarget(pt);
  };

  const handleAccept = async () => {
    if (!acceptTarget) return;
    if (!acceptTarget.department && !acceptDepartmentId) {
      toast.error("Choose a department to accept this ticket into.");
      return;
    }
    setProcessing(true);
    try {
      const res = await fetch(`/api/tickets/pending/${acceptTarget.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(acceptTarget.department ? {} : { departmentId: acceptDepartmentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to accept ticket");
      }
      const created: { id: string; ticketNumber: number; title: string } = await res.json();
      if (isRejectedMode) {
        // Recovered from Rejected — the source row switches to ACCEPTED
        // and, per the query filter, disappears from this page's list on
        // the next render (router.refresh() below). Offer a direct way to
        // reach the ticket that was just created, since the user can no
        // longer find it via this same page.
        toast.success("Ticket created successfully", {
          action: { label: "View Ticket", onClick: () => router.push(`/tickets/${created.id}`) },
        });
      } else {
        toast.success("Ticket accepted — now visible in All Tickets");
      }
      setAcceptTarget(null);
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? (isRejectedMode ? "Failed to create ticket" : "Failed to accept ticket"));
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    setProcessing(true);
    try {
      const res = await fetch(`/api/tickets/pending/${rejectTarget.id}/reject`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to reject ticket");
      }
      toast.success("Ticket rejected");
      setRejectTarget(null);
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to reject ticket");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Sender</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pendingTickets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
                    <Inbox className="h-8 w-8" />
                    <p className="text-sm">
                      {isRejectedMode ? "No rejected tickets match your filters." : "No pending tickets match your filters."}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pendingTickets.map((pt) => {
                const badge = STATUS_BADGE[pt.status];
                return (
                  <TableRow key={pt.id}>
                    <TableCell className="max-w-[280px]">
                      <button
                        type="button"
                        onClick={() => setPreviewTarget(pt)}
                        className="text-sm font-medium truncate hover:text-primary hover:underline text-left block w-full"
                        title="Preview full email"
                      >
                        {pt.subject}
                      </button>
                      <p className="text-xs text-muted-foreground truncate">{stripHtmlToText(pt.body).slice(0, 120)}</p>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm truncate max-w-[160px]">{pt.fromName || pt.fromEmail}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-[160px]">{pt.fromEmail}</p>
                    </TableCell>
                    <TableCell>
                      {pt.department ? (
                        <span className="text-sm">{pt.department.name}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">Unmatched</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{formatDateTime(pt.receivedAt)}</span>
                    </TableCell>
                    <TableCell>
                      <Badge className={badge.className} variant="secondary">
                        {badge.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setPreviewTarget(pt)} title="Preview full email">
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        {!isRejectedMode && pt.status === "PENDING" && canAccept && (
                          <Button size="sm" variant="outline" onClick={() => openAccept(pt)}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-emerald-600" />
                            Accept
                          </Button>
                        )}
                        {!isRejectedMode && pt.status === "PENDING" && canReject && (
                          <Button size="sm" variant="outline" onClick={() => setRejectTarget(pt)}>
                            <XCircle className="h-3.5 w-3.5 mr-1.5 text-destructive" />
                            Reject
                          </Button>
                        )}
                        {/* Rejected Tickets: no Reject button (already rejected) — the
                            SAME accept dialog/endpoint is reused as the "Create Ticket"
                            recovery action, never a second implementation. */}
                        {isRejectedMode && pt.status === "REJECTED" && canAccept && (
                          <Button size="sm" variant="outline" onClick={() => openAccept(pt)}>
                            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-emerald-600" />
                            Create Ticket
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <PaginationControls
        pagination={pagination}
        onPageChange={(page) => updateParams({ page: page === 1 ? null : String(page) })}
        onPageSizeChange={(pageSize) => updateParams({ pageSize: pageSize === 20 ? null : String(pageSize) }, { resetPage: true })}
        itemLabel={isRejectedMode ? "rejected tickets" : "pending tickets"}
      />

      {/* Accept confirm dialog — reused verbatim as the Rejected Tickets
          "Create Ticket" recovery dialog (same department-resolution UI
          for an unmatched request), only the copy differs by mode. */}
      <Dialog open={!!acceptTarget} onOpenChange={(o) => !o && setAcceptTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRejectedMode ? "Create Ticket from Rejected Request" : "Accept Pending Ticket"}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            {isRejectedMode && (
              <p className="text-sm text-muted-foreground">
                This request was previously rejected. Creating it will create a real ticket using the original email/request data.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              This creates a real ticket from <strong className="text-foreground">{acceptTarget?.subject}</strong>.
              It will then appear in All Tickets{acceptTarget?.department ? ` for ${acceptTarget.department.name}` : ""}.
            </p>
            {acceptTarget && !acceptTarget.department && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">This email didn&apos;t match a department — choose one:</p>
                <Select value={acceptDepartmentId} onValueChange={setAcceptDepartmentId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select a department" />
                  </SelectTrigger>
                  <SelectContent>
                    {allDepartments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptTarget(null)} disabled={processing}>Cancel</Button>
            <Button onClick={handleAccept} disabled={processing}>
              {processing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isRejectedMode ? "Create Ticket" : "Accept"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject confirm dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Pending Ticket</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Reject <strong className="text-foreground">{rejectTarget?.subject}</strong>? It will be kept for audit
              but will never appear in All Tickets.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={processing}>Cancel</Button>
            <Button variant="destructive" onClick={handleReject} disabled={processing}>
              {processing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog — read-only, works for PENDING/ACCEPTED/REJECTED
          alike. The body is inbound external content (an email), so it is
          NEVER rendered as HTML (no dangerouslySetInnerHTML) — htmlToReadableText
          (lib/utils.ts) converts it to a plain-text string with paragraph/
          line-break structure preserved, which React renders as an inert
          text node inside a whitespace-pre-wrap container. Any literal
          markup/script in the original email shows up as visible, inert
          text if at all — it can never execute. */}
      <Dialog open={!!previewTarget} onOpenChange={(o) => !o && setPreviewTarget(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="pr-6 break-words">{previewTarget?.subject}</DialogTitle>
          </DialogHeader>
          {previewTarget && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm border rounded-md p-3 bg-muted/30 flex-shrink-0">
                <div>
                  <span className="text-muted-foreground">From: </span>
                  <span className="font-medium">{previewTarget.fromName || previewTarget.fromEmail}</span>
                  {previewTarget.fromName && <span className="text-muted-foreground"> &lt;{previewTarget.fromEmail}&gt;</span>}
                </div>
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <Badge className={STATUS_BADGE[previewTarget.status].className} variant="secondary">
                    {STATUS_BADGE[previewTarget.status].label}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Department: </span>
                  <span className="font-medium">{previewTarget.department?.name ?? "Unmatched"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Received: </span>
                  <span className="font-medium">{formatDateTime(previewTarget.receivedAt)}</span>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border p-4">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {htmlToReadableText(previewTarget.body) || <span className="text-muted-foreground italic">(empty message)</span>}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
