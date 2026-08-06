/**
 * Verifies the Organization Chart route move (from /admin/organization to
 * the canonical /organization) and its navigation/RBAC wiring:
 *  1. The old /admin/organization page permanently redirects to /organization.
 *  2. The new /organization page requires a session (redirects to /login
 *     when absent) and renders normally when present — same auth contract
 *     as before the move, unchanged.
 *  3. canViewFullOrganizationTree (the RBAC gate backing both the nav
 *     shortcut's visibility AND the full-tree-vs-own-slice API scoping) is
 *     untouched by this move: ADMIN/DIRECTOR still bypass, a granted custom
 *     role still passes, a plain USER still doesn't.
 *  4. The sidebar's static nav config reflects the move: a top-level
 *     "Organization" entry pointing at /organization gated by
 *     canViewOrganizationChart, the old "Organization" (My Departments) item
 *     renamed to "My Department" with its href/children untouched, and no
 *     leftover "Organization Chart" entry under Administration (moved, not
 *     duplicated).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-organization-nav-route.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope } from "@prisma/client";
import { canViewFullOrganizationTree } from "@/lib/services/organization-scope-service";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

let currentSession: { user: { id: string } } | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

// The real /organization page's component tree imports @xyflow/react's CSS
// (components/admin/organization-chart/organization-chart-view.tsx), which
// only a real bundler (Next's own build, not a bare `tsx` script) knows how
// to load — stub it out so the module graph can resolve here at all. This
// has no effect on what's actually being tested (the page's redirect/auth
// contract, not its rendered CSS).
mock.module("@xyflow/react/dist/style.css", {});

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const customRoleIds: string[] = [];

  try {
    console.log("\n1. Old /admin/organization redirects to the canonical /organization...\n");
    const { default: AdminOrganizationPage } = await import("@/app/(main)/admin/organization/page");
    try {
      AdminOrganizationPage();
      check("Calling the old page throws a redirect (it never reaches this line)", false);
    } catch (err: any) {
      check("Old /admin/organization throws a NEXT_REDIRECT", typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT"));
      check("Redirect target is exactly /organization", String(err?.digest ?? "").split(";")[2] === "/organization");
    }

    console.log("\n2. New /organization page's session contract...\n");
    const { default: OrganizationChartPage } = await import("@/app/(main)/organization/page");
    currentSession = null;
    try {
      await OrganizationChartPage();
      check("No session -> redirects to /login", false);
    } catch (err: any) {
      check("No session -> redirects to /login", String(err?.digest ?? "").split(";")[2] === "/login");
    }

    const user = await prisma.user.create({ data: { email: `org-nav-user-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(user.id);
    currentSession = { user: { id: user.id } };
    const element = await OrganizationChartPage();
    check("With a session, the page renders (no redirect thrown) — same contract as before the move", element != null && typeof element === "object");

    console.log("\n3. RBAC gate (canViewFullOrganizationTree) is unchanged by the move...\n");
    check("ADMIN always has full-tree access", await canViewFullOrganizationTree(Role.ADMIN, null));
    check("DIRECTOR always has full-tree access", await canViewFullOrganizationTree(Role.DIRECTOR, null));
    check("A plain USER with no grant does NOT have full-tree access", !(await canViewFullOrganizationTree(Role.USER, null)));

    const grantedRole = await prisma.customRole.create({
      data: { key: `org-nav-granted-${RUN_ID}`, name: `Org Nav Granted ${RUN_ID}`, scope: RoleScope.GLOBAL },
    });
    customRoleIds.push(grantedRole.id);
    const treeViewPermission = await prisma.permission.findUnique({ where: { key: "organization.tree.view" } });
    if (!treeViewPermission) throw new Error("organization.tree.view permission row is missing — run the seed first.");
    await prisma.rolePermission.create({ data: { roleKey: grantedRole.key, permissionId: treeViewPermission.id } });
    check("A USER with a custom role granted organization.tree.view has full-tree access", await canViewFullOrganizationTree(Role.USER, grantedRole.id));

    console.log("\n4. Sidebar nav config reflects the move...\n");
    const sidebarSource = readFileSync(join(process.cwd(), "components/layout/sidebar.tsx"), "utf-8");
    check(
      'A top-level "Organization" item links to /organization, gated by canViewOrganizationChart',
      /label:\s*"Organization",\s*\n\s*href:\s*"\/organization",\s*\n\s*icon:\s*Building2,\s*\n\s*visible:\s*navFlags\.canViewOrganizationChart,/.test(sidebarSource)
    );
    check(
      'The old "Organization" (My Departments) item is renamed to "My Department", href/children untouched',
      /label:\s*"My Department",\s*\n\s*href:\s*"\/my-departments",/.test(sidebarSource) &&
        sidebarSource.includes('{ label: "My Departments", href: "/my-departments"') &&
        sidebarSource.includes('{ label: "My SubDepartments", href: "/my-subdepartments"')
    );
    check(
      'No leftover "Organization Chart" entry under Administration (moved, not duplicated)',
      !sidebarSource.includes('label: "Organization Chart"') && !sidebarSource.includes('href: "/admin/organization"')
    );
    check(
      "Every other Administration entry is still present (nothing else was accidentally removed)",
      sidebarSource.includes('{ label: "Users", href: "/admin/users"') &&
        sidebarSource.includes('{ label: "Departments", href: "/admin/departments"') &&
        sidebarSource.includes('{ label: "Integrations", href: "/admin/integrations"')
    );
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (customRoleIds.length > 0) {
        await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleIds.length ? [`org-nav-granted-${RUN_ID}`] : [] } } });
        await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      }
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
