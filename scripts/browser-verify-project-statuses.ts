/**
 * Real-browser acceptance for configurable Project Statuses:
 *  - Administration -> Project Statuses (nav entry, system protections,
 *    create a custom status through the dialog, deactivate it, in-use
 *    delete blocked).
 *  - The custom status is selectable on the Project detail quick-status
 *    dropdown and shows its configured label/color on the detail badge,
 *    the Projects list (incl. the ?statusId= filter + filter dropdown) and
 *    the Project Gantt's status filter.
 *  - An inactive status stays visible/selected in Project Edit and saving
 *    unrelated changes keeps it.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-statuses.ts
 */
import { chromium, type Browser, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, ProjectStatus, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const TAG = `BV PStatus ${RUN_ID}`;
const PASSWORD = "BvPStatus123!";
const CUSTOM_LABEL = `Review ${RUN_ID}`;
const CUSTOM_COLOR = "#7c3aed";
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
async function login(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
  return page;
}

async function main() {
  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[] };
  const browser = await chromium.launch();
  const originalSystem = await prisma.projectStatusDefinition.findMany({ where: { isSystem: true } });
  try {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const admin = await prisma.user.create({ data: { email: `bv-pstatus-admin-${RUN_ID}@kinsen.gr`, name: `${TAG} admin`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
    ids.users.push(admin.id);
    const dept = await createDepartment({ name: `${TAG} Dept`, slug: `bv-pstatus-${RUN_ID}` });
    ids.depts.push(dept.id);
    const project = await prisma.project.create({ data: { title: `${TAG} Project`, departmentId: dept.id, ownerId: admin.id, owners: { connect: [{ id: admin.id }] }, status: ProjectStatus.PLANNING, startDate: new Date("2026-11-02"), endDate: new Date("2026-11-27") } });
    ids.projects.push(project.id);

    console.log("\n=== 1. Administration -> Project Statuses ===\n");
    const page = await login(browser, admin.email);
    await page.goto(`${BASE_URL}/admin/project-statuses`, { waitUntil: "load" });
    await page.getByRole("heading", { name: "Project Statuses" }).waitFor({ timeout: 60000 });
    const adminGroup = page.getByRole("button", { name: "Administration" });
    if ((await adminGroup.count()) > 0 && (await page.getByRole("link", { name: "Project Statuses", exact: true }).count()) === 0) await adminGroup.first().click();
    check("Sidebar has the 'Project Statuses' Administration entry", (await page.getByRole("link", { name: "Project Statuses", exact: true }).count()) > 0);
    const table = page.getByTestId("project-status-table");
    check("All five system statuses are listed, each marked 'System'", (await Promise.all(["PLANNING", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"].map(async (k) => (await table.locator(`tr[data-status-key="${k}"]`).getByText("System").count()) === 1))).every(Boolean));
    check("System statuses can't be deleted (delete control disabled)", await table.locator('tr[data-status-key="CANCELLED"]').getByRole("button", { name: /^Delete / }).isDisabled());
    check("The system PLANNING status can't be deactivated (switch disabled)", await table.locator('tr[data-status-key="PLANNING"]').getByRole("switch").isDisabled());

    await page.getByRole("button", { name: "New Project Status" }).click();
    await page.fill("#ps-label", CUSTOM_LABEL);
    await page.getByLabel("Color hex").fill(CUSTOM_COLOR);
    await page.getByRole("combobox", { name: "Lifecycle State" }).click();
    await page.getByRole("option", { name: "In Progress", exact: true }).click();
    const [createRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/admin/project-statuses") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    const custom = await prisma.projectStatusDefinition.findFirst({ where: { label: CUSTOM_LABEL } });
    check("Creating a custom status through the dialog (201) persists it mapped to IN_PROGRESS", createRes.status() === 201 && custom?.canonicalStatus === "IN_PROGRESS" && custom.color === CUSTOM_COLOR && !custom.isSystem);
    await table.getByText(CUSTOM_LABEL).waitFor({ timeout: 10000 });
    check("...and it appears in the table", (await table.getByText(CUSTOM_LABEL).count()) === 1);

    console.log("\n=== 2. Selecting the custom status on the Project ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    const quick = page.getByRole("button", { name: "Change project status" });
    await quick.waitFor({ timeout: 60000 });
    await quick.click();
    const [patchRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === "PATCH"),
      page.getByRole("menuitem", { name: new RegExp(CUSTOM_LABEL) }).click(),
    ]);
    const afterQuick = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    check("Quick-status dropdown selects the custom status (200): definition set, canonical IN_PROGRESS", patchRes.status() === 200 && afterQuick.statusDefinitionId === custom!.id && afterQuick.status === "IN_PROGRESS");
    const headerBadge = page.locator(`[data-project-status-id="${custom!.id}"]`).first();
    await headerBadge.waitFor({ timeout: 10000 });
    const dotColor = await headerBadge.locator("span").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    check("Detail badge shows the configured label with the configured color", (await headerBadge.innerText()).includes(CUSTOM_LABEL) && dotColor === "rgb(124, 58, 237)", dotColor);

    console.log("\n=== 3. Projects list + filter ===\n");
    await page.goto(`${BASE_URL}/projects?departmentId=${dept.id}&statusId=${custom!.id}`, { waitUntil: "load" });
    await page.getByText(`${TAG} Project`).first().waitFor({ timeout: 60000 });
    check("?statusId= filter lists the Project, with the configured badge", (await page.locator(`[data-project-status-id="${custom!.id}"]`).count()) > 0);
    await page.getByRole("combobox", { name: "Project status filter" }).click();
    check("The list's Status filter dropdown offers the custom status", (await page.getByRole("option", { name: new RegExp(CUSTOM_LABEL) }).count()) === 1);
    await page.keyboard.press("Escape");
    const planningSys = originalSystem.find((d) => d.canonicalStatus === "PLANNING")!;
    await page.goto(`${BASE_URL}/projects?departmentId=${dept.id}&statusId=${planningSys.id}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    check("...and filtering by another status (Planning) excludes it", (await page.getByText(`${TAG} Project`).count()) === 0);

    console.log("\n=== 4. Project Gantt ===\n");
    await page.goto(`${BASE_URL}/projects/gantt?departmentId=${dept.id}`, { waitUntil: "load" });
    await page.getByText(`${TAG} Project`).first().waitFor({ timeout: 60000 });
    await page.getByRole("combobox").filter({ hasText: "All statuses" }).first().click();
    check("Gantt status filter offers the configured status label", (await page.getByRole("option", { name: CUSTOM_LABEL, exact: true }).count()) === 1);
    await page.keyboard.press("Escape");

    console.log("\n=== 5. Inactive status retention ===\n");
    await page.goto(`${BASE_URL}/admin/project-statuses`, { waitUntil: "load" });
    const customRow = page.getByTestId("project-status-table").locator(`tr[data-status-key="${custom!.key}"]`);
    await customRow.waitFor({ timeout: 60000 });
    check("A status used by a Project can't be deleted (delete control disabled, usage 1)", (await customRow.getByRole("button", { name: /^Delete / }).isDisabled()) && (await customRow.getByTestId("usage-count").innerText()) === "1");
    const [deactRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/admin/project-statuses/${custom!.id}`) && r.request().method() === "PATCH"),
      customRow.getByRole("switch").click(),
    ]);
    check("Deactivating it through the switch (200)", deactRes.status() === 200 && (await prisma.projectStatusDefinition.findUniqueOrThrow({ where: { id: custom!.id } })).isActive === false);
    await page.goto(`${BASE_URL}/projects/${project.id}/edit`, { waitUntil: "load" });
    await page.getByText("Edit Project", { exact: true }).waitFor({ timeout: 60000 });
    const statusSelect = page.getByRole("combobox", { name: "Status", exact: true });
    await statusSelect.waitFor({ timeout: 30000 });
    await page.waitForFunction((label) => [...document.querySelectorAll('[role="combobox"]')].some((el) => el.textContent?.includes(label)), CUSTOM_LABEL, { timeout: 30000 });
    check("Project Edit still shows the (now inactive) status, labelled '(inactive)'", (await statusSelect.innerText()).includes(CUSTOM_LABEL) && (await statusSelect.innerText()).includes("(inactive)"));
    await page.fill("#title", `${TAG} Project`);
    const [saveRes] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === "PATCH"),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);
    check("Saving the Edit page keeps the inactive status (200, unchanged)", saveRes.status() === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).statusDefinitionId === custom!.id);
    await page.goto(`${BASE_URL}/projects/${project.id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Change project status" }).waitFor({ timeout: 60000 });
    check("Detail badge marks the retained status '(inactive)'", (await page.locator(`[data-project-status-id="${custom!.id}"]`).first().innerText()).includes("(inactive)"));
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["custom statuses", () => prisma.projectStatusDefinition.deleteMany({ where: { label: CUSTOM_LABEL } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    for (const d of originalSystem) await prisma.projectStatusDefinition.update({ where: { id: d.id }, data: { label: d.label, color: d.color, sortOrder: d.sortOrder, isActive: d.isActive } });
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
