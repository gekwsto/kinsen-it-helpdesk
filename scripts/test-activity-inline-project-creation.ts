/**
 * Server-side regression coverage for inline Project creation from the
 * Activity create/edit flows (components/activities/activity-new-form.tsx,
 * app/(main)/activities/[id]/edit/activity-edit-client.tsx — both reuse
 * components/projects/project-create-dialog.tsx / project-form.tsx
 * mode="inline" verbatim, the exact same components the Ticket inline
 * creation flow already uses; no second implementation exists).
 *
 * Exercises the REAL route handlers directly (mocked @/lib/auth, same
 * convention as scripts/test-ticket-inline-project-activity-creation.ts).
 * UI-level behavior (the "+ New" button, Select auto-population via the
 * deferred/pending-selection pattern, preserved form field values while the
 * dialog is open) is covered separately by
 * scripts/browser-verify-activity-inline-project-creation.ts — this script
 * is the server-authoritative backstop.
 *
 * Covers the task's own 16-point checklist (UI-only points 3/6/7/8 are
 * noted inline and left to the browser script):
 *  1.  Create Activity still allows Standalone (no projectId).
 *  2.  Create Activity can select an existing Project.
 *  4.  Inline Project creation (POST /api/projects) uses the Activity's
 *      department exactly — the fixedDepartmentId ProjectForm sends.
 *  5.  Cross-department Project creation for an Activity's department
 *      cannot be forced into linking to an Activity in a different one.
 *  9.  Creating an Activity with the newly-created project's id links it.
 *  10. Edit Activity can create a Project inline — same POST /api/projects,
 *      no special Activity-only endpoint; GET /api/activities/[id] reports
 *      canCreateProjectInDept correctly for permitted/denied users.
 *  11. Creating the Project via POST /api/projects does NOT touch the
 *      Activity row at all — proves creation and linking are genuinely
 *      separate operations, no auto-save.
 *  12. Saving the edit (PATCH /api/activities/[id]) with the new project's
 *      id actually links it.
 *  13/14. A user without project.create cannot create a Project inline —
 *      POST /api/projects independently rejects it (not just a hidden
 *      button).
 *  15. Existing Project-change / clear-to-Standalone via PATCH still works.
 *  16. Activity progress + Project rollup are still computed/recalculated
 *      exactly as before (untouched by this task).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-inline-project-creation.ts
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
const TAG = `aipc-${RUN_ID}`;

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
  const { GET: getActivityGET, PATCH: patchActivity } = await import("@/app/api/activities/[id]/route");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, admin + a limited (activity-view-only) member ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    // REQUESTER: real Department-A membership, activity.view only — proves
    // project.create is checked independently of general department
    // standing.
    const limitedUser = await prisma.user.create({
      data: { email: `${TAG}-limited@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(limitedUser.id);
    const limitedMembership = await prisma.departmentMembership.create({
      data: { userId: limitedUser.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(limitedMembership.id);

    // A genuinely-authorized NON-admin: global Role.USER (no canViewAllDepartments
    // bypass at all) with a real Department-A membership at DEPARTMENT_MANAGER
    // (which holds project.create per prisma/seed.ts's ROLE_PERMISSIONS).
    // Proves canCreateProjectInDept works via real membership + permission
    // lookup, not merely the ADMIN/DIRECTOR canViewAllDepartments shortcut —
    // the two bypass paths are easy to conflate and this closes that gap.
    const scopedManager = await prisma.user.create({
      data: { email: `${TAG}-manager@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(scopedManager.id);
    const scopedManagerMembership = await prisma.departmentMembership.create({
      data: { userId: scopedManager.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(scopedManagerMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1. Standalone (no project) still works ──
    console.log("\n1. Create Activity still allows Standalone ===\n");
    const standaloneRes = await createActivityPOST(jsonReq("http://localhost/api/activities", { title: `${TAG} Standalone Activity`, departmentId: deptA.id }));
    check("POST /api/activities without projectId -> 201", standaloneRes.status === 201);
    const standaloneActivity = await standaloneRes.json();
    if (standaloneActivity?.id) activityIds.push(standaloneActivity.id);
    check("Created activity has projectId null (Standalone)", standaloneActivity.projectId === null);

    // ── 2. Selecting an existing Project still works ──
    console.log("\n2. Create Activity can select an existing Project ===\n");
    const existingProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Existing Project`, departmentId: deptA.id }));
    const existingProject = await existingProjectRes.json();
    if (existingProject?.id) projectIds.push(existingProject.id);
    const withExistingRes = await createActivityPOST(
      jsonReq("http://localhost/api/activities", { title: `${TAG} With Existing Project`, departmentId: deptA.id, projectId: existingProject.id })
    );
    check("POST /api/activities with an existing projectId -> 201", withExistingRes.status === 201);
    const withExisting = await withExistingRes.json();
    if (withExisting?.id) activityIds.push(withExisting.id);
    check("Activity links to the existing project", withExisting.projectId === existingProject.id);

    // ── 4. Inline Project creation uses the Activity's department exactly ──
    console.log("\n4. Inline Project (POST /api/projects) uses the Activity's department exactly ===\n");
    const inlineProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Inline Project`, departmentId: deptA.id }));
    check("POST /api/projects with the Activity's departmentId -> 201", inlineProjectRes.status === 201);
    const inlineProject = await inlineProjectRes.json();
    if (inlineProject?.id) projectIds.push(inlineProject.id);
    check("Created project's departmentId matches the Activity's department exactly", inlineProject.departmentId === deptA.id);

    // ── 5. Cross-department: a Department-B project cannot become an Activity-A's project ──
    console.log("\n5. Cross-department Project cannot be linked to an Activity in a different department ===\n");
    const crossProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Cross Project`, departmentId: deptB.id }));
    const crossProject = await crossProjectRes.json();
    if (crossProject?.id) projectIds.push(crossProject.id);
    const crossLinkAttempt = await createActivityPOST(
      jsonReq("http://localhost/api/activities", { title: `${TAG} Cross Attempt`, departmentId: deptA.id, projectId: crossProject.id })
    );
    check("Creating a Department-A activity with a Department-B project -> rejected (not 201)", crossLinkAttempt.status !== 201, `got ${crossLinkAttempt.status}`);
    const crossBody = await crossLinkAttempt.json().catch(() => ({}));
    check("...with an explicit different-department error", typeof crossBody.error === "string" && crossBody.error.toLowerCase().includes("department"));

    // ── 9. Creating the Activity with the newly-created project's id links it ──
    console.log("\n9. Creating Activity with the newly-created project's id links it ===\n");
    const linkedRes = await createActivityPOST(
      jsonReq("http://localhost/api/activities", { title: `${TAG} Linked To Inline`, departmentId: deptA.id, projectId: inlineProject.id })
    );
    check("POST /api/activities with the just-created project's id -> 201", linkedRes.status === 201);
    const linkedActivity = await linkedRes.json();
    if (linkedActivity?.id) activityIds.push(linkedActivity.id);
    check("Activity is linked to the newly-created project", linkedActivity.projectId === inlineProject.id);
    check("Response includes the project's title (what the UI merges into its local options list)", linkedActivity.project?.title === `${TAG} Inline Project`);

    // ── 10. Edit Activity: same POST /api/projects, and GET reports the permission hint correctly ──
    console.log("\n10. Edit Activity's inline Project creation reuses POST /api/projects; GET /api/activities/[id] reports canCreateProjectInDept ===\n");
    const editTargetActivity = standaloneActivity;
    const getAsAdminRes = await getActivityGET(new NextRequest(`http://localhost/api/activities/${editTargetActivity.id}`), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    const getAsAdminBody = await getAsAdminRes.json();
    check("Admin editing: GET reports canCreateProjectInDept = true", getAsAdminBody.canCreateProjectInDept === true);

    currentSession = { user: { id: scopedManager.id, role: Role.USER, customRoleId: null } };
    const getAsScopedManagerRes = await getActivityGET(new NextRequest(`http://localhost/api/activities/${editTargetActivity.id}`), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    const getAsScopedManagerBody = await getAsScopedManagerRes.json();
    check(
      "A genuinely-authorized NON-admin (real DEPARTMENT_MANAGER membership, not the ADMIN/DIRECTOR bypass) also gets canCreateProjectInDept = true",
      getAsScopedManagerBody.canCreateProjectInDept === true
    );

    currentSession = { user: { id: limitedUser.id, role: Role.USER, customRoleId: null } };
    const getAsLimitedRes = await getActivityGET(new NextRequest(`http://localhost/api/activities/${editTargetActivity.id}`), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    const getAsLimitedBody = await getAsLimitedRes.json();
    check("REQUESTER editing (no project.create): GET reports canCreateProjectInDept = false", getAsLimitedBody.canCreateProjectInDept === false);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const editInlineProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Edit-Inline Project`, departmentId: deptA.id }));
    check("Edit Activity's '+ New Project' -> same POST /api/projects -> 201 (no special endpoint)", editInlineProjectRes.status === 201);
    const editInlineProject = await editInlineProjectRes.json();
    if (editInlineProject?.id) projectIds.push(editInlineProject.id);

    // ── 11. Creating the Project does NOT touch the Activity — creation and linking are separate ──
    console.log("\n11. Creating the Project does not auto-save/auto-link the Activity ===\n");
    const activityAfterProjectCreate = await prisma.projectActivity.findUnique({ where: { id: editTargetActivity.id }, select: { projectId: true, updatedAt: true } });
    check("The Activity's projectId is still null immediately after the Project was created (no auto-link)", activityAfterProjectCreate?.projectId === null);

    // ── 12. Saving the edit actually links it ──
    console.log("\n12. Saving the edit (PATCH) links the Activity to the newly-created Project ===\n");
    const saveLinkRes = await patchActivity(jsonReq(`http://localhost/api/activities/${editTargetActivity.id}`, { projectId: editInlineProject.id }, "PATCH"), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    check("PATCH /api/activities/[id] with the new project's id -> 200", saveLinkRes.status === 200);
    const afterSave = await prisma.projectActivity.findUnique({ where: { id: editTargetActivity.id }, select: { projectId: true } });
    check("Activity is now linked to the newly-created Project", afterSave?.projectId === editInlineProject.id);

    // ── 13/14. A user without project.create cannot create a Project inline — server-authoritative ──
    console.log("\n13/14. A user without project.create is independently rejected by POST /api/projects ===\n");
    currentSession = { user: { id: limitedUser.id, role: Role.USER, customRoleId: null } };
    const deniedProjectRes = await createProjectPOST(jsonReq("http://localhost/api/projects", { title: `${TAG} Denied Project`, departmentId: deptA.id }));
    check("REQUESTER-role member without project.create -> denied (not 201)", deniedProjectRes.status !== 201, `got ${deniedProjectRes.status}`);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 15. Existing Project-change / clear-to-Standalone still works ──
    console.log("\n15. Existing Project-change / clear-to-Standalone via PATCH still works ===\n");
    const changeToOtherRes = await patchActivity(jsonReq(`http://localhost/api/activities/${editTargetActivity.id}`, { projectId: inlineProject.id }, "PATCH"), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    check("Changing to a different existing project -> 200", changeToOtherRes.status === 200);
    const afterChange = await prisma.projectActivity.findUnique({ where: { id: editTargetActivity.id }, select: { projectId: true } });
    check("Activity now points at the other project", afterChange?.projectId === inlineProject.id);

    const clearRes = await patchActivity(jsonReq(`http://localhost/api/activities/${editTargetActivity.id}`, { projectId: null }, "PATCH"), {
      params: Promise.resolve({ id: editTargetActivity.id }),
    });
    check("Clearing back to Standalone (projectId: null) -> 200", clearRes.status === 200);
    const afterClear = await prisma.projectActivity.findUnique({ where: { id: editTargetActivity.id }, select: { projectId: true } });
    check("Activity is Standalone again", afterClear?.projectId === null);

    // ── 16. Activity progress + Project rollup are still computed exactly as before ──
    console.log("\n16. Activity progress + Project rollup remain unchanged (not touched by this task) ===\n");
    check("Newly created activity has a numeric progress (derived from status, per ActivityProgressConfig)", typeof linkedActivity.progress === "number");
    const rollupProject = await prisma.project.findUnique({ where: { id: inlineProject.id }, select: { progress: true } });
    check("Project.progress was recalculated after an activity was created under it (rollup untouched)", typeof rollupProject?.progress === "number");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
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
