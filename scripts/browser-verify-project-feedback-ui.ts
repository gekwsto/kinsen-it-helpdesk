/**
 * Live browser verification for Project Feedback — the ORIGINAL Project
 * Request requester's one-time evaluation of a delivered, request-origin
 * Project.
 *
 *   A. As the requester, BEFORE completion: no Feedback card at all.
 *   B. Complete the Project through the REAL completion flow — the Project
 *      Edit page's Status select (a genuine UI action, not a raw API call).
 *   C. As the requester: the Feedback card appears, select 8/10, enter a
 *      comment, submit -> a readonly result replaces the form.
 *   D. Reload: the SAME feedback remains, never a second editable form.
 *   E. Another eligible Project user (not the requester, here: the admin,
 *      who is also this Project's own owner) -> no requester form at all.
 *   F. Administration -> Feedback (an authorized/ADMIN user) -> the
 *      submitted row appears with the correct Project, requester, 8/10,
 *      and comment text, entirely readonly.
 *   Also: a manual Project never shows the feature, for anyone.
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
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
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

    // Fixture: a real request-origin Project (via the real routes), owned
    // by admin, requested by the real `user@kinsen.gr` demo account — so
    // the browser login flow has two REAL, distinct demo identities to use.
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
        projectOwnerId: admin.id,
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

    // ══════════════════════ A. Before completion: no Feedback card ══════════════════════
    const requesterContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const requesterPage = await requesterContext.newPage();
    await login(requesterPage, REQUESTER_EMAIL, REQUESTER_PASSWORD);

    console.log("\n=== A. As requester, BEFORE completion: no Feedback card ===\n");
    await requesterPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("A. No 'Project Feedback' card before completion", (await requesterPage.getByText("Project Feedback", { exact: true }).count()) === 0);
    check("A. ...and no 'Your Feedback' readonly card either, obviously", (await requesterPage.getByText("Your Feedback", { exact: true }).count()) === 0);

    // ══════════════════════ B. Complete via the REAL Project edit UI ══════════════════════
    console.log("\n=== B. Completing the Project through the real Edit page Status control ===\n");
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const adminPage = await adminContext.newPage();
    await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);

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

    // ══════════════════════ C. Submit feedback as the requester ══════════════════════
    console.log("\n=== C. As the requester: Feedback card appears, submit 8/10 + a comment ===\n");
    await requesterPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("C. 'Project Feedback' card now appears, now that the Project is COMPLETED", (await requesterPage.getByText("Project Feedback", { exact: true }).count()) === 1);

    await requesterPage.getByRole("button", { name: "8 out of 10", exact: true }).click();
    const commentText = "Very satisfied with the delivered work, great communication throughout.";
    await requesterPage.fill("#feedback-comments", commentText);
    await Promise.all([
      requesterPage.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/feedback`) && r.request().method() === "POST"),
      requesterPage.getByRole("button", { name: /submit feedback/i }).click(),
    ]);
    await requesterPage.waitForTimeout(500);
    check("C. After submitting, the readonly 'Your Feedback' card appears", (await requesterPage.getByText("Your Feedback", { exact: true }).count()) === 1);
    check("C. ...showing 'Satisfaction: 8 / 10'", (await requesterPage.getByText("Satisfaction: 8 / 10", { exact: true }).count()) === 1);
    check("C. ...and the real comment text", (await requesterPage.getByText(commentText).count()) === 1);
    check("C. ...and the form (Submit Feedback button) is GONE — no second submit action", (await requesterPage.getByRole("button", { name: /submit feedback/i }).count()) === 0);

    // ══════════════════════ D. Reload: same feedback, no second form ══════════════════════
    console.log("\n=== D. Reloading shows the SAME feedback, never a second editable form ===\n");
    await requesterPage.reload({ waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("D. 'Your Feedback' readonly card still shows after reload", (await requesterPage.getByText("Your Feedback", { exact: true }).count()) === 1);
    check("D. ...with the same rating", (await requesterPage.getByText("Satisfaction: 8 / 10", { exact: true }).count()) === 1);
    check("D. ...and still no editable form anywhere on the page", (await requesterPage.getByRole("button", { name: /submit feedback/i }).count()) === 0);

    // ══════════════════════ E. Another eligible Project user (admin, the owner) sees no requester form ══════════════════════
    console.log("\n=== E. Another eligible Project user (admin, this Project's own owner) sees no requester form ===\n");
    await adminPage.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("E. The Project's own owner (admin, NOT the requester) sees no 'Project Feedback' submission card", (await adminPage.getByText("Project Feedback", { exact: true }).count()) === 0);
    check("E. ...and no 'Your Feedback' readonly card either — that belongs ONLY to the original requester's own view", (await adminPage.getByText("Your Feedback", { exact: true }).count()) === 0);

    // ══════════════════════ F. Administration -> Feedback (admin) ══════════════════════
    console.log("\n=== F. Administration -> Feedback: the submitted row appears, readonly ===\n");
    // "Administration" is a collapsible nav section, collapsed by default
    // (only "Tickets" starts expanded) — expand it before looking for its
    // "Feedback" child link.
    await adminPage.getByRole("button", { name: "Administration" }).click();
    await adminPage.waitForTimeout(200);
    check("F. The 'Feedback' sidebar entry is visible to admin", (await adminPage.getByRole("link", { name: "Feedback", exact: true }).count()) > 0);
    await adminPage.goto(`${BASE_URL}/admin/project-feedback`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("F. The submitted row's Project title appears", (await adminPage.getByText(`${TAG} request`, { exact: true }).count()) > 0);
    check("F. ...the real requester's name/email appears", (await adminPage.getByText(requester.name ?? requester.email, { exact: false }).count()) > 0);
    check("F. ...the rating '8 / 10' appears", (await adminPage.getByText("8 / 10", { exact: true }).count()) > 0);
    check("F. ...the comment text appears", (await adminPage.getByText(commentText, { exact: false }).count()) > 0);
    check("F. The page has no Edit/Delete control for this row — readonly review only", (await adminPage.getByRole("button", { name: /edit|delete/i }).count()) === 0);

    // ══════════════════════ Manual Project: never shows the feature ══════════════════════
    console.log("\n=== Manual Project never shows the Feedback feature, for anyone ===\n");
    await requesterPage.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await requesterPage.waitForTimeout(500);
    check("Manual Project (requester view): no 'Project Feedback' card", (await requesterPage.getByText("Project Feedback", { exact: true }).count()) === 0);
    await adminPage.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await adminPage.waitForTimeout(500);
    check("Manual Project (owner/admin view): no 'Project Feedback' card either", (await adminPage.getByText("Project Feedback", { exact: true }).count()) === 0);
  } finally {
    await browser.close();
    try {
      await prisma.projectFeedback.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
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
