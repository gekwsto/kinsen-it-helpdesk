# TicketApp API Documentation

Πλήρες, πρακτικό documentation του TicketApp API — βασισμένο **αποκλειστικά** στον πραγματικό κώδικα του repository (`app/api/**/route.ts`, `lib/validations.ts`, `lib/permissions.ts`, `lib/auth.ts`, `lib/auth.config.ts`, `middleware.ts`). Παράχθηκε ως read-only audit — καμία αλλαγή δεν έγινε στην εφαρμογή.

## ⚠️ Πριν διαβάσεις οτιδήποτε άλλο

**Το API σήμερα απαιτεί browser-session authentication (Auth.js cookie) για σχεδόν κάθε endpoint.** Δεν υπάρχει σήμερα API key, OAuth client-credentials flow, ή service-account μηχανισμός για machine-to-machine integration. Η μόνη εξαίρεση είναι το `/api/email/inbound` webhook, το οποίο δεν εκθέτει κανένα business entity — απλώς πυροδοτεί email polling. Διάβασε το [`AUTHENTICATION.md`](./AUTHENTICATION.md) και το [`EXTERNAL_API_READINESS.md`](./EXTERNAL_API_READINESS.md) πριν σχεδιάσεις οποιαδήποτε integration.

## Base URL

| Environment | Base URL |
|---|---|
| Local | `http://localhost:3000` |
| Staging/Production | Δεν υπάρχει σταθερό public URL καταγεγραμμένο στον κώδικα — χρησιμοποίησε το πραγματικό deployment domain σου (`NEXT_PUBLIC_APP_URL` στο `.env` είναι η authoritative τιμή στο εκάστοτε deployment). |

Δεν υπάρχει `/api/v1/` prefix ή οποιαδήποτε άλλη API versioning σήμερα — κάθε endpoint είναι απευθείας κάτω από `/api/*`.

## Authentication overview

- **Auth.js JWT session cookie** (`authjs.session-token`) — ο μοναδικός μηχανισμός για 107 από τα 109 method handlers. Microsoft Entra ID SSO ή email+password credentials login.
- **1 εξαίρεση**: `/api/email/inbound` δέχεται `Authorization: Bearer $EMAIL_WEBHOOK_SECRET` (ή το deprecated-interchangeable `$CRON_SECRET`) — static shared secret, όχι scoped credential, **fail-open** αν λείπουν και τα δύο.
- Πλήρης ανάλυση, συμπεριλαμβανομένου του πώς αντιμετωπίζεται (ή όχι) ένα stale/διαγραμμένο local user: [`AUTHENTICATION.md`](./AUTHENTICATION.md).

## Γρήγορη πλοήγηση

| Αρχείο | Περιεχόμενο |
|---|---|
| [`README.md`](./README.md) | Αυτό το αρχείο — entry point |
| [`ENDPOINT_INVENTORY.md`](./ENDPOINT_INVENTORY.md) | Συνοπτικός πίνακας όλων των 109 method/path combinations με classification |
| [`API_REFERENCE.md`](./API_REFERENCE.md) | Αναλυτικό contract κάθε endpoint — body, response, errors, side effects |
| [`AUTHENTICATION.md`](./AUTHENTICATION.md) | Auth.js session, Microsoft login, webhook secrets, τι μπορεί/δεν μπορεί να χρησιμοποιήσει μια εξωτερική εφαρμογή σήμερα |
| [`WORKFLOWS.md`](./WORKFLOWS.md) | Ticket/Project/Activity lifecycle με πραγματικά `curl` examples |
| [`ERROR_CODES.md`](./ERROR_CODES.md) | Τα **τρία** διαφορετικά error contracts, πλήρης λίστα error codes |
| [`EXTERNAL_API_READINESS.md`](./EXTERNAL_API_READINESS.md) | Τι είναι πραγματικά έτοιμο για external use σήμερα, τι όχι, ποια gaps υπάρχουν |
| [`ticketapp-openapi.yaml`](./ticketapp-openapi.yaml) | OpenAPI 3.1 machine-readable specification |
| [`TicketApp.postman_collection.json`](./TicketApp.postman_collection.json) | Postman collection |
| [`TicketApp.local.postman_environment.json`](./TicketApp.local.postman_environment.json) | Postman environment (local) |

## Σε αδρές γραμμές

- **61** `route.ts` αρχεία, **109** πραγματικά HTTP method handlers.
- **85** `INTERNAL_SESSION_ONLY`, **19** `ADMIN_ONLY`, **2** `AUTH_INTERNAL` (Auth.js catch-all), **2** `WEBHOOK` (GET+POST στο ίδιο endpoint), **1** `NOT_SAFE_FOR_EXTERNAL_USE` (attachment upload — βλ. παρακάτω).
- Δύο βασικά domains **δεν** έχουν καμία JSON API έκθεση σήμερα: Resource Planning και Gantt (Project + Activity) — αποκλειστικά server-rendered.

## ⚠️ Σοβαρό εύρημα — attachments

`POST /api/tickets/{id}/attachments` απαιτεί μεν session, αλλά το αποθηκευμένο αρχείο σερβίρεται στη συνέχεια από το `public/uploads/{ticketId}/{filename}` — ένα Next.js static-file path εντελώς εκτός του Auth.js middleware. Το επιστρεφόμενο `path` στο response είναι επομένως ένα **unauthenticated URL**, ανεξάρτητα από το αν ο ticket είναι ιδιωτικός. Πλήρης ανάλυση: [`EXTERNAL_API_READINESS.md`](./EXTERNAL_API_READINESS.md) §3.

## Μην θεωρήσεις το TicketApp έτοιμο για external integration

Αυτό το documentation set περιγράφει με ακρίβεια τον **σημερινό** κώδικα — δεν σημαίνει ότι το API είναι σχεδιασμένο ή ασφαλές για χρήση από άλλη εφαρμογή. Δες ρητά το [`EXTERNAL_API_READINESS.md`](./EXTERNAL_API_READINESS.md) πριν υποθέσεις οτιδήποτε για machine-to-machine δυνατότητες.
