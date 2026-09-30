---
name: Kinsen IT Helpdesk
description: Kinsen's internal workspace for requests, projects and activities, set in the Kinsen Mark.
colors:
  kinsen-teal: "#32C0C5"
  kinsen-navy: "#052E4A"
  link-teal: "#0A747A"
  cool-paper: "#F4F6F7"
  card-white: "#FFFFFF"
  ink: "#0D1B26"
  muted-ink: "#52616D"
  mist: "#E9EEF1"
  hairline: "#D9E0E5"
  field-edge: "#84929E"
  signal-red: "#C62828"
  rail-ink: "#C3D2DC"
  rail-active: "#0B3D60"
  rail-active-ink: "#E4ECF1"
  rail-hairline: "#0F4A73"
  night-field: "#07141E"
  night-card: "#0C1E2B"
  night-mist: "#132B3C"
  night-hairline: "#1C3A50"
  night-muted-ink: "#8EA0AE"
  night-field-edge: "#56708A"
  night-signal-red: "#F87171"
typography:
  headline:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  figure:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "\"tnum\" 1"
  title:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
  reference:
    fontFamily: "Commissioner, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    fontFeature: "\"tnum\" 1"
rounded:
  none: "0px"
  sm: "2px"
  md: "4px"
spacing:
  row-y: "10px"
  cell-x: "12px"
  card: "20px"
  strip-cell: "16px 20px"
components:
  button-primary:
    backgroundColor: "{colors.kinsen-teal}"
    textColor: "{colors.kinsen-navy}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.mist}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  button-link:
    textColor: "{colors.link-teal}"
  input:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "20px"
  nav-item:
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "40px"
  nav-item-active:
    backgroundColor: "{colors.rail-active}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.md}"
  sidebar:
    backgroundColor: "{colors.kinsen-navy}"
    textColor: "{colors.rail-ink}"
  ledger-row:
    textColor: "{colors.ink}"
    padding: "10px 12px"
  ledger-head:
    textColor: "{colors.muted-ink}"
    typography: "{typography.label}"
    height: "40px"
  reference-cell:
    textColor: "{colors.link-teal}"
    typography: "{typography.reference}"
---

# Design System: Kinsen IT Helpdesk

## Overview

**Creative North Star: "The Kinsen Mark"**

The Kinsen K, a square cut by two diagonals, is the product's only authored shape, and the palette is sampled straight from the logo asset (`public/kinsen_vertical.webp`). A navy rail carries the official white lockup in both themes; the work surface is cool paper in light and navy-black in dark. Teal is scarce on purpose: it lights only what is live or actionable, so a glance at any screen finds the one thing to press and the place you are.

The density is that of a working ledger. Lists are hairline-ruled tables hanging off a fixed KIN-N reference column, dashboard counts are one ruled strip rather than a row of icon cards, and breakdowns are ruled rows with a single neutral bar instead of pies. Status and priority are drawn as small marks with a shape (ring versus filled check, one to four level bars) beside neutral text, because department admins pick those colours freely and some of them are pale yellows.

The system was built to replace the stock shadcn admin look (slate neutrals, blue primary, stacked soft cards, pill badges tinted in the status colour). Commissioner, a Greek-designed grotesk, sets everything, because staff and department names are often Greek while the interface is English.

Coverage is partial. The shell, sign-in, dashboard and ticket screens were reworked by hand. Admin, projects, activities, goals and organization pages inherit the tokens and primitives but were not reworked, and they still contain hardcoded Tailwind palette classes, tinted priority pills and uppercase tracked labels. Those are drift for future passes to convert. They are not part of this system.

**Key Characteristics:**
- Navy rail, cool-paper (or navy-black) work surface, teal reserved for live and actionable things.
- One shape: the K mark's lower triangle, used as the "current place" notch and, at page scale, on the sign-in field.
- Hairline-ruled ledgers, tabular numerals, a fixed KIN-N reference column.
- Status and priority as shaped marks beside neutral text, never as tinted pills.
- Near-square corners (0 to 4px), flat surfaces, borders instead of shadows.
- Light, dark and system themes, applied before first paint.

