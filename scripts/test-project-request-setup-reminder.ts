/**
 * Delayed Project Request setup reminder — scheduling on approve, cancellation
 * on setup completion, the worker's claim/fire/fan-out-to-every-eligible-
 * approver behavior, idempotency/concurrency safety, stale-claim recovery,
 * and the worker endpoint's auth. Real routes + real DB; time is an injected
 * `now` (no waits) — a 1-month delay can't be live-waited, so every delivery
 * check drives the service functions directly with a `now` already past
 * `dueAt`, same approach as scripts/test-mention-reminders.ts.
 *
 * Usage: npx tsx scripts/test-project-request-setup-reminder.ts
 * Requires a reachable DATABASE_URL.
 */
// lib/services/project-request-setup-reminder-service.ts transitively imports
// lib/notifications/create-notification.ts -> lib/web-push.ts, which has a
// top-level `import "server-only"` — that marker package always throws under
// plain Node/tsx (its package.json only resolves to a no-op under a
// bundler's "react-server" export condition, which tsx/node never set) — a
// pre-existing environment quirk, unrelated to this change. Pre-seeding
// Node's CJS module cache makes it a no-op, same as it already is inside a
// real Next.js server build — same workaround already used in
// scripts/test-project-request-setup-authorization.ts and others.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as NodeModule;

