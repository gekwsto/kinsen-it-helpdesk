import fs from "fs";
import path from "path";
import sql from "mssql";
import { PrismaClient, AuthProvider, MessageDirection, Role, TicketHistoryType, TicketSource } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── Types ────────────────────────────────────────────────────────────────────

type LegacyUserRow = {
  UserName: string;
  OldUserId: number | null;
  Company: string | null;
  Name: string | null;
  Email: string | null;
  EmailConfirmed: boolean | null;
  Profile: number | null;
  LockoutEnabled: boolean | null;
};

type LegacyTicketRow = {
  // Explicit aliases set in the SQL query — these names are intentional.
  // legacyTicketId = t.Id (column 1 of legacy source)
  // legacyTitle    = t.Title (column 3 of legacy source)
  // legacyDescription = t.Description (column 4 of legacy source — the original ticket description)
  legacyTicketId: number;
  legacyTitle: string | null;
  legacyDescription: string | null;
  Priority: number | null;
  OpenDate: Date | null;
  LastUpdatedOn: Date | null;
  CancelDate: Date | null;
  CloseDate: Date | null;
  reopenDate: Date | null;
  Status: number | null;
  SubCategory: string | null;
  Categories: string | null;
  IsHiddenComments: boolean | null;
  CancelledReason: number | null;
  CancelText: string | null;
  CancelledBy: string | null;
  Platform: number | null;
  ticketUser: string | null;
  Developer: string | null;
  User: string | null;
  Category: number | null;
};

type LegacyCategoryRow = {
  Id: number;
  Description: string | null;
};

type LegacySubCategoryRow = {
  Id: number;
  Description: string | null;
  Category: number | null;
};

type LegacyCommentRow = {
  Id: number;
  Message: string | null;
  CreatedBy: string | null;
  DateSent: Date | null;
  isPublic: boolean | null;
  isHidden: boolean | null;
  Ticket_Messages: number | null;
};

// ─── Report ───────────────────────────────────────────────────────────────────

type DescriptionSample = {
  ticketNumber: number;
  titlePreview: string;
  legacyDescriptionLength: number;
  targetDescriptionLength: number;
  usedFallback: boolean;
};

type MigrationReport = {
  startedAt: string;
  finishedAt?: string;
  cleanedBeforeImport: boolean;
  users: {
    seen: number;
    createdOrUpdated: number;
    skippedNoEmail: number;
  };
  tickets: {
    seen: number;
    created: number;
    updated: number;
    skipped: number;
    missingRequester: number;
    missingAssignedAgent: number;
  };
  descriptions: {
    legacyNonEmpty: number;
    usedFallback: number;
    legacyExistedButTargetEmpty: number;
    samples: DescriptionSample[];
  };
  comments: {
    seen: number;
    created: number;
    skippedNoTicket: number;
    skippedEmptyBody: number;
    missingAuthor: number;
  };
  categories: {
    createdOrFound: number;
  };
  warnings: string[];
};

