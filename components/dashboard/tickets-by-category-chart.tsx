import { BreakdownList } from "@/components/dashboard/breakdown-list";

export interface CategoryDataPoint {
  name: string;
  count: number;
  color: string;
}

export function TicketsByCategoryChart({ data }: { data: CategoryDataPoint[] }) {
  return (
    <BreakdownList
      title="Tickets by Category"
      emptyLabel="No categorised tickets yet"
      rows={[...data].sort((a, b) => b.count - a.count).map((d) => ({ label: d.name, count: d.count, color: d.color, mark: "swatch" }))}
    />
  );
}
