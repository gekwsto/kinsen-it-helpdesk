import { ActivityPriority } from "@prisma/client";

/**
 * Project.priority is a plain Int (1=Low, 2=Medium, 3=High — a legacy value
 * of 4 is clamped to 3 elsewhere, see app/(main)/projects/[id]/edit),
 * a completely different value space from ActivityPriority's LOW/MEDIUM/
 * HIGH/URGENT string enum. Single source of truth for both directions of
 * that mapping — was previously duplicated as a local PRIORITY_LABELS
 * const in components/projects/project-list.tsx.
 *
 * Real model gap, deliberately NOT hidden behind an "arbitrary" mapping:
 * this Int<->enum correspondence is a fixed, TYPE-LEVEL fact of the schema
 * (a 3-level scale mapped onto a 4-level one), not a business rule that
 * could ever legitimately vary per department — no department would want
 * "Project priority 1" to mean HIGH in one place and LOW in another, so
 * unlike terminal-status (lib/status-terminal.ts) or priority ORDER/
 * ENABLEMENT (lib/priority-config.ts, ActivityPriorityConfig), this
 * specific correspondence is intentionally NOT part of the department-
 * scoped configuration system — making it "configurable" would invent a
 * knob nobody could sensibly turn. What IS genuinely department-scoped
 * (the ORDER those keys are offered in, and whether each is enabled at
 * all) comes from lib/priority-config.ts, same as it does for a real
 * ActivityPriority value. The actual fix, if full unification is ever
 * wanted, is a schema migration changing Project.priority's TYPE to
 * ActivityPriority directly — out of scope here: it touches project
 * creation/edit forms, validation schemas, and every existing Int-typed
 * read of Project.priority across the app, a much larger blast radius than
 * this filter's own ordering bug.
 *
 * projectPriorityKey maps a Project's Int priority onto the SAME string
 * keys ActivityPriority uses, so the Project Gantt's single Priority filter
 * (components/gantt/gantt-chart.tsx) can apply one option list (itself
 * sourced from ActivityPriorityConfig, see lib/priority-config.ts) to both
 * project rows and activity rows. Project priority has no URGENT
 * equivalent — selecting URGENT simply never matches a project directly
 * (the project row can still surface via a matching child activity, same as
 * the existing Status filter's own "group survives via matching children"
 * rule). A project mapped to a priority currently DISABLED for its
 * department still renders with that priority normally; it's just never
 * reachable via the filter's own dropdown (see buildPriorityFilterOptions).
 */
export const PROJECT_PRIORITY_LABEL: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
};

export function projectPriorityKey(priority: number): ActivityPriority | null {
  switch (priority) {
    case 1: return ActivityPriority.LOW;
    case 2: return ActivityPriority.MEDIUM;
    case 3: return ActivityPriority.HIGH;
    default: return null;
  }
}
