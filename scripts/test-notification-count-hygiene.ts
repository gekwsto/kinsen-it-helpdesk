/**
 * Regression coverage for the "unread notification count grows
 * unboundedly" investigation. The fail-before audit found:
 *
 *   A. Test-data pollution: CONFIRMED, the primary cause — 64 of 66
 *      "New Project Request awaiting your approval" notifications for the
 *      real admin@kinsen.gr pointed at a ProjectRequest that no longer
 *      existed (the test that created it deleted the request in its own
 *      cleanup, but never the Notification — which has no FK/cascade to
 *      ProjectRequest). admin@kinsen.gr always receives these because
 *      ADMIN holds `projectRequest.approve` globally, so EVERY test run's
 *      submissions notify the real account, regardless of which ephemeral
 *      department the test created.
 *   B. Duplicate Notification DB rows: RULED OUT — exactly 66 distinct
 *      ProjectRequest links for 66 rows, zero duplicates per link.
 *   C/D. Duplicate realtime subscription / client double-increment: RULED
 *      OUT structurally — <NotificationDropdown> is rendered exactly once
 *      (components/layout/topbar.tsx), owns ONE shared `unreadCount` for
 *      both the bell badge and the dropdown header, and
 *      lib/notifications/notification-state.ts's applyNotificationCreated
 *      already dedupes by id (see scripts/test-notification-realtime-bell.ts
 *      for the core reducer suite — not re-tested here).
 *   E. Duplicate push dispatch: not implicated — dispatchCreatedNotification
 *      is called exactly once per Notification row.
 *
 * One genuine, previously-undiscovered SERVER bug was found and fixed
 * during this audit: GET /api/notifications computed `unreadCount` by
 * filtering its own `take: 50` display list, instead of a true table-wide
 * COUNT. Once a user has more than 50 notifications, an unread row sitting
 * outside that 50-row window would silently NOT be counted — the
 * authoritative reconciliation endpoint itself could under-report. Fixed
 * to use a separate `prisma.notification.count(...)`, decoupled from the
 * display list's pagination. SECTION C below proves this with a user who
 * genuinely has 55+ rows and an unread one outside the top-50 window.
 *
 * This file does NOT re-prove the pure reducer's dedup/mark-read/
 * mark-all-read/reconcile logic — scripts/test-notification-realtime-bell.ts
 * already covers that exhaustively. This file adds exactly the gaps that
 * investigation surfaced: the two extra pure-function combinations
 * (replay-after-mark-all-read, new-notification-after-mark-all-read), the
 * structural single-subscription/shared-count guarantees, the
 * take-50-window count bug fix, the mark-all-read API route itself, and —
 * most importantly — that test cleanup genuinely leaves the real
 * admin@kinsen.gr account's notification count UNCHANGED, even when the
 * test itself fails partway through.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-notification-count-hygiene.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import {
  applyMarkAllRead,
  applyNotificationCreated,
  type NotificationItem,
  type NotificationState,
} from "@/lib/notifications/notification-state";

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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (this IS the exact robustness gap the investigation found and fixed across the Project Request test suite). */
async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

