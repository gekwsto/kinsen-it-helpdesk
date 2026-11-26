import { prisma } from "@/lib/prisma";
import { ProjectStatus, type Prisma } from "@prisma/client";
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
 * RECIPIENTS (resolveProjectFeedbackRecipientIds below): the Project's
 * Responsible People when it has any (exclusively — an Owner is never a
 * recipient merely for being an Owner then), otherwise the existing
 * primary Owner (Project.ownerId). Deduplicated. Each recipient has their
 * OWN Feedback row (@@unique([projectId, submittedByUserId])); rows
 * submitted before this rule stay exactly as they were.
 *
 * PERSISTED OBLIGATIONS (ProjectFeedbackRequest): when a request-origin
 * Project transitions to COMPLETED, recordProjectFeedbackObligationsInTransaction
 * persists one obligation per then-eligible ACTIVE recipient (active
 * Responsible People; the Owner only when NO Responsible People are
 * configured — never as a fallback for all-inactive Responsible People),
 * atomically with the transition, and stamps Project.feedbackRequestedAt
 * (the tracking marker) even when nobody was eligible. Only NEWLY created
 * obligations are notified. Re-completion only adds newly eligible
 * recipients. Later Responsible People / Owner changes never rewrite them.
 *
 * AUTHORIZATION (isFeedbackRecipient below):
 *  - TRACKED Project (feedbackRequestedAt set): exactly the users holding
 *    an obligation, while active — independent of their CURRENT Project
 *    relationship (a requested user later removed from Responsible People
 *    keeps the right to submit their own Feedback). This grants access to
 *    the Feedback page/API ONLY, never to the Project itself or its
 *    Workspace (those keep their own, unchanged checks).
 *  - UNTRACKED (historical) Project: the live recipient rule above,
 *    unchanged — historical access is preserved, but no obligation is
 *    created and the Project counts as "Not tracked" in Administration.
 *
 * Editable, not immutable: a recipient may UPDATE their own existing row
 * (upsertProjectFeedback below) rather than ever creating a second one —
 * @@unique([projectId, submittedByUserId]) is the structural backstop. Both create AND
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

/**
 * THE canonical Feedback recipient resolution: the Project's Responsible
 * People when it has any (exclusively), otherwise its primary Owner
 * (Project.ownerId — the pre-existing behaviour). Deduplicated, stable order.
 */
export function resolveProjectFeedbackRecipientIds(project: { ownerId: string; responsiblePeople: { id: string }[] }): string[] {
  if (project.responsiblePeople.length > 0) return Array.from(new Set(project.responsiblePeople.map((p) => p.id)));
  return [project.ownerId];
}

// Only the given user's obligation row is ever needed for authorization.
function recipientSelect(userId: string) {
  return {
    ownerId: true,
    feedbackRequestedAt: true,
    responsiblePeople: { select: { id: true } },
    feedbackRequests: { where: { userId }, select: { user: { select: { isActive: true } } } },
  } as const;
}

/** See this module's AUTHORIZATION doc. `feedbackRequests` must be pre-filtered to `userId` (recipientSelect). */
function isFeedbackRecipient(
  project: { feedbackRequestedAt: Date | null; ownerId: string; responsiblePeople: { id: string }[]; feedbackRequests: { user: { isActive: boolean } }[] },
  userId: string
): boolean {
  if (project.feedbackRequestedAt) return project.feedbackRequests.some((r) => r.user.isActive);
  return resolveProjectFeedbackRecipientIds(project).includes(userId);
}

