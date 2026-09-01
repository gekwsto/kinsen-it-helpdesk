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

console.log("\n=== Category / SubCategory — CORRECTED: Category is the parent int id, SubCategory is free TEXT matched within that parent, never a numeric id ===\n");

// The 4 exact real examples from the migration-safety correction.
check(
  'Category=1, SubCategory="New Feature" -> New Feature (parent: Development)',
  resolveLegacyCategoryTarget(1, "New Feature").name === "New Feature" && resolveLegacyCategoryTarget(1, "New Feature").description.includes("Development")
);
check(
  'Category=2, SubCategory="Data" -> Data (parent: Reporting)',
  resolveLegacyCategoryTarget(2, "Data").name === "Data" && resolveLegacyCategoryTarget(2, "Data").description.includes("Reporting")
);
check(
  'Category=201, SubCategory="General" -> General (parent: Support)',
  resolveLegacyCategoryTarget(201, "General").name === "General" && resolveLegacyCategoryTarget(201, "General").description.includes("Support")
);
check(
  'Category=1, SubCategory="Bug/Error" -> Bug/Error (parent: Development)',
  resolveLegacyCategoryTarget(1, "Bug/Error").name === "Bug/Error" && resolveLegacyCategoryTarget(1, "Bug/Error").description.includes("Development")
);

// The remaining explicit map entries.
check('Category=1, SubCategory="Other" -> Other (parent: Development)', resolveLegacyCategoryTarget(1, "Other").name === "Other");
check('Category=2, SubCategory="Power BI Report" -> Power BI Report (parent: Reporting)', resolveLegacyCategoryTarget(2, "Power BI Report").name === "Power BI Report");
check('Category=201, SubCategory="Question" -> Question (parent: Support)', resolveLegacyCategoryTarget(201, "Question").name === "Question");

// Normalization: trim + case-insensitive, exact text match only.
check(
  'Category=1, SubCategory=" new feature " (lowercase, padded) -> still New Feature',
  resolveLegacyCategoryTarget(1, " new feature ").name === "New Feature"
);
check('Category=201, SubCategory="GENERAL" (uppercase) -> still General', resolveLegacyCategoryTarget(201, "GENERAL").name === "General");

// No SubCategory text at all -> falls back to the bare parent Category, not an error.
check(
  "Category=1, SubCategory=null -> bare parent Development (not an error)",
  resolveLegacyCategoryTarget(1, null).name === "Development" && resolveLegacyCategoryTarget(1, null).description.includes("no SubCategory text recorded")
);
check("Category=2, SubCategory='' (empty string) -> bare parent Reporting", resolveLegacyCategoryTarget(2, "").name === "Reporting");

// SubCategory text is scoped to its OWN parent — a text valid under one
// Category must NOT resolve under a different Category (never cross-matched).
threw = false;
try { resolveLegacyCategoryTarget(2, "New Feature"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check('Category=2, SubCategory="New Feature" (valid text, WRONG parent) throws — never cross-matched across categories', threw);

// Unrecognized SubCategory text for a Category that DOES exist -> hard error, never guessed.
threw = false;
try { resolveLegacyCategoryTarget(1, "Something Unrecognized"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unrecognized SubCategory text for a known Category throws — never guessed", threw);

// Category id outside {1, 2, 201} -> hard error regardless of SubCategory text.
threw = false;
try { resolveLegacyCategoryTarget(9999, null); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Unmapped Category id (9999) throws — never silently defaults to \"General\"", threw);
threw = false;
try { resolveLegacyCategoryTarget(null, "New Feature"); } catch (e) { threw = e instanceof LegacyEnumMappingError; }
check("Null Category id throws even when SubCategory text is present", threw);

console.log("\n=== allResolvedLegacyCategories — 3 bare parents + 7 distinct subcategory names, no more, no less ===\n");
const allCats = allResolvedLegacyCategories();
check("Exactly 10 target category rows (3 parents + 7 subcategories)", allCats.length === 10);
check("Names are exactly 10 distinct strings, no duplicates", new Set(allCats.map((c) => c.name)).size === 10);
check(
  "Set matches exactly {Development, Reporting, Support, New Feature, Other, Bug/Error, Power BI Report, Data, General, Question}",
  JSON.stringify(allCats.map((c) => c.name).sort()) ===
    JSON.stringify(["Development", "Reporting", "Support", "New Feature", "Other", "Bug/Error", "Power BI Report", "Data", "General", "Question"].sort())
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
