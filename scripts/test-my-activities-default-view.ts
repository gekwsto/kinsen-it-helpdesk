/**
 * Regression coverage for "all real Activity-list pages default to List
 * view" — extends the earlier /projects and /activities work (see
 * scripts/test-projects-activities-view-and-sort.ts, which already proves
 * those two default to List) to /my-activities, the one remaining page that
 * uses the shared ActivityList/ViewToggle components and had NOT yet opted
 * in (it previously passed neither component a `defaultView` prop, so both
 * fell back to their own historical "grid" default).
 *
 * Audit confirmed exactly two pages render ActivityList/ViewToggle at all
 * (grep across app/(main) for both component names): /activities (already
 * "list") and /my-activities (the gap this fixes). No other Activity
 * listing page exists.
 *
 * FIX: app/(main)/my-activities/page.tsx now passes `defaultView="list"` to
 * BOTH <ViewToggle> and <ActivityList> (the two independent Client
 * Components that each read `?view=` off the URL via the same canonical
 * resolveViewMode — see components/ui/view-toggle.tsx) — the exact same
 * pattern /activities and /projects already use. No change to
 * resolveViewMode/ViewToggle/ActivityList themselves: their OWN default
 * stays "grid" for any future caller that doesn't opt in.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-my-activities-default-view.ts
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
  const { resolveViewMode } = await import("@/components/ui/view-toggle");

  // ══════════════ 11/12/13. resolveViewMode — pure resolver, exhaustive ══════════════
  console.log("\n=== resolveViewMode against defaultView=\"list\" (what /my-activities now passes) ===\n");
  check("11. Missing param (null) -> falls back to \"list\"", resolveViewMode(null, "list") === "list");
  check("11. Missing param (undefined) -> falls back to \"list\"", resolveViewMode(undefined, "list") === "list");
  check("12. Invalid/garbage value -> falls back to \"list\"", resolveViewMode("bogus", "list") === "list");
  check("12. Empty string -> falls back to \"list\" (not treated as a real value)", resolveViewMode("", "list") === "list");
  check("13. Explicit ?view=grid -> still resolves to \"grid\" even though the page's default is now \"list\"", resolveViewMode("grid", "list") === "grid");
  check("13. Explicit ?view=list -> resolves to \"list\"", resolveViewMode("list", "list") === "list");

  // ══════════════ Source-level wiring ══════════════
  console.log("\n=== Source-level: /my-activities now opts into defaultView=\"list\" on BOTH components; /activities and /projects unchanged ═══\n");
  const myActivitiesSrc = await fs.readFile("app/(main)/my-activities/page.tsx", "utf8");
  const activitiesSrc = await fs.readFile("app/(main)/activities/page.tsx", "utf8");
  const projectsSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  const viewToggleSrc = await fs.readFile("components/ui/view-toggle.tsx", "utf8");
  const activityListSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");
  const projectListSrc = await fs.readFile("components/projects/project-list.tsx", "utf8");

  check("/my-activities passes defaultView=\"list\" to <ViewToggle>", /<ViewToggle defaultView="list"\s*\/>/.test(myActivitiesSrc));
  check("/my-activities passes defaultView=\"list\" to <ActivityList>", /<ActivityList[^>]*defaultView="list"/.test(myActivitiesSrc));
  check("/activities STILL passes defaultView=\"list\" to <ViewToggle> (unchanged by this task)", /<ViewToggle defaultView="list"/.test(activitiesSrc));
  check("/activities STILL passes defaultView=\"list\" to <ActivityList> (unchanged)", /<ActivityList[^>]*defaultView="list"/.test(activitiesSrc));
  check("/projects default view is untouched by this task (still \"list\", from the earlier work — not reverted, not altered)", /<ViewToggle defaultView="list"/.test(projectsSrc) && /<ProjectList[^>]*defaultView="list"/.test(projectsSrc));

  check("ViewToggle's OWN default stays \"grid\" — unchanged for any FUTURE caller that doesn't opt in", /defaultView = "grid"/.test(viewToggleSrc));
  check("ActivityList's OWN default stays \"grid\" too", /defaultView = "grid"/.test(activityListSrc));
  check("ProjectList's OWN default stays \"grid\" (untouched, not part of this task)", /defaultView = "grid"/.test(projectListSrc));

  console.log("\n=== 14a. Nothing else in /my-activities changed: sorting/filters/pagination/scope/permissions all intact (source-verified) ===\n");
  check("Still gates on getNavVisibilityFlags(...).canViewActivities — permission check untouched", /navFlags\.canViewActivities/.test(myActivitiesSrc));
  check("Still scoped to assignedUsers: { some: { id: session.user.id } } — query scope untouched", /assignedUsers: \{ some: \{ id: session\.user\.id \} \}/.test(myActivitiesSrc));
  check("The `status` filter param handling is untouched", /params\.status && validStatuses\.includes\(params\.status\)/.test(myActivitiesSrc));
  check("orderBy: { createdAt: \"desc\" } is untouched — no new sort mechanism was introduced here", /orderBy: \{ createdAt: "desc" \}/.test(myActivitiesSrc));
  check("No pagination was added or removed (this page never had server-side pagination, and still doesn't)", !/skip:|take:|computePagination/.test(myActivitiesSrc));

  // ══════════════ Real Server Component behavior ══════════════
  console.log("\n=== Real MyActivitiesPage: defaultView=\"list\" reaches both components, scope/data untouched ===\n");
  const { prisma } = await import("@/lib/prisma");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping the real-DB portion.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { Role, AuthProvider, ActivityStatus } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { default: MyActivitiesPage } = await import("@/app/(main)/my-activities/page");
  const { ActivityList } = await import("@/components/activities/activity-list");
  const { ViewToggle } = await import("@/components/ui/view-toggle");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const activityIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `MyActivities View ${RUN_ID}`, slug: `my-activities-view-${RUN_ID}` });
    departmentIds.push(dept.id);
    const user = await prisma.user.create({ data: { email: `myact-view-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(user.id);
    const otherUser = await prisma.user.create({ data: { email: `myact-view-other-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(otherUser.id);

    const assignedActivity = await prisma.projectActivity.create({
      data: { title: `Assigned to me ${RUN_ID}`, departmentId: dept.id, status: ActivityStatus.TODO, assignedUsers: { connect: [{ id: user.id }] } },
    });
    activityIds.push(assignedActivity.id);
    const notAssignedActivity = await prisma.projectActivity.create({
      data: { title: `Assigned to someone else ${RUN_ID}`, departmentId: dept.id, status: ActivityStatus.TODO, assignedUsers: { connect: [{ id: otherUser.id }] } },
    });
    activityIds.push(notAssignedActivity.id);

    currentSession = { user: { id: user.id, role: Role.USER, customRoleId: null } };
    const element = await MyActivitiesPage({ searchParams: Promise.resolve({}) });

    const [viewToggleEl] = findElementsByType(element, ViewToggle);
    const [activityListEl] = findElementsByType(element, ActivityList);
    check("11. Real page call with NO ?view= param: <ViewToggle> receives defaultView=\"list\"", viewToggleEl?.props.defaultView === "list");
    check("11. Real page call with NO ?view= param: <ActivityList> receives defaultView=\"list\"", activityListEl?.props.defaultView === "list");
    check("resolveViewMode(no param, \"list\") therefore resolves to \"list\" -> the page genuinely opens in List view", resolveViewMode(null, activityListEl?.props.defaultView) === "list");

    console.log("\n-- 14c. Scope/data is exactly what it was before this change (assignedUsers-based, unaffected) --\n");
    const activities = activityListEl?.props.activities as any[];
    check("Only the activity assigned to THIS user is present", activities?.some((a) => a.id === assignedActivity.id) && !activities?.some((a) => a.id === notAssignedActivity.id));
    check("Exactly 1 activity for this fixture user (scope wasn't widened or narrowed)", activities?.length === 1);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
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

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