const report: MigrationReport = {
  startedAt: new Date().toISOString(),
  cleanedBeforeImport: false,
  users: { seen: 0, createdOrUpdated: 0, skippedNoEmail: 0 },
  tickets: { seen: 0, created: 0, updated: 0, skipped: 0, missingRequester: 0, missingAssignedAgent: 0 },
  descriptions: { legacyNonEmpty: 0, usedFallback: 0, legacyExistedButTargetEmpty: 0, samples: [] },
  comments: { seen: 0, created: 0, skippedNoTicket: 0, skippedEmptyBody: 0, missingAuthor: 0 },
  categories: { createdOrFound: 0 },
  warnings: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function normalizeUsername(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  return cleaned ? cleaned.toLowerCase() : null;
}

function fallbackEmailFromUsername(username: string): string {
  const domain = process.env.LEGACY_FALLBACK_EMAIL_DOMAIN || "legacy.local";
  return `${username.toLowerCase()}@${domain}`;
}

function statusNameFromLegacy(status: number | null): string {
  switch (status) {
    case 0: return "Open";
    case 1: return "In Progress";
    case 2: return "On Hold";
    case 3: return "Closed";
    default: return "Open";
  }
}

function statusIsClosedFromLegacy(status: number | null): boolean {
  return status === 3;
}

function priorityFromLegacy(priority: number | null): { name: string; level: number; color: string } {
  switch (priority) {
    case 0: return { name: "Low", level: 1, color: "#22c55e" };
    case 2: return { name: "High", level: 3, color: "#f97316" };
    case 1:
    default: return { name: "Medium", level: 2, color: "#eab308" };
  }
}

function safeDate(value: Date | null | undefined, fallback = new Date()): Date {
  return value ?? fallback;
}

// ─── Database cleanup ─────────────────────────────────────────────────────────
// Controlled by:
//   MIGRATION_CLEAN_BEFORE_IMPORT=true  → enable cleanup
//   MIGRATION_ALLOW_DB_CLEAN=true       → required in production to allow cleanup

async function cleanDatabase() {
  const isProduction = process.env.NODE_ENV === "production";
  const allowClean = process.env.MIGRATION_ALLOW_DB_CLEAN === "true";

  if (isProduction && !allowClean) {
    throw new Error(
      "\n[SAFETY] Database cleanup is blocked in production.\n" +
      "Set MIGRATION_ALLOW_DB_CLEAN=true to explicitly allow cleanup in production.\n" +
      "WARNING: This will permanently delete all helpdesk/ticket data.\n"
    );
  }

  console.log("Cleaning target database before migration...");
  console.log("  NOTE: Users, Roles, Permissions, and SLA settings are preserved.");
  console.log("  NOTE: SlaPolicy records will be cascade-deleted with TicketPriority.");

  console.log("  Deleting TicketAttachment...");
  await prisma.ticketAttachment.deleteMany({});

  console.log("  Deleting TicketMessage...");
  await prisma.ticketMessage.deleteMany({});

  console.log("  Deleting TicketHistory...");
  await prisma.ticketHistory.deleteMany({});

  console.log("  Deleting Notification...");
  await prisma.notification.deleteMany({});

  console.log("  Deleting Ticket...");
  await prisma.ticket.deleteMany({});

  console.log("  Deleting TicketCategory...");
  await prisma.ticketCategory.deleteMany({});

  // Deleting TicketPriority cascades SlaPolicy (FK onDelete: Cascade).
  // SlaSettings (the enabled/disabled flag) is preserved.
  console.log("  Deleting TicketPriority (cascades SlaPolicy)...");
  await prisma.ticketPriority.deleteMany({});

  console.log("  Deleting TicketStatus...");
  await prisma.ticketStatus.deleteMany({});

  console.log("  Deleting TicketCancelReason...");
  await prisma.ticketCancelReason.deleteMany({});

  report.cleanedBeforeImport = true;
  console.log("Database cleanup complete.\n");
}

// ─── SQL Server connection ────────────────────────────────────────────────────

async function getSqlServerPool() {
  return sql.connect({
    server: requiredEnv("OLD_SQLSERVER_HOST"),
    port: Number(process.env.OLD_SQLSERVER_PORT || 1433),
    database: requiredEnv("OLD_SQLSERVER_DATABASE"),
    user: requiredEnv("OLD_SQLSERVER_USER"),
    password: requiredEnv("OLD_SQLSERVER_PASSWORD"),
    options: {
      encrypt: process.env.OLD_SQLSERVER_ENCRYPT === "true",
      trustServerCertificate: process.env.OLD_SQLSERVER_TRUST_CERT !== "false",
    },
  });
}

// ─── Org bootstrap ────────────────────────────────────────────────────────────

async function ensureDefaultOrg() {
  const companyDomain = process.env.MIGRATION_COMPANY_DOMAIN || "kinsen.gr";
  const companyName = process.env.MIGRATION_COMPANY_NAME || "Kinsen Hellas";
  const businessUnitName = process.env.MIGRATION_BUSINESS_UNIT_NAME || "IT";

  const company = await prisma.company.upsert({
    where: { domain: companyDomain },
    update: { name: companyName },
    create: { name: companyName, domain: companyDomain },
  });

  const existingBusinessUnit = await prisma.businessUnit.findFirst({
    where: { companyId: company.id, name: businessUnitName },
  });

  const businessUnit =
    existingBusinessUnit ??
    (await prisma.businessUnit.create({
      data: { companyId: company.id, name: businessUnitName },
    }));

  return { company, businessUnit };
}

async function ensureFallbackRequester(companyId: string, businessUnitId: string) {
  const fallbackEmail = normalizeEmail(process.env.MIGRATION_FALLBACK_REQUESTER_EMAIL) || "admin@kinsen.gr";
  const fallbackName = process.env.MIGRATION_FALLBACK_REQUESTER_NAME || "Migration Fallback Admin";

  const existing = await prisma.user.findUnique({ where: { email: fallbackEmail } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      email: fallbackEmail,
      name: fallbackName,
      role: Role.ADMIN,
      authProvider: AuthProvider.MICROSOFT,
      isActive: true,
      companyId,
      businessUnitId,
    },
  });
}

