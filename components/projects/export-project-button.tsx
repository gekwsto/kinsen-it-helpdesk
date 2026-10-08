"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { downloadFile } from "@/lib/download-file";

interface ExportProjectButtonProps {
  projectId: string;
}

/**
 * Triggers GET /api/projects/[id]/export — see ExportProjectsButton (the
 * All Projects list's own export trigger) for the shared controlled
 * fetch+blob download rationale (lib/download-file.ts).
 */
export function ExportProjectButton({ projectId }: ExportProjectButtonProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await downloadFile(`/api/projects/${projectId}/export`, "project-export.xlsx");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to export project");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Button variant="outline" onClick={handleExport} disabled={isExporting} data-testid="export-project-button">
      {isExporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
      {isExporting ? "Exporting..." : "Export to Excel"}
    </Button>
  );
}
