# Mention Reminders

One reminder notification for a structured @mention in a **Project or Activity Note** (never Ticket Internal Notes) when the mentioned user has not posted a newer Note on the same Project/Activity after the configured delay (default 24h). Only users who can view the entity **and** create a Note there (`project.edit` / `activity.edit`, resolved with `hasEffectiveEntityPermission` against the entity's department) are reminded; view-only users still get the immediate mention notification.

## Worker
`POST /api/internal/mention-reminders/process` with `Authorization: Bearer $CRON_SECRET` (GET also accepted for Vercel Cron). Fails closed (401) in production if `CRON_SECRET` is unset. Idempotent and safe to run concurrently.

- **Docker Compose (Ubuntu):** the `kinsen-helpdesk-mention-reminder-worker` sidecar (curl loop, every 60 s) — `docker compose up -d --build`. Needs `CRON_SECRET` in `.env`. No `tsx`/dev dependencies are required at runtime.
- **Vercel:** `vercel.json` cron `* * * * *`.
- **Manual:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3009/api/internal/mention-reminders/process`

Batches of 50 (max 10 per run), claimed with `FOR UPDATE SKIP LOCKED`; a `PROCESSING` claim older than 10 minutes is re-claimed. Logs only counts and reminder ids.

## Configuration
- Delay: `MentionReminderSettings.delayMinutes` (singleton row `default`, 5 min – 30 days; default 1440). Edited on **Settings → Mention Reminder Settings** (admin only). A change recalculates `PENDING` reminders from the original mention time; it never sends anything.
- User preference: `User.mentionRemindersEnabled` (default true), toggled in the notification bell dropdown via `PATCH /api/users/me/mention-reminders`. Disabling cancels unsent reminders; re-enabling revives nothing.
