/**
 * Project Workspace transfer (PATCH /api/projects/[id] with a new
 * departmentId → lib/services/project-workspace-transfer-service.ts).
 *
 *  1. Authorization: project.edit in the source + project.create in the
 *     destination (ADMIN/DIRECTOR rule as in Project creation); unknown /
 *     ineligible destinations and missing source rights → 403, nothing changes.
 *  2. Atomic transfer of the Project and ALL its Activities (completed
 *     included); only invalid sub-departments cleared; Tickets stay in their
 *     departments with links intact and remain editable.
 *  3. Preservation: Owners, Members, Responsible People, Audience (users,
 *     departments, business units), Activity assignees, statuses, dates,
 *     Expected/Actual Days, cost snapshots, financial totals, notes,
 *     dependencies, the original Project Request.
 *  4. Assignability: existing Members/Assignees kept; NEWLY added ones must
 *     be assignable in the destination.
 *  5. No escalation / exposure: source-only viewers lose access; preserved
 *     users gain no destination access.
 *  6. Rollback: a failure inside the transfer leaves Project + Activities untouched.
 *  7. Realtime: Project AND Activity list invalidations fire.
 *  8. Gantt / Resource Planning follow the transfer; an unchanged save keeps
 *     the previous behaviour; GET exposes options + counts to editors only.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-workspace-transfer.ts
 */
