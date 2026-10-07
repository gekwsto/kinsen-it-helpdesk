import { z } from "zod";
import {
  MessageDirection,
  ProjectStatus,
  ActivityStatus,
  ActivityPriority,
  GoalStatus,
  Role,
  DependencyType,
  DepartmentRole,
  MicrosoftMappingSourceType,
} from "@prisma/client";

// ─── Ticket Schemas ────────────────────────────────────────────────────────────

export const createTicketSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters").max(200),
  description: z.string().min(10, "Description must be at least 10 characters"),
  categoryId: z.string().optional(),
  priorityId: z.string().optional(),
  departmentId: z.string().optional(),
  subDepartmentId: z.string().optional(),
  projectId: z.string().optional(),
  activityId: z.string().optional(),
  // Ticket-only sharing — the requester creating this ticket is always
  // allowed to set these on their own ticket (owner bypass), see
  // POST /api/tickets.
  shareWithDepartment: z.boolean().default(false),
  shareWithSubDepartment: z.boolean().default(false),
});

// POST /api/integrations/tickets — the server-to-server ticket-creation
// contract for external applications (see lib/services/integration-key-
// service.ts and lib/services/ticket-creation-service.ts). Deliberately
// `.strict()`: an unknown field (e.g. a caller trying to sneak in
// `departmentId`/`requesterId`/`statusId`) is a hard validation error
// rather than being silently dropped, so a misbehaving integration caller
// finds out immediately rather than assuming a field it sent was honored.
export const MAX_INTEGRATION_METADATA_BYTES = 10 * 1024;

export const createIntegrationTicketSchema = z
  .object({
    externalReferenceId: z.string().trim().min(1, "externalReferenceId is required").max(200),
    requesterEmail: z.string().trim().email("requesterEmail must be a valid email address").max(320),
    requesterName: z.string().trim().min(1).max(200).optional(),
    // Same lower bound as createTicketSchema above. The upper bound is new
    // here (createTicketSchema has none) — a human typing in the WEB form
    // self-limits in practice, but an external API caller doesn't, so this
    // endpoint bounds it explicitly rather than inheriting an unbounded field.
    title: z.string().min(5, "Title must be at least 5 characters").max(200),
    description: z.string().min(10, "Description must be at least 10 characters").max(50000, "Description must not exceed 50,000 characters"),
    // Real WHATWG URL parsing (new URL()), not a regex — rejects malformed
    // hosts/ports the same way the browser's own URL parser would, and
    // normalizes IDN hosts to punycode automatically. Beyond "is this a
    // valid URL", three explicit checks: only http/https (no javascript:,
    // data:, file:, etc.), no embedded credentials (https://user:pass@host
    // is rejected outright — never silently stripped), and a max length
    // matching the DB column's practical bound. sourceUrl is never fetched
    // server-side (it's only stored and later rendered as a clickable
    // target="_blank" link — see ticket-detail-client.tsx), so this
    // endpoint introduces no SSRF surface regardless of what host it
    // points to; localhost/private-network URLs are therefore deliberately
    // NOT blocked here (a self-hosted calling app on an internal address
    // is a legitimate case, and there is nothing server-side that would
    // ever dereference the URL). The URL's fragment (#...), if present, is
    // kept as-is as part of the stored string — it's meaningful only to
    // whatever the admin's own browser does when they click the link,
    // never parsed or acted on server-side.
    sourceUrl: z
      .string()
      .trim()
      .max(2000)
      .superRefine((value, ctx) => {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceUrl must be a valid URL" });
          return;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceUrl must use http or https" });
        }
        if (parsed.username || parsed.password) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceUrl must not contain embedded credentials" });
        }
      })
      .optional(),
    categoryId: z.string().min(1).optional(),
    priorityId: z.string().min(1).optional(),
    subDepartmentId: z.string().min(1).optional(),
    // A plain JSON object (z.record already rejects arrays/primitives —
    // they have a different "parsed type" than "object" in Zod), capped at
    // ~10KB serialized so one caller's arbitrary metadata blob can never
    // become a storage/row-size problem.
    metadata: z
      .record(z.unknown())
      .optional()
      .refine(
        (value) => !value || Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_INTEGRATION_METADATA_BYTES,
        { message: `metadata must not exceed ${MAX_INTEGRATION_METADATA_BYTES} bytes when serialized` }
      ),
  })
  .strict();

export type CreateIntegrationTicketInput = z.infer<typeof createIntegrationTicketSchema>;