export type ProjectFeedbackEligibility = {
  // Project.projectRequestId != null — a manual Project is never a
  // feedback target at all, regardless of who's asking or what status
  // it's in. Unchanged by this feature's eligibility-identity swap.
  isRequestOriginTarget: boolean;
  // The authenticated user may submit/view their own Feedback
  // (isFeedbackRecipient: a persisted obligation on tracked Projects, the
  // live recipient rule on historical untracked ones) — never Audience/
  // Members/other Owners as such, never an implicit ADMIN bypass.
  isRecipient: boolean;
  // Project.status === ProjectStatus.COMPLETED — the canonical, existing
  // Project completion state (see prisma/schema.prisma's ProjectStatus
  // enum). Deliberately NOT Activity completion, and NOT the
  // per-department "isTerminal" overdue-calculation config (lib/status-
  // terminal.ts) — that flag governs a different concern (whether a
  // status counts toward overdue) and can be true for CANCELLED too,
  // which is never genuine completion. Also gates whether an existing row
  // may be EDITED, not only whether a first submission may be created.
  isProjectCompleted: boolean;
  // The authenticated user's OWN Feedback row for this Project. Null until
  // they submit, OR if only a legacy (pre-five-rating) row exists — see
  // isCompleteFiveRatingRecord above. Never another recipient's row.
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
      ...recipientSelect(userId),
      feedback: { where: { submittedByUserId: userId }, select: FEEDBACK_SELECT, take: 1 },
    },
  });

  if (!project || !project.projectRequestId) {
    return { isRequestOriginTarget: false, isRecipient: false, isProjectCompleted: false, feedback: null };
  }

  const own = project.feedback[0] ?? null;
  return {
    isRequestOriginTarget: true,
    isRecipient: isFeedbackRecipient(project, userId),
    isProjectCompleted: project.status === ProjectStatus.COMPLETED,
    feedback: own && isCompleteFiveRatingRecord(own) ? (own as ProjectFeedbackRecord) : null,
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
    select: { status: true, projectRequestId: true, ...recipientSelect(userId) },
  });
  if (!project) return { ok: false, error: { code: "not_found" } };
  if (!project.projectRequestId) return { ok: false, error: { code: "not_request_origin" } };
  const projectRequestId = project.projectRequestId;
  // Only a recipient (isFeedbackRecipient: persisted obligation on tracked
  // Projects, the live rule on historical untracked ones — re-read from the
  // DB on every call) may create/update, and only their OWN row. Never the
  // full `owners` set as such, never Audience/Members, and ADMIN holds no
  // implicit bypass here — a deliberate, identity-based exception.
  if (!isFeedbackRecipient(project, userId)) return { ok: false, error: { code: "forbidden" } };
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

    // The caller's OWN row only — one row per (Project, recipient).
    const ownKey = { projectId_submittedByUserId: { projectId, submittedByUserId: userId } };
    const existing = await tx.projectFeedback.findUnique({ where: ownKey, select: { id: true } });
    if (existing) {
      // writeData's ratings/requirementsDelivered are all real, Zod-
      // validated non-null values (ProjectFeedbackInput) — the column
      // type is only nullable to accommodate pre-existing LEGACY rows
      // (see FEEDBACK_SELECT's own doc comment), never a row this
      // function itself just wrote. submittedByUserId is deliberately
      // ABSENT from writeData — see this function's own doc comment on
      // legacy provenance preservation.
      result = (await tx.projectFeedback.update({ where: ownKey, data: writeData, select: FEEDBACK_SELECT })) as ProjectFeedbackRecord;
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

// ─── Persisted obligations ──────────────────────────────────────────────────

/**
 * Called INSIDE the transaction that performs a genuine non-COMPLETED ->
 * COMPLETED transition of a Project (PATCH /api/projects/[id]), so the
 * obligations commit or roll back together with the completion itself.
 *
 *  - Request-origin Projects only (manual Projects: no-op).
 *  - Stamps Project.feedbackRequestedAt the FIRST time (tracking marker),
 *    even when zero recipients are eligible.
 *  - Eligible = ACTIVE Responsible People; the primary Owner (if active)
 *    ONLY when no Responsible People are configured at all.
 *  - Adds only obligations that don't exist yet: existing ones (and their
 *    responses) are never touched, so re-completion just adds newly
 *    eligible recipients. Idempotent: the Project row is locked FOR UPDATE
 *    (concurrent completions serialize here) and @@unique([projectId,
 *    userId]) + skipDuplicates are the structural backstop.
 *
 * Returns the users to notify: the NEWLY created obligations, minus anyone
 * who already has a Feedback row for this Project (e.g. submitted while the
 * Project was historical/untracked) — never anyone who already had an
 * obligation.
 */
export async function recordProjectFeedbackObligationsInTransaction(
  tx: Prisma.TransactionClient,
  projectId: string
): Promise<{ notifyUserIds: string[] }> {
  await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: {
      projectRequestId: true,
      feedbackRequestedAt: true,
      ownerId: true,
      owner: { select: { isActive: true } },
      responsiblePeople: { select: { id: true, isActive: true } },
      feedbackRequests: { select: { userId: true } },
      feedback: { select: { submittedByUserId: true } },
    },
  });
  if (!project || !project.projectRequestId) return { notifyUserIds: [] };

  if (!project.feedbackRequestedAt) {
    await tx.project.update({ where: { id: projectId }, data: { feedbackRequestedAt: new Date() } });
  }

  const eligible =
    project.responsiblePeople.length > 0
      ? Array.from(new Set(project.responsiblePeople.filter((p) => p.isActive).map((p) => p.id)))
      : project.owner.isActive
        ? [project.ownerId]
        : [];
  const alreadyRequested = new Set(project.feedbackRequests.map((r) => r.userId));
  const newUserIds = eligible.filter((u) => !alreadyRequested.has(u));
  if (newUserIds.length === 0) return { notifyUserIds: [] };

  await tx.projectFeedbackRequest.createMany({ data: newUserIds.map((userId) => ({ projectId, userId })), skipDuplicates: true });
  const alreadySubmitted = new Set(project.feedback.map((f) => f.submittedByUserId));
  return { notifyUserIds: newUserIds.filter((u) => !alreadySubmitted.has(u)) };
}

