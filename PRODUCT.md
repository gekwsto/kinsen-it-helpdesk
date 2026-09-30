# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyone at Kinsen uses it. Design decisions are balanced across three groups; none of them outranks the others, and role-based navigation carries the difference:

- **Handlers**: IT agents and department staff who triage, assign, reply to, and close tickets, and who run activities. They are in the app for long stretches and move through lists and detail views repeatedly.
- **Requesters**: any Kinsen employee (a `@kinsen.gr` Microsoft account) who opens a ticket to a department and follows up on it. They come in occasionally and have no training.
- **Managers and department heads**: people who oversee workload and delivery through the dashboard, projects, Gantt charts, resource planning, goals, and SLA settings.

A fourth, smaller group is the **administrators**. They configure the organization, departments, roles and permissions, statuses, priorities, categories, SLA, email intake, integrations, and Microsoft mappings.

Users are Greek-speaking and work in an English-language interface. The Greek user guide (`docs/odigos-xristi.md`) explains the English screens.

## Product Purpose

Kinsen IT Helpdesk (also called "TicketApp" internally) is Kinsen's in-house workspace for support requests and departmental work. Employees send tickets to any department. Departments work those tickets and connect them to projects and activities. Managers plan and oversee this work in one place. The product succeeds when requests reach the right department, are handled visibly and on time, and every item of work stays linked to its origin and its people, with no juggling of separate tools.

## Positioning

- **One linked workspace.** Tickets, projects, activities, goals, Gantt charts, and resource planning live in one system and link to each other. Off-the-shelf tools split these across a helpdesk, a project tool, and a planner.
- **Shaped to Kinsen's organization.** It covers multiple companies, business units, departments, and sub-departments. Membership and placement sync from Microsoft Entra ID. Each department can have its own statuses, priorities, categories, cancel reasons, activity progress values, SLA, members, and roles.
- **Email intake with human review.** Department and central mailboxes feed a Pending queue, and a person accepts or rejects each item before it becomes a ticket. Rejected requests can be revived. A reply to an existing ticket (`[KIN-N]`) goes straight into that ticket's thread.
- **Owned in-house.** The system is self-hosted (Docker Compose, or Vercel) and controlled by Kinsen's own team, with no per-seat licences.

## Operating Context

- Sign-in uses Microsoft SSO (Entra ID). A secondary local email/password form exists for locally created (admin) accounts. Sessions last up to 8 hours.
- Users mostly work on office desktops and laptops. Mobile is secondary; web push notifications and a service worker exist.
- Updates are live: tickets, projects, activities, and notifications stream in (SSE routes), and the lists refresh themselves.
- Workspace concept: a user can belong to several departments or sub-departments and switches the active workspace. Filter behavior differs between modules. In Tickets, "no department filter" shows the union of all the user's departments. In Projects and the project Gantt, it shows the current workspace only.
- Collaboration features: @mentions in project and activity notes, with reminder notifications; internal notes; attachments; related links; dependencies.
- Tickets can come from the Web, from Email, or from an Integration (API keys under Admin → Integrations).

## Capabilities and Constraints

- **Stack (existing):** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS 3, shadcn/ui (Radix), lucide-react icons, Recharts, @xyflow/react (org chart), motion, sonner toasts, Prisma with PostgreSQL, next-auth v5.
- **Modules:** Dashboard; Tickets (All, Assigned to Me, Created by Me, Create, Pending, Rejected, Closed); Projects (list, Gantt, resource planning, My Projects); Activities (list, Gantt, My Activities); Goals; Organization chart; My Department / Sub-departments; Settings; the in-app Help Guide; Administration.
- **Permissions:** access is role- and permission-based per department. Navigation items and actions appear only when the user is allowed to use them.
- **Language:** the interface stays English-only for now. Greek localization is not planned in the current scope.
- **Desktop-first:** layouts are designed for desktop first and must still work on smaller screens (the sidebar collapses to icons).
- **Terminology in use:** Ticket, Pending / Rejected Ticket, Project (can be marked "a Goal"), Activity, Goal (personal yearly goals, separate from project goals), Department, Sub-Department, Business Unit, Company, Workspace, SLA, Agent, Source.
- **Known product gaps (from the user guide audit; not yet decided):** there is no in-app explanation of the Pending/Rejected flow, of the "Share with my department" options, of "SLA not configured", or of resource-planning load levels (they count assignments, not hours). The name "Goal" means two different things. "My Department" and "Organization" are easy to confuse.

## Brand Commitments

- Product name: **Kinsen IT Helpdesk** (title), also called **TicketApp** internally. Ticket references use the `KIN-N` format.
- Kinsen logo assets: `public/kinsen_logo_white.webp`, `public/kinsen_vertical.webp`, `kinsen_logo_white.webp` (root), `app/icon.svg`.
- Voice: plain, functional English in the UI. No other voice or identity commitments have been confirmed.

## Evidence on Hand

- User guide in Greek: `docs/odigos-xristi.md`.
- API reference: `docs/api/API_REFERENCE.md`. Operational and integration docs in `docs/` (email testing, mention reminders, Microsoft Graph and Entra audits, handoff register).
- There are no user research findings, satisfaction data, or usage metrics in the repo. Future work must not invent them.

## Product Principles

1. **Right place, first time.** Every request should reach the correct department with the least effort from the requester. The UI makes clear that the chosen department is where the request goes, not the requester's own department.
2. **Nothing gets lost.** Intake is reviewed rather than automatic, rejected items can be recovered, and every ticket, project, and activity stays traceable to its origin, owners, and history.
3. **One workspace, many roles.** The same system serves requesters, handlers, managers, and admins. Each person sees what they are permitted and need to see, and nothing that only adds noise.
4. **Mirror the real organization.** Structure, membership, and per-department configuration follow how Kinsen is actually organized and synced from Microsoft. The UI makes the scope (which department or workspace) visible wherever it changes what the user sees.
5. **Explain the non-obvious in place.** Where behavior differs between modules or depends on configuration, the interface says so at the point of use, not only in an external guide.
