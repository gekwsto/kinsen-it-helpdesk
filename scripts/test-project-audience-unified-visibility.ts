/**
 * Phase 1.1 — Complete Project Audience Authorization: regression coverage
 * for the two gaps Phase 1.1 closes on top of Phase 1 (see
 * scripts/test-project-organizational-audience.ts for Phase 1's own
 * coverage, still valid and not re-proven here):
 *
 *   1. Individual Audience (Project.audience) is no longer request-
 *      origin-only — it now provides the same visibility AND is
 *      configurable (create + edit) for a MANUAL Project too, exactly like
 *      Department/Business Unit audience already was. Project Owner
 *      semantics are explicitly UNCHANGED (never extended to manual
 *      Projects, no edit surface).
 *   2. Audience-derived visibility (all three types) now also applies to
 *      Project LIST/search/Gantt/dashboard queries (buildProjectListWhere/
 *      getProjectsDashboardData), via the SAME predicate
 *      (buildProjectAudienceWhere) hasProjectViewAccess uses at record
 *      level — centralized, not duplicated, applied before pagination/
 *      aggregation. A single-department filter the caller has no RBAC in
 *      is deliberately left denied (Audience must not grant general
 *      access to the owning Department).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-audience-unified-visibility.ts
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
  async function addMembership(userId: string, departmentId: string, isActive = true) {
    const m = await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive },
    });
    membershipIds.push(m.id);
    return m;
  }

  try {
    // Project's own OWNING department — gives NOBODY project.view here, so
    // any visibility proven below comes purely from Audience.
    const ownDept = await createDepartment({ name: `UnifiedAudience Own Dept ${RUN_ID}`, slug: `unified-audience-own-${RUN_ID}` });
    deptIds.push(ownDept.id);
    // A SEPARATE department the audience Department-membership test uses —
    // distinct from ownDept so "Audience must not grant general access to
    // the owning Department" has something real to fail against.
    const audienceDept = await createDepartment({ name: `UnifiedAudience Audience Dept ${RUN_ID}`, slug: `unified-audience-audience-dept-${RUN_ID}` });
    deptIds.push(audienceDept.id);

    const admin = await makeUser(`unified-audience-admin-${RUN_ID}@kinsen.gr`);
    const audienceUser = await makeUser(`unified-audience-user-${RUN_ID}@kinsen.gr`);
    const unrelatedUser = await makeUser(`unified-audience-unrelated-${RUN_ID}@kinsen.gr`);
    const deptAudienceMember = await makeUser(`unified-audience-deptmember-${RUN_ID}@kinsen.gr`);
    await addMembership(deptAudienceMember.id, audienceDept.id);

    // ══════════════════════ 1. Schema: audienceIds is a real field on createProjectSchema ══════════════════════
    console.log("\n=== 1. Schema shape ===\n");
    const { createProjectSchema } = await import("@/lib/validations");
    check("audienceIds is on createProjectSchema (manual creation), defaulting to []", "audienceIds" in createProjectSchema.shape && (createProjectSchema.safeParse({ title: "A valid title", departmentId: ownDept.id }) as any).data?.audienceIds?.length === 0);

    // ══════════════════════ 2. POST /api/projects validates + connects individual Audience ══════════════════════
    console.log("\n=== 2. Manual creation accepts and validates individual Audience ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const fakeAudienceRes = await projectsPOST(jsonReq({ title: `UnifiedAudience Fake ${RUN_ID}`, departmentId: ownDept.id, audienceIds: ["nonexistent-id"] }));
    check("A nonexistent audienceIds entry -> 400 invalid_audience", fakeAudienceRes.status === 400 && (await fakeAudienceRes.json()).code === "invalid_audience");

    const createRes = await projectsPOST(jsonReq({ title: `UnifiedAudience Manual Project ${RUN_ID}`, departmentId: ownDept.id, audienceIds: [audienceUser.id, audienceUser.id] }));
    check("Valid audienceIds on a MANUAL Project -> 201 (individual Audience no longer request-origin-only)", createRes.status === 201);
    const createBody = await createRes.json();
    const projectId: string = createBody.id;
    projectIds.push(projectId);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const getRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    const getBody = await getRes.json();
    check("GET reflects the connected individual Audience user", getBody.audience?.some((a: any) => a.id === audienceUser.id));
    check("...deduplicated (exactly one row, not two)", getBody.audience?.length === 1);

    // ══════════════════════ 3. Record-level visibility: a manual Project's individual Audience member CAN view ══════════════════════
    console.log("\n=== 3. Record-level: individual Audience grants view access to a MANUAL Project ===\n");
    const projectForAccessCheck = { id: projectId, departmentId: ownDept.id, projectRequestId: null as string | null };
    check("Individual Audience member CAN view (via hasProjectViewAccess) — the Phase 1.1 gap this task closes", await hasProjectViewAccess(audienceUser.id, Role.USER, null, projectForAccessCheck));
    check("An unrelated user still CANNOT view", !(await hasProjectViewAccess(unrelatedUser.id, Role.USER, null, projectForAccessCheck)));

    currentSession = { user: { id: audienceUser.id, role: Role.USER, customRoleId: null } };
    const audienceGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    check("...and really does, through the real GET route (not just the service function)", audienceGetRes.status === 200);

    // ══════════════════════ 4. Audience grants READ only — never mutation, even on a manual Project ══════════════════════
    console.log("\n=== 4. Individual Audience membership never grants edit/delete ===\n");
    const audiencePatchRes = await projectsPATCH(jsonReq({ title: "Hijacked" }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("Audience member's PATCH -> 403", audiencePatchRes.status === 403);
    const audienceDeleteRes = await projectsDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: projectId }) });
    check("Audience member's DELETE -> 403", audienceDeleteRes.status === 403);

    // ══════════════════════ 5. PATCH: independent omit-vs-replace, same convention as org audience ══════════════════════
    console.log("\n=== 5. PATCH audienceIds — independent per-field omit-vs-replace ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const secondAudienceUser = await makeUser(`unified-audience-second-${RUN_ID}@kinsen.gr`);
    const patchAddDeptRes = await projectsPATCH(jsonReq({ audienceDepartmentIds: [audienceDept.id] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH touching ONLY audienceDepartmentIds -> 200", patchAddDeptRes.status === 200);
    const patchAddDeptBody = await patchAddDeptRes.json();
    check("...audience (individual) is UNTOUCHED by a PATCH that omitted it", patchAddDeptBody.audience?.some((a: any) => a.id === audienceUser.id) && patchAddDeptBody.audience?.length === 1);

    const patchReplaceAudienceRes = await projectsPATCH(jsonReq({ audienceIds: [secondAudienceUser.id] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("A later PATCH with an explicit audienceIds array -> 200, REPLACES the full set", patchReplaceAudienceRes.status === 200);
    const patchReplaceAudienceBody = await patchReplaceAudienceRes.json();
    check("...only secondAudienceUser remains (the original audienceUser was replaced, not appended to)", patchReplaceAudienceBody.audience?.length === 1 && patchReplaceAudienceBody.audience[0].id === secondAudienceUser.id);
    check("...audienceDepartments (omitted from THIS PATCH) is still untouched from the previous step", patchReplaceAudienceBody.audienceDepartments?.some((d: any) => d.id === audienceDept.id));

    const patchFakeAudienceRes = await projectsPATCH(jsonReq({ audienceIds: ["nonexistent-id"] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH with a fake audienceIds entry -> 400 invalid_audience, nothing applied", patchFakeAudienceRes.status === 400 && (await patchFakeAudienceRes.json()).code === "invalid_audience");
    const afterFakePatch = await prisma.project.findUnique({ where: { id: projectId }, select: { audience: { select: { id: true } } } });
    check("...the rejected attempt did not partially apply (still just secondAudienceUser)", afterFakePatch?.audience.length === 1 && afterFakePatch.audience[0].id === secondAudienceUser.id);

    const patchClearRes = await projectsPATCH(jsonReq({ audienceIds: [] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("An explicit empty array clears individual Audience -> 200", patchClearRes.status === 200);
    const patchClearBody = await patchClearRes.json();
    check("...audience is now empty", patchClearBody.audience?.length === 0);

    // ══════════════════════ 6. Owner semantics are explicitly UNCHANGED ══════════════════════
    console.log("\n=== 6. Project Owner semantics are untouched — never extended to manual Projects ===\n");
    const ownerOnlyUser = await makeUser(`unified-audience-owneronly-${RUN_ID}@kinsen.gr`);
    // Directly attach ownerOnlyUser to `owners` at the DB level (bypassing
    // any route — there is still no UI/API path to do this for a manual
    // Project, by design) to prove the AUTHORIZATION side also still
    // refuses it, not merely that no UI offers it.
    await prisma.project.update({ where: { id: projectId }, data: { owners: { connect: [{ id: ownerOnlyUser.id }] } } });
    check(
      "A user manually added to `owners` on a MANUAL Project still CANNOT view — Owner-based visibility stays request-origin-only, unchanged by Phase 1.1",
      !(await hasProjectViewAccess(ownerOnlyUser.id, Role.USER, null, projectForAccessCheck))
    );

    // ══════════════════════ 7. List-level discoverability (buildProjectListWhere) ══════════════════════
    console.log("\n=== 7. Audience-derived visibility now reaches Project lists/search/Gantt (buildProjectListWhere) ===\n");
    // Re-grant individual Audience for this section (cleared in step 5).
    await prisma.project.update({ where: { id: projectId }, data: { audience: { connect: [{ id: audienceUser.id }] } } });

    const unscopedWhere = await buildProjectListWhere(audienceUser.id, Role.USER);
    check("Unscoped ('All Workspaces') list where is a real where, not a denial", !("denied" in unscopedWhere));
    const listMatches = "denied" in unscopedWhere ? [] : await prisma.project.findMany({ where: { AND: [unscopedWhere as any, { id: projectId }] } });
    check("...and the audience-only Project IS found by it — discoverable in list views, not only by direct URL", listMatches.length === 1);

    const unrelatedWhere = await buildProjectListWhere(unrelatedUser.id, Role.USER);
    const unrelatedMatches = "denied" in unrelatedWhere ? [] : await prisma.project.findMany({ where: { AND: [unrelatedWhere as any, { id: projectId }] } });
    check("...while an unrelated user's own unscoped list where does NOT match this Project", unrelatedMatches.length === 0);

    // Department-audience member reaches the list the same way (the
    // Business Unit roll-up path is already covered record-level in the
    // Phase 1 test; this just proves the SAME predicate also works from
    // the list side, which is this task's actual new requirement).
    await prisma.project.update({ where: { id: projectId }, data: { audienceDepartments: { connect: [{ id: audienceDept.id }] } } });
    const deptMemberWhere = await buildProjectListWhere(deptAudienceMember.id, Role.USER);
    const deptMemberMatches = "denied" in deptMemberWhere ? [] : await prisma.project.findMany({ where: { AND: [deptMemberWhere as any, { id: projectId }] } });
    check("Department-audience member also finds it via the SAME list-level predicate", deptMemberMatches.length === 1);

    // ══════════════════════ 8. "Audience must not grant general access to the owning Department" ══════════════════════
    console.log("\n=== 8. An explicit single-department filter the caller has no RBAC in stays denied ===\n");
    const explicitDeptFilterWhere = await buildProjectListWhere(audienceUser.id, Role.USER, ownDept.id);
    check("Filtering explicitly to the Project's OWNING department (no RBAC there) is still DENIED — Audience never unlocks browsing that Department", "denied" in explicitDeptFilterWhere);

    // A second, unrelated Project in the SAME owning department — proves
    // Audience access to ONE Project never leaks into seeing OTHERS in
    // that Department via the unscoped list either.
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const otherProjRes = await projectsPOST(jsonReq({ title: `UnifiedAudience Sibling ${RUN_ID}`, departmentId: ownDept.id }));
    const otherProjBody = await otherProjRes.json();
    projectIds.push(otherProjBody.id);
    const siblingMatches = "denied" in unscopedWhere ? [] : await prisma.project.findMany({ where: { AND: [(await buildProjectListWhere(audienceUser.id, Role.USER)) as any, { id: otherProjBody.id }] } });
    check("...and a SIBLING Project in the same Department (no Audience grant of its own) is correctly NOT visible", siblingMatches.length === 0);

    // ══════════════════════ 9. Dashboard counts/aggregations respect the same predicate ══════════════════════
    console.log("\n=== 9. Dashboard counters (aggregation, not per-record) include the audience-granted Project ===\n");
    const dashboardForAudienceUser = await getProjectsDashboardData(audienceUser.id, Role.USER, undefined);
    check("Dashboard data resolves (not denied) for the audience-only user", !("denied" in dashboardForAudienceUser));
    if (!("denied" in dashboardForAudienceUser)) {
      check("...totalProjects counts the audience-granted Project (>= 1)", dashboardForAudienceUser.totalProjects >= 1);
    }
    const dashboardForUnrelated = await getProjectsDashboardData(unrelatedUser.id, Role.USER, undefined);
    // unrelatedUser has literally zero Department access anywhere and no
    // Audience grants — buildEntityListWhere's own NO_MATCH_WHERE branch,
    // ORed with an audience predicate that also matches nothing, so this
    // must resolve to a real (empty-result) where, never `denied` (denied
    // is reserved for an invalid EXPLICIT department filter, never "no
    // access at all" — see buildEntityListWhere's own established shape).
    check("...and resolves to zero for a user with no access and no Audience anywhere", !("denied" in dashboardForUnrelated) && (dashboardForUnrelated as any).totalProjects === 0);

    // ══════════════════════ 10. Live membership change updates LIST visibility too, not just record-level ══════════════════════
    console.log("\n=== 10. A membership change updates LIST-level access live, without touching the Project ===\n");
    const freshUser = await makeUser(`unified-audience-fresh-${RUN_ID}@kinsen.gr`);
    const beforeJoinWhere = await buildProjectListWhere(freshUser.id, Role.USER);
    const beforeJoinMatches = "denied" in beforeJoinWhere ? [] : await prisma.project.findMany({ where: { AND: [beforeJoinWhere as any, { id: projectId }] } });
    check("Before joining audienceDept, freshUser's list where does not match", beforeJoinMatches.length === 0);
    const freshMembership = await addMembership(freshUser.id, audienceDept.id);
    const afterJoinWhere = await buildProjectListWhere(freshUser.id, Role.USER);
    const afterJoinMatches = "denied" in afterJoinWhere ? [] : await prisma.project.findMany({ where: { AND: [afterJoinWhere as any, { id: projectId }] } });
    check("Immediately after joining (no Project edit) — list where now matches", afterJoinMatches.length === 1);
    await prisma.departmentMembership.update({ where: { id: freshMembership.id }, data: { isActive: false } });
    const afterLeaveWhere = await buildProjectListWhere(freshUser.id, Role.USER);
    const afterLeaveMatches = "denied" in afterLeaveWhere ? [] : await prisma.project.findMany({ where: { AND: [afterLeaveWhere as any, { id: projectId }] } });
    check("Deactivating the membership immediately revokes list-level access too", afterLeaveMatches.length === 0);

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
