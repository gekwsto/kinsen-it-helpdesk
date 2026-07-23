import { prisma } from "@/lib/prisma";
import type { MicrosoftDepartmentMapping } from "@prisma/client";
import { DepartmentRole, MembershipSource, MicrosoftMappingSourceType, Role } from "@prisma/client";
import {
  isDepartmentRoleAllowedForMicrosoftMapping,
  isGlobalRoleAllowedForMicrosoftMapping,
} from "@/lib/services/department-role-translation";
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
  [MicrosoftMappingSourceType.PROFILE_JOB_TITLE]: MembershipSource.MICROSOFT_JOB_TITLE,
  [MicrosoftMappingSourceType.ENTRA_GROUP]: MembershipSource.MICROSOFT_GROUP,
  [MicrosoftMappingSourceType.ENTRA_APP_ROLE]: MembershipSource.MICROSOFT_APP_ROLE,
};

// When the same department is reachable via more than one signal for the
// same login, the more administratively-deliberate signal wins: an app role
// requires an explicit assignment in Entra, a group is broader/self-service
// in many tenants, a job title is more specific than a bare department, and
// a free-text department field is the least trustworthy/most generic. This
// is an adjustable default — change the order here, nowhere else, if that
// judgment call should go the other way. Shared by both
// resolveDepartmentMemberships (per-department) and
// resolvePrimaryMicrosoftMapping (single overall winner, for global role).
const SOURCE_TYPE_PRIORITY: Record<MicrosoftMappingSourceType, number> = {
  [MicrosoftMappingSourceType.ENTRA_APP_ROLE]: 4,
  [MicrosoftMappingSourceType.ENTRA_GROUP]: 3,
  [MicrosoftMappingSourceType.PROFILE_JOB_TITLE]: 2,
  [MicrosoftMappingSourceType.PROFILE_DEPARTMENT]: 1,
};

function buildCandidates(
  claims: MicrosoftIdentityClaims
): { sourceType: MicrosoftMappingSourceType; microsoftValue: string }[] {
  const candidates: { sourceType: MicrosoftMappingSourceType; microsoftValue: string }[] = [];

  if (claims.department) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT, microsoftValue: claims.department });
  }
  if (claims.jobTitle) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE, microsoftValue: claims.jobTitle });
  }
  for (const group of claims.groups ?? []) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.ENTRA_GROUP, microsoftValue: group });
  }
  for (const role of claims.roles ?? []) {
    candidates.push({ sourceType: MicrosoftMappingSourceType.ENTRA_APP_ROLE, microsoftValue: role });
  }
  return candidates;
}

async function findActiveMappingsForClaims(claims: MicrosoftIdentityClaims): Promise<MicrosoftDepartmentMapping[]> {
  const candidates = buildCandidates(claims);
  if (candidates.length === 0) return [];

  return prisma.microsoftDepartmentMapping.findMany({
    where: {
      isActive: true,
      department: { isActive: true },
      // Job title matches are trimmed + case-insensitive (explicit design
      // choice — see docs/microsoft-graph-directory-sync.md); every other
      // source type stays exact-match, unchanged from today.
      OR: candidates.map((c) =>
        c.sourceType === MicrosoftMappingSourceType.PROFILE_JOB_TITLE
          ? { sourceType: c.sourceType, microsoftValue: { equals: c.microsoftValue, mode: "insensitive" as const } }
          : { sourceType: c.sourceType, microsoftValue: c.microsoftValue }
      ),
    },
  });
}

/**
 * Turns whatever Microsoft/Entra signals are present on `claims` into a
 * resolved set of (department, role) tuples, purely via a data lookup — no
 * department/group/role name is ever compared in code, only in
 * MicrosoftDepartmentMapping rows. Claims fields that aren't populated by
 * the current Auth.js provider config (department/groups/roles — see
 * MicrosoftIdentityClaims) simply contribute nothing; this resolves to an
 * empty array today until the provider requests those claims, which is a
 * safe no-op, not an error.
 *
 * MicrosoftDepartmentMapping stores the GLOBAL Role (`role`, matches
 * /admin/roles) and the DepartmentRole (`departmentRole`) independently — an
 * admin picks both explicitly in the mapping form, so this reads
 * `departmentRole` directly rather than deriving it from `role`.
 */
export async function resolveDepartmentMemberships(
  claims: MicrosoftIdentityClaims
): Promise<ResolvedMembership[]> {
  const matches = await findActiveMappingsForClaims(claims);

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
    role: m.departmentRole,
    source: SOURCE_TYPE_TO_MEMBERSHIP_SOURCE[m.sourceType],
  }));
}

