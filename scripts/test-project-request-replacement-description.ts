/**
 * Regression coverage for the new conditional "Solution/project to be
 * replaced" field on the Project Request Form — only required (and only
 * ever shown) when the "Replaces an existing solution/project" checkbox is
 * checked.
 *
 * SECTION A is pure Zod schema unit tests (createProjectRequestSchema's own
 * .superRefine invariant) — no DOM, no DB needed. SECTION B is a source-text
 * guard for the client-only conditional show/hide + clear-on-uncheck
 * behavior (no DOM to drive directly in this suite — same established
 * convention as every other client-only check this session). SECTION C
 * drives the REAL POST route and detail page against a real database to
 * prove the server-side invariant, persistence (including the pre-existing-
 * rows-with-NULL migration safety), detail-page visibility, and that the
 * approval workflow/notifications are completely unaffected.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-replacement-description.ts
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

/** Runs each cleanup step independently — one step throwing must never skip every step after it (that silent partial-cleanup is exactly how earlier test runs left orphaned fixture users/Notification rows in the dev database). */
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

const RUN_ID = Date.now();

const VALID_BASE = {
  title: `PR Replace Base ${RUN_ID}`,
  description: "A description that is definitely long enough.",
  importance: 2,
  teamConcerned: "Engineering",
  expectedBenefits: "Benefits text that is definitely long enough for validation.",
  // Any non-empty array — intermediateApproverIds' own DB-level eligibility
  // is checked separately by the route (Section C); Section A only exercises
  // the replacesExisting <-> replacementDescription schema invariant.
  intermediateApproverIds: ["cmx0000000000000000000001"],
};

