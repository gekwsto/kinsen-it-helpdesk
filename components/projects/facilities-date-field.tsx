"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;

interface FacilitiesDateFieldProps {
  label: string;
  required?: boolean;
  precision: "EXACT" | "QUARTER";
  onPrecisionChange: (precision: "EXACT" | "QUARTER") => void;
  exactValue: string;
  onExactChange: (value: string) => void;
  quarter: string;
  onQuarterChange: (value: string) => void;
  year: string;
  onYearChange: (value: string) => void;
}

/**
 * One Facilities Services Start/End field — a small Exact/Quarter toggle
 * above either the existing native date input (same as every other date
 * field in this app) or a Quarter (Q1–Q4) + Year pair. Switching the
 * toggle clears the OTHER representation's own local state (handled by the
 * caller, not here) so a stale value from before the switch is never sent
 * alongside the new one — see ProjectForm's own onSubmit and the Edit
 * Project page's equivalent handler.
 */
export function FacilitiesDateField({
  label,
  required,
  precision,
  onPrecisionChange,
  exactValue,
  onExactChange,
  quarter,
  onQuarterChange,
  year,
  onYearChange,
}: FacilitiesDateFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        <div className="inline-flex rounded-md border p-0.5 text-xs">
          {(["EXACT", "QUARTER"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPrecisionChange(p)}
              className={cn(
                "px-2 py-0.5 rounded-sm transition-colors",
                precision === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p === "EXACT" ? "Exact date" : "Quarter"}
            </button>
          ))}
        </div>
      </div>
      {precision === "QUARTER" ? (
        <div className="grid grid-cols-2 gap-2">
          <Select value={quarter} onValueChange={onQuarterChange}>
            <SelectTrigger>
              <SelectValue placeholder="Quarter" />
            </SelectTrigger>
            <SelectContent>
              {QUARTERS.map((q) => (
                <SelectItem key={q} value={q}>
                  {q}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            inputMode="numeric"
            placeholder="Year"
            value={year}
            onChange={(e) => onYearChange(e.target.value)}
          />
        </div>
      ) : (
        <Input type="date" value={exactValue} onChange={(e) => onExactChange(e.target.value)} />
      )}
    </div>
  );
}
