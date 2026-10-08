"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { formatDate, cn } from "@/lib/utils";
import { MessageSquareHeart } from "lucide-react";

const SCALE = [
  { value: 1, label: "Καθόλου" },
  { value: 2, label: "Λίγο" },
  { value: 3, label: "Ούτε λίγο ούτε πολύ" },
  { value: 4, label: "Αρκετά" },
  { value: 5, label: "Πολύ" },
] as const;

export type RatingField = "deliverySpeedRating" | "communicationRating" | "functionalityRating" | "easeOfUseRating" | "overallRating";

const QUESTIONS: { field: RatingField; label: string }[] = [
  { field: "deliverySpeedRating", label: "Πόσο ικανοποιημένοι είστε με την ταχύτητα παράδοσης του έργου;" },
  { field: "communicationRating", label: "Πόσο ικανοποιημένοι είστε με την επικοινωνία με την ομάδα;" },
  { field: "functionalityRating", label: "Πόσο ικανοποιημένοι είστε με τις λειτουργίες που παραδόθηκαν;" },
  { field: "easeOfUseRating", label: "Πόσο ικανοποιημένοι είστε με την ευκολία χρήσης;" },
  { field: "overallRating", label: "Πόσο ικανοποιημένοι είστε συνολικά από την υλοποίηση;" },
];

export interface SubmittedProjectFeedback {
  deliverySpeedRating: number;
  communicationRating: number;
  functionalityRating: number;
  easeOfUseRating: number;
  overallRating: number;
  requirementsDelivered: boolean;
  comments: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFeedbackSummaryInfo {
  title: string;
  departmentName: string | null;
  expectedStartDate: string | null;
  expectedFinishDate: string | null;
  owners: { id: string; name: string | null; email: string }[];
}

interface ProjectFeedbackCardProps {
  projectId: string;
  /** Project.status === COMPLETED right now — gates whether the form is editable (see this component's own render logic below). */
  isProjectCompleted: boolean;
  /** Present when this requester already submitted feedback (including across a reload, or after the Project was later reopened). */
  initialFeedback: SubmittedProjectFeedback | null;
  projectSummary: ProjectFeedbackSummaryInfo;
}

type RatingValues = Record<RatingField, number | null>;

function emptyRatings(): RatingValues {
  return { deliverySpeedRating: null, communicationRating: null, functionalityRating: null, easeOfUseRating: null, overallRating: null };
}

function ratingsFromFeedback(feedback: SubmittedProjectFeedback): RatingValues {
  return {
    deliverySpeedRating: feedback.deliverySpeedRating,
    communicationRating: feedback.communicationRating,
    functionalityRating: feedback.functionalityRating,
    easeOfUseRating: feedback.easeOfUseRating,
    overallRating: feedback.overallRating,
  };
}

/** Read-only "Σχετικό Έργο" section — existing Project information only, never an editable control. Shared by both the editable-form and readonly-summary render paths below. */
function ProjectSummarySection({ summary }: { summary: ProjectFeedbackSummaryInfo }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4 space-y-2 text-sm">
      <h3 className="text-sm font-semibold mb-1">Σχετικό Έργο</h3>
      <p>
        <span className="text-muted-foreground">Τίτλος: </span>
        <span className="font-medium">{summary.title}</span>
      </p>
      <p>
        <span className="text-muted-foreground">Workspace: </span>
        {summary.departmentName ?? "—"}
      </p>
      <p>
        <span className="text-muted-foreground">Ημερομηνία Έναρξης: </span>
        {summary.expectedStartDate ? formatDate(summary.expectedStartDate) : "—"}
      </p>
      <p>
        <span className="text-muted-foreground">Ημερομηνία Ολοκλήρωσης: </span>
        {summary.expectedFinishDate ? formatDate(summary.expectedFinishDate) : "—"}
      </p>
      <p>
        <span className="text-muted-foreground">Owner{summary.owners.length === 1 ? "" : "(s)"}: </span>
        {summary.owners.length > 0 ? summary.owners.map((o) => o.name ?? o.email).join(", ") : "—"}
      </p>
    </div>
  );
}

