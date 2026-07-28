# TicketApp — Πλήρες API Reference

*Βασισμένο αποκλειστικά στον πραγματικό κώδικα (`app/api/**/route.ts`, `lib/validations.ts`, `lib/permissions.ts`). Κάθε endpoint παρακάτω επιβεβαιώθηκε διαβάζοντας την πραγματική implementation, όχι μόνο το filename. Classification labels εξηγούνται στο [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md).*

**Σύνολο**: 61 `route.ts` αρχεία, **109** HTTP method handlers. Authentication (εκτός όπου σημειώνεται): Auth.js JWT session cookie (`authjs.session-token`) — δες [AUTHENTICATION.md](./AUTHENTICATION.md). Error contract: **τρία** διαφορετικά σχήματα υπάρχουν ταυτόχρονα — δες [ERROR_CODES.md](./ERROR_CODES.md), σημειώνεται ρητά ανά endpoint.

---

## Authentication

### `GET/POST /api/auth/{nextauth}` — Auth.js catch-all
**Classification**: `AUTH_INTERNAL` | Χειρίζεται όλο το OAuth redirect flow, callback, session read, CSRF token, sign-out. Δεν είναι business API. **Source**: `app/api/auth/[...nextauth]/route.ts` (`export const { GET, POST } = handlers;`, από `lib/auth.ts`).

Πλήρης ανάλυση credentials/Microsoft login, session cookie, JWT lifecycle, stale-session συμπεριφορά: [AUTHENTICATION.md](./AUTHENTICATION.md).

---

## Tickets

### `GET /api/tickets` — List/search/filter tickets
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + permission `ticket.view` | **Source**: `app/api/tickets/route.ts`

**Query params**: `page` (default 1), `limit` (default 20), `search` (τίτλος/περιγραφή/requester name-email, ή ticket number αν αριθμητικό), `statusId`, `priorityId`, `categoryId`, `assignedAgentId`, `departmentId`, `subDepartmentId`, `source` (`WEB`\|`EMAIL`), `createdAfter`/`createdBefore` (ISO date), `sortBy` (`createdAt`\|`updatedAt`\|`priority`\|`status`, default `createdAt`), `sortDir` (`asc`\|`desc`, default `desc`), `unassigned` (`true`), `myOnly` (`true`), `projectId`, `activityId`.

**Department scoping**: `departmentId` **δεν** εμπιστεύεται τυφλά — περνά από `buildTicketListWhere(userId, role, departmentId)` (`lib/services/department-scope-service.ts`), το οποίο επικυρώνει πραγματική membership. Χωρίς `departmentId`, ενώνει (union) όλα τα προσβάσιμα departments του caller. `403 {"error":"You don't have access to this department"}` αν η επικύρωση αποτύχει.

**Response 200**: `{ tickets: Ticket[], total, page, limit, totalPages }` — πλήρες pagination.

**Errors**: `401 {"error":"Unauthorized"}` (καμία session).

---

### `POST /api/tickets` — Create ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `ticket.create` | **Source**: `app/api/tickets/route.ts`

**Body** (`createTicketSchema`): `title` (5-200 chars, **required**), `description` (min 10 chars, **required**), `categoryId?`, `priorityId?`, `departmentId?`, `subDepartmentId?`, `projectId?`, `activityId?`, `shareWithDepartment` (default `false`), `shareWithSubDepartment` (default `false`).

