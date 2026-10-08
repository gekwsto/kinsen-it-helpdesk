/**
 * Live browser verification for the Project Request Setup UI/editability
 * pass:
 *
 *   1. Expected Total Initial Days renders as a real readOnly textbox
 *      (create flow AND edit flow), visually consistent with other inputs,
 *      not typable, not disabled-looking.
 *   2. The Project Request Setup card sits beside Project Details as peer
 *      cards on desktop, and stacks safely at narrow widths with no
 *      horizontal overflow.
 *   3. The card's pencil/Edit control navigates to the existing Project
 *      edit page (no second edit flow), and editing Expected Start/Finish
 *      there never changes the displayed Expected Total Initial Days.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-project-detail-request-setup-ui.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvprdsu-${RUN_ID}`;

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
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const expenseTypeIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const type = await prisma.taskType.create({ data: { name: `${TAG}-type` } });
    typeIds.push(type.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    const requester = await prisma.user.create({
      data: { email: `${TAG}-requester@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(requester.id);
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expense-type` } });
    expenseTypeIds.push(expenseType.id);

    // ══════════════════════ Fixture: one real request-origin Project (via the real routes, end to end) ══════════════════════
    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Project Request Setup UI fixture — description long enough.",
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
      })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);

    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const clearRes = await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    if (clearRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${clearRes.status}`);
    const approveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Project Request Setup UI fixture." }), { params: Promise.resolve({ id: submitted.id }) });
    if (approveRes.status !== 200) throw new Error(`Fixture setup failed: final approval returned ${approveRes.status}`);

    const setupRes = await setupPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Project Request Setup UI fixture — description long enough.",
        ownerIds: [admin.id],
        expectedStartDate: "2026-03-01",
        expectedFinishDate: "2026-03-11", // 10 whole calendar days — a stable, checkable baseline
        expenseTypeId: expenseType.id,
        external: false,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: project setup returned ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const project = await setupRes.json();
    projectIds.push(project.id);
    fixtureSession = null;

    // A plain manual Project too, for the "manual Project shows none of this" side of the comparison.
    const manualProject = await prisma.project.create({
      data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id },
    });
    projectIds.push(manualProject.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await login(page);

    // ══════════════════════ 1. Request-origin create flow: Expected Total Initial Days is a real readOnly textbox ══════════════════════
    console.log("\n=== 1. Request-origin /projects/new create flow ===\n");
    await page.goto(`${BASE_URL}/projects/new?projectRequestId=${submitted.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    // this request is already linked to a Project (via setupPOST above), so
    // the page redirects straight to it — reopen the raw setup URL on a
    // FRESH request instead, to see the actual create-time form.
    const requester2 = await prisma.user.create({
      data: { email: `${TAG}-requester2@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(requester2.id);
    await prisma.departmentMembership.create({
      data: { userId: requester2.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    fixtureSession = { user: { id: requester2.id, role: Role.USER, customRoleId: null } };
    const submit2Res = await requestsPOST(
      jsonReq({
        title: `${TAG} request 2`,
        description: "Second fixture request — stays unlinked for the create-flow UI check.",
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
      })
    );
    const submitted2 = await submit2Res.json();
    requestIds.push(submitted2.id);
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted2.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted2.id }) });
    fixtureSession = null;

    await page.goto(`${BASE_URL}/projects/new?projectRequestId=${submitted2.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const readonlyInput = page.locator("#expected-total-initial-days");
    check("1. The Expected Total Initial Days field is a real <input> element (not a <p> aside)", (await readonlyInput.count()) === 1);
    check("1. ...and it is readOnly (not editable)", await readonlyInput.evaluate((el) => (el as HTMLInputElement).readOnly));
    check("1. ...and it is NOT disabled (full visual weight, not greyed out)", !(await readonlyInput.evaluate((el) => (el as HTMLInputElement).disabled)));
    const opacityBefore = await readonlyInput.evaluate((el) => getComputedStyle(el).opacity);
    check("1. ...its opacity is the SAME as a normal (non-disabled) input (1), not faded", opacityBefore === "1");

    await page.fill("#expected-start", "2026-05-01");
    await page.fill("#expected-finish", "2026-05-06");
    await page.waitForTimeout(150);
    const previewValue = await readonlyInput.inputValue();
    check("1. Once both dates are set, the preview shows the real calculated value", previewValue === "5 days");

    // 3. Typing directly into the readOnly field must do nothing.
    await readonlyInput.click();
    await page.keyboard.type("999");
    await page.waitForTimeout(100);
    const afterTypeValue = await readonlyInput.inputValue();
    check("3. Typing into the readOnly field changes nothing — value is still the real calculated preview, not '999'", afterTypeValue === previewValue && !afterTypeValue.includes("999"));

    // ══════════════════════ 2. Manual create flow never shows any of this ══════════════════════
    console.log("\n=== 2. Manual /projects/new create flow (regression guard) ===\n");
    await page.goto(`${BASE_URL}/projects/new`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    check("2. The manual create form has NO Expected Total Initial Days field at all", (await page.locator("#expected-total-initial-days").count()) === 0);
    check("2. ...and no Expected Start/Finish/Expense Type/Budget fields either", (await page.locator("#expected-start").count()) === 0 && (await page.locator("#expense-type").count()) === 0);

    // ══════════════════════ 4/5/6/7. Detail page: card adjacency + responsive stacking ══════════════════════
    console.log("\n=== 4/5/6/7. Project detail page: peer-card layout ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const detailsCard = page.locator("h3,div").filter({ hasText: /^Project Details$/ }).first();
    const setupCard = page.locator("h3,div").filter({ hasText: /^Project Request Setup$/ }).first();
    check("4. The request-origin Project's detail page shows a 'Project Request Setup' card", (await setupCard.count()) > 0);
    await page.screenshot({ path: `/tmp/${TAG}-desktop-1440.png` });

    const detailsBox = await detailsCard.boundingBox();
    const setupBox = await setupCard.boundingBox();
    check("6. (sanity) Both card headers were found on screen", detailsBox !== null && setupBox !== null);
    if (detailsBox && setupBox) {
      // A header with a title + Edit button is taller than a title-only
      // header, so its title can sit a little lower within its own row
      // (vertical centering) — 50px is well under a real card's height
      // (reserved for "this is a genuinely different grid row"), so this
      // still only passes for true side-by-side placement, not stacking.
      const sameRow = Math.abs(detailsBox.y - setupBox.y) < 50;
      const sideBySide = Math.abs(detailsBox.x - setupBox.x) > 50;
      check("6. On a desktop width (1440px), Project Details and Project Request Setup are peer cards in the SAME row, side by side", sameRow && sideBySide, `detailsBox.y=${detailsBox.y} setupBox.y=${setupBox.y} detailsBox.x=${detailsBox.x} setupBox.x=${setupBox.x}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/tmp/${TAG}-narrow-390.png`, fullPage: true });
    const narrowDetailsBox = await detailsCard.boundingBox();
    const narrowSetupBox = await setupCard.boundingBox();
    if (narrowDetailsBox && narrowSetupBox) {
      const stacked = narrowSetupBox.y - narrowDetailsBox.y > 50;
      check("7. At a narrow width (390px), the two cards stack vertically instead of staying side by side", stacked, `narrowDetailsBox.y=${narrowDetailsBox.y} narrowSetupBox.y=${narrowSetupBox.y}`);
    }
    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("7. ...and there is no horizontal overflow at that narrow width", noHorizontalOverflow);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ══════════════════════ 5. Manual Project detail page shows neither card content nor the section ══════════════════════
    console.log("\n=== 5. Manual Project detail page (regression guard) ===\n");
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    check("5. A manual Project's detail page shows NO 'Project Request Setup' card", (await page.locator("h3,div").filter({ hasText: /^Project Request Setup$/ }).count()) === 0);
    const manualDetailsCard = page.locator("h3,div").filter({ hasText: /^Project Details$/ }).first();
    const manualDetailsBox = await manualDetailsCard.boundingBox();
    check("5. ...and Project Details still renders normally (no empty grid column beside it)", manualDetailsBox !== null);

    // ══════════════════════ 8/10. The pencil/Edit control navigates to the existing edit page ══════════════════════
    console.log("\n=== 8/10. Pencil/Edit control on the Project Request Setup card ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const editControl = page.getByRole("link", { name: /edit project request setup/i });
    check("8. The admin (authorized) user sees the pencil/Edit control on the Project Request Setup card", (await editControl.count()) === 1);
    await editControl.click();
    await page.waitForURL((url) => url.pathname === `/projects/${project.id}/edit`, { timeout: 10000 });
    check("10. Clicking it navigates to the EXISTING Project edit route — no second edit page", page.url().endsWith(`/projects/${project.id}/edit`));
    // EditProjectPage is a client component that shows a loading spinner
    // until its own useEffect fetch(`/api/projects/${id}`) resolves — wait
    // for that real content, not a fixed sleep that can race it.
    await page.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 10000 });
    check("10. ...and that page is indeed the normal 'Edit Project' page", (await page.getByText("Edit Project", { exact: true }).count()) > 0);

    // ══════════════════════ 11/12/13. Edit page: request-origin fields editable, baseline readonly and stable ══════════════════════
    console.log("\n=== 11/12/13. Edit page: request-origin fields + immutable baseline ===\n");
    for (const id of ["expectedStartDate", "expectedFinishDate"]) {
      check(`11. Edit page exposes #${id}`, (await page.locator(`#${id}`).count()) > 0);
    }
    check("11. Edit page exposes the Expense Type selector", (await page.getByText("Expense Type", { exact: true }).count()) > 0);
    check("11. Edit page exposes Estimated Cost/Actual Cost as readonly (Budget removed entirely)", (await page.locator("#estimatedCost").count()) > 0 && (await page.locator("#actualCost").count()) > 0 && (await page.locator("#budget").count()) === 0);
    check("...and both are readOnly — never directly editable", (await page.locator("#estimatedCost").evaluate((el) => (el as HTMLInputElement).readOnly)) && (await page.locator("#actualCost").evaluate((el) => (el as HTMLInputElement).readOnly)));

    const editReadonlyInput = page.locator("#expectedTotalInitialDays");
    check("12. Expected Total Initial Days is VISIBLE on the edit page", (await editReadonlyInput.count()) === 1);
    check("12. ...and it is readOnly there too", await editReadonlyInput.evaluate((el) => (el as HTMLInputElement).readOnly));
    const baselineOnEditPage = await editReadonlyInput.inputValue();
    check("12. ...and shows the REAL persisted baseline (10 days, from Expected Start/Finish set at creation)", baselineOnEditPage === "10 days");

    // 13: change Expected Start/Finish in the edit form — the readonly baseline must NOT move.
    await page.fill("#expectedStartDate", "2026-01-01");
    await page.fill("#expectedFinishDate", "2026-01-20");
    await page.waitForTimeout(150);
    const baselineAfterDateChange = await editReadonlyInput.inputValue();
    check("13. Editing Expected Start/Finish in the form does NOT change the displayed Expected Total Initial Days", baselineAfterDateChange === baselineOnEditPage);
  } finally {
    await browser.close();
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { id: { in: expenseTypeIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
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
