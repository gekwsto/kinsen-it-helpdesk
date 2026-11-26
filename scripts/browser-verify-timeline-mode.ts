/**
 * Real-browser acceptance for the Actual / Expected timeline modes on
 * Project Gantt (/projects/gantt) and Resource Planning
 * (/projects/resource-planning):
 *  - Toggle in each existing toolbar, Actual by default, active mode shown;
 *    zoom + search preserved across the switch; incomplete Expected dates
 *    → Unscheduled.
 *  - Expected-mode drag-and-drop through the existing engine: Activity,
 *    Project and milestone moves on the Gantt and an Activity move on
 *    Resource Planning persist ONLY Expected dates (verified in the DB and
 *    after reload); Actual moves still persist only Actual dates.
 *  - Failed mutation (forced 500) → optimistic bar rolls back, nothing
 *    persisted. A view-only user gets no draggable bars in Expected mode.
 *  - The moved Expected dates appear on the Activity and Project detail
 *    pages.
 *  - Gantt ?from=/?to=: interval overlap (a spanning Project is listed).
 *  - Standalone Activity Gantt: no toggle.
 *  - Mobile (390×844): toggles + Gantt filters on-screen, no page scroll;
 *    desktop filter sizes unchanged.
 *
 * Creates its own department/users/request/project/activities and deletes
 * them afterwards. Requires a running app (npm run dev).
 *
 * Usage: BASE_URL=http://localhost:3000 [SHOT_DIR=…] npx tsx scripts/browser-verify-timeline-mode.ts
 */
import { chromium, type Browser, type Locator, type Page, type Response } from "playwright";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { format } from "date-fns";
import { shiftDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ActivityPriority, ActivityStatus, AuthProvider, DepartmentRole, MembershipSource, ProjectStatus, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), "browser-verify-timeline-mode");
const RUN_ID = Date.now();
const PASSWORD = "BvTimeline123!";
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

const isCanonical = (d: Date | null) => !!d && d.toISOString().endsWith("T00:00:00.000Z");

async function login(browser: Browser, email: string, timezoneId?: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(timezoneId ? { timezoneId } : {}) });
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u: URL) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
  return page;
}

/** Scrolls the Gantt's horizontal container so the bar sits mid-viewport (clear of the sticky name column). */
async function centerBar(bar: Locator) {
  // A successful drag triggers router.refresh(); wait until the target bar is
  // rendered again before measuring it (deterministic, no fixed sleep).
  await bar.waitFor({ state: "visible", timeout: 15000 });
  await bar.evaluate((el) => {
    const sc = el.closest(".overflow-x-auto") as HTMLElement | null;
    if (!sc) return;
    const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect();
    sc.scrollLeft += r.left - c.left - c.width / 2;
  });
}

/**
 * Drag a bar and wait until the drop has fully settled: the PATCH response
 * and, when it succeeded, the router.refresh() RSC response it triggers plus
 * two animation frames for React to commit it. Gantt bars are re-mounted on
 * every chart re-render, so starting the NEXT gesture while that refresh is
 * still landing would lose its pointer capture — this makes sequential
 * drags deterministic without fixed sleeps.
 */
async function dragSaved(page: Page, bar: Locator, dx: number, pathPart: string): Promise<Response> {
  const refresh = page
    .waitForResponse((r) => r.request().headers()["rsc"] === "1" || r.url().includes("_rsc="), { timeout: 15000 })
    .catch(() => null);
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(pathPart) && r.request().method() === "PATCH", { timeout: 15000 }),
    dragBy(page, bar, dx),
  ]);
  if (res.ok()) await refresh;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return res;
}

const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const rscResponse = (page: Page) => page.waitForResponse((r) => r.request().headers()["rsc"] === "1" || r.url().includes("_rsc="), { timeout: 15000 });

/**
 * Starts a drag, triggers a REAL router.refresh() (window.next.router — the
 * same call the components make after a save) while the pointer is still
 * down, waits for that refresh's RSC response to land and be committed,
 * then finishes the gesture. Returns the drop's PATCH response.
 */
async function dragWithRefreshMidGesture(page: Page, bar: Locator, dx: number, pathPart: string, beforeRefresh?: () => Promise<unknown>): Promise<Response> {
  await bar.waitFor({ state: "visible", timeout: 15000 });
  const b = (await bar.boundingBox())!;
  const x = b.x + Math.min(10, b.width / 2), y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  if (beforeRefresh) await beforeRefresh();
  const refreshed = rscResponse(page);
  await page.evaluate(() => (window as unknown as { next: { router: { refresh: () => void } } }).next.router.refresh());
  await refreshed;
  await nextFrames(page);
  const patch = page.waitForResponse((r) => r.url().includes(pathPart) && r.request().method() === "PATCH", { timeout: 15000 });
  const after = rscResponse(page).catch(() => null);
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
  const res = await patch;
  if (res.ok()) await after;
  await nextFrames(page);
  return res;
}

