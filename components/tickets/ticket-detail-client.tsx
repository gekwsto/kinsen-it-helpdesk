"use client";

import { useState, useCallback } from "react";
import { Role } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDateTime, getInitials } from "@/lib/utils";
import Link from "next/link";
import { formatTicketNumber } from "@/lib/utils";
import { StatusBadge, PriorityBadge, ColorBadge, SourceBadge } from "@/components/tickets/ticket-badge";
import { TicketThread, type ThreadMessage } from "@/components/tickets/ticket-thread";
import { TicketReplyForm } from "@/components/tickets/ticket-reply-form";
import { TicketHistory } from "@/components/tickets/ticket-history";
import { TicketActions } from "@/components/tickets/ticket-actions";
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

export interface TicketDetailClientProps {
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  ticketSource: string;
  ticketCreatedAt: string;
  requester: { id: string; name: string | null; email: string; image: string | null };
  department: { id: string; name: string } | null;
  project: { id: string; title: string } | null;
  activity: { id: string; title: string } | null;
  initialStatus: TicketStatus;
  initialPriority: TicketPriority | null;
  initialCategory: TicketCategory | null;
  initialAssignedAgent: TicketAgent | null;
  initialClosedAt: string | null;
  initialMessages: ThreadMessage[];
  initialHistory: HistoryEntry[];
  currentUserId: string;
  userRole: Role;
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
  ticketSource,
  ticketCreatedAt,
  requester,
  department,
  project,
  activity,
  initialStatus,
  initialPriority,
  initialCategory,
  initialAssignedAgent,
  initialClosedAt,
  initialMessages,
  initialHistory,
  currentUserId,
  userRole,
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
  const canManageAny = canChangeStatus || canAssign;
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [status, setStatus] = useState<TicketStatus>(initialStatus);
  const [priority, setPriority] = useState<TicketPriority | null>(initialPriority);
  const [category, setCategory] = useState<TicketCategory | null>(initialCategory);
  const [assignedAgent, setAssignedAgent] = useState<TicketAgent | null>(initialAssignedAgent);
  const [closedAt, setClosedAt] = useState<string | null>(initialClosedAt);

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

  // Build the ticket object TicketActions expects (synced to live state)
  const ticketForActions = {
    id: ticketId,
    statusId: status.id,
    priorityId: priority?.id ?? null,
    categoryId: category?.id ?? null,
    assignedAgentId: assignedAgent?.id ?? null,
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
          />
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
            {department && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Department</span>
                <span className="font-medium">{department.name}</span>
              </div>
            )}
            {project && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Project</span>
                <Link
                  href={`/projects/${project.id}`}
                  className="font-medium text-primary hover:underline text-sm truncate max-w-[140px]"
                >
                  {project.title}
                </Link>
              </div>
            )}
            {activity && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Activity</span>
                <Link
                  href={`/activities/${activity.id}`}
                  className="font-medium text-primary hover:underline text-sm truncate max-w-[140px]"
                >
                  {activity.title}
                </Link>
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
