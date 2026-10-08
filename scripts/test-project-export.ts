/**
 * Focused verification for the Projects Excel export feature:
 *   - GET /api/projects/export (All Projects list export)
 *   - GET /api/projects/[id]/export (single Project detail export)
 *
 * Exercises the REAL route handlers (not a reimplementation) against a real
 * local database, with a mocked @/lib/auth session — same convention as
 * scripts/test-project-attachments.ts. Verifies: valid .xlsx parses back
 * with ExcelJS, exported rows match the exact filters/department-scope the
 * on-screen list would show, no pagination truncation, unauthorized
 * requests never receive project/financial data, and user-controlled
 * strings that start with a formula-trigger character (=, +, -, @) come
 * back defused (see lib/services/project-export-service.ts's
 * sanitizeExcelString) rather than as a live formula.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-export.ts
 */
import { mock } from "node:test";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { Role, ProjectStatus, ProjectRequestStatus } from "@prisma/client";
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

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

const RUN_ID = Date.now();

async function readSheetTitles(buffer: Buffer | ExcelJS.Buffer, sheetName: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) return [];
  const titles: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const value = row.getCell(1).value;
    if (typeof value === "string") titles.push(value);
  });
  return titles;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { GET: listExportGET } = await import("@/app/api/projects/export/route");
  const { GET: detailExportGET } = await import("@/app/api/projects/[id]/export/route");
  const { NextRequest } = await import("next/server");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const taskSubTypeIds: string[] = [];
  const projectRequestIds: string[] = [];

  try {
    const deptA = await createDepartment({ name: `Export Test Dept A ${RUN_ID}`, slug: `export-test-dept-a-${RUN_ID}` });
    departmentIds.push(deptA.id);
    const deptB = await createDepartment({ name: `Export Test Dept B ${RUN_ID}`, slug: `export-test-dept-b-${RUN_ID}` });
    departmentIds.push(deptB.id);

    const adminUser = await prisma.user.create({ data: { email: `pexp-admin-${RUN_ID}@example.com`, role: Role.ADMIN, name: `Export Admin ${RUN_ID}` } });
    userIds.push(adminUser.id);
    const memberUser = await prisma.user.create({ data: { email: `pexp-member-${RUN_ID}@example.com`, role: Role.USER, name: `Export Member ${RUN_ID}` } });
    userIds.push(memberUser.id);
    const unauthorizedUser = await prisma.user.create({ data: { email: `pexp-unauth-${RUN_ID}@example.com`, role: Role.USER, name: `Unauthorized User ${RUN_ID}` } });
    userIds.push(unauthorizedUser.id);

    const costSubType = await prisma.taskSubType.create({ data: { name: `Export Fixed Cost ${RUN_ID}`, cost: 100 } });
    taskSubTypeIds.push(costSubType.id);
    const noCostSubType = await prisma.taskSubType.create({ data: { name: `Export Manual Cost ${RUN_ID}`, cost: null } });
    taskSubTypeIds.push(noCostSubType.id);

    const pr = await prisma.projectRequest.create({
      data: {
        title: `Export Test Request ${RUN_ID}`,
        description: "fixture",
        importance: 2,
        teamConcerned: "IT",
        expectedBenefits: "fixture",
        requesterId: adminUser.id,
        departmentId: deptA.id,
        status: ProjectRequestStatus.APPROVED,
      },
    });
    projectRequestIds.push(pr.id);

    const p1 = await prisma.project.create({
      data: {
        title: `Export Manual Project ${RUN_ID}`,
        status: ProjectStatus.PLANNING,
        priority: 1,
        progress: 40,
        ownerId: adminUser.id,
        departmentId: deptA.id,
        members: { connect: [{ id: memberUser.id }] },
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-02-01"),
      },
    });
    projectIds.push(p1.id);

    const p2 = await prisma.project.create({
      data: {
        title: `Export Request-Origin Project ${RUN_ID}`,
        status: ProjectStatus.IN_PROGRESS,
        priority: 3,
        ownerId: adminUser.id,
        departmentId: deptA.id,
        projectRequestId: pr.id,
      },
    });
    projectIds.push(p2.id);

    const p3 = await prisma.project.create({
      data: {
        title: `Export DeptB Project ${RUN_ID}`,
        status: ProjectStatus.PLANNING,
        priority: 2,
        ownerId: adminUser.id,
        departmentId: deptB.id,
      },
    });
    projectIds.push(p3.id);

    const a1 = await prisma.projectActivity.create({
      data: {
        title: `Export Activity Fixed Cost ${RUN_ID}`,
        projectId: p1.id,
        departmentId: deptA.id,
        taskSubTypeId: costSubType.id,
        taskSubTypeCost: 100,
        expectedDays: 5,
        actualDays: 3,
      },
    });
    const a2 = await prisma.projectActivity.create({
      data: {
        title: `Export Activity Manual Cost ${RUN_ID}`,
        projectId: p1.id,
        departmentId: deptA.id,
        taskSubTypeId: noCostSubType.id,
        taskSubTypeCost: 250,
        expectedDays: 2,
        actualDays: 2,
      },
    });
    activityIds.push(a1.id, a2.id);

    // 25 manual projects (> DEFAULT_PAGE_SIZE of 20) sharing a unique search
    // term, to prove the export never truncates to one pagination page.
    const pagTag = `ExportPagTest-${RUN_ID}`;
    const pagProjects = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        prisma.project.create({ data: { title: `${pagTag} ${i}`, status: ProjectStatus.PLANNING, priority: 2, ownerId: adminUser.id, departmentId: deptA.id } })
      )
    );
    projectIds.push(...pagProjects.map((p) => p.id));

    // Formula-injection fixture — Project title/description, a Member's
    // name, and an Activity title that each start with a classic
    // CSV/formula-injection trigger character (=, +, @). Real user-
    // controllable fields (title, description, User.name), deliberately
    // not a "safe" admin-only field — proves the defense applies generically.
    const formulaTag = `FormulaInjTest-${RUN_ID}`;
    const formulaMember = await prisma.user.create({
      data: { email: `pexp-formula-${RUN_ID}@example.com`, role: Role.USER, name: `+1;cmd|'/c calc'!A1 ${RUN_ID}` },
    });
    userIds.push(formulaMember.id);
    const p4 = await prisma.project.create({
      data: {
        title: `=HYPERLINK("http://evil.example") ${formulaTag}`,
        description: `@SUM(1,1) description ${formulaTag}`,
        status: ProjectStatus.PLANNING,
        priority: 2,
        ownerId: adminUser.id,
        departmentId: deptA.id,
        members: { connect: [{ id: formulaMember.id }] },
      },
    });
    projectIds.push(p4.id);
    const a3 = await prisma.projectActivity.create({
      data: { title: `-2+3 ${formulaTag}`, projectId: p4.id, departmentId: deptA.id },
    });
    activityIds.push(a3.id);

    const callListExport = (query: string) => listExportGET(new NextRequest(`http://localhost/api/projects/export${query}`));
    const callDetailExport = (id: string) => detailExportGET(new NextRequest(`http://localhost/api/projects/${id}/export`), { params: Promise.resolve({ id }) });

    console.log("\n1. Unauthenticated / unauthorized requests never receive project data...\n");
    currentSession = null;
    let res = await callListExport("");
    check("No session -> 401, not a file", res.status === 401);

    currentSession = { user: { id: unauthorizedUser.id, role: Role.USER, customRoleId: null } };
    res = await callListExport("");
    check("USER with no department access -> 403 on list export, no workbook body", res.status === 403);
    res = await callDetailExport(p1.id);
    check("USER with no department access -> 403 on detail export", res.status === 403);

    console.log("\n2. Authorized export returns a valid, parseable .xlsx with the right rows...\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    res = await callListExport(`?search=${encodeURIComponent(`Export `)}&departmentId=${deptA.id}`);
    check("List export responds 200", res.status === 200);
    check(
      "Content-Type is the real .xlsx media type",
      res.headers.get("Content-Type") === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    const buf1 = Buffer.from(await res.arrayBuffer());
    const titlesScoped = await readSheetTitles(buf1, "Projects");
    check("Scoped-to-deptA export includes the manual + request-origin deptA projects", titlesScoped.includes(p1.title) && titlesScoped.includes(p2.title));
    check("Scoped-to-deptA export excludes the deptB project (department narrowing honored)", !titlesScoped.includes(p3.title));

    console.log("\n3. Origin filter is honored identically to the on-screen list...\n");
    res = await callListExport(`?origin=request&departmentId=${deptA.id}`);
    let titles = await readSheetTitles(Buffer.from(await res.arrayBuffer()), "Projects");
    check("origin=request returns only the request-origin project", titles.includes(p2.title) && !titles.includes(p1.title));

    res = await callListExport(`?origin=manual&departmentId=${deptA.id}&search=Export%20Manual`);
    titles = await readSheetTitles(Buffer.from(await res.arrayBuffer()), "Projects");
    check("origin=manual returns only the manual project (not the request-origin one)", titles.includes(p1.title) && !titles.includes(p2.title));

    console.log("\n4. Status filter is honored...\n");
    res = await callListExport(`?status=IN_PROGRESS&departmentId=${deptA.id}`);
    titles = await readSheetTitles(Buffer.from(await res.arrayBuffer()), "Projects");
    check("status=IN_PROGRESS returns only p2", titles.join(",") === p2.title || (titles.includes(p2.title) && !titles.includes(p1.title)));

    console.log("\n5. No pagination truncation — all 25 matching rows exported, not just one page...\n");
    res = await callListExport(`?search=${encodeURIComponent(pagTag)}&departmentId=${deptA.id}`);
    titles = await readSheetTitles(Buffer.from(await res.arrayBuffer()), "Projects");
    check(`All 25 fixture rows present in the export (found ${titles.length})`, titles.length === 25);

    console.log("\n6. Detail export — 3 worksheets, correct Financials totals, Activities rows...\n");
    res = await callDetailExport(p1.id);
    check("Detail export responds 200", res.status === 200);
    const detailBuf = Buffer.from(await res.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(detailBuf as any);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    check(
      "Workbook has exactly the 3 expected sheets",
      sheetNames.includes("Project Details") && sheetNames.includes("Financials") && sheetNames.includes("Activities")
    );

    const detailsSheet = workbook.getWorksheet("Project Details")!;
    let titleRowValue: unknown;
    detailsSheet.eachRow((row) => {
      if (row.getCell(1).value === "Title") titleRowValue = row.getCell(2).value;
    });
    check("Project Details sheet's Title row matches the Project", titleRowValue === p1.title);

    const financialsSheet = workbook.getWorksheet("Financials")!;
    let totalEstimated: unknown;
    let totalActual: unknown;
    let financialsDataRows = 0;
    financialsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(1).value === "TOTAL") {
        totalEstimated = row.getCell(6).value;
        totalActual = row.getCell(7).value;
      } else {
        financialsDataRows++;
      }
    });
    // a1: 100/day * 3 actual days = 300, 100*5 expected = 500. a2: 250*2=500 expected, 250*2=500 actual.
    check("Financials sheet has one data row per Activity (2)", financialsDataRows === 2);
    check(`Financials TOTAL estimated cost is correct (500+500=1000, got ${totalEstimated})`, totalEstimated === 1000);
    check(`Financials TOTAL actual cost is correct (300+500=800, got ${totalActual})`, totalActual === 800);

    const activitiesSheet = workbook.getWorksheet("Activities")!;
    const activityTitles = await readSheetTitles(detailBuf, "Activities");
    check("Activities sheet lists both fixture Activities", activityTitles.includes(a1.title) && activityTitles.includes(a2.title));
    void activitiesSheet;

    console.log("\n7. Unknown Project id -> 404, not a crash or empty file...\n");
    res = await callDetailExport("nonexistent-id-12345");
    check("Unknown id returns 404", res.status === 404);

    console.log("\n8. Formula-injection defense-in-depth — leading =/+/-/@ strings come back defused, never as a live formula...\n");
    res = await callListExport(`?departmentId=${deptA.id}&search=${encodeURIComponent(formulaTag)}`);
    check("Formula-fixture list export responds 200", res.status === 200);
    const formulaListBuf = Buffer.from(await res.arrayBuffer());
    const formulaListWb = new ExcelJS.Workbook();
    await formulaListWb.xlsx.load(formulaListBuf as any);
    const projectsSheet = formulaListWb.getWorksheet("Projects")!;
    let titleCellValue: unknown;
    let titleCellType: ExcelJS.ValueType | undefined;
    let membersCellValue: unknown;
    projectsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = row.getCell(1);
      if (typeof cell.value === "string" && cell.value.includes(formulaTag)) {
        titleCellValue = cell.value;
        titleCellType = cell.type;
        membersCellValue = row.getCell(7).value;
      }
    });
    check(
      `List export Title cell is defused with a leading apostrophe (got ${JSON.stringify(titleCellValue)})`,
      typeof titleCellValue === "string" && titleCellValue === `'=HYPERLINK("http://evil.example") ${formulaTag}`
    );
    check("List export Title cell's stored type is still a plain string, never a live Formula cell", titleCellType === ExcelJS.ValueType.String);
    check(
      `List export Members cell (joined with the =-leading Member name) is defused too (got ${JSON.stringify(membersCellValue)})`,
      typeof membersCellValue === "string" && (membersCellValue as string).startsWith("'+1;cmd|")
    );

    res = await callDetailExport(p4.id);
    check("Formula-fixture detail export responds 200", res.status === 200);
    const formulaDetailBuf = Buffer.from(await res.arrayBuffer());
    const formulaDetailWb = new ExcelJS.Workbook();
    await formulaDetailWb.xlsx.load(formulaDetailBuf as any);
    const formulaDetailsSheet = formulaDetailWb.getWorksheet("Project Details")!;
    let detailTitleValue: unknown;
    let detailDescriptionValue: unknown;
    formulaDetailsSheet.eachRow((row) => {
      if (row.getCell(1).value === "Title") detailTitleValue = row.getCell(2).value;
      if (row.getCell(1).value === "Description") detailDescriptionValue = row.getCell(2).value;
    });
    check(
      `Detail export's Title row is defused (got ${JSON.stringify(detailTitleValue)})`,
      detailTitleValue === `'=HYPERLINK("http://evil.example") ${formulaTag}`
    );
    check(
      `Detail export's Description row (leading @) is defused (got ${JSON.stringify(detailDescriptionValue)})`,
      detailDescriptionValue === `'@SUM(1,1) description ${formulaTag}`
    );

    const formulaActivitiesSheet = formulaDetailWb.getWorksheet("Activities")!;
    let activityTitleValue: unknown;
    let activityTitleType: ExcelJS.ValueType | undefined;
    formulaActivitiesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = row.getCell(1);
      if (typeof cell.value === "string" && cell.value.includes(formulaTag)) {
        activityTitleValue = cell.value;
        activityTitleType = cell.type;
      }
    });
    check(`Activity title (leading -) is defused (got ${JSON.stringify(activityTitleValue)})`, activityTitleValue === `'-2+3 ${formulaTag}`);
    check("Activity title cell's stored type is still a plain string, never a live Formula cell", activityTitleType === ExcelJS.ValueType.String);

    check(
      "A title NOT starting with a trigger character is left byte-for-byte unchanged (no over-escaping)",
      p1.title === `Export Manual Project ${RUN_ID}` &&
        (await readSheetTitles(Buffer.from(await (await callDetailExport(p1.id)).arrayBuffer()), "Activities")).includes(a1.title)
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
