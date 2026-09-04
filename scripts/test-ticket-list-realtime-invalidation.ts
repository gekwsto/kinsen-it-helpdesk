/**
 * Proves the ticket-list live-refresh mechanism end to end:
 *   - PostgreSQL LISTEN/NOTIFY actually delivers cross-process (a raw `pg`
 *     LISTEN connection, completely independent of Prisma's own pool,
 *     receives what Prisma's $executeRaw pg_notify() publishes) — the real
 *     proof this is NOT the in-process-only event bus pattern.
 *   - A NOTIFY issued inside a transaction only ever arrives if that
 *     transaction actually commits, never on rollback.
 *   - ticketListChangeHub coalesces a burst of NOTIFYs into a single local
 *     dispatch.
 *   - publishTicketEvent's existing 7 call sites now ALSO trigger list
 *     invalidation, without breaking the pre-existing per-ticket event bus.
 *   - The REAL route handlers (POST /api/tickets, PATCH .../status, PATCH
 *     .../department, DELETE) each produce a real NOTIFY.
 *   - The REAL SSE route (GET /api/tickets/stream) requires auth, sends a
 *     CONNECTED message, and forwards a genuine TICKETS_CHANGED message
 *     when a real ticket mutation happens elsewhere — driven through an
 *     actual ReadableStream reader, not a mock.
 *
 * Must run with --experimental-test-module-mocks (route-level sections
 * mock @/lib/auth) — dynamically imported AFTER mock.module() registers,
 * same documented pitfall as scripts/test-ticket-config-ownership-integrity.ts.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-list-realtime-invalidation.ts
 */
import { mock } from "node:test";
import { Client, type Notification } from "pg";

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

const RUN_ID = Date.now();

/** Waits for the next `notification` event on a raw LISTEN client, or null if none arrives within timeoutMs. */
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

