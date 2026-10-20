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
}

export function createOrganizationResolutionCache(): OrganizationResolutionCache {
  return { companyByNormalizedName: new Map(), departmentByCompanyAndNormalizedName: new Map() };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Finds or creates the Company for a raw Entra `companyName` — one root per
 * normalized name (trim/collapse-whitespace/lowercase, see
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

  const existing = await prisma.company.findUnique({ where: { normalizedName }, select: { id: true, name: true } });
  if (existing) {
    cache.companyByNormalizedName.set(normalizedName, existing);
    return existing;
  }

  try {
    const created = await prisma.company.create({ data: { name, normalizedName } });
    cache.companyByNormalizedName.set(normalizedName, created);
    return created;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    // Race: something else (a concurrent manual admin action — sync runs
    // themselves are already lock-serialized, see
    // organization-sync-orchestrator.ts) created the exact same normalized
    // company between our find and create. Re-fetch, never duplicate.
    const retried = await prisma.company.findUnique({ where: { normalizedName }, select: { id: true, name: true } });
    if (!retried) throw err;
    cache.companyByNormalizedName.set(normalizedName, retried);
    return retried;
  }
}

/**
 * Finds or creates the Department for a raw Entra `department` value, always
 * placed DIRECTLY under `companyId` (never a fabricated BusinessUnit). Two
 * companies each having their own "IT" department is expected and correct —
 * matching is scoped to `(companyId, normalizedName)`, so they are never
 * merged. A missing/blank department value resolves to that company's own
 * "Unassigned" department (scoped within the correct company, never a
 * cross-company bucket).
 *
 * `companyId: null` means the user's companyName itself was missing (see
 * resolveCompanyForSync above) — the resulting Department is genuinely
 * orphaned (`companyId: null`, `businessUnitId: null`), the exact shape
 * organization-tree-service.ts already renders under its synthesized
 * "Unassigned" grouping. Sync runs are lock-serialized
 * (organization-sync-orchestrator.ts), so the find-then-create race window
 * here is the same one every other branch of this resolver already accepts.
 */
export async function resolveDepartmentForSync(
  cache: OrganizationResolutionCache,
  companyId: string | null,
  rawDepartmentName: string | null | undefined
): Promise<{ id: string; name: string }> {
  const name = rawDepartmentName?.trim() || UNASSIGNED_NODE_NAME;
  const normalizedName = normalizeDepartmentName(name);
  const cacheKey = `${companyId ?? "__no_company__"}:${normalizedName}`;

  const cached = cache.departmentByCompanyAndNormalizedName.get(cacheKey);
  if (cached) return cached;

  const existing = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });
  if (existing) {
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, existing);
    return existing;
  }

  try {
    // createDepartment (lib/services/department-service.ts) — never a
    // parallel department-creation path — handles slug generation, the full
    // starter-config row set (terminal status, priority order, activity
    // progress, SLA), and now normalizedName, identically to a manually
    // admin-created department.
    const created = await createDepartment({ name, companyId });
    const summary = { id: created.id, name: created.name };
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, summary);
    return summary;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const retried = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });
    if (!retried) throw err;
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, retried);
    return retried;
  }
}

export interface OrganizationPlacement {
  companyId: string | null;
  companyName: string | null;
  departmentId: string;
  departmentName: string;
}

/** Convenience: resolves both levels in one call — the shape Microsoft Directory Sync actually needs per user. */
export async function resolveOrganizationPlacement(
  cache: OrganizationResolutionCache,
  rawCompanyName: string | null | undefined,
  rawDepartmentName: string | null | undefined
): Promise<OrganizationPlacement> {
  const company = await resolveCompanyForSync(cache, rawCompanyName);
  const department = await resolveDepartmentForSync(cache, company?.id ?? null, rawDepartmentName);
  return { companyId: company?.id ?? null, companyName: company?.name ?? null, departmentId: department.id, departmentName: department.name };
}

