/**
 * Explicit, hardcoded source-enum -> target-shape maps for the one-time
 * legacy TicketApp migration (scripts/migrate-legacy-ticketapp.ts).
 *
 * Deliberately NOT derived from any heuristic (ticket title, free-text
 * legacy `Categories`/`SubCategory` string columns, etc.) — every mapping
 * here is a literal, closed lookup table matching the migration brief's
 * "SOURCE FACTS ALREADY PROVEN" section exactly. An enum value with no
 * entry here is a hard migration error (see resolveLegacyStatus etc. below
 * — each throws rather than guessing a plausible-looking default), never a
 * silent "General"/"Open"-style fallback.
 *
 * Pure, dependency-free, fully unit-testable — see
 * scripts/test-legacy-migration-enum-maps.ts.
 */

// ─── Status (dbo.Tickets.Status) ───────────────────────────────────────────
export const LEGACY_STATUS_NAMES: Record<number, string> = {
  0: "Open",
  1: "Under Development",
  2: "Cancelled",
  3: "Closed",
  4: "Draft",
  5: "Reopen",
  6: "Waiting Partner",
};

/** isClosed on the target TicketStatus row — Closed and Cancelled both terminate the ticket; every other legacy status is still an open/working state. */
export const LEGACY_STATUS_IS_CLOSED: Record<number, boolean> = {
  0: false,
  1: false,
  2: true,
  3: true,
  4: false,
  5: false,
  6: false,
};

export function resolveLegacyStatusName(legacyStatus: number | null | undefined): string {
  if (legacyStatus == null || !(legacyStatus in LEGACY_STATUS_NAMES)) {
    throw new LegacyEnumMappingError("STATUS", legacyStatus);
  }
  return LEGACY_STATUS_NAMES[legacyStatus];
}

export function resolveLegacyStatusIsClosed(legacyStatus: number | null | undefined): boolean {
  if (legacyStatus == null || !(legacyStatus in LEGACY_STATUS_IS_CLOSED)) {
    throw new LegacyEnumMappingError("STATUS", legacyStatus);
  }
  return LEGACY_STATUS_IS_CLOSED[legacyStatus];
}

// ─── Priority (dbo.Tickets.Priority) ───────────────────────────────────────
export const LEGACY_PRIORITY_NAMES: Record<number, { name: string; level: number; color: string }> = {
  0: { name: "Low", level: 1, color: "#22c55e" },
  1: { name: "Medium", level: 2, color: "#eab308" },
  2: { name: "High", level: 3, color: "#f97316" },
};

export function resolveLegacyPriority(legacyPriority: number | null | undefined): { name: string; level: number; color: string } {
  if (legacyPriority == null || !(legacyPriority in LEGACY_PRIORITY_NAMES)) {
    throw new LegacyEnumMappingError("PRIORITY", legacyPriority);
  }
  return LEGACY_PRIORITY_NAMES[legacyPriority];
}

// ─── Platform (dbo.Tickets.Platform) — NO target Ticket column exists for
// this concept. Gap handled the "safest repository-consistent" way: recorded
// as text in the initial TicketHistory "CREATED" entry's description
// (lib/services/legacy-migration/ticket-import.ts), never invented as a new
// column, never dropped silently. ────────────────────────────────────────
export const LEGACY_PLATFORM_NAMES: Record<number, string> = {
  0: "CRM",
  1: "Estimate",
  2: "CarStock",
  3: "Wheelsys",
  4: "Other",
};

/** Unlike Status/Priority/Category, an unrecognized/null Platform is NOT a hard error — it's cosmetic metadata with no target column, so a missing value just means the CREATED history note omits it. */
export function resolveLegacyPlatformName(legacyPlatform: number | null | undefined): string | null {
  if (legacyPlatform == null) return null;
  return LEGACY_PLATFORM_NAMES[legacyPlatform] ?? `Unknown legacy platform (${legacyPlatform})`;
}

// ─── Category / SubCategory ────────────────────────────────────────────────
// CORRECTED source shape (confirmed against the actual dbo.Tickets/
// dbo.SubCategories schema — see the migration brief's follow-up
// correction): dbo.Tickets.Category is the INTEGER parent legacy Category
// id (1/2/201); dbo.Tickets.SubCategory is FREE TEXT (nvarchar), the
// subcategory's own Description string as typed on the ticket — NOT a
// numeric id into dbo.SubCategories.Id. An earlier version of this module
// incorrectly treated a numeric SubCategory-id space as authoritative; that
// was wrong and has been replaced entirely by this text-based resolution.
//
// dbo.Categories (broad grouping) still has no direct target representation
// — TicketCategory (the target model) is flat, one level, no parent/child.
// The migration maps each (Category id, SubCategory text) PAIR to one
// target TicketCategory, and preserves the legacy parent Category's name in
// that TicketCategory's `description` — see resolveLegacyCategoryTarget.
export const LEGACY_CATEGORY_NAMES: Record<number, string> = {
  1: "Development",
  2: "Reporting",
  201: "Support",
};

