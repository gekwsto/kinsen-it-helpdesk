# TicketApp API — Error Codes & Contracts

*Πλήρης, πραγματική λίστα error codes — εξήχθησαν με `grep` πάνω στον πραγματικό κώδικα (`app/api/**`, `lib/**`), όχι επινοημένη λίστα.*

## ⚠️ Τρία διαφορετικά error contracts συνυπάρχουν σήμερα στο ίδιο API

Αυτό είναι το πιο σημαντικό πράγμα που πρέπει να ξέρει μια εξωτερική εφαρμογή πριν κάνει parse σε ένα error response. Contracts A και B είναι και τα δύο **internal, session-based** endpoints — μια εξωτερική εφαρμογή δεν πρέπει να τα καλεί καθόλου. Contract C είναι το μόνο πραγματικά εξωτερικό contract.

### Contract A — Structured (`lib/api-errors.ts`)

Χρησιμοποιείται **μόνο** από αυτά τα 7 route files: `app/api/admin/statuses/route.ts`, `app/api/admin/categories/route.ts`, `app/api/admin/priorities/route.ts`, `app/api/admin/cancel-reasons/route.ts`, `app/api/admin/sla/route.ts`, `app/api/admin/activity-progress/route.ts`, `app/api/admin/activity-statuses/route.ts`.

```json
{
  "code": "duplicate_status_name",
  "error": "A status named \"Open\" already exists in this department.",
  "message": "A status named \"Open\" already exists in this department.",
  "field": "name",
  "fieldErrors": { "name": "A status named \"Open\" already exists in this department." }
}
```

