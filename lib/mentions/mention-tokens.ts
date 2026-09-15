/**
 * Pure, client-safe mention-token serialization — shared by the composer
 * (components/notes/mention-textarea.tsx, browser bundle) and the server
 * (lib/services/mention-service.ts). No Prisma/Node-only imports, so it's
 * safe in either context.
 *
 * A mention is embedded inline in a Note/TicketMessage's plain-text `body`
 * as `@[Display Name](user:USER_ID)` — the SAME body field every note
 * already has, so no new column/format is introduced at the storage layer
 * (see this feature's schema comment on TicketMessageMention for why the
 * relation, not this text, is the actual authority on who was mentioned).
 * This module only builds/finds these tokens; it never decides whether a
 * given token is a REAL mention — that's the persisted *NoteMention/
 * TicketMessageMention relation's job (see renderNoteBodyWithMentions in
 * components/notes/mention-render.tsx, which cross-checks every token found
 * here against that relation before rendering it as a real mention chip).
 */

const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(user:([a-zA-Z0-9_-]+)\)/g;

/** Strips characters that would break the `@[Name](user:id)` token shape out of a display name before embedding it. Defensive only — real display names never contain these. */
function sanitizeMentionName(name: string): string {
  return name.replace(/[[\]()]/g, "");
}

/** The exact inline token text to insert into a note body when a user picks a mention candidate. */
export function buildMentionToken(userId: string, displayName: string): string {
  return `@[${sanitizeMentionName(displayName)}](user:${userId})`;
}

export interface MentionTokenMatch {
  /** Index into the body string where this token starts. */
  index: number;
  /** Full matched token text, e.g. `@[Konstantinos Kefalas](user:abc123)`. */
  raw: string;
  userId: string;
  /** The name embedded in the token at write time — NEVER trusted as current; see the module doc comment. */
  embeddedName: string;
}

/** Every mention-token occurrence in a body string, in order. Pure regex scan — makes no claim about whether any of these correspond to a real, persisted mention. */
export function findMentionTokens(body: string): MentionTokenMatch[] {
  const matches: MentionTokenMatch[] = [];
  const re = new RegExp(MENTION_TOKEN_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    matches.push({ index: m.index, raw: m[0], userId: m[2], embeddedName: m[1] });
  }
  return matches;
}

/** Every DISTINCT userId embedded in the body's tokens, in first-occurrence order — a convenience for the composer's local "who have I already mentioned" bookkeeping. Never used server-side as the source of truth for what to persist/notify (the client's explicit `mentionUserIds` list is — see the mention-service doc comment). */
export function extractMentionedUserIdsFromBody(body: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const { userId } of findMentionTokens(body)) {
    if (!seen.has(userId)) {
      seen.add(userId);
      ids.push(userId);
    }
  }
  return ids;
}

/**
 * Pure recipient-list computation for mention notifications — deduplicates
 * (the same user id appearing twice yields exactly one recipient) and
 * excludes the author (mentioning yourself never notifies you). Extracted
 * as its own pure, dependency-free function — used by
 * lib/services/mention-notification-service.ts's notifyNewMentions — so
 * this specific piece of logic is directly unit-testable without pulling
 * in that file's web-push dependency.
 */
export function computeMentionNotificationRecipients(mentionedUserIds: string[], authorId: string): string[] {
  return Array.from(new Set(mentionedUserIds)).filter((id) => id !== authorId);
}
