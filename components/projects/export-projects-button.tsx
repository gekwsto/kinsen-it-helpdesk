"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { downloadFile } from "@/lib/download-file";

/**
 * Triggers GET /api/projects/export with the CURRENT URL's filter/sort
 * query params attached as-is — same convention as ProjectPaginationBar's
 * own `new URLSearchParams(searchParams.toString())` reuse. A controlled
 * fetch+blob download (via lib/download-file.ts) rather than a plain
 * anchor, so a failed request surfaces a toast instead of failing
 * silently; the downloaded filename still comes from the route's own
 * Content-Disposition header, unchanged. page/pageSize/view are harmless
 * to forward too since the route only reads the filter/sort params it
 * knows about and ignores the rest.
 */
export function ExportProjectsButton() {
  const searchParams = useSearchParams();
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await downloadFile(`/api/projects/export?${searchParams.toString()}`, "projects-export.xlsx");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to export projects");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Button variant="outline" onClick={handleExport} disabled={isExporting} data-testid="export-projects-button">
      {isExporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
      {isExporting ? "Exporting..." : "Export to Excel"}
    </Button>
  );
}