import { addMonths } from "date-fns";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { grantManualMembership, setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";
// Dynamically imported inside main(), not statically here — see the
// server-only workaround comment above for why.
type ProjectRequestService = typeof import("@/lib/services/project-request-service");
type SetupReminderService = typeof import("@/lib/services/project-request-setup-reminder-service");
type WorkerRoute = typeof import("@/app/api/internal/project-request-setup-reminders/process/route");

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
const email = (local: string) => `${local}.${RUN_ID}@kinsen.gr`;
const MIN = 60_000;

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { decideApproval, createProjectFromApprovedRequest }: ProjectRequestService = await import("@/lib/services/project-request-service");
  const svc: SetupReminderService = await import("@/lib/services/project-request-setup-reminder-service");
  const workerRoute: WorkerRoute = await import("@/app/api/internal/project-request-setup-reminders/process/route");
  const { NextRequest } = await import("next/server");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const customRoleIds: string[] = [];
  const requestIds: string[] = [];

  const jsonReq = (method: string, headers: Record<string, string> = {}) => new NextRequest("http://localhost/x", { method, headers });

  async function makeApproverCustomRole(label: string) {
    const permission = await prisma.permission.findUnique({ where: { key: "projectRequest.approve" } });
    if (!permission) throw new Error("projectRequest.approve permission not seeded — cannot run this test");
    const role = await prisma.customRole.create({ data: { key: `SR_${label}-${RUN_ID}`, name: `${label} ${RUN_ID}`, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(role.id);
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: permission.id } });
    return role;
  }
  async function makeUser(local: string) {
    const u = await prisma.user.create({ data: { email: email(local), name: local, authProvider: "CREDENTIALS", isActive: true, role: Role.USER } });
    userIds.push(u.id);
    return u;
  }
  async function freshRequest(departmentId: string, requesterId: string, status: "PENDING_APPROVAL" = "PENDING_APPROVAL") {
    const r = await prisma.projectRequest.create({
      data: {
        title: `SR test request ${RUN_ID}-${requestIds.length}`,
        description: "Test description",
        importance: 2,
        teamConcerned: "QA",
        expectedBenefits: "Testing",
        requesterId,
        departmentId,
        status,
      },
    });
    requestIds.push(r.id);
    return r;
  }
  const getReminder = (requestId: string) => prisma.projectRequestSetupReminder.findUnique({ where: { projectRequestId: requestId } });
  const reminderNotifs = (userId: string, requestId: string) => prisma.notification.findMany({ where: { userId, title: svc.setupReminderTitle(), link: svc.setupReminderLink(requestId) } });
  const afterDue = (r: { dueAt: Date }) => new Date(r.dueAt.getTime() + 1000);

  try {
    console.log("\n=== Setup ===");
    const dept = await createDepartment({ name: `SR Dept ${RUN_ID}` });
    departmentIds.push(dept.id);
    const deptB = await createDepartment({ name: `SR Dept B ${RUN_ID}` });
    departmentIds.push(deptB.id);

    const approverRole = await makeApproverCustomRole("approver-role");
    const requester = await makeUser("requester");
    const approver1 = await makeUser("approver1");
    const approver2 = await makeUser("approver2"); // second, independent eligible approver — same department authority
    const noPermissionUser = await makeUser("no-permission");

    await grantManualMembership(approver1.id, dept.id, { customRoleId: approverRole.id });
    await grantManualMembership(approver2.id, dept.id, { customRoleId: approverRole.id });
    await grantManualMembership(noPermissionUser.id, dept.id, { role: DepartmentRole.VIEWER });
    const deptDefault = await resolveDefaultDepartmentRoleAssignment();
    await setPrimaryDepartmentMembership(requester.id, dept.id, MembershipSource.MANUAL, { role: deptDefault.role, customRoleId: deptDefault.customRoleId });

    const projectInput = {
      title: "SR test Project",
      description: "Test",
      status: "PLANNING" as const,
      priority: 2,
      subDepartmentId: null,
      ownerIds: [requester.id],
      audienceIds: [],
      memberIds: [],
      expenseTypeId: (await prisma.projectExpenseType.findFirst({ select: { id: true } }))?.id ?? "",
      expectedStartDate: new Date().toISOString(),
      expectedFinishDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      isGoal: false,
      external: false,
    };
    check("Fixture: at least one ProjectExpenseType exists to use in setup", !!projectInput.expenseTypeId);

    // ── 1–3: scheduling ──
    console.log("\nScheduling ===\n");
    const r1 = await freshRequest(dept.id, requester.id);
    const d1 = await decideApproval(r1.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder1 = await getReminder(r1.id);
    const afterApproval1 = await prisma.projectRequest.findUniqueOrThrow({ where: { id: r1.id }, select: { approvedAt: true } });
    check("1. Approving schedules exactly one PENDING reminder", d1.ok === true && reminder1?.status === "PENDING");
    check(
      "1b. dueAt = approvedAt + exactly 1 month",
      !!reminder1 && !!afterApproval1.approvedAt && reminder1.dueAt.getTime() === addMonths(afterApproval1.approvedAt, 1).getTime()
    );

    const r2 = await freshRequest(dept.id, requester.id);
    await decideApproval(r2.id, approver1.id, Role.USER, null, "reject", "Not needed.");
    check("2. Rejecting schedules no reminder", (await getReminder(r2.id)) === null);

    let dupFailed = false;
    try {
      await prisma.$transaction((tx) => svc.scheduleSetupReminderInTx(tx, r1.id, new Date()));
    } catch {
      dupFailed = true;
    }
    check("3. projectRequestId is unique — scheduling a second reminder for the same request is rejected", dupFailed);

    // ── 4: cancellation on setup completion ──
    console.log("\nCancellation on setup ===\n");
    const setupResult = await createProjectFromApprovedRequest(r1.id, approver1.id, Role.USER, null, projectInput);
    const reminder1After = await getReminder(r1.id);
    check(
      "4. Completing setup cancels the reminder with reason project_created",
      setupResult.ok === true && reminder1After?.status === "CANCELLED" && reminder1After?.cancellationReason === "project_created"
    );
    await svc.processDueProjectRequestSetupReminders({ now: reminder1 ? afterDue(reminder1) : new Date() });
    check("4b. a cancelled reminder is never delivered even once its original dueAt passes", (await reminderNotifs(approver1.id, r1.id)).length === 0);

    // ── 5–7: delivery ──
    console.log("\nDelivery ===\n");
    const r3 = await freshRequest(dept.id, requester.id);
    await decideApproval(r3.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder3 = (await getReminder(r3.id))!;
    const before = await svc.processDueProjectRequestSetupReminders({ now: new Date(reminder3.dueAt.getTime() - 1000) });
    check(
      "5. reminder does not fire before dueAt",
      (await getReminder(r3.id))?.status === "PENDING" && (await reminderNotifs(approver1.id, r3.id)).length === 0,
      `sent=${before.sent}`
    );
    const run1 = await svc.processDueProjectRequestSetupReminders({ now: afterDue(reminder3) });
    const notifs1 = await reminderNotifs(approver1.id, r3.id);
    const notifs2 = await reminderNotifs(approver2.id, r3.id);
    const reminder3After = await getReminder(r3.id);
    check(
      "6. due unanswered approval notifies EVERY eligible approver and marks the reminder SENT",
      notifs1.length === 1 && notifs2.length === 1 && reminder3After?.status === "SENT" && !!reminder3After?.sentAt && run1.sent >= 1,
      `notifs1=${notifs1.length} notifs2=${notifs2.length} status=${reminder3After?.status}`
    );
    check(
      "6b. the no-permission department member is never notified",
      (await prisma.notification.count({ where: { userId: noPermissionUser.id, link: svc.setupReminderLink(r3.id) } })) === 0
    );
    check(
      "6c. notification title/body/link are well-formed and contain no business-sensitive text leak beyond the title",
      notifs1[0].title === "Project Request still needs Project setup" &&
        notifs1[0].body === `"${r3.title}" was approved over a month ago and still has no Project set up.` &&
        notifs1[0].link === `/project-requests/${r3.id}`
    );
    await svc.processDueProjectRequestSetupReminders({ now: new Date(afterDue(reminder3).getTime() + 5 * MIN) });
    check("7. rerunning the processor creates no duplicate", (await reminderNotifs(approver1.id, r3.id)).length === 1 && (await reminderNotifs(approver2.id, r3.id)).length === 1);

    // ── 8: no eligible recipients ──
    // deptB has no DEPARTMENT-scoped approve-permission holders at all, but
    // this real dev DB may still have pre-existing users holding
    // projectRequest.approve GLOBALLY (e.g. a seeded ADMIN) — those ARE
    // legitimately eligible for every department, including deptB. The
    // no_eligible_recipients path is only reachable when the computed
    // eligible set is genuinely empty, so this check adapts to whatever
    // that real set is rather than assuming deptB has none.
    console.log("\nNo eligible recipients ===\n");
    const { getEligibleApproverUserIds }: typeof import("@/lib/services/project-request-approver-eligibility-service") = await import(
      "@/lib/services/project-request-approver-eligibility-service"
    );
    const deptBEligible = await getEligibleApproverUserIds(deptB.id);
    const r4 = await freshRequest(deptB.id, requester.id);
    await prisma.projectRequest.update({ where: { id: r4.id }, data: { status: "APPROVED", approvedAt: new Date(), approverId: approver1.id } });
    await prisma.$transaction((tx) => svc.scheduleSetupReminderInTx(tx, r4.id, new Date()));
    const reminder4 = (await getReminder(r4.id))!;
    await svc.processDueProjectRequestSetupReminders({ now: afterDue(reminder4) });
    const reminder4After = await getReminder(r4.id);
    if (deptBEligible.length === 0) {
      check(
        "8. a department with no eligible approvers at all is cancelled (no_eligible_recipients), nothing is sent",
        reminder4After?.status === "CANCELLED" && reminder4After?.cancellationReason === "no_eligible_recipients"
      );
    } else {
      check(
        "8. (deptB has pre-existing globally-eligible approvers in this DB) delivery still reaches exactly that real set",
        reminder4After?.status === "SENT" &&
          (await Promise.all(deptBEligible.map((id) => reminderNotifs(id, r4.id)))).every((n) => n.length === 1)
      );
    }

    // ── 9: concurrency ──
    console.log("\nConcurrency ===\n");
    const r5 = await freshRequest(dept.id, requester.id);
    await decideApproval(r5.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder5 = (await getReminder(r5.id))!;
    const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => svc.processDueProjectRequestSetupReminders({ now: afterDue(reminder5) })));
    check(
      "9. three concurrent processors still notify each eligible approver exactly once",
      (await reminderNotifs(approver1.id, r5.id)).length === 1 && (await reminderNotifs(approver2.id, r5.id)).length === 1 && c1.sent + c2.sent + c3.sent >= 1
    );

    // ── 10–11: claim recovery ──
    console.log("\nClaim recovery ===\n");
    const r6 = await freshRequest(dept.id, requester.id);
    await decideApproval(r6.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder6 = (await getReminder(r6.id))!;
    const now6 = afterDue(reminder6);
    await prisma.projectRequestSetupReminder.update({ where: { id: reminder6.id }, data: { status: "PROCESSING", claimedAt: new Date(now6.getTime() - 1 * MIN), claimToken: "dead-worker" } });
    await svc.processDueProjectRequestSetupReminders({ now: now6 });
    check(
      "10. a FRESH PROCESSING claim (worker still alive) is not stolen",
      (await getReminder(r6.id))?.status === "PROCESSING" && (await reminderNotifs(approver1.id, r6.id)).length === 0
    );
    await prisma.projectRequestSetupReminder.update({ where: { id: reminder6.id }, data: { claimedAt: new Date(now6.getTime() - (svc.STALE_CLAIM_TIMEOUT_MS + MIN)) } });
    await svc.processDueProjectRequestSetupReminders({ now: now6 });
    check(
      "11. a STALE PROCESSING claim (crashed worker) is recovered and delivered exactly once",
      (await getReminder(r6.id))?.status === "SENT" && (await reminderNotifs(approver1.id, r6.id)).length === 1
    );
    await svc.processDueProjectRequestSetupReminders({ now: new Date(now6.getTime() + 60 * MIN) });
    check("11b. retry after recovery creates no duplicate", (await reminderNotifs(approver1.id, r6.id)).length === 1);

    // ── 12: lost claim (token mismatch) ──
    console.log("\nLost claim ===\n");
    const r7 = await freshRequest(dept.id, requester.id);
    await decideApproval(r7.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder7 = (await getReminder(r7.id))!;
    const outcome7 = await svc.processClaimedSetupReminder(reminder7.id, "wrong-token", afterDue(reminder7));
    check("12. a token mismatch returns lost_claim and leaves the reminder untouched", outcome7 === "lost_claim" && (await getReminder(r7.id))?.status === "PENDING");

    // ── 13: race between the eligibility check and the final SENT transaction ──
    // Simulates a Project appearing through a path that does NOT also run
    // cancelSetupReminderInTx (e.g. a request that predates this feature, or
    // a genuine commit-ordering race) by inserting the Project row directly
    // — calling createProjectFromApprovedRequest here would also cancel the
    // reminder itself (already covered by check 4), masking the specific
    // in-transaction re-check this test targets (processOne's own "defense
    // in depth" re-read of request.project inside the SENT transaction's row
    // lock).
    console.log("\nRace: Project created mid-processing ===\n");
    const r8 = await freshRequest(dept.id, requester.id);
    await decideApproval(r8.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder8 = (await getReminder(r8.id))!;
    const token8 = "race-token";
    await prisma.projectRequestSetupReminder.update({ where: { id: reminder8.id }, data: { status: "PROCESSING", claimedAt: afterDue(reminder8), claimToken: token8 } });
    const outcome8 = await svc.processClaimedSetupReminder(reminder8.id, token8, afterDue(reminder8), {
      beforeFinalTransaction: async () => {
        await prisma.project.create({ data: { title: `Race Project ${RUN_ID}`, ownerId: requester.id, projectRequestId: r8.id } });
      },
    });
    check(
      "13. a Project appearing between the eligibility check and the final transaction cancels the reminder (already_set_up), never sends",
      outcome8 === "cancelled" && (await getReminder(r8.id))?.cancellationReason === "already_set_up" && (await reminderNotifs(approver1.id, r8.id)).length === 0
    );

    // ── 14: defensive status_changed path ──
    console.log("\nDefensive: status no longer APPROVED ===\n");
    const r9 = await freshRequest(dept.id, requester.id);
    await decideApproval(r9.id, approver1.id, Role.USER, null, "approve", "Approved.");
    const reminder9 = (await getReminder(r9.id))!;
    // Simulate a request whose status somehow left APPROVED without the
    // normal cancellation path running (defense in depth only — not a real
    // reachable transition in this app today).
    await prisma.projectRequest.update({ where: { id: r9.id }, data: { status: "REJECTED" } });
    await svc.processDueProjectRequestSetupReminders({ now: afterDue(reminder9) });
    check(
      "14. a reminder whose request is no longer APPROVED is cancelled (status_changed), never sent",
      (await getReminder(r9.id))?.status === "CANCELLED" && (await getReminder(r9.id))?.cancellationReason === "status_changed" && (await reminderNotifs(approver1.id, r9.id)).length === 0
    );

    // ── 15: worker endpoint auth ──
    console.log("\nWorker endpoint auth ===\n");
    const prevSecret = process.env.CRON_SECRET;
    const prevEnv = process.env.NODE_ENV;
    process.env.CRON_SECRET = "s3cret-test";
    const noAuth = await workerRoute.POST(jsonReq("POST"));
    const wrong = await workerRoute.POST(jsonReq("POST", { authorization: "Bearer nope" }));
    const right = await workerRoute.POST(jsonReq("POST", { authorization: "Bearer s3cret-test" }));
    const rightGet = await workerRoute.GET(jsonReq("GET", { authorization: "Bearer s3cret-test" }));
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const failClosed = await workerRoute.POST(jsonReq("POST"));
    (process.env as Record<string, string>).NODE_ENV = prevEnv ?? "test";
    if (prevSecret) process.env.CRON_SECRET = prevSecret;
    check(
      "15. worker endpoint: 401 without/with wrong token, 200 with the secret (GET and POST), fails closed in production with no secret",
      noAuth.status === 401 && wrong.status === 401 && right.status === 200 && rightGet.status === 200 && failClosed.status === 401
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["setup reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["notifications (test users)", () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      // Covers notifications sent to a real, pre-existing globally-eligible
      // user (e.g. an ADMIN) outside this test's own userIds — see check 8's
      // own comment on why deptB can still have real eligible recipients.
      ["notifications (by request link, any recipient)", () => prisma.notification.deleteMany({ where: { OR: requestIds.map((id) => ({ link: svc.setupReminderLink(id) })) } })],
      ["projects", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      [
        "rolePermissions",
        async () => {
          const keys = (await prisma.customRole.findMany({ where: { id: { in: customRoleIds } }, select: { key: true } })).map((r) => r.key);
          await prisma.rolePermission.deleteMany({ where: { roleKey: { in: keys } } });
        },
      ],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
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
