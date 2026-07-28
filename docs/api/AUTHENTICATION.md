# TicketApp API — Authentication

*Τεκμηρίωση βασισμένη αποκλειστικά στην ανάγνωση του πραγματικού κώδικα: `lib/auth.ts`, `lib/auth.config.ts`, `middleware.ts`, `lib/permissions.ts`, `app/api/email/inbound/route.ts`. Καμία υπόθεση, μόνο ό,τι πραγματικά υλοποιείται σήμερα.*

---

## 1. Auth.js session (ο μοναδικός μηχανισμός για σχεδόν κάθε endpoint)

Η εφαρμογή χρησιμοποιεί **Auth.js v5** (`next-auth@5.0.0-beta.25`) με **JWT session strategy** (`session: { strategy: "jwt" }`, `lib/auth.ts:222`). Δύο providers:

### 1.1 Microsoft Entra ID (SSO)

- Provider: `MicrosoftEntraID` (`lib/auth.config.ts:26-46`), scope `"openid profile email User.Read"`.
- `issuer` κλειδωμένο στο συγκεκριμένο tenant (`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`) — αν δεν έχει οριστεί tenant, γίνεται fallback στο multi-tenant `"common"` endpoint (σχόλιο στον κώδικα το επισημαίνει ρητά ως λιγότερο ασφαλές).
- `signIn` callback (`lib/auth.ts:80-90`): για Microsoft sign-in, το email πρέπει να τελειώνει σε `@${ALLOWED_EMAIL_DOMAIN}` (default `kinsen.gr`) — αλλιώς redirect σε `/unauthorized?reason=domain`.
- Στο πρώτο sign-in, το `jwt` callback (`lib/auth.ts:92-201`) καλεί `handleMicrosoftJwtSignIn()` (`lib/services/microsoft-department-sync-service.ts`) που κάνει live `GET /me` στο Microsoft Graph (με το delegated access token του sign-in) για να συγχρονίσει department/role/group signals — αποτυχία του Graph call απλώς παραλείπει το sync, ΔΕΝ μπλοκάρει το login.
- `allowDangerousEmailAccountLinking` ενεργό μόνο όταν υπάρχει πραγματικό tenant configured (`lib/auth.config.ts:45`) — επιτρέπει σε ένα Microsoft sign-in να συνδεθεί αυτόματα με υπάρχον `User` row με το ίδιο email (π.χ. δημιουργημένο μέσω credentials/admin).

### 1.2 Credentials (email + password)

- Provider `Credentials` (`lib/auth.ts:26-76`) — μόνο `email`/`password`, validated με `adminLoginSchema` (`lib/validations.ts:360-363`).
- `authorize()`: `prisma.user.findUnique({where:{email}})`, `bcrypt.compare(password, user.passwordHash)`. Αν `!user.isActive`, throws `InactiveUserError` (code `"inactive_user"`, φτάνει στο client μέσω `SignInResponse.code`).
- Δεν υπάρχει self-registration endpoint — ο μοναδικός τρόπος να αποκτήσει κάποιος `passwordHash` είναι μέσω `POST /api/admin/users` (Administrator-only) ή seed data.

### 1.3 Το session cookie

- Cookie name: **`authjs.session-token`** (Auth.js v5 default), httpOnly, encrypted JWE (A256CBC-HS512).
- `session.user` περιέχει: `id`, `role`, `mustChangePassword`, `departmentId?`, `businessUnitId?`, `customRoleId?`, `microsoftUserId?`, `globalRoleSource?`, `name?`, `email?`, `image` (πάντα `null` — βλ. §3).
- `AUTH_SECRET` (env var) είναι το signing/encryption secret.

---

## 2. `requireAuth()` και το middleware — τι πραγματικά ελέγχεται

### 2.1 Route-level check (`lib/permissions.ts:180-186`)

```ts
export async function requireAuth() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  return session;
}
```

Καλείται σε κάθε internal write/read route. Ελέγχει **μόνο** ότι υπάρχει `session.user` — δεν κάνει καμία επιπλέον, live επαλήθευση έναντι της βάσης σε αυτό το σημείο.

### 2.2 `middleware.ts` — ένα δεύτερο, ανεξάρτητο layer

```ts
export const { auth: middleware } = NextAuth(authConfig);
export default middleware;
export const config = { matcher: ["/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.json|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|map|txt|xml)$).*)"] };
```

