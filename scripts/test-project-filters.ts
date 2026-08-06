/**
 * End-to-end verification of the All Projects list's new URL-driven
 * filtering (app/(main)/projects/page.tsx) — exercises the REAL Server
 * Component function directly (not a reimplementation) with a mocked
 * @/lib/auth session and a mocked next/headers cookies() (so
 * getActiveWorkspace resolves to a specific test department instead of
 * throwing outside a real request scope). The page's returned React element
 * tree is walked as plain data (never rendered/hydrated) to read exactly
 * which projects ProjectList/ProjectPaginationBar were given — no DOM, no
 * react-dom/server, so client components inside the tree are never actually
 * invoked.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-filters.ts
 */
import { mock } from "node:test";
import * as React from "react";
// tsx/esbuild compiles this repo's .tsx files with the classic JSX runtime
// (React.createElement), which assumes `React` is a global in scope — true
// under Next's own build pipeline, not true when a plain Node script
// dynamic-imports a Server Component module directly like this test does.
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, ProjectStatus, ActivityStatus, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined),
    }),
    headers: async () => new Headers(),
  },
});

// ── Plain-data React element tree walking (never rendered) ────────────────
function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}
function findText(node: any, text: string): boolean {
  if (node == null) return false;
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((n) => findText(n, text));
  if (typeof node === "object" && node.props?.children !== undefined) return findText(node.props.children, text);
  return false;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: ProjectsPage } = await import("@/app/(main)/projects/page");
  const { ProjectList } = await import("@/components/projects/project-list");
  const { ProjectPaginationBar } = await import("@/components/projects/project-pagination-bar");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];

  const callPage = async (params: Record<string, string>): Promise<{ element: any } | { redirectTo: string }> => {
    try {
      const element = await ProjectsPage({ searchParams: Promise.resolve(params) });
      return { element };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        // Next's digest shape: NEXT_REDIRECT;<type>;<url>;<statusCode>
        const parts = err.digest.split(";");
        return { redirectTo: parts[2] ?? "" };
      }
      throw err;
    }
  };

  const getProjectIds = (element: any): string[] => {
    const [listEl] = findElementsByType(element, ProjectList);
    if (!listEl) return [];
    return (listEl.props.projects as any[]).map((p) => p.id);
  };

  try {
    // ── Fixture department, fully config-backed via the real createDepartment() service ──
    const deptA = await createDepartment({ name: `Project Filters Dept A ${RUN_ID}`, slug: `project-filters-dept-a-${RUN_ID}` });
    departmentIds.push(deptA.id);
    const deptB = await createDepartment({ name: `Project Filters Dept B ${RUN_ID}`, slug: `project-filters-dept-b-${RUN_ID}` });
    departmentIds.push(deptB.id);

    const adminUser = await prisma.user.create({ data: { email: `pf-admin-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(adminUser.id);
    const ownerA = await prisma.user.create({ data: { email: `pf-owner-a-${RUN_ID}@example.com`, role: Role.IT_AGENT, name: `Owner A ${RUN_ID}` } });
    userIds.push(ownerA.id);
    const ownerB = await prisma.user.create({ data: { email: `pf-owner-b-${RUN_ID}@example.com`, role: Role.IT_AGENT, name: `Owner B ${RUN_ID}` } });
    userIds.push(ownerB.id);
    const memberB = await prisma.user.create({ data: { email: `pf-member-b-${RUN_ID}@example.com`, role: Role.IT_AGENT, name: `Member B ${RUN_ID}` } });
    userIds.push(memberB.id);

    const now = new Date();
    const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

    const beforeCreate = new Date();

    const p1 = await prisma.project.create({
      data: { title: `PF Planning Project ${RUN_ID}`, status: ProjectStatus.PLANNING, priority: 1, ownerId: ownerA.id, departmentId: deptA.id, endDate: future },
    });
    projectIds.push(p1.id);

    const p2 = await prisma.project.create({
      data: {
        title: `PF InProgress Project ${RUN_ID}`,
        status: ProjectStatus.IN_PROGRESS,
        priority: 2,
        ownerId: ownerA.id,
        departmentId: deptA.id,
        endDate: past,
        startDate: past,
        members: { connect: [{ id: memberB.id }] },
      },
    });
    projectIds.push(p2.id);

    const p3 = await prisma.project.create({
      data: { title: `PF Completed Project ${RUN_ID}`, status: ProjectStatus.COMPLETED, priority: 3, ownerId: ownerB.id, departmentId: deptA.id, endDate: past },
    });
    projectIds.push(p3.id);

    const p4 = await prisma.project.create({
      data: { title: `PF Cancelled Project ${RUN_ID}`, status: ProjectStatus.CANCELLED, priority: 2, ownerId: ownerB.id, departmentId: deptA.id },
    });
    projectIds.push(p4.id);

    const p5 = await prisma.project.create({
      data: {
        title: `PF Zephyr Migration ${RUN_ID}`,
        description: `special-search-term-xyz-${RUN_ID}`,
        status: ProjectStatus.PLANNING,
        priority: 1,
        ownerId: ownerA.id,
        departmentId: deptA.id,
      },
    });
    projectIds.push(p5.id);

    const allIds = [p1.id, p2.id, p3.id, p4.id, p5.id];

    // p2: one completed activity + one overdue (non-terminal, past due) activity
    const act1 = await prisma.projectActivity.create({
      data: { title: `PF Act Completed ${RUN_ID}`, projectId: p2.id, departmentId: deptA.id, status: ActivityStatus.COMPLETED },
    });
    activityIds.push(act1.id);
    const act2 = await prisma.projectActivity.create({
      data: { title: `PF Act Overdue ${RUN_ID}`, projectId: p2.id, departmentId: deptA.id, status: ActivityStatus.TODO, dueDate: past },
    });
    activityIds.push(act2.id);
    // p3: one completed activity, not overdue-eligible (terminal itself)
    const act3 = await prisma.projectActivity.create({
      data: { title: `PF Act Completed On Terminal Project ${RUN_ID}`, projectId: p3.id, departmentId: deptA.id, status: ActivityStatus.COMPLETED },
    });
    activityIds.push(act3.id);

    const afterCreate = new Date();

    // ── RBAC fixture: global role IT_AGENT (passes the page's global
    // project.view gate, same as app/(main)/tickets/page.tsx's analogous
    // check) but a REQUESTER-tier DepartmentMembership in deptB — REQUESTER
    // is not granted project.view at the department level (prisma/seed.ts),
    // so this specifically exercises buildProjectListWhere's department-scope
    // denial, distinct from and in addition to the earlier global gate. ──
    const rbacUser = await prisma.user.create({ data: { email: `pf-rbac-${RUN_ID}@example.com`, role: Role.IT_AGENT } });
    userIds.push(rbacUser.id);
    const rbacMembership = await prisma.departmentMembership.create({
      data: { userId: rbacUser.id, departmentId: deptB.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(rbacMembership.id);

    // ADMIN as the primary test identity — cookie pins their active workspace
    // to deptA specifically, so every count below is isolated from any other
    // data already in this database.
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = deptA.id;

    console.log("\nBaseline (no filters)...\n");
    let result = await callPage({});
    if ("element" in result) {
      check("No filters returns all 5 fixture projects", getProjectIds(result.element).sort().join(",") === [...allIds].sort().join(","));
    } else check("No filters returns all 5 fixture projects", false);

    console.log("\nSearch...\n");
    result = await callPage({ search: `special-search-term-xyz-${RUN_ID}` });
    if ("element" in result) check("Search matches only the project whose description contains the term", getProjectIds(result.element).join(",") === p5.id);
    else check("Search matches only the project whose description contains the term", false);

    console.log("\nExact status...\n");
    result = await callPage({ status: "PLANNING" });
    if ("element" in result) check("status=PLANNING returns exactly p1 and p5", getProjectIds(result.element).sort().join(",") === [p1.id, p5.id].sort().join(","));
    else check("status=PLANNING returns exactly p1 and p5", false);

    console.log("\nStatus group (active/completed)...\n");
    result = await callPage({ statusGroup: "active" });
    if ("element" in result) check("statusGroup=active returns exactly p1, p2, p5 (non-terminal)", getProjectIds(result.element).sort().join(",") === [p1.id, p2.id, p5.id].sort().join(","));
    else check("statusGroup=active", false);
    result = await callPage({ statusGroup: "completed" });
    if ("element" in result) check("statusGroup=completed returns exactly p3, p4 (terminal)", getProjectIds(result.element).sort().join(",") === [p3.id, p4.id].sort().join(","));
    else check("statusGroup=completed", false);

    console.log("\nOverdue (same rule as the dashboard card)...\n");
    result = await callPage({ overdue: "true" });
    if ("element" in result) check("overdue=true returns exactly p2 (non-terminal + past due date; p3 excluded despite past due because it's terminal)", getProjectIds(result.element).join(",") === p2.id);
    else check("overdue=true", false);

    console.log("\nPriority...\n");
    result = await callPage({ priority: "3" });
    if ("element" in result) check("priority=3 returns exactly p3", getProjectIds(result.element).join(",") === p3.id);
    else check("priority=3", false);

    console.log("\nOwner...\n");
    result = await callPage({ ownerId: ownerB.id });
    if ("element" in result) check("ownerId=ownerB returns exactly p3, p4", getProjectIds(result.element).sort().join(",") === [p3.id, p4.id].sort().join(","));
    else check("ownerId filter", false);

    console.log("\nMember...\n");
    result = await callPage({ memberId: memberB.id });
    if ("element" in result) check("memberId=memberB returns exactly p2", getProjectIds(result.element).join(",") === p2.id);
    else check("memberId filter", false);

    console.log("\nDate ranges...\n");
    result = await callPage({ dueDateBefore: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) });
    if ("element" in result) check("dueDateBefore=yesterday returns exactly p2, p3 (both have a past endDate)", getProjectIds(result.element).sort().join(",") === [p2.id, p3.id].sort().join(","));
    else check("dueDateBefore filter", false);

    // createdBefore is date-only granularity (YYYY-MM-DD -> UTC midnight),
    // same as app/(main)/tickets/page.tsx's own createdBefore — so the upper
    // bound must be the day AFTER fixture creation, not literally "today,"
    // or same-day records created after 00:00 UTC would be excluded.
    const createdBeforeBound = new Date(afterCreate.getTime() + 24 * 60 * 60 * 1000);
    result = await callPage({ createdAfter: beforeCreate.toISOString().slice(0, 10), createdBefore: createdBeforeBound.toISOString().slice(0, 10) });
    if ("element" in result) {
      const ids = getProjectIds(result.element);
      check("createdAfter/createdBefore bracketing fixture creation returns all 5", allIds.every((id) => ids.includes(id)));
    } else check("createdAfter/createdBefore", false);

    console.log("\nActivity-based filters...\n");
    result = await callPage({ hasActivities: "true" });
    if ("element" in result) check("hasActivities=true returns exactly p2, p3", getProjectIds(result.element).sort().join(",") === [p2.id, p3.id].sort().join(","));
    else check("hasActivities filter", false);

    result = await callPage({ activityStatus: "completed" });
    if ("element" in result) check("activityStatus=completed returns exactly p2, p3 (each has a completed activity)", getProjectIds(result.element).sort().join(",") === [p2.id, p3.id].sort().join(","));
    else check("activityStatus=completed", false);

    result = await callPage({ activityStatus: "incomplete" });
    if ("element" in result) check("activityStatus=incomplete returns exactly p2 (p3's only activity is terminal/completed)", getProjectIds(result.element).join(",") === p2.id);
    else check("activityStatus=incomplete", false);

    result = await callPage({ activityOverdue: "true" });
    if ("element" in result) check("activityOverdue=true returns exactly p2", getProjectIds(result.element).join(",") === p2.id);
    else check("activityOverdue=true", false);

    console.log("\nCombining multiple filters (AND, not chained/order-dependent)...\n");
    result = await callPage({ statusGroup: "active", overdue: "true" });
    if ("element" in result) check("statusGroup=active AND overdue=true returns exactly p2", getProjectIds(result.element).join(",") === p2.id);
    else check("combined statusGroup+overdue", false);

    console.log("\nInvalid query parameters are ignored, never guessed at...\n");
    result = await callPage({ priority: "2abc" });
    if ("element" in result) check('priority="2abc" is ignored (returns all 5, not parsed as 2)', getProjectIds(result.element).length === 5);
    else check("invalid priority ignored", false);

    result = await callPage({ status: "NOT_A_REAL_STATUS" });
    if ("element" in result) check("status=garbage is ignored (returns all 5)", getProjectIds(result.element).length === 5);
    else check("invalid status ignored", false);

    result = await callPage({ dueDateBefore: "not-a-date" });
    if ("element" in result) check("dueDateBefore=not-a-date is ignored (returns all 5)", getProjectIds(result.element).length === 5);
    else check("invalid date ignored", false);

    console.log("\nFilter change resets to page 1 / pagination + canonical redirect...\n");
    result = await callPage({ page: "5" });
    if ("redirectTo" in result) check("page=5 (out of range for 5 results on one page) redirects to the canonical last page", result.redirectTo.includes("page=1"));
    else check("out-of-range page redirects", false);

    result = await callPage({ page: "5", ownerId: ownerB.id });
    if ("redirectTo" in result) {
      check("Canonical redirect preserves other active filters", result.redirectTo.includes(`ownerId=${ownerB.id}`) && result.redirectTo.includes("page=1"));
    } else check("Canonical redirect preserves filters", false);

    console.log("\nRBAC — a department member without project.view sees nothing, regardless of filters...\n");
    currentSession = { user: { id: rbacUser.id, role: Role.IT_AGENT, customRoleId: null } };
    currentCookieDepartmentId = deptB.id;
    result = await callPage({});
    if ("element" in result) check("REQUESTER-tier member (no project.view) sees an access-denied state, not deptB's/anyone's projects", findText(result.element, "Access denied"));
    else check("RBAC denied state", false);

    result = await callPage({ departmentId: deptA.id, ownerId: ownerA.id, statusGroup: "active" });
    if ("element" in result) {
      check(
        "Explicitly requesting deptA (not a member) via query params is still denied — URL cannot widen access",
        findText(result.element, "Access denied")
      );
    } else check("URL manipulation cannot widen RBAC access", false);

    console.log("\nEmpty result state...\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = deptA.id;
    result = await callPage({ search: `no-such-project-${RUN_ID}-zzz` });
    if ("element" in result) {
      check("A search matching nothing returns zero projects", getProjectIds(result.element).length === 0);
      check("Empty state distinguishes 'no matches' from 'no projects yet'", findText(result.element, "No projects match your filters"));
    } else {
      check("Empty result state", false);
      check("Empty state message", false);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      // createDepartment() seeds starter TicketPriority/TicketStatus rows
      // (RESTRICT FK, not cascade — unlike ProjectStatusConfig/
      // ActivityStatusConfig/ActivityPriorityConfig/ActivityProgressConfig,
      // which cascade automatically) — must be cleared before the department
      // itself can be deleted.
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      if (customRoleIds.length > 0) await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