- **`requesterId` είναι πάντα ο authenticated caller** — ποτέ client-settable.
- Σύνδεση σε `projectId`/`activityId` επιτρέπεται **μόνο σε `Role.ADMIN`** — `403 {"error":"Only administrators can link tickets to projects or activities"}` αλλιώς.
- Department resolution: explicit `departmentId` → (αν `projectId` δωμένο, κληρονομεί το project's department όταν λείπει) → `active-workspace` cookie fallback (`getActiveWorkspace`) → `resolveDepartmentForCreate` (τελική επικύρωση permission). Αποτυχία → `{"error": <μήνυμα>}` με status `400`/`403` ανάλογα με τον λόγο (`departmentDenialStatus`).
- Αν `projectId`/`activityId` δωμένα: `validateTicketProjectActivityLink` επιβεβαιώνει ότι ανήκουν στο ίδιο department (404 αν δεν υπάρχουν, 400 αν mismatch, με `code`).
- `subDepartmentId` (αν δωμένο) πρέπει να ανήκει στο resolved department → `400 {"error":"...", "code":"subdepartment_department_mismatch"}`.
- Default status: `resolveDefaultStatusId(departmentId)` — αν δεν υπάρχει κανένα configured, `500 {"error":"No default status configured"}` (server misconfiguration).
- Side effects: δημιουργεί αρχικό `TicketHistory` (`type:"CREATED"`) + αρχικό `TicketMessage` (η περιγραφή γίνεται το πρώτο, `INBOUND` μήνυμα).

**Response 201**: πλήρες `Ticket` (με `status`, `priority`, `category`, `requester`).

**Errors**: `422 {"error": ZodIssue[]}` (validation), `500 {"error":"Internal error"}` (catch-all).

**Idempotency**: **ΟΧΙ ασφαλές να επαναληφθεί** — κανένα `Idempotency-Key` header, κανένα unique constraint στο business περιεχόμενο (μόνο auto-increment `ticketNumber`). Retry μετά από timeout δημιουργεί duplicate.

---

### `GET /api/tickets/{id}` — Get ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `canViewTicket()` | **Source**: `app/api/tickets/[id]/route.ts`

`canViewTicket` (`lib/services/department-scope-service.ts`): system-wide (Admin/Director) → πάντα ναι· requester/assigned-agent → πάντα ναι· αλλιώς department-wide `ticket.view` permission (full-view tier) → ναι· `REQUESTER`-tier membership → μόνο αν `shareWithDepartment`/`shareWithSubDepartment` true.

**Response 200**: πλήρες `Ticket` με `messages[]` (φιλτραρισμένα τα `isInternal` αν ο caller δεν έχει `ticket.internalNote`), `attachments[]`, `history[]`, `status`, `priority`, `category`, `cancelReason`, `requester`, `assignedAgent`, `department`.

**Errors**: `404 {"error":"Not found"}`, `403 {"error":"Forbidden"}`, `401 {"error":"Unauthorized"}` (catch-all).

---

### `PATCH /api/tickets/{id}` — Update ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "ticket.changeStatus", isOwner)` (owner bypass) | **Source**: `app/api/tickets/[id]/route.ts`

**Body** (`updateTicketSchema`, όλα optional): `title`, `description`, `categoryId` (nullable), `priorityId` (nullable), `statusId`, `assignedAgentId` (nullable), `cancelReasonId` (nullable), `projectId` (nullable), `activityId` (nullable), `shareWithDepartment`, `shareWithSubDepartment`. (`departmentId`/`subDepartmentId` **δεν** περιλαμβάνονται — δες dedicated PATCH `.../department` παρακάτω.)

- Αλλαγή `projectId`/`activityId` → μόνο `Role.ADMIN`.
- Νέο `assignedAgentId` → πρέπει να είναι eligible assignee για tickets σε αυτό το department (`userHasAssignablePermissionForEntity`) → `400 {"code":"assignee_not_assignable"}`.
- Share-flag αλλαγές: owner κάνει πάντα bypass· αλλιώς `ticket.share.department`/`ticket.share.subdepartment` permission → `403 {"code":"missing_permission"}`. `shareWithSubDepartment:true` χωρίς `subDepartmentId` → `400 {"code":"subdepartment_required_for_share"}`.
- Side effects: `TicketHistory` entries για status/priority/assignee αλλαγές· `closedAt` set αυτόματα αν το νέο status είναι `isClosed`· real-time events (`TICKET_PRIORITY_CHANGED`/`TICKET_STATUS_CHANGED`/`TICKET_ASSIGNEE_CHANGED`) μέσω `publishTicketEvent`.

**Response 200**: ενημερωμένο `Ticket`.

**Errors**: `404`, `403`, `422 {"error": ZodIssue[]}`, `500`.

---

### `DELETE /api/tickets/{id}` — Delete ticket
**Classification**: `ADMIN_ONLY` | **Auth**: `requireAdmin()` | **Source**: `app/api/tickets/[id]/route.ts`

Hard delete. Διαγράφει φυσικά αρχεία attachments κάτω από `UPLOAD_DIR/{ticketId}/`. Cascade στο schema: `TicketMessage`/`TicketAttachment`/`TicketHistory` έχουν `onDelete: Cascade`.

**Response**: `204` (κενό body). **Errors**: `401`, `403`, `404`.

---

### `PATCH /api/tickets/{id}/status` — Change status
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "ticket.changeStatus", isOwner)` | **Source**: `app/api/tickets/[id]/status/route.ts`

**Body** (`changeStatusSchema`): `statusId` (**required**), `cancelReasonId?`.

Side effects: `closedAt` set αν το νέο status `isClosed`· `TicketHistory` (`type: isClosed?"CLOSED":"STATUS_CHANGE"`)· real-time event· fire-and-forget email notification στον requester αν κλείνει (`notifyRequesterClosed`).

**Response 200**: `Ticket` με `status`+`cancelReason` includes. **Errors**: `404`, `403`, `422 {"error":ZodIssue[]}`, `500`.

---

### `PATCH /api/tickets/{id}/assign` — Assign/unassign agent
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "ticket.assign")` (**όχι** owner bypass) | **Source**: `app/api/tickets/[id]/assign/route.ts`

**Body**: `{assignedAgentId: string | null}`. Ο target χρήστης πρέπει να είναι eligible assignee → `400 {"code":"assignee_not_assignable"}` αλλιώς. Side effects: `TicketHistory` (`ASSIGNMENT_CHANGE`), real-time event.

**Response 200**: `Ticket` με `assignedAgent`. **Errors**: `404`, `403`, `422`, `500`.

---

