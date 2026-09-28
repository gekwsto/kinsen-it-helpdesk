/**
 * Regression coverage for "Activity marked Done inside a Project":
 *
 * ORIGINAL ROOT CAUSE (confirmed by reading, then reproduced): PATCH
 * /api/activities/[id] rolled the parent Project's progress up via a
 * fire-and-forget `recalculateProjectRollup(...).catch(...)` — never
 * awaited, which used to race the client's own router.refresh() and
 * regularly lose, leaving stale Project progress. Fixed by awaiting the
 * rollup (still swallowing its own errors) before the route responds — this
 * part of the fix is unchanged and still verified below.
 *
 * SUPERSEDED client architecture (see scripts/test-activity-completion-performance.ts
 * for the full follow-up fix and its own tests): the Project detail page's
 * Activities card is no longer server-rendered directly in
 * app/(main)/projects/[id]/page.tsx — it's the client-managed
 * ProjectActivitiesCard (components/projects/project-activities-card.tsx),
 * which applies the PATCH response's own authoritative
 * activity+projectRollups data directly, and no longer calls
 * router.refresh() at all. This file's own assertions below read
 * ProjectActivitiesCard's props (the data the Server Component hands it)
 * rather than re-deriving rendered text, since that card's internal JSX
 * — like any Client Component's — never executes when the Server Component
 * function is called directly in this harness.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-completion-project-refresh.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";
import { NextRequest } from "next/server";

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
  const { prisma } = await import("@/lib/prisma");
  const { AuthProvider, Role } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  const activityRoute = await import("@/app/api/activities/[id]/route");
  const { default: ProjectDetailPage } = await import("@/app/(main)/projects/[id]/page");
  const { ProjectActivitiesCard } = await import("@/components/projects/project-activities-card");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const renderProjectPage = async (id: string) => {
    const el = await ProjectDetailPage({ params: Promise.resolve({ id }) });
    return el;
  };
  // ProjectActivitiesCard is a Client Component — its own internal JSX
  // never executes when ProjectDetailPage() is called directly in this
  // harness (see the module doc comment above), so every assertion below
  // reads ITS PROPS (the exact data the Server Component computed and
  // handed down) rather than re-deriving rendered text.
  const findActivitiesCardProps = (el: any) => findElementsByType(el, ProjectActivitiesCard)[0]?.props;
  const findActivityRow = (el: any, activityId: string) =>
    findActivitiesCardProps(el)?.initialActivities?.find((a: any) => a.id === activityId);

  try {
    const dept = await createDepartment({ name: `ActRefresh-${RUN_ID}`, slug: `act-refresh-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.create({ data: { email: `act-refresh-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: admin.role, customRoleId: null } };

    console.log("\n=== 1/2. Toggling Done from inside the Project: authoritative state + progress/count refresh together, no race ===\n");
    const project = await prisma.project.create({ data: { title: `Refresh Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, progress: 0 } });
    projectIds.push(project.id);
    // A1 already done (100%), A2 still TODO (0%) — completing A2 changes the
    // average from 50% to something higher, a real, checkable delta.
    const a1 = await prisma.projectActivity.create({ data: { title: "A1", projectId: project.id, departmentId: dept.id, status: "COMPLETED", isCompleted: true, progress: 100 } });
    const a2 = await prisma.projectActivity.create({ data: { title: "A2", projectId: project.id, departmentId: dept.id, status: "TODO", isCompleted: false, progress: 0 } });
    activityIds.push(a1.id, a2.id);
    await prisma.project.update({ where: { id: project.id }, data: { progress: 50 } }); // seed a real, stale-if-unfixed rollup value

    const before = await renderProjectPage(project.id);
    check("BEFORE: no exception thrown rendering the Project page (no crash)", !!before);
    check("BEFORE: the row reflects the real, not-yet-completed state", findActivityRow(before, a2.id)?.isCompleted === false);
    const beforeProps = findActivitiesCardProps(before);
    check("BEFORE: 1 of 2 activities complete", beforeProps?.initialActivities.filter((a: any) => a.isCompleted).length === 1 && beforeProps?.initialActivities.length === 2);

    // The exact PATCH the checkbox's toggleActivityComplete() sends.
    const patchRes = await activityRoute.PATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }), { params: Promise.resolve({ id: a2.id }) });
    check("PATCH -> 200", patchRes.status === 200);
    const patchBody = await patchRes.clone().json();
    check("Response payload carries the authoritative isCompleted/status the checkbox reads", patchBody.isCompleted === true && patchBody.status === "COMPLETED");
    check("Response payload also carries the awaited projectRollups — this Project's freshly-rolled-up progress, with no second round-trip needed", patchBody.projectRollups?.some((r: any) => r.id === project.id && r.progress === 100));

    // Independently confirms the DB-committed truth every fresh page render
    // still re-derives from (not just the response payload) — a real Server
    // Component navigation/reload to this same page must never show stale
    // data either, even though the client no longer calls router.refresh()
    // in normal operation.
    const after = await renderProjectPage(project.id);
    check("2. AFTER: no exception thrown re-rendering the page", !!after);
    check("...the row now reflects the authoritative Done state", findActivityRow(after, a2.id)?.isCompleted === true);
    const afterProps = findActivitiesCardProps(after);
    check("...the Activities count and completed count both updated (2 of 2)", afterProps?.initialActivities.filter((a: any) => a.isCompleted).length === 2 && afterProps?.initialActivities.length === 2);
    check("...the Project's progress (the value the old race used to leave stale at 50%) is the freshly-rolled-up 100%, with no delay needed", afterProps?.initialProgress === 100);

    const projectRowAfter = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { progress: true } });
    check("Project.progress is committed in the DB by the time the PATCH response resolves (the actual race fix)", projectRowAfter.progress === 100, `got ${projectRowAfter.progress}`);

    console.log("\n=== 3. A failed Activity mutation leaves no false Done state ===\n");
    const a3 = await prisma.projectActivity.create({ data: { title: "A3", projectId: project.id, departmentId: dept.id, status: "TODO", isCompleted: false, progress: 0 } });
    activityIds.push(a3.id);
    const projectProgressBeforeFail = (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { progress: true } })).progress;

    // Deliberately inconsistent pair — the same guard the client can never
    // itself send (toggleActivityComplete always sends a consistent pair),
    // but proves the server-side source of truth a failed client request
    // would re-sync from is never mutated.
    const failRes = await activityRoute.PATCH(jsonReq({ isCompleted: true, status: "IN_PROGRESS" }), { params: Promise.resolve({ id: a3.id }) });
    check("Inconsistent isCompleted/status -> 400, not persisted", failRes.status === 400);
    const a3AfterFail = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a3.id }, select: { isCompleted: true, status: true } });
    check("...Activity row still shows the true (unchanged) state — no false Done", a3AfterFail.isCompleted === false && a3AfterFail.status === "TODO");
    const projectProgressAfterFail = (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { progress: true } })).progress;
    check("...the parent Project's progress was never touched by the failed mutation", projectProgressAfterFail === projectProgressBeforeFail);

    const canEditFalseUser = await prisma.user.create({ data: { email: `act-refresh-noedit-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(canEditFalseUser.id);
    currentSession = { user: { id: canEditFalseUser.id, role: canEditFalseUser.role, customRoleId: null } };
    const forbiddenRes = await activityRoute.PATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }), { params: Promise.resolve({ id: a3.id }) });
    check("A user without activity.edit -> 403, not persisted (existing authorization unchanged)", forbiddenRes.status === 403);
    const a3AfterForbidden = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a3.id }, select: { isCompleted: true } });
    check("...still no false Done state after the forbidden attempt", a3AfterForbidden.isCompleted === false);
    currentSession = { user: { id: admin.id, role: admin.role, customRoleId: null } };

    console.log("\n=== Client-side state-machine structure (source-level — the part no real DOM exists to drive in this suite) ===\n");
    const checkboxSrc = await fs.readFile("components/activities/activity-complete-checkbox.tsx", "utf8");
    const listSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");
    const toggleSrc = await fs.readFile("components/activities/toggle-activity-complete.ts", "utf8");
    const repoWideNoReload =
      !/window\.location\.reload|location\.reload/.test(checkboxSrc) &&
      !/window\.location\.reload|location\.reload/.test(listSrc) &&
      !/window\.location\.reload|location\.reload/.test(toggleSrc);
    check("No window.location.reload() anywhere in the completion-toggle code path", repoWideNoReload);
    check("ActivityCompleteCheckbox: loading state clears in a `finally` block (always runs, success or failure)", /finally\s*{\s*setToggling\(false\)/.test(checkboxSrc));
    check("ActivityCompleteCheckbox: a failed toggle restores the PREVIOUS value (rollback), not a guessed one", /catch[\s\S]{0,120}setIsCompleted\(previous\)/.test(checkboxSrc));
    check("ActivityCompleteCheckbox: a failed toggle still surfaces the existing toast error feedback", /catch[\s\S]{0,200}toast\.error/.test(checkboxSrc));
    check("ActivityList (project-filtered /activities view): loading state clears in `finally`", /finally\s*{\s*setTogglingId\(null\)/.test(listSrc));
    check("ActivityList: a failed toggle rolls the optimistic flip back to the previous isCompleted/status, not left stuck", /catch[\s\S]{0,300}isCompleted:\s*previous/.test(listSrc));
    check("toggle-activity-complete.ts: a non-OK response is thrown as a real Error (so every caller's catch actually fires)", /if \(!res\.ok\)[\s\S]{0,150}throw new Error/.test(toggleSrc));
    check("ActivityCompleteCheckbox no longer calls router.refresh() at all — the PATCH response's own authoritative data is applied directly via onToggled, not a whole-page re-render", !/router\.refresh/.test(checkboxSrc) && !/useRouter/.test(checkboxSrc));
    check("ActivityCompleteCheckbox is marked with NAV_LOADER_IGNORE_ATTR so the global nav loader's capture-phase click listener never arms the full-page overlay for this same-page mutation (see scripts/test-activity-completion-performance.ts for the full race explanation)", /NAV_LOADER_IGNORE_ATTR/.test(checkboxSrc));

    console.log("\n=== PATCH /api/activities/[id]: the rollup is now awaited, not fire-and-forget ===\n");
    const routeSrc = await fs.readFile("app/api/activities/[id]/route.ts", "utf8");
    check("recalculateProjectRollup(...) is awaited (directly or via a collected Promise.all) before the route responds", /await Promise\.all\(rollups\)/.test(routeSrc));
    check("...the response is returned strictly AFTER that await, never before", routeSrc.indexOf("await Promise.all(rollups)") < routeSrc.indexOf("return NextResponse.json({ ...activity, statusLabel"));
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
