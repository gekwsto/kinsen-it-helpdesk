import { prisma } from "@/lib/prisma";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { hasPermission, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { listAccessibleWorkspaces, isAccessibleDepartment } from "@/lib/services/workspace-service";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import { createInAppNotification, dispatchCreatedNotification } from "@/lib/notifications/create-notification";
import { scheduleSetupReminderInTx, cancelSetupReminderInTx } from "@/lib/services/project-request-setup-reminder-service";
import { APPROVE_PERMISSION_KEY, getEligibleApproverUserIds } from "@/lib/services/project-request-approver-eligibility-service";
import { listAllSqlGeneralUsers } from "@/lib/sqlgeneral-api-client";
import { wholeCalendarDaysBetween } from "@/lib/date-only";
import { Role, type ProjectRequestStatus, type Prisma } from "@prisma/client";

// ─── Department resolution ──────────────────────────────────────────────────

export type DepartmentResolution =
  | { ok: true; departmentId: string }
  | { ok: false; reason: "no_department" | "not_a_member" | "ambiguous" | "all_workspaces_not_allowed" };

/**
 * Resolves the ONE department a submission is filed under — server-side,
 * from the SAME canonical accessible-departments rule the workspace
 * selector itself uses (lib/services/workspace-service.ts's
 * listAccessibleWorkspaces/isAccessibleDepartment: a global-scope role,
 * i.e. canViewAllDepartments — ADMIN/DIRECTOR — reaches every ACTIVE
 * department; everyone else only an active DepartmentMembership's own
 * department).
 *
 * A single accessible department is auto-selected; more than one requires
 * an explicit `requestedDepartmentId` that must pass isAccessibleDepartment
 * — a forged id for a department outside the caller's real accessible set
 * is always rejected here, never silently accepted. The synthetic "All
 * Workspaces" value is never a real department and is rejected outright,
 * never stored.
 */
export async function resolveDepartmentForRequest(
  userId: string,
  role: Role,
  requestedDepartmentId: string | null | undefined
): Promise<DepartmentResolution> {
  if (requestedDepartmentId) {
    if (requestedDepartmentId === ALL_WORKSPACES_VALUE) {
      return { ok: false, reason: "all_workspaces_not_allowed" };
    }
    const accessible = await isAccessibleDepartment(userId, role, requestedDepartmentId);
    if (!accessible) return { ok: false, reason: "not_a_member" };
    return { ok: true, departmentId: requestedDepartmentId };
  }

  const accessible = await listAccessibleWorkspaces(userId, role);
  if (accessible.length === 0) return { ok: false, reason: "no_department" };
  if (accessible.length === 1) return { ok: true, departmentId: accessible[0].id };
  return { ok: false, reason: "ambiguous" };
}

// ─── Eligible approvers (for the "Awaiting My Approval" scope AND submission notifications) ──
// getEligibleApproverUserIds now lives in
// project-request-approver-eligibility-service.ts (imported above) — see
// that file's own header comment for why it was extracted out of here.

/** Submission-time notification to every currently-eligible approver in the request's department — best-effort, called only after the ProjectRequest row itself has committed. */
export async function notifyEligibleApproversOfSubmission(departmentId: string, requestId: string, title: string): Promise<void> {
  const approverIds = await getEligibleApproverUserIds(departmentId);
  await Promise.all(
    approverIds.map((userId) =>
      createInAppNotification({
        userId,
        title: "New Project Request awaiting your approval",
        body: `A new Project Request "${title}" needs your approval.`,
        link: `/project-requests/${requestId}`,
      })
    )
  );
}

// ─── Intermediate stage: requester-selected, unanimous, multi-approver ─────

export type IntermediateApproverCandidateResolution =
  | { status: "has_candidates"; candidates: { id: string; name: string | null; email: string }[] }
  // A VERIFIED fact about the requester's own SQLGeneral record: their
  // managerAMAccountName is genuinely null. The intermediate stage is
  // skipped entirely for this request (see resolveIntermediateApprovers).
  | { status: "no_manager" }
  // Anything that stops short of a verified "this requester has no
  // manager" — the requester's own SQLGeneral identity isn't captured/
  // doesn't resolve/is ambiguous, the SQLGeneral API/pagination failed, the
  // manager's own identity doesn't resolve/is ambiguous, the manager has no
  // TicketApp account, or the manager's TicketApp account is inactive.
  // NEVER treated as "no_manager" — see this function's own doc comment.
  | { status: "unresolved"; reason: string };

/**
 * The requester's intermediate-approver candidate pool is their own
 * VERIFIED SQLGeneral direct manager — never Company/Department, never
 * inferred, never a global permission grant (the prior design; see
 * decideIntermediateApproval's own doc comment for the matching
 * authorization change this round makes). Resolution mirrors the
 * manager-chain logic in sqlgeneral-organization-tree-service.ts exactly
 * (same fail-closed semantics for an ambiguous SQLGeneral username), scoped
 * to a single requester rather than the whole roster.
 *
 * Fails CLOSED to "unresolved", never "no_manager", at every step except
 * one: only a requester's own SQLGeneral row with a genuinely null
 * managerAMAccountName is "no_manager". An API/pagination failure, an
 * unmatched/ambiguous requester or manager identity, a manager with no
 * TicketApp account, or an inactive manager account are all "unresolved" —
 * the business rule this exists to enforce ("Unresolved manager/API
 * failure must never be treated as no manager").
 */
export async function resolveIntermediateApproverCandidates(requesterId: string): Promise<IntermediateApproverCandidateResolution> {
  const requesterAttempt = await prisma.sqlGeneralUserSyncAttempt.findUnique({
    where: { userId: requesterId },
    select: { sqlGeneralUsername: true },
  });
  if (!requesterAttempt?.sqlGeneralUsername) {
    return { status: "unresolved", reason: "Your SQLGeneral identity has not been captured yet — sign out and back in, or contact an administrator." };
  }

  const usersResult = await listAllSqlGeneralUsers();
  if (!usersResult.ok) {
    return { status: "unresolved", reason: `Could not verify your manager against SQLGeneral right now (${usersResult.reason}).` };
  }

  const requesterMatches = usersResult.users.filter((u) => u.username === requesterAttempt.sqlGeneralUsername);
  if (requesterMatches.length === 0) {
    return { status: "unresolved", reason: "Your SQLGeneral identity was not found in current SQLGeneral data." };
  }
  if (requesterMatches.length > 1) {
    return { status: "unresolved", reason: "Your SQLGeneral identity is ambiguous (it matches more than one SQLGeneral record)." };
  }

  const managerUsername = requesterMatches[0].managerAMAccountName?.trim() || null;
  if (managerUsername === null) return { status: "no_manager" };
  if (managerUsername === requesterMatches[0].username) {
    return { status: "unresolved", reason: "Your SQLGeneral record claims you as your own manager — cannot be verified." };
  }

  const managerMatches = usersResult.users.filter((u) => u.username === managerUsername);
  if (managerMatches.length === 0) {
    return { status: "unresolved", reason: "Your manager's SQLGeneral identity was not found in current SQLGeneral data." };
  }
  if (managerMatches.length > 1) {
    return { status: "unresolved", reason: "Your manager's SQLGeneral identity is ambiguous (it matches more than one SQLGeneral record)." };
  }

  const localAttempts = await prisma.sqlGeneralUserSyncAttempt.findMany({
    where: { sqlGeneralUsername: managerUsername },
    select: { userId: true, user: { select: { id: true, name: true, email: true, isActive: true } } },
  });
  if (localAttempts.length === 0) {
    return { status: "unresolved", reason: "Your manager does not have a TicketApp account yet — contact an administrator." };
  }
  if (localAttempts.length > 1) {
    return { status: "unresolved", reason: "Your manager's SQLGeneral identity is claimed by more than one TicketApp account — contact an administrator." };
  }
  const managerUser = localAttempts[0].user;
  if (!managerUser.isActive) {
    return { status: "unresolved", reason: "Your manager's TicketApp account is inactive — contact an administrator." };
  }

  return { status: "has_candidates", candidates: [{ id: managerUser.id, name: managerUser.name, email: managerUser.email }] };
}

export type IntermediateApproverResolution =
  | { ok: true; approverIds: string[]; skipIntermediateStage: boolean }
  | { ok: false; reason: "no_approvers_selected" | "invalid_approver" | "unresolved_manager"; detail?: string };

/**
 * Server-side re-verification of the requester's own selection — never
 * trusted as-is. Re-derives the candidate pool fresh from
 * resolveIntermediateApproverCandidates (never a stale/client-supplied
 * pool):
 *   - "unresolved" fails the WHOLE submission — never silently skips the
 *     stage and never silently requires an empty selection either.
 *   - "no_manager" requires an EMPTY selection (a non-empty one here is a
 *     forged/stale submission, rejected as invalid_approver) and signals
 *     the stage should be skipped entirely.
 *   - "has_candidates" requires at least one real candidate id selected
 *     (REQUIRED #4 — explicit selection, never auto-selected), and every
 *     selected id must be exactly one of the verified candidates — a
 *     single forged/stale id fails the WHOLE submission, never silently
 *     dropped and never substituted.
 */
export async function resolveIntermediateApprovers(requesterId: string, selectedIds: string[]): Promise<IntermediateApproverResolution> {
  const candidateResolution = await resolveIntermediateApproverCandidates(requesterId);
  if (candidateResolution.status === "unresolved") {
    return { ok: false, reason: "unresolved_manager", detail: candidateResolution.reason };
  }
  if (candidateResolution.status === "no_manager") {
    if (selectedIds.length > 0) return { ok: false, reason: "invalid_approver" };
    return { ok: true, approverIds: [], skipIntermediateStage: true };
  }
  if (selectedIds.length === 0) return { ok: false, reason: "no_approvers_selected" };
  const eligibleIds = new Set(candidateResolution.candidates.map((u) => u.id));
  for (const id of selectedIds) {
    if (!eligibleIds.has(id)) return { ok: false, reason: "invalid_approver" };
  }
  return { ok: true, approverIds: selectedIds, skipIntermediateStage: false };
}

/** Submission-time notification to every SELECTED intermediate approver — best-effort, called only after the ProjectRequest + ProjectRequestIntermediateApprover rows have actually committed. The final stage's own eligible approvers are deliberately NOT notified yet — see notifyEligibleApproversOfSubmission's new call site in decideIntermediateApproval, fired only once intermediate approval is unanimously complete. */
export async function notifyIntermediateApprovers(requestId: string, title: string, approverIds: string[]): Promise<void> {
  await Promise.all(
    approverIds.map((userId) =>
      createInAppNotification({
        userId,
        title: "New Project Request awaiting your intermediate approval",
        body: `A new Project Request "${title}" needs your intermediate approval.`,
        link: `/project-requests/${requestId}`,
      })
    )
  );
}

// ─── Visibility / scope ─────────────────────────────────────────────────────

/** Every departmentId where this user has effective projectRequest.approve via a real, active DepartmentMembership (never the active workspace). Empty when they hold no department-scoped grant at all. */
async function getDepartmentIdsWithApprovePermission(userId: string): Promise<string[]> {
  const memberships = await getUserDepartmentMemberships(userId);
  const ids: string[] = [];
  for (const m of memberships) {
    if (await hasDepartmentPermission(m.role, APPROVE_PERMISSION_KEY, m.customRoleId)) ids.push(m.departmentId);
  }
  return ids;
}

export interface RequesterApprovalScope {
  hasGlobalApprove: boolean;
  approveDepartmentIds: string[];
}

export async function resolveApprovalScope(userId: string, role: Role, customRoleId: string | null | undefined): Promise<RequesterApprovalScope> {
  const [hasGlobalApprove, approveDepartmentIds] = await Promise.all([
    hasPermission(role, APPROVE_PERMISSION_KEY, customRoleId),
    getDepartmentIdsWithApprovePermission(userId),
  ]);
  return { hasGlobalApprove, approveDepartmentIds };
}

/**
 * Prisma `where` fragment for the "Awaiting My Approval" tab — PENDING
 * requests within this user's effective projectRequest.approve scope
 * (global -> every department, department-scoped -> only those
 * departments). Empty (never-matching) when the user holds no approve
 * grant at all — never a broader "everyone sees everything pending"
 * fallback.
 */
export function buildAwaitingMyApprovalWhere(userId: string, scope: RequesterApprovalScope): Prisma.ProjectRequestWhereInput {
  void userId;
  if (scope.hasGlobalApprove) {
    return { status: "PENDING_APPROVAL" };
  }
  if (scope.approveDepartmentIds.length > 0) {
    return { status: "PENDING_APPROVAL", departmentId: { in: scope.approveDepartmentIds } };
  }
  // No approve grant anywhere — matches nothing, never falls back to "all".
  return { id: { in: [] } };
}

/** "Awaiting My Intermediate Approval": PENDING_INTERMEDIATE_APPROVAL requests where THIS user has their own still-PENDING ProjectRequestIntermediateApprover row — never a department/permission-scoped query, since this stage is purely per-request selection. A user who already decided their own row (approved or rejected) no longer sees the request here, even if OTHER selected approvers haven't decided yet. */
export function buildAwaitingMyIntermediateApprovalWhere(userId: string): Prisma.ProjectRequestWhereInput {
  return {
    status: "PENDING_INTERMEDIATE_APPROVAL",
    intermediateApprovers: { some: { approverId: userId, status: "PENDING" } },
  };
}

/** History tab: Approved/Rejected requests this user was actually involved in (requester, or within their own effective approval scope) — never every request in the system. */
export function buildHistoryWhere(userId: string, scope: RequesterApprovalScope): Prisma.ProjectRequestWhereInput {
  if (scope.hasGlobalApprove) {
    // Global approve -> every decided request is "their own involvement",
    // not just ones they personally submitted — an unconditional status
    // filter, same shape buildAwaitingMyApprovalWhere's own global branch
    // already uses. Deliberately NEVER `OR: [{requesterId}, {}]` — an empty
    // `{}` member inside a Prisma OR array is NOT "always true" (it's
    // effectively ignored), which silently collapsed this to
    // requesterId-only and hid every other decided request from a global
    // approver's History tab until this was caught by a real browser
    // smoke test.
    return { status: { in: ["APPROVED", "REJECTED"] } };
  }
  const or: Prisma.ProjectRequestWhereInput[] = [
    { requesterId: userId },
    // Any request they were EVER asked to intermediate-approve, regardless
    // of how they decided (or whether another approver's rejection beat
    // them to it) — real involvement, not department-scoped.
    { intermediateApprovers: { some: { approverId: userId } } },
  ];
  if (scope.approveDepartmentIds.length > 0) {
    or.push({ departmentId: { in: scope.approveDepartmentIds } });
  }
  return { status: { in: ["APPROVED", "REJECTED"] }, OR: or };
}

/** Detail-page/API visibility — requester, within effective FINAL approval scope for THIS request's own department, OR one of THIS request's own selected intermediate approvers (even though they hold no department-scoped grant at all — their authority is the explicit per-request selection, not a department). Never a broader "any admin-adjacent role" shortcut. */
export async function canViewProjectRequest(
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  request: { id: string; requesterId: string; departmentId: string }
): Promise<boolean> {
  if (request.requesterId === userId) return true;
  const isFinalApprover = await hasEffectiveEntityPermission(userId, role, customRoleId, request.departmentId, APPROVE_PERMISSION_KEY);
  if (isFinalApprover) return true;
  const intermediateRow = await prisma.projectRequestIntermediateApprover.findUnique({
    where: { projectRequestId_approverId: { projectRequestId: request.id, approverId: userId } },
    select: { id: true },
  });
  return intermediateRow !== null;
}

// ─── Approval transition ────────────────────────────────────────────────────

export type ApprovalActionError =
  | { code: "not_found" }
  | { code: "forbidden" }
  | { code: "invalid_status"; currentStatus: ProjectRequestStatus }
  | { code: "invalid_assessment" };

export type ApprovalActionResult =
  | { ok: true }
  | { ok: false; error: ApprovalActionError };

const MAX_BUSINESS_ASSESSMENT_LENGTH = 5000;

/**
 * Approve/Reject — a single, department-scoped approval stage. Authorization
 * is effective `projectRequest.approve` for THIS request's own department
 * (global grant OR that department's own grant), re-checked here
 * server-side regardless of what the UI showed — never tied to the
 * requester's own manager/org-chart in any way. `businessAssessment` is the
 * approver's OWN mandatory justification for this specific decision —
 * re-validated here (trimmed, non-empty, length-capped) rather than trusting
 * the route's zod check alone, since this is the actual persistence
 * boundary. Guarded atomically by the CURRENT status in the same
 * conditional `updateMany` that performs the transition (never a separate
 * read-then-write with a race window) — a concurrent double-click or two
 * different approvers racing each other can only ever have ONE of them
 * actually flip the row; every other caller gets a clean "already
 * processed" result, never a silent double-transition, and the LOSING
 * call's businessAssessment is never persisted. The Notification row is
 * created in the SAME transaction as the status + assessment write (publish
 * only after a real commit) — the realtime publish + push dispatch happens
 * AFTER the transaction commits, via dispatchCreatedNotification.
 *
 * This function is responsible ONLY for the approval decision itself — it
 * does NOT create a Project. On a successful APPROVE, the acting approver
 * is expected to be redirected to the dedicated request-origin Project
 * setup flow (POST /api/project-requests/[id]/project,
 * createProjectFromApprovedRequest below) — a deliberately separate step,
 * since that flow collects its own required fields (Project Owner,
 * Expected Start/Finish, Expense Type, Budget, Estimated Cost) that have no
 * natural place in this decision's own dialog.
 */
export async function decideApproval(
  requestId: string,
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  decision: "approve" | "reject",
  businessAssessment: string
): Promise<ApprovalActionResult> {
  const trimmedAssessment = businessAssessment.trim();
  if (trimmedAssessment.length === 0 || trimmedAssessment.length > MAX_BUSINESS_ASSESSMENT_LENGTH) {
    return { ok: false, error: { code: "invalid_assessment" } };
  }

  const existing = await prisma.projectRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, status: true, departmentId: true, requesterId: true },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };
  if (existing.status !== "PENDING_APPROVAL") return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };

  const allowed = await hasEffectiveEntityPermission(userId, role, customRoleId, existing.departmentId, APPROVE_PERMISSION_KEY);
  if (!allowed) return { ok: false, error: { code: "forbidden" } };

  const nextStatus: ProjectRequestStatus = decision === "approve" ? "APPROVED" : "REJECTED";
  const now = new Date();

  let notificationRow: { id: string; userId: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: Date } | null = null;

  await prisma.$transaction(async (tx) => {
    const updateResult = await tx.projectRequest.updateMany({
      where: { id: requestId, status: "PENDING_APPROVAL" },
      data:
        decision === "approve"
          ? { status: nextStatus, approvedAt: now, approverId: userId, businessAssessment: trimmedAssessment }
          : { status: nextStatus, rejectedAt: now, approverId: userId, businessAssessment: trimmedAssessment },
    });
    if (updateResult.count === 0) {
      // Lost a race against a concurrent identical call — nothing else to do.
      return;
    }
    const decisionLabel = decision === "approve" ? "approved" : "rejected";
    notificationRow = await tx.notification.create({
      data: {
        userId: existing.requesterId,
        title: `Project Request ${decisionLabel}`,
        body: `Your Project Request "${existing.title}" was ${decisionLabel}.`,
        link: `/project-requests/${requestId}`,
      },
    });
    // Only on approve — a rejected request has no Project to ever set up.
    // See ProjectRequestSetupReminder's own doc comment for why this fires
    // for every currently-eligible approver, not just `userId` (this call's
    // own acting approver).
    if (decision === "approve") {
      await scheduleSetupReminderInTx(tx, requestId, now);
    }
  });

  if (!notificationRow) {
    const nowState = await prisma.projectRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    return { ok: false, error: { code: "invalid_status", currentStatus: nowState?.status ?? existing.status } };
  }

  await dispatchCreatedNotification(notificationRow);
  return { ok: true };
}

