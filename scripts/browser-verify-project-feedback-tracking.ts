/**
 * Real-browser acceptance for persistent Feedback obligations + the
 * Administration -> Project Feedback "Feedback Tracking" overview:
 *  - Completing a request-origin Project through the real Edit page creates
 *    obligations for its active Responsible People (tracked).
 *  - Each recipient submits independently; Admin shows submitted / required,
 *    pending names and In progress -> Complete.
 *  - A requested recipient removed from Responsible People can still open
 *    and submit their own Feedback; a newly added one is redirected away.
 *  - "No eligible active recipients" vs "Not tracked (historical)".
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-feedback-tracking.ts
 */
import { chromium, type Browser, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, ProjectStatus, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const TAG = `BV FbTrack ${RUN_ID}`;
const PASSWORD = "BvFbTrack123!";
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
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
  return page;
}
async function completeViaEditPage(page: Page, projectId: string) {
  await page.goto(`${BASE_URL}/projects/${projectId}/edit`, { waitUntil: "load" });
  await page.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
  await page.locator("label", { hasText: /^Status$/ }).locator("xpath=..").getByRole("combobox").click();
  await page.getByRole("option", { name: "COMPLETED", exact: true }).click();
  await Promise.all([
    page.waitForURL((u) => u.pathname === `/projects/${projectId}`, { timeout: 60000 }),
    page.getByRole("button", { name: /save changes/i }).click(),
  ]);
}
async function submitFeedback(page: Page, projectId: string): Promise<number> {
  await page.goto(`${BASE_URL}/projects/${projectId}/feedback`);
  const submit = page.getByRole("button", { name: "Υποβολή Αξιολόγησης", exact: true });
  await submit.waitFor({ timeout: 60000 });
  for (const [i, q] of QUESTIONS.entries()) {
    const row = page.locator("div.rounded-lg.border", { has: page.locator("label", { hasText: q }) }).last();
    await row.locator(`input[type="radio"][value="${(i % 5) + 1}"]`).click({ force: true });
  }
  await page.getByLabel("Παραδόθηκαν όλες οι συμφωνημένες προδιαγραφές", { exact: true }).check();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/projects/${projectId}/feedback`) && r.request().method() === "POST"),
    submit.click(),
  ]);
  return res.status();
}
async function trackingRow(page: Page, deptId: string, projectId: string) {
  await page.goto(`${BASE_URL}/admin/project-feedback?departmentId=${deptId}`, { waitUntil: "load" });
  const row = page.getByTestId("feedback-tracking-table").locator(`tr[data-project-id="${projectId}"]`);
  await row.waitFor({ timeout: 60000 });
  const text = async (id: string) => (await row.getByTestId(id).innerText()).trim();
  return { status: await text("tracking-status"), counts: await text("tracking-counts"), required: await text("tracking-required"), submitted: await text("tracking-submitted"), pending: await text("tracking-pending") };
}

async function main() {
  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], requests: [] as string[] };
  const browser = await chromium.launch();
  try {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mkUser = async (tag: string, role: Role = Role.USER, isActive = true) => {
      const u = await prisma.user.create({ data: { email: `bv-fbtrack-${tag}-${RUN_ID}@kinsen.gr`, name: `${TAG} ${tag}`, role, authProvider: AuthProvider.CREDENTIALS, isActive, passwordHash: hash } });
      ids.users.push(u.id);
      return u;
    };
    const dept = await createDepartment({ name: `${TAG} Dept`, slug: `bv-fbtrack-${RUN_ID}` });
    ids.depts.push(dept.id);
    const admin = await mkUser("admin", Role.ADMIN);
    const owner = await mkUser("owner");
    const rp1 = await mkUser("rp1");
    const rp2 = await mkUser("rp2");
    const rp3 = await mkUser("rp3");
    const gone = await mkUser("inactive", Role.USER, false);
    const mkProject = async (tag: string, rps: { id: string }[], status: ProjectStatus = ProjectStatus.IN_PROGRESS) => {
      const pr = await prisma.projectRequest.create({ data: { title: `${TAG} ${tag}`, departmentId: dept.id, requesterId: owner.id, approverId: admin.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
      ids.requests.push(pr.id);
      const p = await prisma.project.create({ data: { title: `${TAG} ${tag}`, departmentId: dept.id, ownerId: owner.id, owners: { connect: [{ id: owner.id }] }, projectRequestId: pr.id, status, responsiblePeople: { connect: rps.map((r) => ({ id: r.id })) } } });
      ids.projects.push(p.id);
      return p.id;
    };
    const pTracked = await mkProject("tracked", [rp1, rp2]);
    const pZero = await mkProject("zero", [gone]);
    const pHist = await mkProject("historical", [], ProjectStatus.COMPLETED);
    const pMixed = await mkProject("mixed", [rp1, gone]);

    console.log("\n=== 1. Completion through the real Edit page creates obligations ===\n");
    const ap = await login(browser, admin.email);
    await completeViaEditPage(ap, pTracked);
    // Existing inactive Responsible People are retained: shown, selected and
    // labelled "(inactive)" in the Edit page, and the Project saves/completes.
    await ap.goto(`${BASE_URL}/projects/${pZero}/edit`, { waitUntil: "load" });
    await ap.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
    const goneRow = ap.locator('#project-responsible-people label[data-inactive="true"]', { hasText: gone.name! });
    await goneRow.waitFor({ timeout: 30000 });
    check("Edit page keeps the existing INACTIVE Responsible Person visible, selected and labelled '(inactive)'", (await goneRow.locator('input[type="checkbox"]').isChecked()) && (await goneRow.innerText()).includes("(inactive)"));
    await completeViaEditPage(ap, pZero);
    const zeroRps = (await prisma.project.findUniqueOrThrow({ where: { id: pZero }, select: { status: true, responsiblePeople: { select: { id: true } } } }));
    check("All-inactive Responsible People: completing via the Edit page succeeds and keeps the relationship", zeroRps.status === "COMPLETED" && JSON.stringify(zeroRps.responsiblePeople.map((r) => r.id)) === JSON.stringify([gone.id]));
    const oblig = (await prisma.projectFeedbackRequest.findMany({ where: { projectId: pTracked } })).map((o) => o.userId).sort();
    check("Completing via the Edit page persisted obligations for both active Responsible People", JSON.stringify(oblig) === JSON.stringify([rp1.id, rp2.id].sort()));
    let r = await trackingRow(ap, dept.id, pTracked);
    check("Admin tracking: 'In progress', 0 / 2, both recipients listed as required and pending", r.status === "In progress" && r.counts === "0 / 2" && r.required.includes(rp1.name!) && r.required.includes(rp2.name!) && r.pending.includes(rp1.name!) && r.pending.includes(rp2.name!), JSON.stringify(r));

    console.log("\n=== 2. Independent submissions ===\n");
    const p1 = await login(browser, rp1.email);
    check("Recipient 1 submits their own Feedback (201)", (await submitFeedback(p1, pTracked)) === 201);
    r = await trackingRow(ap, dept.id, pTracked);
    check("Admin tracking: 'In progress', 1 / 2; recipient 1 submitted, recipient 2 pending", r.status === "In progress" && r.counts === "1 / 2" && r.submitted.includes(rp1.name!) && r.pending.includes(rp2.name!) && !r.pending.includes(rp1.name!), JSON.stringify(r));

    console.log("\n=== 3. Responsible People changed after completion ===\n");
    await prisma.project.update({ where: { id: pTracked }, data: { responsiblePeople: { set: [{ id: rp1.id }, { id: rp3.id }] } } });
    const p3 = await login(browser, rp3.email);
    await p3.goto(`${BASE_URL}/projects/${pTracked}/feedback`);
    await p3.waitForURL((u) => !u.pathname.endsWith("/feedback"), { timeout: 30000 }).catch(() => undefined);
    check("A Responsible Person added AFTER completion (no obligation) is redirected away from the Feedback page", !new URL(p3.url()).pathname.endsWith("/feedback"), p3.url());
    const p2 = await login(browser, rp2.email);
    check("Recipient 2 — removed from Responsible People after being requested — still submits their own Feedback (201)", (await submitFeedback(p2, pTracked)) === 201);
    r = await trackingRow(ap, dept.id, pTracked);
    check("Admin tracking: 'Complete', 2 / 2, nothing pending (original obligations, not the current Responsible People)", r.status === "Complete" && r.counts === "2 / 2" && r.pending === "—" && !r.required.includes(rp3.name!), JSON.stringify(r));

    console.log("\n=== 4. No eligible active recipients vs historical ===\n");
    const z = await trackingRow(ap, dept.id, pZero);
    check("All-inactive Responsible People: 'No eligible active recipients', 0 / 0", z.status === "No eligible active recipients" && z.counts === "0 / 0", JSON.stringify(z));
    const h = await trackingRow(ap, dept.id, pHist);
    check("Historical Project completed before tracking: 'Not tracked (historical)', no counts", h.status === "Not tracked (historical)" && h.counts === "—", JSON.stringify(h));
    check("No notification was created for the historical or zero-eligible Projects", (await prisma.notification.count({ where: { link: { in: [`/projects/${pHist}/feedback`, `/projects/${pZero}/feedback`] } } })) === 0);
    await ap.getByRole("heading", { name: "Submitted Feedback" }).waitFor({ timeout: 10000 });
    check("The existing Submitted Feedback list still shows both submissions", (await ap.locator("table").nth(1).getByText(`${TAG} tracked`, { exact: true }).count()) === 2);

    console.log("\n=== 5. Mixed active + inactive Responsible People through the Edit page ===\n");
    await completeViaEditPage(ap, pMixed);
    const mixedObl = (await prisma.projectFeedbackRequest.findMany({ where: { projectId: pMixed } })).map((o) => o.userId);
    check("Mixed: completion via the Edit page → obligation for the active Responsible Person only", JSON.stringify(mixedObl) === JSON.stringify([rp1.id]));
    check("...notification only for the active one (none for the inactive one or the Owner)", (await prisma.notification.count({ where: { link: `/projects/${pMixed}/feedback`, userId: rp1.id } })) === 1 && (await prisma.notification.count({ where: { link: `/projects/${pMixed}/feedback`, userId: { in: [gone.id, owner.id] } } })) === 0);
    const m = await trackingRow(ap, dept.id, pMixed);
    check("Admin tracking: 'In progress', 0 / 1; only the active Responsible Person is required/pending (the inactive one was never requested)", m.status === "In progress" && m.counts === "0 / 1" && m.required === rp1.name && m.pending === rp1.name && !JSON.stringify(m).includes(gone.name!), JSON.stringify(m));
    // Remove the inactive Responsible Person through the UI.
    await ap.goto(`${BASE_URL}/projects/${pMixed}/edit`, { waitUntil: "load" });
    await ap.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
    const mixedGoneRow = ap.locator('#project-responsible-people label[data-inactive="true"]', { hasText: gone.name! });
    await mixedGoneRow.waitFor({ timeout: 30000 });
    await mixedGoneRow.locator('input[type="checkbox"]').uncheck();
    await Promise.all([
      ap.waitForURL((u) => u.pathname === `/projects/${pMixed}`, { timeout: 60000 }),
      ap.getByRole("button", { name: /save changes/i }).click(),
    ]);
    const afterRemove = (await prisma.project.findUniqueOrThrow({ where: { id: pMixed }, select: { responsiblePeople: { select: { id: true } } } })).responsiblePeople.map((r) => r.id);
    check("Unticking the inactive Responsible Person and saving removes it (active one kept)", JSON.stringify(afterRemove) === JSON.stringify([rp1.id]));
    await ap.goto(`${BASE_URL}/projects/${pMixed}/edit`, { waitUntil: "load" });
    await ap.getByText("Edit Project", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
    await ap.locator("#project-responsible-people").waitFor({ timeout: 30000 });
    const rpSection = ap.locator("div.space-y-2", { has: ap.locator("#project-responsible-people") }).last();
    await rpSection.getByPlaceholder("Search by name or email…").fill(gone.name!);
    await rpSection.getByText(`No users match "${gone.name}".`).waitFor({ timeout: 10000 }).catch(() => undefined);
    check("After removal the inactive user is NOT offered for re-adding (only active users are listed)", (await ap.locator("#project-responsible-people label", { hasText: gone.name! }).count()) === 0);
    check("...obligations and tracking unchanged by the removal", JSON.stringify((await prisma.projectFeedbackRequest.findMany({ where: { projectId: pMixed } })).map((o) => o.userId)) === JSON.stringify([rp1.id]));
  } finally {
    await browser.close();
    const steps: [string, () => Promise<unknown>][] = [
      ["feedback", () => prisma.projectFeedback.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["obligations", () => prisma.projectFeedbackRequest.deleteMany({ where: { projectId: { in: ids.projects } } })],
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