async function main() {
  const { createProjectRequestSchema } = await import("@/lib/validations");

  // ══════════════════════ SECTION A — Zod schema, pure unit tests ══════════════════════
  console.log("\n=== SECTION A — createProjectRequestSchema's replacesExisting <-> replacementDescription invariant ===\n");

  const missingProjectTypeId = "cmx0000000000000000000000"; // any non-empty string; projectTypeId's own DB-level validity is checked separately by the route

  check(
    "3. replacesExisting:true, replacementDescription MISSING -> validation fails",
    !createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true }).success
  );
  const missingResult = createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true });
  check("...the error is associated with the replacementDescription field (for inline UI association)", !missingResult.success && missingResult.error.issues.some((i) => i.path.join(".") === "replacementDescription"));

  check(
    "4. replacesExisting:true, replacementDescription is WHITESPACE-ONLY -> validation fails (trimmed to empty)",
    !createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true, replacementDescription: "   \n\t  " }).success
  );

  check(
    "5. replacesExisting:true, a REAL description -> validation passes",
    createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true, replacementDescription: "The legacy spreadsheet-based tracker." }).success
  );

  const paddedResult = createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true, replacementDescription: "  padded text  " });
  check("...and the persisted value is TRIMMED by the schema itself", paddedResult.success && paddedResult.data.replacementDescription === "padded text");

  check(
    "6. replacesExisting:false with a FORGED description present -> the schema itself still accepts the request (route discards the value, see Section C)",
    createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: false, replacementDescription: "forged text that should be ignored" }).success
  );

  check(
    "replacesExisting:false with NO description at all -> validation passes (never required when unchecked)",
    createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: false }).success
  );

  const tooLongResult = createProjectRequestSchema.safeParse({ ...VALID_BASE, projectTypeId: missingProjectTypeId, replacesExisting: true, replacementDescription: "x".repeat(5001) });
  check("A description over 5000 chars (matching every other free-text field's limit) -> rejected", !tooLongResult.success);

  // ══════════════════════ SECTION B — client-only conditional behavior (source-text guard) ══════════════════════
  console.log("\n=== SECTION B — Form: conditional show/hide, clear-on-uncheck, accessibility wiring ===\n");
  const formSrc = await fs.readFile("components/project-requests/project-request-form.tsx", "utf8");

  check("1/2. The textarea block is conditionally rendered on `replacesExisting` — hidden when false, shown when true", /\{replacesExisting && \(/.test(formSrc) && /id="replacementDescription"/.test(formSrc));
  check("Label text matches exactly: \"Solution/project to be replaced\"", /Solution\/project to be replaced/.test(formSrc));
  check("Helper text matches exactly: \"Describe the existing solution or project that this request will replace.\"", /Describe the existing solution or project that this request will replace\./.test(formSrc));
  check("The textarea has a sensible maxLength matching the other Project Request text fields (5000)", /id="replacementDescription"[\s\S]{0,150}maxLength=\{5000\}/.test(formSrc));
  check("Correct aria-describedby wiring (helper text, plus the error id when present)", /aria-describedby=\{errors\.replacementDescription \? "replacementDescription-helper replacementDescription-error" : "replacementDescription-helper"\}/.test(formSrc));
  check("aria-invalid reflects the field's own error state", /aria-invalid=\{!!errors\.replacementDescription\}/.test(formSrc));
  check("Inline validation error is rendered when present (accessible error association via the same id referenced by aria-describedby)", /id="replacementDescription-error"/.test(formSrc) && /\{errors\.replacementDescription &&/.test(formSrc));

  console.log("\n-- 7. Unchecking clears the client-held value AND its error, so nothing stale survives a re-check --\n");
  const checkboxHandlerBlock = formSrc.slice(formSrc.indexOf("Replaces an existing solution/project") - 900, formSrc.indexOf("Replaces an existing solution/project"));
  check("The checkbox's onChange, on uncheck, calls setValue(\"replacementDescription\", undefined)", /setValue\("replacementDescription", undefined\)/.test(checkboxHandlerBlock));
  check("...and clearErrors(\"replacementDescription\") so a stale inline error doesn't linger either", /clearErrors\("replacementDescription"\)/.test(checkboxHandlerBlock));

  // ══════════════════════ SECTION C — real route + real DB ══════════════════════
  console.log("\n=== SECTION C — real POST route + detail page against a real database ===\n");

  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const dept = await createDepartment({ name: `PR Replace Dept ${RUN_ID}`, slug: `pr-replace-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR Replace Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await prisma.user.create({ data: { email: `pr-replace-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(requester.id);
    await prisma.departmentMembership.create({ data: { userId: requester.id, departmentId: dept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });

    const globalApproverRole = await prisma.customRole.create({ data: { key: `PR_REPLACE_APPROVER_${RUN_ID}`, name: `PR Replace Approver ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL" as any, isActive: true } });
    customRoleIds.push(globalApproverRole.id);
    customRoleKeys.push(globalApproverRole.key);
    const approvePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: globalApproverRole.key, permissionId: approvePerm.id } });
    // Also project-assignable, via the SAME role — systemApprover doubles
    // as the chosen owner of the Project auto-created on approval (see
    // decideApproval), no separate fixture needed just for that.
    const projectAssignablePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "project.assignable" } });
    await prisma.rolePermission.create({ data: { roleKey: globalApproverRole.key, permissionId: projectAssignablePerm.id } });
    const systemApprover = await prisma.user.create({ data: { email: `pr-replace-sysapprover-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(systemApprover.id);
    await prisma.departmentMembership.create({ data: { userId: systemApprover.id, departmentId: dept.id, role: DepartmentRole.VIEWER, customRoleId: globalApproverRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });

    const intermediateApproverRole = await prisma.customRole.create({ data: { key: `PR_REPLACE_INTERMEDIATE_${RUN_ID}`, name: `PR Replace Intermediate Approver ${RUN_ID}`, isBuiltIn: false, scope: "GLOBAL" as any, isActive: true } });
    customRoleIds.push(intermediateApproverRole.id);
    customRoleKeys.push(intermediateApproverRole.key);
    const intermediateApprovePerm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.intermediateApprove" } });
    await prisma.rolePermission.create({ data: { roleKey: intermediateApproverRole.key, permissionId: intermediateApprovePerm.id } });
    // The global-permission reverse lookup used at submission time reads the
    // User's own top-level customRoleId DB column, never a
    // DepartmentMembership's — must be set directly here.
    const intermediateApprover = await prisma.user.create({ data: { email: `pr-replace-intermediate-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId: intermediateApproverRole.id } });
    userIds.push(intermediateApprover.id);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };

    console.log("\n-- 8. A pre-existing row with NULL replacementDescription (simulating a row from before this migration) remains valid --\n");
    const preExisting = await prisma.projectRequest.create({
      data: {
        title: `PR Replace Legacy ${RUN_ID}`,
        description: VALID_BASE.description,
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Ops",
        expectedBenefits: VALID_BASE.expectedBenefits,
        legacyRequesterBusinessAssessment: "Legacy pre-redesign requester assessment text.",
        replacesExisting: false,
        requesterId: requester.id,
        departmentId: dept.id,
        // A row from before the intermediate-approval redesign must not
        // silently pick up the new PENDING_INTERMEDIATE_APPROVAL default.
        status: "PENDING_APPROVAL",
        // replacementDescription deliberately omitted — must default to NULL.
      },
    });
    requestIds.push(preExisting.id);
    check("A row created without replacementDescription is valid and stores NULL", preExisting.replacementDescription === null);
    const reread = await prisma.projectRequest.findUniqueOrThrow({ where: { id: preExisting.id } });
    check("...and reads back cleanly as null (no migration/type error)", reread.replacementDescription === null);

    console.log("\n-- 6. Checkbox off + forged description via a direct API call -> stored as NULL, never the forged text --\n");
    const forgedFalseRes = await requestsPOST(
      jsonReq({ ...VALID_BASE, title: `PR Replace ForgedFalse ${RUN_ID}`, projectTypeId: type.id, replacesExisting: false, replacementDescription: "forged text that must be discarded", intermediateApproverIds: [intermediateApprover.id] })
    );
    check("replacesExisting:false with a forged description -> 201 (request itself is valid)", forgedFalseRes.status === 201);
    const forgedFalseBody = await forgedFalseRes.json();
    requestIds.push(forgedFalseBody.id);
    const forgedFalseRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: forgedFalseBody.id } });
    check("...the stored replacementDescription is NULL, the forged text was discarded server-side", forgedFalseRow.replacementDescription === null);

    console.log("\n-- 4. Checkbox on + whitespace-only description, submitted directly to the API (bypassing any client trim) -> server rejection --\n");
    const countBefore = await prisma.projectRequest.count();
    const notifCountBefore = await prisma.notification.count({ where: { userId: systemApprover.id } });
    const whitespaceRes = await requestsPOST(
      jsonReq({ ...VALID_BASE, title: `PR Replace Whitespace ${RUN_ID}`, projectTypeId: type.id, replacesExisting: true, replacementDescription: "   \n\t   ", intermediateApproverIds: [intermediateApprover.id] })
    );
    check("10. Whitespace-only replacementDescription with replacesExisting:true -> 422 (validation failure)", whitespaceRes.status === 422);
    const countAfter = await prisma.projectRequest.count();
    check("10. ...zero ProjectRequest rows created", countBefore === countAfter);
    const notifCountAfter = await prisma.notification.count({ where: { userId: systemApprover.id } });
    check("10. ...zero notifications created either", notifCountBefore === notifCountAfter);

    console.log("\n-- 5. Checkbox on + a valid description -> successful creation, TRIMMED persistence --\n");
    const validRes = await requestsPOST(
      jsonReq({ ...VALID_BASE, title: `PR Replace Valid ${RUN_ID}`, projectTypeId: type.id, replacesExisting: true, replacementDescription: "  The legacy on-prem ticketing tool.  ", intermediateApproverIds: [intermediateApprover.id] })
    );
    check("Valid replacesExisting:true submission -> 201", validRes.status === 201);
    const validBody = await validRes.json();
    requestIds.push(validBody.id);
    const validRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: validBody.id } });
    check("...replacesExisting is stored as true", validRow.replacesExisting === true);
    check("...replacementDescription is persisted TRIMMED (no leading/trailing whitespace)", validRow.replacementDescription === "The legacy on-prem ticketing tool.");

    console.log("\n-- 12. The submission notification body does NOT include the replacement description text --\n");
    // Submission now notifies the intermediate approver first (the final,
    // department-scoped approver isn't notified until the intermediate
    // stage completes — see below).
    const submitNotif = await prisma.notification.findFirst({ where: { userId: intermediateApprover.id, link: `/project-requests/${validBody.id}` } });
    check("Intermediate approver notification exists for this submission", submitNotif !== null);
    check("...its body does NOT contain the replacement description text", !submitNotif?.body.includes("legacy on-prem ticketing tool"));

    console.log("\n-- 9. Detail page shows the replacement description ONLY when replacesExisting === true --\n");
    // The page's own local `Field` helper is a custom (non-intrinsic)
    // component — calling the Server Component function directly (no real
    // React renderer in this suite) never invokes it, so its OWN <p>
    // children don't exist yet in the raw tree; only the unresolved
    // {type: Field, props: {label, value}} placeholder does. Matching by
    // prop SHAPE (never needing a reference to the unexported Field
    // function itself) is the reliable way to find it — same established
    // limitation/workaround as every other nested-custom-component check
    // this session's test suite already uses.
    function findElementsByProps(node: any, predicate: (props: any) => boolean, results: any[] = []): any[] {
      if (node == null || typeof node !== "object") return results;
      if (node.props && predicate(node.props)) results.push(node);
      const children = node.props?.children;
      if (Array.isArray(children)) for (const c of children) findElementsByProps(c, predicate, results);
      else if (children) findElementsByProps(children, predicate, results);
      return results;
    }
    const detailWithReplacement = await ProjectRequestDetailPage({ params: Promise.resolve({ id: validBody.id }) });
    const [replacementFieldEl] = findElementsByProps(detailWithReplacement, (p) => p.label === "Solution/project to be replaced");
    check("replacesExisting:true detail page renders the 'Solution/project to be replaced' Field", replacementFieldEl !== undefined);
    check("...with the exact, full replacement description text as its value", replacementFieldEl?.props.value === "The legacy on-prem ticketing tool.");

    const detailWithoutReplacement = await ProjectRequestDetailPage({ params: Promise.resolve({ id: forgedFalseBody.id }) });
    const withoutReplacementMatches = findElementsByProps(detailWithoutReplacement, (p) => p.label === "Solution/project to be replaced");
    check("replacesExisting:false detail page does NOT render the 'Solution/project to be replaced' section at all", withoutReplacementMatches.length === 0);

    console.log("\n-- Clearing the mandatory intermediate stage before the final approval workflow can run --\n");
    const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
    currentSession = { user: { id: intermediateApprover.id, role: Role.USER, customRoleId: intermediateApproverRole.id } };
    const clearIntermediateRes = await intermediateApprovalPOST(
      jsonReq({ decision: "approve", businessAssessment: "Intermediate approval granted." }),
      { params: Promise.resolve({ id: validBody.id }) }
    );
    check("Intermediate approver clears the stage -> 200", clearIntermediateRes.status === 200);
    const afterIntermediate = await prisma.projectRequest.findUniqueOrThrow({ where: { id: validBody.id } });
    check("...status now advances to PENDING_APPROVAL, unlocking the final stage", afterIntermediate.status === "PENDING_APPROVAL");
    const finalStageNotif = await prisma.notification.findFirst({ where: { userId: systemApprover.id, link: `/project-requests/${validBody.id}` } });
    check("...and ONLY NOW is the final, department-scoped approver notified", finalStageNotif !== null);

    console.log("\n-- 11. The single-stage approval workflow itself is completely unaffected by this addition --\n");
    const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
    currentSession = { user: { id: systemApprover.id, role: Role.USER, customRoleId: null } };
    const approveRes = await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "Positive ROI, proceed.", projectOwnerId: systemApprover.id }), { params: Promise.resolve({ id: validBody.id }) });
    check("Approval on a replacesExisting:true request still works normally -> 200", approveRes.status === 200);
    const afterApprove = await prisma.projectRequest.findUniqueOrThrow({ where: { id: validBody.id } });
    check("...status -> APPROVED as always", afterApprove.status === "APPROVED");
    check("...replacementDescription is untouched by the approval action itself", afterApprove.replacementDescription === "The legacy on-prem ticketing tool.");
    check("...the approver's businessAssessment is stored independently of replacementDescription", afterApprove.businessAssessment === "Positive ROI, proceed.");
    const finalNotif = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/project-requests/${validBody.id}` }, orderBy: { createdAt: "desc" } });
    check("Final approval notification's body does NOT include the replacement description", !!finalNotif && !finalNotif.body.includes("legacy on-prem ticketing tool"));
    check("...nor the approver's businessAssessment text", !!finalNotif && !finalNotif.body.includes("Positive ROI, proceed."));
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
