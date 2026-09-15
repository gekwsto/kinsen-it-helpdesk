import { createElement, Fragment, type ReactNode } from "react";
import { findMentionTokens } from "@/lib/mentions/mention-tokens";

export interface RenderedMention {
  userId: string;
  /** Current display name from the User relation — see the module doc comment on why this, not the token's embedded name, is preferred. */
  name: string | null;
  email: string;
}

/**
 * Splits a Note/TicketMessage body into plain-text segments and real
 * mention chips — shared by note-item.tsx and ticket-thread.tsx's message
 * bubble, the ONE place mention rendering logic lives. Every
 * `@[Name](user:id)` token found in the text (see lib/mentions/mention-tokens.ts)
 * is only ever rendered as a mention chip if `mentions` — the persisted
 * NoteMention/TicketMessageMention relation, loaded from the DB alongside
 * the note — actually contains that userId. A token whose id has no
 * matching relation row (a forged/stripped/otherwise-invalid token) renders
 * as its own literal raw text instead, never styled like a real mention —
 * the relation is the sole authority on who was actually mentioned, never
 * the text alone. A body with no tokens at all (every historical Note
 * before this feature existed) renders exactly as before: one plain-text
 * segment, whitespace-pre-wrap, never dangerouslySetInnerHTML.
 *
 * Built with createElement rather than JSX syntax so this pure function
 * stays directly callable from a plain Node script (see
 * scripts/test-note-mentions.ts) without depending on a JSX-transform
 * runtime — this file has no other build-time requirement either way, but
 * the regression test does.
 */
export function renderNoteBodyWithMentions(body: string, mentions: RenderedMention[]): ReactNode {
  const tokens = findMentionTokens(body);
  if (tokens.length === 0) return body;

  const mentionsById = new Map(mentions.map((m) => [m.userId, m]));
  const parts: ReactNode[] = [];
  let cursor = 0;

  tokens.forEach((token, i) => {
    if (token.index > cursor) {
      parts.push(createElement(Fragment, { key: `text-${i}` }, body.slice(cursor, token.index)));
    }
    const resolved = mentionsById.get(token.userId);
    if (resolved) {
      const label = resolved.name?.trim() || resolved.email;
      parts.push(
        createElement(
          "span",
          { key: `mention-${i}`, className: "inline-block rounded bg-primary/10 px-1 font-medium text-primary" },
          `@${label}`
        )
      );
    } else {
      // No matching persisted mention — render the raw token text
      // literally, never as a styled mention (see doc comment above).
      parts.push(createElement(Fragment, { key: `unresolved-${i}` }, token.raw));
    }
    cursor = token.index + token.raw.length;
  });

  if (cursor < body.length) {
    parts.push(createElement(Fragment, { key: "text-end" }, body.slice(cursor)));
  }

  return parts;
}
