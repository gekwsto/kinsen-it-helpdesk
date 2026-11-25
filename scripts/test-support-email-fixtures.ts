/**
 * Synthetic email-file fixtures for attachment tests (never real user mail).
 *
 *  - buildSampleMsg(): a structurally valid OLE2 / Compound File Binary
 *    (CFB v3) file laid out like an Outlook .msg (MS-OXMSG): root storage with
 *    __properties_version1.0, __substg1.0_0037001F (subject),
 *    __substg1.0_1000001F (body) streams, plus an EMBEDDED ATTACHMENT storage
 *    __attach_version1.0_#00000000 holding __substg1.0_37010102 (attachment
 *    data) and __substg1.0_3707001F (attachment filename). Every stream is
 *    >= the 4096-byte mini-stream cutoff so it lives in regular sectors.
 *  - buildRenamedOleDoc(): a CFB file WITHOUT any Outlook property streams
 *    (what a legacy .doc renamed to .msg looks like) — must be rejected.
 *  - buildSampleEml(): an RFC 5322 multipart message with a base64 PDF
 *    attachment and a nested message/rfc822 (forwarded) part.
 */

const SECTOR = 512;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

interface CfbNode {
  name: string;
  kind: "storage" | "stream";
  data?: Buffer;
  children?: CfbNode[];
}

function utf16(s: string) {
  return Buffer.from(s, "utf16le");
}

export function buildCfb(rootChildren: CfbNode[]): Buffer {
  // Flatten: index 0 = root entry.
  const entries: { node: CfbNode | null; name: string; type: number; child: number; right: number; data?: Buffer; startSector: number; size: number }[] = [];
  entries.push({ node: null, name: "Root Entry", type: 5, child: NOSTREAM, right: NOSTREAM, startSector: ENDOFCHAIN, size: 0 });
  const addChildren = (parentIndex: number, children: CfbNode[]) => {
    let prev = -1;
    for (const child of children) {
      const idx = entries.length;
      const data = child.kind === "stream" ? padTo(child.data ?? Buffer.alloc(0), 4096) : undefined;
      entries.push({ node: child, name: child.name, type: child.kind === "storage" ? 1 : 2, child: NOSTREAM, right: NOSTREAM, data, startSector: ENDOFCHAIN, size: data ? data.length : 0 });
      if (prev === -1) entries[parentIndex].child = idx;
      else entries[prev].right = idx; // siblings chained via right pointers (all black — valid degenerate tree)
      prev = idx;
      if (child.kind === "storage" && child.children) addChildren(idx, child.children);
    }
  };
  addChildren(0, rootChildren);

  const dirSectors = Math.ceil(entries.length / 4);
  const streamSectors = entries.reduce((n, e) => n + (e.data ? e.data.length / SECTOR : 0), 0);
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + dirSectors + streamSectors) fatSectors++;
  const total = fatSectors + dirSectors + streamSectors;
  const fat = new Array<number>(fatSectors * 128).fill(FREESECT);
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT;
  const dirStart = fatSectors;
  for (let i = 0; i < dirSectors; i++) fat[dirStart + i] = i === dirSectors - 1 ? ENDOFCHAIN : dirStart + i + 1;
  let next = dirStart + dirSectors;
  for (const e of entries) {
    if (!e.data) continue;
    const n = e.data.length / SECTOR;
    e.startSector = next;
    for (let i = 0; i < n; i++) fat[next + i] = i === n - 1 ? ENDOFCHAIN : next + i + 1;
    next += n;
  }

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24); // minor version
  header.writeUInt16LE(0x0003, 26); // major version 3
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift (512)
  header.writeUInt16LE(6, 32); // mini sector shift (64)
  header.writeUInt32LE(0, 40); // number of directory sectors (0 for v3)
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(dirStart, 48);
  header.writeUInt32LE(0, 52); // transaction signature
  header.writeUInt32LE(4096, 56); // mini stream cutoff
  header.writeUInt32LE(ENDOFCHAIN, 60); // first mini FAT sector
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68); // first DIFAT sector
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREESECT, 76 + i * 4);

  const body = Buffer.alloc(total * SECTOR);
  for (let i = 0; i < fat.length; i++) body.writeUInt32LE(fat[i], i * 4);
  entries.forEach((e, i) => {
    const off = dirStart * SECTOR + i * 128;
    const name = utf16(e.name);
    name.copy(body, off, 0, Math.min(62, name.length));
    body.writeUInt16LE(Math.min(64, name.length + 2), off + 64);
    body.writeUInt8(e.type, off + 66);
    body.writeUInt8(1, off + 67); // black
    body.writeUInt32LE(NOSTREAM, off + 68); // left sibling
    body.writeUInt32LE(e.right, off + 72);
    body.writeUInt32LE(e.child, off + 76);
    body.writeUInt32LE(e.startSector, off + 116);
    body.writeUInt32LE(e.size, off + 120);
  });
  for (let i = entries.length; i < dirSectors * 4; i++) {
    const off = dirStart * SECTOR + i * 128;
    body.writeUInt32LE(NOSTREAM, off + 68);
    body.writeUInt32LE(NOSTREAM, off + 72);
    body.writeUInt32LE(NOSTREAM, off + 76);
  }
  for (const e of entries) if (e.data) e.data.copy(body, e.startSector * SECTOR);
  return Buffer.concat([header, body]);
}

