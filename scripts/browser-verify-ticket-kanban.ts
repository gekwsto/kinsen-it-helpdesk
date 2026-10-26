/**
 * Live browser verification for the Ticket Kanban/Board view: the
 * Table/Board toggle persists in the URL, drag-and-drop moves a real
 * fixture ticket between columns and persists after a hard reload,
 * per-column pagination ("Load more"), permission gating (a user without
 * ticket.changeStatus and who isn't the ticket's own requester sees a
 * non-draggable but still-clickable card), and the "All Workspaces"
 * disabled state.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-kanban.ts
 * Requires a reachable DATABASE_URL and a running dev server.
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, RoleScope, DepartmentRole } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import bcrypt from "bcryptjs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = "KanbanTest123!";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.log("FAIL:", label, detail ? `— ${detail}` : "");
  }
}

async function loginAs(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#credentials-email", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(400);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

const ALL_WORKSPACES_VALUE = "ALL"; // types/department.ts's own exported sentinel — mirrored here since this script can't import a "use server"-adjacent module directly without the usual tsx workarounds, and this is a stable, documented public constant.

async function setActiveWorkspace(page: Page, departmentId: string) {
  // Mirrors the real WorkspaceSelector's own write path (the active-workspace
  // cookie set via its API) — simplest direct way to pin the active workspace
  // for a test without clicking through the selector UI. departmentId is
  // required by the endpoint; pass ALL_WORKSPACES_VALUE for "All Workspaces".
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  const res = await page.evaluate(async (deptId) => {
    const r = await fetch("/api/workspace/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departmentId: deptId }),
    });
    return { ok: r.ok, status: r.status };
  }, departmentId);
  if (!res.ok) console.warn(`[setActiveWorkspace] POST /api/workspace/active returned ${res.status} for departmentId=${departmentId}`);
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const dept = await createDepartment({ name: `Kanban Dept ${RUN_ID}`, slug: `kanban-${RUN_ID}` });
  const statuses = await prisma.ticketStatus.findMany({ where: { departmentId: dept.id }, orderBy: { order: "asc" } });
  const openStatus = statuses.find((s) => s.isDefault) ?? statuses[0];
  const otherStatus = statuses.find((s) => s.id !== openStatus.id && !s.isClosed) ?? statuses[1];
  // A third, otherwise-untouched status for the pagination test, so bulk
  // fixture tickets there never interfere with the drag test's own
  // openStatus/otherStatus columns.
  const pagedStatus = statuses.find((s) => s.id !== openStatus.id && s.id !== otherStatus.id && !s.isClosed) ?? statuses[2];
  check("Fixture: department has at least 3 non-closed statuses (drag x2 + pagination)", !!openStatus && !!otherStatus && !!pagedStatus && new Set([openStatus.id, otherStatus.id, pagedStatus.id]).size === 3);

  const permission = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.changeStatus" } });
  const changerRole = await prisma.customRole.create({ data: { key: `KANBAN_CHANGER_${RUN_ID}`, name: `Kanban Changer ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
  await prisma.rolePermission.create({ data: { roleKey: changerRole.key, permissionId: permission.id } });

  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@kinsen.gr" } });
  const noPermUser = await prisma.user.create({
    data: { email: `kanban-noperm-${RUN_ID}@kinsen.gr`, name: "Kanban NoPerm", authProvider: AuthProvider.CREDENTIALS, isActive: true, role: Role.USER, passwordHash: await bcrypt.hash(PASSWORD, 10) },
  });
  await grantManualMembership(noPermUser.id, dept.id, { role: DepartmentRole.VIEWER });

  const ticket = await prisma.ticket.create({
    data: { title: `Kanban drag fixture ${RUN_ID}`, description: "x", requesterId: admin.id, departmentId: dept.id, statusId: openStatus.id },
  });
  const noPermTicket = await prisma.ticket.create({
    data: { title: `Kanban no-perm fixture ${RUN_ID}`, description: "x", requesterId: admin.id, departmentId: dept.id, statusId: openStatus.id },
  });

  // 35 tickets in a dedicated status (> the 30-per-column initial page
  // size) — enough to prove the column paginates via "Load more" instead
  // of silently fetching/truncating everything up front.
  const PAGED_TICKET_COUNT = 35;
  await prisma.ticket.createMany({
    data: Array.from({ length: PAGED_TICKET_COUNT }, (_, i) => ({
      title: `Kanban paging fixture ${RUN_ID}-${String(i).padStart(2, "0")}`,
      description: "x",
      requesterId: admin.id,
      departmentId: dept.id,
      statusId: pagedStatus.id,
    })),
  });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAs(page, "admin@kinsen.gr", process.env.ADMIN_PASSWORD || "Kinsen123!");
    await setActiveWorkspace(page, dept.id);

    // 1. Toggle to Board, URL carries ?view=board, preserved across reload.
    await page.goto(`${BASE}/tickets`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await page.click('button:has-text("Board")');
    await page.waitForURL((url) => url.searchParams.get("view") === "board", { timeout: 10000 });
    check("Clicking Board sets ?view=board in the URL", page.url().includes("view=board"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    check("Board view persists across reload", page.url().includes("view=board") && (await page.isVisible(`text=${ticket.title}`)));

    const openColumnHeader = page.locator(`text=${openStatus.name}`).first();
    const otherColumnHeader = page.locator(`text=${otherStatus.name}`).first();
    const otherColumnDrop = page.locator(`[data-kanban-column="${otherStatus.id}"]`);
    check("Open-status column header is visible", await openColumnHeader.isVisible());
    check("Other-status column header is visible", await otherColumnHeader.isVisible());

    // 2. Drag the fixture ticket card from its column into the other
    // column's actual DROPPABLE zone (the card-stack div below the header,
    // identified by data-kanban-column — NOT the header text's own bounding
    // box, which sits outside the droppable's bounds and would never
    // register the drop).
    const card = page.locator(`text=${ticket.title}`).first();
    const cardBox = await card.boundingBox();
    const targetBox = await otherColumnDrop.boundingBox();
    check("Fixture card and target column both have a bounding box", !!cardBox && !!targetBox);
    if (cardBox && targetBox) {
      // A generous, stepped drag — dnd-kit's PointerSensor only "picks up"
      // once pointer movement exceeds its activation distance, and needs a
      // real intermediate move (not a single teleport) to register the
      // drop target under pointerWithin collision detection.
      await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.move(cardBox.x + cardBox.width / 2 + 20, cardBox.y + cardBox.height / 2 + 20, { steps: 5 });
      await page.waitForTimeout(100);
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
      await page.waitForTimeout(150);
      await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 90, { steps: 5 });
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(1200);
    }

    const afterDrag = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { statusId: true } });
    check("Drag persisted the new status server-side", afterDrag.statusId === otherStatus.id, `statusId=${afterDrag.statusId}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    check("New status persists after a hard reload", await page.locator(`[data-kanban-column="${otherStatus.id}"]`).locator(`text=${ticket.title}`).isVisible().catch(() => false));

    // 3. Clicking (not dragging) a card still navigates to the ticket.
    await page.click(`text=${ticket.title}`);
    await page.waitForURL((url) => url.pathname === `/tickets/${ticket.id}`, { timeout: 10000 });
    check("A plain click on a card navigates to the ticket detail page", page.url().includes(`/tickets/${ticket.id}`));

    // 3b. Per-column pagination: the paged-fixture column starts capped at
    // BOARD_COLUMN_PAGE_SIZE (30) with a "Load more" control, and clicking
    // it reveals the rest — never one big unpaginated/truncated fetch.
    await page.goto(`${BASE}/tickets?view=board`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const pagedColumn = page.locator(`[data-kanban-column="${pagedStatus.id}"]`);
    const initialCardCount = await pagedColumn.locator(`text=Kanban paging fixture ${RUN_ID}`).count();
    check(
      `Paged column initially shows only the first page (<=30), not all ${PAGED_TICKET_COUNT}`,
      initialCardCount > 0 && initialCardCount <= 30,
      `initialCardCount=${initialCardCount}`
    );
    const loadMoreButton = pagedColumn.locator('button:has-text("Load more")');
    check("Load more button is visible when a column has more tickets than its current page", await loadMoreButton.isVisible());
    page.on("console", (msg) => { if (msg.type() === "error") console.log("[browser console error]", msg.text()); });
    page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));
    await loadMoreButton.click();
    // Poll instead of a fixed sleep — the fetch+re-render timing can vary.
    let afterLoadMoreCount = initialCardCount;
    for (let i = 0; i < 20; i++) {
      afterLoadMoreCount = await pagedColumn.locator(`text=Kanban paging fixture ${RUN_ID}`).count();
      if (afterLoadMoreCount >= PAGED_TICKET_COUNT) break;
      await page.waitForTimeout(500);
    }
    check(
      `Clicking Load more reveals all ${PAGED_TICKET_COUNT} paged fixture tickets`,
      afterLoadMoreCount === PAGED_TICKET_COUNT,
      `afterLoadMoreCount=${afterLoadMoreCount}`
    );
    check("Load more button disappears once every ticket in the column is loaded", !(await loadMoreButton.isVisible().catch(() => false)));

    // 4. All Workspaces -> Board toggle disabled.
    await setActiveWorkspace(page, ALL_WORKSPACES_VALUE);
    await page.goto(`${BASE}/tickets`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const boardButtonDisabled = await page.locator('button:has-text("Board")').isDisabled();
    check("Board toggle is disabled under All Workspaces", boardButtonDisabled);

    await context.close();

    // 5. A user with no ticket.changeStatus (and not the ticket's requester) sees a non-draggable card.
    const noPermContext = await browser.newContext();
    const noPermPage = await noPermContext.newPage();
    await loginAs(noPermPage, noPermUser.email, PASSWORD);
    await setActiveWorkspace(noPermPage, dept.id);
    await noPermPage.goto(`${BASE}/tickets?view=board`, { waitUntil: "domcontentloaded" });
    await noPermPage.waitForTimeout(600);
    const noPermCard = noPermPage.locator(`text=${noPermTicket.title}`).first();
    const cardVisible = await noPermCard.isVisible().catch(() => false);
    check("No-permission user can still see the board and the ticket card", cardVisible);
    // Non-draggable cards in this implementation simply never receive
    // dnd-kit's drag listeners/attributes — the most reliable external
    // signal to check is that attempting a drag never changes the
    // server-side status (checked below), rather than inspecting internal
    // DOM attributes.
    const noPermCardBox = await noPermCard.boundingBox().catch(() => null);
    const noPermTargetBox = await noPermPage.locator(`[data-kanban-column="${otherStatus.id}"]`).boundingBox().catch(() => null);
    if (noPermCardBox && noPermTargetBox) {
      await noPermPage.mouse.move(noPermCardBox.x + noPermCardBox.width / 2, noPermCardBox.y + noPermCardBox.height / 2);
      await noPermPage.mouse.down();
      await noPermPage.waitForTimeout(150);
      await noPermPage.mouse.move(noPermCardBox.x + noPermCardBox.width / 2 + 20, noPermCardBox.y + noPermCardBox.height / 2 + 20, { steps: 5 });
      await noPermPage.waitForTimeout(100);
      await noPermPage.mouse.move(noPermTargetBox.x + noPermTargetBox.width / 2, noPermTargetBox.y + 80, { steps: 15 });
      await noPermPage.waitForTimeout(150);
      await noPermPage.mouse.up();
      await noPermPage.waitForTimeout(1000);
    }
    const noPermTicketAfter = await prisma.ticket.findUniqueOrThrow({ where: { id: noPermTicket.id }, select: { statusId: true } });
    check(
      "A drag attempt by a user without ticket.changeStatus (and not the requester) never changes the server-side status",
      noPermTicketAfter.statusId === openStatus.id,
      `statusId=${noPermTicketAfter.statusId}`
    );
    // Still clickable regardless of drag permission.
    await noPermPage.click(`text=${noPermTicket.title}`);
    await noPermPage.waitForURL((url) => url.pathname === `/tickets/${noPermTicket.id}`, { timeout: 10000 });
    check("The non-draggable card is still clickable through to the ticket", noPermPage.url().includes(`/tickets/${noPermTicket.id}`));

    await noPermContext.close();
  } finally {
    await browser.close();
    await prisma.ticket.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.departmentMembership.deleteMany({ where: { userId: noPermUser.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: noPermUser.id } }).catch(() => {});
    await prisma.rolePermission.deleteMany({ where: { roleKey: changerRole.key } }).catch(() => {});
    await prisma.customRole.deleteMany({ where: { id: changerRole.id } }).catch(() => {});
    await prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.ticketCategory.deleteMany({ where: { departmentId: dept.id } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: dept.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(" -", f));
    process.exit(1);
  }
}

main();
