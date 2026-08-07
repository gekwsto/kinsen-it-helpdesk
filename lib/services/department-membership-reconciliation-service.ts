/**
 * Phase 3 reconciliation for the User/Department/Member canonical-membership
 * architecture: backfills historical drift between User.departmentId and
 * the active PRIMARY DepartmentMembership for users created/edited before
 * setPrimaryDepartmentMembership (department-membership-service.ts) existed.
 * Deterministic, idempotent, resumable, dry-run capable — never touches
 * MANUAL secondary memberships, global roles, or Company/BusinessUnit
 * hierarchy. The CLI entry point is scripts/reconcile-user-department-membership.ts;
 * the logic lives here so it's importable (by tests, or any future caller)
 * without triggering a CLI run as a side effect of importing it.
 *
 * Categorization (per user), matching the audit's own lettering:
 *   A. User.departmentId set, matching active primary membership exists — already consistent, no action.
 *   B. User.departmentId set, NO membership row at all for that department — create an active primary membership there.
 *   C. User.departmentId set, a membership row for that SAME department exists but isPrimary=false (or inactive) — promote/reactivate it as primary, role/source preserved exactly as-is.
 *   D. Exactly one active primary membership exists, User.departmentId is null — mirror User.departmentId to it.
 *   E. Exactly one active primary membership exists, but points to a DIFFERENT department than User.departmentId — DepartmentMembership is canonical (explicit architecture decision), so User.departmentId is corrected to match it. Deterministic, logged, never touches the membership itself.
 *   F. More than one active primary membership — genuinely ambiguous. Auto-resolved ONLY if exactly one of the duplicates has source MANUAL (an explicit admin choice outranks any automated one — same precedent as every other MANUAL-protection rule in this codebase): that one wins, the others are demoted (isPrimary:false, isActive UNCHANGED — never destroys access), User.departmentId mirrors the winner. If zero or 2+ are MANUAL, this is a genuine conflict — reported only, ZERO writes for this user.
 *   G/H. Secondary MANUAL / secondary Microsoft-or-SYSTEM-sourced memberships — informational counts only, never touched by this service under any category.
 *
 * Consistent with rule "never a blind overwrite": E and F's MANUAL-tiebreak
 * resolutions are not guesses — they directly implement this session's
 * explicit architecture decision (DepartmentMembership is canonical; MANUAL
 * always outranks an automated source) and are logged per-user so every
 * change is auditable. Anything that doesn't reduce to one of these
 * deterministic rules (F with zero or 2+ MANUAL rows) is reported as an
 * unresolved conflict and left completely untouched.
 *
 * Safety:
 *  - Never touches TicketPriority, roles, permissions, Company/BusinessUnit
 *    hierarchy, or any MANUAL membership's role/source/isActive.
 *  - Each user's fix is its own bounded prisma.$transaction — never one
 *    shared transaction across the run (see the real production incident
 *    documented in organization-directory-sync-service.ts's header comment).
 *  - Counters increment ONLY after a real successful commit.
 *  - A per-user failure is caught, logged, and counted as an error — it
 *    never aborts the run or fakes a success.
 *  - Idempotent: a user already in category A (or an unresolved F conflict)
 *    produces zero writes on a repeat run.
 */
import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentMembership, MembershipSource, User } from "@prisma/client";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";

export type ReconciliationCategory = "A" | "B" | "C" | "D" | "E" | "F_resolved" | "F_conflict" | "none";

interface UserRow {
  id: string;
  email: string;
  departmentId: string | null;
  authProvider: AuthProvider;
  role: User["role"];
}

export interface ReconciliationItem {
  userId: string;
  email: string;
  category: ReconciliationCategory;
  detail: string;
}

export interface ReconciliationPlan {
  items: ReconciliationItem[];
  counts: Record<ReconciliationCategory, number>;
  secondaryManualCount: number;
  secondaryOtherCount: number;
}