### `PATCH /api/tickets/{id}/department` — Move department/sub-department
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "ticket.department.change", false)` (owner ΔΕΝ κάνει bypass — μοναδικό PATCH με αυτή τη ρύθμιση) | **Source**: `app/api/tickets/[id]/department/route.ts`

**Body** (`changeTicketDepartmentSchema`): `departmentId` (**required**), `subDepartmentId?` (nullable).

- Αν το target department διαφέρει, ελέγχει επιπλέον `ticket.department.change` permission ΣΤΟ target (`getMembership`+`hasDepartmentPermission`, εκτός αν Admin/Director) → `403 {"code":"invalid_department"}`.
- Target department πρέπει να υπάρχει → `404 {"code":"invalid_department"}`.
- Νέο sub-department πρέπει να ανήκει στο target department → `400 {"code":"subdepartment_department_mismatch"}`.
- **Αν αλλάζει department**, επανεπικυρώνει category/priority/status/cancelReason/project/activity — τα nullable καθαρίζονται σιωπηλά αν δεν ανήκουν πλέον στο target department· το status (required) πέφτει στο target department's default μέσω `resolveDefaultStatusId`.
- No-op (ίδιο department+subdepartment) → επιστρέφει το ticket ως έχει, χωρίς audit εγγραφή.
- Side effects: `departmentChangedById`/`departmentChangedAt` fields, `TicketHistory` (`DEPARTMENT_CHANGE`).

**Response 200**: ενημερωμένο `Ticket` με `department`, `subDepartment`, `departmentChangedBy`. **Errors**: `404 {"code":"ticket_not_found"}`, `403 {"code":"missing_permission"}`, `400`, `422`, `401`, `500`.

---

### `POST /api/tickets/{id}/cancel` — Cancel ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: Admin ή requester | **Source**: `app/api/tickets/[id]/cancel/route.ts`

**Body**: `{cancelReasonId: string, note?: string (max 1000)}`.

`409 {"error":"Ticket is already cancelled"}` αν `cancelReasonId` ήδη set· `409 {"error":"Ticket is already closed"}` αν το status ήδη `isClosed`. Cancel reason πρέπει να είναι `isActive` → `422 {"error":"Cancel reason not found or inactive"}`.

Side effects (σε transaction): βρίσκει ένα `isClosed` status στο department του ticket (fallback legacy department) και μεταφέρει το ticket εκεί αν υπάρχει· `TicketHistory` (`CANCEL_REASON_SET`)· admin notes γίνονται internal `TicketMessage` (`INTERNAL_NOTE`), requester notes μένουν μόνο στο history.

**Response 200**: `{status, cancelReasonId, closedAt}`. **Errors**: `404`, `403`, `409`, `422`, `401`, `500`.

---

### `POST /api/tickets/{id}/reply` — Add comment/reply/internal note
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `ticket.reply` permission ή requester· `isInternal:true` απαιτεί επιπλέον `ticket.internalNote` | **Source**: `app/api/tickets/[id]/reply/route.ts`

**Body** (`replyTicketSchema`): `body` (**required**, non-empty), `direction` (`INBOUND`\|`OUTBOUND`\|`INTERNAL_NOTE`, default `OUTBOUND`), `isInternal` (default `false`).

Side effects: `TicketMessage` create· `TicketHistory` (`COMMENT_ADDED`)· fire-and-forget email + in-app + web-push notification στον requester όταν agent απαντά δημόσια (`!isInternal && canManageTickets && requester≠caller && requester δεν είναι Admin`)· real-time event (`TICKET_MESSAGE_CREATED` ή `TICKET_INTERNAL_NOTE_CREATED`).

**Response 201**: `TicketMessage` με `author`, `attachments`. **Errors**: `404`, `403`, `422 {"error":ZodIssue[]}`, `500`.

---

### `POST /api/tickets/{id}/attachments` — Upload attachment
**Classification**: `NOT_SAFE_FOR_EXTERNAL_USE` (**βλ. EXTERNAL_API_READINESS.md §3**) | **Auth**: `canViewAllTickets()` ή requester | **Content-Type**: `multipart/form-data` | **Source**: `app/api/tickets/[id]/attachments/route.ts`

| Field (form-data) | Type | Required |
|---|---|---|
| `file` | binary | ✅ — max **10MB**, allowed MIME: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`, `application/msword`, `.docx`, `.xls`, `.xlsx`, `text/plain`, `application/zip` |
| `messageId` | string | — (προαιρετικά συνδέει το attachment με συγκεκριμένο μήνυμα) |

Side effects: `TicketHistory` (`ATTACHMENT_ADDED`). **⚠️ Το αποθηκευμένο αρχείο σερβίρεται ως static file κάτω από `public/uploads/{ticketId}/{filename}`, εντελώς εκτός Auth.js middleware.**

**Response 201**: attachment object με `path: "/uploads/{ticketId}/{filename}"` — **δεν** είναι authenticated URL.

**Errors**: `400 {"error":"No file provided"}` / `"File too large (max 10MB)"` / `"File type not allowed"`, `403`, `404`, `500 {"error":"Upload failed"}` (γενικό catch-all — καλύπτει και malformed multipart body).

---

