import { prisma } from "@/lib/prisma";
import { getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { hasPermission, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { listAccessibleWorkspaces, isAccessibleDepartment } from "@/lib/services/workspace-service";
import { DEPARTMENT_ROLE_OPTIONS } from "@/lib/services/department-role-translation";
import { ALL_WORKSPACES_VALUE } from "@/types/department";
import { createInAppNotification, dispatchCreatedNotification } from "@/lib/notifications/create-notification";
import { Role, DepartmentRole, type ProjectRequestStatus, type Prisma } from "@prisma/client";

const APPROVE_PERMISSION_KEY = "projectRequest.approve";

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

/** Every roleKey (DepartmentRole strings, global Role enum values, or custom-role keys) currently granting `projectRequest.approve` — a real RolePermission catalogue lookup, never the runtime ADMIN bypass (so this also correctly reflects ADMIN's own explicit, migrated grant row). */
async function getRoleKeysWithApprovePermission() {
  const rows = await prisma.rolePermission.findMany({
    where: { permission: { key: APPROVE_PERMISSION_KEY } },
    select: { roleKey: true },
  });
  const roleKeys = rows.map((r) => r.roleKey);
  const departmentRoleValues = new Set<string>(DEPARTMENT_ROLE_OPTIONS as string[]);
  const globalRoleValues = new Set<string>(Object.values(Role));
  return {
    // DEPARTMENT_MANAGER is intentionally reachable via both sets — it's a
    // single shared roleKey for the global Role and DepartmentRole enum
    // values (see prisma/seed.ts's own comment on this).
    departmentRoles: roleKeys.filter((k): k is DepartmentRole => departmentRoleValues.has(k)),
    globalRoles: roleKeys.filter((k): k is Role => globalRoleValues.has(k)),
    // Every roleKey, including admin-created custom-role keys that aren't a
    // Role/DepartmentRole enum member at all — matched against
    // User.customRole.key / DepartmentMembership.customRole.key.
    allRoleKeys: roleKeys,
  };
}

/**
 * Every ACTIVE user who effectively holds `projectRequest.approve` for
 * `departmentId` — a broad, cheap SQL prefilter by roleKey (never misses
 * anyone) followed by the exact hasEffectiveEntityPermission check per
 * candidate (never over-includes), same two-phase shape as
 * lib/services/assignment-eligibility-service.ts's getAssignableUsersForEntity.
 * Used both for the submission-time notification fan-out and could be
 * reused anywhere else "who can approve this" needs a real user list.
 */
export async function getEligibleApproverUserIds(departmentId: string): Promise<string[]> {
  const { departmentRoles, globalRoles, allRoleKeys } = await getRoleKeysWithApprovePermission();

  const orConditions: Record<string, unknown>[] = [];
  if (globalRoles.length > 0) orConditions.push({ role: { in: globalRoles } });
  if (allRoleKeys.length > 0) orConditions.push({ customRole: { key: { in: allRoleKeys } } });
  if (departmentRoles.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId, isActive: true, role: { in: departmentRoles } } } });
  }
  if (allRoleKeys.length > 0) {
    orConditions.push({ departmentMemberships: { some: { departmentId, isActive: true, customRole: { key: { in: allRoleKeys } } } } });
  }
  if (orConditions.length === 0) return [];

  const candidates = await prisma.user.findMany({
    where: { isActive: true, OR: orConditions },
    select: { id: true, role: true, customRoleId: true },
  });

  const eligible: string[] = [];
  for (const candidate of candidates) {
    if (await hasEffectiveEntityPermission(candidate.id, candidate.role, candidate.customRoleId, departmentId, APPROVE_PERMISSION_KEY)) {
      eligible.push(candidate.id);
    }
  }
  return eligible;
}

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
  const or: Prisma.ProjectRequestWhereInput[] = [{ requesterId: userId }];
  if (scope.approveDepartmentIds.length > 0) {
    or.push({ departmentId: { in: scope.approveDepartmentIds } });
  }
  return { status: { in: ["APPROVED", "REJECTED"] }, OR: or };
}

/** Detail-page/API visibility — requester, or within effective approval scope for THIS request's own department. Never a broader "any admin-adjacent role" shortcut. */
export async function canViewProjectRequest(
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  request: { requesterId: string; departmentId: string }
): Promise<boolean> {
  if (request.requesterId === userId) return true;
  return hasEffectiveEntityPermission(userId, role, customRoleId, request.departmentId, APPROVE_PERMISSION_KEY);
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
  });

  if (!notificationRow) {
    const nowState = await prisma.projectRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    return { ok: false, error: { code: "invalid_status", currentStatus: nowState?.status ?? existing.status } };
  }

  await dispatchCreatedNotification(notificationRow);
  return { ok: true };
}
