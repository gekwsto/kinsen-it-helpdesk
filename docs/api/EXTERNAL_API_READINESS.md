# TicketApp API — External API Readiness

*Χωρίς καμία αλλαγή κώδικα. Κατέγραψε τι μπορεί πραγματικά να χρησιμοποιηθεί σήμερα από μια εξωτερική εφαρμογή, τι όχι, και ποια gaps υπάρχουν. Οι προτάσεις στο τέλος είναι σκέψεις για μελλοντική φάση — καμία δεν έχει υλοποιηθεί.*

---

## 1. Classification legend

| Classification | Σημασία |
|---|---|
| `INTERNAL_SESSION_ONLY` | Απαιτεί έγκυρο `authjs.session-token` cookie, αποκτημένο μόνο μέσω interactive browser login. Σχεδιασμένο αποκλειστικά για τη δική του UI. |
| `ADMIN_ONLY` | Το ίδιο με πάνω, ΚΑΙ επιπλέον απαιτεί `Role.ADMIN` (ή ισοδύναμο global permission που στην πράξη μόνο ο Administrator έχει). |
| `AUTH_INTERNAL` | Το ίδιο το Auth.js OAuth/session μηχανισμό — δεν είναι business API, είναι το login flow. |
| `WEBHOOK` | Bearer shared-secret authentication, όχι session cookie. |
| `NOT_SAFE_FOR_EXTERNAL_USE` | Απαιτεί μεν session, αλλά έχει μια πλευρική συνέπεια που το κάνει επικίνδυνο να εκτεθεί/χρησιμοποιηθεί από εξωτερική εφαρμογή σήμερα (βλ. §3). |
| `PUBLIC` / `CRON_ONLY` / `EXTERNAL_READY` | Δεν υπάρχει κανένα endpoint σε αυτές τις κατηγορίες σήμερα. |

Πλήρης πίνακας ανά endpoint: [ENDPOINT_INVENTORY.md](./ENDPOINT_INVENTORY.md).

---

## 2. Ποια endpoints μπορούν πραγματικά να χρησιμοποιηθούν από άλλη εφαρμογή σήμερα

**Ένα, μερικώς**: `/api/email/inbound` (GET/POST) — με `Authorization: Bearer <EMAIL_WEBHOOK_SECRET ή CRON_SECRET>`. Ακόμη κι αυτό είναι εξαιρετικά περιορισμένο: δεν δέχεται κανένα δεδομένο πέρα από το να πυροδοτήσει ένα Microsoft Graph email-polling κύκλο — δεν μπορεί να δημιουργήσει/διαβάσει/ενημερώσει κανένα business entity απευθείας.

**Κανένα άλλο** από τα υπόλοιπα 107 method handlers μπορεί να κληθεί σήμερα χωρίς ένα πραγματικό, ενεργό browser session cookie. Δεν υπάρχει API key, OAuth client-credentials, ή service-account μηχανισμός — βλ. [AUTHENTICATION.md](./AUTHENTICATION.md) §5.

**Πρακτική συνέπεια**: μια εξωτερική εφαρμογή που θέλει σήμερα να δημιουργήσει/διαβάσει Tickets, Projects, Activities, Departments, Users, κ.λπ. δεν έχει κανέναν επίσημο, production-safe τρόπο να το κάνει. Το μόνο τεχνικά εφικτό (αλλά **δεν προτείνεται**) μονοπάτι θα ήταν να προσομοιώσει πλήρες browser login και να επαναχρησιμοποιήσει το προκύπτον session cookie — εύθραυστο (λήγει, εξαρτάται από UI αλλαγές, δεν είναι σχεδιασμένο για αυτό τον σκοπό).

---

## 3. Γιατί `POST /api/tickets/{id}/attachments` χαρακτηρίζεται `NOT_SAFE_FOR_EXTERNAL_USE`

Το ίδιο το route **απαιτεί** session cookie για upload — μέχρι εκεί συμπεριφέρεται σαν κάθε άλλο `INTERNAL_SESSION_ONLY` endpoint. Το πρόβλημα είναι στο **αποτέλεσμα** του upload:

- Το αρχείο αποθηκεύεται κάτω από `UPLOAD_DIR` (default `./public/uploads/{ticketId}/{filename}` — επιβεβαιωμένο στον πραγματικό κώδικα, `app/api/tickets/[id]/attachments/route.ts`).
- Το `public/` directory του Next.js σερβίρεται **πάντα** ως static files, εντελώς εκτός του `middleware.ts` (Auth.js session gate) — το middleware's matcher (`middleware.ts:8`) εξαιρεί ρητά αρχεία με συγκεκριμένες επεκτάσεις εικόνας/κειμένου, και ακόμη και για επεκτάσεις που ΔΕΝ εξαιρούνται από τη matcher regex, το static-file-serving του `public/` folder προηγείται του routing/middleware layer οπουδήποτε αντιστοιχεί ένα αρχείο.
- Το επιστρεφόμενο `path` πεδίο στο response (`/uploads/{ticketId}/{filename}`) είναι επομένως μια **unauthenticated URL** — οποιοσδήποτε αποκτήσει/μαντέψει αυτό το path μπορεί να κατεβάσει το αρχείο, ανεξάρτητα από το αν ο ticket έχει `shareWithDepartment:false` και είναι ορατός μόνο στον requester/ανατεθειμένο agent.

