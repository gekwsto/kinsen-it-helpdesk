/**
 * Live browser verification for:
 *   1. The new "Project completed" notification (appears in the bell,
 *      clicking it navigates to the Project detail page).
 *   2. The new "clear notifications" feature — per-row dismiss (x) and
 *      "Clear all".
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-notification-clear-ui.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const REQUESTER_EMAIL = "user@kinsen.gr";
const REQUESTER_PASSWORD = process.env.DEMO_USER_PASSWORD || "User@123456";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvncl-${RUN_ID}`;

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
  const projectIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    const requester = await prisma.user.findFirstOrThrow({ where: { email: REQUESTER_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Notification UI fixture — description long enough.",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
        departmentId: dept.id,
      })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({ title: `${TAG} request`, description: "fixture", ownerIds: [admin.id], expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-05", expenseTypeId: expenseType.id }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    const project = await setupRes.json();
    projectIds.push(project.id);
    fixtureSession = null;

    // A spare, harmless notification for the requester (clear-all target).
    await prisma.notification.create({ data: { userId: requester.id, title: `${TAG} spare notification`, body: "Just a spare one.", link: null } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page, REQUESTER_EMAIL, REQUESTER_PASSWORD);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const bellButton = page.locator("header button", { has: page.locator("svg") }).filter({ hasText: "" }).first();

    console.log("\n=== 1. No completion notification yet (Project not completed) ===\n");
    await page.getByRole("button").filter({ has: page.locator("svg.lucide-bell, svg.lucide-bell-off") }).first().click();
    await page.waitForTimeout(400);
    check("1. No 'Project completed' notification before completion", (await page.getByText("Project completed", { exact: true }).count()) === 0);
    await page.keyboard.press("Escape");

    console.log("\n=== 2. Complete the Project (admin), then the requester sees the notification ===\n");
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
    await projectsPATCH(jsonReq({ status: "COMPLETED" }), { params: Promise.resolve({ id: project.id }) });
    fixtureSession = null;

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(600);
    await page.getByRole("button").filter({ has: page.locator("svg.lucide-bell, svg.lucide-bell-off") }).first().click();
    await page.waitForTimeout(400);
    check("2. 'Project completed' notification now appears in the bell dropdown", (await page.getByText("Project completed", { exact: true }).count()) === 1);

    console.log("\n=== 3. Clicking it navigates to the Project detail page ===\n");
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${project.id}`, { timeout: 10000 }),
      page.getByText("Project completed", { exact: true }).click(),
    ]);
    check("3. Clicking the notification navigated to /projects/[id]", page.url().endsWith(`/projects/${project.id}`));

    console.log("\n=== 4. Per-row dismiss (x) removes just that one notification ===\n");
    await page.getByRole("button").filter({ has: page.locator("svg.lucide-bell, svg.lucide-bell-off") }).first().click();
    await page.waitForTimeout(400);
    const spareRow = page.locator("text=" + `${TAG} spare notification`).locator("../..");
    await spareRow.hover();
    await spareRow.getByRole("button", { name: "Dismiss notification" }).click();
    await page.waitForTimeout(400);
    check("4. The dismissed spare notification is gone from the list", (await page.getByText(`${TAG} spare notification`, { exact: true }).count()) === 0);
    check("...while the 'Project completed' one (not dismissed) still remains", (await page.getByText("Project completed", { exact: true }).count()) === 1);

    console.log("\n=== 5. 'Clear all' empties the whole list ===\n");
    await page.getByRole("button", { name: /clear all/i }).click();
    await page.waitForTimeout(400);
    check("5. After 'Clear all', the list shows 'No notifications yet'", (await page.getByText("No notifications yet", { exact: true }).count()) === 1);

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(500);
    await page.getByRole("button").filter({ has: page.locator("svg.lucide-bell, svg.lucide-bell-off") }).first().click();
    await page.waitForTimeout(400);
    check("...and reloading confirms it was really persisted server-side, not just a local/optimistic clear", (await page.getByText("No notifications yet", { exact: true }).count()) === 1);
  } finally {
    await browser.close();
    try {
      await prisma.notification.deleteMany({ where: { userId: (await prisma.user.findFirstOrThrow({ where: { email: REQUESTER_EMAIL }, select: { id: true } })).id, title: { contains: TAG } } });
      await prisma.notification.deleteMany({ where: { link: `/projects/${projectIds[0]}` } });
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