### `GET /api/tickets/{id}/stream` — Real-time SSE event stream
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canViewAllTickets()` ή requester | **Content-Type**: `text/event-stream` | **Source**: `app/api/tickets/[id]/stream/route.ts`

Μόνιμη σύνδεση (`export const dynamic = "force-dynamic"`), heartbeat κάθε 20s. Events: `CONNECTED`, `TICKET_STATUS_CHANGED`, `TICKET_PRIORITY_CHANGED`, `TICKET_ASSIGNEE_CHANGED`, `TICKET_MESSAGE_CREATED`, `TICKET_INTERNAL_NOTE_CREATED` (φιλτραρισμένο για callers χωρίς `ticket.internalNote`). Καμία REST σημασιολογία (GET-only, μόνιμη σύνδεση) — ακατάλληλο για curl-style testing.

---

### `POST /api/tickets/pending/{id}/accept` — Accept pending (email) ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `ticket.pending.accept` (department-scoped αν το pending ticket έχει ήδη department, αλλιώς global permission μόνο) | **Source**: `app/api/tickets/pending/[id]/accept/route.ts`

**Body**: `{departmentId?: string | null}` — χρησιμοποιείται μόνο αν το pending ticket δεν έχει ήδη matched department.

Καλεί `acceptPendingTicket()` (`lib/services/pending-ticket-service.ts`) — δημιουργεί πραγματικό `Ticket` (με default status/priority του department), αντιγράφει attachments, δημιουργεί αρχικό `TicketMessage`+`TicketHistory`, σημαδεύει το `PendingTicket` ως `ACCEPTED`.

**Response 200**: το νέο `Ticket`. **Errors**: `404 {"code":"ticket_not_found"}`, `403 {"code":"missing_permission"}`, discriminated result errors (`already_accepted`/`already_rejected`/`invalid_department`, status 400/409), `422`, `401`, `500`.

---

### `POST /api/tickets/pending/{id}/reject` — Reject pending ticket
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `ticket.pending.reject` (ίδιο μοτίβο με accept) | **Source**: `app/api/tickets/pending/[id]/reject/route.ts`

Soft — κρατά το `PendingTicket` row (`status: REJECTED`), ποτέ δεν παράγει `Ticket`. **Response 200**: `{ok:true}`. **Errors**: ίδιο μοτίβο με accept.

---

## Projects

### `GET /api/projects` — List/search/filter projects
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `buildProjectListWhere` scope (permission `project.view`) | **Source**: `app/api/projects/route.ts`

**Query params**: `page`, `limit` (defaults 1/20), `search` (τίτλος/περιγραφή), `status` (`ProjectStatus` enum), `departmentId`, `subDepartmentId`.

**Response 200**: `{projects: Project[], total, page, totalPages}` (πλήρες pagination· σημείωση: **δεν** επιστρέφει `limit` στο response object, σε αντίθεση με tickets).

**Errors**: `401`, `403 {"error":"You don't have access to this department"}`.

---

### `POST /api/projects` — Create project
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `project.create` (department-scoped) | **Source**: `app/api/projects/route.ts`

**Body** (`createProjectSchema`): `title` (3-200 chars, **required**), `description?`, `status` (`ProjectStatus`, default `PLANNING`), `priority` (1-3, default `2`), `departmentId?`, `subDepartmentId?` (nullable), `businessUnitId?`, `startDate?`, `endDate?`, `successTarget?`, `memberIds` (array, default `[]`), `isGoal` (default `false`).

- `ownerId` πάντα ο authenticated caller.
- Department: explicit → active-workspace fallback → `resolveDepartmentForCreate`.
- `subDepartmentId` πρέπει να ανήκει στο resolved department → `400 {"code":"subdepartment_department_mismatch"}`.
- Κάθε `memberIds[i]` πρέπει να είναι eligible assignee για projects σε αυτό το department → `400 {"code":"assignee_not_assignable"}`.

**Response 201**: `Project` με `owner`, `department`, `members`, `_count.activities`. **Errors**: `422 {"error":ZodIssue[]}`, `500`.

**Idempotency**: **ΟΧΙ ασφαλές** — καμία `Idempotency-Key` υποστήριξη.

---

### `GET /api/projects/{id}` — Get project
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "project.view")` | **Source**: `app/api/projects/[id]/route.ts`

**Response 200**: `Project` με `owner`, `department`, `businessUnit`, `members`, `activities[]` (με `assignedUser`). **Errors**: `404`, `403`, `401`.

---

