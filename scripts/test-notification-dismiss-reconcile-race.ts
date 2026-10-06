/**
 * Regression coverage for a real race reported live: dismissing a
 * notification (the per-row "x") right after opening the bell dropdown
 * could make it reappear and look "stuck" until a manual page refresh.
 *
 * Root cause: components/notifications/notification-dropdown.tsx refetches
 * notifications on every dropdown open ("staleness guard"). Opening the
 * dropdown is usually the very action right before dismissing an item, so
 * that GET can still be in flight when the item's own DELETE fires. If the
 * GET resolves AFTER the optimistic local delete but BEFORE the DELETE
 * itself commits server-side, the old (plain) applyReconcile — a
 * destructive full replace — resurrected the just-dismissed item from the
 * stale response. The underlying DELETE still succeeded moments later, so
 * a manual refresh "fixed" it — exactly matching the reported symptom.
 *
 * Fix: lib/notifications/notification-state.ts's new
 * applyReconcileExcluding masks out any id (or everything, for Clear All)
 * the component still has an in-flight DELETE for, so a racing GET can
 * never resurrect something the user just dismissed.
 *
 * Usage: npx tsx scripts/test-notification-dismiss-reconcile-race.ts
 * (no DB/server required — pure function tests only.)
 */
import {
  EMPTY_NOTIFICATION_STATE,
  applyNotificationCreated,
  applyMarkRead,
  applyMarkAllRead,
  applyDeleted,
  applyClearAll,
  applyReconcile,
  applyReconcileExcluding,
  type NotificationState,
  type NotificationItem,
} from "@/lib/notifications/notification-state";

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

function item(id: string, isRead: boolean): NotificationItem {
  return { id, title: `title-${id}`, body: `body-${id}`, link: null, isRead, createdAt: new Date().toISOString() };
}

console.log("\n=== 1. The exact reported race: dismiss an unread item while a reconcile GET is still in flight ===\n");
{
  const a = item("a", false);
  const b = item("b", true);
  const serverSnapshotStillHasA: NotificationState = { items: [a, b], unreadCount: 1 };

  // The component's own sequence: optimistic delete first (local state no
  // longer matters here — applyReconcileExcluding only looks at the
  // fetched payload + the pending-id set), then the stale GET response
  // (still containing "a", since its own DELETE hadn't committed yet when
  // that GET was issued) lands and gets reconciled.
  const pendingDeletedIds = new Set(["a"]);
  const reconciled = applyReconcileExcluding(serverSnapshotStillHasA, pendingDeletedIds, false);

  check("Masks out the in-flight-deleted id even though the server snapshot still has it", !reconciled.items.some((n) => n.id === "a"));
  check("Keeps every other item untouched", reconciled.items.some((n) => n.id === "b"));
  check("unreadCount is recomputed from the filtered items, not trusted from the stale payload", reconciled.unreadCount === 0);
}

console.log("\n=== 2. Once the DELETE's own request settles, the component clears the id — reconcile then behaves exactly like plain applyReconcile ===\n");
{
  const b = item("b", true);
  const serverSnapshotNowCorrect: NotificationState = { items: [b], unreadCount: 0 };
  const reconciled = applyReconcileExcluding(serverSnapshotNowCorrect, new Set(), false);
  check("No pending ids -> behaves identically to a plain fetch reconcile", reconciled.items.length === 1 && reconciled.items[0].id === "b");
  check("Reference-shape matches applyReconcile's own passthrough for the empty-set case", JSON.stringify(reconciled) === JSON.stringify(applyReconcile(serverSnapshotNowCorrect)));
}

console.log("\n=== 3. The same race for 'Clear All': a GET in flight during a Clear All DELETE must never repopulate the list ===\n");
{
  const serverSnapshotStillPopulated: NotificationState = { items: [item("a", false), item("b", false)], unreadCount: 2 };
  const reconciled = applyReconcileExcluding(serverSnapshotStillPopulated, new Set(), true);
  check("excludeAll forces the empty state regardless of what the stale GET returned", reconciled.items.length === 0 && reconciled.unreadCount === 0);
}

console.log("\n=== 4. Multiple simultaneous in-flight deletes are all masked, not just the most recent one ===\n");
{
  const serverSnapshot: NotificationState = { items: [item("a", false), item("b", false), item("c", true)], unreadCount: 2 };
  const reconciled = applyReconcileExcluding(serverSnapshot, new Set(["a", "b"]), false);
  check("Both in-flight-deleted ids are masked", reconciled.items.length === 1 && reconciled.items[0].id === "c");
  check("unreadCount reflects only the surviving, still-read item", reconciled.unreadCount === 0);
}

console.log("\n=== 5. A reconcile with no pending deletes/clear and an empty fetched list is still a true empty state ===\n");
{
  const reconciled = applyReconcileExcluding(EMPTY_NOTIFICATION_STATE, new Set(), false);
  check("Empty payload reconciles to empty state", reconciled.items.length === 0 && reconciled.unreadCount === 0);
}

console.log("\n=== 6. Existing reducers are untouched by this fix — regression guard ===\n");
{
  const state: NotificationState = { items: [item("a", false)], unreadCount: 1 };
  check("applyMarkRead still works", applyMarkRead(state, "a").unreadCount === 0);
  check("applyMarkAllRead still works", applyMarkAllRead(state).items.every((n) => n.isRead));
  check("applyDeleted still works standalone (component's own optimistic step, unchanged)", applyDeleted(state, "a").items.length === 0);
  check("applyClearAll still works standalone", applyClearAll(state).items.length === 0);
  check("applyNotificationCreated dedupe still works", applyNotificationCreated(state, item("a", false)).items.length === 1);
  check("Plain applyReconcile (still exported, still used by nothing else) is untouched passthrough behavior", applyReconcile(state) === state);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
