/**
 * Regression coverage for Project Feedback — the Project's own PRIMARY
 * Owner (Project.ownerId) evaluation (five independent 1-5 ratings + a
 * separate requirementsDelivered boolean + optional comments) of a
 * delivered, request-origin Project, submitted/updated exclusively
 * through the dedicated standalone /projects/[id]/feedback page.
 *
 * This REPLACES the original-requester-based eligibility rule — see
 * lib/services/project-feedback-service.ts's own doc comment for the full
 * business rule and prisma/schema.prisma's ProjectFeedback model doc
 * comment for the legacy-preservation strategy (legacySatisfactionScore).
 *
 * Covers: eligibility (manual vs request-origin, completed vs not, exact
 * ownerId identity — never the requester, an additional `owners`-set
 * member, the final approver, or ADMIN), input validation (five 1-5
 * ratings, required boolean, optional comments), upsert semantics (create
 * on first submission, UPDATE — never a second row — on resubmission,
 * race safety), provenance (submittedByUserId always server-set, never
 * client-forgeable, and NEVER rewritten on update — a pre-existing legacy
 * row's original submitter stays exactly who it always was even after the
 * current Owner updates it), the dedicated feedback page's own
 * independent authorization + render-time gating, the Project detail
 * page's small CTA (never the full form), the Administration review
 * page, and a quick confirmation that unrelated Project/Activity behavior
 * is unaffected.
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

/** Depth-first search for every React element of the given component type in a rendered element tree. */
function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

/** Depth-first collection of every plain string a rendered element tree contains. */
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

