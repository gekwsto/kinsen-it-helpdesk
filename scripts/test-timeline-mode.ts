/**
 * Actual / Expected timeline mode — Project Gantt (/projects/gantt) and
 * Resource Planning (/projects/resource-planning).
 *
 *  1. Pure resolvers (lib/timeline-mode.ts): parsing, project/activity/
 *     milestone dates, Resource Planning's Actual fallback (unchanged) vs
 *     Expected (both dates required, never an Actual fallback), the
 *     mode-aware ?from=/?to= Project filter (Actual = the previous shape).
 *  2. Resource Planning service, DB-backed: placement, server-side range
 *     filtering, unscheduled reasons, lane/overlap calculation and the
 *     utilization count all follow the mode; omitting the mode is
 *     identical to Actual.
 *  3. Server-rendered pages: Project Gantt groups/children carry the
 *     mode's dates, Expected range filtering uses Expected fields, nothing
 *     is inferred from Activities; the same edit permission in both modes.
 *  4. Source-level: the standalone Activity Gantt does not opt in; no
 *     Expected-mode editing guard remains.
 *  5. Expected-mode scheduling through the REAL PATCH routes with the
 *     shared buildSchedulingPatch mapping: Expected moves touch only
 *     Expected fields (and the canonical Expected-duration recalculation),
 *     Actual moves never touch Expected; milestones; reassignment;
 *     server-side date validation and permission; consistency across
 *     Gantt, Resource Planning and the detail (GET) endpoints.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-timeline-mode.ts
 * Server-time-zone independence: run it under TZ=UTC, TZ=Europe/Athens and
 * TZ=America/New_York — every assertion must pass unchanged.
 */
import { mock } from "node:test";
import * as React from "react";
import fs from "node:fs/promises";
(globalThis as any).React = React;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out; }
  if (pred(node)) out.push(node);
  const ch = node.props?.children;
  if (ch !== undefined) findAll(ch, pred, out);
  return out;
}
let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });
const RUN_ID = Date.now();
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (s: string) => D(s).toISOString();

