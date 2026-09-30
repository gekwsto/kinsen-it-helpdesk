import { BreakdownList } from "@/components/dashboard/breakdown-list";

export interface PieDataPoint {
  name: string;
  value: number;
  color: string;
}

/** Projects Dashboard breakdown — the same ruled BreakdownList the Ticket Dashboard uses. */
export function DashboardPieCard({ title, data, emptyLabel }: { title: string; data: PieDataPoint[]; emptyLabel: string }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <BreakdownList
      title={title}
      totalLabel={`${total} total`}
      emptyLabel={emptyLabel}
      rows={data.map((d) => ({ label: d.name, count: d.value, color: d.color, mark: "swatch" }))}
    />
  );
}