// ─────────────────────────────────────────────────────────────────────────
// HR directory API (lib/services/hr-directory-sync-service.ts) resolution —
// a SEPARATE cache/function set from the Microsoft ones above, never mixed
// into the same signatures, since the two sources key on genuinely different
// identities (a real external integer id here vs. pure string-normalization
// above). Both still write to the exact same Company/Department tables and
// still never fabricate a BusinessUnit — only the match key differs.
// ─────────────────────────────────────────────────────────────────────────

export interface HrOrganizationResolutionCache {
  companyByHrId: Map<number, { id: string; name: string }>;
  companyByNormalizedName: Map<string, { id: string; name: string }>;
  departmentByHrId: Map<number, { id: string; name: string }>;
  departmentByCompanyAndNormalizedName: Map<string, { id: string; name: string }>;
}

export function createHrOrganizationResolutionCache(): HrOrganizationResolutionCache {
  return {
    companyByHrId: new Map(),
    companyByNormalizedName: new Map(),
    departmentByHrId: new Map(),
    departmentByCompanyAndNormalizedName: new Map(),
  };
}

/**
 * Finds or creates the Company for one HR API row's `CompanyId`/`Company` —
 * `hrCompanyId` is checked FIRST (a real, stable integer identity), falling
 * back to `normalizedName` matching only for a company that predates the HR
 * sync (e.g. matches an existing Microsoft-sourced or manually-created
 * company by name) — in which case `hrCompanyId` is backfilled onto that row
 * so every subsequent sync is an O(1) id lookup instead of a string match.
 * A missing/blank `hrCompanyId` AND name returns `null` — never persists a
 * fabricated company, same rule as resolveCompanyForSync.
 */
export async function resolveCompanyForHrSync(
  cache: HrOrganizationResolutionCache,
  hrCompanyId: number | null | undefined,
  rawCompanyName: string | null | undefined
): Promise<{ id: string; name: string } | null> {
  const name = rawCompanyName?.trim();
  if (!hrCompanyId && !name) return null;

  if (hrCompanyId) {
    const cachedById = cache.companyByHrId.get(hrCompanyId);
    if (cachedById) return cachedById;

    const existingById = await prisma.company.findUnique({ where: { hrCompanyId }, select: { id: true, name: true } });
    if (existingById) {
      cache.companyByHrId.set(hrCompanyId, existingById);
      return existingById;
    }
  }

  if (!name) {
    // Have an hrCompanyId but no usable name and no existing row to match —
    // genuinely nothing to create (Company.name is required).
    return null;
  }

  const normalizedName = normalizeCompanyName(name);
  const cachedByName = cache.companyByNormalizedName.get(normalizedName);
  if (cachedByName) {
    if (hrCompanyId) cache.companyByHrId.set(hrCompanyId, cachedByName);
    return cachedByName;
  }

  const existingByName = await prisma.company.findUnique({ where: { normalizedName }, select: { id: true, name: true, hrCompanyId: true } });
  if (existingByName) {
    const summary = { id: existingByName.id, name: existingByName.name };
    if (hrCompanyId && existingByName.hrCompanyId !== hrCompanyId) {
      // Backfill — a pre-HR-sync company matched by name, now linked to its
      // real external id so future syncs skip the name match entirely.
      await prisma.company.update({ where: { id: existingByName.id }, data: { hrCompanyId } }).catch(() => {
        // A race (another sync run linked it first, or a genuine duplicate
        // hrCompanyId conflict) degrades to "already linked by someone else" —
        // never a hard failure for what's otherwise a successful resolution.
      });
    }
    cache.companyByNormalizedName.set(normalizedName, summary);
    if (hrCompanyId) cache.companyByHrId.set(hrCompanyId, summary);
    return summary;
  }

  try {
    const created = await prisma.company.create({ data: { name, normalizedName, hrCompanyId: hrCompanyId ?? null } });
    const summary = { id: created.id, name: created.name };
    cache.companyByNormalizedName.set(normalizedName, summary);
    if (hrCompanyId) cache.companyByHrId.set(hrCompanyId, summary);
    return summary;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const retried = await prisma.company.findUnique({ where: { normalizedName }, select: { id: true, name: true } });
    if (!retried) throw err;
    cache.companyByNormalizedName.set(normalizedName, retried);
    if (hrCompanyId) cache.companyByHrId.set(hrCompanyId, retried);
    return retried;
  }
}

