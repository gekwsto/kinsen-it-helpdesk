/**
 * Live browser verification for the request-origin Activity creation UI:
 *
 *   /activities/new
 *
 * Verifies: a request-origin Project's Activity creation shows Expected
 * Start/Finish/Task Type/Owner (required, with asterisks) and Related Users
 * (relabeled, required); a manual Project shows NONE of it; and, after
 * completing a request-origin Activity, its detail page shows the
 * calculated Actual Days.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-request-origin-ui.ts
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
const TAG = `bvaro-${RUN_ID}`;

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
  const userIds: string[] = [];
  const taskTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });
    const taskType = await prisma.taskSubType.create({ data: { name: `${TAG}-tasktype`, cost: 77 } });
    taskTypeIds.push(taskType.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.upsert({
      where: { userId_departmentId: { userId: admin.id, departmentId: dept.id } },
      update: { isActive: true },
      create: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    }).catch(async () => {
      await prisma.departmentMembership.create({
        data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
      });
    });

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
        description: "Activity request-origin UI fixture — description long enough.",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
        // Admin is global-scope (sees every department) — disambiguate
        // explicitly, same as every other fixture in this repo's test
        // suite that submits as an admin/global-scope user.
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
        ownerIds: [admin.id],
        expectedStartDate: "2026-06-01",
        expectedFinishDate: "2026-06-10",
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const requestOriginProject = await setupRes.json();
    projectIds.push(requestOriginProject.id);

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(manualProject.id);
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);

    // The standalone /activities/new form sends the ACTIVE WORKSPACE's
    // department explicitly (never relies on inferring it from whichever
    // Project gets picked) — switch to this fixture's own department first,
    // or POST /api/activities correctly rejects the department mismatch
    // between the active workspace and the selected request-origin Project.
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

    // ══════════════════════ 1. Request-origin create UI ══════════════════════
    console.log("\n=== Request-origin Activity creation UI ===\n");
    await page.goto(`${BASE_URL}/activities/new`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    check("(sanity) None of the request-origin fields show before a project is picked", (await page.locator("#expected-start").count()) === 0);
    check("Task Type field (NEW, universal) is present even before any Project is picked", (await page.locator("#task-type").count()) === 1);

    const projectSelect = page.getByRole("combobox").filter({ hasText: /no project/i });
    await projectSelect.click();
    await page.getByRole("option", { name: `${TAG} request`, exact: true }).click();
    await page.waitForTimeout(400);

    check("Expected Start field appears for a request-origin Project", (await page.locator("#expected-start").count()) === 1);
    check("Expected Finish field appears", (await page.locator("#expected-finish").count()) === 1);
    check("Expected Days (readonly) field appears", (await page.locator("#expected-days").count()) === 1);
    check("...and is readOnly", await page.locator("#expected-days").evaluate((el) => (el as HTMLInputElement).readOnly));
    check("Task Sub Type field appears (request-origin-only, renamed from the old 'Task Type')", (await page.locator("#task-sub-type").count()) === 1);
    check("Owner field appears", (await page.locator("#owner").count()) === 1);
    check("Related Users (relabeled from Assigned Users) text appears", (await page.getByText("Related Users", { exact: false }).count()) > 0);

    // Task Type (NEW, universal) — always visible, independent of
    // request-origin status; must be selected for ANY Activity now.
    await page.locator("#task-type").click();
    await page.getByRole("option", { name: `${TAG}-reqtype` }).click();

    // Fill the whole request-origin block + submit.
    await page.fill("#title", `${TAG} RO Activity`);
    await page.fill("#expected-start", "2026-06-02");
    await page.fill("#expected-finish", "2026-06-09");
    const expectedDaysValue = await page.locator("#expected-days").inputValue();
    check("Expected Days preview shows the real calculated value (7 days)", expectedDaysValue === "7 days");

    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-tasktype` }).click();
    await page.waitForTimeout(150);
    check("Task Sub Type cost shown as informational text after selecting", (await page.getByText(/Cost: 77\.00 EUR/).count()) > 0);

    await page.locator("#owner").click();
    await page.getByRole("option", { name: "System Administrator" }).first().click();

    // Check at least one Related User checkbox.
    const firstUserCheckbox = page.locator('input[type="checkbox"]').first();
    await firstUserCheckbox.check();

    await page.getByRole("button", { name: /create activity/i }).click();
    // Excludes "new" explicitly — the CURRENT url (before the click even
    // resolves) is already /activities/new, which a bare [a-z0-9]+ pattern
    // would also match, making waitForURL resolve immediately against the
    // STALE url instead of actually waiting for the real post-create
    // navigation.
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const newActivityId = page.url().split("/").pop()!;
    activityIds.push(newActivityId);
    check("Submitting the fully-filled request-origin form succeeds and navigates to the new Activity", true);

    // ══════════════════════ 2. Manual Project create UI (regression guard) ══════════════════════
    console.log("\n=== Manual Project Activity creation UI (regression guard) ===\n");
    await page.goto(`${BASE_URL}/activities/new`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const projectSelect2 = page.getByRole("combobox").filter({ hasText: /no project/i });
    await projectSelect2.click();
    await page.getByRole("option", { name: manualProject.title, exact: true }).click();
    await page.waitForTimeout(400);
    check("A manual Project shows NONE of the request-origin-only fields (Task Sub Type included)", (await page.locator("#expected-start").count()) === 0 && (await page.locator("#task-sub-type").count()) === 0 && (await page.locator("#owner").count()) === 0);
    check("...but Task Type (NEW, universal) is STILL shown — it's required for every Activity, manual or not", (await page.locator("#task-type").count()) === 1);
    check("...and the users section is still labeled 'Assigned Users', not 'Related Users'", (await page.getByText("Assigned Users", { exact: true }).count()) === 1);

    // ══════════════════════ 3. Completion -> Actual Days on the detail page ══════════════════════
    console.log("\n=== Activity detail page after completion ===\n");
    await page.goto(`${BASE_URL}/activities/${newActivityId}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    check("Project Request Setup card appears on the detail page for a request-origin Activity", (await page.getByText("Project Request Setup", { exact: true }).count()) > 0);
    check("Actual Days shows 'Not set until completion' before completion", (await page.getByText(/Not set until completion/).count()) > 0);

    // Complete it via the quick-status dropdown (the same real UI control a
    // user would use — not a direct API call). It's a DropdownMenu
    // (role="menuitem" items), not a Select/Listbox (role="option").
    // The trigger's accessible name is its explicit aria-label
    // ("Change activity status" — see components/activities/
    // activity-quick-status.tsx), NOT its visible status-label text, which
    // Playwright's getByRole name-matching uses in preference to innerText.
    const statusControl = page.getByRole("button", { name: /change activity status/i });
    check("(sanity) The quick-status dropdown trigger is found on the detail page", (await statusControl.count()) > 0);
    await statusControl.click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: /completed/i }).first().click();
    await page.waitForTimeout(800);
    check("After marking COMPLETED via the real quick-status control, Actual Days shows a real calculated value", !(await page.getByText(/Not set until completion/).count()));
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskTypeIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
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
