/**
 * User Management → Add Department Membership: ACTIVE departments only.
 *  - POST /api/admin/departments/[id]/members into an INACTIVE department →
 *    409 inactive_department, nothing created.
 *  - An existing membership in a department that later became inactive is
 *    preserved untouched (not deleted, modified or deactivated).
 *  - Active departments keep working.
 *  - The Users page passes each department's isActive flag (the dialog
 *    offers only active ones — verified in the browser script).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-user-membership-active-departments.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out; }
  if (pred(node)) out.push(node);
  const ch = node.props?.children;
  if (ch !== undefined) findAll(ch, pred, out);
  return out;
}
let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });
const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const { Role, AuthProvider, DepartmentRole, MembershipSource } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const membersRoute = await import("@/app/api/admin/departments/[id]/members/route");
  const { default: UsersPage } = await import("@/app/(main)/admin/users/page");
  const ids = { depts: [] as string[], users: [] as string[] };
  const jsonReq = (b: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    const active = await createDepartment({ name: `UMA Active ${RUN_ID}`, slug: `uma-active-${RUN_ID}` });
    const inactive = await createDepartment({ name: `UMA Inactive ${RUN_ID}`, slug: `uma-inactive-${RUN_ID}` });
    ids.depts.push(active.id, inactive.id);
    const admin = await prisma.user.create({ data: { email: `uma-admin-${RUN_ID}@kinsen.gr`, name: `UMA Admin`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const target = await prisma.user.create({ data: { email: `uma-target-${RUN_ID}@kinsen.gr`, name: `UMA Target`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const other = await prisma.user.create({ data: { email: `uma-other-${RUN_ID}@kinsen.gr`, name: `UMA Other`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ids.users.push(admin.id, target.id, other.id);
    // Existing membership created while the department was still active, then the department is deactivated.
    const existing = await prisma.departmentMembership.create({ data: { userId: target.id, departmentId: inactive.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    await prisma.department.update({ where: { id: inactive.id }, data: { isActive: false } });
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const res = await membersRoute.POST(jsonReq({ userId: other.id, role: DepartmentRole.VIEWER }), { params: Promise.resolve({ id: inactive.id }) });
    const body = await res.json();
    check("Direct API: new membership in an INACTIVE department → 409 inactive_department", res.status === 409 && body.code === "inactive_department", JSON.stringify(body));
    check("...nothing created for that user in the inactive department", (await prisma.departmentMembership.count({ where: { userId: other.id, departmentId: inactive.id } })) === 0);
    const resExisting = await membersRoute.POST(jsonReq({ userId: target.id, role: DepartmentRole.VIEWER }), { params: Promise.resolve({ id: inactive.id }) });
    const existingAfter = await prisma.departmentMembership.findUniqueOrThrow({ where: { id: existing.id } });
    check("Existing membership in the now-inactive department is preserved untouched (still active, same role, not deleted)", resExisting.status === 409 && existingAfter.isActive === true && existingAfter.role === DepartmentRole.AGENT_ASSIGNEE);
    const okRes = await membersRoute.POST(jsonReq({ userId: other.id, role: DepartmentRole.VIEWER }), { params: Promise.resolve({ id: active.id }) });
    check("Active department: membership created normally → 201", okRes.status === 201 && (await prisma.departmentMembership.count({ where: { userId: other.id, departmentId: active.id, isActive: true } })) === 1);

    const el = await UsersPage({ searchParams: Promise.resolve({}) } as any);
    const umProps = findAll(el, (n) => Array.isArray(n.props?.departments) && Array.isArray(n.props?.users))[0]?.props;
    const inPage = (id: string) => umProps?.departments.find((d: any) => d.id === id);
    check("Users page passes each department's isActive flag (inactive one present for listing/filters, flagged inactive)", inPage(active.id)?.isActive === true && inPage(inactive.id)?.isActive === false);
  } finally {
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids.users } } }).catch(() => {});
    for (const t of ["ticketStatus", "ticketPriority", "ticketCategory"] as const) await (prisma as any)[t].deleteMany({ where: { departmentId: { in: ids.depts } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: { in: ids.depts } } }).catch((e: any) => console.warn("dept cleanup", String(e.message).split("\n")[0]));
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
