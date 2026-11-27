"use client";

import { useState, useMemo, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  format,
  addDays,
  addMonths,
  startOfMonth,
  endOfMonth,
  differenceInCalendarDays,
  getDay,
  isSameDay,
} from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ChevronDown,
  ChevronRight,
  CalendarDays,
  Search,
  X,
  Maximize2,
  Minimize2,
  AlertTriangle,
  CalendarClock,
} from "lucide-react";
import { getInitials } from "@/lib/utils";
import { STATUS_BAR, STATUS_LABEL, PRIORITY_CLS } from "@/components/gantt/status-colors";
import { StatusLegend } from "@/components/gantt/status-legend";
import { ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";
import { ActivityPriority } from "@prisma/client";
import { filterGanttGroups } from "@/lib/gantt-filters";
import type { PriorityFilterOption } from "@/lib/priority-config";
import { buildSchedulingPatch, DEFAULT_TIMELINE_MODE, type TimelineMode } from "@/lib/timeline-mode";
import { shiftDateOnly, dateOnlyAsLocalDate } from "@/lib/date-only";
import { shouldKeepLocal, recordConfirmedWrite } from "@/lib/timeline-reconcile";
import { TimelineModeToggle } from "@/components/timeline/timeline-mode-toggle";

// Fallback ONLY for callers that don't pass priorityOptions (e.g. an "All
// Workspaces" view spanning several departments with no single department's
// config to honor — see app/(main)/projects/gantt/page.tsx's own comment on
// this exact case). The department-specific case always gets a REAL
// priorityOptions prop resolved from ActivityPriorityConfig
// (lib/priority-config.ts) — never this constant.
const CANONICAL_PRIORITY_OPTIONS: PriorityFilterOption[] = [
  ActivityPriority.URGENT,
  ActivityPriority.HIGH,
  ActivityPriority.MEDIUM,
  ActivityPriority.LOW,
].map((value) => ({ value, label: ACTIVITY_PRIORITY_LABEL[value] }));

export type ViewMode = "day" | "week" | "month";

const PX_PER_DAY: Record<ViewMode, number> = { day: 40, week: 16, month: 6 };

const ROW_H  = 44;
const TOP_H  = 22;
const BTM_H  = 30;
const LEFT_W = 296;

// STATUS_DOT was identical to STATUS_BAR (same values) — uses STATUS_BAR
// directly below instead of keeping a second copy.

export interface GanttItem {
  id: string;
  title: string;
  status: string;
  /** This activity's department-resolved status display label — see lib/services/activity-status-config.ts. Always present for activity/milestone items; project (group) bars have none and fall back to the legacy STATUS_LABEL map (Project status isn't department-scoped by this system). */
  statusLabel?: string;
  /** This activity's department-resolved status color (#RRGGBB) — same fallback rule as statusLabel. */
  statusColor?: string;
  priority?: string | null;
  startDate: string | null;
  endDate: string | null;
  /** null means no ActivityProgressConfig row is configured/enabled for this activity's department+status — see lib/activities/activity-progress.ts. Never rendered as 0%. */
  progress: number | null;
  href: string;
  assigneeName?: string | null;
  assigneeImage?: string | null;
  type: "activity" | "milestone";
  /** Record version (updatedAt ISO) of this snapshot — lets a stale refresh be told apart from a newer committed drag (lib/timeline-reconcile.ts). Optional: without it the server snapshot always wins, as before. */
  updatedAt?: string | null;
  /** Derived server-side via lib/overdue.ts — never a stored/stale flag. */
  overdue?: boolean;
  /**
   * True when this item's own endDate is LATER than its parent Project's
   * endDate — computed client-side, purely for display (see where
   * `scheduledGroups` is rendered below), never a stored/validated flag.
   * Deliberately NOT tied into `overdue` (a different, self-contained
   * concept — see lib/overdue.ts) and never blocks anything; it only
   * flags a scheduling inconsistency worth a human's attention.
   */
  extendsPastProject?: boolean;
  /**
   * Expected-mode milestones only: the milestone's stored Expected Start
   * (null when it has none). The milestone is still drawn as a point at
   * Expected Finish; a move shifts this by the same calendar-day delta when
   * present and never creates it (see buildSchedulingPatch).
   */
  expectedMilestoneStartDate?: string | null;
}

export interface GanttGroup {
  id: string;
  title: string;
  href: string;
  status: string;
  /** Project.priority (Int 1-3), mapped to the same LOW/MEDIUM/HIGH keys ActivityPriority uses — see lib/project-priority.ts. Null/undefined for a group whose priority can't be mapped. */
  priority?: string | null;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  ownerName?: string | null;
  ownerImage?: string | null;
  type: "project" | "standalone";
  /** Project groups only: the configured Project Status (lib/services/project-status-service.ts) — display label/color, and the value the in-chart status filter matches on (`project-status:<definitionId>`). `status` itself stays the CANONICAL lifecycle state. */
  statusLabel?: string;
  statusColor?: string;
  statusFilterValue?: string;
  children: GanttItem[];
  /** Record version (updatedAt ISO) — see GanttItem.updatedAt. */
  updatedAt?: string | null;
  /** Derived server-side via lib/overdue.ts — never a stored/stale flag. */
  overdue?: boolean;
  /**
   * Facilities Services Project with Quarter precision only — e.g. "Q2
   * 2027", pre-formatted server-side (formatFacilitiesQuarterLabel). When
   * present, the tooltip shows this INSTEAD of the formatted exact
   * startDate/endDate for that one boundary — startDate/endDate
   * themselves are still the real derived dates (unchanged, still what
   * positions/sizes the bar), this only controls what the tooltip's own
   * label text says, so a Quarter-derived boundary is never presented as
   * if a user had typed in that exact day.
   */
  facilitiesStartLabel?: string | null;
  facilitiesEndLabel?: string | null;
}

export interface GanttDependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: "FINISH_TO_START" | "START_TO_START" | "FINISH_TO_FINISH" | "START_TO_FINISH";
}

interface GanttChartProps {
  groups: GanttGroup[];
  canEdit?: boolean;
  dependencies?: GanttDependency[];
  /** Department-scoped, order/enablement-resolved Priority filter options (lib/priority-config.ts) — falls back to CANONICAL_PRIORITY_OPTIONS only when the caller has no single department to scope to. */
  priorityOptions?: PriorityFilterOption[];
  /** Department-scoped Activity Status legend entries (label/color — see lib/services/activity-status-config.ts) — same "only resolvable for a single specific department" limitation as priorityOptions; falls back to the legacy static legend in "All Workspaces" (no single department). */
  activityStatusLegendEntries?: { key: string; label: string; color: string }[];
  /**
   * Actual / Expected timeline mode (lib/timeline-mode.ts) the caller has
   * ALREADY resolved every item's startDate/endDate for. When provided, the
   * Actual / Expected toggle is shown in the toolbar; omitted (e.g. the
   * standalone Activity Gantt) the chart is exactly as before, no toggle.
   * Drag-to-reschedule writes ONLY this mode's own date fields (see
   * buildSchedulingPatch) — omitted means Actual, exactly as before.
   */
  timelineMode?: TimelineMode;
}

