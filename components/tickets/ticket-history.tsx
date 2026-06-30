import { formatRelative, getInitials } from "@/lib/utils";
import { TicketHistoryType } from "@prisma/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ArrowRight,
  UserCheck,
  Tag,
  Layers,
  GitBranch,
  XCircle,
  RefreshCcw,
  MessageSquare,
  Paperclip,
  Plus,
} from "lucide-react";

interface HistoryEntry {
  id: string;
  type: TicketHistoryType;
  oldValue?: string | null;
  newValue?: string | null;
  description?: string | null;
  createdAt: string | Date;
  changedBy?: {
    id: string;
    name?: string | null;
    image?: string | null;
  } | null;
}

const HISTORY_ICONS: Record<TicketHistoryType, React.ElementType> = {
  CREATED: Plus,
  STATUS_CHANGE: GitBranch,
  PRIORITY_CHANGE: Layers,
  CATEGORY_CHANGE: Tag,
  ASSIGNMENT_CHANGE: UserCheck,
  DEPARTMENT_CHANGE: GitBranch,
  CLOSED: XCircle,
  REOPENED: RefreshCcw,
  COMMENT_ADDED: MessageSquare,
  ATTACHMENT_ADDED: Paperclip,
  CANCEL_REASON_SET: XCircle,
};

const HISTORY_COLORS: Record<TicketHistoryType, string> = {
  CREATED: "bg-green-100 text-green-700",
  STATUS_CHANGE: "bg-blue-100 text-blue-700",
  PRIORITY_CHANGE: "bg-orange-100 text-orange-700",
  CATEGORY_CHANGE: "bg-purple-100 text-purple-700",
  ASSIGNMENT_CHANGE: "bg-cyan-100 text-cyan-700",
  DEPARTMENT_CHANGE: "bg-indigo-100 text-indigo-700",
  CLOSED: "bg-gray-100 text-gray-700",
  REOPENED: "bg-green-100 text-green-700",
  COMMENT_ADDED: "bg-slate-100 text-slate-700",
  ATTACHMENT_ADDED: "bg-slate-100 text-slate-700",
  CANCEL_REASON_SET: "bg-red-100 text-red-700",
};

interface TicketHistoryProps {
  history: HistoryEntry[];
}

export function TicketHistory({ history }: TicketHistoryProps) {
  if (history.length === 0) {
    return (
      <p className="text-center text-muted-foreground py-8 text-sm">
        No history yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {history.map((entry) => {
        const Icon = HISTORY_ICONS[entry.type] ?? GitBranch;
        const colorClass = HISTORY_COLORS[entry.type] ?? "bg-gray-100 text-gray-700";

        return (
          <div key={entry.id} className="flex items-start gap-3 text-sm">
            <div className={`rounded-full p-1.5 flex-shrink-0 mt-0.5 ${colorClass}`}>
              <Icon className="h-3 w-3" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">
                  {entry.changedBy?.name ?? "System"}
                </span>
                <span className="text-muted-foreground text-xs">
                  {entry.description}
                </span>
              </div>
              {entry.oldValue && entry.newValue && (
                <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                  <span className="line-through">{entry.oldValue}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span className="font-medium text-foreground">{entry.newValue}</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatRelative(entry.createdAt)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
