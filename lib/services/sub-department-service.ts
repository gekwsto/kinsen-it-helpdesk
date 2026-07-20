import { prisma } from "@/lib/prisma";
import type { SubDepartment } from "@prisma/client";
import { slugify } from "@/lib/services/department-service";

// Pure data-access helpers for the SubDepartment entity — mirrors
// department-service.ts's shape exactly. Callers own their own
// authorization (requireDepartmentPermission(departmentId, "subdepartment.*"))
// — this module has no permission checks baked in.

export interface SubDepartmentSummary {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  isActive: boolean;
  departmentId: string;
}

export function toSubDepartmentSummary(sd: SubDepartment): SubDepartmentSummary {
  return {
    id: sd.id,
    name: sd.name,
    slug: sd.slug,
    description: sd.description,
    isActive: sd.isActive,
    departmentId: sd.departmentId,
  };
}

export async function listSubDepartments(
  departmentId: string,
  options?: { includeInactive?: boolean }
): Promise<SubDepartmentSummary[]> {
  const rows = await prisma.subDepartment.findMany({
    where: { departmentId, ...(options?.includeInactive ? {} : { isActive: true }) },
    orderBy: { name: "asc" },
  });
  return rows.map(toSubDepartmentSummary);
}

export async function getSubDepartmentById(id: string): Promise<SubDepartment | null> {
  return prisma.subDepartment.findUnique({ where: { id } });
}

export interface CreateSubDepartmentInput {
  departmentId: string;
  name: string;
  description?: string | null;
}

export async function createSubDepartment(input: CreateSubDepartmentInput): Promise<SubDepartment> {
  return prisma.subDepartment.create({
    data: {
      departmentId: input.departmentId,
      name: input.name,
      slug: slugify(input.name),
      description: input.description ?? null,
    },
  });
}

export interface UpdateSubDepartmentInput {
  name?: string;
  description?: string | null;
}

export async function updateSubDepartment(id: string, patch: UpdateSubDepartmentInput): Promise<SubDepartment> {
  return prisma.subDepartment.update({
    where: { id },
    data: {
      ...patch,
      ...(patch.name !== undefined ? { slug: slugify(patch.name) } : {}),
    },
  });
}

export async function setSubDepartmentActive(id: string, isActive: boolean): Promise<SubDepartment> {
  return prisma.subDepartment.update({ where: { id }, data: { isActive } });
}

/**
 * The core cross-entity rule this feature repeats everywhere a Ticket/
 * Project/ProjectActivity gets a subDepartmentId: it must belong to the
 * SAME departmentId as the entity. `departmentId: null`/`undefined` means
 * "no department context yet" — in that case a subDepartmentId can never be
 * valid (a sub-department always belongs to some department).
 */
export async function validateSubDepartmentInDepartment(
  subDepartmentId: string,
  departmentId: string | null | undefined
): Promise<boolean> {
  if (!departmentId) return false;
  const subDepartment = await prisma.subDepartment.findUnique({
    where: { id: subDepartmentId },
    select: { departmentId: true },
  });
  return subDepartment?.departmentId === departmentId;
}
