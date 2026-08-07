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
  normalizeJobTitleValue,
  syncMicrosoftDirectoryValues,
  type DirectoryFetchFailureReason,
} from "@/lib/services/microsoft-directory-service";
import { ORGANIZATION_SYNC_ALLOWED_DOMAIN } from "@/lib/services/organization-directory-eligibility-service";

export interface JobTitleDirectorySyncSummary {
  domain: string;
  discovered: number;
  added: number;
  updated: number;
  staled: number;
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
    domain: ORGANIZATION_SYNC_ALLOWED_DOMAIN,
    discovered: result.discoveredJobTitles,
    added: result.addedJobTitles,
    updated: result.updatedJobTitles,
    staled: result.staledJobTitles,
    otherDomainsObserved: result.otherDomainsObserved,
  };
}

export interface JobTitleDirectoryMappingSummary {
  id: string;
  departmentId: string;
  departmentName: string;
  role: Role;
  departmentRole: DepartmentRole;
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
 */
export async function listJobTitleDirectoryForAdmin(): Promise<{ domain: string; rows: JobTitleDirectoryRow[] }> {
  const domain = ORGANIZATION_SYNC_ALLOWED_DOMAIN;

  const [values, mappings] = await Promise.all([
    prisma.microsoftDirectoryJobTitleValue.findMany({
      where: { domain },
      orderBy: { value: "asc" },
    }),
    prisma.microsoftDepartmentMapping.findMany({
      where: { sourceType: "PROFILE_JOB_TITLE" },
      include: { department: { select: { id: true, name: true } } },
    }),
  ]);

  // Same case/whitespace-insensitive comparison as
  // microsoft-mapping-service.ts's findActiveMappingsForClaims — an admin
  // must see the exact same "is this configured" answer that login/sync
  // would actually apply, never a stricter or looser one computed here.
  const mappingByNormalized = new Map(mappings.map((m) => [normalizeJobTitleValue(m.microsoftValue), m]));

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
            departmentRole: mapping.departmentRole,
            isActive: mapping.isActive,
          }
        : null,
    };
  });

  return { domain, rows };
}
