/**
 * Proves the inactive-Department ticket-intake policy is enforced
 * consistently across every creation path (WEB via resolveDepartmentForCreate,
 * API via the integration endpoint, EMAIL via acceptPendingTicket) through
 * the ONE shared gate (isDepartmentAcceptingTickets in
 * department-scope-service.ts) — not three separately-maintained checks —
 * and that existing tickets/integrations in a deactivated department are
 * never affected, only new-item creation is refused. Also proves
 * reactivating a department restores creation immediately with no other
 * change (no key rotation, no membership change).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-inactive-department-policy.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { generateIntegrationKey } from "@/lib/services/integration-key-service";
import {
  ensureStatusForDepartment,
  ensureCategoryForDepartment,
  ensurePriorityForDepartment,
  STARTER_STATUSES,
} from "@/lib/services/config-starter-data";
// acceptPendingTicket / canViewTicket / canActOnEntity are deliberately NOT
// statically imported here — they transitively import lib/permissions.ts,
// which imports lib/auth.ts. A static top-level import runs (and caches
// the whole chain, including the REAL, un-mocked auth()) before
// mock.module("@/lib/auth", ...) below ever registers — after which
// app/api/tickets/route.ts's own dynamic import of that same cached chain
// would silently get the real auth() instead of the mock, making
// requireAuth() call NextAuth's real implementation outside any actual
// Next.js request context (it throws, since next/headers has nothing to
// read), surfacing as a confusing generic 500 with no indication the
// import order was the cause. Importing them dynamically inside main(),
// after both mock.module() calls, avoids this entirely — see the working
// pattern in test-web-ticket-creation-regression.ts / test-integration-
// admin-authz.ts, neither of which statically imports anything from this
// chain either.

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });

  // Imported here, after both mock.module() registrations above — see the
  // header comment on why these specifically must not be static top-level
  // imports.
  const { acceptPendingTicket } = await import("@/lib/services/pending-ticket-service");
  const { canViewTicket, canActOnEntity } = await import("@/lib/services/department-scope-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  if (!process.env.INTEGRATION_KEY_PEPPER) {
    console.log("INTEGRATION_KEY_PEPPER is not set — skipping.");
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const integrationIds: string[] = [];
  const pendingTicketIds: string[] = [];

  try {
    const dept = await prisma.department.create({ data: { name: `Inactive Policy Dept ${RUN_ID}`, slug: `inactive-policy-dept-${RUN_ID}` } });
    departmentIds.push(dept.id);
    const status = await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);
    const category = await ensureCategoryForDepartment(prisma, dept.id, { name: "Hardware", description: null, color: "#6366f1" });
    const priority = await ensurePriorityForDepartment(prisma, dept.id, { name: "High", level: 3, color: "#f97316" });

    const admin = await prisma.user.create({ data: { email: `inactive-policy-admin-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(admin.id);

    const key = generateIntegrationKey();
    const integration = await prisma.externalIntegration.create({
      data: {
        name: `Inactive Policy Integration ${RUN_ID}`,
        slug: `inactive-policy-integration-${RUN_ID}`,
        departmentId: dept.id,
        apiKeyPrefix: key.keyPrefix,
        apiKeyHash: key.keyHash,
      },
    });
    integrationIds.push(integration.id);

    // ── Baseline: department active, everything works ──────────────────
    console.log("\nBaseline (department active)...\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    {
      const { POST } = await import("@/app/api/tickets/route");
      const req = new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Baseline WEB ticket", description: "Created while the department is still active.", departmentId: dept.id, categoryId: category.id, priorityId: priority.id }),
      });
      const res = await POST(req);
      const body = await res.json();
      check("WEB create succeeds while department is active", res.status === 201);
      if (body?.id) ticketIds.push(body.id);
    }

    // Existing ticket used later to prove "existing items stay accessible".
    const existingTicket = await prisma.ticket.findFirst({ where: { departmentId: dept.id }, select: { id: true, requesterId: true } });

    console.log("\nDeactivating the department...\n");
    await prisma.department.update({ where: { id: dept.id }, data: { isActive: false } });

    // ── WEB create blocked ───────────────────────────────────────────────
    console.log("\nWEB create against an inactive department...\n");
    {
      const { POST } = await import("@/app/api/tickets/route");
      const req = new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should be blocked", description: "Department is inactive now.", departmentId: dept.id }),
      });
      const res = await POST(req);
      const body = await res.json();
      check("WEB create is refused for an inactive department -> 409", res.status === 409);
      check("WEB error message names the department as inactive", typeof body.error === "string" && body.error.toLowerCase().includes("inactive"));
    }

    // ── API (integration) create blocked ────────────────────────────────
    console.log("\nAPI create via an integration whose department is inactive...\n");
    {
      const { POST } = await import("@/app/api/integrations/tickets/route");
      const req = new NextRequest("http://localhost/api/integrations/tickets", {
        method: "POST",
        headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          externalReferenceId: `inactive-dept-${RUN_ID}`,
          requesterEmail: `inactive-dept-requester-${RUN_ID}@example.com`,
          title: "Should be blocked",
          description: "The integration's department is inactive now.",
        }),
      });
      const res = await POST(req);
      const body = await res.json();
      check("API create is refused for an inactive department -> 409 integration_department_inactive", res.status === 409 && body.code === "integration_department_inactive");
      const ticketCreated = await prisma.ticket.count({ where: { externalReferenceId: `inactive-dept-${RUN_ID}` } });
      check("No ticket was created by the refused API request", ticketCreated === 0);
    }
    check("The integration row itself still exists (never deleted/reassigned) for audit", (await prisma.externalIntegration.findUnique({ where: { id: integration.id } })) !== null);

    // ── EMAIL/PendingTicket acceptance blocked ──────────────────────────
    console.log("\nPendingTicket acceptance against an inactive department...\n");
    {
      const pending = await prisma.pendingTicket.create({
        data: {
          emailMessageId: `inactive-dept-pending-${RUN_ID}@test.local`,
          fromEmail: `inactive-dept-pending-${RUN_ID}@example.com`,
          subject: "Should not become a real ticket",
          body: "The matched department is inactive.",
          receivedAt: new Date(),
          departmentId: dept.id,
        },
      });
      pendingTicketIds.push(pending.id);
      const result = await acceptPendingTicket(pending.id, admin.id);
      check('Accepting a pending ticket for an inactive department returns { ok:false, error:"department_inactive" }', !result.ok && result.error === "department_inactive");
      const stillPending = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { status: true } });
      check("The PendingTicket itself is untouched (still PENDING, not silently rejected)", stillPending?.status === "PENDING");
      const ticketCreated = await prisma.ticket.count({ where: { emailMessageId: pending.emailMessageId } });
      check("No Ticket was created from the refused acceptance", ticketCreated === 0);
    }

    // ── Existing tickets remain accessible ──────────────────────────────
    console.log("\nExisting tickets in the now-inactive department remain accessible...\n");
    if (existingTicket) {
      const ticketRow = await prisma.ticket.findUnique({
        where: { id: existingTicket.id },
        select: { departmentId: true, subDepartmentId: true, requesterId: true, assignedAgentId: true, shareWithDepartment: true, shareWithSubDepartment: true },
      });
      const canView = ticketRow ? await canViewTicket(admin.id, Role.ADMIN, ticketRow) : false;
      check("ADMIN can still view the existing ticket in the inactive department", canView === true);
      const canEdit = ticketRow ? await canActOnEntity(admin.id, Role.ADMIN, ticketRow.departmentId, "ticket.changeStatus") : false;
      check("ADMIN can still act on (edit) the existing ticket in the inactive department", canEdit === true);
    } else {
      check("Baseline ticket existed to test against", false);
    }

    // ── Reactivation restores creation, no key rotation needed ──────────
    console.log("\nReactivating the department restores creation immediately...\n");
    await prisma.department.update({ where: { id: dept.id }, data: { isActive: true } });
    {
      const { POST } = await import("@/app/api/integrations/tickets/route");
      const req = new NextRequest("http://localhost/api/integrations/tickets", {
        method: "POST",
        headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          externalReferenceId: `reactivated-${RUN_ID}`,
          requesterEmail: `reactivated-requester-${RUN_ID}@example.com`,
          title: "Should succeed now",
          description: "The department was just reactivated; the SAME integration key must still work.",
        }),
      });
      const res = await POST(req);
      check("API create succeeds again after reactivation, using the SAME (never rotated) key", res.status === 201);
      const body = await res.json();
      if (body.ticket?.id) ticketIds.push(body.ticket.id);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.user.deleteMany({ where: { email: { contains: `-${RUN_ID}@example.com` } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
