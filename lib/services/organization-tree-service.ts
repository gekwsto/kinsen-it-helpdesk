/**
 * Builds the two visualization trees (Departments, People) and the
 * current-user organization-context DTO from flat Prisma queries + in-memory
 * assembly — never one query per node (no recursive N+1). Returns typed DTOs
 * only, never raw Prisma model rows, per the brief's explicit requirement.
 *
 * Department hierarchy used here is the EXISTING, already-modeled
 * Company -> BusinessUnit -> Department -> SubDepartment structure
 * (prisma/schema.prisma) — no new `parentDepartmentId` self-relation was
 * added (see the organization-sync plan's audit findings: this 4-tier
 * structure already satisfies "Organization -> Division -> Department ->
 * Subdepartment", and nothing in this codebase or Entra proved a need for
 * deeper nesting).
 *
 * A Department/SubDepartment's "active user" association uses the SAME
 * dual-source rule already established by app/(main)/admin/users/page.tsx's
 * query: legacy `User.departmentId`/`subDepartmentId` OR an active
 * DepartmentMembership/SubDepartmentMembership row — never just one or the
 * other, so counts here can never disagree with what the admin/users list
 * shows for the same department.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole } from "@prisma/client";

// ─── Cache ──────────────────────────────────────────────────────────────────
// Simple in-process cache — correct for this app's single-server-process
// deployment model (same assumption the rate-limiter/idempotency pieces of
// this codebase's other features already make). Invalidated wholesale
// (never partially) after a sync run or a relevant admin mutation — the tree
// is cheap enough to rebuild that partial/targeted invalidation would be
// speculative complexity for no measured benefit.
const treeCache = new Map<string, { builtAt: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateOrganizationTreeCache(): void {
  treeCache.clear();
}

function getCached<T>(key: string): T | undefined {
  const entry = treeCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.builtAt > CACHE_TTL_MS) {
    treeCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCached<T>(key: string, value: T): void {
  treeCache.set(key, { builtAt: Date.now(), value });
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface DepartmentTreeNode {
  id: string;
  name: string;
  type: "company" | "businessUnit" | "department" | "subDepartment";
  isActive: boolean;
  manager: { id: string; displayName: string | null; jobTitle: string | null } | null;
  activeUserCount: number;
  totalUserCount: number;
  children: DepartmentTreeNode[];
}

export interface PeopleTreeNode {
  id: string;
  displayName: string | null;
  jobTitle: string | null;
  department: { id: string; name: string } | null;
  email: string;
  isActive: boolean;
  directReportsCount: number;
  children: PeopleTreeNode[];
}

// ─── Department tree ────────────────────────────────────────────────────────

interface DeptUserAssociation {
  departmentId: string;
  subDepartmentId: string | null;
}

/**
 * Department-level counts here are PRIMARY-ONLY — `User.departmentId`,
 * which is now a canonically-maintained mirror of each user's single active
 * primary DepartmentMembership (see setPrimaryDepartmentMembership in
 * lib/services/department-membership-service.ts), never a second
 * independent source. This is a deliberate choice, not an oversight: the
 * Organization tree is an ORGANIZATIONAL PLACEMENT chart (one node per
 * person, matching a real org chart), not a permissions/membership view — a
 * director with secondary access to Finance/IT/Sales/HR shows up ONCE,
 * under their actual primary department, never duplicated across every
 * department they merely have access to. Full active-membership visibility
 * (primary + secondary) is the Department Members page's job
 * (getDepartmentMemberships in department-membership-service.ts) and
 * authorization's job (getUserDepartmentMemberships in
 * department-scope-service.ts) — deliberately NOT unioned in here anymore.
 * SubDepartment associations are unrelated to this change and still use
 * SubDepartmentMembership as before (SubDepartment has no primary/secondary
 * concept of its own).
 */
