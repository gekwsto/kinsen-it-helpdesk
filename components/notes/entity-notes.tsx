"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StickyNote } from "lucide-react";
import { NoteItem } from "./note-item";
import { NoteComposer } from "./note-composer";
import type { Note } from "./types";

interface EntityNotesProps {
  /** e.g. `/api/projects/${id}` or `/api/activities/${id}` — notes live at `${apiBasePath}/notes`. */
  apiBasePath: string;
  initialNotes: Note[];
  /**
   * Whether the composer is shown at all. This is a UI convenience only —
   * POST {apiBasePath}/notes independently re-checks project.edit/
   * activity.edit server-side and is the actual authority; a user without
   * this permission who somehow posts anyway gets rejected there, not here.
   */
  canAddNote: boolean;
}

/**
 * Shared Notes section for Project/Activity detail pages. Renders existing
 * notes chronologically (oldest first, newest near the composer — a
 * deliberate "conversation" ordering, not the Ticket UI's newest-first
 * convention) and, if `canAddNote`, a composer beneath them. A note posted
 * here is appended to local state immediately — no page refresh needed.
 *
 * This is NOTES ONLY: there is no Reply/Internal toggle, no direction, no
 * email semantics. See lib/validations.ts's createNoteSchema and
 * app/api/{projects,activities}/[id]/notes/route.ts for the server-side
 * invariants this UI relies on.
 */
export function EntityNotes({ apiBasePath, initialNotes, canAddNote }: EntityNotesProps) {
  const [notes, setNotes] = useState<Note[]>(initialNotes);

  const handleAddNote = async (body: string) => {
    const res = await fetch(`${apiBasePath}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const message = typeof err.error === "string" ? err.error : "Failed to add note";
      toast.error(message);
      throw new Error(message);
    }
    const note: Note = await res.json();
    setNotes((prev) => [...prev, note]);
    toast.success("Note added");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <StickyNote className="h-4 w-4" />
          Notes ({notes.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {notes.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <div className="space-y-4">
            {notes.map((note) => (
              <NoteItem key={note.id} note={note} />
            ))}
          </div>
        )}

        {canAddNote && (
          <>
            <Separator />
            <NoteComposer onSubmit={handleAddNote} placeholder="Write a note…" />
          </>
        )}
      </CardContent>
    </Card>
  );
}
