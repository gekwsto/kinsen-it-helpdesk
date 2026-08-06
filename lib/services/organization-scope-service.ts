/**
 * Visibility rules for the organization tree/visualization — a thin layer
 * over the existing permission system (lib/permissions.ts), not a parallel
 * one. Full-tree access reuses `canViewAllDepartments` (the same
 * Admin/Director bypass every other cross-department view already uses) OR
 * the new `organization.tree.view` permission key for a custom role. Every
 * OTHER authenticated user gets their own baseline slice — own department,
 * own manager, own upward management chain, own direct reports — with no
 * extra permission required, mirroring this app's existing "my tickets"/
 * "my activities" self-scoping convention (never an empty response for a
 * logged-in user with no special grant).
 */
import { Role } from "@prisma/client";
import { canViewAllDepartments, hasPermission } from "@/lib/permissions";
import {
  getDepartmentTree,
  getOrganizationContext,
  type DepartmentTreeNode,
  type PeopleTreeNode,
} from "@/lib/services/organization-tree-service";
import { prisma } from "@/lib/prisma";

export async function canViewFullOrganizationTree(role: Role, customRoleId?: string | null): Promise<boolean> {
  if (canViewAllDepartments(role)) return true;
  return hasPermission(role, "organization.tree.view", customRoleId);
}

export async function canTriggerOrganizationSync(role: Role, customRoleId?: string | null): Promise<boolean> {
  return hasPermission(role, "organization.sync", customRoleId);
}

/** Finds the root-to-self path through an already-assembled department tree — returns [] if the department isn't in the tree (e.g. inactive and pruned, or the user has no department at all). */
function findDepartmentPath(nodes: DepartmentTreeNode[], departmentId: string): DepartmentTreeNode[] | null {
  for (const node of nodes) {
    if (node.id === departmentId && node.type === "department") return [node];
    const childPath = findDepartmentPath(node.children, departmentId);
    if (childPath) return [node, ...childPath];
  }
  return null;
}

/**
 * Own-slice view of the DEPARTMENT tree for a user without full-tree access:
 * just the ancestor chain (Company -> BusinessUnit -> ... -> own Department),
 * each ancestor's `children` trimmed to only the next node in the path (so
 * the response never leaks sibling departments the caller isn't permitted to
 * see) — but the user's OWN department node keeps its real children
 * (subdepartments), since those are the caller's own org unit.
 */
export async function getOwnDepartmentTreeSlice(userId: string): Promise<DepartmentTreeNode[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } });
  if (!user?.departmentId) return [];

  const fullTree = await getDepartmentTree({ activeOnly: false });
  const path = findDepartmentPath(fullTree, user.departmentId);
  if (!path) return [];

  // Rebuild the path top-down, replacing every ancestor's children with
  // just [nextInPath] — the leaf (own department) keeps its real children.
  let rebuilt: DepartmentTreeNode | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    rebuilt = { ...node, children: rebuilt ? [rebuilt] : node.children };
  }
  return rebuilt ? [rebuilt] : [];
}

const MAX_CHAIN_DEPTH = 50;

/**
 * Own-slice view of the PEOPLE tree: a single linear path from the caller's
 * topmost visible ancestor down to the caller, with the caller's own direct
 * reports attached as real children — every ancestor above the caller shows
 * only the single next node in the chain (never a sibling's whole team).
 */
export async function getOwnPeopleTreeSlice(userId: string): Promise<PeopleTreeNode[]> {
  const self = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, jobTitle: true, email: true, isActive: true, managerId: true, department: { select: { id: true, name: true } } },
  });
  if (!self) return [];

  const directReports = await prisma.user.findMany({
    where: { managerId: userId },
    select: { id: true, name: true, jobTitle: true, email: true, isActive: true, department: { select: { id: true, name: true } } },
  });

  let selfNode: PeopleTreeNode = {
    id: self.id,
    displayName: self.name,
    jobTitle: self.jobTitle,
    department: self.department,
    email: self.email,
    isActive: self.isActive,
    directReportsCount: directReports.length,
    children: directReports.map((r) => ({
      id: r.id,
      displayName: r.name,
      jobTitle: r.jobTitle,
      department: r.department,
      email: r.email,
      isActive: r.isActive,
      directReportsCount: 0, // one level down only — own-slice, not the reports' own reports
      children: [],
    })),
  };

  const visited = new Set<string>([self.id]);
  let currentManagerId = self.managerId;
  let depth = 0;
  while (currentManagerId && depth < MAX_CHAIN_DEPTH) {
    if (visited.has(currentManagerId)) break; // cycle guard
    visited.add(currentManagerId);
    const managerRow = await prisma.user.findUnique({
      where: { id: currentManagerId },
      select: { id: true, name: true, jobTitle: true, email: true, isActive: true, managerId: true, department: { select: { id: true, name: true } } },
    });
    if (!managerRow) break;
    selfNode = {
      id: managerRow.id,
      displayName: managerRow.name,
      jobTitle: managerRow.jobTitle,
      department: managerRow.department,
      email: managerRow.email,
      isActive: managerRow.isActive,
      directReportsCount: 1, // own-slice: only the single next-in-chain node is shown as a "report" here
      children: [selfNode],
    };
    currentManagerId = managerRow.managerId;
    depth++;
  }

  return [selfNode];
}

export { getOrganizationContext };