/** Counts every `notification` event received within windowMs (does not stop early). */
function countNotifications(client: Client, windowMs: number): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const onNotify = () => {
      count++;
    };
    client.on("notification", onNotify);
    setTimeout(() => {
      client.removeListener("notification", onNotify);
      resolve(count);
    }, windowMs);
  });
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null; absoluteSessionExpiresAt?: number } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider } = await import("@prisma/client");
  const { publishTicketListInvalidation, publishTicketListInvalidationInTransaction, TICKET_LIST_CHANGED_CHANNEL } = await import(
    "@/lib/realtime/ticket-list-invalidation"
  );
  const { ticketListChangeHub } = await import("@/lib/realtime/ticket-list-change-hub");
  const { publishTicketEvent } = await import("@/lib/realtime/publisher");
  const { ticketEventBus } = await import("@/lib/realtime/event-bus");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { ensureCategoryForDepartment } = await import("@/lib/services/config-starter-data");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(0);
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];

  // A raw LISTEN client, completely independent of Prisma's own pool — this
  // is what makes the following checks a genuine proof of cross-process
  // delivery, not just "the same in-memory object got called".
  const rawListener = new Client({ connectionString: process.env.DATABASE_URL });
  await rawListener.connect();
  await rawListener.query(`LISTEN ${TICKET_LIST_CHANGED_CHANNEL}`);

  try {
    // ══════════════ 1. Real cross-connection NOTIFY delivery ══════════════
    console.log("\n=== 1. publishTicketListInvalidation() delivers a REAL Postgres NOTIFY to an independent LISTEN connection ===\n");
    const waitP1 = waitForNotification(rawListener, 5_000);
    publishTicketListInvalidation();
    const msg1 = await waitP1;
    check("A raw, independent LISTEN client received the NOTIFY", msg1 !== null);
    check("...on the expected channel", msg1?.channel === TICKET_LIST_CHANGED_CHANNEL);
    check("...with a non-empty, generic payload (a bare timestamp pulse — see the module's own doc comment)", !!msg1?.payload && JSON.parse(msg1.payload).at > 0);

    // ══════════════ 2. Transactional variant: commit delivers, rollback never does ══════════════
    console.log("\n=== 2. Transactional publish only ever arrives on a REAL commit, never on rollback ===\n");
    let threwAsExpected = false;
    try {
      await prisma.$transaction(async (tx) => {
        await publishTicketListInvalidationInTransaction(tx);
        throw new Error("Simulated rollback — the NOTIFY issued above must never be delivered");
      });
    } catch {
      threwAsExpected = true;
    }
    check("The deliberately-failing transaction did throw (sanity check)", threwAsExpected);
    const msgAfterRollback = await waitForNotification(rawListener, 1_500);
    check("No NOTIFY was delivered for the ROLLED-BACK transaction", msgAfterRollback === null);

    const waitP2 = waitForNotification(rawListener, 5_000);
    await prisma.$transaction(async (tx) => {
      await publishTicketListInvalidationInTransaction(tx);
    });
    const msg2 = await waitP2;
    check("A NOTIFY WAS delivered for the transaction that actually committed", msg2 !== null);

    // ══════════════ 3. ticketListChangeHub coalesces a burst into one local dispatch ══════════════
    console.log("\n=== 3. ticketListChangeHub coalesces a burst of NOTIFYs into ONE local dispatch ===\n");
    let dispatchCount = 0;
    const unsubscribeHub = ticketListChangeHub.subscribe(() => {
      dispatchCount++;
    });
    // Give the hub's own lazily-created LISTEN connection a moment to
    // actually establish before firing the burst.
    await new Promise((r) => setTimeout(r, 500));
    const rawCountPromise = countNotifications(rawListener, 1_500);
    for (let i = 0; i < 5; i++) publishTicketListInvalidation();
    const rawCount = await rawCountPromise;
    check("Postgres itself genuinely delivered all 5 raw NOTIFYs to the independent listener (nothing swallowed at the publish/DB level)", rawCount === 5);
    check("...yet the hub coalesced them into exactly 1 local dispatch (not 5) — the coalescing is a hub-level behavior, not fewer NOTIFYs having been sent", dispatchCount === 1);
    unsubscribeHub();

    // Unsubscribed listener receives nothing further.
    let dispatchCountAfterUnsub = 0;
    const unsub2 = ticketListChangeHub.subscribe(() => {
      dispatchCountAfterUnsub++;
    });
    unsub2();
    publishTicketListInvalidation();
    await new Promise((r) => setTimeout(r, 500));
    check("An unsubscribed listener receives nothing further (no leak)", dispatchCountAfterUnsub === 0);

    // ══════════════ 3b. Reconnect after an interrupted realtime connection ══════════════
    console.log("\n=== 3b. ticketListChangeHub reconnects on its own after its DB connection drops, and resumes receiving NOTIFYs ===\n");
    let dispatchCountReconnect = 0;
    const unsubReconnect = ticketListChangeHub.subscribe(() => {
      dispatchCountReconnect++;
    });
    await new Promise((r) => setTimeout(r, 500)); // ensure connected before interrupting it
    // Simulate a real connection drop (network blip, DB restart) the exact
    // way the underlying `pg` client would report one — via its own
    // 'error' event, the same handler a genuine disconnect triggers.
    const hubInternals = ticketListChangeHub as unknown as { client: { emit: (event: string, err: Error) => void } | null };
    check("Fixture: the hub has an active internal connection to interrupt", hubInternals.client !== null);
    hubInternals.client?.emit("error", new Error("Simulated connection drop for reconnect test"));

    // Immediately after the simulated drop, a publish should NOT be
    // delivered (the connection is down / being re-established).
    const dispatchCountRightAfterDrop = dispatchCountReconnect;
    publishTicketListInvalidation();
    await new Promise((r) => setTimeout(r, 800));
    check("No dispatch happens for a publish sent WHILE the connection is down", dispatchCountReconnect === dispatchCountRightAfterDrop);

    // Poll for reconnection (the hub's fixed 5s reconnect delay + time to
    // re-establish + LISTEN again) rather than a single brittle sleep.
    let reconnected = false;
    const reconnectDeadline = Date.now() + 15_000;
    while (Date.now() < reconnectDeadline && !reconnected) {
      await new Promise((r) => setTimeout(r, 500));
      reconnected = hubInternals.client !== null;
    }
    check("The hub reconnected on its own within a bounded window, no manual intervention needed", reconnected);

    const dispatchCountBeforeResume = dispatchCountReconnect;
    publishTicketListInvalidation();
    await new Promise((r) => setTimeout(r, 1_000));
    check("...and resumes receiving/dispatching NOTIFYs normally after reconnecting", dispatchCountReconnect > dispatchCountBeforeResume);
    unsubReconnect();

    // ══════════════ 4. publishTicketEvent now ALSO triggers list invalidation, without breaking the existing per-ticket bus ══════════════
    console.log("\n=== 4. publishTicketEvent (all 7 existing call sites) now also triggers list invalidation — per-ticket bus unaffected ===\n");
    let listDispatched = false;
    const unsubHub2 = ticketListChangeHub.subscribe(() => {
      listDispatched = true;
    });
    const perTicketReceived: unknown[] = [];
    const unsubTicketBus = ticketEventBus.subscribe(`piggyback-test-${RUN_ID}`, (e) => perTicketReceived.push(e));
    publishTicketEvent("TICKET_STATUS_CHANGED", `piggyback-test-${RUN_ID}`, "actor", { status: { name: "Open" } });
    await new Promise((r) => setTimeout(r, 500));
    check("The existing per-ticket-detail bus still receives the event unaffected", perTicketReceived.length === 1);
    check("...AND the generic list-invalidation hub also received a dispatch from the SAME call", listDispatched);
    unsubHub2();
    unsubTicketBus();

    // ══════════════ Fixtures for route-level proof ══════════════
    const deptA = await createDepartment({ name: `RT Invalidation Dept A ${RUN_ID}`, slug: `rt-invalidation-dept-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `RT Invalidation Dept B ${RUN_ID}`, slug: `rt-invalidation-dept-b-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id);
    const [statusA, categoryA] = await Promise.all([
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isDefault: true } }),
      ensureCategoryForDepartment(prisma, deptA.id, { name: "Hardware", description: null, color: "#6366f1" }),
    ]);
    const openStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isDefault: true } });
    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: true } });

    const admin = await prisma.user.create({ data: { email: `rt-invalidation-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const { POST: ticketsPOST } = await import("@/app/api/tickets/route");
    const { PATCH: statusPATCH } = await import("@/app/api/tickets/[id]/status/route");
    const { PATCH: departmentPATCH } = await import("@/app/api/tickets/[id]/department/route");
    const { DELETE: ticketDELETE } = await import("@/app/api/tickets/[id]/route");
    const { GET: streamGET } = await import("@/app/api/tickets/stream/route");
    const { NextRequest } = await import("next/server");

    // ══════════════ 5. Real route handlers each produce a real NOTIFY ══════════════
    console.log("\n=== 5. Real route handlers (create/status/department-transfer/delete) each produce a real NOTIFY ===\n");

    const waitCreate = waitForNotification(rawListener, 5_000);
    const createRes = await ticketsPOST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Realtime invalidation test ticket", description: "Proving the create boundary publishes.", departmentId: deptA.id, categoryId: categoryA.id }),
      })
    );
    check("POST /api/tickets -> 201", createRes.status === 201);
    const createdTicket = await createRes.json();
    if (createdTicket?.id) ticketIds.push(createdTicket.id);
    check("POST /api/tickets (createTicketAtomic) produced a real NOTIFY", (await waitCreate) !== null);

    const waitStatus = waitForNotification(rawListener, 5_000);
    const statusRes = await statusPATCH(
      new NextRequest(`http://localhost/api/tickets/${createdTicket.id}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statusId: closedStatusA.id }),
      }),
      { params: Promise.resolve({ id: createdTicket.id }) }
    );
    check("PATCH .../status -> 200", statusRes.status === 200);
    check("PATCH .../status (via publishTicketEvent) produced a real NOTIFY", (await waitStatus) !== null);

    const waitDept = waitForNotification(rawListener, 5_000);
    const deptRes = await departmentPATCH(
      new NextRequest(`http://localhost/api/tickets/${createdTicket.id}/department`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ departmentId: deptB.id }),
      }),
      { params: Promise.resolve({ id: createdTicket.id }) }
    );
    check("PATCH .../department -> 200", deptRes.status === 200);
    check("PATCH .../department (previously published NOTHING at all) now produces a real NOTIFY", (await waitDept) !== null);
    void openStatusB;
    void statusA;

    const waitDelete = waitForNotification(rawListener, 5_000);
    const deleteRes = await ticketDELETE(new NextRequest(`http://localhost/api/tickets/${createdTicket.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: createdTicket.id }),
    });
    check("DELETE /api/tickets/[id] -> 204", deleteRes.status === 204);
    check("DELETE (ticket removed from every list) produced a real NOTIFY", (await waitDelete) !== null);
    ticketIds.length = 0; // the ticket no longer exists — nothing left to clean up for it

    // ══════════════ 6. The REAL SSE route: auth-gated, CONNECTED handshake, and a genuine end-to-end push ══════════════
    console.log("\n=== 6. GET /api/tickets/stream: requires auth, sends CONNECTED, then forwards a REAL mutation as TICKETS_CHANGED ===\n");
    currentSession = null;
    const unauthRes = await streamGET(new NextRequest("http://localhost/api/tickets/stream"));
    check("Unauthenticated GET /api/tickets/stream -> 401", unauthRes.status === 401);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const abortController = new AbortController();
    const streamReq = new NextRequest("http://localhost/api/tickets/stream", { signal: abortController.signal });
    const streamRes = await streamGET(streamReq);
    check("Authenticated GET /api/tickets/stream -> 200", streamRes.status === 200);
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
          continue; // a bare heartbeat comment line — keep reading
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

    // A genuine, independent ticket mutation — the SAME kind a second
    // browser tab creating/changing a ticket would cause.
    const secondTicketRes = await ticketsPOST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Second realtime SSE proof ticket", description: "Should push a TICKETS_CHANGED message to the open stream.", departmentId: deptA.id, categoryId: categoryA.id }),
      })
    );
    const secondTicket = await secondTicketRes.json();
    if (secondTicket?.id) ticketIds.push(secondTicket.id);

    const pushedEvent = await readNextEvent(3_000);
    check("The open SSE stream received a REAL TICKETS_CHANGED message caused by an independent mutation", pushedEvent?.type === "TICKETS_CHANGED");
    check("...carrying NO ticket-specific data at all (no id/title/department — see item 9 of the brief)", pushedEvent && !("ticketId" in pushedEvent) && !("id" in pushedEvent) && !("title" in pushedEvent));

    abortController.abort();
    try {
      await reader.cancel();
    } catch {}
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await rawListener.end().catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
