import type { ProjectRequestStatus } from "@prisma/client";

const STATUS_CONFIG: Record<ProjectRequestStatus, { label: string; className: string }> = {
  PENDING_INTERMEDIATE_APPROVAL: { label: "Pending Intermediate Approval", className: "bg-amber-50 text-amber-700" },
  PENDING_APPROVAL: { label: "Pending Final Approval", className: "bg-amber-50 text-amber-700" },
  APPROVED: { label: "Approved", className: "bg-green-50 text-green-700" },
  REJECTED: { label: "Rejected", className: "bg-red-50 text-red-700" },
  // Phase 3.1 — a Historical Import request's own terminal status,
  // deliberately distinct from APPROVED (see ProjectRequestStatus's own
  // schema doc comment) — a different color so it's never visually
  // mistaken for a normally-decided request at a glance.
  IMPORTED: { label: "Imported", className: "bg-slate-100 text-slate-700" },
};

/** Single source of truth for how a ProjectRequestStatus renders anywhere in the app (list rows, detail header) — never a second, independently-drifting label/color mapping. */
export function ProjectRequestStatusBadge({ status }: { status: ProjectRequestStatus }) {
  const config = STATUS_CONFIG[status];
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${config.className}`}>{config.label}</span>;
}