// departmentId/subDepartmentId are deliberately NOT here — moving a ticket's
// department/sub-department goes through the dedicated, audited
// PATCH /api/tickets/[id]/department route (changeTicketDepartmentSchema
// below) instead, gated by ticket.department.change rather than whatever
// permission this generic update happens to be gated by.
export const updateTicketSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  description: z.string().min(10).optional(),
  categoryId: z.string().nullable().optional(),
  priorityId: z.string().nullable().optional(),
  statusId: z.string().optional(),
  assignedAgentId: z.string().nullable().optional(),
  cancelReasonId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  activityId: z.string().nullable().optional(),
  shareWithDepartment: z.boolean().optional(),
  shareWithSubDepartment: z.boolean().optional(),
});

// PATCH /api/tickets/[id]/department body — the one audited path for moving
// a ticket's department/sub-department (see decision #1 in the plan).
export const changeTicketDepartmentSchema = z.object({
  departmentId: z.string().min(1, "Department is required"),
  subDepartmentId: z.string().nullable().optional(),
});

export const replyTicketSchema = z.object({
  body: z.string().min(1, "Reply cannot be empty"),
  direction: z.nativeEnum(MessageDirection).default(MessageDirection.OUTBOUND),
  isInternal: z.boolean().default(false),
  // Candidate @mention user ids from the composer — NEVER trusted as-is;
  // only meaningful for an internal note (isInternal: true — see
  // app/api/tickets/[id]/reply/route.ts) and re-validated there against
  // lib/services/mention-service.ts's canonical ticket-view eligibility
  // check before anything is persisted or notified.
  mentionUserIds: z.array(z.string()).max(50).default([]),
});

export const assignTicketSchema = z.object({
  assignedAgentId: z.string().nullable(),
});

export const changeStatusSchema = z.object({
  statusId: z.string(),
  cancelReasonId: z.string().optional(),
});

// ─── Project Schemas ───────────────────────────────────────────────────────────

export const createProjectSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().optional(),
  status: z.nativeEnum(ProjectStatus).default(ProjectStatus.PLANNING),
  priority: z.number().int().min(1).max(3).default(2),
  departmentId: z.string().optional(),
  subDepartmentId: z.string().nullable().optional(),
  businessUnitId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  successTarget: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
  isGoal: z.boolean().default(false),
});

export const updateProjectSchema = createProjectSchema.partial();

// POST /api/projects ONLY — deliberately never merged into
// createProjectSchema/updateProjectSchema itself (so PATCH /api/projects/[id]
// never accepts or has to strip this field; see that route's own `rest`
// spread straight into prisma.project.update, which has no matching
// column). Selects which Member-eligibility RULE this request enforces —
// never which users are actually accepted; every id is independently
// re-validated against whichever rule applies, same as always.
// "assignable" (the default — every pre-existing caller, in particular
// inline/ticket-linking Project creation, keeps sending this implicitly by
// simply omitting the field) preserves the historical `project.assignable`
// permission check untouched. "workspaceMembership" is sent ONLY by the
// standalone manual-creation form (components/projects/project-form.tsx),
// whose Members picker is itself now Workspace-DepartmentMembership-based
// (see GET /api/departments/[id]/members) — this keeps write-time
// validation honest with what that UI actually offered, without touching
// the semantics any other caller relies on.
export const createProjectMemberEligibilitySchema = z.object({
  memberEligibilitySource: z.enum(["assignable", "workspaceMembership"]).optional().default("assignable"),
});

// A plain number from the client — never trusted as-is for currency storage
// without re-validating precision here: non-negative, at most 2 decimal
// places (the refine check tolerates tiny floating-point representation
// error, e.g. 19.99 * 100 landing at 1998.9999999999998, rather than
// requiring exact binary equality), and capped well above any realistic
// amount (matches Decimal(10,2)'s own storage ceiling). Reused as-is (not
// duplicated) for Activity Task Type cost below — kept as its own factory
// (not a shared const) so every caller gets its own field-specific error
// messages.
function moneyAmountSchema(label: string) {
  return z
    .number({ invalid_type_error: `${label} must be a number` })
    .finite(`${label} must be a finite number`)
    .nonnegative(`${label} cannot be negative`)
    .max(99999999.99, `${label} is too large`)
    .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, `${label} supports at most 2 decimal places`);
}

