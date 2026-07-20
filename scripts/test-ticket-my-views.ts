/**
 * "My Tickets" was split into /tickets/assigned-to-me (assignedAgentId) and
 * /tickets/created-by-me (requesterId) — it used to conflate the two,
 * checking only requesterId. This tests both the pure where-builders and a
 * real DB round-trip: a ticket assigned-but-not-created, one
 * created-but-not-assigned, and one that's both, confirming each page's
 * query returns exactly the right set (and the "both" ticket shows up in
 * both).
 *
 * Usage: npx tsx scripts/test-ticket-my-views.ts
 * Requires a reachable DATABASE_URL for the DB-backed section — prints a
 * clear message and exits if one isn't configured/reachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { buildAssignedToMeWhere, buildCreatedByMeWhere } from "@/lib/services/department-scope-service";

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

async function main() {
  console.log("Testing buildAssignedToMeWhere / buildCreatedByMeWhere (pure)...\n");
  check(
    "buildAssignedToMeWhere with no department",
    JSON.stringify(buildAssignedToMeWhere("user-1")) === JSON.stringify({ assignedAgentId: "user-1" })
  );
  check(
    "buildAssignedToMeWhere with a department",
    JSON.stringify(buildAssignedToMeWhere("user-1", "dept-1")) ===
      JSON.stringify({ assignedAgentId: "user-1", departmentId: "dept-1" })
  );
  check(
    "buildCreatedByMeWhere with no department",
    JSON.stringify(buildCreatedByMeWhere("user-1")) === JSON.stringify({ requesterId: "user-1" })
  );
  check(
    "buildCreatedByMeWhere with a department",
    JSON.stringify(buildCreatedByMeWhere("user-1", "dept-1")) ===
      JSON.stringify({ requesterId: "user-1", departmentId: "dept-1" })
  );

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("\nNo reachable DATABASE_URL in this environment — skipping DB-backed round-trip.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    return;
  }

  console.log("\nSetting up fixtures for the DB round-trip...\n");
  let userA: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let userB: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];

  try {
    userA = await prisma.user.create({
      data: { email: `test-myviews-a-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.IT_AGENT },
    });
    userB = await prisma.user.create({
      data: { email: `test-myviews-b-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER },
    });

    const status = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!status) throw new Error("No default TicketStatus seeded — cannot create test tickets.");

    // Assigned to A, created by B — should appear ONLY in A's "assigned to
    // me" and ONLY in B's "created by me".
    const assignedOnly = await prisma.ticket.create({
      data: { title: `Test assigned-only ${RUN_ID}`, description: "x", requesterId: userB.id, assignedAgentId: userA.id, statusId: status.id },
    });
    ticketIds.push(assignedOnly.id);

    // Created by A, assigned to nobody — should appear ONLY in A's "created
    // by me", never in anyone's "assigned to me".
    const createdOnly = await prisma.ticket.create({
      data: { title: `Test created-only ${RUN_ID}`, description: "x", requesterId: userA.id, statusId: status.id },
    });
    ticketIds.push(createdOnly.id);

    // Both created AND assigned to A — should appear in BOTH of A's views.
    const both = await prisma.ticket.create({
      data: { title: `Test both ${RUN_ID}`, description: "x", requesterId: userA.id, assignedAgentId: userA.id, statusId: status.id },
    });
    ticketIds.push(both.id);

    console.log("Testing Assigned to Me for user A...\n");
    const assignedToA = await prisma.ticket.findMany({ where: buildAssignedToMeWhere(userA.id) });
    const assignedToAIds = assignedToA.map((t) => t.id);
    check("Includes the assigned-only ticket", assignedToAIds.includes(assignedOnly.id));
    check("Includes the both ticket", assignedToAIds.includes(both.id));
    check("Does NOT include the created-only ticket (never assigned to A)", !assignedToAIds.includes(createdOnly.id));

    console.log("\nTesting Created by Me for user A...\n");
    const createdByA = await prisma.ticket.findMany({ where: buildCreatedByMeWhere(userA.id) });
    const createdByAIds = createdByA.map((t) => t.id);
    check("Includes the created-only ticket", createdByAIds.includes(createdOnly.id));
    check("Includes the both ticket", createdByAIds.includes(both.id));
    check("Does NOT include the assigned-only ticket (A didn't create it)", !createdByAIds.includes(assignedOnly.id));

    console.log("\nTesting Created by Me for user B...\n");
    const createdByB = await prisma.ticket.findMany({ where: buildCreatedByMeWhere(userB.id) });
    const createdByBIds = createdByB.map((t) => t.id);
    check("Includes the assigned-only ticket (B created it)", createdByBIds.includes(assignedOnly.id));
    check("Does NOT include the created-only ticket (B didn't create it)", !createdByBIds.includes(createdOnly.id));

    console.log("\nTesting Assigned to Me for user B (never assigned anything)...\n");
    const assignedToB = await prisma.ticket.findMany({ where: buildAssignedToMeWhere(userB.id) });
    check("Empty — B is never anyone's assignee", assignedToB.length === 0);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticket", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["user", () =>
        prisma.user.deleteMany({ where: { id: { in: [userA?.id, userB?.id].filter((x): x is string => !!x) } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
