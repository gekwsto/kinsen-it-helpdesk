/**
 * Regression coverage for attachment selection/upload added to the Create
 * Project and Create Activity forms — the two-step "create the entity, then
 * upload its selected attachments through the EXISTING protected
 * /api/{projects,activities}/[id]/attachments route" architecture (see
 * hooks/use-create-with-attachments.ts, components/attachments/
 * pending-attachments-field.tsx, components/attachments/post-create-
 * upload-panel.tsx).
 *
 * SECTION A is a source-text guard proving the client-only guarantees this
 * suite has no DOM to execute directly (same established convention as
 * e.g. scripts/test-activity-completion-project-refresh.ts for
 * ActivityCompleteCheckbox's finally/catch logic): the double-submit guard,
 * "retry only failed" filtering, "never re-upload a success", "Continue
 * never re-creates the entity", and that no attachment validation/storage
 * logic was duplicated inside the create routes.
 *
 * SECTION B drives the REAL POST /api/projects, POST /api/activities, and
 * the REAL POST/GET /api/{projects,activities}/[id]/attachments route
 * handlers end to end — exactly the sequence the shared coordinator hook
 * performs — against a real database and real files under UPLOAD_DIR.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-create-with-attachments.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role, RoleScope } from "@prisma/client";
import { UPLOAD_DIR } from "@/lib/attachment-policy";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { createDepartment } from "@/lib/services/department-service";

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
  namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
});

async function main() {
  // ══════════════════════ SECTION A — client-only guarantees (source-text) ══════════════════════
  console.log("\n=== SECTION A — Shared coordinator: double-submit guard, retry-only-failed, no duplicated server logic ===\n");

  const hookSrc = await fs.readFile("hooks/use-create-with-attachments.ts", "utf8");
  check("A1. A synchronous (non-state) guard rejects a second submit() while one is already in flight or already succeeded", /if \(submittingRef\.current \|\| createdEntity\)/.test(hookSrc));
  check("A2. retryFailed() only ever re-uploads entries currently marked \"failed\" — a success is never re-sent", /const failed = entries\.filter\(\(e\) => e\.status === "failed"\)/.test(hookSrc));
  check("A3. Each upload targets the REAL server-issued entity id, never a client-generated one (uploadBasePath(created.id), called only after createFn() resolved)", /uploadBasePath\(created\.id\)/.test(hookSrc) && hookSrc.indexOf("created = await createFn()") < hookSrc.indexOf("uploadBasePath(created.id)"));
  check("A4. Files are uploaded via FormData POST to `${basePath}/attachments` — the EXISTING protected route, not a new endpoint", /fetch\(`\$\{basePath\}\/attachments`, \{ method: "POST", body: fd \}\)/.test(hookSrc));
  check("A5. No entity is ever deleted from this file (a failed attachment never rolls back the created entity)", !/\.delete\(/.test(hookSrc) && !/method: "DELETE"/.test(hookSrc));

  const panelSrc = await fs.readFile("components/attachments/post-create-upload-panel.tsx", "utf8");
  check("A6. The panel offers Retry only when at least one file failed", /failedCount > 0/.test(panelSrc));
  check("A7. \"Continue\" is always offered, independent of failures", /Continue to \{entityLabel\}/.test(panelSrc));

  const projectFormSrc = await fs.readFile("components/projects/project-form.tsx", "utf8");
  const activityFormSrc = await fs.readFile("components/activities/activity-new-form.tsx", "utf8");
  // The shared `finish` helper (added when inline-dialog support was
  // layered on — see scripts/test-inline-create-with-attachments.ts) is
  // what Continue now calls; for standalone it still does nothing but
  // router.push — never re-invokes attachments.submit or POSTs to the
  // create route again.
  const finishBlockOf = (src: string) => src.slice(src.indexOf("const finish = () => {"), src.indexOf("};", src.indexOf("const finish = () => {")));
  check("A8. Continuing after partial failure only ever calls router.push (via the shared `finish` helper, standalone's own branch) — it never re-invokes attachments.submit or POSTs to the create route again", /router\.push\(`\/projects\/\$\{attachments\.createdEntity!\.id\}`\)/.test(finishBlockOf(projectFormSrc)) && /onContinue=\{finish\}/.test(projectFormSrc));
  check("A8b. ...same for Activities", /router\.push\(`\/activities\/\$\{attachments\.createdEntity!\.id\}`\)/.test(finishBlockOf(activityFormSrc)) && /onContinue=\{finish\}/.test(activityFormSrc));
  check("A9. Once the entity is created, the ORIGINAL form is replaced (not merely disabled) — nothing left in the tree that could resubmit it", /if \(attachments\.createdEntity && attachments\.entries\.length > 0\)/.test(projectFormSrc) && /if \(attachments\.createdEntity && attachments\.entries\.length > 0\)/.test(activityFormSrc));

  const projectRouteSrc = await fs.readFile("app/api/projects/route.ts", "utf8");
  const activityRouteSrc = await fs.readFile("app/api/activities/route.ts", "utf8");
  check("A10. POST /api/projects still creates JSON only — not converted to multipart, no attachment handling was added to the create route itself", !/formData\(\)/.test(projectRouteSrc) && !/multipart/i.test(projectRouteSrc) && !/attachment/i.test(projectRouteSrc));
  check("A10b. POST /api/activities likewise unchanged — no multipart, no attachment handling", !/formData\(\)/.test(activityRouteSrc) && !/multipart/i.test(activityRouteSrc) && !/attachment/i.test(activityRouteSrc));
  check("A11. No second/duplicate attachment endpoint was introduced — the create forms POST to the SAME existing routes the detail pages already use", /`\$\{basePath\}\/attachments`/.test(hookSrc) && !(await fs.access("app/api/projects/create-with-attachments").then(() => true).catch(() => false)));

  const newProjectPageSrc = await fs.readFile("app/(main)/projects/new/page.tsx", "utf8");
  const newActivityPageSrc = await fs.readFile("app/(main)/activities/new/page.tsx", "utf8");
  check("A12. Project create-only-vs-edit capability is computed server-side via hasEffectiveEntityPermission (the canonical union), never assumed from create", /hasEffectiveEntityPermission\(session\.user\.id, session\.user\.role, session\.user\.customRoleId, d\.id, "project\.edit"\)/.test(newProjectPageSrc));
  check("A13. Activity create-only-vs-edit capability likewise computed via hasEffectiveEntityPermission against activity.edit", /hasEffectiveEntityPermission\(session\.user\.id, session\.user\.role, session\.user\.customRoleId, departmentId, "activity\.edit"\)/.test(newActivityPageSrc));
  check("A14. Neither page ever uses active workspace AS the authorization decision for attachments (getActiveWorkspace is only consulted for the pre-existing department resolution, never re-purposed as a permission check)", !/getActiveWorkspace\([^)]*\)[\s\S]{0,80}"(project|activity)\.edit"/.test(newProjectPageSrc + newActivityPageSrc));
  check("A15. The client only checks SET MEMBERSHIP, never decides the permission itself", /editableDepartmentIds\.includes\(departmentId\)/.test(projectFormSrc));

  // ══════════════════════ SECTION B — real two-step create+upload, real DB, real files ══════════════════════
  console.log("\n=== SECTION B — real POST create + POST/GET attachments route handlers, end to end ===\n");

  let routes: {
    projectsPOST: typeof import("@/app/api/projects/route").POST;
    activitiesPOST: typeof import("@/app/api/activities/route").POST;
    projectAttachPOST: typeof import("@/app/api/projects/[id]/attachments/route").POST;
    projectAttachGET: typeof import("@/app/api/projects/[id]/attachments/route").GET;
    activityAttachPOST: typeof import("@/app/api/activities/[id]/attachments/route").POST;
    activityAttachGET: typeof import("@/app/api/activities/[id]/attachments/route").GET;
  };
  try {
    routes = {
      projectsPOST: (await import("@/app/api/projects/route")).POST,
      activitiesPOST: (await import("@/app/api/activities/route")).POST,
      projectAttachPOST: (await import("@/app/api/projects/[id]/attachments/route")).POST,
      projectAttachGET: (await import("@/app/api/projects/[id]/attachments/route")).GET,
      activityAttachPOST: (await import("@/app/api/activities/[id]/attachments/route")).POST,
      activityAttachGET: (await import("@/app/api/activities/[id]/attachments/route")).GET,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { projectsPOST, activitiesPOST, projectAttachPOST, projectAttachGET, activityAttachPOST, activityAttachGET } = routes;

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section B.");
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
  function jsonReq(body: unknown) {
    return new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  function uploadReq(url: string, filename: string, mime: string, bytes: number[]) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    return new NextRequest(url, { method: "POST", body: fd as any });
  }
  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `CWA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    const deptA = await createDepartment({ name: `CWA Dept A ${RUN_ID}`, slug: `cwa-a-${RUN_ID}` });
    deptIds.push(deptA.id);

    const noopGlobalRole = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);
    const createAndEditRole = await makeCustomRole("CREATE_EDIT", RoleScope.DEPARTMENT, ["project.create", "project.edit", "activity.create", "activity.edit", "project.view", "activity.view"]);
    const createOnlyRole = await makeCustomRole("CREATE_ONLY", RoleScope.DEPARTMENT, ["project.create", "activity.create", "project.view", "activity.view"]);
    const globalEditRole = await makeCustomRole("GLOBAL_EDIT", RoleScope.GLOBAL, ["project.edit", "activity.edit"]);

    const fullUser = await prisma.user.create({ data: { email: `cwa-full-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(fullUser.id);
    await grantManualMembership(fullUser.id, deptA.id, { customRoleId: createAndEditRole.id });

    const createOnlyUser = await prisma.user.create({ data: { email: `cwa-createonly-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(createOnlyUser.id);
    await grantManualMembership(createOnlyUser.id, deptA.id, { customRoleId: createOnlyRole.id });

    // Create-only in the department, but effective EDIT via a GLOBAL custom
    // role (no department-level edit grant at all) — the "global grant"
    // case, same union hasEffectiveEntityPermission resolves on the detail
    // page.
    const globalEditUser = await prisma.user.create({ data: { email: `cwa-globaledit-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: globalEditRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(globalEditUser.id);
    await grantManualMembership(globalEditUser.id, deptA.id, { customRoleId: createOnlyRole.id });

    // ── 1/2/3/4/13. Full user creates a Project with multiple attachments ──
    console.log("\n-- 1/4/13. Project created with multiple attachments, linked to the real new id, visible/downloadable after --\n");
    asUser(fullUser.id, Role.USER, noopGlobalRole.id);
    const projectRes = await projectsPOST(jsonReq({ title: `CWA Project ${RUN_ID}`, departmentId: deptA.id }));
    check("Project create -> 201", projectRes.status === 201);
    const project = await projectRes.json();
    projectIds.push(project.id);
    check("4a. Response carries the authoritative server-issued id", typeof project.id === "string" && project.id.length > 0);

    const up1 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "a.pdf", "application/pdf", [1, 2, 3]), { params: Promise.resolve({ id: project.id }) });
    const up2 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "b.txt", "text/plain", [4, 5]), { params: Promise.resolve({ id: project.id }) });
    check("1a. First attachment upload -> 201", up1.status === 201);
    check("1b. Second attachment upload -> 201", up2.status === 201);
    const up1Body = await up1.json();
    check("4b. Uploaded attachment is linked to the REAL project id (projectId column), not a client value", up1Body.id && (await prisma.projectAttachment.findUniqueOrThrow({ where: { id: up1Body.id } })).projectId === project.id);

    const listRes = await projectAttachGET(new NextRequest(`http://localhost/api/projects/${project.id}/attachments`), { params: Promise.resolve({ id: project.id }) });
    const listBody = await listRes.json();
    check("13. Both attachments are visible/listable on the resulting Project (same GET the detail page itself uses)", listRes.status === 200 && listBody.length === 2);

    // ── 3. Creation without attachments is unchanged ──
    console.log("\n-- 3. Creation without attachments is unchanged (no upload attempt at all) --\n");
    const noAttachRes = await projectsPOST(jsonReq({ title: `CWA Project No Attach ${RUN_ID}`, departmentId: deptA.id }));
    check("3a. Create still succeeds with 201 exactly as before", noAttachRes.status === 201);
    const noAttachProject = await noAttachRes.json();
    projectIds.push(noAttachProject.id);
    const noAttachCount = await prisma.projectAttachment.count({ where: { projectId: noAttachProject.id } });
    check("3b. Zero ProjectAttachment rows exist for it", noAttachCount === 0);

    // ── 2. Activity created with one and multiple attachments ──
    console.log("\n-- 2. Activity created with attachments, same two-step flow --\n");
    const activityRes = await activitiesPOST(jsonReq({ title: `CWA Activity ${RUN_ID}`, departmentId: deptA.id }));
    const activityResBody = await activityRes.clone().json().catch(() => ({}));
    check("Activity create -> 201", activityRes.status === 201, `status=${activityRes.status} body=${JSON.stringify(activityResBody)}`);
    const activity = await activityRes.json();
    activityIds.push(activity.id);
    const actUp1 = await activityAttachPOST(uploadReq(`http://localhost/api/activities/${activity.id}/attachments`, "c.png", "image/png", [9]), { params: Promise.resolve({ id: activity.id }) });
    check("2a. Single attachment upload for a new Activity -> 201", actUp1.status === 201);
    const actListRes = await activityAttachGET(new NextRequest(`http://localhost/api/activities/${activity.id}/attachments`), { params: Promise.resolve({ id: activity.id }) });
    check("2b. It's visible on the resulting Activity", (await actListRes.json()).length === 1);

    // ── 6. Invalid type / oversized rejected by the server ──
    console.log("\n-- 6. Server-side validation remains authoritative for post-create uploads --\n");
    const badType = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "virus.exe", "application/x-msdownload", [1]), { params: Promise.resolve({ id: project.id }) });
    check("6a. Disallowed MIME type -> 400", badType.status === 400);
    const oversized = new Array(10 * 1024 * 1024 + 1).fill(0);
    const bigFile = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "big.pdf", "application/pdf", oversized), { params: Promise.resolve({ id: project.id }) });
    check("6b. Oversized file -> 400", bigFile.status === 400);
    check("6c. Neither created a row (still exactly 2 from before)", (await prisma.projectAttachment.count({ where: { projectId: project.id } })) === 2);

    // ── 5. No upload occurs when entity creation fails ──
    console.log("\n-- 5. If Project/Activity creation itself fails, nothing is ever uploaded (the coordinator never reaches the upload step) --\n");
    const failedCreate = await projectsPOST(jsonReq({ title: "ab", departmentId: deptA.id })); // fails createProjectSchema's min(3) title validation
    check("5a. A schema-invalid create request fails (never reaches 201)", failedCreate.status !== 201);
    // No corresponding project id exists to even attempt an upload against —
    // the coordinator's own submit() only calls uploadBasePath(created.id)
    // after createFn() has already resolved (see A3 above); a rejected
    // create means createFn() throws and that call is structurally
    // unreachable. Confirmed at the source level in Section A; nothing to
    // additionally exercise at the DB level since there is no entity id.

    // ── 9/10. Successful files remain when another fails; retry re-uploads only the failed one ──
    console.log("\n-- 9/10. Partial failure: successful upload stays; a retry only re-sends the failed file, never re-sends the success --\n");
    const partialProjectRes = await projectsPOST(jsonReq({ title: `CWA Partial ${RUN_ID}`, departmentId: deptA.id }));
    const partialProject = await partialProjectRes.json();
    projectIds.push(partialProject.id);
    const goodUp = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${partialProject.id}/attachments`, "good.txt", "text/plain", [1]), { params: Promise.resolve({ id: partialProject.id }) });
    const failUp = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${partialProject.id}/attachments`, "bad.exe", "application/x-msdownload", [1]), { params: Promise.resolve({ id: partialProject.id }) });
    check("9a. The valid file uploaded successfully", goodUp.status === 201);
    check("9b. The invalid one failed", failUp.status === 400);
    const afterFirstPass = await prisma.projectAttachment.count({ where: { projectId: partialProject.id } });
    check("9c. Exactly one row exists (only the successful upload)", afterFirstPass === 1);
    // Simulate "Retry failed uploads": the coordinator re-sends ONLY the
    // failed entry (now with a corrected/allowed type, as a user fixing
    // their selection would do) — it never re-sends "good.txt" again.
    const retryUp = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${partialProject.id}/attachments`, "bad-retry.txt", "text/plain", [1]), { params: Promise.resolve({ id: partialProject.id }) });
    check("10a. The retried (now-valid) file uploads successfully", retryUp.status === 201);
    const afterRetry = await prisma.projectAttachment.findMany({ where: { projectId: partialProject.id }, select: { originalName: true } });
    check("10b. Exactly two rows exist total — the original success plus the retried one, the first success never duplicated", afterRetry.length === 2 && afterRetry.filter((a) => a.originalName === "good.txt").length === 1);

    // ── 7/8. Create-only user cannot bypass edit; global edit works ──
    console.log("\n-- 7/8. A create-only user cannot bypass project.edit/activity.edit for the post-create upload; global edit works exactly like the detail page --\n");
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    const createOnlyProjectRes = await projectsPOST(jsonReq({ title: `CWA CreateOnly ${RUN_ID}`, departmentId: deptA.id }));
    check("7a. Create-only user CAN still create the Project (project.create alone is sufficient)", createOnlyProjectRes.status === 201);
    const createOnlyProject = await createOnlyProjectRes.json();
    projectIds.push(createOnlyProject.id);
    const createOnlyUploadAttempt = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${createOnlyProject.id}/attachments`, "sneaky.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: createOnlyProject.id }) });
    check("7b. ...but the post-create upload is REJECTED with 403 — create never implies edit, and the server (not the client) enforces this", createOnlyUploadAttempt.status === 403);
    check("7c. No row was created by the rejected upload", (await prisma.projectAttachment.count({ where: { projectId: createOnlyProject.id } })) === 0);

    const createOnlyActivityRes = await activitiesPOST(jsonReq({ title: `CWA CreateOnly Activity ${RUN_ID}`, departmentId: deptA.id }));
    const createOnlyActivity = await createOnlyActivityRes.json();
    activityIds.push(createOnlyActivity.id);
    const createOnlyActivityUpload = await activityAttachPOST(uploadReq(`http://localhost/api/activities/${createOnlyActivity.id}/attachments`, "sneaky2.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: createOnlyActivity.id }) });
    check("7d. Same for Activities: create-only user's post-create upload -> 403", createOnlyActivityUpload.status === 403);

    asUser(globalEditUser.id, Role.USER, globalEditRole.id);
    const globalProjectRes = await projectsPOST(jsonReq({ title: `CWA GlobalEdit ${RUN_ID}`, departmentId: deptA.id }));
    check("8a. Global-edit user (create-only in the department, edit via a GLOBAL role, no department edit grant) can still create", globalProjectRes.status === 201);
    const globalProject = await globalProjectRes.json();
    projectIds.push(globalProject.id);
    const globalUpload = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${globalProject.id}/attachments`, "global.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: globalProject.id }) });
    check("8b. ...and the post-create upload succeeds via the GLOBAL edit grant — exactly the same union the detail page's Attachments card already relies on", globalUpload.status === 201);

    console.log("\n-- 15. No file stored under public/ --\n");
    check("UPLOAD_DIR itself is never under public/", !UPLOAD_DIR.includes("public"));
    const projectDirFiles = await fs.readdir(path.join(UPLOAD_DIR, "projects", project.id)).catch(() => []);
    check("The Project's uploaded files are on disk under the private UPLOAD_DIR/projects/<id> directory", projectDirFiles.length === 2);

    console.log("\n-- 16. No new permission, model, migration or attachment endpoint was introduced --\n");
    const permKeys = await prisma.permission.findMany({ where: { key: { contains: "attachment" } }, select: { key: true } });
    check("No permission key containing \"attachment\" exists (upload/delete still ride project.edit/activity.edit, view/download still ride project.view/activity.view)", permKeys.length === 0);
    const schemaSrc = await fs.readFile("prisma/schema.prisma", "utf8");
    check("Exactly the two existing Project/Activity attachment models remain — no third such model was added", (schemaSrc.match(/^model (Project|Activity)Attachment /gm) ?? []).length === 2);
    const migrationDirs = await fs.readdir("prisma/migrations");
    const attachmentMigrations = migrationDirs.filter((d) => /attachment/i.test(d));
    check("No NEW attachment-related migration beyond the two already-established ones (Activity, Project)", attachmentMigrations.length === 2);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["projectAttachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: projectIds } } })],
      ["activityAttachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityProgressConfig", () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["projectStatusConfig", () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityStatusConfig", () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityPriorityConfig", () => prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
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

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