### `PATCH /api/projects/{id}` — Update project
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "project.edit")` | **Source**: `app/api/projects/[id]/route.ts`

**Body**: `updateProjectSchema` = `createProjectSchema.partial()`. Αλλαγή `departmentId` σε διαφορετικό department απαιτεί `project.create` permission ΣΤΟ target (εκτός Admin) → `403`. `subDepartmentId` καθαρίζεται αυτόματα (`clearStaleSubDepartment`) αν το department αλλάζει χωρίς ρητό νέο sub-department. `members` γίνεται `set` (πλήρης αντικατάσταση, όχι incremental).

**Response 200**: ενημερωμένο `Project`. **Errors**: `404`, `403`, `400 {"code":"assignee_not_assignable"|"subdepartment_department_mismatch"}`, `422`, `500`.

---

### `DELETE /api/projects/{id}` — Delete project
**Classification**: `ADMIN_ONLY` | **Auth**: `requireAdmin()` | **Source**: `app/api/projects/[id]/route.ts`

**Ασφαλές cascade, χωρίς migration**: `Ticket.projectId` → `SetNull`, `ProjectActivity.projectId` → `SetNull` (explicit στο schema), `_ProjectMembers`/`_GoalProjects` join rows → DB `CASCADE`. Κανένα Ticket/Activity δεν διαγράφεται — απλώς αποσυνδέεται.

**Response**: `204`. **Errors**: `401`, `403`, `404`.

---

## Activities

### `GET /api/activities` — List/search/filter activities
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `buildActivityListWhere` scope (`activity.view`) | **Source**: `app/api/activities/route.ts`

**Query params**: `projectId`, `status` (`ActivityStatus` enum, μόνο valid τιμές εφαρμόζονται), `assignedUserId`, `departmentId`, `subDepartmentId`.

**⚠️ Καμία pagination** — `prisma.projectActivity.findMany({where,...})` χωρίς `skip`/`take`. Σε μεγάλο department, επιστρέφει **όλες** τις activities σε μία response.

**Response 200**: raw array `Activity[]` με `project`, `assignedUsers`, `department`. **Errors**: `401`, `403`.

---

### `POST /api/activities` — Create activity (standalone ή μέσα σε project)
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `activity.create` (department-scoped) | **Source**: `app/api/activities/route.ts`

**Body** (`createActivitySchema`): `title` (3-200, **required**), `description?`, `projectId?` (nullable — standalone αν παραληφθεί/null), `status` (`ActivityStatus`, default `TODO`), `priority` (`ActivityPriority`, default `MEDIUM`), `assignedUserIds` (array, default `[]`), `departmentId?`, `subDepartmentId?` (nullable), `businessUnitId?`, `startDate?`, `dueDate?`, `isCompleted` (default `false`), `isMilestone?`.

**⚠️ `progress` ΔΕΝ γίνεται δεκτό από τον client** — αφαιρείται εντελώς από το schema, πάντα server-derived από το `status` (per-department configurable, `lib/activities/activity-progress.ts`).

- `createdById` πάντα ο authenticated caller.
- Αν `projectId` δωμένο: κληρονομεί το project's department αν λείπει· mismatch ρητού `departmentId` έναντι του project's → `400 {"error":"An activity cannot be attached to a project from a different department"}` (χωρίς `code`).
- Λείπει config για status+department → **`409 {"code":"configuration_required"}`** (ΠΟΤΕ δεν επινοεί ένα progress ποσοστό).
- Side effect: fire-and-forget `recalculateProjectRollup(projectId)` αν συνδεδεμένο με project.

**Response 201**: `Activity` με `project`, `assignedUsers`. **Errors**: `404 {"error":"Project not found"}`, `400`, `409 {"code":"configuration_required"}`, `422 {"error":ZodIssue[]}`, `500`.

**Idempotency**: **ΟΧΙ ασφαλές**.

---

### `GET /api/activities/{id}` — Get activity
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "activity.view")` | **Source**: `app/api/activities/[id]/route.ts`

**Response 200**: `Activity` + `project`, `assignedUsers`, `department`, `businessUnit`, **και** runtime-υπολογισμένα: `progress` (μπορεί `null` + `progressConfigError:{reason}` αν λείπει config — ποτέ fake ποσοστό), `statusLabel`, `statusColor` (department-scoped display metadata, ανανεωμένα κάθε φορά, όχι απλώς η τελευταία αποθηκευμένη τιμή).

**Errors**: `404`, `403`, `401`.

---

### `PATCH /api/activities/{id}` — Update activity
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `canActOnEntity(..., "activity.edit")` | **Source**: `app/api/activities/[id]/route.ts`

**Body**: `updateActivitySchema` = `createActivitySchema.partial()` (`projectId` nullable — ρητό `null` καθιστά standalone).

- `startDate > dueDate` → `400 {"code":"invalid_date_range"}`.
- `isCompleted`/`status` ασυνεπή (π.χ. `isCompleted:true` με status≠`COMPLETED`) → `400 {"code":"invalid_status_transition"}`.
- Αλλαγή `departmentId` σε διαφορετικό → απαιτεί `activity.create` permission ΣΤΟ target (εκτός Admin) → `403`.
- Αλλαγή `projectId` (όχι στο ίδιο) → target project πρέπει να υπάρχει (`404 {"code":"project_not_found"}`) και να ανήκει στο (effective) department (`400 {"code":"invalid_project_scope"}`).
- `assignedUserIds[i]` κάθε ένα πρέπει να είναι eligible → `400 {"code":"assignee_not_assignable"}`.
- **`progress` ΠΑΝΤΑ re-derived** από status — ξανά-υπολογίζεται σε ΚΑΘΕ write, όχι μόνο όταν αλλάζει το status. Λείπει config → `409 {"code":"configuration_required"}`.
- `completedAt` set/clear αυτόματα με `isCompleted`.
- Side effects: fire-and-forget project rollup recalculation (παλιό project αν άλλαξε + νέο/τρέχον αν status ή project άλλαξε).

**Response 200**: ενημερωμένο `Activity` + `statusLabel`/`statusColor`. **Errors**: `404 {"code":"activity_not_found"}`, `403 {"code":"missing_permission"}`, `400` (πολλαπλά codes), `409 {"code":"configuration_required"}`, `422`, `500`.

---

### `DELETE /api/activities/{id}` — Delete activity
**Classification**: `ADMIN_ONLY` | **Auth**: `requireAdmin()` | **Source**: `app/api/activities/[id]/route.ts`

**Ασφαλές cascade**: `Ticket.activityId` → `SetNull`, `_ActivityAssignees` join rows → DB `CASCADE`. **Response**: `204`. **Errors**: `401`, `403`, `404`.

---

## Dependencies (Activity-to-Activity)

