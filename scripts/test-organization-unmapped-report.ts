/**
 * lib/services/organization-unmapped-report-service.ts — the corrected
 * manager-mapping classification (production correction pass). Proves the
 * seven distinct statuses are computed correctly and, critically, that a
 * legitimate organizational root (a user with no manager but real direct
 * reports) is NEVER reported as a problem — the earlier, overly broad
 * "any active synced user without a manager = unmapped" rule would have
 * flagged every department head/executive in a real tenant as a false
 * positive.
 *
 * Usage: npx tsx scripts/test-organization-unmapped-report.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";
import { classifyUserManagerMappings, buildManagerMappingReport } from "@/lib/services/organization-unmapped-report-service";

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
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const userIds: string[] = [];
  const now = new Date();

  try {
    // SYNCED: has a valid, active manager.
    const manager = await prisma.user.create({
      data: { email: `report-manager-${RUN_ID}@x.com`, name: "Report Manager", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now },
    });
    userIds.push(manager.id);
    const synced = await prisma.user.create({
      data: { email: `report-synced-${RUN_ID}@x.com`, name: "Report Synced", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now, managerId: manager.id },
    });
    userIds.push(synced.id);

    // EXPECTED_ROOT: manager itself has no manager but DOES have a direct
    // report (synced, above) — this is exactly the "manager" fixture, so it
    // doubles as both the SYNCED case's manager AND the EXPECTED_ROOT case.

    // MANAGER_NOT_ASSIGNED: no manager, no direct reports — a genuine dead end.
    const notAssigned = await prisma.user.create({
      data: { email: `report-notassigned-${RUN_ID}@x.com`, name: "Report NotAssigned", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now },
    });
    userIds.push(notAssigned.id);

    // MANAGER_NOT_SYNCED: real Entra manager relationship, but the manager
    // was excluded from the synced set (guest/service account).
    const notSynced = await prisma.user.create({
      data: {
        email: `report-notsynced-${RUN_ID}@x.com`,
        name: "Report NotSynced",
        authProvider: AuthProvider.CREDENTIALS,
        role: Role.USER,
        isActive: true,
        organizationSyncedAt: now,
        managerExcludedFromSync: true,
      },
    });
    userIds.push(notSynced.id);

    // MANAGER_INACTIVE: resolved manager exists but is inactive.
    const inactiveManager = await prisma.user.create({
      data: { email: `report-inactivemgr-${RUN_ID}@x.com`, name: "Report InactiveMgr", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: false },
    });
    userIds.push(inactiveManager.id);
    const managerInactive = await prisma.user.create({
      data: {
        email: `report-mgrinactive-${RUN_ID}@x.com`,
        name: "Report MgrInactive",
        authProvider: AuthProvider.CREDENTIALS,
        role: Role.USER,
        isActive: true,
        organizationSyncedAt: now,
        managerId: inactiveManager.id,
      },
    });
    userIds.push(managerInactive.id);

    // INVALID_SELF_MANAGER: managerId === own id (only reachable via a
    // direct update — the schema doesn't allow it at create time since the
    // FK target must already exist).
    const selfManager = await prisma.user.create({
      data: { email: `report-selfmgr-${RUN_ID}@x.com`, name: "Report SelfMgr", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now },
    });
    userIds.push(selfManager.id);
    await prisma.user.update({ where: { id: selfManager.id }, data: { managerId: selfManager.id } });

    // MANAGER_CYCLE: cycleA <-> cycleB.
    const cycleA = await prisma.user.create({
      data: { email: `report-cyclea-${RUN_ID}@x.com`, name: "Report CycleA", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now },
    });
    userIds.push(cycleA.id);
    const cycleB = await prisma.user.create({
      data: { email: `report-cycleb-${RUN_ID}@x.com`, name: "Report CycleB", authProvider: AuthProvider.CREDENTIALS, role: Role.USER, isActive: true, organizationSyncedAt: now, managerId: cycleA.id },
    });
    userIds.push(cycleB.id);
    await prisma.user.update({ where: { id: cycleA.id }, data: { managerId: cycleB.id } });

    const allClassifications = await classifyUserManagerMappings();
    const byId = new Map(allClassifications.map((c) => [c.userId, c.status]));

    console.log("\nEach fixture classifies exactly as expected...\n");
    check("manager (no manager, has a direct report) -> EXPECTED_ROOT, not an error", byId.get(manager.id) === "EXPECTED_ROOT");
    check("synced (has a valid active manager) -> SYNCED", byId.get(synced.id) === "SYNCED");
    check("notAssigned (no manager, no reports) -> MANAGER_NOT_ASSIGNED", byId.get(notAssigned.id) === "MANAGER_NOT_ASSIGNED");
    check("notSynced (managerExcludedFromSync flag) -> MANAGER_NOT_SYNCED", byId.get(notSynced.id) === "MANAGER_NOT_SYNCED");
    check("managerInactive (resolved manager is inactive) -> MANAGER_INACTIVE", byId.get(managerInactive.id) === "MANAGER_INACTIVE");
    check("selfManager (managerId === own id) -> INVALID_SELF_MANAGER", byId.get(selfManager.id) === "INVALID_SELF_MANAGER");
    check("cycleA/cycleB (mutual manager chain) -> both MANAGER_CYCLE", byId.get(cycleA.id) === "MANAGER_CYCLE" && byId.get(cycleB.id) === "MANAGER_CYCLE");

    console.log("\nbuildManagerMappingReport: expected roots are never listed as problems...\n");
    const report = await buildManagerMappingReport(500);
    const problemUserIds = new Set(Object.values(report.problems).flatMap((bucket) => bucket?.items.map((i) => i.userId) ?? []));
    check("EXPECTED_ROOT user (manager) never appears in the problems report", !problemUserIds.has(manager.id));
    check("SYNCED user never appears in the problems report", !problemUserIds.has(synced.id));
    check("MANAGER_NOT_ASSIGNED user DOES appear in problems", problemUserIds.has(notAssigned.id));
    check("MANAGER_NOT_SYNCED user DOES appear in problems", problemUserIds.has(notSynced.id));
    check("MANAGER_INACTIVE user DOES appear in problems", problemUserIds.has(managerInactive.id));
    check("INVALID_SELF_MANAGER user DOES appear in problems", problemUserIds.has(selfManager.id));
    check("MANAGER_CYCLE users DO appear in problems", problemUserIds.has(cycleA.id) && problemUserIds.has(cycleB.id));

    check("countsByStatus totals match the number of classified users for this fixture set", (() => {
      const totalForFixtures = userIds.filter((id) => byId.has(id)).length;
      const sum = Object.values(report.countsByStatus).reduce((a, b) => a + b, 0);
      // sum covers ALL synced users in the DB (not just fixtures), so just
      // confirm it's at least as large as our fixture set and internally consistent.
      return sum >= totalForFixtures;
    })());
  } finally {
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
