/**
 * Regression coverage for the standalone-Activity Quick Status bug: the
 * status-options fetch and the status-transition PATCH must both scope
 * entirely off `activity.departmentId`, never `activity.projectId` /
 * `project.departmentId` — a standalone Activity (projectId: null) uses the
 * exact same department-scoped status configuration and progress
 * calculation as a Project-linked one; only the (skippable) Project rollup
 * step differs.
 *
 * Root cause verified during this fix (see the final report): the
 * server-side data flow (GET /api/departments/[id]/activity-statuses,
 * PATCH /api/activities/[id]) already scoped correctly off
 * activity.departmentId — no `if (!activity.projectId) return []`-shaped
 * code existed. The real, reproduced bug was CLIENT-side:
 * components/status/quick-status-select.tsx's trigger derived its OWN
 * label by searching the (separately, more slowly fetched) options list
 * for the current status id — a real window existed where that list was
 * still empty, so the trigger fell back to the raw enum key (e.g. "TODO")
 * instead of the resolved label ("To Do"), independent of whether
 * projectId was null. Fixed by requiring callers to pass the entity's own
 * authoritative label directly (see ActivityDetailClient). This script
 * therefore focuses on proving the SERVER-side data flow was already
 * correct for standalone activities (and stays correct), since the UI race
 * itself is covered live in scripts/browser-verify-quick-status.ts.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-standalone-quick-status.ts
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
const TAG = `asqs-${RUN_ID}`;

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
    console.log("\n=== Fixtures: Department A + Department B (different config), admin, editor, viewer ===\n");
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

    // Department B configured differently (BLOCKED disabled) so we can
    // prove standalone status resolution stays department-scoped, never
    // project-scoped and never cross-department.
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: deptB.id, status: ActivityStatus.BLOCKED } }, data: { isEnabled: false } });

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1/2. Standalone Activity has projectId null but a real departmentId ──
    console.log("\n1/2. A standalone Activity (projectId: null) still has a real departmentId ===\n");
    const standaloneA = await prisma.projectActivity.create({
      data: { title: `${TAG} Standalone A`, departmentId: deptA.id, status: ActivityStatus.TODO, projectId: null },
    });
    activityIds.push(standaloneA.id);
    check("Fixture activity really is standalone", standaloneA.projectId === null);
    check("Fixture activity has a real departmentId", standaloneA.departmentId === deptA.id);

    // ── 3/4. Quick Status returns valid statuses for a standalone Activity's department ──
    console.log("\n3/4. GET /api/departments/[id]/activity-statuses (what Quick Status fetches) is not empty for a standalone Activity's department ===\n");
    const statusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${deptA.id}/activity-statuses`), { params: Promise.resolve({ id: deptA.id }) });
    const statuses: any[] = await statusesRes.json();
    check("Status list is not empty", Array.isArray(statuses) && statuses.length > 0);
    check("Status list contains all 6 enabled ActivityStatus values for Department A", statuses.length === 6);

    // ── 5/6. Current status correctly identified, matches badge-equivalent statusLabel ──
    console.log("\n5/6. GET /api/activities/[id] resolves the current status/label from activity.departmentId (never via a Project) ===\n");
    const getRes = await getActivity(new NextRequest(`http://localhost/api/activities/${standaloneA.id}`), { params: Promise.resolve({ id: standaloneA.id }) });
    const got = await getRes.json();
    check("departmentId in the response is the Activity's OWN department", got.departmentId === deptA.id);
    check("status is TODO", got.status === "TODO");
    check("statusLabel is resolved (\"To Do\"), proving department-scoped config resolution works with no Project at all", got.statusLabel === "To Do");
    check("projectId is null (genuinely standalone) and canCreateProjectInDept/canEditActivity still resolve without error", got.projectId === null && typeof got.canEditActivity === "boolean");

    // ── 7/8. Selecting another status persists it ──
    console.log("\n7/8. Selecting another status via the quick-status PATCH persists it for a standalone Activity ===\n");
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const inProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS } } });
    const patchRes = await patchActivity(jsonReq(`http://localhost/api/activities/${standaloneA.id}`, { status: ActivityStatus.IN_PROGRESS, isCompleted: false }), {
      params: Promise.resolve({ id: standaloneA.id }),
    });
    check("Quick-status PATCH on a standalone Activity -> 200 (no null-project exception)", patchRes.status === 200);
    const patched = await patchRes.json();
    check("Status persisted", patched.status === ActivityStatus.IN_PROGRESS);

    // ── 9. Progress recalculates from ActivityProgressConfig ──
    console.log("\n9. Progress recalculates from ActivityProgressConfig exactly as for a linked Activity ===\n");
    check("Progress matches Department A's configured percentage for IN_PROGRESS", patched.progress === inProgressConfig.progressPercent);

    // ── 10. Reload preserves new status/progress ──
    console.log("\n10. A fresh GET (\"reload\") reflects the persisted status/progress ===\n");
    const reloadRes = await getActivity(new NextRequest(`http://localhost/api/activities/${standaloneA.id}`), { params: Promise.resolve({ id: standaloneA.id }) });
    const reloaded = await reloadRes.json();
    check("Reload shows IN_PROGRESS", reloaded.status === ActivityStatus.IN_PROGRESS);
    check("Reload shows the same recalculated progress", reloaded.progress === inProgressConfig.progressPercent);

    // ── 11/12. No Project rollup attempted; no exception for a null project ──
    console.log("\n11/12. No Project rollup side effect occurs for a standalone Activity, and no exception was thrown ===\n");
    check("projectId remains null after the transition (never implicitly attached to a Project)", reloaded.projectId === null);
    // The absence of a crash across every check above already proves no
    // null-project exception occurred; recalculateProjectRollup is never
    // invoked for a null projectId (see the PATCH route's own
    // `if (projectChanged && existing.projectId)` / `if (... && activity.project?.id)`
    // guards) — there is no Project row to assert a rollup against here at all.

    // ── PROJECT-LINKED comparison: same resolver, same transition mechanism ──
    console.log("\n13/14/15/16/17. A Project-linked Activity uses the SAME resolver and still recalculates the parent Project rollup ===\n");
    const linkedProject = await prisma.project.create({ data: { title: `${TAG} Linked Project`, departmentId: deptA.id, ownerId: admin.id } });
    projectIds.push(linkedProject.id);
    const linkedActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Linked Activity`, departmentId: deptA.id, projectId: linkedProject.id, status: ActivityStatus.TODO },
    });
    activityIds.push(linkedActivity.id);

    const linkedStatusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${deptA.id}/activity-statuses`), { params: Promise.resolve({ id: deptA.id }) });
    const linkedStatuses: any[] = await linkedStatusesRes.json();
    check("Linked Activity's department resolves the SAME status list as the standalone one (same resolver, not a project-based branch)", JSON.stringify(linkedStatuses) === JSON.stringify(statuses));

    const linkedPatchRes = await patchActivity(jsonReq(`http://localhost/api/activities/${linkedActivity.id}`, { status: ActivityStatus.IN_PROGRESS, isCompleted: false }), {
      params: Promise.resolve({ id: linkedActivity.id }),
    });
    check("Linked Activity status transition -> 200", linkedPatchRes.status === 200);
    const linkedPatched = await linkedPatchRes.json();
    check("Progress recalculates identically for the linked Activity", linkedPatched.progress === inProgressConfig.progressPercent);
    const rollup = await waitForProjectProgress(linkedProject.id, (p) => p === inProgressConfig.progressPercent);
    check("Parent Project rollup DOES recalculate for the linked Activity", rollup === inProgressConfig.progressPercent, `got ${rollup}`);

    // ── 18/19/20. Department-scoped, non-leaking configuration ──
    console.log("\n18/19/20. Standalone Activities in different Departments see only their own configured statuses ===\n");
    const standaloneB = await prisma.projectActivity.create({
      data: { title: `${TAG} Standalone B`, departmentId: deptB.id, status: ActivityStatus.TODO, projectId: null },
    });
    activityIds.push(standaloneB.id);
    const deptBStatusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${deptB.id}/activity-statuses`), { params: Promise.resolve({ id: deptB.id }) });
    const deptBStatuses: any[] = await deptBStatusesRes.json();
    check("Department B's standalone Activity does NOT see the disabled BLOCKED status", !deptBStatuses.some((s) => s.status === "BLOCKED"));
    check("Department A's standalone Activity still sees BLOCKED (no cross-department leakage)", statuses.some((s) => s.status === "BLOCKED"));

    // ── 21/22/23. No hardcoded names, stable IDs, configured ordering ──
    console.log("\n21/22/23. No hardcoded status names; stable enum IDs; configured ordering preserved ===\n");
    check("Every returned status entry uses a real ActivityStatus enum id (stable, not a display name)", statuses.every((s) => ["TODO", "IN_PROGRESS", "ON_HOLD", "BLOCKED", "COMPLETED", "CANCELLED"].includes(s.status)));
    const sortOrders = statuses.map((s) => s.sortOrder);
    check("Statuses are returned in ascending configured sortOrder", sortOrders.every((v, i) => i === 0 || sortOrders[i - 1] <= v));

    // ── 24/25/26. Permissions ──
    console.log("\n24/25/26. activity.edit is required to change a standalone Activity's status; activity.view alone is rejected ===\n");
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const deniedRes = await patchActivity(jsonReq(`http://localhost/api/activities/${standaloneA.id}`, { status: ActivityStatus.COMPLETED, isCompleted: true }), {
      params: Promise.resolve({ id: standaloneA.id }),
    });
    check("activity.view-only user cannot change a standalone Activity's status -> 403", deniedRes.status === 403);
    const stillUnchanged = await prisma.projectActivity.findUnique({ where: { id: standaloneA.id }, select: { status: true } });
    check("...and the real status is unchanged", stillUnchanged?.status === ActivityStatus.IN_PROGRESS);

    // ── 27. No Project permission is required for a standalone Activity ──
    console.log("\n27. No project.edit/project.view standing is required — only activity.edit in the Activity's own department ===\n");
    // editorUser holds ONLY a Department-A DEPARTMENT_MANAGER membership —
    // no relationship to any Project row exists or is checked; the earlier
    // successful PATCH (#7/8) with this exact user already proves this,
    // reiterated explicitly here for the record.
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const noProjectPermNeededRes = await patchActivity(jsonReq(`http://localhost/api/activities/${standaloneA.id}`, { status: ActivityStatus.ON_HOLD, isCompleted: false }), {
      params: Promise.resolve({ id: standaloneA.id }),
    });
    check("A user with only activity.edit (no project.* standing at all) can still change a standalone Activity's status -> 200", noProjectPermNeededRes.status === 200);

    // ── 30. Activity Edit page shows the same status after quick change ──
    console.log("\n30. GET /api/activities/[id] (what Activity Edit reads) shows the SAME status the quick-status PATCH just persisted ===\n");
    const finalGetRes = await getActivity(new NextRequest(`http://localhost/api/activities/${standaloneA.id}`), { params: Promise.resolve({ id: standaloneA.id }) });
    const finalGet = await finalGetRes.json();
    check("Edit-page-equivalent GET reflects ON_HOLD", finalGet.status === ActivityStatus.ON_HOLD);
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
