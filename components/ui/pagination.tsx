"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPageNumbers, PAGE_SIZE_OPTIONS, type PaginationMeta } from "@/lib/pagination";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

interface PaginationControlsProps {
  pagination: PaginationMeta;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  itemLabel?: string;
  className?: string;
}

/**
 * Generic, URL-agnostic pagination controls — the page fetching/URL-sync
 * logic lives in whichever page uses this (see app/(main)/admin/users/page.tsx
 * + components/admin/user-management.tsx), this component only renders and
 * reports intent via callbacks. Page-number windowing/ellipsis math comes
 * from lib/pagination.ts (shared, unit-tested), not reimplemented here.
 */
export function PaginationControls({
  pagination,
  onPageChange,
  onPageSizeChange,
  itemLabel = "results",
  className,
}: PaginationControlsProps) {
  const { page, pageSize, totalCount, totalPages, hasPreviousPage, hasNextPage, startIndex, endIndex } = pagination;
  const pageTokens = getPageNumbers(page, totalPages);

  return (
    <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${className ?? ""}`}>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {totalCount === 0
            ? `No ${itemLabel}`
            : `Showing ${startIndex}–${endIndex} of ${totalCount} ${itemLabel}`}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="hidden sm:inline">Per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-8 w-[70px]" aria-label="Results per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {totalPages > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPreviousPage}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Previous</span>
          </Button>

          {/* Numbered pages — hidden on very small screens in favor of the compact "Page X of Y" text, so controls never overflow/wrap awkwardly on mobile. */}
          <div className="hidden items-center gap-1 sm:flex">
            {pageTokens.map((token, i) =>
              token === "ellipsis" ? (
                <span key={`ellipsis-${i}`} className="flex h-8 w-8 items-center justify-center text-muted-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                </span>
              ) : (
                <Button
                  key={token}
                  variant={token === page ? "default" : "outline"}
                  size="sm"
                  className="h-8 w-8 p-0"
                  aria-current={token === page ? "page" : undefined}
                  aria-label={`Page ${token}`}
                  onClick={() => onPageChange(token)}
                >
                  {token}
                </Button>
              )
            )}
          </div>
          <span className="text-sm text-muted-foreground sm:hidden">
            Page {page} of {totalPages}
          </span>

          <Button
            variant="outline"
            size="sm"
            disabled={!hasNextPage}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="h-4 w-4 sm:ml-1" />
          </Button>
        </nav>
      )}
    </div>
  );
}
