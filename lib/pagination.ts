/**
 * Framework-agnostic pagination math — shared by the Server Component that
 * runs the Prisma query (parses/validates URL params, decides whether a
 * canonical redirect is needed) and the Client Component that renders the
 * controls (page-number/ellipsis windowing). One source of truth so the
 * two can never silently disagree on what a given page/pageSize means.
 */

export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 20;
export const DEFAULT_PAGE = 1;

/** True only for a finite, positive integer — rejects NaN, negatives, zero, floats, Infinity. */
function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0 && Number.isFinite(n);
}

/**
 * Parses a `?page=` URL param. Any value that isn't a positive integer
 * (missing, non-numeric, negative, zero, a float, "NaN", trailing garbage
 * like "2abc") safely falls back to page 1 — never throws, never produces
 * a negative skip.
 */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return DEFAULT_PAGE;
  // Number() (not parseInt) so trailing-garbage strings like "2abc" are
  // rejected outright rather than silently truncated to 2.
  const n = Number(value);
  return isPositiveInteger(n) ? n : DEFAULT_PAGE;
}

/**
 * Parses a `?pageSize=` URL param against the allowed set (20/50/100) —
 * anything else (missing, invalid, or a technically-valid-looking integer
 * outside the allowlist, e.g. 1000000) safely falls back to the default
 * rather than letting a caller force an unbounded page size.
 */
export function parsePageSizeParam(raw: string | string[] | undefined): PageSize {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return DEFAULT_PAGE_SIZE;
  const n = Number(value);
  if (!isPositiveInteger(n)) return DEFAULT_PAGE_SIZE;
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  /** 1-indexed position of the first item on this page, for "Showing X–Y of Z" — 0 when totalCount is 0. */
  startIndex: number;
  /** 1-indexed position of the last item on this page. */
  endIndex: number;
}

/**
 * Given an already-syntactically-valid page/pageSize (see the parse*
 * functions above) and the real totalCount from the database, computes
 * every derived pagination value a caller needs — including whether the
 * requested page is out of range. totalCount === 0 always canonicalizes to
 * page 1 (never page 0, never an unreachable page), per the "empty result
 * set" requirement.
 */
export function computePagination(totalCount: number, requestedPage: number, pageSize: number): PaginationMeta {
  const totalPages = totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const startIndex = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
    startIndex,
    endIndex,
  };
}

/** True when the requested page needed to be clamped down — the caller should issue a canonical redirect instead of rendering. */
export function isOutOfRange(requestedPage: number, meta: PaginationMeta): boolean {
  return requestedPage !== meta.page;
}

export type PageToken = number | "ellipsis";

/**
 * Windowed page-number list for pagination controls: always shows the
 * first and last page, a small window around the current page, and
 * collapses any gap into a single "ellipsis" token — never two ellipses
 * back to back, never an ellipsis standing in for exactly one hidden page
 * (that page is just shown instead).
 */
export function getPageNumbers(current: number, totalPages: number, delta = 1): PageToken[] {
  if (totalPages <= 1) return totalPages === 1 ? [1] : [];

  const windowStart = Math.max(2, current - delta);
  const windowEnd = Math.min(totalPages - 1, current + delta);

  const tokens: PageToken[] = [1];

  if (windowStart > 2) {
    tokens.push("ellipsis");
  } else if (windowStart === 2) {
    tokens.push(2);
  }

  for (let p = Math.max(windowStart, 3); p <= windowEnd; p++) {
    tokens.push(p);
  }

  if (windowEnd < totalPages - 1) {
    tokens.push("ellipsis");
  } else if (windowEnd === totalPages - 1 && windowEnd >= 2) {
    tokens.push(totalPages - 1);
  }

  tokens.push(totalPages);

  // De-dupe while preserving order (small totals can otherwise produce the
  // same page number from two branches above, e.g. totalPages === 3).
  const seen = new Set<PageToken>();
  return tokens.filter((t) => {
    const key = t;
    if (seen.has(key) && key !== "ellipsis") return false;
    if (key !== "ellipsis") seen.add(key);
    return true;
  });
}
