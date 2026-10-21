/**
 * Regression coverage for the SSR/client hydration mismatch fix in
 * components/project-requests/project-request-table.tsx: the "Submitted"
 * column used `r.submittedAt.toLocaleDateString()` with no explicit locale,
 * which formats using the SERVER's default locale during SSR and the
 * BROWSER's own locale on the client — producing different text (e.g.
 * "10/20/2026" vs "20/10/2026") whenever the two disagree, which React
 * reports as a hydration mismatch and recovers from by regenerating the
 * whole document tree (see the theme-flash investigation this fix followed
 * from). Fixed by switching to the app's existing `formatDate()` helper
 * (lib/utils.ts, date-fns `format(date, "dd MMM yyyy")`), which uses its own
 * bundled locale data and is therefore identical in SSR and in every
 * browser, regardless of OS/browser locale — the same convention already
 * used for this exact kind of "Submitted/Created" date-only table column
 * elsewhere (e.g. components/projects/project-list.tsx).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-date-hydration.ts
 * Requires a reachable DATABASE_URL and a running dev server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.log("FAIL:", label);
  }
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#credentials-email", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);
  await page.fill("#credentials-email", "admin@kinsen.gr");
  await page.fill("#credentials-password", "Kinsen123!");
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const dept = await prisma.department.findFirstOrThrow({ select: { id: true } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
  // Day > 12 so MM/DD/YYYY and DD/MM/YYYY would always have rendered
  // different text under the old, buggy implementation.
  const SUBMITTED_AT = new Date("2026-03-20T12:00:00.000Z");
  const fixture = await prisma.projectRequest.create({
    data: {
      title: "Date-hydration regression fixture request",
      description: "x",
      importance: 2,
      teamConcerned: "QA",
      expectedBenefits: "x",
      requesterId: admin.id,
      departmentId: dept.id,
      submittedAt: SUBMITTED_AT,
    },
    select: { id: true },
  });

  const browser = await chromium.launch();
  const renderedByLocale: Record<string, string | null> = {};

  try {
    for (const locale of ["en-US", "en-GB"] as const) {
      const context = await browser.newContext({ locale });
      const page = await context.newPage();
      const hydrationErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => {
        if (/[Hh]ydration/.test(err.message)) hydrationErrors.push(err.message);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error" && /[Hh]ydration/.test(msg.text())) consoleErrors.push(msg.text());
      });

      await login(page);

      // Load the list page 5 times (reload + fresh navigation) — the
      // mismatch, when present, is deterministic per request but we exercise
      // both navigation paths real users hit (full reload, direct nav).
      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) {
          await page.goto(`${BASE}/project-requests`, { waitUntil: "domcontentloaded" });
        } else {
          await page.reload({ waitUntil: "domcontentloaded" });
        }
        await page.waitForTimeout(500);
      }

      check(`[${locale}] no hydration mismatch pageerror on /project-requests (5 loads)`, hydrationErrors.length === 0);
      check(`[${locale}] no hydration mismatch console error on /project-requests (5 loads)`, consoleErrors.length === 0);
      if (hydrationErrors.length) console.log(`  [${locale}] pageerror:`, hydrationErrors[0].slice(0, 300));
      if (consoleErrors.length) console.log(`  [${locale}] console:`, consoleErrors[0].slice(0, 300));

      const cellText = await page.evaluate((title: string) => {
        const row = Array.from(document.querySelectorAll("tr")).find((r) => r.textContent?.includes(title));
        const cells = row ? Array.from(row.querySelectorAll("td")) : [];
        // Submitted is the 6th column (Title, Type, Department, Requester,
        // Status, Submitted, Actions) per project-request-table.tsx's header.
        return cells[5]?.textContent?.trim() ?? null;
      }, fixture.id ? "Date-hydration regression fixture request" : "");
      renderedByLocale[locale] = cellText;
      check(`[${locale}] Submitted column rendered a date string ("${cellText}")`, !!cellText);

      await context.close();
    }

    check(
      `Submitted date text is IDENTICAL under en-US and en-GB (en-US="${renderedByLocale["en-US"]}", en-GB="${renderedByLocale["en-GB"]}")`,
      !!renderedByLocale["en-US"] && renderedByLocale["en-US"] === renderedByLocale["en-GB"]
    );
    check(
      `Submitted date text matches the app's existing dd MMM yyyy convention ("20 Mar 2026")`,
      renderedByLocale["en-US"] === "20 Mar 2026"
    );
  } finally {
    await browser.close();
    await prisma.projectRequest.delete({ where: { id: fixture.id } }).catch(() => {});
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