// ─── Users ────────────────────────────────────────────────────────────────────

async function loadLegacyUsers(pool: sql.ConnectionPool): Promise<LegacyUserRow[]> {
  const result = await pool.request().query<LegacyUserRow>(`
    SELECT
      u.UserName,
      u.Id AS OldUserId,
      u.Company,
      au.Name,
      au.Email,
      au.EmailConfirmed,
      au.Profile,
      au.LockoutEnabled
    FROM dbo.Users u
    LEFT JOIN security.ApplicationUsers au
      ON au.UserName = u.UserName
    ORDER BY u.UserName
  `);
  return result.recordset;
}

async function migrateUsers(pool: sql.ConnectionPool, companyId: string, businessUnitId: string) {
  const rows = await loadLegacyUsers(pool);
  report.users.seen = rows.length;

  const usernameToUserId = new Map<string, string>();
  const usernameToEmail = new Map<string, string>();

  for (const row of rows) {
    const username = normalizeUsername(row.UserName);
    if (!username) continue;

    const email = normalizeEmail(row.Email) ?? fallbackEmailFromUsername(username);
    const name = cleanText(row.Name) ?? username;

    if (!email) {
      report.users.skippedNoEmail += 1;
      report.warnings.push(`Skipped user ${row.UserName}: no email and no fallback could be generated.`);
      continue;
    }

    const user = await prisma.user.upsert({
      where: { email },
      update: { name, isActive: true, authProvider: AuthProvider.MICROSOFT, companyId, businessUnitId },
      create: { email, name, role: Role.USER, isActive: true, authProvider: AuthProvider.MICROSOFT, companyId, businessUnitId },
    });

    usernameToUserId.set(username, user.id);
    usernameToEmail.set(username, email);
    report.users.createdOrUpdated += 1;
  }

  return { usernameToUserId, usernameToEmail };
}

// ─── Statuses & Priorities ────────────────────────────────────────────────────

// TicketStatus/TicketPriority are fully department-owned now (required
// departmentId, no more global/shared row — see the
// 20260727_retire_global_config migration), so this script creates/reuses
// them scoped to dept-it, matching ensureCategory below and
// prisma/seed.ts's own per-department seeding. find-by-(departmentId, name)
// then create-or-update-by-id reproduces the original find-or-create-by-name
// behavior exactly, without relying on `name` being globally unique at the
// Prisma type level.
const LEGACY_IMPORT_DEPARTMENT_ID = "dept-it";

async function ensureTicketStatuses() {
  const statuses = [0, 1, 2, 3];
  const map = new Map<number, string>();

  for (const legacyStatus of statuses) {
    const name = statusNameFromLegacy(legacyStatus);
    const isClosed = statusIsClosedFromLegacy(legacyStatus);

    const existing = await prisma.ticketStatus.findFirst({ where: { departmentId: LEGACY_IMPORT_DEPARTMENT_ID, name } });
    const status = existing
      ? await prisma.ticketStatus.update({
          where: { id: existing.id },
          data: { isClosed, isActive: true, order: legacyStatus },
        })
      : await prisma.ticketStatus.create({
          data: {
            name,
            color: isClosed ? "#22c55e" : legacyStatus === 1 ? "#3b82f6" : legacyStatus === 2 ? "#f97316" : "#6366f1",
            isDefault: legacyStatus === 0,
            isClosed,
            isActive: true,
            order: legacyStatus,
            departmentId: LEGACY_IMPORT_DEPARTMENT_ID,
          },
        });

    map.set(legacyStatus, status.id);
  }

  return map;
}

