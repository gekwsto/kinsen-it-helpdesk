/**
 * End-to-end proof that the New Ticket page's Department selector cannot be
 * bypassed by a manually crafted request — POST /api/tickets's
 * resolveTicketDestinationDepartment is the sole, fail-closed authority over
 * which department a ticket actually lands in, regardless of what the
 * client sends. Exercises the REAL route handler, then proves the resulting
 * ticket is visible to an eligible agent of the destination department and
 * invisible to an unrelated department's agent — through the EXISTING
 * buildTicketListWhere/GET /api/tickets visibility path, never a second
 * system.
 *
 * REVISED per the corrected business requirement (see
 * scripts/test-ticket-destination-department-selector.ts for the full
 * root-cause reproduction/fix): a ticket's destination department is who
 * it's being SENT TO, not a department the requester must already hold
 * DepartmentMembership in — §2 below used to assert the OPPOSITE (a
 * cross-department departmentId was rejected purely for lack of
 * membership), which was exactly the incorrect coupling this app's product
 * requirement identified and corrected. §2 now proves the requester CAN
 * address a department they don't belong to, as long as they can create
 * tickets at all; §3/§4 (cross-department config-ownership rejection,
 * resulting agent visibility) are unaffected and still hold.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-department-selector-authorization.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole, MembershipSource, AuthProvider } from "@prisma/client";
import { ensureStatusForDepartment, ensureCategoryForDepartment, STARTER_STATUSES } from "@/lib/services/config-starter-data";

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
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(0);
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];

  try {
    const deptA = await prisma.department.create({ data: { name: `Dept Selector Auth A ${RUN_ID}`, slug: `dept-selector-auth-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `Dept Selector Auth B ${RUN_ID}`, slug: `dept-selector-auth-b-${RUN_ID}` } });
    departmentIds.push(deptA.id, deptB.id);
    await ensureStatusForDepartment(prisma, deptA.id, STARTER_STATUSES[0]);
    await ensureStatusForDepartment(prisma, deptB.id, STARTER_STATUSES[0]);
    const categoryA = await ensureCategoryForDepartment(prisma, deptA.id, { name: "Hardware", description: null, color: "#6366f1" });
    const categoryB = await ensureCategoryForDepartment(prisma, deptB.id, { name: "Hardware", description: null, color: "#6366f1" });

    // requesterA: a plain member of Dept A ONLY (REQUESTER role — has
    // ticket.create by default), no membership/permission in Dept B at all.
    const requesterA = await prisma.user.create({ data: { email: `dept-selector-requester-a-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requesterA.id);
    const membershipA = await prisma.departmentMembership.create({
      data: { userId: requesterA.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(membershipA.id);

    // agentB: eligible full-view agent of Dept B ONLY.
    const agentB = await prisma.user.create({ data: { email: `dept-selector-agent-b-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(agentB.id);
    const membershipB = await prisma.departmentMembership.create({
      data: { userId: agentB.id, departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(membershipB.id);

    const { POST } = await import("@/app/api/tickets/route");
    const { GET } = await import("@/app/api/tickets/route");

    // ══════════════ 1. Legitimate: requesterA submits Dept A (their own, permitted) ══════════════
    console.log("\n=== 1. Legitimate department selection ===\n");
    currentSession = { user: { id: requesterA.id, role: Role.USER, customRoleId: null } };
    const legitRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Legit ticket for my own department",
          description: "Should succeed — the user is a real member of this department with ticket.create.",
          departmentId: deptA.id,
          categoryId: categoryA.id,
        }),
      })
    );
    check("POST with the user's OWN permitted department -> 201", legitRes.status === 201);
    const legitBody = await legitRes.json();
    if (legitBody?.id) ticketIds.push(legitBody.id);
    check("Ticket persisted with departmentId = Dept A (the ACTUAL Ticket.departmentId column, not a parallel field)", legitBody.departmentId === deptA.id);

    // ══════════════ 2. requesterA addresses a ticket to Dept B — a real destination they have NO membership in ══════════════
    console.log("\n=== 2. Destination department the requester has NO membership in is a VALID choice (corrected behavior) ===\n");
    const crossDeptRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ticket addressed to a department I'm not a member of",
          description: "requesterA has zero DepartmentMembership in Dept B — must still succeed; the destination is who the ticket is SENT TO, not somewhere the requester operates.",
          departmentId: deptB.id,
          categoryId: categoryB.id,
        }),
      })
    );
    check("POST addressed to a department the requester has NO membership in -> 201 (not 403)", crossDeptRes.status === 201);
    const crossDeptBody = await crossDeptRes.json();
    if (crossDeptBody?.id) ticketIds.push(crossDeptBody.id);
    check("Ticket.departmentId is the DESTINATION (Dept B), never silently redirected to the requester's own department", crossDeptBody.departmentId === deptB.id);
    check("Dept B's own category was accepted", crossDeptBody.categoryId === categoryB.id);
    const requesterAMembershipInB = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: requesterA.id, departmentId: deptB.id } } });
    check("requesterA still has NO DepartmentMembership in Dept B afterward — addressing a ticket never grants membership", requesterAMembershipInB === null);

    // ══════════════ 3. Manually crafted bypass attempt: cross-department categoryId paired with the user's OWN legitimate department ══════════════
    console.log("\n=== 3. Manually crafted request: legitimate department, but a categoryId belonging to a DIFFERENT department ===\n");
    const ticketCountBefore2 = await prisma.ticket.count();
    const crossConfigRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Own department, foreign category",
          description: "departmentId is legitimately theirs, but categoryId belongs to Dept B.",
          departmentId: deptA.id,
          categoryId: categoryB.id,
        }),
      })
    );
    check("Own department + Dept B's categoryId -> rejected 400 category_department_mismatch", crossConfigRes.status === 400);
    const crossConfigBody = await crossConfigRes.json();
    check("...specific mismatch code returned", crossConfigBody.code === "category_department_mismatch");
    check("No ticket was created by the rejected request", (await prisma.ticket.count()) === ticketCountBefore2);

    // ══════════════ 4. The legitimately-created ticket is visible to an eligible Dept B... wait, Dept A agent, and NOT to an unrelated Dept B agent ══════════════
    console.log("\n=== 4. Resulting visibility follows the EXISTING DepartmentMembership/buildTicketListWhere architecture ===\n");
    // Give requesterA's own ticket a Dept-A full-view agent to check against too.
    const agentA = await prisma.user.create({ data: { email: `dept-selector-agent-a-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(agentA.id);
    const membershipAgentA = await prisma.departmentMembership.create({
      data: { userId: agentA.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(membershipAgentA.id);

    currentSession = { user: { id: agentA.id, role: Role.USER, customRoleId: null } };
    const agentAListRes = await GET(new NextRequest(`http://localhost/api/tickets?departmentId=${deptA.id}`));
    check("GET /api/tickets -> 200 for the eligible Dept A agent", agentAListRes.status === 200);
    const agentAList = await agentAListRes.json();
    check("Eligible Dept A agent sees the ticket created for Dept A", agentAList.tickets?.some((t: any) => t.id === legitBody.id));

    currentSession = { user: { id: agentB.id, role: Role.USER, customRoleId: null } };
    const agentBListRes = await GET(new NextRequest(`http://localhost/api/tickets?departmentId=${deptA.id}`));
    check("GET /api/tickets?departmentId=DeptA -> 403 for an agent with no membership in Dept A (buildTicketListWhere denies, not a silent empty list)", agentBListRes.status === 403);

    // Confirm agentB's own unrestricted (no departmentId filter) list never surfaces the Dept-A ticket either.
    const agentBOwnListRes = await GET(new NextRequest("http://localhost/api/tickets"));
    const agentBOwnList = await agentBOwnListRes.json();
    check(
      "Dept B agent's own ticket list (no filter) never includes the unrelated Dept A ticket — no cross-department leak",
      !agentBOwnList.tickets?.some((t: any) => t.id === legitBody.id)
    );

    // And the §2 ticket (requesterA -> Dept B, cross-department address) IS
    // visible to Dept B's own eligible agent — agent visibility follows the
    // DESTINATION department's membership, never the requester's.
    const agentBCrossDeptListRes = await GET(new NextRequest(`http://localhost/api/tickets?departmentId=${deptB.id}`));
    const agentBCrossDeptList = await agentBCrossDeptListRes.json();
    check("Dept B agent DOES see the ticket requesterA addressed to Dept B, despite requesterA having no membership there", agentBCrossDeptList.tickets?.some((t: any) => t.id === crossDeptBody.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
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

main();
