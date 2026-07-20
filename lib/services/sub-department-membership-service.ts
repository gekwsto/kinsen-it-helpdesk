import { prisma } from "@/lib/prisma";
import type { SubDepartmentMembership } from "@prisma/client";
import { MembershipSource } from "@prisma/client";
import { getMembership } from "@/lib/services/department-membership-service";

// Mirrors department-membership-service.ts's shape, but for
// SubDepartmentMembership — deliberately no `role` (see the model's
// doc-comment in prisma/schema.prisma): a sub-department is an
// organizational grouping for filtering, not a second permission tier.

export interface SubDepartmentMembershipView {
  id: string;
  userId: string;
  subDepartmentId: string;
  departmentId: string;
  source: MembershipSource;
  isActive: boolean;
  subDepartment: { id: string; name: string };
}

export interface SubDepartmentMembershipAdminView {
  id: string;
  userId: string;
  subDepartmentId: string;
  departmentId: string;
  source: MembershipSource;
  isActive: boolean;
  user: { id: string; name: string | null; email: string; image: string | null };
}

const subDeptSelect = { id: true, name: true } as const;
const memberUserSelect = { id: true, name: true, email: true, image: true } as const;

/** Bare active subDepartmentIds for a user — the lightweight shape nav-visibility and ticket-sharing checks need, without the joined subDepartment name. */
export async function getUserSubDepartmentIds(userId: string): Promise<string[]> {
  const rows = await prisma.subDepartmentMembership.findMany({
    where: { userId, isActive: true, subDepartment: { isActive: true } },
    select: { subDepartmentId: true },
  });
  return rows.map((r) => r.subDepartmentId);
}

export async function getUserSubDepartmentMemberships(userId: string): Promise<SubDepartmentMembershipView[]> {
  const rows = await prisma.subDepartmentMembership.findMany({
    where: { userId, isActive: true, subDepartment: { isActive: true } },
    include: { subDepartment: { select: subDeptSelect } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    subDepartmentId: m.subDepartmentId,
    departmentId: m.departmentId,
    source: m.source,
    isActive: m.isActive,
    subDepartment: m.subDepartment,
  }));
}

/** All memberships (active + inactive) for a sub-department — admin visibility, not an authorization check. */
export async function getSubDepartmentMemberships(subDepartmentId: string): Promise<SubDepartmentMembershipAdminView[]> {
  const rows = await prisma.subDepartmentMembership.findMany({
    where: { subDepartmentId },
    include: { user: { select: memberUserSelect } },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    subDepartmentId: m.subDepartmentId,
    departmentId: m.departmentId,
    source: m.source,
    isActive: m.isActive,
    user: m.user,
  }));
}

export async function getSubDepartmentMembership(userId: string, subDepartmentId: string): Promise<SubDepartmentMembership | null> {
  return prisma.subDepartmentMembership.findFirst({
    where: { userId, subDepartmentId, isActive: true, subDepartment: { isActive: true } },
  });
}

export type GrantSubDepartmentMembershipResult =
  | { ok: true; membership: SubDepartmentMembership }
  | { ok: false; reason: "subdepartment_not_found" | "subdepartment_inactive" | "user_not_in_department" };

/**
 * Grants (or reactivates) a sub-department membership — always source
 * MANUAL, same protection-from-sync convention as
 * grantManualMembership (there's no Microsoft->SubDepartment sync in this
 * phase, but keeping the field consistent costs nothing and matches the
 * existing pattern everywhere else in this codebase).
 *
 * Requires an ACTIVE parent DepartmentMembership first (per the explicit
 * "prefer block for safety" decision) — never silently creates one.
 */
export async function grantSubDepartmentMembership(
  userId: string,
  subDepartmentId: string
): Promise<GrantSubDepartmentMembershipResult> {
  const subDepartment = await prisma.subDepartment.findUnique({ where: { id: subDepartmentId } });
  if (!subDepartment) return { ok: false, reason: "subdepartment_not_found" };
  if (!subDepartment.isActive) return { ok: false, reason: "subdepartment_inactive" };

  const departmentMembership = await getMembership(userId, subDepartment.departmentId);
  if (!departmentMembership) return { ok: false, reason: "user_not_in_department" };

  const membership = await prisma.subDepartmentMembership.upsert({
    where: { userId_subDepartmentId: { userId, subDepartmentId } },
    update: { isActive: true, source: MembershipSource.MANUAL, departmentId: subDepartment.departmentId },
    create: { userId, subDepartmentId, departmentId: subDepartment.departmentId, source: MembershipSource.MANUAL },
  });
  return { ok: true, membership };
}

/** Soft-revoke — never deletes, so ticket/project/activity history referencing the user is unaffected. */
export async function revokeSubDepartmentMembership(id: string): Promise<SubDepartmentMembership> {
  return prisma.subDepartmentMembership.update({ where: { id }, data: { isActive: false } });
}
