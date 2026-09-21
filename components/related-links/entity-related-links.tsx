"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check, ExternalLink, Link2, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { parseSafeExternalUrl, relatedLinkHostname, relatedLinkSchema, RELATED_LINK_TITLE_MAX, RELATED_LINK_URL_MAX } from "@/lib/related-links/validation";
import type { RelatedLinkDto, RelatedLinkEntityType } from "@/lib/related-links/types";

interface EntityRelatedLinksProps {
  entityType: RelatedLinkEntityType;
  entityId: string;
  /**
   * Server-rendered initial data (Project page). When omitted (Activity page,
   * which is a client component that loads its own data), the card fetches
   * from GET {apiBase} on mount — and that response also tells it whether
   * the current user may modify, computed server-side by the same effective
   * permission the mutation routes enforce.
   */
  initialLinks?: RelatedLinkDto[];
  /**
   * Whether Add/Edit/Delete controls are shown. A UI convenience only —
   * POST/PATCH/DELETE independently re-authorize (project.edit /
   * activity.edit on the entity's own department) and are the authority.
   */
  initialCanManage?: boolean;
}

const API_SEGMENT: Record<RelatedLinkEntityType, string> = { project: "projects", activity: "activities" };

type FieldErrors = { url?: string; title?: string };

function validateFields(url: string, title: string): FieldErrors {
  const result = relatedLinkSchema.safeParse({ url, title });
  if (result.success) return {};
  const flat = result.error.flatten().fieldErrors;
  return { url: flat.url?.[0], title: flat.title?.[0] };
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const err = await res.json().catch(() => ({}));
  return typeof err.error === "string" ? err.error : fallback;
}

/**
 * The ONE Related Links card for both Project and Activity detail pages —
 * an entity-agnostic component; the only per-entity input is which API
 * segment it talks to. Users save external links (SharePoint documents,
 * wiki pages, ...) with a short note. Links are stored and rendered only —
 * nothing is ever fetched from them — and every title/URL is plain React
 * text, never HTML.
 */
