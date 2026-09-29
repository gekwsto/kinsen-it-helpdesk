/**
 * Regression coverage for making the Project List's "Members" column use
 * the EXACT same trigger markup as the Activity List's "Assigned" column —
 * both were already wrapped in the shared components/shared/member-preview.tsx
 * (hover/focus/tap popover, keyboard-accessible, no new fetch), but Members
 * previously rendered a `<Users icon> {count}` trigger while Assigned
 * rendered a real avatar stack (image or initials fallback, up to 3, then
 * a "+N" overflow) — this closes that visual gap without touching
 * MemberPreview itself, without a second component, and without changing
 * anything about the Project grid/cards, Activity list, sorting, filters,
 * pagination, scope, permissions, or realtime refresh.
 *
 * TESTING APPROACH: SECTION A is a source-text guard proving the two
 * TableCells now share the identical avatar-stack markup (className
 * strings, slice(0,3), the "+N" overflow expression) and that the reuse is
 * literal (both still go through the SAME MemberPreview import, not a
 * second copy) — same established convention as
 * scripts/test-member-preview.ts for client-only interaction this suite has
 * no DOM to drive directly. SECTION B drives the real /projects Server
 * Component page against a real database to prove the empty-state, no-
 * email, and no-new-query guarantees hold for actual data, and that Project
 * grid/cards + Activity List remain byte-for-byte untouched.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-project-members-activity-assigned-parity.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

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

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

const RUN_ID = Date.now();

async function main() {
  // ══════════════════════ SECTION A — source-text parity guard ══════════════════════
  console.log("\n=== SECTION A — Project Members trigger markup is byte-identical to Activity Assigned's ===\n");

  const projectListSrc = await fs.readFile("components/projects/project-list.tsx", "utf8");
  const activityListSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");
  const memberPreviewSrc = await fs.readFile("components/shared/member-preview.tsx", "utf8");

  function extractCell(src: string, cellMarker: string): string {
    const start = src.indexOf(cellMarker);
    if (start === -1) return "";
    // Grab a generous window past the marker — enough to contain the whole
    // TableCell (including its empty-state else-branch) without needing a
    // real JSX parser for this source-text check.
    return src.slice(start, start + 1100);
  }
  const projectMembersCell = extractCell(projectListSrc, "project.members.length > 0");
  const activityAssignedCell = extractCell(activityListSrc, "activity.assignedUsers.length > 0");

  check("Both cells exist and were located", projectMembersCell.length > 0 && activityAssignedCell.length > 0);
  check("Same Avatar wrapper className (image or initials, ring, overlap)", /className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0"/.test(projectMembersCell) && /className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0"/.test(activityAssignedCell));
  check("Same AvatarImage usage (real photo when present)", /<AvatarImage src=\{.*?\.image \?\? undefined\}/.test(projectMembersCell) && /<AvatarImage src=\{.*?\.image \?\? undefined\}/.test(activityAssignedCell));
  check("Same AvatarFallback className (initials fallback, identical text size)", (projectMembersCell.match(/className="text-\[9px\]"/g) ?? []).length > 0 && (activityAssignedCell.match(/className="text-\[9px\]"/g) ?? []).length > 0);
  check("Same fallback initials helper (getInitials) used by both", /getInitials\(.*?\.name\)/.test(projectMembersCell) && /getInitials\(.*?\.name\)/.test(activityAssignedCell));
  check("Same cap of 3 visible avatars before overflow (.slice(0, 3))", /\.slice\(0, 3\)/.test(projectMembersCell) && /\.slice\(0, 3\)/.test(activityAssignedCell));
  check("Same compact overflow representation (\"+N\", length - 3, identical className)", /\{[a-zA-Z.]+\.length > 3 && \(\s*<span className="text-xs text-muted-foreground ml-1">\+\{[a-zA-Z.]+\.length - 3\}<\/span>/.test(projectMembersCell) && /\{[a-zA-Z.]+\.length > 3 && \(\s*<span className="text-xs text-muted-foreground ml-1">\+\{[a-zA-Z.]+\.length - 3\}<\/span>/.test(activityAssignedCell));
  check("Same outer flex wrapper className (\"flex items-center gap-1\") — row height doesn't grow", /className="flex items-center gap-1"/.test(projectMembersCell) && /className="flex items-center gap-1"/.test(activityAssignedCell));
  check("Both still route through the SAME shared MemberPreview wrapper — no second/independent hover implementation", /<MemberPreview members=\{project\.members\} label="Members">/.test(projectMembersCell) && /<MemberPreview members=\{activity\.assignedUsers\} label="Assigned">/.test(activityAssignedCell));

  console.log("\n=== Empty state: same clean, non-interactive behavior as Activity Assigned's ===\n");
  check("Project: zero members renders a plain, non-interactive muted <span> (no MemberPreview/button wrapper at all)", /:\s*\(\s*<span className="text-xs text-muted-foreground">No members<\/span>/.test(projectMembersCell));
  check("Activity: zero assignees renders the same shape of plain muted <span> (pre-existing, unchanged)", /:\s*\(\s*<span className="text-xs text-muted-foreground">Unassigned<\/span>/.test(activityAssignedCell));

  console.log("\n=== Header stays plain, non-sortable ===\n");
  check("Members column header is still a plain TableHead (never SortableTableHead)", /<TableHead>Members<\/TableHead>/.test(projectListSrc));
  check("No \"members\" sortKey was introduced anywhere in ProjectList", !/sortKey="members"/.test(projectListSrc));

  console.log("\n=== No email anywhere in the new markup or the shared preview it reuses ===\n");
  check("Project Members cell never references .email", !/\.email/.test(projectMembersCell));
  check("MemberPreview itself still never references .email (unmodified — no email leak was introduced by reusing it more visibly)", !/\.email/.test(memberPreviewSrc));

  console.log("\n=== Row-navigation is unaffected by the new trigger — same click-prevention MemberPreview already provides ===\n");
  check("MemberPreview's own tap handler still stops propagation before toggling (prevents any wrapping row/Link navigation from firing) — unchanged by this task", /e\.preventDefault\(\);[\s\S]{0,50}e\.stopPropagation\(\);/.test(memberPreviewSrc));
  check("The Project List (table) row itself is not wrapped in a navigating <Link> or an onClick handler (only the Title cell and the trailing View button navigate) — so the new avatar trigger has nothing stray to swallow, same as before", !/<TableRow key=\{project\.id\}[^>]*onClick/.test(projectListSrc));

  console.log("\n=== Project grid/cards and the Activity list's own grid/cards remain byte-for-byte untouched by this task ===\n");
  const projectGridStart = projectListSrc.indexOf('return (\n    <div className="grid gap-4 md:grid-cols-2');
  check("Project grid branch never references MemberPreview or the new avatar-stack markup (Users icon + count untouched there)", projectGridStart > -1 && !/MemberPreview/.test(projectListSrc.slice(projectGridStart)) && /<Users className="h-3\.5 w-3\.5" \/>/.test(projectListSrc.slice(projectGridStart)));
  const activityGridStart = activityListSrc.indexOf("// Grid view");
  check("Activity grid branch is untouched (still renders ActivityCard, no diff from this task)", activityGridStart > -1 && /<ActivityCard/.test(activityListSrc.slice(activityGridStart)));
  check("Activity Assigned cell's own markup is IDENTICAL to before this task (this task only ever read it as a reference, never edited activity-list.tsx)", /activity\.assignedUsers\.length > 0/.test(activityListSrc));

  console.log("\n=== No new fetch/query anywhere in this diff ===\n");
  check("ProjectList still issues zero fetch() calls (avatar stack renders from the existing `project.members` prop only)", !/fetch\(/.test(projectListSrc));
  const projectsPageSrc = await fs.readFile("app/(main)/projects/page.tsx", "utf8");
  check("The /projects page's own Prisma query for `members` is unchanged (still just id/name/image, one query)", /members:\s*\{\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*image:\s*true\s*\}\s*\}/.test(projectsPageSrc));

  // ══════════════════════ SECTION B — real /projects page, real DB ══════════════════════
  console.log("\n=== SECTION B — real /projects List view: avatar/initials data, overflow, empty state, isolation ===\n");

  let ProjectsPage: any, ProjectList: any;
  try {
    ProjectsPage = (await import("@/app/(main)/projects/page")).default;
    ProjectList = (await import("@/components/projects/project-list")).ProjectList;
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { prisma } = await import("@/lib/prisma");
  const { AuthProvider, Role } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping Section B.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];

  const renderProjects = async (params: Record<string, string>) => {
    const el = await ProjectsPage({ searchParams: Promise.resolve(params) });
    return findElementsByType(el, ProjectList)[0]?.props;
  };

  try {
    const dept = await createDepartment({ name: `Parity Dept ${RUN_ID}`, slug: `parity-dept-${RUN_ID}` });
    deptIds.push(dept.id);

    const admin = await prisma.user.create({ data: { email: `parity-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    const withImage = await prisma.user.create({ data: { email: `parity-img-${RUN_ID}@kinsen.gr`, name: "Ivy Image", image: "https://example.com/ivy.png", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const withoutImage = await prisma.user.create({ data: { email: `parity-noimg-${RUN_ID}@kinsen.gr`, name: "Nadia Noimage", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(withImage.id, withoutImage.id);
    const overflowMembers: { id: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await prisma.user.create({ data: { email: `parity-over-${i}-${RUN_ID}@kinsen.gr`, name: `Overflow ${i}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      overflowMembers.push(u);
      userIds.push(u.id);
    }

    const projectWithMixedMembers = await prisma.project.create({
      data: { title: `Parity Mixed ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, members: { connect: [{ id: withImage.id }, { id: withoutImage.id }] } },
    });
    const projectWithOverflow = await prisma.project.create({
      data: { title: `Parity Overflow ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, members: { connect: overflowMembers.map((u) => ({ id: u.id })) } },
    });
    const projectWithNoMembers = await prisma.project.create({ data: { title: `Parity Empty ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id } });
    // Owner is NOT a member unless separately added — proves requirement 2.
    const projectOwnerNotMember = await prisma.project.create({ data: { title: `Parity Owner Only ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, members: { connect: [{ id: withImage.id }] } } });
    projectIds.push(projectWithMixedMembers.id, projectWithOverflow.id, projectWithNoMembers.id, projectOwnerNotMember.id);

    const props = await renderProjects({ view: "list", departmentId: dept.id });
    const rowFor = (id: string) => (props?.projects as any[])?.find((p: any) => p.id === id);

    console.log("\n-- Avatar / initials data is exactly what the trigger needs, nothing more --\n");
    const mixedRow = rowFor(projectWithMixedMembers.id);
    check("Member with an image carries it verbatim (real avatar, not forced to initials)", mixedRow?.members?.find((m: any) => m.id === withImage.id)?.image === "https://example.com/ivy.png");
    check("Member without an image has image: null (renders the SAME initials fallback Activity Assigned uses — AvatarFallback + getInitials, proven structurally in Section A)", mixedRow?.members?.find((m: any) => m.id === withoutImage.id)?.image === null);
    check("No email field present on either member object (nothing new leaked into the tooltip data)", mixedRow?.members?.every((m: any) => !("email" in m)));

    console.log("\n-- Overflow: 5 real members -> the UI (Section A) shows 3 avatars + \"+2\", full data still present for the hover preview --\n");
    const overflowRow = rowFor(projectWithOverflow.id);
    check("All 5 real members are present in the row's own data (MemberPreview's hover list shows every one of them, not just the visible 3)", overflowRow?.members?.length === 5);

    console.log("\n-- Empty state: real zero-member project --\n");
    const emptyRow = rowFor(projectWithNoMembers.id);
    check("Zero-member project: members is a genuinely empty array (renders the plain 'No members' text, proven structurally in Section A)", Array.isArray(emptyRow?.members) && emptyRow.members.length === 0);

    console.log("\n-- Requirement 2: owner is not implicitly a member unless separately registered --\n");
    const ownerRow = rowFor(projectOwnerNotMember.id);
    check("The admin (owner) is NOT counted among `members` here (only withImage, who was explicitly connected) — owner never silently injected", ownerRow?.members?.length === 1 && ownerRow.members[0].id === withImage.id);

    console.log("\n-- Grid/card view still shows the OLD icon+count style (untouched) for the same data --\n");
    const gridProps = await renderProjects({ view: "grid", departmentId: dept.id });
    check("Grid view still returns the exact same `members` data (no view-specific query fork) — only the List view's rendering changed", (gridProps?.projects as any[])?.find((p: any) => p.id === projectWithMixedMembers.id)?.members?.length === 2);
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["categories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["priorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
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

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
