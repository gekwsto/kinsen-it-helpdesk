import { StatusMark } from "@/components/shared/marks";

/**
 * Single visual for an Activity's status everywhere it's shown (List/Grid,
 * detail, edit form, Gantt, Resource Planning) — label and color are always
 * the CALLER's already-resolved, department-scoped values (see
 * lib/services/activity-status-config.ts), this component only renders
 * them. Never looks up a hardcoded label/color map itself. Drawn with the
 * shared StatusMark (components/shared/marks.tsx) so tickets and activities
 * speak one status language.
 */
export function StatusBadge({ label, color, className }: { label: string; color: string; className?: string }) {
  return <StatusMark label={label} color={color} className={className} />;
}

export { StatusDot } from "@/components/shared/marks";
