"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, X } from "lucide-react";

interface PendingTicketFiltersProps {
  departments: { id: string; name: string }[];
}

export function PendingTicketFilters({ departments }: PendingTicketFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const get = (key: string) => searchParams.get(key) ?? "";
  const [fromEmail, setFromEmail] = useState(get("fromEmail"));
  const [subject, setSubject] = useState(get("subject"));

  const push = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      params.delete("page");
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [pathname, router, searchParams]
  );

  const hasAnyFilter = !!(get("fromEmail") || get("subject") || get("departmentId") || get("status") || get("receivedAfter") || get("receivedBefore"));

  const resetAll = () => {
    setFromEmail("");
    setSubject("");
    startTransition(() => router.push(pathname));
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="space-y-1 lg:col-span-2">
          <Label className="text-xs text-muted-foreground">Sender</Label>
          <form onSubmit={(e) => { e.preventDefault(); push({ fromEmail: fromEmail || null }); }} className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-8 pl-8 text-xs"
              placeholder="sender@example.com"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              onBlur={() => push({ fromEmail: fromEmail || null })}
            />
          </form>
        </div>

        <div className="space-y-1 lg:col-span-2">
          <Label className="text-xs text-muted-foreground">Subject</Label>
          <Input
            className="h-8 text-xs"
            placeholder="Search subject…"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={() => push({ subject: subject || null })}
          />
        </div>

        {departments.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Department</Label>
            <Select value={get("departmentId") || "all"} onValueChange={(v) => push({ departmentId: v === "all" ? null : v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any department</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={get("status") || "PENDING"} onValueChange={(v) => push({ status: v })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="ACCEPTED">Accepted</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Received after</Label>
          <Input
            type="date"
            className="h-8 text-xs"
            value={get("receivedAfter")}
            onChange={(e) => push({ receivedAfter: e.target.value || null })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Received before</Label>
          <Input
            type="date"
            className="h-8 text-xs"
            value={get("receivedBefore")}
            onChange={(e) => push({ receivedBefore: e.target.value || null })}
          />
        </div>
        {hasAnyFilter && (
          <Button variant="ghost" size="sm" className="h-8 text-muted-foreground" onClick={resetAll}>
            <X className="h-3.5 w-3.5 mr-1" />
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
