# Microsoft Directory Sync Module — Setup & Permission Model

TicketApp has **one Microsoft Directory Sync module**. Its job is singular: keep TicketApp's `DepartmentMembership` and `MicrosoftDepartmentMapping` data aligned with the real department data in Microsoft/Entra. It does this through **two Graph operations** — not two unrelated systems — each with its own token type, permission, and trigger, because Microsoft Graph itself requires that separation (a user's own delegated token cannot list the whole tenant; an app-only token isn't needed to read one user's own profile). Failing one operation never affects the other — they run independently, at different times, for different reasons.

## Operation A — current user department sync (`/me`)

- **Endpoint:** `GET https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,department,jobTitle`
- **Token type:** delegated — the signed-in user's own access token, obtained via the sign-in OAuth flow.
- **Permission:** `User.Read` (delegated), already requested by the Microsoft Entra ID sign-in provider — no extra Azure setup needed.
- **Purpose:** reads *only the department of the user who just logged in*, once per login, and resolves it through `MicrosoftDepartmentMapping` to create/update that one user's `DepartmentMembership`.
- **Runs:** only inside the Microsoft login sync path — never on page render, never on a modal open, never for any user other than the one currently signing in.
- **Code:** `lib/services/microsoft-graph-profile-service.ts`, called from `lib/services/microsoft-department-sync-service.ts`, invoked only from the `jwt` callback in `lib/auth.ts` on Microsoft sign-in.
- **If it fails:** that login's `DepartmentMembership` sync is skipped for that user (login itself still succeeds). It has **no effect** on the cached dropdown values Operation B maintains — those are a separate table, untouched by this operation.

## Operation B — admin-triggered company directory discovery (`/users`)

- **Endpoint:** `GET https://graph.microsoft.com/v1.0/users?$select=id,department&$top=999`, paged via `@odata.nextLink`.
- **Token type:** application (client-credentials) — the app's own identity, not any particular user's.
- **Permission:** **`Directory.Read.All`** (Microsoft Graph **Application** permission — not delegated), with **admin consent**.
- **Purpose:** reads every user in the tenant to collect the distinct set of `department` string values, so the "Microsoft Value" dropdown on `/admin/microsoft-mappings` (Source Type = Profile Department) offers admins an exact value to pick instead of hand-typing one — the same values Operation A will later match against `MicrosoftDepartmentMapping`.
- **Runs:** only when a System Admin clicks **Sync** on `/admin/microsoft-mappings` (`POST /api/admin/microsoft-directory/departments/sync`, `requireAdmin()`-gated). **Never** during any user's login, never on page render, never on modal open, never on a workspace switch — this module never scans the tenant as a side effect of anything a regular user does.
- **Code:** `lib/services/microsoft-directory-service.ts`, called only from that one admin route.
- **If it fails:** the admin sees a clear error and the cached dropdown simply doesn't refresh (falls back to whatever was last synced, or manual entry). It has **no effect** on login — Operation A does not depend on Operation B or its cache in any way.

## Why "one module, two operations" matters

Both operations feed the same two tables (`DepartmentMembership`, `MicrosoftDepartmentMapping`) toward the same goal — Microsoft directory data driving TicketApp's department access — but at different scopes and cadences: Operation A applies it to one user, on every login; Operation B refreshes the admin's picklist of known values, only when explicitly triggered. Neither is a fallback or a replacement for the other, and **`Directory.Read.All` is never required for normal login** — only Operation B needs it, and only an admin ever triggers Operation B.

Both operations use the same underlying app registration and tenant as the app's other Microsoft integrations (`AUTH_MICROSOFT_ENTRA_ID_ID`/`GRAPH_CLIENT_ID` are the same value in this deployment), but Operation B's permission is **additional** on top of Operation A's — not implied by it, and not required for it.

## Required Azure setup for Operation B

Without this, the "Sync" button on `/admin/microsoft-mappings` will fail with a 403, surfaced as: *"Microsoft Graph Directory.Read.All application permission with admin consent is required to sync tenant department values."* This **does not** break login or Operation A — they are unaffected, by design.

Steps, in [Microsoft Entra admin center](https://entra.microsoft.com):

1. Go to **Microsoft Entra admin center**.
2. **App registrations**.
3. Select the App Registration used by `GRAPH_CLIENT_ID` (same registration used for mailbox polling — see `lib/microsoft-graph.ts`).
4. **API permissions**.
5. **Add a permission**.
6. **Microsoft Graph**.
7. **Application permissions** (not Delegated).
8. Add **`Directory.Read.All`**.
9. **Grant admin consent for the tenant.**

Existing permissions on this app registration (`Mail.Read`, `Mail.Send`, `Mail.ReadWrite`, all Application) are untouched — `Directory.Read.All` is added alongside them, not instead of them. Operation A's `User.Read` (delegated) needs no change at all.

## Env vars used (same three as mailbox polling and Operation B, no new vars needed)

```
GRAPH_TENANT_ID=<Azure AD tenant ID>
GRAPH_CLIENT_ID=<App registration client ID — same registration as above>
GRAPH_CLIENT_SECRET=<App registration client secret>
```

## Error handling (Operation B)

`fetchAllGraphUserDepartments()` (`lib/services/microsoft-directory-service.ts`) never throws — every failure is a typed result, mapped to an admin-facing message by `app/api/admin/microsoft-directory/departments/sync/route.ts`:

| Graph response | Reason code | Admin sees |
|---|---|---|
| No token obtainable / network failure | `network_error` | "Could not reach Microsoft Graph..." |
| 401 | `unauthorized` | "Microsoft Graph rejected the app credentials — verify GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/GRAPH_TENANT_ID." |
| 403 | `no_permission` | The `Directory.Read.All` + admin consent message above, with a pointer to this doc. |
| 429 | `rate_limited` | "Microsoft Graph is throttling requests..." |
| 5xx | `server_error` | "Microsoft Graph returned a server error..." |
| Non-JSON / missing `value` array | `malformed_response` | "Microsoft Graph returned an unexpected response shape." |

Never logged, anywhere in this module (either operation): access tokens, the client secret, or raw Graph response bodies. Only safe metadata is logged — `reason`, HTTP `status`, and on success `discovered`/`added`/`updated`/`staled` counts (see `console.warn`/`console.log` calls in `microsoft-directory-service.ts`).

## Caching (Operation B only — Operation A has no cache, it's live per login)

Values Operation B discovers are cached in the `MicrosoftDirectoryDepartmentValue` table — never queried live from Graph on page render or dialog open. A sync (admin-triggered only) upserts every currently-seen value and marks previously-seen-but-now-absent values `isActive: false` (never deletes — self-healing on the next sync, audit trail preserved). `GET /api/admin/microsoft-directory/departments` and the mapping dialog's dropdown both read only this cache.

## Manual fallback

The mapping dialog's "Enter value manually" checkbox is a fallback for when Operation B hasn't run yet or `Directory.Read.All` isn't granted — it is not the primary flow. A manually-typed value must be an **exact** match (casing and spacing included) with what Operation A will later read from `user.department` for the mapping to actually resolve at login; the UI says so inline when manual entry is selected.
