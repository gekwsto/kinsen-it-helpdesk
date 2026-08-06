"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { PaginationControls } from "@/components/ui/pagination";
import type { PaginationMeta } from "@/lib/pagination";

interface ActivityPaginationBarProps {
  pagination: PaginationMeta;
}

/**
 * URL-sync wrapper around the shared PaginationControls — same convention as
 * components/projects/project-pagination-bar.tsx: a page change preserves
 * every other filter param, a page-size change resets back to page 1.
 */
export function ActivityPaginationBar({ pagination }: ActivityPaginationBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateParams = (updates: Record<string, string | null>, opts: { resetPage?: boolean } = {}) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    if (opts.resetPage) params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <PaginationControls
      pagination={pagination}
      onPageChange={(page) => updateParams({ page: page === 1 ? null : String(page) })}
      onPageSizeChange={(pageSize) => updateParams({ pageSize: pageSize === 20 ? null : String(pageSize) }, { resetPage: true })}
      itemLabel="activities"
    />
  );
}
