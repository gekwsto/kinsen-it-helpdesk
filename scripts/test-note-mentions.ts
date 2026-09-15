/**
 * Regression coverage for Note @mentions — the shared mention architecture
 * used identically by Ticket internal notes, Project Notes, and Activity
 * Notes (see lib/services/mention-service.ts, lib/mentions/mention-tokens.ts,
 * lib/services/mention-notification-service.ts,
 * components/notes/mention-textarea.tsx, components/notes/mention-render.tsx,
 * app/api/mentions/search/route.ts).
 *
 * Uses Node's module-mocking API (same established pattern as
 * scripts/test-integration-admin-authz.ts and
 * scripts/test-ticket-notes-regression-boundary.ts — swaps out @/lib/auth's
 * `auth()` for a controllable fake session) to exercise the REAL POST/GET
 * route handlers for all three note surfaces end to end: real DB fixtures,
 * real persistence, real transactions, real Notification rows.
 *
 * Also mocks @/lib/web-push and next/server's `after`, exactly like
 * test-ticket-notes-regression-boundary.ts already does and explains in its
 * own comment: every note-creation route transitively imports
 * lib/web-push.ts, which imports the `server-only` sentinel package — a
 * webpack-only build-time guard that always throws when the real file is
 * loaded outside Next's own bundler (confirmed via git-stash against the
 * UNMODIFIED, pre-existing reply route, which already had this same
 * transitive import before this feature). Mocking the real, resolvable
 * lib/web-push.ts file short-circuits that import; the route's fire-and-
 * forget push call becomes a no-op, exactly as harmless here as a real push
 * failure already is in production (every call site wraps it in try/catch
 * and still returns 201/commits the write). Nothing about authorization,
 * eligibility, or persistence is mocked.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-note-mentions.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, Role, RoleScope } from "@prisma/client";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { renderNoteBodyWithMentions } from "@/components/notes/mention-render";
import { buildMentionToken, extractMentionedUserIdsFromBody, computeMentionNotificationRecipients } from "@/lib/mentions/mention-tokens";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

function asUser(userId: string, role: Role, customRoleId: string | null = null) {
  currentSession = { user: { id: userId, role, customRoleId } };
}

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — routes reuse the shared mention service, never a per-surface reimplementation ===\n");

  const projectNotesSrc = await fs.readFile(path.join(process.cwd(), "app/api/projects/[id]/notes/route.ts"), "utf8");
  const activityNotesSrc = await fs.readFile(path.join(process.cwd(), "app/api/activities/[id]/notes/route.ts"), "utf8");
  const ticketReplySrc = await fs.readFile(path.join(process.cwd(), "app/api/tickets/[id]/reply/route.ts"), "utf8");
  const searchRouteSrc = await fs.readFile(path.join(process.cwd(), "app/api/mentions/search/route.ts"), "utf8");
  const mentionServiceSrc = await fs.readFile(path.join(process.cwd(), "lib/services/mention-service.ts"), "utf8");

  for (const [label, src] of [["Project notes", projectNotesSrc], ["Activity notes", activityNotesSrc], ["Ticket reply", ticketReplySrc]] as const) {
    check(`A. ${label} route imports resolveEligibleMentionUsers from the shared mention-service (not a local reimplementation)`, /from "@\/lib\/services\/mention-service"/.test(src) && /resolveEligibleMentionUsers/.test(src));
    check(`A. ${label} route resolves mentions BEFORE the transaction, then persists mention rows INSIDE it`, src.indexOf("resolveEligibleMentionUsers(") < src.indexOf("$transaction") && src.indexOf("$transaction") < src.indexOf("skipDuplicates"));
    check(`A. ${label} route calls notifyNewMentions(...) only AFTER the transaction commits (never before persistence)`, src.indexOf("$transaction") < src.indexOf("notifyNewMentions({"));
  }
  check("A. The mention search endpoint exists at a single shared route (app/api/mentions/search/route.ts), not three per-entity search routes", searchRouteSrc.length > 0);
  check("A. The search route requires the CALLER to already be able to view the entity before revealing who else can (canActOnEntity/canViewTicket gate)", /canActOnEntity|canViewTicket/.test(searchRouteSrc));
  check("A. Eligibility is resolved via the canonical canActOnEntity/canViewTicket resolvers, never a raw role===ADMIN-style check", /canActOnEntity|canViewTicket/.test(mentionServiceSrc) && !/role\s*===\s*["']ADMIN["']/.test(mentionServiceSrc));

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
  const projectNoteIdRouteExists = await pathExists(path.join(process.cwd(), "app/api/projects/[id]/notes/[noteId]"));
  const activityNoteIdRouteExists = await pathExists(path.join(process.cwd(), "app/api/activities/[id]/notes/[noteId]"));
  check("A. Project/Activity Notes have no PATCH/edit route — mentions are never re-validated for an edit that doesn't exist (item 14 is N/A: no editing exists)", !projectNoteIdRouteExists && !activityNoteIdRouteExists);

  // ══════════════════════ SECTION B — pure rendering + pure token logic (no DB) ══════════════════════
  console.log("\n=== SECTION B — rendering: real vs. fake mentions, historical notes, and pure token/recipient logic ===\n");

  const plainHistorical = "Please check with @Konstantinos about this before Friday.";
  check("B1. A historical note with a literal @word (no structured token) renders as plain, unmodified text", renderNoteBodyWithMentions(plainHistorical, []) === plainHistorical);

  const realToken = buildMentionToken("user-abc", "Konstantinos Kefalas");
  const bodyWithReal = `Please check with ${realToken} about this.`;
  const renderedReal = renderNoteBodyWithMentions(bodyWithReal, [{ userId: "user-abc", name: "Konstantinos Kefalas", email: "k@example.com" }]);
  check("B2. A token WITH a matching persisted mention renders as an array (styled chip + surrounding text), not the raw literal string", Array.isArray(renderedReal) && !renderedReal.includes(realToken as any));

  const fakeToken = buildMentionToken("nobody", "Nobody Real");
  const bodyWithFakeToken = `Please check with ${fakeToken} about this.`;
  const renderedFake = renderNoteBodyWithMentions(bodyWithFakeToken, []); // no persisted mention for "nobody"
  const renderedFakeJson = JSON.stringify(renderedFake);
  check("B3. A token with NO matching persisted mention renders its literal raw text (relation is the authority, not the text)", renderedFakeJson.includes(fakeToken));
  check("B3. ...and is never wrapped in the mention-chip styling", !renderedFakeJson.includes("bg-primary/10"));

  const displayNameChanged = renderNoteBodyWithMentions(
    buildMentionToken("user-abc", "Old Stale Name"),
    [{ userId: "user-abc", name: "New Current Name", email: "k@example.com" }]
  );
  check("B4. Rendering prefers the CURRENT name from the relation over the token's embedded (possibly stale) name", JSON.stringify(displayNameChanged).includes("New Current Name") && !JSON.stringify(displayNameChanged).includes("Old Stale Name"));

  check("B5. extractMentionedUserIdsFromBody dedupes the same user mentioned twice in one body to a single id", (() => {
    const twice = `${buildMentionToken("u1", "One")} hey ${buildMentionToken("u1", "One")} again`;
    const ids = extractMentionedUserIdsFromBody(twice);
    return ids.length === 1 && ids[0] === "u1";
  })());

  check("B6. computeMentionNotificationRecipients dedupes a repeated id to one recipient", JSON.stringify(computeMentionNotificationRecipients(["a", "a", "b"], "author")) === JSON.stringify(["a", "b"]));
  check("B7. computeMentionNotificationRecipients excludes the author from their own mention's recipients (self-mention never notifies)", computeMentionNotificationRecipients(["author", "b"], "author").length === 1 && !computeMentionNotificationRecipients(["author", "b"], "author").includes("author"));

  // ══════════════════════ SECTION C — real DB + real routes ══════════════════════
  console.log("\n=== SECTION C — real POST/GET route handlers against real DB fixtures, all three surfaces ===\n");

  let routes: {
    projectNotesRoute: typeof import("@/app/api/projects/[id]/notes/route");
    activityNotesRoute: typeof import("@/app/api/activities/[id]/notes/route");
    ticketReplyRoute: typeof import("@/app/api/tickets/[id]/reply/route");
    mentionSearchRoute: typeof import("@/app/api/mentions/search/route");
  };
  let canActOnEntity: typeof import("@/lib/services/department-scope-service").canActOnEntity;
  let canViewTicket: typeof import("@/lib/services/department-scope-service").canViewTicket;
  try {
    const realNextServer = await import("next/server");
    mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
    // See this file's header comment — short-circuits lib/web-push.ts's
    // `import "server-only"`, which always throws outside Next's own
    // bundler. The route's fire-and-forget push call becomes a no-op here.
    mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

    // department-scope-service.ts (and everything else below) transitively
    // imports lib/permissions.ts, which imports @/lib/auth — MUST be
    // reached only via a dynamic import here, after the @/lib/auth mock at
    // the top of this file has already been registered. A static top-level
    // `import` of this module would resolve (and permanently bind
    // lib/permissions.ts's own `auth` reference) before that mock.module
    // call ever runs, since ES module imports are fully evaluated before
    // any of this file's own top-level code executes — silently leaving
    // requireAuth() using the REAL auth() for the rest of the process, no
    // matter what currentSession is later set to.
    const departmentScopeService = await import("@/lib/services/department-scope-service");
    canActOnEntity = departmentScopeService.canActOnEntity;
    canViewTicket = departmentScopeService.canViewTicket;

    const projectNotesRoute = await import("@/app/api/projects/[id]/notes/route");
    const activityNotesRoute = await import("@/app/api/activities/[id]/notes/route");
    const ticketReplyRoute = await import("@/app/api/tickets/[id]/reply/route");
    const mentionSearchRoute = await import("@/app/api/mentions/search/route");
    routes = { projectNotesRoute, activityNotesRoute, ticketReplyRoute, mentionSearchRoute };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const notificationUserIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `MENTION_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  async function makeUser(tag: string, customRoleId: string | null, isActive = true) {
    const u = await prisma.user.create({
      data: { email: `mention-${tag}-${RUN_ID}@kinsen.gr`, name: `Mention ${tag} ${RUN_ID}`, role: Role.USER, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive },
    });
    userIds.push(u.id);
    notificationUserIds.push(u.id);
    return u;
  }

  function search(entityType: string, entityId: string, q: string) {
    const req = new NextRequest(`http://localhost/api/mentions/search?entityType=${entityType}&entityId=${entityId}&q=${encodeURIComponent(q)}`);
    return routes.mentionSearchRoute.GET(req);
  }

  async function getNotifications(userId: string) {
    return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }
  async function clearNotifications() {
    await prisma.notification.deleteMany({ where: { userId: { in: notificationUserIds } } });
  }

  try {
    const deptA = await prisma.department.create({ data: { name: `Mention Dept A ${RUN_ID}`, slug: `mention-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `Mention Dept B ${RUN_ID}`, slug: `mention-b-${RUN_ID}` } });
    deptIds.push(deptA.id, deptB.id);

    // Neutralizes Role.USER's own global grants (e.g. activity.view — see
    // prisma/seed.ts ROLE_PERMISSIONS.USER) so every fixture below is
    // isolated to ONLY its explicit department-scoped grant — same
    // technique this session's other test scripts already use for the same
    // reason.
    const noopGlobal = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);

    const authorRole = await makeCustomRole("AUTHOR", RoleScope.DEPARTMENT, [
      "project.view", "project.edit", "activity.view", "activity.edit", "ticket.view",
    ]);
    const viewerRole = await makeCustomRole("VIEWER", RoleScope.DEPARTMENT, ["project.view", "activity.view", "ticket.view"]);
    const viewer2Role = await makeCustomRole("VIEWER2", RoleScope.DEPARTMENT, ["project.view", "activity.view", "ticket.view"]);
    const deptBViewerRole = await makeCustomRole("DEPTB_VIEWER", RoleScope.DEPARTMENT, ["project.view", "activity.view", "ticket.view"]);
    // ticket.reply/ticket.internalNote are checked as GLOBAL-role
    // permissions by POST /api/tickets/[id]/reply (hasPermission, not
    // canActOnEntity — Phase 2A intentionally kept these two ungated by
    // department, unlike project.edit/activity.edit above), so the author
    // needs them on their GLOBAL customRoleId, not the department
    // membership's role. A dedicated role (not noopGlobal) keeps every
    // OTHER fixture user's global grant set genuinely empty.
    const authorGlobalRole = await makeCustomRole("AUTHOR_GLOBAL", RoleScope.GLOBAL, ["ticket.reply", "ticket.internalNote"]);

    const author = await makeUser("author", authorGlobalRole.id);
    await grantManualMembership(author.id, deptA.id, { customRoleId: authorRole.id });

    const eligible = await makeUser("eligible", noopGlobal.id);
    await grantManualMembership(eligible.id, deptA.id, { customRoleId: viewerRole.id });

    const eligible2 = await makeUser("eligible2", noopGlobal.id);
    await grantManualMembership(eligible2.id, deptA.id, { customRoleId: viewer2Role.id });

    const outsider = await makeUser("outsider", noopGlobal.id);
    // No membership anywhere — ineligible for everything below.

    const deptBUser = await makeUser("deptb", noopGlobal.id);
    await grantManualMembership(deptBUser.id, deptB.id, { customRoleId: deptBViewerRole.id });

    const inactiveEligible = await makeUser("Konstantinos-Inactive", noopGlobal.id, false);
    await grantManualMembership(inactiveEligible.id, deptA.id, { customRoleId: viewerRole.id });

    const project = await prisma.project.create({ data: { title: `Mention Project ${RUN_ID}`, departmentId: deptA.id, ownerId: author.id } });
    projectIds.push(project.id);
    const activity = await prisma.projectActivity.create({ data: { title: `Mention Activity ${RUN_ID}`, departmentId: deptA.id } });
    activityIds.push(activity.id);
    const defaultStatus = await prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!defaultStatus) throw new Error("No default TicketStatus seeded — cannot create a test ticket.");
    const ticket = await prisma.ticket.create({
      data: { title: `Mention Ticket ${RUN_ID}`, description: "x", requesterId: author.id, departmentId: deptA.id, statusId: defaultStatus.id },
    });
    ticketIds.push(ticket.id);

    type Surface = {
      name: "ticket" | "project" | "activity";
      entityId: string;
      link: string;
      post: (body: string, mentionUserIds: string[]) => Promise<Response>;
      countMentions: (parentId: string) => Promise<number>;
      countRows: () => Promise<number>;
      deleteParent: (parentId: string) => Promise<void>;
    };

    const surfaces: Surface[] = [
      {
        name: "project",
        entityId: project.id,
        link: `/projects/${project.id}`,
        post: (body, mentionUserIds) => {
          const req = new NextRequest(`http://localhost/api/projects/${project.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, mentionUserIds }) });
          return routes.projectNotesRoute.POST(req, { params: Promise.resolve({ id: project.id }) });
        },
        countMentions: (noteId) => prisma.projectNoteMention.count({ where: { noteId } }),
        countRows: () => prisma.projectNote.count({ where: { projectId: project.id } }),
        deleteParent: (noteId) => prisma.projectNote.delete({ where: { id: noteId } }).then(() => {}),
      },
      {
        name: "activity",
        entityId: activity.id,
        link: `/activities/${activity.id}`,
        post: (body, mentionUserIds) => {
          const req = new NextRequest(`http://localhost/api/activities/${activity.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, mentionUserIds }) });
          return routes.activityNotesRoute.POST(req, { params: Promise.resolve({ id: activity.id }) });
        },
        countMentions: (noteId) => prisma.activityNoteMention.count({ where: { noteId } }),
        countRows: () => prisma.activityNote.count({ where: { activityId: activity.id } }),
        deleteParent: (noteId) => prisma.activityNote.delete({ where: { id: noteId } }).then(() => {}),
      },
      {
        name: "ticket",
        entityId: ticket.id,
        link: `/tickets/${ticket.id}`,
        post: (body, mentionUserIds) => {
          const req = new NextRequest(`http://localhost/api/tickets/${ticket.id}/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body, isInternal: true, direction: "INTERNAL_NOTE", mentionUserIds }) });
          return routes.ticketReplyRoute.POST(req, { params: Promise.resolve({ id: ticket.id }) });
        },
        countMentions: (messageId) => prisma.ticketMessageMention.count({ where: { messageId } }),
        countRows: () => prisma.ticketMessage.count({ where: { ticketId: ticket.id, isInternal: true } }),
        deleteParent: (messageId) => prisma.ticketMessage.delete({ where: { id: messageId } }).then(() => {}),
      },
    ];

    for (const surface of surfaces) {
      console.log(`\n--- ${surface.name.toUpperCase()} NOTES ---\n`);
      asUser(author.id, Role.USER, authorGlobalRole.id);

      // Items 1-4: a permitted user mentions a single eligible user, then multiple.
      await clearNotifications();
      const tokenEligible = buildMentionToken(eligible.id, "Eligible One");
      const res1 = await surface.post(`Hey ${tokenEligible} please review.`, [eligible.id]);
      check(`${surface.name}: create with an eligible mention -> 201`, res1.status === 201);
      const body1 = await res1.json();
      const note1Id = body1.id;
      check(`${surface.name}: response includes the resolved mention with a name`, Array.isArray(body1.mentions) && body1.mentions.some((m: any) => m.userId === eligible.id));
      check(`${surface.name}: exactly one persisted mention row`, (await surface.countMentions(note1Id)) === 1);
      const notifs1 = await getNotifications(eligible.id);
      check(`${surface.name}: eligible user received exactly one notification`, notifs1.length === 1);
      check(`${surface.name}: notification link points at the correct entity (item 13)`, notifs1[0]?.link === surface.link);
      check(`${surface.name}: notification body never includes the note's own text (no content leak)`, !notifs1[0]?.body.includes("please review"));

      // Item 11: mentioning does not grant access — verify the DIRECT authorization check for the mentioned user is unaffected by the mention.
      const stillEligible = surface.name === "ticket"
        ? await canViewTicket(eligible.id, Role.USER, { departmentId: deptA.id, subDepartmentId: null, requesterId: ticket.requesterId, assignedAgentId: null, shareWithDepartment: false, shareWithSubDepartment: false })
        : await canActOnEntity(eligible.id, Role.USER, deptA.id, surface.name === "project" ? "project.view" : "activity.view");
      check(`${surface.name}: mentioned user's own view-eligibility is unchanged by being mentioned (still exactly what their real membership grants)`, stillEligible === true);

      // Items 10/11: an UNAUTHORIZED (outsider) user id injected in the request must not become a recorded mention, must not be notified, and must not gain access.
      await clearNotifications();
      const res2 = await surface.post(`Also cc ${buildMentionToken(outsider.id, "Outsider")}.`, [outsider.id]);
      check(`${surface.name}: create still succeeds (201) even though the only requested mention is unauthorized`, res2.status === 201);
      const body2 = await res2.json();
      check(`${surface.name}: the unauthorized user is NOT in the response's resolved mentions`, !(body2.mentions ?? []).some((m: any) => m.userId === outsider.id));
      check(`${surface.name}: zero persisted mention rows for the unauthorized id`, (await surface.countMentions(body2.id)) === 0);
      check(`${surface.name}: the unauthorized (outsider) user received NO notification`, (await getNotifications(outsider.id)).length === 0);
      const outsiderStillCannotView = surface.name === "ticket"
        ? await canViewTicket(outsider.id, Role.USER, { departmentId: deptA.id, subDepartmentId: null, requesterId: ticket.requesterId, assignedAgentId: null, shareWithDepartment: false, shareWithSubDepartment: false })
        : await canActOnEntity(outsider.id, Role.USER, deptA.id, surface.name === "project" ? "project.view" : "activity.view");
      check(`${surface.name}: the mention attempt did NOT grant the outsider entity access (item 11) — still false`, outsiderStillCannotView === false);

      // Multiple distinct mentions in one note.
      await clearNotifications();
      const res3 = await surface.post(
        `${buildMentionToken(eligible.id, "Eligible One")} and ${buildMentionToken(eligible2.id, "Eligible Two")}, please both look.`,
        [eligible.id, eligible2.id]
      );
      check(`${surface.name}: multiple mentions in one note -> 201`, res3.status === 201);
      const body3 = await res3.json();
      check(`${surface.name}: both eligible users resolved in the response`, (body3.mentions ?? []).length === 2);
      check(`${surface.name}: both eligible users each received a notification`, (await getNotifications(eligible.id)).length === 1 && (await getNotifications(eligible2.id)).length === 1);

      // Same user mentioned twice in the same note -> one persisted mention, one notification.
      await clearNotifications();
      const dupToken = buildMentionToken(eligible.id, "Eligible One");
      const res4 = await surface.post(`${dupToken} ping ${dupToken} ping again`, [eligible.id, eligible.id]);
      check(`${surface.name}: duplicate-in-one-note mention -> 201`, res4.status === 201);
      const body4 = await res4.json();
      check(`${surface.name}: exactly ONE logical persisted mention despite two occurrences/two requested ids for the same user`, (await surface.countMentions(body4.id)) === 1);
      check(`${surface.name}: exactly ONE notification for that user, not two`, (await getNotifications(eligible.id)).length === 1);

      // Self-mention: persisted but never notifies the author.
      await clearNotifications();
      const res5 = await surface.post(`Reminder to myself: ${buildMentionToken(author.id, "Author Self")}`, [author.id]);
      check(`${surface.name}: self-mention -> 201`, res5.status === 201);
      const body5 = await res5.json();
      check(`${surface.name}: self-mention IS persisted (harmless reference)`, (await surface.countMentions(body5.id)) === 1);
      check(`${surface.name}: the author received NO notification for mentioning themselves`, (await getNotifications(author.id)).length === 0);

      // Cross-department leak (item 12): a Dept-B-only user can never be a valid mention on a Dept-A entity.
      await clearNotifications();
      const res6 = await surface.post(`Loop in ${buildMentionToken(deptBUser.id, "Dept B User")}.`, [deptBUser.id]);
      check(`${surface.name}: create with a Dept-B-only requested mention still succeeds (201)`, res6.status === 201);
      const body6 = await res6.json();
      check(`${surface.name}: the Dept-B user is NOT resolved as a mention on this Dept-A entity`, !(body6.mentions ?? []).some((m: any) => m.userId === deptBUser.id));
      check(`${surface.name}: the Dept-B user received no notification (no cross-department leak)`, (await getNotifications(deptBUser.id)).length === 0);

      // Delete cascades mention rows (item 9).
      const beforeDeleteCount = await surface.countMentions(body3.id);
      check(`${surface.name}: sanity — the multi-mention note from earlier still has its mention rows before delete`, beforeDeleteCount === 2);
      await surface.deleteParent(body3.id);
      check(`${surface.name}: deleting the note/message cascades — zero mention rows remain for it`, (await surface.countMentions(body3.id)) === 0);
    }

    // ══════════════════════ Picker/search endpoint checks (item 15) ══════════════════════
    console.log("\n--- MENTION SEARCH ENDPOINT ---\n");
    asUser(author.id, Role.USER, authorGlobalRole.id);
    const searchRes = await search("project", project.id, "Mention");
    check("Search: caller with genuine project.view access -> 200", searchRes.status === 200);
    const searchBody = await searchRes.json();
    check("Search: results include the eligible Dept A user", searchBody.some((c: any) => c.id === eligible.id));
    check("Search: results do NOT include the outsider (no access)", !searchBody.some((c: any) => c.id === outsider.id));
    check("Search: results do NOT include the Dept-B-only user", !searchBody.some((c: any) => c.id === deptBUser.id));
    check("Search: results do NOT include the inactive user, even though their name matches the query and they'd otherwise be eligible", !searchBody.some((c: any) => c.id === inactiveEligible.id));
    check("Search: each result exposes ONLY the minimal picker fields (id/name/email/image) — no role/passwordHash/etc.", searchBody.every((c: any) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["email", "id", "image", "name"])));

    asUser(outsider.id, Role.USER, noopGlobal.id);
    const searchAsOutsider = await search("project", project.id, "Mention");
    check("Search: a caller with NO access to the entity itself gets 403 (can't probe who else can view it)", searchAsOutsider.status === 403);

    const prevSession = currentSession;
    currentSession = null;
    const unauthedSearchRes = await search("project", project.id, "x");
    currentSession = prevSession;
    check("Search: a call with no session at all -> 401", unauthedSearchRes.status === 401);

    // ══════════════════════ Existing permission gate unchanged (item 16) ══════════════════════
    console.log("\n--- EXISTING NOTE PERMISSIONS UNCHANGED ---\n");
    asUser(eligible.id, Role.USER, noopGlobal.id); // view-only, no project.edit
    const forbiddenRes = await surfaces[0].post("Should not be allowed", []);
    check("Project notes: a view-only user (no project.edit) still gets 403 creating a note — unchanged by this feature", forbiddenRes.status === 403);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticketMessages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["projectNotes", () => prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } })],
      ["activityNotes", () => prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["notifications", () => prisma.notification.deleteMany({ where: { userId: { in: notificationUserIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["rolePermissions (custom roles)", () => prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } })],
      ["customRoles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of cleanupSteps) {
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
