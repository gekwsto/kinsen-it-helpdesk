import { prisma } from "@/lib/prisma";
import type { MicrosoftDepartmentMapping } from "@prisma/client";
import { DepartmentRole, MembershipSource, MicrosoftMappingSourceType } from "@prisma/client";
import type {
  MicrosoftIdentityClaims,
  MicrosoftMappingView,
  ResolvedMembership,
} from "@/types/department";

// Maps a MicrosoftDepartmentMapping.sourceType to the MembershipSource used
// on the resulting DepartmentMembership row — kept as an explicit table
// (not a naming convention) so the two enums can diverge safely later.
const SOURCE_TYPE_TO_MEMBERSHIP_SOURCE: Record<MicrosoftMappingSourceType, MembershipSource> = {
  [MicrosoftMappingSourceType.PROFILE_DEPARTMENT]: MembershipSource.MICROSOFT_DEPARTMENT,
  [MicrosoftMappingSourceType.ENTRA_GROUP]: MembershipSource.MICROSOFT_GROUP,
  [MicrosoftMappingSourceType.ENTRA_APP_ROLE]: MembershipSource.MICROSOFT_APP_ROLE,
};

// When the same department is reachable via more than one signal for the
// same login, the more administratively-deliberate signal wins: an app role
// requires an explicit assignment in Entra, a group is broader/self-service
// in many tenants, and a free-text profile field is the least trustworthy.
// This is an adjustable default — change the order here, nowhere else, if
// that judgment call should go the other way.
const SOURCE_TYPE_PRIORITY: Record<MicrosoftMappingSourceType, number> = {
  [MicrosoftMappingSourceType.ENTRA_APP_ROLE]: 3,
  [MicrosoftMappingSourceType.ENTRA_GROUP]: 2,
  [MicrosoftMappingSourceType.PROFILE_DEPARTMENT]: 1,
};

/**
 * Turns whatever Microsoft/Entra signals are present on `claims` into a
 * resolved set of (department, role) tuples, purely via a data lookup — no
 * department/group/role name is ever compared in code, only in
 * MicrosoftDepartmentMapping rows. Claims fields that aren't populated by
 * the current Auth.js provider config (department/groups/roles — see
 * MicrosoftIdentityClaims) simply contribute nothing; this resolves to an
 * empty array today until the provider requests those claims, which is a
 * safe no-op, not an error.
 */
export async function resolveDepartmentMemberships(
  claims: MicrosoftIdentityClaims
): Promise<ResolvedMembership[]> {
  const candidates: { sourceType: MicrosoftMappingSourceType; microsoftValue: string }[] = [];

  if (claims.department) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT, microsoftValue: claims.department });
  }
  for (const group of claims.groups ?? []) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.ENTRA_GROUP, microsoftValue: group });
  }
  for (const role of claims.roles ?? []) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.ENTRA_APP_ROLE, microsoftValue: role });
  }

  if (candidates.length === 0) return [];

  const matches = await prisma.microsoftDepartmentMapping.findMany({
    where: {
      isActive: true,
      department: { isActive: true },
      OR: candidates.map((c) => ({ sourceType: c.sourceType, microsoftValue: c.microsoftValue })),
    },
  });

  // Same department reachable via multiple signals -> keep the highest-priority one.
  const bestByDepartment = new Map<string, MicrosoftDepartmentMapping>();
  for (const match of matches) {
    const current = bestByDepartment.get(match.departmentId);
    if (!current || SOURCE_TYPE_PRIORITY[match.sourceType] > SOURCE_TYPE_PRIORITY[current.sourceType]) {
      bestByDepartment.set(match.departmentId, match);
    }
  }

  return Array.from(bestByDepartment.values()).map((m) => ({
    departmentId: m.departmentId,
    role: m.role,
    source: SOURCE_TYPE_TO_MEMBERSHIP_SOURCE[m.sourceType],
  }));
}

/**
 * Used by microsoft-department-sync-service.ts to decide whether the
 * auto-create-department path should even be considered — an explicit,
 * active PROFILE_DEPARTMENT mapping for this exact value always wins and
 * must be checked first.
 */
export async function hasActiveProfileDepartmentMapping(value: string): Promise<boolean> {
  const match = await prisma.microsoftDepartmentMapping.findFirst({
    where: {
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: value,
      isActive: true,
      department: { isActive: true },
    },
    select: { id: true },
  });
  return match !== null;
}

// ─── Admin CRUD (for the Phase 3 admin UI to call — not wired to any route yet) ──

function toView(
  m: MicrosoftDepartmentMapping & { department: { id: string; name: string; slug: string } }
): MicrosoftMappingView {
  return {
    id: m.id,
    sourceType: m.sourceType,
    microsoftValue: m.microsoftValue,
    departmentId: m.departmentId,
    role: m.role,
    isActive: m.isActive,
    department: m.department,
  };
}

export async function listMappings(): Promise<MicrosoftMappingView[]> {
  const rows = await prisma.microsoftDepartmentMapping.findMany({
    include: { department: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ sourceType: "asc" }, { microsoftValue: "asc" }],
  });
  return rows.map(toView);
}

export interface CreateMappingInput {
  sourceType: MicrosoftMappingSourceType;
  microsoftValue: string;
  departmentId: string;
  role?: DepartmentRole;
}

export async function createMapping(input: CreateMappingInput): Promise<MicrosoftDepartmentMapping> {
  return prisma.microsoftDepartmentMapping.create({
    data: {
      sourceType: input.sourceType,
      microsoftValue: input.microsoftValue,
      departmentId: input.departmentId,
      role: input.role ?? DepartmentRole.REQUESTER,
    },
  });
}

export interface UpdateMappingInput {
  sourceType?: MicrosoftMappingSourceType;
  microsoftValue?: string;
  departmentId?: string;
  role?: DepartmentRole;
  isActive?: boolean;
}

export async function updateMapping(id: string, patch: UpdateMappingInput): Promise<MicrosoftDepartmentMapping> {
  return prisma.microsoftDepartmentMapping.update({ where: { id }, data: patch });
}

export async function deleteMapping(id: string): Promise<void> {
  await prisma.microsoftDepartmentMapping.delete({ where: { id } });
}
