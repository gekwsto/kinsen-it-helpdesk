"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Ticket, FolderKanban } from "lucide-react";

export type DashboardTab = "tickets" | "projects";

interface DashboardTabsProps {
  active: DashboardTab;
}

/**
 * Segmented control swapping the SAME Dashboard page between the Ticket
 * Dashboard and Projects Dashboard (Part 3) — no new route. Query-param
 * driven (`?tab=`), same convention as ViewToggle (components/ui/view-toggle.tsx):
 * a click is a router.push causing the Server Component page to re-fetch
 * and render only the selected dashboard's data (never both at once), so
 * browser refresh/back/forward all land on the exact same tab predictably.
 * "tickets" is the default and is omitted from the URL entirely, matching
 * ViewToggle's own "keep URLs clean" rule — so today's bare /dashboard
 * link (bookmarks, nav sidebar) keeps behaving exactly as before.
 */
export function DashboardTabs({ active }: DashboardTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setTab = (tab: DashboardTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "tickets") params.delete("tab");
    else params.set("tab", tab);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-1" role="group" aria-label="Dashboard">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={
          active === "tickets"
            ? "h-8 px-3 gap-1.5 bg-background shadow-sm hover:bg-background"
            : "h-8 px-3 gap-1.5 text-muted-foreground hover:text-foreground hover:bg-transparent"
        }
        onClick={() => setTab("tickets")}
        aria-pressed={active === "tickets"}
      >
        <Ticket className="h-3.5 w-3.5" />
        Tickets
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={
          active === "projects"
            ? "h-8 px-3 gap-1.5 bg-background shadow-sm hover:bg-background"
            : "h-8 px-3 gap-1.5 text-muted-foreground hover:text-foreground hover:bg-transparent"
        }
        onClick={() => setTab("projects")}
        aria-pressed={active === "projects"}
      >
        <FolderKanban className="h-3.5 w-3.5" />
        Projects
      </Button>
    </div>
  );
}
