/**
 * Activity completion checkbox: toggling flips isCompleted AND status
 * together (not-completed -> COMPLETED, completed -> IN_PROGRESS), gated by
 * canActOnEntity(..., "activity.edit") exactly like every other activity
 * edit, and rejected by the new isCompleted/status consistency guard in
 * app/api/activities/[id]/route.ts if the two fields ever disagree.
 *
 * Tests:
 *  1. canActOnEntity grants "activity.edit" for a department member with
 *     AGENT_ASSIGNEE (has activity.edit) and denies it for VIEWER (view-only).
 *  2. canActOnEntity denies entirely for a user with no membership in the
 *     activity's department (cross-department).
 *  3. The consistency guard (isCompleted:true requires status:COMPLETED,
 *     isCompleted:false forbids status:COMPLETED) — same predicate the route
 *     applies before writing.
 *  4. IN_PROGRESS -> COMPLETED: isCompleted true, completedAt set, updatedAt bumped.
 *  5. COMPLETED -> IN_PROGRESS: isCompleted false, completedAt cleared back to null.
 *
 * Usage: npx tsx scripts/test-activity-status-toggle.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, ActivityStatus, ActivityPriority, DepartmentRole, MembershipSource, ProjectStatus, Role } from "@prisma/client";
import { canActOnEntity } from "@/lib/services/department-scope-service";

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

/** Mirrors the exact predicate in app/api/activities/[id]/route.ts's PATCH handler. */
function isConsistentToggle(isCompleted: boolean | undefined, status: string | undefined): boolean {
  if (isCompleted === undefined || status === undefined) return true;
  return isCompleted ? status === "COMPLETED" : status !== "COMPLETED";
}

const RUN_ID = Date.now();

async function main() {
  console.log("Testing the isCompleted/status consistency guard (pure, no DB)...\n");
  check("isCompleted:true + status:COMPLETED is consistent", isConsistentToggle(true, "COMPLETED"));
  check("isCompleted:false + status:IN_PROGRESS is consistent", isConsistentToggle(false, "IN_PROGRESS"));
  check("isCompleted:true + status:IN_PROGRESS is rejected", !isConsistentToggle(true, "IN_PROGRESS"));
  check("isCompleted:false + status:COMPLETED is rejected", !isConsistentToggle(false, "COMPLETED"));
  check("Only isCompleted provided (no status) is always consistent", isConsistentToggle(true, undefined));

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed checks.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let migrationApplied = true;
  try {
    await prisma.departmentMembership.findFirst({ select: { id: true, customRoleId: true } });
  } catch (err) {
    migrationApplied = false;
    console.log(
      "\nDepartmentMembership.customRoleId isn't usable against this database yet (migration " +
        "20260721100000_add_subdepartments_and_custom_department_roles not applied) — skipping DB-backed checks."
    );
    console.log(String(err instanceof Error ? err.message : err));
  }
  if (!migrationApplied) {
    printSummaryAndExit();
    return;
  }

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let otherDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let agentUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let viewerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  let activity: Awaited<ReturnType<typeof prisma.projectActivity.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Test Activity Toggle Dept ${RUN_ID}`, slug: `test-activity-toggle-dept-${RUN_ID}` } });
    otherDept = await prisma.department.create({ data: { name: `Test Activity Toggle Other Dept ${RUN_ID}`, slug: `test-activity-toggle-other-dept-${RUN_ID}` } });

    agentUser = await prisma.user.create({ data: { email: `test-toggle-agent-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    viewerUser = await prisma.user.create({ data: { email: `test-toggle-viewer-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });
    outsiderUser = await prisma.user.create({ data: { email: `test-toggle-outsider-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER } });

    const agentMembership = await prisma.departmentMembership.create({
      data: { userId: agentUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(agentMembership.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewerUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);
    // outsiderUser deliberately gets a membership only in the OTHER department.
    const outsiderMembership = await prisma.departmentMembership.create({
      data: { userId: outsiderUser.id, departmentId: otherDept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(outsiderMembership.id);

    project = await prisma.project.create({
      data: { title: `Test Activity Toggle Project ${RUN_ID}`, status: ProjectStatus.IN_PROGRESS, departmentId: dept.id, ownerId: agentUser.id },
    });
    activity = await prisma.projectActivity.create({
      data: {
        title: `Test Activity Toggle Activity ${RUN_ID}`,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        isCompleted: false,
        projectId: project.id,
        departmentId: dept.id,
      },
    });

    console.log("\nTesting canActOnEntity(\"activity.edit\") gating...\n");
    check(
      "AGENT_ASSIGNEE (has activity.edit) can edit the activity",
      await canActOnEntity(agentUser.id, agentUser.role, activity.departmentId, "activity.edit")
    );
    check(
      "VIEWER (view-only, no activity.edit) cannot edit the activity",
      !(await canActOnEntity(viewerUser.id, viewerUser.role, activity.departmentId, "activity.edit"))
    );
    check(
      "A user with no membership in this department (cross-department) cannot edit the activity",
      !(await canActOnEntity(outsiderUser.id, outsiderUser.role, activity.departmentId, "activity.edit"))
    );

    console.log("\nTesting IN_PROGRESS -> COMPLETED toggle...\n");
    const beforeUpdatedAt = activity.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = await prisma.projectActivity.update({
      where: { id: activity.id },
      data: { isCompleted: true, status: ActivityStatus.COMPLETED, completedAt: new Date() },
    });
    check("isCompleted is true", completed.isCompleted === true);
    check("status is COMPLETED", completed.status === ActivityStatus.COMPLETED);
    check("completedAt is set", completed.completedAt !== null);
    check("updatedAt advanced", completed.updatedAt.getTime() > beforeUpdatedAt.getTime());

    console.log("\nTesting COMPLETED -> IN_PROGRESS toggle...\n");
    const reopened = await prisma.projectActivity.update({
      where: { id: activity.id },
      data: { isCompleted: false, status: ActivityStatus.IN_PROGRESS, completedAt: null },
    });
    check("isCompleted is false", reopened.isCompleted === false);
    check("status is IN_PROGRESS", reopened.status === ActivityStatus.IN_PROGRESS);
    check("completedAt is cleared back to null", reopened.completedAt === null);

    console.log("\nTesting the activity is not deleted/closed by the toggle...\n");
    const stillExists = await prisma.projectActivity.findUnique({ where: { id: activity.id } });
    check("Activity row still exists after both toggles", stillExists !== null);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activity", () => (activity ? prisma.projectActivity.deleteMany({ where: { id: activity.id } }) : Promise.resolve())],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [agentUser?.id, viewerUser?.id, outsiderUser?.id].filter((id): id is string => !!id) } },
          }),
      ],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: [dept?.id, otherDept?.id].filter((id): id is string => !!id) } } })],
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