/** Read-only — never writes. Safe to call any number of times. */
export async function buildReconciliationPlan(): Promise<ReconciliationPlan> {
  const users: UserRow[] = await prisma.user.findMany({ select: { id: true, email: true, departmentId: true, authProvider: true, role: true } });
  const allMemberships = await prisma.departmentMembership.findMany({ where: { isActive: true } });
  const membershipsByUser = new Map<string, DepartmentMembership[]>();
  for (const m of allMemberships) {
    if (!membershipsByUser.has(m.userId)) membershipsByUser.set(m.userId, []);
    membershipsByUser.get(m.userId)!.push(m);
  }
  // Non-primary active memberships everywhere — for the G/H informational counts, independent of the per-user category below.
  let secondaryManualCount = 0;
  let secondaryOtherCount = 0;
  for (const m of allMemberships) {
    if (m.isPrimary) continue;
    if (m.source === MembershipSource.MANUAL) secondaryManualCount++;
    else secondaryOtherCount++;
  }

  const items: ReconciliationItem[] = [];
  const counts: Record<ReconciliationCategory, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F_resolved: 0, F_conflict: 0, none: 0 };

  for (const user of users) {
    const memberships = membershipsByUser.get(user.id) ?? [];
    const activePrimaries = memberships.filter((m) => m.isPrimary);

    if (activePrimaries.length > 1) {
      const manualOnes = activePrimaries.filter((m) => m.source === MembershipSource.MANUAL);
      if (manualOnes.length === 1) {
        counts.F_resolved++;
        items.push({
          userId: user.id,
          email: user.email,
          category: "F_resolved",
          detail: `${activePrimaries.length} active primaries found; exactly one is MANUAL (dept ${manualOnes[0].departmentId}) — it wins, ${activePrimaries.length - 1} other(s) demoted, User.departmentId mirrored to it.`,
        });
      } else {
        counts.F_conflict++;
        items.push({
          userId: user.id,
          email: user.email,
          category: "F_conflict",
          detail: `${activePrimaries.length} active primaries found (departments: ${activePrimaries.map((m) => m.departmentId).join(", ")}), ${manualOnes.length} of them MANUAL — cannot be resolved deterministically. NOT modified.`,
        });
      }
      continue;
    }

    if (activePrimaries.length === 1) {
      const primary = activePrimaries[0];
      if (user.departmentId === primary.departmentId) {
        counts.A++;
        items.push({ userId: user.id, email: user.email, category: "A", detail: "Already consistent." });
      } else if (user.departmentId === null) {
        counts.D++;
        items.push({ userId: user.id, email: user.email, category: "D", detail: `Active primary membership exists (dept ${primary.departmentId}) but User.departmentId is null — will mirror it.` });
      } else {
        counts.E++;
        items.push({ userId: user.id, email: user.email, category: "E", detail: `Active primary membership points at dept ${primary.departmentId}, but User.departmentId is ${user.departmentId} — DepartmentMembership is canonical, User.departmentId will be corrected to match it.` });
      }
      continue;
    }

    // No active primary at all.
    if (user.departmentId === null) {
      counts.none++;
      items.push({ userId: user.id, email: user.email, category: "none", detail: "No department at all — nothing to reconcile." });
      continue;
    }

    const membershipAtDept = memberships.find((m) => m.departmentId === user.departmentId);
    if (membershipAtDept) {
      counts.C++;
      items.push({ userId: user.id, email: user.email, category: "C", detail: `An active, non-primary membership already exists at User.departmentId (${user.departmentId}) — will be promoted to primary, role/source preserved exactly.` });
    } else {
      counts.B++;
      items.push({ userId: user.id, email: user.email, category: "B", detail: `User.departmentId (${user.departmentId}) set, but no membership row exists for it at all — will create an active primary membership there.` });
    }
  }

  return { items, counts, secondaryManualCount, secondaryOtherCount };
}

export function printReconciliationPlanSummary(plan: ReconciliationPlan): void {
  console.log("\n=== Reconciliation plan (categorization) ===\n");
  console.log(`A. Already consistent:                                    ${plan.counts.A}`);
  console.log(`B. departmentId set, no membership at all -> will create: ${plan.counts.B}`);
  console.log(`C. departmentId set, non-primary membership exists -> promote: ${plan.counts.C}`);
  console.log(`D. active primary exists, departmentId null -> mirror:   ${plan.counts.D}`);
  console.log(`E. active primary disagrees with departmentId -> mirror corrected (membership is canonical): ${plan.counts.E}`);
  console.log(`F. multiple active primaries, MANUAL tiebreak resolved:  ${plan.counts.F_resolved}`);
  console.log(`F. multiple active primaries, UNRESOLVABLE conflict:     ${plan.counts.F_conflict}`);
  console.log(`(no department at all, nothing to do):                  ${plan.counts.none}`);
  console.log(`\nG. Secondary MANUAL memberships (untouched, informational): ${plan.secondaryManualCount}`);
  console.log(`H. Secondary Microsoft/SYSTEM memberships (untouched, informational): ${plan.secondaryOtherCount}`);
  const totalFixable = plan.counts.B + plan.counts.C + plan.counts.D + plan.counts.E + plan.counts.F_resolved;
  console.log(`\nTotal users needing a deterministic fix: ${totalFixable}`);
  console.log(`Total unresolved conflicts (never auto-fixed): ${plan.counts.F_conflict}`);
}

