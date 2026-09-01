/**
 * One-time production-safe legacy TicketApp migration runner.
 *
 * SOURCE: legacy SQL Server (IIS TicketApp — dbo.Users, security.
 * ApplicationUsers, dbo.Tickets, dbo.CommentsTbl, security.FileDataTbl,
 * dbo.Categories, dbo.SubCategories) + the legacy physical attachment
 * directory (E:\www\TicketApp\App_Data\Uploads\TicketFileUpload or a copy
 * of it).
 * TARGET: this repository's current Prisma/PostgreSQL schema, current
 * attachment storage layout, current CustomRole/default-role architecture,
 * current Microsoft-identity-reconciliation invariants — see the
 * lib/services/legacy-migration/* modules this runner orchestrates for the
 * exact source-to-target mapping and the reasoning behind each decision.
 *
 * SAFETY
 *   - DRY RUN BY DEFAULT. Nothing is written to the target database or
 *     filesystem unless --execute is passed on the command line AND
 *     MIGRATION_CONFIRM=I_UNDERSTAND is set in the environment — two
 *     independent, deliberate opt-ins, so simply having source SQL Server
 *     credentials configured (e.g. in a shared .env) can never itself
 *     trigger a write.
 *   - All preflight validation (source connectivity, target department,
 *     physical attachment directory, row-count sanity checks against the
 *     migration brief's proven facts) runs and must pass BEFORE any phase
 *     that could write anything — in both dry-run and --execute mode.
 *   - Prints source/target connection identity (host/port/database/user)
 *     WITHOUT ever printing a password.
 *   - Strongly recommends pausing Microsoft provisioning/sync during the
 *     --execute window (see printMicrosoftSyncPauseGuidance below) to
 *     eliminate races between this migration and a real concurrent
 *     Microsoft login/sync writing the same rows.
 *
 * IDEMPOTENCY / RESUME
 *   Every created User/Ticket/TicketMessage/TicketAttachment is recorded in
 *   MigrationLedger (prisma/schema.prisma) keyed by
 *   (source="TICKETAPP_V1", entityType, legacyKey) — a second --execute run
 *   reuses every already-ledgered target object and creates nothing new for
 *   it. A single failed entity is ledgered FAILED (with its error) and does
 *   NOT abort the run or roll back any other already-committed entity —
 *   every Ticket/Comment/Attachment gets its own short transaction, never
 *   one giant transaction for the whole batch.
 *
 * USAGE
 *   Dry run (default, no writes):
 *     npx tsx scripts/migrate-legacy-ticketapp.ts
 *   Execute (writes to the target database/filesystem):
 *     MIGRATION_CONFIRM=I_UNDERSTAND npx tsx scripts/migrate-legacy-ticketapp.ts --execute
 *
 * See this file's REQUIRED/OPTIONAL environment variable list in
 * loadMigrationConfig() below.
 */
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  loadSqlServerConfigFromEnv,
  describeSqlServerConnection,
  connectSqlServerSource,
  fetchSourceRowCounts,
  fetchLegacyUsers,
  fetchLegacyApplicationUsers,
  fetchLegacyTickets,
  fetchLegacyComments,
  fetchLegacyFileData,
  validateSourceColumnMetadata,
  EXPECTED_SOURCE_COLUMNS,
} from "@/lib/services/legacy-migration/sql-source-client";
import { buildLegacyIdentities, reconcileLegacyUsers } from "@/lib/services/legacy-migration/user-reconciliation";
import { validateTargetDepartment, ensureDepartmentMemberships } from "@/lib/services/legacy-migration/department-preparation";
import { ensureReferenceData } from "@/lib/services/legacy-migration/reference-data";
import { ensureUnknownCreatorPlaceholder } from "@/lib/services/legacy-migration/unknown-creator";
import { importOneLegacyTicket } from "@/lib/services/legacy-migration/ticket-import";
import { importOneLegacyComment } from "@/lib/services/legacy-migration/comment-import";
import { resolveLegacyAttachmentFilenamesById, resolveLegacyAttachmentFilenames } from "@/lib/services/legacy-migration/attachment-filename-resolver";
import { importOneLegacyAttachment, findPhysicalOrphans, findSameTicketFilenameCollisions } from "@/lib/services/legacy-migration/attachment-import";
import { resolveDefaultGlobalRoleAssignment } from "@/lib/services/default-role-service";

