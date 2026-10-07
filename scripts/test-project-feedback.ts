/**
 * Regression coverage for Project Feedback — the ORIGINAL Project Request
 * requester's one-time evaluation (1-10 satisfaction + optional comments)
 * of a delivered, request-origin Project.
 *
 * Covers: eligibility (manual vs request-origin, completed vs not, exact
 * requester identity never Project owner/final approver/ADMIN), input
 * validation, the structural one-row-per-Project uniqueness/race
 * guarantee, provenance (submittedByUserId always server-set, never
 * client-forgeable), the requester-facing Project detail UI's render-time
 * gating (Case A/B/C/D), and a quick confirmation that unrelated Project/
 * Activity behavior is unaffected.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-feedback.ts
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

/** Depth-first search for every React element of the given component type in a rendered element tree — same helper already established by scripts/test-nested-project-create-attachments.ts. */
function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

/** Depth-first collection of every plain string a rendered element tree contains — used to assert visible text without JSON.stringify (React elements have circular internal refs, e.g. type/_owner, that crash JSON.stringify). Visited-set guards against the same circularity. */
function extractText(node: any, out: string[] = [], seen = new Set<any>()): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (node == null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) extractText(c, out, seen);
  else if (children !== undefined) extractText(children, out, seen);
  return out;
}

