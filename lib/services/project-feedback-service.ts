import { prisma } from "@/lib/prisma";
import { ProjectStatus } from "@prisma/client";
import type { ProjectFeedbackInput } from "@/lib/validations";
import { createInAppNotification } from "@/lib/notifications/create-notification";
import { microsoftGraph } from "@/lib/microsoft-graph";

/**
 * Project Feedback — the Project's own PRIMARY Owner (`Project.ownerId`)
 * evaluation of a delivered, request-origin Project, across five
 * independent 1-5 ratings plus a separate requirementsDelivered boolean.
 * See prisma/schema.prisma's ProjectFeedback model doc comment for the
 * full business rule (including the legacySatisfactionScore migration/
 * preservation story); this module is the SINGLE authoritative place the
 * rule is enforced (POST /api/projects/[id]/feedback, and the dedicated
 * /projects/[id]/feedback page's own render-time eligibility check, both
 * call into this file — neither re-implements any part of the rule
 * itself).
 *
 * Eligibility was ORIGINALLY the Project Request's own requesterId —
 * REPLACED by this feature with Project.ownerId (the single canonical
 * primary Owner, never the full `owners` multi-owner set, never Audience/
 * Members, never an implicit ADMIN bypass). A pre-existing row submitted
 * under the old requester rule keeps its real, original
 * `submittedByUserId` forever — upsertProjectFeedback's own UPDATE path
 * below never rewrites that field, preserving truthful historical
 * provenance even though the CURRENTLY authorized submitter is now a
 * different identity (the owner).
 *
 * Editable, not immutable: the Owner may UPDATE their own existing row
 * (upsertProjectFeedback below) rather than ever creating a second one —
 * @unique(projectId) remains the structural backstop. Both create AND
 * update require the Project to be CURRENTLY COMPLETED (the same
 * canonical ProjectStatus.COMPLETED check as before) — if the Project is
 * later reopened, an already-submitted row remains fully visible
 * (historical record), but can no longer be edited until it is COMPLETED
 * again.
 */

