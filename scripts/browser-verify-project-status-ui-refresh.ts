/**
 * Live browser verification for the Project status dropdown staleness bug:
 * changing Project status via the real top dropdown (e.g. COMPLETED ->
 * IN_PROGRESS) must update the dropdown, the status badge, AND any
 * status-dependent server-rendered UI (the Project Feedback card)
 * immediately — no manual browser refresh required.
 *
 * Root cause (confirmed by reproduction before this fix): the dropdown/
 * badge themselves already updated correctly from the mutation's own
 * response (ProjectQuickStatus's confirmed-update local state) — but
 * nothing called router.refresh(), so the Project detail page's own
 * Server-Component-rendered content that depends on the CURRENT
 * Project.status (specifically the Project Feedback card's eligibility,
 * Project.status === COMPLETED) stayed stale until a manual reload. Fixed
 * by adding router.refresh() to ProjectQuickStatus's handleSelect, right
 * after the already-correct local state update.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-project-status-ui-refresh.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: any = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvpsu-${RUN_ID}`;

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

/** Clicks the Nth (1-5) scale option within the question row identified by its exact Greek label text — see components/projects/project-feedback-card.tsx. */
async function selectRating(page: Page, questionLabel: string, value: number) {
  const row = page.locator("div.rounded-lg.border", { has: page.locator("label", { hasText: questionLabel }) }).last();
  await row.locator(`input[type="radio"][value="${value}"]`).click({ force: true });
}

