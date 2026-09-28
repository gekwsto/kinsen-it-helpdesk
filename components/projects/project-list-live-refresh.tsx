"use client";

import { useRouter } from "next/navigation";
import { useProjectListRealtime } from "@/hooks/use-project-list-realtime";

/**
 * Mount ONCE on the /projects list page. Renders nothing. On a debounced
 * PROJECTS_CHANGED signal, calls router.refresh() — re-runs the SAME Server
 * Component page with its EXACT current URL (search, status, statusGroup,
 * page, pageSize, workspace/department filters all untouched), re-executing
 * its real server-side authorization/scope/filter query from scratch.
 * Mirrors components/tickets/ticket-list-live-refresh.tsx exactly.
 */
export function ProjectListLiveRefresh() {
  const router = useRouter();
  useProjectListRealtime(() => router.refresh());
  return null;
}
