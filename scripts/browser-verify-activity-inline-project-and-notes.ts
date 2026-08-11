/**
 * Live browser verification for:
 *  - Inline Project creation from the Activity create/edit flows
 *    (components/activities/activity-new-form.tsx,
 *    app/(main)/activities/[id]/edit/activity-edit-client.tsx).
 *  - Project/Activity Notes (components/notes/entity-notes.tsx,
 *    app/(main)/projects/[id]/page.tsx,
 *    app/(main)/activities/[id]/activity-detail-client.tsx).
 *  - The Ticket Reply/Internal Note architecture is completely untouched by
 *    either of the above.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-inline-project-and-notes.ts
 */
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvaipn-${RUN_ID}`;

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
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true }, select: { id: true } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    // Point the admin's active workspace at our fixture department so
    // ActivityNewForm (which has no Department picker of its own — it
    // relies entirely on the caller's active workspace) resolves a real
    // department for "+ New Project" to use.
    await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });

    // ══════════════════════ FLOW 1 — Create Activity ══════════════════════
    console.log("\n=== FLOW 1: Create Activity — inline Project creation ===\n");
    await page.goto(`${BASE_URL}/activities/new`);
    await page.waitForSelector("#title");
    await page.fill("#title", `${TAG} Flow1 Activity`);
    await page.fill("#description", `${TAG} description text`);

    const newProjectButton = page.locator('button:has-text("New")').first();
    await newProjectButton.waitFor({ state: "visible" });
    check("'+ New Project' button is enabled once a department is resolved", await newProjectButton.isEnabled());
    await newProjectButton.click();

    const projectDialog = page.getByRole("dialog", { name: "New Project" });
    await projectDialog.waitFor({ state: "visible" });
    await projectDialog.locator("#title").fill(`${TAG} Flow1 Project`);
    await projectDialog.getByRole("button", { name: "Create Project" }).click();
    await projectDialog.waitFor({ state: "hidden", timeout: 10000 });
    check("Project dialog closes automatically after creation", true);

    // Auto-selected: the Project Select's visible trigger text now shows
    // the new project's title instead of the placeholder. Field order in
    // ActivityNewForm is Status, Priority, THEN Project — index 2, not 0.
    const projectSelectTrigger = page.locator('button[role="combobox"]').nth(2);
    await page.waitForFunction(
      (expected) => document.querySelectorAll('button[role="combobox"]')[2]?.textContent?.includes(expected),
      `${TAG} Flow1 Project`,
      { timeout: 10000 }
    );
    check("Newly created Project is automatically selected in the Activity form", (await projectSelectTrigger.textContent())?.includes(`${TAG} Flow1 Project`) ?? false);
    check("Activity title entered before opening the dialog is still intact", (await page.locator("#title").inputValue()) === `${TAG} Flow1 Activity`);
    check("Activity description entered before opening the dialog is still intact", (await page.locator("#description").inputValue()) === `${TAG} description text`);

    await Promise.all([
      page.waitForURL((url) => /^\/activities\/[a-z0-9]+$/.test(url.pathname) && url.pathname !== "/activities/new", { timeout: 15000 }),
      page.getByRole("button", { name: "Create Activity" }).click(),
    ]);
    const flow1ActivityId = page.url().split("/").pop()!;
    activityIds.push(flow1ActivityId);
    await page.waitForSelector(`text=${TAG} Flow1 Project`, { timeout: 10000 });
    check("Activity detail page shows the linked Project's title", (await page.locator(`text=${TAG} Flow1 Project`).count()) > 0);
    const flow1Project = await prisma.projectActivity.findUnique({ where: { id: flow1ActivityId }, include: { project: true } });
    if (flow1Project?.project?.id) projectIds.push(flow1Project.project.id);
    check("Activity is really linked to the new Project in the DB", flow1Project?.project?.title === `${TAG} Flow1 Project`);

    // ══════════════════════ FLOW 2 — Edit Activity ══════════════════════
    console.log("\n=== FLOW 2: Edit Activity — inline Project creation ===\n");
    const flow2Activity = await prisma.projectActivity.create({
      data: { title: `${TAG} Flow2 Activity`, departmentId: dept.id, createdById: undefined },
    });
    activityIds.push(flow2Activity.id);

    await page.goto(`${BASE_URL}/activities/${flow2Activity.id}/edit`);
    await page.waitForSelector('text=Edit Activity');
    const editNewProjectButton = page.locator('button:has-text("New")').first();
    await editNewProjectButton.waitFor({ state: "visible" });
    check("Edit Activity page also offers '+ New Project'", await editNewProjectButton.isEnabled());
    await editNewProjectButton.click();

    const editProjectDialog = page.getByRole("dialog", { name: "New Project" });
    await editProjectDialog.waitFor({ state: "visible" });
    await editProjectDialog.locator("#title").fill(`${TAG} Flow2 Project`);
    await editProjectDialog.getByRole("button", { name: "Create Project" }).click();
    await editProjectDialog.waitFor({ state: "hidden", timeout: 10000 });

    await page.waitForFunction(
      (expected) => document.querySelectorAll('button[role="combobox"]')[2]?.textContent?.includes(expected),
      `${TAG} Flow2 Project`,
      { timeout: 10000 }
    );
    check("Newly created Project is auto-selected in the Edit Activity form", (await page.locator('button[role="combobox"]').nth(2).textContent())?.includes(`${TAG} Flow2 Project`) ?? false);

    const activityUnchangedYet = await prisma.projectActivity.findUnique({ where: { id: flow2Activity.id }, select: { projectId: true } });
    check("The Activity is NOT auto-saved just from creating the Project (still Standalone in the DB)", activityUnchangedYet?.projectId === null);

    await Promise.all([
      page.waitForURL((url) => url.pathname === `/activities/${flow2Activity.id}`, { timeout: 15000 }),
      page.getByRole("button", { name: "Save Changes" }).click(),
    ]);
    const flow2AfterSave = await prisma.projectActivity.findUnique({ where: { id: flow2Activity.id }, include: { project: true } });
    if (flow2AfterSave?.projectId) projectIds.push(flow2AfterSave.projectId);
    check("After pressing Save, the Activity is now linked to the newly-created Project", flow2AfterSave?.project?.title === `${TAG} Flow2 Project`);

    // ══════════════════════ FLOW 3 — Project Notes ══════════════════════
    console.log("\n=== FLOW 3: Project Notes ===\n");
    const notesProject = await prisma.project.create({
      data: { title: `${TAG} Notes Project`, departmentId: dept.id, ownerId: (await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN }, select: { id: true } })).id },
    });
    projectIds.push(notesProject.id);

    await page.goto(`${BASE_URL}/projects/${notesProject.id}`);
    await page.waitForSelector("text=Notes (0)");
    check("Project page shows a 'Notes' section starting at 0", (await page.locator("text=Notes (0)").count()) > 0);
    check("No 'Reply' control exists anywhere on the Project page", (await page.locator("text=Public Reply").count()) === 0 && (await page.locator("text=Send Reply").count()) === 0);
    check("No 'Internal Note' toggle exists anywhere on the Project page", (await page.locator("text=Internal Note").count()) === 0);

    await page.fill("textarea[placeholder='Write a note…']", `${TAG} project note body`);
    await page.getByRole("button", { name: "Add Note" }).click();
    await page.waitForSelector(`text=${TAG} project note body`, { timeout: 10000 });
    check("The note appears instantly without a page reload", (await page.locator(`text=${TAG} project note body`).count()) > 0);
    // Same setNotes() call drives both the list item and the "Notes (N)"
    // counter, so both are always consistent — but the browser can paint
    // them across two frames, so poll briefly rather than asserting the
    // instant after the note body itself becomes visible.
    await page.waitForSelector("text=Notes (1)", { timeout: 5000 });
    check("Notes counter updated to (1)", (await page.locator("text=Notes (1)").count()) > 0);
    await page.waitForFunction(
      () => (document.querySelector("textarea[placeholder='Write a note…']") as HTMLTextAreaElement | null)?.value === "",
      undefined,
      { timeout: 5000 }
    );
    check("Composer cleared after posting", (await page.locator("textarea[placeholder='Write a note…']").inputValue()) === "");

    await page.reload();
    await page.waitForSelector("text=Notes (1)", { timeout: 10000 });
    check("Note survives a full page reload", (await page.locator(`text=${TAG} project note body`).count()) > 0);

    // ══════════════════════ FLOW 4 — Activity Notes ══════════════════════
    console.log("\n=== FLOW 4: Activity Notes ===\n");
    const notesActivity = await prisma.projectActivity.create({ data: { title: `${TAG} Notes Activity`, departmentId: dept.id } });
    activityIds.push(notesActivity.id);

    await page.goto(`${BASE_URL}/activities/${notesActivity.id}`);
    await page.waitForSelector("text=Notes (0)");
    check("Activity page shows a 'Notes' section starting at 0", (await page.locator("text=Notes (0)").count()) > 0);
    check("No 'Reply' control exists anywhere on the Activity page", (await page.locator("text=Public Reply").count()) === 0 && (await page.locator("text=Send Reply").count()) === 0);
    check("No 'Internal Note' toggle exists anywhere on the Activity page", (await page.locator("text=Internal Note").count()) === 0);

    await page.fill("textarea[placeholder='Write a note…']", `${TAG} activity note body`);
    await page.getByRole("button", { name: "Add Note" }).click();
    await page.waitForSelector(`text=${TAG} activity note body`, { timeout: 10000 });
    check("The activity note appears instantly", (await page.locator(`text=${TAG} activity note body`).count()) > 0);

    await page.reload();
    await page.waitForSelector("text=Notes (1)", { timeout: 10000 });
    check("Activity note survives a full page reload", (await page.locator(`text=${TAG} activity note body`).count()) > 0);

    // ══════════════════════ FLOW 5 — Ticket regression ══════════════════════
    console.log("\n=== FLOW 5: Ticket Reply / Internal Note are unaffected ===\n");
    const admin = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMIN }, select: { id: true } });
    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} Ticket`, description: "fixture", departmentId: dept.id, statusId: status.id, requesterId: admin.id },
    });
    ticketIds.push(ticket.id);

    await page.goto(`${BASE_URL}/tickets/${ticket.id}`);
    await page.waitForSelector("text=Public Reply", { timeout: 10000 });
    check("Ticket page still shows the Public Reply / Internal Note toggle", (await page.locator("text=Public Reply").count()) > 0 && (await page.locator("text=Internal Note").count()) > 0);

    await page.fill('textarea[placeholder^="Write a reply"]', `${TAG} ticket reply body`);
    await page.getByRole("button", { name: "Send Reply" }).click();
    await page.waitForSelector(`text=${TAG} ticket reply body`, { timeout: 10000 });
    check("Ticket Reply still works end-to-end", (await page.locator(`text=${TAG} ticket reply body`).count()) > 0);

    // Reload to a clean, settled render before the next interaction — the
    // ticket detail page keeps a live SSE connection, and the echo of the
    // reply just posted can otherwise cause a transient re-render right as
    // the next click lands (a pre-existing Ticket real-time behavior,
    // unrelated to and untouched by this task).
    await page.reload();
    await page.waitForSelector("text=Internal Note", { timeout: 10000 });
    await page.getByRole("button", { name: "Internal Note" }).click();
    await page.waitForSelector('textarea[placeholder^="Internal note"]', { timeout: 5000 });
    await page.fill('textarea[placeholder^="Internal note"]', `${TAG} ticket internal note body`);
    await page.getByRole("button", { name: "Add Note" }).click();
    await page.waitForSelector(`text=${TAG} ticket internal note body`, { timeout: 10000 });
    check("Ticket Internal Note still works end-to-end", (await page.locator(`text=${TAG} ticket internal note body`).count()) > 0);

    // ══════════════════════ FLOW 6 — Permission negative test ══════════════════════
    // A user who CAN edit the Activity (activity.edit) but genuinely lacks
    // project.create in this department (AGENT_ASSIGNEE, per prisma/seed.ts's
    // ROLE_PERMISSIONS — has activity.edit + project.view but NOT
    // project.create) must see "+ New Project" disabled with an explanatory
    // tooltip, and a direct POST /api/projects must still be rejected. This
    // is the proof that fixing the enable-path did not also remove
    // authorization for anyone who should still be denied.
    console.log("\n=== FLOW 6: Permission negative test (activity.edit without project.create) ===\n");
    // Email MUST end in @<ALLOWED_EMAIL_DOMAIN> ("kinsen.gr" here) — the
    // middleware `authorized` callback (lib/auth.config.ts) rejects any
    // session whose email doesn't match, for BOTH Microsoft and Credentials
    // sign-ins. Using an @example.com address here would bounce this user
    // back to /login despite a genuinely valid session — a pure test-fixture
    // mistake unrelated to the actual feature, discovered while building
    // this exact check.
    const limitedPassword = `${TAG}-pw!`;
    const limitedPasswordHash = await bcrypt.hash(limitedPassword, 10);
    const limitedUser = await prisma.user.create({
      data: {
        email: `${TAG}-limited@kinsen.gr`,
        role: Role.USER,
        authProvider: AuthProvider.CREDENTIALS,
        passwordHash: limitedPasswordHash,
        isActive: true,
      },
      select: { id: true },
    });
    userIds.push(limitedUser.id);
    const limitedMembership = await prisma.departmentMembership.create({
      data: { userId: limitedUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL },
    });
    membershipIds.push(limitedMembership.id);

    const limitedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const limitedPage = await limitedContext.newPage();
    await limitedPage.goto(`${BASE_URL}/login`);
    await limitedPage.fill("#credentials-email", `${TAG}-limited@kinsen.gr`);
    await limitedPage.fill("#credentials-password", limitedPassword);
    await Promise.all([
      limitedPage.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      limitedPage.click('button:has-text("Sign in as Admin")'),
    ]);

    await limitedPage.goto(`${BASE_URL}/activities/${flow2Activity.id}/edit`);
    await limitedPage.waitForSelector("text=Edit Activity", { timeout: 10000 });
    const limitedNewButton = limitedPage.locator('button:has-text("New")').first();
    await limitedNewButton.waitFor({ state: "visible" });
    check("A user with activity.edit but WITHOUT project.create sees '+ New Project' disabled", !(await limitedNewButton.isEnabled()));
    check(
      "...with an explanatory (non-internal) tooltip",
      (await limitedNewButton.getAttribute("title")) === "You don't have permission to create projects in this department."
    );

    const directPostRes = await limitedPage.request.post(`${BASE_URL}/api/projects`, {
      data: { title: `${TAG} Should Be Rejected`, departmentId: dept.id },
    });
    check("Direct POST /api/projects from this user is still rejected server-side (not merely hidden client-side)", !directPostRes.ok());
    const rejectedTitleExists = await prisma.project.findFirst({ where: { title: `${TAG} Should Be Rejected` }, select: { id: true } });
    check("...and no Project row was created", rejectedTitleExists === null);

    await limitedContext.close();

    await context.close();
  } finally {
    await browser.close();
    try {
      await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
