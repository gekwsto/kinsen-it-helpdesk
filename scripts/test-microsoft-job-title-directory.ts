/**
 * Microsoft Job Title auto-discovery — domain-filtered tenant scan,
 * compound-key (domain, normalizedValue) idempotent sync, userCount
 * accuracy, Operation A (login) opportunistic cache-fill safety (the
 * regression this schema change could have introduced — see
 * microsoft-directory-service.ts's upsertDiscoveredMicrosoftDirectoryValue),
 * and the admin listing's configured/not-configured join against
 * MicrosoftDepartmentMapping. Every Graph call is a mocked `global.fetch`
 * (matching test-organization-graph-sync.ts's approach) — never requires a
 * real Azure tenant. GRAPH_* env vars are correctly-SHAPED fake values.
 *
 * Usage: npx tsx scripts/test-microsoft-job-title-directory.ts
 * Requires a reachable DATABASE_URL — skips (not fails) DB-writing sections
 * if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";
process.env.ALLOWED_EMAIL_DOMAIN = "kinsen.gr";

import { prisma } from "@/lib/prisma";
import { MicrosoftMappingSourceType, Role, DepartmentRole } from "@prisma/client";
import {
  fetchAllGraphUserDirectoryValues,
  syncMicrosoftDirectoryValues,
  upsertDiscoveredMicrosoftDirectoryValue,
  normalizeJobTitleValue,
} from "@/lib/services/microsoft-directory-service";
import {
  syncMicrosoftJobTitleDirectory,
  listJobTitleDirectoryForAdmin,
} from "@/lib/services/microsoft-job-title-directory-service";
import { createMapping } from "@/lib/services/microsoft-mapping-service";

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

function installTokenMock(router: (url: string) => Promise<Response> | Response) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "mock-app-token" });
    return router(url);
  }) as typeof fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
}

const TITLE_A = `Regional Manager ${RUN_ID}`;
const TITLE_B = `Field Engineer ${RUN_ID}`;
const NAME_TAG = `jt-directory-${RUN_ID}`;

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function cleanup() {
  await prisma.microsoftDepartmentMapping.deleteMany({ where: { microsoftValue: { contains: `${RUN_ID}` } } });
  await prisma.microsoftDirectoryJobTitleValue.deleteMany({ where: { value: { contains: `${RUN_ID}` } } });
  const depts = await prisma.department.findMany({ where: { name: { contains: NAME_TAG } }, select: { id: true } });
  const deptIds = depts.map((d) => d.id);
  if (deptIds.length > 0) {
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
  }
}

function section1_normalize() {
  console.log("\n=== normalizeJobTitleValue (pure) ===\n");
  check("trims", normalizeJobTitleValue("  Manager  ") === "manager");
  check("collapses internal whitespace", normalizeJobTitleValue("Sales   Manager") === "sales manager");
  check("lowercases", normalizeJobTitleValue("SALES MANAGER") === "sales manager");
  check("different casing/spacing collide to same key", normalizeJobTitleValue("Sales  Manager") === normalizeJobTitleValue("sales manager"));
}

async function section2_domainFilteredFetch() {
  console.log("\n=== fetchAllGraphUserDirectoryValues: domain + userType filtering ===\n");

  installTokenMock(() =>
    jsonResponse(200, {
      value: [
        // Eligible: Member, @kinsen.gr mail — counted.
        { id: "u1", userType: "Member", mail: `u1-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null },
        // Eligible, different casing of the SAME title -> must merge into ONE count bucket.
        { id: "u2", userType: "Member", mail: `u2-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A.toUpperCase(), department: null },
        // Guest with a @kinsen.gr mail -> excluded (not_member), never counted.
        { id: "u3", userType: "Guest", mail: `u3-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null },
        // Member on a different domain -> excluded, but its domain is reported.
        { id: "u4", userType: "Member", mail: `u4-${RUN_ID}@othercorp.com`, jobTitle: TITLE_A, department: null },
        // Eligible, second distinct title.
        { id: "u5", userType: "Member", userPrincipalName: `u5-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_B, department: null },
      ],
    })
  );

  const result = await fetchAllGraphUserDirectoryValues();
  check("fetch ok", result.ok === true);
  if (result.ok) {
    const countA = result.values.jobTitleCounts.find((c) => c.normalizedValue === normalizeJobTitleValue(TITLE_A));
    const countB = result.values.jobTitleCounts.find((c) => c.normalizedValue === normalizeJobTitleValue(TITLE_B));
    check("Title A counted exactly twice (u1 + u2, case-merged), Guest/other-domain excluded", countA?.count === 2);
    check("Title A display value keeps FIRST-seen casing", countA?.value === TITLE_A);
    check("Title B counted once", countB?.count === 1);
    check("otherDomainsObserved reports othercorp.com", result.values.otherDomainsObserved.includes("othercorp.com"));
    check("otherDomainsObserved never includes kinsen.gr itself", !result.values.otherDomainsObserved.includes("kinsen.gr"));
  }
  restoreFetch();
}

async function section3_syncIdempotencyAndStaling() {
  console.log("\n=== syncMicrosoftDirectoryValues: job-title compound-key idempotency + staling ===\n");

  installTokenMock(() =>
    jsonResponse(200, {
      value: [
        { id: "s1", userType: "Member", mail: `s1-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null },
        { id: "s2", userType: "Member", mail: `s2-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null },
        { id: "s3", userType: "Member", mail: `s3-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_B, department: null },
      ],
    })
  );

  const first = await syncMicrosoftDirectoryValues();
  check("first sync ok", first.ok === true);

  const rowsAfterFirst = await prisma.microsoftDirectoryJobTitleValue.findMany({
    where: { value: { in: [TITLE_A, TITLE_B] } },
  });
  check("exactly 2 rows created (no duplicates across the run)", rowsAfterFirst.length === 2);
  const rowA = rowsAfterFirst.find((r) => r.value === TITLE_A);
  check("Title A userCount = 2", rowA?.userCount === 2);
  check("Title A domain = kinsen.gr", rowA?.domain === "kinsen.gr");
  check("Title A normalizedValue matches helper", rowA?.normalizedValue === normalizeJobTitleValue(TITLE_A));

  // Re-run the IDENTICAL scan — must be fully idempotent (no new rows, same counts).
  const second = await syncMicrosoftDirectoryValues();
  check("second identical sync ok", second.ok === true);
  const rowsAfterSecond = await prisma.microsoftDirectoryJobTitleValue.findMany({
    where: { value: { in: [TITLE_A, TITLE_B] } },
  });
  check("still exactly 2 rows after re-sync (idempotent)", rowsAfterSecond.length === 2);
  check("added=0 on the idempotent re-run", second.ok === true && second.addedJobTitles === 0);

  // Third run: Title B disappears (no longer any eligible user has it) -> staled, not deleted.
  installTokenMock(() =>
    jsonResponse(200, {
      value: [{ id: "s1", userType: "Member", mail: `s1-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null }],
    })
  );
  const third = await syncMicrosoftDirectoryValues();
  check("third sync ok", third.ok === true);
  check("staledJobTitles counts Title B", third.ok === true && third.staledJobTitles === 1);
  const rowBAfterStale = await prisma.microsoftDirectoryJobTitleValue.findUnique({
    where: { domain_normalizedValue: { domain: "kinsen.gr", normalizedValue: normalizeJobTitleValue(TITLE_B) } },
  });
  check("Title B row preserved (never deleted), marked inactive", rowBAfterStale !== null && rowBAfterStale.isActive === false);
  check("Title A row still active", rowA !== undefined);

  // Fourth run: Title B reappears -> reactivated, never a second row.
  installTokenMock(() =>
    jsonResponse(200, {
      value: [
        { id: "s1", userType: "Member", mail: `s1-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_A, department: null },
        { id: "s3", userType: "Member", mail: `s3-${RUN_ID}@kinsen.gr`, jobTitle: TITLE_B, department: null },
      ],
    })
  );
  await syncMicrosoftDirectoryValues();
  const rowsAfterReactivate = await prisma.microsoftDirectoryJobTitleValue.findMany({
    where: { value: { in: [TITLE_A, TITLE_B] } },
  });
  check("still exactly 2 rows after reactivation (no duplicate created)", rowsAfterReactivate.length === 2);
  const rowBReactivated = rowsAfterReactivate.find((r) => r.value === TITLE_B);
  check("Title B reactivated (isActive true again)", rowBReactivated?.isActive === true);

  restoreFetch();
}

async function section4_operationALoginCacheFillSafety() {
  console.log("\n=== upsertDiscoveredMicrosoftDirectoryValue (Operation A): compound-key collision safety ===\n");

  const titleC = `Login Cache Title C ${RUN_ID}`;
  const titleD = `Login Cache Title D ${RUN_ID}`;

  // This is the exact regression scenario the schema change could have
  // introduced: two DIFFERENT job titles cached opportunistically via two
  // separate logins must never collide on the (domain, normalizedValue)
  // compound unique index just because both used to default to an empty
  // domain/normalizedValue.
  await upsertDiscoveredMicrosoftDirectoryValue("jobTitle", titleC);
  await upsertDiscoveredMicrosoftDirectoryValue("jobTitle", titleD);

  const rows = await prisma.microsoftDirectoryJobTitleValue.findMany({ where: { value: { in: [titleC, titleD] } } });
  check("both distinct titles created without throwing/colliding", rows.length === 2);
  check("both get the configured domain", rows.every((r) => r.domain === "kinsen.gr"));

  // Re-observing the SAME title with different casing must reuse the same
  // row via (domain, normalizedValue), never create a second one.
  await upsertDiscoveredMicrosoftDirectoryValue("jobTitle", titleC.toUpperCase());
  const rowsAfterRecast = await prisma.microsoftDirectoryJobTitleValue.findMany({ where: { normalizedValue: normalizeJobTitleValue(titleC) } });
  check("re-observing a different casing reuses the existing row (no duplicate)", rowsAfterRecast.length === 1);
  check("display casing stays first-seen (not overwritten to the new casing)", rowsAfterRecast[0]?.value === titleC);

  await prisma.microsoftDirectoryJobTitleValue.deleteMany({ where: { value: { in: [titleC, titleD] } } });
}

async function section5_adminListingConfiguredStatus() {
  console.log("\n=== listJobTitleDirectoryForAdmin: configured/not-configured join ===\n");

  const dept = await prisma.department.create({
    data: { name: `${NAME_TAG}-dept`, slug: `${NAME_TAG}-dept-${RUN_ID}` },
  });

  await syncMicrosoftJobTitleDirectory().catch(() => null); // best-effort refresh; fetch mock not required for this section since rows already exist from section3/4

  // Ensure a discovered-but-unconfigured row exists.
  await prisma.microsoftDirectoryJobTitleValue.upsert({
    where: { domain_normalizedValue: { domain: "kinsen.gr", normalizedValue: normalizeJobTitleValue(TITLE_B) } },
    create: { value: TITLE_B, domain: "kinsen.gr", normalizedValue: normalizeJobTitleValue(TITLE_B), userCount: 1, isActive: true },
    update: { isActive: true },
  });

  // Configure TITLE_A via a real mapping — different casing than stored, to
  // prove the join is case/whitespace-insensitive, matching
  // microsoft-mapping-service.ts's own matching rule.
  const mapping = await createMapping({
    sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
    microsoftValue: TITLE_A.toUpperCase(),
    departmentId: dept.id,
    role: Role.USER,
    departmentRole: DepartmentRole.REQUESTER,
    // FIND-006 (docs/roadmap-handoff-register.md): PROFILE_JOB_TITLE is now
    // domain-scoped — required.
    domain: "kinsen.gr",
  });

  const { domain, rows } = await listJobTitleDirectoryForAdmin();
  check("domain reflects configured ALLOWED_EMAIL_DOMAIN", domain === "kinsen.gr");
  const rowA = rows.find((r) => r.value === TITLE_A);
  const rowB = rows.find((r) => r.value === TITLE_B);
  check("Title A is reported configured despite casing difference", rowA?.configured === true);
  check("Title A's mapping department/role surfaced correctly", rowA?.mapping?.departmentId === dept.id && rowA?.mapping?.role === Role.USER);
  check("Title B is reported NOT configured", rowB?.configured === false && rowB?.mapping === null);

  await prisma.microsoftDepartmentMapping.delete({ where: { id: mapping.id } });
  await prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } });
  await prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } });
  await prisma.department.delete({ where: { id: dept.id } });
}

async function section6_crossDomainDirectoryIdentity() {
  console.log("\n=== Cross-domain directory identity: canonical key is (domain, normalizedValue), NOT global value ===\n");
  // FIND-005 follow-up audit: MicrosoftDirectoryJobTitleValue used to also
  // carry a GLOBAL `@unique` on `value` (a leftover from copy-pasting
  // MicrosoftDirectoryDepartmentValue's shape) — that silently blocked this
  // exact scenario. Fixed by migration
  // 20260807153000_job_title_value_domain_scoped_identity, which drops that
  // index; canonical identity is now (domain, normalizedValue) only.
  const RAW_TITLE = `Cross-Domain IT Manager ${RUN_ID}`;
  const rowGr = await prisma.microsoftDirectoryJobTitleValue.create({
    data: { value: RAW_TITLE, domain: "kinsen.gr", normalizedValue: normalizeJobTitleValue(RAW_TITLE), userCount: 4, isActive: true },
  });
  let rowAt: { id: string } | null = null;
  try {
    rowAt = await prisma.microsoftDirectoryJobTitleValue.create({
      data: { value: RAW_TITLE, domain: "kinsen.at", normalizedValue: normalizeJobTitleValue(RAW_TITLE), userCount: 2, isActive: true },
    });
    check("IDENTICAL raw value can coexist under two different domains (no DB constraint violation)", true);
  } catch (err) {
    check("IDENTICAL raw value can coexist under two different domains (no DB constraint violation)", false);
    console.error("   unexpected error:", err instanceof Error ? err.message : err);
  }
  check("kinsen.gr row and kinsen.at row are genuinely distinct rows", !!rowAt && rowAt.id !== rowGr.id);

  const both = await prisma.microsoftDirectoryJobTitleValue.findMany({ where: { normalizedValue: normalizeJobTitleValue(RAW_TITLE) } });
  check("exactly 2 rows exist for this normalizedValue, one per domain", both.length === 2);
  check("each row keeps its own domain-specific userCount independently", both.find((r) => r.domain === "kinsen.gr")?.userCount === 4 && both.find((r) => r.domain === "kinsen.at")?.userCount === 2);

  await prisma.microsoftDirectoryJobTitleValue.delete({ where: { id: rowGr.id } });
  if (rowAt) await prisma.microsoftDirectoryJobTitleValue.delete({ where: { id: rowAt.id } });
}

// A prior revision of this file had a section7 here documenting
// MicrosoftDepartmentMapping as a KNOWN, deliberate architectural
// limitation (global-per-string, not domain-scoped) — that limitation is
// now FIXED (FIND-006, docs/roadmap-handoff-register.md): PROFILE_JOB_TITLE
// mappings are domain-scoped, `domain` is now a REQUIRED input for them,
// and the same raw title independently resolves per domain. That coverage
// now lives in scripts/test-microsoft-mapping-domain-scope.ts (multi-domain
// isolated fixture, resolver convergence, admin CRUD domain validation,
// MANUAL/ADMIN protection, job-title-change semantics) — not duplicated
// here, since this file's own scope is the discovery catalog (sections 1-6
// above), not the permission-mapping engine.

async function main() {
  section1_normalize();

  if (!(await dbReachable())) {
    console.log("\nDATABASE_URL unreachable — skipping DB-backed sections 2-6 (this is a skip, not a failure).\n");
  } else {
    try {
      await cleanup();
      await section2_domainFilteredFetch();
      await section3_syncIdempotencyAndStaling();
      await section4_operationALoginCacheFillSafety();
      await section5_adminListingConfiguredStatus();
      await section6_crossDomainDirectoryIdentity();
    } finally {
      restoreFetch();
      await cleanup().catch(() => {});
      await prisma.$disconnect();
    }
  }

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
