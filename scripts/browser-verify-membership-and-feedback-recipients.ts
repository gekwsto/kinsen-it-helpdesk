/**
 * Real-browser acceptance for:
 *  1. User Management → Edit User → Add Membership offers ACTIVE departments
 *     only; an existing membership in an inactive department is still listed.
 *  2. Project Feedback recipient priority: a Responsible Person (no
 *     memberships, not an Owner/Member) sees the Feedback prompt, opens the
 *     form and submits their own Feedback; the primary Owner of a Project
 *     that HAS Responsible People gets no prompt and is redirected away from
 *     the Feedback page.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-membership-and-feedback-recipients.ts
 */
import { chromium, type Browser, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, DepartmentRole, MembershipSource, ProjectStatus, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = "BvMemFb123!";
const QUESTIONS = [
  "Πόσο ικανοποιημένοι είστε με την ταχύτητα παράδοσης του έργου;",
  "Πόσο ικανοποιημένοι είστε με την επικοινωνία με την ομάδα;",
  "Πόσο ικανοποιημένοι είστε με τις λειτουργίες που παραδόθηκαν;",
  "Πόσο ικανοποιημένοι είστε με την ευκολία χρήσης;",
  "Πόσο ικανοποιημένοι είστε συνολικά από την υλοποίηση;",
];
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
async function login(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
  return page;
}

async function main() {
  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], requests: [] as string[] };
  const browser = await chromium.launch();
  try {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mkUser = async (tag: string, role: Role = Role.USER) => { const u = await prisma.user.create({ data: { email: `bv-memfb-${tag}-${RUN_ID}@kinsen.gr`, name: `BV MemFb ${tag} ${RUN_ID}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } }); ids.users.push(u.id); return u; };
    const active = await createDepartment({ name: `BV MemFb Active ${RUN_ID}`, slug: `bv-memfb-active-${RUN_ID}` });
    const inactive = await createDepartment({ name: `BV MemFb Inactive ${RUN_ID}`, slug: `bv-memfb-inactive-${RUN_ID}` });
    ids.depts.push(active.id, inactive.id);
    const admin = await mkUser("admin", Role.ADMIN);
    const target = await mkUser("target");
    await prisma.departmentMembership.create({ data: { userId: target.id, departmentId: inactive.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    await prisma.department.update({ where: { id: inactive.id }, data: { isActive: false } });

    console.log("\n=== 1. Add Membership: active departments only ===\n");
    const ap = await login(browser, admin.email);
    await ap.goto(`${BASE_URL}/admin/users?search=${encodeURIComponent(target.email)}`);
    const row = ap.getByRole("row", { name: new RegExp(target.email.replace(/[.+]/g, "\\$&")) });
    await row.waitFor({ timeout: 60000 });
    await row.getByRole("button").last().click();
    const dialog = ap.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add Membership" }).waitFor({ timeout: 30000 });
    check("Existing membership in the INACTIVE department is still listed in Edit User", (await dialog.getByText(inactive.name).count()) > 0);
    await dialog.getByRole("button", { name: "Add Membership" }).click();
    await dialog.getByRole("combobox").filter({ hasText: "Department…" }).click();
    const options = await ap.getByRole("option").allInnerTexts();
    check("Department dropdown lists the active department but NOT the inactive one", options.includes(active.name) && !options.includes(inactive.name), JSON.stringify(options.filter((o) => o.includes("BV MemFb"))));
    const membershipAfter = await prisma.departmentMembership.findFirst({ where: { userId: target.id, departmentId: inactive.id } });
    check("...the existing inactive-department membership is untouched in the database", membershipAfter?.isActive === true && membershipAfter.role === DepartmentRole.AGENT_ASSIGNEE);

    console.log("\n=== 2. Feedback: Responsible People take priority ===\n");
    const owner = await mkUser("owner");
    const rp = await mkUser("rp"); // no memberships, not an Owner/Member
    const pr = await prisma.projectRequest.create({ data: { title: `BV MemFb Request ${RUN_ID}`, departmentId: active.id, requesterId: owner.id, approverId: admin.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const project = await prisma.project.create({ data: { title: `BV MemFb Project ${RUN_ID}`, departmentId: active.id, ownerId: owner.id, owners: { connect: [{ id: owner.id }] }, projectRequestId: pr.id, status: ProjectStatus.COMPLETED, responsiblePeople: { connect: [{ id: rp.id }] } } });
    ids.projects.push(project.id);

    const rpPage = await login(browser, rp.email);
    await rpPage.goto(`${BASE_URL}/projects/${project.id}`);
    const cta = rpPage.getByRole("link", { name: "Μετάβαση στην Αξιολόγηση", exact: true });
    await cta.waitFor({ timeout: 60000 }).catch(() => undefined);
    check("Responsible Person (no memberships) sees the Feedback prompt on the Project page", (await cta.count()) === 1);
    await rpPage.goto(`${BASE_URL}/projects/${project.id}/feedback`);
    const submit = rpPage.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true });
    await submit.waitFor({ timeout: 60000 });
    for (const [i, q] of QUESTIONS.entries()) {
      const qRow = rpPage.locator("div.rounded-lg.border", { has: rpPage.locator("label", { hasText: q }) }).last();
      await qRow.locator(`input[type="radio"][value="${(i % 5) + 1}"]`).click({ force: true });
    }
    await rpPage.getByLabel("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).check();
    await rpPage.fill("#feedback-comments", "Responsible Person feedback");
    const [res] = await Promise.all([
      rpPage.waitForResponse((r) => r.url().includes(`/api/projects/${project.id}/feedback`) && r.request().method() === "POST"),
      submit.click(),
    ]);
    const rows = await prisma.projectFeedback.findMany({ where: { projectId: project.id } });
    check("Responsible Person submits their Feedback (201) — one row, attributed to them", res.status() === 201 && rows.length === 1 && rows[0].submittedByUserId === rp.id && rows[0].comments === "Responsible Person feedback");

    const ownerPage = await login(browser, owner.email);
    await ownerPage.goto(`${BASE_URL}/projects/${project.id}`);
    await ownerPage.getByRole("heading", { name: project.title }).first().waitFor({ timeout: 60000 });
    check("The primary Owner (not a Responsible Person) sees NO Feedback prompt", (await ownerPage.getByRole("link", { name: "Μετάβαση στην Αξιολόγηση", exact: true }).count()) === 0);
    await ownerPage.goto(`${BASE_URL}/projects/${project.id}/feedback`);
    await ownerPage.waitForURL((u) => !u.pathname.endsWith("/feedback"), { timeout: 30000 }).catch(() => undefined);
    check("...and is redirected away from the Feedback page", !new URL(ownerPage.url()).pathname.endsWith("/feedback"), ownerPage.url());
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["feedback", () => prisma.projectFeedback.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
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
