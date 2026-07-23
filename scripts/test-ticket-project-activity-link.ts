/**
 * Ticket <-> Project/Activity linking — Edit Ticket now supports the same
 * link/clear behavior Create Ticket already had, backed by a new shared
 * validator (validateTicketProjectActivityLink in
 * lib/services/department-scope-service.ts) used by BOTH
 * POST /api/tickets and PATCH /api/tickets/[id], closing a real gap: Create
 * Ticket previously validated a project's department but never an
 * activity's at all, and PATCH validated neither.
 *
 * Tests:
 *  1. A project + its own matching activity, same department -> valid.
 *  2. A project + a project-less (standalone) activity in the same
 *     department -> valid (a standalone activity has no project constraint).
 *  3. An activity that belongs to a different project than the one selected
 *     -> invalid_project_activity_pair.
 *  4. An activity selected with NO project selected, when that activity
 *     actually belongs to one -> invalid_project_activity_pair (never
 *     silently auto-fills the project — matches Create Ticket's form, which
 *     doesn't do that either).
 *  5. A project from another department -> invalid_project_scope.
 *  6. An activity from another department -> invalid_activity_scope.
 *  7. A null-department (legacy) activity is treated as compatible with any
 *     department — same leniency already used for category/priority/
 *     cancelReason in the department-change route.
 *  8. Unknown project/activity ids -> project_not_found / activity_not_found.
 *  9. The admin-only gate is the same hard rule already used consistently
 *     by both POST /api/tickets and PATCH /api/tickets/[id] (pure logic
 *     check, mirrors the exact predicate in both routes).
 * 10. Department-change cascade: a project/activity scoped to the OLD
 *     department are cleared when the ticket moves to an unrelated
 *     department (mirrors the exact "stillValid" predicate in
 *     app/api/tickets/[id]/department/route.ts).
 *
 * Usage: npx tsx scripts/test-ticket-project-activity-link.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ProjectStatus, ActivityStatus, ActivityPriority, Role } from "@prisma/client";
import { validateTicketProjectActivityLink } from "@/lib/services/department-scope-service";

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

/** Mirrors the exact admin-only guard in app/api/tickets/route.ts POST and app/api/tickets/[id]/route.ts PATCH. */
function isLinkChangeAllowed(role: Role, projectIdGiven: boolean, activityIdGiven: boolean): boolean {
  if (!projectIdGiven && !activityIdGiven) return true;
  return role === Role.ADMIN;
}