export type ProjectFeedbackRecord = {
  id: string;
  deliverySpeedRating: number;
  communicationRating: number;
  functionalityRating: number;
  easeOfUseRating: number;
  overallRating: number;
  requirementsDelivered: boolean;
  comments: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const FEEDBACK_SELECT = {
  id: true,
  deliverySpeedRating: true,
  communicationRating: true,
  functionalityRating: true,
  easeOfUseRating: true,
  overallRating: true,
  requirementsDelivered: true,
  comments: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * A row from BEFORE this feature's five-rating replacement — every rating
 * field above (and requirementsDelivered) is null on such a row, since no
 * truthful per-dimension breakdown can be derived from the old single
 * legacySatisfactionScore. Never returned by getProjectFeedbackEligibility
 * (which only ever surfaces rows with real ratings); exists purely so a
 * legacy row is never miscast into ProjectFeedbackRecord's all-required
 * shape. See the Administration -> Feedback review page for where this
 * actually gets displayed.
 */
function isCompleteFiveRatingRecord(row: {
  deliverySpeedRating: number | null;
  communicationRating: number | null;
  functionalityRating: number | null;
  easeOfUseRating: number | null;
  overallRating: number | null;
  requirementsDelivered: boolean | null;
}): boolean {
  return (
    row.deliverySpeedRating !== null &&
    row.communicationRating !== null &&
    row.functionalityRating !== null &&
    row.easeOfUseRating !== null &&
    row.overallRating !== null &&
    row.requirementsDelivered !== null
  );
}

export type ProjectFeedbackEligibility = {
  // Project.projectRequestId != null — a manual Project is never a
  // feedback target at all, regardless of who's asking or what status
  // it's in. Unchanged by this feature's eligibility-identity swap.
  isRequestOriginTarget: boolean;
  // The authenticated user IS Project.ownerId — the single canonical
  // primary Owner, resolved directly from the Project row, never from the
  // full `owners` multi-owner set, Audience, Members, the original
  // Project Request requester (unless that same person happens to also be
  // ownerId), or an implicit ADMIN-role bypass.
  isPrimaryOwner: boolean;
  // Project.status === ProjectStatus.COMPLETED — the canonical, existing
  // Project completion state (see prisma/schema.prisma's ProjectStatus
  // enum). Deliberately NOT Activity completion, and NOT the
  // per-department "isTerminal" overdue-calculation config (lib/status-
  // terminal.ts) — that flag governs a different concern (whether a
  // status counts toward overdue) and can be true for CANCELLED too,
  // which is never genuine completion. Also gates whether an existing row
  // may be EDITED, not only whether a first submission may be created.
  isProjectCompleted: boolean;
  // Null until submitted, OR if only a legacy (pre-five-rating) row
  // exists for this Project — see isCompleteFiveRatingRecord above.
  // Present regardless of isProjectCompleted — reopening a Project after
  // feedback was submitted must never hide that historical record (see
  // this module's doc comment); it only blocks further edits.
  feedback: ProjectFeedbackRecord | null;
};

/**
 * Read-only eligibility + existing-feedback lookup, shared by the
 * dedicated /projects/[id]/feedback page's server-side render and the
 * POST route's own authorization below — the SAME facts, computed exactly
 * once per call, directly from the Project row (no extra ProjectRequest
 * lookup needed any more — ownerId lives on Project itself).
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
      ownerId: true,
      feedback: { select: FEEDBACK_SELECT },
    },
  });

  if (!project || !project.projectRequestId) {
    return { isRequestOriginTarget: false, isPrimaryOwner: false, isProjectCompleted: false, feedback: null };
  }

  return {
    isRequestOriginTarget: true,
    isPrimaryOwner: project.ownerId === userId,
    isProjectCompleted: project.status === ProjectStatus.COMPLETED,
    feedback: project.feedback && isCompleteFiveRatingRecord(project.feedback) ? (project.feedback as ProjectFeedbackRecord) : null,
  };
}

export type SubmitProjectFeedbackError =
  | { code: "not_found" }
  | { code: "not_request_origin" }
  | { code: "forbidden" }
  | { code: "not_completed" };

export type SubmitProjectFeedbackResult =
  | { ok: true; feedback: ProjectFeedbackRecord; created: boolean }
  | { ok: false; error: SubmitProjectFeedbackError };

/**
 * The ONLY path that ever creates OR updates a ProjectFeedback row. Re-
 * verifies every eligibility fact server-side (never trusts a query param,
 * client flag, hidden input, the full `owners` set, Audience, Members, or
 * an ADMIN role) and never accepts submittedByUserId from the caller — it
 * is always `userId`, the authenticated session's own id, passed in by the
 * route handler AFTER `requireAuth()`.
 *
 * Legacy provenance: on an UPDATE of a pre-existing row (submitted under
 * the OLD requester-based rule, by a different person than the current
 * Owner), `submittedByUserId` is deliberately NEVER included in the write
 * — see `writeData` below. The row's original submitter stays exactly who
 * really submitted it; only the ratings/requirementsDelivered/comments
 * change. Never fabricated to the new Owner's identity.
 *
 * Race safety: a `SELECT ... FOR UPDATE` on the Project row inside a
 * transaction, the SAME pattern createProjectFromApprovedRequest already
 * uses for its own "at most one child row" guarantee — two concurrent
 * submissions for the same Project serialize through this one critical
 * section. The second one genuinely UPDATES the first's row with its own
 * answers (last write wins) — the real upsert behavior this feature wants.
 */
export async function upsertProjectFeedback(
  projectId: string,
  userId: string,
  data: ProjectFeedbackInput
): Promise<SubmitProjectFeedbackResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, projectRequestId: true, ownerId: true },
  });
  if (!project) return { ok: false, error: { code: "not_found" } };
  if (!project.projectRequestId) return { ok: false, error: { code: "not_request_origin" } };
  const projectRequestId = project.projectRequestId;
  // Project.ownerId — the single canonical primary Owner — is the ONLY
  // identity ever allowed through, re-derived from the DB on every call.
  // Never the full `owners` set, never Audience/Members, and ADMIN holds
  // no implicit bypass here (unlike most of this app's other permission
  // checks) — this is a deliberate, identity-based exception, the same
  // kind the old requester-only rule already was.
  if (project.ownerId !== userId) return { ok: false, error: { code: "forbidden" } };
  // Gates BOTH create and update — a Project reopened after feedback was
  // already submitted keeps that row fully visible (see
  // getProjectFeedbackEligibility above) but may not be edited again until
  // it is COMPLETED once more.
  if (project.status !== ProjectStatus.COMPLETED) return { ok: false, error: { code: "not_completed" } };

  const writeData = {
    deliverySpeedRating: data.deliverySpeedRating,
    communicationRating: data.communicationRating,
    functionalityRating: data.functionalityRating,
    easeOfUseRating: data.easeOfUseRating,
    overallRating: data.overallRating,
    requirementsDelivered: data.requirementsDelivered,
    comments: data.comments ?? null,
  };

  let result: ProjectFeedbackRecord | null = null;
  let created = false;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;

    const existing = await tx.projectFeedback.findUnique({ where: { projectId }, select: { id: true } });
    if (existing) {
      // writeData's ratings/requirementsDelivered are all real, Zod-
      // validated non-null values (ProjectFeedbackInput) — the column
      // type is only nullable to accommodate pre-existing LEGACY rows
      // (see FEEDBACK_SELECT's own doc comment), never a row this
      // function itself just wrote. submittedByUserId is deliberately
      // ABSENT from writeData — see this function's own doc comment on
      // legacy provenance preservation.
      result = (await tx.projectFeedback.update({ where: { projectId }, data: writeData, select: FEEDBACK_SELECT })) as ProjectFeedbackRecord;
      created = false;
      return;
    }

    result = (await tx.projectFeedback.create({
      data: { projectId, projectRequestId, submittedByUserId: userId, ...writeData },
      select: FEEDBACK_SELECT,
    })) as ProjectFeedbackRecord;
    created = true;
  });

  return { ok: true, feedback: result!, created };
}

