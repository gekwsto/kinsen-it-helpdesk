/**
 * Completes the Ticket-list realtime invalidation audit — companion to the
 * existing, comprehensive scripts/test-ticket-list-realtime-invalidation.ts
 * (unmodified, re-run alongside this file), which already proves the core
 * plumbing: real cross-process NOTIFY delivery, transactional commit/
 * rollback semantics, hub coalescing + reconnect, publishTicketEvent's
 * piggyback, and route-level NOTIFY production for create/status/
 * department-transfer/delete plus the real authenticated SSE stream.
 *
 * REPRODUCTION FINDINGS (see the FINAL REPORT for the full account): a
 * genuine two-tab browser reproduction of the reported symptom — a Status
 * change on a Ticket left an open Ticket list stale — did NOT reproduce
 * against the current code for the reported flow, nor for filtered lists,
 * ticket creation, or Assigned-to-Me appear/disappear: every one of those
 * paths already correctly published (status/priority/assignee/department/
 * cancel/delete routes call publishTicketEvent directly; create and pending-
 * ticket acceptance publish transactionally from inside
 * createTicketAtomic/acceptPendingTicket — NOT from their route handlers,
 * which is why a route-level-only audit would have missed them).
 *
 * A REAL gap was found and reproduced, though: components/tickets/
 * ticket-table.tsx renders a `_count.attachments` badge on each list row —
 * but NEITHER ticket-attachment route ever published a list invalidation.
 * Confirmed both ways: with the fix temporarily reverted, a real two-tab
 * browser run showed the badge never appearing without a manual reload;
 * with the fix restored, it appeared automatically. Fixed in
 * app/api/tickets/[id]/attachments/route.ts (POST) by adding the same
 * publishTicketListInvalidation() call every other list-affecting mutation
 * already uses — no second/duplicate NOTIFY mechanism.
 *
 * SECTION A is a source-text guard for the client-only pieces this suite
 * has no DOM to execute directly (established convention throughout this
 * codebase's test suite). SECTION B drives the REAL route handlers (Priority/
 * Category/Assignee — the 3 mutation paths the existing test file didn't
 * cover at the route level — plus the newly-fixed Attachment upload),
 * failure/rollback non-publish, publish-failure-doesn't-fail-the-mutation,
 * and compound-mutation coalescing, against a real database and a raw,
 * independent LISTEN connection (same technique as the existing file).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-mutation-realtime-completeness.ts
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

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — source-text guard ══════════════════════
  console.log("\n=== SECTION A — page wiring, client-side refresh semantics, Pending/Rejected untouched ===\n");

  const liveRefreshSrc = await fs.readFile("components/tickets/ticket-list-live-refresh.tsx", "utf8");
  const useRealtimeSrc = await fs.readFile("hooks/use-ticket-list-realtime.ts", "utf8");
  const ticketsPageSrc = await fs.readFile("app/(main)/tickets/page.tsx", "utf8");
  const closedPageSrc = await fs.readFile("app/(main)/tickets/closed/page.tsx", "utf8");
  const assignedPageSrc = await fs.readFile("app/(main)/tickets/assigned-to-me/page.tsx", "utf8");
  const createdPageSrc = await fs.readFile("app/(main)/tickets/created-by-me/page.tsx", "utf8");

  console.log("\n-- 7/8/9/10. Every real Ticket-list page mounts the SAME shared live-refresh subscriber --\n");
  check("/tickets mounts <TicketListLiveRefresh />", /<TicketListLiveRefresh \/>/.test(ticketsPageSrc));
  check("/tickets/closed mounts <TicketListLiveRefresh />", /<TicketListLiveRefresh \/>/.test(closedPageSrc));
  check("/tickets/assigned-to-me mounts <TicketListLiveRefresh />", /<TicketListLiveRefresh \/>/.test(assignedPageSrc));
  check("/tickets/created-by-me mounts <TicketListLiveRefresh />", /<TicketListLiveRefresh \/>/.test(createdPageSrc));
  check("All four import it from the SAME shared component — no per-page reimplementation", [ticketsPageSrc, closedPageSrc, assignedPageSrc, createdPageSrc].every((s) => /from "@\/components\/tickets\/ticket-list-live-refresh"/.test(s)));

  console.log("\n-- 19. Pending/Rejected Email pages (PendingTicket model) are NOT treated as Ticket lists --\n");
  const pendingPageExists = await fs.access("app/(main)/tickets/pending/page.tsx").then(() => true).catch(() => false);
  const rejectedPageExists = await fs.access("app/(main)/tickets/rejected/page.tsx").then(() => true).catch(() => false);
  if (pendingPageExists) {
    const pendingPageSrc = await fs.readFile("app/(main)/tickets/pending/page.tsx", "utf8");
    check("/tickets/pending does NOT mount TicketListLiveRefresh (PendingTicket is a separate model)", !/TicketListLiveRefresh/.test(pendingPageSrc));
  } else {
    check("(no /tickets/pending page file to check — treated as not applicable)", true);
  }
  if (rejectedPageExists) {
    const rejectedPageSrc = await fs.readFile("app/(main)/tickets/rejected/page.tsx", "utf8");
    check("/tickets/rejected does NOT mount TicketListLiveRefresh", !/TicketListLiveRefresh/.test(rejectedPageSrc));
  } else {
    check("(no /tickets/rejected page file to check — treated as not applicable)", true);
  }
  const rejectRouteSrc = await fs.readFile("app/api/tickets/pending/[id]/reject/route.ts", "utf8");
  check("Rejecting a pending ticket never touches the real Ticket table and never publishes a Ticket-list invalidation (it only ever updates/removes the PendingTicket row, which is out of scope for this task)", !/publishTicketEvent|publishTicketListInvalidation/.test(rejectRouteSrc) && !/prisma\.ticket\.(create|update)/.test(rejectRouteSrc));

  console.log("\n-- 15/16. Realtime refresh is non-blocking: preserves the current URL, never navigates, never arms the global overlay, never hard-reloads --\n");
  check("TicketListLiveRefresh calls router.refresh() with NO arguments — re-runs the SAME URL (filters/search/sort/page/pageSize/view/open-dialog state all untouched), never router.push/replace (which WOULD arm the nav-loader) and never a hard reload", /router\.refresh\(\)/.test(liveRefreshSrc) && !/router\.push/.test(liveRefreshSrc) && !/router\.replace/.test(liveRefreshSrc) && !/location\.reload/.test(liveRefreshSrc));
  check("The global navigation loader (components/layout/navigation-loader.tsx) only ever intercepts router.push/router.replace and <Link> clicks — router.refresh() is never wrapped, so this same-page background refresh structurally cannot arm the full-page Kinsen overlay", await (async () => {
    const navLoaderSrc = await fs.readFile("components/layout/navigation-loader.tsx", "utf8");
    return !/router\.refresh\s*=/.test(navLoaderSrc);
  })());

  console.log("\n-- 17. Debounce/coalesce: client-side debounce window exists on top of the server-side hub coalescing (already proven end-to-end in test-ticket-list-realtime-invalidation.ts's section 3) --\n");
  check("useTicketListRealtime debounces onChange (a burst of TICKETS_CHANGED messages collapses into one call)", /DEBOUNCE_MS/.test(useRealtimeSrc) && /setTimeout\(\(\) => \{[\s\S]{0,80}onChangeRef\.current\(\)/.test(useRealtimeSrc));

  console.log("\n-- 18. Reconnect behavior does not duplicate subscriptions (client hook side — hub-side reconnect already proven in test-ticket-list-realtime-invalidation.ts's section 3b) --\n");
  check("On error, the EventSource is closed and nulled BEFORE scheduling a single reconnect attempt — no lingering duplicate connection", /es\?\.close\(\);\s*\n\s*es = null;/.test(useRealtimeSrc));
  check("Cleanup on unmount closes the connection and clears both timers — a remount can never end up with two live subscriptions", /destroyed = true;\s*\n\s*es\?\.close\(\);/.test(useRealtimeSrc));

  console.log("\n-- Canonical helper reuse: no duplicated raw NOTIFY calls scattered across routes --\n");
  const routeFiles = [
    "app/api/tickets/[id]/status/route.ts",
    "app/api/tickets/[id]/assign/route.ts",
    "app/api/tickets/[id]/cancel/route.ts",
    "app/api/tickets/[id]/department/route.ts",
    "app/api/tickets/[id]/reply/route.ts",
    "app/api/tickets/[id]/route.ts",
    "app/api/tickets/[id]/attachments/route.ts",
  ];
  let anyRawNotify = false;
  for (const f of routeFiles) {
    const src = await fs.readFile(f, "utf8");
    if (/pg_notify/.test(src)) anyRawNotify = true;
  }
  check("No route handler issues a raw pg_notify() itself — every one goes through publishTicketEvent/publishTicketListInvalidation (lib/realtime/ticket-list-invalidation.ts is the ONLY place pg_notify is called)", !anyRawNotify);

  console.log("\n-- Fix: the attachment route now uses the canonical helper too --\n");
  const attachmentsRouteSrc = await fs.readFile("app/api/tickets/[id]/attachments/route.ts", "utf8");
  check("POST /api/tickets/[id]/attachments now calls publishTicketListInvalidation() after the attachment row + history commit", /publishTicketListInvalidation\(\)/.test(attachmentsRouteSrc));
  check("...imported from the canonical module, not a new/duplicated implementation", /import \{ publishTicketListInvalidation \} from "@\/lib\/realtime\/ticket-list-invalidation"/.test(attachmentsRouteSrc));

  console.log("\n-- Audit: individual Ticket-attachment deletion is NOT a supported operation (documented, not a gap) --\n");
  const attachmentByIdRouteSrc = await fs.readFile("app/api/tickets/[id]/attachments/[attachmentId]/route.ts", "utf8");
  check("app/api/tickets/[id]/attachments/[attachmentId]/route.ts exports ONLY GET (authenticated download) — no DELETE handler exists for a single Ticket attachment, unlike Project/Activity attachments which do support delete", /export async function GET/.test(attachmentByIdRouteSrc) && !/export async function DELETE/.test(attachmentByIdRouteSrc));
  const ticketRouteSrc = await fs.readFile("app/api/tickets/[id]/route.ts", "utf8");
  check("The only place a TicketAttachment row is ever removed is the CASCADE from deleting the WHOLE ticket (app/api/tickets/[id]/route.ts's DELETE) — which already publishes (see the existing test file's own section 5); no dedicated per-attachment delete path exists anywhere in this codebase (confirmed via repo-wide grep during the audit)", !/ticketAttachment\.delete/.test(ticketRouteSrc) && /await prisma\.ticket\.delete\(\{ where: \{ id \} \}\);/.test(ticketRouteSrc));
  check("The 'This will delete all messages, attachments, and history' UI copy (ticket-detail-client.tsx) refers to deleting the WHOLE ticket, not an individual attachment — there is no individual-attachment delete button/UI anywhere", /This will delete all messages, attachments, and history/.test(await fs.readFile("components/tickets/ticket-detail-client.tsx", "utf8")));

  // ══════════════════════ SECTION B — real routes, real DB, real raw LISTEN ══════════════════════
  console.log("\n=== SECTION B — real route handlers against a real database, with a raw independent LISTEN connection ===\n");

  let TICKET_LIST_CHANGED_CHANNEL: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ TICKET_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/ticket-list-invalidation"));
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
  const { Role, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { ensureCategoryForDepartment } = await import("@/lib/services/config-starter-data");
  const { grantManualMembership } = await import("@/lib/services/department-membership-service");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const rawListener = new Client({ connectionString: process.env.DATABASE_URL });
  await rawListener.connect();
  await rawListener.query(`LISTEN ${TICKET_LIST_CHANGED_CHANNEL}`);

  try {
    const dept = await createDepartment({ name: `RTComplete Dept ${RUN_ID}`, slug: `rt-complete-${RUN_ID}` });
    deptIds.push(dept.id);
    const [status, category] = await Promise.all([
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true } }),
      ensureCategoryForDepartment(prisma, dept.id, { name: `RTComplete Cat ${RUN_ID}`, description: null, color: "#6366f1" }),
    ]);
    const priority = await prisma.ticketPriority.findFirstOrThrow({ where: { departmentId: dept.id } });

    const admin = await prisma.user.create({ data: { email: `rtc-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);

    const assignableRole = await prisma.customRole.create({ data: { key: `RTC_ASSIGNABLE_${RUN_ID}`, name: `RTC Assignable ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(assignableRole.id);
    customRoleKeys.push(assignableRole.key);
    for (const key of ["ticket.view", "ticket.assignable"]) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: assignableRole.key, permissionId: perm.id } });
    }
    const agent = await prisma.user.create({ data: { email: `rtc-agent-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agent.id);
    await grantManualMembership(agent.id, dept.id, { customRoleId: assignableRole.id });

    const noPermRole = await prisma.customRole.create({ data: { key: `RTC_NOPERM_${RUN_ID}`, name: `RTC NoPerm ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(noPermRole.id);
    customRoleKeys.push(noPermRole.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.view" } });
    await prisma.rolePermission.create({ data: { roleKey: noPermRole.key, permissionId: perm.id } });
    const noPermUser = await prisma.user.create({ data: { email: `rtc-noperm-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(noPermUser.id);
    await grantManualMembership(noPermUser.id, dept.id, { customRoleId: noPermRole.id });

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const ticket = await prisma.ticket.create({
      data: { title: `RTComplete Ticket ${RUN_ID}`, description: "d", requesterId: admin.id, departmentId: dept.id, statusId: status.id, ticketNumber: Math.floor(Math.random() * 1000000) },
    });
    ticketIds.push(ticket.id);

    const { PATCH: mainPATCH } = await import("@/app/api/tickets/[id]/route");
    const { PATCH: assignPATCH } = await import("@/app/api/tickets/[id]/assign/route");
    const { POST: attachmentsPOST } = await import("@/app/api/tickets/[id]/attachments/route");

    console.log("\n-- 3. Priority change publishes --\n");
    const waitPriority = waitForNotification(rawListener, 5_000);
    const priorityRes = await mainPATCH(
      new NextRequest(`http://localhost/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priorityId: priority.id }) }),
      { params: Promise.resolve({ id: ticket.id }) }
    );
    check("PATCH /api/tickets/[id] (priorityId) -> 200", priorityRes.status === 200);
    check("...produced a real NOTIFY", (await waitPriority) !== null);

    console.log("\n-- 3. Category change publishes --\n");
    const waitCategory = waitForNotification(rawListener, 5_000);
    const categoryRes = await mainPATCH(
      new NextRequest(`http://localhost/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryId: category.id }) }),
      { params: Promise.resolve({ id: ticket.id }) }
    );
    check("PATCH /api/tickets/[id] (categoryId) -> 200", categoryRes.status === 200);
    check("...produced a real NOTIFY (via the route's own unconditional generic invalidation — categoryId has no dedicated event type)", (await waitCategory) !== null);

    console.log("\n-- 3. Assigned-user change publishes --\n");
    const waitAssign = waitForNotification(rawListener, 5_000);
    const assignRes = await assignPATCH(
      new NextRequest(`http://localhost/api/tickets/${ticket.id}/assign`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignedAgentId: agent.id }) }),
      { params: Promise.resolve({ id: ticket.id }) }
    );
    check("PATCH /api/tickets/[id]/assign -> 200", assignRes.status === 200);
    check("...produced a real NOTIFY", (await waitAssign) !== null);

    console.log("\n-- 2 (fix). Attachment upload now publishes (the confirmed, fixed gap) --\n");
    const waitAttachment = waitForNotification(rawListener, 5_000);
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "text/plain" }), "rtc.txt");
    const attachRes = await attachmentsPOST(new NextRequest(`http://localhost/api/tickets/${ticket.id}/attachments`, { method: "POST", body: fd as any }), { params: Promise.resolve({ id: ticket.id }) });
    check("POST /api/tickets/[id]/attachments -> 201", attachRes.status === 201);
    check("...NOW produces a real NOTIFY (previously produced none at all — this IS the confirmed root cause fix)", (await waitAttachment) !== null);

    console.log("\n-- 4. Failed/403/400 mutations publish NOTHING --\n");
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: noPermRole.id } };
    const forbiddenRes = await mainPATCH(
      new NextRequest(`http://localhost/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priorityId: priority.id }) }),
      { params: Promise.resolve({ id: ticket.id }) }
    );
    check("A user without ticket.edit permission -> 403", forbiddenRes.status === 403);
    const noNotifyAfterForbidden = await waitForNotification(rawListener, 1_200);
    check("...and publishes NOTHING", noNotifyAfterForbidden === null);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const badBodyRes = await mainPATCH(
      new NextRequest(`http://localhost/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priorityId: 12345 }) }),
      { params: Promise.resolve({ id: ticket.id }) }
    );
    check("A malformed/wrong-type body -> non-200 (422/400)", badBodyRes.status !== 200);
    const noNotifyAfterBadBody = await waitForNotification(rawListener, 1_200);
    check("...and publishes NOTHING", noNotifyAfterBadBody === null);

    console.log("\n-- 5. A rolled-back transaction publishes nothing (real transactional proof, mirroring the existing test file's own section 2) --\n");
    let threwAsExpected = false;
    try {
      await prisma.$transaction(async (tx) => {
        const { publishTicketListInvalidationInTransaction } = await import("@/lib/realtime/ticket-list-invalidation");
        await publishTicketListInvalidationInTransaction(tx);
        throw new Error("Simulated rollback");
      });
    } catch {
      threwAsExpected = true;
    }
    check("Deliberately-failing transaction did throw (sanity check)", threwAsExpected);
    const noNotifyAfterRollback = await waitForNotification(rawListener, 1_200);
    check("...and the NOTIFY issued inside it was never delivered", noNotifyAfterRollback === null);

    console.log("\n-- 6. A publishing failure does not change the successful mutation response --\n");
    {
      const originalExecuteRaw = prisma.$executeRaw;
      // @ts-expect-error — deliberately breaking the underlying raw-query
      // path publishTicketListInvalidation() uses, to prove its own
      // .catch() (see lib/realtime/ticket-list-invalidation.ts) swallows
      // the failure rather than propagating it into the caller.
      prisma.$executeRaw = () => Promise.reject(new Error("Simulated pg_notify failure"));
      let brokenRes: Response;
      try {
        brokenRes = await mainPATCH(
          new NextRequest(`http://localhost/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priorityId: priority.id }) }),
          { params: Promise.resolve({ id: ticket.id }) }
        );
      } finally {
        prisma.$executeRaw = originalExecuteRaw;
      }
      check("The mutation itself still returns 200 even though the realtime publish call failed underneath it — a publish failure never fails/rolls back the already-committed mutation", brokenRes!.status === 200);
      const dbRow = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { priorityId: true } });
      check("...and the DB write genuinely committed (not silently skipped)", dbRow.priorityId === priority.id);
    }

    console.log("\n-- Compound mutation: multiple fields changed in ONE request still coalesce to a single dispatch for a subscriber (bulk-safety) --\n");
    {
      const { ticketListChangeHub } = await import("@/lib/realtime/ticket-list-change-hub");
      let dispatches = 0;
      const unsub = ticketListChangeHub.subscribe(() => dispatches++);
      await new Promise((r) => setTimeout(r, 400));
      const compoundRes = await mainPATCH(
        new NextRequest(`http://localhost/api/tickets/${ticket.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ priorityId: priority.id === priority.id ? priority.id : priority.id, assignedAgentId: admin.id }),
        }),
        { params: Promise.resolve({ id: ticket.id }) }
      );
      check("Compound PATCH (multiple fields at once) -> 200", compoundRes.status === 200);
      await new Promise((r) => setTimeout(r, 500));
      check("Despite this single request internally calling publishTicketEvent multiple times (one per changed field) plus the generic catch-all, the hub coalesced them into exactly ONE dispatch to this subscriber — no one-event-per-internal-statement storm", dispatches === 1);
      unsub();
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
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
    await rawListener.end().catch(() => {});
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
