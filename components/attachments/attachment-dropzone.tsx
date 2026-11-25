"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Upload, X, FileText, Image as ImageIcon, FileSpreadsheet, Archive, Mail, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatBytes } from "@/lib/utils";
import { ATTACHMENT_ACCEPT_ATTRIBUTE, ATTACHMENT_ALLOWED_LABELS, attachmentIconKind, classifyAttachmentFile } from "@/lib/attachment-constants";

/**
 * THE shared attachment picker for every upload surface (Ticket create /
 * reply, Project + Activity create, Project + Activity detail panels):
 * drag & drop of one or many files, a Browse button, per-file validation
 * with the shared policy (lib/attachment-constants.ts — the server enforces
 * the same rule plus email-content checks), drag-over highlighting, keyboard
 * access and duplicate-event protection. It only SELECTS files — the caller
 * decides whether they are staged (record not created yet) or uploaded
 * immediately (lib/attachment-upload-client.ts), so the existing staged-
 * upload behavior is unchanged.
 *
 * Outlook: when a mail client exposes the dragged message as a real file
 * (dataTransfer.files / items of kind "file"), it is accepted like any other
 * .msg/.eml. When it does not (no file data at all), a clear fallback message
 * explains how to save the message as .msg/.eml first.
 */

const DROPZONE_ATTR = "data-attachment-dropzone";

// One shared window-level guard while ANY dropzone is mounted: a file dropped
// near (but not on) a dropzone must never make the browser navigate away to
// the file and lose the form. Drops on a real dropzone are handled there.
let windowGuardCount = 0;
function isFileDrag(e: DragEvent) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}
function windowGuard(e: DragEvent) {
  if (!isFileDrag(e)) return;
  const target = e.target as Element | null;
  if (target?.closest?.(`[${DROPZONE_ATTR}]`)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
}
function useWindowDropGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (windowGuardCount++ === 0) {
      window.addEventListener("dragover", windowGuard);
      window.addEventListener("drop", windowGuard);
    }
    return () => {
      if (--windowGuardCount === 0) {
        window.removeEventListener("dragover", windowGuard);
        window.removeEventListener("drop", windowGuard);
      }
    };
  }, [active]);
}

