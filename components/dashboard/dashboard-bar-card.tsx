"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface BarDataPoint {
  name: string;
  count: number;
  color: string;
}

interface Props {
  title: string;
  data: BarDataPoint[];
  emptyLabel: string;
  tooltipLabel: string;
}

/** Generic version of the Ticket Dashboard's by-category horizontal bar card (components/dashboard/tickets-by-category-chart.tsx) — same visual shape, reused (not duplicated per-chart) for the Projects Dashboard's "by owner" breakdown. */
export function DashboardBarCard({ title, data, emptyLabel, tooltipLabel }: Props) {
  const nonEmpty = data.filter((d) => d.count > 0);
  const chartHeight = Math.max(160, nonEmpty.length * 40 + 32);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {nonEmpty.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <div style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={nonEmpty}
                margin={{ top: 4, right: 24, bottom: 4, left: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal={false}
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={100}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  formatter={(value) => [value, tooltipLabel]}
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--background))",
                  }}
                  cursor={{ fill: "hsl(var(--muted))" }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  {nonEmpty.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
