"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paperclip, Loader2, Trash2, X } from "lucide-react";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { AttachmentDropzone, AttachmentFileIcon, AttachmentUploadRow, fileSignature, type AttachmentUploadStatus } from "@/components/attachments/attachment-dropzone";
import { uploadAttachmentFile } from "@/lib/attachment-upload-client";

interface QueuedUpload {
  key: string;
  file: File;
  status: AttachmentUploadStatus;
  progress: number;
  error?: string;
}

interface Attachment {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedBy?: { id: string; name?: string | null; email: string } | null;
}

interface EntityAttachmentsProps {
  /** e.g. `/api/projects/${id}` or `/api/activities/${id}` — attachments live at `${apiBasePath}/attachments[/:attachmentId]`, same convention as EntityNotes. */
  apiBasePath: string;
  initialAttachments: Attachment[];
  /**
   * Whether upload/delete controls are shown at all. This is a UI
   * convenience only — POST/DELETE `${apiBasePath}/attachments[/...]`
   * independently re-check project.edit/activity.edit server-side and are
   * the actual authority (upload/delete = *.edit, view/download = *.view —
   * a stricter gate than the plain view access every member of this page
   * already has once it renders at all).
   */
  canManage: boolean;
}

/**
 * Shared Attachments panel for Project/Activity detail pages — generalized
 * from what used to be Activity-only (components/activities/activity-
 * attachments.tsx), the same way EntityNotes generalized Notes. Reuses the
 * exact private-storage architecture already built for Ticket/Activity
 * attachments (private UPLOAD_DIR, MIME/size allowlist, authenticated
 * per-entity download route; see lib/attachment-policy.ts and each of
 * app/api/{projects,activities}/[id]/attachments/). Every download link
 * points at the authenticated route, never a static URL. Behavior is
 * IDENTICAL for both entities — only `apiBasePath` differs; the server
 * side independently enforces which entity each id actually belongs to.
 */
export function EntityAttachments({ apiBasePath, initialAttachments, canManage }: EntityAttachmentsProps) {
  const [attachments, setAttachments] = useState<Attachment[]>(initialAttachments);
  const [queue, setQueue] = useState<QueuedUpload[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Mirrors `queue` for the sequential worker (avoids stale closures) and
  // makes a file that is already queued/uploading impossible to enqueue twice.
  const queueRef = useRef<QueuedUpload[]>([]);
  const workingRef = useRef(false);

  const patch = (key: string, changes: Partial<QueuedUpload>) => {
    queueRef.current = queueRef.current.map((q) => (q.key === key ? { ...q, ...changes } : q));
    setQueue(queueRef.current);
  };

  const processQueue = async () => {
    if (workingRef.current) return;
    workingRef.current = true;
    let uploadedCount = 0;
    try {
      for (;;) {
        const next = queueRef.current.find((q) => q.status === "pending");
        if (!next) break;
        patch(next.key, { status: "uploading", progress: 0 });
        const result = await uploadAttachmentFile<Attachment>(`${apiBasePath}/attachments`, next.file, {
          onProgress: (fraction) => patch(next.key, { progress: fraction }),
        });
        if (result.ok) {
          uploadedCount++;
          setAttachments((prev) => [result.data, ...prev]);
          queueRef.current = queueRef.current.filter((q) => q.key !== next.key);
          setQueue(queueRef.current);
        } else {
          patch(next.key, { status: "failed", error: result.error });
          toast.error(`${next.file.name}: ${result.error}`);
        }
      }
    } finally {
      workingRef.current = false;
    }
    if (uploadedCount > 0) toast.success(uploadedCount === 1 ? "Attachment uploaded" : `${uploadedCount} attachments uploaded`);
  };

  const enqueue = (files: File[]) => {
    const active = new Set(queueRef.current.filter((q) => q.status !== "failed").map((q) => q.key));
    const added = files
      .map((file) => ({ key: fileSignature(file), file, status: "pending" as const, progress: 0 }))
      .filter((q) => !active.has(q.key));
    if (added.length === 0) return;
    // A retried file replaces its own failed row.
    const addedKeys = new Set(added.map((q) => q.key));
    queueRef.current = [...queueRef.current.filter((q) => !addedKeys.has(q.key)), ...added];
    setQueue(queueRef.current);
    void processQueue();
  };

  const dismiss = (key: string) => {
    queueRef.current = queueRef.current.filter((q) => q.key !== key);
    setQueue(queueRef.current);
  };

  const uploading = queue.some((q) => q.status === "pending" || q.status === "uploading");

  const deleteAttachment = async (attachmentId: string) => {
    setDeletingId(attachmentId);
    try {
      const res = await fetch(`${apiBasePath}/attachments/${attachmentId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err.error === "string" ? err.error : "Failed to delete attachment");
        return;
      }
      setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
      toast.success("Attachment deleted");
    } catch {
      toast.error("Failed to delete attachment");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            Attachments ({attachments.length})
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage && <AttachmentDropzone variant="compact" busy={uploading} onFiles={enqueue} />}
        {queue.length > 0 && (
          <div className="space-y-2" aria-live="polite">
            {queue.map((q) => (
              <div key={q.key} className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <AttachmentUploadRow file={q.file} status={q.status} progress={q.progress} error={q.error} />
                </div>
                {q.status === "failed" && (
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground shrink-0" onClick={() => dismiss(q.key)} aria-label={`Dismiss ${q.file.name}`}>
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No attachments yet.
          </p>
        ) : (
          <div className="space-y-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
              >
                <a
                  href={`${apiBasePath}/attachments/${att.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 min-w-0 flex-1 hover:opacity-80 transition-opacity"
                >
                  <AttachmentFileIcon mimeType={att.mimeType} name={att.originalName} className="h-3.5 w-3.5 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{att.originalName}</p>
                    <p className="text-muted-foreground mt-0.5">
                      {formatBytes(att.size)} · {att.mimeType}
                    </p>
                    <p className="text-muted-foreground">
                      {formatDateTime(att.createdAt)}
                      {att.uploadedBy && (
                        <> · {att.uploadedBy.name ?? att.uploadedBy.email}</>
                      )}
                    </p>
                  </div>
                </a>
                {canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                    disabled={deletingId === att.id}
                    onClick={() => deleteAttachment(att.id)}
                  >
                    {deletingId === att.id
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <Trash2 className="h-3 w-3" />
                    }
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
