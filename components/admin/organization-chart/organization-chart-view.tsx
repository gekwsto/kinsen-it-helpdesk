"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow, type Node, type Edge } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { RefreshCw, Search, Maximize2, AlertTriangle, Inbox, ArrowLeft } from "lucide-react";
import { computeTreeLayout, toLayoutPositionMap, type LayoutTreeNode } from "@/lib/organization-chart-layout";
import { DepartmentNode, type DepartmentNodeData } from "@/components/admin/organization-chart/department-node";
import { PeopleNode, type PeopleNodeData } from "@/components/admin/organization-chart/people-node";

// ─── Shared tree node shape (structurally matches both DTOs from
// lib/services/organization-tree-service.ts) ────────────────────────────────
interface RawTreeNode {
  id: string;
  children: RawTreeNode[];
  [key: string]: unknown;
}

type Mode = "departments" | "people" | "sqlgeneral";

interface UnresolvedSqlGeneralUser {
  userId: string;
  reason: "not_found" | "ambiguous" | "conflicting_attempt";
}
interface UnresolvedSqlGeneralManagerLink {
  sqlGeneralUsername: string;
  reason: "self_reference" | "missing_manager" | "ambiguous_manager" | "cycle";
}

interface SearchResult {
  type: "user" | "department";
  id: string;
  label: string;
  sublabel: string | null;
}

interface SyncStatusResponse {
  latestRun: { id: string; status: string; startedAt: string; completedAt: string | null; usersScanned: number; usersUpdated: number; errorCount: number } | null;
  running: boolean;
}

const nodeTypes = { department: DepartmentNode, person: PeopleNode };

function flattenIds(nodes: RawTreeNode[]): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    ids.push(n.id, ...flattenIds(n.children));
  }
  return ids;
}

/** Every node in the forest, flattened — used by the SQLGeneral manager directory/employee search, which both filter client-side over the already-fetched data rather than a server round-trip. */
function flattenAll(nodes: RawTreeNode[]): RawTreeNode[] {
  const out: RawTreeNode[] = [];
  for (const n of nodes) {
    out.push(n, ...flattenAll(n.children));
  }
  return out;
}

/** Total descendant count (not just direct children) for every node in the forest — the manager directory's "team size". */
function computeSubtreeSizes(nodes: RawTreeNode[]): Map<string, number> {
  const sizes = new Map<string, number>();
  function size(n: RawTreeNode): number {
    let total = n.children.length;
    for (const c of n.children) total += size(c);
    sizes.set(n.id, total);
    return total;
  }
  for (const root of nodes) size(root);
  return sizes;
}

function sqlGeneralLabel(n: RawTreeNode): string {
  return (n.name as string | null) ?? (n.sqlGeneralUsername as string);
}

/** Root -> target id path, or null if target isn't in this tree. */
function findPath(nodes: RawTreeNode[], targetId: string, path: string[] = []): string[] | null {
  for (const n of nodes) {
    const nextPath = [...path, n.id];
    if (n.id === targetId) return nextPath;
    const found = findPath(n.children, targetId, nextPath);
    if (found) return found;
  }
  return null;
}

/** Clones the tree, replacing a collapsed node's children with []. Nodes deeper than 2 levels are collapsed by default (handled by the caller seeding `collapsedIds`), not here. */
function pruneCollapsed(nodes: RawTreeNode[], collapsedIds: Set<string>): RawTreeNode[] {
  return nodes.map((n) => ({
    ...n,
    children: collapsedIds.has(n.id) ? [] : pruneCollapsed(n.children, collapsedIds),
  }));
}

function seedDefaultCollapsed(nodes: RawTreeNode[], depth: number, maxAutoExpandDepth: number, into: Set<string>) {
  for (const n of nodes) {
    if (depth >= maxAutoExpandDepth && n.children.length > 0) {
      into.add(n.id);
    } else {
      seedDefaultCollapsed(n.children, depth + 1, maxAutoExpandDepth, into);
    }
  }
}

