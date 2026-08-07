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