/**
 * Explicit (parentCategoryId -> { normalizedSubCategoryText -> target name })
 * map, exactly matching the migration brief's proven real-world examples:
 *   Development(1): New Feature, Other, Bug/Error
 *   Reporting(2):   Power BI Report, Data
 *   Support(201):   General, Question
 * Keys are normalized (trim + lowercase) so "New Feature", "new feature",
 * and " New Feature " all resolve identically — this is a closed, explicit
 * lookup table, never a fuzzy/partial match.
 */
export const LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP: Record<number, Record<string, string>> = {
  1: { "new feature": "New Feature", other: "Other", "bug/error": "Bug/Error" },
  2: { "power bi report": "Power BI Report", data: "Data" },
  201: { general: "General", question: "Question" },
};

function normalizeSubCategoryText(value: string): string {
  return value.trim().toLowerCase();
}

export interface ResolvedLegacyCategory {
  /** Target TicketCategory.name */
  name: string;
  /** Target TicketCategory.description — records the legacy hierarchy this flat category came from, since the target schema has no parent/child category concept to represent it directly. */
  description: string;
}

/**
 * Resolves a ticket's (Category id, SubCategory text) pair to a target
 * TicketCategory. The SubCategory text is looked up ONLY within the map
 * entry for its OWN ticket's Category id (never across parents) — an exact,
 * case/whitespace-normalized match against the closed table above. A
 * SubCategory value present but not recognized for that Category, or a
 * Category id outside {1, 2, 201}, is a hard error (LegacyEnumMappingError)
 * — never guessed, never defaulted to a generic "General" category. A
 * ticket with a recognized Category id but NO SubCategory text at all
 * resolves to the parent Category itself (a legitimate, narrower case, not
 * an error).
 */
export function resolveLegacyCategoryTarget(legacyCategoryId: number | null | undefined, legacySubCategoryText: string | null | undefined): ResolvedLegacyCategory {
  if (legacyCategoryId == null) {
    throw new LegacyEnumMappingError("CATEGORY", { legacyCategoryId, legacySubCategoryText });
  }
  const parentName = LEGACY_CATEGORY_NAMES[legacyCategoryId];
  if (!parentName) {
    throw new LegacyEnumMappingError("CATEGORY", { legacyCategoryId, legacySubCategoryText });
  }

  const trimmedSubCategory = legacySubCategoryText?.trim();
  if (!trimmedSubCategory) {
    // No SubCategory text at all — the ticket is classified only at the
    // parent Category level.
    return { name: parentName, description: `Migrated from legacy TicketApp Category "${parentName}" (no SubCategory text recorded on this ticket).` };
  }

  const subCategoryMapForParent = LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP[legacyCategoryId] ?? {};
  const targetName = subCategoryMapForParent[normalizeSubCategoryText(trimmedSubCategory)];
  if (!targetName) {
    throw new LegacyEnumMappingError("CATEGORY", { legacyCategoryId, legacySubCategoryText: trimmedSubCategory, reason: "SubCategory text not recognized for this Category" });
  }

  return {
    name: targetName,
    description: `Migrated from legacy TicketApp SubCategory "${trimmedSubCategory}" (parent Category: ${parentName}).`,
  };
}

/** The complete, closed set of target TicketCategory rows the migration ensures exist for the target department (Phase 4) — computed once from the explicit map, not per-ticket. Includes the 3 bare parent categories (for tickets with a Category but no SubCategory text) plus the 7 subcategory-derived ones. */
export function allResolvedLegacyCategories(): ResolvedLegacyCategory[] {
  const results: ResolvedLegacyCategory[] = [];
  for (const [categoryIdStr, parentName] of Object.entries(LEGACY_CATEGORY_NAMES)) {
    const categoryId = Number(categoryIdStr);
    results.push({ name: parentName, description: `Migrated from legacy TicketApp Category "${parentName}" (no SubCategory text recorded on this ticket).` });
    const subMap = LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP[categoryId] ?? {};
    for (const targetName of new Set(Object.values(subMap))) {
      results.push({ name: targetName, description: `Migrated from legacy TicketApp SubCategory "${targetName}" (parent Category: ${parentName}).` });
    }
  }
  return results;
}

// ─── Error type ─────────────────────────────────────────────────────────────
export class LegacyEnumMappingError extends Error {
  constructor(public readonly enumName: "STATUS" | "PRIORITY" | "CATEGORY", public readonly legacyValue: unknown) {
    super(`Unmapped legacy ${enumName} value: ${JSON.stringify(legacyValue)} — no explicit mapping exists. Refusing to guess.`);
    this.name = "LegacyEnumMappingError";
  }
}
