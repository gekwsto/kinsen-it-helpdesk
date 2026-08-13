/**
 * Admin-facing composition layer for Microsoft Job Title auto-discovery —
 * sits ON TOP of the existing infrastructure, adds nothing parallel to it:
 *
 *   - Discovery/sync itself is the existing, eligibility-filtered Operation B
 *     scan (lib/services/microsoft-directory-service.ts's
 *     syncMicrosoftDirectoryValues / syncJobTitleDirectoryTable) — this file
 *     does not fetch from Graph on its own. syncMicrosoftJobTitleDirectory
 *     below is a thin, job-title-focused summary wrapper around that same
 *     call, so the admin UI's "Sync Microsoft Job Titles" button and the
 *     existing "Sync Directory Values" button both trigger the exact same
 *     underlying tenant scan (no duplicate Graph traffic) — they just
 *     surface different, purpose-fit summaries.
 *   - The actual permission mapping (which Department/Global Role/Department
 *     Role a job title grants) is the existing MicrosoftDepartmentMapping
 *     model with sourceType PROFILE_JOB_TITLE
 *     (lib/services/microsoft-mapping-service.ts) — already resolved
 *     identically for full sync and first login via
 *     resolveDepartmentMemberships/resolvePrimaryMicrosoftMapping, already
 *     protected from MANUAL overrides (department-membership-service.ts /
 *     department-role-translation.ts's shouldSyncGlobalRole). Nothing here
 *     creates a second permission system — listJobTitleDirectoryForAdmin
 *     below only READS MicrosoftDepartmentMapping, to tell an admin which
 *     discovered titles already have one.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole, Role } from "@prisma/client";
import {
  syncMicrosoftDirectoryValues,
  type DirectoryFetchFailureReason,
} from "@/lib/services/microsoft-directory-service";
import { ALLOWED_ORGANIZATION_EMAIL_DOMAINS } from "@/lib/allowed-email-domains";

export interface JobTitleDirectorySyncSummary {
  /** Kept for backward compatibility — the FIRST configured allowed domain. Prefer perDomain for a deployment with more than one allowed domain. */
  domain: string;
  /** Sum across every configured allowed domain. */
  discovered: number;
  added: number;
  updated: number;
  staled: number;
  /** One entry per configured allowed domain — see microsoft-directory-service.ts's DirectorySyncSummary.perDomainJobTitles. */
  perDomain: Array<{ domain: string; discovered: number; added: number; updated: number; staled: number }>;
  otherDomainsObserved: string[];
}

export type JobTitleDirectorySyncResult =
  | ({ ok: true } & JobTitleDirectorySyncSummary)
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

/**
 * Job-title-focused view of syncMicrosoftDirectoryValues's result — see this
 * file's header for why this doesn't run its own Graph scan.
 */
export async function syncMicrosoftJobTitleDirectory(): Promise<JobTitleDirectorySyncResult> {
  const result = await syncMicrosoftDirectoryValues();
  if (!result.ok) return result;

  return {
    ok: true,
    domain: ALLOWED_ORGANIZATION_EMAIL_DOMAINS[0],
    discovered: result.discoveredJobTitles,
    added: result.addedJobTitles,
    updated: result.updatedJobTitles,
    staled: result.staledJobTitles,
    perDomain: result.perDomainJobTitles,
    otherDomainsObserved: result.otherDomainsObserved,
  };
}

export interface JobTitleDirectoryMappingSummary {
  id: string;
  departmentId: string;
  departmentName: string;
  role: Role;
  /** Set when this mapping grants a custom GLOBAL/BOTH-scope role instead of the built-in `role` above — see MicrosoftDepartmentMapping.globalCustomRoleId. */
  globalCustomRoleName: string | null;
  departmentRole: DepartmentRole;
  /** Same idea, department-scoped — see MicrosoftDepartmentMapping.departmentCustomRoleId. */
  departmentCustomRoleName: string | null;
  isActive: boolean;
}

export interface JobTitleDirectoryRow {
  id: string;
  value: string;
  userCount: number;
  isActive: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Whether an active PROFILE_JOB_TITLE mapping exists for this exact value (case/whitespace-insensitive, same rule microsoft-mapping-service.ts uses at sync time). */
  configured: boolean;
  mapping: JobTitleDirectoryMappingSummary | null;
}

/**
 * Everything the Job Titles admin panel needs in one call: the discovered,
 * domain-scoped value cache, joined in-memory (no N+1) against active
 * PROFILE_JOB_TITLE mappings so the admin sees, per title, whether it's
 * already configured and what it currently grants.
 *
 * `domain` selects WHICH configured allowed domain to view — defaults to
 * the first one (preserves the exact previous single-domain behavior for a
 * deployment that only ever configured one). An admin with more than one
 * allowed domain configured can pass any of ALLOWED_ORGANIZATION_EMAIL_DOMAINS
 * to view/manage that domain's discovered titles instead. An unrecognized
 * domain falls back to the first configured one rather than silently
 * returning an empty/wrong view.
 */
export async function listJobTitleDirectoryForAdmin(domain?: string): Promise<{ domain: string; rows: JobTitleDirectoryRow[] }> {
  const requested = domain?.trim().toLowerCase();
  const resolvedDomain = requested && ALLOWED_ORGANIZATION_EMAIL_DOMAINS.includes(requested)
    ? requested
    : ALLOWED_ORGANIZATION_EMAIL_DOMAINS[0];

  const [values, mappings] = await Promise.all([
    prisma.microsoftDirectoryJobTitleValue.findMany({
      where: { domain: resolvedDomain },
      orderBy: { value: "asc" },
    }),
    // FIND-006: filtered by THIS domain too, not just sourceType — a
    // saracakis.gr mapping must never make a kinsen.gr discovered title
    // show as "Configured", and vice versa. Matches this table's own
    // `where: {domain}` above exactly.
    prisma.microsoftDepartmentMapping.findMany({
      where: { sourceType: "PROFILE_JOB_TITLE", domain: resolvedDomain },
      include: {
        department: { select: { id: true, name: true } },
        globalCustomRole: { select: { name: true } },
        departmentCustomRole: { select: { name: true } },
      },
    }),
  ]);

  // normalizedMicrosoftValue is precomputed with the exact same
  // normalizeJobTitleValue function the discovery catalog uses (see
  // MicrosoftDepartmentMapping's schema comment) — an admin must see the
  // exact same "is this configured" answer that login/sync would actually
  // apply, never a stricter or looser one computed here.
  const mappingByNormalized = new Map(mappings.map((m) => [m.normalizedMicrosoftValue, m]));

  const rows: JobTitleDirectoryRow[] = values.map((v) => {
    const mapping = mappingByNormalized.get(v.normalizedValue) ?? null;
    return {
      id: v.id,
      value: v.value,
      userCount: v.userCount,
      isActive: v.isActive,
      firstSeenAt: v.firstSeenAt,
      lastSeenAt: v.lastSeenAt,
      configured: !!mapping && mapping.isActive,
      mapping: mapping
        ? {
            id: mapping.id,
            departmentId: mapping.departmentId,
            departmentName: mapping.department.name,
            role: mapping.role,
            globalCustomRoleName: mapping.globalCustomRole?.name ?? null,
            departmentRole: mapping.departmentRole,
            departmentCustomRoleName: mapping.departmentCustomRole?.name ?? null,
            isActive: mapping.isActive,
          }
        : null,
    };
  });

  return { domain: resolvedDomain, rows };
}
