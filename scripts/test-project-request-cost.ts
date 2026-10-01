/**
 * Regression coverage for the Project Request Type cost feature:
 * - ProjectRequestType.cost (Decimal(10,2), current/default cost)
 * - ProjectRequest.cost (Decimal(10,2), a SNAPSHOT taken server-side at
 *   submission time — frozen forever, never re-read live from the type)
 *
 * SECTION A drives the real admin Project Request Type CRUD routes
 * (create/update/validation) against a real database. SECTION B proves the
 * snapshot invariant end-to-end: create -> submit -> edit the type's cost ->
 * the existing request keeps its original cost, a NEW request gets the new
 * one. SECTION C proves the server never trusts a client-supplied cost on
 * submission. SECTION D confirms the existing approval workflow/permissions
 * are completely unaffected by this addition.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-cost.ts
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

/** Runs each cleanup step independently — one step throwing must never skip every step after it. */
async function runCleanup(steps: [string, () => Promise<unknown>][]) {
  for (const [label, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.warn(`Cleanup step failed (non-fatal): ${label}`, err instanceof Error ? err.message : err);
    }
  }
}

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
// NewProjectRequestPage -> getActiveWorkspace reads the active-department
// cookie via next/headers — unavailable outside a real request scope when
// calling the page function directly, same established mock this suite's
// sibling test (test-project-request-department-eligibility.ts) already uses.
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

