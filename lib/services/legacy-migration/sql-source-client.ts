/**
 * Read-only SQL Server source connection + typed row fetchers for the
 * legacy TicketApp migration. Every query here is a plain SELECT — this
 * module never writes to the source database, and the connection is opened
 * with the credentials the operator supplies (no assumption they carry
 * write permission at all).
 *
 * Deliberately thin: each fetch function does exactly one `pool.request()
 * .query(...)` and returns typed rows, nothing else — all reconciliation/
 * import LOGIC lives in sibling modules that accept already-fetched row
 * arrays, so that logic is unit-testable without a live SQL Server
 * connection (see scripts/test-legacy-migration-*.ts, none of which touch
 * `mssql` at all).
 */
import sql from "mssql";

export interface SqlServerConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

export function loadSqlServerConfigFromEnv(): SqlServerConnectionConfig {
  const missing: string[] = [];
  const get = (name: string) => {
    const v = process.env[name];
    if (!v || v.trim() === "") missing.push(name);
    return v ?? "";
  };
  const host = get("OLD_SQLSERVER_HOST");
  const database = get("OLD_SQLSERVER_DATABASE");
  const user = get("OLD_SQLSERVER_USER");
  const password = get("OLD_SQLSERVER_PASSWORD");
  if (missing.length > 0) {
    throw new Error(`Missing required legacy source environment variable(s): ${missing.join(", ")}`);
  }
  return {
    host,
    port: Number(process.env.OLD_SQLSERVER_PORT || 1433),
    database,
    user,
    password,
    encrypt: process.env.OLD_SQLSERVER_ENCRYPT === "true",
    trustServerCertificate: process.env.OLD_SQLSERVER_TRUST_CERT !== "false",
  };
}

/** Safe-to-print connection identity — host/port/database/user, NEVER the password. Printed during preflight so an operator can visually confirm they're pointed at the right source before anything runs. */
export function describeSqlServerConnection(config: SqlServerConnectionConfig): string {
  return `${config.user}@${config.host}:${config.port}/${config.database} (encrypt=${config.encrypt}, trustServerCertificate=${config.trustServerCertificate})`;
}

export async function connectSqlServerSource(config: SqlServerConnectionConfig): Promise<sql.ConnectionPool> {
  return sql.connect({
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    options: { encrypt: config.encrypt, trustServerCertificate: config.trustServerCertificate },
  });
}

// ─── Row shapes ─────────────────────────────────────────────────────────────

export interface LegacyUserRow {
  UserName: string;
  Id: number;
}

export interface LegacyApplicationUserRow {
  UserName: string;
  Email: string | null;
  /** Display name, when present — used only as a fallback for target User.name when dbo.Users has none of its own; NEVER used for identity matching (see user-reconciliation.ts's header comment: matching is by UserName/email only). */
  Name: string | null;
}

export interface LegacyTicketRow {
  Id: number;
  Title: string | null;
  Description: string | null;
  Priority: number | null;
  Status: number | null;
  Platform: number | null;
  /** The parent legacy Category id (1/2/201) — NOT a subcategory id. See enum-maps.ts's Category/SubCategory header comment. */
  Category: number | null;
  /** Free-text subcategory description as typed on the ticket (e.g. "New Feature", "Bug/Error") — matched against the explicit LEGACY_CATEGORY_SUBCATEGORY_TEXT_MAP, never parsed as a numeric id. */
  SubCategory: string | null;
  User: string | null;
  Developer: string | null;
  OpenDate: Date | null;
  LastUpdatedOn: Date | null;
  CloseDate: Date | null;
  CancelDate: Date | null;
  reopenDate: Date | null;
  CancelText: string | null;
  CancelledReason: number | null;
  CancelledBy: string | null;
}

