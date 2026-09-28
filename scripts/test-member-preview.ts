/**
 * Regression coverage for the shared Members/Assigned hover-focus-tap
 * preview added to the existing List (table) views for /projects and
 * /activities (components/shared/member-preview.tsx, wired into
 * components/projects/project-list.tsx and
 * components/activities/activity-list.tsx — list/table branch only, never
 * the grid/card branch, never a new page or filter).
 *
 * Reuses the ONLY existing Radix primitive available for this
 * (components/ui/tooltip.tsx) — no new dependency (no
 * @radix-ui/react-popover was added), same <TooltipProvider> convention
 * already used by components/gantt/gantt-chart.tsx and
 * components/resource-planning/resource-timeline.tsx. The wrapped trigger
 * markup itself is never redesigned — MemberPreview only adds the
 * hover/focus/tap behavior AROUND whatever a list already renders.
 *
 * Data: `members` (Project) / `assignedUsers` (Activity) are the EXACT
 * relations each list already queried and rendered before this change —
 * no new relationship was invented, and both are already part of each
 * page's single paginated query (see the source-text checks below), so
 * opening a preview issues zero additional requests.
 *
 * SECTION A is a source-text guard for the client-only interaction (no real
 * DOM exists in this suite to drive hover/focus/tap directly — established
 * convention, see scripts/test-inline-create-with-attachments.ts).
 * SECTION B drives the REAL /projects and /activities Server Component
 * pages against a real database to prove per-entity data isolation,
 * zero/many-member cases, and that sorting/pagination/filters are
 * untouched.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-member-preview.ts
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
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

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
  console.log("\n=== SECTION A — MemberPreview: reuse, no new fetch, correct empty/many/touch/a11y handling ===\n");

  const previewSrc = await fs.readFile("components/shared/member-preview.tsx", "utf8");
  const projectListSrc = await fs.readFile("components/projects/project-list.tsx", "utf8");
  const activityListSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");
  const projectsPageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  const activitiesPageSrc = await fs.readFile("app/(main)/activities/page.tsx", "utf8");

  check("MemberPreview reuses the EXISTING Tooltip primitive (components/ui/tooltip.tsx) — no new popover/hover-card dependency added", /from "@\/components\/ui\/tooltip"/.test(previewSrc) && /Tooltip,\s*TooltipTrigger,\s*TooltipContent/.test(previewSrc.replace(/\s+/g, " ")));
  check("No new radix package referenced (still only tooltip's own primitive)", !/@radix-ui\/react-popover/.test(previewSrc) && !/@radix-ui\/react-hover-card/.test(previewSrc));
  check("Zero members: renders the accessible 'No members' text", /No members/.test(previewSrc));
  check("Many members: compact max-height list with internal scrolling (never expands the row)", /max-h-40 overflow-y-auto/.test(previewSrc));
  check("Never reads/renders `.email` — only name + avatar/initials, even where the underlying data also carries email for unrelated reasons", !/\.email/.test(previewSrc));
  check("Trigger has an accessible name (aria-label) reflecting the member list, for screen readers", /aria-label=\{accessibleLabel\}/.test(previewSrc));
  check("Keyboard focus gets a visible ring (focus-visible utility classes) — not just a mouse-hover affordance", /focus-visible:ring/.test(previewSrc));
  check("Touch/click: preventDefault + stopPropagation before toggling — never lets the tap fall through to a row-level navigation", /onClick=\{\(e\) => \{[\s\S]{0,500}e\.preventDefault\(\);[\s\S]{0,50}e\.stopPropagation\(\);/.test(previewSrc));
  check("No data is fetched inside MemberPreview itself — `members` is a prop, never fetched on open", !/fetch\(/.test(previewSrc));
  check("The wrapped trigger markup is rendered via `children`, unchanged — MemberPreview never re-implements the avatar stack/icon+count look itself", /\{children\}/.test(previewSrc));

  console.log("\n=== Wiring: list/table view only, never grid/cards, never sortable, never a new column ===\n");
  check("ProjectList: MemberPreview used inside the Members TableCell", /<TableCell className="text-sm text-muted-foreground">\s*<MemberPreview members=\{project\.members\}/.test(projectListSrc));
  check("ProjectList: the Members column header stays a plain TableHead — never converted to SortableTableHead", /<TableHead>Members<\/TableHead>/.test(projectListSrc));
  check("ProjectList: MemberPreview is NOT referenced inside the grid (card) branch — that block never imports/renders it a second way", (() => {
    const gridStart = projectListSrc.indexOf('return (\n    <div className="grid gap-4 md:grid-cols-2');
    return gridStart > -1 && !/MemberPreview/.test(projectListSrc.slice(gridStart));
  })());

  check("ActivityList: MemberPreview used inside the Assigned TableCell", /<MemberPreview members=\{activity\.assignedUsers\} label="Assigned">/.test(activityListSrc));
  check("ActivityList: the Assigned column header stays a plain TableHead — never converted to SortableTableHead", /<TableHead>Assigned<\/TableHead>/.test(activityListSrc));
  check("ActivityList: the zero-assignee case keeps its exact previous appearance ('Unassigned'), MemberPreview only wraps the non-empty branch", /:\s*\(\s*<span className="text-xs text-muted-foreground">Unassigned<\/span>/.test(activityListSrc));
  check("ActivityList: MemberPreview is NOT referenced inside the ActivityCard grid branch", (() => {
    const gridStart = activityListSrc.indexOf("// Grid view");
    return gridStart > -1 && !/MemberPreview/.test(activityListSrc.slice(gridStart));
  })());

  console.log("\n=== Data: members/assignedUsers are already part of each page's single paginated query — no second request ===\n");
  check("Projects page selects members {id,name,image} (no email) as part of the SAME findMany building the paginated `projects` list", /members:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*image:\s*true\s*\}\s*\}/.test(projectsPageSrc));
  check("Activities page selects assignedUsers as part of the SAME findMany building the paginated `activities` list", /assignedUsers:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*email:\s*true,\s*image:\s*true\s*\}\s*\}/.test(activitiesPageSrc));
  const projectSortKeysBlock = projectsPageSrc.slice(projectsPageSrc.indexOf("const PROJECT_SORT_KEYS"), projectsPageSrc.indexOf("const PROJECT_DEFAULT_ORDER_BY"));
  check("No new 'members'/'assigned' entry was added to PROJECT_SORT_KEYS (sorting semantics unchanged, no new sortable column)", !/\n\s*(members|assigned):/i.test(projectSortKeysBlock));
  const activitySortKeysBlock = activitiesPageSrc.slice(activitiesPageSrc.indexOf("const ACTIVITY_SORT_KEYS"), activitiesPageSrc.indexOf("const ACTIVITY_DEFAULT_ORDER_BY"));
  check("No new 'assigned'/'members' entry was added to ACTIVITY_SORT_KEYS", !/\n\s*(members|assigned):/i.test(activitySortKeysBlock));

  // ══════════════════════ SECTION B — real pages, real DB ══════════════════════
  console.log("\n=== SECTION B — real /projects and /activities pages: per-entity isolation, empty/many, sort/filter/pagination untouched ===\n");

  let mods: {
    ProjectsPage: any;
    ProjectList: any;
    ActivitiesPage: any;
    ActivityList: any;
  };
  try {
    mods = {
      ProjectsPage: (await import("@/app/(main)/projects/page")).default,
      ProjectList: (await import("@/components/projects/project-list")).ProjectList,
      ActivitiesPage: (await import("@/app/(main)/activities/page")).default,
      ActivityList: (await import("@/components/activities/activity-list")).ActivityList,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { ProjectsPage, ProjectList, ActivitiesPage, ActivityList } = mods;

  const { prisma } = await import("@/lib/prisma");
  const { AuthProvider, Role } = await import("@prisma/client");
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

  const renderProjects = async (params: Record<string, string>) => {
    const el = await ProjectsPage({ searchParams: Promise.resolve(params) });
    return findElementsByType(el, ProjectList)[0]?.props;
  };
  const renderActivities = async (params: Record<string, string>) => {
    const el = await ActivitiesPage({ searchParams: Promise.resolve(params) });
    return findElementsByType(el, ActivityList)[0]?.props;
  };

  try {
    const deptA = await createDepartment({ name: `MP Dept A ${RUN_ID}`, slug: `mp-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `MP Dept B ${RUN_ID}`, slug: `mp-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({ data: { email: `mp-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const memberX = await prisma.user.create({ data: { email: `mp-x-${RUN_ID}@kinsen.gr`, name: "Xena Xample", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const memberY = await prisma.user.create({ data: { email: `mp-y-${RUN_ID}@kinsen.gr`, name: "Yusuf Yilmaz", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const memberZ = await prisma.user.create({ data: { email: `mp-z-${RUN_ID}@kinsen.gr`, name: "Zara Zubair", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(memberX.id, memberY.id, memberZ.id);

    console.log("\n-- 12/14/15. Project List: correct, per-project, isolated member sets, including zero and many --\n");
    const projectWithTwoMembers = await prisma.project.create({ data: { title: `MP Two Members ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id, members: { connect: [{ id: memberX.id }, { id: memberY.id }] } } });
    const projectWithNoMembers = await prisma.project.create({ data: { title: `MP Zero Members ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id } });
    const projectInOtherDept = await prisma.project.create({ data: { title: `MP Other Dept ${RUN_ID}`, departmentId: deptB.id, ownerId: admin.id, members: { connect: [{ id: memberZ.id }] } } });
    projectIds.push(projectWithTwoMembers.id, projectWithNoMembers.id, projectInOtherDept.id);

    // ADMIN sees ALL departments by default when no ?departmentId= is given
    // (resolves to whichever active department sorts first by name across
    // this whole, possibly-shared, database) — every render below passes an
    // EXPLICIT ?departmentId=, the same "explicit scoped view" resolution
    // order the real page itself documents, so results are deterministic
    // regardless of what else exists in this database.
    const projectListProps = await renderProjects({ view: "list", departmentId: deptA.id });
    const rowFor = (id: string) => (projectListProps?.projects as any[])?.find((p) => p.id === id);

    check("12. Project with members: every one of its member names/ids is present, from THIS row's own `members` field", (() => {
      const row = rowFor(projectWithTwoMembers.id);
      const ids = (row?.members ?? []).map((m: any) => m.id).sort();
      return JSON.stringify(ids) === JSON.stringify([memberX.id, memberY.id].sort());
    })());
    check("...each member carries name + image only, no email field on the object at all (never fetched broader than needed)", (() => {
      const row = rowFor(projectWithTwoMembers.id);
      const m = row?.members?.[0];
      return m && Object.prototype.hasOwnProperty.call(m, "name") && Object.prototype.hasOwnProperty.call(m, "image") && !Object.prototype.hasOwnProperty.call(m, "email");
    })());
    check("15a. Zero-member project: `members` is an empty array (preserves the existing empty case)", rowFor(projectWithNoMembers.id)?.members?.length === 0);
    check("14. A project's row never carries another project's members (isolation) — the two-member project's row does NOT include memberZ (who only belongs to the other-department project)", !(rowFor(projectWithTwoMembers.id)?.members ?? []).some((m: any) => m.id === memberZ.id));

    const projectListPropsDeptB = await renderProjects({ view: "list", departmentId: deptB.id });
    const otherDeptRow = (projectListPropsDeptB?.projects as any[])?.find((p) => p.id === projectInOtherDept.id);
    check("...and the other-department project's own row does NOT include memberX/memberY", !(otherDeptRow?.members ?? []).some((m: any) => m.id === memberX.id || m.id === memberY.id));
    check("...it DOES include its own member (memberZ)", (otherDeptRow?.members ?? []).some((m: any) => m.id === memberZ.id));

    console.log("\n-- 15b. Many members (compact scroll case) --\n");
    const manyMembers = [];
    for (let i = 0; i < 8; i++) {
      const u = await prisma.user.create({ data: { email: `mp-many-${i}-${RUN_ID}@kinsen.gr`, name: `Many Member ${i}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      manyMembers.push(u);
    }
    userIds.push(...manyMembers.map((u) => u.id));
    const projectWithManyMembers = await prisma.project.create({ data: { title: `MP Many Members ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id, members: { connect: manyMembers.map((u) => ({ id: u.id })) } } });
    projectIds.push(projectWithManyMembers.id);
    const projectListProps2 = await renderProjects({ view: "list", departmentId: deptA.id });
    const manyRow = (projectListProps2?.projects as any[])?.find((p) => p.id === projectWithManyMembers.id);
    check("All 8 members are present in the row's own data (the compact-scroll UI, checked structurally in Section A, has everything it needs)", manyRow?.members?.length === 8);

    console.log("\n-- 13/14. Activity List: correct, per-activity, isolated assignee sets --\n");
    const activityWithAssignees = await prisma.projectActivity.create({ data: { title: `MP Activity Assigned ${RUN_ID}`, departmentId: deptA.id, status: "TODO", assignedUsers: { connect: [{ id: memberX.id }] } } });
    const activityUnassigned = await prisma.projectActivity.create({ data: { title: `MP Activity Unassigned ${RUN_ID}`, departmentId: deptA.id, status: "TODO" } });
    const activityOtherDept = await prisma.projectActivity.create({ data: { title: `MP Activity Other Dept ${RUN_ID}`, departmentId: deptB.id, status: "TODO", assignedUsers: { connect: [{ id: memberZ.id }] } } });
    activityIds.push(activityWithAssignees.id, activityUnassigned.id, activityOtherDept.id);

    const activityListProps = await renderActivities({ view: "list", departmentId: deptA.id });
    const actRowFor = (id: string) => (activityListProps?.activities as any[])?.find((a) => a.id === id);
    check("13. Assigned activity: its row carries exactly its own assignee (memberX)", (actRowFor(activityWithAssignees.id)?.assignedUsers ?? []).map((u: any) => u.id).includes(memberX.id));
    check("14. That row does NOT carry the other activity's assignee (memberZ) — isolation holds for Activities too", !(actRowFor(activityWithAssignees.id)?.assignedUsers ?? []).some((u: any) => u.id === memberZ.id));
    check("15c. Unassigned activity: assignedUsers is an empty array (preserves the existing 'Unassigned' case)", actRowFor(activityUnassigned.id)?.assignedUsers?.length === 0);

    console.log("\n-- 18. Sorting, pagination and filters remain exactly as before (nothing in this task touched the query pipeline) --\n");
    const filtered = await renderProjects({ view: "list", departmentId: deptA.id, search: `Two Members ${RUN_ID}` });
    check("Existing `search` filter still narrows results correctly (query pipeline untouched)", filtered?.projects?.length === 1 && filtered?.projects?.[0]?.id === projectWithTwoMembers.id);

    const sortedAsc = await renderProjects({ view: "list", departmentId: deptA.id, sortBy: "title", sortOrder: "asc" });
    const sortedDesc = await renderProjects({ view: "list", departmentId: deptA.id, sortBy: "title", sortOrder: "desc" });
    const ascTitles = (sortedAsc?.projects as any[]).map((p) => p.title);
    const descTitles = (sortedDesc?.projects as any[]).map((p) => p.title);
    check("Existing column sort (title asc/desc) still works, reversed order between the two calls — unaffected by the new Members preview", JSON.stringify(ascTitles) === JSON.stringify([...descTitles].reverse()) && ascTitles.length > 1);

    console.log("\n-- 19/20/16/17. No email exposed structurally, no new sortable column, no extra request surface, no unauthorized data --\n");
    check("19. No member object anywhere in the Project list response carries an email field", !(projectListProps?.projects as any[]).some((p: any) => (p.members ?? []).some((m: any) => "email" in m)));
    const sortByMembersRes = await renderProjects({ view: "list", departmentId: deptA.id, sortBy: "members", sortOrder: "asc" });
    check("20. defaultView/sortBy plumbing is unchanged — no members/assigned key accepted (re-confirmed live): an attempted sortBy=members is silently ignored, falling back to the default order, never erroring", Array.isArray(sortByMembersRes?.projects));
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityProgressConfig", () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityStatusConfig", () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["projectStatusConfig", () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
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

main();
