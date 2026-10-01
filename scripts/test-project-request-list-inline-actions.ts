/**
 * Regression coverage for moving Preview/Approve/Reject on Project Requests
 * INTO the `/project-requests` list itself — same UX pattern as the Pending
 * Tickets list (components/tickets/pending-ticket-table.tsx): a Preview
 * dialog over data already loaded by the list query (no per-row fetch), and
 * Approve/Reject that reuse the SAME shared ProjectRequestDecisionDialog +
 * the SAME POST /api/project-requests/[id]/approval endpoint the detail
 * page's ApprovalActions already used — never a second/independent
 * approval modal or a duplicated copy of the decision logic.
 *
 * The detail route (/project-requests/[id]) and its own authorization are
 * UNCHANGED — this feature only adds an additional, faster path to the SAME
 * underlying data/actions, never a replacement that weakens anything.
 *
 * SECTION A is source-text/structural checks on the new
 * components/project-requests/project-request-table.tsx (no DOM renderer in
 * this suite — same established convention as every other client-only
 * check in this test suite: no router.push/replace, no per-row fetch, the
 * ONE shared decision dialog, double-click guarding, non-sortable Actions
 * column). SECTION B drives the REAL list page + approval route against a
 * real database.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-list-inline-actions.ts
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
  // ══════════════════════ SECTION A — structural checks on the new list table ══════════════════════
  console.log("\n=== SECTION A — Actions column, Preview, shared dialog reuse, no-redirect guarantees ===\n");
  const tableSrc = await fs.readFile("components/project-requests/project-request-table.tsx", "utf8");
  const pageSrc = await fs.readFile("app/(main)/project-requests/page.tsx", "utf8");

  // 1. Actions column exists, non-sortable (no sort handler/affordance on its header).
  check("1. The table renders an 'Actions' column header", /<TableHead className="text-right">Actions<\/TableHead>/.test(tableSrc));
  check("1. ...the Actions header has no onClick/sort handler — it's a plain, non-interactive header cell", !/<TableHead className="text-right"[^>]*onClick/.test(tableSrc));

  // 3. Preview opens a local-state dialog, never a Link/navigation.
  check("3. The row Preview button sets local dialog state (setPreviewTarget), not a navigation", /onClick=\{\(\) => setPreviewTarget\(r\)\}/.test(tableSrc));
  check("3. The Title button ALSO opens the same Preview dialog, not a <Link> to the detail page", /onClick=\{\(\) => setPreviewTarget\(r\)\}[\s\S]{0,40}className="text-sm font-medium truncate hover:text-primary hover:underline/.test(tableSrc));
  check("3. ...the table never renders an <a>/<Link> pointing at /project-requests/<id> (no forced navigation anywhere in the list rows)", !/href=\{?`?\/project-requests\/\$\{/.test(tableSrc));

  // 5/9. Approve/Reject reuse the ONE shared decision dialog — never a second modal.
  check("5/9. Exactly ONE <ProjectRequestDecisionDialog> is rendered by the list table (shared for both Approve and Reject, row AND preview entry points)", (tableSrc.match(/<ProjectRequestDecisionDialog/g) ?? []).length === 1);
  check("...row Approve/Reject and Preview's Approve/Reject both call the SAME openDecision() opener — never a separate code path", (tableSrc.match(/openDecision\(/g) ?? []).length >= 4);
  check("...the list never imports/defines a second decision-dialog component", !/function \w*DecisionDialog/.test(tableSrc.replace(/ProjectRequestDecisionDialog/g, "")));

  // 6/11/17. No redirect/URL change on success — only router.refresh().
  check("6/17. The table NEVER calls router.push/router.replace/window.location (no redirect, no URL change, no navigation overlay trigger)", !/router\.push|router\.replace|window\.location/.test(tableSrc));
  check("6/11. On success, router.refresh() is the ONLY state-sync mechanism used (same authoritative-refresh pattern as the detail page's ApprovalActions)", (tableSrc.match(/router\.refresh\(\)/g) ?? []).length >= 2);

  // 8. Conflict (409) handled distinctly — closes cleanly, refreshes, never a false success.
  check("8. A 409 response is handled distinctly from other errors — closes the dialog and refreshes rather than retrying a call that can only fail again", /res\.status === 409/.test(tableSrc) && /setDecisionTarget\(null\);\s*\n\s*router\.refresh\(\);\s*\n\s*return;/.test(tableSrc));
  check("8. ...a 409 never shows a success toast (it's handled in its own branch, before the success toast.success call)", /if \(res\.status === 409\) \{[\s\S]*?toast\.error\([\s\S]*?\}\s*\n\s*throw/.test(tableSrc));

  // 10/14. Cancel never mutates; failed submit keeps the dialog's target (and thus its typed text) intact.
  check("10. cancelDecision only clears local state — it never calls fetch", /const cancelDecision = \(\) => \{\s*setDecisionTarget\(null\);\s*setServerError\(null\);\s*\};/.test(tableSrc));
  const catchBlockMatch = tableSrc.match(/catch \(error: any\) \{([\s\S]*?)\} finally/);
  check("14. The catch branch never clears decisionTarget on a failed submit — the dialog (and its typed assessment) stays open", catchBlockMatch !== null && !/setDecisionTarget\(null\)/.test(catchBlockMatch[1]));

  // 13. Double-click/concurrent-click guard — the SPECIFIC row's buttons disable while it's processing, not every row.
  check("13. Row Approve/Reject buttons are disabled via a PER-ROW busy flag (decisionTarget.row.id === r.id), never a single global disable that would freeze every row", /const rowBusy = submitting && decisionTarget\?\.row\.id === r\.id;/.test(tableSrc) && (tableSrc.match(/disabled=\{rowBusy\}/g) ?? []).length === 2);

  // 16. No per-row/N+1 fetch — the table's only network call is the approval POST; Preview reads already-loaded props.
  const fetchCalls = tableSrc.match(/fetch\(/g) ?? [];
  check("16. The table makes exactly ONE kind of network call (the approval POST) — Preview never triggers a fetch of its own", fetchCalls.length === 1 && /fetch\(`\/api\/project-requests\/\$\{row\.id\}\/approval`/.test(tableSrc));
  let previewRouteExists = true;
  try {
    await fs.access("app/api/project-requests/[id]/preview");
  } catch {
    previewRouteExists = false;
  }
  check("16. ...no new per-request 'preview' API route was added — Preview is purely a client-side dialog over already-fetched list data", !previewRouteExists);

  // 7. The page computes canDecideNow from ONE already-resolved scope — never a per-row permission query.
  check("7. The page computes canDecideNow from the SAME scope object already resolved once for the where-clause — not a second per-row lookup", /scope\.hasGlobalApprove \|\| scope\.approveDepartmentIds\.includes\(r\.departmentId\)/.test(pageSrc));
  check("...and it maps over the already-fetched `requests` array in plain JS — no additional Prisma query inside the map", /requests\.map\(\(r\) => \(\{[\s\S]{0,600}canDecideNow:/.test(pageSrc));

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
  const { default: ProjectRequestsPage } = await import("@/app/(main)/project-requests/page");
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");
  const { ProjectRequestTable } = await import("@/components/project-requests/project-request-table");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const typeIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const notificationIds: string[] = [];

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
  async function makeApproverRole(tag: string, scope: "GLOBAL" | "DEPARTMENT") {
    const r = await prisma.customRole.create({ data: { key: `PR_LIST_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: scope as any, isActive: true } });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectRequest.approve" } });
    await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    return r;
  }

  async function getTableRows(searchParams: Record<string, string>): Promise<any[]> {
    const pageEl = await ProjectRequestsPage({ searchParams: Promise.resolve(searchParams) });
    const [tableEl] = findElementsByProps(pageEl, (p) => Array.isArray(p.requests) && "emptyMessage" in p);
    return tableEl?.props.requests ?? [];
  }

  try {
    const dept = await createDepartment({ name: `PR List Dept ${RUN_ID}`, slug: `pr-list-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const otherDept = await createDepartment({ name: `PR List Other Dept ${RUN_ID}`, slug: `pr-list-other-dept-${RUN_ID}` });
    deptIds.push(otherDept.id);
    const type = await prisma.projectRequestType.create({ data: { name: `PR List Type ${RUN_ID}` } });
    typeIds.push(type.id);

    const requester = await makeUser(`pr-list-requester-${RUN_ID}@kinsen.gr`);
    await addMembership(requester.id, dept.id);

    const approverRole = await makeApproverRole("APPROVER", "DEPARTMENT");
    const approverUser = await makeUser(`pr-list-approver-${RUN_ID}@kinsen.gr`);
    await addMembership(approverUser.id, dept.id, approverRole.id);

    const otherDeptApproverRole = await makeApproverRole("OTHER", "DEPARTMENT");
    const otherDeptApproverUser = await makeUser(`pr-list-otherapprover-${RUN_ID}@kinsen.gr`);
    await addMembership(otherDeptApproverUser.id, otherDept.id, otherDeptApproverRole.id);

    const noPermUser = await makeUser(`pr-list-noperm-${RUN_ID}@kinsen.gr`);
    await addMembership(noPermUser.id, dept.id);

    const basePayload = {
      title: `PR List Request ${RUN_ID}`,
      description: "A description that is definitely long enough.",
      importance: 2,
      projectTypeId: type.id,
      teamConcerned: "Engineering",
      expectedBenefits: "Benefits text that is definitely long enough for validation.",
      replacesExisting: false,
    };

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const mainSubmitRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR List Main ${RUN_ID}` }));
    const mainSubmit = await mainSubmitRes.json();
    requestIds.push(mainSubmit.id);

    const withReplacementRes = await requestsPOST(
      jsonReq("POST", { ...basePayload, title: `PR List Replaces ${RUN_ID}`, replacesExisting: true, replacementDescription: "The legacy spreadsheet tracker." })
    );
    const withReplacement = await withReplacementRes.json();
    requestIds.push(withReplacement.id);

    // ══════════════════════ 7/8. canDecideNow is correctly gated by real authorization, per row ══════════════════════
    console.log("\n=== 7/8. canDecideNow on each row matches real authorization — never from ownership alone ===\n");
    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const awaitingRowsForApprover = await getTableRows({ tab: "awaiting" });
    const mainRowForApprover = awaitingRowsForApprover.find((r) => r.id === mainSubmit.id);
    check("7. An authorized in-scope approver sees canDecideNow=true on a PENDING_APPROVAL row in their department", mainRowForApprover?.canDecideNow === true);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const mineRowsForRequester = await getTableRows({ tab: "mine" });
    const mainRowForRequester = mineRowsForRequester.find((r) => r.id === mainSubmit.id);
    check("8. The requester (who holds NO approve permission) sees canDecideNow=false on their OWN 'My Requests' row — ownership alone never grants approval access", mainRowForRequester?.canDecideNow === false);

    currentSession = { user: { id: otherDeptApproverUser.id, role: Role.USER, customRoleId: null } };
    const awaitingRowsForOtherDeptApprover = await getTableRows({ tab: "awaiting" });
    check("8. An approver scoped to a DIFFERENT department sees the row excluded from their 'Awaiting My Approval' entirely (out of scope)", !awaitingRowsForOtherDeptApprover.some((r) => r.id === mainSubmit.id));

    // ══════════════════════ 2/4/5/6. Preview data: present for every row, complete, conditional fields correct ══════════════════════
    console.log("\n=== 2/4. Every row carries the FULL preview payload already (no per-row fetch needed) ===\n");
    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const awaitingRows = await getTableRows({ tab: "awaiting" });
    const mainRow = awaitingRows.find((r) => r.id === mainSubmit.id);
    check("2. The row for a real, visible request is present (Preview has data to show)", mainRow !== undefined);
    check(
      "4. The row carries every Preview-required field with REAL values straight from the list query — description/importance/teamConcerned/expectedBenefits/requester/submittedAt/status",
      mainRow?.description === basePayload.description &&
        mainRow?.importance === basePayload.importance &&
        mainRow?.teamConcerned === basePayload.teamConcerned &&
        mainRow?.expectedBenefits === basePayload.expectedBenefits &&
        mainRow?.requester?.email === requester.email &&
        mainRow?.status === "PENDING_APPROVAL" &&
        mainRow?.submittedAt instanceof Date
    );
    check("4. ...department and projectType names are present for display", mainRow?.department?.name === dept.name && mainRow?.projectType?.name === type.name);

    console.log("\n-- 5. replacementDescription present ONLY when replacesExisting is true --\n");
    const replacesRow = awaitingRows.find((r) => r.id === withReplacement.id);
    check("5. replacesExisting:false row has replacementDescription === null", mainRow?.replacesExisting === false && mainRow?.replacementDescription === null);
    check("5. replacesExisting:true row carries the real replacementDescription text", replacesRow?.replacesExisting === true && replacesRow?.replacementDescription === "The legacy spreadsheet tracker.");

    console.log("\n-- 6. legacy requester assessment and approval-time assessment are SEPARATE fields on the row --\n");
    const legacyRow = await prisma.projectRequest.create({
      data: {
        title: `PR List Legacy ${RUN_ID}`,
        description: basePayload.description,
        importance: 2,
        projectTypeId: type.id,
        teamConcerned: "Ops",
        expectedBenefits: basePayload.expectedBenefits,
        legacyRequesterBusinessAssessment: "Pre-redesign requester-filled text.",
        replacesExisting: false,
        requesterId: requester.id,
        departmentId: dept.id,
      },
    });
    requestIds.push(legacyRow.id);
    const awaitingRowsWithLegacy = await getTableRows({ tab: "awaiting" });
    const legacyRowProps = awaitingRowsWithLegacy.find((r) => r.id === legacyRow.id);
    check("6. The legacy row carries legacyRequesterBusinessAssessment", legacyRowProps?.legacyRequesterBusinessAssessment === "Pre-redesign requester-filled text.");
    check("6. ...and its (not-yet-decided) businessAssessment is a SEPARATE, still-null field — never conflated with the legacy text", legacyRowProps?.businessAssessment === null);

    // ══════════════════════ 9/11/12. Inline decision via the real approval endpoint; row moves tabs on refresh ══════════════════════
    console.log("\n=== 9/11/12. Approving inline moves the row from Awaiting -> History on the next (refresh) fetch ===\n");
    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const beforeAwaiting = await getTableRows({ tab: "awaiting" });
    check("12. Before the decision, the row IS in 'Awaiting My Approval'", beforeAwaiting.some((r) => r.id === mainSubmit.id));
    const beforeHistory = await getTableRows({ tab: "history" });
    check("12. ...and NOT yet in 'History'", !beforeHistory.some((r) => r.id === mainSubmit.id));

    const decideRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Looks solid, approve." }), { params: Promise.resolve({ id: mainSubmit.id }) });
    check("9. The SAME approval endpoint the list's inline Approve button posts to -> 200", decideRes.status === 200);

    // 11. "Success -> router.refresh(), same URL/tab" — proven at the data
    // layer: re-querying the EXACT SAME tab param (no URL change needed)
    // now reflects the decision, because router.refresh() just re-runs this
    // same server page for the current URL.
    const afterAwaiting = await getTableRows({ tab: "awaiting" });
    check("11/12. After the decision, a plain re-fetch of the SAME 'awaiting' URL no longer includes the row (moved out, no navigation needed)", !afterAwaiting.some((r) => r.id === mainSubmit.id));
    const afterHistory = await getTableRows({ tab: "history" });
    const decidedRow = afterHistory.find((r) => r.id === mainSubmit.id);
    check("12. ...and the SAME re-fetch of 'history' now includes it", decidedRow !== undefined);
    check("...with the real decision data attached (status/approver/assessment) for the Preview modal to show", decidedRow?.status === "APPROVED" && decidedRow?.approver?.email === approverUser.email && decidedRow?.businessAssessment === "Looks solid, approve.");
    check("...and its canDecideNow is now false (terminal — the row-level Approve/Reject buttons disappear on refresh)", decidedRow?.canDecideNow === false);

    // ══════════════════════ Regression: a GLOBAL approver's History tab shows EVERY decided request, not just their own submissions ══════════════════════
    // Caught by the browser smoke test for this feature: buildHistoryWhere
    // used `OR: [{requesterId}, {}]` for the hasGlobalApprove case — an
    // empty `{}` member inside a Prisma OR array is NOT "always true" (it's
    // effectively a no-op), which silently collapsed the whole OR down to
    // "only their own submissions" and hid every other department's
    // decided request from a global approver's History tab. Fixed to
    // return a plain, unconditional status filter for the global case
    // instead (same shape buildAwaitingMyApprovalWhere's own global branch
    // already uses).
    console.log("\n=== Regression: global-scope approver's History includes a decided request they did NOT submit, from a department they're not even in ===\n");
    const globalApproverRole = await makeApproverRole("GLOBALHIST", "GLOBAL");
    const globalApproverUser = await makeUser(`pr-list-globalapprover-${RUN_ID}@kinsen.gr`);
    // Deliberately NO DepartmentMembership at all for the global approver —
    // a GLOBAL-scope grant lives on the session's own customRoleId (what
    // hasPermission checks directly), never on a DepartmentMembership row
    // (that's what the DEPARTMENT-scope grants above use instead). This
    // also proves the row isn't merely reachable via some department-scoped
    // fallback.
    currentSession = { user: { id: globalApproverUser.id, role: Role.USER, customRoleId: globalApproverRole.id } };
    const globalApproverHistoryBefore = await getTableRows({ tab: "history" });
    // mainSubmit was already decided earlier (by a DIFFERENT, department-
    // scoped approver, in a department this global approver has no
    // membership in at all) — a global grant must surface it immediately,
    // with zero action of this user's own. This single assertion is the
    // direct proof of the fix: under the old buggy `OR: [{requesterId},{}]`
    // shape, this would have been false (empty History) even though
    // hasGlobalApprove was true.
    check(
      "The global approver's History ALREADY includes a request decided by someone else entirely, in a department they're not even a member of — proves the global grant genuinely works, not just department-scoped history",
      globalApproverHistoryBefore.some((r) => r.id === mainSubmit.id)
    );

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const historyRegressionSubmitRes = await requestsPOST(jsonReq("POST", { ...basePayload, title: `PR List History Regression ${RUN_ID}` }));
    const historyRegressionSubmit = await historyRegressionSubmitRes.json();
    requestIds.push(historyRegressionSubmit.id);

    currentSession = { user: { id: approverUser.id, role: Role.USER, customRoleId: null } };
    const decideRegressionRes = await approvalPOST(jsonReq("POST", { decision: "reject", businessAssessment: "Deferred for this cycle." }), { params: Promise.resolve({ id: historyRegressionSubmit.id }) });
    check("(fixture) Dept-A approver rejects a fresh request -> 200", decideRegressionRes.status === 200);

    currentSession = { user: { id: globalApproverUser.id, role: Role.USER, customRoleId: globalApproverRole.id } };
    const globalApproverHistoryAfter = await getTableRows({ tab: "history" });
    check(
      "The global approver's History now includes BOTH decided requests — the one approved earlier (different department) AND the one just rejected by someone else entirely — never limited to their own submissions",
      globalApproverHistoryAfter.some((r) => r.id === mainSubmit.id) && globalApproverHistoryAfter.some((r) => r.id === historyRegressionSubmit.id)
    );

    // ══════════════════════ 15. Forged action is rejected server-side, independent of what the UI showed ══════════════════════
    console.log("\n=== 15. A forged Approve from a user the list itself marks canDecideNow=false is independently rejected by the API ===\n");
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: null } };
    const noPermRows = await getTableRows({ tab: "mine" });
    void noPermRows; // noPermUser has no rows of their own; the real point is the forged API call below.
    const forgedRes = await approvalPOST(jsonReq("POST", { decision: "approve", businessAssessment: "Should never persist" }), { params: Promise.resolve({ id: withReplacement.id }) });
    check("15. A user with no projectRequest.approve -> 403, regardless of what any client claimed", forgedRes.status === 403);
    const stillPending = await prisma.projectRequest.findUniqueOrThrow({ where: { id: withReplacement.id } });
    check("15. ...status is untouched", stillPending.status === "PENDING_APPROVAL");
    check("15. ...businessAssessment was never persisted", stillPending.businessAssessment === null);

    // ══════════════════════ 18. The detail route still works, untouched ══════════════════════
    console.log("\n=== 18. The direct detail route (/project-requests/[id]) still renders normally — unchanged by this feature ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const detailEl = await ProjectRequestDetailPage({ params: Promise.resolve({ id: mainSubmit.id }) });
    check("18. The requester can still open the detail page for their own (now-decided) request directly", detailEl !== undefined);

    // Sanity: the exported component used by the list really is the one just audited above.
    check("(sanity) ProjectRequestTable is a real function export", typeof ProjectRequestTable === "function");
  } finally {
    console.log("\nCleaning up test data...\n");
    await runCleanup([
      ["notifications (by request link)", () => prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } })],
      ["notifications (explicitly tracked)", () => prisma.notification.deleteMany({ where: { id: { in: notificationIds } } })],
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
