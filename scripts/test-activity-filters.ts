/**
 * End-to-end verification of the All Activities list's URL-driven filtering
 * (app/(main)/activities/page.tsx) — exercises the REAL Server Component
 * function directly (not a reimplementation) with a mocked @/lib/auth
 * session and a mocked next/headers cookies(). The page's returned React
 * element tree is walked as plain data (never rendered/hydrated) to read
 * exactly which activities ActivityList was given.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-filters.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, ActivityStatus, ActivityPriority, DepartmentRole, MembershipSource } from "@prisma/client";
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

  const { default: ActivitiesPage } = await import("@/app/(main)/activities/page");
  const { ActivityList } = await import("@/components/activities/activity-list");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const membershipIds: string[] = [];

  const callPage = async (params: Record<string, string>): Promise<{ element: any } | { redirectTo: string }> => {
    try {
      const element = await ActivitiesPage({ searchParams: Promise.resolve(params) });
      return { element };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        const parts = err.digest.split(";");
        return { redirectTo: parts[2] ?? "" };
      }
      throw err;
    }
  };

  const getActivityIds = (result: { element: any } | { redirectTo: string }): string[] => {
    if (!("element" in result)) return [];
    const [listEl] = findElementsByType(result.element, ActivityList);
    if (!listEl) return [];
    return (listEl.props.activities as any[]).map((a) => a.id);
  };

  try {
    const deptA = await createDepartment({ name: `Activity Filters Dept A ${RUN_ID}`, slug: `activity-filters-dept-a-${RUN_ID}` });
    departmentIds.push(deptA.id);
    const deptB = await createDepartment({ name: `Activity Filters Dept B ${RUN_ID}`, slug: `activity-filters-dept-b-${RUN_ID}` });
    departmentIds.push(deptB.id);

    const adminUser = await prisma.user.create({ data: { email: `af-admin-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(adminUser.id);
    const assigneeA = await prisma.user.create({ data: { email: `af-assignee-a-${RUN_ID}@example.com`, role: Role.IT_AGENT, name: `Assignee A ${RUN_ID}` } });
    userIds.push(assigneeA.id);
    const assigneeB = await prisma.user.create({ data: { email: `af-assignee-b-${RUN_ID}@example.com`, role: Role.IT_AGENT, name: `Assignee B ${RUN_ID}` } });
    userIds.push(assigneeB.id);

    const project = await prisma.project.create({ data: { title: `Activity Filters Project ${RUN_ID}`, ownerId: adminUser.id, departmentId: deptA.id } });
    projectIds.push(project.id);

    const now = new Date();
    const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const beforeCreate = new Date();

    const a1 = await prisma.projectActivity.create({
      data: { title: `AF Todo Activity ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.LOW, projectId: project.id, departmentId: deptA.id, startDate: future, dueDate: future, assignedUsers: { connect: [{ id: assigneeA.id }] } },
    });
    const a2 = await prisma.projectActivity.create({
      data: { title: `AF InProgress Activity ${RUN_ID}`, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.HIGH, projectId: project.id, departmentId: deptA.id, dueDate: past, assignedUsers: { connect: [{ id: assigneeA.id }, { id: assigneeB.id }] } },
    });
    const a3 = await prisma.projectActivity.create({
      data: { title: `AF Completed Activity ${RUN_ID}`, status: ActivityStatus.COMPLETED, priority: ActivityPriority.MEDIUM, projectId: project.id, departmentId: deptA.id, dueDate: past },
    });
    const a4 = await prisma.projectActivity.create({
      data: { title: `AF Cancelled Standalone Activity ${RUN_ID}`, status: ActivityStatus.CANCELLED, priority: ActivityPriority.URGENT, departmentId: deptA.id },
    });
    const a5 = await prisma.projectActivity.create({
      data: { title: `AF Zephyr Migration Activity ${RUN_ID}`, description: `special-activity-term-xyz-${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.LOW, projectId: project.id, departmentId: deptA.id },
    });
    activityIds.push(a1.id, a2.id, a3.id, a4.id, a5.id);
    const allIds = [a1.id, a2.id, a3.id, a4.id, a5.id];
    const afterCreate = new Date();

    // RBAC fixture: real membership in deptB only, global IT_AGENT (passes
    // canManageProjects + global activity.view), used to prove requesting
    // deptA explicitly is denied and default browsing never leaks deptA rows.
    const rbacUser = await prisma.user.create({ data: { email: `af-rbac-${RUN_ID}@example.com`, role: Role.IT_AGENT } });
    userIds.push(rbacUser.id);
    const rbacMembership = await prisma.departmentMembership.create({
      data: { userId: rbacUser.id, departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(rbacMembership.id);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = deptA.id;

    console.log("\n1. Total Activities -> canonical unfiltered route...\n");
    let result = await callPage({});
    check("No filters returns all 5 fixture activities", getActivityIds(result).sort().join(",") === [...allIds].sort().join(","));

    console.log("\n2. Completed Activities -> statusGroup=completed...\n");
    result = await callPage({ statusGroup: "completed" });
    check("statusGroup=completed returns exactly a3, a4 (terminal)", getActivityIds(result).sort().join(",") === [a3.id, a4.id].sort().join(","));

    console.log("\n3. Overdue Activities -> overdue=true...\n");
    result = await callPage({ overdue: "true" });
    check("overdue=true returns exactly a2 (a3 excluded despite past due — it's terminal)", getActivityIds(result).join(",") === a2.id);

    console.log("\n7. Terminal activity is never overdue / 8. no due date is never overdue...\n");
    check("a3 (terminal, past due date) does not appear in overdue=true results", !getActivityIds(await callPage({ overdue: "true" })).includes(a3.id));
    check("a1 (non-terminal, future due date) does not appear in overdue=true results", !getActivityIds(await callPage({ overdue: "true" })).includes(a1.id));
    check("a4 (non-terminal... actually terminal/CANCELLED, no due date at all) does not appear in overdue=true results", !getActivityIds(await callPage({ overdue: "true" })).includes(a4.id));

    console.log("\nSearch...\n");
    result = await callPage({ search: `special-activity-term-xyz-${RUN_ID}` });
    check("Search matches only the activity whose description contains the term", getActivityIds(result).join(",") === a5.id);

    console.log("\nExact status / statusGroup incomplete...\n");
    result = await callPage({ status: "TODO" });
    check("status=TODO returns exactly a1, a5", getActivityIds(result).sort().join(",") === [a1.id, a5.id].sort().join(","));
    result = await callPage({ statusGroup: "incomplete" });
    check("statusGroup=incomplete returns exactly a1, a2, a5 (non-terminal)", getActivityIds(result).sort().join(",") === [a1.id, a2.id, a5.id].sort().join(","));

    console.log("\nPriority...\n");
    result = await callPage({ priority: "URGENT" });
    check("priority=URGENT returns exactly a4", getActivityIds(result).join(",") === a4.id);

    console.log("\nAssignee / unassigned...\n");
    result = await callPage({ assignedUserId: assigneeB.id });
    check("assignedUserId=assigneeB returns exactly a2", getActivityIds(result).join(",") === a2.id);
    result = await callPage({ unassigned: "true" });
    // a5 also has no assignedUsers set in this fixture (only a1/a2 do).
    check("unassigned=true returns exactly a3, a4, a5", getActivityIds(result).sort().join(",") === [a3.id, a4.id, a5.id].sort().join(","));

    console.log("\nProject...\n");
    result = await callPage({ projectId: project.id });
    check("projectId filter returns exactly a1, a2, a3, a5 (a4 is standalone)", getActivityIds(result).sort().join(",") === [a1.id, a2.id, a3.id, a5.id].sort().join(","));

    console.log("\nDate ranges...\n");
    result = await callPage({ dueDateBefore: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) });
    check("dueDateBefore=yesterday returns exactly a2, a3", getActivityIds(result).sort().join(",") === [a2.id, a3.id].sort().join(","));

    const createdBeforeBound = new Date(afterCreate.getTime() + 24 * 60 * 60 * 1000);
    result = await callPage({ createdAfter: beforeCreate.toISOString().slice(0, 10), createdBefore: createdBeforeBound.toISOString().slice(0, 10) });
    check("createdAfter/createdBefore bracketing fixture creation returns all 5", allIds.every((id) => getActivityIds(result).includes(id)));

    console.log("\n12. Combined filters (AND)...\n");
    result = await callPage({ statusGroup: "incomplete", overdue: "true" });
    check("statusGroup=incomplete AND overdue=true returns exactly a2", getActivityIds(result).join(",") === a2.id);

    console.log("\n11. Invalid query parameters are ignored...\n");
    check('priority="bogus" is ignored (returns all 5)', getActivityIds(await callPage({ priority: "bogus" })).length === 5);
    check("status=garbage is ignored (returns all 5)", getActivityIds(await callPage({ status: "NOT_A_REAL_STATUS" })).length === 5);
    check("dueDateBefore=not-a-date is ignored (returns all 5)", getActivityIds(await callPage({ dueDateBefore: "not-a-date" })).length === 5);

    console.log("\n13/14. Pagination + canonical redirect...\n");
    result = await callPage({ page: "5" });
    check("page=5 (out of range for 5 results on one page) redirects to the canonical last page", "redirectTo" in result && result.redirectTo.includes("page=1"));
    result = await callPage({ page: "5", priority: "URGENT" });
    check("Canonical redirect preserves other active filters", "redirectTo" in result && result.redirectTo.includes("priority=URGENT") && result.redirectTo.includes("page=1"));

    console.log("\n9/10. RBAC — department scope cannot be widened via query params...\n");
    currentSession = { user: { id: rbacUser.id, role: Role.IT_AGENT, customRoleId: null } };
    currentCookieDepartmentId = deptB.id;
    result = await callPage({});
    check("Default browsing on deptB (real membership) returns zero of deptA's fixture activities", getActivityIds(result).every((id) => !allIds.includes(id)));
    result = await callPage({ departmentId: deptA.id });
    check("Explicitly requesting deptA (not a member) via query params is denied, not leaked", "element" in result && findText(result.element, "Access denied"));
    result = await callPage({ departmentId: deptA.id, statusGroup: "completed", overdue: "true" });
    check("Explicit deptA + filters still denied — URL cannot widen access", "element" in result && findText(result.element, "Access denied"));

    console.log("\n4. Keyboard accessibility / clickable card structure (structural check)...\n");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cardsSource = readFileSync(join(process.cwd(), "components/dashboard/projects-kpi-cards.tsx"), "utf-8");
    check("Total Activities card links to /activities", cardsSource.includes('href: "/activities", ariaLabel'));
    check("Completed Activities card links to ?statusGroup=completed", cardsSource.includes('href: "/activities?statusGroup=completed"'));
    check("Overdue Activities card links to ?overdue=true", cardsSource.includes('href: "/activities?overdue=true"'));
    check("No card has href: null anymore (all 7 are clickable)", !cardsSource.includes("href: null"));
    check("Every clickable card has a focus-visible ring", cardsSource.includes("focus-visible:ring-2"));

    console.log("\n15. Clear filters returns to the canonical route (structural check)...\n");
    const filtersSource = readFileSync(join(process.cwd(), "components/activities/activity-filters.tsx"), "utf-8");
    check("Reset navigates to the bare pathname (no query string) — the canonical /activities route", filtersSource.includes("router.push(pathname)"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
