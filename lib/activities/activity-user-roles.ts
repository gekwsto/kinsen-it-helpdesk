export interface ActivityUserRolesContext {
  /** ProjectActivity.owner — request-origin-only, null/undefined for a manual or legacy Activity. */
  owner?: { id: string } | null;
  /** ProjectActivity.assignedUsers — the many-to-many "Related Users" relation, set on any Activity. */
  assignedUsers: { id: string }[];
}

/**
 * The ONE place resolving which role(s) a given user holds on a specific
 * Activity — "Assigned To" and/or "Owner" — so ProjectActivitiesCard,
 * ProjectActivitySequenceCard, and the Activity detail page never each grow
 * their own copy of this logic. A person who is BOTH an assignee and the
 * Owner gets both labels, in this fixed order; a person who holds neither
 * (shouldn't normally happen for a rendered avatar, but defensively
 * possible) gets an empty array rather than a fabricated role.
 */
export function resolveActivityUserRoles(activity: ActivityUserRolesContext, userId: string): string[] {
  const roles: string[] = [];
  if (activity.assignedUsers.some((u) => u.id === userId)) roles.push("Assigned To");
  if (activity.owner?.id === userId) roles.push("Owner");
  return roles;
}
