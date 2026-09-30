/**
 * Real interactive browser verification for the new Project-list and
 * Activity-list realtime auto-refresh — two separate browser contexts (two
 * independent "tabs"/sessions), exactly the scenario the task asked for:
 * one tab sits on a list page, a second tab changes an entity, and the
 * first tab must pick it up automatically, no manual reload.
 *
 * Mutations from the "second tab" are issued as real HTTP requests through
 * that tab's own authenticated context (`page.request.patch(...)`) — the
 * exact same server code path a UI click would hit — matching this repo's
 * established convention (see browser-verify-ticket-list-realtime.ts's own
 * attachment-upload scenario, which does the same for the same reason: this
 * smoke test verifies the realtime PIPELINE, not a specific dialog's DOM).
 *
 * Uses `playwright` directly against a live `npm run dev` server — not part
 * of the regular npm test flow (matches browser-verify-ticket-list-realtime.ts).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-activity-list-realtime.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();

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

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenign = isAborted && (req.url().includes("_rsc=") || req.url().includes("/stream"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
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

const OVERLAY_SELECTOR = '[role="status"][aria-live="polite"]';
async function overlayIsVisible(page: Page): Promise<boolean> {
  const el = page.locator(OVERLAY_SELECTOR).first();
  const hidden = await el.getAttribute("aria-hidden");
  return hidden === "false";
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const deptIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const dept = await createDepartment({ name: `BV Proj Act Realtime ${RUN_ID}`, slug: `bv-proj-act-rt-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL } });

    // ══════════════════════ 1. Project list: a change in tab 2 updates tab 1 ══════════════════════
    console.log("\n=== 1. /projects list: editing a Project from a second tab updates the first tab's row, without a manual reload ===\n");

    const project = await prisma.project.create({
      data: { title: `BV Project Realtime ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING", priority: 2 },
    });
    projectIds.push(project.id);

    const contextProjList = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageProjList = await contextProjList.newPage();
    attachCapture(pageProjList, consoleErrors, failedRequests);
    await login(pageProjList);
    await pageProjList.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });
    const projectsUrl = `${BASE_URL}/projects?departmentId=${dept.id}&view=list`;
    await pageProjList.goto(projectsUrl);
    await pageProjList.waitForLoadState("load");
    const projectRow = pageProjList.locator("tr", { hasText: project.title });
    await projectRow.waitFor({ state: "visible", timeout: 10000 });
    check("Project list tab shows the project with its initial status (Planning)", (await projectRow.innerText()).includes("PLANNING"));
    check("Overlay is hidden at rest on the Project list tab", !(await overlayIsVisible(pageProjList)));

    const contextProjEdit = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageProjEdit = await contextProjEdit.newPage();
    attachCapture(pageProjEdit, consoleErrors, failedRequests);
    await login(pageProjEdit);

    const projPatchRes = await pageProjEdit.request.patch(`${BASE_URL}/api/projects/${project.id}`, {
      data: { status: "IN_PROGRESS" },
      headers: { "Content-Type": "application/json" },
    });
    check("Second tab's Project status change -> 200", projPatchRes.status() === 200);

    let projectListUpdated = false;
    for (let i = 0; i < 20; i++) {
      if ((await projectRow.innerText()).includes("IN PROGRESS")) {
        projectListUpdated = true;
        break;
      }
      await pageProjList.waitForTimeout(300);
    }
    check("Project list tab picked up the new status WITHOUT a manual reload", projectListUpdated);
    check("Overlay never armed on the Project list tab during the background refresh", !(await overlayIsVisible(pageProjList)));
    check("Project list tab's URL is unchanged (no navigation occurred)", pageProjList.url() === projectsUrl);

    // ══════════════════════ 2. Filtered Project list: status change makes the row disappear ══════════════════════
    console.log("\n=== 2. Filtered /projects?status=... list: a status change makes the row disappear once it no longer matches ===\n");

    await pageProjList.goto(`${BASE_URL}/projects?departmentId=${dept.id}&view=list&status=IN_PROGRESS`);
    await pageProjList.waitForLoadState("load");
    const filteredProjectRow = pageProjList.locator("tr", { hasText: project.title });
    await filteredProjectRow.waitFor({ state: "visible", timeout: 10000 });
    check("Status-filtered Project list (IN_PROGRESS) shows the project while it matches", true);

    const projPatchRes2 = await pageProjEdit.request.patch(`${BASE_URL}/api/projects/${project.id}`, {
      data: { status: "COMPLETED" },
      headers: { "Content-Type": "application/json" },
    });
    check("Second tab's Project status change to COMPLETED -> 200", projPatchRes2.status() === 200);

    let projectRowGone = false;
    for (let i = 0; i < 20; i++) {
      if ((await filteredProjectRow.count()) === 0) {
        projectRowGone = true;
        break;
      }
      await pageProjList.waitForTimeout(300);
    }
    check("The row DISAPPEARED from the IN_PROGRESS-filtered list once it no longer matched, without a manual reload", projectRowGone);
    check("The filtered list tab's search params are still exactly as left (status=IN_PROGRESS)", pageProjList.url().includes("status=IN_PROGRESS"));

    // ══════════════════════ 3. Activity list: a change in tab 2 updates tab 1 ══════════════════════
    console.log("\n=== 3. /activities list: editing an Activity from a second tab updates the first tab's row, without a manual reload ===\n");

    const activity = await prisma.projectActivity.create({
      data: { title: `BV Activity Realtime ${RUN_ID}`, departmentId: dept.id, status: "TODO", priority: "MEDIUM", createdById: admin.id },
    });
    activityIds.push(activity.id);

    const contextActList = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageActList = await contextActList.newPage();
    attachCapture(pageActList, consoleErrors, failedRequests);
    await login(pageActList);
    await pageActList.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });
    const activitiesUrl = `${BASE_URL}/activities?departmentId=${dept.id}&view=list`;
    await pageActList.goto(activitiesUrl);
    await pageActList.waitForLoadState("load");
    const activityRow = pageActList.locator("tr", { hasText: activity.title });
    await activityRow.waitFor({ state: "visible", timeout: 10000 });
    check("Activity list tab shows the activity with its initial priority (MEDIUM)", (await activityRow.innerText()).includes("MEDIUM"));
    check("Overlay is hidden at rest on the Activity list tab", !(await overlayIsVisible(pageActList)));

    const contextActEdit = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageActEdit = await contextActEdit.newPage();
    attachCapture(pageActEdit, consoleErrors, failedRequests);
    await login(pageActEdit);

    const actPatchRes = await pageActEdit.request.patch(`${BASE_URL}/api/activities/${activity.id}`, {
      data: { priority: "URGENT" },
      headers: { "Content-Type": "application/json" },
    });
    check("Second tab's Activity priority change -> 200", actPatchRes.status() === 200);

    let activityListUpdated = false;
    for (let i = 0; i < 20; i++) {
      if ((await activityRow.innerText()).includes("URGENT")) {
        activityListUpdated = true;
        break;
      }
      await pageActList.waitForTimeout(300);
    }
    check("Activity list tab picked up the new priority WITHOUT a manual reload", activityListUpdated);
    check("Overlay never armed on the Activity list tab during the background refresh", !(await overlayIsVisible(pageActList)));
    check("Activity list tab's URL is unchanged (no navigation occurred)", pageActList.url() === activitiesUrl);

    // ══════════════════════ 4. Sorted Activity list: status change moves the row ══════════════════════
    console.log("\n=== 4. Sorted /activities?sortBy=priority list: a priority change moves the row without a manual reload ===\n");

    const lowActivity = await prisma.projectActivity.create({
      data: { title: `BV Activity Low ${RUN_ID}`, departmentId: dept.id, status: "TODO", priority: "LOW", createdById: admin.id },
    });
    activityIds.push(lowActivity.id);

    await pageActList.goto(`${BASE_URL}/activities?departmentId=${dept.id}&view=list&sortBy=priority&sortOrder=asc`);
    await pageActList.waitForLoadState("load");
    const rowsBefore = await pageActList.locator("tbody tr").allInnerTexts();
    const lowIndexBefore = rowsBefore.findIndex((t) => t.includes(lowActivity.title));
    check("Sorted-ascending list initially places the LOW-priority activity before the URGENT one", lowIndexBefore !== -1 && lowIndexBefore < rowsBefore.findIndex((t) => t.includes(activity.title)));

    const actPatchRes2 = await pageActEdit.request.patch(`${BASE_URL}/api/activities/${lowActivity.id}`, {
      data: { priority: "URGENT" },
      headers: { "Content-Type": "application/json" },
    });
    check("Second tab's Activity priority change (LOW -> URGENT) -> 200", actPatchRes2.status() === 200);

    let rowMoved = false;
    for (let i = 0; i < 20; i++) {
      const rowsNow = await pageActList.locator("tbody tr").allInnerTexts();
      const idxNow = rowsNow.findIndex((t) => t.includes(lowActivity.title));
      if (idxNow !== -1 && idxNow >= rowsNow.findIndex((t) => t.includes(activity.title))) {
        rowMoved = true;
        break;
      }
      await pageActList.waitForTimeout(300);
    }
    check("The row MOVED to reflect its new sort position (now on/after the other URGENT row) without a manual reload", rowMoved);
    check("The sorted list tab's URL (sortBy/sortOrder) is unchanged", pageActList.url().includes("sortBy=priority") && pageActList.url().includes("sortOrder=asc"));

    // ══════════════════════ Console/network error summary ══════════════════════
    console.log("\n=== Console/network error summary ===\n");
    check("Zero console errors across the whole run", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the whole run", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {});
    for (const deptId of deptIds) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
      await prisma.department.delete({ where: { id: deptId } }).catch(() => {});
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
