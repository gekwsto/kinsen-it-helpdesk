import { formatDateTime } from "@/lib/utils";

/**
 * Shared display of an approval stage that was SKIPPED at submission —
 * never shown as "Approved", and never with an approver/decision time
 * (none exists). Used by the Project Request detail page, its list preview,
 * the Final Approval panel and the Project detail page's request history.
 */

export type IntermediateSkipReason = "NO_MANAGER" | "PERMISSION_BYPASS" | "REQUESTER_OPTED_OUT";

export function intermediateSkipReasonLabel(reason: IntermediateSkipReason): string {
  if (reason === "REQUESTER_OPTED_OUT") return "skipped by the requester at submission";
  if (reason === "NO_MANAGER") return "the requester has no manager on record";
  return "skipped by role permission (legacy)";
}

export function SkippedIntermediateStage({ reason, className }: { reason: IntermediateSkipReason; className?: string }) {
  return (
    <p className={className ?? "text-sm"} data-stage="intermediate" data-stage-state="skipped">
      <span className="font-medium text-muted-foreground">Skipped</span>
      <span className="text-muted-foreground"> — {intermediateSkipReasonLabel(reason)}</span>
    </p>
  );
}

export function SkippedFinalStage({
  skippedBy,
  skippedAt,
  className,
}: {
  skippedBy: { name: string | null; email: string } | null;
  skippedAt: Date | string | null;
  className?: string;
}) {
  return (
    <div className={className ?? "text-sm"} data-stage="final" data-stage-state="skipped">
      <p>
        <span className="font-medium text-muted-foreground">Skipped</span>
        <span className="text-muted-foreground">
          {" "}
          — requested at submission{skippedBy ? ` by ${skippedBy.name ?? skippedBy.email}` : ""}
        </span>
      </p>
      {skippedAt && <p className="text-xs text-muted-foreground">{formatDateTime(skippedAt)}</p>}
    </div>
  );
}
