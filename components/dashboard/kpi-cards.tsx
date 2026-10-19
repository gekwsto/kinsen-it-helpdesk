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

// Each href's `status`/`source` value is a legacy/deep-link-only contract
// app/(main)/tickets/page.tsx still recognizes (see its SearchParams doc
// comment) — only "all" (lifts the default non-closed scope) still changes
// behavior there; "Open" and "Closed" instead point at their own dedicated
// canonical pages (app/(main)/tickets/open/page.tsx and
// app/(main)/tickets/closed/page.tsx), same precedent. This card's own
// COUNT still comes from the same lib/services/ticket-status-groups.ts
// helper the Dashboard always used, unaffected by the All Tickets list no
// longer offering a matching manual dropdown for every group.
const CARDS = [
  {
    key: "total" as const,
    title: "Total Tickets",
    icon: LayoutList,
    iconClass: "text-slate-600 dark:text-slate-400",
    bgClass: "bg-slate-100 dark:bg-slate-800/60",
    accentClass: "bg-slate-400 dark:bg-slate-500",
    sub: "All time",
    href: "/tickets?status=all",
    ariaLabel: "View all tickets",
  },
  {
    key: "open" as const,
    title: "Open",
    icon: Ticket,
    iconClass: "text-blue-600 dark:text-blue-400",
    bgClass: "bg-blue-50 dark:bg-blue-900/20",
    accentClass: "bg-blue-500",
    sub: "Not yet closed",
    href: "/tickets/open",
    ariaLabel: "View open tickets",
  },
  {
    key: "inProgress" as const,
    title: "In Progress",
    icon: Clock,
    iconClass: "text-amber-600 dark:text-amber-400",
    bgClass: "bg-amber-50 dark:bg-amber-900/20",
    accentClass: "bg-amber-500",
    sub: "Being worked on",
    href: "/tickets?status=in_progress",
    ariaLabel: "View in-progress tickets",
  },
  {
    key: "closed" as const,
    title: "Closed",
    icon: CheckCircle2,
    iconClass: "text-emerald-600 dark:text-emerald-400",
    bgClass: "bg-emerald-50 dark:bg-emerald-900/20",
    accentClass: "bg-emerald-500",
    sub: "Resolved & closed",
    href: "/tickets/closed",
    ariaLabel: "View closed tickets",
  },
  {
    key: "emailCreated" as const,
    title: "From Email",
    icon: Mail,
    iconClass: "text-violet-600 dark:text-violet-400",
    bgClass: "bg-violet-50 dark:bg-violet-900/20",
    accentClass: "bg-violet-500",
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
          className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Card className="relative h-full overflow-hidden rounded-xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-primary/40 cursor-pointer">
            <div className={`absolute inset-x-0 top-0 h-1 ${card.accentClass}`} />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div className={`rounded-xl p-2 ${card.bgClass}`}>
                <card.icon className={`h-4 w-4 ${card.iconClass}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{props[card.key]}</div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{card.sub}</p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
