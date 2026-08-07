# Email-to-Ticket: Manual Test Checklist

## Current architecture (important — read before testing)

A new inbound email thread **does not** create a real `Ticket` directly. It
creates a **`PendingTicket`** — visible at **Tickets → Pending** — which a
human with the right permission must **Accept** (or **Reject**) before a
real `Ticket` exists. This is deliberate: email intake is a review queue,
not an automatic ticket-creation pipeline. Only a reply that already
references an accepted ticket (`[KIN-N]` in the subject) skips the pending
step and appends straight to that ticket's thread.

Polling now covers **every configured mailbox**, not just one hardcoded
address:
- the **central support mailbox** (`GRAPH_USER_EMAIL`) — messages here are
  routed to a department by matching the recipient address against
  `Department.inboundEmail` (unchanged from before — this is what makes
  aliases/forwarding that ultimately deliver into the central mailbox keep
  working).
- every **active department's own `Department.inboundEmail`**, configured
  from the department's page (Admin → Departments → a department, or
  My Departments) — a message fetched directly from a department's own
  mailbox is routed straight to that department, deterministically, without
  depending on Graph's `toRecipients` (which Exchange rules/aliases can
  rewrite).

See `lib/services/inbound-mailbox-service.ts` for the exact mailbox
discovery/dedup rules and `lib/ticket-email-service.ts`'s
`processInboundEmails` for the per-mailbox processing loop.

## Prerequisites

Set the following environment variables before testing:

```
GRAPH_TENANT_ID=<Azure AD tenant ID>
GRAPH_CLIENT_ID=<App registration client ID>
GRAPH_CLIENT_SECRET=<App registration client secret>
GRAPH_USER_EMAIL=<central support mailbox address>
EMAIL_WEBHOOK_SECRET=<your webhook secret>   # required for the endpoint to accept requests in production — see below
CRON_SECRET=<your cron secret>               # Vercel injects this automatically on Vercel
```

Each Azure app registration used as a mailbox (the central mailbox, and any
department mailbox you intend to poll directly) must be a real,
Graph-accessible Exchange Online mailbox with the app's Application
permissions (`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`) consented against
it. A distribution list or a purely forwarding-only address is **not** a
pollable mailbox — see "Distribution-only / non-mailbox addresses" below;
route those through the central mailbox instead.

Verify connectivity at **Admin → Email → Diagnostics → Test Microsoft
Connection** — this checks the central mailbox AND every configured
department mailbox (active and inactive) in one click, and reports exactly
which ones Graph can/can't reach.

---

## Configuring a department's inbound mailbox

1. Go to the department's page (Admin → Departments → a department, or
   My Departments if you manage that department) and set **Inbound Email**
   to a real mailbox address Graph can access (see Prerequisites above).
2. That's it — no separate "enable polling" step. As soon as it's saved
   (and the department is **active**), the next poll (manual or scheduled)
   includes that mailbox.
3. On **Admin → Email**, the **Department Mailboxes** table shows every
   configured department mailbox, whether it's currently being polled
   (active departments only), and the result of the most recent poll.

An **inactive** department's configured mailbox is shown for visibility but
is **not** polled — matching the existing rule that an inactive department
doesn't accept new tickets at all.

---

## Test Scenarios

### 1. New Email to the Central Mailbox Creates a Pending Ticket

**Steps:**
1. Send an email to the central support mailbox (`GRAPH_USER_EMAIL`) from a
   non-support address (e.g. Gmail).
2. Wait up to ~2 minutes (Vercel Cron, or the Docker Compose `email-poller`
   sidecar — see "Scheduling" below), or click **Poll Now** on the Admin →
   Email page.

**Expected:**
- A new row appears in **Tickets → Pending** with the email's subject
  (leading `Fwd:` / `Re:` stripped) and sender.
- If the recipient address matched a configured `Department.inboundEmail`,
  the pending ticket already shows that department; otherwise it shows
  "Unassigned" and an Admin/Director picks the department at Accept time.
