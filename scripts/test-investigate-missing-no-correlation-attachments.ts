/**
 * Focused regression for scripts/investigate-missing-no-correlation-attachments.ts.
 * No Graph mocking is needed or used — the script under test never imports
 * @/lib/microsoft-graph at all (confirmed by grep in the review this test
 * accompanies), so there is nothing to mock. UPLOAD_DIR/LEGACY_PUBLIC_UPLOAD_DIR
 * are sandboxed to throwaway OS-temp directories (process.env set BEFORE
 * any dynamic import touches them), same convention as the other focused
 * tests in this suite.
 *
 * Proves:
 *   A. A row with email correlation is excluded from the report entirely
 *      (out of scope for this tool).
 *   B. A row whose file is already present locally is excluded entirely.
 *   C. An exact filename+size match in the LEGACY location is classified
 *      "exact_filename_and_size_match".
 *   D. A same-size, different-name file is classified "size_only_match"
 *      — never conflated with a real match.
 *   E. A same-originalName-fragment, wrong-size file is classified
 *      "filename_only_match" — never treated as a usable candidate.
 *   F. --extra-path finds a candidate that exists ONLY in an
 *      operator-supplied directory, not in either canonical location.
 *   G. --scan-whole-upload-tree finds a candidate sitting in a DIFFERENT
 *      ticket's own directory only when explicitly enabled — absent by
 *      default.
 *   H. ticketHasAnyEmailReply correctly reflects a genuine TicketMessage
 *      with a non-null emailMessageId on the ticket.
 *   I. A row for which NO candidate exists in any searched location is
 *      still fully reported (never silently dropped) — with an empty
 *      candidates array and a non-empty searchedLocations list, so "not
 *      found" is distinguishable from "never checked."
 *   J. A ticket's own UPLOAD_DIR directory that is actually a SYMLINK
 *      pointing outside UPLOAD_DIR is never followed — a file sitting at
 *      the symlink's target that would otherwise look like a perfect
 *      exact-filename-and-size match is never reported as a candidate,
 *      and never appears in searchedLocations.
 *
 * Usage: npx tsx scripts/test-investigate-missing-no-correlation-attachments.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import os from "os";
import path from "path";
import fs from "fs/promises";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const TAG = `ginvestigate-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);
const TEMP_EXTRA_DIR = path.join(os.tmpdir(), `${TAG}-extra-backup`);

async function main() {
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  // LEGACY_PUBLIC_UPLOAD_DIR is a hardcoded constant ("./public/uploads"),
  // never read from an env var (see lib/attachment-policy.ts's own doc
  // comment) — so this test cannot sandbox it the same way it sandboxes
  // UPLOAD_DIR. Scenario C below uses --extra-path as an honest stand-in
  // for "a second canonical-style location," since the matching/search
  // logic treats every searched directory identically regardless of which
  // constant named it.
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  await fs.mkdir(TEMP_EXTRA_DIR, { recursive: true });

  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, TicketSource } = await import("@prisma/client");
  const { investigateMissingNoCorrelationAttachments } = await import("@/scripts/investigate-missing-no-correlation-attachments");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const attachmentIds: string[] = [];

  let dept: Awaited<ReturnType<typeof createDepartment>>;
  let user: Awaited<ReturnType<typeof prisma.user.create>>;

  async function makeTicket(title: string, emailMessageId: string | null) {
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const ticket = await prisma.ticket.create({
      data: { title, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id, emailMessageId },
    });
    ticketIds.push(ticket.id);
    return ticket;
  }
  async function makeAttachment(ticketId: string, originalName: string, filename: string, size: number) {
    const attachment = await prisma.ticketAttachment.create({
      data: { ticketId, uploadedById: user.id, filename, originalName, mimeType: "image/png", size, path: "/x" },
    });
    attachmentIds.push(attachment.id);
    return attachment;
  }

  try {
    dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    userIds.push(user.id);

    // ── A — a row WITH email correlation is excluded entirely. ───────────
    const ticketWithEmail = await makeTicket(`${TAG} with-email`, `<${TAG}-has-email@example.com>`);
    const attWithEmail = await makeAttachment(ticketWithEmail.id, "has-email.png", `${TAG}-has-email.bin`, 10);

    // ── B — a row whose file is already present is excluded entirely. ────
    const ticketPresent = await makeTicket(`${TAG} present`, null);
    const attPresent = await makeAttachment(ticketPresent.id, "present.png", `${TAG}-present.bin`, 11);
    await fs.mkdir(path.join(TEMP_UPLOAD_DIR, ticketPresent.id), { recursive: true });
    await fs.writeFile(path.join(TEMP_UPLOAD_DIR, ticketPresent.id, attPresent.filename), "x");

    // ── C — exact filename+size match (simulated "legacy" location, using
    //    an --extra-path-equivalent since LEGACY_PUBLIC_UPLOAD_DIR is a
    //    hardcoded constant this test cannot redirect). ───────────────────
    const ticketC = await makeTicket(`${TAG} exact-match`, null);
    const attC = await makeAttachment(ticketC.id, "exact.png", `${TAG}-exact.bin`, 42);
    await fs.writeFile(path.join(TEMP_EXTRA_DIR, attC.filename), Buffer.alloc(42));

    // ── D — same size, different name — must be size_only_match, never a
    //    stronger classification. ─────────────────────────────────────────
    const ticketD = await makeTicket(`${TAG} size-only`, null);
    const attD = await makeAttachment(ticketD.id, "sizeonly.png", `${TAG}-sizeonly.bin`, 77);
    await fs.writeFile(path.join(TEMP_EXTRA_DIR, "completely-unrelated-name.dat"), Buffer.alloc(77));

    // ── E — name fragment matches, wrong size — filename_only_match. ─────
    const ticketE = await makeTicket(`${TAG} filename-only`, null);
    const attE = await makeAttachment(ticketE.id, "filenameonly.png", `${TAG}-filenameonly.bin`, 88);
    await fs.writeFile(path.join(TEMP_EXTRA_DIR, "old-filenameonly.png"), Buffer.alloc(999));

    // ── G setup — a candidate sitting in a DIFFERENT ticket's own
    //    directory under UPLOAD_DIR, only found with --scan-whole-upload-tree. ─
    const ticketG = await makeTicket(`${TAG} whole-tree`, null);
    const attG = await makeAttachment(ticketG.id, "wholetree.png", `${TAG}-wholetree.bin`, 55);
    const otherTicketDir = path.join(TEMP_UPLOAD_DIR, `${TAG}-other-ticket-dir`);
    await fs.mkdir(otherTicketDir, { recursive: true });
    await fs.writeFile(path.join(otherTicketDir, attG.filename), Buffer.alloc(55));

    // ── H — ticketHasAnyEmailReply reflects a genuine TicketMessage with a
    //    non-null emailMessageId, even though the TICKET itself has none. ─
    const ticketH = await makeTicket(`${TAG} had-reply`, null);
    const attH = await makeAttachment(ticketH.id, "hadreply.png", `${TAG}-hadreply.bin`, 99);
    await prisma.ticketMessage.create({ data: { ticketId: ticketH.id, authorId: user.id, body: "a real reply", direction: "INBOUND", emailMessageId: `<${TAG}-reply@example.com>`, fromEmail: "x@example.com", fromName: "X" } });

    // ── I — a row with NO candidate anywhere must still be fully reported,
    //    never silently dropped, with searchedLocations non-empty. ────────
    const ticketI = await makeTicket(`${TAG} no-candidate`, null);
    const attI = await makeAttachment(ticketI.id, "nocandidate.png", `${TAG}-nocandidate.bin`, 1234);
    // Deliberately: no file written anywhere matching this row at all.

    // ── J — a ticket's own UPLOAD_DIR directory that is actually a SYMLINK
    //    to somewhere OUTSIDE UPLOAD_DIR must never be followed, even
    //    though the target holds a file that would otherwise look like a
    //    perfect exact-filename-and-size match. ────────────────────────────
    const ticketJ = await makeTicket(`${TAG} symlink-escape`, null);
    const attJ = await makeAttachment(ticketJ.id, "symlink.png", `${TAG}-symlink.bin`, 321);
    const secretOutsideDir = path.join(os.tmpdir(), `${TAG}-secret-outside`);
    await fs.mkdir(secretOutsideDir, { recursive: true });
    await fs.writeFile(path.join(secretOutsideDir, attJ.filename), Buffer.alloc(321)); // would be a PERFECT match if the symlink were followed
    await fs.symlink(secretOutsideDir, path.join(TEMP_UPLOAD_DIR, ticketJ.id), "dir");

    const reportsDefault = await investigateMissingNoCorrelationAttachments({ extraPaths: [TEMP_EXTRA_DIR], scanWholeUploadTree: false });

    check("A: the email-correlated row is NOT in the report", !reportsDefault.some((r) => r.attachmentId === attWithEmail.id));
    check("B: the already-present row is NOT in the report", !reportsDefault.some((r) => r.attachmentId === attPresent.id));

    const reportC = reportsDefault.find((r) => r.attachmentId === attC.id);
    check("C: the exact-match row IS in the report", reportC !== undefined);
    check("C: it reports an exact_filename_and_size_match candidate", (reportC?.candidates ?? []).some((c) => c.classification === "exact_filename_and_size_match" && c.foundFilename === attC.filename));

    const reportD = reportsDefault.find((r) => r.attachmentId === attD.id);
    check("D: the size-only row reports ONLY size_only_match (never a stronger classification)", (reportD?.candidates ?? []).length > 0 && (reportD?.candidates ?? []).every((c) => c.classification === "size_only_match"));

    const reportE = reportsDefault.find((r) => r.attachmentId === attE.id);
    check("E: the filename-only row reports filename_only_match, never treated as a usable size match", (reportE?.candidates ?? []).some((c) => c.classification === "filename_only_match") && !(reportE?.candidates ?? []).some((c) => c.classification === "exact_filename_and_size_match" || c.classification === "originalname_and_size_match"));

    const reportGDefault = reportsDefault.find((r) => r.attachmentId === attG.id);
    check("G: WITHOUT --scan-whole-upload-tree, the other-ticket candidate is NOT found", !(reportGDefault?.candidates ?? []).some((c) => c.foundFilename === attG.filename));

    const reportsWithWholeTree = await investigateMissingNoCorrelationAttachments({ extraPaths: [], scanWholeUploadTree: true });
    const reportGWithScan = reportsWithWholeTree.find((r) => r.attachmentId === attG.id);
    check("G: WITH --scan-whole-upload-tree enabled, the other-ticket candidate IS found", (reportGWithScan?.candidates ?? []).some((c) => c.classification === "exact_filename_and_size_match" && c.foundFilename === attG.filename));

    const reportH = reportsDefault.find((r) => r.attachmentId === attH.id);
    check("H: ticketHasAnyEmailReply is true for a ticket whose TICKET itself has no emailMessageId but has a message that does", reportH?.ticketHasAnyEmailReply === true);
    const reportC_asControl = reportsDefault.find((r) => r.attachmentId === attC.id);
    check("H-control: a ticket with no email replies at all reports ticketHasAnyEmailReply === false", reportC_asControl?.ticketHasAnyEmailReply === false);

    const reportI = reportsDefault.find((r) => r.attachmentId === attI.id);
    check("I: a row with no candidate anywhere is STILL present in the report (never silently dropped)", reportI !== undefined);
    check("I: its candidates array is empty", (reportI?.candidates ?? ["not empty"]).length === 0);
    check("I: its searchedLocations is non-empty (distinguishing 'not found' from 'never checked')", (reportI?.searchedLocations.length ?? 0) > 0);

    const reportJ = reportsDefault.find((r) => r.attachmentId === attJ.id);
    check("J: a ticket directory that is a symlink to outside UPLOAD_DIR is never followed — the perfect-match file at the symlink's target is NOT reported as a candidate", !(reportJ?.candidates ?? []).some((c) => c.foundFilename === attJ.filename));
    check("J: the escaped (secret) directory never appears in searchedLocations", !(reportJ?.searchedLocations ?? []).some((loc) => loc.startsWith(secretOutsideDir)));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticketAttachment.deleteMany({ where: { id: { in: attachmentIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("DB cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    try {
      // fs.rm's recursive walk removes a symlink it encounters (the link
      // entry itself), never following it into its target — so this does
      // NOT reach into (or delete) secretOutsideDir, which is cleaned up
      // separately below since it was created as its own, sibling temp dir.
      await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
      await fs.rm(TEMP_EXTRA_DIR, { recursive: true, force: true });
      await fs.rm(path.join(os.tmpdir(), `${TAG}-secret-outside`), { recursive: true, force: true });
    } catch (err) {
      console.warn("Temp directory cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
