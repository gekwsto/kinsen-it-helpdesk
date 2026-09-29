/**
 * Regression coverage for making the Project List's "Priority" column use
 * the EXACT same small colored badge as the Activity List's "Priority"
 * column, instead of its previous large two-line outlined "Priority {Label}"
 * pill.
 *
 * The badge was extracted from its previous inline JSX in
 * components/activities/activity-list.tsx into a new shared component,
 * components/shared/priority-badge.tsx (<PriorityBadge> + the single
 * PRIORITY_COLORS mapping, same convention as components/shared/
 * member-preview.tsx). components/activities/activity-card.tsx (the Card/
 * grid-view badge, deliberately different and untouched visually) now
 * imports PRIORITY_COLORS from that same shared module instead of defining
 * its own copy — there is exactly ONE color mapping in the codebase now,
 * not two independent ones.
 *
 * TESTING APPROACH: PriorityBadge has no "use client" pragma and uses no
 * hooks, so — unlike most of this codebase's Client Components — it can be
 * called directly as a plain function and its returned React element
 * inspected structurally (className, children), without needing a DOM or a
 * source-text-only proxy. SECTION A does exactly that: it proves the same
 * priority VALUE produces an IDENTICAL element (className + label) whether
 * it arrives via Activity's own enum or via Project's Int->enum mapping.
 * SECTION B is the established source-text guard for the two (actual
 * Client Component) list views' wiring — which cell calls it, which don't,
 * and that the grid/card views were left alone.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-project-priority-activity-parity.ts
 */
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  const { PriorityBadge, PRIORITY_COLORS } = await import("@/components/shared/priority-badge");
  const { PROJECT_PRIORITY_LABEL, projectPriorityKey } = await import("@/lib/project-priority");
  const { ActivityPriority } = await import("@prisma/client");

  // ══════════════════════ SECTION A — PriorityBadge, called directly (pure function) ══════════════════════
  console.log("\n=== SECTION A — PriorityBadge is a pure function: same priority VALUE -> IDENTICAL element ===\n");

  function render(priority: any) {
    const el: any = PriorityBadge({ priority });
    return { type: el.type, className: el.props.className as string, children: el.props.children };
  }

  for (const value of Object.values(ActivityPriority)) {
    const el = render(value);
    check(`"${value}": renders a <span> with PRIORITY_COLORS["${value}"] classes`, el.type === "span" && el.className === `text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_COLORS[value]}`);
    check(`"${value}": label is the RAW enum value itself, no "Priority" prefix, no extra text`, el.children === value);
  }

  console.log("\n=== Requirement 2: identical Project vs. Activity priority value -> visually identical badge ===\n");
  for (const [projectLevel, expectedActivityValue] of [[1, ActivityPriority.LOW], [2, ActivityPriority.MEDIUM], [3, ActivityPriority.HIGH]] as const) {
    const mappedKey = projectPriorityKey(projectLevel);
    check(`projectPriorityKey(${projectLevel}) === ActivityPriority.${expectedActivityValue}`, mappedKey === expectedActivityValue);
    const projectEl = render(mappedKey);
    const activityEl = render(expectedActivityValue);
    check(`Project priority ${projectLevel} and Activity priority "${expectedActivityValue}" render the EXACT same className`, projectEl.className === activityEl.className);
    check(`...and the exact same label text ("${expectedActivityValue}", not "${PROJECT_PRIORITY_LABEL[projectLevel]}")`, projectEl.children === expectedActivityValue && projectEl.children !== PROJECT_PRIORITY_LABEL[projectLevel]);
  }

  console.log("\n=== Requirement 3: null/out-of-range priority -> clean empty state, never a crash ===\n");
  const outOfRangeKey = projectPriorityKey(4 as any);
  check("projectPriorityKey(4) (legacy/out-of-range value) resolves to null", outOfRangeKey === null);
  const emptyEl = render(null);
  check("PriorityBadge(null): renders a plain muted <span>, not a colored pill", emptyEl.type === "span" && emptyEl.className === "text-xs text-muted-foreground");
  check("PriorityBadge(null): shows a clean em-dash, not \"undefined\"/a crash", emptyEl.children === "—");

  console.log("\n=== No line-break: always exactly ONE inline text node inside ONE <span>, never nested block children ===\n");
  for (const value of Object.values(ActivityPriority)) {
    const el = render(value);
    check(`"${value}": children is a single string (never an array/nested element that could wrap to 2 lines)`, typeof el.children === "string");
  }
  check("Empty state: children is also a single string", typeof emptyEl.children === "string");

  console.log("\n=== Exactly ONE color mapping in the codebase — not two independent ones ===\n");
  const priorityBadgeSrc = await fs.readFile("components/shared/priority-badge.tsx", "utf8");
  const activityCardSrc = await fs.readFile("components/activities/activity-card.tsx", "utf8");
  check("components/shared/priority-badge.tsx is the sole DEFINITION of PRIORITY_COLORS", /export const PRIORITY_COLORS: Record<ActivityPriority, string> = \{/.test(priorityBadgeSrc));
  check("activity-card.tsx no longer DEFINES its own PRIORITY_COLORS object — it imports/re-exports the shared one", !/export const PRIORITY_COLORS: Record<ActivityPriority, string> = \{/.test(activityCardSrc) && /import \{ PRIORITY_COLORS \} from "@\/components\/shared\/priority-badge"/.test(activityCardSrc));
  check("activity-card.tsx's own Card-view priority badge markup is UNCHANGED (still Badge variant=\"outline\" border-0, a deliberately different visual this task does not touch)", /<Badge variant="outline" className=\{`text-xs border-0 \$\{PRIORITY_COLORS\[activity\.priority\]\}`\}>/.test(activityCardSrc));

  // ══════════════════════ SECTION B — wiring: which cell calls it, which don't ══════════════════════
  console.log("\n=== SECTION B — List-view wiring: both lists' Priority cell now calls the SAME <PriorityBadge>; grid/cards untouched ===\n");

  const projectListSrc = await fs.readFile("components/projects/project-list.tsx", "utf8");
  const activityListSrc = await fs.readFile("components/activities/activity-list.tsx", "utf8");

  check("ProjectList imports PriorityBadge from the shared module", /import \{ PriorityBadge \} from "@\/components\/shared\/priority-badge"/.test(projectListSrc));
  check("ActivityList imports PriorityBadge from the shared module too — the SAME import, not a second copy", /import \{ PriorityBadge \} from "@\/components\/shared\/priority-badge"/.test(activityListSrc));

  check("ProjectList's List-view Priority cell renders <PriorityBadge priority={projectPriorityKey(project.priority)} />", /<PriorityBadge priority=\{projectPriorityKey\(project\.priority\)\} \/>/.test(projectListSrc));
  check("ActivityList's List-view Priority cell renders <PriorityBadge priority={activity.priority} />", /<PriorityBadge priority=\{activity\.priority\} \/>/.test(activityListSrc));

  console.log("\n=== Requirement: the extra \"Priority\" label is gone from the Project List row ===\n");
  const projectListTableSection = projectListSrc.slice(projectListSrc.indexOf('if (view === "list")'), projectListSrc.indexOf('return (\n    <div className="grid gap-4 md:grid-cols-2'));
  check("The List-view branch of project-list.tsx never renders the literal text \"Priority \" before a value anymore", !/Priority \{PRIORITY_LABELS\[project\.priority\]\}/.test(projectListTableSection));
  check("...and never wraps the priority in the old outlined <Badge> either, within the List branch", !/<Badge variant="outline" className="text-xs">\s*Priority/.test(projectListTableSection));

  console.log("\n=== Priority header stays SortableTableHead with the SAME sortKey, in both lists ===\n");
  check("ProjectList: Priority header is still <SortableTableHead sortKey=\"priority\">", /<SortableTableHead sortKey="priority">Priority<\/SortableTableHead>/.test(projectListSrc));
  check("ActivityList: Priority header is still <SortableTableHead sortKey=\"priority\"> too (unchanged, for comparison)", /<SortableTableHead sortKey="priority">Priority<\/SortableTableHead>/.test(activityListSrc));

  console.log("\n=== Project grid/cards remain completely untouched ===\n");
  const projectGridStart = projectListSrc.indexOf('return (\n    <div className="grid gap-4 md:grid-cols-2');
  const projectGridSection = projectListSrc.slice(projectGridStart);
  check("Project grid/card branch still renders the OLD outlined 'Priority {Label}' Badge, exactly as before — this task never touched it", /<Badge variant="outline" className="text-xs">\s*Priority \{PRIORITY_LABELS\[project\.priority\]\}/.test(projectGridSection));
  check("Project grid/card branch never references the new <PriorityBadge> component", !/<PriorityBadge/.test(projectGridSection));
  check("PROJECT_PRIORITY_LABEL (PRIORITY_LABELS) import is still present — still needed by the untouched grid view", /PROJECT_PRIORITY_LABEL as PRIORITY_LABELS/.test(projectListSrc));

  console.log("\n=== Activity Card/grid view remains completely untouched ===\n");
  check("ActivityCard's own priority Badge markup is unchanged (already re-verified above via its own PRIORITY_COLORS re-export check)", /activity\.priority\]\}`\}>\s*\{activity\.priority\}/.test(activityCardSrc.replace(/\s+/g, " ").replace(/ /g, "")) || /\{activity\.priority\}/.test(activityCardSrc));
  const activityGridStart = activityListSrc.indexOf("// Grid view");
  check("ActivityList's own grid branch still renders ActivityCard, untouched by this task", activityGridStart > -1 && /<ActivityCard/.test(activityListSrc.slice(activityGridStart)));

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
