/**
 * Live browser verification for the Project/Activity quick-status dropdown
 * (components/status/quick-status-select.tsx,
 * components/projects/project-quick-status.tsx,
 * components/projects/project-detail-header.tsx,
 * components/activities/activity-quick-status.tsx).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-quick-status.ts
 */
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, ActivityStatus, ProjectStatus } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvqs-${RUN_ID}`;

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

  const departmentIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const deptOther = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    departmentIds.push(deptOther.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN }, select: { id: true } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // ══════════════════════ FLOW 1 — Project status ══════════════════════
    console.log("\n=== FLOW 1: Project quick status ===\n");
    const project = await prisma.project.create({
      data: { title: `${TAG} Project`, departmentId: dept.id, ownerId: admin.id, status: ProjectStatus.PLANNING },
    });
    projectIds.push(project.id);

    await page.goto(`${BASE_URL}/projects/${project.id}`);
    await page.waitForSelector("text=PLANNING", { timeout: 10000 });
    check("Project detail confirms current status (PLANNING)", (await page.locator("text=PLANNING").count()) > 0);

    const projectStatusTrigger = page.getByRole("button", { name: "Change project status" });
    await projectStatusTrigger.waitFor({ state: "visible" });
    check("Quick-status trigger shows the current status label", (await projectStatusTrigger.textContent())?.includes("PLANNING") ?? false);
    await projectStatusTrigger.click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    check("Dropdown offers 'ON HOLD' (a valid ProjectStatus)", (await page.locator('[role="menuitem"]:has-text("ON HOLD")').count()) > 0);

    await page.locator('[role="menuitem"]:has-text("ON HOLD")').click();
    await page.waitForSelector('button[aria-label="Change project status"]:has-text("ON HOLD")', { timeout: 10000 });
    check("Status badge in the header updated to ON HOLD immediately (no reload)", (await page.locator("h1").locator("xpath=following-sibling::span[1]").textContent())?.trim() === "ON HOLD");

    await page.reload();
    await page.waitForSelector('button[aria-label="Change project status"]:has-text("ON HOLD")', { timeout: 10000 });
    check("Reload confirms the status was persisted", true);

    await page.goto(`${BASE_URL}/projects/${project.id}/edit`);
    await page.waitForSelector("text=Edit Project", { timeout: 10000 }).catch(() => {});
    const editStatusTrigger = page.locator('button[role="combobox"]').filter({ hasText: "ON HOLD" });
    check("Edit Project form shows the SAME new status (ON HOLD)", (await editStatusTrigger.count()) > 0);

    // ══════════════════════ FLOW 2 — Activity regular transition ══════════════════════
    console.log("\n=== FLOW 2: Activity regular status transition ===\n");
    const activity = await prisma.projectActivity.create({
      data: { title: `${TAG} Activity`, departmentId: dept.id, status: ActivityStatus.TODO },
    });
    activityIds.push(activity.id);
    const inProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.IN_PROGRESS } } });

    await page.goto(`${BASE_URL}/activities/${activity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    check("'Mark Complete' button no longer exists on Activity detail", (await page.getByRole("button", { name: "Mark Complete" }).count()) === 0);

    const activityStatusTrigger = page.getByRole("button", { name: "Change activity status" });
    await activityStatusTrigger.click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^In Progress$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check(`Progress updated to the configured percentage for In Progress (${inProgressConfig.progressPercent}%)`, (await page.locator(`text=${inProgressConfig.progressPercent}%`).count()) > 0);

    await page.reload();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check("Reload confirms the Activity status was persisted", true);

    // ══════════════════════ FLOW 3 — Activity completion ══════════════════════
    console.log("\n=== FLOW 3: Activity completion via quick status ===\n");
    const completionProject = await prisma.project.create({ data: { title: `${TAG} Completion Project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(completionProject.id);
    const completionActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Completion Activity`, departmentId: dept.id, projectId: completionProject.id, status: ActivityStatus.TODO },
    });
    activityIds.push(completionActivity.id);

    await page.goto(`${BASE_URL}/activities/${completionActivity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^Completed$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("Completed")', { timeout: 10000 });
    check("Activity reached 100% progress on completion", (await page.locator("text=100%").count()) > 0);

    await page.goto(`${BASE_URL}/projects/${completionProject.id}`);
    await page.waitForSelector("text=100%", { timeout: 10000 });
    check("Parent Project rollup shows 100% (its only activity is now Completed)", (await page.locator("text=100%").count()) > 0);

    await page.reload();
    await page.waitForSelector("text=100%", { timeout: 10000 });
    const completedActivityInDb = await prisma.projectActivity.findUnique({ where: { id: completionActivity.id }, select: { isCompleted: true, completedAt: true } });
    check("DB: isCompleted true and completedAt stamped", completedActivityInDb?.isCompleted === true && !!completedActivityInDb.completedAt);

    // ══════════════════════ FLOW 4 — Activity reopen ══════════════════════
    console.log("\n=== FLOW 4: Activity reopen (Completed -> another status) ===\n");
    await page.goto(`${BASE_URL}/activities/${completionActivity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("Completed")', { timeout: 10000 });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^To Do$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("To Do")', { timeout: 10000 });
    const todoConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.TODO } } });
    check(`Progress recalculated for To Do (${todoConfig.progressPercent}%)`, (await page.locator(`text=${todoConfig.progressPercent}%`).count()) > 0);

    await page.goto(`${BASE_URL}/projects/${completionProject.id}`);
    await page.waitForSelector(`text=${todoConfig.progressPercent}%`, { timeout: 10000 });
    check("Parent Project rollup recalculated after reopening", (await page.locator(`text=${todoConfig.progressPercent}%`).count()) > 0);

    // ══════════════════════ FLOW 5 — Permissions ══════════════════════
    console.log("\n=== FLOW 5: Permissions (real non-admin browser session) ===\n");
    const limitedPassword = `${TAG}-pw!`;
    const limitedPasswordHash = await bcrypt.hash(limitedPassword, 10);
    const limitedUser = await prisma.user.create({
      data: { email: `${TAG}-viewer@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: limitedPasswordHash, isActive: true },
      select: { id: true },
    });
    userIds.push(limitedUser.id);
    const limitedMembership = await prisma.departmentMembership.create({
      data: { userId: limitedUser.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(limitedMembership.id);

    const limitedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const limitedPage = await limitedContext.newPage();
    await login(limitedPage, `${TAG}-viewer@kinsen.gr`, limitedPassword);

    await limitedPage.goto(`${BASE_URL}/projects/${project.id}`);
    await limitedPage.waitForSelector('button[aria-label="Change project status"]', { timeout: 10000 });
    check("project.view-only user: quick-status trigger is disabled", !(await limitedPage.getByRole("button", { name: "Change project status" }).isEnabled()));
    const directProjectPatch = await limitedPage.request.fetch(`${BASE_URL}/api/projects/${project.id}`, { method: "PATCH", data: { status: ProjectStatus.CANCELLED } });
    check("Direct PATCH /api/projects/[id] status change from this user is rejected", !directProjectPatch.ok());

    await limitedPage.goto(`${BASE_URL}/activities/${activity.id}`);
    await limitedPage.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    check("activity.view-only user: quick-status trigger is disabled", !(await limitedPage.getByRole("button", { name: "Change activity status" }).isEnabled()));
    const directActivityPatch = await limitedPage.request.fetch(`${BASE_URL}/api/activities/${activity.id}`, { method: "PATCH", data: { status: ActivityStatus.CANCELLED, isCompleted: false } });
    check("Direct PATCH /api/activities/[id] status change from this user is rejected", !directActivityPatch.ok());
    await limitedContext.close();

    // ══════════════════════ FLOW 6 — Department-specific statuses ══════════════════════
    console.log("\n=== FLOW 6: Department-specific status sets don't leak ===\n");
    await prisma.activityStatusConfig.update({ where: { departmentId_status: { departmentId: deptOther.id, status: ActivityStatus.BLOCKED } }, data: { isEnabled: false } });
    const otherActivity = await prisma.projectActivity.create({ data: { title: `${TAG} Other Dept Activity`, departmentId: deptOther.id, status: ActivityStatus.TODO } });
    activityIds.push(otherActivity.id);

    await page.goto(`${BASE_URL}/activities/${otherActivity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    check("Department-with-BLOCKED-disabled's dropdown does NOT offer Blocked", (await page.locator('[role="menuitem"]:has-text("Blocked")').count()) === 0);
    await page.keyboard.press("Escape");

    await page.goto(`${BASE_URL}/activities/${activity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    check("The FIRST department (BLOCKED never touched there) still offers Blocked", (await page.locator('[role="menuitem"]:has-text("Blocked")').count()) > 0);

    await context.close();
  } finally {
    await browser.close();
    try {
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
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
