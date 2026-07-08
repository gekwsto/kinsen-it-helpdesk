"use client";

import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  format,
  addDays,
  addMonths,
  startOfMonth,
  endOfMonth,
  differenceInDays,
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
} from "lucide-react";
import { getInitials } from "@/lib/utils";

export type ViewMode = "day" | "week" | "month";

const PX_PER_DAY: Record<ViewMode, number> = { day: 40, week: 16, month: 6 };

const ROW_H  = 44;
const TOP_H  = 22;
const BTM_H  = 30;
const LEFT_W = 296;

const STATUS_BAR: Record<string, string> = {
  PLANNING:    "bg-blue-500",
  TODO:        "bg-slate-400",
  IN_PROGRESS: "bg-amber-500",
  ON_HOLD:     "bg-orange-400",
  BLOCKED:     "bg-red-500",
  COMPLETED:   "bg-emerald-500",
  CANCELLED:   "bg-gray-300",
};

const STATUS_DOT: Record<string, string> = {
  PLANNING:    "bg-blue-500",
  TODO:        "bg-slate-400",
  IN_PROGRESS: "bg-amber-500",
  ON_HOLD:     "bg-orange-400",
  BLOCKED:     "bg-red-500",
  COMPLETED:   "bg-emerald-500",
  CANCELLED:   "bg-gray-300",
};

const STATUS_LABEL: Record<string, string> = {
  PLANNING: "Planning", TODO: "To Do", IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold", BLOCKED: "Blocked", COMPLETED: "Completed", CANCELLED: "Cancelled",
};

const PRIORITY_CLS: Record<string, string> = {
  LOW:    "bg-green-50 text-green-700 border border-green-200",
  MEDIUM: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  HIGH:   "bg-orange-50 text-orange-700 border border-orange-200",
  URGENT: "bg-red-50 text-red-700 border border-red-200",
};

export interface GanttItem {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  href: string;
  assigneeName?: string | null;
  assigneeImage?: string | null;
  type: "activity" | "milestone";
}

export interface GanttGroup {
  id: string;
  title: string;
  href: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  ownerName?: string | null;
  ownerImage?: string | null;
  type: "project" | "standalone";
  children: GanttItem[];
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
  href: string;
  startX: number;
};

function parseDate(d: string | null): Date | null {
  return d ? new Date(d) : null;
}

function applyDateChange(
  current: GanttGroup[],
  id: string,
  isGroup: boolean,
  newStart: string,
  newEnd: string,
): GanttGroup[] {
  if (isGroup) {
    return current.map(g =>
      g.id === id ? { ...g, startDate: newStart, endDate: newEnd } : g,
    );
  }
  return current.map(g => ({
    ...g,
    children: g.children.map(c =>
      c.id === id ? { ...c, startDate: newStart, endDate: newEnd } : c,
    ),
  }));
}