// The request-origin Project creation payload — POST
// /api/project-requests/[id]/project only (see
// createProjectFromApprovedRequest in lib/services/project-request-service.ts).
// Deliberately a SEPARATE schema from createProjectSchema, never merged
// into it: createProjectSchema must stay exactly as it is so normal/manual
// Project creation never requires (or even accepts) any of these fields —
// see this feature's own "UI visibility rule" and "malicious caller can't
// forge provenance into the generic create API" requirements.
//
// departmentId is deliberately OMITTED (not just optional) — the
// department is always the Project Request's own, authoritative and
// server-resolved, never a client choice in this flow.
export const createProjectFromRequestSchema = createProjectSchema
  .omit({ departmentId: true })
  .extend({
    // The approver's own explicit choice of who should own the new
    // Project — one or more, re-verified server-side (every id must be a
    // real, active user — system-wide, NEVER Department-scoped, see
    // resolveSystemWideActiveUserIds in project-request-service.ts)
    // regardless of what the client sent. ownerIds[0] becomes the
    // canonical Project.ownerId; the full array becomes Project.owners.
    ownerIds: z.array(z.string().trim().min(1)).min(1, "Select at least one Owner."),
    // Optional — zero or more users who may follow this Project's progress
    // without being a Member or an Owner. Same system-wide (never
    // Department-scoped) re-verification as ownerIds above.
    audienceIds: z.array(z.string().trim().min(1)).default([]),
    expectedStartDate: z.string().min(1, "Expected Start Date is required."),
    expectedFinishDate: z.string().min(1, "Expected Finish Date is required."),
    // Server-computed only — expectedTotalInitialDays is deliberately NOT a
    // field on this schema at all, so a client-submitted value (forged or
    // not) is simply never read; see createProjectFromApprovedRequest's own
    // doc comment for the authoritative calculation.
    expenseTypeId: z.string().trim().min(1, "Select an Expense Type."),
    // Budget was REMOVED entirely (no replacement) — see
    // prisma/migrations/20261005090000_remove_project_budget_and_cost_columns.
    // Estimated Cost / Actual Cost are no longer client-submitted at all,
    // at creation or edit — both are now fully derived from the Project's
    // own Activities (lib/services/project-financials-service.ts), so
    // neither is a field on this schema any more.
    external: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    const start = new Date(data.expectedStartDate);
    const finish = new Date(data.expectedFinishDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(finish.getTime()) && finish < start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedFinishDate"], message: "Expected Finish Date cannot be before Expected Start Date." });
    }
  });

// The subset of request-origin-only fields a Project may have maintained
// LATER through the normal edit workflow (PATCH /api/projects/[id]) — never
// expectedTotalInitialDays (the creation-time baseline, never client-
// editable) and never projectOwnerId (ownership reassignment, if ever
// needed, is a separate concern outside this feature's scope). Every field
// here is optional on its own — a PATCH touching only, say, actualCost must
// still work without resupplying every other field — so the
// expectedFinishDate >= expectedStartDate invariant is re-checked against
// the EXISTING stored values at the route level instead of here (a pure
// schema-level refine can't see what's already in the database).
//
// Unlike createProjectFromRequestSchema (which stays strictly REQUIRED —
// this schema intentionally never weakens that), every field here is both
// OPTIONAL (the key may be omitted — "leave this field untouched") AND
// NULLABLE (the key may be explicitly `null` — "clear this field"). The
// route (PATCH /api/projects/[id]) relies on telling those two states
// apart: `undefined` passed through to Prisma leaves a column untouched,
// `null` sets it to NULL. external stays a plain boolean (no null) — it
// already defaults to false and the task this schema was last revised for
// explicitly asked not to introduce tri-state for it.
export const updateProjectRequestOriginFieldsSchema = z.object({
  expectedStartDate: z.string().min(1).nullable().optional(),
  expectedFinishDate: z.string().min(1).nullable().optional(),
  expenseTypeId: z.string().trim().min(1).nullable().optional(),
  // Budget/Estimated Cost/Actual Cost are no longer editable fields at all
  // — see createProjectFromRequestSchema's own doc comment above. A client
  // sending any of these three keys now has them silently stripped by Zod
  // (unknown keys), never persisted.
  external: z.boolean().optional(),
});

export const projectExpenseTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  isActive: z.boolean().optional(),
});

// ─── Project Feedback Schema ────────────────────────────────────────────────────
// The ORIGINAL Project Request requester's one-time evaluation of a
// delivered, request-origin Project — see prisma/schema.prisma's
// ProjectFeedback model and POST /api/projects/[id]/feedback's own
// authorization checks (requester identity, Project completion, request-
// origin provenance, and no existing row are ALL re-verified server-side;
// this schema only validates the two fields the client actually sends).
// submittedByUserId/projectId/projectRequestId are never fields here —
// they're never accepted from the client at all, only ever set server-side
// from the authenticated session and the already-verified Project row.
export const projectFeedbackSchema = z.object({
  // Integer 1-10 inclusive. z.coerce is deliberately NOT used — this repo's
  // other rating-shaped inputs (Project priority, Activity priority) are
  // sent as real numbers by their own client components, not form-encoded
  // strings, and this one follows the same convention (a decimal or
  // string value is a genuine client bug, not something to silently round
  // or coerce).
  satisfactionScore: z.number().int("Rating must be a whole number.").min(1, "Rating must be at least 1.").max(10, "Rating must be at most 10."),
  // Optional — an empty/whitespace-only string normalizes to undefined
  // (never persisted as an empty string), same convention as this
  // feature's own comments field is documented to use in the Prisma
  // schema. 2000 chars is a deliberately smaller ceiling than
  // createNoteSchema's 10,000 — feedback comments are a short evaluation,
  // not a running discussion thread.
  comments: z
    .string()
    .trim()
    .max(2000, "Comments must not exceed 2,000 characters.")
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
});

