/**
 * Focused regression for ProjectRequest.requesterDepartmentId — a
 * server-resolved SNAPSHOT of the requester's own department (never the
 * request's target department) at submission time.
 *
 * Covers the submission-time resolution logic in POST /api/project-requests
 * (real route, real DB) and the read-only display on the Project Request
 * detail page. The resulting Project Overview display (field order,
 * null-safe rendering, permission scoping) is covered separately in
 * scripts/test-project-request-approvals-display.ts, which already builds
 * the Project/ProjectRequest fixtures directly and renders that page.
 *
 * Uses the `projectRequest.skipIntermediateApproval` permission grant to
 * bypass the intermediate-approval stage's SQLGeneral manager-chain lookup
 * entirely (same mechanism, same established test shortcut as other
 * Project Request submission tests that aren't themselves about that
 * stage) — this file's subject is the requester-department snapshot, not
 * intermediate approval.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-requester-department.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";

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
const TAG = `prrd-${RUN_ID}`;

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

async function main() {
  let prisma: typeof import("@/lib/prisma").prisma;
  try {
    ({ prisma } = await import("@/lib/prisma"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { Role, DepartmentRole, MembershipSource, AuthProvider, RoleScope } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { setPrimaryDepartmentMembership } = await import("@/lib/services/department-membership-service");
  const requestsPOST = (await import("@/app/api/project-requests/route")).POST;
  const { default: ProjectRequestDetailPage } = await import("@/app/(main)/project-requests/[id]/page");

  const jsonReq = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const requestIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  async function grantGlobalPermission(label: string, permissionKey: string): Promise<string> {
    const role = await prisma.customRole.create({ data: { key: `${TAG}-${label}-${customRoleIds.length}`, name: `${TAG} ${label}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
    customRoleIds.push(role.id);
    customRoleKeys.push(role.key);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { key: permissionKey } });
    await prisma.rolePermission.create({ data: { roleKey: role.key, permissionId: perm.id } });
    return role.id;
  }

  try {
    console.log("\n=== Fixtures ===\n");
    const homeDept = await createDepartment({ name: `${TAG}-home-dept`, slug: `${TAG}-home-dept` });
    deptIds.push(homeDept.id);
    const targetDept = await createDepartment({ name: `${TAG}-target-dept`, slug: `${TAG}-target-dept` });
    deptIds.push(targetDept.id);
    const otherDept = await createDepartment({ name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` });
    deptIds.push(otherDept.id);

    const skipRoleId = await grantGlobalPermission("skip-intermediate", "projectRequest.skipIntermediateApproval");

    // Requester: HOME department (primary) differs from the department
    // they're about to submit the request FOR (target). Also given
    // membership in `targetDept` (not primary) so they're a legitimate,
    // real member of both — resolveDepartmentForRequest's own accessible
    // set requires real membership, not merely an arbitrary id.
    const requester = await prisma.user.create({ data: { email: `${TAG}-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: true, customRoleId: skipRoleId } });
    userIds.push(requester.id);
    await prisma.departmentMembership.create({ data: { userId: requester.id, departmentId: homeDept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true } });
    await prisma.departmentMembership.create({ data: { userId: requester.id, departmentId: targetDept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    await prisma.user.update({ where: { id: requester.id }, data: { departmentId: homeDept.id } }); // mirrors what setPrimaryDepartmentMembership would have set

    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: skipRoleId } };

    // ── 1. Correctly captured, and DIFFERS from the target department ───
    console.log("\n1. Requester department captured correctly, independent of the target department ===\n");
    const res1 = await requestsPOST(
      jsonReq({
        title: `${TAG} Request 1`,
        description: "A description long enough to pass validation.",
        importance: 2,
        teamConcerned: "IT",
        expectedBenefits: "Benefits text long enough.",
        departmentId: targetDept.id,
        intermediateApproverIds: [],
      })
    );
    check("POST -> 201", res1.status === 201, JSON.stringify(await res1.clone().json()));
    const body1 = await res1.json();
    if (body1.id) requestIds.push(body1.id);
    const dbRequest1 = await prisma.projectRequest.findUnique({ where: { id: body1.id } });
    check("Target departmentId is the SELECTED department", dbRequest1?.departmentId === targetDept.id);
    check("requesterDepartmentId is the requester's OWN (home) department", dbRequest1?.requesterDepartmentId === homeDept.id);
    check("Requester and target departments genuinely differ", dbRequest1?.departmentId !== dbRequest1?.requesterDepartmentId);

    // ── 2. Client cannot spoof requesterDepartmentId ─────────────────────
    console.log("\n2. A forged requesterDepartmentId in the request body is ignored ===\n");
    const res2 = await requestsPOST(
      jsonReq({
        title: `${TAG} Request 2`,
        description: "A description long enough to pass validation.",
        importance: 1,
        teamConcerned: "IT",
        expectedBenefits: "Benefits text long enough.",
        departmentId: targetDept.id,
        requesterDepartmentId: otherDept.id, // forged — not a real schema field at all
        intermediateApproverIds: [],
      })
    );
    check("POST -> 201 (unknown key silently stripped, not rejected)", res2.status === 201);
    const body2 = await res2.json();
    if (body2.id) requestIds.push(body2.id);
    const dbRequest2 = await prisma.projectRequest.findUnique({ where: { id: body2.id } });
    check("requesterDepartmentId is STILL the requester's real home department, never the forged value", dbRequest2?.requesterDepartmentId === homeDept.id);
    check("The forged value was never used", dbRequest2?.requesterDepartmentId !== otherDept.id);

    // ── 3. Department change AFTER submission never alters the snapshot ──
    console.log("\n3. A later department transfer does not retroactively change the stored snapshot ===\n");
    await setPrimaryDepartmentMembership(requester.id, otherDept.id, MembershipSource.MANUAL, { role: DepartmentRole.VIEWER });
    const requesterAfterTransfer = await prisma.user.findUnique({ where: { id: requester.id }, select: { departmentId: true } });
    check("(sanity) requester's CURRENT department really did change", requesterAfterTransfer?.departmentId === otherDept.id);
    const dbRequest1AfterTransfer = await prisma.projectRequest.findUnique({ where: { id: body1.id } });
    check("Request 1's historical requesterDepartmentId is UNCHANGED after the transfer", dbRequest1AfterTransfer?.requesterDepartmentId === homeDept.id);

    // A NEW submission after the transfer correctly captures the NEW home department.
    const res3 = await requestsPOST(
      jsonReq({
        title: `${TAG} Request 3`,
        description: "A description long enough to pass validation.",
        importance: 1,
        teamConcerned: "IT",
        expectedBenefits: "Benefits text long enough.",
        departmentId: targetDept.id,
        intermediateApproverIds: [],
      })
    );
    check("Post-transfer submission -> 201", res3.status === 201);
    const body3 = await res3.json();
    if (body3.id) requestIds.push(body3.id);
    const dbRequest3 = await prisma.projectRequest.findUnique({ where: { id: body3.id } });
    check("A request submitted AFTER the transfer captures the NEW home department", dbRequest3?.requesterDepartmentId === otherDept.id);

    // ── 4. No primary department at all -> null, never guessed ──────────
    console.log("\n4. A requester with no primary department -> requesterDepartmentId is null ===\n");
    const noDeptRequester = await prisma.user.create({ data: { email: `${TAG}-no-dept-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", isActive: true, customRoleId: skipRoleId } });
    userIds.push(noDeptRequester.id);
    await prisma.departmentMembership.create({ data: { userId: noDeptRequester.id, departmentId: targetDept.id, role: DepartmentRole.VIEWER, source: MembershipSource.MANUAL, isPrimary: false, isActive: true } });
    currentSession = { user: { id: noDeptRequester.id, role: Role.USER, customRoleId: skipRoleId } };
    const res4 = await requestsPOST(
      jsonReq({
        title: `${TAG} Request 4`,
        description: "A description long enough to pass validation.",
        importance: 1,
        teamConcerned: "IT",
        expectedBenefits: "Benefits text long enough.",
        departmentId: targetDept.id,
        intermediateApproverIds: [],
      })
    );
    check("POST -> 201 even with no primary department", res4.status === 201);
    const body4 = await res4.json();
    if (body4.id) requestIds.push(body4.id);
    const dbRequest4 = await prisma.projectRequest.findUnique({ where: { id: body4.id } });
    check("requesterDepartmentId is null (never guessed)", dbRequest4?.requesterDepartmentId === null);

    // ── 5. Project Request detail page displays it, and "Not recorded" for null ──
    console.log("\n5. Project Request detail page renders Requester Department correctly ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: skipRoleId } };
    // Render via a plain text extraction, matching this suite's own
    // established convention (collectText over the already-constructed
    // element tree — see test-project-request-approvals-display.ts).
    // This page's own Field({label, value}) is a custom component whose
    // rendered text lives in PROPS, not `children` (it builds its own
    // <p>{value}</p> internally — never instantiated here, since this never
    // actually renders anything, only inspects the plain element tree the
    // page function itself already constructed). So for any element whose
    // `type` isn't a plain DOM tag (a string), every OTHER prop value is
    // walked too, not just `children`.
    function collectText(node: unknown, out: string[] = []): string[] {
      if (node === null || node === undefined || typeof node === "boolean") return out;
      if (typeof node === "string" || typeof node === "number") {
        out.push(String(node));
        return out;
      }
      if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return out;
      }
      if (React.isValidElement(node)) {
        const props = node.props as Record<string, unknown> | null | undefined;
        if (props) {
          const isCustomComponent = typeof node.type !== "string";
          for (const key of Object.keys(props)) {
            if (key === "children" || isCustomComponent) collectText(props[key], out);
          }
        }
        return out;
      }
      return out;
    }
    const detailElement1 = await ProjectRequestDetailPage({ params: Promise.resolve({ id: body1.id }) } as any);
    const detailText1 = collectText(detailElement1).join(" ␟ ");
    check("Shows the correct Requester Department name (home dept)", detailText1.includes(`${TAG}-home-dept`));

    currentSession = { user: { id: noDeptRequester.id, role: Role.USER, customRoleId: skipRoleId } };
    const detailElement4 = await ProjectRequestDetailPage({ params: Promise.resolve({ id: body4.id }) } as any);
    const detailText4 = collectText(detailElement4).join(" ␟ ");
    check('Null requesterDepartment renders "Not recorded"', detailText4.includes("Not recorded"));

    // ── 6. Historical rows (pre-existing this feature) render safely ────
    console.log("\n6. A historical row with no requesterDepartmentId column value renders safely ===\n");
    const historicalRequest = await prisma.projectRequest.create({
      data: {
        title: `${TAG} Historical Request`,
        description: "d",
        importance: 2,
        teamConcerned: "IT",
        expectedBenefits: "b",
        requesterId: requester.id,
        departmentId: targetDept.id,
        // requesterDepartmentId omitted entirely -> null, simulating a
        // pre-existing row from before this feature existed.
      },
    });
    requestIds.push(historicalRequest.id);
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: skipRoleId } };
    const historicalElement = await ProjectRequestDetailPage({ params: Promise.resolve({ id: historicalRequest.id }) } as any);
    const historicalText = collectText(historicalElement).join(" ␟ ");
    check('Historical row -> "Not recorded", no crash', historicalText.includes("Not recorded"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: requestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: requestIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
