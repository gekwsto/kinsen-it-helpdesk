/**
 * Configurable Project Statuses (ProjectStatusDefinition) — acceptance
 * through the real routes/services:
 *  1. Migration integrity (system rows, every Project linked + consistent).
 *  2. Admin CRUD + ADMIN-only authorization + read endpoint.
 *  3. System protection (no delete/remap; PLANNING stays active).
 *  4. Custom creation + selection (create/PATCH), contradictions rejected.
 *  5. Used-status delete/remap rejection with usage counts.
 *  6. Inactive retention + backward-compatible legacy enum callers.
 *  7. DB trigger backstop for direct writers.
 *  8. Lifecycle: same-canonical moves have no side effects; COMPLETED entry
 *     runs the completion workflow once; COMPLETED->COMPLETED never
 *     duplicates notifications/obligations; reopen/re-complete.
 *  9. Workspace transfer keeps the definition.
 * 10. Filters, dashboard breakdown, canonical lifecycle metrics, export labels.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-status-definitions.ts
 */
import { mock } from "node:test";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ProjectStatus, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { microsoftGraph } from "@/lib/microsoft-graph";

let sentTo: string[] = [];
microsoftGraph.sendMail = async (payload) => { sentTo.push(payload.message.toRecipients[0]?.emailAddress.address ?? ""); };

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

const RUN_ID = Date.now();
const TAG = `psd-${RUN_ID}`;

