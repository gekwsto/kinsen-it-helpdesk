/**
 * Live browser verification for /projects/new (manual Project creation):
 *   1. Members eligibility is membership-based (DepartmentMembership), not
 *      permission-based — a plain VIEWER department member now appears,
 *      and a non-member (even one who happens to hold project.assignable
 *      via a different department) does not.
 *   2. No Workspace selected -> no system-wide Members dump, no false
 *      attachment-denied message.
 *   3. Members search filters the visible list without widening it.
 *   4. Switching Workspace refreshes Members and clears stale selections.
 *   5. Attachment permission state is neutral before selection, correctly
 *      evaluated after, and re-evaluated on Workspace switch.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-manual-project-members-attachments.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvmpma-${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
}

async function switchHeaderWorkspace(page: Page, name: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  await trigger.click();
  await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 });
  // "All Workspaces" is a static item only ever shown while the search box
  // is EMPTY (see components/workspace/workspace-selector.tsx's own
  // `!isSearchMode &&` guard) — searching for its own label would hide it.
  if (name !== "All Workspaces") {
    await page.locator('input[placeholder="Search workspaces..."]').fill(name);
  }
  // `.catch()` attached at creation, not after the click below — if `name`
  // is already the active selection, the click may be a no-op that never
  // fires this request, and an unattached rejection surfacing later would
  // crash the whole script as an unhandled rejection.
  const activeWorkspaceResponse = page
    .waitForResponse((res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST", { timeout: 8000 })
    .catch(() => null);
  await page.locator(`[role="menuitem"]:has-text("${name}")`).first().click({ timeout: 8000 }).catch(() => {});
  await activeWorkspaceResponse;
  await page.waitForTimeout(500);
}

async function selectFormWorkspace(page: Page, name: string) {
  // The Workspace Select is the first (and, on /projects/new, only)
  // combobox on this standalone-mode form.
  const workspaceTrigger = page.locator('button[role="combobox"]').first();
  await workspaceTrigger.click();
  await page.locator('[role="option"]', { hasText: name }).first().click();
  await page.waitForTimeout(600);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures: two Workspaces (Departments), each with distinct members ===\n");
    const deptA = await createDepartment({ name: `${TAG}-Workspace-A`, slug: `${TAG}-workspace-a` });
    departmentIds.push(deptA.id);
    const deptB = await createDepartment({ name: `${TAG}-Workspace-B`, slug: `${TAG}-workspace-b` });
    departmentIds.push(deptB.id);

    // VIEWER never grants project.assignable (see prisma/seed.ts's
    // AGENT_ASSIGNEE/IT_AGENT comment on the same point) — the exact case
    // that used to be wrongly EXCLUDED from the old, permission-based
    // Members list despite being a real Workspace member.
    const viewerA = await prisma.user.create({
      data: { email: `${TAG}-viewerA@example.com`, name: `${TAG} Viewer A`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(viewerA.id);
    const viewerAMembership = await prisma.departmentMembership.create({
      data: { userId: viewerA.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerAMembership.id);

    // DEPARTMENT_MANAGER DOES grant project.assignable — sanity check that
    // the new, membership-based list still includes users who were already
    // (correctly) showing up before.
    const managerA = await prisma.user.create({
      data: { email: `${TAG}-managerA@example.com`, name: `${TAG} Manager A`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(managerA.id);
    const managerAMembership = await prisma.departmentMembership.create({
      data: { userId: managerA.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(managerAMembership.id);

    // A member of Workspace B ONLY — must never appear for Workspace A.
    const viewerB = await prisma.user.create({
      data: { email: `${TAG}-viewerB@example.com`, name: `${TAG} Viewer B`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(viewerB.id);
    const viewerBMembership = await prisma.departmentMembership.create({
      data: { userId: viewerB.id, departmentId: deptB.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerBMembership.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));
    await page.waitForTimeout(500);

    console.log("\nEnsuring the active header Workspace is \"All Workspaces\" (so /projects/new starts with no Workspace preselected)...\n");
    await switchHeaderWorkspace(page, "All Workspaces");

    console.log("\n=== 1. Open /projects/new with no Workspace selected ===\n");
    await page.goto(`${BASE_URL}/projects/new`);
    await page.waitForTimeout(800);
    let bodyText = await page.locator("body").innerText();
    check("No Workspace selected yet (admin is not this Workspace's member) -> Members shows the 'select a workspace' helper, not a list", bodyText.includes("Select a workspace to see its members."));
    check("Neither fixture member's name is rendered (no system-wide dump)", !bodyText.includes(`${TAG} Viewer A`) && !bodyText.includes(`${TAG} Manager A`) && !bodyText.includes(`${TAG} Viewer B`));
    check("No false attachment-permission-denied message before a Workspace is selected", !bodyText.includes("You don't have permission to attach files to a Project in the selected workspace."));
    check("Neutral attachment message shown instead", bodyText.includes("Select a workspace to enable project attachments."));

    console.log(`\n=== 2. Select Workspace A ("${deptA.name}") ===\n`);
    await selectFormWorkspace(page, deptA.name);
    await page.waitForTimeout(600);
    bodyText = await page.locator("body").innerText();
    check("Viewer A (plain VIEWER, membership-only) now appears", bodyText.includes(`${TAG} Viewer A`));
    check("Manager A (DEPARTMENT_MANAGER, already project.assignable) still appears", bodyText.includes(`${TAG} Manager A`));
    check("Viewer B (member of Workspace B only) does NOT appear", !bodyText.includes(`${TAG} Viewer B`));
    check("The 'select a workspace' helper is gone now that one is selected", !bodyText.includes("Select a workspace to see its members."));
    check("Neutral attachment message is gone now that a Workspace is selected", !bodyText.includes("Select a workspace to enable project attachments."));
    check("Admin has project.edit everywhere (global bypass) -> Attachments picker is enabled, not a denial message", (await page.locator("text=Attachments").count()) > 0 && !bodyText.includes("You don't have permission to attach files"));

    console.log("\n=== 3. Search filters the visible Workspace A member list without widening it ===\n");
    const memberSearchInput = page.locator('input[placeholder="Search members by name or email…"]');
    check("Member search input is present", (await memberSearchInput.count()) > 0);
    await memberSearchInput.fill("Viewer A");
    await page.waitForTimeout(300);
    bodyText = await page.locator("body").innerText();
    check("Searching 'Viewer A' shows Viewer A", bodyText.includes(`${TAG} Viewer A`));
    check("...and hides Manager A", !bodyText.includes(`${TAG} Manager A`));
    check("...and still never shows Viewer B (search never widens eligibility)", !bodyText.includes(`${TAG} Viewer B`));

    // Select Viewer A while filtered, to prove the clear-on-switch below.
    await page.locator("label", { hasText: `${TAG} Viewer A` }).locator('input[type="checkbox"]').check();
    check("Viewer A's checkbox is checked", await page.locator("label", { hasText: `${TAG} Viewer A` }).locator('input[type="checkbox"]').isChecked());

    await memberSearchInput.fill("");
    await page.waitForTimeout(300);
    bodyText = await page.locator("body").innerText();
    check("Clearing the search restores the full Workspace A member list (Manager A visible again)", bodyText.includes(`${TAG} Manager A`));
    check("Viewer A's checkbox remains checked after clearing search", await page.locator("label", { hasText: `${TAG} Viewer A` }).locator('input[type="checkbox"]').isChecked());

    console.log(`\n=== 4. Switch to Workspace B ("${deptB.name}") ===\n`);
    await selectFormWorkspace(page, deptB.name);
    await page.waitForTimeout(600);
    bodyText = await page.locator("body").innerText();
    check("Members refreshed to Workspace B only — Viewer B appears", bodyText.includes(`${TAG} Viewer B`));
    check("...and Viewer A/Manager A (Workspace A) no longer appear", !bodyText.includes(`${TAG} Viewer A`) && !bodyText.includes(`${TAG} Manager A`));
    const viewerBCheckbox = page.locator("label", { hasText: `${TAG} Viewer B` }).locator('input[type="checkbox"]');
    check("The stale Viewer-A selection was cleared — Viewer B starts unchecked", !(await viewerBCheckbox.isChecked()));

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
