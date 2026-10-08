import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MessageSquareHeart } from "lucide-react";

interface ProjectFeedbackCtaCardProps {
  projectId: string;
  hasExistingFeedback: boolean;
}

/**
 * The Project detail page's only trace of the Feedback feature — a small
 * CTA, never the full evaluation form (that now lives exclusively on the
 * dedicated /projects/[id]/feedback page; see
 * components/projects/project-feedback-card.tsx). Rendered server-side,
 * no client-side state of its own — both labels and the destination are
 * static given the two booleans the caller already resolved.
 */
export function ProjectFeedbackCtaCard({ projectId, hasExistingFeedback }: ProjectFeedbackCtaCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquareHeart className="h-4 w-4" />
          Αξιολόγηση Έργου
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href={`/projects/${projectId}/feedback`}>
            {hasExistingFeedback ? "Προβολή / Ενημέρωση Αξιολόγησης" : "Μετάβαση στην Αξιολόγηση"}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
