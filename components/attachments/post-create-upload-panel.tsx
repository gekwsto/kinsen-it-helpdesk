"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paperclip, Loader2, CheckCircle2, XCircle, RotateCcw } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import type { PendingUploadEntry } from "@/hooks/use-create-with-attachments";

interface PostCreateUploadPanelProps {
  entityLabel: string;
  entries: PendingUploadEntry[];
  uploading: boolean;
  onRetryFailed: () => void;
  onContinue: () => void;
}

/**
 * Shown INSTEAD of the create form once the entity has been successfully
 * created — the entity now exists, so the form fields must never be
 * resubmitted (see useCreateWithAttachments's `locked`). Lists every
 * selected file's upload outcome; when at least one failed, offers
 * "Retry failed uploads" (retries only the failed ones — succeeded files
 * are never re-sent) and "Continue" to leave without retrying. On full
 * success the caller navigates automatically and this panel is never seen
 * with failures at all — see each form's own onSubmit.
 */
export function PostCreateUploadPanel({ entityLabel, entries, uploading, onRetryFailed, onContinue }: PostCreateUploadPanelProps) {
  const failedCount = entries.filter((e) => e.status === "failed").length;
  const successCount = entries.filter((e) => e.status === "success").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Paperclip className="h-4 w-4" />
          Uploading attachments
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {entityLabel} was created.{" "}
          {failedCount > 0
            ? `${successCount} of ${entries.length} file(s) uploaded; ${failedCount} failed.`
            : uploading
            ? "Uploading the selected files…"
            : `${successCount} of ${entries.length} file(s) uploaded.`}
        </p>

        <div className="space-y-2">
          {entries.map((entry, index) => (
            <div key={`${entry.file.name}-${index}`} className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              {entry.status === "uploading" && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
              {entry.status === "success" && <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-green-600" />}
              {entry.status === "failed" && <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />}
              {entry.status === "pending" && <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{entry.file.name}</p>
                <p className="text-muted-foreground mt-0.5">
                  {formatBytes(entry.file.size)}
                  {entry.status === "failed" && entry.error && <span className="text-destructive"> · {entry.error}</span>}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          {failedCount > 0 && (
            <Button type="button" variant="outline" disabled={uploading} onClick={onRetryFailed}>
              {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Retry failed uploads
            </Button>
          )}
          <Button type="button" disabled={uploading} onClick={onContinue}>
            Continue to {entityLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