/** Mirrors the exact "stillValid" predicate in app/api/tickets/[id]/department/route.ts. */
function stillValid(rowDepartmentId: string | null | undefined, targetDepartmentId: string): boolean {
  return rowDepartmentId == null || rowDepartmentId === targetDepartmentId;
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  console.log("Admin-only gate (pure, no DB)\n");
  check("No project/activity fields touched -> allowed for anyone", isLinkChangeAllowed(Role.USER, false, false));
  check("Setting a project as ADMIN -> allowed", isLinkChangeAllowed(Role.ADMIN, true, false));
  check("Setting an activity as a plain USER -> rejected", !isLinkChangeAllowed(Role.USER, false, true));
  check("Setting a project as IT_AGENT -> rejected (still admin-only)", !isLinkChangeAllowed(Role.IT_AGENT, true, false));

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptC: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let owner: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Link Dept A ${RUN_ID}`, slug: `test-link-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Link Dept B ${RUN_ID}`, slug: `test-link-dept-b-${RUN_ID}` } });
    deptC = await prisma.department.create({ data: { name: `Test Link Dept C ${RUN_ID}`, slug: `test-link-dept-c-${RUN_ID}` } });
    owner = await prisma.user.create({ data: { email: `test-link-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const projectA = await prisma.project.create({ data: { title: `Test Link Project A ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: deptA.id, ownerId: owner.id } });
    projectIds.push(projectA.id);
    const projectA2 = await prisma.project.create({ data: { title: `Test Link Project A2 ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: deptA.id, ownerId: owner.id } });
    projectIds.push(projectA2.id);
    const projectB = await prisma.project.create({ data: { title: `Test Link Project B ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: deptB.id, ownerId: owner.id } });
    projectIds.push(projectB.id);

    const activityInProjectA = await prisma.projectActivity.create({
      data: { title: `Test Link Activity in A ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: deptA.id, projectId: projectA.id },
    });
    activityIds.push(activityInProjectA.id);
    const standaloneActivityDeptA = await prisma.projectActivity.create({
      data: { title: `Test Link Standalone Activity A ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: deptA.id },
    });
    activityIds.push(standaloneActivityDeptA.id);
    const activityDeptB = await prisma.projectActivity.create({
      data: { title: `Test Link Activity B ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: deptB.id },
    });
    activityIds.push(activityDeptB.id);
    const legacyActivityNoDept = await prisma.projectActivity.create({
      data: { title: `Test Link Legacy Activity ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM },
    });
    activityIds.push(legacyActivityNoDept.id);

    console.log("\nValid combinations\n");
    let result = await validateTicketProjectActivityLink(deptA.id, projectA.id, activityInProjectA.id);
    check("Project + its own matching activity, same department -> valid", result.ok === true);

    result = await validateTicketProjectActivityLink(deptA.id, projectA.id, standaloneActivityDeptA.id);
    check("Project + a standalone activity in the same department -> valid (no project constraint from the activity)", result.ok === true);

    result = await validateTicketProjectActivityLink(deptA.id, null, legacyActivityNoDept.id);
    check("Null-department (legacy) activity is compatible with any department", result.ok === true);

    console.log("\nMismatches\n");
    result = await validateTicketProjectActivityLink(deptA.id, projectA2.id, activityInProjectA.id);
    check("Activity belongs to a DIFFERENT project than the one selected -> invalid_project_activity_pair", !result.ok && result.code === "invalid_project_activity_pair");

    result = await validateTicketProjectActivityLink(deptA.id, null, activityInProjectA.id);
    check("Activity belongs to a project but none is selected -> invalid_project_activity_pair (no silent auto-fill)", !result.ok && result.code === "invalid_project_activity_pair");

    console.log("\nCross-department rejections\n");
    result = await validateTicketProjectActivityLink(deptA.id, projectB.id, null);
    check("Project from another department -> invalid_project_scope", !result.ok && result.code === "invalid_project_scope");

    result = await validateTicketProjectActivityLink(deptA.id, null, activityDeptB.id);
    check("Activity from another department -> invalid_activity_scope", !result.ok && result.code === "invalid_activity_scope");

    console.log("\nUnknown ids\n");
    result = await validateTicketProjectActivityLink(deptA.id, "not-a-real-project-id", null);
    check("Unknown projectId -> project_not_found", !result.ok && result.code === "project_not_found");

    result = await validateTicketProjectActivityLink(deptA.id, null, "not-a-real-activity-id");
    check("Unknown activityId -> activity_not_found", !result.ok && result.code === "activity_not_found");

    console.log("\nDepartment-change cascade (mirrors app/api/tickets/[id]/department/route.ts's stillValid predicate)\n");
    // A ticket in deptA, linked to projectA/activityInProjectA, moves to deptC (unrelated).
    check("Project scoped to deptA is no longer valid once the ticket moves to deptC", !stillValid(projectA.departmentId, deptC.id));
    check("Activity scoped to deptA is no longer valid once the ticket moves to deptC", !stillValid(activityInProjectA.departmentId, deptC.id));
    // Moving to deptA itself (no-op) or to a department the row already tolerates (null) stays valid.
    check("Same department (no real move) stays valid", stillValid(projectA.departmentId, deptA.id));
    check("A null-department (legacy) row stays valid for any target department", stillValid(legacyActivityNoDept.departmentId, deptC.id));
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length > 0 ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["user", () => (owner ? prisma.user.deleteMany({ where: { id: owner.id } }) : Promise.resolve())],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id, deptC?.id].filter((id): id is string => !!id) } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
