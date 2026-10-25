"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table2, LayoutGrid } from "lucide-react";

interface TicketViewToggleProps {
  /** True when Board view isn't coherent right now (e.g. "All Workspaces" selected — TicketStatus, the board's own column set, is per-department). The Board button is disabled with a Tooltip rather than hidden. */
  boardDisabled?: boolean;
}

/**
 * Table/Board view toggle for the Tickets list — lives in the page HEADER
 * row (next to "New Ticket"), same position ViewToggle (components/ui/
 * view-toggle.tsx) occupies on /projects next to "New Project", not inside
 * the filters card below it. A separate component from ViewToggle (not a
 * reuse) because that one's modes are hardcoded to "grid"/"list" — this
 * page's two views are "table"/"board", with their own icons and a
 * disabled+tooltip state ViewToggle has no concept of.
 */
export function TicketViewToggle({ boardDisabled = false }: TicketViewToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = searchParams.get("view") === "board" ? "board" : "table";

  const setView = (next: "table" | "board") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "table") params.delete("view");
    else params.set("view", "board");
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="inline-flex items-center rounded-md border p-0.5" role="group" aria-label="Ticket view mode">
        <Button
          type="button"
          variant={view === "table" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 px-2.5"
          onClick={() => setView("table")}
          aria-pressed={view === "table"}
        >
          <Table2 className="h-3.5 w-3.5 mr-1.5" />
          Table
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span wrapper so the Tooltip still works while the Button itself is disabled */}
            <span>
              <Button
                type="button"
                variant={view === "board" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2.5"
                disabled={boardDisabled}
                onClick={() => setView("board")}
                aria-pressed={view === "board"}
              >
                <LayoutGrid className="h-3.5 w-3.5 mr-1.5" />
                Board
              </Button>
            </span>
          </TooltipTrigger>
          {boardDisabled && <TooltipContent>Select a single department to use Board view</TooltipContent>}
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
