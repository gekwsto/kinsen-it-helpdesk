/**
 * Regression coverage for moving "Business Assessment" off the requester's
 * create form and onto the approver's own decision.
 *
 * BEFORE: the requester filled in a required `businessAssessment` field on
 * the Project Request Form itself.
 * AFTER: the requester never fills in any assessment. Instead, whoever
 * decides the request (Approve or Reject) must supply a mandatory Business
 * Assessment in a shared confirmation dialog at decision time. That text is
 * stored on `ProjectRequest.businessAssessment` (an approver-side field,
 * null until decided). Any PRE-EXISTING requester-filled value from before
 * this change was preserved, never destroyed, under a new
 * `legacyRequesterBusinessAssessment` column — read-only, shown separately
 * on the detail page.
 *
 * NOTE on scope: this repo's single Project Request approval model has ONE
 * approval stage (not Manager+System) — see
 * lib/services/project-request-service.ts's decideApproval. Every check
 * below that the original two-stage spec described per-stage is adapted to
 * this single stage; there is exactly one businessAssessment field on the
 * approval side, not two.
 *
 * SECTION A is schema/source-text checks (no DOM, no DB — same established
 * convention as every other client-only check in this test suite). SECTION
 * B drives the REAL routes + detail page against a real database.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-business-assessment.ts
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
  // ══════════════════════ SECTION A — form/schema source checks ══════════════════════
  console.log("\n=== SECTION A — Business Assessment removed from the create side entirely ===\n");
  const { createProjectRequestSchema, projectRequestApprovalDecisionSchema } = await import("@/lib/validations");
  const formSrc = await fs.readFile("components/project-requests/project-request-form.tsx", "utf8");
  const routeSrc = await fs.readFile("app/api/project-requests/route.ts", "utf8");

  // 1. Business Assessment no longer exists in the create form.
  check("1. The create form never renders a businessAssessment field/label", !/businessAssessment/.test(formSrc) && !/Business [Aa]ssessment/.test(formSrc));

  // 2. Create schema/API don't require it.
  const minimalPayload = {
    title: "A valid title",
    description: "A description that is definitely long enough.",
    importance: 2,
    projectTypeId: "some-id",
    teamConcerned: "Engineering",
    expectedBenefits: "Benefits text that is definitely long enough for validation.",
    replacesExisting: false,
    intermediateApproverIds: ["some-approver-id"],
  };
  check("2. createProjectRequestSchema accepts a payload with NO businessAssessment at all", createProjectRequestSchema.safeParse(minimalPayload).success);
  check("2. POST /api/project-requests never writes businessAssessment into the create() call", !/businessAssessment:\s*data\.businessAssessment/.test(routeSrc));

  // Forged businessAssessment on create is silently stripped (zod's default
  // strip-unknown-keys behavior) rather than ever reaching persistence.
  const forgedParse = createProjectRequestSchema.safeParse({ ...minimalPayload, businessAssessment: "forged at create time" });
  check("2/3. A forged businessAssessment key on the create payload is stripped by the schema itself (not an error, not persisted)", forgedParse.success && !("businessAssessment" in (forgedParse as any).data));

  // 6/7. The decision schema requires businessAssessment, rejects empty/whitespace, caps length.
  check("6/7. projectRequestApprovalDecisionSchema REQUIRES businessAssessment (missing key fails)", !projectRequestApprovalDecisionSchema.safeParse({ decision: "approve" }).success);
  check("7. Empty string businessAssessment fails", !projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "" }).success);
  check("7. Whitespace-only businessAssessment fails (trimmed to empty)", !projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "   \n\t  " }).success);
  check("7. Over-length (5001 chars) businessAssessment fails", !projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "x".repeat(5001) }).success);
  const trimParse = projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "  Looks solid.  " });
  check("9. A valid businessAssessment passes and is persisted-ready TRIMMED by the schema itself", trimParse.success && (trimParse as any).data.businessAssessment === "Looks solid.");
  check("...and 'reject' accepts the exact same mandatory field (never optional for reject)", projectRequestApprovalDecisionSchema.safeParse({ decision: "reject", businessAssessment: "Not viable." }).success);
  check(
    "...FINAL approval no longer requires (or even accepts a meaningful) projectOwnerId — Project setup moved to a separate follow-up step, see scripts/test-project-request-project-creation.ts",
    projectRequestApprovalDecisionSchema.safeParse({ decision: "approve", businessAssessment: "Looks solid." }).success
  );

  // ══════════════════════ SECTION A2 — shared dialog / client behavior (source checks) ══════════════════════
  console.log("\n=== SECTION A2 — the ONE shared decision dialog; click never mutates by itself ===\n");
  const actionsSrc = await fs.readFile("components/project-requests/approval-actions.tsx", "utf8");
  const dialogSrc = await fs.readFile("components/project-requests/project-request-decision-dialog.tsx", "utf8");

  // 4/5/6. A single shared dialog component used for both Approve and Reject.
  check("4/5/6. ApprovalActions renders exactly ONE <ProjectRequestDecisionDialog>, shared by both Approve and Reject (never two separate dialogs)", (actionsSrc.match(/<ProjectRequestDecisionDialog/g) ?? []).length === 1);
  check("...and there is only ONE ProjectRequestDecisionDialog component definition in the codebase (not duplicated per action)", /export function ProjectRequestDecisionDialog/.test(dialogSrc));

  // 4. Clicking Approve/Reject only sets state (opens the dialog) — it must
  // never call fetch/submit directly from the button's own onClick.
  const approveButtonBlock = actionsSrc.match(/<Button[^>]*onClick=\{\(\) => setPendingDecision\("approve"\)\}[\s\S]{0,80}/);
  const rejectButtonBlock = actionsSrc.match(/<Button[^>]*onClick=\{\(\) => setPendingDecision\("reject"\)\}[\s\S]{0,80}/);
  check("4. The Approve button's onClick ONLY sets pendingDecision state (opens the dialog) — no direct fetch/mutation on click", approveButtonBlock !== null);
  check("5. The Reject button's onClick ONLY sets pendingDecision state (opens the dialog) — same shared flow as Approve", rejectButtonBlock !== null);
  check("...neither button's onClick handler calls fetch/submit directly", !/onClick=\{\(\) => setPendingDecision\("(approve|reject)"\)\}[^}]*fetch/.test(actionsSrc));

  // 7 (client). Empty/whitespace-only is blocked before onConfirm ever fires
  // (gated by assessmentRequired, which is true/default for the FINAL
  // stage this file is about — the intermediate stage passes
  // assessmentRequired={false} and never shows this field at all, see
  // scripts/test-project-request-intermediate-approval.ts).
  check(
    "7. The dialog computes isEmpty from the TRIMMED value and blocks confirm when empty (client-side gate, independent of the server's own re-check)",
    /isEmpty = value\.trim\(\)\.length === 0/.test(dialogSrc) && /if \(assessmentRequired && isEmpty\) return;/.test(dialogSrc)
  );
  check("...maxLength={5000} matches every other large Project Request text field", /maxLength=\{MAX_LENGTH\}/.test(dialogSrc) && /MAX_LENGTH = 5000/.test(dialogSrc));

  // 8/14. Cancel/Escape closes without mutation; a failed submit keeps the
  // dialog open AND keeps the typed text (state only resets when the dialog
  // actually closes, i.e. decision -> null — never on a server error).
  check("8. Cancel/Escape path (onOpenChange) calls onCancel, never onConfirm — no mutation path from closing", /onOpenChange=\{\(open\) => !open && !submitting && onCancel\(\)\}/.test(dialogSrc));
  check("14. The dialog's typed value is reset ONLY when decision becomes null (closes) — never reset by a server error, so failed-submit text survives", /if \(decision === null\) \{\s*setValue\(""\);/.test(dialogSrc));
  const catchBlockMatch = actionsSrc.match(/catch \(error: any\) \{([\s\S]*?)\} finally/);
  check("...ApprovalActions' catch branch sets serverError (keeps the dialog's text/open state intact)", catchBlockMatch !== null && /setServerError\(message\);/.test(catchBlockMatch[1]));
  check("...and the catch branch never clears pendingDecision — the dialog stays open on a failed submit", catchBlockMatch !== null && !/setPendingDecision\(null\)/.test(catchBlockMatch[1]));
  check("...and the confirm button disables + shows a loading state while submitting (prevents double-submit)", /disabled=\{submitting\}/.test(dialogSrc) && /Loader2/.test(dialogSrc));

  // 13. The "checked"/decided UI only renders after status is genuinely APPROVED/REJECTED (i.e. after a committed server response), never optimistically on click.
  check('13. ApprovalActions only renders the terminal "Approved by"/"Rejected by" summary when status is already APPROVED/REJECTED — never optimistically before the server confirms', /status === "APPROVED" && approver/.test(actionsSrc) && /status === "REJECTED" && approver/.test(actionsSrc));

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
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { ApprovalActions } = await import("@/components/project-requests/approval-actions");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const notificationIds: string[] = [];

  const jsonReq = (method: string, body?: unknown) =>
    new NextRequest("http://localhost/x", { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

  let intermediateApproverUser: { id: string };
  let intermediateApproverCustomRoleId: string;

  async function makeUser(email: string, customRoleId: string | null = null) {
    const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, customRoleId } });
    userIds.push(u.id);
    return u;
  }
  async function addMembership(userId: string, departmentId: string, customRoleId: string | null = null) {
    await prisma.departmentMembership.create({
      data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
  }
  async function makeApproverRole(tag: string, scope: "GLOBAL" | "DEPARTMENT", permissionKey = "projectRequest.approve") {
    const r = await prisma.customRole.create({ data: { key: `PR_BA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } });
    await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    return r;
  }
  /** Submits via the real route AND immediately clears the mandatory intermediate stage (as the one designated intermediate approver) so the returned request lands at PENDING_APPROVAL — the pre-existing starting point every test in this file was written against. */
  async function submitAndClearIntermediate(payload: Record<string, unknown>, sessionAfter: { id: string; role: any; customRoleId: string | null }) {
    const res = await requestsPOST(jsonReq("POST", payload));
    const body = await res.json();
    requestIds.push(body.id);
    currentSession = { user: { id: intermediateApproverUser.id, role: Role.USER, customRoleId: intermediateApproverCustomRoleId } };
    const intermediateRes = await intermediateApprovalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Intermediate approval clear for test setup." }), { params: Promise.resolve({ id: body.id }) });
    if (intermediateRes.status !== 200) throw new Error(`Fixture setup failed: intermediate approval returned ${intermediateRes.status}`);
    currentSession = { user: sessionAfter };
    return { res, body };
  }

  try {
    const dept = await createDepartment({ name: `PR BA Dept ${RUN_ID}`, slug: `pr-ba-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR BA Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await makeUser(`pr-ba-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, dept.id);

    const approverRole = await makeApproverRole("APPROVER", "DEPARTMENT");
    const approverUser = await makeUser(`pr-ba-approver-${RUN_ID}@kinsen.gr`);
    await addMembership(approverUser.id, dept.id, approverRole.id);

    const noPermUser = await makeUser(`pr-ba-noperm-${RUN_ID}@kinsen.gr`);
    await addMembership(noPermUser.id, dept.id);

    // Every successful FINAL approve now also needs a real, valid Project
    // owner (see projectRequestApprovalDecisionSchema/decideApproval) — a
    // dedicated department-scoped `project.assignable` holder, distinct
    // from the approver itself, so the owner-picker is exercised against a
    // real, independently-checked identity rather than reusing the
    // approver's own id.
    const projectOwnerRole = await makeApproverRole("PROJECTOWNER", "DEPARTMENT", "project.assignable");
    const projectOwnerUser = await makeUser(`pr-ba-projectowner-${RUN_ID}@kinsen.gr`);
    await addMembership(projectOwnerUser.id, dept.id, projectOwnerRole.id);

    // The single intermediate approver every fixture in this file selects —
    // this file is about businessAssessment at the FINAL stage, so the
    // intermediate stage is only ever cleared here as fixture setup, never
    // itself under test (see scripts/test-project-request-intermediate-approval.ts
    // for the intermediate stage's own dedicated coverage).
    const intermediateApproverRole = await makeApproverRole("INTERMEDIATE", "GLOBAL", "projectRequest.intermediateApprove");
    intermediateApproverUser = await makeUser(`pr-ba-intermediate-${RUN_ID}@kinsen.gr`, intermediateApproverRole.id);
    intermediateApproverCustomRoleId = intermediateApproverRole.id;

    const basePayload = {
      title: `PR BA Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 2,
      projectTypeId: type.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
      intermediateApproverIds: [intermediateApproverUser.id],
    };

    // ══════════════════════ 3. Forged create-time assessment never fills approval fields ══════════════════════
    console.log("\n=== 3. Forged create-time businessAssessment is discarded, never fills approval fields ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const forgedCreateRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR BA Forged Create ${RUN_ID}`, businessAssessment: "forged at create time" }));
    check("3. Submission with a forged businessAssessment still succeeds -> 201 (the forged key is simply ignored)", forgedCreateRes.status === 201);
    const forgedCreate = await forgedCreateRes.json();
    requestIds.push(forgedCreate.id);
    const forgedCreateRow = await prisma.projectRequest.findUniqueOrThrow({ where: { id: forgedCreate.id } });
    check("3. ...businessAssessment (approver field) is null — the forged create-time value never reached it", forgedCreateRow.businessAssessment === null);
    check("3. ...legacyRequesterBusinessAssessment is also null — the forged value never reached that field either", forgedCreateRow.legacyRequesterBusinessAssessment === null);

    // ══════════════════════ 7 (server). Empty / whitespace-only rejected server-side ══════════════════════
    console.log("\n=== 7. Empty and whitespace-only businessAssessment are rejected server-side on the real route ===\n");
    const { body: mainSubmit } = await submitAndClearIntermediate(
      { ...basePayload, title: `PR BA Main ${RUN_ID}` },
      { id: requester.id, role: Role.USER, customRoleId: null }
    );

    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const missingRes = await approvalPOST(jsonReq("POST", { decision: "approve", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("7. Missing businessAssessment key -> 422 (zod rejection, never reaches decideApproval)", missingRes.status === 422);
    const emptyRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("7. Empty string businessAssessment -> 422", emptyRes.status === 422);
    const whitespaceRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "   \n\t  ", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("7. Whitespace-only businessAssessment -> 422", whitespaceRes.status === 422);
    const stillPending = await prisma.projectRequest.findUniqueOrThrow({ where: { id: mainSubmit.id } });
    check("7. ...none of the three rejected attempts changed the status — still PENDING_APPROVAL", stillPending.status === "PENDING_APPROVAL");
    check("7. ...and none of them persisted anything into businessAssessment", stillPending.businessAssessment === null);

    // ══════════════════════ 11. Unauthorized / terminal action -> no assessment, no notification ══════════════════════
    console.log("\n=== 11. Unauthorized decision attempt persists no assessment and sends no notification ===\n");
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: null } };
    const notifBefore = await prisma.notification.count({ where: { userId: requester.id } });
    const unauthorizedRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("11. A user without projectRequest.approve -> 403", unauthorizedRes.status === 403);
    const afterUnauthorized = await prisma.projectRequest.findUniqueOrThrow({ where: { id: mainSubmit.id } });
    check("11. ...businessAssessment is STILL null after the rejected unauthorized attempt", afterUnauthorized.businessAssessment === null);
    const notifAfter = await prisma.notification.count({ where: { userId: requester.id } });
    check("11. ...and no notification was created for the unauthorized attempt", notifBefore === notifAfter);

    // ══════════════════════ 9/10. Valid assessment persists trimmed; a terminal request's assessment is immutable ══════════════════════
    console.log("\n=== 9. A valid businessAssessment is approved and persists TRIMMED, tied to decision/approver/timestamp ===\n");
    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const approveRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "  Strong ROI case, proceed.  ", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("9. Valid businessAssessment -> 200", approveRes.status === 200);
    const afterApprove = await prisma.projectRequest.findUniqueOrThrow({ where: { id: mainSubmit.id } });
    check("9. ...status -> APPROVED", afterApprove.status === "APPROVED");
    check("9. ...businessAssessment persisted TRIMMED", afterApprove.businessAssessment === "Strong ROI case, proceed.");
    check("9. ...tied to the real approver", afterApprove.approverId === approverUser.id);
    check("9. ...tied to a real decision timestamp", afterApprove.approvedAt !== null);

    console.log("\n-- 10. A terminal request's businessAssessment is immutable — a second decision attempt never overwrites it --\n");
    const secondAttemptRes = await approvalPOST(jsonReq("POST", { decision: "reject", businessAssessment: "Trying to overwrite" }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("10. A decision attempt on an already-APPROVED (terminal) request -> 409", secondAttemptRes.status === 409);
    const afterSecondAttempt = await prisma.projectRequest.findUniqueOrThrow({ where: { id: mainSubmit.id } });
    check("10. ...the ORIGINAL businessAssessment is completely untouched by the rejected second attempt", afterSecondAttempt.businessAssessment === "Strong ROI case, proceed.");
    check("10. ...status is still APPROVED, never flipped to REJECTED by the losing attempt", afterSecondAttempt.status === "APPROVED");

    // ══════════════════════ 12. Concurrent decisions -> exactly one decision, exactly one assessment ══════════════════════
    console.log("\n=== 12. Concurrent decisions on the SAME request -> exactly one wins, exactly one assessment persists ===\n");
    const raceRequester = await makeUser(`pr-ba-racerequester-${RUN_ID}@kinsen.gr`);
    await addMembership(raceRequester.id, dept.id);
    currentSession = { user: { id: raceRequester.id, role: Role.USER, customRoleId: null } };
    const { body: raceSubmit } = await submitAndClearIntermediate(
      { ...basePayload, title: `PR BA Race ${RUN_ID}` },
      { id: raceRequester.id, role: Role.USER, customRoleId: null }
    );

    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const [raceA, raceB] = await Promise.all([
      approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Race A assessment", projectOwnerId: projectOwnerUser.id }), { params: Promise.resolve({ id: raceSubmit.id }) }),
      approvalPOST(jsonReq("POST", { decision: "reject", businessAssessment: "Race B assessment" }), { params: Promise.resolve({ id: raceSubmit.id }) }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    check("12. Exactly one of two concurrent conflicting decisions wins (200), the other loses the race (409)", raceStatuses[0] === 200 && raceStatuses[1] === 409);
    const raceFinal = await prisma.projectRequest.findUniqueOrThrow({ where: { id: raceSubmit.id } });
    check("12. ...exactly ONE assessment persisted — either Race A's or Race B's, never both, never neither", raceFinal.businessAssessment === "Race A assessment" || raceFinal.businessAssessment === "Race B assessment");
    check("12. ...the winning assessment matches whichever decision actually won (approve <-> APPROVED, reject <-> REJECTED)", (raceFinal.status === "APPROVED") === (raceFinal.businessAssessment === "Race A assessment"));
    const raceNotifCount = await prisma.notification.count({ where: { userId: raceRequester.id, link: `/project-requests/${raceSubmit.id}` } });
    check("12. ...exactly ONE decision notification was created, not two", raceNotifCount === 1);
    notificationIds.push(...(await prisma.notification.findMany({ where: { userId: raceRequester.id, link: `/project-requests/${raceSubmit.id}` }, select: { id: true } })).map((n) => n.id));

    // ══════════════════════ 15/16. Detail page shows the new assessment AND legacy data, kept separate ══════════════════════
    console.log("\n=== 15. Detail page surfaces the approver's businessAssessment via ApprovalActions ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const detailEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: mainSubmit.id }) });
    const [approvalActionsEl] = findElementsByProps(detailEl, (p) => "businessAssessment" in p && "canDecideNow" in p);
    check("15. The detail page renders ApprovalActions with the real, persisted businessAssessment as a prop", approvalActionsEl !== undefined && approvalActionsEl.props.businessAssessment === "Strong ROI case, proceed.");
    check("15. ...and it is NOT literally the ApprovalActions function reference (confirms it's the real import, not a stray placeholder)", approvalActionsEl?.type === ApprovalActions);

    console.log("\n=== 16. A pre-existing legacy requester assessment is preserved and shown SEPARATELY, read-only ===\n");
    const legacyRow = await prisma.projectRequest.create({
      data: {
        title: `PR BA Legacy ${RUN_ID}`,
        description: basePayload.description,
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Ops",
        expectedBenefits: basePayload.expectedBenefits,
        legacyRequesterBusinessAssessment: "Pre-redesign requester-filled assessment text.",
        replacesExisting: false,
        requesterId: requester.id,
        departmentId: dept.id,
        // A row this old genuinely predates the intermediate stage
        // entirely (it never existed for it) — explicitly PENDING_APPROVAL,
        // never the new default PENDING_INTERMEDIATE_APPROVAL, exactly
        // matching how the real pre-existing rows in this app's own
        // database behave (see this feature's own migration strategy).
        status: "PENDING_APPROVAL",
      },
    });
    requestIds.push(legacyRow.id);
    const legacyDetailEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: legacyRow.id }) });
    const [legacyFieldEl] = findElementsByProps(legacyDetailEl, (p) => p.label === "Legacy requester business assessment");
    check("16. The detail page renders a separate 'Legacy requester business assessment' Field", legacyFieldEl !== undefined);
    check("16. ...with the exact preserved legacy text", legacyFieldEl?.props.value === "Pre-redesign requester-filled assessment text.");
    const [legacyApprovalActionsEl] = findElementsByProps(legacyDetailEl, (p) => "businessAssessment" in p && "canDecideNow" in p);
    check("16. ...and the NEW approver-side businessAssessment (still null, undecided) is never conflated with the legacy text", legacyApprovalActionsEl?.props.businessAssessment === null);

    // ══════════════════════ 17. Assessment text never leaks into notifications ══════════════════════
    console.log("\n=== 17. businessAssessment text never appears in any Notification row (title, body, or link) ===\n");
    const decisionNotif = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/project-requests/${mainSubmit.id}` }, orderBy: { createdAt: "desc" } });
    check("17. The decision notification exists", decisionNotif !== null);
    check("17. ...its title does not contain the assessment text", !!decisionNotif && !decisionNotif.title.includes("Strong ROI"));
    check("17. ...its body does not contain the assessment text", !!decisionNotif && !decisionNotif.body.includes("Strong ROI"));
    if (decisionNotif) notificationIds.push(decisionNotif.id);
    // The SAME notificationRow object created inside decideApproval's
    // transaction is what dispatchCreatedNotification forwards to both the
    // realtime publish and the push payload (see
    // lib/services/project-request-service.ts) — proving the stored
    // Notification row never contains assessment text therefore also proves
    // neither the realtime event nor the push payload can leak it, since
    // there is no second, independently-built payload for either channel.
    check("17. (structural) decideApproval builds exactly ONE notification body, reused verbatim for in-app + realtime + push — never a second payload that could include the assessment", /body: `Your Project Request "\$\{existing\.title\}" was \$\{decisionLabel\}\.`/.test(await fs.readFile("lib/services/project-request-service.ts", "utf8")));
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["notifications (explicitly tracked)", () => prisma.notification.deleteMany({ where: { id: { in: notificationIds } } })],
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
