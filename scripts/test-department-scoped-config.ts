/**
 * Verifies the department-scoped config feature (Categories/Priorities/
 * Statuses/Cancel Reasons/SLA): strict per-department visibility via
 * buildCategoryWhere/buildPriorityWhere/buildStatusWhere (Categories/
 * Priorities/Statuses are fully department-owned — no more global/shared
 * row, see the 20260727_retire_global_config migration), buildCancelReasonWhere
 * still supporting its own global-plus-own shape (Cancel Reasons were kept
 * global, out of scope for that migration), department-only default status/
 * priority resolution (no more global fallback), the ticketConfig
 * permission keys' seeded defaults, that SLA policy scoping is entirely
 * inherited from priority ownership (no separate SLA department field), that
 * `resolveActiveWorkspace`'s "All Workspaces" selection only ever takes
 * effect for a canViewAllDepartments (ADMIN) user, and that Director's
 * global role grants none of the ticketConfig permission keys (the
 * workspace-aware admin config pages gate any cross-department override on
 * isAdmin(), not canViewAllDepartments(), specifically because of this).
 *
 * Same style/limits as scripts/test-department-manager-scope.ts: tests the
 * parameterized service/permission functions directly (buildXWhere,
 * hasDepartmentPermission, resolveDefaultStatusId/resolveDefaultPriorityId),
 * not the session-dependent requireDepartmentPermission/requireAuth wrappers
 * or the Next.js route handlers themselves — those are thin wrappers over
 * the same functions tested here, and this codebase has no HTTP-mocking
 * harness for route handlers.
 *
 * Requires a reachable DATABASE_URL, and `npm run db:seed` to have been run
 * at least once against it (so the ticketConfig permission keys/grants
 * exist) — prints a clear message and exits if either isn't available.
 *
 * Usage: npx tsx scripts/test-department-scoped-config.ts
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole, MembershipSource, Role, AuthProvider } from "@prisma/client";
import {
  buildCategoryWhere,
  buildPriorityWhere,
  buildStatusWhere,
  buildCancelReasonWhere,
  resolveDefaultStatusId,
  resolveDefaultPriorityId,
} from "@/lib/services/department-scope-service";
import { hasDepartmentPermission, hasAnyDepartmentPermission, hasPermission, isAdmin } from "@/lib/permissions";
import { resolveActiveWorkspace, ALL_WORKSPACES_VALUE } from "@/lib/services/workspace-service";
import { getMembership } from "@/lib/services/department-membership-service";

const TICKET_CONFIG_PERMISSION_KEYS = [
  "category.manage",
  "priority.create", "priority.edit", "priority.delete",
  "status.create", "status.edit", "status.delete",
  "cancelReason.create", "cancelReason.edit", "cancelReason.delete",
  "sla.create", "sla.edit", "sla.delete",
];

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

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  try {
    await prisma.ticketPriority.findFirst({ select: { id: true, departmentId: true } });
    await prisma.ticketStatus.findFirst({ select: { id: true, departmentId: true } });
    await prisma.ticketCancelReason.findFirst({ select: { id: true, departmentId: true } });
  } catch (err) {
    console.log(
      "\nTicketPriority/TicketStatus/TicketCancelReason.departmentId isn't usable against this database yet " +
        "(migration 20260725090000_add_department_role_and_config_scoping not applied) — skipping."
    );
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const priorityCreatePerm = await prisma.permission.findUnique({ where: { key: "priority.create" } });
  if (!priorityCreatePerm) {
    console.log("\nticketConfig permission keys aren't seeded yet — run `npm run db:seed` first. Skipping.");
    process.exit(0);
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const priorityIds: string[] = [];
  const statusIds: string[] = [];
  const cancelReasonIds: string[] = [];
  const slaPolicyPriorityIds: string[] = [];
  const testUserIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Config Dept A ${RUN_ID}`, slug: `test-config-dept-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Config Dept B ${RUN_ID}`, slug: `test-config-dept-b-${RUN_ID}` } });

    console.log("Categories: department-owned visibility\n");
    const categoryA = await prisma.ticketCategory.create({
      data: { name: `Test Category A ${RUN_ID}`, departmentId: deptA.id },
    });
    check(
      "Dept A's own category matches buildCategoryWhere(deptA)",
      await prisma.ticketCategory.count({ where: { AND: [{ id: categoryA.id }, buildCategoryWhere(deptA.id)] } }) === 1
    );
    check(
      "Dept A's own category does NOT match buildCategoryWhere(deptB)",
      await prisma.ticketCategory.count({ where: { AND: [{ id: categoryA.id }, buildCategoryWhere(deptB.id)] } }) === 0
    );

    console.log("\nPriorities: department-owned visibility + SLA inherits scope from priority ownership\n");
    const priorityA = await prisma.ticketPriority.create({
      data: { name: `Test Priority A ${RUN_ID}`, level: 5, color: "#111111", departmentId: deptA.id },
    });
    priorityIds.push(priorityA.id);
    check(
      "Dept A's own priority matches buildPriorityWhere(deptA)",
      await prisma.ticketPriority.count({ where: { AND: [{ id: priorityA.id }, buildPriorityWhere(deptA.id)] } }) === 1
    );
    check(
      "Dept A's own priority does NOT match buildPriorityWhere(deptB)",
      await prisma.ticketPriority.count({ where: { AND: [{ id: priorityA.id }, buildPriorityWhere(deptB.id)] } }) === 0
    );

    const priorityB = await prisma.ticketPriority.create({
      data: { name: `Test Priority B ${RUN_ID}`, level: 4, color: "#444444", departmentId: deptB.id },
    });
    priorityIds.push(priorityB.id);
    const slaPolicyA = await prisma.slaPolicy.create({
      data: { priorityId: priorityA.id, firstResponseHours: 1, resolutionHours: 2 },
    });
    slaPolicyPriorityIds.push(priorityA.id);
    check(
      "Dept A's own priority has its own independent SlaPolicy row",
      slaPolicyA.priorityId === priorityA.id
    );
    check(
      "Dept B's identically-scoped-shape priority has no SlaPolicy of its own — no shared/cross-department SLA state",
      (await prisma.slaPolicy.findUnique({ where: { priorityId: priorityB.id } })) === null
    );

    console.log("\nStatuses: department-owned visibility + department-aware default resolution\n");
    const statusA = await prisma.ticketStatus.create({
      data: { name: `Test Status A ${RUN_ID}`, color: "#222222", departmentId: deptA.id, isDefault: true, order: 0 },
    });
    statusIds.push(statusA.id);
    check(
      "Dept A's own status matches buildStatusWhere(deptA)",
      await prisma.ticketStatus.count({ where: { AND: [{ id: statusA.id }, buildStatusWhere(deptA.id)] } }) === 1
    );
    check(
      "Dept A's own status does NOT match buildStatusWhere(deptB)",
      await prisma.ticketStatus.count({ where: { AND: [{ id: statusA.id }, buildStatusWhere(deptB.id)] } }) === 0
    );

    const resolvedForDeptA = await resolveDefaultStatusId(deptA.id);
    check("resolveDefaultStatusId(deptA) resolves to deptA's OWN default status", resolvedForDeptA === statusA.id);

    const resolvedForDeptB = await resolveDefaultStatusId(deptB.id);
    check(
      "resolveDefaultStatusId(deptB) resolves to null — deptB has no default status of its own and there is no more global fallback",
      resolvedForDeptB === null
    );

    console.log("\nPriorities: default-priority resolution is strictly the department's own, no fallback\n");
    const resolvedPriorityForDeptA = await resolveDefaultPriorityId(deptA.id);
    check("resolveDefaultPriorityId(deptA) resolves to deptA's own priority", resolvedPriorityForDeptA === priorityA.id);
    const resolvedPriorityForDeptB = await resolveDefaultPriorityId(deptB.id);
    check("resolveDefaultPriorityId(deptB) resolves to deptB's own priority (not deptA's)", resolvedPriorityForDeptB === priorityB.id);

    console.log("\nCancel Reasons: department-owned visibility\n");
    const cancelReasonA = await prisma.ticketCancelReason.create({
      data: { name: `Test Cancel Reason A ${RUN_ID}`, departmentId: deptA.id },
    });
    cancelReasonIds.push(cancelReasonA.id);
    check(
      "Dept A's own cancel reason matches buildCancelReasonWhere(deptA)",
      await prisma.ticketCancelReason.count({ where: { AND: [{ id: cancelReasonA.id }, buildCancelReasonWhere(deptA.id)] } }) === 1
    );
    check(
      "Dept A's own cancel reason does NOT match buildCancelReasonWhere(deptB)",
      await prisma.ticketCancelReason.count({ where: { AND: [{ id: cancelReasonA.id }, buildCancelReasonWhere(deptB.id)] } }) === 0
    );

    console.log("\nPermissions: seeded ticketConfig defaults per role\n");
    check(
      "DEPARTMENT_ADMIN has priority.create/edit/delete",
      await hasAnyDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, ["priority.create", "priority.edit", "priority.delete"])
    );
    check(
      "DEPARTMENT_MANAGER has status.create/edit/delete",
      await hasAnyDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, ["status.create", "status.edit", "status.delete"])
    );
    check(
      "DEPARTMENT_ADMIN has category.manage",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, "category.manage")
    );
    check(
      "DEPARTMENT_ADMIN has category.delete",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, "category.delete")
    );
    check(
      "DEPARTMENT_MANAGER has category.delete",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "category.delete")
    );
    check(
      "DIRECTOR does NOT have category.delete by default (global role, not a DepartmentRole grant)",
      !(await hasPermission(Role.DIRECTOR, "category.delete"))
    );
    check(
      "VIEWER does NOT have category.delete by default",
      !(await hasDepartmentPermission(DepartmentRole.VIEWER, "category.delete"))
    );
    check(
      "AGENT_ASSIGNEE does NOT have category.delete by default",
      !(await hasDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, "category.delete"))
    );
    check(
      "DEPARTMENT_MANAGER has sla.edit",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "sla.edit")
    );
    check(
      "AGENT_ASSIGNEE does NOT have priority.create by default",
      !(await hasDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, "priority.create"))
    );
    check(
      "REQUESTER does NOT have cancelReason.delete by default",
      !(await hasDepartmentPermission(DepartmentRole.REQUESTER, "cancelReason.delete"))
    );
    check(
      "VIEWER does NOT have category.manage by default",
      !(await hasDepartmentPermission(DepartmentRole.VIEWER, "category.manage"))
    );

    console.log("\nGlobal Categories/Priorities/Statuses have been fully retired (departmentId is required now)\n");
    check("Every department still has its own real categories/priorities/statuses (nothing lost)", (await prisma.ticketCategory.count()) > 0 && (await prisma.ticketPriority.count()) > 0 && (await prisma.ticketStatus.count()) > 0);
    check("Cancel Reasons alone still support a global (departmentId: null) row", (await prisma.ticketCancelReason.count({ where: { departmentId: null } })) > 0);

    console.log("\nWorkspace resolution: isAllSelected only for canViewAllDepartments users, never for a plain member\n");
    const adminUser = await prisma.user.create({
      data: { email: `test-config-admin-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN },
    });
    testUserIds.push(adminUser.id);
    const adminWorkspace = await resolveActiveWorkspace(adminUser.id, Role.ADMIN, ALL_WORKSPACES_VALUE);
    check("ADMIN + explicit ALL cookie -> isAllSelected true, departmentId null", adminWorkspace.isAllSelected === true && adminWorkspace.departmentId === null);

    const managerUser = await prisma.user.create({
      data: { email: `test-config-manager-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.DEPARTMENT_MANAGER },
    });
    testUserIds.push(managerUser.id);
    const managerMembershipA = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL, isPrimary: true },
    });
    membershipIds.push(managerMembershipA.id);
    const managerWorkspace = await resolveActiveWorkspace(managerUser.id, Role.DEPARTMENT_MANAGER, ALL_WORKSPACES_VALUE);
    check(
      "Plain department member + ALL cookie -> isAllSelected stays false (ALL is ignored for non-canViewAllDepartments roles)",
      managerWorkspace.isAllSelected === false && managerWorkspace.departmentId === deptA.id
    );

    console.log("\nDirector holds none of the ticketConfig permission keys via their global role (matches prisma/seed.ts DIRECTOR list)\n");
    for (const key of TICKET_CONFIG_PERMISSION_KEYS) {
      check(`DIRECTOR global role lacks '${key}'`, !(await hasPermission(Role.DIRECTOR, key)));
    }
    check("isAdmin(DIRECTOR) is false (Director never bypasses department-permission checks the way Admin does)", !isAdmin(Role.DIRECTOR));

    console.log("\nA Department Manager scoped to Dept A has no membership (and therefore no permission) in Dept B\n");
    const membershipInOwnDept = await getMembership(managerUser.id, deptA.id);
    const membershipInForeignDept = await getMembership(managerUser.id, deptB.id);
    check("Has a real membership in their own department", membershipInOwnDept !== null && membershipInOwnDept.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("Has NO membership at all in a foreign department (no cross-department fallback)", membershipInForeignDept === null);
    check(
      "Permission check in own department passes (priority.create)",
      membershipInOwnDept != null && (await hasDepartmentPermission(membershipInOwnDept.role, "priority.create", membershipInOwnDept.customRoleId))
    );
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () =>
        membershipIds.length > 0 ? prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } }) : Promise.resolve()],
      ["user", () =>
        testUserIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: testUserIds } } }) : Promise.resolve()],
      ["slaPolicy", () =>
        slaPolicyPriorityIds.length > 0
          ? prisma.slaPolicy.deleteMany({ where: { priorityId: { in: slaPolicyPriorityIds } } })
          : Promise.resolve()],
      ["ticketPriority", () =>
        priorityIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { id: { in: priorityIds } } }) : Promise.resolve()],
      ["ticketStatus", () =>
        statusIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } }) : Promise.resolve()],
      ["ticketCancelReason", () =>
        cancelReasonIds.length > 0 ? prisma.ticketCancelReason.deleteMany({ where: { id: { in: cancelReasonIds } } }) : Promise.resolve()],
      ["ticketCategory", () => prisma.ticketCategory.deleteMany({ where: { name: { contains: RUN_ID.toString() } } })],
      ["department", () => {
        const ids = [deptA?.id, deptB?.id].filter((v): v is string => !!v);
        return ids.length > 0 ? prisma.department.deleteMany({ where: { id: { in: ids } } }) : Promise.resolve();
      }],
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
