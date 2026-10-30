/**
 * Resolves (finds, or creates when missing) the Company + Department a
 * Microsoft Directory Sync user belongs to, from Entra's free-text
 * `companyName`/`department` fields — the multi-company half of
 * lib/services/organization-directory-sync-service.ts. Every Company gets
 * its own root (no assumption of a single "the" company); a Department
 * always attaches DIRECTLY to a Company (`Department.companyId`), never a
 * synthetic/fabricated BusinessUnit — Entra has no "business unit" concept
 * of its own, and a manually admin-organized department's `businessUnitId`
 * path (lib/services/department-service.ts) is left completely untouched.
 *
 * Idempotent and race-safe the same way the User identity fix in
 * organization-directory-sync-service.ts is: every write is its own
 * independent statement (never a shared multi-row transaction), and the
 * database-level unique indexes (Company.normalizedName, Department's
 * `@@unique([companyId, normalizedName])`) are the real backstop — a race
 * (e.g. against a concurrent manual admin company/department creation)
 * degrades to a safe re-fetch, never a crash, never a duplicate.
 *
 * `OrganizationResolutionCache` is a plain per-sync-run cache (create one
 * with createOrganizationResolutionCache() at the start of a sync run, reuse
 * it across every user processed) — avoids re-querying the same Company/
 * Department for every one of potentially thousands of users, matching the
 * existing bulk-loaded-config-map convention used throughout this codebase
 * (e.g. lib/status-terminal.ts's getProjectTerminalConfigsForDepartments).
 */
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { normalizeCompanyName, normalizeDepartmentName, UNASSIGNED_NODE_NAME } from "@/lib/services/organization-normalization";

export interface OrganizationResolutionCache {
  companyByNormalizedName: Map<string, { id: string; name: string }>;
  departmentByCompanyAndNormalizedName: Map<string, { id: string; name: string }>;
  /** Negative cache: normalizedName values already confirmed to have no existing Company match this run — avoids re-querying (and re-warning) for every one of potentially thousands of users from the same unresolved free-text company name. */
  unresolvedCompanyNormalizedNames: Set<string>;
}

