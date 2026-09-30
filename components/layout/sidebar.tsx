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
  ShieldCheck,
  Target,
  PanelLeftClose,
  PanelLeftOpen,
  BookOpen,
} from "lucide-react";
import { useState, useEffect } from "react";
import type { NavVisibilityFlags } from "@/lib/services/department-scope-service";
import { useHelpGuide } from "@/components/help/help-guide-provider";
import { resolveActiveHref } from "@/lib/sidebar-active-route";
import { motion, LayoutGroup, useReducedMotion } from "motion/react";
import { KinsenLockup, KinsenMark } from "@/components/layout/kinsen-logo";

/**
 * The Kinsen notch — the K mark's lower teal triangle — marks the current
 * place. One shared layoutId, so it slides from the old item to the new one
 * on navigation (instant under reduced motion).
 */
function Notch() {
  const reduce = useReducedMotion();
  return (
    <motion.span
      layoutId="sidebar-notch"
      aria-hidden="true"
      className="kinsen-notch absolute left-0 top-[calc(50%-0.4375rem)] h-3.5 w-2"
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42 }}
    />
  );
}

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
const NAV_ITEM_SIZE = "min-h-[40px] py-2 maxh-800:min-h-[36px] maxh-800:py-1.5 maxh-700:min-h-[34px] maxh-700:py-1";
const NAV_CHILD_SIZE = "min-h-[34px] py-1.5 maxh-800:min-h-[32px] maxh-700:min-h-[30px] maxh-700:py-1";
const NAV_ICON_SIZE = "p-2.5 maxh-700:p-2";

