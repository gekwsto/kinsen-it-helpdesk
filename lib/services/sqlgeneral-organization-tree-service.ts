/**
 * Builds a SEPARATE, read-only, MANAGER-FIRST tree sourced entirely from
 * SQLGeneral's own UsersAndManagers.managerAMAccountName relationships —
 * NOT from Departments.ParentDepartmentId (the prior round's design).
 * Management relationships are authoritative; Company/Department are
 * employee METADATA on a node, never a hierarchy boundary — two people in
 * completely different Companies/Departments are placed directly under one
 * another whenever a real managerAMAccountName link says so.
 *
 * Scope: every valid (non-ambiguous) SQLGeneral identity in the complete
 * UsersAndManagers listing renders — not just TicketApp-linked ones, the
 * same "across all Companies/Departments" scope the prior round's
 * Department tree used (every Department rendered regardless of user-
 * match). An existing TicketApp user whose captured SQLGeneral username
 * resolves uniquely (an "anchor") gets `isLocal: true` plus their local
 * name/email/jobTitle attached to the SAME node; everyone else renders as
 * an external, read-only placeholder (REQUIRED #3) — a real manager
 * identity is never hidden just because they lack a local TicketApp
 * account, and never gets one created.
 *
 * Deliberately independent of the canonical local Organization Tree
 * (lib/services/organization-tree-service.ts, unchanged by this file) and
 * of the local Department/Company mapping tables — never reads or writes
 * Company/BusinessUnit/Department/DepartmentMembership, and never requires
 * a SqlGeneralCompanyMapping/SqlGeneralDepartmentMapping to exist.
 *
 * Never creates/updates a local Company, Department, User, or membership —
 * every function here is read-only.
 */
import { prisma } from "@/lib/prisma";
import { listAllSqlGeneralUsers, type SqlGeneralUserRecord } from "@/lib/sqlgeneral-api-client";

export interface SqlGeneralManagerTreeNode {
  id: string;
  kind: "sqlgeneral-person";
  sqlGeneralUsername: string;
  /** True only for an existing TicketApp user whose captured SQLGeneral username resolved uniquely — see resolveSqlGeneralAnchors. Never set for a placeholder-only ancestor. */
  isLocal: boolean;
  userId: string | null;
  name: string | null;
  email: string | null;
  jobTitle: string | null;
  /** Metadata only (REQUIRED #5) — the person's OWN SQLGeneral Company/Department strings, shown on hover, NEVER used to group, separate, or otherwise shape this tree. */
  company: string | null;
  department: string | null;
  isActive: boolean | null;
  children: SqlGeneralManagerTreeNode[];
}

export type UnresolvedSqlGeneralUserReason = "not_found" | "ambiguous" | "conflicting_attempt";

export interface UnresolvedSqlGeneralUser {
  userId: string;
  reason: UnresolvedSqlGeneralUserReason;
}

/**
 * A SQLGeneral identity (by username) whose OWN edge to its claimed
 * manager could not be trusted — the person themselves still renders (as
 * a de-facto root at that point; their own subordinates are completely
 * unaffected), only the specific upward edge is cut. Never silently
 * resolved/guessed (REQUIRED #4):
 *   - "self_reference": managerAMAccountName === the person's own username.
 *   - "missing_manager": the claimed manager username does not exist
 *     anywhere in the live UsersAndManagers data at all (dangling).
 *   - "ambiguous_manager": the claimed manager username exists, but more
 *     than once (SQLGeneral's own data is ambiguous about who that is).
 *   - "cycle": this person's ancestor chain loops back on itself.
 * Reported for every valid identity in the complete UsersAndManagers
 * listing — the tree's scope is the whole roster, so this is never
 * narrowed to only TicketApp-relevant people.
 */
export interface UnresolvedSqlGeneralManagerLink {
  sqlGeneralUsername: string;
  reason: "self_reference" | "missing_manager" | "ambiguous_manager" | "cycle";
}

export type SqlGeneralOrganizationTreeResult =
  | { ok: true; roots: SqlGeneralManagerTreeNode[]; unresolvedUsers: UnresolvedSqlGeneralUser[]; unresolvedManagerLinks: UnresolvedSqlGeneralManagerLink[] }
  | { ok: false; reason: string };

function personNodeId(sqlGeneralUsername: string): string {
  return `sgperson:${sqlGeneralUsername}`;
}

