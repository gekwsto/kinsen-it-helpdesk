/**
 * Real interactive browser verification for the reported bug: the System
 * Administrator account (admin@kinsen.gr) genuinely has ZERO direct
 * DepartmentMembership rows and no manager set — confirmed directly against
 * the dev database before writing this — which is EXACTLY the reproduction
 * case: a global-scope user whose real active workspace the OLD, narrower
 * resolveDepartmentForRequest (direct-membership-only) could never see.
 *
 * UPDATED for the single-stage approval redesign: submission no longer has
 * any manager dependency at all (there is no more manager stage, and no
 * Business Assessment field on the create form — see
 * scripts/test-project-request-business-assessment.ts) — a correctly
 * department-resolved submission now succeeds outright (201), not a
 * manager-specific 409.
 *
 * Uses `playwright` directly against a live `npm run dev` server — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-department-eligibility.ts
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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (that silent partial-cleanup is exactly how earlier runs of this suite left orphaned fixture users/Notification rows in the dev database). */
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
    // Chromium itself auto-logs any non-2xx fetch response as a console
    // "Failed to load resource" error — this test deliberately triggers a
    // real 400 (forged inactive department), so that specific expected
    // error response is excluded here; any OTHER console error still fails
    // the run.
    if (msg.type() === "error" && !/Failed to load resource.*400/.test(msg.text())) consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    // ANY aborted request is expected noise from ordinary page navigation
    // (an in-flight background poll/prefetch cancelled by the next
    // navigation) — a real failure is a non-2xx response or a genuine
    // connection error, never a plain ERR_ABORTED caused by navigating.
    const isBenign = req.failure()?.errorText === "net::ERR_ABORTED";
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
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL } });
    const directMembershipCount = await prisma.departmentMembership.count({ where: { userId: admin.id } });
    check("Fixture (real dev DB, not synthetic): the System Administrator account genuinely has ZERO direct DepartmentMembership rows — the exact reported reproduction", directMembershipCount === 0);

    const targetDept = await createDepartment({ name: `DRC Manual Primary Dept ${RUN_ID}`, slug: `drc-manual-primary-${RUN_ID}` });
    deptIds.push(targetDept.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors, failedRequests);
    await login(page);

    // Select this department as the active workspace — exactly what the
    // bug report describes ("έχει ήδη έγκυρο, επιλεγμένο workspace").
    const setWorkspaceRes = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: targetDept.id } });
    check("Active workspace set to the target department -> 200", setWorkspaceRes.status() === 200);

    console.log("\n=== 1/3. /project-requests/new no longer shows the false 'no department' empty state ===\n");
    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForLoadState("load");
    const bodyText = await page.locator("body").innerText();
    check("The false \"You don't belong to any active department\" message is GONE", !/don.t belong to any active department/i.test(bodyText));
    check("The real Project Request Form is shown instead (Title field present)", (await page.locator("#title").count()) > 0);
    check("The create form has NO Business Assessment field (moved to the approver's decision — see the single-stage redesign)", (await page.locator("#businessAssessment").count()) === 0);

    console.log(`\n=== The active department "${targetDept.name}" is pre-selected as the default ===\n`);
    // ADMIN is global-scope, so the canonical accessible set is EVERY active
    // department in this (shared, long-lived dev) database — a real
    // Department picker renders, unlike a single-department requester. The
    // meaningful assertion here is that the just-selected active workspace
    // is what's PRE-SELECTED as its default value, not that the picker is
    // absent.
    const deptPickerCount = await page.locator("#departmentId").count();
    check("A real Department picker is shown (this ADMIN's canonical accessible set spans every active department, not just one)", deptPickerCount > 0);
    const deptTriggerText = await page.locator("#departmentId").innerText();
    check(`The active workspace "${targetDept.name}" is pre-selected as the picker's default value`, deptTriggerText.includes(targetDept.name));

    console.log("\n=== 4. Submitting now succeeds outright — no manager dependency anywhere in this flow ===\n");
    const typeRes = await page.request.post(`${BASE_URL}/api/admin/project-request-types`, { data: { name: `BV Elig Type ${RUN_ID}` } });
    check("Fixture: created an active Project Request Type", typeRes.status() === 201);
    const createdType = await typeRes.json();
    typeIds.push(createdType.id);

    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForLoadState("load");
    await page.fill("#title", `BV Elig Request ${RUN_ID}`);
    await page.fill("#description", "A description that is definitely long enough for validation.");
    // Project Type select (shadcn Select — click trigger, pick the option).
    await page.locator("#projectTypeId").click();
    await page.getByRole("option", { name: new RegExp(`BV Elig Type ${RUN_ID}`) }).click({ timeout: 5000 });
    await page.fill("#teamConcerned", "Engineering");
    await page.fill("#expectedBenefits", "Benefits text that is definitely long enough for validation.");
    const [submitResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith("/api/project-requests") && res.request().method() === "POST", { timeout: 10000 }),
      page.getByRole("button", { name: "Submit Request" }).click(),
    ]);
    check("Submission from a global-scope ADMIN with zero direct memberships, department already resolved -> 201 (never a manager-related failure — there is no manager stage)", submitResponse.status() === 201);
    const submitBody = await submitResponse.json().catch(() => ({}));
    if (submitBody?.id) requestIds.push(submitBody.id);

    const navigatedToDetail = await page
      .waitForURL((url) => url.pathname.includes(`/project-requests/${submitBody?.id ?? ""}`), { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check("...navigated to the new request's own detail page (successful submission, not stuck on /new)", navigatedToDetail);

    console.log("\n=== Forged Department is rejected server-side even from a real authenticated browser request ===\n");
    const otherDept = await createDepartment({ name: `BV Elig Forged Target ${RUN_ID}`, slug: `bv-elig-forged-${RUN_ID}` });
    deptIds.push(otherDept.id);
    // Make the admin NOT globally-scoped for this specific probe is not
    // possible (ADMIN is always global-scope) — so this proves the
    // INACTIVE-department rejection path instead, which is real and
    // meaningful for ANY caller including a global-scope one.
    await prisma.department.update({ where: { id: otherDept.id }, data: { isActive: false } });
    const forgedRes = await page.request.post(`${BASE_URL}/api/project-requests`, {
      data: {
        title: `BV Elig Forged ${RUN_ID}`,
        description: "A description that is definitely long enough for validation.",
        importance: 2,
        projectTypeId: createdType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text that is definitely long enough for validation.",
        replacesExisting: false,
        departmentId: otherDept.id,
      },
    });
    check("A forged (inactive) departmentId submitted via a real authenticated request -> rejected (400)", forgedRes.status() === 400);
    const forgedCount = await prisma.projectRequest.count({ where: { title: `BV Elig Forged ${RUN_ID}` } });
    check("...and created NO ProjectRequest row", forgedCount === 0);

    console.log("\n=== Console/network error summary ===\n");
    check("Zero console errors across the whole run", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the whole run", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      // Notification has no FK/cascade to ProjectRequest, and submission
      // fans out to every eligible approver — including the REAL admin
      // account itself (global projectRequest.approve) — so this is keyed
      // by link, not by an enumerated recipient list.
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } })],
      ...deptIds.flatMap((deptId): [string, () => Promise<unknown>][] => [
        [`ticket categories (${deptId})`, () => prisma.ticketCategory.deleteMany({ where: { departmentId: deptId } })],
        [`ticket priorities (${deptId})`, () => prisma.ticketPriority.deleteMany({ where: { departmentId: deptId } })],
        [`ticket statuses (${deptId})`, () => prisma.ticketStatus.deleteMany({ where: { departmentId: deptId } })],
        [`activity progress config (${deptId})`, () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: deptId } })],
        [`project status config (${deptId})`, () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: deptId } })],
        [`activity status config (${deptId})`, () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: deptId } })],
        [`activity priority config (${deptId})`, () => prisma.activityPriorityConfig.deleteMany({ where: { departmentId: deptId } })],
        [`department (${deptId})`, () => prisma.department.delete({ where: { id: deptId } })],
      ]),
    ]);
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
