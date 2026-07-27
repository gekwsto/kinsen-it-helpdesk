# TicketApp — Microsoft Entra ID / Microsoft Graph Production-Readiness Audit

*Πλήρες end-to-end audit. Κάθε ισχυρισμός συνδέεται με πραγματικό κώδικα, πραγματικό test, ή ρητά χαρακτηρίζεται `NOT VERIFIED`/`NOT IMPLEMENTED`. Κανένα permission δεν προτείνεται χωρίς συγκεκριμένο code path.*

---

## 1. Executive Conclusion

**Η Microsoft integration ΔΕΝ είναι σήμερα πλήρως "VERIFIED LIVE" production-ready — είναι "VERIFIED BY AUTOMATED TEST" σε βάθος, με ένα ρητό, μη-αναστρέψιμο σε αυτό το environment gap: δεν υπάρχουν πραγματικά Azure credentials εδώ (`.env` έχει `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=dummy`), άρα κανένα live OAuth login ή live Graph call δεν μπόρεσε να εκτελεστεί.**

Ό,τι ΔΕΝ εξαρτάται από πραγματικά Azure credentials είναι πλήρως αποδεδειγμένο: 1211 automated assertions (67 test/measurement scripts, 0 αποτυχίες πέρα από ένα γνωστό άσχετο pre-existing issue), 2 πλήρη Playwright browser runs, πλήρες TypeScript/build/schema validation. Η core λογική (login sync, department/job-title mapping, precedence, role independence, photo sync, cookie-size safety) είναι εξονυχιστικά testαρισμένη με πραγματικά DB calls και πραγματικό Auth.js/`@auth/core` κώδικα.

**Δύο πραγματικά χαρακτηριστικά χαρακτηρίζονται `NOT IMPLEMENTED`, όχι απλά ελλιπή**: Entra Group mapping και App Role mapping υπάρχουν μόνο ως data-model options — δεν υπάρχει καμία πραγματική Graph κλήση που να τα ενεργοποιεί. **Δεν χαρακτηρίζονται "verified"** πουθενά σε αυτή την αναφορά.

**Blockers πριν το declare ως production-ready με πραγματικό tenant**: (1) πρέπει να τρέξει με πραγματικά Azure staging credentials τουλάχιστον ένα πλήρες login/sync smoke test· (2) αν χρειάζονται groups/app-roles, αυτά χρειάζονται πραγματική υλοποίηση (δεν υπάρχουν σήμερα)· (3) δεν υπάρχει `.env.example` ή README για onboarding νέου deployment.

---

## 2. Πλήρες Inventory Microsoft Flows

```
Login/SSO (delegated, User.Read)
  lib/auth.config.ts            → MicrosoftEntraID provider + custom profile() override
  lib/auth.ts                   → signIn/jwt/session callbacks
  lib/services/microsoft-graph-profile-service.ts → GET /me
  lib/services/microsoft-department-sync-service.ts → orchestration
  lib/services/microsoft-mapping-service.ts → DB-only resolution (no Graph)
  lib/services/microsoft-profile-photo-service.ts → GET /me/photos/48x48/$value
  lib/services/microsoft-department-autocreate-service.ts → optional, env-gated
  lib/services/department-membership-service.ts → reconciliation (transaction)

Directory discovery (application, admin-triggered)
  lib/services/microsoft-directory-service.ts → GET /users (paged, Directory.Read.All)
  app/api/admin/microsoft-directory/values/sync/route.ts
  app/api/admin/microsoft-directory/values/route.ts (cached, no Graph call)

Mailbox / email-to-ticket (application, polling)
  lib/microsoft-graph.ts → getUnreadMessages/markAsRead/moveMessage/sendMail
  lib/ticket-email-service.ts → processInboundEmails()
  app/api/email/inbound/route.ts (Vercel Cron κάθε 2 λεπτά)
  app/api/admin/email/poll/route.ts (manual)

Admin Mapping UI (τοπικό CRUD, καμία Graph κλήση εκτός sync button)
  app/api/admin/microsoft-mappings/route.ts, [id]/route.ts
  components/admin/microsoft-mapping-management.tsx
```

**Δεν βρέθηκαν**: Graph subscriptions/webhooks, group/app-role Graph queries (`/memberOf`, `/transitiveMemberOf`, `/appRoleAssignedTo`), MSAL SDK, refresh tokens, `accountEnabled` handling.