/** Same hrDepartmentId-first, normalizedName-fallback strategy as resolveCompanyForHrSync above, scoped to one Company via (companyId, normalizedName). */
export async function resolveDepartmentForHrSync(
  cache: HrOrganizationResolutionCache,
  companyId: string | null,
  hrDepartmentId: number | null | undefined,
  rawDepartmentName: string | null | undefined
): Promise<{ id: string; name: string }> {
  const name = rawDepartmentName?.trim() || UNASSIGNED_NODE_NAME;
  const normalizedName = normalizeDepartmentName(name);
  const cacheKey = `${companyId ?? "__no_company__"}:${normalizedName}`;

  if (hrDepartmentId) {
    const cachedById = cache.departmentByHrId.get(hrDepartmentId);
    if (cachedById) return cachedById;

    const existingById = await prisma.department.findUnique({ where: { hrDepartmentId }, select: { id: true, name: true } });
    if (existingById) {
      cache.departmentByHrId.set(hrDepartmentId, existingById);
      return existingById;
    }
  }

  const cachedByName = cache.departmentByCompanyAndNormalizedName.get(cacheKey);
  if (cachedByName) {
    if (hrDepartmentId) cache.departmentByHrId.set(hrDepartmentId, cachedByName);
    return cachedByName;
  }

  const existingByName = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true, hrDepartmentId: true } });
  if (existingByName) {
    const summary = { id: existingByName.id, name: existingByName.name };
    if (hrDepartmentId && existingByName.hrDepartmentId !== hrDepartmentId) {
      await prisma.department.update({ where: { id: existingByName.id }, data: { hrDepartmentId } }).catch(() => {
        // Same race tolerance as resolveCompanyForHrSync above.
      });
    }
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, summary);
    if (hrDepartmentId) cache.departmentByHrId.set(hrDepartmentId, summary);
    return summary;
  }

  try {
    const created = await createDepartment({ name, companyId, hrDepartmentId: hrDepartmentId ?? null });
    const summary = { id: created.id, name: created.name };
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, summary);
    if (hrDepartmentId) cache.departmentByHrId.set(hrDepartmentId, summary);
    return summary;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const retried = await prisma.department.findFirst({ where: { companyId, normalizedName }, select: { id: true, name: true } });
    if (!retried) throw err;
    cache.departmentByCompanyAndNormalizedName.set(cacheKey, retried);
    if (hrDepartmentId) cache.departmentByHrId.set(hrDepartmentId, retried);
    return retried;
  }
}

/** HR-sourced counterpart to resolveOrganizationPlacement above — resolves both levels in one call from one HR API row's CompanyId/Company/HrDepartmentId/Department fields. */
export async function resolveHrOrganizationPlacement(
  cache: HrOrganizationResolutionCache,
  hrCompanyId: number | null | undefined,
  rawCompanyName: string | null | undefined,
  hrDepartmentId: number | null | undefined,
  rawDepartmentName: string | null | undefined
): Promise<OrganizationPlacement> {
  const company = await resolveCompanyForHrSync(cache, hrCompanyId, rawCompanyName);
  const department = await resolveDepartmentForHrSync(cache, company?.id ?? null, hrDepartmentId, rawDepartmentName);
  return { companyId: company?.id ?? null, companyName: company?.name ?? null, departmentId: department.id, departmentName: department.name };
}
