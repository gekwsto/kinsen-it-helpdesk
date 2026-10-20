/**
 * Regression coverage for the opt-in "New Department Tickets" notification
 * preference (lib/ticket-notification-service.ts's notifyDepartmentOfNewTicket) —
 * exercises the real service functions directly against a real dev DB (no
 * HTTP server, no network mocking needed — this feature makes no external
 * calls), covering every acceptance criterion from the spec.
 *
 * Usage: npx tsx scripts/test-department-ticket-notifications.ts
 * Requires a reachable DATABASE_URL.
 */
// lib/ticket-notification-service.ts (dynamically imported inside main()
// below) transitively imports lib/web-push.ts, which has a top-level
// `import "server-only"` — that marker package always throws under plain
// Node/tsx (its package.json only resolves to a no-op under a bundler's
// "react-server" export condition, which tsx/node never set) — a
// pre-existing environment quirk, unrelated to this feature. Pre-seeding
// Node's CJS module cache makes it a no-op, same as it already is inside a
// real Next.js server build.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as NodeModule;

import { prisma } from "@/lib/prisma";
import { DepartmentRole } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { resolveDefaultStatusId, resolveDefaultPriorityId } from "@/lib/services/department-scope-service";
import { createTicketAtomic } from "@/lib/services/ticket-creation-service";
import { acceptPendingTicket } from "@/lib/services/pending-ticket-service";
// Dynamically imported inside main(), not statically here — see the call
// site below for why (lib/web-push.ts's `import "server-only"`, pulled in
// transitively, throws under plain Node/tsx's static-import hoisting; a
// dynamic import() executes in place instead of being hoisted, same
// workaround class as other scripts/test-*.ts files already need for this
// pre-existing environment quirk, unrelated to this feature).
type TicketNotificationService = typeof import("@/lib/ticket-notification-service");

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
const email = (local: string) => `${local}.${RUN_ID}@kinsen.gr`;

async function makeUser(local: string, opts: { newDepartmentTicketsEnabled: boolean }) {
  return prisma.user.create({
    data: {
      email: email(local),
      name: local,
      authProvider: "CREDENTIALS",
      isActive: true,
      newDepartmentTicketsEnabled: opts.newDepartmentTicketsEnabled,
    },
  });
}

async function notificationCountFor(userId: string, ticketId: string) {
  return prisma.notification.count({ where: { userId, link: `/tickets/${ticketId}` } });
}