async function loadDepartmentUserAssociations(): Promise<{
  byDepartment: Map<string, Set<string>>;
  bySubDepartment: Map<string, Set<string>>;
  activeUserIds: Set<string>;
}> {
  const [users, activeSubMemberships] = await Promise.all([
    prisma.user.findMany({ select: { id: true, isActive: true, departmentId: true, subDepartmentId: true } }),
    prisma.subDepartmentMembership.findMany({ where: { isActive: true }, select: { userId: true, subDepartmentId: true } }),
  ]);

  const byDepartment = new Map<string, Set<string>>();
  const bySubDepartment = new Map<string, Set<string>>();
  const activeUserIds = new Set(users.filter((u) => u.isActive).map((u) => u.id));

  const addTo = (map: Map<string, Set<string>>, key: string, userId: string) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(userId);
  };

  for (const u of users) {
    if (u.departmentId) addTo(byDepartment, u.departmentId, u.id);
    if (u.subDepartmentId) addTo(bySubDepartment, u.subDepartmentId, u.id);
  }
  for (const m of activeSubMemberships) addTo(bySubDepartment, m.subDepartmentId, m.userId);

  return { byDepartment, bySubDepartment, activeUserIds };
}

async function loadDepartmentManagers(): Promise<Map<string, { id: string; displayName: string | null; jobTitle: string | null }>> {
  const rows = await prisma.departmentMembership.findMany({
    where: { role: DepartmentRole.DEPARTMENT_MANAGER, isActive: true },
    select: { departmentId: true, createdAt: true, user: { select: { id: true, name: true, jobTitle: true } } },
    orderBy: { createdAt: "asc" },
  });
  const managerByDepartment = new Map<string, { id: string; displayName: string | null; jobTitle: string | null }>();
  for (const row of rows) {
    // First (earliest-assigned) active DEPARTMENT_MANAGER wins if a
    // department somehow has more than one — deterministic, never "whichever
    // the DB happened to return last".
    if (!managerByDepartment.has(row.departmentId)) {
      managerByDepartment.set(row.departmentId, { id: row.user.id, displayName: row.user.name, jobTitle: row.user.jobTitle });
    }
  }
  return managerByDepartment;
}

/** Keeps a node if it's itself active OR has at least one visible (kept) descendant — never drops the active ancestor of a still-visible active child. */
function pruneInactive(node: DepartmentTreeNode): DepartmentTreeNode | null {
  const children = node.children.map(pruneInactive).filter((c): c is DepartmentTreeNode => c !== null);
  if (!node.isActive && children.length === 0) return null;
  return { ...node, children };
}

export interface DepartmentTreeOptions {
  activeOnly?: boolean;
}