export type ProjectFeedbackInput = z.infer<typeof projectFeedbackSchema>;

// ─── Activity Sequence (reorder) Schema ─────────────────────────────────────────
// The full, ordered list of Activity ids for a request-origin Project's
// vertical sequence — see lib/services/activity-sequence-service.ts's
// reorderProjectActivities for the authoritative server-side validation
// (every id must belong to THIS Project, no duplicates, no partial list —
// re-verified there, never trusted from this shape check alone).
export const reorderActivitiesSchema = z.object({
  activityIds: z.array(z.string().trim().min(1)).min(1, "At least one Activity id is required."),
});

export type ReorderActivitiesInput = z.infer<typeof reorderActivitiesSchema>;

// ─── Activity Schemas ──────────────────────────────────────────────────────────

export const createActivitySchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().optional(),
  // Nullable (not just optional) so an update can explicitly clear it back
  // to Standalone — `undefined` means "leave unchanged", `null` means "make
  // Standalone", same distinction subDepartmentId below already uses.
  projectId: z.string().nullable().optional(),
  status: z.nativeEnum(ActivityStatus).default(ActivityStatus.TODO),
  priority: z.nativeEnum(ActivityPriority).default(ActivityPriority.MEDIUM),
  // "Related Users" (request-origin requirement: at least one required) —
  // this reuses the SAME field/relation every other Activity assignment
  // already uses; see this field's own canonical relation
  // (assignedUsers/"ActivityAssignees") in prisma/schema.prisma. No
  // separate "related users" relation was added.
  assignedUserIds: z.array(z.string()).default([]),
  departmentId: z.string().optional(),
  subDepartmentId: z.string().nullable().optional(),
  businessUnitId: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  isCompleted: z.boolean().default(false),
  // progress is deliberately NOT accepted here — it's fully derived from
  // status (per-department configurable, see
  // lib/activities/activity-progress.ts) and set server-side on every
  // write, never manually editable. Any progress a client sends is simply
  // dropped by Zod before it ever reaches the route handler.
  isMilestone: z.boolean().optional(),
  // ─── Request-origin-only Activity metadata ────────────────────────────
  // Every field below is OPTIONAL at the schema level — this is the SAME
  // single schema used for every Activity, manual or request-origin alike
  // (there is only one Activity creation endpoint, unlike Project's two
  // separate create paths). Requiredness for a request-origin parent
  // Project is enforced in the ROUTE (POST /api/activities and PATCH
  // .../[id]), AFTER resolving the parent Project server-side and checking
  // project.projectRequestId — never here, and never from a client flag.
  // expectedDays/actualDays/taskTypeCost are deliberately NOT fields on
  // this schema at all — every one of them is server-computed only.
  expectedStartDate: z.string().nullable().optional(),
  expectedFinishDate: z.string().nullable().optional(),
  // Owner — a NEW single-user field (see prisma/schema.prisma's
  // ProjectActivity.ownerId doc comment for why this isn't a reuse of the
  // legacy, unused singular `assignedUser`).
  ownerId: z.string().trim().min(1).nullable().optional(),
  taskTypeId: z.string().trim().min(1).nullable().optional(),
});

export const updateActivitySchema = createActivitySchema.partial();

// The exact set of request-origin-only fields required at INITIAL Activity
// creation when the parent Project itself originates from a Project Request
// — re-checked in the route against the ALREADY-PARSED createActivitySchema
// output (not a separate schema merge) because, unlike Project's two
// distinct create endpoints, Activity has only ONE — see this schema's own
// doc comment above.
export function requestOriginActivityMissingFields(data: {
  expectedStartDate?: string | null;
  expectedFinishDate?: string | null;
  taskTypeId?: string | null;
  ownerId?: string | null;
  assignedUserIds?: string[];
}): string[] {
  const missing: string[] = [];
  if (!data.expectedStartDate) missing.push("expectedStartDate");
  if (!data.expectedFinishDate) missing.push("expectedFinishDate");
  if (!data.taskTypeId) missing.push("taskTypeId");
  if (!data.ownerId) missing.push("ownerId");
  if (!data.assignedUserIds || data.assignedUserIds.length === 0) missing.push("assignedUserIds");
  return missing;
}

// Global reference data (see ActivityTaskType in prisma/schema.prisma) —
// cost is REQUIRED on create (every Task Type must have a real,
// authoritative cost), optional only via .partial() below for PATCH, where
// an isActive-only toggle or a name-only rename must still work without
// resupplying cost every time. Reuses moneyAmountSchema verbatim — the same
// exact-money convention as Project Budget/Estimated/Actual Cost, never a
// duplicated factory.
export const activityTaskTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  isActive: z.boolean().optional(),
  cost: moneyAmountSchema("Cost"),
});

