/**
 * Offline test for the Microsoft mapping -> global role alignment pieces
 * that need no network or DB: the DepartmentRole -> Role translation table
 * and the sync-eligibility guardrail.
 *
 * Usage: npx tsx scripts/test-microsoft-role-sync.ts
 */
import { DepartmentRole, GlobalRoleSource, Role } from "@prisma/client";
import {
  translateDepartmentRoleToGlobalRole,
  shouldSyncGlobalRole,
} from "@/lib/services/department-role-translation";

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

function main() {
  console.log("Testing translateDepartmentRoleToGlobalRole...\n");

  check(
    "DEPARTMENT_MANAGER -> DEPARTMENT_MANAGER (the exact bug-report case)",
    translateDepartmentRoleToGlobalRole(DepartmentRole.DEPARTMENT_MANAGER) === Role.DEPARTMENT_MANAGER
  );
  check(
    "DEPARTMENT_ADMIN -> DEPARTMENT_MANAGER (ceiling, never ADMIN)",
    translateDepartmentRoleToGlobalRole(DepartmentRole.DEPARTMENT_ADMIN) === Role.DEPARTMENT_MANAGER
  );
  check("AGENT_ASSIGNEE -> IT_AGENT", translateDepartmentRoleToGlobalRole(DepartmentRole.AGENT_ASSIGNEE) === Role.IT_AGENT);
  check("REQUESTER -> USER", translateDepartmentRoleToGlobalRole(DepartmentRole.REQUESTER) === Role.USER);
  check("VIEWER -> USER", translateDepartmentRoleToGlobalRole(DepartmentRole.VIEWER) === Role.USER);

  console.log("\nGuardrail: translation table never produces System Admin...\n");
  const allDepartmentRoles = Object.values(DepartmentRole);
  const everyTranslationIsSafe = allDepartmentRoles.every(
    (r) => translateDepartmentRoleToGlobalRole(r) !== Role.ADMIN
  );
  check("no DepartmentRole translates to Role.ADMIN, for any value in the enum", everyTranslationIsSafe);

  console.log("\nTesting shouldSyncGlobalRole...\n");

  check(
    "System Admin is never touched, even with SYSTEM source",
    shouldSyncGlobalRole({ role: Role.ADMIN, globalRoleSource: GlobalRoleSource.SYSTEM }) === false
  );
  check(
    "System Admin is never touched, even with MICROSOFT_DEPARTMENT source",
    shouldSyncGlobalRole({ role: Role.ADMIN, globalRoleSource: GlobalRoleSource.MICROSOFT_DEPARTMENT }) === false
  );
  check(
    "Manual override blocks sync regardless of current role",
    shouldSyncGlobalRole({ role: Role.USER, globalRoleSource: GlobalRoleSource.MANUAL }) === false
  );
  check(
    "Fresh/seeded user (SYSTEM source) is sync-eligible",
    shouldSyncGlobalRole({ role: Role.USER, globalRoleSource: GlobalRoleSource.SYSTEM }) === true
  );
  check(
    "Already Microsoft-managed user stays sync-eligible on the next login",
    shouldSyncGlobalRole({ role: Role.DEPARTMENT_MANAGER, globalRoleSource: GlobalRoleSource.MICROSOFT_DEPARTMENT }) === true
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
