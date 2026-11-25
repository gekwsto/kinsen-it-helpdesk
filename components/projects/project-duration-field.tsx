"use client";

import { RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_PROJECT_DURATION_DAYS } from "@/lib/project-duration";

/**
 * Parses a duration field's manual text for submission. `null` manual text
 * means automatic mode -> `{ ok: true, value: null }` (reset/keep
 * calculated). Otherwise the text must be a whole, non-negative number of
 * days. The server (projectDurationOverrideSchema + resolveProjectDuration)
 * re-validates and resolves authoritatively regardless.
 */
export function parseDurationOverride(manualText: string | null): { ok: true; value: number | null } | { ok: false } {
  if (manualText === null) return { ok: true, value: null };
  const trimmed = manualText.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (value > MAX_PROJECT_DURATION_DAYS) return { ok: false };
  return { ok: true, value };
}

interface ProjectDurationFieldProps {
  id: string;
  label: string;
  /** The automatic value from lib/project-duration.ts's calculateProjectDurationDays — the same calculation the server persists. */
  calculatedValue: number | null;
  /** null = automatic mode; a string = manual override (raw input text). */
  manualText: string | null;
  onManualTextChange: (manualText: string | null) => void;
  /** e.g. "Expected Start/Finish Date" — used in the helper text. */
  sourceLabel: string;
  disabled?: boolean;
}

/**
 * One Project duration (Expected Total Initial Days / Actual Total Days).
 * Shows the calculated value while automatic; typing switches to a manual
 * override that later date changes never overwrite; "Reset" returns to the
 * calculated value. Editing the duration never touches the dates.
 */
export function ProjectDurationField({ id, label, calculatedValue, manualText, onManualTextChange, sourceLabel, disabled }: ProjectDurationFieldProps) {
  const isManual = manualText !== null;
  const invalid = isManual && !parseDurationOverride(manualText).ok;
  const helperId = `${id}-helper`;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {isManual && (
          <button
            type="button"
            onClick={() => onManualTextChange(null)}
            disabled={disabled}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to calculated value
          </button>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={isManual ? manualText : calculatedValue !== null ? String(calculatedValue) : ""}
          placeholder="Select both dates to calculate"
          onChange={(e) => onManualTextChange(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={helperId}
          className="pr-14"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">days</span>
      </div>
      <p id={helperId} className={invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {invalid
          ? "Enter a whole number of days (0 or more)."
          : isManual
          ? `Manually set (working days) — calculated value: ${calculatedValue !== null ? `${calculatedValue} day${calculatedValue === 1 ? "" : "s"}` : "not available"}.`
          : `Working days (Mon–Fri), calculated from ${sourceLabel}. Enter a value to override.`}
      </p>
    </div>
  );
}
