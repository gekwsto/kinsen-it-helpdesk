"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Loader2 } from "lucide-react";
import { ProjectStatus } from "@prisma/client";

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
}

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>(ProjectStatus.PLANNING);
  const [priority, setPriority] = useState("2");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [successTarget, setSuccessTarget] = useState("");
  const [isGoal, setIsGoal] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => {
        if (p?.title) {
          setTitle(p.title);
          setDescription(p.description ?? "");
          setStatus(p.status);
          // Clamp to max priority 3 (High) in case legacy value of 4 exists
          setPriority(String(Math.min(p.priority ?? 2, 3)));
          setStartDate(p.startDate ? p.startDate.split("T")[0] : "");
          setEndDate(p.endDate ? p.endDate.split("T")[0] : "");
          setSuccessTarget(p.successTarget ?? "");
          setIsGoal(p.isGoal ?? false);
          // Pre-select existing members
          const existingIds = new Set<string>(
            (p.members ?? []).map((m: { id: string }) => m.id)
          );
          setSelectedMemberIds(existingIds);

          // Eligible members depend on the project's own department —
          // fetched once we know it, not in parallel with the project itself.
          const assignableUrl = `/api/users?assignableFor=project${p.departmentId ? `&departmentId=${p.departmentId}` : ""}`;
          fetch(assignableUrl)
            .then((r) => (r.ok ? r.json() : []))
            .then((users) => setAssignableUsers(Array.isArray(users) ? users : []));
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          status,
          priority: parseInt(priority),
          startDate: startDate || null,
          endDate: endDate || null,
          successTarget: successTarget || undefined,
          memberIds: Array.from(selectedMemberIds),
          isGoal,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update project");
      }
      toast.success("Project updated");
      router.push(`/projects/${id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update project");
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/projects/${id}`} className="hover:text-foreground truncate max-w-[200px]">
          {title}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Edit</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit Project</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                placeholder="Project title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Project description..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ProjectStatus).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">High</SelectItem>
                    <SelectItem value="2">Medium</SelectItem>
                    <SelectItem value="1">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="successTarget">Success Target</Label>
              <Textarea
                id="successTarget"
                placeholder="What does success look like?"
                value={successTarget}
                onChange={(e) => setSuccessTarget(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded"
                  checked={isGoal}
                  onChange={(e) => setIsGoal(e.target.checked)}
                />
                <span className="text-sm font-medium">This project is a Goal</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Mark this project as a yearly goal for tracking purposes.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Members</Label>
              <p className="text-xs text-muted-foreground">
                Only users eligible for this workspace are listed.
              </p>
              {assignableUsers.length > 0 ? (
                <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {assignableUsers.map((u) => (
                    <label
                      key={u.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded"
                        checked={selectedMemberIds.has(u.id)}
                        onChange={() => toggleMember(u.id)}
                      />
                      <span className="text-sm">{u.name ?? u.email}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                  No eligible users for this workspace yet.
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
