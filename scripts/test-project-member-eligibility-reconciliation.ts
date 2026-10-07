/**
 * Focused regression for reconciling POST /api/projects's memberIds
 * write-time validation with the manual /projects/new Members UI, which an
 * earlier task already switched to Workspace-DepartmentMembership-based
 * eligibility (see components/projects/project-form.tsx,
 * GET /api/departments/[id]/members). Before this fix, the backend still
 * unconditionally required `project.assignable` regardless of what the UI
 * actually offered — a plain Workspace member without that permission
 * could be SELECTED in the UI, then REJECTED on submit.
 *
 * The fix is the new `memberEligibilitySource` field
 * (createProjectMemberEligibilitySchema in lib/validations.ts): the
 * standalone manual-creation form now sends
 * memberEligibilitySource: "workspaceMembership", resolved via the new
 * resolveActiveDepartmentMemberIds helper; every OTHER caller (inline/
 * ticket-linking in particular, which omits the field or sends
 * "assignable" explicitly) keeps the historical
 * userHasAssignablePermissionForEntity check, completely unchanged.
 *
 * Covers:
 *  1. "workspaceMembership": a plain VIEWER department member (no
 *     project.assignable) -> 201, member persisted.
 *  2. "workspaceMembership": a user who is a member of a DIFFERENT
 *     department only -> 400.
 *  3. "workspaceMembership": an INACTIVE user who otherwise has an active
 *     membership in the target department -> 400.
 *  4. "assignable" (omitted — the default, what inline/ticket-linking
 *     sends) with that SAME plain VIEWER member -> still 400, exactly like
 *     before this change — proves inline's own semantics are untouched.
 *  5. "assignable" with a DEPARTMENT_MANAGER member (holds
 *     project.assignable) -> still 201 — sanity, the historical path still
 *     works for its own intended case.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-member-eligibility-reconciliation.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
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

const RUN_ID = Date.now();
const TAG = `pmer-${RUN_ID}`;

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

  const { POST: postProjects } = await import("@/app/api/projects/route");

  const jsonReq = (body: unknown) =>
    new NextRequest("http://localhost/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const otherDept = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    departmentIds.push(otherDept.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // Plain VIEWER — an active, real member of `dept`, but VIEWER never
    // grants project.assignable (see prisma/seed.ts's AGENT_ASSIGNEE/
    // IT_AGENT comment on the same point).
    const viewer = await prisma.user.create({
      data: { email: `${TAG}-viewer@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(viewer.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewer.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);

    // DEPARTMENT_MANAGER — DOES grant project.assignable.
    const manager = await prisma.user.create({
      data: { email: `${TAG}-manager@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(manager.id);
    const managerMembership = await prisma.departmentMembership.create({
      data: { userId: manager.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerMembership.id);

    // A member of the OTHER department only — must be rejected for `dept`.
    const outsider = await prisma.user.create({
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(outsider.id);
    const outsiderMembership = await prisma.departmentMembership.create({
      data: { userId: outsider.id, departmentId: otherDept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(outsiderMembership.id);

    // An INACTIVE user with an otherwise-active membership in `dept`.
    const inactiveMember = await prisma.user.create({
      data: { email: `${TAG}-inactive@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: false },
      select: { id: true },
    });
    userIds.push(inactiveMember.id);
    const inactiveMembership = await prisma.departmentMembership.create({
      data: { userId: inactiveMember.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(inactiveMembership.id);

    // ── 1. workspaceMembership: plain Workspace member, no project.assignable -> 201 ──
    console.log("\n1. memberEligibilitySource: workspaceMembership — a plain VIEWER member (no project.assignable) -> 201, persisted ===\n");
    const res1 = await postProjects(
      jsonReq({ title: `${TAG} Project 1`, departmentId: dept.id, memberIds: [viewer.id], memberEligibilitySource: "workspaceMembership" })
    );
    check("POST -> 201", res1.status === 201);
    if (res1.status === 201) {
      const body1 = await res1.json();
      projectIds.push(body1.id);
      check("Response includes the member", Array.isArray(body1.members) && body1.members.some((m: any) => m.id === viewer.id));
      const persisted1 = await prisma.project.findUnique({ where: { id: body1.id }, include: { members: { select: { id: true } } } });
      check("...and it's genuinely persisted in the DB", !!persisted1 && persisted1.members.some((m) => m.id === viewer.id));
    }

    // ── 2. workspaceMembership: user outside the selected Workspace -> 400 ──
    console.log("\n2. memberEligibilitySource: workspaceMembership — a user who belongs to a DIFFERENT department only -> 400 ===\n");
    const res2 = await postProjects(
      jsonReq({ title: `${TAG} Project 2`, departmentId: dept.id, memberIds: [outsider.id], memberEligibilitySource: "workspaceMembership" })
    );
    check("POST -> 400 assignee_not_assignable", res2.status === 400);
    const body2 = await res2.json().catch(() => ({}));
    check("...with the expected error code", body2.code === "assignee_not_assignable");
    const createdForOutsider = await prisma.project.findFirst({ where: { title: `${TAG} Project 2` } });
    check("...and nothing was created", createdForOutsider === null);

    // ── 3. workspaceMembership: inactive user -> 400 ──
    console.log("\n3. memberEligibilitySource: workspaceMembership — an INACTIVE user with an otherwise-active membership -> 400 ===\n");
    const res3 = await postProjects(
      jsonReq({ title: `${TAG} Project 3`, departmentId: dept.id, memberIds: [inactiveMember.id], memberEligibilitySource: "workspaceMembership" })
    );
    check("POST -> 400", res3.status === 400);
    const createdForInactive = await prisma.project.findFirst({ where: { title: `${TAG} Project 3` } });
    check("...and nothing was created", createdForInactive === null);

    // ── 4. "assignable" (omitted — what inline/ticket-linking sends) with
    //       the SAME plain VIEWER -> still 400, proving inline's own
    //       semantics are completely unchanged by this fix. ──
    console.log("\n4. memberEligibilitySource OMITTED (inline/ticket-linking's default) — the SAME plain VIEWER member -> still 400 (unchanged) ===\n");
    const res4 = await postProjects(jsonReq({ title: `${TAG} Project 4`, departmentId: dept.id, memberIds: [viewer.id] }));
    check("POST -> 400 — the historical project.assignable rule still applies when the field is omitted", res4.status === 400);
    const createdForOmitted = await prisma.project.findFirst({ where: { title: `${TAG} Project 4` } });
    check("...and nothing was created", createdForOmitted === null);

    // ── 5. "assignable" explicitly, with a project.assignable holder -> 201 (sanity) ──
    console.log("\n5. memberEligibilitySource: assignable (explicit) — a DEPARTMENT_MANAGER (holds project.assignable) -> still 201 ===\n");
    const res5 = await postProjects(
      jsonReq({ title: `${TAG} Project 5`, departmentId: dept.id, memberIds: [manager.id], memberEligibilitySource: "assignable" })
    );
    check("POST -> 201 — the historical path still accepts its own intended case", res5.status === 201);
    if (res5.status === 201) {
      const body5 = await res5.json();
      projectIds.push(body5.id);
    }

    // ── And the inverse of #4: "assignable" explicitly also still ACCEPTS
    //    a manager, confirming the branch itself (not just the default) is
    //    byte-for-byte the pre-existing behavior. ──
    console.log("\n6. memberEligibilitySource: workspaceMembership — the SAME DEPARTMENT_MANAGER (member either way) -> also 201 ===\n");
    const res6 = await postProjects(
      jsonReq({ title: `${TAG} Project 6`, departmentId: dept.id, memberIds: [manager.id], memberEligibilitySource: "workspaceMembership" })
    );
    check("POST -> 201 — a project.assignable holder is ALSO a real Workspace member, so both rules agree", res6.status === 201);
    if (res6.status === 201) {
      const body6 = await res6.json();
      projectIds.push(body6.id);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { title: { startsWith: TAG } } });
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
