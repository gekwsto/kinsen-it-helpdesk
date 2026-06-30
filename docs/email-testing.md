# Email-to-Ticket: Manual Test Checklist

## Prerequisites

Set the following environment variables before testing:

```
GRAPH_TENANT_ID=<Azure AD tenant ID>
GRAPH_CLIENT_ID=<App registration client ID>
GRAPH_CLIENT_SECRET=<App registration client secret>
GRAPH_USER_EMAIL=kinsenitsupport@kinsen.gr
EMAIL_WEBHOOK_SECRET=<your webhook secret>
CRON_SECRET=<your cron secret>   # Vercel injects this automatically
```

Verify the Microsoft Graph connection at **Admin → Email Settings → Diagnostics → Test Microsoft Connection**.

---

## Test Scenarios

### 1. New Email Creates a Ticket

**Steps:**
1. Send an email to `kinsenitsupport@kinsen.gr` from a non-support address (e.g. Gmail).
2. Wait up to 2 minutes (Vercel Cron), or click **Poll Now** on the admin Email Settings page.

**Expected:**
- A new ticket appears in the Tickets list with source badge **Email**.
- The ticket title matches the email subject (leading `Fwd:` / `Re:` stripped).
- A ticket message is created with `direction = INBOUND`.
- The requester is auto-created if they had no account.
- The sender receives an auto-reply containing `[KIN-N]` in the subject.
- The Recent Email Log shows `New ticket` badge for this message.
- The email is moved to the **Processed** folder in the mailbox.

---

### 2. Reply to Existing Ticket Is Appended

**Steps:**
1. Reply to the auto-reply from scenario 1, keeping `[KIN-N]` in the subject.
2. Wait for the next poll or click **Poll Now**.

**Expected:**
- No new ticket is created.
- A new message is appended to the existing ticket thread.
- The Recent Email Log shows `Reply added` badge.
- The SSE event `TICKET_MESSAGE_CREATED` fires; the ticket detail page updates in real time without a page refresh.

---

### 3. Duplicate Email Is Skipped (Message-ID Deduplication)

**Steps:**
1. Note the `Message-ID` header from a processed email (visible in raw email headers).
2. Manually trigger the poll again immediately after the email was processed.

**Expected:**
- The email is already marked as read / moved to Processed, so it will not appear in the unread filter.
- If somehow still unread: the system finds the existing `TicketMessage` with the same `emailMessageId` and skips it.
- The Recent Email Log shows `Duplicate` badge.
- No duplicate ticket or message is created.

---

### 4. Auto-Reply / Loop Email Is Skipped

**Steps:**
Option A — Send an email to the support mailbox from the same address (`kinsenitsupport@kinsen.gr`).  
Option B — Send with header `Auto-Submitted: auto-replied` (use Postman / curl with raw SMTP injection or a test mail client that supports custom headers).  
Option C — Send from a `no-reply@*` or `noreply@*` address.

**Expected:**
- No ticket created, no reply sent.
- The Recent Email Log shows `Auto-reply` badge.
- The email is marked as read and not retried.

---

### 5. Failed Email Stays Unread for Retry

**Steps:**
1. Temporarily break the database connection (e.g. set `DATABASE_URL` to an invalid value in a staging env, or introduce a deliberate error in a migration).
2. Send a new email and trigger a poll.

**Expected:**
- The email processing fails with an exception.
- The email remains **unread** in the inbox (not moved to Processed) so the next poll retries it.
- The Recent Email Log shows `Failed` badge with the error text.
- The Recent Poll Runs table shows a ✗ (failed) run with `errors = 1`.
- The admin page shows a **Last error** banner.

---

### 6. Source Badge Is Visible

**Steps:**
1. Navigate to **Tickets** (all tickets list).
2. Find a ticket created from email (scenario 1).

**Expected:**
- The **Source** column shows a blue **Email** badge with a mail icon.
- Tickets created from the portal show a gray **Portal** badge.
- The ticket detail page also shows the source badge next to the ticket number.

---

### 7. Real-Time SSE Update on Email Reply

**Steps:**
1. Open a ticket detail page in a browser tab.
2. In a second terminal / email client, send a reply that matches the ticket's `[KIN-N]` reference.
3. Trigger a poll (click **Poll Now** or wait for cron).

**Expected:**
- Without refreshing the page, the new message appears in the ticket thread automatically.
- This is driven by the SSE stream (`/api/realtime/stream`) publishing `TICKET_MESSAGE_CREATED`.

---

## Admin Diagnostics Shortcuts

| Action | Location |
|--------|----------|
| Check env var status | Admin → Email Settings → Configuration |
| Test Graph token + mailbox | Admin → Email Settings → Diagnostics → Test Microsoft Connection |
| Create test ticket without real email | Admin → Email Settings → Diagnostics → Send Test Email Ticket |
| Manually trigger poll | Admin → Email Settings → Poll Now |
| View processing log | Admin → Email Settings → Recent Email Log |