/**
 * Confirmed real dbo.CommentsTbl columns: Id, Message, CreatedBy, DateSent,
 * isPublic, Liked, isLeft, isHidden, Ticket_Messages. Liked/isLeft are
 * fetched by neither this row type nor the SELECT below — they have no
 * target TicketMessage concept (a "like" count / a "left the conversation"
 * flag) and nothing in the migration brief asks for them to be preserved;
 * deliberately, not an oversight.
 */
export interface LegacyCommentRow {
  Id: number;
  Message: string | null;
  CreatedBy: string | null;
  DateSent: Date | null;
  isPublic: boolean | null;
  isHidden: boolean | null;
  Ticket_Messages: number | null;
}

/**
 * Confirmed real security.FileDataTbl columns: Id, FileName, FolderPath,
 * Blob, StorageMedium, UploadedBy, UploadDateTime, Description,
 * Ticket_FileUpload. Blob is proven NULL for all records (physical storage
 * only) and is not fetched. UploadedBy (legacy UserName, resolved via the
 * same LegacyUser map as everything else) -> target TicketAttachment.
 * uploadedById. Description has NO target TicketAttachment column (that
 * model has none) — preserved instead in the initial ATTACHMENT_ADDED
 * TicketHistory entry's own description text (see attachment-import.ts),
 * the same "use an existing mechanism, don't invent a column" pattern
 * already used for legacy Platform/CancelDate/reopenDate on tickets.
 */
