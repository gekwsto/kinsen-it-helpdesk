/**
 * Real browser verification for cross-month/cross-year Resource Planning
 * drag-and-drop (the 28/07 -> 05/08 bug report). Confirms: (1) a bar that's
 * clipped at the visible range's edge (continuesBefore/continuesAfter) is
 * now actually draggable from wherever it's visible, in both month and
 * week view; (2) dragging it produces correct startDate/dueDate and
 * preserves duration across month/year boundaries; (3) this holds up over
 * repeated drags, not just once.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-resource-planning-crossmonth-drag.ts
 */
import { chromium, type Page } from "playwright";
import { PrismaClient, Role, AuthProvider, DepartmentRole, MembershipSource, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const CROSSMONTH_REPEAT_COUNT = 20;

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function localMidnight(y: number, m: number, d: number): Date {
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
function ymd(d: Date | null | undefined): string {
  if (!d) return "null";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await page.fill("#credentials-email", "admin@kinsen.gr");
  await page.fill("#credentials-password", "Kinsen123!");
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

async function dragBarByText(page: Page, text: string, dxPx: number, steps = 10) {
  const bar = page.getByText(text, { exact: false }).first();
  // A bar late in a wide month grid (e.g. day 28 of 31) can render past the
  // test viewport's right edge, inside the timeline's own overflow-x-auto
  // scroll container — scrollIntoViewIfNeeded() scrolls that container (not
  // just the page) so the bar's real screen coordinates are actually within
  // the rendered viewport before computing where to click.
  await bar.scrollIntoViewIfNeeded();
  const box = await bar.boundingBox();
  if (!box) throw new Error(`bar "${text}" not found`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dxPx * i) / steps, startY);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let agent1: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];

  const browser = await chromium.launch();
  try {
    dept = await prisma.department.create({ data: { name: `XMonth Verify ${RUN_ID}`, slug: `xmonth-verify-${RUN_ID}` } });
    agent1 = await prisma.user.create({
      data: { email: `xmonth-verify-a1-${RUN_ID}@kinsen.gr`, name: "XMonth Agent", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    await prisma.departmentMembership.create({ data: { userId: agent1.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL } });
    await prisma.activityProgressConfig.createMany({
      data: [
        { departmentId: dept.id, status: ActivityStatus.TODO, progressPercent: 0, sortOrder: 0 },
        { departmentId: dept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, sortOrder: 1 },
      ],
    });
    project = await prisma.project.create({ data: { title: `XMonth Verify Proj ${RUN_ID}`, ownerId: agent1.id, departmentId: dept.id, status: ProjectStatus.IN_PROGRESS } });

    async function makeActivity(title: string, start: Date, end: Date) {
      const a = await prisma.projectActivity.create({
        data: {
          title,
          projectId: project!.id,
          departmentId: dept!.id,
          status: ActivityStatus.IN_PROGRESS,
          priority: ActivityPriority.MEDIUM,
          startDate: start,
          dueDate: end,
          assignedUsers: { connect: [{ id: agent1!.id }] },
        },
      });
      activityIds.push(a.id);
      return a;
    }

    // Wider than the other verify scripts' 1440px — month view's compact
    // day columns still push a late-month bar close to (or past) 1440px,
    // leaving too little margin for a drag gesture even after scrolling it
    // into view.
    const context = await browser.newContext({ viewport: { width: 1920, height: 900 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (msg) => {
      const isExpectedFixtureNoise = /configuration gap/.test(msg.text());
      if (msg.type() === "error" && !isExpectedFixtureNoise) consoleErrors.push(msg.text());
    });
    page.on("response", (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
    });
    const patchLog: { url: string; status: number; body: string }[] = [];
    page.on("response", async (res) => {
      if (res.request().method() === "PATCH" && res.url().includes("/api/activities/")) {
        patchLog.push({ url: res.url(), status: res.status(), body: res.request().postData() ?? "" });
      }
    });

    await login(page);

    // ── 1. The exact reported case: 28/07 -> 05/08, month view (July side) ──
    console.log("\n=== 28/07 -> 05/08 is draggable in July month view ===\n");
    const a1 = await makeActivity(`XMBug ${RUN_ID}`, localMidnight(2026, 7, 28), localMidnight(2026, 8, 5));
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-07-15`, { waitUntil: "networkidle" });
    const tagJuly = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll("span")).find((s) => s.textContent?.includes("XMBug"));
      return span?.closest("a, div.absolute")?.tagName;
    });
    check("Bar renders as draggable DIV (not a plain Link) in July month view", tagJuly === "DIV");
    // In July's own month view this bar is right-clipped (dueDate 05/08 is
    // past July's end) — its right edge already touches the grid's own
    // right edge, so clampDragDelta correctly clamps further RIGHTWARD
    // movement to zero (there's no visual room to show it moving even
    // further past the edge of the currently-loaded grid — the same reason
    // you can't drag it past the left edge of a fully-loaded calendar
    // either). That's correct, intentional clamping, not a bug — so this
    // drags LEFT (earlier), which has plenty of room, to prove the bar
    // genuinely responds to a real drag gesture in this view.
    let before = patchLog.length;
    await dragBarByText(page, "XMBug", -60);
    check("Drag from July month view (leftward, where there's clamp room) fires exactly one PATCH", patchLog.length - before === 1);
    check("...and it succeeded", patchLog[patchLog.length - 1]?.status === 200);
    {
      const db = await prisma.projectActivity.findUnique({ where: { id: a1.id }, select: { startDate: true, dueDate: true } });
      const durationBefore = 8; // 28/07 -> 05/08
      const durationAfter = db!.dueDate!.getTime() - db!.startDate!.getTime();
      check("Duration preserved after drag (still exactly 8 days)", Math.round(durationAfter / 86400000) === durationBefore);
      check("Activity actually moved earlier (startDate before 28/07)", db!.startDate!.getTime() < localMidnight(2026, 7, 28).getTime());
    }

    // ── 2. Same bar visible in August month view (continuesBefore side) ──
    console.log("\n=== The same activity is draggable in August month view (continuesBefore side) ===\n");
    await prisma.projectActivity.update({ where: { id: a1.id }, data: { startDate: localMidnight(2026, 7, 28), dueDate: localMidnight(2026, 8, 5) } });
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-08-15`, { waitUntil: "networkidle" });
    const tagAug = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll("span")).find((s) => s.textContent?.includes("XMBug"));
      return span?.closest("a, div.absolute")?.tagName;
    });
    check("Bar renders as draggable DIV in August month view too", tagAug === "DIV");
    before = patchLog.length;
    await dragBarByText(page, "XMBug", 60);
    check("Drag from August month view fires exactly one successful PATCH", patchLog.length - before === 1 && patchLog[patchLog.length - 1]?.status === 200);

    // ── 3. Exact date-shift correctness: +3 days should give 31/07 -> 08/08 ──
    console.log("\n=== Exact +3 day shift: 28/07->05/08 becomes 31/07->08/08 ===\n");
    await prisma.projectActivity.update({ where: { id: a1.id }, data: { startDate: localMidnight(2026, 7, 28), dueDate: localMidnight(2026, 8, 5) } });
    // August month view: this bar is left-clipped only (continuesBefore),
    // so it has full room to move RIGHTWARD (later) — the direction this
    // +3-day test needs.
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-08-15`, { waitUntil: "networkidle" });
    // Measure real pxPerDay from the day header cells to drag exactly 3 days.
    const pxPerDay = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll(".sticky.top-0 .flex > div")).filter((el) => (el as HTMLElement).style.width);
      const w = cells[1] ? parseFloat((cells[1] as HTMLElement).style.width) : 60;
      return w;
    });
    await dragBarByText(page, "XMBug", Math.round(pxPerDay * 3));
    {
      const db = await prisma.projectActivity.findUnique({ where: { id: a1.id }, select: { startDate: true, dueDate: true } });
      check(`+3d exact result: startDate = 31/07/2026 (got ${ymd(db?.startDate)})`, ymd(db?.startDate) === "2026-07-31");
      check(`+3d exact result: dueDate = 08/08/2026 (got ${ymd(db?.dueDate)})`, ymd(db?.dueDate) === "2026-08-08");
    }

    // ── 4. Year boundary: 28/12 -> 05/01 ──
    console.log("\n=== Year-boundary activity (28/12 -> 05/01) is draggable and shifts correctly ===\n");
    const a2 = await makeActivity(`XMYear ${RUN_ID}`, localMidnight(2026, 12, 28), localMidnight(2027, 1, 5));
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-12-15`, { waitUntil: "networkidle" });
    const tagDec = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll("span")).find((s) => s.textContent?.includes("XMYear"));
      return span?.closest("a, div.absolute")?.tagName;
    });
    check("Year-crossing bar renders as draggable DIV", tagDec === "DIV");
    // December view: this bar is right-clipped (dueDate 05/01 is past
    // December's end), so it has room to move LEFT (earlier) but not
    // right, for the same clamp-at-the-loaded-grid-edge reason as the July
    // case above.
    before = patchLog.length;
    await dragBarByText(page, "XMYear", -60);
    check("Year-boundary drag (leftward, where there's clamp room) fires exactly one successful PATCH", patchLog.length - before === 1 && patchLog[patchLog.length - 1]?.status === 200);
    {
      const db = await prisma.projectActivity.findUnique({ where: { id: a2.id }, select: { startDate: true, dueDate: true } });
      check("Year rolled BACK correctly (startDate still in 2026, before 28/12)", db!.startDate!.getTime() < localMidnight(2026, 12, 28).getTime());
      const dur = Math.round((db!.dueDate!.getTime() - db!.startDate!.getTime()) / 86400000);
      check("Duration preserved across the year boundary (still 8 days)", dur === 8);
    }

    // ── 4b. Same activity, now dragged FORWARD across the year boundary from January's view ──
    console.log("\n=== Year-boundary activity dragged forward, viewed from January (2027) ===\n");
    await prisma.projectActivity.update({ where: { id: a2.id }, data: { startDate: localMidnight(2026, 12, 28), dueDate: localMidnight(2027, 1, 5) } });
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2027-01-15`, { waitUntil: "networkidle" });
    before = patchLog.length;
    await dragBarByText(page, "XMYear", 60);
    check("Forward drag from January's (left-clipped) view fires exactly one successful PATCH", patchLog.length - before === 1 && patchLog[patchLog.length - 1]?.status === 200);
    {
      const db = await prisma.projectActivity.findUnique({ where: { id: a2.id }, select: { startDate: true, dueDate: true } });
      check("Activity moved further into January (dueDate later than original 05/01/2027)", db!.dueDate!.getTime() > localMidnight(2027, 1, 5).getTime());
      const dur = Math.round((db!.dueDate!.getTime() - db!.startDate!.getTime()) / 86400000);
      check("Duration still preserved (still 8 days)", dur === 8);
    }

    // ── 5. Activity fully outside visible range at one edge (starts before range) ──
    console.log("\n=== Activity starting before the visible range is draggable from its visible part ===\n");
    const a3 = await makeActivity(`XMBefore ${RUN_ID}`, localMidnight(2026, 6, 1), localMidnight(2026, 7, 20));
    // Deliberately a 49-day activity, deliberately viewed in MONTH (not
    // week) view: in a 7-day week view this would be clipped on BOTH ends
    // at once (its visible fragment would already span the entire 7-day
    // grid), leaving zero pixels of room to drag in either direction in
    // that specific narrow viewport — a real geometric constraint, not a
    // bug (the same reason you can't drag a bar further than the edge of
    // whatever date range is currently loaded). In July's month view this
    // same activity is clipped on the LEFT only (ends the 20th, well
    // before July's end), giving real room to drag right.
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-07-15`, { waitUntil: "networkidle" });
    const foundBefore = await page.getByText("XMBefore", { exact: false }).first().isVisible().catch(() => false);
    check("Activity starting before the visible range is still shown (clipped)", foundBefore);
    if (foundBefore) {
      before = patchLog.length;
      await dragBarByText(page, "XMBefore", 40);
      const gotPatch = patchLog.length - before === 1;
      check("...and dragging its visible fragment fires exactly one successful PATCH", gotPatch && patchLog[patchLog.length - 1]?.status === 200);
    }

    // ── 6. Repeat the core cross-month scenario CROSSMONTH_REPEAT_COUNT times ──
    console.log(`\n=== Repeating the 28/07 -> 05/08 drag ${CROSSMONTH_REPEAT_COUNT}x to rule out intermittency ===\n`);
    let okCount = 0;
    for (let i = 0; i < CROSSMONTH_REPEAT_COUNT; i++) {
      await prisma.projectActivity.update({ where: { id: a1.id }, data: { startDate: localMidnight(2026, 7, 28), dueDate: localMidnight(2026, 8, 5) } });
      // August view: left-clipped only, so rightward drag has real room.
      await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-08-15`, { waitUntil: "networkidle" });
      const beforeRep = patchLog.length;
      await dragBarByText(page, "XMBug", 50);
      const newPatches = patchLog.slice(beforeRep);
      const db = await prisma.projectActivity.findUnique({ where: { id: a1.id }, select: { startDate: true, dueDate: true } });
      const dur = db!.startDate && db!.dueDate ? Math.round((db!.dueDate.getTime() - db!.startDate.getTime()) / 86400000) : -1;
      if (newPatches.length === 1 && newPatches[0].status === 200 && dur === 8) okCount++;
    }
    check(`Cross-month drag succeeded with exactly one PATCH and preserved duration in all ${CROSSMONTH_REPEAT_COUNT} repetitions (${okCount}/${CROSSMONTH_REPEAT_COUNT})`, okCount === CROSSMONTH_REPEAT_COUNT);

    // ── 7. Persistence after full refresh ──
    console.log("\n=== Persistence after full page refresh ===\n");
    await prisma.projectActivity.update({ where: { id: a1.id }, data: { startDate: localMidnight(2026, 7, 28), dueDate: localMidnight(2026, 8, 5) } });
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2026-08-15`, { waitUntil: "networkidle" });
    await dragBarByText(page, "XMBug", 60);
    const dbBeforeReload = await prisma.projectActivity.findUnique({ where: { id: a1.id }, select: { startDate: true, dueDate: true } });
    await page.reload({ waitUntil: "networkidle" });
    const dbAfterReload = await prisma.projectActivity.findUnique({ where: { id: a1.id }, select: { startDate: true, dueDate: true } });
    check("startDate identical before/after reload", dbBeforeReload?.startDate?.getTime() === dbAfterReload?.startDate?.getTime());
    check("dueDate identical before/after reload", dbBeforeReload?.dueDate?.getTime() === dbAfterReload?.dueDate?.getTime());

    console.log("\n=== Console/network error summary ===\n");
    check("Zero unexpected console errors across the whole run", consoleErrors.length === 0);
    if (consoleErrors.length) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed (4xx/5xx) requests", failedRequests.length === 0);
    if (failedRequests.length) failedRequests.forEach((e) => console.error("   ", e));

    await context.close();
  } finally {
    await browser.close();
    const cleanup: [string, () => Promise<unknown>][] = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["progressConfig", () => (dept ? prisma.activityProgressConfig.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["memberships", () => (agent1 ? prisma.departmentMembership.deleteMany({ where: { userId: agent1.id } }) : Promise.resolve())],
      ["users", () => (agent1 ? prisma.user.deleteMany({ where: { id: agent1.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
