/**
 * Organization data sync sourced from the external HR directory API
 * (lib/hr-directory-api.ts, `sql-api.saracakis.gr`'s `UsersAndManagers`
 * endpoint) — replaces Microsoft Graph as the source for company/department
 * placement AND the manager/reporting-line tree, while Microsoft Entra ID
 * SSO login itself (lib/auth.ts/lib/auth.config.ts) is completely unrelated
 * and untouched; see lib/services/microsoft-department-sync-service.ts for
 * how the per-login hook now calls into this file's upsertOneHrRow via
 * applyHrPlacementToUser.
 *
 * Unlike the two Graph-based services this replaces
 * (organization-directory-sync-service.ts + organization-manager-sync-service.ts,
 * both left in place, just no longer called from the orchestrator), this is
 * a SINGLE paginated scan with no separate manager fan-out stage: every row
 * already carries its own direct manager (`managerAMAccountName`/`managerMail`)
 * inline, so Pass 2 below resolves the whole manager graph purely in memory
 * from Pass 1's own output — no per-manager `directReports` calls, no
 * concurrency pool, no "candidate manager" concept at all. `manager2`/`manager3`
 * (the manager's own manager, and the one above that) are NOT stored as
 * separate columns — the existing `User.managerId` self-relation already
 * reconstructs the full multi-level chain transitively by walking
 * `manager.manager.manager`, as long as every user's own DIRECT manager edge
 * (level 1 only) is correct.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, MembershipSource } from "@prisma/client";
import { fetchAllHrUsersAndManagers, type HrApiFailureReason, type HrUsersAndManagersRow } from "@/lib/hr-directory-api";
import { isAllowedOrganizationEmail } from "@/lib/allowed-email-domains";
import { normalizeEmail } from "@/lib/services/email-identity";
import { resolveDefaultGlobalRoleAssignment, resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";
import { setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import {
  createHrOrganizationResolutionCache,
  resolveHrOrganizationPlacement,
  type HrOrganizationResolutionCache,
} from "@/lib/services/organization-company-department-resolver";

const MAX_CHAIN_DEPTH = 50; // same safety cap as organization-manager-sync-service.ts's cycle guard
// Same rationale as organization-manager-sync-service.ts's PUBLISH_TRANSACTION_TIMEOUT_MS —
// one transaction writes every resolved user's managerId in a single commit.
const PUBLISH_TRANSACTION_TIMEOUT_MS = 120000;
const PUBLISH_TRANSACTION_MAX_WAIT_MS = 10000;

function hrUsernameOf(row: HrUsersAndManagersRow): string | null {
  const value = (row.Username || row.sAMAccountName || "").trim();
  return value.length > 0 ? value : null;
}

export interface HrPlacementResult {
  companyId: string | null;
  departmentId: string | null;
}

/**
 * Applies ONE HR row's organizational placement (Company/Department +
 * primary DepartmentMembership) to an ALREADY-KNOWN local userId — the
 * shared building block both this file's own batch Pass 1 (after its own
 * identity resolution finds/creates the userId) and the per-login hook in
 * microsoft-department-sync-service.ts (which already knows its userId,
 * being called mid-login for an existing row) call, so the two never
 * duplicate this logic. Never does identity resolution itself — that's the
 * caller's job (see upsertOneHrRow below for the batch-sync version, or
 * fetchHrUserByMail for the per-login lookup).
 */