async function ensureTicketPriorities() {
  const legacyPriorities = [0, 1, 2];
  const map = new Map<number, string>();

  for (const legacyPriority of legacyPriorities) {
    const p = priorityFromLegacy(legacyPriority);

    const existing = await prisma.ticketPriority.findFirst({ where: { departmentId: LEGACY_IMPORT_DEPARTMENT_ID, name: p.name } });
    const priority = existing
      ? await prisma.ticketPriority.update({
          where: { id: existing.id },
          data: { level: p.level, color: p.color, isActive: true },
        })
      : await prisma.ticketPriority.create({
          data: { name: p.name, level: p.level, color: p.color, isActive: true, departmentId: LEGACY_IMPORT_DEPARTMENT_ID },
        });

    map.set(legacyPriority, priority.id);
  }

  return map;
}

// ─── Categories ───────────────────────────────────────────────────────────────

async function loadLegacyCategoryMaps(pool: sql.ConnectionPool) {
  const categoryRows = await pool.request().query<LegacyCategoryRow>(`
    SELECT Id, Description FROM dbo.Categories
  `);

  const subCategoryRows = await pool.request().query<LegacySubCategoryRow>(`
    SELECT Id, Description, Category FROM dbo.SubCategories
  `);

  const categoryIdToName = new Map<number, string>();
  const subCategoryIdToName = new Map<number, string>();

  for (const row of categoryRows.recordset) {
    const name = cleanText(row.Description);
    if (name) categoryIdToName.set(row.Id, name);
  }

  for (const row of subCategoryRows.recordset) {
    const name = cleanText(row.Description);
    if (name) subCategoryIdToName.set(row.Id, name);
  }

  return { categoryIdToName, subCategoryIdToName };
}

async function ensureCategory(name: string) {
  const cleanedName = cleanText(name) ?? "General";

  // Categories are now department-owned (multi-department architecture,
  // Phase 1). This script imports historical tickets from the legacy
  // IT-only system, so its categories are assigned to the IT department,
  // consistent with how existing NULL-department rows are backfilled
  // elsewhere (see prisma/migrations/20260714120000_.../backfill.sql).
  const category = await prisma.ticketCategory.upsert({
    where: { departmentId_name: { departmentId: "dept-it", name: cleanedName } },
    update: { isActive: true },
    create: { name: cleanedName, color: "#6366f1", isActive: true, departmentId: "dept-it" },
  });

  return category.id;
}

