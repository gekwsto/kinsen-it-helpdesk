/**
 * Detail-VIEW authorization for Projects and Activities uses
 * hasEffectiveEntityPermission (global grant OR the entity's own department
 * grant) instead of a bare canActOnEntity — which only resolved the
 * ADMIN/DIRECTOR bypass or a DepartmentMembership and therefore turned away
 * a user whose ONLY project.view/activity.view came from a global built-in
 * role or a global CustomRole.
 *
 * Gates covered (all outer "may this user VIEW this entity" decisions):
 *   Project:  app/(main)/projects/[id]/page.tsx, GET /api/projects/[id],
 *             GET /api/projects/[id]/notes
 *   Activity: GET /api/activities/[id] (the detail page's data API),
 *             GET .../notes, GET .../attachments (+ item download),
 *             GET /api/dependencies?activityId=
 * NOT changed (and asserted unchanged below): edit/delete/note-create
 * permissions, list scoping, canActOnEntity itself.
 *
 * Real route handlers + the real Project page server component, real
 * role/permission rows and department scoping; only @/lib/auth and the
 * next/headers workspace cookie are mocked.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-activity-detail-view-authorization.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
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
mock.module("@/lib/auth", {
  namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined) }),
    headers: async () => new Headers(),
  },
});
const asUser = (id: string, role: Role, customRoleId: string | null = null) => {
  currentSession = { user: { id, role, customRoleId } };
};

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

  // Notes routes transitively import lib/web-push.ts (`server-only`, which
  // always throws outside Next's bundler) — same short-circuit
  // scripts/test-note-mentions.ts documents. Nothing under test is mocked.
  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  // Dynamic imports only AFTER the mocks (see scripts/test-note-mentions.ts).
  const { default: ProjectDetailPage } = await import("@/app/(main)/projects/[id]/page");
  const { EntityRelatedLinks } = await import("@/components/related-links/entity-related-links");
  const { ProjectDetailHeader } = await import("@/components/projects/project-detail-header");
  const { hasPermission } = await import("@/lib/permissions");
  const projectGet = (await import("@/app/api/projects/[id]/route")).GET;
  const projectNotesGet = (await import("@/app/api/projects/[id]/notes/route")).GET;
  const projectNotesPost = (await import("@/app/api/projects/[id]/notes/route")).POST;
  const activityGet = (await import("@/app/api/activities/[id]/route")).GET;
  const activityNotesGet = (await import("@/app/api/activities/[id]/notes/route")).GET;
  const activityNotesPost = (await import("@/app/api/activities/[id]/notes/route")).POST;
  const activityAttachmentsGet = (await import("@/app/api/activities/[id]/attachments/route")).GET;
  const dependenciesGet = (await import("@/app/api/dependencies/route")).GET;
  const activityRelatedLinks = await import("@/app/api/activities/[id]/related-links/route");
  const projectRelatedLinks = await import("@/app/api/projects/[id]/related-links/route");

  const req = (url = "http://localhost/x", method = "GET", body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const idp = (id: string) => ({ params: Promise.resolve({ id }) });

  /** Renders the real Project page; returns props of what it rendered, or "redirect". */
  async function renderProject(id: string) {
    try {
      const el = await ProjectDetailPage({ params: Promise.resolve({ id }) });
      const [links] = findElementsByType(el, EntityRelatedLinks);
      const [header] = findElementsByType(el, ProjectDetailHeader);
      return { rendered: true as const, links: links?.props, header: header?.props };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) return { rendered: false as const };
      throw err;
    }
  }
  async function activityReads(id: string) {
    const [detail, notes, attachments, deps] = await Promise.all([
      activityGet(req(), idp(id)),
      activityNotesGet(req(), idp(id)),
      activityAttachmentsGet(req(), idp(id)),
      dependenciesGet(req(`http://localhost/api/dependencies?activityId=${id}`)),
    ]);
    return { detail, notes, attachments, deps };
  }

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  async function makeRole(tag: string, scope: RoleScope, keys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `DV_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    roleIds.push(r.id);
    roleKeys.push(r.key);
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  async function makeUser(tag: string, role: Role, customRoleId: string | null) {
    const u = await prisma.user.create({ data: { email: `dv-${tag}-${RUN_ID}@kinsen.gr`, name: `DV ${tag}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u;
  }

  try {
    const deptA = await createDepartment({ name: `DV-A-${RUN_ID}`, slug: `dv-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `DV-B-${RUN_ID}`, slug: `dv-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    // Role.USER carries a built-in GLOBAL activity.view (prisma/seed.ts) — every
    // "no grant" / department-only user therefore gets an empty global role to
    // neutralize it, so denial/scoping below is attributable to the fixture.
    const noopGlobal = await makeRole("NOOP", RoleScope.GLOBAL, []);
    const globalProjectView = await makeRole("GLOBAL_PROJECT_VIEW", RoleScope.GLOBAL, ["project.view"]);
    const globalActivityView = await makeRole("GLOBAL_ACTIVITY_VIEW", RoleScope.GLOBAL, ["activity.view"]);
    const deptAViewRole = await makeRole("DEPTA_VIEW", RoleScope.DEPARTMENT, ["project.view", "activity.view"]);

    const owner = await makeUser("owner", Role.USER, noopGlobal.id);
    const mkProject = async (departmentId: string, tag: string) => {
      const p = await prisma.project.create({ data: { title: `DV Project ${tag} ${RUN_ID}`, departmentId, ownerId: owner.id } });
      projectIds.push(p.id);
      return p;
    };
    const mkActivity = async (departmentId: string, tag: string) => {
      const a = await prisma.projectActivity.create({ data: { title: `DV Activity ${tag} ${RUN_ID}`, departmentId } });
      activityIds.push(a.id);
      return a;
    };
    const projectA = await mkProject(deptA.id, "A");
    const projectB = await mkProject(deptB.id, "B");
    const activityA = await mkActivity(deptA.id, "A");
    const activityB = await mkActivity(deptB.id, "B");
    await prisma.relatedLink.create({ data: { url: "https://docs.example.com/p", title: "project doc", projectId: projectA.id, createdById: owner.id } });
    await prisma.relatedLink.create({ data: { url: "https://docs.example.com/a", title: "activity doc", activityId: activityA.id, createdById: owner.id } });

    // ── 1. Global BUILT-IN role project.view, no DepartmentMembership ──
    console.log("\n1. Global built-in role project.view opens a Project without any DepartmentMembership ===\n");
    const itAgent = await makeUser("it-agent", Role.IT_AGENT, null);
    check("1-pre. IT_AGENT genuinely holds project.view globally (seeded) and has no membership", (await hasPermission(Role.IT_AGENT, "project.view", null)) && (await prisma.departmentMembership.count({ where: { userId: itAgent.id } })) === 0);
    asUser(itAgent.id, Role.IT_AGENT);
    const p1 = await renderProject(projectA.id);
    check("1a. Project page renders (no redirect)", p1.rendered);
    check("1b. GET /api/projects/[id] -> 200", (await projectGet(req(), idp(projectA.id))).status === 200);
    check("1c. GET /api/projects/[id]/notes -> 200", (await projectNotesGet(req(), idp(projectA.id))).status === 200);
    check("1d. ...and for a Department B project too (a global grant applies everywhere)", (await renderProject(projectB.id)).rendered);

    // ── 2. Global CustomRole project.view (view-only) ──
    console.log("\n2. Global CustomRole project.view opens a Project without DepartmentMembership ===\n");
    const globalProjectViewer = await makeUser("global-project-viewer", Role.USER, globalProjectView.id);
    asUser(globalProjectViewer.id, Role.USER, globalProjectView.id);
    const p2 = await renderProject(projectA.id);
    check("2a. Project page renders", p2.rendered);
    check("2b. GET /api/projects/[id] -> 200", (await projectGet(req(), idp(projectA.id))).status === 200);
    check("2c. GET /api/projects/[id]/notes -> 200", (await projectNotesGet(req(), idp(projectA.id))).status === 200);
    // 8. Related Links visible whenever the entity is viewable
    check("8a. Project page renders the shared Related Links card with the saved link", !!p2.rendered && p2.links?.initialLinks?.some((l: any) => l.title === "project doc"));
    const pl = await projectRelatedLinks.GET(req(), idp(projectA.id));
    check("8b. GET /api/projects/[id]/related-links -> 200 with the link", pl.status === 200 && (await pl.json()).links.length === 1);
    // 9. View does not grant edit/delete/link management
    check("9a. view-only user is NOT offered project edit/delete on the page", !!p2.rendered && p2.header?.canEditProject === false && p2.header?.canDeleteProject === false);
    check("9b. ...nor Related Links management (canManage false)", !!p2.rendered && p2.links?.initialCanManage === false && (await (await projectRelatedLinks.GET(req(), idp(projectA.id))).json()).canManage === false);
    check("9c. ...POST note -> 403", (await projectNotesPost(req("http://localhost/x", "POST", { body: "hi" }), idp(projectA.id))).status === 403);
    check("9d. ...POST related link -> 403", (await projectRelatedLinks.POST(req("http://localhost/x", "POST", { url: "https://x.example.com", title: "t" }), idp(projectA.id))).status === 403);

    // ── 3. Activity: global built-in + global custom ──
    console.log("\n3. Activity detail: global built-in role and global CustomRole grants ===\n");
    const plainUser = await makeUser("plain-user", Role.USER, null); // Role.USER's own built-in global activity.view, no membership
    check("3-pre. Role.USER genuinely holds activity.view globally (seeded), no membership", (await hasPermission(Role.USER, "activity.view", null)) && (await prisma.departmentMembership.count({ where: { userId: plainUser.id } })) === 0);
    asUser(plainUser.id, Role.USER);
    let reads = await activityReads(activityA.id);
    check("3a. built-in: GET /api/activities/[id] -> 200", reads.detail.status === 200);
    check("3b. built-in: notes / attachments / dependencies reads -> 200", reads.notes.status === 200 && reads.attachments.status === 200 && reads.deps.status === 200);
    const detailBody = await activityGet(req(), idp(activityA.id)).then((r) => r.json());
    check("3c. view access does NOT expose edit/delete (canEditActivity/canDeleteActivity false)", detailBody.canEditActivity === false && detailBody.canDeleteActivity === false);
    const globalActivityViewer = await makeUser("global-activity-viewer", Role.USER, globalActivityView.id);
    asUser(globalActivityViewer.id, Role.USER, globalActivityView.id);
    reads = await activityReads(activityA.id);
    check("3d. global CustomRole: detail + notes + attachments + dependencies -> 200", reads.detail.status === 200 && reads.notes.status === 200 && reads.attachments.status === 200 && reads.deps.status === 200);
    const b = await activityReads(activityB.id);
    check("3e. ...and for a Department B activity (global applies everywhere)", b.detail.status === 200);
    const al = await activityRelatedLinks.GET(req(), idp(activityA.id));
    const alBody = await al.json();
    check("8c. Activity Related Links visible to the viewer (200, link present)", al.status === 200 && alBody.links.length === 1);
    check("9e. view-only activity user: canManage false; POST note / POST related link -> 403", alBody.canManage === false && (await activityNotesPost(req("http://localhost/x", "POST", { body: "hi" }), idp(activityA.id))).status === 403 && (await activityRelatedLinks.POST(req("http://localhost/x", "POST", { url: "https://x.example.com", title: "t" }), idp(activityA.id))).status === 403);

    // ── 4/5/6. Department A grant opens only Department A; workspace can't override ──
    console.log("\n4/5/6. Department A grant: only Department A; the active workspace never overrides the entity's department ===\n");
    const deptAUser = await makeUser("dept-a-user", Role.USER, noopGlobal.id);
    await prisma.departmentMembership.create({ data: { userId: deptAUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, customRoleId: deptAViewRole.id, source: MembershipSource.MANUAL, isActive: true } });
    asUser(deptAUser.id, Role.USER, noopGlobal.id);
    currentCookieDepartmentId = null;
    check("4a. Department A project page renders", (await renderProject(projectA.id)).rendered);
    check("4b. Department A project/activity APIs -> 200", (await projectGet(req(), idp(projectA.id))).status === 200 && (await activityReads(activityA.id)).detail.status === 200);
    check("5a. Department B project page redirects", !(await renderProject(projectB.id)).rendered);
    const bReads = await activityReads(activityB.id);
    check("5b. Department B project API and every Department B activity read -> 403", (await projectGet(req(), idp(projectB.id))).status === 403 && bReads.detail.status === 403 && bReads.notes.status === 403 && bReads.attachments.status === 403 && bReads.deps.status === 403);
    check("5c. Department B Related Links -> 403", (await projectRelatedLinks.GET(req(), idp(projectB.id))).status === 403);
    currentCookieDepartmentId = deptB.id; // workspace says B; entity A is still A
    check("6a. workspace = B does not stop the user opening their Department A entity", (await renderProject(projectA.id)).rendered && (await activityReads(activityA.id)).detail.status === 200);
    check("6b. workspace = B does not let them open a Department B entity", !(await renderProject(projectB.id)).rendered && (await activityReads(activityB.id)).detail.status === 403);
    currentCookieDepartmentId = deptA.id;
    check("6c. workspace = A does not let them open a Department B entity", !(await renderProject(projectB.id)).rendered);
    currentCookieDepartmentId = null;
    check("9f. a Department A view-only grant still confers no edit (page hints false)", await (async () => { const r = await renderProject(projectA.id); return r.rendered && r.header?.canEditProject === false && r.links?.initialCanManage === false; })());

    // ── 7. No grant anywhere: still denied ──
    console.log("\n7. No global or applicable department grant remains denied ===\n");
    const nobody = await makeUser("nobody", Role.USER, noopGlobal.id);
    asUser(nobody.id, Role.USER, noopGlobal.id);
    const nReads = await activityReads(activityA.id);
    check("7a. project page redirects, project API 403, project notes 403", !(await renderProject(projectA.id)).rendered && (await projectGet(req(), idp(projectA.id))).status === 403 && (await projectNotesGet(req(), idp(projectA.id))).status === 403);
    check("7b. every activity read -> 403", nReads.detail.status === 403 && nReads.notes.status === 403 && nReads.attachments.status === 403 && nReads.deps.status === 403);
    check("7c. Related Links -> 403 for both entity types", (await projectRelatedLinks.GET(req(), idp(projectA.id))).status === 403 && (await activityRelatedLinks.GET(req(), idp(activityA.id))).status === 403);
    currentSession = null;
    check("7d. unauthenticated -> 401 (project API)", (await projectGet(req(), idp(projectA.id))).status === 401);

    // ── 10. Existing behavior unchanged ──
    console.log("\n10. Existing behavior does not regress ===\n");
    const admin = await prisma.user.create({ data: { email: `dv-admin-${RUN_ID}@kinsen.gr`, name: "DV admin", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    asUser(admin.id, Role.ADMIN);
    const adminP = await renderProject(projectB.id);
    check("10a. ADMIN still opens any project and sees edit/delete + management", adminP.rendered && adminP.header?.canEditProject === true && adminP.header?.canDeleteProject === true && adminP.links?.initialCanManage === true);
    check("10b. ADMIN still reads any activity", (await activityReads(activityB.id)).detail.status === 200);
    const fs = await import("fs/promises");
    const dsSource = await fs.readFile("lib/services/department-scope-service.ts", "utf8");
    const canActBody = dsSource.slice(dsSource.indexOf("export async function canActOnEntity("), dsSource.indexOf("export async function hasEffectiveEntityPermission("));
    check("10c. canActOnEntity itself is unchanged (no global-permission path added to it)", !/hasPermission\(/.test(canActBody.replace(/\/\*[\s\S]*?\*\//g, "")));
    const gateFiles = ["app/(main)/projects/[id]/page.tsx", "app/api/projects/[id]/route.ts", "app/api/activities/[id]/route.ts", "app/api/projects/[id]/notes/route.ts", "app/api/activities/[id]/notes/route.ts", "app/api/activities/[id]/attachments/route.ts", "app/api/activities/[id]/attachments/[attachmentId]/route.ts", "app/api/dependencies/route.ts"];
    let allOk = true;
    for (const f of gateFiles) {
      const src = await fs.readFile(f, "utf8");
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/canActOnEntity\([^)]*"(project|activity)\.view"\)/.test(noComments) || !/hasEffectiveEntityPermission\([^)]*"(project|activity)\.view"\)/.test(noComments) || /hasEffectiveModulePermission|active_department|getActiveWorkspace/.test(noComments)) {
        allOk = false;
        console.error(`     gate check failed in ${f}`);
      }
    }
    check("10d. every outer view gate uses hasEffectiveEntityPermission (no bare canActOnEntity view, no module/workspace helper)", allOk);
    const editSrc = (await fs.readFile("app/api/activities/[id]/route.ts", "utf8")) + (await fs.readFile("app/api/projects/[id]/route.ts", "utf8"));
    check("10e. edit/delete keys are still enforced on the outer gates (the write union is covered by test-project-activity-write-permission-audit.ts)", /hasEffectiveEntityPermission\([^)]*"activity\.edit"\)/.test(editSrc) && /hasEffectiveEntityPermission\([^)]*"activity\.delete"\)/.test(editSrc) && /hasEffectiveEntityPermission\([^)]*"project\.edit"\)/.test(editSrc) && /hasEffectiveEntityPermission\([^)]*"project\.delete"\)/.test(editSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["relatedLinks", () => prisma.relatedLink.deleteMany({ where: { OR: [{ projectId: { in: projectIds } }, { activityId: { in: activityIds } }] } })],
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

main();