/**
 * Same candidate lookup as resolveDepartmentMemberships, but returns the
 * single highest-priority mapping ROW across all matches (not grouped by
 * department) — used to drive the user's GLOBAL role, which must be one
 * decision, not one per department. Returns null if no active mapping
 * matched anything this login. Ties (same priority) break deterministically
 * on microsoftValue so behavior never depends on DB row ordering.
 */
export async function resolvePrimaryMicrosoftMapping(
  claims: MicrosoftIdentityClaims
): Promise<MicrosoftDepartmentMapping | null> {
  const matches = await findActiveMappingsForClaims(claims);
  if (matches.length === 0) return null;

  return matches.reduce((best, current) => {
    const bestPriority = SOURCE_TYPE_PRIORITY[best.sourceType];
    const currentPriority = SOURCE_TYPE_PRIORITY[current.sourceType];
    if (currentPriority > bestPriority) return current;
    if (currentPriority < bestPriority) return best;
    return current.microsoftValue.localeCompare(best.microsoftValue) < 0 ? current : best;
  });
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

// ─── Admin CRUD (wired to app/api/admin/microsoft-mappings/**) ──

function toView(
  m: MicrosoftDepartmentMapping & { department: { id: string; name: string; slug: string } }
): MicrosoftMappingView {
  return {
    id: m.id,
    sourceType: m.sourceType,
    microsoftValue: m.microsoftValue,
    departmentId: m.departmentId,
    role: m.role,
    departmentRole: m.departmentRole,
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

// Thrown by createMapping/updateMapping so API routes can map each distinct
// failure to its own JSON error code instead of a single generic 400/404.
export class MicrosoftMappingValidationError extends Error {
  constructor(public code: "ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING" | "DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING" | "DEPARTMENT_NOT_FOUND") {
    super(code);
    this.name = "MicrosoftMappingValidationError";
  }
}

async function assertDepartmentExists(departmentId: string): Promise<void> {
  const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
  if (!department) throw new MicrosoftMappingValidationError("DEPARTMENT_NOT_FOUND");
}

export interface CreateMappingInput {
  sourceType: MicrosoftMappingSourceType;
  microsoftValue: string;
  departmentId: string;
  /** Global Role (matches /admin/roles) — never DepartmentRole. See department-role-translation.ts. */
  role?: Role;
  /** DepartmentRole granted on the resulting DepartmentMembership — independent of `role` above. */
  departmentRole: DepartmentRole;
}

export async function createMapping(input: CreateMappingInput): Promise<MicrosoftDepartmentMapping> {
  const role = input.role ?? Role.USER;
  if (!isGlobalRoleAllowedForMicrosoftMapping(role)) {
    throw new MicrosoftMappingValidationError("ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  if (!isDepartmentRoleAllowedForMicrosoftMapping(input.departmentRole)) {
    throw new MicrosoftMappingValidationError("DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  await assertDepartmentExists(input.departmentId);
  return prisma.microsoftDepartmentMapping.create({
    data: {
      sourceType: input.sourceType,
      microsoftValue: input.microsoftValue,
      departmentId: input.departmentId,
      role,
      departmentRole: input.departmentRole,
    },
  });
}

export interface UpdateMappingInput {
  sourceType?: MicrosoftMappingSourceType;
  microsoftValue?: string;
  departmentId?: string;
  /** Global Role (matches /admin/roles) — never DepartmentRole. See department-role-translation.ts. */
  role?: Role;
  /** DepartmentRole granted on the resulting DepartmentMembership — independent of `role` above. */
  departmentRole?: DepartmentRole;
  isActive?: boolean;
}

export async function updateMapping(id: string, patch: UpdateMappingInput): Promise<MicrosoftDepartmentMapping> {
  if (patch.role !== undefined && !isGlobalRoleAllowedForMicrosoftMapping(patch.role)) {
    throw new MicrosoftMappingValidationError("ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  if (patch.departmentRole !== undefined && !isDepartmentRoleAllowedForMicrosoftMapping(patch.departmentRole)) {
    throw new MicrosoftMappingValidationError("DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  if (patch.departmentId !== undefined) {
    await assertDepartmentExists(patch.departmentId);
  }
  return prisma.microsoftDepartmentMapping.update({ where: { id }, data: patch });
}

export async function deleteMapping(id: string): Promise<void> {
  await prisma.microsoftDepartmentMapping.delete({ where: { id } });
}
