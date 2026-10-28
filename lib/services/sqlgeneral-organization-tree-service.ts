/**
 * Builds a SEPARATE, read-only tree sourced entirely from SQLGeneral's own
 * Departments.ParentDepartmentId hierarchy, with existing TicketApp users
 * (matched by their already-captured, Graph-verified username) as leaves.
 *
 * Deliberately independent of the canonical local Organization Tree
 * (lib/services/organization-tree-service.ts, unchanged by this file) —
 * never reads or writes Company/BusinessUnit/Department/DepartmentMembership,
 * and NEVER requires a SqlGeneralCompanyMapping/SqlGeneralDepartmentMapping
 * to exist in order to build or display. Mapping status is attached to a
 * department node purely as an informational annotation (see
 * SqlGeneralDepartmentTreeNode.localMapping) — displaying the source
 * hierarchy and approving a mapping for an actual write are two completely
 * separate concerns; see applySqlGeneralDepartmentMembership in
 * sqlgeneral-user-sync-service.ts for the (unchanged, still fully guarded)
 * write path this file has no bearing on.
 *
 * Never creates/updates a local Company, Department, User, or membership —
 * every function here is read-only.
 */
import { prisma } from "@/lib/prisma";
import { listAllSqlGeneralDepartments, listAllSqlGeneralUsers, type SqlGeneralUserRecord } from "@/lib/sqlgeneral-api-client";

export type SqlGeneralTreeNode =
  | {
      id: string;
      kind: "sqlgeneral-department";
      sqlGeneralDepartmentId: string;
      name: string;
      company: string | null;
      companyShortname: string | null;
      isActive: boolean | null;
      /** Purely informational — see this file's header. Never required to build or render this tree. */
      localMapping: { departmentId: string; departmentName: string } | null;
      children: SqlGeneralTreeNode[];
    }
  | {
      id: string;
      kind: "sqlgeneral-user";
      userId: string;
      name: string | null;
      email: string;
      sqlGeneralUsername: string;
      children: [];
    };

export interface UnresolvedSqlGeneralDepartment {
  sqlGeneralDepartmentId: string;
  reason: "missing_parent" | "cycle";
}

export type UnresolvedSqlGeneralUserReason = "not_found" | "ambiguous" | "no_hr_department" | "department_not_found" | "conflicting_attempt";

export interface UnresolvedSqlGeneralUser {
  userId: string;
  reason: UnresolvedSqlGeneralUserReason;
}

export type SqlGeneralOrganizationTreeResult =
  | { ok: true; roots: SqlGeneralTreeNode[]; unresolvedDepartments: UnresolvedSqlGeneralDepartment[]; unresolvedUsers: UnresolvedSqlGeneralUser[] }
  | { ok: false; reason: string };

function deptNodeId(sqlGeneralDepartmentId: string): string {
  return `sgdept:${sqlGeneralDepartmentId}`;
}
function userNodeId(userId: string): string {
  return `sguser:${userId}`;
}

/**
 * Builds the pure department skeleton (no users yet) from a flat list,
 * supporting ARBITRARY nesting depth via a worklist/fixed-point approach —
 * never a fixed-depth recursive walk. Two independent failure modes are
 * detected and reported, never silently dropped or promoted to a false
 * root:
 *   - "missing_parent": a department's ParentDepartmentId isn't present in
 *     the fetched set at all.
 *   - "cycle": a department's ancestor chain loops back on itself.
 * Any department that is ITSELF fine but whose parent (at any depth) is
 * unresolved is cascaded into "missing_parent" too — a broken ancestor
 * anywhere upstream means this node can't be safely placed either.
 */
