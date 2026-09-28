"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paperclip, Upload, Loader2, Trash2 } from "lucide-react";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { ATTACHMENT_MIME_TYPE_LABELS as ALLOWED_TYPES, MAX_ATTACHMENT_SIZE_BYTES as MAX_FILE_SIZE } from "@/lib/attachment-constants";

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
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = async (file: File) => {
    if (!ALLOWED_TYPES[file.type]) {
      toast.error(`${file.name}: unsupported file type`);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`${file.name}: exceeds 10 MB limit`);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiBasePath}/attachments`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(typeof err.error === "string" ? err.error : "Upload failed");
        return;
      }
      const attachment: Attachment = await res.json();
      setAttachments((prev) => [attachment, ...prev]);
      toast.success("Attachment uploaded");
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => uploadFile(file));
  };

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
          {canManage && (
            <>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={Object.keys(ALLOWED_TYPES).join(",")}
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                )}
                Upload
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
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
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
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
