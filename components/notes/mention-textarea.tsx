"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { buildMentionToken } from "@/lib/mentions/mention-tokens";
import type { MentionEntityType } from "@/lib/services/mention-service";

interface MentionCandidate {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Which entity's eligible-viewer pool the picker searches — see app/api/mentions/search/route.ts. */
  entityType: MentionEntityType;
  entityId: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Fires for every keydown the mention dropdown did NOT itself handle (e.g. so a caller's Ctrl+Enter-to-submit shortcut keeps working when the dropdown is closed). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Drop-in replacement for a plain `<Textarea>` that adds @mention support —
 * the ONE shared implementation components/notes/note-composer.tsx (Project/
 * Activity Notes) and components/tickets/ticket-reply-form.tsx (Ticket
 * internal notes) both use, rather than three separate mention UIs.
 *
 * Typing `@` at the start of a "word" (preceded by whitespace or the start
 * of the text — so `foo@bar.com` never triggers it) opens a searchable
 * dropdown of users eligible to view the current entity (see
 * app/api/mentions/search/route.ts). Continuing to type narrows the query;
 * Arrow Up/Down move the highlight, Enter/Tab selects, Escape closes the
 * dropdown without touching the text, and clicking a suggestion selects it
 * too. Selecting a candidate inserts a structured `@[Name](user:id)` token
 * (see lib/mentions/mention-tokens.ts) — never plain `@Name` text — so the
 * server can tell a real mention from someone merely typing an `@word`.
 *
 * The dropdown is anchored directly below the textarea rather than at the
 * live caret position — a deliberate simplification (a pixel-accurate
 * caret-relative popup over a plain `<textarea>` needs a hidden mirror-div
 * measurement technique that's easy to get subtly wrong across
 * fonts/wrapping); every functional requirement (search-as-you-type,
 * keyboard nav, mouse select) still works identically.
 */
export function MentionTextarea({
  value,
  onChange,
  entityType,
  entityId,
  placeholder,
  disabled,
  className,
  onKeyDown,
  textareaRef: externalRef,
}: MentionTextareaProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;

  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const requestSeq = useRef(0);

  const closeDropdown = useCallback(() => {
    setTrigger(null);
    setCandidates([]);
    setHighlightedIndex(0);
  }, []);

  // Debounced search whenever the active trigger's query text changes.
  useEffect(() => {
    if (!trigger) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ entityType, entityId, q: trigger.query });
        const res = await fetch(`/api/mentions/search?${params.toString()}`);
        if (seq !== requestSeq.current) return; // a newer keystroke superseded this request
        if (!res.ok) {
          setCandidates([]);
          return;
        }
        const data: MentionCandidate[] = await res.json();
        if (seq !== requestSeq.current) return;
        setCandidates(data);
        setHighlightedIndex(0);
      } catch {
        if (seq === requestSeq.current) setCandidates([]);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [trigger, entityType, entityId]);

  /** Recomputes the active mention trigger (if any) from the textarea's current text + cursor position. */
  const recomputeTrigger = useCallback((text: string, cursorPos: number) => {
    // Scan back from the cursor to the nearest "@" that starts a word and
    // has no whitespace/newline between it and the cursor.
    let i = cursorPos - 1;
    while (i >= 0 && !/\s/.test(text[i]) && text[i] !== "@") i--;
    if (i >= 0 && text[i] === "@" && (i === 0 || /\s/.test(text[i - 1]))) {
      setTrigger({ start: i, query: text.slice(i + 1, cursorPos) });
    } else {
      closeDropdown();
    }
  }, [closeDropdown]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    recomputeTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const handleSelectionChange = () => {
    const el = textareaRef.current;
    if (!el) return;
    recomputeTrigger(el.value, el.selectionStart ?? 0);
  };

  const selectCandidate = (candidate: MentionCandidate) => {
    const el = textareaRef.current;
    if (!el || !trigger) return;
    const cursorPos = el.selectionStart ?? trigger.start + 1 + trigger.query.length;
    const token = buildMentionToken(candidate.id, candidate.name?.trim() || candidate.email);
    const newValue = `${value.slice(0, trigger.start)}${token} ${value.slice(cursorPos)}`;
    const newCursorPos = trigger.start + token.length + 1;
    onChange(newValue);
    closeDropdown();
    // Restore focus + cursor after the value prop round-trips back in.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(newCursorPos, newCursorPos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        selectCandidate(candidates[highlightedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeDropdown();
        return;
      }
    }
    onKeyDown?.(e);
  };

  const showDropdown = trigger !== null;

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={handleSelectionChange}
        onClick={handleSelectionChange}
        onBlur={closeDropdown}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
      {showDropdown && (
        <div
          // Prevents the textarea from blurring (which would close this
          // dropdown) before a click on a suggestion below registers.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 top-full z-20 mt-1 max-h-56 w-full max-w-xs overflow-y-auto rounded-md border bg-popover shadow-md"
        >
          {loading && candidates.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Searching…
            </div>
          ) : candidates.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No matching users.
            </div>
          ) : (
            <ul>
              {candidates.map((candidate, i) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => selectCandidate(candidate)}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      i === highlightedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                    }`}
                  >
                    <Avatar className="h-5 w-5 shrink-0">
                      <AvatarImage src={candidate.image ?? undefined} />
                      <AvatarFallback className="text-[9px]">
                        {getInitials(candidate.name ?? candidate.email)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate">{candidate.name ?? candidate.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
