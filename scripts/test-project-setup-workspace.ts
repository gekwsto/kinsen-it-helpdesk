/**
 * Editable destination Workspace during Project Request setup
 * (POST /api/project-requests/[id]/project → createProjectFromApprovedRequest).
 *
 *  - Omitted departmentId → the request's own Workspace (previous behaviour).
 *  - A different Workspace where the user may create Projects → the Project
 *    is created there; the Project Request (department, status, approver,
 *    requester) is unchanged and no approval step is repeated.
 *  - A Workspace without project.create → 403 forbidden_destination, nothing created.
 *  - Source authority unchanged: projectRequest.approve in the REQUEST's
 *    department is still required (project.create elsewhere isn't enough).
 *  - Destination-dependent checks follow the destination: Members must be
 *    assignable there; a sub-department must belong to it.
 *  - ADMIN may choose any active Workspace.
 *  - The setup page offers exactly: request's Workspace + project.create Workspaces.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-setup-workspace.ts
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
mock.module("next/navigation", { namedExports: { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, notFound: () => { throw new Error("NOT_FOUND"); } } });
const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const { Role, AuthProvider, DepartmentRole, MembershipSource } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const { default: NewProjectPage } = await import("@/app/(main)/projects/new/page");

  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], requests: [] as string[], projects: [] as string[], expense: [] as string[], subDepts: [] as string[] };
  const jsonReq = (b: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const as = (u: { id: string }, role: any = Role.USER) => { currentSession = { user: { id: u.id, role, customRoleId: null } }; };
  const user = async (tag: string, role: any = Role.USER) => { const u = await prisma.user.create({ data: { email: `psw-${tag}-${RUN_ID}@kinsen.gr`, name: `PSW ${tag} ${RUN_ID}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true } }); ids.users.push(u.id); return u; };
  const role = async (tag: string, keys: string[]) => {
    const r = await prisma.customRole.create({ data: { key: `PSW_${tag}_${RUN_ID}`, name: `PSW ${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    ids.roles.push(r.id); ids.roleKeys.push(r.key);
    for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    return r;
  };
  const member = (userId: string, departmentId: string, customRoleId: string) => prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });

  try {
    const deptA = await createDepartment({ name: `PSW A ${RUN_ID}`, slug: `psw-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PSW B ${RUN_ID}`, slug: `psw-b-${RUN_ID}` });
    const deptC = await createDepartment({ name: `PSW C ${RUN_ID}`, slug: `psw-c-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id, deptC.id);
    const approveRole = await role("APPROVE", ["projectRequest.approve", "project.view"]);
    const createRole = await role("CREATE", ["project.create", "project.view"]);
    const assignableRole = await role("ASSIGNABLE", ["project.assignable"]);
    const setupUser = await user("setup"); await member(setupUser.id, deptA.id, approveRole.id); await member(setupUser.id, deptB.id, createRole.id);
    const createOnly = await user("createonly"); await member(createOnly.id, deptB.id, createRole.id);
    const requester = await user("requester");
    const approver = await user("approver");
    const memberA = await user("memberA"); await member(memberA.id, deptA.id, assignableRole.id);
    const memberB = await user("memberB"); await member(memberB.id, deptB.id, assignableRole.id);
    const admin = await user("admin", Role.ADMIN);
    const expense = await prisma.projectExpenseType.create({ data: { name: `PSW Expense ${RUN_ID}` } });
    ids.expense.push(expense.id);
    const subA = await prisma.subDepartment.create({ data: { name: `PSW SubA ${RUN_ID}`, departmentId: deptA.id } });
    ids.subDepts.push(subA.id);

    const approvedAt = new Date("2026-11-01T10:00:00.000Z");
    const mkRequest = async (tag: string) => {
      const r = await prisma.projectRequest.create({ data: { title: `PSW ${tag} ${RUN_ID}`, departmentId: deptA.id, requesterId: requester.id, approverId: approver.id, approvedAt, status: "APPROVED", source: "STANDARD" } });
      ids.requests.push(r.id);
      return r;
    };
    const body = (extra: Record<string, unknown> = {}) => ({ title: `PSW Project ${RUN_ID}`, ownerIds: [setupUser.id], expectedStartDate: "2027-01-04", expectedFinishDate: "2027-01-15", expenseTypeId: expense.id, ...extra });
    const setup = async (requestId: string, extra: Record<string, unknown> = {}) => {
      const res = await setupPOST(jsonReq(body(extra)), { params: Promise.resolve({ id: requestId }) });
      const json = await res.json();
      if (json.id) ids.projects.push(json.id);
      return { status: res.status, json };
    };
    const snapshot = (id: string) => prisma.projectRequest.findUniqueOrThrow({ where: { id }, select: { departmentId: true, status: true, requesterId: true, approverId: true, approvedAt: true, title: true } });

    console.log("\n=== Destination Workspace ===\n");
    as(setupUser);
    const r1 = await mkRequest("default");
    const s1 = await setup(r1.id);
    const p1 = s1.json.id ? await prisma.project.findUniqueOrThrow({ where: { id: s1.json.id } }) : null;
    check("No departmentId → Project created in the request's Workspace (A) — previous behaviour", s1.status === 201 && p1?.departmentId === deptA.id && p1?.projectRequestId === r1.id);

    const r2 = await mkRequest("moved");
    const before2 = await snapshot(r2.id);
    const s2 = await setup(r2.id, { departmentId: deptB.id });
    const p2 = s2.json.id ? await prisma.project.findUniqueOrThrow({ where: { id: s2.json.id } }) : null;
    check("departmentId = B (user holds project.create there) → Project created in B, linked to the request", s2.status === 201 && p2?.departmentId === deptB.id && p2?.projectRequestId === r2.id);
    check("...the Project Request is unchanged (department A, status, requester, approver, approval time)", JSON.stringify(await snapshot(r2.id)) === JSON.stringify(before2));
    check("...no approval step repeated: no new intermediate-approver rows, status still APPROVED", (await prisma.projectRequestIntermediateApprover.count({ where: { projectRequestId: r2.id } })) === 0 && (await snapshot(r2.id)).status === "APPROVED");
    const again = await setup(r2.id, { departmentId: deptA.id });
    check("...re-submitting setup is idempotent: returns the existing Project (still in B), no second Project", again.status === 200 && again.json.alreadyExisted === true && again.json.id === s2.json.id && (await prisma.project.count({ where: { projectRequestId: r2.id } })) === 1);

    const r3 = await mkRequest("forbidden-dest");
    const s3 = await setup(r3.id, { departmentId: deptC.id });
    check("departmentId = C (no project.create there) → 403 forbidden_destination, nothing created", s3.status === 403 && (await prisma.project.count({ where: { projectRequestId: r3.id } })) === 0, JSON.stringify(s3));
    const s3b = await setup(r3.id, { departmentId: "does-not-exist" });
    check("Unknown departmentId → 403 forbidden_destination", s3b.status === 403);

    as(createOnly);
    const s4 = await setup(r3.id, { departmentId: deptB.id });
    check("Source authority unchanged: project.create in B without projectRequest.approve in A → 403", s4.status === 403 && (await prisma.project.count({ where: { projectRequestId: r3.id } })) === 0);

    as(setupUser);
    const s5 = await setup(r3.id, { departmentId: deptB.id, memberIds: [memberA.id] });
    check("Members are validated against the DESTINATION: a member assignable only in A is rejected for B (400 invalid_member)", s5.status === 400 && (await prisma.project.count({ where: { projectRequestId: r3.id } })) === 0, JSON.stringify(s5.json));
    const s6 = await setup(r3.id, { departmentId: deptB.id, subDepartmentId: subA.id });
    check("Sub-department must belong to the DESTINATION: A's sub-department rejected for B (400 invalid_sub_department)", s6.status === 400);
    const s7 = await setup(r3.id, { departmentId: deptB.id, memberIds: [memberB.id] });
    const p7 = s7.json.id ? await prisma.project.findUniqueOrThrow({ where: { id: s7.json.id }, include: { members: { select: { id: true } } } }) : null;
    check("...a member assignable in B is accepted; Project in B with that member", s7.status === 201 && p7?.departmentId === deptB.id && p7?.members.some((m) => m.id === memberB.id));

    as(admin, Role.ADMIN);
    const r8 = await mkRequest("admin");
    const s8 = await setup(r8.id, { departmentId: deptC.id });
    const p8 = s8.json.id ? await prisma.project.findUniqueOrThrow({ where: { id: s8.json.id } }) : null;
    check("ADMIN may choose any active Workspace (C)", s8.status === 201 && p8?.departmentId === deptC.id);

    console.log("\n=== Setup page Workspace options ===\n");
    as(setupUser);
    const r9 = await mkRequest("page");
    const el = await NewProjectPage({ searchParams: Promise.resolve({ projectRequestId: r9.id }) } as any);
    const formProps = findAll(el, (n) => n.props?.mode === "fromRequest")[0]?.props;
    const optionIds = (formProps?.departments ?? []).map((d: { id: string }) => d.id);
    check("Setup form defaults to the request's Workspace and offers exactly request's + project.create Workspaces (A, B — not C)", formProps?.fixedDepartmentId === deptA.id && optionIds[0] === deptA.id && optionIds.includes(deptB.id) && !optionIds.includes(deptC.id), JSON.stringify(optionIds));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { OR: [{ id: { in: ids.projects } }, { projectRequestId: { in: ids.requests } }] } })],
      ["reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["sub depts", () => prisma.subDepartment.deleteMany({ where: { id: { in: ids.subDepts } } })],
      ["expense", () => prisma.projectExpenseType.deleteMany({ where: { id: { in: ids.expense } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roles } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
