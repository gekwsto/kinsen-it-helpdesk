/**
 * Mention Reminders (Project + Activity Note mentions only) — scheduling,
 * response cancellation, eligibility, admin delay, user preference, the
 * worker's atomic/idempotent/recoverable processing, and auth of every new
 * endpoint. Real routes + real DB; time is an injected `now` (no waits).
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-mention-reminders.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role, RoleScope } from "@prisma/client";
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

let currentSession: { user: { id: string; name: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

const RUN_ID = Date.now();
const MIN = 60_000;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  const projectNotes = await import("@/app/api/projects/[id]/notes/route");
  const activityNotes = await import("@/app/api/activities/[id]/notes/route");
  const ticketReply = await import("@/app/api/tickets/[id]/reply/route");
  const svc = await import("@/lib/services/mention-reminder-service");
  const cfg = await import("@/lib/mention-reminders/config");
  const workerRoute = await import("@/app/api/internal/mention-reminders/process/route");
  const prefRoute = await import("@/app/api/users/me/mention-reminders/route");
  const adminRoute = await import("@/app/api/admin/mention-reminders/route");

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];
  const originalSettings = await prisma.mentionReminderSettings.findUnique({ where: { id: "default" } });

  type Subject = { id: string; name: string; role: Role; customRoleId: string | null };
  const as = (s: Subject | null) => {
    currentSession = s ? { user: { id: s.id, name: s.name, role: s.role, customRoleId: s.customRoleId } } : null;
  };
  async function makeRole(tag: string, scope: RoleScope, keys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `MR_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    roleIds.push(r.id);
    roleKeys.push(r.key);
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  async function makeUser(tag: string, role: Role, customRoleId: string | null, extra: Record<string, unknown> = {}): Promise<Subject> {
    const u = await prisma.user.create({ data: { email: `mr-${tag}-${RUN_ID}@kinsen.gr`, name: `MR ${tag}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true, ...extra } });
    userIds.push(u.id);
    return { id: u.id, name: u.name!, role, customRoleId };
  }
  async function member(userId: string, departmentId: string, customRoleId: string, isActive = true) {
    return prisma.departmentMembership.create({ data: { userId, departmentId, role: DepartmentRole.REQUESTER, customRoleId, source: MembershipSource.MANUAL, isActive } });
  }
  const jsonReq = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/x", { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  try {
    const deptA = await createDepartment({ name: `MR-A-${RUN_ID}`, slug: `mr-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `MR-B-${RUN_ID}`, slug: `mr-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const EDIT_KEYS = ["project.view", "project.edit", "activity.view", "activity.edit"];
    const VIEW_KEYS = ["project.view", "activity.view"];
    const noop = await makeRole("NOOP", RoleScope.GLOBAL, []);
    const deptEdit = await makeRole("DEPT_EDIT", RoleScope.DEPARTMENT, EDIT_KEYS);
    const deptView = await makeRole("DEPT_VIEW", RoleScope.DEPARTMENT, VIEW_KEYS);
    const globalEdit = await makeRole("GLOBAL_EDIT", RoleScope.GLOBAL, EDIT_KEYS);

    const author = await makeUser("author", Role.ADMIN, null);
    const editor = await makeUser("editor", Role.USER, noop.id);
    const editorMembership = await member(editor.id, deptA.id, deptEdit.id);
    const adminMentionee = await makeUser("admin-mentionee", Role.ADMIN, null); // eligible for ticket-note mentions
    const editor2 = await makeUser("editor2", Role.USER, noop.id);
    await member(editor2.id, deptA.id, deptEdit.id);
    const viewer = await makeUser("viewer", Role.USER, noop.id);
    await member(viewer.id, deptA.id, deptView.id);
    const globalUser = await makeUser("global-edit", Role.USER, globalEdit.id); // no DepartmentMembership
    const optedOut = await makeUser("opted-out", Role.USER, noop.id, { mentionRemindersEnabled: false });
    await member(optedOut.id, deptA.id, deptEdit.id);
    const deptAOnly = await makeUser("dept-a-only", Role.USER, noop.id);
    await member(deptAOnly.id, deptA.id, deptEdit.id);

    const freshProject = async (departmentId = deptA.id, title = `MR Project ${RUN_ID}-${projectIds.length}`) => {
      const p = await prisma.project.create({ data: { title, departmentId, ownerId: author.id } });
      projectIds.push(p.id);
      return p;
    };
    const freshActivity = async (departmentId = deptA.id, title = `MR Activity ${RUN_ID}-${activityIds.length}`) => {
      const a = await prisma.projectActivity.create({ data: { title, departmentId } });
      activityIds.push(a.id);
      return a;
    };
    const postProject = async (who: Subject, id: string, mentionUserIds: string[] = []) => {
      as(who);
      const res = await projectNotes.POST(jsonReq("POST", { body: "note body SECRET-TEXT", mentionUserIds }), { params: Promise.resolve({ id }) });
      return { res, json: res.status === 201 ? await res.clone().json() : null };
    };
    const postActivity = async (who: Subject, id: string, mentionUserIds: string[] = []) => {
      as(who);
      const res = await activityNotes.POST(jsonReq("POST", { body: "note body SECRET-TEXT", mentionUserIds }), { params: Promise.resolve({ id }) });
      return { res, json: res.status === 201 ? await res.clone().json() : null };
    };
    const projReminders = (projectId: string, userId?: string) =>
      prisma.mentionReminder.findMany({ where: { projectNoteMention: { note: { projectId }, ...(userId ? { userId } : {}) } }, include: { projectNoteMention: true } });
    const actReminders = (activityId: string, userId?: string) =>
      prisma.mentionReminder.findMany({ where: { activityNoteMention: { note: { activityId }, ...(userId ? { userId } : {}) } }, include: { activityNoteMention: true } });
    const reminderNotifs = (userId: string, linkPrefix: string) =>
      prisma.notification.findMany({ where: { userId, title: svc.REMINDER_TITLE, link: { startsWith: linkPrefix } } });
    const afterDue = (r: { dueAt: Date }) => new Date(r.dueAt.getTime() + 1000);

    // ── 1–5: scheduling + delay ──
    console.log("\nScheduling ===\n");
    check("4. default delay is exactly 24 hours (1440 min) when nothing is configured", (await svc.getMentionReminderDelayMinutes()) === 1440 || !!originalSettings);
    await prisma.mentionReminderSettings.deleteMany({});
    check("4b. no settings row => DEFAULT_MENTION_REMINDER_DELAY_MINUTES = 24h", (await svc.getMentionReminderDelayMinutes()) === 24 * 60 && cfg.DEFAULT_MENTION_REMINDER_DELAY_MINUTES === 1440);

    const p1 = await freshProject();
    const n1 = await postProject(author, p1.id, [editor.id]);
    const r1 = await projReminders(p1.id, editor.id);
    check("1. Project mention schedules exactly one PENDING reminder", n1.res.status === 201 && r1.length === 1 && r1[0].status === "PENDING");
    check("4c. dueAt = mention.createdAt + exactly 24h", r1[0].dueAt.getTime() === r1[0].projectNoteMention!.createdAt.getTime() + 24 * 60 * MIN);

    const a1 = await freshActivity();
    await postActivity(author, a1.id, [editor.id]);
    const ar1 = await actReminders(a1.id, editor.id);
    check("2. Activity mention schedules a reminder", ar1.length === 1 && ar1[0].status === "PENDING" && ar1[0].projectNoteMentionId === null);

    // 3. Ticket internal note mention never schedules one.
    const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    const ticket = await prisma.ticket.create({ data: { title: `MR Ticket ${RUN_ID}`, description: "x", requesterId: author.id, departmentId: deptA.id, statusId: defaultStatus!.id } });
    ticketIds.push(ticket.id);
    const remindersBefore = await prisma.mentionReminder.count();
    as(author);
    const tRes = await ticketReply.POST(jsonReq("POST", { body: "internal", isInternal: true, direction: "INTERNAL_NOTE", mentionUserIds: [adminMentionee.id] }), { params: Promise.resolve({ id: ticket.id }) });
    const ticketMentions = await prisma.ticketMessageMention.count({ where: { message: { ticketId: ticket.id } } });
    check("3. Ticket Internal Note mention persisted but creates NO reminder", tRes.status === 201 && ticketMentions === 1 && (await prisma.mentionReminder.count()) === remindersBefore, `status ${tRes.status} mentions ${ticketMentions} before ${remindersBefore} after ${await prisma.mentionReminder.count()}`);

    // 5. Admin-configured delay determines dueAt.
    await svc.updateMentionReminderDelay(2 * 60, author.id);
    const p2 = await freshProject();
    await postProject(author, p2.id, [editor.id]);
    const r2 = await projReminders(p2.id, editor.id);
    check("5. configured delay (2h) determines dueAt", r2[0].dueAt.getTime() === r2[0].projectNoteMention!.createdAt.getTime() + 120 * MIN);

    // 6. delay change recalculates PENDING only.
    const sentSeed = await prisma.mentionReminder.update({ where: { id: r2[0].id }, data: { status: "SENT", sentAt: new Date() } });
    const p2b = await freshProject();
    await postProject(author, p2b.id, [editor.id]);
    const pendingBefore = (await projReminders(p2b.id, editor.id))[0];
    const changed = await svc.updateMentionReminderDelay(6 * 60, author.id);
    const pendingAfter = (await projReminders(p2b.id, editor.id))[0];
    const sentAfter = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: sentSeed.id } });
    check("6a. PENDING reminder recalculated from its ORIGINAL mention time (+6h)", pendingAfter.dueAt.getTime() === pendingAfter.projectNoteMention!.createdAt.getTime() + 360 * MIN && pendingAfter.dueAt.getTime() !== pendingBefore.dueAt.getTime() && changed.recalculated >= 1);
    check("6b. SENT reminder is untouched by a delay change (dueAt unchanged)", sentAfter.dueAt.getTime() === sentSeed.dueAt.getTime() && sentAfter.status === "SENT");
    check("33a. delay bounds: 1 minute and 31 days rejected, 5 minutes and 30 days accepted", !cfg.parseMentionReminderDelay(1, "minutes").ok && !cfg.parseMentionReminderDelay(31, "days").ok && cfg.parseMentionReminderDelay(5, "minutes").ok && cfg.parseMentionReminderDelay(30, "days").ok && !cfg.parseMentionReminderDelay(1.5, "hours").ok);
    await svc.updateMentionReminderDelay(24 * 60, author.id);

    // ── 7–10: delivery ──
    console.log("\nDelivery ===\n");
    const pd = await freshProject(deptA.id, `Delivery Project ${RUN_ID}`);
    await postProject(author, pd.id, [editor.id]);
    const rd = (await projReminders(pd.id, editor.id))[0];
    const before = await svc.processDueMentionReminders({ now: new Date(rd.dueAt.getTime() - 1000) });
    check("7. reminder does not fire before dueAt", (await reminderNotifs(editor.id, `/projects/${pd.id}`)).length === 0 && (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rd.id } })).status === "PENDING", `sent=${before.sent}`);
    const run1 = await svc.processDueMentionReminders({ now: afterDue(rd) });
    const notifs = await reminderNotifs(editor.id, `/projects/${pd.id}`);
    const rdAfter = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rd.id } });
    check("8. due unanswered mention produces exactly one notification and status SENT", notifs.length === 1 && rdAfter.status === "SENT" && !!rdAfter.sentAt && run1.sent >= 1, `notifs ${notifs.length} status ${rdAfter.status}`);
    await svc.processDueMentionReminders({ now: new Date(afterDue(rd).getTime() + 5 * MIN) });
    check("9. rerunning the processor creates no duplicate", (await reminderNotifs(editor.id, `/projects/${pd.id}`)).length === 1);
    check("29. notification contains no Note text", !/SECRET-TEXT/.test(notifs[0].title + notifs[0].body) && notifs[0].body === `You were mentioned in project "Delivery Project ${RUN_ID}" and have not responded yet.` && notifs[0].title === "Mention reminder");
    check("30a. project reminder links to the Notes section of that project", notifs[0].link === `/projects/${pd.id}#notes`);
    const a1Due = ar1[0];
    await svc.processDueMentionReminders({ now: afterDue(a1Due) });
    const anotifs = await reminderNotifs(editor.id, `/activities/${a1.id}`);
    check("30b. activity reminder links to the Notes section of that activity", anotifs.length === 1 && anotifs[0].link === `/activities/${a1.id}#notes` && anotifs[0].body === `You were mentioned in activity "${a1.title}" and have not responded yet.`);

    // 10. concurrent processors
    const pc = await freshProject();
    await postProject(author, pc.id, [editor2.id]);
    const rc = (await projReminders(pc.id, editor2.id))[0];
    const [c1, c2, c3] = await Promise.all([1, 2, 3].map(() => svc.processDueMentionReminders({ now: afterDue(rc) })));
    check("10. three concurrent processors still send exactly one notification", (await reminderNotifs(editor2.id, `/projects/${pc.id}`)).length === 1 && c1.sent + c2.sent + c3.sent >= 1);

    // ── 11–16: responses ──
    console.log("\nResponses ===\n");
    const pr = await freshProject();
    await postProject(author, pr.id, [editor.id]);
    await postProject(editor, pr.id, []);
    const rr = (await projReminders(pr.id, editor.id))[0];
    check("11. Project response before due marks the reminder RESPONDED", rr.status === "RESPONDED" && !!rr.respondedAt);
    await svc.processDueMentionReminders({ now: afterDue(rr) });
    check("11b. ...and it is never delivered", (await reminderNotifs(editor.id, `/projects/${pr.id}`)).length === 0);

    const ar = await freshActivity();
    await postActivity(author, ar.id, [editor.id]);
    await postActivity(editor, ar.id, []);
    check("12. Activity response marks the reminder RESPONDED", (await actReminders(ar.id, editor.id))[0].status === "RESPONDED");

    const po = await freshProject();
    await postProject(author, po.id, [editor.id]);
    await postProject(editor2, po.id, []); // another user
    check("13. another user's Note does not resolve the reminder", (await projReminders(po.id, editor.id))[0].status === "PENDING");
    const other = await freshProject();
    await postProject(editor, other.id, []); // same user, other entity
    check("14. a response in another entity does not count", (await projReminders(po.id, editor.id))[0].status === "PENDING");

    const pm = await freshProject();
    const am = await freshActivity();
    await postProject(author, pm.id, [editor.id]);
    await postProject(author, pm.id, [editor.id]);
    await postActivity(author, am.id, [editor.id]);
    check("15a. two independent PENDING reminders exist for the user on one project", (await projReminders(pm.id, editor.id)).filter((r) => r.status === "PENDING").length === 2);
    await postProject(editor, pm.id, []);
    const pmAfter = await projReminders(pm.id, editor.id);
    check("15. one response resolves every earlier pending reminder for that user/entity", pmAfter.length === 2 && pmAfter.every((r) => r.status === "RESPONDED"));
    check("15b. ...but not the same user's reminder on a different entity", (await actReminders(am.id, editor.id))[0].status === "PENDING");
    await postProject(author, pm.id, [editor.id]);
    const pm3 = (await projReminders(pm.id, editor.id)).filter((r) => r.status === "PENDING");
    check("16. a later new mention creates a new independent PENDING reminder", pm3.length === 1);

    // ── 17–21: eligibility & preference ──
    console.log("\nEligibility and preference ===\n");
    const pe = await freshProject();
    await postProject(author, pe.id, [author.id]);
    check("17. self-mention creates no reminder", (await projReminders(pe.id)).length === 0);
    await postProject(author, pe.id, [editor.id, editor.id]);
    check("18. duplicate mention ids in one Note create only one reminder", (await projReminders(pe.id, editor.id)).length === 1);
    await postProject(author, pe.id, [optedOut.id]);
    check("19. opted-out user: immediate notification still delivered, NO reminder scheduled", (await projReminders(pe.id, optedOut.id)).length === 0 && (await prisma.notification.count({ where: { userId: optedOut.id, link: `/projects/${pe.id}`, title: { contains: "mentioned you" } } })) === 1);

    const pf = await freshProject();
    await postProject(author, pf.id, [editor2.id]);
    const rf = (await projReminders(pf.id, editor2.id))[0];
    as(editor2);
    const off = await prefRoute.PATCH(jsonReq("PATCH", { enabled: false }));
    check("20. disabling cancels existing unsent reminders (reason recorded)", off.status === 200 && (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rf.id } })).status === "CANCELLED" && (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rf.id } })).cancellationReason === "user_opted_out");
    const on = await prefRoute.PATCH(jsonReq("PATCH", { enabled: true }));
    await svc.processDueMentionReminders({ now: afterDue(rf) });
    check("21. re-enabling does not revive a cancelled reminder", on.status === 200 && (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rf.id } })).status === "CANCELLED" && (await reminderNotifs(editor2.id, `/projects/${pf.id}`)).length === 0);
    await postProject(author, pf.id, [editor2.id]);
    check("21b. ...only future mentions schedule again", (await projReminders(pf.id, editor2.id)).filter((r) => r.status === "PENDING").length === 1);

    // 22 inactive / 23 lost access / disabled before delivery
    const pi = await freshProject();
    await postProject(author, pi.id, [deptAOnly.id]);
    const ri = (await projReminders(pi.id, deptAOnly.id))[0];
    await prisma.user.update({ where: { id: deptAOnly.id }, data: { isActive: false } });
    await svc.processDueMentionReminders({ now: afterDue(ri) });
    const riAfter = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: ri.id } });
    check("22. inactive user is cancelled without notification", riAfter.status === "CANCELLED" && riAfter.cancellationReason === "user_inactive" && (await reminderNotifs(deptAOnly.id, `/projects/${pi.id}`)).length === 0);
    await prisma.user.update({ where: { id: deptAOnly.id }, data: { isActive: true } });

    const pl = await freshProject();
    await postProject(author, pl.id, [editor.id]);
    const rl = (await projReminders(pl.id, editor.id))[0];
    await prisma.departmentMembership.update({ where: { id: editorMembership.id }, data: { isActive: false } });
    await svc.processDueMentionReminders({ now: afterDue(rl) });
    const rlAfter = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rl.id } });
    check("23. lost entity access cancels delivery", rlAfter.status === "CANCELLED" && rlAfter.cancellationReason === "lost_view_access" && (await reminderNotifs(editor.id, `/projects/${pl.id}`)).length === 0);
    await prisma.departmentMembership.update({ where: { id: editorMembership.id }, data: { isActive: true } });

    // ── 24–28: permissions ──
    console.log("\nPermissions ===\n");
    const pv = await freshProject();
    await postProject(author, pv.id, [viewer.id, editor.id]);
    check("24. view-only tagged user: immediate notification, NO reminder", (await prisma.notification.count({ where: { userId: viewer.id, link: `/projects/${pv.id}`, title: { contains: "mentioned you" } } })) === 1 && (await projReminders(pv.id, viewer.id)).length === 0);
    check("25. user with effective edit permission gets a reminder", (await projReminders(pv.id, editor.id)).length === 1);
    const av = await freshActivity();
    await postActivity(author, av.id, [viewer.id, globalUser.id]);
    check("24b. activity: view-only gets no reminder", (await actReminders(av.id, viewer.id)).length === 0);
    check("27. global edit permission works without any DepartmentMembership", (await prisma.departmentMembership.count({ where: { userId: globalUser.id } })) === 0 && (await actReminders(av.id, globalUser.id)).length === 1);
    const rg = (await actReminders(av.id, globalUser.id))[0];
    await svc.processDueMentionReminders({ now: afterDue(rg) });
    check("27b. ...and the global user is actually notified at delivery", (await reminderNotifs(globalUser.id, `/activities/${av.id}`)).length === 1);

    const pB = await freshProject(deptB.id);
    check("26a. Department A edit grant does not make a Department B reminder eligible", (await svc.filterReminderEligibleUserIds({ entityType: "project", entityDepartmentId: deptB.id, authorId: author.id, mentionedUserIds: [editor.id] })).length === 0);
    check("26b. ...while a global grant does, in any department", (await svc.filterReminderEligibleUserIds({ entityType: "project", entityDepartmentId: deptB.id, authorId: author.id, mentionedUserIds: [globalUser.id] })).length === 1);
    // Force a reminder for the Dept A user on a Dept B entity: delivery must still refuse it.
    const noteB = await prisma.projectNote.create({ data: { projectId: pB.id, authorId: author.id, body: "x" } });
    const mB = await prisma.projectNoteMention.create({ data: { noteId: noteB.id, userId: deptAOnly.id } });
    const rB = await prisma.mentionReminder.create({ data: { projectNoteMentionId: mB.id, dueAt: new Date(mB.createdAt.getTime() + 24 * 60 * MIN) } });
    await svc.processDueMentionReminders({ now: afterDue(rB) });
    check("26c. delivery-time revalidation: Department A grant cannot deliver a Department B reminder", (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rB.id } })).status === "CANCELLED" && (await reminderNotifs(deptAOnly.id, `/projects/${pB.id}`)).length === 0);

    // 28 deletion
    const pdel = await freshProject();
    const adel = await freshActivity();
    const pn = await postProject(author, pdel.id, [editor.id]);
    await postActivity(author, adel.id, [editor.id]);
    const rdel = (await projReminders(pdel.id, editor.id))[0];
    const rdel2 = (await actReminders(adel.id, editor.id))[0];
    await prisma.projectNote.delete({ where: { id: pn.json.id } });
    await prisma.projectActivity.delete({ where: { id: adel.id } });
    check("28a. deleting the Note/entity cascades the reminder away", !(await prisma.mentionReminder.findUnique({ where: { id: rdel.id } })) && !(await prisma.mentionReminder.findUnique({ where: { id: rdel2.id } })));
    await svc.processDueMentionReminders({ now: afterDue(rdel) });
    check("28b. ...so nothing is delivered", (await reminderNotifs(editor.id, `/projects/${pdel.id}`)).length === 0 && (await reminderNotifs(editor.id, `/activities/${adel.id}`)).length === 0);

    // ── 31: immediate notification unchanged ──
    console.log("\nImmediate notification + constraints ===\n");
    const pim = await freshProject(deptA.id, `Immediate ${RUN_ID}`);
    await postProject(author, pim.id, [editor.id]);
    const imm = await prisma.notification.findMany({ where: { userId: editor.id, link: `/projects/${pim.id}` } });
    check("31. immediate mention notification unchanged (title/body/link)", imm.length === 1 && imm[0].title === `${author.name} mentioned you in a note` && imm[0].body === `${author.name} mentioned you in a note on the project "Immediate ${RUN_ID}"`);

    let bothFailed = false;
    let neitherFailed = false;
    try {
      await prisma.$executeRaw`INSERT INTO "MentionReminder" (id, "dueAt", "updatedAt") VALUES (${`x${RUN_ID}`}, now(), now())`;
    } catch {
      neitherFailed = true;
    }
    const someP = (await projReminders(pim.id))[0];
    const someA = (await actReminders(a1.id))[0];
    try {
      await prisma.$executeRaw`INSERT INTO "MentionReminder" (id, "projectNoteMentionId", "activityNoteMentionId", "dueAt", "updatedAt") VALUES (${`y${RUN_ID}`}, ${someP.projectNoteMentionId}, ${someA.activityNoteMentionId}, now(), now())`;
    } catch {
      bothFailed = true;
    }
    let dupFailed = false;
    try {
      await prisma.mentionReminder.create({ data: { projectNoteMentionId: someP.projectNoteMentionId, dueAt: new Date() } });
    } catch {
      dupFailed = true;
    }
    check("2b. CHECK: neither source rejected; both sources rejected; one reminder per source mention (unique)", neitherFailed && bothFailed && dupFailed);

    // ── 32–34: endpoints ──
    console.log("\nEndpoint authorization ===\n");
    as(editor);
    const before32 = (await prisma.user.findUniqueOrThrow({ where: { id: editor2.id } })).mentionRemindersEnabled;
    await prefRoute.PATCH(jsonReq("PATCH", { enabled: false, userId: editor2.id, id: editor2.id }));
    const after32 = (await prisma.user.findUniqueOrThrow({ where: { id: editor2.id } })).mentionRemindersEnabled;
    const mine = (await prisma.user.findUniqueOrThrow({ where: { id: editor.id } })).mentionRemindersEnabled;
    check("32. a user can only change their OWN preference (no user id is accepted)", before32 === after32 && mine === false);
    as(editor);
    await prefRoute.PATCH(jsonReq("PATCH", { enabled: true }));
    check("32b. invalid payload rejected (400); unauthenticated rejected (401)", (await prefRoute.PATCH(jsonReq("PATCH", { enabled: "yes" }))).status === 400 && (as(null), (await prefRoute.PATCH(jsonReq("PATCH", { enabled: true }))).status === 401));

    as(editor);
    const nonAdminPut = await adminRoute.PUT(jsonReq("PUT", { value: 1, unit: "hours" }));
    const nonAdminGet = await adminRoute.GET();
    const delayNow = await svc.getMentionReminderDelayMinutes();
    check("33. non-admin cannot read or change the global delay", nonAdminPut.status === 403 && nonAdminGet.status === 403 && delayNow === 1440);
    as(author);
    const adminPut = await adminRoute.PUT(jsonReq("PUT", { value: 3, unit: "hours" }));
    const adminBad = await adminRoute.PUT(jsonReq("PUT", { value: 2, unit: "years" }));
    check("33b. admin can set 3 hours (stored as 180 minutes); invalid unit rejected", adminPut.status === 200 && (await svc.getMentionReminderDelayMinutes()) === 180 && adminBad.status === 400);
    await svc.updateMentionReminderDelay(1440, author.id);

    const prevSecret = process.env.CRON_SECRET;
    const prevEnv = process.env.NODE_ENV;
    process.env.CRON_SECRET = "s3cret-test";
    const noAuth = await workerRoute.POST(jsonReq("POST"));
    const wrong = await workerRoute.POST(jsonReq("POST", undefined, { authorization: "Bearer nope" }));
    const right = await workerRoute.POST(jsonReq("POST", undefined, { authorization: "Bearer s3cret-test" }));
    delete process.env.CRON_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    const failClosed = await workerRoute.POST(jsonReq("POST"));
    (process.env as Record<string, string>).NODE_ENV = prevEnv ?? "test";
    if (prevSecret) process.env.CRON_SECRET = prevSecret;
    check("34. worker endpoint: 401 without/with wrong token, 200 with the secret, fails closed in production with no secret", noAuth.status === 401 && wrong.status === 401 && right.status === 200 && failClosed.status === 401);

    // ── 35: recovery ──
    console.log("\nRecovery ===\n");
    const ps = await freshProject();
    await postProject(author, ps.id, [editor2.id]);
    const rs = (await projReminders(ps.id, editor2.id))[0];
    const nowS = afterDue(rs);
    await prisma.mentionReminder.update({ where: { id: rs.id }, data: { status: "PROCESSING", claimedAt: new Date(nowS.getTime() - 1 * MIN), claimToken: "dead-worker" } });
    await svc.processDueMentionReminders({ now: nowS });
    check("35a. a FRESH PROCESSING claim (worker still alive) is not stolen", (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rs.id } })).status === "PROCESSING" && (await reminderNotifs(editor2.id, `/projects/${ps.id}`)).length === 0, `status ${(await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rs.id } })).status}`);
    await prisma.mentionReminder.update({ where: { id: rs.id }, data: { claimedAt: new Date(nowS.getTime() - (svc.STALE_CLAIM_TIMEOUT_MS + MIN)) } });
    await svc.processDueMentionReminders({ now: nowS });
    check("35. a STALE PROCESSING claim (crashed worker) is recovered and delivered exactly once", (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rs.id } })).status === "SENT" && (await reminderNotifs(editor2.id, `/projects/${ps.id}`)).length === 1);
    await svc.processDueMentionReminders({ now: new Date(nowS.getTime() + 60 * MIN) });
    check("35b. retry after recovery creates no duplicate", (await reminderNotifs(editor2.id, `/projects/${ps.id}`)).length === 1);

    // response committed after claim but before delivery (worker race)
    const pw = await freshProject();
    await postProject(author, pw.id, [editor2.id]);
    const rw = (await projReminders(pw.id, editor2.id))[0];
    await prisma.mentionReminder.update({ where: { id: rw.id }, data: { status: "PROCESSING", claimedAt: new Date(afterDue(rw).getTime() - 30 * MIN * 10), claimToken: "gone" } });
    await prisma.projectNote.create({ data: { projectId: pw.id, authorId: editor2.id, body: "late reply" } });
    await svc.processDueMentionReminders({ now: afterDue(rw) });
    const rwAfter = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rw.id } });
    check("9b. response committed before delivery (race) => RESPONDED, no notification", rwAfter.status === "RESPONDED" && (await reminderNotifs(editor2.id, `/projects/${pw.id}`)).length === 0);

    // disabled between claim and delivery
    const pdis = await freshProject();
    await postProject(author, pdis.id, [editor.id]);
    const rdis = (await projReminders(pdis.id, editor.id))[0];
    await prisma.user.update({ where: { id: editor.id }, data: { mentionRemindersEnabled: false } });
    await svc.processDueMentionReminders({ now: afterDue(rdis) });
    check("20b. disabling before delivery prevents delivery", (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: rdis.id } })).status !== "SENT" && (await reminderNotifs(editor.id, `/projects/${pdis.id}`)).length === 0);
    await prisma.user.update({ where: { id: editor.id }, data: { mentionRemindersEnabled: true } });

    // terminal rows are immune to admin delay updates (already in 6b) + SENT never re-sent
    const term = await prisma.mentionReminder.findMany({ where: { status: { in: ["SENT", "RESPONDED", "CANCELLED"] }, projectNoteMention: { note: { projectId: { in: projectIds } } } }, select: { id: true, dueAt: true } });
    await svc.updateMentionReminderDelay(7 * 60, author.id);
    const term2 = await prisma.mentionReminder.findMany({ where: { id: { in: term.map((t) => t.id) } }, select: { id: true, dueAt: true } });
    check("6c. admin delay update never modifies terminal (SENT/RESPONDED/CANCELLED) reminders", term.length > 0 && term.every((t) => term2.find((x) => x.id === t.id)!.dueAt.getTime() === t.dueAt.getTime()));
    await svc.updateMentionReminderDelay(1440, author.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["reminders", () => prisma.mentionReminder.deleteMany({ where: { OR: [{ projectNoteMention: { userId: { in: userIds } } }, { activityNoteMention: { userId: { in: userIds } } }] } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      ["ticket messages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: roleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: roleIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
      ["settings", async () => {
        await prisma.mentionReminderSettings.deleteMany({});
        if (originalSettings) await prisma.mentionReminderSettings.create({ data: { id: "default", delayMinutes: originalSettings.delayMinutes, updatedById: originalSettings.updatedById } });
      }],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main();
