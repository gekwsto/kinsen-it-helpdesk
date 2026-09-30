"use client";

import { cn } from "@/lib/utils";
import { Mail, Globe, Plug } from "lucide-react";
import { StatusMark, PriorityMark } from "@/components/shared/marks";

interface ColorBadgeProps {
  name: string;
  color: string;
  className?: string;
}

/** Category-style label: neutral text with a small square swatch (colour is admin-picked, so never used as text colour). */
export function ColorBadge({ name, color, className }: ColorBadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground", className)}>
      <span className="h-2 w-2 shrink-0 rounded-[1px]" style={{ backgroundColor: color }} aria-hidden="true" />
      {name}
    </span>
  );
}

export function StatusBadge({ name, color, isClosed }: { name: string; color: string; isClosed?: boolean }) {
  return <StatusMark label={name} color={color} closed={isClosed} />;
}

const SOURCES: Record<string, { label: string; icon: typeof Mail }> = {
  EMAIL: { label: "Email", icon: Mail },
  API: { label: "Integration", icon: Plug },
};

export function SourceBadge({ source, compact }: { source: string; compact?: boolean }) {
  const { label, icon: Icon } = SOURCES[source] ?? { label: "Portal", icon: Globe };
  if (compact) {
    return (
      <span className="inline-flex text-muted-foreground" title={`Source: ${label}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PriorityBadge({
  name,
  color,
  level,
}: {
  name: string;
  color: string;
  level: number;
}) {
  return <PriorityMark label={name} rank={level} color={color} />;
}
