/**
 * Note @mention notification fan-out — separate from
 * lib/services/mention-service.ts's eligibility logic (searchMentionCandidates/
 * resolveEligibleMentionUsers) purely so that file can stay free of this
 * one's dependency chain (lib/notifications/create-notification.ts ->
 * lib/web-push.ts, which is intentionally `import "server-only"`-guarded).
 * Reuses the exact same in-app Notification + realtime + Web Push delivery
 * every other notification in this app already uses — see
 * lib/notifications/create-notification.ts.
 */
import { createInAppNotification } from "@/lib/notifications/create-notification";
import { computeMentionNotificationRecipients } from "@/lib/mentions/mention-tokens";

export interface NotifyNewMentionsParams {
  authorId: string;
  authorName: string;
  /** Already-resolved, already-eligible mentioned user ids (the output of resolveEligibleMentionUsers, or the subset of it that's newly added on an edit). */
  mentionedUserIds: string[];
  link: string;
  /** Human-readable entity reference for the notification body, e.g. `ticket #1042` / the project's title / the activity's title. Never includes the note's own text — see mention-service.ts's doc comment on why notification bodies stay generic. */
  entityLabel: string;
}

/**
 * Fan-out notification for newly-mentioned users. Never notifies the
 * author for mentioning themselves; the caller is responsible for passing
 * only NEWLY-added mention ids on an edit (today none of the three note
 * surfaces support editing at all, so every call site currently passes the
 * full resolved set — see each route's own comment). Dedup + self-exclusion
 * is computeMentionNotificationRecipients (lib/mentions/mention-tokens.ts) —
 * directly unit-tested there without needing this file's own dependencies.
 */
export async function notifyNewMentions(params: NotifyNewMentionsParams): Promise<void> {
  const recipients = computeMentionNotificationRecipients(params.mentionedUserIds, params.authorId);
  for (const userId of recipients) {
    await createInAppNotification({
      userId,
      title: `${params.authorName} mentioned you in a note`,
      body: `${params.authorName} mentioned you in a note on ${params.entityLabel}`,
      link: params.link,
    });
  }
}