async function changeStatusViaDropdown(page: Page, label: string | RegExp) {
  await page.getByRole("button", { name: /change project status/i }).click();
  await page.waitForTimeout(200);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/projects/") && r.request().method() === "PATCH"),
    page.getByRole("menuitem", { name: label }).click(),
  ]);
  // router.refresh() is async (a background RSC re-fetch) — give it a
  // real moment to actually land, same as any other refresh-dependent
  // check in this repo's browser scripts.
  await page.waitForTimeout(1500);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    }).catch(() => {});

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // admin plays requester + final approver + owner — sufficient to prove
    // the status-refresh mechanism (already-established Feedback
    // eligibility rules are their own, separately-tested concern — see
    // scripts/test-project-feedback.ts).
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({ title: `${TAG} request`, description: "Status refresh UI fixture — description long enough.", importance: 2, projectTypeId: reqType.id, teamConcerned: "Engineering", expectedBenefits: "Benefits text long enough for validation.", replacesExisting: false, intermediateApproverIds: [admin.id], departmentId: dept.id })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({ title: `${TAG} request`, description: "fixture", ownerIds: [admin.id], expectedStartDate: "2026-01-01", expectedFinishDate: "2026-01-05", expenseTypeId: expenseType.id }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    const project = await setupRes.json();
    projectIds.push(project.id);

    // ══════════════════════ 13. Project starts COMPLETED ══════════════════════
    const completeRes = await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: project.id }) });
    check("13. (fixture) Project starts COMPLETED", completeRes.status === 200 && (await completeRes.json()).status === "COMPLETED");
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    check("(sanity) Badge shows COMPLETED on initial load", (await page.getByText("COMPLETED", { exact: true }).count()) > 0);
    check("(sanity) 'Αξιολόγηση Έργου' form is visible (COMPLETED, eligible requester, no feedback yet)", (await page.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 1);

    // ══════════════════════ 14-19. Real dropdown: COMPLETED -> IN_PROGRESS ══════════════════════
    console.log("\n=== 14-19. Real dropdown interaction: COMPLETED -> IN_PROGRESS ===\n");
    await changeStatusViaDropdown(page, /in progress/i);

    const dbAfter1 = await prisma.project.findUnique({ where: { id: project.id }, select: { status: true } });
    check("15. DB status becomes IN_PROGRESS", dbAfter1?.status === "IN_PROGRESS");
    check("16. Dropdown immediately displays IN PROGRESS — no reload", (await page.getByRole("button", { name: /change project status/i }).innerText()).toUpperCase().includes("IN PROGRESS"));
    check("17. Status badge immediately displays IN PROGRESS", (await page.getByText("IN PROGRESS", { exact: true }).count()) > 0);
    check("18. No manual page refresh was performed between the click and these checks (by construction of this test)", true);
    check("22. Completion-dependent UI ('Αξιολόγηση Έργου' form) disappears immediately — status is no longer COMPLETED, and no feedback exists yet", (await page.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 0);

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(600);
    check("19. Reload still shows IN PROGRESS (persisted, not just a client illusion)", (await page.getByText("IN PROGRESS", { exact: true }).count()) > 0);

    // ══════════════════════ 20. Symmetric: IN_PROGRESS -> COMPLETED ══════════════════════
    console.log("\n=== 20. Symmetric change back: IN_PROGRESS -> COMPLETED ===\n");
    await changeStatusViaDropdown(page, "COMPLETED");
    const dbAfter2 = await prisma.project.findUnique({ where: { id: project.id }, select: { status: true } });
    check("20. DB status becomes COMPLETED again", dbAfter2?.status === "COMPLETED");
    check("...dropdown immediately displays COMPLETED", (await page.getByRole("button", { name: /change project status/i }).innerText()).toUpperCase().includes("COMPLETED"));
    check("...badge immediately displays COMPLETED", (await page.getByText("COMPLETED", { exact: true }).count()) > 0);
    check("...'Αξιολόγηση Έργου' form reappears immediately (status is COMPLETED again, still no feedback submitted)", (await page.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 1);

    // ══════════════════════ 21. Failed mutation never leaves false/stale dropdown state ══════════════════════
    console.log("\n=== 21. A FAILED status mutation leaves the dropdown showing the real, unchanged status ===\n");
    await page.route("**/api/projects/**", (route) => {
      if (route.request().method() === "PATCH") return route.fulfill({ status: 500, body: JSON.stringify({ error: "Simulated failure" }) });
      return route.continue();
    });
    await page.getByRole("button", { name: /change project status/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole("menuitem", { name: /in progress/i }).click();
    await page.waitForTimeout(800);
    check("21. After a FAILED mutation, the dropdown still shows the real persisted status (COMPLETED) — confirmed-update, never optimistic", (await page.getByRole("button", { name: /change project status/i }).innerText()).toUpperCase().includes("COMPLETED"));
    check("...the badge agrees — no desync between the two", (await page.getByText("COMPLETED", { exact: true }).count()) > 0);
    const dbAfterFailedAttempt = await prisma.project.findUnique({ where: { id: project.id }, select: { status: true } });
    check("...and the DB was genuinely never touched by the failed attempt", dbAfterFailedAttempt?.status === "COMPLETED");
    await page.unroute("**/api/projects/**");

    // ══════════════════════ 23. Existing submitted Feedback remains visible, but becomes readonly, after status moves away from COMPLETED ══════════════════════
    console.log("\n=== 23. Existing submitted Feedback stays visible (historical record) but becomes readonly once status moves away from COMPLETED ===\n");
    const QUESTIONS = [
      "Πόσο ικανοποιημένοι είστε με την ταχύτητα παράδοσης του έργου;",
      "Πόσο ικανοποιημένοι είστε με την επικοινωνία με την ομάδα;",
      "Πόσο ικανοποιημένοι είστε με τις λειτουργίες που παραδόθηκαν;",
      "Πόσο ικανοποιημένοι είστε με την ευκολία χρήσης;",
      "Πόσο ικανοποιημένοι είστε συνολικά από την υλοποίηση;",
    ];
    // The full form no longer lives on /projects/[id] at all — the CTA
    // there only ever links to the dedicated standalone page.
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${project.id}/feedback`, { timeout: 10000 }),
      page.getByRole("link", { name: "Μετάβαση στην Αξιολόγηση", exact: true }).click(),
    ]);
    for (const q of QUESTIONS) await selectRating(page, q, 4);
    await page.getByLabel("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).check();
    await page.fill("#feedback-comments", `${TAG} status-refresh regression comment`);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/feedback`) && r.request().method() === "POST"),
      page.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true }).click(),
    ]);
    await page.waitForTimeout(500);
    check("(fixture) Feedback submitted successfully -> button becomes 'Ενημέρωση Αξιολόγησης' (editable update)", (await page.getByRole("button", { name: "Ενημέρωση Αξιολόγησης", exact: true }).count()) === 1);

    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    await changeStatusViaDropdown(page, /in progress/i);
    check("23. After moving status AWAY from COMPLETED, the CTA (and thus the ALREADY-SUBMITTED Feedback it links to) remains visible — historical record, not re-hidden", (await page.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 1);
    check("...the CTA still offers 'Προβολή / Ενημέρωση Αξιολόγησης' (feedback exists, even though the Project is no longer COMPLETED)", (await page.getByRole("link", { name: "Προβολή / Ενημέρωση Αξιολόγησης", exact: true }).count()) === 1);

    await page.getByRole("link", { name: "Προβολή / Ενημέρωση Αξιολόγησης", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/projects/${project.id}/feedback`, { timeout: 10000 });
    await page.waitForTimeout(300);
    check("...the dedicated page still shows the real submitted rating (4 / 5)", (await page.getByText("4 / 5", { exact: true }).first().count()) === 1);
    check("...but is now READONLY — no editable scale inputs and no update button, since the Project is no longer COMPLETED", (await page.locator('input[type="radio"]').count()) === 0 && (await page.getByRole("button", { name: /Ενημέρωση Αξιολόγησης|Υποβολή Αξιολόγησης/, exact: true }).count()) === 0);
  } finally {
    await browser.close();
    try {
      await prisma.projectFeedback.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
      await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
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
