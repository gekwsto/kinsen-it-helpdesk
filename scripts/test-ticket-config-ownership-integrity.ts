/**
 * Regression coverage for the real Finance/Open bug reported against the
 * live dev database (KIN-10 visibly "Open" but invisible to Finance+Open).
 *
 * Root cause: prisma/seed.ts reused dept-it-scoped TicketStatus/TicketPriority/
 * TicketCategory rows for tickets seeded into OTHER departments, producing
 * tickets whose statusId/priorityId/categoryId pointed at a DIFFERENT
 * department than their own departmentId — invisible to any canonical-ID
 * filter scoped to their real department, despite rendering a real-looking
 * status/priority/category name. See scripts/repair-ticket-config-department-
 * mismatch.ts (the one-time repair for the 9 tickets this affected) and
 * validateTicketConfigOwnership in lib/services/department-scope-service.ts
 * (the write-path guard preventing new occurrences).
 *
 * This script proves, against isolated fixtures (never real/shared data):
 *  1. validateTicketConfigOwnership itself — valid/invalid per field,
 *     null/undefined fields are skipped (partial updates).
 *  2. The 3 write paths that accept a client-submitted status/priority/
 *     category id (POST /api/tickets, PATCH /api/tickets/[id], PATCH
 *     /api/tickets/[id]/status) all reject a cross-department id with 400 +
 *     a specific `${field}_department_mismatch` code, and accept a same-
 *     department id.
 *  3. Department transfer (PATCH /api/tickets/[id]/department) remaps a
 *     ticket's status/priority/category to the TARGET department's own
 *     equivalent rows (matched by name) — never leaves a foreign-department
 *     config row attached, and status.departmentId/priority.departmentId/
 *     category.departmentId all equal the new departmentId afterwards.
 *  4. A legacy-mismatch fixture (isolated, not real data) simulating the
 *     exact historical corruption — ticket.departmentId = B but statusId
 *     still pointing at A's "Open" row — proves: (A) the repair script's
 *     detectTicketConfigMismatches() flags it, (B) resolveTicketConfigMismatches()
 *     resolves it to B's own "Open" row (same-name match), (C) after
 *     applying that resolution, the REAL ticket-list query path (the same
 *     app/(main)/tickets/page.tsx Server Component used in production)
 *     filtering B+Open returns the ticket.
 *  5. A live integrity audit against the real database (if reachable):
 *     zero non-legacy tickets have a status/priority/category row whose
 *     departmentId differs from the ticket's own departmentId — i.e. the
 *     9-ticket corruption found during the original investigation has been
 *     fully repaired and no new instances exist.
 *
 * Must run with --experimental-test-module-mocks (auth is mocked, same
 * convention as test-integration-admin-authz.ts / test-ticket-status-filter-
 * determinism.ts).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-config-ownership-integrity.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
// Deliberately NOT a static top-level import — repair-ticket-config-
// department-mismatch.ts transitively imports department-scope-service.ts
// -> lib/permissions.ts -> lib/auth.ts. A static import here would evaluate
// that whole chain (caching the REAL auth()) before mock.module("@/lib/auth",
// ...) below ever registers, making every dynamically-imported route
// handler's requireAuth() silently use the real, unmocked auth chain too
// (same already-cached module instance) — see the identical, previously-
// diagnosed gotcha documented in test-inactive-department-policy.ts's header
// comment. Imported dynamically inside main() instead, after both
// mock.module() calls.

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

const RUN_ID = Date.now();
const TAG = `tcoi-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;
let currentCookieIsAllWorkspaces = false;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => {
        if (name !== "active_department_id") return undefined;
        if (currentCookieIsAllWorkspaces) return { value: "ALL" };
        return currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined;
      },
    }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });

  // Dynamic imports after both mocks are registered — see the established
  // rationale in test-inactive-department-policy.ts's header comment.
  const { validateTicketConfigOwnership } = await import("@/lib/services/department-scope-service");
  const { POST: createTicketPOST } = await import("@/app/api/tickets/route");
  const { PATCH: genericPATCH } = await import("@/app/api/tickets/[id]/route");
  const { PATCH: statusPATCH } = await import("@/app/api/tickets/[id]/status/route");
  const { PATCH: departmentPATCH } = await import("@/app/api/tickets/[id]/department/route");
  const { detectTicketConfigMismatches, resolveTicketConfigMismatches } = await import("./repair-ticket-config-department-mismatch");
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const callList = async (params: Record<string, string>) => {
    const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
    const [tableEl] = findElementsByType(element, TicketTable);
    const tickets = (tableEl?.props.tickets as any[]) ?? [];
    // TicketTable now receives a single `pagination: PaginationMeta` prop
    // instead of a separate `total` — see components/tickets/ticket-table.tsx.
    return { total: tableEl?.props.pagination?.totalCount as number, ids: tickets.map((t) => t.id) };
  };

  const jsonReq = (url: string, body: unknown, method = "PATCH") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, each with their own full starter-shaped config ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: [deptA.id, deptB.id] } } });
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: [deptA.id, deptB.id] } } });
    await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: [deptA.id, deptB.id] } } });

    const aOpen = await prisma.ticketStatus.create({ data: { name: "Open", color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: deptA.id } });
    const aInProgress = await prisma.ticketStatus.create({ data: { name: "In Progress", color: "#f59e0b", isClosed: false, order: 2, departmentId: deptA.id } });
    const aHigh = await prisma.ticketPriority.create({ data: { name: "High", level: 3, color: "#dc2626", departmentId: deptA.id } });
    const aCategory = await prisma.ticketCategory.create({ data: { name: "Category A", color: "#6366f1", departmentId: deptA.id } });

    const bOpen = await prisma.ticketStatus.create({ data: { name: "Open", color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: deptB.id } });
    const bInProgress = await prisma.ticketStatus.create({ data: { name: "In Progress", color: "#f59e0b", isClosed: false, order: 2, departmentId: deptB.id } });
    const bHigh = await prisma.ticketPriority.create({ data: { name: "High", level: 3, color: "#dc2626", departmentId: deptB.id } });
    const bCategory = await prisma.ticketCategory.create({ data: { name: "Category A", color: "#6366f1", departmentId: deptB.id } }); // same NAME as deptA's, different id — proves name-based remap, not accidental id reuse

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1. validateTicketConfigOwnership unit tests ──
    console.log("\n1. validateTicketConfigOwnership — direct unit tests ===\n");
    check("Same-department statusId -> ok", (await validateTicketConfigOwnership(deptA.id, { statusId: aOpen.id })).ok === true);
    const badStatus = await validateTicketConfigOwnership(deptA.id, { statusId: bOpen.id });
    check("Cross-department statusId -> rejected with field='status'", badStatus.ok === false && (badStatus as any).field === "status");
    const badPriority = await validateTicketConfigOwnership(deptA.id, { priorityId: bHigh.id });
    check("Cross-department priorityId -> rejected with field='priority'", badPriority.ok === false && (badPriority as any).field === "priority");
    const badCategory = await validateTicketConfigOwnership(deptA.id, { categoryId: bCategory.id });
    check("Cross-department categoryId -> rejected with field='category'", badCategory.ok === false && (badCategory as any).field === "category");
    check("Undefined fields are skipped (no false rejection)", (await validateTicketConfigOwnership(deptA.id, {})).ok === true);
    check("null fields are skipped (clearing a value never triggers rejection)", (await validateTicketConfigOwnership(deptA.id, { categoryId: null, priorityId: null })).ok === true);
    check("A nonexistent id is rejected, not silently passed", (await validateTicketConfigOwnership(deptA.id, { statusId: "does-not-exist" })).ok === false);

    // ── 2a. POST /api/tickets rejects cross-department categoryId/priorityId ──
    console.log("\n2a. POST /api/tickets rejects a cross-department categoryId/priorityId ===\n");
    const badCreate = await createTicketPOST(
      jsonReq("http://localhost/api/tickets", { title: `${TAG} bad create`, description: "fixture description", departmentId: deptA.id, categoryId: bCategory.id }, "POST")
    );
    check("POST with Department A + Department B's categoryId -> 400", badCreate.status === 400, `got ${badCreate.status}: ${JSON.stringify(await badCreate.clone().json().catch(() => null))}`);
    const badCreateBody = await badCreate.json();
    check("...with code category_department_mismatch", badCreateBody.code === "category_department_mismatch");

    const goodCreate = await createTicketPOST(
      jsonReq("http://localhost/api/tickets", { title: `${TAG} good create`, description: "fixture description", departmentId: deptA.id, categoryId: aCategory.id, priorityId: aHigh.id }, "POST")
    );
    check("POST with Department A + Department A's own categoryId/priorityId -> 201", goodCreate.status === 201);
    const createdTicket = await goodCreate.json();
    if (createdTicket?.id) ticketIds.push(createdTicket.id);
    check("...created ticket keeps the submitted categoryId", createdTicket.categoryId === aCategory.id);

    // ── 2b. Generic PATCH /api/tickets/[id] rejects cross-department statusId/priorityId/categoryId ──
    console.log("\n2b. PATCH /api/tickets/[id] rejects cross-department statusId/priorityId/categoryId ===\n");
    const patchTicket = await prisma.ticket.create({
      data: { title: `${TAG} patch target`, description: "x", departmentId: deptA.id, statusId: aOpen.id, requesterId: admin.id },
    });
    ticketIds.push(patchTicket.id);

    const badPatchStatus = await genericPATCH(jsonReq("http://localhost/api/tickets/x", { statusId: bOpen.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("PATCH statusId=DeptB's Open on a DeptA ticket -> 400 status_department_mismatch", badPatchStatus.status === 400 && (await badPatchStatus.json()).code === "status_department_mismatch");

    const badPatchPriority = await genericPATCH(jsonReq("http://localhost/api/tickets/x", { priorityId: bHigh.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("PATCH priorityId=DeptB's High on a DeptA ticket -> 400 priority_department_mismatch", badPatchPriority.status === 400 && (await badPatchPriority.json()).code === "priority_department_mismatch");

    const badPatchCategory = await genericPATCH(jsonReq("http://localhost/api/tickets/x", { categoryId: bCategory.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("PATCH categoryId=DeptB's category on a DeptA ticket -> 400 category_department_mismatch", badPatchCategory.status === 400 && (await badPatchCategory.json()).code === "category_department_mismatch");

    const goodPatch = await genericPATCH(jsonReq("http://localhost/api/tickets/x", { statusId: aInProgress.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("PATCH statusId=DeptA's own In Progress on a DeptA ticket -> 200", goodPatch.status === 200);

    // ── 2c. Dedicated status PATCH /api/tickets/[id]/status rejects cross-department statusId ──
    console.log("\n2c. PATCH /api/tickets/[id]/status rejects a cross-department statusId ===\n");
    const badStatusPatch = await statusPATCH(jsonReq("http://localhost/api/tickets/x/status", { statusId: bInProgress.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("Dedicated status PATCH with DeptB's In Progress on a DeptA ticket -> 400 status_department_mismatch", badStatusPatch.status === 400 && (await badStatusPatch.json()).code === "status_department_mismatch");

    const goodStatusPatch = await statusPATCH(jsonReq("http://localhost/api/tickets/x/status", { statusId: aOpen.id }), { params: Promise.resolve({ id: patchTicket.id }) });
    check("Dedicated status PATCH with DeptA's own Open on a DeptA ticket -> 200", goodStatusPatch.status === 200);

    // ── 3. Department transfer remaps config to the TARGET department's own rows ──
    console.log("\n3. PATCH /api/tickets/[id]/department (A -> B) remaps status/priority/category to B's own rows ===\n");
    const transferTicket = await prisma.ticket.create({
      data: { title: `${TAG} transfer target`, description: "x", departmentId: deptA.id, statusId: aOpen.id, priorityId: aHigh.id, categoryId: aCategory.id, requesterId: admin.id },
    });
    ticketIds.push(transferTicket.id);

    const transferRes = await departmentPATCH(jsonReq("http://localhost/api/tickets/x/department", { departmentId: deptB.id }), { params: Promise.resolve({ id: transferTicket.id }) });
    check("Transfer A -> B succeeds (200)", transferRes.status === 200);
    const transferred = await prisma.ticket.findUnique({
      where: { id: transferTicket.id },
      select: {
        departmentId: true,
        statusId: true,
        priorityId: true,
        categoryId: true,
        status: { select: { departmentId: true, name: true } },
        priority: { select: { departmentId: true, name: true } },
        category: { select: { departmentId: true, name: true } },
      },
    });
    check("...departmentId = B", transferred?.departmentId === deptB.id);
    check("...statusId remapped to B's own 'Open' row (same name, different id)", transferred?.statusId === bOpen.id);
    check("...priorityId remapped to B's own 'High' row", transferred?.priorityId === bHigh.id);
    check("...categoryId remapped to B's own 'Category A' row (same NAME as A's, different id)", transferred?.categoryId === bCategory.id);
    check("...status.departmentId === B (explicit invariant check)", transferred?.status?.departmentId === deptB.id);
    check("...priority.departmentId === B (explicit invariant check)", transferred?.priority?.departmentId === deptB.id);
    check("...category.departmentId === B (explicit invariant check)", transferred?.category?.departmentId === deptB.id);
    check("...no foreign (Department A) config row was preserved anywhere", transferred?.statusId !== aOpen.id && transferred?.priorityId !== aHigh.id && transferred?.categoryId !== aCategory.id);

    console.log("\n3b. B + Open filter returns the just-transferred ticket ===\n");
    currentCookieDepartmentId = deptB.id;
    currentCookieIsAllWorkspaces = false;
    const bOpenFilterResult = await callList({ statusId: bOpen.id });
    check("Department B + Open includes the transferred ticket", bOpenFilterResult.ids.includes(transferTicket.id));

    // ── 4. Legacy-mismatch fixture: isolated, simulates the exact historical corruption ──
    console.log("\n4. Legacy-mismatch fixture — ticket.departmentId=B but statusId still points at A's Open (simulated historical corruption) ===\n");
    // Bypass the write-path guard deliberately (raw prisma.update, not the
    // API route) — this fixture exists specifically to represent data that
    // predates validateTicketConfigOwnership, the exact shape the repair
    // script targets. Never done against real/shared tickets.
    const corruptTicket = await prisma.ticket.create({
      data: { title: `${TAG} corrupt fixture`, description: "x", departmentId: deptB.id, statusId: aOpen.id, priorityId: aHigh.id, categoryId: aCategory.id, requesterId: admin.id },
    });
    ticketIds.push(corruptTicket.id);

    const corruptView = {
      departmentId: deptB.id,
      status: { id: aOpen.id, name: "Open", departmentId: deptA.id },
      priority: { id: aHigh.id, name: "High", departmentId: deptA.id },
      category: { id: aCategory.id, name: "Category A", departmentId: deptA.id },
    };
    const detected = detectTicketConfigMismatches(corruptView);
    check("(A) detectTicketConfigMismatches flags all 3 fields as mismatched", detected.length === 3 && detected.every((m) => ["statusId", "priorityId", "categoryId"].includes(m.field)));

    const resolved = await resolveTicketConfigMismatches(corruptView);
    const statusRes = resolved.find((m) => m.field === "statusId");
    const priorityRes = resolved.find((m) => m.field === "priorityId");
    const categoryRes = resolved.find((m) => m.field === "categoryId");
    check("(B) statusId resolves to B's own 'Open' row", statusRes?.resolution.ok === true && (statusRes.resolution as any).newId === bOpen.id);
    check("(B) priorityId resolves to B's own 'High' row", priorityRes?.resolution.ok === true && (priorityRes.resolution as any).newId === bHigh.id);
    check("(B) categoryId resolves to B's own 'Category A' row", categoryRes?.resolution.ok === true && (categoryRes.resolution as any).newId === bCategory.id);

    // Apply the resolution exactly like the real repair script's --apply path would.
    await prisma.ticket.update({
      where: { id: corruptTicket.id },
      data: {
        statusId: (statusRes!.resolution as any).newId,
        priorityId: (priorityRes!.resolution as any).newId,
        categoryId: (categoryRes!.resolution as any).newId,
      },
    });

    console.log("\n(C) After repair, Department B + Open filter returns the previously-invisible ticket ===\n");
    const postRepairResult = await callList({ statusId: bOpen.id });
    check("(C) Department B + Open now includes the repaired ticket", postRepairResult.ids.includes(corruptTicket.id));

    const postRepairCheck = await prisma.ticket.findUnique({
      where: { id: corruptTicket.id },
      select: { departmentId: true, status: { select: { departmentId: true } }, priority: { select: { departmentId: true } }, category: { select: { departmentId: true } } },
    });
    check("Post-repair invariant holds: ticket.departmentId === status.departmentId", postRepairCheck?.departmentId === postRepairCheck?.status?.departmentId);
    check("Post-repair invariant holds: ticket.departmentId === priority.departmentId", postRepairCheck?.departmentId === postRepairCheck?.priority?.departmentId);
    check("Post-repair invariant holds: ticket.departmentId === category.departmentId", postRepairCheck?.departmentId === postRepairCheck?.category?.departmentId);
    check("Re-running detection against the repaired ticket finds zero mismatches (idempotent)", detectTicketConfigMismatches({
      departmentId: postRepairCheck!.departmentId!,
      status: { id: "x", name: "Open", departmentId: postRepairCheck!.status!.departmentId },
      priority: { id: "x", name: "High", departmentId: postRepairCheck!.priority!.departmentId },
      category: { id: "x", name: "Category A", departmentId: postRepairCheck!.category!.departmentId },
    }).length === 0);

    // ── 5. Live DB integrity audit — zero real (non-legacy) mismatches remain ──
    console.log("\n5. Live integrity audit against the real database (excluding this script's own isolated fixtures) ===\n");
    const realTickets = await prisma.ticket.findMany({
      where: { departmentId: { not: null }, id: { notIn: ticketIds } },
      select: {
        ticketNumber: true,
        departmentId: true,
        status: { select: { id: true, name: true, departmentId: true } },
        priority: { select: { id: true, name: true, departmentId: true } },
        category: { select: { id: true, name: true, departmentId: true } },
      },
    });
    const realMismatches = realTickets.flatMap((t) =>
      detectTicketConfigMismatches({ departmentId: t.departmentId!, status: t.status, priority: t.priority, category: t.category }).map((m) => ({ ticketNumber: t.ticketNumber, ...m }))
    );
    if (realMismatches.length > 0) {
      console.error("  Mismatches found in the real database:");
      for (const m of realMismatches) console.error(`    KIN-${m.ticketNumber}: ${m.field} -> row dept ${m.row.departmentId}`);
    }
    check(`Zero non-legacy config-ownership mismatches remain in the real database (scanned ${realTickets.length} tickets)`, realMismatches.length === 0);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
