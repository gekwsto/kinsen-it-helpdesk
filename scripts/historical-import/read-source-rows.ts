/**
 * Phase 4.1 — the ONE shared reader for the "Project List" historical
 * import source file, used by BOTH the manifest generator
 * (generate-manifest.ts) and the dry-run tooling
 * (scripts/phase4-historical-import-dry-run.ts) — never duplicated between
 * them, so a future column/header fix only ever needs to happen once.
 *
 * Reads directly from the real .xlsx via exceljs (already a project
 * dependency — see lib/services/project-export-service.ts for the
 * existing convention) — NOT from any pre-extracted JSON cache — so this
 * is genuinely reusable against a freshly-exported source file with no
 * code change, by passing a different `filePath`.
 *
 * Column headers are matched EXACTLY as they appear in the real source
 * file (confirmed against "ProjectList_ 23-11-2026 (15 10).xlsx", sheet
 * "Project List", header row 1, data starting row 2) — including the
 * Greek-language "Τίτλος"/"Περιγραφή" headers, which are genuinely how the
 * source names Title/Description, never a translation artifact to "fix".
 */
import ExcelJS from "exceljs";

export interface SourceRow {
  excelRow: number;
  active: boolean | null;
  title: string;
  groupParent: string | null;
  status: string | null;
  departmentType: string | null;
  team: string | null;
  teamsOwner: string | null;
  expectedStartDate: string | null; // ISO, date-only semantics preserved as given by the source
  expectedFinishDate: string | null;
  actualStartDate: string | null;
  actualFinishDate: string | null;
  totalDays: number | null;
  projectOwner: string | null;
  ticketId: string | null;
  zohoLink: string | null;
  audiences: string | null;
  responsiblePeople: string | null;
  feedbackUsers: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  description: string | null;
}

const HEADER_TO_KEY: Record<string, keyof SourceRow> = {
  "Ενεργό": "active",
  "Τίτλος": "title",
  "Group/Parent": "groupParent",
  Status: "status",
  "Department Type": "departmentType",
  Team: "team",
  "Team's Owner": "teamsOwner",
  "Expected Start Date": "expectedStartDate",
  "Expected Finish Date": "expectedFinishDate",
  "Actual Start Date": "actualStartDate",
  "Actual Finish Date": "actualFinishDate",
  "Total Days": "totalDays",
  "Project Owner": "projectOwner",
  "Ticket ID": "ticketId",
  "Zoho Link": "zohoLink",
  Audiences: "audiences",
  "Responsible People": "responsiblePeople",
  "Feedback(s) User(s)": "feedbackUsers",
  ProjectsList_RES_LIST_ProjectList_COLUMN_EstimatedCost: "estimatedCost",
  "Actual Cost": "actualCost",
  "Περιγραφή": "description",
};

function cellToPlain(value: ExcelJS.CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in (value as any)) return String((value as any).text); // rich text
  if (typeof value === "object" && "result" in (value as any)) return (value as any).result ?? null; // formula
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

export async function readProjectListRows(filePath: string): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`No worksheet found in ${filePath}`);

  const headerRow = sheet.getRow(1);
  const columnKeyByIndex = new Map<number, keyof SourceRow>();
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const header = cell.value;
    if (typeof header === "string" && HEADER_TO_KEY[header]) {
      columnKeyByIndex.set(colNumber, HEADER_TO_KEY[header]);
    }
  });

  const missingHeaders = Object.keys(HEADER_TO_KEY).filter((h) => !Array.from(columnKeyByIndex.values()).includes(HEADER_TO_KEY[h]));
  if (missingHeaders.length > 0) {
    throw new Error(`Source file is missing expected column(s): ${missingHeaders.join(", ")} — refusing to guess a different mapping.`);
  }

  const rows: SourceRow[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;
    const partial: Partial<SourceRow> = { excelRow: rowNumber };
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = columnKeyByIndex.get(colNumber);
      if (!key) return;
      (partial as any)[key] = cellToPlain(cell.value);
    });
    if (!partial.title) continue; // a genuinely blank trailing row, never a real source record
    rows.push(partial as SourceRow);
  }
  return rows;
}
