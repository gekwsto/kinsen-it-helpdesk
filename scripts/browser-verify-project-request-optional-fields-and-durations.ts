/**
 * Real-browser acceptance (durations are WORKING DAYS, Mon–Fri — see
 * lib/date-only.ts) for:
 *   - Project Request submission with Team Concerned / Expected Benefits empty
 *   - FINAL approval (detail page) and rejection (list row action) with NO
 *     Business Assessment
 *   - Project creation from a Request: no Audience Business Units picker
 *     (and none sent); standalone creation still offers Business Units
 *   - Editable durations (Expected Total Initial Days / Actual Total Days):
 *     automatic calculation, manual override without touching dates,
 *     persistence after save + reload, date changes in automatic vs manual
 *     mode, Reset to calculated value, clearing dates, Facilities Quarter
 *   - layout screenshots (desktop + phone width) of both duration inputs
 *
 * Uses `playwright` against a live `npm run dev` server (this repo's
 * established browser-verify-*.ts convention). Local/dev database only:
 * every fixture is created here and removed in the cleanup block.
 *
 * The fixture user holds ONE department with a custom role granting
 * projectRequest.skipIntermediateApproval, so the request skips the
 * SQLGeneral-manager intermediate stage deterministically (no live
 * SQLGeneral dependency) and goes straight to FINAL approval.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-optional-fields-and-durations.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = "BvDurations123!";
const SHOT_DIR = process.env.SHOT_DIR || "reports/browser-verify-durations";

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

async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

async function main() {
  await prisma.$connect();
  const fs = await import("fs/promises");
  await fs.mkdir(SHOT_DIR, { recursive: true });

  const deptIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  let userId: string | null = null;
  let roleKey: string | null = null;
  let roleId: string | null = null;
  let expenseTypeId: string | null = null;
  let taskTypeId: string | null = null;
  let taskSubTypeId: string | null = null;
  const consoleErrors: string[] = [];
  const browser = await chromium.launch();

  try {
    // ══════════════════════ Fixtures ══════════════════════
    const dept = await createDepartment({ name: `BV Dur Dept ${RUN_ID}`, slug: `bv-dur-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const facilitiesDept = await prisma.department.findUniqueOrThrow({ where: { slug: process.env.FACILITIES_SERVICES_DEPARTMENT_SLUG || "facilities-services" } });
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `BV Dur Expense ${RUN_ID}` } });
    expenseTypeId = expenseType.id;

    const baseKeys = (await prisma.rolePermission.findMany({ where: { roleKey: "DEPARTMENT_ADMIN" }, select: { permission: { select: { key: true } } } })).map((r) => r.permission.key);
    const keys = Array.from(new Set([...baseKeys, "projectRequest.approve", "projectRequest.skipIntermediateApproval"]));
    const role = await prisma.customRole.create({ data: { key: `BV_DUR_${RUN_ID}`, name: `BV Dur ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    roleKey = role.key;
    roleId = role.id;
    for (const key of keys) {
      const perm = await prisma.permission.findUnique({ where: { key } });
      if (perm) await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    }
    const bcrypt = await import("bcryptjs");
    const email = `bv-dur-${RUN_ID}@kinsen.gr`;
    const user = await prisma.user.create({
      data: { email, name: `BV Dur User ${RUN_ID}`, authProvider: AuthProvider.CREDENTIALS, isActive: true, role: Role.USER, passwordHash: await bcrypt.hash(PASSWORD, 10) },
    });
    userId = user.id;
    await prisma.departmentMembership.create({
      data: { userId: user.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: role.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));

    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", email);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }), page.click('button:has-text("Sign in as Admin")')]);

    // ══════════════════════ 1. Request submission with optional fields empty ══════════════════════
    console.log("\n=== 1. Project Request submission with Team Concerned + Expected Benefits empty ===\n");
    async function submitRequest(title: string) {
      await page.goto(`${BASE_URL}/project-requests/new`);
      await page.waitForSelector("#title", { timeout: 30000 });
      await page.fill("#title", title);
      await page.fill("#description", "A description that is definitely long enough for validation.");
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith("/api/project-requests") && r.request().method() === "POST", { timeout: 20000 }),
        page.getByRole("button", { name: "Submit Request" }).click(),
      ]);
      const body = await res.json();
      if (body.id) requestIds.push(body.id);
      return { status: res.status(), id: body.id as string };
    }
    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForSelector("#teamConcerned", { timeout: 30000 });
    const teamLabel = (await page.locator('label[for="teamConcerned"]').innerText()).trim();
    const benefitsLabel = (await page.locator('label[for="expectedBenefits"]').innerText()).trim();
    check("Team Concerned label shows (optional), no required asterisk", /\(optional\)/.test(teamLabel) && !teamLabel.includes("*"), teamLabel);
    check("Expected Benefits label shows (optional), no required asterisk", /\(optional\)/.test(benefitsLabel) && !benefitsLabel.includes("*"), benefitsLabel);
    await page.screenshot({ path: `${SHOT_DIR}/01-request-form.png`, fullPage: true });

    const pr1 = await submitRequest(`BV Dur Approve ${RUN_ID}`);
    check("Submission with both optional fields EMPTY -> 201", pr1.status === 201);
    const pr2 = await submitRequest(`BV Dur Reject ${RUN_ID}`);
    check("Second submission (reject target) -> 201", pr2.status === 201);
    const pr1Row = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr1.id } });
    check("...Team Concerned and Expected Benefits persisted as null", pr1Row.teamConcerned === null && pr1Row.expectedBenefits === null);
    check("...request is awaiting FINAL approval (intermediate stage skipped by permission)", pr1Row.status === "PENDING_APPROVAL");

    // ══════════════════════ 2. Final approval (detail) + rejection (list) without Business Assessment ══════════════════════
    console.log("\n=== 2. Final approval from the detail page and rejection from the list — no Business Assessment ===\n");
    await page.goto(`${BASE_URL}/project-requests/${pr1.id}`);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForSelector("text=Approve Project Request");
    const assessmentLabel = (await page.locator('label[for="pr-decision-assessment"]').innerText()).trim();
    check("Decision dialog still SHOWS Business Assessment, labelled optional", /Business Assessment/.test(assessmentLabel) && /\(optional\)/.test(assessmentLabel), assessmentLabel);
    await page.screenshot({ path: `${SHOT_DIR}/02-approve-dialog.png` });
    const [approveRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/project-requests/${pr1.id}/approval`) && r.request().method() === "POST", { timeout: 20000 }),
      page.getByRole("button", { name: "Approve request" }).click(),
    ]);
    check("Approve with an EMPTY Business Assessment -> 200", approveRes.status() === 200);
    await page.waitForURL((u) => u.pathname === "/projects/new" && u.searchParams.get("projectRequestId") === pr1.id, { timeout: 30000 });
    check("...redirected to Project setup for that request", true);
    const pr1Approved = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr1.id } });
    check("...APPROVED with approver + timestamp, Business Assessment null", pr1Approved.status === "APPROVED" && pr1Approved.approverId === user.id && !!pr1Approved.approvedAt && pr1Approved.businessAssessment === null);

    const setupUrl = page.url();
    await page.goto(`${BASE_URL}/project-requests?tab=awaiting`);
    const rejectRow = page.getByRole("row", { name: new RegExp(`BV Dur Reject ${RUN_ID}`) });
    await rejectRow.waitFor({ state: "visible", timeout: 20000 });
    await rejectRow.locator("td").last().getByRole("button", { name: "Reject", exact: true }).click();
    await page.waitForSelector("text=Reject Project Request");
    const [rejectRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/project-requests/${pr2.id}/approval`) && r.request().method() === "POST", { timeout: 20000 }),
      page.getByRole("button", { name: "Reject request" }).click(),
    ]);
    check("Reject from the LIST row action with an EMPTY Business Assessment -> 200", rejectRes.status() === 200);
    const pr2Rejected = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr2.id } });
    check("...REJECTED with rejectedAt, Business Assessment null", pr2Rejected.status === "REJECTED" && !!pr2Rejected.rejectedAt && pr2Rejected.businessAssessment === null);
    check("...requester notified of both decisions", (await prisma.notification.count({ where: { userId: user.id, link: { in: [`/project-requests/${pr1.id}`, `/project-requests/${pr2.id}`] } } })) >= 2);

    // ══════════════════════ 3. Project creation from Request ══════════════════════
    console.log("\n=== 3. Project creation from Request — Audience without Business Units; durations ===\n");
    await page.goto(setupUrl);
    await page.waitForSelector("#expected-start", { timeout: 30000 });
    check("Audience — Business Units picker is NOT rendered", (await page.locator("#project-audience-business-units").count()) === 0 && (await page.getByText("Audience — Business Units").count()) === 0);
    check("Audience — Departments picker IS still rendered", await page.getByText("Audience — Departments").isVisible());
    check("Audience — Users picker IS still rendered", await page.getByText("Audience — Users").isVisible());

    await page.locator('input[placeholder="Search by name or email…"]').first().fill(email);
    await page.locator("#project-owners").getByRole("checkbox").first().check();
    await page.fill("#expected-start", "2026-10-01");
    await page.fill("#expected-finish", "2026-10-05");
    check("Expected Total Initial Days calculates automatically in working days (Thu 10-01 -> Mon 10-05 = 2)", (await page.inputValue("#expected-total-initial-days")) === "2");
    await page.fill('input[name="startDate"]', "2026-10-02");
    await page.fill('input[name="endDate"]', "2026-10-09");
    check("Actual Total Days calculates automatically in working days (Fri 10-02 -> Fri 10-09 = 5)", (await page.inputValue("#actual-total-days")) === "5");
    await page.fill("#expected-finish", "2026-10-08");
    check("Automatic mode: changing Expected Finish recalculates (Thu 10-01 -> Thu 10-08 = 5)", (await page.inputValue("#expected-total-initial-days")) === "5");
    await page.fill("#expected-total-initial-days", "10");
    check("Manual override shows 'Manually set' + Reset action", (await page.getByText("Manually set (working days) — calculated value: 5 days.").isVisible()) && (await page.getByRole("button", { name: "Reset to calculated value" }).count()) === 1);
    await page.fill("#expected-finish", "2026-10-09");
    check("Manual mode: a later date change does NOT overwrite the override (still 10)", (await page.inputValue("#expected-total-initial-days")) === "10");
    check("...and the override never changed the selected dates", (await page.inputValue("#expected-start")) === "2026-10-01" && (await page.inputValue("#expected-finish")) === "2026-10-09");
    await page.locator("#expense-type").click();
    await page.getByRole("option", { name: expenseType.name }).click();
    await page.locator("#expected-total-initial-days").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/03-create-from-request-durations.png`, fullPage: true });

    const [setupReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/project-requests/${pr1.id}/project`) && r.method() === "POST", { timeout: 20000 }),
      page.getByRole("button", { name: "Create Project" }).click(),
    ]);
    const setupBody = setupReq.postDataJSON() as Record<string, unknown>;
    check("Setup POST body never contains audienceBusinessUnitIds", !("audienceBusinessUnitIds" in setupBody));
    check("Setup POST body carries the Expected override only (Actual is automatic)", setupBody.expectedTotalInitialDaysOverride === 10 && !("actualTotalDaysOverride" in setupBody));
    await page.waitForURL((u) => /^\/projects\/[^/]+$/.test(u.pathname) && u.pathname !== "/projects/new", { timeout: 30000 });
    const projectId = page.url().split("/projects/")[1].split(/[?#]/)[0];
    projectIds.push(projectId);
    const createdWithAudience = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { audienceBusinessUnits: true } });
    let p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("Created Project: Expected Total Initial Days = 10 (manual)", p.expectedTotalInitialDays === 10 && p.expectedTotalInitialDaysOverridden);
    check("Created Project: Actual Total Days = 5 working days (automatic)", p.actualTotalDays === 5 && !p.actualTotalDaysOverridden);
    check("Created Project: dates exactly as selected", iso(p.expectedStartDate) === "2026-10-01" && iso(p.expectedFinishDate) === "2026-10-09" && iso(p.startDate) === "2026-10-02" && iso(p.endDate) === "2026-10-09");
    check("Created Project: no Business Unit Audience", createdWithAudience.audienceBusinessUnits.length === 0);
    await page.waitForSelector("text=Expected Timeline", { timeout: 30000 }).catch(() => {});
    const detailText = await page.locator("main").innerText();
    check("Detail page shows both durations (manual one marked)", /Expected total initial: 10 working day\(s\) \(manually set\)/.test(detailText) && /Actual total: 5 working day\(s\)/.test(detailText));

    // ══════════════════════ 4. Edit page — persistence, modes, reset, clearing ══════════════════════
    console.log("\n=== 4. Edit page — persistence after reload, manual vs automatic, Reset, clearing dates ===\n");
    const editUrl = `${BASE_URL}/projects/${projectId}/edit`;
    async function openEdit() {
      await page.goto(editUrl);
      await page.waitForSelector("#actualTotalDays", { timeout: 30000 });
      await page.waitForFunction(() => (document.querySelector("#title") as HTMLInputElement | null)?.value !== "", null, { timeout: 30000 });
    }
    async function save() {
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith(`/api/projects/${projectId}`) && r.request().method() === "PATCH", { timeout: 20000 }),
        page.getByRole("button", { name: "Save Changes" }).click(),
      ]);
      await page.waitForURL((u) => u.pathname === `/projects/${projectId}`, { timeout: 30000 });
      return res.status();
    }
    const expectedField = page.locator("#expectedTotalInitialDays").locator("xpath=ancestor::div[contains(@class,'space-y-2')][1]");
    const actualField = page.locator("#actualTotalDays").locator("xpath=ancestor::div[contains(@class,'space-y-2')][1]");

    await openEdit();
    check("Reload: Expected override persisted (10) with its Reset action", (await page.inputValue("#expectedTotalInitialDays")) === "10" && (await expectedField.getByRole("button", { name: "Reset to calculated value" }).count()) === 1);
    check("Reload: Actual is automatic (5), no Reset action", (await page.inputValue("#actualTotalDays")) === "5" && (await actualField.getByRole("button", { name: "Reset to calculated value" }).count()) === 0);
    await page.locator("#actualTotalDays").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/04-edit-durations-desktop.png`, fullPage: true });

    await page.fill("#actualTotalDays", "3");
    await page.fill("#endDate", "2026-10-20");
    check("Manual Actual override survives an End Date change in the form (still 3)", (await page.inputValue("#actualTotalDays")) === "3");
    check("Save (manual Actual + new End Date) -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: Actual = 3 (manual), End Date = 2026-10-20, Expected still 10 (manual)", p.actualTotalDays === 3 && p.actualTotalDaysOverridden && iso(p.endDate) === "2026-10-20" && p.expectedTotalInitialDays === 10 && p.expectedTotalInitialDaysOverridden);
    await openEdit();
    check("Reload: both overrides shown (10 / 3)", (await page.inputValue("#expectedTotalInitialDays")) === "10" && (await page.inputValue("#actualTotalDays")) === "3");

    await page.fill("#title", `BV Dur Project Renamed ${RUN_ID}`);
    check("Unrelated save (title only) -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: overrides survive an unrelated update", p.expectedTotalInitialDays === 10 && p.actualTotalDays === 3 && p.expectedTotalInitialDaysOverridden && p.actualTotalDaysOverridden);

    await openEdit();
    await expectedField.getByRole("button", { name: "Reset to calculated value" }).click();
    check("Reset Expected -> shows calculated working days (2026-10-01 -> 2026-10-09 = 6)", (await page.inputValue("#expectedTotalInitialDays")) === "6");
    await actualField.getByRole("button", { name: "Reset to calculated value" }).click();
    check("Reset Actual -> shows calculated working days (2026-10-02 -> 2026-10-20 = 12)", (await page.inputValue("#actualTotalDays")) === "12");
    check("Reset never changed the dates", (await page.inputValue("#expectedFinishDate")) === "2026-10-09" && (await page.inputValue("#endDate")) === "2026-10-20");
    check("Save after reset -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: both back to automatic (6 / 12)", p.expectedTotalInitialDays === 6 && !p.expectedTotalInitialDaysOverridden && p.actualTotalDays === 12 && !p.actualTotalDaysOverridden);

    await openEdit();
    await page.fill("#endDate", "2026-10-12");
    await page.fill("#expectedFinishDate", "2026-10-03");
    check("Automatic mode: date changes recalculate live (Fri 10-02 -> Mon 10-12 = 6 / Thu 10-01 -> Sat 10-03 = 2)", (await page.inputValue("#actualTotalDays")) === "6" && (await page.inputValue("#expectedTotalInitialDays")) === "2");
    check("Save -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: recalculated values persisted (Actual 6, Expected 2)", p.actualTotalDays === 6 && p.expectedTotalInitialDays === 2);

    console.log("\n-- Clearing dates --\n");
    await openEdit();
    await page.fill("#endDate", "");
    check("Automatic mode: clearing End Date empties the calculated value", (await page.inputValue("#actualTotalDays")) === "");
    check("Save with End Date cleared -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: End Date really cleared, Start Date kept, automatic Actual cleared", p.endDate === null && iso(p.startDate) === "2026-10-02" && p.actualTotalDays === null && !p.actualTotalDaysOverridden);
    await openEdit();
    check("Reload: End Date input is empty", (await page.inputValue("#endDate")) === "");
    await page.fill("#endDate", "2026-10-07");
    check("Re-entering End Date recalculates (Fri 10-02 -> Wed 10-07 = 3)", (await page.inputValue("#actualTotalDays")) === "3");
    // A value DIFFERENT from the calculated 3, so the input actually changes.
    await page.fill("#actualTotalDays", "9");
    await page.fill("#startDate", "");
    check("Manual Actual (9) kept after clearing Start Date in the form", (await page.inputValue("#actualTotalDays")) === "9");
    check("Save manual Actual (9) with Start Date cleared -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: Start Date cleared, End Date set, manual Actual 9 preserved", p.startDate === null && iso(p.endDate) === "2026-10-07" && p.actualTotalDays === 9 && p.actualTotalDaysOverridden);
    await openEdit();
    await page.fill("#expectedStartDate", "");
    await page.fill("#expectedTotalInitialDays", "6");
    check("Save manual Expected (6) with Expected Start cleared -> 200", (await save()) === 200);
    p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    check("DB: Expected Start cleared, manual Expected 6 preserved", p.expectedStartDate === null && p.expectedTotalInitialDays === 6 && p.expectedTotalInitialDaysOverridden);

    console.log("\n-- Invalid overrides are blocked client-side --\n");
    await openEdit();
    await page.fill("#actualTotalDays", "2.5");
    check("Fractional value shows the inline error", await page.getByText("Enter a whole number of days (0 or more).").isVisible());
    await page.getByRole("button", { name: "Save Changes" }).click();
    await page.waitForTimeout(500);
    check("...and Save does not navigate away (blocked)", page.url().endsWith("/edit"));
    await page.fill("#actualTotalDays", "0");
    check("Zero is accepted (no error)", (await page.getByText("Enter a whole number of days (0 or more).").count()) === 0);

    // ══════════════════════ 4b. Activity working days + cost preview ══════════════════════
    console.log("\n=== 4b. Activity — Expected Days in working days and Estimated Cost = daily rate × working days ===\n");
    const taskType = await prisma.taskType.create({ data: { name: `BV Dur TaskType ${RUN_ID}` } });
    taskTypeId = taskType.id;
    const taskSubType = await prisma.taskSubType.create({ data: { name: `BV Dur SubType ${RUN_ID}`, cost: 150 } });
    taskSubTypeId = taskSubType.id;
    await page.goto(`${BASE_URL}/activities/new?projectId=${projectId}`);
    await page.waitForSelector("#expected-start", { timeout: 30000 });
    await page.fill("#expected-start", "2026-10-02");
    await page.fill("#expected-finish", "2026-10-13");
    check("Activity create preview: Fri 10-02 -> Tue 10-13 = 7 working days", (await page.inputValue("#expected-days")) === "7 days");
    await page.locator("#task-sub-type").click();
    await page.getByRole("option", { name: taskSubType.name }).click();
    check("Activity create preview: Estimated Cost = 150 × 7 = 1050.00 EUR", (await page.inputValue("#estimated-cost")) === "1050.00 EUR", await page.inputValue("#estimated-cost"));
    await page.locator("#expected-days").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/04b-activity-create-working-days.png`, fullPage: true });
    const created = await page.evaluate(async (payload) => {
      const r = await fetch("/api/activities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return { status: r.status, body: await r.json() };
    }, { title: `BV Dur Activity ${RUN_ID}`, projectId, departmentId: dept.id, expectedStartDate: "2026-10-02", expectedFinishDate: "2026-10-13", taskTypeId: taskType.id, taskSubTypeId: taskSubType.id, ownerId: user.id, assignedUserIds: [user.id] });
    check("Activity created through the real API from the browser session -> 201", created.status === 201, JSON.stringify(created.body).slice(0, 200));
    const actRow = await prisma.projectActivity.findUniqueOrThrow({ where: { id: created.body.id } });
    check("DB: Activity expectedDays = 7 (server matches the preview); rate snapshot 150 untouched", actRow.expectedDays === 7 && Number(actRow.taskSubTypeCost) === 150);
    check("API: estimatedCost = '1050' (rate × working days)", created.body.estimatedCost === "1050");
    await page.goto(`${BASE_URL}/activities/${created.body.id}`);
    await page.waitForSelector("text=7 working day(s)", { timeout: 30000 });
    check("Activity detail shows '7 working day(s)'", await page.getByText("7 working day(s)").first().isVisible());
    const projAfterActivity = await page.evaluate(async (id) => (await fetch(`/api/projects/${id}`)).json(), projectId);
    check("Project financial rollup includes the Activity's working-day cost (estimatedCost '1050')", projAfterActivity.estimatedCost === "1050");

    // ══════════════════════ 5. Standalone Project — Business Units still available ══════════════════════
    console.log("\n=== 5. Standalone Project creation — Business Units still offered and saved ===\n");
    await page.goto(`${BASE_URL}/projects/new`);
    await page.waitForSelector("#title", { timeout: 30000 });
    check("Standalone form shows Audience — Business Units", await page.getByText("Audience — Business Units").isVisible());
    const buGroup = page.locator("#project-audience-business-units");
    await buGroup.waitFor({ state: "visible", timeout: 20000 });
    const buCheckbox = buGroup.getByRole("checkbox").first();
    await buCheckbox.check();
    await page.fill("#title", `BV Dur Standalone ${RUN_ID}`);
    await page.fill('input[name="startDate"]', "2026-03-01");
    await page.fill('input[name="endDate"]', "2026-03-11");
    check("Standalone: Actual Total Days calculates automatically (Sun 03-01 -> Wed 03-11 = 7)", (await page.inputValue("#actual-total-days")) === "7");
    await page.locator("#actual-total-days").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/05-standalone-create.png`, fullPage: true });
    const [standaloneReq, standaloneRes] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/projects") && r.method() === "POST", { timeout: 20000 }),
      page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.request().method() === "POST", { timeout: 20000 }),
      page.getByRole("button", { name: "Create Project" }).click(),
    ]);
    const standaloneBody = standaloneReq.postDataJSON() as { audienceBusinessUnitIds?: string[] };
    const standaloneCreated = await standaloneRes.json();
    if (standaloneCreated.id) projectIds.push(standaloneCreated.id);
    check("Standalone create -> 201 with a Business Unit in the payload", standaloneRes.status() === 201 && (standaloneBody.audienceBusinessUnitIds?.length ?? 0) === 1);
    const standaloneRow = await prisma.project.findUniqueOrThrow({ where: { id: standaloneCreated.id }, include: { audienceBusinessUnits: true } });
    check("DB: Business Unit Audience connected; Actual Total Days 7 (automatic)", standaloneRow.audienceBusinessUnits.length === 1 && standaloneRow.actualTotalDays === 7 && !standaloneRow.actualTotalDaysOverridden);

    // ══════════════════════ 6. Facilities Quarter dates ══════════════════════
    console.log("\n=== 6. Facilities Services — Quarter dates drive Actual Total Days ===\n");
    await prisma.departmentMembership.create({
      data: { userId: user.id, departmentId: facilitiesDept.id, role: DepartmentRole.VIEWER, customRoleId: role.id, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
    });
    const facProject = await prisma.project.create({
      data: { title: `BV Dur Facilities ${RUN_ID}`, departmentId: facilitiesDept.id, ownerId: user.id, owners: { connect: [{ id: user.id }] }, startDate: new Date("2027-01-15"), endDate: new Date("2027-03-31"), facilitiesStartPrecision: "EXACT", facilitiesEndPrecision: "EXACT", actualTotalDays: 53 },
    });
    projectIds.push(facProject.id);
    await page.goto(`${BASE_URL}/projects/${facProject.id}/edit`);
    await page.waitForSelector("#actualTotalDays", { timeout: 30000 });
    await page.waitForFunction(() => (document.querySelector("#title") as HTMLInputElement | null)?.value !== "", null, { timeout: 30000 });
    check("Facilities exact dates: Actual Total Days 53 working days (2027-01-15 -> 2027-03-31)", (await page.inputValue("#actualTotalDays")) === "53");
    const quarterButtons = page.getByRole("button", { name: "Quarter", exact: true });
    await quarterButtons.nth(0).click();
    await quarterButtons.nth(1).click();
    const quarterTriggers = page.getByRole("combobox").filter({ hasText: "Quarter" });
    await quarterTriggers.nth(0).click();
    await page.getByRole("option", { name: "Q2", exact: true }).click();
    await page.locator('input[placeholder="Year"]').nth(0).fill("2027");
    await page.getByRole("combobox").filter({ hasText: "Quarter" }).nth(0).click();
    await page.getByRole("option", { name: "Q2", exact: true }).click();
    await page.locator('input[placeholder="Year"]').nth(1).fill("2027");
    check("Quarter Q2 2027 -> Q2 2027 calculates 64 working days (2027-04-01 -> 2027-06-30)", (await page.inputValue("#actualTotalDays")) === "64", await page.inputValue("#actualTotalDays"));
    await page.locator("#actualTotalDays").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOT_DIR}/06-facilities-quarter.png`, fullPage: true });
    const [facRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${facProject.id}`) && r.request().method() === "PATCH", { timeout: 20000 }),
      page.getByRole("button", { name: "Save Changes" }).click(),
    ]);
    check("Facilities Quarter save -> 200", facRes.status() === 200);
    let fac = await prisma.project.findUniqueOrThrow({ where: { id: facProject.id } });
    check(
      "DB: Quarter metadata + derived boundary dates kept; Actual 64 working days, automatic",
      fac.facilitiesStartPrecision === "QUARTER" && fac.facilitiesStartQuarter === "Q2" && fac.facilitiesStartYear === 2027 && fac.facilitiesEndQuarter === "Q2" &&
        iso(fac.startDate) === "2027-04-01" && iso(fac.endDate) === "2027-06-30" && fac.actualTotalDays === 64 && !fac.actualTotalDaysOverridden
    );
    await page.goto(`${BASE_URL}/projects/${facProject.id}/edit`);
    await page.waitForSelector("#actualTotalDays", { timeout: 30000 });
    await page.waitForFunction(() => (document.querySelector("#title") as HTMLInputElement | null)?.value !== "", null, { timeout: 30000 });
    await page.fill("#actualTotalDays", "45");
    await page.getByRole("combobox").filter({ hasText: "Q2" }).nth(1).click();
    await page.getByRole("option", { name: "Q3", exact: true }).click();
    check("Manual override (45) not overwritten by changing End quarter to Q3", (await page.inputValue("#actualTotalDays")) === "45");
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${facProject.id}`) && r.request().method() === "PATCH", { timeout: 20000 }),
      page.getByRole("button", { name: "Save Changes" }).click(),
    ]);
    fac = await prisma.project.findUniqueOrThrow({ where: { id: facProject.id } });
    check("DB: End Q3 2027 -> 2027-09-30; manual Actual 45 preserved", fac.facilitiesEndQuarter === "Q3" && iso(fac.endDate) === "2027-09-30" && fac.actualTotalDays === 45 && fac.actualTotalDaysOverridden);

    // ══════════════════════ 7. Layout at phone width ══════════════════════
    console.log("\n=== 7. Layout — duration inputs at phone width ===\n");
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await context.storageState() });
    const phonePage = await phone.newPage();
    await phonePage.goto(editUrl);
    await phonePage.waitForSelector("#actualTotalDays", { timeout: 30000 });
    await phonePage.locator("#actualTotalDays").scrollIntoViewIfNeeded();
    const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("Edit page at 390px: no horizontal page overflow", overflow <= 0, String(overflow));
    const box = await phonePage.locator("#actualTotalDays").boundingBox();
    check("Actual Total Days input fits within the viewport at 390px", !!box && box.x >= 0 && box.x + box.width <= 390);
    await phonePage.screenshot({ path: `${SHOT_DIR}/07-edit-durations-phone.png`, fullPage: true });
    await phone.close();

    check("No page errors / console errors during the run", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
    await runCleanup([
      ["notifications", () => prisma.notification.deleteMany({ where: { OR: [{ link: { in: requestIds.map((id) => `/project-requests/${id}`) } }, ...(userId ? [{ userId }] : [])] } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, ...(userId ? [{ createdById: userId }] : [])] } })],
      ["projects", () => prisma.project.deleteMany({ where: { OR: [{ id: { in: projectIds } }, { projectRequestId: { in: requestIds } }] } })],
      ["setup reminders", () => (prisma as any).projectRequestSetupReminder?.deleteMany({ where: { projectRequestId: { in: requestIds } } }) ?? Promise.resolve()],
      ["intermediate approvers", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["task sub type", () => (taskSubTypeId ? prisma.taskSubType.delete({ where: { id: taskSubTypeId } }) : Promise.resolve())],
      ["task type", () => (taskTypeId ? prisma.taskType.delete({ where: { id: taskTypeId } }) : Promise.resolve())],
      ["expense type", () => (expenseTypeId ? prisma.projectExpenseType.delete({ where: { id: expenseTypeId } }) : Promise.resolve())],
      ["memberships", () => (userId ? prisma.departmentMembership.deleteMany({ where: { userId } }) : Promise.resolve())],
      ["sessions", () => (userId ? (prisma as any).session?.deleteMany({ where: { userId } }) ?? Promise.resolve() : Promise.resolve())],
      ["user", () => (userId ? prisma.user.delete({ where: { id: userId } }) : Promise.resolve())],
      ["role permissions", () => (roleKey ? prisma.rolePermission.deleteMany({ where: { roleKey } }) : Promise.resolve())],
      ["custom role", () => (roleId ? prisma.customRole.delete({ where: { id: roleId } }) : Promise.resolve())],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ]);
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