**Συνέπεια για εξωτερική χρήση**: ακόμη κι αν μια εξωτερική εφαρμογή μπορούσε να αποκτήσει έγκυρο session (κάτι που δεν προτείνεται ούτως ή άλλως), το επιστρεφόμενο `path` δεν πρέπει ποτέ να θεωρηθεί ασφαλές/persistent αναγνωριστικό πρόσβασης — είναι ένα δημόσιο URL. Αυτό είναι το πιο σοβαρό, πραγματικό εύρημα αυτού του audit.

---

## 4. Λοιπά authentication gaps

Κατεγραμμένα με ακρίβεια, χωρίς διόρθωση:

1. **Κανένα API key/OAuth client-credentials/service-account μηχανισμό** — βλ. [AUTHENTICATION.md](./AUTHENTICATION.md) §5. Το μόνο Bearer-token endpoint (`/api/email/inbound`) χρησιμοποιεί ένα static shared secret, όχι per-application scoped credential.
2. **`/api/email/inbound` fail-open όταν λείπουν τα secrets**: αν ΚΑΙ τα δύο `EMAIL_WEBHOOK_SECRET`/`CRON_SECRET` δεν έχουν οριστεί, η συνάρτηση `isAuthorized()` επιστρέφει `true` για ΟΛΟΥΣ — το endpoint γίνεται προσβάσιμο χωρίς κανένα token. Επιβεβαιωμένο ότι λείπουν και τα δύο από το `.env` αυτού του environment.
3. **Stale session δεν ανιχνεύεται live**: όπως τεκμηριώνεται στο [AUTHENTICATION.md](./AUTHENTICATION.md) §3, το `session()` callback δεν κάνει καμία νέα ερώτηση στη βάση σε κάθε request — αν ένα `User` row διαγραφεί, το session παραμένει "authenticated" μέχρι να λήξει το JWT. Αν κάποιο route handler κάνει στη συνέχεια write με `session.user.id` που δεν αντιστοιχεί πλέον σε πραγματική γραμμή, το αποτέλεσμα είναι ένα foreign-key constraint violation στη βάση, το οποίο (βλ. [ERROR_CODES.md](./ERROR_CODES.md) §Prisma/database errors) καταλήγει σε ένα αδιαφοροποίητο `500 {"error":"Internal error"}` — χωρίς συγκεκριμένο, αναγνωρίσιμο error code.
4. **Καμία CORS ρύθμιση** πουθενά στον κώδικα (`next.config.ts` δεν ορίζει CORS headers) — server-to-server calls δεν επηρεάζονται (CORS είναι browser-enforced), αλλά ένα browser-based external app σε διαφορετικό origin θα μπλοκαριστεί αυτόματα.
5. **Δύο διαφορετικά error contracts** συνυπάρχουν (βλ. [ERROR_CODES.md](./ERROR_CODES.md)) — μια εξωτερική εφαρμογή που περιμένει string σε `error` θα σπάσει σε validation errors (422) από τα περισσότερα core business-entity routes, όπου το `error` είναι ένα raw `ZodIssue[]` array.
6. **`active-workspace`-style cookie fallback**: αρκετά write endpoints (π.χ. tickets/projects/activities create) βασίζονται σε server-side workspace/membership resolution όταν παραλείπεται explicit `departmentId` — ένα machine client που δεν διαχειρίζεται cookies stateful θα πάρει απρόβλεπτο department resolution αν δεν στέλνει πάντα explicit `departmentId`.
7. **Καμία rate limiting υποδομή** πουθενά στον κώδικα.
8. **Καμία API versioning** — δεν υπάρχει `/api/v1/` prefix ή version header οπουδήποτε στο repository σήμερα.

---

## 5. Τι θα χρειαζόταν σε μελλοντική φάση για ασφαλές M2M access (πρόταση — ΔΕΝ υλοποιήθηκε)

Αυτή η ενότητα είναι αμιγώς προτάσεις για συζήτηση/σχεδιασμό, **όχι** αλλαγή στον κώδικα ή δέσμευση υλοποίησης:

- Ένα ξεχωριστό, scoped credential μοντέλο για εξωτερικές εφαρμογές (π.χ. per-application API key ή OAuth client-credentials), με explicit department/scope περιορισμούς — ρητά διαχωρισμένο από το Auth.js session/browser-login μηχανισμό, όχι πάνω του.
- Πρώτα τη διόρθωση του §3 (attachments) πριν θεωρηθεί οποιοδήποτε attachment-related endpoint ασφαλές για εξωτερική χρήση.
- Ρύθμιση `EMAIL_WEBHOOK_SECRET` σε production ώστε το §4.2 fail-open σενάριο να μην είναι ποτέ πραγματικό.
- Ένα συγκεκριμένο, αναγνωρίσιμο error code (αντί για γενικό 500) όταν ένα authenticated session αναφέρεται σε μη-υπαρκτό local user — ώστε ο client να μπορεί να ζητήσει re-authentication καθαρά αντί να λάβει αδιαφοροποίητο server error.
- Ενοποίηση του error contract σε όλα τα routes.
- Rate limiting, CORS policy, και API versioning πριν από οποιαδήποτε πραγματική εξωτερική έκθεση.

Καμία από τις παραπάνω προτάσεις δεν πρέπει να θεωρηθεί μέρος της σημερινής, πραγματικής συμπεριφοράς του API.
