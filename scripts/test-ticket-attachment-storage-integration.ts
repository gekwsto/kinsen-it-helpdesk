/**
 * Integration regression proving POST /api/tickets/[id]/attachments is
 * correctly wired through the new shared lib/attachment-storage-service.ts
 * — drives the REAL route handlers end to end (same convention as
 * scripts/test-create-with-attachments.ts: mock @/lib/auth for session,
 * real NextRequest/FormData, real database, real files under a sandboxed
 * UPLOAD_DIR), rather than re-testing the storage service's own internals
 * (already exhaustively covered in scripts/test-attachment-storage-
 * service.ts).
 *
 * Proves:
 *   A. A normal upload still works end to end: 201, the DB row is created
 *      with the storage service's own verified size, the file exists with
 *      the exact uploaded bytes, and the EXISTING, UNCHANGED download
 *      route (GET /api/tickets/[id]/attachments/[attachmentId]) still
 *      serves it correctly — proving backward compatibility with the
 *      download path was preserved.
 *   B. When attachment storage is forced into the "not verified" state
 *      (the exact condition that caused the historical incident), the
 *      SAME upload route now returns 503, creates NO database row, and
 *      writes NO file — where previously it would have silently
 *      succeeded with an undetectable, non-durable write.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-attachment-storage-integration.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import { mock } from "node:test";
import { NextRequest } from "next/server";

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
const TAG = `gtsi-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

async function main() {
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

  let currentSession: { user: { id: string; role: string; customRoleId: string | null } } | null = null;
  mock.module("@/lib/auth", {
    namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
  });

  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, TicketSource } = await import("@prisma/client");
  const { POST: attachPOST } = await import("@/app/api/tickets/[id]/attachments/route");
  const { GET: attachGET } = await import("@/app/api/tickets/[id]/attachments/[attachmentId]/route");
  const { resetAttachmentStorageVerificationForTests, verifyAttachmentStorage } = await import("@/lib/attachment-storage-service");

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

  function uploadReq(url: string, filename: string, mime: string, bytes: number[]) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    return new NextRequest(url, { method: "POST", body: fd as any });
  }

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: true } });
    userIds.push(user.id);
    currentSession = { user: { id: user.id, role: Role.USER, customRoleId: null } };

    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} ticket`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id },
    });
    ticketIds.push(ticket.id);

    // Force storage VERIFIED for scenario A (forced via a non-Linux
    // platform injection, same as test-attachment-storage-service.ts) —
    // this test exercises the ROUTE's wiring, not the mount-check logic
    // itself (already exhaustively covered separately).
    resetAttachmentStorageVerificationForTests();
    await verifyAttachmentStorage({ platform: "darwin", uploadDir: TEMP_UPLOAD_DIR });

    // ── A — normal upload end to end, including the EXISTING download route. ─
    console.log("\nA — a normal upload still works end to end, download route unchanged...\n");
    const fileBytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const uploadRes = await attachPOST(uploadReq(`http://localhost/api/tickets/${ticket.id}/attachments`, "evidence.png", "image/png", fileBytes), { params: Promise.resolve({ id: ticket.id }) });
    check("A: upload returns 201", uploadRes.status === 201);
    const uploadedAttachment = await uploadRes.json();
    check("A: response includes the attachment id", typeof uploadedAttachment.id === "string");
    check("A: DB row reports the correct, storage-service-verified size", uploadedAttachment.size === fileBytes.length);

    const dbRow = await prisma.ticketAttachment.findUnique({ where: { id: uploadedAttachment.id } });
    check("A: TicketAttachment row exists with the expected metadata", dbRow !== null && dbRow.originalName === "evidence.png" && dbRow.mimeType === "image/png" && dbRow.size === fileBytes.length);

    const onDiskPath = path.join(TEMP_UPLOAD_DIR, ticket.id, dbRow!.filename);
    const onDiskBytes = await fs.readFile(onDiskPath);
    check("A: file on disk matches the uploaded bytes exactly", onDiskBytes.equals(Buffer.from(fileBytes)));

    const downloadRes = await attachGET(new NextRequest(`http://localhost/api/tickets/${ticket.id}/attachments/${uploadedAttachment.id}`), { params: Promise.resolve({ id: ticket.id, attachmentId: uploadedAttachment.id }) });
    check("A: the EXISTING, unchanged download route still returns 200", downloadRes.status === 200);
    const downloadedBytes = Buffer.from(await downloadRes.arrayBuffer());
    check("A: downloaded bytes match exactly what was uploaded", downloadedBytes.equals(Buffer.from(fileBytes)));

    // ── B — storage forced "not verified" -> 503, no DB row, no file. ────
    console.log("\nB — with storage forced unverified, the SAME route now fails closed instead of silently losing data...\n");
    resetAttachmentStorageVerificationForTests();
    const badMountInfo = "37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n";
    await verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_UPLOAD_DIR, mountInfoReader: async () => badMountInfo });

    const countBefore = await prisma.ticketAttachment.count({ where: { ticketId: ticket.id } });
    const failedUploadRes = await attachPOST(uploadReq(`http://localhost/api/tickets/${ticket.id}/attachments`, "would-be-lost.png", "image/png", [9, 9, 9]), { params: Promise.resolve({ id: ticket.id }) });
    check("B: upload is refused with 503 when storage is not verified", failedUploadRes.status === 503);
    const countAfter = await prisma.ticketAttachment.count({ where: { ticketId: ticket.id } });
    check("B: NO new TicketAttachment row was created", countAfter === countBefore);
    const wouldBeLostDirEntries = await fs.readdir(path.join(TEMP_UPLOAD_DIR, ticket.id));
    check("B: no new file was written either — only the earlier scenario A upload remains", wouldBeLostDirEntries.length === 1);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketAttachment.deleteMany({ where: { ticketId: { in: ticketIds } } });
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
      await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
    } catch (err) {
      console.warn("Temp directory cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    (await import("@/lib/attachment-storage-service")).resetAttachmentStorageVerificationForTests();
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