async function main() {
  const tm = await import("@/lib/timeline-mode");

  console.log("\n=== 1. Shared timeline mode (pure) ===\n");
  check("Default mode is actual; only exactly 'expected' switches", tm.DEFAULT_TIMELINE_MODE === "actual" && tm.parseTimelineMode(undefined) === "actual" && tm.parseTimelineMode("") === "actual" && tm.parseTimelineMode("EXPECTED") === "actual" && tm.parseTimelineMode("bogus") === "actual" && tm.parseTimelineMode("expected") === "expected" && tm.parseTimelineMode(["expected"]) === "expected");
  const proj = { startDate: D("2027-01-04"), endDate: D("2027-01-10"), expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-07") };
  check("Project: actual → startDate/endDate, expected → expectedStart/expectedFinish", +tm.resolveProjectTimelineDates(proj, "actual").start! === +proj.startDate && +tm.resolveProjectTimelineDates(proj, "expected").end! === +proj.expectedFinishDate);
  const projNoExp = { ...proj, expectedStartDate: null, expectedFinishDate: null };
  check("Project without Expected dates → null/null in expected (no Actual fallback)", tm.resolveProjectTimelineDates(projNoExp, "expected").start === null && tm.resolveProjectTimelineDates(projNoExp, "expected").end === null);
  const act = { startDate: D("2027-01-04"), dueDate: D("2027-01-06"), expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-03"), isMilestone: false };
  check("Gantt activity: actual → startDate→dueDate (unchanged), expected → expectedStart→expectedFinish", +tm.resolveGanttActivityDates(act, "actual").start! === +act.startDate && +tm.resolveGanttActivityDates(act, "actual").end! === +act.dueDate && +tm.resolveGanttActivityDates(act, "expected").start! === +act.expectedStartDate);
  const halfExp = { ...act, expectedFinishDate: null };
  check("Gantt activity missing Expected Finish → end null in expected (→ unscheduled, never Actual)", tm.resolveGanttActivityDates(halfExp, "expected").end === null && +tm.resolveGanttActivityDates(halfExp, "expected").start! === +act.expectedStartDate);
  const ms = { startDate: D("2027-01-01"), dueDate: D("2027-01-09"), expectedStartDate: null, expectedFinishDate: D("2027-03-06"), isMilestone: true };
  check("Gantt milestone: point at dueDate (actual, unchanged) / expectedFinishDate (expected)", +tm.resolveGanttActivityDates(ms, "actual").start! === +ms.dueDate && +tm.resolveGanttActivityDates(ms, "actual").end! === +ms.dueDate && +tm.resolveGanttActivityDates(ms, "expected").start! === +ms.expectedFinishDate! && +tm.resolveGanttActivityDates(ms, "expected").end! === +ms.expectedFinishDate!);
  check("Gantt milestone without Expected Finish → unscheduled in expected", tm.resolveGanttActivityDates({ ...ms, expectedFinishDate: null }, "expected").start === null);
  const onlyDue = { startDate: null, dueDate: D("2027-01-07"), expectedStartDate: D("2027-03-01"), expectedFinishDate: null };
  const rpA = tm.resolveResourcePlanningActivityDates(onlyDue, "actual");
  check("RP actual: single-side fallback + isFallbackDate exactly as before", +rpA.start! === +onlyDue.dueDate && +rpA.end! === +onlyDue.dueDate && rpA.isFallbackDate === true);
  const rpE = tm.resolveResourcePlanningActivityDates(onlyDue, "expected");
  check("RP expected: either Expected date missing → unscheduled, no fallback, no single-day estimate", rpE.start === null && rpE.end === null && rpE.isFallbackDate === false);
  const from = D("2027-03-01"), to = D("2027-03-31");
  check("Range where (actual): interval overlap startDate <= to AND endDate >= from", JSON.stringify(tm.buildProjectTimelineRangeWhere("actual", from, to)) === JSON.stringify({ AND: [{ startDate: { lte: to } }, { endDate: { gte: from } }] }));
  check("Range where (expected): same overlap on expectedStartDate/expectedFinishDate only", JSON.stringify(tm.buildProjectTimelineRangeWhere("expected", from, to)) === JSON.stringify({ AND: [{ expectedStartDate: { lte: to } }, { expectedFinishDate: { gte: from } }] }));
  check("Range where, open-ended from only: end >= from, start must exist", JSON.stringify(tm.buildProjectTimelineRangeWhere("expected", from, null)) === JSON.stringify({ AND: [{ expectedStartDate: { not: null } }, { expectedFinishDate: { gte: from } }] }));
  check("Range where, open-ended to only: start <= to, end must exist", JSON.stringify(tm.buildProjectTimelineRangeWhere("actual", null, to)) === JSON.stringify({ AND: [{ startDate: { lte: to } }, { endDate: { not: null } }] }));
  check("Range where: invalid dates ignored (treated as not supplied)", tm.buildProjectTimelineRangeWhere("actual", new Date("garbage"), null) === null && JSON.stringify(tm.buildProjectTimelineRangeWhere("actual", new Date("garbage"), to)) === JSON.stringify(tm.buildProjectTimelineRangeWhere("actual", null, to)));
  check("Range where: none requested → null", tm.buildProjectTimelineRangeWhere("expected", null, null) === null);
  const S = "2027-03-08T00:00:00.000Z", E = "2027-03-10T00:00:00.000Z";
  const bsp = tm.buildSchedulingPatch;
  check("Scheduling patch, actual: project → startDate/endDate; activity → startDate/dueDate (the previous bodies)", JSON.stringify(bsp("project", "actual", S, E)) === JSON.stringify({ startDate: S, endDate: E }) && JSON.stringify(bsp("activity", "actual", S, E)) === JSON.stringify({ startDate: S, dueDate: E }));
  check("Scheduling patch, actual milestone: startDate = dueDate = date (the previous body)", JSON.stringify(bsp("milestone", "actual", E, E)) === JSON.stringify({ startDate: E, dueDate: E }));
  check("Scheduling patch, expected: project/activity → expectedStartDate/expectedFinishDate only", JSON.stringify(bsp("project", "expected", S, E)) === JSON.stringify({ expectedStartDate: S, expectedFinishDate: E }) && JSON.stringify(bsp("activity", "expected", S, E)) === JSON.stringify({ expectedStartDate: S, expectedFinishDate: E }));
  check("Scheduling patch, expected milestone WITHOUT Expected Start → expectedFinishDate only (start never created)", JSON.stringify(bsp("milestone", "expected", null, E)) === JSON.stringify({ expectedFinishDate: E }));
  check("Scheduling patch, expected milestone WITH Expected Start → both (shifted together)", JSON.stringify(bsp("milestone", "expected", S, E)) === JSON.stringify({ expectedStartDate: S, expectedFinishDate: E }));
  check("Scheduling patch, actual milestone ignores any start (startDate = dueDate = date, unchanged)", JSON.stringify(bsp("milestone", "actual", S, E)) === JSON.stringify({ startDate: E, dueDate: E }));
  check("No mapping ever mixes Actual and Expected fields", (["project", "activity", "milestone"] as const).every((t) => { const a = Object.keys(bsp(t, "actual", S, E)), e = Object.keys(bsp(t, "expected", S, E)); return a.every((k) => !k.startsWith("expected")) && e.every((k) => k.startsWith("expected")); }));

  console.log("\n=== 1b. Date-only display + snapshot reconciliation (pure) ===\n");
  {
    const { formatDateOnly } = await import("@/lib/utils");
    const { dateOnlyAsLocalDate } = await import("@/lib/date-only");
    const { differenceInCalendarDays, format } = await import("date-fns");
    const originalTz = process.env.TZ;
    const shown: string[] = [];
    for (const zone of ["UTC", "Europe/Athens", "America/New_York"]) {
      process.env.TZ = zone;
      shown.push([
        formatDateOnly("2027-03-14T00:00:00.000Z"), // New York spring-forward day
        formatDateOnly("2027-03-28T00:00:00.000Z"), // Athens spring-forward day
        formatDateOnly("2027-01-07T03:00:00.000Z"), // legacy 03:00Z value
        format(dateOnlyAsLocalDate("2027-03-12T00:00:00.000Z"), "EEE d"),
        String(differenceInCalendarDays(dateOnlyAsLocalDate("2027-03-30T00:00:00.000Z"), dateOnlyAsLocalDate("2027-03-10T00:00:00.000Z"))),
      ].join("|"));
    }
    process.env.TZ = originalTz;
    check("formatDateOnly / dateOnlyAsLocalDate show the stored UTC calendar day identically under UTC, Athens and New York (incl. DST days)", new Set(shown).size === 1 && shown[0] === "14 Mar 2027|28 Mar 2027|07 Jan 2027|Fri 12|20", JSON.stringify(shown));
    const { formatDate } = await import("@/lib/utils");
    process.env.TZ = "America/New_York";
    const tsNy = formatDate("2027-03-14T03:00:00.000Z");
    process.env.TZ = originalTz;
    check("Genuine timestamps keep local formatting (formatDate unchanged: 03:00Z is still 13 Mar in New York)", tsNy === "13 Mar 2027");
  }
  {
    const { shouldKeepLocal, isStaleSnapshot, recordConfirmedWrite } = await import("@/lib/timeline-reconcile");
    const state = { pending: new Set<string>(["p"]), confirmed: new Map<string, string>() };
    recordConfirmedWrite(state, "c", { updatedAt: "2027-01-01T10:00:05.000Z" });
    check("In-flight item keeps its optimistic local copy", shouldKeepLocal("p", "2099-01-01T00:00:00.000Z", state) === true);
    check("Snapshot OLDER than our committed write (stale refresh) keeps the local copy", shouldKeepLocal("c", "2027-01-01T10:00:04.000Z", state) === true && state.confirmed.has("c"));
    check("Snapshot that caught up (same updatedAt) wins and clears the confirmation", shouldKeepLocal("c", "2027-01-01T10:00:05.000Z", state) === false && !state.confirmed.has("c"));
    recordConfirmedWrite(state, "c", { updatedAt: "2027-01-01T10:00:05.000Z" });
    check("Someone else's NEWER change wins over our confirmation", shouldKeepLocal("c", "2027-01-01T10:00:09.000Z", state) === false);
    check("Unknown / version-less snapshot is never treated as stale (server wins, as before)", shouldKeepLocal("x", "2027-01-01T00:00:00.000Z", state) === false && isStaleSnapshot(undefined, "2027-01-01T00:00:00.000Z") === false);
  }

  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider, ActivityStatus, ActivityPriority, ProjectStatus } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { getResourcePlanningEvents } = await import("@/lib/services/resource-planning-service");
  const { assignLanes } = await import("@/lib/resource-planning-lanes");
  const { default: ProjectGanttPage } = await import("@/app/(main)/projects/gantt/page");
  const { default: ResourcePlanningPage } = await import("@/app/(main)/projects/resource-planning/page");
  const projectRoute = await import("@/app/api/projects/[id]/route");
  const activityRoute = await import("@/app/api/activities/[id]/route");
  const { NextRequest } = await import("next/server");
  const { workingDaysBetween, shiftDateOnly } = await import("@/lib/date-only");
  const { resolveProjectDuration } = await import("@/lib/project-duration");

  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], activities: [] as string[] };
  try {
    const dept = await createDepartment({ name: `Timeline ${RUN_ID}`, slug: `timeline-${RUN_ID}` });
    ids.depts.push(dept.id);
    const admin = await prisma.user.create({ data: { email: `timeline-admin-${RUN_ID}@kinsen.gr`, name: `Timeline Admin`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const agent = await prisma.user.create({ data: { email: `timeline-agent-${RUN_ID}@kinsen.gr`, name: `Timeline Agent`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ids.users.push(admin.id, agent.id);

    // P1: Actual in January, Expected in March. P2: Actual in March, no Expected at all.
    const p1 = await prisma.project.create({ data: { title: `TL P1 ${RUN_ID}`, ownerId: admin.id, departmentId: dept.id, status: ProjectStatus.IN_PROGRESS, startDate: D("2027-01-04"), endDate: D("2027-01-24"), expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-14") } });
    const p2 = await prisma.project.create({ data: { title: `TL P2 ${RUN_ID}`, ownerId: admin.id, departmentId: dept.id, status: ProjectStatus.PLANNING, startDate: D("2027-03-15"), endDate: D("2027-03-20") } });
    // P3: half-dated in both modes (start only) — never "in" a range it has no interval for.
    const p3 = await prisma.project.create({ data: { title: `TL P3 ${RUN_ID}`, ownerId: admin.id, departmentId: dept.id, status: ProjectStatus.PLANNING, startDate: D("2027-01-10"), expectedStartDate: D("2027-03-02") } });
    ids.projects.push(p1.id, p2.id, p3.id);
    const mk = async (title: string, data: Record<string, unknown>) => {
      const a = await prisma.projectActivity.create({ data: { title: `${title} ${RUN_ID}`, projectId: p1.id, departmentId: dept.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, assignedUsers: { connect: [{ id: agent.id }] }, ...data } });
      ids.activities.push(a.id);
      return a;
    };
    // Actual overlaps: A1×A2, A2×A6.  Expected overlaps: A1×A3×A5.
    const a1 = await mk("A1", { startDate: D("2027-01-04"), dueDate: D("2027-01-06"), expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-03") });
    const a2 = await mk("A2", { startDate: D("2027-01-05"), dueDate: D("2027-01-08"), expectedStartDate: D("2027-03-10"), expectedFinishDate: D("2027-03-12") });
    const a3 = await mk("A3", { startDate: D("2027-01-20"), dueDate: D("2027-01-22"), expectedStartDate: D("2027-03-02"), expectedFinishDate: D("2027-03-04") });
    const a4 = await mk("A4 half expected", { startDate: D("2027-01-09"), dueDate: D("2027-01-09"), expectedStartDate: D("2027-03-05") });
    const a5 = await mk("A5 expected only", { expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-02") });
    const a6 = await mk("A6 due only", { dueDate: D("2027-01-07") });
    const m1 = await mk("M1 milestone", { isMilestone: true, dueDate: D("2027-01-09"), expectedFinishDate: D("2027-03-06") });
    const dep = await prisma.activityDependency.create({ data: { predecessorId: a1.id, successorId: a2.id, type: "FINISH_TO_START" } });

    console.log("\n=== 2. Resource Planning service ===\n");
    const janWeek = { departmentId: dept.id, rangeStart: D("2027-01-04"), rangeEnd: new Date("2027-01-10T23:59:59.999Z") };
    const marWeek = { departmentId: dept.id, rangeStart: D("2027-03-01"), rangeEnd: new Date("2027-03-07T23:59:59.999Z") };
    const byId = (r: { events: any[] }) => new Map(r.events.map((e) => [e.id, e]));

    const actJanDefault = await getResourcePlanningEvents(janWeek);
    const actJan = await getResourcePlanningEvents({ ...janWeek, timelineMode: "actual" });
    check("Omitting the mode is identical to explicit Actual (existing behaviour preserved)", JSON.stringify(actJanDefault) === JSON.stringify(actJan));
    const aj = byId(actJan);
    check("Actual Jan week: A1, A2, A4, A6, M1 placed at their ACTUAL dates; A3 (Jan 20) range-filtered out", aj.has(a1.id) && aj.has(a2.id) && aj.has(a4.id) && aj.has(a6.id) && aj.has(m1.id) && !aj.has(a3.id) && aj.get(a1.id)!.start === iso("2027-01-04") && aj.get(a2.id)!.end === iso("2027-01-08"));
    check("Actual: due-only A6 keeps its single-day fallback (isFallbackDate)", aj.get(a6.id)?.isFallbackDate === true && aj.get(a6.id)?.start === iso("2027-01-07"));
    check("Actual: expected-only A5 is unscheduled 'no-dates' (unchanged)", actJan.unscheduled.some((e) => e.id === a5.id && e.unscheduledReason === "no-dates"));

    const expJan = await getResourcePlanningEvents({ ...janWeek, timelineMode: "expected" });
    check("Expected Jan week: nothing placed (no Expected date falls in January — Actual dates never used)", expJan.events.length === 0);

    const expMar = await getResourcePlanningEvents({ ...marWeek, timelineMode: "expected" });
    const em = byId(expMar);
    check("Expected Mar week: A1, A3, A5 placed at their EXPECTED dates; A2 (Mar 10) range-filtered out", em.has(a1.id) && em.has(a3.id) && em.has(a5.id) && !em.has(a2.id) && em.get(a1.id)!.start === iso("2027-03-01") && em.get(a1.id)!.end === iso("2027-03-03") && em.get(a3.id)!.start === iso("2027-03-02"));
    const reasons = new Map(expMar.unscheduled.map((e) => [e.id, e.unscheduledReason]));
    check("Expected: A4 (Expected Finish missing), A6 (no Expected), M1 (Expected Start missing) unscheduled 'no-expected-dates'", reasons.get(a4.id) === "no-expected-dates" && reasons.get(a6.id) === "no-expected-dates" && reasons.get(m1.id) === "no-expected-dates");
    check("Expected: no event is a single-day estimate; no unscheduled item carries fabricated dates", expMar.events.every((e) => e.isFallbackDate === false) && expMar.unscheduled.filter((e) => e.unscheduledReason !== "no-assignee").every((e) => e.start === null && e.end === null));
    const actMar = await getResourcePlanningEvents({ ...marWeek, timelineMode: "actual" });
    check("Actual Mar week: nothing placed (Expected dates never used in Actual)", actMar.events.length === 0);

    const lanes = (r: { events: any[] }) => assignLanes(new Map([[agent.id, r.events.filter((e) => e.assignedUserIds.includes(agent.id)).map((e) => ({ id: e.id, start: e.start!, end: e.end!, title: e.title, priority: e.priority }))]]));
    const actLanes = lanes(actJan), expLanes = lanes(expMar);
    // assignLanes gives every activity its own lane, ordered by priority
    // then START date — so lane count and order must follow the mode.
    const laneOrder = (l: ReturnType<typeof assignLanes>, ids: string[]) => ids.map((id) => l.laneByKey.get(`${agent.id}:${id}`));
    check("Actual lanes: 5 lanes in Actual start order (A1 Jan 4, A2 Jan 5, A6 Jan 7, A4/M1 Jan 9)", actLanes.laneCountByResource.get(agent.id) === 5 && JSON.stringify(laneOrder(actLanes, [a1.id, a2.id, a6.id])) === JSON.stringify([0, 1, 2]));
    check("Expected lanes: 3 lanes in Expected start order (A1/A5 Mar 1, A3 Mar 2) — overlapping Expected bars stacked, not superimposed", expLanes.laneCountByResource.get(agent.id) === 3 && expLanes.laneByKey.get(`${agent.id}:${a3.id}`) === 2 && new Set(laneOrder(expLanes, [a1.id, a3.id, a5.id])).size === 3);
    check("Utilization count follows the mode (Actual Jan: 5, Expected Mar: 3)", actJan.events.filter((e) => e.assignedUserIds.includes(agent.id)).length === 5 && expMar.events.length === 3);
    check("Expected Mar sort is by Expected start (A1/A5 Mar 1 before A3 Mar 2)", expMar.events.findIndex((e) => e.id === a3.id) === 2);

    console.log("\n=== 3. Server-rendered pages ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const gantt = async (sp: Record<string, string>) => {
      const el = await ProjectGanttPage({ searchParams: Promise.resolve({ departmentId: dept.id, ...sp }) });
      return findAll(el, (n) => Array.isArray(n.props?.groups))[0]?.props;
    };
    const ga = await gantt({});
    const ge = await gantt({ timeline: "expected" });
    const g1a = ga.groups.find((g: any) => g.id === p1.id), g1e = ge.groups.find((g: any) => g.id === p1.id);
    const child = (g: any, id: string) => g.children.find((c: any) => c.id === id);
    check("Gantt Actual (default): timelineMode='actual', canEdit kept, Project at Actual dates", ga.timelineMode === "actual" && ga.canEdit === true && g1a.startDate === iso("2027-01-04") && g1a.endDate === iso("2027-01-24"));
    check("Gantt Actual: activity/milestone dates unchanged (A1 startDate→dueDate, M1 point at dueDate)", child(g1a, a1.id).startDate === iso("2027-01-04") && child(g1a, a1.id).endDate === iso("2027-01-06") && child(g1a, m1.id).startDate === iso("2027-01-09") && child(g1a, m1.id).endDate === iso("2027-01-09"));
    check("Gantt Expected: timelineMode='expected' and the SAME edit permission as Actual (canEdit=true for an editor)", ge.timelineMode === "expected" && ge.canEdit === true);
    check("Gantt Expected: Project P1 at its Expected dates", g1e.startDate === iso("2027-03-01") && g1e.endDate === iso("2027-03-14"));
    check("Gantt Expected: A1/A3 at Expected dates, M1 point at Expected Finish", child(g1e, a1.id).startDate === iso("2027-03-01") && child(g1e, a3.id).endDate === iso("2027-03-04") && child(g1e, m1.id).startDate === iso("2027-03-06") && child(g1e, m1.id).endDate === iso("2027-03-06"));
    check("Gantt Expected: A4 / A6 have no complete Expected pair → no bar (end/start null, never Actual)", child(g1e, a4.id).endDate === null && child(g1e, a6.id).startDate === null && child(g1e, a6.id).endDate === null);
    const g2e = ge.groups.find((g: any) => g.id === p2.id);
    check("Gantt Expected: P2 without Expected dates → null/null (not inferred from Activities, no Actual fallback)", g2e && g2e.startDate === null && g2e.endDate === null);
    {
      const p1Row = await prisma.project.findUniqueOrThrow({ where: { id: p1.id }, select: { updatedAt: true } });
      const a1Row = await prisma.projectActivity.findUniqueOrThrow({ where: { id: a1.id }, select: { updatedAt: true } });
      const rpSnap = await getResourcePlanningEvents({ ...marWeek, timelineMode: "expected" });
      check("Snapshots carry record versions for stale-refresh protection (Gantt group/child, Resource Planning event updatedAt)", g1e.updatedAt === p1Row.updatedAt.toISOString() && child(g1e, a1.id).updatedAt === a1Row.updatedAt.toISOString() && rpSnap.events.find((e) => e.id === a1.id)?.updatedAt === a1Row.updatedAt.toISOString());
    }
    check("Gantt: dependencies identical in both modes", ga.dependencies.some((d: any) => d.id === dep.id) && JSON.stringify(ga.dependencies) === JSON.stringify(ge.dependencies));
    check("Gantt: status/overdue unchanged between modes", g1a.status === g1e.status && g1a.overdue === g1e.overdue && child(g1a, a1.id).statusColor === child(g1e, a1.id).statusColor);
    const ids_ = (p: any) => p.groups.map((g: any) => g.id).filter((id: string) => [p1.id, p2.id, p3.id].includes(id)).sort();
    const marchA = await gantt({ from: "2027-03-01", to: "2027-03-31" });
    const marchE = await gantt({ from: "2027-03-01", to: "2027-03-31", timeline: "expected" });
    check("Gantt range filter, Actual March: only P2 (Actual in March)", JSON.stringify(ids_(marchA)) === JSON.stringify([p2.id]));
    check("Gantt range filter, Expected March: only P1 (Expected in March), never P2 via Actual dates", JSON.stringify(ids_(marchE)) === JSON.stringify([p1.id]));
    const janE = await gantt({ from: "2027-01-01", to: "2027-01-31", timeline: "expected" });
    check("Gantt range filter, Expected January: no project (January dates are ACTUAL only)", ids_(janE).length === 0);
    const spanA = await gantt({ from: "2027-01-10", to: "2027-01-12" });
    check("Overlap, Actual: P1 (Jan 4–24) SPANNING the whole Jan 10–12 range is included", JSON.stringify(ids_(spanA)) === JSON.stringify([p1.id]));
    const spanE = await gantt({ from: "2027-03-05", to: "2027-03-06", timeline: "expected" });
    check("Overlap, Expected: P1 (Expected Mar 1–14) spanning Mar 5–6 is included; half-dated P3 is not", JSON.stringify(ids_(spanE)) === JSON.stringify([p1.id]));
    const p1InSpan = spanE.groups.find((g: any) => g.id === p1.id);
    check("Overlap, Expected: the matching Project's milestone still renders (point at Expected Finish)", p1InSpan?.children.find((c: any) => c.id === m1.id)?.startDate === iso("2027-03-06"));
    const edgeA = await gantt({ from: "2027-01-24", to: "2027-01-24" });
    check("Overlap is inclusive at the boundary (range = P1's own end day)", JSON.stringify(ids_(edgeA)) === JSON.stringify([p1.id]));
    const fromOnly = await gantt({ from: "2027-03-16" });
    check("Open-ended from only (Actual): P2 (ends Mar 20) included, P1 (ended Jan 24) and half-dated P3 excluded", JSON.stringify(ids_(fromOnly)) === JSON.stringify([p2.id]));
    const toOnly = await gantt({ to: "2027-01-05" });
    check("Open-ended to only (Actual): P1 (starts Jan 4) included, P2 (starts Mar 15) and half-dated P3 excluded", JSON.stringify(ids_(toOnly)) === JSON.stringify([p1.id]));
    const toOnlyE = await gantt({ to: "2027-03-31", timeline: "expected" });
    check("Open-ended to only (Expected): only P1 — P2 has no Expected dates, P3 only an Expected Start", JSON.stringify(ids_(toOnlyE)) === JSON.stringify([p1.id]));
    const noFilter = await gantt({ timeline: "expected" });
    check("No range filter: half-dated P3 still listed, without a bar (Expected Finish missing → unscheduled)", ids_(noFilter).includes(p3.id) && noFilter.groups.find((g: any) => g.id === p3.id).endDate === null);

    const rp = async (sp: Record<string, string>) => {
      const el = await ResourcePlanningPage({ searchParams: Promise.resolve({ departmentId: dept.id, from: "2027-03-01", ...sp }) });
      return {
        timeline: findAll(el, (n) => Array.isArray(n.props?.events) && Array.isArray(n.props?.resources))[0]?.props,
        toolbar: findAll(el, (n) => typeof n.props?.rangeLabel === "string")[0]?.props,
        unscheduled: findAll(el, (n) => Array.isArray(n.props?.unscheduled) && !("selectedDepartmentId" in n.props))[0]?.props,
      };
    };
    const rpa = await rp({});
    const rpe = await rp({ timeline: "expected" });
    check("RP page Actual (default): toolbar/timeline in actual, editing kept; nothing in the Mar week", rpa.toolbar?.timelineMode === "actual" && rpa.timeline?.timelineMode === "actual" && rpa.timeline?.canEdit === true && rpa.timeline.events.length === 0);
    check("RP page Expected: toolbar/timeline in expected, editing allowed for an editor, A1/A3/A5 placed", rpe.toolbar?.timelineMode === "expected" && rpe.timeline?.timelineMode === "expected" && rpe.timeline?.canEdit === true && JSON.stringify(rpe.timeline.events.map((e: any) => e.id).sort()) === JSON.stringify([a1.id, a3.id, a5.id].sort()));
    const agentRow = rpe.timeline.resources.find((r: any) => r.id === agent.id);
    check("RP page Expected: agent utilization counted from Expected events (3 scheduled)", agentRow?.utilization.count === 3);
    check("RP page Expected: unscheduled panel gets the mode", rpe.unscheduled?.timelineMode === "expected");
    check("RP page Expected: view/from preserved (same Mar week label in both modes)", rpa.toolbar.rangeLabel === rpe.toolbar.rangeLabel && rpe.toolbar.view === "week");

    console.log("\n=== 4. Source-level ===\n");
    const activityGantt = await fs.readFile("app/(main)/activities/gantt/page.tsx", "utf8");
    check("Standalone Activity Gantt does not opt in (no timelineMode → no toggle, unchanged)", !/timelineMode/.test(activityGantt));
    const chart = await fs.readFile("components/gantt/gantt-chart.tsx", "utf8");
    const timeline = await fs.readFile("components/resource-planning/resource-timeline.tsx", "utf8");
    const ganttPageSrc = await fs.readFile("app/(main)/projects/gantt/page.tsx", "utf8");
    const rpPageSrc = await fs.readFile("app/(main)/projects/resource-planning/page.tsx", "utf8");
    check("No Expected-mode editing guard remains (components or pages)", ![chart, timeline, ganttPageSrc, rpPageSrc].some((src) => /canEditProp && !isExpectedMode|timelineMode === "actual"\}/.test(src)));
    check("Both drag handlers build their PATCH body through the shared buildSchedulingPatch (no parallel drag implementation)", /buildSchedulingPatch\(/.test(chart) && /buildSchedulingPatch\("activity"/.test(timeline));

    console.log("\n=== 5. Expected-mode scheduling through the real PATCH routes ===\n");
    const patchReq = (b: unknown) => new NextRequest("http://localhost/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const patchActivity = (id: string, b: unknown) => activityRoute.PATCH(patchReq(b), { params: Promise.resolve({ id }) });
    const patchProject = (id: string, b: unknown) => projectRoute.PATCH(patchReq(b), { params: Promise.resolve({ id }) });
    const getA = (id: string) => prisma.projectActivity.findUniqueOrThrow({ where: { id }, include: { assignedUsers: { select: { id: true } } } });
    const getP = (id: string) => prisma.project.findUniqueOrThrow({ where: { id } });
    const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
    const actualOf = (a: any) => [a.startDate, a.dueDate];
    const expectedOf = (a: any) => [a.expectedStartDate, a.expectedFinishDate];
    const sameAll = (x: (Date | null)[], y: (Date | null)[]) => x.every((v, i) => same(v, y[i]));
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // Activity whole-bar move (+7d, duration preserved) in Expected.
    const a1Before = await getA(a1.id);
    const r1 = await patchActivity(a1.id, tm.buildSchedulingPatch("activity", "expected", iso("2027-03-08"), iso("2027-03-10")));
    const a1After = await getA(a1.id);
    check("Expected activity move → 200; Expected Start/Finish persisted (Mar 8–10)", r1.status === 200 && +a1After.expectedStartDate! === +D("2027-03-08") && +a1After.expectedFinishDate! === +D("2027-03-10"));
    check("...Actual startDate/dueDate untouched", sameAll(actualOf(a1After), actualOf(a1Before)));
    check("...expectedDays recalculated canonically (working days, lib/date-only)", a1After.expectedDays === workingDaysBetween(D("2027-03-08"), D("2027-03-10")));
    // Actual move never touches Expected.
    const r1b = await patchActivity(a1.id, tm.buildSchedulingPatch("activity", "actual", iso("2027-01-05"), iso("2027-01-07")));
    const a1Actual = await getA(a1.id);
    check("Actual activity move → 200; Actual dates moved, Expected dates and expectedDays untouched", r1b.status === 200 && +a1Actual.startDate! === +D("2027-01-05") && +a1Actual.dueDate! === +D("2027-01-07") && sameAll(expectedOf(a1Actual), expectedOf(a1After)) && a1Actual.expectedDays === a1After.expectedDays);

    // Project move in Expected.
    const p1Before = await getP(p1.id);
    const rp1 = await patchProject(p1.id, tm.buildSchedulingPatch("project", "expected", iso("2027-03-03"), iso("2027-03-16")));
    const p1After = await getP(p1.id);
    const expDur = resolveProjectDuration({ start: D("2027-03-03"), finish: D("2027-03-16"), override: undefined, current: { value: p1Before.expectedTotalInitialDays, overridden: p1Before.expectedTotalInitialDaysOverridden } });
    check("Expected project move → 200; Expected Start/Finish persisted", rp1.status === 200 && +p1After.expectedStartDate! === +D("2027-03-03") && +p1After.expectedFinishDate! === +D("2027-03-16"));
    check("...Actual startDate/endDate and actualTotalDays untouched", same(p1After.startDate, p1Before.startDate) && same(p1After.endDate, p1Before.endDate) && p1After.actualTotalDays === p1Before.actualTotalDays);
    check("...expectedTotalInitialDays recalculated via resolveProjectDuration", p1After.expectedTotalInitialDays === expDur.value && p1After.expectedTotalInitialDaysOverridden === expDur.overridden);
    const rp1b = await patchProject(p1.id, tm.buildSchedulingPatch("project", "actual", iso("2027-01-05"), iso("2027-01-25")));
    const p1Actual = await getP(p1.id);
    check("Actual project move → 200; Expected dates and expectedTotalInitialDays untouched", rp1b.status === 200 && +p1Actual.startDate! === +D("2027-01-05") && same(p1Actual.expectedStartDate, p1After.expectedStartDate) && same(p1Actual.expectedFinishDate, p1After.expectedFinishDate) && p1Actual.expectedTotalInitialDays === p1After.expectedTotalInitialDays);

    // Milestone in Expected: only Expected Finish moves.
    const m1Before = await getA(m1.id);
    // Drag path: Expected Finish shifted +3 with the canonical shift; no Expected Start → null.
    const rm = await patchActivity(m1.id, tm.buildSchedulingPatch("milestone", "expected", null, shiftDateOnly(m1Before.expectedFinishDate!, 3)));
    const m1After = await getA(m1.id);
    check("Expected milestone move → 200; only expectedFinishDate changed (Mar 9), Expected Start still empty", rm.status === 200 && +m1After.expectedFinishDate! === +D("2027-03-09") && m1After.expectedStartDate === null);
    check("...Actual milestone dates untouched", sameAll(actualOf(m1After), actualOf(m1Before)));
    const rmA = await patchActivity(m1.id, tm.buildSchedulingPatch("milestone", "actual", iso("2027-01-12"), iso("2027-01-12")));
    const m1Actual = await getA(m1.id);
    check("Actual milestone move → 200 (startDate = dueDate = date, as before); Expected Finish untouched", rmA.status === 200 && +m1Actual.dueDate! === +D("2027-01-12") && +m1Actual.startDate! === +D("2027-01-12") && same(m1Actual.expectedFinishDate, m1After.expectedFinishDate));

    // Milestone WITH both Expected dates: both shift by the same delta, backwards and forwards.
    const m2 = await mk("M2 milestone both", { isMilestone: true, dueDate: D("2027-01-15"), startDate: D("2027-01-15"), expectedStartDate: D("2027-03-05"), expectedFinishDate: D("2027-03-08") });
    const moveMilestone = async (days: number) => {
      const cur = await getA(m2.id);
      return patchActivity(m2.id, tm.buildSchedulingPatch("milestone", "expected", shiftDateOnly(cur.expectedStartDate!, days), shiftDateOnly(cur.expectedFinishDate!, days)));
    };
    const rBack = await moveMilestone(-6); // finish lands BEFORE the original start — no validation conflict
    const m2Back = await getA(m2.id);
    check("Expected milestone with both dates moved -6d → 200; both shifted (Feb 27 / Mar 2), 3-day spread preserved", rBack.status === 200 && m2Back.expectedStartDate!.toISOString() === iso("2027-02-27") && m2Back.expectedFinishDate!.toISOString() === iso("2027-03-02"));
    const rFwd = await moveMilestone(10);
    const m2Fwd = await getA(m2.id);
    check("...then +10d → 200; both shifted (Mar 9 / Mar 12), spread preserved", rFwd.status === 200 && m2Fwd.expectedStartDate!.toISOString() === iso("2027-03-09") && m2Fwd.expectedFinishDate!.toISOString() === iso("2027-03-12"));
    check("...its Actual dates never touched", +m2Fwd.dueDate! === +D("2027-01-15") && +m2Fwd.startDate! === +D("2027-01-15"));
    check("...stored values are canonical UTC midnight", [m2Fwd.expectedStartDate!, m2Fwd.expectedFinishDate!, m1After.expectedFinishDate!].every((d) => d.toISOString().endsWith("T00:00:00.000Z")));

    // Financials: Expected Days, Estimated Cost (activity + Project rollup), Actual Days/Cost.
    const fin = await mk("F1 costed", { expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-03"), taskSubTypeCost: "150.00" });
    const done = await mk("F2 completed", { status: ActivityStatus.COMPLETED, isCompleted: true, completedAt: D("2027-01-20"), actualDays: 5, expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-05"), expectedDays: 4, taskSubTypeCost: "100.00" });
    const rFin = await patchActivity(fin.id, tm.buildSchedulingPatch("activity", "expected", shiftDateOnly(fin.expectedStartDate!, 4), shiftDateOnly(fin.expectedFinishDate!, 4))); // Fri Mar 5 – Sun Mar 7
    const finAfter = await getA(fin.id);
    const finDays = workingDaysBetween(D("2027-03-05"), D("2027-03-07"));
    check("Costed activity Expected move → expectedDays recalculated with the canonical working-day rule (Fri→Sun = 1)", rFin.status === 200 && finAfter.expectedDays === finDays && finDays === 1);
    const finDetail = await (await activityRoute.GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: fin.id }) })).json();
    check("...Estimated Cost = taskSubTypeCost × expectedDays (150 × 1)", Number(finDetail.estimatedCost) === 150 * finDays);
    const rDone = await patchActivity(done.id, tm.buildSchedulingPatch("activity", "expected", shiftDateOnly(done.expectedStartDate!, 7), shiftDateOnly(done.expectedFinishDate!, 7)));
    const doneAfter = await getA(done.id);
    const doneDetail = await (await activityRoute.GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: done.id }) })).json();
    check("Completed activity Expected move → expectedDays recalculated (Mar 8–12 = 4), Actual Days unchanged (5)", rDone.status === 200 && doneAfter.expectedDays === workingDaysBetween(D("2027-03-08"), D("2027-03-12")) && doneAfter.actualDays === 5);
    check("...Actual Cost unchanged (100 × 5), Estimated Cost follows Expected Days (100 × 4)", Number(doneDetail.actualCost) === 500 && Number(doneDetail.estimatedCost) === 100 * doneAfter.expectedDays!);
    const pFin = await (await projectRoute.GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: p1.id }) })).json();
    check("Project financial rollup = Σ cost × expectedDays (150×1 + 100×4) and Σ cost × actualDays (100×5)", Number(pFin.estimatedCost) === 150 * finDays + 100 * doneAfter.expectedDays! && Number(pFin.actualCost) === 500);

    // Reassignment between resources in Expected (Resource Planning drag).
    const a2Before = await getA(a2.id);
    const ra = await patchActivity(a2.id, { ...tm.buildSchedulingPatch("activity", "expected", iso("2027-03-11"), iso("2027-03-13")), assignedUserIds: [admin.id] });
    const a2After = await getA(a2.id);
    check("Expected move + reassignment → 200; assignee changed exactly as in Actual mode, Expected dates shifted", ra.status === 200 && JSON.stringify(a2After.assignedUsers.map((u) => u.id)) === JSON.stringify([admin.id]) && +a2After.expectedStartDate! === +D("2027-03-11"));
    check("...Actual dates untouched by the Expected reassignment", sameAll(actualOf(a2After), actualOf(a2Before)));

    // Server-side date validation.
    const a3Before = await getA(a3.id);
    const rbad = await patchActivity(a3.id, { expectedFinishDate: iso("2027-02-01") });
    check("Expected Finish before Expected Start (e.g. a milestone-finish move past its start) → 400 invalid_expected_dates, nothing persisted", rbad.status === 400 && (await rbad.json()).code === "invalid_expected_dates" && sameAll(expectedOf(await getA(a3.id)), expectedOf(a3Before)));
    const rbadP = await patchProject(p1.id, { expectedStartDate: iso("2027-04-01"), expectedFinishDate: iso("2027-03-01") });
    check("Project Expected range inverted → 400, nothing persisted", rbadP.status === 400 && same((await getP(p1.id)).expectedStartDate, p1Actual.expectedStartDate));

    // Permission enforcement (no project.edit / activity.edit anywhere).
    currentSession = { user: { id: agent.id, role: Role.USER, customRoleId: null } };
    const a5Before = await getA(a5.id);
    const rForbA = await patchActivity(a5.id, tm.buildSchedulingPatch("activity", "expected", iso("2027-04-01"), iso("2027-04-02")));
    const rForbP = await patchProject(p1.id, tm.buildSchedulingPatch("project", "expected", iso("2027-04-01"), iso("2027-04-20")));
    check("No activity.edit → 403 on an Expected move; nothing persisted", rForbA.status === 403 && sameAll(expectedOf(await getA(a5.id)), expectedOf(a5Before)));
    check("No project.edit → 403 on an Expected project move; nothing persisted", rForbP.status === 403 && same((await getP(p1.id)).expectedStartDate, p1Actual.expectedStartDate));
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // Consistency across views.
    const geAfter = await gantt({ timeline: "expected" });
    const g1After = geAfter.groups.find((g: any) => g.id === p1.id);
    check("Project Gantt (Expected) shows the moved Expected dates (P1 Mar 3–16, A1 Mar 8–10, M1 Mar 9)", g1After.startDate === iso("2027-03-03") && g1After.endDate === iso("2027-03-16") && child(g1After, a1.id).startDate === iso("2027-03-08") && child(g1After, m1.id).endDate === iso("2027-03-09"));
    const gaAfter = await gantt({});
    check("Project Gantt (Actual) shows the moved Actual dates (A1 Jan 5–7)", child(gaAfter.groups.find((g: any) => g.id === p1.id), a1.id).startDate === iso("2027-01-05"));
    const rpAfter = await getResourcePlanningEvents({ departmentId: dept.id, rangeStart: D("2027-03-08"), rangeEnd: new Date("2027-03-14T23:59:59.999Z"), timelineMode: "expected" });
    const rpA1 = rpAfter.events.find((e) => e.id === a1.id), rpA2 = rpAfter.events.find((e) => e.id === a2.id);
    check("Resource Planning (Expected) shows A1 at Mar 8–10 and A2 on its NEW resource", rpA1?.start === iso("2027-03-08") && rpA1?.end === iso("2027-03-10") && JSON.stringify(rpA2?.assignedUserIds) === JSON.stringify([admin.id]));
    const detail = await (await activityRoute.GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: a1.id }) })).json();
    check("Activity detail endpoint returns the moved Expected AND Actual dates", detail.expectedStartDate === iso("2027-03-08") && detail.startDate === iso("2027-01-05"));
    const pDetail = await (await projectRoute.GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: p1.id }) })).json();
    check("Project detail endpoint returns the moved Expected dates + recalculated duration", pDetail.expectedStartDate === iso("2027-03-03") && pDetail.expectedTotalInitialDays === expDur.value);
    check("No schema change for this feature (no timeline columns)", !/timelineMode|timeline_mode/i.test(await fs.readFile("prisma/schema.prisma", "utf8")));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["deps", () => prisma.activityDependency.deleteMany({ where: { OR: [{ predecessorId: { in: ids.activities } }, { successorId: { in: ids.activities } }] } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${e.message}`); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
