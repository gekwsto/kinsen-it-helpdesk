/**
 * Live browser verification for the non-blocking same-day-start warning on
 * the request-origin Project's own Activities card
 * (components/projects/project-activity-sequence-card.tsx), driven by
 * lib/activities/activity-conflict.ts:
 *   - Two active Activities in the same Project, same Expected Start -> both warn.
 *   - Completing one -> neither warns (only one active remains).
 *   - A third same-day active Activity -> the two active ones warn, the
 *     completed one never does.
 *   - A different Project, same date -> no cross-project conflict.
 *   - Reopening recalculates the warning back on, live, with no page reload.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-same-day-start-warning.ts
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
const TAG = `bvsds-${RUN_ID}`;

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

function activityRow(page: Page, title: string) {
  // The per-row container carries "rounded-lg border" too (see
  // SequencedActivityRowItem's own className), same as the outer <Card>
  // around the whole list — but the Card's opening tag comes FIRST in
  // document order, so .last() picks the innermost (most specific) match:
  // this one row alone, not the whole list.
  return page.locator(`div.rounded-lg.border:has-text("${title}")`).last();
}

async function hasWarning(page: Page, title: string): Promise<boolean> {
  return (await activityRow(page, title).getByText("Same-day start").count()) > 0;
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
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });
    const taskSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-subtype`, cost: 50 } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const activitiesPOST = (await import("@/app/api/activities/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    async function makeRequestOriginProject(title: string) {
      fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
      const submitRes = await requestsPOST(
        jsonReq({
          title,
          description: "Same-day-start warning UI fixture — description long enough for validation.",
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
        jsonReq({ title, description: "fixture", ownerIds: [admin.id], expectedStartDate: "2026-09-01", expectedFinishDate: "2026-09-08", expenseTypeId: expenseType.id }),
        { params: Promise.resolve({ id: submitted.id }) }
      );
      if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
      const project = await setupRes.json();
      projectIds.push(project.id);
      return project;
    }

    async function makeActivity(projectId: string, title: string, expectedStartDate: string) {
      const res = await activitiesPOST(
        jsonReq({
          title,
          projectId,
          departmentId: dept.id,
          expectedStartDate,
          expectedFinishDate: "2026-10-20",
          taskTypeId: reqType.id,
          taskSubTypeId: taskSubType.id,
          ownerId: admin.id,
          assignedUserIds: [admin.id],
        })
      );
      if (res.status !== 201) throw new Error(`Fixture Activity create failed: ${res.status}: ${JSON.stringify(await res.json())}`);
      const activity = await res.json();
      activityIds.push(activity.id);
      return activity;
    }

    const projectOne = await makeRequestOriginProject(`${TAG} Project One`);
    const projectTwo = await makeRequestOriginProject(`${TAG} Project Two`);

    const actA = await makeActivity(projectOne.id, `${TAG} Act A`, "2026-10-10");
    const actB = await makeActivity(projectOne.id, `${TAG} Act B`, "2026-10-10");
    const actOther = await makeActivity(projectOne.id, `${TAG} Act Other Day`, "2026-10-15");
    // Different PROJECT, same date as A/B — must never participate in their
    // conflict set (see "Do not compare Activities from different
    // Projects").
    const actCrossProject = await makeActivity(projectTwo.id, `${TAG} Act CrossProject`, "2026-10-10");
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await login(page);

    console.log("\n=== 1-2. Two active Activities, same Project, same Expected Start -> both warn ===\n");
    await page.goto(`${BASE_URL}/projects/${projectOne.id}`, { waitUntil: "load" });
    await activityRow(page, `${TAG} Act A`).waitFor({ state: "visible", timeout: 10000 });
    check("1. Activity A shows the Same-day start warning", await hasWarning(page, `${TAG} Act A`));
    check("2. Activity B shows the Same-day start warning too", await hasWarning(page, `${TAG} Act B`));
    check("...and the unrelated different-day Activity does NOT", !(await hasWarning(page, `${TAG} Act Other Day`)));

    console.log("\n=== 3. A different Project, same date -> no cross-project conflict ===\n");
    await page.goto(`${BASE_URL}/projects/${projectTwo.id}`, { waitUntil: "load" });
    await activityRow(page, `${TAG} Act CrossProject`).waitFor({ state: "visible", timeout: 10000 });
    check("3. The lone Activity in Project Two (same date as A/B, but a DIFFERENT Project) shows no warning", !(await hasWarning(page, `${TAG} Act CrossProject`)));

    console.log("\n=== 4. Tooltip text for exactly one other conflicting Activity ===\n");
    await page.goto(`${BASE_URL}/projects/${projectOne.id}`, { waitUntil: "load" });
    await activityRow(page, `${TAG} Act A`).waitFor({ state: "visible", timeout: 10000 });
    await activityRow(page, `${TAG} Act A`).getByText("Same-day start").hover();
    await page.waitForTimeout(400);
    check("4. Tooltip reads the singular form for exactly 1 other active conflict", (await page.getByText("Another active activity in this project starts on the same day.").count()) > 0);

    console.log("\n=== 5-6. Completing A (via the checkbox, no page reload) -> neither A nor B warns ===\n");
    await activityRow(page, `${TAG} Act A`).locator('input[type="checkbox"]').click();
    await activityRow(page, `${TAG} Act A`).getByText("Completed", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    check("5. Completed Activity A shows no warning", !(await hasWarning(page, `${TAG} Act A`)));
    check("6. Activity B, now the only active Activity left on that day, ALSO shows no warning anymore — live, no reload", !(await hasWarning(page, `${TAG} Act B`)));

    console.log("\n=== 7-9. A third active same-day Activity (reusing the same date) -> B + C warn, completed A still doesn't ===\n");
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const actC = await makeActivity(projectOne.id, `${TAG} Act C`, "2026-10-10");
    fixtureSession = null;
    await page.reload({ waitUntil: "load" });
    await activityRow(page, `${TAG} Act C`).waitFor({ state: "visible", timeout: 10000 });
    check("7. Activity B now warns again (new active sibling C on the same day)", await hasWarning(page, `${TAG} Act B`));
    check("8. Activity C warns too", await hasWarning(page, `${TAG} Act C`));
    check("9. Completed Activity A still never warns", !(await hasWarning(page, `${TAG} Act A`)));

    console.log("\n=== 10. Reopening A (un-completing) brings its own warning back live ===\n");
    await activityRow(page, `${TAG} Act A`).locator('input[type="checkbox"]').click();
    await activityRow(page, `${TAG} Act A`).getByText("Same-day start").waitFor({ state: "visible", timeout: 10000 });
    check("10. Reopened Activity A shows the warning again, live, no reload", await hasWarning(page, `${TAG} Act A`));

    console.log("\n=== No create/edit blocking regression guard ===\n");
    await page.goto(`${BASE_URL}/activities/new?projectId=${projectOne.id}`, { waitUntil: "load" });
    await page.fill("#title", `${TAG} Act D unaffected`);
    await page.fill("#expected-start", "2026-10-10");
    await page.fill("#expected-finish", "2026-10-12");
    await page.locator("#task-type").click();
    await page.getByRole("option", { name: `${TAG}-reqtype` }).click();
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: `${TAG}-subtype` }).click();
    await page.locator("#owner").click();
    await page.getByRole("option", { name: "System Administrator" }).first().click();
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByRole("button", { name: /create activity/i }).click();
    await page.waitForURL((url) => /\/activities\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith("/activities/new"), { timeout: 10000 });
    const actD_Id = page.url().split("/").pop()!;
    activityIds.push(actD_Id);
    check("11. Creating ANOTHER same-day Activity is never blocked — the warning is purely informational", true);
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.taskSubType.deleteMany({ where: { name: `${TAG}-subtype` } });
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
