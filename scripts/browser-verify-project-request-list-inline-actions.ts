/**
 * Real interactive browser smoke test for inline Preview/Approve/Reject on
 * the Project Requests list — Preview from each tab, Approve from Awaiting,
 * Reject on a second fixture, Business Assessment validation in the shared
 * decision dialog, successful row movement to History, and confirmation
 * that the URL never changes (no full-page redirect, no navigation overlay)
 * through the whole flow.
 *
 * Uses `playwright` directly against a live `npm run dev` server — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-list-inline-actions.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { DepartmentRole, MembershipSource } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const REQUESTER_EMAIL = "user@kinsen.gr";
const REQUESTER_PASSWORD = process.env.DEMO_USER_PASSWORD || "User@123456";
const APPROVER_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const APPROVER_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (that silent partial-cleanup is exactly how earlier test runs left orphaned fixture users/Notification rows in the dev database). */
async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    // This script does many rapid page.goto() calls (switching tabs/users
    // back to back) — ANY in-flight background request from the page being
    // left (notification polling, mention-reminder polling, push config,
    // a prefetched chunk) is expected to abort right then, same underlying
    // reason the established SSE-stream exclusion already documents. A
    // REAL failure is a non-2xx response or a genuine connection error,
    // never a plain ERR_ABORTED caused by our own navigation.
    const isBenign = req.failure()?.errorText === "net::ERR_ABORTED";
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

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
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const dept = await createDepartment({ name: `BV List Dept ${RUN_ID}`, slug: `bv-list-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const type = await prisma.taskType.create({ data: { name: `BV List Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requesterUser = await prisma.user.findFirstOrThrow({ where: { email: REQUESTER_EMAIL } });
    const existingMembership = await prisma.departmentMembership.findFirst({ where: { userId: requesterUser.id, isActive: true } });
    if (!existingMembership) {
      await prisma.departmentMembership.create({
        data: { userId: requesterUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
      });
    } else {
      // user@kinsen.gr already belongs elsewhere from the seed — add THIS
      // department too so the create form auto-selects it unambiguously is
      // not guaranteed, but the explicit departmentId picker will still let
      // us choose it.
      await prisma.departmentMembership.create({
        data: { userId: requesterUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
      });
    }

    const context1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const requesterPage = await context1.newPage();
    attachCapture(requesterPage, consoleErrors, failedRequests);

    console.log("\n=== Logging in as the requester and submitting two fixtures (no Business Assessment field) ===\n");
    await login(requesterPage, REQUESTER_EMAIL, REQUESTER_PASSWORD);

    // The requester now belongs to >1 department — the form requires an
    // explicit department pick. Select it right after filling the rest.
    async function selectDepartmentIfNeeded(page: Page) {
      const deptTrigger = page.locator("#departmentId");
      if (await deptTrigger.count()) {
        await deptTrigger.click();
        await page.getByRole("option", { name: dept.name }).click({ timeout: 5000 });
      }
    }

    await requesterPage.goto(`${BASE_URL}/project-requests/new`);
    await requesterPage.waitForLoadState("load");
    await requesterPage.fill("#title", `BV List Approve Target ${RUN_ID}`);
    await requesterPage.fill("#description", "A description that is definitely long enough for validation.");
    await selectDepartmentIfNeeded(requesterPage);
    // Project Type was removed from the Project Request Form entirely —
    // see TaskType in prisma/schema.prisma. No field to interact with here.
    await requesterPage.fill("#teamConcerned", "Engineering");
    await requesterPage.fill("#expectedBenefits", "Benefits text that is definitely long enough for validation.");
    check("Create form has NO Business Assessment field at all", (await requesterPage.locator("#businessAssessment").count()) === 0);
    const [approveTargetRes] = await Promise.all([
      requesterPage.waitForResponse((res) => res.url().endsWith("/api/project-requests") && res.request().method() === "POST", { timeout: 10000 }),
      requesterPage.getByRole("button", { name: "Submit Request" }).click(),
    ]);
    check("Submission (Approve-target fixture) succeeds -> 201", approveTargetRes.status() === 201);
    const approveTarget = (await approveTargetRes.json()) as { id: string };
    requestIds.push(approveTarget.id);

    await requesterPage.goto(`${BASE_URL}/project-requests/new`);
    await requesterPage.waitForLoadState("load");
    await requesterPage.fill("#title", `BV List Reject Target ${RUN_ID}`);
    await requesterPage.fill("#description", "A description that is definitely long enough for validation.");
    await selectDepartmentIfNeeded(requesterPage);
    await requesterPage.fill("#teamConcerned", "Engineering");
    await requesterPage.fill("#expectedBenefits", "Benefits text that is definitely long enough for validation.");
    const [rejectTargetRes] = await Promise.all([
      requesterPage.waitForResponse((res) => res.url().endsWith("/api/project-requests") && res.request().method() === "POST", { timeout: 10000 }),
      requesterPage.getByRole("button", { name: "Submit Request" }).click(),
    ]);
    check("Submission (Reject-target fixture) succeeds -> 201", rejectTargetRes.status() === 201);
    const rejectTarget = (await rejectTargetRes.json()) as { id: string };
    requestIds.push(rejectTarget.id);

    console.log("\n=== Preview from 'My Requests' (requester) — modal opens, no URL change ===\n");
    await requesterPage.goto(`${BASE_URL}/project-requests?tab=mine`);
    await requesterPage.waitForLoadState("load");
    const urlBeforePreview = requesterPage.url();
    // The dedicated Actions-column Preview button (an icon-only ghost
    // button) — scoped via the row's LAST cell to disambiguate it from the
    // Title cell's own button, which carries the identical tooltip text.
    const myRequestsRow = requesterPage.getByRole("row", { name: new RegExp(`BV List Approve Target ${RUN_ID}`) });
    await myRequestsRow.locator("td").last().getByTitle("Preview this request").click();
    await requesterPage.waitForSelector('[role="dialog"]');
    check("Preview dialog opened from 'My Requests' via the Actions-column Preview button", await requesterPage.locator('[role="dialog"]').isVisible());
    check("URL did NOT change when Preview opened", requesterPage.url() === urlBeforePreview);
    check("Preview shows Description field", await requesterPage.getByText("Description", { exact: true }).isVisible());
    check("Preview shows no Approve/Reject (requester has no approval authority)", (await requesterPage.getByRole("button", { name: "Approve request" }).count()) === 0);
    await requesterPage.keyboard.press("Escape");
    await requesterPage.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});
    check("Escape closed the Preview dialog", !(await requesterPage.locator('[role="dialog"]').isVisible().catch(() => false)));

    console.log("\n=== Logging in as the approver (separate browser context) and deciding both fixtures ===\n");
    const context2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const approverPage = await context2.newPage();
    attachCapture(approverPage, consoleErrors, failedRequests);
    await login(approverPage, APPROVER_EMAIL, APPROVER_PASSWORD);

    await approverPage.goto(`${BASE_URL}/project-requests?tab=awaiting`);
    await approverPage.waitForLoadState("load");
    const awaitingUrl = approverPage.url();

    const approveRow = approverPage.getByRole("row", { name: new RegExp(`BV List Approve Target ${RUN_ID}`) });
    await approveRow.waitFor({ state: "visible", timeout: 10000 });
    check("Approve-target row is visible in 'Awaiting My Approval'", await approveRow.isVisible());

    // Preview from Awaiting, then Approve FROM WITHIN the preview modal.
    await approveRow.locator("td").last().getByTitle("Preview this request").click();
    await approverPage.waitForSelector('[role="dialog"]');
    check("Preview opened for the approver from 'Awaiting My Approval'", await approverPage.locator('[role="dialog"]').isVisible());
    const previewDialog = approverPage.locator('[role="dialog"]');
    check("Preview shows an Approve action for an authorized approver", await previewDialog.getByRole("button", { name: "Approve", exact: true }).isVisible());
    await previewDialog.getByRole("button", { name: "Approve", exact: true }).click();
    await approverPage.waitForSelector('text=Approve Project Request');

    // Confirm with an EMPTY Business Assessment -> inline validation error, no mutation.
    const confirmBtn = approverPage.getByRole("button", { name: "Approve request" });
    await confirmBtn.click();
    check("Confirming with an EMPTY Business Assessment shows an inline validation error", await approverPage.getByText("Business Assessment is required.").isVisible());

    // Now fill a real assessment and confirm for real.
    await approverPage.fill("#pr-decision-assessment", "Looks good, approving via inline list action.");
    const [decisionRes] = await Promise.all([
      approverPage.waitForResponse((res) => res.url().includes("/approval") && res.request().method() === "POST", { timeout: 10000 }),
      confirmBtn.click(),
    ]);
    check("Approve decision POST succeeds -> 200", decisionRes.status() === 200);
    await approverPage.waitForSelector('text=Approve Project Request', { state: "detached", timeout: 10000 });
    check("Decision dialog closed after success", !(await approverPage.getByText("Approve Project Request").isVisible().catch(() => false)));
    check("URL is STILL the original 'awaiting' URL (no redirect, no URL change)", approverPage.url() === awaitingUrl);

    await approverPage.waitForTimeout(500); // let router.refresh()'s RSC fetch settle
    check("The approved row is GONE from 'Awaiting My Approval' after refresh (same URL, no manual reload)", (await approverPage.getByRole("row", { name: new RegExp(`BV List Approve Target ${RUN_ID}`) }).count()) === 0);

    console.log("\n=== Reject the second fixture directly from the row buttons (not via Preview) ===\n");
    await approverPage.goto(`${BASE_URL}/project-requests?tab=awaiting`);
    await approverPage.waitForLoadState("load");
    const rejectRow = approverPage.getByRole("row", { name: new RegExp(`BV List Reject Target ${RUN_ID}`) });
    await rejectRow.waitFor({ state: "visible", timeout: 10000 });
    check("Reject-target row is visible in 'Awaiting My Approval'", await rejectRow.isVisible());
    await rejectRow.locator("td").last().getByRole("button", { name: "Reject", exact: true }).click();
    await approverPage.waitForSelector('text=Reject Project Request');
    await approverPage.fill("#pr-decision-assessment", "Not needed at this time — rejecting via inline row action.");
    const rejectUrlBefore = approverPage.url();
    const [rejectRes] = await Promise.all([
      approverPage.waitForResponse((res) => res.url().includes("/approval") && res.request().method() === "POST", { timeout: 10000 }),
      approverPage.getByRole("button", { name: "Reject request" }).click(),
    ]);
    check("Reject decision POST succeeds -> 200", rejectRes.status() === 200);
    check("URL unchanged after reject too", approverPage.url() === rejectUrlBefore);

    console.log("\n=== Both decided requests now appear in History, for both the approver and the requester ===\n");
    await approverPage.goto(`${BASE_URL}/project-requests?tab=history`);
    await approverPage.waitForLoadState("load");
    const historyApproveRow = approverPage.getByRole("row", { name: new RegExp(`BV List Approve Target ${RUN_ID}`) });
    const historyRejectRow = approverPage.getByRole("row", { name: new RegExp(`BV List Reject Target ${RUN_ID}`) });
    // .isVisible() checks the DOM at this exact instant with no retry — the
    // RSC payload for a hard navigation can still be streaming in right
    // after the `load` event fires, so wait for the row to actually appear
    // before asserting (same reasoning as every other auto-waiting
    // Playwright assertion; this script predates @playwright/test's
    // `expect`, so it's spelled out explicitly here).
    const approveRowAppeared = await historyApproveRow.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
    check("Approve-target now appears in the approver's History", approveRowAppeared);
    const rejectRowAppeared = await historyRejectRow.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
    check("Reject-target now appears in the approver's History", rejectRowAppeared);

    await requesterPage.goto(`${BASE_URL}/project-requests?tab=mine`);
    await requesterPage.waitForLoadState("load");
    await requesterPage.getByRole("row", { name: new RegExp(`BV List Approve Target ${RUN_ID}`) }).locator("td").last().getByTitle("Preview this request").click();
    await requesterPage.waitForSelector('[role="dialog"]');
    check("Requester's Preview of the now-APPROVED request shows the Approved-by summary", await requesterPage.getByText(/Approved by/).isVisible());
    check("...and the real Business Assessment text from the approver", await requesterPage.getByText("Looks good, approving via inline list action.").isVisible());
    await requesterPage.keyboard.press("Escape");

    console.log("\n=== Console/network error summary ===\n");
    check("No unexpected console errors across the whole flow", consoleErrors.length === 0);
    if (consoleErrors.length) console.log(consoleErrors.join("\n"));
    check("No unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length) console.log(failedRequests.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.taskType.deleteMany({ where: { id: { in: typeIds } } })],
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ]);
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