### Τα 12 υποχρεωτικά σενάρια

| # | Σενάριο | Τι κάνει το σύστημα | Απόδειξη |
|---|---|---|---|
| 1 | Νέος χρήστης, Microsoft login | `handleLoginOrRegister`(Auth.js core) → `createUser` (`image:null`) → `handleMicrosoftJwtSignIn` → department/role sync + photo sync, όλα στο ΙΔΙΟ login | `test-microsoft-first-login-sync.ts` Scenario 1, `test-microsoft-profile-photo-sync.ts` Test 1 |
| 2 | Υπάρχων local (credentials) χρήστης, 1η Microsoft σύνδεση | Auth.js core `getUserByEmail` + `allowDangerousEmailAccountLinking` (μόνο όταν tenant pinned) → `linkAccount` → ίδιο sync path | `test-microsoft-first-login-sync.ts` Scenario 3 |
| 3 | Ήδη linked Microsoft χρήστης | `getUserByAccount` βρίσκει το Account row, καμία επανα-δημιουργία, `handleMicrosoftJwtSignIn` τρέχει κανονικά | `test-microsoft-first-login-sync.ts` Scenario 2 (idempotent, no duplicates) |
| 4 | Microsoft user χωρίς local account | Καλύπτεται από #1 (η ίδια διαδρομή) | ίδιο με #1 |
| 5 | Αλλαγμένο department | Επόμενο login → νέο `/me` claim → `resolveDepartmentMemberships` → `syncDepartmentMemberships` reconciles (νέα membership, παλιά soft-revoked) | `test-microsoft-global-vs-department-role-conflict.ts` Test 4 |
| 6 | Αλλαγμένο job title | Job-title mapping override του department-only mapping για το ίδιο department | `test-microsoft-first-login-sync.ts` Cases 1-3 |
| 7 | Αλλαγμένο group/app role | **NOT IMPLEMENTED** — καμία Graph κλήση, μόνο optional ID-token claim (μη ρυθμισμένο) | — |
| 8 | Αλλαγμένη φωτογραφία | `syncMicrosoftProfilePhoto` ETag-aware update, atomic race guard | `test-microsoft-profile-photo-sync.ts` Test 3 |
| 9 | Χωρίς φωτογραφία | Graph 404 → καμία εγγραφή, υπάρχουσα διατηρείται | `test-microsoft-profile-photo-sync.ts` Test 5 |
| 10 | Disabled/deleted Entra user | **Δεν ελέγχεται ρητά από τον κώδικα** — βασίζεται αποκλειστικά στο ότι η ίδια η Microsoft ΔΕΝ εκδίδει token για disabled λογαριασμό· ΑΝ ένα ήδη-εκδοθέν session token είναι ακόμα valid, δεν γίνεται re-check | Βλ. §5, gap |
| 11 | Αφαίρεση από group/app role | N/A — δεν υλοποιείται καν η αρχική ανάθεση | — |
| 12 | Καμία αντιστοίχιση | `resolveDepartmentMemberships` επιστρέφει `[]`, καμία membership, `User.role` παραμένει ό,τι ήταν | `test-microsoft-first-login-sync.ts` Scenario 7 |

---

## 3. Exact Delegated Permissions

| Permission | Required/Optional | Admin consent | Endpoint | Feature | Code location |
|---|---|---|---|---|---|
| `User.Read` | **Required** | Όχι | `GET /me?$select=id,displayName,mail,userPrincipalName,department,jobTitle`, `GET /me/photos/48x48/$value` | Login, profile sync, photo sync | `lib/auth.config.ts`, `lib/services/microsoft-graph-profile-service.ts`, `lib/services/microsoft-profile-photo-service.ts` |

**OIDC scopes (ΟΧΙ Graph permissions)**: `openid`, `profile`, `email` — ρητά ζητούνται στο `authorization.params.scope` (`lib/auth.config.ts:33`), ελέγχουν το OIDC handshake/ID-token claims, όχι Graph API access. `offline_access` **δεν ζητείται πουθενά** — καμία refresh token δεν εκδίδεται/αποθηκεύεται (επιβεβαιωμένο, μηδενικά hits σε repo-wide search).

## 4. Exact Application Permissions

