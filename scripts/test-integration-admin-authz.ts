/**
 * Independent verification that every admin integration route actually
 * enforces integration.manage — not just that the admin UI hides the nav
 * link. Uses Node's experimental module-mocking API to swap out @/lib/auth's
 * `auth()` for a controllable fake session, so real route handler functions
 * (not just the isolated hasPermission() function) are exercised end to end
 * with a genuine non-privileged account.
 *
 * Must run with --experimental-test-module-mocks (module mocking is an
 * experimental Node API as of Node 24).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-integration-admin-authz.ts
 */
import { mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope } from "@prisma/client";

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

// Mutable holder the mocked auth() reads from on every call, so a single
// mock.module registration can represent many different "logged in as X"
// scenarios across the test without re-registering the mock.
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

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const integrationIds: string[] = [];
  const customRoleIds: string[] = [];

  try {
    const dept = await prisma.department.create({ data: { name: `AuthZ Test Dept ${RUN_ID}`, slug: `authz-test-dept-${RUN_ID}` } });
    departmentIds.push(dept.id);

    const plainUser = await prisma.user.create({ data: { email: `authz-plain-user-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(plainUser.id);

    const itAgent = await prisma.user.create({ data: { email: `authz-it-agent-${RUN_ID}@example.com`, role: Role.IT_AGENT } });
    userIds.push(itAgent.id);

    // A custom role that's GLOBAL-scoped and genuinely granted
    // integration.manage — the positive-authorization case, proving the
    // gate is a real permission check (custom roles can be granted it),
    // not a hardcoded `role === "ADMIN"` check that would make the
    // permission key meaningless.
    const grantedRole = await prisma.customRole.create({
      data: { key: `authz-test-granted-${RUN_ID}`, name: `AuthZ Test Granted ${RUN_ID}`, scope: RoleScope.GLOBAL },
    });
    customRoleIds.push(grantedRole.id);
    const integrationManagePermission = await prisma.permission.findUnique({ where: { key: "integration.manage" } });
    if (!integrationManagePermission) throw new Error("integration.manage permission row is missing — run the seed first.");
    await prisma.rolePermission.create({ data: { roleKey: grantedRole.key, permissionId: integrationManagePermission.id } });
    const grantedUser = await prisma.user.create({ data: { email: `authz-granted-user-${RUN_ID}@example.com`, role: Role.USER, customRoleId: grantedRole.id } });
    userIds.push(grantedUser.id);

    const seedIntegration = await prisma.externalIntegration.create({
      data: { name: `AuthZ Seed Integration ${RUN_ID}`, slug: `authz-seed-integration-${RUN_ID}`, departmentId: dept.id, apiKeyPrefix: `tkint_authzseed${RUN_ID}`.slice(0, 18), apiKeyHash: "0".repeat(64) },
    });
    integrationIds.push(seedIntegration.id);

    const { GET: listGET, POST: createPOST } = await import("@/app/api/admin/integrations/route");
    const { PATCH: editPATCH } = await import("@/app/api/admin/integrations/[id]/route");
    const { POST: rotatePOST } = await import("@/app/api/admin/integrations/[id]/rotate/route");

    const jsonReq = (body: unknown) =>
      new NextRequest("http://localhost/api/admin/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // ── Unauthenticated ──────────────────────────────────────────────────
    console.log("\nUnauthenticated (no session at all)...\n");
    currentSession = null;
    check("GET list -> 401", (await listGET()).status === 401);
    check("POST create -> 401", (await createPOST(jsonReq({ name: "x", departmentId: dept.id }))).status === 401);
    check("PATCH edit -> 401", (await editPATCH(jsonReq({ name: "x" }), { params: Promise.resolve({ id: seedIntegration.id }) })).status === 401);
    check("POST rotate -> 401", (await rotatePOST(new Request("http://localhost"), { params: Promise.resolve({ id: seedIntegration.id }) })).status === 401);

    // ── Authenticated, but a plain USER with no integration.manage ──────
    console.log("\nAuthenticated as a plain USER (no integration.manage)...\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    let res: NextResponse<any> = await listGET();
    check("GET list -> 403", res.status === 403);
    res = await createPOST(jsonReq({ name: `Should Never Exist ${RUN_ID}`, departmentId: dept.id }));
    check("POST create -> 403", res.status === 403);
    res = await editPATCH(jsonReq({ name: "Renamed" }), { params: Promise.resolve({ id: seedIntegration.id }) });
    check("PATCH edit -> 403", res.status === 403);
    res = await rotatePOST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: seedIntegration.id }) });
    check("POST rotate -> 403", res.status === 403);

    // ── Authenticated as IT_AGENT (a real, non-trivial role, still no integration.manage) ──
    console.log("\nAuthenticated as IT_AGENT (no integration.manage)...\n");
    currentSession = { user: { id: itAgent.id, role: Role.IT_AGENT, customRoleId: null } };
    check("IT_AGENT GET list -> 403", (await listGET()).status === 403);
    check("IT_AGENT POST create -> 403", (await createPOST(jsonReq({ name: `x-${RUN_ID}`, departmentId: dept.id }))).status === 403);

    // Confirm the 403 attempts truly created nothing.
    const afterDeniedAttempts = await prisma.externalIntegration.count({ where: { departmentId: dept.id } });
    check("No integration was created by any of the denied attempts", afterDeniedAttempts === 1 /* just the seed */);

    // ── Authenticated via a custom role that IS granted integration.manage ──
    console.log("\nAuthenticated via a custom role WITH integration.manage granted...\n");
    currentSession = { user: { id: grantedUser.id, role: Role.USER, customRoleId: grantedRole.id } };
    res = await listGET();
    check("Granted custom role GET list -> 200", res.status === 200);
    const listBody = await res.json();
    check("List response never includes apiKeyHash", listBody.every((i: any) => !("apiKeyHash" in i)));
    check("List response includes only the apiKeyPrefix, not a raw key", listBody.every((i: any) => typeof i.apiKeyPrefix === "string" && !("apiKey" in i)));

    res = await createPOST(jsonReq({ name: `AuthZ Created By Granted Role ${RUN_ID}`, departmentId: dept.id }));
    check("Granted custom role POST create -> 201", res.status === 201);
    const createBody = await res.json();
    if (createBody?.integration?.id) integrationIds.push(createBody.integration.id);
    check("Create response includes a one-time raw apiKey", typeof createBody.apiKey === "string" && createBody.apiKey.startsWith("tkint_"));
    check("Create response's integration object never includes apiKeyHash", !("apiKeyHash" in (createBody.integration ?? {})));
    check("createdById on the new row is the authenticated user, never client-suppliable", createBody.integration.createdById === grantedUser.id);

    // ── Mass-assignment: department/category/priority cannot be smuggled beyond what's validated ──
    console.log("\nMass-assignment / field-injection attempts (still as the granted user)...\n");
    res = await createPOST(
      jsonReq({
        name: `AuthZ Mass Assignment Attempt ${RUN_ID}`,
        departmentId: dept.id,
        apiKeyHash: "attacker-supplied-hash",
        apiKeyPrefix: "tkint_attacker",
        createdById: plainUser.id,
        slug: "attacker-chosen-slug",
        isActive: false,
      } as any)
    );
    check("Unknown/forbidden fields (apiKeyHash/createdById/slug/isActive) on create -> 422 (schema is .strict())", res.status === 422);

    res = await editPATCH(jsonReq({ apiKeyHash: "attacker-hash", apiKeyPrefix: "tkint_attacker" } as any), { params: Promise.resolve({ id: seedIntegration.id }) });
    check("Unknown fields on edit -> 422 (schema is .strict())", res.status === 422);

    const untouchedSeed = await prisma.externalIntegration.findUnique({ where: { id: seedIntegration.id } });
    check("The seed integration's real apiKeyHash/apiKeyPrefix are untouched by the rejected edit attempt", untouchedSeed?.apiKeyHash === "0".repeat(64));

    // ── Edit response never returns a raw key ───────────────────────────
    console.log("\nEdit/rotate response contracts...\n");
    res = await editPATCH(jsonReq({ name: `Renamed Legitimately ${RUN_ID}` }), { params: Promise.resolve({ id: seedIntegration.id }) });
    check("Legitimate edit -> 200", res.status === 200);
    const editBody = await res.json();
    check("Edit response has no apiKeyHash field", !("apiKeyHash" in editBody));
    check("Edit response has no apiKey (raw key) field", !("apiKey" in editBody));

    res = await rotatePOST(new Request("http://localhost", { method: "POST" }), { params: Promise.resolve({ id: seedIntegration.id }) });
    check("Legitimate rotate -> 200", res.status === 200);
    const rotateBody = await res.json();
    check("Rotate response includes the one-time raw apiKey", typeof rotateBody.apiKey === "string" && rotateBody.apiKey.startsWith("tkint_"));
    check("Rotate response's integration object has no apiKeyHash", !("apiKeyHash" in (rotateBody.integration ?? {})));

    // ── No delete endpoint exists at all ────────────────────────────────
    console.log("\nNo delete endpoint...\n");
    const idRouteModule = await import("@/app/api/admin/integrations/[id]/route");
    check("app/api/admin/integrations/[id]/route.ts exports no DELETE handler", !("DELETE" in idRouteModule));
    const listRouteModule = await import("@/app/api/admin/integrations/route");
    check("app/api/admin/integrations/route.ts exports no DELETE handler", !("DELETE" in listRouteModule));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { integrationId: { in: integrationIds } } });
      await prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleIds.length ? [`authz-test-granted-${RUN_ID}`] : [] } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