### `GET /api/dependencies` — List
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: raw `auth()` + `activity.view` scope | **Source**: `app/api/dependencies/route.ts`

**Query**: `activityId?` (φιλτράρει σε predecessor/successor αυτής της activity — απαιτεί `activity.view` permission σε αυτή, `404`/`403` αλλιώς). Χωρίς `activityId`: scope μέσω `buildActivityListWhere`.

**Response 200**: raw array `{id, predecessor:{id,title,status}, successor:{...}, type, createdBy:{id,name}, createdAt}`. Contract B raw shapes, **χωρίς** `lib/api-errors.ts`.

---

### `POST /api/dependencies` — Create dependency
**Classification**: `ADMIN_ONLY` | **Auth**: `isAdmin()` (raw check) | **Source**: `app/api/dependencies/route.ts`

**Body** (`createDependencySchema`): `predecessorId` (**required**), `successorId` (**required**), `type` (`DependencyType`, default `FINISH_TO_START`).

- `predecessorId === successorId` → `400 {"error":"An activity cannot depend on itself"}`.
- Και τα δύο activities πρέπει να υπάρχουν → `404`.
- **BFS cycle detection** ξεκινώντας από `successorId` — αν φτάσει στο `predecessorId`, `409 {"error":"This dependency would create a cycle"}`.

**Response 201**: πλήρες dependency object.

---

### `DELETE /api/dependencies/{id}`
**Classification**: `ADMIN_ONLY` | **Auth**: `isAdmin()` | **Source**: `app/api/dependencies/[id]/route.ts` | **Response 200**: `{success:true}`. `404 {"error":"Dependency not found"}` αλλιώς.

---

## Goals (Yearly Goals)

Ιδιοκτησία (`ownerUserId`) πάντα ο authenticated caller — καμία δυνατότητα "εκ μέρους άλλου". Κανένα department scoping — αυστηρά per-user.

### `GET /api/goals` — List own goals
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `goal.view` | **Query**: `year`, `status`. **Response 200**: raw array, πάντα `{ownerUserId: caller}`. **Source**: `app/api/goals/route.ts`

### `POST /api/goals` — Create
**Auth**: `goal.create`. **Body** (`createGoalSchema`): `year` (2020-2100, **required**), `status` (`GoalStatus`, default `NOT_STARTED`), `targetValue?`, `currentValue?`, `unit?`, `projectIds` (default `[]`). **Response 201**. **Errors**: `422 {"error":ZodIssue[]}` (raw array), `403 {"error":"Forbidden"}`, `500`.

### `GET /api/goals/{id}` — Get
**Auth**: `goal.view` + ownership check (`403` αν `ownerUserId !== caller`, **καμία** admin bypass). **Response 200**/`404`/`403`.

### `PATCH /api/goals/{id}` — Update
**Auth**: `goal.edit` + ownership. **Body**: `updateGoalSchema` (partial). **Response 200**.

### `DELETE /api/goals/{id}` — Delete
**Auth**: `goal.delete` + ownership. **Response**: `204`. **Σημείωση**: αυτό το DELETE handler's catch-all επιστρέφει `500` (όχι `401`) αν το `requireAuth()` πετάξει "Unauthorized" — ασυνέπεια σε σχέση με GET/PATCH.

---

## Users και Departments

