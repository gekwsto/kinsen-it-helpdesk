/**
 * Real interactive browser reproduction script for the intermittent
 * Resource Planning drag-and-drop bug investigation. Uses playwright
 * against a live `npm run dev` server, driving REAL pointer events
 * (page.mouse.move/down/up — Chromium dispatches these as native pointer
 * events, exactly like a real mouse), and captures the temporary
 * window.__rpDragDebug console instrumentation added to
 * components/resource-planning/resource-timeline.tsx for this
 * investigation (removed once root cause is confirmed and fixed).
 *
 * Not a pass/fail regression test — a diagnostic tool. Creates its own
 * isolated department/resources/activities via Prisma, drives the UI, dumps
 * every [rp-drag] log line + PATCH network activity, and cleans up in a
 * finally block.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-resource-planning-drag-repro.ts
 */
import { chromium, type Page } from "playwright";
import { PrismaClient, Role, AuthProvider, DepartmentRole, MembershipSource, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";

const prisma = new PrismaClient();
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = "Kinsen123!";
const RUN_ID = Date.now();

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let agent1: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let agent2: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let project: Awaited<ReturnType<typeof prisma.project.create>> | undefined;
  const activityIds: string[] = [];
  const membershipIds: string[] = [];
  const extraAgentIds: string[] = [];

  const browser = await chromium.launch();
  try {
    dept = await prisma.department.create({ data: { name: `RP Drag Repro ${RUN_ID}`, slug: `rp-drag-repro-${RUN_ID}` } });
    agent1 = await prisma.user.create({
      data: { email: `rp-drag-agent1-${RUN_ID}@kinsen.gr`, name: "Agent One", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    agent2 = await prisma.user.create({
      data: { email: `rp-drag-agent2-${RUN_ID}@kinsen.gr`, name: "Agent Two", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    const m1 = await prisma.departmentMembership.create({
      data: { userId: agent1.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(m1.id);
    const m2 = await prisma.departmentMembership.create({
      data: { userId: agent2.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(m2.id);

    // Pad the department with extra agents so agent1/agent2's rows are NOT
    // at the very top — needed to test the "row scrolled under the sticky
    // header" hypothesis without also being confounded by "row IS the top
    // row so there's nothing to scroll".
    for (let i = 0; i < 6; i++) {
      const extra = await prisma.user.create({
        data: { email: `rp-drag-pad-${i}-${RUN_ID}@kinsen.gr`, name: `Pad Agent ${i}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
      });
      extraAgentIds.push(extra.id);
      const pm = await prisma.departmentMembership.create({
        data: { userId: extra.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
      });
      membershipIds.push(pm.id);
    }

    // Required or every PATCH /api/activities/[id] rejects with 409
    // configuration_required (progress is always server-re-derived from
    // status) — a fresh department created outside the normal admin flow
    // has none of these rows by default.
    await prisma.activityProgressConfig.createMany({
      data: [
        { departmentId: dept.id, status: ActivityStatus.TODO, progressPercent: 0, sortOrder: 0 },
        { departmentId: dept.id, status: ActivityStatus.IN_PROGRESS, progressPercent: 50, sortOrder: 1 },
        { departmentId: dept.id, status: ActivityStatus.COMPLETED, progressPercent: 100, sortOrder: 2 },
      ],
    });

    project = await prisma.project.create({
      data: { title: `RP Drag Repro Project ${RUN_ID}`, ownerId: agent1.id, departmentId: dept.id, status: ProjectStatus.IN_PROGRESS },
    });

    const monday = new Date();
    const day = monday.getDay();
    const diffToMonday = (day + 6) % 7;
    monday.setDate(monday.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);
    const wed = new Date(monday);
    wed.setDate(wed.getDate() + 2);

    const activity1 = await prisma.projectActivity.create({
      data: {
        title: `Drag Test Activity 1 (${RUN_ID})`,
        projectId: project.id,
        departmentId: dept.id,
        status: ActivityStatus.IN_PROGRESS,
        priority: ActivityPriority.MEDIUM,
        startDate: monday,
        dueDate: wed,
        assignedUsers: { connect: [{ id: agent1.id }] },
      },
    });
    activityIds.push(activity1.id);

    const oneDay = new Date(monday);
    const activity2 = await prisma.projectActivity.create({
      data: {
        title: `Drag Test Activity 2 One-Day (${RUN_ID})`,
        projectId: project.id,
        departmentId: dept.id,
        status: ActivityStatus.TODO,
        priority: ActivityPriority.HIGH,
        startDate: oneDay,
        dueDate: oneDay,
        assignedUsers: { connect: [{ id: agent2.id }] },
      },
    });
    activityIds.push(activity2.id);

    console.log(`Fixture ready: dept=${dept.id} agent1=${agent1.id} agent2=${agent2.id} activity1=${activity1.id} activity2=${activity2.id}`);

    const context = await browser.newContext({ viewport: { width: 1440, height: 700 } });
    const page = await context.newPage();

    const dragLogs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().startsWith("[rp-drag]")) {
        dragLogs.push(msg.text());
        console.log("  ", msg.text());
      }
    });
    const patchRequests: { url: string; body: string }[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/api/activities/")) {
        patchRequests.push({ url: req.url(), body: req.postData() ?? "" });
      }
    });

    // Enable instrumentation BEFORE any page script runs.
    await context.addInitScript(() => {
      (window as unknown as { __rpDragDebug: boolean }).__rpDragDebug = true;
    });

    console.log("\nLogging in as admin...\n");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const url = `${BASE_URL}/projects/resource-planning?departmentId=${dept.id}`;

    async function gotoBoard() {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.getByText("Drag Test Activity 1", { exact: false }).first().waitFor({ state: "visible", timeout: 10000 });
    }

    // ---- helper: perform a real synthetic drag via page.mouse ----
    async function dragBar(opts: {
      label: string;
      barText: string;
      dxDays: number; // horizontal days to move (converted via measured pxPerDay)
      dyPx?: number; // vertical pixels (for cross-row)
      steps?: number;
      preScroll?: number; // scroll main container by this many px before the drag
      scrollDuringDrag?: number; // scroll main container by this many px mid-drag
      pauseMsBetweenSteps?: number;
    }) {
      const { label, barText, dxDays, dyPx = 0, steps = 12, preScroll, scrollDuringDrag, pauseMsBetweenSteps = 0 } = opts;
      console.log(`\n=== Scenario: ${label} ===`);
      if (preScroll) {
        await page.evaluate((s) => {
          document.querySelector("main")?.scrollBy(0, s);
        }, preScroll);
        await page.waitForTimeout(150);
      }
      const bar = page.getByText(barText, { exact: false }).first();
      const before = await bar.boundingBox();
      if (!before) {
        console.log(`  ✗ Could not locate bar "${barText}" before drag`);
        return;
      }
      // Measure real px-per-day from two adjacent day header cells.
      const dayHeaders = page.locator(".sticky.top-0 >> div[style*='width']");
      const startX = before.x + before.width / 2;
      const startY = before.y + before.height / 2;
      const pxPerDayGuess = 60; // fallback; real delta is what matters for click-threshold, exact day math verified via network payload
      const endX = startX + dxDays * pxPerDayGuess;
      const endY = startY + dyPx;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
        if (pauseMsBetweenSteps) await page.waitForTimeout(pauseMsBetweenSteps);
        if (scrollDuringDrag && i === Math.floor(steps / 2)) {
          await page.evaluate((s) => {
            document.querySelector("main")?.scrollBy(0, s);
          }, scrollDuringDrag);
        }
      }
      await page.mouse.up();
      await page.waitForTimeout(400);
      void dayHeaders;
    }

    // 1. Baseline same-row drag, no scroll.
    await gotoBoard();
    const patchCountBefore1 = patchRequests.length;
    await dragBar({ label: "1. Baseline same-row drag (no scroll)", barText: "Drag Test Activity 1", dxDays: 2 });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore1}`);

    // 2. Drag after scrolling the page down slightly (row under/near sticky header).
    await gotoBoard();
    const patchCountBefore2 = patchRequests.length;
    await dragBar({ label: "2. Drag Activity 1's row after scrolling page down 150px", barText: "Drag Test Activity 1", dxDays: 2, preScroll: 150 });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore2}`);

    // 3. Drag while scrolling DURING the gesture.
    await gotoBoard();
    const patchCountBefore3 = patchRequests.length;
    await dragBar({ label: "3. Scroll happens DURING an active drag", barText: "Drag Test Activity 1", dxDays: 2, scrollDuringDrag: 100, steps: 20, pauseMsBetweenSteps: 20 });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore3}`);

    // 4. Small vertical movement before horizontal (should still be a move, not a click).
    await gotoBoard();
    const patchCountBefore4 = patchRequests.length;
    await dragBar({ label: "4. Small vertical wobble then horizontal drag", barText: "Drag Test Activity 1", dxDays: 2, dyPx: 3 });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore4}`);

    // 5. One-day activity drag.
    await gotoBoard();
    const patchCountBefore5 = patchRequests.length;
    await dragBar({ label: "5. One-day activity drag", barText: "Drag Test Activity 2 One-Day", dxDays: 1 });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore5}`);

    // 6. Rapid consecutive drags on the same activity (no wait for first PATCH to settle).
    await gotoBoard();
    const patchCountBefore6 = patchRequests.length;
    console.log("\n=== Scenario: 6. Two rapid consecutive drags on the same activity ===");
    await dragBar({ label: "6a. first drag", barText: "Drag Test Activity 1", dxDays: 1, steps: 4 });
    await dragBar({ label: "6b. second drag immediately after", barText: "Drag Test Activity 1", dxDays: 1, steps: 4 });
    await page.waitForTimeout(800);
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore6}`);

    // 7. Cross-row drag (pure vertical, no horizontal movement).
    await gotoBoard();
    const patchCountBefore7 = patchRequests.length;
    const row1 = await page.locator("text=Agent One").first().boundingBox();
    const row2 = await page.locator("text=Agent Two").first().boundingBox();
    const rowDy = row2 && row1 ? row2.y - row1.y : 90;
    await dragBar({ label: "7. Pure vertical cross-row reassignment", barText: "Drag Test Activity 1", dxDays: 0, dyPx: rowDy });
    console.log(`  PATCH requests fired: ${patchRequests.length - patchCountBefore7}`);

    // 8. Direct test of the sticky-header-overlap hypothesis: scroll far
    // enough that Activity 1's row would sit directly under the sticky day
    // header band, then check what element actually receives a hit-test at
    // the bar's own screen coordinates.
    await gotoBoard();
    const beforeScrollBox = await page.getByText("Drag Test Activity 1", { exact: false }).first().boundingBox();
    if (beforeScrollBox) {
      const scrollAmount = Math.round(beforeScrollBox.y - 40); // leaves the row ~40px into the header's territory
      await page.evaluate((s) => {
        document.querySelector("main")?.scrollBy(0, s);
      }, scrollAmount);
      await page.waitForTimeout(150);
      const scrollDiag = await page.evaluate(() => {
        const main = document.querySelector("main");
        const scrollRefEl = Array.from(document.querySelectorAll("div")).find(
          (d) => d.className.includes("overflow-x-auto") && d.className.includes("rounded-lg")
        );
        const cs = scrollRefEl ? getComputedStyle(scrollRefEl) : null;
        return {
          mainScrollTop: main?.scrollTop,
          mainScrollHeight: main?.scrollHeight,
          mainClientHeight: main?.clientHeight,
          scrollRefComputedOverflowY: cs?.overflowY,
          scrollRefScrollTop: scrollRefEl?.scrollTop,
          scrollRefScrollHeight: scrollRefEl?.scrollHeight,
          scrollRefClientHeight: scrollRefEl?.clientHeight,
          scrollRefIsIndependentlyScrollable: scrollRefEl ? scrollRefEl.scrollHeight > scrollRefEl.clientHeight : null,
        };
      });
      console.log("  scroll-container diagnostic:", JSON.stringify(scrollDiag));
      const afterScrollBox = await page.getByText("Drag Test Activity 1", { exact: false }).first().boundingBox();
      if (afterScrollBox) {
        const px = afterScrollBox.x + afterScrollBox.width / 2;
        const py = afterScrollBox.y + afterScrollBox.height / 2;
        const hit = await page.evaluate(
          ([x, y]) => {
            const stack = document.elementsFromPoint(x, y).slice(0, 6);
            const header = document.querySelector(".sticky.top-0");
            const headerRect = header?.getBoundingClientRect();
            return {
              stack: stack.map((el) => ({ tag: el.tagName, className: (el as HTMLElement).className.slice(0, 80) })),
              headerRect: headerRect ? { top: headerRect.top, bottom: headerRect.bottom, left: headerRect.left, right: headerRect.right } : null,
            };
          },
          [px, py] as [number, number]
        );
        console.log(`\n=== Scenario: 8. Sticky-header-overlap hit-test check ===`);
        console.log(`  Scrolled main by ${scrollAmount}px; bar now at (${px.toFixed(0)}, ${py.toFixed(0)})`);
        console.log(`  document.elementFromPoint at that location:`, JSON.stringify(hit));
        const patchCountBefore8 = patchRequests.length;
        await page.mouse.move(px, py);
        await page.mouse.down();
        await page.mouse.move(px + 60, py, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        console.log(`  PATCH requests fired after attempting drag at that scrolled position: ${patchRequests.length - patchCountBefore8}`);
      }
    }

    console.log(`\nTotal [rp-drag] log lines captured: ${dragLogs.length}`);
    console.log(`Total PATCH /api/activities/* requests fired: ${patchRequests.length}`);
    patchRequests.forEach((r, i) => console.log(`  #${i + 1}: ${r.url} body=${r.body}`));

    await context.close();
  } finally {
    await browser.close();
    const cleanup: [string, () => Promise<unknown>][] = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["project", () => (project ? prisma.project.deleteMany({ where: { id: project.id } }) : Promise.resolve())],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [agent1?.id, agent2?.id, ...extraAgentIds].filter((id): id is string => !!id) } },
          }),
      ],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    cleanup.unshift(["progressConfig", () => (dept ? prisma.activityProgressConfig.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())]);
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Repro script crashed:", err);
  process.exit(1);
});
