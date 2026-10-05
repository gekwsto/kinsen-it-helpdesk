import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import type { ProjectFeedbackInput } from "@/lib/validations";
import { createInAppNotification } from "@/lib/notifications/create-notification";

/**
 * Project Feedback — the ORIGINAL Project Request requester's one-time
 * evaluation of a delivered, request-origin Project. See
 * prisma/schema.prisma's ProjectFeedback model doc comment for the full
 * business rule; this module is the SINGLE authoritative place that rule is
 * enforced (POST /api/projects/[id]/feedback, and the Project detail
 * page's own render-time eligibility check, both call into this file —
 * neither re-implements any part of the rule itself).
 */

export type ProjectFeedbackRecord = {
  id: string;
  satisfactionScore: number;
  comments: string | null;
  createdAt: Date;
};

export type ProjectFeedbackEligibility = {
  // Project.projectRequestId != null — a manual Project is never a
  // feedback target at all, regardless of who's asking or what status
  // it's in.
  isRequestOriginTarget: boolean;
  // The authenticated user IS the ProjectRequest.requesterId that this
  // Project originated from — resolved from the DB relation, never from
  // any client-supplied flag, Project owner, final approver, or
  // membership.
  isOriginalRequester: boolean;
  // Project.status === ProjectStatus.COMPLETED — the canonical, existing
  // Project completion state (see prisma/schema.prisma's ProjectStatus
  // enum). Deliberately NOT Activity completion, and NOT the
  // per-department "isTerminal" overdue-calculation config (lib/status-
  // terminal.ts) — that flag governs a different concern (whether a
  // status counts toward overdue) and can be true for CANCELLED too,
  // which is never genuine completion.
  isProjectCompleted: boolean;
  // Null until submitted. Present regardless of isProjectCompleted —
  // reopening a Project after feedback was submitted must never hide or
  // delete that historical record (see this module's doc comment).
  feedback: ProjectFeedbackRecord | null;
};

/**
 * Read-only eligibility + existing-feedback lookup, shared by the Project
 * detail page's server-side render (Case A/B/C/D in the feature's own
 * spec) and the POST route's own authorization below — the SAME four
 * facts, computed exactly once per call, from the DB, every time.
 */
export async function getProjectFeedbackEligibility(
  projectId: string,
  userId: string
): Promise<ProjectFeedbackEligibility> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      projectRequestId: true,
      feedback: { select: { id: true, satisfactionScore: true, comments: true, createdAt: true } },
    },
  });

  if (!project || !project.projectRequestId) {
    return { isRequestOriginTarget: false, isOriginalRequester: false, isProjectCompleted: false, feedback: null };
  }

  const request = await prisma.projectRequest.findUnique({
    where: { id: project.projectRequestId },
    select: { requesterId: true },
  });
  // Fail closed: a Project claiming request-origin provenance whose linked
  // ProjectRequest row no longer exists is never treated as eligible —
  // this should be unreachable in practice (projectRequestId is a real FK,
  // never cascade-deleted away from under a Project), but the rule itself
  // never assumes that.
  if (!request) {
    return { isRequestOriginTarget: false, isOriginalRequester: false, isProjectCompleted: false, feedback: null };
  }

  return {
    isRequestOriginTarget: true,
    isOriginalRequester: request.requesterId === userId,
    isProjectCompleted: project.status === ProjectStatus.COMPLETED,
    feedback: project.feedback,
  };
}

export type SubmitProjectFeedbackError =
  | { code: "not_found" }
  | { code: "not_request_origin" }
  | { code: "forbidden" }
  | { code: "not_completed" };

export type SubmitProjectFeedbackResult =
  | { ok: true; feedback: ProjectFeedbackRecord; alreadyExisted: boolean }
  | { ok: false; error: SubmitProjectFeedbackError };

/**
 * The ONLY path that ever creates a ProjectFeedback row. Re-verifies every
 * eligibility fact server-side (never trusts a query param, client flag,
 * hidden input, Project owner, final approver, or Project membership) and
 * never accepts submittedByUserId from the caller — it is always `userId`,
 * the authenticated session's own id, passed in by the route handler AFTER
 * `requireAuth()`.
 *
 * Race safety: a `SELECT ... FOR UPDATE` on the Project row inside a
 * transaction, the SAME pattern createProjectFromApprovedRequest already
 * uses for its own "at most one child row" guarantee — two concurrent
 * submissions for the same Project serialize through this one critical
 * section, so the second one always observes the first's already-created
 * row and returns it (alreadyExisted: true) instead of racing the DB's own
 * @unique(projectId) constraint. That constraint remains the ultimate
 * structural backstop regardless.
 */
export async function submitProjectFeedback(
  projectId: string,
  userId: string,
  data: ProjectFeedbackInput
): Promise<SubmitProjectFeedbackResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, projectRequestId: true },
  });
  if (!project) return { ok: false, error: { code: "not_found" } };
  if (!project.projectRequestId) return { ok: false, error: { code: "not_request_origin" } };

  const request = await prisma.projectRequest.findUnique({
    where: { id: project.projectRequestId },
    select: { id: true, requesterId: true },
  });
  if (!request) return { ok: false, error: { code: "not_request_origin" } };
  if (request.requesterId !== userId) return { ok: false, error: { code: "forbidden" } };
  if (project.status !== ProjectStatus.COMPLETED) return { ok: false, error: { code: "not_completed" } };

  let result: { id: string; satisfactionScore: number; comments: string | null; createdAt: Date } | null = null;
  let alreadyExisted = false;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

    const existing = await tx.projectFeedback.findUnique({
      where: { projectId },
      select: { id: true, satisfactionScore: true, comments: true, createdAt: true },
    });
    if (existing) {
      result = existing;
      alreadyExisted = true;
      return;
    }

    result = await tx.projectFeedback.create({
      data: {
        projectId,
        projectRequestId: request.id,
        submittedByUserId: userId,
        satisfactionScore: data.satisfactionScore,
        comments: data.comments ?? null,
      },
      select: { id: true, satisfactionScore: true, comments: true, createdAt: true },
    });
  });

  return { ok: true, feedback: result!, alreadyExisted };
}

/**
 * Best-effort notification to the original Project Request requester the
 * moment their request-origin Project becomes COMPLETED — the one prompt
 * this feature surfaces so the requester actually discovers the new
 * Feedback card, rather than needing to stumble onto the Project page on
 * their own. Clicking it (via its `link`) lands directly on the Project
 * detail page, where the Feedback card is now showing.
 *
 * Deliberately NOT a generic "Project status changed" notification — only
 * fired for the specific COMPLETED transition, and only when
 * projectRequestId is set (a manual Project never notifies anyone this
 * way). Call this ONLY once the Project.update that caused the transition
 * has actually committed (see PATCH /api/projects/[id]'s own call site) —
 * never speculatively. createInAppNotification already swallows its own
 * failures (logged, never thrown), so this never risks the caller's
 * already-successful response.
 */
export async function notifyRequesterOfProjectCompletion(project: { id: string; title: string; projectRequestId: string | null }): Promise<void> {
  if (!project.projectRequestId) return;
  const request = await prisma.projectRequest.findUnique({ where: { id: project.projectRequestId }, select: { requesterId: true } });
  if (!request) return;
  await createInAppNotification({
    userId: request.requesterId,
    title: "Project completed",
    body: `Your Project "${project.title}" has been completed. You can now share your feedback.`,
    link: `/projects/${project.id}`,
  });
}