function item(id: string, isRead = false): NotificationItem {
  return { id, title: `Title ${id}`, body: `Body ${id}`, link: null, isRead, createdAt: new Date().toISOString() };
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — structural: single subscription, shared count ══════════════════════
  console.log("\n=== SECTION A — exactly one subscription, one shared count (no independent navbar/dropdown increment) ===\n");
  const topbarSrc = await fs.readFile("components/layout/topbar.tsx", "utf8");
  const dropdownSrc = await fs.readFile("components/notifications/notification-dropdown.tsx", "utf8");
  const hookSrc = await fs.readFile("hooks/use-notification-realtime.ts", "utf8");

  check("1. <NotificationDropdown> is rendered exactly ONCE in the app shell (topbar) — never a separate navbar-bell + dropdown pair", (topbarSrc.match(/<NotificationDropdown/g) ?? []).length === 1);
  check("2. NotificationDropdown calls useNotificationRealtime exactly ONCE — a single logical subscription per mounted instance", (dropdownSrc.match(/useNotificationRealtime\(/g) ?? []).length === 1);
  check("3. The bell trigger's badge and the dropdown header's badge both read from the SAME destructured `unreadCount` — never two independently-computed counts", /const \{ items, unreadCount \} = state;/.test(dropdownSrc) && (dropdownSrc.match(/\{unreadCount > 0/g) ?? []).length >= 2);

  check("4. The realtime hook's effect properly tears down on unmount/re-run: sets a `destroyed` flag, closes the EventSource, and clears any pending reconnect timeout", /destroyed = true;\s*\n\s*es\?\.close\(\);\s*\n\s*if \(retryTimeout\) clearTimeout\(retryTimeout\);/.test(hookSrc));
  check("5. connect() is a no-op once destroyed — a reconnect timer firing AFTER unmount can never open a second, orphaned connection", /const connect = \(\) => \{\s*\n\s*if \(destroyed\) return;/.test(hookSrc));
  check("6. Exactly ONE useEffect drives the EventSource lifecycle (no second effect that could open a parallel connection)", (hookSrc.match(/useEffect\(\(\) => \{/g) ?? []).length === 1);

  // ══════════════════════ SECTION B — pure reducer: the two combinations the original bell suite doesn't cover ══════════════════════
  console.log("\n=== SECTION B — replay/new-arrival semantics AROUND mark-all-read (not covered by test-notification-realtime-bell.ts) ===\n");
  const before: NotificationState = { items: [item("x1"), item("x2", true)], unreadCount: 1 };
  const afterAllRead = applyMarkAllRead(before);
  check("Precondition: mark-all-read zeroes the count", afterAllRead.unreadCount === 0 && afterAllRead.items.every((n) => n.isRead));

  // 9. An old/replayed realtime event for an id that was already read (via
  // mark-all-read) must not resurrect it as unread.
  const replayedOld = applyNotificationCreated(afterAllRead, item("x1", false));
  check("9. Replaying the SAME notification id after mark-all-read (e.g. a late/duplicate realtime delivery) does NOT increment the count again", replayedOld.unreadCount === 0);
  check("   ...and does not flip the item back to unread either (dedup-by-id returns the existing, already-read entry untouched)", replayedOld.items.find((n) => n.id === "x1")?.isRead === true);

  // 10. A genuinely NEW notification arriving after mark-all-read must
  // still increment normally — mark-all-read must never freeze the
  // counter at zero for real future events.
  const genuinelyNew = applyNotificationCreated(afterAllRead, item("brand-new"));
  check("10. A genuinely NEW notification id after mark-all-read increments the count to 1", genuinelyNew.unreadCount === 1);
  check("   ...and appears in the items list", genuinelyNew.items.some((n) => n.id === "brand-new"));

  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping the real-DB portion.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { Role, AuthProvider, DepartmentRole, MembershipSource } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const notificationsGET = (await import("@/app/api/notifications/route")).GET;
  const markAllReadPOST = (await import("@/app/api/notifications/mark-all-read/route")).POST;

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const notificationIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function makeUser(email: string, customRoleId: string | null = null) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }

  try {
    // ══════════════════════ SECTION C — real DB: the take-50-window undercount bug, now fixed ══════════════════════
    console.log("\n=== SECTION C — GET /api/notifications: unreadCount is a TRUE count, not filtered from the take-50 display window ===\n");
    const windowUser = await makeUser(`notif-hygiene-window-${RUN_ID}@kinsen.gr`);
    // 55 OLD, already-read rows (older createdAt), then 5 NEW, unread rows.
    // orderBy createdAt desc + take 50 means the 50 most recent are: the 5
    // new unread ones + 45 of the 55 old read ones — the OLDEST 10 read
    // rows fall OUTSIDE the window. If unreadCount were (incorrectly)
    // derived from that window, it would still read 5 by coincidence here
    // — so this fixture instead puts 5 UNREAD rows among the OLDEST 55,
    // outside the window entirely, which a window-filtered count would
    // completely miss.
    const base = new Date("2020-01-01T00:00:00.000Z").getTime();
    const oldRows = Array.from({ length: 55 }, (_, i) => ({
      userId: windowUser.id,
      title: `Old ${i}`,
      body: "old",
      isRead: i >= 5, // the OLDEST 5 of these 55 are unread; the rest are read
      createdAt: new Date(base + i * 1000),
    }));
    await prisma.notification.createMany({ data: oldRows });
    const recentRows = Array.from({ length: 10 }, (_, i) => ({
      userId: windowUser.id,
      title: `Recent ${i}`,
      body: "recent",
      isRead: true,
      createdAt: new Date(base + 60_000 + i * 1000),
    }));
    await prisma.notification.createMany({ data: recentRows });

    const totalForWindowUser = await prisma.notification.count({ where: { userId: windowUser.id } });
    check("Fixture: this user genuinely has MORE than 50 notifications", totalForWindowUser > 50);
    const trueUnread = await prisma.notification.count({ where: { userId: windowUser.id, isRead: false } });
    check("Fixture: exactly 5 are genuinely unread, and they sit OUTSIDE the most-recent-50 window", trueUnread === 5);

    currentSession = { user: { id: windowUser.id, role: Role.USER, customRoleId: null } };
    const getRes = await notificationsGET();
    const getBody = await getRes.json();
    check(
      "GET /api/notifications reports the FULL, true unreadCount (5) — not 0, which the old take-50-filtered computation would have returned here",
      getBody.unreadCount === 5
    );
    check("...the display list itself is still capped at 50 (unchanged, separate concern)", getBody.notifications.length === 50);

    // ══════════════════════ All read: DB + authoritative GET both go to zero ══════════════════════
    console.log("\n=== 8. POST /api/notifications/mark-all-read sets every unread row read; GET afterward reports 0 ===\n");
    const markAllRes = await markAllReadPOST();
    check("mark-all-read -> 200/ok", markAllRes.status === 200);
    const stillUnread = await prisma.notification.count({ where: { userId: windowUser.id, isRead: false } });
    check("...zero unread rows remain in the DB for this user, including the ones outside the display window", stillUnread === 0);
    const getAfter = await notificationsGET();
    const getAfterBody = await getAfter.json();
    check("...GET /api/notifications now reports unreadCount: 0", getAfterBody.unreadCount === 0);

    // ══════════════════════ 1/4. One business event -> one notification per recipient; a failed mutation -> zero ══════════════════════
    console.log("\n=== 1/4. One real business event -> exactly one notification per recipient; a REJECTED mutation creates none ===\n");
    const dept = await createDepartment({ name: `Notif Hygiene Dept ${RUN_ID}`, slug: `notif-hygiene-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const type = await prisma.taskType.create({ data: { name: `Notif Hygiene Type ${RUN_ID}` } });
    typeIds.push(type.id);
    const requester = await makeUser(`notif-hygiene-requester-${RUN_ID}@kinsen.gr`);
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const intermediateApproverRole = await prisma.customRole.create({ data: { key: `NOTIF_HYGIENE_INTERMEDIATE_${RUN_ID}`, name: `Notif Hygiene Intermediate ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL" as any, isActive: true } });
    customRoleIds.push(intermediateApproverRole.id);
    customRoleKeys.push(intermediateApproverRole.key);
    const intermediateApprovePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.intermediateApprove" } });
    await prisma.rolePermission.create({ data: { roleKey: intermediateApproverRole.key, permissionId: intermediateApprovePerm.id } });
    // The global-permission reverse lookup used at submission time reads the
    // User's own top-level customRoleId DB column, never a
    // DepartmentMembership's — must be set directly here.
    const intermediateApprover = await makeUser(`notif-hygiene-intermediate-${RUN_ID}@kinsen.gr`, intermediateApproverRole.id);

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (method: string, body?: unknown) =>
      new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq("POST", {
        title: `Notif Hygiene Request ${RUN_ID}`,
        description: "A description that is definitely long enough.",
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Ops",
        expectedBenefits: "Benefits text that is definitely long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [intermediateApprover.id],
      })
    );
    check("Real submission -> 201", submitRes.status === 201);
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);

    const realAdmin = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" } });

    // Submission notifies the INTERMEDIATE approver first — the final,
    // global approver (the real admin account) isn't notified until the
    // intermediate stage completes.
    const intermediateNotifsForThisRequest = await prisma.notification.findMany({ where: { userId: intermediateApprover.id, link: `/project-requests/${submitted.id}` } });
    check("1. Exactly ONE notification was created for the selected intermediate approver for this ONE submission event — never more", intermediateNotifsForThisRequest.length === 1);
    notificationIds.push(...intermediateNotifsForThisRequest.map((n) => n.id));
    const adminNotifsAtSubmission = await prisma.notification.findMany({ where: { userId: realAdmin.id, link: `/project-requests/${submitted.id}` } });
    check("1. ...and the real admin account (final-stage global approver) is NOT yet notified — the final stage hasn't unlocked", adminNotifsAtSubmission.length === 0);

    currentSession = { user: { id: intermediateApprover.id, role: Role.USER, customRoleId: intermediateApproverRole.id } };
    const clearIntermediateRes = await intermediateApprovalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Cleared for fixture setup." }), { params: Promise.resolve({ id: submitted.id }) });
    check("The intermediate approver clears the stage -> 200", clearIntermediateRes.status === 200);
    const adminNotifsForThisRequest = await prisma.notification.findMany({ where: { userId: realAdmin.id, link: `/project-requests/${submitted.id}` } });
    check("1. Exactly ONE notification was created for the real admin account (global approver) once the intermediate stage completed — never more", adminNotifsForThisRequest.length === 1);
    notificationIds.push(...adminNotifsForThisRequest.map((n) => n.id));

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const noPermUser = await makeUser(`notif-hygiene-noperm-${RUN_ID}@kinsen.gr`);
    await prisma.departmentMembership.create({
      data: { userId: noPermUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: null } };
    const notifCountBeforeRejectedMutation = await prisma.notification.count();
    const rejectedMutationRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: realAdmin.id }), { params: Promise.resolve({ id: submitted.id }) });
    check("4. Unauthorized decision attempt -> 403 (rejected mutation)", rejectedMutationRes.status === 403);
    const notifCountAfterRejectedMutation = await prisma.notification.count();
    check("4. ...a rejected/failed mutation creates ZERO notifications anywhere", notifCountBeforeRejectedMutation === notifCountAfterRejectedMutation);

    // ══════════════════════ 11. The Project Request test suite's own cleanup leaves the REAL admin's count unchanged ══════════════════════
    console.log("\n=== 11. This run's fixture leaves admin@kinsen.gr's notification count EXACTLY where it started, once cleaned up ===\n");
    const adminCountBeforeThisCleanup = await prisma.notification.count({ where: { userId: realAdmin.id } });
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
    ]);
    const adminCountAfterThisCleanup = await prisma.notification.count({ where: { userId: realAdmin.id } });
    check("11. The real admin account's notification count dropped by exactly the number this fixture added to it (link-based cleanup caught the fan-out, not just the explicitly tracked rows)", adminCountAfterThisCleanup === adminCountBeforeThisCleanup - adminNotifsForThisRequest.length);

    // ══════════════════════ 12. Cleanup still runs (and still works) even when the test itself throws ══════════════════════
    console.log("\n=== 12. A thrown error mid-test does not prevent the finally-block cleanup from removing fixture notifications ===\n");
    const throwRequester = await makeUser(`notif-hygiene-throw-${RUN_ID}@kinsen.gr`);
    await prisma.departmentMembership.create({
      data: { userId: throwRequester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    currentSession = { user: { id: throwRequester.id, role: Role.USER, customRoleId: null } };
    const throwRequestIds: string[] = [];
    const adminCountBeforeThrowTest = await prisma.notification.count({ where: { userId: realAdmin.id } });
    let caughtTheDeliberateThrow = false;
    try {
      try {
        const throwSubmitRes = await requestsPOST(
          jsonReq("POST", {
            title: `Notif Hygiene Throw Fixture ${RUN_ID}`,
            description: "A description that is definitely long enough.",
            importance: 2,
            projectTypeId: type.id,
            teamConcerned: "Ops",
            expectedBenefits: "Benefits text that is definitely long enough for validation.",
            replacesExisting: false,
            intermediateApproverIds: [intermediateApprover.id],
          })
        );
        const throwSubmitted = await throwSubmitRes.json();
        throwRequestIds.push(throwSubmitted.id);
        // Simulates a crashed assertion / an unexpected exception partway
        // through a test — the SAME shape a real test-file crash takes.
        throw new Error("Deliberate simulated test failure, mid-fixture");
      } finally {
        await runCleanup([["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: throwRequestIds.map((id) => `/project-requests/${id}`) } } })], ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: throwRequestIds } } })]]);
      }
    } catch (err) {
      caughtTheDeliberateThrow = err instanceof Error && err.message === "Deliberate simulated test failure, mid-fixture";
    }
    check("12. The deliberate throw genuinely propagated (this is a real failure path, not a swallowed one)", caughtTheDeliberateThrow);
    const adminCountAfterThrowTest = await prisma.notification.count({ where: { userId: realAdmin.id } });
    check("12. ...yet the finally block's cleanup STILL ran and removed the fan-out notification — admin's count is back to its pre-test baseline despite the thrown error", adminCountAfterThrowTest === adminCountBeforeThrowTest);
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["notifications (explicitly tracked)", () => prisma.notification.deleteMany({ where: { id: { in: notificationIds } } })],
      ["notifications (window-bug fixture user)", () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.taskType.deleteMany({ where: { id: { in: typeIds } } })],
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["role permissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ]);
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
