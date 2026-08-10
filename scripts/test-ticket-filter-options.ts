/**
 * Ticket list Status/Priority/Category filter options
 * (lib/services/ticket-filter-options-service.ts) — proves the fix for the
 * "Open / Open / Open / Open" duplicate-dropdown bug: TicketStatus/
 * TicketPriority/TicketCategory are department-owned config tables
 * (@@unique([departmentId, name])), so a query unscoped by department
 * returned one row per department sharing a name. This script verifies:
 *   - a single department's options are exactly its own config rows, in
 *     configured order, regardless of how many tickets share a status
 *     (dedup was never really the issue — department scoping was);
 *   - "All Workspaces" returns the unique name-grouped union across every
 *     department the caller is authorized to view tickets in;
 *   - a department the caller cannot access never leaks its status/
 *     priority/category names into that union;
 *   - reconcileTicketFilterParam correctly preserves a still-valid
 *     selection across a workspace switch (by name, carried to the new
 *     scope's real id), and resets one that's no longer valid.
 *
 * Usage: npx tsx scripts/test-ticket-filter-options.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import {
  getTicketFilterOptions,
  splitFilterParam,
  reconcileTicketFilterParam,
} from "@/lib/services/ticket-filter-options-service";

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

const RUN_ID = Date.now();
const TAG = `tfo-${RUN_ID}`;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: two departments with overlapping + distinct status/priority/category names ===\n");

    const deptA = await createDepartment({ name: `${TAG}-Dept-A`, slug: `${TAG}-dept-a` });
    const deptB = await createDepartment({ name: `${TAG}-Dept-B`, slug: `${TAG}-dept-b` });
    const deptC = await createDepartment({ name: `${TAG}-Dept-C`, slug: `${TAG}-dept-c` }); // unauthorized — must never leak
    deptIds.push(deptA.id, deptB.id, deptC.id);

    // createDepartment() seeds its own starter statuses/priorities (Open, In
    // Progress, Resolved, Closed, Cancelled / High, Medium, Low) — this
    // script needs full, exact control over each department's config to
    // test specific overlapping/non-overlapping scenarios, so those starter
    // rows are deactivated immediately and this test's own TAG-prefixed rows
    // (below) are the only active ones for A/B/C.
    await prisma.ticketStatus.updateMany({ where: { departmentId: { in: [deptA.id, deptB.id, deptC.id] } }, data: { isActive: false } });
    await prisma.ticketPriority.updateMany({ where: { departmentId: { in: [deptA.id, deptB.id, deptC.id] } }, data: { isActive: false } });

    const OPEN = `${TAG}-Open`;
    const IN_PROGRESS = `${TAG}-InProgress`;
    const RESOLVED = `${TAG}-Resolved`;
    const WAITING = `${TAG}-Waiting`;
    const CLOSED = `${TAG}-Closed`;
    const SECRET = `${TAG}-SecretOnlyInC`;

    // Dept A: Open, InProgress, Resolved, Closed (in that configured order).
    const statusA = await Promise.all([
      prisma.ticketStatus.create({ data: { name: OPEN, color: "#111111", order: 0, departmentId: deptA.id } }),
      prisma.ticketStatus.create({ data: { name: IN_PROGRESS, color: "#222222", order: 1, departmentId: deptA.id } }),
      prisma.ticketStatus.create({ data: { name: RESOLVED, color: "#333333", order: 2, departmentId: deptA.id } }),
      prisma.ticketStatus.create({ data: { name: CLOSED, color: "#444444", order: 3, isClosed: true, departmentId: deptA.id } }),
    ]);
    // Dept B: Open, Waiting, Closed — Open/Closed share a NAME with Dept A
    // but are independent rows with independent ids.
    const statusB = await Promise.all([
      prisma.ticketStatus.create({ data: { name: OPEN, color: "#111111", order: 0, departmentId: deptB.id } }),
      prisma.ticketStatus.create({ data: { name: WAITING, color: "#555555", order: 1, departmentId: deptB.id } }),
      prisma.ticketStatus.create({ data: { name: CLOSED, color: "#444444", order: 2, isClosed: true, departmentId: deptB.id } }),
    ]);
    // Dept C: a status name that must never appear for a caller unauthorized there.
    await prisma.ticketStatus.create({ data: { name: SECRET, color: "#000000", order: 0, departmentId: deptC.id } });

    const LOW = `${TAG}-Low`;
    const MEDIUM = `${TAG}-Medium`;
    const HIGH = `${TAG}-High`;
    const URGENT = `${TAG}-Urgent`;
    const priorityA = await Promise.all([
      prisma.ticketPriority.create({ data: { name: LOW, level: 1, color: "#aaa", departmentId: deptA.id } }),
      prisma.ticketPriority.create({ data: { name: MEDIUM, level: 2, color: "#bbb", departmentId: deptA.id } }),
      prisma.ticketPriority.create({ data: { name: HIGH, level: 3, color: "#ccc", departmentId: deptA.id } }),
      prisma.ticketPriority.create({ data: { name: URGENT, level: 4, color: "#ddd", departmentId: deptA.id } }),
    ]);
    const priorityB = await Promise.all([
      prisma.ticketPriority.create({ data: { name: LOW, level: 1, color: "#aaa", departmentId: deptB.id } }),
      prisma.ticketPriority.create({ data: { name: HIGH, level: 3, color: "#ccc", departmentId: deptB.id } }),
    ]);

    const CATEGORY_BUG = `${TAG}-Bug`;
    const categoryA = await prisma.ticketCategory.create({ data: { name: CATEGORY_BUG, color: "#6366f1", departmentId: deptA.id } });
    const categoryB = await prisma.ticketCategory.create({ data: { name: CATEGORY_BUG, color: "#6366f1", departmentId: deptB.id } });

    // Users: ADMIN (sees everything), and a plain USER scoped to A+B only
    // (never C) — DepartmentRole.AGENT_ASSIGNEE so ticket.view is granted.
    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    const scopedUser = await prisma.user.create({
      data: { email: `${TAG}-scoped@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id, scopedUser.id);
    await prisma.departmentMembership.createMany({
      data: [
        { userId: scopedUser.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
        { userId: scopedUser.id, departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
      ],
    });

    // 5 tickets all with Dept A's "Open" status — the exact repro of the
    // reported bug ("Open" appearing once per ticket). A requester is
    // needed for Ticket.requesterId (not nullable) — reuse admin as the
    // requester, irrelevant to what's under test here.
    for (let i = 0; i < 5; i++) {
      const t = await prisma.ticket.create({
        data: {
          title: `${TAG} ticket ${i}`,
          description: "fixture",
          departmentId: deptA.id,
          statusId: statusA[0].id, // Open
          priorityId: priorityA[0].id,
          requesterId: admin.id,
        },
        select: { id: true },
      });
      ticketIds.push(t.id);
    }
    // A few more with InProgress, to also prove multiple-tickets-per-status
    // never inflates the count beyond one option.
    for (let i = 0; i < 3; i++) {
      const t = await prisma.ticket.create({
        data: {
          title: `${TAG} in-progress ${i}`,
          description: "fixture",
          departmentId: deptA.id,
          statusId: statusA[1].id,
          priorityId: priorityA[1].id,
          requesterId: admin.id,
        },
        select: { id: true },
      });
      ticketIds.push(t.id);
    }

    console.log("\n1-2. Duplicate tickets on the same status still produce exactly ONE option each ===\n");
    const optionsA = await getTicketFilterOptions(deptA.id, admin.id, Role.ADMIN);
    const namesA = optionsA.statuses.map((s) => s.name);
    check("5 tickets on Open -> exactly one 'Open' status option", namesA.filter((n) => n === OPEN).length === 1, `names: ${namesA.join(", ")}`);
    check("3 tickets on InProgress -> exactly one 'InProgress' status option", namesA.filter((n) => n === IN_PROGRESS).length === 1);

    console.log("\n3-4. Workspace-specific scoping (Dept A vs Dept B) ===\n");
    check("Dept A statuses: exactly [Open, InProgress, Resolved, Closed]", namesA.join(",") === [OPEN, IN_PROGRESS, RESOLVED, CLOSED].join(","), namesA.join(","));
    const optionsB = await getTicketFilterOptions(deptB.id, admin.id, Role.ADMIN);
    const namesB = optionsB.statuses.map((s) => s.name);
    check("Dept B statuses: exactly [Open, Waiting, Closed]", namesB.join(",") === [OPEN, WAITING, CLOSED].join(","), namesB.join(","));
    const openA = optionsA.statuses.find((s) => s.name === OPEN)!;
    const openB = optionsB.statuses.find((s) => s.name === OPEN)!;
    check("Dept A's 'Open' and Dept B's 'Open' are different underlying rows (different ids)", openA.value !== openB.value);

    console.log("\n5-6. All Workspaces union + unauthorized exclusion ===\n");
    const optionsAllAdmin = await getTicketFilterOptions(undefined, admin.id, Role.ADMIN);
    const allNames = optionsAllAdmin.statuses.map((s) => s.name);
    check("All Workspaces (ADMIN): 'Open' appears exactly once despite existing in 2 departments", allNames.filter((n) => n === OPEN).length === 1);
    check("All Workspaces (ADMIN): includes Dept A-only 'InProgress'/'Resolved'", allNames.includes(IN_PROGRESS) && allNames.includes(RESOLVED));
    check("All Workspaces (ADMIN): includes Dept B-only 'Waiting'", allNames.includes(WAITING));
    check("All Workspaces (ADMIN): includes Dept C's status too (ADMIN is authorized everywhere)", allNames.includes(SECRET));
    const openAllOption = optionsAllAdmin.statuses.find((s) => s.name === OPEN)!;
    check("All Workspaces 'Open' option's ids = union of Dept A's + Dept B's Open ids", new Set(openAllOption.ids).size === 2 && openAllOption.ids.includes(openA.value) && openAllOption.ids.includes(openB.value));

    const optionsAllScoped = await getTicketFilterOptions(undefined, scopedUser.id, Role.USER);
    const scopedNames = optionsAllScoped.statuses.map((s) => s.name);
    check("Scoped user (member of A+B only): sees 'Open', 'Waiting', 'Resolved'", scopedNames.includes(OPEN) && scopedNames.includes(WAITING) && scopedNames.includes(RESOLVED));
    check("Scoped user: Dept C's status is NEVER exposed, even in the All-Workspaces union", !scopedNames.includes(SECRET));

    console.log("\n7. Status ordering is preserved (not alphabetical) ===\n");
    // Alphabetical would be Closed, InProgress, Open, Resolved — configured
    // order is Open, InProgress, Resolved, Closed. Confirms `order` drives
    // position, not Array.sort()/name comparison.
    check("Dept A status order matches configured `order`, not alphabetical", namesA[0] === OPEN && namesA[namesA.length - 1] === CLOSED);

    console.log("\n8-9. Priority dedup + Dept A/B scoping ===\n");
    const prioNamesA = optionsA.priorities.map((p) => p.name);
    const prioNamesB = optionsB.priorities.map((p) => p.name);
    check("Dept A priorities: exactly [Low, Medium, High, Urgent] (level desc)", prioNamesA.join(",") === [URGENT, HIGH, MEDIUM, LOW].join(","), prioNamesA.join(","));
    check("Dept B priorities: exactly [High, Low] (level desc, no Medium/Urgent configured)", prioNamesB.join(",") === [HIGH, LOW].join(","), prioNamesB.join(","));

    console.log("\n11-12. All Workspaces priority union + unauthorized exclusion ===\n");
    const prioAllNames = optionsAllAdmin.priorities.map((p) => p.name);
    check("All Workspaces: 'Low' appears exactly once despite existing in both departments", prioAllNames.filter((n) => n === LOW).length === 1);
    const prioScopedNames = optionsAllScoped.priorities.map((p) => p.name);
    check("Scoped user's priority union never includes a Dept-C-only priority (none configured, sanity: union has no extras beyond A/B)", prioScopedNames.every((n) => [LOW, MEDIUM, HIGH, URGENT].includes(n)));

    console.log("\n13. Priority ordering (level desc) preserved in the union too ===\n");
    check("All Workspaces priorities: 'Urgent' (highest level) sorts before 'Low'", prioAllNames.indexOf(URGENT) < prioAllNames.indexOf(LOW));

    console.log("\nCategory: same mechanism (section 11 audit) ===\n");
    check("Dept A category options contain exactly one 'Bug' (own row)", optionsA.categories.filter((c) => c.name === CATEGORY_BUG).length === 1);
    check("Dept A and Dept B 'Bug' categories are different rows", optionsA.categories.find((c) => c.name === CATEGORY_BUG)!.value !== optionsB.categories.find((c) => c.name === CATEGORY_BUG)!.value);
    const optionsAllCategories = optionsAllAdmin.categories.map((c) => c.name);
    check("All Workspaces: 'Bug' category appears exactly once", optionsAllCategories.filter((n) => n === CATEGORY_BUG).length === 1);

    console.log("\n17/19. reconcileTicketFilterParam: still-valid selection is preserved unchanged ===\n");
    const unchangedStatus = await reconcileTicketFilterParam("status", openA.value, optionsA.statuses);
    check("Selecting Dept A's Open, options still Dept A's -> unchanged", unchangedStatus === openA.value);

    console.log("\n5 / 17. Selection carried over BY NAME across a workspace switch (still valid) ===\n");
    const carriedOver = await reconcileTicketFilterParam("status", openA.value, optionsB.statuses);
    check("Dept A's Open id, switched to Dept B's options -> resolves to Dept B's OWN Open id (not left stale)", carriedOver === openB.value, `got ${carriedOver}`);

    console.log("\n18/20. Selection reset when no longer valid after a workspace switch ===\n");
    const inProgressA = optionsA.statuses.find((s) => s.name === IN_PROGRESS)!;
    const reset = await reconcileTicketFilterParam("status", inProgressA.value, optionsB.statuses);
    check("Dept A's InProgress id, switched to Dept B (no InProgress) -> resets to null", reset === null, `got ${reset}`);

    console.log("\nSame reconciliation rules apply to Priority ===\n");
    const lowA = optionsA.priorities.find((p) => p.name === LOW)!;
    const mediumA = optionsA.priorities.find((p) => p.name === MEDIUM)!;
    const lowB = optionsB.priorities.find((p) => p.name === LOW)!;
    check("Priority: still-valid name carried over to the new scope's own id", (await reconcileTicketFilterParam("priority", lowA.value, optionsB.priorities)) === lowB.value);
    check("Priority: no-longer-valid selection resets to null", (await reconcileTicketFilterParam("priority", mediumA.value, optionsB.priorities)) === null);

    console.log("\nNo selection at all is always a no-op (null) ===\n");
    check("Undefined current value -> null", (await reconcileTicketFilterParam("status", undefined, optionsA.statuses)) === null);

    console.log("\nAll-Workspaces grouped value: splitFilterParam + reconciliation round-trip ===\n");
    const groupedOpenValue = openAllOption.value; // "idA,idB"
    check("Grouped value splits back into exactly the 2 underlying ids", splitFilterParam(groupedOpenValue).length === 2);
    const stillValidGrouped = await reconcileTicketFilterParam("status", groupedOpenValue, optionsAllAdmin.statuses);
    check("A grouped All-Workspaces selection, options unchanged -> stays valid unchanged", stillValidGrouped === groupedOpenValue);
    // Switching FROM All-Workspaces TO Dept A alone: only DeptA's id half of
    // the grouped pair is still valid, but by design the whole selection
    // still means "Open", which exists in A -> carried over to A's own id.
    const narrowedToA = await reconcileTicketFilterParam("status", groupedOpenValue, optionsA.statuses);
    check("Grouped All-Workspaces 'Open', narrowed to Dept A alone -> resolves to Dept A's Open id", narrowedToA === openA.value, `got ${narrowedToA}`);

    console.log("\n10. Empty-workspace case: a department with no active statuses/priorities/categories still returns a safe, empty (never throwing) result ===\n");
    const emptyDept = await createDepartment({ name: `${TAG}-Empty`, slug: `${TAG}-empty` });
    deptIds.push(emptyDept.id);
    await prisma.ticketStatus.updateMany({ where: { departmentId: emptyDept.id }, data: { isActive: false } });
    await prisma.ticketPriority.updateMany({ where: { departmentId: emptyDept.id }, data: { isActive: false } });
    await prisma.ticketCategory.updateMany({ where: { departmentId: emptyDept.id }, data: { isActive: false } });
    const emptyOptions = await getTicketFilterOptions(emptyDept.id, admin.id, Role.ADMIN);
    check("Empty department: statuses is an empty array, not an error", Array.isArray(emptyOptions.statuses) && emptyOptions.statuses.length === 0);
    check("Empty department: priorities is an empty array", Array.isArray(emptyOptions.priorities) && emptyOptions.priorities.length === 0);
    check("Empty department: categories is an empty array", Array.isArray(emptyOptions.categories) && emptyOptions.categories.length === 0);
    const reconcileAgainstEmpty = await reconcileTicketFilterParam("status", openA.value, emptyOptions.statuses);
    check("Reconciling any prior selection against an empty option set resets to null (never throws)", reconcileAgainstEmpty === null);
  } finally {
    console.log("\nCleaning up test data...\n");
    if (ticketIds.length > 0) await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
    if (deptIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: deptIds } } }).catch(() => {});
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } }).catch(() => {});
    }
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
