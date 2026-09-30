import { cn } from "@/lib/utils";

/**
 * The one visual language for status and priority across tickets, projects
 * and activities. Colour is admin-configured per department and can be any
 * hex (including pale yellows), so it is only ever drawn as a MARK beside
 * neutral text — never as the text colour or a tinted pill — and every
 * mark also carries a shape, so colour is never the only signal.
 */

interface StatusMarkProps {
  label: string;
  color: string;
  /** Closed/terminal statuses draw a filled mark with a check; open ones a ring. Omit when unknown. */
  closed?: boolean;
  className?: string;
}

export function StatusMark({ label, color, closed, className }: StatusMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground", className)}>
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
        {closed ? (
          <>
            <circle cx="6" cy="6" r="6" fill={color} />
            <path d="M3.4 6.2l1.7 1.7 3.5-3.6" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : (
          <>
            <circle cx="6" cy="6" r="4.75" fill="none" stroke={color} strokeWidth="2.5" />
            <circle cx="6" cy="6" r="1.6" fill={color} />
          </>
        )}
      </svg>
      {label}
    </span>
  );
}

/** Compact mark-only variant for tight layouts (Gantt bars, resource rows); pair it with visible text or a title nearby. */
export function StatusDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}

interface PriorityMarkProps {
  label: string;
  /** 1 (lowest) to 4 (highest); drives how many bars are filled. */
  rank: number;
  color?: string;
  className?: string;
}

export function PriorityMark({ label, rank, color, className }: PriorityMarkProps) {
  const filled = Math.max(1, Math.min(4, Math.round(rank)));
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground", className)}>
      <svg viewBox="0 0 14 12" className="h-3 w-3.5 shrink-0" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={i * 3.6}
            y={9 - i * 3}
            width="2.4"
            height={3 + i * 3}
            rx="0.4"
            fill={i < filled ? color ?? "currentColor" : "hsl(var(--border))"}
          />
        ))}
      </svg>
      {label}
    </span>
  );
}

/** Black-ish or white text, whichever reads better on an arbitrary (admin-picked) fill. */
export function readableTextOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#FFFFFF";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.05) ? "#FFFFFF" : "#0D1B26";
}

/** "URGENT" -> "Urgent" for enum-backed priorities. */
export function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
