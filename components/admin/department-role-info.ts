import { MembershipSource, MicrosoftMappingSourceType } from "@prisma/client";

// GLOBAL_ROLE_LABELS / DEPARTMENT_ROLE_LABELS / DEPARTMENT_ROLE_DESCRIPTIONS /
// DEPARTMENT_ROLE_OPTIONS now live in lib/services/department-role-translation.ts
// (the server-and-client-safe home, since API routes need them too for
// Microsoft-mapping role validation) — re-exported here so this file's
// existing consumers don't need to change their import path.
export {
  GLOBAL_ROLE_LABELS,
  GLOBAL_ROLE_DESCRIPTIONS,
  DEPARTMENT_ROLE_LABELS,
  DEPARTMENT_ROLE_DESCRIPTIONS,
  DEPARTMENT_ROLE_OPTIONS,
} from "@/lib/services/department-role-translation";

export const MEMBERSHIP_SOURCE_LABELS: Record<MembershipSource, string> = {
  MANUAL: "Manual",
  MICROSOFT_DEPARTMENT: "Microsoft — Department",
  MICROSOFT_JOB_TITLE: "Microsoft — Job Title",
  MICROSOFT_GROUP: "Microsoft — Group",
  MICROSOFT_APP_ROLE: "Microsoft — App Role",
  HR_DIRECTORY: "HR Directory",
};

export const MEMBERSHIP_SOURCE_COLORS: Record<MembershipSource, string> = {
  MANUAL: "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700",
  MICROSOFT_DEPARTMENT: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  MICROSOFT_JOB_TITLE: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  MICROSOFT_GROUP: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  MICROSOFT_APP_ROLE: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  HR_DIRECTORY: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
};

export const MAPPING_SOURCE_TYPE_LABELS: Record<MicrosoftMappingSourceType, string> = {
  PROFILE_DEPARTMENT: "Profile Department",
  PROFILE_JOB_TITLE: "Profile Job Title",
  ENTRA_GROUP: "Entra Group",
  ENTRA_APP_ROLE: "Entra App Role",
};

export const MAPPING_SOURCE_TYPE_HELP: Record<MicrosoftMappingSourceType, string> = {
  PROFILE_DEPARTMENT: "Matches the Microsoft Graph profile \"department\" field, e.g. \"Procurement\".",
  PROFILE_JOB_TITLE: "Matches the Microsoft Graph user.jobTitle value, e.g. IT Operations Assistant or Systems Operations Manager.",
  ENTRA_GROUP: "Matches an Entra ID group name/id the user belongs to, e.g. \"TicketApp - Procurement\".",
  ENTRA_APP_ROLE: "Matches an app role assigned to the user on this app registration, e.g. \"TicketApp.Procurement.Manager\".",
};

export const MAPPING_SOURCE_TYPE_OPTIONS = Object.values(MicrosoftMappingSourceType);
