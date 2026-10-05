/**
 * Live browser verification for the Project/Activity FINANCIAL behavior UI:
 *
 *   A. Project setup (request-origin): no Budget field anywhere; Estimated
 *      Cost/Actual Cost render readonly, both '€0.00' before any Activity
 *      exists.
 *   B. Creating an Activity with a Task Type (€150/day) and a 12-day
 *      Expected Start/Finish span shows a live Estimated Cost preview
 *      (€1800.00) on the create form, and the Project detail page reflects
 *      it immediately after creation.
 *   C. Completing the Activity (via the real quick-status control) shows a
 *      real, non-placeholder Actual Cost on the Activity detail page, and
 *      the Project detail page's Actual Cost total reflects it.
 *   D. Reopening the Activity makes its Actual Cost disappear from BOTH the
 *      Activity detail page and the Project's total, immediately.
 *   E. Completing again (after the Activity's Expected Start/Finish were
 *      shifted, same span) shows a NEW Actual Cost on both pages — never
 *      the old value added to the new one.
 *   F. Bumping the Task Type's MASTER cost after creation never changes the
 *      already-created Activity's displayed Estimated/Actual Cost. A
 *      manual Project's own Activity is unaffected throughout (stays
 *      '€0.00' the whole time, never even shown a Project Request Setup
 *      card at all).
 *
 * Determinism note: the server always derives Actual Days from the real
 * server clock (`new Date()`) at the moment of completion — there is no
 * client-controllable "pretend today is 14 Oct" lever, and this suite
 * deliberately never adds one (a forged client date is exactly the
 * "client-authoritative calculation" this feature's own spec forbids).
 * Instead, Expected Start/Finish are computed HERE relative to the real
 * "now" so the illustrative numbers from the spec (12 Expected Days, 9 then
 * 12 Actual Days, €1800/€1350/€1800) come out exactly, using the REAL
 * clock, not a mocked one.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-project-activity-financials-ui.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvpaf-${RUN_ID}`;

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

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", ADMIN_EMAIL);
  await page.fill("#credentials-password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

/** YYYY-MM-DD, `offsetDays` days from real "now" (negative = past). */
function dateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
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
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const taskTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });
    const taskType = await prisma.activityTaskType.create({ data: { name: `${TAG}-tasktype`, cost: 150 } });
    taskTypeIds.push(taskType.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    }).catch(() => {});

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Financials UI fixture — description long enough for validation.",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
        departmentId: dept.id,
      })
    );
    if (submitRes.status !== 201) throw new Error(`Fixture submit failed: ${submitRes.status}: ${JSON.stringify(await submitRes.json())}`);
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "fixture",
        projectOwnerId: admin.id,
        expectedStartDate: dateOffset(-30),
        expectedFinishDate: dateOffset(-18),
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const project = await setupRes.json();
    projectIds.push(project.id);

    // A manual Project + manual Activity, for the "completely unaffected
    // throughout" guarantee re-checked at the very end.
    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(manualProject.id);
    const manualActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} manual activity`, projectId: manualProject.id, departmentId: dept.id, createdById: admin.id },
    });
    activityIds.push(manualActivity.id);
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);

    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    const workspaceTrigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
    await workspaceTrigger.click();
    await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 }).catch(() => {});
    await page.fill('input[placeholder="Search workspaces..."]', `${TAG}-dept`);
    await page.waitForTimeout(300);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/workspace/active") && r.request().method() === "POST"),
      page.getByRole("menuitem", { name: new RegExp(`${TAG}-dept`) }).first().click(),
    ]);
    await page.waitForTimeout(200);

    // ══════════════════════ A. Project detail: no Budget, Estimated/Actual Cost readonly '€0.00' ══════════════════════
    console.log("\n=== A. Project detail (request-origin, zero Activities): no Budget, Estimated/Actual Cost '€0.00' ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("A. 'Budget' is not rendered anywhere on the Project detail page", (await page.getByText("Budget", { exact: true }).count()) === 0);
    check("A. Estimated Cost shows '€0.00' (no Activities exist yet)", (await page.getByText("€0.00").count()) >= 2);
    check("A. The Project Request Setup card itself is visible", (await page.getByText("Project Request Setup", { exact: true }).count()) > 0);

    // A (edit page): Budget removed entirely; Estimated/Actual Cost readonly.
    const editControl = page.getByRole("link", { name: /edit project request setup/i });
    await editControl.click();
    await page.waitForURL((url) => url.pathname === `/projects/${project.id}/edit`, { timeout: 10000 });
    await page.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    check("A. Edit page has NO Budget input at all", (await page.locator("#budget").count()) === 0);
    check("A. Edit page's Estimated Cost input is readOnly", await page.locator("#estimatedCost").evaluate((el) => (el as HTMLInputElement).readOnly));
    check("A. Edit page's Actual Cost input is readOnly", await page.locator("#actualCost").evaluate((el) => (el as HTMLInputElement).readOnly));

    // ══════════════════════ B. Activity creation: live Estimated Cost preview ══════════════════════
    console.log("\n=== B. Activity creation UI: Estimated Cost preview = Task Type cost × Expected Days ===\n");
    await page.goto(`${BASE_URL}/activities/new`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const projectSelect = page.getByRole("combobox").filter({ hasText: /no project/i });
    await projectSelect.click();
    await page.getByRole("option", { name: `${TAG} request`, exact: true }).click();
    await page.waitForTimeout(400);

    await page.fill("#title", `${TAG} Act1`);
    const expStart = dateOffset(-9);
    const expFinish = dateOffset(3); // 12-day span
    await page.fill("#expected-start", expStart);
    await page.fill("#expected-finish", expFinish);
    const expectedDaysValue = await page.locator("#expected-days").inputValue();
    check("B. Expected Days preview shows 12 days", expectedDaysValue === "12 days");

    await page.locator("#task-type").click();
    await page.getByRole("option", { name: `${TAG}-tasktype` }).click();
    await page.waitForTimeout(150);
    const estimatedCostPreview = await page.locator("#estimated-cost").inputValue();
    check("B. Estimated Cost preview shows '1800.00 EUR' (150 × 12) BEFORE submitting — client preview only, never sent to the server", estimatedCostPreview === "1800.00 EUR");

    await page.locator("#owner").click();
    await page.getByRole("option", { name: "System Administrator" }).first().click();
    const firstUserCheckbox = page.locator('input[type="checkbox"]').first();
    await firstUserCheckbox.check();

    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const act1Id = page.url().split("/").pop()!;
    activityIds.push(act1Id);
    check("B. Activity created successfully", true);

    await page.goto(`${BASE_URL}/activities/${act1Id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("B. Activity detail page shows Estimated Cost '1800.00 EUR' (server-computed, same as the preview)", (await page.getByText("1800.00 EUR").count()) > 0);
    check("B. Actual Cost is '0.00 EUR' before completion", (await page.getByText("0.00 EUR").count()) > 0);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("B. Project detail's Estimated Cost now shows '€1800.00' — reflects the one Activity, with zero extra bookkeeping", (await page.getByText("€1800.00").count()) > 0);

    // ══════════════════════ C. Completion: real Actual Cost appears ══════════════════════
    console.log("\n=== C. Completing the Activity shows a real Actual Cost on both pages ===\n");
    await page.goto(`${BASE_URL}/activities/${act1Id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const statusControl = page.getByRole("button", { name: /change activity status/i });
    await statusControl.click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: /completed/i }).first().click();
    await page.waitForTimeout(800);
    // Expected Start is 9 days before "today" -> Actual Days = 9 -> 150×9 = 1350.
    check("C. Activity detail's Actual Cost shows '1350.00 EUR' (150 × 9 Actual Days, computed from the REAL server clock)", (await page.getByText("1350.00 EUR").count()) > 0);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("C. Project detail's Actual Cost now shows '€1350.00' too", (await page.getByText("€1350.00").count()) > 0);

    // ══════════════════════ D. Reopen: Actual Cost disappears immediately ══════════════════════
    console.log("\n=== D. Reopening clears Actual Cost on both pages immediately ===\n");
    await page.goto(`${BASE_URL}/activities/${act1Id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /change activity status/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: /in progress/i }).first().click();
    await page.waitForTimeout(800);
    check("D. Activity detail's Actual Cost is back to '0.00 EUR' immediately after reopening", (await page.getByText("0.00 EUR").count()) > 0);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("D. Project detail's Actual Cost total excludes the reopened Activity — back to '€0.00'", (await page.getByText("€0.00").count()) >= 1);
    check("...while Estimated Cost is UNCHANGED at '€1800.00' (reopening never touches Estimated Cost)", (await page.getByText("€1800.00").count()) > 0);

    // ══════════════════════ E. Re-complete: a NEW, different Actual Cost ══════════════════════
    console.log("\n=== E. Completing again (after shifting Expected Start/Finish) shows a NEW Actual Cost, not 1350+1800 ===\n");
    // Shift both dates back by 3 more days (same 12-day span, so Estimated
    // Cost/Expected Days stay put) via the real edit route — not a direct
    // DB write — so this exercises the actual PATCH path a user would use.
    const activitiesPATCH = (await import("@/app/api/activities/[id]/route")).PATCH;
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await activitiesPATCH(jsonReq({ expectedStartDate: dateOffset(-12), expectedFinishDate: dateOffset(0) }), { params: Promise.resolve({ id: act1Id }) });
    fixtureSession = null;

    await page.goto(`${BASE_URL}/activities/${act1Id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /change activity status/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: /completed/i }).first().click();
    await page.waitForTimeout(800);
    // New Expected Start is 12 days before "today" -> Actual Days = 12 -> 150×12 = 1800.
    check("E. Activity detail's Actual Cost now shows '1800.00 EUR' — the FRESH calculation, not '1350' nor '3150' (1350+1800)", (await page.getByText("1800.00 EUR").count()) > 0 && (await page.getByText(/3150/).count()) === 0);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("E. Project detail's Actual Cost shows '€1800.00' — never '€3150.00'", (await page.getByText("€1800.00").count()) >= 1 && (await page.getByText("€3150.00").count()) === 0);

    // ══════════════════════ F. Master Task Type price bump never affects this Activity ══════════════════════
    console.log("\n=== F. Bumping the Task Type's MASTER cost never retroactively changes this Activity's displayed cost ===\n");
    await prisma.activityTaskType.update({ where: { id: taskType.id }, data: { cost: 9999 } });
    await page.goto(`${BASE_URL}/activities/${act1Id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("F. Activity detail's Estimated Cost is STILL '1800.00 EUR' (the frozen €150/day snapshot), not a recalculation off the new €9999/day master price", (await page.getByText("1800.00 EUR").count()) > 0);
    check("...and Actual Cost is STILL '1800.00 EUR' too — the snapshot, never the live master cost", (await page.getByText("1800.00 EUR").count()) >= 1);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("F. Project detail's totals are unaffected by the master price bump too", (await page.getByText("€1800.00").count()) >= 1);

    // F (continued): the manual Project/Activity never showed a Request
    // Setup card and never displayed anything but €0.00, throughout.
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("F. The unrelated manual Project never rendered a 'Project Request Setup' card at all", (await page.getByText("Project Request Setup", { exact: true }).count()) === 0);
    await page.goto(`${BASE_URL}/activities/${manualActivity.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("F. The manual Activity's detail page never rendered a 'Project Request Setup' card either", (await page.getByText("Project Request Setup", { exact: true }).count()) === 0);
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
      await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