const STUB = 12;
const DEP_COLORS: Record<string, string> = {
  FINISH_TO_START:  "#6366f1",
  START_TO_START:   "#0ea5e9",
  FINISH_TO_FINISH: "#f59e0b",
  START_TO_FINISH:  "#f43f5e",
};

type DragMeta = {
  id: string;
  isGroup: boolean;
  isMilestone: boolean;
  startDate: string;
  endDate: string;
  /** Expected-mode milestone's existing Expected Start (null when none) — see GanttItem.expectedMilestoneStartDate. */
  milestoneStartDate: string | null;
  href: string;
  startX: number;
};

/**
 * Date-only values (UTC-midnight ISO) → the rendering bridge from
 * lib/date-only.ts: local noon on the stored UTC calendar date, so every
 * local-time calendar helper below (differenceInCalendarDays, format,
 * isSameDay, startOfMonth, getDay) sees the stored day in any time zone and
 * server render === client hydration.
 */
function parseDate(d: string | null): Date | null {
  return d ? dateOnlyAsLocalDate(d) : null;
}

function applyDateChange(
  current: GanttGroup[],
  id: string,
  isGroup: boolean,
  newStart: string,
  newEnd: string,
  milestoneStart?: string | null,
): GanttGroup[] {
  if (isGroup) {
    return current.map(g =>
      g.id === id ? { ...g, startDate: newStart, endDate: newEnd } : g,
    );
  }
  return current.map(g => ({
    ...g,
    children: g.children.map(c =>
      c.id === id
        ? { ...c, startDate: newStart, endDate: newEnd, ...(milestoneStart !== undefined && c.expectedMilestoneStartDate !== undefined ? { expectedMilestoneStartDate: milestoneStart } : {}) }
        : c,
    ),
  }));
}

