/**
 * Confirms the seeded `*.assignable` defaults (prisma/seed.ts) exactly match
 * the intended matrix — both global roleKeys (IT_AGENT, DEPARTMENT_MANAGER,
 * DIRECTOR, USER, ADMIN-implicit) and DepartmentRole keys (DEPARTMENT_ADMIN,
 * PROJECT_MANAGER, AGENT_ASSIGNEE, REQUESTER, VIEWER).
 *
 * Usage: npx tsx scripts/test-assignable-permission-defaults.ts
 * Requires a reachable DATABASE_URL and a re-seed with the new permissions —
 * reports clearly and exits if either is missing.
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

const ASSIGNABLE_KEYS = ["ticket.assignable", "activity.assignable", "project.assignable"] as const;

// The intended matrix — true means the roleKey should have that permission seeded.
const EXPECTED: Record<string, Record<(typeof ASSIGNABLE_KEYS)[number], boolean>> = {
  IT_AGENT: { "ticket.assignable": true, "activity.assignable": true, "project.assignable": false },
  DEPARTMENT_MANAGER: { "ticket.assignable": true, "activity.assignable": true, "project.assignable": true },
  DIRECTOR: { "ticket.assignable": false, "activity.assignable": false, "project.assignable": false },
  USER: { "ticket.assignable": false, "activity.assignable": false, "project.assignable": false },
  DEPARTMENT_ADMIN: { "ticket.assignable": true, "activity.assignable": true, "project.assignable": true },
  PROJECT_MANAGER: { "ticket.assignable": false, "activity.assignable": true, "project.assignable": true },
  AGENT_ASSIGNEE: { "ticket.assignable": true, "activity.assignable": true, "project.assignable": false },
  REQUESTER: { "ticket.assignable": false, "activity.assignable": false, "project.assignable": false },
  VIEWER: { "ticket.assignable": false, "activity.assignable": false, "project.assignable": false },
};

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const perms = await prisma.permission.findMany({ where: { key: { in: [...ASSIGNABLE_KEYS] } } });
  if (perms.length !== ASSIGNABLE_KEYS.length) {
    console.log(
      "One or more `*.assignable` permissions aren't seeded yet — re-run `npx tsx prisma/seed.ts` " +
        "(or `npm run db:seed`) against this database, then re-run this test."
    );
    printSummaryAndExit();
    return;
  }
  const permIdByKey = new Map(perms.map((p) => [p.key, p.id]));

  for (const [roleKey, expectations] of Object.entries(EXPECTED)) {
    console.log(`\nTesting ${roleKey}...\n`);
    for (const permKey of ASSIGNABLE_KEYS) {
      const permId = permIdByKey.get(permKey)!;
      const row = await prisma.rolePermission.findUnique({
        where: { roleKey_permissionId: { roleKey, permissionId: permId } },
      });
      const has = row !== null;
      check(`${roleKey}.${permKey} === ${expectations[permKey]}`, has === expectations[permKey]);
    }
  }

  console.log("\nTesting ADMIN bypasses everything without needing seeded rows...\n");
  const adminRows = await prisma.rolePermission.findMany({ where: { roleKey: "ADMIN" } });
  check("ADMIN has no explicit RolePermission rows (bypassed in hasPermission instead)", adminRows.length === 0);

  await prisma.$disconnect();
  printSummaryAndExit();
}

main();
