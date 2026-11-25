"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MentionTextarea } from "@/components/notes/mention-textarea";
import { extractMentionedUserIdsFromBody } from "@/lib/mentions/mention-tokens";
import { Loader2, Send, Lock, X } from "lucide-react";
import { AttachmentDropzone, AttachmentFileIcon } from "@/components/attachments/attachment-dropzone";
import { uploadAttachmentFile } from "@/lib/attachment-upload-client";
import { cn } from "@/lib/utils";
import type { ThreadMessage } from "./ticket-thread";

interface TicketReplyFormProps {
  ticketId: string;
  canInternalNote: boolean;
  onMessageSent?: (message: ThreadMessage) => void;
}

export function TicketReplyForm({
  ticketId,
  canInternalNote,
  onMessageSent,
}: TicketReplyFormProps) {
  const [body, setBody] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) {
      toast.error("Reply cannot be empty");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          isInternal,
          direction: isInternal ? "INTERNAL_NOTE" : "OUTBOUND",
          // Only meaningful for an internal note — see
          // app/api/tickets/[id]/reply/route.ts, which ignores this
          // entirely for a public reply.
          mentionUserIds: isInternal ? extractMentionedUserIdsFromBody(body) : [],
        }),
      });

      if (!res.ok) throw new Error("Failed to send reply");

      const message: ThreadMessage = await res.json();

      // Upload attachments sequentially (shared upload helper, same route).
      if (attachments.length > 0) {
        setUploadingFile(true);
        const failures: string[] = [];
        for (const file of attachments) {
          const result = await uploadAttachmentFile(`/api/tickets/${ticketId}/attachments`, file, { fields: { messageId: message.id } });
          if (!result.ok) failures.push(`${file.name}: ${result.error}`);
        }
        setUploadingFile(false);
        if (failures.length > 0) toast.error(`${failures.length} attachment(s) could not be uploaded: ${failures.join("; ")}`);
      }

      // Optimistic append — parent adds the message immediately
      onMessageSent?.(message);

      setBody("");
      setAttachments([]);
      setIsInternal(false);
      toast.success(isInternal ? "Internal note added" : "Reply sent");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to send reply");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };


  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Mode toggle — only for staff */}
      {canInternalNote && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={!isInternal ? "default" : "outline"}
            onClick={() => setIsInternal(false)}
          >
            <Send className="h-3.5 w-3.5 mr-1.5" />
            Public Reply
          </Button>
          <Button
            type="button"
            size="sm"
            variant={isInternal ? "default" : "outline"}
            onClick={() => setIsInternal(true)}
            className={isInternal ? "bg-amber-500 hover:bg-amber-600 border-amber-500" : ""}
          >
            <Lock className="h-3.5 w-3.5 mr-1.5" />
            Internal Note
          </Button>
        </div>
      )}

      <div
        className={cn(
          "rounded-xl border shadow-sm",
          isInternal ? "border-amber-300 bg-amber-50" : "bg-background"
        )}
      >
        {isInternal ? (
          // Internal notes are the "Ticket Notes" surface — @mention
          // support is only ever offered here, never on a public reply
          // (see app/api/tickets/[id]/reply/route.ts and
          // components/notes/mention-textarea.tsx).
          <MentionTextarea
            value={body}
            onChange={setBody}
            entityType="ticket"
            entityId={ticketId}
            onKeyDown={handleKeyDown}
            placeholder="Internal note — only visible to IT staff... (Ctrl+Enter to send, @ to mention someone)"
            className={cn(
              "min-h-[100px] resize-none border-0 focus-visible:ring-0 rounded-b-none text-sm",
              "bg-amber-50 placeholder:text-amber-700/50"
            )}
          />
        ) : (
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a reply... (Ctrl+Enter to send)"
            className="min-h-[100px] resize-none border-0 focus-visible:ring-0 rounded-b-none text-sm"
          />
        )}

        {/* Staged attachments */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 py-2 border-t border-border/40">
            {attachments.map((file, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded border bg-background px-2 py-1 text-xs"
              >
                <AttachmentFileIcon mimeType={file.type} name={file.name} className="h-3 w-3" />
                <span className="max-w-[120px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Attach: shared dropzone (drag & drop or browse) */}
        <div className="px-3 pt-2 border-t border-border/40">
          <AttachmentDropzone
            variant="compact"
            existing={attachments}
            disabled={isSubmitting || uploadingFile}
            onFiles={(added) => setAttachments((prev) => [...prev, ...added])}
          />
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-end px-3 py-2">
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting || uploadingFile || !body.trim()}
            className={isInternal ? "bg-amber-500 hover:bg-amber-600" : ""}
          >
            {isSubmitting || uploadingFile ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : isInternal ? (
              <Lock className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1.5" />
            )}
            {isInternal ? "Add Note" : "Send Reply"}
          </Button>
        </div>
      </div>
    </form>
  );
}
