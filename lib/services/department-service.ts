import { cache } from "react";
import { prisma } from "@/lib/prisma";
import type { Department } from "@prisma/client";
import type { DepartmentSummary, DepartmentWithCounts } from "@/types/department";

// Slug of the department legacy (pre-Phase-1) rows fall back to for scoping
// purposes — never a raw literal id, so it stays correct if the bootstrap
// department's id ever differs across environments. Overridable so a
// deployment without an "it" department can point this at whatever their
// actual default is.
const DEFAULT_LEGACY_DEPARTMENT_SLUG = process.env.DEFAULT_DEPARTMENT_SLUG || "it";

// Pure data-access helpers for the Department entity. Callers are
// responsible for their own authorization (e.g. requireAdmin() for
// create/update/setActive) — this module has no permission checks baked in,
// matching the rest of this codebase's service-layer convention.

// Exported so other callers that need to derive the same slug a department
// would get (e.g. microsoft-department-autocreate-service.ts, checking for
// an existing department before creating a new one) use the identical
// algorithm rather than a second, potentially-diverging copy.
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Generates a unique slug for a department name, appending -2, -3, ... on collision. */
async function generateUniqueSlug(name: string, excludeId?: string): Promise<string> {
  const base = slugify(name) || "department";
  let candidate = base;
  let suffix = 2;
  // Bounded by the number of existing collisions — not a realistic infinite loop.
  while (
    await prisma.department.findFirst({
      where: { slug: candidate, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
      select: { id: true },
    })
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function listDepartments(options?: { includeInactive?: boolean }): Promise<DepartmentWithCounts[]> {
  return prisma.department.findMany({
    where: options?.includeInactive ? undefined : { isActive: true },
    orderBy: { name: "asc" },
    include: {
      businessUnit: { select: { id: true, name: true } },
      _count: { select: { users: true, tickets: true } },
    },
  });
}

export async function getDepartmentById(id: string): Promise<Department | null> {
  return prisma.department.findUnique({ where: { id } });
}

export async function getDepartmentBySlug(slug: string): Promise<Department | null> {
  return prisma.department.findUnique({ where: { slug } });
}

export interface CreateDepartmentInput {
  name: string;
  description?: string | null;
  businessUnitId?: string | null;
  /** Explicit slug override; auto-generated from `name` (collision-checked) if omitted. */
  slug?: string;
}

export async function createDepartment(input: CreateDepartmentInput): Promise<Department> {
  const slug = input.slug ? slugify(input.slug) : await generateUniqueSlug(input.name);
  return prisma.department.create({
    data: {
      name: input.name,
      slug,
      description: input.description ?? null,
      businessUnitId: input.businessUnitId ?? null,
    },
  });
}

export interface UpdateDepartmentInput {
  name?: string;
  description?: string | null;
  businessUnitId?: string | null;
}

export async function updateDepartment(id: string, patch: UpdateDepartmentInput): Promise<Department> {
  return prisma.department.update({
    where: { id },
    data: patch,
  });
}

export async function setDepartmentActive(id: string, isActive: boolean): Promise<Department> {
  return prisma.department.update({ where: { id }, data: { isActive } });
}

export function toDepartmentSummary(department: DepartmentSummary): DepartmentSummary {
  return {
    id: department.id,
    name: department.name,
    slug: department.slug,
    description: department.description,
    isActive: department.isActive,
    businessUnitId: department.businessUnitId,
  };
}

/**
 * Resolves the id of the department that pre-Phase-1 rows (NULL
 * departmentId on Ticket/Project/ProjectActivity) are treated as belonging
 * to for scoping purposes, per the documented legacy-fallback rule — looked
 * up by slug, never a hardcoded id. Returns null if no such department
 * exists (e.g. a fresh environment without the bootstrap seed), in which
 * case legacy null rows are simply invisible to non-admins rather than
 * guessed at — a safe default, not a crash.
 * Request-deduplicated with React cache(), matching getPermissionsForRole.
 */
export const getDefaultLegacyDepartmentId = cache(async (): Promise<string | null> => {
  const department = await prisma.department.findUnique({
    where: { slug: DEFAULT_LEGACY_DEPARTMENT_SLUG },
    select: { id: true },
  });
  return department?.id ?? null;
});