- `code`: σταθερό, μηχανικά αναγνωρίσιμο string.
- `error` **και** `message`: πάντα identical string (`lib/api-errors.ts`'s `apiError()` τα θέτει ταυτόχρονα, για backward-compat με παλαιότερους frontend readers του `err.error`), human-readable, ασφαλές — ποτέ raw Prisma/SQL/stack trace.
- `field`/`fieldErrors`: παρόντα μόνο σε validation errors.
- Παράγεται από `zodErrorResponse(error)` για 422, ή απευθείας `apiError(code, message, opts)` για κάθε άλλο status.

### Contract B — Legacy (raw `{ error }`, όλα τα υπόλοιπα routes)

Χρησιμοποιείται από **Tickets, Projects, Activities, Goals, Dependencies, Users (admin), Departments (admin + non-admin), Microsoft Mappings, Roles, Notifications, Dashboard, Workspace**.

```json
{ "error": "Forbidden" }
```

ή, σε **422 validation error — η πιο σημαντική διαφορά**:

```json
{ "error": [ { "code": "too_small", "minimum": 5, "path": ["title"], "message": "Title must be at least 5 characters" } ] }
```

⚠️ **Στο Contract B, το `error` field σε validation failures (422) είναι raw `ZodIssue[]` ARRAY, όχι string.** Αυτό προκύπτει από τον ίδιο τον κώδικα (π.χ. `app/api/tickets/route.ts`: `if (error.name === "ZodError") return NextResponse.json({ error: error.errors }, { status: 422 });`) — ένας client πρέπει να ελέγχει `Array.isArray(body.error)` πριν προσπαθήσει να το εμφανίσει ως string. Δεν είναι επινοημένη ασυνέπεια — είναι η πραγματική, τρέχουσα συμπεριφορά.

**Ορισμένα Contract B routes προσθέτουν ΚΑΙ ένα `code` string field** σε συγκεκριμένα, χειροκίνητα προστιθέμενα σημεία (π.χ. `{"error": "Project not found", "code": "project_not_found"}`) — αλλά **όχι σε κάθε response** του ίδιου route, και ποτέ `message`/`field`/`fieldErrors`. Πάντα έλεγξε αν το `code` υπάρχει πριν βασιστείς σε αυτό.

### Contract C — Πρακτική σημείωση

Δεν υπάρχει σήμερα κανένα endpoint σχεδιασμένο ειδικά για εξωτερική/machine-to-machine κατανάλωση, άρα δεν υπάρχει ξεχωριστό "εξωτερικό" error contract στο repository σήμερα — μόνο τα A και B παραπάνω, και τα δύο UI-oriented. Οποιαδήποτε μελλοντική external API θα χρειαστεί το δικό της, ξεχωριστό contract (πρόταση, όχι υλοποιημένο): [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md).

---

## Πλήρης λίστα πραγματικών `code` values

### Contract A (`apiError()` — 7 admin config routes)

| Code | HTTP Status | Meaning | Routes |
|---|---|---|---|
| `validation_failed` | 422 | Zod validation error | όλα τα 7 |
| `duplicate_status_name` | 409 | Status name ήδη υπάρχει σε αυτό το department | `/api/admin/statuses` |
| `duplicate_default_status` | 409 | Ήδη υπάρχει active default status σε αυτό το department | `/api/admin/statuses` |
| `duplicate_category_name` | 409 | | `/api/admin/categories` |
| `duplicate_priority_name` | 409 | | `/api/admin/priorities` |
| `duplicate_cancel_reason_name` | 409 | | `/api/admin/cancel-reasons` |
| `duplicate_status` | 409 | Activity Status row ήδη υπάρχει | `/api/admin/activity-statuses` |
| `department_required` | 400 | Το entity χρειάζεται `departmentId` | όλα τα 7 |
| `invalid_department` | 400 | Το department δεν υπάρχει | όλα τα 7 |
| `invalid_color` | 400/422 | Color δεν ταιριάζει `^#[0-9A-Fa-f]{6}$` | statuses, categories, priorities |
| `invalid_label` | 400 | | `/api/admin/activity-statuses` |
| `invalid_percentage` | 400 | | `/api/admin/activity-progress` |
| `invalid_status` | 400 | | `/api/admin/activity-progress`, `/api/admin/activity-statuses` |
| `invalid_sla_hours` | 400 | firstResponseHours/resolutionHours invalid | `/api/admin/sla` |
| `invalid_payload` | 400 | Malformed request body | όλα τα 7 |
| `item_in_use` | 409 | Δεν μπορεί να διαγραφεί/απενεργοποιηθεί — χρησιμοποιείται | statuses, categories, priorities, activity-progress, activity-statuses |
| `item_not_found` | 404 | | όλα τα 7 |
| `system_item_locked` | 400/403 | Built-in item δεν μπορεί να τροποποιηθεί/διαγραφεί | statuses/categories/priorities κ.λπ. |
| `cross_department_denied` | 403 | Priority/entity δεν ανήκει στο δηλωμένο department | `/api/admin/sla` |
| `unauthorized` | 401 | `unauthorizedResponse()` | όλα τα 7 |
| `missing_permission` | 403 | `forbiddenResponse()` | όλα τα 7 (+ κάποια Contract B routes) |
| `internal_error` | 500 | Γενικό, ασφαλές server error | όλα τα 7 |

### Contract B (raw `{error, code?}` — υπόλοιπα routes)

| Code | HTTP Status | Meaning | Routes |
|---|---|---|---|
| `ticket_not_found` | 404 | | tickets pending accept/reject, department PATCH |
| `project_not_found` | 404 | | tickets, activities |
| `activity_not_found` | 404 | | tickets, activities PATCH |
| `department_not_found` | 404 | | Microsoft mappings |
| `user_not_found` | 404 | | department members POST |
| `not_found` | 404 | Generic | roles |
| `assignee_not_assignable` | 400 | Ο επιλεγμένος χρήστης δεν είναι eligible assignee σε αυτό το department | tickets, projects, activities |
| `invalid_project_scope` | 400 | Project ανήκει σε άλλο department | activities PATCH, tickets link validation |
| `invalid_activity_scope` | 400 | | tickets/activities link validation |
| `invalid_project_activity_pair` | 400 | Activity δεν ανήκει στο δηλωμένο project | ticket create/update project+activity link |
| `subdepartment_department_mismatch` | 400 | Sub-department δεν ανήκει στο δηλωμένο department | tickets, projects, activities |
| `subdepartment_required_for_share` | 400 | `shareWithSubDepartment:true` χωρίς `subDepartmentId` | tickets PATCH |
| `invalid_subdepartment` | 400 | | admin sub-department routes |
| `invalid_date_range` | 400 | `startDate > dueDate` | activities PATCH |
| `invalid_status_transition` | 400 | `isCompleted`/`status` ασυνεπή | activities PATCH |
| `configuration_required` | 409 | Λείπει Activity Progress config για department+status | activities create/update |
| `duplicate_department` | 400 | Το ίδιο department επιλέχθηκε 2 φορές σε `departmentMemberships[]` | admin users create |
| `duplicate_mapping` | 409 | Microsoft mapping ήδη υπάρχει (unique constraint) | Microsoft mappings |
| `invalid_role` | 400 | Custom role invalid/GLOBAL scope σε department context | users, department members |
| `role_not_allowed` | 400 | Microsoft mapping προσπαθεί να χορηγήσει Admin/Department Admin | Microsoft mappings |
| `role_in_use` | 409 | Custom role δεν μπορεί να διαγραφεί — χρησιμοποιείται | admin roles |
| `builtin_role_locked` | 400 | Built-in role δεν μπορεί να διαγραφεί | admin roles |
| `cannot_remove_last_admin` | 400 | Guardrail — δεν επιτρέπεται μηδενισμός System Admin | admin roles |
| `invalid_permission_scope` | 400 | | admin roles |
| `email_in_use` | 409 | | admin users |
| `invalid_email` | 400 | | admin users |

**Επιπλέον, χωρίς `code` field καθόλου** (Contract B, μόνο `{"error": "..."}` string): `"Not found"`, `"Forbidden"`, `"Unauthorized"`, `"Internal error"`, `"No default status configured"` (500 — server misconfiguration, βλ. §Prisma/database errors παρακάτω), `"Ticket is already cancelled"` (409), `"Ticket is already closed"` (409), `"File too large (max 10MB)"`, `"File type not allowed"`, `"No file provided"`, `"Upload failed"` (500, generic catch — βλ. παρακάτω).

---

## HTTP Status Codes σε χρήση

| Status | Χρήση |
|---|---|
| 200 | Επιτυχής GET/PATCH/PUT |
| 201 | Επιτυχής POST (δημιουργία) |
| 204 | Επιτυχής DELETE (no body) |
| 307 | Redirect προς `/login` όταν λείπει session cookie (middleware, όχι το route handler) |
| 400 | Bad request / validation (μη-Zod) / business-rule rejection |
| 401 | Unauthenticated (καμία/άκυρη session, ή route handler's δικό του `requireAuth()` catch) |
| 403 | Forbidden (authenticated αλλά χωρίς permission) |
| 404 | Resource not found |
| 409 | Conflict (duplicate, already-in-state, in-use) |
| 422 | Zod validation failure |
| 500 | Server error — και πραγματικά bugs, και σκόπιμα γενικά μηνύματα |
| 502 | Upstream (Microsoft Graph) failure — μόνο `/api/admin/microsoft-directory/values/sync` |

---

## Prisma/database errors που ενδέχεται να διαρρέουν ως generic 500

Επιβεβαιωμένο διαβάζοντας τα `catch` blocks: **κανένα raw Prisma error message, SQL detail, ή stack trace δεν επιστρέφεται ποτέ στον client** — κάθε γενικό `catch (error)` σε Contract B routes επιστρέφει σταθερά `{"error": "Internal error"}` (status 500), χωρίς `error.message`. Contract A routes χρησιμοποιούν `internalErrorResponse()` με το ίδιο ασφαλές μήνυμα.

**Πραγματικό, τεκμηριωμένο gap**: αυτό σημαίνει ότι ένα foreign-key constraint violation στη βάση (π.χ. `requesterId`/`createdById`/`ownerId` δεν αντιστοιχεί σε υπαρκτό `User` row — κάτι που θα συνέβαινε αν το authenticated session αναφέρεται σε διαγραμμένο local user, βλ. [AUTHENTICATION.md](./AUTHENTICATION.md) §3) **δεν αναγνωρίζεται ειδικά πουθενά στον σημερινό κώδικα** — καταλήγει στο γενικό `catch` block και επιστρέφεται ως ένα αδιαφοροποίητο `500 {"error": "Internal error"}`, χωρίς συγκεκριμένο `code` όπως `session_user_not_found` ή `requester_not_found`. Αυτό επιβεβαιώθηκε διαβάζοντας τα `catch` blocks των `app/api/tickets/route.ts`, `app/api/projects/route.ts`, `app/api/activities/route.ts` — κανένα δεν κάνει pattern-match πάνω σε Prisma error codes (π.χ. `P2003` foreign-key violation) πριν επιστρέψει το generic 500. Καταγράφεται εδώ ως πραγματικό εύρημα, όχι ως πρόταση αλλαγής — δες [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md) για το πού αυτό κατατάσσεται ως gap.

Το `POST /api/tickets/[id]/attachments`'s `catch` block ειδικά επιστρέφει `{"error": "Upload failed"}` (500) για **οτιδήποτε** αποτύχει μέσα στο try block (συμπεριλαμβανομένου malformed multipart body parsing) — δεν διαχωρίζει "file system error" από "invalid request".
