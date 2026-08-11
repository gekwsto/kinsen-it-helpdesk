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
});

export const updateActivitySchema = createActivitySchema.partial();

// ─── Notes Schemas ─────────────────────────────────────────────────────────────
// Shared by ProjectNote and ActivityNote — deliberately just a plain-text
// body. No isInternal/direction/visibility/email fields exist here or ever
// should: a Project/Activity note has exactly one concept (see
// components/notes/ and app/api/{projects,activities}/[id]/notes/route.ts).
// authorId is never accepted from the client — it always comes from the
// authenticated session in the route handler.

export const createNoteSchema = z.object({
  body: z.string().trim().min(1, "Note cannot be empty").max(10000, "Note must not exceed 10,000 characters"),
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