// ─── Request-origin Project setup (a separate step, AFTER final approval) ──

export type CreateProjectFromRequestError =
  | { code: "not_found" }
  | { code: "forbidden" }
  | { code: "invalid_status"; currentStatus: ProjectRequestStatus }
  | { code: "invalid_project_owner" }
  | { code: "invalid_audience" }
  | { code: "invalid_expense_type" }
  | { code: "invalid_sub_department" }
  | { code: "invalid_member" };

/**
 * Validates a set of user ids for Owner(s)/Audience — deliberately NEVER
 * Department/Workspace-scoped, unlike Members' own
 * userHasAssignablePermissionForEntity: both are explicitly "ANY active
 * user in the entire system" per this feature's own spec (no requirement
 * the user belongs to the Project's department, holds any particular
 * permission, or is already a Member). Deduplicates, rejects blank
 * entries, and returns null if ANY id doesn't resolve to a real, currently
 * active User — never silently drops an invalid one and proceeds with the
 * rest (fail closed, same philosophy as the Member-eligibility loop below).
 */
async function resolveSystemWideActiveUserIds(ids: string[]): Promise<string[] | null> {
  const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
  if (deduped.length === 0) return deduped;
  const activeCount = await prisma.user.count({ where: { id: { in: deduped }, isActive: true } });
  return activeCount === deduped.length ? deduped : null;
}

