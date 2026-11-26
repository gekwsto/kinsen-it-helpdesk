import { prisma } from "@/lib/prisma";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { hasPermission, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission, getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { listAccessibleWorkspaces, isAccessibleDepartment } from "@/lib/services/workspace-service";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import { createInAppNotification, dispatchCreatedNotification } from "@/lib/notifications/create-notification";
import { scheduleSetupReminderInTx, cancelSetupReminderInTx } from "@/lib/services/project-request-setup-reminder-service";
import { APPROVE_PERMISSION_KEY, getEligibleApproverUserIds } from "@/lib/services/project-request-approver-eligibility-service";
import { findSqlGeneralUserByUsername, type SqlGeneralUserRecord } from "@/lib/sqlgeneral-api-client";
import { resolveProjectDuration } from "@/lib/project-duration";
import { resolveProjectAudienceOrganizationalIds, resolveSystemWideActiveUserIds } from "@/lib/services/project-audience-service";
import {
  getFacilitiesServicesDepartmentId,
  hasFacilitiesFieldsPresent,
  resolveFacilitiesWrite,
  type ResolvedFacilitiesWrite,
} from "@/lib/services/project-facilities-service";
import { Role, type ProjectRequestStatus, type IntermediateApprovalSkipReason, type Prisma } from "@prisma/client";

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

/**
 * A request reached APPROVED with Final Approval SKIPPED (either when its
 * last intermediate approval completed, or at submission when both stages
 * were skipped) — tell everyone who can create its Project (effective
 * projectRequest.approve for the request's department, the same audience
 * and permission createProjectFromApprovedRequest requires) that it is
 * approved and ready for Project Creation. Not an approval request.
 * Called exactly once per transition, only from the code path that actually
 * performed it (the status write is conditional / the row was just
 * created), and each user is notified once. The delayed setup reminder is
 * scheduled separately and unchanged; nothing is created automatically.
 */
export async function notifyEligibleApproversReadyForProjectCreation(departmentId: string, requestId: string, title: string): Promise<void> {
  const approverIds = Array.from(new Set(await getEligibleApproverUserIds(departmentId)));
  await Promise.all(
    approverIds.map((userId) =>
      createInAppNotification({
        userId,
        title: "Project Request approved — ready for Project Creation",
        body: `The Project Request "${title}" is approved (Final Approval was skipped) and is ready for you to create its Project.`,
        link: `/project-requests/${requestId}`,
      })
    )
  );
}

// ─── Intermediate stage: requester-selected, unanimous, multi-approver ─────

export interface IntermediateApproverCandidate {
  id: string;
  name: string | null;
  email: string;
  /**
   * The candidate's REAL depth in the requester's verified SQLGeneral
   * chain — 1 = direct manager, 2 = that manager's own manager, etc. —
   * NEVER renumbered when an intervening level is skipped (no TicketApp
   * account / inactive / claimed by more than one local account), so a
   * level-2 candidate is always honestly labeled "2", never silently
   * promoted to "1" just because level 1 wasn't selectable.
   */
  level: number;
}

export type IntermediateApproverCandidateResolution =
  | { status: "has_candidates"; candidates: IntermediateApproverCandidate[] }
  // A VERIFIED fact, and ONLY this fact: the requester's OWN SQLGeneral
  // record has a genuinely null managerAMAccountName — they have no
  // manager at all, so there was never a chain to walk in the first
  // place. NEVER returned just because a real chain yielded zero eligible
  // candidates — see "unresolved" below for that case, which is
  // deliberately distinct and still blocks submission.
  | { status: "no_manager" }
  // Everything that stops short of the ONE verified "no_manager" fact
  // above: the chain's own STRUCTURE couldn't be fully, honestly verified
  // (a SQLGeneral API/pagination failure, the requester's own identity
  // isn't captured/doesn't resolve/is ambiguous, or SOMEWHERE in the chain
  // a claimed manager doesn't resolve/is ambiguous/self-references/
  // cycles) — OR the requester genuinely HAS a verified manager chain, but
  // not one ancestor along it currently has an eligible active TicketApp
  // account to act as approver. Both block submission outright; neither is
  // ever treated as "no_manager" — a real manager existing, just not yet
  // onboarded to TicketApp, must never be silently skipped as if no
  // approval step were required at all.
  | { status: "unresolved"; reason: string };

/** Walking up to this many levels before giving up — the SAME defensive bound getOrganizationContext (organization-tree-service.ts) uses for its own local manager-chain walk. Real cycles are already caught explicitly below; this only guards a pathologically/corruptly deep chain. */
const MAX_MANAGER_CHAIN_DEPTH = 50;

type SqlGeneralIdentityLookup = { outcome: "unique"; user: SqlGeneralUserRecord } | { outcome: "not_found" } | { outcome: "ambiguous" } | { outcome: "error"; reason: string };

/**
 * Resolves exactly ONE SQLGeneral identity via a single exact OData filter
 * (findSqlGeneralUserByUsername's own `$filter=Username eq '...'`) — never
 * the full paginated roster (listAllSqlGeneralUsers), which is what made
 * resolving even one manager level expensive regardless of chain depth.
 * findSqlGeneralUserByUsername throws on an API/pagination failure (see its
 * own doc comment) rather than returning a typed failure — caught here and
 * converted into the same "error" outcome every other failure mode in this
 * file already uses, so every caller has one uniform shape to check.
 */
async function lookupSqlGeneralIdentity(username: string): Promise<SqlGeneralIdentityLookup> {
  try {
    const result = await findSqlGeneralUserByUsername(username);
    if (result.outcome === "unique") return { outcome: "unique", user: result.user };
    if (result.outcome === "not_found") return { outcome: "not_found" };
    return { outcome: "ambiguous" };
  } catch (err) {
    return { outcome: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The requester's intermediate-approver candidate pool is every eligible
 * manager in their own VERIFIED SQLGeneral chain (direct manager, that
 * manager's own manager, and so on) — never Company/Department, never
 * inferred, never a global permission grant, and never manager2AMAccountName/
 * manager3AMAccountName (see this file's header for why — those fields are
 * read by the SQLGeneral API client but deliberately never consulted for
 * placement anywhere in this codebase, "never skip levels").
 *
 * Two genuinely different kinds of problem are handled differently,
 * deliberately:
 *   - A STRUCTURAL problem anywhere in the chain (the requester's own
 *     identity, or ANY ancestor's) — not found, ambiguous, self-reference,
 *     cycle, or a live API/pagination failure — fails the WHOLE resolution
 *     closed ("unresolved"), discarding any candidates already found. Once
 *     the chain's own shape can't be fully, honestly verified up to a real
 *     root, nothing beyond the break is knowable, so presenting only the
 *     candidates found below it would misrepresent an incomplete list as a
 *     complete one — never silently truncated.
 *   - A LOCAL-ACCOUNT problem on one SPECIFIC, structurally-verified
 *     ancestor (no TicketApp account, claimed by more than one TicketApp
 *     account, or an inactive account) only excludes THAT ancestor from
 *     being offered as a candidate — the walk continues upward through
 *     them regardless, since their own place in the verified chain, and
 *     their own managerAMAccountName, are still real, known facts.
 *
 * "no_manager" is reserved EXCLUSIVELY for a requester whose OWN
 * managerAMAccountName is verified null — there was never a chain to walk.
 * A requester who DOES have a manager chain, walked cleanly to a genuine
 * root with no structural problem anywhere, but with zero ELIGIBLE
 * (local, active TicketApp) candidates found along the way, gets
 * "unresolved" instead — a real manager existing with nobody currently
 * able to act on it must still block submission, never be silently
 * treated as if no manager existed at all.
 */
export async function resolveIntermediateApproverCandidates(requesterId: string): Promise<IntermediateApproverCandidateResolution> {
  const requesterAttempt = await prisma.sqlGeneralUserSyncAttempt.findUnique({
    where: { userId: requesterId },
    select: { sqlGeneralUsername: true },
  });
  if (!requesterAttempt?.sqlGeneralUsername) {
    return { status: "unresolved", reason: "Your SQLGeneral identity has not been captured yet — sign out and back in, or contact an administrator." };
  }

  const requesterLookup = await lookupSqlGeneralIdentity(requesterAttempt.sqlGeneralUsername);
  if (requesterLookup.outcome === "error") return { status: "unresolved", reason: `Could not verify your manager chain against SQLGeneral right now (${requesterLookup.reason}).` };
  if (requesterLookup.outcome === "not_found") return { status: "unresolved", reason: "Your SQLGeneral identity was not found in current SQLGeneral data." };
  if (requesterLookup.outcome === "ambiguous") return { status: "unresolved", reason: "Your SQLGeneral identity is ambiguous (it matches more than one SQLGeneral record)." };

  const visitedUsernames = new Set<string>([requesterLookup.user.username]);
  const candidates: IntermediateApproverCandidate[] = [];
  let current = requesterLookup.user;
  let level = 0;
  // True the moment the requester's OWN managerAMAccountName is confirmed
  // non-null — i.e., a real chain exists to walk at all. "no_manager" is
  // reserved EXCLUSIVELY for this flag staying false (the requester's own
  // record verifies they have no manager, full stop) — never for a real
  // chain that simply yields zero ELIGIBLE (active-TicketApp-account)
  // candidates along the way, which is a distinct, blocking "unresolved"
  // outcome (see the end of this function) — a verified manager existing
  // with nobody currently able to act on it must never be silently treated
  // as if no manager existed, since that would skip a real, required
  // approval step.
  let hasManagerChain = false;

  while (true) {
    level++;
    if (level > MAX_MANAGER_CHAIN_DEPTH) {
      return { status: "unresolved", reason: "Your SQLGeneral manager chain is unexpectedly deep — cannot be safely verified." };
    }

    const managerUsername = current.managerAMAccountName?.trim() || null;
    if (managerUsername === null) break; // a genuine, verified root — the chain is fully, honestly resolved
    hasManagerChain = true;

    if (managerUsername === current.username || visitedUsernames.has(managerUsername)) {
      return { status: "unresolved", reason: "Your SQLGeneral manager chain contains a cycle or self-reference — cannot be safely verified." };
    }

    const managerLookup = await lookupSqlGeneralIdentity(managerUsername);
    if (managerLookup.outcome === "error") return { status: "unresolved", reason: `Could not verify your manager chain against SQLGeneral right now (${managerLookup.reason}).` };
    if (managerLookup.outcome === "not_found") return { status: "unresolved", reason: `A manager in your chain (SQLGeneral identity "${managerUsername}") was not found in current SQLGeneral data.` };
    if (managerLookup.outcome === "ambiguous") return { status: "unresolved", reason: `A manager in your chain (SQLGeneral identity "${managerUsername}") is ambiguous in SQLGeneral data.` };

    visitedUsernames.add(managerUsername);

    const localAttempts = await prisma.sqlGeneralUserSyncAttempt.findMany({
      where: { sqlGeneralUsername: managerUsername },
      select: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    });
    if (localAttempts.length === 1 && localAttempts[0].user.isActive) {
      candidates.push({ id: localAttempts[0].user.id, name: localAttempts[0].user.name, email: localAttempts[0].user.email, level });
    }
    // localAttempts.length === 0 (no TicketApp account), > 1 (claimed by
    // more than one local account), or an inactive account: this ancestor
    // is skipped as a candidate — never a structural failure (their own
    // SQLGeneral identity just above was verified fine) — and the walk
    // continues through them regardless, per this function's own doc
    // comment.

    current = managerLookup.user;
  }

  if (candidates.length === 0) {
    if (!hasManagerChain) return { status: "no_manager" };
    // A real, verified, structurally-sound manager chain exists, but not a
    // single ancestor in it currently has an eligible active TicketApp
    // account — this is NEVER "no_manager" (a real manager genuinely
    // exists; approval cannot be silently skipped just because they
    // haven't been onboarded to TicketApp yet) — block submission closed,
    // same as any other unresolved case.
    return { status: "unresolved", reason: "Your verified SQLGeneral manager chain exists, but none of your managers currently have an active TicketApp account to intermediate-approve this request. Contact an administrator." };
  }
  return { status: "has_candidates", candidates };
}

export type IntermediateApproverResolution =
  | { ok: true; approverIds: string[]; skipIntermediateStage: boolean; skipReason: IntermediateApprovalSkipReason | null }
  | { ok: false; reason: "no_approvers_selected" | "invalid_approver" | "unresolved_manager"; detail?: string };

/**
 * Server-side re-verification of the requester's own selection — never
 * trusted as-is. Re-derives the candidate pool fresh from
 * resolveIntermediateApproverCandidates (never a stale/client-supplied
 * pool):
 *   - `requesterOptedOut` true (the requester ticked "Skip Intermediate
 *     Approval" — available to every requester, no permission) skips the
 *     ENTIRE stage, including the SQLGeneral identity/manager-chain lookup
 *     (never invoked). Any selectedIds still sent are ignored. Recorded as
 *     REQUESTER_OPTED_OUT.
 *   - "unresolved" fails the WHOLE submission — never silently skips the
 *     stage (the requester may explicitly opt out instead).
 *   - "no_manager" requires an EMPTY selection (a non-empty one here is a
 *     forged/stale submission, rejected as invalid_approver) and signals
 *     the stage should be skipped entirely (unchanged behaviour).
 *   - "has_candidates" requires at least one real candidate id selected
 *     (explicit selection, never auto-selected), and every selected id must
 *     be exactly one of the verified candidates — a single forged/stale id
 *     fails the WHOLE submission, never silently dropped or substituted.
 */
export async function resolveIntermediateApprovers(
  requesterId: string,
  selectedIds: string[],
  requesterOptedOut: boolean = false
): Promise<IntermediateApproverResolution> {
  if (requesterOptedOut) {
    return { ok: true, approverIds: [], skipIntermediateStage: true, skipReason: "REQUESTER_OPTED_OUT" };
  }

  const candidateResolution = await resolveIntermediateApproverCandidates(requesterId);
  if (candidateResolution.status === "unresolved") {
    return { ok: false, reason: "unresolved_manager", detail: candidateResolution.reason };
  }
  if (candidateResolution.status === "no_manager") {
    if (selectedIds.length > 0) return { ok: false, reason: "invalid_approver" };
    return { ok: true, approverIds: [], skipIntermediateStage: true, skipReason: "NO_MANAGER" };
  }
  if (selectedIds.length === 0) return { ok: false, reason: "no_approvers_selected" };
  const eligibleIds = new Set(candidateResolution.candidates.map((u) => u.id));
  for (const id of selectedIds) {
    if (!eligibleIds.has(id)) return { ok: false, reason: "invalid_approver" };
  }
  return { ok: true, approverIds: selectedIds, skipIntermediateStage: false, skipReason: null };
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

/**
 * History tab: Approved/Rejected/Imported requests this user was actually
 * involved in (requester, or within their own effective approval scope —
 * for a HISTORICAL_IMPORT row, "their own department" is still exactly
 * the request's own TARGET department, never its Requester Department,
 * which grants nothing here) — never every request in the system.
 * IMPORTED is included deliberately (Phase 3.1): a historical import must
 * stay discoverable in History, same as any other decided request, even
 * though it's never counted as "Approved" anywhere that distinguishes the
 * two (status badges, the Final Approval UI, decideApproval's own
 * PENDING_APPROVAL-only guard) — this bucket is "decided/settled", not
 * "went through the standard approval workflow."
 */
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
    return { status: { in: ["APPROVED", "REJECTED", "IMPORTED"] } };
  }
  const or: Prisma.ProjectRequestWhereInput[] = [
    { requesterId: userId },
    // Any request they were EVER asked to intermediate-approve, regardless
    // of how they decided (or whether another approver's rejection beat
    // them to it) — real involvement, not department-scoped. A
    // HISTORICAL_IMPORT row never has any such row, so this never matches
    // one — it only ever reaches History via requesterId or the
    // departmentId branch below.
    { intermediateApprovers: { some: { approverId: userId } } },
  ];
  if (scope.approveDepartmentIds.length > 0) {
    or.push({ departmentId: { in: scope.approveDepartmentIds } });
  }
  return { status: { in: ["APPROVED", "REJECTED", "IMPORTED"] }, OR: or };
}

/** Detail-page/API visibility — requester, within effective FINAL approval scope for THIS request's own department, OR one of THIS request's own selected intermediate approvers (even though they hold no department-scoped grant at all — their authority is the explicit per-request selection, not a department). Never a broader "any admin-adjacent role" shortcut. */
export async function canViewProjectRequest(
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  // requesterId is null for a HISTORICAL_IMPORT request with an unknown
  // requester — `null === userId` is never true for a real session user,
  // so this naturally, correctly denies the "I am the requester" path for
  // such a row without any special-casing.
  request: { id: string; requesterId: string | null; departmentId: string }
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

// ─── Canonical stage machine ────────────────────────────────────────────────

/**
 * THE canonical Project Request stage machine — the only place that decides
 * which status a STANDARD request moves to. Each request carries two
 * requirements fixed at submission: Intermediate Approval (required unless
 * the requester opted out / has no manager — intermediateApprovalSkipReason)
 * and Final Approval (required unless finalApprovalSkipped). A skipped stage
 * is simply never entered — it is NOT an approval: no approver, decision or
 * timestamp is ever recorded for it.
 *
 *   Intermediate | Final    | Path
 *   required     | required | PENDING_INTERMEDIATE_APPROVAL -> PENDING_APPROVAL -> APPROVED
 *   skipped      | required | PENDING_APPROVAL -> APPROVED
 *   required     | skipped  | PENDING_INTERMEDIATE_APPROVAL -> APPROVED
 *   skipped      | skipped  | APPROVED (at submission)
 *
 * Rejection at any ENABLED stage is terminal (REJECTED) — unchanged, handled
 * by decideIntermediateApproval / decideApproval.
 */
export function nextProjectRequestStatus(
  event: "submitted" | "intermediate_completed",
  requirements: { intermediateRequired: boolean; finalRequired: boolean }
): ProjectRequestStatus {
  if (event === "submitted" && requirements.intermediateRequired) return "PENDING_INTERMEDIATE_APPROVAL";
  return requirements.finalRequired ? "PENDING_APPROVAL" : "APPROVED";
}

// ─── Approval transition ────────────────────────────────────────────────────

export type ApprovalActionError =
  | { code: "not_found" }
  | { code: "forbidden" }
  | { code: "invalid_status"; currentStatus: ProjectRequestStatus }
  | { code: "invalid_assessment" }
  // Phase 3 — an explicit, independent invariant check (never relying
  // solely on the incidental fact that a HISTORICAL_IMPORT row can never
  // actually reach PENDING_APPROVAL/have a PENDING intermediate row) that
  // this normal-workflow action was attempted against a source !==
  // STANDARD request. See ProjectRequestSource's own doc comment.
  | { code: "not_standard_request" };

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
 * approver's OWN OPTIONAL justification for this specific decision —
 * re-normalized here (trimmed, empty -> null, length-capped) rather than
 * trusting the route's zod check alone, since this is the actual
 * persistence boundary. Guarded atomically by the CURRENT status in the same
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
  businessAssessment?: string | null
): Promise<ApprovalActionResult> {
  const trimmedAssessment = businessAssessment?.trim() || null;
  if (trimmedAssessment && trimmedAssessment.length > MAX_BUSINESS_ASSESSMENT_LENGTH) {
    return { ok: false, error: { code: "invalid_assessment" } };
  }

  const existing = await prisma.projectRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, status: true, departmentId: true, requesterId: true, source: true, finalApprovalSkipped: true },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };
  // Explicit invariant: this entire normal-workflow action is reserved for
  // STANDARD requests. Checked independently of status (which already
  // makes this unreachable for a HISTORICAL_IMPORT row today, since it's
  // created directly at APPROVED) — see ApprovalActionError's own doc
  // comment on this code.
  if (existing.source !== "STANDARD") return { ok: false, error: { code: "not_standard_request" } };
  if (existing.status !== "PENDING_APPROVAL") return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  // Defense in depth: a request whose Final Approval was skipped never enters
  // PENDING_APPROVAL (see nextProjectRequestStatus) and must never get a
  // final decision recorded.
  if (existing.finalApprovalSkipped) return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  // A STANDARD request always has a real requester, set from the
  // authenticated session at submission (POST /api/project-requests) and
  // never cleared afterward — this is never actually null in practice; a
  // thrown error here (rather than a quiet fallback) is deliberate: it
  // would mean this invariant was somehow violated elsewhere.
  if (!existing.requesterId) throw new Error(`STANDARD ProjectRequest ${existing.id} has no requesterId — data integrity violation`);
  const requesterId = existing.requesterId;

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
        userId: requesterId,
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
  // The chosen destination Workspace isn't one where the user may create
  // Projects (see the destination check in createProjectFromApprovedRequest).
  | { code: "forbidden_destination" }
  | { code: "invalid_status"; currentStatus: ProjectRequestStatus }
  // Phase 3 — same explicit, independent invariant check as
  // ApprovalActionError's own "not_standard_request" (see its doc
  // comment). A HISTORICAL_IMPORT request already has its Project linked
  // at creation time, so this is also unreachable in practice via the
  // `if (existing.project)` short-circuit below — this is the second,
  // explicit guard, not the only one.
  | { code: "not_standard_request" }
  | { code: "invalid_project_owner" }
  | { code: "invalid_audience" }
  | { code: "invalid_audience_department" }
  | { code: "invalid_audience_business_unit" }
  | { code: "audience_business_units_not_allowed" }
  | { code: "invalid_responsible_people" }
  | { code: "invalid_expense_type" }
  | { code: "invalid_sub_department" }
  | { code: "invalid_member" }
  | { code: "facilities_fields_not_allowed" }
  | { code: "facilities_quarter_fields_incomplete"; field: "start" | "end" }
  | { code: "facilities_invalid_date_range" };

// resolveSystemWideActiveUserIds (Owner(s)/Audience — "any active user in
// the entire system") now lives in lib/services/project-audience-service.ts
// (imported above) — relocated there in Phase 1.1 once manual Project
// creation/edit needed the exact same validation for individual Audience.

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
  data: import("@/lib/validations").CreateProjectFromRequestInput & Partial<import("@/lib/validations").FacilitiesProjectFieldsInput>
): Promise<CreateProjectFromRequestResult> {
  const existing = await prisma.projectRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, departmentId: true, approverId: true, source: true, project: { select: { id: true } } },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };
  // Explicit invariant — same reasoning as decideApproval's own check.
  // Placed BEFORE the `existing.project` short-circuit below so a
  // HISTORICAL_IMPORT request (whose Project is already linked at
  // creation time) never resolves as a quiet "alreadyExisted: true" no-op
  // through this normal-workflow entry point — it fails explicitly instead.
  if (existing.source !== "STANDARD") return { ok: false, error: { code: "not_standard_request" } };
  if (existing.status !== "APPROVED") return { ok: false, error: { code: "invalid_status", currentStatus: existing.status } };
  const allowed = await hasEffectiveEntityPermission(userId, role, customRoleId, existing.departmentId, APPROVE_PERMISSION_KEY);
  if (!allowed) return { ok: false, error: { code: "forbidden" } };

  // Destination Workspace. SOURCE authority is unchanged: projectRequest.approve
  // in the request's own department (checked just above). The request's own
  // department is always a valid destination (the previous behaviour, which
  // deliberately never required a separate project.create there). A
  // DIFFERENT destination additionally requires the standard Project-creation
  // right there — exactly the Workspaces the New Project picker offers
  // (getAccessibleDepartmentSummaries(…, "project.create"): active
  // departments; ADMIN all). The Project Request itself is never modified,
  // and no approval step is repeated.
  const destinationDepartmentId = data.departmentId ?? existing.departmentId;
  if (destinationDepartmentId !== existing.departmentId) {
    const eligible = await getAccessibleDepartmentSummaries(userId, role, "project.create");
    if (!eligible.some((d) => d.id === destinationDepartmentId)) return { ok: false, error: { code: "forbidden_destination" } };
  }

  if (existing.project) {
    return { ok: true, projectId: existing.project.id, alreadyExisted: true };
  }

  // Facilities Services-only metadata — the department here is ALWAYS the
  // Project Request's own, server-resolved, never client-chosen (see this
  // route's own doc comment) — still re-checked against the real
  // department identity (never display-name matching), same as every
  // other creation path.
  const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
  const isFacilitiesWorkspace = !!facilitiesServicesDepartmentId && destinationDepartmentId === facilitiesServicesDepartmentId;
  if (!isFacilitiesWorkspace && hasFacilitiesFieldsPresent(data as Record<string, unknown>)) {
    return { ok: false, error: { code: "facilities_fields_not_allowed" } };
  }
  let facilitiesWrite: ResolvedFacilitiesWrite | null = null;
  if (isFacilitiesWorkspace) {
    const resolution = resolveFacilitiesWrite({
      startPrecision: data.facilitiesStartPrecision ?? null,
      startQuarter: data.facilitiesStartQuarter ?? null,
      startYear: data.facilitiesStartYear ?? null,
      startExact: data.startDate ?? null,
      endPrecision: data.facilitiesEndPrecision ?? null,
      endQuarter: data.facilitiesEndQuarter ?? null,
      endYear: data.facilitiesEndYear ?? null,
      endExact: data.endDate ?? null,
    });
    if (!resolution.ok) {
      return {
        ok: false,
        error:
          resolution.error.code === "quarter_fields_incomplete"
            ? { code: "facilities_quarter_fields_incomplete", field: resolution.error.field }
            : { code: "facilities_invalid_date_range" },
      };
    }
    facilitiesWrite = resolution.value;
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

  // Organizational Audience (Phase 1) — available here too, same as plain
  // manual Project creation (see POST /api/projects). Every id re-verified
  // against real, existing (and for Departments, active) rows.
  // Business Unit Audience is never accepted on this path (see
  // createProjectFromRequestSchema) — re-asserted here at the persistence
  // boundary so no other caller of this function can connect one either.
  if (data.audienceBusinessUnitIds && data.audienceBusinessUnitIds.length > 0) {
    return { ok: false, error: { code: "audience_business_units_not_allowed" } };
  }
  const audienceOrgResolution = await resolveProjectAudienceOrganizationalIds(data.audienceDepartmentIds ?? [], []);
  if (!audienceOrgResolution.ok) return { ok: false, error: { code: audienceOrgResolution.code } };

  // Responsible People (Phase 2) — available here too, same as plain
  // manual Project creation (see POST /api/projects). Its own separate
  // relation, never connected into `audience`.
  const responsiblePeopleIds = await resolveSystemWideActiveUserIds(data.responsiblePeopleIds ?? []);
  if (responsiblePeopleIds === null) return { ok: false, error: { code: "invalid_responsible_people" } };

  const expenseType = await prisma.projectExpenseType.findUnique({ where: { id: data.expenseTypeId }, select: { id: true, isActive: true } });
  if (!expenseType || !expenseType.isActive) return { ok: false, error: { code: "invalid_expense_type" } };

  if (data.subDepartmentId) {
    const valid = await validateSubDepartmentInDepartment(data.subDepartmentId, destinationDepartmentId);
    if (!valid) return { ok: false, error: { code: "invalid_sub_department" } };
  }

  if (data.memberIds.length > 0) {
    for (const memberId of data.memberIds) {
      const assignable = await userHasAssignablePermissionForEntity(memberId, "project", destinationDepartmentId);
      if (!assignable) return { ok: false, error: { code: "invalid_member" } };
    }
  }

  // Both durations resolved server-side through the ONE canonical resolver
  // (lib/project-duration.ts): calculated from their dates unless the
  // creator supplied an explicit manual override. The client only previews
  // the same calculation; a raw duration value is never accepted.
  const expectedDuration = resolveProjectDuration({
    start: data.expectedStartDate,
    finish: data.expectedFinishDate,
    override: data.expectedTotalInitialDaysOverride ?? undefined,
  });
  const actualDuration = resolveProjectDuration({
    start: facilitiesWrite ? facilitiesWrite.startDate : data.startDate,
    finish: facilitiesWrite ? facilitiesWrite.endDate : data.endDate,
    override: data.actualTotalDaysOverride ?? undefined,
  });

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
        departmentId: destinationDepartmentId,
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
        audienceDepartments: audienceOrgResolution.departmentIds.length ? { connect: audienceOrgResolution.departmentIds.map((id) => ({ id })) } : undefined,
        responsiblePeople: responsiblePeopleIds.length ? { connect: responsiblePeopleIds.map((id) => ({ id })) } : undefined,
        // Facilities Services: the resolved write wins (derived from
        // either Quarter or Exact). Every other workspace: the exact,
        // unmodified pre-existing behavior.
        ...(facilitiesWrite
          ? {
              ...facilitiesWrite,
              facilitiesCompany: data.facilitiesCompany ?? undefined,
              facilitiesLocation: data.facilitiesLocation ?? undefined,
              facilitiesCategory: data.facilitiesCategory ?? undefined,
              facilitiesEstimatedCost: data.facilitiesEstimatedCost ?? undefined,
              facilitiesEstimatedCostNotes: data.facilitiesEstimatedCostNotes ?? undefined,
              facilitiesActualCost: data.facilitiesActualCost ?? undefined,
              facilitiesActualCostNotes: data.facilitiesActualCostNotes ?? undefined,
              facilitiesPlannedForAnnualTargets: data.facilitiesPlannedForAnnualTargets ?? undefined,
              facilitiesIsBigProject: data.facilitiesIsBigProject ?? undefined,
            }
          : {
              startDate: data.startDate ? new Date(data.startDate) : undefined,
              endDate: data.endDate ? new Date(data.endDate) : undefined,
            }),
        successTarget: data.successTarget,
        isGoal: data.isGoal,
        members: data.memberIds.length ? { connect: data.memberIds.map((id) => ({ id })) } : undefined,
        projectRequestId: requestId,
        expectedStartDate: new Date(data.expectedStartDate),
        expectedFinishDate: new Date(data.expectedFinishDate),
        expectedTotalInitialDays: expectedDuration.value,
        expectedTotalInitialDaysOverridden: expectedDuration.overridden,
        actualTotalDays: actualDuration.value,
        actualTotalDaysOverridden: actualDuration.overridden,
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
    select: { id: true, title: true, status: true, departmentId: true, requesterId: true, source: true, finalApprovalSkipped: true },
  });
  if (!existing) return { ok: false, error: { code: "not_found" } };
  // Explicit invariant — see decideApproval's identical check and
  // ApprovalActionError's own doc comment on this code. Independent of
  // status (which already makes this unreachable for a HISTORICAL_IMPORT
  // row today, since it never has any ProjectRequestIntermediateApprover
  // rows for `myRow` below to find at all).
  if (existing.source !== "STANDARD") return { ok: false, error: { code: "not_standard_request" } };
  // A STANDARD request always has a real requester (see decideApproval's
  // identical assertion) — a thrown error here is deliberate, not a quiet
  // fallback.
  if (!existing.requesterId) throw new Error(`STANDARD ProjectRequest ${existing.id} has no requesterId — data integrity violation`);
  const requesterId = existing.requesterId;

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
  let approvedWithoutFinalStage = false;
  let approvedNotificationRow: { id: string; userId: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: Date } | null = null;

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
            userId: requesterId,
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
      // Canonical stage machine: Final Approval next, or — when it was
      // skipped at submission — APPROVED directly (no final decision is
      // fabricated: approverId/approvedAt stay null).
      const nextStatus = nextProjectRequestStatus("intermediate_completed", { intermediateRequired: true, finalRequired: !existing.finalApprovalSkipped });
      const parentUpdate = await tx.projectRequest.updateMany({
        where: { id: requestId, status: "PENDING_INTERMEDIATE_APPROVAL" },
        data: { status: nextStatus },
      });
      if (parentUpdate.count > 0) {
        justCompletedUnanimously = true;
        if (nextStatus === "APPROVED") {
          approvedWithoutFinalStage = true;
          await scheduleSetupReminderInTx(tx, requestId, now);
          approvedNotificationRow = await tx.notification.create({
            data: {
              userId: requesterId,
              title: "Project Request approved",
              body: `Your Project Request "${existing.title}" was approved (Final Approval was skipped at submission).`,
              link: `/project-requests/${requestId}`,
            },
          });
        }
      }
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
  if (approvedNotificationRow) {
    await dispatchCreatedNotification(approvedNotificationRow);
  }
  // Final approvers are asked to act ONLY when Final Approval is actually
  // the next stage — never for a skipped one.
  if (justCompletedUnanimously && !approvedWithoutFinalStage) {
    await notifyEligibleApproversOfSubmission(existing.departmentId, requestId, existing.title);
  }
  // Final Approval was skipped: the request is APPROVED now — tell the users
  // who can create its Project (exactly once, from this transition only).
  if (approvedWithoutFinalStage) {
    await notifyEligibleApproversReadyForProjectCreation(existing.departmentId, requestId, existing.title);
  }

  return { ok: true };
}
