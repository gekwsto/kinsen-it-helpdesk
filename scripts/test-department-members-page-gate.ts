/**
 * The department members page (/admin/departments/[id]/members) used to be
 * gated on the single permission department.manageMembers — but a previous
 * phase moved the actual POST/DELETE member routes to check
 * department.user.assign/department.user.unassign instead, so a
 * DEPARTMENT_MANAGER (who has assign/unassign but not manageMembers) could
 * pass the API checks yet get redirected away from the page that would let
 * them use those actions. Fixed via hasAnyDepartmentPermission +
 * requireAnyDepartmentPermission (lib/permissions.ts), and granular
 * canAssign/canUnassign/canChangeRole props on
 * DepartmentMembersManagement so the UI narrows instead of all-or-nothing.
 *
 * Tests:
 *  1. hasAnyDepartmentPermission is true when ANY of the given keys is held.
 *  2. hasAnyDepartmentPermission is false when NONE of the given keys is held.
 *  3. DEPARTMENT_MANAGER (has department.user.assign/unassign, not manageMembers)
 *     passes the page's 3-key view gate.
 *  4. AGENT_ASSIGNEE (has none of the three) is rejected by the same gate.
 *  5. DEPARTMENT_ADMIN (has the legacy department.manageMembers) still passes.
 *
 * Usage: npx tsx scripts/test-department-members-page-gate.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole } from "@prisma/client";
import { hasAnyDepartmentPermission } from "@/lib/permissions";

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

const MEMBER_PAGE_VIEW_PERMISSIONS = ["department.manageMembers", "department.user.assign", "department.user.unassign"];

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    console.log("Testing hasAnyDepartmentPermission...\n");
    check(
      "DEPARTMENT_MANAGER (has department.user.assign) matches [\"department.manageMembers\", \"department.user.assign\"]",
      await hasAnyDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, ["department.manageMembers", "department.user.assign"], null)
    );
    check(
      "AGENT_ASSIGNEE (has neither) does not match the same list",
      !(await hasAnyDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, ["department.manageMembers", "department.user.assign"], null))
    );

    console.log("\nTesting the members page's exact 3-key view gate...\n");
    check(
      "DEPARTMENT_MANAGER passes the page gate (via department.user.assign/unassign)",
      await hasAnyDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, MEMBER_PAGE_VIEW_PERMISSIONS, null)
    );
    check(
      "DEPARTMENT_ADMIN passes the page gate (via legacy department.manageMembers)",
      await hasAnyDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, MEMBER_PAGE_VIEW_PERMISSIONS, null)
    );
    check(
      "AGENT_ASSIGNEE (has none of the three) is rejected by the page gate",
      !(await hasAnyDepartmentPermission(DepartmentRole.AGENT_ASSIGNEE, MEMBER_PAGE_VIEW_PERMISSIONS, null))
    );
    check(
      "REQUESTER (has none of the three) is rejected by the page gate",
      !(await hasAnyDepartmentPermission(DepartmentRole.REQUESTER, MEMBER_PAGE_VIEW_PERMISSIONS, null))
    );
  } finally {
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
