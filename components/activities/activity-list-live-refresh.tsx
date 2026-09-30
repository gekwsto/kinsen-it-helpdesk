"use client";

import { useRouter } from "next/navigation";
import { useActivityListRealtime } from "@/hooks/use-activity-list-realtime";

/**
 * Mount ONCE on an Activities list page (/activities, /my-activities).
 * Renders nothing. On a debounced ACTIVITIES_CHANGED signal, calls
 * router.refresh() — re-runs the SAME Server Component page with its EXACT
 * current URL (search, filters, sort, page, pageSize, view all untouched),
 * re-executing its real server-side authorization/scope/filter query from
 * scratch. Mirrors components/projects/project-list-live-refresh.tsx exactly.
 */
export function ActivityListLiveRefresh() {
  const router = useRouter();
  useActivityListRealtime(() => router.refresh());
  return null;
}
