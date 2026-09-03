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
// dbo.Tickets.Category is the INTEGER parent legacy Category id (1/2/201);
// dbo.Tickets.SubCategory is FREE TEXT (nvarchar), the subcategory's own
// Description string as typed on the ticket — NOT a numeric id. Neither is
// reliably populated: a REAL production dry-run proved 164/581 tickets have
// Category IS NULL, and dbo.Tickets.Categories (a separate free-text column,
// distinct from the Category int FK) is NULL on every one of those 164 too.
// Of those 164: 107 still carry a usable, exact SubCategory text; the
// remaining 57 have NO category information at all (Category, Categories,
// AND SubCategory all null) — including the two known no-creator tickets
// 6204 and 11802.
//
// Resolution is a 4-tier fallback, source-truth only, never a heuristic
// (never derived from title/description/Platform/user/dates) and never
// fuzzy-matched — see resolveLegacyCategoryTarget:
//   A. Category (int FK) present -> resolve exactly as before (SubCategory
//      text looked up only within THIS Category's own subcategory map).
//   B. Category NULL, Categories text present -> exact normalized match of
//      the Categories text against LEGACY_CATEGORY_NAMES (the SAME
//      authoritative table tier A trusts) resolves the parent; SubCategory
//      (if present) is then applied exactly as in tier A.
//   C. Category AND Categories both NULL, SubCategory text present ->
//      resolved via the closed, 1:1 reverse mapping (SubCategory text
//      uniquely identifies its parent Category in this dataset — see
//      LEGACY_SUBCATEGORY_TEXT_TO_CATEGORY), then the SAME target mapping
//      tier A would have produced with that parent present.
//   D. Category, Categories, AND SubCategory all absent -> NEVER guessed
//      into Development/Reporting/Support. Preserved instead under the
//      dedicated, idempotent "Legacy Uncategorized" target category
//      (LEGACY_UNCATEGORIZED_CATEGORY_NAME) — a migration-preservation
//      category, not a semantic classification.
// Any NON-EMPTY value that doesn't match the closed reference tables at any
// tier is a hard LegacyEnumMappingError — never guessed, never defaulted.
//
// dbo.Categories (broad grouping) still has no direct target representation
// — TicketCategory (the target model) is flat, one level, no parent/child.
// The legacy parent Category's name is preserved in the resolved
// TicketCategory's `description`.
export const LEGACY_CATEGORY_NAMES: Record<number, string> = {
  1: "Development",
  2: "Reporting",
  201: "Support",
};

/**
 * Explicit (parentCategoryId -> { normalizedSubCategoryText -> target name })
 * map, exactly matching the authoritative legacy reference mapping:
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

interface SubCategoryTextResolution {
  legacyCategoryId: number;
  targetName: string;
}

/**
 * The reverse of LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP — built once, from
 * that SAME table (never hand-duplicated, so the two can never drift), for
 * tier C: when Category and Categories are both absent, SubCategory text
 * alone must uniquely identify its parent. Throws AT MODULE LOAD TIME (not
 * per-ticket) if the source table ever stops being 1:1 — that would make
 * tier C's "unique identification" guarantee false, and this must fail
 * loudly at build time, never silently pick one parent per-ticket.
 */
const LEGACY_SUBCATEGORY_TEXT_TO_CATEGORY: Record<string, SubCategoryTextResolution> = (() => {
  const reverse: Record<string, SubCategoryTextResolution> = {};
  for (const [categoryIdStr, subMap] of Object.entries(LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP)) {
    const legacyCategoryId = Number(categoryIdStr);
    for (const [normalizedText, targetName] of Object.entries(subMap)) {
      const existing = reverse[normalizedText];
      if (existing) {
        throw new Error(
          `Internal consistency error in enum-maps.ts: SubCategory text "${normalizedText}" is mapped under more than one parent Category (${existing.legacyCategoryId} and ${legacyCategoryId}) — tier C (Category/Categories-absent fallback) requires this text to uniquely identify one parent. Fix LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP.`
        );
      }
      reverse[normalizedText] = { legacyCategoryId, targetName };
    }
  }
  return reverse;
})();

/** Dedicated, idempotent migration-preservation target category for tickets with NO category information at all (Category, Categories, and SubCategory all absent) — never a guess at Development/Reporting/Support. */
export const LEGACY_UNCATEGORIZED_CATEGORY_NAME = "Legacy Uncategorized";
const LEGACY_UNCATEGORIZED_CATEGORY_DESCRIPTION =
  'Migration-preservation category: the legacy TicketApp ticket record had no Category, Categories, or SubCategory value at all. This is NOT a semantic guess — these tickets are never silently classified into Development/Reporting/Support; they are preserved here explicitly instead.';

function normalizeSubCategoryText(value: string): string {
  return value.trim().toLowerCase();
}

export interface ResolvedLegacyCategory {
  /** Target TicketCategory.name */
  name: string;
  /** Target TicketCategory.description — records the legacy hierarchy this flat category came from, since the target schema has no parent/child category concept to represent it directly. */
  description: string;
}