async function resolveCategoryId(
  ticket: LegacyTicketRow,
  categoryIdToName: Map<number, string>,
  subCategoryIdToName: Map<number, string>,
  cache: Map<string, string>
): Promise<string> {
  const textCategory = cleanText(ticket.Categories) || cleanText(ticket.SubCategory);
  let name = textCategory;

  if (!name && ticket.Category != null) {
    name = categoryIdToName.get(ticket.Category) ?? subCategoryIdToName.get(ticket.Category) ?? null;
  }

  if (!name) name = "General";

  const cached = cache.get(name);
  if (cached) return cached;

  const id = await ensureCategory(name);
  cache.set(name, id);
  report.categories.createdOrFound += 1;
  return id;
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

async function loadLegacyTickets(pool: sql.ConnectionPool): Promise<LegacyTicketRow[]> {
  // IMPORTANT: explicit aliases ensure correct field mapping regardless of
  // physical column order in the legacy SQL Server table.
  //   legacyTicketId  = column 1 of legacy source (dbo.Tickets.Id)
  //   legacyTitle     = column 3 of legacy source (dbo.Tickets.Title)
  //   legacyDescription = column 4 of legacy source (dbo.Tickets.Description)
  //                       — this is the ORIGINAL initial ticket description,
  //                         NOT CancelText, NOT comment replies, NOT closing text.
  const result = await pool.request().query<LegacyTicketRow>(`
    SELECT
      t.Id          AS legacyTicketId,
      t.Title       AS legacyTitle,
      t.Description AS legacyDescription,
      t.Priority,
      t.OpenDate,
      t.LastUpdatedOn,
      t.CancelDate,
      t.CloseDate,
      t.reopenDate,
      t.Status,
      t.SubCategory,
      t.Categories,
      t.IsHiddenComments,
      t.CancelledReason,
      t.CancelText,
      t.CancelledBy,
      t.Platform,
      t.ticketUser,
      t.Developer,
      t.[User],
      t.Category
    FROM dbo.Tickets t
    ORDER BY t.Id
  `);

  return result.recordset;
}

async function migrateTickets(
  pool: sql.ConnectionPool,
  usernameToUserId: Map<string, string>,
  fallbackRequesterId: string,
  statusMap: Map<number, string>,
  priorityMap: Map<number, string>,
  categoryIdToName: Map<number, string>,
  subCategoryIdToName: Map<number, string>
) {
  const rows = await loadLegacyTickets(pool);
  report.tickets.seen = rows.length;

  const ticketNumberToNewId = new Map<number, string>();
  const categoryCache = new Map<string, string>();
  const MAX_DESCRIPTION_SAMPLES = 15;

  for (const row of rows) {
    try {
      const requesterUsername = normalizeUsername(row.User) ?? normalizeUsername(row.ticketUser);
      const requesterId = requesterUsername ? usernameToUserId.get(requesterUsername) : undefined;

      let finalRequesterId = requesterId;
      if (!finalRequesterId) {
        finalRequesterId = fallbackRequesterId;
        report.tickets.missingRequester += 1;
        report.warnings.push(`Ticket ${row.legacyTicketId}: requester '${requesterUsername ?? "NULL"}' not found. Used fallback requester.`);
      }

      const developerUsername = normalizeUsername(row.Developer);
      const assignedAgentId = developerUsername ? usernameToUserId.get(developerUsername) ?? null : null;
      if (developerUsername && !assignedAgentId) {
        report.tickets.missingAssignedAgent += 1;
        report.warnings.push(`Ticket ${row.legacyTicketId}: assigned agent '${developerUsername}' not found. Left unassigned.`);
      }

      const legacyStatus = row.Status ?? 0;
      const legacyPriority = row.Priority ?? 1;
      const statusId = statusMap.get(legacyStatus) ?? statusMap.get(0)!;
      const priorityId = priorityMap.get(legacyPriority) ?? priorityMap.get(1)!;
      const categoryId = await resolveCategoryId(row, categoryIdToName, subCategoryIdToName, categoryCache);

      const createdAt = safeDate(row.OpenDate);
      const updatedAt = safeDate(row.LastUpdatedOn, createdAt);
      const closedAt = row.CloseDate ?? row.CancelDate ?? null;

      const title = cleanText(row.legacyTitle) ?? `Migrated ticket ${row.legacyTicketId}`;

      // Description comes from t.Description (column 4 of the legacy source).
      // Do NOT use CancelText, comment replies, or closing text here.
      const rawLegacyDescription = cleanText(row.legacyDescription);
      const usedFallback = !rawLegacyDescription;
      const description = rawLegacyDescription ?? "No description provided.";

      // Track description migration stats
      if (rawLegacyDescription) {
        report.descriptions.legacyNonEmpty += 1;
      } else {
        report.descriptions.usedFallback += 1;
      }

      // Collect samples for verification (first N tickets)
      if (report.descriptions.samples.length < MAX_DESCRIPTION_SAMPLES) {
        report.descriptions.samples.push({
          ticketNumber: row.legacyTicketId,
          titlePreview: title.slice(0, 60),
          legacyDescriptionLength: rawLegacyDescription?.length ?? 0,
          targetDescriptionLength: description.length,
          usedFallback,
        });
      }

      const existing = await prisma.ticket.findUnique({
        where: { ticketNumber: row.legacyTicketId },
        select: { id: true, description: true },
      });

      const data = {
        title,
        description,
        source: TicketSource.WEB,
        requesterId: finalRequesterId,
        assignedAgentId,
        statusId,
        priorityId,
        categoryId,
        departmentId: null,
        projectId: null,
        activityId: null,
        closedAt,
        createdAt,
        updatedAt,
      };

      const ticket = existing
        ? await prisma.ticket.update({ where: { id: existing.id }, data })
        : await prisma.ticket.create({ data: { ...data, ticketNumber: row.legacyTicketId } });

      // Verify: if legacy had a description but the target description ended up
      // empty or fallback after update, flag it.
      if (rawLegacyDescription && ticket.description === "No description provided.") {
        report.descriptions.legacyExistedButTargetEmpty += 1;
        report.warnings.push(`Ticket ${row.legacyTicketId}: legacy description existed but target has fallback value.`);
      }

      ticketNumberToNewId.set(row.legacyTicketId, ticket.id);

      if (existing) {
        report.tickets.updated += 1;
      } else {
        report.tickets.created += 1;
      }

      if (row.CancelText || row.CancelledReason || row.CancelledBy) {
        await prisma.ticketHistory.create({
          data: {
            ticketId: ticket.id,
            changedById: row.CancelledBy
              ? usernameToUserId.get(normalizeUsername(row.CancelledBy) ?? "") ?? null
              : null,
            type: TicketHistoryType.CANCEL_REASON_SET,
            oldValue: null,
            newValue: row.CancelText ?? String(row.CancelledReason ?? ""),
            description: `Legacy cancel info. Reason: ${row.CancelledReason ?? "N/A"}. Text: ${row.CancelText ?? "N/A"}`,
            createdAt: row.CancelDate ?? updatedAt,
          },
        });
      }
    } catch (error) {
      report.tickets.skipped += 1;
      report.warnings.push(
        `Ticket ${row.legacyTicketId}: skipped due to error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return ticketNumberToNewId;
}

// ─── Comments ─────────────────────────────────────────────────────────────────

async function loadLegacyComments(pool: sql.ConnectionPool): Promise<LegacyCommentRow[]> {
  const result = await pool.request().query<LegacyCommentRow>(`
    SELECT
      Id,
      Message,
      CreatedBy,
      DateSent,
      isPublic,
      isHidden,
      Ticket_Messages
    FROM dbo.CommentsTbl
    ORDER BY Id
  `);
  return result.recordset;
}

async function migrateComments(
  pool: sql.ConnectionPool,
  usernameToUserId: Map<string, string>,
  ticketNumberToNewId: Map<number, string>
) {
  const rows = await loadLegacyComments(pool);
  report.comments.seen = rows.length;

  for (const row of rows) {
    const body = cleanText(row.Message);
    if (!body) {
      report.comments.skippedEmptyBody += 1;
      continue;
    }

    if (!row.Ticket_Messages) {
      report.comments.skippedNoTicket += 1;
      report.warnings.push(`Comment ${row.Id}: no Ticket_Messages value.`);
      continue;
    }

    const ticketId = ticketNumberToNewId.get(row.Ticket_Messages);
    if (!ticketId) {
      report.comments.skippedNoTicket += 1;
      report.warnings.push(`Comment ${row.Id}: ticket ${row.Ticket_Messages} was not migrated or not found.`);
      continue;
    }

    const authorUsername = normalizeUsername(row.CreatedBy);
    const authorId = authorUsername ? usernameToUserId.get(authorUsername) ?? null : null;
    if (authorUsername && !authorId) {
      report.comments.missingAuthor += 1;
      report.warnings.push(`Comment ${row.Id}: author '${authorUsername}' not found.`);
    }

    const isInternal = row.isHidden === true || row.isPublic === false;
    const direction = isInternal ? MessageDirection.INTERNAL_NOTE : MessageDirection.OUTBOUND;

    // Idempotency: use a legacy marker embedded in the body.
    // Comments that were migrated in a previous run will be skipped.
    const legacyMarker = `[legacy-comment-id:${row.Id}]`;
    const existing = await prisma.ticketMessage.findFirst({
      where: { ticketId, body: { contains: legacyMarker } },
      select: { id: true },
    });

    if (existing) continue;

    await prisma.ticketMessage.create({
      data: {
        ticketId,
        authorId,
        body: `${body}\n\n${legacyMarker}`,
        direction,
        isInternal,
        createdAt: safeDate(row.DateSent),
        updatedAt: safeDate(row.DateSent),
      },
    });

    await prisma.ticketHistory.create({
      data: {
        ticketId,
        changedById: authorId,
        type: TicketHistoryType.COMMENT_ADDED,
        description: `Legacy comment ${row.Id} migrated.`,
        createdAt: safeDate(row.DateSent),
      },
    });

    report.comments.created += 1;
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

function writeReport() {
  report.finishedAt = new Date().toISOString();
  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const reportPath = path.join(reportsDir, `legacy-phase1-migration-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`Migration report written to: ${reportPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ─── Environment variables ──────────────────────────────────────────────────
  // MIGRATION_CLEAN_BEFORE_IMPORT=true  → clean the target DB before importing
  // MIGRATION_ALLOW_DB_CLEAN=true       → required in production to allow cleanup
  const cleanBeforeImport = process.env.MIGRATION_CLEAN_BEFORE_IMPORT === "true";

  // ─── Optional cleanup ───────────────────────────────────────────────────────
  if (cleanBeforeImport) {
    await cleanDatabase();
  } else {
    console.log("Skipping database cleanup. Set MIGRATION_CLEAN_BEFORE_IMPORT=true to enable.");
  }

  console.log("Connecting to old SQL Server...");
  const pool = await getSqlServerPool();

  try {
    console.log("Ensuring default organisation...");
    const { company, businessUnit } = await ensureDefaultOrg();
    const fallbackRequester = await ensureFallbackRequester(company.id, businessUnit.id);

    console.log("Migrating users...");
    const { usernameToUserId } = await migrateUsers(pool, company.id, businessUnit.id);

    console.log("Ensuring statuses and priorities...");
    const statusMap = await ensureTicketStatuses();
    const priorityMap = await ensureTicketPriorities();

    console.log("Loading legacy category maps...");
    const { categoryIdToName, subCategoryIdToName } = await loadLegacyCategoryMaps(pool);

    console.log("Migrating tickets...");
    const ticketNumberToNewId = await migrateTickets(
      pool,
      usernameToUserId,
      fallbackRequester.id,
      statusMap,
      priorityMap,
      categoryIdToName,
      subCategoryIdToName
    );

    console.log("Migrating comments...");
    await migrateComments(pool, usernameToUserId, ticketNumberToNewId);

    console.log("\nPhase 1 migration completed.");
    console.log(JSON.stringify({
      ...report,
      "descriptions.samples": `${report.descriptions.samples.length} samples — see report file`,
    }, null, 2));

    // Description summary
    console.log("\n─── Description Migration Summary ───");
    console.log(`  Legacy tickets with non-empty description : ${report.descriptions.legacyNonEmpty}`);
    console.log(`  Tickets using fallback description        : ${report.descriptions.usedFallback}`);
    console.log(`  Legacy had desc but target is fallback    : ${report.descriptions.legacyExistedButTargetEmpty}`);
    console.log(`  Sample checks (first ${report.descriptions.samples.length} tickets):`);
    for (const s of report.descriptions.samples) {
      console.log(
        `    #${s.ticketNumber} "${s.titlePreview}" — ` +
        `legacy len=${s.legacyDescriptionLength} target len=${s.targetDescriptionLength}` +
        (s.usedFallback ? " [FALLBACK]" : "")
      );
    }
  } finally {
    await pool.close();
    await prisma.$disconnect();
    writeReport();
  }
}

main().catch(async (error) => {
  console.error("Migration failed:", error);
  report.warnings.push(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  await prisma.$disconnect();
  writeReport();
  process.exit(1);
});
