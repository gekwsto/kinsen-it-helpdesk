/**
 * Ticket Resolution Time Tracking (manual effort, 1 day = 8h = 480 min).
 *
 * Exercises the REAL route handlers (PATCH /api/tickets/[id]/status,
 * PATCH /api/tickets/[id]/resolution-time) and the REAL ticket detail
 * Server Component against the local database, with mocked @/lib/auth,
 * next/headers, next/server's after(), web-push and the realtime publisher
 * (captured) — same convention as
 * scripts/test-ticket-link-department-scoped-permission.ts.
 *
 *  A. Shared utility: conversion, normalization, formatting, input parsing.
 *  B. API schema validation (non-negative integer, cap, null vs omitted).
 *  C. Resolve workflow: with / without / partial / zero / explicit null,
 *     atomic status + duration + audit, rejected off-resolution, invalid.
 *  D. Reopen and re-resolve: preserved, retained, modified, cleared.
 *  E. Standalone edit: add on resolved + closed tickets, edit, clear,
 *     omitted field rejected, no-op, status/closedAt untouched, audit.
 *  F. Permissions: dedicated key, department-scoped, UI flag + API.
 *  G. Catalogue migration idempotency, historical tickets untouched,
 *     SLA / project / activity code independent.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-resolution-time.ts
 */
