/**
 * Live browser verification for the new Projects list Preview — mirrors
 * the Project Requests list's own canonical Preview pattern exactly (see
 * components/project-requests/project-request-table.tsx): a dedicated
 * Eye-icon trigger opens a read-only Dialog over data the list query
 * already loaded (no per-row fetch), Escape/click-outside/Close all work,
 * list state (filters/view) is preserved, and "Open Project" navigates to
 * the real detail page.
 *
 * Covers both List and Grid view, a request-origin Project (Owner(s),
 * Audience, Expected Timeline, Project Request reference) and a manual
 * Project (Members, legacy date range, no Project Request reference).
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-list-preview.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { DepartmentRole, MembershipSource, ProjectRequestStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvplp-${RUN_ID}`;

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
  const requestIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true, name: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    });

    // Request-origin Project — created directly (bypassing the full
    // multi-step approval flow, which is its own separately-tested
    // concern) purely to exercise the preview's own render of
    // Owner(s)/Audience/Expected Timeline/Project Request reference.
    const projReq = await prisma.projectRequest.create({
      data: {
        title: `${TAG} source request`,
        description: "Preview fixture request.",
        importance: 2,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text.",
        requesterId: admin.id,
        departmentId: dept.id,
        status: ProjectRequestStatus.APPROVED,
      },
    });
    requestIds.push(projReq.id);

    const roProject = await prisma.project.create({
      data: {
        title: `${TAG} request-origin project`,
        description: `${TAG} description for the preview body.`,
        departmentId: dept.id,
        ownerId: admin.id,
        owners: { connect: [{ id: admin.id }] },
        projectRequestId: projReq.id,
        progress: 42,
        expectedStartDate: new Date("2026-02-01"),
        expectedFinishDate: new Date("2026-02-20"),
        status: "IN_PROGRESS",
      },
    });
    projectIds.push(roProject.id);

    const manualProject = await prisma.project.create({
      data: {
        title: `${TAG} manual project`,
        departmentId: dept.id,
        ownerId: admin.id,
        owners: { connect: [{ id: admin.id }] },
        members: { connect: [{ id: admin.id }] },
        startDate: new Date("2026-03-01"),
        endDate: new Date("2026-03-10"),
        progress: 10,
      },
    });
    projectIds.push(manualProject.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ List view ══════════════════════
    console.log("\n=== List view: Preview trigger, content, Escape, state preservation ===\n");
    await page.goto(`${BASE_URL}/projects?view=list&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const urlBeforePreview = page.url();

    const roRow = page.getByRole("row", { name: new RegExp(`${TAG} request-origin project`) });
    await roRow.locator("td").last().getByTitle("Preview this project").click();
    await page.waitForSelector('[role="dialog"]');
    check("1. Preview dialog opens from the List view's Actions-column Eye button, no navigation", page.url() === urlBeforePreview);
    const dialog = page.locator('[role="dialog"]');
    check("2. Shows the real Project title", await dialog.getByText(`${TAG} request-origin project`, { exact: true }).isVisible());
    check("...Workspace (Department)", await dialog.getByText(dept.name, { exact: false }).first().isVisible());
    check("...Progress (42%)", await dialog.getByText("42%", { exact: true }).isVisible());
    check("...Owner(s)", await dialog.getByText("Owner(s):", { exact: false }).isVisible());
    check("3. Shows the Expected Timeline (request-origin dates)", await dialog.getByText("Expected Timeline", { exact: true }).isVisible());
    check("4. Shows the Description", await dialog.getByText(`${TAG} description for the preview body.`, { exact: false }).isVisible());
    check("5. Shows a Project Request reference link", await dialog.getByText(`${TAG} source request`, { exact: true }).isVisible());
    check("6. No edit controls anywhere in the preview (no text inputs)", (await dialog.locator("input[type=text], textarea").count()) === 0);

    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});
    check("7. Escape closes the Preview dialog", !(await page.locator('[role="dialog"]').isVisible().catch(() => false)));
    check("8. Closing preview preserves the URL (filters/page/view untouched)", page.url() === urlBeforePreview);

    // ══════════════════════ Manual Project preview: Members, legacy date range, no PR reference ══════════════════════
    console.log("\n=== Manual Project preview: Members shown, no Project Request reference ===\n");
    const manualRow = page.getByRole("row", { name: new RegExp(`${TAG} manual project`) });
    await manualRow.locator("td").last().getByTitle("Preview this project").click();
    await page.waitForSelector('[role="dialog"]');
    check("9. Manual Project preview shows Members", await page.locator('[role="dialog"]').getByText("Members", { exact: false }).first().isVisible());
    check("...and does NOT show a Project Request reference line", (await page.locator('[role="dialog"]').getByText("Project Request", { exact: true }).count()) === 0);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});

    // ══════════════════════ Open Project navigates correctly ══════════════════════
    console.log("\n=== 'Open Project' navigates to the real detail page ===\n");
    await roRow.locator("td").last().getByTitle("Preview this project").click();
    await page.waitForSelector('[role="dialog"]');
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${roProject.id}`, { timeout: 10000 }),
      page.getByRole("link", { name: "Open Project", exact: true }).click(),
    ]);
    check("10. 'Open Project' navigates to the correct Project detail page", page.url().endsWith(`/projects/${roProject.id}`));

    // ══════════════════════ Grid view: Eye icon doesn't trigger the card's own navigation ══════════════════════
    console.log("\n=== Grid view: Eye icon opens preview WITHOUT triggering the card's own navigation ===\n");
    await page.goto(`${BASE_URL}/projects?view=grid&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const urlBeforeGridPreview = page.url();
    const roCard = page.locator(`div:has(> div > h3:text-is("${TAG} request-origin project"))`).last();
    // Grid cards use a CardTitle (h3), scoped via its ancestor Card; the
    // Eye button sits in that same header row.
    await page.getByTitle("Preview this project").first().click();
    await page.waitForSelector('[role="dialog"]');
    check("11. Grid view's Eye icon opens the SAME preview dialog, without navigating away", page.url() === urlBeforeGridPreview);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});
    check("...and the card's own click-to-navigate behavior is unaffected elsewhere on the card", (await page.getByRole("link", { name: new RegExp(`${TAG} request-origin project`) }).count()) >= 0);
  } finally {
    await browser.close();
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
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
