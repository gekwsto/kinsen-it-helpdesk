"use client";

import { useRef, useState } from "react";

export type PendingUploadStatus = "pending" | "uploading" | "success" | "failed";

export interface PendingUploadEntry {
  file: File;
  status: PendingUploadStatus;
  error?: string;
}

export type CreatePhase = "idle" | "creating" | "uploading" | "done";

/**
 * Shared two-step "create the entity, then upload its selected attachments"
 * coordinator for Create Project / Create Activity — the entity and its
 * files are never one database transaction (the entity is a single Prisma
 * write; each attachment is its own independent upload against the
 * ALREADY-EXISTING protected route), so this owns the partial-failure state
 * machine explicitly: which files are pending/uploading/succeeded/failed,
 * and lets the caller retry ONLY the failed ones without ever re-running
 * entity creation or re-uploading a file that already succeeded.
 *
 * Deliberately entity-agnostic: `uploadBasePath` is the only thing that
 * differs between Projects and Activities (`/api/projects/<id>` vs
 * `/api/activities/<id>`); everything else — validation was already done by
 * PendingAttachmentsField before files ever reach here — is identical.
 *
 * `submittingRef` is a synchronous, non-reactive guard (a `useRef`, not
 * state) checked BEFORE any state update or async work starts — this is
 * what actually prevents a double-click from firing two overlapping create
 * requests in the same tick, before React has had a chance to re-render the
 * button as disabled. `phase`/`createdEntity` (real state) drive the UI
 * disabling for every render after the first.
 */
export function useCreateWithAttachments<TCreated extends { id: string }>(uploadBasePath: (entityId: string) => string) {
  const [files, setFiles] = useState<File[]>([]);
  const [entries, setEntries] = useState<PendingUploadEntry[]>([]);
  const [phase, setPhase] = useState<CreatePhase>("idle");
  const [createdEntity, setCreatedEntity] = useState<TCreated | null>(null);
  const submittingRef = useRef(false);

  const uploadOne = async (basePath: string, file: File): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${basePath}/attachments`, { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: typeof err.error === "string" ? err.error : "Upload failed" };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Upload failed" };
    }
  };

  /**
   * Uploads exactly the entries passed in (never re-derives "which are
   * pending" from possibly-stale state) — sequential, so a burst of large
   * files never saturates the connection, and so `entries` updates stay
   * simple to reason about. Returns the final status of just THIS batch
   * (not the full `entries` array) — React state updates are async, so a
   * caller that needs to know "did everything just uploaded succeed"
   * immediately after `await` (e.g. to decide whether to auto-navigate)
   * reads this return value, never the component's own stale `entries`
   * closure.
   */
  const runUploads = async (basePath: string, targets: PendingUploadEntry[]): Promise<PendingUploadEntry[]> => {
    setPhase("uploading");
    const finished: PendingUploadEntry[] = [];
    for (const target of targets) {
      setEntries((prev) => prev.map((e) => (e.file === target.file ? { ...e, status: "uploading" as const } : e)));
      const result = await uploadOne(basePath, target.file);
      const updated: PendingUploadEntry = result.ok
        ? { ...target, status: "success", error: undefined }
        : { ...target, status: "failed", error: result.error };
      finished.push(updated);
      setEntries((prev) => prev.map((e) => (e.file === target.file ? updated : e)));
    }
    setPhase("done");
    return finished;
  };

  /**
   * Runs `createFn` (the caller's own existing POST /api/projects or
   * /api/activities request — unchanged, including its own error/toast
   * handling) and, only once it resolves successfully, uploads every
   * currently-selected file against the real new entity id. Returns the
   * created entity so the caller can decide what to do when there were no
   * files at all (existing behavior: navigate immediately). If `createFn`
   * throws, nothing is uploaded and the selected files are left untouched
   * for the caller's existing error path to re-offer.
   */
  const submit = async (createFn: () => Promise<TCreated>): Promise<{ entity: TCreated; allUploaded: boolean }> => {
    if (submittingRef.current || createdEntity) {
      // Already submitting or already created — never fire a second create
      // request (double-click/double-submit guard).
      throw new Error("Already submitting");
    }
    submittingRef.current = true;
    setPhase("creating");
    let created: TCreated;
    try {
      created = await createFn();
    } catch (err) {
      submittingRef.current = false;
      setPhase("idle");
      throw err;
    }
    setCreatedEntity(created);
    if (files.length === 0) {
      setPhase("done");
      return { entity: created, allUploaded: true };
    }
    const toUpload: PendingUploadEntry[] = files.map((file) => ({ file, status: "pending" }));
    setEntries(toUpload);
    const finished = await runUploads(uploadBasePath(created.id), toUpload);
    return { entity: created, allUploaded: finished.every((e) => e.status === "success") };
  };

  /**
   * Retries ONLY entries currently marked "failed" — a successful upload is
   * never re-sent. Returns `allUploaded` (true once every entry — not just
   * this retried batch — is now a success) so a caller that auto-completes
   * on a fully-successful retry (inline mode's dialogs) can decide without
   * re-deriving it from `entries` state, which may not have flushed yet
   * immediately after `await` — same rationale as `submit`'s own return
   * value.
   */
  const retryFailed = async (): Promise<{ allUploaded: boolean }> => {
    if (!createdEntity) return { allUploaded: entries.every((e) => e.status === "success") };
    const failed = entries.filter((e) => e.status === "failed");
    if (failed.length === 0) return { allUploaded: true };
    const finished = await runUploads(uploadBasePath(createdEntity.id), failed);
    // Every non-retried entry was already "success" (the only other
    // terminal state) by construction — so the retried batch's own outcome
    // fully determines whether zero failures remain overall.
    return { allUploaded: finished.every((e) => e.status === "success") };
  };

  const hasFailures = entries.some((e) => e.status === "failed");
  const allDone = phase === "done" && entries.every((e) => e.status === "success");

  return {
    files,
    setFiles,
    entries,
    phase,
    createdEntity,
    submit,
    retryFailed,
    hasFailures,
    allDone,
    /** True once creation has started or succeeded — form fields should lock. */
    locked: phase !== "idle" || createdEntity !== null,
  };
}