function ChartCanvas({
  mode,
  data,
  fullAccess,
  selectedId,
  setSelectedId,
  highlightedIds,
}: {
  mode: Mode;
  data: RawTreeNode[];
  fullAccess: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  highlightedIds: Set<string>;
}) {
  const { fitView } = useReactFlow();
  // SQLGeneral trees can run to hundreds of Departments, so they start
  // collapsed one level shallower than the existing Departments/People
  // modes to keep the initial render usable (DO #3).
  const maxAutoExpandDepth = mode === "sqlgeneral" ? 1 : 2;

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    seedDefaultCollapsed(data, 0, maxAutoExpandDepth, s);
    return s;
  });

  // Re-seed default collapse state whenever the underlying data set changes
  // (mode switch, filter toggle, fresh fetch) — never carries stale
  // collapsed ids from a previous, structurally different tree.
  const dataSignature = useMemo(() => JSON.stringify(flattenIds(data)), [data]);
  useEffect(() => {
    const s = new Set<string>();
    seedDefaultCollapsed(data, 0, maxAutoExpandDepth, s);
    // Always keep the path to a selected node expanded.
    if (selectedId) {
      const path = findPath(data, selectedId);
      if (path) for (const id of path) s.delete(id);
    }
    setCollapsedIds(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSignature]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const path = findPath(data, selectedId);
    if (!path) return;
    setCollapsedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of path) {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedId, data]);

  const { nodes, edges } = useMemo(() => {
    const visibleTree = pruneCollapsed(data, collapsedIds);
    const layoutInput: LayoutTreeNode[] = visibleTree.map(function toLayoutNode(n: RawTreeNode): LayoutTreeNode {
      return { id: n.id, children: n.children.map(toLayoutNode) };
    });
    const positions = toLayoutPositionMap(computeTreeLayout(layoutInput));

    const rfNodes: Node[] = [];
    const rfEdges: Edge[] = [];

    function walk(n: RawTreeNode, originalChildCount: number) {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      const isCollapsed = collapsedIds.has(n.id);
      const hasHiddenChildren = originalChildCount > 0;

      if (mode === "departments") {
        const data0: DepartmentNodeData = {
          label: n.name as string,
          isActive: n.isActive as boolean,
          managerName: (n.manager as { displayName: string | null } | null)?.displayName ?? null,
          managerJobTitle: (n.manager as { jobTitle: string | null } | null)?.jobTitle ?? null,
          activeUserCount: n.activeUserCount as number,
          childCount: originalChildCount,
          hasHiddenChildren,
          isCollapsed,
          isHighlighted: highlightedIds.has(n.id),
          isSelected: n.id === selectedId,
          onToggleCollapse: toggleCollapse,
          onSelect: setSelectedId,
        };
        rfNodes.push({ id: n.id, type: "department", position: { x: pos.x, y: pos.y }, data: data0 as unknown as Record<string, unknown> });
      } else if (mode === "people") {
        const data0: PeopleNodeData = {
          label: (n.displayName as string | null) ?? "(no name)",
          jobTitle: n.jobTitle as string | null,
          departmentName: (n.department as { name: string } | null)?.name ?? null,
          email: n.email as string,
          isActive: n.isActive as boolean,
          directReportsCount: n.directReportsCount as number,
          hasHiddenChildren,
          isCollapsed,
          isHighlighted: highlightedIds.has(n.id),
          isSelected: n.id === selectedId,
          onToggleCollapse: toggleCollapse,
          onSelect: setSelectedId,
        };
        rfNodes.push({ id: n.id, type: "person", position: { x: pos.x, y: pos.y }, data: data0 as unknown as Record<string, unknown> });
      } else {
        // mode === "sqlgeneral" — manager-first: ONE node kind only
        // ("sqlgeneral-person"), reusing PeopleNode as-is. Company/
        // Department are metadata shown on hover (REQUIRED #5), never a
        // separate node kind or grouping layer.
        const isLocal = n.isLocal as boolean;
        const data0: PeopleNodeData = {
          label: (n.name as string | null) ?? (n.sqlGeneralUsername as string),
          jobTitle: n.jobTitle as string | null,
          departmentName: (n.department as string | null) ?? null,
          companyName: (n.company as string | null) ?? null,
          email: (n.email as string | null) ?? "",
          isActive: (n.isActive as boolean | null) ?? true,
          isExternal: !isLocal,
          directReportsCount: originalChildCount,
          hasHiddenChildren,
          isCollapsed,
          isHighlighted: highlightedIds.has(n.id),
          isSelected: n.id === selectedId,
          onToggleCollapse: toggleCollapse,
          onSelect: setSelectedId,
        };
        rfNodes.push({ id: n.id, type: "person", position: { x: pos.x, y: pos.y }, data: data0 as unknown as Record<string, unknown> });
      }

      for (const child of n.children) {
        rfEdges.push({
          id: `${n.id}->${child.id}`,
          source: n.id,
          target: child.id,
          style: highlightedIds.has(n.id) && highlightedIds.has(child.id) ? { stroke: "hsl(var(--primary))", strokeWidth: 2 } : undefined,
        });
        walk(child, child.children.length);
      }
    }

    // originalChildCount for a root must come from the UNPRUNED data, so a
    // collapsed root still shows its real child count on the badge.
    function findOriginal(id: string, list: RawTreeNode[]): RawTreeNode | undefined {
      for (const n of list) {
        if (n.id === id) return n;
        const found = findOriginal(id, n.children);
        if (found) return found;
      }
    }
    for (const root of visibleTree) {
      const original = findOriginal(root.id, data);
      walk(root, original?.children.length ?? root.children.length);
    }

    return { nodes: rfNodes, edges: rfEdges };
  }, [data, collapsedIds, mode, highlightedIds, selectedId, toggleCollapse, setSelectedId]);

  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 50);
    return () => clearTimeout(t);
  }, [dataSignature, mode, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      aria-label={mode === "departments" ? "Department organization chart" : mode === "people" ? "People reporting-line chart" : "SQLGeneral manager subtree chart"}
    >
      <Background />
      <Controls showInteractive={false} />
      {fullAccess && <MiniMap pannable zoomable className="!bg-card" />}
    </ReactFlow>
  );
}

