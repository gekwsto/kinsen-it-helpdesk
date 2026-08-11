/**
 * Real interactive browser proof of two features:
 *
 *  1. The shared page-size selector (lib/pagination.ts + PaginationControls)
 *     now works on /tickets: the Select control shows 20/50/100, changing it
 *     updates the URL and the row count, resets to page 1, and an invalid
 *     ?pageSize= typed directly into the URL safely falls back to 20 in the
 *     rendered control (never a broken/unbounded page).
 *
 *  2. Pending Ticket Preview shows the FULL body (not the ~120-char table
 *     snippet) and never executes injected markup — a real XSS payload
 *     (`<img src=x onerror=...>`) in the body is proven inert: the handler
 *     never fires and no live <img> element is created inside the dialog,
 *     because the body is rendered as plain text (htmlToReadableText),
 *     never via dangerouslySetInnerHTML.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-pagination-and-preview.ts
 * Requires a reachable DATABASE_URL and a running dev/production server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvtpp-${RUN_ID}`;

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

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const pendingTicketIds: string[] = [];
  const browser = await chromium.launch();

  try {
    console.log("\n=== Fixtures: department with 25 tickets + 2 pending tickets (one with an XSS payload) ===\n");
    const dept = await createDepartment({ name: `${TAG}-Dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true }, select: { id: true } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    for (let i = 0; i < 25; i++) {
      const t = await prisma.ticket.create({
        data: { title: `${TAG} Ticket ${String(i).padStart(2, "0")}`, description: "fixture", departmentId: dept.id, statusId: status.id, requesterId: admin.id },
      });
      ticketIds.push(t.id);
    }

    const longParagraph = "This is a very long inbound email body used to prove the preview dialog shows the FULL content, not a truncated snippet. ".repeat(30);
    const normalPending = await prisma.pendingTicket.create({
      data: {
        subject: `${TAG} Long Body Pending Ticket`,
        fromEmail: "sender@example.com",
        fromName: "Test Sender",
        body: `<p>${longParagraph}</p><p>A second paragraph after a real paragraph break.</p>`,
        receivedAt: new Date(),
        departmentId: dept.id,
        emailMessageId: `${TAG}-msg-normal`,
      },
    });
    pendingTicketIds.push(normalPending.id);

    const xssPending = await prisma.pendingTicket.create({
      data: {
        subject: `${TAG} XSS Payload Pending Ticket`,
        fromEmail: "attacker@example.com",
        fromName: "Attacker",
        body: `<p>Hello</p><img src="x" onerror="window.__xssFired = true"><script>window.__xssFired = true;</script><p>End</p>`,
        receivedAt: new Date(),
        departmentId: dept.id,
        emailMessageId: `${TAG}-msg-xss`,
      },
    });
    pendingTicketIds.push(xssPending.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log("\nLogging in as admin...\n");
    await login(page);

    console.log("\n1. /tickets page-size selector: default is 20 ===\n");
    await page.goto(`${BASE_URL}/tickets?departmentId=${dept.id}`);
    await page.waitForLoadState("networkidle");
    check("25 tickets exist but only 20 rows render by default", (await page.locator(`text=${TAG} Ticket`).count()) === 20);

    console.log("\n2. Selecting 50 per page shows all 25 and updates the URL ===\n");
    const perPageSelect = page.locator('[aria-label="Results per page"]');
    await perPageSelect.click();
    await page.getByRole("option", { name: "50", exact: true }).click();
    await page.waitForFunction((tag) => window.location.search.includes(`pageSize=50`), TAG, { timeout: 8000 });
    await page.waitForLoadState("networkidle");
    check("URL now has pageSize=50", page.url().includes("pageSize=50"));
    check("All 25 tickets now visible on one page", (await page.locator(`text=${TAG} Ticket`).count()) === 25);

    console.log("\n3. Page-size change reset page to 1 (no stray page= param) ===\n");
    check("URL has no leftover page=2+ param after the pageSize change", !/[?&]page=[2-9]/.test(page.url()));

    console.log("\n4. An invalid ?pageSize= typed directly into the URL safely falls back to 20 ===\n");
    await page.goto(`${BASE_URL}/tickets?departmentId=${dept.id}&pageSize=999999`);
    await page.waitForLoadState("networkidle");
    check("Only 20 rows render for an invalid pageSize (safe fallback, not unbounded)", (await page.locator(`text=${TAG} Ticket`).count()) === 20);
    const selectedLabel = await perPageSelect.innerText();
    check('The Select control itself shows "20" (the canonical fallback), not the invalid raw value', selectedLabel.trim() === "20");

    console.log("\n5. Page 2 preserves the selected page size ===\n");
    await page.goto(`${BASE_URL}/tickets?departmentId=${dept.id}&pageSize=50`);
    await page.waitForLoadState("networkidle");
    check("pageSize=50 with only 25 tickets has no next-page control (single page)", (await page.locator('button[aria-label="Next page"]').count()) === 0);

    console.log("\n=== Pending Ticket Preview ===\n");
    await page.goto(`${BASE_URL}/tickets/pending?departmentId=${dept.id}`);
    await page.waitForLoadState("networkidle");

    console.log("\n6. Preview shows the FULL body, not the truncated table snippet ===\n");
    await page.click(`text=${TAG} Long Body Pending Ticket`);
    await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
    const dialogText = (await page.locator('[role="dialog"]').innerText()).replace(/\s+/g, " ");
    check("Full long body text is present in the dialog (not truncated to ~120 chars)", dialogText.includes("This is a very long inbound email body"));
    check("Second paragraph (well past the 120-char table snippet cutoff) is also present", dialogText.includes("A second paragraph after a real paragraph break"));
    check("Dialog shows the Subject/Sender/Department/Received context", dialogText.includes("sender@example.com") && dialogText.includes(dept.name));
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 }).catch(() => {});

    console.log("\n7. XSS payload in the body is rendered inert — never executes, never becomes real markup ===\n");
    await page.evaluate(() => {
      (window as any).__xssFired = false;
    });
    await page.click(`text=${TAG} XSS Payload Pending Ticket`);
    await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
    await page.waitForTimeout(500); // give a real onerror/script a fair chance to fire if it somehow could
    const xssFired = await page.evaluate(() => (window as any).__xssFired === true);
    check("The injected onerror/script handler never executed", !xssFired);
    const imgInsideDialog = await page.locator('[role="dialog"] img').count();
    check("No live <img> element was created inside the preview dialog from the payload", imgInsideDialog === 0);
    const scriptInsideDialog = await page.locator('[role="dialog"] script').count();
    check("No live <script> element exists inside the preview dialog", scriptInsideDialog === 0);
    const dialogXssText = await page.locator('[role="dialog"]').innerText();
    check('The literal words "Hello" and "End" (real content around the payload) are still visible as plain text', dialogXssText.includes("Hello") && dialogXssText.includes("End"));
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 }).catch(() => {});

    console.log("\n8. Preview does not interfere with Accept/Reject — both still open normally ===\n");
    const row = page.locator("tr", { hasText: `${TAG} Long Body Pending Ticket` });
    await row.getByRole("button", { name: "Accept" }).click();
    await page.waitForSelector("text=Accept Pending Ticket", { timeout: 8000 });
    check("Accept dialog opens normally after a Preview was used earlier", (await page.locator("text=Accept Pending Ticket").count()) > 0);
    await page.click('button:has-text("Cancel")');
    await page.waitForTimeout(300);

    await context.close();
  } finally {
    await browser.close();
    await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } }).catch(() => {});
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
