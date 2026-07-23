"use client";

import { useState, useCallback } from "react";
import { Role } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { formatDateTime, formatBytes, getInitials } from "@/lib/utils";
import { Paperclip, Trash2, Loader2, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatTicketNumber } from "@/lib/utils";
import { StatusBadge, PriorityBadge, ColorBadge, SourceBadge } from "@/components/tickets/ticket-badge";
import { TicketThread, type ThreadMessage } from "@/components/tickets/ticket-thread";
import { TicketReplyForm } from "@/components/tickets/ticket-reply-form";
import { TicketHistory } from "@/components/tickets/ticket-history";
import { TicketActions } from "@/components/tickets/ticket-actions";
import { TicketDepartmentEditor } from "@/components/tickets/ticket-department-editor";
import { TicketShareToggles } from "@/components/tickets/ticket-share-toggles";
import { useTicketRealtime } from "@/hooks/use-ticket-realtime";
import type { TicketRealtimeEvent } from "@/lib/realtime/types";

// Serializable ticket metadata managed in real-time
interface TicketStatus {
  id: string;
  name: string;
  color: string;
  isClosed: boolean;
}

interface TicketPriority {
  id: string;
  name: string;
  color: string;
  level: number;
}

interface TicketCategory {
  id: string;
  name: string;
  color: string;
}

interface TicketAgent {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface HistoryEntry {
  id: string;
  type: string;
  oldValue?: string | null;
  newValue?: string | null;
  description?: string | null;
  createdAt: string;
  changedBy?: { id: string; name?: string | null; image?: string | null } | null;
}

interface TicketAttachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
  uploadedBy: { id: string; name: string | null; email: string } | null;
}

export interface TicketDetailClientProps {
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  ticketDescription: string;
  ticketSource: string;
  ticketCreatedAt: string;
  requester: { id: string; name: string | null; email: string; image: string | null };
  department: { id: string; name: string } | null;
  subDepartment: { id: string; name: string } | null;
  allDepartments: { id: string; name: string }[];
  canChangeDepartment: boolean;
  shareWithDepartment: boolean;
  shareWithSubDepartment: boolean;
  canShareDepartment: boolean;
  canShareSubDepartment: boolean;
  project: { id: string; title: string } | null;
  activity: { id: string; title: string } | null;
  canLinkProjectActivity: boolean;
  allProjects: Array<{ id: string; title: string }>;
  allActivities: Array<{ id: string; title: string; projectId: string | null }>;
  initialStatus: TicketStatus;
  initialPriority: TicketPriority | null;
  initialCategory: TicketCategory | null;
  initialAssignedAgent: TicketAgent | null;
  initialClosedAt: string | null;
  initialMessages: ThreadMessage[];
  ticketAttachments: TicketAttachment[];
  initialHistory: HistoryEntry[];
  currentUserId: string;
  userRole: Role;
  isAdmin: boolean;
  isRequester: boolean;
  initialCancelReasonId: string | null;
  cancelReasons: Array<{ id: string; name: string }>;
  // Fine-grained permission flags (derived server-side via hasPermission)
  canReply: boolean;
  canInternalNote: boolean;
  canChangeStatus: boolean;
  canAssign: boolean;
  canViewHistory: boolean;
  statuses: Array<{ id: string; name: string; color: string }>;
  priorities: Array<{ id: string; name: string; color: string; level: number }>;
  categories: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string | null; email: string; image: string | null }>;
}