Ο πραγματικός έλεγχος γίνεται στο `authorized()` callback (`lib/auth.config.ts:66-81`): αν το path δεν είναι στο `PUBLIC_PATHS` (`/login`, `/unauthorized`, `/api/auth`, `/api/email/inbound`), απαιτείται `isLoggedIn` (`!!auth?.user`) και το email πρέπει να τελειώνει σε `@${ALLOWED_EMAIL_DOMAIN}`. Αποτυχία → redirect στο `/login` (η matcher regex εξαιρεί μόνο στατικά αρχεία με συγκεκριμένες επεκτάσεις — τα `/api/**` routes **δεν** εξαιρούνται, άρα ένα ανεξέλεγκτο `fetch()` χωρίς cookie σε οποιοδήποτε `/api/tickets`-like path παίρνει HTTP 307 redirect προς `/login`, όχι καθαρό 401 JSON).

**Πρακτική συνέπεια για integration/testing**: ένα plain `fetch()`/`curl` χωρίς session cookie δεν παίρνει `401` από το ίδιο το route handler — το middleware παρεμβαίνει πρώτο με `307` προς `/login`. Το route handler's δικό του `requireAuth()`/401 logic εκτελείται μόνο αν η αίτηση περάσει το middleware (δηλ. έχει ήδη ένα έγκυρο, αναγνωρίσιμο session cookie, ακόμη κι αν αυτό αντιστοιχεί σε stale/ανύπαρκτο local user — βλ. §3).

---

## 3. Τι ΔΕΝ ελέγχεται σε κάθε request — stale session reality

Αυτό είναι τεκμηριωμένο με ακρίβεια από τον πραγματικό κώδικα, όχι υπόθεση:

- Η JWT `session` strategy σημαίνει ότι το `session()` callback (`lib/auth.ts:203-221`) τρέχει σε κάθε `auth()`/`requireAuth()` κλήση, αλλά **παράγει το session αποκλειστικά από το ήδη-αποκρυπτογραφημένο JWT token** — δεν κάνει καμία νέα ερώτηση στη βάση.
- Το `jwt()` callback (όπου γίνεται η **μοναδική** πραγματική ανάγνωση από τη βάση, `prisma.user.findUnique`) τρέχει **μόνο κατά το αρχικό sign-in** (`if (user?.email)` guard, `lib/auth.ts:94`) — όχι σε κάθε επόμενο request με το ίδιο token.
- Ο μοναδικός "still valid" έλεγχος που ΥΠΑΡΧΕΙ είναι στο `session()` callback: `if (token.isActive === false) return null` (`lib/auth.ts:205`) — αλλά αυτό διαβάζει το **cached** `token.isActive`, μια τιμή που γράφτηκε στο token τη στιγμή του τελευταίου sign-in/token-refresh, όχι μια live τιμή από τη βάση σε κάθε request.
- **Συνέπεια, τεκμηριωμένη ρητά εδώ ως πραγματική συμπεριφορά του σημερινού κώδικα**: αν ένα `User` row διαγραφεί εντελώς από τη βάση (όχι απλώς `isActive:false`) αφού ο χρήστης έχει ήδη ένα έγκυρο JWT cookie, το session παραμένει "authenticated" — `requireAuth()` περνάει κανονικά, γιατί `session.user` εξακολουθεί να υπάρχει ως αντικείμενο (source: το token), απλώς το `session.user.id` δεν αντιστοιχεί πλέον σε πραγματική γραμμή. Το αν αυτό προκαλεί σφάλμα εξαρτάται αποκλειστικά από το αν το route handler που ακολουθεί κάνει τη δική του, ξεχωριστή αναζήτηση στη βάση με αυτό το `id` (π.χ. ένα `prisma.ticket.create({data:{requesterId: session.user.id}}))` θα χτυπήσει foreign-key violation σε αυτή την περίπτωση — δεν υπάρχει κεντρικό, upfront "ο authenticated local user υπάρχει ακόμα" check πριν από αυτό).
- Δεν υπάρχει κανένα session-invalidation μηχανισμό όταν διαγράφεται ένα `User` row (π.χ. server-side session store revocation) — με JWT strategy (χωρίς database session strategy) δεν υπάρχει καν πίνακας `Session` στη βάση για να γίνει revoke.

---

## 4. `/api/email/inbound` — ξεχωριστός μηχανισμός, Bearer token

