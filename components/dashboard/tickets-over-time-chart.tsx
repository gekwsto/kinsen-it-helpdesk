"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface TimelinePoint {
  date: string;   // ISO date string "YYYY-MM-DD"
  count: number;
}

interface Props {
  data: TimelinePoint[];
  days: number;
}

function shortDate(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

export function TicketsOverTimeChart({ data, days }: Props) {
  const hasAny = data.some((d) => d.count > 0);
  // Show tick every ~7 days
  const tickEvery = Math.ceil(days / 5);
  const ticks = data
    .filter((_, i) => i % tickEvery === 0)
    .map((d) => d.date);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Tickets Created — Last {days} Days</CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {!hasAny ? (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No tickets in this period
          </div>
        ) : (
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="date"
                  ticks={ticks}
                  tickFormatter={shortDate}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  labelFormatter={(label) => shortDate(String(label))}
                  formatter={(value) => [value, "Tickets"]}
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: 8,
                    border: "1px solid hsl(var(--border))",
                    background: "hsl(var(--background))",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
