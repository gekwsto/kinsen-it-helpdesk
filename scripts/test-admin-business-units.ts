/**
 * End-to-end authz + behavior verification for /api/admin/business-units —
 * exercises the real route handlers (not just hasPermission() in isolation)
 * with a mocked @/lib/auth session, same technique as
 * scripts/test-integration-admin-authz.ts. Covers: 401/403 gating,
 * create/edit happy paths, invalid-companyId rejection, and the
 * dependents-check blocking deletion (never a destructive cascade).
 *
 * Must run with --experimental-test-module-mocks (module mocking is an
 * experimental Node API as of Node 24).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-admin-business-units.ts
 */
import { mock } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope } from "@prisma/client";
import { normalizeCompanyName } from "@/lib/services/organization-normalization";

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

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const businessUnitIds: string[] = [];
  const departmentIds: string[] = [];
  const customRoleIds: string[] = [];

  try {
    const plainUser = await prisma.user.create({ data: { email: `bu-plain-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(plainUser.id);

    const grantedRole = await prisma.customRole.create({
      data: { key: `bu-test-granted-${RUN_ID}`, name: `Business Units Test Granted ${RUN_ID}`, scope: RoleScope.GLOBAL },
    });
    customRoleIds.push(grantedRole.id);
    const [createPerm, updatePerm, deletePerm] = await Promise.all([
      prisma.permission.findUnique({ where: { key: "businessUnit.create" } }),
      prisma.permission.findUnique({ where: { key: "businessUnit.update" } }),
      prisma.permission.findUnique({ where: { key: "businessUnit.delete" } }),
    ]);
    if (!createPerm || !updatePerm || !deletePerm) throw new Error("businessUnit.* permission rows are missing — run the seed first.");
    await prisma.rolePermission.createMany({
      data: [createPerm, updatePerm, deletePerm].map((p) => ({ roleKey: grantedRole.key, permissionId: p.id })),
    });
    const grantedUser = await prisma.user.create({ data: { email: `bu-granted-${RUN_ID}@example.com`, role: Role.USER, customRoleId: grantedRole.id } });
    userIds.push(grantedUser.id);

    const companyA = await prisma.company.create({ data: { name: `BU Test Company A ${RUN_ID}`, domain: `bu-test-a-${RUN_ID}.example.com`, normalizedName: normalizeCompanyName(`BU Test Company A ${RUN_ID}`) } });
    companyIds.push(companyA.id);
    const companyB = await prisma.company.create({ data: { name: `BU Test Company B ${RUN_ID}`, domain: `bu-test-b-${RUN_ID}.example.com`, normalizedName: normalizeCompanyName(`BU Test Company B ${RUN_ID}`) } });
    companyIds.push(companyB.id);

    const seedBu = await prisma.businessUnit.create({ data: { name: `BU Seed ${RUN_ID}`, companyId: companyA.id } });
    businessUnitIds.push(seedBu.id);

    const { GET: listGET, POST: createPOST } = await import("@/app/api/admin/business-units/route");
    const { PATCH: editPATCH, DELETE: deleteDELETE } = await import("@/app/api/admin/business-units/[id]/route");

    const jsonReq = (body: unknown) =>
      new NextRequest("http://localhost/api/admin/business-units", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // ── Unauthenticated ──────────────────────────────────────────────────
    console.log("\nUnauthenticated (no session)...\n");
    currentSession = null;
    check("GET list -> 401", (await listGET()).status === 401);
    check("POST create -> 401", (await createPOST(jsonReq({ name: "x", companyId: companyA.id }))).status === 401);
    check("PATCH edit -> 401", (await editPATCH(jsonReq({ name: "x" }), { params: Promise.resolve({ id: seedBu.id }) })).status === 401);
    check("DELETE -> 401", (await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedBu.id }) })).status === 401);

    // ── Plain USER, no businessUnit.* permission ────────────────────────
    console.log("\nAuthenticated as a plain USER (no businessUnit.* permission)...\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    check("GET list -> 403", (await listGET()).status === 403);
    check("POST create -> 403", (await createPOST(jsonReq({ name: `Should Never Exist ${RUN_ID}`, companyId: companyA.id }))).status === 403);
    check("PATCH edit -> 403", (await editPATCH(jsonReq({ name: "Renamed" }), { params: Promise.resolve({ id: seedBu.id }) })).status === 403);
    check("DELETE -> 403", (await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedBu.id }) })).status === 403);

    const afterDenied = await prisma.businessUnit.count({ where: { name: `Should Never Exist ${RUN_ID}` } });
    check("No business unit was created by any denied attempt", afterDenied === 0);

    // ── Granted custom role ──────────────────────────────────────────────
    console.log("\nAuthenticated via a custom role WITH businessUnit.* granted...\n");
    currentSession = { user: { id: grantedUser.id, role: Role.USER, customRoleId: grantedRole.id } };

    let res: NextResponse<any> = await listGET();
    check("Granted role GET list -> 200", res.status === 200);
    const listBody = await res.json();
    check("List includes the seed business unit with company + counts", listBody.some((b: any) => b.id === seedBu.id && b.company?.id === companyA.id && "_count" in b));

    res = await createPOST(jsonReq({ name: `BU Created ${RUN_ID}`, companyId: companyA.id }));
    check("Create -> 201", res.status === 201);
    const created = await res.json();
    businessUnitIds.push(created.id);
    check("Created business unit has zero dependents", Object.values(created._count).every((n) => n === 0));

    // Invalid companyId.
    res = await createPOST(jsonReq({ name: `BU Invalid Company ${RUN_ID}`, companyId: "nonexistent-company-id" }));
    check("Invalid companyId on create -> 400", res.status === 400);
    const invalidBody = await res.json();
    check("Invalid companyId error names the companyId field", JSON.stringify(invalidBody).includes("companyId"));

    // Invalid payload (missing required field).
    res = await createPOST(jsonReq({ companyId: companyA.id }));
    check("Missing name on create -> 422", res.status === 422);

    // Legitimate edit — rename and move to a different company.
    res = await editPATCH(jsonReq({ name: `BU Renamed ${RUN_ID}`, companyId: companyB.id }), { params: Promise.resolve({ id: created.id }) });
    check("Legitimate edit (rename + move company) -> 200", res.status === 200);
    const editedBody = await res.json();
    check("Edit persisted the new name", editedBody.name === `BU Renamed ${RUN_ID}`);
    check("Edit persisted the new company", editedBody.company?.id === companyB.id);

    // Edit with invalid companyId.
    res = await editPATCH(jsonReq({ companyId: "nonexistent-company-id" }), { params: Promise.resolve({ id: created.id }) });
    check("Invalid companyId on edit -> 400", res.status === 400);

    // ── Dependents-check blocks deletion (never a destructive cascade) ──
    console.log("\nDependents-check-before-delete...\n");
    const dept = await prisma.department.create({ data: { name: `BU Test Dept ${RUN_ID}`, slug: `bu-test-dept-${RUN_ID}`, businessUnitId: seedBu.id } });
    departmentIds.push(dept.id);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedBu.id }) });
    check("Delete blocked by dependent department -> 409", res.status === 409);
    const stillExists = await prisma.businessUnit.findUnique({ where: { id: seedBu.id } });
    check("Business unit was NOT deleted (no cascade)", stillExists !== null);
    const deptStillExists = await prisma.department.findUnique({ where: { id: dept.id } });
    check("Dependent department was NOT touched/orphaned", deptStillExists !== null && deptStillExists.businessUnitId === seedBu.id);

    await prisma.department.delete({ where: { id: dept.id } });
    departmentIds.splice(departmentIds.indexOf(dept.id), 1);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: created.id }) });
    check("Delete succeeds once dependents are gone -> 204", res.status === 204);
    businessUnitIds.splice(businessUnitIds.indexOf(created.id), 1);
    const goneNow = await prisma.businessUnit.findUnique({ where: { id: created.id } });
    check("Business unit row is actually gone", goneNow === null);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: "nonexistent-id" }) });
    check("Delete of a nonexistent id -> 404", res.status === 404);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.businessUnit.deleteMany({ where: { id: { in: businessUnitIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleIds.length ? [`bu-test-granted-${RUN_ID}`] : [] } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
