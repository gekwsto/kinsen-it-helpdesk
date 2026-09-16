/**
 * Fix: Project/Activity @mention eligibility (lib/services/mention-service.ts's
 * candidateCanView, and app/api/mentions/search/route.ts's own
 * callerCanViewEntity gate) used a BARE canActOnEntity(...) check —
 * canActOnEntity alone only resolves canViewAllDepartments(role) (ADMIN/
 * DIRECTOR) or an active DepartmentMembership in the entity's own
 * department; it never consults the candidate's GLOBAL role/custom-role
 * grant at all. A candidate (or note author, for the search endpoint's own
 * gate) whose ONLY project.view/activity.view grant came from a built-in
 * global Role or a global CustomRole — no DepartmentMembership in that
 * entity's department — was therefore wrongly excluded from the picker AND
 * from resolveEligibleMentionUsers, even though the exact same user is
 * correctly treated as an eligible viewer everywhere else in the app.
 *
 * FIX: both call sites now use hasEffectiveEntityPermission
 * (lib/services/department-scope-service.ts) — the union of the global
 * grant and a DepartmentMembership/custom Department role grant FOR THE
 * ENTITY'S OWN department — never hasEffectiveModulePermission (which would
 * leak a Department A grant into eligibility for a Department B entity).
 * Ticket mentions (canViewTicket) are UNCHANGED — no reproduced bug there,
 * and the task's own non-goal says not to touch it without one.
 *
 * Reuses the exact real route handlers / mock.module convention already
 * established in scripts/test-note-mentions.ts (mocked @/lib/auth +
 * next/server + @/lib/web-push) — this file is a focused ADDITION proving
 * the specific closure-pass matrix, not a replacement for that file (which
 * already covers the general mention architecture end to end and must
 * still pass unmodified — see the companion run in the final report).
 *
 * Test matrix (task's own 16-point checklist):
 *  1.  Ticket Internal Notes continue finding eligible users (non-regression
 *      — canViewTicket branch is untouched by this fix).
 *  2.  Project Notes find a candidate with GLOBAL project.view and no
 *      DepartmentMembership.
 *  3.  Activity Notes find a candidate with GLOBAL activity.view and no
 *      DepartmentMembership.
 *  4.  A Department A custom-role project.view grant finds the candidate
 *      for a Department A Project.
 *  5.  The same grant does NOT expose the candidate for a Department B
 *      Project.
 *  6.  Equivalent Department-scoped behavior for Activities.
 *  7.  A valid search result can be persisted as a structured mention.
 *  8.  Search and create-time validation agree.
 *  9.  Crafted unauthorized mention ids remain rejected.
 *  10. Mentioning still grants no entity access.
 *  11. Inactive users/memberships/custom roles remain excluded.
 *  12. Query filtering happens before limiting results.
 *  13. Case-insensitive name/username matching works.
 *  14. A stale async response cannot replace newer results (server-side
 *      statelessness proof — the client-side sequence-number guard itself
 *      is verified by code audit; see the final report).
 *  15. Existing duplicate/self-notification behavior does not regress.
 *  16. All three surfaces still use the same shared components/services.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-mention-global-permission-eligibility.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentRole, MembershipSource, Role, RoleScope } from "@prisma/client";
import { grantManualMembership } from "@/lib/services/department-membership-service";
import { buildMentionToken } from "@/lib/mentions/mention-tokens";

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
  let routes: {
    projectNotesRoute: typeof import("@/app/api/projects/[id]/notes/route");
    activityNotesRoute: typeof import("@/app/api/activities/[id]/notes/route");
    ticketReplyRoute: typeof import("@/app/api/tickets/[id]/reply/route");
    mentionSearchRoute: typeof import("@/app/api/mentions/search/route");
  };
  let canActOnEntity: typeof import("@/lib/services/department-scope-service").canActOnEntity;
  try {
    const realNextServer = await import("next/server");
    mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
    mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

    // MUST be dynamic, after the @/lib/auth mock above — see
    // scripts/test-note-mentions.ts's own header comment for why a static
    // top-level import here would permanently bind the REAL (unmocked)
    // auth() into lib/permissions.ts's module cache.
    const departmentScopeService = await import("@/lib/services/department-scope-service");
    canActOnEntity = departmentScopeService.canActOnEntity;

    routes = {
      projectNotesRoute: await import("@/app/api/projects/[id]/notes/route"),
      activityNotesRoute: await import("@/app/api/activities/[id]/notes/route"),
      ticketReplyRoute: await import("@/app/api/tickets/[id]/reply/route"),
      mentionSearchRoute: await import("@/app/api/mentions/search/route"),
    };
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const customRoleKeys: string[] = [];
  const customRoleIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];
  const notificationUserIds: string[] = [];

  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `MENTIONGLOBAL_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
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
      data: { email: `mentionglobal-${tag}-${RUN_ID}@kinsen.gr`, name: `MentionGlobal ${tag} ${RUN_ID}`, role: Role.USER, customRoleId, authProvider: AuthProvider.CREDENTIALS, isActive },
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
    const deptA = await prisma.department.create({ data: { name: `MentionGlobal Dept A ${RUN_ID}`, slug: `mentionglobal-a-${RUN_ID}` } });
    const deptB = await prisma.department.create({ data: { name: `MentionGlobal Dept B ${RUN_ID}`, slug: `mentionglobal-b-${RUN_ID}` } });
    deptIds.push(deptA.id, deptB.id);

    // Neutralizes Role.USER's own default global grants (see prisma/seed.ts
    // ROLE_PERMISSIONS.USER) so every fixture below is isolated to ONLY its
    // explicit grant — same technique test-note-mentions.ts already uses.
    const noopGlobal = await makeCustomRole("NOOP_GLOBAL", RoleScope.GLOBAL, []);

    // Author: real write access (project.edit/activity.edit/ticket.reply+
    // internalNote) plus enough view standing in Department A to reach the
    // create routes. Global scope for ticket.reply/ticket.internalNote
    // (Phase 2A kept those two global-only, unrelated to this fix).
    // Also grants project.view/activity.view GLOBALLY — purely so this
    // author (the caller doing the searching throughout this file) can
    // legitimately search a Department B project/activity for the
    // cross-department leak checks below (items 5/6), without that being
    // conflated with department-scoped standing. Never used to prove
    // anything about CANDIDATE eligibility, only caller eligibility.
    const authorGlobalRole = await makeCustomRole("AUTHOR_GLOBAL", RoleScope.GLOBAL, ["ticket.reply", "ticket.internalNote", "project.view", "activity.view"]);
    const authorDeptRole = await makeCustomRole("AUTHOR_DEPT", RoleScope.DEPARTMENT, ["project.view", "project.edit", "activity.view", "activity.edit", "ticket.view"]);
    const author = await makeUser("author", authorGlobalRole.id);
    await grantManualMembership(author.id, deptA.id, { customRoleId: authorDeptRole.id });

    // 2/3. GLOBAL grant, NO DepartmentMembership at all.
    const globalProjectRole = await makeCustomRole("GLOBAL_PROJECT_VIEW", RoleScope.GLOBAL, ["project.view"]);
    const globalActivityRole = await makeCustomRole("GLOBAL_ACTIVITY_VIEW", RoleScope.GLOBAL, ["activity.view"]);
    const globalProjectViewer = await makeUser("global-project-viewer", globalProjectRole.id);
    const globalActivityViewer = await makeUser("global-activity-viewer", globalActivityRole.id);

    // 4/5/6. Department-A-scoped custom-role grant, no global grant.
    const deptAProjectRole = await makeCustomRole("DEPTA_PROJECT_VIEW", RoleScope.DEPARTMENT, ["project.view"]);
    const deptAActivityRole = await makeCustomRole("DEPTA_ACTIVITY_VIEW", RoleScope.DEPARTMENT, ["activity.view"]);
    const deptAProjectViewer = await makeUser("depta-project-viewer", noopGlobal.id);
    await grantManualMembership(deptAProjectViewer.id, deptA.id, { customRoleId: deptAProjectRole.id });
    const deptAActivityViewer = await makeUser("depta-activity-viewer", noopGlobal.id);
    await grantManualMembership(deptAActivityViewer.id, deptA.id, { customRoleId: deptAActivityRole.id });

    // 1. Ticket sanity (department-scoped ticket.view, unchanged branch).
    const ticketViewerRole = await makeCustomRole("TICKET_VIEWER", RoleScope.DEPARTMENT, ["ticket.view"]);
    const ticketViewer = await makeUser("ticket-viewer", noopGlobal.id);
    await grantManualMembership(ticketViewer.id, deptA.id, { customRoleId: ticketViewerRole.id });

    // 9/10. An ineligible (Department-B-only) user — for the crafted-id and no-access-granted checks.
    const deptBOnlyRole = await makeCustomRole("DEPTB_ONLY", RoleScope.DEPARTMENT, ["project.view", "activity.view"]);
    const deptBOnlyUser = await makeUser("deptb-only", noopGlobal.id);
    await grantManualMembership(deptBOnlyUser.id, deptB.id, { customRoleId: deptBOnlyRole.id });

    // 11. Inactive user (otherwise-eligible global grant) / inactive membership / inactive custom role.
    const inactiveUser = await makeUser("inactive-user", globalProjectRole.id, false);
    const inactiveMembershipUser = await makeUser("inactive-membership", noopGlobal.id);
    const inactiveMembership = await grantManualMembership(inactiveMembershipUser.id, deptA.id, { customRoleId: deptAProjectRole.id });
    await prisma.departmentMembership.update({ where: { id: inactiveMembership.id }, data: { isActive: false } });
    const inactiveCustomRole = await makeCustomRole("SOON_INACTIVE", RoleScope.DEPARTMENT, ["project.view"]);
    const inactiveCustomRoleUser = await makeUser("inactive-customrole", noopGlobal.id);
    // Created directly (not via grantManualMembership, which forces the
    // built-in role to VIEWER whenever a customRoleId is given — and
    // VIEWER already grants project.view by default, which would make this
    // fixture prove nothing once the custom role is deactivated). REQUESTER
    // does NOT include project.view (see prisma/seed.ts), so once the
    // custom role below is deactivated, hasDepartmentPermission's own
    // documented fallback to the built-in role correctly yields "no grant".
    await prisma.departmentMembership.create({
      data: { userId: inactiveCustomRoleUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, customRoleId: inactiveCustomRole.id, source: MembershipSource.MANUAL, isActive: true },
    });
    await prisma.customRole.update({ where: { id: inactiveCustomRole.id }, data: { isActive: false } });

    // 12/13. Extra candidates for query-filtering / case-insensitivity checks — a distinctly-named global project viewer.
    const uniqueNameRole = await makeCustomRole("UNIQUE_NAME_ROLE", RoleScope.GLOBAL, ["project.view"]);
    const uniqueNamedUser = await prisma.user.create({
      data: { email: `mentionglobal-zzyzx-${RUN_ID}@kinsen.gr`, name: `Zzyzx Quibblewick ${RUN_ID}`, role: Role.USER, customRoleId: uniqueNameRole.id, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(uniqueNamedUser.id);
    notificationUserIds.push(uniqueNamedUser.id);

    const projectA = await prisma.project.create({ data: { title: `MentionGlobal Project A ${RUN_ID}`, departmentId: deptA.id, ownerId: author.id } });
    projectIds.push(projectA.id);
    const projectB = await prisma.project.create({ data: { title: `MentionGlobal Project B ${RUN_ID}`, departmentId: deptB.id, ownerId: author.id } });
    projectIds.push(projectB.id);
    const activityA = await prisma.projectActivity.create({ data: { title: `MentionGlobal Activity A ${RUN_ID}`, departmentId: deptA.id } });
    activityIds.push(activityA.id);
    const activityB = await prisma.projectActivity.create({ data: { title: `MentionGlobal Activity B ${RUN_ID}`, departmentId: deptB.id } });
    activityIds.push(activityB.id);
    const defaultStatus = await prisma.ticketStatus.findFirstOrThrow({ where: { isDefault: true } });
    const ticket = await prisma.ticket.create({
      data: { title: `MentionGlobal Ticket ${RUN_ID}`, description: "x", requesterId: author.id, departmentId: deptA.id, statusId: defaultStatus.id },
    });
    ticketIds.push(ticket.id);

    asUser(author.id, Role.USER, authorGlobalRole.id);

    // Every fixture user's name embeds RUN_ID (see makeUser above) — search
    // queries below narrow to it so results are deterministic regardless of
    // how many OTHER users already exist in a shared dev database (avoids
    // relying on alphabetical-name ordering + the picker's hard result cap
    // to coincidentally include this run's own fixtures).
    const RUN_TAG = String(RUN_ID);

    // ── 1. Ticket Internal Notes continue finding eligible users ──
    console.log("\n1. Ticket Internal Notes continue finding eligible users (non-regression, canViewTicket branch untouched) ===\n");
    const ticketSearchRes = await search("ticket", ticket.id, RUN_TAG);
    check("1a. Ticket mention search -> 200", ticketSearchRes.status === 200);
    const ticketSearchBody = await ticketSearchRes.json();
    check("1b. The Department A ticket viewer is found", ticketSearchBody.some((c: any) => c.id === ticketViewer.id));

    // ── 2. Project Notes find a GLOBAL project.view candidate with no DepartmentMembership ──
    console.log("\n2. Project Notes: a candidate with GLOBAL project.view and NO DepartmentMembership is found ===\n");
    const projectSearchRes = await search("project", projectA.id, RUN_TAG);
    check("2a. Project mention search -> 200", projectSearchRes.status === 200);
    const projectSearchBody = await projectSearchRes.json();
    check("2b. The global project.view candidate (no membership at all) IS found — this was the bug", projectSearchBody.some((c: any) => c.id === globalProjectViewer.id));
    const globalProjectMembership = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: globalProjectViewer.id, departmentId: deptA.id } } });
    check("2c. Sanity: this candidate genuinely has no Department A membership row at all", globalProjectMembership === null);

    // ── 3. Activity Notes find a GLOBAL activity.view candidate with no DepartmentMembership ──
    console.log("\n3. Activity Notes: a candidate with GLOBAL activity.view and NO DepartmentMembership is found ===\n");
    const activitySearchRes = await search("activity", activityA.id, RUN_TAG);
    check("3a. Activity mention search -> 200", activitySearchRes.status === 200);
    const activitySearchBody = await activitySearchRes.json();
    check("3b. The global activity.view candidate (no membership at all) IS found", activitySearchBody.some((c: any) => c.id === globalActivityViewer.id));

    // ── 4/5. Department A custom-role project.view grant: found for Dept A, not for Dept B ──
    console.log("\n4/5. A Department A custom-role project.view grant finds the candidate for the Department A Project, not for Department B ===\n");
    check("4a. deptAProjectViewer found for the Department A project", projectSearchBody.some((c: any) => c.id === deptAProjectViewer.id));
    const projectBSearchRes = await search("project", projectB.id, RUN_TAG);
    check("5a0. Project B search -> 200 (author's global project.view lets them legitimately search here)", projectBSearchRes.status === 200, `got ${projectBSearchRes.status}`);
    const projectBSearchBody = await projectBSearchRes.json();
    check("5a. deptAProjectViewer is NOT found for the Department B project — no cross-department leak", !projectBSearchBody.some((c: any) => c.id === deptAProjectViewer.id));
    check("5b. The global project.view candidate IS still found for Department B (global grant applies everywhere)", projectBSearchBody.some((c: any) => c.id === globalProjectViewer.id));

    // ── 6. Equivalent Department-scoped behavior for Activities ──
    console.log("\n6. Equivalent Department-scoped behavior for Activities ===\n");
    check("6a. deptAActivityViewer found for the Department A activity", activitySearchBody.some((c: any) => c.id === deptAActivityViewer.id));
    const activityBSearchRes = await search("activity", activityB.id, RUN_TAG);
    const activityBSearchBody = await activityBSearchRes.json();
    check("6b. deptAActivityViewer is NOT found for the Department B activity", !activityBSearchBody.some((c: any) => c.id === deptAActivityViewer.id));

    // ── 7/8. A valid search result can be persisted as a structured mention; search and create-time validation agree ──
    console.log("\n7/8. A valid search result (global-grant candidate) can be persisted as a structured mention; search and create-time validation agree ===\n");
    await clearNotifications();
    const token = buildMentionToken(globalProjectViewer.id, "Global Project Viewer");
    const createRes = await routes.projectNotesRoute.POST(
      new NextRequest(`http://localhost/api/projects/${projectA.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: `Hey ${token} please take a look.`, mentionUserIds: [globalProjectViewer.id] }) }),
      { params: Promise.resolve({ id: projectA.id }) }
    );
    check("7a. Note create with the global-grant candidate mentioned -> 201", createRes.status === 201, `got ${createRes.status}`);
    const createdNote = await createRes.json();
    check("7b. Response resolves the mention (search found it, create accepted it — parity)", Array.isArray(createdNote.mentions) && createdNote.mentions.some((m: any) => m.userId === globalProjectViewer.id));
    check("7c. Exactly one persisted mention row", (await prisma.projectNoteMention.count({ where: { noteId: createdNote.id } })) === 1);
    const globalViewerNotifs = await getNotifications(globalProjectViewer.id);
    check("8a. The mentioned global-grant candidate received a notification (search eligibility and create eligibility fully agree)", globalViewerNotifs.length === 1);

    // ── 9. Crafted unauthorized mention ids remain rejected ──
    console.log("\n9. A crafted request naming an unauthorized (Department-B-only) user id is silently rejected, note still succeeds ===\n");
    await clearNotifications();
    const craftedRes = await routes.projectNotesRoute.POST(
      new NextRequest(`http://localhost/api/projects/${projectA.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Trying to mention someone unauthorized.", mentionUserIds: [deptBOnlyUser.id] }) }),
      { params: Promise.resolve({ id: projectA.id }) }
    );
    check("9a. Note create still succeeds (201) even though the only requested mention is unauthorized", craftedRes.status === 201);
    const craftedNote = await craftedRes.json();
    check("9b. The unauthorized user is NOT in the response's resolved mentions", !craftedNote.mentions.some((m: any) => m.userId === deptBOnlyUser.id));
    check("9c. Zero persisted mention rows for the unauthorized id", (await prisma.projectNoteMention.count({ where: { noteId: craftedNote.id } })) === 0);
    check("9d. The unauthorized user received no notification", (await getNotifications(deptBOnlyUser.id)).length === 0);

    // ── 10. Mentioning still grants no entity access ──
    console.log("\n10. The mention attempt did NOT grant the unauthorized user entity access ===\n");
    check("10a. The Department-B-only user still cannot view the Department A project", !(await canActOnEntity(deptBOnlyUser.id, Role.USER, deptA.id, "project.view")));

    // ── 11. Inactive users/memberships/custom roles remain excluded ──
    console.log("\n11. Inactive users, inactive memberships, and inactive custom roles remain excluded ===\n");
    const freshProjectSearch = await (await search("project", projectA.id, RUN_TAG)).json();
    check("11a. An inactive user (otherwise-eligible global grant) is excluded", !freshProjectSearch.some((c: any) => c.id === inactiveUser.id));
    check("11b. A user with an INACTIVE DepartmentMembership is excluded", !freshProjectSearch.some((c: any) => c.id === inactiveMembershipUser.id));
    check("11c. A user whose custom Department role is INACTIVE is excluded (falls back to the built-in DepartmentRole, which lacks project.view)", !freshProjectSearch.some((c: any) => c.id === inactiveCustomRoleUser.id));

    // ── 12. Query filtering happens before limiting results ──
    console.log("\n12. Query filtering happens server-side before the result limit is applied ===\n");
    const filteredRes = await (await search("project", projectA.id, "Zzyzx")).json();
    check("12a. Searching a distinctive substring returns ONLY the matching candidate, not an arbitrary pre-limit slice", filteredRes.length === 1 && filteredRes[0].id === uniqueNamedUser.id);

    // ── 13. Case-insensitive matching ──
    console.log("\n13. Case-insensitive name matching ===\n");
    const upperRes = await (await search("project", projectA.id, "ZZYZX")).json();
    const lowerRes = await (await search("project", projectA.id, "zzyzx")).json();
    check("13a. Uppercase query still matches", upperRes.some((c: any) => c.id === uniqueNamedUser.id));
    check("13b. Lowercase query still matches", lowerRes.some((c: any) => c.id === uniqueNamedUser.id));

    // ── 14. A stale async response cannot replace newer results (server-side statelessness) ──
    console.log("\n14. Concurrent searches with different query text each resolve independently — no shared/global server state to leak between them ===\n");
    const [concurrentA, concurrentB] = await Promise.all([
      search("project", projectA.id, "Zzyzx"),
      search("project", projectA.id, "global-project-viewer"),
    ]);
    const concurrentABody = await concurrentA.json();
    const concurrentBBody = await concurrentB.json();
    check("14a. The first concurrent request's results match its OWN query", concurrentABody.every((c: any) => c.id === uniqueNamedUser.id));
    check("14b. The second concurrent request's results are unaffected by the first (no cross-request contamination server-side)", !concurrentBBody.some((c: any) => c.id === uniqueNamedUser.id));

    // ── 15. Existing duplicate/self-notification behavior does not regress ──
    console.log("\n15. Duplicate-in-one-note and self-mention behavior is unchanged for this new global-grant fixture ===\n");
    await clearNotifications();
    const dupToken = buildMentionToken(globalProjectViewer.id, "Global Project Viewer");
    const dupRes = await routes.projectNotesRoute.POST(
      new NextRequest(`http://localhost/api/projects/${projectA.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: `${dupToken} and again ${dupToken}`, mentionUserIds: [globalProjectViewer.id, globalProjectViewer.id] }) }),
      { params: Promise.resolve({ id: projectA.id }) }
    );
    const dupNote = await dupRes.json();
    check("15a. Duplicate mention -> 201", dupRes.status === 201);
    check("15b. Exactly ONE persisted mention row despite two occurrences/two requested ids", (await prisma.projectNoteMention.count({ where: { noteId: dupNote.id } })) === 1);
    check("15c. Exactly ONE notification, not two", (await getNotifications(globalProjectViewer.id)).length === 1);

    await clearNotifications();
    const selfToken = buildMentionToken(author.id, "Author Self");
    const selfRes = await routes.projectNotesRoute.POST(
      new NextRequest(`http://localhost/api/projects/${projectA.id}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: `Note to self ${selfToken}`, mentionUserIds: [author.id] }) }),
      { params: Promise.resolve({ id: projectA.id }) }
    );
    check("15d. Self-mention -> 201", selfRes.status === 201);
    check("15e. The author received NO notification for mentioning themselves", (await getNotifications(author.id)).length === 0);

    // ── 16. All three surfaces still use the same shared components/services ──
    console.log("\n16. All three surfaces still funnel through the SAME shared mention-service, never separate implementations ===\n");
    const fs = await import("fs/promises");
    const mentionServiceSrc = await fs.readFile("lib/services/mention-service.ts", "utf-8");
    const projectRouteSrc = await fs.readFile("app/api/projects/[id]/notes/route.ts", "utf-8");
    const activityRouteSrc = await fs.readFile("app/api/activities/[id]/notes/route.ts", "utf-8");
    const ticketRouteSrc = await fs.readFile("app/api/tickets/[id]/reply/route.ts", "utf-8");
    check("16a. Exactly one candidateCanView function exists in the shared service (not duplicated per surface)", (mentionServiceSrc.match(/function candidateCanView/g) ?? []).length === 1);
    check("16b. Project notes route imports resolveEligibleMentionUsers from the shared service", /from "@\/lib\/services\/mention-service"/.test(projectRouteSrc) && /resolveEligibleMentionUsers/.test(projectRouteSrc));
    check("16c. Activity notes route imports resolveEligibleMentionUsers from the shared service", /from "@\/lib\/services\/mention-service"/.test(activityRouteSrc) && /resolveEligibleMentionUsers/.test(activityRouteSrc));
    check("16d. Ticket reply route imports resolveEligibleMentionUsers from the shared service", /from "@\/lib\/services\/mention-service"/.test(ticketRouteSrc) && /resolveEligibleMentionUsers/.test(ticketRouteSrc));
    check("16e. The fix uses hasEffectiveEntityPermission, never a bare canActOnEntity call, for project/activity eligibility", /hasEffectiveEntityPermission/.test(mentionServiceSrc));
    check("16f. No role-name string comparisons were introduced (e.g. \"Department Admin\")", !mentionServiceSrc.includes('"Department Admin"'));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["projectNoteMentions", () => prisma.projectNoteMention.deleteMany({ where: { note: { projectId: { in: projectIds } } } })],
      ["projectNotes", () => prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } })],
      ["activityNoteMentions", () => (activityIds.length > 0 ? prisma.activityNoteMention.deleteMany({ where: { note: { activityId: { in: activityIds } } } }) : Promise.resolve())],
      ["activityNotes", () => (activityIds.length > 0 ? prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } }) : Promise.resolve())],
      ["ticketMessageMentions", () => (ticketIds.length > 0 ? prisma.ticketMessageMention.deleteMany({ where: { message: { ticketId: { in: ticketIds } } } }) : Promise.resolve())],
      ["ticketMessages", () => (ticketIds.length > 0 ? prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } }) : Promise.resolve())],
      ["tickets", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length > 0 ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["notifications", () => (notificationUserIds.length > 0 ? prisma.notification.deleteMany({ where: { userId: { in: notificationUserIds } } }) : Promise.resolve())],
      ["departmentMemberships", () => (userIds.length > 0 ? prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } }) : Promise.resolve())],
      ["users", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["rolePermissions (custom roles)", () => (customRoleKeys.length > 0 ? prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } }) : Promise.resolve())],
      ["customRoles", () => (customRoleIds.length > 0 ? prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } }) : Promise.resolve())],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => (deptIds.length > 0 ? prisma.department.deleteMany({ where: { id: { in: deptIds } } }) : Promise.resolve())],
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