// ─── Completion notification + email ────────────────────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

/**
 * The completion-triggered email's HTML body — same established visual
 * style as lib/email-ticket-parser.ts's own templates (header bar, white
 * content card, blue CTA button, footer), Greek copy per this feature's
 * own spec.
 */
function buildProjectFeedbackCompletionEmailHtml(params: { projectTitle: string; feedbackUrl: string }): string {
  const { projectTitle, feedbackUrl } = params;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1e3a5f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">Kinsen IT Support</h1>
  </div>
  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>Το έργο <strong>&quot;${projectTitle}&quot;</strong> ολοκληρώθηκε.</p>
    <p>Παρακαλούμε αφιερώστε λίγο χρόνο για να συμπληρώσετε την αξιολόγησή σας.</p>
    <p>
      <a href="${feedbackUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">
        Αξιολόγηση Έργου
      </a>
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Kinsen IT Support | kinsenitsupport@kinsen.gr
    </p>
  </div>
</body>
</html>`;
}

/**
 * Best-effort in-app notification + email to the Project's PRIMARY Owner
 * the moment their request-origin Project becomes COMPLETED — the prompt
 * this feature surfaces so the Owner actually discovers the dedicated
 * feedback page, rather than needing to stumble onto it on their own.
 * Clicking either lands directly on /projects/[id]/feedback (NOT the
 * Project detail page — the full evaluation form no longer lives there).
 *
 * Deliberately NOT a generic "Project status changed" notification — only
 * fired for the specific COMPLETED transition, and only when
 * projectRequestId is set (a manual Project never notifies anyone this
 * way, consistent with feedback eligibility itself being request-origin-
 * only — see getProjectFeedbackEligibility). Call this ONLY once the
 * Project.update that caused the transition has actually committed (see
 * PATCH /api/projects/[id]'s own call site, which already guards this
 * exact genuine non-COMPLETED -> COMPLETED transition and calls this
 * function at most once per real transition) — never speculatively.
 *
 * Idempotency: entirely inherited from the call site's own transition
 * guard (`existing.status !== COMPLETED && project.status === COMPLETED`)
 * — no separate ledger/outbox is introduced here. A repeated PATCH while
 * already COMPLETED, or an unrelated edit, never re-enters this function
 * at all. A genuine reopen -> re-complete cycle DOES call it again — a
 * fresh, real transition deserves a fresh prompt, the same policy the
 * pre-existing (now-replaced) requester notification already had.
 *
 * Reliability: createInAppNotification already swallows its own failures
 * (logged, never thrown). The email send below is wrapped in its own
 * try/catch for the identical reason — a Microsoft Graph outage must
 * never turn an already-successful Project completion into an error
 * response, and must never roll back the completion itself.
 */
export async function notifyOwnerOfProjectCompletion(project: {
  id: string;
  title: string;
  projectRequestId: string | null;
  owner: { id: string; name: string | null; email: string };
}): Promise<void> {
  if (!project.projectRequestId) return;

  const feedbackUrl = `/projects/${project.id}/feedback`;
  await createInAppNotification({
    userId: project.owner.id,
    title: "Το έργο ολοκληρώθηκε",
    body: `Το έργο "${project.title}" ολοκληρώθηκε. Παρακαλούμε υποβάλετε την αξιολόγησή σας.`,
    link: feedbackUrl,
  });

  try {
    await microsoftGraph.sendMail({
      message: {
        subject: `Αξιολόγηση ολοκληρωμένου έργου: ${project.title}`,
        body: {
          contentType: "HTML",
          content: buildProjectFeedbackCompletionEmailHtml({ projectTitle: project.title, feedbackUrl: `${APP_URL}${feedbackUrl}` }),
        },
        toRecipients: [{ emailAddress: { address: project.owner.email, name: project.owner.name ?? undefined } }],
      },
    });
  } catch (err) {
    console.error("[project-feedback] Failed to send completion email to Project Owner:", err);
  }
}