export async function applyHrPlacementToUser(
  userId: string,
  row: HrUsersAndManagersRow,
  cache: HrOrganizationResolutionCache
): Promise<HrPlacementResult> {
  const placement = await resolveHrOrganizationPlacement(cache, row.CompanyId, row.Company, row.HrDepartmentId, row.Department);
  const hrUsername = hrUsernameOf(row);

  await prisma.user.update({
    where: { id: userId },
    data: {
      name: row.DisplayName || undefined,
      jobTitle: row.Title ?? undefined,
      hrUsername: hrUsername ?? undefined,
      companyId: placement.companyId,
      organizationSyncedAt: new Date(),
      // Explicit, user-confirmed behavior: unlike the Microsoft sync this
      // replaces (which never auto-deactivates an existing user), the HR
      // API's own Active flag is treated as authoritative — Active:false
      // actively flips isActive here. Active:true/missing never touches an
      // existing row's isActive (a user reactivated locally for some other
      // reason is never silently re-deactivated by a stale HR row).
      ...(row.Active === false ? { isActive: false } : {}),
    },
  });

  const departmentDefault = await resolveDefaultDepartmentRoleAssignment();
  await setPrimaryDepartmentMembership(userId, placement.departmentId, MembershipSource.HR_DIRECTORY, {
    role: departmentDefault.role,
    customRoleId: departmentDefault.customRoleId,
    // Deactivates an obsolete non-MANUAL primary when replaced — including a
    // pre-cutover MICROSOFT_DEPARTMENT-sourced one (the option's own
    // implementation only checks "was the old source non-MANUAL", not
    // literally "was it Microsoft" — see department-membership-service.ts).
    deactivateObsoleteMicrosoftPrimary: true,
  });

  return { companyId: placement.companyId, departmentId: placement.departmentId };
}

type RowAction = "created" | "updated" | "linked" | "excluded" | "skipped";

interface RowUpsertOutcome {
  action: RowAction;
  dbUserId: string | null;
  skipReason?: string;
}

/**
 * Upserts ONE HR row with full identity resolution — the batch-sync
 * counterpart to applyHrPlacementToUser above. Mirrors
 * organization-directory-sync-service.ts's upsertOneDirectoryUser identity
 * rules exactly (hrUsername/microsoftUserId-equivalent match first, email
 * fallback, never silently reassign a conflicting match), isolated to its
 * own statement sequence per row (no shared batch transaction — same
 * production-incident reasoning documented there).
 *
 * Domain eligibility (lib/allowed-email-domains.ts) gates CREATE/UPDATE
 * exactly like Microsoft sync's validateDirectoryUser does: a row outside
 * every allowed organization domain is never created or updated here, but
 * if a local user already exists for it (e.g. from a prior Microsoft sync),
 * their dbUserId is still reported — a non-eligible person can still
 * legitimately be someone else's manager, same "excluded but still a valid
 * manager target" allowance organization-manager-sync-service.ts has.
 */
async function upsertOneHrRow(row: HrUsersAndManagersRow, cache: HrOrganizationResolutionCache): Promise<RowUpsertOutcome> {
  const rawMail = row.Mail?.trim();
  if (!rawMail) return { action: "skipped", dbUserId: null, skipReason: "missing_mail" };

  const email = normalizeEmail(rawMail);
  const hrUsername = hrUsernameOf(row);
  const eligible = isAllowedOrganizationEmail(rawMail);

  try {
    let existing = hrUsername
      ? await prisma.user.findUnique({ where: { hrUsername }, select: { id: true, hrUsername: true } })
      : null;
    let action: RowAction = "updated";

    if (!existing) {
      const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, hrUsername: true } });
      if (byEmail) {
        if (byEmail.hrUsername && hrUsername && byEmail.hrUsername !== hrUsername) {
          console.warn("[hr-directory-sync] user sync skipped", { email, hrUsername, reason: "email_linked_to_different_hr_user" });
          return { action: "skipped", dbUserId: null, skipReason: "email_linked_to_different_hr_user" };
        }
        existing = byEmail;
        action = "linked";
      }
    }

    if (!eligible) {
      // Never create/update — but still a legitimate manager target if a
      // local row already exists (see this function's header comment).
      return { action: "excluded", dbUserId: existing?.id ?? null };
    }

    if (existing) {
      await applyHrPlacementToUser(existing.id, row, cache);
      return { action, dbUserId: existing.id };
    }

    const globalDefault = await resolveDefaultGlobalRoleAssignment();
    const created = await prisma.user.create({
      data: {
        email,
        name: row.DisplayName || null,
        hrUsername,
        authProvider: AuthProvider.MICROSOFT,
        isActive: row.Active ?? true,
        jobTitle: row.Title ?? null,
        organizationSyncedAt: new Date(),
        role: globalDefault.role,
        customRoleId: globalDefault.customRoleId,
      },
      select: { id: true },
    });
    await applyHrPlacementToUser(created.id, row, cache);
    return { action: "created", dbUserId: created.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[hr-directory-sync] user sync failed", { email, hrUsername, reason });
    return { action: "skipped", dbUserId: null, skipReason: reason };
  }
}

