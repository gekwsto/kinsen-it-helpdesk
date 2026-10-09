/**
 * Visual/responsive verification for the Project Details and Activity
 * Details page layout redesign (app/(main)/projects/[id]/page.tsx,
 * app/(main)/activities/[id]/activity-detail-client.tsx) — widened
 * containers (max-w-5xl -> max-w-7xl, max-w-3xl -> max-w-6xl) and a
 * responsive right-rail grid grouping "at a glance" cards together.
 *
 * Exercises the DENSEST variant of each page (a request-origin Project
 * with Activities/Financials/Success Target/a Linked Goal/Related Tickets,
 * and an Activity with Dependencies + Related Tickets) at every required
 * width: 1440/1920/2560 (desktop) plus 390 (mobile). Screenshots are saved
 * for visual review; `scrollWidth > clientWidth` is checked programmatically
 * at every width as the objective "no horizontal overflow" signal.
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-detail-pages-responsive.ts
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ProjectStatus, ProjectRequestStatus, ActivityStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvdp-${RUN_ID}`;
const SHOT_DIR = "/tmp/claude-501/detail-pages-responsive-shots";

const WIDTHS = [390, 1440, 1920, 2560];

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
  await page.waitForTimeout(500);
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(`${label} @ ${width}px — no horizontal overflow (scrollWidth ${scrollWidth} <= clientWidth ${clientWidth})`, scrollWidth <= clientWidth);
  // See browser-verify-edit-pages-responsive.ts's own comment on this exact
  // pattern — this app's <main> scrolls internally while <body>/<html>
  // stay pinned at 100vh, so a plain fullPage screenshot truncates to one
  // viewport height. Resize tall enough that nothing needs to scroll first.
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
  const expenseTypeIds: string[] = [];
  const yearlyGoalIds: string[] = [];
  const ticketIds: string[] = [];
  const dependencyIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    const ticketStatus = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id }, select: { id: true } });

    const costSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-cost-subtype`, cost: 150 } });
    taskSubTypeIds.push(costSubType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expense-type` } });
    expenseTypeIds.push(expenseType.id);

    // ══════════════════════ Dense Project fixture ══════════════════════
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

    const project = await prisma.project.create({
      data: {
        title: `${TAG} Dense Project`,
        description: "A fixture project exercising every card on the Project Details page at once.",
        status: ProjectStatus.IN_PROGRESS,
        priority: 3,
        ownerId: admin.id,
        departmentId: dept.id,
        projectRequestId: pr.id,
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-06-01"),
        successTarget: "Deliver the fixture on time and under budget, validated by this very screenshot.",
        expenseTypeId: expenseType.id,
        external: true,
        expectedStartDate: new Date("2026-01-01"),
        expectedFinishDate: new Date("2026-04-01"),
        expectedTotalInitialDays: 90,
        owners: { connect: [{ id: admin.id }] },
        members: { connect: [{ id: admin.id }] },
      },
    });
    projectIds.push(project.id);

    const goal = await prisma.yearlyGoal.create({
      data: { year: 2026, ownerUserId: admin.id, status: "ON_TRACK", projects: { connect: { id: project.id } } },
    });
    yearlyGoalIds.push(goal.id);

    for (let i = 0; i < 3; i++) {
      const a = await prisma.projectActivity.create({
        data: {
          title: `${TAG} Project Activity ${i}`,
          projectId: project.id,
          departmentId: dept.id,
          status: i === 0 ? ActivityStatus.COMPLETED : ActivityStatus.IN_PROGRESS,
          isCompleted: i === 0,
          taskSubTypeId: costSubType.id,
          taskSubTypeCost: 150,
          expectedDays: 5,
          actualDays: i === 0 ? 4 : null,
          sequence: i,
        },
      });
      activityIds.push(a.id);
    }

    const projectTicket = await prisma.ticket.create({
      data: {
        title: `${TAG} Project Ticket`,
        description: "fixture",
        requesterId: admin.id,
        departmentId: dept.id,
        statusId: ticketStatus.id,
        projectId: project.id,
      },
    });
    ticketIds.push(projectTicket.id);

    // ══════════════════════ Dense Activity fixture (Dependencies + Related Tickets) ══════════════════════
    const activityA = await prisma.projectActivity.create({
      data: { title: `${TAG} Dense Activity`, departmentId: dept.id, description: "A fixture standalone Activity exercising Dependencies + Related Tickets side by side." },
    });
    activityIds.push(activityA.id);
    const activityB = await prisma.projectActivity.create({
      data: { title: `${TAG} Dependency Activity`, departmentId: dept.id },
    });
    activityIds.push(activityB.id);

    const dependency = await prisma.activityDependency.create({
      data: { predecessorId: activityB.id, successorId: activityA.id, type: "FINISH_TO_START" },
    });
    dependencyIds.push(dependency.id);

    const activityTicket = await prisma.ticket.create({
      data: {
        title: `${TAG} Activity Ticket`,
        description: "fixture",
        requesterId: admin.id,
        departmentId: dept.id,
        statusId: ticketStatus.id,
        activityId: activityA.id,
      },
    });
    ticketIds.push(activityTicket.id);

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);
    check("0. Logged in as the demo Admin account", !page.url().includes("/login"));

    console.log("\n=== Project Details (dense: Activities + Financials + Success Target + Linked Goal + Related Tickets) ===\n");
    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/projects/${project.id}`, width, "Project Details (dense)", "project-details-dense");
    }

    console.log("\n=== Activity Details (dense: Dependencies + Related Tickets) ===\n");
    for (const width of WIDTHS) {
      await checkNoOverflowAndShot(page, `${BASE_URL}/activities/${activityA.id}`, width, "Activity Details (dense)", "activity-details-dense");
    }

    // ══════════════════════ Layout structure checks at 1920px ══════════════════════
    console.log("\n=== Layout structure at 1920px ===\n");
    await page.setViewportSize({ width: 1920, height: 1100 });
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(400);

    const activitiesCardBox = await page.getByRole("heading", { name: /^Activities/ }).first().boundingBox().catch(() => null);
    const relatedTicketsHeading = page.getByRole("heading", { name: /Related Tickets/ });
    const relatedTicketsBox = await relatedTicketsHeading.boundingBox().catch(() => null);
    check("1. Activities card and Related Tickets card are both present", !!activitiesCardBox && !!relatedTicketsBox);
    check(
      "2. Related Tickets sits to the RIGHT of Activities (same row, right rail), not below it",
      !!activitiesCardBox && !!relatedTicketsBox && relatedTicketsBox.x > activitiesCardBox.x + activitiesCardBox.width / 2
    );

    const successTargetHeading = page.getByRole("heading", { name: "Success Target" });
    const successTargetBox = await successTargetHeading.boundingBox().catch(() => null);
    check(
      "3. Success Target sits BELOW Related Tickets in the SAME right-hand column (not wrapped under Activities)",
      !!relatedTicketsBox && !!successTargetBox && successTargetBox.y > relatedTicketsBox.y && Math.abs(successTargetBox.x - relatedTicketsBox.x) < 5
    );

    const linkedGoalsHeading = page.getByRole("heading", { name: /Linked Goals/ });
    const linkedGoalsBox = await linkedGoalsHeading.boundingBox().catch(() => null);
    check(
      "4. Linked Goals continues the SAME right-hand column below Success Target",
      !!successTargetBox && !!linkedGoalsBox && linkedGoalsBox.y > successTargetBox.y && Math.abs(linkedGoalsBox.x - successTargetBox.x) < 5
    );

    const notesHeading = page.getByRole("heading", { name: /^Notes/ }).first();
    const notesBox = await notesHeading.boundingBox().catch(() => null);
    check(
      "5. Notes section spans back to full page width below the grid (starts at the SAME x as Activities, not the right rail)",
      !!activitiesCardBox && !!notesBox && Math.abs(notesBox.x - activitiesCardBox.x) < 5
    );

    await page.goto(`${BASE_URL}/activities/${activityA.id}`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    const headerCardBox = await page.getByText(activityA.title, { exact: true }).first().boundingBox().catch(() => null);
    const dependenciesHeading = page.getByRole("heading", { name: /Dependencies/ });
    const dependenciesBox = await dependenciesHeading.boundingBox().catch(() => null);
    check("6. Activity header and Dependencies card are both present", !!headerCardBox && !!dependenciesBox);
    check(
      "7. Dependencies sits to the RIGHT of the main activity info (right rail), not below it",
      !!headerCardBox && !!dependenciesBox && dependenciesBox.x > headerCardBox.x + 100
    );
    const activityRelatedTicketsHeading = page.getByRole("heading", { name: /Related Tickets/ });
    const activityRelatedTicketsBox = await activityRelatedTicketsHeading.boundingBox().catch(() => null);
    check(
      "8. Related Tickets continues the SAME right rail below Dependencies",
      !!dependenciesBox && !!activityRelatedTicketsBox && activityRelatedTicketsBox.y > dependenciesBox.y && Math.abs(activityRelatedTicketsBox.x - dependenciesBox.x) < 5
    );

    // ══════════════════════ Mobile (390px): still a clean single column ══════════════════════
    console.log("\n=== Mobile (390px): single-column stacking preserved ===\n");
    await page.setViewportSize({ width: 390, height: 1200 });
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(400);
    const mobileActivitiesBox = await page.getByRole("heading", { name: /^Activities/ }).first().boundingBox().catch(() => null);
    const mobileRelatedTicketsBox = await page.getByRole("heading", { name: /Related Tickets/ }).boundingBox().catch(() => null);
    check(
      "9. At 390px, Related Tickets stacks BELOW Activities (single column), not beside it",
      !!mobileActivitiesBox && !!mobileRelatedTicketsBox && mobileRelatedTicketsBox.y > mobileActivitiesBox.y + mobileActivitiesBox.height - 20
    );
  } finally {
    await browser.close();
    try {
      await prisma.activityDependency.deleteMany({ where: { id: { in: dependencyIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.yearlyGoal.deleteMany({ where: { id: { in: yearlyGoalIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { id: { in: expenseTypeIds } } });
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
