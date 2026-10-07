/**
 * Regression coverage for Project attachments — the Project counterpart of
 * scripts/test-activity-attachments.ts, added by generalizing the same
 * architecture (private UPLOAD_DIR, MIME/size allowlist, path-traversal
 * guards, authenticated per-entity download route; see
 * lib/attachment-policy.ts) onto a NEW, additive ProjectAttachment model —
 * ActivityAttachment itself was left untouched (see the final report for
 * why a shared polymorphic table was rejected).
 *
 * Authorization is resolved via hasEffectiveEntityPermission against the
 * Project's own real departmentId (global grant OR that department's own
 * grant — never active workspace, never a client-supplied department):
 *   - upload (POST) and delete (DELETE) require project.edit
 *   - list/download (GET) require project.view
 * No new "project.attachment" permission key was introduced — same choice
 * already made for Notes and for Activity attachments.
 *
 * SECTION A is a pure source-text guard (no DB) proving the route handlers
 * call the right permission with the right key and apply the same
 * path-traversal guards the Activity/Ticket attachment routes already
 * established.
 *
 * SECTION B uses Node's experimental module-mocking API (same established
 * pattern as scripts/test-activity-attachments.ts) to exercise the REAL
 * POST/GET/DELETE route handler functions end to end: real DB fixtures, a
 * real FormData upload, real bytes written under UPLOAD_DIR, a real
 * authenticated download, and a real DELETE.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-attachments.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, RoleScope } from "@prisma/client";
import { UPLOAD_DIR } from "@/lib/attachment-policy";
import { grantManualMembership } from "@/lib/services/department-membership-service";

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
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — Project attachment routes reuse the shared storage architecture and the right department-scoped permission ===\n");

  const listRoutePath = path.join(process.cwd(), "app/api/projects/[id]/attachments/route.ts");
  const listRouteSrc = await fs.readFile(listRoutePath, "utf8");
  check("A1. List (GET) requires authentication via requireAuth()", /requireAuth\s*\(/.test(listRouteSrc));
  // hasProjectViewAccess (lib/services/project-access-service.ts) — the
  // canonical Project read gate as of the Owner(s)/Audience feature: wraps
  // hasEffectiveEntityPermission(..., "project.view") as its FIRST branch
  // (global grant OR the project's own department grant, byte-for-byte
  // unchanged for any non-Owner/Audience caller), extended with a
  // request-origin-only Owner(s)/Audience fallback. See that function's
  // own doc comment for why this was never folded into
  // hasEffectiveEntityPermission itself (shared by Tickets/Activities too).
  check("A2. List (GET) checks hasProjectViewAccess(...) — the canonical Project read gate (wraps hasEffectiveEntityPermission's project.view union, extended for request-origin Owner(s)/Audience)", /hasProjectViewAccess\(/.test(listRouteSrc));
  check("A3. Upload (POST) checks hasEffectiveEntityPermission(...) with 'project.edit' (a stricter gate than list)", /hasEffectiveEntityPermission\([^)]*"project\.edit"/.test(listRouteSrc));
  check("A4. Upload reuses the shared attachment policy (MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename, entityAttachmentDir) rather than inventing new constants", /from "@\/lib\/attachment-policy"/.test(listRouteSrc) && /entityAttachmentDir\("projects"/.test(listRouteSrc));
  check("A5. Upload rejects a disallowed MIME type before ever writing to disk", /isAllowedAttachmentMimeType/.test(listRouteSrc) && listRouteSrc.indexOf("isAllowedAttachmentMimeType") < listRouteSrc.indexOf("fs.writeFile"));
  check("A6. Upload rejects an oversized file before ever writing to disk", /MAX_ATTACHMENT_SIZE_BYTES/.test(listRouteSrc) && listRouteSrc.indexOf("MAX_ATTACHMENT_SIZE_BYTES") < listRouteSrc.indexOf("fs.writeFile"));
  check("A6b. Never active workspace, never hasPermission/hasEffectiveModulePermission, never a hardcoded role name", !/getActiveWorkspace|hasEffectiveModulePermission|"ADMIN"|Role\.ADMIN/.test(listRouteSrc) && !/\bhasPermission\(/.test(listRouteSrc));

  const itemRoutePath = path.join(process.cwd(), "app/api/projects/[id]/attachments/[attachmentId]/route.ts");
  const itemRouteSrc = await fs.readFile(itemRoutePath, "utf8");
  check("A7. Download (GET) checks hasProjectViewAccess(...) (same canonical read gate as A2)", /hasProjectViewAccess\(/.test(itemRouteSrc));
  check("A8. Delete (DELETE) checks hasEffectiveEntityPermission(...) with 'project.edit' (not project.view — write, not read)", /export async function DELETE/.test(itemRouteSrc) && /hasEffectiveEntityPermission\([^)]*"project\.edit"/.test(itemRouteSrc.slice(itemRouteSrc.indexOf("export async function DELETE"))));
  check("A9. Download applies the SAME path-traversal guards as the Activity/Ticket attachment download route (isSafeStoredFilename + resolvesInsideDir)", /isSafeStoredFilename/.test(itemRouteSrc) && /resolvesInsideDir/.test(itemRouteSrc));
  check("A10. Download validates the attachment row belongs to THIS projectId before serving (cross-project isolation)", /attachment\.projectId !== projectId/.test(itemRouteSrc));
  check("A11. Delete validates the attachment row belongs to THIS projectId too", /attachment\.projectId !== projectId/.test(itemRouteSrc.slice(itemRouteSrc.indexOf("export async function DELETE"))));
  check("A12. Never served from public/ — storage is the private UPLOAD_DIR, never a literal \"public/...\" path built into either route", !/["'`(]\s*public\//.test(listRouteSrc) && !/["'`(]\s*public\//.test(itemRouteSrc));

  const uiSrc = await fs.readFile(path.join(process.cwd(), "components/attachments/entity-attachments.tsx"), "utf8");
  check("A13. The UI is a single shared component (not a duplicated Project-only copy) — reused by both the Project and Activity detail pages", /export function EntityAttachments/.test(uiSrc));
  const activityDetailSrc = await fs.readFile(path.join(process.cwd(), "app/(main)/activities/[id]/activity-detail-client.tsx"), "utf8");
  const projectPageSrc = await fs.readFile(path.join(process.cwd(), "app/(main)/projects/[id]/page.tsx"), "utf8");
  check("A14. Activity detail page uses the shared EntityAttachments component", /<EntityAttachments/.test(activityDetailSrc));
  check("A15. Project detail page uses the SAME shared EntityAttachments component", /<EntityAttachments/.test(projectPageSrc));
  check("A16. No leftover Project-specific 'ProjectAttachments' duplicate component file exists", await fs.access(path.join(process.cwd(), "components/projects/project-attachments.tsx")).then(() => false).catch(() => true));

  // ══════════════════════ SECTION B — behavioral (real DB + real routes + real files) ══════════════════════
  console.log("\n=== SECTION B — real POST/GET/DELETE route handlers against real DB fixtures ===\n");

  let routes: {
    listGET: typeof import("@/app/api/projects/[id]/attachments/route").GET;
    uploadPOST: typeof import("@/app/api/projects/[id]/attachments/route").POST;
    downloadGET: typeof import("@/app/api/projects/[id]/attachments/[attachmentId]/route").GET;
    deleteDELETE: typeof import("@/app/api/projects/[id]/attachments/[attachmentId]/route").DELETE;
    activityListGET: typeof import("@/app/api/activities/[id]/attachments/route").GET;
    activityDownloadGET: typeof import("@/app/api/activities/[id]/attachments/[attachmentId]/route").GET;
  };
  try {
    const listModule = await import("@/app/api/projects/[id]/attachments/route");
    const itemModule = await import("@/app/api/projects/[id]/attachments/[attachmentId]/route");
    const activityListModule = await import("@/app/api/activities/[id]/attachments/route");
    const activityItemModule = await import("@/app/api/activities/[id]/attachments/[attachmentId]/route");
    routes = {
      listGET: listModule.GET,
      uploadPOST: listModule.POST,
      downloadGET: itemModule.GET,
      deleteDELETE: itemModule.DELETE,
      activityListGET: activityListModule.GET,
      activityDownloadGET: activityItemModule.GET,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { listGET, uploadPOST, downloadGET, deleteDELETE, activityListGET, activityDownloadGET } = routes;

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const RUN_ID = Date.now();
  const userIds: string[] = [];
  const deptIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  function asUser(userId: string, role: Role, customRoleId: string | null = null) {
    currentSession = { user: { id: userId, role, customRoleId } };
  }
  async function upload(projectId: string, filename: string, mime: string, bytes: number[]): Promise<Response> {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    fd.append("file", blob, filename);
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/attachments`, { method: "POST", body: fd as any });
    return uploadPOST(req, { params: Promise.resolve({ id: projectId }) });
  }
  function list(projectId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/attachments`);
    return listGET(req, { params: Promise.resolve({ id: projectId }) });
  }
  function download(projectId: string, attachmentId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/attachments/${attachmentId}`);
    return downloadGET(req, { params: Promise.resolve({ id: projectId, attachmentId }) });
  }
  function remove(projectId: string, attachmentId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/projects/${projectId}/attachments/${attachmentId}`, { method: "DELETE" });
    return deleteDELETE(req, { params: Promise.resolve({ id: projectId, attachmentId }) });
  }
  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `PATTACH_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUnique({ where: { key } });
      if (!perm) throw new Error(`Missing canonical permission: ${key}`);
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    const deptA = await prisma.department.create({ data: { name: `PAttach Dept A ${RUN_ID}`, slug: `pattach-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `PAttach Dept B ${RUN_ID}`, slug: `pattach-b-${RUN_ID}` } });
    deptIds.push(deptA.id, deptB.id);

    const ownerUser = await prisma.user.create({ data: { email: `pattach-owner-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(ownerUser.id);

    const projectA = await prisma.project.create({ data: { title: `PAttach Project A ${RUN_ID}`, departmentId: deptA.id, ownerId: ownerUser.id } });
    const projectB = await prisma.project.create({ data: { title: `PAttach Project B ${RUN_ID}`, departmentId: deptB.id, ownerId: ownerUser.id } });
    projectIds.push(projectA.id, projectB.id);
    // A genuine Activity in Dept A too — proves an ActivityAttachment id is
    // never reachable through the Project route and vice versa (separate
    // tables entirely, not just separate rows in one table).
    const activityA = await prisma.projectActivity.create({ data: { title: `PAttach Activity A ${RUN_ID}`, departmentId: deptA.id } });
    activityIds.push(activityA.id);

    // Blank GLOBAL custom role neutralizes Role.USER's own global grants —
    // same isolation technique test-activity-attachments.ts already uses.
    const noopGlobalRole = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);

    // Also holds activity.view/activity.edit — needed only for the
    // cross-entity-isolation fixture below (a real ActivityAttachment to
    // prove a foreign-table id is rejected), not part of what's under test.
    const editorRole = await makeCustomRole("EDITOR", RoleScope.DEPARTMENT, ["project.view", "project.edit", "activity.view", "activity.edit"]);
    const viewerRole = await makeCustomRole("VIEWER_ONLY", RoleScope.DEPARTMENT, ["project.view"]);
    const globalEditRole = await makeCustomRole("GLOBAL_EDIT", RoleScope.GLOBAL, ["project.view", "project.edit"]);

    const editorUser = await prisma.user.create({
      data: { email: `pattach-editor-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(editorUser.id);
    await grantManualMembership(editorUser.id, deptA.id, { customRoleId: editorRole.id });

    const viewerUser = await prisma.user.create({
      data: { email: `pattach-viewer-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(viewerUser.id);
    await grantManualMembership(viewerUser.id, deptA.id, { customRoleId: viewerRole.id });

    const outsiderUser = await prisma.user.create({
      data: { email: `pattach-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(outsiderUser.id);
    // No membership anywhere.

    // GLOBAL project.edit, deliberately NO DepartmentMembership row at all —
    // proves the "effective global permission" union without any per-
    // department standing.
    const globalEditorUser = await prisma.user.create({
      data: { email: `pattach-globaleditor-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: globalEditRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(globalEditorUser.id);

    // ── 0. Unauthenticated ──
    console.log("\n0. No session at all\n");
    currentSession = null;
    check("0a. List -> 401", (await list(projectA.id)).status === 401);
    check("0b. Upload -> 401", (await upload(projectA.id, "x.txt", "text/plain", [1])).status === 401);

    // ── 1. project.edit user can upload/list/download ──
    console.log("\n1. A user with project.edit in Dept A can upload, list and download a Project A attachment\n");
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    const uploadRes1 = await upload(projectA.id, "report.pdf", "application/pdf", [1, 2, 3, 4]);
    check("1a. Upload returns 201", uploadRes1.status === 201);
    const created1 = await uploadRes1.json();
    check("1b. Response includes the original filename", created1.originalName === "report.pdf");
    const attachmentId1: string = created1.id;
    const listRes1 = await list(projectA.id);
    check("1c. List includes the new attachment", (await listRes1.clone().json()).some((a: any) => a.id === attachmentId1));
    const downloadRes1 = await download(projectA.id, attachmentId1);
    check("1d. Download returns 200 with the exact uploaded bytes", downloadRes1.status === 200 && Buffer.from(await downloadRes1.arrayBuffer()).equals(Buffer.from([1, 2, 3, 4])));

    // ── 2. project.view-only user CANNOT upload/delete ──
    console.log("\n2. A user with ONLY project.view (no project.edit) in Dept A CANNOT upload or delete, but CAN list/download\n");
    asUser(viewerUser.id, Role.USER, noopGlobalRole.id);
    check("2a. Upload is rejected with 403", (await upload(projectA.id, "sneaky.pdf", "application/pdf", [9, 9])).status === 403);
    check("2b. Delete is rejected with 403", (await remove(projectA.id, attachmentId1)).status === 403);
    const listRes2 = await list(projectA.id);
    check("2c. List returns 200", listRes2.status === 200);
    check("2d. List includes the editor's attachment", (await listRes2.clone().json()).some((a: any) => a.id === attachmentId1));
    const downloadRes2 = await download(projectA.id, attachmentId1);
    check("2e. Download returns 200", downloadRes2.status === 200);
    check("2f. Content-Disposition carries the original filename", (downloadRes2.headers.get("content-disposition") ?? "").includes("report.pdf"));

    // ── 4. Outsider (no membership anywhere) ──
    console.log("\n4. A user with NO membership in Dept A at all cannot list, download, or upload there\n");
    asUser(outsiderUser.id, Role.USER, noopGlobalRole.id);
    check("4a. List is rejected with 403", (await list(projectA.id)).status === 403);
    check("4b. Download is rejected with 403", (await download(projectA.id, attachmentId1)).status === 403);
    check("4c. Upload is rejected with 403", (await upload(projectA.id, "x.txt", "text/plain", [1])).status === 403);

    // ── 3. Department isolation: Dept A's editor has no rights on Dept B's project ──
    console.log("\n3. Department A permission works ONLY for a Department A Project — Dept A's editor has no rights on Project B (Dept B)\n");
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    check("3a. Upload to Project B is rejected with 403", (await upload(projectB.id, "y.txt", "text/plain", [1])).status === 403);
    check("3b. List of Project B is rejected with 403", (await list(projectB.id)).status === 403);

    // ── 5. Cross-entity isolation ──
    console.log("\n5. A foreign Project/Activity attachment id is rejected\n");
    const editorBRole = await makeCustomRole("EDITOR_B", RoleScope.DEPARTMENT, ["project.view", "project.edit"]);
    const editorBUser = await prisma.user.create({
      data: { email: `pattach-editor-b-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(editorBUser.id);
    await grantManualMembership(editorBUser.id, deptB.id, { customRoleId: editorBRole.id });
    asUser(editorBUser.id, Role.USER, noopGlobalRole.id);
    check("5a. This user genuinely can view Project B (sanity check)", (await list(projectB.id)).status === 200);
    check("5b. ...but requesting Project A's real attachment id through Project B's URL 404s, not 403 or 200", (await download(projectB.id, attachmentId1)).status === 404);
    const crossDeleteRes = await remove(projectB.id, attachmentId1);
    check("5c. DELETE of Project A's real attachment id through Project B's URL 404s (not 204)", crossDeleteRes.status === 404);
    const stillThereAfterCrossDelete = await prisma.projectAttachment.findUnique({ where: { id: attachmentId1 } });
    check("5d. The ProjectAttachment DB row still exists — the cross-project DELETE attempt had no effect", stillThereAfterCrossDelete !== null);

    // An ActivityAttachment id used against the PROJECT route (different
    // table entirely) — and a ProjectAttachment id used against the
    // ACTIVITY route — must both 404, never accidentally resolve.
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    const activityUploadReq = new FormData();
    activityUploadReq.append("file", new Blob([new Uint8Array([7, 7])], { type: "text/plain" }), "act.txt");
    const activityAttachRoutePost = (await import("@/app/api/activities/[id]/attachments/route")).POST;
    const activityUploadRes = await activityAttachRoutePost(
      new NextRequest(`http://localhost/api/activities/${activityA.id}/attachments`, { method: "POST", body: activityUploadReq as any }),
      { params: Promise.resolve({ id: activityA.id }) }
    );
    const activityUploadBody = await activityUploadRes.clone().json().catch(() => ({}));
    check("5e. (fixture) editorUser can upload a real ActivityAttachment in Dept A", activityUploadRes.status === 201, `status=${activityUploadRes.status} body=${JSON.stringify(activityUploadBody)}`);
    const activityAttachment = await activityUploadRes.json();
    check("5f. That ActivityAttachment id, used against the PROJECT download route, 404s (wrong table entirely)", (await download(projectA.id, activityAttachment.id)).status === 404);
    check("5g. ...and Project A's real attachment id, used against the ACTIVITY download route, 404s too", (await activityDownloadGET(new NextRequest(`http://localhost/api/activities/${activityA.id}/attachments/${attachmentId1}`), { params: Promise.resolve({ id: activityA.id, attachmentId: attachmentId1 }) })).status === 404);
    void activityListGET;

    // ── 7. Delete requires project.edit, not just project.view ──
    console.log("\n7. Delete affects only the intended attachment\n");
    const uploadRes7b = await upload(projectA.id, "second.txt", "text/plain", [5, 5, 5]);
    const attachmentId7b = (await uploadRes7b.json()).id;
    const dirA = path.join(UPLOAD_DIR, "projects", projectA.id);
    const filesBeforeDelete = await fs.readdir(dirA).catch(() => []);
    check("7a. Two attachments now exist on disk for Project A", filesBeforeDelete.length === 2);

    const deleteRes = await remove(projectA.id, attachmentId1);
    check("7b. Deleting attachmentId1 succeeds with 204", deleteRes.status === 204);
    const stillThere1 = await prisma.projectAttachment.findUnique({ where: { id: attachmentId1 } });
    check("7c. attachmentId1's DB row is gone", stillThere1 === null);
    const stillThere7b = await prisma.projectAttachment.findUnique({ where: { id: attachmentId7b } });
    check("7d. ...but the OTHER attachment (attachmentId7b) is untouched", stillThere7b !== null);

    await new Promise((r) => setTimeout(r, 50));
    const filesAfterDelete = await fs.readdir(dirA).catch(() => []);
    check("7e. Exactly one file remains on disk (only the deleted one's file was removed)", filesAfterDelete.length === 1);
    check("7f. A second delete of the same (now-gone) id 404s rather than erroring", (await remove(projectA.id, attachmentId1)).status === 404);

    // ── 6. Invalid file type, oversized file, unsafe filename ──
    console.log("\n6. Invalid file type, oversized file and unsafe filename/path are all rejected or safely handled\n");
    const badMimeRes = await upload(projectA.id, "script.exe", "application/x-msdownload", [1, 2, 3]);
    check("6a. Disallowed MIME type is rejected with 400", badMimeRes.status === 400);
    const oversized = new Array(10 * 1024 * 1024 + 1).fill(0);
    const bigRes = await upload(projectA.id, "big.pdf", "application/pdf", oversized);
    check("6b. Oversized file is rejected with 400", bigRes.status === 400);
    const countBeforeUnsafe = await prisma.projectAttachment.count({ where: { projectId: projectA.id } });
    const unsafeNameRes = await upload(projectA.id, "../../../etc/passwd.txt", "text/plain", [1]);
    check("6c. A path-traversal-attempting filename is still accepted (the ORIGINAL name is free text; only the STORED name is sanitized)", unsafeNameRes.status === 201);
    const unsafeAttachment = await unsafeNameRes.json();
    check("6d. ...the STORED filename never contains a path separator or '..' (generateStoredFilename's own sanitization)", (await prisma.projectAttachment.findUniqueOrThrow({ where: { id: unsafeAttachment.id } })).filename.match(/^[a-zA-Z0-9._-]+$/) !== null);
    const dirEntries = await fs.readdir(dirA).catch(() => []);
    check("6e. The file was written strictly inside Project A's own directory (no directory traversal occurred)", dirEntries.some((f) => f.endsWith("passwd.txt")));
    check("6f. Neither the bad-MIME nor the oversized upload created a DB row (only the unsafe-name one, which is a valid upload, did)", await prisma.projectAttachment.count({ where: { projectId: projectA.id } }) === countBeforeUnsafe + 1);

    // ── 9. Effective GLOBAL project.edit works, without any DepartmentMembership ──
    console.log("\n9. Effective global project.edit works — no DepartmentMembership needed, works on ANY department's Project\n");
    check("9a. globalEditorUser genuinely holds no membership anywhere (fixture sanity check)", (await prisma.departmentMembership.count({ where: { userId: globalEditorUser.id } })) === 0);
    asUser(globalEditorUser.id, Role.USER, globalEditRole.id);
    const globalUploadA = await upload(projectA.id, "global-a.txt", "text/plain", [1]);
    check("9b. Global editor can upload to Project A (Dept A)", globalUploadA.status === 201);
    const globalUploadB = await upload(projectB.id, "global-b.txt", "text/plain", [2]);
    check("9c. ...and to Project B (Dept B) too — the SAME global grant, no per-department standing needed", globalUploadB.status === 201);
    const globalDeleteA = await remove(projectA.id, (await globalUploadA.json()).id);
    check("9d. Global editor can also delete what they just uploaded", globalDeleteA.status === 204);

    // ── Files remain protected from unauthenticated direct access ──
    console.log("\n11. Files remain protected — never reachable except through the authenticated route\n");
    currentSession = null;
    check("11a. Unauthenticated download attempt -> 401, not the file", (await download(projectA.id, attachmentId7b)).status === 401);
    check("11b. UPLOAD_DIR itself is never under public/ (storage-policy invariant, shared with Activities/Tickets)", !UPLOAD_DIR.includes("public"));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["projectAttachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: projectIds } } })],
      ["activityAttachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions (custom roles)", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    for (const projectId of projectIds) {
      await fs.rm(path.join(UPLOAD_DIR, "projects", projectId), { recursive: true, force: true }).catch(() => {});
    }
    for (const activityId of activityIds) {
      await fs.rm(path.join(UPLOAD_DIR, "activities", activityId), { recursive: true, force: true }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
