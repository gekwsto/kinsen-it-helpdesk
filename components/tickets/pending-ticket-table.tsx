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
import { formatDateTime, stripHtmlToText } from "@/lib/utils";
import { CheckCircle2, XCircle, Loader2, Inbox } from "lucide-react";

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
  total: number;
  page: number;
  totalPages: number;
  canAccept: boolean;
  canReject: boolean;
  /** True when no single department is in scope (Admin/Director "All Workspaces") — an unmatched pending ticket needs an explicit department chosen at accept time. */
  showDepartmentPicker: boolean;
  allDepartments: { id: string; name: string }[];
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Pending", className: "bg-amber-100 text-amber-700" },
  ACCEPTED: { label: "Accepted", className: "bg-emerald-100 text-emerald-700" },
  REJECTED: { label: "Rejected", className: "bg-slate-100 text-slate-600" },
};

export function PendingTicketTable({
  pendingTickets,
  total,
  page,
  totalPages,
  canAccept,
  canReject,
  showDepartmentPicker,
  allDepartments,
}: PendingTicketTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [acceptTarget, setAcceptTarget] = useState<PendingTicket | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingTicket | null>(null);
  const [acceptDepartmentId, setAcceptDepartmentId] = useState<string>("");
  const [processing, setProcessing] = useState(false);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
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
      toast.success("Ticket accepted — now visible in All Tickets");
      setAcceptTarget(null);
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to accept ticket");
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
                    <p className="text-sm">No pending tickets match your filters.</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pendingTickets.map((pt) => {
                const badge = STATUS_BADGE[pt.status];
                return (
                  <TableRow key={pt.id}>
                    <TableCell className="max-w-[280px]">
                      <p className="text-sm font-medium truncate">{pt.subject}</p>
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
                      {pt.status === "PENDING" && (
                        <div className="flex justify-end gap-1.5">
                          {canAccept && (
                            <Button size="sm" variant="outline" onClick={() => openAccept(pt)}>
                              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-emerald-600" />
                              Accept
                            </Button>
                          )}
                          {canReject && (
                            <Button size="sm" variant="outline" onClick={() => setRejectTarget(pt)}>
                              <XCircle className="h-3.5 w-3.5 mr-1.5 text-destructive" />
                              Reject
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateParam("page", String(page - 1))}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => updateParam("page", String(page + 1))}>
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Accept confirm dialog */}
      <Dialog open={!!acceptTarget} onOpenChange={(o) => !o && setAcceptTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept Pending Ticket</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
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
              Accept
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
    </div>
  );
}