export function GanttChart({ groups, canEdit = false, dependencies }: GanttChartProps) {
  const router = useRouter();

  // ── Optimistic local state ─────────────────────────────────────────────────
  // Updated immediately on drop → zero flicker. Synced back from server after
  // router.refresh() completes, skipping IDs that are still in-flight.
  const [localGroups, setLocalGroups] = useState<GanttGroup[]>(groups);
  const pendingSaves = useRef(new Set<string>());

  useEffect(() => {
    if (pendingSaves.current.size === 0) {
      setLocalGroups(groups);
      return;
    }
    setLocalGroups(prev =>
      groups.map(serverGroup => {
        if (pendingSaves.current.has(serverGroup.id)) {
          return prev.find(g => g.id === serverGroup.id) ?? serverGroup;
        }
        return {
          ...serverGroup,
          children: serverGroup.children.map(serverChild => {
            if (pendingSaves.current.has(serverChild.id)) {
              const prevGroup = prev.find(g => g.id === serverGroup.id);
              return prevGroup?.children.find(c => c.id === serverChild.id) ?? serverChild;
            }
            return serverChild;
          }),
        };
      }),
    );
  }, [groups]);

  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Drag state — refs only so pointer-move never triggers React re-renders
  const barElRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef   = useRef<DragMeta | null>(null);

  const today = useMemo(() => new Date(), []);

  // ── Client-side filtering (uses localGroups) ───────────────────────────────
  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase();
    return localGroups
      .map((g) => ({
        ...g,
        children: g.children.filter((c) => {
          if (q && !c.title.toLowerCase().includes(q)) return false;
          if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
          return true;
        }),
      }))
      .filter((g) => {
        if (!q && statusFilter === "ALL") return true;
        const groupMatch = !q || g.title.toLowerCase().includes(q);
        const statusOk   = statusFilter === "ALL" || g.status === statusFilter;
        return (groupMatch && statusOk) || g.children.length > 0;
      });
  }, [localGroups, search, statusFilter]);

  // ── Separate scheduled / unscheduled ──────────────────────────────────────
  const { scheduledGroups, unscheduledItems } = useMemo(() => {
    type UItem = {
      id: string; title: string; href: string; status: string;
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
        unscheduled.push({ id: g.id, title: g.title, href: g.href, status: g.status, isGroup: true, isMilestone: false });
      }

      for (const c of unscheduledKids) {
        unscheduled.push({
          id: c.id, title: c.title, href: c.href, status: c.status,
          priority: c.priority, isGroup: false, isMilestone: c.type === "milestone",
        });
      }
    }
    return { scheduledGroups: scheduled, unscheduledItems: unscheduled };
  }, [filteredGroups]);

  // ── Timeline bounds (always includes today) ────────────────────────────────
  const { viewStart, viewEnd } = useMemo(() => {
    const dates: number[] = [today.getTime()];
    for (const g of scheduledGroups) {
      if (g.startDate) dates.push(new Date(g.startDate).getTime());
      if (g.endDate)   dates.push(new Date(g.endDate).getTime());
      for (const c of g.children) {
        if (c.startDate) dates.push(new Date(c.startDate).getTime());
        if (c.endDate)   dates.push(new Date(c.endDate).getTime());
      }
    }
    return {
      viewStart: addDays(new Date(Math.min(...dates)), -14),
      viewEnd:   addDays(new Date(Math.max(...dates)), 14),
    };
  }, [scheduledGroups, today]);

  const pxPerDay    = PX_PER_DAY[viewMode];
  const totalDays   = Math.max(differenceInDays(viewEnd, viewStart), 1);
  const totalWidth  = totalDays * pxPerDay;
  const todayOffset = differenceInDays(today, viewStart);
  const todayPx     = todayOffset * pxPerDay;
  const showToday   = todayOffset >= 0 && todayOffset <= totalDays;

  function scrollToToday() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, todayPx - (el.clientWidth - LEFT_W) / 2);
  }

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
        top.push({ label: format(cur, "MMMM yyyy"), left: differenceInDays(s, viewStart) * pxPerDay, width: (differenceInDays(e, s) + 1) * pxPerDay });
        cur = addMonths(cur, 1);
      }
    } else {
      for (let y = viewStart.getFullYear(); y <= viewEnd.getFullYear(); y++) {
        const ys = new Date(y, 0, 1);
        const ye = new Date(y, 11, 31);
        const s  = ys < viewStart ? viewStart : ys;
        const e  = ye > viewEnd   ? viewEnd   : ye;
        top.push({ label: String(y), left: differenceInDays(s, viewStart) * pxPerDay, width: (differenceInDays(e, s) + 1) * pxPerDay });
        y++;
      }
    }

    if (viewMode === "day") {
      let d = new Date(viewStart);
      while (d <= viewEnd) {
        btm.push({ label: format(d, "d"), left: differenceInDays(d, viewStart) * pxPerDay, width: pxPerDay, highlight: isSameDay(d, today) });
        d = addDays(d, 1);
      }
    } else if (viewMode === "week") {
      let d = new Date(viewStart);
      while (d <= viewEnd) {
        const wOff = differenceInDays(d, viewStart);
        btm.push({ label: format(d, "MMM d"), left: wOff * pxPerDay, width: 7 * pxPerDay, highlight: todayOffset >= wOff && todayOffset < wOff + 7 });
        d = addDays(d, 7);
      }
    } else {
      let cur = startOfMonth(viewStart);
      while (cur <= viewEnd) {
        const mEnd = endOfMonth(cur);
        const s    = cur < viewStart ? viewStart : cur;
        const e    = mEnd > viewEnd  ? viewEnd  : mEnd;
        btm.push({ label: format(cur, "MMM"), left: differenceInDays(s, viewStart) * pxPerDay, width: (differenceInDays(e, s) + 1) * pxPerDay, highlight: cur.getMonth() === today.getMonth() && cur.getFullYear() === today.getFullYear() });
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
      if (dow === 0 || dow === 6) s.push({ left: differenceInDays(d, viewStart) * pxPerDay, width: pxPerDay });
      d = addDays(d, 1);
    }
    return s;
  }, [viewMode, viewStart, viewEnd, pxPerDay]);

  // ── Bar geometry ──────────────────────────────────────────────────────────
  function barMetrics(startDate: string | null, endDate: string | null) {
    const s = parseDate(startDate);
    if (!s) return null;
    const e    = parseDate(endDate) ?? s;
    const left = Math.max(0, differenceInDays(s, viewStart)) * pxPerDay;
    const end  = Math.min(totalWidth, (differenceInDays(e, viewStart) + 1) * pxPerDay);
    return { left, width: Math.max(end - left, 8) };
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const expandAll   = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(scheduledGroups.map((g) => g.id)));

  const allStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const g of localGroups) { s.add(g.status); for (const c of g.children) s.add(c.status); }
    return [...s].sort();
  }, [localGroups]);

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
        const left = Math.max(0, differenceInDays(new Date(g.startDate), viewStart)) * pxPerDay;
        const end  = Math.min(totalWidth, (differenceInDays(new Date(g.endDate), viewStart) + 1) * pxPerDay);
        map.set(g.id, { leftX: LEFT_W + left, rightX: LEFT_W + Math.max(end, left + 8) });
      }
      for (const c of g.children) {
        if (c.type === "milestone" && c.endDate) {
          const dayOffset = differenceInDays(new Date(c.endDate), viewStart);
          const centerX = LEFT_W + dayOffset * pxPerDay + pxPerDay * 0.5;
          const size    = Math.round(ROW_H * 0.45);
          map.set(c.id, { leftX: centerX - size / 2, rightX: centerX + size / 2 });
        } else if (c.startDate && c.endDate) {
          const left = Math.max(0, differenceInDays(new Date(c.startDate), viewStart)) * pxPerDay;
          const end  = Math.min(totalWidth, (differenceInDays(new Date(c.endDate), viewStart) + 1) * pxPerDay);
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
  ) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, isGroup, isMilestone, startDate, endDate, href, startX: e.clientX };
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

    const delta = e.clientX - d.startX;
    const el = barElRefs.current.get(id);
    if (el) el.style.transform = "";

    if (Math.abs(delta) < 5) {
      router.push(d.href);
      return;
    }

    const days = Math.round(delta / pxPerDay);
    if (days === 0) return;

    let newStart: string;
    let newEnd: string;
    if (d.isMilestone) {
      const newDate = addDays(new Date(d.endDate), days).toISOString();
      newStart = newDate;
      newEnd   = newDate;
    } else {
      newStart = addDays(new Date(d.startDate), days).toISOString();
      newEnd   = addDays(new Date(d.endDate),   days).toISOString();
    }

    // Optimistic: snap bar to new position immediately, no post-drop flicker
    pendingSaves.current.add(id);
    setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, newStart, newEnd));

    const url  = d.isGroup ? `/api/projects/${id}` : `/api/activities/${id}`;
    const body = d.isGroup
      ? { startDate: newStart, endDate: newEnd }
      : { startDate: newStart, dueDate: newEnd };

    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(`Dates shifted ${days > 0 ? "+" : ""}${days}d`);
        pendingSaves.current.delete(id);
        router.refresh();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to update dates");
        pendingSaves.current.delete(id);
        setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, d.startDate, d.endDate));
      }
    } catch {
      toast.error("Failed to update dates");
      pendingSaves.current.delete(id);
      setLocalGroups(prev => applyDateChange(prev, id, d.isGroup, d.startDate, d.endDate));
    }
  }

  function cancelDrag(id: string) {
    if (dragRef.current?.id === id) dragRef.current = null;
    const el = barElRefs.current.get(id);
    if (el) el.style.transform = "";
  }

  // ── Bar (activities and project rows) ─────────────────────────────────────
  function Bar({
    item, barH, isGroup,
  }: {
    item: {
      id: string; title: string; status: string; priority?: string | null;
      startDate: string | null; endDate: string | null; progress: number; href: string;
      assigneeName?: string | null; assigneeImage?: string | null;
      ownerName?: string | null; ownerImage?: string | null;
    };
    barH: number;
    isGroup: boolean;
  }) {
    const m = barMetrics(item.startDate, item.endDate);
    if (!m) return null;

    const barColor    = STATUS_BAR[item.status] ?? "bg-slate-400";
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
            barColor,
            item.status === "CANCELLED" && "opacity-40",
          )}
        >
          {item.progress > 0 && (
            <div
              className="absolute inset-y-0 left-0 bg-black/25"
              style={{ width: `${item.progress}%` }}
            />
          )}
          {m.width > 48 && (
            <span className="absolute inset-0 flex items-center px-2 text-[10px] font-medium text-white truncate pointer-events-none z-10 drop-shadow-sm">
              {item.progress > 0 ? `${item.progress}%` : item.title}
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
            <span className={cn("inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium text-white", barColor)}>
              {STATUS_LABEL[item.status] ?? item.status}
            </span>
            {item.priority && PRIORITY_CLS[item.priority] && (
              <span className={cn("text-[11px] px-2 py-0.5 rounded-full font-medium", PRIORITY_CLS[item.priority])}>
                {item.priority}
              </span>
            )}
          </div>
          <div className="text-xs space-y-0.5">
            {item.startDate && <p><span className="text-muted-foreground">Start:</span>{" "}{format(new Date(item.startDate), "MMM d, yyyy")}</p>}
            {item.endDate   && <p><span className="text-muted-foreground">End:</span>{" "}{format(new Date(item.endDate),   "MMM d, yyyy")}</p>}
          </div>
          {item.progress > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-semibold">{item.progress}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full", barColor)} style={{ width: `${item.progress}%` }} />
              </div>
            </div>
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
            <p className="text-[10px] text-muted-foreground border-t pt-1.5">Drag to move dates</p>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── MilestoneMarker (diamond shape, positioned at endDate) ─────────────────
  function MilestoneMarker({ item }: { item: GanttItem }) {
    const d = parseDate(item.endDate);
    if (!d) return null;

    const dayOffset   = differenceInDays(d, viewStart);
    const centerX     = dayOffset * pxPerDay + pxPerDay * 0.5;
    const size        = Math.round(ROW_H * 0.45);
    const left        = centerX - size / 2;
    const top         = (ROW_H - size) / 2;
    const barColor    = STATUS_BAR[item.status] ?? "bg-slate-400";
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
          ? (e) => startDrag(e, item.id, false, true, item.endDate!, item.endDate!, item.href)
          : undefined}
        onPointerMove={isDraggable ? (e) => moveDrag(e, item.id) : undefined}
        onPointerUp={isDraggable ? (e) => endDrag(e, item.id) : undefined}
        onPointerCancel={isDraggable ? () => cancelDrag(item.id) : undefined}
        onClick={isDraggable ? undefined : () => router.push(item.href)}
      >
        <div
          className={cn("w-full h-full shadow-sm", barColor, item.status === "CANCELLED" && "opacity-40")}
          style={{ transform: "rotate(45deg)" }}
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
          <div>
            <span className={cn("inline-flex items-center text-[11px] px-2 py-0.5 rounded-full font-medium text-white", barColor)}>
              {STATUS_LABEL[item.status] ?? item.status}
            </span>
          </div>
          {item.endDate && (
            <p className="text-xs">
              <span className="text-muted-foreground">Date:</span>{" "}
              {format(new Date(item.endDate), "MMM d, yyyy")}
            </p>
          )}
          {isDraggable && (
            <p className="text-[10px] text-muted-foreground border-t pt-1.5">Drag to move date</p>
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

          <div className="ml-auto flex items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-[150px] text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {allStatuses.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABEL[s] ?? s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="h-9 pl-8 pr-8 w-44 text-xs" />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={cn("inline-block h-2 w-4 rounded-sm", STATUS_BAR[k])} />
              {v}
            </span>
          ))}
        </div>

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
                      No items to display. Add dates to projects and activities to see them here.
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
                                <span className={cn("h-2 w-2 rounded-full flex-shrink-0", STATUS_DOT[group.status] ?? "bg-slate-400")} />
                                {group.ownerImage !== undefined && (
                                  <Avatar className="h-5 w-5 flex-shrink-0">
                                    <AvatarImage src={group.ownerImage ?? undefined} />
                                    <AvatarFallback className="text-[9px]">{getInitials(group.ownerName)}</AvatarFallback>
                                  </Avatar>
                                )}
                                <Link href={group.href} className="font-semibold text-xs truncate hover:text-primary transition-colors">
                                  {group.title}
                                </Link>
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
                              <Bar
                                item={{ id: group.id, title: group.title, status: group.status, startDate: group.startDate, endDate: group.endDate, progress: group.progress, href: group.href, ownerName: group.ownerName, ownerImage: group.ownerImage }}
                                barH={24}
                                isGroup
                              />
                            </td>
                          </tr>

                          {/* Activity / milestone rows */}
                          {!isCollapsed && group.children.map((child) => (
                            <tr key={child.id} style={{ height: ROW_H }} className="border-b hover:bg-muted/5 transition-colors">
                              <td
                                className="sticky left-0 z-20 bg-background border-r"
                                style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                              >
                                <div className="flex items-center gap-1.5 pl-8 pr-2 h-full min-w-0">
                                  {child.type === "milestone" ? (
                                    <div className={cn("h-2 w-2 flex-shrink-0 rotate-45", STATUS_DOT[child.status] ?? "bg-slate-400")} />
                                  ) : (
                                    <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", STATUS_DOT[child.status] ?? "bg-slate-400")} />
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
                                  ? <MilestoneMarker item={child} />
                                  : <Bar item={child} barH={16} isGroup={false} />
                                }
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}

                    {/* Unscheduled section */}
                    {unscheduledItems.length > 0 && (
                      <>
                        <tr>
                          <td colSpan={2} className="bg-muted/40 border-y px-4 py-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                              Unscheduled — {unscheduledItems.length} item{unscheduledItems.length !== 1 ? "s" : ""} without dates
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
                                  <div className={cn("h-2 w-2 flex-shrink-0 rotate-45", STATUS_DOT[item.status] ?? "bg-slate-400")} />
                                ) : (
                                  <span className={cn("rounded-full flex-shrink-0", item.isGroup ? "h-2 w-2" : "h-1.5 w-1.5", STATUS_DOT[item.status] ?? "bg-slate-400")} />
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
                                <span className="text-[11px] text-muted-foreground/50 italic select-none">No dates set</span>
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
