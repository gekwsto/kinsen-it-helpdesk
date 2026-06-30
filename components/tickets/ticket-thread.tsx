"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, formatDateTime, formatBytes } from "@/lib/utils";
import { Role, MessageDirection } from "@prisma/client";
import { Paperclip, Lock, Mail, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MessageAttachment {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  path: string;
}

export interface ThreadMessage {
  id: string;
  body: string;
  direction: MessageDirection;
  isInternal: boolean;
  createdAt: string | Date;
  fromEmail?: string | null;
  fromName?: string | null;
  author?: {
    id: string;
    name?: string | null;
    email: string;
    image?: string | null;
    role: Role;
  } | null;
  attachments: MessageAttachment[];
}

interface TicketThreadProps {
  messages: ThreadMessage[];
  currentUserId: string;
  userRole: Role;
}

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Manager",
  USER: "User",
};

export function TicketThread({
  messages,
  currentUserId,
}: TicketThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showNewMessage, setShowNewMessage] = useState(false);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    setShowNewMessage(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distFromBottom < 80;
    if (isNearBottomRef.current) setShowNewMessage(false);
  }, []);

  // Instant scroll on mount
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Auto-scroll when messages change
  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    const isOwn = last.author?.id === currentUserId;

    if (isOwn || isNearBottomRef.current) {
      scrollToBottom();
    } else {
      setShowNewMessage(true);
    }
    // currentUserId is stable — intentionally omitted from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, scrollToBottom]);

  if (messages.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[520px] overflow-y-auto rounded-xl border bg-muted/20 p-4 space-y-5"
      >
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            currentUserId={currentUserId}
          />
        ))}
      </div>

      {showNewMessage && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={() => scrollToBottom()}
            className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md hover:bg-primary/90 transition-colors"
          >
            <ArrowDown className="h-3 w-3" />
            New message
          </button>
        </div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  currentUserId,
}: {
  message: ThreadMessage;
  currentUserId: string;
}) {
  const isOwn = message.author?.id === currentUserId;
  const isInternal = message.isInternal;
  const isEmailInbound = message.direction === "INBOUND" && !isInternal;

  const authorName =
    message.author?.name ??
    message.fromName ??
    message.fromEmail ??
    "Unknown";

  const roleLabel =
    message.author?.role ? ROLE_LABEL[message.author.role] : null;

  return (
    <div
      className={cn(
        "flex items-end gap-2.5",
        isOwn && !isInternal ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <Avatar className="h-7 w-7 flex-shrink-0 mb-1">
        <AvatarImage src={message.author?.image ?? undefined} />
        <AvatarFallback className="text-[10px] bg-muted">
          {getInitials(authorName)}
        </AvatarFallback>
      </Avatar>

      {/* Content column */}
      <div
        className={cn(
          "flex flex-col gap-1 max-w-[75%]",
          isOwn && !isInternal ? "items-end" : "items-start"
        )}
      >
        {/* Author + badges row */}
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground",
            isOwn && !isInternal ? "flex-row-reverse" : "flex-row"
          )}
        >
          <span className="font-medium text-foreground/80">{authorName}</span>
          {roleLabel && (
            <span className="text-muted-foreground">({roleLabel})</span>
          )}
          {isInternal && (
            <span className="flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
              <Lock className="h-2.5 w-2.5" />
              Internal
            </span>
          )}
          {isEmailInbound && (
            <span className="flex items-center gap-0.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
              <Mail className="h-2.5 w-2.5" />
              Email
            </span>
          )}
          <span className="text-muted-foreground/60">
            {formatDateTime(message.createdAt)}
          </span>
        </div>

        {/* Bubble */}
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
            isInternal
              ? "rounded-tl-sm border border-amber-200 bg-amber-50 text-amber-900"
              : isOwn
              ? "rounded-tr-sm bg-primary text-primary-foreground"
              : "rounded-tl-sm bg-muted text-foreground"
          )}
        >
          {/* Use whitespace-pre-wrap for user-typed messages; dangerouslySetInnerHTML for email HTML */}
          {isEmailInbound ? (
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: message.body }}
            />
          ) : (
            <p className="whitespace-pre-wrap break-words">{message.body}</p>
          )}
        </div>

        {/* Attachments */}
        {message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {message.attachments.map((att) => (
              <a
                key={att.id}
                href={att.path}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted transition-colors"
              >
                <Paperclip className="h-3 w-3 text-muted-foreground" />
                <span className="max-w-[120px] truncate">{att.originalName}</span>
                <span className="text-muted-foreground">
                  ({formatBytes(att.size)})
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