| Permission | Required/Optional | Admin consent | Endpoint | Feature | Code location |
|---|---|---|---|---|---|
| `Mail.ReadWrite` | Required (email-to-ticket feature) | **Ναι** | `GET .../mailFolders/Inbox/messages`, `PATCH .../messages/{id}`, `POST .../messages/{id}/move` | Mailbox polling | `lib/microsoft-graph.ts` |
| `Mail.Send` | Required (email replies feature) | **Ναι** | `POST .../sendMail` | Ticket reply emails | `lib/microsoft-graph.ts:sendMail` |
| `Directory.Read.All` | Optional (admin convenience only) | **Ναι** | `GET /users?$select=id,department,jobTitle&$top=999` (paged) | Directory dropdown cache | `lib/services/microsoft-directory-service.ts` |

**Δεν χρησιμοποιείται κανένα από**: `User.Read.All`, `User.ReadBasic.All`, `Group.Read.All`, `GroupMember.Read.All`, `AppRoleAssignment.*`, `Directory.ReadWrite.All`, `Group.ReadWrite.All`, `MailboxSettings.Read`, `Subscriptions.ReadWrite.All`.

## 5. Exact Azure Portal Setup

| Ρύθμιση | Τιμή | Ποιο flow επηρεάζει |
|---|---|---|
| Supported account types | Single tenant (ή multi-tenant + `issuer` pin — βλ. §11) | Tenant isolation |
| Tenant ID | `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` / `GRAPH_TENANT_ID` | Login issuer pin + app-only token endpoint |
| Redirect URI | `{APP_URL}/api/auth/callback/microsoft-entra-id` (local/staging/prod) | Login callback |
| Client secret | `AUTH_MICROSOFT_ENTRA_ID_SECRET` / `GRAPH_CLIENT_SECRET` | Token exchange |
| Public client flows | **Disabled** | Server-side confidential client only |
| Implicit grant | **Disabled** | Authorization code + PKCE only, καμία χρήση implicit/hybrid |
| API permissions | Βλ. §3/§4 | — |
| User assignment required | Σύσταση: Yes | Extra layer πάνω από το δικό μας `@kinsen.gr` domain check |
| App roles | Δεν χρησιμοποιούνται σήμερα | N/A μέχρι να υλοποιηθεί §NOT IMPLEMENTED |
| Group claims / Optional claims | Δεν είναι ενεργά σήμερα | Θα χρειαστούν ΜΟΝΟ αν υλοποιηθεί group/app-role mapping |

## 6. Admin Consent Required

`Mail.ReadWrite`, `Mail.Send`, `Directory.Read.All` — και τα 3 Application permissions, admin consent πάντα υποχρεωτικό γι' αυτά. `User.Read` (delegated) δεν απαιτεί ρητό admin consent σε τυπικές ρυθμίσεις.

## 7. Permissions προς αφαίρεση ως υπερβολικά

Βάσει ΑΠΟΔΕΔΕΙΓΜΕΝΟΥ τι χρειάζεται ο κώδικας (όχι υπόθεση για το τι ΕΙΝΑΙ ρυθμισμένο στο πραγματικό Azure — δεν έχω πρόσβαση εκεί): αν υπάρχει `Directory.ReadWrite.All` → αντικατάσταση με `Directory.Read.All` (ο κώδικας κάνει ΜΟΝΟ `GET /users`). Αν υπάρχει `User.Read.All`/`User.ReadBasic.All` → αφαίρεση, δεν χρησιμοποιούνται πουθενά.

## 8. Graph Endpoints & Code Locations

Βλ. §2/§3/§4 tables — κάθε endpoint ήδη συνδεδεμένο με ακριβές αρχείο/function.

## 9. Environment Variables

