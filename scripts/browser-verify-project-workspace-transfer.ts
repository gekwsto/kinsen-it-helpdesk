/**
 * Real-browser acceptance: editable Workspace in Project Edit (Workspace
 * transfer of a Project and all its Activities).
 *  - Workspace field in the general section, preselected to the persisted one.
 *  - Choosing another Workspace + Save → confirmation dialog with source,
 *    destination, Activity count and linked-Ticket count; Cancel saves nothing.
 *  - Confirm → Project + Activities in the destination, Ticket stays put;
 *    persists after reload; works for manual and Request-origin Projects.
 *  - Source-Workspace Project and Activity lists refresh live (realtime).
 *  - An unchanged save has no dialog and no departmentId in the payload.
 *  - A user without destination rights gets no transfer options.
 *  - The user's active Workspace (cookie) is not changed.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-workspace-transfer.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { ActivityPriority, ActivityStatus, AuthProvider, DepartmentRole, MembershipSource, ProjectStatus, Role, TicketSource } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = "BvTransfer123!";
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], projects: [] as string[], activities: [] as string[], tickets: [] as string[], requests: [] as string[], subDepts: [] as string[] };
  const browser = await chromium.launch();
  try {
    const deptA = await createDepartment({ name: `BV Transfer A ${RUN_ID}`, slug: `bv-transfer-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `BV Transfer B ${RUN_ID}`, slug: `bv-transfer-b-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id);
    const subA = await prisma.subDepartment.create({ data: { name: `BV SubA ${RUN_ID}`, departmentId: deptA.id } });
    ids.subDepts.push(subA.id);
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mkRole = async (tag: string, keys: string[]) => {
      const r = await prisma.customRole.create({ data: { key: `BV_TRANSFER_${tag}_${RUN_ID}`, name: `BV Transfer ${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
      ids.roles.push(r.id); ids.roleKeys.push(r.key);
      for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
      return r;
    };
    const fullRole = await mkRole("FULL", ["project.view", "project.create", "project.edit", "activity.view", "activity.edit", "gantt.view"]);
    const editOnlyRole = await mkRole("EDITONLY", ["project.view", "project.edit", "activity.view"]);
    const mkUser = async (tag: string) => { const u = await prisma.user.create({ data: { email: `bv-transfer-${tag}-${RUN_ID}@kinsen.gr`, name: `BV Transfer ${tag} ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } }); ids.users.push(u.id); return u; };
    const membership = (userId: string, departmentId: string, customRoleId: string, isPrimary = false) => prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary, isActive: true } });
    const editor = await mkUser("editor");
    await membership(editor.id, deptA.id, fullRole.id, true);
    await membership(editor.id, deptB.id, fullRole.id);
    const sourceOnly = await mkUser("sourceonly");
    await membership(sourceOnly.id, deptA.id, editOnlyRole.id, true);

    const project = await prisma.project.create({ data: { title: `BV Transfer Manual ${RUN_ID}`, departmentId: deptA.id, subDepartmentId: subA.id, ownerId: editor.id, owners: { connect: [{ id: editor.id }] }, status: ProjectStatus.IN_PROGRESS, startDate: D("2027-01-04"), endDate: D("2027-01-29") } });
    ids.projects.push(project.id);
    const a1 = await prisma.projectActivity.create({ data: { title: `BV Transfer Act1 ${RUN_ID}`, projectId: project.id, departmentId: deptA.id, subDepartmentId: subA.id, status: ActivityStatus.COMPLETED, isCompleted: true, completedAt: D("2027-01-10"), priority: ActivityPriority.MEDIUM, startDate: D("2027-01-04"), dueDate: D("2027-01-08") } });
    const a2 = await prisma.projectActivity.create({ data: { title: `BV Transfer Act2 ${RUN_ID}`, projectId: project.id, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.HIGH, startDate: D("2027-01-11"), dueDate: D("2027-01-15") } });
    ids.activities.push(a1.id, a2.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id } });
    const ticket = await prisma.ticket.create({ data: { title: `BV Transfer Ticket ${RUN_ID}`, description: "linked", source: TicketSource.WEB, requesterId: editor.id, departmentId: deptA.id, statusId: status.id, projectId: project.id } });
    ids.tickets.push(ticket.id);
    const pr = await prisma.projectRequest.create({ data: { title: `BV Transfer Request ${RUN_ID}`, departmentId: deptA.id, requesterId: editor.id, approverId: editor.id, approvedAt: D("2026-11-01"), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const ro = await prisma.project.create({ data: { title: `BV Transfer RO ${RUN_ID}`, departmentId: deptA.id, ownerId: editor.id, owners: { connect: [{ id: editor.id }] }, projectRequestId: pr.id, expectedStartDate: D("2027-02-01"), expectedFinishDate: D("2027-02-12"), expectedTotalInitialDays: 9 } });
    ids.projects.push(ro.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = async (page: Page, email: string) => {
      await page.goto(`${BASE_URL}/login`);
      await page.fill("#credentials-email", email);
      await page.fill("#credentials-password", PASSWORD);
      await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
    };
    const page = await context.newPage();
    await login(page, editor.email);
    await context.addCookies([{ name: "active_department_id", value: deptA.id, url: BASE_URL }]);

    // Source-Workspace lists open in other tabs — they must refresh live.
    const projectsA = await context.newPage();
    await projectsA.goto(`${BASE_URL}/projects?departmentId=${deptA.id}`);
    await projectsA.getByText(project.title).first().waitFor({ timeout: 60000 });
    const activitiesA = await context.newPage();
    await activitiesA.goto(`${BASE_URL}/activities?departmentId=${deptA.id}`);
    await activitiesA.getByText(a2.title).first().waitFor({ timeout: 60000 });

    console.log("\n=== Project Edit: Workspace transfer (manual Project) ===\n");
    await page.bringToFront();
    await page.goto(`${BASE_URL}/projects/${project.id}/edit`);
    const field = page.getByTestId("project-workspace-field");
    await field.waitFor({ timeout: 60000 });
    const combo = field.getByRole("combobox");
    check("Workspace field shown in the general section, preselected to the persisted Workspace (A)", (await combo.innerText()).includes(deptA.name));
    await combo.click();
    await page.getByRole("option", { name: new RegExp(deptB.name) }).click();
    check("After choosing B, the helper explains the transfer (2 Activities)", (await field.innerText()).includes("2 Activities will be transferred"));
    let patchSent = false;
    page.on("request", (r) => { if (r.url().endsWith(`/api/projects/${project.id}`) && r.method() === "PATCH") patchSent = true; });
    await page.getByRole("button", { name: "Save Changes" }).click();
    const dialog = page.getByTestId("workspace-transfer-dialog");
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    check("Confirmation dialog: source A, destination B, 2 Activities, 1 linked Ticket staying put",
      (await dialog.getByTestId("transfer-source").innerText()) === deptA.name && (await dialog.getByTestId("transfer-destination").innerText()) === deptB.name && (await dialog.getByTestId("transfer-activity-count").innerText()) === "2" && (await dialog.getByTestId("transfer-ticket-count").innerText()).startsWith("1"));
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    check("Cancel: nothing sent, Project still in A", !patchSent && (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).departmentId === deptA.id);

    await page.getByRole("button", { name: "Save Changes" }).click();
    await dialog.waitFor({ state: "visible" });
    const [patch] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === "PATCH", { timeout: 30000 }),
      dialog.getByRole("button", { name: "Transfer and save" }).click(),
    ]);
    const body = patch.request().postDataJSON();
    check("Confirm: PATCH carries departmentId B and a cleared sub-department → 200", patch.ok() && body.departmentId === deptB.id && body.subDepartmentId === null, `${patch.status()} ${JSON.stringify({ d: body.departmentId, s: body.subDepartmentId })}`);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const acts = await prisma.projectActivity.findMany({ where: { projectId: project.id } });
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    check("Project and BOTH Activities (completed included) now in B; invalid sub-departments cleared", p.departmentId === deptB.id && p.subDepartmentId === null && acts.length === 2 && acts.every((a) => a.departmentId === deptB.id && a.subDepartmentId === null));
    check("Linked Ticket stays in A with its link intact", t.departmentId === deptA.id && t.projectId === project.id);

    await projectsA.getByText(project.title).first().waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
    check("Source Project list (A) refreshed live: the Project is gone without a reload", (await projectsA.getByText(project.title).count()) === 0);
    await activitiesA.getByText(a2.title).first().waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
    check("Source Activity list (A) refreshed live: the transferred Activities are gone without a reload", (await activitiesA.getByText(a2.title).count()) === 0 && (await activitiesA.getByText(a1.title).count()) === 0);
    const projectsB = await context.newPage();
    await projectsB.goto(`${BASE_URL}/projects?departmentId=${deptB.id}`);
    check("Destination Project list (B) shows it", await projectsB.getByText(project.title).first().isVisible({ timeout: 60000 }).catch(() => false));
    await projectsB.goto(`${BASE_URL}/projects/gantt?departmentId=${deptB.id}`);
    await projectsB.getByTestId("timeline-mode-toggle").waitFor({ timeout: 60000 });
    check("Project Gantt (B) shows the Project and both Activities", (await projectsB.getByRole("link", { name: project.title, exact: true }).count()) > 0 && (await projectsB.getByRole("link", { name: a1.title, exact: true }).count()) > 0 && (await projectsB.getByRole("link", { name: a2.title, exact: true }).count()) > 0);
    const cookie = (await context.cookies(BASE_URL)).find((c) => c.name === "active_department_id");
    check("The user's active Workspace was NOT changed (still A)", cookie?.value === deptA.id);
    // Each tab holds long-lived SSE streams (notifications + list refresh);
    // close the helper tabs so they don't exhaust the browser's per-origin
    // HTTP/1.1 connection pool for the main tab.
    await Promise.all([projectsA.close(), activitiesA.close(), projectsB.close()]);

    await page.goto(`${BASE_URL}/projects/${project.id}/edit`);
    await field.waitFor({ timeout: 60000 });
    check("After reload the Edit page shows the persisted Workspace (B)", (await field.getByRole("combobox").innerText()).includes(deptB.name));
    await page.fill("#title", `${project.title} renamed`);
    let dialogShown = false;
    const [plain] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}`) && r.request().method() === "PATCH", { timeout: 30000 }),
      (async () => { await page.getByRole("button", { name: "Save Changes" }).click(); dialogShown = await dialog.isVisible().catch(() => false); })(),
    ]);
    check("Save without a Workspace change: no dialog, no departmentId in the payload, 200", plain.ok() && !dialogShown && !("departmentId" in plain.request().postDataJSON()));

    console.log("\n=== Request-origin Project ===\n");
    await page.goto(`${BASE_URL}/projects/${ro.id}/edit`);
    await field.waitFor({ timeout: 60000 });
    await field.getByRole("combobox").click();
    await page.getByRole("option", { name: new RegExp(deptB.name) }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await dialog.waitFor({ state: "visible" });
    const [roPatch] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${ro.id}`) && r.request().method() === "PATCH", { timeout: 30000 }),
      dialog.getByRole("button", { name: "Transfer and save" }).click(),
    ]);
    const roAfter = await prisma.project.findUniqueOrThrow({ where: { id: ro.id } });
    const prAfter = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr.id } });
    check("Request-origin Project transferred to B; Expected Total Initial Days unchanged; Project Request still in A", roPatch.ok() && roAfter.departmentId === deptB.id && roAfter.expectedTotalInitialDays === 9 && prAfter.departmentId === deptA.id && prAfter.status === "APPROVED");

    console.log("\n=== No destination rights ===\n");
    const otherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sp = await otherContext.newPage();
    const extra = await prisma.project.create({ data: { title: `BV Transfer SourceOnly ${RUN_ID}`, departmentId: deptA.id, ownerId: sourceOnly.id, owners: { connect: [{ id: sourceOnly.id }] } } });
    ids.projects.push(extra.id);
    await login(sp, sourceOnly.email);
    await sp.goto(`${BASE_URL}/projects/${extra.id}/edit`);
    const spField = sp.getByTestId("project-workspace-field");
    await spField.waitFor({ timeout: 60000 });
    check("A user with project.edit but no project.create anywhere else sees the Workspace but cannot change it (selector disabled)", await spField.getByRole("combobox").isDisabled());
    await otherContext.close();
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ids.tickets } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["sub depts", () => prisma.subDepartment.deleteMany({ where: { id: { in: ids.subDepts } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
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
