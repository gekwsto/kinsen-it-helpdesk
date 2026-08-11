/**
 * Server-side regression coverage for the Activity quick-status dropdown
 * (components/activities/activity-quick-status.tsx) and its removal of the
 * old "Mark Complete"/"Reopen" button from Activity detail. Exercises the
 * REAL PATCH /api/activities/[id] route handler directly — the exact same
 * canonical update path the standalone Edit form AND the old
 * toggleActivityComplete helper (components/activities/toggle-activity-complete.ts)
 * already used; no separate status-update endpoint or business logic was
 * introduced.
 *
 * Covers the task's own checklist (UI-only points 11/12/13/27/28 are left
 * to scripts/browser-verify-quick-status.ts):
 *  14. Selecting another status persists it.
 *  15. Progress recalculates correctly (derived from ActivityProgressConfig).
 *  16. Selecting the configured completion status (COMPLETED) produces the
 *      SAME persisted result as the old Mark Complete action — proven by
 *      literally replaying toggleActivityComplete's own PATCH body
 *      ({status:"COMPLETED", isCompleted:true}, exactly what that helper
 *      sends) via the quick-status wrapper's identical code path and
 *      comparing outcomes.
 *  17. Parent Project rollup recalculates correctly.
 *  18. Changing from COMPLETED back to another valid status behaves
 *      correctly (completedAt cleared, progress/rollup recalculated).
 *  19/20. An activity.view-only user cannot change status — rejected
 *      server-side.
 *  21. The standalone Activity Edit form's full-payload PATCH still works.
 *  22/25. Department-scoped, ordered, ENABLED-only status lists — two
 *      departments with different ActivityStatusConfig never leak into
 *      each other, and ordering follows each department's own sortOrder.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-quick-status.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, ActivityStatus } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

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

/** The rollup triggered by PATCH /api/activities/[id] is fire-and-forget (never awaited by the route) — poll briefly for the expected value rather than assuming synchronous completion. */
async function waitForProjectProgress(projectId: string, predicate: (progress: number) => boolean, timeoutMs = 3000): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { progress: true } });
    if (project && predicate(project.progress)) return project.progress;
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = await prisma.project.findUnique({ where: { id: projectId }, select: { progress: true } });
  return final?.progress ?? null;
}

