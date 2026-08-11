"use client";

import { useRef, useState } from "react";
import { Loader2, NotebookPen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface NoteComposerProps {
  onSubmit: (body: string) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Generic plain-text note composer — textarea, Ctrl/Cmd+Enter to submit,
 * loading state, clears on success. Same UX shape as
 * components/tickets/simple-comment-box.tsx (textarea + Ctrl+Enter +
 * loading + clear-on-success), reimplemented standalone here rather than
 * shared: SimpleCommentBox is a Ticket-specific component (its copy says
 * "Post Comment" / "Add a message for the IT team…") and must keep behaving
 * exactly as it does today. This component only ever says "Add Note" /
 * "Write a note…" — there is no Reply/Internal toggle here or anywhere in
 * Project/Activity Notes.
 */
export function NoteComposer({
  onSubmit,
  disabled = false,
  placeholder = "Write a note…",
}: NoteComposerProps) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
      setText("");
      textareaRef.current?.focus();
    } catch {
      // The caller is responsible for surfacing its own error (toast); this
      // just prevents an unhandled rejection. Text is deliberately left
      // as-is on failure so the user doesn't lose what they typed.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || isSubmitting}
        className="min-h-[80px] resize-y text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit();
        }}
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">Ctrl+Enter</kbd>
          {" "}to post
        </p>
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!text.trim() || disabled || isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <NotebookPen className="h-3.5 w-3.5" />
          )}
          Add Note
        </Button>
      </div>
    </div>
  );
}
