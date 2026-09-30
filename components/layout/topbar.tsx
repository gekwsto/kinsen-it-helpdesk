"use client";

import { signOut } from "next-auth/react";
import { LogOut, User, ChevronDown, Search, X } from "lucide-react";
import { useState } from "react";
import { getInitials } from "@/lib/utils";
import { Role } from "@prisma/client";
import { getSessionSyncChannel, broadcastLogout } from "@/lib/client-session-broadcast";
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
import { GlobalSearch } from "@/components/layout/global-search";
import { ThemeToggle } from "@/components/theme/theme";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Dept. Manager",
  DIRECTOR: "Director",
  USER: "User",
};

interface TopbarProps {
  canViewAllTickets: boolean;
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role: Role;
    /** Persisted CustomRole.name — preferred over ROLE_LABELS below when present (renamed built-in role or a genuinely custom role). */
    roleName?: string | null;
  };
}

export function Topbar({ user, canViewAllTickets }: TopbarProps) {
  // Phones hide the inline search field; this toggles it as a row under the bar.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  return (
    <header className="relative h-14 border-b bg-card flex items-center gap-3 px-3 sm:gap-4 sm:px-6 sticky top-0 z-30">
      {mobileSearchOpen && (
        <div className="absolute inset-x-0 top-full border-b bg-card px-3 py-2 sm:hidden">
          <GlobalSearch canViewAllTickets={canViewAllTickets} autoFocus onDone={() => setMobileSearchOpen(false)} />
        </div>
      )}
      <div className="flex flex-1 items-center gap-3 min-w-0">
        <div className="min-w-0 shrink">
          <WorkspaceSelector />
        </div>
        <div className="hidden min-w-0 flex-1 sm:block">
          <GlobalSearch canViewAllTickets={canViewAllTickets} />
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          aria-label={mobileSearchOpen ? "Close search" : "Search tickets"}
          aria-expanded={mobileSearchOpen}
          onClick={() => setMobileSearchOpen((v) => !v)}
        >
          {mobileSearchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </Button>
        <ThemeToggle />
        {/* Notifications */}
        <NotificationDropdown />

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 px-1.5 sm:pl-2 sm:pr-3 h-9 ml-1"
            >
              <Avatar className="h-7 w-7">
                <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User"} />
                <AvatarFallback className="text-xs bg-brand-navy text-white">
                  {getInitials(user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:block text-left">
                <p className="text-sm font-medium leading-none">{user.name}</p>
                <p className="text-xs text-muted-foreground leading-none mt-0.5">
                  {user.email}
                </p>
              </div>
              <ChevronDown className="hidden sm:block h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-muted-foreground">{user.email}</p>
                <span className="mt-1 inline-flex w-fit items-center rounded-sm border px-2 py-0.5 text-xs font-medium text-foreground">
                  {user.roleName ?? ROLE_LABELS[user.role]}
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
              onClick={() => {
                // Same cross-tab channel components/auth/session-expiry-controller.tsx
                // listens on — a manual sign-out here must also end every
                // other open tab's session, not just this one.
                broadcastLogout(getSessionSyncChannel());
                signOut({ callbackUrl: "/login" });
              }}
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