## Colors

A two-colour brand (deep navy and bright teal from the logo) over cool blue-grey neutrals, with one red kept for destructive and attention signals.

### Primary
- **Kinsen Teal** (brand teal, `--primary` / `--brand-teal`): the fill of the one primary action per page, the active-place notch, the sign-in triangle, text selection (at 28% opacity), and link/focus colour in dark mode. On light surfaces it is a fill only: as text on white it measures 2.2:1.
- **Link Teal** (`--link`, `--ring` in light): the same hue deepened to carry teal as text on light surfaces (5.5:1 on white, 5.1:1 on cool paper). Every link, every KIN-N reference, the caret, and the focus ring in light mode.

### Secondary
- **Kinsen Navy** (`--brand-navy`, `--sidebar-background`): owns the sidebar rail in both themes, the sign-in brand field, the avatar fallback, and the text on teal buttons (6.3:1 on teal).

### Neutral
- **Cool Paper**: the light work-surface background behind cards and ledgers.
- **Card White**: cards, ledgers, inputs, popovers and the top bar in light mode.
- **Ink**: all body text and headings in light mode (16.1:1 on cool paper).
- **Muted Ink**: scope lines, column heads, metadata and empty cells (5.9:1 on cool paper, 6.4:1 on white).
- **Mist** (`--secondary`, `--muted`, `--accent`): hover fills on rows, ghost and outline buttons, count-strip cells, and breakdown bar tracks.
- **Hairline** (`--border`): every rule, divider and card edge.
- **Field Edge** (`--input`): input and outline-button strokes, set at 3.2:1 against white so field edges stay visible; also the scrollbar thumb at 50%.
- **Rail Ink / Rail Active / Rail Active Ink / Rail Hairline**: the sidebar's idle text (9.1:1 on navy), active and hover fill, active text, and internal dividers.
- **Night Field / Night Card / Night Mist / Night Hairline / Night Muted Ink / Night Field Edge**: the dark-theme counterparts. In dark mode `--link` and `--ring` return to Kinsen Teal (7.7:1 on night card).
- **Signal Red / Night Signal Red** (`--destructive`): destructive buttons and the attention icon on flagged counts (overdue, unassigned).

### Named Rules
**The Live-Only Rule.** Teal appears only on what is live or actionable: the primary action, links, the active nav item, the notch, focus. Never on headings, decoration, section fills or charts.

**The Deep-Teal-For-Text Rule.** Brand teal is never text on a light surface (2.2:1). Teal-coloured copy uses Link Teal in light mode; the dark theme may use brand teal directly.

**The Mark-Not-Paint Rule.** Admin-picked status, priority and category colours appear only as a mark (ring, filled check, level bars, 2px-cornered swatch) beside neutral ink text. They are never the text colour and never tint a pill background. The status-colour admin form shows the mark on both a light and a dark strip so admins can judge it in both themes.

## Typography

**Display Font:** none; the system has no display tier.
**Body Font:** Commissioner (via `next/font`, latin and greek subsets, `--font-sans`, falling back to system-ui, sans-serif)

**Character:** one grotesk at a few weights, carrying Greek names without a fallback seam. Every table cell sets tabular numerals, so counts, references and dates align by column.

### Hierarchy
- **Headline** (700, 1.5rem, tight tracking, balanced wrap): the page title in PageHeader, once per screen.
- **Figure** (700, 1.5rem, line-height 1, tabular): count-strip numbers.
- **Title** (600, 1rem): card and section titles, breakdown titles.
- **Body** (400, 0.875rem): ledger cells, form text, thread bodies, the PageHeader scope line in Muted Ink.
- **Label** (500, 0.75rem): column heads, status and priority mark labels, metadata, count-strip labels; sentence case.
- **Reference** (600, 0.875rem, tabular, Link Teal): the KIN-N ticket reference that anchors every ticket row.

