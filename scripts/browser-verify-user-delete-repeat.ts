/**
 * Real interactive browser verification of the reported bug: after
 * deleting a user in Administration > Users, the Delete button stayed
 * disabled ("stuck") for the NEXT user you tried to delete, requiring a
 * full page reload — caused by components/admin/user-management.tsx's
 * handleDelete never resetting `deleting` back to false on the success
 * path (only on error), so the client component's local state stayed
 * stuck true across router.refresh() (which re-renders the Server
 * Component tree but does not reset this client component's own state).
 *
 * Proves the fix by deleting TWO users back-to-back, in the same session,
 * with no manual page reload in between.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-user-delete-repeat.ts
 * Requires a reachable DATABASE_URL and a running dev server — skips if
 * either is unavailable.
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvudr-${RUN_ID}`;

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

async function deleteUserThroughUI(page: Page, email: string): Promise<{ deleteButtonWasDisabledBeforeClick: boolean }> {
  // Open the row's edit sheet via its pencil (Edit) button, then expand the
  // collapsed "Danger Zone" <details> to reveal "Delete User".
  const row = page.locator("tr", { hasText: email }).first();
  await row.locator("button").last().click();
  await page.waitForSelector("text=Danger Zone", { timeout: 10000 });
  await page.click("text=Danger Zone");
  await page.waitForSelector('button:has-text("Delete User")', { timeout: 5000 });

  const deleteUserBtn = page.locator('button:has-text("Delete User")');
  const deleteButtonWasDisabledBeforeClick = await deleteUserBtn.isDisabled();
  await deleteUserBtn.click();

  await page.waitForSelector('button:has-text("Delete"):not(:has-text("Delete User"))', { timeout: 5000 });
  const confirmBtn = page.locator('button:has-text("Delete"):not(:has-text("Delete User"))').last();
  await confirmBtn.click();
  await page.waitForTimeout(1000);
  return { deleteButtonWasDisabledBeforeClick };
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const userIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures: two throwaway users to delete back-to-back ===\n");
    const email1 = `${TAG}-one@kinsen.gr`;
    const email2 = `${TAG}-two@kinsen.gr`;
    const user1 = await prisma.user.create({ data: { email: email1, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const user2 = await prisma.user.create({ data: { email: email2, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(user1.id, user2.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.waitForSelector("#credentials-email", { state: "visible" });
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    await page.goto(`${BASE_URL}/admin/users?search=${TAG}`);
    await page.waitForTimeout(800);
    const bodyBefore = await page.locator("body").innerText();
    check("Both throwaway users are visible before deleting", bodyBefore.includes(email1) && bodyBefore.includes(email2));

    console.log("\n=== Delete user #1 ===\n");
    const result1 = await deleteUserThroughUI(page, email1);
    check("Delete User button was NOT disabled before the first delete (clean starting state)", !result1.deleteButtonWasDisabledBeforeClick);
    const deleted1 = await prisma.user.findUnique({ where: { id: user1.id } });
    check("User #1 was actually deleted server-side", deleted1 === null);
    if (!deleted1) userIds.splice(userIds.indexOf(user1.id), 1);

    console.log("\n=== Delete user #2 — THE REGRESSION CHECK: no manual reload in between ===\n");
    const result2 = await deleteUserThroughUI(page, email2);
    check(
      "THE BUG: Delete User button for the SECOND user was NOT stuck disabled (this previously required a full page reload)",
      !result2.deleteButtonWasDisabledBeforeClick
    );
    const deleted2 = await prisma.user.findUnique({ where: { id: user2.id } });
    check("User #2 was actually deleted server-side too, with zero manual reload in between", deleted2 === null);
    if (!deleted2) userIds.splice(userIds.indexOf(user2.id), 1);

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
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
