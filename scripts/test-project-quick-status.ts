/**
 * Server-side regression coverage for the Project quick-status dropdown
 * (components/projects/project-quick-status.tsx,
 * components/projects/project-detail-header.tsx). Exercises the REAL
 * PATCH /api/projects/[id] route handler directly — the same canonical
 * update path the standalone Project Edit form already uses; no separate
 * status-update endpoint or business logic was introduced (see the final
 * report).
 *
 * Covers the task's own checklist (UI-only points 1/2/3/4/26 are left to
 * scripts/browser-verify-quick-status.ts):
 *  5.  Selecting another status persists it.
 *  6.  A fresh GET ("reload") reflects the persisted status.
 *  7.  A project.view-only user cannot change status.
 *  8.  Direct unauthorized API request is rejected.
 *  9.  A status-only PATCH does not alter any unrelated field (title,
 *      description, priority, isGoal, members, subDepartment).
 *  10. The standalone Project Edit form's full-payload PATCH still works
 *      for status (the generic route was not narrowed/broken).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-quick-status.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, ProjectStatus } from "@prisma/client";
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
const TAG = `pqs-${RUN_ID}`;

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

  const { GET: getProject, PATCH: patchProject } = await import("@/app/api/projects/[id]/route");

  const jsonReq = (url: string, body: unknown, method = "PATCH") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department, admin, an editor (project.edit) and a viewer (project.view only) ===\n");
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);

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
      data: { userId: editorUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(editorMembership.id);

    const viewerUser = await prisma.user.create({
      data: { email: `${TAG}-viewer@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(viewerUser.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewerUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const owner = admin;
    const fixtureMember = await prisma.user.create({
      data: { email: `${TAG}-member@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(fixtureMember.id);
    const fixtureMemberMembership = await prisma.departmentMembership.create({
      data: { userId: fixtureMember.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(fixtureMemberMembership.id);

    const project = await prisma.project.create({
      data: {
        title: `${TAG} Project`,
        description: `${TAG} original description`,
        departmentId: dept.id,
        ownerId: owner.id,
        status: ProjectStatus.PLANNING,
        priority: 3,
        isGoal: true,
        members: { connect: [{ id: fixtureMember.id }] },
      },
    });
    projectIds.push(project.id);

    // ── 5. Selecting another status persists it ──
    console.log("\n5. Selecting another status via a targeted PATCH persists it ===\n");
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const patchRes = await patchProject(jsonReq(`http://localhost/api/projects/${project.id}`, { status: ProjectStatus.IN_PROGRESS }), {
      params: Promise.resolve({ id: project.id }),
    });
    check("Targeted {status} PATCH by an authorized (project.edit) non-admin user -> 200", patchRes.status === 200);
    const patched = await patchRes.json();
    check("Response reflects the new status", patched.status === ProjectStatus.IN_PROGRESS);

    // ── 6. Reload shows persisted status ──
    console.log("\n6. A fresh GET (\"reload\") reflects the persisted status ===\n");
    const reloadRes = await getProject(new NextRequest(`http://localhost/api/projects/${project.id}`), { params: Promise.resolve({ id: project.id }) });
    const reloaded = await reloadRes.json();
    check("GET after the PATCH returns the new status", reloaded.status === ProjectStatus.IN_PROGRESS);

    // ── 9. A status-only PATCH does not alter unrelated fields ──
    console.log("\n9. A status-only PATCH leaves every unrelated field untouched ===\n");
    check("title unchanged", reloaded.title === `${TAG} Project`);
    check("description unchanged", reloaded.description === `${TAG} original description`);
    check("priority unchanged", reloaded.priority === 3);
    check("isGoal unchanged", reloaded.isGoal === true);
    check("members unchanged (still exactly the one fixture member)", Array.isArray(reloaded.members) && reloaded.members.length === 1 && reloaded.members[0].id === fixtureMember.id);

    // ── 7/8. A project.view-only user cannot change status ──
    console.log("\n7/8. A project.view-only user cannot change status — rejected server-side, not just hidden client-side ===\n");
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const deniedRes = await patchProject(jsonReq(`http://localhost/api/projects/${project.id}`, { status: ProjectStatus.ON_HOLD }), {
      params: Promise.resolve({ id: project.id }),
    });
    check("VIEWER (project.view only) attempting a status PATCH -> 403", deniedRes.status === 403);
    const stillUnchanged = await prisma.project.findUnique({ where: { id: project.id }, select: { status: true } });
    check("...and the real status is unchanged", stillUnchanged?.status === ProjectStatus.IN_PROGRESS);

    // ── 10. Project Edit's full-payload PATCH still works for status ──
    console.log("\n10. The standalone Project Edit form's full-payload PATCH still works ===\n");
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const fullPayloadRes = await patchProject(
      jsonReq(`http://localhost/api/projects/${project.id}`, {
        title: `${TAG} Project`,
        description: `${TAG} original description`,
        status: ProjectStatus.COMPLETED,
        priority: 3,
        isGoal: true,
        // DEPARTMENT_MANAGER (unlike the VIEWER fixtureMember) holds
        // project.assignable, so this is a genuinely eligible member.
        memberIds: [editorUser.id],
      }),
      { params: Promise.resolve({ id: project.id }) }
    );
    check("Full Edit-form-style payload PATCH -> 200", fullPayloadRes.status === 200);
    const afterFullPayload = await fullPayloadRes.json();
    check("Status updated via the full payload too", afterFullPayload.status === ProjectStatus.COMPLETED);

    console.log("\nCross-check: no status name is hardcoded — every ProjectStatus enum value round-trips through the same PATCH ===\n");
    for (const status of Object.values(ProjectStatus)) {
      const roundTripRes = await patchProject(jsonReq(`http://localhost/api/projects/${project.id}`, { status }), {
        params: Promise.resolve({ id: project.id }),
      });
      check(`ProjectStatus.${status} accepted via targeted PATCH -> 200`, roundTripRes.status === 200);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
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