export function GanttChart({ groups, canEdit = false, dependencies, priorityOptions = CANONICAL_PRIORITY_OPTIONS, activityStatusLegendEntries, timelineMode }: GanttChartProps) {
  const router = useRouter();
  const isExpectedMode = timelineMode === "expected";

  // ── Optimistic local state ─────────────────────────────────────────────────
  // Updated immediately on drop → zero flicker. Synced back from server after
  // router.refresh() completes, skipping IDs that are still in-flight.
  const [localGroups, setLocalGroups] = useState<GanttGroup[]>(groups);
  const pendingSaves = useRef(new Set<string>());
  // id → committed updatedAt from our own successful PATCH (lib/timeline-reconcile.ts).
  const confirmedSaves = useRef(new Map<string, string>());
  // A server snapshot that arrived DURING an active drag — applied once the
  // gesture ends or is cancelled, so a refresh never re-lays-out (or jumps)
  // the chart under the pointer.
  const deferredGroups = useRef<GanttGroup[] | null>(null);

  // Server snapshot → local state. Keeps the local copy only where the
  // snapshot isn't authoritative yet: a mutation still in flight, or a
  // snapshot rendered before our own committed write (older updatedAt).
  function reconcileWithServer(server: GanttGroup[]) {
    const state = { pending: pendingSaves.current, confirmed: confirmedSaves.current };
    const keep = new Set<string>();
    for (const g of server) {
      if (shouldKeepLocal(g.id, g.updatedAt, state)) keep.add(g.id);
      for (const c of g.children) if (shouldKeepLocal(c.id, c.updatedAt, state)) keep.add(c.id);
    }
    if (keep.size === 0) {
      setLocalGroups(server);
      return;
    }
    setLocalGroups(prev =>
      server.map(serverGroup => {
        const prevGroup = prev.find(g => g.id === serverGroup.id);
        const base = keep.has(serverGroup.id) && prevGroup
          ? { ...serverGroup, startDate: prevGroup.startDate, endDate: prevGroup.endDate }
          : serverGroup;
        return {
          ...base,
          children: serverGroup.children.map(serverChild => {
            if (!keep.has(serverChild.id)) return serverChild;
            return prevGroup?.children.find(c => c.id === serverChild.id) ?? serverChild;
          }),
        };
      }),
    );
  }

  useEffect(() => {
    if (dragRef.current) {
      deferredGroups.current = groups;
      return;
    }
    deferredGroups.current = null;
    reconcileWithServer(groups);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  /** Applies a snapshot deferred during the gesture that just ended/was cancelled. */
  function flushDeferredSnapshot() {
    const server = deferredGroups.current;
    if (!server) return;
    deferredGroups.current = null;
    reconcileWithServer(server);
  }

  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Drag state — refs only so pointer-move never triggers React re-renders
  const barElRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef   = useRef<DragMeta | null>(null);

  // "Today" is the VIEWER's local day, which the server cannot know (its own
  // zone/day may differ). Resolved in the browser only — null for the server
  // render and the hydration render, so both agree — and set in a layout
  // effect, so it is applied before the first paint (the auto-scroll below
  // waits for it).
  const [today, setToday] = useState<Date | null>(null);
  useLayoutEffect(() => {
    setToday(new Date());
  }, []);

  // ── Client-side filtering (uses localGroups) ───────────────────────────────
  // Search + Status + Priority combined filtering — see lib/gantt-filters.ts
  // for the (independently unit-tested) shared rule both the Status and
  // Priority (Part 1) filters follow.
  const filteredGroups = useMemo(
    () => filterGanttGroups(localGroups, search, statusFilter, priorityFilter),
    [localGroups, search, statusFilter, priorityFilter]
  );

  // ── Separate scheduled / unscheduled ──────────────────────────────────────
  const { scheduledGroups, unscheduledItems } = useMemo(() => {
    type UItem = {
      id: string; title: string; href: string; status: string;
      statusColor?: string;
      priority?: string | null; isGroup: boolean; isMilestone: boolean;
    };
    const scheduled: GanttGroup[] = [];
    const unscheduled: UItem[]    = [];

    for (const g of filteredGroups) {
      const scheduledKids   = g.children.filter((c) => c.startDate && c.endDate);
      const unscheduledKids = g.children.filter((c) => !c.startDate || !c.endDate);

      if (g.startDate && g.endDate) {
        scheduled.push({ ...g, children: scheduledKids });
      } else if (scheduledKids.length > 0) {
        scheduled.push({ ...g, startDate: null, endDate: null, children: scheduledKids });
      } else {
        unscheduled.push({ id: g.id, title: g.title, href: g.href, status: g.status, statusColor: g.statusColor, isGroup: true, isMilestone: false });
      }

      for (const c of unscheduledKids) {
        unscheduled.push({
          id: c.id, title: c.title, href: c.href, status: c.status, statusColor: c.statusColor,
          priority: c.priority, isGroup: false, isMilestone: c.type === "milestone",
        });
      }
    }
    return { scheduledGroups: scheduled, unscheduledItems: unscheduled };
  }, [filteredGroups]);

  // ── Timeline bounds (always includes today) ────────────────────────────────
  const { viewStart, viewEnd } = useMemo(() => {
    const dates: number[] = today ? [today.getTime()] : [];
    for (const g of scheduledGroups) {
      if (g.startDate) dates.push(dateOnlyAsLocalDate(g.startDate).getTime());
      if (g.endDate)   dates.push(dateOnlyAsLocalDate(g.endDate).getTime());
      for (const c of g.children) {
        if (c.startDate) dates.push(dateOnlyAsLocalDate(c.startDate).getTime());
        if (c.endDate)   dates.push(dateOnlyAsLocalDate(c.endDate).getTime());
      }
    }
    // Pre-hydration with no dated items: a fixed placeholder (identical on
    // server and client) until `today` resolves in the browser.
    if (dates.length === 0) dates.push(new Date(2000, 0, 1, 12).getTime());
    return {
      viewStart: addDays(new Date(Math.min(...dates)), -14),
      viewEnd:   addDays(new Date(Math.max(...dates)), 14),
    };
  }, [scheduledGroups, today]);

  const pxPerDay    = PX_PER_DAY[viewMode];
  const totalDays   = Math.max(differenceInCalendarDays(viewEnd, viewStart), 1);
  const totalWidth  = totalDays * pxPerDay;
  const todayOffset = today ? differenceInCalendarDays(today, viewStart) : -1;
  const todayPx     = todayOffset * pxPerDay;
  const showToday   = !!today && todayOffset >= 0 && todayOffset <= totalDays;

  function scrollToToday() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayPx - (el.clientWidth - LEFT_W) / 2);
  }

  // ── Initial viewport position: open on today, once ─────────────────────────
  // Requirement: the Gantt should never make the user press "Today" manually
  // on open — the full (unfiltered) timeline already always includes today
  // (see the viewStart/viewEnd useMemo above) and is rendered in full; only
  // the initial horizontal SCROLL POSITION changes, nothing is hidden or
  // re-queried. Runs exactly once per mount (hasAutoScrolledRef), reusing
  // the exact same scrollToToday() the manual "Today" button calls — never a
  // separate/duplicated centering formula.
  //
  // useLayoutEffect (not useEffect) so scrollLeft is set BEFORE the browser
  // paints the first frame — the user never sees the left (unscrolled) edge
  // flash before jumping to today, which useEffect's post-paint timing would
  // cause. clientWidth is measured directly from the just-committed DOM, so
  // this only runs once the scroll container has real, laid-out width — a
  // requestAnimationFrame retry (not an arbitrary setTimeout) covers the
  // rare case a still-hidden/animating ancestor reports 0 width on the very
  // first layout pass.
  const hasAutoScrolledRef = useRef(false);
  useLayoutEffect(() => {
    if (hasAutoScrolledRef.current || !today) return;
    const el = scrollRef.current;
    if (!el) return;

    if (el.clientWidth === 0) {
      const raf = requestAnimationFrame(() => {
        if (hasAutoScrolledRef.current || !scrollRef.current) return;
        scrollToToday();
        hasAutoScrolledRef.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }

    scrollToToday();
    hasAutoScrolledRef.current = true;
    // Runs once, as soon as the browser's `today` is known (the layout
    // effect above sets it before first paint): re-running this on every
    // filter/drag/refresh re-render (which would happen if todayPx/
    // scrollToToday were listed as deps) is exactly the "keeps forcing the
    // user back to today" behavior this must NOT do — the ref guard above is
    // the actual one-time gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  // ── Header cells ──────────────────────────────────────────────────────────
  const { topCells, btmCells } = useMemo(() => {
    type Cell = { label: string; left: number; width: number; highlight?: boolean };
    const top: Cell[] = [];
    const btm: Cell[] = [];

    if (viewMode !== "month") {
      let cur = startOfMonth(viewStart);
      while (cur <= viewEnd) {
        const mEnd = endOfMonth(cur);
        const s    = cur < viewStart ? viewStart : cur;
        const e    = mEnd > viewEnd  ? viewEnd  : mEnd;
        top.push({ label: format(cur, "MMMM yyyy"), left: differenceInCalendarDays(s, viewStart) * pxPerDay, width: (differenceInCalendarDays(e, s) + 1) * pxPerDay });
        cur = addMonths(cur, 1);
      }
    } else {
      for (let y = viewStart.getFullYear(); y <= viewEnd.getFullYear(); y++) {
        const ys = new Date(y, 0, 1);
        const ye = new Date(y, 11, 31);
        const s  = ys < viewStart ? viewStart : ys;
        const e  = ye > viewEnd   ? viewEnd   : ye;
        top.push({ label: String(y), left: differenceInCalendarDays(s, viewStart) * pxPerDay, width: (differenceInCalendarDays(e, s) + 1) * pxPerDay });
        y++;
      }
    }

    if (viewMode === "day") {
      let d = new Date(viewStart);
      while (d <= viewEnd) {
        btm.push({ label: format(d, "d"), left: differenceInCalendarDays(d, viewStart) * pxPerDay, width: pxPerDay, highlight: !!today && isSameDay(d, today) });
        d = addDays(d, 1);
      }
    } else if (viewMode === "week") {
      let d = new Date(viewStart);
      while (d <= viewEnd) {
        const wOff = differenceInCalendarDays(d, viewStart);
        btm.push({ label: format(d, "MMM d"), left: wOff * pxPerDay, width: 7 * pxPerDay, highlight: !!today && todayOffset >= wOff && todayOffset < wOff + 7 });
        d = addDays(d, 7);
      }
    } else {
      let cur = startOfMonth(viewStart);
      while (cur <= viewEnd) {
        const mEnd = endOfMonth(cur);
        const s    = cur < viewStart ? viewStart : cur;
        const e    = mEnd > viewEnd  ? viewEnd  : mEnd;
        btm.push({ label: format(cur, "MMM"), left: differenceInCalendarDays(s, viewStart) * pxPerDay, width: (differenceInCalendarDays(e, s) + 1) * pxPerDay, highlight: !!today && cur.getMonth() === today.getMonth() && cur.getFullYear() === today.getFullYear() });
        cur = addMonths(cur, 1);
      }
    }

    return { topCells: top, btmCells: btm };
  }, [viewMode, viewStart, viewEnd, pxPerDay, today, todayOffset]);

  // ── Weekend stripes ────────────────────────────────────────────────────────
  const weekendStripes = useMemo(() => {
    if (viewMode !== "day") return [];
    const s: { left: number; width: number }[] = [];
    let d = new Date(viewStart);
    while (d <= viewEnd) {
      const dow = getDay(d);
      if (dow === 0 || dow === 6) s.push({ left: differenceInCalendarDays(d, viewStart) * pxPerDay, width: pxPerDay });
      d = addDays(d, 1);
    }
    return s;
  }, [viewMode, viewStart, viewEnd, pxPerDay]);

  // ── Bar geometry ──────────────────────────────────────────────────────────
  function barMetrics(startDate: string | null, endDate: string | null) {
    const s = parseDate(startDate);
    if (!s) return null;
    const e    = parseDate(endDate) ?? s;
    const left = Math.max(0, differenceInCalendarDays(s, viewStart)) * pxPerDay;
    const end  = Math.min(totalWidth, (differenceInCalendarDays(e, viewStart) + 1) * pxPerDay);
    return { left, width: Math.max(end - left, 8) };
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll   = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(scheduledGroups.map((g) => g.id)));

  const allStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const g of localGroups) { s.add(g.statusFilterValue ?? g.status); for (const c of g.children) s.add(c.status); }
    return [...s].sort();
  }, [localGroups]);
  // Configured Project Status labels for project-group filter values.
  const groupStatusLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of localGroups) if (g.statusFilterValue && g.statusLabel) m.set(g.statusFilterValue, g.statusLabel);
    return m;
  }, [localGroups]);

  // Same department-scoped label source as the legend — falls back to the
  // static enum label only when unresolvable (e.g. a Project-status value,
  // or "All Workspaces" with no single department to resolve against).
  const statusLabelFor = (s: string) => groupStatusLabels.get(s) ?? activityStatusLegendEntries?.find((e) => e.key === s)?.label ?? STATUS_LABEL[s] ?? s;

  // ── Dependency arrow geometry ──────────────────────────────────────────────

  // Maps each rendered item ID → y-center in the SVG (accounts for header + row offset)
  const rowPositions = useMemo(() => {
    const map = new Map<string, number>();
    let rowIdx = 0;
    const headerH = TOP_H + BTM_H;
    for (const g of scheduledGroups) {
      map.set(g.id, headerH + rowIdx * ROW_H + ROW_H / 2);
      rowIdx++;
      if (!collapsed.has(g.id)) {
        for (const c of g.children) {
          map.set(c.id, headerH + rowIdx * ROW_H + ROW_H / 2);
          rowIdx++;
        }
      }
    }
    return map;
  }, [scheduledGroups, collapsed]);

  // Maps each rendered item ID → {leftX, rightX} in table coordinates (includes LEFT_W offset)
  const barXMap = useMemo(() => {
    const map = new Map<string, { leftX: number; rightX: number }>();
    for (const g of scheduledGroups) {
      if (g.startDate && g.endDate) {
        const left = Math.max(0, differenceInCalendarDays(dateOnlyAsLocalDate(g.startDate), viewStart)) * pxPerDay;
        const end  = Math.min(totalWidth, (differenceInCalendarDays(dateOnlyAsLocalDate(g.endDate), viewStart) + 1) * pxPerDay);
        map.set(g.id, { leftX: LEFT_W + left, rightX: LEFT_W + Math.max(end, left + 8) });
      }
      for (const c of g.children) {
        if (c.type === "milestone" && c.endDate) {
          const dayOffset = differenceInCalendarDays(dateOnlyAsLocalDate(c.endDate), viewStart);
          const centerX = LEFT_W + dayOffset * pxPerDay + pxPerDay * 0.5;
          const size    = Math.round(ROW_H * 0.45);
          map.set(c.id, { leftX: centerX - size / 2, rightX: centerX + size / 2 });
        } else if (c.startDate && c.endDate) {
          const left = Math.max(0, differenceInCalendarDays(dateOnlyAsLocalDate(c.startDate), viewStart)) * pxPerDay;
          const end  = Math.min(totalWidth, (differenceInCalendarDays(dateOnlyAsLocalDate(c.endDate), viewStart) + 1) * pxPerDay);
          map.set(c.id, { leftX: LEFT_W + left, rightX: LEFT_W + Math.max(end, left + 8) });
        }
      }
    }
    return map;
  }, [scheduledGroups, viewStart, pxPerDay, totalWidth]);

  const totalTableHeight = useMemo(() => {
    let rows = 0;
    for (const g of scheduledGroups) {
      rows++;
      if (!collapsed.has(g.id)) rows += g.children.length;
    }
    if (unscheduledItems.length > 0) rows += 1 + unscheduledItems.length;
    return TOP_H + BTM_H + rows * ROW_H;
  }, [scheduledGroups, collapsed, unscheduledItems]);

  const dependencyArrows = useMemo(() => {
    if (!dependencies?.length) return [];
    const arrows: { path: string; color: string; markerId: string }[] = [];
    for (const dep of dependencies) {
      const predY  = rowPositions.get(dep.predecessorId);
      const succY  = rowPositions.get(dep.successorId);
      const predBar = barXMap.get(dep.predecessorId);
      const succBar = barXMap.get(dep.successorId);
      if (predY === undefined || succY === undefined || !predBar || !succBar) continue;

      let path: string;
      const py = predY, sy = succY;
      switch (dep.type) {
        case "FINISH_TO_START": {
          const px = predBar.rightX, sx = succBar.leftX;
          path = `M ${px},${py} H ${px + STUB} V ${sy} H ${sx}`;
          break;
        }
        case "START_TO_START": {
          const px = predBar.leftX, sx = succBar.leftX;
          path = `M ${px},${py} H ${Math.min(px, sx) - STUB} V ${sy} H ${sx}`;
          break;
        }
        case "FINISH_TO_FINISH": {
          const px = predBar.rightX, sx = succBar.rightX;
          path = `M ${px},${py} H ${Math.max(px, sx) + STUB} V ${sy} H ${sx}`;
          break;
        }
        case "START_TO_FINISH": {
          const px = predBar.leftX, sx = succBar.rightX;
          path = `M ${px},${py} H ${px - STUB} V ${sy} H ${sx}`;
          break;
        }
        default:
          continue;
      }
      arrows.push({ path, color: DEP_COLORS[dep.type] ?? "#6366f1", markerId: `dep-arrow-${dep.type}` });
    }
    return arrows;
  }, [dependencies, rowPositions, barXMap]);

  // ── Drag handlers (DOM-direct, zero re-renders during move) ───────────────
  function startDrag(
    e: React.PointerEvent<HTMLDivElement>,
    id: string, isGroup: boolean, isMilestone: boolean,
    startDate: string, endDate: string, href: string,
    milestoneStartDate: string | null = null,
  ) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, isGroup, isMilestone, startDate, endDate, milestoneStartDate, href, startX: e.clientX };
  }

  function moveDrag(e: React.PointerEvent<HTMLDivElement>, id: string) {
    const d = dragRef.current;
    if (!d || d.id !== id) return;
    const delta = e.clientX - d.startX;
    const el = barElRefs.current.get(id);
    if (el) el.style.transform = `translateX(${delta}px)`;
  }

  async function endDrag(e: React.PointerEvent<HTMLDivElement>, id: string) {
    const d = dragRef.current;
    if (!d || d.id !== id) return;
    dragRef.current = null;
    // Any snapshot that arrived mid-gesture is applied now, BEFORE this
    // drop's optimistic update (queued after it, so the drop wins).
    flushDeferredSnapshot();

    const delta = e.clientX - d.startX;
    const el = barElRefs.current.get(id);
    if (el) el.style.transform = "";

    if (Math.abs(delta) < 5) {
      router.push(d.href);
      return;
    }

    const days = Math.round(delta / pxPerDay);
    if (days === 0) return;

    // Canonical, time-zone-independent calendar-day shift (lib/date-only.ts)
    // — the same one Resource Planning uses; both dates move by the same
    // delta, so duration is preserved and the stored value is always the
    // intended day at UTC midnight, whatever the browser's zone or DST.
    let newStart: string;
    let newEnd: string;
    if (d.isMilestone) {
      const newDate = shiftDateOnly(d.endDate, days);
      newStart = newDate;
      newEnd   = newDate;
    } else {
      newStart = shiftDateOnly(d.startDate, days);
      newEnd   = shiftDateOnly(d.endDate,   days);
    }
    // Expected milestone: its existing Expected Start moves with it; a
    // missing one stays missing (never created).
    const newMilestoneStart = d.isMilestone && d.milestoneStartDate ? shiftDateOnly(d.milestoneStartDate, days) : null;

    // Optimistic: snap bar to new position immediately, no post-drop flicker
    pendingSaves.current.add(id);
    setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, newStart, newEnd, newMilestoneStart));

    const url  = d.isGroup ? `/api/projects/${id}` : `/api/activities/${id}`;
    // Mode-aware field mapping (lib/timeline-mode.ts): Actual writes
    // startDate/endDate|dueDate exactly as before; Expected writes only
    // expectedStartDate/expectedFinishDate (a milestone: expectedFinishDate).
    const body = buildSchedulingPatch(
      d.isGroup ? "project" : d.isMilestone ? "milestone" : "activity",
      timelineMode ?? DEFAULT_TIMELINE_MODE,
      d.isMilestone ? newMilestoneStart : newStart,
      newEnd,
    );

    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // Committed version of this write — an older snapshot (a slow refresh
        // rendered before it) can no longer overwrite it.
        recordConfirmedWrite({ pending: pendingSaves.current, confirmed: confirmedSaves.current }, id, await res.json().catch(() => null));
        toast.success(`${isExpectedMode ? "Expected dates" : "Dates"} shifted ${days > 0 ? "+" : ""}${days}d`);
        pendingSaves.current.delete(id);
        router.refresh();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to update dates");
        pendingSaves.current.delete(id);
        setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, d.startDate, d.endDate, d.milestoneStartDate));
      }
    } catch {
      toast.error("Failed to update dates");
      pendingSaves.current.delete(id);
      setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, d.startDate, d.endDate, d.milestoneStartDate));
    }
  }

  function cancelDrag(id: string) {
    if (dragRef.current?.id === id) dragRef.current = null;
    const el = barElRefs.current.get(id);
    if (el) el.style.transform = "";
    flushDeferredSnapshot();
  }

  // ── Bar (activities and project rows) ─────────────────────────────────────
  function Bar({
    item, barH, isGroup,
  }: {
    item: {
      id: string; title: string; status: string;
      statusLabel?: string; statusColor?: string;
      priority?: string | null;
      startDate: string | null; endDate: string | null;
      /** null means no ActivityProgressConfig row is configured/enabled for this activity's department+status — never rendered as 0%/hidden, shown as "Configuration required" in the tooltip instead. Always a real number for a project bar (group.progress, the stored rollup). */
      progress: number | null; href: string;
      assigneeName?: string | null; assigneeImage?: string | null;
      ownerName?: string | null; ownerImage?: string | null;
      overdue?: boolean;
      /** See GanttItem's own doc comment — a child-only display hint, never set on a group/project item. */
      extendsPastProject?: boolean;
      /** Facilities Services Quarter precision only — see GanttGroup's own doc comment. */
      facilitiesStartLabel?: string | null; facilitiesEndLabel?: string | null;
    };
    barH: number;
    isGroup: boolean;
  }) {
    const m = barMetrics(item.startDate, item.endDate);
    if (!m) return null;

    // An activity item always carries its own department-resolved
    // label/color (lib/services/activity-status-config.ts) — used as an
    // inline color instead of the legacy Tailwind-class map. A project
    // (group) bar has neither and keeps the class-based STATUS_BAR lookup
    // (ProjectStatus isn't part of this department-scoping system).
    const hasCustomColor = !!item.statusColor;
    const barColorClass = hasCustomColor ? "" : (STATUS_BAR[item.status] ?? "bg-slate-400");
    const barInlineStyle = hasCustomColor ? { backgroundColor: item.statusColor } : undefined;
    const displayLabel = item.statusLabel ?? STATUS_LABEL[item.status] ?? item.status;
    const top         = (ROW_H - barH) / 2;
    const personName  = item.assigneeName  ?? item.ownerName;
    const personImage = item.assigneeImage ?? item.ownerImage;
    const isDraggable = canEdit && !!(item.startDate && item.endDate);

    const handlePointerDown = isDraggable
      ? (e: React.PointerEvent<HTMLDivElement>) =>
          startDrag(e, item.id, isGroup, false, item.startDate!, item.endDate!, item.href)
      : undefined;

    const handlePointerMove = isDraggable
      ? (e: React.PointerEvent<HTMLDivElement>) => moveDrag(e, item.id)
      : undefined;

    const handlePointerUp = isDraggable
      ? (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, item.id)
      : undefined;

    const handlePointerCancel = isDraggable
      ? () => cancelDrag(item.id)
      : undefined;

    const handleClick = isDraggable
      ? undefined
      : () => router.push(item.href);

    const barEl = (
      <div
        ref={(el) => {
          if (el) barElRefs.current.set(item.id, el);
          else barElRefs.current.delete(item.id);
        }}
        className={cn(
          "absolute select-none outline-none",
          isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        )}
        style={{ left: m.left, width: m.width, top, height: barH, touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={handleClick}
      >
        <div
          className={cn(
            "relative w-full h-full overflow-hidden transition-opacity",
            isGroup ? "rounded shadow-sm" : "rounded-sm",
            barColorClass,
            item.status === "CANCELLED" && "opacity-40",
          )}
          style={barInlineStyle}
        >
          {item.progress != null && item.progress > 0 && (
            <div
              className="absolute inset-y-0 left-0 bg-black/25"
              style={{ width: `${item.progress}%` }}
            />
          )}
          {m.width > 48 && (
            <span className="absolute inset-0 flex items-center px-2 text-[10px] font-medium text-white truncate pointer-events-none z-10 drop-shadow-sm">
              {item.progress != null && item.progress > 0 ? `${item.progress}%` : item.title}
            </span>
          )}
          <div className="absolute inset-0 rounded ring-0 hover:ring-2 hover:ring-white/60 transition-all pointer-events-none" />
        </div>
      </div>
    );

    return (
      <Tooltip>
        <TooltipTrigger asChild>{barEl}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] space-y-2 p-3">
          <div>
            <p className="font-semibold text-sm leading-snug">{item.title}</p>
            <p className="text-[11px] text-muted-foreground">{isGroup ? "Project" : "Activity"}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className={cn("inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium text-white", barColorClass)} style={barInlineStyle}>
              {displayLabel}
            </span>
            {item.priority && PRIORITY_CLS[item.priority] && (
              <span className={cn("text-[11px] px-2 py-0.5 rounded-full font-medium", PRIORITY_CLS[item.priority])}>
                {item.priority}
              </span>
            )}
            {item.overdue && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                Overdue
              </span>
            )}
            {item.extendsPastProject && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                <CalendarClock className="h-2.5 w-2.5" />
                Ends after project end date
              </span>
            )}
          </div>
          <div className="text-xs space-y-0.5">
            {/* Facilities Services with Quarter precision: show the
                explicit "Q2 2027" label instead of the formatted derived
                boundary date — never present a Quarter boundary as if it
                were a user-entered exact date. startDate/endDate
                themselves are untouched either way; they're what
                positioned/sized this bar in the first place. */}
            {item.startDate && <p><span className="text-muted-foreground">{isExpectedMode ? "Expected start:" : "Start:"}</span>{" "}{item.facilitiesStartLabel ?? format(dateOnlyAsLocalDate(item.startDate), "MMM d, yyyy")}</p>}
            {item.endDate   && <p><span className="text-muted-foreground">{isExpectedMode ? "Expected finish:" : "End:"}</span>{" "}{item.facilitiesEndLabel ?? format(dateOnlyAsLocalDate(item.endDate),   "MMM d, yyyy")}</p>}
          </div>
          {item.progress != null && item.progress > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-semibold">{item.progress}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full", barColorClass)} style={{ width: `${item.progress}%`, ...barInlineStyle }} />
              </div>
            </div>
          )}
          {item.progress === null && (
            <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">Configuration required — no progress percentage configured for this status.</p>
          )}
          {personName && (
            <div className="flex items-center gap-1.5 text-xs">
              <Avatar className="h-4 w-4">
                <AvatarImage src={personImage ?? undefined} />
                <AvatarFallback className="text-[8px]">{getInitials(personName)}</AvatarFallback>
              </Avatar>
              <span>{personName}</span>
            </div>
          )}
          {isDraggable && (
            <p className="text-[10px] text-muted-foreground border-t pt-1.5">{isExpectedMode ? "Drag to move Expected dates" : "Drag to move dates"}</p>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── MilestoneMarker (diamond shape, positioned at endDate) ─────────────────
  function MilestoneMarker({ item }: { item: GanttItem }) {
    const d = parseDate(item.endDate);
    if (!d) return null;

    const dayOffset   = differenceInCalendarDays(d, viewStart);
    const centerX     = dayOffset * pxPerDay + pxPerDay * 0.5;
    const size        = Math.round(ROW_H * 0.45);
    const left        = centerX - size / 2;
    const top         = (ROW_H - size) / 2;
    const hasCustomColor = !!item.statusColor;
    const barColorClass = hasCustomColor ? "" : (STATUS_BAR[item.status] ?? "bg-slate-400");
    const barInlineStyle = hasCustomColor ? { backgroundColor: item.statusColor } : undefined;
    const displayLabel = item.statusLabel ?? STATUS_LABEL[item.status] ?? item.status;
    const isDraggable = canEdit && !!item.endDate;

    const markerEl = (
      <div
        ref={(el) => {
          if (el) barElRefs.current.set(item.id, el);
          else barElRefs.current.delete(item.id);
        }}
        className={cn(
          "absolute select-none",
          isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        )}
        style={{ left, top, width: size, height: size, touchAction: "none" }}
        onPointerDown={isDraggable
          ? (e) => startDrag(e, item.id, false, true, item.endDate!, item.endDate!, item.href, item.expectedMilestoneStartDate ?? null)
          : undefined}
        onPointerMove={isDraggable ? (e) => moveDrag(e, item.id) : undefined}
        onPointerUp={isDraggable ? (e) => endDrag(e, item.id) : undefined}
        onPointerCancel={isDraggable ? () => cancelDrag(item.id) : undefined}
        onClick={isDraggable ? undefined : () => router.push(item.href)}
      >
        <div
          className={cn("w-full h-full shadow-sm", barColorClass, item.status === "CANCELLED" && "opacity-40")}
          style={{ transform: "rotate(45deg)", ...barInlineStyle }}
        />
        <div
          className="absolute inset-0 hover:ring-2 hover:ring-white/60 transition-all pointer-events-none"
          style={{ transform: "rotate(45deg)" }}
        />
      </div>
    );

    return (
      <Tooltip>
        <TooltipTrigger asChild>{markerEl}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px] space-y-2 p-3">
          <div>
            <p className="font-semibold text-sm leading-snug">{item.title}</p>
            <p className="text-[11px] text-muted-foreground">Milestone</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className={cn("inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium text-white", barColorClass)} style={barInlineStyle}>
              {displayLabel}
            </span>
            {item.overdue && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                Overdue
              </span>
            )}
            {item.extendsPastProject && (
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                <CalendarClock className="h-2.5 w-2.5" />
                Ends after project end date
              </span>
            )}
          </div>
          {item.endDate && (
            <p className="text-xs">
              <span className="text-muted-foreground">{isExpectedMode ? "Expected date:" : "Date:"}</span>{" "}
              {format(dateOnlyAsLocalDate(item.endDate), "MMM d, yyyy")}
            </p>
          )}
          {isDraggable && (
            <p className="text-[10px] text-muted-foreground border-t pt-1.5">{isExpectedMode ? (item.expectedMilestoneStartDate ? "Drag to move Expected Start / Finish together" : "Drag to move Expected Finish") : "Drag to move date"}</p>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">

        {/* Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 border rounded-lg p-1 bg-background">
            {(["day", "week", "month"] as ViewMode[]).map((m) => (
              <Button key={m} variant={viewMode === m ? "default" : "ghost"} size="sm" className="h-7 px-3 text-xs capitalize" onClick={() => setViewMode(m)}>
                {m}
              </Button>
            ))}
          </div>

          {timelineMode && <TimelineModeToggle mode={timelineMode} />}

          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={scrollToToday}>
            <CalendarDays className="h-3.5 w-3.5" />
            Today
          </Button>

          <div className="flex items-center border rounded-lg divide-x bg-background overflow-hidden">
            <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-xs rounded-none border-0" onClick={expandAll}>
              <Maximize2 className="h-3.5 w-3.5" />
              Expand all
            </Button>
            <Button variant="ghost" size="sm" className="h-9 gap-1.5 text-xs rounded-none border-0" onClick={collapseAll}>
              <Minimize2 className="h-3.5 w-3.5" />
              Collapse all
            </Button>
          </div>

          {/* Below sm the filters take the full row (two selects side by
              side, search full width) instead of overflowing the viewport;
              from sm up every class resolves to the original desktop layout
              (ml-auto, 150px selects, w-44 search). */}
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-[calc(50%-0.25rem)] sm:w-[150px] text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {allStatuses.map((s) => (
                  <SelectItem key={s} value={s}>{statusLabelFor(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="h-9 w-[calc(50%-0.25rem)] sm:w-[150px] text-xs">
                <SelectValue placeholder="All priorities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All priorities</SelectItem>
                {priorityOptions.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative w-full sm:w-auto">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="h-9 pl-8 pr-8 w-full sm:w-44 text-xs" />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {isExpectedMode && (
          <p className="text-xs text-muted-foreground" data-testid="timeline-expected-note">
            Showing <span className="font-medium text-foreground">Expected</span> Start / Finish dates. Dragging changes Expected dates only — Actual dates are never modified.
          </p>
        )}

        {/* Legend */}
        <StatusLegend entries={activityStatusLegendEntries} />

        {/* Chart */}
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto" ref={scrollRef}>
            <div className="relative" style={{ width: LEFT_W + totalWidth }}>
            <table
              style={{ width: LEFT_W + totalWidth, borderCollapse: "separate", borderSpacing: 0 }}
              className="text-sm"
            >
              {/* ── Header ── */}
              <thead>
                {/* Top row: months / years */}
                <tr style={{ height: TOP_H }}>
                  <th className="sticky left-0 z-30 bg-muted border-b" style={{ width: LEFT_W, minWidth: LEFT_W }} />
                  <th className="relative border-b bg-muted p-0" style={{ width: totalWidth }}>
                    <div className="relative" style={{ width: totalWidth, height: TOP_H }}>
                      {topCells.map((cell, i) => (
                        <div key={i} className="absolute flex items-center border-r px-2 overflow-hidden" style={{ left: cell.left, width: cell.width, height: TOP_H }}>
                          <span className="text-[10px] font-semibold text-muted-foreground truncate">{cell.label}</span>
                        </div>
                      ))}
                    </div>
                  </th>
                </tr>
                {/* Bottom row: scale */}
                <tr style={{ height: BTM_H }}>
                  <th className="sticky left-0 z-30 bg-muted text-left border-b border-r px-3 font-medium text-muted-foreground text-xs" style={{ width: LEFT_W, minWidth: LEFT_W }}>
                    Name
                  </th>
                  <th className="relative border-b bg-muted p-0" style={{ width: totalWidth }}>
                    <div className="relative" style={{ width: totalWidth, height: BTM_H }}>
                      {weekendStripes.map((s, i) => (
                        <div key={i} className="absolute inset-y-0 bg-muted-foreground/8 pointer-events-none" style={{ left: s.left, width: s.width }} />
                      ))}
                      {btmCells.map((cell, i) => (
                        <div key={i} className={cn("absolute flex items-center justify-center border-r overflow-hidden", cell.highlight && "bg-primary/15")} style={{ left: cell.left, width: cell.width, height: BTM_H }}>
                          <span className={cn("text-[10px] truncate px-0.5", cell.highlight ? "text-primary font-bold" : "text-muted-foreground")}>
                            {cell.label}
                          </span>
                        </div>
                      ))}
                      {showToday && (
                        <div className="absolute top-0 h-full w-0.5 bg-red-500 pointer-events-none z-10" style={{ left: todayPx }} />
                      )}
                    </div>
                  </th>
                </tr>
              </thead>

              {/* ── Body ── */}
              <tbody>
                {scheduledGroups.length === 0 && unscheduledItems.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="text-center text-muted-foreground py-20 text-sm">
                      {isExpectedMode
                        ? "No items to display. Add Expected Start / Finish dates to projects and activities to see them here."
                        : "No items to display. Add dates to projects and activities to see them here."}
                    </td>
                  </tr>
                ) : (
                  <>
                    {scheduledGroups.map((group) => {
                      const isCollapsed = collapsed.has(group.id);
                      return (
                        <Fragment key={group.id}>
                          {/* Group row */}
                          <tr style={{ height: ROW_H }} className="border-b">
                            <td
                              className="sticky left-0 z-20 bg-muted border-r"
                              style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                            >
                              <div className="flex items-center gap-1.5 px-2 h-full min-w-0">
                                <button onClick={() => toggleCollapse(group.id)} className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors" aria-label={isCollapsed ? "Expand" : "Collapse"}>
                                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                </button>
                                <span className={cn("h-2 w-2 rounded-full flex-shrink-0", !group.statusColor && (STATUS_BAR[group.status] ?? "bg-slate-400"))} style={group.statusColor ? { backgroundColor: group.statusColor } : undefined} />
                                {group.ownerImage !== undefined && (
                                  <Avatar className="h-5 w-5 flex-shrink-0">
                                    <AvatarImage src={group.ownerImage ?? undefined} />
                                    <AvatarFallback className="text-[9px]">{getInitials(group.ownerName)}</AvatarFallback>
                                  </Avatar>
                                )}
                                <Link href={group.href} className="font-semibold text-xs truncate hover:text-primary transition-colors">
                                  {group.title}
                                </Link>
                                {group.overdue && (
                                  <AlertTriangle className="h-3 w-3 text-red-600 dark:text-red-400 flex-shrink-0" aria-label="Overdue" />
                                )}
                                {group.progress > 0 && (
                                  <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-auto">{group.progress}%</span>
                                )}
                              </div>
                            </td>
                            <td className="relative p-0" style={{ width: totalWidth, height: ROW_H }}>
                              {weekendStripes.map((s, i) => (
                                <div key={i} className="absolute inset-y-0 bg-muted/40 pointer-events-none" style={{ left: s.left, width: s.width }} />
                              ))}
                              {showToday && (
                                <div className="absolute inset-y-0 w-0.5 bg-red-500/70 pointer-events-none z-10" style={{ left: todayPx }} />
                              )}
                              {/* Called as a function, NOT mounted as <Bar/>: Bar is
                                  declared inside GanttChart, so as a component its
                                  identity changed every render and React re-mounted
                                  the bar — a refresh landing mid-drag then lost the
                                  pointer capture. As a call, the returned elements
                                  keep a stable identity across re-renders. */}
                              {Bar({
                                item: { id: group.id, title: group.title, status: group.status, statusLabel: group.statusLabel, statusColor: group.statusColor, startDate: group.startDate, endDate: group.endDate, progress: group.progress, href: group.href, ownerName: group.ownerName, ownerImage: group.ownerImage, overdue: group.overdue, facilitiesStartLabel: group.facilitiesStartLabel, facilitiesEndLabel: group.facilitiesEndLabel },
                                barH: 24,
                                isGroup: true,
                              })}
                            </td>
                          </tr>

                          {/* Activity / milestone rows */}
                          {!isCollapsed && group.children.map((child) => {
                          // Purely a display hint — never derived/validated
                          // server-side, never affects `overdue` (a
                          // different, self-contained concept). See
                          // GanttItem's own doc comment.
                          const extendsPastProject = !!(child.endDate && group.endDate && new Date(child.endDate) > new Date(group.endDate));
                          return (
                            <tr key={child.id} style={{ height: ROW_H }} className="border-b hover:bg-muted/5 transition-colors">
                              <td
                                className="sticky left-0 z-20 bg-background border-r"
                                style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                              >
                                <div className="flex items-center gap-1.5 pl-8 pr-2 h-full min-w-0">
                                  {child.type === "milestone" ? (
                                    <div className={cn("h-2 w-2 flex-shrink-0 rotate-45", !child.statusColor && (STATUS_BAR[child.status] ?? "bg-slate-400"))} style={child.statusColor ? { backgroundColor: child.statusColor } : undefined} />
                                  ) : (
                                    <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", !child.statusColor && (STATUS_BAR[child.status] ?? "bg-slate-400"))} style={child.statusColor ? { backgroundColor: child.statusColor } : undefined} />
                                  )}
                                  {child.type !== "milestone" && child.assigneeImage !== undefined && (
                                    <Avatar className="h-4 w-4 flex-shrink-0">
                                      <AvatarImage src={child.assigneeImage ?? undefined} />
                                      <AvatarFallback className="text-[8px]">{getInitials(child.assigneeName)}</AvatarFallback>
                                    </Avatar>
                                  )}
                                  <Link href={child.href} className="text-xs truncate hover:text-primary transition-colors">
                                    {child.title}
                                  </Link>
                                  {child.overdue && (
                                    <AlertTriangle className="h-3 w-3 text-red-600 dark:text-red-400 flex-shrink-0" aria-label="Overdue" />
                                  )}
                                  {extendsPastProject && (
                                    <CalendarClock
                                      className="h-3 w-3 text-amber-600 dark:text-amber-400 flex-shrink-0"
                                      aria-label="Ends after project end date"
                                    >
                                      <title>Ends after project end date</title>
                                    </CalendarClock>
                                  )}
                                  {child.type === "milestone" && (
                                    <span className="text-[9px] px-1 py-0.5 rounded font-medium flex-shrink-0 ml-auto bg-violet-50 text-violet-700 border border-violet-200">
                                      M
                                    </span>
                                  )}
                                  {child.type !== "milestone" && child.priority && PRIORITY_CLS[child.priority] && (
                                    <span className={cn("text-[9px] px-1 py-0.5 rounded font-medium flex-shrink-0 ml-auto", PRIORITY_CLS[child.priority])}>
                                      {child.priority}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="relative p-0" style={{ width: totalWidth, height: ROW_H }}>
                                {weekendStripes.map((s, i) => (
                                  <div key={i} className="absolute inset-y-0 bg-muted/40 pointer-events-none" style={{ left: s.left, width: s.width }} />
                                ))}
                                {showToday && (
                                  <div className="absolute inset-y-0 w-0.5 bg-red-500/70 pointer-events-none z-10" style={{ left: todayPx }} />
                                )}
                                {child.type === "milestone"
                                  ? MilestoneMarker({ item: { ...child, extendsPastProject } })
                                  : Bar({ item: { ...child, extendsPastProject }, barH: 16, isGroup: false })
                                }
                              </td>
                            </tr>
                          );
                          })}
                        </Fragment>
                      );
                    })}

                    {/* Unscheduled section */}
                    {unscheduledItems.length > 0 && (
                      <>
                        <tr>
                          <td colSpan={2} className="bg-muted/40 border-y px-4 py-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                              Unscheduled — {unscheduledItems.length} item{unscheduledItems.length !== 1 ? "s" : ""} without {isExpectedMode ? "Expected dates" : "dates"}
                            </span>
                          </td>
                        </tr>
                        {unscheduledItems.map((item) => (
                          <tr key={`u-${item.id}`} style={{ height: ROW_H }} className="border-b hover:bg-muted/5">
                            <td
                              className="sticky left-0 z-20 bg-background border-r"
                              style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                            >
                              <div className={cn("flex items-center gap-1.5 h-full min-w-0", item.isGroup ? "px-7" : "pl-8 pr-2")}>
                                {item.isMilestone ? (
                                  <div className={cn("h-2 w-2 flex-shrink-0 rotate-45", !item.statusColor && (STATUS_BAR[item.status] ?? "bg-slate-400"))} style={item.statusColor ? { backgroundColor: item.statusColor } : undefined} />
                                ) : (
                                  <span className={cn("rounded-full flex-shrink-0", item.isGroup ? "h-2 w-2" : "h-1.5 w-1.5", !item.statusColor && (STATUS_BAR[item.status] ?? "bg-slate-400"))} style={item.statusColor ? { backgroundColor: item.statusColor } : undefined} />
                                )}
                                <Link href={item.href} className={cn("truncate hover:text-primary transition-colors text-muted-foreground/70", item.isGroup ? "text-xs font-semibold" : "text-xs")}>
                                  {item.title}
                                </Link>
                              </div>
                            </td>
                            <td className="relative p-0" style={{ width: totalWidth, height: ROW_H }}>
                              {weekendStripes.map((s, i) => (
                                <div key={i} className="absolute inset-y-0 bg-muted/40 pointer-events-none" style={{ left: s.left, width: s.width }} />
                              ))}
                              {showToday && (
                                <div className="absolute inset-y-0 w-0.5 bg-red-500/70 pointer-events-none z-10" style={{ left: todayPx }} />
                              )}
                              <div className="absolute inset-0 flex items-center pl-3">
                                <span className="text-[11px] text-muted-foreground/50 italic select-none">{isExpectedMode ? "No Expected dates set" : "No dates set"}</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </>
                    )}
                  </>
                )}
              </tbody>
            </table>
            {dependencyArrows.length > 0 && (
              <svg
                className="absolute top-0 left-0 pointer-events-none"
                style={{ zIndex: 15 }}
                width={LEFT_W + totalWidth}
                height={totalTableHeight}
                overflow="visible"
              >
                <defs>
                  {Object.entries(DEP_COLORS).map(([type, color]) => (
                    <marker
                      key={type}
                      id={`dep-arrow-${type}`}
                      markerWidth="6"
                      markerHeight="6"
                      refX="5"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L6,3 L0,6 Z" fill={color} />
                    </marker>
                  ))}
                </defs>
                {dependencyArrows.map((arrow, i) => (
                  <path
                    key={i}
                    d={arrow.path}
                    stroke={arrow.color}
                    strokeWidth={1.5}
                    fill="none"
                    markerEnd={`url(#${arrow.markerId})`}
                    strokeDasharray="4 2"
                    opacity={0.75}
                  />
                ))}
              </svg>
            )}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
