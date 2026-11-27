/**
 * Browser verification — Ticket Resolution Time Tracking.
 *
 *  1. Admin Actions "Resolve" opens the duration dialog (3 empty optional
 *     inputs, helper text, Cancel / Resolve Ticket); Cancel changes nothing.
 *  2. Resolve with a duration; value shown under "Edit Resolution Time",
 *     which sits directly below "Link Project / Activity".
 *  3. Persistence after reload; edit dialog prefilled, Cancel / Save.
 *  4. 10 hours normalizes to 1d 2h; invalid input blocked client-side.
 *  5. Clear all fields -> Not recorded (NULL).
 *  6. Reopen via Change Status keeps the value; Change Status -> Resolved
 *     goes through the same dialog, prefilled.
 *  7. Resolve without any duration.
 *  8. Closed ticket: Edit Resolution Time still available and works.
 *  9. Unauthorized user: no Edit Resolution Time control.
 * 10. History tab shows the audit entries.
 * 11. Dark theme + mobile / tablet viewports: dialog fits, inputs usable.
 * 12. Kanban: dropping on "Resolved" opens the dialog; Cancel keeps the card.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-resolution-time.ts
 */
import { chromium, type Page, type Browser } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, DepartmentRole } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = `Rt-${RUN_ID}-Pw!`;
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function loginAs(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('form[data-hydrated="true"]').waitFor({ timeout: 60000 });
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 60000 }), page.click('button:has-text("Sign in as Admin")')]);
}
async function openTicket(page: Page, id: string) {
  await page.goto(`${BASE}/tickets/${id}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Details", { exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(500); // hydration
}
const dialog = (page: Page) => page.getByRole("dialog");
async function fillDuration(page: Page, d: string, h: string, m: string) {
  await page.fill("#resolution-time-days", d);
  await page.fill("#resolution-time-hours", h);
  await page.fill("#resolution-time-minutes", m);
}
const inputValues = async (page: Page) => [await page.inputValue("#resolution-time-days"), await page.inputValue("#resolution-time-hours"), await page.inputValue("#resolution-time-minutes")].join("/");
const shownValue = async (page: Page) => (await page.getByTestId("resolution-time-value").textContent())?.replace(/\s+/g, " ").trim();
const row = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id }, include: { status: true } });

async function main() {
  const dept = await createDepartment({ name: `RT Dept ${RUN_ID}`, slug: `rt-${RUN_ID}` });
  const statuses = await prisma.ticketStatus.findMany({ where: { departmentId: dept.id } });
  const open = statuses.find((s) => s.name === "Open")!;
  const resolved = statuses.find((s) => s.name === "Resolved")!;
  const closed = statuses.find((s) => s.isClosed)!;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const admin = await prisma.user.create({ data: { email: `rt-admin-${RUN_ID}@kinsen.gr`, name: "RT Admin", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
  const requester = await prisma.user.create({ data: { email: `rt-req-${RUN_ID}@kinsen.gr`, name: "RT Requester", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
  await grantManualMembership(requester.id, dept.id, { role: DepartmentRole.REQUESTER });
  const mk = (title: string, statusId = open.id) => prisma.ticket.create({ data: { title: `RT ${title} ${RUN_ID}`, description: "fixture", requesterId: requester.id, departmentId: dept.id, statusId } });
  const t1 = await mk("main");
  const t2 = await mk("no-duration");
  const t3 = await mk("closed");
  const t4 = await mk("kanban");

  const browser: Browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    await loginAs(page, admin.email, PASSWORD);

    console.log("\n=== 1. Resolve dialog + Cancel ===\n");
    await openTicket(page, t1.id);
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await dialog(page).waitFor();
    check("1a. Resolve opens a dialog instead of resolving immediately", (await row(t1.id)).statusId === open.id);
    check("1b. three inputs Days / Hours / Minutes, all empty", (await inputValues(page)) === "//" && (await dialog(page).getByLabel("Days").isVisible()) && (await dialog(page).getByLabel("Hours").isVisible()) && (await dialog(page).getByLabel("Minutes").isVisible()));
    check("1c. helper text '1 day = 8 working hours.'", await dialog(page).getByText("1 day = 8 working hours.").isVisible());
    check("1d. buttons Cancel and Resolve Ticket", (await dialog(page).getByRole("button", { name: "Cancel" }).isVisible()) && (await dialog(page).getByRole("button", { name: "Resolve Ticket" }).isVisible()));
    await fillDuration(page, "3", "", "");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    let r = await row(t1.id);
    check("1e. Cancel closes without modifying anything", r.statusId === open.id && r.resolutionTimeMinutes === null && (await prisma.ticketHistory.count({ where: { ticketId: t1.id } })) === 0);
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    check("1f. reopening after Cancel starts empty again (abandoned input discarded)", (await inputValues(page)) === "//");

    console.log("\n=== 2. Resolve with a duration ===\n");
    await fillDuration(page, "1", "2", "30");
    await dialog(page).getByRole("button", { name: "Resolve Ticket" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    r = await row(t1.id);
    check("2a. resolved with 630 minutes", r.status.name === "Resolved" && r.resolutionTimeMinutes === 630, `${r.status.name} ${r.resolutionTimeMinutes}`);
    check("2b. value shown under the button: 1d 2h 30m", (await shownValue(page)) === "Resolution time: 1d 2h 30m", await shownValue(page));
    const order = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim());
      return { link: btns.indexOf("Link Project / Activity"), edit: btns.indexOf("Edit Resolution Time") };
    });
    check("2c. Edit Resolution Time sits directly below Link Project / Activity", order.link >= 0 && order.edit === order.link + 1, JSON.stringify(order));
    const linkBtn = await page.getByRole("button", { name: "Link Project / Activity" }).boundingBox();
    const editBtn = await page.getByRole("button", { name: "Edit Resolution Time" }).boundingBox();
    check("2d. same width/x as the existing action buttons", !!linkBtn && !!editBtn && Math.abs(linkBtn.x - editBtn.x) < 1 && Math.abs(linkBtn.width - editBtn.width) < 1 && editBtn.y > linkBtn.y);

    console.log("\n=== 3. Persistence + edit prefill ===\n");
    await openTicket(page, t1.id);
    check("3a. after reload still 1d 2h 30m", (await shownValue(page)) === "Resolution time: 1d 2h 30m");
    await page.getByRole("button", { name: "Edit Resolution Time" }).click();
    await dialog(page).waitFor();
    check("3b. edit dialog prefilled 1 / 2 / 30", (await inputValues(page)) === "1/2/30", await inputValues(page));
    check("3c. edit buttons Cancel and Save", (await dialog(page).getByRole("button", { name: "Cancel" }).isVisible()) && (await dialog(page).getByRole("button", { name: "Save" }).isVisible()));

    console.log("\n=== 4. Normalization + invalid input ===\n");
    await fillDuration(page, "", "-1", "");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    check("4a. invalid value shows an error and keeps the dialog open", (await dialog(page).getByRole("alert").isVisible()) && (await row(t1.id)).resolutionTimeMinutes === 630);
    await fillDuration(page, "", "10", "");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    r = await row(t1.id);
    check("4b. 10 hours saved as 600 minutes, status unchanged", r.resolutionTimeMinutes === 600 && r.status.name === "Resolved");
    check("4c. displayed normalized as 1d 2h", (await shownValue(page)) === "Resolution time: 1d 2h", await shownValue(page));
    await page.getByRole("button", { name: "Edit Resolution Time" }).click();
    check("4d. prefilled normalized 1 / 2 / 0", (await inputValues(page)) === "1/2/0", await inputValues(page));

    console.log("\n=== 5. Clear back to NULL ===\n");
    await fillDuration(page, "", "", "");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    check("5a. cleared -> NULL in the DB", (await row(t1.id)).resolutionTimeMinutes === null);
    check("5b. shows 'Not recorded'", (await shownValue(page)) === "Resolution time: Not recorded");
    await page.getByRole("button", { name: "Edit Resolution Time" }).click();
    await fillDuration(page, "0", "", "");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    check("5c. explicit 0 saved as 0 and shown as 0m (distinct from Not recorded)", (await row(t1.id)).resolutionTimeMinutes === 0 && (await shownValue(page)) === "Resolution time: 0m");

    console.log("\n=== 6. Reopen + Change Status -> Resolved ===\n");
    await page.getByRole("button", { name: "Edit Resolution Time" }).click();
    await fillDuration(page, "", "2", "15");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    const changeStatus = async (name: string) => {
      await page.getByRole("button", { name: "Change Status" }).click();
      await dialog(page).getByRole("combobox").click();
      await page.getByRole("option", { name }).click();
      await dialog(page).getByRole("button", { name: "Update Status" }).click();
    };
    await changeStatus("Open");
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(600);
    r = await row(t1.id);
    check("6a. reopen via Change Status: no duration dialog, value preserved (135)", r.status.name === "Open" && r.resolutionTimeMinutes === 135);
    await changeStatus("Resolved");
    await page.getByRole("button", { name: "Resolve Ticket" }).waitFor();
    check("6b. Change Status -> Resolved opens the same dialog, prefilled 0 / 2 / 15", (await inputValues(page)) === "0/2/15", await inputValues(page));
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(400);
    check("6c. Cancel from Change Status keeps the ticket Open", (await row(t1.id)).status.name === "Open");
    await changeStatus("Resolved");
    await page.getByRole("button", { name: "Resolve Ticket" }).waitFor();
    await fillDuration(page, "", "3", "");
    await page.getByRole("button", { name: "Resolve Ticket" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    r = await row(t1.id);
    check("6d. resolved through Change Status with the modified value (180), not accumulated", r.status.name === "Resolved" && r.resolutionTimeMinutes === 180, `${r.status.name} ${r.resolutionTimeMinutes}`);
    check("6e. display updated to 3h", (await shownValue(page)) === "Resolution time: 3h", await shownValue(page));

    console.log("\n=== 7. Resolve without a duration ===\n");
    await openTicket(page, t2.id);
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Resolve Ticket" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(400);
    r = await row(t2.id);
    check("7a. resolved with no duration -> NULL, not blocked", r.status.name === "Resolved" && r.resolutionTimeMinutes === null);

    console.log("\n=== 8. Closed ticket ===\n");
    await prisma.ticket.update({ where: { id: t3.id }, data: { statusId: closed.id, closedAt: new Date("2026-11-20T10:00:00Z") } });
    await openTicket(page, t3.id);
    await page.getByRole("button", { name: "Edit Resolution Time" }).click();
    await fillDuration(page, "2", "4", "15");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    r = await row(t3.id);
    check("8a. closed ticket edited to 1215, still closed, closedAt untouched", r.resolutionTimeMinutes === 1215 && r.statusId === closed.id && r.closedAt?.toISOString() === "2026-11-20T10:00:00.000Z");

    console.log("\n=== 9. History ===\n");
    await openTicket(page, t1.id);
    await page.getByRole("tab", { name: /History/ }).click();
    check("9a. history shows the resolution-time audit entries", (await page.getByText("Resolution time changed from Not recorded to 1d 2h 30m").count()) === 1 && (await page.getByText(/Resolution time changed from 0m to 2h 15m/).count()) === 1);

    console.log("\n=== 10. Unauthorized user ===\n");
    const rctx = await browser.newContext();
    const rpage = await rctx.newPage();
    await loginAs(rpage, requester.email, PASSWORD);
    await openTicket(rpage, t3.id);
    check("10a. requester (no ticket.resolutionTime.edit): no Edit Resolution Time control", (await rpage.getByRole("button", { name: "Edit Resolution Time" }).count()) === 0 && (await rpage.getByTestId("resolution-time-value").count()) === 0);
    await rctx.close();

    console.log("\n=== 11. Dark theme + responsive ===\n");
    for (const vp of [{ name: "mobile", width: 390, height: 844 }, { name: "tablet", width: 820, height: 1180 }]) {
      const dctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: "dark" });
      const dpage = await dctx.newPage();
      await loginAs(dpage, admin.email, PASSWORD);
      await openTicket(dpage, t1.id);
      const isDark = await dpage.evaluate(() => document.documentElement.classList.contains("dark"));
      await dpage.getByRole("button", { name: "Edit Resolution Time" }).scrollIntoViewIfNeeded();
      await dpage.getByRole("button", { name: "Edit Resolution Time" }).click();
      await dialog(dpage).waitFor();
      await dpage.waitForTimeout(500); // open animation
      const box = await dialog(dpage).boundingBox();
      const inputs = await Promise.all(["days", "hours", "minutes"].map((k) => dpage.locator(`#resolution-time-${k}`).boundingBox()));
      check(`11. ${vp.name} (dark=${isDark}): dialog fits the viewport`, !!box && box.x >= 0 && box.x + box.width <= vp.width + 0.5, JSON.stringify(box));
      check(`11. ${vp.name}: three inputs side by side, each usable (>= 60px wide)`, inputs.every((b) => !!b && b.width >= 60) && Math.abs(inputs[0]!.y - inputs[2]!.y) < 1);
      const bg = await dialog(dpage).evaluate((el) => getComputedStyle(el).backgroundColor);
      check(`11. ${vp.name}: dark theme applied to the dialog`, isDark && bg !== "rgb(255, 255, 255)", bg);
      await dpage.screenshot({ path: `/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/517b094a-bf5a-4601-a37c-f917e2757102/scratchpad/rt-${vp.name}-dark.png` });
      await dctx.close();
    }

    console.log("\n=== 12. Kanban drop on Resolved ===\n");
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async (deptId) => { await fetch("/api/workspace/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ departmentId: deptId }) }); }, dept.id);
    await page.goto(`${BASE}/tickets?view=board`, { waitUntil: "domcontentloaded" });
    const card = page.locator(`[data-kanban-column="${open.id}"]`).locator(`text=${t4.title}`).first();
    await card.waitFor({ timeout: 60000 });
    // Board must be hydrated before dragging, or mouse-up acts as a plain click on the card link.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    const drag = async () => {
      const cb = await page.locator(`text=${t4.title}`).first().boundingBox();
      const tb = await page.locator(`[data-kanban-column="${resolved.id}"]`).boundingBox();
      if (!cb || !tb) return;
      await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.move(cb.x + cb.width / 2 + 20, cb.y + cb.height / 2 + 20, { steps: 5 });
      await page.waitForTimeout(100);
      await page.mouse.move(tb.x + tb.width / 2, tb.y + 80, { steps: 15 });
      await page.waitForTimeout(150);
      await page.mouse.move(tb.x + tb.width / 2, tb.y + 90, { steps: 5 });
      await page.waitForTimeout(150);
      await page.mouse.up();
    };
    await drag();
    await dialog(page).waitFor({ timeout: 5000 }).catch(() => undefined);
    check("12a. drop on Resolved opens the duration dialog", await dialog(page).getByRole("button", { name: "Resolve Ticket" }).isVisible().catch(() => false));
    await dialog(page).getByRole("button", { name: "Cancel" }).click().catch(() => undefined);
    await page.waitForTimeout(500);
    check("12b. Cancel: ticket stays Open, card stays in its column", (await row(t4.id)).statusId === open.id && (await page.locator(`[data-kanban-column="${open.id}"]`).locator(`text=${t4.title}`).isVisible()));
    // Only the one post-drag click is swallowed — a later plain click still opens the ticket.
    await page.locator(`[data-kanban-column="${open.id}"]`).locator(`text=${t4.title}`).click();
    const navigated = await page.waitForURL((u) => u.pathname === `/tickets/${t4.id}`, { timeout: 30000 }).then(() => true).catch(() => false);
    check("12c0. a plain click after the cancelled drop still opens the ticket", navigated, page.url());
    await page.goto(`${BASE}/tickets?view=board`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-kanban-column="${open.id}"]`).locator(`text=${t4.title}`).waitFor({ timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    await drag();
    await dialog(page).waitFor({ timeout: 5000 }).catch(() => undefined);
    await fillDuration(page, "", "", "45");
    await dialog(page).getByRole("button", { name: "Resolve Ticket" }).click();
    await page.waitForTimeout(1200);
    r = await row(t4.id);
    check("12c. Resolve Ticket from the board: Resolved + 45 minutes", r.statusId === resolved.id && r.resolutionTimeMinutes === 45, `${r.status.name} ${r.resolutionTimeMinutes}`);
    check("12d. card moved to the Resolved column", await page.locator(`[data-kanban-column="${resolved.id}"]`).locator(`text=${t4.title}`).isVisible());
  } finally {
    await browser.close();
    const ids = [t1.id, t2.id, t3.id, t4.id];
    await prisma.ticket.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: [admin.id, requester.id] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [admin.id, requester.id] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, requester.id] } } }).catch((e) => console.warn("cleanup users", String(e.message).split("\n")[0]));
    await prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketCategory.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.department.delete({ where: { id: dept.id } }).catch((e) => console.warn("cleanup dept", String(e.message).split("\n")[0]));
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
