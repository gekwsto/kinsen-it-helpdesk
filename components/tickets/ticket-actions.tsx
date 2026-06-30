"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { UserCheck, GitBranch, Tag, Layers, Loader2 } from "lucide-react";

interface TicketActionsProps {
  ticket: {
    id: string;
    statusId: string;
    priorityId?: string | null;
    categoryId?: string | null;
    assignedAgentId?: string | null;
  };
  statuses: Array<{ id: string; name: string; color: string }>;
  priorities: Array<{ id: string; name: string; color: string; level: number }>;
  categories: Array<{ id: string; name: string }>;
  agents: Array<{
    id: string;
    name?: string | null;
    email: string;
    image?: string | null;
  }>;
  canChangeStatus: boolean;
  canAssign: boolean;
}

export function TicketActions({
  ticket,
  statuses,
  priorities,
  categories,
  agents,
  canChangeStatus,
  canAssign,
}: TicketActionsProps) {
  const [loading, setLoading] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);

  const [selectedStatus, setSelectedStatus] = useState(ticket.statusId);
  const [selectedAgent, setSelectedAgent] = useState(ticket.assignedAgentId ?? "");
  const [selectedPriority, setSelectedPriority] = useState(ticket.priorityId ?? "");
  const [selectedCategory, setSelectedCategory] = useState(ticket.categoryId ?? "");

  // Sync dialog pre-selections when ticket metadata changes from real-time events
  useEffect(() => {
    if (!statusOpen) setSelectedStatus(ticket.statusId);
  }, [ticket.statusId, statusOpen]);

  useEffect(() => {
    if (!assignOpen) setSelectedAgent(ticket.assignedAgentId ?? "");
  }, [ticket.assignedAgentId, assignOpen]);

  useEffect(() => {
    if (!priorityOpen) setSelectedPriority(ticket.priorityId ?? "");
  }, [ticket.priorityId, priorityOpen]);

  useEffect(() => {
    if (!categoryOpen) setSelectedCategory(ticket.categoryId ?? "");
  }, [ticket.categoryId, categoryOpen]);

  const patch = async (endpoint: string, data: object, label: string) => {
    setLoading(label);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Request failed");
      toast.success(`${label} updated`);
      // Real-time SSE event will update the UI — no router.refresh() needed
    } catch {
      toast.error(`Failed to update ${label.toLowerCase()}`);
    } finally {
      setLoading(null);
    }
  };

  const handleStatusChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}/status`,
      { statusId: selectedStatus },
      "Status"
    );
    setStatusOpen(false);
  };

  const handleAssign = async () => {
    await patch(
      `/api/tickets/${ticket.id}/assign`,
      { assignedAgentId: selectedAgent || null },
      "Assignment"
    );
    setAssignOpen(false);
  };

  const handlePriorityChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}`,
      { priorityId: selectedPriority || null },
      "Priority"
    );
    setPriorityOpen(false);
  };

  const handleCategoryChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}`,
      { categoryId: selectedCategory || null },
      "Category"
    );
    setCategoryOpen(false);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Change Status */}
        {canChangeStatus && (
          <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <GitBranch className="h-3.5 w-3.5" />
                Change Status
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Status</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>New Status</Label>
                <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: s.color }}
                          />
                          {s.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleStatusChange} disabled={loading === "Status"}>
                  {loading === "Status" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Status
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Assign Agent */}
        {canAssign && (
          <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <UserCheck className="h-3.5 w-3.5" />
                Assign Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Assign Agent</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Assign to</Label>
                <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">Unassigned</span>
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={a.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">
                              {getInitials(a.name)}
                            </AvatarFallback>
                          </Avatar>
                          {a.name ?? a.email}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleAssign} disabled={loading === "Assignment"}>
                  {loading === "Assignment" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Assign
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Change Priority */}
        {canChangeStatus && (
          <Dialog open={priorityOpen} onOpenChange={setPriorityOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Layers className="h-3.5 w-3.5" />
                Change Priority
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Priority</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Priority</Label>
                <Select value={selectedPriority} onValueChange={setSelectedPriority}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">None</span>
                    </SelectItem>
                    {priorities.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handlePriorityChange} disabled={loading === "Priority"}>
                  {loading === "Priority" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Priority
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Change Category */}
        {canChangeStatus && (
          <Dialog open={categoryOpen} onOpenChange={setCategoryOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Tag className="h-3.5 w-3.5" />
                Change Category
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Category</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Category</Label>
                <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">None</span>
                    </SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleCategoryChange} disabled={loading === "Category"}>
                  {loading === "Category" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Category
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
