"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Role } from "@prisma/client";
import {
  LayoutDashboard,
  Ticket,
  FolderKanban,
  CheckSquare,
  Users,
  Building2,
  Network,
  Tag,
  AlertTriangle,
  Settings,
  ChevronDown,
  Headset,
  Target,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
} from "lucide-react";
import { useState, useEffect } from "react";
import type { NavVisibilityFlags } from "@/lib/services/department-scope-service";
import { useHelpGuide } from "@/components/help/help-guide-provider";

// `visible`, when defined, wins outright over `roles` — lets specific items
// be gated by a server-computed permission flag (e.g. subdepartment.view)
// instead of a hardcoded Role[] list, without touching any item that still
// only sets `roles`.
interface NavChild {
  label: string;
  href: string;
  roles?: Role[];
  visible?: boolean;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  roles?: Role[];
  visible?: boolean;
  children?: NavChild[];
}

interface SidebarProps {
  userRole: Role;
  canCreateTicket: boolean;
  navFlags: NavVisibilityFlags;
}

// Shared sizing for every nav/footer row — one place to tune "comfortable
// on tall screens, compact on short ones" instead of repeating the same
// responsive utility string at each of the 6 places an item renders
// (collapsed icon links, the expandable button, child links, leaf links,
// and the two footer buttons). maxh-800/maxh-700 are custom max-height
// screens (tailwind.config.ts) — width-based breakpoints (sm/md/lg) don't
// help here since the constraint is vertical (short laptop viewports), not
// sidebar width, which is already handled separately by collapsed mode.
const NAV_ITEM_SIZE = "min-h-[44px] py-2.5 maxh-800:min-h-[40px] maxh-800:py-2 maxh-700:min-h-[36px] maxh-700:py-1.5";
const NAV_CHILD_SIZE = "min-h-[40px] py-2 maxh-800:min-h-[38px] maxh-800:py-1.5 maxh-700:min-h-[34px] maxh-700:py-1";
const NAV_ICON_SIZE = "p-2.5 maxh-700:p-2";

