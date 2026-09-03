/**
 * Pure-logic regression coverage for
 * lib/services/legacy-migration/enum-maps.ts — no DB, no network.
 *
 * Usage: npx tsx scripts/test-legacy-migration-enum-maps.ts
 */
import {
  resolveLegacyStatusName,
  resolveLegacyStatusIsClosed,
  resolveLegacyPriority,
  resolveLegacyPlatformName,
  resolveLegacyCategoryTarget,
  allResolvedLegacyCategories,
  LEGACY_UNCATEGORIZED_CATEGORY_NAME,
  LegacyEnumMappingError,
} from "@/lib/services/legacy-migration/enum-maps";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log("\n=== Status (0-6) ===\n");
check("0 -> Open, not closed", resolveLegacyStatusName(0) === "Open" && !resolveLegacyStatusIsClosed(0));
check("1 -> Under Development, not closed", resolveLegacyStatusName(1) === "Under Development" && !resolveLegacyStatusIsClosed(1));
check("2 -> Cancelled, IS closed", resolveLegacyStatusName(2) === "Cancelled" && resolveLegacyStatusIsClosed(2));
check("3 -> Closed, IS closed", resolveLegacyStatusName(3) === "Closed" && resolveLegacyStatusIsClosed(3));
check("4 -> Draft, not closed", resolveLegacyStatusName(4) === "Draft" && !resolveLegacyStatusIsClosed(4));
check("5 -> Reopen, not closed", resolveLegacyStatusName(5) === "Reopen" && !resolveLegacyStatusIsClosed(5));
check("6 -> Waiting Partner, not closed", resolveLegacyStatusName(6) === "Waiting Partner" && !resolveLegacyStatusIsClosed(6));

