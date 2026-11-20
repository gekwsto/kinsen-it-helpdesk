# External Integrations — Server-to-Server Ticket Creation

Lets another internal application create real TicketApp tickets automatically
(e.g. when a business event fires in that app) without a human ever signing
into TicketApp. This is a wholly separate authentication path from the
browser/session-based UI — the API key identifies an **application**, not a
person, and the ticket's real requester is always resolved from the email you
send in the request body.

## Authentication

Every request must carry:

```
Authorization: Bearer <your-api-key>
```

- Keys are issued and rotated by a TicketApp Administrator at **Admin →
  Integrations** (`/admin/integrations`). Each integration is pinned to one
  TicketApp department — every ticket it creates lands in that department;
  there is no way to choose or override this from the request.
- The raw key is shown **exactly once**, at creation or rotation time. If you
  lose it, an admin must rotate it (which invalidates the old one) — TicketApp
  never stores or can show the raw key again.
- Missing/malformed/unknown/wrong key → `401 invalid_api_key`.
- A disabled integration's key → `403 integration_disabled`.

### Keeping the key safe

`TICKET_APP_API_KEY` is a **server-only secret**:

- Never put it in a `NEXT_PUBLIC_*` env var, browser bundle, mobile app
  binary, or any client-side source.
- Store it the same way you'd store a database password (server env var /
  secrets manager).
- If the ticket-creation trigger is a button/flag in a browser UI, **the
  browser must call your own backend**, and your backend calls TicketApp —
  the browser never talks to TicketApp directly.

## Endpoint

```
POST /api/integrations/tickets
Content-Type: application/json
Authorization: Bearer <your-api-key>
```

### Request body

```json
{
  "externalReferenceId": "vehicle-app:incident:99114",
  "requesterEmail": "user@kinsen.gr",
  "requesterName": "Optional User Name",
  "requesterMicrosoftUserId": "optional-entra-oid",
  "requesterTenantId": "optional-entra-tid",
  "title": "Vehicle application error",
  "description": "The user received an error while opening vehicle 99114.",
  "sourceUrl": "https://application.example.com/vehicles/99114",
  "categoryId": "optional-department-category-id",
  "priorityId": "optional-department-priority-id",
  "subDepartmentId": "optional-subdepartment-id",
  "metadata": { "vehicleId": 99114, "plate": "ABC1234", "environment": "production" }
}
```

| Field                  | Required | Notes |
|------------------------|----------|-------|
| `externalReferenceId`  | yes      | Your own idempotency key for this business event (e.g. `"<app>:<entity>:<id>"`). Trimmed, 1–200 chars. Drives duplicate-ticket prevention — see below. |
| `requesterEmail`       | yes      | The real end user who hit the problem. Always required, even when the two Entra fields below are also sent. Normalized (trimmed + lowercased). |
| `requesterName`        | no       | Only used if a new user is created. |
| `requesterMicrosoftUserId` | no   | The requester's Entra ID `oid` claim. See "Entra ID requester identity" below — when present, this (not email) becomes the primary identity signal. |
| `requesterTenantId`    | required if `requesterMicrosoftUserId` is sent | The requester's Entra `tid` claim. Must match this TicketApp server's own configured Entra tenant, or the request is rejected (`422 tenant_mismatch`) — this is a safety check, not a multi-tenant feature. |
| `title`                | yes      | Same lower bound as the web ticket form, 5–200 chars. |
| `description`          | yes      | 10–50,000 chars. |
| `sourceUrl`            | no       | Deep link back to the record in your app. Must be `http(s)` (real URL parsing, not a regex), max 2000 chars, and must not contain embedded credentials (`https://user:pass@host/...` is rejected). If the integration has a configured `baseUrl`, `sourceUrl` must share its exact origin (scheme+host+port) — a mismatch is rejected, not silently accepted. Never fetched server-side (only stored and rendered as a clickable link), so it introduces no SSRF surface — localhost/private-network URLs are accepted for this reason. |
| `categoryId`           | no       | Must be an **active** category belonging to the integration's department, or it's rejected (never silently swapped for the department default). Omit to use the integration's configured default, if any. |
| `priorityId`           | no       | Same rule as `categoryId`. Omitted and no integration default → falls back to the department's own lowest-severity active priority. |
| `subDepartmentId`      | no       | Must belong to the integration's department. |
| `metadata`             | no       | A flat JSON object, ≤10KB serialized. Arrays/non-objects are rejected. Shown in the ticket detail UI as a compact key/value list — never executed or rendered as HTML. |

