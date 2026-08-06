/**
 * End-to-end authz + behavior verification for /api/admin/companies —
 * exercises the real route handlers (not just hasPermission() in isolation)
 * with a mocked @/lib/auth session, same technique as
 * scripts/test-integration-admin-authz.ts. Covers: 401/403 gating,
 * create/edit happy paths, domain-uniqueness conflicts on create and edit,
 * and the dependents-check blocking deletion (never a destructive cascade).
 *
 * Must run with --experimental-test-module-mocks (module mocking is an
 * experimental Node API as of Node 24).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-admin-companies.ts
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
  const customRoleIds: string[] = [];

  try {
    const plainUser = await prisma.user.create({ data: { email: `companies-plain-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(plainUser.id);

    const grantedRole = await prisma.customRole.create({
      data: { key: `companies-test-granted-${RUN_ID}`, name: `Companies Test Granted ${RUN_ID}`, scope: RoleScope.GLOBAL },
    });
    customRoleIds.push(grantedRole.id);
    const [createPerm, updatePerm, deletePerm] = await Promise.all([
      prisma.permission.findUnique({ where: { key: "company.create" } }),
      prisma.permission.findUnique({ where: { key: "company.update" } }),
      prisma.permission.findUnique({ where: { key: "company.delete" } }),
    ]);
    if (!createPerm || !updatePerm || !deletePerm) throw new Error("company.* permission rows are missing — run the seed first.");
    await prisma.rolePermission.createMany({
      data: [createPerm, updatePerm, deletePerm].map((p) => ({ roleKey: grantedRole.key, permissionId: p.id })),
    });
    const grantedUser = await prisma.user.create({ data: { email: `companies-granted-${RUN_ID}@example.com`, role: Role.USER, customRoleId: grantedRole.id } });
    userIds.push(grantedUser.id);

    const seedCompany = await prisma.company.create({ data: { name: `Companies Seed ${RUN_ID}`, domain: `companies-seed-${RUN_ID}.example.com` } });
    companyIds.push(seedCompany.id);

    const { GET: listGET, POST: createPOST } = await import("@/app/api/admin/companies/route");
    const { PATCH: editPATCH, DELETE: deleteDELETE } = await import("@/app/api/admin/companies/[id]/route");

    const jsonReq = (body: unknown, url = "http://localhost/api/admin/companies") =>
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    // ── Unauthenticated ──────────────────────────────────────────────────
    console.log("\nUnauthenticated (no session)...\n");
    currentSession = null;
    check("GET list -> 401", (await listGET()).status === 401);
    check("POST create -> 401", (await createPOST(jsonReq({ name: "x", domain: "x.com" }))).status === 401);
    check("PATCH edit -> 401", (await editPATCH(jsonReq({ name: "x" }), { params: Promise.resolve({ id: seedCompany.id }) })).status === 401);
    check("DELETE -> 401", (await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedCompany.id }) })).status === 401);

    // ── Plain USER, no company.* permission ─────────────────────────────
    console.log("\nAuthenticated as a plain USER (no company.* permission)...\n");
    currentSession = { user: { id: plainUser.id, role: Role.USER, customRoleId: null } };
    check("GET list -> 403", (await listGET()).status === 403);
    check("POST create -> 403", (await createPOST(jsonReq({ name: `Should Never Exist ${RUN_ID}`, domain: `never-${RUN_ID}.example.com` }))).status === 403);
    check("PATCH edit -> 403", (await editPATCH(jsonReq({ name: "Renamed" }), { params: Promise.resolve({ id: seedCompany.id }) })).status === 403);
    check("DELETE -> 403", (await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedCompany.id }) })).status === 403);

    const afterDenied = await prisma.company.count({ where: { domain: `never-${RUN_ID}.example.com` } });
    check("No company was created by any denied attempt", afterDenied === 0);
    const seedUntouched = await prisma.company.findUnique({ where: { id: seedCompany.id } });
    check("Seed company untouched by denied PATCH", seedUntouched?.name === `Companies Seed ${RUN_ID}`);

    // ── Granted custom role ──────────────────────────────────────────────
    console.log("\nAuthenticated via a custom role WITH company.* granted...\n");
    currentSession = { user: { id: grantedUser.id, role: Role.USER, customRoleId: grantedRole.id } };

    let res: NextResponse<any> = await listGET();
    check("Granted role GET list -> 200", res.status === 200);
    const listBody = await res.json();
    check("List includes the seed company with counts", listBody.some((c: any) => c.id === seedCompany.id && "_count" in c));

    res = await createPOST(jsonReq({ name: `Companies Created ${RUN_ID}`, domain: `companies-created-${RUN_ID}.example.com` }));
    check("Create -> 201", res.status === 201);
    const created = await res.json();
    companyIds.push(created.id);
    check("Created company has zero dependents in its counts", created._count.businessUnits === 0 && created._count.users === 0);

    // Domain uniqueness on create.
    res = await createPOST(jsonReq({ name: `Companies Dup ${RUN_ID}`, domain: seedCompany.domain }));
    check("Duplicate domain on create -> 409", res.status === 409);
    const dupBody = await res.json();
    check("Duplicate domain error names the domain field", dupBody.field === "domain" || dupBody.error?.field === "domain" || JSON.stringify(dupBody).includes("domain"));

    // Invalid payload.
    res = await createPOST(jsonReq({ name: "x", domain: "not a domain" }));
    check("Invalid domain format on create -> 422", res.status === 422);

    // Legitimate edit.
    res = await editPATCH(jsonReq({ name: `Companies Renamed ${RUN_ID}` }), { params: Promise.resolve({ id: created.id }) });
    check("Legitimate edit -> 200", res.status === 200);
    const editedBody = await res.json();
    check("Edit persisted the new name", editedBody.name === `Companies Renamed ${RUN_ID}`);

    // Domain uniqueness on edit (against the seed company's domain).
    res = await editPATCH(jsonReq({ domain: seedCompany.domain }), { params: Promise.resolve({ id: created.id }) });
    check("Duplicate domain on edit -> 409", res.status === 409);

    // Editing a company's own unchanged domain should NOT conflict with itself.
    res = await editPATCH(jsonReq({ domain: created.domain }), { params: Promise.resolve({ id: created.id }) });
    check("Editing to its own current domain is not a conflict -> 200", res.status === 200);

    // ── Dependents-check blocks deletion (never a destructive cascade) ──
    console.log("\nDependents-check-before-delete...\n");
    const bu = await prisma.businessUnit.create({ data: { name: `Companies Test BU ${RUN_ID}`, companyId: seedCompany.id } });
    businessUnitIds.push(bu.id);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: seedCompany.id }) });
    check("Delete blocked by dependent business unit -> 409", res.status === 409);
    const stillExists = await prisma.company.findUnique({ where: { id: seedCompany.id } });
    check("Company was NOT deleted (no cascade)", stillExists !== null);
    const buStillExists = await prisma.businessUnit.findUnique({ where: { id: bu.id } });
    check("Dependent business unit was NOT touched/orphaned", buStillExists !== null);

    await prisma.businessUnit.delete({ where: { id: bu.id } });
    businessUnitIds.splice(businessUnitIds.indexOf(bu.id), 1);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: created.id }) });
    check("Delete succeeds once dependents are gone -> 204", res.status === 204);
    companyIds.splice(companyIds.indexOf(created.id), 1);
    const goneNow = await prisma.company.findUnique({ where: { id: created.id } });
    check("Company row is actually gone", goneNow === null);

    res = await deleteDELETE(new NextRequest("http://localhost"), { params: Promise.resolve({ id: "nonexistent-id" }) });
    check("Delete of a nonexistent id -> 404", res.status === 404);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.businessUnit.deleteMany({ where: { id: { in: businessUnitIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleIds.length ? [`companies-test-granted-${RUN_ID}`] : [] } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
