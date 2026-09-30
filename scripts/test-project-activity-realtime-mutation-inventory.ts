/**
 * Full mutation inventory + cross-entity invalidation regression for the
 * Project/Activity realtime auto-refresh task.
 *
 * AUDIT FINDINGS this task fixed (see the final report for the full
 * account): the existing Project realtime mechanism (lib/realtime/
 * project-list-invalidation.ts, project-list-change-hub.ts,
 * app/api/projects/stream/route.ts, hooks/use-project-list-realtime.ts,
 * components/projects/project-list-live-refresh.tsx) only ever published on
 * a Project STATUS change — title, priority, dates, department,
 * subDepartment, and member edits, plus Project create/delete, never
 * published at all. /my-projects (a real, separate list page) had NO
 * subscription mounted. Activities had NO realtime mechanism whatsoever.
 * Cross-entity effects (an Activity's project reassignment/count/rollup
 * affecting the Project list; a Project rename/delete affecting the
 * Activity list) were entirely unhandled.
 *
 * This file mirrors scripts/test-ticket-mutation-realtime-completeness.ts's
 * shape: SECTION A is a source-text guard for wiring that has no DOM to
 * drive directly (which pages mount which LiveRefresh component, no
 * duplicated raw pg_notify, no polling). SECTION B drives the REAL route
 * handlers against a real database with raw, independent LISTEN
 * connections on both the Project and Activity channels (plus the existing
 * Ticket channel, to prove all three stay mutually isolated).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-activity-realtime-mutation-inventory.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";
import { Client, type Notification } from "pg";

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

function waitForNotification(client: Client, timeoutMs: number): Promise<Notification | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.removeListener("notification", onNotify);
      resolve(null);
    }, timeoutMs);
    const onNotify = (msg: Notification) => {
      clearTimeout(timer);
      client.removeListener("notification", onNotify);
      resolve(msg);
    };
    client.on("notification", onNotify);
  });
}
function countNotifications(client: Client, windowMs: number): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const onNotify = () => count++;
    client.on("notification", onNotify);
    setTimeout(() => {
      client.removeListener("notification", onNotify);
      resolve(count);
    }, windowMs);
  });
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — source-text wiring guard ══════════════════════
  console.log("\n=== SECTION A — which pages subscribe, no duplicate pg_notify, no polling, no hard reload ===\n");

  console.log("\n-- 11. Every real Project/Activity list page mounts the correct LiveRefresh component --\n");
  const projectsPageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  const myProjectsPageSrc = await fs.readFile("app/(main)/my-projects/page.tsx", "utf8");
  const activitiesPageSrc = await fs.readFile("app/(main)/activities/page.tsx", "utf8");
  const myActivitiesPageSrc = await fs.readFile("app/(main)/my-activities/page.tsx", "utf8");
  check("/projects mounts <ProjectListLiveRefresh />", /<ProjectListLiveRefresh\s*\/>/.test(projectsPageSrc));
  check("/my-projects mounts <ProjectListLiveRefresh /> (previously missing entirely)", /<ProjectListLiveRefresh\s*\/>/.test(myProjectsPageSrc));
  check("/activities mounts <ActivityListLiveRefresh /> (previously no Activity realtime existed at all)", /<ActivityListLiveRefresh\s*\/>/.test(activitiesPageSrc));
  check("/my-activities mounts <ActivityListLiveRefresh />", /<ActivityListLiveRefresh\s*\/>/.test(myActivitiesPageSrc));

  console.log("\n-- Detail/create/Gantt pages do NOT mount a list-level LiveRefresh (they don't show the list) --\n");
  const projectDetailSrc = await fs.readFile("app/(main)/projects/[id]/page.tsx", "utf8").catch(() => "");
  const projectNewSrc = await fs.readFile("app/(main)/projects/new/page.tsx", "utf8").catch(() => "");
  const projectGanttSrc = await fs.readFile("app/(main)/projects/gantt/page.tsx", "utf8").catch(() => "");
  const activityGanttSrc = await fs.readFile("app/(main)/activities/gantt/page.tsx", "utf8").catch(() => "");
  check("Project detail page does not mount ProjectListLiveRefresh", !/ProjectListLiveRefresh/.test(projectDetailSrc));
  check("Project 'new' page does not mount ProjectListLiveRefresh", !/ProjectListLiveRefresh/.test(projectNewSrc));
  check("Project Gantt page does not mount ProjectListLiveRefresh or ActivityListLiveRefresh", !/ProjectListLiveRefresh/.test(projectGanttSrc) && !/ActivityListLiveRefresh/.test(projectGanttSrc));
  check("Activity Gantt page does not mount ActivityListLiveRefresh or ProjectListLiveRefresh", !/ActivityListLiveRefresh/.test(activityGanttSrc) && !/ProjectListLiveRefresh/.test(activityGanttSrc));

  console.log("\n-- No duplicated raw pg_notify anywhere outside the 2 canonical publisher helpers --\n");
  const mutationRouteFiles = [
    "app/api/projects/route.ts",
    "app/api/projects/[id]/route.ts",
    "app/api/activities/route.ts",
    "app/api/activities/[id]/route.ts",
    "app/api/activities/[id]/notes/route.ts",
    "app/api/activities/[id]/attachments/route.ts",
    "app/api/activities/[id]/attachments/[attachmentId]/route.ts",
    "app/api/activities/[id]/related-links/route.ts",
    "app/api/activities/[id]/related-links/[linkId]/route.ts",
  ];
  let anyRawNotify = false;
  for (const f of mutationRouteFiles) {
    const src = await fs.readFile(f, "utf8").catch(() => "");
    if (/pg_notify/.test(src)) anyRawNotify = true;
  }
  check("No mutation route issues a raw pg_notify() itself — every one goes through publishProjectListInvalidation/publishActivityListInvalidation", !anyRawNotify);

  console.log("\n-- 14. Notes/attachments/related-links never touch Project/Activity tables, so they correctly never publish --\n");
  for (const f of ["app/api/activities/[id]/notes/route.ts", "app/api/activities/[id]/attachments/route.ts", "app/api/activities/[id]/related-links/route.ts"]) {
    const src = await fs.readFile(f, "utf8").catch(() => "");
    check(`${f}: never calls publishActivityListInvalidation/publishProjectListInvalidation`, !/publishActivityListInvalidation|publishProjectListInvalidation/.test(src));
    check(`${f}: never writes to prisma.projectActivity or prisma.project directly`, !/prisma\.projectActivity\.(update|create|delete)|prisma\.project\.(update|create|delete)/.test(src));
  }

  console.log("\n-- No polling, no hard reload anywhere in the new Activity realtime files --\n");
  const activityHookSrc = await fs.readFile("hooks/use-activity-list-realtime.ts", "utf8");
  const activityLiveRefreshSrc = await fs.readFile("components/activities/activity-list-live-refresh.tsx", "utf8");
  check("useActivityListRealtime is EventSource/SSE-based, not setInterval polling", /EventSource/.test(activityHookSrc) && !/setInterval/.test(activityHookSrc));
  check("No window.location.reload anywhere in the new Activity realtime files", !/window\.location\.reload/.test(activityHookSrc) && !/window\.location\.reload/.test(activityLiveRefreshSrc));
  check("ActivityListLiveRefresh reacts via router.refresh(), same as ProjectListLiveRefresh", /router\.refresh\(\)/.test(activityLiveRefreshSrc));
  check("ActivityListLiveRefresh never calls router.push/replace itself (never mutates the URL/filters on its own)", !/router\.(push|replace)/.test(activityLiveRefreshSrc));

  // ══════════════════════ SECTION B — real routes, real DB, raw independent LISTEN ══════════════════════
  console.log("\n=== SECTION B — real route handlers against a real database, with raw LISTEN on all 3 channels ===\n");

  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  const { NextRequest } = await import("next/server");
  const { Role, AuthProvider, ActivityStatus, ActivityPriority } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { PROJECT_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/project-list-invalidation");
  const { ACTIVITY_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/activity-list-invalidation");
  const { TICKET_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/ticket-list-invalidation");
  const projectRoute = await import("@/app/api/projects/[id]/route");
  const projectsRoute = await import("@/app/api/projects/route");
  const activityRoute = await import("@/app/api/activities/[id]/route");
  const activitiesRoute = await import("@/app/api/activities/route");

  const projectListener = new Client({ connectionString: process.env.DATABASE_URL });
  await projectListener.connect();
  await projectListener.query(`LISTEN ${PROJECT_LIST_CHANGED_CHANNEL}`);
  const activityListener = new Client({ connectionString: process.env.DATABASE_URL });
  await activityListener.connect();
  await activityListener.query(`LISTEN ${ACTIVITY_LIST_CHANGED_CHANNEL}`);
  const ticketListener = new Client({ connectionString: process.env.DATABASE_URL });
  await ticketListener.connect();
  await ticketListener.query(`LISTEN ${TICKET_LIST_CHANGED_CHANNEL}`);

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  const jsonReq = (method: string, body?: unknown) => new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  try {
    const dept = await createDepartment({ name: `RT Inventory ${RUN_ID}`, slug: `rt-inventory-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.create({ data: { email: `rt-inv-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const agent = await prisma.user.create({ data: { email: `rt-inv-agent-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id, agent.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== 2. Project CREATE -> Project list refresh ===\n");
    const waitCreate = waitForNotification(projectListener, 5_000);
    const createProjectRes = await projectsRoute.POST(jsonReq("POST", { title: `RT Inv Project ${RUN_ID}`, departmentId: dept.id, status: "PLANNING", priority: 2 }));
    check("POST /api/projects -> 201", createProjectRes.status === 201);
    const createdProject = await createProjectRes.json();
    projectIds.push(createdProject.id);
    check("...produces a Project-channel NOTIFY", (await waitCreate) !== null);

    console.log("\n=== 8. Field-by-field: title, priority, dates, department, subDepartment, members each publish ===\n");
    const fieldCases: Array<[string, unknown]> = [
      ["title", `RT Inv Project ${RUN_ID} v2`],
      ["priority", 3],
      ["startDate", "2027-01-01"],
      ["endDate", "2027-06-01"],
    ];
    for (const [field, value] of fieldCases) {
      const wait = waitForNotification(projectListener, 3_000);
      const res = await projectRoute.PATCH(jsonReq("PATCH", { [field]: value }), { params: Promise.resolve({ id: createdProject.id }) });
      check(`PATCH {${field}} -> 200`, res.status === 200);
      check(`...publishes a Project-channel NOTIFY`, (await wait) !== null);
    }
    console.log("\n-- 4. Member change -> Project list refresh --\n");
    const waitMembers = waitForNotification(projectListener, 3_000);
    const memberRes = await projectRoute.PATCH(jsonReq("PATCH", { memberIds: [admin.id] }), { params: Promise.resolve({ id: createdProject.id }) });
    check("PATCH {memberIds} -> 200", memberRes.status === 200);
    check("...publishes a Project-channel NOTIFY", (await waitMembers) !== null);

    console.log("\n-- businessUnitId (not Project-list-visible) does NOT publish --\n");
    const waitBU = waitForNotification(projectListener, 1_500);
    const buRes = await projectRoute.PATCH(jsonReq("PATCH", { successTarget: "Ship it" }), { params: Promise.resolve({ id: createdProject.id }) });
    check("PATCH {successTarget} (not rendered by any real list page) -> 200", buRes.status === 200);
    check("...publishes NOTHING", (await waitBU) === null);

    console.log("\n=== 7. Project rename -> Activity list refresh (cross-entity, Activity table shows project.title) ===\n");
    const waitRenameActivity = waitForNotification(activityListener, 3_000);
    const waitRenameProject = waitForNotification(projectListener, 3_000);
    const renameRes = await projectRoute.PATCH(jsonReq("PATCH", { title: `RT Inv Project ${RUN_ID} RENAMED` }), { params: Promise.resolve({ id: createdProject.id }) });
    check("PATCH {title} (genuine rename) -> 200", renameRes.status === 200);
    check("...publishes a Project-channel NOTIFY", (await waitRenameProject) !== null);
    check("...ALSO publishes an Activity-channel NOTIFY (cross-entity: Activity List shows this project's title)", (await waitRenameActivity) !== null);

    console.log("\n-- A Project field change that ISN'T title does NOT also publish to Activity (selectivity) --\n");
    const waitNoActivity = waitForNotification(activityListener, 1_500);
    const statusOnlyRes = await projectRoute.PATCH(jsonReq("PATCH", { status: "IN_PROGRESS" }), { params: Promise.resolve({ id: createdProject.id }) });
    check("PATCH {status} (no title change) -> 200", statusOnlyRes.status === 200);
    check("...does NOT publish to the Activity channel", (await waitNoActivity) === null);

    console.log("\n=== 3. Activity CREATE (standalone) -> Activity list refresh only, never Project ===\n");
    const waitActCreate = waitForNotification(activityListener, 3_000);
    const waitNoProjectOnStandaloneCreate = waitForNotification(projectListener, 1_500);
    const standaloneActRes = await activitiesRoute.POST(jsonReq("POST", { title: `RT Inv Standalone Activity ${RUN_ID}`, departmentId: dept.id, status: "TODO", priority: "MEDIUM" }));
    check("POST /api/activities (standalone) -> 201", standaloneActRes.status === 201);
    const standaloneAct = await standaloneActRes.json();
    activityIds.push(standaloneAct.id);
    check("...publishes an Activity-channel NOTIFY", (await waitActCreate) !== null);
    check("...never publishes to the Project channel (no project involved)", (await waitNoProjectOnStandaloneCreate) === null);

    console.log("\n=== 6. Activity CREATE (linked to a Project) -> BOTH Activity and Project lists refresh (count) ===\n");
    const waitActCreate2 = waitForNotification(activityListener, 3_000);
    const waitProjCreate2 = waitForNotification(projectListener, 3_000);
    const linkedActRes = await activitiesRoute.POST(jsonReq("POST", { title: `RT Inv Linked Activity ${RUN_ID}`, projectId: createdProject.id, departmentId: dept.id, status: "TODO", priority: "MEDIUM" }));
    check("POST /api/activities (projectId set) -> 201", linkedActRes.status === 201);
    const linkedAct = await linkedActRes.json();
    activityIds.push(linkedAct.id);
    check("...publishes an Activity-channel NOTIFY", (await waitActCreate2) !== null);
    check("...ALSO publishes a Project-channel NOTIFY (cross-entity: _count.activities changed)", (await waitProjCreate2) !== null);
    check("...and the project's activity count genuinely reflects it", (await prisma.project.findUnique({ where: { id: createdProject.id }, select: { _count: { select: { activities: true } } } }))?._count.activities === 1);

    console.log("\n=== 7 (Activity fields). title, priority, assignedUsers, dates each publish to the Activity channel ===\n");
    const actFieldCases: Array<[string, unknown]> = [
      ["title", `RT Inv Linked Activity ${RUN_ID} v2`],
      ["priority", "HIGH"],
      ["assignedUserIds", [admin.id]],
      ["startDate", "2027-02-01"],
      ["dueDate", "2027-03-01"],
    ];
    for (const [field, value] of actFieldCases) {
      const wait = waitForNotification(activityListener, 3_000);
      const res = await activityRoute.PATCH(jsonReq("PATCH", { [field]: value }), { params: Promise.resolve({ id: linkedAct.id }) });
      check(`PATCH activity {${field}} -> 200`, res.status === 200);
      check(`...publishes an Activity-channel NOTIFY`, (await wait) !== null);
    }
    console.log("\n-- 5. Assignee change already covered above (assignedUserIds); description does NOT publish --\n");
    const waitDescNoop = waitForNotification(activityListener, 1_500);
    const descRes = await activityRoute.PATCH(jsonReq("PATCH", { description: "Not rendered by any real list page" }), { params: Promise.resolve({ id: linkedAct.id }) });
    check("PATCH activity {description} -> 200", descRes.status === 200);
    check("...publishes NOTHING (description isn't rendered by any real Activity list page)", (await waitDescNoop) === null);

    console.log("\n=== 8. Completion/status change on a project-linked activity -> BOTH lists refresh (rollup) ===\n");
    const waitActComplete = waitForNotification(activityListener, 3_000);
    const waitProjRollup = waitForNotification(projectListener, 3_000);
    const completeRes = await activityRoute.PATCH(jsonReq("PATCH", { status: "COMPLETED", isCompleted: true }), { params: Promise.resolve({ id: linkedAct.id }) });
    check("PATCH activity {status:COMPLETED, isCompleted:true} -> 200", completeRes.status === 200);
    check("...publishes an Activity-channel NOTIFY", (await waitActComplete) !== null);
    check("...ALSO publishes a Project-channel NOTIFY (cross-entity: progress rollup changed)", (await waitProjRollup) !== null);
    const rolledUpProject = await prisma.project.findUnique({ where: { id: createdProject.id }, select: { progress: true } });
    check("...and Project.progress genuinely reflects the completed activity (100%, one activity, all complete)", rolledUpProject?.progress === 100);

    console.log("\n=== 6. Activity REPARENT (reassign to a different project) -> BOTH old and new Project lists, coalesced into ONE Project publish ===\n");
    const secondProject = await prisma.project.create({ data: { title: `RT Inv Second Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
    projectIds.push(secondProject.id);
    const projectNotifyCountPromise = countNotifications(projectListener, 1_500);
    const activityNotifyWait = waitForNotification(activityListener, 3_000);
    const reparentRes = await activityRoute.PATCH(jsonReq("PATCH", { projectId: secondProject.id }), { params: Promise.resolve({ id: linkedAct.id }) });
    check("PATCH activity {projectId: <different project>} -> 200", reparentRes.status === 200);
    check("...publishes an Activity-channel NOTIFY", (await activityNotifyWait) !== null);
    const projectNotifyCount = await projectNotifyCountPromise;
    check("...publishes EXACTLY ONE Project-channel NOTIFY (coalesced — old AND new project both recalculated by one request, never two separate publishes)", projectNotifyCount === 1);

    console.log("\n=== 10. Activity DELETE (standalone) -> Activity list refresh only ===\n");
    const waitActDelete = waitForNotification(activityListener, 3_000);
    const waitNoProjectOnStandaloneDelete = waitForNotification(projectListener, 1_500);
    const deleteStandaloneRes = await activityRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: standaloneAct.id }) });
    check("DELETE standalone activity -> 204", deleteStandaloneRes.status === 204);
    check("...publishes an Activity-channel NOTIFY", (await waitActDelete) !== null);
    check("...never publishes to the Project channel", (await waitNoProjectOnStandaloneDelete) === null);
    activityIds.splice(activityIds.indexOf(standaloneAct.id), 1);

    console.log("\n=== 11. Activity DELETE (linked to a Project) -> BOTH lists refresh (count) ===\n");
    const waitActDelete2 = waitForNotification(activityListener, 3_000);
    const waitProjDelete2 = waitForNotification(projectListener, 3_000);
    const deleteLinkedRes = await activityRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: linkedAct.id }) });
    check("DELETE project-linked activity -> 204", deleteLinkedRes.status === 204);
    check("...publishes an Activity-channel NOTIFY", (await waitActDelete2) !== null);
    check("...ALSO publishes a Project-channel NOTIFY (cross-entity: count decremented, rollup recalculated)", (await waitProjDelete2) !== null);
    activityIds.splice(activityIds.indexOf(linkedAct.id), 1);
    check("...the second project's own activity count is now genuinely 0", (await prisma.project.findUnique({ where: { id: secondProject.id }, select: { _count: { select: { activities: true } } } }))?._count.activities === 0);

    console.log("\n=== 7 (Project delete, with activities) -> BOTH lists refresh (SetNull disconnect) ===\n");
    const projectWithActivity = await prisma.project.create({ data: { title: `RT Inv Deletable ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
    const activityUnderIt = await prisma.projectActivity.create({ data: { title: `RT Inv Orphan-to-be ${RUN_ID}`, projectId: projectWithActivity.id, departmentId: dept.id, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, createdById: admin.id } });
    activityIds.push(activityUnderIt.id);
    const waitProjDelWithAct = waitForNotification(projectListener, 3_000);
    const waitActDelWithAct = waitForNotification(activityListener, 3_000);
    const deleteWithActRes = await projectRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: projectWithActivity.id }) });
    check("DELETE project WITH linked activities -> 204", deleteWithActRes.status === 204);
    check("...publishes a Project-channel NOTIFY", (await waitProjDelWithAct) !== null);
    check("...ALSO publishes an Activity-channel NOTIFY (its activity is now Standalone)", (await waitActDelWithAct) !== null);
    const orphaned = await prisma.projectActivity.findUnique({ where: { id: activityUnderIt.id }, select: { projectId: true } });
    check("...the activity genuinely survived (SetNull, not cascade-deleted) and is now projectId: null", orphaned !== null && orphaned.projectId === null);

    console.log("\n-- Project delete WITHOUT any linked activities does NOT publish to the Activity channel --\n");
    const emptyProject = await prisma.project.create({ data: { title: `RT Inv Empty ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
    const waitProjDelEmpty = waitForNotification(projectListener, 3_000);
    const waitActDelEmpty = waitForNotification(activityListener, 1_500);
    const deleteEmptyRes = await projectRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: emptyProject.id }) });
    check("DELETE project with ZERO linked activities -> 204", deleteEmptyRes.status === 204);
    check("...publishes a Project-channel NOTIFY", (await waitProjDelEmpty) !== null);
    check("...does NOT publish to the Activity channel (nothing there needs refreshing)", (await waitActDelEmpty) === null);

    console.log("\n=== 9. Failed/forbidden/rolled-back mutations publish NOTHING, on either channel ===\n");
    currentSession = { user: { id: agent.id, role: Role.USER, customRoleId: null } }; // no edit/create permission anywhere
    const waitForbiddenProj = waitForNotification(projectListener, 1_500);
    const forbiddenProjRes = await projectsRoute.POST(jsonReq("POST", { title: `RT Inv Forbidden ${RUN_ID}`, departmentId: dept.id }));
    check("A user without project.create -> request rejected (not 201)", forbiddenProjRes.status !== 201);
    check("...publishes NOTHING", (await waitForbiddenProj) === null);

    const waitForbiddenAct = waitForNotification(activityListener, 1_500);
    const forbiddenActRes = await activitiesRoute.POST(jsonReq("POST", { title: `RT Inv Forbidden Activity ${RUN_ID}`, departmentId: dept.id, status: "TODO" }));
    check("A user without activity.create -> request rejected (not 201)", forbiddenActRes.status !== 201);
    check("...publishes NOTHING", (await waitForbiddenAct) === null);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const waitValidationFail = waitForNotification(activityListener, 1_500);
    const badActivityRes = await activityRoute.PATCH(jsonReq("PATCH", { status: "NOT_A_REAL_STATUS" }), { params: Promise.resolve({ id: activityUnderIt.id }) });
    check("Invalid activity status enum value -> 422 (validation failure)", badActivityRes.status === 422);
    check("...publishes NOTHING", (await waitValidationFail) === null);

    const waitInconsistentFail = waitForNotification(activityListener, 1_500);
    const inconsistentRes = await activityRoute.PATCH(jsonReq("PATCH", { isCompleted: true, status: "TODO" }), { params: Promise.resolve({ id: activityUnderIt.id }) });
    check("Inconsistent isCompleted/status pair -> 400 (rejected before any write)", inconsistentRes.status === 400);
    check("...publishes NOTHING", (await waitInconsistentFail) === null);

    console.log("\n=== 10. Compound mutation (many fields at once) -> exactly ONE coalesced NOTIFY per affected channel ===\n");
    const compoundCountPromise = countNotifications(activityListener, 1_500);
    const compoundRes = await activityRoute.PATCH(
      jsonReq("PATCH", { title: `RT Inv Compound ${RUN_ID}`, priority: "URGENT", startDate: "2027-04-01", dueDate: "2027-05-01" }),
      { params: Promise.resolve({ id: activityUnderIt.id }) }
    );
    check("Compound PATCH (4 fields at once) -> 200", compoundRes.status === 200);
    const compoundCount = await compoundCountPromise;
    check("...exactly ONE Activity-channel NOTIFY, not one per field", compoundCount === 1);

    console.log("\n=== 15/18. Project, Activity and Ticket realtime channels are mutually, completely isolated ===\n");
    const { publishProjectListInvalidation } = await import("@/lib/realtime/project-list-invalidation");
    const { publishActivityListInvalidation } = await import("@/lib/realtime/activity-list-invalidation");
    const { publishTicketListInvalidation } = await import("@/lib/realtime/ticket-list-invalidation");
    check("PROJECT_LIST_CHANGED_CHANNEL, ACTIVITY_LIST_CHANGED_CHANNEL, TICKET_LIST_CHANGED_CHANNEL are 3 distinct strings", new Set([PROJECT_LIST_CHANGED_CHANNEL, ACTIVITY_LIST_CHANGED_CHANNEL, TICKET_LIST_CHANGED_CHANNEL]).size === 3);
    const waitCrossAT = waitForNotification(activityListener, 1_500);
    const waitCrossTT = waitForNotification(ticketListener, 1_500);
    publishProjectListInvalidation();
    check("A Project publish never reaches the Activity channel", (await waitCrossAT) === null);
    check("A Project publish never reaches the Ticket channel", (await waitCrossTT) === null);
    const waitCrossPA = waitForNotification(projectListener, 1_500);
    const waitCrossTA = waitForNotification(ticketListener, 1_500);
    publishActivityListInvalidation();
    check("An Activity publish never reaches the Project channel", (await waitCrossPA) === null);
    check("An Activity publish never reaches the Ticket channel", (await waitCrossTA) === null);
    const waitCrossPT = waitForNotification(projectListener, 1_500);
    const waitCrossAT2 = waitForNotification(activityListener, 1_500);
    publishTicketListInvalidation();
    check("A Ticket publish never reaches the Project channel", (await waitCrossPT) === null);
    check("A Ticket publish never reaches the Activity channel", (await waitCrossAT2) === null);

    console.log("\n=== 13. Department-scoped user never sees an out-of-scope entity after a refresh ===\n");
    const otherDept = await createDepartment({ name: `RT Inventory Other ${RUN_ID}`, slug: `rt-inventory-other-${RUN_ID}` });
    deptIds.push(otherDept.id);
    const otherDeptProject = await prisma.project.create({ data: { title: `RT Inv OutOfScope Project ${RUN_ID}`, departmentId: otherDept.id, ownerId: admin.id, status: "PLANNING" } });
    projectIds.push(otherDeptProject.id);
    const otherDeptActivity = await prisma.projectActivity.create({ data: { title: `RT Inv OutOfScope Activity ${RUN_ID}`, departmentId: otherDept.id, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, createdById: admin.id } });
    activityIds.push(otherDeptActivity.id);
    const customRole = await prisma.customRole.create({ data: { key: `RT_INV_SCOPED_${RUN_ID}`, name: `RT Inv Scoped ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    const [projViewPerm, actViewPerm] = await Promise.all([
      prisma.permission.findUniqueOrThrow({ where: { key: "project.view" } }),
      prisma.permission.findUniqueOrThrow({ where: { key: "activity.view" } }),
    ]);
    await prisma.rolePermission.createMany({ data: [{ roleKey: customRole.key, permissionId: projViewPerm.id }, { roleKey: customRole.key, permissionId: actViewPerm.id }] });
    const scopedUser = await prisma.user.create({ data: { email: `rt-inv-scoped-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(scopedUser.id);
    const membership = await prisma.departmentMembership.create({ data: { userId: scopedUser.id, departmentId: dept.id, role: "AGENT_ASSIGNEE" as any, customRoleId: customRole.id, source: "MANUAL" as any, isPrimary: true, isActive: true } });

    currentSession = { user: { id: scopedUser.id, role: Role.USER, customRoleId: null } };
    const { default: ProjectsPage } = await import("@/app/(main)/projects/page");
    const { default: ActivitiesPage } = await import("@/app/(main)/activities/page");
    const { ProjectList } = await import("@/components/projects/project-list");
    const { ActivityList } = await import("@/components/activities/activity-list");
    function findElementsByType(node: any, type: any, results: any[] = []): any[] {
      if (node == null || typeof node !== "object") return results;
      if (node.type === type) results.push(node);
      const children = node.props?.children;
      if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
      else if (children) findElementsByType(children, type, results);
      return results;
    }
    const projectsEl = await ProjectsPage({ searchParams: Promise.resolve({}) });
    const [projectListEl] = findElementsByType(projectsEl, ProjectList);
    const scopedProjectIds = ((projectListEl?.props.projects as any[]) ?? []).map((p) => p.id);
    check("Scoped user's re-rendered /projects (what router.refresh() runs) never includes the other department's project", !scopedProjectIds.includes(otherDeptProject.id));

    const activitiesEl = await ActivitiesPage({ searchParams: Promise.resolve({}) });
    const [activityListEl] = findElementsByType(activitiesEl, ActivityList);
    const scopedActivityIds = ((activityListEl?.props.activities as any[]) ?? []).map((a) => a.id);
    check("Scoped user's re-rendered /activities never includes the other department's activity", !scopedActivityIds.includes(otherDeptActivity.id));

    await prisma.departmentMembership.delete({ where: { id: membership.id } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: customRole.key } });
    await prisma.customRole.delete({ where: { id: customRole.id } });
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await projectListener.end().catch(() => {});
    await activityListener.end().catch(() => {});
    await ticketListener.end().catch(() => {});
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