/** Tier A/B shared logic: SubCategory text is looked up ONLY within the given parent's own subcategory map (never across parents) — an exact, case/whitespace-normalized match. A SubCategory value present but not recognized for that Category is a hard error. No SubCategory text at all resolves to the bare parent Category (a legitimate, narrower case, not an error). */
function resolveWithinParent(legacyCategoryId: number, parentName: string, trimmedSubCategory: string | null): ResolvedLegacyCategory {
  if (!trimmedSubCategory) {
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

/** Tier B: exact normalized match of the free-text Categories column against the SAME authoritative LEGACY_CATEGORY_NAMES table tier A trusts — never fuzzy. */
function resolveParentCategoryIdFromCategoriesText(trimmedCategoriesText: string): number {
  const normalized = trimmedCategoriesText.toLowerCase();
  const match = Object.entries(LEGACY_CATEGORY_NAMES).find(([, name]) => name.toLowerCase() === normalized);
  if (!match) {
    throw new LegacyEnumMappingError("CATEGORY", { legacyCategoriesText: trimmedCategoriesText, reason: "Categories text not recognized against the authoritative legacy category reference data" });
  }
  return Number(match[0]);
}

/**
 * Resolves a ticket's legacy category information to a target
 * TicketCategory via the 4-tier fallback documented in this section's
 * header comment (A: Category FK -> B: Categories text -> C: SubCategory
 * text alone -> D: Legacy Uncategorized). Any non-empty value unrecognized
 * at its tier is a hard LegacyEnumMappingError — never guessed.
 */
export function resolveLegacyCategoryTarget(
  legacyCategoryId: number | null | undefined,
  legacyCategoriesText: string | null | undefined,
  legacySubCategoryText: string | null | undefined
): ResolvedLegacyCategory {
  const trimmedSubCategory = legacySubCategoryText?.trim() || null;
  const trimmedCategoriesText = legacyCategoriesText?.trim() || null;

  // Tier A — the strong, explicit FK. Categories text is IGNORED when
  // present (Category always wins outright; the two are never blended).
  if (legacyCategoryId != null) {
    const parentName = LEGACY_CATEGORY_NAMES[legacyCategoryId];
    if (!parentName) {
      throw new LegacyEnumMappingError("CATEGORY", { legacyCategoryId, legacySubCategoryText: trimmedSubCategory });
    }
    return resolveWithinParent(legacyCategoryId, parentName, trimmedSubCategory);
  }

  // Tier B — Category is NULL, but the free-text Categories column names a
  // recognized parent directly.
  if (trimmedCategoriesText) {
    const resolvedParentId = resolveParentCategoryIdFromCategoriesText(trimmedCategoriesText);
    return resolveWithinParent(resolvedParentId, LEGACY_CATEGORY_NAMES[resolvedParentId], trimmedSubCategory);
  }

  // Tier C — Category AND Categories both NULL; SubCategory text alone,
  // resolved via the closed reverse mapping, then the exact same target
  // mapping tier A would have used with that parent present.
  if (trimmedSubCategory) {
    const resolution = LEGACY_SUBCATEGORY_TEXT_TO_CATEGORY[normalizeSubCategoryText(trimmedSubCategory)];
    if (!resolution) {
      throw new LegacyEnumMappingError("CATEGORY", {
        legacyCategoryId,
        legacyCategoriesText,
        legacySubCategoryText: trimmedSubCategory,
        reason: "SubCategory text not recognized and no Category/Categories value present to independently confirm a parent",
      });
    }
    return {
      name: resolution.targetName,
      description: `Migrated from legacy TicketApp SubCategory "${trimmedSubCategory}" (Category and Categories were both absent on this ticket; parent Category "${LEGACY_CATEGORY_NAMES[resolution.legacyCategoryId]}" inferred via the closed SubCategory->Category reference mapping, never guessed).`,
    };
  }

  // Tier D — no category information at all. Never a guess.
  return { name: LEGACY_UNCATEGORIZED_CATEGORY_NAME, description: LEGACY_UNCATEGORIZED_CATEGORY_DESCRIPTION };
}

/** The complete, closed set of target TicketCategory rows the migration ensures exist for the target department (Phase 4) — computed once from the explicit maps, not per-ticket. Includes the 3 bare parent categories, the 7 subcategory-derived ones, and the 1 "Legacy Uncategorized" preservation category (11 total). */
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
  results.push({ name: LEGACY_UNCATEGORIZED_CATEGORY_NAME, description: LEGACY_UNCATEGORIZED_CATEGORY_DESCRIPTION });
  return results;
}

// ─── Error type ─────────────────────────────────────────────────────────────
export class LegacyEnumMappingError extends Error {
  constructor(public readonly enumName: "STATUS" | "PRIORITY" | "CATEGORY", public readonly legacyValue: unknown) {
    super(`Unmapped legacy ${enumName} value: ${JSON.stringify(legacyValue)} — no explicit mapping exists. Refusing to guess.`);
    this.name = "LegacyEnumMappingError";
  }
}
