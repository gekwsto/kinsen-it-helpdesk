/**
 * Phase 3 — target department validation + per-user membership/default-role
 * preparation for the legacy migration.
 *
 * The target app is department/workspace scoped; the legacy system was not.
 * Rather than guessing a department from legacy Platform/Category/title
 * (explicitly forbidden by the migration brief), every migrated ticket goes
 * into ONE operator-supplied target department (LEGACY_MIGRATION_DEPARTMENT_ID),
 * and every migrated user gets AT LEAST some membership there so they can see
 * their own imported tickets.
 *
 * CRITICAL SAFETY RULE (this module's entire reason for existing as a
 * separate layer over setPrimaryDepartmentMembership, not a thin wrapper
 * around it): setPrimaryDepartmentMembership's own MANUAL-primary
 * protection only fires when the CALLER's `source` differs from
 * MembershipSource.MANUAL (see its own doc comment: "A MANUAL call — an
 * admin explicitly re-choosing — always wins over any previous MANUAL
 * primary"). Since this migration itself uses source: MANUAL (the only
 * non-Microsoft-sync value, and the one that gets a migrated membership the
 * right long-term protection from LATER Microsoft sync), calling
 * setPrimaryDepartmentMembership UNCONDITIONALLY for every reconciled user
 * — including an EXISTING/reused user who already has their own real
 * primary department elsewhere — would silently MOVE that user's primary
 * department to the migration target, exactly the kind of destructive
 * side effect a bulk, non-targeted migration must never cause for a
 * pre-existing person's account.
 *
 * So this module only ever calls setPrimaryDepartmentMembership for a user
 * who has NO primary membership at all yet (a genuinely new import, or an
 * existing account that — unusually — has no department at all). For an
 * existing user who already HAS a primary department (anywhere), that
 * primary is left COMPLETELY untouched, and the target department is
 * granted only as an ADDITIVE, NON-primary membership — created only if no
 * row for that (user, department) pair exists yet, and NEVER updated if
 * one already does (so an existing manual role/customRole in that
 * department, however it got there, is never overwritten either).
 */
import type { PrismaClient, Role, DepartmentRole } from "@prisma/client";
import { setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";

export class TargetDepartmentValidationError extends Error {}

export interface ValidatedTargetDepartment {
  id: string;
  name: string;
}

/** Hard-fails (never guesses/falls back) if LEGACY_MIGRATION_DEPARTMENT_ID is absent, doesn't exist, or points at an inactive department. */
export async function validateTargetDepartment(db: PrismaClient, departmentIdFromEnv: string | undefined): Promise<ValidatedTargetDepartment> {
  if (!departmentIdFromEnv || departmentIdFromEnv.trim() === "") {
    throw new TargetDepartmentValidationError(
      "LEGACY_MIGRATION_DEPARTMENT_ID is required and was not set. Refusing to guess a target department from legacy Platform/Category/title data."
    );
  }
  const department = await db.department.findUnique({ where: { id: departmentIdFromEnv }, select: { id: true, name: true, isActive: true } });
  if (!department) {
    throw new TargetDepartmentValidationError(`LEGACY_MIGRATION_DEPARTMENT_ID="${departmentIdFromEnv}" does not match any existing Department.`);
  }
  if (!department.isActive) {
    throw new TargetDepartmentValidationError(`LEGACY_MIGRATION_DEPARTMENT_ID="${departmentIdFromEnv}" (${department.name}) is not active.`);
  }
  return { id: department.id, name: department.name };
}

/**
 * Purely additive: creates a NON-primary DepartmentMembership row ONLY if
 * (userId, departmentId) has no row at all yet. If one already exists —
 * primary or secondary, MANUAL or Microsoft-sourced, any role/customRole —
 * it is returned unchanged and NEVER written to. This is the one and only
 * membership-mutating operation this migration ever applies to a user who
 * already has a primary department elsewhere.
 */
export async function ensureAdditionalDepartmentMembership(
  db: PrismaClient,
  userId: string,
  departmentId: string,
  role: DepartmentRole,
  customRoleId: string | null
): Promise<{ outcome: "created" | "already_present" }> {
  const existing = await db.departmentMembership.findUnique({
    where: { userId_departmentId: { userId, departmentId } },
    select: { id: true },
  });
  if (existing) return { outcome: "already_present" };

  await db.departmentMembership.create({
    data: { userId, departmentId, role, customRoleId, source: "MANUAL", isPrimary: false, isActive: true },
  });
  return { outcome: "created" };
}

export interface EnsureMembershipsResult {
  /** User had NO primary department membership at all — the migration target became their primary via setPrimaryDepartmentMembership (safe: nothing pre-existing to disturb). */
  grantedAsPrimary: number;
  /** User's existing primary was ALREADY the migration target department — a true no-op, nothing written. */
  alreadyPrimaryInTarget: number;
  /** User already has a DIFFERENT primary department — that primary is left completely untouched; a new, additive, NON-primary membership was created in the migration target so they can see the imported tickets. */
  addedAsSecondary: number;
  /** User already has a DIFFERENT primary department AND already had some (any-source) membership row in the migration target too — left completely untouched. */
  secondaryAlreadyPresent: number;
}

export async function ensureDepartmentMemberships(
  db: PrismaClient,
  userIds: string[],
  targetDepartmentId: string,
  dryRun: boolean
): Promise<EnsureMembershipsResult> {
  const result: EnsureMembershipsResult = { grantedAsPrimary: 0, alreadyPrimaryInTarget: 0, addedAsSecondary: 0, secondaryAlreadyPresent: 0 };
  const departmentDefault = dryRun ? { role: "REQUESTER" as DepartmentRole, customRoleId: null as string | null } : await resolveDefaultDepartmentRoleAssignment();

  for (const userId of userIds) {
    if (userId.startsWith("dry-run:")) {
      // A dry-run-synthesized placeholder user id — nothing real to look up; counted as a fresh primary grant (the common case for a genuinely new import).
      result.grantedAsPrimary++;
      continue;
    }

    const existingPrimary = await db.departmentMembership.findFirst({
      where: { userId, isPrimary: true, isActive: true },
      select: { departmentId: true },
    });

    if (!existingPrimary) {
      // No primary anywhere — safe to set the migration target as primary.
      if (dryRun) {
        result.grantedAsPrimary++;
        continue;
      }
      await setPrimaryDepartmentMembership(userId, targetDepartmentId, "MANUAL", {
        role: departmentDefault.role,
        customRoleId: departmentDefault.customRoleId,
      });
      result.grantedAsPrimary++;
      continue;
    }

    if (existingPrimary.departmentId === targetDepartmentId) {
      // Already exactly where they need to be.
      result.alreadyPrimaryInTarget++;
      continue;
    }

    // Existing primary in a DIFFERENT department — PRESERVED EXACTLY,
    // never touched. Only ensure an additive secondary membership.
    if (dryRun) {
      const existingAny = await db.departmentMembership.findUnique({
        where: { userId_departmentId: { userId, departmentId: targetDepartmentId } },
        select: { id: true },
      });
      if (existingAny) result.secondaryAlreadyPresent++;
      else result.addedAsSecondary++;
      continue;
    }

    const outcome = await ensureAdditionalDepartmentMembership(db, userId, targetDepartmentId, departmentDefault.role, departmentDefault.customRoleId);
    if (outcome.outcome === "created") result.addedAsSecondary++;
    else result.secondaryAlreadyPresent++;
  }

  return result;
}
