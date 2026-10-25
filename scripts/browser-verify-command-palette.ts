/**
 * Live browser verification for the global Command Palette (⌘K / Ctrl+K):
 * open via keyboard shortcut and via the Topbar button, debounced search
 * returning real fixture tickets/projects, keyboard-free click navigation,
 * Escape to close, and department-scoped authorization (a user with no
 * access to a department never sees its tickets in palette results, even
 * though the palette searches across the caller's FULL accessible union,
 * not just the active workspace).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-command-palette.ts
 * Requires a reachable DATABASE_URL and a running dev server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.log("FAIL:", label);
  }
}

async function loginAs(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#credentials-email", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const dept = await createDepartment({ name: `CmdK Dept ${RUN_ID}`, slug: `cmdk-${RUN_ID}` });
  const defaultStatus = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@kinsen.gr" } });

  const bcrypt = await import("bcryptjs");
  const OUTSIDER_PASSWORD = "Outsider123!";
  const outsider = await prisma.user.create({
    data: {
      email: `cmdk-outsider-${RUN_ID}@kinsen.gr`,
      name: "CmdK Outsider",
      authProvider: AuthProvider.CREDENTIALS,
      isActive: true,
      role: Role.USER,
      passwordHash: await bcrypt.hash(OUTSIDER_PASSWORD, 10),
    },
  });

  const ticket = await prisma.ticket.create({
    data: {
      title: `CmdK unique fixture ticket ${RUN_ID}`,
      description: "x",
      requesterId: admin.id,
      departmentId: dept.id,
      statusId: defaultStatus.id,
    },
  });
  const project = await prisma.project.create({
    data: { title: `CmdK unique fixture project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id },
  });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, "admin@kinsen.gr", process.env.ADMIN_PASSWORD || "Kinsen123!");

    // 1. Keyboard shortcut opens it, from an arbitrary authenticated page.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await page.keyboard.press("Meta+K").catch(() => {});
    await page.keyboard.press("Control+K").catch(() => {});
    const dialogVisible = await page.isVisible('[role="dialog"]');
    check("⌘K/Ctrl+K opens the palette", dialogVisible);

    // Quick actions visible with an empty query.
    check("Quick actions visible on empty query", await page.isVisible("text=New Ticket"));

    // 2. Typing the fixture ticket's title returns it.
    await page.fill('input[cmdk-input=""], input[type="text"]', `fixture ticket ${RUN_ID}`);
    await page.waitForTimeout(1200);
    const ticketResultVisible = await page.isVisible(`text=${ticket.title}`);
    check("Search returns the fixture ticket by title", ticketResultVisible);

    // 3. Clicking the result navigates and closes the dialog.
    await page.click(`text=${ticket.title}`);
    await page.waitForURL((url) => url.pathname === `/tickets/${ticket.id}`, { timeout: 10000 });
    await page.waitForTimeout(400);
    check("Clicking a ticket result navigates to its detail page", page.url().includes(`/tickets/${ticket.id}`));
    check("Dialog closes after navigating", !(await page.isVisible('[role="dialog"]')));

    // 4. Project search.
    await page.keyboard.press("Meta+K").catch(() => {});
    await page.keyboard.press("Control+K").catch(() => {});
    await page.waitForTimeout(300);
    await page.fill('input[cmdk-input=""], input[type="text"]', `fixture project ${RUN_ID}`);
    await page.waitForTimeout(1200);
    check("Search returns the fixture project by title", await page.isVisible(`text=${project.title}`));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Escape closes the palette", !(await page.isVisible('[role="dialog"]')));

    // 5. Topbar trigger button opens the same instance.
    await page.click('button[aria-label="Search tickets and projects"]');
    await page.waitForTimeout(200);
    check("Topbar trigger button opens the palette", await page.isVisible('[role="dialog"]'));
    await page.keyboard.press("Escape");

    await context.close();

    // 6. Scoping: an outsider with no membership anywhere never sees the fixture ticket/project.
    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    await loginAs(outsiderPage, outsider.email, OUTSIDER_PASSWORD);
    await outsiderPage.keyboard.press("Meta+K").catch(() => {});
    await outsiderPage.keyboard.press("Control+K").catch(() => {});
    await outsiderPage.waitForTimeout(300);
    await outsiderPage.fill('input[cmdk-input=""], input[type="text"]', `fixture ticket ${RUN_ID}`);
    await outsiderPage.waitForTimeout(1200);
    check(
      "A user with no access to the fixture's department sees no results for it",
      !(await outsiderPage.isVisible(`text=${ticket.title}`))
    );
    check("...and sees the 'no results' empty state instead", await outsiderPage.isVisible(`text=No tickets or projects match`));
    await outsiderContext.close();
  } finally {
    await browser.close();
    await prisma.ticket.deleteMany({ where: { id: ticket.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: project.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: outsider.id } }).catch(() => {});
    await prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketCategory.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: dept.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(" -", f));
    process.exit(1);
  }
}

main();
