"use client";

import { useRef, useState } from "react";
import { Paperclip, X, Upload, FileText, Image, FileSpreadsheet, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/zip": "ZIP",
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function fileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return <Image className="h-4 w-4 text-blue-500" />;
  if (mimeType === "application/pdf") return <FileText className="h-4 w-4 text-red-500" />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel"))
    return <FileSpreadsheet className="h-4 w-4 text-green-600" />;
  if (mimeType === "application/zip") return <Archive className="h-4 w-4 text-yellow-600" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentDropzoneProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export function AttachmentDropzone({ files, onFilesChange }: AttachmentDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const newErrors: string[] = [];
    const accepted: File[] = [];

    Array.from(incoming).forEach((file) => {
      if (!ALLOWED_TYPES[file.type]) {
        newErrors.push(`${file.name}: unsupported file type`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        newErrors.push(`${file.name}: exceeds 10 MB limit`);
        return;
      }
      const isDuplicate = files.some((f) => f.name === file.name && f.size === file.size);
      if (!isDuplicate) accepted.push(file);
    });

    setErrors(newErrors);
    if (accepted.length > 0) onFilesChange([...files, ...accepted]);
  };

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      {/* Drop area */}
      <div
        className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors cursor-pointer
          ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-8 w-8 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">
            Drag &amp; drop files here, or{" "}
            <span className="text-primary underline-offset-2 hover:underline">browse</span>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            JPG, PNG, PDF, DOCX, XLSX, ZIP — max 10 MB each
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={Object.keys(ALLOWED_TYPES).join(",")}
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {/* Error messages */}
      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err) => (
            <li key={err} className="text-xs text-destructive flex items-center gap-1.5">
              <span>•</span> {err}
            </li>
          ))}
        </ul>
      )}

      {/* File list */}
      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2"
            >
              <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
              {fileIcon(file.type)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => removeFile(i)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
