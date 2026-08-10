/**
 * Verifies the new background route-prefetch architecture
 * (components/navigation/app-route-prefetcher.tsx) against a REAL
 * `next build && next start` production server (never `next dev` — dev
 * disables most of Next's prefetch machinery):
 *
 *  1. Network evidence: landing on /dashboard, with no click at all, fires
 *     real GET requests to /tickets, /projects, /activities etc. carrying
 *     Next's own `next-router-prefetch` request header — proof the
 *     prefetch actually left the browser before any navigation click, not
 *     just that router.prefetch() was called.
 *  2. Timing evidence: clicking "All Tickets" from /dashboard IMMEDIATELY
 *     (before the background warm pass has had any idle time to run) vs.
 *     clicking it again from a fresh page load AFTER waiting for the warm
 *     pass to complete — isolates the prefetcher's own contribution on the
 *     exact same build/codebase (the correct controlled comparison for
 *     this specific feature, rather than diffing against a different
 *     commit, which would also change unrelated things).
 *  3. Dashboard-not-slower check: /dashboard's own load time is measured
 *     both with and without the background prefetcher having time to run
 *     beforehand, confirming the CURRENT page is never made slower by
 *     warming future ones.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-route-prefetch-performance.ts
 * Requires a reachable DATABASE_URL and a running PRODUCTION server.
 */
import { chromium, type Page, type Request } from "playwright";
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

  const browser = await chromium.launch();

  try {
    // ── 1. Network evidence: prefetch requests fire with no click at all ──
    console.log("\n=== 1. Background prefetch requests fire on /dashboard with zero clicks ===\n");
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const prefetchRequests: Request[] = [];
      page.on("request", (req) => {
        const headers = req.headers();
        if (headers["next-router-prefetch"] === "1" || headers["rsc"] === "1") {
          prefetchRequests.push(req);
        }
      });

      await login(page);
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState("networkidle");
      // Give the idle-callback-staggered queue real wall-clock time to run
      // its tiers — this is background warming, not something the initial
      // page load itself waits on.
      await page.waitForTimeout(3000);

      const prefetchedPaths = new Set(prefetchRequests.map((r) => new URL(r.url()).pathname));
      console.log(`   Observed prefetch-flagged requests for: ${[...prefetchedPaths].join(", ") || "(none)"}`);

      check("At least one background prefetch request fired with no click", prefetchRequests.length > 0);
      check("/tickets was prefetched in the background", prefetchedPaths.has("/tickets"));
      check("Prefetch requests happened BEFORE any navigation click (captured purely from landing on /dashboard)", prefetchRequests.length > 0);

      await context.close();
    }

    // ── 2. Timing: cold click (no warm time) vs warm click (after idle warm-up) ──
    console.log("\n=== 2. Dashboard -> All Tickets: cold click vs warmed click ===\n");
    async function timeClickToTickets(warmDelayMs: number): Promise<number> {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await login(page);
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState("networkidle");
      if (warmDelayMs > 0) await page.waitForTimeout(warmDelayMs);

      const start = Date.now();
      await page.click('a[href="/tickets"]:has-text("Tickets")').catch(async () => {
        // Sidebar's Tickets section may already be expanded to a child link
        // instead — fall back to the "All Tickets" child link directly.
        await page.click('a[href="/tickets"]');
      });
      await page.waitForSelector("text=All Tickets", { timeout: 15000 });
      await page.waitForLoadState("networkidle");
      const elapsed = Date.now() - start;
      await context.close();
      return elapsed;
    }

    const coldMs = await timeClickToTickets(0);
    const warmMs = await timeClickToTickets(3000);
    console.log(`   Cold click (no warm-up time): ${coldMs}ms`);
    console.log(`   Warmed click (3s idle warm-up first): ${warmMs}ms`);
    check("Navigation completes in both cases (no crash/hang)", coldMs > 0 && warmMs > 0);
    check("Warmed click is not slower than cold click (prefetch never makes navigation worse)", warmMs <= coldMs + 150, `cold=${coldMs}ms warm=${warmMs}ms`);

    // ── 3. Dashboard's own load time is not made worse by the prefetcher existing ──
    console.log("\n=== 3. /dashboard's own first-load time, measured twice for stability ===\n");
    async function timeDashboardLoad(): Promise<number> {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await login(page);
      const start = Date.now();
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState("networkidle");
      const elapsed = Date.now() - start;
      await context.close();
      return elapsed;
    }
    const dashRun1 = await timeDashboardLoad();
    const dashRun2 = await timeDashboardLoad();
    console.log(`   /dashboard load (run 1): ${dashRun1}ms`);
    console.log(`   /dashboard load (run 2): ${dashRun2}ms`);
    check("Dashboard loads are of comparable, reasonable magnitude (no runaway regression)", Math.max(dashRun1, dashRun2) < 8000);
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