function buildDepartmentSkeleton(
  departments: Array<{ id: string | number; description: string | null; isActive: boolean | null; parentDepartmentId: string | number | null; company: string | null; companyShortname: string | null }>,
  mappingByDeptId: Map<string, { departmentId: string; departmentName: string }>
): { nodesById: Map<string, SqlGeneralTreeNode & { kind: "sqlgeneral-department" }>; parentOf: Map<string, string | null>; roots: string[]; unresolvedDepartments: UnresolvedSqlGeneralDepartment[] } {
  const nodesById = new Map<string, SqlGeneralTreeNode & { kind: "sqlgeneral-department" }>();
  const parentOf = new Map<string, string | null>();

  for (const d of departments) {
    const id = String(d.id);
    const parentId = d.parentDepartmentId === null || d.parentDepartmentId === undefined ? null : String(d.parentDepartmentId);
    parentOf.set(id, parentId);
    nodesById.set(id, {
      id: deptNodeId(id),
      kind: "sqlgeneral-department",
      sqlGeneralDepartmentId: id,
      name: d.description ?? id,
      company: d.company,
      companyShortname: d.companyShortname,
      isActive: d.isActive,
      localMapping: mappingByDeptId.get(id) ?? null,
      children: [],
    });
  }

  // Cycle detection: walk ancestors from every node; if the walk revisits
  // its own starting id, every node on that loop is a cycle member.
  const cycleMembers = new Set<string>();
  for (const startId of parentOf.keys()) {
    if (cycleMembers.has(startId)) continue;
    const path: string[] = [];
    const pathSet = new Set<string>();
    let current: string | null = startId;
    while (current !== null) {
      if (pathSet.has(current)) {
        if (current === startId) {
          for (const id of path) cycleMembers.add(id);
        }
        break;
      }
      if (!parentOf.has(current)) break; // dangling parent id — a missing_parent case elsewhere, not a cycle
      path.push(current);
      pathSet.add(current);
      current = parentOf.get(current) ?? null;
    }
  }

  const unresolved = new Map<string, "missing_parent" | "cycle">();
  for (const id of cycleMembers) unresolved.set(id, "cycle");
  for (const [id, parentId] of parentOf) {
    if (unresolved.has(id)) continue;
    if (parentId !== null && !parentOf.has(parentId)) unresolved.set(id, "missing_parent");
  }

  // Cascade: anything whose parent (direct or, after more passes, indirect)
  // is already unresolved becomes unresolved too — fixed-point, so this is
  // correct at any nesting depth, not just one level.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parentId] of parentOf) {
      if (unresolved.has(id)) continue;
      if (parentId !== null && unresolved.has(parentId)) {
        unresolved.set(id, "missing_parent");
        changed = true;
      }
    }
  }

  const roots: string[] = [];
  for (const [id, parentId] of parentOf) {
    if (unresolved.has(id)) continue;
    if (parentId === null) {
      roots.push(id);
    } else {
      // parentId is guaranteed present and resolved here, since id itself
      // was not cascaded into "unresolved".
      nodesById.get(parentId)!.children.push(nodesById.get(id)!);
    }
  }

  const unresolvedDepartments: UnresolvedSqlGeneralDepartment[] = Array.from(unresolved.entries()).map(([sqlGeneralDepartmentId, reason]) => ({ sqlGeneralDepartmentId, reason }));
  return { nodesById, parentOf, roots, unresolvedDepartments };
}

/**
 * Resolves every existing TicketApp user with an already-captured SQLGeneral
 * username into a leaf under their HrDepartmentId — never a live per-user
 * API call (the bulk `sqlGeneralUsers` listing is matched in memory).
 *
 * Deduplicates and fails closed on identity conflicts (REQUIRED #3):
 *   - Two or more DIFFERENT local userIds claiming the exact SAME SQLGeneral
 *     username is a genuine local-side conflict — ALL of them are reported
 *     unresolved ("conflicting_attempt"), none is shown as a leaf, since
 *     which one (if any) legitimately owns that external identity can't be
 *     determined here.
 *   - Zero or more-than-one SQLGeneral row sharing that Username is the
 *     SAME "not_found"/"ambiguous" distinction findSqlGeneralUserByUsername
 *     already makes elsewhere, just computed against the bulk listing.
 * (SqlGeneralUserSyncAttempt.userId is already @unique in the schema, so a
 * single local user can never have two attempt rows — the conflict this
 * guards against is two DIFFERENT users claiming the same username.)
 */