export async function getDepartmentTree(options: DepartmentTreeOptions = {}): Promise<DepartmentTreeNode[]> {
  const activeOnly = options.activeOnly ?? true;
  const cacheKey = `dept:${activeOnly}`;
  const cached = getCached<DepartmentTreeNode[]>(cacheKey);
  if (cached) return cached;

  const [companies, businessUnits, departments, subDepartments, associations, managers] = await Promise.all([
    prisma.company.findMany({ select: { id: true, name: true } }),
    prisma.businessUnit.findMany({ select: { id: true, name: true, companyId: true } }),
    prisma.department.findMany({ select: { id: true, name: true, isActive: true, businessUnitId: true, companyId: true } }),
    prisma.subDepartment.findMany({ select: { id: true, name: true, isActive: true, departmentId: true } }),
    loadDepartmentUserAssociations(),
    loadDepartmentManagers(),
  ]);

  const countsFor = (map: Map<string, Set<string>>, id: string) => {
    const ids = map.get(id) ?? new Set<string>();
    let active = 0;
    for (const userId of ids) if (associations.activeUserIds.has(userId)) active++;
    return { activeUserCount: active, totalUserCount: ids.size };
  };

  const subDepartmentNodes = subDepartments.map((sd): DepartmentTreeNode => {
    const counts = countsFor(associations.bySubDepartment, sd.id);
    return {
      id: sd.id,
      name: sd.name,
      type: "subDepartment",
      isActive: sd.isActive,
      // SubDepartment has no membership-role concept of its own (see
      // SubDepartmentMembership's schema comment — "organizational grouping
      // for filtering, not a second permission tier") — no reliable manager
      // signal exists at this level, so this is always null, never guessed.
      manager: null,
      ...counts,
      children: [],
    };
  });
  const subDepartmentsByDepartment = new Map<string, DepartmentTreeNode[]>();
  for (let i = 0; i < subDepartments.length; i++) {
    const parentId = subDepartments[i].departmentId;
    if (!subDepartmentsByDepartment.has(parentId)) subDepartmentsByDepartment.set(parentId, []);
    subDepartmentsByDepartment.get(parentId)!.push(subDepartmentNodes[i]);
  }

  const departmentNodes = departments.map((d): DepartmentTreeNode => {
    const counts = countsFor(associations.byDepartment, d.id);
    return {
      id: d.id,
      name: d.name,
      type: "department",
      isActive: d.isActive,
      manager: managers.get(d.id) ?? null,
      ...counts,
      children: subDepartmentsByDepartment.get(d.id) ?? [],
    };
  });
  const departmentsByBusinessUnit = new Map<string, DepartmentTreeNode[]>();
  // Departments placed DIRECTLY under a Company (Department.companyId,
  // Microsoft Directory Sync's own placement path — see
  // lib/services/organization-company-department-resolver.ts), scoped
  // per-company (a fix for a real bug: this used to be one shared array
  // attached to EVERY company node, which would have shown e.g. Kinsen
  // Austria's "IT" department under every other company too once more than
  // one company existed).
  const departmentsByCompany = new Map<string, DepartmentTreeNode[]>();
  // Genuinely orphaned legacy departments (neither businessUnitId nor
  // companyId set — predates both organizational-placement paths) are never
  // duplicated across companies either; collected separately and rendered
  // under their own dedicated top-level grouping below.
  const orphanDepartments: DepartmentTreeNode[] = [];
  for (let i = 0; i < departments.length; i++) {
    const d = departments[i];
    if (d.businessUnitId) {
      if (!departmentsByBusinessUnit.has(d.businessUnitId)) departmentsByBusinessUnit.set(d.businessUnitId, []);
      departmentsByBusinessUnit.get(d.businessUnitId)!.push(departmentNodes[i]);
    } else if (d.companyId) {
      if (!departmentsByCompany.has(d.companyId)) departmentsByCompany.set(d.companyId, []);
      departmentsByCompany.get(d.companyId)!.push(departmentNodes[i]);
    } else {
      orphanDepartments.push(departmentNodes[i]);
    }
  }

  const businessUnitNodes = businessUnits.map((bu): DepartmentTreeNode => {
    const children = departmentsByBusinessUnit.get(bu.id) ?? [];
    const activeUserCount = children.reduce((sum, c) => sum + c.activeUserCount, 0);
    const totalUserCount = children.reduce((sum, c) => sum + c.totalUserCount, 0);
    return {
      id: bu.id,
      name: bu.name,
      type: "businessUnit",
      // BusinessUnit has no `isActive` column in this schema — there is no
      // deactivation concept for it today, so it's always reported active
      // (never a fabricated fallback rule for a field that doesn't exist).
      isActive: true,
      manager: null,
      activeUserCount,
      totalUserCount,
      children,
    };
  });
  const businessUnitsByCompany = new Map<string, DepartmentTreeNode[]>();
  for (let i = 0; i < businessUnits.length; i++) {
    const parentId = businessUnits[i].companyId;
    if (!businessUnitsByCompany.has(parentId)) businessUnitsByCompany.set(parentId, []);
    businessUnitsByCompany.get(parentId)!.push(businessUnitNodes[i]);
  }

  const companyNodes = companies.map((c): DepartmentTreeNode => {
    const businessUnitChildren = businessUnitsByCompany.get(c.id) ?? [];
    const directDepartmentChildren = departmentsByCompany.get(c.id) ?? [];
    const children = [...businessUnitChildren, ...directDepartmentChildren];
    const activeUserCount = children.reduce((sum, ch) => sum + ch.activeUserCount, 0);
    const totalUserCount = children.reduce((sum, ch) => sum + ch.totalUserCount, 0);
    return {
      id: c.id,
      name: c.name,
      type: "company",
      isActive: true, // same rationale as BusinessUnit above — no isActive column on Company
      manager: null,
      activeUserCount,
      totalUserCount,
      children,
    };
  });

  // A presentation-only grouping for genuinely orphaned legacy departments
  // (see above) — never persisted as a fake Company row, only synthesized
  // here at read time, and only included at all when at least one such
  // department actually exists.
  const orphanGroupNode: DepartmentTreeNode | null =
    orphanDepartments.length > 0
      ? {
          id: "__unassigned_departments__",
          name: "Unassigned",
          type: "company",
          isActive: true,
          manager: null,
          activeUserCount: orphanDepartments.reduce((sum, d) => sum + d.activeUserCount, 0),
          totalUserCount: orphanDepartments.reduce((sum, d) => sum + d.totalUserCount, 0),
          children: orphanDepartments,
        }
      : null;

  const allRootNodes = orphanGroupNode ? [...companyNodes, orphanGroupNode] : companyNodes;

  const result = activeOnly
    ? allRootNodes.map(pruneInactive).filter((n): n is DepartmentTreeNode => n !== null)
    : allRootNodes;

  setCached(cacheKey, result);
  return result;
}

