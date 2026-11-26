/**
 * Real-browser acceptance for:
 *  - Permissions tab: projectRequest.skipFinalApproval listed under Project
 *    Requests; an administrator assigns and revokes it on a Department role.
 *  - Project Request form: "Skip Intermediate Approval" for every requester;
 *    "Skip Final Approval" only for the department where the requester holds
 *    the permission, re-evaluated when the department changes; server-side
 *    rejection after revocation.
 *  - Skipped stages displayed as "Skipped" (never "Approved by …").
 *  - Owner(s) editing on an existing Request-origin Project (persisted after
 *    reload); no Owner picker on standalone Projects.
 *
 * Usage: BASE_URL=http://localhost:3000 [SHOT_DIR=…] npx tsx scripts/browser-verify-project-request-skip-stages-and-owners.ts
 */
import { chromium, type Page } from "playwright";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || "reports/browser-verify-skip-stages";
const RUN_ID = Date.now();
const PASSWORD = "BvSkip123!";
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const ids = { depts: [] as string[], users: [] as string[], roleIds: [] as string[], roleKeys: [] as string[], projects: [] as string[], requests: [] as string[] };
  const browser = await chromium.launch();
  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mkUser = async (tag: string, role: Role = Role.USER) => {
    const u = await prisma.user.create({ data: { email: `bv-skip-${tag}-${RUN_ID}@kinsen.gr`, name: `BV Skip ${tag}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } });
    ids.users.push(u.id);
    return u;
  };
  const login = async (page: Page, email: string) => {
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", email);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }), page.click('button:has-text("Sign in as Admin")')]);
  };
  const errors: string[] = [];
  const newPage = async (email: string) => {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await login(p, email);
    return p;
  };

  try {
    const deptA = await createDepartment({ name: `BV Skip A ${RUN_ID}`, slug: `bv-skip-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `BV Skip B ${RUN_ID}`, slug: `bv-skip-b-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id);
    const skipRole = await prisma.customRole.create({ data: { key: `BV_SKIPFINAL_${RUN_ID}`, name: `BV SkipFinal ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
    ids.roleIds.push(skipRole.id); ids.roleKeys.push(skipRole.key);
    const admin = await mkUser("admin", Role.ADMIN);
    const requester = await mkUser("requester");
    await prisma.departmentMembership.create({ data: { userId: requester.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, customRoleId: skipRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    await prisma.departmentMembership.create({ data: { userId: requester.id, departmentId: deptB.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    const plain = await mkUser("plain");
    await prisma.departmentMembership.create({ data: { userId: plain.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    const o1 = await mkUser("owner1"), o2 = await mkUser("owner2"), o3 = await mkUser("owner3");
    const pr = await prisma.projectRequest.create({ data: { title: `BV Skip Origin Request ${RUN_ID}`, departmentId: deptA.id, requesterId: plain.id, status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const ro = await prisma.project.create({ data: { title: `BV Skip Request-origin ${RUN_ID}`, departmentId: deptA.id, ownerId: o1.id, owners: { connect: [{ id: o1.id }] }, projectRequestId: pr.id } });
    const sa = await prisma.project.create({ data: { title: `BV Skip Standalone ${RUN_ID}`, departmentId: deptA.id, ownerId: admin.id, owners: { connect: [{ id: admin.id }] } } });
    ids.projects.push(ro.id, sa.id);

    // ═══ 1. Permissions tab — assign ═══
    console.log("\n=== 1. Permissions tab: assign Skip Final Approval to a Department role ===\n");
    const ap = await newPage(admin.email);
    await ap.goto(`${BASE_URL}/admin/roles`);
    await ap.getByRole("button", { name: "Department Roles" }).click();
    await ap.getByText(skipRole.name, { exact: true }).first().click();
    const permLabel = ap.locator("label", { hasText: "projectRequest.skipFinalApproval" });
    await permLabel.waitFor({ timeout: 30000 });
    check("Permission listed with its description (display name + purpose)", (await permLabel.innerText()).includes("Skip Final Approval — Allows users to bypass the final approval stage when creating a Project Request."));
    check("...in the Project Requests category", (await ap.locator("div", { has: ap.getByText("Project Requests", { exact: true }) }).filter({ has: permLabel }).count()) > 0);
    check("...unassigned by default", !(await permLabel.locator("input[type=checkbox]").isChecked()));
    await ap.screenshot({ path: `${SHOT_DIR}/01-permissions-tab.png`, fullPage: true });
    await Promise.all([ap.waitForResponse((r) => r.url().includes("/api/admin/") && ["POST", "PUT", "PATCH", "DELETE"].includes(r.request().method()), { timeout: 20000 }), permLabel.locator("input[type=checkbox]").click()]);
    await ap.waitForTimeout(500);
    check("Admin assigned it through the UI (RolePermission row exists)", (await prisma.rolePermission.count({ where: { roleKey: skipRole.key, permission: { key: "projectRequest.skipFinalApproval" } } })) === 1);

    // ═══ 2. Requester with the Department-scoped grant ═══
    console.log("\n=== 2. Request form: checkboxes, department re-validation, both stages skipped ===\n");
    const rp = await newPage(requester.email);
    const pickDept = async (name: string) => {
      await rp.locator("#departmentId").click();
      await rp.getByRole("option", { name }).click();
    };
    await rp.goto(`${BASE_URL}/project-requests/new`);
    await rp.waitForSelector("#title", { timeout: 30000 });
    check("Skip Intermediate Approval checkbox shown, unchecked by default", (await rp.locator("#skipIntermediateApproval").count()) === 1 && !(await rp.locator("#skipIntermediateApproval").isChecked()));
    await pickDept(deptA.name);
    check("Department A (granted): Skip Final Approval shown, unchecked by default", (await rp.locator("#skipFinalApproval").count()) === 1 && !(await rp.locator("#skipFinalApproval").isChecked()));
    await rp.check("#skipFinalApproval");
    await pickDept(deptB.name);
    check("Switching to department B (not granted) hides Skip Final Approval", (await rp.locator("#skipFinalApproval").count()) === 0);
    await pickDept(deptA.name);
    check("Back to A: shown again but reset to unchecked (decision re-validated)", (await rp.locator("#skipFinalApproval").count()) === 1 && !(await rp.locator("#skipFinalApproval").isChecked()));
    await rp.fill("#title", `BV Both Skipped ${RUN_ID}`);
    await rp.fill("#description", "Both approval stages skipped via the UI.");
    await rp.check("#skipIntermediateApproval");
    await rp.check("#skipFinalApproval");
    check("Workflow summary reads 'Approved' only", (await rp.getByTestId("approval-workflow-summary").innerText()).trim() === "Workflow: Approved");
    await rp.screenshot({ path: `${SHOT_DIR}/02-request-form-both-skipped.png`, fullPage: true });
    const [bothRes] = await Promise.all([rp.waitForResponse((r) => r.url().endsWith("/api/project-requests") && r.request().method() === "POST"), rp.getByRole("button", { name: "Submit Request" }).click()]);
    const both = await bothRes.json();
    if (both.id) ids.requests.push(both.id);
    await rp.waitForURL((u) => u.pathname === `/project-requests/${both.id}`, { timeout: 30000 });
    const bothRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: both.id } });
    check("Both skipped -> APPROVED immediately, no approver/approval time fabricated", bothRow.status === "APPROVED" && bothRow.approverId === null && bothRow.approvedAt === null && bothRow.finalApprovalSkippedById === requester.id);
    const bothText = await rp.locator("main").innerText();
    check("Detail page shows both stages as 'Skipped' and never 'Approved by'", (bothText.match(/Skipped/g) ?? []).length >= 2 && !bothText.includes("Approved by"));
    await rp.screenshot({ path: `${SHOT_DIR}/03-detail-both-skipped.png`, fullPage: true });

    // ═══ 3. Plain requester ═══
    console.log("\n=== 3. Plain requester: Skip Intermediate only ===\n");
    const pp = await newPage(plain.email);
    await pp.goto(`${BASE_URL}/project-requests/new`);
    await pp.waitForSelector("#title", { timeout: 30000 });
    check("Plain requester sees Skip Intermediate Approval but NOT Skip Final Approval", (await pp.locator("#skipIntermediateApproval").count()) === 1 && (await pp.locator("#skipFinalApproval").count()) === 0);
    check("Default workflow summary: Intermediate → Final → Approved", (await pp.getByTestId("approval-workflow-summary").innerText()).includes("Intermediate Approval → Final Approval → Approved"));
    await pp.fill("#title", `BV Skip Intermediate ${RUN_ID}`);
    await pp.fill("#description", "Intermediate approval skipped by a plain requester.");
    await pp.check("#skipIntermediateApproval");
    const [ipRes] = await Promise.all([pp.waitForResponse((r) => r.url().endsWith("/api/project-requests") && r.request().method() === "POST"), pp.getByRole("button", { name: "Submit Request" }).click()]);
    const ip = await ipRes.json();
    if (ip.id) ids.requests.push(ip.id);
    await pp.waitForURL((u) => u.pathname === `/project-requests/${ip.id}`, { timeout: 30000 });
    const ipText = await pp.locator("main").innerText();
    check("Submitted -> detail shows Intermediate 'Skipped — skipped by the requester' and Final still pending", ipText.includes("skipped by the requester at submission") && ipText.includes("Awaiting approval"));
    const forgedRes = await pp.request.post(`${BASE_URL}/api/project-requests`, { data: { title: `BV Forged ${RUN_ID}`, description: "Forged skip final attempt via API.", importance: 2, replacesExisting: false, intermediateApproverIds: [], skipIntermediateApproval: true, skipFinalApproval: true } });
    check("Direct API attempt to skip Final Approval without the permission -> 403", forgedRes.status() === 403);

    // ═══ 4. Revoke ═══
    console.log("\n=== 4. Permissions tab: revoke; requester loses the option ===\n");
    await ap.reload();
    await ap.getByRole("button", { name: "Department Roles" }).click();
    await ap.getByText(skipRole.name, { exact: true }).first().click();
    await permLabel.waitFor({ timeout: 30000 });
    await permLabel.locator("input[type=checkbox]").click();
    await ap.getByRole("dialog").getByText("Remove Permission").first().waitFor({ timeout: 10000 });
    await Promise.all([ap.waitForResponse((r) => r.url().includes("/api/admin/") && r.request().method() === "DELETE", { timeout: 20000 }), ap.getByRole("button", { name: "Remove Permission" }).click()]);
    await ap.waitForTimeout(500);
    check("Admin revoked it through the UI (confirmation dialog)", (await prisma.rolePermission.count({ where: { roleKey: skipRole.key, permission: { key: "projectRequest.skipFinalApproval" } } })) === 0);
    await rp.goto(`${BASE_URL}/project-requests/new`);
    await rp.waitForSelector("#title", { timeout: 30000 });
    await pickDept(deptA.name);
    check("After revocation the requester no longer sees Skip Final Approval", (await rp.locator("#skipFinalApproval").count()) === 0);
    const afterRevoke = await rp.request.post(`${BASE_URL}/api/project-requests`, { data: { title: `BV After revoke ${RUN_ID}`, description: "Attempt after the permission was revoked.", importance: 2, replacesExisting: false, intermediateApproverIds: [], departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true } });
    check("...and the API rejects it -> 403", afterRevoke.status() === 403);

    // ═══ 5. Approver view of the both-skipped request ═══
    await ap.goto(`${BASE_URL}/project-requests/${both.id}`);
    check("An approver sees 'Complete Project Setup' on the both-skipped request (workflow complete, nothing auto-created)", await ap.getByRole("link", { name: "Complete Project Setup" }).isVisible());

    // ═══ 6. Owners ═══
    console.log("\n=== 6. Owner(s) editing on an existing Request-origin Project ===\n");
    await ap.goto(`${BASE_URL}/projects/${ro.id}/edit`);
    await ap.waitForSelector("#project-owners", { timeout: 30000 });
    const ownerBox = (name: string) => ap.locator("#project-owners label", { hasText: name }).locator("input[type=checkbox]");
    check("Owner(s) picker shown with the current owner selected", await ownerBox(o1.name!).isChecked());
    await ownerBox(o1.name!).uncheck();
    await ownerBox(o2.name!).check();
    await ownerBox(o3.name!).check();
    await ap.screenshot({ path: `${SHOT_DIR}/04-edit-owners.png`, fullPage: true });
    await ap.getByRole("button", { name: "Save Changes" }).click();
    await ap.waitForURL((u) => u.pathname === `/projects/${ro.id}`, { timeout: 30000 });
    const owned = await prisma.project.findUniqueOrThrow({ where: { id: ro.id }, include: { owners: true } });
    check("Saved: owners = owner2 + owner3, primary moved off owner1", owned.owners.map((o) => o.id).sort().join() === [o2.id, o3.id].sort().join() && owned.ownerId !== o1.id);
    await ap.goto(`${BASE_URL}/projects/${ro.id}/edit`);
    await ap.waitForSelector("#project-owners", { timeout: 30000 });
    check("Persisted after reload (owner2 + owner3 checked, owner1 not)", (await ownerBox(o2.name!).isChecked()) && (await ownerBox(o3.name!).isChecked()) && !(await ownerBox(o1.name!).isChecked()));
    await ap.goto(`${BASE_URL}/projects/${ro.id}`);
    check("Project detail lists the new owners", (await ap.locator("main").innerText()).includes(o2.name!) && (await ap.locator("main").innerText()).includes(o3.name!));
    await ap.goto(`${BASE_URL}/projects/${sa.id}/edit`);
    await ap.waitForSelector("#title", { timeout: 30000 });
    await ap.waitForTimeout(800);
    check("Standalone Project edit page has no Owner(s) picker (unchanged)", (await ap.locator("#project-owners").count()) === 0);
    check("No uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { OR: [{ id: { in: ids.projects } }, { projectRequestId: { in: ids.requests } }] } })],
      ["requests by fixture users", async () => { const extra = await prisma.projectRequest.findMany({ where: { requesterId: { in: ids.users } }, select: { id: true } }); ids.requests.push(...extra.map((e) => e.id)); }],
      ["notifications", () => prisma.notification.deleteMany({ where: { OR: [{ link: { in: ids.requests.map((i) => `/project-requests/${i}`) } }, { userId: { in: ids.users } }] } })],
      ["reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["intermediate rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roleIds } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e) { console.warn(`Cleanup ${l} failed:`, e instanceof Error ? e.message : e); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Browser verification crashed:", e); process.exit(1); });
