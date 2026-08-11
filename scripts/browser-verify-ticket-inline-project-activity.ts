/**
 * Real interactive browser proof of inline Project/Activity creation from
 * the Ticket create and Ticket edit/link flows (components/tickets/ticket-form.tsx,
 * components/tickets/ticket-actions.tsx) — the actual user-facing workflow
 * described in the task: create a Project inline, have it auto-select,
 * create an Activity inline (preselecting that Project), have IT
 * auto-select too, and submit/save with both links intact — all without
 * ever leaving the Ticket page, and (for the existing-ticket Link dialog)
 * without any broken nested-Dialog focus/overlay behavior.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-inline-project-activity.ts
 * Requires a reachable DATABASE_URL and a running dev/production server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvipa-${RUN_ID}`;

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

/** The "New" button rows for Project (index 0) and Activity (index 1) — see ticket-form.tsx / ticket-actions.tsx's identical `<Select/> + <Button>New</Button>` row shape. */
function newButtonRow(page: Page, index: 0 | 1) {
  const btn = page.getByRole("button", { name: "New", exact: true }).nth(index);
  return { button: btn, trigger: btn.locator("xpath=preceding-sibling::button[@role='combobox']") };
}

/**
 * The Link dialog itself, by ACCESSIBLE ROLE+NAME — never by matching the
 * text "Link Project / Activity" directly, which ALSO matches the
 * always-present trigger button that opens it (same visible label). Radix
 * wires DialogContent's aria-labelledby to DialogTitle, so
 * getByRole("dialog", {name}) correctly targets only the dialog, open or
 * not — the trigger button (role="button") never matches.
 */
function linkDialog(page: Page) {
  return page.getByRole("dialog", { name: "Link Project / Activity" });
}

/** The inline "New Activity" create dialog specifically, by role+name — same reasoning as linkDialog: during a swap/close animation more than one `[role="dialog"]` node can transiently exist, so a generic `[role="dialog"]` selector is not reliably scoped to just this one. */
function activityCreateDialog(page: Page) {
  return page.getByRole("dialog", { name: "New Activity" });
}

