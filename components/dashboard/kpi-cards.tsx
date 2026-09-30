import { CountStrip } from "@/components/dashboard/count-strip";

export type KpiCardKey = "open" | "unassigned" | "fromEmail" | "closed" | "myRequests";

export interface KpiCard {
  key: KpiCardKey;
  count: number;
  /**
   * Built server-side (app/(main)/dashboard/page.tsx) from the SAME scope
   * and conditions as `count`, so clicking a card always lands on a list
   * holding exactly that many tickets — including the active workspace's
   * departmentId, which All Tickets otherwise ignores.
   */
  href: string;
}

const META: Record<KpiCardKey, { label: string; sub: string; attention?: boolean }> = {
  open: { label: "Not Closed", sub: "Any status that isn't closed" },
  unassigned: { label: "Unassigned", sub: "Open, nobody assigned", attention: true },
  fromEmail: { label: "From Email", sub: "Open, created from email" },
  closed: { label: "Closed", sub: "Resolved, closed or cancelled" },
  myRequests: { label: "My Requests", sub: "Every ticket you've opened" },
};

export function KpiCards({ cards }: { cards: KpiCard[] }) {
  return <CountStrip items={cards.map((c) => ({ ...META[c.key], key: c.key, count: c.count, href: c.href }))} />;
}
