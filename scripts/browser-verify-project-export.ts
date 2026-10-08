/**
 * Live browser verification for the Projects Excel export feature:
 *   - "Export to Excel" on /projects, with and without active filters
 *   - "Export to Excel" on /projects/[id]
 *   - Opens both downloaded .xlsx files (via ExcelJS, same as a real Excel
 *     open would validate) and checks worksheet structure, headers, dates,
 *     and financial totals against known fixture values
 *   - Loading state ("Exporting...", disabled button), an error toast on a
 *     failed request, and both buttons recovering to their normal state
 *     after success or failure (lib/download-file.ts + the two button
 *     components' own isExporting state)
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention, e.g. browser-verify-project-list-preview.ts).
 * Fixture data is created fresh and tagged/cleaned up, same as every other
 * browser-verify script — no existing/real Project is ever touched.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-export.ts
 */
import { chromium, type Page } from "playwright";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ProjectStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvpe-${RUN_ID}`;

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

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", ADMIN_EMAIL);
  await page.fill("#credentials-password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

async function readWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const buf = readFileSync(path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  return wb;
}

function sheetTitles(sheet: ExcelJS.Worksheet): string[] {
  const titles: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const v = row.getCell(1).value;
    if (typeof v === "string") titles.push(v);
  });
  return titles;
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const deptIds: string[] = [];
  const projectIds: string[] = [];
  const taskSubTypeIds: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const costSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-cost-subtype`, cost: 150 } });
    taskSubTypeIds.push(costSubType.id);

    const manualProject = await prisma.project.create({
      data: {
        title: `${TAG} Manual Project`,
        status: ProjectStatus.PLANNING,
        priority: 2,
        ownerId: admin.id,
        departmentId: dept.id,
        startDate: new Date("2026-03-01"),
        endDate: new Date("2026-04-15"),
      },
    });
    projectIds.push(manualProject.id);

    const inProgressProject = await prisma.project.create({
      data: {
        title: `${TAG} In Progress Project`,
        status: ProjectStatus.IN_PROGRESS,
        priority: 3,
        ownerId: admin.id,
        departmentId: dept.id,
      },
    });
    projectIds.push(inProgressProject.id);

    // Activities on manualProject for the detail export's Financials sheet:
    // 150/day * 4 expected = 600 estimated, 150 * 2 actual = 300 actual.
    await prisma.projectActivity.create({
      data: { title: `${TAG} Activity A`, projectId: manualProject.id, departmentId: dept.id, taskSubTypeId: costSubType.id, taskSubTypeCost: 150, expectedDays: 4, actualDays: 2 },
    });

    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await browserContext.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await login(page);
    check("0. Logged in as the demo Admin account", !page.url().includes("/login"));

    // ══════════════════════ /projects — export WITHOUT active filters ══════════════════════
    console.log("\n=== /projects export — no active filters (scoped only to the fixture department) ===\n");
    await page.goto(`${BASE_URL}/projects?departmentId=${dept.id}&search=${encodeURIComponent(TAG)}`, { waitUntil: "load" });
    // Located by a stable data-testid, NOT by accessible name/text — the
    // button's own text toggles between "Export to Excel" and
    // "Exporting...", so a name-based locator would stop matching (and
    // silently block/retry) the instant the loading state kicks in.
    const exportButton = page.getByTestId("export-projects-button");
    await exportButton.waitFor({ state: "visible", timeout: 5000 });
    check("1. Export to Excel button is visible on /projects", await exportButton.isVisible());

    // Delay this one request so the transient "Exporting..." loading state
    // is reliably observable instead of racing a near-instant local response.
    // The margin before checking is generous (500ms of a 1500ms delay) since
    // the actual request dispatch (click -> React handler -> fetch) can lag
    // a bit behind the synchronous click() call resolving, depending on
    // machine load.
    await page.route("**/api/projects/export**", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const clickPromise = exportButton.click();
    await page.waitForTimeout(500);
    const loadingText = await exportButton.textContent();
    check(`1b. Button shows 'Exporting...' while the request is in flight (got "${loadingText}")`, !!loadingText?.includes("Exporting..."));
    check("1c. Button is disabled while the request is in flight", !(await exportButton.isEnabled()));

    const [unfilteredDownload] = await Promise.all([page.waitForEvent("download"), clickPromise]);
    await page.unroute("**/api/projects/export**");
    const recoveredText = await exportButton.textContent();
    check(`1d. Button recovers to 'Export to Excel' after a successful download (got "${recoveredText}")`, !!recoveredText?.includes("Export to Excel"));
    check("1e. Button re-enables after a successful download", await exportButton.isEnabled());
    const unfilteredPath = await unfilteredDownload.path();
    check("2. Unfiltered export downloaded a file", unfilteredPath !== null);
    check("3. Downloaded filename has a .xlsx extension", unfilteredDownload.suggestedFilename().endsWith(".xlsx"));

    const unfilteredWb = await readWorkbook(unfilteredPath!);
    const unfilteredSheet = unfilteredWb.getWorksheet("Projects");
    check("4. Unfiltered workbook has a 'Projects' worksheet", !!unfilteredSheet);
    const unfilteredHeaders = unfilteredSheet!.getRow(1).values as unknown[];
    check(
      "5. Header row has the expected readable columns",
      ["Title", "Status", "Priority", "Origin", "Workspace", "Owner(s)", "Members", "Activities", "Progress (%)", "Overdue", "Expected Start", "Expected Finish", "Start Date", "Due Date", "Created", "Description"].every((h) =>
        unfilteredHeaders.includes(h)
      )
    );
    check("6. Header row is bold (visually distinguishable)", unfilteredSheet!.getRow(1).font?.bold === true);
    check("7. Autofilter is enabled on the header row", !!unfilteredSheet!.autoFilter);
    const unfilteredTitles = sheetTitles(unfilteredSheet!);
    check("8. Both fixture projects appear with no filters active", unfilteredTitles.includes(manualProject.title) && unfilteredTitles.includes(inProgressProject.title));

    // Spot-check one data row's Start Date cell is a real Excel date (not a pre-formatted string).
    let startDateCell: ExcelJS.Cell | undefined;
    unfilteredSheet!.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(1).value === manualProject.title) startDateCell = row.getCell(13);
    });
    check(
      "9. Manual Project's Start Date cell is a real Date value with a date number format",
      startDateCell?.value instanceof Date && typeof startDateCell?.numFmt === "string" && startDateCell.numFmt.includes("mmm")
    );

    // ══════════════════════ /projects — export WITH an active filter ══════════════════════
    console.log("\n=== /projects export — WITH an active filter (status=IN_PROGRESS) ===\n");
    await page.goto(`${BASE_URL}/projects?departmentId=${dept.id}&search=${encodeURIComponent(TAG)}&status=IN_PROGRESS`, { waitUntil: "load" });
    const [filteredDownload] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-projects-button").click()]);
    const filteredPath = await filteredDownload.path();
    const filteredWb = await readWorkbook(filteredPath!);
    const filteredTitles = sheetTitles(filteredWb.getWorksheet("Projects")!);
    check("10. Filtered export (status=IN_PROGRESS) includes only the matching project", filteredTitles.includes(inProgressProject.title) && !filteredTitles.includes(manualProject.title));
    check("11. Filtered export respects the SAME filter the on-screen list currently shows", (await page.locator("table tbody tr", { hasText: TAG }).count()) === 1);

    // ══════════════════════ Button responsiveness — no loading/disabled lock, no console errors ══════════════════════
    console.log("\n=== Button responsiveness and error surface ===\n");
    const stillEnabled = await page.getByTestId("export-projects-button").isEnabled();
    check("12. Export button remains enabled/clickable immediately after a download (no stuck disabled/loading state)", stillEnabled);
    const [secondDownload] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-projects-button").click()]);
    check("13. A second, immediate click downloads again without error", (await secondDownload.path()) !== null);
    check("14. No browser console errors occurred during the /projects export flow", consoleErrors.length === 0, consoleErrors.join(" | "));
    check("15. No uncaught page errors occurred during the /projects export flow", pageErrors.length === 0, pageErrors.join(" | "));

    // ══════════════════════ /projects/[id] — detail export ══════════════════════
    console.log("\n=== /projects/[id] export — Project Details + Financials + Activities ===\n");
    consoleErrors.length = 0;
    pageErrors.length = 0;
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    const detailExportButton = page.getByTestId("export-project-button");
    check("16. Export to Excel button is visible on the Project detail page", await detailExportButton.isVisible());
    const [detailDownload] = await Promise.all([page.waitForEvent("download"), detailExportButton.click()]);
    const detailPath = await detailDownload.path();
    check("17. Detail export downloaded a file", detailPath !== null);
    const detailWb = await readWorkbook(detailPath!);
    const sheetNames = detailWb.worksheets.map((s) => s.name);
    check("18. Detail workbook has exactly 3 worksheets: Project Details, Financials, Activities", sheetNames.join(",") === "Project Details,Financials,Activities");

    const detailsSheet = detailWb.getWorksheet("Project Details")!;
    let titleValue: unknown;
    let statusValue: unknown;
    detailsSheet.eachRow((row) => {
      if (row.getCell(1).value === "Title") titleValue = row.getCell(2).value;
      if (row.getCell(1).value === "Status") statusValue = row.getCell(2).value;
    });
    check("19. Project Details sheet's Title row matches the real Project title", titleValue === manualProject.title);
    check("20. Project Details sheet's Status row is a readable label, not a raw enum", statusValue === "PLANNING");

    const financialsSheet = detailWb.getWorksheet("Financials")!;
    let totalEstimated: unknown;
    let totalActual: unknown;
    financialsSheet.eachRow((row) => {
      if (row.getCell(1).value === "TOTAL") {
        totalEstimated = row.getCell(6).value;
        totalActual = row.getCell(7).value;
      }
    });
    check(`21. Financials TOTAL estimated cost matches the fixture (150*4=600, got ${totalEstimated})`, totalEstimated === 600);
    check(`22. Financials TOTAL actual cost matches the fixture (150*2=300, got ${totalActual})`, totalActual === 300);
    const estimatedCostColIndex = (financialsSheet.getRow(1).values as unknown[]).indexOf("Estimated Cost (EUR)");
    check("23. Financials cost columns are formatted as currency (€)", !!financialsSheet.getColumn(estimatedCostColIndex).numFmt?.includes("€"));

    const activitiesSheet = detailWb.getWorksheet("Activities")!;
    check("24. Activities sheet lists the fixture Activity", sheetTitles(activitiesSheet).includes(`${TAG} Activity A`));

    check("25. No browser console errors during the detail export flow", consoleErrors.length === 0, consoleErrors.join(" | "));
    check("26. No uncaught page errors during the detail export flow", pageErrors.length === 0, pageErrors.join(" | "));

    // ══════════════════════ Error path — a failed request shows a visible toast and the button recovers ══════════════════════
    console.log("\n=== Error path — a failed export request shows a visible error toast and the button recovers ===\n");
    consoleErrors.length = 0;
    pageErrors.length = 0;
    await page.route("**/api/projects/export**", (route) => route.abort("failed"));
    await page.goto(`${BASE_URL}/projects?departmentId=${dept.id}&search=${encodeURIComponent(TAG)}`, { waitUntil: "load" });
    const failButton = page.getByTestId("export-projects-button");
    await failButton.click();

    const toastLocator = page.locator("[data-sonner-toast]").first();
    const toastVisible = await toastLocator.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("27. A failed export request shows a visible error toast", toastVisible);
    const toastText = toastVisible ? await toastLocator.textContent().catch(() => null) : null;
    check(`28. The toast communicates a failure (got ${JSON.stringify(toastText)})`, !!toastText && /fail/i.test(toastText));
    check("29. Page remains interactive after a failed export request (no crash/blank page)", await failButton.isVisible());
    check(
      `30. Button recovers to 'Export to Excel' and re-enables after the failed request (got "${await failButton.textContent()}")`,
      (await failButton.textContent())?.includes("Export to Excel") === true && (await failButton.isEnabled())
    );
    check("31. No uncaught page errors during the failed export flow", pageErrors.length === 0, pageErrors.join(" | "));
    await page.unroute("**/api/projects/export**");
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { project: { id: { in: projectIds } } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