export interface LegacyFileDataRow {
  Id: number;
  FileName: string;
  UploadDateTime: Date;
  Ticket_FileUpload: number | null;
  StorageMedium: number | null;
  FolderPath: string | null;
  UploadedBy: string | null;
  Description: string | null;
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

export async function fetchLegacyUsers(pool: sql.ConnectionPool): Promise<LegacyUserRow[]> {
  const result = await pool.request().query<LegacyUserRow>(`
    SELECT UserName, Id FROM dbo.Users ORDER BY UserName
  `);
  return result.recordset;
}

export async function fetchLegacyApplicationUsers(pool: sql.ConnectionPool): Promise<LegacyApplicationUserRow[]> {
  const result = await pool.request().query<LegacyApplicationUserRow>(`
    SELECT UserName, Email, Name FROM security.ApplicationUsers ORDER BY UserName
  `);
  return result.recordset;
}

export async function fetchLegacyTickets(pool: sql.ConnectionPool): Promise<LegacyTicketRow[]> {
  const result = await pool.request().query<LegacyTicketRow>(`
    SELECT
      t.Id, t.Title, t.Description, t.Priority, t.Status, t.Platform, t.Category, t.SubCategory,
      t.[User], t.Developer,
      t.OpenDate, t.LastUpdatedOn, t.CloseDate, t.CancelDate, t.reopenDate,
      t.CancelText, t.CancelledReason, t.CancelledBy
    FROM dbo.Tickets t
    ORDER BY t.Id
  `);
  return result.recordset;
}

export async function fetchLegacyComments(pool: sql.ConnectionPool): Promise<LegacyCommentRow[]> {
  const result = await pool.request().query<LegacyCommentRow>(`
    SELECT Id, Message, CreatedBy, DateSent, isPublic, isHidden, Ticket_Messages
    FROM dbo.CommentsTbl
    ORDER BY Id
  `);
  return result.recordset;
}

/** ALL FileDataTbl rows — including the 46 with Ticket_FileUpload IS NULL. Never filter here; filtering to ticket-linked rows happens only after filename resolution (see attachment-filename-resolver.ts's header comment). */
export async function fetchLegacyFileData(pool: sql.ConnectionPool): Promise<LegacyFileDataRow[]> {
  const result = await pool.request().query<LegacyFileDataRow>(`
    SELECT Id, FileName, UploadDateTime, Ticket_FileUpload, StorageMedium, FolderPath, UploadedBy, Description
    FROM security.FileDataTbl
    ORDER BY Id
  `);
  return result.recordset;
}

export interface SourceRowCounts {
  users: number;
  applicationUsers: number;
  tickets: number;
  comments: number;
  fileData: number;
  fileDataLinked: number;
  fileDataUnlinked: number;
}

/** Cheap COUNT(*) preflight — compared against the migration brief's proven facts before anything else runs. */
export async function fetchSourceRowCounts(pool: sql.ConnectionPool): Promise<SourceRowCounts> {
  const query = async (sqlText: string) => (await pool.request().query<{ n: number }>(sqlText)).recordset[0].n;
  const [users, applicationUsers, tickets, comments, fileData, fileDataLinked] = await Promise.all([
    query(`SELECT COUNT(*) AS n FROM dbo.Users`),
    query(`SELECT COUNT(*) AS n FROM security.ApplicationUsers`),
    query(`SELECT COUNT(*) AS n FROM dbo.Tickets`),
    query(`SELECT COUNT(*) AS n FROM dbo.CommentsTbl`),
    query(`SELECT COUNT(*) AS n FROM security.FileDataTbl`),
    query(`SELECT COUNT(*) AS n FROM security.FileDataTbl WHERE Ticket_FileUpload IS NOT NULL`),
  ]);
  return { users, applicationUsers, tickets, comments, fileData, fileDataLinked, fileDataUnlinked: fileData - fileDataLinked };
}

// ─── Real-source column metadata preflight ────────────────────────────────

/** The exact column sets this module's fetchers rely on, confirmed against the real source schema — used to validate the REAL SQL Server's actual metadata before any query runs against it, rather than only discovering a schema drift as a confusing runtime query error mid-migration. */
export const EXPECTED_SOURCE_COLUMNS: Record<string, string[]> = {
  "dbo.Users": ["UserName", "Id"],
  "security.ApplicationUsers": ["UserName", "Email", "Name"],
  "dbo.Tickets": [
    "Id", "Title", "Description", "Priority", "Status", "Platform", "Category", "SubCategory",
    "User", "Developer", "OpenDate", "LastUpdatedOn", "CloseDate", "CancelDate", "reopenDate",
    "CancelText", "CancelledReason", "CancelledBy",
  ],
  "dbo.CommentsTbl": ["Id", "Message", "CreatedBy", "DateSent", "isPublic", "isHidden", "Ticket_Messages"],
  "security.FileDataTbl": ["Id", "FileName", "UploadDateTime", "Ticket_FileUpload", "StorageMedium", "FolderPath", "UploadedBy", "Description"],
};

export interface ColumnMetadataMismatch {
  table: string;
  missingColumns: string[];
}

/**
 * Validates the REAL connected SQL Server's actual column metadata
 * (INFORMATION_SCHEMA.COLUMNS) against EXPECTED_SOURCE_COLUMNS — run once,
 * during Phase 1 preflight, before any fetcher above executes. A missing
 * expected column is reported per-table (never silently ignored, and never
 * discovered only via a confusing runtime "invalid column name" query
 * error partway through a later phase). Extra/unexpected columns on a table
 * are NOT an error — the source schema is allowed to have more than this
 * migration needs.
 */
export async function validateSourceColumnMetadata(pool: sql.ConnectionPool): Promise<ColumnMetadataMismatch[]> {
  const mismatches: ColumnMetadataMismatch[] = [];
  for (const [qualifiedTable, expectedColumns] of Object.entries(EXPECTED_SOURCE_COLUMNS)) {
    const [schemaName, tableName] = qualifiedTable.split(".");
    const result = await pool.request().query<{ COLUMN_NAME: string }>(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${schemaName}' AND TABLE_NAME = '${tableName}'
    `);
    const actualColumns = new Set(result.recordset.map((r) => r.COLUMN_NAME));
    const missingColumns = expectedColumns.filter((c) => !actualColumns.has(c));
    if (missingColumns.length > 0) {
      mismatches.push({ table: qualifiedTable, missingColumns });
    }
  }
  return mismatches;
}
