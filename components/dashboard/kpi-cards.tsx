import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Ticket,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Mail,
  LayoutList,
} from "lucide-react";

interface KpiCardsProps {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  overdue: number;
  emailCreated: number;
}

const CARDS = [
  {
    key: "total" as const,
    title: "Total Tickets",
    icon: LayoutList,
    iconClass: "text-slate-600",
    bgClass: "bg-slate-100",
    sub: "All time",
  },
  {
    key: "open" as const,
    title: "Open",
    icon: Ticket,
    iconClass: "text-blue-600",
    bgClass: "bg-blue-50",
    sub: "Not yet closed",
  },
  {
    key: "inProgress" as const,
    title: "In Progress",
    icon: Clock,
    iconClass: "text-amber-600",
    bgClass: "bg-amber-50",
    sub: "Being worked on",
  },
  {
    key: "closed" as const,
    title: "Closed",
    icon: CheckCircle2,
    iconClass: "text-emerald-600",
    bgClass: "bg-emerald-50",
    sub: "Resolved & closed",
  },
  {
    key: "overdue" as const,
    title: "Overdue",
    icon: AlertTriangle,
    iconClass: "text-red-600",
    bgClass: "bg-red-50",
    sub: "Open > 7 days",
  },
  {
    key: "emailCreated" as const,
    title: "From Email",
    icon: Mail,
    iconClass: "text-violet-600",
    bgClass: "bg-violet-50",
    sub: "Email-created",
  },
];

export function KpiCards(props: KpiCardsProps) {
  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((card) => (
        <Card key={card.key}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {card.title}
            </CardTitle>
            <div className={`rounded-lg p-1.5 ${card.bgClass}`}>
              <card.icon className={`h-3.5 w-3.5 ${card.iconClass}`} />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{props[card.key]}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{card.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
