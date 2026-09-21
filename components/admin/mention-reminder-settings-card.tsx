"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { MENTION_REMINDER_UNITS, type MentionReminderUnit } from "@/lib/mention-reminders/config";

export function MentionReminderSettingsCard({ initialValue, initialUnit }: { initialValue: number; initialUnit: MentionReminderUnit }) {
  const [value, setValue] = useState(String(initialValue));
  const [unit, setUnit] = useState<MentionReminderUnit>(initialUnit);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/mention-reminders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: Number(value), unit }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message ?? data?.error ?? "Could not save the reminder delay.");
        return;
      }
      setValue(String(data.value));
      setUnit(data.unit);
      toast.success("Mention reminder delay saved.");
    } catch {
      toast.error("Could not save the reminder delay.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mention Reminder Settings</CardTitle>
        <CardDescription>
          A user mentioned in a Project or Activity Note who can reply and has not posted a Note there after this delay gets one reminder.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="mention-reminder-delay">Reminder delay</Label>
        <div className="flex items-center gap-2">
          <Input id="mention-reminder-delay" type="number" min={1} className="w-24" value={value} onChange={(e) => setValue(e.target.value)} />
          <select
            aria-label="Reminder delay unit"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={unit}
            onChange={(e) => setUnit(e.target.value as MentionReminderUnit)}
          >
            {MENTION_REMINDER_UNITS.map((u) => (
              <option key={u} value={u}>
                {u.charAt(0).toUpperCase() + u.slice(1)}
              </option>
            ))}
          </select>
          <Button onClick={save} disabled={saving} size="sm">
            {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Between 5 minutes and 30 days. Unsent reminders are recalculated from the original mention time.</p>
      </CardContent>
    </Card>
  );
}
