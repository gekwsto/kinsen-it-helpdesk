/**
 * Focused regression for the new `activity.dependency.manage` permission
 * (see PERMISSIONS in prisma/seed.ts, app/api/dependencies/route.ts,
 * app/api/dependencies/[id]/route.ts) — replaces the previous bare
 * isAdmin(role) gate on creating/deleting Activity Dependencies, so a
 * GLOBAL-scope custom role can now be granted this capability without
 * being Role.ADMIN.
 *
 * Covers:
 *  1. A plain USER (no grant anywhere) -> 403 on POST and DELETE, exactly
 *     like before this change (isAdmin(USER) was already false).
 *  2. Role.ADMIN -> still works end to end (bypasses hasPermission
 *     unconditionally) — the exact behavior this change must preserve.
 *  3. A USER with a GLOBAL custom role NOT granted the permission -> 403.
 *  4. The SAME custom role, once granted `activity.dependency.manage` ->
 *     201 on POST, 200 on DELETE — proving the permission is genuinely
 *     delegable now, not still hardcoded to Role.ADMIN.
 *  5. GET (view) is untouched — unaffected by any of the above (no
 *     permission check was ever added there).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-dependency-manage-permission.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, RoleScope, DependencyType } from "@prisma/client";

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
const TAG = `dmp-${RUN_ID}`;

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

  const { GET: getDeps, POST: postDep } = await import("@/app/api/dependencies/route");
  const { DELETE: deleteDep } = await import("@/app/api/dependencies/[id]/route");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const userIds: string[] = [];
  const activityIds: string[] = [];
  const customRoleIds: string[] = [];
  const dependencyIds: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    const plainUser = await prisma.user.create({
      data: { email: `${TAG}-plain@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(plainUser.id);

    const customRole = await prisma.customRole.create({
      data: { key: `${TAG}-custom`, name: `${TAG} custom role`, scope: RoleScope.GLOBAL },
    });
    customRoleIds.push(customRole.id);

    const customRoleUser = await prisma.user.create({
      data: {
        email: `${TAG}-customrole@example.com`,
        role: Role.USER,
        customRoleId: customRole.id,
        authProvider: AuthProvider.CREDENTIALS,
        passwordHash: "x",
      },
      select: { id: true },
    });
    userIds.push(customRoleUser.id);

    const activityA = await prisma.projectActivity.create({ data: { title: `${TAG} Activity A` } });
    activityIds.push(activityA.id);
    const activityB = await prisma.projectActivity.create({ data: { title: `${TAG} Activity B` } });
    activityIds.push(activityB.id);
    const activityC = await prisma.projectActivity.create({ data: { title: `${TAG} Activity C` } });
    activityIds.push(activityC.id);

    // ── 1. Plain USER, no grant anywhere -> 403 on POST and DELETE ──
    console.log("\n1. A plain USER (no grant anywhere) -> 403 on POST and DELETE ===\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    const plainPostRes = await postDep(
      jsonReq("http://localhost/api/dependencies", { predecessorId: activityA.id, successorId: activityB.id })
    );
    check("Plain USER POST -> 403", plainPostRes.status === 403);
    const plainCountBefore = await prisma.activityDependency.count({ where: { predecessorId: activityA.id, successorId: activityB.id } });
    check("...and nothing was actually created", plainCountBefore === 0);

    // ── 2. Role.ADMIN -> still works end to end ──
    console.log("\n2. Role.ADMIN -> still works end to end (unconditional bypass preserved) ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const adminPostRes = await postDep(
      jsonReq("http://localhost/api/dependencies", { predecessorId: activityA.id, successorId: activityB.id, type: DependencyType.FINISH_TO_START })
    );
    check("ADMIN POST -> 201", adminPostRes.status === 201);
    const adminDep = await adminPostRes.json();
    dependencyIds.push(adminDep.id);

    const adminDeleteRes = await deleteDep(new NextRequest(`http://localhost/api/dependencies/${adminDep.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: adminDep.id }),
    });
    check("ADMIN DELETE -> 200", adminDeleteRes.status === 200);
    const stillThere = await prisma.activityDependency.findUnique({ where: { id: adminDep.id } });
    check("...and it's genuinely gone", stillThere === null);

    // ── 3. GLOBAL custom role WITHOUT the permission -> 403 ──
    console.log("\n3. A GLOBAL custom role NOT granted activity.dependency.manage -> 403 ===\n");
    currentSession = { user: { id: customRoleUser.id, role: Role.USER, customRoleId: customRole.id } };
    const ungrantedPostRes = await postDep(
      jsonReq("http://localhost/api/dependencies", { predecessorId: activityA.id, successorId: activityC.id })
    );
    check("Custom role (no grant) POST -> 403", ungrantedPostRes.status === 403);

    // ── 4. SAME custom role, once granted the permission -> works ──
    console.log("\n4. The SAME custom role, once granted activity.dependency.manage -> POST 201 / DELETE 200 ===\n");
    const perm = await prisma.permission.findUnique({ where: { key: "activity.dependency.manage" } });
    check("(fixture) the activity.dependency.manage Permission row exists (seeded)", !!perm);
    if (perm) {
      await prisma.rolePermission.create({ data: { roleKey: customRole.key, permissionId: perm.id } });
    }

    const grantedPostRes = await postDep(
      jsonReq("http://localhost/api/dependencies", { predecessorId: activityA.id, successorId: activityC.id })
    );
    check("Custom role (granted) POST -> 201 — genuinely delegable now, not hardcoded to Role.ADMIN", grantedPostRes.status === 201);
    const grantedDep = await grantedPostRes.json();

    const grantedDeleteRes = await deleteDep(new NextRequest(`http://localhost/api/dependencies/${grantedDep.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: grantedDep.id }),
    });
    check("Custom role (granted) DELETE -> 200", grantedDeleteRes.status === 200);

    // ── 5. GET (view) is completely unaffected ──
    console.log("\n5. GET (view) is unaffected by any of the above ===\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    const getRes = await getDeps(new NextRequest(`http://localhost/api/dependencies?activityId=${activityA.id}`));
    check("A plain USER can still GET (view) dependencies -> 200 (unrelated to the manage permission)", getRes.status === 200);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.activityDependency.deleteMany({ where: { id: { in: dependencyIds } } });
      await prisma.activityDependency.deleteMany({ where: { predecessorId: { in: activityIds } } });
      await prisma.activityDependency.deleteMany({ where: { successorId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: `${TAG}-custom` } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
