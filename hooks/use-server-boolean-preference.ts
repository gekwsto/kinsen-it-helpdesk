"use client";

import { useEffect, useState } from "react";

/**
 * Generic client-side binding for a self-only, server-persisted ON/OFF
 * preference exposed as `GET`/`PATCH { enabled: boolean }` at `apiPath` —
 * the exact shape every such preference route in this app already follows
 * (app/api/users/me/mention-reminders, .../new-department-tickets). Never
 * assumes a default locally: `enabled` stays `null` until the real value is
 * fetched, so a caller can render nothing (avoiding a flash of the wrong
 * state) until it resolves.
 */
export function useServerBooleanPreference(apiPath: string) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(apiPath)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setEnabled(!!d.enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [apiPath]);

  /** Returns true on success, false on failure (left to the caller to surface, e.g. a toast) — state is only updated optimistically-on-success, never left desynced from the server on a failed PATCH. */
  const toggle = async (next: boolean): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(apiPath, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error();
      setEnabled(next);
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { enabled, saving, toggle };
}