import { mock } from "node:test";
import * as React from "react";
import { Client, type Notification } from "pg";
(globalThis as any).React = React;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out; }
  if (pred(node)) out.push(node);
  const ch = node.props?.children;
  if (ch !== undefined) findAll(ch, pred, out);
  return out;
}
function waitForNotification(client: Client, timeoutMs: number): Promise<Notification | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { client.removeListener("notification", on); resolve(null); }, timeoutMs);
    const on = (msg: Notification) => { clearTimeout(timer); client.removeListener("notification", on); resolve(msg); };
    client.on("notification", on);
  });
}
let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let injectTransferFailure = false;
mock.module("server-only", { namedExports: {} });
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });
const RUN_ID = Date.now();
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  // Failure injection for the rollback check: wraps the REAL transfer so it
  // runs (activities updated inside the transaction) and then throws.
  const realTransfer = await import("@/lib/services/project-workspace-transfer-service");
  mock.module("@/lib/services/project-workspace-transfer-service", {
    namedExports: {
      ...realTransfer,
      transferProjectActivitiesInTransaction: async (...args: Parameters<typeof realTransfer.transferProjectActivitiesInTransaction>) => {
        const result = await realTransfer.transferProjectActivitiesInTransaction(...args);
        if (injectTransferFailure) throw new Error("injected transfer failure");
        return result;
      },
    },
  });

  const { prisma } = await import("@/lib/prisma");
  const { NextRequest } = await import("next/server");
  const { Role, AuthProvider, DepartmentRole, MembershipSource, ActivityStatus, ActivityPriority, ProjectStatus, TicketSource } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const projectRoute = await import("@/app/api/projects/[id]/route");
  const activityRoute = await import("@/app/api/activities/[id]/route");
  const ticketRoute = await import("@/app/api/tickets/[id]/route");
  const { hasProjectViewAccess } = await import("@/lib/services/project-access-service");
  const { getResourcePlanningEvents, getResourcePlanningData } = await import("@/lib/services/resource-planning-service");
  const { hasEffectiveEntityPermission } = await import("@/lib/services/department-scope-service");
  const { default: ProjectGanttPage } = await import("@/app/(main)/projects/gantt/page");
  const { PROJECT_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/project-list-invalidation");
  const { ACTIVITY_LIST_CHANGED_CHANNEL } = await import("@/lib/realtime/activity-list-invalidation");

  const projectListener = new Client({ connectionString: process.env.DATABASE_URL });
  const activityListener = new Client({ connectionString: process.env.DATABASE_URL });
  await projectListener.connect(); await projectListener.query(`LISTEN ${PROJECT_LIST_CHANGED_CHANNEL}`);
  await activityListener.connect(); await activityListener.query(`LISTEN ${ACTIVITY_LIST_CHANGED_CHANNEL}`);

  const ids = { depts: [] as string[], users: [] as string[], roles: [] as string[], roleKeys: [] as string[], projects: [] as string[], activities: [] as string[], tickets: [] as string[], requests: [] as string[], subDepts: [] as string[], bus: [] as string[], companies: [] as string[] };
  const req = (method: string, b?: unknown) => new NextRequest("http://localhost/x", { method, headers: b ? { "content-type": "application/json" } : undefined, body: b ? JSON.stringify(b) : undefined });
  const patchProject = (id: string, b: unknown) => projectRoute.PATCH(req("PATCH", b), { params: Promise.resolve({ id }) });
  const getProject = async (id: string) => (await projectRoute.GET(req("GET"), { params: Promise.resolve({ id }) })).json();
  const as = (u: { id: string }, role: any = Role.USER) => { currentSession = { user: { id: u.id, role, customRoleId: null } }; };
  const user = async (tag: string, role: any = Role.USER) => { const u = await prisma.user.create({ data: { email: `pwt-${tag}-${RUN_ID}@kinsen.gr`, name: `PWT ${tag} ${RUN_ID}`, role, authProvider: AuthProvider.CREDENTIALS, isActive: true } }); ids.users.push(u.id); return u; };
  const role = async (tag: string, keys: string[]) => {
    const r = await prisma.customRole.create({ data: { key: `PWT_${tag}_${RUN_ID}`, name: `PWT ${tag} ${RUN_ID}`, isBuiltIn: false, scope: "DEPARTMENT" as any, isActive: true } });
    ids.roles.push(r.id); ids.roleKeys.push(r.key);
    for (const k of keys) await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: k } })).id } });
    return r;
  };
  const member = (userId: string, departmentId: string, customRoleId: string) => prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.VIEWER, customRoleId, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
  const projectState = (id: string) => prisma.project.findUniqueOrThrow({ where: { id }, include: { owners: { select: { id: true } }, members: { select: { id: true } }, responsiblePeople: { select: { id: true } }, audience: { select: { id: true } }, audienceDepartments: { select: { id: true } }, audienceBusinessUnits: { select: { id: true } } } });
  const activityState = (projectId: string) => prisma.projectActivity.findMany({ where: { projectId }, orderBy: { title: "asc" }, include: { assignedUsers: { select: { id: true } } } });
  const sortedIds = (xs: { id: string }[]) => xs.map((x) => x.id).sort().join(",");

  try {
    const deptA = await createDepartment({ name: `PWT A ${RUN_ID}`, slug: `pwt-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `PWT B ${RUN_ID}`, slug: `pwt-b-${RUN_ID}` });
    const deptC = await createDepartment({ name: `PWT C ${RUN_ID}`, slug: `pwt-c-${RUN_ID}` });
    const audienceDept = await createDepartment({ name: `PWT Audience ${RUN_ID}`, slug: `pwt-aud-${RUN_ID}` });
    ids.depts.push(deptA.id, deptB.id, deptC.id, audienceDept.id);
    const subA = await prisma.subDepartment.create({ data: { name: `PWT SubA ${RUN_ID}`, departmentId: deptA.id } });
    const subB = await prisma.subDepartment.create({ data: { name: `PWT SubB ${RUN_ID}`, departmentId: deptB.id } });
    ids.subDepts.push(subA.id, subB.id);
    const existingCompany = await prisma.company.findFirst({ select: { id: true } });
    const company = existingCompany ?? (await prisma.company.create({ data: { name: `PWT Company ${RUN_ID}`, normalizedName: `pwt company ${RUN_ID}` } }));
    if (!existingCompany) ids.companies.push(company.id);
    const bu = await prisma.businessUnit.create({ data: { name: `PWT BU ${RUN_ID}`, companyId: company.id } });
    ids.bus.push(bu.id);

    const editRole = await role("EDIT", ["project.view", "project.edit", "activity.view", "activity.edit"]);
    const createRole = await role("CREATE", ["project.view", "project.create"]);
    const viewRole = await role("VIEW", ["project.view", "activity.view"]);
    // Destination role for the editor: may create Projects there AND keep editing the Project/Activities after they arrive.
    const createEditRole = await role("CREATEEDIT", ["project.view", "project.create", "project.edit", "activity.view", "activity.edit"]);
    const projAssignable = await role("PASSIGN", ["project.assignable"]);
    const actAssignable = await role("AASSIGN", ["activity.assignable"]);
    const editor = await user("editor"); await member(editor.id, deptA.id, editRole.id); await member(editor.id, deptB.id, createEditRole.id);
    const editorNoDest = await user("nodest"); await member(editorNoDest.id, deptA.id, editRole.id);
    const createOnly = await user("createonly"); await member(createOnly.id, deptB.id, createRole.id);
    const viewerA = await user("viewerA"); await member(viewerA.id, deptA.id, viewRole.id);
    const memberA = await user("memberA"); await member(memberA.id, deptA.id, projAssignable.id);
    const memberB = await user("memberB"); await member(memberB.id, deptB.id, projAssignable.id);
    const assigneeA = await user("assigneeA"); await member(assigneeA.id, deptA.id, actAssignable.id);
    const outsider = await user("outsider");
    const owner = await user("owner");
    const responsible = await user("responsible");
    const audienceUser = await user("audience");
    const admin = await user("admin", Role.ADMIN);
    // DIRECTOR: project.edit in A via membership, NO membership in B — the
    // previous transfer rule has no DIRECTOR / view-all bypass.
    const director = await user("director", Role.DIRECTOR); await member(director.id, deptA.id, editRole.id);

    const project = await prisma.project.create({
      data: {
        title: `PWT Manual ${RUN_ID}`, departmentId: deptA.id, subDepartmentId: subA.id, ownerId: owner.id, status: ProjectStatus.IN_PROGRESS,
        startDate: D("2027-01-04"), endDate: D("2027-02-26"),
        owners: { connect: [{ id: owner.id }] }, members: { connect: [{ id: memberA.id }] }, responsiblePeople: { connect: [{ id: responsible.id }] },
        audience: { connect: [{ id: audienceUser.id }] }, audienceDepartments: { connect: [{ id: audienceDept.id }] }, audienceBusinessUnits: { connect: [{ id: bu.id }] },
      },
    });
    ids.projects.push(project.id);
    const mkAct = async (title: string, data: Record<string, unknown>) => {
      const a = await prisma.projectActivity.create({ data: { title: `${title} ${RUN_ID}`, projectId: project.id, departmentId: deptA.id, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.MEDIUM, ...data } });
      ids.activities.push(a.id);
      return a;
    };
    const act1 = await mkAct("A1 completed", { status: ActivityStatus.COMPLETED, isCompleted: true, completedAt: D("2027-01-20"), subDepartmentId: subA.id, assignedUsers: { connect: [{ id: assigneeA.id }] }, startDate: D("2027-01-04"), dueDate: D("2027-01-15"), expectedStartDate: D("2027-01-04"), expectedFinishDate: D("2027-01-14"), expectedDays: 8, actualDays: 11, taskSubTypeCost: "120.00" });
    const act2 = await mkAct("A2 legacy null dept", { departmentId: null, startDate: D("2027-01-18"), dueDate: D("2027-01-22"), expectedDays: 3, taskSubTypeCost: "100.00" });
    const act3 = await mkAct("A3 dest subdept", { subDepartmentId: subB.id, assignedUsers: { connect: [{ id: assigneeA.id }] }, startDate: D("2027-02-01"), dueDate: D("2027-02-05") });
    await prisma.activityDependency.create({ data: { predecessorId: act1.id, successorId: act2.id, type: "FINISH_TO_START" } });
    await prisma.projectNote.create({ data: { projectId: project.id, authorId: owner.id, body: "Project note" } });
    await prisma.activityNote.create({ data: { activityId: act1.id, authorId: owner.id, body: "Activity note" } });
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id } });
    const ticket = await prisma.ticket.create({ data: { title: `PWT Ticket ${RUN_ID}`, description: "linked", source: TicketSource.WEB, requesterId: owner.id, departmentId: deptA.id, statusId: status.id, projectId: project.id, activityId: act1.id } });
    ids.tickets.push(ticket.id);

    const before = await projectState(project.id);
    const actsBefore = await activityState(project.id);
    as(admin, Role.ADMIN);
    const finBefore = await getProject(project.id);

    console.log("\n=== 1. Authorization ===\n");
    as(editor);
    const g = await getProject(project.id);
    check("GET (editor): Workspace options = current (A) + destinations with project.create (B), not C; counts 3 Activities / 1 Ticket", g.workspaceTransfer && g.workspaceTransfer.options.some((o: any) => o.id === deptA.id) && g.workspaceTransfer.options.some((o: any) => o.id === deptB.id) && !g.workspaceTransfer.options.some((o: any) => o.id === deptC.id) && g.workspaceTransfer.activityCount === 3 && g.workspaceTransfer.linkedTicketCount === 1, JSON.stringify(g.workspaceTransfer));
    as(viewerA);
    check("GET (view-only): no Workspace transfer data exposed", (await getProject(project.id)).workspaceTransfer === null);
    as(editorNoDest);
    let r = await patchProject(project.id, { departmentId: deptB.id });
    check("project.edit in A but no project.create in B → 403 forbidden_destination", r.status === 403 && (await r.json()).code === "forbidden_destination");
    as(createOnly);
    r = await patchProject(project.id, { departmentId: deptB.id });
    check("project.create in B but no project.edit in A → 403", r.status === 403);
    as(editor);
    r = await patchProject(project.id, { departmentId: deptC.id });
    check("Destination C without project.create → 403", r.status === 403);
    r = await patchProject(project.id, { departmentId: "no-such-department" });
    check("Unknown destination → 403", r.status === 403);
    as(director, Role.DIRECTOR);
    const gDir = await getProject(project.id);
    r = await patchProject(project.id, { departmentId: deptB.id });
    check("DIRECTOR without a destination membership → 403 forbidden_destination (no view-all bypass), and B isn't offered", r.status === 403 && (await r.json()).code === "forbidden_destination" && !!gDir.workspaceTransfer && !gDir.workspaceTransfer.options.some((o: any) => o.id === deptB.id), JSON.stringify(gDir.workspaceTransfer?.options?.map((o: any) => o.id)));
    as(editor);
    check("...after all rejected attempts nothing moved (Project + Activities still in A)", (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).departmentId === deptA.id && (await activityState(project.id)).every((a) => a.departmentId === deptA.id || (a.id === act2.id && a.departmentId === null)));

    console.log("\n=== 2. Assignability for NEW members only ===\n");
    r = await patchProject(project.id, { departmentId: deptB.id, memberIds: [memberA.id, outsider.id] });
    check("Transfer that also ADDS a member not assignable in B → 400, nothing moved", r.status === 400 && (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).departmentId === deptA.id);

    console.log("\n=== 3. Rollback ===\n");
    injectTransferFailure = true;
    r = await patchProject(project.id, { departmentId: deptB.id, memberIds: [memberA.id] });
    injectTransferFailure = false;
    const afterFail = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const actsAfterFail = await activityState(project.id);
    check("Failure inside the transfer → 500 and a complete rollback (Project dept/sub-dept and every Activity unchanged)", r.status === 500 && afterFail.departmentId === deptA.id && afterFail.subDepartmentId === subA.id && JSON.stringify(actsAfterFail.map((a) => [a.id, a.departmentId, a.subDepartmentId])) === JSON.stringify(actsBefore.map((a) => [a.id, a.departmentId, a.subDepartmentId])));

    console.log("\n=== 4. Transfer ===\n");
    const waitP = waitForNotification(projectListener, 5000);
    const waitA = waitForNotification(activityListener, 5000);
    // Full-snapshot edit-form-style save with the preserved (non-B-assignable) member memberA + a new B-assignable member.
    r = await patchProject(project.id, { departmentId: deptB.id, title: project.title, memberIds: [memberA.id, memberB.id], audienceIds: [audienceUser.id], audienceDepartmentIds: [audienceDept.id], audienceBusinessUnitIds: [bu.id], responsiblePeopleIds: [responsible.id], subDepartmentId: null });
    check("Authorized transfer A → B → 200", r.status === 200, String(r.status));
    check("Realtime: Project-list invalidation published", (await waitP) !== null);
    check("Realtime: Activity-list invalidation published (Activities moved)", (await waitA) !== null);
    const after = await projectState(project.id);
    const actsAfter = await activityState(project.id);
    check("Project now in B; its source sub-department cleared", after.departmentId === deptB.id && after.subDepartmentId === null);
    check("ALL Activities moved to B (completed and legacy null-department included)", actsAfter.length === 3 && actsAfter.every((a) => a.departmentId === deptB.id));
    const a1 = actsAfter.find((a) => a.id === act1.id)!, a3 = actsAfter.find((a) => a.id === act3.id)!;
    check("Only INVALID sub-departments cleared (A1's A sub-dept cleared; A3's B sub-dept kept)", a1.subDepartmentId === null && a3.subDepartmentId === subB.id);
    check("Owners, Responsible People, Audience users/departments/business units preserved", sortedIds(after.owners) === sortedIds(before.owners) && sortedIds(after.responsiblePeople) === sortedIds(before.responsiblePeople) && sortedIds(after.audience) === sortedIds(before.audience) && sortedIds(after.audienceDepartments) === sortedIds(before.audienceDepartments) && sortedIds(after.audienceBusinessUnits) === sortedIds(before.audienceBusinessUnits));
    check("Existing member (not assignable in B) preserved; new B-assignable member added", sortedIds(after.members) === [memberA.id, memberB.id].sort().join(","));
    check("Activity assignees preserved (assignee not assignable in B kept on A1 and A3)", a1.assignedUsers.some((u) => u.id === assigneeA.id) && a3.assignedUsers.some((u) => u.id === assigneeA.id));
    check("Statuses, dates, Expected/Actual Days and cost snapshots unchanged", actsAfter.every((a) => { const b = actsBefore.find((x) => x.id === a.id)!; return a.status === b.status && a.isCompleted === b.isCompleted && +(a.startDate ?? 0) === +(b.startDate ?? 0) && +(a.dueDate ?? 0) === +(b.dueDate ?? 0) && +(a.expectedStartDate ?? 0) === +(b.expectedStartDate ?? 0) && a.expectedDays === b.expectedDays && a.actualDays === b.actualDays && String(a.taskSubTypeCost) === String(b.taskSubTypeCost) && +(a.completedAt ?? 0) === +(b.completedAt ?? 0); }));
    check("Project dates unchanged", +after.startDate! === +before.startDate! && +after.endDate! === +before.endDate!);
    as(admin, Role.ADMIN);
    const finAfter = await getProject(project.id);
    check("Financial totals unchanged (Estimated/Actual Cost)", finAfter.estimatedCost === finBefore.estimatedCost && finAfter.actualCost === finBefore.actualCost, `${finBefore.estimatedCost}/${finBefore.actualCost} → ${finAfter.estimatedCost}/${finAfter.actualCost}`);
    check("Notes and dependencies preserved", (await prisma.projectNote.count({ where: { projectId: project.id } })) === 1 && (await prisma.activityNote.count({ where: { activityId: act1.id } })) === 1 && (await prisma.activityDependency.count({ where: { predecessorId: act1.id, successorId: act2.id } })) === 1);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    check("Linked Ticket stays in A with its project + activity links intact", t.departmentId === deptA.id && t.projectId === project.id && t.activityId === act1.id);
    as(admin, Role.ADMIN);
    const tPatch = await ticketRoute.PATCH(req("PATCH", { title: `PWT Ticket ${RUN_ID} renamed` }), { params: Promise.resolve({ id: ticket.id }) });
    check("...and remains editable (unrelated field) — Ticket link rules unchanged", tPatch.status === 200 && (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).projectId === project.id);

    console.log("\n=== 5. No escalation / exposure ===\n");
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    check("A source-only viewer can no longer view the transferred Project", !(await hasProjectViewAccess(viewerA.id, Role.USER, null, proj)));
    check("The preserved member (no standing in B) gains no access to it", !(await hasProjectViewAccess(memberA.id, Role.USER, null, proj)));
    check("No Workspace membership was granted to preserved users", (await prisma.departmentMembership.count({ where: { userId: { in: [memberA.id, assigneeA.id, owner.id, responsible.id, audienceUser.id] }, departmentId: deptB.id } })) === 0);
    check("Audience user keeps exactly their existing Audience access", await hasProjectViewAccess(audienceUser.id, Role.USER, null, proj));

    console.log("\n=== 6. Activity assignees after transfer ===\n");
    as(editor);
    const keepRes = await activityRoute.PATCH(req("PATCH", { title: `A3 dest subdept ${RUN_ID}`, assignedUserIds: [assigneeA.id] }), { params: Promise.resolve({ id: act3.id }) });
    check("Editing a moved Activity while KEEPING its existing (non-B-assignable) assignee → 200", keepRes.status === 200, String(keepRes.status));
    const addRes = await activityRoute.PATCH(req("PATCH", { assignedUserIds: [assigneeA.id, outsider.id] }), { params: Promise.resolve({ id: act3.id }) });
    check("ADDING an assignee not assignable in B → 400 assignee_not_assignable", addRes.status === 400 && (await addRes.json()).code === "assignee_not_assignable");

    console.log("\n=== 6b. Resource Planning keeps retained assignees without offering them as targets ===\n");
    as(admin, Role.ADMIN);
    const rpData = await getResourcePlanningData({ userId: admin.id, role: Role.ADMIN }, { departmentId: deptB.id, rangeStart: D("2027-01-01"), rangeEnd: D("2027-02-28") });
    const retainedRow = !rpData.denied ? rpData.resources.find((x) => x.id === assigneeA.id) : undefined;
    check("RP (B): the retained assignee (not eligible in B) still has a row with their moved Activities, tagged as NOT a valid new-assignment target", !!retainedRow && retainedRow.assignableFor.length === 0 && !rpData.denied && rpData.events.some((e) => e.id === act3.id && e.assignedUserIds.includes(assigneeA.id)), JSON.stringify(retainedRow));
    // Compared with `outsider` (same built-in USER role, no memberships, no
    // relationship to this Project): retention must add nothing. (The
    // built-in global USER role itself grants activity.view org-wide — a
    // pre-existing global grant, identical for both.)
    const effective = async (uid: string) => Promise.all(["project.view", "project.edit", "activity.view", "activity.edit", "project.create", "activity.create"].map((k) => hasEffectiveEntityPermission(uid, Role.USER, null, deptB.id, k)));
    check("...and retention grants the assignee nothing extra in B (effective permissions identical to an unrelated user)", JSON.stringify(await effective(assigneeA.id)) === JSON.stringify(await effective(outsider.id)), JSON.stringify({ retained: await effective(assigneeA.id), outsider: await effective(outsider.id) }));

    console.log("\n=== 6c. Removing then re-adding an ineligible user is rejected ===\n");
    as(editor);
    const removeAssignee = await activityRoute.PATCH(req("PATCH", { assignedUserIds: [] }), { params: Promise.resolve({ id: act1.id }) });
    const readdAssignee = await activityRoute.PATCH(req("PATCH", { assignedUserIds: [assigneeA.id] }), { params: Promise.resolve({ id: act1.id }) });
    check("Activity: removing the retained ineligible assignee → 200; re-adding them → 400 assignee_not_assignable (stays removed)", removeAssignee.status === 200 && readdAssignee.status === 400 && (await readdAssignee.json()).code === "assignee_not_assignable" && (await prisma.projectActivity.findUniqueOrThrow({ where: { id: act1.id }, include: { assignedUsers: true } })).assignedUsers.length === 0);
    const removeMember = await patchProject(project.id, { memberIds: [memberB.id] });
    const readdMember = await patchProject(project.id, { memberIds: [memberA.id, memberB.id] });
    const membersNow = (await projectState(project.id)).members.map((m) => m.id);
    check("Project: removing the retained ineligible member → 200; re-adding them → 400 assignee_not_assignable (stays removed)", removeMember.status === 200 && readdMember.status === 400 && (await readdMember.json()).code === "assignee_not_assignable" && membersNow.length === 1 && membersNow[0] === memberB.id);
    // Restore the member snapshot the later "unchanged save" check sends.
    await prisma.project.update({ where: { id: project.id }, data: { members: { connect: [{ id: memberA.id }] } } });

    console.log("\n=== 7. Gantt / Resource Planning ===\n");
    as(admin, Role.ADMIN);
    const ganttGroups = async (deptId: string) => findAll(await ProjectGanttPage({ searchParams: Promise.resolve({ departmentId: deptId }) }), (n) => Array.isArray(n.props?.groups))[0]?.props.groups ?? [];
    const gB = (await ganttGroups(deptB.id)).find((x: any) => x.id === project.id);
    check("Project Gantt (B) shows the Project with all 3 Activities; Gantt (A) no longer shows it", !!gB && gB.children.length === 3 && !(await ganttGroups(deptA.id)).some((x: any) => x.id === project.id));
    const rpB = await getResourcePlanningEvents({ departmentId: deptB.id, rangeStart: D("2027-01-01"), rangeEnd: D("2027-02-28") });
    const rpA = await getResourcePlanningEvents({ departmentId: deptA.id, rangeStart: D("2027-01-01"), rangeEnd: D("2027-02-28") });
    const inRp = (r: any, id: string) => [...r.events, ...r.unscheduled].some((e: any) => e.id === id);
    check("Resource Planning (B) has the moved Activities; Resource Planning (A) no longer does", [act1.id, act3.id].every((id) => inRp(rpB, id)) && ![act1.id, act3.id].some((id) => inRp(rpA, id)));

    console.log("\n=== 8. Unchanged save + Request-origin Project ===\n");
    as(editor);
    const noopWaitA = waitForNotification(activityListener, 1500);
    const plain = await patchProject(project.id, { title: `${project.title} renamed`, memberIds: [memberA.id, memberB.id] });
    const plainState = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    check("Save WITHOUT a Workspace change: 200, department unchanged, Activities untouched", plain.status === 200 && plainState.departmentId === deptB.id && (await activityState(project.id)).every((a) => a.departmentId === deptB.id));
    check("...only the title-rename Activity invalidation fires (existing behaviour)", (await noopWaitA) !== null);

    const pr = await prisma.projectRequest.create({ data: { title: `PWT Request ${RUN_ID}`, departmentId: deptA.id, requesterId: owner.id, approverId: admin.id, approvedAt: D("2026-11-01"), status: "APPROVED", source: "STANDARD" } });
    ids.requests.push(pr.id);
    const ro = await prisma.project.create({ data: { title: `PWT RO ${RUN_ID}`, departmentId: deptA.id, ownerId: owner.id, owners: { connect: [{ id: owner.id }] }, projectRequestId: pr.id, expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-12"), expectedTotalInitialDays: 9 } });
    ids.projects.push(ro.id);
    const roAct = await prisma.projectActivity.create({ data: { title: `PWT RO Act ${RUN_ID}`, projectId: ro.id, departmentId: deptA.id, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, expectedStartDate: D("2027-03-01"), expectedFinishDate: D("2027-03-05"), expectedDays: 6, taskSubTypeCost: "200.00" } });
    ids.activities.push(roAct.id);
    const prBefore = await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr.id } });
    as(editor);
    r = await patchProject(ro.id, { departmentId: deptB.id, subDepartmentId: subB.id });
    const roAfter = await prisma.project.findUniqueOrThrow({ where: { id: ro.id } });
    const roActAfter = await prisma.projectActivity.findUniqueOrThrow({ where: { id: roAct.id } });
    check("Request-origin Project transfer → 200; Project (with a valid destination sub-department) and Activity in B", r.status === 200 && roAfter.departmentId === deptB.id && roAfter.subDepartmentId === subB.id && roActAfter.departmentId === deptB.id);
    check("...Expected Days (6), Expected Total Initial Days (9) and cost snapshot unchanged", roActAfter.expectedDays === 6 && roAfter.expectedTotalInitialDays === 9 && String(roActAfter.taskSubTypeCost) === "200");
    check("...the original Project Request and its approval data are unchanged", JSON.stringify(await prisma.projectRequest.findUniqueOrThrow({ where: { id: pr.id } })) === JSON.stringify(prBefore));
    const adminProject = await prisma.project.create({ data: { title: `PWT Admin ${RUN_ID}`, departmentId: deptA.id, ownerId: owner.id, owners: { connect: [{ id: owner.id }] } } });
    ids.projects.push(adminProject.id);
    as(admin, Role.ADMIN);
    r = await patchProject(adminProject.id, { departmentId: deptC.id });
    check("ADMIN exception preserved: ADMIN (no memberships) transfers to C → 200", r.status === 200 && (await prisma.project.findUniqueOrThrow({ where: { id: adminProject.id } })).departmentId === deptC.id);
  } finally {
    const steps: [string, () => Promise<unknown>][] = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ids.tickets } } })],
      ["deps", () => prisma.activityDependency.deleteMany({ where: { OR: [{ predecessorId: { in: ids.activities } }, { successorId: { in: ids.activities } }] } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: ids.activities } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: ids.projects } } })],
      ["requests", () => prisma.projectRequest.deleteMany({ where: { id: { in: ids.requests } } })],
      ["sub depts", () => prisma.subDepartment.deleteMany({ where: { id: { in: ids.subDepts } } })],
      ["bus", () => prisma.businessUnit.deleteMany({ where: { id: { in: ids.bus } } })],
      ["companies", () => prisma.company.deleteMany({ where: { id: { in: ids.companies } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: ids.users } } })],
      ["ticket history", () => prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ids.tickets } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.users } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: ids.users } } })],
      ["role perms", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: ids.roleKeys } } })],
      ["roles", () => prisma.customRole.deleteMany({ where: { id: { in: ids.roles } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: ids.depts } } })],
      ["depts", () => prisma.department.deleteMany({ where: { id: { in: ids.depts } } })],
    ];
    for (const [l, fn] of steps) { try { await fn(); } catch (e: any) { console.warn(`cleanup ${l} failed: ${String(e.message).split("\n")[0]}`); } }
    await projectListener.end().catch(() => {});
    await activityListener.end().catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
