import type { Prisma } from "@prisma/client";

/**
 * Builds the exact where/orderBy/skip/take/select Prisma args
 * app/(main)/admin/users/page.tsx uses — pulled out into its own pure
 * function (no DB call here) so both the real page and
 * scripts/test-admin-users-pagination.ts exercise the identical query
 * construction, rather than a test re-implementing (and risking silently
 * diverging from) the real logic.
 */
export interface AdminUserListQueryInput {
  departmentId: string | "all";
  search: string;
  page: number;
  pageSize: number;
}

// Only the fields components/admin/user-management.tsx actually renders —
// deliberately `select`, not `include` (which returns every scalar column
// with no filtering, e.g. passwordHash). Selecting only what's displayed
// also means passwordHash is never fetched into the Server Component's
// memory in the first place, let alone serialized across the Server-
// >Client Component RSC payload the way an `include`-only query's full row
// shape previously was.
export const ADMIN_USER_LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  isActive: true,
  createdAt: true,
  microsoftUserId: true,
  lastMicrosoftSyncAt: true,
  globalRoleSource: true,
  globalRoleUpdatedAt: true,
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  customRole: { select: { id: true, key: true, name: true } },
  departmentMemberships: {
    select: {
      id: true,
      departmentId: true,
      role: true,
      source: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
      department: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  subDepartmentMemberships: {
    where: { isActive: true },
    select: {
      id: true,
      subDepartment: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  globalRoleMicrosoftMapping: {
    select: { microsoftValue: true, department: { select: { name: true } } },
  },
} satisfies Prisma.UserSelect;

/**
 * "All" (default) = every user, including legacy-null-department and
 * memberless ones. A specific department = active DepartmentMembership in
 * it OR the legacy User.departmentId field — matched via OR on the same
 * findMany call, so a user row is never duplicated (no fan-out join).
 * AND-ed alongside the search condition (not merged into one OR), so
 * "department X AND matches search" is what's actually queried.
 */
export function buildAdminUserListWhere(departmentId: string | "all", search: string): Prisma.UserWhereInput {
  const andConditions: Prisma.UserWhereInput[] = [];
  if (departmentId !== "all") {
    andConditions.push({
      OR: [
        { departmentMemberships: { some: { departmentId, isActive: true } } },
        { departmentId },
      ],
    });
  }
  const trimmedSearch = search.trim();
  if (trimmedSearch) {
    andConditions.push({
      OR: [
        { name: { contains: trimmedSearch, mode: "insensitive" } },
        { email: { contains: trimmedSearch, mode: "insensitive" } },
      ],
    });
  }
  return andConditions.length > 0 ? { AND: andConditions } : {};
}

// Existing business ordering (name) preserved verbatim, with `id` appended
// as a deterministic tie-breaker — `name` is nullable and far from unique,
// so without it, rows sharing a name/null could swap positions between
// requests and a user could see duplicates or gaps across pages.
export const ADMIN_USER_LIST_ORDER_BY: Prisma.UserOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];

export function buildAdminUserListQueryArgs(input: AdminUserListQueryInput) {
  const where = buildAdminUserListWhere(input.departmentId, input.search);
  return {
    where,
    orderBy: ADMIN_USER_LIST_ORDER_BY,
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
    select: ADMIN_USER_LIST_SELECT,
  };
}
