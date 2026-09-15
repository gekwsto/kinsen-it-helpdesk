/**
 * Regression coverage for the "cannot save a Department rename for a
 * direct-Company department" bug in
 * components/admin/department-settings-form.tsx.
 *
 * ROOT CAUSE: a department placed directly under a Company (no meaningful
 * Business Unit to nest under — always true for a Microsoft/Entra-sourced
 * department; see Department.companyId's schema comment) has
 * `businessUnitId: null`. The form normalized that to form state `""` via
 * `useState(department.businessUnitId ?? "")`, but then compared the LIVE
 * form state against the RAW, un-normalized `department.businessUnitId`
 * (`businessUnitId !== department.businessUnitId`, i.e. `"" !== null`) in
 * two places:
 *   1. The Save-disable rule (`canChangeBusinessUnit && !businessUnitId`)
 *      — permanently disabled Save for ANY direct-Company department, even
 *      for a pure name/slug/description edit that never touches placement.
 *   2. The PATCH body-construction condition — even if Save were somehow
 *      re-enabled, it would have submitted `businessUnitId: ""`, which
 *      updateDepartmentSchema's `.min(1)` correctly rejects with a 422.
 *
 * THE FIX: a single normalized `initialBusinessUnitId = department.businessUnitId
 * ?? ""`, diffed against consistently everywhere
 * (`businessUnitChanged`/`clearingExistingBusinessUnit`) — never the raw
 * `department.businessUnitId` again. `businessUnitId` is now only ever
 * included in the PATCH body when the Business Unit genuinely changed, and
 * Save is only blocked for the ONE genuinely invalid state (clearing an
 * EXISTING Business Unit back to empty), never for an untouched
 * direct-Company placement.
 *
 * No backend change was necessary — PATCH /api/admin/departments/[id] and
 * updateDepartment() (lib/services/department-service.ts) already correctly
 * support a name/slug/description-only update when businessUnitId is
 * omitted from the request, already reject businessUnitId: "" via
 * updateDepartmentSchema's `.min(1)`, and already leave companyId
 * completely untouched unless businessUnitId is both present AND non-null
 * (see updateDepartment's own companyId-clearing condition). This test
 * proves that existing backend behavior directly, plus the fixed form's
 * exact derived-state logic (mirrored here as pure functions, since this
 * codebase has no React-component-rendering test harness — every other
 * test script in this repo verifies UI logic this same way, against the
 * real backend route the component calls).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-department-settings-direct-company-rename.ts
 */
import { mock } from "node:test";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, RoleScope, DepartmentRole, MembershipSource } from "@prisma/client";
import { normalizeCompanyName, normalizeDepartmentName } from "@/lib/services/organization-normalization";
import { createDepartment } from "@/lib/services/department-service";

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

// ══════════════════════ Pure mirror of the FIXED form's derived state ══════════════════════
// Exactly the same formulas now in components/admin/department-settings-form.tsx —
// this codebase has no React-component-rendering test harness, so this is
// the same "mirror the exact logic, verify it against the real backend
// route" pattern scripts/test-ticket-project-activity-link.ts already
// established for this kind of client-side derived state.
function computeFormState(params: { departmentBusinessUnitId: string | null; canChangeBusinessUnit: boolean; selectedBusinessUnitId: string }) {
  const initialBusinessUnitId = params.departmentBusinessUnitId ?? "";
  const businessUnitId = params.selectedBusinessUnitId;
  const businessUnitChanged = businessUnitId !== initialBusinessUnitId;
  const clearingExistingBusinessUnit = params.canChangeBusinessUnit && initialBusinessUnitId !== "" && businessUnitId === "";
  const saveDisabledByBusinessUnit = clearingExistingBusinessUnit;
  const includeBusinessUnitIdInPatch = params.canChangeBusinessUnit && businessUnitChanged;
  return { businessUnitChanged, clearingExistingBusinessUnit, saveDisabledByBusinessUnit, includeBusinessUnitIdInPatch };
}

