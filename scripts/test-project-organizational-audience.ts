/**
 * Phase 1 — Project Audience Architecture Extension: regression coverage
 * for the NEW Organizational Audience (Department/Business Unit) layer
 * added alongside the pre-existing, UNCHANGED individual-user Audience.
 *
 * Exercises the acceptance checks from the feature spec:
 *   1. Existing individual audiences remain unchanged.
 *   2. Department and Business Unit audiences provide correct dynamic
 *      visibility.
 *   3. Combined audiences work without duplicate effective memberships.
 *   4. Organizational membership changes correctly grant/revoke
 *      audience-derived access (no Project edit required).
 *   5. Unauthorized users cannot access Projects through direct APIs.
 *   6. Audience membership does not grant unintended mutation permissions.
 *   7. Both creation paths (manual POST /api/projects and request-origin
 *      POST /api/project-requests/[id]/project) accept and validate the
 *      new fields; PATCH supports independent per-field omit/replace.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-organizational-audience.ts
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
  const { normalizeCompanyName } = await import("@/lib/services/organization-normalization");
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");
  const projectsPOST = (await import("@/app/api/projects/route")).POST;
  const projectsGET = (await import("@/app/api/projects/[id]/route")).GET;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const projectsDELETE = (await import("@/app/api/projects/[id]/route")).DELETE;

  const deptIds: string[] = [];
  const buIds: string[] = [];
  const companyIds: string[] = [];
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
    const company = await prisma.company.create({
      data: { name: `OrgAudience Co ${RUN_ID}`, domain: `orgaudience-${RUN_ID}.example`, normalizedName: normalizeCompanyName(`OrgAudience Co ${RUN_ID}`) },
    });
    companyIds.push(company.id);
    const businessUnit = await prisma.businessUnit.create({ data: { name: `OrgAudience BU ${RUN_ID}`, companyId: company.id } });
    buIds.push(businessUnit.id);
    const otherBusinessUnit = await prisma.businessUnit.create({ data: { name: `OrgAudience Other BU ${RUN_ID}`, companyId: company.id } });
    buIds.push(otherBusinessUnit.id);

    // Project's own OWNING department — deliberately gives NOBODY in this
    // test project.view here, so any visibility proven below is coming
    // from the Organizational Audience path, never this baseline grant.
    const ownDept = await createDepartment({ name: `OrgAudience Own Dept ${RUN_ID}`, slug: `orgaudience-own-${RUN_ID}` });
    deptIds.push(ownDept.id);

    // Audience Department (bare, no Business Unit) and a Department that
    // belongs to a Business Unit (for the hierarchy roll-up check).
    const audienceDept = await createDepartment({ name: `OrgAudience Audience Dept ${RUN_ID}`, slug: `orgaudience-audience-dept-${RUN_ID}` });
    deptIds.push(audienceDept.id);
    const buChildDept = await createDepartment({ name: `OrgAudience BU Child Dept ${RUN_ID}`, slug: `orgaudience-bu-child-${RUN_ID}`, businessUnitId: businessUnit.id });
    deptIds.push(buChildDept.id);
    const inactiveDept = await createDepartment({ name: `OrgAudience Inactive Dept ${RUN_ID}`, slug: `orgaudience-inactive-${RUN_ID}` });
    deptIds.push(inactiveDept.id);
    await prisma.department.update({ where: { id: inactiveDept.id }, data: { isActive: false } });

    const deptMember = await makeUser(`orgaudience-deptmember-${RUN_ID}@kinsen.gr`);
    await addMembership(deptMember.id, audienceDept.id);
    const buMember = await makeUser(`orgaudience-bumember-${RUN_ID}@kinsen.gr`);
    await addMembership(buMember.id, buChildDept.id);
    const unrelatedUser = await makeUser(`orgaudience-unrelated-${RUN_ID}@kinsen.gr`);
    const owner = await makeUser(`orgaudience-owner-${RUN_ID}@kinsen.gr`);

    // ══════════════════════ 1. createProjectSchema has the two new, optional, defaulted fields ══════════════════════
    console.log("\n=== 1. Schema shape ===\n");
    const { createProjectSchema } = await import("@/lib/validations");
    check("audienceDepartmentIds/audienceBusinessUnitIds are on createProjectSchema", "audienceDepartmentIds" in createProjectSchema.shape && "audienceBusinessUnitIds" in createProjectSchema.shape);
    check("...and default to [] when omitted", (createProjectSchema.safeParse({ title: "A valid title", departmentId: ownDept.id }) as any).data?.audienceDepartmentIds?.length === 0);

    // ══════════════════════ 2. Manual creation: validation rejects fake/inactive ids ══════════════════════
    console.log("\n=== 2. POST /api/projects validates Organizational Audience ids ===\n");
    currentSession = { user: { id: owner.id, role: Role.ADMIN, customRoleId: null } };
    const fakeDeptRes = await projectsPOST(jsonReq({ title: `OrgAudience Fake Dept ${RUN_ID}`, departmentId: ownDept.id, audienceDepartmentIds: ["nonexistent-id"] }));
    check("A nonexistent audienceDepartmentIds entry -> 400 invalid_audience_department", fakeDeptRes.status === 400 && (await fakeDeptRes.json()).code === "invalid_audience_department");

    const inactiveDeptRes = await projectsPOST(jsonReq({ title: `OrgAudience Inactive Dept ${RUN_ID}`, departmentId: ownDept.id, audienceDepartmentIds: [inactiveDept.id] }));
    check("An INACTIVE department in audienceDepartmentIds -> rejected (same code)", inactiveDeptRes.status === 400 && (await inactiveDeptRes.json()).code === "invalid_audience_department");

    const fakeBuRes = await projectsPOST(jsonReq({ title: `OrgAudience Fake BU ${RUN_ID}`, departmentId: ownDept.id, audienceBusinessUnitIds: ["nonexistent-id"] }));
    check("A nonexistent audienceBusinessUnitIds entry -> 400 invalid_audience_business_unit", fakeBuRes.status === 400 && (await fakeBuRes.json()).code === "invalid_audience_business_unit");

    // ══════════════════════ 3. Valid manual creation — combined Department + Business Unit audience ══════════════════════
    console.log("\n=== 3. Valid combined Organizational Audience on creation ===\n");
    const createRes = await projectsPOST(
      jsonReq({
        title: `OrgAudience Project ${RUN_ID}`,
        departmentId: ownDept.id,
        ownerIds: [owner.id],
        audienceDepartmentIds: [audienceDept.id, audienceDept.id], // duplicate on purpose — must dedupe
        audienceBusinessUnitIds: [businessUnit.id],
      })
    );
    check("Valid combined payload -> 201", createRes.status === 201);
    const createBody = await createRes.json();
    const projectId: string = createBody.id;
    projectIds.push(projectId);

    const getRes1 = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    const getBody1 = await getRes1.json();
    check("GET reflects BOTH audienceDepartments and audienceBusinessUnits", getBody1.audienceDepartments?.some((d: any) => d.id === audienceDept.id) && getBody1.audienceBusinessUnits?.some((b: any) => b.id === businessUnit.id));
    check("...the duplicated department id was deduplicated (exactly one row, not two)", getBody1.audienceDepartments?.length === 1);

    // ══════════════════════ 4/5. Dynamic visibility: Department member sees it, unrelated user does not ══════════════════════
    console.log("\n=== 4/5. Dynamic visibility via hasProjectViewAccess ===\n");
    const projectForAccessCheck = { id: projectId, departmentId: ownDept.id, projectRequestId: null as string | null };
    check("Department-audience member CAN view (via hasProjectViewAccess)", await hasProjectViewAccess(deptMember.id, Role.USER, null, projectForAccessCheck));
    check("Business-Unit-audience member (via the child Department roll-up) CAN view", await hasProjectViewAccess(buMember.id, Role.USER, null, projectForAccessCheck));
    check("An unrelated user with NO membership anywhere relevant CANNOT view", !(await hasProjectViewAccess(unrelatedUser.id, Role.USER, null, projectForAccessCheck)));

    console.log("\n=== 5. Unauthorized users denied via the real GET route (direct API access) ===\n");
    currentSession = { user: { id: unrelatedUser.id, role: Role.USER, customRoleId: null } };
    const unrelatedGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    check("Unrelated user's GET -> 403/404 (never 200)", unrelatedGetRes.status !== 200);

    currentSession = { user: { id: deptMember.id, role: Role.USER, customRoleId: null } };
    const deptMemberGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: projectId }) });
    check("Department-audience member's GET -> 200 (read access really extends through the real route, not just the service function)", deptMemberGetRes.status === 200);

    // ══════════════════════ 6. Audience membership never grants mutation permissions ══════════════════════
    console.log("\n=== 6. Organizational Audience membership grants READ only — never edit/delete ===\n");
    currentSession = { user: { id: deptMember.id, role: Role.USER, customRoleId: null } };
    const audiencePatchRes = await projectsPATCH(jsonReq({ title: "Hijacked title" }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("Department-audience member's PATCH -> 403 (read access never implies project.edit)", audiencePatchRes.status === 403);
    const audienceDeleteRes = await projectsDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: projectId }) });
    check("Department-audience member's DELETE -> 403 (read access never implies project.delete)", audienceDeleteRes.status === 403);
    const stillThere = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
    check("...and the Project is untouched by both forbidden attempts", stillThere?.title === `OrgAudience Project ${RUN_ID}`);

    // ══════════════════════ 3 (dedup across combined paths) / No duplicate effective membership ══════════════════════
    console.log("\n=== 3. A user in BOTH the audience Department AND (via a second membership) the audience Business Unit's child Department sees no duplicated anything ===\n");
    // deptMember joins buChildDept too — still just ONE boolean "can view", never a double-grant artifact.
    await addMembership(deptMember.id, buChildDept.id);
    check("Still simply true — no duplicate-membership error/throw", await hasProjectViewAccess(deptMember.id, Role.USER, null, projectForAccessCheck));

    // ══════════════════════ 4. Membership changes update effective access live, without touching the Project ══════════════════════
    console.log("\n=== 4. Live membership changes grant/revoke access without editing the Project ===\n");
    const freshUser = await makeUser(`orgaudience-fresh-${RUN_ID}@kinsen.gr`);
    check("Before joining the audience Department, freshUser cannot view", !(await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck)));
    const freshMembership = await addMembership(freshUser.id, audienceDept.id);
    check("Immediately after joining — WITHOUT any Project edit — freshUser can now view", await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck));
    await prisma.departmentMembership.update({ where: { id: freshMembership.id }, data: { isActive: false } });
    check("Deactivating that same membership immediately revokes access again — no Project edit involved", !(await hasProjectViewAccess(freshUser.id, Role.USER, null, projectForAccessCheck)));

    // ══════════════════════ PATCH: independent per-field omit/replace semantics ══════════════════════
    console.log("\n=== PATCH independent per-field omit-vs-replace semantics ===\n");
    currentSession = { user: { id: owner.id, role: Role.ADMIN, customRoleId: null } };
    const patchOnlyBuRes = await projectsPATCH(jsonReq({ audienceBusinessUnitIds: [] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH with ONLY audienceBusinessUnitIds supplied (empty) -> 200", patchOnlyBuRes.status === 200);
    const patchOnlyBuBody = await patchOnlyBuRes.json();
    check("...audienceBusinessUnits cleared to empty (explicit array replaces)", patchOnlyBuBody.audienceBusinessUnits?.length === 0);
    check("...while audienceDepartments (OMITTED from this PATCH) is completely UNTOUCHED, still containing audienceDept — the bug this feature's own implementation caught and fixed before shipping", patchOnlyBuBody.audienceDepartments?.some((d: any) => d.id === audienceDept.id) && patchOnlyBuBody.audienceDepartments?.length === 1);

    const patchOnlyDeptRes = await projectsPATCH(jsonReq({ audienceDepartmentIds: [] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("A later PATCH with ONLY audienceDepartmentIds supplied (empty) -> 200", patchOnlyDeptRes.status === 200);
    const patchOnlyDeptBody = await patchOnlyDeptRes.json();
    check("...audienceDepartments now cleared too", patchOnlyDeptBody.audienceDepartments?.length === 0);
    check("...and after THIS clearing, deptMember (whose access came from that Department) is denied again — proving the view check is live-resolved, never cached off the old set", !(await hasProjectViewAccess(deptMember.id, Role.USER, null, projectForAccessCheck)));

    const patchBothRes = await projectsPATCH(
      jsonReq({ audienceDepartmentIds: [audienceDept.id], audienceBusinessUnitIds: [businessUnit.id, otherBusinessUnit.id] }, "PATCH"),
      { params: Promise.resolve({ id: projectId }) }
    );
    check("PATCH supplying BOTH fields together -> 200, both replaced in the same call", patchBothRes.status === 200);
    const patchBothBody = await patchBothRes.json();
    check("...audienceDepartments restored", patchBothBody.audienceDepartments?.length === 1);
    check("...audienceBusinessUnits now has both", patchBothBody.audienceBusinessUnits?.length === 2);

    const patchNeitherRes = await projectsPATCH(jsonReq({ title: `OrgAudience Project ${RUN_ID} Renamed` }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH touching neither audience field (just title) -> 200, both audience sets left exactly as they were", patchNeitherRes.status === 200);
    const patchNeitherBody = await patchNeitherRes.json();
    check("...audienceDepartments still 1, audienceBusinessUnits still 2 — an unrelated PATCH never silently clears either", patchNeitherBody.audienceDepartments?.length === 1 && patchNeitherBody.audienceBusinessUnits?.length === 2);

    // ══════════════════════ PATCH validation re-checked the same way as creation ══════════════════════
    const patchFakeRes = await projectsPATCH(jsonReq({ audienceDepartmentIds: ["nonexistent-id"] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("PATCH with a fake audienceDepartmentIds entry -> 400 invalid_audience_department, nothing applied", patchFakeRes.status === 400 && (await patchFakeRes.json()).code === "invalid_audience_department");
    const afterFakePatch = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
    check("...and the rejected attempt did not partially apply (title from the successful PATCH right before it is still there)", afterFakePatch?.title === `OrgAudience Project ${RUN_ID} Renamed`);

    // ══════════════════════ Individual Audience coexists cleanly with Organizational Audience ══════════════════════
    // NOTE: as of Phase 1.1, individual Audience (Project.audience) is no
    // longer request-origin-only — it's now available on every Project,
    // same as Organizational Audience always was. That removal, plus its
    // own full record-level/list-level visibility and PATCH omit-vs-
    // replace coverage, lives in
    // scripts/test-project-audience-unified-visibility.ts, not here; this
    // file stays Phase 1's own (still entirely valid) Organizational
    // Audience coverage. This spot-check only confirms the two Audience
    // kinds don't interfere with each other on the SAME manual Project.
    console.log("\n=== Individual Audience (Phase 1.1) coexists with Organizational Audience on the same manual Project ===\n");
    const individualAudienceUser = await makeUser(`orgaudience-individual-${RUN_ID}@kinsen.gr`);
    check("createProjectSchema now has an audienceIds field too (Phase 1.1 — individual Audience, universal like the organizational ones)", "audienceIds" in createProjectSchema.shape);
    const individualOnThisProjectRes = await projectsPATCH(jsonReq({ audienceIds: [individualAudienceUser.id] }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
    check("Adding an individual Audience user to this already-Organizational-Audience-bearing manual Project -> 200", individualOnThisProjectRes.status === 200);
    const individualOnThisProjectBody = await individualOnThisProjectRes.json();
    check(
      "...individual Audience is set AND the existing Organizational Audience (Department/Business Unit, from earlier PATCHes above) is untouched",
      individualOnThisProjectBody.audience?.some((a: any) => a.id === individualAudienceUser.id) &&
        individualOnThisProjectBody.audienceDepartments?.length === 1 &&
        individualOnThisProjectBody.audienceBusinessUnits?.length === 2
    );

    // ══════════════════════ GET /api/departments and /api/business-units picker endpoints ══════════════════════
    console.log("\n=== Picker endpoints used by the UI ===\n");
    currentSession = { user: { id: owner.id, role: Role.USER, customRoleId: null } };
    const departmentsListRes = (await import("@/app/api/departments/route")).GET;
    const deptListRes = await departmentsListRes();
    const deptList = await deptListRes.json();
    check("GET /api/departments includes the active audience Department", deptList.some((d: any) => d.id === audienceDept.id));
    check("...and EXCLUDES the inactive one", !deptList.some((d: any) => d.id === inactiveDept.id));

    const businessUnitsListRes = (await import("@/app/api/business-units/route")).GET;
    const buListRes = await businessUnitsListRes();
    const buList = await buListRes.json();
    check("GET /api/business-units includes both Business Units (no isActive column to filter on)", buList.some((b: any) => b.id === businessUnit.id) && buList.some((b: any) => b.id === otherBusinessUnit.id));

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
      ["delete business units", async () => prisma.businessUnit.deleteMany({ where: { id: { in: buIds } } })],
      ["delete companies", async () => prisma.company.deleteMany({ where: { id: { in: companyIds } } })],
      ["disconnect", async () => prisma.$disconnect()],
    ]);
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Unhandled error in test run:", err);
  process.exit(1);
});
