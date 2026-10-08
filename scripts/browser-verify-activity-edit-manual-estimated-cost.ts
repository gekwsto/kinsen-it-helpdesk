/**
 * Live browser verification for manual Estimated Cost in the Activity EDIT
 * flow (app/(main)/activities/[id]/edit/activity-edit-client.tsx), the
 * parallel counterpart to browser-verify-activity-manual-estimated-cost.ts
 * (which covers the create flow):
 *   - Loading an Activity whose Task Sub Type has no configured cost
 *     pre-fills the manual Estimated Cost input with its existing snapshot.
 *   - Editing that manual value and saving updates the snapshot.
 *   - Switching to a fixed-cost Task Sub Type hides the manual input and
 *     shows the readonly configured-cost text instead; saving snapshots the
 *     configured cost.
 *   - Editing an unrelated field afterward (no Task Sub Type change)
 *     leaves the snapshot untouched.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-edit-manual-estimated-cost.ts
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
const TAG = `bvemec-${RUN_ID}`;

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

function taskSubTypeCombobox(page: Page) {
  return page
    .locator("div.space-y-2")
    .filter({ has: page.locator("label", { hasText: "Task Sub Type" }) })
    .locator('button[role="combobox"]');
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
    const activitiesPOST = (await import("@/app/api/activities/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Manual Estimated Cost EDIT flow UI fixture — description long enough.",
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

    // Create the Activity directly via the API with the null-cost subtype
    // and an existing manual snapshot (65), to test the EDIT page's own
    // pre-fill-on-load behavior (not just fresh-form switching, already
    // covered by the create-flow script).
    const act1Res = await activitiesPOST(
      jsonReq({
        title: `${TAG} Act1`,
        projectId: requestOriginProject.id,
        departmentId: dept.id,
        expectedStartDate: "2026-09-02",
        expectedFinishDate: "2026-09-06",
        taskTypeId: reqType.id,
        taskSubTypeId: nullSubType.id,
        manualEstimatedCost: 65,
        ownerId: admin.id,
        assignedUserIds: [admin.id],
      })
    );
    if (act1Res.status !== 201) throw new Error(`Fixture Activity create failed: ${act1Res.status}: ${JSON.stringify(await act1Res.json())}`);
    const act1 = await act1Res.json();
    activityIds.push(act1.id);
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    console.log("\n=== 1-3. Loading the Edit page pre-fills the manual Estimated Cost from the existing snapshot ===\n");
    await page.goto(`${BASE_URL}/activities/${act1.id}/edit`, { waitUntil: "load" });
    await taskSubTypeCombobox(page).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(400);
    check("1. The Task Sub Type combobox shows the null-cost subtype's name", (await taskSubTypeCombobox(page).textContent())?.includes(`${TAG}-null`) ?? false);
    check("2. The manual Estimated Cost input is visible", (await page.locator("#manual-estimated-cost").count()) === 1);
    check("3. ...and PRE-FILLED with the existing snapshot (65)", (await page.locator("#manual-estimated-cost").inputValue()) === "65");

    console.log("\n=== 4-5. Editing the manual cost and saving updates the snapshot ===\n");
    await page.fill("#manual-estimated-cost", "70");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.waitForURL((url) => url.pathname === `/activities/${act1.id}`, { timeout: 10000 });
    let act1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id } });
    check("4. Snapshot updated to the new manual value (70)", Number(act1Row.taskSubTypeCost) === 70);

    console.log("\n=== 6-8. Switching to a fixed-cost Task Sub Type hides the manual input and snapshots the configured cost ===\n");
    await page.goto(`${BASE_URL}/activities/${act1.id}/edit`, { waitUntil: "load" });
    await taskSubTypeCombobox(page).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(400);
    check("5. Re-loading shows the manual input still pre-filled with 70 before any change", (await page.locator("#manual-estimated-cost").inputValue()) === "70");
    await taskSubTypeCombobox(page).click();
    await page.getByRole("option", { name: `${TAG}-fixed` }).click();
    await page.waitForTimeout(200);
    check("6. The manual Estimated Cost input disappears", (await page.locator("#manual-estimated-cost").count()) === 0);
    check("7. A readonly configured-cost line appears (120.00 EUR)", (await page.getByText(/120\.00 EUR/).count()) > 0);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.waitForURL((url) => url.pathname === `/activities/${act1.id}`, { timeout: 10000 });
    act1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id } });
    check("8. Snapshot is now the configured cost (120), not the stale manual 70", Number(act1Row.taskSubTypeCost) === 120);

    console.log("\n=== 9. Editing an unrelated field (no Task Sub Type change) preserves the snapshot ===\n");
    await page.goto(`${BASE_URL}/activities/${act1.id}/edit`, { waitUntil: "load" });
    await page.locator("#title").waitFor({ state: "visible", timeout: 10000 });
    await page.fill("#title", `${TAG} Act1 renamed`);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.waitForURL((url) => url.pathname === `/activities/${act1.id}`, { timeout: 10000 });
    act1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id } });
    check("9. Snapshot is UNCHANGED (still 120) after an unrelated title edit", Number(act1Row.taskSubTypeCost) === 120);

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