export function createOrganizationResolutionCache(): OrganizationResolutionCache {
  return { companyByNormalizedName: new Map(), departmentByCompanyAndNormalizedName: new Map(), unresolvedCompanyNormalizedNames: new Set() };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Finds the Company for a raw Entra `companyName` — one root per normalized
 * name (trim/collapse-whitespace/lowercase, see
 * lib/services/organization-normalization.ts), never hardcoded per-tenant.
 * A missing/blank companyName returns `null` — it is NEVER resolved to a
 * persisted "Unassigned" Company row (that would be exactly the fabricated
 * company root the feature's spec forbids: "if UI requires a single top
 * root, use a virtual presentation-only root, never persist a fake
 * company"). The caller places the user's Department (and the user itself)
 * with `companyId: null` instead — the SAME genuinely-orphaned shape
 * lib/services/organization-tree-service.ts already recognizes and renders
 * under its own synthesized, non-persisted "Unassigned" grouping
 * (`orphanGroupNode`), so both mechanisms stay consistent instead of
 * fighting each other.
 *
 * REQUIRED (duplicate-Company-prevention round): this NEVER auto-creates a
 * Company any more, on a cache miss or otherwise — only an exact
 * `normalizedName` match against an ALREADY-EXISTING Company (created by an
 * admin via POST /api/admin/companies, by SQLGeneral's own resolver, or by
 * a prior exact match here) is ever reused. normalizeCompanyName only
 * trims/collapses-whitespace/lowercases — it deliberately does not strip
 * punctuation or correct spelling (no fuzzy matching, no hardcoded
 * per-tenant aliases, per this round's own constraints), so two Entra
 * profiles carrying "Acme Inc", "Acme Inc.", and "Acem Inc" (a typo) are
 * three DIFFERENT normalized strings — auto-creating a fresh Company for
 * each is exactly the root cause of the near-duplicate Company rows this
 * round fixes (confirmed in production: three "Kinsen Hellas S.A."
 * punctuation/typo variants, each with its own auto-created Companies and,
 * downstream, its own near-duplicate Departments). A genuinely new,
 * first-time-seen real Company now requires one deliberate admin action
 * (POST /api/admin/companies) instead of being silently minted from
 * whatever free-text string Entra happens to carry — exactly the same
 * "explicit approval before creating cross-system identity" posture this
 * codebase already enforces for SQLGeneral (SqlGeneralCompanyMapping/
 * SqlGeneralDepartmentMapping) and for Microsoft's own PROFILE_DEPARTMENT/
 * JOB_TITLE/GROUP/APP_ROLE mappings — Companies were the one place that
 * posture didn't apply yet.
 */
export async function resolveCompanyForSync(
  cache: OrganizationResolutionCache,
  rawCompanyName: string | null | undefined
): Promise<{ id: string; name: string } | null> {
  const name = rawCompanyName?.trim();
  if (!name) return null;
  const normalizedName = normalizeCompanyName(name);

  const cached = cache.companyByNormalizedName.get(normalizedName);
  if (cached) return cached;
  if (cache.unresolvedCompanyNormalizedNames.has(normalizedName)) return null;

  const existing = await prisma.company.findUnique({ where: { normalizedName }, select: { id: true, name: true } });
  if (existing) {
    cache.companyByNormalizedName.set(normalizedName, existing);
    return existing;
  }

  console.warn("[organization-sync] Company name has no exact match against an existing Company — leaving this user/Department unresolved (companyId: null) rather than auto-creating a possible duplicate. An admin must create the real Company explicitly if this is genuinely new.", { rawCompanyName: name, normalizedName });
  cache.unresolvedCompanyNormalizedNames.add(normalizedName);
  return null;
}

/**
 * Finds the Department for a raw Entra `department` value, always placed
 * DIRECTLY under `companyId` (never a fabricated BusinessUnit). Two
 * companies each having their own "IT" department is expected and correct —
 * matching is scoped to `(companyId, normalizedName)`, so they are never
 * merged. A missing/blank department value resolves to that company's own
 * "Unassigned" department (scoped within the correct company, never a
 * cross-company bucket).
 *
 * `companyId: null` means the user's companyName itself was missing or
 * unresolved (see resolveCompanyForSync above) — the resulting Department
 * is genuinely orphaned (`companyId: null`, `businessUnitId: null`), the
 * exact shape organization-tree-service.ts already renders under its
 * synthesized "Unassigned" grouping. Sync runs are lock-serialized
 * (organization-sync-orchestrator.ts), so the find-then-create race window
 * here is the same one every other branch of this resolver already accepts.
 *
 * REQUIRED (duplicate-Department-prevention round): a raw value that does
 * NOT exactly match an EXISTING Department under this `companyId` falls
 * back to that same Company's "Unassigned" Department — it is NEVER used
 * to create a brand-new Department named after itself. This is the fix for
 * the real production incident this round addresses: an admin RENAMES a
 * Department (e.g. "Mobility & Leasing" -> "Kinsen Marketing"); its
 * `normalizedName` no longer matches the old raw Entra value, so every
 * subsequent login/sync carrying that old value found "no match" and
 * silently created a FRESH "Mobility & Leasing" Department under the same
 * Company — repeatedly, once per slug collision. Falling back to
 * Unassigned instead means an old/renamed signal can never spawn a
 * same-named clone again; a genuinely NEW Department still requires one
 * deliberate admin action, matching the same posture resolveCompanyForSync
 * now has above. Two real, DIFFERENT companies legitimately sharing a
 * Department name are completely unaffected — this only changes the
 * no-match fallback, never the exact-match path multi-company Departments
 * already rely on.
 */
export async function resolveDepartmentForSync(
  cache: OrganizationResolutionCache,
  companyId: string | null,
  rawDepartmentName: string | null | undefined
): Promise<{ id: string; name: string; fellBackToUnassigned: boolean }> {
  let name = rawDepartmentName?.trim() || UNASSIGNED_NODE_NAME;
  let normalizedName = normalizeDepartmentName(name);
  let cacheKey = `${companyId ?? "__no_company__"}:${normalizedName}`;
  // REQUIRED (unresolved-Microsoft-directory-data safety round): the
  // caller (resolveOrganizationPlacement, and through it every Microsoft
  // sync entry point) needs to know whether THIS result is a genuine
  // match or the Unassigned fallback — a fallback is degraded/untrusted
  // information and must never be allowed to move an already-placed
  // user's PRIMARY (see that round's own fix in the two sync services).
  // Computed once, true only for the actual fallback branch below — a
  // genuine match (first check, or the "Unassigned" name itself genuinely
  // matching an existing row) is always false.
  let fellBackToUnassigned = false;

  const cached = cache.departmentByCompanyAndNormalizedName.get(cacheKey);
  if (cached) return { ...cached, fellBackToUnassigned: false };

  let existing = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });

  if (!existing && name !== UNASSIGNED_NODE_NAME) {
    console.warn("[organization-sync] Department name has no exact match under this Company — falling back to Unassigned rather than auto-creating a possible duplicate/stray (e.g. after a rename). An admin must create the real Department explicitly if this is genuinely new.", { companyId, rawDepartmentName: name, normalizedName });
    fellBackToUnassigned = true;
    name = UNASSIGNED_NODE_NAME;
    normalizedName = normalizeDepartmentName(name);
    cacheKey = `${companyId ?? "__no_company__"}:${normalizedName}`;
    const cachedFallback = cache.departmentByCompanyAndNormalizedName.get(cacheKey);
    if (cachedFallback) return { ...cachedFallback, fellBackToUnassigned: true };
    existing = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });
  }

  if (existing) {
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, existing);
    return { ...existing, fellBackToUnassigned };
  }

  try {
    // createDepartment (lib/services/department-service.ts) — never a
    // parallel department-creation path — handles slug generation, the full
    // starter-config row set (terminal status, priority order, activity
    // progress, SLA), and now normalizedName, identically to a manually
    // admin-created department. Reached ONLY for the "Unassigned" bucket
    // now (see this function's own doc comment) — never for an arbitrary
    // unmatched raw value.
    const created = await createDepartment({ name, companyId });
    const summary = { id: created.id, name: created.name };
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, summary);
    return { ...summary, fellBackToUnassigned };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const retried = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });
    if (!retried) throw err;
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, retried);
    return { ...retried, fellBackToUnassigned };
  }
}

