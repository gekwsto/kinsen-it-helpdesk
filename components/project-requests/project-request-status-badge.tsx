import type { ProjectRequestStatus } from "@prisma/client";

const STATUS_CONFIG: Record<ProjectRequestStatus, { label: string; className: string }> = {
  PENDING_INTERMEDIATE_APPROVAL: { label: "Pending Intermediate Approval", className: "bg-amber-50 text-amber-700" },
  PENDING_APPROVAL: { label: "Pending Final Approval", className: "bg-amber-50 text-amber-700" },
  APPROVED: { label: "Approved", className: "bg-green-50 text-green-700" },
  REJECTED: { label: "Rejected", className: "bg-red-50 text-red-700" },
};

/** Single source of truth for how a ProjectRequestStatus renders anywhere in the app (list rows, detail header) — never a second, independently-drifting label/color mapping. */
export function ProjectRequestStatusBadge({ status }: { status: ProjectRequestStatus }) {
  const config = STATUS_CONFIG[status];
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${config.className}`}>{config.label}</span>;
}
