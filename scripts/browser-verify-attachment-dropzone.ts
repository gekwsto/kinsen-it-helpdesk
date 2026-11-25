/**
 * Real-browser acceptance for the unified attachment dropzone + email files
 * (.msg/.eml) across Projects, Activities and Tickets.
 *
 * Drag & drop is exercised with REAL DragEvents carrying a real DataTransfer
 * of File objects dispatched on the dropzone (what the browser delivers when
 * a user drops files from the OS) — Playwright cannot drag files from the OS
 * itself. Browse is exercised with real file selection (setInputFiles).
 * Outlook itself is NOT available on this machine: the two shapes a mail
 * client can deliver are simulated — a .msg File with an empty MIME type
 * (what Chromium reports for Outlook-provided .msg files on Windows) and a
 * drop carrying NO file data at all (the fallback path).
 *
 * Usage: BASE_URL=http://localhost:3000 [SHOT_DIR=…] npx tsx scripts/browser-verify-attachment-dropzone.ts
 */
import { chromium, webkit, type Page, type Browser } from "playwright";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { AuthProvider, DepartmentRole, MembershipSource, Role } from "@prisma/client";
import { buildSampleMsg, buildSampleEml, buildRenamedOleDoc } from "./test-support-email-fixtures";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR || "reports/browser-verify-attachments";
const RUN_ID = Date.now();
const PASSWORD = "BvAttach123!";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./storage/uploads";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type DropFile = { name: string; type: string; b64?: string; size?: number };
const MSG = buildSampleMsg();
const EML = buildSampleEml();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const f = (name: string, type: string, bytes: Buffer): DropFile => ({ name, type, b64: bytes.toString("base64") });
const MIXED: DropFile[] = [f("Outlook capture.msg", "", MSG), f("Invoice.eml", "message/rfc822", EML), f("spec.pdf", "application/pdf", PDF), f("photo.png", "image/png", PNG)];
const ORIGINAL: Record<string, Buffer> = { "Outlook capture.msg": MSG, "Invoice.eml": EML, "spec.pdf": PDF, "photo.png": PNG };

// Plain JS source (not a TS function) so the bundler can't inject helpers
// (e.g. __name) that don't exist inside the page.
const DROP_SRC = `(function (args) {
  var selector = args.selector, files = args.files, opts = args.opts;
  var target = selector ? document.querySelector(selector) : document.body;
  if (!target) throw new Error("no element for " + selector);
  function make() {
    var dt = new DataTransfer();
    if (opts.textOnly !== undefined) dt.setData("text/plain", opts.textOnly);
    files.forEach(function (file) {
      var bytes = file.b64 ? Uint8Array.from(atob(file.b64), function (c) { return c.charCodeAt(0); }) : new Uint8Array(file.size || 0);
      // Fixed lastModified: a real file from disk keeps the same metadata
      // every time it is dragged, which is what duplicate detection keys on.
      dt.items.add(new File([bytes], file.name, { type: file.type, lastModified: 1700000000000 }));
    });
    return dt;
  }
  function fire(type, dt) {
    var ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  var dt = make();
  fire("dragenter", dt);
  fire("dragover", dt);
  if (opts.stopBeforeDrop) return { dropPrevented: null };
  var dropPrevented = fire("drop", dt);
  if (opts.twice) fire("drop", dt); // the same drop event delivered twice
  return { dropPrevented: dropPrevented };
})`;

/** Dispatches dragenter/dragover/drop with a real DataTransfer on `selector` (or document.body). */
async function drop(page: Page, selector: string | null, files: DropFile[], opts: { textOnly?: string; twice?: boolean; stopBeforeDrop?: boolean } = {}): Promise<{ dropPrevented: boolean | null }> {
  return page.evaluate(`${DROP_SRC}(${JSON.stringify({ selector, files, opts })})`) as Promise<{ dropPrevented: boolean | null }>;
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 30000 }), page.click('button:has-text("Sign in as Admin")')]);
}

async function downloadMatches(page: Page, linkName: string, original: Buffer) {
  const href = await page.locator(`a[href*="/attachments/"]:has-text("${linkName}")`).first().getAttribute("href");
  if (!href) return { ok: false, detail: "no link" };
  const res = await page.request.get(`${BASE_URL}${href}`);
  const body = await res.body();
  const disp = res.headers()["content-disposition"] ?? "";
  return { ok: res.status() === 200 && sha(body) === sha(original) && disp.startsWith("attachment;"), detail: `${res.status()} ${disp} ${res.headers()["content-type"]}` };
}

