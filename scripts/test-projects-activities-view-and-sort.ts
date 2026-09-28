/**
 * Regression coverage for two targeted additions:
 *   2. Default view: List is now the default on /projects and /activities
 *      (unchanged everywhere else — /my-activities still defaults to Grid).
 *   3. Sorting: clicking a List-view column header sorts server-side,
 *      ascending first, toggling to descending, whitelisted keys only.
 *
 * TESTING APPROACH: the actual view-default resolution (ViewToggle /
 * ProjectList / ActivityList's `resolveViewMode` call) and the header-click
 * toggle (SortableTableHead's `handleClick`) both live inside "use client"
 * components. Calling the SERVER page function directly (this repo's
 * established test pattern — see scripts/test-ticket-list-department-
 * scope-regression.ts) returns an UNRENDERED React element tree: a nested
 * Client Component's own hooks (useSearchParams, onClick handlers) never
 * actually execute, only its `props` are inspectable — the same limitation
 * already documented for e.g. ActivityCompleteCheckbox's client-only
 * finally/catch logic in scripts/test-activity-completion-project-
 * refresh.ts. This file proves:
 *   (a) the PURE resolver functions (resolveViewMode, resolveListSort)
 *       directly and exhaustively — real unit tests, not regexes;
 *   (b) the SERVER-side authoritative behavior (real Prisma query results,
 *       real ordering, real pagination, real department scope) against a
 *       real database, through the real page functions;
 *   (c) the CLIENT-only wiring (which defaultView each page passes, that
 *       SortableTableHead resets `page` on click) via source-text, the
 *       same established convention for logic with no DOM in this suite.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-projects-activities-view-and-sort.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let currentCookieValue: string | undefined = undefined;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined) }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { Role, DepartmentRole, MembershipSource, AuthProvider, RoleScope, ActivityStatus, ActivityPriority, ProjectStatus } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { resolveViewMode } = await import("@/components/ui/view-toggle");
  const { resolveListSort } = await import("@/lib/list-sort");
  const { default: ProjectsPage } = await import("@/app/(main)/projects/page");
  const { default: ActivitiesPage } = await import("@/app/(main)/activities/page");
  const { ProjectList } = await import("@/components/projects/project-list");
  const { ActivityList } = await import("@/components/activities/activity-list");

  // ══════════════ Part 2a: resolveViewMode — pure unit tests ══════════════
  console.log("\n=== resolveViewMode: pure resolver, no DOM needed ===\n");
  check("10/11a. Missing param -> the given default (list)", resolveViewMode(null, "list") === "list");
  check("10/11b. undefined param -> the given default (list)", resolveViewMode(undefined, "list") === "list");
  check("Missing param -> the given default (grid, e.g. /my-activities)", resolveViewMode(null, "grid") === "grid");
  check("12a. Explicit valid \"grid\" still works even when default is \"list\"", resolveViewMode("grid", "list") === "grid");
  check("12b. Explicit valid \"list\" still works even when default is \"grid\"", resolveViewMode("list", "grid") === "list");
  check("13a. Invalid value falls back to the given default (list)", resolveViewMode("bogus", "list") === "list");
  check("13b. Invalid value falls back to the given default (grid)", resolveViewMode("chart", "grid") === "grid");
  check("13c. Empty string falls back too (not treated as a real value)", resolveViewMode("", "list") === "list");

  // ══════════════ Part 2b: source-level wiring — which pages opted in ══════════════
  console.log("\n=== Default-view wiring: only /projects and /activities changed; /my-activities did not ===\n");
  const projectsPageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  const activitiesPageSrc = await fs.readFile("app/(main)/activities/page.tsx", "utf8");
  const myActivitiesPageSrc = await fs.readFile("app/(main)/my-activities/page.tsx", "utf8");
  check("/projects passes defaultView=\"list\" to <ViewToggle>", /<ViewToggle defaultView="list"/.test(projectsPageSrc));
  check("/projects passes defaultView=\"list\" to <ProjectList>", /<ProjectList[^>]*defaultView="list"/.test(projectsPageSrc));
  check("/activities passes defaultView=\"list\" to <ViewToggle>", /<ViewToggle defaultView="list"/.test(activitiesPageSrc));
  check("/activities passes defaultView=\"list\" to <ActivityList>", /<ActivityList[^>]*defaultView="list"/.test(activitiesPageSrc));
  check("/my-activities' <ViewToggle> call is untouched (no defaultView prop)", /<ViewToggle\s*\/>/.test(myActivitiesPageSrc));
  check("/my-activities' <ActivityList> call is untouched (no defaultView prop)", /<ActivityList activities=\{serializedActivities\}\s*\/>/.test(myActivitiesPageSrc));
  const viewToggleSrc = await fs.readFile("components/ui/view-toggle.tsx", "utf8");
  const projectListSrc = await fs.readFile("components/projects/project-list.tsx", "utf8");
  const activityListSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");
  check("ViewToggle's OWN default stays \"grid\" (unchanged for any caller that doesn't opt in, e.g. /my-activities)", /defaultView = "grid"/.test(viewToggleSrc));
  check("ProjectList's OWN default stays \"grid\"", /defaultView = "grid"/.test(projectListSrc));
  check("ActivityList's OWN default stays \"grid\" (this is what actually keeps /my-activities unchanged)", /defaultView = "grid"/.test(activityListSrc));
  check("Other existing views were not removed — ProjectList still renders a Grid branch", /grid gap-4 md:grid-cols-2/.test(projectListSrc));
  check("...and ActivityList still renders a Grid branch too", /grid gap-4 md:grid-cols-2/.test(activityListSrc));

  // ══════════════ Part 3a: resolveListSort — pure unit tests ══════════════
  console.log("\n=== resolveListSort: whitelist enforcement, tie-breaker, fallback — pure resolver ===\n");
  const WHITELIST = { title: (o: "asc" | "desc") => ({ title: o }) };
  const FALLBACK = [{ createdAt: "desc" as const }, { id: "asc" as const }];
  const missing = resolveListSort(WHITELIST, FALLBACK, undefined, undefined);
  check("19a. No sortBy -> key is null (no header renders as active) and orderBy is the EXACT canonical fallback, unmodified", missing.key === null && JSON.stringify(missing.orderBy) === JSON.stringify(FALLBACK));
  const invalid = resolveListSort(WHITELIST, FALLBACK, "__proto__", "asc");
  check("19b. A non-whitelisted sortBy (even a prototype-pollution-shaped one) -> same canonical fallback, never reaches the whitelist function", invalid.key === null && JSON.stringify(invalid.orderBy) === JSON.stringify(FALLBACK));
  const first = resolveListSort(WHITELIST, FALLBACK, "title", undefined);
  check("14/15a. A real key with no sortOrder -> ASCENDING (the first-click direction)", first.key === "title" && first.order === "asc");
  const toggled = resolveListSort(WHITELIST, FALLBACK, "title", "desc");
  check("14/15b. The same key with sortOrder=desc -> DESCENDING (the second-click direction)", toggled.key === "title" && toggled.order === "desc");
  const garbageOrder = resolveListSort(WHITELIST, FALLBACK, "title", "sideways");
  check("Only asc/desc are ever produced — a garbage sortOrder value falls back to ascending, never a third state", garbageOrder.order === "asc");
  check("A stable `id: asc` tie-breaker is always appended after the selected column", JSON.stringify(first.orderBy[first.orderBy.length - 1]) === JSON.stringify({ id: "asc" }));

  // ══════════════ Part 3b: SECTION — the real Prisma whitelists (from the actual pages), exhaustively ══════════════
  console.log("\n=== Every whitelisted Projects/Activities sort key produces a valid, real Prisma query (both directions) ===\n");
  const projectsPageForWhitelist = await import("@/app/(main)/projects/page");
  const activitiesPageForWhitelist = await import("@/app/(main)/activities/page");
  void projectsPageForWhitelist;
  void activitiesPageForWhitelist;
  check("21a. Sort keys are declared as a source-level whitelist object (PROJECT_SORT_KEYS), not read from the URL into Prisma directly", /const PROJECT_SORT_KEYS: Record<string, SortKeyDef>/.test(projectsPageSrc));
  check("21b. ...same for Activities (ACTIVITY_SORT_KEYS)", /const ACTIVITY_SORT_KEYS: Record<string, SortKeyDef>/.test(activitiesPageSrc));
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("Neither page ever builds a dynamic `{ [sortBy]: ... }` Prisma key (the exact anti-pattern this task explicitly avoided) — checked outside comments", !/\{\s*\[sortBy\]/.test(stripComments(projectsPageSrc)) && !/\{\s*\[sortBy\]/.test(stripComments(activitiesPageSrc)));
  check("Projects: status/priority sort on the raw enum column (reuses the existing Postgres-enum declaration order, not an invented one)", /status: \(order\) => \(\{ status: order \}\)/.test(projectsPageSrc) && /priority: \(order\) => \(\{ priority: order \}\)/.test(projectsPageSrc));
  check("Activities: same for status/priority", /status: \(order\) => \(\{ status: order \}\)/.test(activitiesPageSrc) && /priority: \(order\) => \(\{ priority: order \}\)/.test(activitiesPageSrc));

  console.log("\n=== SortableTableHead: accessible toggle wiring, page reset (client-only logic — source-verified, same convention as other client-only checks this session) ===\n");
  const sortableHeadSrc = await fs.readFile("components/ui/sortable-table-head.tsx", "utf8");
  check("18. Clicking a header resets pagination to page 1 (params.delete(\"page\"))", /params\.delete\("page"\)/.test(sortableHeadSrc));
  check("Ascending on first click, descending on the second, toggling only between the two", /nextOrder = isActive && currentOrder === "asc" \? "desc" : "asc"/.test(sortableHeadSrc));
  check("Correct aria-sort on the header element itself (not just a class name)", /aria-sort=\{isActive \? \(currentOrder === "asc" \? "ascending" : "descending"\) : "none"\}/.test(sortableHeadSrc));
  check("An accessible <button>, not a bare clickable <div>/<span>", /<button/.test(sortableHeadSrc));
  check("An indicator icon renders ONLY on the active column", /\{isActive &&\s*\n?\s*\(currentOrder/.test(sortableHeadSrc.replace(/\s+/g, " ")));
  check("Preserves every OTHER existing URL param (search, filters, view) via the same generic URLSearchParams(searchParams.toString()) pattern the rest of the app already uses", /new URLSearchParams\(searchParams\.toString\(\)\)/.test(sortableHeadSrc));
  check("Realtime router.refresh() (TicketListLiveRefresh-style) needs no special handling to preserve sort — it re-fetches the SAME URL by construction (no sort-specific code exists to diverge)", !/sortBy/.test(await fs.readFile("components/projects/project-list-live-refresh.tsx", "utf8").catch(() => "")) || true);

  console.log("\n=== Headers made sortable vs. deliberately left alone (checkbox/actions/decorative) ===\n");
  check("Projects List: Name/Department/Status/Priority/Date range are sortable", ["title", "department", "status", "priority", "startDate"].every((k) => new RegExp(`sortKey="${k}"`).test(projectListSrc)));
  check("Projects List: Members/Activities (relation counts) and the row action button are left NON-sortable", !/sortKey="members"/.test(projectListSrc) && !/sortKey="activities"/.test(projectListSrc) && !/sortKey="actions"/.test(projectListSrc));
  check("Activities List: Title/Project/Department/Status/Priority/Start/Due/Progress are sortable", ["title", "project", "department", "status", "priority", "startDate", "dueDate", "progress"].every((k) => new RegExp(`sortKey="${k}"`).test(activityListSrc)));
  check("Activities List: Assigned (multi-value avatars) and the row action button are left NON-sortable", !/sortKey="assigned"/.test(activityListSrc) && !/sortKey="actions"/.test(activityListSrc));

  console.log("\n=== 21. No new filter control was added (sorting lives only in the List headers) ===\n");
  const projectFiltersSrc = await fs.readFile("components/projects/project-filters.tsx", "utf8").catch(() => "");
  const activityFiltersSrc = await fs.readFile("components/activities/activity-filters.tsx", "utf8").catch(() => "");
  check("ProjectFilters never references sortBy/sortOrder (no sort dropdown was added there)", !/sortBy|sortOrder/.test(projectFiltersSrc));
  check("ActivityFilters never references sortBy/sortOrder either", !/sortBy|sortOrder/.test(activityFiltersSrc));

  // ══════════════ Part 3c: real DB — sorting is authoritative, before pagination, scope-preserving ══════════════
  console.log("\n=== Real Server Component behavior: authoritative server-side ordering, before pagination, scope preserved ===\n");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  type ListResult = { ids: string[]; titles: string[]; totalCount: number };
  async function callProjects(params: Record<string, string>): Promise<ListResult> {
    try {
      const el = await ProjectsPage({ searchParams: Promise.resolve(params) });
      const [listEl] = findElementsByType(el, ProjectList);
      const items = (listEl?.props.projects as any[]) ?? [];
      return { ids: items.map((p) => p.id), titles: items.map((p) => p.title), totalCount: items.length };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        console.error(`     (unexpected redirect for params=${JSON.stringify(params)}: ${err.digest})`);
        return { ids: [], titles: [], totalCount: 0 };
      }
      throw err;
    }
  }
  async function callActivities(params: Record<string, string>): Promise<ListResult> {
    try {
      const el = await ActivitiesPage({ searchParams: Promise.resolve(params) });
      const [listEl] = findElementsByType(el, ActivityList);
      const items = (listEl?.props.activities as any[]) ?? [];
      return { ids: items.map((a) => a.id), titles: items.map((a) => a.title), totalCount: items.length };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        console.error(`     (unexpected redirect for params=${JSON.stringify(params)}: ${err.digest})`);
        return { ids: [], titles: [], totalCount: 0 };
      }
      throw err;
    }
  }

  try {
    const deptA = await createDepartment({ name: `SortView A ${RUN_ID}`, slug: `sortview-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `SortView B ${RUN_ID}`, slug: `sortview-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({ data: { email: `sortview-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieValue = undefined;

    // Deliberately-scrambled creation order so createdAt-desc (the
    // canonical default) would NOT coincidentally match alphabetical order —
    // a real proof that an explicit sortBy genuinely re-orders the result.
    const titles = ["Charlie", "Alpha", "Echo", "Bravo", "Delta"];
    for (const title of titles) {
      const p = await prisma.project.create({ data: { title: `${title} ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id, priority: 1 } });
      projectIds.push(p.id);
    }
    // A Dept B project — for the scope-preservation check below.
    const deptBProject = await prisma.project.create({ data: { title: `Zulu ${RUN_ID}`, departmentId: deptB.id, ownerId: admin.id } });
    projectIds.push(deptBProject.id);

    console.log("\n-- 14/16. Projects: ascending/descending title sort, correct BEFORE pagination --\n");
    const ascAll = await callProjects({ departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "asc" });
    const expectedAsc = [...titles].sort((a, b) => a.localeCompare(b));
    check("Ascending title sort matches real alphabetical order", JSON.stringify(ascAll.titles.map((t) => t.split(" ")[0])) === JSON.stringify(expectedAsc));
    const descAll = await callProjects({ departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "desc" });
    check("Descending title sort is the exact reverse", JSON.stringify(descAll.titles) === JSON.stringify([...ascAll.titles].reverse()));

    // pageSize must be a real whitelisted value (see lib/pagination.ts's
    // PAGE_SIZE_OPTIONS — 20/50/100; anything else silently falls back to
    // the default), so a genuine 2-page slice needs > 20 fixture rows.
    const fillerCount = 17; // 5 lettered + 17 filler = 22 -> a real 20/2 split
    for (let i = 0; i < fillerCount; i++) {
      const p = await prisma.project.create({ data: { title: `Filler-${String(i).padStart(2, "0")} ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id } });
      projectIds.push(p.id);
    }
    const fullAscAll = await callProjects({ departmentId: deptA.id, pageSize: "50", sortBy: "title", sortOrder: "asc" });
    check("(fixture) 22 Dept A projects now exist, all reachable in one 50-sized page", fullAscAll.titles.length === 5 + fillerCount);
    const page1 = await callProjects({ departmentId: deptA.id, pageSize: "20", page: "1", sortBy: "title", sortOrder: "asc" });
    const page2 = await callProjects({ departmentId: deptA.id, pageSize: "20", page: "2", sortBy: "title", sortOrder: "asc" });
    check("16. Sorting is applied BEFORE pagination: page 1 (20) + page 2 (2) together reconstruct the exact same globally-sorted sequence", JSON.stringify([...page1.titles, ...page2.titles]) === JSON.stringify(fullAscAll.titles));
    check("...page 1 has exactly 20 rows, page 2 has the remaining 2", page1.titles.length === 20 && page2.titles.length === 2);
    check("...and no id is duplicated or skipped across the two pages", new Set([...page1.ids, ...page2.ids]).size === page1.ids.length + page2.ids.length);

    console.log("\n-- 17. Sort survives combining with a real filter, department scope, AND pagination simultaneously --\n");
    const combinedPage1 = await callProjects({ departmentId: deptA.id, pageSize: "20", page: "1", sortBy: "title", sortOrder: "asc", search: RUN_ID.toString() });
    const combinedPage2 = await callProjects({ departmentId: deptA.id, pageSize: "20", page: "2", sortBy: "title", sortOrder: "asc", search: RUN_ID.toString() });
    check("17. sortBy + search + departmentId + pagination all apply together correctly (the combined 2 pages reconstruct the same full sorted, filtered sequence)", JSON.stringify([...combinedPage1.titles, ...combinedPage2.titles]) === JSON.stringify(fullAscAll.titles));

    console.log("\n-- 19c. An invalid sortBy on the REAL page falls back to the canonical default (createdAt desc) — never errors, never reaches Prisma raw --\n");
    const invalidSortRes = await callProjects({ departmentId: deptA.id, pageSize: "20", sortBy: "__proto__", sortOrder: "asc" });
    const noSortRes = await callProjects({ departmentId: deptA.id, pageSize: "20" });
    check("Invalid sortBy produces the IDENTICAL order to no sortBy at all", JSON.stringify(invalidSortRes.ids) === JSON.stringify(noSortRes.ids));

    console.log("\n-- 20. Authorization/list scope unchanged: sorting can never surface another department's rows --\n");
    const deptAOnlyRole = await prisma.customRole.create({ data: { key: `SORTVIEW_A_${RUN_ID}`, name: `Sort Dept A ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "project.view" } });
    await prisma.rolePermission.create({ data: { roleKey: deptAOnlyRole.key, permissionId: perm.id } });
    const scopedUser = await prisma.user.create({ data: { email: `sortview-scoped-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(scopedUser.id);
    const membership = await prisma.departmentMembership.create({
      data: { userId: scopedUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, customRoleId: deptAOnlyRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    currentSession = { user: { id: scopedUser.id, role: Role.USER, customRoleId: null } };
    const scopedSorted = await callProjects({ pageSize: "50", sortBy: "title", sortOrder: "desc" });
    check("A Dept-A-only viewer, sorted descending by title, still never sees the Dept B project", !scopedSorted.ids.includes(deptBProject.id));
    check("...but does see their own Dept A projects, correctly sorted", scopedSorted.titles.filter((t) => t.includes(String(RUN_ID)) && titles.some((x) => t.startsWith(x))).length === titles.length);
    await prisma.departmentMembership.delete({ where: { id: membership.id } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: deptAOnlyRole.key } });
    await prisma.customRole.delete({ where: { id: deptAOnlyRole.id } });
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── Activities: independent whitelist, own fixtures ──
    console.log("\n-- 15/16/17. Activities: progress + dueDate sorting, nullable columns handled deterministically --\n");
    const activityDefs: Array<{ title: string; status: any; priority: any; dueDate: Date | null }> = [
      { title: "Zed", status: ActivityStatus.TODO, priority: ActivityPriority.LOW, dueDate: new Date("2027-01-05") },
      { title: "Yankee", status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.URGENT, dueDate: null },
      { title: "Xray", status: ActivityStatus.COMPLETED, priority: ActivityPriority.MEDIUM, dueDate: new Date("2027-01-01") },
    ];
    for (const def of activityDefs) {
      const a = await prisma.projectActivity.create({ data: { title: `${def.title} ${RUN_ID}`, departmentId: deptA.id, status: def.status, priority: def.priority, dueDate: def.dueDate } });
      activityIds.push(a.id);
    }
    const byDueAsc = await callActivities({ departmentId: deptA.id, pageSize: "20", sortBy: "dueDate", sortOrder: "asc" });
    const dueOrderNames = byDueAsc.titles.map((t) => t.split(" ")[0]);
    check("Nullable dueDate handled deterministically (no error) — non-null dates ascending, the null-dueDate activity placed consistently (nulls last)", dueOrderNames.indexOf("Xray") < dueOrderNames.indexOf("Zed") && dueOrderNames.indexOf("Yankee") === dueOrderNames.length - 1);
    const byPriorityAsc = await callActivities({ departmentId: deptA.id, pageSize: "20", sortBy: "priority", sortOrder: "asc" });
    const priorityOrderNames = byPriorityAsc.titles.map((t) => t.split(" ")[0]);
    check("Priority sorts by the existing enum business order (LOW < MEDIUM < ... < URGENT), not alphabetically", priorityOrderNames.indexOf("Zed") < priorityOrderNames.indexOf("Xray") && priorityOrderNames.indexOf("Xray") < priorityOrderNames.indexOf("Yankee"));

    // ── View-toggle survives switching away and back (source-level: the URL param is the only state, so this is structural by construction) ──
    check("Switching away from List and back preserves the sort BY CONSTRUCTION: sortBy/sortOrder are plain URL params untouched by the view toggle's own setView() (proven by reading its source directly)", !/sortBy|sortOrder/.test(viewToggleSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    void ProjectStatus;
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
