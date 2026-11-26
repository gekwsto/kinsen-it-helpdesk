/**
 * Real-browser acceptance: editable Workspace on the Project Setup form
 * (/projects/new?projectRequestId=…).
 *  - Defaults to the approved request's Workspace.
 *  - The setup user can choose another Workspace where they may create
 *    Projects; the Project is created there.
 *  - The Project Request is unchanged (department, status, requester, approver).
 *  - After reload, the Project lists under the NEW Workspace's scope only.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-setup-workspace.ts
 */
import { chromium } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = "BvSetupWs123!";
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], requests: [] as string[], expense: [] as string[] };
  const browser = await chromium.launch();
  try {
    const deptA = await createDepartment({ name: `BV SetupWs A ${RUN_ID}`, slug: `bv-setupws-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `BV SetupWs B ${RUN_ID}`, slug: `bv-setupws-b-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id);
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mkRole = async (tag: string, keys: string[]) => {
      const r = await prisma.customRole.create({ data: { key: `BV_SETUPWS_${tag}_${RUN_ID}`, name: `BV SetupWs ${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
      ids.roles.push(r.id); ids.roleKeys.push(r.key);
      for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
      return r;
    };
    const approveRole = await mkRole("APPROVE", ["projectRequest.approve", "project.view"]);
    const createRole = await mkRole("CREATE", ["project.create", "project.view", "project.edit"]);
    const setupUser = await prisma.user.create({ data: { email: `bv-setupws-${RUN_ID}@kinsen.gr`, name: `BV SetupWs User ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
    const requester = await prisma.user.create({ data: { email: `bv-setupws-req-${RUN_ID}@kinsen.gr`, name: `BV SetupWs Requester ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ids.users.push(setupUser.id, requester.id);
    await prisma.departmentMembership.create({ data: { userId: setupUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, customRoleId: approveRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    await prisma.departmentMembership.create({ data: { userId: setupUser.id, departmentId: deptB.id, role: DepartmentRole.VIEWER, customRoleId: createRole.id, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    const expense = await prisma.projectExpenseType.create({ data: { name: `BV SetupWs Expense ${RUN_ID}` } });
    ids.expense.push(expense.id);
    const request = await prisma.projectRequest.create({ data: { title: `BV SetupWs Request ${RUN_ID}`, description: "Filed under the wrong department.", importance: 2, departmentId: deptA.id, requesterId: requester.id, approverId: setupUser.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(request.id);
    const before = await prisma.projectRequest.findUniqueOrThrow({ where: { id: request.id }, select: { departmentId: true, status: true, requesterId: true, approverId: true, approvedAt: true } });

    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", setupUser.email);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);

    console.log("\n=== Project Setup Workspace ===\n");
    await page.goto(`${BASE_URL}/projects/new?projectRequestId=${request.id}`);
    await page.waitForSelector("#expected-start", { timeout: 60000 });
    const wsField = page.locator("label", { hasText: /^Workspace/ }).locator("xpath=..");
    const wsCombo = wsField.getByRole("combobox");
    check("Workspace selector shown on the setup form, preselected to the request's Workspace", (await wsCombo.innerText()).includes(deptA.name) && (await wsField.getByText("Defaults to the Project Request's Workspace").count()) === 1);
    await wsCombo.click();
    const options = page.getByRole("option");
    const optionTexts = await options.allInnerTexts();
    check("Options = the request's Workspace + Workspaces where the user may create Projects", optionTexts.some((t) => t.includes(deptA.name)) && optionTexts.some((t) => t.includes(deptB.name)), JSON.stringify(optionTexts));
    await page.getByRole("option", { name: new RegExp(deptB.name) }).click();
    check("After choosing B, the field shows B and explains the request itself is unchanged", (await wsCombo.innerText()).includes(deptB.name) && (await wsField.getByText(/Changed from the request's Workspace/).count()) === 1);

    await page.locator('input[placeholder="Search by name or email…"]').first().fill(setupUser.email);
    await page.locator("#project-owners").getByRole("checkbox").first().check();
    await page.fill("#expected-start", "2027-01-04");
    await page.fill("#expected-finish", "2027-01-15");
    await page.locator("#expense-type").click();
    await page.getByRole("option", { name: expense.name }).click();
    const [setupReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/project-requests/${request.id}/project`) && r.method() === "POST", { timeout: 20000 }),
      page.getByRole("button", { name: "Create Project" }).click(),
    ]);
    check("Setup POST carries the chosen destination departmentId (B)", (setupReq.postDataJSON() as Record<string, unknown>).departmentId === deptB.id);
    await page.waitForURL(/\/projects\/[a-z0-9]+$/, { timeout: 30000 });
    const project = await prisma.project.findFirst({ where: { projectRequestId: request.id } });
    check("Project created in the chosen Workspace (B) and linked to the request", !!project && project.departmentId === deptB.id);
    const after = await prisma.projectRequest.findUniqueOrThrow({ where: { id: request.id }, select: { departmentId: true, status: true, requesterId: true, approverId: true, approvedAt: true } });
    check("The Project Request is unchanged (department A, status, requester, approver, approval time)", JSON.stringify(after) === JSON.stringify(before));

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.goto(`${BASE_URL}/projects?departmentId=${deptB.id}`);
    await page.getByRole("heading", { name: /Projects/ }).first().waitFor({ timeout: 60000 });
    const inB = await page.getByText(project?.title ?? "∅").first().isVisible().catch(() => false);
    await page.goto(`${BASE_URL}/projects?departmentId=${deptA.id}`);
    await page.getByRole("heading", { name: /Projects/ }).first().waitFor({ timeout: 60000 });
    const inA = (await page.getByText(project?.title ?? "∅").count()) > 0;
    check("After reload: the Project lists under Workspace B and not under the request's Workspace A", inB && !inA, JSON.stringify({ inB, inA }));
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["expense", () => prisma.projectExpenseType.deleteMany({ where: { id: { in: ids.expense } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roles } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
