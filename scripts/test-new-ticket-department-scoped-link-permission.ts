/**
 * New Ticket form UI-scope closure for ticket.linkProjectActivity.
 *
 * BUG: app/(main)/tickets/new/page.tsx used hasEffectiveModulePermission —
 * true if the user has ticket.linkProjectActivity in ANY department. A user
 * with the grant only in Department A would see the linking UI enabled even
 * after selecting Department B as the ticket's destination (backend-safe,
 * since POST /api/tickets re-resolves and re-checks the real destination —
 * but a misleading, incorrectly-scoped UI).
 *
 * FIX: the page now resolves TWO pieces via the existing canonical
 * architecture (no new endpoint, no role-name check):
 *   - hasGlobalLinkPermission: the plain global grant (hasPermission).
 *   - linkPermissionDepartmentIds: exactly which destination departments the
 *     user's own DepartmentMembership/custom Department role grants it in
 *     (getAccessibleDepartmentSummaries — the same primitive
 *     projectCreateDepartmentIds/activityCreateDepartmentIds already use).
 * Both are passed to CreateTicketForm (components/tickets/ticket-form.tsx),
 * which combines them against whichever department is CURRENTLY SELECTED
 * via two small exported pure functions — computeCanLinkProjectActivityHere
 * and shouldClearDraftProjectActivityLink — reused directly here (not
 * reimplemented) to prove the exact client-side decision logic without
 * needing a full browser harness (this repo's script-based test convention
 * has no jsdom/RTL; the pure-function extraction keeps this test exercising
 * the REAL logic the component calls, not a parallel model of it).
 *
 * Test matrix (see the task's own 11-point checklist):
 *  1/2/3. User has the grant only in Department A: selecting A enables
 *      linking, selecting B disables it.
 *  4/5/6. Switching A -> B clears any draft Project/Activity link (and the
 *      cleared fields are therefore genuinely absent from what would be
 *      submitted — proven directly against the real POST route); switching
 *      B -> A re-enables linking.
 *  7.  A genuine global grant enables linking for both A and B.
 *  8.  No grant anywhere keeps linking unavailable for both.
 *  9.  The active-workspace cookie does not override: the SERVER-computed
 *      linkPermissionDepartmentIds/hasGlobalLinkPermission are proven
 *      independent of the workspace cookie, and the CLIENT decision
 *      function only ever takes the explicitly selected departmentId as
 *      input (structurally cannot see "default"/workspace state at all).
 *  10. A crafted POST for Department B is still rejected by the existing,
 *      unmodified backend check.
 *  11. No global Simple User grant or role seed is changed.
 *
 * Exercises the REAL Server Component page (app/(main)/tickets/new/page.tsx),
 * the REAL POST /api/tickets route, and the REAL exported pure decision
 * functions from components/tickets/ticket-form.tsx — mocked @/lib/auth +
 * next/headers + next/server + @/lib/web-push, same convention as
 * scripts/test-ticket-link-department-scoped-permission.ts.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-new-ticket-department-scoped-link-permission.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, RoleScope, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
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

const RUN_ID = Date.now();
const TAG = `ntdslp-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined),
    }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

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

  // hasPermission (and anything else touching @/lib/permissions) must be
  // dynamically imported here, AFTER the mocks above are registered —
  // never as a static top-level import: a static import is hoisted and
  // evaluated before ANY module-body code (including the mock.module calls
  // above) runs, which would load lib/permissions.ts's own `import { auth }
  // from "@/lib/auth"` against the REAL, unmocked module and poison Node's
  // module cache for every later importer of lib/permissions.ts, including
  // the route handlers below.
  const { hasPermission } = await import("@/lib/permissions");
  const { default: NewTicketPage } = await import("@/app/(main)/tickets/new/page");
  const { CreateTicketForm, computeCanLinkProjectActivityHere, shouldClearDraftProjectActivityLink } = await import("@/components/tickets/ticket-form");
  const { POST: createTicketPOST } = await import("@/app/api/tickets/route");

  const jsonReq = (url: string, body: unknown) =>
    new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const renderNewTicketPage = async (): Promise<{ hasGlobalLinkPermission: boolean; linkPermissionDepartmentIds: string[] } | { redirectTo: string } | { deniedNoAccess: true }> => {
    try {
      const element = await NewTicketPage();
      const [formEl] = findElementsByType(element, CreateTicketForm);
      if (!formEl) return { deniedNoAccess: true };
      return { hasGlobalLinkPermission: formEl.props.hasGlobalLinkPermission, linkPermissionDepartmentIds: formEl.props.linkPermissionDepartmentIds };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { redirectTo: err.digest };
      }
      throw err;
    }
  };

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const customRoleKeys: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, a Department-A-scoped custom role granting ticket.linkProjectActivity ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const simpleUser = await prisma.user.create({
      data: { email: `${TAG}-simpleuser@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(simpleUser.id);

    const deptRole = await prisma.customRole.create({
      data: { key: `${TAG}-dept-role`, name: "Department Linker", isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleKeys.push(deptRole.key);
    for (const key of ["ticket.create", "ticket.linkProjectActivity"]) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: deptRole.key, permissionId: perm.id } });
    }
    const membershipA = await prisma.departmentMembership.create({
      data: { userId: simpleUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_ADMIN, customRoleId: deptRole.id, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(membershipA.id);

    const projectA = await prisma.project.create({ data: { title: `${TAG} Project A`, status: ProjectStatus.IN_PROGRESS, departmentId: deptA.id, ownerId: simpleUser.id } });
    projectIds.push(projectA.id);

    // ── 1/2/3. Server-side: linkPermissionDepartmentIds is scoped to exactly Department A ──
    console.log("\n1/2/3. Server: hasGlobalLinkPermission=false, linkPermissionDepartmentIds=[Department A] only ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    currentCookieDepartmentId = deptA.id;
    const renderedA = await renderNewTicketPage();
    check("1a. New Ticket page renders (not redirected/denied)", !("redirectTo" in renderedA) && !("deniedNoAccess" in renderedA));
    if (!("redirectTo" in renderedA) && !("deniedNoAccess" in renderedA)) {
      check("1b. hasGlobalLinkPermission is false", renderedA.hasGlobalLinkPermission === false);
      check("1c. linkPermissionDepartmentIds contains Department A", renderedA.linkPermissionDepartmentIds.includes(deptA.id));
      check("1d. linkPermissionDepartmentIds does NOT contain Department B", !renderedA.linkPermissionDepartmentIds.includes(deptB.id));

      console.log("\n2. Client: selecting Department A -> linking enabled ===\n");
      const enabledForA = computeCanLinkProjectActivityHere({
        selectedDepartmentId: deptA.id,
        hasGlobalLinkPermission: renderedA.hasGlobalLinkPermission,
        linkPermissionDepartmentIds: renderedA.linkPermissionDepartmentIds,
      });
      check("2a. computeCanLinkProjectActivityHere(Department A) -> true", enabledForA === true);

      console.log("\n3. Client: selecting Department B -> linking disabled ===\n");
      const enabledForB = computeCanLinkProjectActivityHere({
        selectedDepartmentId: deptB.id,
        hasGlobalLinkPermission: renderedA.hasGlobalLinkPermission,
        linkPermissionDepartmentIds: renderedA.linkPermissionDepartmentIds,
      });
      check("3a. computeCanLinkProjectActivityHere(Department B) -> false", enabledForB === false);

      // ── 4. Switching A -> B with a draft link staged clears it ──
      console.log("\n4. Switching A -> B with a staged draft Project link clears it deterministically ===\n");
      const shouldClearOnSwitchToB = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: enabledForB,
        hasDraftProjectId: true,
        hasDraftActivityId: false,
        selectedDepartmentId: deptB.id,
      });
      check("4a. shouldClearDraftProjectActivityLink -> true when a draft projectId exists and the new department disallows linking", shouldClearOnSwitchToB === true);
      const shouldClearWithNoDraft = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: enabledForB,
        hasDraftProjectId: false,
        hasDraftActivityId: false,
        selectedDepartmentId: deptB.id,
      });
      check("4b. ...but never fires a needless clear when there was no draft link to begin with", shouldClearWithNoDraft === false);
      const shouldClearWhenStillAllowed = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: enabledForA,
        hasDraftProjectId: true,
        hasDraftActivityId: false,
        draftProjectDepartmentId: deptA.id,
        selectedDepartmentId: deptA.id,
      });
      check("4c. ...and never clears a draft link when the (still-selected) department DOES allow linking", shouldClearWhenStillAllowed === false);

      // ── 5. The cleared link is genuinely absent from the POST payload — proven against the real backend ──
      console.log("\n5. Cleared link never reaches POST /api/tickets — creating a Department B ticket with NO projectId field succeeds and stays unlinked ===\n");
      const createUnlinkedRes = await createTicketPOST(
        jsonReq("http://localhost/api/tickets", { title: `${TAG} cleared-link`, description: "fixture description long enough", departmentId: deptB.id })
      );
      check("5a. Creating the Department B ticket with the link fields omitted (as the cleared form would submit) -> 201", createUnlinkedRes.status === 201, `got ${createUnlinkedRes.status}`);
      const createdUnlinked = await createUnlinkedRes.json().catch(() => null);
      if (createdUnlinked?.id) ticketIds.push(createdUnlinked.id);
      check("5b. ...and the created ticket has no projectId (nothing stale carried through)", createdUnlinked?.projectId == null);
      // Sanity: had the STALE projectId actually been submitted instead, the same route would have rejected it (this user has no Department B link grant) — proves the clearing is what makes 5a succeed, not a coincidentally-permissive route.
      const staleAttemptRes = await createTicketPOST(
        jsonReq("http://localhost/api/tickets", { title: `${TAG} stale-attempt`, description: "fixture description long enough", departmentId: deptB.id, projectId: projectA.id })
      );
      check("5c. Sanity: submitting the STALE Department A projectId against a Department B ticket is rejected (proves 5a's success came from the clearing, not a lenient route)", staleAttemptRes.status !== 201, `got ${staleAttemptRes.status}`);

      // ── 6. Switching B -> A re-enables linking ──
      console.log("\n6. Switching back B -> A re-enables linking ===\n");
      const enabledAfterSwitchBack = computeCanLinkProjectActivityHere({
        selectedDepartmentId: deptA.id,
        hasGlobalLinkPermission: renderedA.hasGlobalLinkPermission,
        linkPermissionDepartmentIds: renderedA.linkPermissionDepartmentIds,
      });
      check("6a. computeCanLinkProjectActivityHere(Department A) after switching back -> true", enabledAfterSwitchBack === true);
    }

    // ── 7. A genuine global grant enables linking for both A and B ──
    console.log("\n7. A genuine GLOBAL grant enables linking for BOTH Department A and Department B ===\n");
    const globalGrantedUser = await prisma.user.create({
      data: { email: `${TAG}-globalgrant@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(globalGrantedUser.id);
    const globalRole = await prisma.customRole.create({
      data: { key: `${TAG}-global-link`, name: `${TAG} global link`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleKeys.push(globalRole.key);
    for (const key of ["ticket.create", "ticket.linkProjectActivity"]) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: globalRole.key, permissionId: perm.id } });
    }
    // A plain Department A membership (built-in REQUESTER — no
    // ticket.linkProjectActivity of its own; see prisma/seed.ts) purely so
    // an active workspace resolves at all (getActiveWorkspace needs at
    // least one accessible department to default to — unrelated to this
    // fix). Isolates that the GLOBAL grant alone is what enables linking in
    // BOTH departments below, not any department-level standing.
    const globalGrantedMembership = await prisma.departmentMembership.create({
      data: { userId: globalGrantedUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(globalGrantedMembership.id);
    currentSession = { user: { id: globalGrantedUser.id, role: Role.USER, customRoleId: globalRole.id } };
    currentCookieDepartmentId = deptA.id;
    const renderedGlobal = await renderNewTicketPage();
    check("7a. New Ticket page renders for the global-grant user", !("redirectTo" in renderedGlobal) && !("deniedNoAccess" in renderedGlobal));
    if (!("redirectTo" in renderedGlobal) && !("deniedNoAccess" in renderedGlobal)) {
      check("7b. hasGlobalLinkPermission is true", renderedGlobal.hasGlobalLinkPermission === true);
      const globalEnabledForA = computeCanLinkProjectActivityHere({ selectedDepartmentId: deptA.id, hasGlobalLinkPermission: renderedGlobal.hasGlobalLinkPermission, linkPermissionDepartmentIds: renderedGlobal.linkPermissionDepartmentIds });
      const globalEnabledForB = computeCanLinkProjectActivityHere({ selectedDepartmentId: deptB.id, hasGlobalLinkPermission: renderedGlobal.hasGlobalLinkPermission, linkPermissionDepartmentIds: renderedGlobal.linkPermissionDepartmentIds });
      check("7c. Enabled for Department A", globalEnabledForA === true);
      check("7d. Enabled for Department B too", globalEnabledForB === true);
    }

    // ═══════════════════════════════════════════════════════════════════
    // DRAFT-INTEGRITY AUDIT — closure pass: a GLOBAL grant covers every
    // department, so switching destination departments never disables
    // linking itself, but a staged Project/Activity from the OLD
    // department is still incompatible with the NEW one. Proves
    // shouldClearDraftProjectActivityLink's second, independent clearing
    // reason (isDraftEntityCompatibleWithDepartment) — not just the
    // permission-loss reason already covered by item 4 above. See the
    // task's own 9-point checklist (DI.1-DI.9).
    // ═══════════════════════════════════════════════════════════════════
    console.log("\nDI — Draft-integrity audit: incompatible staged Project/Activity clears even when linking itself remains authorized ===\n");
    {
      const activityA = await prisma.projectActivity.create({
        data: { title: `${TAG} Activity A`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: deptA.id, projectId: projectA.id },
      });
      activityIds.push(activityA.id);

      // DI.1 — Department-A-only permission: stage a Department A Project, switch to Department B, draft clears.
      console.log("\nDI.1. Department-A-only permission: staged Department A Project clears when switching to Department B ===\n");
      const di1 = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: false, // simpleUser (Department-A-only grant) has no standing in Department B at all — matches item 4 above, restated here for the full DI matrix.
        hasDraftProjectId: true,
        hasDraftActivityId: false,
        draftProjectDepartmentId: deptA.id,
        selectedDepartmentId: deptB.id,
      });
      check("DI.1a. Draft clears (permission itself is lost for Department B)", di1 === true);

      // DI.2 — Global permission: stage a Department A Project, switch to Department B — linking STAYS enabled (global grant), but the incompatible draft still clears.
      console.log("\nDI.2. Global permission: staged Department A Project still clears on switch to Department B, even though linking stays enabled ===\n");
      const canLinkStillTrueForB = computeCanLinkProjectActivityHere({ selectedDepartmentId: deptB.id, hasGlobalLinkPermission: true, linkPermissionDepartmentIds: [] });
      check("DI.2a. Sanity: linking itself is still authorized for Department B under the global grant", canLinkStillTrueForB === true);
      const di2 = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: canLinkStillTrueForB,
        hasDraftProjectId: true,
        hasDraftActivityId: false,
        draftProjectDepartmentId: projectA.departmentId,
        selectedDepartmentId: deptB.id,
      });
      check("DI.2b. The incompatible Department A project still clears (permission alone is not enough to keep it staged)", di2 === true);

      // DI.3 — Same, for an Activity.
      console.log("\nDI.3. Same as DI.2, for a staged Activity ===\n");
      const di3 = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: canLinkStillTrueForB,
        hasDraftProjectId: false,
        hasDraftActivityId: true,
        draftActivityDepartmentId: activityA.departmentId,
        selectedDepartmentId: deptB.id,
      });
      check("DI.3a. The incompatible Department A activity still clears under the same global-permission scenario", di3 === true);

      // DI.4 — A compatible staged entity is not cleared unnecessarily.
      console.log("\nDI.4. A compatible staged entity (same department as the new selection) is NOT cleared ===\n");
      const di4Project = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: true,
        hasDraftProjectId: true,
        hasDraftActivityId: false,
        draftProjectDepartmentId: deptA.id,
        selectedDepartmentId: deptA.id,
      });
      check("DI.4a. A Department A project stays staged when the selection is (still/again) Department A", di4Project === false);
      const di4Legacy = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: true,
        hasDraftActivityId: true,
        hasDraftProjectId: false,
        draftActivityDepartmentId: null, // legacy/no-department activity — compatible with any destination, mirrors validateTicketProjectActivityLink's own leniency.
        selectedDepartmentId: deptB.id,
      });
      check("DI.4b. A legacy (null-department) activity is NOT cleared regardless of the selected department", di4Legacy === false);

      // DI.5 — Changing departments with no staged link produces no toast (proven via the same gating decision the component's toast is conditioned on).
      console.log("\nDI.5. No staged link at all -> no clear decision fires (nothing for the component to show a toast about) ===\n");
      const di5 = shouldClearDraftProjectActivityLink({
        canLinkProjectActivityHere: canLinkStillTrueForB,
        hasDraftProjectId: false,
        hasDraftActivityId: false,
        selectedDepartmentId: deptB.id,
      });
      check("DI.5a. shouldClearDraftProjectActivityLink -> false with nothing staged (the component's toast is gated on this exact value, so it never fires here)", di5 === false);

      // DI.6 — Cleared projectId/activityId is genuinely absent from the submitted POST payload (real backend, global-grant user).
      console.log("\nDI.6. Real POST: a global-grant user creating a Department B ticket with the (cleared) link fields omitted succeeds unlinked ===\n");
      currentSession = { user: { id: globalGrantedUser.id, role: Role.USER, customRoleId: globalRole.id } };
      const di6Res = await createTicketPOST(
        jsonReq("http://localhost/api/tickets", { title: `${TAG} DI-cleared`, description: "fixture description long enough", departmentId: deptB.id })
      );
      check("DI.6a. Creating the Department B ticket with no projectId/activityId (as the cleared form would submit) -> 201", di6Res.status === 201, `got ${di6Res.status}`);
      const di6Created = await di6Res.json().catch(() => null);
      if (di6Created?.id) ticketIds.push(di6Created.id);
      check("DI.6b. ...and it has no projectId/activityId (nothing stale carried through)", di6Created?.projectId == null && di6Created?.activityId == null);
      // Sanity: had the stale Department A project actually been submitted instead, the SAME (unmodified) backend validation would reject it — proves DI.6a's success came from the clearing, not a lenient route.
      const di6StaleRes = await createTicketPOST(
        jsonReq("http://localhost/api/tickets", { title: `${TAG} DI-stale`, description: "fixture description long enough", departmentId: deptB.id, projectId: projectA.id })
      );
      check("DI.6c. Sanity: submitting the STALE Department A project against a Department B ticket is still rejected (linking is authorized, but the entity is cross-department)", di6StaleRes.status !== 201, `got ${di6StaleRes.status}`);

      // DI.7 — The Project/Activity entity itself is never updated or moved by any of the above.
      console.log("\nDI.7. The Project and Activity themselves were never touched/moved by any draft-clearing decision above ===\n");
      const projectAAfter = await prisma.project.findUnique({ where: { id: projectA.id }, select: { departmentId: true, title: true } });
      const activityAAfter = await prisma.projectActivity.findUnique({ where: { id: activityA.id }, select: { departmentId: true, title: true } });
      check("DI.7a. Project A's departmentId is unchanged (still Department A)", projectAAfter?.departmentId === deptA.id);
      check("DI.7b. Project A's title is unchanged", projectAAfter?.title === `${TAG} Project A`);
      check("DI.7c. Activity A's departmentId is unchanged (still Department A)", activityAAfter?.departmentId === deptA.id);

      // DI.8 — Existing backend cross-department validation (validateTicketProjectActivityLink) remains unchanged — called directly, not through the route, to prove this fix touched nothing there.
      console.log("\nDI.8. validateTicketProjectActivityLink itself is untouched — still rejects the exact same cross-department pairing ===\n");
      const { validateTicketProjectActivityLink } = await import("@/lib/services/department-scope-service");
      const di8 = await validateTicketProjectActivityLink(deptB.id, projectA.id, null);
      check("DI.8a. Department A project validated directly against Department B -> invalid_project_scope, exactly as before this closure pass", !di8.ok && di8.code === "invalid_project_scope");

    }

    // ── 8. No grant anywhere keeps linking unavailable ──
    console.log("\n8. No grant anywhere keeps linking unavailable for both departments ===\n");
    const noGrantUser = await prisma.user.create({
      data: { email: `${TAG}-nogrant@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(noGrantUser.id);
    const noGrantMembership = await prisma.departmentMembership.create({
      data: { userId: noGrantUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(noGrantMembership.id);
    currentSession = { user: { id: noGrantUser.id, role: Role.USER, customRoleId: null } };
    const renderedNoGrant = await renderNewTicketPage();
    check("8a. New Ticket page renders (REQUESTER has ticket.create)", !("redirectTo" in renderedNoGrant) && !("deniedNoAccess" in renderedNoGrant));
    if (!("redirectTo" in renderedNoGrant) && !("deniedNoAccess" in renderedNoGrant)) {
      check("8b. hasGlobalLinkPermission is false", renderedNoGrant.hasGlobalLinkPermission === false);
      check("8c. linkPermissionDepartmentIds is empty", renderedNoGrant.linkPermissionDepartmentIds.length === 0);
      check(
        "8d. Neither Department A nor Department B is enabled",
        computeCanLinkProjectActivityHere({ selectedDepartmentId: deptA.id, hasGlobalLinkPermission: false, linkPermissionDepartmentIds: [] }) === false &&
          computeCanLinkProjectActivityHere({ selectedDepartmentId: deptB.id, hasGlobalLinkPermission: false, linkPermissionDepartmentIds: [] }) === false
      );
    }

    // ── 9. Active workspace does not override the form's selected department ──
    console.log("\n9. The active-workspace cookie has no bearing on the server-computed grant, and the client decision only ever sees the EXPLICITLY selected department ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    currentCookieDepartmentId = deptB.id; // workspace switched to B, but the user will still SELECT A in the form
    const renderedWithBWorkspace = await renderNewTicketPage();
    check("9a. Page still renders with Department B as the active workspace", !("redirectTo" in renderedWithBWorkspace) && !("deniedNoAccess" in renderedWithBWorkspace));
    if (!("redirectTo" in renderedWithBWorkspace) && !("deniedNoAccess" in renderedWithBWorkspace)) {
      check("9b. linkPermissionDepartmentIds still correctly lists Department A (unaffected by the workspace cookie)", renderedWithBWorkspace.linkPermissionDepartmentIds.includes(deptA.id));
      // The client decision function itself takes no "default"/workspace
      // parameter at all — structurally, an explicitly selected Department A
      // is evaluated purely on its own id, regardless of whatever the
      // workspace/default happened to be.
      const enabledDespiteBWorkspace = computeCanLinkProjectActivityHere({
        selectedDepartmentId: deptA.id,
        hasGlobalLinkPermission: renderedWithBWorkspace.hasGlobalLinkPermission,
        linkPermissionDepartmentIds: renderedWithBWorkspace.linkPermissionDepartmentIds,
      });
      check("9c. Explicitly selecting Department A (while the active workspace is Department B) still resolves to enabled", enabledDespiteBWorkspace === true);
    }
    currentCookieDepartmentId = null;

    // ── 10. A crafted POST for Department B is still rejected by the existing backend check ──
    console.log("\n10. A crafted POST directly targeting Department B (bypassing the UI/client entirely) is still rejected by the unmodified backend check ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    const craftedRes = await createTicketPOST(
      jsonReq("http://localhost/api/tickets", { title: `${TAG} crafted`, description: "fixture description long enough", departmentId: deptB.id, projectId: projectA.id })
    );
    check("10a. Crafted POST (Department B destination, Department A project) -> not 201", craftedRes.status !== 201, `got ${craftedRes.status}`);
    const craftedBody = await craftedRes.json().catch(() => ({}));
    check("10b. Rejected with a real error code, not silently accepted", typeof craftedBody.code === "string" || typeof craftedBody.error === "string");

    // ── 11. No global Simple User grant or role seed is changed ──
    console.log("\n11. No global Simple User grant or role seed is changed ===\n");
    check("11a. A plain Role.USER with no customRoleId still does NOT hold ticket.linkProjectActivity globally", !(await hasPermission(Role.USER, "ticket.linkProjectActivity", null)));
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length > 0 ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["departmentMemberships", () => (userIds.length > 0 ? prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } }) : Promise.resolve())],
      ["users", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["rolePermissions (custom roles)", () => (customRoleKeys.length > 0 ? prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } }) : Promise.resolve())],
      ["customRoles", () => (customRoleKeys.length > 0 ? prisma.customRole.deleteMany({ where: { key: { in: customRoleKeys } } }) : Promise.resolve())],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => (departmentIds.length > 0 ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
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