- The Recent Email Log on Admin → Email shows a `New ticket` badge for this
  message, with the mailbox it was fetched from.
- The email is moved to the **Processed** folder in the central mailbox.
- **No real Ticket, no ticket number, and no auto-reply email exist yet.**

### 2. Direct Email to a Department's Own Mailbox Creates a Pending Ticket for That Department

**Steps:**
1. Configure an active department's **Inbound Email** to a real,
   Graph-accessible mailbox (see "Configuring a department's inbound
   mailbox" above).
2. Send an email directly to that address from a non-support address.
3. Wait for the next poll, or click **Poll Now**.

**Expected:**
- A new row appears in **Tickets → Pending** with `departmentId` already
  set to that department — deterministically, regardless of what the
  message's `To`/`Cc` headers say (Exchange rules/aliases/forwarding can
  rewrite those; this routing doesn't depend on them).
- Admin → Email's **Department Mailboxes** table shows this mailbox's last
  poll as successful with a fetched-message count.
- The email is marked read and moved to **Processed** in *that* mailbox
  (not the central one).

### 3. Accepting a Pending Ticket Creates the Real Ticket

**Steps:**
1. Open **Tickets → Pending**, find the pending ticket from scenario 1 or 2.
2. Click **Accept** (choosing a department first if it shows "Unassigned").

**Expected:**
- A real `Ticket` is created with source badge **Email**, using the
  department's own default status/priority.
- The original email body becomes the ticket's first message
  (`direction = INBOUND`), including any attachments.
- The requester receives the ticket-created notification email containing
  `[KIN-N]` in the subject — this is the point a reply-tracking reference
  first exists, not before.
- The pending row's status becomes `ACCEPTED` and disappears from the
  pending queue (visible in its history as accepted).

Rejecting instead (**Reject**) marks it `REJECTED` — no Ticket is ever
created for it, and it's kept for audit, not deleted.

### 4. Reply to an Accepted Ticket Is Appended (No Pending Step)

**Steps:**
1. Reply to the ticket-created notification from scenario 3, keeping
   `[KIN-N]` in the subject.
2. Wait for the next poll or click **Poll Now**.

**Expected:**
- No pending ticket and no new Ticket are created.
- A new message is appended directly to the existing ticket thread.
- The Recent Email Log shows `Reply added`.
- The SSE event `TICKET_MESSAGE_CREATED` fires; the ticket detail page
  updates in real time without a page refresh.

### 5. Duplicate Email Is Skipped (Message-ID Deduplication)

**Steps:**
1. Note the `Message-ID` header from a processed email.
2. Manually trigger the poll again immediately after the email was
   processed.

**Expected:**
- The email is already marked read / moved to Processed, so it won't
  appear in the unread filter again under normal conditions.
- If it's somehow still unread (or the same message is reachable through
  more than one configured mailbox), the system finds the existing
  `PendingTicket`/`TicketMessage` row with the same `emailMessageId` (a
  real database-unique constraint on both) and skips it — this is
  concurrency-safe: even if two poll runs overlap and both pass the initial
  check, the database itself rejects the second insert, and that's treated
  as a normal duplicate-skip, not a broken run.
- The Recent Email Log shows `Duplicate`.
- No duplicate ticket or message is created.

### 6. Auto-Reply / Loop Email Is Skipped

**Steps:**
Option A — Send an email to a monitored mailbox from that same mailbox's
own address.
Option B — Send with header `Auto-Submitted: auto-replied`.
Option C — Send from a `no-reply@*` or `noreply@*` address.

**Expected:**
- No pending ticket created, no reply sent.
- The Recent Email Log shows `Auto-reply`.
- The email is marked read and not retried.

### 7. One Inaccessible Mailbox Doesn't Block the Others

**Steps:**
1. Configure a department's Inbound Email to an address Graph can't
   actually reach (wrong address, or a distribution-list-only address —
   see below).
2. Send a real email to the central mailbox (or another, correctly
   configured department mailbox) at the same time.
3. Trigger a poll.

