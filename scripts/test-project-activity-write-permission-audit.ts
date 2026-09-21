/**
 * Project/Activity WRITE-permission effective-union audit.
 *
 * Bare canActOnEntity only resolves the ADMIN/DIRECTOR bypass or a
 * DepartmentMembership — never a global built-in/CustomRole grant. For every
 * outer mutation gate whose permission legitimately supports global grants
 * (see the evidence below) the decision is hasEffectiveEntityPermission:
 * global grant OR the ENTITY'S OWN department grant.
 *
 * EVIDENCE that project.edit / project.delete / activity.edit /
 * activity.delete are global-grantable (asserted in section 0 below):
 *   - prisma/seed.ts gives the GLOBAL built-in roles IT_AGENT and
 *     DEPARTMENT_MANAGER project.edit + activity.edit;
 *   - the role editor (app/api/admin/roles/[id]/permissions/[permId]) only
 *     refuses admin.access/user.manage/role.manage on non-GLOBAL roles, so a
 *     GLOBAL CustomRole may hold ANY project.* / activity.* key, delete included;
 *   - hasPermission() is generic over permission key and role.
 * Global built-ins hold no X.delete in the seed (only ADMIN's bypass and
 * DepartmentRole DEPARTMENT_ADMIN do), so "built-in global delete" is proven
 * for ADMIN and "global grant delete" via a GLOBAL CustomRole.
 *
 * GATES INTENTIONALLY RETAINED (asserted below, not changed):
 *   - project/activity CREATE (resolveDepartmentForCreate): creating INTO a
 *     department requires standing there (documented department-scope-service);
 *   - moving an entity to another department requires standing (membership +
 *     *.create) in the TARGET department — a business rule, kept for global
 *     editors too (only ADMIN bypasses);
 *   - dependency create/delete: ADMIN-only, no permission key at all.
 *
 * Also proves the business rules stayed: status/isCompleted consistency,
 * attachment ownership (a foreign attachment id 404s), view-only grants no
 * mutation, inactive membership / inactive custom role grants nothing,
 * active workspace has no authority.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-activity-write-permission-audit.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role, RoleScope } from "@prisma/client";
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
let currentCookieDepartmentId: string | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined) }),
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

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  const { default: ProjectDetailPage } = await import("@/app/(main)/projects/[id]/page");
  const { ProjectDetailHeader } = await import("@/components/projects/project-detail-header");
  const { hasPermission } = await import("@/lib/permissions");
  const projectRoute = await import("@/app/api/projects/[id]/route");
  const projectNotes = await import("@/app/api/projects/[id]/notes/route");
  const activityRoute = await import("@/app/api/activities/[id]/route");
  const activityNotes = await import("@/app/api/activities/[id]/notes/route");
  const attachmentsRoute = await import("@/app/api/activities/[id]/attachments/route");
  const attachmentItemRoute = await import("@/app/api/activities/[id]/attachments/[attachmentId]/route");
  const dependenciesRoute = await import("@/app/api/dependencies/route");
  const { UPLOAD_DIR } = await import("@/lib/attachment-policy");

  const jsonReq = (method: string, body?: unknown) =>
    new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const idp = (id: string) => ({ params: Promise.resolve({ id }) });

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  async function makeRole(tag: string, scope: RoleScope, keys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `WP_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    roleIds.push(r.id);
    roleKeys.push(r.key);
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  type Subject = { name: string; id: string; role: Role; customRoleId: string | null };
  async function makeUser(name: string, role: Role, customRoleId: string | null): Promise<Subject> {
    const u = await prisma.user.create({ data: { email: `wp-${name}-${RUN_ID}@kinsen.gr`, name: `WP ${name}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return { name, id: u.id, role, customRoleId };
  }
  async function member(userId: string, departmentId: string, customRoleId: string, isActive = true) {
    await prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.REQUESTER, customRoleId, source: MembershipSource.MANUAL, isActive } });
  }
  const as = (s: Subject | null) => {
    currentSession = s ? { user: { id: s.id, role: s.role, customRoleId: s.customRoleId } } : null;
  };

  try {
    const deptA = await createDepartment({ name: `WP-A-${RUN_ID}`, slug: `wp-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `WP-B-${RUN_ID}`, slug: `wp-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const WRITE_KEYS = ["project.view", "project.edit", "project.delete", "activity.view", "activity.edit", "activity.delete"];
    const VIEW_KEYS = ["project.view", "activity.view"];
    const noop = await makeRole("NOOP", RoleScope.GLOBAL, []);
    const globalFull = await makeRole("GLOBAL_FULL", RoleScope.GLOBAL, WRITE_KEYS);
    const globalView = await makeRole("GLOBAL_VIEW", RoleScope.GLOBAL, VIEW_KEYS);
    const deptFull = await makeRole("DEPT_FULL", RoleScope.DEPARTMENT, WRITE_KEYS);
    const deptView = await makeRole("DEPT_VIEW", RoleScope.DEPARTMENT, VIEW_KEYS);
    const deptFullToDisable = await makeRole("DEPT_FULL_DISABLED", RoleScope.DEPARTMENT, WRITE_KEYS);

    const owner = await makeUser("owner", Role.USER, noop.id);
    const admin = await makeUser("admin", Role.ADMIN, null);
    const itAgent = await makeUser("it-agent", Role.IT_AGENT, null); // built-in GLOBAL role, no membership
    const gCustom = await makeUser("global-custom", Role.USER, globalFull.id); // global CustomRole, no membership
    const dA = await makeUser("dept-a", Role.USER, noop.id);
    await member(dA.id, deptA.id, deptFull.id);
    const vGlobal = await makeUser("view-global", Role.USER, globalView.id);
    const vDept = await makeUser("view-dept", Role.USER, noop.id);
    await member(vDept.id, deptA.id, deptView.id);
    const nobody = await makeUser("nobody", Role.USER, noop.id);
    const inactiveMember = await makeUser("inactive-membership", Role.USER, noop.id);
    await member(inactiveMember.id, deptA.id, deptFull.id, false);
    const inactiveRole = await makeUser("inactive-role", Role.USER, noop.id);
    await member(inactiveRole.id, deptA.id, deptFullToDisable.id);
    await prisma.customRole.update({ where: { id: deptFullToDisable.id }, data: { isActive: false } });

    // ── 0. Architectural evidence that these permissions are global-grantable ──
    console.log("\n0. Evidence: global grants are part of these permissions' established semantics ===\n");
    check("0a. seeded GLOBAL built-in IT_AGENT holds project.edit and activity.edit", (await hasPermission(Role.IT_AGENT, "project.edit", null)) && (await hasPermission(Role.IT_AGENT, "activity.edit", null)));
    check("0b. seeded GLOBAL built-in IT_AGENT holds NO X.delete (only ADMIN/DepartmentRole do) — delete is proven via a GLOBAL CustomRole + ADMIN", !(await hasPermission(Role.IT_AGENT, "project.delete", null)) && !(await hasPermission(Role.IT_AGENT, "activity.delete", null)));
    const roleEditorSrc = await fs.readFile("app/api/admin/roles/[id]/permissions/[permId]/route.ts", "utf8");
    const globalOnly = /GLOBAL_ONLY_PERMISSION_KEYS = new Set\(\[([^\]]*)\]\)/.exec(roleEditorSrc)?.[1] ?? "";
    check("0c. the role editor restricts only admin.access/user.manage/role.manage — no project.* / activity.* key is department-only", !/project\.|activity\./.test(globalOnly) && /admin\.access/.test(globalOnly));
    check("0d. a GLOBAL CustomRole genuinely holds project.delete/activity.delete", (await hasPermission(Role.USER, "project.delete", globalFull.id)) && (await hasPermission(Role.USER, "activity.delete", globalFull.id)));

    // ── fixtures factory: a FRESH entity per call so destructive actions can be repeated ──
    const freshProject = async (departmentId: string) => {
      const p = await prisma.project.create({ data: { title: `WP project ${RUN_ID}-${projectIds.length}`, departmentId, ownerId: owner.id } });
      projectIds.push(p.id);
      return p;
    };
    const freshActivity = async (departmentId: string) => {
      const a = await prisma.projectActivity.create({ data: { title: `WP activity ${RUN_ID}-${activityIds.length}`, departmentId } });
      activityIds.push(a.id);
      return a;
    };
    const uploadFile = () => {
      const fd = new FormData();
      fd.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
      return new NextRequest("http://localhost/x", { method: "POST", body: fd });
    };

    type Action = { key: string; permission: string; run: (dept: string) => Promise<number>; confirm?: (dept: string) => Promise<boolean> };
    const ok = (s: number) => s >= 200 && s < 300;
    const actions: Action[] = [
      { key: "project PATCH", permission: "project.edit", run: async (d) => (await projectRoute.PATCH(jsonReq("PATCH", { title: "renamed" }), idp((await freshProject(d)).id))).status },
      { key: "project note POST", permission: "project.edit", run: async (d) => (await projectNotes.POST(jsonReq("POST", { body: "a note" }), idp((await freshProject(d)).id))).status },
      { key: "project DELETE", permission: "project.delete", run: async (d) => (await projectRoute.DELETE(jsonReq("DELETE"), idp((await freshProject(d)).id))).status },
      { key: "activity PATCH (edit)", permission: "activity.edit", run: async (d) => (await activityRoute.PATCH(jsonReq("PATCH", { title: "renamed" }), idp((await freshActivity(d)).id))).status },
      { key: "activity PATCH (status/progress)", permission: "activity.edit", run: async (d) => (await activityRoute.PATCH(jsonReq("PATCH", { status: "IN_PROGRESS" }), idp((await freshActivity(d)).id))).status },
      { key: "activity PATCH (completion toggle)", permission: "activity.edit", run: async (d) => (await activityRoute.PATCH(jsonReq("PATCH", { isCompleted: true, status: "COMPLETED" }), idp((await freshActivity(d)).id))).status },
      { key: "activity note POST", permission: "activity.edit", run: async (d) => (await activityNotes.POST(jsonReq("POST", { body: "a note" }), idp((await freshActivity(d)).id))).status },
      { key: "activity attachment upload", permission: "activity.edit", run: async (d) => (await attachmentsRoute.POST(uploadFile(), idp((await freshActivity(d)).id))).status },
      {
        key: "activity attachment delete",
        permission: "activity.edit",
        run: async (d) => {
          const a = await freshActivity(d);
          const att = await prisma.activityAttachment.create({ data: { activityId: a.id, uploadedById: owner.id, filename: `wp-${RUN_ID}.txt`, originalName: "seed.txt", mimeType: "text/plain", size: 5 } });
          return (await attachmentItemRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: a.id, attachmentId: att.id }) })).status;
        },
      },
      { key: "activity DELETE", permission: "activity.delete", run: async (d) => (await activityRoute.DELETE(jsonReq("DELETE"), idp((await freshActivity(d)).id))).status },
    ];

    // expected[subject] = { A: allowedInA(actionPermission)->bool, B: ... }
    type Expect = (permission: string, dept: "A" | "B") => boolean;
    const isDelete = (p: string) => p.endsWith(".delete");
    const subjects: Array<{ s: Subject; label: string; expect: Expect }> = [
      { s: admin, label: "ADMIN (existing bypass)", expect: () => true },
      { s: itAgent, label: "global BUILT-IN role, no membership (edit-type only; seed grants it no delete)", expect: (p) => !isDelete(p) },
      { s: gCustom, label: "global CustomRole, no membership", expect: () => true },
      { s: dA, label: "Department A custom role", expect: (_p, d) => d === "A" },
      { s: vGlobal, label: "GLOBAL view-only", expect: () => false },
      { s: vDept, label: "Department A view-only", expect: () => false },
      { s: nobody, label: "no applicable grant", expect: () => false },
      { s: inactiveMember, label: "INACTIVE membership (custom role otherwise grants all)", expect: () => false },
      { s: inactiveRole, label: "INACTIVE custom role on an active membership", expect: () => false },
    ];

    console.log("\nMatrix: every mutation gate × subject × department (fresh entity per call) ===\n");
    for (const action of actions) {
      for (const { s, label, expect } of subjects) {
        for (const dept of ["A", "B"] as const) {
          as(s);
          const status = await action.run(dept === "A" ? deptA.id : deptB.id);
          const want = expect(action.permission, dept);
          check(`${action.key} [${action.permission}] — ${label} — Dept ${dept}: ${want ? "allowed" : "denied"}`, want ? ok(status) : status === 403, `got ${status}`);
        }
      }
    }

    // ── UI hints agree with the mutation API (project page + activity GET) ──
    console.log("\nUI hint ⇔ mutation API parity ===\n");
    for (const { s, label } of subjects) {
      for (const dept of ["A", "B"] as const) {
        const d = dept === "A" ? deptA.id : deptB.id;
        as(s);
        const project = await freshProject(d);
        let header: any = null;
        try {
          const el = await ProjectDetailPage({ params: Promise.resolve({ id: project.id }) });
          header = findElementsByType(el, ProjectDetailHeader)[0]?.props ?? null;
        } catch (err: any) {
          if (!String(err?.digest ?? "").startsWith("NEXT_REDIRECT")) throw err;
        }
        if (header) {
          const editAllowed = ok((await projectRoute.PATCH(jsonReq("PATCH", { title: "probe" }), idp(project.id))).status);
          const deleteAllowed = ok((await projectRoute.DELETE(jsonReq("DELETE"), idp(project.id))).status);
          check(`project page hints canEditProject/canDeleteProject match PATCH/DELETE — ${label} — Dept ${dept}`, header.canEditProject === editAllowed && header.canDeleteProject === deleteAllowed, `hints ${header.canEditProject}/${header.canDeleteProject} vs api ${editAllowed}/${deleteAllowed}`);
        }
        const activity = await freshActivity(d);
        const detail = await activityRoute.GET(jsonReq("GET"), idp(activity.id));
        if (detail.status === 200) {
          const body = await detail.json();
          const editAllowed = ok((await activityRoute.PATCH(jsonReq("PATCH", { title: "probe" }), idp(activity.id))).status);
          const deleteAllowed = ok((await activityRoute.DELETE(jsonReq("DELETE"), idp(activity.id))).status);
          check(`activity GET hints canEditActivity/canDeleteActivity match PATCH/DELETE — ${label} — Dept ${dept}`, body.canEditActivity === editAllowed && body.canDeleteActivity === deleteAllowed, `hints ${body.canEditActivity}/${body.canDeleteActivity} vs api ${editAllowed}/${deleteAllowed}`);
        }
      }
    }

    // ── Active workspace has no authority ──
    console.log("\nActive workspace never authorizes or blocks ===\n");
    currentCookieDepartmentId = deptB.id;
    as(dA);
    const cookieA = (await projectRoute.PATCH(jsonReq("PATCH", { title: "renamed ok" }), idp((await freshProject(deptA.id)).id))).status;
    check("cookie=B: a Department A editor still edits their Department A entity", ok(cookieA), `got ${cookieA}`);
    check("cookie=B: ...and still cannot edit a Department B entity (workspace grants nothing)", (await projectRoute.PATCH(jsonReq("PATCH", { title: "renamed ok" }), idp((await freshProject(deptB.id)).id))).status === 403);
    currentCookieDepartmentId = deptA.id;
    as(gCustom);
    check("cookie=A: a global editor still edits a Department B entity (workspace takes nothing away)", ok((await activityRoute.PATCH(jsonReq("PATCH", { title: "renamed ok" }), idp((await freshActivity(deptB.id)).id))).status));
    currentCookieDepartmentId = null;

    // ── Business/ownership rules preserved for a global editor ──
    console.log("\nBusiness and ownership rules are still enforced on top of RBAC ===\n");
    as(gCustom);
    const guarded = await freshActivity(deptA.id);
    const inconsistent = await activityRoute.PATCH(jsonReq("PATCH", { isCompleted: true, status: "IN_PROGRESS" }), idp(guarded.id));
    check("status/isCompleted consistency still rejected (400) for a global editor", inconsistent.status === 400 && (await inconsistent.json()).code === "invalid_status_transition");
    check("moving a project to another department still needs standing THERE — global editor without membership -> 403", (await projectRoute.PATCH(jsonReq("PATCH", { departmentId: deptB.id }), idp((await freshProject(deptA.id)).id))).status === 403);
    check("...same for an activity", (await activityRoute.PATCH(jsonReq("PATCH", { departmentId: deptB.id }), idp((await freshActivity(deptA.id)).id))).status === 403);
    as(admin);
    check("...ADMIN still may move an entity across departments", ok((await projectRoute.PATCH(jsonReq("PATCH", { departmentId: deptB.id }), idp((await freshProject(deptA.id)).id))).status));
    as(gCustom);
    const actX = await freshActivity(deptA.id);
    const actY = await freshActivity(deptA.id);
    const foreign = await prisma.activityAttachment.create({ data: { activityId: actY.id, uploadedById: owner.id, filename: `wp-foreign-${RUN_ID}.txt`, originalName: "foreign.txt", mimeType: "text/plain", size: 5 } });
    const crafted = await attachmentItemRoute.DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: actX.id, attachmentId: foreign.id }) });
    check("attachment ownership still enforced: another activity's attachment id via this activity -> 404, row untouched", crafted.status === 404 && !!(await prisma.activityAttachment.findUnique({ where: { id: foreign.id } })));
    check("dependencies stay ADMIN-only: a global editor's POST -> 403", (await dependenciesRoute.POST(jsonReq("POST", { predecessorId: actX.id, successorId: actY.id, type: "FINISH_TO_START" }))).status === 403);

    // ── Retained gates: source evidence ──
    console.log("\nIntentionally retained gates (unchanged) ===\n");
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const [projectsCreate, activitiesCreate, projectSrc, activitySrc, depSrc, deptScopeSrc] = (await Promise.all([
      fs.readFile("app/api/projects/route.ts", "utf8"),
      fs.readFile("app/api/activities/route.ts", "utf8"),
      fs.readFile("app/api/projects/[id]/route.ts", "utf8"),
      fs.readFile("app/api/activities/[id]/route.ts", "utf8"),
      fs.readFile("app/api/dependencies/route.ts", "utf8"),
      fs.readFile("lib/services/department-scope-service.ts", "utf8"),
    ])).map(strip);
    check("R1. project/activity CREATE still go through resolveDepartmentForCreate (membership standing)", /resolveDepartmentForCreate\([^)]*"project\.create"/.test(projectsCreate) && /resolveDepartmentForCreate\([^)]*"activity\.create"/.test(activitiesCreate));
    check("R2. department-move target checks still use hasDepartmentPermission(target membership, *.create)", /hasDepartmentPermission\(targetMembership\.role, "project\.create"/.test(projectSrc) && /hasDepartmentPermission\(targetMembership\.role, "activity\.create"/.test(activitySrc));
    check("R3. dependency POST is still isAdmin-only", /isAdmin\(session\.user\.role\)/.test(depSrc));
    check("R4. project.create hint on the Activity GET (canCreateProjectInDept) is still bare canActOnEntity (creation stays department-standing)", /canActOnEntity\([^)]*"project\.create"\)/.test(activitySrc));
    const canActBody = deptScopeSrc.slice(deptScopeSrc.indexOf("export async function canActOnEntity("), deptScopeSrc.indexOf("export async function hasEffectiveEntityPermission("));
    check("R5. canActOnEntity itself is unchanged — no global-permission path added", !/hasPermission\(/.test(canActBody));
    const gateFiles = ["app/api/projects/[id]/route.ts", "app/api/projects/[id]/notes/route.ts", "app/(main)/projects/[id]/page.tsx", "app/api/activities/[id]/route.ts", "app/api/activities/[id]/notes/route.ts", "app/api/activities/[id]/attachments/route.ts", "app/api/activities/[id]/attachments/[attachmentId]/route.ts", "app/(main)/projects/resource-planning/page.tsx"];
    let gatesClean = true;
    for (const f of gateFiles) {
      const src = strip(await fs.readFile(f, "utf8"));
      if (/canActOnEntity\([^)]*"(project|activity)\.(edit|delete)"\)/.test(src) || (!f.includes("resource-planning") && /hasEffectiveModulePermission|getActiveWorkspace\(/.test(src)) || /"(ADMIN|Department Admin)"/.test(src)) {
        gatesClean = false;
        console.error(`     leftover bare edit/delete gate or forbidden helper in ${f}`);
      }
    }
    check("S1. no bare canActOnEntity(*.edit|X.delete), no module/workspace helper, no role names in any affected write gate", gatesClean);
  } finally {
    console.log("\nCleaning up test data...\n");
    for (const id of activityIds) await fs.rm(path.join(UPLOAD_DIR_SAFE(), "activities", id), { recursive: true, force: true }).catch(() => {});
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["notes", () => prisma.$transaction([prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } }), prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } })])],
      ["attachments", () => prisma.activityAttachment.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["dependencies", () => prisma.activityDependency.deleteMany({ where: { OR: [{ predecessorId: { in: activityIds } }, { successorId: { in: activityIds } }] } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: roleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: roleIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

function UPLOAD_DIR_SAFE(): string {
  return process.env.UPLOAD_DIR || "./storage/uploads";
}

main();
