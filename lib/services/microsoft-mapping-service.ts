import { prisma } from "@/lib/prisma";
import type { MicrosoftDepartmentMapping } from "@prisma/client";
import { DepartmentRole, MembershipSource, MicrosoftMappingSourceType, Role, RoleScope } from "@prisma/client";
import {
  isDepartmentRoleAllowedForMicrosoftMapping,
  isGlobalRoleAllowedForMicrosoftMapping,
} from "@/lib/services/department-role-translation";
import { normalizeJobTitleValue } from "@/lib/services/microsoft-directory-service";
import { ORGANIZATION_SYNC_ALLOWED_DOMAIN } from "@/lib/services/organization-directory-eligibility-service";
import type {
  MicrosoftIdentityClaims,
  MicrosoftMappingView,
  ResolvedMembership,
} from "@/types/department";

// FIND-006 (docs/roadmap-handoff-register.md): only PROFILE_JOB_TITLE is
// REALLY domain-scoped — see MicrosoftDepartmentMapping's own schema
// comment in prisma/schema.prisma for the full per-sourceType reasoning
// (ENTRA_GROUP/ENTRA_APP_ROLE have no domain semantics at all; PROFILE_DEPARTMENT
// stays global for now, no reported multi-domain need). This is the ONE
// place that decides which source types require a real domain vs always use
// the "" global sentinel — every other function in this file reads this,
// never re-derives it.
const DOMAIN_SCOPED_SOURCE_TYPES: ReadonlySet<MicrosoftMappingSourceType> = new Set([
  MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
]);

export function isDomainScopedMicrosoftMappingSourceType(sourceType: MicrosoftMappingSourceType): boolean {
  return DOMAIN_SCOPED_SOURCE_TYPES.has(sourceType);
}

const GLOBAL_MAPPING_DOMAIN = "";

/**
 * The one normalization function per sourceType, used identically at
 * mapping create/update time (below) and at candidate-matching time
 * (buildCandidates) — so a stored row and an incoming Microsoft signal are
 * always compared the exact same way. PROFILE_JOB_TITLE reuses
 * normalizeJobTitleValue (microsoft-directory-service.ts) — the SAME
 * function the discovery catalog (MicrosoftDirectoryJobTitleValue) already
 * uses, so a discovered value and a configured mapping always agree on
 * whether they're "the same" title. Every other sourceType is an exact,
 * untouched copy — see MicrosoftDepartmentMapping's schema comment for why.
 */
function normalizeMicrosoftMappingValue(sourceType: MicrosoftMappingSourceType, microsoftValue: string): string {
  return sourceType === MicrosoftMappingSourceType.PROFILE_JOB_TITLE ? normalizeJobTitleValue(microsoftValue) : microsoftValue;
}

/** Domain a mapping row of this sourceType should be stored/matched under — "" (global sentinel) unless the sourceType is domain-scoped, in which case a real domain is required. */
function resolveMappingDomain(sourceType: MicrosoftMappingSourceType, domain: string | null | undefined): string {
  if (!isDomainScopedMicrosoftMappingSourceType(sourceType)) return GLOBAL_MAPPING_DOMAIN;
  const trimmed = domain?.trim().toLowerCase();
  if (!trimmed) throw new MicrosoftMappingValidationError("DOMAIN_REQUIRED_FOR_SOURCE_TYPE");
  return trimmed;
}

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

interface MappingCandidate {
  sourceType: MicrosoftMappingSourceType;
  /** "" for a global-source-type candidate; a real domain for a domain-scoped one (see resolveMappingDomain). Never re-derived downstream — computed once, here. */
  domain: string;
  normalizedMicrosoftValue: string;
}

/**
 * FIND-006: `domain` is the caller's already-resolved, ALREADY-ELIGIBLE
 * Entra domain for this login/sync (e.g. "kinsen.gr") — see
 * organization-directory-eligibility-service.ts's extractEmailDomain,
 * called by both microsoft-department-sync-service.ts (login) and
 * organization-directory-sync-service.ts (full sync) on the SAME
 * eligibility result that already gated organizational placement. Passed
 * explicitly (never re-derived from claims.email here) so this function
 * never has to duplicate eligibility logic and can never silently disagree
 * with it. `null` means "no eligible domain for this signal" (e.g. this
 * login didn't pass organization-sync eligibility at all) — in that case NO
 * PROFILE_JOB_TITLE candidate is built at all (a domain-scoped source type
 * can never match without a real domain), while every domain-agnostic
 * candidate (department/group/role) is still built exactly as before —
 * those never depended on eligibility to begin with.
 */
