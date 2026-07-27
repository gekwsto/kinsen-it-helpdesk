# TicketApp — Πλήρες Read-Only Audit Microsoft Entra ID / Microsoft Graph Integration

*Read-only audit. Δεν άλλαξε κώδικας, permissions, `.env`, Azure configuration ή database records. Το μόνο νέο αρχείο είναι το `scripts/microsoft-graph-diagnostic.ts` (καθαρά read-only diagnostic tool, μηδενικές write ενέργειες).*

---

## 1. Executive Summary

Το TicketApp χρησιμοποιεί **Microsoft Entra ID** για authentication και **Microsoft Graph** για 3 ξεχωριστά, ανεξάρτητα flows:

| # | Flow | Token type | App registration (env vars) | Σκοπός |
|---|------|-----------|------------------------------|--------|
| A | Login / SSO | Delegated (OIDC) | `AUTH_MICROSOFT_ENTRA_ID_*` | Sign-in, ταυτοποίηση, department sync από `/me` |
| B | Mailbox polling (email→ticket) | Application (client credentials) | `GRAPH_*` | Ανάγνωση/αποστολή email από shared mailbox |
| C | Directory discovery (admin-triggered) | Application (client credentials) | `GRAPH_*` | Company-wide λίστα department/jobTitle values |

**Σημαντικό εύρημα:** Στο σημερινό `.env` αυτού του deployment, το `AUTH_MICROSOFT_ENTRA_ID_ID`/`GRAPH_CLIENT_ID`, το tenant ID, και το secret είναι **literally identical** — δηλαδή σήμερα υπάρχει **ΜΙΑ** μόνο πραγματική Entra App Registration που κάνει διπλή δουλειά (delegated + application permissions μαζί). Αυτό είναι αρχιτεκτονικά λειτουργικό αλλά όχι least-privilege best-practice (βλ. §9).

**Δεν βρέθηκε καμία χρήση**: Graph subscriptions/webhooks, delta queries, IMAP/SMTP, groups/app-role Graph endpoints (`/memberOf`, `/transitiveMemberOf`, `/appRoleAssignments`), MSAL/`@azure/identity` SDK, ή αποθηκευμένο refresh token.

**Πραγματικό, μη προφανές εύρημα ασφαλείας**: το `@auth/prisma-adapter` γράφει το delegated `access_token` + `id_token` του Microsoft login **στη βάση** (πίνακας `Account`) κατά το ΠΡΩΤΟ login κάθε χρήστη — βλ. §12, Medium finding.

---

## 2. Όλα τα Microsoft flows που βρέθηκαν (με ακριβή αρχεία)

```
Login/SSO (delegated)
  lib/auth.config.ts           → MicrosoftEntraID provider, scope "openid profile email User.Read"
  lib/auth.ts                  → jwt callback, δρομολογεί σε Operation A
  lib/services/microsoft-graph-profile-service.ts → GET /me (delegated token)
  lib/services/microsoft-department-sync-service.ts → orchestration, department/global-role sync
  lib/services/microsoft-mapping-service.ts → resolveDepartmentMemberships/resolvePrimaryMicrosoftMapping (DB-only, καμία Graph κλήση)
  lib/services/microsoft-department-autocreate-service.ts → optional, env-gated (AUTO_CREATE_GRAPH_DEPARTMENTS)
  lib/services/department-membership-service.ts → εφαρμόζει το αποτέλεσμα στη βάση

Mailbox polling / email-to-ticket (application)
  lib/microsoft-graph.ts        → getUnreadMessages, markAsRead, moveMessage, sendMail, testConnection
  lib/ticket-email-service.ts   → processInboundEmails() (polling loop)
  app/api/email/inbound/route.ts    → Vercel Cron (κάθε 2 λεπτά, vercel.json) + webhook/manual trigger
  app/api/admin/email/poll/route.ts → admin "Poll Now" button
  app/api/admin/email/test-connection/route.ts → testConnection() diagnostic

Directory discovery (application, admin-triggered μόνο)
  lib/services/microsoft-directory-service.ts → GET /users (paged, Directory.Read.All)
  app/api/admin/microsoft-directory/values/sync/route.ts → POST, requireAdmin()
  app/api/admin/microsoft-directory/values/route.ts → GET cached values (καμία Graph κλήση)

Admin mapping UI (τοπικό μόνο, καμία Graph κλήση)
  app/api/admin/microsoft-mappings/route.ts, [id]/route.ts
  components/admin/microsoft-mapping-management.tsx
  app/(main)/admin/microsoft-mappings/page.tsx
```

**Δεν βρέθηκαν**: Graph subscriptions/webhooks, cron jobs για directory sync (μόνο admin-click), IMAP/SMTP, MSAL SDK χρήση (το `@microsoft/microsoft-graph-client` είναι στο `package.json` αλλά **ποτέ δεν γίνεται import** — dead dependency, όλες οι κλήσεις είναι raw `fetch()`).

---

## 3. Πίνακας Delegated Permissions

