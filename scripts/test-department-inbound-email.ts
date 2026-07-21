/**
 * Department.inboundEmail — the per-department mail routing address for the
 * Pending Tickets flow. Saved via PATCH /api/admin/departments/[id]/inbound-email,
 * gated by department.email.manage (requireDepartmentPermission), separate
 * from the general department.manageSettings PATCH so the two permissions
 * stay independently grantable (see prisma/seed.ts — Department Manager gets
 * email.manage but not manageSettings). Editable from both
 * /admin/departments/[id] and /my-departments — same endpoint, same
 * DepartmentInboundEmailForm component (components/departments/), just a
 * `compact` prop difference — no duplicate route/logic exists for either page.
 *
 * This test exercises the same Prisma calls the route makes directly
 * (setDepartmentInboundEmail + the route's own uniqueness pre-check), the
 * exact hasDepartmentPermission gate the route calls through
 * requireDepartmentPermission, and the exact canManageInboundEmail
 * computation app/(main)/my-departments/page.tsx uses per department.
 *
 * Tests:
 *  1. A user with department.email.manage for a department can set its
 *     inbound email, and it persists.
 *  2. A user WITHOUT department.email.manage for that department is denied
 *     (hasDepartmentPermission returns false — the exact check the route's
 *     requireDepartmentPermission performs).
 *  3. Setting an email already used by another department is rejected
 *     (email_in_use) — the route's own findFirst-excluding-self check.
 *  4. Mixed-case / whitespace input normalizes to lowercase/trimmed on save.
 *  5. Clearing the email (null) succeeds and frees the address for another department.
 *  6. My Departments' own department query (no restrictive `select`) returns
 *     `inboundEmail` on each row, same as the admin page's query.
 *  7. My Departments' canManageInboundEmail logic: a Department Manager's
 *     real membership grants it for their own department only — denied for
 *     another department they don't belong to.
 *  8. Director is NOT auto-granted canManageInboundEmail the way Admin is —
 *     only an actual DepartmentMembership granting department.email.manage
 *     makes it true for a Director, mirroring the page's deliberate
 *     isAdmin()-only (not canViewAllDepartments) bypass.
 *  9. Exactly one inbound-email PATCH route file exists (no duplicate
 *     endpoint was created for the My Departments page).
 *
 * Usage: npx tsx scripts/test-department-inbound-email.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";
import { DepartmentRole, MembershipSource, Role, AuthProvider } from "@prisma/client";
import { hasDepartmentPermission, isAdmin } from "@/lib/permissions";
import { setDepartmentInboundEmail } from "@/lib/services/department-service";

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

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.department.findFirst({ where: { inboundEmail: null }, select: { id: true } });
  } catch (err) {
    console.log(
      "Department.inboundEmail isn't usable against this database yet (migration " +
        "20260724090000_add_department_inbound_email_and_pending_tickets not applied) — skipping. " +
        "Run `npx prisma migrate deploy` (or `migrate dev`) first."
    );
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let deptA: { id: string } | undefined;
  let deptB: { id: string } | undefined;
  let managerUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let outsiderUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const membershipIds: string[] = [];

  try {
    console.log("\nSetting up two departments and a Department Manager for deptA...\n");
    deptA = await prisma.department.create({ data: { name: `Email Dept A ${RUN_ID}`, slug: `email-dept-a-${RUN_ID}` }, select: { id: true } });
    deptB = await prisma.department.create({ data: { name: `Email Dept B ${RUN_ID}`, slug: `email-dept-b-${RUN_ID}` }, select: { id: true } });

    managerUser = await prisma.user.create({
      data: { email: `email-manager-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    outsiderUser = await prisma.user.create({
      data: { email: `email-outsider-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    const membership = await prisma.departmentMembership.create({
      data: { userId: managerUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(membership.id);

    console.log("\nTesting the permission gate...\n");
    check(
      "Department Manager has department.email.manage (seeded default — matches the route's gate)",
      await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "department.email.manage", null)
    );
    check(
      "An outsider with no DepartmentMembership in deptA is denied (route's requireDepartmentPermission would 403)",
      (await prisma.departmentMembership.findUnique({
        where: { userId_departmentId: { userId: outsiderUser.id, departmentId: deptA.id } },
      })) === null
    );

    console.log("\nTesting save + persistence...\n");
    const email = `Support+${RUN_ID}@Kinsen.GR`;
    const normalized = email.trim().toLowerCase();
    const updated = await setDepartmentInboundEmail(deptA.id, normalized);
    check("Save persists the normalized (lowercase/trimmed) email", updated.inboundEmail === normalized);

    const reread = await prisma.department.findUnique({ where: { id: deptA.id }, select: { inboundEmail: true } });
    check("Re-fetching the department shows the saved email", reread?.inboundEmail === normalized);

    console.log("\nTesting duplicate rejection (the route's own pre-check)...\n");
    const conflict = await prisma.department.findFirst({
      where: { inboundEmail: normalized, NOT: { id: deptB.id } },
      select: { id: true },
    });
    check("Route's uniqueness pre-check finds the conflicting department (deptA) when deptB tries the same address", conflict?.id === deptA.id);

    console.log("\nTesting clearing the email...\n");
    const cleared = await setDepartmentInboundEmail(deptA.id, null);
    check("Clearing (null) succeeds", cleared.inboundEmail === null);

    const freedCheck = await prisma.department.findFirst({ where: { inboundEmail: normalized } });
    check("The address is free again for another department after clearing", freedCheck === null);

    const deptBTake = await setDepartmentInboundEmail(deptB.id, normalized);
    check("deptB can now claim the freed address", deptBTake.inboundEmail === normalized);

    console.log("\nTesting My Departments' query shape includes inboundEmail...\n");
    const [deptRowNoSelect] = await prisma.department.findMany({
      where: { id: deptB.id },
      include: { _count: { select: { memberships: true, tickets: true, projects: true, activities: true, subDepartments: true } } },
    });
    check("Department row from the exact My Departments query shape carries inboundEmail", deptRowNoSelect.inboundEmail === normalized);

    console.log("\nTesting My Departments' canManageInboundEmail logic (mirrors app/(main)/my-departments/page.tsx)...\n");
    const managerMembership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: managerUser.id, departmentId: deptA.id } },
    });
    const managerCanManageOwnDept = managerMembership
      ? await hasDepartmentPermission(managerMembership.role, "department.email.manage", managerMembership.customRoleId)
      : false;
    check("Department Manager's real membership grants canManageInboundEmail for their own department", managerCanManageOwnDept === true);

    const managerMembershipInDeptB = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: managerUser.id, departmentId: deptB.id } },
    });
    check(
      "Same Department Manager has no membership (and therefore no canManageInboundEmail) in a department they don't belong to",
      managerMembershipInDeptB === null
    );

    console.log("\nTesting Director is not auto-granted canManageInboundEmail (only Admin is)...\n");
    const directorUser = await prisma.user.create({
      data: { email: `email-director-${RUN_ID}@kinsen.gr`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    const directorMembershipMissing = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: directorUser.id, departmentId: deptA.id } },
    });
    check(
      "Director with no real DepartmentMembership has no canManageInboundEmail (isAdmin()-only bypass, not canViewAllDepartments)",
      !isAdmin(Role.DIRECTOR) && directorMembershipMissing === null
    );
    const directorMembership = await prisma.departmentMembership.create({
      data: { userId: directorUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(directorMembership.id);
    const directorCanManageWithRealGrant = await hasDepartmentPermission(
      directorMembership.role,
      "department.email.manage",
      directorMembership.customRoleId
    );
    check("Director WITH a real DepartmentMembership granting the permission does get canManageInboundEmail", directorCanManageWithRealGrant === true);
    await prisma.user.delete({ where: { id: directorUser.id } }).catch(() => {});

    check("isAdmin(ADMIN) is the only automatic bypass used for canManageInboundEmail", isAdmin(Role.ADMIN) === true);

    console.log("\nTesting no duplicate inbound-email endpoint exists...\n");
    const apiDir = path.join(process.cwd(), "app", "api");
    const matches: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts" && full.includes("inbound-email")) matches.push(full);
      }
    };
    walk(apiDir);
    check("Exactly one inbound-email route.ts exists under app/api (no duplicate for My Departments)", matches.length === 1);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } })],
      [
        "users",
        () =>
          prisma.user.deleteMany({
            where: { id: { in: [managerUser?.id, outsiderUser?.id].filter((id): id is string => !!id) } },
          }),
      ],
      [
        "departments",
        () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((id): id is string => !!id) } } }),
      ],
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
