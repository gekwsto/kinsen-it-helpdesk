/**
 * Excel (.xlsx) generation for Projects — two distinct exports, built with
 * `exceljs` (the only new dependency this feature adds):
 *
 *   - buildProjectsListWorkbook: ONE worksheet, one row per Project — used
 *     by GET /api/projects/export (the All Projects list's "Export to
 *     Excel" button). Caller is responsible for authorization and for
 *     resolving the exact same `where`/`orderBy` the on-screen list uses
 *     (see lib/services/project-query-service.ts's buildProjectListQuery —
 *     reused VERBATIM, never re-implemented here); this module only turns
 *     already-authorized, already-filtered rows into a workbook. It never
 *     queries the database itself.
 *
 *   - buildProjectDetailWorkbook: THREE worksheets (Project Details,
 *     Financials, Activities) — used by GET /api/projects/[id]/export (the
 *     Project detail page's own "Export to Excel" button). Caller is
 *     responsible for authorization (hasProjectViewAccess, the SAME check
 *     the detail page itself uses) and for loading the Project + its
 *     Activities; this module only renders them.
 *
 * Column headers are plain business language (never raw enum/field names),
 * dates are real Excel date cells (a `numFmt`, not pre-formatted strings —
 * so they stay sortable/filterable in Excel itself), and every sheet gets
 * a frozen header row + autofilter.
 */
import ExcelJS from "exceljs";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";
import { computeActivityFinancials } from "@/lib/services/project-financials-service";
import { formatFacilitiesQuarterLabel } from "@/lib/services/project-facilities-service";
import type { Prisma, ProjectQuarter } from "@prisma/client";

const DATE_FORMAT = "dd mmm yyyy";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };

function styleHeaderRow(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(1);
  row.font = { bold: true };
  row.fill = HEADER_FILL;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function applyAutoFilter(sheet: ExcelJS.Worksheet) {
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns?.length ?? 1 },
  };
}

function applyDateFormat(sheet: ExcelJS.Worksheet, keys: string[]) {
  for (const key of keys) {
    const col = sheet.getColumn(key);
    col.numFmt = DATE_FORMAT;
  }
}

function humanizeEnum(value: string): string {
  return value.replace(/_/g, " ");
}

function decimalToNumber(value: Prisma.Decimal | number): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Writes a TOTAL-row cell as a real Excel SUM formula over that column's
 * own data rows (`result` is supplied too, so the total still displays
 * correctly in a viewer that doesn't recalculate on open). This does NOT
 * weaken the formula-injection defense-in-depth above: a `<f>` formula
 * element is written here ONLY for this app-authored total, over a range
 * of numeric duration cells — never for a value built from user-controlled
 * input (every other cell in these sheets keeps going through
 * sanitizeRow/sanitizeCellValue exactly as before, completely unaffected
 * by this helper). Falls back to a plain number when there are no data
 * rows to sum (`SUM(D2:D1)` is an invalid/empty range) — an empty export
 * still shows a correct 0 total, not a formula error.
 */
function setSumTotalCell(
  sheet: ExcelJS.Worksheet,
  totalsRowNumber: number,
  columnKey: string,
  firstDataRow: number,
  lastDataRow: number,
  sumValue: number
) {
  const column = sheet.getColumn(columnKey);
  const cell = sheet.getCell(totalsRowNumber, column.number);
  cell.value =
    lastDataRow >= firstDataRow ? { formula: `SUM(${column.letter}${firstDataRow}:${column.letter}${lastDataRow})`, result: sumValue } : sumValue;
}

// ─── Formula-injection defense-in-depth (CWE-1236) ──────────────────────────
// Every exported .xlsx cell is written as a plain OOXML shared-string value
// (`t="s"`, never a `<f>` formula element — verified directly against the
// generated sheet XML), so Excel itself never re-interprets a stored string
// cell as a formula just because its text happens to start with "=". The
// risk this guards against is downstream: a user re-saving the export as
// CSV, or a more lenient spreadsheet/CSV parser treating a leading
// =, +, -, or @ as a formula/DDE trigger (the long-standing "CSV/Formula
// Injection" class). Applied generically to every string value passed into
// a row or key-value cell — never to a specific named field — so no column
// can be missed, and a newly-added column never needs its own patch.
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

function sanitizeExcelString(value: string): string {
  return value.length > 0 && FORMULA_TRIGGER_CHARS.has(value[0]) ? `'${value}` : value;
}

function sanitizeCellValue<T>(value: T): T {
  return typeof value === "string" ? (sanitizeExcelString(value) as unknown as T) : value;
}

function sanitizeRow<T extends Record<string, unknown>>(row: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) sanitized[key] = sanitizeCellValue(val);
  return sanitized as T;
}