export function EntityRelatedLinks({ entityType, entityId, initialLinks, initialCanManage = false }: EntityRelatedLinksProps) {
  const apiBase = `/api/${API_SEGMENT[entityType]}/${entityId}/related-links`;

  const [links, setLinks] = useState<RelatedLinkDto[]>(initialLinks ?? []);
  const [canManage, setCanManage] = useState(initialCanManage);
  const [loading, setLoading] = useState(initialLinks === undefined);
  const [loadError, setLoadError] = useState(false);

  const [newUrl, setNewUrl] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newErrors, setNewErrors] = useState<FieldErrors>({});
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false); // synchronous double-submit guard (state updates are async)

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);

  const [deleteTarget, setDeleteTarget] = useState<RelatedLinkDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  useEffect(() => {
    if (initialLinks !== undefined) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    fetch(apiBase)
      .then(async (res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json() as Promise<{ links: RelatedLinkDto[]; canManage: boolean }>;
      })
      .then((data) => {
        if (cancelled) return;
        setLinks(data.links);
        setCanManage(data.canManage);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, initialLinks]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (addingRef.current) return;
    const errors = validateFields(newUrl, newTitle);
    setNewErrors(errors);
    if (errors.url || errors.title) return;
    addingRef.current = true;
    setAdding(true);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl, title: newTitle }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, "Failed to add link"));
        return;
      }
      const created: RelatedLinkDto = await res.json();
      setLinks((prev) => [created, ...prev]); // newest first
      setNewUrl("");
      setNewTitle("");
      setNewErrors({});
      toast.success("Link added");
    } catch {
      toast.error("Failed to add link");
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const startEdit = (link: RelatedLinkDto) => {
    setEditingId(link.id);
    setEditUrl(link.url);
    setEditTitle(link.title);
    setEditErrors({});
  };

  const cancelEdit = () => {
    if (savingEditRef.current) return;
    setEditingId(null);
    setEditErrors({});
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingEditRef.current || !editingId) return;
    const errors = validateFields(editUrl, editTitle);
    setEditErrors(errors);
    if (errors.url || errors.title) return;
    savingEditRef.current = true;
    setSavingEdit(true);
    try {
      const res = await fetch(`${apiBase}/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: editUrl, title: editTitle }),
      });
      if (!res.ok) {
        // The displayed entry is left exactly as it was; the form stays open so nothing typed is lost.
        toast.error(await errorMessage(res, "Failed to update link"));
        return;
      }
      const updated: RelatedLinkDto = await res.json();
      setLinks((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
      setEditingId(null);
      toast.success("Link updated");
    } catch {
      toast.error("Failed to update link");
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (deletingRef.current || !deleteTarget) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      const res = await fetch(`${apiBase}/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await errorMessage(res, "Failed to delete link"));
        return; // entry stays in the list
      }
      const removedId = deleteTarget.id;
      setLinks((prev) => prev.filter((l) => l.id !== removedId));
      setDeleteTarget(null);
      toast.success("Link deleted");
    } catch {
      toast.error("Failed to delete link");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          Related Links ({links.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <>
            <form onSubmit={handleAdd} noValidate className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 min-w-0">
                  <Label htmlFor={`related-link-url-${entityId}`}>
                    Link <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id={`related-link-url-${entityId}`}
                    type="url"
                    inputMode="url"
                    placeholder="https://company.sharepoint.com/document/…"
                    maxLength={RELATED_LINK_URL_MAX}
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    disabled={adding}
                    aria-invalid={!!newErrors.url}
                  />
                  {newErrors.url && <p className="text-xs text-destructive">{newErrors.url}</p>}
                </div>
                <div className="space-y-1.5 min-w-0">
                  <Label htmlFor={`related-link-title-${entityId}`}>
                    Title / Note <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id={`related-link-title-${entityId}`}
                    placeholder="e.g. Final approved customer proposal"
                    maxLength={RELATED_LINK_TITLE_MAX}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    disabled={adding}
                    aria-invalid={!!newErrors.title}
                  />
                  {newErrors.title && <p className="text-xs text-destructive">{newErrors.title}</p>}
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={adding}>
                  {adding ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                  Add Link
                </Button>
              </div>
            </form>
            <Separator />
          </>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : loadError ? (
          <p className="py-2 text-center text-sm text-destructive">Couldn&apos;t load related links.</p>
        ) : links.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">No related links yet.</p>
        ) : (
          <ul className="space-y-2">
            {links.map((link) =>
              editingId === link.id ? (
                <li key={link.id} className="rounded-lg border bg-muted/30 p-3">
                  <form onSubmit={handleSaveEdit} noValidate className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5 min-w-0">
                        <Label htmlFor={`related-link-edit-url-${link.id}`}>Link</Label>
                        <Input
                          id={`related-link-edit-url-${link.id}`}
                          type="url"
                          inputMode="url"
                          maxLength={RELATED_LINK_URL_MAX}
                          value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          disabled={savingEdit}
                          aria-invalid={!!editErrors.url}
                        />
                        {editErrors.url && <p className="text-xs text-destructive">{editErrors.url}</p>}
                      </div>
                      <div className="space-y-1.5 min-w-0">
                        <Label htmlFor={`related-link-edit-title-${link.id}`}>Title / Note</Label>
                        <Input
                          id={`related-link-edit-title-${link.id}`}
                          maxLength={RELATED_LINK_TITLE_MAX}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          disabled={savingEdit}
                          aria-invalid={!!editErrors.title}
                        />
                        {editErrors.title && <p className="text-xs text-destructive">{editErrors.title}</p>}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={savingEdit}>
                        <X className="h-4 w-4 mr-1.5" />
                        Cancel
                      </Button>
                      <Button type="submit" size="sm" disabled={savingEdit}>
                        {savingEdit ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Check className="h-4 w-4 mr-1.5" />}
                        Save
                      </Button>
                    </div>
                  </form>
                </li>
              ) : (
                <li key={link.id} className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    {/* Plain React text nodes only — a title like "<script>…" renders inert. */}
                    <p className="text-sm font-medium break-words">{link.title}</p>
                    <ExternalUrl url={link.url} />
                    <p className="mt-0.5 text-xs text-muted-foreground break-words">
                      {link.createdBy ? (link.createdBy.name ?? link.createdBy.email) : "Deleted user"} · {formatDateTime(link.createdAt)}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground"
                        aria-label={`Edit link: ${link.title}`}
                        onClick={() => startEdit(link)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete link: ${link.title}`}
                        onClick={() => setDeleteTarget(link)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              )
            )}
          </ul>
        )}
      </CardContent>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Related Link</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete{" "}
              <strong className="text-foreground break-words">{deleteTarget?.title}</strong>?
            </p>
            <p className="text-sm font-medium text-destructive">This action cannot be undone.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The clickable URL. Rendered as an anchor ONLY if the stored value passes
 * the same http(s) allow-list used at write time (defense in depth against a
 * tampered/legacy row) — otherwise as inert text, never a live href. Shows
 * the hostname, truncated, with the full URL in the tooltip; the flex/min-w-0
 * chain guarantees an arbitrarily long URL can never widen the page.
 */
function ExternalUrl({ url }: { url: string }) {
  const safe = parseSafeExternalUrl(url);
  if (!safe) {
    return <p className="mt-0.5 text-xs text-muted-foreground truncate">{url}</p>;
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      title={safe}
      className="mt-0.5 flex min-w-0 max-w-full items-center gap-1 text-xs text-primary hover:underline"
    >
      <span className="truncate">{relatedLinkHostname(safe)}</span>
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}
