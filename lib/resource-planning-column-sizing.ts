/**
 * Resource Planning timeline day-column width — view-mode aware instead of
 * a single [min, max] range shared by every view. Week (7 columns) and
 * month (28-31 columns) need very different bounds: week can afford wide,
 * easy-to-read columns that fill the available width with room to spare,
 * month needs to stay compact enough that the whole thing doesn't force
 * constant horizontal scroll, while still filling available width rather
 * than sitting at a tiny fixed size on a wide screen.
 *
 * Centralized here (not inline in resource-timeline.tsx) so a future view
 * (quarter/year) only needs a new entry in PX_PER_DAY_BOUNDS — the function
 * itself never needs to change, and an unconfigured view mode falls back
 * to the month bounds (the safer, more compact default) instead of
 * throwing.
 */
export interface PxPerDayBounds {
  min: number;
  max: number;
  /** Pre-measurement fallback (first paint, before the real container width is known). */
  default: number;
}

export const PX_PER_DAY_BOUNDS: Record<string, PxPerDayBounds> = {
  // 7 columns — can afford to be wide; the explicit goal is filling the
  // available width without needing horizontal scroll on a normal laptop.
  week: { min: 110, max: 220, default: 150 },
  // 28-31 columns — must stay compact; contained horizontal scroll is an
  // acceptable fallback (never a page-level one), but columns should still
  // grow to fill a wide viewport rather than sit at a tiny fixed size.
  month: { min: 34, max: 84, default: 38 },
};

const FALLBACK_BOUNDS = PX_PER_DAY_BOUNDS.month;

export interface ComputePxPerDayInput {
  viewMode: string;
  /** The timeline's own scroll container width, or null before it's been measured. */
  containerWidth: number | null;
  /** Width reserved for the Agent info column — excluded from the day-grid's own available width. */
  leftColumnWidth: number;
  daysCount: number;
}

export interface ComputePxPerDayResult {
  pxPerDay: number;
  /** True when daysCount * pxPerDay exceeds the space actually available — the grid needs its own contained horizontal scroll. */
  requiresHorizontalScroll: boolean;
  minPx: number;
  maxPx: number;
}

export function computePxPerDay({ viewMode, containerWidth, leftColumnWidth, daysCount }: ComputePxPerDayInput): ComputePxPerDayResult {
  const bounds = PX_PER_DAY_BOUNDS[viewMode] ?? FALLBACK_BOUNDS;

  if (!containerWidth || daysCount <= 0) {
    return { pxPerDay: bounds.default, requiresHorizontalScroll: false, minPx: bounds.min, maxPx: bounds.max };
  }

  const availableForDays = containerWidth - leftColumnWidth;
  const fit = Math.floor(availableForDays / daysCount);
  const pxPerDay = Math.min(bounds.max, Math.max(bounds.min, fit));

  return {
    pxPerDay,
    requiresHorizontalScroll: pxPerDay * daysCount > availableForDays,
    minPx: bounds.min,
    maxPx: bounds.max,
  };
}
