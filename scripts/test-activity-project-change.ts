/**
 * Activity edit form's Project dropdown (app/(main)/activities/[id]/edit/activity-edit-client.tsx)
 * lets a user move an activity to a different project or clear it back to
 * Standalone. This test exercises the two real bugs the architecture plan
 * identified and fixed: (1) updateActivitySchema now accepts an explicit
 * `projectId: null`; (2) the shared PATCH /api/activities/[id] route now
 * validates a target project exists and belongs to the activity's own
 * department (project_not_found / invalid_project_scope), mirrored here
 * directly against real Prisma data — plus confirms the project dropdown's
 * data source (GET /api/projects?departmentId=) and Resource Planning's
 * existing projectId filter both already handle Standalone/moved activities
 * correctly.
 *
 * Tests:
 *  7. updateActivitySchema accepts projectId: null (Standalone).
 *  8. Project list scoped by departmentId (buildProjectListWhere, same as
 *     GET /api/projects) excludes another department's projects.
 *  9. Setting projectId to a project in the same department succeeds
 *     (the route's own validation logic, mirrored).
 *  10. Setting projectId to a project in a different department is
 *      rejected (invalid_project_scope condition, mirrored).
 *  11. Setting projectId to a nonexistent id is rejected (project_not_found
 *      condition, mirrored).
 *  12. Clearing projectId to null (Standalone) is reflected correctly by
 *      Resource Planning's existing projectId filter: appears under "Any
 *      project", absent when a different specific project is selected,
 *      appears again once actually moved into a project and that project
 *      is selected.
 *
 * Usage: npx tsx scripts/test-activity-project-change.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { buildProjectListWhere } from "@/lib/services/department-scope-service";
import { getResourcePlanningEvents } from "@/lib/services/resource-planning-service";
import { updateActivitySchema } from "@/lib/validations";

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

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

/** Mirrors the PATCH route's exact project-scope validation. */
async function wouldRejectProjectChange(
  targetProjectId: string | null,
  effectiveDepartmentId: string | null
): Promise<{ ok: true } | { ok: false; code: "project_not_found" | "invalid_project_scope" }> {
  if (targetProjectId === null) return { ok: true };
  const targetProject = await prisma.project.findUnique({ where: { id: targetProjectId }, select: { id: true, departmentId: true } });
  if (!targetProject) return { ok: false, code: "project_not_found" };
  if (targetProject.departmentId !== effectiveDepartmentId) return { ok: false, code: "invalid_project_scope" };
  return { ok: true };
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  console.log("\nTesting updateActivitySchema accepts an explicit projectId: null...\n");
  const parsed = updateActivitySchema.safeParse({ projectId: null });
  check("projectId: null parses successfully (Standalone)", parsed.success && parsed.data.projectId === null);
  const parsedRealId = updateActivitySchema.safeParse({ projectId: "some-real-id" });
  check("projectId: <string> still parses successfully (move to a project)", parsedRealId.success && parsedRealId.data.projectId === "some-real-id");
  const parsedOmitted = updateActivitySchema.safeParse({ title: "Unrelated change" });
  check("Omitting projectId entirely still parses (undefined, 'leave unchanged')", parsedOmitted.success && parsedOmitted.data.projectId === undefined);

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let ownerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let projectInA: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  let anotherProjectInA: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  let projectInB: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];

  try {
    console.log("\nSetting up two departments with one project each...\n");
    deptA = await prisma.department.create({ data: { name: `PC Dept A ${RUN_ID}`, slug: `pc-dept-a-${RUN_ID}` }, select: { id: true } });
    deptB = await prisma.department.create({ data: { name: `PC Dept B ${RUN_ID}`, slug: `pc-dept-b-${RUN_ID}` }, select: { id: true } });

    ownerUser = await prisma.user.create({
      data: { email: `pc-owner-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    projectInA = await prisma.project.create({
      data: { title: `PC Project A1 ${RUN_ID}`, ownerId: ownerUser.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS },
    });
    anotherProjectInA = await prisma.project.create({
      data: { title: `PC Project A2 ${RUN_ID}`, ownerId: ownerUser.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS },
    });
    projectInB = await prisma.project.create({
      data: { title: `PC Project B1 ${RUN_ID}`, ownerId: ownerUser.id, departmentId: deptB.id, status: ProjectStatus.IN_PROGRESS },
    });

    console.log("\nTesting the project dropdown's data source is department-scoped...\n");
    const scopeA = await buildProjectListWhere(ownerUser.id, Role.ADMIN, deptA.id);
    if (!("denied" in scopeA)) {
      const projectsInScopeA = await prisma.project.findMany({ where: { AND: [scopeA, { id: { in: [projectInA.id, anotherProjectInA.id, projectInB.id] } }] } });
      check("Department-scoped project list includes both deptA projects", projectsInScopeA.some((p) => p.id === projectInA!.id) && projectsInScopeA.some((p) => p.id === anotherProjectInA!.id));
      check("Department-scoped project list excludes deptB's project", !projectsInScopeA.some((p) => p.id === projectInB!.id));
    } else {
      check("buildProjectListWhere resolved for deptA", false);
    }

    console.log("\nTesting the PATCH route's project-change validation (mirrored)...\n");
    const sameDeptMove = await wouldRejectProjectChange(anotherProjectInA.id, deptA.id);
    check("Moving to a project in the same department succeeds", sameDeptMove.ok === true);

    const crossDeptMove = await wouldRejectProjectChange(projectInB.id, deptA.id);
    check("Moving to a project in a different department is rejected", !crossDeptMove.ok && crossDeptMove.code === "invalid_project_scope");

    const nonexistentMove = await wouldRejectProjectChange("does-not-exist-id", deptA.id);
    check("Moving to a nonexistent project is rejected", !nonexistentMove.ok && nonexistentMove.code === "project_not_found");

    const clearMove = await wouldRejectProjectChange(null, deptA.id);
    check("Clearing to Standalone (null) is always allowed", clearMove.ok === true);

    console.log("\nTesting Resource Planning's existing projectId filter handles Standalone/moved activities correctly...\n");
    const standaloneActivity = await prisma.projectActivity.create({
      data: {
        title: `PC Standalone Activity ${RUN_ID}`,
        projectId: null,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
        startDate: new Date(),
        dueDate: new Date(),
        assignedUsers: { connect: [{ id: ownerUser.id }] },
      },
    });
    activityIds.push(standaloneActivity.id);

    const rangeStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const rangeEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const { events: anyProjectEvents } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      resourceIds: [ownerUser.id],
      rangeStart,
      rangeEnd,
    });
    check("Standalone activity appears when Project filter is 'Any project'", anyProjectEvents.some((e) => e.id === standaloneActivity.id));

    const { events: filteredByOtherProject } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      projectId: anotherProjectInA.id,
      resourceIds: [ownerUser.id],
      rangeStart,
      rangeEnd,
    });
    check("Standalone activity is absent when a specific (different) project is selected", !filteredByOtherProject.some((e) => e.id === standaloneActivity.id));

    // Simulate the activity being moved into projectInA (what the PATCH route would do).
    await prisma.projectActivity.update({ where: { id: standaloneActivity.id }, data: { projectId: projectInA.id } });

    const { events: filteredByOwnProject } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      projectId: projectInA.id,
      resourceIds: [ownerUser.id],
      rangeStart,
      rangeEnd,
    });
    check("After moving into projectInA, the activity appears when that project is selected", filteredByOwnProject.some((e) => e.id === standaloneActivity.id));

    const { events: filteredByOtherProjectAfterMove } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      projectId: anotherProjectInA.id,
      resourceIds: [ownerUser.id],
      rangeStart,
      rangeEnd,
    });
    check("...and no longer appears under a different project's filter", !filteredByOtherProjectAfterMove.some((e) => e.id === standaloneActivity.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      [
        "projects",
        () =>
          prisma.project.deleteMany({
            where: { id: { in: [projectInA?.id, anotherProjectInA?.id, projectInB?.id].filter((id): id is string => !!id) } },
          }),
      ],
      ["users", () => (ownerUser ? prisma.user.deleteMany({ where: { id: ownerUser.id } }) : Promise.resolve())],
      [
        "departments",
        () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } }),
      ],
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

  printSummaryAndExit();
}

main();
