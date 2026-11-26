/**
 * Server-snapshot reconciliation for the drag-and-drop timelines (Project
 * Gantt and Resource Planning, Actual and Expected modes). Each component
 * keeps an optimistic local copy of its items; whenever a fresh server
 * snapshot arrives (router.refresh()), this decides per item whether the
 * server copy replaces the local one.
 *
 * The local copy is kept only when the server copy is provably not yet
 * authoritative for it:
 *   - `pending`: a mutation for the item is still in flight (optimistic).
 *   - `confirmed`: our mutation succeeded, and the PATCH response gave the
 *     record's committed `updatedAt`. A snapshot whose own `updatedAt` is
 *     OLDER was rendered before that write committed (a slow/stale refresh)
 *     and must not overwrite it. Once a snapshot carries an `updatedAt` at
 *     or after ours, the server has caught up — or holds someone else's
 *     newer change — so the confirmation is dropped and the server wins.
 * A snapshot without `updatedAt` is never treated as stale (server wins, as
 * before).
 */
export interface TimelineReconcileState {
  pending: Set<string>;
  /** id → committed updatedAt (ISO) from our own successful PATCH response. */
  confirmed: Map<string, string>;
}

export function isStaleSnapshot(serverUpdatedAt: string | null | undefined, confirmedUpdatedAt: string | undefined): boolean {
  if (!serverUpdatedAt || !confirmedUpdatedAt) return false;
  return Date.parse(serverUpdatedAt) < Date.parse(confirmedUpdatedAt);
}

/** True → keep the local copy of `id`; false → take the server copy (clearing a confirmation the snapshot has caught up with). */
export function shouldKeepLocal(id: string, serverUpdatedAt: string | null | undefined, state: TimelineReconcileState): boolean {
  if (state.pending.has(id)) return true;
  const mine = state.confirmed.get(id);
  if (!mine) return false;
  if (isStaleSnapshot(serverUpdatedAt, mine)) return true;
  state.confirmed.delete(id);
  return false;
}

/** Records the committed updatedAt from a successful PATCH response body (no-op when absent). */
export function recordConfirmedWrite(state: TimelineReconcileState, id: string, responseBody: unknown): void {
  const updatedAt = (responseBody as { updatedAt?: unknown } | null)?.updatedAt;
  if (typeof updatedAt === "string") state.confirmed.set(id, updatedAt);
}
