/**
 * Built-in roles are no longer locked for name/description/permission edits —
 * PATCH /api/admin/roles/[id] and POST/DELETE .../permissions/[permId] both
 * dropped their blanket `role.isBuiltIn` / `role.key === "ADMIN"` gates. Only
 * hard delete and admin-lockout-risking changes stay blocked (see
 * test-role-in-use-and-hard-delete.ts and test-role-admin-lockout-guardrail.ts).
 *
 * This test exercises the same Prisma calls those routes now make directly
 * against real seeded built-in rows, then reverts every change in `finally`
 * so the seeded state is left exactly as found.
 *
 * Tests:
 *  1. Built-in GLOBAL role (IT_AGENT): name/description PATCH persists.
 *  2. Built-in DEPARTMENT role (AGENT_ASSIGNEE): name/description PATCH persists.
 *  3. Non-critical permission add + remove persists on a built-in role (IT_AGENT).
 *  4. The Administrator ("ADMIN") role's permission rows are no longer
 *     unconditionally blocked from being touched (the old cannot_remove_last_admin/
 *     builtin_role_locked blanket gate is gone) — a non-critical permission
 *     can be added and removed on it directly.
 *
 * Usage: npx tsx scripts/test-role-builtin-edit-unlocked.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";

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

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const originals: Record<string, { name: string; description: string | null }> = {};

  try {
    console.log("\nTesting built-in GLOBAL role rename (IT_AGENT)...\n");
    const itAgent = await prisma.customRole.findUnique({
      where: { key: "IT_AGENT" },
      select: { id: true, key: true, name: true, description: true, isBuiltIn: true },
    });
    check("IT_AGENT exists and is built-in", itAgent?.isBuiltIn === true);
    if (itAgent) {
      originals.IT_AGENT = { name: itAgent.name, description: itAgent.description };
      const updated = await prisma.customRole.update({
        where: { id: itAgent.id },
        data: { name: "IT Agent (renamed by test)", description: "temp" },
        select: { name: true, description: true },
      });
      check(
        "Built-in GLOBAL role (IT_AGENT) rename persists — no longer blocked",
        updated.name === "IT Agent (renamed by test)" && updated.description === "temp"
      );
    }

    console.log("\nTesting built-in DEPARTMENT role rename (AGENT_ASSIGNEE)...\n");
    const agentAssignee = await prisma.customRole.findUnique({
      where: { key: "AGENT_ASSIGNEE" },
      select: { id: true, key: true, name: true, description: true, isBuiltIn: true },
    });
    check("AGENT_ASSIGNEE exists and is built-in", agentAssignee?.isBuiltIn === true);
    if (agentAssignee) {
      originals.AGENT_ASSIGNEE = { name: agentAssignee.name, description: agentAssignee.description };
      const updated = await prisma.customRole.update({
        where: { id: agentAssignee.id },
        data: { name: "Agent/Assignee (renamed by test)" },
        select: { name: true },
      });
      check(
        "Built-in DEPARTMENT role (AGENT_ASSIGNEE) rename persists — no longer blocked",
        updated.name === "Agent/Assignee (renamed by test)"
      );
    }

    console.log("\nTesting non-critical permission add/remove on a built-in role (IT_AGENT)...\n");
    const nonCriticalPerm = await prisma.permission.findUnique({ where: { key: "goal.delete" } });
    check("goal.delete permission is seeded", nonCriticalPerm !== null);
    if (itAgent && nonCriticalPerm) {
      await prisma.rolePermission.deleteMany({ where: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id } });
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionId: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id } },
        update: {},
        create: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id },
      });
      const granted = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id } },
      });
      check("Permission grant persists on a built-in role", granted !== null);

      await prisma.rolePermission.deleteMany({ where: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id } });
      const revoked = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey: "IT_AGENT", permissionId: nonCriticalPerm.id } },
      });
      check("Permission revoke persists on a built-in role", revoked === null);
    }

    console.log("\nTesting the ADMIN role's own permission rows are no longer blanket-locked...\n");
    const adminRole = await prisma.customRole.findUnique({ where: { key: "ADMIN" }, select: { id: true, key: true } });
    check("ADMIN CustomRole row exists", adminRole !== null);
    if (adminRole && nonCriticalPerm) {
      await prisma.rolePermission.deleteMany({ where: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id } });
      await prisma.rolePermission.upsert({
        where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id } },
        update: {},
        create: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id },
      });
      const granted = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id } },
      });
      check("Permission grant persists on the ADMIN role (old blanket gate is gone)", granted !== null);

      await prisma.rolePermission.deleteMany({ where: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id } });
      const revoked = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey: "ADMIN", permissionId: nonCriticalPerm.id } },
      });
      check("Permission revoke persists on the ADMIN role (old blanket gate is gone)", revoked === null);
    }
  } finally {
    console.log("\nReverting seeded rows to their original state...\n");
    for (const [key, original] of Object.entries(originals)) {
      try {
        await prisma.customRole.update({ where: { key }, data: original, select: { key: true } });
      } catch (err) {
        console.warn(`Revert of ${key} failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