import { mock } from "node:test";
import fs from "fs";
import path from "path";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, RoleScope } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import {
  durationPartsToMinutes,
  minutesToDurationParts,
  minutesToDurationInputs,
  formatResolutionTime,
  parseDurationInputs,
  resolutionTimeMinutesSchema,
  MAX_RESOLUTION_TIME_MINUTES,
} from "@/lib/resolution-time";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const RUN_ID = Date.now();
const TAG = `trt-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
const events: { type: string; ticketId: string; payload: any }[] = [];

mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });
mock.module("@/lib/realtime/publisher", { namedExports: { publishTicketEvent: (type: string, ticketId: string, _actor: string, payload: any) => { events.push({ type, ticketId, payload }); } } });

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  const { PATCH: statusPATCH } = await import("@/app/api/tickets/[id]/status/route");
  const { PATCH: rtPATCH } = await import("@/app/api/tickets/[id]/resolution-time/route");
  const { default: TicketDetailPage } = await import("@/app/(main)/tickets/[id]/page");
  const { TicketDetailClient } = await import("@/components/tickets/ticket-detail-client");

  const req = (url: string, body: unknown) => new NextRequest(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const setStatus = (ticketId: string, body: Record<string, unknown>) => statusPATCH(req(`http://localhost/api/tickets/${ticketId}/status`, body), { params: Promise.resolve({ id: ticketId }) });
  const setRt = (ticketId: string, body: unknown) => rtPATCH(req(`http://localhost/api/tickets/${ticketId}/resolution-time`, body), { params: Promise.resolve({ id: ticketId }) });
  const as = (u: { id: string; role: Role; customRoleId?: string | null }) => { currentSession = { user: { id: u.id, role: u.role, customRoleId: u.customRoleId ?? null } }; };
  const loadTicket = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id }, include: { status: true } });
  const rtHistory = (id: string) => prisma.ticketHistory.findMany({ where: { ticketId: id, type: "RESOLUTION_TIME_CHANGE" }, orderBy: { createdAt: "asc" } });
  const pageProps = async (ticketId: string) => {
    const el = await TicketDetailPage({ params: Promise.resolve({ id: ticketId }) });
    return findElementsByType(el, TicketDetailClient)[0]?.props;
  };

  // ── A. Utility ──
  console.log("\n=== A. Shared duration utility (1 day = 480 minutes) ===\n");
  for (const [d, h, m, total] of [[1, 0, 0, 480], [0, 2, 30, 150], [1, 2, 30, 630], [2, 4, 15, 1215]]) {
    check(`A. ${d}d ${h}h ${m}m = ${total} minutes`, durationPartsToMinutes({ days: d, hours: h, minutes: m }) === total);
  }
  check("A. 10 hours (600) normalizes to 1d 2h", formatResolutionTime(600) === "1d 2h" && JSON.stringify(minutesToDurationParts(600)) === JSON.stringify({ days: 1, hours: 2, minutes: 0 }));
  check("A. format 630 -> 1d 2h 30m", formatResolutionTime(630) === "1d 2h 30m");
  check("A. format 135 -> 2h 15m", formatResolutionTime(135) === "2h 15m");
  check("A. format 45 -> 45m", formatResolutionTime(45) === "45m");
  check("A. format 0 -> 0m", formatResolutionTime(0) === "0m");
  check("A. format 480 -> 1d", formatResolutionTime(480) === "1d");
  check("A. format NULL -> Not recorded", formatResolutionTime(null) === "Not recorded");
  check("A. prefill NULL -> all fields empty", JSON.stringify(minutesToDurationInputs(null)) === JSON.stringify({ days: "", hours: "", minutes: "" }));
  check("A. prefill 630 -> 1 / 2 / 30", JSON.stringify(minutesToDurationInputs(630)) === JSON.stringify({ days: "1", hours: "2", minutes: "30" }));
  check("A. prefill 600 (entered as 10h) -> normalized 1 / 2 / 0", JSON.stringify(minutesToDurationInputs(600)) === JSON.stringify({ days: "1", hours: "2", minutes: "0" }));
  const p = (days: string, hours: string, minutes: string) => parseDurationInputs({ days, hours, minutes });
  check("A. all inputs empty -> NULL", JSON.stringify(p("", "", "")) === JSON.stringify({ ok: true, minutes: null }));
  check("A. whitespace-only inputs -> NULL", JSON.stringify(p(" ", "", "  ")) === JSON.stringify({ ok: true, minutes: null }));
  check("A. partial (hours only = 2) -> 120, empty fields count as 0", JSON.stringify(p("", "2", "")) === JSON.stringify({ ok: true, minutes: 120 }));
  check("A. explicit 0 -> 0 (distinct from NULL)", JSON.stringify(p("0", "", "")) === JSON.stringify({ ok: true, minutes: 0 }));
  check("A. 10 hours typed -> 600", JSON.stringify(p("", "10", "")) === JSON.stringify({ ok: true, minutes: 600 }));
  check("A. negative rejected", !p("-1", "", "").ok);
  check("A. decimal rejected", !p("", "1.5", "").ok);
  check("A. text rejected", !p("abc", "", "").ok);
  check("A. over the cap (1001 days) rejected", !p("1001", "", "").ok);
  check("A. exactly the cap (1000 days) accepted", JSON.stringify(p("1000", "", "")) === JSON.stringify({ ok: true, minutes: MAX_RESOLUTION_TIME_MINUTES }));
  check("A. huge number (overflow) rejected", !p("99999999999999999999", "", "").ok);

  // ── B. Schema ──
  console.log("\n=== B. API schema ===\n");
  const s = (v: unknown) => resolutionTimeMinutesSchema.safeParse(v).success;
  check("B. accepts null, 0, 630, cap", s(null) && s(0) && s(630) && s(MAX_RESOLUTION_TIME_MINUTES));
  check("B. rejects -1, 1.5, cap+1, \"5\", 2^31", !s(-1) && !s(1.5) && !s(MAX_RESOLUTION_TIME_MINUTES + 1) && !s("5") && !s(2 ** 31));

  if (!(await prisma.$connect().then(() => true).catch(() => false))) {
    console.log("No database — skipping DB sections.");
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const customRoleKeys: string[] = [];
  const ticketIds: string[] = [];
  try {
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);
    const st = async (deptId: string, name: string) => prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptId, name } });
    const [openA, resolvedA, openB] = await Promise.all([st(deptA.id, "Open"), st(deptA.id, "Resolved"), st(deptB.id, "Open")]);
    const closedA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: true } });
    const otherOpenA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: false, NOT: { name: { in: ["Open", "Resolved"] } } } });

    const mkUser = async (suffix: string, role: Role = Role.USER) => {
      const u = await prisma.user.create({ data: { email: `${TAG}-${suffix}@example.com`, name: `${TAG} ${suffix}`, role, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
      userIds.push(u.id);
      return u;
    };
    const member = (userId: string, departmentId: string, role: DepartmentRole, customRoleId?: string) =>
      prisma.departmentMembership.create({ data: { userId, departmentId, role, customRoleId: customRoleId ?? null, source: MembershipSource.MANUAL, isActive: true } });
    const mkCustomRole = async (suffix: string, keys: string[]) => {
      const r = await prisma.customRole.create({ data: { key: `${TAG}-${suffix}`, name: `${TAG} ${suffix}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
      customRoleKeys.push(r.key);
      for (const key of keys) {
        const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
        await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
      }
      return r;
    };

    const admin = await mkUser("admin", Role.ADMIN);
    const requester = await mkUser("requester");
    const agentA = await mkUser("agent-a"); // built-in AGENT_ASSIGNEE in A (changeStatus + resolutionTime.edit by default)
    await member(agentA.id, deptA.id, DepartmentRole.AGENT_ASSIGNEE);
    const requesterMember = await mkUser("requester-member"); // built-in REQUESTER in A
    await member(requesterMember.id, deptA.id, DepartmentRole.REQUESTER);
    const editOnlyRole = await mkCustomRole("edit-only", ["ticket.view", "ticket.view.all", "ticket.resolutionTime.edit"]);
    const editOnly = await mkUser("edit-only");
    await member(editOnly.id, deptA.id, DepartmentRole.VIEWER, editOnlyRole.id);
    const resolveOnlyRole = await mkCustomRole("resolve-only", ["ticket.view", "ticket.view.all", "ticket.changeStatus"]);
    const resolveOnly = await mkUser("resolve-only");
    await member(resolveOnly.id, deptA.id, DepartmentRole.VIEWER, resolveOnlyRole.id);
    await member(requester.id, deptA.id, DepartmentRole.REQUESTER);

    const mkTicket = async (deptId: string, statusId: string, title: string) => {
      const t = await prisma.ticket.create({ data: { title: `${TAG} ${title}`, description: "fixture", departmentId: deptId, statusId, requesterId: requester.id } });
      ticketIds.push(t.id);
      return t;
    };

    // ── C. Resolve workflow ──
    console.log("\n=== C. Resolve workflow (status route) ===\n");
    as(agentA);
    const t1 = await mkTicket(deptA.id, openA.id, "with duration");
    check("C. new ticket starts NULL", (await loadTicket(t1.id)).resolutionTimeMinutes === null);
    events.length = 0;
    let res: Response = await setStatus(t1.id, { statusId: resolvedA.id, resolutionTimeMinutes: 630 });
    let body = await res.json();
    let row = await loadTicket(t1.id);
    check("C1. resolve with 1d 2h 30m -> 200", res.status === 200, JSON.stringify(body));
    check("C1. status Resolved and 630 minutes persisted together", row.status.name === "Resolved" && row.resolutionTimeMinutes === 630);
    check("C1. response carries resolutionTimeMinutes", body.resolutionTimeMinutes === 630);
    let hist = await rtHistory(t1.id);
    check("C1. audit: NULL -> 630 by the resolving user", hist.length === 1 && hist[0].oldValue === null && hist[0].newValue === "630" && hist[0].changedById === agentA.id && hist[0].createdAt instanceof Date);
    check("C1. audit description is human-readable", hist[0]?.description === "Resolution time changed from Not recorded to 1d 2h 30m", hist[0]?.description ?? "");
    check("C1. status history entry still written", (await prisma.ticketHistory.count({ where: { ticketId: t1.id, type: "STATUS_CHANGE" } })) === 1);
    check("C1. realtime TICKET_STATUS_CHANGED carries the duration", events.some((e) => e.type === "TICKET_STATUS_CHANGED" && e.payload.resolutionTimeMinutes === 630));

    const t2 = await mkTicket(deptA.id, openA.id, "no duration");
    res = await setStatus(t2.id, { statusId: resolvedA.id });
    row = await loadTicket(t2.id);
    check("C2. resolve WITHOUT a duration (field omitted) -> 200, stays NULL", res.status === 200 && row.status.name === "Resolved" && row.resolutionTimeMinutes === null);
    check("C2. no resolution-time audit entry", (await rtHistory(t2.id)).length === 0);

    const t3 = await mkTicket(deptA.id, openA.id, "explicit null");
    res = await setStatus(t3.id, { statusId: resolvedA.id, resolutionTimeMinutes: null });
    row = await loadTicket(t3.id);
    check("C3. resolve with all fields empty (explicit null) -> 200, NULL, no audit noise", res.status === 200 && row.resolutionTimeMinutes === null && (await rtHistory(t3.id)).length === 0);

    const t4 = await mkTicket(deptA.id, openA.id, "partial");
    const partial = parseDurationInputs({ days: "", hours: "2", minutes: "" });
    res = await setStatus(t4.id, { statusId: resolvedA.id, resolutionTimeMinutes: partial.ok ? partial.minutes : -1 });
    check("C4. partial fields (2 hours) -> 120 persisted", res.status === 200 && (await loadTicket(t4.id)).resolutionTimeMinutes === 120);

    const t5 = await mkTicket(deptA.id, openA.id, "zero");
    res = await setStatus(t5.id, { statusId: resolvedA.id, resolutionTimeMinutes: 0 });
    row = await loadTicket(t5.id);
    check("C5. explicit zero -> 0 persisted (not NULL)", res.status === 200 && row.resolutionTimeMinutes === 0);
    check("C5. audit NULL -> \"0\"", (await rtHistory(t5.id))[0]?.newValue === "0");

    const t6 = await mkTicket(deptA.id, openA.id, "off-resolution");
    res = await setStatus(t6.id, { statusId: otherOpenA.id, resolutionTimeMinutes: 60 });
    row = await loadTicket(t6.id);
    check("C6. duration with a NON-resolution status -> 400 resolution_time_requires_resolution", res.status === 400 && (await res.json()).code === "resolution_time_requires_resolution");
    check("C6. ...and nothing changed (status, duration, history)", row.statusId === openA.id && row.resolutionTimeMinutes === null && (await prisma.ticketHistory.count({ where: { ticketId: t6.id } })) === 0);

    for (const bad of [-5, 1.5, MAX_RESOLUTION_TIME_MINUTES + 1, "60"]) {
      res = await setStatus(t6.id, { statusId: resolvedA.id, resolutionTimeMinutes: bad });
      row = await loadTicket(t6.id);
      check(`C7. invalid duration ${JSON.stringify(bad)} -> 422 and the ticket is NOT resolved`, res.status === 422 && row.statusId === openA.id && row.resolutionTimeMinutes === null);
    }

    // Atomicity: the DB CHECK is the last line of defence; a write that
    // fails inside the transaction must roll the status change back too.
    {
      const { setTicketResolutionTimeInTransaction } = await import("@/lib/services/ticket-resolution-time-service");
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.ticket.update({ where: { id: t6.id }, data: { statusId: resolvedA.id } });
          await setTicketResolutionTimeInTransaction(tx, { ticketId: t6.id, actorId: agentA.id, minutes: MAX_RESOLUTION_TIME_MINUTES + 1 });
        });
      } catch { threw = true; }
      row = await loadTicket(t6.id);
      check("C8. atomicity: a failing duration write (DB CHECK) rolls back the status change", threw && row.statusId === openA.id && row.resolutionTimeMinutes === null);
    }

    as(requester); // ticket owner: may change status (owner bypass) -> may submit the optional duration when resolving
    const t7 = await mkTicket(deptA.id, openA.id, "owner resolves");
    res = await setStatus(t7.id, { statusId: resolvedA.id, resolutionTimeMinutes: 45 });
    check("C9. a user authorized to resolve (requester-owner) can submit the duration with the resolution", res.status === 200 && (await loadTicket(t7.id)).resolutionTimeMinutes === 45);

    // ── D. Reopen / re-resolve ──
    console.log("\n=== D. Reopen and re-resolve ===\n");
    as(agentA);
    res = await setStatus(t1.id, { statusId: openA.id });
    row = await loadTicket(t1.id);
    check("D1. reopen keeps the recorded duration", res.status === 200 && row.statusId === openA.id && row.resolutionTimeMinutes === 630);
    check("D1. ...without a resolution-time audit entry", (await rtHistory(t1.id)).length === 1);
    let props = await pageProps(t1.id);
    check("D2. reopened ticket prefills the previous duration (page prop)", props?.initialResolutionTimeMinutes === 630);
    res = await setStatus(t1.id, { statusId: resolvedA.id, resolutionTimeMinutes: 630 });
    check("D3. re-resolve retaining the same value -> unchanged, no duplicate audit, no accumulation", res.status === 200 && (await loadTicket(t1.id)).resolutionTimeMinutes === 630 && (await rtHistory(t1.id)).length === 1);
    await setStatus(t1.id, { statusId: openA.id });
    res = await setStatus(t1.id, { statusId: resolvedA.id, resolutionTimeMinutes: 1215 });
    check("D4. re-resolve with a modified value -> replaced (1215), not added", res.status === 200 && (await loadTicket(t1.id)).resolutionTimeMinutes === 1215);
    await setStatus(t1.id, { statusId: openA.id });
    res = await setStatus(t1.id, { statusId: resolvedA.id, resolutionTimeMinutes: null });
    check("D5. re-resolve with all fields cleared -> NULL", res.status === 200 && (await loadTicket(t1.id)).resolutionTimeMinutes === null);
    hist = await rtHistory(t1.id);
    check("D5. audit trail NULL->630, 630->1215, 1215->NULL", JSON.stringify(hist.map((h) => [h.oldValue, h.newValue])) === JSON.stringify([[null, "630"], ["630", "1215"], ["1215", null]]));

    // ── E. Standalone edit ──
    console.log("\n=== E. Edit Resolution Time (standalone) ===\n");
    // Resolved ticket t2 (NULL): add.
    const before2 = await loadTicket(t2.id);
    events.length = 0;
    res = await setRt(t2.id, { resolutionTimeMinutes: 150 });
    body = await res.json();
    row = await loadTicket(t2.id);
    check("E1. add to an already-resolved ticket -> 200, 150 persisted", res.status === 200 && body.resolutionTimeMinutes === 150 && row.resolutionTimeMinutes === 150);
    check("E1. status, closedAt and createdAt unchanged", row.statusId === before2.statusId && String(row.closedAt) === String(before2.closedAt) && row.createdAt.getTime() === before2.createdAt.getTime());
    check("E1. no status history written by an edit", (await prisma.ticketHistory.count({ where: { ticketId: t2.id, NOT: { type: "RESOLUTION_TIME_CHANGE" } } })) === 1);
    check("E1. realtime TICKET_RESOLUTION_TIME_CHANGED published", events.some((e) => e.type === "TICKET_RESOLUTION_TIME_CHANGED" && e.payload.resolutionTimeMinutes === 150));

    res = await setRt(t2.id, { resolutionTimeMinutes: 1215 });
    check("E2. edit existing -> 1215", res.status === 200 && (await loadTicket(t2.id)).resolutionTimeMinutes === 1215);
    events.length = 0;
    res = await setRt(t2.id, { resolutionTimeMinutes: 1215 });
    body = await res.json();
    check("E3. saving the same value is a no-op (changed:false, no audit, no event)", body.changed === false && (await rtHistory(t2.id)).length === 2 && events.length === 0);
    res = await setRt(t2.id, {});
    check("E4. omitted field -> 422 and nothing cleared (no accidental data loss)", res.status === 422 && (await loadTicket(t2.id)).resolutionTimeMinutes === 1215);
    res = await setRt(t2.id, { resolutionTimeMinutes: -1 });
    check("E5. negative -> 422", res.status === 422 && (await loadTicket(t2.id)).resolutionTimeMinutes === 1215);
    res = await setRt(t2.id, { resolutionTimeMinutes: null });
    row = await loadTicket(t2.id);
    check("E6. explicit null clears back to NULL", res.status === 200 && row.resolutionTimeMinutes === null);
    hist = await rtHistory(t2.id);
    check("E6. audit trail NULL->150->1215->NULL with user + timestamp", JSON.stringify(hist.map((h) => [h.oldValue, h.newValue])) === JSON.stringify([[null, "150"], ["150", "1215"], ["1215", null]]) && hist.every((h) => h.changedById === agentA.id));

    // Closed ticket.
    as(agentA);
    const tc = await mkTicket(deptA.id, openA.id, "closed");
    await setStatus(tc.id, { statusId: closedA.id });
    const beforeC = await loadTicket(tc.id);
    res = await setRt(tc.id, { resolutionTimeMinutes: 480 });
    row = await loadTicket(tc.id);
    check("E7. add to a CLOSED ticket -> 200, closedAt and status untouched", res.status === 200 && row.resolutionTimeMinutes === 480 && row.statusId === closedA.id && row.closedAt?.getTime() === beforeC.closedAt?.getTime());

    // ── F. Permissions ──
    console.log("\n=== F. Permissions (dedicated key, department-scoped) ===\n");
    const perm = await prisma.permission.findUnique({ where: { key: "ticket.resolutionTime.edit" }, include: { roles: true } });
    check("F1. permission ticket.resolutionTime.edit exists (module tickets) for /admin/roles", perm?.module === "tickets");
    const grants = new Set(perm?.roles.map((r) => r.roleKey));
    check("F1. default grants: ADMIN, IT_AGENT, DEPARTMENT_ADMIN, AGENT_ASSIGNEE", ["ADMIN", "IT_AGENT", "DEPARTMENT_ADMIN", "AGENT_ASSIGNEE"].every((k) => grants.has(k)));
    check("F1. not granted by default to REQUESTER / VIEWER / USER / PROJECT_MANAGER", !["REQUESTER", "VIEWER", "USER", "PROJECT_MANAGER"].some((k) => grants.has(k)));

    as(requesterMember);
    const tR = await mkTicket(deptA.id, resolvedA.id, "perm checks");
    res = await setRt(tR.id, { resolutionTimeMinutes: 30 });
    check("F2. department REQUESTER (no grant) -> 403", res.status === 403);
    as(requester);
    res = await setRt(tR.id, { resolutionTimeMinutes: 30 });
    check("F3. the ticket's own requester cannot do a standalone edit (no owner bypass) -> 403", res.status === 403);
    props = await pageProps(tR.id);
    check("F3. ...and the UI flag canEditResolutionTime is false for them", props?.canEditResolutionTime === false);

    as(editOnly);
    res = await setRt(tR.id, { resolutionTimeMinutes: 30 });
    check("F4. custom department role with ONLY ticket.resolutionTime.edit -> standalone edit 200", res.status === 200 && (await loadTicket(tR.id)).resolutionTimeMinutes === 30);
    props = await pageProps(tR.id);
    check("F4. ...UI flag true", props?.canEditResolutionTime === true);
    const tR2 = await mkTicket(deptA.id, openA.id, "edit-only resolve");
    res = await setStatus(tR2.id, { statusId: resolvedA.id, resolutionTimeMinutes: 30 });
    check("F5. ...but that role cannot resolve (no ticket.changeStatus) -> 403, nothing written", res.status === 403 && (await loadTicket(tR2.id)).resolutionTimeMinutes === null);

    as(resolveOnly);
    res = await setStatus(tR2.id, { statusId: resolvedA.id, resolutionTimeMinutes: 90 });
    check("F6. role with ticket.changeStatus only CAN submit the duration while resolving", res.status === 200 && (await loadTicket(tR2.id)).resolutionTimeMinutes === 90);
    res = await setRt(tR2.id, { resolutionTimeMinutes: 100 });
    check("F7. ...but standalone edits need the dedicated permission -> 403, value unchanged", res.status === 403 && (await loadTicket(tR2.id)).resolutionTimeMinutes === 90);
    props = await pageProps(tR2.id);
    check("F7. ...UI flag false", props?.canEditResolutionTime === false);

    const tB = await mkTicket(deptB.id, openB.id, "dept B");
    as(agentA);
    res = await setRt(tB.id, { resolutionTimeMinutes: 30 });
    check("F8. Department A agent on a Department B ticket -> 403 (department-level)", res.status === 403 && (await loadTicket(tB.id)).resolutionTimeMinutes === null);
    props = await pageProps(t2.id);
    check("F9. Department A agent: UI flag true on a Department A ticket", props?.canEditResolutionTime === true);

    as(admin);
    res = await setRt(tB.id, { resolutionTimeMinutes: 15 });
    check("F10. System Admin -> 200 in any department", res.status === 200 && (await loadTicket(tB.id)).resolutionTimeMinutes === 15);
    currentSession = null;
    res = await setRt(tB.id, { resolutionTimeMinutes: 20 });
    check("F11. unauthenticated -> 401", res.status === 401 && (await loadTicket(tB.id)).resolutionTimeMinutes === 15);
    as(agentA);
    res = await setRt("does-not-exist", { resolutionTimeMinutes: 20 });
    check("F12. unknown ticket -> 404", res.status === 404);

    // ── G. Migration / historical / independence ──
    console.log("\n=== G. Migration, historical data, independence ===\n");
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261130090000_ticket_resolution_time/migration.sql"), "utf8");
    check("G1. migration adds a nullable column WITHOUT default and without backfill", /ADD COLUMN "resolutionTimeMinutes" INTEGER;/.test(sql) && !/DEFAULT/i.test(sql.split("ADD COLUMN")[1].split(";")[0]) && !/UPDATE "Ticket"/i.test(sql));
    const permStatements = sql.split(";").map((x) => x.trim()).filter((x) => /^INSERT INTO "(Permission|RolePermission)"/m.test(x.replace(/^--.*$/gm, "").trim()));
    const countBefore = await prisma.rolePermission.count({ where: { permission: { key: "ticket.resolutionTime.edit" } } });
    for (const st of permStatements) await prisma.$executeRawUnsafe(st.replace(/^--.*$/gm, ""));
    check("G2. catalogue/grant statements are idempotent (re-run adds nothing)", permStatements.length === 2 && (await prisma.permission.count({ where: { key: "ticket.resolutionTime.edit" } })) === 1 && (await prisma.rolePermission.count({ where: { permission: { key: "ticket.resolutionTime.edit" } } })) === countBefore);
    const nonFixtureRecorded = await prisma.ticket.count({ where: { resolutionTimeMinutes: { not: null }, id: { notIn: ticketIds } } });
    check("G3. historical (non-fixture) tickets remain NULL — no automatic backfill/calculation", nonFixtureRecorded === 0, `${nonFixtureRecorded} non-fixture tickets have a value`);
    let dbRejected = false;
    try { await prisma.ticket.update({ where: { id: tB.id }, data: { resolutionTimeMinutes: -1 } }); } catch { dbRejected = true; }
    check("G4. DB CHECK rejects a negative value even on a raw write", dbRejected);
    const grepFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? grepFiles(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const users = [...grepFiles("lib"), ...grepFiles("app"), ...grepFiles("components")].filter((f) => fs.readFileSync(f, "utf8").includes("resolutionTimeMinutes")).map((f) => path.relative(process.cwd(), f)).sort();
    const allowed = new Set([
      "lib/resolution-time.ts", "lib/validations.ts", "lib/services/ticket-resolution-time-service.ts",
      "app/api/tickets/[id]/status/route.ts", "app/api/tickets/[id]/resolution-time/route.ts", "app/(main)/tickets/[id]/page.tsx",
      "components/tickets/ticket-detail-client.tsx", "components/tickets/ticket-actions.tsx", "components/tickets/ticket-kanban-board.tsx", "components/tickets/ticket-kanban-card.tsx",
    ]);
    const unexpected = users.filter((f) => !allowed.has(f));
    check("G5. no SLA / project / activity / dashboard code reads the manual duration", unexpected.length === 0, unexpected.join(", "));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { key: { in: customRoleKeys } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
    ];
    for (const [label, step] of steps) {
      try { await step(); } catch (e) { console.warn(`cleanup ${label}:`, e instanceof Error ? e.message.split("\n")[0] : e); }
    }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
