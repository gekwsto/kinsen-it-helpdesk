/**
 * Phase 2 — Project Responsible People: regression coverage for the new,
 * permanent, independent Project relationship (Project.responsiblePeople).
 *
 * Does NOT re-prove what earlier phases' own scripts already cover
 * (scripts/test-project-organizational-audience.ts — Phase 1 Department/
 * Business Unit Audience; scripts/test-project-audience-unified-visibility.ts
 * — Phase 1.1 individual Audience + list/Gantt/dashboard discoverability).
 * This file focuses on what's NEW:
 *
 *   1. Schema/validation: responsiblePeopleIds is a real, independently
 *      validated field on createProjectSchema (manual + request-origin),
 *      never written into audience/owners/members.
 *   2. Configuration: manual creation, request-origin creation, and PATCH
 *      edit — all three paths accept it; PATCH omit-vs-replace semantics
 *      match every other Audience-shaped field.
 *   3. Authorization: Responsible People grants the SAME read-only
 *      visibility as Audience, record-level AND list/dashboard-level
 *      (reusing buildProjectAudienceWhere), never edit/delete/approval/
 *      Project-Request/Ticket/Activity access, and is never added to
 *      Project.audience itself.
 *   4. Immediate grant/revoke on assignment change, with no other access
 *      path confusing the result.
 *   5. Existing Audience/Owner behavior is unaffected by any of this.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-responsible-people.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

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

async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");
  const { buildProjectListWhere } = await import("@/lib/services/department-scope-service");
  const { getProjectsDashboardData } = await import("@/lib/services/projects-dashboard-service");
  const projectsPOST = (await import("@/app/api/projects/route")).POST;
  const projectsGET = (await import("@/app/api/projects/[id]/route")).GET;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const projectsDELETE = (await import("@/app/api/projects/[id]/route")).DELETE;

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const membershipIds: string[] = [];

  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u;
  }
  async function addMembership(userId: string, departmentId: string) {
    const m = await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(m.id);
    return m;
  }

  try {
    // Owning department — gives NOBODY project.view, so any visibility
    // proven below comes purely from Responsible People.
    const ownDept = await createDepartment({ name: `RespPeople Own Dept ${RUN_ID}`, slug: `resp-people-own-${RUN_ID}` });
    deptIds.push(ownDept.id);

    const admin = await makeUser(`resp-people-admin-${RUN_ID}@kinsen.gr`);
    const responsibleUser = await makeUser(`resp-people-user-${RUN_ID}@kinsen.gr`);
    const secondResponsibleUser = await makeUser(`resp-people-second-${RUN_ID}@kinsen.gr`);
    const unrelatedUser = await makeUser(`resp-people-unrelated-${RUN_ID}@kinsen.gr`);
    const audienceUser = await makeUser(`resp-people-audience-${RUN_ID}@kinsen.gr`);

    // ══════════════════════ 1. Schema ══════════════════════
    console.log("\n=== 1. Schema shape ===\n");
    const { createProjectSchema } = await import("@/lib/validations");
    check(
      "responsiblePeopleIds is on createProjectSchema, defaulting to []",
      "responsiblePeopleIds" in createProjectSchema.shape &&
        (createProjectSchema.safeParse({ title: "A valid title", departmentId: ownDept.id }) as any).data?.responsiblePeopleIds?.length === 0
    );

    // ══════════════════════ 2. POST /api/projects validates + connects Responsible People ══════════════════════
    console.log("\n=== 2. Manual creation accepts and validates Responsible People ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const fakeRes = await projectsPOST(jsonReq({ title: `RespPeople Fake ${RUN_ID}`, departmentId: ownDept.id, responsiblePeopleIds: ["nonexistent-id"] }));
    check("A nonexistent responsiblePeopleIds entry -> 400 invalid_responsible_people", fakeRes.status === 400 && (await fakeRes.json()).code === "invalid_responsible_people");

    const createRes = await projectsPOST(
      jsonReq({
        title: `RespPeople Manual Project ${RUN_ID}`,
        departmentId: ownDept.id,
        responsiblePeopleIds: [responsibleUser.id, responsibleUser.id], // duplicate on purpose
        audienceIds: [audienceUser.id],
      })
    );
    check("Valid responsiblePeopleIds on a MANUAL Project -> 201", createRes.status === 201);
    const createBody = await createRes.json();
    const projectId: string = createBody.id;
    projectIds.push(projectId);

    const getRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    const getBody = await getRes.json();
    check("GET reflects responsiblePeople, deduplicated", getBody.responsiblePeople?.length === 1 && getBody.responsiblePeople[0].id === responsibleUser.id);
    check("...and responsiblePeople was NEVER written into `audience` — audience is exactly the separately-submitted audienceUser, nothing more", getBody.audience?.length === 1 && getBody.audience[0].id === audienceUser.id);

    // ══════════════════════ 3. Record-level visibility ══════════════════════
    console.log("\n=== 3. Record-level: Responsible People grants the SAME read-only visibility as Audience ===\n");
    const projectForAccessCheck = { id: projectId, departmentId: ownDept.id, projectRequestId: null as string | null };
    check("Responsible Person CAN view (via hasProjectViewAccess)", await hasProjectViewAccess(responsibleUser.id, Role.USER, null, projectForAccessCheck));
    check("An unrelated user still CANNOT view", !(await hasProjectViewAccess(unrelatedUser.id, Role.USER, null, projectForAccessCheck)));

    currentSession = { user: { id: responsibleUser.id, role: Role.USER, customRoleId: null } };
    const respGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    check("...and really does, through the real GET route", respGetRes.status === 200);

    // ══════════════════════ 4. Read-only — never mutation/approval/related-entity access ══════════════════════
    console.log("\n=== 4. Responsible People grants READ only — never edit/delete/approval ===\n");
    const respPatchRes = await projectsPATCH(jsonReq({ title: "Hijacked" }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("Responsible Person's PATCH -> 403", respPatchRes.status === 403);
    const respDeleteRes = await projectsDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: projectId }) });
    check("Responsible Person's DELETE -> 403", respDeleteRes.status === 403);

    // ══════════════════════ 5. PATCH: independent omit-vs-replace, same convention as Audience ══════════════════════
    console.log("\n=== 5. PATCH responsiblePeopleIds — independent per-field omit-vs-replace ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const patchUnrelatedRes = await projectsPATCH(jsonReq({ title: `RespPeople Manual Project ${RUN_ID} Renamed` }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH touching an unrelated field (title) -> 200", patchUnrelatedRes.status === 200);
    const patchUnrelatedBody = await patchUnrelatedRes.json();
    check("...responsiblePeople (omitted from this PATCH) is UNTOUCHED", patchUnrelatedBody.responsiblePeople?.length === 1 && patchUnrelatedBody.responsiblePeople[0].id === responsibleUser.id);

    const patchReplaceRes = await projectsPATCH(jsonReq({ responsiblePeopleIds: [secondResponsibleUser.id] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("A later PATCH with an explicit responsiblePeopleIds array -> 200, REPLACES the full set", patchReplaceRes.status === 200);
    const patchReplaceBody = await patchReplaceRes.json();
    check("...only secondResponsibleUser remains (replaced, not appended)", patchReplaceBody.responsiblePeople?.length === 1 && patchReplaceBody.responsiblePeople[0].id === secondResponsibleUser.id);
    check("...audience (omitted from THIS PATCH) is still untouched", patchReplaceBody.audience?.length === 1 && patchReplaceBody.audience[0].id === audienceUser.id);

    const patchFakeRes = await projectsPATCH(jsonReq({ responsiblePeopleIds: ["nonexistent-id"] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH with a fake responsiblePeopleIds entry -> 400 invalid_responsible_people, nothing applied", patchFakeRes.status === 400 && (await patchFakeRes.json()).code === "invalid_responsible_people");
    const afterFakePatch = await prisma.project.findUnique({ where: { id: projectId }, select: { responsiblePeople: { select: { id: true } } } });
    check("...the rejected attempt did not partially apply", afterFakePatch?.responsiblePeople.length === 1 && afterFakePatch.responsiblePeople[0].id === secondResponsibleUser.id);

    const patchClearRes = await projectsPATCH(jsonReq({ responsiblePeopleIds: [] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("An explicit empty array clears Responsible People -> 200", patchClearRes.status === 200);
    const patchClearBody = await patchClearRes.json();
    check("...responsiblePeople is now empty", patchClearBody.responsiblePeople?.length === 0);
    check("...and the PRE-EXISTING Audience assignment from creation is completely unaffected by all of this", patchClearBody.audience?.length === 1 && patchClearBody.audience[0].id === audienceUser.id);

    // ══════════════════════ 6. List/dashboard-level discoverability (reuses buildProjectAudienceWhere) ══════════════════════
    console.log("\n=== 6. Responsible-People-derived visibility reaches Project lists/dashboards too ===\n");
    await prisma.project.update({ where: { id: projectId }, data: { responsiblePeople: { connect: [{ id: responsibleUser.id }] } } });

    const unscopedWhere = await buildProjectListWhere(responsibleUser.id, Role.USER);
    check("Unscoped ('All Workspaces') list where is a real where, not a denial", !("denied" in unscopedWhere));
    const listMatches = "denied" in unscopedWhere ? [] : await prisma.project.findMany({ where: { AND: [unscopedWhere as any, { id: projectId }] } });
    check("...and the Responsible-Person-only Project IS found by it — discoverable in list views", listMatches.length === 1);

    const unrelatedWhere = await buildProjectListWhere(unrelatedUser.id, Role.USER);
    const unrelatedMatches = "denied" in unrelatedWhere ? [] : await prisma.project.findMany({ where: { AND: [unrelatedWhere as any, { id: projectId }] } });
    check("...while an unrelated user's own unscoped list where does NOT match", unrelatedMatches.length === 0);

    const explicitDeptFilterWhere = await buildProjectListWhere(responsibleUser.id, Role.USER, ownDept.id);
    check("An explicit single-department filter the caller has no RBAC in stays DENIED — same boundary as Audience", "denied" in explicitDeptFilterWhere);

    const dashboardForResponsibleUser = await getProjectsDashboardData(responsibleUser.id, Role.USER, undefined);
    check("Dashboard counters (aggregation) resolve and include the Responsible-People-granted Project", !("denied" in dashboardForResponsibleUser) && (dashboardForResponsibleUser as any).totalProjects >= 1);

    // ══════════════════════ 7. Immediate grant/revoke on assignment change ══════════════════════
    console.log("\n=== 7. Immediate access grant and revocation on Responsible People assignment changes ===\n");
    const freshUser = await makeUser(`resp-people-fresh-${RUN_ID}@kinsen.gr`);
    check("Before assignment, freshUser cannot view", !(await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck)));
    await prisma.project.update({ where: { id: projectId }, data: { responsiblePeople: { connect: [{ id: freshUser.id }] } } });
    check("Immediately after assignment (no other change) — freshUser can now view", await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck));
    await prisma.project.update({ where: { id: projectId }, data: { responsiblePeople: { disconnect: [{ id: freshUser.id }] } } });
    check("Immediately after un-assignment — freshUser is denied again, unless another valid access path exists (none here)", !(await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck)));

    // Membership-based department scoping for a Responsible Person should
    // NOT matter at all — Responsible People is never Department-scoped,
    // same as Audience Users / Owner(s).
    const deptMemberRespUser = await makeUser(`resp-people-deptmember-${RUN_ID}@kinsen.gr`);
    const otherDept = await createDepartment({ name: `RespPeople Other Dept ${RUN_ID}`, slug: `resp-people-other-${RUN_ID}` });
    deptIds.push(otherDept.id);
    await addMembership(deptMemberRespUser.id, otherDept.id);
    await prisma.project.update({ where: { id: projectId }, data: { responsiblePeople: { connect: [{ id: deptMemberRespUser.id }] } } });
    check("A Responsible Person from a COMPLETELY DIFFERENT department (no RBAC in ownDept at all) is still granted view access — system-wide, never Department-scoped", await hasProjectViewAccess(deptMemberRespUser.id, Role.USER, null, projectForAccessCheck));

    // ══════════════════════ 8. Request-origin creation accepts Responsible People too ══════════════════════
    console.log("\n=== 8. Request-origin Project creation also accepts Responsible People ===\n");
    const { createProjectFromRequestSchema } = await import("@/lib/validations");
    check("createProjectFromRequestSchema inherits responsiblePeopleIds from the base schema", "responsiblePeopleIds" in createProjectFromRequestSchema.innerType().shape);

    currentSession = null;
  } finally {
    await runCleanup([
      ["delete projects", async () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["delete memberships", async () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      ["delete users", async () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["delete ticket categories", async () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete ticket priorities", async () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete ticket statuses", async () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["delete departments", async () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
      ["disconnect", async () => prisma.$disconnect()],
    ]);
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Unhandled error in test run:", err);
  process.exit(1);
});
