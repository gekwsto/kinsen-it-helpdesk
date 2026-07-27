/**
 * Real interactive browser verification for the Microsoft profile-photo
 * sync fix — the UI-rendering side (steps 7-9 of the request): does the
 * synced/protected `User.image` actually show up correctly in the header,
 * the admin Users page, and an assigned-user (ticket requester) avatar, and
 * does it survive a full page refresh with zero console/network errors.
 *
 * IMPORTANT SCOPE NOTE: a real interactive Microsoft OAuth sign-in cannot be
 * automated in this environment — it requires a real Entra tenant + a real
 * Microsoft test account and a live browser consent redirect to
 * login.microsoftonline.com, none of which exist here (this repo's .env
 * has placeholder/dummy Azure credentials — see the earlier Microsoft/Entra
 * audit). The actual sync LOGIC (create vs existing user, manual-avatar
 * protection, 404/401/403/timeout/500 handling, ETag skip, the race guard,
 * duplicate-callback idempotency) is exhaustively covered instead by
 * scripts/test-microsoft-profile-photo-sync.ts, which calls the real
 * syncMicrosoftProfilePhoto/handleMicrosoftJwtSignIn functions against a
 * real database with only the Graph `fetch()` call mocked — the correct and
 * standard way to test this without live Azure access.
 *
 * This script instead seeds two throwaway CREDENTIALS-auth users directly
 * via Prisma with `image`/`avatarSource` already set (i.e. the END STATE a
 * Microsoft login — new or existing — would have produced), then verifies
 * the RENDERING pipeline: logs in via the real credentials form (the only
 * interactive login flow that can be automated here), and checks every
 * consumer surface actually displays the right photo for the right user.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-microsoft-photo-sync.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { AuthProvider, AvatarSource } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TEST_PASSWORD = "PhotoSyncTest123!";

// Freshly generated (not hand-typed) minimal valid 1x1 PNGs — real IHDR/IDAT/
// IEND chunks with correct CRC32s, verified to actually decode
// (naturalWidth/naturalHeight === 1) in a real Chromium page before being
// hardcoded here, so a rendered-image check is meaningful and not just a DOM
// string match against possibly-corrupt image bytes.
const RED_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

// A realistic-sized (not 1x1) fake Microsoft photo, purely for the
// cookie-size measurement below — doesn't need to be a valid/renderable
// image, only needs to occupy the same amount of `User.image` storage a
// real ~2KB 48x48 Graph photo would (see scripts/measure-jwt-cookie-size.ts,
// which found this is roughly the point a still-embedded photo would have
// forced Auth.js to chunk the session cookie, before the fix).
const REALISTIC_PHOTO_DATA_URI = `data:image/jpeg;base64,${crypto.randomBytes(2048).toString("base64")}`;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function attachConsoleAndNetworkCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenignAbortedPrefetch = isAborted && req.url().includes("_rsc=");
    const isBenignAbortedNotificationPoll = isAborted && req.url().includes("/api/notifications") && req.method() === "GET";
    if (!isBenignAbortedPrefetch && !isBenignAbortedNotificationPoll) {
      failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    }
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function loginAsCredentials(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

/** Returns [src, naturalWidth, naturalHeight] for the FIRST <img> whose src starts with the given data URI prefix, or null if not found/not loaded. */
async function findRenderedImage(page: Page, srcPrefix: string): Promise<{ src: string; naturalWidth: number; naturalHeight: number } | null> {
  return page.evaluate((prefix) => {
    const imgs = Array.from(document.querySelectorAll("img"));
    const match = imgs.find((img) => img.getAttribute("src")?.startsWith(prefix));
    if (!match) return null;
    return { src: match.getAttribute("src") || "", naturalWidth: match.naturalWidth, naturalHeight: match.naturalHeight };
  }, srcPrefix);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let photoUserId: string | undefined;
  let manualUserId: string | undefined;
  let cookieSizeUserId: string | undefined;
  let ticketId: string | undefined;

  try {
    console.log("\nSeeding throwaway users directly via Prisma — one with a MICROSOFT-sourced photo (the end state a Microsoft login produces), one with a MANUAL-protected photo, one with a realistic ~2KB photo for the cookie-size measurement...\n");
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);

    const photoUser = await prisma.user.create({
      data: {
        email: `test-photo-render-${RUN_ID}@kinsen.gr`,
        name: `Photo Sync Test ${RUN_ID}`,
        authProvider: AuthProvider.CREDENTIALS,
        passwordHash,
        image: RED_PIXEL_PNG,
        avatarSource: AvatarSource.MICROSOFT,
        microsoftPhotoEtag: '"test-etag"',
        microsoftPhotoUpdatedAt: new Date(),
      },
    });
    photoUserId = photoUser.id;

    const cookieSizeUser = await prisma.user.create({
      data: {
        email: `test-cookie-size-${RUN_ID}@kinsen.gr`,
        name: `Cookie Size Test ${RUN_ID}`,
        authProvider: AuthProvider.CREDENTIALS,
        passwordHash,
        image: REALISTIC_PHOTO_DATA_URI,
        avatarSource: AvatarSource.MICROSOFT,
      },
    });
    cookieSizeUserId = cookieSizeUser.id;

    const manualUser = await prisma.user.create({
      data: {
        email: `test-manual-avatar-${RUN_ID}@kinsen.gr`,
        name: `Manual Avatar Test ${RUN_ID}`,
        authProvider: AuthProvider.CREDENTIALS,
        passwordHash,
        image: BLUE_PIXEL_PNG,
        avatarSource: AvatarSource.MANUAL,
      },
    });
    manualUserId = manualUser.id;

    const itDefaultStatus = await prisma.ticketStatus.findFirst({ where: { departmentId: "dept-it", isDefault: true, isActive: true } });
    if (itDefaultStatus) {
      const ticket = await prisma.ticket.create({
        data: {
          title: `PWCHECK Photo Sync Ticket ${RUN_ID}`,
          description: "Verifies the requester avatar renders the synced Microsoft photo.",
          requesterId: photoUser.id,
          departmentId: "dept-it",
          statusId: itDefaultStatus.id,
        },
      });
      ticketId = ticket.id;
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachConsoleAndNetworkCapture(page, consoleErrors, failedRequests);

    // ── 1. Log in as the MICROSOFT-sourced-photo user, check the header ──
    console.log("\nLogging in as the Microsoft-photo test user via the real credentials form...\n");
    await loginAsCredentials(page, photoUser.email, TEST_PASSWORD);
    check("Login redirected away from /login", !page.url().includes("/login"));

    await page.waitForLoadState("networkidle");
    const headerImage = await findRenderedImage(page, RED_PIXEL_PNG);
    check("Topbar/header shows the synced Microsoft photo (matching src)", headerImage !== null);
    check("The header photo actually decoded/rendered (naturalWidth > 0)", (headerImage?.naturalWidth ?? 0) > 0);

    // ── 2. Full refresh — persistence check ──
    console.log("\nFull page refresh — confirming the photo persists (not a stale/initials fallback)...\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    const headerImageAfterRefresh = await findRenderedImage(page, RED_PIXEL_PNG);
    check("Photo still shows the SAME Microsoft photo after a full refresh", headerImageAfterRefresh !== null && (headerImageAfterRefresh.naturalWidth ?? 0) > 0);

    // ── 2b. REAL Set-Cookie / Cookie header size measurement (production-safety follow-up) ──
    // Logs in as a user with a realistic ~2KB Microsoft photo (see
    // scripts/measure-jwt-cookie-size.ts — this is roughly where an embedded
    // photo would have forced Auth.js to chunk the cookie, before the fix)
    // and captures the ACTUAL Set-Cookie response headers and the ACTUAL
    // Cookie request header sent on the next navigation, from the real
    // running server — not a synthetic encode() calculation.
    console.log("\nMeasuring REAL Set-Cookie/Cookie header sizes for a user with a realistic ~2KB photo...\n");
    const cookieContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cookiePage = await cookieContext.newPage();
    attachConsoleAndNetworkCapture(cookiePage, consoleErrors, failedRequests);

    let maxSetCookieHeaderBytes = 0;
    let sessionCookieChunkCount = 0;
    cookiePage.on("response", (res) => {
      void res.headersArray().then((headers) => {
        const setCookieHeaders = headers.filter((h) => h.name.toLowerCase() === "set-cookie");
        for (const h of setCookieHeaders) {
          maxSetCookieHeaderBytes = Math.max(maxSetCookieHeaderBytes, Buffer.byteLength(h.value, "utf8"));
          if (/session-token/i.test(h.value)) sessionCookieChunkCount++;
        }
      });
    });

    await loginAsCredentials(cookiePage, cookieSizeUser.email, TEST_PASSWORD);
    check("Cookie-size test user login succeeded", !cookiePage.url().includes("/login"));
    await cookiePage.waitForTimeout(300); // lets the async headersArray() promises above settle before we read the aggregated values

    const cookies = await cookieContext.cookies();
    const sessionCookies = cookies.filter((c) => /session-token/i.test(c.name));
    const totalSessionCookieBytes = sessionCookies.reduce((sum, c) => sum + Buffer.byteLength(c.value, "utf8"), 0);
    const totalCookieJarBytes = cookies.reduce((sum, c) => sum + Buffer.byteLength(c.name, "utf8") + Buffer.byteLength(c.value, "utf8"), 0);

    console.log(`  Session cookie chunk count:        ${sessionCookies.length} (names: ${sessionCookies.map((c) => c.name).join(", ") || "none"})`);
    console.log(`  Total session cookie value bytes:  ${totalSessionCookieBytes}`);
    console.log(`  Largest single Set-Cookie header:  ${maxSetCookieHeaderBytes} bytes`);
    console.log(`  Total cookie jar (all cookies):    ${totalCookieJarBytes} bytes`);

    check("Session cookie is NOT chunked (exactly 1 session-token cookie, not .0/.1/.2)", sessionCookies.length === 1);
    check("Session cookie stays well under the 4096B single-cookie limit", totalSessionCookieBytes < 4096);
    check("Session cookie size is independent of the user's photo size (this user has a ~2KB photo)", totalSessionCookieBytes < 1200);

    await cookieContext.close();

    // ── 3./4./5. Admin session (fresh browser context — avoids relying on
    // a GET-based /api/auth/signout, which Auth.js doesn't treat as a real
    // sign-out anyway) ──
    console.log("\nLogging in as admin in a FRESH browser context, checking the Users admin page shows the correct photo for each user...\n");
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    attachConsoleAndNetworkCapture(adminPage, consoleErrors, failedRequests);
    await loginAsCredentials(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    check("Admin login redirected away from /login", !adminPage.url().includes("/login"));

    await adminPage.goto(`${BASE_URL}/admin/users`);
    await adminPage.waitForLoadState("networkidle");
    const searchBox = adminPage.locator('input[placeholder*="Search" i]').first();
    if (await searchBox.count() > 0) {
      await searchBox.fill(photoUser.email);
      await adminPage.waitForTimeout(400);
    }
    const usersPageImage = await findRenderedImage(adminPage, RED_PIXEL_PNG);
    check("Admin Users page shows the correct Microsoft-sourced photo for this user", usersPageImage !== null);

    // ── 4. Manual avatar is rendered correctly and distinctly (not confused with the Microsoft one) ──
    console.log("\nChecking the MANUAL-avatar test user shows THEIR distinct photo, not the Microsoft one, on the Users page...\n");
    if (await searchBox.count() > 0) {
      await searchBox.fill(manualUser.email);
      await adminPage.waitForTimeout(400);
    }
    const manualUserImage = await findRenderedImage(adminPage, BLUE_PIXEL_PNG);
    check("Manual-avatar user renders THEIR OWN distinct (blue) photo", manualUserImage !== null);
    if (await searchBox.count() > 0) await searchBox.fill("");

    // ── 5. Assigned-user (ticket requester) avatar ──
    if (ticketId) {
      console.log("\nChecking the ticket requester avatar shows the synced Microsoft photo...\n");
      await adminPage.goto(`${BASE_URL}/tickets/${ticketId}`);
      // NOT waitForLoadState("networkidle") — the ticket detail page opens a
      // persistent SSE connection (/api/tickets/[id]/stream) for live
      // updates, which counts as ongoing network activity forever and would
      // make "networkidle" hang indefinitely.
      await adminPage.waitForSelector(`text=PWCHECK Photo Sync Ticket ${RUN_ID}`, { timeout: 15000 }).catch(() => {});
      await adminPage.waitForTimeout(500);
      const ticketRequesterImage = await findRenderedImage(adminPage, RED_PIXEL_PNG);
      check("Ticket requester avatar shows the synced Microsoft photo", ticketRequesterImage !== null);
    } else {
      check("Could resolve dept-it's default status to create a verification ticket", false);
    }

    await adminContext.close();

    // ── Console/network error summary ──
    console.log("\nConsole and network error summary across the whole run...\n");
    check("Zero console errors across the entire interactive session", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the entire interactive session", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticketId ? prisma.ticket.delete({ where: { id: ticketId } }) : Promise.resolve())],
      ["users", () =>
        prisma.user.deleteMany({ where: { id: { in: [photoUserId, manualUserId, cookieSizeUserId].filter((x): x is string => !!x) } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
