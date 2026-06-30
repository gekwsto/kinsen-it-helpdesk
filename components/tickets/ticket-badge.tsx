"use client";

import { cn } from "@/lib/utils";
import { Mail, Globe } from "lucide-react";

interface ColorBadgeProps {
  name: string;
  color: string;
  className?: string;
}

export function ColorBadge({ name, color, className }: ColorBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        className
      )}
      style={{
        backgroundColor: color + "20",
        color: color,
        border: `1px solid ${color}40`,
      }}
    >
      {name}
    </span>
  );
}

export function StatusBadge({ name, color }: { name: string; color: string }) {
  return <ColorBadge name={name} color={color} />;
}

export function SourceBadge({ source }: { source: string }) {
  if (source === "EMAIL") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 text-[10px] font-medium">
        <Mail className="h-3 w-3" />
        Email
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 text-slate-600 border border-slate-200 px-2 py-0.5 text-[10px] font-medium">
      <Globe className="h-3 w-3" />
      Portal
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
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: color + "20",
        color: color,
        border: `1px solid ${color}40`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}