const prisma = new PrismaClient();

const EXPECTED = {
  businessUsers: 80,
  applicationUsers: 81,
  tickets: 580,
  expectedMissingCreators: 2,
  expectedUnassignedTickets: 173,
  comments: 6,
  fileDataTotal: 189,
  fileDataLinked: 143,
  fileDataUnlinked: 46,
} as const;

// ─── CLI / config ───────────────────────────────────────────────────────────

interface MigrationConfig {
  execute: boolean;
  targetDepartmentId: string;
  legacyPhysicalDir: string;
  uploadDir: string;
  batchSize: number;
}

function parseArgs(): { execute: boolean } {
  const args = process.argv.slice(2);
  return { execute: args.includes("--execute") };
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function loadMigrationConfig(): MigrationConfig {
  const { execute } = parseArgs();

  if (execute && process.env.MIGRATION_CONFIRM !== "I_UNDERSTAND") {
    throw new Error(
      "\n[SAFETY] --execute requires MIGRATION_CONFIRM=I_UNDERSTAND in the environment as a second, deliberate opt-in.\n" +
        "Example: MIGRATION_CONFIRM=I_UNDERSTAND npx tsx scripts/migrate-legacy-ticketapp.ts --execute\n"
    );
  }

  // Required — the migration refuses to guess a target department from
  // legacy Platform/Category/title data (see TargetDepartmentValidationError,
  // which also fires this same message if the value is present but invalid).
  const targetDepartmentId = requiredEnv("LEGACY_MIGRATION_DEPARTMENT_ID");

  const legacyPhysicalDir = process.env.LEGACY_ATTACHMENT_PHYSICAL_DIR || "E:\\www\\TicketApp\\App_Data\\Uploads\\TicketFileUpload";
  const uploadDir = process.env.UPLOAD_DIR || "./public/uploads";
  const batchSize = Number(process.env.LEGACY_MIGRATION_BATCH_SIZE || 25);

  return { execute, targetDepartmentId, legacyPhysicalDir, uploadDir, batchSize };
}

function printMicrosoftSyncPauseGuidance(execute: boolean) {
  console.log("\n─── Cutover / concurrent-write pause guidance ───");
  if (!execute) {
    console.log("(dry run — no pause needed; nothing is written)");
    return;
  }
  console.log(
    "RECOMMENDED before this --execute run — scoped ONLY to this app, never to\n" +
      "company-wide Microsoft 365/Entra access. Do NOT block Microsoft Entra sign-in\n" +
      "tenant-wide and do NOT disrupt unrelated Microsoft 365/Entra access for the\n" +
      "company — that would affect email, Teams, SharePoint, and every other tenant\n" +
      "app, none of which this migration touches.\n" +
      "  1. Put TicketApp itself into a maintenance/restricted-access window at the\n" +
      "     infra/deployment level for the --execute duration (e.g. a Vercel/host-level\n" +
      "     redirect or access rule for this app only) — this repo has no in-app\n" +
      "     maintenance-mode flag today, so this is an operator action outside the code,\n" +
      "     not something this script can flip.\n" +
      "  2. Do not trigger this app's own admin-only tenant-wide directory sync\n" +
      "     (Admin > Organization > Sync, lib/services/organization-sync-orchestrator.ts)\n" +
      "     during the window — it is manually triggered only, so simply don't click it.\n" +
      "  3. Pause automatic email-to-ticket ingestion for this app only, since it writes\n" +
      "     Ticket/User rows the same way this migration does:\n" +
      "       - Vercel Cron: disable/pause the \"/api/email/inbound\" schedule defined in\n" +
      "         vercel.json (*/2 * * * *) for the --execute window, e.g. via the Vercel\n" +
      "         project's Cron Jobs dashboard, or temporarily unset CRON_SECRET.\n" +
      "       - Docker Compose deployments: stop the `kinsen-helpdesk-email-poller`\n" +
      "         sidecar service for the window (e.g. `docker compose stop\n" +
      "         kinsen-helpdesk-email-poller`), and don't use the admin \"Poll Now\"\n" +
      "         button meanwhile.\n" +
      "  4. Run this migration.\n" +
      "  5. Spot-check the reconciliation report (users/tickets/comments/attachments\n" +
      "     counts, warnings, errors) before resuming normal traffic.\n" +
      "  6. Restore: re-enable the Cron schedule / restart the email-poller sidecar,\n" +
      "     lift the app-level maintenance window. Ordinary Microsoft sign-in\n" +
      "     (lib/auth.config.ts's signIn callback + login-time department sync) was never\n" +
      "     paused and needs no restoration step.\n" +
      "This migration's own writes use the same normalized-email matching and\n" +
      "MANUAL-source membership protection that ordinary login sync relies on\n" +
      "(see department-preparation.ts), so a login happening during the window would\n" +
      "not corrupt data — the pause above is defense in depth, not a hard requirement.\n"
  );
}

// ─── Report ─────────────────────────────────────────────────────────────────

interface MigrationReport {
  mode: "DRY_RUN" | "EXECUTE";
  startedAt: string;
  finishedAt?: string;
  success: boolean;
  sourceCounts: Awaited<ReturnType<typeof fetchSourceRowCounts>> | null;
  users: { sourceBusinessUsers: number; reused: number; created: number; unresolved: number; duplicateEmailGroups: number };
  tickets: {
    sourceTotal: number;
    createdOrReused: number;
    failed: number;
    creatorsPreserved: number;
    creatorsUsingUnknownPlaceholder: number;
    assigneesPreserved: number;
    unassignedTickets: number;
  };
  comments: { sourceTotal: number; createdOrReused: number; failed: number; skippedNoTicket: number; unresolvedAuthors: number };
  attachments: {
    fileDataTotal: number;
    ticketLinked: number;
    unlinkedHistorical: number;
    resolvedPhysically: number;
    createdOrReused: number;
    missingPhysicalFiles: number;
    physicalOrphans: number;
  };
  duplicateTargetObjectsCreated: number;
  warnings: string[];
  errors: string[];
}

function writeReportFile(report: MigrationReport) {
  const reportsDir = path.join(process.cwd(), "reports");
  fsSync.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `legacy-ticketapp-migration-report-${Date.now()}.json`);
  fsSync.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nFull reconciliation report written to: ${reportPath}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const config = loadMigrationConfig();
  const report: MigrationReport = {
    mode: config.execute ? "EXECUTE" : "DRY_RUN",
    startedAt: new Date().toISOString(),
    success: false,
    sourceCounts: null,
    users: { sourceBusinessUsers: 0, reused: 0, created: 0, unresolved: 0, duplicateEmailGroups: 0 },
    tickets: { sourceTotal: 0, createdOrReused: 0, failed: 0, creatorsPreserved: 0, creatorsUsingUnknownPlaceholder: 0, assigneesPreserved: 0, unassignedTickets: 0 },
    comments: { sourceTotal: 0, createdOrReused: 0, failed: 0, skippedNoTicket: 0, unresolvedAuthors: 0 },
    attachments: { fileDataTotal: 0, ticketLinked: 0, unlinkedHistorical: 0, resolvedPhysically: 0, createdOrReused: 0, missingPhysicalFiles: 0, physicalOrphans: 0 },
    duplicateTargetObjectsCreated: 0,
    warnings: [],
    errors: [],
  };

  console.log(`\n=== Legacy TicketApp migration — mode: ${report.mode} ===\n`);

  // ─── Phase 1: Preflight ───────────────────────────────────────────────
  console.log("─── Phase 1: Preflight ───");
  const sqlConfig = loadSqlServerConfigFromEnv();
  console.log(`Source (SQL Server): ${describeSqlServerConnection(sqlConfig)}`);
  console.log(`Target (PostgreSQL via Prisma): ${process.env.DATABASE_URL?.replace(/:[^:@]*@/, ":****@") ?? "(DATABASE_URL not set)"}`);

  const targetDepartment = await validateTargetDepartment(prisma, config.targetDepartmentId);
  console.log(`Target department: ${targetDepartment.name} (${targetDepartment.id})`);

  const dirStat = await fs.stat(config.legacyPhysicalDir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) {
    throw new Error(`LEGACY_ATTACHMENT_PHYSICAL_DIR "${config.legacyPhysicalDir}" does not exist or is not a directory.`);
  }
  console.log(`Legacy physical attachment directory: ${config.legacyPhysicalDir} (confirmed present)`);

  const pool = await connectSqlServerSource(sqlConfig);
  try {
    const columnMismatches = await validateSourceColumnMetadata(pool);
    if (columnMismatches.length > 0) {
      const detail = columnMismatches.map((m) => `${m.table} is missing expected column(s): ${m.missingColumns.join(", ")}`).join("; ");
      throw new Error(
        `[SAFETY] Real source schema does not match this migration's expected column set — refusing to proceed. ${detail}\n` +
          "This means the live SQL Server's schema has drifted from the migration brief's confirmed facts; update lib/services/legacy-migration/sql-source-client.ts (EXPECTED_SOURCE_COLUMNS + the affected fetcher/row type) after re-confirming the real column list, rather than proceeding against an unverified schema."
      );
    }
    console.log(`Source column metadata: verified against INFORMATION_SCHEMA.COLUMNS — all expected columns present on all ${Object.keys(EXPECTED_SOURCE_COLUMNS).length} tables.`);

    const counts = await fetchSourceRowCounts(pool);
    report.sourceCounts = counts;
    console.log("Source row counts:", counts);

    const mismatches: string[] = [];
    if (counts.users !== EXPECTED.businessUsers) mismatches.push(`dbo.Users count is ${counts.users}, expected ${EXPECTED.businessUsers}`);
    if (counts.applicationUsers !== EXPECTED.applicationUsers) mismatches.push(`security.ApplicationUsers count is ${counts.applicationUsers}, expected ${EXPECTED.applicationUsers}`);
    if (counts.tickets !== EXPECTED.tickets) mismatches.push(`dbo.Tickets count is ${counts.tickets}, expected ${EXPECTED.tickets}`);
    if (counts.comments !== EXPECTED.comments) mismatches.push(`dbo.CommentsTbl count is ${counts.comments}, expected ${EXPECTED.comments}`);
    if (counts.fileData !== EXPECTED.fileDataTotal) mismatches.push(`security.FileDataTbl count is ${counts.fileData}, expected ${EXPECTED.fileDataTotal}`);
    if (counts.fileDataLinked !== EXPECTED.fileDataLinked) mismatches.push(`security.FileDataTbl linked count is ${counts.fileDataLinked}, expected ${EXPECTED.fileDataLinked}`);
    for (const m of mismatches) {
      report.warnings.push(`PREFLIGHT COUNT MISMATCH: ${m} (source data may have changed since the migration brief was written — proceeding, but verify this is expected).`);
      console.warn(`  WARNING: ${m}`);
    }

    printMicrosoftSyncPauseGuidance(config.execute);

    // ─── Phase 2: User reconciliation/import ─────────────────────────────
    console.log("\n─── Phase 2: User reconciliation/import ───");
    const [legacyUsers, legacyApplicationUsers] = await Promise.all([fetchLegacyUsers(pool), fetchLegacyApplicationUsers(pool)]);
    const { identities, usersWithNoApplicationUserMatch, applicationUsersWithNoBusinessUserRow } = buildLegacyIdentities(legacyUsers, legacyApplicationUsers);
    report.users.sourceBusinessUsers = legacyUsers.length;

    for (const u of usersWithNoApplicationUserMatch) {
      report.warnings.push(`dbo.Users "${u.UserName}" has no matching security.ApplicationUsers row — unresolved, not migrated.`);
    }
    for (const au of applicationUsersWithNoBusinessUserRow) {
      report.warnings.push(`security.ApplicationUsers "${au.UserName}" has no matching dbo.Users row — informational only, not treated as a business user (e.g. the known "Pavlos Chatzisavvas" account with Email=NULL).`);
    }

    const defaultGlobalRole = await resolveDefaultGlobalRoleAssignment();
    if (!defaultGlobalRole.customRoleId) {
      report.warnings.push(
        "No Default Global Role is configured (Admin > Roles & Permissions > Default Roles) — imported users will fall back to the pre-existing Role.USER/no-custom-role default. Consider configuring one before --execute."
      );
    }

    const userResult = await reconcileLegacyUsers(prisma, identities, defaultGlobalRole, !config.execute);
    report.users.reused = userResult.reused;
    report.users.created = userResult.created;
    report.users.unresolved = userResult.unresolved.length;
    report.users.duplicateEmailGroups = userResult.duplicateNormalizedEmails.length;
    for (const u of userResult.unresolved) report.warnings.push(`User "${u.userName}" unresolved: ${u.reason}`);
    for (const d of userResult.duplicateNormalizedEmails) {
      report.warnings.push(`Duplicate normalized email "${d.normalizedEmail}" shared by legacy UserNames: ${d.userNames.join(", ")} — all resolve to the SAME target user.`);
    }
    console.log(`Users: ${userResult.reused} reused, ${userResult.created} created, ${userResult.unresolved.length} unresolved.`);

    const unknownCreatorUserId = await ensureUnknownCreatorPlaceholder(prisma, !config.execute);

    // ─── Phase 3: department/membership/default-role preparation ─────────
    console.log("\n─── Phase 3: Department membership + default-role preparation ───");
    const allTargetUserIds = [...new Set([...userResult.usernameToUserId.values(), unknownCreatorUserId])];
    const membershipResult = await ensureDepartmentMemberships(prisma, allTargetUserIds, targetDepartment.id, !config.execute);
    console.log(
      `Department memberships: ${membershipResult.grantedAsPrimary} granted as PRIMARY (no prior primary existed), ` +
        `${membershipResult.alreadyPrimaryInTarget} already primary in target (no-op), ` +
        `${membershipResult.addedAsSecondary} added as an ADDITIVE secondary membership (existing primary elsewhere preserved untouched), ` +
        `${membershipResult.secondaryAlreadyPresent} already had some membership in the target department (left untouched).`
    );
    if (membershipResult.addedAsSecondary > 0) {
      report.warnings.push(
        `${membershipResult.addedAsSecondary} migrated user(s) already had a primary department elsewhere — that primary was left completely untouched; they were only granted an ADDITIVE, non-primary membership in the migration target department for access to their imported tickets.`
      );
    }

    // ─── Phase 4: explicit reference-data mapping ─────────────────────────
    console.log("\n─── Phase 4: Reference data (Status/Priority/Category) ───");
    const referenceData = await ensureReferenceData(prisma, targetDepartment.id, !config.execute);
    console.log(`Reference data ready: ${referenceData.statusIdByLegacyStatus.size} statuses, ${referenceData.priorityIdByLegacyPriority.size} priorities, ${referenceData.categoryIdByName.size} categories.`);

    // ─── Phase 5: Ticket import ────────────────────────────────────────────
    console.log("\n─── Phase 5: Ticket import ───");
    const legacyTickets = await fetchLegacyTickets(pool);
    report.tickets.sourceTotal = legacyTickets.length;
    const ticketIdByLegacyTicketId = new Map<number, string>();
    let ticketBatchCount = 0;
    for (const row of legacyTickets) {
      const outcome = await importOneLegacyTicket(prisma, row, {
        targetDepartmentId: targetDepartment.id,
        usernameToUserId: userResult.usernameToUserId,
        referenceData,
        unknownCreatorUserId,
        dryRun: !config.execute,
      });
      if (outcome.status === "failed") {
        report.tickets.failed++;
        report.errors.push(`Ticket ${outcome.legacyTicketId}: ${outcome.error}`);
      } else {
        report.tickets.createdOrReused++;
        if (outcome.targetId) ticketIdByLegacyTicketId.set(outcome.legacyTicketId, outcome.targetId);
        if (outcome.usedUnknownCreator) report.tickets.creatorsUsingUnknownPlaceholder++;
        else report.tickets.creatorsPreserved++;
      }
      ticketBatchCount++;
      if (ticketBatchCount % config.batchSize === 0) console.log(`  ...${ticketBatchCount}/${legacyTickets.length} tickets processed`);
    }
    // Assignee stats computed from the source rows directly (independent of
    // per-ticket success/failure bookkeeping above, so this count is exact
    // regardless of which tickets succeeded).
    report.tickets.unassignedTickets = legacyTickets.filter((t) => !t.Developer?.trim()).length;
    report.tickets.assigneesPreserved = legacyTickets.filter((t) => !!t.Developer?.trim()).length;
    console.log(`Tickets: ${report.tickets.createdOrReused} created/reused, ${report.tickets.failed} failed.`);

    // ─── Phase 6: Comment import ────────────────────────────────────────────
    console.log("\n─── Phase 6: Comment import ───");
    const legacyComments = await fetchLegacyComments(pool);
    report.comments.sourceTotal = legacyComments.length;
    const emailToUserId = new Map<string, string>();
    for (const identity of identities) {
      if (identity.normalizedEmail) {
        const uid = userResult.usernameToUserId.get(identity.userName);
        if (uid) emailToUserId.set(identity.normalizedEmail, uid);
      }
    }
    for (const row of legacyComments) {
      const outcome = await importOneLegacyComment(
        prisma,
        row,
        { usernameToUserId: userResult.usernameToUserId, ticketIdByLegacyTicketId, dryRun: !config.execute },
        emailToUserId
      );
      if (outcome.status === "failed") {
        report.comments.failed++;
        report.errors.push(`Comment ${outcome.legacyCommentId}: ${outcome.error}`);
      } else if (outcome.status === "skipped_no_ticket") {
        report.comments.skippedNoTicket++;
        report.warnings.push(`Comment ${outcome.legacyCommentId}: linked ticket not migrated/found — skipped.`);
      } else {
        report.comments.createdOrReused++;
        if (!outcome.authorResolved) report.comments.unresolvedAuthors++;
      }
    }
    console.log(`Comments: ${report.comments.createdOrReused} created/reused, ${report.comments.failed} failed, ${report.comments.skippedNoTicket} skipped (no ticket).`);

    // ─── Phase 7: Attachment physical resolution + copy/import ───────────
    console.log("\n─── Phase 7: Attachment resolution + import ───");
    const allFileData = await fetchLegacyFileData(pool);
    report.attachments.fileDataTotal = allFileData.length;
    report.attachments.ticketLinked = allFileData.filter((r) => r.Ticket_FileUpload != null).length;
    report.attachments.unlinkedHistorical = allFileData.length - report.attachments.ticketLinked;

    const sameTicketCollisions = findSameTicketFilenameCollisions(allFileData);
    if (sameTicketCollisions.length > 0) {
      for (const c of sameTicketCollisions) {
        report.warnings.push(
          `SAME_TICKET_FILENAME_COLLISION (informational, proven safe): legacy ticket ${c.legacyTicketId} has ${c.fileDataIds.length} FileDataTbl rows (ids: ${c.fileDataIds.join(", ")}) sharing display FileName "${c.fileNameLower}" — each imports as a distinct TicketAttachment (target filename keyed on FileDataTbl.Id, globally unique), original FileName preserved as originalName on each.`
        );
      }
      console.log(`Same-ticket duplicate-filename groups detected: ${sameTicketCollisions.length} (see warnings — proven non-destructive, not blocked).`);
    } else {
      console.log("Same-ticket duplicate-filename preflight: no collisions detected in this source.");
    }

    // Resolve filename ordering over ALL 189 records FIRST (including the 46
    // unlinked ones), THEN filter to ticket-linked records for the actual
    // import loop — see attachment-filename-resolver.ts's header comment.
    const allResolved = resolveLegacyAttachmentFilenames(
      allFileData.map((r) => ({ id: r.Id, fileName: r.FileName, uploadDateTime: r.UploadDateTime }))
    );
    const resolvedById = resolveLegacyAttachmentFilenamesById(
      allFileData.map((r) => ({ id: r.Id, fileName: r.FileName, uploadDateTime: r.UploadDateTime }))
    );
    report.attachments.resolvedPhysically = allResolved.length;

    const linkedFileData = allFileData.filter((r) => r.Ticket_FileUpload != null);
    let attachmentBatchCount = 0;
    for (const row of linkedFileData) {
      const outcome = await importOneLegacyAttachment(prisma, row, {
        legacyPhysicalDir: config.legacyPhysicalDir,
        uploadDir: config.uploadDir,
        ticketIdByLegacyTicketId,
        resolvedFilenames: resolvedById,
        usernameToUserId: userResult.usernameToUserId,
        dryRun: !config.execute,
      });
      if (outcome.status === "failed") {
        report.attachments.missingPhysicalFiles++;
        report.errors.push(`Attachment (FileDataTbl ${outcome.legacyFileId}): ${outcome.error}`);
      } else {
        report.attachments.createdOrReused++;
      }
      attachmentBatchCount++;
      if (attachmentBatchCount % config.batchSize === 0) console.log(`  ...${attachmentBatchCount}/${linkedFileData.length} attachments processed`);
    }

    const orphans = await findPhysicalOrphans(config.legacyPhysicalDir, allResolved).catch((err) => {
      report.warnings.push(`Could not scan for physical orphans: ${err instanceof Error ? err.message : String(err)}`);
      return [] as string[];
    });
    report.attachments.physicalOrphans = orphans.length;
    for (const o of orphans) report.warnings.push(`PHYSICAL_ORPHAN: "${o}" exists on disk with no corresponding FileDataTbl record — reported only, never imported.`);
    console.log(`Attachments: ${report.attachments.createdOrReused} created/reused, ${report.attachments.missingPhysicalFiles} missing-physical-file failures, ${orphans.length} physical orphans.`);

    // ─── Phase 8: Full reconciliation report ──────────────────────────────
    report.success =
      report.tickets.failed === 0 &&
      report.comments.failed === 0 &&
      report.attachments.missingPhysicalFiles === 0 &&
      report.users.unresolved === 0;

    console.log("\n─── Phase 8: Full reconciliation report ───");
    printFinalReport(report);
  } finally {
    await pool.close();
  }

  report.finishedAt = new Date().toISOString();
  writeReportFile(report);
  await prisma.$disconnect();

  if (!report.success) {
    console.error("\nMigration completed WITH ERRORS — see errors[]/warnings[] above and in the report file. NOT reported as a full success.");
    process.exitCode = 1;
  } else {
    console.log(`\nMigration completed successfully in ${report.mode} mode.`);
  }
}