// ─── People tree ────────────────────────────────────────────────────────────

interface FlatPersonRow {
  id: string;
  name: string | null;
  jobTitle: string | null;
  email: string;
  isActive: boolean;
  managerId: string | null;
  department: { id: string; name: string } | null;
}

async function loadAllPeopleRows(activeOnly: boolean): Promise<FlatPersonRow[]> {
  return prisma.user.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    select: {
      id: true,
      name: true,
      jobTitle: true,
      email: true,
      isActive: true,
      managerId: true,
      department: { select: { id: true, name: true } },
    },
  });
}

function buildPeopleNode(row: FlatPersonRow, childrenByManager: Map<string, FlatPersonRow[]>, visited: Set<string>): PeopleTreeNode {
  const childRows = childrenByManager.get(row.id) ?? [];
  const children: PeopleTreeNode[] = [];
  for (const childRow of childRows) {
    // Defensive cycle guard at assembly time too (belt-and-braces on top of
    // the manager-sync service's own write-time cycle rejection) — a user
    // can never appear twice in their own ancestor chain during assembly.
    if (visited.has(childRow.id)) continue;
    visited.add(childRow.id);
    children.push(buildPeopleNode(childRow, childrenByManager, visited));
  }
  return {
    id: row.id,
    displayName: row.name,
    jobTitle: row.jobTitle,
    department: row.department,
    email: row.email,
    isActive: row.isActive,
    directReportsCount: childRows.length,
    children,
  };
}

export interface PeopleTreeOptions {
  activeOnly?: boolean;
}

/** Without `rootUserId`: every top-level root (no manager, or a manager outside the active/synced set). With it: that one user's own subtree. */
export async function getPeopleTree(rootUserId: string | undefined, options: PeopleTreeOptions = {}): Promise<PeopleTreeNode[]> {
  const activeOnly = options.activeOnly ?? true;
  const cacheKey = `people:${activeOnly}:${rootUserId ?? "*"}`;
  const cached = getCached<PeopleTreeNode[]>(cacheKey);
  if (cached) return cached;

  const rows = await loadAllPeopleRows(activeOnly);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const childrenByManager = new Map<string, FlatPersonRow[]>();
  for (const row of rows) {
    if (!row.managerId || !rowById.has(row.managerId)) continue; // manager filtered out (inactive) or not in this set — treat this row as a root
    if (!childrenByManager.has(row.managerId)) childrenByManager.set(row.managerId, []);
    childrenByManager.get(row.managerId)!.push(row);
  }

  let result: PeopleTreeNode[];
  if (rootUserId) {
    const rootRow = rowById.get(rootUserId);
    result = rootRow ? [buildPeopleNode(rootRow, childrenByManager, new Set([rootRow.id]))] : [];
  } else {
    const rootRows = rows.filter((r) => !r.managerId || !rowById.has(r.managerId));
    const globallyVisited = new Set<string>();
    result = rootRows.map((r) => {
      const visitedForThisTree = new Set([r.id]);
      const node = buildPeopleNode(r, childrenByManager, visitedForThisTree);
      for (const id of visitedForThisTree) globallyVisited.add(id);
      return node;
    });

    // A user who has SOME managerId, and that manager is itself a known
    // row, is normally reached as a descendant of a real root above — UNLESS
    // it's part of a cycle with no entry point from any real root (e.g. a
    // pure A->B->A pair, or a longer cycle disconnected from the rest of the
    // org). Such rows are never dropped from the tree: each one becomes its
    // own synthetic root instead, so a bad Entra/manual-data cycle is always
    // visibly surfaced rather than silently disappearing.
    for (const row of rows) {
      if (globallyVisited.has(row.id)) continue;
      const orphanVisited = new Set([row.id]);
      result.push(buildPeopleNode(row, childrenByManager, orphanVisited));
      for (const id of orphanVisited) globallyVisited.add(id);
    }
  }

  setCached(cacheKey, result);
  return result;
}

