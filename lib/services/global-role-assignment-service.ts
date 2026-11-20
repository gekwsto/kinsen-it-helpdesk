/**
 * Server-side validation for "assign this Global Role to this user" —
 * mirrors lib/services/department-membership-service.ts's
 * assertDepartmentRoleAssignable, with one deliberate inversion.
 *
 * Department Roles can safely fail OPEN on a missing built-in CustomRole row
 * (trust the DepartmentRole enum) because the
 * 20260812091426_backfill_builtin_department_roles migration guarantees all
 * 6 built-ins always exist — a missing row there is unreachable, defensive
 * only.
 *
 * Global Roles must NOT make that same guarantee: the whole point of this
 * fix is that a Role enum member (DIRECTOR) can legitimately have NO
 * mirrored CustomRole row — see the production evidence in the
 * 20260718160000_add_director_role migration (enum-only, no CustomRole
 * insert). So here a missing/inactive built-in CustomRole row is a REAL,
 * enforced "not currently assignable" state and this function fails CLOSED:
 * a request to assign a Role enum value with no active backing CustomRole
 * is rejected, exactly like a request to assign an unknown/inactive custom
 * role id.
 *
 * "Unchanged is never blocked": if the selection matches what's ALREADY
 * persisted on the target (`current`), the check is skipped entirely — an
 * existing user already on a ghost/disabled global role (built-in or
 * custom) remains readable/manageable/re-saveable without corruption; only
 * a genuinely NEW assignment is validated against the live catalogue.
 */
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, Prisma } from "@prisma/client";

type Db = typeof prisma | Prisma.TransactionClient;

export type GlobalRoleSelection = { role: Role; customRoleId?: null } | { role?: null; customRoleId: string };

export class GlobalRoleAssignmentError extends Error {
  constructor(
    public code: "ROLE_NOT_FOUND" | "ROLE_WRONG_SCOPE" | "ROLE_INACTIVE"
  ) {
    super(code);
    this.name = "GlobalRoleAssignmentError";
  }
}

export async function assertGlobalRoleAssignable(
  selection: GlobalRoleSelection,
  current: { role: Role; customRoleId: string | null } | null,
  db: Db = prisma
): Promise<void> {
  if (selection.customRoleId) {
    if (current?.customRoleId === selection.customRoleId) return; // unchanged — never blocked
    const role = await db.customRole.findUnique({ where: { id: selection.customRoleId } });
    if (!role) throw new GlobalRoleAssignmentError("ROLE_NOT_FOUND");
    if (role.scope === RoleScope.DEPARTMENT) throw new GlobalRoleAssignmentError("ROLE_WRONG_SCOPE");
    if (!role.isActive) throw new GlobalRoleAssignmentError("ROLE_INACTIVE");
    return;
  }

  const targetRole = selection.role!;
  // Unchanged check is on the `role` FIELD alone — independent of whether
  // `current` ALSO happens to have a customRoleId set. That combination is
  // normal (customRoleId is a separate, optional override; `role` is never
  // null) and is exactly what every caller that isn't touching the custom-
  // role dimension at all re-submits verbatim — e.g. the Block/Unblock
  // toggle (components/admin/user-management.tsx) sends `{ role: user.role,
  // isActive: !user.isActive }` with no `customRoleId` key, so this
  // function is entered with `selection = { role: data.role }` purely
  // because the request didn't mention a custom role, not because it's
  // asking to assign/clear one. Requiring `!current?.customRoleId` here
  // wrongly treated that as a genuinely NEW plain-role assignment for any
  // user who also has a customRoleId, so a user on a custom role whose
  // base `role` enum happens to be a ghost value (e.g. DIRECTOR — see this
  // file's own top comment) could never be re-saved/deactivated at all.
  if (current?.role === targetRole) return; // unchanged — never blocked

  const role = await db.customRole.findUnique({ where: { key: targetRole } });
  // Fail CLOSED, unlike the Department Role equivalent — a Role enum member
  // with no active, mirrored CustomRole row (e.g. ghost DIRECTOR) must not
  // become assignable merely because it's accepted by the Prisma enum.
  if (!role) throw new GlobalRoleAssignmentError("ROLE_NOT_FOUND");
  if (role.scope === RoleScope.DEPARTMENT) throw new GlobalRoleAssignmentError("ROLE_WRONG_SCOPE");
  if (!role.isActive) throw new GlobalRoleAssignmentError("ROLE_INACTIVE");
}
