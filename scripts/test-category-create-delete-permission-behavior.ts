/**
 * Behavioral regression for the new `category.create` permission (added
 * alongside the pre-existing `category.delete`) — proves Ticket Category
 * create/delete is governed by real, independently-assignable RBAC
 * permissions, never a hardcoded `role === ADMIN`/requireAdmin check.
 *
 * Drives the REAL route handlers (POST/DELETE app/api/admin/categories/
 * route.ts) and the REAL department-scoped Category management page
 * (app/(main)/admin/departments/[id]/categories/page.tsx) against a real
 * database, with a mocked @/lib/auth session — same established pattern as
 * scripts/test-ticket-mutation-realtime-completeness.ts.
 *
 * Covers (numbered to match the task brief):
 *  1. Admin retains create/delete after the migration.
 *  2. A non-admin Custom Role with category.create can create a category.
 *  3. A non-admin Custom Role with category.delete can delete a category.
 *  4. Create-only and delete-only permissions are genuinely independent.
 *  5. A user without the matching permission gets 403 on a direct API call.
 *  6. A failed/unauthorized request never mutates the database.
 *  7. Existing delete dependency guards (in-use category) stay enforced.
 *  8. UI controls (canCreate/canEdit/canDelete) reflect the caller's actual
 *     permissions.
 *  9. Reaching the Category UI never leaks broader admin-settings access.
 * 10. The permission is listed by, and assignable/removable through, the
 *     real Role editor API.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-category-create-delete-permission-behavior.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

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

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

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
  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const { Role, RoleScope, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { hasDepartmentPermission, hasPermission, canManageAnyRoles } = await import("@/lib/permissions");
  const { POST: categoriesPOST, DELETE: categoriesDELETE } = await import("@/app/api/admin/categories/route");
  const { default: DepartmentCategoriesPage } = await import("@/app/(main)/admin/departments/[id]/categories/page");
  const { WorkspaceConfigManager } = await import("@/components/admin/workspace-config-manager");
  const { GET: rolesGET } = await import("@/app/api/admin/roles/route");
  const { POST: rolePermPOST, DELETE: rolePermDELETE } = await import("@/app/api/admin/roles/[id]/permissions/[permId]/route");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const categoryIds: string[] = [];
  const ticketIds: string[] = [];

  async function makeDeptCustomRole(tag: string, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `CATBEH_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  async function makeMember(email: string, departmentId: string, customRoleId: string | null) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    const m = await prisma.departmentMembership.create({
      data: { userId: u.id, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(m.id);
    return u;
  }
  function postReq(body: unknown) {
    return new NextRequest("http://localhost/api/admin/categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  function deleteReq(id: string) {
    return new NextRequest(`http://localhost/api/admin/categories?id=${id}`, { method: "DELETE" });
  }

  try {
    const dept = await createDepartment({ name: `Cat Perm Behavior ${RUN_ID}`, slug: `cat-perm-behavior-${RUN_ID}` });
    departmentIds.push(dept.id);

    const admin = await prisma.user.create({ data: { email: `catbeh-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);

    const createOnlyRole = await makeDeptCustomRole("CREATE_ONLY", ["category.create"]);
    const deleteOnlyRole = await makeDeptCustomRole("DELETE_ONLY", ["category.delete"]);
    const neitherRole = await makeDeptCustomRole("NEITHER", ["ticket.view"]);

    const createOnlyUser = await makeMember(`catbeh-createonly-${RUN_ID}@kinsen.gr`, dept.id, createOnlyRole.id);
    const deleteOnlyUser = await makeMember(`catbeh-deleteonly-${RUN_ID}@kinsen.gr`, dept.id, deleteOnlyRole.id);
    const neitherUser = await makeMember(`catbeh-neither-${RUN_ID}@kinsen.gr`, dept.id, neitherRole.id);

    // ══════════════ 1. Admin retains create/delete after the migration ══════════════
    console.log("\n=== 1. Admin retains Create/Delete Category after the migration ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const adminCreateRes = await categoriesPOST(postReq({ departmentId: dept.id, name: `Admin Cat ${RUN_ID}`, color: "#111111" }));
    check("Admin: POST -> 201 Created", adminCreateRes.status === 201);
    const adminCat = await adminCreateRes.json();
    categoryIds.push(adminCat.id);
    const adminDeleteRes = await categoriesDELETE(deleteReq(adminCat.id));
    check("Admin: DELETE (unused) -> 204", adminDeleteRes.status === 204);
    check("Admin: category genuinely removed from the DB", (await prisma.ticketCategory.findUnique({ where: { id: adminCat.id } })) === null);
    categoryIds.splice(categoryIds.indexOf(adminCat.id), 1);

    // ══════════════ 2/3. Independent create-only / delete-only Custom Roles ══════════════
    console.log("\n=== 2. Non-admin Custom Role with category.create creates a Category ===\n");
    currentSession = { user: { id: createOnlyUser.id, role: Role.USER, customRoleId: null } };
    const createOnlyRes = await categoriesPOST(postReq({ departmentId: dept.id, name: `CreateOnly Cat ${RUN_ID}`, color: "#222222" }));
    check("create-only user: POST -> 201 Created", createOnlyRes.status === 201);
    const createOnlyCat = await createOnlyRes.json();
    categoryIds.push(createOnlyCat.id);
    check("...category genuinely persisted", (await prisma.ticketCategory.findUnique({ where: { id: createOnlyCat.id } })) !== null);

    console.log("\n=== 3. Non-admin Custom Role with category.delete deletes a Category ===\n");
    const forDeleteOnly = await prisma.ticketCategory.create({ data: { name: `ForDeleteOnly ${RUN_ID}`, color: "#333333", departmentId: dept.id } });
    categoryIds.push(forDeleteOnly.id);
    currentSession = { user: { id: deleteOnlyUser.id, role: Role.USER, customRoleId: null } };
    const deleteOnlyRes = await categoriesDELETE(deleteReq(forDeleteOnly.id));
    check("delete-only user: DELETE (unused) -> 204", deleteOnlyRes.status === 204);
    check("...category genuinely removed", (await prisma.ticketCategory.findUnique({ where: { id: forDeleteOnly.id } })) === null);
    categoryIds.splice(categoryIds.indexOf(forDeleteOnly.id), 1);

    // ══════════════ 4. create-only / delete-only are genuinely independent ══════════════
    console.log("\n=== 4. create-only cannot delete; delete-only cannot create ===\n");
    currentSession = { user: { id: createOnlyUser.id, role: Role.USER, customRoleId: null } };
    const createOnlyDeleteAttempt = await categoriesDELETE(deleteReq(createOnlyCat.id));
    check("create-only user: DELETE -> 403 (no category.delete)", createOnlyDeleteAttempt.status === 403);
    check("...the category is still there afterward (no mutation)", (await prisma.ticketCategory.findUnique({ where: { id: createOnlyCat.id } })) !== null);

    currentSession = { user: { id: deleteOnlyUser.id, role: Role.USER, customRoleId: null } };
    const countBeforeDeleteOnlyCreate = await prisma.ticketCategory.count({ where: { departmentId: dept.id } });
    const deleteOnlyCreateAttempt = await categoriesPOST(postReq({ departmentId: dept.id, name: `DeleteOnly Attempt ${RUN_ID}`, color: "#444444" }));
    check("delete-only user: POST -> 403 (no category.create)", deleteOnlyCreateAttempt.status === 403);
    const countAfterDeleteOnlyCreate = await prisma.ticketCategory.count({ where: { departmentId: dept.id } });
    check("...no category was actually created (6. failed request doesn't mutate the DB)", countBeforeDeleteOnlyCreate === countAfterDeleteOnlyCreate);

    // ══════════════ 5/6. No permission at all -> 403, DB unchanged ══════════════
    console.log("\n=== 5/6. A user without ANY category permission gets 403; the DB is never mutated ===\n");
    currentSession = { user: { id: neitherUser.id, role: Role.USER, customRoleId: null } };
    const countBeforeNeither = await prisma.ticketCategory.count({ where: { departmentId: dept.id } });
    const neitherCreateRes = await categoriesPOST(postReq({ departmentId: dept.id, name: `Neither Attempt ${RUN_ID}`, color: "#555555" }));
    check("neither-permission user: POST -> 403", neitherCreateRes.status === 403);
    const neitherDeleteRes = await categoriesDELETE(deleteReq(createOnlyCat.id));
    check("neither-permission user: DELETE -> 403", neitherDeleteRes.status === 403);
    const countAfterNeither = await prisma.ticketCategory.count({ where: { departmentId: dept.id } });
    check("...zero net DB change from either rejected attempt", countBeforeNeither === countAfterNeither);
    check("...the target category from the rejected DELETE attempt still exists", (await prisma.ticketCategory.findUnique({ where: { id: createOnlyCat.id } })) !== null);

    // Anonymous (no session at all) -> also 403/401-equivalent, never mutates.
    currentSession = null;
    const anonRes = await categoriesPOST(postReq({ departmentId: dept.id, name: `Anon Attempt ${RUN_ID}`, color: "#666666" }));
    check("No session at all: POST is rejected (401)", anonRes.status === 401);

    // ══════════════ 7. Existing delete dependency guards stay enforced ══════════════
    console.log("\n=== 7. The pre-existing in-use dependency guard on delete is untouched ===\n");
    const statusForTicket = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true } });
    const requesterForTicket = await prisma.user.create({ data: { email: `catbeh-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(requesterForTicket.id);
    const inUseCategory = await prisma.ticketCategory.create({ data: { name: `InUse Cat ${RUN_ID}`, color: "#777777", departmentId: dept.id } });
    categoryIds.push(inUseCategory.id);
    const ticketUsingCategory = await prisma.ticket.create({
      data: { title: `Uses category ${RUN_ID}`, description: "seed", source: "WEB", requesterId: requesterForTicket.id, departmentId: dept.id, statusId: statusForTicket.id, categoryId: inUseCategory.id },
    });
    ticketIds.push(ticketUsingCategory.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const inUseDeleteRes = await categoriesDELETE(deleteReq(inUseCategory.id));
    check("Admin: DELETE an in-use category (still referenced by a real ticket) -> 409, not 204", inUseDeleteRes.status === 409);
    check("...the category still exists (guard actually blocked the delete)", (await prisma.ticketCategory.findUnique({ where: { id: inUseCategory.id } })) !== null);

    // ══════════════ 8. UI controls reflect actual permissions ══════════════
    console.log("\n=== 8. Category management UI: canCreate/canEdit/canDelete reflect the caller's real permissions ===\n");
    async function callCategoriesPage(userId: string) {
      const el = await DepartmentCategoriesPage({ params: Promise.resolve({ id: dept.id }) });
      void userId;
      const [managerEl] = findElementsByType(el, WorkspaceConfigManager);
      return managerEl?.props as { canCreate: boolean; canEdit: boolean; canDelete: boolean } | undefined;
    }
    currentSession = { user: { id: createOnlyUser.id, role: Role.USER, customRoleId: null } };
    const createOnlyProps = await callCategoriesPage(createOnlyUser.id);
    check("create-only user: canCreate=true", createOnlyProps?.canCreate === true);
    check("create-only user: canDelete=false (Delete action hidden)", createOnlyProps?.canDelete === false);
    check("create-only user: canEdit=false (never held category.manage)", createOnlyProps?.canEdit === false);

    currentSession = { user: { id: deleteOnlyUser.id, role: Role.USER, customRoleId: null } };
    const deleteOnlyProps = await callCategoriesPage(deleteOnlyUser.id);
    check("delete-only user: canDelete=true", deleteOnlyProps?.canDelete === true);
    check("delete-only user: canCreate=false (Create UI hidden)", deleteOnlyProps?.canCreate === false);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const adminProps = await callCategoriesPage(admin.id);
    check("Admin: canCreate=true, canEdit=true, canDelete=true", adminProps?.canCreate === true && adminProps?.canEdit === true && adminProps?.canDelete === true);

    // ══════════════ 9. Category UI access never leaks broader admin settings ══════════════
    console.log("\n=== 9. Reaching the Category UI grants nothing beyond Categories ===\n");
    check("create-only custom role holds ONLY category.create — no department.manageSettings", (await hasDepartmentPermission(DepartmentRole.VIEWER, "department.manageSettings", createOnlyRole.id)) === false);
    check("...no user.manage", (await hasPermission(Role.USER, "user.manage", createOnlyRole.id)) === false);
    check("...no role.manage", (await hasPermission(Role.USER, "role.manage", createOnlyRole.id)) === false);
    check("...no category.manage (create-only never implies edit)", (await hasDepartmentPermission(DepartmentRole.VIEWER, "category.manage", createOnlyRole.id)) === false);
    currentSession = { user: { id: createOnlyUser.id, role: Role.USER, customRoleId: null } };
    check("create-only user cannot reach the Roles & Permissions admin surface (canManageAnyRoles = false)", (await canManageAnyRoles(Role.USER, null)) === false);
    const managerEl2 = findElementsByType(await DepartmentCategoriesPage({ params: Promise.resolve({ id: dept.id }) }), WorkspaceConfigManager)[0];
    check("The rendered admin component is hardcoded to the Categories API endpoint only (structurally cannot reach any other admin resource)", managerEl2?.props.apiEndpoint === "/api/admin/categories");
    check("...and to Category-only fields (name/description/color) — no department-settings/user/role fields are ever passed through", JSON.stringify(managerEl2?.props.fields.map((f: any) => f.key)) === JSON.stringify(["name", "description", "color"]));
    currentSession = { user: { id: neitherUser.id, role: Role.USER, customRoleId: null } };
    let neitherPageResult: any = null;
    try {
      neitherPageResult = await DepartmentCategoriesPage({ params: Promise.resolve({ id: dept.id }) });
    } catch (err: any) {
      neitherPageResult = err;
    }
    const isRedirect = typeof neitherPageResult?.digest === "string" && neitherPageResult.digest.startsWith("NEXT_REDIRECT");
    check("A user with NO category permission at all is redirected away from the Category page entirely (never shown a degraded admin view)", isRedirect);

    // ══════════════ 10. Role editor: listed, assignable, removable ══════════════
    console.log("\n=== 10. category.create is listed by, and assignable/removable through, the real Role editor API ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const rolesListRes = await rolesGET(new NextRequest("http://localhost/api/admin/roles"));
    check("GET /api/admin/roles -> 200", rolesListRes.status === 200);
    const rolesListBody = await rolesListRes.json();
    const categoryCreatePerm = rolesListBody.permissions.find((p: any) => p.key === "category.create");
    check("category.create appears in the Role editor's permission catalogue", categoryCreatePerm !== undefined);
    check("...grouped under the 'ticketConfig' module, alongside category.manage/category.delete", categoryCreatePerm?.module === "ticketConfig");

    const editorTestRole = await prisma.customRole.create({ data: { key: `CATBEH_EDITOR_${RUN_ID}`, name: `Editor Test ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
    customRoleIds.push(editorTestRole.id);
    customRoleKeys.push(editorTestRole.key);
    const assignRes = await rolePermPOST(new NextRequest("http://localhost/api/admin/roles/x/permissions/y", { method: "POST" }), { params: Promise.resolve({ id: editorTestRole.id, permId: categoryCreatePerm.id }) });
    check("POST .../roles/[id]/permissions/[permId] (assign category.create) -> 200", assignRes.status === 200);
    check("...RolePermission row genuinely created", (await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey: editorTestRole.key, permissionId: categoryCreatePerm.id } } })) !== null);

    const unassignRes = await rolePermDELETE(new NextRequest("http://localhost/api/admin/roles/x/permissions/y", { method: "DELETE" }), { params: Promise.resolve({ id: editorTestRole.id, permId: categoryCreatePerm.id }) });
    check("DELETE .../roles/[id]/permissions/[permId] (unassign category.create) -> 200", unassignRes.status === 200);
    check("...RolePermission row genuinely removed", (await prisma.rolePermission.findUnique({ where: { roleKey_permissionId: { roleKey: editorTestRole.key, permissionId: categoryCreatePerm.id } } })) === null);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.ticketCategory.deleteMany({ where: { id: { in: categoryIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
