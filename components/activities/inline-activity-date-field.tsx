"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { Pencil, Loader2 } from "lucide-react";

interface InlineActivityDateFieldProps {
  /** ISO string (any precision — only the date portion is ever read/sent) or null. */
  value: string | null;
  /** activity.edit for this Activity's department — same permission every other mutation on this page already gates on. A caller without it never renders this component in edit mode at all. */
  canEdit: boolean;
  /** True while a DIFFERENT one of this page's 4 inline date fields has a save in flight — disables entering edit mode here too, so two date edits on the same Activity can never race each other's PATCH. */
  disabled?: boolean;
  /** True while THIS field's own save is in flight. */
  isSaving: boolean;
  /**
   * Sends the actual PATCH — the ONE place that talks to the API for every
   * one of this page's 4 date fields (see the single updateActivityDate
   * in activity-detail-client.tsx); this component only decides WHEN to
   * call it and what to show while waiting. `value` is the raw
   * "YYYY-MM-DD" string from the native date input, or null when cleared —
   * passed straight through, never reformatted or reinterpreted (the
   * server is the single source of truth for date-only normalization, see
   * lib/date-only.ts). Resolves to whether the save succeeded.
   */
  onSave: (value: string | null) => Promise<boolean>;
}

/**
 * A single Activity Timeline date, editable in place via the browser's own
 * native date input (clicking it opens the OS/browser date picker exactly
 * like every other date field in this app — there is no separate custom
 * Date Picker component in this codebase; `<input type="date">` IS the
 * canonical one, see activity-edit-client.tsx / activity-new-form.tsx).
 * Read-only users (canEdit: false) see a plain, unclickable date — no hover
 * affordance at all.
 */
export function InlineActivityDateField({ value, canEdit, disabled, isSaving, onSave }: InlineActivityDateFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ? value.substring(0, 10) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-syncs the draft from the authoritative value on every render WHILE
  // not editing (a successful save's fresh value, or simply a different
  // Activity's data loading in) — but never clobbers an in-flight edit's
  // own draft, same "props win, but not over a live edit" rule the rest of
  // this page already applies to `activity` itself.
  useEffect(() => {
    if (!editing) setDraft(value ? value.substring(0, 10) : "");
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      try {
        inputRef.current?.showPicker?.();
      } catch {
        // showPicker() can throw (not user-activated, unsupported browser,
        // etc.) — the input is still perfectly usable by clicking it
        // directly, so this is never worth surfacing.
      }
    }
  }, [editing]);

  if (!canEdit) {
    return <p className="font-medium">{value ? formatDate(value) : "Not set"}</p>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        className="group inline-flex items-center gap-1 text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className={value ? "font-medium" : "font-medium text-muted-foreground italic"}>
          {value ? formatDate(value) : "Not set"}
        </span>
        <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        ref={inputRef}
        type="date"
        autoFocus
        value={draft}
        disabled={isSaving}
        className="h-7 w-[150px] px-2 text-sm"
        onChange={async (e) => {
          const newValue = e.target.value || null;
          setDraft(e.target.value);
          const ok = await onSave(newValue);
          if (ok) setEditing(false);
          // On failure, stay in edit mode with the attempted (rejected)
          // value visible so the user can see what was tried and correct
          // it — the error itself is surfaced by the caller (toast).
        }}
        onBlur={() => {
          if (!isSaving) setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
      />
      {isSaving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  );
}
