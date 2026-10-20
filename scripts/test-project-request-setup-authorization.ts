/**
 * Regression coverage for broadening "who may complete a Project Request's
 * Project setup" from the exact recorded final approver to anyone who
 * currently holds effective projectRequest.approve for the request's own
 * department — lib/services/project-request-service.ts's
 * createProjectFromApprovedRequest.
 *
 * Usage: npx tsx scripts/test-project-request-setup-authorization.ts
 * Requires a reachable DATABASE_URL.
 */
// lib/services/project-request-service.ts transitively imports
// lib/notifications/create-notification.ts -> lib/web-push.ts, which has a
// top-level `import "server-only"` — that marker package always throws
// under plain Node/tsx (its package.json only resolves to a no-op under a
// bundler's "react-server" export condition, which tsx/node never set) — a
// pre-existing environment quirk, unrelated to this change. Pre-seeding
// Node's CJS module cache makes it a no-op, same as it already is inside a
// real Next.js server build — same workaround already used in
// scripts/test-department-ticket-notifications.ts and
// scripts/test-hr-directory-sync.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = { id: serverOnlyPath, filename: serverOnlyPath, loaded: true, exports: {} } as NodeModule;

import { prisma } from "@/lib/prisma";
import { Role, RoleScope, DepartmentRole, MembershipSource } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { grantManualMembership, setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";
// Dynamically imported inside main(), not statically here — see the
// server-only workaround comment above for why.
type ProjectRequestService = typeof import("@/lib/services/project-request-service");

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

const RUN_ID = Date.now();
const email = (local: string) => `${local}.${RUN_ID}@kinsen.gr`;

async function makeApproverCustomRole(label: string) {
  const permission = await prisma.permission.findUnique({ where: { key: "projectRequest.approve" } });
  if (!permission) throw new Error("projectRequest.approve permission not seeded — cannot run this test");
  const role = await prisma.customRole.create({
    data: { key: `${label}-${RUN_ID}`, name: `${label} ${RUN_ID}`, scope: RoleScope.DEPARTMENT, isActive: true },
  });
  await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: permission.id } });
  return role;
}

async function makeUser(local: string) {
  return prisma.user.create({
    data: { email: email(local), name: local, authProvider: "CREDENTIALS", isActive: true, role: Role.USER },
  });
}

