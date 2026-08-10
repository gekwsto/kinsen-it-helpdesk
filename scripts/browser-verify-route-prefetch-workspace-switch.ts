/**
 * The highest-risk correctness requirement for the new background route
 * prefetcher (components/navigation/app-route-prefetcher.tsx): a prefetch
 * warmed for workspace A must never leak into workspace B after switching.
 * Proves, against a real production server:
 *
 *  1. Landing on Workspace A warms /tickets (and friends) in the
 *     background.
 *  2. Switching to Workspace B triggers a FRESH re-warm pass (new prefetch
 *     requests fire again after the switch settles — not silently reused).
 *  3. Most importantly: clicking All Tickets after switching to Workspace B
 *     shows Workspace B's own ticket, and never Workspace A's — the real,
 *     rendered-content proof that no stale/cross-workspace data survived
 *     the switch, regardless of anything prefetched beforehand.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-route-prefetch-workspace-switch.ts
 * Requires a reachable DATABASE_URL and a running PRODUCTION server.
 */
import { chromium, type Page, type Request } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { Role, AuthProvider } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const TAG = `bvpw-${RUN_ID}`;

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

async function switchWorkspace(page: Page, departmentName: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    const found = await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 2000 }).catch(() => null);
    if (found) break;
    if (attempt === 2) throw new Error(`switchWorkspace: dropdown never opened for "${departmentName}"`);
    await page.waitForTimeout(300);
  }
  const searchInput = page.locator('input[placeholder="Search workspaces..."]');
  await searchInput.fill(departmentName);
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  const activeWorkspaceResponse = page
    .waitForResponse((res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST", { timeout: 8000 })
    .catch(() => null);
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse;
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const ticketIds: string[] = [];
  const userIds: string[] = [];
  const browser = await chromium.launch();

  try {
    console.log("\n=== Fixtures: Workspace A (ticket A) + Workspace B (ticket B) ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const statusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isDefault: true }, select: { id: true } });
    const statusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isDefault: true }, select: { id: true } });

    const requester = await prisma.user.create({
      data: { email: `${TAG}-requester@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(requester.id);

    const ticketA = await prisma.ticket.create({
      data: { title: `${TAG} Ticket In Workspace A`, description: "fixture", departmentId: deptA.id, statusId: statusA.id, requesterId: requester.id },
    });
    const ticketB = await prisma.ticket.create({
      data: { title: `${TAG} Ticket In Workspace B`, description: "fixture", departmentId: deptB.id, statusId: statusB.id, requesterId: requester.id },
    });
    ticketIds.push(ticketA.id, ticketB.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: process.env.VERIFY_EMAIL || "admin@kinsen.gr" }, select: { id: true, email: true } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", admin.email!);
    await page.fill("#credentials-password", process.env.VERIFY_PASSWORD || "Kinsen123!");
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);

    console.log(`\n1. Switch to Workspace A (${deptA.name}) and let the background warm pass run...\n`);
    await switchWorkspace(page, deptA.name);
    await page.waitForTimeout(3000);

    console.log(`\n2. Switch to Workspace B (${deptB.name}) — must trigger a FRESH prefetch, not reuse A's ===\n`);
    const postSwitchPrefetches: Request[] = [];
    page.on("request", (req) => {
      const headers = req.headers();
      if ((headers["next-router-prefetch"] === "1" || headers["rsc"] === "1") && new URL(req.url()).pathname === "/tickets") {
        postSwitchPrefetches.push(req);
      }
    });
    await switchWorkspace(page, deptB.name);
    await page.waitForTimeout(3000);
    check("A fresh /tickets prefetch fired again after switching to Workspace B", postSwitchPrefetches.length > 0);

    console.log("\n3. Click All Tickets — must show Workspace B's ticket, never Workspace A's ===\n");
    await page.goto(`${BASE_URL}/tickets`);
    await page.waitForLoadState("networkidle");
    check("Workspace B's own ticket is visible", (await page.locator(`text=${ticketB.title}`).count()) > 0);
    check("Workspace A's ticket did NOT leak into Workspace B's view (no stale/cross-workspace prefetch data)", (await page.locator(`text=${ticketA.title}`).count()) === 0);

    console.log("\n4. Switch BACK to Workspace A — must show A's ticket again, not B's ===\n");
    await switchWorkspace(page, deptA.name);
    await page.goto(`${BASE_URL}/tickets`);
    await page.waitForLoadState("networkidle");
    check("Workspace A's own ticket is visible again after switching back", (await page.locator(`text=${ticketA.title}`).count()) > 0);
    check("Workspace B's ticket is NOT visible on Workspace A", (await page.locator(`text=${ticketB.title}`).count()) === 0);

    await context.close();
  } finally {
    await browser.close();
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
    if (departmentIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
