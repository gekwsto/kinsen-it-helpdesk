/**
 * Project Workspace transfer — THE canonical mechanism for moving a Project
 * (and everything that belongs to its work breakdown) to another Workspace.
 * Used by PATCH /api/projects/[id] whenever `departmentId` changes; the
 * Project update and the Activity transfer run in ONE database transaction
 * (all-or-nothing).
 *
 * Approved business rules:
 *  - The Project and ALL of its linked Activities (any status, completed
 *    included) move to the destination department.
 *  - Sub-department references are cleared ONLY where invalid in the
 *    destination (a sub-department always belongs to exactly one
 *    department). The Project's own sub-department is handled by the PATCH
 *    route (cleared unless a valid destination sub-department is supplied).
 *  - Linked Tickets stay in their own departments; their project/activity
 *    links are preserved untouched (Ticket links are only re-validated when
 *    a Ticket's own link is edited — see PATCH /api/tickets/[id]).
 *  - Owners, Members, Responsible People, Activity assignees and every
 *    Audience selection are preserved as-is: no user is removed, and no
 *    Workspace membership or permission is granted. Assignability is
 *    enforced only for NEWLY added Members/Assignees (the PATCH routes).
 *  - Statuses, dates, Expected/Actual Days, cost snapshots, comments,
 *    attachments and dependencies are not touched (only departmentId /
 *    invalid subDepartmentId columns change). The Project Request and its
 *    approval history are never touched.
 *
 * Authorization (enforced by the caller before the transaction):
 *  - SOURCE: project.edit in the Project's current department (the PATCH
 *    route's existing gate).
 *  - DESTINATION: canTransferProjectToDepartment — the PREVIOUS Project
 *    department-move rule, unchanged: ADMIN may move to any department;
 *    everyone else (DIRECTOR included — no "view all departments" bypass
 *    here) needs an active membership in the destination whose role grants
 *    project.create. (Project Setup keeps its own, separately approved
 *    destination rule — see createProjectFromApprovedRequest.)
 */
import { Role, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasDepartmentPermission } from "@/lib/permissions";
import { getMembership, getUserDepartmentMemberships } from "@/lib/services/department-membership-service";
import { listDepartments } from "@/lib/services/department-service";

/** Destination eligibility — the previous Project department-move rule (ADMIN exception; otherwise target membership with project.create). */
export async function canTransferProjectToDepartment(userId: string, role: Role, destinationDepartmentId: string): Promise<boolean> {
  if (role === Role.ADMIN) {
    // The existing ADMIN exception (no membership needed); the existence
    // check only turns an unknown id into a clean 403 instead of a DB error.
    return !!(await prisma.department.findUnique({ where: { id: destinationDepartmentId }, select: { id: true } }));
  }
  const targetMembership = await getMembership(userId, destinationDepartmentId);
  return targetMembership ? hasDepartmentPermission(targetMembership.role, "project.create", targetMembership.customRoleId) : false;
}

/** Workspace options for the Project Edit picker: the current Workspace + every destination canTransferProjectToDepartment allows. */
export async function getProjectWorkspaceOptions(userId: string, role: Role, currentDepartment: { id: string; name: string } | null): Promise<{ id: string; name: string }[]> {
  let options: { id: string; name: string }[];
  if (role === Role.ADMIN) {
    options = (await listDepartments()).map((d) => ({ id: d.id, name: d.name }));
  } else {
    options = [];
    for (const m of await getUserDepartmentMemberships(userId)) {
      if (await hasDepartmentPermission(m.role, "project.create", m.customRoleId)) options.push({ id: m.department.id, name: m.department.name });
    }
  }
  if (currentDepartment && !options.some((d) => d.id === currentDepartment.id)) options.unshift({ id: currentDepartment.id, name: currentDepartment.name });
  return options;
}

/** Counts shown in the confirmation dialog before a transfer. */
export async function getProjectWorkspaceTransferPreview(projectId: string): Promise<{ activityCount: number; linkedTicketCount: number }> {
  const [activityCount, linkedTicketCount] = await Promise.all([
    prisma.projectActivity.count({ where: { projectId } }),
    prisma.ticket.count({ where: { projectId } }),
  ]);
  return { activityCount, linkedTicketCount };
}

export interface ActivityTransferResult {
  transferredActivityIds: string[];
  clearedSubDepartmentActivityIds: string[];
}

/**
 * Moves every Activity of `projectId` to `destinationDepartmentId` inside
 * the caller's transaction, clearing only sub-department references that
 * are invalid in the destination. Touches no other column.
 */
export async function transferProjectActivitiesInTransaction(
  tx: Prisma.TransactionClient,
  projectId: string,
  destinationDepartmentId: string
): Promise<ActivityTransferResult> {
  const activities = await tx.projectActivity.findMany({
    where: { projectId },
    select: { id: true, subDepartmentId: true, subDepartment: { select: { departmentId: true } } },
  });
  const invalidSubDepartment = activities
    .filter((a) => a.subDepartmentId !== null && a.subDepartment?.departmentId !== destinationDepartmentId)
    .map((a) => a.id);
  if (invalidSubDepartment.length > 0) {
    await tx.projectActivity.updateMany({ where: { id: { in: invalidSubDepartment } }, data: { subDepartmentId: null } });
  }
  if (activities.length > 0) {
    await tx.projectActivity.updateMany({ where: { projectId }, data: { departmentId: destinationDepartmentId } });
  }
  return { transferredActivityIds: activities.map((a) => a.id), clearedSubDepartmentActivityIds: invalidSubDepartment };
}
