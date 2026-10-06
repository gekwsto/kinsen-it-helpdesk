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
  /** Normalized (trim + lowercase) mailbox address to pass to microsoftGraph.getMessagesSince / getMailboxPollCursor / advanceMailboxPollCursor. */
  email: string;
  kind: "central" | "department";
  departmentId: string | null;
  departmentName: string | null;
}

function normalizeMailbox(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * This mailbox's own persisted polling cursor (see MailboxPollCursor's
 * schema doc comment for the full rationale) — the receivedDateTime
 * boundary processInboundEmails already looked past, regardless of
 * Outlook's own read/unread state. A mailbox never polled before has no
 * row yet: defaults to the Unix epoch, so the very first poll sees
 * whatever's currently in that mailbox's Inbox (bounded by
 * getMessagesSince's own `top`) rather than silently skipping a
 * pre-existing backlog.
 */
export async function getMailboxPollCursor(mailbox: string): Promise<Date> {
  const row = await prisma.mailboxPollCursor.findUnique({
    where: { mailbox: normalizeMailbox(mailbox) },
    select: { lastReceivedAt: true },
  });
  return row?.lastReceivedAt ?? new Date(0);
}

/**
 * Advances (never rewinds — see the explicit max() below) this mailbox's
 * poll cursor to `newCursor`. Called by processInboundEmails only up to
 * the receivedDateTime of the last message it handled WITHOUT hitting a
 * processing error in this run — a failed message, and everything
 * chronologically after it in the same batch, is deliberately left for the
 * next poll to retry (see that function's own doc comment for the exact
 * rule). The max()-against-current-value guard additionally protects
 * against two overlapping poll runs for the same mailbox ever moving this
 * cursor backward.
 */
export async function advanceMailboxPollCursor(mailbox: string, newCursor: Date): Promise<void> {
  const normalized = normalizeMailbox(mailbox);
  // GREATEST(existing, new) semantics via plain Prisma Client calls — never
  // raw SQL here: a Date bound through $executeRaw against this column
  // (TIMESTAMP(3), no time zone) was observed to land shifted by the
  // server's local UTC offset instead of the exact UTC instant, a real bug
  // caught by this file's own test. updateMany's `lt` guard only ever
  // touches a row whose current value is OLDER than newCursor, so two
  // overlapping poll runs for the same mailbox can never move this cursor
  // backward — whichever commits second simply matches zero rows.
  const { count } = await prisma.mailboxPollCursor.updateMany({
    where: { mailbox: normalized, lastReceivedAt: { lt: newCursor } },
    data: { lastReceivedAt: newCursor },
  });
  if (count === 0) {
    // Either this mailbox has no row yet (create it), or it does but its
    // value is already >= newCursor (confirmed by updateMany above
    // matching zero rows) — upsert's `update` branch is then a deliberate
    // no-op, never regressing an already-newer cursor.
    await prisma.mailboxPollCursor.upsert({
      where: { mailbox: normalized },
      create: { mailbox: normalized, lastReceivedAt: newCursor },
      update: {},
    });
  }
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
