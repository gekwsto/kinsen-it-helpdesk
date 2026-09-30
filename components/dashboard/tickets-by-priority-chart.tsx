import { BreakdownList } from "@/components/dashboard/breakdown-list";

export interface PriorityDataPoint {
  name: string;
  value: number;
  color: string;
  level?: number;
}

/**
 * Open tickets by priority. Includes a "No priority" row, so the rows always
 * add up to the dashboard's "Not closed" count.
 */
export function TicketsByPriorityChart({ data, unprioritised = 0 }: { data: PriorityDataPoint[]; unprioritised?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0) + unprioritised;
  return (
    <BreakdownList
      title="Not Closed, by Priority"
      totalLabel={`${total} not closed`}
      emptyLabel="Nothing open right now"
      rows={[
        ...data.map((d) => ({ label: d.name, count: d.value, color: d.color, rank: d.level, mark: "priority" as const })),
        ...(unprioritised > 0 ? [{ label: "No priority", count: unprioritised, color: "", mark: "none" as const }] : []),
      ]}
    />
  );
}
