/**
 * Phase 4 — explicit reference-data mapping: ensures the target department
 * owns one TicketStatus row per legacy Status value, one TicketPriority row
 * per legacy Priority value, and one TicketCategory row per entry returned
 * by enum-maps.ts's allResolvedLegacyCategories() — the 3 bare parent
 * categories, the 7 subcategory-derived ones, and the 1 dedicated "Legacy
 * Uncategorized" preservation category (11 total; see enum-maps.ts's
 * Category/SubCategory header comment for the full 4-tier resolution this
 * mirrors). TicketCategory/TicketPriority/TicketStatus are all
 * required-departmentId models in the current schema (no more global/shared
 * row) — every row this creates is scoped to LEGACY_MIGRATION_DEPARTMENT_ID.
 *
 * find-by-(departmentId, name) then create-or-reuse-by-id — idempotent by
 * construction, safe to call on every migration run (including a resumed
 * one) without duplicating rows.
 */
import type { PrismaClient } from "@prisma/client";
import {
  LEGACY_STATUS_NAMES,
  LEGACY_STATUS_IS_CLOSED,
  LEGACY_PRIORITY_NAMES,
  allResolvedLegacyCategories,
} from "@/lib/services/legacy-migration/enum-maps";

export interface ReferenceDataMaps {
  statusIdByLegacyStatus: Map<number, string>;
  priorityIdByLegacyPriority: Map<number, string>;
  categoryIdByName: Map<string, string>;
}

const STATUS_COLORS: Record<number, string> = {
  0: "#6366f1", // Open
  1: "#3b82f6", // Under Development
  2: "#ef4444", // Cancelled
  3: "#22c55e", // Closed
  4: "#94a3b8", // Draft
  5: "#f97316", // Reopen
  6: "#eab308", // Waiting Partner
};

export async function ensureReferenceData(db: PrismaClient, targetDepartmentId: string, dryRun: boolean): Promise<ReferenceDataMaps> {
  const statusIdByLegacyStatus = new Map<number, string>();
  const priorityIdByLegacyPriority = new Map<number, string>();
  const categoryIdByName = new Map<string, string>();

  for (const [legacyStatusStr, name] of Object.entries(LEGACY_STATUS_NAMES)) {
    const legacyStatus = Number(legacyStatusStr);
    const isClosed = LEGACY_STATUS_IS_CLOSED[legacyStatus];
    if (dryRun) {
      const existing = await db.ticketStatus.findUnique({ where: { departmentId_name: { departmentId: targetDepartmentId, name } } });
      statusIdByLegacyStatus.set(legacyStatus, existing?.id ?? `dry-run:status:${name}`);
      continue;
    }
    const status = await db.ticketStatus.upsert({
      where: { departmentId_name: { departmentId: targetDepartmentId, name } },
      update: { isClosed, isActive: true },
      create: {
        departmentId: targetDepartmentId,
        name,
        color: STATUS_COLORS[legacyStatus] ?? "#6366f1",
        isClosed,
        isActive: true,
        isDefault: legacyStatus === 0,
        order: legacyStatus,
      },
    });
    statusIdByLegacyStatus.set(legacyStatus, status.id);
  }

  for (const [legacyPriorityStr, p] of Object.entries(LEGACY_PRIORITY_NAMES)) {
    const legacyPriority = Number(legacyPriorityStr);
    if (dryRun) {
      const existing = await db.ticketPriority.findFirst({ where: { departmentId: targetDepartmentId, name: p.name } });
      priorityIdByLegacyPriority.set(legacyPriority, existing?.id ?? `dry-run:priority:${p.name}`);
      continue;
    }
    const existing = await db.ticketPriority.findFirst({ where: { departmentId: targetDepartmentId, name: p.name } });
    const priority = existing
      ? await db.ticketPriority.update({ where: { id: existing.id }, data: { level: p.level, color: p.color, isActive: true } })
      : await db.ticketPriority.create({ data: { departmentId: targetDepartmentId, name: p.name, level: p.level, color: p.color, isActive: true } });
    priorityIdByLegacyPriority.set(legacyPriority, priority.id);
  }

  for (const cat of allResolvedLegacyCategories()) {
    if (dryRun) {
      const existing = await db.ticketCategory.findUnique({ where: { departmentId_name: { departmentId: targetDepartmentId, name: cat.name } } });
      categoryIdByName.set(cat.name, existing?.id ?? `dry-run:category:${cat.name}`);
      continue;
    }
    const category = await db.ticketCategory.upsert({
      where: { departmentId_name: { departmentId: targetDepartmentId, name: cat.name } },
      update: { description: cat.description, isActive: true },
      create: { departmentId: targetDepartmentId, name: cat.name, description: cat.description, isActive: true },
    });
    categoryIdByName.set(cat.name, category.id);
  }

  return { statusIdByLegacyStatus, priorityIdByLegacyPriority, categoryIdByName };
}