// ─── Notes Schemas ─────────────────────────────────────────────────────────────
// Shared by ProjectNote and ActivityNote — deliberately just a plain-text
// body. No isInternal/direction/visibility/email fields exist here or ever
// should: a Project/Activity note has exactly one concept (see
// components/notes/ and app/api/{projects,activities}/[id]/notes/route.ts).
// authorId is never accepted from the client — it always comes from the
// authenticated session in the route handler.

export const createNoteSchema = z.object({
  body: z.string().trim().min(1, "Note cannot be empty").max(10000, "Note must not exceed 10,000 characters"),
  // Candidate @mention user ids from the composer — NEVER trusted as-is;
  // re-validated in the route handler against
  // lib/services/mention-service.ts's canonical view-eligibility check
  // before anything is persisted or notified. See that module's doc
  // comment for the full security model.
  mentionUserIds: z.array(z.string()).max(50).default([]),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const createDependencySchema = z.object({
  predecessorId: z.string().min(1),
  successorId: z.string().min(1),
  type: z.nativeEnum(DependencyType).default(DependencyType.FINISH_TO_START),
});

// ─── Goal Schemas ──────────────────────────────────────────────────────────────

export const createGoalSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.NOT_STARTED),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  unit: z.string().optional(),
  projectIds: z.array(z.string()).default([]),
});

export const updateGoalSchema = createGoalSchema.partial();

// ─── Admin Schemas ─────────────────────────────────────────────────────────────

// A single "Department Memberships" row from the Add/Edit User dialog —
// exactly one of role/customRoleId, matching the same shape
// grantManualMembership's DepartmentRoleSelection already expects.
const departmentMembershipInputSchema = z
  .object({
    departmentId: z.string().min(1),
    role: z.nativeEnum(DepartmentRole).optional(),
    customRoleId: z.string().nullable().optional(),
  })
  .refine((data) => !!data.role !== !!data.customRoleId, {
    message: "Provide exactly one of role or customRoleId",
  });

export const updateUserRoleSchema = z.object({
  role: z.nativeEnum(Role),
  customRoleId: z.string().nullable().optional(),
  // departmentId is the legacy field name — primaryDepartmentId is the
  // preferred alias the Add/Edit User UI now sends; the route treats them
  // as the same write (see app/api/admin/users/[id]/route.ts).
  departmentId: z.string().nullable().optional(),
  primaryDepartmentId: z.string().nullable().optional(),
  businessUnitId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required")
    .email("Invalid email address")
    .optional(),
});

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.nativeEnum(Role).default(Role.USER),
  // Custom GLOBAL/BOTH-scope role (see getGlobalRoleOptions) — mirrors
  // updateUserRoleSchema's field. `role` still carries the required-column
  // placeholder (Role.USER) when this is set, exactly as the edit path
  // already does.
  customRoleId: z.string().nullable().optional(),
  // Legacy single-department field — kept for backward compatibility with
  // any other caller; the Add User UI now sends primaryDepartmentId +
  // departmentMemberships instead (see app/api/admin/users/route.ts).
  departmentId: z.string().optional(),
  primaryDepartmentId: z.string().nullable().optional(),
  departmentMemberships: z.array(departmentMembershipInputSchema).default([]),
  businessUnitId: z.string().optional(),
  isActive: z.boolean().default(true),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// Deliberately not a full URL/hostname validator — just enough to catch
// obvious mistakes (spaces, missing a dot) while accepting anything a real
// registrar could issue, same permissiveness level as the rest of this
// file's domain-shaped fields.
const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export const createCompanySchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  domain: z.string().trim().toLowerCase().regex(domainRegex, "Enter a valid domain, e.g. company.com"),
});

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").optional(),
  domain: z.string().trim().toLowerCase().regex(domainRegex, "Enter a valid domain, e.g. company.com").optional(),
});

export const createBusinessUnitSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters"),
  companyId: z.string().min(1, "Company is required"),
});

export const updateBusinessUnitSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").optional(),
  companyId: z.string().min(1, "Company is required").optional(),
});

export const createDepartmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  description: z.string().trim().min(1).optional(),
  businessUnitId: z.string().optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers and hyphens")
    .optional(),
  description: z.string().trim().nullable().optional(),
  // Deliberately not `.nullable()` — a department must always belong to
  // exactly one Business Unit (Company -> BusinessUnit -> Department ->
  // SubDepartment), so this edit path can narrow WHICH one but never clear
  // it. `.min(1)` also rejects an empty-string payload outright.
  businessUnitId: z.string().min(1, "Select a business unit").optional(),
  isActive: z.boolean().optional(),
});