async function noHorizontalOverflow(page: Page) {
  return page.evaluate(`document.documentElement.scrollWidth - window.innerWidth <= 0`) as Promise<boolean>;
}

async function main() {
  await prisma.$connect();
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const cleanup = { deptIds: [] as string[], userId: null as string | null, roleKey: null as string | null, roleId: null as string | null, projectIds: [] as string[], activityIds: [] as string[], ticketIds: [] as string[] };
  let browser: Browser | null = null;
  try {
    // ── Fixtures ──
    const dept = await createDepartment({ name: `BV Attach Dept ${RUN_ID}`, slug: `bv-attach-${RUN_ID}` });
    cleanup.deptIds.push(dept.id);
    const perms = (await prisma.rolePermission.findMany({ where: { roleKey: "DEPARTMENT_ADMIN" }, select: { permission: { select: { key: true } } } })).map((r) => r.permission.key);
    const role = await prisma.customRole.create({ data: { key: `BV_ATTACH_${RUN_ID}`, name: `BV Attach ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    cleanup.roleKey = role.key; cleanup.roleId = role.id;
    for (const key of perms) {
      const p = await prisma.permission.findUnique({ where: { key } });
      if (p) await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: p.id } });
    }
    const bcrypt = await import("bcryptjs");
    const email = `bv-attach-${RUN_ID}@kinsen.gr`;
    const user = await prisma.user.create({ data: { email, name: `BV Attach ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
    cleanup.userId = user.id;
    await prisma.departmentMembership.create({ data: { userId: user.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: role.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    const project = await prisma.project.create({ data: { title: `BV Attach Project ${RUN_ID}`, departmentId: dept.id, ownerId: user.id, owners: { connect: [{ id: user.id }] } } });
    cleanup.projectIds.push(project.id);
    const activity = await prisma.projectActivity.create({ data: { title: `BV Attach Activity ${RUN_ID}`, departmentId: dept.id, projectId: project.id, createdById: user.id } });
    cleanup.activityIds.push(activity.id);
    // An attachment that existed before this change — must keep working.
    const legacyBytes = Buffer.from("legacy text attachment");
    const legacyDir = path.join(UPLOAD_DIR, "projects", project.id);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, `legacy-${RUN_ID}.txt`), legacyBytes);
    await prisma.projectAttachment.create({ data: { projectId: project.id, uploadedById: user.id, filename: `legacy-${RUN_ID}.txt`, originalName: "legacy-notes.txt", mimeType: "text/plain", size: legacyBytes.length } });

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await login(page, email);
    const ZONE = "[data-attachment-dropzone]";

    // ═══════════ Project detail (immediate upload) ═══════════
    console.log("\n=== Project detail — drag & drop, mixed types, progress, validation ===\n");
    await page.goto(`${BASE_URL}/projects/${project.id}`);
    await page.waitForSelector(ZONE, { timeout: 30000 });
    check("Existing attachment still listed and downloads byte-identical", (await downloadMatches(page, "legacy-notes.txt", legacyBytes)).ok);

    await drop(page, ZONE, [MIXED[0]], { stopBeforeDrop: true });
    check("Drag-over highlights the dropzone ('Drop files to attach', primary border)", (await page.locator(ZONE).innerText()).includes("Drop files to attach") && /border-primary/.test((await page.locator(ZONE).getAttribute("class")) ?? ""));
    await page.screenshot({ path: `${SHOT_DIR}/01-project-dragover.png` });
    await page.evaluate(`document.querySelector(${JSON.stringify(ZONE)}).dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))`);
    check("Highlight clears on drag-leave", !(await page.locator(ZONE).innerText()).includes("Drop files to attach"));

    const r1 = await drop(page, ZONE, MIXED);
    check("Drop is default-prevented on the dropzone (browser does not navigate)", r1.dropPrevented === true);
    for (const df of MIXED) await page.waitForSelector(`a[href*="/attachments/"]:has-text("${df.name}")`, { timeout: 30000 });
    check("4 mixed files (MSG, EML, PDF, PNG) dropped at once are all uploaded and listed", true);
    check("Email files show the email icon", (await page.locator('a[href*="/attachments/"] [aria-label="Email message"]').count()) >= 2);
    for (const df of MIXED) {
      const m = await downloadMatches(page, df.name, ORIGINAL[df.name]);
      check(`Download of ${df.name} is byte-identical and served as an attachment`, m.ok, m.detail);
    }
    await page.screenshot({ path: `${SHOT_DIR}/02-project-uploaded.png`, fullPage: true });

    const countBefore = await page.locator('a[href*="/attachments/"]').count();
    await drop(page, ZONE, [f("dup-check.eml", "message/rfc822", EML)], { twice: true });
    await page.waitForSelector('a[href*="/attachments/"]:has-text("dup-check.eml")', { timeout: 30000 });
    await page.waitForTimeout(1500);
    check("A repeated drop event with the same file uploads it exactly once", (await page.locator('a[href*="/attachments/"]:has-text("dup-check.eml")').count()) === 1 && (await page.locator('a[href*="/attachments/"]').count()) === countBefore + 1);

    await drop(page, ZONE, [{ name: "tool.exe", type: "application/x-msdownload", b64: Buffer.from("MZ").toString("base64") }, { name: "huge.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 }]);
    check("Client-side per-file errors: disallowed type and over-size", await page.getByText("tool.exe: this file type isn't allowed").isVisible() && await page.getByText("huge.pdf: exceeds the 10 MB limit").isVisible());
    await drop(page, ZONE, [f("renamed-doc.msg", "application/vnd.ms-outlook", buildRenamedOleDoc())]);
    await page.waitForSelector('[data-upload-status="failed"]', { timeout: 30000 });
    check("Server-side content check surfaces per file (renamed .doc as .msg -> failed row with reason)", (await page.locator('[data-upload-status="failed"]').innerText()).includes("not a valid Outlook message"));

    const navRes = await drop(page, null, [MIXED[2]]);
    check("A file dropped OUTSIDE the dropzone does not navigate away (default prevented, URL unchanged)", navRes.dropPrevented === true && page.url().includes(`/projects/${project.id}`));
    await drop(page, ZONE, [], { textOnly: "Subject: dragged from a mail client without file data" });
    check("Drop with NO file data (e.g. a mail client that doesn't provide the message as a file) shows the save-as-.msg/.eml fallback", await page.getByText("save the message as .msg or .eml first").isVisible());

    await page.locator(`${ZONE} input[type=file]`).setInputFiles({ name: "browsed.eml", mimeType: "message/rfc822", buffer: EML });
    await page.waitForSelector('a[href*="/attachments/"]:has-text("browsed.eml")', { timeout: 30000 });
    check("Browse (real file selection) still works", (await downloadMatches(page, "browsed.eml", EML)).ok);
    await page.locator(ZONE).focus();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null), page.keyboard.press("Enter")]);
    check("Keyboard: Enter on the focused dropzone opens the file chooser (multiple)", !!chooser && chooser.isMultiple());
    await chooser?.setFiles([]).catch(() => {});

    // Real upload progress under a throttled connection.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 50, downloadThroughput: 5_000_000, uploadThroughput: 300_000 });
    await drop(page, ZONE, [{ name: "slow.pdf", type: "application/pdf", size: 3 * 1024 * 1024 }]);
    const bar = page.locator('[role="progressbar"]');
    await bar.waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const pct = Number(await bar.getAttribute("aria-valuenow"));
    await page.screenshot({ path: `${SHOT_DIR}/03-project-progress.png` });
    check(`Upload progress is shown while uploading (progressbar at ${pct}%)`, pct > 0 && pct < 100);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitForSelector('a[href*="/attachments/"]:has-text("slow.pdf")', { timeout: 60000 });
    check("...and the slow upload completes and is listed", true);

    // ═══════════ Activity detail ═══════════
    console.log("\n=== Activity detail ===\n");
    await page.goto(`${BASE_URL}/activities/${activity.id}`);
    await page.waitForSelector(ZONE, { timeout: 30000 });
    await drop(page, ZONE, [MIXED[0], MIXED[1], MIXED[2]]);
    for (const n of ["Outlook capture.msg", "Invoice.eml", "spec.pdf"]) await page.waitForSelector(`a[href*="/attachments/"]:has-text("${n}")`, { timeout: 30000 });
    check("Activity: MSG + EML + PDF dropped together are uploaded", true);
    check("Activity: .msg download byte-identical", (await downloadMatches(page, "Outlook capture.msg", MSG)).ok);
    check("Activity: .eml download byte-identical", (await downloadMatches(page, "Invoice.eml", EML)).ok);

    // ═══════════ Project create (staged → upload after create) ═══════════
    console.log("\n=== Project create — staged files upload after creation ===\n");
    await page.goto(`${BASE_URL}/projects/new`);
    await page.waitForSelector(ZONE, { timeout: 30000 });
    await page.fill("#title", `BV Attach Created ${RUN_ID}`);
    await drop(page, ZONE, [MIXED[0], MIXED[1], MIXED[2]]);
    check("Staged list shows the 3 dropped files before the Project exists", (await page.getByRole("button", { name: /^Remove / }).count()) === 3);
    await drop(page, ZONE, [MIXED[1]]);
    check("Dropping an already-staged file again does not duplicate it", (await page.getByRole("button", { name: /^Remove / }).count()) === 3);
    await page.getByRole("button", { name: "Remove spec.pdf" }).click();
    check("Removing a staged file works", (await page.getByRole("button", { name: /^Remove / }).count()) === 2);
    await page.screenshot({ path: `${SHOT_DIR}/04-project-create-staged.png`, fullPage: true });
    await page.getByRole("button", { name: "Create Project" }).click();
    await page.waitForURL((u) => /^\/projects\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith("/new"), { timeout: 60000 });
    const createdId = page.url().split("/projects/")[1].split(/[?#]/)[0];
    cleanup.projectIds.push(createdId);
    await page.waitForSelector('a[href*="/attachments/"]:has-text("Invoice.eml")', { timeout: 30000 });
    check("Created Project has exactly the 2 staged files (MSG + EML)", (await page.locator('a[href*="/attachments/"]').count()) === 2);
    check("Created Project: staged .msg downloads byte-identical", (await downloadMatches(page, "Outlook capture.msg", MSG)).ok);

    // ═══════════ Ticket create (staged) + reply ═══════════
    console.log("\n=== Ticket create (staged) and reply composer ===\n");
    await page.goto(`${BASE_URL}/tickets/new`);
    await page.waitForSelector(ZONE, { timeout: 30000 });
    await page.fill("#title", `BV Attach Ticket ${RUN_ID}`);
    await page.fill("#description", "Email files attached via drag and drop.");
    await drop(page, ZONE, [MIXED[0], MIXED[3]]);
    check("Ticket create: 2 files staged", (await page.getByRole("button", { name: /^Remove / }).count()) === 2);
    await page.locator('button[type="submit"]').last().click();
    await page.waitForURL((u) => /^\/tickets\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith("/new"), { timeout: 60000 });
    const ticketId = page.url().split("/tickets/")[1].split(/[?#]/)[0];
    cleanup.ticketIds.push(ticketId);
    await page.waitForSelector('a[href*="/attachments/"]:has-text("Outlook capture.msg")', { timeout: 30000 });
    check("Ticket create: staged MSG + PNG uploaded after creation; .msg byte-identical", (await downloadMatches(page, "Outlook capture.msg", MSG)).ok && (await downloadMatches(page, "photo.png", PNG)).ok);
    check("Ticket attachments show the email icon", (await page.locator('a[href*="/attachments/"] [aria-label="Email message"]').count()) >= 1);

    const replyZone = `form ${ZONE}`;
    await page.waitForSelector(replyZone, { timeout: 30000 });
    await drop(page, replyZone, [f("reply-thread.eml", "message/rfc822", EML), f("reply-capture.msg", "", MSG)]);
    check("Reply composer: dropped files staged as chips", (await page.getByRole("button", { name: /^Remove reply-/ }).count()) === 2);
    await page.getByPlaceholder(/Write a reply/).fill("Reply with two email attachments");
    await page.getByRole("button", { name: /Send Reply|Add Note/ }).click();
    await page.getByText("Reply sent").first().waitFor({ timeout: 30000 });
    // The thread appends the new message optimistically BEFORE its attachments
    // finish uploading (unchanged pre-existing behaviour) — reload to see them.
    await page.reload();
    await page.waitForSelector('a[href*="/attachments/"]:has-text("reply-capture.msg")', { timeout: 30000 });
    check("Reply: both email files uploaded with the message; .eml byte-identical", (await downloadMatches(page, "reply-thread.eml", EML)).ok);
    await page.screenshot({ path: `${SHOT_DIR}/05-ticket-reply.png`, fullPage: true });

    // ═══════════ Mobile layout ═══════════
    console.log("\n=== Mobile (390 px) ===\n");
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState(), isMobile: true, hasTouch: true });
    const mp = await mobile.newPage();
    for (const [label, url, shot] of [["Project detail", `/projects/${project.id}`, "06-mobile-project.png"], ["Project create", "/projects/new", "07-mobile-project-create.png"], ["Ticket detail", `/tickets/${ticketId}`, "08-mobile-ticket.png"]] as const) {
      await mp.goto(`${BASE_URL}${url}`);
      await mp.waitForSelector(ZONE, { timeout: 30000 });
      await mp.locator(ZONE).last().scrollIntoViewIfNeeded();
      const box = await mp.locator(ZONE).last().boundingBox();
      check(`${label}: no horizontal overflow; dropzone fits the viewport`, (await noHorizontalOverflow(mp)) && !!box && box.x >= 0 && box.x + box.width <= 390);
      await mp.screenshot({ path: `${SHOT_DIR}/${shot}`, fullPage: true });
    }
    await mp.locator(`${ZONE} input[type=file]`).last().setInputFiles({ name: "mobile.eml", mimeType: "message/rfc822", buffer: EML });
    check("Mobile: Browse selection stages a file in the reply composer", (await mp.getByRole("button", { name: "Remove mobile.eml" }).count()) === 1);
    await mobile.close();
    check("No uncaught page errors (Chromium)", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

    // ═══════════ WebKit (Safari engine) ═══════════
    console.log("\n=== WebKit (Safari engine) — drop + browse on Project detail ===\n");
    const wk = await webkit.launch().catch(() => null);
    if (!wk) {
      console.log("  (WebKit not available — skipped)");
    } else {
      const wctx = await wk.newContext({ viewport: { width: 1280, height: 900 } });
      const wp = await wctx.newPage();
      await login(wp, email);
      await wp.goto(`${BASE_URL}/projects/${activity.projectId}`);
      await wp.waitForSelector(ZONE, { timeout: 30000 });
      await drop(wp, ZONE, [f("webkit-drop.msg", "", MSG), f("webkit-drop.eml", "message/rfc822", EML)]);
      await wp.waitForSelector('a[href*="/attachments/"]:has-text("webkit-drop.eml")', { timeout: 30000 });
      check("WebKit: dropped .msg + .eml uploaded; .msg byte-identical", (await downloadMatches(wp, "webkit-drop.msg", MSG)).ok);
      await wk.close();
    }
  } finally {
    await browser?.close();
    const rm = (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => {});
    for (const id of cleanup.projectIds) await rm(path.join(UPLOAD_DIR, "projects", id));
    for (const id of cleanup.activityIds) await rm(path.join(UPLOAD_DIR, "activities", id));
    const ticketsWithIds = await prisma.ticket.findMany({ where: { OR: [{ id: { in: cleanup.ticketIds } }, ...(cleanup.userId ? [{ requesterId: cleanup.userId }] : [])] }, select: { id: true } });
    for (const t of ticketsWithIds) await rm(path.join(UPLOAD_DIR, t.id));
    const steps: [string, () => Promise<unknown>][] = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketsWithIds.map((t) => t.id) } } })],
      ["activity attachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: cleanup.activityIds } } })],
      ["project attachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: cleanup.projectIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: cleanup.activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: cleanup.projectIds } } })],
      ["notifications", () => (cleanup.userId ? prisma.notification.deleteMany({ where: { userId: cleanup.userId } }) : Promise.resolve())],
      ["memberships", () => (cleanup.userId ? prisma.departmentMembership.deleteMany({ where: { userId: cleanup.userId } }) : Promise.resolve())],
      ["user", () => (cleanup.userId ? prisma.user.delete({ where: { id: cleanup.userId } }) : Promise.resolve())],
      ["role perms", () => (cleanup.roleKey ? prisma.rolePermission.deleteMany({ where: { roleKey: cleanup.roleKey } }) : Promise.resolve())],
      ["role", () => (cleanup.roleId ? prisma.customRole.delete({ where: { id: cleanup.roleId } }) : Promise.resolve())],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: cleanup.deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: cleanup.deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: cleanup.deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: cleanup.deptIds } } })],
    ];
    for (const [label, fn] of steps) {
      try { await fn(); } catch (err) { console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err); }
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
