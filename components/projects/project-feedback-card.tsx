"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/utils";
import { MessageSquareHeart } from "lucide-react";

const RATINGS = Array.from({ length: 10 }, (_, i) => i + 1);

export interface SubmittedProjectFeedback {
  satisfactionScore: number;
  comments: string | null;
  createdAt: string;
}

interface ProjectFeedbackCardProps {
  projectId: string;
  /** Present when this requester already submitted feedback (including across a reload, or after the Project was later reopened — see this card's own doc comment below) — renders the readonly result immediately, never the form. */
  initialFeedback: SubmittedProjectFeedback | null;
}

/**
 * The ORIGINAL Project Request requester's compact Feedback card — only
 * ever rendered by app/(main)/projects/[id]/page.tsx for that exact user,
 * on a request-origin Project, once it's COMPLETED (or feedback already
 * exists — e.g. the Project was reopened after submission; the form never
 * reappears just because the Project is no longer currently completed,
 * since feedback is historical evidence of what was evaluated at
 * completion time, not a living document).
 *
 * Deliberately small: exactly the two fields the feature's own spec asks
 * for (a 1-10 rating + optional comments), no draft-saving, no edit/delete
 * — submission is a one-time, immutable action. POST
 * /api/projects/[id]/feedback is the sole source of truth for every rule
 * this component's own UI gating only mirrors for UX; a duplicate/forged
 * attempt is rejected (or resolved to the existing row) server-side
 * regardless of what this component renders.
 */
export function ProjectFeedbackCard({ projectId, initialFeedback }: ProjectFeedbackCardProps) {
  const [feedback, setFeedback] = useState<SubmittedProjectFeedback | null>(initialFeedback);
  const [rating, setRating] = useState<number | null>(null);
  const [comments, setComments] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Already submitted (on this load, or just now) — readonly result, no
  // "Submit" action shown ever again.
  if (feedback) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquareHeart className="h-4 w-4" />
            Your Feedback
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">Satisfaction: </span>
            <span className="font-medium">{feedback.satisfactionScore} / 10</span>
          </p>
          {feedback.comments && (
            <div>
              <p className="text-muted-foreground mb-1">Comments:</p>
              <p className="whitespace-pre-wrap">&ldquo;{feedback.comments}&rdquo;</p>
            </div>
          )}
          <p className="text-xs text-muted-foreground pt-1">Submitted: {formatDate(feedback.createdAt)}</p>
        </CardContent>
      </Card>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating === null) {
      toast.error("Select a satisfaction rating.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ satisfactionScore: rating, comments: comments.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to submit feedback");
      }
      const created = await res.json();
      // Whether this was the real first submission or a duplicate/race
      // resolved to the already-existing row (alreadyExisted:true), the
      // UI outcome is identical: switch to the readonly result using
      // whatever the server actually has, never what was just typed.
      setFeedback({ satisfactionScore: created.satisfactionScore, comments: created.comments, createdAt: created.createdAt });
      toast.success("Thank you for your feedback");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquareHeart className="h-4 w-4" />
          Project Feedback
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label id="satisfaction-label">How satisfied are you with what was delivered?</Label>
            <div
              role="group"
              aria-labelledby="satisfaction-label"
              className="inline-flex flex-wrap items-center gap-1 rounded-md border p-1 ml-6"
            >
              {RATINGS.map((score) => (
                <Button
                  key={score}
                  type="button"
                  size="sm"
                  variant={rating === score ? "secondary" : "ghost"}
                  className="h-8 w-8 p-0"
                  aria-pressed={rating === score}
                  aria-label={`${score} out of 10`}
                  onClick={() => setRating(score)}
                >
                  {score}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-comments">Comments</Label>
            <Textarea
              id="feedback-comments"
              placeholder="Anything you'd like to share about the delivered Project (optional)..."
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              maxLength={2000}
              rows={4}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting || rating === null}>
              Submit Feedback
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