// Separate from updateDepartmentSchema on purpose — inbound email is gated
// by department.email.manage, a different permission than the general
// department.manageSettings/department.update fields above, and mixing them
// into one PATCH body would conflate the two checks. See
// PATCH /api/admin/departments/[id]/inbound-email.
export const updateDepartmentInboundEmailSchema = z.object({
  inboundEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .nullable(),
});

// ─── External Integrations (admin) ─────────────────────────────────────────────

// .strict() so a caller sending apiKeyHash/apiKeyPrefix/createdById/slug/
// isActive gets an explicit 422 rather than those fields being silently
// stripped (Zod's default for a plain z.object()) — createdById in
// particular must only ever come from the authenticated session, never the
// request body, and .strict() makes any attempt to smuggle it in visible
// as a rejected request instead of a quietly-ignored no-op.
export const createIntegrationSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
    departmentId: z.string().min(1, "departmentId is required"),
    defaultCategoryId: z.string().min(1).optional(),
    defaultPriorityId: z.string().min(1).optional(),
    baseUrl: z.string().trim().url("baseUrl must be a valid URL").max(2000).optional(),
  })
  .strict();

// Deliberately excludes apiKeyPrefix/apiKeyHash (rotation is its own
// dedicated endpoint, never a side effect of a general edit) and slug
// (immutable once created, matching Department's own id/slug stability
// convention — nothing else stores a slug-based reference to an
// integration, but keeping it stable avoids surprising an admin who copied
// it into their own notes/runbook).
export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(100).optional(),
    departmentId: z.string().min(1).optional(),
    defaultCategoryId: z.string().min(1).nullable().optional(),
    defaultPriorityId: z.string().min(1).nullable().optional(),
    baseUrl: z.string().trim().url("baseUrl must be a valid URL").max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const createSubDepartmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  description: z.string().trim().min(1).optional(),
});

export const updateSubDepartmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  description: z.string().trim().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const createCategorySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color").default("#6366f1"),
  // Required — every category belongs to exactly one department, there is
  // no more global/shared category. Enforced (with a clean department_required
  // error code) in the route, not here — kept nullable/optional in the schema
  // itself so that omission surfaces as that specific code, not a generic
  // Zod validation error.
  departmentId: z.string().nullable().optional(),
});

// departmentId deliberately excluded — moving a category between
// departments isn't supported by PATCH /api/admin/categories.
export const updateCategorySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color").optional(),
  isActive: z.boolean().optional(),
});

// ─── Department Membership Schemas (Phase 3) ────────────────────────────────────

// Either a built-in DepartmentRole or a custom department role (CustomRole,
// scope DEPARTMENT/BOTH) — never both. See getDepartmentRoleOptions()
// (lib/services/department-role-options-service.ts) for the unified list
// the "Add Member"/"Change Role" dropdown offers.
export const grantMembershipSchema = z
  .object({
    userId: z.string().min(1, "User is required"),
    role: z.nativeEnum(DepartmentRole).optional(),
    customRoleId: z.string().optional(),
  })
  .refine((data) => !!data.role !== !!data.customRoleId, {
    message: "Provide exactly one of role or customRoleId",
  });

// ─── Microsoft Mapping Schemas (Phase 3) ─────────────────────────────────────────

// Global Role is either a built-in Role enum value or a custom GLOBAL/BOTH-
// scope role (globalCustomRoleId, see
// lib/services/microsoft-mapping-role-options-service.ts) — never both;
// omitting both keeps the pre-existing "defaults to USER" behavior (applied
// in lib/services/microsoft-mapping-service.ts, not here, same reasoning as
// grantMembershipSchema above not using z.default() alongside a mutual-
// exclusion refine). Department Role is REQUIRED (an admin must make an
// explicit choice, no silent default) but, same idea, either the built-in
// enum or a custom DEPARTMENT/BOTH-scope role — never both.
export const createMicrosoftMappingSchema = z
  .object({
    sourceType: z.nativeEnum(MicrosoftMappingSourceType),
    microsoftValue: z.string().trim().min(1, "Value is required"),
    departmentId: z.string().min(1, "Department is required"),
    // Global Role (matches /admin/roles), not DepartmentRole — a stale client
    // sending an old DepartmentRole string (e.g. "AGENT_ASSIGNEE") is rejected
    // here automatically, since it isn't a member of Role.
    role: z.nativeEnum(Role).optional(),
    globalCustomRoleId: z.string().min(1).nullable().optional(),
    // DepartmentRole granted on the resulting DepartmentMembership —
    // independent of `role` above (see department-role-translation.ts).
    departmentRole: z.nativeEnum(DepartmentRole).optional(),
    departmentCustomRoleId: z.string().min(1).nullable().optional(),
    // FIND-006: required (and server-validated against the allowed-domain
    // set) only when sourceType is domain-scoped (today: PROFILE_JOB_TITLE) —
    // ignored for every other sourceType. See
    // lib/services/microsoft-mapping-service.ts's isDomainScopedMicrosoftMappingSourceType.
    domain: z.string().trim().min(1).optional(),
  })
  .refine((data) => !(data.role && data.globalCustomRoleId), {
    message: "Provide at most one of role or globalCustomRoleId",
    path: ["globalCustomRoleId"],
  })
  .refine((data) => !(data.departmentRole && data.departmentCustomRoleId), {
    message: "Provide at most one of departmentRole or departmentCustomRoleId",
    path: ["departmentCustomRoleId"],
  })
  .refine((data) => !!data.departmentRole || !!data.departmentCustomRoleId, {
    message: "Provide either departmentRole or departmentCustomRoleId",
    path: ["departmentRole"],
  });