// ─── Administration completion tracking ────────────────────────────────────

export type ProjectFeedbackTrackingStatus = "COMPLETE" | "IN_PROGRESS" | "NO_ELIGIBLE_RECIPIENTS" | "NOT_TRACKED";

export type ProjectFeedbackTracking = {
  status: ProjectFeedbackTrackingStatus;
  required: string[];
  submitted: string[];
  pending: string[];
  // Requested but now inactive: shown for history, never required, never blocking.
  inactiveRequested: string[];
};

/**
 * THE canonical completion computation (pure):
 *  - NOT_TRACKED: feedbackRequestedAt is null — historical, never processed
 *    by Feedback tracking (decided by the marker, never by "no rows").
 *  - required  = obligations whose user is still ACTIVE;
 *    submitted = required users with a Feedback row; pending = the rest.
 *  - NO_ELIGIBLE_RECIPIENTS: tracked but nothing required (nobody was
 *    eligible at completion, or every requested user is now inactive).
 *  - COMPLETE when nothing is pending, otherwise IN_PROGRESS.
 */
export function computeProjectFeedbackTracking(input: {
  feedbackRequestedAt: Date | null;
  requests: { userId: string; isActive: boolean }[];
  submittedUserIds: string[];
}): ProjectFeedbackTracking {
  const submittedSet = new Set(input.submittedUserIds);
  if (!input.feedbackRequestedAt) {
    return { status: "NOT_TRACKED", required: [], submitted: [], pending: [], inactiveRequested: [] };
  }
  const required = input.requests.filter((r) => r.isActive).map((r) => r.userId);
  const inactiveRequested = input.requests.filter((r) => !r.isActive).map((r) => r.userId);
  const submitted = required.filter((u) => submittedSet.has(u));
  const pending = required.filter((u) => !submittedSet.has(u));
  const status: ProjectFeedbackTrackingStatus = required.length === 0 ? "NO_ELIGIBLE_RECIPIENTS" : pending.length === 0 ? "COMPLETE" : "IN_PROGRESS";
  return { status, required, submitted, pending, inactiveRequested };
}

type TrackingUser = { id: string; name: string | null; email: string; isActive: boolean };

export type ProjectFeedbackTrackingRow = {
  project: { id: string; title: string; status: ProjectStatus; feedbackRequestedAt: Date | null; department: { id: string; name: string } | null };
  tracking: ProjectFeedbackTracking;
  users: Record<string, TrackingUser>;
  // Every user with a Feedback row on this Project (responses are never hidden).
  allSubmittedUserIds: string[];
  // Rows not tied to a current obligation (historical/legacy submissions).
  otherSubmissionUserIds: string[];
};

