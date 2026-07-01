import { z } from "zod";
import {
  MessageDirection,
  ProjectStatus,
  ActivityStatus,
  ActivityPriority,
  GoalStatus,
  Role,
} from "@prisma/client";

// ─── Ticket Schemas ────────────────────────────────────────────────────────────

export const createTicketSchema = z.object({
  title: z.string().min(5, "Title must be at least 5 characters").max(200),
  description: z.string().min(10, "Description must be at least 10 characters"),
  categoryId: z.string().optional(),
  priorityId: z.string().optional(),
  departmentId: z.string().optional(),
  projectId: z.string().optional(),
  activityId: z.string().optional(),
});

export const updateTicketSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  description: z.string().min(10).optional(),
  categoryId: z.string().nullable().optional(),
  priorityId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  statusId: z.string().optional(),
  assignedAgentId: z.string().nullable().optional(),
  cancelReasonId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  activityId: z.string().nullable().optional(),
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
  businessUnitId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  successTarget: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
});

export const updateProjectSchema = createProjectSchema.partial();

// ─── Activity Schemas ──────────────────────────────────────────────────────────

export const createActivitySchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().optional(),
  projectId: z.string().optional(), // optional — activities can be standalone
  status: z.nativeEnum(ActivityStatus).default(ActivityStatus.TODO),
  priority: z.nativeEnum(ActivityPriority).default(ActivityPriority.MEDIUM),
  assignedUserId: z.string().optional(),
  departmentId: z.string().optional(),
  businessUnitId: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  isCompleted: z.boolean().default(false),
  progress: z.number().int().min(0).max(100).optional(),
});

export const updateActivitySchema = createActivitySchema.partial();

// ─── Goal Schemas ──────────────────────────────────────────────────────────────

export const createGoalSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  title: z.string().min(3, "Title must be at least 3 characters").max(200),
  description: z.string().optional(),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.NOT_STARTED),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  unit: z.string().optional(),
  projectIds: z.array(z.string()).default([]),
});

export const updateGoalSchema = createGoalSchema.partial();

// ─── Admin Schemas ─────────────────────────────────────────────────────────────

export const updateUserRoleSchema = z.object({
  role: z.nativeEnum(Role),
  customRoleId: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  businessUnitId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.nativeEnum(Role).default(Role.USER),
  departmentId: z.string().optional(),
  businessUnitId: z.string().optional(),
  isActive: z.boolean().default(true),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const createDepartmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  businessUnitId: z.string().optional(),
});

export const createCategorySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  description: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color").default("#6366f1"),
});

export const createPrioritySchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  level: z.number().int().min(1).max(10),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color"),
});

export const createStatusSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color"),
  isDefault: z.boolean().default(false),
  isClosed: z.boolean().default(false),
  order: z.number().int().default(0),
});

// ─── Auth Schemas ──────────────────────────────────────────────────────────────

export const adminLoginSchema = z.object({
  email: z.string().email("Invalid email address"),
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
