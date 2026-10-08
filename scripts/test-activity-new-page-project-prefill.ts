/**
 * Regression coverage for the "Add Activity from a Project" navigation bug:
 * clicking "Add Activity" on a Project's detail page must land on
 * /activities/new with that Project already preselected — not an empty
 * Project selector requiring the user to pick the same Project again.
 *
 * Covers the full chain: the Project detail header's link,
 * app/(main)/activities/new/page.tsx's server-side resolve+validate of
 * ?projectId=, and the props it hands to ActivityNewForm. UI-level behavior
 * (the Select actually showing the Project, the request-origin block
 * appearing without reselection) is covered separately by
 * scripts/browser-verify-activity-project-prefill.ts — this script is the
 * server-authoritative backstop, inspecting the real Server Component's
 * returned element props directly (same technique
 * test-project-request-project-creation.ts already uses for NewProjectPage).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-activity-new-page-project-prefill.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
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
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
// NewActivityPage calls getActiveWorkspace(), which reads next/headers'
// cookies() — only real inside an actual Next.js request scope. Same mock
// test-project-request-project-creation.ts already uses for its own
// NewProjectPage calls.
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

const RUN_ID = Date.now();
const TAG = `anpp-${RUN_ID}`;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: NewActivityPage } = await import("@/app/(main)/activities/new/page");
  const { NextRequest } = await import("next/server");
  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });

  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const activitiesPOST = (await import("@/app/api/activities/route")).POST;

  const deptIds: string[] = [];
  const otherDeptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const userIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const otherDept = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    otherDeptIds.push(otherDept.id);
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const worker = await prisma.user.create({ data: { email: `${TAG}-worker@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(worker.id);
    // PROJECT_MANAGER grants BOTH activity.create and activity.assignable in
    // this department — same role choice as test-activity-request-origin.ts.
    await prisma.departmentMembership.create({
      data: { userId: worker.id, departmentId: dept.id, role: DepartmentRole.PROJECT_MANAGER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    // A user with NO membership in `dept` at all — used to prove an
    // unauthorized/forged projectId never leaks a preselection.
    const outsider = await prisma.user.create({ data: { email: `${TAG}-outsider@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(outsider.id);
    await prisma.departmentMembership.create({
      data: { userId: outsider.id, departmentId: otherDept.id, role: DepartmentRole.PROJECT_MANAGER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(manualProject.id);

    // ══════════════════════ Fixture: one real request-origin Project ══════════════════════
    currentSession = { user: { id: worker.id, role: Role.USER, customRoleId: null } };
    const submitRes = await requestsPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "Activity Project-prefill fixture — description long enough.",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "Engineering",
        expectedBenefits: "Benefits text long enough for validation.",
        replacesExisting: false,
        intermediateApproverIds: [admin.id],
      })
    );
    const submitted = await submitRes.json();
    requestIds.push(submitted.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
    await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
    const setupRes = await setupPOST(
      jsonReq({
        title: `${TAG} request`,
        description: "fixture",
        ownerIds: [admin.id],
        expectedStartDate: "2026-07-01",
        expectedFinishDate: "2026-07-10",
        expenseTypeId: expenseType.id,
      }),
      { params: Promise.resolve({ id: submitted.id }) }
    );
    if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
    const requestOriginProject = await setupRes.json();
    projectIds.push(requestOriginProject.id);

    // ══════════════════════ 1/2. Preselection props from a real Project ══════════════════════
    console.log("\n=== 1/2. NewActivityPage resolves ?projectId= into ActivityNewForm's preselectedProjectId ===\n");
    currentSession = { user: { id: worker.id, role: Role.USER, customRoleId: null } };

    const manualEl: any = await (NewActivityPage as any)({ searchParams: Promise.resolve({ projectId: manualProject.id }) });
    check("1. From a normal Project: NewActivityPage renders <ActivityNewForm> with preselectedProjectId = the Project's own id", manualEl.props.preselectedProjectId === manualProject.id);
    check("1. ...and departmentId resolved from the Project's OWN department (not just the active workspace)", manualEl.props.departmentId === dept.id);

    const roEl: any = await (NewActivityPage as any)({ searchParams: Promise.resolve({ projectId: requestOriginProject.id }) });
    check("2. From a request-origin Project: preselectedProjectId = that Project's id too", roEl.props.preselectedProjectId === requestOriginProject.id);
    check("2. ...departmentId resolved correctly for it as well", roEl.props.departmentId === dept.id);

    // ══════════════════════ 5. Direct /activities/new (no projectId) is unaffected ══════════════════════
    console.log("\n=== 5. Direct /activities/new (no projectId) starts with no preselection ===\n");
    const plainEl: any = await (NewActivityPage as any)({ searchParams: Promise.resolve({}) });
    check("5. No ?projectId= -> preselectedProjectId is null, not fabricated", plainEl.props.preselectedProjectId === null || plainEl.props.preselectedProjectId === undefined);

    // ══════════════════════ 7. A forged/unauthorized projectId never leaks a preselection ══════════════════════
    console.log("\n=== 7. Forged/unauthorized projectId does not bypass authorization ===\n");
    const nonexistentEl: any = await (NewActivityPage as any)({ searchParams: Promise.resolve({ projectId: "cmx-nonexistent-project-id" }) });
    check("7a. A nonexistent projectId -> silently falls back to no preselection (never an error/throw)", nonexistentEl.props.preselectedProjectId === null || nonexistentEl.props.preselectedProjectId === undefined);

    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const unauthorizedEl: any = await (NewActivityPage as any)({ searchParams: Promise.resolve({ projectId: manualProject.id }) });
    check("7b. A real Project the current user has NO project.view access to -> preselection is NOT applied", unauthorizedEl.props.preselectedProjectId === null || unauthorizedEl.props.preselectedProjectId === undefined);

    // ══════════════════════ 4/8. Submitting without changing the selection creates under the SAME Project; server still re-derives request-origin from the DB ══════════════════════
    console.log("\n=== 4/8. Submitting with the preselected Project creates under it; server re-derives request-origin from the DB, never the query param ===\n");
    currentSession = { user: { id: worker.id, role: Role.USER, customRoleId: null } };

    const manualSubmitRes = await activitiesPOST(jsonReq({ title: `${TAG} Manual via prefill`, projectId: manualProject.id, departmentId: dept.id, taskTypeId: reqType.id }));
    check("4. Submitting with the preselected MANUAL Project's id -> 201, created under that exact Project", manualSubmitRes.status === 201);
    const manualSubmitActivity = await manualSubmitRes.json();
    activityIds.push(manualSubmitActivity.id);
    check("...Activity.projectId matches the preselected Project exactly", manualSubmitActivity.projectId === manualProject.id);

    // A request-origin Project submitted WITHOUT the extended fields must
    // still be rejected — proving the server resolves "is this request-
    // origin" from the DB Project row itself, never from any query-param-
    // adjacent client hint carried over from the navigation step.
    const roMissingFieldsRes = await activitiesPOST(jsonReq({ title: `${TAG} RO via prefill missing`, projectId: requestOriginProject.id, departmentId: dept.id, taskTypeId: reqType.id }));
    check("8. The server still enforces request-origin requirements from DB provenance alone — rejected without the extended fields even though navigation supplied projectId", roMissingFieldsRes.status === 400);
    check("...with code request_origin_fields_required", (await roMissingFieldsRes.json()).code === "request_origin_fields_required");

    const taskType = await prisma.taskSubType.create({ data: { name: `${TAG}-tasktype`, cost: 42 } });
    const roSubmitRes = await activitiesPOST(
      jsonReq({
        title: `${TAG} RO via prefill`,
        projectId: requestOriginProject.id,
        departmentId: dept.id,
        expectedStartDate: "2026-08-01",
        expectedFinishDate: "2026-08-05",
        taskTypeId: reqType.id,
        taskSubTypeId: taskType.id,
        ownerId: worker.id,
        assignedUserIds: [worker.id],
      })
    );
    check("8. ...and succeeds once the real (server-validated) fields are supplied, creating under the preselected request-origin Project", roSubmitRes.status === 201);
    const roSubmitActivity = await roSubmitRes.json();
    activityIds.push(roSubmitActivity.id);
    await prisma.taskSubType.delete({ where: { id: taskType.id } }).catch(() => {});
    check("...Activity.projectId matches the preselected request-origin Project exactly", roSubmitActivity.projectId === requestOriginProject.id);

    // ══════════════════════ 6. Changing the Project after prefill still works correctly ══════════════════════
    console.log("\n=== 6. Changing Project after a prefill still resolves provenance for the NEWLY selected Project ===\n");
    const secondManualProject = await prisma.project.create({ data: { title: `${TAG} second manual project`, departmentId: dept.id, ownerId: admin.id } });
    projectIds.push(secondManualProject.id);
    // Simulates: page loaded with Project A preselected, user then picks
    // Project B in the Select before submitting — the POST reflects B, not
    // the original prefill target A.
    const changedProjectRes = await activitiesPOST(jsonReq({ title: `${TAG} Changed Project`, projectId: secondManualProject.id, departmentId: dept.id, taskTypeId: reqType.id }));
    check("6. Submitting after changing to a different Project uses that NEW Project, not the original prefill target", changedProjectRes.status === 201);
    const changedProjectActivity = await changedProjectRes.json();
    activityIds.push(changedProjectActivity.id);
    check("...Activity.projectId is the newly-selected Project, not the original preselection", changedProjectActivity.projectId === secondManualProject.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds.filter(Boolean) } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): activities", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds.filter(Boolean) } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): projects", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): project requests", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): users", err instanceof Error ? err.message : err);
    }
    try {
      for (const id of [...deptIds, ...otherDeptIds]) {
        await prisma.ticketCategory.deleteMany({ where: { departmentId: id } });
        await prisma.ticketPriority.deleteMany({ where: { departmentId: id } });
        await prisma.ticketStatus.deleteMany({ where: { departmentId: id } });
      }
      await prisma.department.deleteMany({ where: { id: { in: [...deptIds, ...otherDeptIds] } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): departments", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