export type CreateProjectFromRequestResult =
  | { ok: true; projectId: string; alreadyExisted: boolean }
  | { ok: false; error: CreateProjectFromRequestError };

/**
 * Turns an APPROVED Project Request into a real Project — a deliberately
 * SEPARATE step from decideApproval (see that function's own doc comment),
 * with its own authorization boundary:
 *
 *   - the request must genuinely be APPROVED (never
 *     PENDING_INTERMEDIATE_APPROVAL/PENDING_APPROVAL/REJECTED — Project
 *     creation is only ever reachable from the terminal APPROVED state);
 *   - the acting user must currently hold effective `projectRequest.approve`
 *     for THIS request's own department (hasEffectiveEntityPermission — the
 *     exact same check decideApproval itself uses to decide who may approve
 *     in the first place), NOT the exact recorded final approver. Completing
 *     setup is a continuation of "who may finalize this department's
 *     requests right now," not a one-time personal grant tied to whoever
 *     happened to click Approve — if that original approver has since left
 *     the department/role, or simply never returns to finish it, anyone else
 *     who currently holds that same authority can pick it up instead,
 *     without anything getting permanently stuck on one person. This
 *     intentionally does NOT require (or grant) generic `project.create` —
 *     completing setup for an already-decided request in a department you
 *     can approve requests for is a narrower capability than being allowed
 *     to manually create arbitrary Projects there.
 *
 * Idempotent/race-safe: acquires a `SELECT ... FOR UPDATE` row lock on the
 * ProjectRequest as the first statement of the transaction (same
 * established pattern as decideIntermediateApproval's own doc comment),
 * re-checks for an already-linked Project INSIDE that lock, and only
 * creates one if it's still genuinely missing. If a Project already exists
 * (e.g. a duplicate submission, two open tabs, two different eligible
 * approvers both finishing setup, or a refresh after an earlier success),
 * this returns `alreadyExisted: true` with that Project's own id — a clean,
 * safe resolution, never a second Project and never a hard error.
 * Project.projectRequestId's own `@unique` DB constraint is a second,
 * structural backstop even if the row lock were somehow bypassed.
 *
 * Department is ALWAYS `existing.departmentId` — never accepted from the
 * caller's input at all (see createProjectFromRequestSchema, which doesn't
 * even have a departmentId field). Title/description/priority are
 * pre-filled by the caller (the setup page) from the request but ARE
 * ordinary editable Project fields here, same as any manual creation.
 */
