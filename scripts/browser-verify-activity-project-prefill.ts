/**
 * Live browser verification for the "Add Activity from a Project" bug fix:
 * clicking "Add Activity" on a Project's own detail page must land on the
 * Activity create form with that EXACT Project already selected — never an
 * empty Project selector requiring the user to pick it again.
 *
 * Uses the REAL click-through path (Project detail -> "Add Activity"), not
 * a direct /activities/new?projectId=... navigation — the click-through is
 * the actual bug path this feature fixes.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-project-prefill.ts
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
const TAG = `bvapp-${RUN_ID}`;

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
  const taskTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });
    const taskType = await prisma.activityTaskType.create({ data: { name: `${TAG}-tasktype`, cost: 55 } });
    taskTypeIds.push(taskType.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
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
        description: "Activity Project-prefill UI fixture — description long enough.",
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
        ownerIds: [admin.id],
        expectedStartDate: "2026-09-01",
        expectedFinishDate: "2026-09-08",
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

    // ══════════════════════ A. Normal/manual Project click-through ══════════════════════
    console.log("\n=== A. Normal Project: Project detail -> \"Add Activity\" click-through ===\n");
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("link", { name: /add activity/i }).click();
    await page.waitForURL((url) => url.pathname === "/activities/new", { timeout: 10000 });
    const projectSelectA = page.getByRole("combobox").filter({ hasText: manualProject.title });
    // Waits for the preselection effect to actually land (the projects
    // fetch + the effect that applies preselectedProjectId), rather than a
    // fixed sleep that can race a cold first compile of this route.
    await projectSelectA.waitFor({ state: "visible", timeout: 10000 });
    check("A1. The Project selector already shows the manual Project — no manual reselection needed", (await projectSelectA.count()) === 1);
    check("A2. No request-origin fields appear for a manual Project", (await page.locator("#expected-start").count()) === 0);

    await page.fill("#title", `${TAG} Manual click-through Activity`);
    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const manualActivityId = page.url().split("/").pop()!;
    activityIds.push(manualActivityId);
    const manualProjectLink = page.getByRole("link", { name: manualProject.title, exact: true }).first();
    await manualProjectLink.waitFor({ state: "visible", timeout: 10000 });
    check("A3. Submitting without touching the Project selector links to the SAME Project it opened from", (await manualProjectLink.count()) > 0);

    // ══════════════════════ B. Request-origin Project click-through ══════════════════════
    console.log("\n=== B. Request-origin Project: Project detail -> \"Add Activity\" click-through ===\n");
    await page.goto(`${BASE_URL}/projects/${requestOriginProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("link", { name: /add activity/i }).click();
    await page.waitForURL((url) => url.pathname === "/activities/new", { timeout: 10000 });
    const projectSelectB = page.getByRole("combobox").filter({ hasText: `${TAG} request` });
    await projectSelectB.waitFor({ state: "visible", timeout: 10000 });
    check("B1. The Project selector already shows the request-origin Project", (await projectSelectB.count()) === 1);
    check(
      "B2. The request-origin extended fields appear IMMEDIATELY, with no reselection of the Project required",
      (await page.locator("#expected-start").count()) === 1 &&
        (await page.locator("#expected-finish").count()) === 1 &&
        (await page.locator("#task-type").count()) === 1 &&
        (await page.locator("#owner").count()) === 1
    );
    check("B3. Related Users label appears too (reused assignedUsers, relabeled)", (await page.getByText("Related Users", { exact: false }).count()) > 0);

    await page.fill("#title", `${TAG} RO click-through Activity`);
    await page.fill("#expected-start", "2026-09-02");
    await page.fill("#expected-finish", "2026-09-06");
    await page.locator("#task-type").click();
    await page.getByRole("option", { name: `${TAG}-tasktype` }).click();
    await page.waitForTimeout(150);
    await page.locator("#owner").click();
    await page.getByRole("option", { name: "System Administrator" }).first().click();
    await page.locator('input[type="checkbox"]').first().check();

    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const roActivityId = page.url().split("/").pop()!;
    activityIds.push(roActivityId);
    const roProjectLink = page.getByRole("link", { name: `${TAG} request`, exact: true }).first();
    await roProjectLink.waitFor({ state: "visible", timeout: 10000 });
    check("B4. Submitting creates the Activity under the SAME request-origin Project it opened from", (await roProjectLink.count()) > 0);
    check("B5. Project Request Setup card appears on the new Activity's own detail page", (await page.getByText("Project Request Setup", { exact: true }).count()) > 0);

    // ══════════════════════ Direct /activities/new unaffected ══════════════════════
    console.log("\n=== Direct /activities/new (regression guard — not via a Project) ===\n");
    await page.goto(`${BASE_URL}/activities/new`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const noProjectSelect = page.getByRole("combobox").filter({ hasText: /no project/i });
    check("Direct navigation still starts with no Project preselected", (await noProjectSelect.count()) === 1);
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
      await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } });
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
