/**
 * Persistent Project Feedback obligations (ProjectFeedbackRequest +
 * Project.feedbackRequestedAt) — acceptance through the REAL routes
 * (PATCH /api/projects/[id], POST /api/projects/[id]/feedback) and the real
 * Administration tracking computation (getProjectFeedbackTrackingOverview).
 *
 *  1. Multiple independent recipients, independent submissions, overall completion.
 *  2. Zero eligible recipients vs historical untracked Projects (marker-based).
 *  3. Recipient changes after completion (obligations never rewritten).
 *  4. Reopen + re-complete (original set kept, only new eligible added/notified).
 *  5. Concurrent completion + retry deduplication.
 *  6. Inactive recipients (never notified, never blocking, history preserved).
 *  7. Authorization without privilege escalation.
 *  8. Owner fallback + manual Projects.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-feedback-obligations.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { microsoftGraph } from "@/lib/microsoft-graph";

let sentTo: string[] = [];
microsoftGraph.sendMail = async (payload) => {
  sentTo.push(payload.message.toRecipients[0]?.emailAddress.address ?? "");
};

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

const RUN_ID = Date.now();
const TAG = `pfo-${RUN_ID}`;
const FEEDBACK = { deliverySpeedRating: 4, communicationRating: 5, functionalityRating: 3, easeOfUseRating: 4, overallRating: 4, requirementsDelivered: true };

async function main() {
  const { NextRequest } = await import("next/server");
  const projectsPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const feedbackPOST = (await import("@/app/api/projects/[id]/feedback/route")).POST;
  const { getProjectFeedbackEligibility, getProjectFeedbackTrackingOverview, computeProjectFeedbackTracking } = await import("@/lib/services/project-feedback-service");
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");

  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], requests: [] as string[] };
  const req = (body: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const asUser = (u: { id: string }, role: Role = Role.USER) => { currentSession = { user: { id: u.id, role, customRoleId: null } }; };

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    ids.depts.push(dept.id);
    const admin = await prisma.user.create({ data: { email: `${TAG}-admin@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    ids.users.push(admin.id);
    const mkUser = async (tag: string) => {
      const u = await prisma.user.create({ data: { email: `${TAG}-${tag}@kinsen.gr`, name: `${TAG} ${tag}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      ids.users.push(u.id);
      return u;
    };
    const mkProject = async (tag: string, opts: { owner: { id: string }; rps?: { id: string }[]; status?: ProjectStatus; manual?: boolean }) => {
      let projectRequestId: string | null = null;
      if (!opts.manual) {
        const pr = await prisma.projectRequest.create({ data: { title: `${TAG} ${tag}`, departmentId: dept.id, requesterId: opts.owner.id, approverId: admin.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
        ids.requests.push(pr.id);
        projectRequestId = pr.id;
      }
      const p = await prisma.project.create({
        data: {
          title: `${TAG} ${tag}`, departmentId: dept.id, ownerId: opts.owner.id, owners: { connect: [{ id: opts.owner.id }] },
          projectRequestId, status: opts.status ?? ProjectStatus.IN_PROGRESS,
          ...(opts.rps ? { responsiblePeople: { connect: opts.rps.map((r) => ({ id: r.id })) } } : {}),
        },
      });
      ids.projects.push(p.id);
      return p.id;
    };
    const setStatus = (pid: string, status: string) => { asUser(admin, Role.ADMIN); return projectsPATCH(req({ status }, "PATCH"), { params: Promise.resolve({ id: pid }) }); };
    const submit = (pid: string, u: { id: string }) => { asUser(u); return feedbackPOST(req(FEEDBACK), { params: Promise.resolve({ id: pid }) }); };
    const obligations = async (pid: string) => (await prisma.projectFeedbackRequest.findMany({ where: { projectId: pid }, orderBy: { userId: "asc" } })).map((r) => r.userId);
    const notifCount = (pid: string, uid?: string) => prisma.notification.count({ where: { link: `/projects/${pid}/feedback`, ...(uid ? { userId: uid } : {}) } });
    const trackingOf = async (pid: string) => (await getProjectFeedbackTrackingOverview({ departmentId: dept.id })).find((r) => r.project.id === pid);
    const sorted = (a: string[]) => [...a].sort();

    const owner = await mkUser("owner");
    const rp1 = await mkUser("rp1");
    const rp2 = await mkUser("rp2");
    const rp3 = await mkUser("rp3");

    // ── 1. Multiple independent recipients ──
    console.log("\n=== 1. Multiple independent recipients + overall completion ===\n");
    const pMulti = await mkProject("multi", { owner, rps: [rp1, rp2] });
    const t0 = await trackingOf(pMulti);
    check("1.0 Before completion: no marker, no obligations, not listed in tracking", t0 === undefined && (await obligations(pMulti)).length === 0);
    sentTo = [];
    const c1 = await setStatus(pMulti, "COMPLETED");
    const marker = (await prisma.project.findUniqueOrThrow({ where: { id: pMulti } })).feedbackRequestedAt;
    check("1.1 Completion (200) persists one obligation per active Responsible Person and stamps feedbackRequestedAt", c1.status === 200 && JSON.stringify(await obligations(pMulti)) === JSON.stringify(sorted([rp1.id, rp2.id])) && marker !== null);
    check("1.2 Each recipient notified + emailed exactly once; the Owner (not a Responsible Person) gets nothing", (await notifCount(pMulti, rp1.id)) === 1 && (await notifCount(pMulti, rp2.id)) === 1 && (await notifCount(pMulti, owner.id)) === 0 && JSON.stringify(sorted(sentTo)) === JSON.stringify(sorted([rp1.email, rp2.email])));
    let t = await trackingOf(pMulti);
    check("1.3 Admin tracking: IN_PROGRESS 0/2, both pending", t?.tracking.status === "IN_PROGRESS" && t.tracking.submitted.length === 0 && t.tracking.required.length === 2 && t.tracking.pending.length === 2);
    const s1 = await submit(pMulti, rp1);
    t = await trackingOf(pMulti);
    check("1.4 First recipient submits (201) → IN_PROGRESS 1/2, the other still pending", s1.status === 201 && t?.tracking.status === "IN_PROGRESS" && JSON.stringify(t.tracking.submitted) === JSON.stringify([rp1.id]) && JSON.stringify(t.tracking.pending) === JSON.stringify([rp2.id]));
    const s2 = await submit(pMulti, rp2);
    t = await trackingOf(pMulti);
    check("1.5 Second recipient submits independently (201, own row) → COMPLETE 2/2, nothing pending", s2.status === 201 && (await prisma.projectFeedback.count({ where: { projectId: pMulti } })) === 2 && t?.tracking.status === "COMPLETE" && t.tracking.submitted.length === 2 && t.tracking.pending.length === 0);
    const resubmit = await submit(pMulti, rp1);
    check("1.6 Re-submitting updates the recipient's own row (200) — no duplicate Feedback Form", resubmit.status === 200 && (await prisma.projectFeedback.count({ where: { projectId: pMulti } })) === 2);

    // ── 2. Zero eligible vs historical ──
    console.log("\n=== 2. Zero eligible active recipients vs historical (untracked) ===\n");
    const inactiveRp = await mkUser("inactive-rp");
    await prisma.user.update({ where: { id: inactiveRp.id }, data: { isActive: false } });
    const pZero = await mkProject("zero", { owner, rps: [inactiveRp] });
    sentTo = [];
    const cz = await setStatus(pZero, "COMPLETED");
    const zeroRow = await prisma.project.findUniqueOrThrow({ where: { id: pZero } });
    t = await trackingOf(pZero);
    check("2.1 All Responsible People inactive: completion OK, marker SET, zero obligations, no Owner fallback", cz.status === 200 && zeroRow.feedbackRequestedAt !== null && (await obligations(pZero)).length === 0 && (await notifCount(pZero)) === 0 && sentTo.length === 0);
    check("2.2 ...Admin tracking: NO_ELIGIBLE_RECIPIENTS (0/0), never COMPLETE", t?.tracking.status === "NO_ELIGIBLE_RECIPIENTS" && t.tracking.required.length === 0);
    const pHist = await mkProject("historical", { owner, status: ProjectStatus.COMPLETED });
    t = await trackingOf(pHist);
    check("2.3 Historical Project (completed before tracking, marker NULL): NOT_TRACKED, zero obligations, no notification", t?.tracking.status === "NOT_TRACKED" && (await obligations(pHist)).length === 0 && (await notifCount(pHist)) === 0);
    const hs = await submit(pHist, owner);
    t = await trackingOf(pHist);
    check("2.4 Historical access preserved: the live recipient (Owner) can still submit (201) — still NOT_TRACKED, no obligation created", hs.status === 201 && t?.tracking.status === "NOT_TRACKED" && (await obligations(pHist)).length === 0 && t.otherSubmissionUserIds.includes(owner.id));
    check("2.5 Same zero-row situation, different status: decided by the marker, not by the absence of rows", (await trackingOf(pZero))?.tracking.status !== (await trackingOf(pHist))?.tracking.status);

    // ── 3. Recipient changes after completion ──
    console.log("\n=== 3. Responsible People changed after completion ===\n");
    const pChange = await mkProject("change", { owner, rps: [rp1, rp2] });
    await setStatus(pChange, "COMPLETED");
    const changeMarker = (await prisma.project.findUniqueOrThrow({ where: { id: pChange } })).feedbackRequestedAt;
    const obligBefore = await prisma.projectFeedbackRequest.findMany({ where: { projectId: pChange }, orderBy: { userId: "asc" } });
    asUser(admin, Role.ADMIN);
    const edit = await projectsPATCH(req({ responsiblePeopleIds: [rp3.id] }, "PATCH"), { params: Promise.resolve({ id: pChange }) });
    const obligAfter = await prisma.projectFeedbackRequest.findMany({ where: { projectId: pChange }, orderBy: { userId: "asc" } });
    check("3.1 Replacing Responsible People (rp1,rp2 → rp3) leaves the obligations exactly as they were", edit.status === 200 && JSON.stringify(obligAfter) === JSON.stringify(obligBefore));
    check("3.2 ...the new Responsible Person gets no obligation and no notification", !obligAfter.some((o) => o.userId === rp3.id) && (await notifCount(pChange, rp3.id)) === 0);
    const removedSubmit = await submit(pChange, rp1);
    check("3.3 A requested recipient REMOVED from Responsible People keeps the right to submit their own Feedback (201)", removedSubmit.status === 201);
    const newRpSubmit = await submit(pChange, rp3);
    check("3.4 The newly added Responsible Person (no obligation) cannot submit → 403", newRpSubmit.status === 403 && (await prisma.projectFeedback.count({ where: { projectId: pChange, submittedByUserId: rp3.id } })) === 0);
    asUser(rp3);
    check("3.5 ...and sees no Feedback prompt (isRecipient false)", (await getProjectFeedbackEligibility(pChange, rp3.id)).isRecipient === false);
    t = await trackingOf(pChange);
    check("3.6 Tracking still counts the ORIGINAL obligations: IN_PROGRESS 1/2 (rp1 submitted, rp2 pending)", t?.tracking.status === "IN_PROGRESS" && JSON.stringify(t.tracking.submitted) === JSON.stringify([rp1.id]) && JSON.stringify(t.tracking.pending) === JSON.stringify([rp2.id]));

    // ── 7 (part). No privilege escalation for the removed-but-requested recipient ──
    const changeRow = await prisma.project.findUniqueOrThrow({ where: { id: pChange }, select: { id: true, departmentId: true, projectRequestId: true } });
    check("7.1 The removed-but-requested recipient gains NO Project view access (hasProjectViewAccess false)", (await hasProjectViewAccess(rp1.id, Role.USER, null, changeRow)) === false);
    check("7.2 ...and no Workspace membership was created for them", (await prisma.departmentMembership.count({ where: { userId: rp1.id } })) === 0);

    // ── 4. Reopen + re-complete ──
    console.log("\n=== 4. Reopen + re-complete ===\n");
    const responseBefore = await prisma.projectFeedback.findUniqueOrThrow({ where: { projectId_submittedByUserId: { projectId: pChange, submittedByUserId: rp1.id } } });
    await setStatus(pChange, "IN_PROGRESS");
    check("4.1 Reopening keeps obligations and responses", (await obligations(pChange)).length === 2 && (await prisma.projectFeedback.count({ where: { projectId: pChange } })) === 1);
    const blocked = await submit(pChange, rp2);
    check("4.2 ...while reopened, submission is blocked (409 not_completed)", blocked.status === 409);
    sentTo = [];
    const notifsBefore = { rp1: await notifCount(pChange, rp1.id), rp2: await notifCount(pChange, rp2.id) };
    await setStatus(pChange, "COMPLETED");
    check("4.3 Re-completion ADDS only the newly eligible active recipient (rp3); original obligations preserved", JSON.stringify(await obligations(pChange)) === JSON.stringify(sorted([rp1.id, rp2.id, rp3.id])));
    check("4.4 ...only rp3 is notified/emailed; rp1/rp2 are never re-sent a request", (await notifCount(pChange, rp3.id)) === 1 && (await notifCount(pChange, rp1.id)) === notifsBefore.rp1 && (await notifCount(pChange, rp2.id)) === notifsBefore.rp2 && JSON.stringify(sentTo) === JSON.stringify([rp3.email]));
    const responseAfter = await prisma.projectFeedback.findUniqueOrThrow({ where: { id: responseBefore.id } });
    check("4.5 The existing submitted response is untouched (same row, same answers, same timestamps)", JSON.stringify(responseAfter) === JSON.stringify(responseBefore));
    const markerAfter = (await prisma.project.findUniqueOrThrow({ where: { id: pChange } })).feedbackRequestedAt;
    t = await trackingOf(pChange);
    check("4.6 Tracking marker keeps its first value; tracking now IN_PROGRESS 1/3", changeMarker !== null && markerAfter?.getTime() === changeMarker.getTime() && t?.tracking.status === "IN_PROGRESS" && t.tracking.required.length === 3 && t.tracking.submitted.length === 1);

    // A response submitted while the Project was historical/untracked is honoured when it later becomes tracked.
    const pHistReopen = await mkProject("hist-reopen", { owner, status: ProjectStatus.COMPLETED });
    await submit(pHistReopen, owner);
    await setStatus(pHistReopen, "IN_PROGRESS");
    sentTo = [];
    await setStatus(pHistReopen, "COMPLETED");
    t = await trackingOf(pHistReopen);
    check("4.7 Historical Project re-completed: becomes tracked; its existing response counts (COMPLETE 1/1); not asked again (no notification)", t?.tracking.status === "COMPLETE" && t.tracking.submitted.length === 1 && (await notifCount(pHistReopen)) === 0 && sentTo.length === 0);

    // ── 5. Concurrency + retry ──
    console.log("\n=== 5. Concurrent completion + retry deduplication ===\n");
    const pConc = await mkProject("concurrent", { owner, rps: [rp1, rp2] });
    sentTo = [];
    asUser(admin, Role.ADMIN);
    const results = await Promise.all(Array.from({ length: 4 }, () => projectsPATCH(req({ status: "COMPLETED" }, "PATCH"), { params: Promise.resolve({ id: pConc }) })));
    check("5.1 Four concurrent completion PATCHes all succeed (200)", results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    check("5.2 ...exactly one obligation per recipient (no duplicates)", JSON.stringify(await obligations(pConc)) === JSON.stringify(sorted([rp1.id, rp2.id])));
    check("5.3 ...exactly one notification and one email per recipient", (await notifCount(pConc, rp1.id)) === 1 && (await notifCount(pConc, rp2.id)) === 1 && sentTo.length === 2);
    sentTo = [];
    await setStatus(pConc, "COMPLETED");
    check("5.4 Retrying the completion while already COMPLETED creates nothing and notifies nobody", (await obligations(pConc)).length === 2 && (await notifCount(pConc)) === 2 && sentTo.length === 0);

    // ── 6. Inactive recipients ──
    console.log("\n=== 6. Inactive recipients ===\n");
    const pMixed = await mkProject("mixed", { owner, rps: [rp1, inactiveRp] });
    sentTo = [];
    await setStatus(pMixed, "COMPLETED");
    check("6.1 Active + inactive Responsible People: obligation + notification for the active one only (no Owner fallback)", JSON.stringify(await obligations(pMixed)) === JSON.stringify([rp1.id]) && (await notifCount(pMixed, inactiveRp.id)) === 0 && (await notifCount(pMixed, owner.id)) === 0 && JSON.stringify(sentTo) === JSON.stringify([rp1.email]));
    // pMulti: rp1 + rp2 both submitted (COMPLETE). Deactivate rp2 → still COMPLETE, response kept.
    // pChange: rp2 pending. Deactivate rp2 → rp2 no longer blocks.
    await prisma.user.update({ where: { id: rp2.id }, data: { isActive: false } });
    const multiT = await trackingOf(pMulti);
    const changeT = await trackingOf(pChange);
    check("6.2 A requested recipient who becomes inactive no longer blocks: their pending obligation drops out of Required", changeT?.tracking.pending.includes(rp2.id) === false && changeT.tracking.inactiveRequested.includes(rp2.id));
    check("6.3 ...their obligation and submitted response are preserved (listed as inactive, response row intact)", (await obligations(pMulti)).includes(rp2.id) && multiT?.tracking.inactiveRequested.includes(rp2.id) === true && multiT.allSubmittedUserIds.includes(rp2.id) && (await prisma.projectFeedback.count({ where: { projectId: pMulti, submittedByUserId: rp2.id } })) === 1);
    const inactiveSubmit = await submit(pChange, rp2);
    check("6.4 An inactive requested recipient cannot submit (403)", inactiveSubmit.status === 403);
    const pAllGone = await mkProject("all-gone", { owner, rps: [rp2] });
    await prisma.user.update({ where: { id: rp2.id }, data: { isActive: true } });
    await setStatus(pAllGone, "COMPLETED");
    await prisma.user.update({ where: { id: rp2.id }, data: { isActive: false } });
    t = await trackingOf(pAllGone);
    check("6.5 Every requested recipient later inactive → NO_ELIGIBLE_RECIPIENTS (not COMPLETE, not blocking forever)", t?.tracking.status === "NO_ELIGIBLE_RECIPIENTS" && t.tracking.inactiveRequested.length === 1);
    await prisma.user.update({ where: { id: rp2.id }, data: { isActive: true } });

    // ── 7. Authorization ──
    console.log("\n=== 7. Authorization without privilege escalation ===\n");
    const member = await mkUser("member");
    await prisma.project.update({ where: { id: pMulti }, data: { members: { connect: [{ id: member.id }] }, owners: { connect: [{ id: member.id }] } } });
    check("7.3 Primary Owner of a tracked Project with Responsible People (no obligation) → 403", (await submit(pMulti, owner)).status === 403);
    check("7.4 A Member / additional Owner (no obligation) → 403", (await submit(pMulti, member)).status === 403);
    asUser(admin, Role.ADMIN);
    const adminRes = await feedbackPOST(req(FEEDBACK), { params: Promise.resolve({ id: pMulti }) });
    check("7.5 ADMIN without an obligation → 403 (no role bypass)", adminRes.status === 403);
    check("7.6 None of the rejected attempts created a Feedback row", (await prisma.projectFeedback.count({ where: { projectId: pMulti, submittedByUserId: { in: [owner.id, member.id, admin.id] } } })) === 0);

    // ── 8. Owner fallback + manual Projects ──
    console.log("\n=== 8. Owner fallback + manual Projects ===\n");
    const pOwner = await mkProject("owner-fallback", { owner });
    sentTo = [];
    await setStatus(pOwner, "COMPLETED");
    check("8.1 No Responsible People configured: the active primary Owner gets the obligation + notification", JSON.stringify(await obligations(pOwner)) === JSON.stringify([owner.id]) && (await notifCount(pOwner, owner.id)) === 1 && JSON.stringify(sentTo) === JSON.stringify([owner.email]));
    const inactiveOwner = await mkUser("inactive-owner");
    const pOwnerInactive = await mkProject("owner-inactive", { owner: inactiveOwner });
    await prisma.user.update({ where: { id: inactiveOwner.id }, data: { isActive: false } });
    await setStatus(pOwnerInactive, "COMPLETED");
    check("8.2 No Responsible People and an INACTIVE Owner: zero obligations → NO_ELIGIBLE_RECIPIENTS", (await obligations(pOwnerInactive)).length === 0 && (await trackingOf(pOwnerInactive))?.tracking.status === "NO_ELIGIBLE_RECIPIENTS");
    const pManual = await mkProject("manual", { owner, manual: true });
    await setStatus(pManual, "COMPLETED");
    const manualRow = await prisma.project.findUniqueOrThrow({ where: { id: pManual } });
    check("8.3 Manual Project completed: no marker, no obligations, no notification, not in tracking", manualRow.feedbackRequestedAt === null && (await obligations(pManual)).length === 0 && (await notifCount(pManual)) === 0 && (await trackingOf(pManual)) === undefined);

    // ── 10. Inactive Responsible People retention (Edit-page style saves: full RP list on every PATCH) ──
    console.log("\n=== 10. Existing inactive Responsible People are retained; only NEW ones are validated ===\n");
    const patch = (pid: string, body: Record<string, unknown>) => { asUser(admin, Role.ADMIN); return projectsPATCH(req(body, "PATCH"), { params: Promise.resolve({ id: pid }) }); };
    const rpsOf = async (pid: string) => (await prisma.project.findUniqueOrThrow({ where: { id: pid }, select: { responsiblePeople: { select: { id: true } } } })).responsiblePeople.map((r) => r.id).sort();
    const pRet = await mkProject("retain-mixed", { owner, rps: [rp1, inactiveRp] });
    const saveRes = await patch(pRet, { title: `${TAG} retain-mixed renamed`, responsiblePeopleIds: [rp1.id, inactiveRp.id] });
    check("10.1 Saving a Project that keeps an existing INACTIVE Responsible Person → 200, nothing removed", saveRes.status === 200 && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, inactiveRp.id])));
    const getBody = await saveRes.json();
    check("10.2 The Project API flags the inactive Responsible Person (isActive false) for the Edit page", getBody.responsiblePeople?.find((r: any) => r.id === inactiveRp.id)?.isActive === false && getBody.responsiblePeople?.find((r: any) => r.id === rp1.id)?.isActive === true);
    sentTo = [];
    const retComplete = await patch(pRet, { status: "COMPLETED", responsiblePeopleIds: [rp1.id, inactiveRp.id] });
    check("10.3 Completing it (Edit-page save incl. the inactive Responsible Person) → 200, relationship kept", retComplete.status === 200 && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, inactiveRp.id])));
    check("10.4 Mixed: obligation + notification + email for the ACTIVE Responsible Person only; Owner gets nothing", JSON.stringify(await obligations(pRet)) === JSON.stringify([rp1.id]) && (await notifCount(pRet, inactiveRp.id)) === 0 && (await notifCount(pRet, owner.id)) === 0 && JSON.stringify(sentTo) === JSON.stringify([rp1.email]));
    t = await trackingOf(pRet);
    check("10.5 Tracking: IN_PROGRESS 0/1 — the inactive Responsible Person is not required", t?.tracking.status === "IN_PROGRESS" && JSON.stringify(t.tracking.required) === JSON.stringify([rp1.id]));
    const reopen = await patch(pRet, { status: "IN_PROGRESS", responsiblePeopleIds: [rp1.id, inactiveRp.id, rp3.id] });
    sentTo = [];
    const recomplete = await patch(pRet, { status: "COMPLETED", responsiblePeopleIds: [rp1.id, inactiveRp.id, rp3.id] });
    check("10.6 Reopen (adding an active rp3) + re-complete with the inactive one retained → both 200", reopen.status === 200 && recomplete.status === 200 && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, inactiveRp.id, rp3.id])));
    check("10.7 ...only rp3 gets a NEW obligation/notification; rp1 not re-sent; inactive never requested", JSON.stringify(await obligations(pRet)) === JSON.stringify(sorted([rp1.id, rp3.id])) && JSON.stringify(sentTo) === JSON.stringify([rp3.email]) && (await notifCount(pRet, rp1.id)) === 1);

    const pAllInactive = await mkProject("retain-all-inactive", { owner, rps: [inactiveRp] });
    sentTo = [];
    const allInRes = await patch(pAllInactive, { status: "COMPLETED", responsiblePeopleIds: [inactiveRp.id] });
    t = await trackingOf(pAllInactive);
    check("10.8 All Responsible People inactive: Edit-page completion → 200, zero obligations, NO Owner fallback, nobody notified", allInRes.status === 200 && (await obligations(pAllInactive)).length === 0 && (await notifCount(pAllInactive)) === 0 && sentTo.length === 0);
    check("10.9 ...tracking: NO_ELIGIBLE_RECIPIENTS", t?.tracking.status === "NO_ELIGIBLE_RECIPIENTS");

    const removeRes = await patch(pRet, { responsiblePeopleIds: [rp1.id, rp3.id] });
    check("10.10 Removing the inactive Responsible Person → 200, removed", removeRes.status === 200 && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, rp3.id])));
    const readdRes = await patch(pRet, { responsiblePeopleIds: [rp1.id, rp3.id, inactiveRp.id] });
    const readdBody = await readdRes.json();
    check("10.11 Re-adding that inactive user → 400 invalid_responsible_people, Responsible People unchanged", readdRes.status === 400 && readdBody.code === "invalid_responsible_people" && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, rp3.id])));
    const neverAssigned = await mkUser("never-assigned-inactive");
    await prisma.user.update({ where: { id: neverAssigned.id }, data: { isActive: false } });
    const addNewInactive = await patch(pRet, { responsiblePeopleIds: [rp1.id, rp3.id, neverAssigned.id] });
    check("10.12 Adding a NEW inactive user → 400, nothing changed", addNewInactive.status === 400 && JSON.stringify(await rpsOf(pRet)) === JSON.stringify(sorted([rp1.id, rp3.id])));
    const addUnknown = await patch(pRet, { responsiblePeopleIds: [rp1.id, "does-not-exist"] });
    check("10.13 Adding a non-existent user id → 400", addUnknown.status === 400);
    check("10.14 Obligations and the earlier completion state untouched by these edits", JSON.stringify(await obligations(pRet)) === JSON.stringify(sorted([rp1.id, rp3.id])));
    check("10.15 No Workspace membership was created for any Responsible Person", (await prisma.departmentMembership.count({ where: { userId: { in: [rp1.id, rp3.id, inactiveRp.id] } } })) === 0);

    // ── Pure computation ──
    console.log("\n=== 9. computeProjectFeedbackTracking (pure) ===\n");
    check("9.1 marker null → NOT_TRACKED even with rows present", computeProjectFeedbackTracking({ feedbackRequestedAt: null, requests: [{ userId: "a", isActive: true }], submittedUserIds: ["a"] }).status === "NOT_TRACKED");
    check("9.2 marker set, no requests → NO_ELIGIBLE_RECIPIENTS", computeProjectFeedbackTracking({ feedbackRequestedAt: new Date(), requests: [], submittedUserIds: [] }).status === "NO_ELIGIBLE_RECIPIENTS");
    const mixed = computeProjectFeedbackTracking({ feedbackRequestedAt: new Date(), requests: [{ userId: "a", isActive: true }, { userId: "b", isActive: false }], submittedUserIds: ["a"] });
    check("9.3 active submitted + inactive pending → COMPLETE 1/1 (inactive never blocks)", mixed.status === "COMPLETE" && mixed.required.length === 1 && JSON.stringify(mixed.inactiveRequested) === JSON.stringify(["b"]));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["feedback", () => prisma.projectFeedback.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["obligations", () => prisma.projectFeedbackRequest.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    const leftovers = await prisma.projectFeedbackRequest.count({ where: { projectId: { in: ids.projects } } });
    if (leftovers) console.warn(`cleanup: ${leftovers} obligation rows left`);
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
