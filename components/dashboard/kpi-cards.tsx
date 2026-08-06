import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Ticket,
  Clock,
  CheckCircle2,
  Mail,
  LayoutList,
} from "lucide-react";

interface KpiCardsProps {
  total: number;
  open: number;
  inProgress: number;
  closed: number;
  emailCreated: number;
}

// Each href's `status`/`source` value is the exact query contract the All
// Tickets list (app/(main)/tickets/page.tsx) and the shared
// lib/services/ticket-status-groups.ts helper both consume — the same
// function that produced this card's own count also resolves what the
// destination list shows, so the two can never disagree.
const CARDS = [
  {
    key: "total" as const,
    title: "Total Tickets",
    icon: LayoutList,
    iconClass: "text-slate-600",
    bgClass: "bg-slate-100",
    sub: "All time",
    href: "/tickets?status=all",
    ariaLabel: "View all tickets",
  },
  {
    key: "open" as const,
    title: "Open",
    icon: Ticket,
    iconClass: "text-blue-600",
    bgClass: "bg-blue-50",
    sub: "Not yet closed",
    href: "/tickets?status=open",
    ariaLabel: "View open tickets",
  },
  {
    key: "inProgress" as const,
    title: "In Progress",
    icon: Clock,
    iconClass: "text-amber-600",
    bgClass: "bg-amber-50",
    sub: "Being worked on",
    href: "/tickets?status=in_progress",
    ariaLabel: "View in-progress tickets",
  },
  {
    key: "closed" as const,
    title: "Closed",
    icon: CheckCircle2,
    iconClass: "text-emerald-600",
    bgClass: "bg-emerald-50",
    sub: "Resolved & closed",
    href: "/tickets?status=closed",
    ariaLabel: "View closed tickets",
  },
  {
    key: "emailCreated" as const,
    title: "From Email",
    icon: Mail,
    iconClass: "text-violet-600",
    bgClass: "bg-violet-50",
    sub: "Email-created",
    href: "/tickets?source=EMAIL",
    ariaLabel: "View tickets created from email",
  },
];

export function KpiCards(props: KpiCardsProps) {
  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {CARDS.map((card) => (
        <Link
          key={card.key}
          href={card.href}
          aria-label={card.ariaLabel}
          className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Card className="h-full transition-all hover:-translate-y-0.5 hover:shadow-md hover:border-primary/40 cursor-pointer">
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
        </Link>
      ))}
    </div>
  );
}
