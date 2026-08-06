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
import { RefreshCw, Search, Maximize2, AlertTriangle, Inbox } from "lucide-react";
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

type Mode = "departments" | "people";

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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    seedDefaultCollapsed(data, 0, mode === "departments" ? 2 : 2, s);
    return s;
  });

  // Re-seed default collapse state whenever the underlying data set changes
  // (mode switch, filter toggle, fresh fetch) — never carries stale
  // collapsed ids from a previous, structurally different tree.
  const dataSignature = useMemo(() => JSON.stringify(flattenIds(data)), [data]);
  useEffect(() => {
    const s = new Set<string>();
    seedDefaultCollapsed(data, 0, 2, s);
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
      } else {
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
      aria-label={mode === "departments" ? "Department organization chart" : "People reporting-line chart"}
    >
      <Background />
      <Controls showInteractive={false} />
      {fullAccess && <MiniMap pannable zoomable className="!bg-card" />}
    </ReactFlow>
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
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    setErrorState(null);
    try {
      const url = mode === "departments" ? `/api/organization/department-tree?activeOnly=${activeOnly}` : `/api/organization/people-tree?activeOnly=${activeOnly}`;
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
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-3">
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

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={!activeOnly} onCheckedChange={(v) => setActiveOnly(!v)} aria-label="Include inactive" />
            Include inactive
          </label>

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
            <p>No {mode === "departments" ? "departments" : "people"} to show{!activeOnly ? "" : " — try including inactive ones"}.</p>
          </div>
        )}

        {!loading && !errorState && data && data.length > 0 && (
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
                <DialogTitle>{mode === "departments" ? (selectedRawNode.name as string) : (selectedRawNode.displayName as string | null) ?? "(no name)"}</DialogTitle>
                <DialogDescription>
                  {mode === "departments" ? (selectedRawNode.isActive ? "Active department" : "Inactive department") : (selectedRawNode.jobTitle as string | null) ?? "No job title"}
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
              ) : (
                <div className="space-y-1 text-sm">
                  <p>Email: {selectedRawNode.email as string}</p>
                  <p>Department: {(selectedRawNode.department as { name: string } | null)?.name ?? "None"}</p>
                  <p>Direct reports: {selectedRawNode.directReportsCount as number}</p>
                  <p>Status: {selectedRawNode.isActive ? "Active" : "Inactive"}</p>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
