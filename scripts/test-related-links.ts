/**
 * Related Links card (Project + Activity detail pages) — one shared
 * implementation: components/related-links/entity-related-links.tsx,
 * lib/services/related-links-service.ts, lib/related-links/*.
 *
 * Exercises the REAL route handlers (mocked @/lib/auth session only — same
 * convention as scripts/test-note-mentions.ts) against real DB rows, real
 * role/permission rows and real department scoping, plus real server
 * rendering (react-dom/server) of the shared client component. No role-name
 * mocks; no new permission is introduced — modify = project.edit /
 * activity.edit, view = project.view / activity.view, resolved via
 * hasEffectiveEntityPermission against the entity's own departmentId.
 *
 * Layout note: this repo has no DOM/browser test harness for unit scripts, so
 * "no horizontal overflow" (item 17) is asserted structurally on the real
 * rendered markup (min-w-0 / truncate / break-words chain) — see the final
 * report for the honest limits of that.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-related-links.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs/promises";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Prisma, Role, RoleScope } from "@prisma/client";
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
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});
function asUser(id: string, customRoleId: string | null = null, role: Role = Role.USER) {
  currentSession = { user: { id, role, customRoleId } };
}

const RUN_ID = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  // Dynamic imports AFTER the @/lib/auth mock (a static import of anything
  // reaching lib/permissions.ts would bind the REAL auth() first).
  type Ctx = { params: Promise<{ id: string; linkId?: string }> };
  const projectList = await import("@/app/api/projects/[id]/related-links/route");
  const projectItem = await import("@/app/api/projects/[id]/related-links/[linkId]/route");
  const activityList = await import("@/app/api/activities/[id]/related-links/route");
  const activityItem = await import("@/app/api/activities/[id]/related-links/[linkId]/route");
  const { EntityRelatedLinks } = await import("@/components/related-links/entity-related-links");
  const { parseSafeExternalUrl } = await import("@/lib/related-links/validation");

  const json = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  const api = {
    project: {
      list: (id: string) => projectList.GET(json("http://localhost/x", "GET"), { params: Promise.resolve({ id }) }),
      create: (id: string, body: unknown) => projectList.POST(json("http://localhost/x", "POST", body), { params: Promise.resolve({ id }) }),
      patch: (id: string, linkId: string, body: unknown) => projectItem.PATCH(json("http://localhost/x", "PATCH", body), { params: Promise.resolve({ id, linkId }) } as any),
      del: (id: string, linkId: string) => projectItem.DELETE(json("http://localhost/x", "DELETE"), { params: Promise.resolve({ id, linkId }) } as any),
    },
    activity: {
      list: (id: string) => activityList.GET(json("http://localhost/x", "GET"), { params: Promise.resolve({ id }) }),
      create: (id: string, body: unknown) => activityList.POST(json("http://localhost/x", "POST", body), { params: Promise.resolve({ id }) }),
      patch: (id: string, linkId: string, body: unknown) => activityItem.PATCH(json("http://localhost/x", "PATCH", body), { params: Promise.resolve({ id, linkId }) } as any),
      del: (id: string, linkId: string) => activityItem.DELETE(json("http://localhost/x", "DELETE"), { params: Promise.resolve({ id, linkId }) } as any),
    },
  };
  void (null as unknown as Ctx);

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  async function makeRole(tag: string, scope: RoleScope, keys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `RL_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    roleIds.push(r.id);
    roleKeys.push(r.key);
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  async function makeUser(tag: string, customRoleId: string | null) {
    const u = await prisma.user.create({
      data: { email: `rl-${tag}-${RUN_ID}@kinsen.gr`, name: `RL ${tag}`, role: Role.USER, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(u.id);
    return u;
  }
  async function member(userId: string, departmentId: string, customRoleId: string) {
    return prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.REQUESTER, customRoleId, source: MembershipSource.MANUAL, isActive: true },
    });
  }

  try {
    const deptA = await createDepartment({ name: `RL-A-${RUN_ID}`, slug: `rl-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `RL-B-${RUN_ID}`, slug: `rl-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const noopGlobal = await makeRole("NOOP", RoleScope.GLOBAL, []);
    const editKeys = ["project.view", "project.edit", "activity.view", "activity.edit"];
    const editorRole = await makeRole("EDITOR_A", RoleScope.DEPARTMENT, editKeys);
    const viewerRole = await makeRole("VIEWER_A", RoleScope.DEPARTMENT, ["project.view", "activity.view"]);
    const globalEditorRole = await makeRole("GLOBAL_EDITOR", RoleScope.GLOBAL, editKeys);

    const editorA = await makeUser("editor-a", noopGlobal.id);
    await member(editorA.id, deptA.id, editorRole.id);
    const viewerA = await makeUser("viewer-a", noopGlobal.id);
    await member(viewerA.id, deptA.id, viewerRole.id);
    const globalEditor = await makeUser("global-editor", globalEditorRole.id); // NO DepartmentMembership anywhere
    const outsider = await makeUser("outsider", noopGlobal.id);
    const admin = await prisma.user.create({ data: { email: `rl-admin-${RUN_ID}@kinsen.gr`, name: "RL admin", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);

    const mkProject = async (departmentId: string, tag: string) => {
      const p = await prisma.project.create({ data: { title: `RL Project ${tag} ${RUN_ID}`, departmentId, ownerId: editorA.id } });
      projectIds.push(p.id);
      return p;
    };
    const mkActivity = async (departmentId: string, tag: string) => {
      const a = await prisma.projectActivity.create({ data: { title: `RL Activity ${tag} ${RUN_ID}`, departmentId } });
      activityIds.push(a.id);
      return a;
    };
    const projectA = await mkProject(deptA.id, "A");
    const projectB = await mkProject(deptB.id, "B");
    const activityA = await mkActivity(deptA.id, "A");
    const activityB = await mkActivity(deptB.id, "B");

    // ── 1. Authorized user adds a Project link ──
    console.log("\n1. Authorized user adds a Project link ===\n");
    asUser(editorA.id, noopGlobal.id);
    const r1 = await api.project.create(projectA.id, { url: "  https://company.sharepoint.com/document/abc  ", title: "  Final approved customer proposal  ", createdById: admin.id, projectId: projectB.id, activityId: activityA.id });
    check("1a. POST -> 201", r1.status === 201);
    const l1 = await r1.json();
    check("1b. url/title are trimmed", l1.url === "https://company.sharepoint.com/document/abc" && l1.title === "Final approved customer proposal");
    check("1c. creator is the authenticated user, never a body-supplied id", l1.createdBy?.id === editorA.id);
    const row1 = await prisma.relatedLink.findUniqueOrThrow({ where: { id: l1.id } });
    check("1d. owner is the ROUTE's project — body-supplied projectId/activityId ignored", row1.projectId === projectA.id && row1.activityId === null);
    check("1e. response exposes only UI fields (no projectId/activityId/createdById columns)", !("projectId" in l1) && !("activityId" in l1) && !("createdById" in l1));

    // ── 2. Authorized user adds an Activity link ──
    console.log("\n2. Authorized user adds an Activity link ===\n");
    const r2 = await api.activity.create(activityA.id, { url: "https://wiki.example.com/spec", title: "Design spec" });
    check("2a. POST -> 201", r2.status === 201);
    const l2 = await r2.json();
    const row2 = await prisma.relatedLink.findUniqueOrThrow({ where: { id: l2.id } });
    check("2b. owner is the activity", row2.activityId === activityA.id && row2.projectId === null);

    // ── 3. Both surfaces use the shared implementation ──
    console.log("\n3. Shared implementation ===\n");
    const [pl, pi, al, ai, projPage, actClient, handlers, service] = await Promise.all([
      fs.readFile("app/api/projects/[id]/related-links/route.ts", "utf8"),
      fs.readFile("app/api/projects/[id]/related-links/[linkId]/route.ts", "utf8"),
      fs.readFile("app/api/activities/[id]/related-links/route.ts", "utf8"),
      fs.readFile("app/api/activities/[id]/related-links/[linkId]/route.ts", "utf8"),
      fs.readFile("app/(main)/projects/[id]/page.tsx", "utf8"),
      fs.readFile("app/(main)/activities/[id]/activity-detail-client.tsx", "utf8"),
      fs.readFile("lib/related-links/route-handlers.ts", "utf8"),
      fs.readFile("lib/services/related-links-service.ts", "utf8"),
    ]);
    check("3a. all four routes only forward to the shared route-handlers", [pl, pi, al, ai].every((s) => /from "@\/lib\/related-links\/route-handlers"/.test(s) && !/prisma/.test(s)));
    check("3b. shared handlers call only the shared service", /from "@\/lib\/services\/related-links-service"/.test(handlers) && !/prisma/.test(handlers));
    check("3c. Project page and Activity page render the SAME EntityRelatedLinks component", /EntityRelatedLinks/.test(projPage) && /EntityRelatedLinks/.test(actClient) && /components\/related-links\/entity-related-links/.test(projPage) && /components\/related-links\/entity-related-links/.test(actClient));
    check("3d. only one component + one service implementation exist", (await fs.readdir("components/related-links")).length === 1 && !/relatedLink/i.test(await fs.readFile("app/api/projects/[id]/route.ts", "utf8")));
    const serviceCode = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only — the header comment legitimately NAMES the helpers it does not use
    check("3e. no new permission key and no role-name hardcoding in the service", !/Department Admin|Role\.ADMIN|=== "ADMIN"/.test(serviceCode) && !/hasEffectiveModulePermission|hasPermission\(/.test(serviceCode) && /hasEffectiveEntityPermission/.test(serviceCode) && /"project\.edit"/.test(serviceCode) && /"activity\.edit"/.test(serviceCode));
    const newPerm = await prisma.permission.count({ where: { key: { contains: "relatedLink", mode: "insensitive" } } });
    check("3f. no relatedLink permission row exists", newPerm === 0);

    // ── 4. Global effective edit permission works (no membership) ──
    console.log("\n4. Global effective edit permission (no DepartmentMembership) ===\n");
    asUser(globalEditor.id, globalEditorRole.id);
    check("4a. global editor can add to a Department A project", (await api.project.create(projectA.id, { url: "https://g.example.com/1", title: "global A" })).status === 201);
    check("4b. ...and to a Department B activity", (await api.activity.create(activityB.id, { url: "https://g.example.com/2", title: "global B" })).status === 201);
    asUser(admin.id, null, Role.ADMIN);
    check("4c. existing ADMIN behavior: can add anywhere", (await api.project.create(projectB.id, { url: "https://admin.example.com/", title: "admin" })).status === 201);

    // ── 5/6. Department A permission works for A, never modifies B ──
    console.log("\n5/6. Department A edit permission: works for A, not B ===\n");
    asUser(editorA.id, noopGlobal.id);
    check("5a. Department A editor adds to Department A activity", (await api.activity.create(activityA.id, { url: "https://a.example.com/x", title: "A note" })).status === 201);
    const bLinkRes = await (async () => {
      asUser(admin.id, null, Role.ADMIN);
      const r = await api.project.create(projectB.id, { url: "https://b.example.com/keep", title: "B original" });
      const l = await r.json();
      asUser(editorA.id, noopGlobal.id);
      return l;
    })();
    check("6a. Department A editor cannot ADD to a Department B project -> 403", (await api.project.create(projectB.id, { url: "https://x.example.com", title: "no" })).status === 403);
    check("6b. ...cannot add to a Department B activity -> 403", (await api.activity.create(activityB.id, { url: "https://x.example.com", title: "no" })).status === 403);
    check("6c. ...cannot EDIT a Department B link -> 403", (await api.project.patch(projectB.id, bLinkRes.id, { url: "https://evil.example.com", title: "hacked" })).status === 403);
    check("6d. ...cannot DELETE a Department B link -> 403", (await api.project.del(projectB.id, bLinkRes.id)).status === 403);
    const bAfter = await prisma.relatedLink.findUniqueOrThrow({ where: { id: bLinkRes.id } });
    check("6e. Department B link is unchanged", bAfter.url === "https://b.example.com/keep" && bAfter.title === "B original");

    // ── 7. View-only user sees links but cannot mutate ──
    console.log("\n7. View-only user ===\n");
    asUser(viewerA.id, noopGlobal.id);
    const v = await api.project.list(projectA.id);
    const vBody = await v.json();
    check("7a. view-only GET -> 200 with links", v.status === 200 && vBody.links.length >= 2);
    check("7b. canManage is false for view-only", vBody.canManage === false);
    check("7c. POST -> 403", (await api.project.create(projectA.id, { url: "https://v.example.com", title: "nope" })).status === 403);
    check("7d. PATCH -> 403", (await api.project.patch(projectA.id, l1.id, { url: "https://v.example.com", title: "nope" })).status === 403);
    check("7e. DELETE -> 403", (await api.project.del(projectA.id, l1.id)).status === 403);
    check("7f. link untouched", (await prisma.relatedLink.findUniqueOrThrow({ where: { id: l1.id } })).title === "Final approved customer proposal");
    asUser(outsider.id, noopGlobal.id);
    check("7g. a user with no view access can't even list -> 403", (await api.project.list(projectA.id)).status === 403);
    currentSession = null;
    check("7h. unauthenticated -> 401", (await api.project.list(projectA.id)).status === 401);
    asUser(editorA.id, noopGlobal.id);
    const eBody = await (await api.project.list(projectA.id)).json();
    check("7i. editor's GET reports canManage: true", eBody.canManage === true);

    // ── 8. Crafted Related Link ids from another entity ──
    console.log("\n8. Crafted Related Link id from another entity ===\n");
    const otherProjectLink = await prisma.relatedLink.create({ data: { url: "https://other.example.com", title: "other project A2", projectId: (await mkProject(deptA.id, "A2")).id } });
    check("8a. PATCH via project A with a link that belongs to project A2 -> 404", (await api.project.patch(projectA.id, otherProjectLink.id, { url: "https://evil.example.com", title: "x" })).status === 404);
    check("8b. DELETE via project A with a link of project A2 -> 404", (await api.project.del(projectA.id, otherProjectLink.id)).status === 404);
    check("8c. activity route with a PROJECT link id -> 404", (await api.activity.patch(activityA.id, l1.id, { url: "https://evil.example.com", title: "x" })).status === 404 && (await api.activity.del(activityA.id, l1.id)).status === 404);
    check("8d. nonexistent link id -> 404", (await api.project.del(projectA.id, "does-not-exist")).status === 404);
    check("8e. nonexistent entity -> 404", (await api.project.list("nope")).status === 404);
    const untouched = await prisma.relatedLink.findUniqueOrThrow({ where: { id: otherProjectLink.id } });
    check("8f. the foreign link is byte-for-byte unchanged", untouched.url === "https://other.example.com" && untouched.title === "other project A2");

    // ── 9/10. URL validation ──
    console.log("\n9/10. URL validation ===\n");
    const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:msgbox(1)", "not a url", "example.com", "//evil.example.com", "https://", "ftp://files.example.com", "mailto:a@b.com", "blob:https://x.com/1", "java\tscript:alert(1)", "https://exa mple.com", "   "];
    for (const url of bad) {
      const res = await api.project.create(projectA.id, { url, title: "t" });
      check(`9. rejected (422): ${JSON.stringify(url).slice(0, 48)}`, res.status === 422);
    }
    check("9x. missing url field -> 422", (await api.project.create(projectA.id, { title: "t" })).status === 422);
    check("9y. non-JSON body -> 422", (await projectList.POST(new NextRequest("http://localhost/x", { method: "POST", body: "not json" }), { params: Promise.resolve({ id: projectA.id }) })).status === 422);
    const good = ["http://example.com", "https://example.com/path?q=1&r=2#frag", "https://sub.example.com:8443/a/b", "HTTPS://Example.COM/Upper", "https://xn--nxasmq6b.example/παράδειγμα"];
    for (const url of good) {
      const res = await api.project.create(projectA.id, { url, title: "ok" });
      check(`10. accepted (201): ${url.slice(0, 48)}`, res.status === 201);
    }
    check("10x. parseSafeExternalUrl agrees with the server (shared function)", parseSafeExternalUrl("javascript:alert(1)") === null && parseSafeExternalUrl("https://ok.example.com") !== null);
    const noneStoredBad = await prisma.relatedLink.count({ where: { projectId: projectA.id, url: { startsWith: "javascript" } } });
    check("10y. no rejected URL was ever persisted", noneStoredBad === 0);

    // ── 11. Empty / over-limit ──
    console.log("\n11. Empty and over-limit fields ===\n");
    check("11a. empty title -> 422", (await api.project.create(projectA.id, { url: "https://e.example.com", title: "" })).status === 422);
    check("11b. whitespace-only title -> 422", (await api.project.create(projectA.id, { url: "https://e.example.com", title: "   " })).status === 422);
    check("11c. empty url -> 422", (await api.project.create(projectA.id, { url: "", title: "t" })).status === 422);
    check("11d. title of 251 chars -> 422", (await api.project.create(projectA.id, { url: "https://e.example.com", title: "x".repeat(251) })).status === 422);
    check("11e. title of exactly 250 chars -> 201", (await api.project.create(projectA.id, { url: "https://e.example.com", title: "x".repeat(250) })).status === 201);
    const prefix = "https://e.example.com/";
    check("11f. url of 2049 chars -> 422", (await api.project.create(projectA.id, { url: prefix + "a".repeat(2049 - prefix.length), title: "t" })).status === 422);
    const exact = prefix + "a".repeat(2048 - prefix.length);
    check("11g. url of exactly 2048 chars -> 201", (await api.project.create(projectA.id, { url: exact, title: "long" })).status === 201);
    const errBody = await (await api.project.create(projectA.id, { url: "nope", title: "" })).json();
    check("11h. error responses carry field errors for the UI", typeof errBody.error === "string" && !!errBody.fieldErrors);

    // ── 12. HTML/script in the title is inert ──
    console.log("\n12. HTML/script text stays inert ===\n");
    const evilTitle = `<img src=x onerror="alert(document.cookie)"><script>alert(1)</script> & "quotes"`;
    const r12 = await api.activity.create(activityA.id, { url: "https://safe.example.com", title: evilTitle });
    const l12 = await r12.json();
    check("12a. stored verbatim as text", r12.status === 201 && l12.title === evilTitle);
    const markup12 = renderToStaticMarkup(React.createElement(EntityRelatedLinks, { entityType: "activity", entityId: activityA.id, initialLinks: [l12], initialCanManage: true }));
    check("12b. rendered markup contains NO live <script>/<img> element", !/<script/i.test(markup12) && !/<img[\s>]/i.test(markup12));
    check("12c. the text is present, entity-escaped", markup12.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && markup12.includes("&lt;img src=x onerror="));
    check("12d. no dangerouslySetInnerHTML in the component", !/dangerouslySetInnerHTML/.test(await fs.readFile("components/related-links/entity-related-links.tsx", "utf8")));

    // ── ordering ──
    console.log("\nNewest first ===\n");
    const orderProject = await mkProject(deptA.id, "ORDER");
    for (const t of ["first", "second", "third"]) {
      await api.project.create(orderProject.id, { url: `https://o.example.com/${t}`, title: t });
      await sleep(8);
    }
    const ordered = (await (await api.project.list(orderProject.id)).json()).links.map((l: any) => l.title);
    check("newest link is listed first", JSON.stringify(ordered) === JSON.stringify(["third", "second", "first"]));

    // ── 13. Edit updates only the intended entry ──
    console.log("\n13. Edit updates only the intended entry ===\n");
    const [e1, e2] = await Promise.all(
      ["one", "two"].map(async (t) => (await api.project.create(orderProject.id, { url: `https://e.example.com/${t}`, title: `edit ${t}` })).json())
    );
    const before2 = await prisma.relatedLink.findUniqueOrThrow({ where: { id: e2.id } });
    const patch = await api.project.patch(orderProject.id, e1.id, { url: "https://e.example.com/changed", title: "  changed  " });
    const patched = await patch.json();
    check("13a. PATCH -> 200 with updated fields", patch.status === 200 && patched.url === "https://e.example.com/changed" && patched.title === "changed");
    const after2 = await prisma.relatedLink.findUniqueOrThrow({ where: { id: e2.id } });
    check("13b. the sibling entry is untouched (fields and updatedAt)", after2.url === before2.url && after2.title === before2.title && after2.updatedAt.getTime() === before2.updatedAt.getTime());
    check("13c. invalid edit is rejected and changes nothing", (await api.project.patch(orderProject.id, e1.id, { url: "javascript:alert(1)", title: "x" })).status === 422 && (await prisma.relatedLink.findUniqueOrThrow({ where: { id: e1.id } })).url === "https://e.example.com/changed");
    check("13d. creator is preserved by an edit", (await prisma.relatedLink.findUniqueOrThrow({ where: { id: e1.id } })).createdById === editorA.id);

    // ── 14. Delete removes only the intended entry ──
    console.log("\n14. Delete removes only the intended entry ===\n");
    const beforeCount = await prisma.relatedLink.count({ where: { projectId: orderProject.id } });
    check("14a. DELETE -> 200", (await api.project.del(orderProject.id, e1.id)).status === 200);
    check("14b. exactly one row removed", (await prisma.relatedLink.count({ where: { projectId: orderProject.id } })) === beforeCount - 1);
    check("14c. the deleted one is gone, the sibling remains", !(await prisma.relatedLink.findUnique({ where: { id: e1.id } })) && !!(await prisma.relatedLink.findUnique({ where: { id: e2.id } })));
    check("14d. deleting it again -> 404", (await api.project.del(orderProject.id, e1.id)).status === 404);

    // ── 15. Cascade ──
    console.log("\n15. Deleting a Project/Activity cascades its links ===\n");
    const cascadeProject = await mkProject(deptA.id, "CASCADE");
    const cascadeActivity = await mkActivity(deptA.id, "CASCADE");
    await api.project.create(cascadeProject.id, { url: "https://c.example.com/p", title: "cp" });
    await api.activity.create(cascadeActivity.id, { url: "https://c.example.com/a", title: "ca" });
    await prisma.project.delete({ where: { id: cascadeProject.id } });
    await prisma.projectActivity.delete({ where: { id: cascadeActivity.id } });
    check("15a. project delete removed its links", (await prisma.relatedLink.count({ where: { projectId: cascadeProject.id } })) === 0);
    check("15b. activity delete removed its links", (await prisma.relatedLink.count({ where: { activityId: cascadeActivity.id } })) === 0);
    const survivor = await prisma.relatedLink.count({ where: { projectId: projectA.id } });
    check("15c. other projects' links unaffected", survivor > 0);
    const tempUser = await makeUser("temp-creator", noopGlobal.id);
    const tempLink = await prisma.relatedLink.create({ data: { url: "https://t.example.com", title: "outlives creator", projectId: projectA.id, createdById: tempUser.id } });
    await prisma.user.delete({ where: { id: tempUser.id } });
    userIds.splice(userIds.indexOf(tempUser.id), 1);
    const orphan = await prisma.relatedLink.findUniqueOrThrow({ where: { id: tempLink.id } });
    check("15d. deleting the creator keeps the link (createdById -> null)", orphan.createdById === null);

    // ── 16. DB constraint: exactly one owner ──
    console.log("\n16. Database CHECK constraint: exactly one owner ===\n");
    const violates = async (data: Prisma.RelatedLinkUncheckedCreateInput) => {
      try {
        await prisma.relatedLink.create({ data });
        return false;
      } catch (e) {
        return String((e as Error).message).includes("RelatedLink_exactly_one_owner_chk") || (e as any)?.code === "P2010" || /check constraint/i.test(String((e as Error).message));
      }
    };
    check("16a. BOTH owners is rejected by the database", await violates({ url: "https://x.example.com", title: "both", projectId: projectA.id, activityId: activityA.id }));
    check("16b. NEITHER owner is rejected by the database", await violates({ url: "https://x.example.com", title: "neither" }));
    check("16c. project-only is accepted", !(await violates({ url: "https://x.example.com", title: "p", projectId: projectA.id })));
    check("16d. activity-only is accepted", !(await violates({ url: "https://x.example.com", title: "a", activityId: activityA.id })));
    let updateBoth = false;
    try {
      await prisma.relatedLink.update({ where: { id: l1.id }, data: { activityId: activityA.id } });
    } catch {
      updateBoth = true;
    }
    check("16e. an UPDATE that would leave two owners is rejected too", updateBoth);
    check("16f. the same URL is allowed more than once (no uniqueness)", (await api.project.create(projectA.id, { url: "https://company.sharepoint.com/document/abc", title: "same url, different note" })).status === 201);

    // ── 17/18. Rendered markup: overflow-safety classes + anchor attributes ──
    console.log("\n17/18. Rendered markup — overflow safety and external anchors ===\n");
    const veryLong = "https://" + "a".repeat(60) + ".example.com/" + "segment/".repeat(250);
    const dto = (id: string, url: string, title: string) => ({ id, url, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), createdBy: { id: "u", name: "Author", email: "a@x.com" } });
    const html = renderToStaticMarkup(
      React.createElement(EntityRelatedLinks, {
        entityType: "project",
        entityId: "p1",
        initialLinks: [dto("1", veryLong.slice(0, 2048), "Long one " + "word ".repeat(40)), dto("2", "https://normal.example.com/x", "Normal")],
        initialCanManage: true,
      })
    );
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    check("18a. every rendered anchor opens in a new tab", anchors.length === 2 && anchors.every((a) => /target="_blank"/.test(a)));
    check("18b. every rendered anchor has rel=\"noopener noreferrer\"", anchors.every((a) => /rel="noopener noreferrer"/.test(a)));
    const visibleText = html.replace(/<[^>]*>/g, " "); // attribute values (href/title) are not rendered text
    check("17a. the VISIBLE URL text is the truncated hostname only — a 2 KB URL cannot widen the page", /<span class="truncate">a{60}\.example\.com<\/span>/.test(html) && !visibleText.includes("segment/segment"));
    check("17b. the anchor is a min-w-0 / max-w-full flex child (can shrink below content width)", anchors.every((a) => /min-w-0/.test(a) && /max-w-full/.test(a)));
    check("17c. long titles wrap (break-words) and the text column is min-w-0 flex-1", /break-words/.test(html) && /min-w-0 flex-1/.test(html));
    check("17d. the add-form grid children are min-w-0 so long typed input can't push the card wider", (html.match(/space-y-1\.5 min-w-0/g) ?? []).length === 2);
    const tampered = renderToStaticMarkup(React.createElement(EntityRelatedLinks, { entityType: "project", entityId: "p1", initialLinks: [dto("3", "javascript:alert(1)", "tampered row")], initialCanManage: false }));
    check("18c. a tampered/legacy javascript: row renders as inert text — never a live href", !/<a\b/.test(tampered) && !/href="javascript/i.test(tampered));
    const viewOnly = renderToStaticMarkup(React.createElement(EntityRelatedLinks, { entityType: "project", entityId: "p1", initialLinks: [dto("1", "https://normal.example.com/x", "Normal")], initialCanManage: false }));
    check("7j. view-only render shows the link but NO Add/Edit/Delete controls", viewOnly.includes("Normal") && !viewOnly.includes("Add Link") && !/aria-label="Edit link/.test(viewOnly) && !/aria-label="Delete link/.test(viewOnly));
    const managerEmpty = renderToStaticMarkup(React.createElement(EntityRelatedLinks, { entityType: "activity", entityId: "a1", initialLinks: [], initialCanManage: true }));
    check("card: empty state, labels, placeholder and Add Link button", managerEmpty.includes("No related links yet.") && managerEmpty.includes("Title / Note") && managerEmpty.includes(">Link") && managerEmpty.includes("Add Link") && managerEmpty.includes("Related Links (0)"));
    check("card: shows creator + hostname + edit/delete for managers", html.includes("Author") && html.includes("aria-label=\"Edit link: Normal\"") && html.includes("aria-label=\"Delete link: Normal\""));
    const loadingMarkup = renderToStaticMarkup(React.createElement(EntityRelatedLinks, { entityType: "activity", entityId: "a1" }));
    check("card: with no initial data (Activity page) it starts in the loading state", loadingMarkup.includes("Loading…"));
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