export const fileSignature = (f: File) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`;

export const OUTLOOK_FALLBACK_MESSAGE =
  "No file was received. If you dragged an email from Outlook, your mail client didn't provide it as a file — save the message as .msg or .eml first (drag it to your desktop or use File › Save As), then drop or browse the saved file.";

export function AttachmentFileIcon({ mimeType, name, className }: { mimeType?: string | null; name?: string; className?: string }) {
  const kind = attachmentIconKind(mimeType, name);
  const cls = cn("h-4 w-4 shrink-0", className);
  if (kind === "email") return <Mail className={cn(cls, "text-sky-600")} aria-label="Email message" />;
  if (kind === "image") return <ImageIcon className={cn(cls, "text-blue-500")} aria-hidden />;
  if (kind === "pdf") return <FileText className={cn(cls, "text-red-500")} aria-hidden />;
  if (kind === "sheet") return <FileSpreadsheet className={cn(cls, "text-green-600")} aria-hidden />;
  if (kind === "archive") return <Archive className={cn(cls, "text-yellow-600")} aria-hidden />;
  return <FileText className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

interface AttachmentDropzoneProps {
  /** Receives only files that pass the shared policy (and aren't duplicates of `existing`). */
  onFiles: (files: File[]) => void;
  /** Already-selected files — re-adding the same file (name+size+lastModified) is ignored. */
  existing?: File[];
  disabled?: boolean;
  /** Shows a spinner in the zone (e.g. uploads in flight) — still accepts more files unless `disabled`. */
  busy?: boolean;
  variant?: "default" | "compact";
  className?: string;
}

export function AttachmentDropzone({ onFiles, existing = [], disabled = false, busy = false, variant = "default", className }: AttachmentDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const lastBatch = useRef<{ sig: string; at: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const helpId = useId();
  const errorId = useId();
  useWindowDropGuard(!disabled);

  const accept = (incoming: File[], { fromDrop }: { fromDrop: boolean }) => {
    if (disabled) return;
    // Repeated events (double drop events, a re-fired change event) carrying the
    // exact same batch within a moment are ignored — never submitted twice.
    const sig = incoming.map(fileSignature).sort().join("|");
    const now = Date.now();
    if (lastBatch.current && lastBatch.current.sig === sig && now - lastBatch.current.at < 1500) return;
    lastBatch.current = { sig, at: now };

    if (incoming.length === 0) {
      setErrors(fromDrop ? [OUTLOOK_FALLBACK_MESSAGE] : []);
      return;
    }
    const known = new Set(existing.map(fileSignature));
    const nextErrors: string[] = [];
    const accepted: File[] = [];
    for (const file of incoming) {
      const sigOne = fileSignature(file);
      if (known.has(sigOne)) continue; // already selected
      known.add(sigOne); // same file twice in one batch
      const result = classifyAttachmentFile(file);
      if (!result.ok) {
        nextErrors.push(`${file.name}: ${result.code === "too_large" ? "exceeds the 10 MB limit" : "this file type isn't allowed"}`);
        continue;
      }
      accepted.push(file);
    }
    setErrors(nextErrors);
    if (accepted.length > 0) onFiles(accepted);
  };

  const filesFromDataTransfer = (dt: DataTransfer): File[] => {
    const direct = Array.from(dt.files ?? []);
    if (direct.length > 0) return direct;
    // Some sources expose files only through items.
    return Array.from(dt.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => !!f);
  };

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  const compact = variant === "compact";

  return (
    <div className={cn("space-y-2", className)}>
      <div
        {...{ [DROPZONE_ATTR]: "" }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-describedby={`${helpId}${errors.length ? ` ${errorId}` : ""}`}
        aria-label="Attach files: drop files here or press Enter to browse"
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (disabled) return;
          dragDepth.current++;
          setIsDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = disabled ? "none" : "copy";
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault(); // never let the browser navigate to the dropped file
          e.stopPropagation();
          dragDepth.current = 0;
          setIsDragging(false);
          accept(filesFromDataTransfer(e.dataTransfer), { fromDrop: true });
        }}
        className={cn(
          "relative flex rounded-lg border-2 border-dashed text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          compact ? "flex-row items-center justify-center gap-2 px-3 py-3" : "flex-col items-center justify-center gap-2 px-4 py-6 sm:px-6 sm:py-8",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"
        )}
      >
        {busy ? (
          <Loader2 className={cn("animate-spin text-muted-foreground", compact ? "h-4 w-4" : "h-7 w-7")} aria-hidden />
        ) : (
          <Upload className={cn(isDragging ? "text-primary" : "text-muted-foreground/60", compact ? "h-4 w-4" : "h-7 w-7")} aria-hidden />
        )}
        <div className={compact ? "text-left" : undefined}>
          <p className="text-sm font-medium">
            {isDragging ? "Drop files to attach" : (
              <>
                Drag &amp; drop files here, or{" "}
                <span className="text-primary underline-offset-2 hover:underline">browse</span>
              </>
            )}
          </p>
          <p id={helpId} className="text-xs text-muted-foreground mt-0.5">
            {ATTACHMENT_ALLOWED_LABELS.join(", ")} — max 10 MB each
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_ATTRIBUTE}
          className="hidden"
          disabled={disabled}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            accept(Array.from(e.target.files ?? []), { fromDrop: false });
            e.target.value = "";
          }}
          data-testid="attachment-file-input"
        />
      </div>

      <div id={errorId} aria-live="polite">
        {errors.length > 0 && (
          <ul className="space-y-1">
            {errors.map((err) => (
              <li key={err} className="text-xs text-destructive">
                {err}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Files selected but not uploaded yet (record not created / reply not sent). */
export function StagedAttachmentList({ files, onRemove, disabled }: { files: File[]; onRemove: (index: number) => void; disabled?: boolean }) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-2">
      {files.map((file, index) => (
        <li key={`${fileSignature(file)}-${index}`} className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <AttachmentFileIcon mimeType={file.type} name={file.name} />
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
            onClick={() => onRemove(index)}
            aria-label={`Remove ${file.name}`}
          >
            <X className="h-3 w-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export type AttachmentUploadStatus = "pending" | "uploading" | "success" | "failed";

/** One file's upload state — shared by the detail panels and the post-create upload panel. */
export function AttachmentUploadRow({ file, status, progress, error }: { file: File; status: AttachmentUploadStatus; progress?: number; error?: string }) {
  const pct = Math.round((progress ?? 0) * 100);
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs" data-upload-status={status}>
      <div className="flex items-center gap-2">
        {status === "uploading" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
        {status === "success" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600" aria-label="Uploaded" />}
        {status === "failed" && <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Failed" />}
        {status === "pending" && <AttachmentFileIcon mimeType={file.type} name={file.name} className="h-3.5 w-3.5" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{file.name}</p>
          <p className="text-muted-foreground mt-0.5">
            {formatBytes(file.size)}
            {status === "uploading" && <> · {pct}%</>}
            {status === "pending" && <> · Waiting…</>}
            {status === "failed" && error && <span className="text-destructive"> · {error}</span>}
          </p>
        </div>
      </div>
      {status === "uploading" && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Uploading ${file.name}`}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
