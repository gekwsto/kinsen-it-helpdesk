import { BreakdownList } from "@/components/dashboard/breakdown-list";

export interface BarDataPoint {
  name: string;
  count: number;
  color: string;
}

/** Projects Dashboard "by owner" breakdown — ruled BreakdownList rows, largest first. */
export function DashboardBarCard({ title, data, emptyLabel }: { title: string; data: BarDataPoint[]; emptyLabel: string; tooltipLabel?: string }) {
  return (
    <BreakdownList
      title={title}
      emptyLabel={emptyLabel}
      rows={[...data].sort((a, b) => b.count - a.count).map((d) => ({ label: d.name, count: d.count, color: d.color, mark: "none" }))}
    />
  );
}