Unknown fields (e.g. `departmentId`, `requesterId`, `statusId`,
`assignedAgentId`, `source`) are rejected outright — the schema is `.strict()`.
There is no way to set those from the request; they're always derived
server-side from the integration and department configuration.

### Response

**201 — a new ticket was created:**

```json
{
  "success": true,
  "created": true,
  "ticket": { "id": "clx...", "ticketNumber": 1234, "url": "https://your-ticketapp-domain/tickets/clx..." }
}
```

**200 — this `externalReferenceId` was already used for this integration
(idempotent replay):**

```json
{
  "success": true,
  "created": false,
  "ticket": { "id": "clx...", "ticketNumber": 1234, "url": "https://your-ticketapp-domain/tickets/clx..." }
}
```

`ticket.url` is always a complete, absolute HTTPS link — built server-side
from the app's own configured `APP_URL` (never from the request's `Host` or
`X-Forwarded-*` headers, which a caller could spoof). It resolves to the
real ticket detail page and is safe to use directly as a hyperlink (e.g. in
a chat message or notification) — opening it still requires the viewer to
be signed in and have permission to see that ticket, exactly like any other
TicketApp link.

No second `TicketMessage`/`TicketHistory` row is created on replay — you get
back the same ticket every time you retry with the same
`externalReferenceId`, **provided the payload matches what was originally
sent** (see Idempotency & retries below for the conflict case). This also
holds under concurrent retries: TicketApp relies on a database-level unique
constraint on `(integrationId, externalReferenceId)`, not just an initial
existence check, so two simultaneous requests for the same reference can
never create two tickets — the loser of the race gets the winner's ticket
back with `created: false`.

### Error codes

All errors use the shared `{ code, error, message, field?, fieldErrors? }` shape.

| HTTP | code                              | Meaning |
|------|-----------------------------------|---------|
| 400  | `validation_failed`               | Malformed JSON body. |
| 401  | `invalid_api_key`                 | Missing, malformed, or unrecognized API key. |
| 403  | `integration_disabled`            | The key is valid but the integration has been disabled. |
| 409  | `idempotency_conflict`            | `externalReferenceId` matches an existing ticket, but the payload differs from the original request (see below) — `fieldErrors` lists which fields don't match. |
| 409  | `requester_identity_conflict`     | `requesterMicrosoftUserId` and `requesterEmail` resolve to two different existing TicketApp users — never silently guessed, see below. |
| 422  | `tenant_mismatch`                 | `requesterTenantId` doesn't match this server's configured Entra tenant. |
| 413  | `validation_failed`               | Request body too large (over 128KB). |
| 422  | `validation_failed`               | Body failed schema validation (see `field`/`fieldErrors`). |
| 422  | `source_url_origin_mismatch`      | `sourceUrl` doesn't share the integration's configured `baseUrl` origin. |
| 422  | `subdepartment_department_mismatch` | `subDepartmentId` doesn't belong to the integration's department. |
| 422  | `category_department_mismatch`    | `categoryId` isn't an active category in the integration's department. |
| 422  | `priority_department_mismatch`    | `priorityId` isn't an active priority in the integration's department. |
| 422  | `configuration_required`          | The integration's department has no active default ticket status configured — an admin needs to fix department configuration before this integration can create tickets. |
| 429  | `rate_limited`                    | Too many requests from this integration. Respect the `Retry-After` header before retrying. |
| 503  | `configuration_required`          | The server itself isn't configured to authenticate integration keys (missing `INTEGRATION_KEY_PEPPER`), or `APP_URL` is misconfigured — an operational issue on TicketApp's side, not something your request can fix. No ticket is created when this happens. |
| 500  | `internal_error`                  | Unexpected server error. |

## Requester resolution

`requesterEmail` is normalized (trimmed, lowercased) and looked up against
existing TicketApp users:

- **Existing user** → reused as-is. Their role, department, custom role, and
  auth settings are never modified by this endpoint, and an inactive user is
  never reactivated.
- **No match** → a new `User` is created with that email (+ `requesterName`
  if given), default role (`USER`), active, no elevated permissions — the
  same standing a self-registered user gets.