/** Project-level overview for Administration -> Project Feedback (read-only). */
export async function getProjectFeedbackTrackingOverview(filter: { departmentId?: string }): Promise<ProjectFeedbackTrackingRow[]> {
  const userSelect = { select: { id: true, name: true, email: true, isActive: true } } as const;
  const projects = await prisma.project.findMany({
    where: {
      projectRequestId: { not: null },
      ...(filter.departmentId ? { departmentId: filter.departmentId } : {}),
      OR: [{ feedbackRequestedAt: { not: null } }, { status: ProjectStatus.COMPLETED }, { feedback: { some: {} } }],
    },
    orderBy: [{ feedbackRequestedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      status: true,
      feedbackRequestedAt: true,
      department: { select: { id: true, name: true } },
      feedbackRequests: { orderBy: { requestedAt: "asc" }, select: { userId: true, user: userSelect } },
      feedback: { select: { submittedByUserId: true, submittedByUser: userSelect } },
    },
  });
  return projects.map((p) => {
    const users: Record<string, TrackingUser> = {};
    for (const r of p.feedbackRequests) users[r.userId] = r.user;
    for (const f of p.feedback) users[f.submittedByUserId] = f.submittedByUser;
    const requested = new Set(p.feedbackRequests.map((r) => r.userId));
    return {
      project: { id: p.id, title: p.title, status: p.status, feedbackRequestedAt: p.feedbackRequestedAt, department: p.department },
      tracking: computeProjectFeedbackTracking({
        feedbackRequestedAt: p.feedbackRequestedAt,
        requests: p.feedbackRequests.map((r) => ({ userId: r.userId, isActive: r.user.isActive })),
        submittedUserIds: p.feedback.map((f) => f.submittedByUserId),
      }),
      users,
      allSubmittedUserIds: p.feedback.map((f) => f.submittedByUserId),
      otherSubmissionUserIds: p.feedback.map((f) => f.submittedByUserId).filter((u) => !requested.has(u)),
    };
  });
}

// ─── Completion notification + email ────────────────────────────────────────

// Deliberately NOT NEXT_PUBLIC_* — this module is server-only (imports
// prisma directly), and a NEXT_PUBLIC_ var gets inlined as a literal string
// at `next build` time, everywhere it's referenced, client code or not. The
// Docker build stage never sees the real .env (see .dockerignore), so a
// NEXT_PUBLIC_ fallback here would permanently bake in "http://localhost:3000"
// regardless of what docker-compose.yml's env_file supplies at container
// runtime — exactly the bug this was changed to fix. A plain APP_URL is
// read fresh from process.env whenever this code actually runs, which is
// what every consumer here (building an email/notification link) needs.
const APP_URL = process.env.APP_URL || "http://localhost:3000";

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
 * Best-effort in-app notification + email for NEWLY created Feedback
 * obligations only (the `notifyUserIds` returned by
 * recordProjectFeedbackObligationsInTransaction) — called by PATCH
 * /api/projects/[id] only AFTER the completion transaction has committed.
 * Users who already had an obligation are never passed in, so a reopen ->
 * re-complete cycle never re-sends a request to them. Clicking either
 * lands directly on /projects/[id]/feedback.
 *
 * Reliability: createInAppNotification already swallows its own failures
 * (logged, never thrown); the email send is wrapped in its own try/catch —
 * a Microsoft Graph outage never turns an already-successful completion
 * into an error response, and never rolls back the completion or the
 * persisted obligations.
 */
export async function notifyNewProjectFeedbackObligations(project: { id: string; title: string }, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const recipients = await prisma.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true, name: true, email: true },
  });

  const feedbackUrl = `/projects/${project.id}/feedback`;
  for (const recipient of recipients) {
    await createInAppNotification({
      userId: recipient.id,
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
          toRecipients: [{ emailAddress: { address: recipient.email, name: recipient.name ?? undefined } }],
        },
      });
    } catch (err) {
      console.error("[project-feedback] Failed to send completion email to a Feedback recipient:", err);
    }
  }
}