export function TicketDetailClient({
  ticketId,
  ticketNumber,
  ticketTitle,
  ticketDescription,
  ticketSource,
  ticketCreatedAt,
  requester,
  department,
  subDepartment,
  allDepartments,
  canChangeDepartment,
  shareWithDepartment,
  shareWithSubDepartment,
  canShareDepartment,
  canShareSubDepartment,
  project,
  activity,
  canLinkProjectActivity,
  allProjects,
  allActivities,
  initialStatus,
  initialPriority,
  initialCategory,
  initialAssignedAgent,
  initialClosedAt,
  initialMessages,
  ticketAttachments,
  initialHistory,
  currentUserId,
  userRole,
  isAdmin,
  isRequester,
  initialCancelReasonId,
  cancelReasons,
  canReply,
  canInternalNote,
  canChangeStatus,
  canAssign,
  canViewHistory,
  statuses,
  priorities,
  categories,
  agents,
}: TicketDetailClientProps) {
  const router = useRouter();
  const canManageAny = canChangeStatus || canAssign || canLinkProjectActivity;
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [status, setStatus] = useState<TicketStatus>(initialStatus);
  const [priority, setPriority] = useState<TicketPriority | null>(initialPriority);
  const [category, setCategory] = useState<TicketCategory | null>(initialCategory);
  const [assignedAgent, setAssignedAgent] = useState<TicketAgent | null>(initialAssignedAgent);
  const [closedAt, setClosedAt] = useState<string | null>(initialClosedAt);
  const [cancelReasonId, setCancelReasonId] = useState<string | null>(initialCancelReasonId);

  // Delete ticket dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Cancel ticket dialog
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectedCancelReasonId, setSelectedCancelReasonId] = useState("");
  const [cancelNote, setCancelNote] = useState("");

  const handleEvent = useCallback(
    (event: TicketRealtimeEvent) => {
      switch (event.type) {
        case "TICKET_MESSAGE_CREATED":
        case "TICKET_INTERNAL_NOTE_CREATED": {
          const msg = event.payload as ThreadMessage;
          setMessages((prev) => {
            // Deduplicate — optimistic append may have already added it
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
          break;
        }
        case "TICKET_STATUS_CHANGED": {
          const { status: s, closedAt: ca } = event.payload as {
            status: TicketStatus;
            closedAt: string | null;
          };
          setStatus(s);
          setClosedAt(ca);
          break;
        }
        case "TICKET_PRIORITY_CHANGED": {
          const { priority: p } = event.payload as { priority: TicketPriority | null };
          setPriority(p);
          break;
        }
        case "TICKET_CATEGORY_CHANGED": {
          const { category: c } = event.payload as { category: TicketCategory | null };
          setCategory(c);
          break;
        }
        case "TICKET_ASSIGNEE_CHANGED": {
          const { assignedAgent: a } = event.payload as { assignedAgent: TicketAgent | null };
          setAssignedAgent(a);
          break;
        }
      }
    },
    []
  );

  useTicketRealtime(ticketId, handleEvent);

  const handleMessageSent = useCallback((message: ThreadMessage) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) return prev;
      return [...prev, message];
    });
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete ticket");
      }
      toast.success("Ticket deleted");
      router.push("/tickets");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to delete ticket");
      setDeleting(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedCancelReasonId) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancelReasonId: selectedCancelReasonId, note: cancelNote || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to cancel ticket");
      }
      const data = await res.json();
      setStatus(data.status);
      setClosedAt(data.closedAt);
      setCancelReasonId(data.cancelReasonId);
      setCancelOpen(false);
      setSelectedCancelReasonId("");
      setCancelNote("");
      toast.success("Ticket cancelled");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to cancel ticket");
    } finally {
      setCancelling(false);
    }
  };

  // True when this user is allowed to cancel and the ticket is still open
  const canCancelNow = (isAdmin || isRequester) && !cancelReasonId && !status.isClosed;

  // Build the ticket object TicketActions expects (synced to live state)
  const ticketForActions = {
    id: ticketId,
    statusId: status.id,
    priorityId: priority?.id ?? null,
    categoryId: category?.id ?? null,
    assignedAgentId: assignedAgent?.id ?? null,
    projectId: project?.id ?? null,
    activityId: activity?.id ?? null,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Main content — 2 columns */}
      <div className="lg:col-span-2 space-y-4">
        {/* Ticket header */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatTicketNumber(ticketNumber)}
                  </span>
                  <SourceBadge source={ticketSource} />
                  <StatusBadge name={status.name} color={status.color} />
                  {priority && (
                    <PriorityBadge
                      name={priority.name}
                      color={priority.color}
                      level={priority.level}
                    />
                  )}
                </div>
                <h1 className="text-xl font-bold">{ticketTitle}</h1>
              </div>
            </div>
            {ticketDescription && (
              <p className="text-sm text-foreground/80 whitespace-pre-wrap mb-4 leading-relaxed">
                {ticketDescription}
              </p>
            )}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Avatar className="h-5 w-5">
                  <AvatarImage src={requester.image ?? undefined} />
                  <AvatarFallback className="text-[9px]">
                    {getInitials(requester.name)}
                  </AvatarFallback>
                </Avatar>
                {requester.name ?? requester.email}
              </div>
              <span>·</span>
              <span>Opened {formatDateTime(ticketCreatedAt)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Thread + History tabs */}
        <Tabs defaultValue="thread">
          <TabsList>
            <TabsTrigger value="thread">
              Thread ({messages.length})
            </TabsTrigger>
            {canViewHistory && (
              <TabsTrigger value="history">
                History ({initialHistory.length})
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="thread" className="mt-4 space-y-4">
            <TicketThread
              messages={messages}
              currentUserId={currentUserId}
              userRole={userRole}
            />
            {canReply && (
              <>
                <Separator />
                <div>
                  <h3 className="text-sm font-medium mb-3">Add Reply</h3>
                  <TicketReplyForm
                    ticketId={ticketId}
                    canInternalNote={canInternalNote}
                    onMessageSent={handleMessageSent}
                  />
                </div>
              </>
            )}
          </TabsContent>

          {canViewHistory && (
            <TabsContent value="history" className="mt-4">
              <TicketHistory history={initialHistory as any} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Ticket</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete ticket{" "}
              <strong className="text-foreground font-mono">{formatTicketNumber(ticketNumber)}</strong>?
            </p>
            <p className="text-sm font-medium text-destructive">
              This will delete all messages, attachments, and history. This action cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel ticket dialog */}
      <Dialog
        open={cancelOpen}
        onOpenChange={(o) => {
          setCancelOpen(o);
          if (!o) { setSelectedCancelReasonId(""); setCancelNote(""); }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isAdmin ? "Cancel Ticket" : "Cancel My Request"}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? "Cancelling this ticket will close it and remove it from the open queue. The ticket will be preserved in the closed/cancelled list."
                : "Cancelling your request will close this ticket. You will no longer receive updates on it. The record will be preserved in the closed/cancelled list."}
            </p>
            <div className="space-y-2">
              <Label htmlFor="cancel-reason">Cancel Reason *</Label>
              <Select value={selectedCancelReasonId} onValueChange={setSelectedCancelReasonId}>
                <SelectTrigger id="cancel-reason">
                  <SelectValue placeholder="Select a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {cancelReasons.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cancel-note">Note (optional)</Label>
              <Textarea
                id="cancel-note"
                placeholder="Additional context for this cancellation…"
                value={cancelNote}
                onChange={(e) => setCancelNote(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              Back
            </Button>
            <Button
              variant="default"
              onClick={handleCancel}
              disabled={cancelling || !selectedCancelReasonId}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {cancelling && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Cancel Ticket
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sidebar — 1 column */}
      <div className="space-y-4">
        {canManageAny && (
          <TicketActions
            ticket={ticketForActions}
            statuses={statuses}
            priorities={priorities}
            categories={categories}
            agents={agents}
            canChangeStatus={canChangeStatus}
            canAssign={canAssign}
            canLinkProjectActivity={canLinkProjectActivity}
            projects={allProjects}
            activities={allActivities}
          />
        )}

        {/* Ticket-level attachments (not linked to a specific message) */}
        {ticketAttachments.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5" />
                Attachments ({ticketAttachments.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {ticketAttachments.map((att) => (
                <a
                  key={att.id}
                  href={att.path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs hover:bg-muted transition-colors"
                >
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{att.originalName}</p>
                    <p className="text-muted-foreground mt-0.5">
                      {formatBytes(att.size)} · {att.mimeType}
                    </p>
                    <p className="text-muted-foreground">
                      {formatDateTime(att.createdAt)}
                      {att.uploadedBy && (
                        <> · {att.uploadedBy.name ?? att.uploadedBy.email}</>
                      )}
                    </p>
                  </div>
                </a>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Admin destructive actions */}
        {isAdmin && (
          <Card className="border-destructive/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-destructive">Admin Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {canCancelNow && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800"
                  onClick={() => setCancelOpen(true)}
                  disabled={cancelReasons.length === 0}
                  title={cancelReasons.length === 0 ? "No active cancel reasons available" : undefined}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                  Cancel Ticket
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete Ticket
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Requester cancel — only visible to the ticket owner, not admins */}
        {!isAdmin && isRequester && canCancelNow && (
          <Card className="border-orange-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-orange-700">My Request</CardTitle>
            </CardHeader>
            <CardContent>
              {cancelReasons.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No active cancel reasons are available. Contact support if you need this ticket cancelled.
                </p>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800"
                  onClick={() => setCancelOpen(true)}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1.5" />
                  Cancel My Request
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Details card — reflects real-time state */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              <StatusBadge name={status.name} color={status.color} />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Priority</span>
              {priority ? (
                <PriorityBadge
                  name={priority.name}
                  color={priority.color}
                  level={priority.level}
                />
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </div>
            {category && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Category</span>
                <ColorBadge name={category.name} color={category.color} />
              </div>
            )}
            {canChangeDepartment ? (
              <TicketDepartmentEditor
                ticketId={ticketId}
                department={department}
                subDepartment={subDepartment}
                departments={allDepartments}
              />
            ) : (
              <>
                {department && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Department</span>
                    <span className="font-medium">{department.name}</span>
                  </div>
                )}
                {subDepartment && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Sub-Department</span>
                    <span className="font-medium">{subDepartment.name}</span>
                  </div>
                )}
              </>
            )}
            {(canShareDepartment || canShareSubDepartment) && (
              <>
                <Separator />
                <TicketShareToggles
                  ticketId={ticketId}
                  initialShareWithDepartment={shareWithDepartment}
                  initialShareWithSubDepartment={shareWithSubDepartment}
                  hasSubDepartment={!!subDepartment}
                  canShareDepartment={canShareDepartment}
                  canShareSubDepartment={canShareSubDepartment}
                />
              </>
            )}
            {(project || canLinkProjectActivity) && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Project</span>
                {project ? (
                  <Link
                    href={`/projects/${project.id}`}
                    className="font-medium text-primary hover:underline text-sm truncate max-w-[140px]"
                  >
                    {project.title}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            )}
            {(activity || canLinkProjectActivity) && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Activity</span>
                {activity ? (
                  <Link
                    href={`/activities/${activity.id}`}
                    className="font-medium text-primary hover:underline text-sm truncate max-w-[140px]"
                  >
                    {activity.title}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                )}
              </div>
            )}
            <Separator />
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Assigned to</span>
              {assignedAgent ? (
                <div className="flex items-center gap-1.5">
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={assignedAgent.image ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {getInitials(assignedAgent.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-xs">{assignedAgent.name}</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Unassigned</span>
              )}
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span className="text-xs">{formatDateTime(ticketCreatedAt)}</span>
            </div>
            {closedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Closed</span>
                <span className="text-xs">{formatDateTime(closedAt)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
