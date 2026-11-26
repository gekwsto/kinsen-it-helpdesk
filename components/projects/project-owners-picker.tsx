"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OwnerCandidate {
  id: string;
  name: string | null;
  email: string;
}

/**
 * The Owner(s) selector for Request-origin Projects — shared by Project
 * setup from an approved Request (components/projects/project-form.tsx,
 * "fromRequest" mode) and the Project edit page. Eligibility is the same in
 * both places and is enforced server-side (resolveSystemWideActiveUserIds):
 * any active user in the system, at least one.
 */
export function ProjectOwnersPicker({
  users,
  selected,
  onToggle,
}: {
  /** System-wide active users (GET /api/users). */
  users: OwnerCandidate[];
  selected: Set<string>;
  onToggle: (userId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users, search]);

  return (
    <div className="space-y-2">
      <Label htmlFor="project-owners">
        Owner(s) <span className="text-destructive">*</span>
      </Label>
      <p id="project-owners-helper" className="text-xs text-muted-foreground">
        Any active user in the system — not limited to this department. At least one is required.
      </p>
      <Input placeholder="Search by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 text-sm" />
      {users.length > 0 ? (
        <div id="project-owners" role="group" aria-describedby="project-owners-helper" className="border rounded-md divide-y max-h-48 overflow-y-auto">
          {results.map((u) => (
            <label key={u.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer">
              <input type="checkbox" className="h-4 w-4 rounded" checked={selected.has(u.id)} onChange={() => onToggle(u.id)} />
              <span className="text-sm">{u.name ?? u.email}</span>
            </label>
          ))}
          {results.length === 0 && <p className="text-xs text-muted-foreground px-3 py-2">No users match &quot;{search}&quot;.</p>}
        </div>
      ) : (
        <p className="text-xs text-destructive border rounded-md px-3 py-2">No active users exist. Contact an administrator.</p>
      )}
    </div>
  );
}