/**
 * SQLGeneral mode's own navigation shell — fixes the root cause of the
 * unreadable initial view: ReactFlow (and its `fitView`) was being handed
 * the ENTIRE forest (every top-level root, including every standalone
 * root created by an unresolved manager link) at once, so `fitView` had no
 * choice but to zoom out until cards became microscopic. This component
 * NEVER passes the whole forest into ChartCanvas — only ONE manager's
 * subtree at a time (`focusRoot`), so ReactFlow (and fitView) only ever
 * sees a bounded, readable slice. The full forest (`data`) is still kept
 * entirely client-side for the directory/search below, which filter it
 * in-memory — no extra network round-trip.
 */
function SqlGeneralManagerExplorer({
  data,
  fullAccess,
  selectedId,
  setSelectedId,
  highlightedIds,
}: {
  data: RawTreeNode[];
  fullAccess: boolean;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  highlightedIds: Set<string>;
}) {
  const [focusRootId, setFocusRootId] = useState<string | null>(null);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [employeeQuery, setEmployeeQuery] = useState("");

  const flat = useMemo(() => flattenAll(data), [data]);
  const subtreeSizeById = useMemo(() => computeSubtreeSizes(data), [data]);

  const directoryEntries = useMemo(() => {
    return flat
      .filter((n) => (subtreeSizeById.get(n.id) ?? 0) > 0)
      .map((n) => ({ id: n.id, label: sqlGeneralLabel(n), size: subtreeSizeById.get(n.id) ?? 0 }))
      .sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
  }, [flat, subtreeSizeById]);

  const filteredDirectory = useMemo(() => {
    const q = directoryQuery.trim().toLowerCase();
    if (!q) return directoryEntries;
    return directoryEntries.filter((e) => e.label.toLowerCase().includes(q));
  }, [directoryEntries, directoryQuery]);

  const employeeResults = useMemo(() => {
    const q = employeeQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return flat
      .filter((n) => {
        const label = sqlGeneralLabel(n).toLowerCase();
        const email = ((n.email as string | null) ?? "").toLowerCase();
        const username = (n.sqlGeneralUsername as string).toLowerCase();
        return label.includes(q) || email.includes(q) || username.includes(q);
      })
      .slice(0, 25);
  }, [flat, employeeQuery]);

  const focusRoot = useMemo(() => {
    if (!focusRootId) return null;
    function find(nodes: RawTreeNode[]): RawTreeNode | null {
      for (const n of nodes) {
        if (n.id === focusRootId) return n;
        const found = find(n.children);
        if (found) return found;
      }
      return null;
    }
    return find(data);
  }, [data, focusRootId]);

  // Still a valid focus even if the employee is at the very top — findPath
  // returns a root-to-target path, so path[0] is always that employee's
  // ultimate top-level manager (REQUIRED #3: "locate the correct
  // management tree"); setSelectedId reuses the SAME highlight/expand-path
  // machinery ChartCanvas already has for the Departments/People modes.
  function focusOnEmployee(employeeId: string) {
    const path = findPath(data, employeeId);
    if (!path || path.length === 0) return;
    setFocusRootId(path[0]);
    setSelectedId(employeeId);
    setEmployeeQuery("");
  }

  const employeeSearchBox = (small: boolean) => (
    <div className={small ? "relative w-64" : "relative"}>
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={employeeQuery}
        onChange={(e) => setEmployeeQuery(e.target.value)}
        placeholder="Search by name, email or username..."
        className="h-9 pl-7 text-sm"
        aria-label="Search SQLGeneral employees"
      />
      {employeeResults.length > 0 && (
        <Card className="absolute z-10 mt-1 max-h-56 w-full overflow-auto p-1">
          {employeeResults.map((r) => (
            <button key={r.id} type="button" className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => focusOnEmployee(r.id)}>
              <span className="font-medium">{sqlGeneralLabel(r)}</span>
              <span className="text-xs text-muted-foreground">
                {r.sqlGeneralUsername as string}
                {r.isLocal ? "" : " · no TicketApp account"}
              </span>
            </button>
          ))}
        </Card>
      )}
    </div>
  );

  if (!focusRoot) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-auto p-4">
        <div>
          <p className="mb-1 text-sm font-medium">Find an employee</p>
          {employeeSearchBox(false)}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <p className="mb-1 text-sm font-medium">Browse by manager</p>
          <Input value={directoryQuery} onChange={(e) => setDirectoryQuery(e.target.value)} placeholder="Filter managers..." className="mb-2 h-9 text-sm" aria-label="Filter manager directory" />
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            {filteredDirectory.length === 0 && <p className="p-3 text-sm text-muted-foreground">No managers match.</p>}
            {filteredDirectory.map((e) => (
              <button
                key={e.id}
                type="button"
                className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                onClick={() => {
                  setFocusRootId(e.id);
                  setSelectedId(null);
                }}
              >
                <span className="truncate font-medium">{e.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {e.size} {e.size === 1 ? "report" : "reports"}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setFocusRootId(null);
            setSelectedId(null);
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Directory
        </Button>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="truncate text-sm font-medium">{sqlGeneralLabel(focusRoot)}</span>
        <span className="ml-auto">{employeeSearchBox(true)}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ReactFlowProvider>
          <ChartCanvas mode="sqlgeneral" data={[focusRoot]} fullAccess={fullAccess} selectedId={selectedId} setSelectedId={setSelectedId} highlightedIds={highlightedIds} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export function OrganizationChartView() {
  const [mode, setMode] = useState<Mode>("departments");
  const [activeOnly, setActiveOnly] = useState(true);
  const [data, setData] = useState<RawTreeNode[] | null>(null);
  const [fullAccess, setFullAccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<"permission" | "network" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [unresolvedUsers, setUnresolvedUsers] = useState<UnresolvedSqlGeneralUser[]>([]);
  const [unresolvedManagerLinks, setUnresolvedManagerLinks] = useState<UnresolvedSqlGeneralManagerLink[]>([]);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setErrorState(null);
    try {
      const url =
        mode === "departments"
          ? `/api/organization/department-tree?activeOnly=${activeOnly}`
          : mode === "people"
            ? `/api/organization/people-tree?activeOnly=${activeOnly}`
            : `/api/admin/organization/sqlgeneral-tree`;
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        setErrorState("permission");
        setData(null);
        return;
      }
      if (!res.ok) {
        setErrorState("network");
        setData(null);
        return;
      }
      const body = await res.json();
      setData(body.tree ?? []);
      setFullAccess(Boolean(body.fullAccess));
      setUnresolvedUsers(mode === "sqlgeneral" ? (body.unresolvedUsers ?? []) : []);
      setUnresolvedManagerLinks(mode === "sqlgeneral" ? (body.unresolvedManagerLinks ?? []) : []);
    } catch {
      setErrorState("network");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [mode, activeOnly]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/organization/sync/status");
      if (!res.ok) return; // 403 = no full-tree access, silently skip (not an error state for this widget)
      const body: SyncStatusResponse = await res.json();
      setSyncStatus(body);
    } catch {
      // best-effort widget, never surfaces its own error state
    }
  }, []);

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

  useEffect(() => {
    if (!syncStatus?.running) return;
    const interval = setInterval(fetchSyncStatus, 3000);
    return () => clearInterval(interval);
  }, [syncStatus?.running, fetchSyncStatus]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/organization/search?q=${encodeURIComponent(searchQuery)}`);
        if (!res.ok) return;
        const body = await res.json();
        setSearchResults(body.results ?? []);
      } catch {
        // best-effort — search box just shows no results
      }
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchQuery]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/organization/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body?.message ?? "Organization sync failed.");
      } else {
        toast.success(`Sync complete — ${body.usersUpdated} users updated, ${body.errorCount} errors.`);
        await Promise.all([fetchTree(), fetchSyncStatus()]);
      }
    } catch {
      toast.error("Could not reach the server to start the sync.");
    } finally {
      setSyncing(false);
    }
  };

  const highlightedIds = useMemo(() => {
    if (!selectedId || !data) return new Set<string>();
    const path = findPath(data, selectedId);
    return path ? new Set(path) : new Set<string>();
  }, [selectedId, data]);

  const selectedRawNode = useMemo(() => {
    if (!selectedId || !data) return null;
    function find(nodes: RawTreeNode[]): RawTreeNode | null {
      for (const n of nodes) {
        if (n.id === selectedId) return n;
        const found = find(n.children);
        if (found) return found;
      }
      return null;
    }
    return find(data);
  }, [selectedId, data]);

  return (
    <div className="flex h-full min-h-[600px] flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={mode} onValueChange={(v) => { setMode(v as Mode); setSelectedId(null); }}>
          <TabsList>
            <TabsTrigger value="departments">Departments</TabsTrigger>
            <TabsTrigger value="people">People / Reporting lines</TabsTrigger>
            <TabsTrigger value="sqlgeneral">SQLGeneral source</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
          {mode !== "sqlgeneral" && (
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search name, email, department..."
                className="h-9 pl-7 text-sm"
                aria-label="Search organization"
              />
              {searchResults.length > 0 && (
                <Card className="absolute z-10 mt-1 max-h-64 w-full overflow-auto p-1">
                  {searchResults.map((r) => (
                    <button
                      key={`${r.type}-${r.id}`}
                      type="button"
                      className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        setSelectedId(r.id);
                        setSearchQuery("");
                        setSearchResults([]);
                        if (r.type === "department") setMode("departments");
                        else setMode("people");
                      }}
                    >
                      <span className="font-medium">{r.label}</span>
                      {r.sublabel && <span className="text-xs text-muted-foreground">{r.sublabel}</span>}
                    </button>
                  ))}
                </Card>
              )}
            </div>
          )}

          {mode !== "sqlgeneral" && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={!activeOnly} onCheckedChange={(v) => setActiveOnly(!v)} aria-label="Include inactive" />
              Include inactive
            </label>
          )}

          <Button variant="outline" size="sm" onClick={fetchTree} aria-label="Refresh">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          {fullAccess && (
            <Button size="sm" onClick={handleSync} disabled={syncing || syncStatus?.running}>
              <RefreshCw className={`h-3.5 w-3.5 ${syncing || syncStatus?.running ? "animate-spin" : ""}`} />
              {syncing || syncStatus?.running ? "Syncing…" : "Sync organization"}
            </Button>
          )}
        </div>
      </div>

      {syncStatus?.latestRun && (
        <p className="text-xs text-muted-foreground">
          Last synchronized:{" "}
          {syncStatus.latestRun.completedAt
            ? new Date(syncStatus.latestRun.completedAt).toLocaleString()
            : syncStatus.running
              ? "in progress…"
              : "never completed"}
          {syncStatus.latestRun.status === "PARTIAL" && ` (${syncStatus.latestRun.errorCount} records skipped — see server logs)`}
        </p>
      )}

      {mode === "sqlgeneral" && (unresolvedUsers.length > 0 || unresolvedManagerLinks.length > 0) && (
        <Card className="flex items-start gap-2 border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {unresolvedUsers.length > 0 && (
              <p>
                {unresolvedUsers.length} user{unresolvedUsers.length === 1 ? "" : "s"} not shown — unresolved SQLGeneral identity (see admin report for details).
              </p>
            )}
            {unresolvedManagerLinks.length > 0 && (
              <p>
                {unresolvedManagerLinks.length} manager relationship{unresolvedManagerLinks.length === 1 ? "" : "s"} could not be verified — shown as a root instead (
                {unresolvedManagerLinks.map((d) => `${d.sqlGeneralUsername}: ${d.reason}`).join(", ")}).
              </p>
            )}
          </div>
        </Card>
      )}

      <Card className="relative flex-1 overflow-hidden">
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col gap-3 bg-background/60 p-6">
            <Skeleton className="h-16 w-56" />
            <div className="ml-12 flex gap-3">
              <Skeleton className="h-16 w-56" />
              <Skeleton className="h-16 w-56" />
            </div>
          </div>
        )}

        {!loading && errorState === "permission" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">You don't have permission to view this.</p>
            <p className="text-sm text-muted-foreground">Sign in with an account that has organization access, or ask an administrator.</p>
          </div>
        )}

        {!loading && errorState === "network" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive" />
            <p className="font-medium">Couldn't load the organization chart.</p>
            <Button variant="outline" size="sm" onClick={fetchTree}>Try again</Button>
          </div>
        )}

        {!loading && !errorState && data && data.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
            <Inbox className="h-8 w-8" />
            <p>
              No {mode === "departments" ? "departments" : mode === "people" ? "people" : "SQLGeneral identities"} to show{!activeOnly ? "" : mode === "sqlgeneral" ? "" : " — try including inactive ones"}.
            </p>
          </div>
        )}

        {!loading && !errorState && data && data.length > 0 && mode === "sqlgeneral" && (
          <SqlGeneralManagerExplorer data={data} fullAccess={fullAccess} selectedId={selectedId} setSelectedId={setSelectedId} highlightedIds={highlightedIds} />
        )}

        {!loading && !errorState && data && data.length > 0 && mode !== "sqlgeneral" && (
          <ReactFlowProvider>
            <ChartCanvas mode={mode} data={data} fullAccess={fullAccess} selectedId={selectedId} setSelectedId={setSelectedId} highlightedIds={highlightedIds} />
          </ReactFlowProvider>
        )}
      </Card>

      <Dialog open={!!selectedRawNode} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent>
          {selectedRawNode && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {mode === "departments" ? (selectedRawNode.name as string) : mode === "people" ? (selectedRawNode.displayName as string | null) ?? "(no name)" : sqlGeneralLabel(selectedRawNode)}
                </DialogTitle>
                <DialogDescription>
                  {mode === "departments"
                    ? selectedRawNode.isActive
                      ? "Active department"
                      : "Inactive department"
                    : (selectedRawNode.jobTitle as string | null) ?? (mode === "sqlgeneral" && !selectedRawNode.isLocal ? "No TicketApp account" : "No job title")}
                </DialogDescription>
              </DialogHeader>
              {mode === "departments" ? (
                <div className="space-y-1 text-sm">
                  <p>Active users: {selectedRawNode.activeUserCount as number}</p>
                  <p>Total users: {selectedRawNode.totalUserCount as number}</p>
                  <p>Subdepartments: {(selectedRawNode.children as RawTreeNode[]).length}</p>
                  {(selectedRawNode.manager as { displayName: string | null } | null) && (
                    <p>Manager: {(selectedRawNode.manager as { displayName: string | null }).displayName}</p>
                  )}
                </div>
              ) : mode === "people" ? (
                <div className="space-y-1 text-sm">
                  <p>Email: {selectedRawNode.email as string}</p>
                  <p>Department: {(selectedRawNode.department as { name: string } | null)?.name ?? "None"}</p>
                  <p>Direct reports: {selectedRawNode.directReportsCount as number}</p>
                  <p>Status: {selectedRawNode.isActive ? "Active" : "Inactive"}</p>
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  <p>SQLGeneral username: {selectedRawNode.sqlGeneralUsername as string}</p>
                  {(selectedRawNode.email as string | null) && <p>Email: {selectedRawNode.email as string}</p>}
                  <p>Company: {(selectedRawNode.company as string | null) ?? "None"}</p>
                  <p>Department: {(selectedRawNode.department as string | null) ?? "None"}</p>
                  <p>Direct reports: {(selectedRawNode.children as RawTreeNode[]).length}</p>
                  <p>Status: {selectedRawNode.isActive ? "Active" : "Inactive"}</p>
                  <p>{selectedRawNode.isLocal ? "Linked to a TicketApp account" : "No TicketApp account — SQLGeneral identity only"}</p>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
