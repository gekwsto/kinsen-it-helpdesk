import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Ticket, Clock, CheckCircle2, XCircle, UserCheck } from "lucide-react";

interface StatsCardsProps {
  stats: {
    totalOpen: number;
    totalInProgress: number;
    totalResolved: number;
    totalClosed: number;
    assignedToMe: number;
  };
}

export function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      title: "Open Tickets",
      value: stats.totalOpen,
      icon: Ticket,
      iconClass: "text-blue-600",
      bgClass: "bg-blue-50",
      change: "Needs attention",
    },
    {
      title: "In Progress",
      value: stats.totalInProgress,
      icon: Clock,
      iconClass: "text-amber-600",
      bgClass: "bg-amber-50",
      change: "Being worked on",
    },
    {
      title: "Resolved",
      value: stats.totalResolved,
      icon: CheckCircle2,
      iconClass: "text-green-600",
      bgClass: "bg-green-50",
      change: "Awaiting confirmation",
    },
    {
      title: "Assigned to Me",
      value: stats.assignedToMe,
      icon: UserCheck,
      iconClass: "text-purple-600",
      bgClass: "bg-purple-50",
      change: "My workload",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {card.title}
            </CardTitle>
            <div className={`rounded-lg p-2 ${card.bgClass}`}>
              <card.icon className={`h-4 w-4 ${card.iconClass}`} />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground mt-1">{card.change}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
