"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DepartmentInboundEmailFormProps {
  departmentId: string;
  inboundEmail: string | null;
  /** Only a caller with department.email.manage for this department may edit — everyone who can reach this page can view. */
  canManage: boolean;
  /**
   * Compact inline rendering (no Card wrapper) for use inside an existing
   * card, e.g. next to members/tickets/projects/activities on
   * /my-departments — vs. the default standalone Card used on the admin
   * department detail page.
   */
  compact?: boolean;
}

export function DepartmentInboundEmailForm({ departmentId, inboundEmail, canManage, compact = false }: DepartmentInboundEmailFormProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(inboundEmail ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/inbound-email`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inboundEmail: value.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update inbound email");
      }
      toast.success("Inbound email updated");
      setEditing(false);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update inbound email");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setValue(inboundEmail ?? "");
    setEditing(false);
  };

  if (compact) {
    return (
      <div className="space-y-1 border-t pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Inbound Email</span>
          {canManage && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              title={inboundEmail ? "Change inbound email" : "Set up inbound email"}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>

        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              type="email"
              autoFocus
              placeholder="e.g. finance@kinsen.gr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={saving}
              className="h-7 text-xs"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              title="Save"
              className="flex-shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              title="Cancel"
              className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p
            className={cn("text-xs truncate", inboundEmail ? "font-medium" : "text-muted-foreground italic")}
            title={inboundEmail ?? undefined}
          >
            {inboundEmail ?? "No inbound email configured"}
          </p>
        )}

        <p className="text-[10px] text-muted-foreground leading-snug">
          {canManage
            ? "Emails sent to this address become Pending Tickets for this department."
            : "Emails sent here create Pending Tickets for this department."}
        </p>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
          <Mail className="h-4 w-4 text-blue-600" />
        </div>
        <CardTitle className="text-base">Inbound Email</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <div className="space-y-2">
            <Input
              type="email"
              placeholder="e.g. finance@kinsen.gr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">
              {inboundEmail ? (
                <span className="font-medium">{inboundEmail}</span>
              ) : (
                <span className="text-muted-foreground">No inbound email configured.</span>
              )}
            </p>
            {canManage && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                {inboundEmail ? "Change" : "Set up"}
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Emails received for this address will create Pending Tickets for this department.
        </p>
      </CardContent>
    </Card>
  );
}