async function main() {
  // ══════════════════════ SECTION A — structural guard (no DB) ══════════════════════
  console.log("\n=== SECTION A — the form's fixed source uses a single normalized comparison, never the raw department.businessUnitId again ===\n");

  const formSrc = await fs.readFile(path.join(process.cwd(), "components/admin/department-settings-form.tsx"), "utf8");
  check("A1. The form computes a normalized initialBusinessUnitId once (department.businessUnitId ?? \"\")", /const initialBusinessUnitId = department\.businessUnitId \?\? ""/.test(formSrc));
  check("A2. businessUnitChanged is derived from the normalized value, not the raw department.businessUnitId", /const businessUnitChanged = businessUnitId !== initialBusinessUnitId/.test(formSrc));
  check("A3. The PATCH body only includes businessUnitId when businessUnitChanged is true", /if \(canChangeBusinessUnit && businessUnitChanged\)/.test(formSrc));
  check("A4. The Save-disable rule no longer uses the old blanket '!businessUnitId' condition", !/canChangeBusinessUnit && !businessUnitId\)/.test(formSrc));
  check("A5. There is a dedicated 'clearing an existing Business Unit' condition, distinct from 'no Business Unit selected at all'", /const clearingExistingBusinessUnit = canChangeBusinessUnit && initialBusinessUnitId !== "" && businessUnitId === ""/.test(formSrc));
  check("A6. The Save button's disabled prop uses clearingExistingBusinessUnit, not the old blanket rule", /disabled=\{saving \|\| !name\.trim\(\) \|\| !slug\.trim\(\) \|\| clearingExistingBusinessUnit\}/.test(formSrc));
  check("A7. No raw comparison against department.businessUnitId (the un-normalized value) survives anywhere in the derived-state logic", !/businessUnitId !== department\.businessUnitId/.test(formSrc));

  // ══════════════════════ SECTION B — pure logic (no DB): every Save-disable/payload scenario from the task ══════════════════════
  console.log("\n=== SECTION B — derived-state logic for every required scenario ===\n");

  // 1. Valid unchanged direct-Company placement (null -> normalized "") — SAVE ALLOWED, no businessUnitId in payload.
  const s1 = computeFormState({ departmentBusinessUnitId: null, canChangeBusinessUnit: true, selectedBusinessUnitId: "" });
  check("B1. Direct-Company department, untouched -> businessUnitChanged is false", s1.businessUnitChanged === false);
  check("B1. Direct-Company department, untouched -> Save is NOT disabled by the Business Unit rule", s1.saveDisabledByBusinessUnit === false);
  check("B1. Direct-Company department, untouched -> businessUnitId is NOT included in the PATCH body", s1.includeBusinessUnitIdInPatch === false);

  // 2. Actual attempt to clear an existing Business Unit (some-id -> "") — SAVE NOT ALLOWED.
  const s2 = computeFormState({ departmentBusinessUnitId: "bu-real-id", canChangeBusinessUnit: true, selectedBusinessUnitId: "" });
  check("B2. Existing Business Unit cleared to empty -> businessUnitChanged is true", s2.businessUnitChanged === true);
  check("B2. Existing Business Unit cleared to empty -> Save IS disabled", s2.saveDisabledByBusinessUnit === true);

  // 3. Actual selection of another Business Unit — existing move flow, Save allowed, businessUnitId included.
  const s3 = computeFormState({ departmentBusinessUnitId: "bu-old-id", canChangeBusinessUnit: true, selectedBusinessUnitId: "bu-new-id" });
  check("B3. Selecting a different Business Unit -> businessUnitChanged is true", s3.businessUnitChanged === true);
  check("B3. Selecting a different Business Unit -> Save is NOT disabled", s3.saveDisabledByBusinessUnit === false);
  check("B3. Selecting a different Business Unit -> businessUnitId IS included in the PATCH body", s3.includeBusinessUnitIdInPatch === true);

  // Same Business Unit re-submitted (idempotent no-op) — no payload field, no disable.
  const s4 = computeFormState({ departmentBusinessUnitId: "bu-real-id", canChangeBusinessUnit: true, selectedBusinessUnitId: "bu-real-id" });
  check("B4. Same Business Unit re-selected -> businessUnitChanged is false (no-op)", s4.businessUnitChanged === false);
  check("B4. Same Business Unit re-selected -> businessUnitId NOT included in the PATCH body", s4.includeBusinessUnitIdInPatch === false);

  // Department Admin (canChangeBusinessUnit: false) — the Business Unit field never renders, so it can never block Save or appear in the payload, regardless of the department's placement.
  const s5 = computeFormState({ departmentBusinessUnitId: null, canChangeBusinessUnit: false, selectedBusinessUnitId: "" });
  check("B5. Department Admin (canChangeBusinessUnit=false), direct-Company department -> Save never blocked by this rule", s5.saveDisabledByBusinessUnit === false);
  check("B5. Department Admin -> businessUnitId never included in the PATCH body", s5.includeBusinessUnitIdInPatch === false);

  // ══════════════════════ SECTION C — real DB + real PATCH route ══════════════════════
  console.log("\n=== SECTION C — real PATCH /api/admin/departments/[id] against a real direct-Company department ===\n");

  let PATCH: typeof import("@/app/api/admin/departments/[id]/route").PATCH;
  try {
    ({ PATCH } = await import("@/app/api/admin/departments/[id]/route"));
  } catch (err) {
    console.log("mock.module()-based route testing is unavailable in this environment — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping Section C.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const companyIds: string[] = [];
  const businessUnitIds: string[] = [];
  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];

  const jsonReq = (body: unknown) =>
    new NextRequest("http://localhost/api/admin/departments/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  try {
    const company = await prisma.company.create({
      data: { name: `Direct Co ${RUN_ID}`, domain: `direct-co-${RUN_ID}.example.com`, normalizedName: normalizeCompanyName(`Direct Co ${RUN_ID}`) },
    });
    companyIds.push(company.id);

    // ── 1/2. A valid direct-Company department: businessUnitId null, companyId set ──
    const dept = await createDepartment({ name: `Systems Operations ${RUN_ID}`, slug: `systems-ops-${RUN_ID}`, companyId: company.id });
    departmentIds.push(dept.id);
    check("C0. Fixture is genuinely direct-Company: businessUnitId is null", dept.businessUnitId === null);
    check("C0. Fixture is genuinely direct-Company: companyId is set", dept.companyId === company.id);

    const adminUser = await prisma.user.create({ data: { email: `direct-co-admin-${RUN_ID}@example.com`, role: Role.ADMIN } });
    userIds.push(adminUser.id);
    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };

    // ── 3/4/5. Rename-only PATCH, exactly what the FIXED form now sends (no businessUnitId key at all) ──
    console.log("\nGlobal ADMIN renames only the name (fixed form never sends businessUnitId for an unchanged direct-Company department)...\n");
    const newName = `Systems & Operations ${RUN_ID}`;
    const res = await PATCH(jsonReq({ name: newName, slug: dept.slug, description: null }), { params: Promise.resolve({ id: dept.id }) });
    check("C1. Rename-only PATCH (businessUnitId omitted) -> 200 (Save is permitted)", res.status === 200);
    const body = await res.json();

    // ── 6/7. Name + normalizedName updated ──
    check("C2. Department name changed successfully", body.name === newName);
    check("C3. normalizedName was recomputed alongside the rename", body.normalizedName === normalizeDepartmentName(newName));

    // ── 8/9/10. businessUnitId stays null, companyId unchanged, no placement side effect ──
    const refetched = await prisma.department.findUnique({ where: { id: dept.id } });
    check("C4. businessUnitId remains null after the rename", refetched?.businessUnitId === null);
    check("C5. companyId is unchanged (still this same Company)", refetched?.companyId === company.id);
    check("C6. Department is still exactly one row (no re-parenting side effect created/duplicated anything)", (await prisma.department.count({ where: { id: dept.id } })) === 1);

    // ── Requested-but-empty businessUnitId is rejected (proves the backend's own guard, and why the form must never send "") ──
    console.log("\nA crafted businessUnitId: \"\" in the request body is still rejected by the schema (belt-and-suspenders)...\n");
    const emptyRes = await PATCH(jsonReq({ businessUnitId: "" }), { params: Promise.resolve({ id: dept.id }) });
    check("C7. businessUnitId: \"\" -> 422 (schema rejects it outright, never silently accepted)", emptyRes.status === 422);
    const stillDirect = await prisma.department.findUnique({ where: { id: dept.id } });
    check("C7. Department is still direct-Company after the rejected empty-string attempt", stillDirect?.businessUnitId === null && stillDirect?.companyId === company.id);

    // ── 11. A department that ALREADY has a Business Unit cannot be cleared to "" through this route either ──
    console.log("\nA department that already has a real Business Unit still cannot be cleared to \"\" (item 11)...\n");
    const bu = await prisma.businessUnit.create({ data: { name: `Direct Co BU ${RUN_ID}`, companyId: company.id } });
    businessUnitIds.push(bu.id);
    const deptWithBu = await createDepartment({ name: `Has A BU ${RUN_ID}`, slug: `has-a-bu-${RUN_ID}`, businessUnitId: bu.id });
    departmentIds.push(deptWithBu.id);
    const clearRes = await PATCH(jsonReq({ businessUnitId: "" }), { params: Promise.resolve({ id: deptWithBu.id }) });
    check("C8. Clearing an existing Business Unit to \"\" -> 422 (rejected, same schema guard)", clearRes.status === 422);
    const stillHasBu = await prisma.department.findUnique({ where: { id: deptWithBu.id } });
    check("C8. Department still has its original Business Unit after the rejected clear attempt", stillHasBu?.businessUnitId === bu.id);

    // ── 13. Department Admin (department.manageSettings only) can still rename without touching businessUnitId ──
    console.log("\nDepartment Admin (department.manageSettings, no businessUnitId in the request) can still rename (item 13)...\n");
    const deptAdminUser = await prisma.user.create({ data: { email: `direct-co-deptadmin-${RUN_ID}@example.com`, role: Role.USER } });
    userIds.push(deptAdminUser.id);
    const deptAdminMembership = await prisma.departmentMembership.create({
      data: { userId: deptAdminUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(deptAdminMembership.id);
    currentSession = { user: { id: deptAdminUser.id, role: Role.USER, customRoleId: null } };
    const deptAdminNewName = `Systems & Ops Renamed Again ${RUN_ID}`;
    const deptAdminRes = await PATCH(jsonReq({ name: deptAdminNewName, description: "Updated by a Department Admin" }), { params: Promise.resolve({ id: dept.id }) });
    check("C9. Department Admin's rename+description edit (no businessUnitId) -> 200", deptAdminRes.status === 200);
    const deptAdminBody = await deptAdminRes.json();
    check("C9. Name updated by the Department Admin", deptAdminBody.name === deptAdminNewName);
    check("C9. Description updated by the Department Admin", deptAdminBody.description === "Updated by a Department Admin");
    const afterDeptAdmin = await prisma.department.findUnique({ where: { id: dept.id } });
    check("C9. businessUnitId still null and companyId still unchanged after the Department Admin's edit", afterDeptAdmin?.businessUnitId === null && afterDeptAdmin?.companyId === company.id);

    // ── Department Admin still cannot change the Business Unit (unrelated RBAC, unchanged by this fix) ──
    const deptAdminBuAttempt = await PATCH(jsonReq({ businessUnitId: bu.id }), { params: Promise.resolve({ id: dept.id }) });
    check("C10. Department Admin (department.manageSettings only) still cannot move to a real Business Unit -> 403 (unrelated RBAC unchanged)", deptAdminBuAttempt.status === 403);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      // createDepartment() also creates starter TicketCategory/TicketPriority/
      // TicketStatus rows (config-starter-data.ts) — these three have a plain
      // RESTRICT departmentId FK (unlike ActivityProgressConfig/
      // ProjectStatusConfig/ActivityStatusConfig/ActivityPriorityConfig,
      // which cascade), so they must be cleared before the department itself.
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.businessUnit.deleteMany({ where: { id: { in: businessUnitIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