export async function createProjectFromApprovedRequest(
  requestId: string,
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  data: import("@/lib/validations").CreateProjectFromRequestInput
): Promise<CreateProjectFromRequestResult> {
  const existing = await prisma.projectRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, departmentId: true, approverId: true, project: { select: { id: true } } },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };
  if (existing.status !== "APPROVED") return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  const allowed = await hasEffectiveEntityPermission(userId, role, customRoleId, existing.departmentId, APPROVE_PERMISSION_KEY);
  if (!allowed) return { ok: false, error: { code: "forbidden" } };

  if (existing.project) {
    return { ok: true, projectId: existing.project.id, alreadyExisted: true };
  }

  // System-wide, NEVER Department-scoped — see resolveSystemWideActiveUserIds'
  // own doc comment. At least one Owner is required; ownerIds[0] becomes
  // the canonical Project.ownerId below (the FIRST explicitly-selected
  // owner — never auto-derived, never the requester/approver/creator by
  // default).
  const ownerIds = await resolveSystemWideActiveUserIds(data.ownerIds);
  if (!ownerIds || ownerIds.length === 0) return { ok: false, error: { code: "invalid_project_owner" } };

  // Audience is optional (zero or more) — an empty array is valid; only a
  // genuinely INVALID (non-existent/inactive) submitted id fails this.
  const audienceIds = await resolveSystemWideActiveUserIds(data.audienceIds ?? []);
  if (audienceIds === null) return { ok: false, error: { code: "invalid_audience" } };

  const expenseType = await prisma.projectExpenseType.findUnique({ where: { id: data.expenseTypeId }, select: { id: true, isActive: true } });
  if (!expenseType || !expenseType.isActive) return { ok: false, error: { code: "invalid_expense_type" } };

  if (data.subDepartmentId) {
    const valid = await validateSubDepartmentInDepartment(data.subDepartmentId, existing.departmentId);
    if (!valid) return { ok: false, error: { code: "invalid_sub_department" } };
  }

  if (data.memberIds.length > 0) {
    for (const memberId of data.memberIds) {
      const assignable = await userHasAssignablePermissionForEntity(memberId, "project", existing.departmentId);
      if (!assignable) return { ok: false, error: { code: "invalid_member" } };
    }
  }

  // Computed ONCE here, server-side — the authoritative baseline. The
  // client may show a live preview of the same arithmetic for UX, but this
  // is the only value that is ever actually persisted; a client-submitted
  // duration is never read (the field isn't even accepted by
  // createProjectFromRequestSchema).
  const expectedTotalInitialDays = wholeCalendarDaysBetween(new Date(data.expectedStartDate), new Date(data.expectedFinishDate));

  let createdProjectId: string | null = null;
  let alreadyExisted = false;

  await prisma.$transaction(async (tx) => {
    // See this function's own doc comment — serializes every concurrent
    // setup submission for THIS request through one critical section.
    await tx.$queryRaw`SELECT id FROM "ProjectRequest" WHERE id = ${requestId} FOR UPDATE`;

    const stillUnlinked = await tx.projectRequest.findUnique({ where: { id: requestId }, select: { project: { select: { id: true } } } });
    if (stillUnlinked?.project) {
      createdProjectId = stillUnlinked.project.id;
      alreadyExisted = true;
      return;
    }

    const project = await tx.project.create({
      data: {
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        departmentId: existing.departmentId,
        subDepartmentId: data.subDepartmentId ?? undefined,
        businessUnitId: data.businessUnitId,
        // The canonical/primary owner — the FIRST of the creator's
        // explicitly-selected Owner(s), never auto-derived (see
        // Project.ownerId's own schema doc comment).
        ownerId: ownerIds[0],
        // The AUTHORITATIVE full Owner set for this request-origin Project
        // — see Project.owners' own schema doc comment. Always includes
        // ownerIds[0] (it's the same array), so "owners always contains
        // ownerId" holds here too, same as the backfilled invariant for
        // every pre-existing Project.
        owners: { connect: ownerIds.map((id) => ({ id })) },
        // Optional — zero or more system-wide users who may follow this
        // Project's progress without being a Member or an Owner. Never
        // Members (deliberately a separate relation — see
        // hasProjectViewAccess, lib/services/project-access-service.ts,
        // for the ONLY effect Audience membership has).
        audience: audienceIds.length ? { connect: audienceIds.map((id) => ({ id })) } : undefined,
        startDate: data.startDate ? new Date(data.startDate) : undefined,
        endDate: data.endDate ? new Date(data.endDate) : undefined,
        successTarget: data.successTarget,
        isGoal: data.isGoal,
        members: data.memberIds.length ? { connect: data.memberIds.map((id) => ({ id })) } : undefined,
        projectRequestId: requestId,
        expectedStartDate: new Date(data.expectedStartDate),
        expectedFinishDate: new Date(data.expectedFinishDate),
        expectedTotalInitialDays,
        expenseTypeId: data.expenseTypeId,
        // Budget/Estimated Cost/Actual Cost are never written here — Budget
        // was removed entirely, and Estimated/Actual Cost are now derived
        // from this Project's Activities on every read (there are normally
        // none yet at creation time, so they naturally start at €0) — see
        // lib/services/project-financials-service.ts.
        external: data.external,
      },
      select: { id: true },
    });
    createdProjectId = project.id;
    // The request now has a real Project — no more reminding needed. A
    // no-op if no reminder exists (e.g. a request that predates this
    // feature). See cancelSetupReminderInTx's own doc comment.
    await cancelSetupReminderInTx(tx, requestId, "project_created", new Date());
  });

  if (!createdProjectId) {
    // Structural backstop only — the row lock above already makes this
    // unreachable in practice.
    const fallback = await prisma.projectRequest.findUnique({ where: { id: requestId }, select: { project: { select: { id: true } } } });
    if (fallback?.project) return { ok: true, projectId: fallback.project.id, alreadyExisted: true };
    return { ok: false, error: { code: "not_found" } };
  }

  return { ok: true, projectId: createdProjectId, alreadyExisted };
}

