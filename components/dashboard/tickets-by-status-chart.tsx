import { BreakdownList } from "@/components/dashboard/breakdown-list";

export interface StatusDataPoint {
  name: string;
  value: number;
  color: string;
  closed?: boolean;
}

export function TicketsByStatusChart({ data }: { data: StatusDataPoint[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <BreakdownList
      title="Tickets by Status"
      totalLabel={`${total} total`}
      emptyLabel="No tickets yet"
      rows={data.map((d) => ({ label: d.name, count: d.value, color: d.color, closed: d.closed, mark: "status" }))}
    />
  );
}
