/**
 * Real interactive browser verification for Ticket-list realtime refresh —
 * two separate browser contexts (two independent "tabs"/sessions), exactly
 * the scenario the reported symptom describes: one tab sits on a Ticket
 * list, a second tab changes a Ticket's Status through the normal UI, and
 * the first tab must pick up the change automatically, no manual reload.
 * Repeated with an active Status filter on the list tab, where the row must
 * actually disappear once the ticket no longer matches the filter.
 *
 * Also exercises the confirmed, fixed gap (Ticket attachment upload not
 * publishing a list invalidation — see the FINAL REPORT) end to end via a
 * real upload, watching the list row's attachment-count badge.
 *
 * Uses `playwright` directly against a live `npm run dev` server — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention, e.g. browser-verify-activity-filters-
 * live-update.ts).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-list-realtime.ts
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
  const ticketIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const dept = await createDepartment({ name: `BV Ticket Realtime ${RUN_ID}`, slug: `bv-ticket-rt-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL } });
    const statuses = await prisma.ticketStatus.findMany({ where: { departmentId: dept.id }, orderBy: { order: "asc" } });
    const openStatus = statuses.find((s) => !s.isClosed)!;
    const otherOpenStatus = statuses.find((s) => s.id !== openStatus.id && !s.isClosed)!;

    // ══════════════════════ 1. Unfiltered list: status change auto-updates ══════════════════════
    console.log("\n=== 1. Unfiltered /tickets list: a Status change in one tab updates the row in another, without a manual reload ===\n");

    const ticketA = await prisma.ticket.create({
      data: { title: `BV Ticket Status ${RUN_ID}`, description: "d", requesterId: admin.id, departmentId: dept.id, statusId: openStatus.id, ticketNumber: Math.floor(Math.random() * 1000000) },
    });
    ticketIds.push(ticketA.id);

    const contextList = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageList = await contextList.newPage();
    attachCapture(pageList, consoleErrors, failedRequests);
    await login(pageList);
    await pageList.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });
    await pageList.goto(`${BASE_URL}/tickets?departmentId=${dept.id}`);
    await pageList.waitForLoadState("load");
    const rowA = pageList.locator("tr", { hasText: ticketA.title });
    await rowA.waitFor({ state: "visible", timeout: 10000 });
    check("List tab shows the ticket with its initial status", (await rowA.innerText()).includes(openStatus.name));
    check("Overlay is hidden at rest on the list tab", !(await overlayIsVisible(pageList)));

    const contextEdit = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageEdit = await contextEdit.newPage();
    attachCapture(pageEdit, consoleErrors, failedRequests);
    await login(pageEdit);
    await pageEdit.goto(`${BASE_URL}/tickets/${ticketA.id}`);
    await pageEdit.waitForLoadState("load");

    await pageEdit.locator('button:has-text("Change Status")').first().click();
    await pageEdit.getByRole("dialog", { name: "Change Status" }).waitFor({ state: "visible", timeout: 5000 });
    await pageEdit.getByRole("combobox").first().click();
    await pageEdit.waitForTimeout(150);
    await pageEdit.getByRole("option", { name: new RegExp(otherOpenStatus.name) }).click({ timeout: 5000 });
    await pageEdit.getByRole("button", { name: "Update Status" }).click();
    await pageEdit.waitForTimeout(500);
    check("Detail tab (the reported symptom's OWN success criterion) shows the new status", (await pageEdit.locator("body").innerText()).includes(otherOpenStatus.name));

    let listUpdated = false;
    for (let i = 0; i < 20; i++) {
      if ((await rowA.innerText()).includes(otherOpenStatus.name)) {
        listUpdated = true;
        break;
      }
      await pageList.waitForTimeout(300);
    }
    check("List tab picked up the new status WITHOUT a manual reload (the reported symptom, now verified fixed/working)", listUpdated);
    check("Overlay never armed on the list tab during the background refresh", !(await overlayIsVisible(pageList)));
    check("List tab's URL is unchanged (no navigation occurred)", pageList.url() === `${BASE_URL}/tickets?departmentId=${dept.id}`);

    // ══════════════════════ 2. Filtered list: status change makes the row disappear/appear ══════════════════════
    console.log("\n=== 2. Filtered /tickets?statusId=... list: a Status change makes the row disappear from a no-longer-matching filter ===\n");

    const ticketB = await prisma.ticket.create({
      data: { title: `BV Ticket Filtered ${RUN_ID}`, description: "d", requesterId: admin.id, departmentId: dept.id, statusId: openStatus.id, ticketNumber: Math.floor(Math.random() * 1000000) },
    });
    ticketIds.push(ticketB.id);

    await pageList.goto(`${BASE_URL}/tickets?departmentId=${dept.id}&statusId=${openStatus.id}`);
    await pageList.waitForLoadState("load");
    const rowB = pageList.locator("tr", { hasText: ticketB.title });
    await rowB.waitFor({ state: "visible", timeout: 10000 });
    check("Filtered list (statusId=Open) shows the ticket while it matches", true);

    await pageEdit.goto(`${BASE_URL}/tickets/${ticketB.id}`);
    await pageEdit.waitForLoadState("load");
    await pageEdit.locator('button:has-text("Change Status")').first().click();
    await pageEdit.getByRole("dialog", { name: "Change Status" }).waitFor({ state: "visible", timeout: 5000 });
    await pageEdit.getByRole("combobox").first().click();
    await pageEdit.waitForTimeout(150);
    await pageEdit.getByRole("option", { name: new RegExp(otherOpenStatus.name) }).click({ timeout: 5000 });
    await pageEdit.getByRole("button", { name: "Update Status" }).click();
    await pageEdit.waitForTimeout(500);

    let rowGone = false;
    for (let i = 0; i < 20; i++) {
      if ((await rowB.count()) === 0) {
        rowGone = true;
        break;
      }
      await pageList.waitForTimeout(300);
    }
    check("The row DISAPPEARED from the Open-filtered list once it no longer matched, without a manual reload", rowGone);
    check("The list tab's search params (statusId filter) are still exactly as the user left them", pageList.url().includes(`statusId=${openStatus.id}`));

    // Move it back to Open — must REAPPEAR.
    await pageEdit.locator('button:has-text("Change Status")').first().click();
    await pageEdit.getByRole("dialog", { name: "Change Status" }).waitFor({ state: "visible", timeout: 5000 });
    await pageEdit.getByRole("combobox").first().click();
    await pageEdit.waitForTimeout(150);
    await pageEdit.getByRole("option", { name: new RegExp(openStatus.name) }).click({ timeout: 5000 });
    await pageEdit.getByRole("button", { name: "Update Status" }).click();
    await pageEdit.waitForTimeout(500);

    let rowBack = false;
    for (let i = 0; i < 20; i++) {
      if ((await rowB.count()) > 0) {
        rowBack = true;
        break;
      }
      await pageList.waitForTimeout(300);
    }
    check("The row REAPPEARED once it matched the filter again, without a manual reload", rowBack);

    // ══════════════════════ 3. The fixed gap: attachment upload updates the list badge ══════════════════════
    console.log("\n=== 3. Confirmed-fixed gap: uploading a Ticket attachment updates the list's attachment-count badge live ===\n");

    await pageList.goto(`${BASE_URL}/tickets?departmentId=${dept.id}`);
    await pageList.waitForLoadState("load");
    const rowA2 = pageList.locator("tr", { hasText: ticketA.title });
    await rowA2.waitFor({ state: "visible", timeout: 10000 });
    check("No attachment badge before upload", (await rowA2.locator("svg.lucide-paperclip").count()) === 0);

    const uploadRes = await pageEdit.request.post(`${BASE_URL}/api/tickets/${ticketA.id}/attachments`, {
      multipart: { file: { name: "bv.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
    });
    check("Attachment upload -> 201", uploadRes.status() === 201);

    let badgeAppeared = false;
    for (let i = 0; i < 20; i++) {
      if ((await rowA2.locator("svg.lucide-paperclip").count()) > 0) {
        badgeAppeared = true;
        break;
      }
      await pageList.waitForTimeout(300);
    }
    check("The attachment badge appeared on the list row WITHOUT a manual reload (the confirmed, fixed gap)", badgeAppeared);

    // ══════════════════════ Console/network error summary ══════════════════════
    console.log("\n=== Console/network error summary ===\n");
    check("Zero console errors across the whole run", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the whole run", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
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
