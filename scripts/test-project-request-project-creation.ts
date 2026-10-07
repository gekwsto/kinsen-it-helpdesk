/**
 * Regression coverage for the request-origin Project SETUP flow — the
 * NEW business flow, confirmed with the user:
 *
 *   FINAL approval (decideApproval) no longer auto-creates a Project at
 *   all. Instead, the acting approver is redirected to a dedicated setup
 *   page (/projects/new?projectRequestId=...), which collects the
 *   existing Project fields PLUS new request-origin-only metadata
 *   (Project Owner, Expected Start/Finish, Expense Type, Budget,
 *   Estimated Cost, Actual Cost, External) and submits to its OWN
 *   dedicated mutation, POST /api/project-requests/[id]/project
 *   (createProjectFromApprovedRequest in
 *   lib/services/project-request-service.ts) — a DIFFERENT authorization
 *   path from both the approval decision itself and from normal/manual
 *   Project creation (POST /api/projects).
 *
 * This file supersedes the OLD version of itself, which tested the
 * previous "approval auto-creates the Project inline" design — rewritten
 * deliberately, per this feature's own explicit instruction, rather than
 * left describing obsolete behavior.
 *
 * This file does NOT re-prove what sibling test files already cover
 * (the approval decision's own guarantees — see
 * test-project-request-workflow.ts/test-project-request-business-assessment.ts;
 * the intermediate stage — test-project-request-intermediate-approval.ts).
 * It focuses on THIS flow's own behavior: the narrow authorization
 * boundary (the exact recorded final approver, never generic
 * project.create, never a broader ADMIN bypass), idempotency/race safety,
 * field mapping/provenance (including that manual creation can't be
 * abused to forge it), new-field validation (including the server-only
 * Expected Total Initial Days calculation), Expense Type admin lifecycle,
 * and legacy-row safety.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-project-creation.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (established convention across this whole test suite). */
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
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers(),
  },
});

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — schema/source checks (no DOM, no DB) ══════════════════════
  console.log("\n=== SECTION A — schema shape, isolation from manual creation, client-side gates ===\n");
  const { createProjectFromRequestSchema, createProjectSchema, projectRequestApprovalDecisionSchema } = await import("@/lib/validations");

  check(
    "1. projectRequestApprovalDecisionSchema no longer accepts/requires projectOwnerId at all — Project setup moved to its own separate step",
    !("projectOwnerId" in (projectRequestApprovalDecisionSchema as any).shape)
  );

  check(
    "1/36. createProjectSchema (manual/normal creation) has NONE of the request-origin-only fields — malicious caller can't forge provenance into the generic create API by sending them",
    !("projectOwnerId" in createProjectSchema.shape) &&
      !("expectedStartDate" in createProjectSchema.shape) &&
      !("expectedFinishDate" in createProjectSchema.shape) &&
      !("expectedTotalInitialDays" in createProjectSchema.shape) &&
      !("expenseTypeId" in createProjectSchema.shape) &&
      !("budget" in createProjectSchema.shape) &&
      !("estimatedCost" in createProjectSchema.shape) &&
      !("actualCost" in createProjectSchema.shape) &&
      !("external" in createProjectSchema.shape)
  );

  const basePayload = {
    title: "A valid title",
    description: "A description.",
    ownerIds: ["cmx0000000000000000000001"],
    expectedStartDate: "2026-10-01",
    expectedFinishDate: "2026-10-05",
    expenseTypeId: "cmx0000000000000000000002",
  };
  check("22. Missing expectedStartDate -> rejected", !createProjectFromRequestSchema.safeParse({ ...basePayload, expectedStartDate: undefined }).success);
  check("23. Missing expectedFinishDate -> rejected", !createProjectFromRequestSchema.safeParse({ ...basePayload, expectedFinishDate: undefined }).success);
  check("24. Finish BEFORE Start -> rejected", !createProjectFromRequestSchema.safeParse({ ...basePayload, expectedStartDate: "2026-10-05", expectedFinishDate: "2026-10-01" }).success);
  check("...Finish EQUAL TO Start (0 days) -> accepted (0 is a valid duration)", createProjectFromRequestSchema.safeParse({ ...basePayload, expectedStartDate: "2026-10-01", expectedFinishDate: "2026-10-01" }).success);
  check("26. expectedTotalInitialDays is not even a field on this schema — a client-submitted value is simply never read", !("expectedTotalInitialDays" in createProjectFromRequestSchema.innerType().shape));
  check("27. Missing expenseTypeId -> rejected", !createProjectFromRequestSchema.safeParse({ ...basePayload, expenseTypeId: undefined }).success);
  check("28. Budget/Estimated Cost/Actual Cost are not even fields on this schema any more — Project Estimated/Actual Cost are now fully derived from Activities, never client-submitted at creation", !("budget" in createProjectFromRequestSchema.innerType().shape) && !("estimatedCost" in createProjectFromRequestSchema.innerType().shape) && !("actualCost" in createProjectFromRequestSchema.innerType().shape));
  check("29. A payload that still forges budget/estimatedCost/actualCost validates fine (unknown keys silently stripped, never an error)", createProjectFromRequestSchema.safeParse({ ...basePayload, budget: 1000, estimatedCost: 900, actualCost: 500 } as any).success);
  check("31. external is OPTIONAL and defaults to false when omitted", (createProjectFromRequestSchema.safeParse({ ...basePayload }) as any).data.external === false);
  check("31. ...and an explicit true is honored", (createProjectFromRequestSchema.safeParse({ ...basePayload, external: true }) as any).data.external === true);
  check("...departmentId is not even a field on this schema — always server-resolved from the request, never client input", !("departmentId" in createProjectFromRequestSchema.innerType().shape));

  // UI/editability pass — Project edit must accept exactly these 4
  // request-origin fields (and no more) — Budget was removed entirely and
  // Estimated/Actual Cost are now derived, never editable — with
  // expectedTotalInitialDays permanently excluded (the creation-time
  // baseline, immutable by PATCH).
  const { updateProjectRequestOriginFieldsSchema } = await import("@/lib/validations");
  const EDITABLE_REQUEST_ORIGIN_FIELDS = ["expectedStartDate", "expectedFinishDate", "expenseTypeId", "external"];
  check(
    "11. updateProjectRequestOriginFieldsSchema exposes exactly the 4 request-origin fields the edit page offers",
    EDITABLE_REQUEST_ORIGIN_FIELDS.every((f) => f in updateProjectRequestOriginFieldsSchema.shape) &&
      Object.keys(updateProjectRequestOriginFieldsSchema.shape).length === EDITABLE_REQUEST_ORIGIN_FIELDS.length
  );
  check(
    "...and budget/estimatedCost/actualCost are NOT among them — removed/derived, never editable via PATCH",
    !("budget" in updateProjectRequestOriginFieldsSchema.shape) &&
      !("estimatedCost" in updateProjectRequestOriginFieldsSchema.shape) &&
      !("actualCost" in updateProjectRequestOriginFieldsSchema.shape)
  );
  check("...expectedTotalInitialDays is NOT one of them — immutable baseline, never PATCH-able", !("expectedTotalInitialDays" in updateProjectRequestOriginFieldsSchema.shape));

  const formSrc = await fs.readFile("components/projects/project-form.tsx", "utf8");
  check("15. The request-origin-only fields block is rendered ONLY in fromRequest mode", /\{fromRequest && \(/.test(formSrc));
  check("...and POSTs to the dedicated route, never /api/projects, in that mode", /`\/api\/project-requests\/\$\{fromRequestId\}\/project`/.test(formSrc));
  check("UI pass: Expected Total Initial Days now renders as a real readOnly input (not a muted <p> aside)", /id="expected-total-initial-days"[\s\S]{0,200}readOnly/.test(formSrc));

  const editPageSrc = await fs.readFile("app/(main)/projects/[id]/edit/page.tsx", "utf8");
  check("12. The edit page also shows Expected Total Initial Days as a readOnly input", /id="expectedTotalInitialDays"[\s\S]{0,200}readOnly/.test(editPageSrc));
  check("...and never submits it in the PATCH body (no such key anywhere in the fetch payload)", !/expectedTotalInitialDays[,:]/.test(editPageSrc.split("handleSubmit")[1]?.split("};")[0] ?? ""));

  const detailPageSrc = await fs.readFile("app/(main)/projects/[id]/page.tsx", "utf8");
  check("6. Project Details and Project Request Setup are wired as peer cards in one responsive grid wrapper", /project\.projectRequest \? "grid gap-6 sm:grid-cols-2" : undefined/.test(detailPageSrc));
  check("8. The Edit control in the Project Request Setup card is gated on canEditProject (the same existing permission, no new one)", /\{canEditProject && \(/.test(detailPageSrc) && /aria-label="Edit Project Request Setup"/.test(detailPageSrc));
  check("10. It links to the existing Project edit route — no second edit page", /href=\{`\/projects\/\$\{project\.id\}\/edit`\}/.test(detailPageSrc));
  check("2. The Edit control is rendered inside the card's CardHeader (top, beside the title) — not a footer", /<CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2">[\s\S]{0,800}aria-label="Edit Project Request Setup"/.test(detailPageSrc));
  check("3. The old bottom CardFooter Edit block is gone — no CardFooter use left on this page at all", !/CardFooter/.test(detailPageSrc));

  const newPageSrc = await fs.readFile("app/(main)/projects/new/page.tsx", "utf8");
  check("11. The setup page re-resolves the request SERVER-SIDE (never trusts the query param as authorization)", /approverId !== session\.user\.id/.test(newPageSrc) && /status !== "APPROVED"/.test(newPageSrc));

  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping the real-DB portion.");
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
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const projectsPOST = (await import("@/app/api/projects/route")).POST;
  const projectsGET = (await import("@/app/api/projects/[id]/route")).GET;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const { default: NewProjectPage } = await import("@/app/(main)/projects/new/page");
  const expenseTypesAdminPOST = (await import("@/app/api/admin/project-expense-types/route")).POST;
  const expenseTypesAdminPATCH = (await import("@/app/api/admin/project-expense-types/[id]/route")).PATCH;
  const expenseTypesAdminDELETE = (await import("@/app/api/admin/project-expense-types/[id]/route")).DELETE;
  const expenseTypesAdminGET = (await import("@/app/api/admin/project-expense-types/route")).GET;
  const expenseTypesActiveGET = (await import("@/app/api/project-expense-types/route")).GET;

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const projectIds: string[] = [];
  const expenseTypeIds: string[] = [];

  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  async function makeUser(email: string, customRoleId: string | null = null, role: "USER" | "ADMIN" = "USER") {
    const u = await prisma.user.create({ data: { email, role: role as any, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }
  async function makeRole(tag: string, scope: "GLOBAL" | "DEPARTMENT", permissionKeys: string[]) {
    const role = await prisma.customRole.create({ data: { key: `PR_PC_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    }
    return role;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
  }

  try {
    const dept = await createDepartment({ name: `PR Creation Dept ${RUN_ID}`, slug: `pr-creation-dept-${RUN_ID}` });
    const otherDept = await createDepartment({ name: `PR Creation OtherDept ${RUN_ID}`, slug: `pr-creation-otherdept-${RUN_ID}` });
    deptIds.push(dept.id, otherDept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR Creation Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await makeUser(`pr-creation-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, dept.id);

    const intermediateRole = await makeRole("INTERMEDIATE", "GLOBAL", ["projectRequest.intermediateApprove"]);
    const intermediateApprover = await makeUser(`pr-creation-intermediate-${RUN_ID}@kinsen.gr`, intermediateRole.id);

    // Holds ONLY projectRequest.approve — deliberately NOT project.create,
    // NOT project.assignable. The core regression this feature must avoid:
    // this exact user must still be able to complete Project setup for the
    // ONE request they approve, without ever being granted (or needing)
    // generic Project-creation rights.
    const finalApproverRole = await makeRole("FINALAPPROVER", "DEPARTMENT", ["projectRequest.approve"]);
    const finalApprover = await makeUser(`pr-creation-finalapprover-${RUN_ID}@kinsen.gr`);
    await addMembership(finalApprover.id, dept.id, finalApproverRole.id);

    // A SECOND user who also holds projectRequest.approve in the SAME
    // department — eligible to decide OTHER requests, but never the
    // recorded approver of the ones finalApprover decides.
    const unrelatedApproverRole = await makeRole("UNRELATEDAPPROVER", "DEPARTMENT", ["projectRequest.approve"]);
    const unrelatedApprover = await makeUser(`pr-creation-unrelated-${RUN_ID}@kinsen.gr`);
    await addMembership(unrelatedApprover.id, dept.id, unrelatedApproverRole.id);

    const ownerRole = await makeRole("OWNER", "DEPARTMENT", ["project.assignable", "project.view"]);
    const ownerUser = await makeUser(`pr-creation-owner-${RUN_ID}@kinsen.gr`);
    await addMembership(ownerUser.id, dept.id, ownerRole.id);

    const otherDeptOwnerRole = await makeRole("OTHERDEPTOWNER", "DEPARTMENT", ["project.assignable"]);
    const otherDeptOwnerUser = await makeUser(`pr-creation-otherdeptowner-${RUN_ID}@kinsen.gr`);
    await addMembership(otherDeptOwnerUser.id, otherDept.id, otherDeptOwnerRole.id);

    const adminUser = await makeUser(`pr-creation-admin-${RUN_ID}@kinsen.gr`, null, "ADMIN");

    const basePRPayload = {
      title: `PR Creation Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 3,
      projectTypeId: type.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
      intermediateApproverIds: [intermediateApprover.id],
    };

    /** Submits, clears intermediate, and (optionally) runs the FINAL decision — returns the real DB row afterward. */
    async function submitThrough(title: string, finalDecision: "approve" | "reject" | null, decidingUser: { id: string }) {
      currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
      const res = await requestsPOST(jsonReq({ ...basePRPayload, title }));
      const body = await res.json();
      requestIds.push(body.id);
      currentSession = { user: { id: intermediateApprover.id, role: Role.USER, customRoleId: intermediateRole.id } };
      const clearRes = await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: body.id }) });
      if (clearRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${clearRes.status}`);
      if (finalDecision) {
        currentSession = { user: decidingUser, role: Role.USER, customRoleId: null } as any;
        currentSession = { user: { id: decidingUser.id, role: Role.USER, customRoleId: null } };
        const decideRes = await approvalPOST(jsonReq({ decision: finalDecision, businessAssessment: "Fixture decision." }), { params: Promise.resolve({ id: body.id }) });
        if (decideRes.status !== 200) throw new Error(`Fixture setup failed: final ${finalDecision} returned ${decideRes.status}`);
      }
      return prisma.projectRequest.findUniqueOrThrow({ where: { id: body.id } });
    }

    const validSetupPayload = () => ({
      title: `PR Creation Setup ${RUN_ID}`,
      description: "Setup description.",
      memberIds: [],
      isGoal: false,
      ownerIds: [ownerUser.id],
      audienceIds: [],
      expectedStartDate: "2026-10-01",
      expectedFinishDate: "2026-10-05",
      expenseTypeId: expenseTypeActiveId,
    });

    // ══════════════════════ Fixture: two Expense Types (active + inactive) ══════════════════════
    console.log("\n=== 37. Admin can create/edit/activate/deactivate Expense Types ===\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const createETRes = await expenseTypesAdminPOST(jsonReq({ name: `PR Creation ExpenseType Active ${RUN_ID}` }));
    check("Admin creates an Expense Type -> 201", createETRes.status === 201);
    const expenseTypeActive = await createETRes.json();
    expenseTypeIds.push(expenseTypeActive.id);
    const expenseTypeActiveId: string = expenseTypeActive.id;

    const createET2Res = await expenseTypesAdminPOST(jsonReq({ name: `PR Creation ExpenseType Inactive ${RUN_ID}`, isActive: false }));
    const expenseTypeInactive = await createET2Res.json();
    expenseTypeIds.push(expenseTypeInactive.id);

    const renameRes = await expenseTypesAdminPATCH(jsonReq({ name: `PR Creation ExpenseType Renamed ${RUN_ID}` }, "PATCH"), { params: Promise.resolve({ id: expenseTypeActive.id }) });
    check("Admin renames it -> 200, name updated", renameRes.status === 200 && (await renameRes.json()).name === `PR Creation ExpenseType Renamed ${RUN_ID}`);

    const adminListRes = await expenseTypesAdminGET();
    const adminList = await adminListRes.json();
    check("Admin listing (GET /api/admin/project-expense-types) shows BOTH active and inactive", adminList.some((t: any) => t.id === expenseTypeActive.id) && adminList.some((t: any) => t.id === expenseTypeInactive.id));

    console.log("\n=== 38. New request-origin Project creation only offers ACTIVE Expense Types ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const activeOnlyRes = await expenseTypesActiveGET();
    const activeOnlyList = await activeOnlyRes.json();
    check("GET /api/project-expense-types (active-only) includes the active type", activeOnlyList.some((t: any) => t.id === expenseTypeActive.id));
    check("...and EXCLUDES the inactive one", !activeOnlyList.some((t: any) => t.id === expenseTypeInactive.id));

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const nonAdminETRes = await expenseTypesAdminGET();
    check("A non-admin.access user gets 403 from the admin Expense Type endpoint", nonAdminETRes.status === 403);

    // ══════════════════════ 7/8/9/10. Authorization boundary ══════════════════════
    console.log("\n=== 7/8/9/10. Setup authorization: exactly the recorded final approver, no generic project.create, no broad bypass ===\n");
    const authRequest = await submitThrough(`PR Creation Auth ${RUN_ID}`, "approve", finalApprover);
    check("Fixture: request reached APPROVED with finalApprover as the recorded approver", authRequest.status === "APPROVED" && authRequest.approverId === finalApprover.id);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const requesterSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: authRequest.id }) });
    check("10. The REQUESTER (not the approver) attempting setup -> 403", requesterSetupRes.status === 403);

    currentSession = { user: { id: unrelatedApprover.id, role: Role.USER, customRoleId: null } };
    const unrelatedSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: authRequest.id }) });
    check("...a DIFFERENT user who also holds projectRequest.approve in the same department -> still 403 (must be THIS exact request's recorded approver, not merely 'someone with the permission')", unrelatedSetupRes.status === 403);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const adminSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: authRequest.id }) });
    check("...even an ADMIN cannot complete setup on someone else's approved request — no identity bypass invented for this boundary", adminSetupRes.status === 403);
    check("...zero Project rows created by any of the three forbidden attempts", (await prisma.project.count({ where: { projectRequestId: authRequest.id } })) === 0);

    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const ownSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: authRequest.id }) });
    check("8. The EXACT recorded final approver -> 200/201, succeeds WITHOUT ever holding generic project.create", ownSetupRes.status === 201);
    const ownSetupBody = await ownSetupRes.json();
    projectIds.push(ownSetupBody.id);

    const manualCreateRes = await projectsPOST(jsonReq({ title: `PR Creation Manual Attempt ${RUN_ID}`, departmentId: dept.id }));
    check("9. That SAME finalApprover still CANNOT manually create an arbitrary Project in this department (POST /api/projects) — completing ONE request's setup never granted generic creation rights", manualCreateRes.status !== 201);

    // ══════════════════════ 11/12. Status gating ══════════════════════
    console.log("\n=== 11/12. Setup is only reachable from a genuinely APPROVED request ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const pendingRequest = await submitThrough(`PR Creation Pending ${RUN_ID}`, null, finalApprover);
    check("Fixture: request is at PENDING_APPROVAL (final decision not yet made)", pendingRequest.status === "PENDING_APPROVAL");
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const pendingSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: pendingRequest.id }) });
    check("11. Setup attempted BEFORE final approval -> 409 (never reachable while PENDING_APPROVAL)", pendingSetupRes.status === 409);

    const rejectedRequest = await submitThrough(`PR Creation Rejected ${RUN_ID}`, "reject", finalApprover);
    check("Fixture: request is REJECTED, with finalApprover still recorded as its approver", rejectedRequest.status === "REJECTED" && rejectedRequest.approverId === finalApprover.id);
    const rejectedSetupRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: rejectedRequest.id }) });
    check("12. A REJECTED request can never enter Project setup, even attempted by its own recorded approver", rejectedSetupRes.status === 409);
    check("...zero Project rows created for the rejected request", (await prisma.project.count({ where: { projectRequestId: rejectedRequest.id } })) === 0);

    // ══════════════════════ 13/14/15/16. Provenance, idempotency, race safety, resumability ══════════════════════
    console.log("\n=== 13. Created Project receives the exact projectRequestId ===\n");
    check("13. Project.projectRequestId === the real request's id", ownSetupBody.id && (await prisma.project.findUnique({ where: { id: ownSetupBody.id } }))?.projectRequestId === authRequest.id);

    console.log("\n=== 14/16. Resubmitting setup for an already-set-up request resolves to the SAME Project, never a duplicate ===\n");
    const resubmitRes = await setupPOST(jsonReq(validSetupPayload()), { params: Promise.resolve({ id: authRequest.id }) });
    check("A second setup submission -> 200 (not 201) and alreadyExisted:true", resubmitRes.status === 200);
    const resubmitBody = await resubmitRes.json();
    check("...returns the SAME Project id as the first submission", resubmitBody.id === ownSetupBody.id && resubmitBody.alreadyExisted === true);
    check("14. At most one Project exists for this request — never two", (await prisma.project.count({ where: { projectRequestId: authRequest.id } })) === 1);

    console.log("\n-- 16. Reopening the setup PAGE for an already-set-up request resolves safely (redirects) to the existing Project --\n");
    let resumeRedirectTarget: string | null = null;
    try {
      await NewProjectPage({ searchParams: Promise.resolve({ projectRequestId: authRequest.id }) } as any);
    } catch (err: any) {
      resumeRedirectTarget = String(err?.digest ?? "").split(";")[2] ?? null;
    }
    check("16. Reopening the setup page for an already-linked request redirects straight to the existing Project — never a second create, never a confusing re-form", resumeRedirectTarget === `/projects/${ownSetupBody.id}`);

    console.log("\n=== 15. Duplicate/concurrent setup submissions cannot produce duplicate Projects ===\n");
    const raceRequest = await submitThrough(`PR Creation Race ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const [raceA, raceB] = await Promise.all([
      setupPOST(jsonReq({ ...validSetupPayload(), title: `PR Creation Race ${RUN_ID}` }), { params: Promise.resolve({ id: raceRequest.id }) }),
      setupPOST(jsonReq({ ...validSetupPayload(), title: `PR Creation Race ${RUN_ID}` }), { params: Promise.resolve({ id: raceRequest.id }) }),
    ]);
    check("15. Both concurrent submissions succeed (200/201), never one hard-failing the other", raceA.status < 300 && raceB.status < 300);
    const raceABody = await raceA.json();
    const raceBBody = await raceB.json();
    check("...and they resolve to the EXACT SAME Project id", raceABody.id === raceBBody.id);
    check("...exactly ONE Project row exists for the race request, never two", (await prisma.project.count({ where: { projectRequestId: raceRequest.id } })) === 1);
    if (raceABody.id) projectIds.push(raceABody.id);

    // ══════════════════════ 17/18/19/20/21. Field mapping & department authority ══════════════════════
    console.log("\n=== 17/18/19/20/21. Field mapping, department authority, Owner(s) are system-wide (NOT department-scoped) ===\n");

    // A DEDICATED request (never mappingRequest below — createProjectFromApprovedRequest
    // is idempotent per-request, one Project per request forever, so this
    // must not consume mappingRequest's own single setup slot).
    const crossDeptOwnerRequest = await submitThrough(`PR Creation CrossDeptOwner ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    // REVISED per this feature's own spec: Owner(s) are explicitly "ANY
    // active user in the entire system" — no Department restriction at
    // all. An owner from a completely DIFFERENT department (otherDeptOwnerUser,
    // who holds no permission in `dept` whatsoever) must be ACCEPTED, not
    // rejected — the exact opposite of this test's old assertion.
    const crossDeptOwnerRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: crossDeptOwnerRequest.title, ownerIds: [otherDeptOwnerUser.id] }), { params: Promise.resolve({ id: crossDeptOwnerRequest.id }) });
    check("21. An owner from a COMPLETELY DIFFERENT department (no permission in this one at all) -> 201, accepted (Owner(s) are system-wide, never Department-scoped)", crossDeptOwnerRes.status === 201);
    const crossDeptOwnerBody = await crossDeptOwnerRes.json();
    if (crossDeptOwnerBody.id) projectIds.push(crossDeptOwnerBody.id);
    const crossDeptOwnerProject = crossDeptOwnerBody.id ? await prisma.project.findUnique({ where: { id: crossDeptOwnerBody.id }, select: { ownerId: true } }) : null;
    check("...and that cross-department user really did become the Project's canonical owner", crossDeptOwnerProject?.ownerId === otherDeptOwnerUser.id);

    const mappingRequest = await submitThrough(`PR Creation Mapping ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };

    // Forged departmentId in the raw body — not even a field on the schema,
    // so it's silently stripped; the server never reads it from the client
    // at all.
    const mappingRes = await setupPOST(
      jsonReq({ ...validSetupPayload(), title: mappingRequest.title, description: mappingRequest.description, priority: mappingRequest.importance, departmentId: otherDept.id } as any),
      { params: Promise.resolve({ id: mappingRequest.id }) }
    );
    check("Valid setup (title/description matching the request's own pre-fill) -> 201", mappingRes.status === 201);
    const mappingBody = await mappingRes.json();
    projectIds.push(mappingBody.id);
    const mappingProject = await prisma.project.findUniqueOrThrow({ where: { id: mappingBody.id } });
    check("17. title pre-fills/persists correctly", mappingProject.title === mappingRequest.title);
    check("18. description pre-fills/persists correctly", mappingProject.description === mappingRequest.description);
    check("19. importance maps to priority correctly (same 1/2/3 scale)", mappingProject.priority === mappingRequest.importance);
    check("20. Department is the REQUEST's own — the forged departmentId in the body was completely ignored", mappingProject.departmentId === dept.id && mappingProject.departmentId !== otherDept.id);

    console.log("\n-- Title/description ARE still ordinary, editable fields (only the department is immutable) --\n");
    const editableRequest = await submitThrough(`PR Creation Editable ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const editableRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: "A deliberately different, user-edited title" }), { params: Promise.resolve({ id: editableRequest.id }) });
    check("A title different from the request's own original -> still 201 (the approver may tweak it)", editableRes.status === 201);
    const editableBody = await editableRes.json();
    projectIds.push(editableBody.id);
    const editableProject = await prisma.project.findUniqueOrThrow({ where: { id: editableBody.id } });
    check("...the submitted (edited) title is what persists, never silently reverted to the request's own", editableProject.title === "A deliberately different, user-edited title");

    // ══════════════════════ 25/26. Expected Total Initial Days — server-computed, immutable baseline ══════════════════════
    console.log("\n=== 25/26. Expected Total Initial Days is computed server-side; a forged client value is ignored ===\n");
    check("25. 2026-10-01 -> 2026-10-05 = 4 whole calendar days", mappingProject.expectedTotalInitialDays === 4);

    const zeroDaysRequest = await submitThrough(`PR Creation ZeroDays ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const zeroDaysRes = await setupPOST(
      jsonReq({ ...validSetupPayload(), title: zeroDaysRequest.title, expectedStartDate: "2026-10-01", expectedFinishDate: "2026-10-01", expectedTotalInitialDays: 9999 } as any),
      { params: Promise.resolve({ id: zeroDaysRequest.id }) }
    );
    check("Same-day Expected Start/Finish -> still 201", zeroDaysRes.status === 201);
    const zeroDaysBody = await zeroDaysRes.json();
    projectIds.push(zeroDaysBody.id);
    const zeroDaysProject = await prisma.project.findUniqueOrThrow({ where: { id: zeroDaysBody.id } });
    check("25. ...persists as 0 days, the server's own calculation", zeroDaysProject.expectedTotalInitialDays === 0);
    check("26. ...and the forged client value (9999) was completely ignored — the field isn't even on the schema", zeroDaysProject.expectedTotalInitialDays !== 9999);

    // ══════════════════════ 27. Expense Type must be ACTIVE at creation time ══════════════════════
    console.log("\n=== 27/39. Expense Type must be ACTIVE for a NEW setup; an already-referencing Project keeps displaying a since-deactivated one ===\n");
    const inactiveETRequest = await submitThrough(`PR Creation InactiveET ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const inactiveETRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: inactiveETRequest.title, expenseTypeId: expenseTypeInactive.id }), { params: Promise.resolve({ id: inactiveETRequest.id }) });
    check("27. Selecting an INACTIVE Expense Type at setup time -> 422 invalid_expense_type", inactiveETRes.status === 422);

    // 39: deactivate the type the earlier `mappingProject` already uses, and
    // confirm GET /api/projects/[id] still shows it correctly.
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const deactivateUsedETRes = await expenseTypesAdminPATCH(jsonReq({ isActive: false }, "PATCH"), { params: Promise.resolve({ id: expenseTypeActiveId }) });
    check("(fixture) Admin deactivates the Expense Type an existing Project already references -> 200", deactivateUsedETRes.status === 200);
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const getMappingProjectRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: mappingProject.id }) });
    const getMappingProjectBody = await getMappingProjectRes.json();
    check("39. The existing Project continues displaying its (now-inactive) Expense Type by name, not just a dangling id", getMappingProjectBody.expenseType?.id === expenseTypeActiveId && getMappingProjectBody.expenseType?.name && getMappingProjectBody.expenseType?.isActive === false);

    // 14. UI/editability pass: an unrelated edit (title) must still save
    // cleanly while the Project's Expense Type stays the now-inactive one —
    // inactive values must remain usable as the CURRENT selection, just not
    // selectable as a NEW one (already proven at check 27 above).
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const unrelatedEditRes = await projectsPATCH(jsonReq({ title: "Mapping Project Renamed" }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("14. An unrelated edit (title) saves fine while expenseTypeId is the now-inactive type — not blocked", unrelatedEditRes.status === 200);
    const unrelatedEditBody = await unrelatedEditRes.json();
    check("...and the inactive Expense Type was NOT cleared or changed by that unrelated save", unrelatedEditBody.expenseType?.id === expenseTypeActiveId && unrelatedEditBody.expenseType?.isActive === false);

    // 13. Editing Expected Start/Finish later must NOT recalculate or
    // overwrite expectedTotalInitialDays — it stays the creation-time
    // baseline (4, from check 25 above: 2026-10-01 -> 2026-10-05) no matter
    // what new dates are PATCHed in.
    const baselineBeforeDateEdit = mappingProject.expectedTotalInitialDays;
    const dateEditRes = await projectsPATCH(
      jsonReq({ expectedStartDate: "2026-01-01", expectedFinishDate: "2026-06-01" }, "PATCH"),
      { params: Promise.resolve({ id: mappingProject.id }) }
    );
    check("13. PATCHing Expected Start/Finish to very different dates -> 200", dateEditRes.status === 200);
    const dateEditBody = await dateEditRes.json();
    check(
      "13. ...expectedTotalInitialDays is UNCHANGED (still the creation-time baseline, never recomputed on edit)",
      dateEditBody.expectedTotalInitialDays === baselineBeforeDateEdit && dateEditBody.expectedTotalInitialDays !== null
    );
    check("...while the dates themselves DID update — proving this isn't just a no-op PATCH", new Date(dateEditBody.expectedStartDate).toISOString().startsWith("2026-01-01"));

    // ══════════════════════ Follow-up pass: edit-time optionality + null-clearing semantics ══════════════════════
    console.log("\n=== Follow-up: Project Request Setup fields are OPTIONAL (and explicitly clearable) on edit, while creation stays strictly required ===\n");

    // 6-10: creation-time requiredness is UNCHANGED — re-proven live through
    // the real route (not just schema.safeParse), one field omitted at a
    // time, against a freshly-approved request so a prior success can't mask
    // a later regression.
    const reqReqFields: ["expectedStartDate", "expectedFinishDate", "expenseTypeId"] = [
      "expectedStartDate",
      "expectedFinishDate",
      "expenseTypeId",
    ];
    const stillRequiredNumbers: Record<string, number> = { 6: 0, 7: 1, 8: 2 };
    for (const [checkNum, idx] of Object.entries(stillRequiredNumbers)) {
      const field = reqReqFields[idx];
      const omitRequest = await submitThrough(`PR Creation StillRequired ${field} ${RUN_ID}`, "approve", finalApprover);
      currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
      const payload = { ...validSetupPayload(), title: omitRequest.title } as Record<string, unknown>;
      delete payload[field];
      const omitRes = await setupPOST(jsonReq(payload), { params: Promise.resolve({ id: omitRequest.id }) });
      check(`${checkNum}. Initial request-origin creation STILL requires ${field} -> rejected when omitted`, omitRes.status === 400 || omitRes.status === 422);
    }

    // 11/12/13/14/15/16/18/19/20/21/23/25/26/27: a real, live edit sequence
    // against mappingProject, each step building on the last.
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };

    // 18: only Expected Start supplied (Finish omitted) -> valid, and the
    // missing counterpart is NOT force-required.
    const onlyStartRes = await projectsPATCH(jsonReq({ expectedStartDate: "2026-02-01" }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("18. PATCH with ONLY Expected Start supplied (Finish omitted) -> 200, valid", onlyStartRes.status === 200);

    // 19: only Expected Finish supplied (Start omitted this time) -> valid.
    const onlyFinishRes = await projectsPATCH(jsonReq({ expectedFinishDate: "2026-07-01" }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("19. PATCH with ONLY Expected Finish supplied (Start omitted) -> 200, valid", onlyFinishRes.status === 200);

    // 20: BOTH supplied together with Finish < Start -> rejected, and the
    // previously-saved values are untouched by the rejected attempt.
    const bothInvalidRes = await projectsPATCH(
      jsonReq({ expectedStartDate: "2026-08-01", expectedFinishDate: "2026-01-01" }, "PATCH"),
      { params: Promise.resolve({ id: mappingProject.id }) }
    );
    check("20. Both dates supplied with Finish < Start -> rejected (400)", bothInvalidRes.status === 400);
    const afterRejectedRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: mappingProject.id }) });
    const afterRejectedBody = await afterRejectedRes.json();
    check("...the rejected attempt did NOT partially apply — dates are still what they were before it", new Date(afterRejectedBody.expectedStartDate).toISOString().startsWith("2026-02-01"));

    // 21: both valid dates together -> saves successfully.
    const bothValidRes = await projectsPATCH(
      jsonReq({ expectedStartDate: "2026-03-01", expectedFinishDate: "2026-03-15" }, "PATCH"),
      { params: Promise.resolve({ id: mappingProject.id }) }
    );
    check("21. Both dates supplied, Finish >= Start -> 200, saves successfully", bothValidRes.status === 200);

    // 11/12/25/26: clear BOTH dates in one PATCH (explicit null, not
    // omission) -> valid ("neither supplied" case), and the immutable
    // creation-time baseline is untouched by any of this.
    const clearBothDatesRes = await projectsPATCH(
      jsonReq({ expectedStartDate: null, expectedFinishDate: null }, "PATCH"),
      { params: Promise.resolve({ id: mappingProject.id }) }
    );
    check("11. Existing Project can save with Expected Start explicitly cleared to null -> 200", clearBothDatesRes.status === 200);
    const clearBothDatesBody = await clearBothDatesRes.json();
    check("11. ...expectedStartDate really persisted as null, not left at its old value", clearBothDatesBody.expectedStartDate === null);
    check("12. ...and Expected Finish explicitly cleared to null too -> persisted as null", clearBothDatesBody.expectedFinishDate === null);
    check(
      "25/26. Expected Total Initial Days is STILL the original creation-time baseline after all of the above date edits (including clearing both)",
      clearBothDatesBody.expectedTotalInitialDays === baselineBeforeDateEdit && clearBothDatesBody.expectedTotalInitialDays !== null
    );

    // 27: PATCH cannot directly alter it even with both dates cleared AND a forged value present.
    const forgedBaselineRes = await projectsPATCH(
      jsonReq({ title: "Mapping Project Renamed Again", expectedTotalInitialDays: 777 } as any, "PATCH"),
      { params: Promise.resolve({ id: mappingProject.id }) }
    );
    check("27. A forged expectedTotalInitialDays in a PATCH body -> silently ignored (not even a field on the schema)", forgedBaselineRes.status === 200);
    const forgedBaselineBody = await forgedBaselineRes.json();
    check("...it is STILL the real baseline, not 777", forgedBaselineBody.expectedTotalInitialDays === baselineBeforeDateEdit && forgedBaselineBody.expectedTotalInitialDays !== 777);

    // 13/14/15/16/17: Budget no longer exists and Estimated/Actual Cost are
    // now fully derived from this Project's own Activities (none exist on
    // mappingProject here) — a client still sending these keys has them
    // silently stripped by Zod (unknown keys), never persisted; the GET/
    // PATCH response's estimatedCost/actualCost are the SERVER-computed
    // totals (via withProjectFinancials), never echoing back what was sent.
    const forgedMoneyRes = await projectsPATCH(jsonReq({ budget: 1000, estimatedCost: 900, actualCost: 250 } as any, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("14/15/16. PATCHing budget/estimatedCost/actualCost -> still 200 (silently stripped, never an error)", forgedMoneyRes.status === 200);
    const forgedMoneyBody = await forgedMoneyRes.json();
    check("17. ...estimatedCost/actualCost in the response are the DERIVED totals (€0, since mappingProject has no Activities), never the forged 900/250", forgedMoneyBody.estimatedCost === "0" && forgedMoneyBody.actualCost === "0");
    check("...and `budget` isn't even present on the response — the column no longer exists", !("budget" in forgedMoneyBody));

    // 23/24: clear the (now-inactive) Expense Type, then prove a genuinely
    // NEW inactive selection is rejected — the edit-time rule now matches
    // creation's "must be active" rule for an actual NEW choice, while an
    // untouched re-save of an already-set inactive value (proven at check
    // 14 above, before clearing) remains unaffected.
    const clearExpenseTypeRes = await projectsPATCH(jsonReq({ expenseTypeId: null }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("13. Existing Project can save with Expense Type explicitly cleared to null -> 200", clearExpenseTypeRes.status === 200);
    const clearExpenseTypeBody = await clearExpenseTypeRes.json();
    check("23. ...Expense Type really persisted as null/absent, not left at its old value", clearExpenseTypeBody.expenseType === null || clearExpenseTypeBody.expenseType === undefined);

    const newInactiveSelectionRes = await projectsPATCH(jsonReq({ expenseTypeId: expenseTypeInactive.id }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("24. Choosing a BRAND NEW inactive Expense Type on edit (never before set on this Project) -> rejected, same rule as creation", newInactiveSelectionRes.status === 400);
    const afterRejectedSelectionRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("...and it was NOT applied — Expense Type is still cleared, not the rejected inactive id", (await afterRejectedSelectionRes.json()).expenseTypeId === null);

    // 22: re-confirm, now that clearing/re-selecting has been exercised,
    // that an UNRELATED edit on a Project whose Expense Type is untouched
    // (left at whatever it currently is) still saves fine — the general
    // guarantee already proven at check 14 earlier in this file holds
    // throughout this whole sequence, not just once.
    const finalUnrelatedEditRes = await projectsPATCH(jsonReq({ title: "Mapping Project Final Title" }, "PATCH"), { params: Promise.resolve({ id: mappingProject.id }) });
    check("22. An unrelated edit still saves fine after all this field churn", finalUnrelatedEditRes.status === 200);

    // 28: a legacy request-origin Project with every new field left null can
    // still have an unrelated field edited successfully, without being
    // forced to backfill the Project Request Setup fields first.
    const legacySetupProject = await prisma.project.create({
      data: { title: `PR Creation Legacy Setup Null ${RUN_ID}`, departmentId: dept.id, ownerId: ownerUser.id, projectRequestId: null },
    });
    projectIds.push(legacySetupProject.id);
    const legacySetupPatchRes = await projectsPATCH(jsonReq({ title: "Legacy Setup Project Renamed" }, "PATCH"), { params: Promise.resolve({ id: legacySetupProject.id }) });
    check("28. A legacy request-origin Project with null Project Request Setup fields can edit an unrelated field (title) successfully", legacySetupPatchRes.status === 200);

    // ══════════════════════ 40. A referenced Expense Type cannot be destructively deleted ══════════════════════
    console.log("\n=== 40. DELETE on a referenced Expense Type is blocked; an unused one deletes cleanly ===\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const deleteReferencedRes = await expenseTypesAdminDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: expenseTypeActiveId }) });
    check("40. DELETE on an Expense Type still referenced by a Project -> 409 item_in_use", deleteReferencedRes.status === 409);
    check("...it was NOT deleted — still present", (await prisma.projectExpenseType.findUnique({ where: { id: expenseTypeActiveId } })) !== null);
    check("...and no Project was cascade-deleted by the blocked attempt", (await prisma.project.findUnique({ where: { id: mappingProject.id } })) !== null);

    const unusedETRes = await expenseTypesAdminPOST(jsonReq({ name: `PR Creation ExpenseType Unused ${RUN_ID}` }));
    const unusedET = await unusedETRes.json();
    const deleteUnusedRes = await expenseTypesAdminDELETE(jsonReq(undefined, "DELETE"), { params: Promise.resolve({ id: unusedET.id }) });
    check("An Expense Type with NO Project referencing it deletes cleanly -> 204", deleteUnusedRes.status === 204);

    // ══════════════════════ 33/34/35. Scope isolation — manual creation totally unaffected ══════════════════════
    console.log("\n=== 33/34/35. Normal /projects/new (manual) is completely unaffected ===\n");
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const manualOwnerCreateRes = await projectsPOST(jsonReq({ title: `PR Creation Manual Normal ${RUN_ID}`, departmentId: dept.id }));
    check("33/34. A normal manual creation (no request-origin fields at all) still works exactly as before", manualOwnerCreateRes.status === 201);
    const manualProject = await manualOwnerCreateRes.json();
    projectIds.push(manualProject.id);
    check("34. ...and requires none of the new metadata — every new field is simply null/default on a manual Project", manualProject.projectRequestId === undefined || manualProject.projectRequestId === null);

    console.log("\n-- 36. A forged attempt to fake request-origin provenance through the GENERIC create API is a no-op, not an escalation --\n");
    const forgedManualRes = await projectsPOST(
      jsonReq({
        title: `PR Creation Forged Provenance ${RUN_ID}`,
        departmentId: dept.id,
        projectRequestId: authRequest.id,
        expectedStartDate: "2026-01-01",
        expectedFinishDate: "2026-01-02",
        budget: 999999,
        ownerIds: [ownerUser.id],
      } as any)
    );
    check("36. The forged payload still succeeds as an ORDINARY manual Project -> 201 (the extra keys are simply stripped, not an error)", forgedManualRes.status === 201);
    const forgedManualProject = await forgedManualRes.json();
    projectIds.push(forgedManualProject.id);
    const forgedManualRow = await prisma.project.findUniqueOrThrow({ where: { id: forgedManualProject.id } });
    check("...projectRequestId was NEVER set from the forged body — it's still null", forgedManualRow.projectRequestId === null);
    check("...expectedStartDate was NEVER set either — createProjectSchema simply doesn't declare that field (budget isn't even a column any more)", forgedManualRow.expectedStartDate === null);
    check("...the REAL already-approved request (authRequest) was completely unaffected by this forged attempt — still linked only to its own real Project", (await prisma.project.count({ where: { projectRequestId: authRequest.id } })) === 1);

    console.log("\n-- The plain /projects/new page (no projectRequestId) still renders the ordinary manual form --\n");
    const plainPageEl = await NewProjectPage({ searchParams: Promise.resolve({}) } as any);
    check("35. The plain manual-creation page renders without throwing, and is a distinct code path from fromRequest mode", plainPageEl !== undefined);

    // ══════════════════════ 41/42/43. Legacy safety ══════════════════════
    console.log("\n=== 41/42/43. Legacy Projects (manual, and pre-this-feature auto-created) remain fully readable/editable ===\n");
    const legacyAutoCreatedProject = await prisma.project.create({
      data: {
        title: `PR Creation Legacy AutoCreated ${RUN_ID}`,
        departmentId: dept.id,
        ownerId: ownerUser.id,
        projectRequestId: null, // a real pre-feature row would reference its own old request; null here is sufficient to prove the null-new-fields case
      },
    });
    projectIds.push(legacyAutoCreatedProject.id);
    check("41. A legacy row with every new field left null is created without error", legacyAutoCreatedProject.expectedStartDate === null);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const legacyGetRes = await projectsGET(jsonReq(undefined, "GET"), { params: Promise.resolve({ id: legacyAutoCreatedProject.id }) });
    check("41. GET on the legacy row -> 200, reads back cleanly", legacyGetRes.status === 200);

    const legacyPatchRes = await projectsPATCH(jsonReq({ title: "Legacy Project Renamed" }, "PATCH"), { params: Promise.resolve({ id: legacyAutoCreatedProject.id }) });
    check("42. PATCH touching only an unrelated field (title) succeeds WITHOUT requiring any of the new fields to be backfilled first", legacyPatchRes.status === 200);

    const legacyFillInRes = await projectsPATCH(jsonReq({ expectedStartDate: "2026-05-01" }, "PATCH"), { params: Promise.resolve({ id: legacyAutoCreatedProject.id }) });
    check("43. A legacy row can have a previously-null new field filled in LATER via the normal edit route", legacyFillInRes.status === 200 && (await legacyFillInRes.json()).expectedStartDate !== null);

    // ══════════════════════ UI pass: 4/5/8/9 — detail-page rendering + the pencil's permission gate ══════════════════════
    console.log("\n=== UI pass 4/5/8/9: detail page renders for both provenances; the Edit control's gate is the SAME canEditProject the rest of the page already uses ===\n");
    const { default: ProjectDetailPage } = await import("@/app/(main)/projects/[id]/page");
    const { hasEffectiveEntityPermission } = await import("@/lib/services/department-scope-service");

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const requestOriginDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: mappingProject.id }) } as any);
    check("4. The request-origin Project's detail page renders without throwing", requestOriginDetailEl !== undefined);

    const manualDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: manualProject.id }) } as any);
    check("5. A manual Project's detail page renders without throwing too (same code path, projectRequest simply null)", manualDetailEl !== undefined);

    // 8/9: the JSX wraps the Edit control in exactly `{canEditProject && (...)}`
    // (already asserted structurally above) — so proving that boolean is
    // correct for an authorized vs. an unauthorized role IS proving the
    // control's visibility, the same way this page's pre-existing
    // canEditProject/canDeleteProject gates are proven elsewhere in this
    // suite. No new permission was introduced — this re-checks the existing
    // project.edit grant used by every other edit affordance on this page.
    const viewerOnlyUser = await makeUser(`pr-creation-viewer-${RUN_ID}@kinsen.gr`);
    userIds.push(viewerOnlyUser.id);
    await addMembership(viewerOnlyUser.id, dept.id); // base VIEWER role: project.view only, no project.edit (see prisma/seed.ts)
    const adminCanEdit = await hasEffectiveEntityPermission(adminUser.id, Role.ADMIN, null, dept.id, "project.edit");
    const viewerCanEdit = await hasEffectiveEntityPermission(viewerOnlyUser.id, Role.USER, null, dept.id, "project.edit");
    check("8. An authorized user (project.edit) -> canEditProject is true, so the pencil/Edit control renders", adminCanEdit === true);
    check("9. An unauthorized user (view-only) -> canEditProject is false, so the pencil/Edit control does NOT render", viewerCanEdit === false);

    // ══════════════════════ Owner(s) + Audience — the new feature's own acceptance criteria ══════════════════════
    console.log("\n=== Owner(s) + Audience: multi-owner, system-wide eligibility, independent persistence, view-only authorization ===\n");
    const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");

    // expenseTypeActiveId was deactivated earlier (check 39, "an
    // already-referencing Project keeps displaying a since-deactivated
    // one") — validSetupPayload()'s default expenseTypeId is no longer
    // usable for a NEW setup from this point on, so every call below
    // overrides it with this section's own freshly-created, still-active one.
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const freshExpenseType = await expenseTypesAdminPOST(jsonReq({ name: `PR Creation Owners/Audience ExpenseType ${RUN_ID}` }));
    const freshExpenseTypeBody = await freshExpenseType.json();
    expenseTypeIds.push(freshExpenseTypeBody.id);
    const freshExpenseTypeId: string = freshExpenseTypeBody.id;
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };

    // Users with ZERO department membership anywhere — proves Owner(s)/
    // Audience genuinely need no department tie at all, not just "a
    // DIFFERENT department" (already proven at check 21 above).
    const secondOwnerNoMembership = await makeUser(`pr-creation-secondowner-nomembership-${RUN_ID}@kinsen.gr`);
    const audienceNoMembership1 = await makeUser(`pr-creation-audience1-${RUN_ID}@kinsen.gr`);
    const audienceNoMembership2 = await makeUser(`pr-creation-audience2-${RUN_ID}@kinsen.gr`);
    const inactiveUser = await prisma.user.create({ data: { email: `pr-creation-inactive-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: false } });
    userIds.push(inactiveUser.id);

    const multiRequest = await submitThrough(`PR Creation Multi ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };

    console.log("\n-- 4/14. Submission without any Owner is rejected server-side --\n");
    const noOwnerRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: multiRequest.title, expenseTypeId: freshExpenseTypeId, ownerIds: [] }), { params: Promise.resolve({ id: multiRequest.id }) });
    check("4. ownerIds: [] (no Owner at all) -> rejected (422, Zod min(1) validation_failed)", noOwnerRes.status === 422);
    check("...zero Project rows created by the rejected attempt", (await prisma.project.count({ where: { projectRequestId: multiRequest.id } })) === 0);

    console.log("\n-- Invalid/inactive user ids in ownerIds/audienceIds are rejected, never silently dropped --\n");
    const invalidOwnerRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: multiRequest.title, expenseTypeId: freshExpenseTypeId, ownerIds: [ownerUser.id, inactiveUser.id] }), { params: Promise.resolve({ id: multiRequest.id }) });
    check("An INACTIVE user among ownerIds -> 422 invalid_project_owner (fails closed, never silently drops just that one)", invalidOwnerRes.status === 422);
    const invalidOwnerRes2 = await setupPOST(jsonReq({ ...validSetupPayload(), title: multiRequest.title, expenseTypeId: freshExpenseTypeId, ownerIds: ["cmnonexistentuser00000000000"] }), { params: Promise.resolve({ id: multiRequest.id }) });
    check("A NON-EXISTENT user id among ownerIds -> 422 invalid_project_owner", invalidOwnerRes2.status === 422);
    const invalidAudienceRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: multiRequest.title, expenseTypeId: freshExpenseTypeId, audienceIds: [inactiveUser.id] }), { params: Promise.resolve({ id: multiRequest.id }) });
    check("An INACTIVE user among audienceIds -> 422 invalid_audience", invalidAudienceRes.status === 422);
    check("...none of the three rejected attempts created a Project", (await prisma.project.count({ where: { projectRequestId: multiRequest.id } })) === 0);

    console.log("\n-- 1/2/3/5/6/7. Multiple Owners (incl. a user with NO department membership anywhere) + Audience, duplicates deduplicated --\n");
    const multiRes = await setupPOST(
      jsonReq({
        ...validSetupPayload(),
        title: multiRequest.title,
        expenseTypeId: freshExpenseTypeId,
        // Duplicate id included deliberately — must be deduplicated, never
        // stored twice / never rejected for "being a duplicate".
        ownerIds: [ownerUser.id, secondOwnerNoMembership.id, ownerUser.id],
        audienceIds: [audienceNoMembership1.id, audienceNoMembership2.id],
      }),
      { params: Promise.resolve({ id: multiRequest.id }) }
    );
    check("1/2. Multiple Owners, one with NO department membership anywhere -> 201, accepted", multiRes.status === 201);
    const multiBody = await multiRes.json();
    projectIds.push(multiBody.id);
    const multiProject = await prisma.project.findUniqueOrThrow({
      where: { id: multiBody.id },
      include: { owners: { select: { id: true } }, audience: { select: { id: true } }, members: { select: { id: true } } },
    });
    check("5. No Owner was automatically assigned beyond what was explicitly submitted — ownerId is the FIRST explicitly-selected one, never the approver/requester/creator", multiProject.ownerId === ownerUser.id && multiProject.ownerId !== finalApprover.id && multiProject.ownerId !== requester.id);
    check("6. Every selected Owner was explicitly chosen — the full owners set is EXACTLY {ownerUser, secondOwnerNoMembership}, no more, no fewer", multiProject.owners.length === 2 && multiProject.owners.some((o) => o.id === ownerUser.id) && multiProject.owners.some((o) => o.id === secondOwnerNoMembership.id));
    check("...duplicate ownerId submitted twice was deduplicated, not stored twice", multiProject.owners.filter((o) => o.id === ownerUser.id).length === 1);
    check("3/7. Audience persists independently — EXACTLY {audienceNoMembership1, audienceNoMembership2}", multiProject.audience.length === 2 && multiProject.audience.some((a) => a.id === audienceNoMembership1.id) && multiProject.audience.some((a) => a.id === audienceNoMembership2.id));
    check("7. Audience is NOT Members — Members is empty here (none were submitted), completely independent of the Owner(s)/Audience sets", multiProject.members.length === 0);
    check("...and Audience is NOT Owners either — zero overlap between the two sets for this Project", !multiProject.audience.some((a) => multiProject.owners.some((o) => o.id === a.id)));

    console.log("\n-- 8/9. Every selected Owner (not just the primary) is recognized by hasProjectViewAccess; Audience gets the SAME read access but never project.edit --\n");
    const multiProjectForAccess = { id: multiProject.id, departmentId: multiProject.departmentId, projectRequestId: multiProject.projectRequestId };
    const primaryOwnerCanView = await hasProjectViewAccess(ownerUser.id, Role.USER, null, multiProjectForAccess);
    const secondOwnerCanView = await hasProjectViewAccess(secondOwnerNoMembership.id, Role.USER, null, multiProjectForAccess);
    check("8. The PRIMARY owner (ownerId) can view, via their own project.assignable grant (unchanged Department path)", primaryOwnerCanView === true);
    check("8. The SECOND owner (NOT project.ownerId, no Department permission anywhere) can STILL view — the full `owners` set is recognized, not just the canonical ownerId", secondOwnerCanView === true);
    const audienceCanView = await hasProjectViewAccess(audienceNoMembership1.id, Role.USER, null, multiProjectForAccess);
    check("9. An Audience user (no Department permission anywhere) CAN view/follow the Project through the canonical authorization path", audienceCanView === true);
    const audienceCanEdit = await hasEffectiveEntityPermission(audienceNoMembership1.id, Role.USER, null, multiProject.departmentId, "project.edit");
    check("9. ...but that SAME Audience user does NOT gain project.edit merely from Audience membership — still governed by the unchanged, Department-scoped check", audienceCanEdit === false);
    const secondOwnerCanEdit = await hasEffectiveEntityPermission(secondOwnerNoMembership.id, Role.USER, null, multiProject.departmentId, "project.edit");
    check("...the second (non-canonical) Owner likewise does NOT get project.edit merely from being an Owner — ownership never implicitly grants mutation rights beyond the existing Department-scoped grant", secondOwnerCanEdit === false);

    console.log("\n-- 11. A manual Project's hasProjectViewAccess behaves IDENTICALLY to the unchanged hasEffectiveEntityPermission — no bypass for a stranger --\n");
    const strangerUser = await makeUser(`pr-creation-stranger-${RUN_ID}@kinsen.gr`);
    const manualProjectForAccess = { id: manualProject.id, departmentId: manualProject.departmentId, projectRequestId: null };
    const strangerDirectCheck = await hasEffectiveEntityPermission(strangerUser.id, Role.USER, null, manualProject.departmentId, "project.view");
    const strangerViaWrapper = await hasProjectViewAccess(strangerUser.id, Role.USER, null, manualProjectForAccess);
    check("11. A manual Project: hasProjectViewAccess === hasEffectiveEntityPermission for an uninvolved stranger (both false) — no Owner(s)/Audience bypass path exists for a manual Project", strangerDirectCheck === false && strangerViaWrapper === false && strangerDirectCheck === strangerViaWrapper);

    console.log("\n-- Members stays Department-scoped (genuinely unchanged) — contrast with Owner(s)/Audience above --\n");
    const crossDeptMemberRequest = await submitThrough(`PR Creation CrossDeptMember ${RUN_ID}`, "approve", finalApprover);
    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const crossDeptMemberRes = await setupPOST(jsonReq({ ...validSetupPayload(), title: crossDeptMemberRequest.title, expenseTypeId: freshExpenseTypeId, memberIds: [otherDeptOwnerUser.id] }), { params: Promise.resolve({ id: crossDeptMemberRequest.id }) });
    check("A Member candidate who is only project.assignable in a DIFFERENT department -> still 400 invalid_member (Members' own eligibility is genuinely UNCHANGED — the contrast that proves Owner(s)/Audience are a deliberate, scoped exception, not an accidental global loosening)", crossDeptMemberRes.status === 400);
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["projects (explicitly tracked)", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["projects (auto-linked from these requests)", () => prisma.project.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["intermediate approver rows", () => prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } })],
      ["project requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } })],
      ["project request types", () => prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } })],
      ["project expense types", () => prisma.projectExpenseType.deleteMany({ where: { id: { in: expenseTypeIds } } })],
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
