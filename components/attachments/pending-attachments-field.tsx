"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Paperclip } from "lucide-react";
import { AttachmentDropzone, StagedAttachmentList } from "@/components/attachments/attachment-dropzone";

interface PendingAttachmentsFieldProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  /** Disabled once creation has started/succeeded — the picker is only ever meaningful BEFORE submit; see the coordinating form for what replaces it afterward. */
  disabled?: boolean;
  /**
   * Server-computed only — this component never decides eligibility itself,
   * it just renders what the caller already determined via
   * hasEffectiveEntityPermission (see the two creation forms). `null` means
   * "not yet resolvable" (e.g. no department/workspace chosen), `false`
   * means "resolved, but this user cannot upload for the current
   * selection" — both hide the FILE PICKER itself; only `true` shows it.
   * They are NOT the same for messaging purposes though — see
   * unavailableMessage/neutralMessage below.
   */
  canUpload: boolean | null;
  /**
   * Shown in place of the picker when `canUpload` is `false` (resolved,
   * denied) — e.g. "You don't have permission to attach files to a Project
   * in this workspace." Never shown for `null` — a permission that hasn't
   * been evaluated yet is not a denial (see neutralMessage).
   */
  unavailableMessage?: string;
  /**
   * Shown in place of the picker when `canUpload` is `null` (not yet
   * resolvable — e.g. no workspace selected) — e.g. "Select a workspace to
   * enable project attachments." Omit to render nothing for this state
   * (the pre-existing default for every caller that doesn't need one).
   */
  neutralMessage?: string;
}

/**
 * The "pick files before the entity exists" half of Create Project/Create
 * Activity's Attachments section — shared by both forms (see
 * hooks/use-create-with-attachments.ts for the upload-after-create half).
 * Purely local state (the `files` prop) until the entity is actually
 * created; nothing here ever touches the network. File selection (drag &
 * drop + Browse, shared validation) is the shared AttachmentDropzone.
 */
export function PendingAttachmentsField({ files, onFilesChange, disabled, canUpload, unavailableMessage, neutralMessage }: PendingAttachmentsFieldProps) {
  const removeAt = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index));
  };

  if (canUpload !== true) {
    // `false` (resolved, denied) and `null` (not yet resolvable — e.g. no
    // workspace selected) are deliberately NOT the same message: `!canUpload`
    // alone would be true for both (JS: `!null === true`), which previously
    // showed the DENIAL message before a workspace was even selected — a
    // real, visible bug (see this component's own canUpload doc comment,
    // and the Project/Activity creation forms' already-correct "null, not
    // false" derivation that this was silently undermining).
    const message = canUpload === false ? unavailableMessage : canUpload === null ? neutralMessage : undefined;
    if (message) {
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Paperclip className="h-3.5 w-3.5" />
            {message}
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
          {files.length > 0 && (
            <Button type="button" size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled={disabled} onClick={() => onFilesChange([])}>
              Clear all
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <AttachmentDropzone existing={files} disabled={disabled} onFiles={(added) => onFilesChange([...files, ...added])} />
        <StagedAttachmentList files={files} onRemove={removeAt} disabled={disabled} />
        {files.length === 0 && <p className="text-xs text-muted-foreground text-center">Attachments will upload right after this is created.</p>}
      </CardContent>
    </Card>
  );
}
