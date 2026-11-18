/**
 * Focused regression for buildContentDispositionHeader (lib/attachment-policy.ts)
 * — the fix for the production ByteString TypeError:
 * "Cannot convert argument to a ByteString because the character at index
 * 55 has a value of 8239 which is greater than 255" (U+202F NARROW NO-BREAK
 * SPACE in a PNG's original filename reaching a raw template-literal
 * Content-Disposition header).
 *
 * Covers: ASCII, Greek, U+202F specifically, spaces/quotes/parentheses,
 * control-character/header-injection stripping, and — critically — that the
 * built header value never throws when actually passed to the real
 * `Headers` constructor (the exact mechanism that crashed in production),
 * for PNG/PDF/XLSX-shaped names. Also exercises the full download route
 * handler end-to-end (auth, DB lookup, real file read, real NextResponse
 * construction) to prove the fix holds through the whole request, not just
 * the pure helper function in isolation.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-attachment-content-disposition.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, TicketSource } from "@prisma/client";
import { buildContentDispositionHeader, UPLOAD_DIR } from "@/lib/attachment-policy";

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

// ── Pure-helper checks: every name must produce a header value that, when
//    actually passed through the real WHATWG Headers constructor (the
//    exact mechanism that threw in production), never throws. ──
function assertHeaderNeverThrows(label: string, originalName: string) {
  let value: string;
  let threw = false;
  let threwMessage = "";
  try {
    value = buildContentDispositionHeader(originalName);
    new Headers({ "Content-Disposition": value }); // the real crash site
  } catch (err) {
    threw = true;
    threwMessage = err instanceof Error ? err.message : String(err);
    value = "";
  }
  check(`${label}: Headers constructor does not throw`, !threw, threwMessage);
  return value;
}

console.log("\n=== Pure buildContentDispositionHeader checks ===\n");

// 1. ASCII filename
{
  const v = assertHeaderNeverThrows("ASCII filename", "invoice.pdf");
  check("ASCII: filename= present and unmangled", v.includes('filename="invoice.pdf"'), v);
  check("ASCII: filename*= present with UTF-8 encoding", v.includes("filename*=UTF-8''invoice.pdf"), v);
}

// 2. Greek filename
{
  const greek = "τιμολόγιο.pdf"; // "invoice.pdf" in Greek
  const v = assertHeaderNeverThrows("Greek filename", greek);
  check("Greek: filename= fallback is pure ASCII", /filename="[\x20-\x7e]*"/.test(v), v);
  check("Greek: filename*= carries the real UTF-8 original", v.includes(`filename*=UTF-8''${encodeURIComponent(greek)}`), v);
}

// 3. U+202F NARROW NO-BREAK SPACE — the exact production character (code point 8239)
{
  const nnbsp = "Screenshot 2026-11-18.png";
  check("Fixture actually contains U+202F (sanity check)", nnbsp.codePointAt(10) === 0x202f);
  const v = assertHeaderNeverThrows("U+202F filename (production repro)", nnbsp);
  check("U+202F: filename= fallback is pure ASCII (no raw 0x202F byte)", /filename="[\x20-\x7e]*"/.test(v), v);
  check("U+202F: filename*= preserves the original via percent-encoding", v.includes(`filename*=UTF-8''${encodeURIComponent(nnbsp)}`), v);
}

// 4. Spaces, quotes, parentheses
{
  const tricky = 'My "Report" (final) v2.xlsx';
  const v = assertHeaderNeverThrows("Spaces/quotes/parens filename", tricky);
  check("Tricky: quotes are escaped, not stripped", v.includes('filename="My \\"Report\\" (final) v2.xlsx"'), v);
  check("Tricky: filename*= preserves the original exactly via percent-encoding", v.includes(`filename*=UTF-8''${encodeURIComponent(tricky)}`), v);
}

// 5. Control characters / header injection attempt
{
  const malicious = "evil\r\nX-Injected: true.txt";
  const v = assertHeaderNeverThrows("CR/LF header-injection attempt", malicious);
  check("Injection: no raw CR in the built value", !v.includes("\r"));
  check("Injection: no raw LF in the built value", !v.includes("\n"));
  check("Injection: single header line only", v.split("\n").length === 1 && v.split("\r").length === 1);
}

// 6. Backslash in filename
{
  const v = assertHeaderNeverThrows("Backslash filename", 'weird\\name.txt');
  check("Backslash: escaped in the quoted-string", v.includes('filename="weird\\\\name.txt"'), v);
}

// 7. Entirely non-ASCII filename (fallback must never be an empty filename="")
{
  const v = assertHeaderNeverThrows("All-CJK filename", "報告書.pdf");
  check("All-non-ASCII: ASCII fallback is never empty", !v.includes('filename=""'), v);
}

// ── End-to-end: real download route handler, real file on disk, real
//    Headers construction, for PNG/PDF/XLSX — proves the fix holds through
//    the whole request path, not just the isolated helper. ──
console.log("\n=== End-to-end: real GET /api/tickets/[id]/attachments/[attachmentId] ===\n");

const RUN_ID = Date.now();
const TAG = `tcd-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping end-to-end section.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { GET: getAttachment } = await import("@/app/api/tickets/[id]/attachments/[attachmentId]/route");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const attachmentIds: string[] = [];
  const writtenFiles: string[] = [];

  try {
    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: "Open", color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    const user = await prisma.user.create({
      data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(user.id);
    currentSession = { user: { id: user.id, role: Role.ADMIN, customRoleId: null } };

    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} ticket`, description: "desc", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id },
    });
    ticketIds.push(ticket.id);

    const fixtures: { originalName: string; mimeType: string; bytes: Buffer }[] = [
      { originalName: "Screenshot 2026-11-18.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }, // PNG magic bytes
      { originalName: "τιμολόγιο.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 fake") },
      { originalName: 'My "Report" (final) v2.xlsx', mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: Buffer.from("PK fake xlsx") },
    ];

    const dir = path.join(UPLOAD_DIR, ticket.id);
    await fs.mkdir(dir, { recursive: true });

    for (const fx of fixtures) {
      const filename = `${RUN_ID}-${attachmentIds.length}-stored.bin`;
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, fx.bytes);
      writtenFiles.push(filePath);

      const attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          uploadedById: user.id,
          filename,
          originalName: fx.originalName,
          mimeType: fx.mimeType,
          size: fx.bytes.length,
          path: `/uploads/${ticket.id}/${filename}`,
        },
      });
      attachmentIds.push(attachment.id);

      const res = await getAttachment(new NextRequest(`http://localhost/api/tickets/${ticket.id}/attachments/${attachment.id}`), {
        params: Promise.resolve({ id: ticket.id, attachmentId: attachment.id }),
      });

      check(`${fx.mimeType}: GET -> 200 (no crash)`, res.status === 200, `got ${res.status}: ${await res.clone().text().catch(() => "")}`);
      check(`${fx.mimeType}: Content-Type header correct`, res.headers.get("Content-Type") === fx.mimeType);
      const disposition = res.headers.get("Content-Disposition") ?? "";
      check(`${fx.mimeType}: Content-Disposition present`, disposition.length > 0);
      check(`${fx.mimeType}: Content-Disposition carries UTF-8 original name`, disposition.includes(`filename*=UTF-8''${encodeURIComponent(fx.originalName)}`), disposition);
      const body = Buffer.from(await res.arrayBuffer());
      check(`${fx.mimeType}: downloaded bytes match exactly`, body.equals(fx.bytes));
    }

    // Authorization unchanged: a user with no access to this ticket's department is forbidden.
    const outsider = await prisma.user.create({
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(outsider.id);
    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const forbiddenRes = await getAttachment(new NextRequest(`http://localhost/api/tickets/${ticket.id}/attachments/${attachmentIds[0]}`), {
      params: Promise.resolve({ id: ticket.id, attachmentId: attachmentIds[0] }),
    });
    check("Unauthorized user still gets 403 (authorization unchanged)", forbiddenRes.status === 403);

    // Path-traversal guard unchanged: a row with an unsafe filename is still refused.
    currentSession = { user: { id: user.id, role: Role.ADMIN, customRoleId: null } };
    const traversalAttachment = await prisma.ticketAttachment.create({
      data: {
        ticketId: ticket.id,
        uploadedById: user.id,
        filename: "../../etc/passwd",
        originalName: "passwd",
        mimeType: "text/plain",
        size: 0,
        path: `/uploads/${ticket.id}/passwd`,
      },
    });
    attachmentIds.push(traversalAttachment.id);
    const traversalRes = await getAttachment(new NextRequest(`http://localhost/api/tickets/${ticket.id}/attachments/${traversalAttachment.id}`), {
      params: Promise.resolve({ id: ticket.id, attachmentId: traversalAttachment.id }),
    });
    check("Path-traversal filename still refused (404, not served)", traversalRes.status === 404);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      for (const f of writtenFiles) await fs.rm(f, { force: true });
      await prisma.ticketAttachment.deleteMany({ where: { id: { in: attachmentIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
