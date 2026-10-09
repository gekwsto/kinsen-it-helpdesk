/**
 * Visual/responsive verification for the Project Edit and Activity Edit
 * pages' layout redesign (app/(main)/projects/[id]/edit/page.tsx,
 * app/(main)/activities/[id]/edit/activity-edit-client.tsx) — widened from
 * max-w-2xl to max-w-4xl with responsive 2-column field grouping.
 *
 * For each page, exercises BOTH the plain variant (manual Project / a
 * Standalone Activity — the simple, narrower form) and the densest variant
 * (a request-origin Project/Activity, which renders the full conditional
 * "Project Request Setup" block, including the Task Sub Type manual-cost
 * nested field) at every required viewport width: 390, 768, 1440, 1920,
 * 2560. Screenshots are saved for visual review; `scrollWidth >
 * clientWidth` on <html> is checked programmatically at every width as the
 * objective "no horizontal overflow" signal.
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention). Fixture data is created fresh and
 * tagged/cleaned up — no existing/real Project or Activity is ever touched.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-edit-pages-responsive.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ProjectStatus, ProjectRequestStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bverp-${RUN_ID}`;
const SHOT_DIR = "/tmp/claude-501/edit-pages-responsive-shots";

const WIDTHS = [390, 768, 1440, 1920, 2560];

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

async function checkNoOverflowAndShot(page: Page, url: string, width: number, label: string, shotName: string) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(400);
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(`${label} @ ${width}px — no horizontal overflow (scrollWidth ${scrollWidth} <= clientWidth ${clientWidth})`, scrollWidth <= clientWidth);
  // Neither `page.screenshot({ fullPage: true })` (captures document.documentElement's
  // scrollHeight, which stays pinned at one viewport height here — see
  // app/(main)/layout.tsx's `overflow-y-auto` on an INNER <main>, not
  // <body>/<html>) nor `locator("main").screenshot()` (captures only the
  // element's current, already-clipped rendered box, not its scrollable
  // content) produce a full-content screenshot for this layout. Instead:
  // measure <main>'s real scrollHeight, resize the viewport tall enough
  // that nothing needs to scroll, then take a plain viewport screenshot.
  const mainScrollHeight = await page.locator("main").evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width, height: mainScrollHeight + 80 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOT_DIR}/${shotName}-${width}.png` });
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  mkdirSync(SHOT_DIR, { recursive: true });

  const deptIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const projectRequestIds: string[] = [];
  const taskSubTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    // Plain/manual Project — the simple variant.
    const manualProject = await prisma.project.create({
      data: { title: `${TAG} Manual Project`, status: ProjectStatus.PLANNING, priority: 2, ownerId: admin.id, departmentId: dept.id },
    });
    projectIds.push(manualProject.id);

    // Request-origin Project — the dense variant, renders the full
    // "Project Request Setup" block (Expected dates, Expense Type,
    // Estimated/Actual Cost, External).
    const noCostSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-no-cost-subtype`, cost: null } });
    taskSubTypeIds.push(noCostSubType.id);
    const pr = await prisma.projectRequest.create({
      data: {
        title: `${TAG} Request`,
        description: "fixture",
        importance: 2,
        teamConcerned: "IT",
        expectedBenefits: "fixture",
        requesterId: admin.id,
        departmentId: dept.id,
        status: ProjectRequestStatus.APPROVED,
      },
    });
    projectRequestIds.push(pr.id);
    const requestOriginProject = await prisma.project.create({
      data: {
        title: `${TAG} Request-Origin Project`,
        status: ProjectStatus.IN_PROGRESS,
        priority: 2,
        ownerId: admin.id,
        departmentId: dept.id,
        projectRequestId: pr.id,
        expectedStartDate: new Date("2026-01-01"),
        expectedFinishDate: new Date("2026-03-01"),
        expectedTotalInitialDays: 59,
      },
    });
    projectIds.push(requestOriginProject.id);

    // Plain/standalone Activity — the simple variant.
    const standaloneActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Standalone Activity`, departmentId: dept.id },
    });
    activityIds.push(standaloneActivity.id);

    // Request-origin Activity — the dense variant, including the Task Sub
    // Type manual-cost nested field (the tallest/most complex sub-block).
    const requestOriginActivity = await prisma.projectActivity.create({
      data: {
        title: `${TAG} Request-Origin Activity`,
        projectId: requestOriginProject.id,
        departmentId: dept.id,
        taskSubTypeId: noCostSubType.id,
        taskSubTypeCost: 250,
        expectedStartDate: new Date("2026-01-05"),
        expectedFinishDate: new Date("2026-01-20"),
        expectedDays: 15,
      },
    });
    activityIds.push(requestOriginActivity.id);

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);
    check("0. Logged in as the demo Admin account", !page.url().includes("/login"));

    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/projects/${manualProject.id}/edit`, width, "Project Edit (manual, simple)", "project-edit-manual");
    }
    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/projects/${requestOriginProject.id}/edit`, width, "Project Edit (request-origin, dense)", "project-edit-request-origin");
    }
    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/activities/${standaloneActivity.id}/edit`, width, "Activity Edit (standalone, simple)", "activity-edit-standalone");
    }
    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/activities/${requestOriginActivity.id}/edit`, width, "Activity Edit (request-origin, dense)", "activity-edit-request-origin");
    }

    // Functional sanity — Save/Cancel still present and the existing
    // fields are intact (DO NOT list forbids any logic change; this is a
    // smoke check that the redesign didn't drop/rename anything).
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE_URL}/projects/${manualProject.id}/edit`, { waitUntil: "load" });
    check("Project Edit — Title field present with existing value", (await page.locator("#title").inputValue()) === manualProject.title);
    check("Project Edit — Save Changes button present", await page.getByRole("button", { name: "Save Changes" }).isVisible());
    check("Project Edit — Cancel button present", await page.getByRole("button", { name: "Cancel" }).isVisible());

    await page.goto(`${BASE_URL}/projects/${requestOriginProject.id}/edit`, { waitUntil: "load" });
    check("Project Edit (request-origin) — Expected Start Date field present with existing value", (await page.locator("#expectedStartDate").inputValue()) === "2026-01-01");
    check("Project Edit (request-origin) — Expected Total Initial Days readonly field shows the baseline", (await page.locator("#expectedTotalInitialDays").inputValue()).includes("59"));

    await page.goto(`${BASE_URL}/activities/${standaloneActivity.id}/edit`, { waitUntil: "load" });
    check("Activity Edit — Title field present with existing value", (await page.locator("#title").inputValue()) === standaloneActivity.title);
    check("Activity Edit — Task Type field (required) present", await page.locator("#task-type").isVisible());

    await page.goto(`${BASE_URL}/activities/${requestOriginActivity.id}/edit`, { waitUntil: "load" });
    check("Activity Edit (request-origin) — manual Estimated Cost field present with existing snapshot", (await page.locator("#manual-estimated-cost").inputValue()) === "250");
    check("Activity Edit (request-origin) — Expected Days readonly field shows the derived value", (await page.locator("#expected-days").inputValue()).includes("15"));
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
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
  console.log(`Screenshots saved under ${SHOT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
