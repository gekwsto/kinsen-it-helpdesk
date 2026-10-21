/**
 * Regression coverage for the SSR/client hydration mismatch fix in
 * components/project-requests/approval-actions.tsx and
 * intermediate-approval-actions.tsx: both are Client Components that
 * rendered `someDate.toLocaleString()` with no explicit locale — formatting
 * using the SERVER's default locale during SSR and the BROWSER's own locale
 * on the client, the exact same class of bug fixed in
 * project-request-table.tsx (see
 * scripts/browser-verify-project-request-date-hydration.ts). Fixed by
 * switching both to the app's existing `formatDateTime()` helper
 * (lib/utils.ts, date-fns `format(date, "dd MMM yyyy HH:mm")`), which uses
 * its own bundled locale data and is therefore identical in SSR and in
 * every browser, regardless of OS/browser locale.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-approval-date-hydration.ts
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
  // Both day > 12 and a non-midnight time so MM/DD vs DD/MM AND 12h vs 24h
  // formatting would always have rendered different text under the old,
  // buggy implementation.
  const DECIDED_AT = new Date("2026-03-20T14:30:00.000Z");
  const APPROVED_AT = new Date("2026-03-21T16:45:00.000Z");

  const fixture = await prisma.projectRequest.create({
    data: {
      title: "Approval-date-hydration regression fixture request",
      description: "x",
      importance: 2,
      teamConcerned: "QA",
      expectedBenefits: "x",
      requesterId: admin.id,
      departmentId: dept.id,
      status: "APPROVED",
      approverId: admin.id,
      approvedAt: APPROVED_AT,
      businessAssessment: "Approved for regression testing.",
      intermediateApprovers: {
        create: { approverId: admin.id, status: "APPROVED", decidedAt: DECIDED_AT, businessAssessment: null },
      },
    },
    select: { id: true },
  });

  const browser = await chromium.launch();
  const renderedByLocale: Record<string, { approved: string | null; decided: string | null }> = {};

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

      for (let i = 0; i < 5; i++) {
        if (i % 2 === 0) {
          await page.goto(`${BASE}/project-requests/${fixture.id}`, { waitUntil: "domcontentloaded" });
        } else {
          await page.reload({ waitUntil: "domcontentloaded" });
        }
        await page.waitForTimeout(500);
      }

      check(`[${locale}] no hydration mismatch pageerror on the Project Request detail page (5 loads)`, hydrationErrors.length === 0);
      check(`[${locale}] no hydration mismatch console error on the Project Request detail page (5 loads)`, consoleErrors.length === 0);
      if (hydrationErrors.length) console.log(`  [${locale}] pageerror:`, hydrationErrors[0].slice(0, 300));
      if (consoleErrors.length) console.log(`  [${locale}] console:`, consoleErrors[0].slice(0, 300));

      const texts = await page.evaluate(() => {
        const approvedP = Array.from(document.querySelectorAll("p")).find((p) => p.textContent?.includes("Approved by"));
        const approvedTimestamp = approvedP?.nextElementSibling?.textContent?.trim() ?? null;
        const decidedP = Array.from(document.querySelectorAll("p")).find((p) => p.className.includes("mt-0.5") && /\d{4}/.test(p.textContent || ""));
        return { approved: approvedTimestamp, decided: decidedP?.textContent?.trim() ?? null };
      });
      renderedByLocale[locale] = texts;
      check(`[${locale}] "Approved by" timestamp rendered ("${texts.approved}")`, !!texts.approved);
      check(`[${locale}] intermediate approver decision timestamp rendered ("${texts.decided}")`, !!texts.decided);

      await context.close();
    }

    check(
      `"Approved by" timestamp is IDENTICAL under en-US and en-GB (en-US="${renderedByLocale["en-US"]?.approved}", en-GB="${renderedByLocale["en-GB"]?.approved}")`,
      !!renderedByLocale["en-US"]?.approved && renderedByLocale["en-US"]?.approved === renderedByLocale["en-GB"]?.approved
    );
    check(
      `Intermediate approver decision timestamp is IDENTICAL under en-US and en-GB (en-US="${renderedByLocale["en-US"]?.decided}", en-GB="${renderedByLocale["en-GB"]?.decided}")`,
      !!renderedByLocale["en-US"]?.decided && renderedByLocale["en-US"]?.decided === renderedByLocale["en-GB"]?.decided
    );
    check(
      `"Approved by" timestamp matches the app's formatDateTime convention (dd MMM yyyy HH:mm)`,
      /^\d{2} \w{3} \d{4} \d{2}:\d{2}$/.test(renderedByLocale["en-US"]?.approved ?? "")
    );
    check(
      `Intermediate approver decision timestamp matches the app's formatDateTime convention (dd MMM yyyy HH:mm)`,
      /^\d{2} \w{3} \d{4} \d{2}:\d{2}$/.test(renderedByLocale["en-US"]?.decided ?? "")
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