/**
 * Approve/Reject at the INTERMEDIATE stage — authorization is simply that
 * a real ProjectRequestIntermediateApprover row exists for this
 * (requestId, userId) pair. There is no separate global-permission check
 * any more (the prior design, before candidates became SQLGeneral-manager-
 * sourced): the row itself is now the strong guarantee, since it can ONLY
 * ever have been created by resolveIntermediateApprovers against the
 * requester's own freshly-verified SQLGeneral direct manager — selection
 * is no longer an arbitrary choice among permission-holders, so requiring
 * the decider to ALSO separately hold a global RBAC permission would be
 * redundant and would, in practice, block the very manager this stage
 * exists to route to (resolving a manager to a local TicketApp user never
 * grants them any permission — see resolveIntermediateApproverCandidates).
 *
 * Reject: immediately terminal — the WHOLE request moves straight to
 * REJECTED, regardless of how many other approvers were selected or already
 * decided. Approve: only the ACTING approver's own row is marked APPROVED;
 * the request only advances to PENDING_APPROVAL (unlocking the pre-existing
 * FINAL stage) once EVERY selected approver's row is APPROVED (unanimous).
 *
 * Race safety: acquires a `SELECT ... FOR UPDATE` row lock on the parent
 * ProjectRequest as the FIRST statement inside the transaction, serializing
 * every concurrent decision (by any of this request's approvers) through a
 * single critical section. A plain conditional UPDATE alone cannot fully
 * close the "last two approvers both approve at the same instant" race:
 * under READ COMMITTED, each transaction's own "are all rows approved yet"
 * check might not see the OTHER transaction's not-yet-committed row update,
 * so both could conclude "not all approved" and the parent could get
 * permanently stuck at PENDING_INTERMEDIATE_APPROVAL even though both
 * individual decisions did persist. The row lock makes that structurally
 * impossible — only one decision for this request is ever "in flight" at a
 * time.
 *
 * Never mutates ProjectRequest.approver/approvedAt/rejectedAt/
 * businessAssessment (those remain the FINAL stage's own, separate audit
 * trail) — this stage only ever writes to its own
 * ProjectRequestIntermediateApprover rows and, on a terminal outcome, the
 * parent's `status`/`rejectedAt`.
 *
 * Unlike the FINAL stage, `businessAssessment` is OPTIONAL here (confirmed
 * with the user: the intermediate stage asks for a decision only, never a
 * written justification) — an empty/whitespace-only value is simply stored
 * as null, never rejected.
 */
