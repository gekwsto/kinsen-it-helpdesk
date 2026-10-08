import { prisma } from "@/lib/prisma";
import type { Prisma, Role } from "@prisma/client";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";

/**
 * ProjectActivity.sequence — the user-controlled execution/priority ORDER
 * of Activities within a request-origin Project's vertical list (see that
 * field's own doc comment in prisma/schema.prisma). This module is the
 * SINGLE authoritative place that ever reads the "is this Project
 * request-origin" rule for sequencing purposes, or writes `sequence` —
 * every route that touches ordering (create, delete, PATCH project-move,
 * the dedicated reorder endpoint) calls into this file rather than
 * re-implementing any part of it.
 *
 * Pure ORDERING. Carries no dependency/blocking semantics — see
 * prisma/schema.prisma's ProjectActivity.sequence doc comment for why this
 * is never confused with the separate (currently unused) ActivityDependency
 * graph model.
 */

/** True only when `projectId` resolves to a real, currently request-origin Project — the ONLY gate this entire feature hinges on. Never trusts a client flag/query param/route. */
export async function isRequestOriginProject(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { projectRequestId: true } });
  return !!project?.projectRequestId;
}

/**
 * The append position for a NEW Activity (or one being moved INTO this
 * Project) — current max `sequence` + 1, or 1 if the Project has none yet.
 *
 * Race safety: the CALLER must already hold a lock on the Project row
 * within the SAME transaction (`SELECT ... FOR UPDATE`) before calling
 * this — see getAppendSequenceLocked below for the one-call convenience
 * that does both together. Calling this without that lock held is not
 * safe under concurrent creates/moves into the same Project.
 */
async function getAppendSequence(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  const result = await tx.projectActivity.aggregate({ where: { projectId }, _max: { sequence: true } });
  return (result._max.sequence ?? 0) + 1;
}

/**
 * Locks the Project row, then returns the append position — the one call
 * POST /api/activities and PATCH /api/activities/[id] (project-move) both
 * use, each wrapping it in their own short transaction alongside the
 * actual Activity write so the lock and the write that depends on it
 * commit together. Mirrors the exact `SELECT id FROM "Project" WHERE id =
 * ${id} FOR UPDATE` pattern already established by
 * createProjectFromApprovedRequest/upsertProjectFeedback for this same
 * "serialize concurrent writers against one parent row" problem.
 */
export async function getAppendSequenceLocked(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  return getAppendSequence(tx, projectId);
}

/**
 * Renumbers every Activity in `projectId` to a clean, contiguous 1..N,
 * ordered by (current sequence ASC NULLS LAST, createdAt ASC, id ASC) —
 * the deterministic fallback for any null/tied rows. Called after a
 * deletion or after an Activity moves OUT of this Project, so the
 * remaining rows never show a gap. Only writes rows whose sequence
 * actually needs to change. Caller must hold the Project row lock first
 * (see normalizeProjectSequenceLocked).
 */
async function normalizeProjectSequence(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const activities = await tx.projectActivity.findMany({
    where: { projectId },
    orderBy: [{ sequence: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, sequence: true },
  });
  for (let i = 0; i < activities.length; i++) {
    const desired = i + 1;
    if (activities[i].sequence !== desired) {
      await tx.projectActivity.update({ where: { id: activities[i].id }, data: { sequence: desired } });
    }
  }
}

/** Locks the Project row, then normalizes its sequence — the one call DELETE /api/activities/[id] and PATCH /api/activities/[id] (old project, after a move out) use. */
export async function normalizeProjectSequenceLocked(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  await normalizeProjectSequence(tx, projectId);
}

export type ReorderActivitiesError =
  | { code: "project_not_found" }
  | { code: "not_request_origin" }
  | { code: "forbidden" }
  | { code: "invalid_activity_ids" };

export type ReorderActivitiesResult = { ok: true } | { ok: false; error: ReorderActivitiesError };

/**
 * THE authoritative reorder mutation — PATCH /api/projects/[id]/activities/order
 * is a thin wrapper around this. Re-verifies every rule server-side,
 * independent of anything the client claims:
 *
 *   1. Project exists.
 *   2. Project.projectRequestId != null (request-origin only).
 *   3. The acting user holds activity.edit (the SAME canonical permission
 *      every other Activity mutation in this app already requires —
 *      reused, never a new permission) for the Project's own department.
 *   4. `orderedActivityIds` is EXACTLY a reordering of the Project's
 *      current full Activity set — no duplicates, no unknown ids, no
 *      cross-project injection, and no partial list (a partial list would
 *      leave the omitted Activities' position undefined; requiring the
 *      full set keeps the result deterministic and trivially contiguous).
 *
 * Atomic: one transaction, locking the Project row first so two concurrent
 * reorder submissions for the same Project serialize rather than
 * interleaving into a corrupt (duplicate/gapped) result — the second
 * simply re-validates against the first's already-committed state.
 */
export async function reorderProjectActivities(
  projectId: string,
  orderedActivityIds: string[],
  actor: { id: string; role: Role; customRoleId: string | null | undefined }
): Promise<ReorderActivitiesResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, departmentId: true, projectRequestId: true } });
  if (!project) return { ok: false, error: { code: "project_not_found" } };
  if (!project.projectRequestId) return { ok: false, error: { code: "not_request_origin" } };

  const canEdit = await hasEffectiveEntityPermission(actor.id, actor.role, actor.customRoleId, project.departmentId, "activity.edit");
  if (!canEdit) return { ok: false, error: { code: "forbidden" } };

  if (orderedActivityIds.length === 0) return { ok: false, error: { code: "invalid_activity_ids" } };
  if (new Set(orderedActivityIds).size !== orderedActivityIds.length) return { ok: false, error: { code: "invalid_activity_ids" } };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

      const current = await tx.projectActivity.findMany({ where: { projectId }, select: { id: true } });
      const currentIds = new Set(current.map((a) => a.id));
      const submittedIds = new Set(orderedActivityIds);

      // Exact bijection with the CURRENT full set — never a partial list,
      // never an id belonging to a different Project.
      if (currentIds.size !== submittedIds.size || !orderedActivityIds.every((activityId) => currentIds.has(activityId))) {
        throw new SequenceValidationError();
      }

      for (let i = 0; i < orderedActivityIds.length; i++) {
        await tx.projectActivity.update({ where: { id: orderedActivityIds[i] }, data: { sequence: i + 1 } });
      }
    });
  } catch (err) {
    if (err instanceof SequenceValidationError) return { ok: false, error: { code: "invalid_activity_ids" } };
    throw err;
  }

  return { ok: true };
}

class SequenceValidationError extends Error {}