function findElementsByProps(node: any, predicate: (props: any) => boolean, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.props && predicate(node.props)) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByProps(c, predicate, results);
  else if (children) findElementsByProps(children, predicate, results);
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
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { projectRequestTypeSchema, createProjectRequestSchema } = await import("@/lib/validations");
  const typesPOST = (await import("@/app/api/admin/project-request-types/route")).POST;
  const typePATCH = (await import("@/app/api/admin/project-request-types/[id]/route")).PATCH;
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const { default: NewProjectRequestPage } = await import("@/app/(main)/project-requests/new/page");
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { ProjectRequestForm } = await import("@/components/project-requests/project-request-form");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const jsonReq = (method: string, body?: unknown) =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return u;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
  }
  async function makeApproverRole(tag: string) {
    const r = await prisma.customRole.create({ data: { key: `PR_COST_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    return r;
  }

  try {
    const admin = await prisma.user.create({ data: { email: `pr-cost-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);

    // ══════════════════════ SECTION A — admin CRUD: create/update/validation ══════════════════════
    console.log("\n=== A. Creating a Project Request Type with cost €500 stores exactly 500.00 ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const createRes = await typesPOST(jsonReq("POST", { name: `Development ${RUN_ID}`, cost: 500 }));
    check("A. Create with cost 500 -> 201", createRes.status === 201);
    const devType = await createRes.json();
    typeIds.push(devType.id);
    check("A. The response's cost is exactly 500 (a plain number, Decimal->number conversion correct)", devType.cost === 500);
    const devTypeRow = await prisma.projectRequestType.findUniqueOrThrow({ where: { id: devType.id } });
    check("A. The DB row's cost is exactly 500.00 (Decimal, not Float)", devTypeRow.cost?.toNumber() === 500);

    console.log("\n=== H. Negative costs are rejected ===\n");
    const negativeRes = await typesPOST(jsonReq("POST", { name: `Negative Cost Type ${RUN_ID}`, cost: -5 }));
    check("H. A negative cost on create -> 422 (zod rejection)", negativeRes.status === 422);
    check("H. ...zod schema itself rejects a negative cost directly", !projectRequestTypeSchema.safeParse({ name: "Valid Name", cost: -0.01 }).success);
    check("H. ...and rejects a value with more than 2 decimal places", !projectRequestTypeSchema.safeParse({ name: "Valid Name", cost: 19.999 }).success);
    check("H. ...a missing cost on CREATE is rejected (required for new types)", !projectRequestTypeSchema.safeParse({ name: "Valid Name" }).success);
    check("H. ...but cost is OPTIONAL on PATCH (.partial()) — a name/isActive-only edit must still work", projectRequestTypeSchema.partial().safeParse({ name: "Valid Name" }).success);
    const noRowCreatedForNegative = await prisma.projectRequestType.count({ where: { name: `Negative Cost Type ${RUN_ID}` } });
    check("H. ...zero rows created from the rejected attempt", noRowCreatedForNegative === 0);

    console.log("\n=== B. Updating its cost from €500 to €600 works ===\n");
    const updateRes = await typePATCH(jsonReq("PATCH", { cost: 600 }), { params: Promise.resolve({ id: devType.id }) });
    check("B. PATCH cost 500 -> 600 succeeds -> 200", updateRes.status === 200);
    const updatedBody = await updateRes.json();
    check("B. The response reflects the new cost (600)", updatedBody.cost === 600);
    const devTypeAfterUpdate = await prisma.projectRequestType.findUniqueOrThrow({ where: { id: devType.id } });
    check("B. The DB row now stores exactly 600.00", devTypeAfterUpdate.cost?.toNumber() === 600);

    // ══════════════════════ Fixtures for submission/snapshot tests ══════════════════════
    const dept = await createDepartment({ name: `PR Cost Dept ${RUN_ID}`, slug: `pr-cost-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const requester = await makeUser(`pr-cost-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, dept.id);
    const approverRole = await makeApproverRole("APPROVER");
    const approverUser = await makeUser(`pr-cost-approver-${RUN_ID}@kinsen.gr`);
    await addMembership(approverUser.id, dept.id, approverRole.id);

    const basePayload = {
      title: `PR Cost Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 2,
      projectTypeId: devType.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
      // admin is Role.ADMIN, which holds projectRequest.intermediateApprove
      // by default (see prisma/seed.ts's NEW_PERMISSION_DEFAULT_GRANTS) — no
      // extra custom-role fixture needed just to clear this file's own
      // intermediate stage (this file is about the cost feature, not the
      // intermediate stage itself).
      intermediateApproverIds: [admin.id],
    };

    async function clearIntermediate(requestId: string) {
      const prior = currentSession;
      currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
      const res = await intermediateApprovalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Cleared for fixture setup." }), { params: Promise.resolve({ id: requestId }) });
      if (res.status !== 200) throw new Error(`Failed to clear intermediate approval for ${requestId}: ${res.status}`);
      currentSession = prior;
    }

    // ══════════════════════ C. New Project Request form displays the current cost ══════════════════════
    console.log("\n=== C. New Project Request form receives the real, current cost for the selected type ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const newPageEl = await NewProjectRequestPage();
    const [formEl] = findElementsByProps(newPageEl, (p) => Array.isArray(p.types) && "departments" in p);
    check("C. ProjectRequestForm is rendered with the real import (not a stray placeholder)", formEl?.type === ProjectRequestForm);
    const devTypeOption = formEl?.props.types.find((t: any) => t.id === devType.id);
    check("C. The form's `types` prop includes Development with its CURRENT cost (600) — no second network request needed, this is server-rendered prop data", devTypeOption?.cost === 600);

    // ══════════════════════ D/E/F. Submission snapshots cost; later type edits never retroactively change it ══════════════════════
    console.log("\n=== D. Creating a Project Request snapshots the current type cost (600 at this moment) ===\n");
    const submitARes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Cost Request A ${RUN_ID}` }));
    check("D. Submission A -> 201", submitARes.status === 201);
    const submittedA = await submitARes.json();
    requestIds.push(submittedA.id);
    await clearIntermediate(submittedA.id);
    const rowA = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submittedA.id } });
    check("D. Request A's snapshotted cost is exactly 600.00 (the type's cost AT SUBMISSION TIME)", rowA.cost?.toNumber() === 600);

    console.log("\n=== E/F. An admin changes Development's cost 600 -> 750: A keeps 600, a NEW request gets 750 ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const secondUpdateRes = await typePATCH(jsonReq("PATCH", { cost: 750 }), { params: Promise.resolve({ id: devType.id }) });
    check("(fixture) Type cost updated 600 -> 750 -> 200", secondUpdateRes.status === 200);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const rowAAfterTypeChange = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submittedA.id } });
    check("E. Request A's cost is STILL 600.00 — completely unaffected by the later type edit (never a live read)", rowAAfterTypeChange.cost?.toNumber() === 600);

    const submitBRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Cost Request B ${RUN_ID}` }));
    check("F. Submission B (after the change) -> 201", submitBRes.status === 201);
    const submittedB = await submitBRes.json();
    requestIds.push(submittedB.id);
    const rowB = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submittedB.id } });
    check("F. Request B's snapshotted cost is the NEW value, 750.00", rowB.cost?.toNumber() === 750);

    console.log("\n-- The detail page shows each request's OWN snapshot, never a live re-read of the type's current cost --\n");
    const detailAEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: submittedA.id }) });
    const [costFieldA] = findElementsByProps(detailAEl, (p) => p.label === "Cost");
    check("Request A's detail page shows €600.00 (its own frozen snapshot, not the type's current €750.00)", costFieldA?.props.value === "€600.00");
    const detailBEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: submittedB.id }) });
    const [costFieldB] = findElementsByProps(detailBEl, (p) => p.label === "Cost");
    check("Request B's detail page shows €750.00", costFieldB?.props.value === "€750.00");

    // ══════════════════════ G. A tampered client-provided cost cannot override the authoritative type cost ══════════════════════
    console.log("\n=== G. A malicious/tampered client-provided cost in the submit payload is silently discarded ===\n");
    const forgedParse = createProjectRequestSchema.safeParse({ ...basePayload, cost: 999999.99 });
    check(
      "G. createProjectRequestSchema strips a forged `cost` key entirely (zod's default strip-unknown-keys behavior) — it never reaches the parsed data at all",
      forgedParse.success && !("cost" in (forgedParse as any).data)
    );
    const tamperedRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR Cost Tampered ${RUN_ID}`, cost: 999999.99 }));
    check("G. Submission with a forged cost still succeeds -> 201 (the forged key is simply ignored, not an error)", tamperedRes.status === 201);
    const tampered = await tamperedRes.json();
    requestIds.push(tampered.id);
    const tamperedRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: tampered.id } });
    check("G. The persisted cost is the AUTHORITATIVE type cost (750.00), never the forged 999999.99 the client sent", tamperedRow.cost?.toNumber() === 750);

    // ══════════════════════ I. Existing approval permissions/workflow are completely unaffected ══════════════════════
    console.log("\n=== I. The approval workflow/permissions are unaffected by this addition ===\n");
    const noPermUser = await makeUser(`pr-cost-noperm-${RUN_ID}@kinsen.gr`);
    await addMembership(noPermUser.id, dept.id);
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: null } };
    const forbiddenDecisionRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: admin.id }), { params: Promise.resolve({ id: submittedA.id }) });
    check("I. A user with no projectRequest.approve still correctly gets 403 (unchanged authorization)", forbiddenDecisionRes.status === 403);

    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const decideRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Looks good, approving.", projectOwnerId: admin.id }), { params: Promise.resolve({ id: submittedA.id }) });
    check("I. The real approver can still decide normally -> 200 (approval workflow itself untouched)", decideRes.status === 200);
    const decidedRowA = await prisma.projectRequest.findUniqueOrThrow({ where: { id: submittedA.id } });
    check("I. ...status transitions to APPROVED as always", decidedRowA.status === "APPROVED");
    check("I. ...and the cost snapshot (600.00) is STILL untouched by the approval action itself", decidedRowA.cost?.toNumber() === 600);
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["projects (auto-created from these requests)", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } })],
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["role permissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticket categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticket statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ]);
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
