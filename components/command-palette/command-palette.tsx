"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useCommandPalette } from "@/components/command-palette/command-palette-provider";
import { Plus, FileText, FolderKanban, Loader2, Ticket as TicketIcon } from "lucide-react";
import type { NavVisibilityFlags } from "@/lib/services/department-scope-service";

interface SearchTicket {
  id: string;
  ticketNumber: number;
  title: string;
  status: { name: string; color: string };
  department: { name: string } | null;
}
interface SearchProject {
  id: string;
  title: string;
  department: { name: string } | null;
}

const DEBOUNCE_MS = 275;
const MIN_QUERY_LENGTH = 2;

interface CommandPaletteProps {
  /** Soft UX polish only (hides an obviously-irrelevant Quick Action) — never the real enforcement boundary; the destination page's own server-side check is, same as everywhere else in this app. */
  navFlags?: NavVisibilityFlags;
}

export function CommandPalette({ navFlags }: CommandPaletteProps) {
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [tickets, setTickets] = useState<SearchTicket[]>([]);
  const [projects, setProjects] = useState<SearchProject[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestTokenRef = useRef(0);

  // Global ⌘K / Ctrl+K — mirrors the one existing local-listener precedent
  // in this codebase (components/projects/workspace-combobox.tsx). Radix
  // Dialog (inside CommandDialog) already handles Escape-to-close and the
  // focus trap once open, so this only needs to handle opening.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTickets([]);
    setProjects([]);
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setTickets([]);
      setProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myToken = ++requestTokenRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/command-palette/search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) throw new Error("search failed");
        const data = await res.json();
        if (requestTokenRef.current !== myToken) return; // a newer query superseded this one
        setTickets(data.tickets ?? []);
        setProjects(data.projects ?? []);
      } catch {
        if (requestTokenRef.current === myToken) {
          setTickets([]);
          setProjects([]);
        }
      } finally {
        if (requestTokenRef.current === myToken) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const showResults = query.trim().length >= MIN_QUERY_LENGTH;
  const hasAnyResults = tickets.length > 0 || projects.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search tickets and projects, or jump to a quick action"
    >
      <CommandInput placeholder="Search tickets, projects…" value={query} onValueChange={setQuery} />
      <CommandList>
        {(navFlags?.canCreateTickets ?? true) && (
          <CommandGroup heading="Quick actions">
            <CommandItem value="quick-action-new-ticket" onSelect={() => go("/tickets/new")}>
              <Plus className="text-muted-foreground" />
              New Ticket
            </CommandItem>
          </CommandGroup>
        )}
        {(navFlags?.canCreateProjects ?? true) && (
          <CommandGroup heading={navFlags?.canCreateTickets === false ? "Quick actions" : undefined}>
            <CommandItem value="quick-action-new-project" onSelect={() => go("/projects/new")}>
              <Plus className="text-muted-foreground" />
              New Project
            </CommandItem>
            <CommandItem value="quick-action-new-project-request" onSelect={() => go("/project-requests/new")}>
              <Plus className="text-muted-foreground" />
              New Project Request
            </CommandItem>
          </CommandGroup>
        )}

        {showResults && loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Searching…
          </div>
        )}

        {/* A plain div, not cmdk's own CommandEmpty primitive — Quick
            Actions are always mounted as real CommandItems in this same
            Command root, so cmdk's own "list has zero items" visibility
            check (which CommandEmpty relies on) never true, even when the
            Tickets/Projects search itself came back empty. This message is
            about THAT search specifically, not the whole list. */}
        {showResults && !loading && !hasAnyResults && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No tickets or projects match &ldquo;{query.trim()}&rdquo;.
          </div>
        )}

        {showResults && !loading && tickets.length > 0 && (
          <CommandGroup heading="Tickets">
            {tickets.map((t) => (
              <CommandItem key={t.id} value={`ticket-${t.id}`} onSelect={() => go(`/tickets/${t.id}`)}>
                <TicketIcon className="text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{t.title}</div>
                  <div className="text-xs text-muted-foreground">
                    #{t.ticketNumber}
                    {t.department ? ` · ${t.department.name}` : ""} · {t.status.name}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {showResults && !loading && projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((p) => (
              <CommandItem key={p.id} value={`project-${p.id}`} onSelect={() => go(`/projects/${p.id}`)}>
                <FolderKanban className="text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{p.title}</div>
                  {p.department && <div className="text-xs text-muted-foreground">{p.department.name}</div>}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
