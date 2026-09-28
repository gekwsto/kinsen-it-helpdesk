/**
 * Shared, whitelist-only URL-driven sort resolver for the Projects and
 * Activities List views' clickable column headers. Deliberately NOT the
 * pattern app/(main)/tickets/page.tsx uses (`{ [sortBy]: sortDir }` — a raw
 * URL string used as a dynamic Prisma orderBy key, gated only by two
 * special-cased branches) — every allowed key here is an explicit,
 * pre-built Prisma `orderBy` fragment; a `sortBy` value that isn't a key of
 * the caller's own whitelist can never reach Prisma at all, it just falls
 * back — VERBATIM, not reconstructed — to the page's own pre-existing
 * canonical order (e.g. `[{ createdAt: "desc" }, { id: "asc" }]`), so a
 * missing/invalid `sortBy` behaves exactly as it always has.
 */

export type SortOrder = "asc" | "desc";

/** One sortable column: how to turn a direction into a real Prisma `orderBy` fragment. Kept as a function (not a static object) so a nullable column can attach `nulls: "last"` for a deterministic order regardless of direction. */
export type SortKeyDef = (order: SortOrder) => Record<string, unknown>;

export interface ResolvedSort<K extends string> {
  /** The whitelisted key actually in effect, or null when using the canonical default (no explicit/valid `sortBy` — no header should render as active). */
  key: K | null;
  order: SortOrder;
  /** Ready to pass straight to Prisma's `orderBy`. */
  orderBy: Record<string, unknown>[];
}

/**
 * Resolves `?sortBy=&sortOrder=` against `whitelist` (an object whose own
 * keys ARE the only accepted `sortBy` values). A `sortBy` that is missing
 * or not a whitelist key returns `fallbackOrderBy` UNCHANGED (`key: null`)
 * — the page's existing canonical order, never reconstructed or
 * approximated. A real whitelisted key defaults to ASCENDING (the first
 * click's direction); only an explicit `sortOrder=desc` flips it — clicking
 * the same active header again is what produces that `desc` in the URL.
 */
export function resolveListSort<K extends string>(
  whitelist: Record<K, SortKeyDef>,
  fallbackOrderBy: Record<string, unknown>[],
  rawKey: string | undefined,
  rawOrder: string | undefined
): ResolvedSort<K> {
  if (rawKey === undefined || !Object.prototype.hasOwnProperty.call(whitelist, rawKey)) {
    return { key: null, order: "asc", orderBy: fallbackOrderBy };
  }
  const key = rawKey as K;
  const order: SortOrder = rawOrder === "desc" ? "desc" : "asc";
  return { key, order, orderBy: [whitelist[key](order), { id: "asc" }] };
}