interface ResolvedRef {
  dbUserId: string | null;
  companyId: string | null;
  isExcluded: boolean;
}

/** Walks UP the chain with an explicit visited Set + depth guard — same shape as organization-manager-sync-service.ts's wouldCreateCycle, duplicated rather than shared since this file's resolution map/types differ slightly and the function is small. */
function wouldCreateCycle(childId: string, candidateManagerId: string, managerIdByDbUserId: Map<string, string | null>): boolean {
  if (childId === candidateManagerId) return true;
  const visited = new Set<string>([childId]);
  let current: string | null = candidateManagerId;
  let depth = 0;
  while (current) {
    if (visited.has(current)) return true;
    if (depth >= MAX_CHAIN_DEPTH) return true;
    visited.add(current);
    current = managerIdByDbUserId.get(current) ?? null;
    depth++;
  }
  return false;
}

export interface HrDirectorySyncOutcome {
  ok: boolean;
  reason?: HrApiFailureReason;
  usersScanned: number;
  usersUpdated: number;
  usersSkipped: number;
  errorCount: number;
  /** Whether the manager-edge publish transaction actually committed. False only on a publish-transaction failure — Pass 2 here has no fetch-phase failure mode (unlike the Graph fan-out this replaces), since every row already carries its manager inline. */
  managerHierarchyPublished: boolean;
}

/**
 * Full pipeline: fetch (one paginated scan) -> Pass 1 (per-row upsert,
 * building the dbUserId/companyId map as it goes) -> Pass 2 (in-memory
 * manager-edge resolution from that same map, cycle/cross-company/self-
 * manager guarded, one atomic publish transaction). Never throws for an
 * expected API/DB failure — returns a typed outcome, same convention as
 * every other organization-sync service.
 */
