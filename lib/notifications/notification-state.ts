/**
 * Pure, framework-independent state transitions for the notification
 * bell/dropdown — extracted out of components/notifications/notification-dropdown.tsx
 * so the exact merge/dedupe/count logic is directly unit-testable without a
 * DOM or React (this repo's test scripts are plain Node/Prisma, no
 * jsdom/RTL), and so the component itself stays a thin binding layer over
 * these functions.
 */

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationState {
  items: NotificationItem[];
  unreadCount: number;
}

export const EMPTY_NOTIFICATION_STATE: NotificationState = { items: [], unreadCount: 0 };

/**
 * Merge a realtime NOTIFICATION_CREATED payload into existing state.
 * Deduplicates by stable id (an initial fetch + a realtime event for the
 * same notification racing each other, in either order, must never produce
 * two entries), prepends (the payload is always the newest — createdAt
 * order is preserved), and increments the unread count only when the
 * incoming notification isn't already present AND is actually unread.
 */
export function applyNotificationCreated(
  state: NotificationState,
  notification: NotificationItem
): NotificationState {
  if (state.items.some((n) => n.id === notification.id)) return state;
  return {
    items: [notification, ...state.items],
    unreadCount: notification.isRead ? state.unreadCount : state.unreadCount + 1,
  };
}

/** Local optimistic mark-read — the badge must update immediately, before the PATCH request resolves. A no-op if the id is unknown or already read (never double-decrements). */
export function applyMarkRead(state: NotificationState, id: string): NotificationState {
  const target = state.items.find((n) => n.id === id);
  if (!target || target.isRead) return state;
  return {
    items: state.items.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    unreadCount: Math.max(0, state.unreadCount - 1),
  };
}

/** Local optimistic mark-all-read — badge goes to zero immediately. */
export function applyMarkAllRead(state: NotificationState): NotificationState {
  return { items: state.items.map((n) => ({ ...n, isRead: true })), unreadCount: 0 };
}

/**
 * Authoritative reconciliation — a full replace from a fresh server fetch.
 * Used for the initial load AND on realtime reconnect: the database is
 * always the source of truth, so this never merges/dedupes against
 * whatever was locally held — it simply becomes the new state.
 */
export function applyReconcile(fetched: NotificationState): NotificationState {
  return fetched;
}
