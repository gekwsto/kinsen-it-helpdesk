/**
 * Server-side regression coverage for Project/Activity Notes
 * (prisma/schema.prisma's ProjectNote/ActivityNote models,
 * lib/validations.ts's createNoteSchema,
 * app/api/projects/[id]/notes/route.ts, app/api/activities/[id]/notes/route.ts).
 *
 * A Note is deliberately NOT a TicketMessage: no direction, no isInternal,
 * no email fields, no reply semantics — see the schema doc comments and the
 * route handlers' own comments. UI-level behavior ("Notes appear instantly,
 * survive reload, no Reply/Internal controls exist anywhere on a Project/
 * Activity page") is covered separately by
 * scripts/browser-verify-project-activity-notes.ts — this script is the
 * server-authoritative backstop.
 *
 * Covers the task's own checklist:
 *  17/27. Authorized viewer (project.view / activity.view) can GET notes.
 *  18/28. A user with NO membership in the department cannot GET notes.
 *  19/29. A user with project.edit / activity.edit can POST a note.
 *  20/30. A viewer WITHOUT project.edit / activity.edit cannot POST.
 *  21/31. Empty/whitespace-only note is rejected (422).
 *  22.    The server ignores unsupported internal/reply fields entirely —
 *         a POST body carrying isInternal/direction has zero effect; the
 *         created row (and its JSON response) has neither field.
 *  23.    authorId always comes from the session, never the request body.
 *  24/32. The POST response includes the full note + author immediately
 *         (what lets the UI append it without a refetch).
 *  25/33. Notes survive "reload" (a fresh GET returns what was POSTed).
 *  26/34. Multiple notes have deterministic ordering (createdAt ASC, id ASC
 *         tiebreaker).
 *  41.    Deleting a Project cascades only its own ProjectNotes.
 *  42.    Deleting an Activity cascades only its own ActivityNotes.
 *  43.    A note cannot reference a nonexistent Project/Activity (route
 *         404s before any note is created; FK also protects at the DB
 *         level).
 *  44.    No ProjectNote/ActivityNote row (nor any API response) ever
 *         carries `isInternal` or `direction` — asserted both via the
 *         Prisma row shape and the raw JSON response keys.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-activity-notes.ts
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
const TAG = `notes-${RUN_ID}`;

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

  const { POST: createProjectPOST } = await import("@/app/api/projects/route");
  const { POST: createActivityPOST } = await import("@/app/api/activities/route");
  const { GET: getProjectNotes, POST: postProjectNote } = await import("@/app/api/projects/[id]/notes/route");
  const { GET: getActivityNotes, POST: postActivityNote } = await import("@/app/api/activities/[id]/notes/route");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, a Project + an Activity, and users at various standings ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true, name: true, email: true },
    });
    userIds.push(admin.id);

    // VIEWER: real Department-A membership, project.view + activity.view,
    // but NEITHER project.edit NOR activity.edit — proves read (view) and
    // write (edit) are independently gated.
    const viewerUser = await prisma.user.create({
      data: { email: `${TAG}-viewer@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", name: `${TAG} Viewer` },
      select: { id: true },
    });
    userIds.push(viewerUser.id);
    const viewerMembership = await prisma.departmentMembership.create({
      data: { userId: viewerUser.id, departmentId: deptA.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(viewerMembership.id);

    // DEPARTMENT_MANAGER: project.edit + activity.edit — can write notes.
    const editorUser = await prisma.user.create({
      data: { email: `${TAG}-editor@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", name: `${TAG} Editor` },
      select: { id: true },
    });
    userIds.push(editorUser.id);
    const editorMembership = await prisma.departmentMembership.create({
      data: { userId: editorUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(editorMembership.id);

    // Outsider: a real user, but with membership ONLY in Department B —
    // "an unauthorized department user", not merely an unauthenticated one.
    const outsiderUser = await prisma.user.create({
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(outsiderUser.id);
    const outsiderMembership = await prisma.departmentMembership.create({
      data: { userId: outsiderUser.id, departmentId: deptB.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(outsiderMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const projectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Project`, departmentId: deptA.id }));
    const project = await projectRes.json();
    projectIds.push(project.id);
    const activityRes = await createActivityPOST(jsonReq("http://localhost/api/activities", { title: `${TAG} Activity`, departmentId: deptA.id, projectId: project.id }));
    const activity = await activityRes.json();
    activityIds.push(activity.id);

    // ══════════════════════════ PROJECT NOTES ══════════════════════════
    console.log("\n=== PROJECT NOTES ===\n");

    // ── 17. Authorized viewer can GET (empty initially) ──
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const emptyGetRes = await getProjectNotes(new NextRequest(`http://localhost/api/projects/${project.id}/notes`), { params: Promise.resolve({ id: project.id }) });
    check("17. VIEWER (project.view) can GET /api/projects/[id]/notes -> 200", emptyGetRes.status === 200);
    const emptyGetBody = await emptyGetRes.json();
    check("...returns an empty array initially", Array.isArray(emptyGetBody) && emptyGetBody.length === 0);

    // ── 18. Unauthorized department user cannot GET ──
    currentSession = { user: { id: outsiderUser.id, role: Role.USER, customRoleId: null } };
    const outsiderGetRes = await getProjectNotes(new NextRequest(`http://localhost/api/projects/${project.id}/notes`), { params: Promise.resolve({ id: project.id }) });
    check("18. A Department-B-only user cannot GET Department-A project notes -> 403", outsiderGetRes.status === 403);

    // ── 20. Viewer WITHOUT project.edit cannot POST ──
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const viewerPostRes = await postProjectNote(jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "I can only look" }), { params: Promise.resolve({ id: project.id }) });
    check("20. VIEWER without project.edit cannot POST a note -> 403", viewerPostRes.status === 403);
    const notesAfterDeniedPost = await prisma.projectNote.count({ where: { projectId: project.id } });
    check("...and no row was created", notesAfterDeniedPost === 0);

    // ── 21. Empty/whitespace-only note is rejected ──
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const emptyBodyRes = await postProjectNote(jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "   " }), { params: Promise.resolve({ id: project.id }) });
    check("21. Whitespace-only note is rejected -> 422", emptyBodyRes.status === 422);
    const strictEmptyRes = await postProjectNote(jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "" }), { params: Promise.resolve({ id: project.id }) });
    check("...an empty string is also rejected -> 422", strictEmptyRes.status === 422);

    // ── 19. User with project.edit can POST ──
    const firstNoteRes = await postProjectNote(jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "  Waiting for final approval from Finance.  " }), { params: Promise.resolve({ id: project.id }) });
    check("19. DEPARTMENT_MANAGER (project.edit) can POST a note -> 201", firstNoteRes.status === 201);
    const firstNote = await firstNoteRes.json();
    check("Body is trimmed server-side", firstNote.body === "Waiting for final approval from Finance.");

    // ── 22. Unsupported internal/reply semantics are ignored, never accepted ──
    const withFakeFieldsRes = await postProjectNote(
      jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "Second note", isInternal: true, direction: "INBOUND", fromEmail: "x@example.com" }),
      { params: Promise.resolve({ id: project.id }) }
    );
    check("22. POST with isInternal/direction/fromEmail still succeeds (fields are silently dropped) -> 201", withFakeFieldsRes.status === 201);
    const withFakeFields = await withFakeFieldsRes.json();
    check("...response has no isInternal key at all", !("isInternal" in withFakeFields));
    check("...response has no direction key at all", !("direction" in withFakeFields));
    check("...response has no fromEmail key at all", !("fromEmail" in withFakeFields));
    const rawRow = await prisma.projectNote.findUnique({ where: { id: withFakeFields.id } });
    check("...the actual DB row has no isInternal/direction/fromEmail properties (the model has no such columns)", !("isInternal" in (rawRow as object)) && !("direction" in (rawRow as object)) && !("fromEmail" in (rawRow as object)));

    // ── 23. authorId always comes from the session, never the request body ──
    const spoofAttemptRes = await postProjectNote(
      jsonReq(`http://localhost/api/projects/${project.id}/notes`, { body: "Trying to impersonate", authorId: admin.id }),
      { params: Promise.resolve({ id: project.id }) }
    );
    const spoofAttempt = await spoofAttemptRes.json();
    check("23. authorId in the created note is the REAL session user, not the spoofed body value", spoofAttempt.authorId === editorUser.id && spoofAttempt.authorId !== admin.id);

    // ── 24. POST response includes full note + author immediately ──
    check("24. POST response includes author.name for instant UI rendering (no refetch needed)", firstNote.author?.name === `${TAG} Editor`);
    check("...and a createdAt timestamp", typeof firstNote.createdAt === "string" && firstNote.createdAt.length > 0);

    // ── 25/26. Notes survive reload, deterministic ordering ──
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const finalGetRes = await getProjectNotes(new NextRequest(`http://localhost/api/projects/${project.id}/notes`), { params: Promise.resolve({ id: project.id }) });
    const finalNotes = await finalGetRes.json();
    check("25. A fresh GET (\"reload\") returns all previously-posted notes", finalNotes.length === 3);
    check("26. Notes are ordered oldest-first (createdAt ASC)", finalNotes[0].id === firstNote.id && finalNotes[1].id === withFakeFields.id && finalNotes[2].id === spoofAttempt.id);

    // ══════════════════════════ ACTIVITY NOTES ══════════════════════════
    console.log("\n=== ACTIVITY NOTES ===\n");

    // ── 27. Authorized viewer can GET ──
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const actEmptyGetRes = await getActivityNotes(new NextRequest(`http://localhost/api/activities/${activity.id}/notes`), { params: Promise.resolve({ id: activity.id }) });
    check("27. VIEWER (activity.view) can GET /api/activities/[id]/notes -> 200", actEmptyGetRes.status === 200);
    const actEmptyGetBody = await actEmptyGetRes.json();
    check("...returns an empty array initially", Array.isArray(actEmptyGetBody) && actEmptyGetBody.length === 0);

    // ── 28. Unauthorized department user cannot GET ──
    currentSession = { user: { id: outsiderUser.id, role: Role.USER, customRoleId: null } };
    const actOutsiderGetRes = await getActivityNotes(new NextRequest(`http://localhost/api/activities/${activity.id}/notes`), { params: Promise.resolve({ id: activity.id }) });
    check("28. A Department-B-only user cannot GET Department-A activity notes -> 403", actOutsiderGetRes.status === 403);

    // ── 30. Viewer WITHOUT activity.edit cannot POST ──
    currentSession = { user: { id: viewerUser.id, role: Role.USER, customRoleId: null } };
    const actViewerPostRes = await postActivityNote(jsonReq(`http://localhost/api/activities/${activity.id}/notes`, { body: "Not allowed" }), { params: Promise.resolve({ id: activity.id }) });
    check("30. VIEWER without activity.edit cannot POST a note -> 403", actViewerPostRes.status === 403);

    // ── 31. Empty note rejected ──
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    const actEmptyBodyRes = await postActivityNote(jsonReq(`http://localhost/api/activities/${activity.id}/notes`, { body: "" }), { params: Promise.resolve({ id: activity.id }) });
    check("31. Empty note is rejected -> 422", actEmptyBodyRes.status === 422);

    // ── 29. User with activity.edit can POST ──
    const actFirstNoteRes = await postActivityNote(jsonReq(`http://localhost/api/activities/${activity.id}/notes`, { body: "Vendor confirmed delivery for Friday." }), { params: Promise.resolve({ id: activity.id }) });
    check("29. DEPARTMENT_MANAGER (activity.edit) can POST a note -> 201", actFirstNoteRes.status === 201);
    const actFirstNote = await actFirstNoteRes.json();

    // ── 32. Response includes full note + author immediately ──
    check("32. POST response includes author info + createdAt immediately", actFirstNote.author?.id === editorUser.id && typeof actFirstNote.createdAt === "string");
    check("...no isInternal/direction fields on Activity notes either", !("isInternal" in actFirstNote) && !("direction" in actFirstNote));

    const actSecondNoteRes = await postActivityNote(jsonReq(`http://localhost/api/activities/${activity.id}/notes`, { body: "Second activity note" }), { params: Promise.resolve({ id: activity.id }) });
    const actSecondNote = await actSecondNoteRes.json();

    // ── 33/34. Notes survive reload, deterministic ordering ──
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const actFinalGetRes = await getActivityNotes(new NextRequest(`http://localhost/api/activities/${activity.id}/notes`), { params: Promise.resolve({ id: activity.id }) });
    const actFinalNotes = await actFinalGetRes.json();
    check("33. A fresh GET (\"reload\") returns all previously-posted activity notes", actFinalNotes.length === 2);
    check("34. Activity notes are ordered oldest-first (createdAt ASC)", actFinalNotes[0].id === actFirstNote.id && actFinalNotes[1].id === actSecondNote.id);

    // ══════════════════════════ SCHEMA REGRESSION ══════════════════════════
    console.log("\n=== SCHEMA REGRESSION ===\n");

    // ── 43. A note cannot reference a nonexistent Project/Activity ──
    const bogusProjectRes = await postProjectNote(jsonReq("http://localhost/api/projects/does-not-exist/notes", { body: "orphan attempt" }), { params: Promise.resolve({ id: "does-not-exist" }) });
    check("43. POST to a nonexistent Project id -> 404 (route rejects before any note is created)", bogusProjectRes.status === 404);
    const bogusActivityRes = await postActivityNote(jsonReq("http://localhost/api/activities/does-not-exist/notes", { body: "orphan attempt" }), { params: Promise.resolve({ id: "does-not-exist" }) });
    check("...same for a nonexistent Activity id -> 404", bogusActivityRes.status === 404);

    // ── 44. No note row anywhere carries isInternal/direction ──
    const allTestProjectNotes = await prisma.projectNote.findMany({ where: { projectId: project.id } });
    const allTestActivityNotes = await prisma.activityNote.findMany({ where: { activityId: activity.id } });
    check(
      "44. No ProjectNote row has isInternal or direction (the columns don't exist on the model at all)",
      allTestProjectNotes.every((n) => !("isInternal" in n) && !("direction" in n))
    );
    check(
      "...same for ActivityNote rows",
      allTestActivityNotes.every((n) => !("isInternal" in n) && !("direction" in n))
    );

    // ── 41. Deleting a Project cascades only its own ProjectNotes ──
    console.log("\n41/42. Deleting a Project/Activity cascades ONLY its own Notes ===\n");
    const cascadeProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Cascade Project`, departmentId: deptA.id }));
    const cascadeProject = await cascadeProjectRes.json();
    currentSession = { user: { id: editorUser.id, role: Role.USER, customRoleId: null } };
    await postProjectNote(jsonReq(`http://localhost/api/projects/${cascadeProject.id}/notes`, { body: "will be cascaded" }), { params: Promise.resolve({ id: cascadeProject.id }) });
    const cascadeNoteCountBefore = await prisma.projectNote.count({ where: { projectId: cascadeProject.id } });
    check("Note exists before the Project is deleted", cascadeNoteCountBefore === 1);
    await prisma.project.delete({ where: { id: cascadeProject.id } });
    const cascadeNoteCountAfter = await prisma.projectNote.count({ where: { projectId: cascadeProject.id } });
    check("Deleting the Project cascades its own ProjectNote away", cascadeNoteCountAfter === 0);
    const unrelatedProjectNotesStillExist = await prisma.projectNote.count({ where: { projectId: project.id } });
    check("...but the OTHER project's notes are completely unaffected", unrelatedProjectNotesStillExist === 3);

    // ── 42. Deleting an Activity cascades only its own ActivityNotes ──
    const cascadeActivityRes = await createActivityPOST(jsonReq("http://localhost/api/activities", { title: `${TAG} Cascade Activity`, departmentId: deptA.id }));
    const cascadeActivity = await cascadeActivityRes.json();
    await postActivityNote(jsonReq(`http://localhost/api/activities/${cascadeActivity.id}/notes`, { body: "will be cascaded" }), { params: Promise.resolve({ id: cascadeActivity.id }) });
    const cascadeActNoteCountBefore = await prisma.activityNote.count({ where: { activityId: cascadeActivity.id } });
    check("Note exists before the Activity is deleted", cascadeActNoteCountBefore === 1);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    await prisma.projectActivity.delete({ where: { id: cascadeActivity.id } });
    const cascadeActNoteCountAfter = await prisma.activityNote.count({ where: { activityId: cascadeActivity.id } });
    check("Deleting the Activity cascades its own ActivityNote away", cascadeActNoteCountAfter === 0);
    const unrelatedActivityNotesStillExist = await prisma.activityNote.count({ where: { activityId: activity.id } });
    check("...but the OTHER activity's notes are completely unaffected", unrelatedActivityNotesStillExist === 2);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
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