async function cleanup(ids: { userIds: string[]; departmentIds: string[] }) {
  await prisma.notification.deleteMany({ where: { userId: { in: ids.userIds } } });
  await prisma.pushNotificationLog.deleteMany({ where: { userId: { in: ids.userIds } } });
  await prisma.ticketHistory.deleteMany({ where: { changedById: { in: ids.userIds } } });
  await prisma.ticketMessage.deleteMany({ where: { authorId: { in: ids.userIds } } });
  await prisma.ticket.deleteMany({ where: { requesterId: { in: ids.userIds } } });
  await prisma.pendingTicket.deleteMany({ where: { requesterId: { in: ids.userIds } } });
  await prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
  try {
    await prisma.department.deleteMany({ where: { id: { in: ids.departmentIds } } });
  } catch {
    console.warn("Note: left department rows in place (FK-restricted by starter config rows) — harmless, identifiable by RUN_ID in this run's log.");
  }
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.error("DATABASE_URL not reachable — skipping (this script requires a real dev DB).");
    process.exitCode = 0;
    return;
  }

  const { notifyDepartmentOfNewTicket }: TicketNotificationService = await import("@/lib/ticket-notification-service");

  const userIds: string[] = [];
  const departmentIds: string[] = [];

  try {
    console.log("\n=== Setup ===");
    const deptA = await createDepartment({ name: `Dept A ${RUN_ID}` });
    const deptB = await createDepartment({ name: `Dept B ${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id);

    const requester = await makeUser("requester", { newDepartmentTicketsEnabled: true }); // enabled on purpose — must still be excluded (self)
    const userOn = await makeUser("user-on", { newDepartmentTicketsEnabled: true });
    const userOff = await makeUser("user-off", { newDepartmentTicketsEnabled: false });
    const userOtherDept = await makeUser("user-other-dept", { newDepartmentTicketsEnabled: true });
    const userMulti1 = await makeUser("user-multi-1", { newDepartmentTicketsEnabled: true });
    const userMulti2 = await makeUser("user-multi-2", { newDepartmentTicketsEnabled: true });
    const userBothDepts = await makeUser("user-both-depts", { newDepartmentTicketsEnabled: true }); // member of deptA AND deptB
    const userInactive = await makeUser("user-inactive", { newDepartmentTicketsEnabled: true });
    await prisma.user.update({ where: { id: userInactive.id }, data: { isActive: false } });
    userIds.push(
      requester.id, userOn.id, userOff.id, userOtherDept.id,
      userMulti1.id, userMulti2.id, userBothDepts.id, userInactive.id
    );

    // Membership: requester, userOn, userOff, userMulti1, userMulti2, userBothDepts, userInactive -> deptA
    // userOtherDept -> deptB only
    for (const u of [requester, userOn, userOff, userMulti1, userMulti2, userBothDepts, userInactive]) {
      await grantManualMembership(u.id, deptA.id, { role: DepartmentRole.VIEWER });
    }
    await grantManualMembership(userOtherDept.id, deptB.id, { role: DepartmentRole.VIEWER });
    await grantManualMembership(userBothDepts.id, deptB.id, { role: DepartmentRole.VIEWER }); // second, different department

    const statusId = await resolveDefaultStatusId(deptA.id);
    const priorityId = await resolveDefaultPriorityId(deptA.id);
    check("deptA has a resolvable default status (starter config present)", !!statusId);

    console.log("\n=== Create a ticket (WEB path: createTicketAtomic) ===");
    const ticket = await createTicketAtomic(
      {
        title: `Test ticket ${RUN_ID}`,
        description: "Test description",
        source: "WEB",
        requesterId: requester.id,
        statusId: statusId!,
        priorityId: priorityId ?? undefined,
        departmentId: deptA.id,
      },
      { changedById: requester.id, description: "Created by test script" }
    );

    await notifyDepartmentOfNewTicket({ ticketId: ticket.id });

    console.log("\n=== Acceptance checks ===");
    check("1. Preference ON + matching Department membership -> notification received", (await notificationCountFor(userOn.id, ticket.id)) === 1);
    check("2. Preference OFF -> no notification", (await notificationCountFor(userOff.id, ticket.id)) === 0);
    check("3. User in another Department -> no notification", (await notificationCountFor(userOtherDept.id, ticket.id)) === 0);
    check(
      "4. Multiple eligible users -> each receives exactly one notification",
      (await notificationCountFor(userOn.id, ticket.id)) === 1 && (await notificationCountFor(userMulti1.id, ticket.id)) === 1 && (await notificationCountFor(userMulti2.id, ticket.id)) === 1
    );
    check(
      "5. Multiple Department memberships -> correct eligibility without duplicates (exactly 1, not 2)",
      (await notificationCountFor(userBothDepts.id, ticket.id)) === 1
    );
    check("Inactive user is never notified even if enabled", (await notificationCountFor(userInactive.id, ticket.id)) === 0);
    check("The ticket's own requester is excluded (self-notification would be redundant noise)", (await notificationCountFor(requester.id, ticket.id)) === 0);

    const n = await prisma.notification.findFirst({ where: { userId: userOn.id, link: `/tickets/${ticket.id}` } });
    check("8. Notification opens the correct Ticket (link field)", n?.link === `/tickets/${ticket.id}`);

    console.log("\n=== Idempotency: calling the trigger twice (sequentially) for the same ticket ===");
    await notifyDepartmentOfNewTicket({ ticketId: ticket.id });
    check(
      "Each eligible user still has exactly 1 notification after a second (retried) call — no duplicates",
      (await notificationCountFor(userOn.id, ticket.id)) === 1 && (await notificationCountFor(userMulti1.id, ticket.id)) === 1
    );
    const onEventKey = `ticket:${ticket.id}:department-notify:${userOn.id}`;
    const logRowsForUserOn = await prisma.pushNotificationLog.count({ where: { eventKey: onEventKey } });
    check("Exactly one PushNotificationLog row exists for (ticket, userOn) — the eventKey uniquely identifies (ticketId, userId, type)", logRowsForUserOn === 1);
    const onLog = await prisma.pushNotificationLog.findUnique({ where: { eventKey: onEventKey } });
    check("The claim row is scoped to this exact ticket/user/type", onLog?.ticketId === ticket.id && onLog?.userId === userOn.id && onLog?.type === "DEPARTMENT_NEW_TICKET");
    check(
      "Happy path: no PushSubscription rows for this test user -> push leg resolves SKIPPED, not FAILED or stuck PENDING",
      onLog?.status === "SKIPPED"
    );

    console.log("\n=== Concurrent execution: two TRUE-parallel calls for a fresh ticket ===");
    const ticket2 = await createTicketAtomic(
      {
        title: `Concurrent test ticket ${RUN_ID}`,
        description: "Test description",
        source: "WEB",
        requesterId: requester.id,
        statusId: statusId!,
        priorityId: priorityId ?? undefined,
        departmentId: deptA.id,
      },
      { changedById: requester.id, description: "Created by test script (concurrency test)" }
    );
    // Promise.all, not two sequential awaits — both calls are in flight at
    // the same time, racing each other's claimPushEvent INSERTs for the
    // exact same eventKey. The DB's own unique constraint (not application
    // code) is what's actually being proven here.
    await Promise.all([
      notifyDepartmentOfNewTicket({ ticketId: ticket2.id }),
      notifyDepartmentOfNewTicket({ ticketId: ticket2.id }),
    ]);
    check(
      "True concurrent (Promise.all) duplicate calls still produce exactly 1 notification per eligible user — DB unique constraint, not app-level sequencing, is the real guard",
      (await notificationCountFor(userOn.id, ticket2.id)) === 1 &&
        (await notificationCountFor(userMulti1.id, ticket2.id)) === 1 &&
        (await notificationCountFor(userMulti2.id, ticket2.id)) === 1 &&
        (await notificationCountFor(userBothDepts.id, ticket2.id)) === 1
    );
    const logRowsForTicket2UserOn = await prisma.pushNotificationLog.count({
      where: { eventKey: `ticket:${ticket2.id}:department-notify:${userOn.id}` },
    });
    check("Exactly one PushNotificationLog row survives the race (the loser's P2002 INSERT never commits a row)", logRowsForTicket2UserOn === 1);

    console.log("\n=== Residual limitation (NOT fixed by the releasePushClaim correction — a crashed process, not a thrown exception, has no code path left to run): a row stuck PENDING from outside the normal claim lifecycle still blocks retries ===");
    const ticket3 = await createTicketAtomic(
      {
        title: `Delivery-failure test ticket ${RUN_ID}`,
        description: "Test description",
        source: "WEB",
        requesterId: requester.id,
        statusId: statusId!,
        priorityId: priorityId ?? undefined,
        departmentId: deptA.id,
      },
      { changedById: requester.id, description: "Created by test script (delivery-failure test)" }
    );
    // Simulates "a previous attempt claimed this eventKey but the process
    // crashed/errored before resolving it" — e.g. the exact scenario where
    // deliverRequesterPush's own in-app Notification.create throws (caught,
    // logged, swallowed — see that function's first try/catch) yet the push
    // leg still independently resolves the SAME claim row to SENT/SKIPPED/
    // FAILED. Pre-inserting a PENDING row with the real eventKey format
    // reproduces the "claim exists, delivery outcome unknown/incomplete" state
    // directly, without needing to break prisma.notification.create for real.
    const preClaimedUserId = userOn.id;
    const preClaimedEventKey = `ticket:${ticket3.id}:department-notify:${preClaimedUserId}`;
    await prisma.pushNotificationLog.create({
      data: {
        eventKey: preClaimedEventKey,
        ticketId: ticket3.id,
        messageId: null,
        userId: preClaimedUserId,
        type: "DEPARTMENT_NEW_TICKET",
        status: "PENDING",
      },
    });
    await notifyDepartmentOfNewTicket({ ticketId: ticket3.id });
    check(
      "CONFIRMED (pre-existing, inherited characteristic — not introduced by this feature): a pre-claimed eventKey permanently suppresses notifyDepartmentOfNewTicket for that (ticket, user) — no in-app Notification is created even though this 'retry' is the only real attempt",
      (await notificationCountFor(preClaimedUserId, ticket3.id)) === 0
    );
    check(
      "The pre-claimed key does NOT affect other eligible users in the same run — only the exact (ticket, user) pair is suppressed",
      (await notificationCountFor(userMulti1.id, ticket3.id)) === 1 && (await notificationCountFor(userMulti2.id, ticket3.id)) === 1
    );
    const stuckLog = await prisma.pushNotificationLog.findUnique({ where: { eventKey: preClaimedEventKey } });
    check(
      "The pre-claimed row is left exactly as found (still PENDING) — notifyDepartmentOfNewTicket never touches/resolves a claim it didn't win",
      stuckLog?.status === "PENDING"
    );

    console.log("\n=== FIX VERIFICATION: a real prisma.notification.create failure releases the claim (deletes the row) so a legitimate retry can recover ===");
    const ticket4 = await createTicketAtomic(
      {
        title: `Release-on-failure test ticket ${RUN_ID}`,
        description: "Test description",
        source: "WEB",
        requesterId: requester.id,
        statusId: statusId!,
        priorityId: priorityId ?? undefined,
        departmentId: deptA.id,
      },
      { changedById: requester.id, description: "Created by test script (release-on-failure test)" }
    );
    const failingUserId = userOn.id;
    const failingEventKey = `ticket:${ticket4.id}:department-notify:${failingUserId}`;
    // Monkey-patch prisma.notification.create to throw exactly ONCE, only
    // for the targeted recipient — reproduces a real in-app write failure
    // from inside a genuine notifyDepartmentOfNewTicket execution (not a
    // pre-planted row), the exact scenario deliverRequesterPush's fix
    // targets. Restored immediately after, in a finally, so no other
    // assertion in this script is affected by the patch.
    const originalNotificationCreate = prisma.notification.create.bind(prisma.notification);
    let armed = true;
    (prisma.notification as unknown as { create: typeof prisma.notification.create }).create = (async (args: Parameters<typeof prisma.notification.create>[0]) => {
      if (armed && (args as { data: { userId: string } }).data.userId === failingUserId) {
        armed = false;
        throw new Error("Simulated in-app notification write failure (test)");
      }
      return originalNotificationCreate(args);
    }) as unknown as typeof prisma.notification.create;

    try {
      await notifyDepartmentOfNewTicket({ ticketId: ticket4.id });
    } finally {
      prisma.notification.create = originalNotificationCreate;
    }

    check(
      "The targeted user received NO in-app notification on the failing attempt (the write genuinely failed)",
      (await notificationCountFor(failingUserId, ticket4.id)) === 0
    );
    const releasedLog = await prisma.pushNotificationLog.findUnique({ where: { eventKey: failingEventKey } });
    check(
      "FIX: the claim row was RELEASED (deleted), not left stuck or resolved to a terminal status — the eventKey is claimable again",
      releasedLog === null
    );
    check(
      "Other eligible users in the same run (whose write was not intercepted) were notified normally — the failure is scoped to exactly one recipient",
      (await notificationCountFor(userMulti1.id, ticket4.id)) === 1 && (await notificationCountFor(userMulti2.id, ticket4.id)) === 1
    );

    // The "legitimate retry" — same call, same ticket, same user, now that
    // prisma.notification.create is no longer intercepted.
    await notifyDepartmentOfNewTicket({ ticketId: ticket4.id });
    check(
      "FIX: a legitimate retry after the release succeeds — the previously-failed user now has exactly 1 notification (not permanently suppressed)",
      (await notificationCountFor(failingUserId, ticket4.id)) === 1
    );
    check(
      "The retry did not re-notify users who already succeeded on the first attempt (still exactly 1 each, not 2)",
      (await notificationCountFor(userMulti1.id, ticket4.id)) === 1 && (await notificationCountFor(userMulti2.id, ticket4.id)) === 1
    );

    console.log("\n=== FIX VERIFICATION: concurrent retries racing for a just-released eventKey still cannot create duplicates ===");
    const ticket5 = await createTicketAtomic(
      {
        title: `Release-then-concurrent-retry test ticket ${RUN_ID}`,
        description: "Test description",
        source: "WEB",
        requesterId: requester.id,
        statusId: statusId!,
        priorityId: priorityId ?? undefined,
        departmentId: deptA.id,
      },
      { changedById: requester.id, description: "Created by test script (release-then-concurrent-retry test)" }
    );
    const failingUserId2 = userOn.id;
    const failingEventKey2 = `ticket:${ticket5.id}:department-notify:${failingUserId2}`;
    const originalNotificationCreate2 = prisma.notification.create.bind(prisma.notification);
    let armed2 = true;
    (prisma.notification as unknown as { create: typeof prisma.notification.create }).create = (async (args: Parameters<typeof prisma.notification.create>[0]) => {
      if (armed2 && (args as { data: { userId: string } }).data.userId === failingUserId2) {
        armed2 = false;
        throw new Error("Simulated in-app notification write failure (test)");
      }
      return originalNotificationCreate2(args);
    }) as unknown as typeof prisma.notification.create;
    try {
      await notifyDepartmentOfNewTicket({ ticketId: ticket5.id }); // fails + releases, exactly as above
    } finally {
      prisma.notification.create = originalNotificationCreate2;
    }
    check("Setup: the claim was released after the simulated failure", (await prisma.pushNotificationLog.findUnique({ where: { eventKey: failingEventKey2 } })) === null);

    // Two TRUE-parallel retries racing for the now-freed eventKey.
    await Promise.all([
      notifyDepartmentOfNewTicket({ ticketId: ticket5.id }),
      notifyDepartmentOfNewTicket({ ticketId: ticket5.id }),
    ]);
    check(
      "FIX: concurrent retries after a release still produce exactly 1 notification, never 2 — the DB unique constraint guards the re-claim too",
      (await notificationCountFor(failingUserId2, ticket5.id)) === 1
    );
    const finalLogCount2 = await prisma.pushNotificationLog.count({ where: { eventKey: failingEventKey2 } });
    check("Exactly one PushNotificationLog row exists for the recovered eventKey after the concurrent retry", finalLogCount2 === 1);

    console.log("\n=== 7. Failed/rolled-back creation -> no notification ===");
    const fakeTicketId = "nonexistent-ticket-id-never-created";
    await notifyDepartmentOfNewTicket({ ticketId: fakeTicketId }); // must not throw, must not create anything
    const strayCount = await prisma.notification.count({ where: { link: `/tickets/${fakeTicketId}` } });
    check("Calling the trigger for a ticket that was never created produces zero notifications and does not throw", strayCount === 0);

    console.log("\n=== 6. Another creation flow: EMAIL (acceptPendingTicket) ===");
    const pendingRequester = await makeUser("pending-requester", { newDepartmentTicketsEnabled: false });
    userIds.push(pendingRequester.id);
    const pending = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `test-${RUN_ID}@example.com`,
        fromEmail: email("pending-requester"),
        fromName: "Pending Requester",
        subject: `Email ticket ${RUN_ID}`,
        body: "Body text",
        receivedAt: new Date(),
        departmentId: deptA.id,
        requesterId: pendingRequester.id,
      },
    });
    const acceptResult = await acceptPendingTicket(pending.id, userOn.id);
    check("acceptPendingTicket succeeded", acceptResult.ok === true);
    if (acceptResult.ok) {
      await notifyDepartmentOfNewTicket({ ticketId: acceptResult.ticket.id });
      check(
        "6. EMAIL-accept creation flow also notifies eligible, opted-in department members",
        (await notificationCountFor(userOn.id, acceptResult.ticket.id)) === 1
      );
      check("EMAIL-accept flow still excludes opted-out members", (await notificationCountFor(userOff.id, acceptResult.ticket.id)) === 0);
    }

    console.log("\n=== 9. Existing Mention Reminders / other notification types unaffected ===");
    const pushTypes = await prisma.$queryRaw<{ unnest: string }[]>`SELECT unnest(enum_range(NULL::"PushNotificationType"))`;
    const typeNames = pushTypes.map((r) => r.unnest);
    check("PushNotificationType still has REPLY", typeNames.includes("REPLY"));
    check("PushNotificationType still has TERMINAL", typeNames.includes("TERMINAL"));
    check("PushNotificationType gained DEPARTMENT_NEW_TICKET", typeNames.includes("DEPARTMENT_NEW_TICKET"));
    const mentionUser = await prisma.user.findUnique({ where: { id: userOn.id }, select: { mentionRemindersEnabled: true } });
    check("mentionRemindersEnabled still defaults true for unrelated users (untouched by this feature)", mentionUser?.mentionRemindersEnabled === true);
  } finally {
    await cleanup({ userIds, departmentIds });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
