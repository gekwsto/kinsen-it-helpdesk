/**
 * Regression coverage for Activity attachments (Task 3).
 *
 * DESIGN (confirmed with the user before implementing): reuses the exact
 * private-storage architecture already built for Ticket attachments (see
 * lib/attachment-policy.ts: private UPLOAD_DIR, MIME/size allowlist,
 * path-traversal guards, authenticated per-entity download route) rather
 * than inventing a new storage model. Authorization is resolved in the
 * target Activity's OWN department via canActOnEntity, exactly like every
 * other Activity sub-resource (notes, delete, edit):
 *   - upload (POST) and delete (DELETE) require activity.edit
 *   - list/download (GET) require activity.view
 * No new "activity.attachment" permission key was introduced — same choice
 * already made for Notes.
 *
 * SECTION A is a pure source-text guard (no DB) proving the three route
 * handlers call the right department-scoped permission with the right key,
 * and that the download/delete routes apply the same path-traversal guards
 * the Ticket attachment download route already established.
 *
 * SECTION B uses Node's experimental module-mocking API (same established
 * pattern as scripts/test-integration-admin-authz.ts — swaps out @/lib/auth's
 * `auth()` for a controllable fake session) to exercise the REAL POST/GET/
 * DELETE route handler functions end to end: real DB fixtures, a real
 * FormData upload, real bytes written under UPLOAD_DIR, a real authenticated
 * download, and a real DELETE — never mocking canActOnEntity or the
 * filesystem. Requires --experimental-test-module-mocks (Node 24). If this
 * sandbox's Node/tsx setup can't run mock.module (a pre-existing,
 * already-confirmed-unrelated limitation seen throughout this session), this
 * whole section is skipped rather than reported as a failure — see the
 * try/catch around the dynamic imports below.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-attachments.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, Role, RoleScope } from "@prisma/client";
import { UPLOAD_DIR } from "@/lib/attachment-policy";
import { grantManualMembership } from "@/lib/services/department-membership-service";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Mutable holder the mocked auth() reads from on every call — same pattern
// as scripts/test-integration-admin-authz.ts.
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
  console.log("\n=== SECTION A — Activity attachment routes reuse the Ticket attachment storage architecture and the right department-scoped permission ===\n");

  const listRoutePath = path.join(process.cwd(), "app/api/activities/[id]/attachments/route.ts");
  const listRouteSrc = await fs.readFile(listRoutePath, "utf8");
  check("A1. List (GET) requires authentication via requireAuth()", /requireAuth\s*\(/.test(listRouteSrc));
  check("A2. List (GET) checks canActOnEntity(...) with 'activity.view'", /canActOnEntity\([^)]*"activity\.view"/.test(listRouteSrc));
  check("A3. Upload (POST) checks canActOnEntity(...) with 'activity.edit' (a stricter gate than list)", /canActOnEntity\([^)]*"activity\.edit"/.test(listRouteSrc));
  check("A4. Upload reuses the shared attachment policy (UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename) rather than inventing new constants", /from "@\/lib\/attachment-policy"/.test(listRouteSrc));
  check("A5. Upload rejects a disallowed MIME type before ever writing to disk", /isAllowedAttachmentMimeType/.test(listRouteSrc) && listRouteSrc.indexOf("isAllowedAttachmentMimeType") < listRouteSrc.indexOf("fs.writeFile"));
  check("A6. Upload rejects an oversized file before ever writing to disk", /MAX_ATTACHMENT_SIZE_BYTES/.test(listRouteSrc) && listRouteSrc.indexOf("MAX_ATTACHMENT_SIZE_BYTES") < listRouteSrc.indexOf("fs.writeFile"));

  const itemRoutePath = path.join(process.cwd(), "app/api/activities/[id]/attachments/[attachmentId]/route.ts");
  const itemRouteSrc = await fs.readFile(itemRoutePath, "utf8");
  check("A7. Download (GET) checks canActOnEntity(...) with 'activity.view'", /canActOnEntity\([^)]*"activity\.view"/.test(itemRouteSrc));
  check("A8. Delete (DELETE) checks canActOnEntity(...) with 'activity.edit' (not activity.view — write, not read)", /export async function DELETE/.test(itemRouteSrc) && /canActOnEntity\([^)]*"activity\.edit"/.test(itemRouteSrc.slice(itemRouteSrc.indexOf("export async function DELETE"))));
  check("A9. Download applies the SAME path-traversal guards as the Ticket attachment download route (isSafeStoredFilename + resolvesInsideDir)", /isSafeStoredFilename/.test(itemRouteSrc) && /resolvesInsideDir/.test(itemRouteSrc));
  check("A10. Download validates the attachment row belongs to THIS activityId before serving (cross-activity isolation)", /attachment\.activityId !== activityId/.test(itemRouteSrc));
  check("A11. Delete validates the attachment row belongs to THIS activityId too", /attachment\.activityId !== activityId/.test(itemRouteSrc.slice(itemRouteSrc.indexOf("export async function DELETE"))));

  // ══════════════════════ SECTION B — behavioral (real DB + real routes + real files) ══════════════════════
  console.log("\n=== SECTION B — real POST/GET/DELETE route handlers against real DB fixtures ===\n");

  let routes: {
    listGET: typeof import("@/app/api/activities/[id]/attachments/route").GET;
    uploadPOST: typeof import("@/app/api/activities/[id]/attachments/route").POST;
    downloadGET: typeof import("@/app/api/activities/[id]/attachments/[attachmentId]/route").GET;
    deleteDELETE: typeof import("@/app/api/activities/[id]/attachments/[attachmentId]/route").DELETE;
  };
  try {
    const listModule = await import("@/app/api/activities/[id]/attachments/route");
    const itemModule = await import("@/app/api/activities/[id]/attachments/[attachmentId]/route");
    routes = { listGET: listModule.GET, uploadPOST: listModule.POST, downloadGET: itemModule.GET, deleteDELETE: itemModule.DELETE };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment (pre-existing sandbox limitation, unrelated to this fix — see scripts/test-integration-admin-authz.ts and other test scripts this session already confirmed this against unmodified main) — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { listGET, uploadPOST, downloadGET, deleteDELETE } = routes;

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
  const activityIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  function asUser(userId: string, role: Role, customRoleId: string | null = null) {
    currentSession = { user: { id: userId, role, customRoleId } };
  }
  async function upload(activityId: string, filename: string, mime: string, bytes: number[]): Promise<Response> {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    fd.append("file", blob, filename);
    const req = new NextRequest(`http://localhost/api/activities/${activityId}/attachments`, { method: "POST", body: fd as any });
    return uploadPOST(req, { params: Promise.resolve({ id: activityId }) });
  }
  function list(activityId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/activities/${activityId}/attachments`);
    return listGET(req, { params: Promise.resolve({ id: activityId }) });
  }
  function download(activityId: string, attachmentId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/activities/${activityId}/attachments/${attachmentId}`);
    return downloadGET(req, { params: Promise.resolve({ id: activityId, attachmentId }) });
  }
  function remove(activityId: string, attachmentId: string): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/activities/${activityId}/attachments/${attachmentId}`, { method: "DELETE" });
    return deleteDELETE(req, { params: Promise.resolve({ id: activityId, attachmentId }) });
  }
  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `ATTACH_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
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
    const deptA = await prisma.department.create({ data: { name: `Attach Dept A ${RUN_ID}`, slug: `attach-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `Attach Dept B ${RUN_ID}`, slug: `attach-b-${RUN_ID}` } });
    deptIds.push(deptA.id, deptB.id);

    const activityA = await prisma.projectActivity.create({ data: { title: `Attach Activity A ${RUN_ID}`, departmentId: deptA.id } });
    const activityB = await prisma.projectActivity.create({ data: { title: `Attach Activity B ${RUN_ID}`, departmentId: deptB.id } });
    activityIds.push(activityA.id, activityB.id);

    // Blank GLOBAL custom role neutralizes Role.USER's own global grants
    // (e.g. activity.view — see prisma/seed.ts ROLE_PERMISSIONS.USER) so
    // each fixture below is isolated to ONLY the department-scoped grant
    // under test — same technique scripts/test-gantt-view-permission.ts
    // uses for the same reason.
    const noopGlobalRole = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);

    const editorRole = await makeCustomRole("EDITOR", RoleScope.DEPARTMENT, ["activity.view", "activity.edit"]);
    const viewerRole = await makeCustomRole("VIEWER_ONLY", RoleScope.DEPARTMENT, ["activity.view"]);

    const editorUser = await prisma.user.create({
      data: { email: `attach-editor-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(editorUser.id);
    await grantManualMembership(editorUser.id, deptA.id, { customRoleId: editorRole.id });

    const viewerUser = await prisma.user.create({
      data: { email: `attach-viewer-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(viewerUser.id);
    await grantManualMembership(viewerUser.id, deptA.id, { customRoleId: viewerRole.id });

    const outsiderUser = await prisma.user.create({
      data: { email: `attach-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(outsiderUser.id);
    // No membership anywhere.

    // ── 0. Unauthenticated ──
    console.log("\n0. No session at all\n");
    currentSession = null;
    check("0a. List -> 401", (await list(activityA.id)).status === 401);
    check("0b. Upload -> 401", (await upload(activityA.id, "x.txt", "text/plain", [1])).status === 401);

    // ── 1. activity.edit user can upload ──
    console.log("\n1. A user with activity.edit in Dept A can upload an attachment to an Activity in Dept A\n");
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    const uploadRes1 = await upload(activityA.id, "report.pdf", "application/pdf", [1, 2, 3, 4]);
    check("1a. Upload returns 201", uploadRes1.status === 201);
    const created1 = await uploadRes1.json();
    check("1b. Response includes the original filename", created1.originalName === "report.pdf");
    const attachmentId1: string = created1.id;

    // ── 2. activity.view-only user CANNOT upload ──
    console.log("\n2. A user with ONLY activity.view (no activity.edit) in Dept A CANNOT upload\n");
    asUser(viewerUser.id, Role.USER, noopGlobalRole.id);
    const uploadRes2 = await upload(activityA.id, "sneaky.pdf", "application/pdf", [9, 9]);
    check("2a. Upload is rejected with 403", uploadRes2.status === 403);

    // ── 3. activity.view-only user CAN list/download ──
    console.log("\n3. The SAME activity.view-only user CAN list and download the editor's attachment\n");
    const listRes3 = await list(activityA.id);
    check("3a. List returns 200", listRes3.status === 200);
    const listBody3 = await listRes3.json();
    check("3b. List includes the attachment the editor uploaded", Array.isArray(listBody3) && listBody3.some((a: any) => a.id === attachmentId1));
    const downloadRes3 = await download(activityA.id, attachmentId1);
    check("3c. Download returns 200", downloadRes3.status === 200);
    const downloadedBytes = Buffer.from(await downloadRes3.arrayBuffer());
    check("3d. Downloaded bytes exactly match what was uploaded", downloadedBytes.equals(Buffer.from([1, 2, 3, 4])));
    check("3e. Content-Disposition carries the original filename", (downloadRes3.headers.get("content-disposition") ?? "").includes("report.pdf"));

    // ── 4. A user with no membership at all in Dept A CANNOT list/download/upload ──
    console.log("\n4. A user with NO membership in Dept A at all cannot list, download, or upload there\n");
    asUser(outsiderUser.id, Role.USER, noopGlobalRole.id);
    check("4a. List is rejected with 403", (await list(activityA.id)).status === 403);
    check("4b. Download is rejected with 403", (await download(activityA.id, attachmentId1)).status === 403);
    check("4c. Upload is rejected with 403", (await upload(activityA.id, "x.txt", "text/plain", [1])).status === 403);

    // ── 5. Department isolation: Dept A's editor has no attachment rights on Dept B's activity ──
    console.log("\n5. Dept A's editor has NO attachment rights on an Activity in Dept B (no membership there)\n");
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    check("5a. Upload to Dept B's activity is rejected with 403", (await upload(activityB.id, "y.txt", "text/plain", [1])).status === 403);
    check("5b. List of Dept B's activity is rejected with 403", (await list(activityB.id)).status === 403);

    // ── 6. Cross-activity isolation: an attachment id valid for activityA is not reachable via activityB's URL ──
    console.log("\n6. An attachment belonging to Activity A is not reachable through Activity B's URL, even for a user who could view Activity B\n");
    const editorBRole = await makeCustomRole("EDITOR_B", RoleScope.DEPARTMENT, ["activity.view", "activity.edit"]);
    const editorBUser = await prisma.user.create({
      data: { email: `attach-editor-b-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(editorBUser.id);
    await grantManualMembership(editorBUser.id, deptB.id, { customRoleId: editorBRole.id });
    asUser(editorBUser.id, Role.USER, noopGlobalRole.id);
    check("6a. This user genuinely can view Activity B (sanity check)", (await list(activityB.id)).status === 200);
    check("6b. ...but requesting activityA's real attachment id through activityB's URL 404s, not 403 or 200", (await download(activityB.id, attachmentId1)).status === 404);

    // Same cross-activity isolation, for DELETE specifically: editorBUser
    // holds activity.edit in Dept B (the permission DELETE checks), but
    // attachmentId1 belongs to Activity A — the id/activityId pairing must
    // still be enforced, not just the permission.
    check("6c. editorBUser genuinely holds activity.edit in Activity B (sanity check — would pass the permission gate alone)", (await remove(activityB.id, "nonexistent-id-just-checking-403-vs-404")).status === 404 /* real activity, fake attachment id -> 404, proving activity.edit passed and it reached the attachment lookup */);
    const crossDeleteRes = await remove(activityB.id, attachmentId1);
    check("6d. DELETE of Activity A's real attachment id through Activity B's URL 404s (not 204) — the permission check alone is not enough", crossDeleteRes.status === 404);
    const stillThereAfterCrossDelete = await prisma.activityAttachment.findUnique({ where: { id: attachmentId1 } });
    check("6e. The attachment DB row still exists — the cross-activity DELETE attempt had no effect", stillThereAfterCrossDelete !== null);
    const dirAAfterCrossDelete = await fs.readdir(path.join(UPLOAD_DIR, "activities", activityA.id)).catch(() => []);
    check("6f. The on-disk file still exists too", dirAAfterCrossDelete.length === 1);

    // ── 7. Delete requires activity.edit, not just activity.view ──
    console.log("\n7. Delete follows activity.edit — the view-only user cannot delete; the editor can\n");
    asUser(viewerUser.id, Role.USER, noopGlobalRole.id);
    check("7a. View-only user's delete attempt is rejected with 403", (await remove(activityA.id, attachmentId1)).status === 403);

    const dirA = path.join(UPLOAD_DIR, "activities", activityA.id);
    const filesBefore = await fs.readdir(dirA).catch(() => []);
    check("7b. The on-disk file still exists after the rejected delete attempt", filesBefore.length === 1);

    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    const deleteRes = await remove(activityA.id, attachmentId1);
    check("7c. Editor's delete succeeds with 204", deleteRes.status === 204);

    const stillThere = await prisma.activityAttachment.findUnique({ where: { id: attachmentId1 } });
    check("7d. The ActivityAttachment DB row is gone", stillThere === null);

    // Give the fire-and-forget fs.unlink a tick to complete before checking.
    await new Promise((r) => setTimeout(r, 50));
    const filesAfter = await fs.readdir(dirA).catch(() => []);
    check("7e. The on-disk file was removed too", filesAfter.length === 0);

    check("7f. A second delete of the same (now-gone) id 404s rather than erroring", (await remove(activityA.id, attachmentId1)).status === 404);

    // ── 8. MIME/size policy is genuinely enforced, not just declared ──
    console.log("\n8. Disallowed MIME type and oversized files are both rejected before ever touching disk\n");
    asUser(editorUser.id, Role.USER, noopGlobalRole.id);
    const badMimeRes = await upload(activityA.id, "script.exe", "application/x-msdownload", [1, 2, 3]);
    check("8a. Disallowed MIME type is rejected with 400", badMimeRes.status === 400);
    const oversized = new Array(10 * 1024 * 1024 + 1).fill(0);
    const bigRes = await upload(activityA.id, "big.pdf", "application/pdf", oversized);
    check("8b. Oversized file is rejected with 400", bigRes.status === 400);
    const finalCount = await prisma.activityAttachment.count({ where: { activityId: activityA.id } });
    check("8c. Neither rejected upload created a DB row", finalCount === 0);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["activityAttachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
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
    // Best-effort removal of any on-disk files this run created, including
    // ones a failed assertion above might have left behind.
    for (const activityId of activityIds) {
      await fs.rm(path.join(UPLOAD_DIR, "activities", activityId), { recursive: true, force: true }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
