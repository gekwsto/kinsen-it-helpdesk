---
version: 1
slug: "app-main-layout-tsx"
primary_target: "app/(main)/layout.tsx"
related_targets: ["app/(auth)/login/page.tsx","app/(main)/dashboard/page.tsx","app/(main)/tickets/page.tsx","app/(main)/tickets/[id]/page.tsx","app/(main)/tickets/new/page.tsx"]
---

# App shell and core screens

Scope: the authenticated app shell (sidebar, top bar), shared primitives and tokens, plus login, dashboard, ticket lists, ticket detail and new ticket. Every other page inherits the foundation. Mode: Operate.
Audience: handlers, requesters, managers and admins in equal measure (see PRODUCT.md), on office desktops in daylight, for long sessions.
Pinned: Kinsen logo and teal, the left sidebar with its menu structure, a working light/dark switch. SLA visibility is out of scope.

## Direction contract

THESIS: The Kinsen K, a square cut by two diagonals, is the product's only shape. Refuse the default admin (slate, blue primary, stacked soft cards).
OWN-WORLD: Navy #052E4A owns the sidebar in both themes. Work surfaces are cool paper in light and navy-black in dark. Teal #32C0C5 appears only on what is live or actionable: the primary action, links, the active nav item, focus. Lists are hairline-ruled ledgers, not cards. The typeface is Commissioner, set with tabular numerals. Status is a coloured mark plus a shape glyph beside neutral text, and priority is a set of level bars.
STORY: A handler sees, in one pass, which of their departments' tickets are open, whose they are and what state they're in. A requester sees where their request went and what happens next.
FIRST VIEWPORT: Navy rail with the logo lockup, and a top bar with search and the theme switch. The page title sits with its scope line, and the one teal primary action is at the top right. The ruled ledger hangs off a fixed KIN-N reference column.
FORM: The Kinsen Mark, item 5 of the grounded list; seed 4f87ce90. Signature interaction: the active nav item and the selected row carry the logo's teal triangle notch, which slides between items.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
