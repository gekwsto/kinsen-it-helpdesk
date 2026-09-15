/**
 * Regression coverage for the Project/Activity DELETE authorization fix.
 *
 * ROOT CAUSE (fixed): DELETE /api/activities/[id] and DELETE
 * /api/projects/[id] used requireAdmin() — global Role.ADMIN only — even
 * though DEPARTMENT_ADMIN (and other department roles) already hold
 * activity.delete/project.delete independently (see prisma/seed.ts). A
 * global Role.USER with an active DEPARTMENT_ADMIN membership in a
 * department could not delete an Activity/Project in THAT SAME department
 * they administer. The UI (ActivityDeleteButton/ProjectDeleteButton gates)
 * mirrored the same bug via a raw `isAdmin`/`role === Role.ADMIN` check.
 *
 * THE FIX: both DELETE handlers now load the entity's departmentId and call
 * canActOnEntity(userId, role, departmentId, "activity.delete"|"project.delete")
 * — the exact same canonical department-scoped resolver GET/PATCH on both
 * routes already used. activity.delete/project.delete are their own
 * independently-grantable permissions — never implied by activity.edit/
 * project.edit (see prisma/seed.ts: AGENT_ASSIGNEE has *.edit but NOT
 * *.delete). The UI now reads a server-computed canDeleteActivity/
 * canDeleteProject flag (same "UI hint, backend authoritative" pattern
 * already used for canEditActivity/canEditProject) instead of isAdmin.
 *
 * Global Role.ADMIN behavior is unchanged: canActOnEntity's own
 * canViewAllDepartments(role) bypass keeps a real System Admin able to
 * delete anything, in any department, with no membership required —
 * exactly as before this fix.
 *
 * SECTION A is a pure source-text guard (no DB) proving the two DELETE
 * handlers actually call the department-scoped resolver and no longer call
 * requireAdmin(). SECTION B exercises the real canActOnEntity resolver
 * (the exact function both DELETE routes now call) against real DB fixtures
 * for every scenario the fix must satisfy.
 *
 * Usage: npx tsx scripts/test-project-activity-delete-authorization.ts
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";

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

async function main() {
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — DELETE handlers use the department-scoped resolver, not requireAdmin() ===\n");

  const activityRoutePath = path.join(process.cwd(), "app/api/activities/[id]/route.ts");
  const activityRouteSrc = await fs.readFile(activityRoutePath, "utf8");
  const activityDeleteSrc = activityRouteSrc.slice(activityRouteSrc.indexOf("export async function DELETE"));

  check("A1. Activity DELETE calls canActOnEntity(...) with 'activity.delete'", /canActOnEntity\([^)]*"activity\.delete"/.test(activityDeleteSrc));
  check("A2. Activity DELETE does NOT call requireAdmin()", !/requireAdmin\s*\(/.test(activityDeleteSrc));
  check("A3. Activity DELETE returns 403 when the permission check fails", /status:\s*403/.test(activityDeleteSrc));

  const projectRoutePath = path.join(process.cwd(), "app/api/projects/[id]/route.ts");
  const projectRouteSrc = await fs.readFile(projectRoutePath, "utf8");
  const projectDeleteSrc = projectRouteSrc.slice(projectRouteSrc.indexOf("export async function DELETE"));

  check("A4. Project DELETE calls canActOnEntity(...) with 'project.delete'", /canActOnEntity\([^)]*"project\.delete"/.test(projectDeleteSrc));
  check("A5. Project DELETE does NOT call requireAdmin()", !/requireAdmin\s*\(/.test(projectDeleteSrc));
  check("A6. Project DELETE returns 403 when the permission check fails", /status:\s*403/.test(projectDeleteSrc));

  // delete must not be derivable from edit — the two permission checks must
  // be textually distinct call sites, never the same variable reused.
  check("A7. Activity route resolves activity.delete and activity.edit as SEPARATE canActOnEntity calls (delete never implied by edit)", (activityRouteSrc.match(/canActOnEntity\([^)]*"activity\.edit"/g) ?? []).length >= 1 && (activityRouteSrc.match(/canActOnEntity\([^)]*"activity\.delete"/g) ?? []).length >= 1);
  check("A8. Project route resolves project.delete and project.edit as SEPARATE canActOnEntity calls (delete never implied by edit)", (projectRouteSrc.match(/canActOnEntity\([^)]*"project\.edit"/g) ?? []).length >= 1 && (projectRouteSrc.match(/canActOnEntity\([^)]*"project\.delete"/g) ?? []).length >= 1);

  // ══════════════════════ SECTION B — behavioral (real DB) ══════════════════════
  console.log("\n=== SECTION B — canActOnEntity('activity.delete'/'project.delete') behavioral coverage ===\n");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const RUN_ID = Date.now();
  const userIds: string[] = [];
  const departmentIds: string[] = [];

  try {
    const deptA = await prisma.department.create({ data: { name: `Delete Auth Dept A ${RUN_ID}`, slug: `delete-auth-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `Delete Auth Dept B ${RUN_ID}`, slug: `delete-auth-b-${RUN_ID}` } });
    const deptC = await prisma.department.create({ data: { name: `Delete Auth Dept C ${RUN_ID}`, slug: `delete-auth-c-${RUN_ID}` } });
    departmentIds.push(deptA.id, deptB.id, deptC.id);

    // global Role.USER + active DEPARTMENT_ADMIN membership in Dept A only.
    const deptAdminUser = await prisma.user.create({
      data: { email: `delete-auth-deptadmin-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(deptAdminUser.id);
    await grantManualMembership(deptAdminUser.id, deptA.id, { role: DepartmentRole.DEPARTMENT_ADMIN });

    console.log("1. global USER + DEPARTMENT_ADMIN in Dept A CAN delete an Activity/Project in Dept A\n");
    check("1a. activity.delete in Dept A", await canActOnEntity(deptAdminUser.id, Role.USER, deptA.id, "activity.delete"));
    check("1b. project.delete in Dept A", await canActOnEntity(deptAdminUser.id, Role.USER, deptA.id, "project.delete"));

    console.log("\n2. The SAME user CANNOT delete an Activity/Project in Dept B (no membership/permission there)\n");
    check("2a. activity.delete in Dept B is denied", !(await canActOnEntity(deptAdminUser.id, Role.USER, deptB.id, "activity.delete")));
    check("2b. project.delete in Dept B is denied", !(await canActOnEntity(deptAdminUser.id, Role.USER, deptB.id, "project.delete")));

    console.log("\n3. activity.delete/project.delete absent for a role that has *.edit but NOT *.delete (AGENT_ASSIGNEE) => denied — proves edit never implies delete\n");
    const agentUser = await prisma.user.create({
      data: { email: `delete-auth-agent-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(agentUser.id);
    await grantManualMembership(agentUser.id, deptC.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    check("3a. AGENT_ASSIGNEE holds activity.edit in Dept C (sanity check)", await canActOnEntity(agentUser.id, Role.USER, deptC.id, "activity.edit"));
    check("3b. ...but NOT activity.delete in the SAME department", !(await canActOnEntity(agentUser.id, Role.USER, deptC.id, "activity.delete")));
    check("3c. AGENT_ASSIGNEE does NOT hold project.edit in Dept C either (sanity check it's genuinely absent, not just untested)", !(await canActOnEntity(agentUser.id, Role.USER, deptC.id, "project.edit")));
    check("3d. ...and NOT project.delete", !(await canActOnEntity(agentUser.id, Role.USER, deptC.id, "project.delete")));

    console.log("\n4. GLOBAL ADMIN behavior is unchanged — can delete anywhere, in any department, with zero membership\n");
    const adminUser = await prisma.user.create({
      data: { email: `delete-auth-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(adminUser.id);
    check("4a. ADMIN can delete an Activity in Dept A (no membership there)", await canActOnEntity(adminUser.id, Role.ADMIN, deptA.id, "activity.delete"));
    check("4b. ADMIN can delete a Project in Dept B (no membership there)", await canActOnEntity(adminUser.id, Role.ADMIN, deptB.id, "project.delete"));
    check("4c. ADMIN can delete in Dept C too (no membership there either)", await canActOnEntity(adminUser.id, Role.ADMIN, deptC.id, "activity.delete"));

    console.log("\n5. Department permissions never leak — a DEPARTMENT_ADMIN grant in ONE department never applies to a DIFFERENT department, even for the same permission key\n");
    // deptAdminUser (DEPARTMENT_ADMIN in Dept A only) already proven denied
    // in Dept B above (#2) and was never granted anything in Dept C either.
    check("5a. Dept A's DEPARTMENT_ADMIN has no delete rights in Dept C", !(await canActOnEntity(deptAdminUser.id, Role.USER, deptC.id, "activity.delete")));
    check("5b. Dept C's AGENT_ASSIGNEE (agentUser) has no delete rights in Dept A", !(await canActOnEntity(agentUser.id, Role.USER, deptA.id, "activity.delete")));
    // Legacy/no-department entity (departmentId: null) resolves against the
    // configured legacy department, never silently allowed/denied outside
    // that resolution — same behavior canActOnEntity already guarantees for
    // every other permission key; asserting the TWO non-admin users above
    // (unrelated to whichever department the legacy fallback resolves to)
    // are still consistently denied is the actual leakage proof, not a
    // literal null-departmentId case (which depends on this deployment's
    // configured legacy department and isn't reproducible fixture data).
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
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
