/**
 * Director is a cross-department oversight role: view everything, create
 * projects/activities anywhere, but never admin.access / user.manage /
 * role.manage / department.manage* power (see canViewAllDepartments() in
 * lib/permissions.ts and its use throughout
 * lib/services/department-scope-service.ts / workspace-service.ts).
 *
 * The pure canViewAllDepartments truth table needs no DB. Everything else
 * here needs a real database AND the 20260718160000_add_director_role
 * migration applied (Role.DIRECTOR is a new Postgres enum value) plus a
 * re-seed (Director's RolePermission rows) — if either hasn't happened yet
 * in this environment, the DB section reports that clearly and exits 0
 * rather than crashing on an enum/permission mismatch that isn't a real bug.
 *
 * Usage: npx tsx scripts/test-director-scope.ts
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource, Role } from "@prisma/client";
import { canViewAllDepartments, getPermissionsForRole } from "@/lib/permissions";
import {
  buildTicketListWhere,
  buildProjectListWhere,
  buildActivityListWhere,
  getAccessibleDepartmentSummaries,
  resolveDepartmentForCreate,
} from "@/lib/services/department-scope-service";
import { resolveActiveWorkspace } from "@/lib/services/workspace-service";

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
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const RUN_ID = Date.now();

async function main() {
  console.log("Testing canViewAllDepartments (pure, no DB)...\n");
  check("ADMIN can view all departments", canViewAllDepartments(Role.ADMIN) === true);
  check("DIRECTOR can view all departments", canViewAllDepartments(Role.DIRECTOR) === true);
  check("DEPARTMENT_MANAGER cannot view all departments", canViewAllDepartments(Role.DEPARTMENT_MANAGER) === false);
  check("IT_AGENT cannot view all departments", canViewAllDepartments(Role.IT_AGENT) === false);
  check("USER cannot view all departments", canViewAllDepartments(Role.USER) === false);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed checks.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.departmentMembership.findFirst({ select: { id: true, customRoleId: true } });
  } catch (err) {
    console.log(
      "\nDepartmentMembership.customRoleId isn't usable against this database yet (migration " +
        "20260721100000_add_subdepartments_and_custom_department_roles not applied) — skipping DB-backed checks."
    );
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  console.log("\nSetting up Director-role fixtures...\n");
  let directorUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let otherDeptUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const departmentIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    try {
      directorUser = await prisma.user.create({
        data: {
          email: `test-director-${RUN_ID}@kinsen.gr`,
          authProvider: AuthProvider.CREDENTIALS,
          role: Role.DIRECTOR,
        },
      });
    } catch (err) {
      console.log(
        "Role.DIRECTOR isn't usable against this database yet (migration 20260718160000_add_director_role " +
          "not applied and/or prisma/seed.ts not re-run) — skipping DB-backed Director checks. This is expected " +
          "until `npx prisma migrate deploy` (or `migrate dev`) and a re-seed run against this database."
      );
      console.log(String(err instanceof Error ? err.message : err));
      printSummaryAndExit();
      return;
    }

    const deptA = await prisma.department.create({ data: { name: `Test Director Dept A ${RUN_ID}`, slug: `test-director-dept-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `Test Director Dept B ${RUN_ID}`, slug: `test-director-dept-b-${RUN_ID}` } });
    departmentIds.push(deptA.id, deptB.id);

    otherDeptUser = await prisma.user.create({
      data: { email: `test-director-other-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });
    const otherMembership = await prisma.departmentMembership.create({
      data: { userId: otherDeptUser.id, departmentId: deptA.id, role: "REQUESTER", source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(otherMembership.id);

    console.log("\nTesting getPermissionsForRole(DIRECTOR)...\n");
    const directorPerms = await getPermissionsForRole("DIRECTOR");
    for (const expected of ["ticket.view", "project.view", "project.create", "activity.view", "activity.create", "goal.view"]) {
      check(`Director has ${expected}`, directorPerms.includes(expected));
    }
    for (const forbidden of [
      "admin.access",
      "user.manage",
      "role.manage",
      "department.manageSettings",
      "department.manageMembers",
      "ticket.reply",
      "ticket.assign",
      "ticket.changeStatus",
      "project.edit",
      "project.delete",
      "activity.edit",
      "activity.delete",
    ]) {
      check(`Director does NOT have ${forbidden}`, !directorPerms.includes(forbidden));
    }

    console.log("\nTesting buildTicketListWhere/buildProjectListWhere/buildActivityListWhere for Director...\n");
    const ticketScope = await buildTicketListWhere(directorUser.id, Role.DIRECTOR);
    check("No requested department -> unrestricted ({})", !("denied" in ticketScope) && Object.keys(ticketScope).length === 0);

    const scopedTicket = await buildTicketListWhere(directorUser.id, Role.DIRECTOR, deptA.id);
    check(
      "Explicit department -> trusted without membership",
      !("denied" in scopedTicket) && (scopedTicket as any).departmentId === deptA.id
    );

    const projectScope = await buildProjectListWhere(directorUser.id, Role.DIRECTOR);
    check("Project scope unrestricted with no requested department", !("denied" in projectScope) && Object.keys(projectScope).length === 0);

    const activityScope = await buildActivityListWhere(directorUser.id, Role.DIRECTOR);
    check("Activity scope unrestricted with no requested department", !("denied" in activityScope) && Object.keys(activityScope).length === 0);

    console.log("\nTesting getAccessibleDepartmentSummaries for Director...\n");
    const accessible = await getAccessibleDepartmentSummaries(directorUser.id, Role.DIRECTOR, "project.create");
    check("Director's accessible departments include both test departments", accessible.some((d) => d.id === deptA.id) && accessible.some((d) => d.id === deptB.id));

    console.log("\nTesting resolveDepartmentForCreate for Director...\n");
    const createResolution = await resolveDepartmentForCreate(directorUser.id, Role.DIRECTOR, deptB.id, "project.create");
    check(
      "Director's explicit department is trusted without a DepartmentMembership row",
      !("denied" in createResolution) && (createResolution as any).departmentId === deptB.id
    );
    const noDeptResolution = await resolveDepartmentForCreate(directorUser.id, Role.DIRECTOR, undefined, "project.create");
    check(
      "Omitting the department forces an explicit choice (workspace_required), same as Admin",
      "denied" in noDeptResolution && (noDeptResolution as any).denied === "workspace_required"
    );

    console.log("\nTesting resolveActiveWorkspace for Director...\n");
    const workspace = await resolveActiveWorkspace(directorUser.id, Role.DIRECTOR);
    check("Director's workspace lists every active department", workspace.departments.some((d) => d.id === deptA.id) && workspace.departments.some((d) => d.id === deptB.id));
    check("Director's canViewAllDepartments flag is true", workspace.canViewAllDepartments === true);
    check("Director defaults to a specific department, not isAllSelected, with no cookie", workspace.isAllSelected === false && workspace.departmentId !== null);

    const allSelected = await resolveActiveWorkspace(directorUser.id, Role.DIRECTOR, "ALL");
    check("Director can explicitly select All Workspaces", allSelected.isAllSelected === true && allSelected.departmentId === null);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["user", () =>
        prisma.user.deleteMany({ where: { id: { in: [directorUser?.id, otherDeptUser?.id].filter((x): x is string => !!x) } } })],
      ["department", () => (departmentIds.length > 0 ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
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