export interface OrganizationPlacement {
  companyId: string | null;
  companyName: string | null;
  departmentId: string;
  departmentName: string;
  /**
   * REQUIRED (unresolved-Microsoft-directory-data safety round): true
   * whenever departmentId is the Unassigned fallback rather than a
   * genuine match (companyId === null carries the equivalent signal for
   * the Company half — no separate flag needed there). Every caller MUST
   * check this (or companyId === null) before applying this placement to
   * an EXISTING user who already has a real companyId/primary — degraded/
   * unresolved Microsoft data must never downgrade already-good access
   * (see microsoft-department-sync-service.ts / organization-directory-
   * sync-service.ts for the actual guard). Safe to apply unconditionally
   * for a brand-new user with no existing placement to protect.
   */
  departmentFellBackToUnassigned: boolean;
}

/** Convenience: resolves both levels in one call — the shape Microsoft Directory Sync actually needs per user. */
export async function resolveOrganizationPlacement(
  cache: OrganizationResolutionCache,
  rawCompanyName: string | null | undefined,
  rawDepartmentName: string | null | undefined
): Promise<OrganizationPlacement> {
  const company = await resolveCompanyForSync(cache, rawCompanyName);
  const department = await resolveDepartmentForSync(cache, company?.id ?? null, rawDepartmentName);
  return {
    companyId: company?.id ?? null,
    companyName: company?.name ?? null,
    departmentId: department.id,
    departmentName: department.name,
    departmentFellBackToUnassigned: department.fellBackToUnassigned,
  };
}