// ─── Projects LIST export (/api/projects/export) ────────────────────────────

export interface ProjectExportRow {
  title: string;
  description: string | null;
  status: string;
  priority: number;
  origin: "From Request" | "Manual";
  departmentName: string | null;
  owners: string[];
  members: string[];
  activitiesCount: number;
  progress: number;
  overdue: boolean;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  // Facilities Services only — null for every other workspace's Project
  // (and for a Facilities Project that simply never set them). Start
  // Date/Due Date above still carry the derived boundary date regardless
  // (unchanged, still sortable/filterable); these add the human Quarter
  // label alongside, and the free-text Company/Location.
  facilitiesCompany: string | null;
  facilitiesLocation: string | null;
  facilitiesStartQuarter: ProjectQuarter | null;
  facilitiesStartYear: number | null;
  facilitiesEndQuarter: ProjectQuarter | null;
  facilitiesEndYear: number | null;
  // Facilities Services only — directly entered, NEVER the Activity-derived
  // rollup (see lib/services/project-financials-service.ts, unrelated and
  // not exported on this row at all — the list export never included
  // Estimated/Actual Cost before this feature either).
  facilitiesCategory: string | null;
  facilitiesEstimatedCost: Prisma.Decimal | number | null;
  facilitiesEstimatedCostNotes: string | null;
  facilitiesActualCost: Prisma.Decimal | number | null;
  facilitiesActualCostNotes: string | null;
  // Plain manual classification Booleans, never null (DB column itself is
  // non-nullable @default(false)) — see this feature's own doc comment in
  // prisma/schema.prisma. Unlike every other Facilities field on this row
  // (never gated on workspace membership here, by established precedent —
  // see Company/Location above), these two ARE gated by
  // isFacilitiesServicesWorkspace before rendering: a plain boolean has no
  // natural "blank/not applicable" representation the way a null string
  // does, so without this gate every non-Facilities Project (the vast
  // majority of rows in a mixed-department export) would show a
  // misleading "No" for a classification that was never applicable to it
  // in the first place. The underlying value is still exported as-is for
  // a HISTORICALLY Facilities Project that has since moved out — it's
  // just never rendered once outside the workspace, matching the
  // Project Overview page's own display rule.
  isFacilitiesServicesWorkspace: boolean;
  facilitiesPlannedForAnnualTargets: boolean;
  facilitiesIsBigProject: boolean;
  // Project Scoring — the raw persisted inputs plus the two ALREADY-
  // COMPUTED percentage labels (see lib/services/project-scoring-
  // service.ts, the one canonical calculation; computed by the calling
  // route, never here — this module never queries the database). Gated
  // on isFacilitiesServicesWorkspace the same way as Planned/Big Project
  // above, for the same reason (a plain Int has no natural "blank"
  // representation outside the workspace).
  facilitiesProjectImportanceOverall: number | null;
  facilitiesProjectScore: number | null;
  facilitiesImportanceScoreLabel: string | null;
  facilitiesScoreLabel: string | null;
}

