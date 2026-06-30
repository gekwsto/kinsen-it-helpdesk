"use client";

import { useRef, useState } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface SimpleCommentBoxProps {
  onSubmit: (text: string) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

export function SimpleCommentBox({
  onSubmit,
  disabled = false,
  placeholder = "Add a message for the IT team…",
}: SimpleCommentBoxProps) {
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
        className="min-h-[96px] resize-y text-sm"
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
          variant="secondary"
          className="gap-1.5"
          disabled={!text.trim() || disabled || isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5" />
          )}
          Post Comment
        </Button>
      </div>
    </div>
  );
}
