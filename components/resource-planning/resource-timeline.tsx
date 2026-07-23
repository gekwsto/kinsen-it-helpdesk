"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addDays, differenceInCalendarDays, format, isSameDay } from "date-fns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, getInitials } from "@/lib/utils";
import { Search } from "lucide-react";
import type { ResourceEvent, ResourcePlanningResource } from "@/lib/services/resource-planning-service";
import type { ResourcePlanningView } from "@/components/resource-planning/resource-planning-toolbar";
import { assignLanes, BAR_H, LANE_GAP, LANE_TOP, BASE_ROW_H } from "@/lib/resource-planning-lanes";
import { clampDragDelta } from "@/lib/resource-planning-drag-bounds";
import { getClippedBarMetrics } from "@/lib/resource-planning-bar-metrics";
import { computePxPerDay } from "@/lib/resource-planning-column-sizing";
import { computeResourceRowHeights } from "@/lib/resource-planning-row-heights";
import { ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";
import { STATUS_BAR, STATUS_LABEL, PRIORITY_CLS } from "@/components/gantt/status-colors";

export interface ResourceRow extends ResourcePlanningResource {
  roleLabel: string;
  utilization: { count: number; label: string; className: string };
}

interface ResourceTimelineProps {
  resources: ResourceRow[];
  events: ResourceEvent[];
  rangeStart: Date;
  rangeEnd: Date;
  view: ResourcePlanningView;
  /** Server-computed via the same canActOnEntity(..., "activity.edit") the PATCH route itself re-checks — resourcePlanning.view alone never implies this. */
  canEdit: boolean;
}

// Drag mechanics below are standalone (this component groups by agent, not
// by project/activity, so it doesn't share Gantt's GanttGroup/GanttItem
// shape) — but the status/priority color maps ARE the shared
// components/gantt/status-colors.ts ones, so the two views can never drift
// out of visual sync.
//
// Day-column width is NOT a fixed constant — a fixed px-per-day either
// leaves a large blank strip on wide screens or forces the chart wider than
// its container on laptops (the bug this replaces). Instead it's derived
// from the scroll container's own measured width (see the ResizeObserver
// below) via computePxPerDay (lib/resource-planning-column-sizing.ts),
// which is view-mode aware (week/month get different [min, max] bounds —
// see that module) and clamped to a readable range; only when the clamp
// hits its floor does horizontal scroll kick in, contained to this chart's
// own overflow-x-auto box, never the page.
const LEFT_W = 220;
// BAR_H/LANE_GAP/LANE_TOP (per-lane geometry for overlapping-event stacking
// within a resource row) live in lib/resource-planning-lanes.ts, alongside
// assignLanes itself, so the lane-index-to-pixel-offset math here and the
// per-row required-height formula there (used by computeResourceRowHeights,
// lib/resource-planning-row-heights.ts) can never drift out of sync.

// Explicit height applied to the day-header row (below) so
// computeResourceRowHeights' availableHeight math has an exact figure to
// subtract instead of guessing at the header's intrinsic content height.
const HEADER_ROW_H = 36;
// See the minChartHeight effect below — matches app/(main)/layout.tsx's
// <main className="p-6"> bottom padding exactly (24px = p-6).
const PAGE_BOTTOM_PADDING = 24;
// Absolute floor so a short/awkward viewport (e.g. scrolled mid-page on a
// small laptop) never computes a collapsed or negative min-height.
const MIN_CHART_HEIGHT = 320;


type DragMeta = {
  id: string; // activity id — used for the PATCH and optimistic local-state update
  barKey: string; // `${resourceId}:${eventId}` — the same activity assigned to multiple agents renders one bar per row, so barElRefs must be keyed per-row, not per-activity (see barElRefs below)
  start: string;
  end: string;
  href: string;
  startX: number;
  originalLeft: number; // this bar's own static left, in day-grid-local px (excludes LEFT_W) — the drag boundary clamp below
  barWidth: number;
};

function applyDateChange(events: ResourceEvent[], id: string, newStart: string, newEnd: string): ResourceEvent[] {
  return events.map((e) => (e.id === id ? { ...e, start: newStart, end: newEnd } : e));
}

/**
 * Resources/events are already fully scoped and date-windowed server-side
 * (see resource-planning-service.ts); this component owns no filtering
 * state beyond an on-top-of-already-scoped-data text search. Date navigation
 * and view mode live in resource-planning-toolbar.tsx (URL-driven). Drag
 * mechanics (DOM-ref transform during move, zero re-renders, <5px counts as
 * a click, day math, optimistic update + revert-on-failure) are ported from
 * components/gantt/gantt-chart.tsx's startDrag/moveDrag/endDrag — same
 * PATCH /api/activities/[id] target, same {startDate, dueDate} body shape.
 */
export function ResourceTimeline({ resources, events, rangeStart, rangeEnd, view, canEdit }: ResourceTimelineProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");

  // Optimistic local mirror of `events` — updated immediately on drop, kept
  // in sync from props otherwise, skipping ids still in-flight (same
  // pendingSaves pattern gantt-chart.tsx uses).
  const [localEvents, setLocalEvents] = useState<ResourceEvent[]>(events);
  const pendingSaves = useRef(new Set<string>());

  useEffect(() => {
    if (pendingSaves.current.size === 0) {
      setLocalEvents(events);
      return;
    }
    setLocalEvents((prev) =>
      events.map((serverEvent) =>
        pendingSaves.current.has(serverEvent.id) ? prev.find((e) => e.id === serverEvent.id) ?? serverEvent : serverEvent
      )
    );
  }, [events]);

  // Keyed by barKey (`${resourceId}:${eventId}`), NOT the bare activity id —
  // an activity assigned to multiple agents renders one bar per agent row,
  // and a plain `Map<eventId, HTMLDivElement>` would have the later-rendered
  // row's bar silently overwrite the earlier one's ref entry. Dragging the
  // first row's bar would then look up (and visually move) whatever row
  // rendered last instead — the actual cause of "drag the top event, a
  // different one moves."
  const barElRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragMeta | null>(null);

  const days = useMemo(() => {
    const totalDays = differenceInCalendarDays(rangeEnd, rangeStart) + 1;
    return Array.from({ length: totalDays }, (_, i) => addDays(rangeStart, i));
  }, [rangeStart, rangeEnd]);

  // Measures the scroll container's own box (not affected by its scrollable
  // inner content) so day-column width can fill the real available space
  // instead of a fixed constant — see computePxPerDay below.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fills real available viewport height instead of sitting at whatever
  // height the row count happens to produce, which used to leave a large
  // dead strip below a short chart. Driven by an actual measurement (this
  // element's own top offset vs. window.innerHeight), not a guessed
  // constant — ResizeObserver only reports an element's OWN box, which is
  // exactly what's being computed here, so viewport size (window resize /
  // orientation change) is what's listened to instead, same as any
  // viewport-relative layout has to be. PAGE_BOTTOM_PADDING matches
  // app/(main)/layout.tsx's own `<main className="p-6">` bottom padding
  // (24px) so the chart's bottom edge lines up with the rest of the page's
  // content instead of leaving that padding as extra forced scroll.
  const [minChartHeight, setMinChartHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const recompute = () => {
      const top = el.getBoundingClientRect().top;
      const available = window.innerHeight - top - PAGE_BOTTOM_PADDING;
      setMinChartHeight(Math.max(MIN_CHART_HEIGHT, available));
    };
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);

  const { pxPerDay } = useMemo(
    () => computePxPerDay({ viewMode: view, containerWidth, leftColumnWidth: LEFT_W, daysCount: days.length }),
    [containerWidth, view, days.length]
  );
  const totalWidth = days.length * pxPerDay;

  const filteredEvents = useMemo(() => {
    if (!search) return localEvents;
    const q = search.toLowerCase();
    return localEvents.filter((e) => e.title.toLowerCase().includes(q) || (e.projectTitle ?? "").toLowerCase().includes(q));
  }, [localEvents, search]);

  // Each resource's events get their own dedicated lane, one per activity —
  // see lib/resource-planning-lanes.ts for why (no more shared/packed
  // lanes), ordered most-urgent-first via the same canonical priority rank
  // the server already applies as its own default sort.
  const { eventsByResource, laneByEvent, laneCountByResource } = useMemo(() => {
    const byResource = new Map<string, ResourceEvent[]>();
    for (const r of resources) byResource.set(r.id, []);
    for (const e of filteredEvents) {
      for (const userId of e.assignedUserIds) {
        byResource.get(userId)?.push(e);
      }
    }

    const { laneByKey, laneCountByResource } = assignLanes(
      new Map(
        [...byResource].map(([resourceId, resourceEvents]) => [
          resourceId,
          resourceEvents.map((e) => ({ id: e.id, start: e.start!, end: e.end!, title: e.title, priority: e.priority })),
        ])
      )
    );

    return { eventsByResource: byResource, laneByEvent: laneByKey, laneCountByResource };
  }, [resources, filteredEvents]);

  // Distributes real leftover vertical space (chart height minus the
  // header row) into the resource rows themselves, up to a readable cap,
  // before any of it becomes filler grid — see
  // lib/resource-planning-row-heights.ts. Before minChartHeight is first
  // measured, availableHeight is 0, so every row simply renders at its own
  // required height (no premature expansion/flash before the real
  // viewport measurement settles one frame later).
  const { heightByResourceId: rowHeights } = useMemo(() => {
    const availableHeight = minChartHeight != null ? Math.max(0, minChartHeight - HEADER_ROW_H) : 0;
    return computeResourceRowHeights({
      resources: resources.map((r) => ({ resourceId: r.id, laneCount: laneCountByResource.get(r.id) ?? 1 })),
      availableHeight,
    });
  }, [resources, laneCountByResource, minChartHeight]);

  // ── Drag handlers (DOM-direct, zero re-renders during move) — ported from
  // components/gantt/gantt-chart.tsx's startDrag/moveDrag/endDrag/cancelDrag. ──
  //
  // Horizontal movement is clamped to the date-grid's own coordinate space
  // (originalLeft/barWidth, both excluding LEFT_W) so a bar can never be
  // dragged visually into the Agent column on the left, nor past the last
  // loaded day column on the right — the grid container itself also gets
  // overflow-hidden (below) as a second, defense-in-depth guard.
  function clampDeltaToGrid(d: DragMeta, rawDelta: number): number {
    return clampDragDelta(d.originalLeft, d.barWidth, totalWidth, rawDelta);
  }

  function startDrag(
    e: React.PointerEvent<HTMLDivElement>,
    id: string,
    barKey: string,
    start: string,
    end: string,
    href: string,
    originalLeft: number,
    barWidth: number
  ) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Lane assignment already guarantees bars never overlap at rest, but a
    // bar being actively dragged still slides across neighboring lanes/days
    // — bump it above everything else for the duration of the gesture so it
    // never visually disappears under a bar it's passing over.
    e.currentTarget.style.zIndex = "50";
    dragRef.current = { id, barKey, start, end, href, startX: e.clientX, originalLeft, barWidth };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>, barKey: string) {
    const d = dragRef.current;
    if (!d || d.barKey !== barKey) return;
    const delta = clampDeltaToGrid(d, e.clientX - d.startX);
    const el = barElRefs.current.get(barKey);
    if (el) el.style.transform = `translateX(${delta}px)`;
  }

  async function endDrag(e: React.PointerEvent<HTMLDivElement>, barKey: string) {
    const d = dragRef.current;
    if (!d || d.barKey !== barKey) return;
    dragRef.current = null;

    const delta = clampDeltaToGrid(d, e.clientX - d.startX);
    const el = barElRefs.current.get(barKey);
    if (el) {
      el.style.transform = "";
      el.style.zIndex = "";
    }

    if (Math.abs(delta) < 5) {
      router.push(d.href);
      return;
    }

    const daysDelta = Math.round(delta / pxPerDay);
    if (daysDelta === 0) return;

    const id = d.id;

    // Both fields always shift by the identical delta (whether the activity
    // had a real range or was a single-day fallback — start===end in that
    // case already), same as Gantt's milestone drag always sending both
    // fields equal — no need to know which raw field was originally set.
    const newStart = addDays(new Date(d.start), daysDelta).toISOString();
    const newEnd = addDays(new Date(d.end), daysDelta).toISOString();

    pendingSaves.current.add(id);
    setLocalEvents((prev) => applyDateChange(prev, id, newStart, newEnd));

    try {
      const res = await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: newStart, dueDate: newEnd }),
      });
      if (res.ok) {
        toast.success(`Dates shifted ${daysDelta > 0 ? "+" : ""}${daysDelta}d`);
        pendingSaves.current.delete(id);
        router.refresh();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to update dates");
        pendingSaves.current.delete(id);
        setLocalEvents((prev) => applyDateChange(prev, id, d.start, d.end));
      }
    } catch {
      toast.error("Failed to update dates");
      pendingSaves.current.delete(id);
      setLocalEvents((prev) => applyDateChange(prev, id, d.start, d.end));
    }
  }

  function cancelDrag(barKey: string) {
    if (dragRef.current?.barKey === barKey) dragRef.current = null;
    const el = barElRefs.current.get(barKey);
    if (el) {
      el.style.transform = "";
      el.style.zIndex = "";
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3 flex-1 min-w-0">
        <div className="relative w-full sm:w-[240px] ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="Search activity/project…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div
          ref={scrollRef}
          className="rounded-lg border overflow-x-auto flex flex-col"
          style={{ minHeight: minChartHeight ?? undefined }}
        >
          <div className="flex flex-col flex-1" style={{ minWidth: LEFT_W + totalWidth }}>
            {/* Header row — explicit height (matches HEADER_ROW_H) so
                computeResourceRowHeights' availableHeight math has an
                exact figure, not a guess at intrinsic content height. */}
            <div className="flex border-b bg-muted/40 sticky top-0 z-10" style={{ height: HEADER_ROW_H }}>
              <div className="flex-shrink-0 border-r px-3 py-2 text-xs font-medium text-muted-foreground" style={{ width: LEFT_W }}>
                Agent
              </div>
              <div className="flex" style={{ width: totalWidth }}>
                {days.map((d) => (
                  <div
                    key={d.toISOString()}
                    className={cn(
                      "flex-shrink-0 border-r px-1.5 py-2 text-center text-[11px] text-muted-foreground",
                      isSameDay(d, new Date()) && "bg-primary/5 font-semibold text-foreground"
                    )}
                    style={{ width: pxPerDay }}
                  >
                    {view === "week" ? format(d, "EEE d") : format(d, "d")}
                  </div>
                ))}
              </div>
            </div>

            {/* Resource rows — height comes from computeResourceRowHeights
                above: enough for every activity's own lane, plus a share of
                any real leftover viewport space (up to a readable cap) so a
                department with few agents doesn't leave a huge dead strip
                below a handful of tightly-packed rows. */}
            {resources.map((r) => {
              const rowEvents = eventsByResource.get(r.id) ?? [];
              const rowHeight = rowHeights.get(r.id) ?? BASE_ROW_H;
              return (
                <div key={r.id} className="flex border-b last:border-b-0">
                  <div
                    className="flex-shrink-0 border-r px-3 py-2 flex items-center gap-2"
                    style={{ width: LEFT_W, height: rowHeight }}
                  >
                    <Avatar className="h-7 w-7 flex-shrink-0">
                      <AvatarImage src={r.image ?? undefined} />
                      <AvatarFallback className="text-[10px]">{getInitials(r.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{r.name ?? r.email}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{r.roleLabel}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Badge variant="secondary" className={cn("text-[9px] px-1 py-0 h-4", r.utilization.className)}>
                          {r.utilization.label}
                        </Badge>
                        <span className="text-[9px] text-muted-foreground">{r.utilization.count} scheduled</span>
                      </div>
                    </div>
                  </div>
                  {/* overflow-hidden is a defense-in-depth clip on top of the
                      startDrag/moveDrag/endDrag boundary clamp below — a bar
                      must never render past this row's own box, into the
                      Agent column to its left or past the last loaded day. */}
                  <div className="relative overflow-hidden" style={{ width: totalWidth, height: rowHeight }}>
                    {days.map((d, i) => (
                      <div
                        key={i}
                        className={cn("absolute top-0 bottom-0 border-r", isSameDay(d, new Date()) && "bg-primary/5")}
                        style={{ left: i * pxPerDay, width: pxPerDay }}
                      />
                    ))}
                    {rowEvents.map((e) => {
                      const metrics = getClippedBarMetrics(
                        new Date(e.start!),
                        new Date(e.end!),
                        rangeStart,
                        rangeEnd,
                        pxPerDay,
                        totalWidth
                      );
                      // Defensive — getResourcePlanningEvents already drops
                      // events with zero overlap with the requested range
                      // server-side, so this shouldn't trigger in practice,
                      // but a bar must never render for an event with no
                      // actual overlap with what's currently on screen.
                      if (!metrics.isVisible) return null;

                      const { left, width, continuesBefore, continuesAfter } = metrics;
                      const barKey = `${r.id}:${e.id}`;
                      const lane = laneByEvent.get(barKey) ?? 0;
                      const top = LANE_TOP + lane * (BAR_H + LANE_GAP);
                      const barColor = STATUS_BAR[e.status] ?? "bg-slate-400";
                      // A clipped edge gets its rounding removed — a rounded
                      // corner sitting exactly at the grid boundary reads as
                      // "this is where the event ends," which is wrong when
                      // it actually continues off-screen.
                      const cornerClass = cn(continuesBefore ? "rounded-l-none" : "rounded-l-md", continuesAfter ? "rounded-r-none" : "rounded-r-md");
                      // Dragging a bar that's only a clipped fragment of the
                      // real event is confusing (its visible width doesn't
                      // match the event's actual duration) — safer to fall
                      // back to click-to-open for those, matching the
                      // non-editable Link path below exactly.
                      const canDrag = canEdit && !continuesBefore && !continuesAfter;

                      const barInner = (
                        <div
                          className={cn(
                            "relative w-full h-full overflow-hidden transition-opacity",
                            cornerClass,
                            barColor,
                            e.status === "CANCELLED" && "opacity-40"
                          )}
                        >
                          <span className="absolute inset-0 flex items-center px-2 text-[11px] font-medium text-white truncate pointer-events-none">
                            {e.projectTitle ? `${e.projectTitle} — ${e.title}` : e.title}
                          </span>
                        </div>
                      );

                      const bar = canDrag ? (
                        <div
                          ref={(el) => {
                            if (el) barElRefs.current.set(barKey, el);
                            else barElRefs.current.delete(barKey);
                          }}
                          className="absolute select-none outline-none cursor-grab active:cursor-grabbing"
                          style={{ left, width, top, height: BAR_H, touchAction: "none" }}
                          onPointerDown={(ev) => startDrag(ev, e.id, barKey, e.start!, e.end!, `/activities/${e.id}`, left, width)}
                          onPointerMove={(ev) => moveDrag(ev, barKey)}
                          onPointerUp={(ev) => endDrag(ev, barKey)}
                          onPointerCancel={() => cancelDrag(barKey)}
                        >
                          {barInner}
                        </div>
                      ) : (
                        <Link
                          href={`/activities/${e.id}`}
                          className="absolute cursor-pointer hover:opacity-90 transition-opacity"
                          style={{ left, width, top, height: BAR_H }}
                        >
                          {barInner}
                        </Link>
                      );

                      return (
                        <Tooltip key={barKey}>
                          <TooltipTrigger asChild>{bar}</TooltipTrigger>
                          <TooltipContent>
                            <p className="font-medium">{e.title}</p>
                            {e.projectTitle && <p className="text-xs text-muted-foreground">{e.projectTitle}</p>}
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span className="text-xs text-muted-foreground">{STATUS_LABEL[e.status] ?? e.status}</span>
                              {PRIORITY_CLS[e.priority] && (
                                <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", PRIORITY_CLS[e.priority])}>
                                  {ACTIVITY_PRIORITY_LABEL[e.priority as keyof typeof ACTIVITY_PRIORITY_LABEL] ?? e.priority}
                                </span>
                              )}
                            </div>
                            {e.isFallbackDate && (
                              <p className="text-xs text-muted-foreground italic">Single-day estimate — only one of start/due date is set.</p>
                            )}
                            {(continuesBefore || continuesAfter) && (
                              <p className="text-xs text-muted-foreground italic">
                                {continuesBefore && continuesAfter
                                  ? `Extends beyond both ends of the visible ${view}.`
                                  : continuesBefore
                                  ? `Starts before the visible ${view}.`
                                  : `Continues after the visible ${view}.`}
                              </p>
                            )}
                            <p className="text-[10px] text-muted-foreground border-t pt-1.5 mt-1">
                              {!canEdit
                                ? "You do not have permission to update this activity."
                                : canDrag
                                ? "Drag to move dates"
                                : "Open activity to edit dates"}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Fills any remaining vertical space below the last resource
                row so the chart visually extends to match the available
                viewport height (see minChartHeight above) instead of
                leaving blank space below a bordered box that's now taller
                than its natural row content — the day-grid lines simply
                continue, no fake rows/agents are added. A no-op when
                there's no surplus space (many resources): flex-1/min-h-0
                on a flex-col parent that already fills its natural
                content height just collapses to zero extra height. */}
            <div className="flex flex-1 min-h-0">
              <div className="flex-shrink-0 border-r" style={{ width: LEFT_W }} />
              <div className="relative" style={{ width: totalWidth }}>
                {days.map((d, i) => (
                  <div
                    key={i}
                    className={cn("absolute top-0 bottom-0 border-r", isSameDay(d, new Date()) && "bg-primary/5")}
                    style={{ left: i * pxPerDay, width: pxPerDay }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