let threw = false;
try { resolveLegacyStatusName(7); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unmapped status value (7) throws LegacyEnumMappingError, never a guessed default", threw);
threw = false;
try { resolveLegacyStatusName(null); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Null status throws (never silently defaults to Open)", threw);

console.log("\n=== Priority (0-2) ===\n");
check("0 -> Low, level 1", resolveLegacyPriority(0).name === "Low" && resolveLegacyPriority(0).level === 1);
check("1 -> Medium, level 2", resolveLegacyPriority(1).name === "Medium" && resolveLegacyPriority(1).level === 2);
check("2 -> High, level 3", resolveLegacyPriority(2).name === "High" && resolveLegacyPriority(2).level === 3);
threw = false;
try { resolveLegacyPriority(3); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unmapped priority value (3) throws", threw);

console.log("\n=== Platform (0-4) — cosmetic only, never a hard error ===\n");
check("0 -> CRM", resolveLegacyPlatformName(0) === "CRM");
check("1 -> Estimate", resolveLegacyPlatformName(1) === "Estimate");
check("2 -> CarStock", resolveLegacyPlatformName(2) === "CarStock");
check("3 -> Wheelsys", resolveLegacyPlatformName(3) === "Wheelsys");
check("4 -> Other", resolveLegacyPlatformName(4) === "Other");
check("null Platform -> null (never throws — no target column exists for this concept)", resolveLegacyPlatformName(null) === null);
check("Unknown platform value doesn't throw (cosmetic-only degrades gracefully)", resolveLegacyPlatformName(99) === "Unknown legacy platform (99)");

console.log("\n=== Category / SubCategory — TIER A: Category (int FK) present, resolution unchanged ===\n");

// The 4 exact real examples from the migration-safety correction.
check(
  'Category=1, SubCategory="New Feature" -> New Feature (parent: Development)',
  resolveLegacyCategoryTarget(1, null, "New Feature").name === "New Feature" && resolveLegacyCategoryTarget(1, null, "New Feature").description.includes("Development")
);
check(
  'Category=2, SubCategory="Data" -> Data (parent: Reporting)',
  resolveLegacyCategoryTarget(2, null, "Data").name === "Data" && resolveLegacyCategoryTarget(2, null, "Data").description.includes("Reporting")
);
check(
  'Category=201, SubCategory="General" -> General (parent: Support)',
  resolveLegacyCategoryTarget(201, null, "General").name === "General" && resolveLegacyCategoryTarget(201, null, "General").description.includes("Support")
);
check(
  'Category=1, SubCategory="Bug/Error" -> Bug/Error (parent: Development)',
  resolveLegacyCategoryTarget(1, null, "Bug/Error").name === "Bug/Error" && resolveLegacyCategoryTarget(1, null, "Bug/Error").description.includes("Development")
);

// The remaining explicit map entries.
check('Category=1, SubCategory="Other" -> Other (parent: Development)', resolveLegacyCategoryTarget(1, null, "Other").name === "Other");
check('Category=2, SubCategory="Power BI Report" -> Power BI Report (parent: Reporting)', resolveLegacyCategoryTarget(2, null, "Power BI Report").name === "Power BI Report");
check('Category=201, SubCategory="Question" -> Question (parent: Support)', resolveLegacyCategoryTarget(201, null, "Question").name === "Question");

// Normalization: trim + case-insensitive, exact text match only.
check(
  'Category=1, SubCategory=" new feature " (lowercase, padded) -> still New Feature',
  resolveLegacyCategoryTarget(1, null, " new feature ").name === "New Feature"
);
check('Category=201, SubCategory="GENERAL" (uppercase) -> still General', resolveLegacyCategoryTarget(201, null, "GENERAL").name === "General");

// No SubCategory text at all -> falls back to the bare parent Category, not an error.
check(
  "Category=1, SubCategory=null -> bare parent Development (not an error)",
  resolveLegacyCategoryTarget(1, null, null).name === "Development" && resolveLegacyCategoryTarget(1, null, null).description.includes("no SubCategory text recorded")
);
check("Category=2, SubCategory='' (empty string) -> bare parent Reporting", resolveLegacyCategoryTarget(2, null, "").name === "Reporting");

// Categories text is IGNORED when Category (the FK) is present — Category
// always wins outright, the two are never blended.
check(
  "Category=1 present -> Categories text is ignored even if it names a DIFFERENT parent",
  resolveLegacyCategoryTarget(1, "Support", null).name === "Development"
);

// SubCategory text is scoped to its OWN parent — a text valid under one
// Category must NOT resolve under a different Category (never cross-matched).
threw = false;
try { resolveLegacyCategoryTarget(2, null, "New Feature"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check('Category=2, SubCategory="New Feature" (valid text, WRONG parent) throws — never cross-matched across categories', threw);

// Unrecognized SubCategory text for a Category that DOES exist -> hard error, never guessed.
threw = false;
try { resolveLegacyCategoryTarget(1, null, "Something Unrecognized"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unrecognized SubCategory text for a known Category throws — never guessed", threw);

// Category id outside {1, 2, 201} -> hard error regardless of SubCategory text.
threw = false;
try { resolveLegacyCategoryTarget(9999, null, null); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check('Unmapped Category id (9999) throws — never silently defaults to "General"', threw);

console.log("\n=== TIER B: Category NULL, Categories text present — resolved by exact match against the authoritative reference table ===\n");
check(
  'Category=null, Categories="Development" -> bare parent Development',
  resolveLegacyCategoryTarget(null, "Development", null).name === "Development"
);
check(
  'Category=null, Categories="reporting" (case-insensitive) -> Reporting',
  resolveLegacyCategoryTarget(null, "reporting", null).name === "Reporting"
);
check(
  'Category=null, Categories="Support" + SubCategory="Question" -> Question (SubCategory still applied within the Categories-resolved parent)',
  resolveLegacyCategoryTarget(null, "Support", "Question").name === "Question"
);
threw = false;
try { resolveLegacyCategoryTarget(null, "Not A Real Category", null); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unrecognized Categories text throws — never fuzzy-matched", threw);

console.log("\n=== TIER C: Category AND Categories both NULL — SubCategory text alone resolves via the closed 1:1 reverse mapping (real production dry-run: 107/164 null-Category tickets) ===\n");
const tierCCases: Array<[string, string]> = [
  ["General", "Support"],
  ["New Feature", "Development"],
  ["Data", "Reporting"],
  ["Power BI Report", "Reporting"],
  ["Other", "Development"],
  ["Bug/Error", "Development"],
  ["Question", "Support"],
];
for (const [subCategoryText, expectedParent] of tierCCases) {
  const resolved = resolveLegacyCategoryTarget(null, null, subCategoryText);
  check(
    `Category=null, Categories=null, SubCategory="${subCategoryText}" -> ${subCategoryText} (parent inferred: ${expectedParent})`,
    resolved.name === subCategoryText && resolved.description.includes(expectedParent) && resolved.description.includes("both absent")
  );
}
// Case/whitespace normalization applies identically in tier C.
check(
  'Category=null, Categories=null, SubCategory=" general " -> still General (normalized)',
  resolveLegacyCategoryTarget(null, null, " general ").name === "General"
);
// Unknown/ambiguous SubCategory text with no Category/Categories to confirm a parent -> hard failure, never guessed.
threw = false;
try { resolveLegacyCategoryTarget(null, null, "Totally Unknown Text"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Category=null, Categories=null, unrecognized SubCategory text throws — never guessed", threw);

console.log('\n=== TIER D: Category, Categories, AND SubCategory ALL absent -> dedicated "Legacy Uncategorized" preservation category, NEVER a guess (real production dry-run: 57/164 null-Category tickets, including tickets 6204 and 11802) ===\n');
const uncategorized = resolveLegacyCategoryTarget(null, null, null);
check(`All three absent -> name is exactly "${LEGACY_UNCATEGORIZED_CATEGORY_NAME}"`, uncategorized.name === LEGACY_UNCATEGORIZED_CATEGORY_NAME);
check("Legacy Uncategorized is NEVER Development/Reporting/Support — it is its own dedicated category", !["Development", "Reporting", "Support"].includes(uncategorized.name));
check("Legacy Uncategorized's description explicitly states no category/subcategory information existed", uncategorized.description.toLowerCase().includes("no category") || uncategorized.description.toLowerCase().includes("no ") && uncategorized.description.includes("SubCategory"));
check("All-absent case does NOT throw (tier D is a legitimate resolution, not an error)", (() => {
  try { resolveLegacyCategoryTarget(null, null, null); return true; } catch { return false; }
})());
// Idempotent/deterministic: calling it again for the same all-absent input produces the identical target category.
check("Tier D is deterministic across repeated calls (idempotent target category, never re-derived differently)", resolveLegacyCategoryTarget(null, null, null).name === resolveLegacyCategoryTarget(undefined, undefined, undefined).name);

console.log("\n=== allResolvedLegacyCategories — 3 bare parents + 7 subcategories + 1 Legacy Uncategorized, no more, no less ===\n");
const allCats = allResolvedLegacyCategories();
check("Exactly 11 target category rows (3 parents + 7 subcategories + 1 Legacy Uncategorized)", allCats.length === 11);
check("Names are exactly 11 distinct strings, no duplicates", new Set(allCats.map((c) => c.name)).size === 11);
check(
  "Set matches exactly {Development, Reporting, Support, New Feature, Other, Bug/Error, Power BI Report, Data, General, Question, Legacy Uncategorized}",
  JSON.stringify(allCats.map((c) => c.name).sort()) ===
    JSON.stringify(
      ["Development", "Reporting", "Support", "New Feature", "Other", "Bug/Error", "Power BI Report", "Data", "General", "Question", LEGACY_UNCATEGORIZED_CATEGORY_NAME].sort()
    )
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
