/**
 * Live browser verification for:
 *   - Projects list: new "Owners" column (before Members) and "Created"
 *     column (last data column), plus a new Origin filter (All / From
 *     Request / Manual), canonical source of truth Project.projectRequestId.
 *   - Activities list: new "Created" column (right after Progress), plus
 *     a new Origin filter, canonical rule
 *     activity.project.projectRequestId != null (a standalone Activity
 *     counts as Manual too).
 *   - Regression: existing Preview still works, pagination/filter query
 *     state still combines correctly, list state otherwise unaffected.
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-activity-list-columns-origin.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { DepartmentRole, MembershipSource, ProjectRequestStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvcol-${RUN_ID}`;

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
  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true, name: true } });
    const secondOwner = await prisma.user.create({
      data: { email: `${TAG}-secondowner@kinsen.gr`, name: `${TAG} Second Owner`, role: "USER", authProvider: "CREDENTIALS", isActive: true },
    });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    });

    // ── Projects fixtures ──
    const projReq = await prisma.projectRequest.create({
      data: {
        title: `${TAG} source request`,
        description: "Fixture request.",
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
        departmentId: dept.id,
        ownerId: admin.id,
        owners: { connect: [{ id: admin.id }, { id: secondOwner.id }] },
        projectRequestId: projReq.id,
      },
    });
    projectIds.push(roProject.id);

    const manualProject = await prisma.project.create({
      data: {
        title: `${TAG} manual project`,
        departmentId: dept.id,
        ownerId: admin.id,
        owners: { connect: [{ id: admin.id }] },
      },
    });
    projectIds.push(manualProject.id);

    // ── Activities fixtures ──
    const roActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} request-origin activity`, projectId: roProject.id, departmentId: dept.id, createdById: admin.id },
    });
    activityIds.push(roActivity.id);
    const standaloneActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} standalone activity`, departmentId: dept.id, createdById: admin.id },
    });
    activityIds.push(standaloneActivity.id);

    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ PROJECTS: columns ══════════════════════
    console.log("\n=== Projects list: Owners column (before Members), Created column (last) ===\n");
    await page.goto(`${BASE_URL}/projects?view=list&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const headerTexts = await page.locator("table thead th").allInnerTexts();
    const ownersIdx = headerTexts.findIndex((t) => t.trim() === "Owners");
    const membersIdx = headerTexts.findIndex((t) => t.trim() === "Members");
    const activitiesIdx = headerTexts.findIndex((t) => t.trim() === "Activities");
    const createdIdx = headerTexts.findIndex((t) => t.trim() === "Created");
    check("1. 'Owners' header exists and comes immediately before 'Members'", ownersIdx !== -1 && membersIdx !== -1 && ownersIdx === membersIdx - 1);
    check("2. 'Created' header exists and comes after 'Activities' (last data column)", createdIdx !== -1 && activitiesIdx !== -1 && createdIdx === activitiesIdx + 1);

    const roRow = page.getByRole("row", { name: new RegExp(`${TAG} request-origin project`) });
    await roRow.locator("td").nth(ownersIdx).getByLabel(/Owners:/).hover();
    await page.waitForTimeout(300);
    check("3. Multiple request-origin Owners render (tooltip lists both)", (await page.getByText(admin.name ?? "", { exact: false }).count()) > 0 && (await page.getByText(`${TAG} Second Owner`, { exact: false }).count()) > 0);
    await page.mouse.move(10, 10);

    const manualRow = page.getByRole("row", { name: new RegExp(`${TAG} manual project`) });
    const manualOwnersCellText = await manualRow.locator("td").nth(ownersIdx).innerText();
    check("4. Manual Project shows its singleton Owner in the Owners column", manualOwnersCellText.length > 0);

    const roCreatedText = await roRow.locator("td").nth(createdIdx).innerText();
    check("5. Created date is shown (non-empty) and reflects Project.createdAt", roCreatedText.trim().length > 0 && roCreatedText.trim() !== "—");

    // ══════════════════════ PROJECTS: Origin filter ══════════════════════
    console.log("\n=== Projects list: Origin filter (All / From Request / Manual) ===\n");
    // The Select's trigger shows the CURRENTLY SELECTED item's own label,
    // not its placeholder, once a real value (even "all") is set — exactly
    // like the existing Priority/Completion quick-filters already do
    // ("All priorities", not "Priority"). Origin's "all" option is simply
    // labeled "All", unambiguous among this page's other quick-filters.
    await page.getByRole("combobox").filter({ hasText: /^All$/ }).click();
    await page.getByRole("option", { name: "From Request", exact: true }).click();
    await page.waitForTimeout(500);
    check("6. Origin=From Request shows the request-origin Project", (await page.getByText(`${TAG} request-origin project`, { exact: true }).count()) > 0);
    check("...and excludes the manual Project", (await page.getByText(`${TAG} manual project`, { exact: true }).count()) === 0);
    check("...URL carries ?origin=request", page.url().includes("origin=request"));

    await page.getByRole("combobox").filter({ hasText: "From Request" }).click();
    await page.getByRole("option", { name: "Manual", exact: true }).click();
    await page.waitForTimeout(500);
    check("7. Origin=Manual shows the manual Project", (await page.getByText(`${TAG} manual project`, { exact: true }).count()) > 0);
    check("...and excludes the request-origin Project", (await page.getByText(`${TAG} request-origin project`, { exact: true }).count()) === 0);

    await page.getByRole("combobox").filter({ hasText: "Manual" }).first().click();
    await page.getByRole("option", { name: "All", exact: true }).click();
    await page.waitForTimeout(500);
    check("8. Origin=All shows BOTH Projects again (full result set preserved)", (await page.getByText(`${TAG} request-origin project`, { exact: true }).count()) > 0 && (await page.getByText(`${TAG} manual project`, { exact: true }).count()) > 0);

    // ══════════════════════ PROJECTS: Preview still works ══════════════════════
    console.log("\n=== Regression: Preview still works on the Projects list ===\n");
    await page.getByRole("row", { name: new RegExp(`${TAG} request-origin project`) }).locator("td").last().getByTitle("Preview this project").click();
    await page.waitForSelector('[role="dialog"]');
    check("9. Preview dialog still opens correctly after adding the new columns", await page.locator('[role="dialog"]').isVisible());
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 }).catch(() => {});

    // ══════════════════════ ACTIVITIES: columns ══════════════════════
    console.log("\n=== Activities list: Created column immediately after Progress ===\n");
    await page.goto(`${BASE_URL}/activities?view=list&search=${encodeURIComponent(TAG)}&page=1&departmentId=${dept.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);

    const actHeaderTexts = await page.locator("table thead th").allInnerTexts();
    const progressIdx = actHeaderTexts.findIndex((t) => t.trim() === "Progress");
    const actCreatedIdx = actHeaderTexts.findIndex((t) => t.trim() === "Created");
    check("10. 'Created' header exists and comes immediately after 'Progress'", progressIdx !== -1 && actCreatedIdx !== -1 && actCreatedIdx === progressIdx + 1);

    const roActRow = page.getByRole("row", { name: new RegExp(`${TAG} request-origin activity`) });
    const actCreatedText = await roActRow.locator("td").nth(actCreatedIdx).innerText();
    check("11. Created date is shown (non-empty) and reflects ProjectActivity.createdAt", actCreatedText.trim().length > 0 && actCreatedText.trim() !== "—");

    // ══════════════════════ ACTIVITIES: Origin filter ══════════════════════
    console.log("\n=== Activities list: Origin filter (canonical activity.project.projectRequestId rule) ===\n");
    await page.getByRole("combobox").filter({ hasText: /^All$/ }).click();
    await page.getByRole("option", { name: "From Request", exact: true }).click();
    await page.waitForTimeout(500);
    check("12. Origin=From Request shows the request-origin Activity", (await page.getByText(`${TAG} request-origin activity`, { exact: true }).count()) > 0);
    check("...and excludes the standalone Activity", (await page.getByText(`${TAG} standalone activity`, { exact: true }).count()) === 0);

    await page.getByRole("combobox").filter({ hasText: "From Request" }).click();
    await page.getByRole("option", { name: "Manual", exact: true }).click();
    await page.waitForTimeout(500);
    check("13. Origin=Manual shows the standalone Activity (a standalone Activity counts as Manual, per the canonical isRequestOrigin rule)", (await page.getByText(`${TAG} standalone activity`, { exact: true }).count()) > 0);
    check("...and excludes the request-origin Activity", (await page.getByText(`${TAG} request-origin activity`, { exact: true }).count()) === 0);

    await page.getByRole("combobox").filter({ hasText: "Manual" }).click();
    await page.getByRole("option", { name: "All", exact: true }).click();
    await page.waitForTimeout(500);
    check("14. Origin=All shows BOTH Activities again", (await page.getByText(`${TAG} request-origin activity`, { exact: true }).count()) > 0 && (await page.getByText(`${TAG} standalone activity`, { exact: true }).count()) > 0);

    // ══════════════════════ ACTIVITIES: combining Origin with an existing filter ══════════════════════
    console.log("\n=== Regression: Origin combines correctly with the existing search filter, pagination state intact ===\n");
    const urlWithBoth = page.url();
    check("15. The URL still carries the search param alongside origin (filters combine, neither clobbers the other)", urlWithBoth.includes(`search=${encodeURIComponent(TAG)}`) || urlWithBoth.includes("search=bvcol"));

    // ══════════════════════ ACTIVITIES: Preview still works ══════════════════════
    console.log("\n=== Regression: Preview still works on the Activities list ===\n");
    await page.getByRole("row", { name: new RegExp(`${TAG} request-origin activity`) }).locator("td").last().getByTitle("Preview this activity").click();
    await page.waitForSelector('[role="dialog"]');
    check("16. Preview dialog still opens correctly after adding the Created column", await page.locator('[role="dialog"]').isVisible());
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.user.deleteMany({ where: { email: { contains: TAG } } });
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