export async function buildProjectsListWorkbook(rows: ProjectExportRow[]): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kinsen IT Helpdesk";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Projects");
  sheet.columns = [
    { header: "Title", key: "title", width: 32 },
    { header: "Status", key: "status", width: 14 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Origin", key: "origin", width: 14 },
    { header: "Workspace", key: "departmentName", width: 20 },
    { header: "Owner(s)", key: "owners", width: 30 },
    { header: "Members", key: "members", width: 30 },
    { header: "Activities", key: "activitiesCount", width: 11 },
    { header: "Progress (%)", key: "progress", width: 12 },
    { header: "Overdue", key: "overdue", width: 10 },
    { header: "Expected Start", key: "expectedStartDate", width: 16 },
    { header: "Expected Finish", key: "expectedFinishDate", width: 16 },
    { header: "Start Date", key: "startDate", width: 14 },
    { header: "Due Date", key: "endDate", width: 14 },
    { header: "Company", key: "facilitiesCompany", width: 24 },
    { header: "Location", key: "facilitiesLocation", width: 24 },
    { header: "Start (Quarter)", key: "facilitiesStartQuarterLabel", width: 16 },
    { header: "End (Quarter)", key: "facilitiesEndQuarterLabel", width: 16 },
    { header: "Category", key: "facilitiesCategory", width: 20 },
    { header: "Estimated Cost (EUR)", key: "facilitiesEstimatedCost", width: 18 },
    { header: "Estimated Cost Notes", key: "facilitiesEstimatedCostNotes", width: 30 },
    { header: "Actual Cost (EUR)", key: "facilitiesActualCost", width: 16 },
    { header: "Actual Cost Notes", key: "facilitiesActualCostNotes", width: 30 },
    { header: "Planned for This Year's Targets", key: "facilitiesPlannedForAnnualTargets", width: 24 },
    { header: "Big Project", key: "facilitiesIsBigProject", width: 14 },
    { header: "Project Importance Overall", key: "facilitiesProjectImportanceOverall", width: 14 },
    { header: "Project Importance Score", key: "facilitiesImportanceScoreLabel", width: 16 },
    { header: "Project Score", key: "facilitiesProjectScore", width: 12 },
    { header: "Score", key: "facilitiesScoreLabel", width: 12 },
    { header: "Created", key: "createdAt", width: 16 },
    { header: "Description", key: "description", width: 40 },
  ];

  for (const r of rows) {
    sheet.addRow(
      sanitizeRow({
        title: r.title,
        // Already the configured Project Status label — never re-humanized.
        status: r.status,
        priority: PROJECT_PRIORITY_LABEL[r.priority] ?? r.priority,
        origin: r.origin,
        departmentName: r.departmentName ?? "—",
        owners: r.owners.length > 0 ? r.owners.join(", ") : "—",
        members: r.members.length > 0 ? r.members.join(", ") : "—",
        activitiesCount: r.activitiesCount,
        progress: r.progress,
        overdue: r.overdue ? "Yes" : "No",
        expectedStartDate: r.expectedStartDate,
        expectedFinishDate: r.expectedFinishDate,
        startDate: r.startDate,
        endDate: r.endDate,
        facilitiesCompany: r.facilitiesCompany ?? "",
        facilitiesLocation: r.facilitiesLocation ?? "",
        facilitiesStartQuarterLabel: formatFacilitiesQuarterLabel(r.facilitiesStartQuarter, r.facilitiesStartYear) ?? "",
        facilitiesEndQuarterLabel: formatFacilitiesQuarterLabel(r.facilitiesEndQuarter, r.facilitiesEndYear) ?? "",
        facilitiesCategory: r.facilitiesCategory ?? "",
        facilitiesEstimatedCost: r.facilitiesEstimatedCost !== null ? decimalToNumber(r.facilitiesEstimatedCost) : null,
        facilitiesEstimatedCostNotes: r.facilitiesEstimatedCostNotes ?? "",
        facilitiesActualCost: r.facilitiesActualCost !== null ? decimalToNumber(r.facilitiesActualCost) : null,
        facilitiesActualCostNotes: r.facilitiesActualCostNotes ?? "",
        facilitiesPlannedForAnnualTargets: r.isFacilitiesServicesWorkspace ? (r.facilitiesPlannedForAnnualTargets ? "Yes" : "No") : "",
        facilitiesIsBigProject: r.isFacilitiesServicesWorkspace ? (r.facilitiesIsBigProject ? "Yes" : "No") : "",
        facilitiesProjectImportanceOverall: r.isFacilitiesServicesWorkspace ? r.facilitiesProjectImportanceOverall ?? "" : "",
        facilitiesImportanceScoreLabel: r.isFacilitiesServicesWorkspace ? r.facilitiesImportanceScoreLabel ?? "" : "",
        facilitiesProjectScore: r.isFacilitiesServicesWorkspace ? r.facilitiesProjectScore ?? "" : "",
        facilitiesScoreLabel: r.isFacilitiesServicesWorkspace ? r.facilitiesScoreLabel ?? "" : "",
        createdAt: r.createdAt,
        description: r.description ?? "",
      })
    );
  }

  applyDateFormat(sheet, ["expectedStartDate", "expectedFinishDate", "startDate", "endDate", "createdAt"]);
  for (const key of ["facilitiesEstimatedCost", "facilitiesActualCost"]) {
    sheet.getColumn(key).numFmt = '"€"#,##0.00';
  }
  styleHeaderRow(sheet);
  applyAutoFilter(sheet);

  return workbook.xlsx.writeBuffer();
}