/**
 * Builds the pure manager skeleton from the complete UsersAndManagers
 * listing — every valid SQLGeneral identity as a node, every validated
 * managerAMAccountName edge as a parent pointer. Supports ARBITRARY chain
 * depth via a plain parent-pointer map (walked upward as needed by the
 * caller), never a fixed-depth recursion.
 *
 * A username appearing more than once in the live data is never trusted as
 * either a node or a valid reference target (fail closed on ambiguity,
 * REQUIRED #4) — it simply never gets a node, and anyone claiming it as
 * their manager is reported "ambiguous_manager".
 *
 * Each broken edge (self-reference / missing / ambiguous manager / cycle)
 * ONLY cuts that ONE person's own upward edge (parentOf becomes null —
 * they render as a root from that point) — it is NEVER cascaded onto their
 * own subordinates. "Preserve complete chains where source data supports
 * them" (REQUIRED #3) means cutting exactly at the point data stops
 * supporting the chain, not discarding everything downstream of a break.
 */
function buildManagerSkeleton(sqlGeneralUsers: SqlGeneralUserRecord[]): {
  nodeByUsername: Map<string, SqlGeneralManagerTreeNode>;
  parentOf: Map<string, string | null>;
  unresolvedManagerLinks: UnresolvedSqlGeneralManagerLink[];
} {
  const usernameCounts = new Map<string, number>();
  for (const u of sqlGeneralUsers) {
    if (!u.username) continue;
    usernameCounts.set(u.username, (usernameCounts.get(u.username) ?? 0) + 1);
  }

  const nodeByUsername = new Map<string, SqlGeneralManagerTreeNode>();
  const rawManagerOf = new Map<string, string | null>();

  for (const u of sqlGeneralUsers) {
    if (!u.username) continue;
    if (nodeByUsername.has(u.username)) continue; // already handled this username on an earlier (also non-unique) row
    if ((usernameCounts.get(u.username) ?? 0) > 1) continue; // ambiguous identity — never a node, never a valid reference target
    nodeByUsername.set(u.username, {
      id: personNodeId(u.username),
      kind: "sqlgeneral-person",
      sqlGeneralUsername: u.username,
      isLocal: false,
      userId: null,
      name: null,
      email: u.mail,
      jobTitle: null,
      company: u.company,
      department: u.department,
      isActive: u.active,
      children: [],
    });
    rawManagerOf.set(u.username, u.managerAMAccountName?.trim() || null);
  }

  const brokenReason = new Map<string, UnresolvedSqlGeneralManagerLink["reason"]>();
  for (const [username, managerUsername] of rawManagerOf) {
    if (managerUsername === null) continue;
    if (managerUsername === username) {
      brokenReason.set(username, "self_reference");
      continue;
    }
    if (!nodeByUsername.has(managerUsername)) {
      brokenReason.set(username, (usernameCounts.get(managerUsername) ?? 0) > 1 ? "ambiguous_manager" : "missing_manager");
    }
  }

  // Cycle detection: walk ancestors from every (not-already-broken) node; if
  // the walk revisits its own starting username, every node on that loop is
  // a cycle member — same proven idiom as the prior department-tree round.
  const cycleMembers = new Set<string>();
  for (const startUsername of rawManagerOf.keys()) {
    if (cycleMembers.has(startUsername) || brokenReason.has(startUsername)) continue;
    const path: string[] = [];
    const pathSet = new Set<string>();
    let current: string | null = startUsername;
    while (current !== null) {
      if (pathSet.has(current)) {
        if (current === startUsername) for (const u of path) cycleMembers.add(u);
        break;
      }
      if (brokenReason.has(current)) break; // walked into an already-broken edge upstream — not a cycle
      path.push(current);
      pathSet.add(current);
      current = rawManagerOf.get(current) ?? null;
    }
  }
  for (const u of cycleMembers) brokenReason.set(u, "cycle");

  const parentOf = new Map<string, string | null>();
  for (const [username, managerUsername] of rawManagerOf) {
    parentOf.set(username, brokenReason.has(username) ? null : managerUsername);
  }

  const unresolvedManagerLinks: UnresolvedSqlGeneralManagerLink[] = Array.from(brokenReason.entries()).map(([sqlGeneralUsername, reason]) => ({ sqlGeneralUsername, reason }));
  return { nodeByUsername, parentOf, unresolvedManagerLinks };
}

/**
 * Resolves every existing TicketApp user with an already-captured SQLGeneral
 * username into an "anchor" — never a live per-user API call (the bulk
 * `sqlGeneralUsers` listing, already fetched, is matched in memory).
 *
 * Deduplicates and fails closed on identity conflicts, mirroring the prior
 * round's exact semantics:
 *   - Two or more DIFFERENT local userIds claiming the exact SAME SQLGeneral
 *     username is a genuine local-side conflict — ALL of them are reported
 *     unresolved ("conflicting_attempt"), none becomes an anchor.
 *   - Zero or more-than-one SQLGeneral row sharing that Username is the SAME
 *     "not_found"/"ambiguous" distinction findSqlGeneralUserByUsername
 *     already makes elsewhere, just computed against the bulk listing.
 */
