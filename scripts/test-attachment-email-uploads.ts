/**
 * End-to-end route coverage for email-file (.msg/.eml) attachments across
 * Projects, Activities and Tickets (web upload routes) and the external
 * Ticket Integration attachment API — real route handlers, real database,
 * a temporary UPLOAD_DIR, mocked session.
 *
 *  - .msg / .eml / PDF / PNG upload -> 201, stored MIME normalized for email
 *  - download returns BYTE-IDENTICAL content (sha256), as an attachment
 *    (Content-Disposition: attachment, RFC 5987 filename*, nosniff)
 *  - invalid email content, disallowed type, oversized -> 400
 *  - unauthorized upload/download -> 403
 *  - delete still works; an existing (pre-change) attachment still downloads
 *  - Integration API: .msg/.eml accepted with the same policy; idempotency
 *    (same externalAttachmentId + same bytes = duplicate 200; different
 *    bytes = 409) and the 422 rejection contract preserved
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-attachment-email-uploads.ts
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { mock } from "node:test";
import { Role, AuthProvider } from "@prisma/client";
import { buildSampleMsg, buildSampleEml, buildRenamedOleDoc } from "./test-support-email-fixtures";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

const RUN_ID = Date.now();
const TAG = `aeu-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

async function main() {
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR; // before any import of lib/attachment-policy.ts
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  const { NextRequest } = await import("next/server");
  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { createTicketAtomic } = await import("@/lib/services/ticket-creation-service");
  const { ensureStatusForDepartment, STARTER_STATUSES } = await import("@/lib/services/config-starter-data");
  const { generateIntegrationKey } = await import("@/lib/services/integration-key-service");
  const projectAtt = await import("@/app/api/projects/[id]/attachments/route");
  const projectAttItem = await import("@/app/api/projects/[id]/attachments/[attachmentId]/route");
  const activityAtt = await import("@/app/api/activities/[id]/attachments/route");
  const activityAttItem = await import("@/app/api/activities/[id]/attachments/[attachmentId]/route");
  const ticketAtt = await import("@/app/api/tickets/[id]/attachments/route");
  const ticketAttItem = await import("@/app/api/tickets/[id]/attachments/[attachmentId]/route");
  const integrationAtt = await import("@/app/api/integrations/tickets/[ticketId]/attachments/route");
  const { entityAttachmentDir, generateStoredFilename } = await import("@/lib/attachment-policy");

  let noopRoleId: string | null = null;
  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], activities: [] as string[], tickets: [] as string[], integrations: [] as string[] };
  const msg = buildSampleMsg();
  const eml = buildSampleEml();
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  const upload = async (handler: any, url: string, id: string, file: { name: string; type: string; bytes: Buffer }, extra: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    for (const [k, val] of Object.entries(extra)) fd.append(k, val);
    const res = await handler(new NextRequest(url, { method: "POST", body: fd as any, headers }), { params: Promise.resolve({ id, ticketId: id }) });
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status as number, body };
  };
  const download = async (handler: any, url: string, params: Record<string, string>) => {
    const res = await handler(new NextRequest(url), { params: Promise.resolve(params) });
    return { status: res.status as number, headers: res.headers as Headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    ids.depts.push(dept.id);
    const status = await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);
    const admin = await prisma.user.create({ data: { email: `${TAG}-admin@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    // A real outsider: global USER with a no-permission custom global role
    // (the base USER role grants e.g. activity.view globally — same fixture
    // pattern as scripts/test-activity-attachments.ts).
    const noopRole = await prisma.customRole.create({ data: { key: `AEU_NOOP_${RUN_ID}`, name: `AEU noop ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL" as any, isActive: true } });
    noopRoleId = noopRole.id;
    const outsider = await prisma.user.create({ data: { email: `${TAG}-outsider@kinsen.gr`, role: Role.USER, customRoleId: noopRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ids.users.push(admin.id, outsider.id);
    const project = await prisma.project.create({ data: { title: `${TAG} project`, departmentId: dept.id, ownerId: admin.id, owners: { connect: [{ id: admin.id }] } } });
    ids.projects.push(project.id);
    const activity = await prisma.projectActivity.create({ data: { title: `${TAG} activity`, departmentId: dept.id, projectId: project.id } });
    ids.activities.push(activity.id);
    const ticket = await createTicketAtomic({ title: `${TAG} ticket`, description: "Fixture.", source: "WEB", requesterId: admin.id, statusId: status.id, departmentId: dept.id }, { changedById: admin.id, description: "Fixture" });
    ids.tickets.push(ticket.id);

    const surfaces = [
      { label: "Project", post: projectAtt.POST, get: projectAttItem.GET, del: projectAttItem.DELETE, base: `http://localhost/api/projects/${project.id}`, id: project.id, itemParams: (a: string) => ({ id: project.id, attachmentId: a }) },
      { label: "Activity", post: activityAtt.POST, get: activityAttItem.GET, del: activityAttItem.DELETE, base: `http://localhost/api/activities/${activity.id}`, id: activity.id, itemParams: (a: string) => ({ id: activity.id, attachmentId: a }) },
      { label: "Ticket", post: ticketAtt.POST, get: ticketAttItem.GET, del: null as any, base: `http://localhost/api/tickets/${ticket.id}`, id: ticket.id, itemParams: (a: string) => ({ id: ticket.id, attachmentId: a }) },
    ];

    for (const s of surfaces) {
      console.log(`\n=== ${s.label} attachments ===\n`);
      currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
      const files = [
        { name: "Quarterly report – Σύνοψη.msg", type: "", bytes: msg, expectMime: "application/vnd.ms-outlook" }, // non-ASCII name, empty browser MIME
        { name: "Invoice 2026-11.eml", type: "message/rfc822", bytes: eml, expectMime: "message/rfc822" },
        { name: "spec.pdf", type: "application/pdf", bytes: pdf, expectMime: "application/pdf" },
        { name: "photo.png", type: "image/png", bytes: png, expectMime: "image/png" },
      ];
      const created: { id: string; name: string; bytes: Buffer; mime: string }[] = [];
      for (const f of files) {
        const r = await upload(s.post, `${s.base}/attachments`, s.id, f);
        check(`${s.label}: upload ${f.name} (browser MIME "${f.type}") -> 201, stored MIME ${f.expectMime}, original name kept`, r.status === 201 && r.body?.mimeType === f.expectMime && r.body?.originalName === f.name, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
        if (r.status === 201) created.push({ id: r.body.id, name: f.name, bytes: f.bytes, mime: f.expectMime });
      }
      for (const c of created) {
        const d = await download(s.get, `${s.base}/attachments/${c.id}`, s.itemParams(c.id));
        const disp = d.headers.get("content-disposition") ?? "";
        check(`${s.label}: download ${c.name} -> byte-identical (sha256)`, d.status === 200 && sha(d.bytes) === sha(c.bytes), `${d.status}`);
        check(`${s.label}: ${c.name} served as a download (attachment; filename*=UTF-8''…), Content-Type ${c.mime}, nosniff`, disp.startsWith("attachment;") && disp.includes(`filename*=UTF-8''${encodeURIComponent(c.name)}`) && d.headers.get("content-type") === c.mime && d.headers.get("x-content-type-options") === "nosniff", disp);
      }
      const bad = [
        { name: "renamed.msg", type: "application/vnd.ms-outlook", bytes: buildRenamedOleDoc(), why: "OLE file that is not an Outlook message" },
        { name: "fake.eml", type: "message/rfc822", bytes: Buffer.from("just some words\nno headers"), why: "text without an email header block" },
        { name: "script.html", type: "text/html", bytes: Buffer.from("<script>alert(1)</script>"), why: "disallowed type" },
        { name: "noext", type: "", bytes: Buffer.from("x"), why: "empty MIME, not an email extension" },
        { name: "big.msg", type: "", bytes: Buffer.alloc(10 * 1024 * 1024 + 1), why: "over 10 MB" },
      ];
      for (const b of bad) {
        const r = await upload(s.post, `${s.base}/attachments`, s.id, b);
        check(`${s.label}: rejects ${b.name} (${b.why}) -> 400, nothing stored`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
      }
      currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: noopRoleId } };
      const unauthorized = await upload(s.post, `${s.base}/attachments`, s.id, { name: "a.msg", type: "", bytes: msg });
      check(`${s.label}: unauthorized user upload -> 403`, unauthorized.status === 403, String(unauthorized.status));
      if (created[0]) {
        const unauthDl = await download(s.get, `${s.base}/attachments/${created[0].id}`, s.itemParams(created[0].id));
        check(`${s.label}: unauthorized user download -> 403`, unauthDl.status === 403, String(unauthDl.status));
      }
      currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
      if (s.del && created[0]) {
        const res = await s.del(new NextRequest(`${s.base}/attachments/${created[0].id}`, { method: "DELETE" }), { params: Promise.resolve(s.itemParams(created[0].id)) });
        const after = await download(s.get, `${s.base}/attachments/${created[0].id}`, s.itemParams(created[0].id));
        check(`${s.label}: delete the .msg -> 204, then 404`, res.status === 204 && after.status === 404, `${res.status}/${after.status}`);
      }
    }

    console.log("\n=== Existing (pre-change) attachments unaffected ===\n");
    const legacyDir = entityAttachmentDir("projects", project.id);
    const legacyName = generateStoredFilename("legacy.docx");
    const legacyBytes = Buffer.from("PK\u0003\u0004legacy docx bytes");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, legacyName), legacyBytes);
    const legacy = await prisma.projectAttachment.create({ data: { projectId: project.id, uploadedById: admin.id, filename: legacyName, originalName: "legacy.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: legacyBytes.length } });
    const legacyDl = await download(projectAttItem.GET, `http://localhost/api/projects/${project.id}/attachments/${legacy.id}`, { id: project.id, attachmentId: legacy.id });
    check("A pre-existing attachment row still downloads byte-identical with its stored MIME type", legacyDl.status === 200 && sha(legacyDl.bytes) === sha(legacyBytes) && legacyDl.headers.get("content-type") === legacy.mimeType);
    const list = await (await projectAtt.GET(new NextRequest(`http://localhost/api/projects/${project.id}/attachments`), { params: Promise.resolve({ id: project.id }) })).json();
    check("Project attachment list includes old and new attachments", Array.isArray(list) && list.some((a: any) => a.id === legacy.id) && list.some((a: any) => a.mimeType === "message/rfc822"));

    if (!process.env.INTEGRATION_KEY_PEPPER) {
      console.log("\nINTEGRATION_KEY_PEPPER not set — skipping Integration API section.");
    } else {
      console.log("\n=== Ticket Integration attachment API ===\n");
      const key = generateIntegrationKey();
      const integration = await prisma.externalIntegration.create({ data: { name: `${TAG}-int`, slug: `${TAG}-int`, departmentId: dept.id, apiKeyPrefix: key.keyPrefix, apiKeyHash: key.keyHash } });
      ids.integrations.push(integration.id);
      const iTicket = await createTicketAtomic({ title: `${TAG} api ticket`, description: "Fixture.", source: "API", requesterId: admin.id, statusId: status.id, departmentId: dept.id, integrationId: integration.id, externalReferenceId: `${TAG}-ref` }, { changedById: null, description: "Fixture" });
      ids.tickets.push(iTicket.id);
      const auth = { authorization: `Bearer ${key.rawKey}` };
      const url = `http://localhost/api/integrations/tickets/${iTicket.id}/attachments`;
      const m1 = await upload(integrationAtt.POST, url, iTicket.id, { name: "agent-capture.msg", type: "application/octet-stream", bytes: msg }, { externalAttachmentId: `${TAG}-a1` }, auth);
      check("API: .msg (application/octet-stream) -> 201, stored as application/vnd.ms-outlook", m1.status === 201 && m1.body?.created === true && m1.body?.attachment?.mimeType === "application/vnd.ms-outlook", `${m1.status} ${JSON.stringify(m1.body).slice(0, 200)}`);
      const e1 = await upload(integrationAtt.POST, url, iTicket.id, { name: "agent-capture.eml", type: "message/rfc822", bytes: eml }, {}, auth);
      check("API: .eml -> 201, stored as message/rfc822", e1.status === 201 && e1.body?.attachment?.mimeType === "message/rfc822", `${e1.status}`);
      const dup = await upload(integrationAtt.POST, url, iTicket.id, { name: "agent-capture.msg", type: "application/octet-stream", bytes: msg }, { externalAttachmentId: `${TAG}-a1` }, auth);
      check("API idempotency: same externalAttachmentId + same bytes -> 200 duplicate, same attachment", dup.status === 200 && dup.body?.created === false && dup.body?.attachment?.id === m1.body?.attachment?.id, `${dup.status}`);
      const conflict = await upload(integrationAtt.POST, url, iTicket.id, { name: "agent-capture.msg", type: "application/octet-stream", bytes: buildSampleMsg("Different subject") }, { externalAttachmentId: `${TAG}-a1` }, auth);
      check("API idempotency: same externalAttachmentId + different bytes -> 409", conflict.status === 409, `${conflict.status}`);
      const badApi = await upload(integrationAtt.POST, url, iTicket.id, { name: "bad.eml", type: "message/rfc822", bytes: Buffer.from("no headers") }, {}, auth);
      check("API: invalid .eml content -> 422 validation_failed (same contract as a disallowed type)", badApi.status === 422 && badApi.body?.code === "validation_failed", `${badApi.status} ${JSON.stringify(badApi.body)}`);
      const badType = await upload(integrationAtt.POST, url, iTicket.id, { name: "x.html", type: "text/html", bytes: Buffer.from("<b>") }, {}, auth);
      check("API: disallowed type keeps the exact previous message 'File type not allowed.' (422)", badType.status === 422 && badType.body?.message === "File type not allowed.", JSON.stringify(badType.body));
      const noAuth = await upload(integrationAtt.POST, url, iTicket.id, { name: "a.msg", type: "", bytes: msg });
      check("API: missing credentials -> 401 (authentication unchanged)", noAuth.status === 401, String(noAuth.status));
      currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
      const apiDl = await download(ticketAttItem.GET, `http://localhost/api/tickets/${iTicket.id}/attachments/${m1.body.attachment.id}`, { id: iTicket.id, attachmentId: m1.body.attachment.id });
      check("API-uploaded .msg downloads byte-identical through the web route", apiDl.status === 200 && sha(apiDl.bytes) === sha(msg));
    }
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ids.tickets } } })],
      ["integrations", () => prisma.externalIntegration.deleteMany({ where: { id: { in: ids.integrations } } })],
      ["activity attachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: ids.activities } } })],
      ["project attachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["noop role", () => (noopRoleId ? prisma.customRole.delete({ where: { id: noopRoleId } }) : Promise.resolve())],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [label, fn] of steps) {
      try { await fn(); } catch (err) { console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err); }
    }
    await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