export const updateMicrosoftMappingSchema = z
  .object({
    sourceType: z.nativeEnum(MicrosoftMappingSourceType).optional(),
    microsoftValue: z.string().trim().min(1, "Value is required").optional(),
    departmentId: z.string().min(1).optional(),
    role: z.nativeEnum(Role).optional(),
    globalCustomRoleId: z.string().min(1).nullable().optional(),
    departmentRole: z.nativeEnum(DepartmentRole).optional(),
    departmentCustomRoleId: z.string().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
    domain: z.string().trim().min(1).optional(),
  })
  .refine((data) => !(data.role && data.globalCustomRoleId), {
    message: "Provide at most one of role or globalCustomRoleId",
    path: ["globalCustomRoleId"],
  })
  .refine((data) => !(data.departmentRole && data.departmentCustomRoleId), {
    message: "Provide at most one of departmentRole or departmentCustomRoleId",
    path: ["departmentCustomRoleId"],
  });

export const createPrioritySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  level: z.number().int().min(1).max(10),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color"),
  // Required — every priority belongs to exactly one department, there is
  // no more global/shared priority. Enforced (with a clean department_required
  // error code) in the route, not here.
  departmentId: z.string().nullable().optional(),
});

// departmentId deliberately excluded — moving a priority between
// departments isn't supported by PATCH /api/admin/priorities.
export const updatePrioritySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  level: z.number().int().min(1).max(10).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color").optional(),
  isActive: z.boolean().optional(),
});

export const createStatusSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color"),
  isDefault: z.boolean().default(false),
  isClosed: z.boolean().default(false),
  order: z.number().int().default(0),
  // Required — every status belongs to exactly one department, there is no
  // more global/shared status. Enforced (with a clean department_required
  // error code) in the route, not here.
  departmentId: z.string().nullable().optional(),
});

// departmentId deliberately excluded — moving a status between departments
// isn't supported by PATCH /api/admin/statuses. Includes isActive (unlike
// createStatusSchema, since new statuses always start active via Prisma's
// own @default(true) and only PATCH ever needs to toggle it).
export const updateStatusSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color").optional(),
  isDefault: z.boolean().optional(),
  isClosed: z.boolean().optional(),
  isActive: z.boolean().optional(),
  order: z.number().int().optional(),
});

export const createCancelReasonSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).optional(),
  // Nullable/omitted = global/shared reason. Only System Admin may create
  // one without a departmentId — enforced in the route, not here.
  departmentId: z.string().nullable().optional(),
});

export const updateCancelReasonSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

// ─── Auth Schemas ──────────────────────────────────────────────────────────────