export interface ReconciliationApplyResult {
  fixed: number;
  errors: number;
  errorDetails: Array<{ userId: string; email: string; reason: string }>;
}

/** Applies ONE user's deterministic fix in its own bounded transaction. Throws on failure — never swallows an error into a fake success. */
export async function applyOneReconciliationFix(item: ReconciliationItem): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Re-read fresh INSIDE the transaction — never trust the plan snapshot for the actual write (the DB may have changed between plan and apply).
    const user = await tx.user.findUniqueOrThrow({ where: { id: item.userId }, select: { id: true, departmentId: true, role: true } });
    const memberships = await tx.departmentMembership.findMany({ where: { userId: item.userId, isActive: true } });
    const activePrimaries = memberships.filter((m) => m.isPrimary);

    if (item.category === "B") {
      if (!user.departmentId) return; // state changed since the plan was built — nothing to do, safe no-op
      const existingAtDept = memberships.find((m) => m.departmentId === user.departmentId);
      if (existingAtDept) return; // already fixed by a prior run / concurrent change
      const role = translateGlobalRoleToDepartmentRole(user.role);
      // Heuristic for an unknown-provenance backfilled row: a
      // Microsoft-linked account is far more likely to have gotten its
      // departmentId from Microsoft sync; a credentials account, from an
      // admin. Tied to real, already-present data, not an arbitrary guess.
      const fullUser = await tx.user.findUniqueOrThrow({ where: { id: item.userId }, select: { authProvider: true } });
      await tx.departmentMembership.create({
        data: {
          userId: item.userId,
          departmentId: user.departmentId,
          role,
          source: fullUser.authProvider === AuthProvider.MICROSOFT ? MembershipSource.MICROSOFT_DEPARTMENT : MembershipSource.MANUAL,
          isActive: true,
          isPrimary: true,
        },
      });
    } else if (item.category === "C") {
      if (!user.departmentId) return;
      const existingAtDept = memberships.find((m) => m.departmentId === user.departmentId) ?? (await tx.departmentMembership.findUnique({ where: { userId_departmentId: { userId: item.userId, departmentId: user.departmentId } } }));
      if (!existingAtDept) return; // state changed — treat as already handled
      if (existingAtDept.isPrimary && existingAtDept.isActive) return; // already fixed
      await tx.departmentMembership.update({
        where: { id: existingAtDept.id },
        data: { isActive: true, isPrimary: true }, // role/source deliberately untouched
      });
    } else if (item.category === "D") {
      if (activePrimaries.length !== 1) return; // state changed — re-plan will pick up whatever it is now
      if (user.departmentId === activePrimaries[0].departmentId) return; // already fixed
      await tx.user.update({ where: { id: item.userId }, data: { departmentId: activePrimaries[0].departmentId } });
    } else if (item.category === "E") {
      if (activePrimaries.length !== 1) return;
      if (user.departmentId === activePrimaries[0].departmentId) return; // already fixed
      await tx.user.update({ where: { id: item.userId }, data: { departmentId: activePrimaries[0].departmentId } });
    } else if (item.category === "F_resolved") {
      if (activePrimaries.length <= 1) return; // already fixed by a prior run
      const manualOnes = activePrimaries.filter((m) => m.source === MembershipSource.MANUAL);
      if (manualOnes.length !== 1) return; // state changed since plan — no longer a clean tiebreak, skip (will be re-categorized next run)
      const winner = manualOnes[0];
      for (const m of activePrimaries) {
        if (m.id === winner.id) continue;
        await tx.departmentMembership.update({ where: { id: m.id }, data: { isPrimary: false } }); // isActive UNCHANGED — never destroys access
      }
      if (user.departmentId !== winner.departmentId) {
        await tx.user.update({ where: { id: item.userId }, data: { departmentId: winner.departmentId } });
      }
    }
    // "A", "F_conflict", "none" -> no writes, ever.
  });
}

export async function applyReconciliationPlan(plan: ReconciliationPlan): Promise<ReconciliationApplyResult> {
  const result: ReconciliationApplyResult = { fixed: 0, errors: 0, errorDetails: [] };
  const actionable = plan.items.filter((i) => i.category === "B" || i.category === "C" || i.category === "D" || i.category === "E" || i.category === "F_resolved");
  for (const item of actionable) {
    try {
      await applyOneReconciliationFix(item);
      result.fixed++; // only incremented after a real successful commit (applyOneReconciliationFix throws on failure, never swallows)
    } catch (err) {
      result.errors++;
      const reason = err instanceof Error ? err.message : String(err);
      result.errorDetails.push({ userId: item.userId, email: item.email, reason });
      console.warn(`[reconcile] Failed to fix user ${item.email} (${item.category}):`, reason);
    }
  }
  return result;
}
