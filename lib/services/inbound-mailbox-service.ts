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

const DEFAULT_INITIAL_LOOKBACK_HOURS = 72;

/**
 * INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS — bounds how far back a mailbox's
 * very FIRST poll (no MailboxPollCursor row yet) is allowed to look, so a
 * mailbox with years of history never gets crawled from its oldest message
 * forward (the root cause of a real incident: `new Date(0)` used to be the
 * bootstrap fallback here, which made Graph's `receivedDateTime ge {cursor}`
 * filter match the ENTIRE Inbox, oldest-first). This is a soft, tunable
 * knob (unlike GRAPH_TENANT_ID/etc in microsoft-graph.ts, which are hard
 * requirements with no safe default) — an unset, non-numeric, zero, or
 * negative value NEVER falls back to an effectively-unbounded poll; it
 * falls back to DEFAULT_INITIAL_LOOKBACK_HOURS instead, logged once so a
 * misconfiguration is still visible without breaking ingestion.
 */
function getInitialLookbackHours(): number {
  const raw = process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INITIAL_LOOKBACK_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[inbound-mailbox] INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS="${raw}" is not a positive number — falling back to the default of ${DEFAULT_INITIAL_LOOKBACK_HOURS}h.`
    );
    return DEFAULT_INITIAL_LOOKBACK_HOURS;
  }
  return parsed;
}

/**
 * This mailbox's own persisted polling cursor (see MailboxPollCursor's
 * schema doc comment for the full rationale) — the receivedDateTime
 * boundary processInboundEmails already looked past, regardless of
 * Outlook's own read/unread state.
 *
 * A mailbox never polled before (no row yet) does NOT fall back to the
 * Unix epoch — that previously made the very first poll match this
 * mailbox's ENTIRE historical Inbox (Graph's `$orderby=receivedDateTime
 * asc` then crawled it from the oldest message forward, 50 at a time,
 * every ~2-minute run, silently creating PendingTicket rows for
 * years-old mail). Instead it's bounded to `now - lookbackHours` — see
 * getInitialLookbackHours above. This fallback is recomputed fresh on
 * EVERY call for as long as no row exists (deliberately NOT persisted
 * ahead of time — see this module's own "bootstrap cursor creation"
 * design note below), so a poll that fails before processing a single
 * message (Graph unreachable, every message in the batch errors) simply
 * retries with the SAME kind of bounded, always-recent window next time —
 * it can never regress toward epoch/history, only ever stay within the
 * last `lookbackHours` of the CURRENT wall-clock time.
 *
 * Existing cursors are completely unaffected: a mailbox that already has
 * a MailboxPollCursor row always uses its exact persisted
 * `lastReceivedAt`, regardless of this lookback configuration.
 */
export async function getMailboxPollCursor(mailbox: string): Promise<Date> {
  const row = await prisma.mailboxPollCursor.findUnique({
    where: { mailbox: normalizeMailbox(mailbox) },
    select: { lastReceivedAt: true },
  });
  if (row) return row.lastReceivedAt;
  return new Date(Date.now() - getInitialLookbackHours() * 60 * 60 * 1000);
}

/**
 * Bootstrap cursor creation — chosen design: (A) getMailboxPollCursor
 * above returns the bounded fallback on every call for as long as no row
 * exists, and the row is only ever actually CREATED here, by
 * processInboundEmails' own existing success path, once at least one
 * message in the batch was handled without error (see its own
 * `if (cursorAdvanceTo) await advanceMailboxPollCursor(...)` call — never
 * changed by this fix). Rejected alternative: (B) pre-creating/seeding a
 * row at the bounded timestamp BEFORE the first Graph fetch. B was not
 * chosen because it adds a second place a cursor row can come into
 * existence (with its own partial-failure/rollback edge cases — e.g. the
 * seed write succeeds but the Graph fetch then throws, or vice versa) for
 * no real benefit: A already guarantees the exact same safety property
 * (never advance past unprocessed mail, never regress toward epoch) with
 * zero new code paths, since it reuses the SAME existing advance-on-
 * success logic every other cursor update already goes through.
 */

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
