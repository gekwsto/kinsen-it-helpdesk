"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function EmailPollButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const poll = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/email/poll", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setResult(data.message);
        router.refresh();
      } else {
        setResult(`Error: ${data.error ?? "Unknown error"}`);
      }
    } catch {
      setResult("Network error — check console.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Button onClick={poll} disabled={loading} size="sm">
        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
        {loading ? "Polling…" : "Poll Now"}
      </Button>
      {result && (
        <span className={`text-sm ${result.startsWith("Error") ? "text-destructive" : "text-muted-foreground"}`}>
          {result}
        </span>
      )}
    </div>
  );
}
