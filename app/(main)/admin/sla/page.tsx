"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, Clock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface PriorityPolicy {
  id: string;
  name: string;
  color: string;
  level: number;
  firstResponseHours: number;
  resolutionHours: number;
}

export default function SlaAdminPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);
  const [policies, setPolicies] = useState<PriorityPolicy[]>([]);

  useEffect(() => {
    fetch("/api/admin/sla")
      .then((r) => r.json())
      .then((data) => {
        setIsEnabled(data.isEnabled ?? false);
        setPolicies(data.priorities ?? []);
      })
      .catch(() => toast.error("Failed to load SLA settings"))
      .finally(() => setLoading(false));
  }, []);

  const updatePolicy = (id: string, field: "firstResponseHours" | "resolutionHours", value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 1) return;
    setPolicies((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: num } : p))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/sla", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isEnabled,
          policies: policies.map((p) => ({
            priorityId: p.id,
            firstResponseHours: p.firstResponseHours,
            resolutionHours: p.resolutionHours,
          })),
        }),
      });
      if (!res.ok) throw new Error();
      toast.success("SLA settings saved");
    } catch {
      toast.error("Failed to save SLA settings");
    } finally {
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
      <div>
        <h1 className="text-2xl font-bold">SLA Configuration</h1>
        <p className="text-muted-foreground mt-1">
          Set response and resolution time targets per ticket priority.
        </p>
      </div>

      {/* Enable / Disable toggle */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <ShieldCheck className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-base">SLA Enforcement</CardTitle>
                <CardDescription className="text-sm mt-0.5">
                  {isEnabled
                    ? "SLA timers are active and tracking deadlines."
                    : "SLA is currently disabled. No deadlines are tracked."}
                </CardDescription>
              </div>
            </div>
            <Switch
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
              aria-label="Toggle SLA"
            />
          </div>
        </CardHeader>
      </Card>

      {/* Per-priority policies */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Deadlines by Priority</CardTitle>
          </div>
          <CardDescription>
            Times are in hours from ticket creation. Applied when SLA is enabled.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_140px_140px] gap-4 px-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Priority</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">First Response</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Resolution</span>
          </div>

          <div className="divide-y rounded-lg border">
            {policies.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[1fr_140px_140px] gap-4 items-center px-3 py-3"
              >
                {/* Priority badge */}
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="text-sm font-medium">{p.name}</span>
                </div>

                {/* First response */}
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    value={p.firstResponseHours}
                    onChange={(e) => updatePolicy(p.id, "firstResponseHours", e.target.value)}
                    className="h-8 w-20 text-sm"
                    disabled={!isEnabled}
                  />
                  <span className="text-xs text-muted-foreground">h</span>
                </div>

                {/* Resolution */}
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    value={p.resolutionHours}
                    onChange={(e) => updatePolicy(p.id, "resolutionHours", e.target.value)}
                    className="h-8 w-20 text-sm"
                    disabled={!isEnabled}
                  />
                  <span className="text-xs text-muted-foreground">h</span>
                </div>
              </div>
            ))}
          </div>

          {!isEnabled && (
            <p className="text-xs text-muted-foreground pt-2 px-1">
              Enable SLA above to edit deadlines.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save Settings
        </Button>
      </div>
    </div>
  );
}
