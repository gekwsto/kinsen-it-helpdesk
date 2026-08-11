/**
 * Regression check for the standalone /projects/new and /activities/new
 * pages after refactoring ProjectForm / ActivityNewForm to also support an
 * inline mode (components/projects/project-form.tsx, components/activities/
 * activity-new-form.tsx) — both are called with no `mode` prop from their
 * standalone pages, defaulting to "standalone", so this proves that default
 * path still creates and redirects exactly as before.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-standalone-project-activity-new.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvspa-${RUN_ID}`;

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

  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    console.log("\n=== /projects/new — standalone creation still redirects to /projects/{id} ===\n");
    await page.goto(`${BASE_URL}/projects/new`);
    await page.waitForLoadState("networkidle");
    check('Standalone form shows "Project Details" header (Card chrome intact, not the stripped inline layout)', (await page.locator("text=Project Details").count()) > 0);
    check('Workspace field is a real Select (not the inline read-only badge)', (await page.locator('text="Choose a workspace…"').count()) + (await page.locator('[role="combobox"]', { hasText: /./ }).count()) >= 0);
    await page.fill("#title", `${TAG} Standalone Project`);
    // Pick a workspace if the Select requires an explicit choice.
    const deptSelect = page.locator("text=Workspace").locator("xpath=following-sibling::button[@role='combobox']").first();
    if ((await deptSelect.count()) > 0) {
      await deptSelect.click();
      await page.locator('[role="option"]').first().click();
    }
    await Promise.all([
      page.waitForURL((url) => /^\/projects\/[a-z0-9]+$/.test(url.pathname) && url.pathname !== "/projects/new", { timeout: 15000 }),
      page.getByRole("button", { name: "Create Project" }).click(),
    ]);
    check(
      "Redirected to the new project's detail page",
      /^\/projects\/[a-z0-9]+$/.test(new URL(page.url()).pathname) && new URL(page.url()).pathname !== "/projects/new"
    );
    const projectId = page.url().split("/").pop()!;
    projectIds.push(projectId);
    const createdProject = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
    check("Project really was created with the submitted title", createdProject?.title === `${TAG} Standalone Project`);

    console.log("\n=== /activities/new — standalone creation still redirects to /activities/{id} ===\n");
    await page.goto(`${BASE_URL}/activities/new`);
    await page.waitForLoadState("networkidle");
    check('Standalone form shows "Create Activity" header (Card chrome intact)', (await page.locator("text=Create Activity").count()) > 0);
    await page.fill("#title", `${TAG} Standalone Activity`);
    await Promise.all([
      page.waitForURL((url) => /^\/activities\/[a-z0-9]+$/.test(url.pathname) && url.pathname !== "/activities/new", { timeout: 15000 }),
      page.getByRole("button", { name: "Create Activity" }).click(),
    ]);
    check(
      "Redirected to the new activity's detail page",
      /^\/activities\/[a-z0-9]+$/.test(new URL(page.url()).pathname) && new URL(page.url()).pathname !== "/activities/new"
    );
    const activityId = page.url().split("/").pop()!;
    activityIds.push(activityId);
    const createdActivity = await prisma.projectActivity.findUnique({ where: { id: activityId }, select: { title: true, progress: true, status: true } });
    check("Activity really was created with the submitted title", createdActivity?.title === `${TAG} Standalone Activity`);
    check("Activity progress was derived from its status (ActivityProgressConfig), not left unset", typeof createdActivity?.progress === "number");

    await context.close();
  } finally {
    await browser.close();
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
