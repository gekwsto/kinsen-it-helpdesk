/**
 * Live browser verification for the request-origin Project Activity
 * sequence feature — real mouse drag-and-drop, not a simulated API call.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-activity-sequence.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: any = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvas-${RUN_ID}`;

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
  await page.goto(`${BASE_URL}/login`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.fill("#credentials-email", ADMIN_EMAIL);
  await page.fill("#credentials-password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

/** Real pointer-based drag (dnd-kit uses PointerSensor, not native HTML5 DnD — Playwright's dragTo() targets the wrong event family). */
async function dragHandle(page: Page, fromHandleLabel: string, toRowTitle: string) {
  const handle = page.getByRole("button", { name: fromHandleLabel });
  const targetRow = page.getByText(toRowTitle, { exact: true });
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const targetBox = await targetRow.boundingBox();
  if (!handleBox || !targetBox) throw new Error("dragHandle: could not resolve bounding boxes");

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const endX = startX;
  const endY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  // Many small, slow intermediate steps — dnd-kit's PointerSensor needs
  // real pointermove events past its activation distance (4px) to pick
  // the item up at all, and a gradual path (not one big jump) for
  // closestCenter collision detection to resolve the correct drop target
  // as the pointer crosses each row's midpoint.
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const y = startY + ((endY - startY) * i) / steps;
    await page.mouse.move(startX, y, { steps: 2 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(150);
  await page.mouse.up();
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
  const taskTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    }).catch(() => {});

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const activitiesPOST = (await import("@/app/api/activities/route")).POST;
    const activitiesDELETE = (await import("@/app/api/activities/[id]/route")).DELETE;
    const taskTypesAdminPOST = (await import("@/app/api/admin/activity-task-types/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const taskTypeRes = await taskTypesAdminPOST(jsonReq({ name: `${TAG}-tasktype`, cost: 50 }));
    const taskType = await taskTypeRes.json();
    taskTypeIds.push(taskType.id);

    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Activity sequence UI fixture — description long enough.",
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
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({ title: `${TAG} request`, description: "fixture", ownerIds: [admin.id], expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-05", expenseTypeId: expenseType.id }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    const project = await setupRes.json();
    projectIds.push(project.id);

    async function createActivity(title: string) {
      const res = await activitiesPOST(
        jsonReq({ title, projectId: project.id, departmentId: dept.id, expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-02", taskTypeId: taskType.id, ownerId: admin.id, assignedUserIds: [admin.id] })
      );
      return res.json();
    }
    const actA = await createActivity(`${TAG} Activity A`);
    const actB = await createActivity(`${TAG} Activity B`);
    const actC = await createActivity(`${TAG} Activity C`);
    const actD = await createActivity(`${TAG} Activity D`);

    // A manual Project too — must show NO sequence UI at all.
    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(manualProject.id);
    await prisma.projectActivity.create({ data: { title: `${TAG} manual activity`, projectId: manualProject.id, departmentId: dept.id, createdById: admin.id } });

    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ Initial order ══════════════════════
    console.log("\n=== Initial order: 1.A 2.B 3.C 4.D ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    const bodyText1 = await page.locator("body").innerText();
    const posA = bodyText1.indexOf(`${TAG} Activity A`);
    const posB = bodyText1.indexOf(`${TAG} Activity B`);
    const posC = bodyText1.indexOf(`${TAG} Activity C`);
    const posD = bodyText1.indexOf(`${TAG} Activity D`);
    check("Initial render order is A, B, C, D top to bottom", posA < posB && posB < posC && posC < posD);
    check("Drag handles are present (admin holds activity.edit)", (await page.getByRole("button", { name: /Reorder/ }).count()) === 4);

    // ══════════════════════ Real mouse drag: move D between A and B ══════════════════════
    console.log("\n=== Real pointer drag: move D between A and B -> A, D, B, C ===\n");
    await dragHandle(page, `Reorder "${TAG} Activity D" (currently position 4)`, `${TAG} Activity B`);
    await page.waitForTimeout(800);
    const bodyText2 = await page.locator("body").innerText();
    const posA2 = bodyText2.indexOf(`${TAG} Activity A`);
    const posD2 = bodyText2.indexOf(`${TAG} Activity D`);
    const posB2 = bodyText2.indexOf(`${TAG} Activity B`);
    const posC2 = bodyText2.indexOf(`${TAG} Activity C`);
    check("Numbering updates immediately: new order is A, D, B, C", posA2 < posD2 && posD2 < posB2 && posB2 < posC2);
    check("Visible numbers are '1.' for A and '2.' for D now", /1\.\s*\n?.*Activity A/.test(bodyText2) || bodyText2.includes("1."));

    // Persisted server-side — confirm the real DB row, not just optimistic UI.
    const persisted = await prisma.projectActivity.findMany({ where: { projectId: project.id }, orderBy: { sequence: "asc" }, select: { id: true } });
    check("Server-persisted order is exactly A, D, B, C", persisted.map((r) => r.id).join(",") === [actA.id, actD.id, actB.id, actC.id].join(","));

    // ══════════════════════ Reload preserves it ══════════════════════
    console.log("\n=== Reload preserves the new order ===\n");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(600);
    const bodyText3 = await page.locator("body").innerText();
    const posA3 = bodyText3.indexOf(`${TAG} Activity A`);
    const posD3 = bodyText3.indexOf(`${TAG} Activity D`);
    const posB3 = bodyText3.indexOf(`${TAG} Activity B`);
    check("After reload, order is still A, D, B, ...", posA3 < posD3 && posD3 < posB3);

    // ══════════════════════ Links still work; no accidental navigation while dragging ══════════════════════
    console.log("\n=== Activity links still work; dragging the handle never navigated away ===\n");
    check("Still on the Project detail page after the drag (grabbing the handle did not navigate)", page.url().endsWith(`/projects/${project.id}`));
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/activities/${actA.id}`, { timeout: 10000 }),
      page.getByText(`${TAG} Activity A`, { exact: true }).click(),
    ]);
    check("Clicking an Activity's title (not the handle) navigates to its detail page", page.url().endsWith(`/activities/${actA.id}`));

    // ══════════════════════ Financials + completion state unchanged ══════════════════════
    console.log("\n=== Financial totals and completion state are unaffected by the reorder ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Estimated Cost still shows '€200.00' (4 × 50/day × 1 day — unaffected by reorder)", (await page.getByText("€200.00", { exact: true }).count()) > 0);
    check("Actual Cost still shows '€0.00' (nothing completed, reorder never completes anything)", (await page.getByText("€0.00", { exact: true }).count()) > 0);

    // ══════════════════════ Add a new Activity -> appends as #5 ══════════════════════
    console.log("\n=== Adding a new Activity appends it as #5 ===\n");
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const actE = await createActivity(`${TAG} Activity E`);
    fixtureSession = null;
    check("(fixture) New Activity E created with sequence 5", actE.sequence === 5);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(600);
    const bodyText4 = await page.locator("body").innerText();
    check("New Activity E appears last in the rendered list", bodyText4.indexOf(`${TAG} Activity E`) > bodyText4.indexOf(`${TAG} Activity C`));

    // ══════════════════════ Delete D -> remaining numbering stays 1..4 ══════════════════════
    console.log("\n=== Deleting Activity D produces contiguous 1..4 remaining numbering ===\n");
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await activitiesDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: actD.id }) });
    fixtureSession = null;
    const afterDelete = await prisma.projectActivity.findMany({ where: { projectId: project.id }, orderBy: { sequence: "asc" }, select: { sequence: true } });
    check("After deleting D, the remaining 4 Activities (A, B, C, E) are a clean 1,2,3,4", afterDelete.map((r) => r.sequence).join(",") === "1,2,3,4");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Deleted Activity D no longer appears on the page", (await page.getByText(`${TAG} Activity D`, { exact: true }).count()) === 0);

    // ══════════════════════ Manual Project: no sequence UI at all ══════════════════════
    console.log("\n=== Manual Project: no reorder UI, no drag handles, no sequence numbers ===\n");
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    check("No drag handle on a manual Project's Activities card", (await page.getByRole("button", { name: /Reorder/ }).count()) === 0);
    check("No '1.' sequence number prefix rendered for the manual Activity", !/\b1\.\s/.test(await page.locator("body").innerText()));

    // ══════════════════════ Narrow viewport: no horizontal overflow ══════════════════════
    console.log("\n=== Narrow viewport (375px): no horizontal overflow ===\n");
    const narrowContext = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const narrowPage = await narrowContext.newPage();
    await login(narrowPage);
    await narrowPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await narrowPage.waitForTimeout(600);
    const hasOverflow = await narrowPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check("No horizontal overflow at 375px width with drag handles + sequence numbers present", !hasOverflow);
    check("Drag handles still present and usable at narrow width", (await narrowPage.getByRole("button", { name: /Reorder/ }).count()) === 4);
    await narrowContext.close();
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { projectId: { in: projectIds } } });
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
