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
| `requesterEmail`       | yes      | The real end user who hit the problem. Normalized (trimmed + lowercased) and matched against/created as a TicketApp `User`. |
| `requesterName`        | no       | Only used if a new user is created. |
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
  "ticket": { "id": "clx...", "ticketNumber": 1234, "url": "/tickets/clx..." }
}
```

**200 — this `externalReferenceId` was already used for this integration
(idempotent replay):**

```json
{
  "success": true,
  "created": false,
  "ticket": { "id": "clx...", "ticketNumber": 1234, "url": "/tickets/clx..." }
}
```

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
| 413  | `validation_failed`               | Request body too large (over 128KB). |
| 422  | `validation_failed`               | Body failed schema validation (see `field`/`fieldErrors`). |
| 422  | `source_url_origin_mismatch`      | `sourceUrl` doesn't share the integration's configured `baseUrl` origin. |
| 422  | `subdepartment_department_mismatch` | `subDepartmentId` doesn't belong to the integration's department. |
| 422  | `category_department_mismatch`    | `categoryId` isn't an active category in the integration's department. |
| 422  | `priority_department_mismatch`    | `priorityId` isn't an active priority in the integration's department. |
| 422  | `configuration_required`          | The integration's department has no active default ticket status configured — an admin needs to fix department configuration before this integration can create tickets. |
| 503  | `configuration_required`          | The server itself isn't configured to authenticate integration keys (missing `INTEGRATION_KEY_PEPPER`) — an operational issue on TicketApp's side, not something your request can fix. |
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
