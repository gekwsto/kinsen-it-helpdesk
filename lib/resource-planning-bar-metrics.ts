import { differenceInCalendarDays } from "date-fns";

/** Small gap (px) subtracted from a bar's raw width so adjacent day-spanning bars never touch exactly at a day boundary — same convention the previous inline barMetrics used. */
const BAR_GAP = 4;

export interface ClippedBarMetrics {
  left: number;
  width: number;
  clippedStart: Date;
  clippedEnd: Date;
  /** Event's real start is before visibleStart — the bar's left edge is a clip point, not the event's actual start. */
  continuesBefore: boolean;
  /** Event's real end is after visibleEnd — the bar's right edge is a clip point, not the event's actual end. */
  continuesAfter: boolean;
  /** False when the event has no overlap with the visible range at all — caller should not render a bar. */
  isVisible: boolean;
}

/**
 * Computes a Resource Planning timeline event bar's on-screen geometry,
 * clipped to [visibleStart, visibleEnd] (the current week/month window).
 *
 * Replaces the previous "clamp the dates, then diff" approach, which had a
 * real (if currently latent — see below) bug: when an event's start AND end
 * both fall on the SAME side of the visible window (e.g. entirely before
 * it), clamping the dates independently can leave clippedEnd before
 * clippedStart, producing a negative day-difference whose resulting `left`
 * lands far outside [0, totalWidth) instead of the bar simply not
 * rendering. getResourcePlanningEvents already filters events with zero
 * overlap with the requested range server-side, so that degenerate case
 * doesn't currently reach the client — but this function resolves
 * visibility first regardless (isVisible=false skips rendering entirely)
 * and clamps the final PIXEL values directly (left >= 0, left+width <=
 * totalWidth) rather than trusting date arithmetic to stay in range, the
 * same technique components/gantt/gantt-chart.tsx's own barMetrics already
 * uses — defensively correct even if that server-side guarantee ever
 * changes, per a caller passing in an out-of-range event directly, etc.
 *
 * Due-date semantics match Gantt exactly: end is inclusive (a same-day
 * event, start === end, occupies exactly one day column — the "+1" below).
 */
export function getClippedBarMetrics(
  eventStart: Date,
  eventEnd: Date,
  visibleStart: Date,
  visibleEnd: Date,
  pxPerDay: number,
  totalWidth: number
): ClippedBarMetrics {
  if (eventEnd < visibleStart || eventStart > visibleEnd) {
    return {
      left: 0,
      width: 0,
      clippedStart: visibleStart,
      clippedEnd: visibleStart,
      continuesBefore: false,
      continuesAfter: false,
      isVisible: false,
    };
  }

  const continuesBefore = eventStart < visibleStart;
  const continuesAfter = eventEnd > visibleEnd;
  const clippedStart = continuesBefore ? visibleStart : eventStart;
  const clippedEnd = continuesAfter ? visibleEnd : eventEnd;

  const left = Math.max(0, differenceInCalendarDays(clippedStart, visibleStart) * pxPerDay);
  const rawWidth = (differenceInCalendarDays(clippedEnd, clippedStart) + 1) * pxPerDay - BAR_GAP;
  const width = Math.max(pxPerDay - BAR_GAP, Math.min(rawWidth, totalWidth - left));

  return { left, width, clippedStart, clippedEnd, continuesBefore, continuesAfter, isVisible: true };
}
