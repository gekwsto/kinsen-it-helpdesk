/**
 * Unit coverage for the shared attachment policy with email-file support:
 * classifyAttachmentFile (client + server) and validateAttachmentUpload
 * (server: + .msg/.eml content verification). No DB.
 *
 * Usage: npx tsx scripts/test-attachment-email-policy.ts
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { classifyAttachmentFile, isAllowedAttachmentMimeType, attachmentIconKind, ATTACHMENT_ACCEPT_ATTRIBUTE, MAX_ATTACHMENT_SIZE_BYTES } from "@/lib/attachment-constants";
import { validateAttachmentUpload, isOutlookMsgContent, isRfc822MessageContent } from "@/lib/attachment-policy";
import { buildSampleMsg, buildSampleEml, buildRenamedOleDoc } from "./test-support-email-fixtures";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const v = (name: string, type: string, bytes: Buffer) => validateAttachmentUpload({ name, type, size: bytes.length }, bytes);

const msg = buildSampleMsg();
const eml = buildSampleEml();
const renamedDoc = buildRenamedOleDoc();
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");

console.log("\n=== Fixtures are genuine formats (independent libmagic identification) ===\n");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "att-email-"));
fs.writeFileSync(path.join(tmp, "a.msg"), msg);
fs.writeFileSync(path.join(tmp, "a.eml"), eml);
const magic = (f: string) => { try { return execFileSync("file", ["-b", path.join(tmp, f)], { encoding: "utf8" }).trim(); } catch { return "unavailable"; } };
const msgMagic = magic("a.msg"), emlMagic = magic("a.eml");
check(`libmagic: sample .msg is "${msgMagic}"`, msgMagic === "unavailable" || /Outlook Message/.test(msgMagic));
check(`libmagic: sample .eml is "${emlMagic}"`, emlMagic === "unavailable" || /mail/i.test(emlMagic));
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n=== .msg ===\n");
for (const type of ["application/vnd.ms-outlook", "", "application/octet-stream", "application/x-ole-storage", "application/CDFV2"]) {
  const r = v("Quarterly report.msg", type, msg);
  check(`.msg with MIME "${type}" accepted and normalized to application/vnd.ms-outlook`, r.ok && r.mimeType === "application/vnd.ms-outlook", JSON.stringify(r));
}
check(".MSG (upper-case extension) accepted", v("REPORT.MSG", "", msg).ok);
const docAsMsg = v("renamed.msg", "application/vnd.ms-outlook", renamedDoc);
check("A renamed Word .doc (OLE2 but no Outlook property streams) is rejected", !docAsMsg.ok && /Outlook message/.test((docAsMsg as any).error));
check("Random bytes named .msg are rejected", !v("x.msg", "application/vnd.ms-outlook", Buffer.from("hello world, not an OLE file at all".repeat(30))).ok);
check("Empty .msg is rejected", !v("x.msg", "", Buffer.alloc(0)).ok);
check(".msg with an unrelated MIME (image/png) is rejected (not in the accepted list)", !v("x.msg", "image/png", msg).ok);
check("isOutlookMsgContent(sample) === true", isOutlookMsgContent(msg));

console.log("\n=== .eml ===\n");
for (const type of ["message/rfc822", "", "application/octet-stream", "text/plain"]) {
  const r = v("Invoice.eml", type, eml);
  check(`.eml with MIME "${type}" accepted and normalized to message/rfc822`, r.ok && r.mimeType === "message/rfc822", JSON.stringify(r));
}
check(".eml with a UTF-8 BOM accepted", v("bom.eml", "message/rfc822", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), eml])).ok);
check(".eml starting with an mbox 'From ' separator accepted", v("mbox.eml", "", Buffer.concat([Buffer.from("From billing@example.com Wed Nov 25 09:00:00 2026\r\n"), eml])).ok);
const bigHeaders = Buffer.from("From: a@example.com\r\nSubject: big\r\n" + "X-Filler: " + "y".repeat(70) + "\r\n".repeat(1) + Array.from({ length: 400 }, (_, i) => `X-Pad-${i}: ${"z".repeat(40)}\r\n`).join("") + "\r\nbody\r\n");
check(".eml whose header block exceeds the 16 KB sample is still accepted (partial last line ignored)", bigHeaders.length > 16 * 1024 && v("big.eml", "", bigHeaders).ok);
check("Binary content named .eml is rejected", !v("x.eml", "message/rfc822", msg).ok);
check("Plain prose named .eml (no header block) is rejected", !v("x.eml", "text/plain", Buffer.from("Dear team,\nthis is just a note.\n")).ok);
check("A single header line is not enough", !v("x.eml", "", Buffer.from("Subject: hi\r\n\r\nbody")).ok);
check("Headers with no well-known message field are rejected", !v("x.eml", "", Buffer.from("Foo: 1\r\nBar: 2\r\n\r\nbody")).ok);
check("isRfc822MessageContent(sample) === true", isRfc822MessageContent(eml));

console.log("\n=== Existing types unchanged; nothing else gets a generic-MIME pass ===\n");
check("PDF (application/pdf) accepted, MIME kept", (() => { const r = v("a.pdf", "application/pdf", pdf); return r.ok && r.mimeType === "application/pdf"; })());
check("PNG accepted", v("a.png", "image/png", Buffer.from([137, 80, 78, 71])).ok);
check("PDF with an EMPTY MIME type is still rejected (generic types only ever accepted for .msg/.eml)", !v("a.pdf", "", pdf).ok);
check(".exe as application/octet-stream rejected", !v("setup.exe", "application/octet-stream", Buffer.from("MZ....")).ok);
check(".html rejected", !v("a.html", "text/html", Buffer.from("<html>")).ok);
check("A .msg-named file is never accepted on MIME alone — content is always checked", !v("evil.msg", "application/vnd.ms-outlook", Buffer.from("<script>")).ok);
check("Size limit still enforced (10 MB + 1 byte .msg rejected)", !classifyAttachmentFile({ name: "a.msg", type: "", size: MAX_ATTACHMENT_SIZE_BYTES + 1 }).ok);
check("A 0-byte PDF keeps its previous behaviour (accepted; storage unchanged)", v("empty.pdf", "application/pdf", Buffer.alloc(0)).ok);
check("Inbound-email MIME rule (isAllowedAttachmentMimeType) unchanged: message/rfc822 / vnd.ms-outlook NOT added there", !isAllowedAttachmentMimeType("message/rfc822") && !isAllowedAttachmentMimeType("application/vnd.ms-outlook"));

console.log("\n=== UI helpers ===\n");
check("accept attribute includes .msg and .eml", ATTACHMENT_ACCEPT_ATTRIBUTE.split(",").includes(".msg") && ATTACHMENT_ACCEPT_ATTRIBUTE.split(",").includes(".eml"));
check("Email icon for message/rfc822, vnd.ms-outlook and by extension", attachmentIconKind("message/rfc822") === "email" && attachmentIconKind("application/vnd.ms-outlook") === "email" && attachmentIconKind("", "x.msg") === "email");
check("Other icons unchanged (pdf/image/sheet/archive)", attachmentIconKind("application/pdf") === "pdf" && attachmentIconKind("image/png") === "image" && attachmentIconKind("application/vnd.ms-excel") === "sheet" && attachmentIconKind("application/zip") === "archive");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
