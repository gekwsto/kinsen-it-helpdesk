/**
 * Owner(s) editing for existing Request-origin Projects through
 * PATCH /api/projects/[id] (the existing update API): add / replace /
 * remove with the same eligibility as Project setup (real, active users,
 * system-wide, at least one), project.edit authorization, ownership-derived
 * access following the change, the Project Request (requester, approvals)
 * and related Activities untouched, standalone Projects unchanged.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-owner-editing.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");
  const route = await import("@/app/api/projects/[id]/route");
  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], projects: [] as string[], requests: [] as string[], activities: [] as string[] };
  const as = (u: { id: string }, role: any = Role.USER, customRoleId: string | null = null) => { currentSession = { user: { id: u.id, role, customRoleId } }; };
  const user = async (tag: string, active = true) => {
    const u = await prisma.user.create({ data: { email: `owner-edit-${tag}-${RUN_ID}@kinsen.gr`, name: `OE ${tag}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: active } });
    ids.users.push(u.id);
    return u;
  };
  const patch = async (projectId: string, body: Record<string, unknown>) => {
    const res = await route.PATCH(new NextRequest(`http://localhost/api/projects/${projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: projectId }) });
    let json: any = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  const ownersOf = async (projectId: string) => {
    const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { owners: { select: { id: true } } } });
    return { ownerId: p.ownerId, owners: p.owners.map((o) => o.id).sort() };
  };

  try {
    const dept = await createDepartment({ name: `Owner Edit ${RUN_ID}`, slug: `owner-edit-${RUN_ID}` });
    ids.depts.push(dept.id);
    const editorRole = await prisma.customRole.create({ data: { key: `OE_EDIT_${RUN_ID}`, name: `OE edit ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
    ids.roles.push(editorRole.id); ids.roleKeys.push(editorRole.key);
    for (const k of ["project.view", "project.edit"]) await prisma.rolePermission.create({ data: { roleKey: editorRole.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    const viewerRole = await prisma.customRole.create({ data: { key: `OE_VIEW_${RUN_ID}`, name: `OE view ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
    ids.roles.push(viewerRole.id); ids.roleKeys.push(viewerRole.key);
    await prisma.rolePermission.create({ data: { roleKey: viewerRole.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: "project.view" } })).id } });
    const noop = await prisma.customRole.create({ data: { key: `OE_NOOP_${RUN_ID}`, name: `OE noop ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL", isActive: true } });
    ids.roles.push(noop.id); ids.roleKeys.push(noop.key);

    const editor = await user("editor");
    await prisma.departmentMembership.create({ data: { userId: editor.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: editorRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    const viewer = await user("viewer");
    await prisma.departmentMembership.create({ data: { userId: viewer.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: viewerRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    // Outsiders (no department membership, no global view) — access ONLY through ownership.
    const o1 = await prisma.user.update({ where: { id: (await user("o1")).id }, data: { customRoleId: noop.id } });
    const o2 = await prisma.user.update({ where: { id: (await user("o2")).id }, data: { customRoleId: noop.id } });
    const o3 = await prisma.user.update({ where: { id: (await user("o3")).id }, data: { customRoleId: noop.id } });
    const inactive = await user("inactive", false);
    const requester = await user("requester");
    const approver = await user("approver");

    const approvedAt = new Date("2026-11-01T10:00:00Z");
    const request = await prisma.projectRequest.create({ data: { title: `OE Request ${RUN_ID}`, departmentId: dept.id, requesterId: requester.id, status: "APPROVED", approverId: approver.id, approvedAt, businessAssessment: "approved", source: "STANDARD" } });
    ids.requests.push(request.id);
    const ro = await prisma.project.create({ data: { title: `OE Request-origin ${RUN_ID}`, departmentId: dept.id, ownerId: o1.id, owners: { connect: [{ id: o1.id }] }, projectRequestId: request.id } });
    ids.projects.push(ro.id);
    const act = await prisma.projectActivity.create({ data: { title: `OE Activity ${RUN_ID}`, departmentId: dept.id, projectId: ro.id, ownerId: o1.id } });
    ids.activities.push(act.id);
    const standalone = await prisma.project.create({ data: { title: `OE Standalone ${RUN_ID}`, departmentId: dept.id, ownerId: editor.id, owners: { connect: [{ id: editor.id }] } } });
    ids.projects.push(standalone.id);
    const view = (u: { id: string; customRoleId?: string | null }, p: { id: string; departmentId: string | null; projectRequestId: string | null }) => hasProjectViewAccess(u.id, Role.USER, u.customRoleId ?? null, p as any);

    console.log("\n=== Before ===\n");
    check("o1 (owner) can view the Request-origin Project; o2 cannot", (await view(o1, ro)) && !(await view(o2, ro)));

    console.log("\n=== Replace / add / remove ===\n");
    as(editor);
    const rep = await patch(ro.id, { ownerIds: [o2.id] });
    check("Replace o1 -> o2 by a user with project.edit -> 200", rep.status === 200, JSON.stringify(rep.json).slice(0, 200));
    check("...owners = [o2], primary ownerId = o2 (old primary no longer selected)", JSON.stringify(await ownersOf(ro.id)) === JSON.stringify({ ownerId: o2.id, owners: [o2.id] }));
    check("...ownership-derived access follows: o2 can now view, o1 no longer can", (await view(o2, ro)) && !(await view(o1, ro)));
    check("...GET response exposes the full Owner set (used by the edit page)", Array.isArray(rep.json?.owners) && rep.json.owners.map((o: any) => o.id).join() === o2.id);
    const add = await patch(ro.id, { ownerIds: [o2.id, o3.id] });
    check("Add o3 -> 200, owners = [o2, o3], primary stays o2", add.status === 200 && JSON.stringify(await ownersOf(ro.id)) === JSON.stringify({ ownerId: o2.id, owners: [o2.id, o3.id].sort() }));
    const rem = await patch(ro.id, { ownerIds: [o3.id] });
    check("Remove o2 -> 200, owners = [o3], primary moves to o3", rem.status === 200 && JSON.stringify(await ownersOf(ro.id)) === JSON.stringify({ ownerId: o3.id, owners: [o3.id] }));
    const unrelated = await patch(ro.id, { title: `OE Renamed ${RUN_ID}` });
    check("Unrelated edit (ownerIds omitted) leaves Owners unchanged", unrelated.status === 200 && JSON.stringify(await ownersOf(ro.id)) === JSON.stringify({ ownerId: o3.id, owners: [o3.id] }));

    console.log("\n=== Eligibility & authorization ===\n");
    check("Empty Owner list -> 422 (at least one required)", (await patch(ro.id, { ownerIds: [] })).status === 422);
    const inact = await patch(ro.id, { ownerIds: [inactive.id] });
    check("Inactive user -> 400 invalid_project_owner", inact.status === 400 && inact.json?.code === "invalid_project_owner");
    check("Non-existent user -> 400 invalid_project_owner", (await patch(ro.id, { ownerIds: ["does-not-exist"] })).json?.code === "invalid_project_owner");
    as(viewer);
    const unauth = await patch(ro.id, { ownerIds: [viewer.id] });
    check("User WITHOUT project.edit -> 403, Owners unchanged", unauth.status === 403 && JSON.stringify(await ownersOf(ro.id)) === JSON.stringify({ ownerId: o3.id, owners: [o3.id] }));

    console.log("\n=== Preserved ===\n");
    const reqAfter = await prisma.projectRequest.findUniqueOrThrow({ where: { id: request.id } });
    check("Project Request untouched: requester, approver, approval time, status, assessment", reqAfter.requesterId === requester.id && reqAfter.approverId === approver.id && reqAfter.approvedAt?.getTime() === approvedAt.getTime() && reqAfter.status === "APPROVED" && reqAfter.businessAssessment === "approved");
    check("Project still linked to the same Project Request", (await prisma.project.findUniqueOrThrow({ where: { id: ro.id } })).projectRequestId === request.id);
    check("Activity ownership NOT reassigned", (await prisma.projectActivity.findUniqueOrThrow({ where: { id: act.id } })).ownerId === o1.id);

    console.log("\n=== Standalone unchanged ===\n");
    as(editor);
    const sa = await patch(standalone.id, { ownerIds: [o2.id] });
    check("Standalone Project: ownerIds ignored (200, owner still the creator)", sa.status === 200 && JSON.stringify(await ownersOf(standalone.id)) === JSON.stringify({ ownerId: editor.id, owners: [editor.id] }));

    const editSrc = await fs.readFile("app/(main)/projects/[id]/edit/page.tsx", "utf8");
    check("Edit page: Owner(s) picker lives in the Request-origin-only section and ownerIds is sent only there", /\{projectRequestId && \([\s\S]*?<ProjectOwnersPicker/.test(editSrc) && /expectedTotalInitialDaysOverride: expectedOverride\.value,\s*ownerIds: Array\.from\(selectedOwnerIds\)/.test(editSrc));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roles } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e) { console.warn(`Cleanup ${l} failed:`, e instanceof Error ? e.message : e); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
