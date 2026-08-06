"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BusinessUnitOption {
  id: string;
  name: string;
  company: { id: string; name: string };
}

interface BusinessUnitComboboxProps {
  businessUnits: BusinessUnitOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/**
 * Searchable Business Unit picker — the option list is server-fetched and
 * passed in as a prop (same convention as the Department/Owner Selects in
 * components/projects/project-filters.tsx), so there's no client loading
 * phase of its own. A lightweight custom dropdown rather than the
 * Radix Select used elsewhere: Radix Select only supports jump-to-letter
 * typeahead, not real substring search, and this app has no combobox/command
 * primitive yet — this is a narrowly-scoped, self-contained addition, not a
 * new app-wide pattern. Always shows "Name — Company" (never just the name)
 * so two identically-named Business Units under different Companies are
 * never ambiguous.
 */
export function BusinessUnitCombobox({ businessUnits, value, onChange, disabled }: BusinessUnitComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selected = businessUnits.find((bu) => bu.id === value) ?? null;
  const filtered = query.trim()
    ? businessUnits.filter((bu) => `${bu.name} ${bu.company.name}`.toLowerCase().includes(query.trim().toLowerCase()))
    : businessUnits;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={cn("truncate text-left", !selected && "text-muted-foreground")}>
          {selected ? (
            <>
              {selected.name} <span className="text-muted-foreground">— {selected.company.name}</span>
            </>
          ) : (
            "Select a business unit"
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 opacity-50 flex-shrink-0 ml-2" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <div className="flex items-center border-b px-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground mr-2 flex-shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search business units…"
              className="flex h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {businessUnits.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                No business units available. Create one under Administration → Business Units first.
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">No business units match your search.</p>
            ) : (
              filtered.map((bu) => (
                <button
                  key={bu.id}
                  type="button"
                  onClick={() => {
                    onChange(bu.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground",
                    bu.id === value && "bg-accent/50"
                  )}
                >
                  <span className="truncate">
                    {bu.name} <span className="text-muted-foreground">— {bu.company.name}</span>
                  </span>
                  {bu.id === value && <Check className="h-3.5 w-3.5 flex-shrink-0 ml-2" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