function printFinalReport(report: MigrationReport) {
  console.log(`Mode: ${report.mode}`);
  console.log(`\nUsers — source business users: ${report.users.sourceBusinessUsers} (expected ${EXPECTED.businessUsers})`);
  console.log(`  reused: ${report.users.reused}, created: ${report.users.created}, unresolved/errors: ${report.users.unresolved}, duplicate-email groups: ${report.users.duplicateEmailGroups}`);
  console.log(`\nTickets — source: ${report.tickets.sourceTotal} (expected ${EXPECTED.tickets})`);
  console.log(`  imported/reused: ${report.tickets.createdOrReused}, failed: ${report.tickets.failed}`);
  console.log(`  creators preserved: ${report.tickets.creatorsPreserved}, using Unknown-Creator placeholder: ${report.tickets.creatorsUsingUnknownPlaceholder} (expected ${EXPECTED.expectedMissingCreators})`);
  console.log(`  assignees preserved: ${report.tickets.assigneesPreserved}, unassigned: ${report.tickets.unassignedTickets} (expected ${EXPECTED.expectedUnassignedTickets})`);
  console.log(`\nComments — source: ${report.comments.sourceTotal} (expected ${EXPECTED.comments})`);
  console.log(`  imported/reused: ${report.comments.createdOrReused}, unresolved authors: ${report.comments.unresolvedAuthors}, failed: ${report.comments.failed}`);
  console.log(`\nAttachments — FileDataTbl total: ${report.attachments.fileDataTotal} (expected ${EXPECTED.fileDataTotal})`);
  console.log(`  ticket-linked: ${report.attachments.ticketLinked} (expected ${EXPECTED.fileDataLinked}), unlinked historical: ${report.attachments.unlinkedHistorical} (expected ${EXPECTED.fileDataUnlinked})`);
  console.log(`  resolved physically: ${report.attachments.resolvedPhysically}, imported/reused: ${report.attachments.createdOrReused}`);
  console.log(`  missing physical files: ${report.attachments.missingPhysicalFiles}, physical orphans: ${report.attachments.physicalOrphans}`);
  console.log(`\nDuplicate target objects created: ${report.duplicateTargetObjectsCreated} (must be 0)`);
  console.log(`\nOverall success: ${report.success}`);
}

main().catch(async (error) => {
  console.error("\nMigration failed:", error);
  try {
    await prisma.$disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
