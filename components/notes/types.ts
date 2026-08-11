// Shared shape for ProjectNote/ActivityNote as returned by
// GET/POST /api/{projects,activities}/[id]/notes. Deliberately just
// author + body + timestamps — no direction/isInternal/email fields exist
// on either model, so none exist here either.
export interface NoteAuthor {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export interface Note {
  id: string;
  body: string;
  createdAt: string;
  author: NoteAuthor | null;
}
