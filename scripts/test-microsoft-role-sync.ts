/**
 * Offline test for the Microsoft mapping role registry: MicrosoftDepartmentMapping.role
 * stores the GLOBAL Role (matching /admin/roles), translateGlobalRoleToDepartmentRole
 * derives what DepartmentMembership.role should be, and the sync-eligibility
 * guardrail. All pure functions, no DB/network — see
 * lib/services/department-role-translation.ts.
 *
 * Usage: npx tsx scripts/test-microsoft-role-sync.ts
 */
import { DepartmentRole, GlobalRoleSource, Role } from "@prisma/client";
import {
  translateGlobalRoleToDepartmentRole,
  isGlobalRoleAllowedForMicrosoftMapping,
  getMicrosoftMappingRoleOptions,
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
  console.log("Testing translateGlobalRoleToDepartmentRole...\n");

  check(
    "DEPARTMENT_MANAGER -> DEPARTMENT_MANAGER",
    translateGlobalRoleToDepartmentRole(Role.DEPARTMENT_MANAGER) === DepartmentRole.DEPARTMENT_MANAGER
  );
  check(
    "IT_AGENT -> AGENT_ASSIGNEE",
    translateGlobalRoleToDepartmentRole(Role.IT_AGENT) === DepartmentRole.AGENT_ASSIGNEE
  );
  check(
    "USER -> REQUESTER (this app's USER role creates tickets)",
    translateGlobalRoleToDepartmentRole(Role.USER) === DepartmentRole.REQUESTER
  );
  check(
    "DIRECTOR -> VIEWER (Director's real power is the canViewAllDepartments bypass, not this membership)",
    translateGlobalRoleToDepartmentRole(Role.DIRECTOR) === DepartmentRole.VIEWER
  );

  console.log("\nTesting isGlobalRoleAllowedForMicrosoftMapping...\n");

  check("ADMIN is never allowed", isGlobalRoleAllowedForMicrosoftMapping(Role.ADMIN) === false);
  check("DEPARTMENT_MANAGER is allowed", isGlobalRoleAllowedForMicrosoftMapping(Role.DEPARTMENT_MANAGER) === true);
  check("IT_AGENT is allowed", isGlobalRoleAllowedForMicrosoftMapping(Role.IT_AGENT) === true);
  check("USER is allowed", isGlobalRoleAllowedForMicrosoftMapping(Role.USER) === true);
  check("DIRECTOR is allowed", isGlobalRoleAllowedForMicrosoftMapping(Role.DIRECTOR) === true);

  console.log("\nTesting getMicrosoftMappingRoleOptions...\n");

  const roleOptions = getMicrosoftMappingRoleOptions();
  check("returns exactly 4 options (Administrator excluded, Director included)", roleOptions.length === 4);
  check("Administrator is never among the options", !roleOptions.some((opt) => opt.value === Role.ADMIN));
  check("Director is among the options", roleOptions.some((opt) => opt.value === Role.DIRECTOR));

  const departmentManagerOption = roleOptions.find((opt) => opt.value === Role.DEPARTMENT_MANAGER);
  check("Department Manager option has the exact /admin/roles label", departmentManagerOption?.label === "Department Manager");
  check(
    "Department Manager option has the exact /admin/roles description",
    departmentManagerOption?.description === "Manage department projects and goals"
  );
  check("Department Manager option's departmentRolePreview is Department Manager", departmentManagerOption?.departmentRolePreview === "Department Manager");

  const itAgentOption = roleOptions.find((opt) => opt.value === Role.IT_AGENT);
  check("IT Agent option has the exact /admin/roles label", itAgentOption?.label === "IT Agent");
  check("IT Agent option's departmentRolePreview is Agent / Assignee", itAgentOption?.departmentRolePreview === "Agent / Assignee");

  const userOption = roleOptions.find((opt) => opt.value === Role.USER);
  check("User option has the exact /admin/roles label", userOption?.label === "User");
  check("User option's departmentRolePreview is Requester", userOption?.departmentRolePreview === "Requester");

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
