import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";

/**
 * Permission keys whose loss could remove the last path to managing roles,
 * users, or the admin panel itself. `permission.manage` doesn't exist in
 * this codebase's permission catalog (see PERMISSIONS in prisma/seed.ts) —
 * deliberately not included since it isn't a real key to guard.
 */
export const CRITICAL_ADMIN_PERMISSION_KEYS = new Set(["admin.access", "role.manage", "user.manage"]);

/** Real Role enum values — the only roleKey strings a User's base `role` field (rather than customRoleId) can ever resolve to. */
const ROLE_ENUM_VALUES = new Set<string>(Object.values(Role));

/**
 * True if removing `permissionKey` from `roleKey` would leave NO active
 * user with effective access to that permission anywhere in the system.
 * Only ever true for CRITICAL_ADMIN_PERMISSION_KEYS — every other
 * permission returns false unconditionally, since losing e.g. ticket.delete
 * from one role is never a lockout risk no matter how many roles grant it.
 *
 * `hasPermission`'s `Role.ADMIN` bypass is hardcoded and checked BEFORE any
 * RolePermission lookup — so as long as at least one active User still has
 * that literal enum role (true after any normal seed — admin@kinsen.gr),
 * nothing this function guards can actually lock the system out, regardless
 * of RolePermission state. Only once that's not true does this check
 * whether some OTHER role still grants the permission to an active user,
 * via the exact two paths hasPermission itself resolves: an explicit
 * customRoleId, or the base enum `role` field used directly as a roleKey.
 */
export async function wouldOrphanCriticalPermission(roleKey: string, permissionKey: string): Promise<boolean> {
  if (!CRITICAL_ADMIN_PERMISSION_KEYS.has(permissionKey)) return false;

  const adminEnumUsers = await prisma.user.count({ where: { role: Role.ADMIN, isActive: true } });
  if (adminEnumUsers > 0) return false;

  const otherGrants = await prisma.rolePermission.findMany({
    where: { permission: { key: permissionKey }, roleKey: { not: roleKey } },
    select: { roleKey: true },
  });
  const otherRoleKeys = otherGrants.map((r) => r.roleKey);
  if (otherRoleKeys.length === 0) return true;

  const [viaCustomRole, viaEnumRole] = await Promise.all([
    prisma.user.count({ where: { isActive: true, customRole: { key: { in: otherRoleKeys }, isActive: true } } }),
    prisma.user.count({
      where: {
        isActive: true,
        customRoleId: null,
        role: { in: otherRoleKeys.filter((k) => ROLE_ENUM_VALUES.has(k)) as Role[] },
      },
    }),
  ]);
  return viaCustomRole + viaEnumRole === 0;
}

/**
 * True if disabling `roleKey` (CustomRole.isActive -> false) would orphan
 * critical admin access. For most roles this checks only the critical
 * permissions it currently grants (nothing to lose otherwise). For the
 * built-in "ADMIN" role specifically, the full critical set is always
 * re-verified regardless of its currently-granted rows — belt-and-suspenders
 * for the one role this matters most for, matching the explicit
 * "do not rely only on CustomRole rows" requirement.
 */
export async function wouldOrphanAdminAccessByDisablingRole(roleKey: string): Promise<boolean> {
  let keysToCheck: string[];

  if (roleKey === "ADMIN") {
    keysToCheck = [...CRITICAL_ADMIN_PERMISSION_KEYS];
  } else {
    const grantedCritical = await prisma.rolePermission.findMany({
      where: { roleKey, permission: { key: { in: [...CRITICAL_ADMIN_PERMISSION_KEYS] } } },
      include: { permission: { select: { key: true } } },
    });
    keysToCheck = grantedCritical.map((g) => g.permission.key);
  }

  for (const key of keysToCheck) {
    if (await wouldOrphanCriticalPermission(roleKey, key)) return true;
  }
  return false;
}
