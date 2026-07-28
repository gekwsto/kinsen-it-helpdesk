# TicketApp API — Endpoint Inventory

*Συνοπτικός πίνακας όλων των 109 πραγματικών HTTP method handlers, σε 61 `route.ts` αρχεία, κάτω από `app/api/**`. Classification βάσει `EXTERNAL_API_READINESS.md`'s κλειδιά. Λεπτομερές contract κάθε endpoint: [API_REFERENCE.md](./API_REFERENCE.md).*

| Method | Path | Purpose | Authentication | Permission | Classification | Source file |
|---|---|---|---|---|---|---|
| GET | `/api/activities` | List activities | Session | `requireAuth()` only + `buildActivityListWhere` scope | INTERNAL_SESSION_ONLY | `app/api/activities/route.ts` |
| POST | `/api/activities` | Create activity | Session | `activity.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/activities/route.ts` |
| GET | `/api/activities/{id}` | Get activity | Session | `activity.view` (department-scoped, `canActOnEntity`) | INTERNAL_SESSION_ONLY | `app/api/activities/[id]/route.ts` |
| PATCH | `/api/activities/{id}` | Update activity | Session | `activity.edit` | INTERNAL_SESSION_ONLY | `app/api/activities/[id]/route.ts` |
| DELETE | `/api/activities/{id}` | Delete activity | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/activities/[id]/route.ts` |
| GET | `/api/admin/activity-progress` | Read Activity Progress config | Session | `activityProgress.{create,edit,delete}` (department-scoped, any) | INTERNAL_SESSION_ONLY | `app/api/admin/activity-progress/route.ts` |
| POST | `/api/admin/activity-progress` | Create Activity Progress row | Session | `activityProgress.create` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-progress/route.ts` |
| PUT | `/api/admin/activity-progress` | Bulk update Activity Progress rows | Session | `activityProgress.edit` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-progress/route.ts` |
| DELETE | `/api/admin/activity-progress` | Delete Activity Progress row | Session | `activityProgress.delete` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-progress/route.ts` |
| GET | `/api/admin/activity-statuses` | Read Activity Status config | Session | `activityProgress.{create,edit,delete}` (reused keys, any) | INTERNAL_SESSION_ONLY | `app/api/admin/activity-statuses/route.ts` |
| POST | `/api/admin/activity-statuses` | Create Activity Status row | Session | `activityProgress.create` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-statuses/route.ts` |
| PATCH | `/api/admin/activity-statuses` | Bulk update Activity Status rows | Session | `activityProgress.edit` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-statuses/route.ts` |
| DELETE | `/api/admin/activity-statuses` | Delete Activity Status row | Session | `activityProgress.delete` | INTERNAL_SESSION_ONLY | `app/api/admin/activity-statuses/route.ts` |
| GET | `/api/admin/cancel-reasons` | List cancel reasons | Session | `requireAdmin()` (global) or `department.manageSettings`-equivalent (dept) | INTERNAL_SESSION_ONLY | `app/api/admin/cancel-reasons/route.ts` |
| POST | `/api/admin/cancel-reasons` | Create cancel reason | Session | Admin (global) / department-scoped create permission | INTERNAL_SESSION_ONLY | `app/api/admin/cancel-reasons/route.ts` |
| PATCH | `/api/admin/cancel-reasons` | Update cancel reason | Session | ίδιο μοτίβο | INTERNAL_SESSION_ONLY | `app/api/admin/cancel-reasons/route.ts` |
| DELETE | `/api/admin/cancel-reasons` | Delete cancel reason | Session | ίδιο μοτίβο | INTERNAL_SESSION_ONLY | `app/api/admin/cancel-reasons/route.ts` |
| GET | `/api/admin/categories` | List ticket categories | Session | `requireAdmin()` (global) ή department-scoped | INTERNAL_SESSION_ONLY | `app/api/admin/categories/route.ts` |
| POST | `/api/admin/categories` | Create category | Session | `category.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/categories/route.ts` |
| PATCH | `/api/admin/categories` | Update category | Session | `category.edit` | INTERNAL_SESSION_ONLY | `app/api/admin/categories/route.ts` |
| DELETE | `/api/admin/categories` | Delete category | Session | `category.delete` | INTERNAL_SESSION_ONLY | `app/api/admin/categories/route.ts` |
| GET | `/api/admin/department-roles/options` | List available department role options | Session | `requireAuth()` μόνο | INTERNAL_SESSION_ONLY | `app/api/admin/department-roles/options/route.ts` |
| PATCH | `/api/admin/departments/{id}/inbound-email` | Set/clear department inbound email | Session | `department.email.manage` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/inbound-email/route.ts` |
| DELETE | `/api/admin/departments/{id}/members/{membershipId}` | Revoke department membership | Session | `department.user.unassign` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/members/[membershipId]/route.ts` |
| GET | `/api/admin/departments/{id}/members` | List department memberships (incl. inactive) | Session | `department.manageMembers` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/members/route.ts` |
| POST | `/api/admin/departments/{id}/members` | Grant department membership | Session | `department.user.assign` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/members/route.ts` |
| GET | `/api/admin/departments/{id}` | Get department (admin view) | Session | `department.manageSettings` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/route.ts` |
| PATCH | `/api/admin/departments/{id}` | Update department | Session | `department.manageSettings` / `department.update` (global, μόνο για `isActive`) | INTERNAL_SESSION_ONLY | `app/api/admin/departments/[id]/route.ts` |
| DELETE | `/api/admin/departments/{id}` | Delete department (μόνο αν 0 dependents) | Session | `department.delete` (global) | ADMIN_ONLY | `app/api/admin/departments/[id]/route.ts` |
| DELETE | `/api/admin/departments/{id}/sub-departments/{subDeptId}/members/{membershipId}` | Revoke sub-department membership | Session | `subdepartment.user.unassign` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/[subDeptId]/members/[membershipId]/route.ts` |
| GET | `/api/admin/departments/{id}/sub-departments/{subDeptId}/members` | List sub-department memberships | Session | `subdepartment.view` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/[subDeptId]/members/route.ts` |
| POST | `/api/admin/departments/{id}/sub-departments/{subDeptId}/members` | Grant sub-department membership | Session | `subdepartment.user.assign` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/[subDeptId]/members/route.ts` |
| PATCH | `/api/admin/departments/{id}/sub-departments/{subDeptId}` | Update sub-department | Session | `subdepartment.update` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/[subDeptId]/route.ts` |
| DELETE | `/api/admin/departments/{id}/sub-departments/{subDeptId}` | Delete sub-department (μόνο αν 0 dependents) | Session | `subdepartment.delete` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/[subDeptId]/route.ts` |
| GET | `/api/admin/departments/{id}/sub-departments` | List sub-departments (incl. inactive) | Session | `subdepartment.view` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/route.ts` |
| POST | `/api/admin/departments/{id}/sub-departments` | Create sub-department | Session | `subdepartment.create` (department-scoped) | INTERNAL_SESSION_ONLY | `.../sub-departments/route.ts` |
| GET | `/api/admin/departments` | List all departments | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/departments/route.ts` |
| POST | `/api/admin/departments` | Create department | Session | `department.create` (global permission) | ADMIN_ONLY | `app/api/admin/departments/route.ts` |
| POST | `/api/admin/email/poll` | Trigger email polling ("Poll Now") | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/email/poll/route.ts` |
| POST | `/api/admin/email/test-connection` | Test Microsoft Graph mailbox connection | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/email/test-connection/route.ts` |
| POST | `/api/admin/email/test-ticket` | Create a synthetic test pending ticket | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/email/test-ticket/route.ts` |
| GET | `/api/admin/microsoft-directory/values` | Read cached Microsoft directory dept/job-title values | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-directory/values/route.ts` |
| POST | `/api/admin/microsoft-directory/values/sync` | Sync directory values from Graph | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-directory/values/sync/route.ts` |
| PATCH | `/api/admin/microsoft-mappings/{id}` | Update Microsoft mapping | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-mappings/[id]/route.ts` |
| DELETE | `/api/admin/microsoft-mappings/{id}` | Delete Microsoft mapping | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-mappings/[id]/route.ts` |
| GET | `/api/admin/microsoft-mappings` | List Microsoft mappings | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-mappings/route.ts` |
| POST | `/api/admin/microsoft-mappings` | Create Microsoft mapping | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/microsoft-mappings/route.ts` |
| GET | `/api/admin/priorities` | List ticket priorities | Session | `requireAdmin()` (global) ή department-scoped | INTERNAL_SESSION_ONLY | `app/api/admin/priorities/route.ts` |
| POST | `/api/admin/priorities` | Create priority | Session | `priority.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/priorities/route.ts` |
| PATCH | `/api/admin/priorities` | Update priority | Session | `priority.edit` | INTERNAL_SESSION_ONLY | `app/api/admin/priorities/route.ts` |
| DELETE | `/api/admin/priorities` | Delete priority | Session | `priority.delete` | INTERNAL_SESSION_ONLY | `app/api/admin/priorities/route.ts` |
| POST | `/api/admin/roles/{id}/permissions/{permId}` | Grant permission to role | Session | `canManageRoleScope(..., "update")` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/[id]/permissions/[permId]/route.ts` |
| DELETE | `/api/admin/roles/{id}/permissions/{permId}` | Revoke permission from role | Session | `canManageRoleScope(..., "update")` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/[id]/permissions/[permId]/route.ts` |
| PATCH | `/api/admin/roles/{id}` | Update custom role | Session | `canManageRoleScope(..., "update")` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/[id]/route.ts` |
| DELETE | `/api/admin/roles/{id}` | Delete custom role | Session | `canManageRoleScope(..., "delete")` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/[id]/route.ts` |
| GET | `/api/admin/roles` | List roles/permissions/rolePermissions | Session | `canManageAnyRoles()` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/route.ts` |
| POST | `/api/admin/roles` | Create custom role | Session | `canManageRoleScope(..., "create")` | INTERNAL_SESSION_ONLY | `app/api/admin/roles/route.ts` |
| GET | `/api/admin/sla` | Read SLA config + priorities | Session | `sla.{create,edit,delete}` (dept, any) ή `requireAdmin()` (global) | INTERNAL_SESSION_ONLY | `app/api/admin/sla/route.ts` |
| PUT | `/api/admin/sla` | Reset/bulk-save SLA hours, ή toggle global SLA feature | Session | `sla.edit` (dept) ή `requireAdmin()` (global toggle) | INTERNAL_SESSION_ONLY | `app/api/admin/sla/route.ts` |
| GET | `/api/admin/statuses` | List ticket statuses | Session | `requireAdmin()` (global) ή department-scoped | INTERNAL_SESSION_ONLY | `app/api/admin/statuses/route.ts` |
| POST | `/api/admin/statuses` | Create status | Session | `status.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/admin/statuses/route.ts` |
| PATCH | `/api/admin/statuses` | Update status | Session | `status.edit` | INTERNAL_SESSION_ONLY | `app/api/admin/statuses/route.ts` |
| DELETE | `/api/admin/statuses` | Delete status | Session | `status.delete` | INTERNAL_SESSION_ONLY | `app/api/admin/statuses/route.ts` |
| PATCH | `/api/admin/users/{id}` | Update user (role/department/active/email) | Session | `user.manage` (global) ή `department.user.assign` (dept-scoped, μόνο για department field) | ADMIN_ONLY | `app/api/admin/users/[id]/route.ts` |
| DELETE | `/api/admin/users/{id}` | Delete user | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/users/[id]/route.ts` |
| GET | `/api/admin/users` | List all users | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/admin/users/route.ts` |
| POST | `/api/admin/users` | Create user | Session | `user.manage` (global) | ADMIN_ONLY | `app/api/admin/users/route.ts` |
| GET | `/api/auth/{nextauth}` | Auth.js catch-all (OAuth redirects, callback, session, csrf, providers) | — (self) | — | AUTH_INTERNAL | `app/api/auth/[...nextauth]/route.ts` |
| POST | `/api/auth/{nextauth}` | Auth.js catch-all (sign-in/out, callback) | — (self) | — | AUTH_INTERNAL | `app/api/auth/[...nextauth]/route.ts` |
| GET | `/api/dashboard` | Ticket dashboard aggregates | Session | `requireAuth()` + `buildTicketListWhere` scope | INTERNAL_SESSION_ONLY | `app/api/dashboard/route.ts` |
| GET | `/api/departments/{id}/activity-statuses` | List ENABLED activity statuses for a department | Session | `requireAuth()` μόνο | INTERNAL_SESSION_ONLY | `app/api/departments/[id]/activity-statuses/route.ts` |
| GET | `/api/departments/{id}/hierarchy` | Department member hierarchy view | Session | `requireAuth()` + membership-in-that-department (ή Admin/Director) | INTERNAL_SESSION_ONLY | `app/api/departments/[id]/hierarchy/route.ts` |
| GET | `/api/departments/{id}/sub-departments` | List ACTIVE sub-departments | Session | `requireAuth()` μόνο | INTERNAL_SESSION_ONLY | `app/api/departments/[id]/sub-departments/route.ts` |
| DELETE | `/api/dependencies/{id}` | Delete activity dependency | Session | `requireAdmin()` (raw `isAdmin()` check) | ADMIN_ONLY | `app/api/dependencies/[id]/route.ts` |
| GET | `/api/dependencies` | List activity dependencies | Session | `requireAuth()` + `activity.view` scope | INTERNAL_SESSION_ONLY | `app/api/dependencies/route.ts` |
| POST | `/api/dependencies` | Create activity dependency (με cycle detection) | Session | `requireAdmin()` (raw `isAdmin()` check) | ADMIN_ONLY | `app/api/dependencies/route.ts` |
| GET/POST | `/api/email/inbound` | Trigger email polling (webhook/cron) | Bearer shared secret (ή none αν λείπουν secrets) | — | WEBHOOK | `app/api/email/inbound/route.ts` |
| GET | `/api/goals/{id}` | Get yearly goal | Session | `goal.view` + ownership (`ownerUserId === caller`) | INTERNAL_SESSION_ONLY | `app/api/goals/[id]/route.ts` |
| PATCH | `/api/goals/{id}` | Update yearly goal | Session | `goal.edit` + ownership | INTERNAL_SESSION_ONLY | `app/api/goals/[id]/route.ts` |
| DELETE | `/api/goals/{id}` | Delete yearly goal | Session | `goal.delete` + ownership | INTERNAL_SESSION_ONLY | `app/api/goals/[id]/route.ts` |
| GET | `/api/goals` | List own yearly goals | Session | `goal.view` | INTERNAL_SESSION_ONLY | `app/api/goals/route.ts` |
| POST | `/api/goals` | Create yearly goal | Session | `goal.create` | INTERNAL_SESSION_ONLY | `app/api/goals/route.ts` |
| PATCH | `/api/notifications/{id}/read` | Mark one notification read | Session | `requireAuth()` + ownership (masked as 404) | INTERNAL_SESSION_ONLY | `app/api/notifications/[id]/read/route.ts` |
| POST | `/api/notifications/mark-all-read` | Mark all own notifications read | Session | `requireAuth()` | INTERNAL_SESSION_ONLY | `app/api/notifications/mark-all-read/route.ts` |
| POST | `/api/notifications/push/subscribe` | Register web-push subscription | Session | `requireAuth()` | INTERNAL_SESSION_ONLY | `app/api/notifications/push/subscribe/route.ts` |
| POST | `/api/notifications/push/unsubscribe` | Remove web-push subscription | Session | `requireAuth()` | INTERNAL_SESSION_ONLY | `app/api/notifications/push/unsubscribe/route.ts` |
| GET | `/api/notifications` | List own notifications (τελευταίες 50) | Session | `requireAuth()` | INTERNAL_SESSION_ONLY | `app/api/notifications/route.ts` |
| GET | `/api/projects/{id}` | Get project | Session | `project.view` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/projects/[id]/route.ts` |
| PATCH | `/api/projects/{id}` | Update project | Session | `project.edit` | INTERNAL_SESSION_ONLY | `app/api/projects/[id]/route.ts` |
| DELETE | `/api/projects/{id}` | Delete project (safe cascade) | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/projects/[id]/route.ts` |
| GET | `/api/projects` | List projects | Session | `requireAuth()` + `buildProjectListWhere` scope | INTERNAL_SESSION_ONLY | `app/api/projects/route.ts` |
| POST | `/api/projects` | Create project | Session | `project.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/projects/route.ts` |
| PATCH | `/api/tickets/{id}/assign` | Assign/unassign agent | Session | `ticket.assign` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/assign/route.ts` |
| POST | `/api/tickets/{id}/attachments` | Upload attachment | Session | `canViewAllTickets()` ή requester | NOT_SAFE_FOR_EXTERNAL_USE | `app/api/tickets/[id]/attachments/route.ts` |
| POST | `/api/tickets/{id}/cancel` | Cancel ticket | Session | Admin ή requester | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/cancel/route.ts` |
| PATCH | `/api/tickets/{id}/department` | Move ticket to another department/sub-department | Session | `ticket.department.change` (owner δεν κάνει bypass) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/department/route.ts` |
| POST | `/api/tickets/{id}/reply` | Add comment/reply/internal note | Session | `ticket.reply` ή requester (`ticket.internalNote` για internal notes) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/reply/route.ts` |
| GET | `/api/tickets/{id}` | Get ticket | Session | `canViewTicket()` (department scope, ownership, sharing) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/route.ts` |
| PATCH | `/api/tickets/{id}` | Update ticket | Session | `ticket.changeStatus` (owner bypass) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/route.ts` |
| DELETE | `/api/tickets/{id}` | Delete ticket (hard delete + files) | Session | `requireAdmin()` | ADMIN_ONLY | `app/api/tickets/[id]/route.ts` |
| PATCH | `/api/tickets/{id}/status` | Change ticket status | Session | `ticket.changeStatus` (owner bypass) | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/status/route.ts` |
| GET | `/api/tickets/{id}/stream` | Real-time SSE ticket event stream | Session | `canViewAllTickets()` ή requester | INTERNAL_SESSION_ONLY | `app/api/tickets/[id]/stream/route.ts` |
| POST | `/api/tickets/pending/{id}/accept` | Accept pending (email) ticket → real Ticket | Session | `ticket.pending.accept` (dept-scoped ή global) | INTERNAL_SESSION_ONLY | `app/api/tickets/pending/[id]/accept/route.ts` |
| POST | `/api/tickets/pending/{id}/reject` | Reject pending ticket | Session | `ticket.pending.reject` (dept-scoped ή global) | INTERNAL_SESSION_ONLY | `app/api/tickets/pending/[id]/reject/route.ts` |
| GET | `/api/tickets` | List/search/filter tickets | Session | `ticket.view` + `buildTicketListWhere` scope | INTERNAL_SESSION_ONLY | `app/api/tickets/route.ts` |
| POST | `/api/tickets` | Create ticket | Session | `ticket.create` (department-scoped) | INTERNAL_SESSION_ONLY | `app/api/tickets/route.ts` |
| GET | `/api/users` | List active users (ή eligible assignees) | Session | `requireAuth()` μόνο | INTERNAL_SESSION_ONLY | `app/api/users/route.ts` |
| POST | `/api/workspace/active` | Set active workspace/department cookie | Session | `requireAuth()` + membership validation | INTERNAL_SESSION_ONLY | `app/api/workspace/active/route.ts` |

**Σύνολα**: 61 route files, **109** HTTP method handlers.

| Classification | Πλήθος |
|---|---|
| `INTERNAL_SESSION_ONLY` | 85 |
| `ADMIN_ONLY` | 19 |
| `AUTH_INTERNAL` (Auth.js catch-all) | 2 |
| `WEBHOOK` | 2 (GET+POST στο ίδιο path) |
| `NOT_SAFE_FOR_EXTERNAL_USE` | 1 (attachment upload — βλ. [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md)) |
| `PUBLIC` / `CRON_ONLY` / `EXTERNAL_READY` | 0 — δεν υπάρχει κανένα endpoint με αυτές τις classifications σήμερα |

Επεξήγηση κάθε classification και πλήρες σκεπτικό: [EXTERNAL_API_READINESS.md](./EXTERNAL_API_READINESS.md).
