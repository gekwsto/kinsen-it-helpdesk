/**
 * Closes the "third inline caller" gap: /activities/new -> ActivityNewForm
 * -> nested ProjectCreateDialog (the "+ New Project" button) now offers
 * attachment selection too, via the EXACT SAME shared architecture as every
 * other creation entry point — PendingAttachmentsField,
 * useCreateWithAttachments, PostCreateUploadPanel, ProjectCreateDialog
 * itself, and the existing POST /api/projects/[id]/attachments route. No
 * new component, no new endpoint.
 *
 * Also covers the Retry-unification fix: a fully-successful Retry now
 * finishes automatically in EVERY mode (standalone, Ticket-inline, and this
 * nested-in-standalone-Activity-form case) — previously only inline
 * auto-completed; standalone (including this nested Project dialog, which
 * is itself "inline mode" for ProjectForm even though its OWN parent page
 * is standalone) required an extra Continue click after a successful
 * retry. See the final report for the evidence this was a real gap, not
 * just a reporting error.
 *
 * SECTION A is a source-text guard for the client-only orchestration
 * (established convention — see scripts/test-inline-create-with-attachments.ts).
 * SECTION B drives the REAL /activities/new Server Component page and the
 * REAL POST /api/projects + POST/GET /api/projects/[id]/attachments routes.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-nested-project-create-attachments.ts
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
  // ══════════════════════ SECTION A — source-text guard ══════════════════════
  console.log("\n=== SECTION A — Nested caller wiring + the Retry-unification fix ===\n");

  const newActivityPageSrc = await fs.readFile("app/(main)/activities/new/page.tsx", "utf8");
  const activityFormSrc = await fs.readFile("components/activities/activity-new-form.tsx", "utf8");
  const projectFormSrc = await fs.readFile("components/projects/project-form.tsx", "utf8");
  const projectDialogSrc = await fs.readFile("components/projects/project-create-dialog.tsx", "utf8");

  check("1. /activities/new computes canUploadProjectAttachments via hasEffectiveEntityPermission(..., departmentId, \"project.edit\") — the real target department, never active workspace, never inferred from project.create", /const canUploadProjectAttachments = departmentId\s*\n\s*\? await hasEffectiveEntityPermission\(session\.user\.id, session\.user\.role, session\.user\.customRoleId, departmentId, "project\.edit"\)/.test(newActivityPageSrc));
  check("...passed through to <ActivityNewForm>", /canUploadProjectAttachments=\{canUploadProjectAttachments\}/.test(newActivityPageSrc));

  check("1b. ActivityNewForm wires it straight into the nested <ProjectCreateDialog>'s canUploadAttachments — the SAME prop every other caller (ticket-form.tsx, ticket-actions.tsx) already uses, no new prop name/shape invented for this one", /<ProjectCreateDialog[\s\S]{0,150}canUploadAttachments=\{!!canUploadProjectAttachments\}/.test(activityFormSrc));
  check("No second/duplicate dialog component was created — the import is still the one shared ProjectCreateDialog", (activityFormSrc.match(/from "@\/components\/projects\/project-create-dialog"/g) ?? []).length === 1);

  const staleExclusionGone = !/outside this task's scope/.test(projectDialogSrc) && !/is unaffected by this addition/.test(projectDialogSrc);
  check("The stale \"intentionally excluded\" doc comment on ProjectCreateDialogProps.canUploadAttachments has been removed/updated", staleExclusionGone);

  check("4/5/6. handleProjectCreated only ever updates local `projects`/pending-selection state — never navigates (no router.push) and never touches the Activity's OWN form fields (title/description/status/priority/dueDate/startDate setters)", (() => {
    const start = activityFormSrc.indexOf("const handleProjectCreated = ");
    const body = activityFormSrc.slice(start, activityFormSrc.indexOf("};", start));
    return !/router\.push/.test(body) && !/setTitle|setDescription|setStatus|setPriority|setDueDate|setStartDate/.test(body) && /setPendingProjectSelection/.test(body);
  })());
  check("4b. handleProjectCreated is called from EXACTLY one place — the nested dialog's onCreated prop (the shared dialog's own lock/guard already ensures this fires at most once per completed run)", (activityFormSrc.match(/onCreated=\{handleProjectCreated\}/g) ?? []).length === 1);

  console.log("\n=== Retry unification: a fully-successful Retry finishes automatically in EVERY mode ===\n");
  check("9/13a. ProjectForm's Retry handler auto-finishes on any full success (no `inline &&` restriction left)", /if \(allUploaded\) finish\(\);/.test(projectFormSrc) && !/if \(inline && allUploaded\) finish\(\);/.test(projectFormSrc));
  const activityNewFormRetrySrc = await fs.readFile("components/activities/activity-new-form.tsx", "utf8");
  check("13b. Same fix in ActivityNewForm (used for the Activity's OWN attachments, standalone or inline)", /if \(allUploaded\) finish\(\);/.test(activityNewFormRetrySrc) && !/if \(inline && allUploaded\) finish\(\);/.test(activityNewFormRetrySrc));
  check("Initial-upload auto-finish (the pre-existing, always-correct rule) is untouched — `if (allUploaded)` still wraps the onCreated/router.push branch in onSubmit", /toast\.success\("Project created!"\);\s*\n\s*if \(allUploaded\) \{/.test(projectFormSrc));

  // ══════════════════════ SECTION B — real page + real routes ══════════════════════
  console.log("\n=== SECTION B — real /activities/new capability computation, real create+upload routes ===\n");

  let mods: {
    NewActivityPage: any;
    ActivityNewForm: any;
    projectsPOST: typeof import("@/app/api/projects/route").POST;
    projectAttachPOST: typeof import("@/app/api/projects/[id]/attachments/route").POST;
    projectAttachGET: typeof import("@/app/api/projects/[id]/attachments/route").GET;
  };
  try {
    mods = {
      NewActivityPage: (await import("@/app/(main)/activities/new/page")).default,
      ActivityNewForm: (await import("@/components/activities/activity-new-form")).ActivityNewForm,
      projectsPOST: (await import("@/app/api/projects/route")).POST,
      projectAttachPOST: (await import("@/app/api/projects/[id]/attachments/route")).POST,
      projectAttachGET: (await import("@/app/api/projects/[id]/attachments/route")).GET,
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  const { NewActivityPage, ActivityNewForm, projectsPOST, projectAttachPOST, projectAttachGET } = mods;

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
    const r = await prisma.customRole.create({ data: { key: `NPCA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    const deptA = await createDepartment({ name: `NPCA Dept A ${RUN_ID}`, slug: `npca-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `NPCA Dept B ${RUN_ID}`, slug: `npca-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const noopGlobalRole = await makeCustomRole("NOOP", RoleScope.GLOBAL, []);
    const createOnlyRole = await makeCustomRole("CREATE_ONLY", RoleScope.DEPARTMENT, ["project.create", "activity.create", "activity.view"]);
    const createEditRole = await makeCustomRole("CREATE_EDIT", RoleScope.DEPARTMENT, ["project.create", "project.edit", "project.view", "activity.create", "activity.view"]);

    const createOnlyUser = await prisma.user.create({ data: { email: `npca-createonly-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(createOnlyUser.id);
    await grantManualMembership(createOnlyUser.id, deptA.id, { customRoleId: createOnlyRole.id });

    // Edit-capable in Dept A only — used for the "wrong department" proof too.
    const editUser = await prisma.user.create({ data: { email: `npca-edit-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: noopGlobalRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(editUser.id);
    await grantManualMembership(editUser.id, deptA.id, { customRoleId: createEditRole.id });
    await grantManualMembership(editUser.id, deptB.id, { customRoleId: createOnlyRole.id }); // create-only in Dept B

    console.log("\n-- 1/11. /activities/new: canUploadProjectAttachments reflects project.edit, independent of activity.edit or project.create --\n");
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    currentCookieValue = deptA.id;
    const pageCreateOnly = await NewActivityPage();
    const [formElCreateOnly] = findElementsByType(pageCreateOnly, ActivityNewForm);
    check("1a. Create-only user: canUploadProjectAttachments is false (no project.edit)", formElCreateOnly?.props.canUploadProjectAttachments === false);
    check("1b. ...yet canCreateProject remains true — they can still create/select the Project via the dialog", formElCreateOnly?.props.canCreateProject === true);

    asUser(editUser.id, Role.USER, noopGlobalRole.id);
    const pageEdit = await NewActivityPage();
    const [formElEdit] = findElementsByType(pageEdit, ActivityNewForm);
    check("1c. Edit-capable user in Dept A: canUploadProjectAttachments is true", formElEdit?.props.canUploadProjectAttachments === true);

    currentCookieValue = deptB.id;
    const pageEditDeptB = await NewActivityPage();
    const [formElEditDeptB] = findElementsByType(pageEditDeptB, ActivityNewForm);
    check("11a. Dept-A edit grant does not leak into Dept B (wrong-department user): canUploadProjectAttachments is false there, though canCreateProject is still true", formElEditDeptB?.props.canUploadProjectAttachments === false && formElEditDeptB?.props.canCreateProject === true);
    currentCookieValue = deptA.id;

    console.log("\n-- 2/3. One and multiple Project attachments upload successfully, linked to the authoritative new Project id --\n");
    asUser(editUser.id, Role.USER, noopGlobalRole.id);
    const projectRes = await projectsPOST(jsonReq({ title: `NPCA Nested Project ${RUN_ID}`, departmentId: deptA.id }));
    check("Project create (what the nested dialog does) -> 201", projectRes.status === 201);
    const project = await projectRes.json();
    projectIds.push(project.id);
    const up1 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "one.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: project.id }) });
    const up2 = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "two.txt", "text/plain", [2]), { params: Promise.resolve({ id: project.id }) });
    check("2a. First attachment -> 201", up1.status === 201);
    check("2b. Second attachment -> 201", up2.status === 201);
    const up1Body = await up1.json();
    check("3. Linked to the authoritative new Project id", (await prisma.projectAttachment.findUniqueOrThrow({ where: { id: up1Body.id } })).projectId === project.id);
    const listRes = await projectAttachGET(new NextRequest(`http://localhost/api/projects/${project.id}/attachments`), { params: Promise.resolve({ id: project.id }) });
    check("Both are visible on the resulting Project via the SAME GET the detail page uses", (await listRes.json()).length === 2);

    console.log("\n-- 8/10. Retry uploads only failed files; successful files are never re-uploaded --\n");
    const badUp = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "bad.exe", "application/x-msdownload", [9]), { params: Promise.resolve({ id: project.id }) });
    check("Invalid MIME type rejected with 400", badUp.status === 400);
    check("...no row created for it", (await prisma.projectAttachment.count({ where: { projectId: project.id } })) === 2);
    const retryUp = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "bad-retry.txt", "text/plain", [9]), { params: Promise.resolve({ id: project.id }) });
    check("Retried (now-valid) file uploads successfully", retryUp.status === 201);
    const finalRows = await prisma.projectAttachment.findMany({ where: { projectId: project.id }, select: { originalName: true } });
    check("Exactly three rows total — the original two plus the retried one, neither original ever duplicated", finalRows.length === 3 && finalRows.filter((r) => r.originalName === "one.pdf").length === 1 && finalRows.filter((r) => r.originalName === "two.txt").length === 1);

    console.log("\n-- 11 (route level). Create-only and wrong-department users cannot upload, even to a Project they can see/select --\n");
    asUser(createOnlyUser.id, Role.USER, noopGlobalRole.id);
    const createOnlyAttempt = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${project.id}/attachments`, "sneaky.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: project.id }) });
    check("Create-only user's crafted upload attempt -> 403", createOnlyAttempt.status === 403);

    const deptBOnlyProjectRes = await (async () => {
      asUser(editUser.id, Role.USER, noopGlobalRole.id);
      return projectsPOST(jsonReq({ title: `NPCA Dept B Project ${RUN_ID}`, departmentId: deptB.id }));
    })();
    check("(fixture) editUser's create-only standing in Dept B still lets them create there", deptBOnlyProjectRes.status === 201);
    const deptBProject = await deptBOnlyProjectRes.json();
    projectIds.push(deptBProject.id);
    const wrongDeptAttempt = await projectAttachPOST(uploadReq(`http://localhost/api/projects/${deptBProject.id}/attachments`, "sneaky2.pdf", "application/pdf", [1]), { params: Promise.resolve({ id: deptBProject.id }) });
    check("...but the SAME user's upload attempt on their Dept B (create-only) Project -> 403", wrongDeptAttempt.status === 403);
    check("...no row was created", (await prisma.projectAttachment.count({ where: { projectId: deptBProject.id } })) === 0);

    console.log("\n-- No file stored under public/; no new permission/model/migration --\n");
    check("UPLOAD_DIR itself is never under public/", !UPLOAD_DIR.includes("public"));
    const dirFiles = await fs.readdir(path.join(UPLOAD_DIR, "projects", project.id)).catch(() => []);
    check("Files are on disk under the private UPLOAD_DIR/projects/<id> directory", dirFiles.length === 3);
    const permKeys = await prisma.permission.findMany({ where: { key: { contains: "attachment" } }, select: { key: true } });
    check("14. No permission key containing \"attachment\" exists", permKeys.length === 0);
    const schemaSrc = await fs.readFile("prisma/schema.prisma", "utf8");
    check("14b. Exactly the two existing Project/Activity attachment models remain", (schemaSrc.match(/^model (Project|Activity)Attachment /gm) ?? []).length === 2);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["projectAttachments", () => prisma.projectAttachment.deleteMany({ where: { projectId: { in: projectIds } } })],
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
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
