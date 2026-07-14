"use client";

import { signOut } from "next-auth/react";
import { LogOut, User, ChevronDown } from "lucide-react";
import { getInitials } from "@/lib/utils";
import { Role } from "@prisma/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { NotificationDropdown } from "@/components/notifications/notification-dropdown";
import { WorkspaceSelector } from "@/components/workspace/workspace-selector";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Dept. Manager",
  USER: "User",
};

const ROLE_BADGE_VARIANTS: Record<Role, string> = {
  ADMIN: "bg-red-100 text-red-700 border-red-200",
  IT_AGENT: "bg-blue-100 text-blue-700 border-blue-200",
  DEPARTMENT_MANAGER: "bg-purple-100 text-purple-700 border-purple-200",
  USER: "bg-gray-100 text-gray-700 border-gray-200",
};

interface TopbarProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role: Role;
  };
}

export function Topbar({ user }: TopbarProps) {
  return (
    <header className="h-16 border-b bg-white flex items-center justify-between px-6 sticky top-0 z-30">
      <div className="flex items-center gap-2">
        <WorkspaceSelector />
      </div>

      <div className="flex items-center gap-3">
        {/* Notifications */}
        <NotificationDropdown />

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 pl-2 pr-3 h-9"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User"} />
                <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                  {getInitials(user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:block text-left">
                <p className="text-sm font-medium leading-none">{user.name}</p>
                <p className="text-xs text-muted-foreground leading-none mt-0.5">
                  {user.email}
                </p>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
                <span
                  className={`mt-1 inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium w-fit ${ROLE_BADGE_VARIANTS[user.role]}`}
                >
                  {ROLE_LABELS[user.role]}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <User className="mr-2 h-4 w-4" />
                Profile & Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="text-destructive focus:text-destructive"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
