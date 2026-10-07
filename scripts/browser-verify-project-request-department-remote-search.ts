/**
 * Live browser verification that the Project Request form's Department
 * combobox can now reach a Department BEYOND the initial, take-bounded
 * list (WORKSPACE_LIST_TAKE=20 in lib/services/workspace-service.ts) via
 * the new remoteSearch wiring (components/project-requests/project-request-form.tsx),
 * which reuses the existing GET /api/workspace/search endpoint — the
 * concrete repro for "IT Department doesn't show up" on a dev DB with
 * 100+ departments (IT Department sorts well past position 20
 * alphabetically).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-department-remote-search.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";

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

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    const itDept = await prisma.department.findFirst({ where: { name: "IT Department" }, select: { id: true, name: true } });
    if (!itDept) {
      console.log("No 'IT Department' row found — skipping (nothing to reproduce against).");
      console.log(`0 passed, 0 failed`);
      process.exit(0);
    }
    const rankBefore = await prisma.department.count({ where: { isActive: true, name: { lt: itDept.name } } });
    console.log(`\n"IT Department" alphabetical rank (0-indexed) among active departments: ${rankBefore}\n`);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("Logging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    console.log("\n=== 1. Open /project-requests/new, open the Department combobox ===\n");
    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForLoadState("load");
    const deptTrigger = page.locator("#departmentId");
    await deptTrigger.click();
    await page.waitForTimeout(300);
    let bodyText = await page.locator("body").innerText();
    check(
      `"IT Department" is NOT in the initial (take-bounded) list before any search (rank ${rankBefore} > 20)`,
      rankBefore < 20 || !bodyText.includes("IT Department")
    );

    console.log('\n=== 2. Searching "IT Department" reaches it via the remote search fallback ===\n');
    const searchInput = page.locator('input[placeholder="Search workspaces…"]');
    const searchResponse = page.waitForResponse((res) => res.url().includes("/api/workspace/search"), { timeout: 8000 }).catch(() => null);
    await searchInput.fill("IT Department");
    await searchResponse;
    await page.waitForTimeout(500);
    bodyText = await page.locator("body").innerText();
    check('Searching "IT Department" now shows it, even though it was missing from the initial list', bodyText.includes("IT Department"));

    console.log("\n=== 3. Selecting it updates the form value ===\n");
    await page.locator('[role="option"]', { hasText: "IT Department" }).first().click();
    await page.waitForTimeout(300);
    check("Trigger now shows 'IT Department' as selected", (await deptTrigger.innerText()).includes("IT Department"));

    console.log("\n=== 4. Reopening shows a populated list immediately, with no stale search query ===\n");
    await deptTrigger.click();
    await page.waitForTimeout(300);
    const reopenedSearchInput = page.locator('input[placeholder="Search workspaces…"]');
    check("Search input is present and empty again (not a stale 'IT Department' query from before)", (await reopenedSearchInput.inputValue()) === "");
    bodyText = await page.locator("body").innerText();
    check("The original (take-bounded) list is shown immediately — no network wait for an empty query", bodyText.includes("No workspaces available.") === false);

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
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