// ─── Single-Project detail export (/api/projects/[id]/export) ──────────────

export interface ProjectDetailExportData {
  title: string;
  description: string | null;
  status: string;
  priority: number;
  origin: "From Request" | "Manual";
  projectRequestTitle: string | null;
  departmentName: string | null;
  businessUnitName: string | null;
  owners: string[];
  audience: string[];
  members: string[];
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  expectedTotalInitialDays: number | null;
  actualTotalDays: number | null;
  startDate: Date | null;
  endDate: Date | null;
  progress: number;
  createdAt: Date;
  // Facilities Services only — see ProjectExportRow's own doc comment.
  facilitiesCompany: string | null;
  facilitiesLocation: string | null;
  facilitiesStartQuarter: ProjectQuarter | null;
  facilitiesStartYear: number | null;
  facilitiesEndQuarter: ProjectQuarter | null;
  facilitiesEndYear: number | null;
  facilitiesCategory: string | null;
  facilitiesEstimatedCost: Prisma.Decimal | number | null;
  facilitiesEstimatedCostNotes: string | null;
  facilitiesActualCost: Prisma.Decimal | number | null;
  facilitiesActualCostNotes: string | null;
  // See ProjectExportRow's own doc comment for why these two are gated on
  // isFacilitiesServicesWorkspace, unlike every other Facilities field.
  isFacilitiesServicesWorkspace: boolean;
  facilitiesPlannedForAnnualTargets: boolean;
  facilitiesIsBigProject: boolean;
  // Project Scoring — see ProjectExportRow's own doc comment above for why
  // these are pre-computed by the caller, never queried here.
  facilitiesProjectImportanceOverall: number | null;
  facilitiesProjectScore: number | null;
  facilitiesImportanceScoreLabel: string | null;
  facilitiesScoreLabel: string | null;
  activities: {
    title: string;
    status: string;
    ownerName: string | null;
    relatedUsers: string[];
    taskTypeName: string | null;
    taskSubTypeName: string | null;
    taskSubTypeCost: Prisma.Decimal | null;
    expectedStartDate: Date | null;
    expectedFinishDate: Date | null;
    expectedDays: number | null;
    actualDays: number | null;
    progress: number | null;
    isCompleted: boolean;
    createdAt: Date;
  }[];
}

function addKeyValueRow(sheet: ExcelJS.Worksheet, label: string, value: string | number | Date | null) {
  const row = sheet.addRow([label, sanitizeCellValue(value) ?? "—"]);
  row.getCell(1).font = { bold: true };
}

