/**
 * Live browser verification for the request-origin Project setup page's
 * vertical scroll/layout contract:
 *
 *   /projects/new?projectRequestId=<id>
 *
 * This script does NOT assume a root cause. It drives the page with REAL
 * mouse-wheel scrolling (never a direct `el.scrollTop = ...` assignment,
 * which can silently diverge from how an actual user's wheel/trackpad
 * input is routed by the browser), measures window/document/body/main
 * scroll state together, and walks the full ancestor chain from the real
 * last visible content element (the Cancel/Create Project button row) up
 * to `<main>`, recording bounding rects and computed layout properties at
 * every level — so the offending node can be named directly from evidence,
 * never inferred from source classes alone.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-project-request-setup-layout.ts
 */
import { mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let fixtureSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => fixtureSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvprsl-${RUN_ID}`;

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

/** Real wheel-scroll (never a direct scrollTop assignment) over the page center, repeated until two consecutive reads produce no further movement anywhere (window OR main) — the only reliable way to reach "a real user's maximum scroll" without assuming which element actually receives the wheel events. */
async function wheelScrollToBottom(page: Page, label: string) {
  // page.mouse.wheel() dispatches at the virtual mouse's CURRENT position,
  // which Playwright otherwise leaves wherever a prior action (or viewport
  // resize) last left it — possibly over the sidebar, or off the new
  // viewport entirely. Without parking it over <main> first, the wheel can
  // silently scroll the wrong element (or nothing), producing a false pass.
  const mainBox = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const rect = main.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (mainBox) await page.mouse.move(mainBox.x, mainBox.y);

  let lastState = "";
  let capturedWindowScrollMoment = false;
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(60);
    const step = await page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        win: window.scrollY,
        doc: document.documentElement.scrollTop,
        docScrollHeight: document.documentElement.scrollHeight,
        body: document.body.scrollTop,
        main: main?.scrollTop ?? null,
        mainScrollHeight: main?.scrollHeight ?? null,
      };
    });
    console.log(`[${label}] wheel step ${i}:`, JSON.stringify(step));
    if (!capturedWindowScrollMoment && step.win !== 0) {
      capturedWindowScrollMoment = true;
      const bodyChildren = (await page.evaluate(BODY_CHILDREN_SOURCE)) as unknown[];
      console.log(`[${label}] *** window.scrollY became nonzero AT THIS STEP (${step.win}) — body > children AT THIS EXACT MOMENT: ***`);
      for (const c of bodyChildren) console.log("   ", JSON.stringify(c));
    }
    const state = JSON.stringify(step);
    if (state === lastState) break;
    lastState = state;
  }
  await page.waitForTimeout(200);
}

/** Full scroll-state snapshot across every plausible scroll owner — never assumes `main` is the only one. */
async function scrollSnapshot(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      window_scrollY: window.scrollY,
      window_innerHeight: window.innerHeight,
      documentElement_scrollTop: document.documentElement.scrollTop,
      documentElement_scrollHeight: document.documentElement.scrollHeight,
      documentElement_clientHeight: document.documentElement.clientHeight,
      body_scrollTop: document.body.scrollTop,
      body_scrollHeight: document.body.scrollHeight,
      main_scrollTop: main?.scrollTop ?? null,
      main_scrollHeight: main?.scrollHeight ?? null,
      main_clientHeight: main?.clientHeight ?? null,
      main_remaining: main ? main.scrollHeight - main.scrollTop - main.clientHeight : null,
    };
  });
}

// Passed to page.evaluate() as a raw STRING (never a closure reference) —
// tsx/esbuild's dev transform injects a `__name(...)` helper call around
// named inner functions for readable stack traces, and Playwright's
// function-closure evaluate() only ships the function's own .toString()
// text across to the browser, without that helper's definition — causing
// a ReferenceError: __name is not defined inside the browser context. A
// plain string bypasses that transform entirely.
// Enumerates every DIRECT CHILD of <body> and reports its box — finds
// which top-level sibling (outside the app's own h-screen shell div) is
// contributing real document height, if any.
const BODY_CHILDREN_SOURCE = `
(function () {
  return Array.prototype.map.call(document.body.children, function (el) {
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      id: el.id,
      class: el.className,
      rectTop: rect.top,
      rectBottom: rect.bottom,
      rectHeight: rect.height,
      offsetHeight: el.offsetHeight,
      scrollHeight: el.scrollHeight,
      position: cs.position,
      display: cs.display
    };
  });
})()
`;

const ANCESTOR_AUDIT_SOURCE = `
(function () {
  var main = document.querySelector("main");
  var buttons = Array.prototype.filter.call(document.querySelectorAll("button"), function (b) {
    return /create project/i.test(b.textContent || "");
  });
  var createBtn = buttons[0];
  var row = createBtn ? createBtn.closest("div.flex.justify-end") : null;
  var lastContent = row || createBtn || null;

  function describe(el) {
    if (!el) return null;
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      class: el.className,
      rectTop: rect.top,
      rectBottom: rect.bottom,
      rectHeight: rect.height,
      height: cs.height,
      minHeight: cs.minHeight,
      maxHeight: cs.maxHeight,
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      display: cs.display,
      flex: cs.flex,
      flexGrow: cs.flexGrow,
      flexShrink: cs.flexShrink,
      flexBasis: cs.flexBasis,
      alignSelf: cs.alignSelf,
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      overflow: cs.overflow,
      overflowY: cs.overflowY,
      position: cs.position
    };
  }

  var chain = [];
  var node = lastContent;
  var guard = 0;
  while (node && node !== main && guard < 30) {
    chain.push(describe(node));
    node = node.parentElement;
    guard++;
  }
  if (main) chain.push(describe(main));

  var mainRect = main ? main.getBoundingClientRect() : null;
  var contentRect = lastContent ? lastContent.getBoundingClientRect() : null;

  return {
    foundCreateButton: !!createBtn,
    foundRow: !!row,
    lastContentTag: lastContent ? lastContent.tagName : null,
    lastContentClass: lastContent ? lastContent.className : null,
    mainBottom: mainRect ? mainRect.bottom : null,
    contentBottom: contentRect ? contentRect.bottom : null,
    blankTailPx: mainRect && contentRect ? mainRect.bottom - contentRect.bottom : null,
    chain: chain
  };
})()
`;

interface AncestorEntry {
  tag: string;
  class: string;
  rectTop: number;
  rectBottom: number;
  rectHeight: number;
  height: string;
  minHeight: string;
  maxHeight: string;
  paddingTop: string;
  paddingBottom: string;
  marginTop: string;
  marginBottom: string;
  display: string;
  flex: string;
  flexGrow: string;
  flexShrink: string;
  flexBasis: string;
  alignSelf: string;
  alignItems: string;
  justifyContent: string;
  overflow: string;
  overflowY: string;
  position: string;
}

interface AncestorAuditResult {
  foundCreateButton: boolean;
  foundRow: boolean;
  lastContentTag: string | null;
  lastContentClass: string | null;
  mainBottom: number | null;
  contentBottom: number | null;
  blankTailPx: number | null;
  chain: AncestorEntry[];
}

/** Finds the real last-visible-content element (the Cancel/Create Project button row), walks every ancestor up to <main>, and records bounding rect + the full computed-style set the task asked for, at each level. */
async function ancestorAudit(page: Page): Promise<AncestorAuditResult> {
  return page.evaluate(ANCESTOR_AUDIT_SOURCE) as Promise<AncestorAuditResult>;
}

async function fullDiagnose(page: Page, label: string, screenshot: boolean) {
  console.log(`\n--- ${label} ---`);
  await page.waitForTimeout(400);

  if (screenshot) await page.screenshot({ path: `/tmp/${TAG}-${label}-top.png` });

  const pre = (await page.evaluate(() => ({
    docScrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }))) as { docScrollHeight: number; innerHeight: number };
  console.log(`[${label}] BEFORE any scroll: documentElement.scrollHeight=${pre.docScrollHeight} window.innerHeight=${pre.innerHeight}`);
  if (pre.docScrollHeight > pre.innerHeight + 5) {
    const bodyChildren = (await page.evaluate(BODY_CHILDREN_SOURCE)) as unknown[];
    console.log(`[${label}] *** ALREADY taller than viewport BEFORE any scroll — body > children: ***`);
    for (const c of bodyChildren) console.log("   ", JSON.stringify(c));
  }

  await wheelScrollToBottom(page, label);

  const snap = await scrollSnapshot(page);
  console.log(`[${label}] scroll snapshot:`, JSON.stringify(snap, null, 2));

  if (snap.window_scrollY !== 0) {
    const bodyChildren = (await page.evaluate(BODY_CHILDREN_SOURCE)) as unknown[];
    console.log(`[${label}] *** window_scrollY !== 0 — document-level scroll detected. body > children: ***`);
    for (const c of bodyChildren) console.log("   ", JSON.stringify(c));
  }

  const audit = await ancestorAudit(page);
  console.log(`[${label}] foundCreateButton=${audit.foundCreateButton} foundRow=${audit.foundRow} lastContent=${audit.lastContentTag}.${audit.lastContentClass}`);
  console.log(`[${label}] mainBottom=${audit.mainBottom} contentBottom=${audit.contentBottom} blankTailPx=${audit.blankTailPx}`);
  console.log(`[${label}] ancestor chain (content -> main):`);
  for (const entry of audit.chain) {
    console.log("   ", JSON.stringify(entry));
  }

  if (screenshot) await page.screenshot({ path: `/tmp/${TAG}-${label}-bottom.png` });

  const TOLERANCE_PX = 60; // the app's own p-6 (24px) + a small Card-border allowance — never a per-viewport magic number.
  const mainNeededScroll = snap.main_scrollHeight !== null && snap.main_clientHeight !== null && snap.main_scrollHeight > snap.main_clientHeight + 2;
  check(`[${label}] (sanity) Create Project button + its row were found`, audit.foundCreateButton && audit.foundRow);
  if (mainNeededScroll) {
    // Only meaningful once content actually overflowed and had to be scrolled —
    // a short form in a tall viewport legitimately leaves blank space below it
    // without ever scrolling (main_remaining stays 0), which is not this bug.
    check(
      `[${label}] blankTailPx (${audit.blankTailPx?.toFixed(1)}) is within normal padding tolerance (<= ${TOLERANCE_PX}px) — the REAL regression check`,
      audit.blankTailPx !== null && audit.blankTailPx <= TOLERANCE_PX && audit.blankTailPx >= -5
    );
  } else {
    console.log(`[${label}] (skipped blankTailPx check — main never needed to scroll: scrollHeight=${snap.main_scrollHeight} <= clientHeight=${snap.main_clientHeight}, trailing space is just a short form in a tall viewport)`);
  }
  check(
    `[${label}] window itself never scrolled (window_scrollY === 0: document/body is not a second scroll owner)`,
    snap.window_scrollY === 0 && snap.documentElement_scrollTop === 0 && snap.body_scrollTop === 0
  );
  check(
    `[${label}] main's own remaining scroll is ~0 after real wheel-scrolling to the bottom (main_remaining=${snap.main_remaining})`,
    snap.main_remaining !== null && Math.abs(snap.main_remaining) <= 2
  );

  return { snap, audit };
}


