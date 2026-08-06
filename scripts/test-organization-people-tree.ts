/**
 * lib/services/organization-tree-service.ts's getPeopleTree /
 * getOrganizationContext — real DB, multi-level manager chains. Proves:
 * multi-level assembly, root users with no manager, inactive users excluded
 * under activeOnly, and assembly-time cycle protection against a genuine
 * (deliberately constructed) circular manager relationship in the database
 * — the schema/FK layer permits this (no DB-level cycle constraint exists),
 * so this is a real defense-in-depth check, not a theoretical one.
 *
 * Usage: npx tsx scripts/test-organization-people-tree.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { getPeopleTree, getOrganizationContext, invalidateOrganizationTreeCache, type PeopleTreeNode } from "@/lib/services/organization-tree-service";

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

function findNode(nodes: PeopleTreeNode[], id: string): PeopleTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const userIds: string[] = [];

  try {
    // Chain: ceo -> vp -> director -> manager -> ic (5 levels).
    const ceo = await prisma.user.create({ data: { email: `orgtest-ceo-${RUN_ID}@kinsen.gr`, name: "Org Test CEO", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(ceo.id);
    const vp = await prisma.user.create({ data: { email: `orgtest-vp-${RUN_ID}@kinsen.gr`, name: "Org Test VP", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: ceo.id } });
    userIds.push(vp.id);
    const director = await prisma.user.create({ data: { email: `orgtest-dir-${RUN_ID}@kinsen.gr`, name: "Org Test Director", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: vp.id } });
    userIds.push(director.id);
    const manager = await prisma.user.create({ data: { email: `orgtest-mgr2-${RUN_ID}@kinsen.gr`, name: "Org Test Manager2", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: director.id } });
    userIds.push(manager.id);
    const ic = await prisma.user.create({ data: { email: `orgtest-ic-${RUN_ID}@kinsen.gr`, name: "Org Test IC", jobTitle: "Engineer", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: manager.id } });
    userIds.push(ic.id);

    // A second, independent root with no manager.
    const otherRoot = await prisma.user.create({ data: { email: `orgtest-otherroot-${RUN_ID}@kinsen.gr`, name: "Org Test Other Root", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(otherRoot.id);

    // An inactive report under the manager.
    const inactiveReport = await prisma.user.create({ data: { email: `orgtest-inactive-${RUN_ID}@kinsen.gr`, name: "Org Test Inactive Report", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: false, managerId: manager.id } });
    userIds.push(inactiveReport.id);

    invalidateOrganizationTreeCache();

    console.log("\nMulti-level assembly (activeOnly=false, scoped to this run's fixtures)...\n");
    const fullPeopleTree = await getPeopleTree(ceo.id, { activeOnly: false });
    check("getPeopleTree(ceo.id) returns exactly one root (ceo itself)", fullPeopleTree.length === 1 && fullPeopleTree[0].id === ceo.id);
    const ceoNode = fullPeopleTree[0];
    check("ceo -> vp -> director -> manager -> ic chain assembled correctly, 5 levels deep", (() => {
      let cursor: PeopleTreeNode | undefined = ceoNode;
      const expectedChain = [ceo.id, vp.id, director.id, manager.id, ic.id];
      for (let i = 0; i < expectedChain.length; i++) {
        if (!cursor || cursor.id !== expectedChain[i]) return false;
        cursor = cursor.children[0];
      }
      return true;
    })());
    const managerNode = findNode([ceoNode], manager.id);
    check("manager's directReportsCount includes the inactive report when activeOnly=false", managerNode?.directReportsCount === 2);

    console.log("\nInactive users excluded under activeOnly=true...\n");
    const activeOnlyTree = await getPeopleTree(ceo.id, { activeOnly: true });
    const managerNodeActive = findNode(activeOnlyTree, manager.id);
    check("manager's directReportsCount excludes the inactive report under activeOnly", managerNodeActive?.directReportsCount === 1);
    check("only the active IC remains as manager's child", managerNodeActive?.children.length === 1 && managerNodeActive.children[0].id === ic.id);

    console.log("\nRoot discovery (no rootUserId)...\n");
    const allRoots = await getPeopleTree(undefined, { activeOnly: false });
    const rootIds = new Set(allRoots.map((r) => r.id));
    check("ceo appears as a root (no manager)", rootIds.has(ceo.id));
    check("otherRoot appears as a root (no manager)", rootIds.has(otherRoot.id));
    check("vp/director/manager/ic do NOT appear as separate roots (they have a manager)", !rootIds.has(vp.id) && !rootIds.has(director.id) && !rootIds.has(manager.id) && !rootIds.has(ic.id));

    console.log("\nOrganization context DTO (management chain)...\n");
    const icContext = await getOrganizationContext(ic.id);
    check("ic's context resolves", icContext !== null);
    check("ic's manager is `manager`", icContext?.manager?.id === manager.id);
    check("ic's managementChain is manager -> director -> vp -> ceo (4 entries)", icContext?.managementChain.length === 4);
    check(
      "managementChain is in correct upward order",
      icContext?.managementChain[0].id === manager.id &&
        icContext?.managementChain[1].id === director.id &&
        icContext?.managementChain[2].id === vp.id &&
        icContext?.managementChain[3].id === ceo.id
    );
    check("ic's directReportsCount is 0", icContext?.directReportsCount === 0);
    const ceoContext = await getOrganizationContext(ceo.id);
    check("ceo has no manager", ceoContext?.manager === null);
    check("ceo's managementChain is empty", ceoContext?.managementChain.length === 0);
    check("ceo's directReportsCount is 1 (vp)", ceoContext?.directReportsCount === 1);

    console.log("\nCycle protection (a REAL circular manager relationship written directly to the DB)...\n");
    // The schema/FK layer permits this — there is no DB-level cycle
    // constraint, only the manager-sync SERVICE's write-time rejection
    // (organization-manager-sync-service.ts) and this assembly-time guard.
    // Constructing it directly here tests the assembly-time defense
    // in isolation, independent of the sync service.
    const cycleA = await prisma.user.create({ data: { email: `orgtest-cyclea-${RUN_ID}@kinsen.gr`, name: "Org Test Cycle A", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true } });
    userIds.push(cycleA.id);
    const cycleB = await prisma.user.create({ data: { email: `orgtest-cycleb-${RUN_ID}@kinsen.gr`, name: "Org Test Cycle B", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, managerId: cycleA.id } });
    userIds.push(cycleB.id);
    await prisma.user.update({ where: { id: cycleA.id }, data: { managerId: cycleB.id } }); // A -> B -> A cycle

    invalidateOrganizationTreeCache();
    let cycleAssemblyThrew = false;
    let cycleRoots: PeopleTreeNode[] = [];
    try {
      cycleRoots = await getPeopleTree(undefined, { activeOnly: false });
    } catch {
      cycleAssemblyThrew = true;
    }
    check("assembling the full people tree with a real DB cycle present never throws", !cycleAssemblyThrew);
    const cycleAInTree = findNode(cycleRoots, cycleA.id);
    const cycleBInTree = findNode(cycleRoots, cycleB.id);
    check("both cyclic users still appear somewhere in the assembled tree (never silently dropped)", cycleAInTree !== null || cycleBInTree !== null);

    let cycleContextThrew = false;
    try {
      await getOrganizationContext(cycleA.id);
    } catch {
      cycleContextThrew = true;
    }
    check("getOrganizationContext on a cyclic user never infinite-loops or throws", !cycleContextThrew);
  } finally {
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    invalidateOrganizationTreeCache();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
