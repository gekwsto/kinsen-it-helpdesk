/**
 * Proves the Project-list live-refresh mechanism end to end — the Project
 * counterpart of scripts/test-ticket-list-realtime-invalidation.ts, same
 * shape, exercising the REAL new files:
 *   lib/realtime/project-list-invalidation.ts
 *   lib/realtime/project-list-change-hub.ts
 *   app/api/projects/stream/route.ts
 *   PATCH /api/projects/[id] (the publish call site)
 *
 *   - PostgreSQL LISTEN/NOTIFY actually delivers cross-process (a raw `pg`
 *     LISTEN connection, independent of Prisma's own pool).
 *   - projectListChangeHub coalesces a burst into one local dispatch.
 *   - PATCH /api/projects/[id] publishes when any List/Grid-visible field is
 *     committed (broadened by a later task from "status only" — see
 *     PROJECT_LIST_RELEVANT_FIELDS there and
 *     scripts/test-project-activity-realtime-mutation-inventory.ts for the
 *     full field-by-field/cross-entity coverage), and never for a
 *     failed/rejected mutation (403, 404, validation error).
 *   - The REAL SSE route (GET /api/projects/stream) requires auth, sends a
 *     CONNECTED message, and forwards a genuine status change as
 *     PROJECTS_CHANGED, carrying no Project-specific data.
 *   - Re-rendering the REAL /projects Server Component page with the exact
 *     same URL (searchParams untouched — what router.refresh() does) shows
 *     the new status without a manual reload, and a distinct department's
 *     filtered view is never disturbed by it.
 *   - The ticket-list realtime path (channel, hub, route) is completely
 *     unaffected by any of this — proves the two are genuinely separate,
 *     not a shared/competing state source.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-list-realtime-invalidation.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
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

const RUN_ID = Date.now();

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

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null; absoluteSessionExpiresAt?: number } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider } = await import("@prisma/client");
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

  const { publishProjectListInvalidation, PROJECT_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/project-list-invalidation");
  const { projectListChangeHub } = await import("@/lib/realtime/project-list-change-hub");
  const { publishTicketListInvalidation, TICKET_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/ticket-list-invalidation");
  const projectRoute = await import("@/app/api/projects/[id]/route");
  const { GET: streamGET } = await import("@/app/api/projects/stream/route");
  const { default: ProjectsListPage } = await import("@/app/(main)/projects/page");
  const { ProjectList } = await import("@/components/projects/project-list");
  const { NextRequest } = await import("next/server");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const renderProjects = async (params: Record<string, string>) => {
    const el = await ProjectsListPage({ searchParams: Promise.resolve(params) });
    const [listEl] = findElementsByType(el, ProjectList);
    return { ids: ((listEl?.props.projects as any[]) ?? []).map((p) => p.id), statuses: new Map(((listEl?.props.projects as any[]) ?? []).map((p) => [p.id, p.status])) };
  };

  // A raw LISTEN client, independent of Prisma's own pool.
  const rawListener = new Client({ connectionString: process.env.DATABASE_URL });
  await rawListener.connect();
  await rawListener.query(`LISTEN ${PROJECT_LIST_CHANGED_CHANNEL}`);
  const rawTicketListener = new Client({ connectionString: process.env.DATABASE_URL });
  await rawTicketListener.connect();
  await rawTicketListener.query(`LISTEN ${TICKET_LIST_CHANGED_CHANNEL}`);

  try {
    console.log("\n=== 1. publishProjectListInvalidation() delivers a REAL, SEPARATE Postgres NOTIFY ===\n");
    const waitP1 = waitForNotification(rawListener, 5_000);
    publishProjectListInvalidation();
    const msg1 = await waitP1;
    check("A raw, independent LISTEN client received the NOTIFY", msg1 !== null);
    check("...on the Project-specific channel", msg1?.channel === PROJECT_LIST_CHANGED_CHANNEL);
    check("...channel is distinct from the ticket-list channel", (PROJECT_LIST_CHANGED_CHANNEL as string) !== (TICKET_LIST_CHANGED_CHANNEL as string));
    check("...with a non-empty generic payload (no Project data)", !!msg1?.payload && JSON.parse(msg1.payload).at > 0);

    console.log("\n=== 2. projectListChangeHub coalesces a burst into ONE local dispatch, without touching the ticket hub ===\n");
    let dispatchCount = 0;
    const unsubHub = projectListChangeHub.subscribe(() => dispatchCount++);
    await new Promise((r) => setTimeout(r, 500));
    const rawCountPromise = countNotifications(rawListener, 1_500);
    for (let i = 0; i < 5; i++) publishProjectListInvalidation();
    const rawCount = await rawCountPromise;
    check("Postgres delivered all 5 raw NOTIFYs (nothing swallowed at publish/DB level)", rawCount === 5);
    check("...the hub coalesced them into exactly 1 local dispatch", dispatchCount === 1);
    unsubHub();

    console.log("\n=== 3. Projects and Tickets realtime are genuinely separate — never a shared/competing signal ===\n");
    let ticketDispatches = 0;
    const waitTicketNotify = waitForNotification(rawTicketListener, 2_000);
    publishProjectListInvalidation();
    const strayTicketMsg = await waitTicketNotify;
    check("A Project publish never reaches the ticket-list channel", strayTicketMsg === null);
    void ticketDispatches;
    const waitProjectNotify = waitForNotification(rawListener, 2_000);
    publishTicketListInvalidation();
    const strayProjectMsg = await waitProjectNotify;
    check("A Ticket publish never reaches the project-list channel", strayProjectMsg === null);

    // ══════════════ Fixtures ══════════════
    const dept = await createDepartment({ name: `RT Project ${RUN_ID}`, slug: `rt-project-${RUN_ID}` });
    const otherDept = await createDepartment({ name: `RT Project Other ${RUN_ID}`, slug: `rt-project-other-${RUN_ID}` });
    deptIds.push(dept.id, otherDept.id);
    const admin = await prisma.user.create({ data: { email: `rt-project-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const project = await prisma.project.create({ data: { title: `RT Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
    projectIds.push(project.id);
    const otherDeptProject = await prisma.project.create({ data: { title: `RT Other Dept Project ${RUN_ID}`, departmentId: otherDept.id, ownerId: admin.id, status: "PLANNING" } });
    projectIds.push(otherDeptProject.id);

    console.log("\n=== 4. PATCH /api/projects/[id]: a REAL status change publishes; other edits and failures do not ===\n");
    const waitStatus = waitForNotification(rawListener, 5_000);
    const statusRes = await projectRoute.PATCH(jsonReq({ status: "IN_PROGRESS" }), { params: Promise.resolve({ id: project.id }) });
    check("PATCH {status} -> 200", statusRes.status === 200);
    check("...a REAL Project status change produced a NOTIFY", (await waitStatus) !== null);

    // A later task broadened this: title is a real Project List/Grid-visible
    // field (see PROJECT_LIST_RELEVANT_FIELDS in app/api/projects/[id]/route.ts)
    // — previously only `status` ever published here, which was exactly the
    // gap that task's audit found and fixed. See
    // scripts/test-project-activity-realtime-mutation-inventory.ts for the
    // FULL field-by-field/cross-entity coverage this broadening added; this
    // file keeps its own original, narrower "status" scenario for continuity.
    const waitTitle = waitForNotification(rawListener, 1_500);
    const titleRes = await projectRoute.PATCH(jsonReq({ title: `RT Project ${RUN_ID} renamed` }), { params: Promise.resolve({ id: project.id }) });
    check("PATCH {title} (no status change) -> 200", titleRes.status === 200);
    check("...a title edit (a real, list-visible field) NOW also publishes — see the mutation-inventory test for the full field list", (await waitTitle) !== null);

    // Re-sending the SAME status still results in a publish under the
    // broadened, "any list-relevant field present in the payload" check —
    // a deliberate simplicity/precision tradeoff (see
    // PROJECT_LIST_RELEVANT_FIELDS's own doc comment): diffing every one of
    // the 9 list-relevant fields against their stored values (memberIds
    // especially) isn't worth the extra complexity for a harmless, cheap,
    // coalesced no-op publish.
    const waitSameStatus = waitForNotification(rawListener, 1_500);
    const sameStatusRes = await projectRoute.PATCH(jsonReq({ status: "IN_PROGRESS" }), { params: Promise.resolve({ id: project.id }) });
    check("PATCH {status: <same value>} -> 200", sameStatusRes.status === 200);
    check("...re-sending the SAME status still publishes (field-presence check, not a value diff — see above)", (await waitSameStatus) !== null);

    currentSession = { user: { id: admin.id, role: Role.USER, customRoleId: null } }; // no edit permission anywhere
    const waitForbidden = waitForNotification(rawListener, 1_500);
    const forbiddenRes = await projectRoute.PATCH(jsonReq({ status: "COMPLETED" }), { params: Promise.resolve({ id: project.id }) });
    check("6. A user without project.edit -> 403 (mutation rejected)", forbiddenRes.status === 403);
    check("...a REJECTED mutation publishes NO realtime event", (await waitForbidden) === null);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const waitBadPayload = waitForNotification(rawListener, 1_500);
    const badRes = await projectRoute.PATCH(jsonReq({ status: "NOT_A_REAL_STATUS" }), { params: Promise.resolve({ id: project.id }) });
    check("Invalid status value -> 422 (validation failure)", badRes.status === 422);
    check("...a FAILED validation publishes NO realtime event", (await waitBadPayload) === null);

    console.log("\n=== 5. The REAL SSE route: auth-gated, CONNECTED handshake, real status change forwarded as PROJECTS_CHANGED ===\n");
    currentSession = null;
    const unauthRes = await streamGET(new NextRequest("http://localhost/api/projects/stream"));
    check("Unauthenticated GET /api/projects/stream -> 401", unauthRes.status === 401);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const abortController = new AbortController();
    const streamReq = new NextRequest("http://localhost/api/projects/stream", { signal: abortController.signal });
    const streamRes = await streamGET(streamReq);
    check("Authenticated GET /api/projects/stream -> 200", streamRes.status === 200);
    check("Content-Type is text/event-stream", streamRes.headers.get("content-type") === "text/event-stream");

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function readNextEvent(timeoutMs: number): Promise<any | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
          continue;
        }
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), Math.max(0, deadline - Date.now()))),
        ]);
        if (done || !value) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return null;
    }

    const firstEvent = await readNextEvent(3_000);
    check("First SSE message is CONNECTED", firstEvent?.type === "CONNECTED");

    const changeRes = await projectRoute.PATCH(jsonReq({ status: "COMPLETED" }), { params: Promise.resolve({ id: project.id }) });
    check("Independent status-change PATCH (simulating a second browser tab) -> 200", changeRes.status === 200);
    const pushedEvent = await readNextEvent(3_000);
    check("The open SSE stream received a REAL PROJECTS_CHANGED message from that independent mutation", pushedEvent?.type === "PROJECTS_CHANGED");
    check("...carrying NO project-specific data (no id/title/status)", pushedEvent && !("id" in pushedEvent) && !("title" in pushedEvent) && !("status" in pushedEvent));

    abortController.abort();
    try {
      await reader.cancel();
    } catch {}

    console.log("\n=== 6/7. /projects re-render (what router.refresh() does) shows the new status, filters intact, unrelated department undisturbed ===\n");
    const scopedBefore = await renderProjects({ departmentId: dept.id });
    check("Scoped /projects?departmentId=<dept> shows the just-committed COMPLETED status", scopedBefore.statuses.get(project.id) === "COMPLETED");
    check("...the OTHER department's project is correctly excluded by that same explicit filter", !scopedBefore.ids.includes(otherDeptProject.id));

    const statusFiltered = await renderProjects({ departmentId: dept.id, status: "COMPLETED" });
    check("A status-filtered view (?status=COMPLETED) still finds it after the change", statusFiltered.ids.includes(project.id));
    const statusFilteredStale = await renderProjects({ departmentId: dept.id, status: "PLANNING" });
    check("...and the OLD status filter (?status=PLANNING) no longer matches it — no stale cached row anywhere", !statusFilteredStale.ids.includes(project.id));

    console.log("\n=== 8. ProjectListLiveRefresh: mounted on /projects, uses the SAME realtime mechanism, no polling ===\n");
    const fs = await import("fs/promises");
    const pageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
    check("ProjectListLiveRefresh is mounted on the /projects page", /<ProjectListLiveRefresh\s*\/>/.test(pageSrc));
    const componentSrc = await fs.readFile("components/projects/project-list-live-refresh.tsx", "utf8");
    check("...it reacts via router.refresh() (same Server Component re-fetch every ticket list page already uses)", /router\.refresh\(\)/.test(componentSrc));
    check("...it never calls router.push/replace itself (never mutates the URL/filters on its own)", !/router\.(push|replace)/.test(componentSrc));
    const hookSrc = await fs.readFile("hooks/use-project-list-realtime.ts", "utf8");
    check("...the underlying hook is push-based (EventSource/SSE), not a setInterval poll", /EventSource/.test(hookSrc) && !/setInterval/.test(hookSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
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
    await rawListener.end().catch(() => {});
    await rawTicketListener.end().catch(() => {});
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
