/**
 * Live browser verification for the standalone-Activity Quick Status
 * regression fix (components/status/quick-status-select.tsx,
 * components/activities/activity-quick-status.tsx,
 * app/(main)/activities/[id]/activity-detail-client.tsx).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-standalone-activity-quick-status.ts
 */
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, ActivityStatus } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvsaq-${RUN_ID}`;

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
  const activityIds: string[] = [];
  const projectIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // ══════════════════════ FLOW 1 — Standalone Activity, regular transition ══════════════════════
    console.log("\n=== FLOW 1: Standalone Activity quick status ===\n");
    const standalone = await prisma.projectActivity.create({
      data: { title: `${TAG} Standalone Activity`, departmentId: dept.id, status: ActivityStatus.TODO, projectId: null },
    });
    activityIds.push(standalone.id);

    await page.goto(`${BASE_URL}/activities/${standalone.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    check("Project field confirms Standalone", (await page.locator("text=Standalone").count()) > 0);

    const badgeText = (await page.locator(".rounded-full").filter({ hasText: "To Do" }).first().textContent().catch(() => null))?.trim();
    const triggerText = (await page.getByRole("button", { name: "Change activity status" }).textContent())?.trim();
    check("Status badge shows 'To Do'", badgeText === "To Do", `got ${badgeText}`);
    check("Quick Status trigger shows the SAME 'To Do' (not a raw enum key like TODO)", triggerText?.includes("To Do") ?? false, `got ${triggerText}`);
    check("Trigger text is NOT the raw enum key", triggerText !== "TODO");

    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    const menuItems = await page.locator('[role="menuitem"]').allTextContents();
    check("Dropdown offers all 6 configured statuses for this Department (not empty)", menuItems.length === 6, JSON.stringify(menuItems));
    check("Dropdown includes 'In Progress'", menuItems.some((t) => t.includes("In Progress")));

    const inProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.IN_PROGRESS } } });
    await page.locator('[role="menuitem"]').filter({ hasText: /^In Progress$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check("Trigger updated to In Progress", true);
    check("Badge also updated to In Progress (single source of truth)", (await page.locator(".rounded-full").filter({ hasText: "In Progress" }).count()) > 0);
    check(`Progress updated to ${inProgressConfig.progressPercent}%`, (await page.locator(`text=${inProgressConfig.progressPercent}%`).count()) > 0);

    await page.reload();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check("Reload confirms persisted status", true);

    // ══════════════════════ FLOW 2 — Standalone completion ══════════════════════
    console.log("\n=== FLOW 2: Standalone Activity moved to completion status ===\n");
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^Completed$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("Completed")', { timeout: 10000 });
    check("Reached 100% (or configured completion progress)", (await page.locator("text=100%").count()) > 0);
    check("No Project-related error/crash occurred (page still renders normally)", (await page.locator("text=Standalone").count()) > 0);

    await page.reload();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("Completed")', { timeout: 10000 });
    const completedInDb = await prisma.projectActivity.findUnique({ where: { id: standalone.id }, select: { isCompleted: true, completedAt: true, projectId: true } });
    check("DB confirms isCompleted true, completedAt stamped, projectId still null", completedInDb?.isCompleted === true && !!completedInDb.completedAt && completedInDb.projectId === null);

    // ══════════════════════ FLOW 3 — Standalone reopen ══════════════════════
    console.log("\n=== FLOW 3: Standalone Activity reopened from completion ===\n");
    const todoConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: dept.id, status: ActivityStatus.TODO } } });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^To Do$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("To Do")', { timeout: 10000 });
    check(`Progress recalculated correctly for To Do (${todoConfig.progressPercent}%)`, (await page.locator(`text=${todoConfig.progressPercent}%`).count()) > 0);

    // ══════════════════════ FLOW 4 — Linked Activity still rolls up ══════════════════════
    console.log("\n=== FLOW 4: Project-linked Activity quick status still rolls up ===\n");
    const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN }, select: { id: true } });
    const linkedProject = await prisma.project.create({ data: { title: `${TAG} Linked Project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(linkedProject.id);
    const linkedActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Linked Activity`, departmentId: dept.id, projectId: linkedProject.id, status: ActivityStatus.TODO },
    });
    activityIds.push(linkedActivity.id);

    await page.goto(`${BASE_URL}/activities/${linkedActivity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    await page.getByRole("button", { name: "Change activity status" }).click();
    await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
    await page.locator('[role="menuitem"]').filter({ hasText: /^Completed$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("Completed")', { timeout: 10000 });

    await page.goto(`${BASE_URL}/projects/${linkedProject.id}`);
    await page.waitForSelector("text=100%", { timeout: 10000 });
    check("Parent Project rollup shows 100% for the linked Activity (unaffected by the standalone fix)", (await page.locator("text=100%").count()) > 0);

    // ══════════════════════ FLOW 5 — Permissions on a standalone Activity ══════════════════════
    console.log("\n=== FLOW 5: Permissions on a standalone Activity ===\n");
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

    await limitedPage.goto(`${BASE_URL}/activities/${standalone.id}`);
    await limitedPage.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    check("activity.view-only user CAN see the status (badge visible)", (await limitedPage.locator(".rounded-full").filter({ hasText: "To Do" }).count()) > 0);
    check("...but the quick-status trigger is disabled", !(await limitedPage.getByRole("button", { name: "Change activity status" }).isEnabled()));

    const directPatch = await limitedPage.request.fetch(`${BASE_URL}/api/activities/${standalone.id}`, { method: "PATCH", data: { status: ActivityStatus.CANCELLED, isCompleted: false } });
    check("Direct PATCH from this user is rejected", !directPatch.ok());
    await limitedContext.close();

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
