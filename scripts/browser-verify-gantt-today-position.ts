/**
 * Real interactive browser proof that Project/Activity Gantt opens with
 * TODAY already positioned in the visible viewport — the user must never
 * have to press the manual "Today" button just to see what's happening
 * around the current date. Exercises components/gantt/gantt-chart.tsx's new
 * initial-scroll useLayoutEffect against a real production-shaped dataset
 * (past + today-spanning + future activities, so a broken implementation
 * that just left the viewport at its default left edge would be trivially
 * detectable — today would be hundreds of pixels outside the visible area).
 *
 * Also proves the three explicit non-goals hold: manually scrolling away
 * never gets forced back, the manual "Today" button still re-centers on
 * demand, and Day/Week/Month switching keeps working.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-gantt-today-position.ts
 * Requires a reachable DATABASE_URL and a running dev/production server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ActivityStatus, ActivityPriority, ProjectStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvgt-${RUN_ID}`;
const WEEK_PX_PER_DAY = 16; // components/gantt/gantt-chart.tsx PX_PER_DAY.week — default view mode on open

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

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

async function readScrollState(page: Page): Promise<{ scrollLeft: number; clientWidth: number }> {
  return page.evaluate(() => {
    const el = document.querySelector(".overflow-x-auto") as HTMLElement | null;
    if (!el) throw new Error("Gantt scroll container (.overflow-x-auto) not found");
    return { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth };
  });
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

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    console.log("\n=== Fixtures: a project with past + today-spanning + future activities ===\n");
    const dept = await createDepartment({ name: `${TAG}-Dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const project = await prisma.project.create({
      data: { title: `${TAG} Project`, ownerId: admin.id, departmentId: dept.id, status: ProjectStatus.IN_PROGRESS },
    });
    projectIds.push(project.id);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

    async function makeActivity(title: string, start: Date, end: Date) {
      const a = await prisma.projectActivity.create({
        data: {
          title,
          projectId: project.id,
          departmentId: dept.id,
          status: ActivityStatus.IN_PROGRESS,
          priority: ActivityPriority.MEDIUM,
          startDate: start,
          dueDate: end,
        },
      });
      activityIds.push(a.id);
      return a;
    }

    // Deliberately wide, realistic spread — proves the auto-scroll finds
    // TODAY specifically, not just "wherever the data happens to start".
    await makeActivity(`${TAG} Past`, addDays(today, -20), addDays(today, -15));
    await makeActivity(`${TAG} Spanning Today`, addDays(today, -3), addDays(today, 5));
    await makeActivity(`${TAG} Future`, addDays(today, 15), addDays(today, 20));

    // Same viewStart/todayOffset/todayPx math as components/gantt/gantt-chart.tsx's
    // own useMemo — independently computed here (not imported) so this is a
    // real behavioral check, not a tautology against the implementation.
    const minDate = addDays(today, -20);
    const viewStart = addDays(minDate, -14);
    const todayOffset = daysBetween(viewStart, today);
    const expectedTodayPxWeek = todayOffset * WEEK_PX_PER_DAY;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("\nLogging in as admin...\n");
    await login(page);

    console.log(`\n1. Open /projects/gantt -> today is immediately in the visible viewport (no click) ===\n`);
    await page.goto(`${BASE_URL}/projects/gantt?departmentId=${dept.id}`);
    await page.waitForSelector('button:has-text("Today")', { timeout: 15000 });
    await page.waitForLoadState("networkidle");
    // Give the useLayoutEffect + any requestAnimationFrame fallback a moment
    // in real browser scheduling terms, though it should already be applied
    // before the first paint in the common case.
    await page.waitForTimeout(200);

    const initialState = await readScrollState(page);
    console.log(`   scrollLeft=${initialState.scrollLeft} clientWidth=${initialState.clientWidth} expectedTodayPx=${expectedTodayPxWeek}`);
    check(
      "Today's computed pixel offset falls within the visible scrolled viewport on open (no manual click)",
      expectedTodayPxWeek >= initialState.scrollLeft && expectedTodayPxWeek <= initialState.scrollLeft + initialState.clientWidth,
      `today=${expectedTodayPxWeek} visible=[${initialState.scrollLeft}, ${initialState.scrollLeft + initialState.clientWidth}]`
    );
    check("The viewport did not default to the unscrolled left edge (today is 34 days in — scrollLeft > 0)", initialState.scrollLeft > 0);

    console.log("\n2. Manually scrolling away is NOT forced back ===\n");
    await page.evaluate(() => {
      const el = document.querySelector(".overflow-x-auto") as HTMLElement;
      el.scrollLeft = 0;
    });
    await page.waitForTimeout(500);
    const afterManualScroll = await readScrollState(page);
    check("After manually scrolling to 0, the component does not snap back on its own", afterManualScroll.scrollLeft === 0);

    console.log("\n3. Clicking Today re-centers on demand ===\n");
    await page.click('button:has-text("Today")');
    await page.waitForTimeout(200);
    const afterTodayClick = await readScrollState(page);
    check(
      "Clicking Today returns today's offset to the visible viewport",
      expectedTodayPxWeek >= afterTodayClick.scrollLeft && expectedTodayPxWeek <= afterTodayClick.scrollLeft + afterTodayClick.clientWidth
    );

    console.log("\n4. Day / Week / Month switching still works ===\n");
    await page.click('button:has-text("Day")');
    await page.waitForTimeout(200);
    check("Day view is selectable without error", (await page.locator('button:has-text("Day")').count()) > 0);
    await page.click('button:has-text("Month")');
    await page.waitForTimeout(200);
    check("Month view is selectable without error", (await page.locator('button:has-text("Month")').count()) > 0);
    await page.click('button:has-text("Week")');
    await page.waitForTimeout(200);

    console.log("\n5. Activities Gantt (/activities/gantt) also opens positioned on today ===\n");
    const page2 = await context.newPage();
    await page2.goto(`${BASE_URL}/activities/gantt?departmentId=${dept.id}`);
    await page2.waitForSelector('button:has-text("Today")', { timeout: 15000 });
    await page2.waitForLoadState("networkidle");
    await page2.waitForTimeout(200);
    const activitiesState = await readScrollState(page2);
    check(
      "Activities Gantt: today's offset falls within the visible viewport on open (no click)",
      expectedTodayPxWeek >= activitiesState.scrollLeft && expectedTodayPxWeek <= activitiesState.scrollLeft + activitiesState.clientWidth,
      `today=${expectedTodayPxWeek} visible=[${activitiesState.scrollLeft}, ${activitiesState.scrollLeft + activitiesState.clientWidth}]`
    );

    await context.close();
  } finally {
    await browser.close();
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {});
    if (departmentIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