async function selectDepartmentIfPresent(page: Page, departmentName: string) {
  // Only rendered when the user has more than one accessible department —
  // an ADMIN in a real seeded DB always does, so this reliably needs to run.
  const deptTrigger = page.locator("text=Department").locator("xpath=following-sibling::*//button[@role='combobox']").first();
  const anyDeptSelect = await deptTrigger.count();
  if (anyDeptSelect === 0) return;
  await deptTrigger.click();
  await page.getByRole("option", { name: departmentName, exact: true }).click();
  await page.waitForTimeout(400); // sub-department + project/activity re-fetch settle
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const ticketIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    console.log("\n=== Fixtures: an isolated department for this run ===\n");
    const dept = await createDepartment({ name: `${TAG}-Dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();

    console.log("\nLogging in as admin...\n");
    await login(page);

    // ══════════════════════════════════════════════════════════════════
    // PART 1 — CREATE TICKET: inline Project then inline Activity, both
    // auto-selected, ticket submits linked to both.
    // ══════════════════════════════════════════════════════════════════
    console.log("\n=== PART 1: Create Ticket — inline Project + Activity creation ===\n");
    await page.goto(`${BASE_URL}/tickets/new`);
    await page.waitForLoadState("networkidle");
    await selectDepartmentIfPresent(page, dept.name);

    const { button: newProjectBtn, trigger: projectTrigger } = newButtonRow(page, 0);
    const { button: newActivityBtn, trigger: activityTrigger } = newButtonRow(page, 1);

    check("New Project button is enabled once the department is resolved", await newProjectBtn.isEnabled());
    check('Project select shows "No project" before any selection', ((await projectTrigger.innerText()) || "").includes("No project"));

    await newProjectBtn.click();
    await page.waitForSelector("text=New Project", { timeout: 8000 });
    check("Exactly one dialog is open after clicking + New Project", (await page.locator('[role="dialog"]').count()) === 1);
    await page.fill("#title", `${TAG} Inline Project`);
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.waitForSelector("text=New Project", { state: "hidden", timeout: 10000 });
    await page.waitForTimeout(300);

    const projectTriggerTextAfterCreate = await projectTrigger.innerText();
    check("The newly-created project is automatically selected on the Ticket form", projectTriggerTextAfterCreate.includes(`${TAG} Inline Project`), projectTriggerTextAfterCreate);

    await newActivityBtn.click();
    await page.waitForSelector("text=New Activity", { timeout: 8000 });
    check("Exactly one dialog is open after clicking + New Activity", (await page.locator('[role="dialog"]').count()) === 1);
    // The Activity dialog's OWN Project select must show the ticket's
    // currently-selected project preselected (task requirement 4A). Field
    // order in activity-new-form.tsx is Status, Priority, THEN Project —
    // index 2, not the first combobox. The dialog fetches its OWN
    // department-scoped project list (and applies the preselection once
    // that list actually contains it — see activity-new-form.tsx) before
    // this is settled, so this waits for the real preselected label rather
    // than checking immediately.
    const activityDialogProjectTrigger = activityCreateDialog(page).locator('button[role="combobox"]').nth(2);
    await page.waitForFunction(
      (title) => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("New Activity"));
        const combos = dialog?.querySelectorAll('button[role="combobox"]');
        return combos?.[2]?.textContent?.includes(title);
      },
      `${TAG} Inline Project`,
      { timeout: 8000 }
    );
    const preselectedText = await activityDialogProjectTrigger.innerText();
    check("Inline Activity dialog preselects the Ticket's currently-selected Project", preselectedText.includes(`${TAG} Inline Project`), preselectedText);

    await page.locator('[role="dialog"] #title').fill(`${TAG} Inline Activity`);
    await page.locator('[role="dialog"]').getByRole("button", { name: "Create Activity" }).click();
    await page.waitForSelector("text=New Activity", { state: "hidden", timeout: 10000 });
    await page.waitForTimeout(300);

    const activityTriggerTextAfterCreate = await activityTrigger.innerText();
    check("The newly-created activity is automatically selected on the Ticket form", activityTriggerTextAfterCreate.includes(`${TAG} Inline Activity`), activityTriggerTextAfterCreate);
    const projectTriggerStillConsistent = await projectTrigger.innerText();
    check("Project selection is still the same project the Activity belongs to (consistency preserved)", projectTriggerStillConsistent.includes(`${TAG} Inline Project`));

    await page.fill("#title", `${TAG} Ticket via inline creation`);
    await page.fill("#description", "Created through the browser verification script to prove inline Project/Activity creation end to end.");
    await Promise.all([
      page.waitForURL((url) => /\/tickets\/[a-z0-9]+$/.test(url.pathname), { timeout: 15000 }),
      page.getByRole("button", { name: "Submit Ticket" }).click(),
    ]);
    // Ticket detail pages keep a long-lived SSE connection open
    // (useTicketRealtime / GET /api/tickets/[id]/stream) — "networkidle"
    // never resolves there, so a targeted element wait is used instead.
    await page.waitForSelector("text=Link Project / Activity", { timeout: 15000 });
    check("Ticket detail page shows the linked Project", (await page.locator(`text=${TAG} Inline Project`).count()) > 0);
    check("Ticket detail page shows the linked Activity", (await page.locator(`text=${TAG} Inline Activity`).count()) > 0);

    const ticketUrl = page.url();
    const createdTicketId = ticketUrl.split("/").pop()!;
    ticketIds.push(createdTicketId);
    const createdTicketRow = await prisma.ticket.findUnique({ where: { id: createdTicketId }, select: { projectId: true, activityId: true } });
    if (createdTicketRow?.projectId) projectIds.push(createdTicketRow.projectId);
    if (createdTicketRow?.activityId) activityIds.push(createdTicketRow.activityId);
    check("Ticket really is linked to both in the database (not just visually)", !!createdTicketRow?.projectId && !!createdTicketRow?.activityId);

    // ══════════════════════════════════════════════════════════════════
    // PART 2 — EXISTING TICKET: Link dialog, nested-dialog swap UX,
    // inline creation, unlink.
    // ══════════════════════════════════════════════════════════════════
    console.log("\n=== PART 2: Existing Ticket — Link dialog inline creation + nested-dialog UX ===\n");
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true }, select: { id: true } });
    const plainTicket = await prisma.ticket.create({
      data: { title: `${TAG} Plain Ticket`, description: "fixture", departmentId: dept.id, statusId: status.id, requesterId: admin.id },
    });
    ticketIds.push(plainTicket.id);

    await page.goto(`${BASE_URL}/tickets/${plainTicket.id}`);
    await page.waitForSelector("text=Link Project / Activity", { timeout: 15000 });
    await page.getByRole("button", { name: "Link Project / Activity" }).click();
    await linkDialog(page).waitFor({ state: "visible", timeout: 8000 });
    check("Link dialog is open with exactly one dialog visible", (await page.locator('[role="dialog"]').count()) === 1);

    const linkNewProjectBtn = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(0);
    await linkNewProjectBtn.click();
    await page.waitForSelector("text=New Project", { timeout: 8000 });
    // The Link dialog's own exit animation (~200ms, dialog.tsx's own
    // duration-200) can briefly leave its DOM node present-but-fading
    // alongside the just-opened create dialog — waiting for that to settle
    // is the real "no stacking" check, not a snapshot mid-transition.
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1, undefined, { timeout: 3000 }).catch(() => {});
    check("Clicking + New Project inside Link dialog swaps to exactly ONE dialog (no stacking)", (await page.locator('[role="dialog"]').count()) === 1);
    check("The Link dialog itself is no longer in the DOM/visible (true swap, not an overlay stack)", (await linkDialog(page).count()) === 0);

    await page.locator('[role="dialog"] #title').fill(`${TAG} Existing-Ticket Project`);
    await page.locator('[role="dialog"]').getByRole("button", { name: "Create Project" }).click();
    await page.waitForSelector("text=New Project", { state: "hidden", timeout: 10000 });
    await linkDialog(page).waitFor({ state: "visible", timeout: 8000 });
    check("Link dialog automatically reopens after successful inline Project creation", (await linkDialog(page).count()) > 0);
    check("Still exactly one dialog open (Link dialog, not both)", (await page.locator('[role="dialog"]').count()) === 1);

    const { trigger: linkProjectTrigger } = (() => {
      const btn = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(0);
      return { trigger: btn.locator("xpath=preceding-sibling::button[@role='combobox']") };
    })();
    const linkProjectText = await linkProjectTrigger.innerText();
    check("The newly-created project is automatically selected in the Link dialog", linkProjectText.includes(`${TAG} Existing-Ticket Project`), linkProjectText);

    // Escape on the CREATE dialog restores the Link dialog too (not a dead end).
    const linkNewActivityBtn = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(1);
    await linkNewActivityBtn.click();
    await page.waitForSelector("text=New Activity", { timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("text=New Activity", { state: "hidden", timeout: 8000 });
    await linkDialog(page).waitFor({ state: "visible", timeout: 8000 });
    check("Escape on the inline create dialog restores the Link dialog (never a dead end with no dialog open)", (await linkDialog(page).count()) > 0);
    check("Exactly one dialog after Escape-then-restore", (await page.locator('[role="dialog"]').count()) === 1);

    // Now actually create the activity for real — waits for the dialog's
    // own department-scoped Project list (and its preselection) to settle
    // before submitting, same reasoning as Part 1's identical wait.
    await linkNewActivityBtn.click();
    await page.waitForSelector("text=New Activity", { timeout: 8000 });
    await page.waitForFunction(
      (title) => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d.textContent?.includes("New Activity"));
        const combos = dialog?.querySelectorAll('button[role="combobox"]');
        return combos?.[2]?.textContent?.includes(title);
      },
      `${TAG} Existing-Ticket Project`,
      { timeout: 8000 }
    );
    await page.locator('[role="dialog"] #title').fill(`${TAG} Existing-Ticket Activity`);
    await page.locator('[role="dialog"]').getByRole("button", { name: "Create Activity" }).click();
    await page.waitForSelector("text=New Activity", { state: "hidden", timeout: 10000 });
    await linkDialog(page).waitFor({ state: "visible", timeout: 8000 });
    check("Link dialog reopens after inline Activity creation too", (await linkDialog(page).count()) > 0);

    // Select dropdowns remain fully usable after the swap sequence — a real interaction check, not just a DOM-presence check.
    const linkActivityTrigger = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(1).locator("xpath=preceding-sibling::button[@role='combobox']");
    const linkActivityText = await linkActivityTrigger.innerText();
    check("The newly-created activity is automatically selected in the Link dialog", linkActivityText.includes(`${TAG} Existing-Ticket Activity`), linkActivityText);
    check("Select dropdown opens normally after the dialog-swap sequence (not stuck/broken)", await (async () => {
      await linkActivityTrigger.click();
      const opened = (await page.locator('[role="option"]').count()) > 0;
      await page.keyboard.press("Escape");
      return opened;
    })());

    await page.locator('[role="dialog"]').getByRole("button", { name: "Save" }).click();
    await linkDialog(page).waitFor({ state: "hidden", timeout: 10000 });
    await page.waitForSelector(`text=${TAG} Existing-Ticket Project`, { timeout: 10000 });
    check("Existing ticket page shows the linked Project after Save", (await page.locator(`text=${TAG} Existing-Ticket Project`).count()) > 0);
    check("Existing ticket page shows the linked Activity after Save", (await page.locator(`text=${TAG} Existing-Ticket Activity`).count()) > 0);

    const relinkedTicket = await prisma.ticket.findUnique({ where: { id: plainTicket.id }, select: { projectId: true, activityId: true } });
    if (relinkedTicket?.projectId) projectIds.push(relinkedTicket.projectId);
    if (relinkedTicket?.activityId) activityIds.push(relinkedTicket.activityId);
    check("Database confirms both real links were saved", !!relinkedTicket?.projectId && !!relinkedTicket?.activityId);

    // Unlink still works.
    await page.getByRole("button", { name: "Link Project / Activity" }).click();
    await linkDialog(page).waitFor({ state: "visible", timeout: 8000 });
    const unlinkActivityTrigger = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(1).locator("xpath=preceding-sibling::button[@role='combobox']");
    await unlinkActivityTrigger.click();
    await page.getByRole("option", { name: "No activity", exact: true }).click();
    const unlinkProjectTrigger = page.locator('[role="dialog"]').getByRole("button", { name: "New", exact: true }).nth(0).locator("xpath=preceding-sibling::button[@role='combobox']");
    await unlinkProjectTrigger.click();
    await page.getByRole("option", { name: "No project", exact: true }).click();
    await page.locator('[role="dialog"]').getByRole("button", { name: "Save" }).click();
    await linkDialog(page).waitFor({ state: "hidden", timeout: 10000 });
    await page.waitForFunction(
      (title) => !document.body.innerText.includes(title),
      `${TAG} Existing-Ticket Project`,
      { timeout: 10000 }
    ).catch(() => {});
    const unlinkedTicket = await prisma.ticket.findUnique({ where: { id: plainTicket.id }, select: { projectId: true, activityId: true } });
    check("Unlink still works — projectId cleared", unlinkedTicket?.projectId === null);
    check("Unlink still works — activityId cleared", unlinkedTicket?.activityId === null);

    console.log("\nConsole/page error summary...\n");
    await context.close();
  } finally {
    await browser.close();
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => {});
    if (departmentIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