export function Sidebar({ userRole, canCreateTicket, navFlags }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedItems, setExpandedItems] = useState<string[]>(["Tickets"]);
  // Help Guide is available to every user regardless of role/permissions —
  // no canAccess() gate applies to it, unlike every other item above.
  const { toggle: toggleHelpGuide } = useHelpGuide();

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") setCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  const ticketChildren = [
    ...(["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"].includes(userRole)
      ? [{ label: "All Tickets", href: "/tickets" }]
      : []),
    { label: "Assigned to Me", href: "/tickets/assigned-to-me" },
    { label: "Created by Me", href: "/tickets/created-by-me" },
    ...(canCreateTicket ? [{ label: "Create Ticket", href: "/tickets/new" }] : []),
    { label: "Pending Tickets", href: "/tickets/pending", visible: navFlags.canViewPendingTickets },
    ...(userRole === "ADMIN"
      ? [{ label: "Closed Tickets", href: "/tickets/closed", roles: ["ADMIN"] as Role[] }]
      : []),
  ];

  const navItems: NavItem[] = [
    {
      label: "Dashboard",
      href: "/dashboard",
      icon: LayoutDashboard,
    },
    {
      label: "Tickets",
      href: "/tickets",
      icon: Ticket,
      children: ticketChildren,
    },
    {
      label: "Projects",
      href: "/projects",
      icon: FolderKanban,
      roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[],
      children: [
        { label: "All Projects", href: "/projects", roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[] },
        { label: "My Projects", href: "/my-projects", roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[] },
        { label: "New Project", href: "/projects/new", roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[] },
        { label: "Project Gantt", href: "/projects/gantt", roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[] },
        { label: "Resource Planning", href: "/projects/resource-planning", roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[] },
      ],
    },
    {
      label: "Activities",
      href: "/activities",
      icon: CheckSquare,
      roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[],
      children: [
        { label: "All Activities", href: "/activities" },
        { label: "My Activities", href: "/my-activities" },
        { label: "Activity Gantt", href: "/activities/gantt" },
        { label: "New Activity", href: "/activities/new" },
      ],
    },
    {
      label: "Goals",
      href: "/goals",
      icon: Target,
      roles: ["ADMIN", "IT_AGENT", "DEPARTMENT_MANAGER", "DIRECTOR"] as Role[],
    },
    {
      label: "Organization",
      href: "/my-departments",
      icon: Network,
      visible: navFlags.canViewMyDepartments || navFlags.canViewMySubDepartments,
      children: [
        { label: "My Departments", href: "/my-departments", visible: navFlags.canViewMyDepartments },
        { label: "My SubDepartments", href: "/my-subdepartments", visible: navFlags.canViewMySubDepartments },
      ],
    },
    {
      label: "Administration",
      href: "/admin",
      icon: Settings,
      visible: userRole === "ADMIN" || navFlags.canViewAdminSubDepartments,
      children: [
        { label: "Users", href: "/admin/users", roles: ["ADMIN"] as Role[] },
        { label: "Role Permissions", href: "/admin/roles", roles: ["ADMIN"] as Role[] },
        { label: "Departments", href: "/admin/departments", roles: ["ADMIN"] as Role[] },
        { label: "Sub Departments", href: "/admin/sub-departments", visible: navFlags.canViewAdminSubDepartments },
        { label: "Microsoft Mappings", href: "/admin/microsoft-mappings", roles: ["ADMIN"] as Role[] },
        { label: "Categories", href: "/admin/categories", roles: ["ADMIN"] as Role[] },
        { label: "Priorities", href: "/admin/priorities", roles: ["ADMIN"] as Role[] },
        { label: "Statuses", href: "/admin/statuses", roles: ["ADMIN"] as Role[] },
        { label: "Cancel Reasons", href: "/admin/cancel-reasons", roles: ["ADMIN"] as Role[] },
        { label: "SLA", href: "/admin/sla", roles: ["ADMIN"] as Role[] },
        { label: "Email Settings", href: "/admin/email", roles: ["ADMIN"] as Role[] },
      ],
    },
  ];

  const pathname = usePathname();

  const toggleExpand = (label: string) => {
    setExpandedItems((prev) =>
      prev.includes(label) ? prev.filter((i) => i !== label) : [...prev, label]
    );
  };

  const canAccess = (entry: { roles?: Role[]; visible?: boolean }) => {
    if (entry.visible !== undefined) return entry.visible;
    if (!entry.roles || entry.roles.length === 0) return true;
    return entry.roles.includes(userRole);
  };

  const isActive = (href: string) => {
    if (pathname === href) return true;
    return pathname.startsWith(href + "/");
  };

  return (
    <aside
      className={cn(
        "min-h-screen flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-all duration-200 flex-shrink-0",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Logo / Header */}
      {collapsed ? (
        <div className="h-16 flex flex-col items-center justify-center gap-1 border-b border-sidebar-border">
          <button
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            aria-expanded={false}
            className="rounded-lg p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <div className="h-16 flex items-center gap-3 px-4 border-b border-sidebar-border">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sidebar-primary flex-shrink-0">
            <Headset className="h-4 w-4 text-sidebar-primary-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Kinsen IT</p>
            <p className="text-xs text-sidebar-foreground/60">Helpdesk</p>
          </div>
          <button
            onClick={toggleCollapsed}
            aria-label="Collapse sidebar"
            aria-expanded={true}
            className="rounded-lg p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors flex-shrink-0"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Navigation — sidebar-scroll gives this its own thin/dark scrollbar
          (globals.css) instead of the app-wide light one; py/space-y shrink
          slightly on shorter viewports (maxh-800/maxh-700, tailwind.config.ts)
          so the menu needs less scrolling on laptop-height screens. */}
      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1 maxh-800:py-3 maxh-700:py-2 maxh-700:space-y-0.5 sidebar-scroll">
        {navItems.map((item) => {
          if (!canAccess(item)) return null;

          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = expandedItems.includes(item.label);
          const active = isActive(item.href);

          // Collapsed mode: all items are direct icon links
          if (collapsed) {
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={cn(
                  "flex items-center justify-center rounded-lg transition-colors",
                  NAV_ICON_SIZE,
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="h-5 w-5" />
              </Link>
            );
          }

          if (hasChildren) {
            const visibleChildren = item.children!.filter((c) => canAccess(c));
            if (visibleChildren.length === 0) return null;

            return (
              <div key={item.label}>
                <button
                  onClick={() => toggleExpand(item.label)}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-3 rounded-lg text-sm font-medium transition-colors",
                    NAV_ITEM_SIZE,
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    pathname.startsWith(item.href)
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80"
                  )}
                >
                  <span className="flex items-center gap-3">
                    <item.icon className="h-4 w-4 flex-shrink-0" />
                    {item.label}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      isExpanded && "rotate-180"
                    )}
                  />
                </button>
                {isExpanded && (
                  <div className="mt-1 ml-4 pl-3 border-l border-sidebar-border space-y-1 maxh-700:space-y-0.5">
                    {visibleChildren.map((child) => (
                      <Link
                        key={child.href}
                        href={child.href}
                        className={cn(
                          "flex items-center gap-2 px-3 rounded-lg text-sm transition-colors",
                          NAV_CHILD_SIZE,
                          isActive(child.href)
                            ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        )}
                      >
                        {child.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors",
                NAV_ITEM_SIZE,
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-sidebar-border space-y-1 maxh-700:space-y-0.5">
        {collapsed ? (
          <>
            <Link
              href="/settings"
              title="Settings"
              className={cn("flex items-center justify-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors", NAV_ICON_SIZE)}
            >
              <Settings className="h-5 w-5" />
            </Link>
            <button
              type="button"
              onClick={toggleHelpGuide}
              title="Help Guide"
              aria-label="Help Guide"
              className={cn("w-full flex items-center justify-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors", NAV_ICON_SIZE)}
            >
              <BookOpen className="h-5 w-5" />
            </button>
          </>
        ) : (
          <>
            <Link
              href="/settings"
              className={cn("flex items-center gap-3 px-3 rounded-lg text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors", NAV_ITEM_SIZE)}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
            <button
              type="button"
              onClick={toggleHelpGuide}
              aria-label="Help Guide"
              className={cn("w-full flex items-center gap-3 px-3 rounded-lg text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors", NAV_ITEM_SIZE)}
            >
              <BookOpen className="h-4 w-4" />
              Help Guide
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
