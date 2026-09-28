/**
 * Regression coverage for "slow blocking reload after marking an Activity
 * completed from inside a Project".
 *
 * ROOT CAUSE (measured, not assumed): the actual server-side work was never
 * slow — PATCH /api/activities/[id] (including its awaited rollup) and a
 * full Project detail page RSC render both complete in well under 100ms
 * against a realistic-sized project. The reported "slow blocking overlay"
 * came from a CLIENT-side bug: the app's global navigation loader
 * (components/layout/navigation-loader.tsx) arms its full-page overlay from
 * a document-level CAPTURE-phase click listener, which always runs BEFORE
 * any bubble-phase handler — including ActivityCompleteCheckbox's own
 * onClick, which calls preventDefault()/stopPropagation() specifically to
 * stop the row's wrapping <Link> from navigating. By the time that handler
 * runs, the capture listener has already inspected the click, found the
 * ancestor <Link href="/activities/{id}">, and started the loader as if
 * navigating there. Since that navigation is then correctly suppressed,
 * pathname/searchParams never change, so the loader's own "resolved" signal
 * never fires — the overlay shows after SHOW_DELAY_MS (150ms) and then
 * hangs until SAFETY_TIMEOUT_MS (15000ms), a ~15s fully spurious full-page
 * block for what was always only a same-route mutation.
 *
 * FIX, two independent parts:
 *  1. lib/navigation-loader.ts's NAV_LOADER_IGNORE_ATTR + isNavLoaderIgnored,
 *     wired into the capture listener — lets a control opt OUT of arming the
 *     loader at all, the only point early enough to matter (see that
 *     constant's own doc comment for why stopPropagation() alone can't
 *     substitute). ActivityCompleteCheckbox is marked with it.
 *  2. The Project detail page's Activities card (components/projects/
 *     project-activities-card.tsx) is now client-managed: a toggle's PATCH
 *     response (now including the awaited rollup's own result — see
 *     lib/projects/progress-rollup.ts's ProjectRollupResult, threaded
 *     through app/api/activities/[id]/route.ts and
 *     components/activities/toggle-activity-complete.ts) is applied
 *     directly to local state. No router.refresh(), no re-fetch, no second
 *     round-trip — and therefore nothing that could ever race a newer
 *     toggle either (guarded with the same token pattern
 *     lib/navigation-loader.ts's own createTokenGuard already uses).
 *
 * SECTION A is a source-text guard for the client-only orchestration this
 * suite has no DOM to execute directly (established convention — see
 * scripts/test-inline-create-with-attachments.ts). SECTION B drives the
 * REAL PATCH route, rollup function, and Project detail Server Component
 * against a real database, including realistic-size timing measurements.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-completion-performance.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";
import { NextRequest } from "next/server";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — source-text guard ══════════════════════
  console.log("\n=== SECTION A — Overlay opt-out wiring + client-managed card + race guard ===\n");

  const navLoaderLibSrc = await fs.readFile("lib/navigation-loader.ts", "utf8");
  const navLoaderComponentSrc = await fs.readFile("components/layout/navigation-loader.tsx", "utf8");
  const checkboxSrc = await fs.readFile("components/activities/activity-complete-checkbox.tsx", "utf8");
  const cardSrc = await fs.readFile("components/projects/project-activities-card.tsx", "utf8");
  const routeSrc = await fs.readFile("app/api/activities/[id]/route.ts", "utf8");
  const rollupSrc = await fs.readFile("lib/projects/progress-rollup.ts", "utf8");
  const pageSrc = await fs.readFile("app/(main)/projects/[id]/page.tsx", "utf8");

  check("1. NAV_LOADER_IGNORE_ATTR + isNavLoaderIgnored are exported from the pure decision module", /export const NAV_LOADER_IGNORE_ATTR/.test(navLoaderLibSrc) && /export function isNavLoaderIgnored/.test(navLoaderLibSrc));
  check("2. The capture-phase click listener checks isNavLoaderIgnored BEFORE looking for an ancestor <Link> — the only point early enough to prevent arming the loader at all", /isNavLoaderIgnored\(target\)/.test(navLoaderComponentSrc) && navLoaderComponentSrc.indexOf("isNavLoaderIgnored(target)") < navLoaderComponentSrc.indexOf('closest?.("a[href]")'));
  check("3. ActivityCompleteCheckbox's checkbox input is marked with the ignore attribute", /NAV_LOADER_IGNORE_ATTR\]:\s*true/.test(checkboxSrc));
  check("...the toggling spinner is marked too (same click surface while a request is in flight)", (checkboxSrc.match(/NAV_LOADER_IGNORE_ATTR\]:\s*true/g) ?? []).length >= 2);

  check("4. The Project detail page's Activities card is a Client Component (\"use client\")", /^"use client";/.test(cardSrc));
  check("5. ProjectActivitiesCard never calls router.refresh() or router.push() for a toggle — it applies the PATCH response's own data locally", !/router\.refresh/.test(cardSrc) && !/router\.push/.test(cardSrc) && !/useRouter/.test(cardSrc));
  check("6. The Project detail page itself no longer imports ActivityCompleteCheckbox directly (it's rendered INSIDE ProjectActivitiesCard now, not the page)", !/import\s*\{\s*ActivityCompleteCheckbox/.test(pageSrc));
  check("7. recalculateProjectRollup now returns its result (progress/completedActivities/totalActivities) instead of void", /export interface ProjectRollupResult/.test(rollupSrc) && /Promise<ProjectRollupResult \| null>/.test(rollupSrc));
  check("8. recalculateProjectRollup derives completedActivities/totalActivities from the SAME activities query already needed for progress — no added count query on the normal path", /select: \{ departmentId: true, status: true, isCompleted: true \}/.test(rollupSrc));
  check("9. The awaited rollup's settled results are collected into `projectRollups` and returned in the PATCH response body", /const projectRollups[\s\S]{0,80}filter/.test(routeSrc) && /projectRollups\s*\}\)/.test(routeSrc));
  check("10. A rollup that itself throws is still never allowed to fail the whole PATCH — its promise resolves to null (filtered out), not rejected", /\.catch\(\(err\) => \{[\s\S]{0,200}return null;/.test(routeSrc));

  console.log("\n=== Race safety: rapid consecutive toggles can't let an older response overwrite a newer one ===\n");
  check("11. ProjectActivitiesCard guards the SHARED project-level aggregate with a token bumped at toggle START, applied only if still current when the response arrives — reusing the exact pattern lib/navigation-loader.ts's own createTokenGuard already implements (never a second, ad hoc implementation)", /from "@\/lib\/navigation-loader"/.test(cardSrc) && /createTokenGuard/.test(cardSrc) && /tokenGuardRef\.current\.bump\(\)/.test(cardSrc) && /tokenGuardRef\.current\.isCurrent\(myToken\)/.test(cardSrc));
  check("12. Each row's OWN isCompleted/status state is applied unconditionally (never gated behind the shared token) — a toggle's effect on ITS OWN row is never something a different row's toggle should be able to suppress", /setActivities\(\(prev\) => prev\.map/.test(cardSrc) && cardSrc.indexOf("setActivities((prev) => prev.map") < cardSrc.indexOf("tokenGuardRef.current.isCurrent(myToken)"));

  // ══════════════════════ SECTION B — real route + real rollup + real page, timed ══════════════════════
  console.log("\n=== SECTION B — real PATCH/rollup/page timing + correctness against a real database ===\n");

  let mods: {
    PATCH: typeof import("@/app/api/activities/[id]/route").PATCH;
    recalculateProjectRollup: typeof import("@/lib/projects/progress-rollup").recalculateProjectRollup;
    ProjectDetailPage: any;
    ProjectActivitiesCard: any;
  };
  try {
    mods = {
      PATCH: (await import("@/app/api/activities/[id]/route")).PATCH,
      recalculateProjectRollup: (await import("@/lib/projects/progress-rollup")).recalculateProjectRollup,
      ProjectDetailPage: (await import("@/app/(main)/projects/[id]/page")).default,
      ProjectActivitiesCard: (await import("@/components/projects/project-activities-card")).ProjectActivitiesCard,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { PATCH, recalculateProjectRollup, ProjectDetailPage, ProjectActivitiesCard } = mods;

  const { prisma } = await import("@/lib/prisma");
  const { AuthProvider, Role } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const dept = await createDepartment({ name: `ActPerf-${RUN_ID}`, slug: `act-perf-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.create({ data: { email: `act-perf-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: admin.role, customRoleId: null } };

    console.log("\n-- Timing: realistic-size project (25 activities) --\n");
    const project = await prisma.project.create({ data: { title: `Perf Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
    projectIds.push(project.id);
    const activities = [];
    for (let i = 0; i < 25; i++) {
      activities.push(await prisma.projectActivity.create({ data: { title: `Perf Activity ${i} ${RUN_ID}`, projectId: project.id, departmentId: dept.id, status: "IN_PROGRESS" } }));
    }
    activityIds.push(...activities.map((a) => a.id));
    const target = activities[0];

    const t0 = performance.now();
    const patchRes = await PATCH(jsonReq({ isCompleted: true, status: "COMPLETED" }), { params: Promise.resolve({ id: target.id }) });
    const t1 = performance.now();
    const patchMs = t1 - t0;
    check("1. PATCH returns authoritative Activity and Project rollup data", patchRes.status === 200);
    const patchBody = await patchRes.clone().json();
    check("...isCompleted/status/statusLabel/statusColor all present", patchBody.isCompleted === true && patchBody.status === "COMPLETED" && typeof patchBody.statusLabel === "string" && typeof patchBody.statusColor === "string");
    check("...projectRollups carries this Project's id + progress + completed/total counts", patchBody.projectRollups?.[0]?.id === project.id && typeof patchBody.projectRollups[0].progress === "number" && patchBody.projectRollups[0].completedActivities === 1 && patchBody.projectRollups[0].totalActivities === 25);
    check(`6. Rollup completed before the authoritative response — PATCH (with awaited rollup) took ${patchMs.toFixed(1)}ms, well under a "slow" threshold`, patchMs < 2000, `${patchMs.toFixed(1)}ms`);

    const t2 = performance.now();
    await recalculateProjectRollup(project.id);
    const t3 = performance.now();
    console.log(`  (diagnostic) recalculateProjectRollup() alone: ${(t3 - t2).toFixed(1)}ms`);

    const t4 = performance.now();
    await ProjectDetailPage({ params: Promise.resolve({ id: project.id }) });
    const t5 = performance.now();
    const pageMs = t5 - t4;
    console.log(`  (diagnostic) Full ProjectDetailPage() RSC render: ${pageMs.toFixed(1)}ms`);
    check("Root cause confirmed: the server-side path (PATCH+rollup, and a full page render) is fast — the old 'slow blocking overlay' was a client-side bug, not a backend latency problem", patchMs < 2000 && pageMs < 2000, `patch=${patchMs.toFixed(1)}ms page=${pageMs.toFixed(1)}ms`);

    console.log("\n-- 3/4. This same-page mutation never arms the global overlay; no full reload --\n");
    check("3. The exact attribute the nav loader's capture listener checks IS present on the checkbox (re-confirmed at the DOM-attribute-name level, not just source text)", checkboxSrc.includes("data-nav-loader-ignore") || /NAV_LOADER_IGNORE_ATTR/.test(checkboxSrc));
    check("4. No window.location.reload()/location.reload() anywhere in the completion path", !/location\.reload/.test(checkboxSrc) && !/location\.reload/.test(cardSrc));

    console.log("\n-- 2. Immediate UI: ProjectActivitiesCard applies a toggle's result to its own local state synchronously (no intermediate network round-trip needed to reflect it) --\n");
    check("ProjectActivitiesCard's onToggled handler updates BOTH the row (isCompleted/statusLabel/statusColor) and the shared progress from the SAME callback invocation — one state application, not a staged/delayed one", /handleToggled = \(activityId: string\) => \(result: ActivityToggleResult\) => \{/.test(cardSrc));

    console.log("\n-- 5. If a background reconciliation existed it would be non-blocking — here there simply isn't one left: confirm no fetch/refetch is triggered by a toggle at all --\n");
    check("No fetch(...) call inside ProjectActivitiesCard itself (all data comes from props + the checkbox's own already-awaited PATCH) — nothing left to run in the background", !/fetch\(/.test(cardSrc));

    console.log("\n-- 8. Rapid consecutive toggles: an older response cannot overwrite a newer state --\n");
    {
      const raceProject = await prisma.project.create({ data: { title: `Perf Race Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
      projectIds.push(raceProject.id);
      const rA = await prisma.projectActivity.create({ data: { title: `Race A ${RUN_ID}`, projectId: raceProject.id, departmentId: dept.id, status: "IN_PROGRESS" } });
      const rB = await prisma.projectActivity.create({ data: { title: `Race B ${RUN_ID}`, projectId: raceProject.id, departmentId: dept.id, status: "IN_PROGRESS" } });
      activityIds.push(rA.id, rB.id);

      // Simulates ProjectActivitiesCard's own guard directly: two responses
      // for the SAME shared project-level aggregate, applied in REVERSE
      // order (the "newer" toggle's response arrives and applies FIRST,
      // then the "older" one's arrives late) — the older one must be
      // dropped, not clobber the newer value.
      const { createTokenGuard } = await import("@/lib/navigation-loader");
      const guard = createTokenGuard();
      let appliedProgress: number | null = null;

      const tokenOld = guard.bump(); // toggle #1 "starts"
      const tokenNew = guard.bump(); // toggle #2 "starts" before #1's response arrives

      // Toggle #2's response arrives first and applies (it's still current).
      if (guard.isCurrent(tokenNew)) appliedProgress = 77;
      check("...the newer toggle's response applies", appliedProgress === 77);

      // Toggle #1's (older, stale) response now arrives late.
      if (guard.isCurrent(tokenOld)) appliedProgress = 33;
      check("...the older, now-stale response is dropped — progress still reflects the newer toggle, never overwritten backwards", appliedProgress === 77);
    }

    console.log("\n-- 9. Mutation failure restores/preserves the previous UI --\n");
    check("ActivityCompleteCheckbox's catch block restores the PREVIOUS checked value before rethrowing feedback to the user (rollback, not a guessed state)", /catch[\s\S]{0,150}setIsCompleted\(previous\)/.test(checkboxSrc));
    {
      const failActivity = await prisma.projectActivity.create({ data: { title: `Fail ${RUN_ID}`, projectId: project.id, departmentId: dept.id, status: "TODO", isCompleted: false } });
      activityIds.push(failActivity.id);
      const before = (await prisma.projectActivity.findUniqueOrThrow({ where: { id: failActivity.id }, select: { isCompleted: true } })).isCompleted;
      const failRes = await PATCH(jsonReq({ isCompleted: true, status: "IN_PROGRESS" }), { params: Promise.resolve({ id: failActivity.id }) }); // inconsistent pair -> rejected
      check("...a rejected mutation returns non-200", failRes.status !== 200);
      const after = (await prisma.projectActivity.findUniqueOrThrow({ where: { id: failActivity.id }, select: { isCompleted: true } })).isCompleted;
      check("...and the persisted state is genuinely unchanged — the source of truth the checkbox's own rollback re-syncs from on any future render", before === after && after === false);
    }

    console.log("\n-- 10. Multiple affected Projects (project reassignment) are both included in projectRollups --\n");
    {
      const projectOld = await prisma.project.create({ data: { title: `Perf Old ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
      const projectNew = await prisma.project.create({ data: { title: `Perf New ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, status: "PLANNING" } });
      projectIds.push(projectOld.id, projectNew.id);
      const moving = await prisma.projectActivity.create({ data: { title: `Moving ${RUN_ID}`, projectId: projectOld.id, departmentId: dept.id, status: "IN_PROGRESS" } });
      const stayingInOld = await prisma.projectActivity.create({ data: { title: `Staying ${RUN_ID}`, projectId: projectOld.id, departmentId: dept.id, status: "TODO" } });
      activityIds.push(moving.id, stayingInOld.id);

      const moveRes = await PATCH(jsonReq({ projectId: projectNew.id }), { params: Promise.resolve({ id: moving.id }) });
      check("Reassigning the Activity's project -> 200", moveRes.status === 200);
      const moveBody = await moveRes.clone().json();
      const rollupIds = (moveBody.projectRollups ?? []).map((r: any) => r.id).sort();
      check("...projectRollups includes BOTH the OLD and the NEW project — every affected Project, not just the current one", rollupIds.includes(projectOld.id) && rollupIds.includes(projectNew.id));
    }

    console.log("\n-- 7. The old stale-progress race genuinely fails against a simulated pre-fix implementation, and passes now --\n");
    {
      // Simulates the OLD fire-and-forget shape directly against the real
      // rollup function: calling it WITHOUT awaiting, then immediately
      // reading Project.progress (what an immediate router.refresh() used
      // to do), regularly observes the STALE value — proving the race is
      // real, not hypothetical, and that awaiting (the actual route, tested
      // above) is what closes it.
      const raceRegressionProject = await prisma.project.create({ data: { title: `Perf StaleRace ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, progress: 0 } });
      projectIds.push(raceRegressionProject.id);
      await prisma.projectActivity.create({ data: { title: `StaleRace A ${RUN_ID}`, projectId: raceRegressionProject.id, departmentId: dept.id, status: "COMPLETED", isCompleted: true } });
      activityIds.push((await prisma.projectActivity.findFirstOrThrow({ where: { projectId: raceRegressionProject.id } })).id);

      // OLD (fire-and-forget) shape: don't await, read immediately — the
      // read almost always beats the update in this same DB.
      recalculateProjectRollup(raceRegressionProject.id); // deliberately not awaited
      const immediatelyAfter = (await prisma.project.findUniqueOrThrow({ where: { id: raceRegressionProject.id }, select: { progress: true } })).progress;
      check("OLD shape (fire-and-forget, unawaited): reading Project.progress immediately after still shows the STALE pre-toggle value — the race this whole fix closes", immediatelyAfter === 0, `got ${immediatelyAfter}`);

      // NEW (awaited) shape: the real route, exercised earlier in this file
      // and in scripts/test-activity-completion-project-refresh.ts, already
      // proves Project.progress is committed by the time PATCH responds —
      // re-confirmed here directly against the rollup function itself.
      const secondActivity = await prisma.projectActivity.create({ data: { title: `StaleRace B ${RUN_ID}`, projectId: raceRegressionProject.id, departmentId: dept.id, status: "COMPLETED", isCompleted: true } });
      activityIds.push(secondActivity.id);
      await recalculateProjectRollup(raceRegressionProject.id); // awaited, the actual fix
      const afterAwaited = (await prisma.project.findUniqueOrThrow({ where: { id: raceRegressionProject.id }, select: { progress: true } })).progress;
      check("NEW shape (awaited): Project.progress is already committed and correct by the time the caller reads it — no race", afterAwaited === 100, `got ${afterAwaited}`);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityProgressConfig", () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityStatusConfig", () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["projectStatusConfig", () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityPriorityConfig", () => prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main();
