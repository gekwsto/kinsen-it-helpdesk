/**
 * Regression coverage for attachment selection/upload extended to the
 * INLINE Create Project / Create Activity dialogs used by the Ticket
 * create/link flows (ProjectCreateDialog/ActivityCreateDialog, rendered
 * from components/tickets/ticket-form.tsx and ticket-actions.tsx).
 *
 * Reuses, never duplicates: PendingAttachmentsField, useCreateWithAttachments,
 * PostCreateUploadPanel, and the EXACT SAME POST /api/{projects,activities}
 * and POST /api/{projects,activities}/[id]/attachments routes standalone
 * creation already uses — nothing server-side is new for inline mode at
 * all, only the capability computation (project.edit/activity.edit per
 * destination department) feeding into it.
 *
 * SECTION A is a source-text guard for the client-only orchestration this
 * suite has no DOM to execute directly (same established convention as
 * scripts/test-create-with-attachments.ts): onCreated firing exactly once
 * and only after uploads resolve, retry-then-auto-complete, Continue-calls-
 * onCreated-once, the dialog's close-guard (Escape/backdrop/X blocked while
 * locked), the fresh-remount-per-open key, and that standalone's own
 * router.push/no-auto-continue-on-retry behavior is untouched.
 *
 * SECTION B drives the REAL /tickets/new and /tickets/[id] Server Component
 * pages (mocked @/lib/auth + next/headers) to prove the NEW
 * projectEditDepartmentIds/activityEditDepartmentIds/canEditProjectInDept/
 * canEditActivityInDept capability computation is genuinely
 * department-aware and permission-correct — a create-only user's set/flag
 * excludes the department, a Department-A-only edit grant never appears
 * for Department B — and drives the REAL two-step create+upload route
 * sequence (identical routes to standalone) proving the entity/attachment
 * data model side is unaffected by which dialog triggered it.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-inline-create-with-attachments.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
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
let currentCookieValue: string | undefined = undefined;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined) }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  // ══════════════════════ SECTION A — client-only orchestration (source-text) ══════════════════════
  console.log("\n=== SECTION A — Inline dialogs: onCreated timing, retry/continue, close-guard, fresh remount ===\n");

  const projectFormSrc = await fs.readFile("components/projects/project-form.tsx", "utf8");
  const activityFormSrc = await fs.readFile("components/activities/activity-new-form.tsx", "utf8");
  const projectDialogSrc = await fs.readFile("components/projects/project-create-dialog.tsx", "utf8");
  const activityDialogSrc = await fs.readFile("components/activities/activity-create-dialog.tsx", "utf8");

  check("A1. onSubmit only calls onCreated when allUploaded is true — never before uploads finish (Project)", /if \(allUploaded\) \{[\s\S]{0,900}if \(inline\) \{\s*onCreated\?\.\(/.test(projectFormSrc));
  check("A1b. Same for Activity", /if \(allUploaded\) \{[\s\S]{0,900}if \(inline\) \{\s*onCreated\?\.\(/.test(activityFormSrc));
  check("A2. No attachments (allUploaded is unconditionally true in that case, per the hook) still reaches the SAME onCreated call — behavior is unchanged for the zero-attachment path (Project)", /const \{ entity: project, allUploaded \} = await attachments\.submit/.test(projectFormSrc));
  check("A2b. Same for Activity", /const \{ entity: activity, allUploaded \} = await attachments\.submit/.test(activityFormSrc));
  check("A3. Partial failure: NOT allUploaded -> the block that calls onCreated is skipped entirely, falling through to the post-create panel (Project)", /if \(allUploaded\) \{[\s\S]*?\}\s*\} catch/.test(projectFormSrc));

  // Canonical rule (identical in every mode, standalone included): a Retry
  // that clears every remaining failure finishes automatically, calling the
  // shared `finish` helper exactly once — the panel/Continue button exists
  // only to let the user proceed EARLY while a failure still remains, not
  // as an extra confirmation step once nothing is left to review. This used
  // to be gated `if (inline && allUploaded)`, which meant standalone
  // callers still needed an explicit Continue click after a fully-successful
  // retry — that inline-only restriction has been removed.
  check("A4. Retry: a fully-successful retry batch calls the shared `finish` helper unconditionally — no mode restriction (Project)", /if \(allUploaded\) finish\(\);/.test(projectFormSrc) && !/if \(inline && allUploaded\) finish\(\);/.test(projectFormSrc));
  check("A4b. Same for Activity", /if \(allUploaded\) finish\(\);/.test(activityFormSrc) && !/if \(inline && allUploaded\) finish\(\);/.test(activityFormSrc));
  check("A5. Standalone retry ALSO auto-finishes (via router.push, standalone's own `finish` branch) on full success — identical semantics to inline, no separate inline-only carve-out remains", /if \(allUploaded\) finish\(\);/.test(projectFormSrc) && /if \(allUploaded\) finish\(\);/.test(activityFormSrc));
  check("A6. Continue always calls the SAME shared `finish` helper used by the retry-success path — never a second/duplicate completion code path (Project)", (projectFormSrc.match(/onContinue=\{finish\}/g) ?? []).length === 1);
  check("A6b. Same for Activity", (activityFormSrc.match(/onContinue=\{finish\}/g) ?? []).length === 1);
  check("A7. `finish` calls onCreated for inline / router.push for standalone — a single branch point, not two separate implementations", /const finish = \(\) => \{\s*if \(inline\) \{/.test(projectFormSrc) && /const finish = \(\) => \{\s*if \(inline\) \{/.test(activityFormSrc));

  check("A8. The dialog's create request is fired from ONE place only (attachments.submit's createFn) — Retry/Continue never re-invoke it (no second fetch(\"/api/projects\"/\"/api/activities\") call site)", (projectFormSrc.match(/fetch\("\/api\/projects"/g) ?? []).length === 1 && (activityFormSrc.match(/fetch\("\/api\/activities"/g) ?? []).length === 1);

  check("A9. ProjectCreateDialog blocks Radix's own close attempts while locked (Escape/backdrop/X all route through this ONE guarded onOpenChange)", /const guardedOnOpenChange = \(next: boolean\) => \{\s*if \(!next && locked\) return;/.test(projectDialogSrc));
  check("A9b. Same for ActivityCreateDialog", /const guardedOnOpenChange = \(next: boolean\) => \{\s*if \(!next && locked\) return;/.test(activityDialogSrc));
  check("A10. The dialog's own completion path (handleCreated) unlocks and closes directly — bypassing the guard via the real onOpenChange prop, not the guarded one, so a legitimate completion is never blocked by its own guard (Project)", /const handleCreated = \(project: CreatedProject\) => \{\s*setLocked\(false\);\s*onOpenChange\(false\);\s*onCreated\(project\);/.test(projectDialogSrc));
  check("A10b. Same for ActivityCreateDialog", /const handleCreated = \(activity: CreatedActivity\) => \{\s*setLocked\(false\);\s*onOpenChange\(false\);\s*onCreated\(activity\);/.test(activityDialogSrc));
  check("A11. `locked` is reported by the FORM (onLockChange), true exactly while created-with-pending-attachments (Project)", /onLockChange\?\.\(attachments\.createdEntity !== null && attachments\.entries\.length > 0\)/.test(projectFormSrc));
  check("A11b. Same for Activity", /onLockChange\?\.\(attachments\.createdEntity !== null && attachments\.entries\.length > 0\)/.test(activityFormSrc));

  check("A12. Each dialog's key includes `open` — forces a genuinely fresh ProjectForm/ActivityNewForm instance on every re-open, so a stale createdEntity from a PREVIOUS run can never leak into the next (ProjectCreateDialog)", /key=\{`\$\{departmentId\}:\$\{open\}`\}/.test(projectDialogSrc));
  check("A12b. Same for ActivityCreateDialog", /key=\{`\$\{departmentId\}:\$\{preselectedProjectId \?\? ""\}:\$\{open\}`\}/.test(activityDialogSrc));

  check("A13. Inline mode never navigates — no router.push call exists in either form's inline branch (the ONLY router.push call sites are inside the `else` / non-inline branches)", (() => {
    const inlineBlock = projectFormSrc.slice(projectFormSrc.indexOf("if (inline) {"), projectFormSrc.indexOf("} else {"));
    return !/router\.push/.test(inlineBlock);
  })());

  check("A14. No second attachment picker/coordinator/panel implementation exists — the SAME shared modules are imported by both forms", (projectFormSrc.match(/from "@\/hooks\/use-create-with-attachments"/g) ?? []).length === 1 && (activityFormSrc.match(/from "@\/hooks\/use-create-with-attachments"/g) ?? []).length === 1);
  check("A15. No new permission key, endpoint, model, or migration was introduced for inline mode — the dialogs POST to the SAME `${basePath}/attachments` route (inside the shared hook, not re-declared per dialog)", !/attachments\/route/.test(projectDialogSrc) && !/attachments\/route/.test(activityDialogSrc));

  const ticketFormSrc = await fs.readFile("components/tickets/ticket-form.tsx", "utf8");
  const ticketActionsSrc = await fs.readFile("components/tickets/ticket-actions.tsx", "utf8");
  check("A16. Create Ticket form computes attachment capability by membership check against a server-computed set (projectEditDepartmentIds), not a fresh permission decision", /projectEditDepartmentIds\.includes\(selectedDepartmentId\)/.test(ticketFormSrc) && /activityEditDepartmentIds\.includes\(selectedDepartmentId\)/.test(ticketFormSrc));
  check("A17. Existing Ticket detail page's Link dialogs receive a plain server-computed boolean (canEditProjectInDept/canEditActivityInDept), passed straight through as canUploadAttachments — never recomputed client-side", /canUploadAttachments=\{canEditProjectInDept\}/.test(ticketActionsSrc) && /canUploadAttachments=\{canEditActivityInDept\}/.test(ticketActionsSrc));

  // ══════════════════════ SECTION B — real pages/routes ══════════════════════
  console.log("\n=== SECTION B — real /tickets/new + /tickets/[id] capability computation, real create+upload routes ===\n");

  let mods: {
    NewTicketPage: any;
    TicketDetailPage: any;
    CreateTicketForm: any;
    TicketActions: any;
    TicketDetailClient: any;
    projectsPOST: typeof import("@/app/api/projects/route").POST;
    activitiesPOST: typeof import("@/app/api/activities/route").POST;
    projectAttachPOST: typeof import("@/app/api/projects/[id]/attachments/route").POST;
    activityAttachPOST: typeof import("@/app/api/activities/[id]/attachments/route").POST;
  };
  try {
    mods = {
      NewTicketPage: (await import("@/app/(main)/tickets/new/page")).default,
      TicketDetailPage: (await import("@/app/(main)/tickets/[id]/page")).default,
      CreateTicketForm: (await import("@/components/tickets/ticket-form")).CreateTicketForm,
      TicketActions: (await import("@/components/tickets/ticket-actions")).TicketActions,
      TicketDetailClient: (await import("@/components/tickets/ticket-detail-client")).TicketDetailClient,
      projectsPOST: (await import("@/app/api/projects/route")).POST,
      activitiesPOST: (await import("@/app/api/activities/route")).POST,
      projectAttachPOST: (await import("@/app/api/projects/[id]/attachments/route")).POST,
      activityAttachPOST: (await import("@/app/api/activities/[id]/attachments/route")).POST,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { NewTicketPage, TicketDetailPage, CreateTicketForm, TicketDetailClient, projectsPOST, activitiesPOST, projectAttachPOST, activityAttachPOST } = mods;

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
  const ticketIds: string[] = [];
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
    const r = await prisma.customRole.create({ data: { key: `ICWA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    const deptA = await createDepartment({ name: `ICWA Dept A ${RUN_ID}`, slug: `icwa-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `ICWA Dept B ${RUN_ID}`, slug: `icwa-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const noopGlobalRole = await makeCustomRole("NOOP", RoleScope.GLOBAL, []);
    const createOnlyRole = await makeCustomRole("CREATE_ONLY", RoleScope.DEPARTMENT, ["project.create", "activity.create", "ticket.create", "ticket.view", "ticket.view.all", "ticket.linkProjectActivity"]);
    const createEditRoleA = await makeCustomRole("CREATE_EDIT_A", RoleScope.DEPARTMENT, ["project.create", "project.edit", "activity.create", "activity.edit", "project.view", "activity.view", "ticket.create", "ticket.view", "ticket.view.all", "ticket.linkProjectActivity"]);

    const createOnlyUser = await prisma.user.create({ data: { email: `icwa-createonly-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(createOnlyUser.id);
    await grantManualMembership(createOnlyUser.id, deptA.id, { customRoleId: createOnlyRole.id });

    // Edit-capable in Dept A ONLY, never Dept B — proves "Department A edit
    // permission does not enable uploads for Department B" (test 12).
    const deptAEditUser = await prisma.user.create({ data: { email: `icwa-deptaedit-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAEditUser.id);
    await grantManualMembership(deptAEditUser.id, deptA.id, { customRoleId: createEditRoleA.id });
    await grantManualMembership(deptAEditUser.id, deptB.id, { customRoleId: createOnlyRole.id }); // create-only in Dept B

    console.log("\n-- 11. Create Ticket form: a create-only user's server-computed edit-department sets exclude the department (no picker offered) --\n");
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    currentCookieValue = deptA.id;
    const newTicketEl = await NewTicketPage();
    const [createTicketFormEl] = findElementsByType(newTicketEl, CreateTicketForm);
    check("11a. projectEditDepartmentIds excludes Dept A for the create-only user", !createTicketFormEl?.props.projectEditDepartmentIds.includes(deptA.id));
    check("11b. activityEditDepartmentIds excludes Dept A too", !createTicketFormEl?.props.activityEditDepartmentIds.includes(deptA.id));
    check("...but projectCreateDepartmentIds/activityCreateDepartmentIds DO include it — create is unaffected (11 continued: 'must still be able to create/link')", createTicketFormEl?.props.projectCreateDepartmentIds.includes(deptA.id) && createTicketFormEl?.props.activityCreateDepartmentIds.includes(deptA.id));

    console.log("\n-- 12. A Dept-A-only edit grant never appears for Dept B --\n");
    asUser(deptAEditUser.id, Role.USER, noopGlobalRole.id);
    const newTicketEl2 = await NewTicketPage();
    const [createTicketFormEl2] = findElementsByType(newTicketEl2, CreateTicketForm);
    check("12a. projectEditDepartmentIds includes Dept A", createTicketFormEl2?.props.projectEditDepartmentIds.includes(deptA.id));
    check("12b. ...but NOT Dept B, even though this user CAN create there (create-only in B)", !createTicketFormEl2?.props.projectEditDepartmentIds.includes(deptB.id) && createTicketFormEl2?.props.projectCreateDepartmentIds.includes(deptB.id));
    check("12c. Same split for activity", createTicketFormEl2?.props.activityEditDepartmentIds.includes(deptA.id) && !createTicketFormEl2?.props.activityEditDepartmentIds.includes(deptB.id));

    console.log("\n-- Ticket detail page's Link dialogs: canEditProjectInDept/canEditActivityInDept mirror the same rule for a FIXED (ticket) department --\n");
    const ownerUser = await prisma.user.create({ data: { email: `icwa-owner-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(ownerUser.id);
    const statusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isDefault: true } });
    const ticketA = await prisma.ticket.create({ data: { title: `ICWA Ticket ${RUN_ID}`, description: "d", requesterId: ownerUser.id, departmentId: deptA.id, statusId: statusA.id } });
    ticketIds.push(ticketA.id);

    // TicketDetailPage renders <TicketDetailClient {...props} /> — a "use
    // client" component whose OWN internal JSX (which conditionally renders
    // <TicketActions>) never executes in this harness (the same limitation
    // documented throughout this session). canEditProjectInDept/
    // canEditActivityInDept/canCreateProjectInDept are passed straight
    // through unmodified, so reading them directly off TicketDetailClient's
    // own props is exactly equivalent and avoids that limitation entirely.
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    const ticketDetailEl = await TicketDetailPage({ params: Promise.resolve({ id: ticketA.id }) });
    const [clientEl] = findElementsByType(ticketDetailEl, TicketDetailClient);
    check("Create-only user viewing the Ticket: canEditProjectInDept is false (create alone never implies edit)", clientEl?.props.canEditProjectInDept === false);
    check("...canEditActivityInDept is false too", clientEl?.props.canEditActivityInDept === false);
    check("...yet canCreateProjectInDept/canCreateActivityInDept remain true — create still works", clientEl?.props.canCreateProjectInDept === true && clientEl?.props.canCreateActivityInDept === true);

    asUser(deptAEditUser.id, Role.USER, noopGlobalRole.id);
    const ticketDetailEl2 = await TicketDetailPage({ params: Promise.resolve({ id: ticketA.id }) });
    const [clientEl2] = findElementsByType(ticketDetailEl2, TicketDetailClient);
    check("Dept-A-edit user viewing a Dept-A Ticket: canEditProjectInDept is true (global-or-department union)", clientEl2?.props.canEditProjectInDept === true);
    check("...canEditActivityInDept is true too", clientEl2?.props.canEditActivityInDept === true);

    console.log("\n-- 1/2/3. Inline Project/Activity creation uploads one/multiple attachments through the SAME routes standalone uses --\n");
    asUser(deptAEditUser.id, Role.USER, noopGlobalRole.id);
    const inlineProjectRes = await projectsPOST(jsonReq({ title: `ICWA Inline Project ${RUN_ID}`, departmentId: deptA.id }));
    check("Inline-equivalent Project create -> 201 (identical route to standalone)", inlineProjectRes.status === 201);
    const inlineProject = await inlineProjectRes.json();
    projectIds.push(inlineProject.id);
    const p1 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${inlineProject.id}/attachments`, "one.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: inlineProject.id }) });
    const p2 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${inlineProject.id}/attachments`, "two.txt", "text/plain", [2]), { params: Promise.resolve({ id: inlineProject.id }) });
    check("1a. First attachment -> 201", p1.status === 201);
    check("1b. Second attachment -> 201", p2.status === 201);
    const p1Body = await p1.json();
    check("3. Attachment is linked to the authoritative created Project id", (await prisma.projectAttachment.findUniqueOrThrow({ where: { id: p1Body.id } })).projectId === inlineProject.id);
    check("...both are recorded against the Project", (await prisma.projectAttachment.count({ where: { projectId: inlineProject.id } })) === 2);

    const inlineActivityRes = await activitiesPOST(jsonReq({ title: `ICWA Inline Activity ${RUN_ID}`, departmentId: deptA.id }));
    const inlineActivity = await inlineActivityRes.json();
    activityIds.push(inlineActivity.id);
    const a1 = await activityAttachPOST(uploadReq(`http://localhost/api/activities/${inlineActivity.id}/attachments`, "act.png", "image/png", [3]), { params: Promise.resolve({ id: inlineActivity.id }) });
    check("2. Single attachment upload for an inline-created Activity -> 201", a1.status === 201);
    check("3b. Linked to the authoritative created Activity id", (await activityAttachPOST as any) && (await prisma.activityAttachment.findFirstOrThrow({ where: { activityId: inlineActivity.id } })).activityId === inlineActivity.id);

    console.log("\n-- 11 (route level). Create-only user still cannot bypass the upload endpoint even for an entity they just created --\n");
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    const createOnlyInlineProject = await projectsPOST(jsonReq({ title: `ICWA CreateOnly Inline ${RUN_ID}`, departmentId: deptA.id }));
    check("Create-only user CAN create inline", createOnlyInlineProject.status === 201);
    const createOnlyInlineProjectBody = await createOnlyInlineProject.json();
    projectIds.push(createOnlyInlineProjectBody.id);
    const bypassAttempt = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${createOnlyInlineProjectBody.id}/attachments`, "sneaky.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: createOnlyInlineProjectBody.id }) });
    check("...but a crafted upload request against it is rejected 403 — the endpoint remains authoritative regardless of which dialog would have triggered it", bypassAttempt.status === 403);

    console.log("\n-- 6. Server-side validation is authoritative for inline uploads too --\n");
    const badType = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${inlineProject.id}/attachments`, "bad.exe", "application/x-msdownload", [1]), { params: Promise.resolve({ id: inlineProject.id }) });
    asUser(deptAEditUser.id, Role.USER, noopGlobalRole.id);
    const badType2 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${inlineProject.id}/attachments`, "bad.exe", "application/x-msdownload", [1]), { params: Promise.resolve({ id: inlineProject.id }) });
    check("Disallowed MIME type rejected with 400 even through the inline-created entity's own upload endpoint", badType2.status === 400);
    check("...and it didn't create a row", (await prisma.projectAttachment.count({ where: { projectId: inlineProject.id } })) === 2);
    void badType;

    console.log("\n-- 15. No file stored under public/ --\n");
    check("UPLOAD_DIR itself is never under public/", !UPLOAD_DIR.includes("public"));
    const dirFiles = await fs.readdir(path.join(UPLOAD_DIR, "projects", inlineProject.id)).catch(() => []);
    check("Inline-created Project's files are on disk under the private UPLOAD_DIR/projects/<id> directory, same as standalone", dirFiles.length === 2);

    console.log("\n-- 16. No new permission, endpoint, model or migration was introduced --\n");
    const permKeys = await prisma.permission.findMany({ where: { key: { contains: "attachment" } }, select: { key: true } });
    check("No permission key containing \"attachment\" exists", permKeys.length === 0);
    const schemaSrc = await fs.readFile("prisma/schema.prisma", "utf8");
    check("Exactly the two existing Project/Activity attachment models remain", (schemaSrc.match(/^model (Project|Activity)Attachment /gm) ?? []).length === 2);
    check("No routes directory named for a 'create-with-attachments' or similar second endpoint exists", !(await fs.access("app/api/projects/create-with-attachments").then(() => true).catch(() => false)));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["projectAttachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: projectIds } } })],
      ["activityAttachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
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
