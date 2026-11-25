/**
 * Focused regression for the new Facilities Services Category/Cost fields
 * (facilitiesCategory, facilitiesEstimatedCost(+Notes), facilitiesActualCost
 * (+Notes)) added on top of the pre-existing Facilities Services Project
 * metadata feature. Covers: all 3 creation paths + edit, exact Decimal
 * storage (no floating-point drift), explicit null-clearing, cross-workspace
 * write rejection, and historical preservation when a Project moves out of
 * the Facilities Services department.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-facilities-cost-fields.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import ExcelJS from "exceljs";

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
const TAG = `pfc-${RUN_ID}`;
// Set BEFORE any import of project-facilities-service (directly or
// transitively via the route modules below) — that module reads this env
// var into a module-level const at first import, so it must be set first.
process.env.FACILITIES_SERVICES_DEPARTMENT_SLUG = `${TAG}-facilities-services`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;

// Unrelated pre-existing environmental friction (also reproduces on the
// pre-existing scripts/test-project-owner-invariant.ts, unmodified by this
// feature): some service import chain now pulls in lib/web-push.ts, whose
// `import "server-only"` throws when loaded under this CJS mock-module
// harness. Stubbed out here, scoped to this script only.
mock.module("server-only", { namedExports: {} });

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
  const { GET: getProject, PATCH: patchProjectRoute } = await import("@/app/api/projects/[id]/route");
  const { hasFacilitiesFieldsPresent } = await import("@/lib/services/project-facilities-service");
  const { createProjectFromApprovedRequest } = await import("@/lib/services/project-request-service");
  const { POST: postProjectFromRequest } = await import("@/app/api/project-requests/[id]/project/route");
  const { buildProjectsListWorkbook, buildProjectDetailWorkbook } = await import("@/lib/services/project-export-service");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const projectRequestIds: string[] = [];
  const taskTypeIds: string[] = [];
  const expenseTypeIds: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const facDept = await createDepartment({ name: `${TAG}-facilities-dept`, slug: `${TAG}-facilities-services` });
    departmentIds.push(facDept.id);
    const otherDept = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    departmentIds.push(otherDept.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 0. Unit: hasFacilitiesFieldsPresent recognizes the 5 new keys ──
    console.log("\n0. hasFacilitiesFieldsPresent recognizes the new keys ===\n");
    check("Category alone -> true", hasFacilitiesFieldsPresent({ facilitiesCategory: "Maintenance" }) === true);
    check("Estimated Cost alone -> true", hasFacilitiesFieldsPresent({ facilitiesEstimatedCost: 100 }) === true);
    check("Estimated Cost Notes alone -> true", hasFacilitiesFieldsPresent({ facilitiesEstimatedCostNotes: "note" }) === true);
    check("Actual Cost alone -> true", hasFacilitiesFieldsPresent({ facilitiesActualCost: 100 }) === true);
    check("Actual Cost Notes alone -> true", hasFacilitiesFieldsPresent({ facilitiesActualCostNotes: "note" }) === true);
    check("Explicit null still counts as present", hasFacilitiesFieldsPresent({ facilitiesCategory: null }) === true);
    check("None of the keys -> false", hasFacilitiesFieldsPresent({ title: "x" }) === false);

    // ── 1. POST /api/projects in Facilities Services workspace -> exact
    //       Decimal persisted, no float drift ──
    console.log("\n1. POST /api/projects (Facilities Services) persists Category/Costs with exact Decimal precision ===\n");
    const createRes = await postProjects(
      jsonReq("http://localhost/api/projects", {
        title: `${TAG} Facilities Project`,
        departmentId: facDept.id,
        memberIds: [],
        facilitiesCategory: "Maintenance",
        facilitiesEstimatedCost: 1234.56,
        facilitiesEstimatedCostNotes: "Initial quote",
        facilitiesActualCost: 999.9,
        facilitiesActualCostNotes: "Final invoice",
      })
    );
    check("POST -> 201", createRes.status === 201, `got ${createRes.status}: ${await createRes.clone().text()}`);
    const created = await createRes.json();
    projectIds.push(created.id);

    const afterCreate = await prisma.project.findUnique({ where: { id: created.id } });
    check("facilitiesCategory persisted", afterCreate?.facilitiesCategory === "Maintenance");
    check(
      "facilitiesEstimatedCost persisted as EXACT Decimal (1234.56, no float drift)",
      afterCreate?.facilitiesEstimatedCost?.toString() === "1234.56"
    );
    check("facilitiesEstimatedCostNotes persisted", afterCreate?.facilitiesEstimatedCostNotes === "Initial quote");
    check("facilitiesActualCost persisted as EXACT Decimal (999.9)", afterCreate?.facilitiesActualCost?.toString() === "999.9");
    check("facilitiesActualCostNotes persisted", afterCreate?.facilitiesActualCostNotes === "Final invoice");

    // ── 2. POST to a NON-Facilities department with cost fields present ->
    //       rejected outright (cross-workspace write prevention) ──
    console.log("\n2. POST /api/projects (non-Facilities) with cost fields present -> 400 facilities_fields_not_allowed ===\n");
    const rejectedCreateRes = await postProjects(
      jsonReq("http://localhost/api/projects", {
        title: `${TAG} Should Be Rejected`,
        departmentId: otherDept.id,
        memberIds: [],
        facilitiesEstimatedCost: 50,
      })
    );
    const rejectedBody = await rejectedCreateRes.json();
    check(
      "Rejected with facilities_fields_not_allowed",
      rejectedCreateRes.status === 400 && rejectedBody.code === "facilities_fields_not_allowed",
      `got ${rejectedCreateRes.status}: ${JSON.stringify(rejectedBody)}`
    );

    // ── 3. PATCH: update Estimated Cost to a new exact value ──
    console.log("\n3. PATCH updates facilitiesEstimatedCost to a new exact value ===\n");
    const updateRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${created.id}`, { facilitiesEstimatedCost: 2500.01 }, "PATCH"),
      { params: Promise.resolve({ id: created.id }) }
    );
    check("PATCH -> 200", updateRes.status === 200, `got ${updateRes.status}: ${await updateRes.clone().text()}`);
    const afterUpdate = await prisma.project.findUnique({ where: { id: created.id } });
    check("facilitiesEstimatedCost updated exactly to 2500.01", afterUpdate?.facilitiesEstimatedCost?.toString() === "2500.01");
    check("facilitiesActualCost untouched by an unrelated-field PATCH", afterUpdate?.facilitiesActualCost?.toString() === "999.9");

    // ── 4. PATCH: explicit null clears Estimated Cost + its Notes ──
    console.log("\n4. PATCH with explicit null clears facilitiesEstimatedCost/Notes ===\n");
    const clearRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${created.id}`, { facilitiesEstimatedCost: null, facilitiesEstimatedCostNotes: null }, "PATCH"),
      { params: Promise.resolve({ id: created.id }) }
    );
    check("PATCH (clear) -> 200", clearRes.status === 200);
    const afterClear = await prisma.project.findUnique({ where: { id: created.id } });
    check("facilitiesEstimatedCost cleared to null", afterClear?.facilitiesEstimatedCost === null);
    check("facilitiesEstimatedCostNotes cleared to null", afterClear?.facilitiesEstimatedCostNotes === null);
    check("facilitiesActualCost still untouched", afterClear?.facilitiesActualCost?.toString() === "999.9");
    check("facilitiesCategory still untouched", afterClear?.facilitiesCategory === "Maintenance");

    // ── 5. GET reflects isFacilitiesServicesWorkspace=true while inside ──
    console.log("\n5. GET /api/projects/[id] reports isFacilitiesServicesWorkspace=true while inside the workspace ===\n");
    const getInsideRes = await getProject(new NextRequest(`http://localhost/api/projects/${created.id}`), {
      params: Promise.resolve({ id: created.id }),
    });
    const getInsideBody = await getInsideRes.json();
    check("isFacilitiesServicesWorkspace true", getInsideBody.isFacilitiesServicesWorkspace === true);
    check("facilitiesActualCost visible (as a string, exact)", getInsideBody.facilitiesActualCost === "999.9");

    // ── 6. Moving the Project OUT of Facilities Services preserves its
    //       cost data in the DB (never cleared) ──
    console.log("\n6. Moving the Project to another department preserves Facilities cost history ===\n");
    const moveRes = await patchProjectRoute(jsonReq(`http://localhost/api/projects/${created.id}`, { departmentId: otherDept.id }, "PATCH"), {
      params: Promise.resolve({ id: created.id }),
    });
    check("PATCH (department move) -> 200", moveRes.status === 200, `got ${moveRes.status}: ${await moveRes.clone().text()}`);
    const afterMove = await prisma.project.findUnique({ where: { id: created.id } });
    check("facilitiesActualCost PRESERVED in the DB after leaving the workspace", afterMove?.facilitiesActualCost?.toString() === "999.9");
    check("facilitiesCategory PRESERVED in the DB after leaving the workspace", afterMove?.facilitiesCategory === "Maintenance");

    const getOutsideRes = await getProject(new NextRequest(`http://localhost/api/projects/${created.id}`), {
      params: Promise.resolve({ id: created.id }),
    });
    const getOutsideBody = await getOutsideRes.json();
    check("isFacilitiesServicesWorkspace now false", getOutsideBody.isFacilitiesServicesWorkspace === false);

    // ── 7. Write-protection: attempting to set a Facilities cost field now
    //       (outside the workspace) is rejected outright ──
    console.log("\n7. Attempting to write a Facilities cost field outside the workspace -> rejected ===\n");
    const blockedWriteRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${created.id}`, { facilitiesActualCost: 1 }, "PATCH"),
      { params: Promise.resolve({ id: created.id }) }
    );
    const blockedWriteBody = await blockedWriteRes.json();
    check(
      "Rejected with facilities_fields_not_allowed",
      blockedWriteRes.status === 400 && blockedWriteBody.code === "facilities_fields_not_allowed"
    );
    const afterBlockedWrite = await prisma.project.findUnique({ where: { id: created.id } });
    check("facilitiesActualCost still unchanged (999.9, never overwritten)", afterBlockedWrite?.facilitiesActualCost?.toString() === "999.9");

    // ── 8. Request-origin creation path (createProjectFromApprovedRequest)
    //       also persists Category/Costs with exact precision ──
    console.log("\n8. Request-origin creation persists Category/Costs ===\n");
    const taskType = await prisma.taskType.create({ data: { name: `${TAG}-type` } });
    taskTypeIds.push(taskType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expense-type` } });
    expenseTypeIds.push(expenseType.id);

    const projReq = await prisma.projectRequest.create({
      data: {
        title: `${TAG} request`,
        description: "desc",
        importance: 2,
        projectTypeId: taskType.id,
        teamConcerned: "team",
        expectedBenefits: "benefits",
        requesterId: admin.id,
        departmentId: facDept.id,
        status: "APPROVED",
        approverId: admin.id,
      },
    });
    projectRequestIds.push(projReq.id);

    const requestOriginResult = await createProjectFromApprovedRequest(projReq.id, admin.id, Role.ADMIN, null, {
      title: `${TAG} Request-Origin Facilities Project`,
      description: undefined,
      status: "PLANNING" as any,
      priority: 2,
      subDepartmentId: undefined,
      businessUnitId: undefined,
      startDate: undefined,
      endDate: undefined,
      successTarget: undefined,
      memberIds: [],
      isGoal: false,
      ownerIds: [admin.id],
      audienceIds: [],
      expectedStartDate: new Date().toISOString(),
      expectedFinishDate: new Date(Date.now() + 86400000 * 30).toISOString(),
      expenseTypeId: expenseType.id,
      external: false,
      facilitiesCategory: "Renovation",
      facilitiesEstimatedCost: 4321.09,
      facilitiesEstimatedCostNotes: "Request-origin estimate",
      facilitiesActualCost: null,
      facilitiesActualCostNotes: null,
    } as any);
    check("createProjectFromApprovedRequest ok", requestOriginResult.ok === true, JSON.stringify(requestOriginResult));
    if (requestOriginResult.ok) {
      projectIds.push(requestOriginResult.projectId);
      const requestOriginProject = await prisma.project.findUnique({ where: { id: requestOriginResult.projectId } });
      check("facilitiesCategory persisted", requestOriginProject?.facilitiesCategory === "Renovation");
      check(
        "facilitiesEstimatedCost persisted as EXACT Decimal (4321.09)",
        requestOriginProject?.facilitiesEstimatedCost?.toString() === "4321.09"
      );
      check("facilitiesEstimatedCostNotes persisted", requestOriginProject?.facilitiesEstimatedCostNotes === "Request-origin estimate");
      check("facilitiesActualCost left null (never sent)", requestOriginProject?.facilitiesActualCost === null);
    }

    // ── 9. The actual HTTP wrapper route (POST
    //       /api/project-requests/[id]/project) accepts the 5 new keys too
    //       — confirms createProjectFromRequestSchema.and(facilitiesProjectFieldsSchema)
    //       (a ZodIntersection) doesn't drop them ──
    console.log("\n9. POST /api/project-requests/[id]/project (HTTP wrapper) persists Category/Costs ===\n");
    const projReq2 = await prisma.projectRequest.create({
      data: {
        title: `${TAG} request 2`,
        description: "desc",
        importance: 2,
        projectTypeId: taskType.id,
        teamConcerned: "team",
        expectedBenefits: "benefits",
        requesterId: admin.id,
        departmentId: facDept.id,
        status: "APPROVED",
        approverId: admin.id,
      },
    });
    projectRequestIds.push(projReq2.id);
    const httpWrapperRes = await postProjectFromRequest(
      jsonReq(`http://localhost/api/project-requests/${projReq2.id}/project`, {
        title: `${TAG} HTTP Wrapper Facilities Project`,
        memberIds: [],
        isGoal: false,
        ownerIds: [admin.id],
        audienceIds: [],
        expectedStartDate: new Date().toISOString(),
        expectedFinishDate: new Date(Date.now() + 86400000 * 30).toISOString(),
        expenseTypeId: expenseType.id,
        external: false,
        facilitiesCategory: "Inspection",
        facilitiesEstimatedCost: 777.77,
        facilitiesEstimatedCostNotes: "Via HTTP wrapper",
      }),
      { params: Promise.resolve({ id: projReq2.id }) }
    );
    const httpWrapperBody = await httpWrapperRes.json();
    check("HTTP wrapper -> 2xx", httpWrapperRes.status >= 200 && httpWrapperRes.status < 300, `got ${httpWrapperRes.status}: ${JSON.stringify(httpWrapperBody)}`);
    if (httpWrapperBody.id) {
      projectIds.push(httpWrapperBody.id);
      const httpWrapperProject = await prisma.project.findUnique({ where: { id: httpWrapperBody.id } });
      check("facilitiesCategory persisted via HTTP wrapper", httpWrapperProject?.facilitiesCategory === "Inspection");
      check(
        "facilitiesEstimatedCost persisted via HTTP wrapper as EXACT Decimal (777.77)",
        httpWrapperProject?.facilitiesEstimatedCost?.toString() === "777.77"
      );
    }

    // ── 10. Excel exports include Category/both Costs/both Notes ──
    console.log("\n10. Excel exports (list + detail) include Category/Costs/Notes ===\n");
    const listWorkbookBuffer = await buildProjectsListWorkbook([
      {
        title: "Export Row",
        description: null,
        status: "PLANNING",
        priority: 2,
        origin: "Manual",
        departmentName: facDept.name,
        owners: [],
        members: [],
        activitiesCount: 0,
        progress: 0,
        overdue: false,
        expectedStartDate: null,
        expectedFinishDate: null,
        startDate: null,
        endDate: null,
        createdAt: new Date(),
        facilitiesCompany: null,
        facilitiesLocation: null,
        facilitiesStartQuarter: null,
        facilitiesStartYear: null,
        facilitiesEndQuarter: null,
        facilitiesEndYear: null,
        facilitiesCategory: "Export Category",
        facilitiesEstimatedCost: 150.25,
        facilitiesEstimatedCostNotes: "Export estimate note",
        facilitiesActualCost: 160.5,
        facilitiesActualCostNotes: "Export actual note",
        isFacilitiesServicesWorkspace: true,
        facilitiesPlannedForAnnualTargets: true,
        facilitiesIsBigProject: false,
        facilitiesProjectImportanceOverall: null,
        facilitiesProjectScore: null,
        facilitiesImportanceScoreLabel: null,
        facilitiesScoreLabel: null,
      },
    ]);
    const listWb = new ExcelJS.Workbook();
    await listWb.xlsx.load(listWorkbookBuffer as any);
    const listSheet = listWb.getWorksheet("Projects")!;
    const listHeaderRow = listSheet.getRow(1).values as unknown[];
    const listDataRow = listSheet.getRow(2).values as unknown[];
    const listHeaders = listHeaderRow.map((v) => (typeof v === "string" ? v : null));
    const getListCell = (header: string) => listDataRow[listHeaders.indexOf(header)];
    check("List export has a Category column with the right value", getListCell("Category") === "Export Category");
    check("List export Estimated Cost column value", Number(getListCell("Estimated Cost (EUR)")) === 150.25);
    check("List export Estimated Cost Notes column value", getListCell("Estimated Cost Notes") === "Export estimate note");
    check("List export Actual Cost column value", Number(getListCell("Actual Cost (EUR)")) === 160.5);
    check("List export Actual Cost Notes column value", getListCell("Actual Cost Notes") === "Export actual note");
    check("List export shows Yes for Planned for Annual Targets", getListCell("Planned for This Year's Targets") === "Yes");
    check("List export shows No for Big Project", getListCell("Big Project") === "No");

    const detailWorkbookBuffer = await buildProjectDetailWorkbook({
      title: "Detail Export",
      description: null,
      status: "PLANNING",
      priority: 2,
      origin: "Manual",
      projectRequestTitle: null,
      departmentName: facDept.name,
      businessUnitName: null,
      owners: [],
      audience: [],
      members: [],
      expectedStartDate: null,
      expectedFinishDate: null,
      expectedTotalInitialDays: null,
      actualTotalDays: null,
      startDate: null,
      endDate: null,
      progress: 0,
      createdAt: new Date(),
      facilitiesCompany: null,
      facilitiesLocation: null,
      facilitiesStartQuarter: null,
      facilitiesStartYear: null,
      facilitiesEndQuarter: null,
      facilitiesEndYear: null,
      facilitiesCategory: "Detail Category",
      facilitiesEstimatedCost: 300.1,
      facilitiesEstimatedCostNotes: "Detail estimate note",
      facilitiesActualCost: 310.2,
      facilitiesActualCostNotes: "Detail actual note",
      isFacilitiesServicesWorkspace: true,
      facilitiesPlannedForAnnualTargets: true,
      facilitiesIsBigProject: true,
      facilitiesProjectImportanceOverall: null,
      facilitiesProjectScore: null,
      facilitiesImportanceScoreLabel: null,
      facilitiesScoreLabel: null,
      activities: [],
    });
    const detailWb = new ExcelJS.Workbook();
    await detailWb.xlsx.load(detailWorkbookBuffer as any);
    const detailsSheet = detailWb.getWorksheet("Project Details")!;
    const detailKeyValue: Record<string, unknown> = {};
    detailsSheet.eachRow((row) => {
      const key = row.getCell(1).value;
      if (typeof key === "string") detailKeyValue[key] = row.getCell(2).value;
    });
    check("Detail export has Category row", detailKeyValue["Category"] === "Detail Category");
    check("Detail export has Facilities Estimated Cost row", Number(detailKeyValue["Facilities Estimated Cost"]) === 300.1);
    check("Detail export has Facilities Estimated Cost Notes row", detailKeyValue["Facilities Estimated Cost Notes"] === "Detail estimate note");
    check("Detail export has Facilities Actual Cost row", Number(detailKeyValue["Facilities Actual Cost"]) === 310.2);
    check("Detail export has Facilities Actual Cost Notes row", detailKeyValue["Facilities Actual Cost Notes"] === "Detail actual note");
    check("Detail export shows Yes for Planned for Annual Targets", detailKeyValue["Planned for This Year's Targets"] === "Yes");
    check("Detail export shows Yes for Big Project", detailKeyValue["Big Project"] === "Yes");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { id: { in: expenseTypeIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: taskTypeIds } } });
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
