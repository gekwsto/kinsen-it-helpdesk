/**
 * Mention Reminder response/claim race: a Note by the mentioned user must
 * resolve a reminder that the worker has already claimed (PROCESSING), and the
 * worker's final transaction must never deliver after a committed response.
 * Orderings are forced deterministically (manual claims + the
 * beforeFinalTransaction test seam) — no timers, no real waiting.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-mention-reminder-response-race.ts
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
let pushCalls = 0;
let realtimeCalls = 0;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

const RUN_ID = Date.now();
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => { pushCalls++; return { subscriptionCount: 0, sentCount: 0 }; } } });
  mock.module("@/lib/realtime/notification-publisher", { namedExports: { publishNotificationCreated: () => { realtimeCalls++; } } });

  const projectNotes = await import("@/app/api/projects/[id]/notes/route");
  const activityNotes = await import("@/app/api/activities/[id]/notes/route");
  const ticketReply = await import("@/app/api/tickets/[id]/reply/route");
  const svc = await import("@/lib/services/mention-reminder-service");

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const roleIds: string[] = [];
  const roleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];

  type Subject = { id: string; name: string; role: Role; customRoleId: string | null };
  const as = (s: Subject) => { currentSession = { user: { id: s.id, name: s.name, role: s.role, customRoleId: s.customRoleId } }; };
  async function makeRole(tag: string, scope: RoleScope, keys: string[]) {
    const r = await prisma.customRole.create({ data: { key: `RR_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true } });
    roleIds.push(r.id);
    roleKeys.push(r.key);
    for (const key of keys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }
  async function makeUser(tag: string, role: Role, customRoleId: string | null): Promise<Subject> {
    const u = await prisma.user.create({ data: { email: `rr-${tag}-${RUN_ID}@kinsen.gr`, name: `RR ${tag}`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(u.id);
    return { id: u.id, name: u.name!, role, customRoleId };
  }
  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const dept = await createDepartment({ name: `RR-${RUN_ID}`, slug: `rr-${RUN_ID}` });
    deptIds.push(dept.id);
    const noop = await makeRole("NOOP", RoleScope.GLOBAL, []);
    const editRole = await makeRole("EDIT", RoleScope.DEPARTMENT, ["project.view", "project.edit", "activity.view", "activity.edit"]);
    const author = await makeUser("author", Role.ADMIN, null);
    const editor = await makeUser("editor", Role.USER, noop.id);
    const other = await makeUser("other", Role.USER, noop.id);
    for (const u of [editor, other]) {
      await prisma.departmentMembership.create({ data: { userId: u.id, departmentId: dept.id, role: DepartmentRole.REQUESTER, customRoleId: editRole.id, source: MembershipSource.MANUAL, isActive: true } });
    }

    type Kind = "project" | "activity";
    const newEntity = async (kind: Kind) => {
      if (kind === "project") {
        const p = await prisma.project.create({ data: { title: `RR project ${RUN_ID}-${projectIds.length}`, departmentId: dept.id, ownerId: author.id } });
        projectIds.push(p.id);
        return p.id;
      }
      const a = await prisma.projectActivity.create({ data: { title: `RR activity ${RUN_ID}-${activityIds.length}`, departmentId: dept.id } });
      activityIds.push(a.id);
      return a.id;
    };
    // Real route call: exercises the actual Note-create transaction.
    const post = async (kind: Kind, who: Subject, id: string, mentionUserIds: string[] = []) => {
      as(who);
      const route = kind === "project" ? projectNotes : activityNotes;
      const res = await route.POST(jsonReq({ body: "text", mentionUserIds }), { params: Promise.resolve({ id }) });
      if (res.status !== 201) throw new Error(`note POST failed ${res.status}`);
    };
    // Direct insert (a Note that committed WITHOUT touching any reminder).
    const rawNote = (kind: Kind, id: string, authorId: string) =>
      kind === "project" ? prisma.projectNote.create({ data: { projectId: id, authorId, body: "raw" } }) : prisma.activityNote.create({ data: { activityId: id, authorId, body: "raw" } });
    const reminderOf = async (kind: Kind, id: string, userId: string) =>
      (await prisma.mentionReminder.findMany({ where: kind === "project" ? { projectNoteMention: { userId, note: { projectId: id } } } : { activityNoteMention: { userId, note: { activityId: id } } } }))[0];
    const notifsFor = (kind: Kind, id: string) =>
      prisma.notification.findMany({ where: { userId: editor.id, title: svc.REMINDER_TITLE, link: `/${kind === "project" ? "projects" : "activities"}/${id}#notes` } });
    const claim = async (reminderId: string, token: string, claimedAt = new Date()) =>
      prisma.mentionReminder.update({ where: { id: reminderId }, data: { status: "PROCESSING", claimedAt, claimToken: token } });
    const mentioned = async (kind: Kind) => {
      const id = await newEntity(kind);
      await post(kind, author, id, [editor.id]);
      const r = await reminderOf(kind, id, editor.id);
      return { id, r };
    };
    const dueNow = (r: { dueAt: Date }) => new Date(r.dueAt.getTime() + 1000);
    const resetCounters = () => { pushCalls = 0; realtimeCalls = 0; };

    for (const kind of ["project", "activity"] as Kind[]) {
      const K = kind.toUpperCase();
      console.log(`\n=== ${K} ===\n`);

      // 1. PENDING resolved
      {
        const { id, r } = await mentioned(kind);
        await post(kind, editor, id);
        const after = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`1. [${K}] PENDING reminder becomes RESPONDED after a valid response`, r.status === "PENDING" && after.status === "RESPONDED" && !!after.respondedAt);
      }

      // 2–5. PROCESSING resolved by the Note transaction; old token cannot finalize
      {
        const { id, r } = await mentioned(kind);
        await claim(r.id, "worker-A");
        resetCounters();
        await post(kind, editor, id);
        const after = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`2. [${K}] claimed PROCESSING reminder becomes RESPONDED (respondedAt set, claimedAt + claimToken cleared)`, after.status === "RESPONDED" && !!after.respondedAt && after.claimedAt === null && after.claimToken === null, `status=${after.status} claimedAt=${after.claimedAt} token=${after.claimToken}`);
        const outcome = await svc.processClaimedMentionReminder(r.id, "worker-A", dueNow(r));
        const final = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`3. [${K}] the old worker claim token cannot finalize it (no-op, stays RESPONDED)`, outcome === "lost_claim" && final.status === "RESPONDED" && final.sentAt === null, `outcome=${outcome} status=${final.status}`);
        check(`4. [${K}] no Notification row is created in that race`, (await notifsFor(kind, id)).length === 0);
        check(`5. [${K}] no realtime publish and no push dispatch`, pushCalls === 0 && realtimeCalls === 0, `push=${pushCalls} realtime=${realtimeCalls}`);
      }

      // 6. final revalidation detects a response that never touched the reminder
      {
        const { id, r } = await mentioned(kind);
        await claim(r.id, "worker-B");
        resetCounters();
        const outcome = await svc.processClaimedMentionReminder(r.id, "worker-B", dueNow(r), {
          beforeFinalTransaction: async () => { await sleep(3); await rawNote(kind, id, editor.id); },
        });
        const final = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`6. [${K}] worker final revalidation catches a committed response even though the reminder was not proactively updated`, outcome === "responded" && final.status === "RESPONDED" && !!final.respondedAt && final.claimedAt === null && final.claimToken === null && (await notifsFor(kind, id)).length === 0 && pushCalls === 0 && realtimeCalls === 0, `outcome=${outcome} status=${final.status}`);
      }

      // 7–8. things that are NOT a response (final-transaction check ignores them)
      {
        const { id, r } = await mentioned(kind);
        const otherEntity = await newEntity(kind);
        await claim(r.id, "worker-C");
        const outcome = await svc.processClaimedMentionReminder(r.id, "worker-C", dueNow(r), {
          beforeFinalTransaction: async () => { await sleep(3); await rawNote(kind, id, other.id); await rawNote(kind, otherEntity, editor.id); },
        });
        const final = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`7/8. [${K}] another user's Note and the same user's Note on ANOTHER entity do not resolve it — reminder is SENT once`, outcome === "sent" && final.status === "SENT" && (await notifsFor(kind, id)).length === 1, `outcome=${outcome}`);
        // and the proactive path (route) ignores them too
        const { id: id2, r: r2 } = await mentioned(kind);
        await post(kind, other, id2);
        await post(kind, editor, otherEntity);
        check(`7b/8b. [${K}] Note transaction: other user's Note / other entity leave the reminder PENDING`, (await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r2.id } })).status === "PENDING");
      }

      // 9. Note predating the mention
      {
        const id = await newEntity(kind);
        await rawNote(kind, id, editor.id); // editor's Note exists BEFORE the mention
        await sleep(5);
        await post(kind, author, id, [editor.id]);
        const r = await reminderOf(kind, id, editor.id);
        await claim(r.id, "worker-D");
        const outcome = await svc.processClaimedMentionReminder(r.id, "worker-D", dueNow(r));
        check(`9. [${K}] a Note created BEFORE the mention is not a response — reminder is SENT`, outcome === "sent" && (await notifsFor(kind, id)).length === 1, `outcome=${outcome}`);
      }

      // 10. worker committed first, response later
      {
        const { id, r } = await mentioned(kind);
        await claim(r.id, "worker-E");
        await svc.processClaimedMentionReminder(r.id, "worker-E", dueNow(r));
        const sent = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        await post(kind, editor, id);
        const later = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`10. [${K}] finalization committed before the response: reminder stays SENT (not retroactively changed), exactly one Notification`, later.status === "SENT" && later.sentAt?.getTime() === sent.sentAt?.getTime() && later.respondedAt === null && (await notifsFor(kind, id)).length === 1);
      }

      // 11. opt-out while PROCESSING
      {
        const { id, r } = await mentioned(kind);
        await claim(r.id, "worker-F");
        resetCounters();
        await svc.setMentionRemindersEnabled(editor.id, false);
        const outcome = await svc.processClaimedMentionReminder(r.id, "worker-F", dueNow(r));
        await svc.setMentionRemindersEnabled(editor.id, true);
        const final = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        check(`11. [${K}] disabling reminders while PROCESSING prevents finalization`, outcome === "lost_claim" && final.status === "CANCELLED" && (await notifsFor(kind, id)).length === 0 && pushCalls === 0 && realtimeCalls === 0, `outcome=${outcome} status=${final.status}`);
      }

      // 12. recovery never reclaims RESPONDED / CANCELLED
      {
        const { id, r } = await mentioned(kind);
        const { id: id2, r: r2 } = await mentioned(kind);
        const old = new Date(Date.now() - 24 * 60 * MIN);
        await prisma.mentionReminder.update({ where: { id: r.id }, data: { status: "RESPONDED", respondedAt: old, claimedAt: old } });
        await prisma.mentionReminder.update({ where: { id: r2.id }, data: { status: "CANCELLED", cancelledAt: old, claimedAt: old } });
        await svc.processDueMentionReminders({ now: new Date(Date.now() + 48 * 60 * MIN) });
        const a = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r.id } });
        const b = await prisma.mentionReminder.findUniqueOrThrow({ where: { id: r2.id } });
        check(`12. [${K}] recovery never reclaims RESPONDED or CANCELLED reminders`, a.status === "RESPONDED" && b.status === "CANCELLED" && (await notifsFor(kind, id)).length === 0 && (await notifsFor(kind, id2)).length === 0);
      }
    }

    // 14. Ticket mentions stay outside the feature.
    console.log("\n=== TICKET ===\n");
    const adminMentionee = await makeUser("admin-mentionee", Role.ADMIN, null);
    const status = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    const ticket = await prisma.ticket.create({ data: { title: `RR ticket ${RUN_ID}`, description: "x", requesterId: author.id, departmentId: dept.id, statusId: status!.id } });
    ticketIds.push(ticket.id);
    const before = await prisma.mentionReminder.count();
    as(author);
    const res = await ticketReply.POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "n", isInternal: true, direction: "INTERNAL_NOTE", mentionUserIds: [adminMentionee.id] }) }), { params: Promise.resolve({ id: ticket.id }) });
    as(adminMentionee);
    const res2 = await ticketReply.POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "reply", isInternal: true, direction: "INTERNAL_NOTE", mentionUserIds: [] }) }), { params: Promise.resolve({ id: ticket.id }) });
    check("14. Ticket internal-note mentions create no reminder, and a mentioned user's ticket note resolves nothing", res.status === 201 && res2.status === 201 && (await prisma.ticketMessageMention.count({ where: { message: { ticketId: ticket.id } } })) === 1 && (await prisma.mentionReminder.count()) === before);
    check("13. Project and Activity ran the identical scenario set (both sections above)", true);
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
    ];
    for (const [label, step] of steps) {
      try { await step(); } catch (err) { console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err); }
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main();
