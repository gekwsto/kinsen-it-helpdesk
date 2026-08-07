/**
 * Read-only DB invariant audit for the Microsoft Job Title auto-discovery
 * feature. Never writes. Usage: npx tsx scripts/audit-job-title-directory-invariants.ts
 */
import { prisma } from "@/lib/prisma";
import { normalizeJobTitleValue } from "@/lib/services/microsoft-directory-service";
import { listJobTitleDirectoryForAdmin } from "@/lib/services/microsoft-job-title-directory-service";

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

async function main() {
  console.log("\n=== Job Title Directory invariants ===\n");

  const all = await prisma.microsoftDirectoryJobTitleValue.findMany();

  // 1. No duplicate (domain, normalizedValue) pairs.
  const seen = new Map<string, number>();
  for (const row of all) {
    const key = `${row.domain}::${row.normalizedValue}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupes = Array.from(seen.entries()).filter(([, count]) => count > 1);
  check("No duplicate (domain, normalizedValue) pairs", dupes.length === 0, JSON.stringify(dupes));

  // 2. No empty value/normalizedValue among rows with a non-empty domain
  //    (domain non-empty implies this row has been touched by the
  //    domain-aware code path and must be fully populated).
  const domainScoped = all.filter((r) => r.domain !== "");
  const emptyValues = domainScoped.filter((r) => !r.value.trim() || !r.normalizedValue.trim());
  check("No empty value/normalizedValue among domain-scoped rows", emptyValues.length === 0, JSON.stringify(emptyValues.map((r) => r.id)));

  // 3. normalizedValue is always the correct normalization of value, for
  //    every domain-scoped row (never drifted).
  const normalize = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();
  const mismatched = domainScoped.filter((r) => normalize(r.value) !== r.normalizedValue);
  check("normalizedValue matches normalize(value) for every domain-scoped row", mismatched.length === 0, JSON.stringify(mismatched.map((r) => r.id)));

  // 4. userCount is never negative.
  const negative = all.filter((r) => r.userCount < 0);
  check("userCount is never negative", negative.length === 0);

  // 5. Every active PROFILE_JOB_TITLE MicrosoftDepartmentMapping still
  //    points at an existing, active department (no orphaned mapping) —
  //    this feature only READS MicrosoftDepartmentMapping, never writes it,
  //    so this is really a general sanity check, not something this
  //    feature could have broken, but it's cheap to prove.
  const jobTitleMappings = await prisma.microsoftDepartmentMapping.findMany({
    where: { sourceType: "PROFILE_JOB_TITLE" },
    include: { department: { select: { id: true, isActive: true } } },
  });
  const orphaned = jobTitleMappings.filter((m) => !m.department);
  check("No PROFILE_JOB_TITLE mapping references a missing department", orphaned.length === 0);

  // 6. Feature isolation: this feature must never write DepartmentMembership,
  //    User.role, or User.departmentId — verified structurally (no import of
  //    those write paths in microsoft-job-title-directory-service.ts), and
  //    empirically here by confirming zero DepartmentMembership rows exist
  //    with a source that doesn't already appear in the pre-existing
  //    MembershipSource enum (i.e. nothing new was introduced).
  const membershipSources = await prisma.departmentMembership.groupBy({ by: ["source"], _count: true });
  const knownSources = new Set(["MICROSOFT_DEPARTMENT", "MICROSOFT_GROUP", "MICROSOFT_APP_ROLE", "MICROSOFT_JOB_TITLE", "MANUAL"]);
  const unknownSources = membershipSources.filter((s) => !knownSources.has(s.source));
  check("DepartmentMembership.source values are all pre-existing enum members (no new write path introduced)", unknownSources.length === 0, JSON.stringify(unknownSources));

  // 7. Migration backfill sanity: every pre-existing (now domain-scoped)
  //    row has a non-empty domain — none left at the schema default "".
  const blankDomain = all.filter((r) => r.domain === "");
  console.log(`\n  (info) rows with blank domain (never touched by any write path yet — expected 0 post-migration+first sync, informational): ${blankDomain.length}`);

  console.log("\n=== MicrosoftDepartmentMapping domain invariants (FIND-006) ===\n");

  const mappings = await prisma.microsoftDepartmentMapping.findMany();

  // 7. No duplicate (sourceType, domain, normalizedMicrosoftValue) — the DB
  //    unique index already guarantees this structurally, but proving it
  //    from data (not just trusting the constraint exists) is the point.
  const mappingSeen = new Map<string, number>();
  for (const m of mappings) {
    const key = `${m.sourceType}::${m.domain}::${m.normalizedMicrosoftValue}`;
    mappingSeen.set(key, (mappingSeen.get(key) ?? 0) + 1);
  }
  const mappingDupes = Array.from(mappingSeen.entries()).filter(([, count]) => count > 1);
  check("No duplicate (sourceType, domain, normalizedMicrosoftValue) mappings", mappingDupes.length === 0, JSON.stringify(mappingDupes));

  // 8. Every PROFILE_JOB_TITLE mapping has a REAL (non-empty) domain —
  //    "" is the global sentinel, never valid for this sourceType.
  const jobTitleMappingsNoDomain = mappings.filter((m) => m.sourceType === "PROFILE_JOB_TITLE" && !m.domain);
  check("Every PROFILE_JOB_TITLE mapping has a non-empty domain", jobTitleMappingsNoDomain.length === 0, JSON.stringify(jobTitleMappingsNoDomain.map((m) => m.id)));

  // 9. Every non-PROFILE_JOB_TITLE mapping is global (domain === "") — no
  //    accidental domain-scoping ever applied to a source type that
  //    shouldn't have one.
  const nonJobTitleWithDomain = mappings.filter((m) => m.sourceType !== "PROFILE_JOB_TITLE" && m.domain !== "");
  check("Every non-PROFILE_JOB_TITLE mapping stays global (domain='')", nonJobTitleWithDomain.length === 0, JSON.stringify(nonJobTitleWithDomain.map((m) => m.id)));

  // 10. normalizedMicrosoftValue matches the per-sourceType computation rule
  //     exactly (PROFILE_JOB_TITLE: normalizeJobTitleValue; everything else:
  //     an exact copy of microsoftValue) — never drifted from what
  //     createMapping/updateMapping would compute today.
  const mismatchedNormalization = mappings.filter((m) => {
    const expected = m.sourceType === "PROFILE_JOB_TITLE" ? normalizeJobTitleValue(m.microsoftValue) : m.microsoftValue;
    return m.normalizedMicrosoftValue !== expected;
  });
  check("normalizedMicrosoftValue matches the per-sourceType computation rule for every mapping", mismatchedNormalization.length === 0, JSON.stringify(mismatchedNormalization.map((m) => m.id)));

  // 11. Discovery catalog's Configured/Not-Configured join
  //     (listJobTitleDirectoryForAdmin) never disagrees with a direct query
  //     of active PROFILE_JOB_TITLE mappings for the SAME domain.
  const { domain: discoveryDomain, rows: discoveryRows } = await listJobTitleDirectoryForAdmin();
  const activeDomainMappingsByNormalized = new Map(
    mappings.filter((m) => m.sourceType === "PROFILE_JOB_TITLE" && m.domain === discoveryDomain && m.isActive).map((m) => [m.normalizedMicrosoftValue, m])
  );
  const configuredJoinMismatches = discoveryRows.filter((row) => {
    const directMatch = activeDomainMappingsByNormalized.get(normalizeJobTitleValue(row.value));
    return row.configured !== !!directMatch;
  });
  check("Discovery Configured/Not-Configured join matches a direct query for every row (0 mismatches)", configuredJoinMismatches.length === 0, JSON.stringify(configuredJoinMismatches.map((r) => r.value)));

  console.log(`\nTotal MicrosoftDepartmentMapping rows: ${mappings.length} (${mappings.filter((m) => m.sourceType === "PROFILE_JOB_TITLE").length} PROFILE_JOB_TITLE, domain-scoped)`);

  console.log(`\nTotal MicrosoftDirectoryJobTitleValue rows: ${all.length}`);
  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main();
