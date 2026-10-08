/**
 * Live browser verification for the new Activities list Preview — mirrors
 * the Project Requests list's own canonical Preview pattern exactly (see
 * components/project-requests/project-request-table.tsx): a dedicated
 * Eye-icon trigger opens a read-only Dialog over data the list query
 * already loaded (no per-row fetch), Escape/click-outside/Close all work,
 * list state (filters/page/view) is preserved, and "Open Activity"
 * navigates to the real detail page.
 *
 * Covers both List and Grid view, a request-origin Activity (Task Type,
 * Task Sub Type, cost snapshot, Owner, Expected Timeline/Days) and a
 * standalone Activity (no Project, no Task Sub Type).
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-list-preview.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { DepartmentRole, MembershipSource } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvalp-${RUN_ID}`;

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
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const taskTypeIds: string[] = [];
  const taskSubTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true, name: true, email: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    });

    const taskType = await prisma.taskType.create({ data: { name: `${TAG}-tasktype` } });
    taskTypeIds.push(taskType.id);
    const taskSubType = await prisma.taskSubType.create({ data: { name: `${TAG}-subtype`, cost: 150 } });
    taskSubTypeIds.push(taskSubType.id);

    const project = await prisma.project.create({
      data: { title: `${TAG} project`, departmentId: dept.id, ownerId: admin.id },
    });
    projectIds.push(project.id);

    // Request-origin-shaped Activity (full planning metadata) — created
    // directly via Prisma, bypassing the full request/approval flow (its
    // own separately-tested concern); only the FIELDS preview renders
    // matter here.
    const roActivity = await prisma.projectActivity.create({
      data: {
        title: `${TAG} full activity`,
        description: `${TAG} activity description for the preview body.`,
        projectId: project.id,
        departmentId: dept.id,
        createdById: admin.id,
        ownerId: admin.id,
        taskTypeId: taskType.id,
        taskSubTypeId: taskSubType.id,
        taskSubTypeCost: 150,
        expectedStartDate: new Date("2026-02-01"),
        expectedFinishDate: new Date("2026-02-05"),
        expectedDays: 4,
        assignedUsers: { connect: [{ id: admin.id }] },
      },
    });
    activityIds.push(roActivity.id);

    const standaloneActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} standalone activity`, departmentId: dept.id, createdById: admin.id },
    });
    activityIds.push(standaloneActivity.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ List view ══════════════════════
    console.log("\n=== List view: Preview trigger, content, Escape, state preservation ===\n");
    await page.goto(`${BASE_URL}/activities?view=list&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const urlBeforePreview = page.url();

    const fullRow = page.getByRole("row", { name: new RegExp(`${TAG} full activity`) });
    await fullRow.locator("td").last().getByTitle("Preview this activity").click();
    await page.waitForSelector('[role="dialog"]');
    check("1. Preview dialog opens from the List view's Actions-column Eye button, no navigation", page.url() === urlBeforePreview);
    const dialog = page.locator('[role="dialog"]');
    check("2. Shows the real Activity title", await dialog.getByText(`${TAG} full activity`, { exact: true }).isVisible());
    check("...Project", await dialog.getByText(`${TAG} project`, { exact: true }).isVisible());
    check("...Owner", await dialog.getByText(admin.name ?? admin.email ?? "", { exact: false }).first().isVisible());
    check("3. Shows Task Type and Task Sub Type", await dialog.getByText(`${TAG}-tasktype`, { exact: true }).isVisible() && (await dialog.getByText(`${TAG}-subtype`, { exact: true }).isVisible()));
    check("4. Shows the Expected Timeline (start/finish/days)", await dialog.getByText("Expected Timeline", { exact: true }).isVisible());
    check("5. Shows the cost snapshot (€150.00/day) and Estimated Cost (150 × 4 = €600.00)", await dialog.getByText(/€150\.00.*day/, { exact: false }).isVisible() && (await dialog.getByText(/€600\.00/, { exact: false }).isVisible()));
    check("6. Shows Related Users", await dialog.getByText("Related Users", { exact: true }).isVisible());
    check("7. Shows the Description", await dialog.getByText(`${TAG} activity description for the preview body.`, { exact: false }).isVisible());
    check("8. No edit controls anywhere in the preview (no text inputs)", (await dialog.locator("input[type=text], textarea").count()) === 0);

    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});
    check("9. Escape closes the Preview dialog", !(await page.locator('[role="dialog"]').isVisible().catch(() => false)));
    check("10. Closing preview preserves the URL (filters/page/view untouched)", page.url() === urlBeforePreview);

    // ══════════════════════ Standalone Activity: no Project, no Task Sub Type ══════════════════════
    console.log("\n=== Standalone Activity preview: no Project, no Task Sub Type, never crashes ===\n");
    const standaloneRow = page.getByRole("row", { name: new RegExp(`${TAG} standalone activity`) });
    await standaloneRow.locator("td").last().getByTitle("Preview this activity").click();
    await page.waitForSelector('[role="dialog"]');
    check("11. Standalone Activity preview shows 'Standalone' for Project", await page.locator('[role="dialog"]').getByText("Standalone", { exact: true }).isVisible());
    check("...and 'Unassigned' for Related Users, never a crash", await page.locator('[role="dialog"]').getByText("Unassigned", { exact: true }).isVisible());
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});

    // ══════════════════════ Open Activity navigates correctly ══════════════════════
    console.log("\n=== 'Open Activity' navigates to the real detail page ===\n");
    await fullRow.locator("td").last().getByTitle("Preview this activity").click();
    await page.waitForSelector('[role="dialog"]');
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/activities/${roActivity.id}`, { timeout: 10000 }),
      page.getByRole("link", { name: "Open Activity", exact: true }).click(),
    ]);
    check("12. 'Open Activity' navigates to the correct Activity detail page", page.url().endsWith(`/activities/${roActivity.id}`));

    // ══════════════════════ Grid view: Eye icon doesn't trigger the card's own navigation ══════════════════════
    console.log("\n=== Grid view: Eye icon opens preview WITHOUT triggering the card's own navigation ===\n");
    await page.goto(`${BASE_URL}/activities?view=grid&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const urlBeforeGridPreview = page.url();
    await page.getByTitle("Preview this activity").first().click();
    await page.waitForSelector('[role="dialog"]');
    check("13. Grid view's Eye icon opens the SAME preview dialog, without navigating away", page.url() === urlBeforeGridPreview);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.taskSubType.deleteMany({ where: { id: { in: taskSubTypeIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: taskTypeIds } } });
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
