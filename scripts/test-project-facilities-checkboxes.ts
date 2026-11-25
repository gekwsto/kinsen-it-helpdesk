/**
 * Focused regression for the two new independent Facilities Services
 * checkboxes (facilitiesPlannedForAnnualTargets, facilitiesIsBigProject) —
 * manually-maintained Boolean classification flags, @default(false),
 * completely unrelated to each other and to the existing Facilities
 * Company/Location/Category/Cost fields. Covers: all 4 Boolean
 * combinations, independent updates (including explicit true -> false),
 * cross-workspace write rejection, historical preservation after a
 * department move, request-origin creation, both Excel exports, and that
 * the pre-existing Facilities fields are completely unaffected.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-facilities-checkboxes.ts
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
const TAG = `pfcb-${RUN_ID}`;
process.env.FACILITIES_SERVICES_DEPARTMENT_SLUG = `${TAG}-facilities-services`;

mock.module("server-only", { namedExports: {} });

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
  const { GET: getProject, PATCH: patchProjectRoute } = await import("@/app/api/projects/[id]/route");
  const { hasFacilitiesFieldsPresent } = await import("@/lib/services/project-facilities-service");
  const { createProjectFromApprovedRequest } = await import("@/lib/services/project-request-service");
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

    // ── 0. Unit: hasFacilitiesFieldsPresent recognizes the 2 new keys ──
    console.log("\n0. hasFacilitiesFieldsPresent recognizes the new keys ===\n");
    check("Planned-for-targets alone -> true", hasFacilitiesFieldsPresent({ facilitiesPlannedForAnnualTargets: true }) === true);
    check("Big-project alone -> true", hasFacilitiesFieldsPresent({ facilitiesIsBigProject: false }) === true);

    // ── 1. Create with no explicit values -> both default false ──
    console.log("\n1. POST /api/projects (Facilities Services), no explicit checkboxes -> both default false ===\n");
    const createDefaultRes = await postProjects(
      jsonReq("http://localhost/api/projects", { title: `${TAG} Default Project`, departmentId: facDept.id, memberIds: [] })
    );
    check("POST -> 201", createDefaultRes.status === 201);
    const createdDefault = await createDefaultRes.json();
    projectIds.push(createdDefault.id);
    const afterDefaultCreate = await prisma.project.findUnique({ where: { id: createdDefault.id } });
    check("facilitiesPlannedForAnnualTargets defaults to false", afterDefaultCreate?.facilitiesPlannedForAnnualTargets === false);
    check("facilitiesIsBigProject defaults to false", afterDefaultCreate?.facilitiesIsBigProject === false);

    // ── 2. All 4 Boolean combinations via create ──
    console.log("\n2. All 4 Boolean combinations persist correctly on create ===\n");
    const combos: [boolean, boolean][] = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ];
    for (const [planned, big] of combos) {
      const res = await postProjects(
        jsonReq("http://localhost/api/projects", {
          title: `${TAG} Combo ${planned}-${big}`,
          departmentId: facDept.id,
          memberIds: [],
          facilitiesPlannedForAnnualTargets: planned,
          facilitiesIsBigProject: big,
        })
      );
      const body = await res.json();
      if (body.id) projectIds.push(body.id);
      const row = await prisma.project.findUnique({ where: { id: body.id } });
      check(
        `(${planned}, ${big}) persisted exactly`,
        row?.facilitiesPlannedForAnnualTargets === planned && row?.facilitiesIsBigProject === big,
        JSON.stringify({ got: { planned: row?.facilitiesPlannedForAnnualTargets, big: row?.facilitiesIsBigProject } })
      );
    }

    // ── 3. Independent updates, including explicit true -> false ──
    console.log("\n3. Independent updates via PATCH, including explicit true -> false ===\n");
    const patchTarget = await prisma.project.findUnique({ where: { id: projectIds[2] } }); // the (true, false) combo project
    check("(fixture) starting state is (true, false)", patchTarget?.facilitiesPlannedForAnnualTargets === true && patchTarget?.facilitiesIsBigProject === false);

    // Flip ONLY facilitiesIsBigProject to true — facilitiesPlannedForAnnualTargets must stay untouched (true).
    const patch1 = await patchProjectRoute(jsonReq(`http://localhost/api/projects/${projectIds[2]}`, { facilitiesIsBigProject: true }, "PATCH"), {
      params: Promise.resolve({ id: projectIds[2] }),
    });
    check("PATCH (set facilitiesIsBigProject only) -> 200", patch1.status === 200, `got ${patch1.status}: ${await patch1.clone().text()}`);
    const afterPatch1 = await prisma.project.findUnique({ where: { id: projectIds[2] } });
    check("facilitiesIsBigProject flipped to true", afterPatch1?.facilitiesIsBigProject === true);
    check("facilitiesPlannedForAnnualTargets untouched (still true)", afterPatch1?.facilitiesPlannedForAnnualTargets === true);

    // Explicit true -> false transition on facilitiesPlannedForAnnualTargets, leaving facilitiesIsBigProject untouched.
    const patch2 = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${projectIds[2]}`, { facilitiesPlannedForAnnualTargets: false }, "PATCH"),
      { params: Promise.resolve({ id: projectIds[2] }) }
    );
    check("PATCH (explicit true -> false) -> 200", patch2.status === 200);
    const afterPatch2 = await prisma.project.findUnique({ where: { id: projectIds[2] } });
    check("facilitiesPlannedForAnnualTargets explicitly flipped to false", afterPatch2?.facilitiesPlannedForAnnualTargets === false);
    check("facilitiesIsBigProject still untouched (still true)", afterPatch2?.facilitiesIsBigProject === true);

    // ── 4. Cross-workspace write rejection ──
    console.log("\n4. Cross-workspace write rejection ===\n");
    const rejectedCreateRes = await postProjects(
      jsonReq("http://localhost/api/projects", {
        title: `${TAG} Should Be Rejected`,
        departmentId: otherDept.id,
        memberIds: [],
        facilitiesIsBigProject: true,
      })
    );
    const rejectedBody = await rejectedCreateRes.json();
    check(
      "Rejected with facilities_fields_not_allowed",
      rejectedCreateRes.status === 400 && rejectedBody.code === "facilities_fields_not_allowed",
      JSON.stringify(rejectedBody)
    );

    // ── 5. Historical preservation after a department move + write-protection outside the workspace ──
    console.log("\n5. Historical preservation after department move + write-protection ===\n");
    const moveRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${projectIds[2]}`, { departmentId: otherDept.id }, "PATCH"),
      { params: Promise.resolve({ id: projectIds[2] }) }
    );
    check("PATCH (department move) -> 200", moveRes.status === 200, `got ${moveRes.status}: ${await moveRes.clone().text()}`);
    const afterMove = await prisma.project.findUnique({ where: { id: projectIds[2] } });
    check("facilitiesIsBigProject PRESERVED after leaving the workspace (still true)", afterMove?.facilitiesIsBigProject === true);
    check("facilitiesPlannedForAnnualTargets PRESERVED after leaving the workspace (still false)", afterMove?.facilitiesPlannedForAnnualTargets === false);

    const getOutsideRes = await getProject(new NextRequest(`http://localhost/api/projects/${projectIds[2]}`), {
      params: Promise.resolve({ id: projectIds[2] }),
    });
    const getOutsideBody = await getOutsideRes.json();
    check("isFacilitiesServicesWorkspace now false", getOutsideBody.isFacilitiesServicesWorkspace === false);

    const blockedWriteRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${projectIds[2]}`, { facilitiesIsBigProject: false }, "PATCH"),
      { params: Promise.resolve({ id: projectIds[2] }) }
    );
    const blockedWriteBody = await blockedWriteRes.json();
    check(
      "Write outside workspace rejected with facilities_fields_not_allowed",
      blockedWriteRes.status === 400 && blockedWriteBody.code === "facilities_fields_not_allowed"
    );
    const afterBlockedWrite = await prisma.project.findUnique({ where: { id: projectIds[2] } });
    check("facilitiesIsBigProject still unchanged (true, never overwritten)", afterBlockedWrite?.facilitiesIsBigProject === true);

    // ── 6. Existing Facilities fields (Company/Location/Category/Costs)
    //       remain unaffected by a request that ALSO sets the checkboxes ──
    console.log("\n6. Existing Facilities fields unaffected when checkboxes are also set ===\n");
    const comboRes = await postProjects(
      jsonReq("http://localhost/api/projects", {
        title: `${TAG} Combined Fields Project`,
        departmentId: facDept.id,
        memberIds: [],
        facilitiesCompany: "Combo Co",
        facilitiesLocation: "Combo Site",
        facilitiesCategory: "Combo Category",
        facilitiesEstimatedCost: 42.5,
        facilitiesPlannedForAnnualTargets: true,
        facilitiesIsBigProject: true,
      })
    );
    const comboBody = await comboRes.json();
    check("Combined create -> 201", comboRes.status === 201);
    projectIds.push(comboBody.id);
    const comboRow = await prisma.project.findUnique({ where: { id: comboBody.id } });
    check("facilitiesCompany unaffected", comboRow?.facilitiesCompany === "Combo Co");
    check("facilitiesLocation unaffected", comboRow?.facilitiesLocation === "Combo Site");
    check("facilitiesCategory unaffected", comboRow?.facilitiesCategory === "Combo Category");
    check("facilitiesEstimatedCost unaffected (exact Decimal)", comboRow?.facilitiesEstimatedCost?.toString() === "42.5");
    check("facilitiesPlannedForAnnualTargets set alongside", comboRow?.facilitiesPlannedForAnnualTargets === true);
    check("facilitiesIsBigProject set alongside", comboRow?.facilitiesIsBigProject === true);

    // ── 7. Request-origin creation path ──
    console.log("\n7. Request-origin creation persists both checkboxes ===\n");
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
      title: `${TAG} Request-Origin Project`,
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
      facilitiesPlannedForAnnualTargets: true,
      facilitiesIsBigProject: false,
    } as any);
    check("createProjectFromApprovedRequest ok", requestOriginResult.ok === true, JSON.stringify(requestOriginResult));
    if (requestOriginResult.ok) {
      projectIds.push(requestOriginResult.projectId);
      const requestOriginProject = await prisma.project.findUnique({ where: { id: requestOriginResult.projectId } });
      check("facilitiesPlannedForAnnualTargets persisted via request-origin", requestOriginProject?.facilitiesPlannedForAnnualTargets === true);
      check("facilitiesIsBigProject persisted via request-origin", requestOriginProject?.facilitiesIsBigProject === false);
    }

    // ── 8. Both Excel exports include both checkboxes, gated on workspace ──
    console.log("\n8. Excel exports include both checkboxes, shown only while in the workspace ===\n");
    const listBuffer = await buildProjectsListWorkbook([
      {
        title: "In-workspace row",
        description: null,
        status: "PLANNING",
        priority: 2,
        origin: "Manual",
        departmentName: "Facilities Services",
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
        facilitiesCategory: null,
        facilitiesEstimatedCost: null,
        facilitiesEstimatedCostNotes: null,
        facilitiesActualCost: null,
        facilitiesActualCostNotes: null,
        isFacilitiesServicesWorkspace: true,
        facilitiesPlannedForAnnualTargets: true,
        facilitiesIsBigProject: false,
        facilitiesProjectImportanceOverall: null,
        facilitiesProjectScore: null,
        facilitiesImportanceScoreLabel: null,
        facilitiesScoreLabel: null,
      },
      {
        title: "Out-of-workspace row (unrelated department)",
        description: null,
        status: "PLANNING",
        priority: 2,
        origin: "Manual",
        departmentName: "Some Other Department",
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
        facilitiesCategory: null,
        facilitiesEstimatedCost: null,
        facilitiesEstimatedCostNotes: null,
        facilitiesActualCost: null,
        facilitiesActualCostNotes: null,
        isFacilitiesServicesWorkspace: false,
        facilitiesPlannedForAnnualTargets: false,
        facilitiesIsBigProject: false,
        facilitiesProjectImportanceOverall: null,
        facilitiesProjectScore: null,
        facilitiesImportanceScoreLabel: null,
        facilitiesScoreLabel: null,
      },
    ]);
    const listWb = new ExcelJS.Workbook();
    await listWb.xlsx.load(listBuffer as any);
    const listSheet = listWb.getWorksheet("Projects")!;
    const headerRow = listSheet.getRow(1).values as unknown[];
    const headers = headerRow.map((v) => (typeof v === "string" ? v : null));
    const plannedCol = headers.indexOf("Planned for This Year's Targets");
    const bigCol = headers.indexOf("Big Project");
    const row2 = listSheet.getRow(2).values as unknown[];
    const row3 = listSheet.getRow(3).values as unknown[];
    check("In-workspace row shows Yes for Planned for Annual Targets", row2[plannedCol] === "Yes");
    check("In-workspace row shows No for Big Project", row2[bigCol] === "No");
    check("Out-of-workspace row shows blank (not 'No') for Planned for Annual Targets", row2 !== row3 && (row3[plannedCol] === "" || row3[plannedCol] === null));
    check("Out-of-workspace row shows blank (not 'No') for Big Project", row3[bigCol] === "" || row3[bigCol] === null);

    const detailBufferInWorkspace = await buildProjectDetailWorkbook({
      title: "Detail In-Workspace",
      description: null,
      status: "PLANNING",
      priority: 2,
      origin: "Manual",
      projectRequestTitle: null,
      departmentName: "Facilities Services",
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
      facilitiesCategory: null,
      facilitiesEstimatedCost: null,
      facilitiesEstimatedCostNotes: null,
      facilitiesActualCost: null,
      facilitiesActualCostNotes: null,
      isFacilitiesServicesWorkspace: true,
      facilitiesPlannedForAnnualTargets: false,
      facilitiesIsBigProject: true,
      facilitiesProjectImportanceOverall: null,
      facilitiesProjectScore: null,
      facilitiesImportanceScoreLabel: null,
      facilitiesScoreLabel: null,
      activities: [],
    });
    const detailWb = new ExcelJS.Workbook();
    await detailWb.xlsx.load(detailBufferInWorkspace as any);
    const detailsSheet = detailWb.getWorksheet("Project Details")!;
    const detailKv: Record<string, unknown> = {};
    detailsSheet.eachRow((row) => {
      const key = row.getCell(1).value;
      if (typeof key === "string") detailKv[key] = row.getCell(2).value;
    });
    check("Detail export (in workspace) shows No for Planned for Annual Targets", detailKv["Planned for This Year's Targets"] === "No");
    check("Detail export (in workspace) shows Yes for Big Project", detailKv["Big Project"] === "Yes");

    const detailBufferOutsideWorkspace = await buildProjectDetailWorkbook({
      title: "Detail Outside Workspace",
      description: null,
      status: "PLANNING",
      priority: 2,
      origin: "Manual",
      projectRequestTitle: null,
      departmentName: "Some Other Department",
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
      facilitiesCategory: null,
      facilitiesEstimatedCost: null,
      facilitiesEstimatedCostNotes: null,
      facilitiesActualCost: null,
      facilitiesActualCostNotes: null,
      isFacilitiesServicesWorkspace: false,
      facilitiesPlannedForAnnualTargets: true,
      facilitiesIsBigProject: true,
      facilitiesProjectImportanceOverall: null,
      facilitiesProjectScore: null,
      facilitiesImportanceScoreLabel: null,
      facilitiesScoreLabel: null,
      activities: [],
    });
    const detailWbOutside = new ExcelJS.Workbook();
    await detailWbOutside.xlsx.load(detailBufferOutsideWorkspace as any);
    const detailsSheetOutside = detailWbOutside.getWorksheet("Project Details")!;
    const detailKvOutside: Record<string, unknown> = {};
    detailsSheetOutside.eachRow((row) => {
      const key = row.getCell(1).value;
      if (typeof key === "string") detailKvOutside[key] = row.getCell(2).value;
    });
    check(
      "Detail export (outside workspace) never includes a Planned/Big Project row at all",
      detailKvOutside["Planned for This Year's Targets"] === undefined && detailKvOutside["Big Project"] === undefined
    );
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