async function main() {
  const { NextRequest } = await import("next/server");
  const adminList = await import("@/app/api/admin/project-statuses/route");
  const adminItem = await import("@/app/api/admin/project-statuses/[id]/route");
  const readList = await import("@/app/api/project-statuses/route");
  const projectsPOST = (await import("@/app/api/projects/route")).POST;
  const projectPATCH = (await import("@/app/api/projects/[id]/route")).PATCH;
  const feedbackPOST = (await import("@/app/api/projects/[id]/feedback/route")).POST;
  const listExportGET = (await import("@/app/api/projects/export/route")).GET;
  const { buildProjectListQuery } = await import("@/lib/services/project-query-service");
  const { getProjectsDashboardData } = await import("@/lib/services/projects-dashboard-service");
  const { getProjectFeedbackTrackingOverview } = await import("@/lib/services/project-feedback-service");

  const ids = { depts: [] as string[], users: [] as string[], projects: [] as string[], requests: [] as string[], defs: [] as string[] };
  const req = (body?: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const as = (u: { id: string }, role: Role) => { currentSession = { user: { id: u.id, role, customRoleId: null } }; };
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  const systemDefs = Object.fromEntries((await prisma.projectStatusDefinition.findMany({ where: { isSystem: true } })).map((d) => [d.canonicalStatus, d]));
  const originalSystem = await prisma.projectStatusDefinition.findMany({ where: { isSystem: true } });

  try {
    // ── 1. Migration integrity ──
    console.log("\n=== 1. Migration integrity ===\n");
    check("1.1 Exactly five SYSTEM definitions with the canonical keys", JSON.stringify(Object.keys(systemDefs).sort()) === JSON.stringify(Object.values(ProjectStatus).sort()) && Object.values(systemDefs).every((d) => d.key === d.canonicalStatus));
    const mismatched: { n: number }[] = await prisma.$queryRaw`SELECT count(*)::int AS n FROM "Project" p JOIN "ProjectStatusDefinition" d ON d.id = p."statusDefinitionId" WHERE d."canonicalStatus" <> p.status`;
    check("1.2 Every existing Project is linked to a definition matching its canonical status", mismatched[0].n === 0);

    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    const dept2 = await createDepartment({ name: `${TAG}-dept2`, slug: `${TAG}-dept2` });
    ids.depts.push(dept.id, dept2.id);
    const mk = async (tag: string, role: Role = Role.USER) => { const u = await prisma.user.create({ data: { email: `${TAG}-${tag}@kinsen.gr`, name: `${TAG} ${tag}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true } }); ids.users.push(u.id); return u; };
    const admin = await mk("admin", Role.ADMIN);
    const user = await mk("user");
    await prisma.departmentMembership.create({ data: { userId: user.id, departmentId: dept.id, role: DepartmentRole.PROJECT_MANAGER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    const rp = await mk("rp");

    // ── 2. Admin authorization + CRUD ──
    console.log("\n=== 2. Admin CRUD + authorization ===\n");
    as(user, Role.USER);
    const forbiddenStatuses = [
      (await adminList.GET()).status,
      (await adminList.POST(req({ label: "Nope", canonicalStatus: "PLANNING" }))).status,
      (await adminItem.PATCH(req({ label: "x" }, "PATCH"), p(systemDefs.PLANNING.id))).status,
      (await adminItem.DELETE(req(undefined, "DELETE"), p(systemDefs.PLANNING.id))).status,
    ];
    check("2.1 A non-ADMIN user (even a Project Manager) gets 403 on every admin endpoint", forbiddenStatuses.every((s) => s === 403), JSON.stringify(forbiddenStatuses));
    const readRes = await readList.GET();
    check("2.2 ...but can READ the configured statuses (GET /api/project-statuses → 200)", readRes.status === 200 && (await readRes.json()).length >= 5);
    as(admin, Role.ADMIN);
    const created = await adminList.POST(req({ label: `${TAG} In Review`, color: "#7c3aed", canonicalStatus: "IN_PROGRESS" }));
    const review = await created.json();
    if (review.id) ids.defs.push(review.id);
    check("2.3 ADMIN creates a custom status (201) with an auto key, mapped to IN_PROGRESS, not system", created.status === 201 && /^PSD_\d+_IN_REVIEW$/.test(review.key) && review.canonicalStatus === "IN_PROGRESS" && review.isSystem === false && review.isActive === true, JSON.stringify(review));
    const delivered = await (await adminList.POST(req({ label: `${TAG} Delivered`, color: "#059669", canonicalStatus: "COMPLETED" }))).json();
    ids.defs.push(delivered.id);
    const dupLabel = await adminList.POST(req({ label: `${TAG} in review`, canonicalStatus: "PLANNING" }));
    check("2.4 Duplicate label (case-insensitive) → 409 duplicate_label", dupLabel.status === 409 && (await dupLabel.json()).code === "duplicate_label");
    const badColor = await adminList.POST(req({ label: `${TAG} Bad`, color: "red", canonicalStatus: "PLANNING" }));
    const badCanonical = await adminList.POST(req({ label: `${TAG} Bad2`, canonicalStatus: "DONE" }));
    check("2.5 Invalid color / unknown lifecycle state → 400", badColor.status === 400 && badCanonical.status === 400);
    const edit = await adminItem.PATCH(req({ label: `${TAG} Reviewing`, color: "#6d28d9", sortOrder: 25 }, "PATCH"), p(review.id));
    const edited = await edit.json();
    check("2.6 Edit label/color/order → 200", edit.status === 200 && edited.label === `${TAG} Reviewing` && edited.color === "#6d28d9" && edited.sortOrder === 25);
    const keyChange = await adminItem.PATCH(req({ key: "OTHER_KEY" }, "PATCH"), p(review.id));
    check("2.7 The key is immutable → 400", keyChange.status === 400);
    const listRes = await adminList.GET();
    const listed = await listRes.json();
    check("2.8 Admin list returns definitions in display order with usage counts", listRes.status === 200 && listed.some((d: any) => d.id === review.id && d.usageCount === 0) && listed.every((d: any, i: number) => i === 0 || listed[i - 1].sortOrder <= d.sortOrder));

    // ── 3. System protection ──
    console.log("\n=== 3. System status protection ===\n");
    const sysRename = await adminItem.PATCH(req({ label: "Planning (renamed)", color: "#2563eb", sortOrder: 5 }, "PATCH"), p(systemDefs.PLANNING.id));
    check("3.1 System status label/color/order are editable → 200", sysRename.status === 200 && (await sysRename.json()).label === "Planning (renamed)");
    const sysRemap = await adminItem.PATCH(req({ canonicalStatus: "IN_PROGRESS" }, "PATCH"), p(systemDefs.ON_HOLD.id));
    check("3.2 Remapping a system status → 409 system_status_protected", sysRemap.status === 409 && (await sysRemap.json()).code === "system_status_protected");
    const sysDelete = await adminItem.DELETE(req(undefined, "DELETE"), p(systemDefs.CANCELLED.id));
    check("3.3 Deleting a system status → 409 system_status_protected", sysDelete.status === 409 && (await sysDelete.json()).code === "system_status_protected");
    const planningOff = await adminItem.PATCH(req({ isActive: false }, "PATCH"), p(systemDefs.PLANNING.id));
    check("3.4 Deactivating the system PLANNING status → 409 planning_must_stay_active", planningOff.status === 409 && (await planningOff.json()).code === "planning_must_stay_active");
    const holdOff = await adminItem.PATCH(req({ isActive: false }, "PATCH"), p(systemDefs.ON_HOLD.id));
    check("3.5 Deactivating another system status (On Hold) → 200", holdOff.status === 200 && (await holdOff.json()).isActive === false);
    await adminItem.PATCH(req({ isActive: true }, "PATCH"), p(systemDefs.ON_HOLD.id));

    // ── 4. Custom creation + selection ──
    console.log("\n=== 4. Custom status selection ===\n");
    const createRes = await projectsPOST(req({ title: `${TAG} created custom`, departmentId: dept.id, statusDefinitionId: review.id }));
    const createdProject = await createRes.json();
    if (createdProject.id) ids.projects.push(createdProject.id);
    check("4.1 Create with a custom statusDefinitionId → 201, canonical status derived (IN_PROGRESS)", createRes.status === 201 && createdProject.status === "IN_PROGRESS" && createdProject.statusDefinitionId === review.id, JSON.stringify(createdProject).slice(0, 200));
    const createDefault = await projectsPOST(req({ title: `${TAG} created default`, departmentId: dept.id }));
    const createdDefault = await createDefault.json();
    if (createdDefault.id) ids.projects.push(createdDefault.id);
    check("4.2 Create with no status → the system PLANNING status", createDefault.status === 201 && createdDefault.status === "PLANNING" && createdDefault.statusDefinitionId === systemDefs.PLANNING.id);
    const conflict = await projectsPOST(req({ title: `${TAG} conflict`, departmentId: dept.id, statusDefinitionId: review.id, status: "COMPLETED" }));
    check("4.3 Contradictory status + statusDefinitionId → 409 status_conflict, nothing created", conflict.status === 409 && (await conflict.json()).code === "status_conflict");
    const unknown = await projectsPOST(req({ title: `${TAG} unknown`, departmentId: dept.id, statusDefinitionId: "nope" }));
    check("4.4 Unknown statusDefinitionId → 400 invalid_status_definition", unknown.status === 400);
    const legacyCreate = await projectsPOST(req({ title: `${TAG} legacy create`, departmentId: dept.id, status: "ON_HOLD" }));
    const legacyCreated = await legacyCreate.json();
    if (legacyCreated.id) ids.projects.push(legacyCreated.id);
    check("4.5 Legacy enum-only create (status ON_HOLD) → the system On Hold status", legacyCreate.status === 201 && legacyCreated.statusDefinitionId === systemDefs.ON_HOLD.id);
    const consistent = await projectPATCH(req({ status: "IN_PROGRESS", statusDefinitionId: review.id }, "PATCH"), p(createdDefault.id));
    const consistentBody = await consistent.json();
    check("4.6 PATCH with BOTH consistent values → 200; response carries the configured status", consistent.status === 200 && consistentBody.statusDefinition?.id === review.id && consistentBody.statusDefinition?.label === `${TAG} Reviewing`);

    // ── 5. Used-status delete/remap rejection ──
    console.log("\n=== 5. Used statuses can't be deleted or remapped ===\n");
    const usedDelete = await adminItem.DELETE(req(undefined, "DELETE"), p(review.id));
    const usedDeleteBody = await usedDelete.json();
    check("5.1 Deleting a status used by 2 Projects → 409 status_in_use with usageCount 2 and a clear message", usedDelete.status === 409 && usedDeleteBody.code === "status_in_use" && usedDeleteBody.usageCount === 2 && /used by 2 Project/.test(usedDeleteBody.error), JSON.stringify(usedDeleteBody));
    const usedRemap = await adminItem.PATCH(req({ canonicalStatus: "ON_HOLD" }, "PATCH"), p(review.id));
    const usedRemapBody = await usedRemap.json();
    check("5.2 Remapping a used custom status → 409 status_in_use with usageCount", usedRemap.status === 409 && usedRemapBody.code === "status_in_use" && usedRemapBody.usageCount === 2);
    const spare = await (await adminList.POST(req({ label: `${TAG} Spare`, canonicalStatus: "PLANNING" }))).json();
    ids.defs.push(spare.id);
    const spareRemap = await adminItem.PATCH(req({ canonicalStatus: "ON_HOLD" }, "PATCH"), p(spare.id));
    check("5.3 Remapping an UNUSED custom status → 200", spareRemap.status === 200 && (await spareRemap.json()).canonicalStatus === "ON_HOLD");
    const spareDelete = await adminItem.DELETE(req(undefined, "DELETE"), p(spare.id));
    check("5.4 Deleting an UNUSED custom status → 200, gone", spareDelete.status === 200 && (await prisma.projectStatusDefinition.count({ where: { id: spare.id } })) === 0);

    // ── 6. Inactive retention + legacy callers ──
    console.log("\n=== 6. Inactive retention + backward-compatible legacy callers ===\n");
    await adminItem.PATCH(req({ isActive: false }, "PATCH"), p(review.id));
    const pid = createdProject.id;
    const unrelated = await projectPATCH(req({ title: `${TAG} created custom (renamed)` }, "PATCH"), p(pid));
    const afterUnrelated = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
    check("6.1 Saving unrelated fields keeps the existing (now INACTIVE) status", unrelated.status === 200 && afterUnrelated.statusDefinitionId === review.id);
    const resaveSame = await projectPATCH(req({ statusDefinitionId: review.id, title: `${TAG} created custom` }, "PATCH"), p(pid));
    check("6.2 Re-saving the Project's current inactive status (Edit page) → 200, kept", resaveSame.status === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: pid } })).statusDefinitionId === review.id);
    const selectInactive = await projectPATCH(req({ statusDefinitionId: review.id }, "PATCH"), p(legacyCreated.id));
    check("6.3 NEWLY selecting an inactive status → 409 inactive_status, unchanged", selectInactive.status === 409 && (await selectInactive.json()).code === "inactive_status" && (await prisma.project.findUniqueOrThrow({ where: { id: legacyCreated.id } })).statusDefinitionId === systemDefs.ON_HOLD.id);
    const createInactive = await projectsPOST(req({ title: `${TAG} create inactive`, departmentId: dept.id, statusDefinitionId: review.id }));
    check("6.4 Creating with an inactive status → 409", createInactive.status === 409);
    const legacySame = await projectPATCH(req({ status: "IN_PROGRESS" }, "PATCH"), p(pid));
    check("6.5 Legacy enum caller re-sending the UNCHANGED canonical state keeps the custom (inactive) status", legacySame.status === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: pid } })).statusDefinitionId === review.id);
    const legacyChange = await projectPATCH(req({ status: "ON_HOLD" }, "PATCH"), p(pid));
    const afterLegacyChange = await prisma.project.findUniqueOrThrow({ where: { id: pid } });
    check("6.6 Legacy enum caller changing the canonical state → that state's active system status", legacyChange.status === 200 && afterLegacyChange.status === "ON_HOLD" && afterLegacyChange.statusDefinitionId === systemDefs.ON_HOLD.id);
    await adminItem.PATCH(req({ isActive: true }, "PATCH"), p(review.id));
    await adminItem.PATCH(req({ isActive: false }, "PATCH"), p(systemDefs.ON_HOLD.id));
    const holdCustom = await (await adminList.POST(req({ label: `${TAG} Paused`, canonicalStatus: "ON_HOLD" }))).json();
    ids.defs.push(holdCustom.id);
    const legacyToHold = await projectPATCH(req({ status: "ON_HOLD" }, "PATCH"), p(createdDefault.id));
    check("6.7 Legacy caller → a state whose system status is inactive: the first ACTIVE status for that state is used", legacyToHold.status === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: createdDefault.id } })).statusDefinitionId === holdCustom.id);
    await adminItem.PATCH(req({ isActive: true }, "PATCH"), p(systemDefs.ON_HOLD.id));

    // ── 7. DB trigger backstop ──
    console.log("\n=== 7. DB trigger backstop for direct writers ===\n");
    await prisma.project.update({ where: { id: createdDefault.id }, data: { status: ProjectStatus.IN_PROGRESS, statusDefinitionId: review.id } });
    await prisma.project.update({ where: { id: createdDefault.id }, data: { status: ProjectStatus.IN_PROGRESS } });
    check("7.1 Direct write of the same canonical state keeps the custom status", (await prisma.project.findUniqueOrThrow({ where: { id: createdDefault.id } })).statusDefinitionId === review.id);
    await prisma.project.update({ where: { id: createdDefault.id }, data: { status: ProjectStatus.CANCELLED } });
    check("7.2 Direct canonical change → the system status of the new state", (await prisma.project.findUniqueOrThrow({ where: { id: createdDefault.id } })).statusDefinitionId === systemDefs.CANCELLED.id);
    let rejected = false;
    try { await prisma.project.update({ where: { id: createdDefault.id }, data: { status: ProjectStatus.PLANNING, statusDefinitionId: review.id } }); } catch (e: any) { rejected = String(e.message).includes("project_status_mismatch"); }
    check("7.3 A contradictory direct write is rejected by the database", rejected);
    const direct = await prisma.project.create({ data: { title: `${TAG} direct`, departmentId: dept.id, ownerId: admin.id, status: ProjectStatus.COMPLETED } });
    ids.projects.push(direct.id);
    check("7.4 A direct create with only the canonical status gets that state's system status", direct.statusDefinitionId === systemDefs.COMPLETED.id);

    // ── 8. Lifecycle ──
    console.log("\n=== 8. Lifecycle depends only on the canonical state ===\n");
    const pr = await prisma.projectRequest.create({ data: { title: `${TAG} request`, departmentId: dept.id, requesterId: admin.id, approverId: admin.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const ro = await prisma.project.create({ data: { title: `${TAG} request-origin`, departmentId: dept.id, ownerId: admin.id, owners: { connect: [{ id: admin.id }] }, projectRequestId: pr.id, status: ProjectStatus.IN_PROGRESS, responsiblePeople: { connect: [{ id: rp.id }] } } });
    ids.projects.push(ro.id);
    const notifCount = () => prisma.notification.count({ where: { link: `/projects/${ro.id}/feedback` } });
    const obligationCount = () => prisma.projectFeedbackRequest.count({ where: { projectId: ro.id } });
    as(admin, Role.ADMIN);
    sentTo = [];
    const toCustomIP = await projectPATCH(req({ statusDefinitionId: review.id }, "PATCH"), p(ro.id));
    const rowIP = await prisma.project.findUniqueOrThrow({ where: { id: ro.id } });
    check("8.1 IN_PROGRESS (system) → custom IN_PROGRESS: 200, no completion side effects (no marker/obligation/notification/email)", toCustomIP.status === 200 && rowIP.status === "IN_PROGRESS" && rowIP.feedbackRequestedAt === null && (await obligationCount()) === 0 && (await notifCount()) === 0 && sentTo.length === 0);
    const toDelivered = await projectPATCH(req({ statusDefinitionId: delivered.id }, "PATCH"), p(ro.id));
    const rowDone = await prisma.project.findUniqueOrThrow({ where: { id: ro.id } });
    check("8.2 Entering a custom COMPLETED-mapped status runs the completion workflow: canonical COMPLETED, marker set, 1 obligation, 1 notification, 1 email", toDelivered.status === 200 && rowDone.status === "COMPLETED" && rowDone.feedbackRequestedAt !== null && (await obligationCount()) === 1 && (await notifCount()) === 1 && JSON.stringify(sentTo) === JSON.stringify([rp.email]));
    const toSysCompleted = await projectPATCH(req({ statusDefinitionId: systemDefs.COMPLETED.id }, "PATCH"), p(ro.id));
    const rowSys = await prisma.project.findUniqueOrThrow({ where: { id: ro.id } });
    check("8.3 COMPLETED-mapped → another COMPLETED-mapped status: no duplicate notification/email/obligation; marker unchanged", toSysCompleted.status === 200 && rowSys.statusDefinitionId === systemDefs.COMPLETED.id && (await notifCount()) === 1 && sentTo.length === 1 && (await obligationCount()) === 1 && rowSys.feedbackRequestedAt?.getTime() === rowDone.feedbackRequestedAt?.getTime());
    as(rp, Role.USER);
    const fb = await feedbackPOST(req({ deliverySpeedRating: 4, communicationRating: 4, functionalityRating: 4, easeOfUseRating: 4, overallRating: 4, requirementsDelivered: true }), p(ro.id));
    check("8.4 Feedback can be submitted while in any COMPLETED-mapped status (201)", fb.status === 201);
    as(admin, Role.ADMIN);
    const reopen = await projectPATCH(req({ statusDefinitionId: review.id }, "PATCH"), p(ro.id));
    as(rp, Role.USER);
    const fbBlocked = await feedbackPOST(req({ deliverySpeedRating: 5, communicationRating: 5, functionalityRating: 5, easeOfUseRating: 5, overallRating: 5, requirementsDelivered: true }), p(ro.id));
    check("8.5 Reopening into a custom IN_PROGRESS status: canonical IN_PROGRESS; Feedback edits blocked (409); response kept", reopen.status === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: ro.id } })).status === "IN_PROGRESS" && fbBlocked.status === 409 && (await prisma.projectFeedback.count({ where: { projectId: ro.id } })) === 1);
    as(admin, Role.ADMIN);
    sentTo = [];
    const recomplete = await projectPATCH(req({ status: "COMPLETED" }, "PATCH"), p(ro.id));
    check("8.6 Re-completing (legacy enum caller): no re-sent request, no duplicate obligation", recomplete.status === 200 && (await notifCount()) === 1 && sentTo.length === 0 && (await obligationCount()) === 1);
    const tracking = (await getProjectFeedbackTrackingOverview({ departmentId: dept.id })).find((r) => r.project.id === ro.id);
    check("8.7 Feedback tracking unaffected by the custom statuses (COMPLETE 1/1)", tracking?.tracking.status === "COMPLETE" && tracking.tracking.submitted.length === 1);

    // ── 9. Workspace transfer ──
    console.log("\n=== 9. Workspace transfer keeps the status definition ===\n");
    await projectPATCH(req({ statusDefinitionId: review.id }, "PATCH"), p(createdDefault.id));
    const transfer = await projectPATCH(req({ departmentId: dept2.id }, "PATCH"), p(createdDefault.id));
    const moved = await prisma.project.findUniqueOrThrow({ where: { id: createdDefault.id } });
    check("9.1 Transferring a Project to another Workspace keeps its (global) custom status", transfer.status === 200 && moved.departmentId === dept2.id && moved.statusDefinitionId === review.id && moved.status === "IN_PROGRESS");

    // ── 10. Filters, dashboard, metrics, export ──
    console.log("\n=== 10. Filters, dashboard breakdown, lifecycle metrics, export ===\n");
    as(admin, Role.ADMIN);
    const backToReview = await projectPATCH(req({ statusDefinitionId: review.id }, "PATCH"), p(pid));
    check("10.0 (fixture) a Project in this Workspace is moved back onto the custom status (200)", backToReview.status === 200);
    const q = await buildProjectListQuery(admin.id, Role.ADMIN, dept.id, { statusId: review.id });
    const qIds = q.denied ? [] : (await prisma.project.findMany({ where: q.where, select: { id: true, statusDefinitionId: true } }));
    check("10.1 List filter by configured status (?statusId=): every returned Project uses that status", qIds.length > 0 && qIds.every((r) => r.statusDefinitionId === review.id) && qIds.some((r) => r.id === pid));
    const qCanonical = await buildProjectListQuery(admin.id, Role.ADMIN, dept.id, { status: "IN_PROGRESS" });
    const canonicalRows = qCanonical.denied ? [] : await prisma.project.findMany({ where: qCanonical.where, select: { statusDefinitionId: true } });
    check("10.2 Legacy canonical ?status= filter still matches every status mapped to that state", canonicalRows.some((r) => r.statusDefinitionId === review.id));
    const dashResult = await getProjectsDashboardData(admin.id, Role.ADMIN, dept.id);
    if ("denied" in dashResult) throw new Error("dashboard denied for ADMIN");
    const dash = dashResult;
    const reviewSlice = dash.byStatus.find((s) => s.name === `${TAG} Reviewing`);
    check("10.3 Dashboard breakdown shows the custom status with its configured label + color", reviewSlice?.color === "#6d28d9" && reviewSlice.value === qIds.length, JSON.stringify(dash.byStatus));
    const lifecycleTotal = dash.activeProjects + dash.completedProjects;
    const deptTotal = await prisma.project.count({ where: { departmentId: dept.id } });
    check("10.4 Lifecycle KPIs stay canonical (active + completed = all Projects in scope)", lifecycleTotal === deptTotal, `${lifecycleTotal} vs ${deptTotal}`);
    const exportRes = await listExportGET(new NextRequest(`http://localhost/api/projects/export?departmentId=${dept.id}&statusId=${review.id}`));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await exportRes.arrayBuffer()) as any);
    const sheet = wb.getWorksheet("Projects")!;
    const header = (sheet.getRow(1).values as any[]).map(String);
    const statusCol = header.indexOf("Status");
    const statusCells: string[] = [];
    sheet.eachRow((row, n) => { if (n > 1) statusCells.push(String(row.getCell(statusCol).value)); });
    check("10.5 Excel export (filtered by ?statusId=) shows the configured status label", exportRes.status === 200 && statusCells.length > 0 && statusCells.every((c) => c === `${TAG} Reviewing`), JSON.stringify(statusCells));

    // ── 11. DB trigger semantics + concurrency ──
    console.log("\n=== 11. DB trigger: consistency backstop, same selection rules as the resolver, concurrency ===\n");
    const { resolveProjectStatusWrite } = await import("@/lib/services/project-status-service");
    const tp = await prisma.project.create({ data: { title: `${TAG} trigger`, departmentId: dept.id, ownerId: admin.id, status: ProjectStatus.PLANNING } });
    ids.projects.push(tp.id);
    const defOf = async (id: string) => (await prisma.project.findUniqueOrThrow({ where: { id }, select: { statusDefinitionId: true, status: true } }));
    // (a) system ON_HOLD inactive + an active custom ON_HOLD alternative.
    await prisma.projectStatusDefinition.update({ where: { id: systemDefs.ON_HOLD.id }, data: { isActive: false } });
    const alt = await prisma.projectStatusDefinition.create({ data: { key: `${TAG.toUpperCase().replace(/-/g, "_")}_ALT`, label: `${TAG} Alt hold`, canonicalStatus: ProjectStatus.ON_HOLD, sortOrder: 31 } });
    ids.defs.push(alt.id);
    const resolverPick = await resolveProjectStatusWrite({ status: ProjectStatus.ON_HOLD }, { status: ProjectStatus.PLANNING, statusDefinitionId: systemDefs.PLANNING.id });
    await prisma.project.update({ where: { id: tp.id }, data: { status: ProjectStatus.ON_HOLD } });
    const afterAlt = await defOf(tp.id);
    check("11.1 Inactive system status + active custom alternative: the trigger picks the ACTIVE alternative, never the inactive system status", afterAlt.statusDefinitionId === alt.id && afterAlt.status === "ON_HOLD");
    check("11.2 ...the SAME definition the application resolver picks", resolverPick.ok && resolverPick.write?.statusDefinitionId === alt.id);
    // (b) no active definition for the requested state.
    await prisma.project.update({ where: { id: tp.id }, data: { status: ProjectStatus.PLANNING } });
    // Deactivate EVERY ON_HOLD definition (incl. the 6.7 fixture "Paused").
    await prisma.projectStatusDefinition.updateMany({ where: { id: { in: [alt.id, holdCustom.id] } }, data: { isActive: false } });
    check("11.2b (fixture) no active ON_HOLD definition remains", (await prisma.projectStatusDefinition.count({ where: { canonicalStatus: ProjectStatus.ON_HOLD, isActive: true } })) === 0);
    let noActive = "";
    try { await prisma.project.update({ where: { id: tp.id }, data: { status: ProjectStatus.ON_HOLD } }); } catch (e: any) { noActive = String(e.message); }
    const afterNoActive = await defOf(tp.id);
    check("11.3 No active definition for the state: a canonical-only write is REJECTED (project_status_no_active_definition), row unchanged", noActive.includes("project_status_no_active_definition") && afterNoActive.status === "PLANNING" && afterNoActive.statusDefinitionId === systemDefs.PLANNING.id);
    let noActiveInsert = "";
    try { await prisma.project.create({ data: { title: `${TAG} insert none active`, departmentId: dept.id, ownerId: admin.id, status: ProjectStatus.ON_HOLD } }); } catch (e: any) { noActiveInsert = String(e.message); }
    check("11.4 ...same for an INSERT with only the canonical state", noActiveInsert.includes("project_status_no_active_definition"));
    const resolverNone = await resolveProjectStatusWrite({ status: ProjectStatus.ON_HOLD }, { status: ProjectStatus.PLANNING, statusDefinitionId: systemDefs.PLANNING.id });
    as(admin, Role.ADMIN);
    const apiNone = await projectPATCH(req({ status: "ON_HOLD" }, "PATCH"), p(tp.id));
    check("11.5 ...consistent with the application: resolver error inactive_status, API → 409", !resolverNone.ok && resolverNone.error.code === "inactive_status" && apiNone.status === 409 && (await apiNone.json()).code === "inactive_status");
    await prisma.projectStatusDefinition.update({ where: { id: systemDefs.ON_HOLD.id }, data: { isActive: true } });
    // (c) unchanged canonical state keeps an inactive custom status.
    await prisma.project.update({ where: { id: tp.id }, data: { status: ProjectStatus.ON_HOLD, statusDefinitionId: alt.id } });
    await prisma.project.update({ where: { id: tp.id }, data: { status: ProjectStatus.ON_HOLD, title: `${TAG} trigger renamed` } });
    check("11.6 Explicit (inactive) definition + unchanged canonical writes keep it — the trigger never re-selects", (await defOf(tp.id)).statusDefinitionId === alt.id);
    // (d) raw writes are NOT the lifecycle workflow.
    const roRaw = await prisma.projectRequest.create({ data: { title: `${TAG} raw`, departmentId: dept.id, requesterId: admin.id, approverId: admin.id, approvedAt: new Date(), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(roRaw.id);
    const rawProject = await prisma.project.create({ data: { title: `${TAG} raw lifecycle`, departmentId: dept.id, ownerId: admin.id, projectRequestId: roRaw.id, status: ProjectStatus.IN_PROGRESS, responsiblePeople: { connect: [{ id: rp.id }] } } });
    ids.projects.push(rawProject.id);
    await prisma.project.update({ where: { id: rawProject.id }, data: { status: ProjectStatus.COMPLETED } });
    const rawRow = await prisma.project.findUniqueOrThrow({ where: { id: rawProject.id } });
    check("11.7 A raw DB write to COMPLETED only keeps the status consistent — no marker, obligation or notification (lifecycle stays in the application)", rawRow.statusDefinitionId === systemDefs.COMPLETED.id && rawRow.feedbackRequestedAt === null && (await prisma.projectFeedbackRequest.count({ where: { projectId: rawProject.id } })) === 0 && (await prisma.notification.count({ where: { link: `/projects/${rawProject.id}/feedback` } })) === 0);
    // (e) concurrency: remap vs assignment, both orders, two real connections.
    const { Client } = await import("pg");
    const url = process.env.DATABASE_URL!.replace(/\?.*$/, "");
    const race = async (first: "remap" | "assign") => {
      const def = await prisma.projectStatusDefinition.create({ data: { key: `${TAG.toUpperCase().replace(/-/g, "_")}_RACE_${first.toUpperCase()}`, label: `${TAG} race ${first}`, canonicalStatus: ProjectStatus.IN_PROGRESS, sortOrder: 99 } });
      ids.defs.push(def.id);
      const proj = await prisma.project.create({ data: { title: `${TAG} race ${first}`, departmentId: dept.id, ownerId: admin.id, status: ProjectStatus.PLANNING } });
      ids.projects.push(proj.id);
      const a = new Client({ connectionString: url }); const b = new Client({ connectionString: url });
      await a.connect(); await b.connect();
      const remapSql = () => a.query(`UPDATE "ProjectStatusDefinition" SET "canonicalStatus"='COMPLETED' WHERE id=$1`, [def.id]);
      const assignSql = () => b.query(`UPDATE "Project" SET "statusDefinitionId"=$1, status='IN_PROGRESS' WHERE id=$2`, [def.id, proj.id]);
      const outcome = (pr: Promise<unknown>) => pr.then(() => "ok", (e) => String(e.message));
      try {
        await a.query("BEGIN"); await b.query("BEGIN");
        let firstRes: string, secondRes: string;
        if (first === "remap") {
          firstRes = await outcome(remapSql());
          const second = outcome(assignSql());
          await new Promise((r) => setTimeout(r, 800));
          await a.query("COMMIT");
          secondRes = await second;
          await b.query(secondRes === "ok" ? "COMMIT" : "ROLLBACK");
        } else {
          firstRes = await outcome(assignSql());
          const second = outcome(remapSql());
          await new Promise((r) => setTimeout(r, 800));
          await b.query("COMMIT");
          secondRes = await second;
          await a.query(secondRes === "ok" ? "COMMIT" : "ROLLBACK");
        }
        const row = await prisma.project.findUniqueOrThrow({ where: { id: proj.id }, select: { status: true, statusDefinition: { select: { canonicalStatus: true } } } });
        return { firstRes, secondRes, consistent: row.status === row.statusDefinition.canonicalStatus };
      } finally { await a.end(); await b.end(); }
    };
    const r1 = await race("remap");
    check("11.8 Concurrent remap THEN assignment: the assignment waits, then is rejected (project_status_mismatch); data stays consistent", r1.firstRes === "ok" && r1.secondRes.includes("project_status_mismatch") && r1.consistent, JSON.stringify(r1));
    const r2 = await race("assign");
    check("11.9 Concurrent assignment THEN remap: the remap waits, then is rejected (project_status_in_use); data stays consistent", r2.firstRes === "ok" && r2.secondRes.includes("project_status_in_use") && r2.consistent, JSON.stringify(r2));
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["feedback", () => prisma.projectFeedback.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["obligations", () => prisma.projectFeedbackRequest.deleteMany({ where: { projectId: { in: ids.projects } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["leftover projects", () => prisma.project.deleteMany({ where: { title: { startsWith: TAG } } })],
      ["defs", () => prisma.projectStatusDefinition.deleteMany({ where: { id: { in: ids.defs } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    // Restore the system definitions' display fields exactly as they were.
    for (const d of originalSystem) await prisma.projectStatusDefinition.update({ where: { id: d.id }, data: { label: d.label, color: d.color, sortOrder: d.sortOrder, isActive: d.isActive } });
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