const RUN_ID = Date.now();
const TAG = `aqs-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
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

  const { GET: getActivity, PATCH: patchActivity } = await import("@/app/api/activities/[id]/route");
  const { GET: getDeptActivityStatuses } = await import("@/app/api/departments/[id]/activity-statuses/route");

  const jsonReq = (url: string, body: unknown, method = "PATCH") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    console.log("\n=== Fixtures: two Departments with different ActivityStatusConfig, admin, an editor, a viewer ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    const editorUser = await prisma.user.create({
      data: { email: `${TAG}-editor@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(editorUser.id);
    const editorMembership = await prisma.departmentMembership.create({
      data: { userId: editorUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(editorMembership.id);

    const viewerUser = await prisma.user.create({
      data: { email: `${TAG}-viewer@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(viewerUser.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewerUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 22/25. Department-scoped, ordered status lists never leak across departments ──
    console.log("\n22/25. Disabling a status in Department A does not affect Department B; ordering follows configured sortOrder ===\n");
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: deptA.id, status: ActivityStatus.BLOCKED } }, data: { isEnabled: false } });
    // Swap sortOrder of TODO and IN_PROGRESS in Department A only, so its
    // list order visibly differs from Department B's (still-default) order —
    // proves ordering is read from real per-department config, not a fixed
    // enum-declaration order.
    const [todoRowA, inProgressRowA] = await Promise.all([
      prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: deptA.id, status: ActivityStatus.TODO } } }),
      prisma.activityStatusConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS } } }),
    ]);
    await prisma.activityStatusConfig.update({ where: { id: todoRowA.id }, data: { sortOrder: inProgressRowA.sortOrder } });
    await prisma.activityStatusConfig.update({ where: { id: inProgressRowA.id }, data: { sortOrder: todoRowA.sortOrder } });

    const deptAStatusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${deptA.id}/activity-statuses`), { params: Promise.resolve({ id: deptA.id }) });
    const deptAStatuses: any[] = await deptAStatusesRes.json();
    check("Department A's list excludes the disabled BLOCKED status", !deptAStatuses.some((s) => s.status === "BLOCKED"));
    check("Department A's list is ordered by its OWN configured sortOrder (IN_PROGRESS now before TODO)", deptAStatuses.findIndex((s) => s.status === "IN_PROGRESS") < deptAStatuses.findIndex((s) => s.status === "TODO"));

    const deptBStatusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${deptB.id}/activity-statuses`), { params: Promise.resolve({ id: deptB.id }) });
    const deptBStatuses: any[] = await deptBStatusesRes.json();
    check("Department B (untouched) still includes BLOCKED — the disable did not leak across departments", deptBStatuses.some((s) => s.status === "BLOCKED"));
    check("Department B's ordering is unaffected (TODO still before IN_PROGRESS, its own default order)", deptBStatuses.findIndex((s) => s.status === "TODO") < deptBStatuses.findIndex((s) => s.status === "IN_PROGRESS"));

    // ── Fixtures: a Project with two activities in Department A ──
    const project = await prisma.project.create({
      data: { title: `${TAG} Project`, departmentId: deptA.id, ownerId: admin.id },
    });
    projectIds.push(project.id);

    const siblingActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Sibling Activity`, departmentId: deptA.id, projectId: project.id, status: ActivityStatus.COMPLETED, progress: 100, isCompleted: true, completedAt: new Date() },
    });
    activityIds.push(siblingActivity.id);

    const activity = await prisma.projectActivity.create({
      data: { title: `${TAG} Activity`, departmentId: deptA.id, projectId: project.id, status: ActivityStatus.TODO },
    });
    activityIds.push(activity.id);

    // ── 14/15. Selecting another status persists it; progress recalculates ──
    console.log("\n14/15. Selecting a non-completion status persists it and recalculates progress from ActivityProgressConfig ===\n");
    const todoProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS } } });
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const toInProgressRes = await patchActivity(
      jsonReq(`http://localhost/api/activities/${activity.id}`, { status: ActivityStatus.IN_PROGRESS, isCompleted: false }),
      { params: Promise.resolve({ id: activity.id }) }
    );
    check("Quick-status PATCH to IN_PROGRESS -> 200", toInProgressRes.status === 200);
    const toInProgress = await toInProgressRes.json();
    check("Status persisted", toInProgress.status === ActivityStatus.IN_PROGRESS);
    check("Progress matches this department's configured percentage for IN_PROGRESS (not fabricated)", toInProgress.progress === todoProgressConfig.progressPercent);
    check("isCompleted is false", toInProgress.isCompleted === false);

    // ── 17. Parent Project rollup recalculates ──
    console.log("\n17. Parent Project rollup recalculates after the status change ===\n");
    const expectedRollupAfterInProgress = Math.round((100 + todoProgressConfig.progressPercent) / 2);
    const rollupAfterInProgress = await waitForProjectProgress(project.id, (p) => p === expectedRollupAfterInProgress);
    check(`Project.progress recalculated to the average of both activities (${expectedRollupAfterInProgress}%)`, rollupAfterInProgress === expectedRollupAfterInProgress, `got ${rollupAfterInProgress}`);

    // ── 16. Completion status produces the SAME result as the old Mark Complete ──
    console.log("\n16. Selecting the completion status reproduces toggleActivityComplete's exact result ===\n");
    // A second, independent activity completed via the OLD mechanism's own
    // literal PATCH body (components/activities/toggle-activity-complete.ts
    // sends exactly {isCompleted:true, status:"COMPLETED"}) — the baseline.
    const legacyMarkedActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy-marked Activity`, departmentId: deptA.id, status: ActivityStatus.TODO },
    });
    activityIds.push(legacyMarkedActivity.id);
    const legacyRes = await patchActivity(jsonReq(`http://localhost/api/activities/${legacyMarkedActivity.id}`, { isCompleted: true, status: "COMPLETED" }), {
      params: Promise.resolve({ id: legacyMarkedActivity.id }),
    });
    const legacyResult = await legacyRes.json();

    // The SAME transition via the new quick-status wrapper's own request shape.
    const quickStatusRes = await patchActivity(
      jsonReq(`http://localhost/api/activities/${activity.id}`, { status: ActivityStatus.COMPLETED, isCompleted: ActivityStatus.COMPLETED === ActivityStatus.COMPLETED }),
      { params: Promise.resolve({ id: activity.id }) }
    );
    check("Quick-status PATCH to COMPLETED -> 200", quickStatusRes.status === 200);
    const quickStatusResult = await quickStatusRes.json();

    check("Both paths result in isCompleted: true", legacyResult.isCompleted === true && quickStatusResult.isCompleted === true);
    check("Both paths result in status: COMPLETED", legacyResult.status === "COMPLETED" && quickStatusResult.status === "COMPLETED");
    check("Both paths derive the SAME progress percentage for COMPLETED", legacyResult.progress === quickStatusResult.progress);
    check("Both paths stamp a real completedAt timestamp (not null)", !!legacyResult.completedAt && !!quickStatusResult.completedAt);

    // ── 17 (again). Rollup after completion ──
    const rollupAfterCompletion = await waitForProjectProgress(project.id, (p) => p === 100);
    check("Project rollup is 100% once both of its activities are COMPLETED", rollupAfterCompletion === 100, `got ${rollupAfterCompletion}`);

    // ── 18. Reopening (COMPLETED -> another status) recalculates correctly ──
    console.log("\n18. Moving from COMPLETED back to another status clears completion metadata and recalculates ===\n");
    const reopenRes = await patchActivity(
      jsonReq(`http://localhost/api/activities/${activity.id}`, { status: ActivityStatus.IN_PROGRESS, isCompleted: false }),
      { params: Promise.resolve({ id: activity.id }) }
    );
    check("Reopening via quick-status PATCH -> 200", reopenRes.status === 200);
    const reopened = await reopenRes.json();
    check("isCompleted is now false", reopened.isCompleted === false);
    check("completedAt is cleared back to null", reopened.completedAt === null);
    check("Progress recalculated for the new (non-completion) status", reopened.progress === todoProgressConfig.progressPercent);

    const rollupAfterReopen = await waitForProjectProgress(project.id, (p) => p === expectedRollupAfterInProgress);
    check("Project rollup recalculates back down after reopening", rollupAfterReopen === expectedRollupAfterInProgress, `got ${rollupAfterReopen}`);

    // ── 19/20. activity.view-only user cannot change status ──
    console.log("\n19/20. A VIEWER (activity.view only) cannot change status — rejected server-side ===\n");
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const deniedRes = await patchActivity(jsonReq(`http://localhost/api/activities/${activity.id}`, { status: ActivityStatus.COMPLETED, isCompleted: true }), {
      params: Promise.resolve({ id: activity.id }),
    });
    check("VIEWER attempting a status PATCH -> 403", deniedRes.status === 403);
    const stillUnchanged = await prisma.projectActivity.findUnique({ where: { id: activity.id }, select: { status: true } });
    check("...and the real status is unchanged", stillUnchanged?.status === ActivityStatus.IN_PROGRESS);

    // ── 21. Activity Edit's full-payload PATCH still works ──
    console.log("\n21. The standalone Activity Edit form's full-payload PATCH still works ===\n");
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const editFormRes = await patchActivity(
      jsonReq(`http://localhost/api/activities/${activity.id}`, {
        title: `${TAG} Activity (edited)`,
        description: "edited via full form",
        status: ActivityStatus.ON_HOLD,
        priority: "HIGH",
        assignedUserIds: [],
        isMilestone: false,
        isCompleted: false,
      }),
      { params: Promise.resolve({ id: activity.id }) }
    );
    check("Full Edit-form-style payload PATCH -> 200", editFormRes.status === 200);
    const editFormResult = await editFormRes.json();
    check("Status updated via the full payload too", editFormResult.status === ActivityStatus.ON_HOLD);
    check("Title also updated (proves this really is the full-form path, not a status-only shortcut)", editFormResult.title === `${TAG} Activity (edited)`);

    console.log("\nAn activity's real GET response reflects the final persisted state (\"reload\") ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const finalGetRes = await getActivity(new NextRequest(`http://localhost/api/activities/${activity.id}`), { params: Promise.resolve({ id: activity.id }) });
    const finalGet = await finalGetRes.json();
    check("GET reflects the final status", finalGet.status === ActivityStatus.ON_HOLD);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
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

main();