function ScaleRow({
  question,
  value,
  onChange,
  disabled,
}: {
  question: { field: RatingField; label: string };
  value: number | null;
  onChange: (field: RatingField, value: number) => void;
  disabled: boolean;
}) {
  const groupLabelId = `${question.field}-label`;
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <Label id={groupLabelId} className="font-normal">
        {question.label}
      </Label>
      <div role="radiogroup" aria-labelledby={groupLabelId} className="grid grid-cols-5 gap-2">
        {SCALE.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md border px-2 py-2 text-center cursor-pointer transition-colors",
              value === opt.value ? "border-primary bg-primary/10" : "hover:bg-muted",
              disabled && "cursor-not-allowed opacity-60"
            )}
          >
            <input
              type="radio"
              name={question.field}
              value={opt.value}
              checked={value === opt.value}
              disabled={disabled}
              onChange={() => onChange(question.field, opt.value)}
              className="sr-only"
              aria-label={`${opt.value} — ${opt.label}`}
            />
            <span className={cn("text-sm font-semibold", value === opt.value && "text-primary")}>{opt.value}</span>
            <span className="text-[10px] leading-tight text-muted-foreground">{opt.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * The ORIGINAL Project Request requester's Feedback card — only ever
 * rendered by app/(main)/projects/[id]/page.tsx for that exact user, on a
 * request-origin Project, once it's COMPLETED (or feedback already exists
 * — e.g. the Project was reopened after submission). Replaces the old
 * single 1-10 satisfactionScore form with five independent 1-5 ratings +
 * a separate requirementsDelivered boolean + optional comments, and is now
 * EDITABLE (update, not a second submission) while the Project is
 * COMPLETED. POST /api/projects/[id]/feedback is the sole source of truth
 * for every rule this component's own UI gating only mirrors for UX.
 *
 * Three render states:
 *  - isProjectCompleted true  -> editable form (pre-filled from
 *    initialFeedback when it exists — "update" rather than a blank form).
 *  - isProjectCompleted false AND feedback already exists -> readonly
 *    summary of the existing answers (the Project was reopened after
 *    submission; historical record stays visible, but may not be edited
 *    until COMPLETED again).
 *  - isProjectCompleted false AND no feedback -> this component is never
 *    even rendered (see the Project detail page's own gating condition).
 */
export function ProjectFeedbackCard({ projectId, isProjectCompleted, initialFeedback, projectSummary }: ProjectFeedbackCardProps) {
  const [feedback, setFeedback] = useState<SubmittedProjectFeedback | null>(initialFeedback);
  const [ratings, setRatings] = useState<RatingValues>(initialFeedback ? ratingsFromFeedback(initialFeedback) : emptyRatings());
  const [requirementsDelivered, setRequirementsDelivered] = useState(initialFeedback?.requirementsDelivered ?? false);
  const [comments, setComments] = useState(initialFeedback?.comments ?? "");
  const [submitting, setSubmitting] = useState(false);

  const isUpdate = feedback !== null;

  // Reopened after submission — the existing answers remain fully visible,
  // but the form itself is never editable outside COMPLETED.
  if (!isProjectCompleted && feedback) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquareHeart className="h-4 w-4" />
            Αξιολόγηση Έργου
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            {QUESTIONS.map((q) => (
              <p key={q.field}>
                <span className="text-muted-foreground">{q.label} </span>
                <span className="font-medium">{ratingsFromFeedback(feedback)[q.field]} / 5</span>
              </p>
            ))}
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές: </span>
            <span className="font-medium">{feedback.requirementsDelivered ? "Ναι" : "Όχι"}</span>
          </p>
          {feedback.comments && (
            <div className="text-sm">
              <p className="text-muted-foreground mb-1">Σχόλια:</p>
              <p className="whitespace-pre-wrap">&ldquo;{feedback.comments}&rdquo;</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Υποβλήθηκε: {formatDate(feedback.createdAt)}</p>
          <Separator />
          <ProjectSummarySection summary={projectSummary} />
        </CardContent>
      </Card>
    );
  }

  const allRatingsSelected = QUESTIONS.every((q) => ratings[q.field] !== null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allRatingsSelected) {
      toast.error("Επιλέξτε μία απάντηση για κάθε ερώτηση.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliverySpeedRating: ratings.deliverySpeedRating,
          communicationRating: ratings.communicationRating,
          functionalityRating: ratings.functionalityRating,
          easeOfUseRating: ratings.easeOfUseRating,
          overallRating: ratings.overallRating,
          requirementsDelivered,
          comments: comments.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Η υποβολή της αξιολόγησης απέτυχε.");
      }
      const saved = await res.json();
      setFeedback({
        deliverySpeedRating: saved.deliverySpeedRating,
        communicationRating: saved.communicationRating,
        functionalityRating: saved.functionalityRating,
        easeOfUseRating: saved.easeOfUseRating,
        overallRating: saved.overallRating,
        requirementsDelivered: saved.requirementsDelivered,
        comments: saved.comments,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      });
      toast.success("Ευχαριστούμε για την αξιολόγησή σας");
    } catch (error: any) {
      toast.error(error.message ?? "Η υποβολή της αξιολόγησης απέτυχε.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquareHeart className="h-4 w-4" />
          Αξιολόγηση Έργου
        </CardTitle>
        <p className="text-xs text-muted-foreground">Αξιολογήστε το ολοκληρωμένο έργο επιλέγοντας μία απάντηση για κάθε ερώτηση.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {QUESTIONS.map((q) => (
            <ScaleRow key={q.field} question={q} value={ratings[q.field]} onChange={(field, value) => setRatings((prev) => ({ ...prev, [field]: value }))} disabled={submitting} />
          ))}

          <div className="flex items-start gap-3 rounded-lg border p-4">
            <input
              type="checkbox"
              id="requirements-delivered"
              className="h-4 w-4 mt-0.5 rounded"
              checked={requirementsDelivered}
              disabled={submitting}
              onChange={(e) => setRequirementsDelivered(e.target.checked)}
            />
            <Label htmlFor="requirements-delivered" className="cursor-pointer font-normal">
              Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές
            </Label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-comments">Προαιρετικά Σχόλια</Label>
            <Textarea
              id="feedback-comments"
              placeholder="Προσθέστε οποιοδήποτε επιπλέον σχόλιο για το έργο..."
              value={comments}
              disabled={submitting}
              onChange={(e) => setComments(e.target.value)}
              maxLength={2000}
              rows={4}
            />
          </div>

          <Separator />
          <ProjectSummarySection summary={projectSummary} />

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting || !allRatingsSelected}>
              {isUpdate ? "Ενημέρωση Αξιολόγησης" : "Υποβολή Αξιολόγησης"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
