/**
 * Live browser verification for the new search affordances on the Project
 * Request form (components/project-requests/project-request-form.tsx):
 *   1. Department selector (now the shared WorkspaceCombobox) supports
 *      case-insensitive partial search; clearing restores the full set.
 *   2. Intermediate Approvers gets a new search input above the existing
 *      checkbox list, filtering by name/email, WITHOUT ever clearing an
 *      already-selected (even currently search-hidden) approver — and the
 *      final submission includes every selected approver regardless of
 *      what was visible at submit time.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-search.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvprs-${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const deptAlpha = await createDepartment({ name: `0000-${TAG}-Alpha-Dept`, slug: `0000-${TAG}-alpha-dept` });
    departmentIds.push(deptAlpha.id);
    const deptBeta = await createDepartment({ name: `0001-${TAG}-Beta-Dept`, slug: `0001-${TAG}-beta-dept` });
    departmentIds.push(deptBeta.id);

    // Two fresh, globally-eligible (Role.ADMIN bypasses hasPermission, so
    // every ADMIN qualifies for projectRequest.intermediateApprove without
    // any extra RolePermission plumbing) intermediate approvers, clearly
    // tagged so they're unambiguous against this long-lived dev DB's own
    // accumulated fixture noise.
    const approverAlpha = await prisma.user.create({
      data: { email: `${TAG}-alpha-approver@example.com`, name: `${TAG} Approver Alpha`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(approverAlpha.id);
    const approverBeta = await prisma.user.create({
      data: { email: `${TAG}-beta-approver@example.com`, name: `${TAG} Approver Beta`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(approverBeta.id);

    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-type` } });
    typeIds.push(reqType.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    console.log("\n=== 1. Open /project-requests/new, search the Department combobox ===\n");
    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForLoadState("load");
    const deptTrigger = page.locator("#departmentId");
    check("Department combobox is present (ADMIN's accessible set spans many departments)", (await deptTrigger.count()) > 0);
    await deptTrigger.click();
    await page.waitForTimeout(300);
    let bodyText = await page.locator("body").innerText();
    check("Both fixture Departments are listed before any search", bodyText.includes(deptAlpha.name) && bodyText.includes(deptBeta.name));

    const deptSearchInput = page.locator('input[placeholder="Search workspaces…"]');
    await deptSearchInput.fill("alpha-dept");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Lowercase partial 'alpha-dept' finds the mixed-case Alpha Department", bodyText.includes(deptAlpha.name));
    check("...and hides the non-matching Beta Department", !bodyText.includes(deptBeta.name));

    await deptSearchInput.fill("");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Clearing the search restores both Departments", bodyText.includes(deptAlpha.name) && bodyText.includes(deptBeta.name));

    await page.locator('[role="option"]', { hasText: deptAlpha.name }).first().click();
    await page.waitForTimeout(300);
    check("Selecting Alpha updates the Department field's displayed value", (await deptTrigger.innerText()).includes(deptAlpha.name));

    console.log("\n=== 2. Intermediate Approvers: search filters by name/email without losing selections ===\n");
    const approverSearchInput = page.locator('input[placeholder="Search approvers by name or email..."]');
    check("Approver search input is present", (await approverSearchInput.count()) > 0);

    bodyText = await page.locator("body").innerText();
    check("Both fixture approvers are listed before any search", bodyText.includes(`${TAG} Approver Alpha`) && bodyText.includes(`${TAG} Approver Beta`));

    await approverSearchInput.fill("Approver Alpha");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Searching 'Approver Alpha' shows Alpha", bodyText.includes(`${TAG} Approver Alpha`));
    check("...and hides Beta", !bodyText.includes(`${TAG} Approver Beta`));

    // Select Alpha while Beta is hidden by the search.
    await page.locator("label", { hasText: `${TAG} Approver Alpha` }).locator('input[type="checkbox"]').check();
    check("Alpha's checkbox is checked", await page.locator("label", { hasText: `${TAG} Approver Alpha` }).locator('input[type="checkbox"]').isChecked());

    console.log("\n=== 3. Searching for something else still doesn't lose the Alpha selection ===\n");
    await approverSearchInput.fill("Approver Beta");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Searching 'Approver Beta' now shows Beta, hides Alpha from view", bodyText.includes(`${TAG} Approver Beta`) && !bodyText.includes(`${TAG} Approver Alpha`));
    await page.locator("label", { hasText: `${TAG} Approver Beta` }).locator('input[type="checkbox"]').check();
    check("Beta's checkbox is also checked", await page.locator("label", { hasText: `${TAG} Approver Beta` }).locator('input[type="checkbox"]').isChecked());

    console.log("\n=== 4. Clearing the search restores the full list with BOTH selections intact ===\n");
    await approverSearchInput.fill("");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Both approvers visible again after clearing", bodyText.includes(`${TAG} Approver Alpha`) && bodyText.includes(`${TAG} Approver Beta`));
    check("Alpha is STILL checked (never lost while hidden by search)", await page.locator("label", { hasText: `${TAG} Approver Alpha` }).locator('input[type="checkbox"]').isChecked());
    check("Beta is STILL checked", await page.locator("label", { hasText: `${TAG} Approver Beta` }).locator('input[type="checkbox"]').isChecked());

    console.log("\n=== 5. Submission includes BOTH selected approvers, even ones hidden by search at any point ===\n");
    await page.fill("#title", `${TAG} request title`);
    await page.fill("#description", "A description that is definitely long enough for validation.");
    // Project Type was removed from the Project Request Form entirely —
    // see TaskType in prisma/schema.prisma. No field to interact with here
    // any more (the `reqType` fixture above is simply unused now).
    await page.fill("#teamConcerned", "Engineering");
    await page.fill("#expectedBenefits", "Benefits text that is definitely long enough for validation.");

    const [submitResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith("/api/project-requests") && res.request().method() === "POST", { timeout: 10000 }),
      page.getByRole("button", { name: "Submit Request" }).click(),
    ]);
    check("Submission -> 201", submitResponse.status() === 201);
    const submitBody = await submitResponse.json().catch(() => ({}));
    if (submitBody?.id) requestIds.push(submitBody.id);

    const persisted = await prisma.projectRequestIntermediateApprover.findMany({
      where: { projectRequestId: submitBody?.id },
      select: { approverId: true },
    });
    const persistedIds = new Set(persisted.map((p) => p.approverId));
    check(
      "The persisted request's intermediate approvers include BOTH Alpha and Beta — the complete selection, not just whichever was visible at submit time",
      persistedIds.has(approverAlpha.id) && persistedIds.has(approverBeta.id)
    );
    const persistedRequest = await prisma.projectRequest.findUnique({ where: { id: submitBody?.id }, select: { departmentId: true } });
    check("The persisted request's department is the one selected via the searchable combobox (Alpha)", persistedRequest?.departmentId === deptAlpha.id);

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
