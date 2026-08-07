/**
 * Sidebar active-route resolver (lib/sidebar-active-route.ts) — the fix for
 * two sibling nav items (e.g. "All Projects" and "New Project") both
 * lighting up simultaneously. Pure function, no React/DOM rendering
 * required — uses the ACTUAL child hrefs defined in
 * components/layout/sidebar.tsx for Tickets/Projects/Activities/My
 * Department/Administration, so this stays honest about the real routes,
 * not a synthetic example.
 *
 * Usage: npx tsx scripts/test-sidebar-active-route.ts
 */
import { resolveActiveHref } from "@/lib/sidebar-active-route";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// Exact hrefs from components/layout/sidebar.tsx's navItems.
const TICKET_HREFS = ["/tickets", "/tickets/assigned-to-me", "/tickets/created-by-me", "/tickets/new", "/tickets/pending", "/tickets/closed"];
const PROJECT_HREFS = ["/projects", "/my-projects", "/projects/new", "/projects/gantt", "/projects/resource-planning"];
const ACTIVITY_HREFS = ["/activities", "/my-activities", "/activities/gantt", "/activities/new"];
const MY_DEPARTMENT_HREFS = ["/my-departments", "/my-subdepartments"];
const ADMIN_HREFS = [
  "/admin/users", "/admin/roles", "/admin/companies", "/admin/business-units", "/admin/departments",
  "/admin/sub-departments", "/admin/microsoft-mappings", "/admin/categories", "/admin/priorities",
  "/admin/statuses", "/admin/cancel-reasons", "/admin/sla", "/admin/activity-progress",
  "/admin/activity-statuses", "/admin/email", "/admin/integrations",
];

function main() {
  console.log("\n=== Projects section ===\n");
  check("/projects -> only 'All Projects' (/projects) active", resolveActiveHref("/projects", PROJECT_HREFS) === "/projects");
  check("/projects/new -> only 'New Project' active, NOT /projects", resolveActiveHref("/projects/new", PROJECT_HREFS) === "/projects/new");
  check("/projects/gantt -> only 'Project Gantt' active", resolveActiveHref("/projects/gantt", PROJECT_HREFS) === "/projects/gantt");
  check("/projects/resource-planning -> only 'Resource Planning' active", resolveActiveHref("/projects/resource-planning", PROJECT_HREFS) === "/projects/resource-planning");
  check("/my-projects -> only 'My Projects' active", resolveActiveHref("/my-projects", PROJECT_HREFS) === "/my-projects");
  check("/projects/abc123 (detail page) -> falls back to 'All Projects' (parent list item)", resolveActiveHref("/projects/abc123", PROJECT_HREFS) === "/projects");
  check("/projects/abc123/edit -> still 'All Projects', not confused with any sibling", resolveActiveHref("/projects/abc123/edit", PROJECT_HREFS) === "/projects");

  console.log("\n=== Activities section ===\n");
  check("/activities -> only 'All Activities' (/activities) active", resolveActiveHref("/activities", ACTIVITY_HREFS) === "/activities");
  check("/activities/gantt -> only 'Activity Gantt' active, NOT /activities", resolveActiveHref("/activities/gantt", ACTIVITY_HREFS) === "/activities/gantt");
  check("/activities/new -> only 'New Activity' active", resolveActiveHref("/activities/new", ACTIVITY_HREFS) === "/activities/new");
  check("/my-activities -> only 'My Activities' active", resolveActiveHref("/my-activities", ACTIVITY_HREFS) === "/my-activities");
  check("/activities/abc123 (detail page) -> falls back to 'All Activities'", resolveActiveHref("/activities/abc123", ACTIVITY_HREFS) === "/activities");
  check("/activities/abc123/edit -> still 'All Activities'", resolveActiveHref("/activities/abc123/edit", ACTIVITY_HREFS) === "/activities");

  console.log("\n=== Tickets section (pre-existing, must not regress) ===\n");
  check("/tickets -> only 'All Tickets' active", resolveActiveHref("/tickets", TICKET_HREFS) === "/tickets");
  check("/tickets/new -> only 'Create Ticket' active, NOT /tickets", resolveActiveHref("/tickets/new", TICKET_HREFS) === "/tickets/new");
  check("/tickets/pending -> only 'Pending Tickets' active", resolveActiveHref("/tickets/pending", TICKET_HREFS) === "/tickets/pending");
  check("/tickets/assigned-to-me -> only itself active", resolveActiveHref("/tickets/assigned-to-me", TICKET_HREFS) === "/tickets/assigned-to-me");
  check("/tickets/closed -> only itself active", resolveActiveHref("/tickets/closed", TICKET_HREFS) === "/tickets/closed");
  check("/tickets/abc123 (detail page) -> falls back to 'All Tickets'", resolveActiveHref("/tickets/abc123", TICKET_HREFS) === "/tickets");

  console.log("\n=== My Department section ===\n");
  check("/my-departments -> only 'My Departments' active", resolveActiveHref("/my-departments", MY_DEPARTMENT_HREFS) === "/my-departments");
  check("/my-subdepartments -> only 'My SubDepartments' active, NOT /my-departments", resolveActiveHref("/my-subdepartments", MY_DEPARTMENT_HREFS) === "/my-subdepartments");

  console.log("\n=== Administration section ===\n");
  check("/admin/statuses -> only itself, not confused with /admin/activity-statuses", resolveActiveHref("/admin/statuses", ADMIN_HREFS) === "/admin/statuses");
  check("/admin/activity-statuses -> only itself, not confused with /admin/statuses", resolveActiveHref("/admin/activity-statuses", ADMIN_HREFS) === "/admin/activity-statuses");
  check("/admin/departments -> only itself, not confused with /admin/sub-departments", resolveActiveHref("/admin/departments", ADMIN_HREFS) === "/admin/departments");
  check("/admin/sub-departments -> only itself, not confused with /admin/departments", resolveActiveHref("/admin/sub-departments", ADMIN_HREFS) === "/admin/sub-departments");

  console.log("\n=== No two siblings ever active simultaneously (exhaustive per-section check) ===\n");
  for (const [name, hrefs] of [
    ["Tickets", TICKET_HREFS],
    ["Projects", PROJECT_HREFS],
    ["Activities", ACTIVITY_HREFS],
    ["My Department", MY_DEPARTMENT_HREFS],
    ["Administration", ADMIN_HREFS],
  ] as const) {
    for (const pathname of hrefs) {
      const activeCount = hrefs.filter((h) => h === resolveActiveHref(pathname, hrefs)).length;
      check(`${name}: exactly one sibling active for pathname=${pathname}`, activeCount === 1, `resolved=${resolveActiveHref(pathname, hrefs)}`);
    }
  }

  console.log("\n=== Edge cases ===\n");
  check("Unrelated pathname resolves to null (no section falsely highlighted)", resolveActiveHref("/dashboard", PROJECT_HREFS) === null);
  check("Empty candidate list resolves to null", resolveActiveHref("/projects", []) === null);
  check("Exact match wins even when a shorter prefix also matches", resolveActiveHref("/projects", ["/projects", "/proj"]) === "/projects");

  console.log(`\n==================================\n${passed} checks passed, ${failed} checks failed\n`);
  if (failed > 0) process.exit(1);
}

main();
