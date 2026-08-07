/**
 * Discovers WHICH Graph mailboxes inbound email polling should actually
 * check — the root-cause fix for Department.inboundEmail being only a
 * routing address, never a mailbox Graph itself polled. See
 * lib/ticket-email-service.ts's processInboundEmails, which calls
 * getMailboxesToPoll() below instead of hardcoding a single mailbox.
 *
 * Two kinds of mailbox, each with different downstream routing semantics
 * (see processInboundEmails for how `kind` is used):
 *   - "central": the app-wide support mailbox (getCentralMailbox(),
 *     lib/microsoft-graph.ts). A message fetched here is routed by
 *     RECIPIENT matching (matchDepartmentForRecipients,
 *     lib/services/pending-ticket-service.ts) — this is what makes
 *     aliases/forwarding that ultimately deliver into the central mailbox
 *     keep working exactly as before.
 *   - "department": a specific ACTIVE department's own
 *     Department.inboundEmail. A message fetched here is routed DIRECTLY to
 *     that department — deterministic, never re-derived from Graph
 *     `toRecipients` (which Exchange rules/aliases/forwarding can rewrite).
 *
 * A department whose configured inboundEmail happens to equal the central
 * mailbox address is deliberately NOT added as a second, separate poll
 * target — it's already covered by the central-mailbox poll, and
 * matchDepartmentForRecipients already resolves it correctly via
 * Department.inboundEmail (which is exactly what that address is). Without
 * this de-duplication, the same physical mailbox would be polled twice per
 * run for no benefit.
 */
import { prisma } from "@/lib/prisma";
import { getCentralMailbox } from "@/lib/microsoft-graph";

export interface MailboxToPoll {
  /** Normalized (trim + lowercase) mailbox address to pass to microsoftGraph.getUnreadMessages/markAsRead/moveMessage. */
  email: string;
  kind: "central" | "department";
  departmentId: string | null;
  departmentName: string | null;
}

function normalizeMailbox(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The full, deduplicated set of mailboxes this poll run should check —
 * always includes the central mailbox first, then every ACTIVE
 * department's distinct inboundEmail (inactive departments are never
 * treated as a live intake mailbox, matching the existing rule that an
 * inactive department doesn't accept new tickets at all — see
 * isDepartmentAcceptingTickets, department-scope-service.ts). Department
 * names/addresses are never hardcoded — always read fresh from the DB.
 */
export async function getMailboxesToPoll(): Promise<MailboxToPoll[]> {
  const central = normalizeMailbox(getCentralMailbox());

  const departments = await prisma.department.findMany({
    where: { isActive: true, inboundEmail: { not: null } },
    select: { id: true, name: true, inboundEmail: true },
  });

  const mailboxes: MailboxToPoll[] = [{ email: central, kind: "central", departmentId: null, departmentName: null }];

  const seen = new Set<string>([central]);
  for (const dept of departments) {
    if (!dept.inboundEmail) continue;
    const normalized = normalizeMailbox(dept.inboundEmail);
    if (seen.has(normalized)) continue; // already central, or (DB-unique-enforced) can't collide with another department
    seen.add(normalized);
    mailboxes.push({ email: normalized, kind: "department", departmentId: dept.id, departmentName: dept.name });
  }

  return mailboxes;
}

/**
 * Static (no Graph calls) list of every configured department mailbox, for
 * the admin Email Integration page's always-visible "what's configured"
 * section — cheap DB read, safe to call on every page render. Includes
 * INACTIVE departments too (with `isActive` on each row) so an admin can
 * see a department address that's configured but not currently being
 * polled, and understand why (rather than it silently vanishing from the
 * list). Deliberately separate from getMailboxesToPoll (which is
 * active-only, since that's the actual polling behavior) — this is a
 * visibility/diagnostics query, not a polling-decision query.
 */
export async function listConfiguredDepartmentMailboxes(): Promise<
  Array<{ departmentId: string; departmentName: string; email: string; isActive: boolean }>
> {
  const departments = await prisma.department.findMany({
    where: { inboundEmail: { not: null } },
    select: { id: true, name: true, inboundEmail: true, isActive: true },
    orderBy: { name: "asc" },
  });
  return departments
    .filter((d): d is typeof d & { inboundEmail: string } => !!d.inboundEmail)
    .map((d) => ({ departmentId: d.id, departmentName: d.name, email: normalizeMailbox(d.inboundEmail), isActive: d.isActive }));
}