async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const userIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `${TAG}-type` } });
    typeIds.push(type.id);

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    const requester = await prisma.user.create({
      data: { email: `${TAG}-requester@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(requester.id);
    await prisma.departmentMembership.create({
      data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    const { NextRequest } = await import("next/server");
    const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    fixtureSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Layout verification fixture — description long enough.",
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
      })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);

    fixtureSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const clearRes = await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    if (clearRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${clearRes.status}`);
    const approveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Layout verification fixture." }), { params: Promise.resolve({ id: submitted.id }) });
    if (approveRes.status !== 200) throw new Error(`Fixture setup failed: final approval returned ${approveRes.status}`);
    fixtureSession = null;

    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page);

    const MATRIX = [
      { width: 1280, height: 480 },
      { width: 1280, height: 600, screenshot: true },
      { width: 1366, height: 768, screenshot: true },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080, screenshot: true },
      { width: 2560, height: 1440 },
      { width: 3440, height: 1440, screenshot: true },
    ];

    console.log(`\n=== A. Request-origin setup page (REAL click-through: detail page -> "Complete Project Setup") ===\n`);
    for (const { width, height, screenshot } of MATRIX) {
      await page.setViewportSize({ width, height });
      await page.goto(`${BASE_URL}/project-requests/${submitted.id}`, { waitUntil: "load" });
      const link = page.getByRole("link", { name: /complete project setup/i }).or(page.getByRole("button", { name: /complete project setup/i }));
      await link.first().waitFor({ state: "visible", timeout: 10000 });
      await link.first().click();
      await page.waitForURL((url) => url.pathname === "/projects/new", { timeout: 10000 });
      await fullDiagnose(page, `fromRequest-${width}x${height}`, !!screenshot);
    }

    console.log(`\n=== B. Normal manual /projects/new (regression guard) ===\n`);
    for (const { width, height } of MATRIX) {
      await page.setViewportSize({ width, height });
      await page.goto(`${BASE_URL}/projects/new`, { waitUntil: "load" });
      await fullDiagnose(page, `manual-${width}x${height}`, false);
    }

    await context.close();
  } finally {
    await browser.close();
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
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