export function Sidebar({ userRole, navFlags }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  // The section holding the current page starts (and stays) open, so the
  // active child is always visible — not just Tickets.
  const [expandedItems, setExpandedItems] = useState<string[]>(["Tickets"]);
  // Help Guide is available to every user regardless of role/permissions —
  // no canAccess() gate applies to it, unlike every other item above.
  const { toggle: toggleHelpGuide } = useHelpGuide();

  useEffect(() => {
    // Phones always start on the icon rail so the page keeps its width;
    // that automatic collapse is never written back as a preference.
    if (window.matchMedia("(max-width: 767px)").matches) {
      setCollapsed(true);
      return;
    }
    try {
      if (localStorage.getItem("sidebar-collapsed") === "true") setCollapsed(true);
    } catch {
      // Storage blocked: fall back to the expanded default.
    }
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  const ticketChildren = [
    { label: "All Tickets", href: "/tickets", visible: navFlags.canViewAllTickets },
    { label: "Assigned to Me", href: "/tickets/assigned-to-me" },
    { label: "Created by Me", href: "/tickets/created-by-me" },
    { label: "Create Ticket", href: "/tickets/new", visible: navFlags.canCreateTickets },
    { label: "Pending Tickets", href: "/tickets/pending", visible: navFlags.canViewPendingTickets },
    // Same review capability as Pending Tickets — a rejected email request
    // is still an inbound-review record, just further along the same
    // PendingTicket lifecycle (PENDING -> REJECTED, recoverable into
    // ACCEPTED), not a separate permission concept.
    { label: "Rejected Tickets", href: "/tickets/rejected", visible: navFlags.canViewPendingTickets },
    { label: "Closed Tickets", href: "/tickets/closed", visible: navFlags.canViewClosedTickets },
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
      // At least one child (a *.view read link or the *.create "Create
      // Ticket" link) must be reachable for the section to be worth
      // showing — mirrors the Projects/Activities sections below. Clicking
      // this parent itself never navigates (it only toggles expand/collapse
      // — see the `hasChildren` branch further down), so this can never
      // route a create-only, view-less user into a *.view-gated list page.
      visible: navFlags.canViewTickets || navFlags.canCreateTickets,
      children: ticketChildren,
    },
    {
      label: "Projects",
      href: "/projects",
      icon: FolderKanban,
      // Same "at least one visible child" rule as Tickets above.
      visible: navFlags.canViewProjects || navFlags.canCreateProjects,
      children: [
        { label: "All Projects", href: "/projects", visible: navFlags.canViewProjects },
        { label: "My Projects", href: "/my-projects", visible: navFlags.canViewProjects },
        { label: "New Project", href: "/projects/new", visible: navFlags.canCreateProjects },
        { label: "Project Gantt", href: "/projects/gantt", visible: navFlags.canViewProjectGantt },
        { label: "Resource Planning", href: "/projects/resource-planning", visible: navFlags.canViewProjects },
      ],
    },
    {
      label: "Activities",
      href: "/activities",
      icon: CheckSquare,
      // Same "at least one visible child" rule as Tickets above.
      visible: navFlags.canViewActivities || navFlags.canCreateActivities,
      children: [
        { label: "All Activities", href: "/activities", visible: navFlags.canViewActivities },
        { label: "My Activities", href: "/my-activities", visible: navFlags.canViewActivities },
        { label: "Activity Gantt", href: "/activities/gantt", visible: navFlags.canViewActivityGantt },
        { label: "New Activity", href: "/activities/new", visible: navFlags.canCreateActivities },
      ],
    },
    {
      label: "Goals",
      href: "/goals",
      icon: Target,
      visible: navFlags.canViewGoals,
    },
    {
      // Full company tree + reporting-lines chart (department tree / people
      // tree, search, sync) — promoted here from Administration -> Organization
      // Chart, canonical route now /organization (/admin/organization
      // permanently redirects). Distinct from "My Department" below, which is
      // each user's own department/subdepartment membership view, not the
      // company-wide chart.
      label: "Organization",
      href: "/organization",
      icon: Building2,
      visible: navFlags.canViewOrganizationChart,
    },
    {
      label: "My Department",
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
      icon: ShieldCheck,
      visible: userRole === "ADMIN" || navFlags.canViewAdminSubDepartments,
      children: [
        { label: "Users", href: "/admin/users", roles: ["ADMIN"] as Role[] },
        { label: "Role Permissions", href: "/admin/roles", roles: ["ADMIN"] as Role[] },
        { label: "Companies", href: "/admin/companies", roles: ["ADMIN"] as Role[] },
        { label: "Business Units", href: "/admin/business-units", roles: ["ADMIN"] as Role[] },
        { label: "Departments", href: "/admin/departments", roles: ["ADMIN"] as Role[] },
        { label: "Sub Departments", href: "/admin/sub-departments", visible: navFlags.canViewAdminSubDepartments },
        { label: "Microsoft Mappings", href: "/admin/microsoft-mappings", roles: ["ADMIN"] as Role[] },
        { label: "Categories", href: "/admin/categories", roles: ["ADMIN"] as Role[] },
        { label: "Priorities", href: "/admin/priorities", roles: ["ADMIN"] as Role[] },
        { label: "Statuses", href: "/admin/statuses", roles: ["ADMIN"] as Role[] },
        { label: "Cancel Reasons", href: "/admin/cancel-reasons", roles: ["ADMIN"] as Role[] },
        { label: "SLA", href: "/admin/sla", roles: ["ADMIN"] as Role[] },
        { label: "Activity Progress", href: "/admin/activity-progress", roles: ["ADMIN"] as Role[] },
        { label: "Activity Statuses", href: "/admin/activity-statuses", roles: ["ADMIN"] as Role[] },
        { label: "Email Settings", href: "/admin/email", roles: ["ADMIN"] as Role[] },
        { label: "Integrations", href: "/admin/integrations", roles: ["ADMIN"] as Role[] },
      ],
    },
  ];

  useEffect(() => {
    const owner = navItems.find(
      (item) => item.children?.some((c) => pathname === c.href || pathname.startsWith(c.href + "/"))
    );
    if (owner) setExpandedItems((prev) => (prev.includes(owner.label) ? prev : [...prev, owner.label]));
    // navItems is rebuilt every render from stable props; the pathname is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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

  const rowBase = "relative flex items-center gap-3 rounded text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring";
  const rowIdle = "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
  const rowActive = "bg-sidebar-accent text-white font-medium";

  return (
    <aside
      aria-label="Main navigation"
      className={cn(
        "min-h-screen flex flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 flex-shrink-0 overflow-hidden",
        // Phones get the rail width from the first paint; the effect above
        // then swaps in the rail markup, so there's no expanded flash.
        collapsed ? "w-16" : "w-64 max-md:w-16"
      )}
    >
      {/* Brand — the official white logo, cropped into a horizontal lockup. */}
      <div className={cn("h-14 flex items-center border-b border-sidebar-border", collapsed ? "justify-center" : "gap-3 pl-4 pr-2")}>
        {collapsed ? (
          <button
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            aria-expanded={false}
            title="Expand sidebar"
            className="group relative rounded p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <span className="group-hover:opacity-0 transition-opacity"><KinsenMark height={24} /></span>
            <PanelLeftOpen className="absolute inset-0 m-auto h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-white" />
          </button>
        ) : (
          <>
            <Link href="/dashboard" className="flex min-w-0 flex-1 items-end gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
              <KinsenLockup height={24} />
              <span className="pb-px text-xs font-medium text-sidebar-foreground whitespace-nowrap">IT Helpdesk</span>
            </Link>
            <button
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              aria-expanded={true}
              title="Collapse sidebar"
              className="rounded p-1.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-white transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {/* Navigation — sidebar-scroll gives this its own thin navy scrollbar
          (globals.css); spacing compacts on shorter viewports
          (maxh-800/maxh-700, tailwind.config.ts). */}
      <LayoutGroup id="sidebar">
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 maxh-700:py-2 sidebar-scroll">
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
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(rowBase, "justify-center", NAV_ICON_SIZE, active ? rowActive : rowIdle)}
                >
                  {active && <Notch />}
                  <item.icon className="h-[18px] w-[18px]" />
                </Link>
              );
            }

            if (hasChildren) {
              const visibleChildren = item.children!.filter((c) => canAccess(c));
              if (visibleChildren.length === 0) return null;
              // Computed once per section, from ALL visible siblings at once —
              // never per-child in isolation — so exactly one child (the most
              // specific href match, or none) is active. See resolveActiveHref's
              // own doc comment.
              const activeChildHref = resolveActiveHref(pathname, visibleChildren.map((c) => c.href));
              const sectionId = `nav-section-${item.label.replace(/\s+/g, "-").toLowerCase()}`;

              return (
                <div key={item.label}>
                  <button
                    onClick={() => toggleExpand(item.label)}
                    aria-expanded={isExpanded}
                    aria-controls={sectionId}
                    className={cn(
                      rowBase,
                      "w-full justify-between px-3 font-medium",
                      NAV_ITEM_SIZE,
                      activeChildHref ? "text-white" : rowIdle,
                      activeChildHref && "hover:bg-sidebar-accent"
                    )}
                  >
                    <span className="flex items-center gap-3">
                      <item.icon className="h-4 w-4 flex-shrink-0" />
                      {item.label}
                    </span>
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 opacity-70 transition-transform", isExpanded && "rotate-180")}
                      aria-hidden="true"
                    />
                  </button>
                  {isExpanded && (
                    <div id={sectionId} className="mt-0.5 mb-1 ml-[1.35rem] pl-3 border-l border-sidebar-border space-y-0.5">
                      {visibleChildren.map((child) => {
                        const childActive = child.href === activeChildHref;
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            aria-current={childActive ? "page" : undefined}
                            className={cn(rowBase, "px-3", NAV_CHILD_SIZE, childActive ? rowActive : rowIdle)}
                          >
                            {childActive && <Notch />}
                            {child.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(rowBase, "px-3 font-medium", NAV_ITEM_SIZE, active ? rowActive : rowIdle)}
              >
                {active && <Notch />}
                <item.icon className="h-4 w-4 flex-shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-2 border-t border-sidebar-border space-y-0.5">
          {collapsed ? (
            <>
              <Link
                href="/settings"
                title="Settings"
                aria-label="Settings"
                aria-current={isActive("/settings") ? "page" : undefined}
                className={cn(rowBase, "justify-center", NAV_ICON_SIZE, isActive("/settings") ? rowActive : rowIdle)}
              >
                {isActive("/settings") && <Notch />}
                <Settings className="h-[18px] w-[18px]" />
              </Link>
              <button
                type="button"
                onClick={toggleHelpGuide}
                title="Help Guide"
                aria-label="Help Guide"
                className={cn(rowBase, "w-full justify-center", NAV_ICON_SIZE, rowIdle)}
              >
                <BookOpen className="h-[18px] w-[18px]" />
              </button>
            </>
          ) : (
            <>
              <Link
                href="/settings"
                aria-current={isActive("/settings") ? "page" : undefined}
                className={cn(rowBase, "px-3", NAV_ITEM_SIZE, isActive("/settings") ? rowActive : rowIdle)}
              >
                {isActive("/settings") && <Notch />}
                <Settings className="h-4 w-4" />
                Settings
              </Link>
              <button
                type="button"
                onClick={toggleHelpGuide}
                className={cn(rowBase, "w-full px-3", NAV_ITEM_SIZE, rowIdle)}
              >
                <BookOpen className="h-4 w-4" />
                Help Guide
              </button>
            </>
          )}
        </div>
      </LayoutGroup>
    </aside>
  );
}