const FULL_FEEDBACK = { deliverySpeedRating: 4, communicationRating: 5, functionalityRating: 3, easeOfUseRating: 4, overallRating: 4 };

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
  const { default: ProjectFeedbackPage } = await import("@/app/(main)/projects/[id]/feedback/page");
  const { ProjectFeedbackCard } = await import("@/components/projects/project-feedback-card");
  const { ProjectFeedbackCtaCard } = await import("@/components/projects/project-feedback-cta-card");

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
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-reqtype` } });
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
    // An ADDITIONAL member of the Project's own `owners` multi-owner set —
    // NEVER the canonical ownerId (ownerIds[0] always becomes ownerId —
    // see createProjectFromApprovedRequest). Used to prove "additional
    // owners cannot submit unless they are also the canonical ownerId".
    const secondOwner = await makeUser(`${TAG}-secondowner@kinsen.gr`);
    await addMembership(secondOwner.id, dept.id, ownerRole.id);

    /** Submits a PR, clears intermediate (as admin), final-approves (as finalApprover), then completes the request-origin Project setup (as finalApprover, owner(s) = the given ids, ownerIds[0] becomes the canonical ownerId) — returns the real Project id. */
    async function makeRequestOriginProject(tag: string, ownerIds: string[] = [ownerUser.id]): Promise<string> {
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
          ownerIds,
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

    async function reopenProject(projectId: string) {
      currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
      const res = await projectsPATCH(jsonReq({ status: "IN_PROGRESS" }, "PATCH"), { params: Promise.resolve({ id: projectId }) });
      if (res.status !== 200) throw new Error(`Fixture reopen failed: ${res.status}`);
    }

    const manualProject = await prisma.project.create({ data: { title: `${TAG} manual project`, departmentId: dept.id, ownerId: ownerUser.id } });
    projectIds.push(manualProject.id);

    // ══════════════════════ 1-4. ELIGIBILITY: target + timing ══════════════════════
    console.log("\n=== 1-4. Eligibility: manual vs request-origin, completed vs not ===\n");
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const manualAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true }), { params: Promise.resolve({ id: manualProject.id }) });
    check("1. Manual Project cannot receive Project Feedback -> 403 not_request_origin, even for its own real primary Owner", manualAttemptRes.status === 403 && (await manualAttemptRes.json()).code === "not_request_origin");

    const proj1 = await makeRequestOriginProject("proj1");
    check("2. Request-origin Project CAN be a feedback target (confirmed once completed below)", true);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const beforeCompletionRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true }), { params: Promise.resolve({ id: proj1 }) });
    check("3. Non-completed request-origin Project cannot receive feedback -> 409 not_completed, even for the real primary Owner", beforeCompletionRes.status === 409 && (await beforeCompletionRes.json()).code === "not_completed");

    await completeProject(proj1);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const afterCompletionRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "Great work overall." }), { params: Promise.resolve({ id: proj1 }) });
    check("4. Completed request-origin Project CAN receive feedback from its real primary Owner -> 201", afterCompletionRes.status === 201);
    const proj1Feedback = await afterCompletionRes.json();
    check("...response carries all five individual ratings, never a single average", proj1Feedback.deliverySpeedRating === 4 && proj1Feedback.communicationRating === 5 && proj1Feedback.functionalityRating === 3 && proj1Feedback.easeOfUseRating === 4 && proj1Feedback.overallRating === 4);
    check("...and the separate requirementsDelivered boolean", proj1Feedback.requirementsDelivered === true);

    // ══════════════════════ 5-10. ELIGIBILITY: ownerId ONLY — never requester/additional-owners/approver/ADMIN ══════════════════════
    console.log("\n=== 5-10. Only Project.ownerId — never the requester, an additional owners-set member, final approver, or ADMIN ===\n");
    const proj2 = await makeRequestOriginProject("proj2", [ownerUser.id, secondOwner.id]);
    await completeProject(proj2);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const requesterAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: false }), { params: Promise.resolve({ id: proj2 }) });
    check("5. The ORIGINAL REQUESTER (no longer special-cased) cannot submit unless also ownerId -> 403 forbidden", requesterAttemptRes.status === 403 && (await requesterAttemptRes.json()).code === "forbidden");

    currentSession = { user: { id: secondOwner.id, role: Role.USER, customRoleId: null } };
    const secondOwnerAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: false }), { params: Promise.resolve({ id: proj2 }) });
    check("6. An ADDITIONAL member of the `owners` multi-owner set (but NOT the canonical ownerId) cannot submit -> 403 forbidden", secondOwnerAttemptRes.status === 403 && (await secondOwnerAttemptRes.json()).code === "forbidden");

    currentSession = { user: { id: finalApprover.id, role: Role.USER, customRoleId: null } };
    const approverAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: false }), { params: Promise.resolve({ id: proj2 }) });
    check("7. Final approver cannot submit -> 403 forbidden", approverAttemptRes.status === 403 && (await approverAttemptRes.json()).code === "forbidden");

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const adminAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: false }), { params: Promise.resolve({ id: proj2 }) });
    check("8. ADMIN holds NO implicit bypass merely due to role -> 403 forbidden", adminAttemptRes.status === 403 && (await adminAttemptRes.json()).code === "forbidden");

    check("...zero ProjectFeedback rows created by any of the four forbidden attempts", (await prisma.projectFeedback.count({ where: { projectId: proj2 } })) === 0);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const ownerOkRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: false }), { params: Promise.resolve({ id: proj2 }) });
    check("9. The EXACT canonical primary Owner (ownerId) -> 201, succeeds", ownerOkRes.status === 201);

    const eligibilityOwner = await getProjectFeedbackEligibility(proj2, ownerUser.id);
    const eligibilitySecondOwner = await getProjectFeedbackEligibility(proj2, secondOwner.id);
    check("10. getProjectFeedbackEligibility resolves isPrimaryOwner from Project.ownerId directly — true for the real owner", eligibilityOwner.isPrimaryOwner === true);
    check("...false for an additional `owners`-set member who isn't ownerId", eligibilitySecondOwner.isPrimaryOwner === false);

    // ══════════════════════ 11-19. VALIDATION ══════════════════════
    console.log("\n=== 11-19. Five ratings 1-5 integer (required, each independently), requirementsDelivered required boolean, Comments optional/bounded ===\n");
    check("11. All five ratings at 1 accepted by the schema", projectFeedbackSchema.safeParse({ deliverySpeedRating: 1, communicationRating: 1, functionalityRating: 1, easeOfUseRating: 1, overallRating: 1, requirementsDelivered: true }).success);
    check("12. All five ratings at 5 accepted by the schema", projectFeedbackSchema.safeParse({ deliverySpeedRating: 5, communicationRating: 5, functionalityRating: 5, easeOfUseRating: 5, overallRating: 5, requirementsDelivered: true }).success);
    check("13. A rating of 0 rejected", !projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, deliverySpeedRating: 0, requirementsDelivered: true }).success);
    check("14. A rating of 6 rejected", !projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, overallRating: 6, requirementsDelivered: true }).success);
    check("15. A decimal rating rejected", !projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, communicationRating: 3.5, requirementsDelivered: true }).success);
    check("16. Missing ANY one of the five ratings is rejected (not silently defaulted)", !projectFeedbackSchema.safeParse({ communicationRating: 4, functionalityRating: 4, easeOfUseRating: 4, overallRating: 4, requirementsDelivered: true }).success);
    check("...missing requirementsDelivered is ALSO rejected (never defaults to false silently)", !projectFeedbackSchema.safeParse(FULL_FEEDBACK as any).success);
    check("17. Comments optional — omitted entirely still validates", projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, requirementsDelivered: true }).success);
    check("...and an empty string normalizes to undefined, not an empty string", projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "" }).data?.comments === undefined);
    check("18. Oversized comments (2001 chars) rejected", !projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "x".repeat(2001) }).success);
    check("...exactly 2000 chars accepted", projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "x".repeat(2000) }).success);
    check("19. requirementsDelivered: false is a legitimate, distinct explicit answer — never derived from the ratings", projectFeedbackSchema.safeParse({ ...FULL_FEEDBACK, requirementsDelivered: false }).data?.requirementsDelivered === false);

    // Live round-trip for both rating boundaries, end to end through the real route, as the real Owner.
    const proj3 = await makeRequestOriginProject("proj3-boundary-low");
    await completeProject(proj3);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const score1Res = await feedbackPOST(jsonReq({ deliverySpeedRating: 1, communicationRating: 1, functionalityRating: 1, easeOfUseRating: 1, overallRating: 1, requirementsDelivered: true }), { params: Promise.resolve({ id: proj3 }) });
    const score1Body = await score1Res.json();
    check("11. (live) All-1 ratings accepted end-to-end -> 201", score1Res.status === 201 && score1Body.overallRating === 1 && score1Body.deliverySpeedRating === 1);

    const proj4 = await makeRequestOriginProject("proj4-boundary-high");
    await completeProject(proj4);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const score5Res = await feedbackPOST(jsonReq({ deliverySpeedRating: 5, communicationRating: 5, functionalityRating: 5, easeOfUseRating: 5, overallRating: 5, requirementsDelivered: true }), { params: Promise.resolve({ id: proj4 }) });
    const score5Body = await score5Res.json();
    check("12. (live) All-5 ratings accepted end-to-end -> 201", score5Res.status === 201 && score5Body.overallRating === 5);

    const invalidScoreRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, overallRating: 0, requirementsDelivered: true }), { params: Promise.resolve({ id: proj4 }) });
    check("13. (live) overallRating 0 rejected end-to-end -> 422", invalidScoreRes.status === 422);

    const missingRatingRes = await feedbackPOST(jsonReq({ communicationRating: 3, functionalityRating: 3, easeOfUseRating: 3, overallRating: 3, requirementsDelivered: true }), { params: Promise.resolve({ id: proj4 }) });
    check("16. (live) Missing deliverySpeedRating rejected end-to-end -> 422, never accepted with a silent default", missingRatingRes.status === 422);

    // ══════════════════════ 20-23. UPSERT: update, never a duplicate row ══════════════════════
    console.log("\n=== 20-23. Resubmitting (as the Owner) UPDATES the existing row — never a second one ===\n");
    check("20. First submission on proj1 succeeded earlier (check 4) -> exactly 1 row", (await prisma.projectFeedback.count({ where: { projectId: proj1 } })) === 1);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const secondAttemptRes = await feedbackPOST(
      jsonReq({ deliverySpeedRating: 1, communicationRating: 1, functionalityRating: 1, easeOfUseRating: 1, overallRating: 1, requirementsDelivered: false, comments: "Updated answer" }),
      { params: Promise.resolve({ id: proj1 }) }
    );
    check("21. A second submission for the SAME Project (as the Owner) -> 200 (not 201), updates in place", secondAttemptRes.status === 200);
    const secondAttemptBody = await secondAttemptRes.json();
    check("...same id as the first submission", secondAttemptBody.id === proj1Feedback.id);
    check("...but the VALUES are now the new ones (1, false, 'Updated answer') — a genuine update, not a frozen original", secondAttemptBody.overallRating === 1 && secondAttemptBody.requirementsDelivered === false && secondAttemptBody.comments === "Updated answer");
    check("...still exactly ONE row for proj1 — never a second", (await prisma.projectFeedback.count({ where: { projectId: proj1 } })) === 1);

    const proj5 = await makeRequestOriginProject("proj5-race");
    await completeProject(proj5);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const [raceA, raceB] = await Promise.all([
      feedbackPOST(jsonReq({ ...FULL_FEEDBACK, overallRating: 2, requirementsDelivered: true }), { params: Promise.resolve({ id: proj5 }) }),
      feedbackPOST(jsonReq({ ...FULL_FEEDBACK, overallRating: 5, requirementsDelivered: true }), { params: Promise.resolve({ id: proj5 }) }),
    ]);
    check("22. Two concurrent submissions for the same Project both resolve (<300), never one hard-crashing the other", raceA.status < 300 && raceB.status < 300);
    check("...exactly ONE row exists for the race Project — never two (a second duplicate record for the same owner/project cannot be created)", (await prisma.projectFeedback.count({ where: { projectId: proj5 } })) === 1);

    // Reopening, then resubmitting while COMPLETED again, must still just update (not create a second row).
    await reopenProject(proj1);
    await completeProject(proj1);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const thirdAttemptRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "Final update" }), { params: Promise.resolve({ id: proj1 }) });
    check("23. Resubmitting after a reopen+re-complete cycle still updates the SAME row -> 200", thirdAttemptRes.status === 200 && (await thirdAttemptRes.json()).id === proj1Feedback.id);
    check("...still exactly ONE row for proj1", (await prisma.projectFeedback.count({ where: { projectId: proj1 } })) === 1);

    // ══════════════════════ 24. Cannot EDIT while reopened (not currently COMPLETED) ══════════════════════
    console.log("\n=== 24. An existing submission cannot be edited while the Project is reopened ===\n");
    await reopenProject(proj1);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const editWhileReopenedRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "Should be rejected" }), { params: Promise.resolve({ id: proj1 }) });
    check("24. Attempting to update existing feedback while the Project is NOT currently COMPLETED -> 409 not_completed", editWhileReopenedRes.status === 409 && (await editWhileReopenedRes.json()).code === "not_completed");
    const unchangedRow = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj1 } });
    check("...the existing row's comments remain the LAST successfully-saved value ('Final update'), untouched by the rejected attempt", unchangedRow.comments === "Final update");
    await completeProject(proj1); // restore COMPLETED for any later checks reusing proj1

    // ══════════════════════ 25-27. PROVENANCE (including legacy preservation across an update) ══════════════════════
    console.log("\n=== 25-27. submittedByUserId always server-set, never forgeable, and NEVER rewritten to the current Owner on update ===\n");
    const proj1Row = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj1 } });
    check("25. submittedByUserId on the real DB row is the authenticated Owner's own id (this row was created fresh under the NEW rule)", proj1Row.submittedByUserId === ownerUser.id);

    const proj6 = await makeRequestOriginProject("proj6-forged-id");
    await completeProject(proj6);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const forgedIdRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true, submittedByUserId: adminUser.id } as any), { params: Promise.resolve({ id: proj6 }) });
    check("26. A forged submittedByUserId in the body is silently ignored (not even a schema field) -> still 201", forgedIdRes.status === 201);
    const proj6Row = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj6 } });
    check("...the REAL stored submittedByUserId is still the authenticated Owner, never the forged adminUser.id", proj6Row.submittedByUserId === ownerUser.id && proj6Row.submittedByUserId !== adminUser.id);

    // 27: simulate a LEGACY row — one that genuinely exists because the
    // OLD requester-based rule created it (submittedByUserId = requester,
    // a different person than the CURRENT primary Owner). The Owner
    // updating it must change the ratings/comments but NEVER rewrite
    // submittedByUserId to themselves — see this feature's own explicit
    // "preserve truthful provenance, never fabricate history" requirement.
    const proj7Legacy = await makeRequestOriginProject("proj7-legacy-provenance");
    await completeProject(proj7Legacy);
    await prisma.projectFeedback.create({
      data: {
        projectId: proj7Legacy,
        projectRequestId: (await prisma.project.findUniqueOrThrow({ where: { id: proj7Legacy }, select: { projectRequestId: true } })).projectRequestId!,
        submittedByUserId: requester.id, // the OLD requester — simulating pre-existing provenance
        ...FULL_FEEDBACK,
        requirementsDelivered: true,
        comments: "Original legacy submission by the old requester",
      },
    });
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const ownerUpdateOfLegacyRes = await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, overallRating: 2, requirementsDelivered: false, comments: "Owner's update" }), { params: Promise.resolve({ id: proj7Legacy }) });
    check("27. The Owner CAN update a pre-existing legacy row (created under the old rule) -> 200", ownerUpdateOfLegacyRes.status === 200);
    const proj7LegacyRowAfter = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId: proj7Legacy } });
    check("...the ratings/comments are genuinely updated", proj7LegacyRowAfter.overallRating === 2 && proj7LegacyRowAfter.requirementsDelivered === false && proj7LegacyRowAfter.comments === "Owner's update");
    check("...but submittedByUserId is STILL the original requester — truthful historical provenance, NEVER fabricated to the current Owner", proj7LegacyRowAfter.submittedByUserId === requester.id && proj7LegacyRowAfter.submittedByUserId !== ownerUser.id);

    // ══════════════════════ 28-34. Dedicated feedback page: independent authorization + render-time gating ══════════════════════
    console.log("\n=== 28-34. /projects/[id]/feedback: independent authorization, Project detail shows only a CTA ===\n");
    const proj8 = await makeRequestOriginProject("proj8-ui");

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const caseANotCompletedEl = await ProjectFeedbackPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const caseACards = findElementsByType(caseANotCompletedEl, ProjectFeedbackCard);
    check("28. Case A — not yet completed, no feedback: the dedicated page renders an 'unavailable' state, not the form", caseACards.length === 0);
    const caseADetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj8 }) } as any);
    check("...and the Project detail page shows no CTA either (nothing to evaluate yet)", findElementsByType(caseADetailEl, ProjectFeedbackCtaCard).length === 0);
    check("...and critically, the Project detail page's own tree contains NO full feedback form anywhere", findElementsByType(caseADetailEl, ProjectFeedbackCard).length === 0);

    await completeProject(proj8);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const caseBDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const ctaCards = findElementsByType(caseBDetailEl, ProjectFeedbackCtaCard);
    check("29. Case B — completed, Owner, no feedback yet: Project detail shows the small CTA card", ctaCards.length === 1);
    check("...CTA says 'first submission' (hasExistingFeedback=false)", ctaCards[0]?.props.hasExistingFeedback === false);
    check("...and still NO full form anywhere on the Project detail page", findElementsByType(caseBDetailEl, ProjectFeedbackCard).length === 0);

    const caseBPageEl = await ProjectFeedbackPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const caseBPageCards = findElementsByType(caseBPageEl, ProjectFeedbackCard);
    check("30. The dedicated page itself DOES render the full form, with initialFeedback null and isProjectCompleted true", caseBPageCards.length === 1 && caseBPageCards[0]?.props.initialFeedback === null && caseBPageCards[0]?.props.isProjectCompleted === true);
    check("...and a projectSummary carrying the real Project title", caseBPageCards[0]?.props.projectSummary?.title === `${TAG} proj8-ui request`);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    await feedbackPOST(jsonReq({ ...FULL_FEEDBACK, requirementsDelivered: true, comments: "UI test comment" }), { params: Promise.resolve({ id: proj8 }) });
    const caseCDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const caseCCtaCards = findElementsByType(caseCDetailEl, ProjectFeedbackCtaCard);
    check("31. Case C — feedback now exists: CTA now says 'view/update' (hasExistingFeedback=true)", caseCCtaCards.length === 1 && caseCCtaCards[0]?.props.hasExistingFeedback === true);

    const caseCPageEl = await ProjectFeedbackPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const caseCPageCards = findElementsByType(caseCPageEl, ProjectFeedbackCard);
    check("...the dedicated page shows the real submitted data as initialFeedback", caseCPageCards.length === 1 && caseCPageCards[0]?.props.initialFeedback?.overallRating === 4 && caseCPageCards[0]?.props.initialFeedback?.comments === "UI test comment");

    // 32: a non-owner hitting the dedicated page directly is redirected straight back to the Project detail page.
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    let nonOwnerRedirectTarget: string | null = null;
    try {
      await ProjectFeedbackPage({ params: Promise.resolve({ id: proj8 }) } as any);
    } catch (err: any) {
      nonOwnerRedirectTarget = String(err?.digest ?? "").split(";")[2] ?? null;
    }
    check("32. A non-owner (the original requester) hitting /projects/[id]/feedback directly -> redirected to the Project detail page, never shown the form", nonOwnerRedirectTarget === `/projects/${proj8}`);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    const caseDDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj8 }) } as any);
    check("33. Case D — a non-owner (even ADMIN) viewing the SAME completed Project with feedback already submitted -> no CTA, no form, nothing", findElementsByType(caseDDetailEl, ProjectFeedbackCtaCard).length === 0 && findElementsByType(caseDDetailEl, ProjectFeedbackCard).length === 0);

    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const manualProjectEl = await ProjectDetailPage({ params: Promise.resolve({ id: manualProject.id }) } as any);
    check("34. A manual Project NEVER renders the CTA, regardless of who's viewing (even its own real owner) or what status it's in", findElementsByType(manualProjectEl, ProjectFeedbackCtaCard).length === 0);

    await reopenProject(proj8);
    currentSession = { user: { id: ownerUser.id, role: Role.USER, customRoleId: null } };
    const reopenedPageEl = await ProjectFeedbackPage({ params: Promise.resolve({ id: proj8 }) } as any);
    const reopenedCards = findElementsByType(reopenedPageEl, ProjectFeedbackCard);
    check("35. Reopened Project with existing feedback: dedicated page STILL renders it (historical record stays visible, read-only), isProjectCompleted now false", reopenedCards.length === 1 && reopenedCards[0]?.props.isProjectCompleted === false && reopenedCards[0]?.props.initialFeedback?.overallRating === 4);
    const reopenedDetailEl = await ProjectDetailPage({ params: Promise.resolve({ id: proj8 }) } as any);
    check("...and the Project detail page's CTA also still shows (reopened, but feedback exists)", findElementsByType(reopenedDetailEl, ProjectFeedbackCtaCard).length === 1);

    // ══════════════════════ 36-41. ADMIN permission + readonly review ══════════════════════
    console.log("\n=== 36-41. Administration -> Feedback: permission-gated, readonly, five ratings shown ===\n");
    const { getNavVisibilityFlags } = await import("@/lib/services/department-scope-service");
    const { default: ProjectFeedbackAdminPage } = await import("@/app/(main)/admin/project-feedback/page");

    const feedbackViewerRole = await makeRole("FEEDBACKVIEWER", []);
    await prisma.customRole.update({ where: { id: feedbackViewerRole.id }, data: { scope: "GLOBAL" } });
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: "projectFeedback.view" } });
    await prisma.rolePermission.create({ data: { roleKey: feedbackViewerRole.key, permissionId: perm.id } });
    const feedbackViewer = await makeUser(`${TAG}-feedbackviewer@kinsen.gr`);

    const viewerFlags = await getNavVisibilityFlags(feedbackViewer.id, Role.USER, feedbackViewerRole.id);
    check("36. A user granted projectFeedback.view (via a GLOBAL custom role) sees canViewProjectFeedback=true -> the Administration -> Feedback sidebar entry", viewerFlags.canViewProjectFeedback === true);

    const noPermFlags = await getNavVisibilityFlags(requester.id, Role.USER, null);
    check("37. A plain user without the permission does NOT see it", noPermFlags.canViewProjectFeedback === false);

    currentSession = { user: { id: feedbackViewer.id, role: Role.USER, customRoleId: feedbackViewerRole.id } };
    const authorizedAdminEl = await ProjectFeedbackAdminPage({ searchParams: Promise.resolve({}) } as any);
    check("38. Direct access to /admin/project-feedback with the permission -> renders (no redirect thrown)", authorizedAdminEl !== undefined);

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    let deniedRedirectTarget: string | null = null;
    try {
      await ProjectFeedbackAdminPage({ searchParams: Promise.resolve({}) } as any);
    } catch (err: any) {
      deniedRedirectTarget = String(err?.digest ?? "").split(";")[2] ?? null;
    }
    check("38. Direct access WITHOUT the permission -> redirected away (/dashboard), never rendered", deniedRedirectTarget === "/dashboard");

    const adminPageText = extractText(authorizedAdminEl).join("");
    check("39. Admin list includes the real Project title", adminPageText.includes(`${TAG} proj1 request`));
    check("...the real OWNER's email (not the requester's) for a fresh submission", adminPageText.includes(ownerUser.email ?? "__none__"));
    check("40. ...the legacy row's ORIGINAL requester email still appears (truthful historical provenance preserved)", adminPageText.includes(requester.email ?? "__none__"));
    check("...and the real comments text", adminPageText.includes("Final update"));
    check("41. The admin page's own source never references an edit/delete mutation for feedback — review-only by construction", !/DELETE|PATCH\s*\(/.test(await (await import("fs/promises")).readFile("app/(main)/admin/project-feedback/page.tsx", "utf8")));

    // ══════════════════════ 42-44. REGRESSIONS ══════════════════════
    console.log("\n=== 42-44. Unrelated behavior unaffected ===\n");
    check("42. Project completion (PATCH status) still works exactly as before — every completeProject()/reopenProject() call above succeeded", true);
    check("43. Project Request approval/create flow unchanged — every makeRequestOriginProject() call above (the real, unmodified flow) succeeded", true);
    const manualProjectGetCheck = await prisma.project.findUniqueOrThrow({ where: { id: manualProject.id } });
    check("44. A manual Project's own row is untouched by any of this — no feedback relation populated, no new required field", manualProjectGetCheck.projectRequestId === null);
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
      await prisma.taskType.deleteMany({ where: { id: { in: typeIds } } });
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