export async function buildProjectDetailWorkbook(data: ProjectDetailExportData): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Kinsen IT Helpdesk";
  workbook.created = new Date();

  // ── Sheet 1: Project Details — a plain two-column key/value layout, not
  // a filterable table (there's exactly one Project per export; a header
  // row + autofilter would be meaningless here). ──
  const detailsSheet = workbook.addWorksheet("Project Details");
  detailsSheet.columns = [
    { header: "Field", key: "field", width: 22 },
    { header: "Value", key: "value", width: 50 },
  ];
  detailsSheet.getRow(1).font = { bold: true };
  detailsSheet.getRow(1).fill = HEADER_FILL;
  addKeyValueRow(detailsSheet, "Title", data.title);
  addKeyValueRow(detailsSheet, "Status", data.status);
  addKeyValueRow(detailsSheet, "Priority", PROJECT_PRIORITY_LABEL[data.priority] ?? data.priority);
  addKeyValueRow(detailsSheet, "Origin", data.origin);
  if (data.projectRequestTitle) addKeyValueRow(detailsSheet, "Project Request", data.projectRequestTitle);
  addKeyValueRow(detailsSheet, "Workspace", data.departmentName);
  addKeyValueRow(detailsSheet, "Business Unit", data.businessUnitName);
  addKeyValueRow(detailsSheet, "Owner(s)", data.owners.length > 0 ? data.owners.join(", ") : "—");
  if (data.audience.length > 0) addKeyValueRow(detailsSheet, "Audience", data.audience.join(", "));
  addKeyValueRow(detailsSheet, "Members", data.members.length > 0 ? data.members.join(", ") : "—");
  addKeyValueRow(detailsSheet, "Expected Start", data.expectedStartDate);
  addKeyValueRow(detailsSheet, "Expected Finish", data.expectedFinishDate);
  if (data.expectedTotalInitialDays !== null) addKeyValueRow(detailsSheet, "Expected Total Days", data.expectedTotalInitialDays);
  addKeyValueRow(detailsSheet, "Start Date", data.startDate);
  addKeyValueRow(detailsSheet, "Due Date", data.endDate);
  if (data.actualTotalDays !== null) addKeyValueRow(detailsSheet, "Actual Total Days", data.actualTotalDays);
  // Facilities Services only — Start Date/Due Date above already carry the
  // derived boundary date either way; these add the explicit Quarter
  // label (never shown as if it were a user-entered exact date) and the
  // free-text Company/Location, only when actually set.
  if (data.facilitiesCompany) addKeyValueRow(detailsSheet, "Company", data.facilitiesCompany);
  if (data.facilitiesLocation) addKeyValueRow(detailsSheet, "Location", data.facilitiesLocation);
  if (data.facilitiesCategory) addKeyValueRow(detailsSheet, "Category", data.facilitiesCategory);
  const facilitiesStartQuarterLabel = formatFacilitiesQuarterLabel(data.facilitiesStartQuarter, data.facilitiesStartYear);
  if (facilitiesStartQuarterLabel) addKeyValueRow(detailsSheet, "Start (Quarter)", facilitiesStartQuarterLabel);
  const facilitiesEndQuarterLabel = formatFacilitiesQuarterLabel(data.facilitiesEndQuarter, data.facilitiesEndYear);
  if (facilitiesEndQuarterLabel) addKeyValueRow(detailsSheet, "End (Quarter)", facilitiesEndQuarterLabel);
  // Facilities Costs — directly entered, NEVER the Activity-derived rollup
  // on the Financials sheet below (unrelated, never summed/conflated).
  if (data.facilitiesEstimatedCost !== null) addKeyValueRow(detailsSheet, "Facilities Estimated Cost", decimalToNumber(data.facilitiesEstimatedCost));
  if (data.facilitiesEstimatedCostNotes) addKeyValueRow(detailsSheet, "Facilities Estimated Cost Notes", data.facilitiesEstimatedCostNotes);
  if (data.facilitiesActualCost !== null) addKeyValueRow(detailsSheet, "Facilities Actual Cost", decimalToNumber(data.facilitiesActualCost));
  if (data.facilitiesActualCostNotes) addKeyValueRow(detailsSheet, "Facilities Actual Cost Notes", data.facilitiesActualCostNotes);
  // Plain manual Booleans, never null — shown unconditionally as Yes/No
  // (never hidden for a falsy value, per this feature's own Project
  // Overview display rule) but ONLY while this Project is actually in the
  // Facilities Services workspace — see ProjectExportRow's own doc
  // comment for why these two, unlike every other Facilities field here,
  // are gated on isFacilitiesServicesWorkspace.
  if (data.isFacilitiesServicesWorkspace) {
    addKeyValueRow(detailsSheet, "Planned for This Year's Targets", data.facilitiesPlannedForAnnualTargets ? "Yes" : "No");
    addKeyValueRow(detailsSheet, "Big Project", data.facilitiesIsBigProject ? "Yes" : "No");
    // Project Scoring — always shown (never hidden) within the Facilities
    // Services workspace, each field "Not set" rather than omitted when
    // missing, same convention as the Project Overview page.
    addKeyValueRow(detailsSheet, "Project Importance Overall", data.facilitiesProjectImportanceOverall ?? "Not set");
    addKeyValueRow(detailsSheet, "Project Importance Score", data.facilitiesImportanceScoreLabel ?? "Not set");
    addKeyValueRow(detailsSheet, "Project Score", data.facilitiesProjectScore ?? "Not set");
    addKeyValueRow(detailsSheet, "Score", data.facilitiesScoreLabel ?? "Not set");
  }
  addKeyValueRow(detailsSheet, "Progress (%)", data.progress);
  addKeyValueRow(detailsSheet, "Created", data.createdAt);
  addKeyValueRow(detailsSheet, "Description", data.description);
  for (let r = 2; r <= detailsSheet.rowCount; r++) {
    const fieldName = detailsSheet.getCell(r, 1).value;
    for (const col of ["Expected Start", "Expected Finish", "Start Date", "Due Date", "Created"]) {
      if (fieldName === col) detailsSheet.getCell(r, 2).numFmt = DATE_FORMAT;
    }
    for (const col of ["Facilities Estimated Cost", "Facilities Actual Cost"]) {
      if (fieldName === col) detailsSheet.getCell(r, 2).numFmt = '"€"#,##0.00';
    }
  }

  // ── Sheet 2: Financials — per-Activity cost breakdown (the ONLY source
  // of a Project's Estimated/Actual Cost — see
  // lib/services/project-financials-service.ts's own doc comment: these
  // are fully DERIVED, never a stored Project column), plus a totals row.
  // Reuses computeActivityFinancials per row — the SAME function the
  // Project detail page and GET /api/activities/[id] already use, never a
  // re-derived calculation. ──
  const financialsSheet = workbook.addWorksheet("Financials");
  financialsSheet.columns = [
    { header: "Activity", key: "title", width: 32 },
    { header: "Task Sub Type", key: "taskSubType", width: 22 },
    { header: "Cost / Day (EUR)", key: "costPerDay", width: 16 },
    { header: "Expected Days", key: "expectedDays", width: 14 },
    { header: "Actual Days", key: "actualDays", width: 13 },
    { header: "Estimated Cost (EUR)", key: "estimatedCost", width: 18 },
    { header: "Actual Cost (EUR)", key: "actualCost", width: 16 },
  ];
  let totalEstimated = 0;
  let totalActual = 0;
  // Summed from the SAME data.activities array both sheets below iterate —
  // one Activity contributes to this total exactly once, never re-queried
  // or re-derived per sheet, so Financials and Activities can never
  // disagree or double-count. A null expectedDays/actualDays contributes 0
  // here; the Activity's own row cell stays null/blank, never coerced.
  let totalExpectedDays = 0;
  let totalActualDays = 0;
  for (const a of data.activities) {
    const { estimatedCost, actualCost } = computeActivityFinancials({ taskSubTypeCost: a.taskSubTypeCost, expectedDays: a.expectedDays, actualDays: a.actualDays });
    const estimatedNum = decimalToNumber(estimatedCost);
    const actualNum = decimalToNumber(actualCost);
    totalEstimated += estimatedNum;
    totalActual += actualNum;
    totalExpectedDays += a.expectedDays ?? 0;
    totalActualDays += a.actualDays ?? 0;
    financialsSheet.addRow(
      sanitizeRow({
        title: a.title,
        taskSubType: a.taskSubTypeName ?? "—",
        costPerDay: a.taskSubTypeCost !== null ? decimalToNumber(a.taskSubTypeCost) : null,
        expectedDays: a.expectedDays,
        actualDays: a.actualDays,
        estimatedCost: estimatedNum,
        actualCost: actualNum,
      })
    );
  }
  const financialsLastDataRow = 1 + data.activities.length;
  const totalsRow = financialsSheet.addRow({ title: "TOTAL", estimatedCost: totalEstimated, actualCost: totalActual });
  totalsRow.font = { bold: true };
  setSumTotalCell(financialsSheet, totalsRow.number, "expectedDays", 2, financialsLastDataRow, totalExpectedDays);
  setSumTotalCell(financialsSheet, totalsRow.number, "actualDays", 2, financialsLastDataRow, totalActualDays);
  for (const key of ["costPerDay", "estimatedCost", "actualCost"]) {
    financialsSheet.getColumn(key).numFmt = '"€"#,##0.00';
  }
  styleHeaderRow(financialsSheet);
  if (data.activities.length > 0) applyAutoFilter(financialsSheet);

  // ── Sheet 3: Activities — one row per Activity, full planning metadata. ──
  const activitiesSheet = workbook.addWorksheet("Activities");
  activitiesSheet.columns = [
    { header: "Title", key: "title", width: 32 },
    { header: "Status", key: "status", width: 14 },
    { header: "Completed", key: "isCompleted", width: 11 },
    { header: "Owner", key: "ownerName", width: 22 },
    { header: "Related Users", key: "relatedUsers", width: 30 },
    { header: "Task Type", key: "taskTypeName", width: 18 },
    { header: "Task Sub Type", key: "taskSubTypeName", width: 18 },
    { header: "Expected Start", key: "expectedStartDate", width: 16 },
    { header: "Expected Finish", key: "expectedFinishDate", width: 16 },
    { header: "Expected Days", key: "expectedDays", width: 14 },
    { header: "Actual Days", key: "actualDays", width: 13 },
    { header: "Progress (%)", key: "progress", width: 12 },
    { header: "Created", key: "createdAt", width: 16 },
  ];
  for (const a of data.activities) {
    activitiesSheet.addRow(
      sanitizeRow({
        title: a.title,
        status: humanizeEnum(a.status),
        isCompleted: a.isCompleted ? "Yes" : "No",
        ownerName: a.ownerName ?? "—",
        relatedUsers: a.relatedUsers.length > 0 ? a.relatedUsers.join(", ") : "—",
        taskTypeName: a.taskTypeName ?? "—",
        taskSubTypeName: a.taskSubTypeName ?? "—",
        expectedStartDate: a.expectedStartDate,
        expectedFinishDate: a.expectedFinishDate,
        expectedDays: a.expectedDays,
        actualDays: a.actualDays,
        progress: a.progress,
        createdAt: a.createdAt,
      })
    );
  }
  // Same totalExpectedDays/totalActualDays already summed once above while
  // building the Financials sheet — this is the identical data.activities
  // array, so reusing the figure (rather than summing a second time) is
  // both simpler and a guarantee the two sheets' totals can never drift
  // apart. The SUM formula itself still references THIS sheet's own
  // expectedDays/actualDays columns, not Financials' — each sheet's total
  // is independently verifiable from its own visible rows.
  const activitiesLastDataRow = 1 + data.activities.length;
  const activitiesTotalsRow = activitiesSheet.addRow({ title: "TOTAL" });
  activitiesTotalsRow.font = { bold: true };
  setSumTotalCell(activitiesSheet, activitiesTotalsRow.number, "expectedDays", 2, activitiesLastDataRow, totalExpectedDays);
  setSumTotalCell(activitiesSheet, activitiesTotalsRow.number, "actualDays", 2, activitiesLastDataRow, totalActualDays);
  applyDateFormat(activitiesSheet, ["expectedStartDate", "expectedFinishDate", "createdAt"]);
  styleHeaderRow(activitiesSheet);
  if (data.activities.length > 0) applyAutoFilter(activitiesSheet);

  return workbook.xlsx.writeBuffer();
}