### Named Rules
**The Tabular Rule.** Numerals in tables, counts and references are tabular (`td, th` set it globally; figures opt in with `tabular-nums`).

**The Sentence-Case Label Rule.** Labels and column heads are small, medium-weight, sentence case. Enum values are title-cased for display ("URGENT" becomes "Urgent").

## Layout

A fixed navy rail on the left (expanded with lockup, or collapsed to an icon rail; phones always start collapsed) and a sticky 56px top bar in card colour with global search, the theme switch and the account menu. The rail compacts its row heights on short viewports (max-height 800px and 700px) rather than scrolling.

Every core screen opens with one PageHeader: the title with a single scope line beneath it, and at most one primary action at top right, bottom-aligned with the title and wrapping below it on narrow widths. Content below is ledgers, a count strip, and ruled breakdown cards.

Ledgers keep the reference and subject columns at every width and progressively reveal Status and Priority (md), Category, Department, Assignee and Created (lg), and Project (2xl). On narrow widths the hidden status, priority and requester facts collapse into a metadata line under the subject. Cell rhythm is 12px horizontal by 10px vertical under 40px heads; cards pad 20px; count-strip cells pad 16px by 20px. The count strip is two columns on phones and one row on large screens, with an odd last cell spanning the row.

## Elevation & Depth

Flat. Work surfaces sit on cool paper separated by 1px hairlines and a 2px-cornered card edge, not by shadow. Depth comes from tone (paper, card, mist) and from the navy rail. Shadows appear only on transient overlays (dropdown menus, selects, dialogs, tooltips, toasts), where they come with the component primitives.

### Named Rules
**The Hairline-Not-Shadow Rule.** Resting surfaces separate by rules and borders. A shadow means the element floats above the page and will go away.

## Shapes

Near-square. The base radius is 4px, used on buttons, inputs and nav rows; cards and ledger frames use 2px; badges and the scrollbar thumb are square; category swatches round by 1px. The only curves are the status ring and check, which are circles because they are marks.

The authored geometry is the K mark's lower teal triangle. As the **notch** (a right-pointing triangle, 8 by 14px, clipped `polygon(0 0, 100% 50%, 0 100%)`, filled Kinsen Teal) it sits on the left edge of the current place: the active nav item, the ledger row under the pointer or keyboard focus, and the hovered count-strip cell. At page scale, on the sign-in navy field, the same triangle stands apex up at its measured 2:1 base-to-height ratio, anchored bottom right.

**The One-Shape Rule.** The triangle is the system's only decorative form, and it always means "you are here". It never appears as an ornament, bullet or divider.

## Components

### Buttons
Quiet and square, with one loud one per page.
- **Shape:** gently squared corners (4px); 36px tall by default, 32px small, 40px large; 14px medium label; icons 16px.
- **Primary:** Kinsen Teal fill with Kinsen Navy text; hover drops the fill to 90%. One per PageHeader.
- **Outline:** card-coloured fill with a Field Edge stroke; hover fills Mist. The default for secondary actions.
- **Ghost / Secondary:** no fill until hover (Mist), or a Mist fill.
- **Link:** Link Teal text, underline on hover (3px offset site-wide).
- **Destructive:** Signal Red fill, white text.
- **Focus:** a 2px ring in `--ring` with a 2px offset; disabled is 50% opacity.

### Status and Priority Marks
The single language for state across tickets, projects and activities.
- **Status:** a 12px mark beside 12px medium ink text. Open statuses draw a ring with a centre dot; closed or terminal statuses draw a filled disc with a white check. A plain dot variant exists only for tight rows, and must sit beside visible text.
- **Priority:** four ascending level bars (filled to the rank, 1 to 4; unfilled bars in Hairline) beside the label.
- **Category / owner:** an 8px swatch with a 1px corner beside the name.
- **Readable fill:** where an admin colour must carry text (Gantt bars), text is chosen by `readableTextOn` (ink or white, whichever contrasts better).

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** Card White (Night Card in dark).
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px Hairline.
- **Internal Padding:** 20px; a header row may pull a ruled list flush to the edges.