function padTo(b: Buffer, min: number) {
  const len = Math.max(min, Math.ceil(b.length / SECTOR) * SECTOR);
  const out = Buffer.alloc(len);
  b.copy(out);
  return out;
}

export function buildSampleMsg(subject = "Quarterly report"): Buffer {
  return buildCfb([
    { name: "__properties_version1.0", kind: "stream", data: Buffer.alloc(32) },
    { name: "__substg1.0_0037001F", kind: "stream", data: utf16(subject) },
    { name: "__substg1.0_1000001F", kind: "stream", data: utf16("Hello,\r\nPlease find the report attached.\r\n") },
    {
      name: "__attach_version1.0_#00000000",
      kind: "storage",
      children: [
        { name: "__substg1.0_3707001F", kind: "stream", data: utf16("report.pdf") },
        { name: "__substg1.0_37010102", kind: "stream", data: Buffer.from("%PDF-1.4\n% embedded attachment bytes\n%%EOF\n") },
      ],
    },
  ]);
}

export function buildRenamedOleDoc(): Buffer {
  return buildCfb([
    { name: "WordDocument", kind: "stream", data: Buffer.from("not an email") },
    { name: "\u0005SummaryInformation", kind: "stream", data: Buffer.alloc(64) },
  ]);
}

export function buildSampleEml(subject = "Invoice 2026-11"): Buffer {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n").toString("base64");
  const text = [
    "Return-Path: <billing@example.com>",
    "Received: from mail.example.com (mail.example.com [192.0.2.1])",
    "\tby mx.example.org with ESMTPS id abc123",
    "\tfor <it@example.org>; Wed, 25 Nov 2026 09:00:00 +0200",
    "From: Billing <billing@example.com>",
    "To: IT Helpdesk <it@example.org>",
    `Subject: ${subject}`,
    "Date: Wed, 25 Nov 2026 09:00:00 +0200",
    "Message-ID: <fixture-1@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUNDARY-1"',
    "",
    "--BOUNDARY-1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please see the attached invoice and the forwarded message.",
    "",
    "--BOUNDARY-1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "",
    pdf,
    "",
    "--BOUNDARY-1",
    "Content-Type: message/rfc822",
    'Content-Disposition: attachment; filename="forwarded.eml"',
    "",
    "From: Someone <someone@example.com>",
    "Subject: Forwarded original",
    "Date: Tue, 24 Nov 2026 10:00:00 +0200",
    "",
    "Original body.",
    "",
    "--BOUNDARY-1--",
    "",
  ].join("\r\n");
  return Buffer.from(text, "utf8");
}
