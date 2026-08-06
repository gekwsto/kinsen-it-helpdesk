/**
 * Login flow — production correction pass. Proves the CORRECTED contract:
 * `handleMicrosoftJwtSignIn` (lib/services/microsoft-department-sync-service.ts)
 * never makes an application-token `GET /users/{id}/manager` call (or ANY
 * `/manager`/`directReports` call at all) during sign-in — an earlier
 * version of this code bounded such a call to 5 seconds on every login,
 * which would have added real latency (and failed outright against a real
 * tenant, since Application permissions aren't supported on that endpoint
 * at all). `managerId` is read from the local, already-synchronized
 * organization snapshot wherever it's needed (GET /api/organization/me),
 * never fetched live at sign-in time — staleness is surfaced via
 * `syncStatus`, computed purely from local `organizationSyncedAt`/
 * `managerId`, never triggering a Graph call itself.
 *
 * Usage: npx tsx scripts/test-organization-login-integration.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-not-used-directly-by-this-script";

import { prisma } from "@/lib/prisma";
import { AuthProvider } from "@prisma/client";
import { handleMicrosoftJwtSignIn } from "@/lib/services/microsoft-department-sync-service";
import { getOrganizationContext } from "@/lib/services/organization-tree-service";

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
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Records every URL fetched during a login simulation and answers every
 * request with a harmless, generic success — the point of this mock is to
 * observe WHICH endpoints get called, not to exercise their real response
 * shapes (those are already covered by test-microsoft-first-login-sync.ts /
 * test-microsoft-profile-photo-sync.ts).
 */
function installObservingMock(calledUrls: string[]) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    calledUrls.push(url);
    if (url.includes("/photos/")) return jsonResponse(404, {}); // no photo — valid, expected state
    if (url.includes("/me")) {
      return jsonResponse(200, { id: "mock-oid", displayName: "Mock User", mail: "mock@x.com", userPrincipalName: "mock@x.com", department: null, jobTitle: null });
    }
    return jsonResponse(200, {});
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  const userIds: string[] = [];
  try {
    console.log("\nLogin performs NO app-only manager/directReports call — oid-based identification...\n");
    const oid = `login-test-oid-${RUN_ID}`;
    const dbUser = await prisma.user.create({
      data: {
        email: `orgtest-login-${RUN_ID}@kinsen.gr`,
        authProvider: AuthProvider.CREDENTIALS, // pre-existing local account — exercises the "existing local user, first Microsoft login" linking path
        role: "USER",
      },
    });
    userIds.push(dbUser.id);

    const calledUrls: string[] = [];
    installObservingMock(calledUrls);

    const startedAt = Date.now();
    const refreshed = await handleMicrosoftJwtSignIn({
      dbUser: {
        id: dbUser.id,
        role: dbUser.role,
        isActive: dbUser.isActive,
        mustChangePassword: dbUser.mustChangePassword,
        departmentId: dbUser.departmentId,
        businessUnitId: dbUser.businessUnitId,
        customRoleId: dbUser.customRoleId,
        microsoftUserId: dbUser.microsoftUserId,
        globalRoleSource: dbUser.globalRoleSource,
        name: dbUser.name,
        image: dbUser.image,
      },
      accessToken: "mock-delegated-access-token",
      oid,
      providerAccountId: oid,
      userEmail: dbUser.email,
      userName: "Mock User",
    });
    const elapsedMs = Date.now() - startedAt;

    const managerRelatedCalls = calledUrls.filter((u) => u.includes("/manager") || u.includes("directReports"));
    check("zero /manager or /directReports calls were made during login", managerRelatedCalls.length === 0);
    check("the sign-in identifies the user by the oid passed in (never by email lookup for Graph calls)", refreshed.microsoftUserId === oid);
    check(
      "login completes quickly — no multi-second blocking Graph call was added (bounded by the existing /me + photo calls only, both mocked instantly here)",
      elapsedMs < 4000
    );

    if (managerRelatedCalls.length > 0) {
      console.error("  Unexpected manager/directReports calls during login:", managerRelatedCalls);
    }

    console.log("\nStaleness is surfaced purely from local state, never by fetching Graph...\n");
    const context = await getOrganizationContext(dbUser.id);
    check("a never-organization-synced user's syncStatus is NEVER_SYNCED, computed with zero Graph calls", context?.syncStatus === "NEVER_SYNCED");
    check("managerId is simply null for this local-only user — no live lookup was attempted", context?.manager === null);

    console.log("\nLegacy email linking never produces a duplicate User row...\n");
    const usersWithThisEmail = await prisma.user.count({ where: { email: dbUser.email } });
    check("exactly one User row exists for this email after the Microsoft sign-in linked to it", usersWithThisEmail === 1);
    const usersWithThisOid = await prisma.user.count({ where: { microsoftUserId: oid } });
    check("exactly one User row is linked to this oid (no duplicate created by the sign-in)", usersWithThisOid === 1);
  } finally {
    restoreFetch();
    try {
      if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
