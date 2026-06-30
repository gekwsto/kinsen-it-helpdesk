import {
  Ticket,
  TicketMessage,
  TicketAttachment,
  TicketHistory,
  TicketStatus,
  TicketPriority,
  TicketCategory,
  TicketCancelReason,
  User,
  Department,
  BusinessUnit,
  Project,
  ProjectActivity,
  Role,
  TicketSource,
  MessageDirection,
  TicketHistoryType,
  ProjectStatus,
  ActivityStatus,
} from "@prisma/client";

// Re-export enums
export {
  Role,
  TicketSource,
  MessageDirection,
  TicketHistoryType,
  ProjectStatus,
  ActivityStatus,
};

// ─── Expanded types ────────────────────────────────────────────────────────────

export type TicketWithRelations = Ticket & {
  requester: Pick<User, "id" | "name" | "email" | "image">;
  assignedAgent: Pick<User, "id" | "name" | "email" | "image"> | null;
  status: TicketStatus;
  priority: TicketPriority | null;
  category: TicketCategory | null;
  department: Pick<Department, "id" | "name"> | null;
  cancelReason: TicketCancelReason | null;
  messages: TicketMessageWithRelations[];
  attachments: TicketAttachment[];
  history: TicketHistoryWithRelations[];
};

export type TicketMessageWithRelations = TicketMessage & {
  author: (Pick<User, "id" | "name" | "email" | "image"> & { role: Role }) | null;
  attachments: TicketAttachment[];
};

export type TicketHistoryWithRelations = TicketHistory & {
  changedBy: Pick<User, "id" | "name" | "image"> | null;
};

export type ProjectWithRelations = Project & {
  owner: Pick<User, "id" | "name" | "email" | "image">;
  department: Pick<Department, "id" | "name"> | null;
  businessUnit: Pick<BusinessUnit, "id" | "name"> | null;
  members: Pick<User, "id" | "name" | "email" | "image">[];
  activities: ActivityWithRelations[];
};

export type ActivityWithRelations = ProjectActivity & {
  project: Pick<Project, "id" | "title">;
  assignedUser: Pick<User, "id" | "name" | "email" | "image"> | null;
  department: Pick<Department, "id" | "name"> | null;
};

// ─── API response types ────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DashboardStats {
  stats: {
    totalOpen: number;
    totalInProgress: number;
    totalResolved: number;
    totalClosed: number;
    assignedToMe: number;
  };
  byStatus: Array<{ id: string; name: string; color: string; count: number }>;
  byPriority: Array<{
    id: string;
    name: string;
    color: string;
    level: number;
    count: number;
  }>;
  recentTickets: TicketWithRelations[];
  recentActivity: TicketHistoryWithRelations[];
}
