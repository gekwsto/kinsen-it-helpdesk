/**
 * Focused regression for the "Request & Approvals" section added to the
 * Project Overview (app/(main)/projects/[id]/page.tsx) for Projects
 * originating from a Project Request.
 *
 * Calls the real Server Component function directly (it's a plain async
 * function returning a React element tree — no client-only rendering
 * needed) and walks the ALREADY-CONSTRUCTED element graph it returns for
 * specific text, rather than fully rendering every nested "use client"
 * component through react-dom/server (which would require mocking far
 * more than this section's own correctness needs). This proves the
 * SERVER function itself computed and embedded the right data — the
 * actual persisted approval history, gated by the right authorization
 * check — without depending on any particular DOM renderer.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-request-approvals-display.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

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

/** Walks a React element tree (plain {type, props} objects — never actually rendered) collecting every string/number leaf, so a "does this text appear anywhere" assertion doesn't depend on any particular DOM renderer successfully handling every nested client component. */
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
    const props = node.props as { children?: unknown } | null | undefined;
    if (props && "children" in props) collectText(props.children, out);
    return out;
  }
  return out;
}

const RUN_ID = Date.now();
const TAG = `prad-${RUN_ID}`;

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

  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, IntermediateApprovalStatus, ProjectRequestStatus } = await import("@prisma/client");
  const ProjectDetailPage = (await import("@/app/(main)/projects/[id]/page")).default;

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const projectRequestIds: string[] = [];

  async function renderText(projectId: string, userId: string, role: any = Role.USER, customRoleId: string | null = null): Promise<string> {
    currentSession = { user: { id: userId, role, customRoleId } };
    try {
      const element = await ProjectDetailPage({ params: Promise.resolve({ id: projectId }) } as any);
      return collectText(element).join(" ␟ ");
    } catch (err: any) {
      // next/navigation's redirect()/notFound() always throw outside a
      // real Next.js request — treat either as "nothing rendered" (a
      // meaningful, checkable outcome on its own), never a test crash.
      if (err?.digest?.startsWith("NEXT_REDIRECT") || err?.digest === "NEXT_NOT_FOUND") return "";
      throw err;
    }
  }

  try {
    console.log("\n=== Fixtures ===\n");
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);

    const requester = await prisma.user.create({ data: { email: `${TAG}-requester@example.com`, name: "Rita Requester", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    const approver1 = await prisma.user.create({ data: { email: `${TAG}-approver1@example.com`, name: "Alan Approver", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    const approver2 = await prisma.user.create({ data: { email: `${TAG}-approver2@example.com`, name: "Bea Approver", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    const finalApprover = await prisma.user.create({ data: { email: `${TAG}-final@example.com`, name: "Fiona Final", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    const outsider = await prisma.user.create({ data: { email: `${TAG}-outsider@example.com`, name: "Oscar Outsider", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    for (const u of [requester, approver1, approver2, finalApprover, outsider]) userIds.push(u.id);

    const submittedAt = new Date("2026-10-01T09:00:00Z");
    const decidedAt1 = new Date("2026-10-02T10:00:00Z");
    const decidedAt2 = new Date("2026-10-02T11:30:00Z");
    const approvedAt = new Date("2026-10-03T14:00:00Z");

    const request = await prisma.projectRequest.create({
      data: {
        title: `${TAG} Request`,
        description: "d",
        importance: 2,
        teamConcerned: "IT",
        expectedBenefits: "benefits",
        requesterId: requester.id,
        departmentId: dept.id,
        status: ProjectRequestStatus.APPROVED,
        submittedAt,
        approverId: finalApprover.id,
        approvedAt,
        businessAssessment: "Final approval justification text.",
        intermediateApprovers: {
          create: [
            { approverId: approver1.id, status: IntermediateApprovalStatus.APPROVED, decidedAt: decidedAt1, businessAssessment: "Looks good from my side." },
            { approverId: approver2.id, status: IntermediateApprovalStatus.APPROVED, decidedAt: decidedAt2, businessAssessment: null },
          ],
        },
      },
    });
    projectRequestIds.push(request.id);

    const requestOriginProject = await prisma.project.create({
      data: {
        title: `${TAG} Request-Origin Project`,
        ownerId: requester.id,
        owners: { connect: [{ id: requester.id }] },
        // Audience grants VIEW access to a request-origin Project
        // regardless of department permission (hasProjectViewAccess) —
        // used below to give `outsider` real, unambiguous project access
        // WITHOUT also granting any request-level approval access, so
        // test 6 below isolates exactly the boundary it's testing.
        // approver1 ALSO needs SOME way past the Project's own, separate
        // view gate (hasProjectViewAccess) to reach test 7 below — being
        // an intermediate approver on the originating REQUEST grants no
        // view access to the resulting PROJECT by itself (two genuinely
        // independent authorization domains; this feature correctly
        // never conflates them). Audience is the minimal, legitimate way
        // to grant that, same as outsider above.
        audience: { connect: [{ id: outsider.id }, { id: approver1.id }] },
        departmentId: dept.id,
        projectRequestId: request.id,
      },
    });
    projectIds.push(requestOriginProject.id);

    const manualProject = await prisma.project.create({
      data: { title: `${TAG} Manual Project`, ownerId: requester.id, owners: { connect: [{ id: requester.id }] }, departmentId: dept.id },
    });
    projectIds.push(manualProject.id);

    // ── 1. Manual Project -> no Request & Approvals section at all ───────
    // Viewed by finalApprover (ADMIN — global view access) rather than
    // requester: hasProjectViewAccess's Owner-based bypass only applies to
    // a REQUEST-ORIGIN Project (see its own doc comment) — a MANUAL
    // Project's owner still needs real department access to view it,
    // unrelated to what this check is testing.
    console.log("\n1. Manually created Project -> no Request & Approvals section ===\n");
    const manualText = await renderText(manualProject.id, finalApprover.id, Role.ADMIN);
    check("No 'Request & Approvals' heading", !manualText.includes("Request & Approvals"));
    check("No approver names leaked either", !manualText.includes("Alan Approver"));

    // ── 2. Request-origin Project, viewed by the REQUESTER ────────────────
    console.log("\n2. Request-origin Project, viewed by the requester ===\n");
    const requesterText = await renderText(requestOriginProject.id, requester.id);
    check("Section heading present", requesterText.includes("Request & Approvals"));
    check("Correct Requested By", requesterText.includes("Rita Requester"));
    check("Original Project Request link text (title) present", requesterText.includes(`${TAG} Request`));

    // ── 3. Multiple intermediate approvers, each with independent decision ─
    console.log("\n3. Multiple intermediate approvers shown individually ===\n");
    check("Approver 1 name present", requesterText.includes("Alan Approver"));
    check("Approver 2 name present", requesterText.includes("Bea Approver"));
    check("Approver 1's own comment present", requesterText.includes("Looks good from my side."));
    check("Both labeled 'Intermediate Approver'", (requesterText.match(/Intermediate Approver/g) ?? []).length === 2);
    check("At least 2 'Approved' decisions rendered for the intermediate stage + final stage combined", (requesterText.match(/Approved/g) ?? []).length >= 3);

    // ── 4. Final approval — correct approver/decision/timestamp ───────────
    console.log("\n4. Final approval details ===\n");
    check("Final approver name present", requesterText.includes("Fiona Final"));
    check("Labeled 'Final Approver'", requesterText.includes("Final Approver"));
    check("Final approval's own business assessment present", requesterText.includes("Final approval justification text."));

    // ── 5. Missing/optional comment renders safely (no crash, no 'null') ──
    console.log("\n5. Missing comment (approver2 had none) renders safely ===\n");
    check("No literal 'null' leaked into the rendered text", !requesterText.includes("null"));

    // ── 6. Authorization — viewed by someone with NO request-level access ──
    console.log("\n6. An authorized Project viewer with NO request-level access sees the Project but not the section ===\n");
    // outsider already has view access via project.audience (set at
    // fixture creation) — NOT requester/final-approver-permission/
    // intermediate-approver status.
    const outsiderText = await renderText(requestOriginProject.id, outsider.id);
    check("Outsider can genuinely view the Project (title present — not redirected away)", outsiderText.includes(`${TAG} Request-Origin Project`));
    check("Request & Approvals section is OMITTED for a viewer with no request-level access", !outsiderText.includes("Request & Approvals"));
    check("No approver business-assessment comment leaked to an unauthorized viewer", !outsiderText.includes("Looks good from my side."));

    // ── 7. The intermediate approver himself CAN see it (even with no department permission) ──
    console.log("\n7. A selected intermediate approver can see the section ===\n");
    const approverText = await renderText(requestOriginProject.id, approver1.id);
    check("Intermediate approver sees the Request & Approvals section", approverText.includes("Request & Approvals"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.departmentMembership.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.projectRequestIntermediateApprover.deleteMany({ where: { projectRequestId: { in: projectRequestIds } } });
      await prisma.projectRequest.deleteMany({ where: { id: { in: projectRequestIds } } });
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
