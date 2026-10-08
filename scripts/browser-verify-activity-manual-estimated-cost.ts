/**
 * Live browser verification for manual Estimated Cost on Activity creation
 * when the selected Task Sub Type has NO configured fixed cost (see
 * components/activities/activity-new-form.tsx, app/api/activities/route.ts):
 *   - A fixed-cost Task Sub Type shows a readonly "Cost: ... EUR" line, no
 *     editable input.
 *   - A null-cost Task Sub Type dynamically reveals a required, editable
 *     "Estimated Cost *" input.
 *   - Switching from null-cost -> fixed-cost clears the manual input and
 *     hides it again.
 *   - Switching from fixed-cost -> null-cost reveals the (empty) manual
 *     input again, requiring re-entry.
 *   - Submitting with the null-cost subtype and a filled-in manual cost
 *     persists that value as the Activity's taskSubTypeCost snapshot.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-manual-estimated-cost.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvmec-${RUN_ID}`;

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
  const taskSubTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });
    const fixedSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-fixed`, cost: 120 } });
    taskSubTypeIds.push(fixedSubType.id);
    const nullSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-null`, cost: null } });
    taskSubTypeIds.push(nullSubType.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

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
        description: "Manual Estimated Cost UI fixture — description long enough.",
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
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    console.log("\n=== Open the Activity create form for the request-origin Project ===\n");
    await page.goto(`${BASE_URL}/projects/${requestOriginProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("link", { name: /add activity/i }).click();
    await page.waitForURL((url) => url.pathname === "/activities/new", { timeout: 10000 });
    await page.locator("#task-sub-type").waitFor({ state: "visible", timeout: 10000 });

    console.log("\n=== 1-3. Fixed-cost Task Sub Type: readonly cost text, no editable input ===\n");
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-fixed` }).click();
    await page.waitForTimeout(200);
    check("1. Readonly cost text shows the configured cost (120.00 EUR)", (await page.getByText(/120\.00 EUR/).count()) > 0);
    check("2. No editable manual Estimated Cost input is rendered", (await page.locator("#manual-estimated-cost").count()) === 0);
    check("3. No 'Estimated Cost *' label is rendered for a fixed-cost subtype", (await page.getByText("Estimated Cost", { exact: false }).filter({ hasText: "*" }).count()) === 0);

    console.log("\n=== 4-6. Switching to a null-cost Task Sub Type reveals the required manual input ===\n");
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-null` }).click();
    await page.waitForTimeout(200);
    check("4. The readonly fixed-cost text is gone", (await page.getByText(/120\.00 EUR/).count()) === 0);
    check("5. The editable manual Estimated Cost input now appears", (await page.locator("#manual-estimated-cost").count()) === 1);
    check("6. The manual input starts empty (not carrying over anything stale)", (await page.locator("#manual-estimated-cost").inputValue()) === "");

    console.log("\n=== 7. Submitting with the null-cost subtype but NO manual cost is blocked client-side ===\n");
    await page.fill("#title", `${TAG} blocked submit`);
    await page.locator("#task-type").click();
    await page.getByRole("option", { name: `${TAG}-reqtype` }).click();
    await page.fill("#expected-start", "2026-09-02");
    await page.fill("#expected-finish", "2026-09-06");
    await page.locator("#owner").click();
    await page.getByRole("option", { name: "System Administrator" }).first().click();
    await page.locator('input[type="checkbox"]').first().check();
    const urlBeforeBlockedSubmit = page.url();
    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForTimeout(800);
    check("7. Submission is blocked — still on /activities/new, no Activity created from empty manual cost", page.url() === urlBeforeBlockedSubmit);

    console.log("\n=== 8-10. Filling the manual cost and submitting creates the Activity with that snapshot ===\n");
    await page.fill("#manual-estimated-cost", "88.25");
    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const createdActivityId = page.url().split("/").pop()!;
    activityIds.push(createdActivityId);
    const createdRow = await prisma.projectActivity.findUniqueOrThrow({ where: { id: createdActivityId } });
    check("8. The persisted Activity's taskSubTypeCost snapshot is exactly 88.25 (the manual entry)", Number(createdRow.taskSubTypeCost) === 88.25);
    const nullSubTypeRowAfter = await prisma.taskSubType.findUniqueOrThrow({ where: { id: nullSubType.id } });
    check("9. TaskSubType.cost for the null-cost subtype itself is still null — never backfilled from the manual entry", nullSubTypeRowAfter.cost === null);
    await page.getByText("Project Request Setup", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    check("10. Project Request Setup card appears on the new Activity's own detail page", (await page.getByText("Project Request Setup", { exact: true }).count()) > 0);

    console.log("\n=== 11-12. Switching from null-cost -> fixed-cost clears the manual input (fresh form) ===\n");
    await page.goto(`${BASE_URL}/activities/new?projectId=${requestOriginProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-null` }).click();
    await page.waitForTimeout(150);
    await page.fill("#manual-estimated-cost", "55.00");
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-fixed` }).click();
    await page.waitForTimeout(200);
    check("11. Switching to the fixed-cost subtype hides the manual input again", (await page.locator("#manual-estimated-cost").count()) === 0);
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-null` }).click();
    await page.waitForTimeout(200);
    check("12. Switching BACK to the null-cost subtype shows the manual input EMPTY — the earlier 55.00 never silently carried over", (await page.locator("#manual-estimated-cost").inputValue()) === "");

    console.log("\n=== No console errors throughout ===\n");
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
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
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