function buildCandidates(claims: MicrosoftIdentityClaims, domain: string | null): MappingCandidate[] {
  const candidates: MappingCandidate[] = [];

  if (claims.department) {
    candidates.push({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      domain: GLOBAL_MAPPING_DOMAIN,
      normalizedMicrosoftValue: normalizeMicrosoftMappingValue(MicrosoftMappingSourceType.PROFILE_DEPARTMENT, claims.department),
    });
  }
  if (claims.jobTitle && domain) {
    candidates.push({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      domain,
      normalizedMicrosoftValue: normalizeMicrosoftMappingValue(MicrosoftMappingSourceType.PROFILE_JOB_TITLE, claims.jobTitle),
    });
  }
  for (const group of claims.groups ?? []) {
    candidates.push({
      sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
      domain: GLOBAL_MAPPING_DOMAIN,
      normalizedMicrosoftValue: normalizeMicrosoftMappingValue(MicrosoftMappingSourceType.ENTRA_GROUP, group),
    });
  }
  for (const role of claims.roles ?? []) {
    candidates.push({
      sourceType: MicrosoftMappingSourceType.ENTRA_APP_ROLE,
      domain: GLOBAL_MAPPING_DOMAIN,
      normalizedMicrosoftValue: normalizeMicrosoftMappingValue(MicrosoftMappingSourceType.ENTRA_APP_ROLE, role),
    });
  }
  return candidates;
}

