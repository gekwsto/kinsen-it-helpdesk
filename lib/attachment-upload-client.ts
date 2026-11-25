/**
 * THE client-side upload call for every attachment surface (Project /
 * Activity detail panels, the create-then-upload flow, Ticket create, Ticket
 * reply). Posts ONE file as multipart `file` (plus any extra fields, e.g. a
 * Ticket reply's `messageId`) to the EXISTING `${basePath}/attachments`
 * routes — no new endpoint, no new storage path. Uses XMLHttpRequest only so
 * real upload progress can be reported (fetch has no upload progress).
 */
export type AttachmentUploadResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status: number };

export function uploadAttachmentFile<T = unknown>(
  url: string,
  file: File,
  opts: { fields?: Record<string, string>; onProgress?: (fraction: number) => void } = {}
): Promise<AttachmentUploadResult<T>> {
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append("file", file);
    for (const [k, v] of Object.entries(opts.fields ?? {})) fd.append(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "text";
    if (opts.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress!(Math.min(1, e.loaded / e.total));
      };
    }
    xhr.onload = () => {
      let body: any = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(1);
        resolve({ ok: true, data: body as T });
      } else {
        const message = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "Upload failed";
        resolve({ ok: false, error: message, status: xhr.status });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "Upload failed (network error)", status: 0 });
    xhr.onabort = () => resolve({ ok: false, error: "Upload cancelled", status: 0 });
    xhr.send(fd);
  });
}
