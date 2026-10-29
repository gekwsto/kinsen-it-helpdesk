/**
 * Read-only diagnostic for the 8 production "inactive_manager" relationships
 * reported by the SQLGeneral Manager Explorer: thopei, abbsha, bojljo,
 * farfao, kanjha, petsch, tuatas, verbru.
 *
 * Per lib/services/sqlgeneral-organization-tree-service.ts's own
 * buildManagerSkeleton, every entry in unresolvedManagerLinks is keyed by
 * the AFFECTED EMPLOYEE's own username — never the manager's — so these 8
 * usernames ARE the employees, not the managers. This script:
 *   1. Looks up each employee's OWN current SQLGeneral record (confirming
 *      their identity resolves, and reading their CURRENT
 *      managerAMAccountName — the first-level field only, exactly what the
 *      production tree itself uses; manager2AMAccountName/
 *      manager3AMAccountName are never consulted, per the explicit
 *      product rule "never skip levels").
 *   2. Looks up that referenced manager's OWN current record, to confirm
 *      their Active status and surface identifying metadata (mail,
 *      company, department) so a human can recognize who they actually
 *      are.
 *   3. Classifies each case using the SAME ground-truth logic
 *      refineUnresolvedManagerLinks itself uses (outcome + active), so the
 *      classification here is directly comparable to what production
 *      reported.
 *
 * STRICTLY READ-ONLY: only ever calls findSqlGeneralUserByUsername
 * (already the exact, tested, single-identity lookup the live hierarchy
 * build itself uses) — never writes to SQLGeneral, never writes to the
 * local DB, never touches Company/Department/User/Membership records,
 * never triggers Sync, never reassigns a manager or infers one from
 * manager2/manager3AMAccountName, and never touches the snapshot,
 * hierarchy algorithm, or Project Request approval logic.
 *
 * Requires REAL SQLGENERAL_* credentials in the environment it's run from
 * (this script makes live calls) — run it from production or a machine
 * with reachable access to the on-prem SQLGeneral API, never from a dev
 * sandbox with placeholder credentials.
 *
 * Usage: npx tsx scripts/audit-sqlgeneral-inactive-managers.ts [username ...]
 * (defaults to the 8 reported usernames if none are passed on the CLI)
 */
// Importing @/lib/prisma (unused otherwise — this script makes zero DB
// calls) is the same .env-loading trick every scripts/test-*.ts file in
// this project relies on under a bare `tsx` run; it does not open a DB
// connection by itself, only an actual query would.
import "@/lib/prisma";
import { findSqlGeneralUserByUsername, type SqlGeneralUserRecord } from "@/lib/sqlgeneral-api-client";

const DEFAULT_EMPLOYEES = ["thopei", "abbsha", "bojljo", "farfao", "kanjha", "petsch", "tuatas", "verbru"];

type Lookup = { outcome: "unique"; user: SqlGeneralUserRecord } | { outcome: "not_found" } | { outcome: "ambiguous"; count: number } | { outcome: "error"; reason: string };

// Exported only so a focused verification can exercise the classification
// logic directly against a mocked findSqlGeneralUserByUsername — no
// behavioral change from the script's own CLI usage.
export async function lookup(username: string): Promise<Lookup> {
  try {
    const result = await findSqlGeneralUserByUsername(username);
    return result;
  } catch (err) {
    return { outcome: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function describeManager(m: Lookup): string {
  if (m.outcome === "error") return `ERROR verifying manager: ${m.reason}`;
  if (m.outcome === "not_found") return "ANOMALY: manager no longer resolves at all (would now classify as missing_manager, not inactive_manager — data may have changed since the production snapshot was taken).";
  if (m.outcome === "ambiguous") return `ANOMALY: manager identity is now ambiguous (${m.count} matching rows) — would now classify as ambiguous_manager, not inactive_manager.`;
  if (m.user.active === true) return "ANOMALY: manager is now ACTIVE — the production snapshot is stale; a fresh snapshot refresh (ADMIN Refresh button, or the next daily 03:00 Europe/Athens run) should clear this automatically. No HR action needed.";
  return "CONFIRMED genuinely inactive manager — matches production's own inactive_manager classification. Recommended correction at the source: HR/SQLGeneral should update this employee's managerAMAccountName to point to a current, active manager (first-level field only — this script deliberately never looks at or infers from manager2AMAccountName/manager3AMAccountName).";
}

async function main() {
  const employees = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_EMPLOYEES;

  console.log(`Auditing ${employees.length} reported inactive_manager relationship(s)...\n`);

  const rows: Array<{ employee: string; employeeStatus: string; managerUsername: string | null; managerMail: string | null; managerCompany: string | null; managerDepartment: string | null; managerActive: boolean | null; classification: string }> = [];

  for (const employee of employees) {
    const employeeLookup = await lookup(employee);
    if (employeeLookup.outcome !== "unique") {
      rows.push({
        employee,
        employeeStatus: employeeLookup.outcome === "error" ? `ERROR: ${employeeLookup.reason}` : employeeLookup.outcome === "ambiguous" ? `AMBIGUOUS (${employeeLookup.count} rows)` : "NOT FOUND",
        managerUsername: null,
        managerMail: null,
        managerCompany: null,
        managerDepartment: null,
        managerActive: null,
        classification: "Cannot proceed — the employee's OWN identity no longer resolves uniquely. Investigate the employee's own SQLGeneral record directly before anything else.",
      });
      continue;
    }

    const managerUsername = employeeLookup.user.managerAMAccountName?.trim() || null;
    if (!managerUsername) {
      rows.push({
        employee,
        employeeStatus: `active=${employeeLookup.user.active}`,
        managerUsername: null,
        managerMail: null,
        managerCompany: null,
        managerDepartment: null,
        managerActive: null,
        classification: "ANOMALY: this employee's managerAMAccountName is now null (no manager claimed at all) — the production snapshot is stale; a fresh refresh would now classify this as no_manager, not inactive_manager.",
      });
      continue;
    }

    const managerLookup = await lookup(managerUsername);
    rows.push({
      employee,
      employeeStatus: `active=${employeeLookup.user.active}`,
      managerUsername,
      managerMail: managerLookup.outcome === "unique" ? managerLookup.user.mail : null,
      managerCompany: managerLookup.outcome === "unique" ? managerLookup.user.company : null,
      managerDepartment: managerLookup.outcome === "unique" ? managerLookup.user.department : null,
      managerActive: managerLookup.outcome === "unique" ? managerLookup.user.active : null,
      classification: describeManager(managerLookup),
    });
  }

  console.log("Employee       | Employee Active | Referenced Manager | Manager Active | Manager Mail / Company / Dept");
  console.log("-".repeat(120));
  for (const r of rows) {
    console.log(`${r.employee.padEnd(15)} | ${r.employeeStatus.padEnd(16)} | ${(r.managerUsername ?? "(none)").padEnd(19)} | ${String(r.managerActive).padEnd(15)} | ${r.managerMail ?? "-"} / ${r.managerCompany ?? "-"} / ${r.managerDepartment ?? "-"}`);
  }

  console.log("\nDetailed findings and recommended action:\n");
  for (const r of rows) {
    console.log(`- ${r.employee} -> ${r.managerUsername ?? "(no manager claimed)"}: ${r.classification}`);
  }
}

main().catch((err) => {
  console.error("Audit script failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