const RUN_ID = Date.now();
const TAG = `pf-${RUN_ID}`;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { NextRequest } = await import("next/server");
  const jsonReq = (body?: unknown, method = "POST") =>
    new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });

  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const intermediateApprovalPOST = (await import("@/app/api/project-requests/[id]/intermediate-approval/route")).POST;
  const approvalPOST = (await import("@/app/api/project-requests/[id]/approval/route")).POST;
  const setupPOST = (await import("@/app/api/project-requests/[id]/project/route")).POST;
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const feedbackPOST = (await import("@/app/api/projects/[id]/feedback/route")).POST;
  const { projectFeedbackSchema } = await import("@/lib/validations");
  const { getProjectFeedbackEligibility } = await import("@/lib/services/project-feedback-service");
  const { default: ProjectDetailPage } = await import("@/app/(main)/projects/[id]/page");
  const { ProjectFeedbackCard } = await import("@/components/projects/project-feedback-card");

  const deptIds: string[] = [];
  const typeIds: string[] = [];
  const requestIds: string[] = [];
  const projectIds: string[] = [];
  const userIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    deptIds.push(dept.id);
    const reqType = await prisma.projectRequestType.create({ data: { name: `${TAG}-reqtype` } });
    typeIds.push(reqType.id);
    const expenseType = await prisma.projectExpenseType.create({ data: { name: `${TAG}-expensetype` } });

    async function makeUser(email: string) {
      const u = await prisma.user.create({ data: { email, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(u.id);
      return u;
    }
    async function makeRole(tag: string, permissionKeys: string[]) {
      const role = await prisma.customRole.create({ data: { key: `PF_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT", isActive: true } });
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

    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const requester = await makeUser(`${TAG}-requester@kinsen.gr`);
    await addMembership(requester.id, dept.id);

    const finalApproverRole = await makeRole("FINALAPPROVER", ["projectRequest.approve"]);
    const finalApprover = await makeUser(`${TAG}-finalapprover@kinsen.gr`);
    await addMembership(finalApprover.id, dept.id, finalApproverRole.id);

    const ownerRole = await makeRole("OWNER", ["project.assignable", "project.view"]);
    const ownerUser = await makeUser(`${TAG}-owner@kinsen.gr`);
    await addMembership(ownerUser.id, dept.id, ownerRole.id);

    /** Submits a PR, clears intermediate (as admin), final-approves (as finalApprover), then completes the request-origin Project setup (as finalApprover, owner = ownerUser) — returns the real Project id. */
    async function makeRequestOriginProject(tag: string): Promise<string> {
      currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
      const submitRes = await requestsPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "Project Feedback fixture — description long enough for validation.",
          importance: 2,
          projectTypeId: reqType.id,
          teamConcerned: "Engineering",
          expectedBenefits: "Benefits text long enough for validation.",
          replacesExisting: false,
          intermediateApproverIds: [adminUser.id],
        })
      );
      const submitted = await submitRes.json();
      requestIds.push(submitted.id);
      currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
      await intermediateApprovalPOST(jsonReq({ decision: "approve" }), { params: Promise.resolve({ id: submitted.id }) });
      currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
      await approvalPOST(jsonReq({ decision: "approve", businessAssessment: "fixture" }), { params: Promise.resolve({ id: submitted.id }) });
      const setupRes = await setupPOST(
        jsonReq({
          title: `${TAG} ${tag} request`,
          description: "fixture",
          ownerIds: [ownerUser.id],
          expectedStartDate: "2026-01-01",
          expectedFinishDate: "2026-01-05",
          expenseTypeId: expenseType.id,
        }),
        { params: Promise.resolve({ id: submitted.id }) }
      );
      if (setupRes.status !== 201) throw new Error(`Fixture setup failed: ${setupRes.status}: ${JSON.stringify(await setupRes.json())}`);
      const project = await setupRes.json();
      projectIds.push(project.id);
      return project.id;
    }

    async function completeProject(projectId: string) {
      currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
      const res = await projectsPATCH(jsonReq({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
      if (res.status !== 200) throw new Error(`Fixture completion failed: ${res.status}`);
    }

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: ownerUser.id } });
    projectIds.push(manualProject.id);

    // ══════════════════════ 1-4. ELIGIBILITY: target + timing ══════════════════════
    console.log("\n=== 1-4. Eligibility: manual vs request-origin, completed vs not ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const manualAttemptRes = await feedbackPOST(jsonReq({ satisfactionScore: 8 }), { params: Promise.resolve({ id: manualProject.id }) });
    check("1. Manual Project cannot receive Project Feedback -> 403 not_request_origin", manualAttemptRes.status === 403 && (await manualAttemptRes.json()).code === "not_request_origin");

    const proj1 = await makeRequestOriginProject("proj1");
    check("2. Request-origin Project CAN be a feedback target (confirmed once completed below)", true);

    // makeRequestOriginProject leaves currentSession as the final approver
    // (its own last step) — switch back to the real requester for every
    // feedback attempt below.
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const beforeCompletionRes = await feedbackPOST(jsonReq({ satisfactionScore: 8 }), { params: Promise.resolve({ id: proj1 }) });
    check("3. Non-completed request-origin Project cannot receive feedback -> 409 not_completed", beforeCompletionRes.status === 409 && (await beforeCompletionRes.json()).code === "not_completed");

    await completeProject(proj1);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const afterCompletionRes = await feedbackPOST(jsonReq({ satisfactionScore: 8, comments: "Great work overall." }), { params: Promise.resolve({ id: proj1 }) });
    check("4. Completed request-origin Project CAN receive feedback -> 201", afterCompletionRes.status === 201);
    const proj1Feedback = await afterCompletionRes.json();

    // ══════════════════════ 5-8. ELIGIBILITY: exact requester identity only ══════════════════════
    console.log("\n=== 5-8. Only the original requester — never owner/approver/ADMIN ===\n");
    const proj2 = await makeRequestOriginProject("proj2");
    await completeProject(proj2);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const ownerAttemptRes = await feedbackPOST(jsonReq({ satisfactionScore: 5 }), { params: Promise.resolve({ id: proj2 }) });
    check("6. Project Owner cannot submit unless also the requester -> 403 forbidden", ownerAttemptRes.status === 403 && (await ownerAttemptRes.json()).code === "forbidden");

    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const approverAttemptRes = await feedbackPOST(jsonReq({ satisfactionScore: 5 }), { params: Promise.resolve({ id: proj2 }) });
    check("7. Final approver cannot submit unless also the requester -> 403 forbidden", approverAttemptRes.status === 403 && (await approverAttemptRes.json()).code === "forbidden");

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const adminAttemptRes = await feedbackPOST(jsonReq({ satisfactionScore: 5 }), { params: Promise.resolve({ id: proj2 }) });
    check("8. ADMIN cannot impersonate the requester merely due to role/permissions -> 403 forbidden", adminAttemptRes.status === 403 && (await adminAttemptRes.json()).code === "forbidden");

    check("...zero ProjectFeedback rows created by any of the three forbidden attempts", (await prisma.projectFeedback.count({ where: { projectId: proj2 } })) === 0);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const requesterOkRes = await feedbackPOST(jsonReq({ satisfactionScore: 5 }), { params: Promise.resolve({ id: proj2 }) });
    check("5. The EXACT original requester -> 201, succeeds", requesterOkRes.status === 201);

    // ══════════════════════ 9-15. VALIDATION ══════════════════════
    console.log("\n=== 9-15. Rating 1-10 integer, Comments optional/bounded ===\n");
    check("9. Score 1 accepted by the schema", projectFeedbackSchema.safeParse({ satisfactionScore: 1 }).success);
    check("10. Score 10 accepted by the schema", projectFeedbackSchema.safeParse({ satisfactionScore: 10 }).success);
    check("11. Score 0 rejected", !projectFeedbackSchema.safeParse({ satisfactionScore: 0 }).success);
    check("12. Score 11 rejected", !projectFeedbackSchema.safeParse({ satisfactionScore: 11 }).success);
    check("13. Decimal score rejected", !projectFeedbackSchema.safeParse({ satisfactionScore: 7.5 }).success);
    check("14. Comments optional — omitted entirely still validates", projectFeedbackSchema.safeParse({ satisfactionScore: 7 }).success);
    check("...and an empty string normalizes to undefined, not an empty string", projectFeedbackSchema.safeParse({ satisfactionScore: 7, comments: "" }).data?.comments === undefined);
    check("15. Oversized comments (2001 chars) rejected", !projectFeedbackSchema.safeParse({ satisfactionScore: 7, comments: "x".repeat(2001) }).success);
    check("...exactly 2000 chars accepted", projectFeedbackSchema.safeParse({ satisfactionScore: 7, comments: "x".repeat(2000) }).success);

    // Live round-trip for both rating boundaries, end to end through the real route.
    const proj3 = await makeRequestOriginProject("proj3-boundary-low");
    await completeProject(proj3);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const score1Res = await feedbackPOST(jsonReq({ satisfactionScore: 1 }), { params: Promise.resolve({ id: proj3 }) });
    check("9. (live) Score 1 accepted end-to-end -> 201", score1Res.status === 201 && (await score1Res.json()).satisfactionScore === 1);

    const proj4 = await makeRequestOriginProject("proj4-boundary-high");
    await completeProject(proj4);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const score10Res = await feedbackPOST(jsonReq({ satisfactionScore: 10 }), { params: Promise.resolve({ id: proj4 }) });
    check("10. (live) Score 10 accepted end-to-end -> 201", score10Res.status === 201 && (await score10Res.json()).satisfactionScore === 10);

    const invalidScoreRes = await feedbackPOST(jsonReq({ satisfactionScore: 0 }), { params: Promise.resolve({ id: proj4 }) });
    check("11. (live) Score 0 rejected end-to-end -> 422", invalidScoreRes.status === 422);

    // ══════════════════════ 16-18. UNIQUENESS / RACE SAFETY ══════════════════════
    console.log("\n=== 16-18. At most one Feedback row per Project — ever ===\n");
    check("16. First submission on proj1 succeeded earlier (check 4) -> exactly 1 row", (await prisma.projectFeedback.count({ where: { projectId: proj1 } })) === 1);

    const secondAttemptRes = await feedbackPOST(jsonReq({ satisfactionScore: 3, comments: "Different answer, should be ignored" }), { params: Promise.resolve({ id: proj1 }) });
    check("17. A second feedback submission for the SAME Project -> 200 (not 201), resolves to the EXISTING row", secondAttemptRes.status === 200);
    const secondAttemptBody = await secondAttemptRes.json();
    check("...same id, same original score (5->8 from check 4, never overwritten to 3)", secondAttemptBody.id === proj1Feedback.id && secondAttemptBody.satisfactionScore === proj1Feedback.satisfactionScore);
    check("...still exactly ONE row for proj1 — never a second", (await prisma.projectFeedback.count({ where: { projectId: proj1 } })) === 1);

    const proj5 = await makeRequestOriginProject("proj5-race");
    await completeProject(proj5);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const [raceA, raceB] = await Promise.all([
      feedbackPOST(jsonReq({ satisfactionScore: 6 }), { params: Promise.resolve({ id: proj5 }) }),
      feedbackPOST(jsonReq({ satisfactionScore: 9 }), { params: Promise.resolve({ id: proj5 }) }),
    ]);
    check("18. Two concurrent submissions for the same Project both resolve (<300), never one hard-crashing the other", raceA.status < 300 && raceB.status < 300);
    check("...exactly ONE row exists for the race Project — never two", (await prisma.projectFeedback.count({ where: { projectId: proj5 } })) === 1);

    // ══════════════════════ 19-21. PROVENANCE ══════════════════════
    console.log("\n=== 19-21. submittedByUserId always server-set; Project Request relation determines the requester ===\n");
    const proj1Row = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj1 } });
    check("19. submittedByUserId on the real DB row is the authenticated requester's own id", proj1Row.submittedByUserId === requester.id);

    const proj6 = await makeRequestOriginProject("proj6-forged-id");
    await completeProject(proj6);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const forgedIdRes = await feedbackPOST(jsonReq({ satisfactionScore: 7, submittedByUserId: adminUser.id } as any), { params: Promise.resolve({ id: proj6 }) });
    check("20. A forged submittedByUserId in the body is silently ignored (not even a schema field) -> still 201", forgedIdRes.status === 201);
    const proj6Row = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj6 } });
    check("...the REAL stored submittedByUserId is still the authenticated requester, never the forged adminUser.id", proj6Row.submittedByUserId === requester.id && proj6Row.submittedByUserId !== adminUser.id);

    const eligibilityForRequester = await getProjectFeedbackEligibility(proj6, requester.id);
    const eligibilityForAdmin = await getProjectFeedbackEligibility(proj6, adminUser.id);
    check("21. getProjectFeedbackEligibility resolves isOriginalRequester from the ProjectRequest.requesterId relation — true for the real requester", eligibilityForRequester.isOriginalRequester === true);
    check("...false for ADMIN, despite ADMIN's own blanket permission bypass elsewhere in this app", eligibilityForAdmin.isOriginalRequester === false);

    // ══════════════════════ 22-25/27. UI render-time gating (Case A/B/C/D) ══════════════════════
    console.log("\n=== 22-25/27. Project detail page: Feedback card only for the eligible requester, after completion ===\n");
    const proj7 = await makeRequestOriginProject("proj7-ui");

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const caseANotCompletedEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj7 }) } as any);
    check("23. Case A — not yet completed: no Feedback card at all (not even a disabled placeholder)", findElementsByType(caseANotCompletedEl, ProjectFeedbackCard).length === 0);

    await completeProject(proj7);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const caseBCompletedNoFeedbackEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj7 }) } as any);
    const caseBCards = findElementsByType(caseBCompletedNoFeedbackEl, ProjectFeedbackCard);
    check("22. Case B — completed, requester, no feedback yet: Feedback card renders", caseBCards.length === 1);
    check("...with initialFeedback null (the submission form, not a readonly result)", caseBCards[0]?.props.initialFeedback === null);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    await feedbackPOST(jsonReq({ satisfactionScore: 8, comments: "UI test comment" }), { params: Promise.resolve({ id: proj7 }) });
    const caseCWithFeedbackEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj7 }) } as any);
    const caseCCards = findElementsByType(caseCWithFeedbackEl, ProjectFeedbackCard);
    check("27. Case C — feedback now exists: card still renders, this time with the real submitted data as initialFeedback", caseCCards.length === 1 && caseCCards[0]?.props.initialFeedback?.satisfactionScore === 8 && caseCCards[0]?.props.initialFeedback?.comments === "UI test comment");

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const caseDNotRequesterEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj7 }) } as any);
    check("24. Case D — a non-requester (even ADMIN) viewing the SAME completed Project with feedback already submitted -> no requester Feedback card at all", findElementsByType(caseDNotRequesterEl, ProjectFeedbackCard).length === 0);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const manualProjectEl = await ProjectDetailPage({ params: Promise.resolve({ id: manualProject.id }) } as any);
    check("25. A manual Project NEVER renders the Feedback card, regardless of who's viewing or what status it's in", findElementsByType(manualProjectEl, ProjectFeedbackCard).length === 0);

    // ══════════════════════ 28-32. ADMIN permission + readonly review ══════════════════════
    console.log("\n=== 28-32. Administration -> Feedback: permission-gated, readonly ===\n");
    const { getNavVisibilityFlags } = await import("@/lib/services/department-scope-service");
    const { default: ProjectFeedbackAdminPage } = await import("@/app/(main)/admin/project-feedback/page");

    const feedbackViewerRole = await makeRole("FEEDBACKVIEWER", []);
    // GLOBAL-only permission — granted via a GLOBAL-scope custom role, not
    // a department membership (projectFeedback.view is in
    // GLOBAL_ONLY_PERMISSION_KEYS; a department-scoped grant would never
    // apply to it even if one were attempted).
    await prisma.customRole.update({ where: { id: feedbackViewerRole.id }, data: { scope: "GLOBAL" } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectFeedback.view" } });
    await prisma.rolePermission.create({ data: { roleKey: feedbackViewerRole.key, permissionId: perm.id } });
    const feedbackViewer = await makeUser(`${TAG}-feedbackviewer@kinsen.gr`);

    const viewerFlags = await getNavVisibilityFlags(feedbackViewer.id, Role.USER, feedbackViewerRole.id);
    check("28. A user granted projectFeedback.view (via a GLOBAL custom role) sees canViewProjectFeedback=true -> the Administration -> Feedback sidebar entry", viewerFlags.canViewProjectFeedback === true);

    const noPermFlags = await getNavVisibilityFlags(requester.id, Role.USER, null);
    check("29. A plain user without the permission does NOT see it", noPermFlags.canViewProjectFeedback === false);

    currentSession = { user: { id: feedbackViewer.id, role: Role.USER, customRoleId: feedbackViewerRole.id } };
    const authorizedAdminEl = await ProjectFeedbackAdminPage({ searchParams: Promise.resolve({}) } as any);
    check("30. Direct access to /admin/project-feedback with the permission -> renders (no redirect thrown)", authorizedAdminEl !== undefined);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    let deniedRedirectTarget: string | null = null;
    try {
      await ProjectFeedbackAdminPage({ searchParams: Promise.resolve({}) } as any);
    } catch (err: any) {
      deniedRedirectTarget = String(err?.digest ?? "").split(";")[2] ?? null;
    }
    check("30. Direct access WITHOUT the permission -> redirected away (/dashboard), never rendered", deniedRedirectTarget === "/dashboard");

    // 31/32: render the authorized page's own element tree and confirm the
    // real submitted row's data appears somewhere in it, with no
    // edit/delete affordance anywhere (the ONLY interactive controls on
    // this page are the two plain filter <select>s and the "Filter"
    // button — never a mutation).
    const adminPageText = extractText(authorizedAdminEl).join("");
    check("31. Admin list includes the real Project title", adminPageText.includes(`${TAG} proj1 request`));
    check("...the real requester's email", adminPageText.includes(requester.email ?? "__none__"));
    check("...the real submitted rating (8/10 for proj1, from check 4)", adminPageText.includes("8 / 10"));
    check("...and the real comments text", adminPageText.includes("Great work overall."));
    check("32. The admin page's own source never references an edit/delete mutation for feedback — review-only by construction", !/DELETE|PATCH\s*\(/.test(await (await import("fs/promises")).readFile("app/(main)/admin/project-feedback/page.tsx", "utf8")));

    // ══════════════════════ 33-36. REGRESSIONS ══════════════════════
    console.log("\n=== 33-36. Unrelated behavior unaffected ===\n");
    check("33. Project completion (PATCH status) still works exactly as before — every completeProject() call above succeeded", true);
    check("34. Project Request approval/create flow unchanged — every makeRequestOriginProject() call above (the real, unmodified flow) succeeded", true);
    const manualProjectGetCheck = await prisma.project.findUniqueOrThrow({ where: { id: manualProject.id } });
    check("36. A manual Project's own row is untouched by any of this — no feedback relation populated, no new required field", manualProjectGetCheck.projectRequestId === null);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectFeedback.deleteMany({ where: { projectId: { in: projectIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): feedback", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): projects", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.notification.deleteMany({ where: { link: { in: requestIds.map((id) => `/project-requests/${id}`) } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.projectRequestType.deleteMany({ where: { id: { in: typeIds } } });
      await prisma.projectExpenseType.deleteMany({ where: { name: `${TAG}-expensetype` } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): project requests", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): users/roles", err instanceof Error ? err.message : err);
    }
    try {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup step failed (non-fatal): departments", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
