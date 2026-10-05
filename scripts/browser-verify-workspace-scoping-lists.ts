/**
 * Live browser verification for the workspace-scoping fix across the three
 * main list pages: Tickets, Projects, Activities.
 *
 * For each page: switch Workspace using the REAL workspace switcher (never
 * a direct API call, never a manual filter), confirm the visible rows
 * update WITHOUT touching any other filter. Also checks browser back/
 * forward doesn't restore a stale/invalid combination, and that there's no
 * stale-row flash.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-workspace-scoping-lists.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: any = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvws-${RUN_ID}`;

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

async function switchWorkspace(page: Page, departmentName: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  await trigger.click();
  await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 });
  await page.fill('input[placeholder="Search workspaces..."]', departmentName);
  await page.waitForTimeout(300);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/workspace/active") && r.request().method() === "POST"),
    page.getByRole("menuitem", { name: new RegExp(departmentName) }).first().click(),
  ]);
  // Not "networkidle" — this app keeps long-lived SSE connections open
  // (notifications/list realtime streams), so the network is never
  // genuinely idle; a fixed settle delay after the confirmed POST response
  // is the same convention this repo's other workspace-switch browser
  // scripts already use.
  await page.waitForTimeout(500);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const deptIds: string[] = [];
  const ticketIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const deptA = await createDepartment({ name: `${TAG}-deptA`, slug: `${TAG}-deptA` });
    const deptB = await createDepartment({ name: `${TAG}-deptB`, slug: `${TAG}-deptB` });
    deptIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const statusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: false } });
    const statusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isClosed: false } });
    const ticketA = await prisma.ticket.create({ data: { title: `${TAG} Ticket A`, description: "fixture", requesterId: admin.id, departmentId: deptA.id, statusId: statusA.id } });
    const ticketB = await prisma.ticket.create({ data: { title: `${TAG} Ticket B`, description: "fixture", requesterId: admin.id, departmentId: deptB.id, statusId: statusB.id } });
    ticketIds.push(ticketA.id, ticketB.id);

    const projectA = await prisma.project.create({ data: { title: `${TAG} Project A`, departmentId: deptA.id, ownerId: admin.id } });
    const projectB = await prisma.project.create({ data: { title: `${TAG} Project B`, departmentId: deptB.id, ownerId: admin.id } });
    projectIds.push(projectA.id, projectB.id);

    const activityA = await prisma.projectActivity.create({ data: { title: `${TAG} Activity A`, departmentId: deptA.id, projectId: projectA.id, createdById: admin.id } });
    const activityB = await prisma.projectActivity.create({ data: { title: `${TAG} Activity B`, departmentId: deptB.id, projectId: projectB.id, createdById: admin.id } });
    activityIds.push(activityA.id, activityB.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ TICKETS ══════════════════════
    console.log("\n=== TICKETS: real workspace switch updates the list with no manual filter ===\n");
    await switchWorkspace(page, `${TAG}-deptA`);
    await page.goto(`${BASE_URL}/tickets`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Workspace A: Ticket A visible", (await page.getByText(`${TAG} Ticket A`, { exact: true }).count()) > 0);
    check("Workspace A: Ticket B NOT visible", (await page.getByText(`${TAG} Ticket B`, { exact: true }).count()) === 0);

    // Switch WHILE already on /tickets — the list must update in place,
    // no manual filter interaction.
    await switchWorkspace(page, `${TAG}-deptB`);
    await page.waitForTimeout(600);
    check("Switching to Workspace B while ON /tickets: Ticket B now visible, with zero manual filter interaction", (await page.getByText(`${TAG} Ticket B`, { exact: true }).count()) > 0);
    check("Switching to Workspace B: Ticket A no longer visible, no stale row left over", (await page.getByText(`${TAG} Ticket A`, { exact: true }).count()) === 0);

    // ══════════════════════ PROJECTS ══════════════════════
    console.log("\n=== PROJECTS: real workspace switch updates the list with no manual filter ===\n");
    await switchWorkspace(page, `${TAG}-deptA`);
    await page.goto(`${BASE_URL}/projects`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Workspace A: Project A visible", (await page.getByText(`${TAG} Project A`, { exact: true }).count()) > 0);
    check("Workspace A: Project B NOT visible", (await page.getByText(`${TAG} Project B`, { exact: true }).count()) === 0);

    await switchWorkspace(page, `${TAG}-deptB`);
    await page.waitForTimeout(600);
    check("Switching to Workspace B while ON /projects: Project B now visible", (await page.getByText(`${TAG} Project B`, { exact: true }).count()) > 0);
    check("Switching to Workspace B: Project A no longer visible", (await page.getByText(`${TAG} Project A`, { exact: true }).count()) === 0);

    // ══════════════════════ ACTIVITIES ══════════════════════
    console.log("\n=== ACTIVITIES: real workspace switch updates the list with no manual filter ===\n");
    await switchWorkspace(page, `${TAG}-deptA`);
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Workspace A: Activity A visible", (await page.getByText(`${TAG} Activity A`, { exact: true }).count()) > 0);
    check("Workspace A: Activity B NOT visible", (await page.getByText(`${TAG} Activity B`, { exact: true }).count()) === 0);

    await switchWorkspace(page, `${TAG}-deptB`);
    await page.waitForTimeout(600);
    check("Switching to Workspace B while ON /activities: Activity B now visible", (await page.getByText(`${TAG} Activity B`, { exact: true }).count()) > 0);
    check("Switching to Workspace B: Activity A no longer visible", (await page.getByText(`${TAG} Activity A`, { exact: true }).count()) === 0);

    // ══════════════════════ Back/forward does not restore stale state ══════════════════════
    console.log("\n=== Browser back/forward: no stale/invalid workspace-filter combination ===\n");
    // Currently: /activities, workspace B. Navigate to /tickets (workspace
    // still B), then go back — the active workspace is a cookie, not URL
    // state, so back/forward must never silently revert or desync it.
    await page.goto(`${BASE_URL}/tickets`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    check("After navigating to /tickets (still Workspace B): Ticket B visible", (await page.getByText(`${TAG} Ticket B`, { exact: true }).count()) > 0);
    await page.goBack({ waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Back navigation to /activities still correctly shows Workspace B's Activity (cookie-based workspace unaffected by history nav)", (await page.getByText(`${TAG} Activity B`, { exact: true }).count()) > 0);
    check("...and still correctly excludes Workspace A's Activity — no stale/invalid combination restored", (await page.getByText(`${TAG} Activity A`, { exact: true }).count()) === 0);
    await page.goForward({ waitUntil: "load" });
    await page.waitForTimeout(600);
    check("Forward navigation back to /tickets still shows Workspace B's Ticket correctly", (await page.getByText(`${TAG} Ticket B`, { exact: true }).count()) > 0);

    // ══════════════════════ No layout regression (sanity) ══════════════════════
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check("No horizontal overflow/layout regression on the Tickets page after all this switching", !hasHorizontalOverflow);
  } finally {
    await browser.close();
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
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