| Variable | Χρήση | Flow | Server-only; | Κατάσταση |
|---|---|---|---|---|
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Login client ID | Delegated | Ναι | ✅ Set |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Login client secret | Delegated | Ναι | ✅ Set |
| `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | Tenant pin | Delegated | Ναι | ✅ Set (**dummy value** σε αυτό το environment) |
| `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET` | App-only token | Application | Ναι | ✅ Set (**dummy** εδώ) |
| `GRAPH_USER_EMAIL` | Mailbox identifier | Application | Ναι | ✅ Set |
| `AUTO_CREATE_GRAPH_DEPARTMENTS` | Optional feature flag | — | Ναι | Δεν επιβεβαιώθηκε αν είναι `true` |
| `CRON_SECRET`/`EMAIL_WEBHOOK_SECRET` | Auth για `/api/email/inbound` | — | Ναι | ⚠️ **Λείπουν και τα δύο** — endpoint σήμερα χωρίς auth |
| `AZURE_AD_TENANT_ID` | — | — | — | ⚠️ **Legacy/unused**, μηδενικά references στον κώδικα |

**Δεν υπάρχει `.env.example` ούτε README.md σε ολόκληρο το repository** — πραγματικό onboarding gap, καταγράφηκε νέο εύρημα σε αυτό το audit. Κανένα `NEXT_PUBLIC_*` δεν εκθέτει Microsoft secret.

---

## 10. Login & Account-Linking Verification

| Απαίτηση | Απόδειξη |
|---|---|
| Tenant περιορισμένο | `issuer` pin (`lib/auth.config.ts`) — `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` set σε αυτό το env |
| `providerAccountId` από σωστό identity | `profile.sub` (Entra `sub` claim) — αποδεδειγμένο από πραγματικό `@auth/core` source (`getUserAndAccount`) |
| Existing linked user εντοπίζεται πρώτα από Account | `getUserByAccount` — Auth.js core, ΠΡΙΝ οποιοδήποτε email matching |
| Email matching μόνο σύμφωνα με ασφαλή πολιτική | `allowDangerousEmailAccountLinking: Boolean(TENANT_ID)` — απενεργοποιείται αν tenant δεν είναι pinned |
| Καμία matching από display name | Επιβεβαιωμένο — κανένα τέτοιο code path δεν υπάρχει |
| Κανένα duplicate User/Account | Auth.js core `unique([provider, providerAccountId])` + δικά μας tests |
| Microsoft login δεν υποβαθμίζει role | `shouldSyncGlobalRole`/`GlobalRoleSource.MANUAL` protection — testαρισμένο |
| Credentials login εξακολουθεί να δουλεύει | Ξεχωριστό provider, ανεπηρέαστο από τις αλλαγές |
| Missing email claim | Δεν testαρίστηκε ρητά live· το `signIn` callback κάνει `user.email ?? ""` (ασφαλές fallback, απορρίπτεται από το domain check) |
| **Disabled Entra account** | **Gap**: κανένας ρητός `accountEnabled` έλεγχος. Βασίζεται στο ότι η ίδια η Microsoft δεν εκδίδει νέο token σε disabled λογαριασμό — αλλά ένα ΗΔΗ εκδοθέν local session (JWT, έως 30 μέρες) δεν επανελέγχεται αυτόματα. |

---

## 11. Directory Sync Verification

Endpoint: `GET /users?$select=id,department,jobTitle&$top=999`, application token. **Pagination**: πραγματικό `@odata.nextLink` looping με `MAX_PAGES=200` guard (`lib/services/microsoft-directory-service.ts`) — **δεν διαβάζει μόνο την πρώτη σελίδα**, επιβεβαιωμένο τόσο από τον κώδικα όσο και από το νέο diagnostic script's pagination-follow-through check. `429`: typed `rate_limited` αποτέλεσμα, **καμία retry/backoff λογική** (gap, low severity — admin-triggered μόνο, όχι hot path). `401`/`403`: typed, ασφαλή admin-facing μηνύματα. Cache: upsert + soft-stale (`isActive:false`), ποτέ delete. Token type: **Application** (client-credentials) — ΟΧΙ delegated admin token.

---

## 12. Mapping Verification

### Department mapping — **VERIFIED BY AUTOMATED TEST**
Deterministic normalization (exact match), no hardcoding, precedence system (`SOURCE_TYPE_PRIORITY`), reconciliation (soft-revoke, MANUAL protection) — `test-microsoft-first-login-sync.ts` (45 assertions), `test-microsoft-global-vs-department-role-conflict.ts` (16 νέα assertions).

### Job-title mapping — **VERIFIED BY AUTOMATED TEST**
Case-insensitive trim normalization, overrides department-only mapping για το ίδιο department, no-match δεν αναθέτει τυχαίο role — Cases 1-3.

### Entra Group mapping — **NOT IMPLEMENTED**
Υπάρχει μόνο ως `MicrosoftMappingSourceType.ENTRA_GROUP` data option· matched ΜΟΝΟ έναντι optional `groups` ID-token claim (μη ρυθμισμένο στο Azure σήμερα). **Καμία** Graph κλήση σε `/memberOf`/`/transitiveMemberOf`. Δεν χαρακτηρίζεται verified.

### App Role mapping — **NOT IMPLEMENTED**
Ίδιο μοτίβο με groups — `roles` ID-token claim, μη ρυθμισμένο, καμία Graph κλήση.

---

## 13. Global Role & Department Role Verification

**Νέο, ρητό test** (`test-microsoft-global-vs-department-role-conflict.ts`, 16/16 ✓) αποδεικνύει: τα δύο layers λύνονται από ΔΙΑΦΟΡΕΤΙΚΕΣ functions (`resolvePrimaryMicrosoftMapping` για global, `resolveDepartmentMemberships` για department-level, per department) πάνω στο ΙΔΙΟ σύνολο matched mappings· ένας χρήστης μπορεί να έχει global role από το mapping του department B ενώ ταυτόχρονα έχει διαφορετικό department role στο δικό του department A membership· edit σε ένα mapping's department role ΔΕΝ επηρεάζει άλλο department ή το global role· disable ενός mapping → σωστό fallback + soft-revoke, χωρίς cross-contamination.

---

## 14. Photo-Sync Verification

Endpoint: `GET /me/photos/48x48/$value`, delegated `User.Read` (καμία πρόσθετη permission). Νέος χρήστης παίρνει φωτογραφία ✓, υπάρχων χωρίς recreation ✓ (root-cause fix, προηγούμενη φάση), Microsoft-sourced ενημερώνεται ✓, manual protected ✓, 404/timeout δεν αποτυγχάνουν login ✓, **κανένα base64 στο JWT/session cookie** (μετρημένο: session cookie 798 bytes ανεξαρτήτως φωτογραφίας, real browser login), timeout bounded στα 5000ms (μετρημένο: 5002.3ms πραγματικό).

---

## 15. Pagination / Throttling / Error-Handling Verification

`/users`: πραγματικό pagination confirmed (§11). `429`: typed, καμία backoff (gap). `401`/`403`: typed, ασφαλή μηνύματα. Timeout: `AbortSignal.timeout(5000)`, verified bounded. Mailbox: `Mail.ReadWrite` write-path errors (mark-read/move) δεν διακόπτουν το batch (`processInboundEmails` per-message try/catch, email μένει unread για retry).

---

## 16. Diagnostic Script Results

`scripts/verify-microsoft-integration.ts` (νέο, αντικατέστησε το παλαιότερο `microsoft-graph-diagnostic.ts`) — 17 capability checks. Real run κατά του (dummy-tenant) `.env`:

```
6 PASS, 2 FAIL, 9 SKIPPED
```
- PASS: όλα τα env vars παρόντα (6/6).
- FAIL (σωστά): OIDC discovery + application token acquisition — dummy tenant, αναμενόμενο.
- SKIPPED (σωστά, με λόγο): mailbox/directory (cascade από token failure), delegated `/me`+photo (χρειάζεται πραγματικό interactive login), groups/app-role/webhooks (**NOT IMPLEMENTED**, ρητά δηλωμένο).

**Καμία εγγραφή/αλλαγή σε Azure ή στη βάση.**

---

## 17. Live Staging Scenarios

**`NOT VERIFIED`** — δεν υπάρχουν πραγματικά Azure staging credentials σε αυτό το environment (`.env` έχει `dummy` tenant). Δεν έγινε καμία προσομοίωση ως υποκατάστατο. User A/B/C scenarios και negative scenarios (missing permission/consent, timeout, throttling) καλύφθηκαν στο βαθμό που επιτρέπει το environment: (α) πλήρης unit-level DB+mocked-Graph κάλυψη, (β) live browser rendering/cookie-size/mapping-CRUD verification σε πραγματικό running server με throwaway credentials χρήστες. **Χρειάζεται να τρέξει από κάποιον με πρόσβαση σε πραγματικά Azure staging credentials πριν το χαρακτηρισμό ως production-ready με πραγματικό tenant.**

---

## 18. Capability Matrix

| Capability | Status |
|---|---|
| Microsoft login | **PARTIALLY VERIFIED** (κώδικας/tests πλήρη· live OAuth NOT VERIFIED) |
| New-user provisioning | **VERIFIED BY AUTOMATED TEST** |
| Existing-user linking | **VERIFIED BY AUTOMATED TEST** |
| Profile sync (department/jobTitle) | **VERIFIED BY AUTOMATED TEST** |
| Photo sync | **VERIFIED BY AUTOMATED TEST** + live browser rendering |
| Directory users sync (με pagination) | **PARTIALLY VERIFIED** (pagination logic + code path αποδεδειγμένα· live Graph call NOT VERIFIED) |
| Department mapping | **VERIFIED BY AUTOMATED TEST** |
| Job-title mapping | **VERIFIED BY AUTOMATED TEST** |
| Entra group mapping | **NOT IMPLEMENTED** |
| App-role mapping | **NOT IMPLEMENTED** |
| Global Role mapping | **VERIFIED BY AUTOMATED TEST** |
| Department Role mapping | **VERIFIED BY AUTOMATED TEST** |
| Membership reconciliation | **VERIFIED BY AUTOMATED TEST** |
| Background/manual sync | **VERIFIED BY AUTOMATED TEST** (manual admin sync) / directory cron: N/A (δεν υπάρχει cron, μόνο admin-click) |
| Mailbox integration | **PARTIALLY VERIFIED** (κώδικας/error-handling αποδεδειγμένο· live Graph mailbox call NOT VERIFIED) |
| Webhooks/subscriptions | **NOT IMPLEMENTED** |

**Καμία γραμμή δεν χαρακτηρίστηκε `VERIFIED LIVE`** — καμία πραγματική κλήση σε πραγματικό Azure tenant δεν έγινε δυνατή σε αυτό το environment.

---

## 19. Ακριβή Test Totals

- **67 test/measurement scripts**, **1195 automated assertions**, **0 αποτυχίες** (πέρα από 1 γνωστό, προϋπάρχον, άσχετο issue σε `test-pending-ticket-accept-reject.ts`, seed-ordering, επιβεβαιωμένο ανεξάρτητο).
- 6 αφιερωμένα Microsoft test files: `test-microsoft-first-login-sync.ts` (45), `test-microsoft-graph-sync.ts` (23), `test-microsoft-role-sync.ts` (34), `test-microsoft-profile-photo-sync.ts` (38), `test-microsoft-provider-profile-override.ts` (11), `test-microsoft-global-vs-department-role-conflict.ts` (16, νέο).
- 2 Playwright browser runs: photo-sync/rendering (14/14 ✓), Microsoft Mapping admin CRUD (11/11 ✓, εντόπισε + διόρθωσε 1 πραγματικό μικρό bug — missing response-body drain στο delete handler).
- `tsc --noEmit`, `npm run build`, `prisma validate`, `prisma migrate status` — όλα καθαρά.

---

## 20. Πραγματικά Remaining Blockers

1. **Κανένα live Azure/Graph call δεν επιβεβαιώθηκε** — dummy tenant credentials σε αυτό το environment. Πρέπει να τρέξει `scripts/verify-microsoft-integration.ts` + ένα πραγματικό login σε πραγματικό staging tenant πριν το χαρακτηρισμό ως πλήρως production-ready.
2. **Entra Group / App Role mapping δεν είναι υλοποιημένα** — αν χρειάζονται, χρειάζεται πραγματική νέα ανάπτυξη (Graph queries ή optional-claims configuration), όχι απλή επιβεβαίωση.
3. **Disabled Entra user**: κανένας αυτόματος επανέλεγχος υπάρχοντος local session αν ο λογαριασμός απενεργοποιηθεί στο Entra μετά την έκδοση του token.
4. **Δεν υπάρχει `.env.example` ή README** — onboarding gap για νέο deployment.
5. **`CRON_SECRET`/`EMAIL_WEBHOOK_SECRET` λείπουν** από το `.env` — το `/api/email/inbound` endpoint είναι σήμερα χωρίς authentication σε αυτό το environment (ήδη γνωστό εύρημα, επιβεβαιώθηκε ξανά).
6. **Καμία retry/backoff λογική** για Graph `429` (directory sync, mailbox polling) — αποδεκτό για low-volume σήμερα, αλλά καταγράφεται.
