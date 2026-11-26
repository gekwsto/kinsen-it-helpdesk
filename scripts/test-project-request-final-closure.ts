/**
 * Focused coverage for three closure fixes:
 *  1. "Ready for Project Creation" notification to eligible approvers when a
 *     request reaches APPROVED with Final Approval skipped (both paths), once.
 *  2. Co-owners (canonical Project.owners) in My Projects, the Owner filter
 *     and options, the dashboard owner counter and the list scope — never
 *     broadening access to non-owners; primary-owner semantics preserved.
 *  3. Intermediate rejection display: the real rejecting user, never the
 *     "historical import" fallback.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-final-closure.ts
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
const READY_TITLE = "Project Request approved — ready for Project Creation";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const sqlRows = new Map<string, any>();
  const realSql = await import("@/lib/sqlgeneral-api-client");
  mock.module("@/lib/sqlgeneral-api-client", { namedExports: { ...realSql, findSqlGeneralUserByUsername: async (u: string) => (sqlRows.get(u) ? { outcome: "unique" as const, user: sqlRows.get(u) } : { outcome: "not_found" as const }) } });
  const register = (username: string, manager: string | null) => sqlRows.set(username, { username, mail: null, hrDepartmentId: null, department: null, companyId: null, company: null, active: true, managerAMAccountName: manager, manager2AMAccountName: null, manager3AMAccountName: null });

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediatePOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const { default: MyProjectsPage } = await import("@/app/(main)/my-projects/page");
  const { default: RequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { buildProjectListQuery, getProjectOwnerOptions } = await import("@/lib/services/project-query-service");
  const { buildProjectListWhere } = await import("@/lib/services/department-scope-service");
  const { getProjectsDashboardData } = await import("@/lib/services/projects-dashboard-service");
  const { SKIP_FINAL_APPROVAL_PERMISSION_KEY } = await import("@/lib/services/project-request-approver-eligibility-service");

  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], requests: [] as string[], projects: [] as string[] };
  const jsonReq = (b: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const as = (u: { id: string }, role: any = Role.USER, customRoleId: string | null = null) => { currentSession = { user: { id: u.id, role, customRoleId } }; };
  const user = async (tag: string, customRoleId: string | null = null) => { const u = await prisma.user.create({ data: { email: `closure-${tag}-${RUN_ID}@kinsen.gr`, name: `Closure ${tag}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } }); ids.users.push(u.id); return u; };
  const role = async (tag: string, scope: "GLOBAL" | "DEPARTMENT", keys: string[]) => {
    const r = await prisma.customRole.create({ data: { key: `CLOSURE_${tag}_${RUN_ID}`, name: `Closure ${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    ids.roles.push(r.id); ids.roleKeys.push(r.key);
    for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    return r;
  };
  const member = (userId: string, departmentId: string, customRoleId: string | null = null) => prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
  const ready = (userId: string, requestId: string) => prisma.notification.count({ where: { userId, link: `/project-requests/${requestId}`, title: READY_TITLE } });
  const awaiting = (userId: string, requestId: string) => prisma.notification.count({ where: { userId, link: `/project-requests/${requestId}`, title: "New Project Request awaiting your approval" } });

  try {
    const deptA = await createDepartment({ name: `Closure A ${RUN_ID}`, slug: `closure-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `Closure B ${RUN_ID}`, slug: `closure-b-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id);
    const approverRole = await role("FINAL", "DEPARTMENT", ["projectRequest.approve"]);
    const finalA = await user("finalA"); await member(finalA.id, deptA.id, approverRole.id);
    const finalB = await user("finalB"); await member(finalB.id, deptB.id, approverRole.id);
    const skipFinalRole = await role("SKIPFINAL", "DEPARTMENT", [SKIP_FINAL_APPROVAL_PERMISSION_KEY]);
    const requester = await user("requester"); await member(requester.id, deptA.id, skipFinalRole.id);
    const manager = await user("manager");
    register(`closure-mgr-${RUN_ID}`, null);
    register(`closure-req-${RUN_ID}`, `closure-mgr-${RUN_ID}`);
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: manager.id, sqlGeneralUsername: `closure-mgr-${RUN_ID}`, status: "SUCCEEDED" } });
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId: requester.id, sqlGeneralUsername: `closure-req-${RUN_ID}`, status: "SUCCEEDED" } });
    const submit = async (title: string, extra: Record<string, unknown>) => {
      as(requester);
      const res = await requestsPOST(jsonReq({ title: `${title} ${RUN_ID}`, description: "A description that is definitely long enough.", importance: 2, replacesExisting: false, intermediateApproverIds: [], departmentId: deptA.id, ...extra }));
      const body = await res.json();
      if (body.id) ids.requests.push(body.id);
      return body.id as string;
    };

    console.log("\n=== 1. Ready-for-Project-Creation notification ===\n");
    const both = await submit("Both skipped", { skipIntermediateApproval: true, skipFinalApproval: true });
    check("Both skipped at submission: eligible approver of the department gets exactly ONE 'ready for Project Creation' notification with the deep link", (await ready(finalA.id, both)) === 1);
    check("...not an 'awaiting your approval' notification", (await awaiting(finalA.id, both)) === 0);
    check("...approver of ANOTHER department not notified", (await ready(finalB.id, both)) === 0);
    const note = await prisma.notification.findFirst({ where: { userId: finalA.id, link: `/project-requests/${both}` } });
    check("...message says approved and ready for Project Creation (not awaiting approval)", !!note && /is approved/.test(note.body) && /create its Project/.test(note.body) && !/needs your approval/.test(note.body));
    check("...delayed setup reminder still scheduled; no Project created", (await prisma.projectRequestSetupReminder.count({ where: { projectRequestId: both } })) === 1 && (await prisma.project.count({ where: { projectRequestId: both } })) === 0);

    const es = await submit("Intermediate then skipped final", { intermediateApproverIds: [manager.id], skipFinalApproval: true });
    check("Final skipped, intermediate pending: no notification to approvers yet", (await ready(finalA.id, es)) === 0 && (await awaiting(finalA.id, es)) === 0);
    as(manager);
    await intermediatePOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es }) });
    check("After the last intermediate approval (-> APPROVED): approver gets exactly ONE 'ready' notification, no 'awaiting' one", (await ready(finalA.id, es)) === 1 && (await awaiting(finalA.id, es)) === 0);
    const dup = await intermediatePOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es }) });
    check("A repeated decision is refused and creates NO duplicate notification", dup.status === 409 && (await ready(finalA.id, es)) === 1);
    check("...setup reminder scheduled once", (await prisma.projectRequestSetupReminder.count({ where: { projectRequestId: es } })) === 1);
    const normal = await submit("Normal", { skipIntermediateApproval: true });
    check("Regular submission (Final not skipped) still sends 'awaiting your approval', never 'ready'", (await awaiting(finalA.id, normal)) === 1 && (await ready(finalA.id, normal)) === 0);

    console.log("\n=== 2. Co-owners ===\n");
    // Every fixture user may open My Projects (project.view in department B)
    // but has NO access to department A, where the Projects live — so any
    // visibility of them comes from ownership alone.
    const noop = await role("NOOP", "GLOBAL", []);
    const viewRole = await role("VIEW", "DEPARTMENT", ["project.view", "activity.view"]);
    const primary = await user("primary", noop.id); await member(primary.id, deptB.id, viewRole.id);
    const coOwner = await user("coowner", noop.id); await member(coOwner.id, deptB.id, viewRole.id);
    const outsider = await user("outsider", noop.id); await member(outsider.id, deptB.id, viewRole.id);
    const viewerA = await user("viewerA", noop.id); await member(viewerA.id, deptA.id, viewRole.id);
    const pr = await prisma.projectRequest.create({ data: { title: `Closure origin ${RUN_ID}`, departmentId: deptA.id, requesterId: requester.id, status: "APPROVED" } });
    ids.requests.push(pr.id);
    const ro = await prisma.project.create({ data: { title: `Closure co-owned ${RUN_ID}`, departmentId: deptA.id, ownerId: primary.id, owners: { connect: [{ id: primary.id }, { id: coOwner.id }] }, projectRequestId: pr.id } });
    const legacy = await prisma.project.create({ data: { title: `Closure legacy primary-only ${RUN_ID}`, departmentId: deptA.id, ownerId: primary.id } }); // owners relation empty
    const standaloneCo = await prisma.project.create({ data: { title: `Closure standalone ${RUN_ID}`, departmentId: deptA.id, ownerId: primary.id, owners: { connect: [{ id: primary.id }, { id: outsider.id }] } } });
    ids.projects.push(ro.id, legacy.id, standaloneCo.id);
    const myProjectIds = async (u: { id: string }, customRoleId: string | null) => {
      as(u, Role.USER, customRoleId);
      try {
        const el = await MyProjectsPage();
        return findAll(el, (n) => typeof n.props?.href === "string" && n.props.href.startsWith("/projects/") && !n.props.href.endsWith("/new")).map((n) => n.props.href.split("/projects/")[1]);
      } catch (e: any) { return [`redirect:${e?.digest ?? e?.message}`]; }
    };
    const coMine = await myProjectIds(coOwner, noop.id);
    check("My Projects: co-owner (non-primary) sees the co-owned Project", coMine.includes(ro.id), JSON.stringify(coMine));
    const primMine = await myProjectIds(primary, noop.id);
    check("My Projects: primary owner sees it, plus a legacy Project whose owners set lacks them (primary semantics preserved)", primMine.includes(ro.id) && primMine.includes(legacy.id));
    check("My Projects: a non-owner does not see it", !(await myProjectIds(outsider, noop.id)).includes(ro.id));
    const listFor = async (u: { id: string }, params: Record<string, string>) => {
      const q: any = await buildProjectListQuery(u.id, Role.USER, undefined, params as any);
      if (q.denied) return [];
      return (await prisma.project.findMany({ where: q.where, select: { id: true } })).map((p) => p.id);
    };
    as(coOwner, Role.USER, noop.id);
    const coScope = await buildProjectListWhere(coOwner.id, Role.USER, undefined);
    const coListed = "denied" in coScope ? [] : (await prisma.project.findMany({ where: coScope as any, select: { id: true } })).map((p) => p.id);
    check("Projects list scope: co-owner (no department access) sees the Request-origin Project they co-own (matches record-level access)", coListed.includes(ro.id));
    const outScope = await buildProjectListWhere(outsider.id, Role.USER, undefined);
    const outListed = "denied" in outScope ? [] : (await prisma.project.findMany({ where: outScope as any, select: { id: true } })).map((p) => p.id);
    check("...no broadening: a co-owner of a STANDALONE Project gains no list access (same as record-level), non-owners see neither", !outListed.includes(standaloneCo.id) && !outListed.includes(ro.id));
    as(viewerA, Role.USER, noop.id);
    const ownerFilter = await listFor({ id: viewerA.id }, { ownerId: coOwner.id });
    check("Owner filter matches co-owners (ownerId=co-owner returns the co-owned Project)", ownerFilter.includes(ro.id), JSON.stringify(ownerFilter));
    check("...and still matches primary owners incl. legacy primary-only Projects", (await listFor({ id: viewerA.id }, { ownerId: primary.id })).filter((i) => [ro.id, legacy.id].includes(i)).length === 2);
    const options = await getProjectOwnerOptions({ departmentId: deptA.id });
    check("Owner filter options include co-owners", options.some((o) => o.id === coOwner.id) && options.some((o) => o.id === primary.id));
    const dash = await getProjectsDashboardData(viewerA.id, Role.USER, deptA.id);
    const byOwner = "denied" in dash ? [] : dash.byOwner;
    check("Dashboard 'Projects by Owner': primary counted for all 3, co-owner counted for the co-owned one", byOwner.find((b) => b.name === primary.name)?.count === 3 && byOwner.find((b) => b.name === coOwner.name)?.count === 1, JSON.stringify(byOwner));

    console.log("\n=== 3. Intermediate rejection display ===\n");
    const rej = await submit("Rejected at intermediate", { intermediateApproverIds: [manager.id] });
    as(manager);
    await intermediatePOST(jsonReq({ decision: "reject", businessAssessment: "Not aligned." }), { params: Promise.resolve({ id: rej }) });
    as(finalA, Role.USER, approverRole.id);
    const page = await RequestDetailPage({ params: Promise.resolve({ id: rej }) } as any);
    const notReached = findAll(page, (n) => n.props?.["data-testid"] === "final-not-reached");
    const text = findAll(notReached[0], () => true).flatMap((n) => [].concat(n.props?.children ?? [])).filter((c: any) => typeof c === "string").join(" ");
    check("Detail page: Final Approval shows 'Not reached — rejected during Intermediate Approval by <real rejecting user>'", notReached.length === 1 && text.includes("Not reached") && text.includes(manager.name!), text.slice(0, 200));
    const strings = findAll(page, () => true).flatMap((n) => [].concat(n.props?.children ?? []).filter((c: any) => typeof c === "string"));
    check("...never the 'historical import' fallback or 'Awaiting approval'", !strings.some((t: string) => t.includes("historical import")) && !text.includes("Awaiting"));
    const tableSrc = await (await import("fs/promises")).readFile("components/project-requests/project-request-table.tsx", "utf8");
    check("List preview: intermediate rejection rendered from the persisted decision; 'historical import' fallback only for HISTORICAL_IMPORT", /intermediateRejection\(previewTarget\)/.test(tableSrc) && /previewTarget\.source === "HISTORICAL_IMPORT" \? "Not recorded \(historical import\)" : "Not recorded"/.test(tableSrc));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { OR: [{ id: { in: ids.projects } }, { projectRequestId: { in: ids.requests } }] } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { OR: [{ link: { in: ids.requests.map((i) => `/project-requests/${i}`) } }, { userId: { in: ids.users } }] } })],
      ["reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["intermediate rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["sync", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: ids.users } } })],
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
