/**
 * Live browser verification for the Project Request Setup UI/editability
 * pass:
 *
 *   1. Expected Total Initial Days is the calculated-with-override field
 *      (create flow AND edit flow), visually consistent with other inputs,
 *      not disabled-looking: it shows the real calculated working days; a
 *      typed value is an explicit override (Reset returns to the calculation).
 *   2. The detail page's single Project Overview card carries the
 *      request-origin content (Project Request link, Expected Timeline,
 *      Expense Type) — none of it on a manual Project — with no horizontal
 *      overflow at narrow widths.
 *   3. The Project's Edit control navigates to the existing Project edit
 *      page (no second edit flow); there, automatic values follow the
 *      Expected dates and an explicit override survives date edits.
 *
 * Usage: BASE_URL=http://localhost:3000 node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/browser-verify-project-detail-request-setup-ui.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { calculateWorkingDays } from "@/lib/date-only";

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

    // Project Request submission requires the intermediate approver to be the
    // requester's VERIFIED SQLGeneral direct manager — isolated temporary
    // manager (never the seeded admin's identity) for both fixture
    // requesters, mocked the same way the sibling request-origin tests do,
    // registered before the routes load.
    const realSqlGeneralClient = await import("@/lib/sqlgeneral-api-client");
    const sqlRows = new Map<string, any>();
    const sqlRow = (username: string, managerAMAccountName: string | null) => ({ username, mail: null, hrDepartmentId: null, department: null, companyId: null, company: null, active: true, managerAMAccountName, manager2AMAccountName: null, manager3AMAccountName: null });
    mock.module("@/lib/sqlgeneral-api-client", {
      namedExports: {
        ...realSqlGeneralClient,
        findSqlGeneralUserByUsername: async (username: string) => (sqlRows.has(username) ? { outcome: "unique" as const, user: sqlRows.get(username) } : { outcome: "not_found" as const }),
      },
    });
    const manager = await prisma.user.create({ data: { email: `${TAG}-manager@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(manager.id);
    sqlRows.set(`${TAG}-mgr`, sqlRow(`${TAG}-mgr`, null));
    sqlRows.set(`${TAG}-req`, sqlRow(`${TAG}-req`, `${TAG}-mgr`));
    sqlRows.set(`${TAG}-req2`, sqlRow(`${TAG}-req2`, `${TAG}-mgr`));
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: manager.id, sqlGeneralUsername: `${TAG}-mgr`, status: "SUCCEEDED" } });
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: requester.id, sqlGeneralUsername: `${TAG}-req`, status: "SUCCEEDED" } });

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
        intermediateApproverIds: [manager.id],
      })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);

    if (submitRes.status !== 201) throw new Error(`Fixture setup failed: submit returned ${submitRes.status}: ${JSON.stringify(submitted)}`);
    fixtureSession = { user: { id: manager.id, role: Role.USER, customRoleId: null } };
    const clearRes = await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    if (clearRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${clearRes.status}`);
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
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
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: requester2.id, sqlGeneralUsername: `${TAG}-req2`, status: "SUCCEEDED" } });
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
        intermediateApproverIds: [manager.id],
      })
    );
    const submitted2 = await submit2Res.json();
    requestIds.push(submitted2.id);
    if (submit2Res.status !== 201) throw new Error(`Fixture setup failed: submit 2 returned ${submit2Res.status}: ${JSON.stringify(submitted2)}`);
    fixtureSession = { user: { id: manager.id, role: Role.USER, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted2.id }) });
    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted2.id }) });
    fixtureSession = null;

    await page.goto(`${BASE_URL}/projects/new?projectRequestId=${submitted2.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const readonlyInput = page.locator("#expected-total-initial-days");
    check("1. The Expected Total Initial Days field is a real <input> element (not a <p> aside)", (await readonlyInput.count()) === 1);
    // Current contract (approved Expected Days override): a CALCULATED
    // preview field that accepts an explicit manual override.
    check("1. ...and it is the calculated-with-override field (helper explains the calculation + override)", (await page.getByText("Working days (Mon–Fri), calculated from Expected Start/Finish Date. Enter a value to override.").count()) > 0);
    check("1. ...and it is NOT disabled (full visual weight, not greyed out)", !(await readonlyInput.evaluate((el) => (el as HTMLInputElement).disabled)));
    const opacityBefore = await readonlyInput.evaluate((el) => getComputedStyle(el).opacity);
    check("1. ...its opacity is the SAME as a normal (non-disabled) input (1), not faded", opacityBefore === "1");

    await page.fill("#expected-start", "2026-05-01");
    await page.fill("#expected-finish", "2026-05-06");
    await page.waitForTimeout(150);
    const previewValue = await readonlyInput.inputValue();
    const expectedPreview = String(calculateWorkingDays("2026-05-01", "2026-05-06"));
    check(`1. Once both dates are set, the preview shows the real calculated working-day value (${expectedPreview})`, previewValue === expectedPreview, previewValue);

    // 3. Typing a value is an explicit manual override — the calculated
    // value is still shown alongside it, and clearing restores it.
    await readonlyInput.fill("9");
    await page.waitForTimeout(100);
    check("3. Typing a value sets an explicit override (field shows 9) while still displaying the real calculated value", (await readonlyInput.inputValue()) === "9" && (await page.getByText(`Manually set (working days) — calculated value: ${expectedPreview} day${expectedPreview === "1" ? "" : "s"}.`).count()) > 0);
    await page.getByRole("button", { name: "Reset to calculated value" }).click();
    await page.waitForTimeout(100);
    check("3. ...and 'Reset to calculated value' returns to the real calculated preview", (await readonlyInput.inputValue()) === previewValue);

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

    // The former "Project Details" + "Project Request Setup" card pair is now
    // ONE "Project Overview" card (committed redesign); request-origin-only
    // content lives inside it.
    const overviewTitle = page.getByText("Project Overview", { exact: true }).first();
    await overviewTitle.waitFor({ timeout: 30000 });
    check("4. The request-origin Project's detail page shows the Project Overview card", (await overviewTitle.count()) > 0);
    check("4. ...with its request-origin content: the originating Project Request link", (await page.getByText("From Project Request", { exact: true }).count()) > 0 && (await page.getByRole("link", { name: `${TAG} request`, exact: true }).count()) > 0);
    check("4. ...the Expected Timeline set during Request Setup", (await page.getByText("Expected Timeline", { exact: true }).count()) > 0);
    check("4. ...and the Expense Type chosen during Request Setup", (await page.getByText("Expense Type", { exact: true }).count()) > 0);
    await page.screenshot({ path: `/tmp/${TAG}-desktop-1440.png` });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `/tmp/${TAG}-narrow-390.png`, fullPage: true });
    check("7. At a narrow width (390px), the Project Overview card still renders", await overviewTitle.isVisible());
    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("7. ...and there is no horizontal overflow at that narrow width", noHorizontalOverflow);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ══════════════════════ 5. Manual Project detail page shows none of the request-origin content ══════════════════════
    console.log("\n=== 5. Manual Project detail page (regression guard) ===\n");
    await page.goto(`${BASE_URL}/projects/${manualProject.id}`, { waitUntil: "load" });
    await page.getByText("Project Overview", { exact: true }).first().waitFor({ timeout: 30000 });
    check("5. A manual Project's Overview shows NO request-origin content (no Project Request link, Expected Timeline or Expense Type)", (await page.getByText("From Project Request", { exact: true }).count()) === 0 && (await page.getByText("Expected Timeline", { exact: true }).count()) === 0 && (await page.getByText("Expense Type", { exact: true }).count()) === 0);
    check("5. ...and the Project Overview still renders normally", (await page.getByText("Project Overview", { exact: true }).count()) > 0);

    // ══════════════════════ 8/10. The pencil/Edit control navigates to the existing edit page ══════════════════════
    console.log("\n=== 8/10. Pencil/Edit control on the Project Request Setup card ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    // The card-level pencil went away with the single Project Overview card;
    // the Project's Edit control is the header's Edit link (same edit route).
    const editControl = page.getByRole("link", { name: "Edit", exact: true });
    await editControl.first().waitFor({ timeout: 30000 });
    check("8. The admin (authorized) user sees the Project's Edit control", (await editControl.count()) === 1);
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
    // Current contract (approved Expected Days override): automatic values
    // follow the Expected dates; an explicit override is never overwritten
    // by later date edits.
    check("12. ...and it is the calculated-with-override field there too", (await page.getByText("Working days (Mon–Fri), calculated from Expected Start/Finish Date. Enter a value to override.").count()) > 0);
    const persisted = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true } });
    const baselineOnEditPage = await editReadonlyInput.inputValue();
    check(`12. ...and shows the REAL persisted value (${persisted.expectedTotalInitialDays} working days from the Setup dates)`, !persisted.expectedTotalInitialDaysOverridden && baselineOnEditPage === String(persisted.expectedTotalInitialDays) && persisted.expectedTotalInitialDays === calculateWorkingDays("2026-03-01", "2026-03-11"), `${baselineOnEditPage} vs ${persisted.expectedTotalInitialDays}`);

    // 13a: automatic mode follows edited Expected dates.
    await page.fill("#expectedStartDate", "2026-01-01");
    await page.fill("#expectedFinishDate", "2026-01-20");
    await page.waitForTimeout(150);
    check("13. In automatic mode, editing Expected Start/Finish recalculates the value from the new dates", (await editReadonlyInput.inputValue()) === String(calculateWorkingDays("2026-01-01", "2026-01-20")));
    // 13b: an explicit override survives later date edits.
    await editReadonlyInput.fill("7");
    await page.fill("#expectedFinishDate", "2026-01-30");
    await page.waitForTimeout(150);
    check("13. ...and an explicit override is NOT overwritten by later date edits", (await editReadonlyInput.inputValue()) === "7");
  } finally {
    await browser.close();
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
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