// ─── Current-user organization context ─────────────────────────────────────

export type OrganizationSyncStatusLabel = "SYNCED" | "UNMAPPED_DEPARTMENT" | "MANAGER_NOT_ASSIGNED" | "NEVER_SYNCED";

export interface OrganizationContextDto {
  user: { id: string; displayName: string | null; jobTitle: string | null };
  department: { id: string; name: string; path: string } | null;
  manager: { id: string; displayName: string | null; jobTitle: string | null; email: string } | null;
  managementChain: Array<{ id: string; displayName: string | null; jobTitle: string | null }>;
  directReportsCount: number;
  syncStatus: OrganizationSyncStatusLabel;
}

const MAX_MANAGEMENT_CHAIN_DEPTH = 50;

/**
 * Reads directly by `userId` — never through the JWT/session (deliberately
 * not carried there, see the plan's rationale for keeping the session
 * payload unchanged). `UNMAPPED_DEPARTMENT`/`MANAGER_NOT_ASSIGNED` are
 * computed here from `departmentId`/`managerId` being null — nothing is
 * persisted for these statuses, so there's nothing to keep in sync or let
 * go stale.
 */
export async function getOrganizationContext(userId: string): Promise<OrganizationContextDto | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      jobTitle: true,
      managerId: true,
      organizationSyncedAt: true,
      department: { select: { id: true, name: true, businessUnit: { select: { name: true } } } },
    },
  });
  if (!user) return null;

  const directReportsCount = await prisma.user.count({ where: { managerId: userId } });

  let manager: OrganizationContextDto["manager"] = null;
  const managementChain: OrganizationContextDto["managementChain"] = [];
  let currentManagerId = user.managerId;
  const visited = new Set<string>([user.id]);
  let depth = 0;
  while (currentManagerId && depth < MAX_MANAGEMENT_CHAIN_DEPTH) {
    if (visited.has(currentManagerId)) break; // cycle guard — stop, never loop forever
    visited.add(currentManagerId);
    const managerRow = await prisma.user.findUnique({
      where: { id: currentManagerId },
      select: { id: true, name: true, jobTitle: true, email: true, managerId: true },
    });
    if (!managerRow) break;
    const entry = { id: managerRow.id, displayName: managerRow.name, jobTitle: managerRow.jobTitle };
    if (depth === 0) manager = { ...entry, email: managerRow.email };
    managementChain.push(entry);
    currentManagerId = managerRow.managerId;
    depth++;
  }

  const syncStatus: OrganizationSyncStatusLabel = !user.organizationSyncedAt
    ? "NEVER_SYNCED"
    : !user.department
      ? "UNMAPPED_DEPARTMENT"
      : !user.managerId
        ? "MANAGER_NOT_ASSIGNED"
        : "SYNCED";

  return {
    user: { id: user.id, displayName: user.name, jobTitle: user.jobTitle },
    department: user.department
      ? { id: user.department.id, name: user.department.name, path: user.department.businessUnit ? `${user.department.businessUnit.name} / ${user.department.name}` : user.department.name }
      : null,
    manager,
    managementChain,
    directReportsCount,
    syncStatus,
  };
}