export async function decideIntermediateApproval(
  requestId: string,
  userId: string,
  decision: "approve" | "reject",
  businessAssessment?: string
): Promise<ApprovalActionResult> {
  const trimmedAssessment = businessAssessment?.trim() || null;
  if (trimmedAssessment && trimmedAssessment.length > MAX_BUSINESS_ASSESSMENT_LENGTH) {
    return { ok: false, error: { code: "invalid_assessment" } };
  }

  const existing = await prisma.projectRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, status: true, departmentId: true, requesterId: true },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };

  // Never selected for THIS request at all -> forbidden. Selection IS the
  // authorization now (see this function's own doc comment).
  const myRow = await prisma.projectRequestIntermediateApprover.findUnique({
    where: { projectRequestId_approverId: { projectRequestId: requestId, approverId: userId } },
    select: { id: true, status: true },
  });
  if (!myRow) return { ok: false, error: { code: "forbidden" } };

  // A fresh, DB-level re-check — never trusted from the session alone. This
  // app's isActive=false enforcement happens at JWT/session level (see
  // lib/auth.ts's jwt callback), which is a SNAPSHOT taken at login and
  // never re-synced for the life of that session — an approver who was
  // genuinely active when resolveIntermediateApproverCandidates verified
  // them at submission time could be deactivated afterward and still carry
  // a live (stale) session. This mirrors that SAME submission-time
  // guarantee ("resolve managers to ACTIVE TicketApp users") onto the
  // decision itself, closing that window.
  const decidingUser = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  if (!decidingUser?.isActive) return { ok: false, error: { code: "forbidden" } };

  if (existing.status !== "PENDING_INTERMEDIATE_APPROVAL") {
    return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  }
  if (myRow.status !== "PENDING") {
    return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  }

  const nextRowStatus = decision === "approve" ? "APPROVED" : "REJECTED";
  const now = new Date();

  let myDecisionRecorded = false;
  let rejectNotificationRow: { id: string; userId: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: Date } | null = null;
  let justCompletedUnanimously = false;

  await prisma.$transaction(async (tx) => {
    // See this function's own doc comment — serializes every concurrent
    // decision for THIS request through one critical section.
    await tx.$queryRaw`SELECT id FROM "ProjectRequest" WHERE id = ${requestId} FOR UPDATE`;

    const rowUpdate = await tx.projectRequestIntermediateApprover.updateMany({
      where: { id: myRow.id, status: "PENDING" },
      data: { status: nextRowStatus, decidedAt: now, businessAssessment: trimmedAssessment },
    });
    if (rowUpdate.count === 0) {
      // Lost a race against a concurrent identical call (e.g. a double
      // click) — nothing else to do.
      return;
    }
    myDecisionRecorded = true;

    if (decision === "reject") {
      const parentUpdate = await tx.projectRequest.updateMany({
        where: { id: requestId, status: "PENDING_INTERMEDIATE_APPROVAL" },
        data: { status: "REJECTED", rejectedAt: now },
      });
      // Guarded by the row lock above, this should always succeed given
      // myRow.status was genuinely PENDING a moment ago — but never assume;
      // if some other path already moved the parent on, skip the
      // notification rather than fabricate one for a transition that
      // didn't actually happen here.
      if (parentUpdate.count > 0) {
        rejectNotificationRow = await tx.notification.create({
          data: {
            userId: existing.requesterId,
            title: "Project Request rejected",
            body: `Your Project Request "${existing.title}" was rejected during intermediate approval.`,
            link: `/project-requests/${requestId}`,
          },
        });
      }
      return;
    }

    // decision === "approve" — only advance the parent once EVERY selected
    // approver (including the one just updated above) is APPROVED.
    const stillPending = await tx.projectRequestIntermediateApprover.count({
      where: { projectRequestId: requestId, status: "PENDING" },
    });
    if (stillPending === 0) {
      const parentUpdate = await tx.projectRequest.updateMany({
        where: { id: requestId, status: "PENDING_INTERMEDIATE_APPROVAL" },
        data: { status: "PENDING_APPROVAL" },
      });
      if (parentUpdate.count > 0) justCompletedUnanimously = true;
    }
  });

  if (!myDecisionRecorded) {
    const nowState = await prisma.projectRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    return { ok: false, error: { code: "invalid_status", currentStatus: nowState?.status ?? existing.status } };
  }

  if (rejectNotificationRow) {
    await dispatchCreatedNotification(rejectNotificationRow);
  }

  // Fired only AFTER the transaction committed, and only by whichever
  // approver's decision was genuinely the LAST one — the final stage's
  // eligible approvers become actionable (and are told so) only now, never
  // at submission time and never before unanimous intermediate approval. A
  // misleading "ready for final approval" notification before this point
  // is structurally impossible: this call site is the ONLY place that
  // fires it, gated by justCompletedUnanimously.
  if (justCompletedUnanimously) {
    await notifyEligibleApproversOfSubmission(existing.departmentId, requestId, existing.title);
  }

  return { ok: true };
}
