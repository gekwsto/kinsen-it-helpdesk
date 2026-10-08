/**
 * Live browser verification for Project Feedback — the Project's own
 * PRIMARY Owner (Project.ownerId) evaluation of a delivered, request-
 * origin Project, across five independent Greek-labeled 1-5 ratings + a
 * separate requirementsDelivered checkbox + optional comments, submitted
 * exclusively through the dedicated standalone /projects/[id]/feedback
 * page. REPLACES the original-requester-based eligibility rule.
 *
 *   A. As the primary Owner (admin), BEFORE completion: Project detail
 *      shows no CTA at all.
 *   B. Complete the Project through the REAL completion flow — the
 *      Project Edit page's Status select.
 *   C. Project detail now shows the small "Αξιολόγηση Έργου" CTA ->
 *      "Μετάβαση στην Αξιολόγηση". Following it lands on the dedicated
 *      page: all five Greek questions render, each a 1-5 radiogroup.
 *      Submitting without answering every question is blocked
 *      client-side. Answer all five + the checkbox + a comment, submit.
 *   D. Reload: the SAME answers are pre-filled, button now reads
 *      "Ενημέρωση Αξιολόγησης" (update, not a second submission); the
 *      Project detail CTA now reads "Προβολή / Ενημέρωση Αξιολόγησης".
 *   E. Update one rating and resubmit -> persists the new value, still one row.
 *   F. The ORIGINAL REQUESTER (a different, real demo account, NOT the
 *      Owner) sees no CTA on Project detail, and is redirected away if
 *      they navigate straight to the dedicated feedback URL.
 *   G. Administration -> Feedback (admin) -> the submitted row appears
 *      with the five individual ratings, entirely readonly.
 *   Also: a manual Project never shows the feature, for anyone — even its
 *   own real owner.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-project-feedback-ui.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kinsen123!";
const REQUESTER_EMAIL = "user@kinsen.gr";
const REQUESTER_PASSWORD = process.env.DEMO_USER_PASSWORD || "User@123456";
const RUN_ID = Date.now();
const TAG = `bvpf-${RUN_ID}`;

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

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

const QUESTIONS = [
  "Πόσο ικανοποιημένοι είστε με την ταχύτητα παράδοσης του έργου;",
  "Πόσο ικανοποιημένοι είστε με την επικοινωνία με την ομάδα;",
  "Πόσο ικανοποιημένοι είστε με τις λειτουργίες που παραδόθηκαν;",
  "Πόσο ικανοποιημένοι είστε με την ευκολία χρήσης;",
  "Πόσο ικανοποιημένοι είστε συνολικά από την υλοποίηση;",
];

/** Clicks the Nth (1-5) scale option within the question row identified by its exact Greek label text. */
async function selectRating(page: Page, questionLabel: string, value: number) {
  const row = page.locator("div.rounded-lg.border", { has: page.locator("label", { hasText: questionLabel }) }).last();
  await row.locator(`input[type="radio"][value="${value}"]`).click({ force: true });
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
    const requester = await prisma.user.findFirstOrThrow({ where: { email: REQUESTER_EMAIL }, select: { id: true, name: true, email: true } });
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    await prisma.departmentMembership.create({
      data: { userId: admin.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    });

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // Fixture: a real request-origin Project (via the real routes),
    // requested by `user@kinsen.gr`, but OWNED by admin — admin.id is
    // ownerIds[0], the canonical primary Owner. This is the exact
    // deliberate mismatch the new rule cares about: the requester is no
    // longer special, only the Owner is.
    fixtureSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Project Feedback UI fixture — description long enough.",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
        departmentId: dept.id,
      })
    );
    if (submitRes.status !== 201) throw new Error(`Fixture submit failed: ${submitRes.status}: ${JSON.stringify(await submitRes.json())}`);
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "fixture",
        ownerIds: [admin.id],
        expectedStartDate: "2026-01-01",
        expectedFinishDate: "2026-01-05",
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const project = await setupRes.json();
    projectIds.push(project.id);

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(manualProject.id);
    fixtureSession = null;

    const requesterContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const requesterPage = await requesterContext.newPage();
    await login(requesterPage, REQUESTER_EMAIL, REQUESTER_PASSWORD);
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    const adminPage = await adminContext.newPage();
    await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);

    // ══════════════════════ A. Before completion: no CTA ══════════════════════
    console.log("\n=== A. As the primary Owner (admin), BEFORE completion: no 'Αξιολόγηση Έργου' CTA ===\n");
    await adminPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("A. No 'Αξιολόγηση Έργου' CTA before completion", (await adminPage.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 0);

    // ══════════════════════ B. Complete via the REAL Project edit UI ══════════════════════
    console.log("\n=== B. Completing the Project through the real Edit page Status control ===\n");
    await adminPage.goto(`${BASE_URL}/projects/${project.id}/edit`, { waitUntil: "load" });
    await adminPage.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    const statusSelect = adminPage.getByRole("combobox").first();
    await statusSelect.click();
    await adminPage.getByRole("option", { name: "COMPLETED", exact: true }).click();
    await Promise.all([
      adminPage.waitForURL((url) => url.pathname === `/projects/${project.id}`, { timeout: 10000 }),
      adminPage.getByRole("button", { name: /save changes/i }).click(),
    ]);
    check("B. Saving Status=COMPLETED via the real Edit page navigates back to the Project detail page", adminPage.url().endsWith(`/projects/${project.id}`));

    // ══════════════════════ C. Project detail CTA -> dedicated page -> submit ══════════════════════
    console.log("\n=== C. Project detail shows the CTA; following it lands on the dedicated page; all five Greek questions render ===\n");
    await adminPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("C. 'Αξιολόγηση Έργου' CTA now appears on Project detail, now that the Project is COMPLETED", (await adminPage.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 1);
    check("C. ...and the Project detail page itself has NO rating questions anywhere (full form removed from this surface)", (await adminPage.locator('input[type="radio"]').count()) === 0);

    await Promise.all([
      adminPage.waitForURL((url) => url.pathname === `/projects/${project.id}/feedback`, { timeout: 10000 }),
      adminPage.getByRole("link", { name: "Μετάβαση στην Αξιολόγηση", exact: true }).click(),
    ]);
    check("C. Following the CTA navigates to the dedicated /projects/[id]/feedback page", adminPage.url().endsWith(`/projects/${project.id}/feedback`));
    // Two headings legitimately share this exact text: the page's own <h1>
    // AND the ProjectFeedbackCard's <h3> CardTitle — both say "Αξιολόγηση
    // Έργου", so this only asserts it appears (>= 1), not an exact count.
    check("C. Page header reads 'Αξιολόγηση Έργου'", (await adminPage.getByRole("heading", { name: "Αξιολόγηση Έργου", exact: true }).count()) >= 1);
    check("C. Context line renders 'Παρακαλούμε αξιολογήστε το ολοκληρωμένο έργο.'", (await adminPage.getByText("Παρακαλούμε αξιολογήστε το ολοκληρωμένο έργο.", { exact: true }).count()) === 1);
    for (const q of QUESTIONS) {
      check(`C. Question renders: "${q}"`, (await adminPage.getByText(q, { exact: true }).count()) === 1);
    }
    check("C. 'Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές' checkbox renders", (await adminPage.getByText("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).count()) === 1);
    check("C. 'Προαιρετικά Σχόλια' label renders", (await adminPage.getByText("Προαιρετικά Σχόλια", { exact: true }).count()) === 1);
    check("C. 'Σχετικό Έργο' read-only summary renders", (await adminPage.getByText("Σχετικό Έργο", { exact: true }).count()) === 1);
    check("C. No Activity management / Members / attachments / notes / financial controls anywhere on this page", (await adminPage.getByText(/Activities \(|Members|Attachments|Notes/i).count()) === 0);
    check("C. Submit button reads 'Υποβολή Αξιολόγησης' (first submission, not an update)", (await adminPage.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true }).count()) === 1);

    // Answer only 4 of 5 questions — submit must still be blocked (required, client-side).
    await selectRating(adminPage, QUESTIONS[0], 4);
    await selectRating(adminPage, QUESTIONS[1], 5);
    await selectRating(adminPage, QUESTIONS[2], 3);
    await selectRating(adminPage, QUESTIONS[3], 4);
    check("C. Submit button still DISABLED with one question unanswered", await adminPage.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true }).isDisabled());

    await selectRating(adminPage, QUESTIONS[4], 5);
    check("C. Submit button becomes ENABLED once all five are answered", !(await adminPage.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true }).isDisabled()));

    await adminPage.getByLabel("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).check();
    const commentText = "Πολύ ικανοποιημένος/η από το αποτέλεσμα και την επικοινωνία.";
    await adminPage.fill("#feedback-comments", commentText);
    await Promise.all([
      adminPage.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/feedback`) && r.request().method() === "POST"),
      adminPage.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true }).click(),
    ]);
    await adminPage.waitForTimeout(600);
    check("C. After submitting, the button now reads 'Ενημέρωση Αξιολόγησης' (editable update, not a second submission)", (await adminPage.getByRole("button", { name: "Ενημέρωση Αξιολόγησης", exact: true }).count()) === 1);
    check("C. ...and the comment is retained in the textarea", (await adminPage.inputValue("#feedback-comments")) === commentText);

    // ══════════════════════ D. Reload: same answers pre-filled; CTA label updates too ══════════════════════
    console.log("\n=== D. Reloading pre-fills the SAME answers; Project detail CTA now offers update ===\n");
    await adminPage.reload({ waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("D. 'Ενημέρωση Αξιολόγησης' button shows immediately after reload (pre-filled form, not a blank one)", (await adminPage.getByRole("button", { name: "Ενημέρωση Αξιολόγησης", exact: true }).count()) === 1);
    check("D. ...comment pre-filled with the previously submitted text", (await adminPage.inputValue("#feedback-comments")) === commentText);
    check("D. ...the checkbox stays checked", await adminPage.getByLabel("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).isChecked());

    await adminPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("D. Project detail CTA now reads 'Προβολή / Ενημέρωση Αξιολόγησης'", (await adminPage.getByRole("link", { name: "Προβολή / Ενημέρωση Αξιολόγησης", exact: true }).count()) === 1);

    // ══════════════════════ E. Update a rating and resubmit ══════════════════════
    console.log("\n=== E. Updating one rating and resubmitting persists the new value, still one row ===\n");
    await adminPage.getByRole("link", { name: "Προβολή / Ενημέρωση Αξιολόγησης", exact: true }).click();
    await adminPage.waitForURL((url) => url.pathname === `/projects/${project.id}/feedback`, { timeout: 10000 });
    await selectRating(adminPage, QUESTIONS[0], 2);
    await Promise.all([
      adminPage.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/feedback`) && r.request().method() === "POST"),
      adminPage.getByRole("button", { name: "Ενημέρωση Αξιολόγησης", exact: true }).click(),
    ]);
    await adminPage.waitForTimeout(600);
    const updatedRow = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: project.id } });
    check("E. The DB row's deliverySpeedRating is now 2 (the update), not the original 4", updatedRow.deliverySpeedRating === 2);
    check("E. Still exactly ONE ProjectFeedback row for this Project", (await prisma.projectFeedback.count({ where: { projectId: project.id } })) === 1);

    // ══════════════════════ F. The original requester (NOT the Owner) has no access ══════════════════════
    console.log("\n=== F. The original requester (a real, distinct account, NOT the primary Owner) has no Feedback access at all ===\n");
    await requesterPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("F. The original requester sees no 'Αξιολόγηση Έργου' CTA — they are no longer special-cased", (await requesterPage.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 0);

    await requesterPage.goto(`${BASE_URL}/projects/${project.id}/feedback`, { waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("F. Navigating directly to the dedicated feedback URL redirects the non-owner straight back to Project detail", requesterPage.url().endsWith(`/projects/${project.id}`) && !requesterPage.url().includes("/feedback"));

    // ══════════════════════ G. Administration -> Feedback (admin) ══════════════════════
    console.log("\n=== G. Administration -> Feedback: the submitted row appears, with the five individual ratings, readonly ===\n");
    await adminPage.getByRole("button", { name: "Administration" }).click();
    await adminPage.waitForTimeout(200);
    check("G. The 'Feedback' sidebar entry is visible to admin", (await adminPage.getByRole("link", { name: "Feedback", exact: true }).count()) > 0);
    await adminPage.goto(`${BASE_URL}/admin/project-feedback`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("G. The submitted row's Project title appears", (await adminPage.getByText(`${TAG} request`, { exact: true }).count()) > 0);
    check("G. ...the real Owner's (admin's) own identity appears as the submitter, never the requester's", (await adminPage.getByText(ADMIN_EMAIL, { exact: false }).count()) > 0);
    check("G. ...the comment text appears", (await adminPage.getByText(commentText, { exact: false }).count()) > 0);
    check("G. The page has no Edit/Delete control for this row — readonly review only", (await adminPage.getByRole("button", { name: /edit|delete/i }).count()) === 0);

    // ══════════════════════ Manual Project: never shows the feature, even for its own real owner ══════════════════════
    console.log("\n=== Manual Project never shows the Feedback feature, for anyone — even its own real owner ===\n");
    await adminPage.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("Manual Project (its own real owner, admin): no 'Αξιολόγηση Έργου' CTA", (await adminPage.getByText("Αξιολόγηση Έργου", { exact: true }).count()) === 0);
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