/** Horizontal pointer drag starting near the bar's left edge. */
async function dragBy(page: Page, bar: Locator, dx: number) {
  await bar.waitFor({ state: "visible", timeout: 15000 });
  const b = (await bar.boundingBox())!;
  const x = b.x + Math.min(10, b.width / 2), y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const ids = { users: [] as string[], projects: [] as string[], activities: [] as string[], depts: [] as string[], requests: [] as string[], roleIds: [] as string[], roleKeys: [] as string[] };
  const subTypeIds: string[] = [];
  const browser = await chromium.launch();
  try {
    const dept = await createDepartment({ name: `TL BV ${RUN_ID}`, slug: `tl-bv-${RUN_ID}` });
    ids.depts.push(dept.id);
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({ data: { email: `tl-bv-admin-${RUN_ID}@kinsen.gr`, name: "TL BV Admin", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
    const agent = await prisma.user.create({ data: { email: `tl-bv-agent-${RUN_ID}@kinsen.gr`, name: "TL BV Agent", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const viewer = await prisma.user.create({ data: { email: `tl-bv-viewer-${RUN_ID}@kinsen.gr`, name: "TL BV Viewer", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
    ids.users.push(admin.id, agent.id, viewer.id);
    // View-only: can see both timelines, holds no project.edit / activity.edit.
    const viewRole = await prisma.customRole.create({ data: { key: `TL_BV_VIEW_${RUN_ID}`, name: `TL BV View ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
    ids.roleIds.push(viewRole.id); ids.roleKeys.push(viewRole.key);
    for (const k of ["gantt.view", "project.view", "activity.view", "resourcePlanning.view"]) {
      await prisma.rolePermission.create({ data: { roleKey: viewRole.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    }
    await prisma.departmentMembership.create({ data: { userId: viewer.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: viewRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });

    // Actual dates around "today" (the Gantt auto-scrolls there); Expected in January 2027.
    // Request-origin, so the detail pages show the Expected dates.
    const now = new Date();
    const day = (offset: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d.setUTCDate(d.getUTCDate() + offset); return d; };
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const pr = await prisma.projectRequest.create({ data: { title: `TLBV Request ${RUN_ID}`, departmentId: dept.id, requesterId: admin.id, status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const p1 = await prisma.project.create({ data: { title: `TLBV P1 ${RUN_ID}`, ownerId: admin.id, owners: { connect: [{ id: admin.id }] }, projectRequestId: pr.id, departmentId: dept.id, status: ProjectStatus.IN_PROGRESS, startDate: day(-3), endDate: day(8), expectedStartDate: D("2027-01-04"), expectedFinishDate: D("2027-01-15") } });
    ids.projects.push(p1.id);
    const mk = async (t: string, data: Record<string, unknown>) => {
      const a = await prisma.projectActivity.create({ data: { title: `${t} ${RUN_ID}`, projectId: p1.id, departmentId: dept.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, assignedUsers: { connect: [{ id: agent.id }] }, ...data } });
      ids.activities.push(a.id);
      return a;
    };
    const a1 = await mk("TLBV-A1", { startDate: day(-2), dueDate: day(1), expectedStartDate: D("2027-01-04"), expectedFinishDate: D("2027-01-06") });
    const a3 = await mk("TLBV-A3", { startDate: day(14), dueDate: day(15), expectedStartDate: D("2027-01-05"), expectedFinishDate: D("2027-01-07") });
    const a4 = await mk("TLBV-A4", { startDate: day(-1), dueDate: day(0), expectedStartDate: D("2027-01-05") });
    const a5 = await mk("TLBV-A5", { expectedStartDate: D("2027-01-04"), expectedFinishDate: D("2027-01-05") });
    const m1 = await mk("TLBV-M1", { isMilestone: true, dueDate: day(2), expectedFinishDate: D("2027-01-12") });
    const m2 = await mk("TLBV-M2", { isMilestone: true, dueDate: day(3), startDate: day(3), expectedStartDate: D("2027-01-10"), expectedFinishDate: D("2027-01-12") });
    // Drag-stability fixtures (Expected dates in February 2027, clear of the other checks).
    const r1 = await mk("TLBV-R1", { expectedStartDate: D("2027-02-08"), expectedFinishDate: D("2027-02-10") });
    const r2 = await mk("TLBV-R2", { expectedStartDate: D("2027-02-09"), expectedFinishDate: D("2027-02-11") });
    // Manual Expected Days fixture (request-origin Project P1): 11 days at €250/day.
    // A realistic request-origin Activity: a real Task Sub Type (€250/day, snapshotted) and an assignable assignee — the edit form resends both on save.
    const subType = await prisma.taskSubType.create({ data: { name: `TLBV SubType ${RUN_ID}`, cost: "250.00" } });
    subTypeIds.push(subType.id);
    const e1 = await mk("TLBV-E1", { expectedStartDate: D("2027-02-15"), expectedFinishDate: D("2027-02-19"), expectedDays: 11, taskSubTypeId: subType.id, taskSubTypeCost: "250.00", ownerId: admin.id, assignedUsers: { connect: [{ id: admin.id }] } });
    // Time-zone matrix fixtures: Expected ranges ending just before each zone's
    // 2027 spring-forward (Athens 2027-03-28, New York 2027-03-14) so the
    // drags cross DST; Actual dates Mon–Tue of the current UTC week.
    const nowUtc = new Date();
    const mondayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() - ((nowUtc.getUTCDay() + 6) % 7)));
    const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
    const TZ_CASES = [
      { tz: "UTC", expStart: "2027-03-26", expEnd: "2027-03-27", afterGantt: ["2027-03-28", "2027-03-29"], afterRp: ["2027-03-29", "2027-03-30"] },
      { tz: "Europe/Athens", expStart: "2027-03-26", expEnd: "2027-03-27", afterGantt: ["2027-03-28", "2027-03-29"], afterRp: ["2027-03-29", "2027-03-30"] },
      { tz: "America/New_York", expStart: "2027-03-12", expEnd: "2027-03-13", afterGantt: ["2027-03-14", "2027-03-15"], afterRp: ["2027-03-15", "2027-03-16"] },
    ];
    const tzActivities = new Map<string, string>();
    for (const c of TZ_CASES) {
      const a = await mk(`TLBV-TZ-${c.tz.replace(/\W/g, "")}`, { startDate: mondayUtc, dueDate: plusDays(mondayUtc, 1), expectedStartDate: D(c.expStart), expectedFinishDate: D(c.expEnd), expectedDays: 9 });
      tzActivities.set(c.tz, a.id);
    }

    const page = await login(browser, admin.email);
    const toggle = page.getByTestId("timeline-mode-toggle");
    const childRow = (title: string) => page.locator("tr", { has: page.getByRole("link", { name: title, exact: true }) }).first();
    const barIn = (title: string) => childRow(title).locator("td").nth(1).locator("div.absolute.select-none").first();
    const ganttUrl = (extra = "") => `${BASE_URL}/projects/gantt?departmentId=${dept.id}${extra}`;
    const waitPatch = (pathPart: string) => page.waitForResponse((r) => r.url().includes(pathPart) && r.request().method() === "PATCH", { timeout: 15000 });

    console.log("\n=== Project Gantt: switch ===\n");
    await page.goto(ganttUrl());
    await toggle.waitFor({ timeout: 120000 });
    check("Toggle present in the Gantt toolbar; Actual active by default", (await toggle.getAttribute("data-mode")) === "actual" && (await toggle.getByRole("button", { name: "Actual" }).getAttribute("aria-pressed")) === "true");
    const statusBox = (await page.getByRole("combobox").filter({ hasText: "All statuses" }).boundingBox())!;
    const priorityBox = (await page.getByRole("combobox").filter({ hasText: "All priorities" }).boundingBox())!;
    const searchBox = (await page.getByPlaceholder("Search...").boundingBox())!;
    check("Desktop filter layout unchanged (150px selects, 176px search, one row)", Math.round(statusBox.width) === 150 && Math.round(priorityBox.width) === 150 && Math.round(searchBox.width) === 176 && Math.abs(statusBox.y - searchBox.y) < 2);
    await page.getByRole("button", { name: "month", exact: true }).click();
    await page.getByPlaceholder("Search...").fill("TLBV");
    const leftActual = (await barIn(`TLBV-A1 ${RUN_ID}`).boundingBox())!.x;
    await toggle.getByRole("button", { name: "Expected" }).click();
    await page.waitForSelector('[data-testid="timeline-mode-toggle"][data-mode="expected"]'); // server-rendered prop: the Expected render has committed
    check("Expected: URL carries timeline=expected, keeps departmentId; active mode + Expected note shown", page.url().includes("timeline=expected") && page.url().includes(`departmentId=${dept.id}`) && (await toggle.getByRole("button", { name: "Expected" }).getAttribute("aria-pressed")) === "true" && /Expected dates only/.test(await page.getByTestId("timeline-expected-note").innerText()));
    check("Zoom (Month) and search text preserved across the switch", /bg-primary/.test((await page.getByRole("button", { name: "month", exact: true }).getAttribute("class")) ?? "") && (await page.getByPlaceholder("Search...").inputValue()) === "TLBV");
    check("A1 bar moves to its Expected position (later than Actual)", (await barIn(`TLBV-A1 ${RUN_ID}`).boundingBox())!.x > leftActual + 20);
    check("Expected: A4 (Expected Finish missing) → 'No Expected dates set', no bar", await childRow(`TLBV-A4 ${RUN_ID}`).getByText("No Expected dates set").isVisible());

    console.log("\n=== Project Gantt: Expected drag-and-drop ===\n");
    await page.goto(ganttUrl("&timeline=expected"));
    await toggle.waitFor();
    await page.getByRole("button", { name: "day", exact: true }).click(); // 40px/day
    check("Expected: bars are draggable for an editor (cursor-grab)", (await barIn(`TLBV-A1 ${RUN_ID}`).getAttribute("class"))!.includes("cursor-grab"));

    // Activity +2d
    let bar = barIn(`TLBV-A1 ${RUN_ID}`);
    await centerBar(bar);
    const a1Before = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    let res = await dragSaved(page, bar, 80, `/api/activities/${a1.id}`);
    const a1Body = res.request().postDataJSON();
    let a1After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    check("Activity drag sends ONLY expectedStartDate/expectedFinishDate", JSON.stringify(Object.keys(a1Body).sort()) === JSON.stringify(["expectedFinishDate", "expectedStartDate"]), JSON.stringify(a1Body));
    check("Activity drag persisted Expected +2d (Jan 6–8), duration preserved", res.ok() && same(a1After.expectedStartDate, D("2027-01-06")) && same(a1After.expectedFinishDate, D("2027-01-08")), `${a1After.expectedStartDate?.toISOString()} – ${a1After.expectedFinishDate?.toISOString()}`);
    check("...Actual dates unchanged", same(a1After.startDate, a1Before.startDate) && same(a1After.dueDate, a1Before.dueDate));

    // Project +3d
    const groupBar = page.locator("tr", { has: page.getByRole("link", { name: `TLBV P1 ${RUN_ID}`, exact: true }) }).first().locator("td").nth(1).locator("div.absolute.select-none").first();
    await centerBar(groupBar);
    const p1Before = await prisma.project.findUniqueOrThrow({ where: { id: p1.id } });
    res = await dragSaved(page, groupBar, 120, `/api/projects/${p1.id}`);
    const p1After = await prisma.project.findUniqueOrThrow({ where: { id: p1.id } });
    check("Project drag sends ONLY Expected fields and persists Expected +3d (Jan 7–18)", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON()).sort()) === JSON.stringify(["expectedFinishDate", "expectedStartDate"]) && same(p1After.expectedStartDate, D("2027-01-07")) && same(p1After.expectedFinishDate, D("2027-01-18")));
    check("...Actual Project dates unchanged; Expected total initial days recalculated", same(p1After.startDate, p1Before.startDate) && same(p1After.endDate, p1Before.endDate) && p1After.expectedTotalInitialDays !== null);

    // Milestone +1d
    const ms = childRow(`TLBV-M1 ${RUN_ID}`).locator("td").nth(1).locator("div.absolute.select-none").first();
    await centerBar(ms);
    const m1Before = await prisma.projectActivity.findUniqueOrThrow({ where: { id: m1.id } });
    res = await dragSaved(page, ms, 40, `/api/activities/${m1.id}`);
    const m1After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: m1.id } });
    check("Milestone drag sends ONLY expectedFinishDate and persists it +1d (Jan 13)", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON())) === JSON.stringify(["expectedFinishDate"]) && same(m1After.expectedFinishDate, D("2027-01-13")) && m1After.expectedStartDate === null);
    check("...Actual milestone dates unchanged", same(m1After.dueDate, m1Before.dueDate) && same(m1After.startDate, m1Before.startDate));

    // Milestone with BOTH Expected dates: -3d (finish lands before the original start) then +5d.
    const ms2 = childRow(`TLBV-M2 ${RUN_ID}`).locator("td").nth(1).locator("div.absolute.select-none").first();
    await centerBar(ms2);
    const m2Before = await prisma.projectActivity.findUniqueOrThrow({ where: { id: m2.id } });
    res = await dragSaved(page, ms2, -120, `/api/activities/${m2.id}`);
    let m2After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: m2.id } });
    check("Milestone with both Expected dates dragged -3d → both shifted (Jan 7 / Jan 9), spread preserved, no validation conflict", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON()).sort()) === JSON.stringify(["expectedFinishDate", "expectedStartDate"]) && same(m2After.expectedStartDate, D("2027-01-07")) && same(m2After.expectedFinishDate, D("2027-01-09")));
    await centerBar(ms2);
    res = await dragSaved(page, ms2, 200, `/api/activities/${m2.id}`);
    m2After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: m2.id } });
    check("...then +5d → Jan 12 / Jan 14; Actual milestone dates untouched", res.ok() && same(m2After.expectedStartDate, D("2027-01-12")) && same(m2After.expectedFinishDate, D("2027-01-14")) && same(m2After.dueDate, m2Before.dueDate) && same(m2After.startDate, m2Before.startDate));
    check("Every Gantt-written date is canonical UTC midnight", [a1After.expectedStartDate, a1After.expectedFinishDate, p1After.expectedStartDate, p1After.expectedFinishDate, m1After.expectedFinishDate, m2After.expectedStartDate, m2After.expectedFinishDate].every(isCanonical));

    // Persistence after reload
    bar = barIn(`TLBV-A1 ${RUN_ID}`);
    await centerBar(bar);
    const xBeforeReload = await bar.evaluate((el) => (el as HTMLElement).style.left);
    await page.reload();
    await toggle.waitFor();
    await page.getByRole("button", { name: "day", exact: true }).click();
    check("After reload the Expected bar stays at its new position (same computed left)", (await barIn(`TLBV-A1 ${RUN_ID}`).evaluate((el) => (el as HTMLElement).style.left)) === xBeforeReload, xBeforeReload);

    // Failed mutation → rollback
    const a5Bar = barIn(`TLBV-A5 ${RUN_ID}`);
    await centerBar(a5Bar);
    const a5Left = await a5Bar.evaluate((el) => (el as HTMLElement).style.left);
    const a5Before = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a5.id } });
    await page.route(`**/api/activities/${a5.id}`, (route) =>
      route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated failure" }) }) : route.continue()
    );
    await Promise.all([waitPatch(`/api/activities/${a5.id}`), dragBy(page, a5Bar, 80)]);
    // Rollback is applied in the same handler that shows the error toast.
    await page.getByText("Simulated failure").first().waitFor({ state: "visible", timeout: 15000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const a5After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a5.id } });
    check("Failed Expected mutation: error toast shown, bar rolled back, nothing persisted", (await page.getByText("Simulated failure").first().isVisible()) && (await barIn(`TLBV-A5 ${RUN_ID}`).evaluate((el) => (el as HTMLElement).style.left)) === a5Left && same(a5After.expectedStartDate, a5Before.expectedStartDate));
    await page.unroute(`**/api/activities/${a5.id}`);

    // Actual mode still edits only Actual dates
    await page.goto(ganttUrl());
    await toggle.waitFor();
    await page.getByRole("button", { name: "day", exact: true }).click();
    bar = barIn(`TLBV-A1 ${RUN_ID}`);
    await centerBar(bar);
    const a1Pre = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    res = await dragSaved(page, bar, 80, `/api/activities/${a1.id}`);
    a1After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    check("Actual drag sends startDate/dueDate only and moves Actual +2d", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON()).sort()) === JSON.stringify(["dueDate", "startDate"]) && +a1After.startDate! === +a1Pre.startDate! + 2 * 86400000);
    check("...Expected dates unchanged by the Actual drag", same(a1After.expectedStartDate, a1Pre.expectedStartDate) && same(a1After.expectedFinishDate, a1Pre.expectedFinishDate));

    console.log("\n=== Drag stability: refresh mid-gesture and rapid consecutive drags ===\n");
    await page.goto(ganttUrl("&timeline=expected"));
    await toggle.waitFor();
    await page.getByRole("button", { name: "day", exact: true }).click(); // 40px/day
    check("window.next.router.refresh is available to trigger a real refresh", await page.evaluate(() => typeof (window as unknown as { next?: { router?: { refresh?: unknown } } }).next?.router?.refresh === "function"));
    {
      const r1Bar = barIn(`TLBV-R1 ${RUN_ID}`), r2Bar = barIn(`TLBV-R2 ${RUN_ID}`);
      await centerBar(r1Bar);
      const r2LeftBefore = await r2Bar.evaluate((el) => (el as HTMLElement).style.left);
      const res = await dragWithRefreshMidGesture(page, r1Bar, 80, `/api/activities/${r1.id}`, () =>
        // Someone else moves R2 while the drag is in progress — the mid-drag refresh carries it.
        prisma.projectActivity.update({ where: { id: r2.id }, data: { expectedStartDate: D("2027-02-12"), expectedFinishDate: D("2027-02-14") } })
      );
      const r1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: r1.id } });
      check("Gantt: a refresh landing mid-drag does NOT cancel the gesture — the drop's PATCH fires and persists (R1 Expected +2d → Feb 10–12)", res.ok() && same(r1Row.expectedStartDate, D("2027-02-10")) && same(r1Row.expectedFinishDate, D("2027-02-12")));
      const r2LeftAfter = await r2Bar.evaluate((el) => (el as HTMLElement).style.left);
      check("Gantt: the snapshot deferred during the gesture is applied after it (R2's server-side move now shown: +3 days = +120px)", parseFloat(r2LeftAfter) - parseFloat(r2LeftBefore) === 120, `${r2LeftBefore} → ${r2LeftAfter}`);
      check("Gantt: R1 shown at its new position after the drop and the refresh (not reverted)", (await r1Bar.evaluate((el) => (el as HTMLElement).style.left)) === `${parseFloat(r2LeftAfter) - 2 * 40}px`, await r1Bar.evaluate((el) => (el as HTMLElement).style.left));
    }
    {
      // Rapid consecutive drags: the second gesture starts immediately after the first drop, without waiting for its refresh.
      const r1Bar = barIn(`TLBV-R1 ${RUN_ID}`), r2Bar = barIn(`TLBV-R2 ${RUN_ID}`);
      await centerBar(r1Bar);
      const p1Wait = waitPatch(`/api/activities/${r1.id}`);
      const p2Wait = waitPatch(`/api/activities/${r2.id}`);
      await dragBy(page, r1Bar, 40);
      await dragBy(page, r2Bar, -40);
      const [x1, x2] = await Promise.all([p1Wait, p2Wait]);
      const [r1Row, r2Row] = await Promise.all([prisma.projectActivity.findUniqueOrThrow({ where: { id: r1.id } }), prisma.projectActivity.findUniqueOrThrow({ where: { id: r2.id } })]);
      check("Gantt: two rapid consecutive drags both succeed and persist (R1 +1d → Feb 11–13, R2 −1d → Feb 11–13)", x1.ok() && x2.ok() && same(r1Row.expectedStartDate, D("2027-02-11")) && same(r2Row.expectedStartDate, D("2027-02-11")) && same(r2Row.expectedFinishDate, D("2027-02-13")));
      check("...Actual dates of both untouched (field isolation)", r1Row.startDate === null && r1Row.dueDate === null && r2Row.startDate === null && r2Row.dueDate === null);
    }
    {
      // Resource Planning: refresh mid-gesture.
      await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2027-02-01&timeline=expected`);
      await toggle.waitFor();
      const r1Rp = page.locator("div.cursor-grab").filter({ hasText: `TLBV P1 ${RUN_ID} — TLBV-R1 ${RUN_ID}` }).first();
      await r1Rp.hover({ trial: true });
      const col = (await page.locator("div.flex-shrink-0.border-r.px-1\\.5").first().boundingBox())!.width;
      const res = await dragWithRefreshMidGesture(page, r1Rp, col * 2, `/api/activities/${r1.id}`);
      const r1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: r1.id } });
      check("Resource Planning: a refresh mid-drag does NOT cancel the gesture — PATCH persists Expected +2d (Feb 13–15)", res.ok() && same(r1Row.expectedStartDate, D("2027-02-13")) && same(r1Row.expectedFinishDate, D("2027-02-15")), r1Row.expectedStartDate?.toISOString());
    }

    console.log("\n=== Resource Planning: Expected drag-and-drop ===\n");
    const rpUrl = `${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2027-01-01`;
    const rpBar = (title: string) => page.locator(`div.cursor-grab, a[href^="/activities/"]`).filter({ hasText: `TLBV P1 ${RUN_ID} — ${title}` }).first();
    await page.goto(rpUrl);
    await toggle.waitFor({ timeout: 120000 });
    check("RP Actual (default), January 2027: no bars (Actual dates are around today)", (await toggle.getAttribute("data-mode")) === "actual" && (await page.getByText(`TLBV P1 ${RUN_ID} — ${a1.title}`).count()) === 0);
    await toggle.getByRole("button", { name: "Expected" }).click();
    await page.waitForSelector('[data-testid="timeline-mode-toggle"][data-mode="expected"]'); // server-rendered prop: the Expected render has committed
    check("RP Expected: view/from/department preserved; A1, A3, A5 placed; A4 unscheduled with its reason", page.url().includes("view=month") && page.url().includes("from=2027-01-01") && await rpBar(a1.title).isVisible() && await rpBar(a3.title).isVisible() && await rpBar(a5.title).isVisible() && (await page.getByText(`TLBV P1 ${RUN_ID} — ${a4.title}`).count()) === 0 && await page.locator("a", { hasText: a4.title }).filter({ hasText: "Missing Expected Start or Expected Finish" }).first().isVisible());
    const a3Bar = rpBar(a3.title);
    check("RP Expected: bars draggable for an editor", ((await a3Bar.getAttribute("class")) ?? "").includes("cursor-grab"));
    await a3Bar.hover({ trial: true }); // scroll into view + actionability; re-resolves if re-rendered (e.g. hydration) // the agent's row can be below the fold
    const a3Box = (await a3Bar.boundingBox())!;
    const pxPerDay = a3Box.width / 3; // Jan 5–7 inclusive
    const a3Before = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a3.id } });
    res = await dragSaved(page, a3Bar, pxPerDay * 2, `/api/activities/${a3.id}`);
    const a3After = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a3.id } });
    // Same canonical shift as the Gantt (lib/date-only.ts): exact UTC midnight.
    check("RP drag sends ONLY Expected fields and persists Expected +2d (Jan 7–9 at exact UTC midnight)", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON()).sort()) === JSON.stringify(["expectedFinishDate", "expectedStartDate"]) && same(a3After.expectedStartDate, D("2027-01-07")) && same(a3After.expectedFinishDate, D("2027-01-09")), `${a3After.expectedStartDate?.toISOString()}`);
    check("...Actual dates unchanged", same(a3After.startDate, a3Before.startDate) && same(a3After.dueDate, a3Before.dueDate));
    await page.reload();
    await toggle.waitFor();
    await rpBar(a3.title).hover({ trial: true }); // scroll into view + actionability; re-resolves if re-rendered (e.g. hydration)
    const a3Reloaded = (await rpBar(a3.title).boundingBox())!;
    check("RP after reload: bar at its new Expected position (+2 days)", Math.abs(a3Reloaded.x - (a3Box.x + pxPerDay * 2)) < 4, `${a3Box.x} → ${a3Reloaded.x}`);
    // A1, A3, A5 and the milestone M2 (both Expected dates, so Resource Planning schedules it); M1 has only Expected Finish → unscheduled.
    check("RP: utilization counts the 4 scheduled Expected activities (incl. milestone M2 with both Expected dates)", await page.getByText("4 scheduled").first().isVisible());

    // Actual mode on Resource Planning still writes only Actual dates.
    await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=${ymd(day(0))}`);
    await toggle.waitFor();
    const a1RpBar = rpBar(a1.title);
    await a1RpBar.hover({ trial: true }); // scroll into view + actionability; re-resolves if re-rendered (e.g. hydration)
    const dayCellWidth = (await page.locator("div.flex-shrink-0.border-r.px-1\\.5").first().boundingBox())!.width;
    const a1RpBefore = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    res = await dragSaved(page, a1RpBar, dayCellWidth, `/api/activities/${a1.id}`);
    const a1RpAfter = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id } });
    check("RP Actual drag sends startDate/dueDate only, moves Actual +1 day, leaves Expected unchanged", res.ok() && JSON.stringify(Object.keys(res.request().postDataJSON()).sort()) === JSON.stringify(["dueDate", "startDate"]) && a1RpAfter.startDate!.toISOString() === shiftDateOnly(a1RpBefore.startDate!, 1) && isCanonical(a1RpAfter.dueDate) && same(a1RpAfter.expectedStartDate, a1RpBefore.expectedStartDate) && same(a1RpAfter.expectedFinishDate, a1RpBefore.expectedFinishDate), JSON.stringify(res.request().postDataJSON()));

    console.log("\n=== Manual Expected Days survive date-only operations (request-origin Activity) ===\n");
    {
      const e1Row = () => prisma.projectActivity.findUniqueOrThrow({ where: { id: e1.id } });
      // Project Gantt, Expected, +2 days.
      await page.goto(ganttUrl("&timeline=expected"));
      await toggle.waitFor();
      await page.getByRole("button", { name: "day", exact: true }).click();
      const e1Bar = barIn(`TLBV-E1 ${RUN_ID}`);
      await centerBar(e1Bar);
      let r = await dragSaved(page, e1Bar, 80, `/api/activities/${e1.id}`);
      let row = await e1Row();
      check("Gantt Expected drag: dates moved (Feb 17–21), Expected Days still 11", r.ok() && same(row.expectedStartDate, D("2027-02-17")) && same(row.expectedFinishDate, D("2027-02-21")) && row.expectedDays === 11);
      // Resource Planning, Expected, +1 day.
      await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2027-02-01&timeline=expected`);
      await toggle.waitFor();
      const e1Rp = page.locator("div.cursor-grab").filter({ hasText: `TLBV P1 ${RUN_ID} — TLBV-E1 ${RUN_ID}` }).first();
      await e1Rp.hover({ trial: true });
      const col = (await page.locator("div.flex-shrink-0.border-r.px-1\\.5").first().boundingBox())!.width;
      r = await dragSaved(page, e1Rp, col, `/api/activities/${e1.id}`);
      row = await e1Row();
      check("Resource Planning Expected drag: dates moved (Feb 18–22), Expected Days still 11", r.ok() && same(row.expectedStartDate, D("2027-02-18")) && row.expectedDays === 11);
      // Activity detail: inline Expected Finish edit.
      await page.goto(`${BASE_URL}/activities/${e1.id}`);
      await page.getByText("Expected Finish").first().waitFor({ timeout: 60000 });
      await page.locator("p", { hasText: /^Expected Finish$/ }).locator("xpath=..").getByRole("button").first().click();
      const dateInput = page.locator('input[type="date"]').first();
      await dateInput.waitFor({ state: "visible" });
      const [inl] = await Promise.all([waitPatch(`/api/activities/${e1.id}`), dateInput.fill("2027-02-26")]);
      row = await e1Row();
      check("Inline Expected Finish edit: saved (Feb 26), Expected Days still 11", inl.ok() && same(row.expectedFinishDate, D("2027-02-26")) && row.expectedDays === 11);
      await page.reload();
      await page.getByText("Expected Days").first().waitFor({ timeout: 60000 });
      let detail = await page.locator("main").innerText();
      check("After reload: detail shows 11 working day(s) and Estimated Cost 2750.00 EUR (250 × 11, unchanged by every date move)", detail.includes("11 working day(s)") && detail.includes("2750.00 EUR"));
      // Edit form: explicit Expected Days edit.
      await page.goto(`${BASE_URL}/activities/${e1.id}/edit`);
      const daysInput = page.locator("#expected-days");
      await daysInput.waitFor({ timeout: 60000 });
      check("Edit form: Expected Days is editable and shows the stored manual value (11)", (await daysInput.isEditable()) && (await daysInput.inputValue()) === "11");
      await daysInput.fill("6");
      const [save] = await Promise.all([waitPatch(`/api/activities/${e1.id}`), page.getByRole("button", { name: "Save Changes" }).click()]);
      const saveBody = save.request().postDataJSON();
      row = await e1Row();
      check("Edit form save sends expectedDaysOverride: 6 → persisted 6, Expected dates unchanged", save.ok() && saveBody.expectedDaysOverride === 6 && row.expectedDays === 6 && same(row.expectedFinishDate, D("2027-02-26")), `status=${save.status()} body=${JSON.stringify(saveBody)} resp=${save.ok() ? "" : (await save.text()).slice(0, 200)} days=${row.expectedDays}`);
      await page.waitForURL(new RegExp(`/activities/${e1.id}$`), { timeout: 30000 });
      await page.getByText("Expected Days").first().waitFor({ timeout: 60000 });
      detail = await page.locator("main").innerText();
      check("Detail after explicit edit: 6 working day(s), Estimated Cost recalculated to 1500.00 EUR", detail.includes("6 working day(s)") && detail.includes("1500.00 EUR"));
      // A save that only changes a date keeps it.
      await page.goto(`${BASE_URL}/activities/${e1.id}/edit`);
      await daysInput.waitFor({ timeout: 60000 });
      await page.locator("#expected-finish").fill("2027-03-03");
      const [save2] = await Promise.all([waitPatch(`/api/activities/${e1.id}`), page.getByRole("button", { name: "Save Changes" }).click()]);
      row = await e1Row();
      check("Edit form save changing only Expected Finish: no override sent, Expected Days stays 6", save2.ok() && !("expectedDaysOverride" in save2.request().postDataJSON()) && row.expectedDays === 6 && same(row.expectedFinishDate, D("2027-03-03")));
    }

    console.log("\n=== Detail pages reflect the Expected changes ===\n");
    await page.goto(`${BASE_URL}/activities/${a3.id}`);
    await page.getByText("Expected Start").first().waitFor({ timeout: 60000 });
    const actText = await page.locator("main").innerText();
    check("Activity detail shows the moved Expected Start / Finish (07 Jan 2027 / 09 Jan 2027)", actText.includes(format(D("2027-01-07"), "dd MMM yyyy")) && actText.includes(format(D("2027-01-09"), "dd MMM yyyy")));
    await page.goto(`${BASE_URL}/projects/${p1.id}`);
    await page.getByText("Expected Timeline").first().waitFor({ timeout: 60000 });
    const projText = await page.locator("main").innerText();
    check("Project detail shows the moved Expected Timeline (07 Jan 2027) and recalculated initial days", projText.includes(`Start: ${format(D("2027-01-07"), "dd MMM yyyy")}`) && projText.includes(`Expected total initial: ${p1After.expectedTotalInitialDays} working day`));

    console.log("\n=== Time-zone matrix: identical stored dates from UTC, Europe/Athens, America/New_York browsers (across DST) ===\n");
    for (const c of TZ_CASES) {
      const id = tzActivities.get(c.tz)!;
      const title = (await prisma.projectActivity.findUniqueOrThrow({ where: { id } })).title;
      const tp = await login(browser, admin.email, c.tz);
      const tToggle = tp.getByTestId("timeline-mode-toggle");
      const hydrationErrors: string[] = [];
      tp.on("console", (m) => { if (m.type() === "error" && /hydrat|did not match|server rendered|text content does not match/i.test(m.text())) hydrationErrors.push(m.text().slice(0, 160)); });
      tp.on("pageerror", (err) => { if (/hydrat|did not match|server rendered/i.test(err.message)) hydrationErrors.push(err.message.slice(0, 160)); });
      const tRow = tp.locator("tr", { has: tp.getByRole("link", { name: title, exact: true }) }).first();
      // Gantt, Expected, +2 days at 40px/day.
      await tp.goto(ganttUrl("&timeline=expected"));
      await tToggle.waitFor({ timeout: 60000 });
      await tp.getByRole("button", { name: "day", exact: true }).click();
      const tBar = tRow.locator("td").nth(1).locator("div.absolute.select-none").first();
      await centerBar(tBar);
      const tzEvalOk = (await tp.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) === c.tz;
      let r = await dragSaved(tp, tBar, 80, `/api/activities/${id}`);
      let row = await prisma.projectActivity.findUniqueOrThrow({ where: { id } });
      check(`[${c.tz}] browser zone active; Gantt Expected +2d → ${c.afterGantt.join(" – ")} at exact UTC midnight`, tzEvalOk && r.ok() && row.expectedStartDate!.toISOString() === `${c.afterGantt[0]}T00:00:00.000Z` && row.expectedFinishDate!.toISOString() === `${c.afterGantt[1]}T00:00:00.000Z`, `${row.expectedStartDate?.toISOString()} – ${row.expectedFinishDate?.toISOString()}`);
      // Resource Planning, Expected, +1 day (column width = pxPerDay).
      await tp.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&view=month&from=2027-03-01&timeline=expected`);
      await tToggle.waitFor({ timeout: 60000 });
      const rBar = tp.locator(`div.cursor-grab`).filter({ hasText: `TLBV P1 ${RUN_ID} — ${title}` }).first();
      await rBar.hover({ trial: true }); // scroll into view + actionability; re-resolves if re-rendered (e.g. hydration)
      const col = (await tp.locator("div.flex-shrink-0.border-r.px-1\\.5").first().boundingBox())!.width;
      r = await dragSaved(tp, rBar, col, `/api/activities/${id}`);
      row = await prisma.projectActivity.findUniqueOrThrow({ where: { id } });
      check(`[${c.tz}] Resource Planning Expected +1d → ${c.afterRp.join(" – ")} at exact UTC midnight (same convention as the Gantt)`, r.ok() && row.expectedStartDate!.toISOString() === `${c.afterRp[0]}T00:00:00.000Z` && row.expectedFinishDate!.toISOString() === `${c.afterRp[1]}T00:00:00.000Z`, `${row.expectedStartDate?.toISOString()}`);
      check(`[${c.tz}] ...manual Expected Days kept (9 — request-origin, never recalculated from dates), Actual dates untouched`, row.expectedDays === 9 && same(row.startDate, mondayUtc) && same(row.dueDate, plusDays(mondayUtc, 1)));
      // Resource Planning, Actual, +1 day in the current UTC week.
      await tp.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&from=${ymd(mondayUtc)}`);
      await tToggle.waitFor({ timeout: 60000 });
      const aBar = tp.locator(`div.cursor-grab`).filter({ hasText: `TLBV P1 ${RUN_ID} — ${title}` }).first();
      await aBar.hover({ trial: true }); // scroll into view + actionability; re-resolves if re-rendered (e.g. hydration)
      const col2 = (await tp.locator("div.flex-shrink-0.border-r.px-1\\.5").first().boundingBox())!.width;
      const expBefore = await prisma.projectActivity.findUniqueOrThrow({ where: { id } });
      r = await dragSaved(tp, aBar, col2, `/api/activities/${id}`);
      row = await prisma.projectActivity.findUniqueOrThrow({ where: { id } });
      check(`[${c.tz}] Resource Planning Actual +1d → Tue–Wed of this UTC week at exact UTC midnight; Expected untouched`, r.ok() && same(row.startDate, plusDays(mondayUtc, 1)) && same(row.dueDate, plusDays(mondayUtc, 2)) && isCanonical(row.startDate) && same(row.expectedStartDate, expBefore.expectedStartDate) && same(row.expectedFinishDate, expBefore.expectedFinishDate), `${row.startDate?.toISOString()}`);
      // Visible calendar dates — must be identical in every zone.
      await tp.goto(`${BASE_URL}/projects/resource-planning?departmentId=${dept.id}&from=2027-03-08&timeline=expected`);
      await tToggle.waitFor({ timeout: 60000 });
      const firstCol = (await tp.locator("div.flex-shrink-0.border-r.px-1\\.5").first().innerText()).trim();
      await tp.goto(ganttUrl("&timeline=expected"));
      await tToggle.waitFor({ timeout: 60000 });
      await tp.getByRole("button", { name: "day", exact: true }).click();
      const a3GanttBar = tRow.page().locator("tr", { has: tp.getByRole("link", { name: `TLBV-A3 ${RUN_ID}`, exact: true }) }).first().locator("td").nth(1).locator("div.absolute.select-none").first();
      await centerBar(a3GanttBar);
      await a3GanttBar.hover();
      const tip = tp.getByRole("tooltip").first();
      await tip.waitFor({ state: "visible", timeout: 15000 });
      const tipText = await tip.innerText();
      await tp.goto(`${BASE_URL}/activities/${a3.id}`);
      await tp.getByText("Expected Start").first().waitFor({ timeout: 60000 });
      const actText = await tp.locator("main").innerText();
      await tp.goto(`${BASE_URL}/projects/${p1.id}`);
      await tp.getByText("Expected Timeline").first().waitFor({ timeout: 60000 });
      const projText = await tp.locator("main").innerText();
      check(`[${c.tz}] Visible dates are the stored calendar days: RP week column "Mon 8", Gantt tooltip "Jan 7, 2027"/"Jan 9, 2027", Activity detail 07/09 Jan 2027, Project detail "Start: 07 Jan 2027"`,
        firstCol === "Mon 8" && tipText.includes("Expected start: Jan 7, 2027") && tipText.includes("Expected finish: Jan 9, 2027") && actText.includes("07 Jan 2027") && actText.includes("09 Jan 2027") && projText.includes("Start: 07 Jan 2027"),
        JSON.stringify({ firstCol, tip: tipText.replace(/\s+/g, " ").slice(0, 120) }));
      check(`[${c.tz}] No hydration errors on Gantt, Resource Planning or the detail pages`, hydrationErrors.length === 0, hydrationErrors.join(" || "));
      await tp.context().close();
    }

    console.log("\n=== Permissions: view-only user ===\n");
    const vp = await login(browser, viewer.email);
    await vp.goto(ganttUrl("&timeline=expected"));
    await vp.getByTestId("timeline-mode-toggle").waitFor({ timeout: 60000 });
    check("Gantt Expected, view-only user: bars visible but none draggable", (await vp.getByRole("link", { name: `TLBV-A1 ${RUN_ID}`, exact: true }).isVisible()) && (await vp.locator("td div.absolute.select-none.cursor-grab").count()) === 0);
    await vp.goto(`${rpUrl}&timeline=expected`);
    await vp.getByTestId("timeline-mode-toggle").waitFor({ timeout: 60000 });
    check("RP Expected, view-only user: bars are plain links, none draggable", (await vp.getByText(`TLBV P1 ${RUN_ID} — ${a1.title}`).first().isVisible()) && (await vp.locator(".cursor-grab").count()) === 0);
    await vp.context().close();

    console.log("\n=== Gantt range filter (interval overlap) ===\n");
    const groupLink = page.getByRole("link", { name: `TLBV P1 ${RUN_ID}`, exact: true });
    await page.goto(ganttUrl(`&from=${ymd(day(0))}&to=${ymd(day(1))}`));
    await toggle.waitFor();
    check("Actual: P1 spanning the whole selected range is listed", await groupLink.isVisible());
    await page.goto(ganttUrl("&from=2027-01-10&to=2027-01-11&timeline=expected"));
    await toggle.waitFor();
    check("Expected: P1 spanning the whole selected range is listed", await groupLink.isVisible());
    await page.goto(ganttUrl("&from=2027-02-01&to=2027-02-28&timeline=expected"));
    await toggle.waitFor();
    check("Expected: a non-overlapping range excludes P1", (await groupLink.count()) === 0);

    console.log("\n=== Activity Gantt (standalone) ===\n");
    await page.goto(`${BASE_URL}/activities/gantt`);
    await page.getByRole("button", { name: "Today" }).first().waitFor({ timeout: 60000 });
    check("Standalone Activity Gantt has no timeline toggle", (await page.getByTestId("timeline-mode-toggle").count()) === 0);

    console.log("\n=== Mobile (390×844) ===\n");
    await page.setViewportSize({ width: 390, height: 844 });
    const onScreen = (b: { x: number; width: number } | null) => !!b && b.x >= 0 && b.x + b.width <= 390;
    for (const [label, url] of [["Gantt", ganttUrl("&timeline=expected")], ["Resource Planning", `${rpUrl}&timeline=expected`]] as const) {
      await page.goto(url);
      await toggle.waitFor({ timeout: 60000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${label} mobile: toggle on-screen (Expected active), no horizontal page scroll`, onScreen(await toggle.boundingBox()) && (await toggle.getAttribute("data-mode")) === "expected" && overflow <= 0, `overflow ${overflow}px`);
      if (label === "Gantt") {
        const boxes = await Promise.all([
          page.getByRole("combobox").filter({ hasText: "All statuses" }).boundingBox(),
          page.getByRole("combobox").filter({ hasText: "All priorities" }).boundingBox(),
          page.getByPlaceholder("Search...").boundingBox(),
        ]);
        check("Gantt mobile: status, priority and search filters fully on-screen", boxes.every(onScreen));
      }
      await page.screenshot({ path: `${SHOT_DIR}/${label === "Gantt" ? "gantt" : "rp"}-mobile-expected.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(ganttUrl("&timeline=expected"));
    await toggle.waitFor();
    await page.screenshot({ path: `${SHOT_DIR}/gantt-desktop-expected.png` });
    console.log(`\nScreenshots: ${SHOT_DIR}`);
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["task sub types", () => prisma.taskSubType.deleteMany({ where: { id: { in: subTypeIds } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roleIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