async function resolveSqlGeneralAnchors(
  sqlGeneralUsers: SqlGeneralUserRecord[]
): Promise<{ anchors: Map<string, { userId: string; name: string | null; email: string; jobTitle: string | null }>; unresolvedUsers: UnresolvedSqlGeneralUser[] }> {
  const attempts = await prisma.sqlGeneralUserSyncAttempt.findMany({
    where: { sqlGeneralUsername: { not: null } },
    select: { userId: true, sqlGeneralUsername: true, user: { select: { id: true, name: true, email: true, jobTitle: true } } },
  });

  const attemptsByUsername = new Map<string, typeof attempts>();
  for (const a of attempts) {
    const key = a.sqlGeneralUsername as string;
    if (!attemptsByUsername.has(key)) attemptsByUsername.set(key, []);
    attemptsByUsername.get(key)!.push(a);
  }

  const countByUsername = new Map<string, number>();
  for (const u of sqlGeneralUsers) {
    if (!u.username) continue;
    countByUsername.set(u.username, (countByUsername.get(u.username) ?? 0) + 1);
  }

  const anchors = new Map<string, { userId: string; name: string | null; email: string; jobTitle: string | null }>();
  const unresolvedUsers: UnresolvedSqlGeneralUser[] = [];

  for (const [username, localAttempts] of attemptsByUsername) {
    if (localAttempts.length > 1) {
      for (const a of localAttempts) unresolvedUsers.push({ userId: a.userId, reason: "conflicting_attempt" });
      continue;
    }
    const attempt = localAttempts[0];
    const count = countByUsername.get(username) ?? 0;
    if (count === 0) {
      unresolvedUsers.push({ userId: attempt.userId, reason: "not_found" });
      continue;
    }
    if (count > 1) {
      unresolvedUsers.push({ userId: attempt.userId, reason: "ambiguous" });
      continue;
    }
    anchors.set(username, { userId: attempt.userId, name: attempt.user.name, email: attempt.user.email, jobTitle: attempt.user.jobTitle });
  }

  return { anchors, unresolvedUsers };
}

function sortTreeInPlace(nodes: SqlGeneralManagerTreeNode[]): void {
  nodes.sort((a, b) => (a.name ?? a.sqlGeneralUsername).localeCompare(b.name ?? b.sqlGeneralUsername));
  for (const n of nodes) sortTreeInPlace(n.children);
}

/**
 * Builds the full manager-first tree. Never writes anything. Fails closed
 * on any upstream fetch failure (incomplete pagination, config/network
 * errors) — returns `{ ok: false }` rather than a partial tree.
 */
export async function getSqlGeneralOrganizationTree(): Promise<SqlGeneralOrganizationTreeResult> {
  const userResult = await listAllSqlGeneralUsers();
  if (!userResult.ok) return { ok: false, reason: `Could not fetch SQLGeneral UsersAndManagers: ${userResult.reason}` };

  const { nodeByUsername, parentOf, unresolvedManagerLinks } = buildManagerSkeleton(userResult.users);
  const { anchors, unresolvedUsers } = await resolveSqlGeneralAnchors(userResult.users);

  for (const [username, local] of anchors) {
    const node = nodeByUsername.get(username);
    if (!node) continue; // defensive only — anchors are only ever built from usernames already confirmed unique/present above
    node.isLocal = true;
    node.userId = local.userId;
    node.name = local.name;
    node.email = local.email;
    node.jobTitle = local.jobTitle;
  }

  // The full graph — every valid SQLGeneral identity, not just TicketApp-
  // linked ones — renders, exactly like the prior round's Department tree
  // rendered every Department regardless of user-match (REQUIRED #2's
  // "across all Companies/Departments"). `isLocal`/`userId` above is what
  // distinguishes an actual TicketApp user from a placeholder manager —
  // scope is never narrowed to only TicketApp-relevant chains.
  const roots: SqlGeneralManagerTreeNode[] = [];
  for (const [username, node] of nodeByUsername) {
    const parentUsername = parentOf.get(username) ?? null;
    if (parentUsername === null) {
      roots.push(node);
    } else {
      nodeByUsername.get(parentUsername)!.children.push(node);
    }
  }
  sortTreeInPlace(roots);

  return { ok: true, roots, unresolvedUsers, unresolvedManagerLinks };
}
