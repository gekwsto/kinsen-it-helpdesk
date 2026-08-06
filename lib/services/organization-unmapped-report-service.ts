/**
 * Classifies every active, organization-synced user's manager-mapping state
 * into one of seven distinct statuses — replaces the earlier, overly broad
 * "any active synced user with no manager = MANAGER_NOT_ASSIGNED" rule,
 * which misclassified genuine organizational roots (a CEO, a department
 * head with real direct reports) as if they were sync failures.
 *
 * - `SYNCED` — has a valid, active, non-cyclic local manager. Not a problem.
 * - `EXPECTED_ROOT` — no manager, but has ≥1 active direct report — a
 *   plausible top-of-hierarchy node, not an error. (This service does not
 *   also check for an "explicitly configured root" flag — no such
 *   admin-editable concept exists in this schema; building one would be a
 *   real feature addition beyond this correction's scope, not a bug fix.
 *   Documented, not silently skipped.)
 * - `MANAGER_NOT_ASSIGNED` — no manager AND no direct reports: a genuine,
 *   worth-investigating dead end (not a root, not synced to anyone).
 * - `MANAGER_NOT_SYNCED` — Entra reports a real manager relationship for
 *   this user (learned via directReports inversion during the last manager
 *   sync — see `User.managerExcludedFromSync`), but that manager was
 *   excluded from the synced set (guest/service account).
 * - `MANAGER_INACTIVE` — has a resolved local manager, but that manager's
 *   own `isActive` is false.
 * - `INVALID_SELF_MANAGER` — `managerId === id` (defensive; the sync itself
 *   already rejects this at write time, so this only fires against legacy/
 *   manually-edited data).
 * - `MANAGER_CYCLE` — this user is part of a circular manager chain
 *   currently present in the database (same defensive posture as above).
 */
import { prisma } from "@/lib/prisma";

export type ManagerMappingStatus =
  | "SYNCED"
  | "EXPECTED_ROOT"
  | "MANAGER_NOT_ASSIGNED"
  | "MANAGER_NOT_SYNCED"
  | "MANAGER_INACTIVE"
  | "INVALID_SELF_MANAGER"
  | "MANAGER_CYCLE";

export interface ManagerMappingClassification {
  userId: string;
  name: string | null;
  email: string;
  status: ManagerMappingStatus;
}

/**
 * O(n) cycle detection over the FULL `User.managerId` graph (every user has
 * at most one outgoing edge, so this is a functional-graph traversal, not a
 * general graph algorithm) — standard three-color (unvisited/visiting/done)
 * marking. Runs over ALL users (not just active/synced ones), since a cycle
 * could in principle involve a user outside that subset via manual/legacy
 * data edits, even though the sync itself always rejects cycles at write
 * time for what it controls.
 */
async function findUsersInManagerCycles(): Promise<Set<string>> {
  const all = await prisma.user.findMany({ select: { id: true, managerId: true } });
  const managerById = new Map(all.map((u) => [u.id, u.managerId]));
  const state = new Map<string, "visiting" | "done">();
  const inCycle = new Set<string>();

  for (const user of all) {
    if (state.get(user.id) === "done") continue;
    const path: string[] = [];
    let current: string | null = user.id;
    while (current && state.get(current) !== "done") {
      if (state.get(current) === "visiting") {
        const cycleStartIndex = path.indexOf(current);
        for (let i = cycleStartIndex; i < path.length; i++) inCycle.add(path[i]);
        break;
      }
      state.set(current, "visiting");
      path.push(current);
      current = managerById.get(current) ?? null;
    }
    for (const id of path) {
      if (state.get(id) !== "done") state.set(id, "done");
    }
  }

  return inCycle;
}

/**
 * Classifies every active user who has actually gone through at least one
 * organization sync (`organizationSyncedAt` set — a never-synced user isn't
 * a "problem", it just hasn't been processed yet, and is excluded from this
 * report entirely, matching the pre-existing scoping rule).
 */
export async function classifyUserManagerMappings(): Promise<ManagerMappingClassification[]> {
  const users = await prisma.user.findMany({
    where: { isActive: true, organizationSyncedAt: { not: null } },
    select: { id: true, name: true, email: true, managerId: true, managerExcludedFromSync: true },
  });
  if (users.length === 0) return [];

  const [directReportCounts, cycleMembers] = await Promise.all([
    prisma.user.groupBy({ by: ["managerId"], where: { isActive: true, managerId: { not: null } }, _count: { managerId: true } }),
    findUsersInManagerCycles(),
  ]);
  const reportCountByManagerId = new Map(directReportCounts.map((r) => [r.managerId as string, r._count.managerId]));

  const managerIds = Array.from(new Set(users.map((u) => u.managerId).filter((x): x is string => !!x)));
  const managerRows = managerIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, isActive: true } }) : [];
  const managerActiveById = new Map(managerRows.map((m) => [m.id, m.isActive]));

  return users.map((user): ManagerMappingClassification => {
    let status: ManagerMappingStatus;

    if (user.managerId === user.id) {
      status = "INVALID_SELF_MANAGER";
    } else if (cycleMembers.has(user.id)) {
      status = "MANAGER_CYCLE";
    } else if (user.managerId) {
      status = managerActiveById.get(user.managerId) === false ? "MANAGER_INACTIVE" : "SYNCED";
    } else if (user.managerExcludedFromSync) {
      status = "MANAGER_NOT_SYNCED";
    } else if ((reportCountByManagerId.get(user.id) ?? 0) > 0) {
      status = "EXPECTED_ROOT";
    } else {
      status = "MANAGER_NOT_ASSIGNED";
    }

    return { userId: user.id, name: user.name, email: user.email, status };
  });
}

const PROBLEM_STATUSES: ManagerMappingStatus[] = ["MANAGER_NOT_ASSIGNED", "MANAGER_NOT_SYNCED", "MANAGER_INACTIVE", "INVALID_SELF_MANAGER", "MANAGER_CYCLE"];

export interface ManagerMappingReport {
  countsByStatus: Record<ManagerMappingStatus, number>;
  problems: Partial<Record<ManagerMappingStatus, { items: Array<{ userId: string; name: string | null; email: string }>; totalCount: number }>>;
}

/** Aggregates classifyUserManagerMappings into the report shape the admin unmapped-report API returns — only "problem" statuses get a listed sample; SYNCED/EXPECTED_ROOT are counted but never listed (they aren't problems to review). */
export async function buildManagerMappingReport(maxListedPerStatus = 200): Promise<ManagerMappingReport> {
  const classifications = await classifyUserManagerMappings();

  const countsByStatus: Record<ManagerMappingStatus, number> = {
    SYNCED: 0,
    EXPECTED_ROOT: 0,
    MANAGER_NOT_ASSIGNED: 0,
    MANAGER_NOT_SYNCED: 0,
    MANAGER_INACTIVE: 0,
    INVALID_SELF_MANAGER: 0,
    MANAGER_CYCLE: 0,
  };
  const problems: ManagerMappingReport["problems"] = {};

  for (const status of PROBLEM_STATUSES) {
    problems[status] = { items: [], totalCount: 0 };
  }

  for (const c of classifications) {
    countsByStatus[c.status]++;
    if (PROBLEM_STATUSES.includes(c.status)) {
      const bucket = problems[c.status]!;
      bucket.totalCount++;
      if (bucket.items.length < maxListedPerStatus) {
        bucket.items.push({ userId: c.userId, name: c.name, email: c.email });
      }
    }
  }

  return { countsByStatus, problems };
}
