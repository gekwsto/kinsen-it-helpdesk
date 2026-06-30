"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  format,
  addDays,
  addMonths,
  startOfMonth,
  endOfMonth,
  differenceInDays,
} from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getInitials } from "@/lib/utils";

export type ViewMode = "day" | "week" | "month";

const PX_PER_DAY: Record<ViewMode, number> = {
  day: 40,
  week: 16,
  month: 6,
};

const ROW_H = 44;
const HEADER_H = 56;
const LEFT_W = 284;

const STATUS_COLORS: Record<string, string> = {
  PLANNING:    "bg-blue-500",
  TODO:        "bg-slate-400",
  IN_PROGRESS: "bg-amber-500",
  ON_HOLD:     "bg-orange-400",
  BLOCKED:     "bg-red-500",
  COMPLETED:   "bg-emerald-500",
  CANCELLED:   "bg-gray-300",
};

export interface GanttItem {
  id: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  href: string;
  assigneeName?: string | null;
  assigneeImage?: string | null;
  type: "activity";
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

interface GanttChartProps {
  groups: GanttGroup[];
}

function parseDate(s: string | null): Date | null {
  return s ? new Date(s) : null;
}

export function GanttChart({ groups }: GanttChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const today = useMemo(() => new Date(), []);

  // Compute overall timeline bounds from all items
  const { viewStart, viewEnd } = useMemo(() => {
    const dates: number[] = [];
    for (const g of groups) {
      if (g.startDate) dates.push(new Date(g.startDate).getTime());
      if (g.endDate)   dates.push(new Date(g.endDate).getTime());
      for (const c of g.children) {
        if (c.startDate) dates.push(new Date(c.startDate).getTime());
        if (c.endDate)   dates.push(new Date(c.endDate).getTime());
      }
    }

    if (dates.length === 0) {
      return {
        viewStart: addMonths(startOfMonth(today), -1),
        viewEnd:   addMonths(endOfMonth(today), 2),
      };
    }

    return {
      viewStart: addDays(new Date(Math.min(...dates)), -14),
      viewEnd:   addDays(new Date(Math.max(...dates)), 14),
    };
  }, [groups, today]);

  const pxPerDay   = PX_PER_DAY[viewMode];
  const totalDays  = Math.max(differenceInDays(viewEnd, viewStart), 1);
  const totalWidth = totalDays * pxPerDay;

  const todayOffset = differenceInDays(today, viewStart);
  const todayPx     = todayOffset * pxPerDay;
  const showToday   = todayOffset >= 0 && todayOffset <= totalDays;

  // ── Header cells ──────────────────────────────────────────────────────────
  const headerCells = useMemo(() => {
    type Cell = { label: string; sub?: string; left: number; width: number };
    const cells: Cell[] = [];

    if (viewMode === "day") {
      let cur = new Date(viewStart);
      while (cur <= viewEnd) {
        const left = differenceInDays(cur, viewStart) * pxPerDay;
        cells.push({ label: format(cur, "d"), sub: format(cur, "EEE"), left, width: pxPerDay });
        cur = addDays(cur, 1);
      }
    } else if (viewMode === "week") {
      let cur = new Date(viewStart);
      while (cur <= viewEnd) {
        const weekEnd = addDays(cur, 6);
        const left = Math.max(0, differenceInDays(cur, viewStart)) * pxPerDay;
        cells.push({
          label: format(cur, "MMM d"),
          sub:   `– ${format(weekEnd, "MMM d")}`,
          left,
          width: 7 * pxPerDay,
        });
        cur = addDays(cur, 7);
      }
    } else {
      // month
      let cur = startOfMonth(viewStart);
      while (cur <= viewEnd) {
        const mEnd  = endOfMonth(cur);
        const s     = cur < viewStart ? viewStart : cur;
        const e     = mEnd > viewEnd  ? viewEnd  : mEnd;
        const left  = differenceInDays(s, viewStart) * pxPerDay;
        const width = (differenceInDays(e, s) + 1) * pxPerDay;
        cells.push({ label: format(cur, "MMM yyyy"), left, width });
        cur = addMonths(cur, 1);
      }
    }
    return cells;
  }, [viewMode, viewStart, viewEnd, pxPerDay]);

  // ── Bar geometry ──────────────────────────────────────────────────────────
  function barMetrics(startDate: string | null, endDate: string | null) {
    const s = parseDate(startDate);
    const e = parseDate(endDate ?? startDate);
    if (!s) return null;
    const eff  = e ?? s;
    const left = Math.max(0, differenceInDays(s, viewStart)) * pxPerDay;
    const end  = Math.min(totalWidth, (differenceInDays(eff, viewStart) + 1) * pxPerDay);
    return { left, width: Math.max(end - left, 8) };
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Shared: today line in a row ───────────────────────────────────────────
  const TodayLine = () =>
    showToday ? (
      <div
        className="absolute top-0 bottom-0 w-px bg-red-400/70 z-10 pointer-events-none"
        style={{ left: todayPx }}
      />
    ) : null;

  // ── Bar renderer ──────────────────────────────────────────────────────────
  function Bar({
    item,
    barH = 20,
  }: {
    item: { title: string; status: string; startDate: string | null; endDate: string | null; progress: number; href: string; assigneeName?: string | null; ownerName?: string | null };
    barH?: number;
  }) {
    const metrics = barMetrics(item.startDate, item.endDate);
    if (!metrics) return null;
    const color = STATUS_COLORS[item.status] ?? "bg-slate-400";
    const isDone = item.status === "CANCELLED";
    const top = (ROW_H - barH) / 2;
    const personName = (item as any).assigneeName ?? (item as any).ownerName;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href={item.href} className="block absolute" style={{ left: metrics.left, width: metrics.width, top, height: barH }}>
            <div
              className={cn(
                "w-full h-full rounded-sm overflow-hidden cursor-pointer hover:opacity-90 transition-opacity",
                color,
                isDone && "opacity-40"
              )}
            >
              {item.progress > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-black/25 rounded-l-sm"
                  style={{ width: `${item.progress}%` }}
                />
              )}
              {metrics.width > 48 && (
                <span className="absolute inset-0 flex items-center px-1.5 text-[10px] text-white font-medium truncate pointer-events-none">
                  {item.progress > 0 ? `${item.progress}%` : item.title}
                </span>
              )}
            </div>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[240px] space-y-1 p-2.5">
          <p className="font-semibold text-sm leading-tight">{item.title}</p>
          <p className="text-xs text-muted-foreground capitalize">{item.status.replace(/_/g, " ")}</p>
          {personName && <p className="text-xs">👤 {personName}</p>}
          {item.startDate && (
            <p className="text-xs">📅 Start: {format(new Date(item.startDate), "MMM d, yyyy")}</p>
          )}
          {item.endDate && (
            <p className="text-xs">🏁 End: {format(new Date(item.endDate), "MMM d, yyyy")}</p>
          )}
          {item.progress > 0 && <p className="text-xs">⏱ {item.progress}% complete</p>}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── Left label column ─────────────────────────────────────────────────────
  function GroupLabel({ group }: { group: GanttGroup }) {
    const isCollapsed = collapsed.has(group.id);
    return (
      <div className="flex items-center gap-1 min-w-0 px-2">
        <button
          onClick={() => toggleCollapse(group.id)}
          className="flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        {group.ownerImage !== undefined && (
          <Avatar className="h-5 w-5 flex-shrink-0">
            <AvatarImage src={group.ownerImage ?? undefined} />
            <AvatarFallback className="text-[9px]">{getInitials(group.ownerName)}</AvatarFallback>
          </Avatar>
        )}
        <Link href={group.href} className="font-medium text-xs truncate hover:text-primary transition-colors">
          {group.title}
        </Link>
        {group.progress > 0 && (
          <span className="text-[10px] text-muted-foreground flex-shrink-0">{group.progress}%</span>
        )}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 border rounded-lg p-1 bg-background">
            {(["day", "week", "month"] as ViewMode[]).map((m) => (
              <Button
                key={m}
                variant={viewMode === m ? "default" : "ghost"}
                size="sm"
                className="h-7 px-3 text-xs capitalize"
                onClick={() => setViewMode(m)}
              >
                {m}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {format(viewStart, "MMM d, yyyy")} — {format(viewEnd, "MMM d, yyyy")}
          </span>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {Object.entries({
            PLANNING: "Planning", TODO: "To Do", IN_PROGRESS: "In Progress",
            ON_HOLD: "On Hold", BLOCKED: "Blocked", COMPLETED: "Completed", CANCELLED: "Cancelled",
          }).map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <span className={cn("inline-block h-2.5 w-4 rounded-sm", STATUS_COLORS[key])} />
              {label}
            </span>
          ))}
        </div>

        {/* Chart */}
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table
              style={{ width: LEFT_W + totalWidth, borderCollapse: "separate", borderSpacing: 0 }}
              className="text-sm"
            >
              {/* Header */}
              <thead>
                <tr style={{ height: HEADER_H }}>
                  <th
                    className="sticky left-0 z-20 bg-muted text-left border-b border-r px-3 font-medium text-muted-foreground text-xs"
                    style={{ width: LEFT_W, minWidth: LEFT_W }}
                  >
                    Name
                  </th>
                  <th className="relative border-b p-0 bg-muted" style={{ width: totalWidth }}>
                    <div className="relative" style={{ width: totalWidth, height: HEADER_H }}>
                      {headerCells.map((cell, i) => (
                        <div
                          key={i}
                          className="absolute flex flex-col justify-center border-r px-1.5 overflow-hidden"
                          style={{ left: cell.left, width: cell.width, height: HEADER_H }}
                        >
                          <span className="text-[11px] font-medium truncate">{cell.label}</span>
                          {cell.sub && (
                            <span className="text-[10px] text-muted-foreground">{cell.sub}</span>
                          )}
                        </div>
                      ))}
                      {/* Today in header */}
                      {showToday && (
                        <div
                          className="absolute top-0 h-full pointer-events-none z-10"
                          style={{ left: todayPx }}
                        >
                          <div className="w-0.5 h-full bg-red-500" />
                          <span className="absolute top-1 left-1 text-[9px] text-red-600 font-bold whitespace-nowrap">
                            Today
                          </span>
                        </div>
                      )}
                    </div>
                  </th>
                </tr>
              </thead>

              {/* Body */}
              <tbody>
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="text-center text-muted-foreground py-20 text-sm">
                      No items to display. Add dates to projects and activities to see them here.
                    </td>
                  </tr>
                ) : (
                  groups.map((group) => {
                    const isCollapsed = collapsed.has(group.id);
                    return [
                      // ── Group row ──────────────────────────────────────
                      <tr key={`g-${group.id}`} style={{ height: ROW_H }} className="border-b bg-muted/20">
                        <td
                          className="sticky left-0 z-10 bg-muted/20 border-r"
                          style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                        >
                          <GroupLabel group={group} />
                        </td>
                        <td className="relative p-0" style={{ width: totalWidth, height: ROW_H }}>
                          <div className="absolute inset-0 border-b" />
                          <TodayLine />
                          <Bar
                            item={{
                              title: group.title,
                              status: group.status,
                              startDate: group.startDate,
                              endDate: group.endDate,
                              progress: group.progress,
                              href: group.href,
                              ownerName: group.ownerName,
                            }}
                            barH={22}
                          />
                        </td>
                      </tr>,

                      // ── Child rows ─────────────────────────────────────
                      ...(isCollapsed
                        ? []
                        : group.children.map((child) => (
                            <tr key={`c-${child.id}`} style={{ height: ROW_H }} className="border-b hover:bg-muted/10 transition-colors">
                              <td
                                className="sticky left-0 z-10 bg-background border-r"
                                style={{ width: LEFT_W, minWidth: LEFT_W, height: ROW_H }}
                              >
                                <div className="flex items-center gap-1.5 pl-8 pr-2 min-w-0">
                                  {child.assigneeImage !== undefined && (
                                    <Avatar className="h-4 w-4 flex-shrink-0">
                                      <AvatarImage src={child.assigneeImage ?? undefined} />
                                      <AvatarFallback className="text-[8px]">{getInitials(child.assigneeName)}</AvatarFallback>
                                    </Avatar>
                                  )}
                                  <Link
                                    href={child.href}
                                    className="text-xs truncate hover:text-primary transition-colors"
                                  >
                                    {child.title}
                                  </Link>
                                </div>
                              </td>
                              <td className="relative p-0" style={{ width: totalWidth, height: ROW_H }}>
                                <div className="absolute inset-0 border-b" />
                                <TodayLine />
                                <Bar item={child} barH={16} />
                              </td>
                            </tr>
                          ))),
                    ];
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
