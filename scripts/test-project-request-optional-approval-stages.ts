/**
 * Regression coverage for optional approval stages on Project Requests
 * (supersedes the retired projectRequest.skipIntermediateApproval tests):
 *
 *  - Intermediate Approval opt-out available to EVERY requester (no
 *    permission), with no SQLGeneral lookup; the normal manager flow and the
 *    verified "no manager" behaviour unchanged when not opted out; the retired
 *    permission no longer enforced (and no longer bypasses anything).
 *  - projectRequest.skipFinalApproval: registration (module, description, no
 *    default grants), Global vs Department scope, never implied by ADMIN,
 *    server-side rejection of unauthorized attempts, per-department
 *    revalidation.
 *  - The canonical stage machine: all four combinations, skipped stages never
 *    fabricated as approvals, notifications only for required stages,
 *    pending queues, rejection, duplicate/out-of-order decisions, Project
 *    setup eligibility (never automatic).
 *  - Display props ("Skipped") and historical compatibility.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-optional-approval-stages.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (Array.isArray(node)) { for (const c of node) findElementsByType(c, type, results); return results; }
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (children !== undefined) findElementsByType(children, type, results);
  return results;
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

const RUN_ID = Date.now();

async function main() {
  const { prisma } = await import("@/lib/prisma");
  await prisma.$connect();

  const sqlRows = new Map<string, any>();
  let sqlCalls = 0;
  const realSql = await import("@/lib/sqlgeneral-api-client");
  mock.module("@/lib/sqlgeneral-api-client", {
    namedExports: {
      ...realSql,
      findSqlGeneralUserByUsername: async (u: string) => {
        sqlCalls++;
        const row = sqlRows.get(u);
        return row ? { outcome: "unique" as const, user: row } : { outcome: "not_found" as const };
      },
    },
  });
  const register = (username: string, manager: string | null) =>
    sqlRows.set(username, { username, mail: null, hrDepartmentId: null, department: null, companyId: null, company: null, active: true, managerAMAccountName: manager, manager2AMAccountName: null, manager3AMAccountName: null });

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediatePOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const { default: NewProjectRequestPage } = await import("@/app/(main)/project-requests/new/page");
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { ProjectRequestForm } = await import("@/components/project-requests/project-request-form");
  const { ApprovalActions } = await import("@/components/project-requests/approval-actions");
  const { SkippedIntermediateStage } = await import("@/components/project-requests/skipped-stage");
  const { nextProjectRequestStatus, buildAwaitingMyApprovalWhere, resolveApprovalScope } = await import("@/lib/services/project-request-service");
  const { SKIP_FINAL_APPROVAL_PERMISSION_KEY } = await import("@/lib/services/project-request-approver-eligibility-service");

  const ids = { depts: [] as string[], users: [] as string[], requests: [] as string[], roles: [] as string[], roleKeys: [] as string[], expenseTypes: [] as string[], projects: [] as string[] };
  const jsonReq = (body?: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const as = (u: { id: string }, role: any = Role.USER, customRoleId: string | null = null) => { currentSession = { user: { id: u.id, role, customRoleId } }; };
  const makeUser = async (tag: string, opts: { role?: any; customRoleId?: string | null } = {}) => {
    const u = await prisma.user.create({ data: { email: `pr-opt-${tag}-${RUN_ID}@kinsen.gr`, role: opts.role ?? Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId: opts.customRoleId ?? null } });
    ids.users.push(u.id);
    return u;
  };
  const member = (userId: string, departmentId: string, customRoleId: string | null = null, isPrimary = true) =>
    prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary, isActive: true } });
  const role = async (tag: string, scope: "GLOBAL" | "DEPARTMENT", keys: string[]) => {
    const r = await prisma.customRole.create({ data: { key: `PR_OPT_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    ids.roles.push(r.id); ids.roleKeys.push(r.key);
    for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    return r;
  };
  const capture = (userId: string, username: string) => prisma.sqlGeneralUserSyncAttempt.create({ data: { userId, sqlGeneralUsername: username, status: "SUCCEEDED" } });
  const base = { description: "A description that is definitely long enough.", importance: 2, replacesExisting: false, intermediateApproverIds: [] as string[] };
  const submit = async (title: string, extra: Record<string, unknown>) => {
    const res = await requestsPOST(jsonReq({ ...base, title: `${title} ${RUN_ID}`, ...extra }));
    const body = await res.json();
    if (body.id) ids.requests.push(body.id);
    return { status: res.status, body, row: body.id ? await prisma.projectRequest.findUniqueOrThrow({ where: { id: body.id } }) : null };
  };
  const notes = (userId: string, requestId: string) => prisma.notification.count({ where: { userId, link: `/project-requests/${requestId}` } });

  // Snapshot of every pre-existing request — must be untouched by all of this.
  const preexisting = await prisma.projectRequest.findMany({ select: { id: true, status: true, intermediateApprovalSkipReason: true, finalApprovalSkipped: true, approverId: true, approvedAt: true, rejectedAt: true, requesterId: true, updatedAt: true }, orderBy: { id: "asc" } });

  try {
    console.log("\n=== 1. Permission registry ===\n");
    const skipFinal = await prisma.permission.findUnique({ where: { key: SKIP_FINAL_APPROVAL_PERMISSION_KEY } });
    check("projectRequest.skipFinalApproval exists, module projectRequests (Project Requests category)", skipFinal?.module === "projectRequests");
    check("...description starts with the display name 'Skip Final Approval' and states the purpose", !!skipFinal?.description?.startsWith("Skip Final Approval — Allows users to bypass the final approval stage when creating a Project Request."));
    check("...NOT granted to any existing role", (await prisma.rolePermission.count({ where: { permission: { key: SKIP_FINAL_APPROVAL_PERMISSION_KEY } } })) === 0);
    const retired = await prisma.permission.findUnique({ where: { key: "projectRequest.skipIntermediateApproval" } });
    check("Retired projectRequest.skipIntermediateApproval row kept (non-destructive), described as retired", !!retired && retired.description!.startsWith("Retired"));
    check("Canonical stage machine table", nextProjectRequestStatus("submitted", { intermediateRequired: true, finalRequired: true }) === "PENDING_INTERMEDIATE_APPROVAL" && nextProjectRequestStatus("submitted", { intermediateRequired: false, finalRequired: true }) === "PENDING_APPROVAL" && nextProjectRequestStatus("submitted", { intermediateRequired: true, finalRequired: false }) === "PENDING_INTERMEDIATE_APPROVAL" && nextProjectRequestStatus("submitted", { intermediateRequired: false, finalRequired: false }) === "APPROVED" && nextProjectRequestStatus("intermediate_completed", { intermediateRequired: true, finalRequired: true }) === "PENDING_APPROVAL" && nextProjectRequestStatus("intermediate_completed", { intermediateRequired: true, finalRequired: false }) === "APPROVED");

    // ── Fixtures ──
    const deptA = await createDepartment({ name: `PR Opt A ${RUN_ID}`, slug: `pr-opt-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PR Opt B ${RUN_ID}`, slug: `pr-opt-b-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id);
    const approverRole = await role("FINAL", "DEPARTMENT", ["projectRequest.approve"]);
    const finalA = await makeUser("finalA"); await member(finalA.id, deptA.id, approverRole.id);
    const finalB = await makeUser("finalB"); await member(finalB.id, deptB.id, approverRole.id);
    const manager = await makeUser("manager");
    register(`opt-mgr-${RUN_ID}`, null); await capture(manager.id, `opt-mgr-${RUN_ID}`);
    const withManager = async (tag: string, customRoleId: string | null = null, extraDept?: string, deptRoleA: string | null = null) => {
      const u = await makeUser(tag, { customRoleId });
      await member(u.id, deptA.id, deptRoleA);
      if (extraDept) await member(u.id, extraDept, null, false);
      register(`opt-${tag}-${RUN_ID}`, `opt-mgr-${RUN_ID}`); await capture(u.id, `opt-${tag}-${RUN_ID}`);
      return u;
    };
    const et = await prisma.projectExpenseType.create({ data: { name: `PR Opt ET ${RUN_ID}` } }); ids.expenseTypes.push(et.id);

    console.log("\n=== 2. Skip Intermediate Approval — every requester, no permission ===\n");
    const plain = await withManager("plain");
    as(plain);
    let calls = sqlCalls;
    const optOut = await submit("Opt-out", { departmentId: deptA.id, skipIntermediateApproval: true });
    check("Plain requester (no special permission) opting out -> 201", optOut.status === 201, JSON.stringify(optOut.body));
    check("...ZERO SQLGeneral lookups", sqlCalls === calls);
    check("...status PENDING_APPROVAL, reason REQUESTER_OPTED_OUT, no intermediate rows", optOut.row?.status === "PENDING_APPROVAL" && optOut.row?.intermediateApprovalSkipReason === "REQUESTER_OPTED_OUT" && (await prisma.projectRequestIntermediateApprover.count({ where: { projectRequestId: optOut.body.id } })) === 0);
    check("...final approver of the department notified; manager NOT notified", (await notes(finalA.id, optOut.body.id)) === 1 && (await notes(manager.id, optOut.body.id)) === 0);
    const noOpt = await submit("No opt-out empty", { departmentId: deptA.id });
    check("Without opting out, a verified manager still must be selected -> 400 (default unchanged)", noOpt.status === 400);
    const normal = await submit("Normal", { departmentId: deptA.id, intermediateApproverIds: [manager.id] });
    check("...selecting the manager -> PENDING_INTERMEDIATE_APPROVAL, no skip recorded, manager notified", normal.row?.status === "PENDING_INTERMEDIATE_APPROVAL" && normal.row?.intermediateApprovalSkipReason === null && (await notes(manager.id, normal.body.id)) === 1);
    const unresolved = await makeUser("unresolved"); await member(unresolved.id, deptA.id); // no SQLGeneral identity at all
    as(unresolved);
    check("Unresolved SQLGeneral identity WITHOUT opt-out -> 400 (unchanged)", (await submit("Unresolved", { departmentId: deptA.id })).status === 400);
    check("...WITH opt-out -> 201 (no SQLGeneral needed)", (await submit("Unresolved opt-out", { departmentId: deptA.id, skipIntermediateApproval: true })).status === 201);
    const noManager = await makeUser("nomgr"); await member(noManager.id, deptA.id);
    register(`opt-nomgr-${RUN_ID}`, null); await capture(noManager.id, `opt-nomgr-${RUN_ID}`);
    as(noManager);
    const nm = await submit("No manager", { departmentId: deptA.id });
    check("Verified no-manager requester (no opt-out) -> PENDING_APPROVAL, NO_MANAGER (unchanged)", nm.row?.status === "PENDING_APPROVAL" && nm.row?.intermediateApprovalSkipReason === "NO_MANAGER");
    const legacySkipRole = await role("LEGACY_SKIP", "GLOBAL", ["projectRequest.skipIntermediateApproval"]);
    const legacyHolder = await withManager("legacyholder", legacySkipRole.id);
    as(legacyHolder, Role.USER, legacySkipRole.id);
    check("Retired permission is no longer enforced: a holder WITHOUT opt-out goes through the normal flow (empty selection -> 400)", (await submit("Legacy holder", { departmentId: deptA.id })).status === 400);

    console.log("\n=== 3. Skip Final Approval — permission, scope, server enforcement ===\n");
    as(plain);
    const before = await prisma.projectRequest.count();
    const forged = await submit("Forged skip final", { departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true });
    check("No permission: skipFinalApproval -> 403 skip_final_approval_not_allowed, nothing created", forged.status === 403 && forged.body.code === "skip_final_approval_not_allowed" && (await prisma.projectRequest.count()) === before);
    const admin = await makeUser("admin", { role: Role.ADMIN }); await member(admin.id, deptA.id);
    as(admin, Role.ADMIN);
    check("ADMIN role WITHOUT an explicit grant cannot skip Final Approval (never implied) -> 403", (await submit("Admin skip final", { departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true })).status === 403);
    const globalSkipFinal = await role("GLOBAL_SKIPFINAL", "GLOBAL", [SKIP_FINAL_APPROVAL_PERMISSION_KEY]);
    const globalUser = await withManager("globalfinal", globalSkipFinal.id, deptB.id);
    as(globalUser, Role.USER, globalSkipFinal.id);
    check("GLOBAL grant: allowed in department A", (await submit("Global A", { departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true })).status === 201);
    check("GLOBAL grant: allowed in department B", (await submit("Global B", { departmentId: deptB.id, skipIntermediateApproval: true, skipFinalApproval: true })).status === 201);
    const deptSkipFinal = await role("DEPT_SKIPFINAL", "DEPARTMENT", [SKIP_FINAL_APPROVAL_PERMISSION_KEY]);
    const deptUser = await withManager("deptfinal", null, deptB.id, deptSkipFinal.id);
    as(deptUser);
    check("DEPARTMENT grant (A only): allowed in A", (await submit("Dept A", { departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true })).status === 201);
    check("DEPARTMENT grant (A only): re-validated for the target department — B -> 403", (await submit("Dept B", { departmentId: deptB.id, skipIntermediateApproval: true, skipFinalApproval: true })).status === 403);
    const pageEl = await NewProjectRequestPage();
    const formEl = findElementsByType(pageEl, ProjectRequestForm)[0];
    check("New request page passes skipFinalDepartmentIds = [A] for the department-scoped user (checkbox shown only for A)", JSON.stringify(formEl?.props.skipFinalDepartmentIds) === JSON.stringify([deptA.id]), JSON.stringify(formEl?.props.skipFinalDepartmentIds));
    as(unresolved);
    const unresolvedForm = findElementsByType(await NewProjectRequestPage(), ProjectRequestForm)[0];
    check("Unresolved requester now gets the FORM (not a blocking page), managerStatus 'unresolved', no skip-final", unresolvedForm?.props.managerStatus === "unresolved" && unresolvedForm?.props.skipFinalDepartmentIds.length === 0);

    console.log("\n=== 4. The four workflow combinations ===\n");
    as(deptUser);
    // (a) Enabled / Enabled
    const ee = await submit("EE", { departmentId: deptA.id, intermediateApproverIds: [manager.id] });
    as(manager);
    await intermediatePOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: ee.body.id }) });
    check("(a) Intermediate -> Final: after intermediate approval status PENDING_APPROVAL, final approvers notified", (await prisma.projectRequest.findUniqueOrThrow({ where: { id: ee.body.id } })).status === "PENDING_APPROVAL" && (await notes(finalA.id, ee.body.id)) === 1);
    as(finalA);
    await approvalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: ee.body.id }) });
    const eeRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: ee.body.id } });
    check("(a) ...-> APPROVED with the real final approver + time", eeRow.status === "APPROVED" && eeRow.approverId === finalA.id && !!eeRow.approvedAt && !eeRow.finalApprovalSkipped);

    // (b) Skipped / Enabled
    as(deptUser);
    const se = await submit("SE", { departmentId: deptA.id, skipIntermediateApproval: true });
    as(finalA);
    await approvalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: se.body.id }) });
    const seRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: se.body.id } });
    check("(b) Final -> Approved: PENDING_APPROVAL then APPROVED by the final approver; intermediate recorded as skipped", se.row?.status === "PENDING_APPROVAL" && seRow.status === "APPROVED" && seRow.approverId === finalA.id && seRow.intermediateApprovalSkipReason === "REQUESTER_OPTED_OUT");

    // (c) Enabled / Skipped
    as(deptUser);
    const es = await submit("ES", { departmentId: deptA.id, intermediateApproverIds: [manager.id], skipFinalApproval: true });
    check("(c) Submission: PENDING_INTERMEDIATE_APPROVAL, final skip persisted with requester identity + time", es.row?.status === "PENDING_INTERMEDIATE_APPROVAL" && es.row?.finalApprovalSkipped === true && es.row?.finalApprovalSkippedById === deptUser.id && !!es.row?.finalApprovalSkippedAt);
    const scope = await resolveApprovalScope(finalA.id, Role.USER, null);
    check("(c) Not in the final approver's 'Awaiting My Approval' queue", (await prisma.projectRequest.count({ where: { AND: [buildAwaitingMyApprovalWhere(finalA.id, scope), { id: es.body.id }] } })) === 0);
    as(finalA);
    const earlyFinal = await approvalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es.body.id }) });
    check("(c) Out-of-order final decision before intermediate -> 409", earlyFinal.status === 409);
    as(manager);
    const im = await intermediatePOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es.body.id }) });
    const esRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: es.body.id } });
    check("(c) Intermediate -> Approved: APPROVED directly after the intermediate approval", im.status === 200 && esRow.status === "APPROVED");
    check("(c) ...NO final decision fabricated (approverId/approvedAt null)", esRow.approverId === null && esRow.approvedAt === null);
    check("(c) ...final approvers get only the 'ready for Project Creation' notification (no 'awaiting approval'); requester notified of approval", (await notes(finalA.id, es.body.id)) === 1 && (await prisma.notification.count({ where: { userId: finalA.id, link: `/project-requests/${es.body.id}`, title: "Project Request approved — ready for Project Creation" } })) === 1 && (await prisma.notification.count({ where: { userId: deptUser.id, link: `/project-requests/${es.body.id}`, title: "Project Request approved" } })) === 1);
    check("(c) ...Project-setup reminder scheduled", (await prisma.projectRequestSetupReminder.count({ where: { projectRequestId: es.body.id } })) === 1);
    const dupIm = await intermediatePOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es.body.id }) });
    check("(c) Duplicate intermediate decision -> 409", dupIm.status === 409);
    as(finalA);
    const lateFinal = await approvalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: es.body.id }) });
    check("(c) A final decision on it is still refused -> 409 (never recorded)", lateFinal.status === 409 && (await prisma.projectRequest.findUniqueOrThrow({ where: { id: es.body.id } })).approverId === null);

    // (d) Skipped / Skipped
    as(deptUser);
    const ss = await submit("SS", { departmentId: deptA.id, skipIntermediateApproval: true, skipFinalApproval: true });
    check("(d) Immediately APPROVED at submission, no approver/approval time fabricated", ss.row?.status === "APPROVED" && ss.row?.approverId === null && ss.row?.approvedAt === null && ss.row?.intermediateApprovalSkipReason === "REQUESTER_OPTED_OUT" && ss.row?.finalApprovalSkipped === true);
    check("(d) ...only 'ready for Project Creation' notifications (no 'awaiting approval'); setup reminder scheduled", (await prisma.notification.count({ where: { link: `/project-requests/${ss.body.id}` } })) === (await prisma.notification.count({ where: { link: `/project-requests/${ss.body.id}`, title: "Project Request approved — ready for Project Creation" } })) && (await notes(finalA.id, ss.body.id)) === 1 && (await prisma.projectRequestSetupReminder.count({ where: { projectRequestId: ss.body.id } })) === 1);
    check("(d) ...NO Project created automatically", (await prisma.project.count({ where: { projectRequestId: ss.body.id } })) === 0);
    as(deptUser);
    const reqSetup = await setupPOST(jsonReq({ title: `SS project ${RUN_ID}`, ownerIds: [deptUser.id], expectedStartDate: "2026-10-05", expectedFinishDate: "2026-10-09", expenseTypeId: et.id }), { params: Promise.resolve({ id: ss.body.id }) });
    check("(d) Requester WITHOUT projectRequest.approve still cannot create the Project (existing permission preserved) -> 403", reqSetup.status === 403);
    as(finalA);
    const okSetup = await setupPOST(jsonReq({ title: `SS project ${RUN_ID}`, ownerIds: [deptUser.id], expectedStartDate: "2026-10-05", expectedFinishDate: "2026-10-09", expenseTypeId: et.id }), { params: Promise.resolve({ id: ss.body.id }) });
    const okSetupBody = await okSetup.json();
    if (okSetupBody.id) ids.projects.push(okSetupBody.id);
    check("(d) A user with projectRequest.approve can create the Project once the configured workflow completed -> 201", okSetup.status === 201);

    // Rejection still works on every enabled stage
    as(deptUser);
    const rej = await submit("Reject", { departmentId: deptA.id, intermediateApproverIds: [manager.id], skipFinalApproval: true });
    as(manager);
    await intermediatePOST(jsonReq({ decision: "reject" }), { params: Promise.resolve({ id: rej.body.id }) });
    const rejRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: rej.body.id } });
    check("Rejection at the (enabled) intermediate stage with final skipped -> REJECTED, no approver fabricated", rejRow.status === "REJECTED" && rejRow.approverId === null);

    console.log("\n=== 5. Display — skipped stages shown as Skipped ===\n");
    as(finalA);
    const ssPage = await ProjectRequestDetailPage({ params: Promise.resolve({ id: ss.body.id }) } as any);
    const skippedIntermediate = findElementsByType(ssPage, SkippedIntermediateStage);
    const ssActions = findElementsByType(ssPage, ApprovalActions)[0];
    check("(d) detail page renders the Intermediate stage as Skipped (reason REQUESTER_OPTED_OUT)", skippedIntermediate.length === 1 && skippedIntermediate[0].props.reason === "REQUESTER_OPTED_OUT");
    check("(d) Final Approval panel receives finalApprovalSkipped + who/when (rendered as Skipped, not Approved)", ssActions?.props.finalApprovalSkipped === true && ssActions?.props.finalApprovalSkippedBy?.email === deptUser.email && !!ssActions?.props.finalApprovalSkippedAt);
    const esPage = await ProjectRequestDetailPage({ params: Promise.resolve({ id: es.body.id }) } as any);
    check("(c) detail page: Intermediate shows real approvals (not skipped), Final panel marked skipped", findElementsByType(esPage, SkippedIntermediateStage).length === 0 && findElementsByType(esPage, ApprovalActions)[0]?.props.finalApprovalSkipped === true);

    console.log("\n=== 6. Historical compatibility ===\n");
    const legacy = await prisma.projectRequest.create({ data: { title: `PR Opt Legacy ${RUN_ID}`, departmentId: deptA.id, requesterId: plain.id, status: "PENDING_APPROVAL", intermediateApprovalSkipReason: "PERMISSION_BYPASS" } });
    ids.requests.push(legacy.id);
    as(finalA);
    check("A historical PERMISSION_BYPASS request still goes through Final Approval normally", (await approvalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: legacy.id }) })).status === 200);
    const after = await prisma.projectRequest.findMany({ where: { id: { in: preexisting.map((r) => r.id) } }, select: { id: true, status: true, intermediateApprovalSkipReason: true, finalApprovalSkipped: true, approverId: true, approvedAt: true, rejectedAt: true, requesterId: true, updatedAt: true }, orderBy: { id: "asc" } });
    check(`All ${preexisting.length} pre-existing requests unchanged (status, skip fields, approvers, requesters, timestamps)`, JSON.stringify(after) === JSON.stringify(preexisting));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["projects", () => prisma.project.deleteMany({ where: { OR: [{ id: { in: ids.projects } }, { projectRequestId: { in: ids.requests } }] } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { OR: [{ link: { in: ids.requests.map((i) => `/project-requests/${i}`) } }, { userId: { in: ids.users } }] } })],
      ["reminders", () => prisma.projectRequestSetupReminder.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["intermediate rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: ids.requests } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["expense types", () => prisma.projectExpenseType.deleteMany({ where: { id: { in: ids.expenseTypes } } })],
      ["sync attempts", () => prisma.sqlGeneralUserSyncAttempt.deleteMany({ where: { userId: { in: ids.users } } })],
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
