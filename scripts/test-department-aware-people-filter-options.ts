/**
 * Regression coverage for the Project/Activity list pages' people-filter
 * (Owner/Member/Assignee) dropdown options becoming department-aware.
 *
 * ROOT CAUSE (confirmed by reading, then reproduced below): both
 * app/(main)/projects/page.tsx and app/(main)/activities/page.tsx populated
 * their Owner/Member/Assignee dropdowns from
 *   prisma.user.findMany({ where: { role: { in: [ADMIN, IT_AGENT,
 *     DEPARTMENT_MANAGER, DIRECTOR] }, isActive: true }, ... })
 * — a query completely disconnected from Project.owner/Project.members/
 * ProjectActivity.assignedUsers, from the currently selected Department,
 * and from the viewer's own authorized list scope. Any CustomRole user
 * (the normal case for a department-scoped person) has a generic global
 * `role` of USER, so they were NEVER included regardless of how genuinely
 * involved they were in real projects/activities — only the four hardcoded
 * built-in roles ever appeared, exactly the "Member/Owner/Assignee
 * dropdowns primarily show administrators" symptom.
 *
 * FIX: lib/services/project-query-service.ts's getProjectOwnerOptions/
 * getProjectMemberOptions and lib/services/activity-query-service.ts's
 * getActivityAssigneeOptions — each queries `User` filtered by its real
 * back-relation (ownedProjects/projectMemberships/activityAssignments)
 * `{some: scopeWhere}`, where `scopeWhere` is the EXACT SAME
 * buildProjectListWhere/buildActivityListWhere result (authorization +
 * selected Department) the main list query already uses as its own base
 * condition — never a second, weaker, or role-based authorization path.
 *
 * SECTION A is a source-text guard for the exact query shape and the
 * client-only dependent-filter-reset logic (no real DOM exists in this
 * suite to drive a Department Select change — established convention, see
 * scripts/test-inline-create-with-attachments.ts). SECTION B drives the
 * REAL /projects and /activities Server Component pages against a real
 * database.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-department-aware-people-filter-options.ts
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
  // ══════════════════════ SECTION A — source-text guard ══════════════════════
  console.log("\n=== SECTION A — query shape, no hardcoded roles, dependent-filter reset, no new controls ===\n");

  const projectQuerySrc = await fs.readFile("lib/services/project-query-service.ts", "utf8");
  const activityQuerySrc = await fs.readFile("lib/services/activity-query-service.ts", "utf8");
  const projectsPageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  const activitiesPageSrc = await fs.readFile("app/(main)/activities/page.tsx", "utf8");
  const projectFiltersSrc = await fs.readFile("components/projects/project-filters.tsx", "utf8");
  const activityFiltersSrc = await fs.readFile("components/activities/activity-filters.tsx", "utf8");

  check("16. Neither Project nor Activity page's people-option source hardcodes a built-in role list (ADMIN/IT_AGENT/DEPARTMENT_MANAGER/DIRECTOR) anywhere", !/role:\s*\{\s*in:\s*\[.*ADMIN/.test(projectsPageSrc) && !/role:\s*\{\s*in:\s*\[.*ADMIN/.test(activitiesPageSrc));
  check("...nor do the new service functions themselves", !/role:\s*\{\s*in:/.test(projectQuerySrc) && !/role:\s*\{\s*in:/.test(activityQuerySrc));

  check("3. getProjectOwnerOptions queries the REAL Project.owner back-relation (ownedProjects), not a disconnected User query", /ownedProjects:\s*\{\s*some:\s*scopeWhere/.test(projectQuerySrc));
  check("3. getProjectMemberOptions queries the REAL Project.members back-relation (projectMemberships)", /projectMemberships:\s*\{\s*some:\s*scopeWhere/.test(projectQuerySrc));
  check("3. getActivityAssigneeOptions queries the REAL ProjectActivity.assignedUsers back-relation (activityAssignments)", /activityAssignments:\s*\{\s*some:\s*scopeWhere/.test(activityQuerySrc));

  check("6/10. Neither new option function filters on isActive — a historical/inactive user stays eligible as long as they're still attached to a visible entity", !/isActive/.test(projectQuerySrc.slice(projectQuerySrc.indexOf("getProjectOwnerOptions"))) && !/isActive/.test(activityQuerySrc.slice(activityQuerySrc.indexOf("getActivityAssigneeOptions"))));

  check("17. Each option function is exactly ONE prisma.user.findMany call — no per-row loop, no second query", (projectQuerySrc.match(/prisma\.user\.findMany/g) ?? []).length === 2 && (activityQuerySrc.match(/prisma\.user\.findMany/g) ?? []).length === 1);
  check("17. The Projects page's own option fetches are plain awaited promises inside the SAME Promise.all as the main list query — not a request-per-dropdown-item loop", /getProjectOwnerOptions\(scope/.test(projectsPageSrc) && /getProjectMemberOptions\(scope/.test(projectsPageSrc));
  check("17. Same for the Activities page's assignee options", /getActivityAssigneeOptions\(scope/.test(activitiesPageSrc));
  check("Neither page fetches the full User table (no bare prisma.user.findMany() without a relation-based where)", !/prisma\.user\.findMany\(\{\s*where:\s*\{\s*role/.test(projectsPageSrc) && !/prisma\.user\.findMany\(\{\s*where:\s*\{\s*role/.test(activitiesPageSrc));

  check("Options are scoped from `scope` (authorization + selected Department only) — never from `where` (which also carries status/priority/search/date filters), so unrelated filter changes don't narrow the dropdowns", !/getProjectOwnerOptions\(where/.test(projectsPageSrc) && !/getActivityAssigneeOptions\(where/.test(activitiesPageSrc));

  console.log("\n=== Owner/Member/Assignee are genuinely separate option lists, not one shared array ===\n");
  check("ProjectFilterOptions declares distinct `owners` and `members` fields (not a single shared `users` array)", /owners:\s*\{\s*id:\s*string;\s*name:\s*string \| null\s*\}\[\]/.test(projectFiltersSrc) && /members:\s*\{\s*id:\s*string;\s*name:\s*string \| null\s*\}\[\]/.test(projectFiltersSrc));
  check("The Owner Select renders from options.owners", /options\.owners\.map/.test(projectFiltersSrc));
  check("The Member Select renders from options.members (a DIFFERENT array than Owner's)", /options\.members\.map/.test(projectFiltersSrc));
  check("ActivityFilterOptions declares a dedicated `assignees` field", /assignees:\s*\{\s*id:\s*string;\s*name:\s*string \| null\s*\}\[\]/.test(activityFiltersSrc));
  check("The Assignee Select renders from options.assignees", /options\.assignees\.map/.test(activityFiltersSrc));

  console.log("\n=== 12. Dependent-filter reset: Department change clears the person filter(s) + subDepartment, alongside the existing page-reset ===\n");
  const projectDeptHandler = projectFiltersSrc.slice(projectFiltersSrc.indexOf("const handleDepartmentSelect"), projectFiltersSrc.indexOf("};", projectFiltersSrc.indexOf("const handleDepartmentSelect")));
  check("Projects: handleDepartmentSelect clears ownerId", /ownerId:\s*null/.test(projectDeptHandler));
  check("Projects: handleDepartmentSelect clears memberId", /memberId:\s*null/.test(projectDeptHandler));
  check("Projects: handleDepartmentSelect still clears subDepartmentId too (pre-existing, unchanged)", /subDepartmentId:\s*null/.test(projectDeptHandler));
  const activityDeptHandler = activityFiltersSrc.slice(activityFiltersSrc.indexOf("const handleDepartmentSelect"), activityFiltersSrc.indexOf("};", activityFiltersSrc.indexOf("const handleDepartmentSelect")));
  check("Activities: handleDepartmentSelect clears assignedUserId", /assignedUserId:\s*null/.test(activityDeptHandler));
  check("Activities: handleDepartmentSelect still clears subDepartmentId too", /subDepartmentId:\s*null/.test(activityDeptHandler));

  console.log("\n=== 13. Unrelated filters/sort/pageSize/view survive every push() — only `page` is ever unconditionally dropped ===\n");
  const projectPushBody = projectFiltersSrc.slice(projectFiltersSrc.indexOf("const push = useCallback"), projectFiltersSrc.indexOf("const handleSearchSubmit"));
  check("Projects: push() only ever deletes the `page` param unconditionally — sortBy/pageSize/view are never touched by it", /params\.delete\("page"\)/.test(projectPushBody) && !/params\.delete\("sortBy"\)/.test(projectPushBody) && !/params\.delete\("view"\)/.test(projectPushBody) && !/params\.delete\("pageSize"\)/.test(projectPushBody));
  const activityPushBody = activityFiltersSrc.slice(activityFiltersSrc.indexOf("const push = useCallback"), activityFiltersSrc.indexOf("const handleSearchSubmit"));
  check("Activities: same — only `page` is ever unconditionally dropped", /params\.delete\("page"\)/.test(activityPushBody) && !/params\.delete\("sortBy"\)/.test(activityPushBody) && !/params\.delete\("view"\)/.test(activityPushBody) && !/params\.delete\("pageSize"\)/.test(activityPushBody));

  console.log("\n=== 19. No new filter control was added ===\n");
  check("ProjectFilters still has exactly the pre-existing set of quick/advanced controls — Owner/Member/Department/Status/Priority/Sub-Department/date ranges (11 labeled fields), nothing new added", (projectFiltersSrc.match(/<Label className="text-xs text-muted-foreground">/g) ?? []).length === 11);
  check("ActivityFilters still has exactly the pre-existing set of controls (9 labeled fields), nothing new added", (activityFiltersSrc.match(/<Label className="text-xs text-muted-foreground">/g) ?? []).length === 9);

  // ══════════════════════ SECTION B — real pages, real DB ══════════════════════
  console.log("\n=== SECTION B — real /projects and /activities pages against a real database ===\n");

  let mods: { ProjectsPage: any; ProjectFilters: any; ActivitiesPage: any; ActivityFilters: any };
  try {
    mods = {
      ProjectsPage: (await import("@/app/(main)/projects/page")).default,
      ProjectFilters: (await import("@/components/projects/project-filters")).ProjectFilters,
      ActivitiesPage: (await import("@/app/(main)/activities/page")).default,
      ActivityFilters: (await import("@/components/activities/activity-filters")).ActivityFilters,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { ProjectsPage, ProjectFilters, ActivitiesPage, ActivityFilters } = mods;

  const { prisma } = await import("@/lib/prisma");
  const { AuthProvider, Role, RoleScope } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeCustomRole(tag: string, permissionKeys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `DAPF_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  const renderProjects = async (params: Record<string, string>) => {
    const el = await ProjectsPage({ searchParams: Promise.resolve(params) });
    return findElementsByType(el, ProjectFilters)[0]?.props?.options;
  };
  const renderActivities = async (params: Record<string, string>) => {
    const el = await ActivitiesPage({ searchParams: Promise.resolve(params) });
    return findElementsByType(el, ActivityFilters)[0]?.props?.options;
  };

  try {
    const deptA = await createDepartment({ name: `DAPF Dept A ${RUN_ID}`, slug: `dapf-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `DAPF Dept B ${RUN_ID}`, slug: `dapf-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const noopGlobalRole = await makeCustomRole("NOOP", []);
    const viewRoleA = await makeCustomRole("VIEW_A", ["project.view", "activity.view"]);
    const viewRoleB = await makeCustomRole("VIEW_B", ["project.view", "activity.view"]);

    // Admin viewer — sees every department, used for the "Any department" union test.
    const adminUser = await prisma.user.create({ data: { email: `dapf-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(adminUser.id);

    // A department-scoped viewer with access ONLY to Dept A — used to prove
    // unauthorized-department users are never exposed, even under "Any department".
    const deptAOnlyViewer = await prisma.user.create({ data: { email: `dapf-viewer-a-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAOnlyViewer.id);
    await (await import("@/lib/services/department-membership-service")).grantManualMembership(deptAOnlyViewer.id, deptA.id, { customRoleId: viewRoleA.id });

    // Every "person" fixture below is a CustomRole USER — never a built-in
    // ADMIN/IT_AGENT/DEPARTMENT_MANAGER/DIRECTOR — deliberately, so any
    // appearance in the options proves the fix is NOT still role-based.
    const ownerX = await prisma.user.create({ data: { email: `dapf-ownerx-${RUN_ID}@kinsen.gr`, name: `DAPF OwnerX ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const memberY = await prisma.user.create({ data: { email: `dapf-membery-${RUN_ID}@kinsen.gr`, name: `DAPF MemberY ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const assigneeW = await prisma.user.create({ data: { email: `dapf-assigneew-${RUN_ID}@kinsen.gr`, name: `DAPF AssigneeW ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const inactiveOwner = await prisma.user.create({ data: { email: `dapf-inactive-${RUN_ID}@kinsen.gr`, name: `DAPF InactiveOwner ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: false } });
    const unrelatedUser = await prisma.user.create({ data: { email: `dapf-unrelated-${RUN_ID}@kinsen.gr`, name: `DAPF Unrelated ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const deptBOnlyOwner = await prisma.user.create({ data: { email: `dapf-deptb-${RUN_ID}@kinsen.gr`, name: `DAPF DeptBOwner ${RUN_ID}`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(ownerX.id, memberY.id, assigneeW.id, inactiveOwner.id, unrelatedUser.id, deptBOnlyOwner.id);

    // Two Dept A projects, both owned/membered by the SAME ownerX/memberY — dedup proof (item 7/15).
    const projectA1 = await prisma.project.create({ data: { title: `DAPF Project A1 ${RUN_ID}`, departmentId: deptA.id, ownerId: ownerX.id, members: { connect: [{ id: memberY.id }] } } });
    const projectA2 = await prisma.project.create({ data: { title: `DAPF Project A2 ${RUN_ID}`, departmentId: deptA.id, ownerId: ownerX.id, members: { connect: [{ id: memberY.id }] } } });
    const projectA3 = await prisma.project.create({ data: { title: `DAPF Project A3 (inactive owner) ${RUN_ID}`, departmentId: deptA.id, ownerId: inactiveOwner.id } });
    const projectB1 = await prisma.project.create({ data: { title: `DAPF Project B1 ${RUN_ID}`, departmentId: deptB.id, ownerId: deptBOnlyOwner.id } });
    projectIds.push(projectA1.id, projectA2.id, projectA3.id, projectB1.id);

    // Two Dept A activities both assigned to the SAME assigneeW — dedup proof.
    const activityA1 = await prisma.projectActivity.create({ data: { title: `DAPF Activity A1 ${RUN_ID}`, departmentId: deptA.id, status: "TODO", assignedUsers: { connect: [{ id: assigneeW.id }] } } });
    const activityA2 = await prisma.projectActivity.create({ data: { title: `DAPF Activity A2 ${RUN_ID}`, departmentId: deptA.id, status: "TODO", assignedUsers: { connect: [{ id: assigneeW.id }] } } });
    activityIds.push(activityA1.id, activityA2.id);

    console.log("\n-- 1. OLD (role-based) query reproduces the reported admin-only bug --\n");
    const oldStyleOptions = await prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER, Role.DIRECTOR] }, isActive: true },
      select: { id: true },
    });
    check("The OLD role-based query excludes a genuine, real Dept A CustomRole Project owner (ownerX) — reproducing the reported bug", !oldStyleOptions.some((u) => u.id === ownerX.id));
    check("...and excludes the CustomRole member/assignee too", !oldStyleOptions.some((u) => u.id === memberY.id) && !oldStyleOptions.some((u) => u.id === assigneeW.id));

    console.log("\n-- 2/3/4/5/7. Department A selected: real Dept A owner/member/assignee appear, deduplicated, CustomRole users included --\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieValue = deptA.id;
    const projectOptionsA = await renderProjects({ view: "list", departmentId: deptA.id });
    check("2. Department A Project owner (ownerX, a CustomRole user) appears in the Owner options", projectOptionsA?.owners?.some((u: any) => u.id === ownerX.id));
    check("3. Department A Project member (memberY, a CustomRole user) appears in the Member options", projectOptionsA?.members?.some((u: any) => u.id === memberY.id));
    check("7. ownerX appears EXACTLY ONCE in Owner options despite owning TWO Dept A projects (deduplicated)", projectOptionsA?.owners?.filter((u: any) => u.id === ownerX.id).length === 1);
    check("7. memberY appears exactly once in Member options despite being a member of two Dept A projects", projectOptionsA?.members?.filter((u: any) => u.id === memberY.id).length === 1);

    const activityOptionsA = await renderActivities({ view: "list", departmentId: deptA.id });
    check("4. Department A Activity assignee (assigneeW, a CustomRole user) appears in the Assignee options", activityOptionsA?.assignees?.some((u: any) => u.id === assigneeW.id));
    check("7. assigneeW appears exactly once despite being assigned to two Dept A activities (deduplicated)", activityOptionsA?.assignees?.filter((u: any) => u.id === assigneeW.id).length === 1);

    console.log("\n-- 6. A Department B-only user is absent from Department A options --\n");
    check("deptBOnlyOwner (only owns a Dept B project) is absent from Department A's Owner options", !projectOptionsA?.owners?.some((u: any) => u.id === deptBOnlyOwner.id));

    console.log("\n-- 10. An inactive historical user remains available when still attached to a visible entity --\n");
    check("inactiveOwner (isActive: false) still appears in Department A's Owner options — still genuinely owns a visible Dept A project", projectOptionsA?.owners?.some((u: any) => u.id === inactiveOwner.id));

    console.log("\n-- 11. A user with no relevant Owner/Member/Assignee relation is absent --\n");
    check("unrelatedUser (exists, active, but owns/member/assigns nothing) is absent from Owner options", !projectOptionsA?.owners?.some((u: any) => u.id === unrelatedUser.id));
    check("...absent from Member options too", !projectOptionsA?.members?.some((u: any) => u.id === unrelatedUser.id));
    check("...and absent from Assignee options", !activityOptionsA?.assignees?.some((u: any) => u.id === unrelatedUser.id));

    console.log("\n-- 15. Owner and Member option lists are genuinely different — proven with a real owner-but-not-member --\n");
    check("ownerX (owner of A1/A2, never added as a member) appears in Owner options", projectOptionsA?.owners?.some((u: any) => u.id === ownerX.id));
    check("...but does NOT appear in Member options (never connected as a member anywhere)", !projectOptionsA?.members?.some((u: any) => u.id === ownerX.id));

    console.log("\n-- 8. 'Any department' (ADMIN viewer) returns the deduplicated union across all departments --\n");
    // ADMIN with NO active-department cookie does NOT default to "Any
    // department" — it resolves to the first active department by name
    // (see lib/services/workspace-service.ts's resolveActiveWorkspace) —
    // "Any department" is only ever the EXPLICIT ALL_WORKSPACES_VALUE
    // selection, so that's what must be set here to genuinely exercise it.
    currentCookieValue = "ALL";
    const projectOptionsAny = await renderProjects({ view: "list" });
    check("Any-department Owner options include the Dept A owner", projectOptionsAny?.owners?.some((u: any) => u.id === ownerX.id));
    check("...AND the Dept B owner too (union across departments, ADMIN is authorized for both)", projectOptionsAny?.owners?.some((u: any) => u.id === deptBOnlyOwner.id));
    check("...with ownerX still appearing exactly once even though he owns 2 projects", projectOptionsAny?.owners?.filter((u: any) => u.id === ownerX.id).length === 1);

    console.log("\n-- 9. Users from unauthorized departments are never exposed, even under 'Any department', for a department-scoped viewer --\n");
    currentSession = { user: { id: deptAOnlyViewer.id, role: Role.USER, customRoleId: noopGlobalRole.id } };
    currentCookieValue = "ALL";
    const projectOptionsAnyScoped = await renderProjects({ view: "list" });
    check("A Dept-A-only viewer's 'Any department' Owner options include the Dept A owner", projectOptionsAnyScoped?.owners?.some((u: any) => u.id === ownerX.id));
    check("...but NEVER the Dept B-only owner — Dept B is outside this viewer's authorized scope entirely", !projectOptionsAnyScoped?.owners?.some((u: any) => u.id === deptBOnlyOwner.id));

    console.log("\n-- 14. A crafted ownerId for a user outside the viewer's scope only restricts, never expands, results --\n");
    currentSession = { user: { id: deptAOnlyViewer.id, role: Role.USER, customRoleId: noopGlobalRole.id } };
    currentCookieValue = deptA.id;
    const { ProjectList } = await import("@/components/projects/project-list");
    const craftedEl = await ProjectsPage({ searchParams: Promise.resolve({ view: "list", departmentId: deptA.id, ownerId: deptBOnlyOwner.id }) });
    const craftedListProps = findElementsByType(craftedEl, ProjectList)[0]?.props;
    check("A crafted ownerId belonging to an out-of-scope user returns ZERO projects — never a Dept B project leaking through", (craftedListProps?.projects ?? []).length === 0);

    console.log("\n-- Dept A -> Dept B: options genuinely change, proving they're live-scoped, not a static snapshot --\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieValue = deptB.id;
    const projectOptionsB = await renderProjects({ view: "list", departmentId: deptB.id });
    check("Department B's Owner options include the Dept B owner", projectOptionsB?.owners?.some((u: any) => u.id === deptBOnlyOwner.id));
    check("...but NOT the Dept A owner (ownerX) — genuinely re-scoped, not a leftover from Department A", !projectOptionsB?.owners?.some((u: any) => u.id === ownerX.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityProgressConfig", () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["projectStatusConfig", () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityStatusConfig", () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityPriorityConfig", () => prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
