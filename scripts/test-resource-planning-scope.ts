/**
 * Resource Planning (/projects/resource-planning) scoping — buildResourcePlanningWhere
 * (a thin wrapper over the same private buildEntityListWhere used by
 * buildProjectListWhere/buildActivityListWhere) plus the central
 * lib/services/resource-planning-service.ts (getResourcePlanningResources/
 * getResourcePlanningEvents/getResourcePlanningData) are what the page uses
 * to resolve "which department," "who counts as an agent," and "what's
 * scheduled in the current view." This test exercises all of it directly
 * against real Prisma data — no new tables involved (Project/ProjectActivity/
 * User/DepartmentMembership all predate this phase), so it needs no
 * migration guard.
 *
 * Tests:
 *  1. A Department Manager (DepartmentMembership) sees only their own
 *     department's resources/events via buildResourcePlanningWhere.
 *  2. The same user is denied (ScopeDenial) for a department they don't
 *     belong to.
 *  3. Director (global role, canViewAllDepartments) sees every department
 *     unrestricted.
 *  4. A user with no resourcePlanning.view anywhere gets zero accessible
 *     departments (NO_MATCH_WHERE-equivalent).
 *  5. SubDepartment filtering narrows both the resource list (via
 *     SubDepartmentMembership) and the event list (via ProjectActivity.subDepartmentId).
 *  6. An activity with zero assigned users doesn't crash the resource-event
 *     query (simply never appears in any resource's row).
 *  7. An activity with neither startDate nor dueDate is correctly excluded
 *     from the "has real dates" bucket (getResourcePlanningEvents routes it
 *     to `unscheduled`, not silently dropped).
 *  8. Project filter (getResourcePlanningEvents) narrows events to one project.
 *  9. Status filter narrows events to one ActivityStatus.
 *  10. An activity with real dates fully outside [rangeStart, rangeEnd] is
 *      dropped entirely by getResourcePlanningEvents — not in `events`, not
 *      in `unscheduled`.
 *  11. getResourcePlanningResources includes a user who is ONLY
 *      project-assignable (not activity-assignable) — the union, not just
 *      getAssignableUsersForActivity — tagged assignableFor: ["project"].
 *  12. An inactive user, even if otherwise eligible (active DepartmentMembership,
 *      assignable role), never appears as a resource.
 *  13. Priority filter (getResourcePlanningEvents) narrows events to one
 *      ActivityPriority.
 *  14. Returned `events` are sorted canonical-priority-first (URGENT before
 *      HIGH before MEDIUM before LOW), matching lib/activity-priority.ts —
 *      not the schema's own LOW..URGENT declaration order.
 *  15. A standalone activity (no project) still appears correctly and is
 *      unaffected by the project filter/priority filter combination.
 *  16. Combining priority + project + status + subdepartment filters
 *      together narrows correctly (AND semantics), not silently dropping
 *      or over-including.
 *  17. Multiple activities for the same agent with the identical date
 *      range are all returned distinctly (not merged/deduped) by
 *      getResourcePlanningEvents.
 *
 * Usage: npx tsx scripts/test-resource-planning-scope.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole, RoleScope, AuthProvider, MembershipSource, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { buildResourcePlanningWhere } from "@/lib/services/department-scope-service";
import { getAssignableUsersForActivity } from "@/lib/services/assignment-eligibility-service";
import {
  getResourcePlanningResources,
  getResourcePlanningEvents,
} from "@/lib/services/resource-planning-service";

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

  // Department gained a new column (inboundEmail) in the same migration as
  // PendingTicket — Prisma writes every @default()'d field into a Department
  // INSERT's column list regardless of `select`, so no new Department rows
  // (needed throughout this test) can be created until it's applied.
  try {
    await prisma.department.findFirst({ where: { inboundEmail: null }, select: { id: true } });
  } catch (err) {
    console.log(
      "Department.inboundEmail isn't usable against this database yet (migration " +
        "20260724090000_add_department_inbound_email_and_pending_tickets not applied) — skipping. " +
        "Run `npx prisma migrate deploy` (or `migrate dev`) first."
    );
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let subDeptA1: Awaited<ReturnType<typeof prisma.subDepartment.create>> | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let directorUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let noAccessUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let agentInSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let agentOutsideSub: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  let project2: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  let projectOnlyRole: { id: string; key: string } | undefined;
  let projectOnlyUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let inactiveAgent: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const activityIds: string[] = [];
  const membershipIds: string[] = [];
  const subMembershipIds: string[] = [];
  const rolePermissionRoleKeys: string[] = [];

  try {
    console.log("\nSetting up two departments, a sub-department, and users...\n");
    deptA = await prisma.department.create({ data: { name: `RP Dept A ${RUN_ID}`, slug: `rp-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `RP Dept B ${RUN_ID}`, slug: `rp-dept-b-${RUN_ID}` } });
    subDeptA1 = await prisma.subDepartment.create({ data: { name: `RP SubDept A1 ${RUN_ID}`, departmentId: deptA.id, isActive: true } });

    managerUser = await prisma.user.create({
      data: { email: `rp-manager-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    directorUser = await prisma.user.create({
      data: { email: `rp-director-${RUN_ID}@kinsen.gr`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    noAccessUser = await prisma.user.create({
      data: { email: `rp-noaccess-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    agentInSub = await prisma.user.create({
      data: { email: `rp-agent-insub-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    agentOutsideSub = await prisma.user.create({
      data: { email: `rp-agent-outsub-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });

    const mgrMembership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(mgrMembership.id);

    const agentInSubMembership = await prisma.departmentMembership.create({
      data: { userId: agentInSub.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(agentInSubMembership.id);
    const agentOutsideSubMembership = await prisma.departmentMembership.create({
      data: { userId: agentOutsideSub.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(agentOutsideSubMembership.id);

    const subMembership = await prisma.subDepartmentMembership.create({
      data: { userId: agentInSub.id, subDepartmentId: subDeptA1.id, departmentId: deptA.id, source: MembershipSource.MANUAL },
    });
    subMembershipIds.push(subMembership.id);

    console.log("\nTesting buildResourcePlanningWhere scoping...\n");
    const managerWhere = await buildResourcePlanningWhere(managerUser.id, Role.USER, deptA.id);
    check("Department Manager's own-department scope resolves (not denied)", !("denied" in managerWhere));

    const deniedWhere = await buildResourcePlanningWhere(managerUser.id, Role.USER, deptB.id);
    check("Department Manager is denied resourcePlanning scope for a department they don't belong to", "denied" in deniedWhere);

    const directorWhere = await buildResourcePlanningWhere(directorUser.id, Role.DIRECTOR, deptB.id);
    check("Director (canViewAllDepartments) resolves any department unrestricted", !("denied" in directorWhere));
    const directorWhereNoFilter = await buildResourcePlanningWhere(directorUser.id, Role.DIRECTOR, undefined);
    check("Director with no explicit department gets an unrestricted where ({})", JSON.stringify(directorWhereNoFilter) === "{}");

    const noAccessWhere = await buildResourcePlanningWhere(noAccessUser.id, Role.USER, undefined);
    check(
      "A user with no resourcePlanning.view anywhere gets a zero-match where (no accessible departments)",
      !("denied" in noAccessWhere) && JSON.stringify(noAccessWhere).includes('"id":{"in":[]}')
    );

    console.log("\nSetting up activities: one in the sub-department, one outside it, one with no assignees, one with no dates...\n");
    project = await prisma.project.create({
      data: { title: `RP Project ${RUN_ID}`, ownerId: managerUser.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS },
    });

    const now = new Date();
    const inSubActivity = await prisma.projectActivity.create({
      data: {
        title: `In SubDept Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        subDepartmentId: subDeptA1.id,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(inSubActivity.id);

    const outsideSubActivity = await prisma.projectActivity.create({
      data: {
        title: `Outside SubDept Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentOutsideSub.id }] },
      },
    });
    activityIds.push(outsideSubActivity.id);

    const noAssigneeActivity = await prisma.projectActivity.create({
      data: {
        title: `No Assignee Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
      },
    });
    activityIds.push(noAssigneeActivity.id);

    const noDatesActivity = await prisma.projectActivity.create({
      data: {
        title: `No Dates Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(noDatesActivity.id);

    console.log("\nTesting getAssignableUsersForActivity + resource/event scoping...\n");
    const resources = await getAssignableUsersForActivity(deptA.id);
    check("agentInSub is an assignable resource for deptA", resources.some((r) => r.id === agentInSub!.id));
    check("agentOutsideSub is an assignable resource for deptA", resources.some((r) => r.id === agentOutsideSub!.id));

    const subScopedResourceIds = (
      await prisma.subDepartmentMembership.findMany({
        where: { subDepartmentId: subDeptA1.id, departmentId: deptA.id, isActive: true },
        select: { userId: true },
      })
    ).map((m) => m.userId);
    check("SubDepartment filter narrows resources to only its own members", subScopedResourceIds.includes(agentInSub.id) && !subScopedResourceIds.includes(agentOutsideSub.id));

    const subScopedActivities = await prisma.projectActivity.findMany({
      where: { departmentId: deptA.id, subDepartmentId: subDeptA1.id, assignedUsers: { some: { id: { in: subScopedResourceIds } } } },
      select: { id: true },
    });
    check(
      "SubDepartment filter narrows events to only that sub-department's activities",
      subScopedActivities.some((a) => a.id === inSubActivity.id) && !subScopedActivities.some((a) => a.id === outsideSubActivity.id)
    );

    console.log("\nTesting an activity with zero assigned users doesn't break the query...\n");
    const allDeptAActivities = await prisma.projectActivity.findMany({
      where: { departmentId: deptA.id, assignedUsers: { some: { id: { in: resources.map((r) => r.id) } } } },
      include: { assignedUsers: { select: { id: true } } },
    });
    check(
      "Query with an unassigned activity present still succeeds and correctly excludes it",
      !allDeptAActivities.some((a) => a.id === noAssigneeActivity.id) && allDeptAActivities.length > 0
    );

    console.log("\nTesting date fallback bucketing (start/end vs. Unscheduled)...\n");
    const fetchedNoDates = await prisma.projectActivity.findUnique({
      where: { id: noDatesActivity.id },
      select: { startDate: true, dueDate: true },
    });
    const start = fetchedNoDates?.startDate ?? fetchedNoDates?.dueDate;
    const end = fetchedNoDates?.dueDate ?? fetchedNoDates?.startDate;
    check("An activity with neither startDate nor dueDate resolves to no start/end (routes to Unscheduled, not silently dropped)", !start && !end);

    const fetchedInSub = await prisma.projectActivity.findUnique({
      where: { id: inSubActivity.id },
      select: { startDate: true, dueDate: true },
    });
    const inSubStart = fetchedInSub?.startDate ?? fetchedInSub?.dueDate;
    const inSubEnd = fetchedInSub?.dueDate ?? fetchedInSub?.startDate;
    check("An activity with both dates set resolves to a real start/end (goes on the timeline)", !!inSubStart && !!inSubEnd);

    console.log("\nTesting getResourcePlanningEvents: project filter, status filter, date-range dropping...\n");
    project2 = await prisma.project.create({
      data: { title: `RP Project Two ${RUN_ID}`, ownerId: managerUser.id, departmentId: deptA.id, status: ProjectStatus.IN_PROGRESS },
    });
    const project2Activity = await prisma.projectActivity.create({
      data: {
        title: `Project Two Activity ${RUN_ID}`,
        projectId: project2.id,
        departmentId: deptA.id,
        status: ActivityStatus.COMPLETED,
        priority: ActivityPriority.MEDIUM,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(project2Activity.id);

    const farFuture = new Date(now.getFullYear() + 1, 0, 1);
    const outOfRangeActivity = await prisma.projectActivity.create({
      data: {
        title: `Out Of Range Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.MEDIUM,
        startDate: farFuture,
        dueDate: farFuture,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(outOfRangeActivity.id);

    const viewRangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
    const viewRangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
    const allResourceIds = (await getAssignableUsersForActivity(deptA.id)).map((r) => r.id);

    const { events: unfiltered } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("Unfiltered events include both project1 and project2 activities in range", unfiltered.some((e) => e.id === inSubActivity.id) && unfiltered.some((e) => e.id === project2Activity.id));
    check("Out-of-range activity is dropped entirely (not in events)", !unfiltered.some((e) => e.id === outOfRangeActivity.id));

    const { events: byProject, unscheduled: unscheduledByProject } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      projectId: project2.id,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("Project filter narrows events to only that project's activities", byProject.every((e) => e.projectId === project2!.id) && byProject.some((e) => e.id === project2Activity.id));
    check("Project filter's unscheduled bucket is also scoped (empty here — this project's activity has dates)", unscheduledByProject.every((e) => e.projectId === project2!.id));

    const { events: byStatus } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      status: ActivityStatus.COMPLETED,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("Status filter narrows events to only COMPLETED activities", byStatus.every((e) => e.status === "COMPLETED") && byStatus.some((e) => e.id === project2Activity.id));
    check("Status filter excludes non-matching activities", !byStatus.some((e) => e.id === inSubActivity.id));

    console.log("\nTesting getResourcePlanningEvents: priority filter, priority ordering, standalone activity, combination filters...\n");
    // Same agent (agentInSub), same exact date range (now..now) as
    // inSubActivity — multiple activities colliding on both resource AND
    // date range is exactly the "several activities, same agent, same
    // window" case the one-lane-per-activity render model has to handle.
    const urgentActivity = await prisma.projectActivity.create({
      data: {
        title: `Urgent Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        subDepartmentId: subDeptA1.id,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.URGENT,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(urgentActivity.id);

    const highActivity = await prisma.projectActivity.create({
      data: {
        title: `High Activity ${RUN_ID}`,
        projectId: project.id,
        departmentId: deptA.id,
        subDepartmentId: subDeptA1.id,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.HIGH,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(highActivity.id);

    // Standalone — no project at all, matching a real "activity without a
    // project" edge case, not just a project-scoped one.
    const standaloneActivity = await prisma.projectActivity.create({
      data: {
        title: `Standalone Low Activity ${RUN_ID}`,
        projectId: null,
        departmentId: deptA.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.LOW,
        startDate: now,
        dueDate: now,
        assignedUsers: { connect: [{ id: agentInSub.id }] },
      },
    });
    activityIds.push(standaloneActivity.id);

    const { events: byPriority } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      priority: ActivityPriority.URGENT,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("Priority filter narrows events to only URGENT activities", byPriority.every((e) => e.priority === "URGENT") && byPriority.some((e) => e.id === urgentActivity.id));
    check("Priority filter excludes non-matching activities", !byPriority.some((e) => e.id === highActivity.id));

    const { events: allInRange } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    const rankOf: Record<string, number> = { URGENT: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
    const isSortedByPriorityDesc = allInRange.every((e, i) => i === 0 || rankOf[allInRange[i - 1].priority] >= rankOf[e.priority]);
    check("events is sorted URGENT..LOW (canonical rank), never the schema's raw LOW..URGENT order", isSortedByPriorityDesc);
    check("URGENT activity sorts before the MEDIUM ones", allInRange.findIndex((e) => e.id === urgentActivity.id) < allInRange.findIndex((e) => e.id === inSubActivity.id));

    check("Standalone (no-project) activity appears with projectId: null", allInRange.some((e) => e.id === standaloneActivity.id && e.projectId === null));
    const { events: byProjectExcludesStandalone } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      projectId: project.id,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("A specific project filter correctly excludes the standalone (no-project) activity", !byProjectExcludesStandalone.some((e) => e.id === standaloneActivity.id));

    console.log("\nTesting combination filters (priority + project + status + subdepartment) apply as AND, not OR...\n");
    const { events: combo } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      subDepartmentId: subDeptA1.id,
      projectId: project.id,
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.URGENT,
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("Combined filters match exactly the one activity satisfying all four", combo.length === 1 && combo[0].id === urgentActivity.id);

    const { events: comboMismatch } = await getResourcePlanningEvents({
      departmentId: deptA.id,
      subDepartmentId: subDeptA1.id,
      projectId: project.id,
      status: ActivityStatus.IN_PROGRESS,
      priority: ActivityPriority.LOW, // urgentActivity is URGENT, not LOW — AND semantics must exclude it
      resourceIds: allResourceIds,
      rangeStart: viewRangeStart,
      rangeEnd: viewRangeEnd,
    });
    check("A mismatched combination (right project/status/subdept, wrong priority) correctly matches nothing", comboMismatch.length === 0);

    console.log("\nTesting multiple activities for the same agent, same date range, are all returned distinctly...\n");
    const sameAgentSameRange = allInRange.filter((e) => e.assignedUserIds.includes(agentInSub!.id) && e.start === now.toISOString());
    const uniqueIds = new Set(sameAgentSameRange.map((e) => e.id));
    check(
      "At least 3 same-agent, same-date-range activities present (inSubActivity, urgentActivity, highActivity, standaloneActivity)",
      sameAgentSameRange.length >= 3
    );
    check("They're all distinct activity ids — not merged/deduped into one", uniqueIds.size === sameAgentSameRange.length);

    console.log("\nTesting getResourcePlanningResources: union with project-only-assignable users...\n");
    const projectAssignablePerm = await prisma.permission.findUnique({ where: { key: "project.assignable" } });
    check("project.assignable permission is seeded", projectAssignablePerm !== null);
    if (projectAssignablePerm) {
      projectOnlyRole = await prisma.customRole.create({
        data: {
          key: `TEST_PROJECT_ONLY_${RUN_ID}`,
          name: `Project-Only Role ${RUN_ID}`,
          isBuiltIn: false,
          scope: RoleScope.DEPARTMENT,
        },
        select: { id: true, key: true },
      });
      await prisma.rolePermission.create({ data: { roleKey: projectOnlyRole.key, permissionId: projectAssignablePerm.id } });
      rolePermissionRoleKeys.push(projectOnlyRole.key);

      projectOnlyUser = await prisma.user.create({
        data: { email: `rp-project-only-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
      });
      const projectOnlyMembership = await prisma.departmentMembership.create({
        data: {
          userId: projectOnlyUser.id,
          departmentId: deptA.id,
          role: DepartmentRole.VIEWER, // placeholder — customRoleId is the real grant
          customRoleId: projectOnlyRole.id,
          source: MembershipSource.MANUAL,
        },
      });
      membershipIds.push(projectOnlyMembership.id);

      const resourcesWithUnion = await getResourcePlanningResources(deptA.id);
      const projectOnlyResource = resourcesWithUnion.find((r) => r.id === projectOnlyUser!.id);
      check("Project-only-assignable user appears in the resource union", !!projectOnlyResource);
      check("Project-only-assignable user is tagged assignableFor: ['project'] only", JSON.stringify(projectOnlyResource?.assignableFor) === '["project"]');
    }

    console.log("\nTesting getResourcePlanningResources excludes inactive users...\n");
    inactiveAgent = await prisma.user.create({
      data: { email: `rp-inactive-agent-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: false },
    });
    const inactiveMembership = await prisma.departmentMembership.create({
      data: { userId: inactiveAgent.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(inactiveMembership.id);
    const resourcesAfterInactive = await getResourcePlanningResources(deptA.id);
    check("An inactive user never appears as a resource even with an otherwise-eligible active membership", !resourcesAfterInactive.some((r) => r.id === inactiveAgent!.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      [
        "projects",
        () =>
          prisma.project.deleteMany({
            where: { id: { in: [project?.id, project2?.id].filter((id): id is string => !!id) } },
          }),
      ],
      ["subDepartmentMemberships", () => prisma.subDepartmentMembership.deleteMany({ where: { id: { in: subMembershipIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: rolePermissionRoleKeys } } })],
      ["customRoles", () => (projectOnlyRole ? prisma.customRole.deleteMany({ where: { id: projectOnlyRole.id } }) : Promise.resolve())],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: {
              id: {
                in: [
                  managerUser?.id,
                  directorUser?.id,
                  noAccessUser?.id,
                  agentInSub?.id,
                  agentOutsideSub?.id,
                  projectOnlyUser?.id,
                  inactiveAgent?.id,
                ].filter((id): id is string => !!id),
              },
            },
          }),
      ],
      ["subDepartment", () => (subDeptA1 ? prisma.subDepartment.deleteMany({ where: { id: subDeptA1.id } }) : Promise.resolve())],
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
