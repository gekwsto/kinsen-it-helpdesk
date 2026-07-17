import { DepartmentRole, MembershipSource, MicrosoftMappingSourceType, Role } from "@prisma/client";

/** Global Role display labels — matching component-local copies (e.g. user-management.tsx) but kept here too for reuse where a shared source avoids duplication. */
export const GLOBAL_ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Dept. Manager",
  USER: "User",
};

/** Shared between the members page and the Microsoft mapping page — one definition of what each DepartmentRole means. */
export const DEPARTMENT_ROLE_LABELS: Record<DepartmentRole, string> = {
  DEPARTMENT_ADMIN: "Department Admin",
  DEPARTMENT_MANAGER: "Department Manager",
  PROJECT_MANAGER: "Project Manager",
  AGENT_ASSIGNEE: "Agent / Assignee",
  REQUESTER: "Requester",
  VIEWER: "Viewer",
};

export const DEPARTMENT_ROLE_DESCRIPTIONS: Record<DepartmentRole, string> = {
  DEPARTMENT_ADMIN: "Full control of this department — projects, tickets, activities, goals, members and settings.",
  DEPARTMENT_MANAGER: "Manages projects, activities and goals; sees all department tickets, but not member/settings management.",
  PROJECT_MANAGER: "Creates and edits projects and Gantt schedules for this department only.",
  AGENT_ASSIGNEE: "Handles assigned tickets and activities; sees every ticket in this department.",
  REQUESTER: "Creates and tracks their own tickets in this department only.",
  VIEWER: "Read-only access to this department's projects, tickets and activities.",
};

export const DEPARTMENT_ROLE_OPTIONS = Object.values(DepartmentRole);

export const MEMBERSHIP_SOURCE_LABELS: Record<MembershipSource, string> = {
  MANUAL: "Manual",
  MICROSOFT_DEPARTMENT: "Microsoft — Department",
  MICROSOFT_GROUP: "Microsoft — Group",
  MICROSOFT_APP_ROLE: "Microsoft — App Role",
};

export const MEMBERSHIP_SOURCE_COLORS: Record<MembershipSource, string> = {
  MANUAL: "bg-slate-100 text-slate-700 border-slate-200",
  MICROSOFT_DEPARTMENT: "bg-blue-100 text-blue-700 border-blue-200",
  MICROSOFT_GROUP: "bg-blue-100 text-blue-700 border-blue-200",
  MICROSOFT_APP_ROLE: "bg-blue-100 text-blue-700 border-blue-200",
};

export const MAPPING_SOURCE_TYPE_LABELS: Record<MicrosoftMappingSourceType, string> = {
  PROFILE_DEPARTMENT: "Profile Department",
  ENTRA_GROUP: "Entra Group",
  ENTRA_APP_ROLE: "Entra App Role",
};

export const MAPPING_SOURCE_TYPE_HELP: Record<MicrosoftMappingSourceType, string> = {
  PROFILE_DEPARTMENT: "Matches the Microsoft Graph profile \"department\" field, e.g. \"Procurement\".",
  ENTRA_GROUP: "Matches an Entra ID group name/id the user belongs to, e.g. \"TicketApp - Procurement\".",
  ENTRA_APP_ROLE: "Matches an app role assigned to the user on this app registration, e.g. \"TicketApp.Procurement.Manager\".",
};

export const MAPPING_SOURCE_TYPE_OPTIONS = Object.values(MicrosoftMappingSourceType);
