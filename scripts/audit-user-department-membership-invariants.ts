/**
 * Read-only database acceptance-invariant audit for the User/Department/
 * Member canonical-membership architecture. Run after
 * scripts/reconcile-user-department-membership.ts --apply to confirm the
 * database now satisfies every invariant the new write paths
 * (setPrimaryDepartmentMembership) are supposed to guarantee going forward.
 *
 * Invariants 1-3 and 6 are directly DB-checkable (pure SQL, zero writes)
 * and asserted here. Invariants 4 (0..N secondary memberships is trivially
 * always true by schema — no constraint to violate), 5 (MANUAL secondary
 * memberships are never touched by any automated process), 7 (authorization
 * uses all active memberships), 8 (organizational placement uses the
 * primary membership), and 9 (global role sync is independent of
 * department-placement sync) are CODE-LEVEL behavioral guarantees, not
 * point-in-time DB facts — they're verified by the regression test suite
 * (scripts/test-director-multi-department-authorization.ts,
 * scripts/test-organization-sync-primary-membership.ts,
 * scripts/test-user-department-membership-sync.ts), not re-derivable from a
 * single snapshot query, and are listed here for completeness/traceability
 * only.
 *
 * Usage: npx tsx scripts/audit-user-department-membership-invariants.ts
 */
import { prisma } from "@/lib/prisma";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`, detail ?? ""); failed++; }
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  console.log("\n=== User/Department/Member database invariant audit ===\n");

  // ── Invariant 3: no user has more than one active primary membership ───
  const duplicatePrimaries: Array<{ userid: string; count: bigint }> = await prisma.$queryRaw`
    SELECT "userId" as userid, COUNT(*)::bigint as count
    FROM "DepartmentMembership"
    WHERE "isPrimary" = true AND "isActive" = true
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  `;
  check("3. No User has more than one active primary DepartmentMembership", duplicatePrimaries.length === 0, duplicatePrimaries);

  // ── Invariant 1: every User with departmentId != null has EXACTLY one active primary membership in that SAME department ──
  const usersWithDept = await prisma.user.findMany({ where: { departmentId: { not: null } }, select: { id: true, departmentId: true } });
  const invariant1Violations: Array<{ userId: string; departmentId: string | null; reason: string }> = [];
  for (const u of usersWithDept) {
    const primariesInDept = await prisma.departmentMembership.count({ where: { userId: u.id, departmentId: u.departmentId!, isActive: true, isPrimary: true } });
    if (primariesInDept !== 1) {
      invariant1Violations.push({ userId: u.id, departmentId: u.departmentId, reason: `expected exactly 1 active primary membership at User.departmentId, found ${primariesInDept}` });
    }
  }
  check(`1. Every User with departmentId != null has exactly one active primary membership at that SAME department (checked ${usersWithDept.length} users)`, invariant1Violations.length === 0, invariant1Violations);

  // ── Invariant 2: every User with an active primary membership has User.departmentId equal to it ──
  const activePrimaries = await prisma.departmentMembership.findMany({
    where: { isPrimary: true, isActive: true },
    select: { userId: true, departmentId: true, user: { select: { departmentId: true } } },
  });
  const invariant2Violations = activePrimaries.filter((m) => m.user.departmentId !== m.departmentId);
  check(`2. Every User with an active primary membership has User.departmentId equal to it (checked ${activePrimaries.length} active primaries)`, invariant2Violations.length === 0, invariant2Violations.map((m) => ({ userId: m.userId, primaryDept: m.departmentId, userDotDepartmentId: m.user.departmentId })));

  // ── Invariant 6: User.departmentId never matches a SECONDARY (non-primary) membership only — if it's set, it must be backed by a PRIMARY row, never just a secondary one at the same department with no primary anywhere ──
  const invariant6Violations: Array<{ userId: string; departmentId: string }> = [];
  for (const u of usersWithDept) {
    const secondaryOnlyAtDept = await prisma.departmentMembership.findFirst({ where: { userId: u.id, departmentId: u.departmentId!, isActive: true, isPrimary: false } });
    const primaryAtDept = await prisma.departmentMembership.findFirst({ where: { userId: u.id, departmentId: u.departmentId!, isActive: true, isPrimary: true } });
    if (secondaryOnlyAtDept && !primaryAtDept) {
      invariant6Violations.push({ userId: u.id, departmentId: u.departmentId! });
    }
  }
  check(`6. User.departmentId is never backed ONLY by a secondary membership (a secondary grant never silently becomes the organizational placement)`, invariant6Violations.length === 0, invariant6Violations);

  // ── Informational: secondary membership counts (never asserted against — informational only, matching G/H in the reconciliation report) ──
  const secondaryManual = await prisma.departmentMembership.count({ where: { isPrimary: false, isActive: true, source: "MANUAL" } });
  const secondaryOther = await prisma.departmentMembership.count({ where: { isPrimary: false, isActive: true, NOT: { source: "MANUAL" } } });
  console.log(`\n(informational) Active secondary MANUAL memberships: ${secondaryManual}`);
  console.log(`(informational) Active secondary Microsoft/SYSTEM memberships: ${secondaryOther}`);

  console.log("\n(4, 5, 7, 8, 9 are code-level behavioral guarantees, verified by the regression test suite — not re-derivable from a single DB snapshot; see this file's header comment.)");

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main();
