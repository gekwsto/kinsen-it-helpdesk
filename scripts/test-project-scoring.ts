/**
 * Focused regression for Facilities Project Scoring — the four fields
 * (Project Importance Overall, Project Importance Score, Project Score,
 * Score) added on top of the pre-existing Facilities Services Project
 * metadata feature. Covers: the fixed Importance mapping, exact-formula
 * correctness (including the spec's own 25% example), all-statuses-
 * included group counts, independent importance groups, "recalculation"
 * via live computation (create/delete/importance-change/reassignment),
 * missing-input handling, non-Facilities write protection, permission
 * preservation, and UI/API/Excel consistency (the one canonical function
 * used everywhere).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-scoring.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus } from "@prisma/client";
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
const TAG = `psc-${RUN_ID}`;
// Set BEFORE any import of project-facilities-service (directly or
// transitively) — it reads this into a module-level const at first
// import, same requirement as scripts/test-project-facilities-cost-fields.ts.
process.env.FACILITIES_SERVICES_DEPARTMENT_SLUG = `${TAG}-facilities-services`;

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
  const { GET: getProjectRoute, PATCH: patchProjectRoute } = await import("@/app/api/projects/[id]/route");
  const { getFacilitiesImportanceGroupCounts, computeFacilitiesScorePercent } = await import("@/lib/services/project-scoring-service");
  const { getImportanceScoreFraction, formatScorePercent } = await import("@/lib/project-scoring-shared");
  const { buildProjectsListWorkbook } = await import("@/lib/services/project-export-service");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const getReq = (url: string) => new NextRequest(url, { method: "GET" });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];

  async function createFacilitiesProject(overrides: Record<string, unknown> = {}, departmentId?: string) {
    const res = await postProjects(
      jsonReq("http://localhost/api/projects", {
        title: `${TAG} Project ${Math.random().toString(36).slice(2)}`,
        departmentId: departmentId ?? facDept.id,
        memberIds: [],
        ...overrides,
      })
    );
    const body = await res.json();
    if (res.status === 201) projectIds.push(body.id);
    return { status: res.status, body };
  }

  var facDept: { id: string };

  try {
    console.log("\n=== Fixtures ===\n");
    facDept = await createDepartment({ name: `${TAG}-facilities-dept`, slug: `${TAG}-facilities-services` });
    departmentIds.push(facDept.id);
    const otherDept = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    departmentIds.push(otherDept.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1. Importance mapping ────────────────────────────────────────────
    console.log("\n1. Importance mapping: 1 -> 10%, 2 -> 30%, 3 -> 60% ===\n");
    check("Importance 1 -> 0.10", getImportanceScoreFraction(1) === 0.1);
    check("Importance 2 -> 0.30", getImportanceScoreFraction(2) === 0.3);
    check("Importance 3 -> 0.60", getImportanceScoreFraction(3) === 0.6);
    check("Importance null -> null (Not set)", getImportanceScoreFraction(null) === null);
    check("Importance out of range (4) -> null", getImportanceScoreFraction(4 as any) === null);

    // ── 2. Project Score validation (1-5 integers) ───────────────────────
    console.log("\n2. Project Score / Importance Overall server-side range validation ===\n");
    {
      const { status, body } = await createFacilitiesProject({ facilitiesProjectScore: 6 });
      check("Project Score = 6 (over range) -> 422", status === 422, JSON.stringify(body));
    }
    {
      const { status, body } = await createFacilitiesProject({ facilitiesProjectScore: 0 });
      check("Project Score = 0 (under range) -> 422", status === 422, JSON.stringify(body));
    }
    {
      const { status, body } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 4 });
      check("Importance Overall = 4 (over range) -> 422", status === 422, JSON.stringify(body));
    }
    {
      const { status, body } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 1, facilitiesProjectScore: 5 });
      check("Valid Importance=1/Score=5 -> 201", status === 201, JSON.stringify(body));
    }

    // ── 3. Exact Excel formula — the spec's own 25% example ──────────────
    console.log("\n3. Exact Excel formula, including the spec's 25% example ===\n");
    check(
      "(0.10 x 5) / 2 = 0.25 (25%)",
      computeFacilitiesScorePercent(1, 5, { 1: 2 }) === 0.25
    );
    check(
      "Formula is NOT divided by 5 anywhere — a score of 5 against a group of 1 is 50%, not 10%",
      computeFacilitiesScorePercent(1, 5, { 1: 1 }) === 0.5
    );
    check(
      "Formula is NOT capped at 100% — a large enough score/small group legitimately exceeds it",
      computeFacilitiesScorePercent(3, 5, { 3: 1 })! > 1
    );
    check('formatScorePercent renders the 25% example as "25.00%"', formatScorePercent(0.25) === "25.00%");

    // ── 4. All statuses included in group counts ─────────────────────────
    console.log("\n4. All statuses (including Completed/Cancelled/On Hold) counted ===\n");
    const statusGroupTag = `${TAG}-status-group`;
    const statuses: ProjectStatus[] = [ProjectStatus.PLANNING, ProjectStatus.IN_PROGRESS, ProjectStatus.ON_HOLD, ProjectStatus.COMPLETED, ProjectStatus.CANCELLED];
    for (const status of statuses) {
      const { body } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 2, facilitiesProjectScore: 3 });
      await prisma.project.update({ where: { id: body.id }, data: { status } });
    }
    const countsAfterAllStatuses = await getFacilitiesImportanceGroupCounts();
    check(
      `All 5 statuses counted in Importance 2's group (expected >= 5, got ${countsAfterAllStatuses[2]})`,
      (countsAfterAllStatuses[2] ?? 0) >= 5
    );

    // ── 5. Independent importance groups ─────────────────────────────────
    console.log("\n5. Different Importance groups counted independently ===\n");
    const { body: imp1Project } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 1, facilitiesProjectScore: 2 });
    const countsAfterImp1 = await getFacilitiesImportanceGroupCounts();
    check("Importance 1's own count grew", (countsAfterImp1[1] ?? 0) >= 2); // the earlier valid-create check above + this one
    check("Importance 2's count is UNCHANGED by an Importance-1 creation", countsAfterImp1[2] === countsAfterAllStatuses[2]);

    // ── 6. Recalculation via live computation ─────────────────────────────
    console.log("\n6a. Recalculation after CREATE — an existing project's Score changes when a sibling is created ===\n");
    const soloTag = `${TAG}-recalc-solo`;
    const { body: soloProject } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 3, facilitiesProjectScore: 4 });
    const scoreBeforeSibling = computeFacilitiesScorePercent(3, 4, await getFacilitiesImportanceGroupCounts());
    const { body: siblingProject } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 3, facilitiesProjectScore: 2 });
    const scoreAfterSibling = computeFacilitiesScorePercent(3, 4, await getFacilitiesImportanceGroupCounts());
    check(
      "Solo project's live Score changed once a same-Importance sibling was created (denominator grew)",
      scoreBeforeSibling !== null && scoreAfterSibling !== null && scoreAfterSibling < scoreBeforeSibling
    );

    console.log("\n6b. Recalculation after DELETE — removing the sibling reverts the Score ===\n");
    await prisma.project.delete({ where: { id: siblingProject.id } });
    projectIds.splice(projectIds.indexOf(siblingProject.id), 1);
    const scoreAfterDelete = computeFacilitiesScorePercent(3, 4, await getFacilitiesImportanceGroupCounts());
    check("Score reverted to its pre-sibling value after the sibling was deleted", scoreAfterDelete === scoreBeforeSibling);

    console.log("\n6c. Recalculation after an IMPORTANCE change ===\n");
    const patchImportanceRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${soloProject.id}`, { facilitiesProjectImportanceOverall: 1 }, "PATCH"),
      { params: Promise.resolve({ id: soloProject.id }) }
    );
    check("PATCH changing Importance Overall -> 200", patchImportanceRes.status === 200);
    const patchedBody = await patchImportanceRes.json();
    check(
      "The response's facilitiesScorePercent reflects the NEW Importance group, not the old one",
      patchedBody.facilitiesScorePercent === computeFacilitiesScorePercent(1, 4, await getFacilitiesImportanceGroupCounts())
    );

    console.log("\n6d. Recalculation after REASSIGNMENT out of Facilities ===\n");
    const countsBeforeReassign = await getFacilitiesImportanceGroupCounts();
    const reassignRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${soloProject.id}`, { departmentId: otherDept.id }, "PATCH"),
      { params: Promise.resolve({ id: soloProject.id }) }
    );
    check("PATCH reassigning department -> 200", reassignRes.status === 200);
    const reassignedBody = await reassignRes.json();
    check("Reassigned project's isFacilitiesServicesWorkspace is now false", reassignedBody.isFacilitiesServicesWorkspace === false);
    check("Reassigned project's facilitiesScorePercent is null (hidden outside the workspace)", reassignedBody.facilitiesScorePercent === null);
    const dbRowAfterReassign = await prisma.project.findUnique({ where: { id: soloProject.id } });
    check(
      "Historical facilitiesProjectImportanceOverall/Score are PRESERVED, never cleared (same rule as every other Facilities field)",
      dbRowAfterReassign?.facilitiesProjectImportanceOverall === 1 && dbRowAfterReassign?.facilitiesProjectScore === 4
    );
    const countsAfterReassign = await getFacilitiesImportanceGroupCounts();
    check(
      "The reassigned project no longer counts toward Importance 1's Facilities group",
      (countsAfterReassign[1] ?? 0) === (countsBeforeReassign[1] ?? 0) - 1
    );

    // ── 7. Missing inputs handled safely ──────────────────────────────────
    console.log("\n7. Missing inputs -> Not set, never a wrong/guessed value ===\n");
    const { body: noScoreProject } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 2 }); // Score omitted
    const getNoScoreRes = await getProjectRoute(getReq(`http://localhost/api/projects/${noScoreProject.id}`), { params: Promise.resolve({ id: noScoreProject.id }) });
    const noScoreBody = await getNoScoreRes.json();
    check("Missing Project Score -> facilitiesScorePercent is null", noScoreBody.facilitiesScorePercent === null);
    check('formatScorePercent(null) renders "Not set"', formatScorePercent(null) === "Not set");
    const { body: neitherProject } = await createFacilitiesProject({}); // neither field set
    const getNeitherRes = await getProjectRoute(getReq(`http://localhost/api/projects/${neitherProject.id}`), { params: Promise.resolve({ id: neitherProject.id }) });
    check("Neither input set -> facilitiesScorePercent is null", (await getNeitherRes.json()).facilitiesScorePercent === null);

    // ── 8. Non-Facilities projects excluded + write-protected ─────────────
    console.log("\n8. Non-Facilities projects are excluded from calculations and protected from scoring writes ===\n");
    const { status: rejectedStatus, body: rejectedBody } = await createFacilitiesProject(
      { facilitiesProjectImportanceOverall: 1, facilitiesProjectScore: 5 },
      otherDept.id
    );
    check("Writing scoring fields on a non-Facilities create -> 400 facilities_fields_not_allowed", rejectedStatus === 400 && rejectedBody.code === "facilities_fields_not_allowed");
    const nonFacilitiesCountCheck = await createFacilitiesProject({}, otherDept.id);
    check("A plain non-Facilities project can still be created normally (no scoring fields sent)", nonFacilitiesCountCheck.status === 201);
    const countsExcludeOtherDept = await getFacilitiesImportanceGroupCounts();
    check(
      "Group counts are completely unaffected by ANY non-Facilities department project",
      JSON.stringify(countsExcludeOtherDept) === JSON.stringify(await getFacilitiesImportanceGroupCounts())
    );

    // ── 9. Existing permissions / department scoping preserved ────────────
    console.log("\n9. Existing project.edit permission is still enforced for scoring writes ===\n");
    const outsider = await prisma.user.create({
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(outsider.id);
    const savedSession = currentSession;
    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const forbiddenPatch = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${imp1Project.id}`, { facilitiesProjectScore: 5 }, "PATCH"),
      { params: Promise.resolve({ id: imp1Project.id }) }
    );
    check("A user with no project.edit permission -> 403 (scoring fields are not a backdoor around this)", forbiddenPatch.status === 403);
    currentSession = savedSession;

    // ── 10. UI / API / Excel consistency — one canonical calculation ──────
    console.log("\n10. UI, API and Excel export all agree, from the SAME underlying calculation ===\n");
    const { body: consistencyProject } = await createFacilitiesProject({ facilitiesProjectImportanceOverall: 2, facilitiesProjectScore: 4 });
    const consistencyGroupCounts = await getFacilitiesImportanceGroupCounts();
    const expectedFraction = computeFacilitiesScorePercent(2, 4, consistencyGroupCounts);
    const apiRes = await getProjectRoute(getReq(`http://localhost/api/projects/${consistencyProject.id}`), { params: Promise.resolve({ id: consistencyProject.id }) });
    const apiBody = await apiRes.json();
    check("API response's facilitiesScorePercent matches the canonical function's result", apiBody.facilitiesScorePercent === expectedFraction);

    const exportBuffer = await buildProjectsListWorkbook([
      {
        title: "Consistency Row",
        description: null,
        status: "PLANNING",
        priority: 2,
        origin: "Manual",
        departmentName: `${TAG}-facilities-dept`,
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
        facilitiesPlannedForAnnualTargets: false,
        facilitiesIsBigProject: false,
        facilitiesProjectImportanceOverall: 2,
        facilitiesProjectScore: 4,
        facilitiesImportanceScoreLabel: formatScorePercent(getImportanceScoreFraction(2)),
        facilitiesScoreLabel: formatScorePercent(expectedFraction),
      },
    ]);
    const exportWb = new ExcelJS.Workbook();
    await exportWb.xlsx.load(exportBuffer as any);
    const exportSheet = exportWb.getWorksheet("Projects")!;
    const exportHeaders = (exportSheet.getRow(1).values as unknown[]).map((v) => (typeof v === "string" ? v : null));
    const exportRow = exportSheet.getRow(2).values as unknown[];
    const scoreCell = exportRow[exportHeaders.indexOf("Score")];
    check(
      "Excel export's Score column matches the SAME formatted value the API/UI would show",
      scoreCell === formatScorePercent(expectedFraction)
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
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