```ts
function isAuthorized(req: NextRequest): boolean {
  const webhookSecret = process.env.EMAIL_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (!webhookSecret && !cronSecret) return true; // αν λείπουν ΚΑΙ τα δύο, γίνεται δεκτό ΚΑΘΕ request
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  return (!!webhookSecret && token === webhookSecret) || (!!cronSecret && token === cronSecret);
}
```

- **Authorization header μόνο** (`Bearer <secret>`), ποτέ query param.
- `EMAIL_WEBHOOK_SECRET` και `CRON_SECRET` αντιμετωπίζονται ως πλήρως εναλλάξιμα — όποιο από τα δύο ταιριάζει γίνεται δεκτό, χωρίς να καταγράφεται ποιο ακριβώς χρησιμοποιήθηκε.
- Σύγκριση με απλό `===` (όχι constant-time comparison).
- **Σημαντικό, επιβεβαιωμένο στο τρέχον `.env` αυτού του environment**: αν λείπουν ΚΑΙ τα δύο secrets, η συνάρτηση επιστρέφει `true` — δηλαδή το endpoint γίνεται προσβάσιμο από **οποιονδήποτε**, χωρίς κανένα token, όσο τα secrets δεν έχουν οριστεί.
- Καμία επικύρωση body size ή content-type — το route δεν διαβάζει καν το body του request (καλεί `processInboundEmails()`, το οποίο αντλεί τα emails απευθείας από το Microsoft Graph API, όχι από το request body — αυτό είναι ένα "poll-trigger" endpoint, όχι payload-driven webhook).
- Χρησιμοποιείται από: Vercel Cron (GET, κάθε 2 λεπτά), manual curl/webhook (POST), και έμμεσα από `POST /api/admin/email/poll` (session-based, admin-only "Poll Now" κουμπί — **δεν** περνάει μέσα από αυτό το `isAuthorized()`, χρησιμοποιεί το δικό του `requireAdmin()`).

---

## 5. Τι ΔΕΝ υπάρχει σήμερα

- ❌ Κανένα API key mechanism.
- ❌ Κανένα OAuth 2.0 client-credentials flow για εισερχόμενες κλήσεις από άλλες εφαρμογές (η μόνη χρήση OAuth στο repository είναι η ίδια η εφαρμογή ως client προς το Microsoft Entra ID, δηλ. εξερχόμενη).
- ❌ Κανένα service-account concept.
- ❌ Κανένα CORS configuration (`next.config.ts` δεν ορίζει CORS headers πουθενά).
- ❌ Κανένα explicit CSRF token requirement πέρα από το ενσωματωμένο Auth.js `csrf-token` cookie (σχετικό μόνο με browser-originated form submissions· ένα server-to-server `fetch`/`curl` με JSON body δεν εμπλέκει καθόλου CSRF-protected φόρμες).

---

## 6. Τι μπορεί πραγματικά να χρησιμοποιήσει μια εξωτερική εφαρμογή σήμερα

**Καμία δυνατότητα machine-to-machine κλήσης χωρίς πραγματικό, ενεργό browser session cookie**, με μία μερική εξαίρεση:

- `/api/email/inbound` — καλέσιμο με static shared secret (`Authorization: Bearer <secret>`), αλλά μόνο για να πυροδοτήσει email polling· δεν δέχεται κανένα άλλο δεδομένο, δεν επιστρέφει δεδομένα άλλα από polling-run στατιστικά.
- Κάθε άλλο endpoint (106 από τα 107 υπόλοιπα method-handlers, βλ. [ENDPOINT_INVENTORY.md](./ENDPOINT_INVENTORY.md)) απαιτεί ένα πραγματικό `authjs.session-token` cookie, αποκτημένο μόνο μέσω interactive login (Microsoft OAuth redirect ή το credentials form). Ένα script/εξωτερική εφαρμογή που θέλει να καλέσει αυτά τα endpoints πρέπει είτε να προσομοιώσει πλήρες browser login και να επαναχρησιμοποιήσει το cookie (εύθραυστο, όχι προτεινόμενο production pattern), είτε να περιμένει μελλοντική, ξεχωριστή machine-to-machine authentication υποδομή — που **δεν υπάρχει σήμερα στον κώδικα**.

Πλήρης, endpoint-by-endpoint classification: [ENDPOINT_INVENTORY.md](./ENDPOINT_INVENTORY.md). Προτάσεις (όχι υλοποιημένες) για μελλοντική M2M πρόσβαση: [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md).
