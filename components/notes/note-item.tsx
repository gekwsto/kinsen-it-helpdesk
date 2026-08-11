import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDateTime, getInitials } from "@/lib/utils";
import type { Note } from "./types";

/**
 * A single Project/Activity note — author avatar, name, timestamp, and the
 * full plain-text body. Rendered with whitespace-pre-wrap/break-words, never
 * dangerouslySetInnerHTML: a note is always plain text, never HTML.
 */
export function NoteItem({ note }: { note: Note }) {
  const authorLabel = note.author?.name ?? note.author?.email ?? "Deleted user";

  return (
    <div className="flex gap-3">
      <Avatar className="h-7 w-7 shrink-0">
        <AvatarImage src={note.author?.image ?? undefined} />
        <AvatarFallback className="text-[10px]">{getInitials(note.author?.name ?? note.author?.email)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{authorLabel}</span>
          <span className="text-xs text-muted-foreground">{formatDateTime(note.createdAt)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{note.body}</p>
      </div>
    </div>
  );
}
