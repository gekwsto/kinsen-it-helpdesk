/**
 * Regression coverage for two small, related additions on top of Project
 * Feedback:
 *
 *   1. A best-effort in-app notification to the ORIGINAL Project Request
 *      requester the moment their request-origin Project transitions to
 *      COMPLETED (lib/services/project-feedback-service.ts's
 *      notifyRequesterOfProjectCompletion, wired into PATCH
 *      /api/projects/[id]) — the discoverability prompt for the new
 *      Feedback card. Clicking it lands on /projects/[id].
 *   2. A "clear notifications" feature: DELETE /api/notifications/[id]
 *      (dismiss one) and DELETE /api/notifications/clear-all (dismiss
 *      every notification for the authenticated user), plus their pure
 *      client-side state reducers (applyDeleted/applyClearAll).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-completion-notification-and-clear.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { applyDeleted, applyClearAll, type NotificationState, type NotificationItem } from "@/lib/notifications/notification-state";

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

function item(id: string, isRead = false): NotificationItem {
  return { id, title: `Title ${id}`, body: `Body ${id}`, link: null, isRead, createdAt: new Date().toISOString() };
}

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const RUN_ID = Date.now();
const TAG = `pcnc-${RUN_ID}`;

async function main() {
  // ══════════════════════ SECTION A — pure reducers (no DB) ══════════════════════
  console.log("\n=== SECTION A — applyDeleted / applyClearAll pure reducers ===\n");
  const stateWithThree: NotificationState = { items: [item("a", false), item("b", true), item("c", false)], unreadCount: 2 };

  const afterDeleteUnread = applyDeleted(stateWithThree, "a");
  check("1. Deleting an UNREAD item removes it AND decrements unreadCount", afterDeleteUnread.items.length === 2 && !afterDeleteUnread.items.some((n) => n.id === "a") && afterDeleteUnread.unreadCount === 1);

  const afterDeleteRead = applyDeleted(stateWithThree, "b");
  check("2. Deleting an already-READ item removes it WITHOUT touching unreadCount", afterDeleteRead.items.length === 2 && !afterDeleteRead.items.some((n) => n.id === "b") && afterDeleteRead.unreadCount === 2);

  const afterDeleteUnknown = applyDeleted(stateWithThree, "does-not-exist");
  check("3. Deleting an unknown id is a no-op — same items, same count, never throws", afterDeleteUnknown === stateWithThree);

  const afterClear = applyClearAll(stateWithThree);
  check("4. applyClearAll empties the list and zeroes unreadCount regardless of prior state", afterClear.items.length === 0 && afterClear.unreadCount === 0);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping the real-DB portion.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const notificationDELETE = (await import("@/app/api/notifications/[id]/route")).DELETE;
  const clearAllDELETE = (await import("@/app/api/notifications/clear-all/route")).DELETE;

  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const userIds: string[] = [];
  const notificationIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    async function makeUser(email: string) {
      const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(u.id);
      return u;
    }
    async function addMembership(userId: string, departmentId: string) {
      await prisma.departmentMembership.create({
        data: { userId, departmentId, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    }

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const requester = await makeUser(`${TAG}-requester@kinsen.gr`);
    await addMembership(requester.id, dept.id);

    async function makeRequestOriginProject(tag: string): Promise<string> {
      currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
      const submitRes = await requestsPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "Completion-notification fixture — description long enough for validation.",
          importance: 2,
          projectTypeId: reqType.id,
          teamConcerned: "Engineering",
          expectedBenefits: "Benefits text long enough for validation.",
          replacesExisting: false,
          intermediateApproverIds: [adminUser.id],
        })
      );
      const submitted = await submitRes.json();
      requestIds.push(submitted.id);
      currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
      await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
      await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
      const setupRes = await setupPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "fixture",
          ownerIds: [adminUser.id],
          expectedStartDate: "2026-01-01",
          expectedFinishDate: "2026-01-05",
          expenseTypeId: expenseType.id,
        }),
        { params: Promise.resolve({ id: submitted.id }) }
      );
      if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
      const project = await setupRes.json();
      projectIds.push(project.id);
      return project.id;
    }

    // ══════════════════════ SECTION B — completion notification ══════════════════════
    console.log("\n=== SECTION B — notifying the original requester when their Project is COMPLETED ===\n");
    const proj1 = await makeRequestOriginProject("proj1");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };

    const beforeCount = await prisma.notification.count({ where: { userId: requester.id, link: `/projects/${proj1}` } });
    check("5. No completion notification exists before the Project is completed", beforeCount === 0);

    const completeRes = await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: proj1 }) });
    check("(fixture) PATCH status=COMPLETED -> 200", completeRes.status === 200);

    const notif1 = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/projects/${proj1}` } });
    check("6. Completing a request-origin Project creates exactly ONE notification for the ORIGINAL requester", notif1 !== null);
    if (notif1) notificationIds.push(notif1.id);
    check("7. Its title is 'Project completed'", notif1?.title === "Project completed");
    check("8. Its body names the real Project title and mentions feedback", (notif1?.body ?? "").includes(`${TAG} proj1 request`) && /feedback/i.test(notif1?.body ?? ""));
    check("9. Its link points straight at the Project detail page (where the Feedback card now lives)", notif1?.link === `/projects/${proj1}`);
    check("...exactly one such notification, never duplicated by this single completion", (await prisma.notification.count({ where: { userId: requester.id, link: `/projects/${proj1}` } })) === 1);

    // 10: an unrelated edit on the ALREADY-completed Project must not fire a second one.
    await projectsPATCH(jsonReq({ title: "Renamed after completion" }, "PATCH"), { params: Promise.resolve({ id: proj1 }) });
    check("10. An unrelated edit on an ALREADY-completed Project does NOT create a second notification", (await prisma.notification.count({ where: { userId: requester.id, link: `/projects/${proj1}` } })) === 1);

    // 11: reopen -> re-complete is a GENUINE new transition -> a second, real notification.
    await projectsPATCH(jsonReq({ status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: proj1 }) });
    await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: proj1 }) });
    check("11. Reopening then re-completing (a genuine new transition) fires a SECOND real notification", (await prisma.notification.count({ where: { userId: requester.id, link: `/projects/${proj1}` } })) === 2);
    const allNotifsForProj1 = await prisma.notification.findMany({ where: { userId: requester.id, link: `/projects/${proj1}` } });
    for (const n of allNotifsForProj1) notificationIds.push(n.id);

    // 12: a manual Project's completion never notifies anyone this way.
    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: adminUser.id } });
    projectIds.push(manualProject.id);
    const manualBeforeCount = await prisma.notification.count();
    await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: manualProject.id }) });
    check("12. Completing a MANUAL Project (no projectRequestId) creates no new notification at all", (await prisma.notification.count()) === manualBeforeCount);

    // ══════════════════════ SECTION C — DELETE /api/notifications/[id] ══════════════════════
    console.log("\n=== SECTION C — dismissing a single notification ===\n");
    const extraNotif = await prisma.notification.create({ data: { userId: requester.id, title: "Extra", body: "Extra body", link: null } });
    notificationIds.push(extraNotif.id);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const deleteOwnRes = await notificationDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: extraNotif.id }) });
    check("13. The owning user can DELETE their own notification -> 200", deleteOwnRes.status === 200);
    check("...it's genuinely gone from the DB", (await prisma.notification.findUnique({ where: { id: extraNotif.id } })) === null);

    const stillThereNotif = await prisma.notification.findFirst({ where: { userId: requester.id } });
    check("14. Deleting one notification leaves the requester's OTHER notifications untouched", stillThereNotif !== null);

    // 15: cross-user ownership check — a different user can't delete someone else's notification.
    const otherUser = await makeUser(`${TAG}-other@kinsen.gr`);
    currentSession = { user: { id: otherUser.id, role: Role.USER, customRoleId: null } };
    const crossUserDeleteRes = await notificationDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: notif1!.id }) });
    check("15. A DIFFERENT user attempting to delete someone else's notification -> 404 (never leaks existence via 403)", crossUserDeleteRes.status === 404);
    check("...and it was NOT deleted", (await prisma.notification.findUnique({ where: { id: notif1!.id } })) !== null);

    // ══════════════════════ SECTION D — DELETE /api/notifications/clear-all ══════════════════════
    console.log("\n=== SECTION D — clearing every notification for the authenticated user ===\n");
    const requesterCountBefore = await prisma.notification.count({ where: { userId: requester.id } });
    check("(fixture) requester has at least 2 notifications before clearing", requesterCountBefore >= 2);

    const otherUserNotif = await prisma.notification.create({ data: { userId: otherUser.id, title: "Other user's", body: "Should survive", link: null } });
    notificationIds.push(otherUserNotif.id);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const clearAllRes = await clearAllDELETE();
    check("16. Clear-all -> 200", clearAllRes.status === 200);
    check("17. Every notification belonging to the requester is now gone", (await prisma.notification.count({ where: { userId: requester.id } })) === 0);
    check("18. A DIFFERENT user's notification is completely unaffected by someone else's clear-all", (await prisma.notification.findUnique({ where: { id: otherUserNotif.id } })) !== null);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): notifications", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): projects", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): project requests", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): users", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): departments", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