**Expected:**
- Admin → Email's **Department Mailboxes** table (and **Test Microsoft
  Connection**) show the misconfigured mailbox as failing, with a specific
  error — never silently "nothing happened."
- The central mailbox's email (and any other correctly configured
  department's email) is still processed normally in the *same* run.
- The poll run as a whole is reported with `errors > 0` but is not aborted.

### 8. Failed Email Stays Unread for Retry

**Steps:**
1. Temporarily break the database connection (e.g. an invalid
   `DATABASE_URL` in a staging environment).
2. Send a new email and trigger a poll.

**Expected:**
- Processing that email fails with an exception.
- The email remains **unread** in its mailbox (not moved to Processed) so
  the next poll retries it.
- The Recent Email Log shows `Failed` with the error text.
- The Recent Poll Runs table shows a ✗ (failed) run with `errors ≥ 1`.
- The Admin → Email page shows a **Last error** banner.

### 9. Source Badge Is Visible

**Steps:**
1. Navigate to **Tickets** (all tickets list) after accepting a pending
   email ticket.

**Expected:**
- The **Source** column shows a blue **Email** badge with a mail icon.
- Tickets created from the portal show a gray **Portal** badge.

### 10. Real-Time SSE Update on Email Reply

**Steps:**
1. Open a ticket detail page in a browser tab.
2. Send a reply matching the ticket's `[KIN-N]` reference.
3. Trigger a poll.

**Expected:**
- Without refreshing the page, the new message appears in the ticket
  thread automatically, via the `/api/realtime/stream` SSE stream
  publishing `TICKET_MESSAGE_CREATED`.

---

## Distribution-only / non-mailbox addresses

If an address you'd like to configure as `Department.inboundEmail` is a
distribution list, a purely forwarding rule, or otherwise not a real,
directly Graph-pollable Exchange mailbox, **Test Microsoft Connection**
will show it failing with a specific error (Graph can't open it as a
mailbox) rather than silently doing nothing. In that case, keep using it as
a forwarding target into the central mailbox — recipient-based routing via
`Department.inboundEmail` still works for mail that ultimately lands in the
central mailbox, exactly as it did before per-department direct polling was
added.

---

## Scheduling (how polling is actually triggered)

| Deployment | Mechanism |
|---|---|
| Vercel | `vercel.json`'s cron entry calls `GET /api/email/inbound` every 2 minutes, authenticated with `CRON_SECRET` (Vercel sets this automatically). |
| Docker Compose | The `kinsen-helpdesk-email-poller` service in `docker-compose.yml` calls `POST /api/email/inbound` every ~2 minutes over the internal Docker network, authenticated with `EMAIL_WEBHOOK_SECRET`. It starts automatically with `docker compose up` — no manual cron/curl setup needed. |
| Other self-hosted (no Docker Compose) | Add an equivalent host/server cron entry — see the exact command shown on Admin → Email → Configuration. |
| Any deployment | The **Poll Now** button on Admin → Email always works on demand, authenticated by the signed-in admin's own session. |

**Security note:** `POST /api/email/inbound` requires a valid
`EMAIL_WEBHOOK_SECRET` or `CRON_SECRET` bearer token. In production
(`NODE_ENV=production`), if neither is configured, the endpoint refuses
every request rather than silently allowing unauthenticated polling — set
`EMAIL_WEBHOOK_SECRET` in `.env` before relying on either the Docker
Compose poller or a manual cron entry.

---

## Admin Diagnostics Shortcuts

| Action | Location |
|--------|----------|
| Check env var status | Admin → Email → Configuration |
| See every configured department mailbox + its last poll result | Admin → Email → Department Mailboxes |
| Live-test Graph access to the central mailbox AND every department mailbox | Admin → Email → Diagnostics → Test Microsoft Connection |
| Create a test pending ticket without sending a real email | Admin → Email → Diagnostics → Send Test Email Ticket |
| Manually trigger a poll across all mailboxes | Admin → Email → Poll Now |
| View per-message processing log (including which mailbox each came from) | Admin → Email → Recent Email Log |