### Inputs / Fields
- **Style:** 36px tall, 4px corners, card fill, 1px Field Edge stroke (at least 3:1), 14px text, Muted Ink placeholder. The caret is Link Teal.
- **Focus:** a 2px `--ring` ring with a 2px offset, no glow.
- **Disabled:** 50% opacity, not-allowed cursor. Number inputs hide their spinners.

### Navigation
- **Rail:** Kinsen Navy, 56px lockup header cut from the official white logo (mark plus wordmark, never redrawn), Rail Hairline dividers, a thin translucent scrollbar.
- **Rows:** 14px, 16px icons, Rail Ink at rest; hover and active fill Rail Active; active text turns white and medium. Child links hang off a Rail Hairline guide line.
- **Current place:** the notch sits on the active row's left edge and slides between rows via a shared layout animation (spring, stiffness 520, damping 42; instant under reduced motion).

### Ruled Ledger (signature)
The shape of every core list.
- A single 2px-cornered bordered frame on card colour; rows divided by 1px hairlines, never separate cards.
- The first column is the KIN-N reference in the Reference style (Link Teal, semibold, tabular), fixed at every width.
- Hovered or focused rows fill with Mist at 60% and carry the notch, which slides from row to row within the ledger.
- Column heads are Label style in Muted Ink; sortable heads toggle in place. Empty cells show an em dash in Muted Ink; "Unassigned" is written, not blank.

### Count Strip and Breakdown List (signature)
- **Count strip:** one bordered module of hairline-divided cells, each a link to exactly the list it counts: Label, Figure, and a Muted Ink sub-line. A red attention icon appears beside non-zero overdue or unassigned counts. The notch fades in on hover and focus.
- **Breakdown list:** a card of ruled rows: mark plus neutral label, tabular count, and one 6px bar in 60% ink scaled to the largest row. The bar never carries meaning through hue.

### Gantt Bars
Status bars use a deepened, system-owned palette (blue, slate, amber, violet, red, emerald and grey at the 700 step, or 500 for grey) so their white 10px labels clear 4.5:1. Each bar also carries a status glyph (Planning, To Do, In Progress, On Hold, Blocked, Completed, Cancelled each have their own) so colour is never the only signal.

### Theme
Light, dark and system, stored as `kinsen-theme` and applied by an inline script before first paint so dark never flashes light. The rail and sign-in field stay navy in both themes.

## Do's and Don'ts

### Do:
- **Do** give every core screen one PageHeader: title, one scope line, at most one teal primary action at top right.
- **Do** draw status as ring (open) or filled check (closed), and priority as one to four level bars, each beside neutral ink text.
- **Do** use Link Teal for teal text on light surfaces; keep brand teal for fills, the notch and dark-mode text.
- **Do** build lists as hairline-ruled ledgers anchored by the KIN-N reference column, hiding secondary columns by breakpoint and folding their facts into a line under the subject.
- **Do** mark the current place with the notch and let it slide; make it instant under reduced motion.
- **Do** set counts, references and table numerals in tabular figures.
- **Do** keep text pairings at 4.5:1 or better and field and outline strokes at 3:1 or better, in both themes.

### Don't:
- **Don't** set brand teal as text on white or cool paper (2.2:1).
- **Don't** use an admin-picked colour as text colour or as a tinted pill background.
- **Don't** let colour be the only signal for a status, priority or Gantt bar.
- **Don't** stack soft shadowed cards for list items, or put a row of separate icon cards where a count strip belongs.
- **Don't** use teal for headings, decoration, chart series or section fills.
- **Don't** use the triangle as an ornament; it marks the current place only.
- **Don't** redraw the Kinsen mark or re-set the wordmark in another face; crop the official asset.
- **Don't** return to the stock shadcn look: slate neutrals, a blue primary, large rounded corners, tinted pill badges.