async function cleanup(ids: { userIds: string[]; departmentIds: string[]; customRoleIds: string[]; requestIds: string[] }) {
  await prisma.project.deleteMany({ where: { projectRequestId: { in: ids.requestIds } } });
  await prisma.projectRequest.deleteMany({ where: { id: { in: ids.requestIds } } });
  await prisma.departmentMembership.deleteMany({ where: { userId: { in: ids.userIds } } });
  await prisma.rolePermission.deleteMany({ where: { roleKey: { in: (await prisma.customRole.findMany({ where: { id: { in: ids.customRoleIds } }, select: { key: true } })).map((r) => r.key) } } });
  await prisma.customRole.deleteMany({ where: { id: { in: ids.customRoleIds } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.userIds } } });
  try {
    await prisma.department.deleteMany({ where: { id: { in: ids.departmentIds } } });
  } catch {
    console.warn("Note: left department rows in place (FK-restricted by starter config rows) — harmless, identifiable by RUN_ID.");
  }
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    console.error("DATABASE_URL not reachable — skipping (this script requires a real dev DB).");
    process.exitCode = 0;
    return;
  }

  const { decideApproval, createProjectFromApprovedRequest }: ProjectRequestService = await import("@/lib/services/project-request-service");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const customRoleIds: string[] = [];
  const requestIds: string[] = [];

  try {
    console.log("\n=== Setup ===");
    const dept = await createDepartment({ name: `Setup-Auth Dept ${RUN_ID}` });
    departmentIds.push(dept.id);

    const approverRole = await makeApproverCustomRole("approver-role");
    customRoleIds.push(approverRole.id);

    const requester = await makeUser("requester");
    const originalApprover = await makeUser("original-approver"); // approves, then "disappears"
    const otherApprover = await makeUser("other-approver"); // different person, same department-approve authority
    const noPermissionUser = await makeUser("no-permission"); // department member, but NOT holding projectRequest.approve
    userIds.push(requester.id, originalApprover.id, otherApprover.id, noPermissionUser.id);

    // Both approvers get the SAME custom role (projectRequest.approve) —
    // two independent people with the identical authority, never tied to
    // each other.
    await grantManualMembership(originalApprover.id, dept.id, { customRoleId: approverRole.id });
    await grantManualMembership(otherApprover.id, dept.id, { customRoleId: approverRole.id });
    // A real department member, but on the plain VIEWER role — no approve
    // permission at all.
    await grantManualMembership(noPermissionUser.id, dept.id, { role: DepartmentRole.VIEWER });

    const deptDefault = await resolveDefaultDepartmentRoleAssignment();
    await setPrimaryDepartmentMembership(requester.id, dept.id, MembershipSource.MANUAL, { role: deptDefault.role, customRoleId: deptDefault.customRoleId });

    const request = await prisma.projectRequest.create({
      data: {
        title: `Setup-Auth test request ${RUN_ID}`,
        description: "Test description",
        importance: 2,
        teamConcerned: "QA",
        expectedBenefits: "Testing",
        requesterId: requester.id,
        departmentId: dept.id,
        status: "PENDING_APPROVAL", // skip the intermediate stage — not under test here
      },
    });
    requestIds.push(request.id);

    console.log("\n=== Final approval (by originalApprover) ===");
    const decision = await decideApproval(request.id, originalApprover.id, Role.USER, null, "approve", "Looks good, approved.");
    check("decideApproval succeeded", decision.ok === true);
    const afterDecision = await prisma.projectRequest.findUnique({ where: { id: request.id }, select: { status: true, approverId: true } });
    check("Request status is APPROVED", afterDecision?.status === "APPROVED");
    check("approverId recorded is originalApprover (the one who clicked Approve)", afterDecision?.approverId === originalApprover.id);

    const projectInput = {
      title: "Setup-Auth test Project",
      description: "Test",
      status: "PLANNING" as const,
      priority: 2,
      subDepartmentId: null,
      ownerIds: [requester.id],
      audienceIds: [],
      memberIds: [],
      expenseTypeId: (await prisma.projectExpenseType.findFirst({ select: { id: true } }))?.id ?? "",
      expectedStartDate: new Date().toISOString(),
      expectedFinishDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      isGoal: false,
      external: false,
    };
    check("Fixture: at least one ProjectExpenseType exists to use in setup", !!projectInput.expenseTypeId);

    console.log("\n=== FIX VERIFICATION: a DIFFERENT user with the same department-approve authority can complete setup ===");
    const byOther = await createProjectFromApprovedRequest(request.id, otherApprover.id, Role.USER, null, projectInput);
    check(
      "otherApprover (NOT the recorded approver, but holds the same projectRequest.approve authority for this department) can complete setup",
      byOther.ok === true
    );
    if (byOther.ok) {
      check("A real Project was created (not just an 'already existed' no-op)", byOther.alreadyExisted === false);
      const project = await prisma.project.findUnique({ where: { id: byOther.projectId } });
      check("The created Project is linked to this exact Project Request", project?.projectRequestId === request.id);
    }

    console.log("\n=== A user WITHOUT projectRequest.approve for this department is still correctly forbidden ===");
    const request2 = await prisma.projectRequest.create({
      data: {
        title: `Setup-Auth test request 2 ${RUN_ID}`,
        description: "Test description",
        importance: 2,
        teamConcerned: "QA",
        expectedBenefits: "Testing",
        requesterId: requester.id,
        departmentId: dept.id,
        status: "PENDING_APPROVAL",
      },
    });
    requestIds.push(request2.id);
    await decideApproval(request2.id, originalApprover.id, Role.USER, null, "approve", "Approved too.");
    const byNoPermission = await createProjectFromApprovedRequest(request2.id, noPermissionUser.id, Role.USER, null, projectInput);
    check(
      "A department member WITHOUT projectRequest.approve is still rejected (forbidden) — the broadening is scoped to the real permission, not 'anyone in the department'",
      byNoPermission.ok === false && !byNoPermission.ok && byNoPermission.error.code === "forbidden"
    );

    console.log("\n=== Idempotency preserved: a second eligible approver calling setup again after it's already done returns the SAME Project, never a duplicate ===");
    const byOriginalAgain = await createProjectFromApprovedRequest(request.id, originalApprover.id, Role.USER, null, projectInput);
    check("The original approver (who still also holds the permission) calling setup again gets alreadyExisted:true", byOriginalAgain.ok === true && byOriginalAgain.ok && byOriginalAgain.alreadyExisted === true);
    if (byOther.ok && byOriginalAgain.ok && byOriginalAgain.alreadyExisted) {
      check("Both calls resolve to the exact same Project id — never a duplicate", byOriginalAgain.projectId === byOther.projectId);
    }
    const projectCount = await prisma.project.count({ where: { projectRequestId: request.id } });
    check("Exactly one Project exists for this request after both the original and the other approver acted on it", projectCount === 1);

    console.log("\n=== An outsider (no department involvement at all) is rejected, not found-as-not-404 ===");
    const outsider = await makeUser("outsider");
    userIds.push(outsider.id);
    const request3 = await prisma.projectRequest.create({
      data: {
        title: `Setup-Auth test request 3 ${RUN_ID}`,
        description: "Test description",
        importance: 2,
        teamConcerned: "QA",
        expectedBenefits: "Testing",
        requesterId: requester.id,
        departmentId: dept.id,
        status: "PENDING_APPROVAL",
      },
    });
    requestIds.push(request3.id);
    await decideApproval(request3.id, originalApprover.id, Role.USER, null, "approve", "Approved.");
    const byOutsider = await createProjectFromApprovedRequest(request3.id, outsider.id, Role.USER, null, projectInput);
    check("An outsider with no department involvement is rejected (forbidden)", byOutsider.ok === false && !byOutsider.ok && byOutsider.error.code === "forbidden");
  } finally {
    await cleanup({ userIds, departmentIds, customRoleIds, requestIds });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
