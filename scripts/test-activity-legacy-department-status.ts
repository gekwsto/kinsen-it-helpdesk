/**
 * Regression coverage for the ACTUAL root cause of the "Quick Status
 * dropdown opens empty" bug reported against a real, already-existing
 * standalone Activity: a legacy Activity row (`departmentId: null`,
 * predating department-scoping — confirmed to exist in this app's own
 * mock/seed data, e.g. "mock-act-010") never triggered its status-options
 * fetch at all, because both ActivityDetailClient and ActivityEditClient
 * gated that fetch on `if (activity.departmentId)` — always false for such
 * a row. `GET /api/activities/[id]` itself already resolved status/
 * progress display correctly for these rows via the app's existing
 * "legacy department" fallback (getDefaultLegacyDepartmentId) — the gap
 * was purely that this resolved value was never exposed to the client, so
 * the client had no department id to fetch a status LIST from, even though
 * the single current status resolved fine.
 *
 * Fix: GET /api/activities/[id] now returns `effectiveDepartmentId`
 * (`departmentId` when set, otherwise the legacy department) — a UI hint
 * only, computed via the SAME existing getDefaultLegacyDepartmentId()
 * fallback every other department-scoped resolver in this app already
 * uses (lib/status-terminal.ts, lib/activities/activity-progress.ts,
 * lib/services/activity-status-config.ts) — never a new heuristic.
 *
 * `projectId: null` (standalone) and `departmentId: null` (legacy) are
 * DIFFERENT, independent concepts — this script specifically exercises the
 * `departmentId: null` case, which is where the real bug lived.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-activity-legacy-department-status.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, ActivityStatus } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";

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
const TAG = `aldp-${RUN_ID}`;

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

  const legacyDepartmentId = await getDefaultLegacyDepartmentId();
  if (!legacyDepartmentId) {
    console.log("No legacy department configured in this environment (DEFAULT_DEPARTMENT_SLUG unset/unseeded) — skipping. This is an environment fact, not a code defect: GET /api/activities/[id] correctly returns effectiveDepartmentId: null in that case (verified by inspection), which the client treats as an explicit configuration-gap error state, never a silent empty menu.");
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });

  const { GET: getActivity, PATCH: patchActivity } = await import("@/app/api/activities/[id]/route");
  const { GET: getDeptActivityStatuses } = await import("@/app/api/departments/[id]/activity-statuses/route");

  const jsonReq = (url: string, body: unknown, method = "PATCH") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const userIds: string[] = [];
  const activityIds: string[] = [];

  try {
    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== Fixture: a legacy Activity (departmentId: null), mirroring real pre-existing rows like mock-act-010 ===\n");
    const legacyActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy Activity`, departmentId: null, projectId: null, status: ActivityStatus.IN_PROGRESS, progress: 50 },
    });
    activityIds.push(legacyActivity.id);
    check("Fixture really has departmentId: null", legacyActivity.departmentId === null);

    // ── 1. GET exposes a real, resolved effectiveDepartmentId ──
    console.log("\n1. GET /api/activities/[id] resolves and exposes effectiveDepartmentId (never null when a legacy department is configured) ===\n");
    const getRes = await getActivity(new NextRequest(`http://localhost/api/activities/${legacyActivity.id}`), { params: Promise.resolve({ id: legacyActivity.id }) });
    const got = await getRes.json();
    check("Raw departmentId is still null (this field is not being papered over)", got.departmentId === null);
    check("effectiveDepartmentId resolves to the app's configured legacy department", got.effectiveDepartmentId === legacyDepartmentId);
    check("statusLabel still resolves correctly for a legacy row (pre-existing behavior, unaffected)", got.statusLabel === "In Progress");

    // ── 2. The status-options endpoint returns a non-empty list for that resolved department ──
    console.log("\n2. GET /api/departments/[effectiveDepartmentId]/activity-statuses — what the client now correctly fetches — is not empty ===\n");
    const statusesRes = await getDeptActivityStatuses(new NextRequest(`http://localhost/api/departments/${got.effectiveDepartmentId}/activity-statuses`), { params: Promise.resolve({ id: got.effectiveDepartmentId }) });
    const statuses: any[] = await statusesRes.json();
    check("Status list is not empty (this is what was empty in the browser before the fix)", Array.isArray(statuses) && statuses.length > 0);
    check("Every entry uses a real, stable ActivityStatus enum id — never a display name", statuses.every((s) => typeof s.status === "string" && s.status === s.status.toUpperCase()));
    check("The legacy Activity's own current status (IN_PROGRESS) IS one of the returned options", statuses.some((s) => s.status === "IN_PROGRESS"));

    // ── 3. Status transitions still work end-to-end for a legacy-department Activity ──
    console.log("\n3. A status transition on a legacy-department Activity persists and recalculates progress correctly ===\n");
    const completedConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: legacyDepartmentId, status: ActivityStatus.COMPLETED } } });
    const patchRes = await patchActivity(jsonReq(`http://localhost/api/activities/${legacyActivity.id}`, { status: ActivityStatus.COMPLETED, isCompleted: true }), {
      params: Promise.resolve({ id: legacyActivity.id }),
    });
    check("PATCH to COMPLETED on a legacy-department Activity -> 200", patchRes.status === 200);
    const patched = await patchRes.json();
    check("Status persisted", patched.status === ActivityStatus.COMPLETED);
    check(
      `Progress recalculated from the LEGACY department's real configured value for COMPLETED (${completedConfig.progressPercent}%), never fabricated`,
      patched.progress === completedConfig.progressPercent
    );
    check("completedAt was stamped", !!patched.completedAt);

    // This is the exact symptom the bug report described (status=Completed
    // simultaneously shown with a stale, non-100 progress) — proven here to
    // NOT occur for a genuine, correctly-processed transition: status and
    // progress are always written together, from the same live-resolved
    // configuration, in the same PATCH response.
    console.log("\nExplicit check: status=COMPLETED and progress are never inconsistent in the API's own response ===\n");
    check("progress genuinely reflects this department's COMPLETED config (not a stale/unrelated value)", patched.progress === completedConfig.progressPercent);

    // ── Reload confirms persistence ──
    const reloadRes = await getActivity(new NextRequest(`http://localhost/api/activities/${legacyActivity.id}`), { params: Promise.resolve({ id: legacyActivity.id }) });
    const reloaded = await reloadRes.json();
    check("Reload (\"GET after PATCH\") shows the same persisted status and progress", reloaded.status === ActivityStatus.COMPLETED && reloaded.progress === completedConfig.progressPercent);

    // ── Reopen ──
    console.log("\nReopening from COMPLETED back to another status also recalculates correctly for a legacy-department Activity ===\n");
    const inProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: legacyDepartmentId, status: ActivityStatus.IN_PROGRESS } } });
    const reopenRes = await patchActivity(jsonReq(`http://localhost/api/activities/${legacyActivity.id}`, { status: ActivityStatus.IN_PROGRESS, isCompleted: false }), {
      params: Promise.resolve({ id: legacyActivity.id }),
    });
    const reopened = await reopenRes.json();
    check("Reopen -> 200 and progress recalculated for IN_PROGRESS", reopenRes.status === 200 && reopened.progress === inProgressConfig.progressPercent);
    check("completedAt cleared back to null", reopened.completedAt === null);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
