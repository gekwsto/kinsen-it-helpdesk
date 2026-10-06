/**
 * Real interactive browser verification of the three new/normalized
 * `.manage` permissions: projectRequestType.manage, projectExpenseType.manage,
 * taskType.manage (pre-existing, unchanged — regression guard).
 *
 * Creates three real, independently-permissioned GLOBAL custom roles and
 * logs in as a real credentials user holding each one, then drives the
 * actual running dev app: sidebar visibility, create/edit/delete through
 * the real admin UI, sibling resources correctly hidden/denied, and direct
 * unauthorized URL/API access denied.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-reference-data-manage-permissions.ts
 * Requires a reachable DATABASE_URL and a running dev server — skips if
 * either is unavailable.
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, AuthProvider } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const TAG = `bvrdmp-${RUN_ID}`;

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

async function expandAdministration(page: Page) {
  // The "Administration" sidebar section is collapsed by default
  // (expandedItems only seeds "Tickets") — its children are removed from
  // the DOM entirely while collapsed, not just hidden, so they must be
  // expanded before any visibility/text check or click against them.
  await page.click('button:has-text("Administration")').catch(() => {});
  await page.waitForTimeout(300);
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector("#credentials-email", { state: "visible" });
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
  await page.waitForTimeout(800);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const userIds: string[] = [];
  const reqTypeIds: string[] = [];
  const expTypeIds: string[] = [];
  const taskTypeIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures: 3 GLOBAL custom roles, each with exactly one .manage permission ===\n");
    const reqTypePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequestType.manage" } });
    const expTypePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectExpenseType.manage" } });
    const taskTypePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "taskType.manage" } });

    const roleReq = await prisma.customRole.create({ data: { key: `${TAG}-REQ`, name: `${TAG} ReqType Only`, scope: RoleScope.GLOBAL, isBuiltIn: false } });
    const roleExp = await prisma.customRole.create({ data: { key: `${TAG}-EXP`, name: `${TAG} ExpType Only`, scope: RoleScope.GLOBAL, isBuiltIn: false } });
    const roleTask = await prisma.customRole.create({ data: { key: `${TAG}-TASK`, name: `${TAG} TaskType Only`, scope: RoleScope.GLOBAL, isBuiltIn: false } });
    customRoleIds.push(roleReq.id, roleExp.id, roleTask.id);
    customRoleKeys.push(roleReq.key, roleExp.key, roleTask.key);

    await prisma.rolePermission.create({ data: { roleKey: roleReq.key, permissionId: reqTypePerm.id } });
    await prisma.rolePermission.create({ data: { roleKey: roleExp.key, permissionId: expTypePerm.id } });
    await prisma.rolePermission.create({ data: { roleKey: roleTask.key, permissionId: taskTypePerm.id } });

    const password = `${TAG}-pw!`;
    const passwordHash = await bcrypt.hash(password, 10);
    const userReq = await prisma.user.create({ data: { email: `${TAG}-req@kinsen.gr`, role: Role.USER, customRoleId: roleReq.id, authProvider: AuthProvider.CREDENTIALS, passwordHash, isActive: true } });
    const userExp = await prisma.user.create({ data: { email: `${TAG}-exp@kinsen.gr`, role: Role.USER, customRoleId: roleExp.id, authProvider: AuthProvider.CREDENTIALS, passwordHash, isActive: true } });
    const userTask = await prisma.user.create({ data: { email: `${TAG}-task@kinsen.gr`, role: Role.USER, customRoleId: roleTask.id, authProvider: AuthProvider.CREDENTIALS, passwordHash, isActive: true } });
    userIds.push(userReq.id, userExp.id, userTask.id);

    // ══════════════ Role 1: projectRequestType.manage only ══════════════
    console.log("\n=== Role: projectRequestType.manage only ===\n");
    const ctxReq = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageReq = await ctxReq.newPage();
    attachCapture(pageReq, consoleErrors);
    await login(pageReq, userReq.email, password);
    await expandAdministration(pageReq);

    const bodyAfterLoginReq = await pageReq.locator("body").innerText();
    check("Project Request Types nav link visible", bodyAfterLoginReq.includes("Project Request Types"));
    check("Project Expense Types nav link NOT visible", !bodyAfterLoginReq.includes("Project Expense Types"));
    check("Task Types nav link NOT visible", !/\bTask Types\b/.test(bodyAfterLoginReq));

    await pageReq.click('a[href="/admin/project-request-types"]');
    await pageReq.waitForSelector("text=Project Request Types", { timeout: 10000 });
    await pageReq.waitForTimeout(400);
    check("Navigated to Project Request Types admin page", pageReq.url().includes("/admin/project-request-types"));

    const newTypeName = `${TAG} ReqType`;
    await pageReq.click('button:has-text("Add Type")');
    await pageReq.waitForSelector('[role="dialog"] >> text=Add Project Request Type', { timeout: 5000 });
    await pageReq.fill('[role="dialog"] input[placeholder="e.g. New Product"]', newTypeName);
    await pageReq.click('[role="dialog"] button:has-text("Create Type")');
    await pageReq.waitForSelector('[role="dialog"] >> text=Add Project Request Type', { state: "hidden", timeout: 5000 });
    await pageReq.waitForTimeout(400);
    const bodyAfterCreate = await pageReq.locator("body").innerText();
    check("Can create a Project Request Type through the real UI", bodyAfterCreate.includes(newTypeName));
    const createdType = await prisma.projectRequestType.findUnique({ where: { name: newTypeName } });
    if (createdType) reqTypeIds.push(createdType.id);

    if (createdType) {
      await pageReq.click(`button[aria-label="Edit ${newTypeName}"]`);
      await pageReq.waitForSelector('[role="dialog"] >> text=Edit Project Request Type', { timeout: 5000 });
      const renameInput = pageReq.locator('[role="dialog"] input').first();
      await renameInput.fill(`${newTypeName} Edited`);
      await pageReq.click('[role="dialog"] button:has-text("Save Changes")');
      await pageReq.waitForSelector('[role="dialog"] >> text=Edit Project Request Type', { state: "hidden", timeout: 5000 });
      await pageReq.waitForTimeout(400);
      const edited = await prisma.projectRequestType.findUnique({ where: { id: createdType.id } });
      check("Can edit through the real UI", edited?.name === `${newTypeName} Edited`);

      await pageReq.click(`button[aria-label="Delete ${newTypeName} Edited"]`);
      await pageReq.waitForSelector('[role="dialog"] >> text=Delete Project Request Type', { timeout: 5000 });
      await pageReq.click('[role="dialog"] button:has-text("Delete")');
      await pageReq.waitForSelector('[role="dialog"] >> text=Delete Project Request Type', { state: "hidden", timeout: 5000 });
      await pageReq.waitForTimeout(400);
      const deleted = await prisma.projectRequestType.findUnique({ where: { id: createdType.id } });
      check("Can delete the unused type through the real UI", deleted === null);
      if (deleted) reqTypeIds.pop();
    }

    console.log("\n--- Direct unauthorized access attempts (projectRequestType.manage holder) ---\n");
    await pageReq.goto(`${BASE_URL}/admin/project-expense-types`);
    await pageReq.waitForTimeout(600);
    check("Direct navigation to Project Expense Types admin page is denied (redirected away)", !pageReq.url().includes("/admin/project-expense-types"));
    await pageReq.goto(`${BASE_URL}/admin/activity-task-types`);
    await pageReq.waitForTimeout(600);
    check("Direct navigation to Task Types admin page is denied (redirected away)", !pageReq.url().includes("/admin/activity-task-types"));

    const unauthorizedExpPost = await pageReq.request.post(`${BASE_URL}/api/admin/project-expense-types`, { data: { name: `${TAG} Denied` } });
    check("Direct API POST to Project Expense Types is rejected (403)", unauthorizedExpPost.status() === 403);
    const unauthorizedTaskPost = await pageReq.request.post(`${BASE_URL}/api/admin/activity-task-types`, { data: { name: `${TAG} Denied`, cost: 1 } });
    check("Direct API POST to Task Types is rejected (403)", unauthorizedTaskPost.status() === 403);

    await ctxReq.close();

    // ══════════════ Role 2: projectExpenseType.manage only ══════════════
    console.log("\n=== Role: projectExpenseType.manage only ===\n");
    const ctxExp = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageExp = await ctxExp.newPage();
    attachCapture(pageExp, consoleErrors);
    await login(pageExp, userExp.email, password);
    await expandAdministration(pageExp);

    const bodyAfterLoginExp = await pageExp.locator("body").innerText();
    check("Project Expense Types nav link visible", bodyAfterLoginExp.includes("Project Expense Types"));
    check("Project Request Types nav link NOT visible", !bodyAfterLoginExp.includes("Project Request Types"));
    check("Task Types nav link NOT visible", !/\bTask Types\b/.test(bodyAfterLoginExp));

    await pageExp.goto(`${BASE_URL}/admin/project-expense-types`);
    await pageExp.waitForSelector("text=Project Expense Types", { timeout: 10000 });
    await pageExp.waitForTimeout(400);
    check("Can reach Project Expense Types admin page directly", pageExp.url().includes("/admin/project-expense-types"));

    const newExpName = `${TAG} ExpType`;
    await pageExp.click('button:has-text("Add Type")');
    await pageExp.waitForSelector('[role="dialog"] >> text=Add Project Expense Type', { timeout: 5000 });
    await pageExp.fill('[role="dialog"] input[placeholder="e.g. CapEx"]', newExpName);
    await pageExp.click('[role="dialog"] button:has-text("Create Type")');
    await pageExp.waitForSelector('[role="dialog"] >> text=Add Project Expense Type', { state: "hidden", timeout: 5000 });
    await pageExp.waitForTimeout(400);
    const createdExp = await prisma.projectExpenseType.findUnique({ where: { name: newExpName } });
    check("Can create a Project Expense Type through the real UI", !!createdExp);

    if (createdExp) {
      expTypeIds.push(createdExp.id);
      await pageExp.click(`button[aria-label="Edit ${newExpName}"]`);
      await pageExp.waitForSelector('[role="dialog"] >> text=Edit Project Expense Type', { timeout: 5000 });
      await pageExp.locator('[role="dialog"] input').first().fill(`${newExpName} Edited`);
      await pageExp.click('[role="dialog"] button:has-text("Save Changes")');
      await pageExp.waitForSelector('[role="dialog"] >> text=Edit Project Expense Type', { state: "hidden", timeout: 5000 });
      await pageExp.waitForTimeout(400);
      const editedExp = await prisma.projectExpenseType.findUnique({ where: { id: createdExp.id } });
      check("Can edit through the real UI", editedExp?.name === `${newExpName} Edited`);

      // Activate/deactivate — click the Active/Inactive status toggle.
      await pageExp.click(`text=${newExpName} Edited >> xpath=ancestor::tr >> button:has-text("Active")`).catch(() => {});
      await pageExp.waitForTimeout(600);
      const afterToggle = await prisma.projectExpenseType.findUnique({ where: { id: createdExp.id } });
      check("Can deactivate through the real UI", afterToggle?.isActive === false);

      await pageExp.click(`button[aria-label="Delete ${newExpName} Edited"]`);
      await pageExp.waitForSelector('[role="dialog"] >> text=Delete Project Expense Type', { timeout: 5000 });
      await pageExp.click('[role="dialog"] button:has-text("Delete")');
      await pageExp.waitForSelector('[role="dialog"] >> text=Delete Project Expense Type', { state: "hidden", timeout: 5000 });
      await pageExp.waitForTimeout(400);
      const deletedExp = await prisma.projectExpenseType.findUnique({ where: { id: createdExp.id } });
      check("Can delete the unused type through the real UI", deletedExp === null);
      if (deletedExp) expTypeIds.pop();
    }

    const unauthorizedReqPost2 = await pageExp.request.post(`${BASE_URL}/api/admin/project-request-types`, { data: { name: `${TAG} Denied2` } });
    check("projectExpenseType.manage holder: direct API POST to Project Request Types is rejected (403)", unauthorizedReqPost2.status() === 403);

    await ctxExp.close();

    // ══════════════ Role 3: taskType.manage only ══════════════
    console.log("\n=== Role: taskType.manage only (pre-existing permission — regression guard) ===\n");
    const ctxTask = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageTask = await ctxTask.newPage();
    attachCapture(pageTask, consoleErrors);
    await login(pageTask, userTask.email, password);
    await expandAdministration(pageTask);

    const bodyAfterLoginTask = await pageTask.locator("body").innerText();
    check("Task Types nav link visible", /\bTask Types\b/.test(bodyAfterLoginTask));
    check("Project Request Types nav link NOT visible", !bodyAfterLoginTask.includes("Project Request Types"));
    check("Project Expense Types nav link NOT visible", !bodyAfterLoginTask.includes("Project Expense Types"));

    await pageTask.goto(`${BASE_URL}/admin/activity-task-types`);
    await pageTask.waitForSelector("text=Task Types", { timeout: 10000 });
    await pageTask.waitForTimeout(400);
    check("Can reach Task Types admin page directly", pageTask.url().includes("/admin/activity-task-types"));

    const newTaskName = `${TAG} TaskType`;
    await pageTask.click('button:has-text("Add Task Type")');
    await pageTask.waitForSelector('[role="dialog"] >> text=Add Task Type', { timeout: 5000 });
    await pageTask.fill('[role="dialog"] input[placeholder="e.g. Development"]', newTaskName);
    await pageTask.fill('[role="dialog"] input[placeholder="0.00"]', "123");
    await pageTask.click('[role="dialog"] button:has-text("Create Task Type")');
    await pageTask.waitForSelector('[role="dialog"] >> text=Add Task Type', { state: "hidden", timeout: 5000 });
    await pageTask.waitForTimeout(400);
    const createdTask = await prisma.activityTaskType.findUnique({ where: { name: newTaskName } });
    check("Can create a Task Type through the real UI", !!createdTask && Number(createdTask.cost) === 123);

    if (createdTask) {
      taskTypeIds.push(createdTask.id);
      await pageTask.click(`button[aria-label="Delete ${newTaskName}"]`);
      await pageTask.waitForSelector('[role="dialog"] >> text=Delete Task Type', { timeout: 5000 });
      await pageTask.click('[role="dialog"] button:has-text("Delete")');
      await pageTask.waitForSelector('[role="dialog"] >> text=Delete Task Type', { state: "hidden", timeout: 5000 });
      await pageTask.waitForTimeout(400);
      const deletedTask = await prisma.activityTaskType.findUnique({ where: { id: createdTask.id } });
      check("Can delete the unused Task Type through the real UI", deletedTask === null);
      if (deletedTask) taskTypeIds.pop();
    }

    await ctxTask.close();

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed across all three sessions", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.activityTaskType.deleteMany({ where: { id: { in: taskTypeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { id: { in: expTypeIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: reqTypeIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
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
