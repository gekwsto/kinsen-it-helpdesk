"use client";

import { useRef } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paperclip, Upload, X } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { ATTACHMENT_MIME_TYPE_LABELS, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType } from "@/lib/attachment-constants";

interface PendingAttachmentsFieldProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** Disabled once creation has started/succeeded — the picker is only ever meaningful BEFORE submit; see the coordinating form for what replaces it afterward. */
  disabled?: boolean;
  /**
   * Server-computed only — this component never decides eligibility itself,
   * it just renders what the caller already determined via
   * hasEffectiveEntityPermission (see the two creation forms). `null` means
   * "not yet resolvable" (e.g. no department chosen), `false` means
   * "resolved, but this user cannot upload for the current selection" —
   * both hide the picker; only `true` shows it.
   */
  canUpload: boolean | null;
  /** Shown in place of the picker when `canUpload` is false — e.g. "You don't have permission to attach files to a Project in this workspace." */
  unavailableMessage?: string;
}

/**
 * The "pick files before the entity exists" half of Create Project/Create
 * Activity's Attachments section — shared by both forms (see
 * hooks/use-create-with-attachments.ts for the upload-after-create half).
 * Purely local state (the `files` prop) until the entity is actually
 * created; nothing here ever touches the network. Same file-policy
 * constants, same validation messages, and the same visual language
 * (Paperclip/Upload icons, Card layout) as the detail-page
 * EntityAttachments panel this was modeled on.
 */
export function PendingAttachmentsField({ files, onFilesChange, disabled, canUpload, unavailableMessage }: PendingAttachmentsFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const accepted: File[] = [];
    for (const file of Array.from(list)) {
      if (!isAllowedAttachmentMimeType(file.type)) {
        toast.error(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        toast.error(`${file.name}: exceeds 10 MB limit`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) onFilesChange([...files, ...accepted]);
  };

  const removeAt = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index));
  };

  if (canUpload !== true) {
    if (!canUpload && unavailableMessage) {
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Paperclip className="h-3.5 w-3.5" />
            {unavailableMessage}
          </p>
        </div>
      );
    }
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Paperclip className="h-4 w-4" />
            Attachments {files.length > 0 && `(${files.length})`}
          </CardTitle>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={Object.keys(ATTACHMENT_MIME_TYPE_LABELS).join(",")}
              className="hidden"
              disabled={disabled}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {files.length > 0 && (
              <Button type="button" size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={disabled} onClick={() => onFilesChange([])}>
                Clear all
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={disabled} onClick={() => inputRef.current?.click()}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Select files
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No files selected. Attachments will upload right after this is created.
          </p>
        ) : (
          <div className="space-y-2">
            {files.map((file, index) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                <Paperclip className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{file.name}</p>
                  <p className="text-muted-foreground mt-0.5">{formatBytes(file.size)}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  disabled={disabled}
                  onClick={() => removeAt(index)}
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-3">
          Up to 10 MB each. Allowed: {Object.values(ATTACHMENT_MIME_TYPE_LABELS).join(", ")}.
        </p>
      </CardContent>
    </Card>
  );
}