async function resolveSqlGeneralTreeUsers(sqlGeneralUsers: SqlGeneralUserRecord[]): Promise<{ leavesByDepartmentId: Map<string, Array<SqlGeneralTreeNode & { kind: "sqlgeneral-user" }>>; unresolvedUsers: UnresolvedSqlGeneralUser[] }> {
  const attempts = await prisma.sqlGeneralUserSyncAttempt.findMany({
    where: { sqlGeneralUsername: { not: null } },
    select: { userId: true, sqlGeneralUsername: true, user: { select: { id: true, name: true, email: true } } },
  });

  const attemptsByUsername = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const key = a.sqlGeneralUsername as string;
    if (!attemptsByUsername.has(key)) attemptsByUsername.set(key, []);
    attemptsByUsername.get(key)!.push(a);
  }

  const sqlGeneralByUsername = new Map<string, SqlGeneralUserRecord[]>();
  for (const u of sqlGeneralUsers) {
    if (!u.username) continue;
    if (!sqlGeneralByUsername.has(u.username)) sqlGeneralByUsername.set(u.username, []);
    sqlGeneralByUsername.get(u.username)!.push(u);
  }

  const leavesByDepartmentId = new Map<string, Array<SqlGeneralTreeNode & { kind: "sqlgeneral-user" }>>();
  const unresolvedUsers: UnresolvedSqlGeneralUser[] = [];

  for (const [username, localAttempts] of attemptsByUsername) {
    if (localAttempts.length > 1) {
      for (const a of localAttempts) unresolvedUsers.push({ userId: a.userId, reason: "conflicting_attempt" });
      continue;
    }
    const attempt = localAttempts[0];
    const matches = sqlGeneralByUsername.get(username) ?? [];
    if (matches.length === 0) {
      unresolvedUsers.push({ userId: attempt.userId, reason: "not_found" });
      continue;
    }
    if (matches.length > 1) {
      unresolvedUsers.push({ userId: attempt.userId, reason: "ambiguous" });
      continue;
    }
    const match = matches[0];
    if (match.hrDepartmentId === null) {
      unresolvedUsers.push({ userId: attempt.userId, reason: "no_hr_department" });
      continue;
    }
    const deptId = String(match.hrDepartmentId);
    const leaf: SqlGeneralTreeNode & { kind: "sqlgeneral-user" } = {
      id: userNodeId(attempt.userId),
      kind: "sqlgeneral-user",
      userId: attempt.userId,
      name: attempt.user.name,
      email: attempt.user.email,
      sqlGeneralUsername: username,
      children: [],
    };
    if (!leavesByDepartmentId.has(deptId)) leavesByDepartmentId.set(deptId, []);
    leavesByDepartmentId.get(deptId)!.push(leaf);
  }

  return { leavesByDepartmentId, unresolvedUsers };
}

/**
 * Builds the full tree: department skeleton (arbitrary depth, cycle/missing-
 * parent safe) + user leaves attached under their resolved department.
 * Never writes anything. Fails closed on any upstream fetch failure
 * (incomplete pagination, config/network errors) — returns `{ ok: false }`
 * rather than a partial tree.
 */
export async function getSqlGeneralOrganizationTree(): Promise<SqlGeneralOrganizationTreeResult> {
  const [deptResult, userResult] = await Promise.all([listAllSqlGeneralDepartments(), listAllSqlGeneralUsers()]);
  if (!deptResult.ok) return { ok: false, reason: `Could not fetch SQLGeneral Departments: ${deptResult.reason}` };
  if (!userResult.ok) return { ok: false, reason: `Could not fetch SQLGeneral UsersAndManagers: ${userResult.reason}` };

  const deptMappings = await prisma.sqlGeneralDepartmentMapping.findMany({ select: { sqlGeneralDepartmentId: true, department: { select: { id: true, name: true } } } });
  const mappingByDeptId = new Map(deptMappings.map((m) => [m.sqlGeneralDepartmentId, { departmentId: m.department.id, departmentName: m.department.name }]));

  const { nodesById, roots: rootIds, unresolvedDepartments } = buildDepartmentSkeleton(deptResult.departments, mappingByDeptId);
  const { leavesByDepartmentId, unresolvedUsers } = await resolveSqlGeneralTreeUsers(userResult.users);

  const unresolvedSet = new Set(unresolvedDepartments.map((d) => d.sqlGeneralDepartmentId));
  for (const [deptId, leaves] of leavesByDepartmentId) {
    const node = nodesById.get(deptId);
    if (!node || unresolvedSet.has(deptId)) {
      for (const leaf of leaves) unresolvedUsers.push({ userId: leaf.userId, reason: "department_not_found" });
      continue;
    }
    node.children.push(...leaves);
  }

  const roots = rootIds.map((id) => nodesById.get(id)!).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, roots, unresolvedDepartments, unresolvedUsers };
}
