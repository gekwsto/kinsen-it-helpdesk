# TicketApp API — Workflows

*Πρακτικοί, βήμα-προς-βήμα οδηγοί με πραγματικά endpoints. **Κάθε παράδειγμα εδώ απαιτεί έγκυρο `authjs.session-token` cookie** — δες [AUTHENTICATION.md](./AUTHENTICATION.md) για το πώς αποκτάται. Δεν υπάρχει Bearer-token μονοπάτι για κανένα από αυτά τα endpoints.*

`BASE_URL` = `http://localhost:3000` (local) ή το πραγματικό deployment domain σου.

---

## Ticket Lifecycle

### 1. Ανάγνωση department configuration (πριν το create)

```bash
curl -b cookies.txt "${BASE_URL}/api/admin/statuses?departmentId=<departmentId>"
curl -b cookies.txt "${BASE_URL}/api/admin/priorities?departmentId=<departmentId>"
curl -b cookies.txt "${BASE_URL}/api/admin/categories?departmentId=<departmentId>"
```
Κάθε response είναι ένα raw array `{id,name,...}[]`. Τα `id` values είναι database IDs — **διαφορετικά ανά department**, ποτέ μην τα κάνεις hardcode.

### 2. Δημιουργία ticket

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/tickets" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Δεν μπορώ να συνδεθώ στο VPN",
    "description": "Το VPN client δίνει σφάλμα timeout από το πρωί.",
    "departmentId": "<departmentId>",
    "priorityId": "<priorityId>",
    "categoryId": "<categoryId>"
  }'
```
Response `201` — αποθήκευσε το `id` (θα χρειαστεί για κάθε επόμενο βήμα) και το `ticketNumber`.

### 3. Ανάθεση χρήστη (agent)

```bash
curl -b cookies.txt "${BASE_URL}/api/users?assignableFor=ticket&departmentId=<departmentId>"
# επίλεξε ένα user.id από το αποτέλεσμα, μετά:
curl -b cookies.txt -X PATCH "${BASE_URL}/api/tickets/<ticketId>/assign" \
  -H "Content-Type: application/json" \
  -d '{"assignedAgentId": "<userId>"}'
```

### 4. Προσθήκη comment

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/tickets/<ticketId>/reply" \
  -H "Content-Type: application/json" \
  -d '{"body": "Ελέγχω το θέμα, θα επανέλθω σε 30 λεπτά.", "isInternal": false}'
```

### 5. Upload attachment

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/tickets/<ticketId>/attachments" \
  -F "file=@screenshot.png"
```
⚠️ Το επιστρεφόμενο `path` είναι ένα **unauthenticated static URL** — βλ. [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md) §3.

### 6. Αλλαγή priority/status

```bash
curl -b cookies.txt -X PATCH "${BASE_URL}/api/tickets/<ticketId>" \
  -H "Content-Type: application/json" \
  -d '{"priorityId": "<newPriorityId>"}'

curl -b cookies.txt -X PATCH "${BASE_URL}/api/tickets/<ticketId>/status" \
  -H "Content-Type: application/json" \
  -d '{"statusId": "<inProgressStatusId>"}'
```

### 7. Close/Cancel

```bash
# Close — απλώς μετάβαση σε ένα isClosed status
curl -b cookies.txt -X PATCH "${BASE_URL}/api/tickets/<ticketId>/status" \
  -H "Content-Type: application/json" \
  -d '{"statusId": "<closedStatusId>"}'

# Cancel — ξεχωριστό endpoint, απαιτεί cancelReasonId
curl -b cookies.txt "${BASE_URL}/api/admin/cancel-reasons?departmentId=<departmentId>"
curl -b cookies.txt -X POST "${BASE_URL}/api/tickets/<ticketId>/cancel" \
  -H "Content-Type: application/json" \
  -d '{"cancelReasonId": "<cancelReasonId>", "note": "Ο χρήστης έλυσε μόνος του το πρόβλημα."}'
```

### 8. Ανάγνωση τελικού ticket (με πλήρες ιστορικό)

```bash
curl -b cookies.txt "${BASE_URL}/api/tickets/<ticketId>"
```
Η response περιλαμβάνει `messages[]`, `attachments[]`, `history[]` (πλήρες audit trail με `TicketHistory` entries — `CREATED`, `STATUS_CHANGE`, `ASSIGNMENT_CHANGE`, κ.λπ.).

---

## Project Lifecycle

### 1. Δημιουργία project

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Αναβάθμιση δικτύου Γ' ορόφου",
    "description": "Αντικατάσταση switches και καλωδίωσης.",
    "departmentId": "<departmentId>",
    "status": "PLANNING",
    "priority": 1,
    "startDate": "2026-08-01",
    "endDate": "2026-09-30"
  }'
```
`ownerId` γίνεται πάντα ο authenticated caller — δεν στέλνεται στο body.

### 2. Ανάθεση χρηστών (μέλη)

```bash
curl -b cookies.txt "${BASE_URL}/api/users?assignableFor=project&departmentId=<departmentId>"
curl -b cookies.txt -X PATCH "${BASE_URL}/api/projects/<projectId>" \
  -H "Content-Type: application/json" \
  -d '{"memberIds": ["<userId1>", "<userId2>"]}'
```
⚠️ `memberIds` γίνεται πλήρης αντικατάσταση (`set`), όχι προσθήκη — στείλε πάντα την πλήρη τελική λίστα.