| Permission | Flow | Graph endpoint / SDK method | Αρχείο / function | Admin consent | Απαραίτητο; | Τι σταματά αν λείπει | Μικρότερο εναλλακτικό |
|---|---|---|---|---|---|---|---|
| **`User.Read`** | Interactive login | `GET /me?$select=id,displayName,mail,userPrincipalName,department,jobTitle` | `lib/services/microsoft-graph-profile-service.ts:fetchMicrosoftGraphProfile()` | Όχι (default delegated, user consent αρκεί) | **Απαραίτητο** | Login συνεχίζει να δουλεύει, αλλά ο automatic department/job-title/global-role sync παραλείπεται σιωπηλά για αυτό το login (βλ. `syncMicrosoftUserDepartment`'s explicit fail-open design) | Δεν υπάρχει μικρότερο — `User.Read` είναι ήδη το ελάχιστο delegated permission που επιτρέπει `GET /me` με custom `$select` πεδία (`department`, `jobTitle`). |

**OIDC scopes (ΔΕΝ είναι Graph permissions)** — ρητά διαχωρισμένα εδώ όπως ζητήθηκε:

| OIDC scope | Τι κάνει | Πηγή στον κώδικα |
|---|---|---|
| `openid` | Ενεργοποιεί το OIDC flow, παράγει `id_token` | `lib/auth.config.ts:32` |
| `profile` | Claims όπως `name`, `oid` στο ID token | ίδιο |
| `email` | Claim `email`/`preferred_username` στο ID token | ίδιο |

Το `offline_access` **ΔΕΝ ζητείται πουθενά** (επιβεβαιωμένο με repo-wide grep) → **δεν εκδίδεται refresh token**. Το access token από το login ισχύει μόνο ~1 ώρα, χρησιμοποιείται μόνο τη στιγμή του login (`account.access_token` μέσα στο `jwt` callback), ποτέ δεν ανανεώνεται.

**Επιβεβαίωση από τον πραγματικό κώδικα**: το login flow χρειάζεται **μόνο** `id`, `department`, `jobTitle` από το `/me` (τα `displayName`/`mail`/`userPrincipalName` ζητούνται στο `$select` αλλά δεν χρησιμοποιούνται πουθενά μετά — βλ. `buildClaimsFromGraphProfile()`, χρησιμοποιεί μόνο `profile.department`/`profile.jobTitle`). Το `name`/`email` του χρήστη έρχονται ήδη από το **ID token** (OIDC claims), όχι από το `/me` call. Άρα το ελάχιστο `$select` θα μπορούσε να είναι `id,department,jobTitle` — μικρή, μη-κρίσιμη over-fetch, **όχι permission issue** (το `User.Read` το επιτρέπει ούτως ή άλλως).

---

## 4. Πίνακας Application Permissions

| Permission | Flow | Graph endpoint | Αρχείο / function | Admin consent | Απαραίτητο; | Τι σταματά αν λείπει |
|---|---|---|---|---|---|---|
| **`Mail.Read`** ή **`Mail.ReadWrite`** | Mailbox polling | `GET /users/{mailbox}/mailFolders/Inbox/messages`, `PATCH /users/{mailbox}/messages/{id}` (mark read), `POST /users/{mailbox}/messages/{id}/move` | `lib/microsoft-graph.ts: getUnreadMessages, markAsRead, moveMessage` | **Ναι** (κάθε Application permission σε Graph) | **Απαραίτητο** — χρειάζεται write στο mailbox state (mark-as-read, move), άρα **`Mail.ReadWrite`**, όχι `Mail.Read` (read-only δεν καλύπτει markAsRead/moveMessage) | Το email-to-ticket pipeline σταματά τελείως· `processInboundEmails()` πετάει exception στο πρώτο Graph call | Δεν υπάρχει — read+write στο mailbox περιεχόμενο είναι πραγματικά αναγκαίο για το mark-as-read/move flow. `Mail.ReadBasic` δεν αρκεί (δεν επιτρέπει `$select=body` που χρησιμοποιείται). |
| **`Mail.Send`** | Απάντηση ticket προς requester | `POST /users/{mailbox}/sendMail` | `lib/microsoft-graph.ts: sendMail()`, καλείται από `sendTicketReplyEmail()` / `lib/ticket-notification-service.ts` | Ναι | **Απαραίτητο** (μόνο αν χρησιμοποιείται το reply-by-email feature) | Οι απαντήσεις προς requesters μέσω email σταματούν να στέλνονται | Δεν υπάρχει μικρότερο — το `sendMail` action απαιτεί ρητά αυτό το permission. |
| **`Directory.Read.All`** | Admin-triggered directory discovery | `GET /users?$select=id,department,jobTitle&$top=999` (paged) | `lib/services/microsoft-directory-service.ts: fetchAllGraphUserDirectoryValues()` | **Ναι, admin consent required** | **Optional / nice-to-have** — αν λείπει, ΜΟΝΟ το "Sync" κουμπί στο `/admin/microsoft-mappings` αποτυγχάνει με 403· login, mailbox polling, sync-on-login **ΔΕΝ επηρεάζονται** | Το admin dropdown για "Microsoft Value" γυρίζει σε manual text entry — καμία απώλεια λειτουργικότητας πέρα από UX convenience | Δεν υπάρχει μικρότερο endpoint-only permission — το `GET /users` (tenant-wide) απαιτεί πάντα `Directory.Read.All` ή `User.Read.All`, δεν υπάρχει πιο περιορισμένο application permission για tenant-wide listing. |

**Δεν βρέθηκαν στον κώδικα** (άρα δεν χρειάζονται): `User.ReadBasic.All`, `User.Read.All`, `Directory.ReadWrite.All`, `Group.Read.All`, `GroupMember.Read.All`, `AppRoleAssignment.ReadWrite.All`, `RoleManagement.Read.Directory`, `Subscriptions.ReadWrite.All`, `MailboxSettings.Read`.

**Ρητή επιβεβαίωση**: το app **δεν γράφει ποτέ** στο Entra directory (κανένα `POST`/`PATCH`/`DELETE` σε `/users`, `/groups`, `/directory*`). Αν σήμερα υπάρχει configured `Directory.ReadWrite.All` στο Azure app registration, είναι **υπερβολικό** — το ακριβές read-only replacement είναι `Directory.Read.All` (ήδη αυτό είναι το μόνο που τεκμηριώνεται/χρειάζεται στο `docs/microsoft-graph-directory-sync.md`).

---

## 5. Groups, Roles, App Roles — τι υπάρχει vs τι λειτουργεί σήμερα

Το schema/UI **υποστηρίζουν** 4 τύπους mapping source (`PROFILE_DEPARTMENT`, `PROFILE_JOB_TITLE`, `ENTRA_GROUP`, `ENTRA_APP_ROLE` — `MicrosoftMappingSourceType` enum), και το `prisma/seed.ts` έχει seeded παραδείγματα `ENTRA_GROUP`/`ENTRA_APP_ROLE` mappings. **ΑΛΛΑ**, επιβεβαιωμένο από τον πραγματικό κώδικα:

- `lib/auth.ts` (γραμμές 144-150): τα `groups`/`roles` περνάνε **μόνο** αν υπάρχουν ως **ID token claims** (`profile.groups`, `profile.roles` — standard OIDC `profile` object του NextAuth callback), **ΠΟΤΕ** μέσω Graph API κλήσης.
- Κανένα call προς `/memberOf`, `/transitiveMemberOf`, `/appRoleAssignments` δεν υπάρχει πουθενά στον κώδικα (repo-wide grep, μηδενικά αποτελέσματα).
- Το scope που ζητείται στο login (`openid profile email User.Read`) **δεν** παράγει `groups`/`roles` claims από μόνο του — χρειάζεται πρόσθετη ρύθμιση στο Azure app registration (groups claim / App Roles + roles claim), η οποία **δεν είναι ρυθμισμένη σήμερα** (ρητό σχόλιο στο `types/department.ts`: *"not configured today"*).

**Συμπέρασμα**: Τα `ENTRA_GROUP`/`ENTRA_APP_ROLE` mappings είναι **inert/ανενεργά** configuration δεδομένα σήμερα — δεν αντιστοιχούν σε καμία πραγματική Graph λειτουργία. **Δεν χρειάζεται κανένα από τα ακόλουθα σήμερα**: `Group.Read.All`, `GroupMember.Read.All`, `Directory.Read.All` (για groups σκοπό — ήδη υπάρχει για άλλο λόγο, §4), `AppRoleAssignment.ReadWrite.All`, `RoleManagement.Read.Directory`.

### Μελλοντική επιλογή (ΜΟΝΟ αν ενεργοποιηθεί το feature)

| Αν αποφασιστεί να ενεργοποιηθεί… | Χρειάζεται |
|---|---|
| Groups/roles claims στο ID token (χωρίς Graph call) | Καμία επιπλέον Graph permission — μόνο Azure app registration config (optional claims: groups, App Roles) |
| Live query group membership μέσω Graph (`GET /me/memberOf` ή `/transitiveMemberOf`) | Delegated `GroupMember.Read.All` ή `Directory.Read.All` |
| Live query app-role assignments μέσω Graph (`GET /servicePrincipals/{id}/appRoleAssignedTo`) | Application `Application.Read.All` ή `AppRoleAssignment.ReadWrite.All` (μόνο αν χρειαστεί management, όχι μόνο read) |

---

## 6. Mailbox / Email-to-Ticket integration

| Ενέργεια | Πραγματικά γίνεται; | Permission | Type |
|---|---|---|---|
| Διάβασμα emails | ✅ `getUnreadMessages()` | `Mail.Read`/`Mail.ReadWrite` | Application |
| Διάβασμα attachments | ✅ `$expand=attachments`, base64 decode → disk | ίδιο | Application |
| Mark as read | ✅ `markAsRead()` PATCH | `Mail.ReadWrite` (write action) | Application |
| Μετακίνηση/διαγραφή | ✅ Μετακίνηση σε "Processed" φάκελο· **καμία διαγραφή email πουθενά** | `Mail.ReadWrite` | Application |
| Αποστολή replies | ✅ `sendMail()` | `Mail.Send` | Application |
| Shared mailbox | ✅ `GRAPH_USER_EMAIL` (`kinsenitsupport@kinsen.gr` default) — impersonation μέσω `/users/{mailbox}/...` paths | (ίδια πάνω) | Application |
| Graph subscriptions | ❌ Δεν υπάρχουν | — | — |
| Subscription renewal | ❌ N/A | — | — |
| Delta queries | ❌ Δεν χρησιμοποιούνται — polling με `$filter=isRead eq false` | — | — |
| IMAP/SMTP | ❌ Δεν χρησιμοποιείται — αποκλειστικά Graph REST | — | — |

**Μηχανισμός**: **Polling**, όχι webhook. Vercel Cron (`vercel.json`) καλεί `GET /api/email/inbound` κάθε 2 λεπτά → `processInboundEmails()` → `getUnreadMessages(50)`. Εναλλακτικά path για non-Vercel deployment: server crontab curl (documented inline στο route).

**Application Access Policy / RBAC recommendation**: Επειδή χρησιμοποιούνται **Application** mailbox permissions (`Mail.ReadWrite`, `Mail.Send`), το token αυτό **θεωρητικά έχει πρόσβαση σε ΟΛΑ τα mailboxes του tenant**, όχι μόνο στο `kinsenitsupport@kinsen.gr`. Ο κώδικας ΠΟΤΕ δεν προσπαθεί να αγγίξει άλλο mailbox (το `MAILBOX` const είναι hardcoded/env-driven, όχι user input) — αλλά αυτό είναι application-level περιορισμός, **όχι** Azure-level. **Σύσταση**: εφαρμογή **Exchange Online Application Access Policy** που περιορίζει το app registration ώστε να μπορεί να κάνει Graph mailbox calls **μόνο** στο `kinsenitsupport@kinsen.gr` (ή σε μια security group με helpdesk mailboxes) — αυτό είναι Exchange-side config, όχι κάτι που αλλάζει στον κώδικα.

---

## 7. Webhooks / Subscriptions

**Δεν βρέθηκε καμία Graph subscription, webhook, ή lifecycle notification handler πουθενά στον κώδικα.** Το `/api/email/inbound` endpoint ΔΕΝ είναι Graph webhook receiver — είναι το δικό μας cron-triggered polling endpoint (ονομασία "inbound" αναφέρεται στο business meaning, όχι σε Graph subscription callback). Καμία τεχνική ρύθμιση webhook (notification URL, validation token, clientState, κ.λπ.) δεν χρειάζεται σήμερα.

---

## 8. Entra App Registration Checklist (πραγματική αρχιτεκτονική)

| Ρύθμιση | Τιμή/σύσταση βάσει κώδικα |
|---|---|
| Supported account types | **Single tenant** (η ίδια η εφαρμογή pin-άρει issuer στο tenant ID όταν `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` είναι set — αν το app registration είναι multi-tenant στο Azure, το `issuer` pin περιορίζει σε επίπεδο token exchange, αλλά "Single tenant" στο registration είναι πιο καθαρό/ασφαλές defense-in-depth) |
| Tenant restriction | Επιβάλλεται στον κώδικα μέσω `issuer: https://login.microsoftonline.com/{TENANT_ID}/v2.0` — **ΑΠΑΙΤΕΙ** `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` να είναι πάντα set σε production (βλ. §12 finding) |
| Platform type | **Web** (Auth.js server-side OAuth redirect flow) |
| Redirect URIs | `{APP_URL}/api/auth/callback/microsoft-entra-id` — για local: `http://localhost:3000/api/auth/callback/microsoft-entra-id`· staging/production: αντίστοιχο πραγματικό domain |
| Logout/front-channel URL | Δεν υλοποιείται explicit front-channel logout στον κώδικα — δεν χρειάζεται ρύθμιση εκτός αν προστεθεί SLO |
| Client secret ή certificate | **Client secret** (χρησιμοποιείται `clientSecret`/`GRAPH_CLIENT_SECRET`, όχι certificate) |
| Client secret expiration/rotation | Δεν υπάρχει αυτοματοποιημένο rotation στον κώδικα — χειροκίνητη διαδικασία, να προγραμματιστεί πριν τη λήξη |
| Token configuration / optional claims | Σήμερα καμία optional claim δεν είναι ενεργή στον κώδικα (`groups`/`roles` δεν διαβάζονται από Graph, μόνο IF υπάρχουν στο ID token — §5) |
| Group claims | **Μόνο αν** ενεργοποιηθεί το feature του §5 — σήμερα ΔΕΝ χρειάζεται |
| API permissions | Βλ. §3/§4 tables |
| Grant admin consent | Χρειάζεται για: `Mail.ReadWrite`, `Mail.Send`, `Directory.Read.All` (Application permissions πάντα χρειάζονται admin consent) |
| User assignment required | **Σύσταση: Yes** — περιορίζει ποιοι χρήστες του tenant μπορούν να κάνουν sign-in στο app registration, extra layer πάνω από το δικό μας `@kinsen.gr` domain check στο `signIn` callback |
| App roles | Δεν χρησιμοποιούνται σήμερα (§5) |
| Owners | Operational, εκτός scope κώδικα |
| Publisher verification | Δεν σχετίζεται (single-tenant, internal app) |
| Conditional Access | Συμβατό — standard OAuth authorization code flow, καμία incompatibility στον κώδικα |
| Public client flows | **Πρέπει να είναι Disabled** — η εφαρμογή είναι server-side confidential client (έχει client secret) |
| Implicit grant | **Πρέπει να είναι Disabled** — δεν χρησιμοποιείται πουθενά· Auth.js χρησιμοποιεί authorization code + PKCE flow |
| Access/ID tokens από implicit/hybrid | **Δεν χρειάζονται** — δεν χρησιμοποιείται implicit/hybrid flow πουθενά |

---

## 9. Μία ή Δύο App Registrations;

**Σημερινή πραγματικότητα (επιβεβαιωμένο, όχι εικασία)**: `AUTH_MICROSOFT_ENTRA_ID_ID === GRAPH_CLIENT_ID`, `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID === GRAPH_TENANT_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET === GRAPH_CLIENT_SECRET` σε αυτό το deployment — **μία** App Registration κάνει και τα δύο.

**Σύσταση: Δύο ξεχωριστές App Registrations.**

| Κριτήριο | Μία registration (σημερινή) | Δύο registrations (προτεινόμενο) |
|---|---|---|
| Least privilege | Το ίδιο client secret ξεκλειδώνει delegated login **και** mailbox read/write **και** tenant-wide directory read | Compromise του login secret δεν εκθέτει mailbox/directory· compromise του Graph Sync secret δεν επιτρέπει sign-in ως χρήστες |
| Blast radius αν διαρρεύσει το secret | Πλήρες: SSO impersonation + mailbox access + directory read | Περιορισμένο ανά registration |
| Secret rotation | Μία αλλαγή σπάει ΚΑΙ το login ΚΑΙ το email pipeline ΚΑΙ το directory sync ταυτόχρονα | Ανεξάρτητη rotation — π.χ. αλλαγή Graph Sync secret δεν ρίχνει το login |
| Auditing | Τα sign-in logs και τα application (client-credentials) logs στο Entra είναι ήδη ξεχωριστά ανά registration· με ένα registration χάνεται η σαφής διάκριση "ποιο flow έκανε τι" | Καθαρός διαχωρισμός στα Entra sign-in/audit logs |
| Conditional Access | Πολιτικές CA στοχεύουν σε registration/app — σήμερα δεν μπορείς να βάλεις CA policy μόνο στο login flow χωρίς να επηρεάσεις το app-only traffic (which CA δεν αφορά ούτως ή άλλως, αλλά η μπέρδεμα υπάρχει διαχειριστικά) | Καθαρό: CA policies μόνο στο login registration (το CA δεν εφαρμόζεται σε app-only client-credentials flows ούτως ή άλλως) |
| Operational complexity | Απλούστερο σήμερα — 3 env vars αντί για 6 | Ελαφρώς πιο πολύπλοκο setup, αλλά ο κώδικας **ήδη το υποστηρίζει χωρίς καμία αλλαγή** — απλά βάλε διαφορετικές τιμές στα `GRAPH_*` env vars |

**Πραγματική εφαρμοσιμότητα**: Ο κώδικας **ήδη** χρησιμοποιεί δύο ξεχωριστά namespaces env vars (`AUTH_MICROSOFT_ENTRA_ID_*` vs `GRAPH_*`) — δεν χρειάζεται **καμία** αλλαγή κώδικα για να γίνει split, μόνο:
1. Δημιουργία 2ης App Registration στο Entra ("TicketApp Graph Sync") με **μόνο** Application permissions (`Mail.ReadWrite`, `Mail.Send`, `Directory.Read.All`) — **καμία** delegated permission, **κανένα** redirect URI χρειάζεται.
2. Ενημέρωση `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET` στο `.env` ώστε να δείχνουν στη 2η registration.
3. Το `AUTH_MICROSOFT_ENTRA_ID_*` triplet παραμένει στην 1η registration, με **μόνο** `User.Read` delegated.

---

## 10. Τελικός Πίνακας Permissions

### A. Ελάχιστα απαιτούμενα τώρα

| Permission | Type | Required/Optional | Admin consent | Use case | Code location |
|---|---|---|---|---|---|
| `User.Read` | Delegated | **Required** | Όχι | Login + `/me` department/jobTitle sync | `lib/auth.config.ts:32`, `lib/services/microsoft-graph-profile-service.ts` |
| `Mail.ReadWrite` | Application | **Required** (αν email-to-ticket ενεργό) | **Ναι** | Read inbox, mark-as-read, move messages | `lib/microsoft-graph.ts` |
| `Mail.Send` | Application | **Required** (αν email replies ενεργά) | **Ναι** | Αποστολή απαντήσεων προς requester | `lib/microsoft-graph.ts:sendMail`, `lib/ticket-notification-service.ts` |

### B. Υπάρχουν σήμερα αλλά είναι υπερβολικά

| Permission | Πρόβλημα | Σύσταση |
|---|---|---|
| `Directory.ReadWrite.All` (**αν** έχει δοθεί σήμερα στο Azure — δεν επιβεβαιώνεται από τον κώδικα ποιο πραγματικά είναι consented, μόνο τι *χρειάζεται*) | Ο κώδικας κάνει **μόνο** `GET /users` — καμία εγγραφή στη directory πουθενά | Αντικατάσταση με `Directory.Read.All` (Application) |
| `Mail.Read` (αν έχει δοθεί ΑΝΤΙ για `Mail.ReadWrite`) | Δεν αρκεί — ο κώδικας κάνει `PATCH` (mark-as-read) και `POST .../move` | Πρέπει να είναι `Mail.ReadWrite`, όχι μικρότερο — αυτό δεν είναι over-permission, είναι under-permission αν είναι μόνο Read |
| Μία κοινή App Registration για login + Graph sync | Λειτουργικό αλλά όχι least-privilege (§9) | Split σε 2 registrations |
| `@microsoft/microsoft-graph-client` στο `package.json` | Dead dependency, ποτέ δεν γίνεται import | Αφαίρεση (codebase hygiene, όχι permission θέμα) |

### C. Μελλοντικά / Προαιρετικά

| Permission | Feature | Σχόλιο |
|---|---|---|
| Delegated `GroupMember.Read.All` ή `Directory.Read.All` | Live query group membership | Μόνο αν αποφασιστεί ενεργό group-based mapping μέσω Graph αντί για ID-token claim |
| Application `AppRoleAssignment.ReadWrite.All` | Live query/management app-role assignments | Μόνο αν χρειαστεί κάτι πέρα από το ID-token `roles` claim |
| `Subscriptions.ReadWrite.All` | Real-time email webhooks αντί για polling | Θα απαιτούσε νέο lifecycle-renewal background job — δεν υπάρχει σήμερα |

### D. Δεν απαιτούνται

| Permission | Γιατί δεν χρειάζεται |
|---|---|
| `User.ReadBasic.All`, `User.Read.All` | Καμία tenant-wide user listing μέσω delegated token — μόνο `/me` (own profile) |
| `Group.Read.All`, `GroupMember.Read.All` | Καμία Graph κλήση σε group endpoints (§5) |
| `RoleManagement.Read.Directory` | Καμία χρήση directory roles |
| `MailboxSettings.Read` | Δεν διαβάζονται mailbox settings, μόνο messages |
| `Subscriptions.ReadWrite.All` | Δεν υπάρχουν webhooks (§7) |

---

## 11. Exact Setup Instructions (Entra Portal)

**Registration 1 — Login (`AUTH_MICROSOFT_ENTRA_ID_*`):**
1. API permissions → Add → Microsoft Graph → **Delegated** → `User.Read`.
2. Grant admin consent: **δεν χρειάζεται** ρητά (User.Read είναι ήδη pre-consented default σε πολλά tenants, αλλά αν ζητηθεί, χορήγησέ το).
3. Redirect URIs (Web platform): `https://<production-domain>/api/auth/callback/microsoft-entra-id`, `https://<staging-domain>/api/auth/callback/microsoft-entra-id`, `http://localhost:3000/api/auth/callback/microsoft-entra-id`.
4. Client secret: δημιούργησε ένα, καταγράφεται μόνο μία φορά.
5. Env vars στην εφαρμογή: `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`.

**Registration 2 — Graph Sync (`GRAPH_*`), προτεινόμενο ξεχωριστό (§9):**
1. API permissions → Add → Microsoft Graph → **Application** → `Mail.ReadWrite`, `Mail.Send`, `Directory.Read.All`.
2. **Grant admin consent for the tenant** — υποχρεωτικό, και τα 3 είναι Application permissions.
3. Κανένα redirect URI χρειάζεται (client-credentials flow, όχι interactive).
4. Client secret ξεχωριστό από το Registration 1.
5. Env vars: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_USER_EMAIL`.
6. **Σύσταση**: εφαρμογή Exchange Online Application Access Policy περιορισμένη στο `GRAPH_USER_EMAIL` mailbox.

**Permissions προς αφαίρεση** (αν υπάρχουν σήμερα στο πραγματικό Azure — δεν μπορώ να το επιβεβαιώσω από τον κώδικα, μόνο να το προτείνω): οτιδήποτε πέρα από τα 4 permissions του §10.A/§11 πάνω (π.χ. `Directory.ReadWrite.All`, `User.Read.All`, οποιοδήποτε group/role permission).

**Ακριβή environment variables** (μόνο ονόματα, καμία τιμή):

| Variable | Χρήση | Κατάσταση |
|---|---|---|
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Login client ID | ✅ Set, χρησιμοποιείται |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Login client secret | ✅ Set, χρησιμοποιείται |
| `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | Login tenant pin | ✅ Set, χρησιμοποιείται (**κρίσιμο** — βλ. §12) |
| `GRAPH_TENANT_ID` | Graph app-only tenant | ✅ Set, χρησιμοποιείται |
| `GRAPH_CLIENT_ID` | Graph app-only client ID | ✅ Set, χρησιμοποιείται |
| `GRAPH_CLIENT_SECRET` | Graph app-only secret | ✅ Set, χρησιμοποιείται |
| `GRAPH_USER_EMAIL` | Mailbox identifier | ✅ Set, χρησιμοποιείται (fallback: `SUPPORT_EMAIL`) |
| `AUTO_CREATE_GRAPH_DEPARTMENTS` | Optional feature flag | Δεν επιβεβαιώθηκε αν είναι set — προαιρετικό, default off |
| `CRON_SECRET` | Auth για `/api/email/inbound` (Vercel Cron) | ⚠️ **ΛΕΙΠΕΙ από το `.env`** — βλ. §12 finding |
| `EMAIL_WEBHOOK_SECRET` | Auth για `/api/email/inbound` (manual/webhook) | ⚠️ **ΛΕΙΠΕΙ από το `.env`** — βλ. §12 finding |
| `AZURE_AD_TENANT_ID` | — | ⚠️ **Legacy/unused** — υπάρχει στο `.env` αλλά ΔΕΝ αναφέρεται πουθενά στον κώδικα (repo-wide grep, μηδενικά αποτελέσματα) |

---

## 12. Security & Least-Privilege Findings

| Severity | Εύρημα | Λεπτομέρεια |
|---|---|---|
| **Medium** | Delegated `access_token`/`id_token` του Microsoft login αποθηκεύονται στη βάση | Επιβεβαιωμένο από τον πραγματικό `@auth/prisma-adapter` κώδικα (`linkAccount: (data) => p.account.create({ data })`, καλείται ΜΟΝΟ στο πρώτο login κάθε χρήστη, `node_modules/@auth/core/lib/actions/callback/handle-login.js`). Ο πίνακας `Account` έχει στήλες `access_token`/`refresh_token`/`id_token` (`prisma/schema.prisma:406-411`), plaintext `@db.Text`. Κανένα σημείο του app code δεν διαβάζει ξανά αυτές τις στήλες (`grep prisma.account.` = μηδενικά αποτελέσματα) — άρα είναι **"dead" αλλά υπαρκτό** ευαίσθητο δεδομένο, ποτέ δεν ανανεώνεται μετά το 1ο login (μένει μόνιμα ληγμένο access token στη βάση). Δεν εκδίδεται refresh token (χωρίς `offline_access`), άρα ο κίνδυνος περιορίζεται σε ένα ήδη ληγμένο (~1ωρα) access token + το id_token. |
| **Medium** | `/api/email/inbound` χωρίς authentication όταν `CRON_SECRET`/`EMAIL_WEBHOOK_SECRET` δεν είναι set | `isAuthorized()` επιστρέφει `true` για ΟΛΟΥΣ όταν κανένα από τα δύο secrets δεν είναι configured (`app/api/email/inbound/route.ts:18`). Επιβεβαιώθηκε ότι **κανένα από τα δύο δεν υπάρχει στο σημερινό `.env`** → το endpoint είναι σήμερα ανοιχτό χωρίς auth. Οποιοσδήποτε μπορεί να καλέσει το endpoint επαναλαμβανόμενα (rate-limit/DoS risk στο mailbox polling, πιθανές duplicate-processing races — αν και υπάρχει message-ID dedup). |
| **Low** | `AZURE_AD_TENANT_ID` legacy/unused env var | Υπάρχει στο `.env`, ποτέ δεν διαβάζεται από κανένα αρχείο κώδικα — πιθανό υπόλειμμα από παλαιότερη ρύθμιση, ασαφές αν αντιγράφει το πραγματικό tenant ID ή είναι stale. |
| **Low** | Καμία retry/backoff λογική για Graph 429 | Και τα δύο profile/directory services αναγνωρίζουν `rate_limited` ως typed αποτέλεσμα αλλά **δεν κάνουν retry-with-backoff** — απλά αποτυγχάνουν immediately και αναφέρουν το σφάλμα. Αποδεκτό για low-volume/on-demand use cases (login-time single call, admin-triggered sync), αλλά αξίζει αναφοράς. |
| **Low** | `@microsoft/microsoft-graph-client` dead dependency | Εγκατεστημένο, ποτέ δεν γίνεται import — μπερδεύει τον αναγνώστη του `package.json` σχετικά με το τι SDK πραγματικά χρησιμοποιείται (η πραγματική υλοποίηση είναι raw `fetch()`). |
| **Informational (καλή πρακτική)** | Tenant issuer pinning + email domain allowlist | `lib/auth.config.ts` pin-άρει `issuer` στο συγκεκριμένο tenant ΟΤΑΝ `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` είναι set (επιβεβαιωμένο set σήμερα) — αποτρέπει sign-in από άλλο Entra tenant στο OAuth layer. `allowDangerousEmailAccountLinking` είναι ρητά `Boolean(TENANT_ID)` — δραστικά απενεργοποιείται αν το tenant pin λείψει, με σαφές σχόλιο γιατί. Επιπλέον, το `signIn` callback (`lib/auth.ts:83-88`) απορρίπτει οποιοδήποτε email δεν τελειώνει σε `@kinsen.gr`, δεύτερο layer άμυνας. **Παρ' όλα αυτά**: αν ποτέ λείψει το `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` σε production, η εφαρμογή πέφτει πίσω στο multi-tenant "common" endpoint — μετριασμένο (όχι μηδενισμένο) από το domain allowlist. **Σύσταση**: κάνε το `TENANT_ID` hard-required (throw at boot αν λείπει) αντί για graceful fallback. |
| **Informational (καλή πρακτική)** | Microsoft mappings δεν μπορούν ποτέ να χορηγήσουν System Admin / Department Admin | `MicrosoftMappingValidationError` με ρητό guard (`isGlobalRoleAllowedForMicrosoftMapping`, `isDepartmentRoleAllowedForMicrosoftMapping`) — αποτρέπει privilege escalation μέσω κακόβουλου/λανθασμένου Microsoft mapping. |
| **Informational (καλή πρακτική)** | Πλήρες server-side RBAC layer πέρα από το Microsoft login | `requireAuth()`/`requireAdmin()`/`requireDepartmentPermission()` (`lib/permissions.ts`) — η authorization είναι πλήρως ξεχωριστή, DB-driven, δεν εξαρτάται από claims του Microsoft token. |
| **Informational** | `$select` χρησιμοποιείται παντού, pagination σωστή | `/me`, `/users`, mailbox messages — όλα περιορίζουν πεδία με `$select`. Το `/users` scan κάνει σωστό `@odata.nextLink` paging με `MAX_PAGES=200` guard κατά runaway loop. |
| **Informational** | Κανένα `NEXT_PUBLIC_*` variable δεν εκθέτει Microsoft secret | Το μόνο `NEXT_PUBLIC_*` σχετικό με secrets είναι το web-push VAPID public key (άσχετο με Microsoft, εκ σχεδιασμού public). |
| **Informational** | Κανένα token δεν εμφανίζεται σε logs | Ρητά τεκμηριωμένο και επιβεβαιωμένο (`console.log`/`console.warn` calls καταγράφουν μόνο `reason`, `status`, counts — ποτέ token/secret/raw response body). |

---

## 13. Diagnostic Verification Results

*(Ενημέρωση από μεταγενέστερο audit: το script αυτό αντικαταστάθηκε από το πιο ολοκληρωμένο `scripts/verify-microsoft-integration.ts`, που καλύπτει τα ίδια checks plus delegated `/me`+photo, directory pagination follow-through, και explicit reporting για τα NOT IMPLEMENTED capabilities. Βλ. το νεότερο production-readiness audit.)*

Δημιουργήθηκε **`scripts/microsoft-graph-diagnostic.ts`** — read-only, τρέχει με:
```
npx tsx --env-file=.env scripts/microsoft-graph-diagnostic.ts
```
Ελέγχει: (1) OIDC discovery του login tenant (unauthenticated, καμία interactive sign-in — αυτό δεν μπορεί να αυτοματοποιηθεί με ασφάλεια), (2) απόκτηση application token μέσω client-credentials, με εμφάνιση **μόνο** safe JWT claims (`aud`, `appid`, `tid`, `roles`, `exp` — ΠΟΤΕ το token value), (3) 3 read-only Graph calls (mailbox profile, 1 inbox message id, 1 directory user id — `$top=1` παντού, καμία εγγραφή/αλλαγή).

**Πραγματικά αποτελέσματα σε αυτό το dev environment:**

```
6 PASS, 2 FAIL, 3 SKIP
```

- ✅ Και τα 6 απαιτούμενα env vars (`AUTH_MICROSOFT_ENTRA_ID_*` ×3, `GRAPH_*` ×3) είναι **set**.
- ❌ Το OIDC discovery document ΚΑΙ η απόκτηση application token απέτυχαν, επειδή το `.env` σε αυτό το dev/audit environment έχει **placeholder τιμή `"dummy"`** στο tenant ID (όχι πραγματικό Azure tenant) — αναμενόμενο σε τοπικό dev χωρίς πραγματικά Azure credentials, **όχι bug**.
- Τα 3 Graph read-only calls παραλείφθηκαν (SKIP) εφόσον δεν υπήρχε token να χρησιμοποιηθεί.

**Άρα**: η λογική του script επιβεβαιώθηκε σωστή (σωστά αναγνωρίζει env vars, σωστά αποτυγχάνει με σαφές μήνυμα σε μη-πραγματικά credentials), αλλά **η πλήρης end-to-end επαλήθευση έναντι πραγματικού Azure tenant δεν έγινε** — θα χρειαστεί να τρέξει από κάποιον με πρόσβαση στα πραγματικά production/staging Azure credentials.

---

## 14. Πραγματικά Gaps / Μη επαληθευμένα σημεία

1. **Δεν μπόρεσα να επιβεβαιώσω ποια permissions είναι όντως consented στο πραγματικό Azure app registration σήμερα** — το audit βασίζεται αποκλειστικά στο τι *χρειάζεται ο κώδικας*, όχι στο τι είναι *ήδη ρυθμισμένο* στο Entra portal (δεν έχω πρόσβαση στο Azure portal). Το §10.B ("υπερβολικά permissions") είναι **υποθετικό based on code needs** — χρειάζεται χειροκίνητος έλεγχος στο πραγματικό Entra admin center.
2. **Το diagnostic script δεν έτρεξε επιτυχώς έναντι πραγματικού Azure tenant** (§13) — μόνο η λογική επαληθεύτηκε, όχι η πραγματική Graph συνδεσιμότητα.
3. **Δεν μπόρεσα να επιβεβαιώσω ποιο User Assignment / Conditional Access setup υπάρχει σήμερα** στο πραγματικό app registration — μόνο σύσταση δόθηκε.
4. **Documentation drift**: το `docs/microsoft-graph-directory-sync.md` αναφέρει route path `/api/admin/microsoft-directory/departments/sync`, αλλά το πραγματικό route είναι `/api/admin/microsoft-directory/values/sync` — το doc είναι ελαφρώς παλιωμένο (πιθανώς γράφτηκε πριν προστεθεί το jobTitle scanning). Δεν επηρεάζει τη λειτουργία, μόνο την τεκμηρίωση.
5. **`AZURE_AD_TENANT_ID`** — δεν μπόρεσα να προσδιορίσω τον σκοπό του (legacy από παλαιότερη υλοποίηση; παράλληλο documentation reference;) πέρα από το ότι δεν χρησιμοποιείται πουθενά σήμερα.
6. **`AUTO_CREATE_GRAPH_DEPARTMENTS`** — δεν επιβεβαίωσα αν είναι ενεργό (`true`) στο σημερινό `.env` ή όχι· αν είναι ενεργό, ένα Microsoft login μπορεί να δημιουργήσει αυτόματα νέο Department — καθαρά functional θέμα, όχι permission θέμα, αλλά αξίζει να το γνωρίζει ο admin.