async function findActiveMappingsForClaims(claims: MicrosoftIdentityClaims, domain: string | null): Promise<MicrosoftDepartmentMapping[]> {
  const candidates = buildCandidates(claims, domain);
  if (candidates.length === 0) return [];

  // Uniform shape for every sourceType now — no per-source-type branching
  // needed here anymore (case-insensitivity for job titles is already baked
  // into normalizedMicrosoftValue above, computed once, not at query time).
  return prisma.microsoftDepartmentMapping.findMany({
    where: {
      isActive: true,
      department: { isActive: true },
      OR: candidates.map((c) => ({ sourceType: c.sourceType, domain: c.domain, normalizedMicrosoftValue: c.normalizedMicrosoftValue })),
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
 *
 * `domain` (FIND-006): the caller's already-resolved eligible Entra domain
 * for this signal (or `null`) — see buildCandidates' own doc comment. Both
 * call sites (full sync, first login) pass the exact same
 * extractEmailDomain(eligibility.matchedEmail) value used for organizational
 * placement, so this can never disagree with eligibility.
 */
export async function resolveDepartmentMemberships(
  claims: MicrosoftIdentityClaims,
  domain: string | null
): Promise<ResolvedMembership[]> {
  const matches = await findActiveMappingsForClaims(claims, domain);

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
    // Custom DEPARTMENT/BOTH-scope role this mapping grants, or null for a
    // plain built-in DepartmentRole — see MicrosoftDepartmentMapping's
    // departmentCustomRoleId schema comment. Read straight off the mapping
    // row, same as `role` above; syncDepartmentMemberships
    // (department-membership-service.ts) is the only writer of
    // DepartmentMembership.customRoleId from this value.
    customRoleId: m.departmentCustomRoleId ?? null,
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
 *
 * `domain` — same FIND-006 parameter as resolveDepartmentMemberships above;
 * see its doc comment.
 */
export async function resolvePrimaryMicrosoftMapping(
  claims: MicrosoftIdentityClaims,
  domain: string | null
): Promise<MicrosoftDepartmentMapping | null> {
  const matches = await findActiveMappingsForClaims(claims, domain);
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

type MappingRowWithRelations = MicrosoftDepartmentMapping & {
  department: { id: string; name: string; slug: string };
  globalCustomRole: { id: string; name: string; isActive: boolean } | null;
  departmentCustomRole: { id: string; name: string; isActive: boolean } | null;
};

function toView(m: MappingRowWithRelations): MicrosoftMappingView {
  return {
    id: m.id,
    sourceType: m.sourceType,
    microsoftValue: m.microsoftValue,
    domain: m.domain,
    departmentId: m.departmentId,
    role: m.role,
    globalCustomRoleId: m.globalCustomRoleId,
    globalCustomRole: m.globalCustomRole,
    departmentRole: m.departmentRole,
    departmentCustomRoleId: m.departmentCustomRoleId,
    departmentCustomRole: m.departmentCustomRole,
    isActive: m.isActive,
    department: m.department,
  };
}

const mappingRelationsInclude = {
  department: { select: { id: true, name: true, slug: true } },
  globalCustomRole: { select: { id: true, name: true, isActive: true } },
  departmentCustomRole: { select: { id: true, name: true, isActive: true } },
} as const;

export async function listMappings(): Promise<MicrosoftMappingView[]> {
  const rows = await prisma.microsoftDepartmentMapping.findMany({
    include: mappingRelationsInclude,
    orderBy: [{ sourceType: "asc" }, { microsoftValue: "asc" }],
  });
  return rows.map(toView);
}

// Thrown by createMapping/updateMapping so API routes can map each distinct
// failure to its own JSON error code instead of a single generic 400/404.
export class MicrosoftMappingValidationError extends Error {
  constructor(
    public code:
      | "ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING"
      | "DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING"
      | "DEPARTMENT_NOT_FOUND"
      // FIND-006: a domain-scoped sourceType (today, only PROFILE_JOB_TITLE)
      // was given no domain at all.
      | "DOMAIN_REQUIRED_FOR_SOURCE_TYPE"
      // FIND-006: a domain-scoped sourceType was given a domain that isn't
      // in organization-directory-eligibility-service.ts's allowed-domain
      // set — today that set is exactly one domain (ORGANIZATION_SYNC_ALLOWED_DOMAIN),
      // so this rejects any OTHER domain string, keeping "only kinsen.gr is
      // enabled" enforced at the mapping layer too, not just at sync/login
      // eligibility.
      | "DOMAIN_NOT_ALLOWED"
      // globalCustomRoleId/departmentCustomRoleId type-safety — enforced here
      // (not just hidden by dropdown filtering client-side), so a direct API
      // call can never smuggle in a wrong-scope or built-in role id:
      | "GLOBAL_CUSTOM_ROLE_NOT_FOUND"
      // Wrong scope (DEPARTMENT-only) OR a built-in role's id sent through
      // this field — built-ins are always represented via the plain `role`
      // enum, never via globalCustomRoleId, so there is exactly one way to
      // represent each built-in role, never two.
      | "GLOBAL_CUSTOM_ROLE_INVALID"
      // Only enforced when this id is a NEW assignment (create, or an update
      // that actually changes the id) — see assertGlobalCustomRoleEligible's
      // own comment for why an already-referenced-but-now-inactive role is
      // NOT rejected merely by being left unchanged.
      | "GLOBAL_CUSTOM_ROLE_INACTIVE"
      | "DEPARTMENT_CUSTOM_ROLE_NOT_FOUND"
      | "DEPARTMENT_CUSTOM_ROLE_INVALID"
      | "DEPARTMENT_CUSTOM_ROLE_INACTIVE"
  ) {
    super(code);
    this.name = "MicrosoftMappingValidationError";
  }
}

async function assertDepartmentExists(departmentId: string): Promise<void> {
  const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
  if (!department) throw new MicrosoftMappingValidationError("DEPARTMENT_NOT_FOUND");
}

/**
 * Validates a `globalCustomRoleId` the client wants this mapping to grant.
 * Enforced server-side (never just hidden by dropdown filtering) per the
 * same "backend is authoritative" rule createMapping/updateMapping already
 * apply to `role`/`departmentRole` above:
 *  - must exist,
 *  - must be scope GLOBAL or BOTH (never a DEPARTMENT-only role — this is
 *    the type-safety guard against a client sending a department role id in
 *    the global-role slot),
 *  - must NOT be isBuiltIn (built-in roles are always represented via the
 *    plain `role` enum column, so there is exactly one way to reference
 *    each of them, never a redundant second path that could disagree with
 *    the ADMIN-exclusion check below),
 *  - must be active — but ONLY when this id is a genuinely NEW assignment
 *    (`currentId !== customRoleId`). Re-saving a mapping without touching
 *    its already-stored (now possibly deactivated) custom role must never
 *    fail — see the "current selection that becomes ineligible" requirement
 *    (an admin editing unrelated fields on an old mapping isn't required to
 *    also resolve a stale role reference in the same save).
 */
async function assertGlobalCustomRoleEligible(customRoleId: string, currentId: string | null): Promise<void> {
  const role = await prisma.customRole.findUnique({ where: { id: customRoleId } });
  if (!role) throw new MicrosoftMappingValidationError("GLOBAL_CUSTOM_ROLE_NOT_FOUND");
  if (role.isBuiltIn || role.scope === RoleScope.DEPARTMENT) {
    throw new MicrosoftMappingValidationError("GLOBAL_CUSTOM_ROLE_INVALID");
  }
  if (customRoleId !== currentId && !role.isActive) {
    throw new MicrosoftMappingValidationError("GLOBAL_CUSTOM_ROLE_INACTIVE");
  }
}

/** Department-scoped mirror of assertGlobalCustomRoleEligible above — see its doc comment for the full reasoning, identical shape. */
async function assertDepartmentCustomRoleEligible(customRoleId: string, currentId: string | null): Promise<void> {
  const role = await prisma.customRole.findUnique({ where: { id: customRoleId } });
  if (!role) throw new MicrosoftMappingValidationError("DEPARTMENT_CUSTOM_ROLE_NOT_FOUND");
  if (role.isBuiltIn || role.scope === RoleScope.GLOBAL) {
    throw new MicrosoftMappingValidationError("DEPARTMENT_CUSTOM_ROLE_INVALID");
  }
  if (customRoleId !== currentId && !role.isActive) {
    throw new MicrosoftMappingValidationError("DEPARTMENT_CUSTOM_ROLE_INACTIVE");
  }
}

/**
 * FIND-006: computes the actual `domain`/`normalizedMicrosoftValue` to
 * persist for a mapping row, and validates a domain-scoped sourceType's
 * domain against the allowed-domain set. The ONLY place createMapping/
 * updateMapping derive these two columns — never trust a client-supplied
 * normalizedMicrosoftValue (there isn't one in the public input shape at
 * all) and never silently accept a domain for a global sourceType (ignored,
 * not merely unused, so a stray client-sent domain on e.g. an ENTRA_GROUP
 * mapping can never accidentally scope it).
 */
function resolveMappingIdentity(
  sourceType: MicrosoftMappingSourceType,
  microsoftValue: string,
  domainInput: string | null | undefined
): { domain: string; normalizedMicrosoftValue: string } {
  if (!isDomainScopedMicrosoftMappingSourceType(sourceType)) {
    return { domain: GLOBAL_MAPPING_DOMAIN, normalizedMicrosoftValue: normalizeMicrosoftMappingValue(sourceType, microsoftValue) };
  }
  const domain = resolveMappingDomain(sourceType, domainInput);
  if (domain !== ORGANIZATION_SYNC_ALLOWED_DOMAIN) {
    throw new MicrosoftMappingValidationError("DOMAIN_NOT_ALLOWED");
  }
  return { domain, normalizedMicrosoftValue: normalizeMicrosoftMappingValue(sourceType, microsoftValue) };
}

export interface CreateMappingInput {
  sourceType: MicrosoftMappingSourceType;
  microsoftValue: string;
  departmentId: string;
  /** Global Role (matches /admin/roles) — never DepartmentRole. See department-role-translation.ts. Ignored (forced to the placeholder USER) when globalCustomRoleId is set. */
  role?: Role;
  /** Custom GLOBAL/BOTH-scope role (CustomRole, isBuiltIn: false) this mapping grants instead of a built-in `role` — see MicrosoftDepartmentMapping's schema comment. At most one of role/globalCustomRoleId is meaningful; if both are sent, globalCustomRoleId wins and `role` is ignored. */
  globalCustomRoleId?: string | null;
  /** DepartmentRole granted on the resulting DepartmentMembership — independent of `role` above. Ignored (forced to the placeholder VIEWER) when departmentCustomRoleId is set. */
  departmentRole?: DepartmentRole;
  /** Custom DEPARTMENT/BOTH-scope role this mapping grants instead of a built-in `departmentRole` — same relationship as globalCustomRoleId above. */
  departmentCustomRoleId?: string | null;
  /** Required (and validated against the allowed-domain set) when sourceType is domain-scoped (today: PROFILE_JOB_TITLE only) — ignored entirely for every other sourceType. See isDomainScopedMicrosoftMappingSourceType. */
  domain?: string;
}

/**
 * Resolves the GLOBAL role half of a create/update: either a custom role id
 * (validated via assertGlobalCustomRoleEligible) or the built-in `role` enum
 * (validated via the existing ADMIN-exclusion rule) — never both stored at
 * once. Mirrors grantManualMembership's exact placeholder convention
 * (lib/services/department-membership-service.ts): when a custom role is
 * granted, the enum column becomes a required-but-unused placeholder, never
 * whatever raw value the caller happened to send alongside it.
 */
async function resolveGlobalRoleAssignment(
  role: Role | undefined,
  globalCustomRoleId: string | null | undefined,
  currentGlobalCustomRoleId: string | null
): Promise<{ role: Role; globalCustomRoleId: string | null }> {
  if (globalCustomRoleId) {
    await assertGlobalCustomRoleEligible(globalCustomRoleId, currentGlobalCustomRoleId);
    return { role: Role.USER, globalCustomRoleId };
  }
  const resolvedRole = role ?? Role.USER;
  if (!isGlobalRoleAllowedForMicrosoftMapping(resolvedRole)) {
    throw new MicrosoftMappingValidationError("ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  return { role: resolvedRole, globalCustomRoleId: null };
}

/** Department-scoped mirror of resolveGlobalRoleAssignment above — see its doc comment. `departmentRole` has no implicit default (an explicit choice is required — enforced by createMicrosoftMappingSchema's refine, not repeated here). */
async function resolveDepartmentRoleAssignment(
  departmentRole: DepartmentRole | undefined,
  departmentCustomRoleId: string | null | undefined,
  currentDepartmentCustomRoleId: string | null
): Promise<{ departmentRole: DepartmentRole; departmentCustomRoleId: string | null }> {
  if (departmentCustomRoleId) {
    await assertDepartmentCustomRoleEligible(departmentCustomRoleId, currentDepartmentCustomRoleId);
    return { departmentRole: DepartmentRole.VIEWER, departmentCustomRoleId };
  }
  const resolvedRole = departmentRole ?? DepartmentRole.VIEWER;
  if (!isDepartmentRoleAllowedForMicrosoftMapping(resolvedRole)) {
    throw new MicrosoftMappingValidationError("DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING");
  }
  return { departmentRole: resolvedRole, departmentCustomRoleId: null };
}

export async function createMapping(input: CreateMappingInput): Promise<MicrosoftDepartmentMapping> {
  const globalAssignment = await resolveGlobalRoleAssignment(input.role, input.globalCustomRoleId, null);
  const departmentAssignment = await resolveDepartmentRoleAssignment(input.departmentRole, input.departmentCustomRoleId, null);

  await assertDepartmentExists(input.departmentId);
  const { domain, normalizedMicrosoftValue } = resolveMappingIdentity(input.sourceType, input.microsoftValue, input.domain);
  return prisma.microsoftDepartmentMapping.create({
    data: {
      sourceType: input.sourceType,
      microsoftValue: input.microsoftValue,
      domain,
      normalizedMicrosoftValue,
      departmentId: input.departmentId,
      role: globalAssignment.role,
      globalCustomRoleId: globalAssignment.globalCustomRoleId,
      departmentRole: departmentAssignment.departmentRole,
      departmentCustomRoleId: departmentAssignment.departmentCustomRoleId,
    },
  });
}

export interface UpdateMappingInput {
  sourceType?: MicrosoftMappingSourceType;
  microsoftValue?: string;
  departmentId?: string;
  /** Global Role (matches /admin/roles) — never DepartmentRole. See department-role-translation.ts. */
  role?: Role;
  /** See CreateMappingInput's doc comment — same relationship to `role`. `undefined` leaves the mapping's current global-role assignment untouched; `null` explicitly clears a custom role back to the built-in `role` enum; a string switches to that custom role. */
  globalCustomRoleId?: string | null;
  /** DepartmentRole granted on the resulting DepartmentMembership — independent of `role` above. */
  departmentRole?: DepartmentRole;
  /** Same undefined/null/string semantics as globalCustomRoleId above, department-scoped. */
  departmentCustomRoleId?: string | null;
  isActive?: boolean;
  /** Only meaningful (and only re-validated) when sourceType is part of THIS patch and is domain-scoped, or when explicitly provided — see updateMapping's own comment. Omitting it never clears an existing mapping's domain. */
  domain?: string;
}

export async function updateMapping(id: string, patch: UpdateMappingInput): Promise<MicrosoftDepartmentMapping> {
  // Fetched once, up front, for two independent purposes below: (a) the
  // identity-recompute branch (domain/normalizedMicrosoftValue), (b) knowing
  // this mapping's CURRENT custom-role ids so resolveGlobalRoleAssignment/
  // resolveDepartmentRoleAssignment can tell "already-referenced, left
  // unchanged" apart from "newly assigned" (see assertGlobalCustomRoleEligible's
  // doc comment on why that distinction matters for the isActive check).
  // Missing here just means the row doesn't exist — every branch below
  // degrades gracefully and the final update() call surfaces the real P2025.
  const existing = await prisma.microsoftDepartmentMapping.findUnique({
    where: { id },
    select: { sourceType: true, microsoftValue: true, domain: true, globalCustomRoleId: true, departmentCustomRoleId: true },
  });

  const data: Record<string, unknown> = { ...patch };

  const globalRoleTouched = patch.role !== undefined || patch.globalCustomRoleId !== undefined;
  if (globalRoleTouched) {
    const assignment = await resolveGlobalRoleAssignment(patch.role, patch.globalCustomRoleId, existing?.globalCustomRoleId ?? null);
    data.role = assignment.role;
    data.globalCustomRoleId = assignment.globalCustomRoleId;
  }

  const departmentRoleTouched = patch.departmentRole !== undefined || patch.departmentCustomRoleId !== undefined;
  if (departmentRoleTouched) {
    const assignment = await resolveDepartmentRoleAssignment(
      patch.departmentRole,
      patch.departmentCustomRoleId,
      existing?.departmentCustomRoleId ?? null
    );
    data.departmentRole = assignment.departmentRole;
    data.departmentCustomRoleId = assignment.departmentCustomRoleId;
  }

  if (patch.departmentId !== undefined) {
    await assertDepartmentExists(patch.departmentId);
  }

  // FIND-006: `domain`/`normalizedMicrosoftValue` are only ever recomputed
  // when something that could change the mapping's IDENTITY is actually
  // part of this patch (sourceType, microsoftValue, or an explicit new
  // domain) — editing just role/departmentRole/isActive on an existing
  // mapping leaves its domain/normalizedMicrosoftValue completely untouched
  // (requirement: "edit existing mapping preserves domain"). When identity
  // DOES need recomputing, the row's CURRENT sourceType/microsoftValue/domain
  // fill in whatever this patch didn't explicitly change.
  if (patch.sourceType !== undefined || patch.microsoftValue !== undefined || patch.domain !== undefined) {
    if (!existing) {
      // Let the update below hit its own P2025 — never invent a row here.
    } else {
      const sourceType = patch.sourceType ?? existing.sourceType;
      const microsoftValue = patch.microsoftValue ?? existing.microsoftValue;
      const domainInput = patch.domain !== undefined ? patch.domain : existing.domain;
      const identity = resolveMappingIdentity(sourceType, microsoftValue, domainInput);
      data.domain = identity.domain;
      data.normalizedMicrosoftValue = identity.normalizedMicrosoftValue;
    }
  } else {
    // Neither identity input changed — never send a stray `domain` field
    // through to Prisma even if the caller passed one (shouldn't happen
    // given the branch above, but keeps `data` exactly patch-shaped).
    delete data.domain;
  }

  return prisma.microsoftDepartmentMapping.update({ where: { id }, data });
}

export async function deleteMapping(id: string): Promise<void> {
  await prisma.microsoftDepartmentMapping.delete({ where: { id } });
}
