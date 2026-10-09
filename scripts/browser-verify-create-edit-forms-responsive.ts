/**
 * Visual/responsive verification for the Project/Activity Create+Edit page
 * layout fix — removed the page/form-level max-width caps (Project New:
 * max-w-2xl -> none; Project New fromRequest: max-w-4xl -> none; Project
 * Edit: max-w-4xl -> none; Activity New: max-w-2xl -> none; Activity Edit:
 * max-w-4xl -> none) across app/(main)/projects/new/page.tsx,
 * app/(main)/projects/[id]/edit/page.tsx,
 * components/activities/activity-new-form.tsx,
 * app/(main)/activities/[id]/edit/activity-edit-client.tsx — plus made the
 * remaining unconditional `grid-cols-2` field pairs in the two shared
 * CREATE form components (ProjectForm, ActivityNewForm) responsive
 * (`grid-cols-1 sm:grid-cols-2`), matching what the Edit forms already had.
 *
 * Verifies, for every Create/Edit variant (standalone AND Project
 * Request-origin alike): the rendered container's ACTUAL width (not just
 * CSS classes) now matches <main>'s real available content width at
 * 1440/1920/2560, zero horizontal overflow at 390/768/1440/1920/2560, and
 * that submitting each CREATE form still actually works end-to-end
 * (nothing about field/validation/submit logic was touched — pure
 * className/layout edits).
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-create-edit-forms-responsive.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ProjectStatus, ProjectRequestStatus } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvcef-${RUN_ID}`;

const DESKTOP_WIDTHS = [1440, 1920, 2560];
const ALL_WIDTHS = [390, 768, ...DESKTOP_WIDTHS];

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

async function measureContainer(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const r = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const mainContentWidth = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const first = main.firstElementChild;
    const containerWidth = first ? first.getBoundingClientRect().width : null;
    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = document.documentElement.clientWidth;
    return { mainContentWidth, containerWidth, scrollWidth, clientWidth };
  });
}

async function verifyRoute(page: Page, url: string, label: string, waitForText: RegExp) {
  for (const width of ALL_WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(url, { waitUntil: "load" });
    await page.getByRole("button", { name: waitForText }).first().waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(150);
    const m = await measureContainer(page);
    check(`${label} @ ${width}px — no horizontal overflow (scrollWidth ${m?.scrollWidth} <= clientWidth ${m?.clientWidth})`, !!m && m.scrollWidth <= m.clientWidth);
    if (DESKTOP_WIDTHS.includes(width) && m) {
      check(
        `${label} @ ${width}px — container fills <main>'s real content width (container=${m.containerWidth?.toFixed(1)}, main=${m.mainContentWidth.toFixed(1)})`,
        Math.abs((m.containerWidth ?? 0) - m.mainContentWidth) < 2
      );
    }
  }
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
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const standaloneProject = await prisma.project.create({
      data: { title: `${TAG} Standalone Project`, status: ProjectStatus.PLANNING, priority: 2, ownerId: admin.id, departmentId: dept.id },
    });
    projectIds.push(standaloneProject.id);

    const standaloneActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Standalone Activity`, departmentId: dept.id },
    });
    activityIds.push(standaloneActivity.id);

    // A real APPROVED, not-yet-set-up Project Request owned by the demo
    // admin — exercises ProjectForm's "fromRequest" mode exactly the way
    // /projects/new?projectRequestId=... is actually reached in production
    // (via the approval flow), not a synthetic shortcut.
    const existingUnsetRequest = await prisma.projectRequest.findFirst({
      where: { status: ProjectRequestStatus.APPROVED, project: null, approverId: admin.id },
      select: { id: true },
    });

    // Existing request-origin Project/Activity (dense Edit variants) — real
    // fixture data already in this dev DB, not newly created, to also prove
    // the fix against genuinely pre-existing records.
    const requestOriginProject = await prisma.project.findFirst({
      where: { projectRequestId: { not: null } },
      select: { id: true },
    });
    const requestOriginActivity = await prisma.projectActivity.findFirst({
      where: { project: { projectRequestId: { not: null } } },
      select: { id: true },
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);
    check("0. Logged in as the demo Admin account", !page.url().includes("/login"));

    console.log("\n=== Project New (standalone) ===\n");
    await verifyRoute(page, `${BASE_URL}/projects/new`, "Project New (standalone)", /Create Project/);

    if (existingUnsetRequest) {
      console.log("\n=== Project New (fromRequest — Project Request-origin) ===\n");
      await verifyRoute(page, `${BASE_URL}/projects/new?projectRequestId=${existingUnsetRequest.id}`, "Project New (fromRequest)", /Create Project/);
    } else {
      console.log("\n(No unset APPROVED Project Request owned by the demo admin found — skipping fromRequest variant.)\n");
    }

    console.log("\n=== Project Edit (standalone project) ===\n");
    await verifyRoute(page, `${BASE_URL}/projects/${standaloneProject.id}/edit`, "Project Edit (standalone)", /Save Changes/);

    if (requestOriginProject) {
      console.log("\n=== Project Edit (request-origin project, dense Project Request Setup block) ===\n");
      await verifyRoute(page, `${BASE_URL}/projects/${requestOriginProject.id}/edit`, "Project Edit (request-origin)", /Save Changes/);
    }

    console.log("\n=== Activity New (standalone, no project) ===\n");
    await verifyRoute(page, `${BASE_URL}/activities/new`, "Activity New (standalone)", /Create Activity/);

    console.log("\n=== Activity Edit (standalone activity) ===\n");
    await verifyRoute(page, `${BASE_URL}/activities/${standaloneActivity.id}/edit`, "Activity Edit (standalone)", /Save Changes/);

    if (requestOriginActivity) {
      console.log("\n=== Activity Edit (request-origin activity, dense Project Request Setup block) ===\n");
      await verifyRoute(page, `${BASE_URL}/activities/${requestOriginActivity.id}/edit`, "Activity Edit (request-origin)", /Save Changes/);
    }

    // ══════════════════════ Functional parity — forms still actually submit ══════════════════════
    console.log("\n=== Functional smoke: Create forms still work end-to-end (nothing about submit logic was touched) ===\n");
    await page.setViewportSize({ width: 1920, height: 1000 });

    await page.goto(`${BASE_URL}/projects/new`, { waitUntil: "load" });
    const projectTitle = `${TAG} Submitted Project`;
    await page.locator("#title").fill(projectTitle);
    // The Workspace combobox is the first role="combobox" element in DOM
    // order on this page (it's the first Select-like control the form
    // renders, before Status/Priority) — located structurally rather than
    // by its placeholder text, which varies (it shows the already-selected
    // department's name instead of "Choose a workspace…" whenever the
    // signed-in user already has an active workspace set).
    await page.getByRole("combobox").first().click();
    await page.getByRole("option").first().click();
    await Promise.all([
      page.waitForURL((url) => /\/projects\/[a-zA-Z0-9]+$/.test(url.pathname), { timeout: 15000 }),
      page.getByRole("button", { name: "Create Project" }).click(),
    ]);
    check("1. Project New form still submits and navigates to the real new Project's detail page", /\/projects\/[a-zA-Z0-9]+$/.test(new URL(page.url()).pathname));
    const projectTitleShown = await page.getByText(projectTitle, { exact: true }).first().waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
    check("2. The new Project detail page shows the EXACT title submitted", projectTitleShown);
    const createdProject = await prisma.project.findFirst({ where: { title: projectTitle }, select: { id: true } });
    if (createdProject) projectIds.push(createdProject.id);
    check("3. The submitted Project genuinely persisted to the database", !!createdProject);

    await page.goto(`${BASE_URL}/activities/new`, { waitUntil: "load" });
    const activityTitle = `${TAG} Submitted Activity`;
    await page.locator("#title").fill(activityTitle);
    await page.locator("#task-type").click();
    await page.getByRole("option").first().click();
    await Promise.all([
      page.waitForURL((url) => /\/activities\/[a-zA-Z0-9]+$/.test(url.pathname), { timeout: 15000 }),
      page.getByRole("button", { name: "Create Activity" }).click(),
    ]);
    check("4. Activity New form still submits and navigates to the real new Activity's detail page", /\/activities\/[a-zA-Z0-9]+$/.test(new URL(page.url()).pathname));
    const activityTitleShown = await page.getByText(activityTitle, { exact: true }).first().waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
    check("5. The new Activity detail page shows the EXACT title submitted", activityTitleShown);
    const createdActivity = await prisma.projectActivity.findFirst({ where: { title: activityTitle }, select: { id: true } });
    if (createdActivity) activityIds.push(createdActivity.id);
    check("6. The submitted Activity genuinely persisted to the database", !!createdActivity);
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
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