export async function runHrDirectorySync(): Promise<HrDirectorySyncOutcome> {
  const fetchResult = await fetchAllHrUsersAndManagers();
  if (!fetchResult.ok) {
    return { ok: false, reason: fetchResult.reason, usersScanned: 0, usersUpdated: 0, usersSkipped: 0, errorCount: 0, managerHierarchyPublished: false };
  }

  const cache = createHrOrganizationResolutionCache();
  const byHrUsername = new Map<string, ResolvedRef>();
  const byEmail = new Map<string, ResolvedRef>();

  let usersUpdated = 0;
  let usersSkipped = 0;
  let errorCount = 0;

  // Pass 1 — sequential (never Promise.all), same predictable-DB-load
  // reasoning as the Graph-based services this replaces.
  for (const row of fetchResult.rows) {
    const outcome = await upsertOneHrRow(row, cache);

    if (outcome.action === "created" || outcome.action === "updated" || outcome.action === "linked") usersUpdated++;
    else if (outcome.action === "skipped") {
      usersSkipped++;
      errorCount++;
    }
    // "excluded" (domain-ineligible) counts as neither updated nor an error
    // — same treatment as Microsoft sync's guest/domain-ineligible skip.

    const ref: ResolvedRef = {
      dbUserId: outcome.dbUserId,
      companyId: null, // filled below once we know it, for the cross-company guard
      isExcluded: outcome.action === "excluded",
    };
    const hrUsername = hrUsernameOf(row);
    const email = row.Mail?.trim() ? normalizeEmail(row.Mail) : null;
    if (hrUsername) byHrUsername.set(hrUsername, ref);
    if (email) byEmail.set(email, ref);
  }

  // Backfill companyId for the cross-company guard below — one bulk query
  // instead of N, same pattern organization-manager-sync-service.ts uses.
  const allDbUserIds = Array.from(new Set([...byHrUsername.values(), ...byEmail.values()].map((r) => r.dbUserId).filter((id): id is string => !!id)));
  if (allDbUserIds.length > 0) {
    const companyRows = await prisma.user.findMany({ where: { id: { in: allDbUserIds } }, select: { id: true, companyId: true } });
    const companyIdByDbUserId = new Map(companyRows.map((u) => [u.id, u.companyId]));
    for (const ref of byHrUsername.values()) if (ref.dbUserId) ref.companyId = companyIdByDbUserId.get(ref.dbUserId) ?? null;
    for (const ref of byEmail.values()) if (ref.dbUserId) ref.companyId = companyIdByDbUserId.get(ref.dbUserId) ?? null;
  }

  // Pass 2 — manager edges, purely in memory from Pass 1's own maps. No
  // Graph calls, no fetch-phase failure mode — every row already carries
  // its manager inline.
  function resolveManagerRef(row: HrUsersAndManagersRow): ResolvedRef | null {
    const managerUsername = row.managerAMAccountName?.trim();
    if (managerUsername) {
      const byUsername = byHrUsername.get(managerUsername);
      if (byUsername) return byUsername;
    }
    const managerMail = row.managerMail?.trim();
    if (managerMail) {
      const byMail = byEmail.get(normalizeEmail(managerMail));
      if (byMail) return byMail;
    }
    return null;
  }

  interface Resolution {
    managerId: string | null;
    managerExcludedFromSync: boolean;
  }
  const resolutionByDbUserId = new Map<string, Resolution>();
  let selfManagerRejections = 0;
  let crossCompanyRejections = 0;

  for (const row of fetchResult.rows) {
    const hrUsername = hrUsernameOf(row);
    const email = row.Mail?.trim() ? normalizeEmail(row.Mail) : null;
    const self = (hrUsername && byHrUsername.get(hrUsername)) || (email && byEmail.get(email)) || null;
    if (!self?.dbUserId) continue; // no local row for this report — nothing to write

    const managerRef = resolveManagerRef(row);
    if (!managerRef) {
      resolutionByDbUserId.set(self.dbUserId, { managerId: null, managerExcludedFromSync: false });
      continue;
    }
    if (managerRef.dbUserId === self.dbUserId) {
      selfManagerRejections++;
      console.warn("[hr-directory-sync] Rejected self-manager edge", { dbUserId: self.dbUserId });
      resolutionByDbUserId.set(self.dbUserId, { managerId: null, managerExcludedFromSync: false });
      continue;
    }
    if (managerRef.isExcluded || !managerRef.dbUserId) {
      resolutionByDbUserId.set(self.dbUserId, { managerId: null, managerExcludedFromSync: true });
      continue;
    }
    if (self.companyId && managerRef.companyId && self.companyId !== managerRef.companyId) {
      crossCompanyRejections++;
      console.warn("[hr-directory-sync] Rejected cross-company manager edge, publishing null instead", { dbUserId: self.dbUserId });
      resolutionByDbUserId.set(self.dbUserId, { managerId: null, managerExcludedFromSync: false });
      continue;
    }
    resolutionByDbUserId.set(self.dbUserId, { managerId: managerRef.dbUserId, managerExcludedFromSync: false });
  }

  // Cycle detection over the FINAL resolved map.
  let cycleRejections = 0;
  const managerIdLookup = new Map<string, string | null>(Array.from(resolutionByDbUserId.entries()).map(([id, r]) => [id, r.managerId]));
  for (const [dbUserId, resolution] of resolutionByDbUserId) {
    if (resolution.managerId && wouldCreateCycle(dbUserId, resolution.managerId, managerIdLookup)) {
      cycleRejections++;
      resolutionByDbUserId.set(dbUserId, { managerId: null, managerExcludedFromSync: false });
      console.warn("[hr-directory-sync] Rejected cyclic manager chain, publishing null instead", { dbUserId });
    }
  }

  let managerHierarchyPublished = false;
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const [dbUserId, resolution] of resolutionByDbUserId) {
          await tx.user.update({
            where: { id: dbUserId },
            data: { managerId: resolution.managerId, managerExcludedFromSync: resolution.managerExcludedFromSync, organizationSyncedAt: new Date() },
          });
        }
      },
      { timeout: PUBLISH_TRANSACTION_TIMEOUT_MS, maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS }
    );
    managerHierarchyPublished = true;
  } catch (err) {
    console.warn("[hr-directory-sync] Publish transaction failed — previous manager snapshot remains active", {
      reason: err instanceof Error ? err.message : String(err),
    });
    errorCount++;
  }

  errorCount += selfManagerRejections + crossCompanyRejections + cycleRejections;

  return {
    ok: true,
    usersScanned: fetchResult.rows.length,
    usersUpdated,
    usersSkipped,
    errorCount,
    managerHierarchyPublished,
  };
}
