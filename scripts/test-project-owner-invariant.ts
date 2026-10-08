/**
 * Focused regression for ONE invariant: Project.ownerId must always be
 * contained in Project.owners.
 *
 * This is NOT a new feature test — see the audit this script backs: there is
 * no code path anywhere (grep-confirmed across app/api/projects/**,
 * lib/services/project-request-service.ts, and every other
 * prisma.project.update/updateMany call site) that ever changes
 * Project.ownerId after creation. The only two writes to ownerId are at
 * creation time — POST /api/projects (manual) and
 * createProjectFromApprovedRequest (request-origin) — and both already
 * connect `owners` in the SAME write. PATCH /api/projects/[id] (the one
 * generic update path) never accepts an ownerId/ownerIds/owners field at
 * all (updateProjectSchema has no such field — Zod silently strips it), so
 * the invariant cannot be violated through any reachable write path. This
 * script proves that directly rather than asserting it from reading code.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-owner-invariant.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
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
const TAG = `poi-${RUN_ID}`;

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

  const { POST: postProjects } = await import("@/app/api/projects/route");
  const { PATCH: patchProjectRoute } = await import("@/app/api/projects/[id]/route");

  const jsonReq = (url: string, body: unknown, method = "PATCH") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const projectRequestIds: string[] = [];
  const projectRequestTypeIds: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    const secondOwner = await prisma.user.create({
      data: { email: `${TAG}-owner2@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(secondOwner.id);

    const thirdOwner = await prisma.user.create({
      data: { email: `${TAG}-owner3@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(thirdOwner.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1. Create normal Project -> ownerId ∈ owners ──
    console.log("\n1. Create a normal/manual Project -> ownerId is contained in owners ===\n");
    const createRes = await postProjects(
      jsonReq(`http://localhost/api/projects`, { title: `${TAG} Manual Project`, departmentId: dept.id, memberIds: [] }, "POST")
    );
    check("POST /api/projects -> 201", createRes.status === 201);
    const created = await createRes.json();
    projectIds.push(created.id);

    const afterCreate = await prisma.project.findUnique({
      where: { id: created.id },
      include: { owners: { select: { id: true } } },
    });
    check("ownerId is the creating admin", afterCreate?.ownerId === admin.id);
    check(
      "owners contains exactly [ownerId] (singleton mirror)",
      !!afterCreate && afterCreate.owners.length === 1 && afterCreate.owners[0].id === afterCreate.ownerId
    );

    // ── 2. A forged ownerId/owners in a PATCH body is silently ignored ──
    console.log("\n2. Attempting to change the owner via PATCH /api/projects/[id] -> silently ignored (no such field on the schema) ===\n");
    const forgedPatchRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${created.id}`, {
        title: `${TAG} Manual Project (renamed)`,
        // Deliberately sending fields the schema does not declare, to prove
        // they're stripped, not silently honored.
        ownerId: secondOwner.id,
        owners: [secondOwner.id],
      }),
      { params: Promise.resolve({ id: created.id }) }
    );
    check("PATCH with a forged ownerId/owners -> 200 (title alone applied)", forgedPatchRes.status === 200);
    const afterForgedPatch = await prisma.project.findUnique({
      where: { id: created.id },
      include: { owners: { select: { id: true } } },
    });
    check("ownerId is UNCHANGED — still the real creator, never the forged id", afterForgedPatch?.ownerId === admin.id);
    check(
      "owners is UNCHANGED — still exactly [original ownerId]",
      !!afterForgedPatch && afterForgedPatch.owners.length === 1 && afterForgedPatch.owners[0].id === admin.id
    );

    // ── 3. A request-origin Project with multiple Owners, PATCHed on an
    //       unrelated field, keeps its FULL owners set (never collapsed to
    //       a singleton, never losing the extra Owners) ──
    console.log("\n3. Updating a request-origin, multi-owner Project on an unrelated field -> full owners set preserved ===\n");
    const reqType = await prisma.taskType.create({ data: { name: `${TAG}-type` } });
    projectRequestTypeIds.push(reqType.id);

    const projReq = await prisma.projectRequest.create({
      data: {
        title: `${TAG} request`,
        description: "desc",
        importance: 2,
        projectTypeId: reqType.id,
        teamConcerned: "team",
        expectedBenefits: "benefits",
        requesterId: admin.id,
        departmentId: dept.id,
      },
    });
    projectRequestIds.push(projReq.id);

    const multiOwnerProject = await prisma.project.create({
      data: {
        title: `${TAG} Request-Origin Project`,
        departmentId: dept.id,
        ownerId: admin.id,
        owners: { connect: [{ id: admin.id }, { id: secondOwner.id }, { id: thirdOwner.id }] },
        projectRequestId: projReq.id,
      },
    });
    projectIds.push(multiOwnerProject.id);

    const beforeUnrelatedPatch = await prisma.project.findUnique({
      where: { id: multiOwnerProject.id },
      include: { owners: { select: { id: true } } },
    });
    check(
      "(fixture) all 3 explicitly-connected Owners are present before the PATCH",
      !!beforeUnrelatedPatch && beforeUnrelatedPatch.owners.length === 3
    );

    const unrelatedPatchRes = await patchProjectRoute(
      jsonReq(`http://localhost/api/projects/${multiOwnerProject.id}`, { priority: 1 }),
      { params: Promise.resolve({ id: multiOwnerProject.id }) }
    );
    check("Unrelated-field PATCH (priority) -> 200", unrelatedPatchRes.status === 200);

    const afterUnrelatedPatch = await prisma.project.findUnique({
      where: { id: multiOwnerProject.id },
      include: { owners: { select: { id: true } } },
    });
    const ownerIdsAfter = new Set((afterUnrelatedPatch?.owners ?? []).map((o) => o.id));
    check("ownerId still the primary owner", afterUnrelatedPatch?.ownerId === admin.id);
    check(
      "owners still contains ALL 3 original Owners — none dropped by the unrelated PATCH",
      ownerIdsAfter.has(admin.id) && ownerIdsAfter.has(secondOwner.id) && ownerIdsAfter.has(thirdOwner.id) && ownerIdsAfter.size === 3
    );
    check("ownerId ∈ owners still holds", ownerIdsAfter.has(afterUnrelatedPatch!.ownerId));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectNote.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
      await prisma.taskType.deleteMany({ where: { id: { in: projectRequestTypeIds } } });
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