export const adminLoginSchema = z.object({
  // Normalized the same way every User row is stored (see
  // lib/services/email-identity.ts) — without this, a credentials login
  // typed as "Admin@Kinsen.gr" would fail to match the stored
  // "admin@kinsen.gr" row even though the account genuinely exists.
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain at least one uppercase letter")
      .regex(/[a-z]/, "Must contain at least one lowercase letter")
      .regex(/[0-9]/, "Must contain at least one number")
      .regex(/[^A-Za-z0-9]/, "Must contain at least one special character"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

// ─── Project Request Form Schemas ──────────────────────────────────────────────
// Client-submittable fields ONLY — requesterId, status, and every
// approval/audit field (including businessAssessment, now an APPROVER-side
// field written only at decision time — see projectRequestApprovalDecisionSchema
// below) are always server-derived (see lib/services/project-request-service.ts)
// and never accepted here.
// `departmentId` is accepted as the caller's CHOICE among their own real
// memberships, never trusted as an authorization decision by itself — the
// route re-verifies it via resolveDepartmentForRequest before it's ever used.

export const createProjectRequestSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters").max(200),
    description: z.string().trim().min(10, "Description must be at least 10 characters").max(5000),
    // Reuses Project's own 1(Low)/2(Medium)/3(High) Int scale — see
    // lib/project-priority.ts. Never a second/independent importance mapping.
    importance: z.number().int().min(1).max(3),
    projectTypeId: z.string().min(1, "Project Type is required"),
    teamConcerned: z.string().trim().min(2, "Team concerned must be at least 2 characters").max(200),
    expectedBenefits: z.string().trim().min(10, "Expected benefits must be at least 10 characters").max(5000),
    // businessAssessment is deliberately NOT accepted here — it moved to the
    // approver's decision (see projectRequestApprovalDecisionSchema). Any
    // businessAssessment a client sends in the create payload is discarded
    // server-side (zod's default strip-unknown-keys behavior), never
    // persisted anywhere.
    replacesExisting: z.boolean().default(false),
    // Required (trimmed, non-empty) EXACTLY when replacesExisting is true —
    // enforced below via .superRefine, never trusted from client state or
    // HTML `required` alone. When replacesExisting is false, ANY value sent
    // here (forged or otherwise) is simply discarded — the route always
    // persists null in that case (see POST /api/project-requests), never
    // whatever a client happened to submit. max(5000) matches every other
    // free-text Project Request field.
    replacementDescription: z.string().trim().max(5000).optional(),
    // Only meaningful (and only ever consulted) when the requester belongs to
    // more than one active department — resolveDepartmentForRequest ignores
    // this entirely for a single-department requester and auto-selects
    // instead. A value here that isn't one of the requester's OWN real,
    // active memberships is always rejected server-side.
    departmentId: z.string().optional(),
    // The requester's OWN choice of who must unanimously clear the
    // intermediate stage before this request can ever reach final approval
    // — mandatory (fail closed, never silently skipped), at least one id.
    // Each id is re-verified server-side against who ACTUALLY holds
    // projectRequest.intermediateApprove at submission time (see
    // resolveIntermediateApprovers in lib/services/project-request-service.ts)
    // — a forged/stale id here is always rejected, never silently accepted.
    intermediateApproverIds: z
      .array(z.string().min(1))
      .min(1, "Select at least one intermediate approver")
      .refine((ids) => new Set(ids).size === ids.length, "The same approver was selected more than once"),
  })
  .superRefine((data, ctx) => {
    if (data.replacesExisting && !data.replacementDescription) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Describe the existing solution or project that this request will replace.",
        path: ["replacementDescription"],
      });
    }
  });

// businessAssessment is MANDATORY for every FINAL decision (both approve and
// reject) — the approver's own contextual justification, never optional and
// never the requester's. max(5000) matches every other large Project
// Request text field. Trimmed here so a whitespace-only value is rejected
// by min(1), never silently accepted as "blank but technically present".
//
// FINAL approval is responsible ONLY for the approval decision itself —
// it no longer creates a Project (that moved to a dedicated follow-up step,
// see POST /api/project-requests/[id]/project and
// createProjectFromApprovedRequest in lib/services/project-request-service.ts),
// so this schema no longer accepts/requires a projectOwnerId at all.
export const projectRequestApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  businessAssessment: z.string().trim().min(1, "Business Assessment is required").max(5000),
});

// The intermediate stage deliberately does NOT require a Business
// Assessment (confirmed with the user: only the FINAL decision needs one) —
// accepted here only as optional free text, trimmed, capped at 5000 like
// every other large Project Request text field. No projectOwnerId either:
// a Project is only ever created once the FINAL stage approves, never from
// an intermediate decision.
export const projectRequestIntermediateApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  businessAssessment: z.string().trim().max(5000).optional(),
});

// Cost was deliberately REMOVED from Project Request Type (and its
// ProjectRequest submission-time snapshot) — Project Request Types now
// represent identity/name + lifecycle (isActive) only. See
// prisma/migrations/20261004090000_add_activity_task_type_and_request_origin_fields
// for the destructive column-drop this change required, and Task Type's own
// `activityTaskTypeSchema` below for the unrelated, NEW Activity-level cost
// concept this must never be confused with.
export const projectRequestTypeSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  isActive: z.boolean().optional(),
});

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ReplyTicketInput = z.infer<typeof replyTicketSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CreateProjectRequestInput = z.infer<typeof createProjectRequestSchema>;
export type ProjectRequestApprovalDecisionInput = z.infer<typeof projectRequestApprovalDecisionSchema>;
export type ProjectRequestIntermediateApprovalDecisionInput = z.infer<typeof projectRequestIntermediateApprovalDecisionSchema>;
export type ProjectRequestTypeInput = z.infer<typeof projectRequestTypeSchema>;
export type ActivityTaskTypeInput = z.infer<typeof activityTaskTypeSchema>;
export type CreateProjectFromRequestInput = z.infer<typeof createProjectFromRequestSchema>;
export type ProjectExpenseTypeInput = z.infer<typeof projectExpenseTypeSchema>;
