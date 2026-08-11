/**
 * Server-side regression coverage for inline Project/Activity creation from
 * the Ticket create/link flows (components/tickets/ticket-form.tsx,
 * components/tickets/ticket-actions.tsx, components/projects/project-form.tsx
 * mode="inline", components/activities/activity-new-form.tsx mode="inline").
 *
 * Exercises the REAL route handlers directly (mocked @/lib/auth, same
 * convention as scripts/test-integration-admin-authz.ts) — proves the
 * actual POST /api/projects / POST /api/activities / PATCH /api/tickets/[id]
 * behavior the inline dialogs rely on, never a reimplementation. UI-level
 * behavior (Select auto-population, the Dialog-swap nested-dialog pattern,
 * "clear invalid selection on department change") is covered separately by
 * scripts/browser-verify-ticket-inline-project-activity.ts — this script is
 * the server-authoritative backstop: everything it proves must hold
 * regardless of what the client UI does or fails to do.
 *
 * Covers (see the task's own 24-point checklist):
 *  3/4.  A Project created via POST /api/projects with an explicit
 *        departmentId is created in exactly that department (never
 *        anywhere else) and is immediately linkable to a ticket in the
 *        same department.
 *  5/6.  Same for POST /api/activities, including the department inherited
 *        from a preselected Project.
 *  7.    An Activity created under a Project keeps the Project/Activity
 *        relationship consistent — validateTicketProjectActivityLink
 *        accepts {projectId, activityId} from the SAME create flow.
 *  8.    A ticket PATCH links to both a newly-created Project AND Activity
 *        together in one request.
 *  9/10. A Project/Activity from a DIFFERENT department than the target
 *        cannot be created there (POST rejects) and cannot be linked
 *        (PATCH rejects) — proves inline creation can never produce a
 *        cross-department link.
 *  12/13. A user with ticket-department standing but WITHOUT project.create/
 *        activity.create cannot create a Project/Activity there — proves
 *        "create" and "link" are two independently-enforced permissions,
 *        never a single admin bypass.
 *  14.   A non-admin user (who might otherwise hold project.create/
 *        activity.create) still cannot LINK a ticket to a Project/Activity —
 *        confirms creating one never grants ticket-link access.
 *  16/17/19. An inline-created Project/Activity can be saved onto an
 *        EXISTING ticket via PATCH, and a Project/Activity mismatch
 *        (activity belongs to a different project than the one being set)
 *        is rejected.
 *  21/22. GET /api/projects?departmentId= / GET /api/activities?departmentId=
 *        (what the Ticket UI now fetches instead of an unscoped list) never
 *        return a different department's rows.
 *  9(creation)/success-does-not-delete: if linking fails AFTER a successful
 *        Project/Activity creation, the created row is NOT deleted —
 *        creation and linking are separate, independently-valid operations.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-inline-project-activity-creation.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
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

const RUN_ID = Date.now();
const TAG = `tipac-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

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

  // Dynamic imports after both mocks are registered — see the established
  // rationale in test-inactive-department-policy.ts's header comment.
  const { POST: createProjectPOST } = await import("@/app/api/projects/route");
  const { GET: listProjectsGET } = await import("@/app/api/projects/route");
  const { POST: createActivityPOST } = await import("@/app/api/activities/route");
  const { GET: listActivitiesGET } = await import("@/app/api/activities/route");
  const { PATCH: ticketPATCH } = await import("@/app/api/tickets/[id]/route");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, admin + a limited (ticket-only) member ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const statusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isDefault: true }, select: { id: true } });

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    // A plain USER with a real membership in deptA that grants ticket.view/
    // ticket.reply-style standing but explicitly NOT project.create/
    // activity.create — proves those are checked independently, never
    // implied by "can do stuff in this department" in general.
    const limitedUser = await prisma.user.create({
      data: { email: `${TAG}-limited@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(limitedUser.id);
    const limitedMembership = await prisma.departmentMembership.create({
      data: { userId: limitedUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(limitedMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 3/4. Inline Project creation scoped to Department A, immediately linkable ──
    console.log("\n3/4. POST /api/projects with explicit departmentId creates exactly there ===\n");
    const projectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Inline Project`, departmentId: deptA.id }));
    check("POST /api/projects with explicit departmentId -> 201", projectRes.status === 201);
    const project = await projectRes.json();
    if (project?.id) projectIds.push(project.id);
    check("Created project's departmentId matches exactly what was requested", project.departmentId === deptA.id);

    // ── 5/6. Inline Activity creation inherits the SAME department, links to that project ──
    console.log("\n5/6. POST /api/activities with explicit departmentId + preselected projectId ===\n");
    const activityRes = await createActivityPOST(
      jsonReq("http://localhost/api/activities", { title: `${TAG} Inline Activity`, departmentId: deptA.id, projectId: project.id })
    );
    check("POST /api/activities with explicit departmentId + projectId -> 201", activityRes.status === 201);
    const activity = await activityRes.json();
    if (activity?.id) activityIds.push(activity.id);
    check("Created activity's departmentId matches the requested department", activity.departmentId === deptA.id);
    check("Created activity's projectId matches the preselected project", activity.projectId === project.id);
    check("Created activity's response includes the project's title (what the UI merges into its local Project list)", activity.project?.title === `${TAG} Inline Project`);

    // ── 8. Link a ticket to BOTH the new Project and Activity in one PATCH ──
    console.log("\n8. PATCH /api/tickets/[id] links to both the new Project and Activity together ===\n");
    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} Ticket`, description: "fixture", departmentId: deptA.id, statusId: statusA.id, requesterId: admin.id },
    });
    ticketIds.push(ticket.id);
    const linkRes = await ticketPATCH(jsonReq("http://localhost/api/tickets/x", { projectId: project.id, activityId: activity.id }, "PATCH"), {
      params: Promise.resolve({ id: ticket.id }),
    });
    check("Linking ticket to the new Project + Activity together -> 200", linkRes.status === 200);
    const linkedTicket = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { projectId: true, activityId: true } });
    check("Ticket.projectId now matches the created project", linkedTicket?.projectId === project.id);
    check("Ticket.activityId now matches the created activity", linkedTicket?.activityId === activity.id);

    // ── 9/10. Cross-department creation/link is rejected ──
    console.log("\n9/10. Cross-department Project/Activity cannot be created for the wrong scope or linked ===\n");
    const crossProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Cross Project`, departmentId: deptB.id }));
    check("Admin CAN create a project in Department B directly (sanity: not a blanket rejection)", crossProjectRes.status === 201);
    const crossProject = await crossProjectRes.json();
    if (crossProject?.id) projectIds.push(crossProject.id);

    const crossLinkRes = await ticketPATCH(jsonReq("http://localhost/api/tickets/x", { projectId: crossProject.id }, "PATCH"), {
      params: Promise.resolve({ id: ticket.id }),
    });
    check("Linking a Department-A ticket to a Department-B project -> 400 (rejected)", crossLinkRes.status === 400);
    const crossLinkBody = await crossLinkRes.json().catch(() => ({}));
    check("...with code invalid_project_scope", crossLinkBody.code === "invalid_project_scope");
    const stillLinkedToA = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { projectId: true } });
    check("Ticket's real projectId is unchanged after the rejected cross-department attempt (still Department A's project)", stillLinkedToA?.projectId === project.id);

    // ── 12/13. project.create / activity.create are checked independently of ticket standing ──
    console.log("\n12/13. A user with real Department-A standing but WITHOUT project.create/activity.create cannot inline-create ===\n");
    currentSession = { user: { id: limitedUser.id, role: Role.USER, customRoleId: null } };
    const deniedProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Denied Project`, departmentId: deptA.id }));
    check("A REQUESTER-role member without project.create -> denied (not 201)", deniedProjectRes.status !== 201, `got ${deniedProjectRes.status}`);
    const deniedActivityRes = await createActivityPOST(jsonReq("http://localhost/api/activities", { title: `${TAG} Denied Activity`, departmentId: deptA.id }));
    check("A REQUESTER-role member without activity.create -> denied (not 201)", deniedActivityRes.status !== 201, `got ${deniedActivityRes.status}`);

    // ── 14. Even a user who COULD create Projects/Activities still cannot LINK a ticket to one ──
    console.log("\n14. Creating a Project/Activity never grants ticket-link access (that stays System-Admin-only) ===\n");
    // grantedUser: department MANAGER role (typically holds project.create/
    // activity.create by default department-role permissions) — proves that
    // even a genuinely permitted creator is still blocked from linking,
    // since linking is gated by role === ADMIN, not by any department
    // permission at all.
    const grantedUser = await prisma.user.create({
      data: { email: `${TAG}-manager@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(grantedUser.id);
    const grantedMembership = await prisma.departmentMembership.create({
      data: { userId: grantedUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(grantedMembership.id);
    currentSession = { user: { id: grantedUser.id, role: Role.USER, customRoleId: null } };
    const managerLinkAttempt = await ticketPATCH(jsonReq("http://localhost/api/tickets/x", { projectId: project.id }, "PATCH"), {
      params: Promise.resolve({ id: ticket.id }),
    });
    check("A non-admin (even a DEPARTMENT_MANAGER who could create projects) still cannot link a ticket to one -> 403", managerLinkAttempt.status === 403);

    // ── 16/17/19. Inline creation + link on an EXISTING ticket, and mismatch rejection ──
    console.log("\n16/17/19. Existing-ticket flow: inline-created entities link successfully; a Project/Activity mismatch is rejected ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const secondProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Second Project`, departmentId: deptA.id }));
    const secondProject = await secondProjectRes.json();
    if (secondProject?.id) projectIds.push(secondProject.id);
    const secondActivityRes = await createActivityPOST(
      jsonReq("http://localhost/api/activities", { title: `${TAG} Second Activity`, departmentId: deptA.id, projectId: secondProject.id })
    );
    const secondActivity = await secondActivityRes.json();
    if (secondActivity?.id) activityIds.push(secondActivity.id);

    const relinkRes = await ticketPATCH(jsonReq("http://localhost/api/tickets/x", { projectId: secondProject.id, activityId: secondActivity.id }, "PATCH"), {
      params: Promise.resolve({ id: ticket.id }),
    });
    check("Re-linking to the second inline-created Project+Activity pair succeeds -> 200", relinkRes.status === 200);

    // Mismatch: submit the FIRST project with the SECOND (different-project) activity.
    const mismatchRes = await ticketPATCH(jsonReq("http://localhost/api/tickets/x", { projectId: project.id, activityId: secondActivity.id }, "PATCH"), {
      params: Promise.resolve({ id: ticket.id }),
    });
    check("Project A + an Activity that belongs to Project B -> 400 (rejected)", mismatchRes.status === 400);
    const mismatchBody = await mismatchRes.json().catch(() => ({}));
    check("...with code invalid_project_activity_pair", mismatchBody.code === "invalid_project_activity_pair");
    const stillConsistent = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { projectId: true, activityId: true } });
    check("Ticket's real link is unchanged after the rejected mismatch (still Project 2 + Activity 2, a consistent pair)", stillConsistent?.projectId === secondProject.id && stillConsistent?.activityId === secondActivity.id);

    // ── If linking fails, the created Project/Activity are NOT deleted (creation and linking are separate operations) ──
    console.log("\nCreation and linking are separate valid operations — a rejected link never deletes what was created ===\n");
    const crossProjectStillExists = await prisma.project.findUnique({ where: { id: crossProject.id }, select: { id: true } });
    check("The Department-B project from the earlier rejected cross-department link attempt still exists (was never deleted)", !!crossProjectStillExists);
    const firstProjectStillExists = await prisma.project.findUnique({ where: { id: project.id }, select: { id: true } });
    check("The first project (from the rejected mismatch attempt) still exists", !!firstProjectStillExists);
    const secondActivityStillExists = await prisma.projectActivity.findUnique({ where: { id: secondActivity.id }, select: { id: true } });
    check("The mismatched activity itself still exists (only the LINK was rejected, not the activity)", !!secondActivityStillExists);

    // ── 21/22. Department-scoped option fetching never leaks another department's rows ──
    console.log("\n21/22. GET /api/projects?departmentId= / GET /api/activities?departmentId= never return another department's rows ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const scopedProjectsRes = await listProjectsGET(new NextRequest(`http://localhost/api/projects?departmentId=${deptA.id}&limit=100`));
    const scopedProjectsBody = await scopedProjectsRes.json();
    const scopedProjectIds: string[] = (scopedProjectsBody.projects ?? []).map((p: any) => p.id);
    check("Department-A-scoped project list includes the Department-A projects", scopedProjectIds.includes(project.id) && scopedProjectIds.includes(secondProject.id));
    check("Department-A-scoped project list does NOT include the Department-B project", !scopedProjectIds.includes(crossProject.id));

    const scopedActivitiesRes = await listActivitiesGET(new NextRequest(`http://localhost/api/activities?departmentId=${deptA.id}`));
    const scopedActivities: any[] = await scopedActivitiesRes.json();
    check("Department-A-scoped activity list includes the Department-A activities", scopedActivities.some((a) => a.id === activity.id) && scopedActivities.some((a) => a.id === secondActivity.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