### 3. Δημιουργία activities μέσα στο project

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/activities" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Παραγγελία εξοπλισμού",
    "projectId": "<projectId>",
    "status": "TODO",
    "priority": "HIGH",
    "assignedUserIds": ["<userId1>"],
    "startDate": "2026-08-01",
    "dueDate": "2026-08-10"
  }'
```
`departmentId` κληρονομείται αυτόματα από το project αν παραληφθεί.

### 4. Ενημέρωση dates/statuses activities

```bash
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"status": "IN_PROGRESS"}'
```
Το `progress` του project (0-100%) υπολογίζεται αυτόματα από τον μέσο όρο των activities του — δεν στέλνεται ποτέ απευθείας.

### 5. Ανάγνωση project progress

```bash
curl -b cookies.txt "${BASE_URL}/api/projects/<projectId>"
```
Η response περιλαμβάνει `activities[]` με το τρέχον status/progress κάθε μιας. Το ίδιο το `Project.progress` field ενημερώνεται fire-and-forget κάθε φορά που μια activity αλλάζει status/project.

### 6. Ανάγνωση Gantt

**Δεν υπάρχει ξεχωριστό JSON API για Gantt.** Το Project Gantt (`/projects/gantt`) και το Activity Gantt (`/activities/gantt`) είναι αποκλειστικά server-rendered Next.js Server Components — διαβάζουν απευθείας από τη βάση κατά το rendering, όχι μέσω κάποιου `GET /api/.../gantt` endpoint. Μια εξωτερική εφαρμογή δεν έχει σήμερα τρόπο να πάρει τα ίδια δεδομένα ως JSON πέρα από το να συνθέσει τα δικά της ερωτήματα σε `GET /api/projects`/`GET /api/activities`.

---

## Activity Lifecycle

### 1. Δημιουργία standalone activity

```bash
curl -b cookies.txt -X POST "${BASE_URL}/api/activities" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Ετήσιος έλεγχος πυρασφάλειας",
    "departmentId": "<departmentId>",
    "status": "TODO",
    "priority": "MEDIUM"
  }'
```
Χωρίς `projectId` → standalone. `progress` πάντα server-derived, ποτέ δεκτό από τον client.

### 2. Σύνδεση με project (ή αποσύνδεση)

```bash
# Σύνδεση
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"projectId": "<projectId>"}'

# Αποσύνδεση (standalone ξανά) — ρητό null, όχι παράλειψη
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"projectId": null}'
```
Το target project πρέπει να ανήκει στο ίδιο department με την activity — cross-department σύνδεση απορρίπτεται (`400 invalid_project_scope`).

### 3. Ανάθεση users

```bash
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"assignedUserIds": ["<userId1>", "<userId2>"]}'
```

### 4. Αλλαγή dates

```bash
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"startDate": "2026-08-05", "dueDate": "2026-08-20"}'
```
`startDate > dueDate` απορρίπτεται (`400 invalid_date_range`).

### 5. Αλλαγή status/progress

```bash
curl -b cookies.txt -X PATCH "${BASE_URL}/api/activities/<activityId>" \
  -H "Content-Type: application/json" \
  -d '{"status": "COMPLETED", "isCompleted": true}'
```
Το `progress` **δεν** στέλνεται ποτέ — υπολογίζεται server-side από το `status`, σύμφωνα με το configured mapping του department (`GET /api/admin/activity-progress?departmentId=...` για να δεις το τρέχον mapping). Αν λείπει configuration για το status/department, η αίτηση απορρίπτεται (`409 configuration_required`) αντί να αποθηκευτεί ένα επινοημένο ποσοστό.

### 6. Resource Planning / Gantt updates (drag-drop κ.λπ.)

**Δεν υπάρχει ξεχωριστό endpoint.** Το Resource Planning UI (`/projects/resource-planning`) είναι επίσης αποκλειστικά server-rendered — οποιαδήποτε αλλαγή ημερομηνιών μέσω αυτού του UI καταλήγει στο ίδιο `PATCH /api/activities/{id}` που περιγράφεται στο βήμα 4 παραπάνω. Δεν υπάρχει σήμερα κάποιο ξεχωριστό "drag/drop API" ή "reassignment API" — είναι το ίδιο generic update endpoint.

---

## Integration examples — σύνοψη πραγματικότητας

**Δεν υπάρχει σήμερα κανένα integration flow που να μην απαιτεί browser session cookie.** Κάθε παράδειγμα παραπάνω προϋποθέτει ότι το `cookies.txt` περιέχει ένα έγκυρο `authjs.session-token`, αποκτημένο μέσω πραγματικού interactive login. Δεν υπάρχει καμία εναλλακτική αυθεντικοποίηση (API key, Bearer token, OAuth client-credentials) για αυτά τα endpoints — βλ. [AUTHENTICATION.md](./AUTHENTICATION.md) και [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md) για πλήρη ανάλυση.

Το μόνο πραγματικό, μη-session integration flow στο σημερινό API είναι το webhook:

```bash
curl -X POST "${BASE_URL}/api/email/inbound" \
  -H "Authorization: Bearer <EMAIL_WEBHOOK_SECRET>"
```
— και αυτό απλώς πυροδοτεί ένα Microsoft Graph email-polling κύκλο, δεν δέχεται/επιστρέφει κανένα business entity data.