This is the whole resolution path when `requesterMicrosoftUserId` is
omitted. Existing integrations that have never heard of the Entra fields
below are completely unaffected by any of this.

## Entra ID requester identity

For an integration that runs inside a Microsoft Entra ID-authenticated
environment (e.g. an internal AI agent acting on behalf of signed-in
employees), send `requesterMicrosoftUserId` (the Entra `oid` claim) and
`requesterTenantId` (the Entra `tid` claim) alongside `requesterEmail`.
When present, the `oid` — not the email — becomes the primary identity
signal, resolved in this order:

1. **Tenant check first.** `requesterTenantId` must equal this TicketApp
   server's own configured Entra tenant
   (`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` — the same value that already
   pins TicketApp's own Microsoft sign-in). A mismatch is rejected
   (`422 tenant_mismatch`) before anything else happens — no ticket, no
   user lookup.
2. **Resolve by `oid`.** If a TicketApp user is already linked to this
   exact `oid`, that user is used — and if the `requesterEmail` you sent
   doesn't match that user's real email, the request is rejected
   (`409 requester_identity_conflict`) rather than silently preferring
   one signal over the other.
3. **Fall back to `requesterEmail`.** Not found by `oid`? If an existing
   user matches the email instead, that `oid` is linked onto it (so the
   next request for the same person resolves directly by `oid`) — unless
   that user is already linked to a **different** `oid`, which is the
   same kind of conflict as above and is rejected the same way, never
   silently relinked.
4. **Create.** Neither `oid` nor email matched anything → a new `User` is
   created with both set, same default standing as the email-only path
   above.

**What this does and does not prove.** TicketApp has no way to verify
that an `oid`/`tid` it's sent actually came from a real, currently valid
Entra ID token — that verification is entirely your responsibility,
**before** calling this endpoint:

- Your backend must derive `requesterMicrosoftUserId`, `requesterTenantId`,
  `requesterEmail`, and `requesterName` from its own cryptographically
  validated Entra ID session for that employee (signature, issuer,
  audience, expiry all checked on your side) — **never** from chat text,
  never from anything the employee typed, and never trusted merely
  because it was present in a request.
- The `Authorization: Bearer <api-key>` header is what authenticates
  **this integration** to TicketApp — it proves "a request came from the
  system an admin already approved," not "this specific employee is who
  they claim to be." That second guarantee is yours to provide by only
  ever sending identity fields sourced from a session you've already
  validated.
- TicketApp's own, mechanical guarantees on top of the API key are
  exactly the two things above: the tenant check, and never silently
  resolving a conflicting `oid`/email pair. Nothing more can be enforced
  server-side without TicketApp itself re-validating a token, which this
  endpoint deliberately does not do.
- No Microsoft Graph call is ever made by this endpoint — identity
  resolution only reads data TicketApp's own prior sign-ins or its
  tenant-wide directory sync have already stored locally.

## Idempotency & retries

Always send the same `externalReferenceId` for retries of the same business
event (e.g. your own outbox/job retry logic). Sending a different
`externalReferenceId` for what you consider "the same" event will create a
second, separate ticket — TicketApp has no way to know they're related unless
you tell it via the reference id.

`externalReferenceId` identifies a single, immutable creation event. Once a
ticket exists for a given `(your integration, externalReferenceId)` pair:

- A retry with the **same** `title`/`description`/`requesterEmail` and any
  `sourceUrl`/`categoryId`/`priorityId`/`metadata` you included is treated as
  a genuine replay → `200`, the original ticket is returned unchanged. It is
  **never** mutated by a replay, no matter how many times you retry.
- A retry with the same `externalReferenceId` but a **different** value for
  any of those fields is rejected with `409 idempotency_conflict` — this
  almost always means a caller-side bug (e.g. accidentally reusing a
  reference id for a different event, or retrying with an edited payload).
  The original ticket is left exactly as it was; nothing is silently
  overwritten. `fieldErrors` in the response names which field(s) didn't match.
  Fields you omit on a retry are never compared (omitting a field isn't an
  assertion that it changed).

## Attachments

```
POST /api/integrations/tickets/{ticketId}/attachments
Content-Type: multipart/form-data
Authorization: Bearer <your-api-key>

file: <binary — required>
externalAttachmentId: <string, optional, 1–200 chars>
```

- `{ticketId}` must be a ticket **this same integration created** —
  belonging to the integration's department is not enough; a ticket
  created by a human, by a different integration, or via email is always
  rejected with `404` (the same response as a ticket id that doesn't exist
  at all — this endpoint never confirms whether some other integration's
  ticket id exists).
- `file` is validated against the exact same size cap (10MB) and allowed
  MIME-type list as every other attachment upload in TicketApp.
- `externalAttachmentId` is your own idempotency key for this one
  attachment (independent of the ticket's own `externalReferenceId`).
  Recommended for any upload your side might retry. Omit it and every call
  is treated as a brand-new attachment — no deduplication is attempted.

### Response

**201 — a new attachment was stored:**

```json
{ "success": true, "created": true, "attachment": { "id": "clx...", "originalName": "invoice.pdf", "mimeType": "application/pdf", "size": 48213, "createdAt": "2026-11-20T12:00:00.000Z" } }
```

**200 — `externalAttachmentId` was already used, with byte-identical
content (idempotent replay) — no second attachment is created:**

```json
{ "success": true, "created": false, "attachment": { "id": "clx...", "...": "..." } }
```

**409 `idempotency_conflict` — `externalAttachmentId` was already used,
but with a DIFFERENT file this time.** The original attachment is left
exactly as it was; nothing is overwritten or duplicated. Use a new
`externalAttachmentId` if this is genuinely a different attachment.

This endpoint is safe under real concurrent retries, not just sequential
ones: two simultaneous requests sharing the same `externalAttachmentId`
can never both succeed and can never produce two attachments — one
request is always serialized behind the other at the database level, and
the result (200/201/409) is decided from the actual stored file content,
not merely from whether the key was seen before.

| HTTP | code                  | Meaning |
|------|-----------------------|---------|
| 400  | `validation_failed`   | No `file` field, or the body isn't valid multipart/form-data. |
| 401  | `invalid_api_key`     | Missing, malformed, or unrecognized API key. |
| 403  | `integration_disabled`| The key is valid but the integration has been disabled. |
| 404  | `not_found`           | The ticket doesn't exist, or wasn't created by this integration. |
| 409  | `idempotency_conflict`| Same `externalAttachmentId`, different file content. |
| 413  | `validation_failed`   | File exceeds the 10MB cap. |
| 422  | `validation_failed`   | Disallowed MIME type, or `externalAttachmentId` over 200 chars. |
| 429  | `rate_limited`        | Too many requests from this integration. Respect the `Retry-After` header before retrying. Independent of the ticket-creation endpoint's own limit. |
| 500  | `storage_error`       | A write/verification failure on TicketApp's side. |
| 503  | `storage_error`       | Attachment storage is not currently verified as durable — retry later. |

## API key rotation

From **Admin → Integrations**, click the key icon on an integration to
rotate it. This immediately generates a new key and invalidates the old one
— any in-flight caller still using the old key starts getting
`401 invalid_api_key` right away. Update your stored secret with the new key
before or as part of the same maintenance window as the rotation.

## Examples

### curl

```bash
curl -X POST "https://your-ticketapp-domain/api/integrations/tickets" \
  -H "Authorization: Bearer $TICKET_APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalReferenceId": "vehicle-app:incident:99114",
    "requesterEmail": "user@kinsen.gr",
    "requesterName": "Optional User Name",
    "title": "Vehicle application error",
    "description": "The user received an error while opening vehicle 99114.",
    "sourceUrl": "https://application.example.com/vehicles/99114",
    "metadata": { "vehicleId": 99114, "plate": "ABC1234", "environment": "production" }
  }'
```

### TypeScript (server-side only)

```ts
// Runs on YOUR backend — never in browser code. TICKET_APP_API_KEY is a
// server-only secret, read from your own server's environment.
async function createTicketAppTicket(input: {
  externalReferenceId: string;
  requesterEmail: string;
  requesterName?: string;
  // Only send these from identity fields you already derived from your
  // OWN validated Entra ID session — never from chat text or user input.
  requesterMicrosoftUserId?: string;
  requesterTenantId?: string; // required together with requesterMicrosoftUserId
  title: string;
  description: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}) {
  const res = await fetch(`${process.env.TICKET_APP_URL}/api/integrations/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TICKET_APP_API_KEY}`,
    },
    body: JSON.stringify(input),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`TicketApp ticket creation failed: ${body.code} — ${body.message}`);
  }
  return body as { success: true; created: boolean; ticket: { id: string; ticketNumber: number; url: string } };
}
```

## Architecture notes (for TicketApp maintainers)

- The integration endpoint deliberately does **not** call the existing
  session-based `POST /api/tickets` internally, and never constructs a fake
  `User`/NextAuth session for the API key. Both endpoints instead share one
  persistence layer, `lib/services/ticket-creation-service.ts`
  (`createTicketAtomic`), which atomically creates the `Ticket` + initial
  `TicketMessage` + initial `TicketHistory` row via `prisma.$transaction` —
  each caller resolves its own permissions/department/defaults first, then
  calls the same persistence function, so the two paths can never silently
  diverge on what a "ticket creation" actually writes.
- API keys: `crypto.randomBytes(32)` (256 bits), stored as
  `HMAC-SHA256(rawKey, INTEGRATION_KEY_PEPPER)` + a short lookup prefix —
  never the raw key. Verification hashes the candidate and compares with
  `crypto.timingSafeEqual`. See `lib/services/integration-key-service.ts`.
- Requester resolution: `lib/services/requester-resolution-service.ts`,
  reusable by other flows that need the same "find or create a User by
  email" behavior (e.g. inbound email) without behavioral regression.
- Attachment idempotency (`lib/services/integration-attachment-service.ts`):
  reuses `TicketAttachment.sourceAttachmentId` (no schema migration) with a
  PostgreSQL advisory transaction lock (`pg_advisory_xact_lock`) keyed by
  `(ticketId, externalAttachmentId)` for true mutual exclusion under real
  concurrent retries — a plain "check then insert" would still race two
  simultaneous requests, since that column has no unique constraint. See
  that file's own doc comment for the full design rationale.
- **Rate limiting** (`lib/services/integration-rate-limiter.ts`): a
  minimal in-process, per-integration, fixed-window counter — applied
  only AFTER a request's API key has already verified successfully, so
  an invalid/unknown key can never grow this module's state. Ticket
  creation and attachment upload each have their own independent bucket
  per integration (an integration exhausting one never affects the
  other). Safe as a plain in-memory structure specifically because
  production runs as exactly one `kinsen-helpdesk` app container (see
  `docker-compose.yml` — no `deploy.replicas`, no multi-instance load
  balancing); if that topology ever changes, this module's state would
  need to move to a shared store. Exceeding the limit returns
  `429 rate_limited` with a `Retry-After` header.
- **APP_URL validation** (`lib/services/app-url-service.ts`): the
  ticket-creation route validates `APP_URL` (real URL parsing, HTTPS
  required in production, HTTP permitted only for localhost/non-
  production) BEFORE creating anything — a misconfigured value returns
  `503 configuration_required` and no ticket is ever created by that
  request. `.origin` is used to build every link, which also normalizes
  away any trailing slash or stray path an operator might have
  mistakenly included in `APP_URL`.
- **Entra identity resolution** (`lib/services/requester-resolution-service.ts`'s
  `resolveOrCreateRequesterByEntraIdentity`): reuses `User.microsoftUserId`
  (already populated by ordinary Microsoft sign-in and by the tenant-wide
  directory sync — no new column) and the SAME oid-first/email-fallback/
  conflict-detection order `lib/services/organization-directory-sync-service.ts`
  already uses tenant-wide, minus that function's Graph-dependent
  organizational-placement logic (irrelevant here — a ticket's department
  always comes from the integration's own binding). Every linking/creation
  write is race-safe against a concurrent call for the same or a
  conflicting identity, using `User.email`/`User.microsoftUserId`'s real
  unique constraints as the actual backstop, never just an initial read.
- **Middleware transport bypass** (`lib/auth.config.ts`'s
  `PUBLIC_API_TRANSPORT_PATH_PATTERNS`): both this endpoint and the
  attachment endpoint are reachable without a browser session via
  precise, anchored regex patterns — never a prefix/`startsWith` match,
  so `/api/admin/integrations/**` (session + `integration.manage`
  protected) can never be accidentally exposed by a broadened pattern.
  Bearer API-key verification inside each route handler remains the real
  authentication boundary either way; this only controls whether an
  unauthenticated request reaches that handler at all, or gets
  redirected to `/login` before ever doing so.