### `GET /api/users` — List active users
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` μόνο (κανένα permission key) | **Source**: `app/api/users/route.ts`

**Query**: `assignableFor` (`ticket`\|`activity`\|`project` — αν δωμένο, επιστρέφει eligible assignees μέσω `getAssignableUsersForEntity`, ελεγμένο permission `` `${type}.assignable` ``, μπορεί να φιλτραριστεί επιπλέον με `departmentId`), `role` (`Role` enum — αγνοείται σιωπηλά αν άκυρο).

**Response 200**: raw array `{id,name,email,role,image}` (ή `AssignableUserSummary[]` για το `assignableFor` path).

---

### `GET /api/admin/users` — List all users
**Classification**: `ADMIN_ONLY` | **Auth**: `requireAdmin()` | **Source**: `app/api/admin/users/route.ts` | Πλήρες `USER_INCLUDE` (department, businessUnit, customRole, departmentMemberships+department, globalRoleMicrosoftMapping).

### `POST /api/admin/users` — Create user
**Auth**: `user.manage` (global permission). **Body** (`createUserSchema`): `name` (min 2), `email`, `password` (min 8), `role` (default `USER`), `departmentId?` (legacy), `primaryDepartmentId?`, `departmentMemberships[]` (κάθε ένα: `departmentId`, ένα από `role`/`customRoleId`), `businessUnitId?`, `isActive` (default `true`). Password hashed με `bcrypt` (cost 12). **Errors**: `409 {"error":"Email already in use"}`, `400 {"code":"duplicate_department"|"invalid_department"|"invalid_role"}`, `403 {"code":"missing_permission"}`.

### `PATCH /api/admin/users/{id}` — Update user
**Auth**: `user.manage` (global, για role/isActive/email/customRoleId) **ή** `department.user.assign` (department-scoped, **μόνο** για το primary department field). Self-edit guard: `400` αν προσπαθεί να αλλάξει το δικό του role/isActive. `409` σε email collision.

### `DELETE /api/admin/users/{id}` — Delete user
**Auth**: `requireAdmin()`. Self-delete guard: `400`. Dependents guard: `409` αν έχει tickets ως requester (**δεν** ελέγχει assigned tickets/project memberships).

---

### Departments (admin)

| Endpoint | Auth | Σκοπός |
|---|---|---|
| `GET /api/admin/departments` | `requireAdmin()` | Λίστα όλων |
| `POST /api/admin/departments` | `department.create` (global) | Δημιουργία + starter config (status/priority/activity-progress rows) σε transaction |
| `GET /api/admin/departments/{id}` | `department.manageSettings` (dept) | Λεπτομέρειες + `_count` |
| `PATCH /api/admin/departments/{id}` | `department.manageSettings` (dept) / `department.update` (global, μόνο `isActive`) | Ενημέρωση |
| `DELETE /api/admin/departments/{id}` | `department.delete` (global) | Hard delete, **μόνο αν 0 dependents** (`409` αλλιώς) |
| `PATCH /api/admin/departments/{id}/inbound-email` | `department.email.manage` (dept) | `{inboundEmail: string\|null}` |
| `GET/POST /api/admin/departments/{id}/members` | `department.manageMembers` / `department.user.assign` (dept) | Λίστα/χορήγηση membership |
| `DELETE .../members/{membershipId}` | `department.user.unassign` (dept) | **Soft**-revoke (`isActive:false`) |
| `GET/POST .../sub-departments` | `subdepartment.view`/`subdepartment.create` (dept) | Λίστα (incl. inactive)/δημιουργία |
| `PATCH/DELETE .../sub-departments/{subDeptId}` | `subdepartment.update`/`subdepartment.delete` (dept) | Ενημέρωση/hard delete (μόνο αν 0 dependents) |
| `GET/POST .../sub-departments/{subDeptId}/members` | `subdepartment.view`/`subdepartment.user.assign` (dept) | Απαιτεί ήδη ενεργό parent-department membership |
| `DELETE .../sub-departments/{subDeptId}/members/{membershipId}` | `subdepartment.user.unassign` (dept) | Soft-revoke |
| `GET /api/admin/department-roles/options` | `requireAuth()` μόνο | Built-in + custom department role options |

Πλήρες error-code detail ανά route: [ERROR_CODES.md](./ERROR_CODES.md).

### Departments (non-admin, περιορισμένο auth)

| Endpoint | Auth | Διαφορά από το admin equivalent |
|---|---|---|
| `GET /api/departments/{id}/hierarchy` | `requireAuth()` + **οποιαδήποτε** ενεργή membership σε αυτό το department (ή Admin/Director) — **κανένα συγκεκριμένο permission key** | Member hierarchy view (tiers) |
| `GET /api/departments/{id}/sub-departments` | `requireAuth()` **μόνο**, καμία membership | Επιστρέφει μόνο **ενεργά** sub-departments (το admin GET επιστρέφει και inactive) |
| `GET /api/departments/{id}/activity-statuses` | `requireAuth()` **μόνο** | Μόνο **ενεργά** (`isEnabled:true`) activity statuses, raw array |

---

## Department Configuration (7 admin config domains)

Όλα ακολουθούν το ίδιο μοτίβο: `GET` χωρίς `departmentId` = System-Admin-only global view· με `departmentId` = department-scoped (System Admin ή holder του αντίστοιχου permission). Write operations πάντα department-scoped permission (εκτός global cancel reasons/SLA toggle, System-Admin-only).

| Domain | Endpoint | Permission keys | Department required στο create; |
|---|---|---|---|
| Ticket Statuses | `GET/POST/PATCH/DELETE /api/admin/statuses` | `status.create/edit/delete` | Ναι (`department_required`) |
| Ticket Categories | `GET/POST/PATCH/DELETE /api/admin/categories` | `category.manage`/`department.manageSettings` (+`category.delete`) | Ναι |
| Ticket Priorities | `GET/POST/PATCH/DELETE /api/admin/priorities` | `priority.create/edit/delete` | Ναι |
| Cancel Reasons | `GET/POST/PATCH/DELETE /api/admin/cancel-reasons` | `cancelReason.create/edit/delete` | **Όχι** — `null`=global (System-Admin-only δημιουργία) |
| SLA | `GET/PUT /api/admin/sla` | `sla.create/edit/delete` | Ναι για dept-scoped PUT· global `isEnabled` toggle = `requireAdmin()` |
| Activity Progress | `GET/POST/PUT/DELETE /api/admin/activity-progress` | `activityProgress.create/edit/delete` | Ναι |
| Activity Statuses (label/color/terminal) | `GET/POST/PATCH/DELETE /api/admin/activity-statuses` | `activityProgress.create/edit/delete` (ίδια keys, σκόπιμα) | Ναι |

**Error contract**: αυτά τα 7 domains είναι τα **μόνα** routes σε ολόκληρο το API που χρησιμοποιούν το structured Contract A (`lib/api-errors.ts` — `{code, error, message, field?, fieldErrors?}`). Κάθε write επιβεβαιώνει server-side ότι το target row/config ανήκει πραγματικά στο δηλωμένο department πριν προχωρήσει (`cross_department_denied` για SLA, `department_required`/`invalid_department` για τα υπόλοιπα). "In-use" guards (`item_in_use`, 409) αποτρέπουν διαγραφή/απενεργοποίηση configuration που ήδη χρησιμοποιείται από πραγματικά tickets/activities. Πλήρες field-level detail: [ERROR_CODES.md](./ERROR_CODES.md).

---

## Microsoft Integration (admin-only, `requireAdmin()` σε όλα)

| Endpoint | Σκοπός |
|---|---|
| `GET/POST /api/admin/microsoft-mappings` | Λίστα/δημιουργία mapping (Microsoft dept/job-title/group/app-role → local Role+DepartmentRole). Απαγορεύει ρητά χορήγηση Administrator/Department Admin μέσω mapping (`role_not_allowed`). |
| `PATCH/DELETE /api/admin/microsoft-mappings/{id}` | Ενημέρωση/διαγραφή mapping |
| `GET /api/admin/microsoft-directory/values` | Cached Microsoft directory dept/job-title values + `ready` flags (env vars configured) |
| `POST /api/admin/microsoft-directory/values/sync` | Live sync από Graph (`GET /users`, paginated έως 200 σελίδες) — **502** με ασφαλές mapped μήνυμα σε αποτυχία (rate-limited/no-permission/κ.λπ.) |
| `POST /api/admin/email/poll` | Χειροκίνητο "Poll Now" — καλεί το ίδιο `processInboundEmails()` με το webhook |
| `POST /api/admin/email/test-connection` | Έλεγχος Graph token + mailbox — πάντα `200`, ακόμη κι αν `tokenOk`/`mailboxOk` false |
| `POST /api/admin/email/test-ticket` | Δημιουργεί συνθετικό `PendingTicket` για δοκιμή |

**Roles administration** (`requireAuth()` + `canManageAnyRoles`/`canManageRoleScope`, **όχι** `requireAdmin()` literal): `GET/POST /api/admin/roles`, `PATCH/DELETE /api/admin/roles/{id}`, `POST/DELETE /api/admin/roles/{id}/permissions/{permId}`. Guardrails: built-in roles δεν διαγράφονται (`builtin_role_locked`), critical permissions (`admin.access`/`role.manage`/`user.manage`) δεν αφαιρούνται αν θα άφηναν μηδενικό μονοπάτι πρόσβασης (`cannot_remove_last_admin`), department-scoped roles δεν μπορούν ποτέ να αποκτήσουν αυτά τα 3 global permissions (`invalid_permission_scope`).

---

## Email Ingestion

### `GET/POST /api/email/inbound`
**Classification**: `WEBHOOK` | **Auth**: `Authorization: Bearer <EMAIL_WEBHOOK_SECRET ή CRON_SECRET>` — **fail-open αν λείπουν και τα δύο** (βλ. [AUTHENTICATION.md](./AUTHENTICATION.md) §4) | **Source**: `app/api/email/inbound/route.ts`

Δεν διαβάζει request body — αντλεί emails απευθείας από Microsoft Graph. **Response 200**: `{success:true, created, appended, skipped, errors, runId, message}`. **401** αν λείπει/λάθος token (όταν secrets configured).

---

## Notifications

| Endpoint | Auth | Σκοπός |
|---|---|---|
| `GET /api/notifications` | `requireAuth()` | Τελευταίες 50 own notifications + `unreadCount` (προσεγγιστικό, από τις 50) |
| `PATCH /api/notifications/{id}/read` | `requireAuth()` + ownership (masked ως `404`) | Mark read |
| `POST /api/notifications/mark-all-read` | `requireAuth()` | Mark όλα read |
| `POST /api/notifications/push/subscribe` | `requireAuth()` | Body `{endpoint,p256dh,auth}`, `endpoint` globally unique — re-subscribe reassigns ownership χωρίς έλεγχο προηγούμενου owner |
| `POST /api/notifications/push/unsubscribe` | `requireAuth()` | Body `{endpoint}`, scoped στον caller |

---

## Dashboard

### `GET /api/dashboard`
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + `buildTicketListWhere` scope | **Source**: `app/api/dashboard/route.ts`

**⚠️ Μόνο Ticket-scoped** — παρά το όνομα, ΔΕΝ συγκεντρώνει projects/activities/goals. **Response 200**: `{stats:{totalOpen,totalInProgress,totalResolved,totalClosed,assignedToMe}, byStatus:[...], byPriority:[...], recentTickets:[...8], recentActivity:[...10]}`. Δεν υπάρχει ξεχωριστό Projects Dashboard/Gantt/Resource-Planning API — αυτά τα features είναι αποκλειστικά server-rendered (Server Components), όχι JSON endpoints.

---

## Workspace

### `POST /api/workspace/active` — Set active department cookie
**Classification**: `INTERNAL_SESSION_ONLY` | **Auth**: `requireAuth()` + membership validation | **Source**: `app/api/workspace/active/route.ts`

**Body**: `{departmentId: string}` (ή ειδική τιμή "All Workspaces", μόνο για Admin/Director). Επικυρώνει πραγματική membership (ή ενεργό department για Admin/Director) πριν γράψει το cookie — ποτέ τυφλή αποδοχή. **Cookie**: `active_department_id`, httpOnly, `sameSite:lax`, `secure` σε production, `maxAge` 1 έτος. **Response 200**: `{departmentId}`.
